'use strict';

// v3.2.21 release 审查：写进活动日志的说明文字中形似账号、卡号的编号只写位数（AGENTS.md 敏感数据边界）。
//   模板包导入跳过模板时的原因来自校验异常消息，可能带完整的大账号。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '../../../src/main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });

function loadMainFunction(name, deps = {}) {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
  assert.ok(node, name);
  return Function(...Object.keys(deps), `return (${MAIN_SOURCE.slice(node.start, node.end)});`)(...Object.values(deps));
}

const maskAccountLikeTextForLog = loadMainFunction('maskAccountLikeTextForLog');

test('maskAccountLikeTextForLog：已知账号不论写法整体替换；其余连续 4 位以上的数字（可按组分隔、全角）只写位数', () => {
  // 已知账号（如模板包条目里的大账号）：按四位一组、夹字母的写法都整体替换，不按写法猜边界
  assert.equal(
    maskAccountLikeTextForLog('大账号 6222 0212 3456 7890 123 的币种 USD 重复', ['6222 0212 3456 7890 123']),
    '大账号 （23位账号） 的币种 USD 重复'
  );
  assert.equal(maskAccountLikeTextForLog('大账号 A1B2C3D4E5 的币种 USD 重复', ['A1B2C3D4E5', '', null]), '大账号 （10位账号） 的币种 USD 重复');
  // 未知号码：数字之间夹空格、连字符、点的写法同样按一串计
  assert.equal(maskAccountLikeTextForLog('大账号「6222021234567890123」与币种「USD」重复'), '大账号「（19位数字）」与币种「USD」重复');
  assert.equal(maskAccountLikeTextForLog('账号 6222 0212 3456 7890 已存在'), '账号 （16位数字） 已存在');
  assert.equal(maskAccountLikeTextForLog('账号 6222-0212-3456 已存在'), '账号 （12位数字） 已存在');
  assert.equal(maskAccountLikeTextForLog('账号 ６２２２０２１２ 已存在'), '账号 （8位数字） 已存在');
  assert.equal(maskAccountLikeTextForLog('大账号 NET20261234 已存在'), '大账号 NET（8位数字） 已存在');
  // 3 位以内的数字、字段名与币种不变
  assert.equal(maskAccountLikeTextForLog('映射字段不存在：Transaction Description'), '映射字段不存在：Transaction Description');
  assert.equal(maskAccountLikeTextForLog('特征值「流水号」：筛选字段不存在：ABC123（第 12 行）'), '特征值「流水号」：筛选字段不存在：ABC123（第 12 行）');
  assert.equal(maskAccountLikeTextForLog(undefined), '');
});

test('模板包导入跳过模板时，活动日志的原因经 maskAccountLikeTextForLog 脱敏', () => {
  const start = MAIN_SOURCE.indexOf("message: '模板包导入时跳过模板'");
  assert.ok(start > 0);
  const snippet = MAIN_SOURCE.slice(start - 400, start + 400);
  // 条目里三类大账号配置的账号都传入，按原样整体替换
  assert.match(snippet, /const entryAccountValues = collectTemplateAccountValuesForLog\(entry\);/);
  const { normalizeCell } = require('../../../src/backend/file-service');
  const collectTemplateAccountValuesForLog = loadMainFunction('collectTemplateAccountValuesForLog', { normalizeCell });
  assert.deepEqual(collectTemplateAccountValuesForLog(
    { bigAccounts: [{ merchantId: ' AC12B34 ' }], fixedAssignments: [{ merchantId: 'M2' }], currencyBigAccounts: [{ merchantId: 'M3' }], other: [{ merchantId: 'X' }] },
    { bigAccounts: [{ merchantId: 'OWN1' }], accountMappings: [{ bankAccountId: 'BK12A', clearingAccountId: 'CL9' }] },
    null
  ), ['AC12B34', 'M2', 'M3', 'OWN1', 'BK12A', 'CL9']);
  // 旧模板包条目只在 MerchantId 映射行保存固定账号（__FIXED__:AC-X7Y8Z9）、没有大账号记录时，按兼容口径解出（release 审查）
  const legacyDeps = { normalizeCell, FIXED_FIELD_VALUE_PREFIX: '__FIXED__:', MERCHANT_ID_SELF_INPUT_OPTION: '自己输入',
    MERCHANT_ID_MULTI_ACCOUNT_MARKER: '__MULTI_BIG_ACCOUNT__', MERCHANT_ID_CURRENCY_ONLY_MARKER: '__CURRENCY_ONLY__',
    MERCHANT_ID_CURRENCY_ONLY_OPTION: '原始账单仅有币种无账户号' };
  legacyDeps.decodeCustomInputMappingValue = loadMainFunction('decodeCustomInputMappingValue', legacyDeps);
  legacyDeps.extractFixedMappingValue = loadMainFunction('extractFixedMappingValue', legacyDeps);
  const buildCompatibleBigAccounts = loadMainFunction('buildCompatibleBigAccounts', legacyDeps);
  const collectWithLegacy = loadMainFunction('collectTemplateAccountValuesForLog', { normalizeCell, buildCompatibleBigAccounts });
  assert.deepEqual(collectWithLegacy({
    name: 'AC-X7Y8Z9 旧模板',
    mappings: [{ templateField: 'MerchantId', mappedField: '__FIXED__:AC-X7Y8Z9' }, { templateField: 'Currency', mappedField: '币种' }]
  }), ['AC-X7Y8Z9']);
  assert.deepEqual(collectWithLegacy({ mappings: [{ templateField: 'MerchantId', mappedField: '账号' }] }), []);
  assert.match(snippet, /原因：\$\{maskAccountLikeTextForLog\(error\.message, entryAccountValues\)\}/);
  // 模板名由用户填写，可能含账号：同样脱敏
  assert.match(snippet, /模板名：\$\{maskAccountLikeTextForLog\(entry\.name, entryAccountValues\)\}/);
  assert.doesNotMatch(snippet, /模板名：\$\{entry\.name\}/);
  assert.doesNotMatch(snippet, /原因：\$\{error\.message\}/);
});

