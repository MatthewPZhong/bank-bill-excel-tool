'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createModalHost } = require('../../../src/renderer/modal-host');
const { createModalDom } = require('../../helpers/modal-dom');
const previewSource = fs.readFileSync(require.resolve('../../../src/renderer-previews'), 'utf8');

function setup() {
  const dom = createModalDom();
  const errors = [];
  const host = createModalHost({ ...dom, reportError: (error) => errors.push(error) });
  const timers = new Map();
  let nextTimer = 0;
  const global = {
    __rendererModalHost: host,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(previewSource, { window: global });
  const state = {};
  const elements = { modalRoot: dom.root };
  const created = [];
  function create() {
    const descriptor = dom.createDialog();
    const option = { checked: false };
    descriptor.overlay.querySelector = (selector) => selector.includes('input[type="radio"]') ? option : null;
    created.push({ descriptor, option });
    return descriptor;
  }
  const deps = {
    state, elements, modalHost: host,
    MODULES: { statementGenerator: { id: 'statement' }, bankStatementProcess: { id: 'bank' } },
    setCurrentModule(id) { state.currentModule = id; },
    openModal: (factory) => host.openRoot(factory),
    createBigAccountSelectionDialog: create,
    createToolboxDialog: create,
    createFundTransferAccountMappingDialog: create
  };
  const previews = global.__rendererPreviews.createRendererPreviews(deps);
  function tick() {
    const pending = [...timers.values()]; timers.clear();
    for (const callback of pending) callback();
  }
  return { ...dom, host, timers, tick, created, errors, previews, elements, state, deps, global };
}

test('预览延迟选中只操作本次句柄，替换窗口会取消旧 timer', () => {
  const env = setup();
  env.previews.applyBigAccountSelectionPreviewState();
  assert.equal(env.timers.size, 1);
  const stale = [...env.timers.values()][0];
  const old = env.created[0];
  const production = env.createDialog();
  const newOption = { checked: false };
  production.overlay.querySelector = () => newOption;
  env.host.openRoot(() => production);
  assert.equal(env.timers.size, 0);
  stale();
  assert.equal(old.option.checked, false);
  assert.equal(newOption.checked, false);
  env.host.dispose();
});

test('预览句柄仍是栈顶时执行控件设置', () => {
  const env = setup();
  env.previews.applyBigAccountSelectionPreviewState();
  env.tick();
  assert.equal(env.created[0].option.checked, true);
  env.host.dispose();
});

test('根打开被 busy 拒绝时，不创建工厂也不调度修改现有窗口', () => {
  const env = setup();
  env.host.openRoot(() => env.createDialog({ canClose: () => false }));
  env.previews.applyBigAccountSelectionPreviewState();
  assert.equal(env.created.length, 0);
  assert.equal(env.timers.size, 0);
  env.host.dispose();
});

test('延迟打开之前出现生产窗口时，预览不能随后替换生产栈', () => {
  const env = setup();
  env.previews.applyToolboxPreviewState();
  const production = env.host.openRoot(() => env.createDialog()).handle;
  env.tick();
  assert.equal(env.created.length, 0);
  assert.equal(production.isTop(), true);
  env.host.dispose();
});

test('新预览代次和生产模块切换都废弃旧面板延迟动作', () => {
  const env = setup();
  env.previews.applyToolboxPreviewState();
  const oldCallback = [...env.timers.values()][0];
  env.previews.applyBankStatementPanelPreviewState();
  oldCallback();
  assert.equal(env.created.length, 0);
  env.previews.applyToolboxPreviewState();
  env.state.currentModule = 'another-production-module';
  env.tick();
  assert.equal(env.created.length, 0);
  env.host.dispose();
});

test('同步生产按钮建立的父层可以继续预览；下一级晚到不得编辑后来新层', () => {
  const env = setup();
  let manages = 0;
  const manager = env.createDialog();
  manager.overlay.querySelector = () => ({ click() { manages += 1; } });
  env.elements.bankStatementScenarioBtn = { click() { env.host.openRoot(() => manager); } };
  env.previews.applyBuiltinFixedChannelManagePreviewState();
  env.tick();
  assert.equal(env.timers.size, 1);
  env.tick();
  assert.equal(manages, 1);
  env.host.closeTop();
  const manager2 = env.createDialog();
  manager2.overlay.querySelector = () => ({ click() { manages += 10; } });
  env.elements.bankStatementScenarioBtn = { click() { env.host.openRoot(() => manager2); } };
  env.previews.applyBuiltinFixedChannelManagePreviewState();
  env.tick();
  const stale = [...env.timers.values()][0];
  env.host.openRoot(() => env.createDialog());
  stale();
  assert.equal(manages, 1);
  env.host.dispose();
});

test('dispose 清理待决预览 timer，账户映射入口返回真实宿主打开结果', () => {
  const env = setup();
  env.previews.applyToolboxPreviewState();
  env.previews.dispose();
  assert.equal(env.timers.size, 0);
  const result = env.previews.applyFundTransferAccountMappingPreviewState();
  assert.equal(result.status, 'opened');
  assert.equal(result.handle, env.host.getTop());
  env.host.dispose();
});
