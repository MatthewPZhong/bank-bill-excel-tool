'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { TEMPLATE_RESOURCES } = require('../../../src/main-process/template-resources/catalog');
const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');

// 真实设置弹窗、模板文件工厂与宿主；列表数据由 Main 服务读取随包模板生成，写接口为受控替身，不读写用户文件。
module.exports = async ({ js, load, reset, assert, test, layout }) => {
  const root = path.resolve(__dirname, '../../..');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  const program = acorn.parse(renderer, { ecmaVersion: 'latest' }).body;
  const escapeHtmlNode = program.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'escapeHtml');
  const modulesNode = program.find((node) => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'MODULES');
  assert.ok(escapeHtmlNode && modulesNode, '生产 escapeHtml 与 MODULES 应存在');
  const escapeHtmlSource = renderer.slice(escapeHtmlNode.start, escapeHtmlNode.end);
  const modulesSource = renderer.slice(modulesNode.declarations[0].init.start, modulesNode.declarations[0].init.end);

  const service = createTemplateResourceService({ appRoot: root, appVersion: '3.2.11' });
  const listed = await service.list();
  const details = {};
  for (const item of listed.resources) details[item.id] = (await service.get(item.id)).resource;
  const data = JSON.stringify({ resources: listed.resources, excluded: listed.excluded, details });
  const vccCount = TEMPLATE_RESOURCES.filter((item) => item.bindings.some((binding) => binding.moduleId === 'vcc-financial-op')).length;

  async function setup({ writes = false, hold = [], layoutOptions = null, open = true } = {}) {
    await reset('<div id="modalRoot"></div>', layoutOptions ? { layout: layoutOptions } : undefined);
    await js(escapeHtmlSource + '\n;void 0;');
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await load('src/renderer/dialogs/template-files.js');
    await load('src/renderer/dialogs/app-settings.js');
    await js(`
      window.FIXTURE_MODULES = ${modulesSource};
      window.tf = { calls: [], data: ${data}, hold: {}, listeners: new Set(),
        clone: (value) => JSON.parse(JSON.stringify(value)),
        defer() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; },
        saveAsResult: { status: 'success', fileName: '重复入金召回邮件模板.xlsx', filePath: '/fixture/重复入金召回邮件模板.xlsx' },
        commitResults: [], setCurrentResults: [] };
      for (const name of ${JSON.stringify(hold)}) tf.hold[name] = tf.defer();
      tf.api = {
        async list() { tf.calls.push(['list']); if (tf.hold.list) await tf.hold.list.promise;
          return tf.clone({ status: 'success', resources: tf.data.resources, excluded: tf.data.excluded }); },
        async get(id) { tf.calls.push(['get', id]); const held = tf.hold['get:' + id]; if (held) await held.promise;
          const resource = tf.data.details[id]; return resource ? { status: 'success', resource: tf.clone(resource) } : { status: 'failed', message: '模板不存在' }; },
        async saveAs(payload) { tf.calls.push(['saveAs', payload]); return tf.clone(tf.saveAsResult); }
      };
      tf.count = (name) => tf.calls.filter((call) => call[0] === name).length;
      tf.last = (name) => tf.calls.filter((call) => call[0] === name).at(-1)?.[1];
      void 0;`);
    if (writes) {
      // 后端阶段的写接口替身：重复入金召回邮件模板含用户版本、运行中任务与变更记录。
      await js(`(() => {
        const allCaps = { saveAs: true, importVersion: true, importReason: '', setCurrent: true, deleteVersion: true, restoreDefault: true };
        const detail = tf.data.details['dup-recall-mail'];
        const builtin = { ...detail.current, current: false };
        const user = (id, label, fileName, createdAt) => ({ id, label, source: 'user', current: false, fileName, size: 9300, createdAt, sha256: id.repeat(32).slice(0, 64), tasks: [] });
        const v4 = { ...user('v4', 'V4', '重复入金召回邮件模板-绿色.xlsx', '2026-10-07 09:12'), current: true };
        const v3 = user('v3', 'V3', '重复入金召回邮件模板-蓝色.xlsx', '2026-10-06 16:40');
        const v2 = { ...user('v2', 'V2', '重复入金召回邮件模板-旧版.xlsx', '2026-10-05 10:31'),
          tasks: [{ id: '2026-10-07-003', moduleId: 'duplicate-inbound-match', state: '运行中', versionId: 'v2' }] };
        Object.assign(detail, { current: v4, versions: [v4, v3, v2, builtin], tasks: v2.tasks, capabilities: allCaps });
        const item = tf.data.resources.find((resource) => resource.id === 'dup-recall-mail');
        Object.assign(item, { current: { ...v4 }, capabilities: allCaps });
        tf.pickResult = { status: 'success', filePath: '/fixture/新模板.xlsx', fileName: '新模板.xlsx', size: 9400 };
        tf.prepareResult = { status: 'success', importToken: 'token-1', expectedVersionId: 'v4', expectedVersionLabel: 'V4', expectedVersionSource: 'user',
          file: { name: '新模板.xlsx', size: 9400, sha256: 'ab'.repeat(32) }, verdict: 'pass',
          checks: [{ group: 'file', label: '表头', status: 'pass', detail: '10 列一致' },
            { group: 'usage', label: '重复入金匹配', status: 'pass', detail: '邮件模板 · 兼容' }], diff: { added: [], removed: [] } };
        Object.assign(tf.api, {
          async pickImportFile(payload) { tf.calls.push(['pick', payload]); return tf.clone(tf.pickResult); },
          async prepareImport(payload) { tf.calls.push(['prepare', payload]); return tf.clone(tf.prepareResult); },
          async discardImport(token) { tf.calls.push(['discard', token]); return { status: 'success' }; },
          async commitImport(payload) { tf.calls.push(['commit', payload]); if (tf.hold.commit) await tf.hold.commit.promise;
            return tf.commitResults.shift() || { status: 'success', enabled: payload.enable, version: { id: 'v5', label: 'V5' } }; },
          async setCurrentVersion(payload) { tf.calls.push(['setCurrent', payload]); return tf.setCurrentResults.shift() || { status: 'success' }; },
          async deleteVersion(payload) { tf.calls.push(['delete', payload]); return { status: 'success' }; },
          async listChanges() { tf.calls.push(['changes']); return { status: 'success', changes: [
            { at: '2026-10-07 09:12', resourceId: 'dup-recall-mail', resourceName: '重复入金召回邮件模板', action: '导入并启用', from: 'V3', to: 'V4', result: 'success' },
            { at: '2026-10-05 10:31', resourceId: 'fund-type-enum', resourceName: 'FundType枚举值', action: '恢复默认', from: 'V2', to: 'V1', result: 'success' }] }; },
          onChanged(listener) { tf.calls.push(['subscribe']); tf.listeners.add(listener);
            return () => { tf.calls.push(['unsubscribe']); tf.listeners.delete(listener); }; }
        });
      })(); void 0;`);
    }
    await js(`
      tf.bridge = window.__rendererModalBridge;
      tf.host = window.__rendererModalHost;
      tf.dialogs = window.__createTestRendererDialogs({ modalBridge: tf.bridge, state: {}, elements: {}, desktopApi: {}, appConstants: {} });
      tf.templateFiles = window.__templateFilesDialogs.createTemplateFilesDialogs({
        api: { templateResources: tf.api }, modalBridge: tf.bridge, modules: FIXTURE_MODULES,
        ui: { escapeHtml, createConfirmDialog: tf.dialogs.createConfirmDialog } });
      tf.settings = window.__appSettingsDialogs.createAppSettingsDialogs({
        api: {}, modalBridge: tf.bridge, modules: FIXTURE_MODULES,
        ui: { escapeHtml, createConfirmDialog: tf.dialogs.createConfirmDialog,
          getDarkModeController: () => null, mountAppearanceSettings: () => null,
          mountTemplateFiles: (pane, options) => tf.templateFiles.mountTemplateFiles(pane, options),
          applyAppUpdateActionResult() {}, applyAppUpdateStatus() {}, getAppUpdateStatus: () => ({}),
          refreshOpenAppUpdateDialog() {}, restartAndInstallAppUpdate() {} } });
      tf.open = () => { tf.handle = tf.bridge.openModal(() => (tf.overlay = tf.settings.createAppUpdateSettingsDialog())).handle; };
      tf.q = (selector) => tf.overlay.querySelector(selector);
      tf.top = () => document.getElementById('modalRoot').lastElementChild;
      tf.text = (selector) => (tf.q(selector)?.textContent || '').replace(/\\s+/g, ' ').trim();
      tf.detailTitle = () => tf.text('.template-center-detail-heading h4');
      // 存档中心也有同名筛选控件，筛选操作限定在模板文件面板内。
      tf.select = (selector, value) => { const element = tf.q('[data-pane="templates"] ' + selector); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
      tf.search = (value) => { const input = tf.q('[data-pane="templates"] [data-filter="query"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
      void 0;`);
    if (open) {
      await js('tf.open(); tf.q(\'[data-tab="templates"]\').click(); void 0;');
      if (!hold.includes('list')) await waitFor('tf.q(\'[data-role="template-count"]\').textContent === "39 个" && !!tf.q(".template-center-detail-heading")', '模板列表与详情加载');
    }
  }

  async function waitFor(expression, description = expression) {
    return js(`new Promise((resolve, reject) => {
      const until = Date.now() + 3000;
      const check = () => {
        try { if (${expression}) return resolve(true); } catch (error) { return reject(error); }
        if (Date.now() > until) return reject(new Error('等待条件超时：' + ${JSON.stringify(description)}));
        setTimeout(check, 20);
      };
      check();
    })`);
  }
  const settle = () => js('new Promise((resolve) => setTimeout(resolve, 30))');
  async function selectResource(id) {
    await js(`tf.q('[data-resource-id="${id}"]').click(); void 0;`);
    await waitFor(`tf.q('.template-center-item.is-active')?.dataset.resourceId === '${id}' && tf.detailTitle() === tf.data.details['${id}'].name`, `选中 ${id}`);
  }
  async function openTab(tab) {
    await js(`tf.q('[data-detail-tab="${tab}"]').click(); void 0;`);
  }

  await test('模板文件位于存档中心与外观设置之间，首次进入才加载且切换标签不重复读取', async () => {
    await setup({ open: false });
    await js('tf.open(); void 0;');
    assert.deepEqual(await js(`[...tf.overlay.querySelectorAll('.app-settings-nav-item')].map((item) => item.querySelector('span:not(.app-settings-nav-icon)').textContent)`),
      ['版本管理', '存档中心', '模板文件', '外观设置']);
    assert.deepEqual(await js(`[...tf.overlay.querySelectorAll('.app-settings-nav-item')].map((item) => item.dataset.tab)`),
      ['update', 'archive', 'templates', 'appearance']);
    assert.equal(await js('tf.count("list")'), 0);
    await js(`tf.q('[data-tab="templates"]').click(); void 0;`);
    await waitFor('tf.q(\'[data-role="template-count"]\').textContent === "39 个" && !!tf.q(".template-center-detail-heading")');
    assert.equal(await js(`tf.q('[data-pane="templates"]').hidden`), false);
    assert.equal(await js(`tf.q('[data-footer="update"]').hidden`), true);
    assert.equal(await js(`tf.q('.template-center-item.is-active')?.dataset.resourceId === tf.last('get')`), true);
    await js(`tf.q('[data-tab="appearance"]').click(); tf.q('[data-tab="templates"]').click(); void 0;`);
    await settle();
    assert.equal(await js('tf.count("list")'), 1);
    assert.equal(await js(`!!tf.q('[data-action="open-history"]')`), false, '只读接口不显示变更记录入口');
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('筛选只提供实际存在的选项；搜索字段时命中模板并高亮字段', async () => {
    await setup();
    assert.deepEqual(await js(`[...tf.q('[data-pane="templates"] [data-filter="status"]').options].map((option) => option.value)`),
      ['', 'runtime', 'cached', 'locked', 'disabled', 'sample', 'generated', 'reference']);
    await js(`tf.select('[data-filter="type"]', 'enum'); void 0;`);
    await waitFor(`tf.text('[data-role="template-count"]') === '1 个' && tf.detailTitle() === 'FundType枚举值'`);
    assert.equal(await js(`tf.q('[data-detail-tab="fields"]').textContent.trim()`), '枚举值');
    await js(`tf.select('[data-filter="type"]', ''); tf.select('[data-filter="module"]', 'vcc-financial-op'); void 0;`);
    await waitFor(`tf.text('[data-role="template-count"]') === '${vccCount} 个'`);
    await js(`tf.select('[data-filter="module"]', ''); tf.search('Merchant_status'); void 0;`);
    await waitFor(`!!tf.q('.template-center-tab-panel mark')`, '字段命中高亮');
    assert.equal(await js(`tf.q('.template-center-tab-panel mark').textContent.toLowerCase()`), 'merchant_status');
    assert.equal(await js(`[...tf.overlay.querySelectorAll('.template-center-item')].some((item) => item.dataset.resourceId === 'gateway-recon')`), true);
    await js(`tf.search(''); void 0;`);
    await waitFor(`tf.text('[data-role="template-count"]') === '39 个'`);
  });

  await test('详情四个标签展示后端结构；未开放的导入按能力置灰并说明原因', async () => {
    await setup();
    await selectResource('dup-recall-mail');
    assert.deepEqual(await js(`({ disabled: tf.q('[data-action="import"]').disabled, title: tf.q('[data-action="import"]').title,
      restore: !!tf.q('[data-action="restore-default"]'), meta: tf.text('.template-center-metadata') })`),
    { disabled: true, title: '版本存储不可用', restore: false, meta: '读取方式运行时读取 当前版本V1 · 内置 使用模块重复入金匹配 更新时间随 v3.2.11' });
    await openTab('versions');
    assert.deepEqual(await js(`[...tf.overlay.querySelectorAll('.template-center-tab-panel tbody tr')].map((row) => ({
      label: row.cells[0].textContent.replace(/\\s+/g, ''), status: row.cells[3].textContent.trim(),
      actions: [...row.querySelectorAll('[data-action]')].map((button) => button.dataset.action) }))`),
    [{ label: 'V1内置', status: '当前', actions: ['save-as'] }]);
    assert.equal(await js(`tf.text('.template-center-tab-panel .template-center-note')`), '版本存储不可用');
    await selectResource('vcc-result-template');
    assert.equal(await js(`tf.q('[data-action="import"]').title`), '文件受 SHA-256 锁定，需随应用版本更新');
    await openTab('info');
    assert.equal(await js(`tf.overlay.querySelector('.template-center-kv').textContent.includes(tf.data.details['vcc-result-template'].current.sha256)`), true);
    await selectResource('bank-statement');
    await openTab('usage');
    assert.deepEqual(await js(`[...tf.overlay.querySelectorAll('.template-center-tab-panel tbody tr')].map((row) => [row.cells[2].textContent.trim(), row.cells[3].textContent.trim()])`),
      [['运行时读取', 'V1 · 内置'], ['不读取', '—'], ['不读取', '—']]);
    await selectResource('fx-option');
    await openTab('info');
    await js(`tf.q('.template-center-kv [data-action="goto"]').click(); void 0;`);
    await waitFor(`tf.q('.template-center-item.is-active')?.dataset.resourceId === 'fx-option-order' && tf.detailTitle() === '外汇期权订单'`, '内容相同的模板跳转');
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('另存为传递资源与版本；成功、取消、失败分别反馈', async () => {
    await setup();
    await selectResource('dup-recall-mail');
    await js(`tf.q('.template-center-detail-actions [data-action="save-as"]').click(); void 0;`);
    await waitFor(`!tf.q('[data-role="template-feedback"]').hidden`);
    assert.deepEqual(await js('tf.last("saveAs")'), { resourceId: 'dup-recall-mail', versionId: 'v1' });
    assert.deepEqual(await js(`({ text: tf.text('[data-role="template-feedback"]'), tone: tf.q('[data-role="template-feedback"]').dataset.tone })`),
      { text: '已另存为「重复入金召回邮件模板.xlsx」', tone: 'success' });
    await js(`tf.saveAsResult = { status: 'cancelled' }; tf.q('.template-center-detail-actions [data-action="save-as"]').click(); void 0;`);
    await waitFor('tf.count("saveAs") === 2 && !tf.q(\'.template-center-detail-actions [data-action="save-as"]\').disabled');
    assert.equal(await js(`tf.q('[data-role="template-feedback"]').hidden`), true);
    await js(`tf.saveAsResult = { status: 'failed', message: '磁盘已满' }; tf.q('.template-center-detail-actions [data-action="save-as"]').click(); void 0;`);
    await waitFor(`tf.text('[data-role="template-feedback"]') === '另存为失败：磁盘已满'`);
    assert.equal(await js(`tf.q('[data-role="template-feedback"]').dataset.tone`), 'error');
  });

  await test('未纳入文件以子弹窗压在设置之上，Esc 只关闭子弹窗', async () => {
    await setup();
    await js(`tf.q('[data-action="show-excluded"]').click(); void 0;`);
    assert.equal(await js('tf.host.getTop() !== tf.handle && tf.handle.isOpen()'), true);
    assert.deepEqual(await js(`[...tf.top().querySelectorAll('.template-excluded-list li')].map((item) => [item.querySelector('strong').textContent, item.querySelector('span').textContent])`), [
      ['COMMON枚举.xlsx', '网银账单生成'],
      ['余额账单模版.xlsx', '网银账单生成、新开账户余额账单生成'],
      ['币种映射表.xlsx', '网银账单生成']
    ]);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); void 0;`);
    assert.equal(await js('tf.host.getTop() === tf.handle'), true);
  });

  await test('关闭后晚到的列表不写入；连续切换模板时旧详情不覆盖新详情', async () => {
    await setup({ hold: ['list'] });
    await js(`tf.handle.close({ status: 'cancelled', reason: 'cancel' }); tf.hold.list.resolve(); void 0;`);
    await settle();
    assert.equal(await js('tf.overlay.isConnected'), false);
    assert.equal(await js('tf.count("get")'), 0);
    assert.deepEqual(await js('__testErrors'), []);

    await setup({ hold: ['get:pending'] });
    await js(`tf.q('[data-resource-id="pending"]').click(); tf.q('[data-resource-id="biz-op-bill"]').click(); void 0;`);
    await waitFor(`tf.detailTitle() === '业务OP账单'`);
    await js(`tf.hold['get:pending'].resolve(); void 0;`);
    await settle();
    assert.equal(await js('tf.detailTitle()'), '业务OP账单');
  });

  await test('列表返回前输入搜索：保持加载提示，返回后首个命中模板定位到命中的工作表', async () => {
    await setup({ hold: ['list'] });
    await js(`tf.search('网关-清算网络'); void 0;`);
    // 越过 160ms 搜索防抖，确认筛选已执行。
    await js('new Promise((resolve) => setTimeout(resolve, 250))');
    assert.equal(await js(`tf.text('[data-role="template-list"]')`), '正在加载模板…');
    await js('tf.hold.list.resolve(); void 0;');
    await waitFor(`tf.detailTitle() === '资金对账导出不平'`, '首个命中模板');
    assert.deepEqual(await js(`({ selected: tf.q('.template-center-item.is-active')?.dataset.resourceId,
      sheet: tf.q('[data-action="select-sheet"][aria-pressed="true"]')?.textContent.split(' · ')[0],
      mark: tf.q('.template-center-tab-panel mark')?.textContent })`),
    { selected: 'prefund-unbalanced', sheet: '平账结果', mark: '网关-清算网络' });
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('导入新版本：选择、预检、保存并启用后关闭子弹窗并重读列表', async () => {
    await setup({ writes: true });
    await selectResource('dup-recall-mail');
    assert.equal(await js(`tf.q('.template-center-item.is-active .template-center-version-tag').textContent`), 'V4');
    await js(`tf.q('[data-action="import"]').click(); void 0;`);
    assert.equal(await js(`tf.top().querySelector('.template-import-target').textContent.replace(/\\s+/g, ' ').trim()`), '重复入金召回邮件模板 · 当前 V4');
    await js(`tf.top().querySelector('[data-action="choose"]').click(); void 0;`);
    await waitFor(`tf.top().querySelector('.template-import-verdict')?.dataset.tone === 'success'`, '预检完成');
    assert.deepEqual(await js('[tf.last("pick"), tf.last("prepare")]'), [{ resourceId: 'dup-recall-mail' }, { resourceId: 'dup-recall-mail', filePath: '/fixture/新模板.xlsx' }]);
    assert.deepEqual(await js(`[...tf.top().querySelectorAll('.template-import-group')].map((item) => item.textContent)`), ['文件检查', '使用方']);
    const listsBefore = await js('tf.count("list")');
    await js(`tf.top().querySelector('[data-action="save-enable"]').click(); void 0;`);
    await waitFor('tf.host.getTop() === tf.handle', '导入弹窗关闭');
    assert.deepEqual(await js('tf.last("commit")'), { importToken: 'token-1', enable: true });
    assert.equal(await js(`tf.text('[data-role="template-feedback"]')`), '已启用 V5，新任务开始使用');
    await waitFor(`tf.count('list') === ${listsBefore + 1}`, '提交后重读列表');
    assert.equal(await js('tf.count("discard")'), 0, '已提交的暂存不应再放弃');
  });

  await test('提交冲突时要求重新校验；提交中不能关闭设置，关闭时放弃未提交的暂存', async () => {
    await setup({ writes: true, hold: ['commit'] });
    await selectResource('dup-recall-mail');
    await js(`tf.q('[data-action="import"]').click(); tf.top().querySelector('[data-action="choose"]').click(); void 0;`);
    await waitFor(`!tf.top().querySelector('[data-action="save-only"]').disabled`);
    await js(`tf.commitResults.push({ status: 'conflict', message: '模板已更新为 V5，请重新校验' }); tf.top().querySelector('[data-action="save-only"]').click(); void 0;`);
    await waitFor('tf.count("commit") === 1');
    assert.equal(await js(`tf.handle.close({ status: 'cancelled', reason: 'cancel' }).status`), 'blocked', '提交中不能关闭设置');
    assert.equal(await js('tf.handle.isOpen()'), true);
    await js('tf.hold.commit.resolve(); void 0;');
    await waitFor(`!!tf.top().querySelector('[data-action="recheck"]')`, '冲突提示');
    assert.equal(await js(`tf.top().querySelector('.template-import-verdict').textContent.trim()`), '模板已更新为 V5，请重新校验 重新校验');
    assert.deepEqual(await js('tf.last("discard")'), 'token-1');
    await js(`tf.top().querySelector('[data-action="recheck"]').click(); void 0;`);
    await waitFor(`tf.count('prepare') === 2 && !tf.top().querySelector('[data-action="save-only"]').disabled`);
    assert.deepEqual(await js('tf.last("prepare")'), { resourceId: 'dup-recall-mail', filePath: '/fixture/新模板.xlsx' });
    await js(`tf.top().querySelector('[data-action="close"]').click(); void 0;`);
    await settle();
    assert.equal(await js('tf.host.getTop() === tf.handle'), true);
    assert.equal(await js('tf.count("discard")'), 2, '关闭后放弃重新校验得到的暂存');
  });

  await test('启用与恢复默认用主操作确认，冲突在原框提示；被任务固定的版本不能删除', async () => {
    await setup({ writes: true });
    await selectResource('dup-recall-mail');
    await openTab('versions');
    assert.deepEqual(await js(`[...tf.overlay.querySelectorAll('.template-center-tab-panel tbody tr')].map((row) => ({
      label: row.cells[0].querySelector('strong').textContent, status: row.cells[3].textContent.replace(/\\s+/g, ''),
      remove: row.querySelector('[data-action="delete-version"]') ? { disabled: row.querySelector('[data-action="delete-version"]').disabled, title: row.querySelector('[data-action="delete-version"]').title } : null }))`), [
      { label: 'V4', status: '当前', remove: { disabled: true, title: '当前版本不能删除' } },
      { label: 'V3', status: '可启用', remove: { disabled: false, title: '删除 V3' } },
      { label: 'V2', status: '任务使用中1个任务', remove: { disabled: true, title: '1 个任务正在使用' } },
      { label: 'V1', status: '默认', remove: null }
    ]);
    await js(`tf.setCurrentResults.push({ status: 'conflict', message: '模板已更新为 V6，请确认后重试' });
      tf.q('[data-action="set-current"][data-version-id="v3"]').click(); void 0;`);
    assert.equal(await js(`tf.top().querySelector('[data-action="confirm"]').className`), 'primary-btn small');
    const listsBefore = await js('tf.count("list")');
    await js(`tf.top().querySelector('[data-action="confirm"]').click(); void 0;`);
    await waitFor(`!!tf.top().querySelector('.template-confirm-error')`, '冲突提示');
    assert.equal(await js(`tf.top().querySelector('.template-confirm-error').textContent`), '模板已更新为 V6，请确认后重试');
    assert.deepEqual(await js('tf.last("setCurrent")'), { resourceId: 'dup-recall-mail', versionId: 'v3', expectedVersionId: 'v4' });
    await waitFor(`tf.count('list') === ${listsBefore + 1}`, '冲突后重读列表');
    await js(`tf.top().querySelector('[data-action="confirm"]').click(); void 0;`);
    await waitFor('tf.host.getTop() === tf.handle');
    assert.equal(await js(`tf.text('[data-role="template-feedback"]')`), '已启用 V3');

    await js(`tf.q('[data-action="restore-default"]').click(); void 0;`);
    assert.match(await js(`tf.top().querySelector('.alert-message').textContent`), /恢复为内置版本/);
    await js(`tf.top().querySelector('[data-action="confirm"]').click(); void 0;`);
    await waitFor('tf.host.getTop() === tf.handle');
    assert.deepEqual(await js('tf.last("setCurrent")'), { resourceId: 'dup-recall-mail', versionId: 'v1', expectedVersionId: 'v4' });

    await openTab('versions');
    await js(`tf.q('[data-action="delete-version"][data-version-id="v3"]').click(); void 0;`);
    assert.equal(await js(`tf.top().querySelector('[data-action="confirm"]').className`), 'danger-btn small');
    await js(`tf.top().querySelector('[data-action="confirm"]').click(); void 0;`);
    await waitFor('tf.host.getTop() === tf.handle');
    assert.deepEqual(await js('tf.last("delete")'), { resourceId: 'dup-recall-mail', versionId: 'v3' });
    assert.equal(await js(`tf.text('[data-role="template-feedback"]')`), '已删除 V3');
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('不兼容的用户版本：列表标签与版本行标出原因、不能启用；当前版本不兼容时详情顶部提示（浅色/深色）', async () => {
    for (const theme of ['light', 'dark']) {
    // 加载生产样式，核对标签在两种主题下都使用危险色。
    await setup({ writes: true, open: false, layoutOptions: { width: 1080, height: 760, theme } });
    await js(`(() => {
      const detail = tf.data.details['dup-recall-mail'];
      const v3 = detail.versions.find((version) => version.id === 'v3');
      Object.assign(v3, { validation: 'failed', validationMessage: '与本版程序不兼容：表头：邮件模板表头不符合约定' });
      const v4 = detail.versions.find((version) => version.id === 'v4');
      Object.assign(v4, { validation: 'failed', validationMessage: '版本文件已被修改（SHA-256 不一致）' });
      Object.assign(detail.current, { validation: 'failed', validationMessage: '版本文件已被修改（SHA-256 不一致）' });
      const item = tf.data.resources.find((resource) => resource.id === 'dup-recall-mail');
      Object.assign(item.current, { validation: 'failed', validationMessage: '版本文件已被修改（SHA-256 不一致）' });
    })(); tf.open(); tf.q('[data-tab="templates"]').click(); void 0;`);
    await waitFor('tf.q(\'[data-role="template-count"]\').textContent === "39 个" && !!tf.q(".template-center-detail-heading")', '模板列表与详情加载');
    const tag = (id) => js(`(() => { const element = tf.q('[data-resource-id="${id}"] .template-center-version-tag');
      return { text: element.textContent, state: element.dataset.state || '', title: element.title, color: getComputedStyle(element).color }; })()`);
    const dangerColor = await js(`(() => { const probe = document.createElement('span'); probe.style.color = 'var(--danger)';
      document.body.appendChild(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`);
    const incompatibleTag = await tag('dup-recall-mail');
    const builtinTag = await tag('fund-type-enum');
    assert.deepEqual({ text: incompatibleTag.text, state: incompatibleTag.state, title: incompatibleTag.title },
      { text: 'V4 · 不兼容', state: 'failed', title: '版本文件已被修改（SHA-256 不一致）' });
    assert.deepEqual({ text: builtinTag.text, state: builtinTag.state }, { text: '内置', state: '' });
    assert.equal(incompatibleTag.color, dangerColor, `${theme}：不兼容标签使用危险色`);
    assert.notEqual(builtinTag.color, dangerColor, `${theme}：内置标签不使用危险色`);
    await selectResource('dup-recall-mail');
    assert.equal(await tag('dup-recall-mail').then((value) => value.state), 'failed', '选中后仍保留不兼容标记');
    assert.equal(await js(`tf.text('.template-center-inline-alert')`),
      '当前版本 V4 不可用：版本文件已被修改（SHA-256 不一致）。相关导出会中止，请恢复默认或导入兼容的新版本。');
    await openTab('versions');
    assert.deepEqual(await js(`[...tf.overlay.querySelectorAll('.template-center-tab-panel tbody tr')].slice(0, 2).map((row) => ({
      status: row.cells[3].textContent.replace(/\\s+/g, ''), title: row.cells[3].querySelector('.template-center-status').title,
      enable: row.querySelector('[data-action="set-current"]') ? { disabled: row.querySelector('[data-action="set-current"]').disabled, title: row.querySelector('[data-action="set-current"]').title } : null }))`), [
      { status: '当前·不兼容', title: '版本文件已被修改（SHA-256 不一致）', enable: null },
      { status: '不兼容', title: '与本版程序不兼容：表头：邮件模板表头不符合约定', enable: { disabled: true, title: '与本版程序不兼容：表头：邮件模板表头不符合约定' } }
    ]);
    assert.deepEqual(await js('__testErrors'), []);
    }
  });

  await test('复核未完成的用户版本：标为暂不可用（警示色），提示稍后重试，仍可点启用重试（浅色/深色）', async () => {
    for (const theme of ['light', 'dark']) {
    await setup({ writes: true, open: false, layoutOptions: { width: 1080, height: 760, theme } });
    await js(`(() => {
      const message = '兼容复核未完成：样式：运行环境异常（ENOSPC: no space left on device），未能完成检查，请稍后重试';
      const detail = tf.data.details['dup-recall-mail'];
      const v3 = detail.versions.find((version) => version.id === 'v3');
      Object.assign(v3, { validation: 'unverified', validationMessage: message });
      const v4 = detail.versions.find((version) => version.id === 'v4');
      Object.assign(v4, { validation: 'unverified', validationMessage: message });
      Object.assign(detail.current, { validation: 'unverified', validationMessage: message });
      const item = tf.data.resources.find((resource) => resource.id === 'dup-recall-mail');
      Object.assign(item.current, { validation: 'unverified', validationMessage: message });
    })(); tf.open(); tf.q('[data-tab="templates"]').click(); void 0;`);
    await waitFor('tf.q(\'[data-role="template-count"]\').textContent === "39 个" && !!tf.q(".template-center-detail-heading")', '模板列表与详情加载');
    const message = '兼容复核未完成：样式：运行环境异常（ENOSPC: no space left on device），未能完成检查，请稍后重试';
    const tag = await js(`(() => { const element = tf.q('[data-resource-id="dup-recall-mail"] .template-center-version-tag');
      return { text: element.textContent, state: element.dataset.state || '', title: element.title, color: getComputedStyle(element).color }; })()`);
    const colorOf = (value) => js(`(() => { const probe = document.createElement('span'); probe.style.color = '${value}';
      document.body.appendChild(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`);
    assert.deepEqual({ text: tag.text, state: tag.state, title: tag.title }, { text: 'V4 · 暂不可用', state: 'unverified', title: message });
    assert.equal(tag.color, await colorOf('var(--warning, #a15c00)'), `${theme}：暂不可用标签使用警示色`);
    assert.notEqual(tag.color, await colorOf('var(--danger)'), `${theme}：暂不可用不使用危险色`);
    await selectResource('dup-recall-mail');
    assert.equal(await js(`tf.text('.template-center-inline-alert')`), `当前版本 V4 暂不可用：${message}。相关导出会中止，请稍后重试。`);
    await openTab('versions');
    assert.deepEqual(await js(`[...tf.overlay.querySelectorAll('.template-center-tab-panel tbody tr')].slice(0, 2).map((row) => ({
      status: row.cells[3].textContent.replace(/\\s+/g, ''), tone: row.cells[3].querySelector('.template-center-status').dataset.tone,
      enable: row.querySelector('[data-action="set-current"]') ? { disabled: row.querySelector('[data-action="set-current"]').disabled, title: row.querySelector('[data-action="set-current"]').title } : null }))`), [
      { status: '当前·暂不可用', tone: 'locked', enable: null },
      { status: '暂不可用', tone: 'locked', enable: { disabled: false, title: message } }
    ]);
    assert.deepEqual(await js('__testErrors'), []);
    }
  });

  await test('当前版本文件缺失：当前版本不能另存为，内置 V1 等可读版本仍可另存为', async () => {
    await setup({ writes: true, open: false });
    await js(`(() => {
      const detail = tf.data.details['dup-recall-mail'];
      detail.capabilities = { ...detail.capabilities, saveAs: false };
      Object.assign(detail.current, { validation: 'failed', validationMessage: '版本文件缺失', saveAs: false });
      for (const version of detail.versions) version.saveAs = version.id !== detail.current.id;
    })(); tf.open(); tf.q('[data-tab="templates"]').click(); void 0;`);
    await waitFor('tf.q(\'[data-role="template-count"]\').textContent === "39 个" && !!tf.q(".template-center-detail-heading")', '模板列表与详情加载');
    await selectResource('dup-recall-mail');
    assert.equal(await js(`tf.q('.template-center-action[data-action="save-as"]').disabled`), true, '当前版本的另存为不可用');
    await openTab('versions');
    const rows = await js(`[...tf.overlay.querySelectorAll('.template-center-tab-panel tbody tr')].map((row) => ({
      label: row.cells[0].querySelector('strong').textContent, disabled: row.querySelector('[data-action="save-as"]').disabled }))`);
    const current = await js(`tf.data.details['dup-recall-mail'].current.label`);
    assert.deepEqual(rows.filter((row) => row.label === current).map((row) => row.disabled), [true]);
    assert.ok(rows.filter((row) => row.label !== current).every((row) => row.disabled === false), JSON.stringify(rows));
    assert.ok(rows.some((row) => row.label === 'V1'));
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('有变更记录接口时显示入口，记录可跳回对应模板；关闭设置后退订', async () => {
    await setup({ writes: true });
    assert.equal(await js('tf.count("subscribe")'), 1);
    await js(`tf.q('[data-action="open-history"]').click(); void 0;`);
    await waitFor(`tf.overlay.querySelectorAll('.template-center-history tbody tr').length === 2`);
    assert.equal(await js(`tf.q('[data-template-view="browser"]').hidden`), true);
    await js(`tf.q('.template-center-history [data-resource-id="fund-type-enum"]').click(); void 0;`);
    await waitFor(`tf.q('[data-template-view="history"]').hidden && tf.detailTitle() === 'FundType枚举值'`, '跳回模板');
    const lists = await js('tf.count("list")');
    await js('for (const listener of tf.listeners) listener({ resourceId: "fund-type-enum" }); void 0;');
    await waitFor(`tf.count('list') === ${lists + 1}`, '变更通知后重读');
    const listener = await js('(window.__lastListener = [...tf.listeners][0], true)');
    assert.equal(listener, true);
    await js(`tf.handle.close({ status: 'cancelled', reason: 'cancel' }); void 0;`);
    assert.equal(await js('tf.count("unsubscribe")'), 1);
    await js('window.__lastListener({ resourceId: "fund-type-enum" }); void 0;');
    await settle();
    assert.equal(await js('tf.count("list")'), lists + 1, '关闭后的通知不再读取');
    assert.deepEqual(await js('__testErrors'), []);
  });

  await test('键盘激活模板、切换 Sheet、跳转关联模板后焦点留在对应控件，方向键可继续切换', async () => {
    // Enter/Space 激活按钮是浏览器默认行为，需真实按键；布局模式的窗口已显示并获得焦点。
    await setup({ layoutOptions: { width: 1080, height: 760, theme: 'light' } });
    const focusedResource = () => js('document.activeElement?.dataset.resourceId || document.activeElement?.tagName');
    await js(`tf.q('[data-resource-id="dup-recall-mail"]').focus(); void 0;`);
    await layout.key('Enter');
    await waitFor(`tf.detailTitle() === tf.data.details['dup-recall-mail'].name`, 'Enter 激活模板');
    assert.equal(await focusedResource(), 'dup-recall-mail');
    const next = await js(`(() => { const items = [...tf.overlay.querySelectorAll('.template-center-item')];
      return items[items.findIndex((item) => item.dataset.resourceId === 'dup-recall-mail') + 1].dataset.resourceId; })()`);
    await layout.key('Down');
    await waitFor(`tf.q('.template-center-item.is-active')?.dataset.resourceId === '${next}'`, '方向键切换模板');
    assert.equal(await focusedResource(), next);
    await layout.key('Space');
    await settle();
    assert.equal(await focusedResource(), next, 'Space 激活当前模板后焦点不变');

    await selectResource('prefund-unbalanced');
    await js(`tf.q('[data-action="select-sheet"][data-sheet-index="1"]').focus(); void 0;`);
    await layout.key('Enter');
    assert.deepEqual(await js(`({ index: document.activeElement?.dataset.sheetIndex, pressed: document.activeElement?.getAttribute('aria-pressed') })`),
      { index: '1', pressed: 'true' });

    await selectResource('fx-option');
    await openTab('info');
    await js(`tf.q('.template-center-kv [data-action="goto"]').focus(); void 0;`);
    await layout.key('Enter');
    await waitFor(`tf.detailTitle() === '外汇期权订单'`, 'Enter 跳转关联模板');
    assert.equal(await focusedResource(), 'fx-option-order', '跳转后焦点移到目标模板');
    assert.deepEqual(await js('__testErrors'), []);
  });

  for (const [name, options] of [
    ['template-files-light', { width: 1080, height: 760, theme: 'light' }],
    ['template-files-dark', { width: 1080, height: 760, theme: 'dark' }],
    ['template-files-zoom-150', { width: 1080, height: 760, theme: 'light', zoom: 1.5 }]
  ]) {
    await test(`生产样式 ${options.width}×${options.height}${options.zoom ? ` @${options.zoom * 100}%` : ''} ${options.theme}：无横向溢出，操作可见`, async () => {
      // 先切回普通模式，使布局用例各自新建并显示窗口；复用被遮挡的窗口时截图可能停在旧帧。
      await reset();
      await setup({ layoutOptions: options });
      await selectResource('prefund-unbalanced');
      const geometry = await js(`(() => {
        const card = tf.q('.app-update-settings-card').getBoundingClientRect();
        const overflow = ['.template-center-filters', '.template-center-list', '.template-center-detail', '.template-center-tabs']
          .filter((selector) => { const element = tf.q(selector); return element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'auto'; });
        const actions = [...tf.overlay.querySelectorAll('.template-center-detail-actions button')].map((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.left >= card.left - 1 && rect.right <= card.right + 1;
        });
        return { overflow, actions, cardFits: card.right <= innerWidth + 1 && card.bottom <= innerHeight + 1 };
      })()`);
      assert.deepEqual(geometry, { overflow: [], actions: [true, true], cardFits: true });
      // 截图取最近一次合成帧；等待几帧，避免停在选中前的画面。
      await layout.settle();
      await js('new Promise((resolve) => setTimeout(resolve, 250))');
      await layout.evidence(name, { geometry });
    });
  }
};
