// v3.2.22：资金对账「链接表管理 / 账户映射管理 / 场景管理」文案与入口的源码断言。
//
// renderer 弹窗为浏览器 IIFE（依赖 DOM + deps 注入），沿用 renderer-dialogs-fund-transfer-account-mapping-load-guard.test.js
// 的源码字符串断言范式，按工厂函数切片，避免误命中同文件其他弹窗（前置资金对账链接表管理仍保留「退出」）。
//
// 锁定点：
//   ① 链接表管理底部【退出】→【返回】（data-action 不变）。
//   ② 账户映射管理表头「中台调拨单账户号」→「链接表账户号」；主进程重复校验文案同步。
//   ③ 场景管理底部【完成】→【返回】（data-action 不变，所有入口共用）。
//   ④ 场景管理右上角「网关对账单修复 [管理]」入口已移除；资金对账运行网关场景时的未启用提示改指向新入口。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const dialogsSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer-dialogs.js'), 'utf8');
const scenariosSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'dialogs', 'scenarios.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const bankStatementControllerSource = fs.readFileSync(
  path.join(ROOT, 'src', 'renderer', 'controllers', 'bank-statement.js'), 'utf8'
);

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `应能定位 ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `应能定位 ${startMarker} 的结束位置 ${endMarker}`);
  return source.slice(start, end);
}

test('链接表管理底部按钮为【返回】（不再是【退出】）', () => {
  const body = slice(dialogsSource, 'function createLinkedTableManagerDialog()', 'function createLinkedTableDeleteRangeDialog(');
  assert.match(body, /data-action="exit">返回<\/button>/);
  assert.doesNotMatch(body, />退出<\/button>/);
  assert.match(body, /querySelector\('\[data-action="exit"\]'\)\.addEventListener\('click', closeModal\)/, '行为仍为关闭本层');
});

test('账户映射管理表头为「链接表账户号」，主进程重复校验文案同步', () => {
  const body = slice(dialogsSource, 'function createFundTransferAccountMappingDialog()', 'function createPreFundTempManagerDialog(');
  assert.match(body, /<th>链接表账户号<\/th>\s*<th>清结算系统银行账号<\/th>/);
  assert.doesNotMatch(body, /中台调拨单账户号/);
  const validator = slice(mainSource, 'function validateFundTransferAccountMappings', 'function registerFundTransferAccountMappingHandlers');
  assert.match(validator, /链接表账户号不可重复，请重新确认/);
  assert.doesNotMatch(validator, /中台调拨单账户号不可重复/);
});

test('场景管理底部按钮为【返回】，右上角「网关对账单修复」入口已移除', () => {
  const body = slice(scenariosSource, 'function createScenariosManagerDialog(', 'function reopenScenariosManager(');
  assert.match(body, /data-action="finish">返回<\/button>/);
  assert.doesNotMatch(body, /data-action="finish">完成<\/button>/);
  assert.doesNotMatch(body, /manage-gateway-recon-id-fix/);
  assert.doesNotMatch(body, /gateway-recon-id-fix-entry/);
  assert.doesNotMatch(body, /<label[^>]*>网关对账单修复<\/label>/);
});

test('网关场景未启用的提示指向「对账单修复 → 网关对账单 → 场景管理」，不再指向已移除的入口', () => {
  const body = slice(bankStatementControllerSource, 'async function handleBankStatementGatewayReconRun()', 'if (choices.length === 1)');
  assert.match(body, /请先在「对账单修复」中将账单类别选为「网关对账单」，再点「场景管理」启用场景/);
  assert.doesNotMatch(body, /网关对账单修复-场景管理/);
});
