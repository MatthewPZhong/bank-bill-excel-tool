'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const { factoryPresent } = require('../../../scripts/architecture/contracts');
const baseline = '1'.repeat(40);
function boundary(rule, fields = {}) {
  return { id: 'release-fixture', owner: 'fixture', governance: 'G8', state: 'pending', rules: [rule], entrypoints: [],
    allowedLocal: [], allowedExternal: [], requiredConsumers: [], activationEvidence: [], protectedScopes: [],
    restrictedApis: [], allowedSites: [], compositionEntrypoints: [], globals: [], factory: null, allowedApiFields: {},
    deprecatedEntrypoints: [], directory: null, ...fields };
}
function fixture(t, files, b, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-release-closure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), source);
  }
  const config = { schemaVersion: 1, factBaseline: baseline, bootstrap: { factBaseline: baseline, mode: 'first-introduction' },
    boundaries: [b], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  let scanned = scan(root, config); mutate(config, scanned); scanned = scan(root, config);
  return { scanned, result: evaluateRules(scanned, config, { schemaVersion: 1, factBaseline: baseline, exceptions: [] }, { root }) };
}
const clean = result => assert.deepEqual(result.violations, []);
const denied = (result, rule) => assert.ok(result.violations.some(item => item.rule === rule), JSON.stringify(result.violations));
const queryBoundary = () => boundary('ARCH-BIZOP-QUERY', { protectedScopes: [{ path: 'src/read.js', functionPath: null }] });
const taskBoundary = () => boundary('ARCH-TASK-ADAPTER', { protectedScopes: [{ path: 'src/main.js', functionPath: 'run' }],
  restrictedApis: [{ path: 'src/position.js', exportNames: null, operations: [] }] });
const registryFiles = {
  'src/composition.js': "const {write}=require('./repository'); const {createRegistry}=require('./registry'); exports.createRegistry=createRegistry; exports.runDomain=()=>write();",
  'src/registry.js': "class Registry { get(){return 1;} } function createRegistry(){return new Registry();} module.exports={createRegistry};",
  'src/repository.js': "exports.write=()=>catalog.db.prepare('DELETE FROM facts').run();"
};

test('release Q3 只读 registry 导出不继承同一 composition 的未调用领域写入', t => {
  clean(fixture(t, { ...registryFiles, 'src/read.js': "const {createRegistry}=require('./composition'); exports.read=()=>createRegistry().get();" }, queryBoundary()).result);
  denied(fixture(t, { ...registryFiles, 'src/read.js': "const c=require('./composition'); exports.read=()=>c.runDomain();" }, queryBoundary()).result, 'ARCH-BIZOP-QUERY');
});

test('release Q3 import/reexport 选择仍沿真实 helper 追踪 raw DB', t => {
  for (const read of [
    "const {read}=require('./helper');exports.run=()=>read();",
    "const h=require('./helper');const chosen=h.read.bind(null);exports.run=()=>chosen();",
    "import {read} from './forward.mjs'; export function run(){read();}"
  ]) {
    denied(fixture(t, { 'src/read.js': read,
      'src/helper.js': "exports.read=()=>catalog.db.prepare('SELECT * FROM facts').all();",
      'src/forward.mjs': "export {read} from './helper.js';" }, queryBoundary()).result, 'ARCH-BIZOP-QUERY');
  }
});

test('release Q3 工厂返回函数/成员和实例方法里的 raw DB 不因精确选中而漏检', t => {
  const cases = [
    ["exports.make=()=>()=>catalog.db.prepare('SELECT * FROM facts');", 'h.make()()'],
    ["exports.make=()=>({read(){catalog.db.prepare('SELECT * FROM facts');},safe(){return 1;}});", 'h.make().read()'],
    ["class Reader{read(){catalog.db.prepare('SELECT * FROM facts');}}exports.make=()=>new Reader();", 'h.make().read()']
  ];
  for (const [helper, call] of cases) { denied(fixture(t, { 'src/read.js': `const h=require('./helper');exports.run=()=>${call};`,
    'src/helper.js': helper }, queryBoundary()).result, 'ARCH-BIZOP-QUERY'); }
  clean(fixture(t, { 'src/read.js': "const h=require('./helper');exports.run=()=>h.make().safe();", 'src/helper.js': cases[1][0] }, queryBoundary()).result);
});

