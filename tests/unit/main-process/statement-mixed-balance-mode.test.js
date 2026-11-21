'use strict';

// v3.2.21 网银账单：渠道子模板余额方式可不一致（changes/v3.2.21/feat/channel-mixed-balance-mode/spec.md）。
//   resolveAccountBalanceModes：按条目收集账户 → 余额方式，同一账户命中不同方式为冲突（D3）；
//   deriveBalanceRecords 的 modeByAccount：各账户按自己的方式生成余额与种子（D2）。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  deriveBalanceRecords,
  resolveAccountBalanceModes
} = require('../../../src/main-process/statement-generation-business');

const DETAIL_HEADER = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'];
const BALANCE_FIELDS = ['银行名称', '所在地', '币种', '银行账号', '账单日期', '期初余额', '期初可用余额', '期末余额', '期末可用余额'];

function rows(dataRows) {
  return [DETAIL_HEADER.slice(), ...dataRows.map((row) => row.slice())];
}

function seedResolver(seeds) {
  return ({ merchantId, currency, targetBillDate, generationMethod }) => (
    seeds
      .filter((seed) => seed.merchantId === merchantId && seed.currency === currency && seed.billDate < targetBillDate)
      .filter((seed) => !generationMethod || seed.generationMethod === generationMethod)
      .sort((left, right) => right.billDate.localeCompare(left.billDate))[0] || null
  );
}

function balanceOf(record) {
  return [record[3], record[4], record[7]];
}

test('resolveAccountBalanceModes：账户各自一种方式时无冲突，返回账户 → 方式', () => {
  const result = resolveAccountBalanceModes([
    { templateName: 'A', balanceMode: 'calculated', detailRows: rows([['2026-09-01', 'M001', 'USD', '1', '', '']]) },
    { templateName: 'B', balanceMode: 'statement', detailRows: rows([['2026-09-01', 'M002', 'USD', '1', '', '9']]) },
    { templateName: 'C', balanceMode: 'none', detailRows: rows([['2026-09-01', 'M003', 'CNY', '1', '', '']]) },
    // 同一方式的两个子模板含同一账户：不算冲突
    { templateName: 'D', balanceMode: 'calculated', detailRows: rows([['2026-09-02', 'M001', 'USD', '1', '', '']]) }
  ]);
  assert.deepEqual(result.modeByAccount, { 'M001@@USD': 'calculated', 'M002@@USD': 'statement', 'M003@@CNY': 'none' });
  assert.deepEqual(result.conflicts, []);
});

test('resolveAccountBalanceModes：同一账户命中不同方式为冲突，逐账户列出子模板；同账号不同币种不算同一账户', () => {
  const result = resolveAccountBalanceModes([
    { templateName: '主', balanceMode: 'calculated', detailRows: rows([['2026-09-01', 'M002', 'USD', '1', '', ''], ['2026-09-01', 'M001', 'USD', '1', '', '']]) },
    { templateName: '费用', balanceMode: 'none', detailRows: rows([['2026-09-01', 'M001', 'USD', '', '1', ''], ['2026-09-01', 'M002', 'EUR', '1', '', '']]) },
    { templateName: '余额', balanceMode: 'statement', detailRows: rows([['2026-09-02', 'M001', 'USD', '1', '', '5']]) }
  ]);
  assert.deepEqual(result.conflicts, [{
    merchantId: 'M001',
    currency: 'USD',
    templates: [
      { templateName: '费用', balanceMode: 'none' },
      { templateName: '余额', balanceMode: 'statement' },
      { templateName: '主', balanceMode: 'calculated' }
    ]
  }]);
  assert.deepEqual(result.modeByAccount, { 'M002@@USD': 'calculated', 'M002@@EUR': 'none' });
});

test('resolveAccountBalanceModes：MerchantId 或账单日期为空的行无法归属账户，不参与判断', () => {
  const result = resolveAccountBalanceModes([
    { templateName: 'A', balanceMode: 'calculated', detailRows: rows([['2026-09-01', '', 'USD', '1', '', '']]) },
    { templateName: 'B', balanceMode: 'statement', detailRows: rows([['2026-09-01', '', 'USD', '1', '', '3'], ['', 'M009', 'USD', '1', '', '3']]) },
    { templateName: 'C', balanceMode: 'statement', detailRows: [] }
  ]);
  assert.deepEqual(result, { modeByAccount: {}, conflicts: [] });
});

