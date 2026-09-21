'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const { createModalDom } = require('../../helpers/modal-dom');
const { createModalHost } = require('../../../src/renderer/modal-host');
const { createModalBridge } = require('../../../src/renderer/modal-bridge');
const { createVccOpCalcController } = require(process.env.VCC_OP_CALC_CONTROLLER_PATH
  || '../../../src/renderer/controllers/vcc-op-calc');
const { FLOW_HEADERS } = require('../../../src/backend/vcc-op-calc-db/columns');
const { createVccOpCalcSession } = require('../../../src/main-process/vcc-op-calc-session');
const { hashVccOpComputeSnapshot } = require('../../../src/main-process/vcc-op-calc/save-run-contract');
const { ensureVccOpCalcTablesSupport } = require('../../../src/backend/database/migrations');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-source-binding-'));
  const db = new DatabaseSync(':memory:');
  ensureVccOpCalcTablesSupport(db);
  const session = createVccOpCalcSession({ getDb: () => db });
  const files = {};
  // 仅合成数据：A 与 C 金额、账期相同，文件不同；D 触发现有整批拒绝。
  for (const [name, month, amount, direction] of [
    ['A', '2026-07', '10.00', '入'], ['B', '2026-08', '900.00', '入'],
    ['C', '2026-07', '10.00', '入'], ['D', '2026-08', '5.00', '非法方向']
  ]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Flow');
    ws.addRow(FLOW_HEADERS.slice());
    const row = new Array(FLOW_HEADERS.length).fill('');
    row[1] = month + '-15'; row[8] = direction; row[13] = amount; row[14] = 'CNY';
    ws.addRow(row);
    files[name] = path.join(tmp, name + '.xlsx');
    await wb.xlsx.writeFile(files[name]);
  }
  const dom = createModalDom();
  const host = createModalHost({ root: dom.root, document: dom.document });
  const bridge = createModalBridge({ host });
  const nodes = new Map();
  const views = [];
  const calls = [];
  const controls = {};
  const releases = [];
  let selected = 'A';
  let writes = 0;
  const defaults = {
    pickFiles: async () => ({ status: 'success', filePaths: [files[selected]] }),
    scan: async ({ filePaths }) => {
      const result = await session.streamScanAndCompute(filePaths);
      return result.ok
        ? { status: 'success', yearMonth: result.yearMonth, totalRows: result.totalRows, fileCount: filePaths.length }
        : { status: 'rejected', errorRows: result.errorRows, errorCount: result.errorCount };
    },
    computeAmounts: async () => {
      const cache = session.getComputeCache();
      return cache ? { status: 'success', ...cache } : { status: 'error', message: '无统计结果（请先导入文件）' };
    },
    save: async ({ beginOp }) => {
      const id = ++writes;
      try {
        return { status: 'success', ...session.saveRun({ beginOp, operationOwner: {
          taskRunId: 'vcc-source-test-' + id, taskKey: 'vccOpCalc:run:save', moduleId: 'vcc-op-calc',
          parentRunId: 'vcc-source-parent-' + id, operationKey: 'vcc-source-operation-' + id
        } }) };
      } catch (error) { return { status: 'error', message: error.message }; }
    },
    listBalanceMonths: async () => session.listCalculatedMonths().map((month) => month.yearMonth),
    getBalance: async ({ yearMonth }) => session.getMonthResult(yearMonth),
    onScanProgress: () => () => {}
  };
  const api = Object.fromEntries(Object.entries(defaults).map(([name, fn]) => [name, (...args) => {
    calls.push({ name, args });
    return (controls[name] || fn)(...args);
  }]));
  function dialog(name, options) {
    const view = dom.createDialog();
    Object.assign(view, { name, options });
    bridge.registerModal(view.overlay, { dialog: view.dialog, canClose: options.canClose });
    views.push(view);
    return view.overlay;
  }
  const panel = { querySelector(selector) {
    assert.match(selector, /^#vccOpCalc/);
    if (!nodes.has(selector)) {
      const node = dom.document.createElement('button');
      node.textContent = '';
      nodes.set(selector, node);
    }
    return nodes.get(selector);
  } };
  const ui = {
    modalHost: host, modalBridge: bridge,
    status: (node, message, tone) => { node.textContent = message; node.tone = tone; },
    alert: (message) => dialog('alert', { message }),
    createVccOpCalcConfirmDialog: (options) => dialog('F1', options),
    createVccOpCalcComputeDialog: (options) => dialog('F2', options),
    createVccOpCalcShowBalanceDialog: (options) => dialog('F3', options)
  };
  const controller = createVccOpCalcController({ api, panel, ui });
  t.after(() => { controller.dispose(); for (const release of releases) release(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const h = {
    controller, session, db, files, controls, defaults, calls, views, host, bridge, dom,
    select: (name) => { selected = name; },
    node: (suffix) => nodes.get('#vccOpCalc' + suffix),
    status: () => nodes.get('#vccOpCalcStatusBox').textContent,
    rows: () => db.prepare('SELECT year_month,begin_op,total_amount,end_op FROM vcc_op_calc_runs ORDER BY id').all().map((row) => ({ ...row })),
    count: (name) => calls.filter((call) => call.name === name).length,
    async import(name = selected) { selected = name; return controller.commands.import(); },
    async confirm(view = views.at(-1)) {
      assert.equal(view.name, 'F1');
      bridge.closeModal(view.overlay, { status: 'submitted', value: true });
      return view.options.onConfirm();
    },
    async ready(name = selected) { await h.import(name); await h.confirm(); },
    async f2() { await controller.commands.run(); const view = views.at(-1); assert.equal(view.name, 'F2'); return view; },
    hold(name, after = true) {
      const started = deferred();
      const response = deferred();
      releases.push(response.resolve);
      controls[name] = async (...args) => {
        const result = after ? await defaults[name](...args) : null;
        started.resolve();
        await response.promise;
        return after ? result : defaults[name](...args);
      };
      return { started: started.promise, release: response.resolve };
    }
  };
  await controller.enter();
  return h;
}

test('R01：后台重扫 B 后不得恢复 A 的 F2；重新确认 B 后显示、期初、Main、SQLite 一致', async (t) => {
  const h = await harness(t);
  await h.ready('A');
  const delayed = h.hold('scan');
  const importing = h.import('B');
  await delayed.started;
  assert.equal(h.controller.leave().status, 'left');
  delayed.release();
  await importing;
  await h.controller.enter();
  assert.equal(h.node('RunBtn').disabled, true);
  assert.match(h.status(), /2026-08.*尚未确认/);
  await h.controller.commands.run();
  assert.equal(h.views.at(-1).name, 'alert');
  assert.equal(h.count('save'), 0);
  assert.deepEqual(h.rows(), []);
  delete h.controls.scan;
  await h.ready('B');
  const f2 = await h.f2();
  const mainCache = h.session.getComputeCache();
  assert.equal(f2.options.yearMonth, mainCache.yearMonth);
  assert.deepEqual(f2.options.totals, mainCache.totals);
  const saved = await f2.options.onCompute('100.00');
  assert.deepEqual(saved, { status: 'success', endOp: '1000.00' });
  assert.deepEqual(h.rows(), [{ year_month: '2026-08', begin_op: '100.00', total_amount: '900.00', end_op: '1000.00' }]);
  const fileRows = h.db.prepare('SELECT file_name,row_count,amount_out,amount_in,amount FROM vcc_op_calc_run_files').all().map((row) => ({ ...row }));
  assert.deepEqual(fileRows, [{ file_name: 'B.xlsx', row_count: 1, amount_out: '0.00', amount_in: '900.00', amount: '900.00' }]);
  const receipt = h.db.prepare('SELECT year_month,input_file_count,compute_snapshot_hash FROM vcc_op_operation_receipts').get();
  assert.equal(receipt.year_month, '2026-08');
  assert.equal(receipt.input_file_count, 1);
  assert.equal(receipt.compute_snapshot_hash, hashVccOpComputeSnapshot(mainCache).computeSnapshotHash);
  t.diagnostic(JSON.stringify({ displayed: { yearMonth: f2.options.yearMonth, totalAmount: f2.options.totals.totalAmount }, beginOp: '100.00', storedRows: h.rows(), fileRows, receipt }));
});

test('返回早于 scan 结束：仍禁用旧保存，晚到成功只结算未确认状态，不打开 F1', async (t) => {
  const h = await harness(t);
  await h.ready();
  const delayed = h.hold('scan');
  const importing = h.import('B');
  await delayed.started;
  h.controller.leave();
  await h.controller.enter();
  const views = h.views.length;
  assert.equal(h.node('RunBtn').disabled, true);
  assert.equal((await h.controller.commands.import()).status, 'blocked');
  delayed.release(); await importing;
  assert.equal(h.views.length, views);
  assert.equal(h.node('RunBtn').disabled, true);
  assert.equal(h.node('ImportBtn').disabled, false);
  assert.match(h.status(), /2026-08.*尚未确认/);
});

test('重扫成功后必须确认新 F1；F1 取消不能复活旧 A 保存资格', async (t) => {
  const h = await harness(t);
  await h.ready(); await h.import('B');
  assert.equal(h.node('RunBtn').disabled, true);
  const f1 = h.views.at(-1);
  assert.equal(f1.options.yearMonth, '2026-08');
  h.bridge.closeModal(f1.overlay); f1.options.onCancel();
  await h.controller.commands.run();
  assert.equal(h.count('save'), 0);
  assert.equal(h.count('computeAmounts'), 1);
  assert.equal(h.node('RunBtn').disabled, true);
  h.controller.leave(); await h.controller.enter();
  assert.equal(h.node('RunBtn').disabled, true);
});

test('F1 通过导航关闭也收尾取消；旧确认回调不能开始统计', async (t) => {
  const h = await harness(t);
  await h.import();
  const f1 = h.views.at(-1);
  h.controller.leave(); await h.controller.enter();
  const before = h.count('computeAmounts');
  await f1.options.onConfirm();
  assert.equal(h.count('computeAmounts'), before);
  assert.equal(h.node('RunBtn').disabled, true);
});

test('文件选择取消未改变 Main 来源：旧已确认 A 仍可按原金额保存', async (t) => {
  const h = await harness(t);
  await h.ready();
  h.controls.pickFiles = async () => ({ status: 'cancelled' });
  await h.import();
  assert.equal(h.count('scan'), 1);
  assert.equal(h.node('RunBtn').disabled, false);
  const f2 = await h.f2();
  await f2.options.onCompute('000.0100');
  assert.deepEqual(h.calls.find((call) => call.name === 'save').args, [{ beginOp: '000.0100' }]);
  assert.deepEqual(h.rows(), [{ year_month: '2026-07', begin_op: '0.01', total_amount: '10.00', end_op: '10.01' }]);
});

for (const outcome of ['cancelled', 'error', 'rejected']) {
  test(`已打开 F2 后重扫 ${outcome}：旧回调不保存，返回模块不恢复旧 ready`, async (t) => {
    const h = await harness(t);
    await h.ready(); const f2 = await h.f2();
    if (outcome !== 'rejected') h.controls.scan = async () => {
      h.session.clearCache();
      return { status: outcome, message: '合成扫描失败' };
    };
    await h.import(outcome === 'rejected' ? 'D' : 'B');
    await f2.options.onCompute('100.00');
    assert.equal(h.count('save'), 0);
    assert.equal(h.node('RunBtn').disabled, true);
    assert.equal(h.session.getComputeCache(), null);
    h.controller.leave(); await h.controller.enter();
    assert.equal(h.node('RunBtn').disabled, true);
    assert.match(h.status(), outcome === 'cancelled' ? /已取消导入/ : outcome === 'error' ? /合成扫描失败/ : /导入被拒绝/);
  });
}

test('同文件同金额重扫并确认也属于新来源，已关闭旧 F2 不得借新来源提交', async (t) => {
  const h = await harness(t);
  await h.ready(); const old = await h.f2();
  await h.ready('A');
  await old.options.onCompute('100.00');
  assert.equal(h.count('save'), 0);
  const fresh = await h.f2();
  await fresh.options.onCompute('5.00');
  assert.deepEqual(h.rows(), [{ year_month: '2026-07', begin_op: '5.00', total_amount: '10.00', end_op: '15.00' }]);
});

for (const stage of ['enter', 'F2', 'save']) {
  test(`Main 同账期同金额但不同文件来源，在 ${stage} 核对时拒绝旧确认`, async (t) => {
    const h = await harness(t);
    await h.ready();
    const f2 = stage === 'save' ? await h.f2() : null;
    await h.session.streamScanAndCompute([h.files.C]);
    if (stage === 'enter') { h.controller.leave(); await h.controller.enter(); }
    else if (stage === 'F2') await h.controller.commands.run();
    else await f2.options.onCompute('100.00');
    assert.equal(h.count('save'), 0);
    assert.equal(h.node('RunBtn').disabled, true);
    assert.match(h.status(), /统计来源已变化/);
    assert.deepEqual(h.rows(), []);
  });
}

for (const returnEarly of [false, true]) {
  test(`F1 已确认的统计在离页后完成，${returnEarly ? '提前返回后重新核对' : '再次进入核对'}正确来源`, async (t) => {
    const h = await harness(t);
    await h.import('B');
    const delayed = h.hold('computeAmounts');
    const computing = h.confirm();
    await delayed.started;
    h.controller.leave();
    if (returnEarly) await h.controller.enter();
    delayed.release(); await computing;
    delete h.controls.computeAmounts;
    if (!returnEarly) await h.controller.enter();
    assert.equal(h.node('RunBtn').disabled, false);
    assert.match(h.status(), /2026-08/);
    const f2 = await h.f2();
    assert.equal(f2.options.yearMonth, '2026-08');
    await f2.options.onCompute('100.00');
    assert.equal(h.rows()[0].end_op, '1000.00');
  });
}

test('统计失败在离页后保留真实失败反馈；重入禁用保存并可重新导入', async (t) => {
  const h = await harness(t);
  await h.import('B');
  const pending = deferred();
  h.controls.computeAmounts = () => pending.promise;
  const computing = h.confirm();
  h.controller.leave();
  pending.resolve({ status: 'error', message: '合成统计读取失败' });
  await computing; await h.controller.enter();
  assert.equal(h.node('RunBtn').disabled, true);
  assert.match(h.status(), /合成统计读取失败/);
  delete h.controls.computeAmounts;
  await h.ready('B');
  assert.equal(h.node('RunBtn').disabled, false);
});

test('保存前来源核对等待时销毁 F2，不发送尚未提交的 save', async (t) => {
  const h = await harness(t);
  await h.ready(); const f2 = await h.f2();
  const delayed = h.hold('computeAmounts');
  const saving = f2.options.onCompute('100.00');
  await delayed.started;
  h.host.getHandle(f2.overlay).dispose();
  h.controller.leave();
  delayed.release(); await saving;
  assert.equal(h.count('save'), 0);
  assert.deepEqual(h.rows(), []);
});

for (const leaveMode of ['leave', 'dispose']) {
  test(`已经提交的 save 在 ${leaveMode} 后仍返回真实成功；不重复写或恢复旧 ready`, async (t) => {
    const h = await harness(t);
    await h.ready('B'); const f2 = await h.f2();
    const delayed = h.hold('save');
    const saving = f2.options.onCompute('100.00');
    await delayed.started;
    assert.equal((await h.controller.commands.import()).status, 'blocked');
    assert.equal((await f2.options.onCompute('200.00')).status, 'blocked');
    assert.equal(h.controller.leave().status, 'blocked');
    assert.equal(h.host.openRoot(() => h.dom.createDialog(), { owner: 'other' }).status, 'blocked');
    if (leaveMode === 'dispose') h.controller.dispose();
    else {
      h.host.getHandle(f2.overlay).dispose();
      assert.equal(h.controller.leave().status, 'left');
      await h.controller.enter();
    }
    const hiddenFeedback = h.status();
    delayed.release();
    assert.deepEqual(await saving, { status: 'success', endOp: '1000.00' });
    assert.equal(h.count('save'), 1);
    assert.equal(h.rows().length, 1);
    if (leaveMode === 'dispose') assert.equal(h.status(), hiddenFeedback);
    else {
      assert.equal(h.node('RunBtn').disabled, true);
      assert.equal(h.node('ShowBalanceBtn').disabled, false);
      assert.match(h.status(), /2026-08.*已保存/);
    }
  });
}

test('后端期初校验失败允许原来源重试，不在 Renderer 做金额运算或伪造成功', async (t) => {
  const h = await harness(t);
  await h.ready(); const f2 = await h.f2();
  const rejected = await f2.options.onCompute('not-money');
  assert.equal(rejected.status, 'error');
  assert.match(rejected.message, /期初OP 无效/);
  assert.deepEqual(h.rows(), []);
  assert.equal(h.node('RunBtn').disabled, false);
  const saved = await f2.options.onCompute('-10.01');
  assert.deepEqual(saved, { status: 'success', endOp: '-0.01' });
  assert.deepEqual(h.rows(), [{ year_month: '2026-07', begin_op: '-10.01', total_amount: '10.00', end_op: '-0.01' }]);
});

test('F1 确认前 Main 换成同月同金额的 C，不能把 C 当作所选 A 确认', async (t) => {
  const h = await harness(t);
  await h.import('A');
  await h.session.streamScanAndCompute([h.files.C]);
  await h.confirm();
  assert.equal(h.node('RunBtn').disabled, true);
  assert.match(h.status(), /统计失败.*来源已变化/);
  assert.equal(h.count('save'), 0);
});

test('已确认来源在 enter 核对期间再次 A/B/A，旧核对结束后当前访问恢复按钮', async (t) => {
  const h = await harness(t);
  await h.ready(); h.controller.leave();
  const delayed = h.hold('computeAmounts');
  const oldEntry = h.controller.enter();
  await delayed.started;
  h.controller.leave(); await h.controller.enter();
  assert.equal(h.node('RunBtn').disabled, true);
  delayed.release();
  assert.equal((await oldEntry).status, 'stale');
  assert.equal(h.node('RunBtn').disabled, false);
  assert.equal(h.node('ImportBtn').disabled, false);
  assert.match(h.status(), /2026-07/);
});

test('后台整批拒绝保留错误行与总数，重入显示失败而非原有就绪', async (t) => {
  const h = await harness(t);
  await h.ready();
  const delayed = h.hold('scan');
  const importing = h.import('D');
  await delayed.started; h.controller.leave();
  delayed.release(); await importing;
  await h.controller.enter();
  assert.equal(h.node('RunBtn').disabled, true);
  assert.equal(h.views.at(-1).name, 'alert');
  assert.match(h.views.at(-1).options.message, /共 1 处异常/);
  assert.match(h.views.at(-1).options.message, /D.xlsx.*第 2 行/);
  assert.equal(h.count('save'), 0);
});

for (const outcome of ['error', 'cancelled']) {
  test(`保存 ${outcome} 在离页后保留最终结算，不保留虚假运行中或自动重试写`, async (t) => {
    const h = await harness(t);
    await h.ready(); const f2 = await h.f2();
    const submitted = deferred();
    const response = deferred();
    h.controls.save = async () => { submitted.resolve(); return response.promise; };
    const saving = f2.options.onCompute('100.00');
    await submitted.promise;
    h.host.getHandle(f2.overlay).dispose(); h.controller.leave();
    response.resolve({ status: outcome, message: outcome === 'error' ? '合成保存失败' : '已取消保存' });
    const result = await saving;
    assert.equal(result.status, outcome);
    await h.controller.enter();
    assert.match(h.status(), outcome === 'error' ? /合成保存失败/ : /已取消保存/);
    assert.equal(h.count('save'), 1);
    assert.deepEqual(h.rows(), []);
    assert.equal(h.node('RunBtn').disabled, false);
  });
}

test('统计取消在离页后保留取消反馈；新的多文件同月导入仍保持逐文件血缘', async (t) => {
  const h = await harness(t);
  await h.import();
  const response = deferred();
  h.controls.computeAmounts = () => response.promise;
  const computing = h.confirm();
  h.controller.leave();
  response.resolve({ status: 'cancelled' }); await computing;
  await h.controller.enter();
  assert.equal(h.node('RunBtn').disabled, true);
  assert.match(h.status(), /已取消统计/);
  delete h.controls.computeAmounts;
  h.controls.pickFiles = async () => ({ status: 'success', filePaths: [h.files.C, h.files.A] });
  await h.import();
  assert.equal(h.views.at(-1).options.fileCount, 2);
  await h.confirm();
  const f2 = await h.f2();
  assert.equal(f2.options.totals.totalAmount, '20.00');
  await f2.options.onCompute('-0.01');
  const files = h.db.prepare('SELECT file_name FROM vcc_op_calc_run_files ORDER BY id').all().map((row) => row.file_name);
  assert.deepEqual(files, ['C.xlsx', 'A.xlsx']);
  assert.deepEqual(h.rows(), [{ year_month: '2026-07', begin_op: '-0.01', total_amount: '20.00', end_op: '19.99' }]);
});
