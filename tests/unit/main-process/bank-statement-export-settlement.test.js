// v3.2.22（🔴 资金红线·存档血缘）：资金对账导出（bank-statement:export）的产物结算。
//
// 只有 writer 成功返回的输出才按路径结算；写失败、写盘前被拒或因前序失败未执行的计划输出一律声明 produced: false——
//   用户选择覆盖的旧主文件、同一分钟同目录上一批的同名附属报表仍在原路径时，不能归档成本批产物。
//   附属报表写失败不阻塞主文件，失败原因随导出结果带回界面（sideReportFailures）。
//
// 从 src/main.js 切出 trackedIpcHandle('bank-statement:export', …) 的处理对象，以 with 作用域注入依赖后直接调用
//   prepare / execute；剔除文件与退款回填文件用真实 writer。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writePlatformCleanupOutput } = require('../../../src/main-process/platform-cleanup-writer');
const { writeRefundBackfillOutput } = require('../../../src/main-process/refund-backfill-writer');
const { CLEANUP_TEMPLATE_HEADERS } = require('../../../src/constants/platform-cleanup-template-fields');

const mainSource = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');

function extractExportHandlerLiteral() {
  const marker = "trackedIpcHandle('bank-statement:export', '银行对账单处理', '导出文件', ";
  const start = mainSource.indexOf(marker);
  assert.ok(start >= 0, '应能定位 bank-statement:export');
  const bodyStart = start + marker.length;
  assert.strictEqual(mainSource[bodyStart], '{');
  let depth = 0;
  for (let index = bodyStart; index < mainSource.length; index += 1) {
    if (mainSource[index] === '{') depth += 1;
    if (mainSource[index] === '}') {
      depth -= 1;
      if (depth === 0) return mainSource.slice(bodyStart, index + 1);
    }
  }
  throw new Error('bank-statement:export 处理对象未闭合');
}
const HANDLER_LITERAL = extractExportHandlerLiteral();

function cleanupRow(overrides = {}) {
  return Object.fromEntries(CLEANUP_TEMPLATE_HEADERS.map((header) => [header, overrides[header] ?? `${header}-1`]));
}

function createHarness(t, { mainWriter, cleanupRows, lock = { acquired: true } }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-statement-export-settlement-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const mainPath = path.join(tmpDir, 'out', '处理结果.xlsx');
  const logs = [];
  const settled = [];
  const lockReleases = [];
  const hitRow = { _rowId: 'r1', _hitScenarioId: 1, ReconciliationId: 'RID-1' };
  const scope = {
    processingResult: {
      errorReport: [],
      modifiedRows: [hitRow],
      unmatchedRows: [],
      modifications: [],
      platformCleanupRows: cleanupRows,
      refundBackfillRows: [{ '退款单号': 'RF-1', ReconciliationId: 'RID-1' }],
      refundUnmatchedRows: [],
      refundHitDepositBizIds: []
    },
    bankStatementSession: { headers: ['ReconciliationId'], filePath: path.join(tmpDir, '银行.xlsx') },
    inspectBankStatementExportState: () => ({
      ok: true,
      processingResult: scope.processingResult,
      bankStatementSession: scope.bankStatementSession,
      unmatchedCount: 0,
      requiresMainOutput: true
    }),
    getStorageRoot: () => tmpDir,
    buildDateDir: () => '2026-11-24',
    buildTimestamp: () => '20261124_120000',
    buildTimestampMinuteUnderscore: () => '2026_11_24_1200',
    buildMainOutputFileName: () => '处理结果.xlsx',
    buildScenarioHitRowsBaseName: () => '银行',
    buildPlatformCleanupFileName: (stamp) => `中台加款单剔除-${stamp}.xlsx`,
    buildRefundBackfillFileName: (stamp) => `中台退款订单回填-${stamp}.xlsx`,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: mainPath }) },
    mainWindow: {},
    app: { getPath: () => tmpDir },
    path,
    fs,
    tryAcquireBankStatementOpLock: () => lock,
    releaseBankStatementOpLock: () => { lockReleases.push(true); },
    writeErrorReportOutputToPath: async () => { throw new Error('本用例无错误报告'); },
    getErrorReportTemporaryMarkerDir: () => tmpDir,
    writeBankStatementMainOutput: mainWriter,
    writeScenarioHitRows: async (_rows, _original, { outputPath }) => {
      fs.writeFileSync(outputPath, 'HIT');
      return { filePath: outputPath, fileName: path.basename(outputPath) };
    },
    channelsRepository: { listChannels: () => [] },
    database: { db: {} },
    appendActivityLogEntry: (entry) => logs.push(entry),
    writePlatformCleanupOutput,
    writeRefundBackfillOutput,
    pickStaleHits: () => [],
    buildStaleHitReminder: () => ''
  };
  // eslint-disable-next-line no-new-func
  const handler = new Function('scope', `with (scope) { return (${HANDLER_LITERAL}); }`)(scope);
  async function run() {
    const prepared = await handler.prepare();
    assert.strictEqual(prepared.proceed, true);
    const outputs = prepared.filePlan.outputs.map((item, index) => ({ ...item, artifactKey: `artifact-${index}` }));
    const result = await handler.execute({}, prepared, {
      fileEvidence: { filePlan: { ...prepared.filePlan, outputs } },
      settleArtifacts: async (payload) => { settled.push(payload); return { ok: true }; }
    });
    const byKind = Object.fromEntries(prepared.outputKinds.map((kind, index) => [kind, {
      filePath: outputs[index].filePath,
      settle: settled[0].files[index]
    }]));
    return { result, byKind };
  }
  return { tmpDir, mainPath, logs, settled, lockReleases, run };
}

