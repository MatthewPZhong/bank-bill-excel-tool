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
    if (node.type === 'FunctionDeclaration' && ['getTemplateResourceService', 'registerTemplateResourceHandlers'].includes(node.id.name)) {
      parts.push(mainSource.slice(node.start, node.end));
    }
    if (node.type === 'VariableDeclaration' && node.declarations.some((item) => item.id.name === 'templateResourceService')) {
      parts.push(mainSource.slice(node.start, node.end));
    }
  });
  assert.equal(parts.length, 3, 'main.js 应包含模板文件服务与注册函数');
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

function registerHandlers({ showSaveDialog }) {
  const handlers = new Map();
  const supportLabels = new Map();
  const mainWindow = { id: 'main-window' };
  const context = {
    path,
    createTemplateResourceService,
    mainWindow,
    app: { getAppPath: () => ROOT, getVersion: () => '9.9.9' },
    dialog: { showSaveDialog },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    supportIpcHandle: (channel, label, handler) => {
      supportLabels.set(channel, label);
      handlers.set(channel, handler);
    }
  };
  vm.runInNewContext(`${mainHandlersSource()}\nregisterTemplateResourceHandlers();`, context);
  return { handlers, supportLabels, mainWindow };
}

test('preload 方法与 Main 通道、参数一一对应', async () => {
  const calls = [];
  const api = vm.runInNewContext(`(${preloadGroupSource()})`, {
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(args[0]); } }
  });
  assert.deepEqual(Object.keys(api).sort(), ['get', 'list', 'saveAs']);
  await api.list();
  await api.get('fund-type-enum');
  await api.saveAs({ resourceId: 'fund-type-enum', versionId: 'v1' });
  assert.deepEqual(plain(calls), [
    ['template-resources:list'],
    ['template-resources:get', 'fund-type-enum'],
    ['template-resources:save-as', { resourceId: 'fund-type-enum', versionId: 'v1' }]
  ]);
  const { handlers, supportLabels } = registerHandlers({ showSaveDialog: async () => ({ canceled: true }) });
  assert.deepEqual([...handlers.keys()].sort(), calls.map((call) => call[0]).sort());
  assert.deepEqual([...supportLabels], [['template-resources:save-as', '另存模板文件']]);
});

test('列表与详情由同一个应用目录服务返回', async () => {
  const { handlers } = registerHandlers({ showSaveDialog: async () => ({ canceled: true }) });
  const listed = await handlers.get('template-resources:list')({});
  assert.equal(listed.status, 'success');
  assert.equal(listed.resources.length, 39);
  assert.equal(listed.resources[0].current.appVersion, '9.9.9');
  const detail = await handlers.get('template-resources:get')({}, 'gateway-recon');
  assert.equal(detail.resource.id, 'gateway-recon');
  assert.match(detail.resource.current.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(plain(await handlers.get('template-resources:get')({}, 'missing')), { status: 'failed', message: '模板不存在' });
});

test('另存为：先校验资源再弹保存框；取消不写入，确认后写出原文件', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resources-ipc-'));
  try {
    const dialogs = [];
    let answer = { canceled: true };
    const { handlers, mainWindow } = registerHandlers({
      showSaveDialog: async (parent, options) => { dialogs.push({ parent, options }); return answer; }
    });
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
