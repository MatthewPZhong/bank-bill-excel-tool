'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createModalDom } = require('../helpers/modal-dom');
const { createModalHost } = require('../../src/renderer/modal-host');
const { createModalBridge } = require('../../src/renderer/modal-bridge');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  // 读取现有设置工厂的删除/销毁逻辑；挂载、关闭和 busy 检查使用真实宿主。
  // DOM 替身只提供选择器/按钮，浏览器装配另由 renderer-lifecycle 的 app-settings fixture 验证。
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/dialogs/app-settings.js'), 'utf8');
  const start = source.indexOf('  async function confirmArchiveBatchDelete(button) {');
  const end = source.indexOf("  dialog.querySelector('[data-action=\"close\"]')", start);
  assert.ok(start > 0 && end > start);
  const state = {
    destroyed: false, deleteRequestId: 0, listRequestId: 0, detailRequestId: 0,
    settingsRequestId: 0, retentionIntentToken: 0, retentionPendingIntent: null,
    settingsLoading: false, retentionSaving: false, selectedBatchId: 'old', detail: { id: 'old' }
  };
  const dom = createModalDom();
  const { overlay, dialog } = dom.createDialog();
  const modalRoot = dom.root;
  const host = createModalHost({ root: modalRoot, document: dom.document });
  const modalBridge = createModalBridge({ host });
  const confirmations = [];
  const feedback = [];
  const prepareCalls = [];
  const deleteCalls = [];
  const listRefresh = deferred();
  const listStarted = deferred();
  let deferredList = false;
  let listCalls = 0;
  let statsCalls = 0;
  let refreshCalls = 0;

  function createConfirmDialog(options) {
    const nodes = dom.createDialog();
    const modal = nodes.overlay;
    const confirmButton = nodes.first;
    const cancelButton = nodes.last;
    const body = dom.document.createElement('div');
    nodes.dialog.appendChild(body);
    confirmButton.textContent = options.confirmText;
    Object.assign(modal, {
      options, confirmButton, cancelButton,
      querySelector(selector) {
        if (selector === '[data-action="confirm"]') return confirmButton;
        if (selector === '[data-action="cancel"]') return cancelButton;
        if (selector === '[data-role="archive-delete-error"]') return body.firstChild;
        if (selector === '.alert-body') return body;
        return null;
      },
      cancel() {
        if (cancelButton.disabled) return;
        // 与共享确认工厂一致：先按 handle 关闭子页，再通知父页刷新。
        const closed = modalBridge.closeModal(modal, { status: 'cancelled', reason: 'cancel' });
        if (closed.status === 'closed') options.onCancel();
      }
    });
    modalBridge.registerModal(modal, { dialog: nodes.dialog });
    confirmations.push(modal);
    return modal;
  }
  const context = {
    archiveState: state, overlay, elements: { modalRoot },
    themeController: null, appearanceView: null,
    unsubscribeStorageMigration: null, unsubscribeEntryMaintenanceCompleted: null,
    unsubscribeEntryMaintenanceFailed: null,
    getArchiveCenterApi: () => ({
      prepareDeleteBatch(batchId) {
        const result = deferred();
        prepareCalls.push({ batchId, ...result });
        return result.promise;
      },
      deleteBatch(batchId, confirmationToken) {
        const result = deferred();
        deleteCalls.push({ batchId, confirmationToken, ...result });
        return result.promise;
      }
    }),
    verifyArchiveCenterAction(result, fallback) {
      if (result.ok === true) return true;
      feedback.push({ message: result.message || fallback, type: 'error' });
      return false;
    },
    showArchiveFeedback: (message, type) => feedback.push({ message, type }),
    archiveCenterErrorText: (error, fallback) => error.message || fallback,
    escapeHtml: (text) => String(text),
    createConfirmDialog, modalBridge, settingsHandle: null,
    loadArchiveBatches: () => {
      listCalls += 1;
      listStarted.resolve();
      return deferredList ? listRefresh.promise : Promise.resolve(true);
    },
    loadArchiveStats: async () => { statsCalls += 1; return true; },
    refreshOpenAppUpdateDialog: () => { refreshCalls += 1; },
    setArchiveSettingsLoading() {},
    requestAnimationFrame: (callback) => callback(),
    clearTimeout,
    document: { createElement: (tag) => Object.assign(dom.document.createElement(tag), { dataset: {} }) }
  };
  const actions = vm.runInNewContext(`${source.slice(start, end)}\n({ confirmArchiveBatchDelete, closeSettingsDialog, canCloseSettingsDialog, disposeSettingsDialog });`, context);
  modalBridge.registerModal(overlay, {
    dialog, canClose: actions.canCloseSettingsDialog, onDispose: actions.disposeSettingsDialog,
    onMount: (handle) => { context.settingsHandle = handle; }
  });
  const settingsHandle = modalBridge.openModal(() => overlay).handle;
  return {
    state, overlay, modalRoot, host, settingsHandle, confirmations, feedback, prepareCalls, deleteCalls, listRefresh,
    listStarted: listStarted.promise,
    ...actions,
    button(batchId) {
      return { disabled: false, get isConnected() { return overlay.isConnected; },
        dataset: { batchId, batchNumber: `batch-${batchId}` } };
    },
    prepared(index, patch = {}) {
      prepareCalls[index].resolve({ ok: true, confirmationToken: `token-${index}`,
        summary: { fileCount: 2 }, ...patch });
    },
    showOtherModal() {
      const other = dom.createDialog();
      modalBridge.registerModal(other.overlay, { dialog: other.dialog });
      assert.equal(modalBridge.openModal(() => other.overlay).status, 'opened');
      return other.overlay;
    },
    attemptOtherModal() {
      let factoryCalls = 0;
      const result = modalBridge.openModal(() => { factoryCalls += 1; return dom.createDialog(); });
      return { result, factoryCalls };
    },
    deferListRefresh() { deferredList = true; },
    get listCalls() { return listCalls; },
    get statsCalls() { return statsCalls; },
    get refreshCalls() { return refreshCalls; }
  };
}

