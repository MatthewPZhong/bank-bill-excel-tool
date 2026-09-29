'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const baseline = '1'.repeat(40);
function boundary(rule, overrides = {}) {
  return { id: 'probe', governance: 'G8', owner: 'fixture', state: 'pending', rules: [rule],
    entrypoints: [], allowedLocal: [], allowedExternal: [], requiredConsumers: [], activationEvidence: [],
    protectedScopes: [], restrictedApis: [], allowedSites: [], compositionEntrypoints: [], globals: [],
    factory: null, allowedApiFields: {}, deprecatedEntrypoints: [], directory: null, ...overrides };
}
function fixture(t, files, protectedBoundary, change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-adversarial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), source);
  }
  const config = { schemaVersion: 1, factBaseline: baseline, bootstrap: { factBaseline: baseline, mode: 'first-introduction' },
    boundaries: [protectedBoundary], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  change(config, scan(root, config));
  return evaluateRules(scan(root, config), config, { schemaVersion: 1, factBaseline: baseline, exceptions: [] }, { root });
}
function denied(result, rule) { assert.ok(result.violations.some(v => v.rule === rule), JSON.stringify(result.violations)); }

test('准确登记动态目标仍进入纯模块依赖闭包', t => {
  const result = fixture(t, { 'src/core.js': "const target = choose(); require(target);" },
    boundary('ARCH-PLATFORM-CORE', { entrypoints: ['src/core.js'], allowedLocal: ['src/core.js'] }),
    (config, scanned) => { const d = scanned.dynamicSites[0]; config.dynamicLoads.push({ from: d.from, functionPath: d.functionPath,
      evidenceId: d.evidenceId, allowedTargets: ['node:fs'], reason: 'fixture准确目标' }); });
  denied(result, 'ARCH-PLATFORM-CORE');
});

test('纯模块无法使用 eval 隐藏禁止依赖', t => {
  const result = fixture(t, { 'src/core.js': "eval('require(\"node:fs\")');" },
    boundary('ARCH-PLATFORM-CORE', { entrypoints: ['src/core.js'], allowedLocal: ['src/core.js'] }));
  denied(result, 'ARCH-STATIC-COVERAGE');
});

test('工厂注入对象 spread 不能隐藏完整状态', t => {
  const result = fixture(t, { 'src/controller.js': 'window.createProbe = function (options) { return options; };',
    'src/shell.js': 'window.createProbe({ ...getDependencies() });' }, boundary('ARCH-RENDERER-SCOPE', {
    entrypoints: ['src/controller.js'], factory: { path: 'src/controller.js', name: 'createProbe', parameters: ['api'] }, allowedApiFields: { api: ['read'] }
  }));
  denied(result, 'ARCH-STATIC-COVERAGE');
});

test('冻结且明确按方法构造的 scoped API 允许，完整 desktopApi 禁止', t => {
  const b = boundary('ARCH-RENDERER-SCOPE', { entrypoints: ['src/controller.js'], factory: { path: 'src/controller.js', name: 'createProbe', parameters: ['api'] }, allowedApiFields: { api: ['read'] } });
  const good = fixture(t, { 'src/controller.js': 'window.createProbe = function (options) { const state = {}; return state; };',
    'src/shell.js': 'window.createProbe({ api: Object.freeze({read() { return 1; }}) });' }, b);
  assert.deepEqual(good.violations, []);
  const bad = fixture(t, { 'src/controller.js': 'window.createProbe = function (options) {};',
    'src/shell.js': 'window.createProbe({ api: Object.freeze(window.desktopApi) });' }, b);
  denied(bad, 'ARCH-RENDERER-SCOPE');
});

test('通用具名函数通过本地函数 alias 调 Position 也拒绝，Main 的其他装配允许', t => {
  const files = { 'src/main.js': "const position = require('./position'); function finish() { position.settle(); } const alias = finish; function runArchiveAwareOperation() { alias(); } function compose() { position.settle(); }", 'src/position.js': 'exports.settle = () => {};' };
  const result = fixture(t, files, boundary('ARCH-TASK-ADAPTER', { protectedScopes: [{ path: 'src/main.js', functionPath: 'runArchiveAwareOperation' }],
    restrictedApis: [{ path: 'src/position.js', exportNames: ['settle'], operations: [] }] }));
  denied(result, 'ARCH-TASK-ADAPTER');
});

test('G5 不透明 DB alias 必须报覆盖错误', t => {
  const result = fixture(t, { 'src/query.js': "function read(catalog, suffix) { const handle = catalog['d' + suffix]; return handle.prepare('SELECT * FROM facts').all(); }" },
    boundary('ARCH-BIZOP-QUERY', { protectedScopes: [{ path: 'src/query.js', functionPath: 'read' }] }));
  denied(result, 'ARCH-STATIC-COVERAGE');
});

test('其他业务经 BizOP 域内 helper 也不能获得私有恢复实现', t => {
  const prefix = 'src/main-process/biz-op-v327/';
  const result = fixture(t, { [prefix + 'recovery-driver.js']: 'exports.recover = () => {};',
    [prefix + 'bridge.js']: "exports.recover = require('./recovery-driver').recover;",
    'src/main-process/other.js': "require('./biz-op-v327/bridge').recover();" }, boundary('ARCH-BIZOP-RECOVERY-PRIVATE', {
    restrictedApis: [{ path: prefix + 'recovery-driver.js', exportNames: ['recover'], operations: [] }] }));
  denied(result, 'ARCH-BIZOP-RECOVERY-PRIVATE');
});

test('build-info 生成合同不能掩盖目标大小写错误', t => {
  const result = fixture(t, { 'src/main.js': "require('./Build-info');", 'src/build-info.js': 'module.exports = {};', 'scripts/generate.js': '' },
    boundary('ARCH-STATIC-COVERAGE'), config => { config.generatedModules.push({ from: 'src/main.js', specifier: './Build-info', target: 'src/Build-info.js', generator: 'scripts/generate.js' }); });
  denied(result, 'ARCH-STATIC-COVERAGE');
});

test('受保护纯模块不能通过 module.require/globalThis.require/bind 隐藏加载', t => {
  for (const source of ["module.require('node:fs');", "globalThis.require('node:fs');", "const load = require.bind(null); load('node:fs');"]) {
    const result = fixture(t, { 'src/core.js': source }, boundary('ARCH-PLATFORM-CORE', { entrypoints: ['src/core.js'], allowedLocal: ['src/core.js'] }));
    assert.ok(result.violations.some(v => ['ARCH-STATIC-COVERAGE', 'ARCH-PLATFORM-CORE'].includes(v.rule)), source);
  }
});
