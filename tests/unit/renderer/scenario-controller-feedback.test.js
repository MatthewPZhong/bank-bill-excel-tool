'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMainHarness, deferred } = require('../../helpers/scenario-main-harness');
const { createScenarioCommandService } = require('../../../src/renderer/scenario-command-service');
const { createScenarioChangeRouter } = require('../../../src/renderer/scenario-change-router');
const { createSharedReconSession } = require('../../../src/renderer/shared-recon-session');
const { createBankStatementController } = require('../../../src/renderer/controllers/bank-statement');
const { createReconIdFixController } = require('../../../src/renderer/controllers/recon-id-fix');

const payload = (category, name) => ({ category, name, priority: 1, enabled: true, config: {} });
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function panel(ids) {
  const controls = Object.fromEntries(ids.map(id => [id, {
    textContent: '欢迎使用小助手', value: '', innerHTML: '', disabled: false, dataset: {},
    addEventListener() {}, removeEventListener() {}
  }]));
  return { controls, querySelector(selector) { assert.ok(controls[selector.slice(1)], `禁止域外DOM ${selector}`); return controls[selector.slice(1)]; } };
}
function fixture(t) {
  const main = createMainHarness();
  const bankId = main.database.createScenario(payload('extract-recon-id', '反馈测试银行')).id;
  const reconId = main.database.createScenario(payload('gateway-recon-id-fix', '反馈测试网关')).id;
  const bankPanel = panel(['bankStatementScenarioBtn', 'bankStatementImportBtn', 'bankStatementRunBtn', 'bankStatementExportBtn', 'bankStatementStatusBox', 'bankStatementLinkedTableBtn']);
  const reconPanel = panel(['reconIdFixBillCategorySelect', 'reconIdFixScenarioRow', 'reconIdFixManageScenariosBtn', 'reconIdFixImportBtn', 'reconIdFixScenarioSelect', 'reconIdFixRunBtn', 'reconIdFixExportBtn', 'reconIdFixStatusBox']);
  const events = [];
  const statusWrites = [];
  let router;
  const service = createScenarioCommandService({ scenariosApi: main.scenariosApi, channelsApi: main.channelsApi,
    writerBoundaryTrusted: false, publish(event) { events.push(event); router.route(event); } });
  const shared = createSharedReconSession({ api: main.reconApi });
  const config = { scenarios: { list: service.scenarios.list } };
  const ui = { status(element, text, tone) { statusWrites.push({ element, text, tone }); element.textContent = text; element.dataset.tone = tone; },
    reportError() {}, alert() { return {}; }, modalHost: { openRoot(factory) { factory(); return { status: 'opened' }; }, closeOwner() { return { status: 'closed' }; } } };
  const bank = createBankStatementController({ api: main.bankApi, panel: bankPanel, config, sharedReconSession: shared, ui });
  const recon = createReconIdFixController({ api: { setReconIdFixBillCategory: async () => ({ status: 'ok' }) }, panel: reconPanel, config, sharedReconSession: shared, ui });
  router = createScenarioChangeRouter({ bankStatement: bank, reconIdFix: recon, scenarioSubscribers: [() => recon.reloadScenarios({ updateStatus: false })] });
  const f = { main, service, bank, recon, bankId, reconId, config, events, statusWrites,
    bankBox: bankPanel.controls.bankStatementStatusBox, bankExport: bankPanel.controls.bankStatementExportBtn,
    reconBox: reconPanel.controls.reconIdFixStatusBox, reconExport: reconPanel.controls.reconIdFixExportBtn,
    select: reconPanel.controls.reconIdFixScenarioSelect,
    async ready() {
      await Promise.all([bank.enter(), recon.enter()]);
      main.setResults();
      await Promise.all([bank.refreshStatus(), recon.refreshStatus()]);
      await Promise.all([bank.commands.export(), recon.commands.export()]);
      assertState(f, true, true);
    }
  };
  t.after(() => { bank.dispose(); recon.dispose(); router.dispose(); service.dispose(); shared.dispose(); main.dispose(); });
  return f;
}

function domainApi(f, domain) { return domain === 'bank' ? f.main.bankApi : f.main.reconApi; }
const statusChannel = domain => domain === 'bank' ? 'bank-statement:session-status' : 'recon-id-fix:session-status';
function failStatus(api, message, reject = false) {
  api.sessionStatus = async () => {
    if (reject) throw new Error(message);
    return { status: 'failed', message };
  };
}