test('release Q3 require 顶层副作用和 helper 直接回调仍受保护', t => {
  for (const helper of [
    "catalog.db.prepare('SELECT * FROM facts');exports.read=()=>1;",
    "exports.read=()=>[1].map(()=>catalog.db.prepare('SELECT * FROM facts'));",
    "exports.read=()=>setImmediate(()=>catalog.db.prepare('SELECT * FROM facts'));"
  ]) denied(fixture(t, { 'src/read.js': "const h=require('./helper');exports.run=()=>h.read();", 'src/helper.js': helper }, queryBoundary()).result, 'ARCH-BIZOP-QUERY');
});

test('release Q3 Main读取worker常量不执行worker-only分支，实际启动worker仍检查该分支', t => {
  const worker = "const {isMainThread,parentPort}=require('node:worker_threads');exports.TABLE='rows';if(!isMainThread){parentPort.on('message',()=>catalog.db.prepare('SELECT * FROM facts'));}";
  clean(fixture(t, { 'src/read.js': "const {TABLE}=require('./worker');exports.read=()=>TABLE;", 'src/worker.js': worker }, queryBoundary()).result);
  denied(fixture(t, { 'src/read.js': "const {Worker}=require('node:worker_threads');const path=require('node:path');exports.read=()=>new Worker(path.join(__dirname,'worker.js'));", 'src/worker.js': worker }, queryBoundary()).result, 'ARCH-BIZOP-QUERY');
  denied(fixture(t, { 'src/read.js': "require('./worker');", 'src/worker.js': worker.replace('!isMainThread', 'isMainThread') }, queryBoundary()).result, 'ARCH-BIZOP-QUERY');
});

test('release Q3 require.resolve 仅解释路径；真实 require 不继承这种语义', t => {
  const source = "exports.read=()=>require.resolve('./helper');";
  const initial = fixture(t, { 'src/read.js': source, 'src/helper.js': "catalog.db.prepare('SELECT * FROM facts');" }, queryBoundary(), (config, scanned) => {
    const dynamic = scanned.dynamicSites[0];
    config.dynamicLoads.push({ from: dynamic.from, functionPath: dynamic.functionPath, evidenceId: dynamic.evidenceId,
      allowedTargets: ['src/helper.js'], reason: '固定 require.resolve 路径，只解释不执行目标模块。' });
  });
  // 合同加入后必须重新扫描，动态加载边仍保留，但查询调用闭包不执行 resolver 目标。
  clean(initial.result);
  assert.ok(initial.scanned.edges.some(edge => edge.to === 'src/helper.js' && edge.callee === 'require.resolve'));
  denied(fixture(t, { 'src/read.js': source.replace('require.resolve', 'require'), 'src/helper.js': "catalog.db.prepare('SELECT * FROM facts');" }, queryBoundary()).result, 'ARCH-BIZOP-QUERY');
});

test('release G2 合法 registry 调用不执行 composition 内未调用的 Position 注册', t => {
  const files = {
    'src/main.js': "const c=require('./composition');function run(){return c.createRegistry().get();}",
    'src/composition.js': "const p=require('./position');const {createRegistry}=require('./registry');exports.createRegistry=createRegistry;exports.compose=()=>p.settle();",
    'src/registry.js': registryFiles['src/registry.js'],
    'src/position.js': 'exports.settle=()=>{};'
  };
  clean(fixture(t, files, taskBoundary()).result);
  denied(fixture(t, { ...files, 'src/main.js': files['src/main.js'].replace('c.createRegistry().get()', 'c.compose()') }, taskBoundary()).result, 'ARCH-TASK-ADAPTER');
});