// release 审查：渠道余额错误写进错误报告与活动日志的明细（persistedLines / persistedDetailLines）中，子模板名（用户填写，
//   可能以账号命名）的编号只写位数；弹窗明细照常显示原名
test('渠道余额错误的落盘明细中子模板名脱敏，弹窗明细保留原名', () => {
  const { FileValidationError, normalizeCell } = require('../../../src/backend/file-service');
  const { buildFieldIndexMap } = require('../../../src/main-process/statement-generation-business');
  const { isZeroOrBlankAmount } = require('../../../src/backend/file-service/normalizers');
  const collectEntryMerchantIdsForLog = loadMainFunction('collectEntryMerchantIdsForLog', { buildFieldIndexMap, normalizeCell });
  const inspectBalanceEntryRows = loadMainFunction('inspectBalanceEntryRows', {
    buildFieldIndexMap, normalizeCell, isZeroOrBlankAmount, maskAccountLikeTextForLog, collectEntryMerchantIdsForLog
  });
  const accountName = '对公6222021234567890123';
  const rows = [['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'], ['', 'M1', 'USD', '5', '']];
  const inspected = inspectBalanceEntryRows([{ templateName: accountName, fileName: 'a.xlsx', fileOrdinal: 1, detailRows: rows }]);
  assert.deepEqual([inspected.lines, inspected.persistedLines], [
    [`文件「a.xlsx」（子模板「${accountName}」）第2行：缺少账单日期`],
    ['本组第1个文件（子模板「对公（19位数字）」）第2行：缺少账单日期']
  ]);

  const buildChannelBalanceModeMismatchError = loadMainFunction('buildChannelBalanceModeMismatchError', { FileValidationError, maskAccountLikeTextForLog });
  const error = buildChannelBalanceModeMismatchError([{
    channelName: '招商银行', lines: [`账户 M1（USD）：${accountName}（不出余额）、主（取账单余额列）`], accountCount: 1, templateNames: [accountName, '主']
  }]);
  assert.deepEqual(error.detailLines, [`账户 M1（USD）：${accountName}（不出余额）、主（取账单余额列）`]);
  assert.deepEqual(error.persistedDetailLines, ['渠道「招商银行」：1 个账户命中余额方式不同的子模板（对公（19位数字）、主）']);

  // release 审查：渠道名同样由用户填写、可能以账号命名：两类错误的落盘明细中渠道名都只写编号位数，弹窗明细保留原名
  const channelName = '渠道6222021234567890123';
  const named = buildChannelBalanceModeMismatchError([
    { channelName, lines: ['账户 M1（USD）：A（不出余额）、B（取账单余额列）'], accountCount: 1, templateNames: ['A', 'B'] },
    { channelName: '招商银行', lines: ['账户 M2（USD）：C（不出余额）、D（通过发生额计算）'], accountCount: 1, templateNames: ['C', 'D'] }
  ]);
  assert.equal(named.detailLines[0], `渠道「${channelName}」账户 M1（USD）：A（不出余额）、B（取账单余额列）`);
  assert.deepEqual(named.persistedDetailLines, [
    '渠道「渠道（19位数字）」：1 个账户命中余额方式不同的子模板（A、B）',
    '渠道「招商银行」：1 个账户命中余额方式不同的子模板（C、D）'
  ]);
  const buildChannelBalanceRowsIncompleteError = loadMainFunction('buildChannelBalanceRowsIncompleteError', { FileValidationError, maskAccountLikeTextForLog });
  const incomplete = buildChannelBalanceRowsIncompleteError([
    { channelName, lines: ['文件「a.xlsx」第2行：缺少账单日期'], persistedLines: ['本组第1个文件第2行：缺少账单日期'], issueCount: 1 },
    { channelName: '招商银行', lines: ['文件「b.xlsx」第3行：缺少 MerchantId'], persistedLines: ['本组第1个文件第3行：缺少 MerchantId'], issueCount: 1 }
  ]);
  assert.equal(incomplete.detailLines[0], `渠道「${channelName}」文件「a.xlsx」第2行：缺少账单日期`);
  assert.deepEqual(incomplete.persistedDetailLines, ['渠道「渠道（19位数字）」本组第1个文件第2行：缺少账单日期', '渠道「招商银行」本组第1个文件第3行：缺少 MerchantId']);

  // release 审查：冲突账号不是纯数字（如 AC12B34）、渠道或子模板以它命名时，按冲突的实际账号整体脱敏；错误带出 logMaskValues
  const lettered = buildChannelBalanceModeMismatchError([{
    channelName: '渠道AC12B34', lines: ['账户 AC12B34（USD）：AC12B34子模板（不出余额）、主（取账单余额列）'], accountCount: 1,
    templateNames: ['AC12B34子模板', '主'], accountValues: ['AC12B34']
  }]);
  assert.deepEqual(lettered.persistedDetailLines, ['渠道「渠道（7位账号）」：1 个账户命中余额方式不同的子模板（（7位账号）子模板、主）']);
  assert.deepEqual(lettered.logMaskValues, ['AC12B34']);
  assert.ok(lettered.message.includes('AC12B34'), '界面摘要保留原文');

  // release 审查：交易只缺账单日期、子模板或渠道以字母数字混合的实际账号（AB12CD34，没有连续 4 位数字）命名时，
  //   按本组读到的账号整体脱敏；错误带出 logMaskValues，弹窗明细与界面摘要保留原文
  const letteredRows = [['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    ['', 'AB12CD34', 'USD', '5', ''], ['2026-11-01', 'XY56', 'USD', '0', '0']];
  const letteredInspect = inspectBalanceEntryRows([{ templateName: 'AB12CD34', fileName: 'a.xlsx', fileOrdinal: 1, detailRows: letteredRows }]);
  assert.deepEqual([letteredInspect.lines, letteredInspect.persistedLines, letteredInspect.accountValues], [
    ['文件「a.xlsx」（子模板「AB12CD34」）第2行：缺少账单日期'],
    ['本组第1个文件（子模板「（8位账号）」）第2行：缺少账单日期'],
    ['AB12CD34']
  ]);
  const letteredIncomplete = buildChannelBalanceRowsIncompleteError([
    { channelName: '渠道AB12CD34', lines: letteredInspect.lines, persistedLines: letteredInspect.persistedLines,
      issueCount: letteredInspect.issueCount, accountValues: letteredInspect.accountValues },
    { channelName: '招商银行', lines: ['文件「b.xlsx」第3行：缺少 MerchantId'], persistedLines: ['本组第1个文件第3行：缺少 MerchantId'], issueCount: 1, accountValues: [] }
  ]);
  assert.deepEqual(letteredIncomplete.persistedDetailLines, [
    '渠道「渠道（8位账号）」本组第1个文件（子模板「（8位账号）」）第2行：缺少账单日期',
    '渠道「招商银行」本组第1个文件第3行：缺少 MerchantId'
  ]);
  assert.deepEqual(letteredIncomplete.logMaskValues, ['AB12CD34']);
  assert.ok(letteredIncomplete.message.includes('AB12CD34') && letteredIncomplete.detailLines[0].includes('AB12CD34'), '界面明细与摘要保留原文');
});

// release 审查：混合渠道出余额的交易缺字段时，渠道或子模板可能以同组不出余额的账户（字母数字混合，如 AC-X7Y8Z9）命名：
//   缺字段校验仍只查出余额的条目，脱敏另读同组不出余额条目的 MerchantId
test('混合渠道缺字段诊断：同组不出余额条目的账号同样用于脱敏', () => {
  const { FileValidationError, normalizeCell } = require('../../../src/backend/file-service');
  const { buildFieldIndexMap, resolveAccountBalanceModes } = require('../../../src/main-process/statement-generation-business');
  const { isZeroOrBlankAmount } = require('../../../src/backend/file-service/normalizers');
  const collectEntryMerchantIdsForLog = loadMainFunction('collectEntryMerchantIdsForLog', { buildFieldIndexMap, normalizeCell });
  const inspectBalanceEntryRows = loadMainFunction('inspectBalanceEntryRows', {
    buildFieldIndexMap, normalizeCell, isZeroOrBlankAmount, maskAccountLikeTextForLog, collectEntryMerchantIdsForLog
  });
  const buildChannelBalanceRowsIncompleteError = loadMainFunction('buildChannelBalanceRowsIncompleteError', { FileValidationError, maskAccountLikeTextForLog });
  const resolveEntryBalancePlan = loadMainFunction('resolveEntryBalancePlan', {
    path: require('node:path'),
    resolveEntryBalanceMode: (entry) => ({ templateName: entry.templateName, balanceMode: entry.balanceMode }),
    resolveStatementOutputName: () => '',
    resolveAccountBalanceModes,
    buildChannelBalanceModeMismatchError: () => new Error('不应出现余额方式冲突'),
    buildBalanceModeConflictGroup: () => null,
    inspectBalanceEntryRows,
    buildChannelBalanceRowsIncompleteError
  });
  const header = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'];
  const rows = (dataRows) => [header, ...dataRows];
  let error = null;
  try {
    resolveEntryBalancePlan({
      config: { outputName: '渠道AC-X7Y8Z9' },
      fileEntries: [
        { matchedTemplateId: 1, templateName: '对公', balanceMode: 'statement', filePath: 'a.xlsx', detailRows: rows([['', 'M1', 'USD', '5', '', '10']]) },
        { matchedTemplateId: 2, templateName: 'AC-X7Y8Z9', balanceMode: 'none', filePath: 'b.xlsx', detailRows: rows([['2026-11-01', 'AC-X7Y8Z9', 'USD', '5', '', '']]) }
      ]
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error && error.code, 'CHANNEL_BALANCE_ROWS_INCOMPLETE');
  assert.deepEqual(error.logMaskValues.slice().sort(), ['AC-X7Y8Z9', 'M1']);
  assert.deepEqual(error.persistedDetailLines, ['本组第1个文件（子模板「对公」）第2行：缺少账单日期']);
  assert.ok(maskAccountLikeTextForLog(error.message, error.logMaskValues).includes('渠道（9位账号）'), '摘要中的渠道名按不出余额账户脱敏');
  // 出余额的条目没有缺字段时不额外读取（不报错）
  assert.equal(resolveEntryBalancePlan({
    config: { outputName: '渠道' },
    fileEntries: [
      { matchedTemplateId: 1, templateName: '对公', balanceMode: 'statement', filePath: 'a.xlsx', detailRows: rows([['2026-11-01', 'M1', 'USD', '5', '', '10']]) },
      { matchedTemplateId: 2, templateName: 'B', balanceMode: 'none', filePath: 'b.xlsx', detailRows: rows([['2026-11-01', 'AC-X7Y8Z9', 'USD', '5', '', '']]) }
    ]
  }).balanceEntries.length, 1);
});

// release 审查：余额方式冲突的落盘诊断写出渠道名与子模板名，渠道可能以本组未冲突的实际账号（AC12B34）命名：
//   脱敏用冲突账号与本组交易读到的全部账号
test('余额方式冲突诊断：本组未冲突的账号同样用于脱敏', () => {
  const { normalizeCell } = require('../../../src/backend/file-service');
  const { buildFieldIndexMap, resolveAccountBalanceModes } = require('../../../src/main-process/statement-generation-business');
  const identity = require('../../../src/main-process/statement-channel-identity');
  const formatBalanceModeConflictLines = loadMainFunction('formatBalanceModeConflictLines', { describeBalanceMode: identity.describeBalanceMode });
  const collectEntryMerchantIdsForLog = loadMainFunction('collectEntryMerchantIdsForLog', { buildFieldIndexMap, normalizeCell });
  const buildBalanceModeConflictGroup = loadMainFunction('buildBalanceModeConflictGroup', { formatBalanceModeConflictLines, collectEntryMerchantIdsForLog });
  const header = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'];
  const entryModes = [
    { templateName: '对公', balanceMode: 'statement', detailRows: [header, ['2026-11-01', 'M1', 'USD', '5', '', '10'], ['2026-11-01', 'AC12B34', 'USD', '5', '', '10']] },
    { templateName: '对私', balanceMode: 'none', detailRows: [header, ['2026-11-01', 'M1', 'USD', '5', '', '']] }
  ];
  const { conflicts } = resolveAccountBalanceModes(entryModes);
  assert.deepEqual(conflicts.map((conflict) => conflict.merchantId), ['M1']);
  const group = buildBalanceModeConflictGroup('渠道AC12B34', conflicts, entryModes);
  assert.deepEqual(group.accountValues.slice().sort(), ['AC12B34', 'M1']);
  assert.equal(maskAccountLikeTextForLog(group.channelName, group.accountValues), '渠道（7位账号）');
  // 不给条目时只用冲突账号（兼容原调用）
  assert.deepEqual(buildBalanceModeConflictGroup('渠道', conflicts).accountValues, ['M1']);
});