test('resolveAccountBalanceModes：判断冲突时币种不区分大小写，modeByAccount 仍按原样账户键', () => {
  const conflict = resolveAccountBalanceModes([
    { templateName: '费用', balanceMode: 'none', detailRows: rows([['2026-09-01', 'M1', 'usd', '1', '', '']]) },
    { templateName: '余额', balanceMode: 'statement', detailRows: rows([['2026-09-01', 'M1', 'USD', '1', '', '9']]) }
  ]);
  assert.deepEqual(conflict.conflicts.map((item) => [item.merchantId, item.templates.map((template) => template.balanceMode)]), [
    ['M1', ['none', 'statement']]
  ]);
  assert.deepEqual(conflict.modeByAccount, {});

  const sameMode = resolveAccountBalanceModes([
    { templateName: 'A', balanceMode: 'statement', detailRows: rows([['2026-09-01', 'M1', 'usd', '1', '', '9']]) },
    { templateName: 'B', balanceMode: 'statement', detailRows: rows([['2026-09-02', 'M1', 'USD', '1', '', '10']]) },
    { templateName: 'C', balanceMode: 'none', detailRows: rows([['2026-09-01', 'M9', 'CNY', '1', '', '']]) }
  ]);
  assert.deepEqual(sameMode.conflicts, []);
  assert.deepEqual(sameMode.modeByAccount, { 'M1@@usd': 'statement', 'M1@@USD': 'statement', 'M9@@CNY': 'none' });
});

test('resolveAccountBalanceModes：收支都为空或 0 的行不算命中该子模板，收支同时有值的行照常参与', () => {
  const zeroOnly = resolveAccountBalanceModes([
    { templateName: '费用', balanceMode: 'none', detailRows: rows([
      ['2026-09-01', 'M1', 'USD', '0', '', ''],
      ['2026-09-01', 'M1', 'USD', '', '0.00', '']
    ]) },
    { templateName: '余额', balanceMode: 'statement', detailRows: rows([['2026-09-01', 'M1', 'USD', '1', '', '9']]) }
  ]);
  assert.deepEqual(zeroOnly, { modeByAccount: { 'M1@@USD': 'statement' }, conflicts: [] });

  const simultaneous = resolveAccountBalanceModes([
    { templateName: '费用', balanceMode: 'none', detailRows: rows([['2026-09-01', 'M1', 'USD', '2', '3', '']]) },
    { templateName: '余额', balanceMode: 'statement', detailRows: rows([['2026-09-01', 'M1', 'USD', '1', '', '9']]) }
  ]);
  assert.deepEqual(simultaneous.conflicts.map((item) => item.merchantId), ['M1']);
});

test('deriveBalanceRecords：modeByAccount 下计算账户按种子推算、账单余额账户逐日校验，种子方式各自正确', () => {
  const detailRows = rows([
    ['2026-09-01', 'M002', 'USD', '10', '', '210'],
    ['2026-09-01', 'M001', 'USD', '10', '', ''],
    ['2026-09-02', 'M001', 'USD', '', '1', ''],
    ['2026-09-02', 'M002', 'USD', '', '5', '205']
  ]);
  const result = deriveBalanceRecords({
    detailRows,
    templateName: '招商银行-上海',
    balanceTemplateFields: BALANCE_FIELDS,
    mode: 'statement',
    modeByAccount: { 'M001@@USD': 'calculated', 'M002@@USD': 'statement' },
    resolvePreviousBalanceSeed: seedResolver([
      { merchantId: 'M001', currency: 'USD', billDate: '2026-08-31', endBalance: 1000, generationMethod: '人工录入' },
      { merchantId: 'M002', currency: 'USD', billDate: '2026-08-31', endBalance: 200, generationMethod: '人工录入' }
    ])
  });
  assert.deepEqual(result.records.map(balanceOf), [
    ['M001', '2026-09-01', 1010],
    ['M001', '2026-09-02', 1009],
    ['M002', '2026-09-01', 210],
    ['M002', '2026-09-02', 205]
  ]);
  assert.deepEqual(result.seedRecords.map((record) => [record.merchantId, record.generationMethod]), [
    ['M001', '通过发生额计算'],
    ['M001', '通过发生额计算'],
    ['M002', '账单里的余额'],
    ['M002', '账单里的余额']
  ]);
});