async function confirmReady(current) {
  const waiting = current.confirmArchiveBatchDelete(current.button('a'));
  current.prepared(0);
  await waiting;
  assert.equal(current.confirmations.length, 1);
  assert.equal(current.modalRoot.childElementCount, 2);
  assert.equal(current.modalRoot.firstChild, current.overlay);
  assert.equal(current.overlay.isConnected, true);
  assert.equal(current.overlay.inert, true);
  assert.equal(current.state.destroyed, false);
  return current.confirmations[0];
}

for (const [field, value, expectedMessage] of [
  ['settingsLoading', true, '存档设置正在加载'],
  ['retentionSaving', true, '保留期限正在保存'],
  ['retentionPendingIntent', { token: 1 }, '保留期限正在保存']
]) {
  test(`${field} 未收口时不发起删除预检或替换设置页`, async () => {
    const current = harness();
    current.state[field] = value;
    const button = current.button('a');
    await current.confirmArchiveBatchDelete(button);
    assert.equal(current.prepareCalls.length, 0);
    assert.equal(current.confirmations.length, 0);
    assert.equal(current.modalRoot.lastChild, current.overlay);
    assert.equal(button.disabled, false);
    assert.ok(current.feedback.at(-1).message.includes(expectedMessage));
  });

  test(`删除预检等待期间 ${field} 开始，迟到预检不替换设置页；收口后可重新预检`, async () => {
    const current = harness();
    const button = current.button('a');
    const preparing = current.confirmArchiveBatchDelete(button);
    const settingsWork = deferred();
    current.state[field] = value;
    const settingsFinished = settingsWork.promise.then(() => {
      current.state[field] = field === 'retentionPendingIntent' ? null : false;
    });
    current.prepared(0);
    await preparing;
    assert.equal(current.confirmations.length, 0);
    assert.equal(current.modalRoot.lastChild, current.overlay);
    assert.equal(current.state.destroyed, false);
    assert.equal(current.state[field], value);
    assert.equal(button.disabled, false);
    assert.equal(current.deleteCalls.length, 0);
    assert.ok(current.feedback.at(-1).message.includes(expectedMessage));
    settingsWork.resolve();
    await settingsFinished;
    const retry = current.confirmArchiveBatchDelete(button);
    current.prepared(1);
    await retry;
    assert.equal(current.confirmations.length, 1);
    const deleting = current.confirmations[0].options.onConfirm();
    assert.equal(current.deleteCalls[0].confirmationToken, 'token-1');
    current.deleteCalls[0].resolve({ ok: true, metadataDeleted: true, fullyDeleted: true });
    await deleting;
    assert.equal(current.modalRoot.lastChild, current.overlay);
  });
}

