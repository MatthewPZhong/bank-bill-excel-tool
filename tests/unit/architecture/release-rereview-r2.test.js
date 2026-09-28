'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const actual = require('../../../architecture/boundaries.json');
const baseline = '1'.repeat(40);
function boundary(rule, extra = {}) {
  return { id: 'rereview-r2', governance: 'G8', owner: 'fixture', state: 'pending', rules: [rule], entrypoints: [],
    allowedLocal: [], allowedExternal: [], requiredConsumers: [], activationEvidence: [], protectedScopes: [],
    restrictedApis: [], allowedSites: [], compositionEntrypoints: [], globals: [], factory: null, allowedApiFields: {},
    deprecatedEntrypoints: [], directory: null, ...extra };
}
function fixture(t, files, b) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), source);
  }
  const config = { schemaVersion: 1, factBaseline: baseline, bootstrap: { factBaseline: baseline, mode: 'first-introduction' },
    boundaries: [b], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  return evaluateRules(scan(root, config), config, { schemaVersion: 1, factBaseline: baseline, exceptions: [] }, { root });
}
const clean = result => assert.deepEqual(result.violations, []);
const denied = (result, rule) => assert.ok(result.violations.some(item => item.rule === rule), JSON.stringify(result.violations));
const query = source => ({ 'src/read.js': "const h=require('./helper');exports.read=c=>h.read(c);", 'src/helper.js': source });
const queryBoundary = () => boundary('ARCH-BIZOP-QUERY', { protectedScopes: [{ path: 'src/read.js', functionPath: null }] });
const queryFunction = "const query=c=>c.db.prepare('SELECT 1 AS value').all();";
const arrayCases = [
  ['static index', 'const handlers=[query];exports.read=c=>handlers[0](c);'],
  ['destructuring', 'const [run]=[query];exports.read=c=>run(c);'],
  ['nested index', 'const handlers=[[query]];exports.read=c=>handlers[0][0](c);'],
  ['static spread', 'const handlers=[...[query]];exports.read=c=>handlers[0](c);'],
  ['parameter index', 'function invoke(handlers,index,c){return handlers[index](c);}exports.read=c=>invoke([query],0,c);'],
  ['parameter destructuring', 'function invoke([run],c){return run(c);}exports.read=c=>invoke([query],c);']
];
for (const [name, body] of arrayCases) test(`RR2-01 ${name} 实际执行 SQLite 查询并被检查`, t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const exports = {}; const source = queryFunction + body;
  vm.runInNewContext(source, { exports });
  assert.equal(exports.read({ db })[0].value, 1);
  denied(fixture(t, query(source), queryBoundary()), 'ARCH-BIZOP-QUERY');
});
test('RR2-01 未调用的数组危险成员不污染合法 safe 导出', t => {
  clean(fixture(t, query(queryFunction + 'const handlers=[query,()=>1];exports.read=()=>handlers[1]();'), queryBoundary()));
  clean(fixture(t, query('function firstCode(value){return value.charCodeAt(0);}function read(values){return firstCode(values[0]);}exports.read=()=>read(["bank"]);'), queryBoundary()));
});
for (const expression of ['handlers[unknown]', 'handlers[1]', 'handlers[0]']) test(`RR2-01 不可解释数组目标 ${expression} 必须报 coverage`, t => {
  denied(fixture(t, query(`const handlers=[opaque];exports.read=c=>${expression}(c);`), queryBoundary()), 'ARCH-STATIC-COVERAGE');
});