test('deriveBalanceRecords：modeByAccount 中不出余额的账户不生成余额，也不要求其种子；未列出的账户按 mode', () => {
  const detailRows = rows([
    ['2026-09-01', 'M101', 'USD', '7', '', ''],
    ['2026-09-01', 'M102', 'USD', '', '20', '30']
  ]);
  const result = deriveBalanceRecords({
    detailRows,
    templateName: '招商银行-上海',
    balanceTemplateFields: BALANCE_FIELDS,
    mode: 'statement',
    modeByAccount: { 'M101@@USD': 'none' },
    resolvePreviousBalanceSeed: seedResolver([
      { merchantId: 'M102', currency: 'USD', billDate: '2026-08-31', endBalance: 50, generationMethod: '人工录入' }
    ])
  });
  assert.deepEqual(result.records.map(balanceOf), [['M102', '2026-09-01', 30]]);
});

test('deriveBalanceRecords：不传 modeByAccount 时全部按 mode（与此前一致）', () => {
  const detailRows = rows([
    ['2026-09-01', 'M001', 'USD', '10', '', '999'],
    ['2026-09-01', 'M002', 'USD', '1', '', '']
  ]);
  const result = deriveBalanceRecords({
    detailRows,
    templateName: '招商银行-上海',
    balanceTemplateFields: BALANCE_FIELDS,
    mode: 'calculated',
    resolvePreviousBalanceSeed: seedResolver([
      { merchantId: 'M001', currency: 'USD', billDate: '2026-08-31', endBalance: 100, generationMethod: '人工录入' },
      { merchantId: 'M002', currency: 'USD', billDate: '2026-08-31', endBalance: 5, generationMethod: '人工录入' }
    ])
  });
  // 计算模式不读账单余额列（999 被忽略）
  assert.deepEqual(result.records.map(balanceOf), [['M001', '2026-09-01', 110], ['M002', '2026-09-01', 6]]);
  assert.ok(result.seedRecords.every((record) => record.generationMethod === '通过发生额计算'));
});

// v3.2.21（T9）：冲突明细含账号只用于界面；错误报告与活动日志写错误对象的 persistedDetailLines。
test('createErrorResult：错误对象带 persistedDetailLines 时，错误报告与活动日志不写展示明细', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const acorn = require('acorn');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
  const node = ast.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === 'createErrorResult');
  const reports = [];
  const logs = [];
  const createErrorResult = Function(
    'archiveOperationContext', 'createPreflightErrorResult', 'createErrorReport', 'appendActivityLogEntry',
    `let lastErrorReport = null;\nreturn (${source.slice(node.start, node.end)});`
  )(
    { getStore: () => null },
    () => { throw new Error('不应走预检'); },
    (payload) => { reports.push(payload); return { fileName: 'report.txt' }; },
    (entry) => logs.push(entry)
  );
  const originalError = Object.assign(new Error('渠道「招商银行-上海」下同一账户命中了余额方式不同的子模板'), {
    persistedDetailLines: ['渠道「招商银行-上海」：1 个账户命中余额方式不同的子模板（招商银行-上海、CMB-SH）']
  });
  createErrorResult({
    step: '选择大账号',
    message: originalError.message,
    errorCode: 'CHANNEL_BALANCE_MODE_MISMATCH',
    detailLines: ['账户 6222000011112222（USD）：CMB-SH（取账单余额列）、招商银行-上海（通过发生额计算）'],
    originalError
  });
  assert.deepEqual(reports[0].detailLines, originalError.persistedDetailLines);
  assert.ok(!JSON.stringify(logs).includes('6222000011112222'));
  assert.ok(JSON.stringify(logs).includes('1 个账户命中余额方式不同的子模板'));

  // 没有 persistedDetailLines 时照常写 detailLines（其他错误行为不变）
  createErrorResult({ step: '导入', message: '其他错误', detailLines: ['第 3 行'] });
  assert.deepEqual(reports[1].detailLines, ['第 3 行']);
});
