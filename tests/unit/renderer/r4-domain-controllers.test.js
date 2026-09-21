'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createModalDom } = require('../../helpers/modal-dom');
const { createModalHost } = require('../../../src/renderer/modal-host');
const { createModalBridge } = require('../../../src/renderer/modal-bridge');
const { createPreFundController } = require('../../../src/renderer/controllers/pre-fund');
const { createBankBuController } = require('../../../src/renderer/controllers/bank-bu');
const { createDuplicateInboundController } = require('../../../src/renderer/controllers/duplicate-inbound');
const { createVccOpCalcController } = require('../../../src/renderer/controllers/vcc-op-calc');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const domains = [
  { key: 'preFund', factory: createPreFundController, prefix: 'preFundReconciliation', owner: 'pre-fund-reconciliation',
    statusMethod: 'sessionStatus', ready: { status: 'ok', canRun: true, canExport: true }, empty: { status: 'ok', canRun: false, canExport: false }, command: 'importBank', operation: 'importBank' },
  { key: 'bankBu', factory: createBankBuController, prefix: 'bankBuRecon', owner: 'bank-bu-recon',
    statusMethod: 'listReadyMonths', ready: ['2026-08'], empty: [], command: 'run', operation: 'listReadyMonths' },
  { key: 'duplicateInbound', factory: createDuplicateInboundController, prefix: 'duplicateInboundMatch', owner: 'duplicate-inbound-match',
    statusMethod: 'sessionStatus', ready: { status: 'ok', canRun: true, canExport: true }, empty: { status: 'ok', canRun: false, canExport: false }, command: 'import', operation: 'importFiles' },
  { key: 'vccOpCalc', factory: createVccOpCalcController, prefix: 'vccOpCalc', owner: 'vcc-op-calc',
    statusMethod: 'listBalanceMonths', ready: ['2026-08'], empty: [], command: 'import', operation: 'pickFiles' }
];