const realMainWriter = async ({ mainFilePath }) => {
  fs.writeFileSync(mainFilePath, 'MAIN');
  return { filePath: mainFilePath, fileName: path.basename(mainFilePath) };
};

test('附属报表写盘前被拒：主文件照常生成，失败原因带回界面，同名旧文件不被当成本批产物结算', async (t) => {
  // 🔴 剔除文件的对账ID 读回超过 Excel 单格上限（v3.2.22 之前按转义原文落库的旧记录），写盘前整本拒绝。
  const harness = createHarness(t, {
    mainWriter: realMainWriter,
    cleanupRows: [cleanupRow({ ReconciliationId: '_x005F_x0041_'.repeat(2600) })]
  });
  // 同一分钟同目录上一批的同名剔除文件。
  const oldCleanupPath = path.join(path.dirname(harness.mainPath), '中台加款单剔除-2026_11_24_1200.xlsx');
  fs.mkdirSync(path.dirname(oldCleanupPath), { recursive: true });
  fs.writeFileSync(oldCleanupPath, 'OLD-BATCH');

  const { result, byKind } = await harness.run();
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.mainFileName, '处理结果.xlsx');
  assert.strictEqual(result.platformCleanupPath, null);
  assert.ok(result.refundBackfillPath, '退款回填文件照常生成');
  assert.strictEqual(result.sideReportFailures.length, 1);
  assert.strictEqual(result.sideReportFailures[0].label, '加款单剔除文件');
  assert.match(result.sideReportFailures[0].message, /工作表「Sheet1」单元格 L2 的文本有 33800 个字符/);

  assert.strictEqual(byKind['platform-cleanup'].filePath, oldCleanupPath);
  assert.deepStrictEqual(byKind['platform-cleanup'].settle, { artifactKey: byKind['platform-cleanup'].settle.artifactKey, produced: false },
    '🔴 写失败的剔除文件声明未产出，不按路径读取上一批的同名文件');
  assert.strictEqual(fs.readFileSync(oldCleanupPath, 'utf8'), 'OLD-BATCH', '不删除、不改写他人文件');
  const cleanupLog = harness.logs.find((entry) => /中台加款单剔除文件生成失败/.test(entry.message));
  assert.ok(cleanupLog, '附属报表失败写活动日志');
  assert.doesNotMatch(JSON.stringify(cleanupLog), /33800|_x005F_|单元格 L2|中台加款单剔除-/,
    '活动日志不记原始错误文本（路径、单元格内容等）');
  for (const kind of ['main', 'hit-scenarios', 'refund-backfill']) {
    assert.strictEqual(byKind[kind].settle.produced, undefined, `${kind} 写成功，按路径结算`);
  }
});

