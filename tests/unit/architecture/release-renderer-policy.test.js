'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const { createPolicyRepository } = require('./fixtures/policy-repository');
const baseline = '1'.repeat(40);
const root = path.resolve(__dirname, '../../..');
function boundary(extra = {}) {
  return { id: 'renderer-fixture', governance: 'G8', owner: 'fixture', state: 'pending', rules: ['ARCH-RENDERER-SCOPE'],
    entrypoints: ['src/controller.js'], allowedLocal: [], allowedExternal: [], requiredConsumers: [], activationEvidence: [],
    protectedScopes: [], restrictedApis: [], allowedSites: [], compositionEntrypoints: [], globals: [],
    factory: { path: 'src/controller.js', name: 'createController', parameters: ['api', 'ui', 'panel'] },
    allowedApiFields: { api: ['read'], ui: ['confirm'] }, deprecatedEntrypoints: [], directory: null, ...extra };
}
function fixture(t, files, b = boundary()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-renderer-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sources = { 'src/controller.js': 'window.createController = function createController({api, ui, panel}) { return {enter(){return api.read();}}; };', ...files };
  for (const [name, text] of Object.entries(sources)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
  const config = { schemaVersion: 1, factBaseline: baseline, bootstrap: { factBaseline: baseline, mode: 'first-introduction' }, boundaries: [b], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  return evaluateRules(scan(dir, config), config, { schemaVersion: 1, factBaseline: baseline, exceptions: [] }, { root: dir });
}
const clean = result => assert.deepEqual(result.violations, []);
const denied = result => assert.ok(result.violations.length, '真实旁路必须产生诊断');

test('已集成 Renderer 登记由真实 factory、消费者、生产脚本和行为证据共同激活', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'architecture/boundaries.json')));
  const renderer = config.boundaries.filter(b => b.id.startsWith('renderer-'));
  assert.equal(renderer.length, 20);
  assert.ok(renderer.every(b => b.state === 'active'));
  config.boundaries = renderer;
  const result = evaluateRules(scan(root, config), config, JSON.parse(fs.readFileSync(path.join(root, 'architecture/legacy-allowlist.json'))), { root });
  clean(result);
  assert.equal(result.activeBoundaries.length, 20);
  assert.deepEqual(result.partialBoundaries, []);
});

test('显式 Preload namespace 按当前完整方法集合核验，新增能力不能跟随 namespace 自动放行', t => {
  const base = { 'src/shell.js': 'window.createController({api:window.desktopApi.own});' };
  for (const methods of ['read(){}', 'read(){},write(){}']) {
    const result = fixture(t, { ...base, 'src/preload.js': `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('desktopApi',{own:{${methods}},other:{read(){}}});` });
    if (methods === 'read(){}') clean(result); else denied(result);
  }
  denied(fixture(t, { ...base, 'src/shell.js': 'window.createController({api:window.desktopApi});' }));
});

test('已注册 service 的窄返回和静态 spread 合法，返回整个 API 或动态对象仍失败', t => {
  const provider = body => `(function(root){root.Service={createService(){${body}}};})(typeof window!=='undefined'?window:null);`;
  for (const [body, expected] of [
    ['return {confirm(){}};', true],
    ['const methods={confirm(){}};methods.write=()=>{};return methods;', false],
    ['const methods={confirm(){}};methods[name]=()=>{};return methods;', false],
    ['return window.desktopApi;', false]
  ]) {
    const result = fixture(t, { 'src/service.js': provider(body), 'src/shell.js': 'const ui=window.Service.createService();window.createController({ui:{...ui}});',
      'index.html': '<script src="src/service.js"></script><script src="src/controller.js"></script><script src="src/shell.js"></script>' });
    if (expected) clean(result); else denied(result);
  }
});

test('有限命令表生成的 service 方法全部纳入检查，额外写方法仍被拒绝', t => {
  for (const methods of ["['confirm']", "['confirm','write']"]) {
    const result = fixture(t, { 'src/service.js': `window.Service={createService(){const methods={};const names=${methods};names.forEach(name=>{methods[name]=()=>true;});return methods;}};`,
      'src/shell.js': 'window.createController({ui:window.Service.createService()});',
      'index.html': '<script src="src/service.js"></script><script src="src/controller.js"></script><script src="src/shell.js"></script>' });
    if (methods === "['confirm']") clean(result); else denied(result);
  }
});

test('能力对象的 Object.assign/defineProperty 写入和迟到 provider 覆盖均不能隐藏越权', t => {
  for (const source of [
    'function provide(){const api={read:window.desktopApi.read};Object.assign(api,window.desktopApi);return api;}window.createController({api:provide()});',
    "function provide(){const api={read:window.desktopApi.read};Object.defineProperty(api,'outsideScope',{value:window.desktopApi.outsideScope});return api;}window.createController({api:provide()});",
    'window.Provider={provide(){return window.desktopApi;}};window.createController({api:Provider.provide()});window.Provider={provide(){return {read:window.desktopApi.read}}};'
  ]) {
    const desktopApi = { read() {}, outsideScope() { return true; } }; let received;
    const context = { desktopApi, createController(input) { received = input; } }; context.window = context;
    vm.runInNewContext(source, context);
    assert.equal(received.api.outsideScope(), true);
    denied(fixture(t, { 'src/shell.js': source }));
  }
});

test('明确领域 DOM alias 合法，modalRoot 和应用总 elements 仍不能注入', t => {
  clean(fixture(t, { 'src/shell.js': "const elements={ownPanel:document.getElementById('ownPanel')};window.createController({panel:elements.ownPanel});" }));
  denied(fixture(t, { 'src/shell.js': "const elements={ownPanel:document.getElementById('ownPanel')};window.createController({panel:elements});" }));
  denied(fixture(t, { 'src/shell.js': "window.createController({panel:document.getElementById('modalRoot')});" }));
});

test('同文件参数和双层 helper 不得把完整 desktopApi 伪装成授权方法', t => {
  for (const source of [
    'function mount(read){window.createController({api:{read}});}mount(window.desktopApi);',
    'function forward(api){return {read:api};}function mount(api){window.createController({api:forward(api)});}mount(window.desktopApi);'
  ]) {
    const desktopApi = { outsideScope() { return true; } }; let received;
    vm.runInNewContext(source, { window: { desktopApi, createController(input) { received = input; } } });
    assert.equal(received.api.read, desktopApi);
    assert.equal(received.api.read.outsideScope(), true);
    denied(fixture(t, { 'src/shell.js': source }));
  }
  clean(fixture(t, { 'src/shell.js': 'function mount(read){window.createController({api:{read}});}mount(()=>true);' }));
});

test('新增具名宿主和配置 service 方法合同受历史强度比较保护', t => {
  const f = createPolicyRepository(t);
  f.boundary.allowedApiFields = { modalHost: ['closeOwner'], modalBridge: ['closeModal'], services: ['getTemplates'], subscriptions: ['subscribeChannels'], legacyController: ['enter'], differenceApi: ['assertCanonicalDifference'], reviewProjection: ['projectReview'] };
  f.save(); f.commit('启用明确 service 合同');
  for (const name of Object.keys(f.boundary.allowedApiFields)) {
    const previous = [...f.boundary.allowedApiFields[name]];
    f.boundary.allowedApiFields[name].push('arbitraryWrite'); f.save();
    assert.ok(f.check().violations.some(v => v.field === 'allowedApiFields'), name);
    f.boundary.allowedApiFields[name] = previous;
  }
});