const rendererBoundary = () => boundary('ARCH-RENDERER-SCOPE', {
  factory: { path: 'src/controller.js', name: 'createController', parameters: ['api', 'initialInfo', 'initialBillCategory'] },
  allowedApiFields: { api: ['read'] }
});
function renderer(t, source, b = rendererBoundary()) {
  return fixture(t, { 'src/shell.js': source, 'src/controller.js': 'window.createController=function createController(options){return options;};' }, b);
}
function received(source) {
  let result;
  const window = { desktopApi: { read() {}, outsideScope() { return true; } }, createController(input) { result = input; } };
  vm.runInNewContext(source, { window }); return result;
}
for (const bind of ['provide.bind(null,window.desktopApi)', 'provide.bind(null,window.desktopApi).bind(null,{read(){}})']) {
  test(`RR2-02 预绑定优先于后传实参 ${bind}`, t => {
    const source = `function provide(api){return api;}const bound=${bind};window.createController({api:bound({read(){}})});`;
    assert.equal(received(source).api.outsideScope(), true); denied(renderer(t, source), 'ARCH-RENDERER-SCOPE');
  });
}
test('RR2-02 合法窄能力的多层预绑定和普通工厂仍可装配', t => {
  for (const source of [
    'function provide(api){return api;}const bound=provide.bind(null,{read(){}}).bind(null,window.desktopApi);window.createController({api:bound()});',
    'function provide(prefix,api){return api;}const bound=provide.bind(null,1).bind(null,{read(){}});window.createController({api:bound()});',
    'function provide(api){return api;}window.createController({api:provide({read(){}})});'
  ]) { assert.equal(typeof received(source).api.read, 'function'); clean(renderer(t, source)); }
});
const aliasCases = [
  'function provide(){const api={read(){}};const alias=api;alias.outsideScope=window.desktopApi.outsideScope;return api;}window.createController({api:provide()});',
  'const api={read(){}};const alias=api;alias.outsideScope=window.desktopApi.outsideScope;window.createController({api:{...api}});',
  'function provide(){const api={read(){}};const wrapper={api};const {api:alias}=wrapper;alias.outsideScope=window.desktopApi.outsideScope;return api;}window.createController({api:provide()});',
  'function provide(){const api={read(){}};const alias=api;Object.assign(alias,window.desktopApi);return api;}window.createController({api:provide()});'
];
aliasCases.forEach((source, index) => test(`RR2-03 别名变更或逃逸 ${index + 1} 实际带入额外能力并被拒绝`, t => {
  assert.equal(received(source).api.outsideScope(), true);
  assert.ok(renderer(t, source).violations.length, '别名实际改变的能力不可被遗漏');
}));
test('RR2-03 同名不同对象不混淆，合法 spread 遵守覆盖顺序', t => {
  for (const source of [
    'function other(){const api={};api.outsideScope=window.desktopApi.outsideScope;}function provide(){const api={read(){}};return api;}window.createController({api:provide()});',
    'const api={read(){}};const alias=api;Object.freeze(alias);window.createController({api:{...api}});',
    'window.createController({api:{read:window.desktopApi,...{read(){}}}});'
  ]) clean(renderer(t, source));
  denied(renderer(t, 'window.createController({api:{read(){},...{read:window.desktopApi}}});'), 'ARCH-STATIC-COVERAGE');
});
for (const payload of ['{api:window.desktopApi}', '[{api:window.desktopApi}]', '{nested:{run(){}}}', '{nested:window.state}', '{nested:window.elements}', '{nested:unknown}']) {
  test(`RR2-04 initialInfo 递归拒绝能力与未知数据 ${payload}`, t => {
    denied(renderer(t, `window.createController({initialInfo:${payload}});`), 'ARCH-RENDERER-SCOPE');
  });
}
test('RR2-04 递归纯数据和真实 app:get-info IPC 数据保持合法', t => {
  clean(renderer(t, 'window.createController({initialInfo:{name:"tool",nested:[null,1,true,{kind:"bank"}]},initialBillCategory:"bank"});'));
  clean(renderer(t, "const {ipcRenderer}=require('electron');window.createController({initialInfo:ipcRenderer.invoke('app:get-info')});"));
  denied(renderer(t, "const {ipcRenderer}=require('electron');window.createController({initialInfo:ipcRenderer.invoke('other')});"), 'ARCH-RENDERER-SCOPE');
  const statement = actual.boundaries.find(b => b.id === 'renderer-statement');
  assert.ok(statement.factory.parameters.includes('initialInfo'));
  const source = 'window.StatementController.createStatementController({initialInfo:{api:window.desktopApi}});';
  denied(fixture(t, { 'src/shell.js': source }, { ...statement, state: 'pending' }), 'ARCH-RENDERER-SCOPE');
});

const recovery = actual.boundaries.find(b => b.id === 'publication-recovery-entry');
const raw = 'src/main-process/toolbox-output-publication.js';
for (const operation of ['recoverOneJournal', 'recoverPreparingIntent', 'recoverFinalizingIntent']) {
  for (const call of [operation + '(runtime,entry,{})', `alias(runtime,entry,{})`, 'bound(runtime,entry,{})']) {
    test(`RR2-05 当前恢复入口 ${operation} 在 prepare 中通过 ${call} 仍被拒绝`, t => {
      const source = `function ${operation}(runtime,entry){return runtime.remove(entry);}const alias=${operation};const bound=alias.bind(null);function prepareToolboxPublication(runtime,entry){return ${call};}`;
      denied(fixture(t, { [raw]: source }, { ...recovery, state: 'pending' }), 'ARCH-PUBLICATION-RECOVERY-ENTRY');
    });
  }
}
