'use strict';

// 执行 src/main.js 与 src/preload.js 中模板文件的真实注册代码；Electron 对象为替身，写出只落在临时目录。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const acorn = require('acorn');
const { createTemplateResourceService } = require('../../../src/main-process/template-resources/service');
const { createTemplateResourceStore, restyledTemplate } = require('../../helpers/template-resource-store');

const ROOT = path.join(__dirname, '..', '..', '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === 'object' && value.type) walk(value, visit);
  }
}

function mainHandlersSource() {
  const parts = [];
  walk(acorn.parse(mainSource, { ecmaVersion: 'latest' }), (node) => {
    if (node.type === 'FunctionDeclaration' && ['getTemplateResourceService', 'broadcastTemplateResourcesChanged', 'registerTemplateResourceHandlers'].includes(node.id.name)) {
      parts.push(mainSource.slice(node.start, node.end));
    }
    if (node.type === 'VariableDeclaration' && node.declarations.some((item) => item.id.name === 'templateResourceService')) {
      parts.push(mainSource.slice(node.start, node.end));
    }
  });
  assert.equal(parts.length, 4, 'main.js 应包含模板文件服务、变更广播与注册函数');
  return parts.join('\n');
}

function preloadGroupSource() {
  let group = '';
  walk(acorn.parse(preloadSource, { ecmaVersion: 'latest' }), (node) => {
    if (node.type === 'Property' && node.key.name === 'templateResources') group = preloadSource.slice(node.value.start, node.value.end);
  });
  assert.ok(group, 'preload 应暴露 templateResources');
  return group;
}

// vm 内创建的对象来自另一 realm，比较前转为普通数据。
const plain = (value) => JSON.parse(JSON.stringify(value));

function registerHandlers({ showSaveDialog, showImportOpenDialog = async () => ({ canceled: true }) }) {
  const handlers = new Map();
  const supportLabels = new Map();
  const mainWindow = { id: 'main-window' };
  const sent = [];
  const logs = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resources-ipc-user-data-'));
  const database = createTemplateResourceStore();
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) }
  };
  const context = {
    path,
    fs,
    createTemplateResourceService,
    mainWindow,
    database,
    app: { getAppPath: () => ROOT, getVersion: () => '9.9.9', getPath: (name) => (name === 'userData' ? userData : '') },
    dialog: { showSaveDialog },
    showImportOpenDialog,
    appendActivityLogEntry: (entry) => logs.push(entry),
    BrowserWindow: { getAllWindows: () => [window] },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    supportIpcHandle: (channel, label, handler) => {
      supportLabels.set(channel, label);
      handlers.set(channel, handler);
    }
  };
  vm.runInNewContext(`${mainHandlersSource()}\nregisterTemplateResourceHandlers();`, context);
  const cleanup = () => {
    database.close();
    fs.rmSync(userData, { recursive: true, force: true });
  };
  return { handlers, supportLabels, mainWindow, sent, logs, userData, cleanup };
}

test('preload 方法与 Main 通道、参数一一对应', async () => {
  const calls = [];
  const listeners = new Map();
  const api = vm.runInNewContext(`(${preloadGroupSource()})`, {
    ipcRenderer: {
      invoke: (...args) => { calls.push(args); return Promise.resolve(args[0]); },
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); }
    }
  });
  assert.deepEqual(Object.keys(api).sort(), [
    'commitImport', 'deleteVersion', 'discardImport', 'get', 'list', 'listChanges', 'onChanged',
    'pickImportFile', 'prepareImport', 'saveAs', 'setCurrentVersion'
  ]);
  await api.list();
  await api.get('fund-type-enum');
  await api.saveAs({ resourceId: 'fund-type-enum', versionId: 'v1' });
  await api.pickImportFile({ resourceId: 'fund-type-enum' });
  await api.prepareImport({ resourceId: 'fund-type-enum', filePath: '/tmp/a.xlsx' });
  await api.discardImport('token-1');
  await api.commitImport({ importToken: 'token-1', enable: true });
  await api.setCurrentVersion({ resourceId: 'fund-type-enum', versionId: 'v1', expectedVersionId: 'v2' });
  await api.deleteVersion({ resourceId: 'fund-type-enum', versionId: 'v2' });
  await api.listChanges();
  assert.deepEqual(plain(calls), [
    ['template-resources:list'],
    ['template-resources:get', 'fund-type-enum'],
    ['template-resources:save-as', { resourceId: 'fund-type-enum', versionId: 'v1' }],
    ['template-resources:pick-import-file', { resourceId: 'fund-type-enum' }],
    ['template-resources:prepare-import', { resourceId: 'fund-type-enum', filePath: '/tmp/a.xlsx' }],
    ['template-resources:discard-import', 'token-1'],
    ['template-resources:commit-import', { importToken: 'token-1', enable: true }],
    ['template-resources:set-current-version', { resourceId: 'fund-type-enum', versionId: 'v1', expectedVersionId: 'v2' }],
    ['template-resources:delete-version', { resourceId: 'fund-type-enum', versionId: 'v2' }],
    ['template-resources:list-changes']
  ]);

  const received = [];
  const unsubscribe = api.onChanged((payload) => {
    received.push(payload);
    throw new Error('listener 异常被隔离');
  });
  listeners.get('template-resources:changed')({}, { resourceId: 'fund-type-enum' });
  assert.deepEqual(plain(received), [{ resourceId: 'fund-type-enum' }]);
  unsubscribe();
  assert.equal(listeners.has('template-resources:changed'), false);
  assert.equal(typeof api.onChanged(null), 'function', '非函数 listener 返回空退订');

  const { handlers, supportLabels, cleanup } = registerHandlers({ showSaveDialog: async () => ({ canceled: true }) });
  try {
    assert.deepEqual([...handlers.keys()].sort(), calls.map((call) => call[0]).sort());
    assert.deepEqual([...supportLabels].sort(), [
      ['template-resources:commit-import', '导入模板版本'],
      ['template-resources:delete-version', '删除模板版本'],
      ['template-resources:save-as', '另存模板文件'],
      ['template-resources:set-current-version', '切换模板版本']
    ]);
  } finally {
    cleanup();
  }
});

