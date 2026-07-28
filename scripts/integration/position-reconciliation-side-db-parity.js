// 平盘资金性质校验 side DB 集成回放
// 覆盖：银行/链接导入、原子拒绝、跨重启草稿恢复、版本快照失效、
//       重新运行、49 列导出、确认写入及主库零批量明细。
//
// 用法：node scripts/integration/position-reconciliation-side-db-parity.js

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const {
  createPositionReconciliationService
} = require('../../src/main-process/position-reconciliation/service');
const {
  BANK_SHEET_NAME,
  POSITION_BANK_HEADERS,
  POSITION_DB_RELATIVE_PATH,
  SOURCE_DEFINITIONS,
  SOURCE_TYPES
} = require('../../src/main-process/position-reconciliation/constants');
const {
  BANK_STATEMENT_FIELDS
} = require('../../src/constants/bank-statement-fields');

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATE_PATH = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, detail });
}

function assertEq(actual, expected, label) {
  assertTrue(Object.is(actual, expected), label, `expected=${expected} actual=${actual}`);
}

function writeWorkbook(filePath, sheetName, headers, rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => headers.map((header) => row[header] ?? ''))
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filePath);
}

function bankRow(overrides = {}) {
  return {
    BizId: 'POSITION-INTEGRATION-1',
    BillDate: '2026-07-20',
    Channel: 'DBS',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': '100',
    'Debit Amount': '0',
    ReconciliationId: 'RID-INTEGRATION-1',
    FundType: 'Inbound&FX',
    ...overrides
  };
}

function inboundRow(overrides = {}) {
  return {
    bizId: 'INBOUND-INTEGRATION-1',
    billDate: '2026-07-20',
    tradeType: 'Inbound-VA',
    reconId: 'RID-INTEGRATION-1',
    channel: 'DBS',
    merchantId: 'M001',
    currency: 'USD',
    amount: '100',
    originOutboundCurrency: 'USD',
    ...overrides
  };
}

async function expectErrorCode(action, expectedCode, label) {
  try {
    await action();
    assertTrue(false, label, `expected error code ${expectedCode}`);
  } catch (error) {
    assertEq(error && error.code, expectedCode, label);
  }
}