test('release G2 精确授权初始化收口后仍拒绝其他位置的私有 helper 调用', t => {
  const source = "const p=require('./position');function initialize(){p.settle();}function run(){initialize();}";
  const files = { 'src/main.js': source, 'src/position.js': 'exports.settle=()=>{};' };
  let allowed;
  clean(fixture(t, files, taskBoundary(), (config, scanned) => {
    const site = scanned.sites.find(s => s.type === 'call' && s.functionPath === 'run');
    allowed = { rule: 'ARCH-TASK-ADAPTER', from: site.from, functionPath: site.functionPath, callee: site.callee,
      evidenceId: site.evidenceId, reason: '准确验证的独立初始化装配事务；仅该调用位置合法。' };
    config.boundaries[0].allowedSites.push(allowed);
  }).result);
  denied(fixture(t, { ...files, 'src/main.js': source.replace('initialize();}', 'initialize();p.settle();}') },
    { ...taskBoundary(), allowedSites: [allowed] }).result, 'ARCH-TASK-ADAPTER');
  const whole = taskBoundary(); whole.protectedScopes = [{ path: 'src/main.js', functionPath: null }];
  denied(fixture(t, files, whole).result, 'ARCH-TASK-ADAPTER');
});

test('release G7 namespace仅具名静态消费，两个目标按各自准确合同判断', t => {
  const a = 'src/backend/a.js'; const b = 'src/backend/b.js';
  const rule = boundary('ARCH-DESCRIPTOR-COMPOSITION', { compositionEntrypoints: [
    { path: 'src/compose.js', allowedTargets: [a], importedNames: ['createA'] },
    { path: 'src/compose.js', allowedTargets: [b], importedNames: ['createB'] }
  ] });
  const files = { 'src/compose.js': "const a=require('./backend/a');const b=require('./backend/b');a.createA();b.createB();",
    [a]: 'exports.createA=()=>{};exports.createB=()=>{};', [b]: 'exports.createB=()=>{};' };
  const good = fixture(t, files, rule); clean(good.result);
  assert.deepEqual(good.scanned.edges.find(e => e.to === a).importedNames, ['createA']);
  for (const source of [files['src/compose.js'].replace('a.createA()', 'a.createB()'),
    files['src/compose.js'] + 'consume(a);', files['src/compose.js'] + 'a.createA = opaque;', files['src/compose.js'].replace('a.createA()', 'a[unknown]()')])
    denied(fixture(t, { ...files, 'src/compose.js': source }, rule).result, 'ARCH-DESCRIPTOR-COMPOSITION');
});

test('release UMD真实global别名与静态IIFE导出被识别，普通helper不能冒充已导出工厂', t => {
  for (const other of ['globalThis', 'null']) {
    const source = `(function(root){if(root)root.Feature=(function(){function createFeature(){return 1;}return {createFeature};})();})(typeof window!=='undefined'?window:${other});`;
    const { scanned } = fixture(t, { 'src/feature.js': source }, boundary('ARCH-CYCLE'));
    assert.ok(scanned.globals.some(g => g.type === 'global-write' && g.name === 'Feature'));
    assert.equal(factoryPresent(scanned, { path: 'src/feature.js', name: 'createFeature' }), true);
  }
  for (const source of [
    'function make(){function createFeature(){}return {createFeature};}window.Feature=make();',
    'window.Feature=(function(){function hidden(){}return {hidden};})();'
  ]) assert.equal(factoryPresent(fixture(t, { 'src/feature.js': source }, boundary('ARCH-CYCLE')).scanned,
    { path: 'src/feature.js', name: 'createFeature' }), false);
});