test('列表与详情由同一个应用目录服务返回', async (t) => {
  const { handlers, cleanup } = registerHandlers({ showSaveDialog: async () => ({ canceled: true }) });
  t.after(cleanup);
  const listed = await handlers.get('template-resources:list')({});
  assert.equal(listed.status, 'success');
  assert.equal(listed.resources.length, 39);
  assert.equal(listed.resources[0].current.appVersion, '9.9.9');
  const detail = await handlers.get('template-resources:get')({}, 'gateway-recon');
  assert.equal(detail.resource.id, 'gateway-recon');
  assert.match(detail.resource.current.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(plain(await handlers.get('template-resources:get')({}, 'missing')), { status: 'failed', message: '模板不存在' });
});

test('另存为：先校验资源再弹保存框；取消不写入，确认后写出原文件', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resources-ipc-'));
  try {
    const dialogs = [];
    let answer = { canceled: true };
    const { handlers, mainWindow, cleanup } = registerHandlers({
      showSaveDialog: async (parent, options) => { dialogs.push({ parent, options }); return answer; }
    });
    t.after(cleanup);
    const saveAs = handlers.get('template-resources:save-as');

    assert.deepEqual(plain(await saveAs({}, { resourceId: 'missing' })), { status: 'failed', message: '模板不存在' });
    assert.deepEqual(plain(await saveAs({}, undefined)), { status: 'failed', message: '模板不存在' });
    assert.equal(dialogs.length, 0, '无效资源不应弹出保存框');

    assert.deepEqual(plain(await saveAs({}, { resourceId: 'refund-order', versionId: 'v1' })), { status: 'cancelled' });
    assert.equal(dialogs[0].parent, mainWindow);
    assert.deepEqual(plain(dialogs[0].options), {
      title: '另存模板文件',
      defaultPath: '中台退款订单.xls',
      filters: [{ name: 'XLS', extensions: ['xls'] }]
    });
    assert.deepEqual(fs.readdirSync(directory), []);

    const target = path.join(directory, '退款订单副本.xls');
    answer = { canceled: false, filePath: target };
    const result = await saveAs({}, { resourceId: 'refund-order', versionId: 'v1' });
    assert.deepEqual(plain(result), { status: 'success', filePath: target, fileName: '退款订单副本.xls' });
    const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(digest(target), digest(path.join(ROOT, 'assets', '中台退款订单.xls')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('导入新版本：只接受选择框返回的文件，提交后广播变更并记录变更', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resources-ipc-import-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const picked = await restyledTemplate('assets/重复入金召回邮件模板.xlsx', path.join(directory, '邮件模板-新版.xlsx'), (workbook) => {
    workbook.worksheets[0].getColumn(1).width = 30;
  });
  const dialogs = [];
  let answer = { canceled: true };
  const { handlers, sent, logs, userData, cleanup } = registerHandlers({
    showSaveDialog: async () => ({ canceled: true }),
    showImportOpenDialog: async (scope, options) => { dialogs.push({ scope, options }); return answer; }
  });
  t.after(cleanup);

  assert.deepEqual(plain(await handlers.get('template-resources:pick-import-file')({}, { resourceId: 'dup-recall-mail' })), { status: 'cancelled' });
  assert.equal(dialogs[0].scope, 'template-resources');
  assert.deepEqual(plain(dialogs[0].options.filters), [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]);

  const unpicked = await handlers.get('template-resources:prepare-import')({}, { resourceId: 'dup-recall-mail', filePath: picked });
  assert.equal(unpicked.status, 'failed', '未经选择框的路径不读取');

  answer = { canceled: false, filePaths: [picked] };
  const choice = await handlers.get('template-resources:pick-import-file')({}, { resourceId: 'dup-recall-mail' });
  assert.deepEqual(plain(choice), { status: 'success', filePath: picked, fileName: '邮件模板-新版.xlsx', size: fs.statSync(picked).size });

  const prepared = await handlers.get('template-resources:prepare-import')({}, { resourceId: 'dup-recall-mail', filePath: picked });
  assert.equal(prepared.status, 'success');
  assert.equal(prepared.verdict, 'pass');
  assert.equal(prepared.expectedVersionId, 'v1');
  const committed = await handlers.get('template-resources:commit-import')({}, { importToken: prepared.importToken, enable: true });
  assert.equal(committed.status, 'success');
  assert.equal(committed.version.label, 'V2');
  assert.ok(fs.existsSync(path.join(userData, 'template-resources', 'dup-recall-mail', 'v2.xlsx')));
  assert.deepEqual(plain(sent), [['template-resources:changed', { resourceId: 'dup-recall-mail' }]]);
  assert.ok(logs.some((entry) => /导入并启用 V2/.test(entry.message)));

  const changes = await handlers.get('template-resources:list-changes')({});
  assert.deepEqual(plain(changes.changes.map((change) => [change.resourceName, change.action, change.from, change.to, change.result])), [
    ['重复入金召回邮件模板', '导入并启用', 'V1', 'V2', 'success']
  ]);
});
