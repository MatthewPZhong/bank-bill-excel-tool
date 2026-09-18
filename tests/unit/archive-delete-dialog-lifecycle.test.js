'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf8');
  const start = source.indexOf('  async function confirmArchiveBatchDelete(button) {');
  const end = source.indexOf("  dialog.querySelector('[data-action=\"close\"]')", start);
  assert.ok(start > 0 && end > start);
  const state = {
    destroyed: false, deleteRequestId: 0, listRequestId: 0, detailRequestId: 0,
    settingsRequestId: 0, retentionIntentToken: 0, retentionPendingIntent: null,
    settingsLoading: false, retentionSaving: false, selectedBatchId: 'old', detail: { id: 'old' }
  };
  const overlay = { name: 'settings', isConnected: true };
  const modalRoot = { firstElementChild: overlay };
  const confirmations = [];
  const feedback = [];
  const prepareCalls = [];
  const deleteCalls = [];
  const microtasks = [];
  const listRefresh = deferred();
  const listStarted = deferred();
  let deferredList = false;
  let listCalls = 0;
  let statsCalls = 0;
  let refreshCalls = 0;

  function openModal(modal) {
    if (modalRoot.firstElementChild) modalRoot.firstElementChild.isConnected = false;
    modalRoot.firstElementChild = modal;
    modal.isConnected = true;
  }
  function closeModal() {
    if (modalRoot.firstElementChild) modalRoot.firstElementChild.isConnected = false;
    modalRoot.firstElementChild = null;
  }
  function createConfirmDialog(options) {
    const confirmButton = { disabled: false, textContent: options.confirmText };
    const cancelButton = { disabled: false };
    let errorElement = null;
    const modal = {
      name: 'confirmation', options, isConnected: false, confirmButton, cancelButton,
      querySelector(selector) {
        if (selector === '[data-action="confirm"]') return confirmButton;
        if (selector === '[data-action="cancel"]') return cancelButton;
        if (selector === '[data-role="archive-delete-error"]') return errorElement;
        if (selector === '.alert-body') return { appendChild(node) { errorElement = node; } };
        throw new Error(`未处理的 DOM 查询：${selector}`);
      },
      cancel() {
        if (cancelButton.disabled) return;
        options.onCancel();
        // 与共享 createConfirmDialog 的真实取消顺序一致：回调后关闭弹窗。
        closeModal();
      }
    };
    confirmations.push(modal);
    return modal;
  }
  const context = {
    archiveState: state, overlay, elements: { modalRoot },
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
    createConfirmDialog, openModal, closeModal,
    loadArchiveBatches: () => {
      listCalls += 1;
      listStarted.resolve();
      return deferredList ? listRefresh.promise : Promise.resolve(true);
    },
    loadArchiveStats: async () => { statsCalls += 1; return true; },
    refreshOpenAppUpdateDialog: () => { refreshCalls += 1; },
    setArchiveSettingsLoading() {},
    requestAnimationFrame: (callback) => callback(),
    queueMicrotask: (callback) => microtasks.push(callback),
    clearTimeout,
    document: { createElement: () => ({ dataset: {}, setAttribute() {} }) }
  };
  const actions = vm.runInNewContext(`${source.slice(start, end)}\n({ confirmArchiveBatchDelete, closeSettingsDialog });`, context);
  return {
    state, overlay, modalRoot, confirmations, feedback, prepareCalls, deleteCalls, listRefresh,
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
    showOtherModal() { const modal = { name: 'other', isConnected: false }; openModal(modal); return modal; },
    flushMicrotasks() { while (microtasks.length) microtasks.shift()(); },
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
  return current.confirmations[0];
}

for (const outcome of ['success', 'failure', 'rejection']) {
  test(`关闭设置页后迟到的删除预检 ${outcome} 不覆盖后续弹窗或写入反馈`, async () => {
    const current = harness();
    const waiting = current.confirmArchiveBatchDelete(current.button('a'));
    assert.equal(current.closeSettingsDialog(), true);
    const other = current.showOtherModal();
    if (outcome === 'rejection') current.prepareCalls[0].reject(new Error('延迟错误'));
    else current.prepared(0, outcome === 'failure' ? { ok: false, message: '预检失败' } : {});
    await waiting;
    assert.equal(current.state.destroyed, true);
    assert.equal(current.modalRoot.firstElementChild, other);
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
    assert.equal(current.modalRoot.firstElementChild, current.confirmations[0]);
  });
}

test('设置页被其他弹窗替换后，迟到预检不重新抢占弹窗', async () => {
  const current = harness();
  const waiting = current.confirmArchiveBatchDelete(current.button('a'));
  const other = current.showOtherModal();
  current.prepared(0);
  await waiting;
  assert.equal(current.modalRoot.firstElementChild, other);
  assert.equal(current.confirmations.length, 0);
});

test('正常取消只恢复仍有效的设置页，不发起删除', async () => {
  const current = harness();
  const confirmation = await confirmReady(current);
  confirmation.cancel();
  current.flushMicrotasks();
  assert.equal(current.modalRoot.firstElementChild, current.overlay);
  assert.equal(current.state.destroyed, false);
  assert.equal(current.refreshCalls, 1);
  assert.equal(current.deleteCalls.length, 0);
});

test('取消后的恢复微任务不会覆盖期间打开的新弹窗', async () => {
  const current = harness();
  const confirmation = await confirmReady(current);
  confirmation.cancel();
  const other = current.showOtherModal();
  current.flushMicrotasks();
  assert.equal(current.modalRoot.firstElementChild, other);
  assert.equal(current.refreshCalls, 0);
});

test('正常删除防止重复提交与执行中取消，完成后恢复设置页并刷新结果', async () => {
  const current = harness();
  const confirmation = await confirmReady(current);
  const deleting = confirmation.options.onConfirm();
  const repeated = confirmation.options.onConfirm();
  assert.equal(current.deleteCalls.length, 1);
  await repeated;
  assert.equal(confirmation.confirmButton.disabled, true);
  assert.equal(confirmation.cancelButton.disabled, true);
  confirmation.cancel();
  assert.equal(current.modalRoot.firstElementChild, confirmation);
  current.deleteCalls[0].resolve({ ok: true, metadataDeleted: true, fullyDeleted: true });
  await deleting;
  assert.equal(current.modalRoot.firstElementChild, current.overlay);
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
  assert.equal(current.modalRoot.firstElementChild, confirmation);
  assert.equal(confirmation.confirmButton.disabled, false);
  assert.equal(confirmation.cancelButton.disabled, false);
  assert.match(confirmation.querySelector('[data-role="archive-delete-error"]').textContent, /存档正在维护/);
  assert.equal(current.listCalls, 0);
});

for (const outcome of ['success', 'rejection']) {
  test(`已提交删除的迟到 ${outcome} 不覆盖新的业务弹窗`, async () => {
    const current = harness();
    const confirmation = await confirmReady(current);
    const deleting = confirmation.options.onConfirm();
    const other = current.showOtherModal();
    if (outcome === 'rejection') current.deleteCalls[0].reject(new Error('删除延迟错误'));
    else current.deleteCalls[0].resolve({ ok: true, metadataDeleted: true, fullyDeleted: true });
    await deleting;
    assert.equal(current.modalRoot.firstElementChild, other);
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
  assert.equal(current.modalRoot.firstElementChild, current.overlay);
  current.closeSettingsDialog();
  const other = current.showOtherModal();
  current.listRefresh.resolve(true);
  await deleting;
  assert.equal(current.modalRoot.firstElementChild, other);
  assert.equal(current.statsCalls, 0);
  assert.deepEqual(current.feedback, []);
});
