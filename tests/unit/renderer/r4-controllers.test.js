'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModalDom } = require('../../helpers/modal-dom');
const { createModalHost } = require('../../../src/renderer/modal-host');
const { createModalBridge } = require('../../../src/renderer/modal-bridge');
const { createAcquiringController, formatAcquiringBillCurrencyProgress } = require('../../../src/renderer/controllers/acquiring');
const { createBizOpLegacyController } = require('../../../src/renderer/controllers/biz-op-legacy');
const { createPendingController } = require('../../../src/renderer/controllers/pending');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function environment() {
  const dom = createModalDom();
  const host = createModalHost(dom);
  const bridge = createModalBridge({ host });
  const elements = new Map();
  const feedback = [];
  const errors = [];
  const dialogs = [];
  const panel = { ownerDocument: dom.document, querySelector(selector) {
    if (!elements.has(selector)) {
      const element = dom.document.createElement(selector.includes('Select') ? 'select' : 'button');
      element.dataset = {};
      element.classList = { toggle() {} };
      element.querySelector = () => element;
      elements.set(selector, element);
    }
    return elements.get(selector);
  } };
  const factory = options => { const descriptor = dom.createDialog(); dialogs.push({ options, descriptor }); return descriptor; };
  const ui = { modalHost: host, modalBridge: bridge, status(_element, text, tone) { feedback.push({ text, tone }); },
    reportError(error) { errors.push(error); }, createAcquiringBillCurrencyMonthPickerDialog: factory,
    createAlertDialog: factory, createConfirmDialog: factory, createBizOpReconDatePickerDialog: factory,
    createBizOpReconSecondImportPromptDialog: factory, createBizOpReconReconcileDialog: factory,
    createBizOpReconExportDialog: factory, getBizOpReconDefaultDate: () => '2026-03-02', confirmNative: () => true };
  function choose(value) {
    const { options } = dialogs.at(-1);
    host.getTop().close({ status: 'submitted', value });
    options.onConfirm(value);
  }
  return { ...dom, host, bridge, elements, panel, ui, feedback, errors, dialogs, choose };
}
const acquiringApi = { listMonths: async () => [], sessionStatus: async () => ({ monthKey: null }) };
const bizApi = { listBu: async () => [{ buName: 'BU 原值' }], listReadyDates: async () => [{ date: '2026-03-02' }],
  listSuccessDates: async () => [{ date: '2026-03-02', runId: 23 }] };

test('收单月份选择取消、busy leave 拒绝和订阅幂等释放', async () => {
  const env = environment(); let calls = 0; let subscriptions = 0; let unsubscribes = 0;
  const pending = deferred();
  const controller = createAcquiringController({ ...env, api: { ...acquiringApi, run: () => { calls++; return pending.promise; },
    onRunProgress: () => { subscriptions++; return () => { unsubscribes++; }; } } });
  await controller.enter();
  const cancelled = controller.run(); env.host.closeTop(); await cancelled;
  assert.equal(calls, 0);
  const operation = controller.run(); env.choose('2026-03'); await flush();
  assert.equal(calls, 1); assert.equal(subscriptions, 1);
  const busy = env.host.openRoot(() => env.createDialog({ canClose: () => false }), { owner: 'acquiring-bill-currency' }).handle;
  assert.equal(controller.leave().status, 'blocked');
  busy.dispose();
  assert.equal(controller.leave().status, 'left');
  const before = env.feedback.length;
  pending.resolve({ status: 'success', totalBillRows: 8, mismatchRows: 2, unmatchedRows: 1, diffFilePath: '/out/diff.xlsx' });
  await operation;
  assert.equal(env.feedback.length, before);
  assert.equal(unsubscribes, 1);
  await controller.enter();
  assert.match(env.feedback.at(-1).text, /币种差异 2 条.*未匹配 1 条/);
  controller.dispose(); controller.dispose(); assert.equal(unsubscribes, 1);
  assert.equal(env.elements.get('#acquiringBillCurrencyRunBtn').listenerCount('click'), 0);
});

