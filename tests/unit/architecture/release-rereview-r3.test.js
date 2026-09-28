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
function boundary(rule, extra = {}) {
  return { id: 'rereview-r3', governance: 'G8', owner: 'fixture', state: 'pending', rules: [rule], entrypoints: [],
    allowedLocal: [], allowedExternal: [], requiredConsumers: [], activationEvidence: [], protectedScopes: [],
    restrictedApis: [], allowedSites: [], compositionEntrypoints: [], globals: [], factory: null, allowedApiFields: {},
    deprecatedEntrypoints: [], directory: null, ...extra };
}
function fixture(t, files, b) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), source);
  }
  const config = { schemaVersion: 1, factBaseline: '1'.repeat(40), bootstrap: { factBaseline: '1'.repeat(40), mode: 'first-introduction' },
    boundaries: [b], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  return evaluateRules(scan(root, config), config, { schemaVersion: 1, factBaseline: config.factBaseline, exceptions: [] }, { root });
}
const clean = result => assert.deepEqual(result.violations, []);
const denied = result => assert.ok(result.violations.some(v => ['ARCH-STATIC-COVERAGE', 'ARCH-RENDERER-SCOPE',
  'ARCH-BIZOP-QUERY', 'ARCH-PUBLICATION-RECOVERY-ENTRY'].includes(v.rule)), JSON.stringify(result.violations));
const queryBoundary = boundary('ARCH-BIZOP-QUERY', { protectedScopes: [{ path: 'src/read.js', functionPath: null }] });
function query(t, body) {
  return fixture(t, { 'src/read.js': "const h=require('./helper');exports.read=c=>h.read(c);",
    'src/helper.js': "const query=c=>c.db.prepare('SELECT 1 AS value').all();const safe=()=>[];" + body }, queryBoundary);
}
const spreadCases = [
  ['parameter', 'function invoke(values,c){const handlers=[...values,safe];return handlers[1](c);}exports.read=c=>invoke([safe,query],c);'],
  ['factory', 'function get(){return [safe,query];}const handlers=[...get(),safe];exports.read=c=>handlers[1](c);'],
  ['nested spread', 'function invoke(values,c){const first=[...values];const handlers=[...first,safe];return handlers[1](c);}exports.read=c=>invoke([safe,query],c);'],
  ['destructured', 'function invoke(values,c){const [,run]=[...values,safe];return run(c);}exports.read=c=>invoke([safe,query],c);'],
  ['apply argument spread', 'function invoke(fn,c){return fn(c);}function run(values,c){return invoke.apply(null,[...values,safe,c]);}exports.read=c=>run([query,c],c);']
];
for (const [name, body] of spreadCases) test(`RR3-01 ${name} 不得将未知 spread 长度当作一个槽位`, t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const exports = {}; vm.runInNewContext("const query=c=>c.db.prepare('SELECT 1 AS value').all();const safe=()=>[];" + body, { exports });
  assert.equal(exports.read({ db })[0].value, 1); denied(query(t, body));
});
test('RR3-01 完全静态数组保留正确位置，安全与危险选择分别判断', t => {
  clean(query(t, 'const handlers=[...[query,safe],query];exports.read=c=>handlers[1](c);'));
  denied(query(t, 'const handlers=[...[safe,query],safe];exports.read=c=>handlers[1](c);'));
});

