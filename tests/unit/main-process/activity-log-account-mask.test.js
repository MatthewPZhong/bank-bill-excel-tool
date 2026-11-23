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
  assert.match(snippet, /\['bigAccounts', 'fixedAssignments', 'currencyBigAccounts'\]/);
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
  const inspectBalanceEntryRows = loadMainFunction('inspectBalanceEntryRows', {
    buildFieldIndexMap, normalizeCell, isZeroOrBlankAmount, maskAccountLikeTextForLog
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
});
