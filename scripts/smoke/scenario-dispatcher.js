// v2.0.0-beta.3 PR #32a：first-match-wins 调度引擎 smoke 测试
// 接入 smoke 流程

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
  runAllScenarios,
  sortScenariosByPriority,
  filterScenariosByGwAvailability
} = require('../../src/main-process/scenario-dispatcher');

const {
  writeBankStatementOutput,
  writeErrorReport
} = require('../../src/main-process/exceljs-writer');

const ExcelJS = require('exceljs');

// ===== 工具：构造场景 =====

function makeC1Scenario(overrides = {}) {
  return {
    id: 1,
    name: 'C1 调拨ReconId自提取',
    category: 'extract-recon-id',
    priority: 3,
    enabled: true,
    config: {
      conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
      extractByFeature: {
        enabled: true,
        searchFields: ['CustomerRef'],
        featureCode: 'FT',
        digitCount: 12,
        totalLength: 15
      },
      extractByOtherField: null
    },
    ...overrides
  };
}

function makeC2Scenario(overrides = {}) {
  return {
    id: 2,
    name: 'C2 outbound Fail打标',
    category: 'offset-bill-mark',
    priority: 2,
    enabled: true,
    config: {
      billTypes: [
        { seq: 1, field: 'FundType', op: '等于', value: 'outbound Fail' },
        { seq: 2, field: 'FundType', op: '等于', value: 'outbound' }
      ],
      reconFields: [
        { seq: 1, leftType: 1, leftField: 'CustomerRef', rightType: 2, rightField: 'CustomerRef' },
        { seq: 2, leftType: 1, leftField: 'Credit Amount', rightType: 2, rightField: 'Debit Amount' }
      ],
      markValue: { type: 2, field: 'FundType', value: 'outbound Fail' }
    },
    ...overrides
  };
}

function makeC3Scenario(overrides = {}) {
  return {
    id: 3,
    name: 'C3 调拨ReconId From网关',
    category: 'gateway-recon-join',
    priority: 1,
    enabled: true,
    config: {
      reconFields: [
        { seq: 1, gwField: 'Currency', bankField: 'Currency' },
        { seq: 2, gwField: 'Amount', bankField: '发生额绝对值' },
        { seq: 3, gwField: 'MerchantId', bankField: 'MerchantId' },
        { seq: 4, gwField: 'Bank', bankField: 'Channel' }
      ],
      assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId' }
    },
    ...overrides
  };
}