function harness(domain, overrides = {}) {
  const dom = createModalDom();
  const nodes = new Map();
  const calls = [];
  const views = [];
  const errors = [];
  const progress = new Map();
  let releases = 0;
  const panel = {
    querySelector(selector) {
      assert.ok(selector.startsWith('#' + domain.prefix), '只能查询本域 panel');
      if (!nodes.has(selector)) {
        const element = dom.document.createElement(selector.endsWith('Select') ? 'select' : 'button');
        element.value = 'withdraw';
        element.textContent = '';
        nodes.set(selector, element);
      }
      return nodes.get(selector);
    }
  };
  const api = {
    sessionStatus: async () => ({ status: 'ok', canRun: true, canExport: true }),
    listReadyMonths: async () => ['2026-08'],
    listSuccessMonths: async () => [{ yearMonth: '2026-08', runId: 1 }],
    listBalanceMonths: async () => ['2026-08'],
    importBank: async () => ({ status: 'cancelled' }),
    importMpt: async () => ({ status: 'cancelled' }),
    importFiles: async () => ({ status: 'cancelled' }),
    pickFiles: async () => ({ status: 'cancelled' }),
    pickPendingFile: async () => ({ status: 'success', filePath: '/test/pending.xlsx' }),
    pickBankFile: async () => ({ status: 'success', filePath: '/test/bank.xlsx' }),
    runImport: async () => ({ status: 'success', pendingCount: 20, bankCount: 30 }),
    run: async () => ({ status: 'success', stats: { matchedCount: 12, buDiffCount: 1, pendingUnmatched: 2, bankUnmatched: 3, nmAnomalyCount: 4 } }),
    pickSavePath: async () => ({ status: 'success', savePath: '/test/result.xlsx' }),
    exportSingle: async () => ({ status: 'success', filePath: '/test/result.xlsx' }),
    exportAggregate: async () => ({ status: 'success', filePath: '/test/result.xlsx', skippedMonths: ['2026-07'] }),
    export: async () => ({ status: 'success', filePath: '/test/result.xlsx' }),
    scan: async () => ({ status: 'success', yearMonth: '2026-08', totalRows: 30, fileCount: 1 }),
    computeAmounts: async () => ({ status: 'success', yearMonth: '2026-08', totals: { totalOut: '1.01', totalIn: '2.03', totalAmount: '1.02' } }),
    save: async () => ({ status: 'success', yearMonth: '2026-08', beginOp: '0.01', endOp: '1.03' }),
    getBalance: async ({ yearMonth }) => ({ yearMonth, endOp: '1.03' }),
    ...overrides
  };
  for (const [name, fn] of Object.entries(api)) api[name] = (...args) => { calls.push({ name, args }); return fn(...args); };
  for (const name of ['onImportProgress', 'onRunProgress', 'onExportProgress', 'onScanProgress']) {
    api[name] = (listener) => {
      progress.set(name, listener);
      return () => { releases += 1; progress.delete(name); };
    };
  }
  const host = createModalHost({ root: dom.root, document: dom.document });
  const bridge = createModalBridge({ host });
  const ui = {
    modalHost: host, modalBridge: bridge,
    status(element, text, tone) { element.textContent = text; element.tone = tone; },
    reportError: (error) => errors.push(error),
    escapeHtml: (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    alert: (message) => dialog('alert', { message })
  };
  function dialog(name, options) {
    const view = dom.createDialog();
    view.name = name;
    view.options = options;
    view.busy = false;
    bridge.registerModal(view.overlay, { dialog: view.dialog, canClose: () => !view.busy });
    views.push(view);
    return view.overlay;
  }
  for (const name of [
    'createPreFundTempManagerDialog', 'createBankBuReconMonthPickerDialog', 'createBankBuReconFileImportPromptDialog',
    'createBankBuReconReconcileDialog', 'createBankBuReconExportDialog', 'createVccOpCalcConfirmDialog',
    'createVccOpCalcComputeDialog', 'createVccOpCalcShowBalanceDialog'
  ]) ui[name] = (options) => dialog(name, options);
  const controller = domain.factory({ api, panel, ui });
  return {
    controller, api, ui, dom, host, bridge, nodes, calls, views, errors, progress,
    get releases() { return releases; },
    node(suffix) { return nodes.get('#' + domain.prefix + suffix); },
    status() { return nodes.get('#' + domain.prefix + 'StatusBox').textContent; },
    snapshot() { return [...nodes.values()].map((node) => [node.disabled, node.textContent]); },
    async confirm(view, value, action = 'onConfirm') {
      // 月份/F1 这类工厂在开始业务回调前提交并关闭；F2 onCompute 保持当前视图。
      if (action === 'onConfirm') bridge.closeModal(view.overlay, { status: 'submitted', value });
      return await view.options[action](value);
    }
  };
}

for (const domain of domains) {
  test(`${domain.key} 工厂无 IPC、私有状态，重复 enter 不重复绑定，dispose 取消静态监听`, async () => {
    const h = harness(domain);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(Object.keys(h.controller).sort(), ['commands', 'dispose', 'enter', 'invalidate', 'leave']);
    await h.controller.enter();
    await h.controller.enter();
    for (const [selector, button] of h.nodes) {
      if (selector.endsWith('Btn')) assert.equal(button.listenerCount('click'), 1);
    }
    h.controller.dispose();
    h.controller.dispose();
    for (const button of h.nodes.values()) assert.equal(button.listenerCount('click'), 0);
    const before = h.calls.length;
    await h.controller.commands[domain.command]();
    assert.equal(h.calls.length, before);
    assert.equal((await h.controller.enter()).status, 'stale');
  });

  test(`${domain.key} A/B/A 的旧读取不能覆盖新访问；每次进入重读 Main`, async () => {
    const first = deferred();
    const second = deferred();
    let reads = 0;
    const h = harness(domain, { [domain.statusMethod]: () => (++reads === 1 ? first.promise : second.promise) });
    const oldEntry = h.controller.enter();
    assert.equal(h.controller.leave().status, 'left');
    const newEntry = h.controller.enter();
    second.resolve(domain.ready);
    assert.equal((await newEntry).status, 'ready');
    const fresh = h.snapshot();
    first.resolve(domain.empty);
    assert.equal((await oldEntry).status, 'stale');
    assert.deepEqual(h.snapshot(), fresh);
    assert.equal(reads, 2);
  });

  test(`${domain.key} 同一访问内较旧 refresh 迟到不覆盖最近结果`, async () => {
    const first = deferred();
    const second = deferred();
    let reads = 0;
    const h = harness(domain, { [domain.statusMethod]: () => (++reads === 1 ? first.promise : second.promise) });
    const entering = h.controller.enter();
    const latest = h.controller.invalidate();
    second.resolve(domain.ready);
    await latest;
    const fresh = h.snapshot();
    first.resolve(domain.empty);
    assert.equal((await entering).status, 'stale');
    assert.deepEqual(h.snapshot(), fresh);
  });

  test(`${domain.key} 状态读取失败在本域反馈，enter 返回 error`, async () => {
    const h = harness(domain, { [domain.statusMethod]: async () => { throw new Error('测试读取失败'); } });
    assert.equal((await h.controller.enter()).status, 'error');
    assert.match(h.status(), /状态读取失败|测试读取失败/);
    assert.equal(h.errors.length, 1);
  });

  test(`${domain.key} leave 服从现有 modal canClose，blocked 时保留当前作用域`, async () => {
    const h = harness(domain);
    await h.controller.enter();
    const view = h.dom.createDialog();
    let busy = true;
    h.host.openRoot(() => ({ ...view, canClose: () => !busy }), { owner: domain.owner });
    assert.equal(h.controller.leave().status, 'blocked');
    assert.equal(view.overlay.isConnected, true);
    busy = false;
    assert.equal(h.controller.leave().status, 'left');
    assert.equal(view.overlay.isConnected, false);
    const before = h.calls.length;
    await h.controller.commands[domain.command]();
    assert.equal(h.calls.length, before);
  });
}

test('前置资金导出保留文件名和提醒，完成刷新不覆盖导出反馈', async () => {
  const h = harness(domains[0], { export: async () => ({ status: 'ok', files: [{ fileName: 'A.xlsx' }, { fileName: 'B.xlsx' }], warnings: ['待核实渠道'] }) });
  await h.controller.enter();
  await h.controller.commands.export();
  assert.equal(h.status(), '已导出 2 个文件\nA.xlsx\nB.xlsx\n提醒：待核实渠道');
  assert.equal(h.node('StatusBox').tone, 'info');
  assert.equal(h.calls.filter((call) => call.name === 'sessionStatus').length, 2);
  assert.equal(h.releases, 1);
});

test('前置资金临时账单导入保留部分失败对象和文案，场景参数原样送 Main', async () => {
  const result = { status: 'ok', results: [{ status: 'failed', fileName: '<bad>.xlsx', message: '列缺失' }] };
  const h = harness(domains[0], { importMpt: async () => result, run: async () => ({ status: 'ok' }) });
  await h.controller.enter();
  assert.equal(await h.controller.commands.importMpt(), result);
  assert.match(h.views.at(-1).options.message, /部分文件导入失败（1 个）/);
  assert.match(h.views.at(-1).options.message, /&lt;bad&gt;/);
  await h.controller.commands.run();
  assert.deepEqual(h.calls.find((call) => call.name === 'run').args, [{ scenario: 'withdraw' }]);
});

test('前置资金无 modal 后台导入允许离开，释放进度并丢弃晚到错误 UI', async () => {
  const importing = deferred();
  const h = harness(domains[0], { importMpt: () => importing.promise });
  await h.controller.enter();
  const waiting = h.controller.commands.importMpt();
  const lateProgress = h.progress.get('onImportProgress');
  assert.equal(h.controller.leave().status, 'left');
  const snapshot = h.snapshot();
  lateProgress({ current: 1, total: 2 });
  importing.resolve({ status: 'failed', message: '晚到错误' });
  await waiting;
  assert.equal(h.releases, 1);
  assert.equal(h.views.length, 0);
  assert.deepEqual(h.snapshot(), snapshot);
  await h.controller.enter();
  assert.equal(h.node('ImportBankBtn').disabled, false);
});

test('重复入金导出保留警告与失败细节，按 Main 状态更新按钮', async () => {
  const h = harness(domains[2], { export: async () => ({ status: 'success', filePath: '/test/result.xlsx', warnings: ['匹配待复核'] }) });
  await h.controller.enter();
  await h.controller.commands.export();
  assert.equal(h.status(), '文件已生成：/test/result.xlsx\n警告：匹配待复核');
  assert.equal(h.node('StatusBox').tone, 'warning');
  h.api.export = async () => ({ status: 'failed', message: '来源变化', detailLines: ['请重新导入'] });
  await h.controller.commands.export();
  assert.equal(h.status(), '导出失败：来源变化\n请重新导入');
  assert.equal(h.node('ExportBtn').disabled, false);
  assert.equal(h.releases, 2);
});

test('重复入金后台任务离开后不续读、不写 UI；重新进入从 Main 刷新', async () => {
  const importing = deferred();
  const h = harness(domains[2], { importFiles: () => importing.promise });
  await h.controller.enter();
  const waiting = h.controller.commands.import();
  const lateProgress = h.progress.get('onImportProgress');
  assert.equal(h.controller.leave().status, 'left');
  const before = h.snapshot();
  lateProgress({ message: '晚到进度' });
  importing.resolve({ status: 'ok' });
  await waiting;
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.calls.filter((call) => call.name === 'sessionStatus').length, 1);
  assert.equal(h.releases, 1);
  await h.controller.enter();
  assert.equal(h.calls.filter((call) => call.name === 'sessionStatus').length, 2);
  assert.equal(h.node('ImportBtn').disabled, false);
});