for (const domain of ['bank', 'recon']) {
  for (const failure of ['failed', 'reject']) {
    test(`RR02 ${domain} 可见确定失效后状态${failure}，重入ready撤回读取错误且不恢复旧导出`, async t => {
      const f = fixture(t); await f.ready();
      const api = domainApi(f, domain); const original = api.sessionStatus;
      failStatus(api, '可见失效后暂时无法读取', failure === 'reject');
      const expected = await mutations[domain + 'Create'](f); await flush();
      assert.match(f[domain + 'Box'].textContent, /可见失效后暂时无法读取/);
      api.sessionStatus = original; f[domain].leave();
      assert.equal((await f[domain].enter()).status, 'ready');
      assert.doesNotMatch(f[domain + 'Box'].textContent, /状态读取失败|已导出/);
      assertState(f, ...expected);
    });
  }
  for (const prior of ['welcome', 'export']) {
    test(`RR02 ${domain} 静默读取恢复保留原${prior}反馈，不以状态摘要覆盖`, async t => {
      const f = fixture(t);
      if (prior === 'export') await f.ready();
      else await Promise.all([f.bank.enter(), f.recon.enter()]);
      const box = f[domain + 'Box']; const before = box.textContent;
      const api = domainApi(f, domain); const original = api.sessionStatus;
      failStatus(api, '暂时无法读取');
      assert.equal(await f[domain].refreshStatus({ updateStatus: false }), false);
      assert.match(box.textContent, /暂时无法读取/);
      api.sessionStatus = original;
      assert.equal(await f[domain].refreshStatus({ updateStatus: false }), true);
      assert.equal(box.textContent, before);
      const writes = f.statusWrites.length;
      f[domain].leave(); assert.equal((await f[domain].enter()).status, 'ready');
      assert.equal(box.textContent, before);
      assert.equal(f.statusWrites.length, writes, '错误已撤回后，正常重入不重复改写反馈');
    });
  }
  test(`RR02 ${domain} 连续读取失败不丢此前成功，最新成功只撤回当前读取错误`, async t => {
    const f = fixture(t); await f.ready(); const before = f[domain + 'Box'].textContent;
    const api = domainApi(f, domain); const original = api.sessionStatus;
    for (const message of ['第一次读取失败', '第二次读取失败']) {
      failStatus(api, message); assert.equal(await f[domain].refreshStatus({ updateStatus: false }), false);
      assert.match(f[domain + 'Box'].textContent, new RegExp(message));
    }
    api.sessionStatus = original; await f[domain].refreshStatus({ updateStatus: false });
    assert.equal(f[domain + 'Box'].textContent, before);
  });
  test(`RR02 ${domain} 读取错误后较新导出结算取代旧标记，恢复不回放旧成功`, async t => {
    const f = fixture(t); await f.ready(); const api = domainApi(f, domain); const original = api.sessionStatus;
    const pending = deferred(); api.export = () => pending.promise;
    const exporting = f[domain].commands.export();
    failStatus(api, '导出在途的读取失败'); await f[domain].refreshStatus({ updateStatus: false });
    assert.match(f[domain + 'Box'].textContent, /导出在途的读取失败/);
    pending.resolve({ status: 'ok', mainFileName: 'newer-export.xlsx' }); await exporting;
    assert.match(f[domain + 'Box'].textContent, /newer-export.xlsx/);
    const writes = f.statusWrites.length;
    api.sessionStatus = original; await f[domain].refreshStatus({ updateStatus: false });
    assert.match(f[domain + 'Box'].textContent, /newer-export.xlsx/);
    assert.equal(f.statusWrites.length, writes, '旧错误已被业务反馈替代，恢复不得再次写状态框');
  });
  test(`RR02 ${domain} 其他读取错误替代session错误后，该session成功不误清其他错误`, async t => {
    const f = fixture(t); await f.ready(); const api = domainApi(f, domain); const original = api.sessionStatus;
    failStatus(api, 'session读取失败'); await f[domain].refreshStatus({ updateStatus: false });
    if (domain === 'bank') {
      f.bank.commands.selectRunMode('gateway');
      failStatus(f.main.reconApi, '较新的网关读取失败');
      await f.bank.refreshGatewayStatus();
    } else {
      f.config.scenarios.list = async () => ({ status: 'failed', message: '较新的场景读取失败' });
      await f.recon.reloadScenarios();
    }
    const newerText = f[domain + 'Box'].textContent;
    assert.match(newerText, /较新的.*读取失败/);
    const writes = f.statusWrites.length;
    api.sessionStatus = original; await f[domain].refreshStatus({ updateStatus: false });
    assert.equal(f[domain + 'Box'].textContent, newerText);
    assert.equal(f.statusWrites.length, writes);
  });
  test(`RR02 ${domain} R9重同步未命中实际结果域，读取恢复仍保留有效导出`, async t => {
    const f = fixture(t); await f.ready(); const api = domainApi(f, domain); const original = api.sessionStatus;
    const before = f[domain + 'Box'].textContent;
    failStatus(api, '不确定重同步读取失败');
    const expected = await mutations[domain === 'bank' ? 'reconResync' : 'bankResync'](f); await flush();
    assert.match(f[domain + 'Box'].textContent, /不确定重同步读取失败/);
    api.sessionStatus = original; await f[domain].refreshStatus({ updateStatus: false });
    assert.equal(f[domain + 'Box'].textContent, before);
    assertState(f, ...expected);
  });
  for (const late of ['ok', 'failed', 'reject']) {
    test(`RR02 ${domain} 快进出后旧${late}晚于有效成功，不恢复错误或覆盖当前反馈`, async t => {
      const f = fixture(t); await f.ready(); const api = domainApi(f, domain); const original = api.sessionStatus;
      const before = f[domain + 'Box'].textContent;
      failStatus(api, '重入前读取错误'); await f[domain].refreshStatus({ updateStatus: false });
      api.sessionStatus = original;
      const held = f.main.hold(statusChannel(domain));
      const oldRead = f[domain].refreshStatus({ updateStatus: false });
      f[domain].leave(); assert.equal((await f[domain].enter()).status, 'ready');
      assert.equal(f[domain + 'Box'].textContent, before);
      const writes = f.statusWrites.length;
      if (late === 'reject') held.reject(new Error('过期传输失败'));
      else held.resolve(late === 'failed' ? { status: 'failed', message: '过期读取失败' } : { status: 'ok' });
      assert.equal(await oldRead, false);
      assert.equal(f[domain + 'Box'].textContent, before);
      assert.equal(f.statusWrites.length, writes);
      assertState(f, true, true);
    });
  }
  test(`RR02 ${domain} 并行刷新较新失败不会被较旧成功撤回，之后有效成功恢复`, async t => {
    const f = fixture(t); await f.ready(); const before = f[domain + 'Box'].textContent;
    const older = f.main.hold(statusChannel(domain)); const oldRead = f[domain].refreshStatus({ updateStatus: false });
    const newer = f.main.hold(statusChannel(domain)); const newRead = f[domain].refreshStatus({ updateStatus: false });
    newer.resolve({ status: 'failed', message: '较新读取失败' }); assert.equal(await newRead, false);
    older.deliver(); assert.equal(await oldRead, false);
    assert.match(f[domain + 'Box'].textContent, /较新读取失败/);
    assert.equal(f[domain + 'Export'].disabled, true);
    await f[domain].refreshStatus({ updateStatus: false });
    assert.equal(f[domain + 'Box'].textContent, before); assertState(f, true, true);
  });
}