async function run() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-side-db-integration-'));
  const mainDbPath = path.join(userDataDir, 'tool-data.sqlite');
  const bankPath = path.join(userDataDir, 'bank.xlsx');
  const invalidBankPath = path.join(userDataDir, 'bank-invalid.xlsx');
  const sourcePath = path.join(userDataDir, 'gateway-inbound.xlsx');
  const sourceRefreshPath = path.join(userDataDir, 'gateway-inbound-refresh.xlsx');
  const firstResultPath = path.join(userDataDir, 'result-before-refresh.xlsx');
  const finalResultPath = path.join(userDataDir, 'result-final.xlsx');
  let service = null;

  console.log('==== 平盘资金性质校验 side DB 集成验证 ====');
  try {
    const mainDb = new DatabaseSync(mainDbPath);
    mainDb.exec('CREATE TABLE app_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    mainDb.prepare('INSERT INTO app_sentinel(value) VALUES (?)').run('keep');
    mainDb.close();

    writeWorkbook(bankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [bankRow()]);
    writeWorkbook(invalidBankPath, BANK_SHEET_NAME, BANK_STATEMENT_FIELDS, [
      bankRow({ BizId: 'POSITION-REPLACEMENT-VALID' }),
      bankRow({ BizId: '', ReconciliationId: 'RID-INVALID' })
    ]);
    writeWorkbook(
      sourcePath,
      '账单明细',
      SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
      [inboundRow()]
    );
    writeWorkbook(
      sourceRefreshPath,
      '账单明细',
      SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_INBOUND].headers,
      [inboundRow({ finishTime: '2026-07-20 10:00:00' })]
    );

    service = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH,
      now: () => new Date(2026, 6, 26, 9, 30, 0)
    });

    const preparedBank = service.prepareBankImport([bankPath]);
    assertEq(preparedBank.rowCount, 1, '银行文件预解析得到一行');
    assertEq(service.applyBankImport(preparedBank.token).rowCount, 1, '银行数据写入 side DB');

    await expectErrorCode(
      () => service.prepareBankImport([invalidBankPath]),
      'position-bank-row-invalid',
      '银行替换文件含坏行时整份拒绝'
    );
    assertEq(service.store.getBankRows().length, 1, '失败替换后原银行批次仍完整');
    assertEq(
      service.store.getBankRows()[0].biz_id,
      'POSITION-INTEGRATION-1',
      '失败替换未写入前置合法行'
    );

    const sourceImport = service.prepareSourceImport([sourcePath]);
    assertEq(sourceImport.successCount, 1, '网关入账原始表导入成功');
    assertEq(
      service.store.sourceRecords(SOURCE_TYPES.GATEWAY_INBOUND).length,
      1,
      '链接原始行只保存在 position side DB'
    );

    const firstRun = service.run({ channels: ['DBS'], months: ['2026-07'] });
    assertEq(firstRun.summary.inputRows, 1, '首轮运行输入行数守恒');
    assertEq(firstRun.summary.changedRows, 1, '首轮将错误 FX 性质修正为基础类型');
    assertEq(firstRun.summary.differenceRows, 0, '明确币种证据不进入差异');
    const firstRunId = firstRun.runId;

    service.close();
    service = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH
    });
    const restored = service.status().pendingRun;
    assertEq(restored && restored.id, firstRunId, '应用重启后恢复待确认草稿');
    assertEq(restored && restored.stale, false, '重启未改变数据版本时草稿仍有效');

    await service.exportRun(firstRunId, firstResultPath);
    const firstWorkbook = XLSX.readFile(firstResultPath, { raw: true });
    const firstRows = XLSX.utils.sheet_to_json(firstWorkbook.Sheets[BANK_SHEET_NAME], {
      header: 1,
      defval: ''
    });
    assertEq(firstRows[0].length, POSITION_BANK_HEADERS.length, '结果文件固定49列表头');
    assertTrue(
      firstRows[0].every((header, index) => header === POSITION_BANK_HEADERS[index]),
      '结果文件49列表头顺序严格一致'
    );
    assertEq(
      firstRows[1][POSITION_BANK_HEADERS.indexOf('FundType')],
      'Inbound',
      '结果文件输出修正后的 FundType'
    );

    const refreshed = service.prepareSourceImport([sourceRefreshPath]);
    assertEq(refreshed.successCount, 1, '同业务主键后续导入原子更新成功');
    assertEq(service.status().pendingRun.stale, true, '链接数据版本变化后旧草稿失效');
    await expectErrorCode(
      () => service.exportRun(firstRunId, path.join(userDataDir, 'must-not-exist.xlsx')),
      'position-run-stale',
      '失效草稿禁止再次导出'
    );
    assertTrue(
      !fs.existsSync(path.join(userDataDir, 'must-not-exist.xlsx')),
      '失效导出不留下文件'
    );

    const replacePrompt = service.run({ channels: ['DBS'], months: ['2026-07'] });
    assertEq(
      replacePrompt.status,
      'needs-replace-confirmation',
      '存在待确认草稿时先要求显式替换'
    );
    const secondRun = service.run({
      channels: ['DBS'],
      months: ['2026-07'],
      replacePendingRunId: firstRunId
    });
    assertEq(secondRun.status, 'ok', '确认替换后重新生成草稿');
    assertTrue(secondRun.runId !== firstRunId, '重新运行使用新的稳定运行ID');

    await expectErrorCode(
      () => service.confirmRun(secondRun.runId),
      'position-run-confirm-gate',
      '未导出或合法回导前禁止确认'
    );
    await service.exportRun(secondRun.runId, finalResultPath);
    const confirmed = service.confirmRun(secondRun.runId);
    assertEq(confirmed.confirmedRows, 1, '成功导出后确认一行');

    const savedBank = service.store.getBankRows()[0];
    assertEq(savedBank.status, '已校验性质', '确认后银行状态更新为已校验性质');
    assertEq(savedBank.workingRow.FundType, 'Inbound', '系统工作表库保存确认后的 FundType');
    assertEq(savedBank.originalRow.FundType, 'Inbound&FX', '原始银行行快照保持导入值不变');
    assertEq(
      JSON.parse(savedBank.original_json).FundType,
      'Inbound&FX',
      '持久化 original_json 未被确认动作改写'
    );

    const diagnostics = service.diagnostics();
    assertEq(
      diagnostics.dbPath,
      path.join(userDataDir, POSITION_DB_RELATIVE_PATH),
      '诊断接口指向独立 position side DB'
    );
    assertEq(diagnostics.tableCounts.position_bank_rows, 1, 'side DB 保存银行批量明细');
    assertEq(diagnostics.tableCounts.position_source_rows, 1, 'side DB 保存链接原始明细');
    assertEq(diagnostics.tableCounts.position_link_rows, 1, 'side DB 保存转换后的链接行');
    assertEq(diagnostics.tableCounts.position_runs, 2, 'side DB 保留失效与已确认运行审计');
    assertEq(diagnostics.tableCounts.position_run_rows, 2, '每次运行结果独立保存');
    assertEq(diagnostics.tableCounts.position_consumed_sources, 1, '已确认链接记录保存全局消费审计');

    service.close();
    service = null;

    const sideDb = new DatabaseSync(path.join(userDataDir, POSITION_DB_RELATIVE_PATH), {
      readOnly: true
    });
    try {
      const statuses = sideDb.prepare(
        'SELECT status FROM position_runs ORDER BY id'
      ).all().map((row) => row.status);
      assertEq(statuses.join(','), 'superseded,confirmed', '运行状态完整记录替换与确认');
    } finally {
      sideDb.close();
    }

    const mainCheck = new DatabaseSync(mainDbPath, { readOnly: true });
    try {
      assertEq(
        mainCheck.prepare('SELECT value FROM app_sentinel WHERE id = 1').get().value,
        'keep',
        '平盘运行不修改主库既有数据'
      );
      const leaked = mainCheck.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'position_%'
      `).get();
      assertEq(Number(leaked.count), 0, '主库没有 position 批量明细表');
    } finally {
      mainCheck.close();
    }
  } finally {
    if (service) service.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    for (const failure of failures) {
      console.error(`  - ${failure.label}: ${failure.detail}`);
    }
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