test('BankBU 两步选文件和导入保持原参数；完成摘要/异常组文案不变', async () => {
  const h = harness(domains[1]);
  await h.controller.enter();
  await h.controller.commands.import();
  await h.confirm(h.views.at(-1), '2026-08');
  assert.equal(h.views.at(-1).options.title, '请导入 Pending 数据管理文件');
  await h.confirm(h.views.at(-1));
  assert.equal(h.views.at(-1).options.title, '请导入银行对账单文件');
  await h.confirm(h.views.at(-1));
  assert.deepEqual(h.calls.find((call) => call.name === 'runImport').args, [{ yearMonth: '2026-08', pendingPath: '/test/pending.xlsx', bankPath: '/test/bank.xlsx' }]);
  assert.match(h.status(), /Pending 20 行 \/ 银行对账单 30 行/);
  await h.controller.commands.run();
  await h.confirm(h.views.at(-1), '2026-08');
  assert.match(h.status(), /BU 差异 1 行.*N:M 异常 4 组/);
});

test('BankBU 导出 single/aggregate 保持 runId、文件名及跳过月份提示', async () => {
  const h = harness(domains[1]);
  await h.controller.enter();
  await h.controller.commands.export();
  await h.confirm(h.views.at(-1), { scope: 'single', yearMonth: '2026-08', runId: 77 });
  assert.deepEqual(h.calls.find((call) => call.name === 'exportSingle').args, [{ runId: 77, savePath: '/test/result.xlsx' }]);
  assert.match(h.calls.find((call) => call.name === 'pickSavePath').args[0].defaultFileName, /^月度银行对账单BU回填校验_202608_\d{8}T\d{6}\.xlsx$/);
  await h.controller.commands.export();
  await h.confirm(h.views.at(-1), { scope: 'aggregate' });
  assert.match(h.views.at(-1).options.message, /1 个月份.*2026-07/);
  assert.equal(h.status(), '差异表已生成：/test/result.xlsx');
});