test('RR02 bank 读取错误被较新导入进度替代，静默恢复不覆盖进度', async t => {
  const f = fixture(t); await f.ready(); let onProgress;
  const pending = deferred(); f.main.bankApi.batchImport = () => pending.promise;
  f.main.bankApi.onImportProgress = listener => { onProgress = listener; return () => {}; };
  const importing = f.bank.commands.import(); const original = f.main.bankApi.sessionStatus;
  failStatus(f.main.bankApi, '导入在途读取失败'); await f.bank.refreshStatus({ updateStatus: false });
  onProgress({ stage: 'reading', fileIndex: 1, fileCount: 3 });
  assert.equal(f.bankBox.textContent, '正在导入第 2/3 个文件…');
  const writes = f.statusWrites.length;
  f.main.bankApi.sessionStatus = original; await f.bank.refreshStatus({ updateStatus: false });
  assert.equal(f.bankBox.textContent, '正在导入第 2/3 个文件…'); assert.equal(f.statusWrites.length, writes);
  pending.resolve({ status: 'cancelled' }); await importing;
});

test('RR02 recon 场景刷新主动更新业务反馈后，session恢复不回放旧错误前反馈', async t => {
  const f = fixture(t); await Promise.all([f.bank.enter(), f.recon.enter()]);
  const original = f.main.reconApi.sessionStatus;
  failStatus(f.main.reconApi, '场景更新前读取失败'); await f.recon.refreshStatus({ updateStatus: false });
  await f.recon.reloadScenarios({ updateStatus: true });
  assert.match(f.reconBox.textContent, /已导入/);
  const before = f.reconBox.textContent; const writes = f.statusWrites.length;
  f.main.reconApi.sessionStatus = original; await f.recon.refreshStatus({ updateStatus: false });
  assert.equal(f.reconBox.textContent, before); assert.equal(f.statusWrites.length, writes);
});
function assertState(f, bank, recon) {
  assert.deepEqual(f.main.results(), { bank, recon });
  for (const [domain, expected] of [['bank', bank], ['recon', recon]]) {
    assert.equal(f[domain + 'Export'].disabled, !expected, `${domain} 导出资格应与 Main 一致`);
    assert.equal(f[domain + 'Box'].textContent.includes('已导出'), expected, `${domain} 已导出反馈按实际失效域保留/撤回`);
  }
}