for (const outcome of ['success', 'failure', 'rejection']) {
  test(`关闭设置页后迟到的删除预检 ${outcome} 不覆盖后续弹窗或写入反馈`, async () => {
    const current = harness();
    const waiting = current.confirmArchiveBatchDelete(current.button('a'));
    assert.equal(current.closeSettingsDialog().status, 'closed');
    const other = current.showOtherModal();
    if (outcome === 'rejection') current.prepareCalls[0].reject(new Error('延迟错误'));
    else current.prepared(0, outcome === 'failure' ? { ok: false, message: '预检失败' } : {});
    await waiting;
    assert.equal(current.state.destroyed, true);
    assert.equal(current.modalRoot.lastChild, other);
    assert.equal(current.confirmations.length, 0);
    assert.deepEqual(current.feedback, []);
  });
}

for (const order of [[0, 1], [1, 0]]) {
  test(`不同批次并发预检按 ${order.join('→')} 返回，仅最近一次请求显示确认`, async () => {
    const current = harness();
    const first = current.confirmArchiveBatchDelete(current.button('a'));
    const second = current.confirmArchiveBatchDelete(current.button('b'));
    current.prepared(order[0]);
    await (order[0] === 0 ? first : second);
    current.prepared(order[1]);
    await Promise.all([first, second]);
    assert.equal(current.confirmations.length, 1);
    assert.match(current.confirmations[0].options.message, /batch-b/);
    assert.equal(current.modalRoot.lastChild, current.confirmations[0]);
    assert.equal(current.modalRoot.firstChild, current.overlay);
    assert.equal(current.overlay.isConnected, true);
    assert.equal(current.overlay.inert, true);
    assert.equal(current.state.destroyed, false);
  });
}

test('设置页被其他弹窗替换后，迟到预检不重新抢占弹窗', async () => {
  const current = harness();
  const waiting = current.confirmArchiveBatchDelete(current.button('a'));
  const other = current.showOtherModal();
  current.prepared(0);
  await waiting;
  assert.equal(current.modalRoot.lastChild, other);
  assert.equal(current.confirmations.length, 0);
});

test('正常取消只关闭确认子页并返回仍挂载的设置页，不发起删除', async () => {
  const current = harness();
  const confirmation = await confirmReady(current);
  confirmation.cancel();
  await Promise.resolve();
  assert.equal(current.modalRoot.lastChild, current.overlay);
  assert.equal(current.state.destroyed, false);
  assert.equal(current.overlay.inert, false);
  assert.equal(current.modalRoot.childElementCount, 1);
  assert.equal(current.refreshCalls, 1);
  assert.equal(current.deleteCalls.length, 0);
});

test('取消后打开新弹窗，后续微任务不复活已销毁的设置页', async () => {
  const current = harness();
  const confirmation = await confirmReady(current);
  confirmation.cancel();
  const other = current.showOtherModal();
  await Promise.resolve();
  assert.equal(current.modalRoot.lastChild, other);
  assert.equal(current.refreshCalls, 1);
  assert.equal(current.state.destroyed, true);
  assert.equal(current.overlay.isConnected, false);
});

