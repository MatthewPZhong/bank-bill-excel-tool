'use strict';

// v3.2.21 release 审查：渠道名可能以账号命名。主进程给结果另附脱敏后的日志摘要（logMessage）时，状态框照常显示原文，
//   转写活动日志（app:report-log）时用 logMessage；没有时照旧写显示的文字。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const { createStatementController } = require('../../src/renderer/controllers/statement');

function stubElement() {
  return {
    dataset: {}, style: {}, value: '', textContent: '', disabled: false, title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, querySelector: () => stubElement(), setAttribute() {}, removeAttribute() {}
  };
}

async function createController(t, apiOverrides = {}) {
  const statusCalls = [];
  const fallbackApi = new Proxy({}, { get: () => async () => ({ status: 'ok', channels: [], conflicts: [] }) });
  const controller = createStatementController({
    api: new Proxy({}, { get: (_target, key) => (key in apiOverrides ? apiOverrides[key] : fallbackApi[key]) }),
    panel: { querySelector: () => stubElement() },
    config: { subscribe: () => () => {}, getAccountMappingCount: () => 0, getStatementChannels: () => [], refreshTemplates: async () => {} },
    ui: {
      status: (...args) => statusCalls.push(args),
      modalHost: { closeOwner: () => ({ status: 'closed' }) },
      modalBridge: { openModal: () => ({}) },
      alertNative: () => {}
    }
  });
  t.after(() => controller.dispose());
  await controller.enter();
  statusCalls.length = 0;
  return { controller, statusCalls };
}

test('网银账单状态框：结果带 logMessage 时传给状态框作日志摘要，显示文字不变', async (t) => {
  const { controller, statusCalls } = await createController(t);
  controller.preview.applyStatementResult({
    status: 'error', message: '渠道「对公6222021234567890123」下同一账户命中了余额方式不同的子模板', logMessage: '渠道「对公（19位数字）」下同一账户命中了余额方式不同的子模板', errorReportReady: true
  });
  controller.preview.applyStatementResult({ status: 'error', message: '其他错误', errorReportReady: true });
  assert.deepEqual(statusCalls.map(([, message, tone, options]) => [message, tone, options.logMessage]), [
    ['渠道「对公6222021234567890123」下同一账户命中了余额方式不同的子模板', 'error', '渠道「对公（19位数字）」下同一账户命中了余额方式不同的子模板'],
    ['其他错误', 'error', undefined]
  ]);
});

test('updateStatusBox：上报活动日志时优先用 options.logMessage，界面显示 message', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const node = ast.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === 'updateStatusBox');
  const reported = [];
  const window = { desktopApi: { app: { reportLog: (payload) => reported.push(payload) } } };
  const updateStatusBox = Function('window', `return (${source.slice(node.start, node.end)});`)(window);
  const textEl = { textContent: '' };
  const box = { dataset: {}, classList: { toggle() {} }, querySelector: () => textEl, title: '' };
  updateStatusBox(box, '渠道「对公6222021234567890123」：冲突', 'error', { logMessage: '渠道「对公（19位数字）」：冲突' });
  updateStatusBox(box, '其他错误', 'error');
  assert.equal(textEl.textContent, '其他错误');
  assert.deepEqual(reported.map((item) => item.message), ['渠道「对公（19位数字）」：冲突', '其他错误']);
});

test('网银账单「导出余额」预检被拒（渠道余额冲突）：状态框的日志摘要用结果的 logMessage', async (t) => {
  const rejected = {
    status: 'error',
    message: '渠道「对公6222021234567890123」下同一账户命中了余额方式不同的子模板',
    logMessage: '渠道「对公（19位数字）」下同一账户命中了余额方式不同的子模板',
    errorCode: 'CHANNEL_BALANCE_MODE_MISMATCH',
    detailLines: [],
    errorReportReady: false
  };
  const { controller, statusCalls } = await createController(t, { files: { exportBalance: async () => rejected } });
  await controller.commands.exportBalance();
  const errorCall = statusCalls.find(([, , tone]) => tone === 'error');
  assert.deepEqual([errorCall[1], errorCall[3].logMessage], [rejected.message, rejected.logMessage]);
});