for (const operation of ['import', 'run', 'export']) {
  for (const outcome of ['ok', 'failed', 'cancelled', 'reject']) {
    test(`R03 ${operation} ${outcome} 收尾重算场景可选资格，不残留busy禁用`, async t => {
      const f = fixture(t); await f.ready();
      assert.equal(f.select.disabled, false, '有可选场景，空闲时应可选择');
      const pending = deferred();
      let calls = 0;
      f.main.reconApi[operation] = () => { calls++; return pending.promise; };
      const action = f.recon.commands[operation]();
      assert.equal(f.select.disabled, true, '命令在途不能修改场景');
      if (outcome === 'reject') pending.reject(new Error('测试传输失败'));
      else pending.resolve({ status: outcome, mainFileName: 'recon-output.xlsx', message: '测试结算' });
      await action; await flush();
      assert.equal(calls, 1);
      assert.equal(f.select.disabled, false, '命令已结算，不应继续沿用在途disabled');
    });
  }
}
for (const unavailable of ['empty', 'failed', 'category']) {
  test(`R03 ${unavailable} 无合法场景资格，busy收尾仍保持下拉禁用`, async t => {
    const f = fixture(t); await f.ready();
    const pending = deferred(); f.main.reconApi.export = () => pending.promise;
    const action = f.recon.commands.export();
    if (unavailable === 'category') {
      f.recon.applyPreviewCategory('business');
    } else {
      f.config.scenarios.list = async () => unavailable === 'empty' ? { status: 'ok', scenarios: [] } : { status: 'failed', message: '列表读取失败' };
      await f.recon.reloadScenarios();
    }
    pending.resolve({ status: 'cancelled' }); await action;
    assert.equal(f.select.disabled, true, '不能因busy结束把无选项/不匹配类别的选择框打开');
  });
}

const mutations = {
  batchDelete: async f => { assert.equal((await f.service.scenarios.batchDelete([f.bankId])).status, 'ok'); return [false, false]; },
  applyImport: async f => { assert.equal((await f.service.scenarios.applyImport(...f.main.prepareImport({ channels: [] }))).status, 'ok'); return [false, false]; },
  bankCreate: async f => { assert.equal((await f.service.scenarios.create(payload('extract-recon-id', '隐藏期新银行'))).status, 'ok'); return [false, true]; },
  reconCreate: async f => { assert.equal((await f.service.scenarios.create(payload('gateway-recon-id-fix', '隐藏期新网关'))).status, 'ok'); return [true, false]; },
  bankResync: async f => { assert.equal((await f.service.scenarios.toggleEnabled(f.bankId, false)).status, 'ok'); assert.equal(f.events.at(-1).kind, 'scenarios-resync-required'); return [false, true]; },
  reconResync: async f => { assert.equal((await f.service.scenarios.toggleEnabled(f.reconId, false)).status, 'ok'); assert.equal(f.events.at(-1).kind, 'scenarios-resync-required'); return [true, false]; },
  closed: async f => { f.service.closed(); return [true, true]; },
  failed: async f => { assert.equal((await f.service.scenarios.update(f.bankId, { priority: 9 })).status, 'failed'); return [true, true]; },
  channels: async f => { assert.equal((await f.service.channels.create({ name: '仅改渠道', ownerLocation: 'HK' })).status, 'ok'); return [true, true]; }
};
for (const hidden of ['bank', 'recon']) {
  for (const [name, mutate] of Object.entries(mutations)) {
    test(`R05 隐藏${hidden} → ${name} → enter，反馈和按钮按Main同步，未命中域保持`, async t => {
      const f = fixture(t); await f.ready();
      const oldText = f[hidden + 'Box'].textContent;
      f[hidden].leave();
      const expected = await mutate(f); await flush();
      assert.equal(f[hidden + 'Box'].textContent, oldText, '隐藏时不得直接写旧面板');
      await f[hidden].enter();
      assertState(f, ...expected);
    });
  }
  test(`R05 ${hidden}确定失效后首次重读失败，后续静默成功仍清已失效反馈`, async t => {
    const f = fixture(t); await f.ready(); f[hidden].leave();
    await mutations.batchDelete(f); await flush();
    const api = hidden === 'bank' ? f.main.bankApi : f.main.reconApi;
    const original = api.sessionStatus;
    api.sessionStatus = async () => ({ status: 'failed', message: '暂时无法读取' });
    await f[hidden].enter();
    assert.match(f[hidden + 'Box'].textContent, /暂时无法读取/);
    api.sessionStatus = original;
    await f[hidden].refreshStatus({ updateStatus: false });
    assert.doesNotMatch(f[hidden + 'Box'].textContent, /暂时无法读取|已导出/);
    assertState(f, false, false);
  });
}
