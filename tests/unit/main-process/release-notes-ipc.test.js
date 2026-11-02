'use strict';

// 执行 src/main.js 的 registerAppHandlers 与 src/preload.js 的 settings 组真实代码；Electron 对象为替身。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const acorn = require('acorn');
const { createReleaseNotesState } = require('../../../src/main-process/release-notes/service');

const ROOT = path.join(__dirname, '..', '..', '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const mainAst = acorn.parse(mainSource, { ecmaVersion: 'latest' });

const NOTES = [
  { version: '3.2.16', date: '2026-11-11', highlights: ['十六'] },
  { version: '3.2.15', date: '2026-11-04', highlights: ['十五'] }
];

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === 'object' && value.type) walk(value, visit);
  }
}

function findFunction(name) {
  let found = null;
  walk(mainAst, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id.name === name) found = node;
  });
  assert.ok(found, `main.js 应包含 ${name}`);
  return found;
}

function preloadSettingsSource() {
  let group = '';
  walk(acorn.parse(preloadSource, { ecmaVersion: 'latest' }), (node) => {
    if (node.type === 'Property' && node.key.name === 'settings' && node.value.type === 'ObjectExpression') {
      group = preloadSource.slice(node.value.start, node.value.end);
    }
  });
  assert.ok(group, 'preload 应暴露 settings');
  return group;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function registerAppHandlers(releaseNotesState) {
  const handlers = new Map();
  const node = findFunction('registerAppHandlers');
  const database = {
    countAllAccountMappings: () => 0,
    getUiStyle: () => 'Clear',
    getCurrentModule: () => 'statement-generator',
    getReconIdFixBillCategory: () => null,
    getEnabledModules: () => ['statement-generator']
  };
  const context = {
    fs,
    process: { env: {} },
    app: { getVersion: () => '3.2.16' },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} },
    // 同一注册函数里的业务通道与本用例无关，只需注册时不报错。
    trackedIpcHandle: () => {},
    businessIpcHandle: () => {},
    supportIpcHandle: () => {},
    database,
    darkModeScheduler: { refresh: () => ({}) },
    releaseNotesState,
    lastErrorReport: null,
    lastOwnAccountsMigrationError: null,
    getEnumConfig: () => null,
    ensureStorageRoot: () => '/tmp/storage-root',
    getAvailableCurrencyCodes: () => [],
    buildBackgroundPayload: () => ({})
  };
  vm.runInNewContext(`${mainSource.slice(node.start, node.end)}\nregisterAppHandlers();`, context);
  return handlers;
}

function createStore(value) {
  return {
    value,
    writes: [],
    getReleaseNotesAcknowledgedVersion() { return this.value; },
    setReleaseNotesAcknowledgedVersion(version) { this.writes.push(version); this.value = version; }
  };
}

test('preload acknowledgeReleaseNotes 透传版本到确认通道', async () => {
  const calls = [];
  const api = vm.runInNewContext(`(${preloadSettingsSource()})`, {
    ipcRenderer: {
      invoke: (...args) => { calls.push(args); return Promise.resolve(args[0]); },
      on: () => {},
      removeListener: () => {}
    }
  });
  await api.acknowledgeReleaseNotes('3.2.16');
  assert.deepEqual(plain(calls), [['settings:acknowledge-release-notes', '3.2.16']]);
});

test('app:get-info 附带更新说明，确认通道只接受待显示的当前版本', async () => {
  const store = createStore('3.2.14');
  const state = createReleaseNotesState({ store, currentVersion: '3.2.16', databaseExisted: true, rawNotes: NOTES });
  const handlers = registerAppHandlers(state);

  const info = plain(await handlers.get('app:get-info')());
  assert.equal(info.version, '3.2.16');
  assert.equal(info.releaseNotes.current.version, '3.2.16');
  assert.deepEqual(info.releaseNotes.pending, {
    fromVersion: '3.2.14',
    toVersion: '3.2.16',
    entries: NOTES
  });

  const acknowledge = handlers.get('settings:acknowledge-release-notes');
  assert.deepEqual(plain(await acknowledge({}, '3.2.15')), { status: 'ignored' });
  assert.deepEqual(plain(await acknowledge({}, { version: '3.2.16' })), { status: 'ignored' });
  assert.deepEqual(store.writes, []);
  assert.deepEqual(plain(await acknowledge({}, '3.2.16')), { status: 'ok', acknowledgedVersion: '3.2.16' });
  assert.deepEqual(store.writes, ['3.2.16']);

  const reloaded = plain(await handlers.get('app:get-info')());
  assert.equal(reloaded.releaseNotes.pending, null, '渲染层重载后不再弹出');
  assert.equal(reloaded.releaseNotes.current.version, '3.2.16');
});

test('判定失败（无状态）时 get-info 返回空说明，确认通道忽略', async () => {
  const handlers = registerAppHandlers(null);
  const info = plain(await handlers.get('app:get-info')());
  assert.deepEqual(info.releaseNotes, { current: null, pending: null });
  assert.deepEqual(plain(await handlers.get('settings:acknowledge-release-notes')({}, '3.2.16')), { status: 'ignored' });
});

test('启动时先判断主库是否存在，再打开主库，并在判定失败时不阻断启动', () => {
  const node = findFunction('initializeApplication');
  const source = mainSource.slice(node.start, node.end);
  const existsAt = source.indexOf('const databaseExisted = fs.existsSync(dataPath);');
  const openAt = source.indexOf('database = new AppDatabase(dataPath);');
  const stateAt = source.indexOf('releaseNotesState = createReleaseNotesState({');
  assert.ok(existsAt > 0 && openAt > existsAt, '必须在 new AppDatabase 之前记录主库是否已存在');
  assert.ok(stateAt > openAt, '更新说明判定须在主库初始化之后');
  assert.match(source.slice(stateAt - 200, stateAt + 900), /try \{[\s\S]*releaseNotesState = createReleaseNotesState[\s\S]*\} catch \(error\) \{\s*releaseNotesState = null;/);
});