test('BankBU 离开后旧文件选择不打开第二步骤或启动导入', async () => {
  const pending = deferred();
  const h = harness(domains[1], { pickPendingFile: () => pending.promise });
  await h.controller.enter();
  await h.controller.commands.import();
  await h.confirm(h.views.at(-1), '2026-08');
  const waiting = h.confirm(h.views.at(-1));
  h.controller.leave();
  pending.resolve({ status: 'success', filePath: '/test/pending.xlsx' });
  await waiting;
  assert.equal(h.views.length, 2);
  assert.equal(h.calls.some((call) => call.name === 'pickBankFile' || call.name === 'runImport'), false);
});

test('VCC OP scan→F1→统计→F2 保存保持金额原样、结果文案和余额读取', async () => {
  const h = harness(domains[3], { pickFiles: async () => ({ status: 'success', filePaths: ['/test/a.xlsx'] }) });
  await h.controller.enter();
  await h.controller.commands.import();
  assert.equal(h.views.at(-1).name, 'createVccOpCalcConfirmDialog');
  await h.confirm(h.views.at(-1));
  assert.equal(h.node('RunBtn').disabled, false);
  assert.match(h.status(), /发生额出 1.01：发生额入 2.03：总发生额 1.02/);
  await h.controller.commands.run();
  const result = await h.confirm(h.views.at(-1), '000.0100', 'onCompute');
  assert.deepEqual(h.calls.find((call) => call.name === 'save').args, [{ beginOp: '000.0100' }]);
  assert.deepEqual(result, { status: 'success', endOp: '1.03' });
  assert.match(h.status(), /期初OP 0.01 → 期末OP 1.03（已保存）/);
  assert.equal(h.node('RunBtn').disabled, true);
  await h.controller.commands.showBalance();
  assert.deepEqual(await h.confirm(h.views.at(-1), '2026-08', 'onView'), { yearMonth: '2026-08', endOp: '1.03' });
});