test('release Q3 真实同步调用的 imported、返回及对象回调沿参数能力传播', t => {
  const helper = "exports.query=catalog=>catalog.db.prepare('SELECT 1').all();exports.create=()=>catalog=>catalog.db.prepare('SELECT 1').all();";
  const local = "function query(catalog){return catalog.db.prepare('SELECT 1').all();}";
  const variants = [
    ["function invoke(fn,catalog){return fn(catalog);}", 'invoke(h.query,catalog)'],
    ["function invoke(fn,catalog){return fn(catalog);}", 'invoke(h.create(),catalog)'],
    ["function invoke(service,catalog){return service.query(catalog);}", 'invoke({query},catalog)'],
    ["function invoke({query},catalog){return query(catalog);}", 'invoke({query:h.query},catalog)'],
    ["function invoke(service,catalog){return forward(service,catalog);}function forward(service,catalog){return service.query(catalog);}", 'invoke({query:h.query},catalog)'],
    ["function wrap(service){return service;}function invoke(service,catalog){return service.query(catalog);}", 'invoke(wrap({query:h.query}),catalog)']
  ];
  for (const [setup, call] of variants) {
    const source = `const h=require('./helper');${local}${setup}function read(catalog){return ${call};}module.exports={read};`;
    const b = queryBoundary(); b.protectedScopes[0].functionPath = 'read';
    denied(fixture(t, { 'src/read.js': source, 'src/helper.js': helper }, b).result, 'ARCH-BIZOP-QUERY');
  }
  // 仅传递/保存未被执行的危险成员不应污染本次 safe 读取。
  const b = queryBoundary(); b.protectedScopes[0].functionPath = 'read';
  clean(fixture(t, { 'src/read.js': `${local}function invoke(service){return service.safe();}function read(){return invoke({query,safe(){return 1;}});}` }, b).result);
});

test('release G2 同步helper不能通过参数、对象成员或返回回调隐藏Position能力', t => {
  for (const [setup, call] of [
    ['function invoke(fn){return fn();}', 'invoke(p.settle)'],
    ['function invoke(service){return service.settle();}', 'invoke({settle:p.settle})'],
    ['function identity(fn){return fn;}function invoke(fn){return fn();}', 'invoke(identity(p.settle))']
  ]) denied(fixture(t, { 'src/main.js': `const p=require('./position');${setup}function run(){return ${call};}`,
    'src/position.js': 'exports.settle=()=>{};' }, taskBoundary()).result, 'ARCH-TASK-ADAPTER');
});


test('release helper 动态执行成员无法解释时失败关闭，不能用未知键隐藏查询或状态操作', t => {
  const q = queryBoundary(); q.protectedScopes[0].functionPath = 'read';
  denied(fixture(t, { 'src/read.js': "function invoke(service,key,catalog){return service[key](catalog);}function query(catalog){return catalog.db.prepare('SELECT 1');}function read(catalog,key){return invoke({query},key,catalog);}" }, q).result, 'ARCH-STATIC-COVERAGE');
  denied(fixture(t, { 'src/main.js': "const p=require('./position');function invoke(service,key){return service[key]();}function run(key){return invoke({settle:p.settle},key);}",
    'src/position.js': 'exports.settle=()=>{};' }, taskBoundary()).result, 'ARCH-STATIC-COVERAGE');
});


test('release Q3 导出的CJS/ESM类构造器及实例方法继续受保护', t => {
  for (const [helper, read] of [
    ["module.exports=class Reader{constructor(){catalog.db.prepare('SELECT 1');}};", "const Reader=require('./helper');new Reader();"],
    ["export default class Reader{constructor(){catalog.db.prepare('SELECT 1');}}", "import Reader from './helper.mjs';new Reader();"],
    ["export class Reader{read(){catalog.db.prepare('SELECT 1');}}", "import {Reader} from './helper.mjs';new Reader().read();"]
  ]) denied(fixture(t, { 'src/read.js': read, [read.includes('helper.mjs') ? 'src/helper.mjs' : 'src/helper.js']: helper }, queryBoundary()).result, 'ARCH-BIZOP-QUERY');
});


test('release 动态数据键不等于动态callee，静态方法名仍沿参数追踪且未知候选失败', t => {
  const q = queryBoundary(); q.protectedScopes[0].functionPath = 'read';
  clean(fixture(t, { 'src/read.js': "function read(rows,key){return rows[key].find(item=>item.ok);}" }, q).result);
  const source = "const h=require('./helper');function invoke(service,key,catalog){return service[key](catalog);}function read(catalog){return invoke(h,'query',catalog);}";
  denied(fixture(t, { 'src/read.js': source, 'src/helper.js': "exports.query=c=>c.db.prepare('SELECT 1');" }, q).result, 'ARCH-BIZOP-QUERY');
  denied(fixture(t, { 'src/read.js': "function invoke(service,key){return service[key]();}function read(key){return invoke({safe(){return 1;}},flag?'safe':key);}" }, q).result, 'ARCH-STATIC-COVERAGE');
});
