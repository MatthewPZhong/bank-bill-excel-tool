// v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块 IPC handler 仿真 smoke 测试
//
// 镜像 src/main.js 的 4 个 trackedIpcHandle 内核（不真启 Electron）：
//   - recon-id-fix:import   — 调 readReconIdFixFile 落 reconIdFixSession（资金红线：清 reconIdFixResult）
//   - recon-id-fix:run      — structuredClone + runReconIdFix → 落 reconIdFixResult + scenariosSnapshot
//   - recon-id-fix:export   — 重读 scenario 比对 snapshot（defense in depth）+ 写 xlsx
//   - recon-id-fix:session-status — 读 reconIdFixSession + reconIdFixResult 返回元数据
//
// 模拟主进程的 reconIdFixSession / reconIdFixResult 全局变量用一个 cache 对象代替。
// 用 in-memory DB + scenarios-repository 直接当 database facade。

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');

const {
  ensureScenariosCategoryReconIdFix
} = require('../../src/backend/database/migrations');
const {
  createScenario,
  getScenario,
  updateScenario,
  deleteScenario
} = require('../../src/backend/database/scenarios-repository');
const {
  readReconIdFixFile,
  writeReconIdFixOutput,
  writeUnmatchedReport,
  buildMainOutputFileName,
  buildUnmatchedReportFileName,
  buildTimestampMinute
} = require('../../src/main-process/recon-id-fix-io');
const { runReconIdFix } = require('../../src/main-process/recon-id-fix-engine');
const {
  RECON_RESULT_FIELDS,
  BUSINESS_BILL_FIELDS,
  OPPONENT_BILL_FIELDS,
  ORDER_REPAIR_FIELDS,
  RECON_RESULT_SHEET_NAME,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME
} = require('../../src/constants/recon-id-fix-fields');
const { FileValidationError } = require('../../src/backend/file-service/common');

// ===== 全等 main.js 中的 buildReconIdFixSnapshot =====
//
// PR #36 self-review round 5（P3-C，2026-05-09）：
//   stableJsonStringify 与 main.js 同名 helper 同源（递归按 key 排序）；保证 smoke
//   simulator 跟 main.js 真实 IPC 行为一致——同语义但 key 顺序不同的 config 应产生
//   相同 snapshot 字符串。
function stableJsonStringify(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableJsonStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJsonStringify(obj[k])).join(',') + '}';
}

function buildReconIdFixSnapshot(scenario) {
  if (!scenario) return '';
  return [
    scenario.id,
    scenario.name,
    scenario.priority,
    scenario.enabled ? 1 : 0,
    stableJsonStringify(scenario.config || {})
  ].join('|');
}