test('收单覆盖只沿原 preparedContextId 二次提交，离页后的预检不确认或续写', async () => {
  const env = environment(); const requests = [];
  const controller = createAcquiringController({ ...env, api: { ...acquiringApi, importFlow: async payload => {
    requests.push(payload); return requests.length === 1 ? { status: 'overwrite-required', monthKey: '2026-03', preparedContextId: 'original', existingCount: 5, fileCount: 2 }
      : { status: 'success', monthKey: '2026-03', totalImported: 12, overwritten: true, deletedCount: 5 };
  } } });
  await controller.enter(); const operation = controller.importFlow(); env.choose('2026-03'); await operation;
  assert.deepEqual(requests, [{ monthKey: '2026-03' }, { monthKey: '2026-03', preparedContextId: 'original', confirmOverwrite: true }]);
  assert.match(env.feedback.at(-1).text, /共 12 行（已清旧 5 行）/);
  controller.dispose();
  const late = deferred(); let confirmations = 0;
  const second = createAcquiringController({ ...env, ui: { ...env.ui, confirmNative: () => { confirmations++; return true; } },
    api: { ...acquiringApi, importBill: () => late.promise } });
  await second.enter(); const delayed = second.importBill(); env.choose('2026-03'); await flush(); second.leave();
  late.resolve({ status: 'overwrite-required', monthKey: '2026-03', preparedContextId: 'late' }); await delayed;
  assert.equal(confirmations, 0); second.dispose();
});

test('收单新 enter 不接受旧读取，进度格式保留文件名和各阶段', async () => {
  const env = environment(); const first = deferred(); let reads = 0;
  const controller = createAcquiringController({ ...env, api: { ...acquiringApi, listMonths: () => ++reads === 1 ? first.promise : Promise.resolve(['2026-03']) } });
  const old = controller.enter(); controller.leave(); await controller.enter(); first.resolve(['2020-01']);
  assert.equal((await old).status, 'stale');
  assert.equal(formatAcquiringBillCurrencyProgress({ phase: 'import', stage: 'reading', filePath: 'C:\\data\\a.xlsx', fileIndex: 1, fileCount: 3 }), '正在导入 a.xlsx 文件 (2/3 个文件)');
  assert.equal(formatAcquiringBillCurrencyProgress({ phase: 'run', stage: 'sql-joining' }), '正在比对币种（耗时较长，请稍候）...');
  controller.dispose();
});

test('旧 BizOP 取消首日续导后保存原 BU/日期/行数，不发流水导入', async () => {
  const env = environment(); const calls = [];
  const controller = createBizOpLegacyController({ ...env, api: { ...bizApi,
    pickBizOpFile: async payload => { calls.push(['pick', payload]); return { status: 'success', filePath: '/op.xlsx' }; },
    runBizOpImport: async payload => { calls.push(['import', payload]); return { status: 'success', buName: 'BU 原值', validCount: 17 }; },
    checkSingleDay: async () => ({ onlyOneDay: true }) } });
  await controller.enter(); const operation = controller.importFiles(); env.choose('2026-03-02'); await flush();
  assert.equal(env.dialogs.at(-1).options.firstDate, '2026-03-02');
  env.host.closeTop(); await operation;
  assert.deepEqual(calls, [['pick', { date: '2026-03-02' }], ['import', { date: '2026-03-02', filePath: '/op.xlsx' }]]);
  assert.match(env.feedback.at(-1).text, /已导入第 1 日数据（2026-03-02 \/ BU=BU 原值）/);
  controller.dispose();
});