test('正常删除防止重复提交与执行中取消，完成后关闭子页并刷新仍挂载的设置页', async () => {
  const current = harness();
  const confirmation = await confirmReady(current);
  const deleting = confirmation.options.onConfirm();
  const repeated = confirmation.options.onConfirm();
  assert.equal(current.deleteCalls.length, 1);
  await repeated;
  assert.equal(confirmation.confirmButton.disabled, true);
  assert.equal(confirmation.cancelButton.disabled, true);
  confirmation.cancel();
  assert.equal(current.modalRoot.lastChild, confirmation);
  current.deleteCalls[0].resolve({ ok: true, metadataDeleted: true, fullyDeleted: true });
  await deleting;
  assert.equal(current.modalRoot.lastChild, current.overlay);
  assert.equal(current.listCalls, 1);
  assert.equal(current.statsCalls, 1);
  assert.equal(current.state.selectedBatchId, '');
  assert.equal(current.state.detail, null);
  assert.equal(current.feedback.at(-1).type, 'success');
});

test('实际删除失败保留当前确认及错误，恢复确认和取消按钮', async () => {
  const current = harness();
  const confirmation = await confirmReady(current);
  const deleting = confirmation.options.onConfirm();
  current.deleteCalls[0].resolve({ ok: false, message: '存档正在维护' });
  await deleting;
  assert.equal(current.modalRoot.lastChild, confirmation);
  assert.equal(confirmation.confirmButton.disabled, false);
  assert.equal(confirmation.cancelButton.disabled, false);
  assert.match(confirmation.querySelector('[data-role="archive-delete-error"]').textContent, /存档正在维护/);
  assert.equal(current.listCalls, 0);
});

for (const outcome of ['success', 'rejection']) {
  test(`执行中阻止替换，页面销毁后已提交删除的迟到 ${outcome} 不影响新弹窗`, async () => {
    const current = harness();
    const confirmation = await confirmReady(current);
    const deleting = confirmation.options.onConfirm();
    const blocked = current.attemptOtherModal();
    assert.equal(blocked.result.status, 'blocked');
    assert.equal(blocked.factoryCalls, 0);
    assert.equal(current.modalRoot.lastChild, confirmation);
    // 页面退出可强制收尾父子页，已提交操作继续等待，但迟到结果不可触及新页。
    current.settingsHandle.dispose('renderer-dispose');
    const other = current.showOtherModal();
    if (outcome === 'rejection') current.deleteCalls[0].reject(new Error('删除延迟错误'));
    else current.deleteCalls[0].resolve({ ok: true, metadataDeleted: true, fullyDeleted: true });
    await deleting;
    assert.equal(current.modalRoot.lastChild, other);
    assert.equal(current.listCalls, 0);
    assert.equal(current.statsCalls, 0);
    assert.deepEqual(current.feedback, []);
    assert.equal(confirmation.querySelector('[data-role="archive-delete-error"]'), null);
  });
}

test('删除成功后的列表刷新期间关闭设置页，不再继续统计或显示迟到完成消息', async () => {
  const current = harness();
  current.deferListRefresh();
  const confirmation = await confirmReady(current);
  const deleting = confirmation.options.onConfirm();
  current.deleteCalls[0].resolve({ ok: true, metadataDeleted: true, fullyDeleted: true });
  await current.listStarted;
  assert.equal(current.modalRoot.lastChild, current.overlay);
  current.closeSettingsDialog();
  const other = current.showOtherModal();
  current.listRefresh.resolve(true);
  await deleting;
  assert.equal(current.modalRoot.lastChild, other);
  assert.equal(current.statsCalls, 0);
  assert.deepEqual(current.feedback, []);
});