// ===== Simulator：模拟 main.js 4 IPC handler 内核 =====
function simulateImport(state, filePath) {
  try {
    const result = readReconIdFixFile(filePath);
    state.reconIdFixSession = {
      filePath: result.filePath,
      fileName: result.fileName,
      sheets: result.sheets,
      importedAt: result.importedAt
    };
    state.reconIdFixResult = null; // 资金红线
    return {
      status: 'ok',
      fileName: result.fileName,
      sheetCounts: {
        recon: result.sheets.reconResult.length,
        business: result.sheets.businessBills.length,
        opp: result.sheets.opponentBills.length
      }
    };
  } catch (error) {
    if (error && error.name === 'FileValidationError') {
      return {
        status: 'invalid',
        code: error.code,
        message: error.message,
        detailLines: Array.isArray(error.detailLines) ? error.detailLines : []
      };
    }
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

function simulateRun(state, db, scenarioId) {
  if (!state.reconIdFixSession) {
    return { status: 'failed', message: '请先点击"导入文件"' };
  }
  if (scenarioId === null || scenarioId === undefined) {
    return { status: 'failed', message: '请先在主面板"场景"下拉选择一个场景' };
  }
  const scenario = getScenario(db, scenarioId);
  if (!scenario) {
    return { status: 'failed', message: `场景 id=${scenarioId} 不存在` };
  }
  if (scenario.category !== 'recon-id-fix') {
    return { status: 'failed', message: `场景 "${scenario.name}" 不是单据对账类，无法运行` };
  }
  try {
    const cloned = {
      reconResult: structuredClone(state.reconIdFixSession.sheets.reconResult),
      businessBills: structuredClone(state.reconIdFixSession.sheets.businessBills),
      opponentBills: structuredClone(state.reconIdFixSession.sheets.opponentBills),
      fixTemplate: state.reconIdFixSession.sheets.fixTemplate
    };
    const result = runReconIdFix(scenario, cloned);
    state.reconIdFixResult = {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      fixedRows: result.fixedRows,
      warnings: result.warnings,
      unmatchedRows: result.unmatchedRows || [],
      scenariosSnapshot: buildReconIdFixSnapshot(scenario),
      ranAt: Date.now()
    };
    return { status: 'ok', stats: result.stats };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

// simulateExport：第 3 参数 saveDialogResult 模拟用户行为：null=取消；string=路径
// 第 4 参数 saveDialogDefaultProbe（可选）：传入函数 fn 时回传 saveDialog 准备用的
//   defaultPath（让用例校验"默认名"逻辑命中），见 P3-A 测试。
// Round 3：双文件输出（主+unmatched）
// PR #36 self-review round 5（P3-A / P3-B，2026-05-09）：
//   - fixedRows 空 + unmatched 非空 → defaultPath 用 unmatched 名，用户选定路径就是 unmatched 文件
//   - fixedRows 非空 + unmatched 非空 → defaultPath 用主名，主+unmatched 同目录，
//     unmatched 文件名联动主文件 basename
async function simulateExport(state, db, saveDialogResult, saveDialogDefaultProbe = null) {
  if (!state.reconIdFixResult) {
    return { status: 'failed', message: '请先点击"开始运行"' };
  }
  const currentScenario = getScenario(db, state.reconIdFixResult.scenarioId);
  if (!currentScenario) {
    state.reconIdFixResult = null;
    return { status: 'failed', code: 'stale-snapshot', message: '场景已删除，请重新选择场景再运行' };
  }
  const currentSnapshot = buildReconIdFixSnapshot(currentScenario);
  if (currentSnapshot !== state.reconIdFixResult.scenariosSnapshot) {
    state.reconIdFixResult = null;
    return { status: 'failed', code: 'stale-snapshot', message: '场景已变更，请重新点击"开始运行"再导出' };
  }
  const fixedRows = Array.isArray(state.reconIdFixResult.fixedRows) ? state.reconIdFixResult.fixedRows : [];
  const unmatchedRows = Array.isArray(state.reconIdFixResult.unmatchedRows) ? state.reconIdFixResult.unmatchedRows : [];
  if (fixedRows.length === 0 && unmatchedRows.length === 0) {
    return { status: 'empty', message: '本次运行无修复记录且无未匹配记录，未生成文件' };
  }
  // 模拟 saveDialog 默认名（P3-A）
  const timestamp = buildTimestampMinute();
  const defaultFileName = (fixedRows.length === 0 && unmatchedRows.length > 0)
    ? buildUnmatchedReportFileName(state.reconIdFixResult.scenarioName, timestamp)
    : `单据对账修复-${timestamp}-${state.reconIdFixResult.scenarioName}.xlsx`;
  if (typeof saveDialogDefaultProbe === 'function') {
    saveDialogDefaultProbe(defaultFileName);
  }
  if (saveDialogResult === null) {
    return { status: 'cancelled' };
  }
  try {
    const ret = {
      status: 'ok',
      mainFilePath: null, mainFileName: null,
      unmatchedFilePath: null, unmatchedFileName: null,
      rowCount: 0, unmatchedCount: 0
    };
    if (fixedRows.length === 0) {
      // 仅 unmatched 分支：用户选定路径就是 unmatched 文件
      const wUnm = await writeUnmatchedReport({ unmatchedRows, savePath: saveDialogResult });
      ret.unmatchedFilePath = wUnm.filePath;
      ret.unmatchedFileName = wUnm.fileName;
      ret.unmatchedCount = wUnm.rowCount;
    } else {
      // 主非空：写主文件
      const w = await writeReconIdFixOutput({ fixedRows, savePath: saveDialogResult });
      ret.mainFilePath = w.filePath;
      ret.mainFileName = w.fileName;
      ret.rowCount = w.rowCount;
      if (unmatchedRows.length > 0) {
        const dir = path.dirname(saveDialogResult);
        const mainBase = path.basename(saveDialogResult);
        const unmName = buildUnmatchedReportFileName(
          state.reconIdFixResult.scenarioName,
          timestamp,
          mainBase
        );
        const unmPath = path.join(dir, unmName);
        const wUnm = await writeUnmatchedReport({ unmatchedRows, savePath: unmPath });
        ret.unmatchedFilePath = wUnm.filePath;
        ret.unmatchedFileName = wUnm.fileName;
        ret.unmatchedCount = wUnm.rowCount;
      }
    }
    return ret;
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
}

// v2.1.0-beta.3 PR #39 Codex#1（P2）：清 main 端 session + result（切换账单类别时调用）
function simulateClearSession(state) {
  state.reconIdFixSession = null;
  state.reconIdFixResult = null;
  return { status: 'ok' };
}

function simulateSessionStatus(state) {
  return {
    status: 'ok',
    hasFile: state.reconIdFixSession !== null,
    fileName: state.reconIdFixSession ? state.reconIdFixSession.fileName : null,
    sheetCounts: state.reconIdFixSession && state.reconIdFixSession.sheets
      ? {
          recon: state.reconIdFixSession.sheets.reconResult.length,
          business: state.reconIdFixSession.sheets.businessBills.length,
          opp: state.reconIdFixSession.sheets.opponentBills.length
        }
      : null,
    hasResult: state.reconIdFixResult !== null,
    resultStats: state.reconIdFixResult ? {
      fixedRowCount: state.reconIdFixResult.fixedRows.length,
      warningCount: state.reconIdFixResult.warnings.length,
      unmatchedRowCount: Array.isArray(state.reconIdFixResult.unmatchedRows) ? state.reconIdFixResult.unmatchedRows.length : 0
    } : null
  };
}

// ===== fixture 工具 =====
function setupDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join')),
      name TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      config_json TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (name)
    );
  `);
  ensureScenariosCategoryReconIdFix(db);
  return db;
}

function makeC4Payload(name = 'C4-IPC') {
  // PR-B Q1=B + Round 3 Decision 4：reconGroups[] 含 Amount 锁定
  return {
    category: 'recon-id-fix',
    name,
    priority: 0,
    enabled: true,
    config: {
      matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
      billTypes: [
        { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
        { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
      ],
      reconGroups: [
        {
          leftTypeSeq: 1,
          rightTypeSeq: 2,
          fieldPairs: [
            { leftField: 'Amount', rightField: 'Amount', locked: true },
            { leftField: 'OrderId', rightField: 'OrderId' }
          ]
        }
      ],
      output: {
        mode: 'main',
        commonId: null,
        subBizType: { mode: 'manualMain', mainValue: 'SBT-test' }
      }
    }
  };
}

function writeFourSheetXlsx({ reconRows, businessRows, opponentRows, savePath }) {
  const wb = XLSX.utils.book_new();
  const sheets = [
    { name: RECON_RESULT_SHEET_NAME, headers: RECON_RESULT_FIELDS.slice(), rows: reconRows },
    { name: BUSINESS_BILL_SHEET_NAME, headers: BUSINESS_BILL_FIELDS.slice(), rows: businessRows },
    { name: OPPONENT_BILL_SHEET_NAME, headers: OPPONENT_BILL_FIELDS.slice(), rows: opponentRows },
    { name: ORDER_REPAIR_SHEET_NAME, headers: ORDER_REPAIR_FIELDS.slice(), rows: [] }
  ];
  sheets.forEach(({ name, headers, rows }) => {
    const aoa = [headers, ...rows];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, sheet, name);
  });
  XLSX.writeFile(wb, savePath);
}

// Round 3：默认填 BillDate + Amount，让 Step 1 严格匹配能够命中
function makeBusinessAoa(o) {
  const merged = Object.assign({ BillDate: '2026-04-09', Amount: 100 }, o);
  return BUSINESS_BILL_FIELDS.map((f) => merged[f] ?? '');
}
function makeOpponentAoa(o) {
  const merged = Object.assign({ BillDate: '2026-04-09', Amount: 100 }, o);
  return OPPONENT_BILL_FIELDS.map((f) => merged[f] ?? '');
}

// ===== 主测试 =====
async function runReconIdFixIpcHandlersSmokeTests() {
  const tmpDir = path.join(__dirname, '..', '..', '.tmp-smoke-recon-id-fix-ipc');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // ===== T1：import 正常路径 → reconIdFixSession 落 + reconIdFixResult 清 =====
  {
    const filePath = path.join(tmpDir, 't1-ok.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T1', BillType: 'biz' })],
      opponentRows: [makeOpponentAoa({ OrderId: 'O-T1', BillType: 'biz', reconId: 'RID-T1' })],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: { stale: 'old-result' } };
    const res = simulateImport(state, filePath);
    assert.strictEqual(res.status, 'ok', 'T1 import status=ok');
    assert.strictEqual(res.fileName, 't1-ok.xlsx', 'T1 fileName');
    assert.deepStrictEqual(res.sheetCounts, { recon: 0, business: 1, opp: 1 }, 'T1 sheetCounts');
    assert.ok(state.reconIdFixSession, 'T1 reconIdFixSession 落');
    assert.strictEqual(state.reconIdFixResult, null, 'T1 reconIdFixResult 清（资金红线）');
  }

  // ===== T2：import 文件缺 sheet → invalid 分支带 detailLines =====
  {
    const filePath = path.join(tmpDir, 't2-missing-sheet.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), '随便');
    XLSX.writeFile(wb, filePath);
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    const res = simulateImport(state, filePath);
    assert.strictEqual(res.status, 'invalid', 'T2 status=invalid');
    assert.strictEqual(res.code, 'missing-sheet', 'T2 code=missing-sheet');
    assert.ok(Array.isArray(res.detailLines) && res.detailLines.length > 0, 'T2 detailLines 非空');
    assert.strictEqual(state.reconIdFixSession, null, 'T2 invalid 不应落 session');
  }

  // ===== T3：未导入 → run 拒绝 =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T3-sc'));
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    const res = simulateRun(state, db, sc.id);
    assert.strictEqual(res.status, 'failed', 'T3 未导入 → failed');
    assert.match(res.message, /请先点击.*导入文件/, 'T3 message');
  }

  // ===== T4：scenarioId=null → run 拒绝 =====
  {
    const db = setupDb();
    const filePath = path.join(tmpDir, 't4.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O', BillType: 'biz' })],
      opponentRows: [],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    const res = simulateRun(state, db, null);
    assert.strictEqual(res.status, 'failed', 'T4 scenarioId=null → failed');
    assert.match(res.message, /请先在主面板.*选择一个场景/, 'T4 message');
  }

  // ===== T5：scenarioId 不存在 → run 拒绝 =====
  {
    const db = setupDb();
    const filePath = path.join(tmpDir, 't5.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O', BillType: 'biz' })],
      opponentRows: [],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    const res = simulateRun(state, db, 999);
    assert.strictEqual(res.status, 'failed', 'T5 不存在场景 → failed');
    assert.match(res.message, /场景 id=999 不存在/, 'T5 message');
  }

  // ===== T6：scenario 是 C1 类 → run 拒绝（category 校验）=====
  {
    const db = setupDb();
    const c1 = createScenario(db, {
      category: 'extract-recon-id', name: 'T6-c1', priority: 0, enabled: true,
      config: {
        conditions: [{ field: 'X', op: '等于', value: 'y' }],
        extractByFeature: null,
        extractByOtherField: { field: 'X' }
      }
    });
    const filePath = path.join(tmpDir, 't6.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O', BillType: 'biz' })],
      opponentRows: [],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    const res = simulateRun(state, db, c1.id);
    assert.strictEqual(res.status, 'failed', 'T6 C1 类 → failed');
    assert.match(res.message, /不是单据对账类/, 'T6 message');
  }

  // ===== T7：run 正常路径 → 落 reconIdFixResult + scenariosSnapshot =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T7-sc'));
    const filePath = path.join(tmpDir, 't7.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T7', BillType: 'biz' })],
      opponentRows: [makeOpponentAoa({ OrderId: 'O-T7', BillType: 'biz', reconId: 'RID-T7' })],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    const res = simulateRun(state, db, sc.id);
    assert.strictEqual(res.status, 'ok', 'T7 run status=ok');
    assert.strictEqual(res.stats.fixedRowCount, 1, 'T7 命中 1 行');
    assert.ok(state.reconIdFixResult, 'T7 reconIdFixResult 落');
    assert.strictEqual(state.reconIdFixResult.scenarioId, sc.id, 'T7 scenarioId 一致');
    assert.ok(state.reconIdFixResult.scenariosSnapshot, 'T7 scenariosSnapshot 非空');
  }

  // ===== T8：export 正常路径 + 写盘成功 =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T8-sc'));
    const filePath = path.join(tmpDir, 't8.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T8', BillType: 'biz' })],
      opponentRows: [makeOpponentAoa({ OrderId: 'O-T8', BillType: 'biz', reconId: 'RID-T8' })],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    const outPath = path.join(tmpDir, 't8-out.xlsx');
    const res = await simulateExport(state, db, outPath);
    assert.strictEqual(res.status, 'ok', 'T8 export ok');
    assert.strictEqual(res.mainFilePath, outPath, 'T8 mainFilePath');
    assert.ok(fs.existsSync(outPath), 'T8 文件存在');
  }

  // ===== T9：未运行 → export 拒绝 =====
  {
    const db = setupDb();
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    const res = await simulateExport(state, db, '/tmp/no.xlsx');
    assert.strictEqual(res.status, 'failed', 'T9 未运行 → failed');
    assert.match(res.message, /请先点击.*开始运行/, 'T9 message');
  }

  // ===== T10：space saveDialog cancel → cancelled =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T10-sc'));
    const filePath = path.join(tmpDir, 't10.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T10', BillType: 'biz' })],
      opponentRows: [makeOpponentAoa({ OrderId: 'O-T10', BillType: 'biz', reconId: 'RID-T10' })],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    const res = await simulateExport(state, db, null);
    assert.strictEqual(res.status, 'cancelled', 'T10 用户取消 → cancelled');
    // 取消后 reconIdFixResult 仍保留（用户可再次点导出）
    assert.ok(state.reconIdFixResult, 'T10 reconIdFixResult 保留');
  }

  // ===== T11：主从都空 → export 返回 empty（不弹 saveDialog）=====
  // Round 3：主+unmatched 都为空才 empty。这里主从行都不存在
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T11-sc'));
    const filePath = path.join(tmpDir, 't11.xlsx');
    // 主从都为空：NoBusiness vs NoOpp（不属于 BillType=biz 类型）
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [],
      opponentRows: [],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    assert.strictEqual(state.reconIdFixResult.fixedRows.length, 0, 'T11 fixedRows 为空');
    assert.strictEqual(state.reconIdFixResult.unmatchedRows.length, 0, 'T11 unmatchedRows 为空');
    const res = await simulateExport(state, db, '/should-not-be-used');
    assert.strictEqual(res.status, 'empty', 'T11 主+unmatched 都空 → empty');
  }

  // ===== T12：snapshot 不一致（scenario.config 已改）→ stale-snapshot 拒绝 + 清 result =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T12-sc'));
    const filePath = path.join(tmpDir, 't12.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T12', BillType: 'biz' })],
      opponentRows: [makeOpponentAoa({ OrderId: 'O-T12', BillType: 'biz', reconId: 'RID-T12' })],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    assert.ok(state.reconIdFixResult, 'T12 run 后 result 在');
    // 模拟用户改了 scenario（mode main → both）
    updateScenario(db, sc.id, {
      config: {
        ...makeC4Payload('T12-sc').config,
        output: {
          mode: 'both',
          commonId: { source: 'main', suffix: '-Z' },
          subBizType: { mode: 'auto' }
        }
      }
    });
    // 注意：本 simulator 不模拟 main.js 的 scenarios:update 自动清 result（那里 main.js 已清）；
    // 这里只是模拟"假设 scenarios:update 没清 / 时间线漂移"——用 export 端的 snapshot 校验兜底
    const outPath = path.join(tmpDir, 't12-out.xlsx');
    const res = await simulateExport(state, db, outPath);
    assert.strictEqual(res.status, 'failed', 'T12 snapshot 不一致 → failed');
    assert.strictEqual(res.code, 'stale-snapshot', 'T12 code=stale-snapshot');
    assert.strictEqual(state.reconIdFixResult, null, 'T12 result 已清');
    assert.ok(!fs.existsSync(outPath), 'T12 文件未生成');
  }

  // ===== T13：scenario 已删除 → stale-snapshot =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T13-sc'));
    const filePath = path.join(tmpDir, 't13.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T13', BillType: 'biz' })],
      opponentRows: [makeOpponentAoa({ OrderId: 'O-T13', BillType: 'biz', reconId: 'RID-T13' })],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    deleteScenario(db, sc.id);
    const res = await simulateExport(state, db, '/should-not');
    assert.strictEqual(res.status, 'failed', 'T13 已删 → failed');
    assert.strictEqual(res.code, 'stale-snapshot', 'T13 code=stale-snapshot');
    assert.match(res.message, /场景已删除/, 'T13 message');
  }

  // ===== T14：session-status 4 字段汇报 =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T14-sc'));
    const filePath = path.join(tmpDir, 't14.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [
        makeBusinessAoa({ OrderId: 'O-T14a', BillType: 'biz' }),
        makeBusinessAoa({ OrderId: 'O-T14b', BillType: 'biz' })
      ],
      opponentRows: [makeOpponentAoa({ OrderId: 'O-T14a', BillType: 'biz', reconId: 'RID-A' })],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    // 起始：都为空
    let st = simulateSessionStatus(state);
    assert.strictEqual(st.hasFile, false, 'T14a hasFile=false');
    assert.strictEqual(st.hasResult, false, 'T14a hasResult=false');
    // 导入后：hasFile=true
    simulateImport(state, filePath);
    st = simulateSessionStatus(state);
    assert.strictEqual(st.hasFile, true, 'T14b hasFile=true');
    assert.strictEqual(st.fileName, 't14.xlsx', 'T14b fileName');
    assert.deepStrictEqual(st.sheetCounts, { recon: 0, business: 2, opp: 1 }, 'T14b sheetCounts');
    assert.strictEqual(st.hasResult, false, 'T14b hasResult=false');
    // 运行后：hasResult=true + resultStats
    simulateRun(state, db, sc.id);
    st = simulateSessionStatus(state);
    assert.strictEqual(st.hasResult, true, 'T14c hasResult=true');
    assert.strictEqual(st.resultStats.fixedRowCount, 1, 'T14c fixedRowCount=1');
  }

  // ===== T15：重新导入清 reconIdFixResult（资金红线 — 防旧结果导出新文件）=====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T15-sc'));
    const file1 = path.join(tmpDir, 't15-1.xlsx');
    const file2 = path.join(tmpDir, 't15-2.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'OA', BillType: 'biz' })],
      opponentRows: [makeOpponentAoa({ OrderId: 'OA', BillType: 'biz', reconId: 'RID-A' })],
      savePath: file1
    });
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'OB', BillType: 'biz' })],
      opponentRows: [makeOpponentAoa({ OrderId: 'OB', BillType: 'biz', reconId: 'RID-B' })],
      savePath: file2
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, file1);
    simulateRun(state, db, sc.id);
    assert.ok(state.reconIdFixResult, 'T15 第 1 次 run 后 result 在');
    // 重新导入 file2 → 应清 result
    simulateImport(state, file2);
    assert.strictEqual(state.reconIdFixResult, null, 'T15 重新导入清 reconIdFixResult');
    // 此时直接 export 应失败
    const res = await simulateExport(state, db, '/should-not');
    assert.strictEqual(res.status, 'failed', 'T15 未 run → failed');
  }

  // ===== T16（Round 3 + Round 5 P3-B）：export 主+unmatched 双文件输出，unmatched 文件名联动主名 =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T16-sc'));
    const filePath = path.join(tmpDir, 't16.xlsx');
    // 主 1 vs 从 1（同 OrderId+Amount）→ 命中；额外主 1 行 OrderId 不同 → unmatched
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [
        makeBusinessAoa({ OrderId: 'O-T16-OK', BillType: 'biz', Amount: 100 }),
        makeBusinessAoa({ OrderId: 'O-T16-LONELY', BillType: 'biz', Amount: 999 })
      ],
      opponentRows: [
        makeOpponentAoa({ OrderId: 'O-T16-OK', BillType: 'biz', Amount: 100, reconId: 'RID-T16-OPP' })
      ],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    assert.strictEqual(state.reconIdFixResult.fixedRows.length, 1, 'T16 命中 1');
    assert.ok(state.reconIdFixResult.unmatchedRows.length >= 1, 'T16 至少 1 unmatched（额外主）');
    const outPath = path.join(tmpDir, 't16-out.xlsx');
    const res = await simulateExport(state, db, outPath);
    assert.strictEqual(res.status, 'ok', 'T16 export ok');
    assert.ok(fs.existsSync(res.mainFilePath), 'T16 主文件存在');
    assert.ok(fs.existsSync(res.unmatchedFilePath), 'T16 unmatched 文件存在');
    // P3-B：unmatched 文件名 = 主文件 stem + '-未匹配.xlsx'
    assert.strictEqual(res.unmatchedFileName, 't16-out-未匹配.xlsx', 'T16 unmatched 文件名联动主名');
    assert.strictEqual(path.dirname(res.unmatchedFilePath), tmpDir, 'T16 unmatched 同目录');
  }

  // ===== T17（Round 3 + Round 5 P3-A）：仅 unmatched 时用户选定路径就是 unmatched 文件 =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T17-sc'));
    const filePath = path.join(tmpDir, 't17.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T17-LONE', BillType: 'biz', Amount: 999 })],
      opponentRows: [],   // 没有从 → 主一定 unmatch
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    assert.strictEqual(state.reconIdFixResult.fixedRows.length, 0, 'T17 fixedRows=0');
    assert.strictEqual(state.reconIdFixResult.unmatchedRows.length, 1, 'T17 1 unmatched');
    // 用户选定 t17-out.xlsx → 现在用户选什么名 unmatched 就写到那个路径（P3-A 修复 UX 困惑）
    const outPath = path.join(tmpDir, 't17-out.xlsx');
    const res = await simulateExport(state, db, outPath);
    assert.strictEqual(res.status, 'ok', 'T17 export ok');
    assert.strictEqual(res.mainFilePath, null, 'T17 主文件 null');
    assert.strictEqual(res.unmatchedFilePath, outPath, 'T17 unmatched 写到用户选定路径');
    assert.ok(fs.existsSync(outPath), 'T17 用户选定路径有文件');
    assert.strictEqual(res.unmatchedFileName, 't17-out.xlsx', 'T17 unmatched fileName 与用户选名一致');
  }

  // ===== T18（Round 5 P3-A）：fixedRows 空 + unmatched 非空 → saveDialog 默认名是 unmatched 名 =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T18-sc'));
    const filePath = path.join(tmpDir, 't18.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T18-LONE', BillType: 'biz', Amount: 555 })],
      opponentRows: [],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    assert.strictEqual(state.reconIdFixResult.fixedRows.length, 0, 'T18 fixedRows=0');
    assert.ok(state.reconIdFixResult.unmatchedRows.length >= 1, 'T18 unmatched 非空');
    let captured = null;
    const userPath = path.join(tmpDir, 't18-user-pick.xlsx');
    const res = await simulateExport(state, db, userPath, (defaultName) => { captured = defaultName; });
    assert.strictEqual(res.status, 'ok', 'T18 export ok');
    // P3-A：默认名应是 unmatched 名（前缀 `单据对账修复-未匹配-`），不是主名
    assert.ok(captured, 'T18 captured 默认名');
    assert.ok(captured.startsWith('单据对账修复-未匹配-'), `T18 默认名是 unmatched 名 (got: ${captured})`);
    assert.ok(captured.includes('T18-sc'), 'T18 默认名含 scenarioName');
    // 用户选 't18-user-pick.xlsx' → 文件实际写到该路径
    assert.strictEqual(res.unmatchedFilePath, userPath, 'T18 unmatched 写到用户选定路径');
    assert.ok(fs.existsSync(userPath), 'T18 用户路径有文件');
    assert.strictEqual(res.mainFilePath, null, 'T18 mainFilePath null');
  }

  // ===== T19（Round 5 P3-B）：fixedRows 非空 + 改主名 → unmatched 联动 =====
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T19-sc'));
    const filePath = path.join(tmpDir, 't19.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [
        makeBusinessAoa({ OrderId: 'O-T19-OK', BillType: 'biz', Amount: 100 }),
        makeBusinessAoa({ OrderId: 'O-T19-LONELY', BillType: 'biz', Amount: 999 })
      ],
      opponentRows: [
        makeOpponentAoa({ OrderId: 'O-T19-OK', BillType: 'biz', Amount: 100, reconId: 'RID-T19-OPP' })
      ],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    // 用户在 saveDialog 改主名为 myreport.xlsx
    const userMainPath = path.join(tmpDir, 'myreport.xlsx');
    const res = await simulateExport(state, db, userMainPath);
    assert.strictEqual(res.status, 'ok', 'T19 export ok');
    assert.strictEqual(res.mainFilePath, userMainPath, 'T19 主文件路径 = myreport.xlsx');
    assert.strictEqual(res.mainFileName, 'myreport.xlsx', 'T19 主文件名');
    // P3-B：unmatched 文件名应是 myreport-未匹配.xlsx
    assert.strictEqual(res.unmatchedFileName, 'myreport-未匹配.xlsx', 'T19 unmatched 联动主名');
    assert.strictEqual(path.dirname(res.unmatchedFilePath), tmpDir, 'T19 unmatched 同目录');
    assert.ok(fs.existsSync(res.unmatchedFilePath), 'T19 unmatched 文件存在');
    assert.ok(fs.existsSync(res.mainFilePath), 'T19 主文件存在');
  }

  // ===== T20（Round 5 P3-C）：buildReconIdFixSnapshot 同语义 config 不同 key 顺序 → 同 snapshot =====
  {
    // 关键：模拟 SQLite round-trip 后 config 的 key 顺序变化
    // 同语义 config（matchRules / billTypes / reconGroups / output 完全等价）但 key 顺序不同
    const sc1 = {
      id: 100, name: 'T20-sc', priority: 0, enabled: 1,
      config: {
        matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
        billTypes: [
          { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
        ],
        reconGroups: [
          { leftTypeSeq: 1, rightTypeSeq: 2,
            fieldPairs: [{ leftField: 'Amount', rightField: 'Amount', locked: true }] }
        ],
        output: { mode: 'main', commonId: null, subBizType: { mode: 'manualMain', mainValue: 'X' } }
      }
    };
    // 同语义但顶层 key 顺序倒过来 + 嵌套 key 顺序倒过来
    const sc2 = {
      id: 100, name: 'T20-sc', priority: 0, enabled: 1,
      config: {
        // 故意调换顶层 key 顺序
        output: { subBizType: { mainValue: 'X', mode: 'manualMain' }, commonId: null, mode: 'main' },
        reconGroups: [
          { fieldPairs: [{ rightField: 'Amount', locked: true, leftField: 'Amount' }],
            rightTypeSeq: 2, leftTypeSeq: 1 }
        ],
        billTypes: [
          { conditions: [{ value: 'biz', op: '等于', field: 'BillType' }], side: 'main', seq: 1 }
        ],
        matchRules: { manyToOne: false, oneToMany: false, oneToOne: true }
      }
    };
    const snap1 = buildReconIdFixSnapshot(sc1);
    const snap2 = buildReconIdFixSnapshot(sc2);
    assert.strictEqual(snap1, snap2, 'T20 同语义不同 key 顺序 → 同 snapshot（资金红线 P3-C）');
    // 反例：实际改了 config（mode main → both）→ 不同 snapshot
    const sc3 = JSON.parse(JSON.stringify(sc1));
    sc3.config.output.mode = 'both';
    const snap3 = buildReconIdFixSnapshot(sc3);
    assert.notStrictEqual(snap1, snap3, 'T20 真实改动 → 不同 snapshot');
    // 数组顺序敏感（不应该排序数组）
    const sc4 = JSON.parse(JSON.stringify(sc1));
    sc4.config.billTypes = [
      { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
      { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
    ];
    const sc5 = JSON.parse(JSON.stringify(sc1));
    sc5.config.billTypes = [
      { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] },
      { seq: 2, side: 'opp', conditions: [{ field: 'BillType', op: '等于', value: 'biz' }] }
    ];
    assert.notStrictEqual(buildReconIdFixSnapshot(sc4), buildReconIdFixSnapshot(sc5), 'T20 数组顺序敏感（语义不同）');
  }

  // ===== T21（v2.1.0-beta.3 PR #39 Codex#1 P2）：recon-id-fix:clear-session 清 main 端 session+result =====
  // 用户切换"账单类别"时调用，防 refreshReconIdFixStatus 从 main 端拉回旧 session/result 进 renderer state
  {
    const db = setupDb();
    const sc = createScenario(db, makeC4Payload('T21-clear-session'));
    const filePath = path.join(tmpDir, 't21.xlsx');
    writeFourSheetXlsx({
      reconRows: [],
      businessRows: [makeBusinessAoa({ OrderId: 'O-T21a', BillType: 'biz', Amount: 100 })],
      opponentRows: [makeOpponentAoa({ OrderId: 'O-T21a', BillType: 'biz', reconId: 'RID-T21' })],
      savePath: filePath
    });
    const state = { reconIdFixSession: null, reconIdFixResult: null };
    // 导入 + 运行，让 session + result 都非空
    simulateImport(state, filePath);
    simulateRun(state, db, sc.id);
    assert.notStrictEqual(state.reconIdFixSession, null, 'T21a 运行后 session 非空');
    assert.notStrictEqual(state.reconIdFixResult, null, 'T21a 运行后 result 非空');
    // 触发 clear-session
    const ret = simulateClearSession(state);
    assert.strictEqual(ret.status, 'ok', 'T21b clearSession 返回 ok');
    assert.strictEqual(state.reconIdFixSession, null, 'T21b session 已清');
    assert.strictEqual(state.reconIdFixResult, null, 'T21b result 已清');
    // 幂等：再调一次仍 ok
    const ret2 = simulateClearSession(state);
    assert.strictEqual(ret2.status, 'ok', 'T21c 幂等：再调仍 ok');
  }

  console.log('  recon-id-fix-ipc-handlers smoke: 21 / 21 PASS');
}

module.exports = { runReconIdFixIpcHandlersSmokeTests };