test('主文件写失败：导出失败，所有计划输出（含未执行的附属报表）都声明未产出，用户选择覆盖的旧主文件不被归档', async (t) => {
  const harness = createHarness(t, {
    mainWriter: async () => {
      throw new Error('工作表「命中场景」单元格 D2 的文本有 33800 个字符，超过 Excel 单元格 32767 个字符的上限');
    },
    cleanupRows: [cleanupRow()]
  });
  fs.mkdirSync(path.dirname(harness.mainPath), { recursive: true });
  fs.writeFileSync(harness.mainPath, 'OLD-MAIN');

  const { result, byKind } = await harness.run();
  assert.strictEqual(result.status, 'failed');
  assert.match(result.message, /单元格 D2/);
  for (const kind of ['main', 'hit-scenarios', 'platform-cleanup', 'refund-backfill']) {
    assert.strictEqual(byKind[kind].settle.produced, false, `🔴 ${kind} 未产出`);
  }
  assert.strictEqual(fs.readFileSync(harness.mainPath, 'utf8'), 'OLD-MAIN');
});

test('抢锁失败：一个文件都不写，计划输出全部声明未产出，用户选择覆盖的旧主文件不被归档，也不释放他人持有的锁', async (t) => {
  let mainWrites = 0;
  const harness = createHarness(t, {
    mainWriter: async (args) => { mainWrites += 1; return realMainWriter(args); },
    cleanupRows: [cleanupRow()],
    lock: { acquired: false, message: '银行对账单正在导入或运行，请稍后再导出' }
  });
  fs.mkdirSync(path.dirname(harness.mainPath), { recursive: true });
  fs.writeFileSync(harness.mainPath, 'OLD-MAIN');

  const { result, byKind } = await harness.run();
  assert.strictEqual(result.status, 'failed');
  assert.match(result.message, /正在导入或运行/);
  assert.strictEqual(mainWrites, 0);
  assert.strictEqual(harness.settled.length, 1, '结算一次');
  for (const kind of ['main', 'hit-scenarios', 'platform-cleanup', 'refund-backfill']) {
    assert.strictEqual(byKind[kind].settle.produced, false, `🔴 ${kind} 未产出，不留待按路径重试存档`);
  }
  assert.strictEqual(fs.readFileSync(harness.mainPath, 'utf8'), 'OLD-MAIN');
  assert.strictEqual(harness.lockReleases.length, 0, '锁由他人持有，不释放');
});

test('存档告警：含未产出时区分本次未生成 / 存档时找不到 / 其他存档失败，只提示重新执行业务', () => {
  const start = mainSource.indexOf('function reportArchiveFailure(warning) {');
  assert.ok(start >= 0);
  let depth = 0;
  let end = mainSource.indexOf('{', start);
  for (; end < mainSource.length; end += 1) {
    if (mainSource[end] === '{') depth += 1;
    if (mainSource[end] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const notifications = [];
  const logs = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    show() { notifications.push(this.options.body); }
  }
  // eslint-disable-next-line no-new-func
  const reportArchiveFailure = new Function('Notification', 'appendActivityLogEntry',
    `${mainSource.slice(start, end + 1)}\nreturn reportArchiveFailure;`)(Notification, (entry) => logs.push(entry.message));

  const cases = [
    [{ declaredNotProducedCount: 1, missingAtArchiveCount: 0, otherArchiveFailureCount: 0 }, /本次未生成/, /找不到|另有/],
    [{ declaredNotProducedCount: 0, missingAtArchiveCount: 1, otherArchiveFailureCount: 0 }, /存档时已找不到/, /本次未生成|另有/],
    [{ declaredNotProducedCount: 1, missingAtArchiveCount: 0, otherArchiveFailureCount: 2 }, /本次未生成.*另有文件存档失败/, /找不到/]
  ];
  for (const [counts, expected, unexpected] of cases) {
    reportArchiveFailure({ code: 'ARCHIVE_OUTPUT_NOT_PRODUCED', message: '计数摘要', ...counts });
    const body = notifications[notifications.length - 1];
    assert.match(body, expected);
    assert.doesNotMatch(body, unexpected);
    assert.match(body, /不能重试存档.*重新执行/, '只提示存档中心实际可用的「重新执行业务」');
    assert.doesNotMatch(body, /已正常生成|打开存档中心重试/);
    assert.match(logs[logs.length - 1], /只能重新执行业务/);
  }

  reportArchiveFailure({ code: 'ARCHIVE_TASK_SETTLE_FAILED', message: 'x' });
  assert.match(notifications[notifications.length - 1], /业务文件已正常生成，但存档失败，请打开存档中心重试/);
});