const rendererBoundary = id => ({ ...actual.boundaries.find(b => b.id === id), state: 'pending' });
const bank = rendererBoundary('renderer-bank-statement');
const statement = rendererBoundary('renderer-statement');
const recon = rendererBoundary('renderer-recon-id-fix');
const mountBank = expression => `window.BankStatementController.createBankStatementController({api:${expression}});`;
function renderer(t, source, b = bank) { return fixture(t, { 'src/shell.js': source }, b); }
function received(source) {
  let input; const accept = value => { input = value; };
  const desktopApi = { run() {}, outsideScope() { return true; } };
  const window = { desktopApi, BankStatementController: { createBankStatementController: accept },
    StatementController: { createStatementController: accept }, ReconIdFixController: { createReconIdFixController: accept } };
  vm.runInNewContext(source, { window }); return { input, desktopApi };
}
const nestedCases = [
  ['member write', 'envelope.api.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['alias write', 'const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['spread', 'const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;', '{...envelope.api}'],
  ['Object.assign', 'Object.assign(envelope.api,window.desktopApi);', 'envelope.api'],
  ['helper escape', 'function mutate(api){api.outsideScope=window.desktopApi.outsideScope;}mutate(envelope.api);', 'envelope.api']
];
for (const [name, mutate, expression] of nestedCases) test(`RR3-02 嵌套对象 ${name} 实际带入额外方法并被拒绝`, t => {
  const source = 'const envelope={api:{run(){}}};' + mutate + mountBank(expression);
  assert.equal(received(source).input.api.outsideScope(), true); denied(renderer(t, source));
});
test('RR3-02 新建工厂输入、无变更嵌套对象和纯观察调用保持合法', t => {
  for (const source of [mountBank('{run(){}}'), 'const envelope={api:{run(){}}};' + mountBank('envelope.api'),
    'const envelope={api:{run(){}}};Object.freeze(envelope.api);Object.keys(envelope.api);' + mountBank('{...envelope.api}')]) clean(renderer(t, source));
});
test('RR3-02 本地工厂返回对象后的别名写入和 helper 逃逸也不能遗漏', t => {
  for (const mutate of ['alias.outsideScope=window.desktopApi.outsideScope;', 'Object.assign(alias,window.desktopApi);']) {
    const source = 'function provide(){return {run(){}};}const api=provide();const alias=api;' + mutate + mountBank('api');
    assert.equal(received(source).input.api.outsideScope(), true); denied(renderer(t, source));
  }
  clean(renderer(t, 'function provide(){return {run(){}};}const api=provide();' + mountBank('api')));
});

for (const expression of ['{["__proto__"]:window.desktopApi}', '{nested:{["__proto__"]:window.desktopApi}}',
  '{...{["__proto__"]:window.desktopApi}}', '{__proto__:window.desktopApi}', '{nested:{__proto__:window.desktopApi}}']) {
  test(`RR3-03 特殊自有键或真实 prototype setter 不得隐藏能力 ${expression}`, t => {
    const source = `window.StatementController.createStatementController({initialInfo:${expression}});`;
    denied(renderer(t, source, statement));
  });
}
test('RR3-03 computed __proto__ 在真实 VM 中为自有属性，纯数据特殊键仍合法', t => {
  const { input, desktopApi } = received('window.StatementController.createStatementController({initialInfo:{["__proto__"]:window.desktopApi}});');
  assert.equal(Object.hasOwn(input.initialInfo, '__proto__'), true); assert.equal(input.initialInfo.__proto__, desktopApi);
  assert.equal(input.initialInfo.outsideScope, undefined); assert.equal(input.initialInfo.__proto__.outsideScope(), true);
  for (const literal of ['{["__proto__"]:{name:"bank"}}', '{__proto__:null,name:"bank"}', '{constructor:"bank",toString:"text",hasOwnProperty:true}'])
    clean(renderer(t, `window.StatementController.createStatementController({initialInfo:${literal}});`, statement));
});
test('RR3-03 scoped 方法集合不得吞掉名为 __proto__ 的未授权自有方法', t => {
  denied(renderer(t, mountBank('{run(){},["__proto__"](){return true;}}')));
});

for (const value of ['()=>window.desktopApi', '{nested:()=>window.desktopApi}', 'window.desktopApi',
  "ipcRenderer.invoke('archive-center:get-settings')", "ipcRenderer.invoke('other').reconIdFixBillCategory"]) {
  test(`RR3-04 真实 config.initialBillCategory 拒绝非数据或非指定 IPC ${value}`, t => {
    denied(renderer(t, `const {ipcRenderer}=require('electron');window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:${value}}});`, recon));
  });
}
test('RR3-04 真实 ReconID 配置允许分类数据与 app:get-info 字段', t => {
  for (const value of ['"business"', "ipcRenderer.invoke('app:get-info').reconIdFixBillCategory"]) {
    clean(renderer(t, `const {ipcRenderer}=require('electron');window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:${value}}});`, recon));
  }
});

const recovery = { ...actual.boundaries.find(b => b.id === 'publication-recovery-entry'), state: 'pending' };
const raw = 'src/main-process/toolbox-output-publication.js';
const recoveryCases = [
  ['array', 'const list=[recoverOneJournal];return list[0](runtime,entry,{});'],
  ['destructure', 'const [run]=[recoverOneJournal];return run(runtime,entry,{});'],
  ['parameter', 'function invoke(fn,r,e){return fn(r,e,{});}return invoke(recoverOneJournal,runtime,entry);'],
  ['identity', 'function identity(fn){return fn;}return identity(recoverOneJournal)(runtime,entry,{});'],
  ['external helper', "const {invoke}=require('./invoke-helper');return invoke(recoverOneJournal,runtime,entry);"],
  ['nested forwarding', "const {invoke}=require('./invoke-helper');function forward(o,r,e){return invoke(o.run,r,e);}return forward({run:recoverOneJournal},runtime,entry);"]
];
for (const [name, body] of recoveryCases) test(`RR3-05 受限恢复经 ${name} 仍保留能力身份`, t => {
  const source = `function recoverOneJournal(runtime,entry){return runtime.remove(entry);}function prepareToolboxPublication(runtime,entry){${body}}module.exports={prepareToolboxPublication};`;
  let writes = 0; const module = { exports: {} };
  vm.runInNewContext(source, { module, require: () => ({ invoke: (fn, r, e) => fn(r, e, {}) }) });
  module.exports.prepareToolboxPublication({ remove() { writes += 1; } }, {}); assert.equal(writes, 1);
  denied(fixture(t, { [raw]: source, 'src/main-process/invoke-helper.js': 'exports.invoke=(fn,r,e)=>fn(r,e,{});' }, recovery));
});
test('RR3-05 传递但不执行的受限成员与同名普通函数不扩大成恢复调用', t => {
  for (const body of [
    'function choose(o){return o.safe();}return choose({restricted:recoverOneJournal,safe(){return 1;}});',
    'function invoke(fn){return fn();}return invoke(function recoverOneJournal(){return 1;});',
    'const list=[recoverOneJournal,()=>1];return list[1]();'
  ]) clean(fixture(t, { [raw]: `function recoverOneJournal(){}function prepareToolboxPublication(){${body}}` }, recovery));
});
