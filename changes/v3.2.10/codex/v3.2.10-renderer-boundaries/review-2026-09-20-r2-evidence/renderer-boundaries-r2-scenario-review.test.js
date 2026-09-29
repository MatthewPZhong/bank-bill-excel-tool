const REVIEW_SOURCE_ROOT = process.env.REVIEW_SOURCE_ROOT || '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries';
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMainHarness, deferred } = require(REVIEW_SOURCE_ROOT + '/tests/helpers/scenario-main-harness');
const { createScenarioCommandService } = require(REVIEW_SOURCE_ROOT + '/src/renderer/scenario-command-service');
const { createScenarioChangeRouter } = require(REVIEW_SOURCE_ROOT + '/src/renderer/scenario-change-router');
const { createSharedReconSession } = require(REVIEW_SOURCE_ROOT + '/src/renderer/shared-recon-session');
const { createBankStatementController } = require(REVIEW_SOURCE_ROOT + '/src/renderer/controllers/bank-statement');
const { createReconIdFixController } = require(REVIEW_SOURCE_ROOT + '/src/renderer/controllers/recon-id-fix');

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

test('审查探针：Recon 一次导出后场景选择须恢复', async (t) => {
  const f=fixture(t,{trusted:false});
  await f.enter();
  assert.equal(f.reconPanel.controls.reconIdFixScenarioSelect.disabled,false);
  await f.seedResults();
  console.log('select after export',f.reconPanel.controls.reconIdFixScenarioSelect.disabled);
  assert.equal(f.reconPanel.controls.reconIdFixScenarioSelect.disabled,false);
});

for (const hidden of ['bank','recon']) {
  test(`审查探针：${hidden} 隐藏期间批删场景，返回清除旧导出反馈`, async (t) => {
    const f=fixture(t,{trusted:false});
    await f.enter();
    const created=await f.service.scenarios.create(payload('extract-recon-id','隐藏失效'));
    await flush(); await f.seedResults();
    f[hidden].leave();
    assert.equal((await f.service.scenarios.batchDelete([created.id])).status,'ok');
    await flush(); await f[hidden].enter();
    const controls=hidden==='bank'?f.bankPanel.controls:f.reconPanel.controls;
    const prefix=hidden==='bank'?'bankStatement':'reconIdFix';
    console.log(hidden,{ main:f.main.results(),disabled:controls[prefix+'ExportBtn'].disabled,text:controls[prefix+'StatusBox'].textContent});
    assertState(f,false,false);
  });
}

for(const order of ['list-first','action-first']) {
  test(`再审 R03 busy/list 交错 ${order}`,async t=>{
    const f=fixture(t,{trusted:false});await f.enter();await f.seedResults();
    const actionPending=deferred(); const listPending=deferred();
    f.main.reconApi.export=()=>actionPending.promise;
    f.config.scenarios={list:()=>listPending.promise};
    const action=f.recon.commands.export(); const reload=f.recon.reloadScenarios();
    if(order==='list-first') {
      listPending.resolve({status:'ok',scenarios:[{id:1,name:'重载场景',category:'gateway-recon-id-fix'}]});
      await reload;assert.equal(f.reconPanel.controls.reconIdFixScenarioSelect.disabled,true);
      actionPending.resolve({status:'cancelled'});await action;
    } else {
      actionPending.resolve({status:'cancelled'});await action;
      listPending.resolve({status:'ok',scenarios:[]});await reload;
    }
    assert.equal(f.reconPanel.controls.reconIdFixScenarioSelect.disabled,order==='action-first');
  });
}
for(const target of ['bank','recon']) {
  test(`再审 active ${target} 失效重读失败后重入须结束错误提示`,async t=>{
    const f=fixture(t,{trusted:false});await f.enter();await f.seedResults();
    const api=target==='bank'?f.main.bankApi:f.main.reconApi; const original=api.sessionStatus;
    api.sessionStatus=async()=>({status:'failed',message:'暂时无法读取'});
    await f.service.scenarios.create(payload(target==='bank'?'extract-recon-id':'gateway-recon-id-fix','可见失效'));await flush();
    const controls=target==='bank'?f.bankPanel.controls:f.reconPanel.controls;
    const prefix=target==='bank'?'bankStatement':'reconIdFix';
    assert.match(controls[prefix+'StatusBox'].textContent,/暂时无法读取/);
    api.sessionStatus=original;f[target].leave();
    assert.equal((await f[target].enter()).status,'ready');
    console.log('recovered',target,controls[prefix+'StatusBox'].textContent);
    assert.doesNotMatch(controls[prefix+'StatusBox'].textContent,/暂时无法读取/);
  });
}