async function runScenarioDispatcherSmokeTests() {
  // ===== Dispatcher D1: 单 C1 命中 =====
  {
    const bankRows = [
      { _rowId: 'r1', CustomerRef: 'AFT123456789012', 'Extra Information': '', ReconciliationId: '' },
      { _rowId: 'r2', CustomerRef: 'no_match', 'Extra Information': '', ReconciliationId: '' }
    ];
    const result = runAllScenarios(bankRows, null, [makeC1Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 1, 'D1 应有 1 行命中');
    assert.strictEqual(result.modifiedRows[0]._rowId, 'r1', 'D1 应是 r1');
    assert.strictEqual(result.modifiedRows[0]._hitScenarioId, 1, 'D1 应记 scenarioId');
    assert(result.modifiedRows[0]._modifiedColumns.has('ReconciliationId'), 'D1 应记 column');
    assert.strictEqual(result.stats.hitRowCount, 1, 'D1 stats hitRowCount');
    assert.strictEqual(result.stats.scenarioHitCount, 1, 'D1 scenarioHitCount');
  }

  // ===== Dispatcher D2: 单 C2 命中（双锁）=====
  {
    const bankRows = [
      { _rowId: 'rA', FundType: 'outbound Fail', CustomerRef: 'CUST-A', 'Credit Amount': 100, 'Debit Amount': 0 },
      { _rowId: 'rB', FundType: 'outbound', CustomerRef: 'CUST-A', 'Credit Amount': 0, 'Debit Amount': 100 }
    ];
    const result = runAllScenarios(bankRows, null, [makeC2Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 2, 'D2 双锁应 2 行');
    const rowIds = result.modifiedRows.map((r) => r._rowId).sort();
    assert.deepStrictEqual(rowIds, ['rA', 'rB'], 'D2 双方都应入 modifiedRows');
    // rA 没改字段，但 _hitScenarioId 也应填上（dispatcher 视 lockedRowIds 全部为命中）
    const rA = result.modifiedRows.find((r) => r._rowId === 'rA');
    assert.strictEqual(rA._hitScenarioName, 'C2 outbound Fail打标', 'D2 leftRow 也记 hitScenario');
    // rB 改了 FundType
    const rB = result.modifiedRows.find((r) => r._rowId === 'rB');
    assert(rB._modifiedColumns.has('FundType'), 'D2 rB 应记 FundType 改动');
  }

  // ===== Dispatcher D3: first-match-wins（C1 优先级 3 + C3 优先级 1 同行）=====
  {
    const bankRows = [
      {
        _rowId: 'rX',
        CustomerRef: 'AFT123456789012',
        'Extra Information': '',
        Currency: 'CNY',
        'Credit Amount': 100,
        'Debit Amount': 0,
        MerchantId: 'M001',
        Channel: 'BankA',
        ReconciliationId: ''
      }
    ];
    const gwRows = [{ Currency: 'CNY', Amount: 100, MerchantId: 'M001', Bank: 'BankA', reconciliationId: 'GW_FROM_C3' }];
    const result = runAllScenarios(bankRows, gwRows, [makeC1Scenario(), makeC3Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 1, 'D3 应 1 行');
    assert.strictEqual(
      result.modifiedRows[0]._hitScenarioId,
      1,
      'D3 first-match-wins：C1 优先级 3 > C3 优先级 1，应记 C1'
    );
    assert.strictEqual(
      bankRows[0].ReconciliationId,
      'AFT123456789012',
      'D3 ReconciliationId 应被 C1 写入，C3 不再覆盖'
    );
  }

  // ===== Dispatcher D4: gwRows = null → C3 类被过滤 =====
  {
    const bankRows = [
      { _rowId: 'rY', Currency: 'CNY', 'Credit Amount': 100, 'Debit Amount': 0, MerchantId: 'M001', Channel: 'BankA', ReconciliationId: '' }
    ];
    const result = runAllScenarios(bankRows, null, [makeC3Scenario()]);
    assert.strictEqual(result.modifiedRows.length, 0, 'D4 C3 被过滤应 0 行');
    assert.strictEqual(result.stats.skippedC3Count, 1, 'D4 stats.skippedC3Count');
  }

  // ===== Dispatcher D5: 全部 disabled → 无命中 =====
  {
    const bankRows = [{ _rowId: 'rZ', CustomerRef: 'AFT123456789012', ReconciliationId: '' }];
    const c1Disabled = makeC1Scenario({ enabled: false });
    const result = runAllScenarios(bankRows, null, [c1Disabled]);
    assert.strictEqual(result.modifiedRows.length, 0, 'D5 全部 disabled 应 0 行');
    assert.strictEqual(result.stats.scenarioHitCount, 0, 'D5 scenarioHitCount');
  }

  // ===== Helper unit: sortScenariosByPriority =====
  {
    const list = [
      { id: 5, priority: 1 },
      { id: 1, priority: 3 },
      { id: 3, priority: 3 },
      { id: 7, priority: 2 }
    ];
    const sorted = sortScenariosByPriority(list);
    assert.deepStrictEqual(sorted.map((s) => s.id), [1, 3, 7, 5], 'sortScenariosByPriority 应 priority desc, id asc');
  }

  // ===== Helper unit: filterScenariosByGwAvailability =====
  {
    const list = [{ category: 'extract-recon-id' }, { category: 'gateway-recon-join' }, { category: 'offset-bill-mark' }];
    assert.strictEqual(filterScenariosByGwAvailability(list, []).length, 2, 'gwRows 空 → 过滤 C3');
    assert.strictEqual(filterScenariosByGwAvailability(list, null).length, 2, 'gwRows null → 过滤 C3');
    assert.strictEqual(filterScenariosByGwAvailability(list, [{}]).length, 3, 'gwRows 非空 → 全保留');
  }

  console.log('  scenario-dispatcher: 7/7 PASS');
}

// ===== exceljs-writer round-trip =====

async function runExceljsWriterSmokeTests() {
  const tmpDir = path.join(__dirname, '..', '..', '.tmp-smoke');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // I1: 主输出标黄 round-trip
  {
    const headers = ['col1', 'col2', 'col3'];
    const rows = [
      { col1: 'a', col2: 'b', col3: 'c', _rowId: 'r1', _modifiedColumns: new Set(['col2']) },
      { col1: 'x', col2: 'y', col3: 'z', _rowId: 'r2', _modifiedColumns: new Set(['col1', 'col3']) }
    ];
    const out = path.join(tmpDir, 'main-output.xlsx');
    await writeBankStatementOutput(rows, headers, out);
    assert(fs.existsSync(out), 'I1 文件应被创建');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet('渠道对账单');
    assert.strictEqual(sheet.getCell(1, 1).value, 'col1', 'I1 表头 col1');
    assert.strictEqual(sheet.getCell(2, 2).value, 'b', 'I1 数据 r1.col2');
    // r1.col2 被标黄
    const r1c2Fill = sheet.getCell(2, 2).fill;
    assert(r1c2Fill && r1c2Fill.fgColor && r1c2Fill.fgColor.argb === 'FFFFFF00', 'I1 r1.col2 应黄底');
    // r1.col1 未标黄
    const r1c1Fill = sheet.getCell(2, 1).fill;
    assert(!r1c1Fill || !r1c1Fill.fgColor, 'I1 r1.col1 不应黄底');
    // r2.col1 被标黄
    const r2c1Fill = sheet.getCell(3, 1).fill;
    assert(r2c1Fill && r2c1Fill.fgColor && r2c1Fill.fgColor.argb === 'FFFFFF00', 'I1 r2.col1 应黄底');
  }

  // I2: error-report 4 列
  {
    const warnings = [
      { scenarioId: 1, scenarioName: 'C1 提取', rowId: 'r5', code: 'inconsistent-recon-id-values', message: '多字段值不一致' },
      { scenarioId: 2, scenarioName: 'C2 打标', rowId: 'r10', code: 'one-to-many', message: '一对多匹配' }
    ];
    const out = path.join(tmpDir, 'error-report.xlsx');
    await writeErrorReport(warnings, out);
    assert(fs.existsSync(out), 'I2 文件应被创建');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet('error-report');
    assert.strictEqual(sheet.getCell(1, 1).value, '时间戳', 'I2 表头 1');
    assert.strictEqual(sheet.getCell(1, 2).value, '场景名', 'I2 表头 2');
    assert.strictEqual(sheet.getCell(1, 3).value, '行号', 'I2 表头 3');
    assert.strictEqual(sheet.getCell(1, 4).value, '原因', 'I2 表头 4');
    assert.strictEqual(sheet.getCell(2, 2).value, 'C1 提取', 'I2 r2 场景名');
    assert.strictEqual(sheet.getCell(2, 3).value, 'r5', 'I2 r2 行号');
    assert.strictEqual(sheet.getCell(2, 4).value, '多字段值不一致', 'I2 r2 原因');
  }

  // I3: 空 modifiedRows 也能写表头
  {
    const headers = ['col1', 'col2'];
    const out = path.join(tmpDir, 'empty.xlsx');
    await writeBankStatementOutput([], headers, out);
    assert(fs.existsSync(out), 'I3 空数据也应能写文件');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sheet = wb.getWorksheet('渠道对账单');
    assert.strictEqual(sheet.getCell(1, 1).value, 'col1', 'I3 表头 col1');
    assert.strictEqual(sheet.actualRowCount, 1, 'I3 仅表头 1 行');
  }

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('  exceljs-writer: 3/3 PASS');
}

module.exports = {
  runScenarioDispatcherSmokeTests,
  runExceljsWriterSmokeTests
};
