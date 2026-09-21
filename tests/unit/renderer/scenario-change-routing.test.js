'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMainHarness, deferred } = require('../../helpers/scenario-main-harness');
const { createScenarioCommandService } = require('../../../src/renderer/scenario-command-service');
const { createScenarioChangeRouter } = require('../../../src/renderer/scenario-change-router');
const { createSharedReconSession } = require('../../../src/renderer/shared-recon-session');
const { createBankStatementController } = require('../../../src/renderer/controllers/bank-statement');
const { createReconIdFixController } = require('../../../src/renderer/controllers/recon-id-fix');

class Control {
  constructor() { this.textContent = '欢迎使用小助手'; this.value = ''; this.innerHTML = ''; this.disabled = false; this.dataset = {}; this.listeners = new Map(); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
}
function panel(ids) {
  const controls = Object.fromEntries(ids.map((id) => [id, new Control()]));
  return { controls, querySelector(selector) {
    const id = selector.replace(/^#/, '');
    assert.ok(Object.hasOwn(controls, id), `控制器不得读取域外 DOM: ${selector}`);
    return controls[id];
  } };
}
const bankIds = ['bankStatementScenarioBtn', 'bankStatementImportBtn', 'bankStatementRunBtn', 'bankStatementExportBtn', 'bankStatementStatusBox', 'bankStatementLinkedTableBtn'];
const reconIds = ['reconIdFixBillCategorySelect', 'reconIdFixScenarioRow', 'reconIdFixManageScenariosBtn', 'reconIdFixImportBtn', 'reconIdFixScenarioSelect', 'reconIdFixRunBtn', 'reconIdFixExportBtn', 'reconIdFixStatusBox'];
const payload = (category, name = category) => ({ category, name, priority: 1, enabled: true, config: {} });
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture(t, { trusted = true } = {}) {
  const main = createMainHarness();
  main.database.createScenario(payload('gateway-recon-id-fix', '网关展示场景'));
  const bankPanel = panel(bankIds);
  const reconPanel = panel(reconIds);
  const events = [];
  const alerts = [];
  const confirmations = [];
  const errors = [];
  const closeCalls = [];
  let blocked = false;
  let router;
  const publish = (event) => { events.push(event); router?.route(event); };
  const commandOptions = { scenariosApi: main.scenariosApi, channelsApi: main.channelsApi, publish, writerBoundaryTrusted: trusted };
  const service = createScenarioCommandService(commandOptions);
  const shared = createSharedReconSession({ api: main.reconApi });
  const ui = {
    status(element, text, tone) { element.textContent = text; element.dataset.tone = tone; },
    reportError(error) { errors.push(error); },
    alert(message, options) { alerts.push({ message, options }); return {}; },
    confirm(options) { confirmations.push(options); return {}; },
    modalHost: {
      openRoot(factory) { if (blocked) return { status: 'blocked' }; factory(); return { status: 'opened' }; },
      closeOwner(owner, reason) { closeCalls.push({ owner, reason }); return { status: blocked ? 'blocked' : 'closed' }; }
    }
  };
  const config = { scenarios: service.scenarios, linkedTable: { rowCount: async () => ({ status: 'ok', rowCount: 0 }), import: async () => ({ status: 'cancelled' }) } };
  const bank = createBankStatementController({ api: main.bankApi, panel: bankPanel, config, sharedReconSession: shared, ui });
  const recon = createReconIdFixController({ api: { setReconIdFixBillCategory: async () => ({ status: 'ok' }) }, panel: reconPanel, config, sharedReconSession: shared, ui });
  router = createScenarioChangeRouter({ bankStatement: bank, reconIdFix: recon, scenarioSubscribers: [() => { void recon.reloadScenarios(); }] });
  const f = {
    main, service, shared, bank, recon, bankPanel, reconPanel, ui, config, events, alerts, confirmations, errors, closeCalls, commandOptions,
    block(value) { blocked = value; },
    async enter() { return Promise.all([bank.enter(), recon.enter()]); },
    async seedResults() {
      main.setResults();
      await Promise.all([bank.refreshStatus(), recon.refreshStatus()]);
      await Promise.all([bank.commands.export(), recon.commands.export()]);
      assertState(f, true, true);
    }
  };
  t.after(() => { bank.dispose(); recon.dispose(); router.dispose(); service.dispose(); shared.dispose(); main.dispose(); });
  return f;
}
function assertState(f, bank, recon) {
  assert.deepEqual(f.main.results(), { bank, recon });
  assert.equal(f.bankPanel.controls.bankStatementExportBtn.disabled, !bank, '银行导出按钮与 Main 一致');
  assert.equal(f.reconPanel.controls.reconIdFixExportBtn.disabled, !recon, 'Recon 导出按钮与 Main 一致');
  assert.equal(f.bankPanel.controls.bankStatementStatusBox.textContent.includes('已导出'), bank, '银行已导出反馈按 scope 保留/清除');
  assert.equal(f.reconPanel.controls.reconIdFixStatusBox.textContent.includes('已导出'), recon, 'Recon 已导出反馈按 scope 保留/清除');
}
const operations = {
  update: { channel: 'scenarios:update', run: (service, id) => service.scenarios.update(id, { priority: 2 }) },
  toggle: { channel: 'scenarios:toggle-enabled', run: (service, id) => service.scenarios.toggleEnabled(id, false) },
  delete: { channel: 'scenarios:delete', run: (service, id) => service.scenarios.deleteOne(id) }
};
for (const [oldCategory, newCategory] of [['gateway-recon-id-fix', 'extract-recon-id'], ['extract-recon-id', 'gateway-recon-id-fix']]) {
  for (const [name, operation] of Object.entries(operations)) {
    test(`AC19 真实 SQLite ${oldCategory} → 同 ID ${newCategory}，旧 list/get 晚到后 ${name}`, async (t) => {
      const f = fixture(t);
      await f.enter();
      const old = await f.service.scenarios.create(payload(oldCategory, '被复用记录'));
      assert.equal(old.status, 'ok');
      const oldList = f.main.hold('scenarios:list');
      const oldGet = f.main.hold('scenarios:get');
      const listRead = f.service.scenarios.list();
      const getRead = f.service.scenarios.get(old.id);
      assert.equal((await f.service.scenarios.deleteOne(old.id)).deleted, true);
      const replacement = await f.service.scenarios.create(payload(newCategory, '新实体'));
      assert.equal(replacement.id, old.id, '真实 calculateNextScenarioId 必须复用这个 ID');
      await f.service.scenarios.list();
      oldGet.deliver(); oldList.deliver();
      await Promise.all([getRead, listRead]);
      await flush();
      // 每种后续命令使用独立 fixture，执行前两域重新具备 Main 成功结果和真实控制器导出反馈。
      await f.seedResults();
      const before = f.main.calls.filter((call) => call.name === operation.channel).length;
      assert.equal((await operation.run(f.service, old.id)).status, 'ok');
      await flush();
      assert.equal(f.main.calls.filter((call) => call.name === operation.channel).length - before, 1);
      const bankChanged = newCategory === 'extract-recon-id';
      assert.deepEqual([...f.events.at(-1).invalidationScope], [bankChanged ? 'bank-statement' : 'recon-id-fix']);
      assertState(f, !bankChanged, bankChanged);
    });
  }
}
for (const category of ['extract-recon-id', 'gateway-recon-id-fix']) {
  for (const command of ['transfer', 'batchDelete']) {
    test(`完整矩阵：${category} 单类 ${command} 仍双清`, async (t) => {
      const f = fixture(t);
      await f.enter();
      const created = await f.service.scenarios.create(payload(category, '批量记录'));
      const channel = await f.service.channels.create({ name: '测试渠道', ownerLocation: 'HK' });
      await flush();
      await f.seedResults();
      const args = command === 'transfer' ? { scenarioIds: [created.id], targetChannelId: channel.channel.id } : [created.id];
      const result = await f.service.scenarios[command](args);
      assert.equal(result.status, 'ok', result.message);
      await flush();
      assertState(f, false, false);
    });
  }
}
test('默认不可信 service 的 resync 只清 Main 真正失效域，未命中域保留导出反馈', async (t) => {
  const f = fixture(t, { trusted: false });
  await f.enter();
  const created = await f.service.scenarios.create(payload('gateway-recon-id-fix', '不可信写'));
  await flush(); await f.seedResults();
  const holdBank = f.main.hold('bank-statement:session-status');
  const holdRecon = f.main.hold('recon-id-fix:session-status');
  await f.service.scenarios.update(created.id, { priority: 3 });
  assert.equal(f.events.at(-1).kind, 'scenarios-resync-required');
  assert.equal(f.bankPanel.controls.bankStatementExportBtn.disabled, true);
  assert.equal(f.reconPanel.controls.reconIdFixExportBtn.disabled, true);
  assert.match(f.bankPanel.controls.bankStatementStatusBox.textContent, /已导出/);
  holdBank.deliver(); holdRecon.deliver(); await flush();
  assertState(f, true, false);
});
test('AC20 补 get 跨另一写，get 原响应仍返回，单次 update 按 resync 拉齐真实 Main', async (t) => {
  const f = fixture(t);
  await f.enter();
  const created = await f.service.scenarios.create(payload('gateway-recon-id-fix', '补读目标'));
  // 渠道写使 category Map 为空，但不改变结果。
  await f.service.channels.create({ name: '清元数据', ownerLocation: 'HK' });
  await flush(); await f.seedResults();
  const holdGet = f.main.hold('scenarios:get');
  const before = f.main.calls.filter((call) => call.name === 'scenarios:update').length;
  const pending = f.service.scenarios.update(created.id, { priority: 2 });
  await f.service.channels.create({ name: '穿越补读', ownerLocation: 'US' });
  holdGet.deliver();
  assert.equal((await pending).status, 'ok');
  await flush();
  assert.equal(f.events.at(-1).kind, 'scenarios-resync-required');
  assert.equal(f.main.calls.filter((call) => call.name === 'scenarios:update').length - before, 1);
  assertState(f, true, false);
});
test('AC20 A/B 写响应逆序：两次真实写分别只调用一次，旧证据不恢复', async (t) => {
  const f = fixture(t);
  await f.enter();
  const created = await f.service.scenarios.create(payload('gateway-recon-id-fix', '交错目标'));
  await flush(); await f.seedResults();
  const heldA = f.main.hold('scenarios:update');
  const countA = f.main.calls.filter((call) => call.name === 'scenarios:update').length;
  const pendingA = f.service.scenarios.update(created.id, { priority: 2 });
  await flush();
  const heldB = f.main.hold('channels:create');
  const pendingB = f.service.channels.create({ name: '交错渠道', ownerLocation: 'HK' });
  heldB.deliver(); await pendingB;
  // A 已在 Main 写完、仍未向 service 结算；再次置成功结果，保证结算 resync 不会伪造失效。
  await f.seedResults();
  heldA.deliver(); await pendingA; await flush();
  assert.equal(f.events.at(-1).kind, 'scenarios-resync-required');
  assertState(f, true, true);
  assert.equal(f.main.calls.filter((call) => call.name === 'scenarios:update').length - countA, 1);
});
test('AC20 未知 invoke 结算后成功 list/get/enter/服务重建均不能恢复分类信任', async (t) => {
  const f = fixture(t);
  await f.enter();
  const created = await f.service.scenarios.create(payload('gateway-recon-id-fix', '未知目标'));
  const hold = f.main.hold('scenarios:update');
  const rejected = f.service.scenarios.update(created.id, { priority: 2 });
  await flush();
  hold.reject(new Error('响应通道断开'));
  await assert.rejects(rejected, /响应通道断开/);
  await flush();
  await f.service.scenarios.list(); await f.service.scenarios.get(created.id);
  f.bank.leave(); f.recon.leave(); await f.enter();
  await f.seedResults();
  await f.service.scenarios.toggleEnabled(created.id, false); await flush();
  assert.equal(f.events.at(-1).kind, 'scenarios-resync-required');
  assertState(f, true, false);
  const replacement = createScenarioCommandService({ ...f.commandOptions, writerBoundaryTrusted: true });
  t.after(() => replacement.dispose());
  await replacement.scenarios.list(); await replacement.scenarios.get(created.id);
  await f.seedResults();
  await replacement.scenarios.update(created.id, { priority: 3 }); await flush();
  assert.equal(f.events.at(-1).kind, 'scenarios-resync-required');
  assertState(f, true, false);
});
test('渠道 create/update/delete 及无变更关闭不触碰两域结果、按钮、导出反馈', async (t) => {
  const f = fixture(t);
  await f.enter(); await f.seedResults();
  const created = await f.service.channels.create({ name: '渠道草稿', ownerLocation: 'HK' });
  assert.equal(created.status, 'ok'); await flush(); assertState(f, true, true);
  await f.service.channels.update(created.channel.id, { name: '更新渠道' }); await flush(); assertState(f, true, true);
  await f.service.channels.deleteOne(created.channel.id); await flush(); assertState(f, true, true);
  f.service.closed(); await flush(); assertState(f, true, true);
});
test('deleted:false、明确写失败不广播成功失效，保留两域反馈', async (t) => {
  const f = fixture(t);
  await f.enter(); await f.seedResults();
  assert.equal((await f.service.scenarios.deleteOne(99999)).deleted, false);
  await flush(); assertState(f, true, true);
  assert.equal((await f.service.scenarios.update(99999, { name: '不存在' })).status, 'failed');
  await flush(); assertState(f, true, true);
});
test('控制器 leave blocked 不变更代次；允许离页后旧状态响应不能覆盖 A/B/A 的新结果', async (t) => {
  const f = fixture(t);
  await f.enter(); await f.seedResults();
  f.block(true);
  assert.equal(f.recon.leave().status, 'blocked');
  assertState(f, true, true);
  f.block(false);
  const held = f.main.hold('recon-id-fix:session-status');
  const oldRead = f.recon.refreshStatus();
  f.recon.leave();
  f.main.setResults(true, false);
  await f.recon.enter();
  held.deliver(); await oldRead;
  assertState(f, true, false);
});
test('共享 run 失败通知仍重读 Main，银行普通结果与导出反馈保持', async (t) => {
  const f = fixture(t);
  await f.enter(); await f.seedResults();
  f.main.reconApi.run = async () => { f.main.setResults(true, false); return { status: 'failed', message: 'Main 已撤回旧结果' }; };
  await f.shared.run({ scenarioId: 1, originModuleId: 'bank-statement-process' });
  await flush();
  assertState(f, true, false);
});
test('导出请求在途收到确定失效，晚到成功不能恢复旧反馈', async (t) => {
  const f = fixture(t);
  await f.enter(); await f.seedResults();
  const pending = deferred();
  f.main.reconApi.export = () => pending.promise;
  const output = f.recon.commands.export();
  await f.service.scenarios.create(payload('gateway-recon-id-fix', '撤回导出'));
  pending.resolve({ status: 'ok', mainFileName: 'old.xlsx' });
  await output; await flush();
  assertState(f, true, false);
});
test('离页后的在途导入不写 UI、不弹告警，dispose 重复调用只清一次订阅', async (t) => {
  const f = fixture(t);
  await f.enter();
  const pending = deferred();
  f.main.reconApi.import = () => pending.promise;
  const importing = f.recon.commands.import();
  f.recon.leave();
  const oldText = f.reconPanel.controls.reconIdFixStatusBox.textContent;
  pending.resolve({ status: 'invalid', message: '晚到错误' });
  await importing;
  assert.equal(f.alerts.length, 0);
  assert.equal(f.reconPanel.controls.reconIdFixStatusBox.textContent, oldText);
  f.recon.dispose(); f.recon.dispose();
  for (const control of Object.values(f.reconPanel.controls)) for (const listeners of control.listeners.values()) assert.equal(listeners.size, 0);
  assert.equal(f.closeCalls.filter((call) => call.owner === 'recon-id-fix' && call.reason === 'dispose').length, 1);
});
for (const interleave of ['delete/create', 'applyImport']) {
  test(`AC20 补读期间 ${interleave}，旧合法类别 get 晚到不得成为确定 scope`, async (t) => {
    const f = fixture(t);
    await f.enter();
    const created = await f.service.scenarios.create(payload('gateway-recon-id-fix', '补读旧实体'));
    await f.service.channels.create({ name: '清空元数据', ownerLocation: 'HK' });
    const held = f.main.hold('scenarios:get');
    const before = f.main.calls.filter((call) => call.name === 'scenarios:update').length;
    const pending = f.service.scenarios.update(created.id, { priority: 3 });
    assert.equal(held.result.scenario.category, 'gateway-recon-id-fix');
    if (interleave === 'delete/create') {
      await f.service.scenarios.deleteOne(created.id);
      const replacement = await f.service.scenarios.create(payload('extract-recon-id', '补读后的普通新实体'));
      assert.equal(replacement.id, created.id);
    } else {
      const imported = await f.service.scenarios.applyImport(...f.main.prepareImport({ channels: [] }));
      assert.equal(imported.status, 'ok', imported.message);
      assert.equal(imported.importedCount, 0);
    }
    await flush(); await f.seedResults();
    held.deliver(); assert.equal((await pending).status, 'ok'); await flush();
    assert.equal(f.events.at(-1).kind, 'scenarios-resync-required');
    assert.equal(f.main.calls.filter((call) => call.name === 'scenarios:update').length - before, 1);
    assertState(f, interleave === 'applyImport', interleave === 'delete/create');
  });
}
test('applyImport importedCount=0 真实 Main handler 仍双清；后续单项重取类别', async (t) => {
  const f = fixture(t);
  await f.enter();
  const created = await f.service.scenarios.create(payload('gateway-recon-id-fix', '空导入后目标'));
  await flush(); await f.seedResults();
  const heldList = f.main.hold('scenarios:list');
  const imported = await f.service.scenarios.applyImport(...f.main.prepareImport({ channels: [] }));
  assert.equal(imported.status, 'ok', imported.message);
  assert.equal(imported.importedCount, 0);
  await flush(); assertState(f, false, false);
  await f.seedResults();
  const beforeGet = f.main.calls.filter((call) => call.name === 'scenarios:get').length;
  await f.service.scenarios.toggleEnabled(created.id, false);
  await flush();
  assert.equal(f.main.calls.filter((call) => call.name === 'scenarios:get').length - beforeGet, 1);
  assertState(f, true, false);
  heldList.deliver(); await flush();
});
test('适用渠道保存成功后 priority 更新失败，保留前一步银行失效且 Recon 保持', async (t) => {
  const f = fixture(t);
  await f.enter();
  const created = await f.service.scenarios.create(payload('builtin-fixed', '适用渠道目标'));
  await flush(); await f.seedResults();
  const saved = await f.service.scenarios.setApplicableChannels(created.id, []);
  assert.equal(saved.status, 'ok', saved.message);
  const failure = await f.service.scenarios.update(created.id, { priority: 9 });
  assert.equal(failure.status, 'failed');
  await flush(); assertState(f, false, true);
});
test('银行运行提醒保持退款 → C3 → 实际运行顺序，点击直接运行不吞 C3', async (t) => {
  const f = fixture(t);
  await f.enter();
  await f.service.scenarios.create(payload('builtin-fixed', '中台退款订单回填'));
  await f.service.scenarios.create(payload('gateway-recon-join', 'C3 候选'));
  await flush();
  f.main.bankApi.refundCandidateCount = async () => ({ status: 'ok', candidateCount: 1 });
  f.main.bankApi.c3CandidateCount = async () => ({ status: 'ok', candidateCount: 1 });
  let runs = 0;
  f.main.bankApi.run = async () => { runs++; f.main.setResults(true, true); return { status: 'ok' }; };
  await f.bank.commands.run();
  assert.match(f.confirmations[0].message, /退款订单/);
  assert.equal(runs, 0);
  await f.confirmations[0].onMiddle();
  assert.match(f.confirmations[1].message, /网关对账单/);
  assert.equal(runs, 0);
  await f.confirmations[1].onMiddle();
  assert.equal(runs, 1);
  assert.equal(f.bankPanel.controls.bankStatementExportBtn.disabled, false);
});
test('银行批量导入保留纯失败摘要和原导出；linked 成功撤销旧结果', async (t) => {
  const f = fixture(t);
  await f.enter(); await f.seedResults();
  f.main.bankApi.batchImport = async () => ({ status: 'ok', results: [{ status: 'invalid', fileName: 'invalid.xlsx', message: '缺列' }] });
  await f.bank.commands.import();
  assertState(f, true, true);
  assert.match(f.bankPanel.controls.bankStatementStatusBox.textContent, /失败 1 个: invalid.xlsx: 缺列/);
  f.main.bankApi.batchImport = async () => { f.main.setResults(false, true); return { status: 'ok', results: [{ status: 'ok', outcome: 'linked', tableKey: 'gateway-bill', rowCount: 2, fileName: 'gateway.xlsx' }] }; };
  await f.bank.commands.import();
  assertState(f, false, true);
  assert.match(f.bankPanel.controls.bankStatementStatusBox.textContent, /已存入[\s\S]*网关/);
});
test('银行后台写跨离页/重进后完成，从 Main 重读且进度只退订一次', async (t) => {
  const f = fixture(t);
  await f.enter(); await f.seedResults();
  const pending = deferred();
  let unsubscribes = 0;
  let progress;
  f.main.bankApi.onImportProgress = (listener) => { progress = listener; return () => { unsubscribes++; }; };
  f.main.bankApi.batchImport = () => pending.promise;
  const importing = f.bank.commands.import();
  f.bank.leave(); await f.bank.enter();
  const text = f.bankPanel.controls.bankStatementStatusBox.textContent;
  progress({ stage: 'reading', fileIndex: 0, fileCount: 2 });
  assert.equal(f.bankPanel.controls.bankStatementStatusBox.textContent, text);
  f.main.setResults(false, true);
  pending.resolve({ status: 'ok', results: [{ status: 'ok', tableKey: 'bank-statement' }] });
  await importing; await flush();
  assertState(f, false, true);
  assert.equal(unsubscribes, 1);
  f.bank.dispose(); assert.equal(unsubscribes, 1);
});
test('service dispose 后旧 list/get 交付不影响重建 service；查询成功也仅 resync', async (t) => {
  const f = fixture(t);
  await f.enter();
  const created = await f.service.scenarios.create(payload('gateway-recon-id-fix', '销毁前实体'));
  await flush();
  const heldList = f.main.hold('scenarios:list');
  const heldGet = f.main.hold('scenarios:get');
  const pending = [f.service.scenarios.list(), f.service.scenarios.get(created.id)];
  f.service.dispose();
  const replacement = createScenarioCommandService({ ...f.commandOptions, writerBoundaryTrusted: true });
  f.config.scenarios = replacement.scenarios;
  t.after(() => replacement.dispose());
  await replacement.scenarios.deleteOne(created.id);
  const current = await replacement.scenarios.create(payload('extract-recon-id', '销毁后实体'));
  assert.equal(current.id, created.id);
  await replacement.scenarios.list(); await replacement.scenarios.get(current.id);
  heldList.deliver(); heldGet.deliver(); await Promise.all(pending); await flush();
  await f.seedResults();
  const count = f.main.calls.filter((call) => call.name === 'scenarios:update').length;
  await replacement.scenarios.update(current.id, { priority: 2 }); await flush();
  assert.equal(f.events.at(-1).kind, 'scenarios-resync-required');
  assert.equal(f.main.calls.filter((call) => call.name === 'scenarios:update').length - count, 1);
  assertState(f, false, true);
});
test('create 回包期间插入渠道写不能播种；后续 toggle 补读得到实际类别', async (t) => {
  const f = fixture(t);
  await f.enter();
  const heldCreate = f.main.hold('scenarios:create');
  const creating = f.service.scenarios.create(payload('gateway-recon-id-fix', '创建交错'));
  const id = heldCreate.result.id;
  await f.service.channels.create({ name: '创建穿越', ownerLocation: 'HK' });
  const heldList = f.main.hold('scenarios:list');
  heldCreate.deliver(); await creating; await flush();
  await f.seedResults();
  const count = f.main.calls.filter((call) => call.name === 'scenarios:get').length;
  await f.service.scenarios.toggleEnabled(id, false); await flush();
  assert.equal(f.main.calls.filter((call) => call.name === 'scenarios:get').length - count, 1);
  assertState(f, true, false);
  heldList.deliver(); await flush();
});
test('batchDelete 使未删除 ID 的元数据也失效；下一单项只补读一次', async (t) => {
  const f = fixture(t);
  await f.enter();
  const keep = await f.service.scenarios.create(payload('gateway-recon-id-fix', '保留实体'));
  const remove = await f.service.scenarios.create(payload('extract-recon-id', '批量删除实体'));
  await f.service.scenarios.list();
  const heldList = f.main.hold('scenarios:list');
  await f.service.scenarios.batchDelete([remove.id]); await flush();
  await f.seedResults();
  const count = f.main.calls.filter((call) => call.name === 'scenarios:get').length;
  await f.service.scenarios.update(keep.id, { priority: 2 }); await flush();
  assert.equal(f.main.calls.filter((call) => call.name === 'scenarios:get').length - count, 1);
  assertState(f, true, false);
  heldList.deliver(); await flush();
});
test('初次 enter 保留欢迎文案；重复 enter 不重复绑定事件，状态读取失败禁用导出并报错', async (t) => {
  const f = fixture(t);
  await f.enter(); await f.enter();
  assert.equal(f.bankPanel.controls.bankStatementStatusBox.textContent, '欢迎使用小助手');
  assert.equal(f.reconPanel.controls.reconIdFixStatusBox.textContent, '欢迎使用小助手');
  for (const p of [f.bankPanel, f.reconPanel]) for (const control of Object.values(p.controls)) for (const listeners of control.listeners.values()) assert.equal(listeners.size, 1);
  await f.seedResults();
  f.main.reconApi.sessionStatus = async () => ({ status: 'failed', message: '测试读取错误' });
  assert.equal(await f.recon.refreshStatus(), false);
  assert.equal(f.reconPanel.controls.reconIdFixExportBtn.disabled, true);
  assert.match(f.reconPanel.controls.reconIdFixStatusBox.textContent, /测试读取错误/);
});