test('旧 BizOP 流水多文件保持数组和整批拒绝报告', async () => {
  const env = environment(); let payload;
  const controller = createBizOpLegacyController({ ...env, api: { ...bizApi,
    pickBizOpFile: async () => ({ filePath: '/op.xlsx' }), runBizOpImport: async () => ({ status: 'success', buName: 'BU 原值', validCount: 2 }),
    checkSingleDay: async () => ({ onlyOneDay: false }), pickFlowFile: async () => ({ filePaths: ['/a.xlsx', '/b.xlsx'] }),
    runFlowImport: async value => { payload = value; return { status: 'rejected', errorRows: [1, 2], errorReportPath: '/errors.xlsx' }; } } });
  await controller.enter(); const operation = controller.importFiles(); env.choose('2026-03-02'); await flush();
  env.choose('2026-03-02'); await operation;
  assert.deepEqual(payload, { date: '2026-03-02', filePaths: ['/a.xlsx', '/b.xlsx'] });
  assert.match(env.feedback.at(-1).text, /2 行（整批拒绝）；失败报告：\/errors.xlsx/);
  controller.dispose();
});

test('旧 BizOP 区间导出原参数/文件名和晚到反馈；重新进入保留完成状态', async () => {
  const env = environment(); let filename; let payload; const result = deferred();
  const controller = createBizOpLegacyController({ ...env, api: { ...bizApi,
    pickSavePath: async value => { filename = value.defaultFileName; return { savePath: '/out.xlsx' }; },
    exportDateRange: value => { payload = value; return result.promise; } } });
  await controller.enter(); const operation = controller.export(); await flush();
  env.choose({ scope: 'range', startDate: '2026-03-01', endDate: '2026-03-02' }); await flush();
  assert.match(filename, /^业务OP数据核对_BU 原值_20260301-20260302_\d{8}T\d{6}\.xlsx$/);
  assert.deepEqual(payload, { buName: 'BU 原值', startDate: '2026-03-01', endDate: '2026-03-02', savePath: '/out.xlsx' });
  controller.leave(); const length = env.feedback.length;
  result.resolve({ status: 'success', filePath: '/out.xlsx', skippedDates: ['2026-03-01'] }); await operation;
  assert.equal(env.feedback.length, length); assert.equal(env.host.getTop(), null);
  await controller.enter(); assert.equal(env.feedback.at(-1).text, '差异表已生成：/out.xlsx'); controller.dispose();
});

test('旧 BizOP BU 切换独立代次拒绝旧日期回复', async () => {
  const env = environment(); const slow = deferred(); let pendingMode = false;
  const controller = createBizOpLegacyController({ ...env, api: { ...bizApi,
    listBu: async () => [{ buName: 'A' }, { buName: 'B' }],
    listReadyDates: value => pendingMode && value.buName === 'A' ? slow.promise : Promise.resolve([{ date: '2026-03-01' }]) } });
  await controller.enter(); pendingMode = true;
  const old = controller.selectBu('A'); await flush(); await controller.selectBu('B'); slow.resolve([]); await old;
  assert.equal(controller.getSnapshot().selectedBu, 'B');
  assert.equal(env.elements.get('#bizOpReconRunBtn').disabled, false); controller.dispose();
});

test('Pending 私有状态、读取代次、重复绑定与 unsubscribe 一次', async () => {
  const env = environment(); let subscribes = 0; let removes = 0; const oldMonths = deferred(); let reads = 0;
  const api = { getRule: async () => ({ matchFields: ['ID'], compareFields: [] }),
    listMonths: () => ++reads === 1 ? oldMonths.promise : Promise.resolve(['2026-03', '2026-02']),
    diff: { listAllRuns: async () => [{ id: 31 }] }, onImportProgress: () => { subscribes++; return () => { removes++; }; } };
  const controller = createPendingController({ ...env, api });
  const first = controller.enter(); controller.leave(); await controller.enter();
  oldMonths.resolve(['2020-01']); assert.equal((await first).status, 'stale');
  assert.deepEqual(controller.getSnapshot().months, ['2026-03', '2026-02']);
  assert.equal(controller.getSnapshot().latestRunId, 31);
  controller.bindEvents(); assert.equal(subscribes, 1);
  const preview = { months: ['2025-01'], lastImportSummary: '已导入' };
  controller.applyPreviewState(preview); preview.months.push('malicious');
  assert.deepEqual(controller.getSnapshot().months, ['2025-01']);
  controller.dispose(); controller.dispose(); assert.equal(removes, 1);
  assert.equal(env.elements.get('#pendingImportBtn').listenerCount('click'), 0);
});