test('VCC OP 整批拒绝仍报告真实异常总数和前20条，不统计或保存', async () => {
  const errorRows = Array.from({ length: 25 }, (_, i) => ({ fileName: 'A.xlsx', rowIndex: i + 1, reason: '异常' }));
  const h = harness(domains[3], {
    pickFiles: async () => ({ status: 'success', filePaths: ['/test/a.xlsx'] }),
    scan: async () => ({ status: 'rejected', errorCount: 350, errorRows })
  });
  await h.controller.enter();
  await h.controller.commands.import();
  const message = h.views.at(-1).options.message;
  assert.match(message, /共 350 处异常/);
  assert.match(message, /第 20 行/);
  assert.doesNotMatch(message, /第 21 行/);
  assert.match(message, /其余 330 处略/);
  assert.equal(h.calls.some((call) => ['computeAmounts', 'save'].includes(call.name)), false);
});

test('VCC OP scan 等待中离开立即退订，晚到不显示 F1；dispose 的忙碌视图也收尾', async () => {
  const scanning = deferred();
  const h = harness(domains[3], { pickFiles: async () => ({ status: 'success', filePaths: ['/test/a.xlsx'] }), scan: () => scanning.promise });
  await h.controller.enter();
  const waiting = h.controller.commands.import();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.progress.size, 1);
  assert.equal(h.controller.leave().status, 'left');
  assert.equal(h.releases, 1);
  scanning.resolve({ status: 'success', yearMonth: '2026-08', totalRows: 30, fileCount: 1 });
  await waiting;
  assert.equal(h.views.length, 0);
  await h.controller.enter();
  await h.controller.commands.showBalance();
  const view = h.views.at(-1);
  view.busy = true;
  assert.equal(h.controller.leave().status, 'blocked');
  h.controller.dispose();
  assert.equal(view.overlay.isConnected, false);
  const before = h.calls.length;
  assert.deepEqual(await view.options.onView('2026-08'), { status: 'stale' });
  assert.equal(h.calls.length, before);
});

for (const domain of [domains[0], domains[2]]) {
  test(`${domain.key} 返回早于后台完成时通过新的 Main 读取恢复按钮，旧结果不进入新页面`, async () => {
    const background = deferred();
    let reads = 0;
    const h = harness(domain, {
      [domain.operation]: () => background.promise,
      sessionStatus: async () => {
        reads += 1;
        return { status: 'ok', canRun: reads >= 3, canExport: reads >= 3 };
      }
    });
    await h.controller.enter();
    const waiting = h.controller.commands[domain.command]();
    assert.equal((await h.controller.commands[domain.command]()).status, 'blocked');
    assert.equal(h.calls.filter((call) => call.name === domain.operation).length, 1);
    assert.equal(h.controller.leave().status, 'left');
    await h.controller.enter();
    const importNode = h.node(domain.key === 'preFund' ? 'ImportBankBtn' : 'ImportBtn');
    assert.equal(importNode.disabled, true);
    background.resolve({ status: 'failed', message: '上一访问的失败不可展示' });
    await waiting;
    assert.equal(reads, 3);
    assert.equal(importNode.disabled, false);
    assert.equal(h.node('RunBtn').disabled, false);
    assert.equal(h.node('ExportBtn').disabled, false);
    assert.doesNotMatch(h.status(), /上一访问的失败/);
    assert.equal(h.views.length, 0);
  });
}
