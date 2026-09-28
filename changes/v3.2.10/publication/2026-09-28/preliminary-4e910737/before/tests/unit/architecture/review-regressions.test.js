'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const { createPolicyRepository } = require('./fixtures/policy-repository');
const cliPath = path.resolve(__dirname, '../../../scripts/check-architecture.js');
const baseline = '1'.repeat(40);
function boundary(rule, overrides = {}) {
  return { id: 'review', governance: 'G8', owner: 'fixture', state: 'pending', rules: [rule], entrypoints: [],
    allowedLocal: [], allowedExternal: [], requiredConsumers: [], activationEvidence: [], protectedScopes: [],
    restrictedApis: [], allowedSites: [], compositionEntrypoints: [], globals: [], factory: null,
    allowedApiFields: {}, deprecatedEntrypoints: [], directory: null, ...overrides };
}
function fixture(t, files, boundaries, configure = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-review-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), source);
  }
  const config = { schemaVersion: 1, factBaseline: baseline, bootstrap: { factBaseline: baseline, mode: 'first-introduction' },
    boundaries: [].concat(boundaries), generatedModules: [], dynamicLoads: [], policyChanges: [] };
  const scanned = scan(root, config);
  const allowlist = { schemaVersion: 1, factBaseline: baseline, exceptions: [] };
  configure({config, allowlist, scanned, root});
  return { root, scanned, result: evaluateRules(scanned, config, allowlist, { root }) };
}
const clean = result => assert.deepEqual(result.violations, []);
const denied = (result, rule) => assert.ok(result.violations.some(v => v.rule === rule), JSON.stringify(result.violations));
function cli(f) {
  const run = spawnSync(process.execPath, [cliPath, '--root', f.root], { cwd: f.root, encoding: 'utf8' });
  assert.ifError(run.error); return run;
}

test('R1 StaticBlock 的 var/let 只遮蔽块内 require，块外真实 fs 仍受保护', t => {
  const b = boundary('ARCH-PLATFORM-CORE', { entrypoints: ['src/core.js'], allowedLocal: ['src/core.js'] });
  for (const declaration of ['var', 'let', 'const']) {
    const local = `class C { static { ${declaration} require = () => {}; require('node:fs'); } }`;
    clean(fixture(t, { 'src/core.js': local }, b).result);
    const source = `${local}\nmodule.exports = typeof require('node:fs').readFileSync;`;
    const module = { exports: null }; vm.runInNewContext(source, { require, module }); assert.equal(module.exports, 'function');
    const f = fixture(t, { 'src/core.js': source }, b);
    assert.equal(f.scanned.edges.filter(e => e.to === 'node:fs').length, 1);
    denied(f.result, 'ARCH-PLATFORM-CORE');
  }
});

test('R2 factory 仅改配置、替代未使用和旧调用残留均不能迁移；真实迁移 CLI 通过', t => {
  const f = createPolicyRepository(t);
  f.boundary.rules = ['ARCH-RENDERER-SCOPE'];
  f.boundary.factory = { path: 'src/entry.js', name: 'createProbe', parameters: ['api'] };
  f.boundary.allowedApiFields = { api: ['read'] };
  f.write('src/entry.js', 'window.createProbe = function(options) { return options; };');
  f.write('src/shell.js', 'window.createProbe({api: {read() { return 1; }}});');
  f.save(); const s1 = f.commit('S1 激活真实工厂'); assert.equal(cli(f).status, 0);
  const old = structuredClone(f.boundary.factory);
  f.boundary.factory.name = 'createReplacement';
  f.change(s1, 'factory', old, structuredClone(f.boundary.factory));
  f.write('src/shell.js', 'window.createProbe({state: {}, api: {write() {}}});'); f.save();
  assert.equal(cli(f).status, 1, '仅配置改名不能解禁');
  f.write('src/entry.js', 'window.createReplacement = function(options) { return options; };');
  assert.equal(cli(f).status, 1, '替代存在但旧消费仍在');
  f.write('src/shell.js', 'window.createReplacement({api: {read() {}}});');
  assert.equal(cli(f).status, 0, '定义与真实消费者一起迁移');
  f.write('src/shell.js', 'window.createReplacement({api: {write() {}}});');
  assert.equal(cli(f).status, 1, '新入口保持方法限制');
});

test('R2 active 工厂定义或生产调用消失要报告覆盖错误', t => {
  const b = boundary('ARCH-RENDERER-SCOPE', { state: 'active', entrypoints: ['src/controller.js'],
    factory: { path: 'src/controller.js', name: 'createProbe', parameters: ['api'] }, allowedApiFields: { api: ['read'] } });
  for (const files of [
    { 'src/controller.js': '', 'src/shell.js': 'window.createProbe({api: {read() {}}});' },
    { 'src/controller.js': 'window.createProbe = function(options) { return options; };' }
  ]) denied(fixture(t, files, b).result, 'ARCH-STATIC-COVERAGE');
});

test('R3 worker operation 候选含 recover 被拒绝，未知值失败关闭，纯 publish 允许', t => {
  const b = boundary('ARCH-PUBLICATION-RECOVERY-ENTRY', { protectedScopes: [{ path: 'src/dispatch.js', functionPath: null }] });
  for (const expression of ["'recover'", "flag ? 'recover' : 'publish'", "flag && 'recover'"]) {
    const source = `function unauthorized(worker, flag) { worker.postMessage({op: ${expression}, payload: {}}); }`;
    const messages = []; const context = { worker: { postMessage: x => messages.push(x.op) } };
    vm.runInNewContext(source + '; unauthorized(worker, true);', context); assert.equal(messages[0], 'recover');
    denied(fixture(t, { 'src/dispatch.js': source }, b).result, 'ARCH-PUBLICATION-RECOVERY-ENTRY');
  }
  for (const source of [
    'function go(worker, op) { worker.postMessage({op}); }',
    'function go(worker, message) { worker.postMessage(message); }',
    'function go(op) { runWorkerJob("worker", op, {}); }'
  ]) denied(fixture(t, { 'src/dispatch.js': source }, b).result, 'ARCH-STATIC-COVERAGE');
  clean(fixture(t, { 'src/dispatch.js': "function go(worker, flag) { worker.postMessage({op: flag ? 'publish' : 'prepare'}); }" }, b).result);
});

test('R4 具名任务作用域按来源检查 mutable alias 和本地 helper，不依赖 Position 变量名', t => {
  const b = boundary('ARCH-TASK-ADAPTER', { protectedScopes: [{ path: 'src/main.js', functionPath: 'runArchiveAwareOperation' }],
    restrictedApis: [{ path: 'src/position.js', exportNames: ['settle'], operations: [] }] });
  for (const alias of ['const settle = position.settle;', 'let settle = position.settle;', 'let settle; settle = position.settle;', 'function helper(){position.settle();} let settle = helper;']) {
    const source = `const position = require('./position'); ${alias} function runArchiveAwareOperation(){settle();}`;
    let calls = 0; vm.runInNewContext(source + '; runArchiveAwareOperation();', { require: () => ({ settle: () => calls++ }) }); assert.equal(calls, 1);
    denied(fixture(t, { 'src/main.js': source, 'src/position.js': 'exports.settle=()=>{};' }, b).result, 'ARCH-TASK-ADAPTER');
  }
  clean(fixture(t, { 'src/main.js': 'function runArchiveAwareOperation(adapter){adapter.execute();}' }, b).result);
});

test('R5 getter 的 DB 句柄保留方法身份并失败关闭，query facade 允许', t => {
  const b = boundary('ARCH-BIZOP-QUERY', { protectedScopes: [{ path: 'src/query.js', functionPath: 'read' }] });
  const source = "function getHandle(catalog){return catalog.db;} function read(catalog){const handle=getHandle(catalog);return handle.prepare('SELECT * FROM facts').all();}";
  const sql = []; vm.runInNewContext(source + '; read(catalog);', { catalog: { db: { prepare: x => { sql.push(x); return {all: () => []}; } } } });
  assert.deepEqual(sql, ['SELECT * FROM facts']);
  denied(fixture(t, { 'src/query.js': source }, b).result, 'ARCH-STATIC-COVERAGE');
  denied(fixture(t, { 'src/query.js': "function read(catalog){return catalog.db.prepare('SELECT * FROM facts').all();}" }, b).result, 'ARCH-BIZOP-QUERY');
  clean(fixture(t, { 'src/query.js': 'function read(catalog){return catalog.queries.find();}' }, b).result);
});

function rendererBoundary() {
  return boundary('ARCH-RENDERER-SCOPE', { entrypoints: ['src/controller.js'],
    factory: { path: 'src/controller.js', name: 'createProbe', parameters: ['api'] }, allowedApiFields: { api: ['scenarios.list'] } });
}
test('R6 scoped API 不接受 helper 返回值、条件对象及嵌套 full API', t => {
  for (const api of ['window.desktopApi', 'getApi()', 'flag ? {scenarios:{list(){}}} : getApi()', '{scenarios: getApi()}', '{scenarios: window.desktopApi}']) {
    const f = fixture(t, { 'src/controller.js': 'window.createProbe = options => options;',
      'src/shell.js': `function getApi(){return window.desktopApi;} window.createProbe({api: ${api}});` }, rendererBoundary());
    assert.ok(f.result.violations.some(v => ['ARCH-RENDERER-SCOPE', 'ARCH-STATIC-COVERAGE'].includes(v.rule)), api);
  }
});

test('R7 装配依据执行模式：defer/module/async 不能当作同步先行脚本', t => {
  const service = boundary('ARCH-RENDERER-SCOPE', { id: 'service', entrypoints: ['src/service.js'], globals: [{ path: 'src/service.js', exportsGlobal: ['service'], consumesGlobals: [] }] });
  const consumer = boundary('ARCH-RENDERER-SCOPE', { id: 'consumer', entrypoints: ['src/controller.js'], allowedLocal: ['src/service.js'], globals: [{ path: 'src/controller.js', exportsGlobal: [], consumesGlobals: ['service'] }] });
  const sources = { 'src/service.js': 'window.service={read(){}};', 'src/controller.js': 'window.service.read();' };
  for (const mode of ['defer', 'type="module"', 'async']) {
    denied(fixture(t, { ...sources, 'index.html': `<script ${mode} src="src/service.js"></script><script src="src/controller.js"></script>` }, [service, consumer]).result, 'ARCH-RENDERER-SCOPE');
  }
  for (const html of [
    '<script src="src/service.js"></script><script src="src/controller.js"></script>',
    '<script defer src="src/service.js"></script><script defer src="src/controller.js"></script>',
    '<script defer src="src/controller.js"></script><script src="src/service.js"></script>'
  ]) clean(fixture(t, { ...sources, 'index.html': html }, [service, consumer]).result);
  for (const html of [
    '<template><script src="src/service.js"></script></template><script src="src/controller.js"></script>',
    '<template><template></template><script src="src/service.js"></script></template><script src="src/controller.js"></script>'
  ]) denied(fixture(t, { ...sources, 'index.html': html }, [service, consumer]).result, 'ARCH-STATIC-COVERAGE');
});

test('R8 Worker 相对路径按仓库 cwd，与真实 Node Worker 结果一致而非 launcher 目录', t => {
  const f = fixture(t, {
    'src/launcher.cjs': "const {Worker}=require('node:worker_threads'); new Worker('./src/worker.cjs');",
    'src/worker.cjs': "console.log('worker-ran');",
    'src/src/worker.cjs': "throw new Error('wrong base');"
  }, boundary('ARCH-CYCLE'));
  const runtime = spawnSync(process.execPath, ['src/launcher.cjs'], {cwd: f.root, encoding: 'utf8', timeout: 10000});
  assert.equal(runtime.status, 0, runtime.stderr); assert.match(runtime.stdout, /worker-ran/);
  clean(f.result);
  assert.deepEqual(f.scanned.edges.filter(e => e.kind === 'worker').map(e => e.to), ['src/worker.cjs']);
});

test('R9 dotted API 白名单逐叶匹配，合法嵌套方法通过，额外方法/spread 失败', t => {
  for (const [api, valid] of [
    ['{scenarios: {list() {return [];}}}', true],
    ['Object.freeze({scenarios: Object.freeze({list(){}})})', true],
    ['{scenarios: {list(){}, write(){}}}', false],
    ['{scenarios: {...other, list(){}}}', false],
    ['{scenarios: {get list(){return other;}}}', false]
  ]) {
    const f = fixture(t, { 'src/controller.js': 'window.createProbe = options => options;', 'src/shell.js': `window.createProbe({api: ${api}});` }, rendererBoundary());
    if (valid) clean(f.result); else assert.ok(f.result.violations.length, api);
  }
});

test('R10 父函数扩大保护 CLI 通过，反向缩小和同前缀兄弟范围拒绝', t => {
  const f = createPolicyRepository(t);
  f.boundary.rules = ['ARCH-BIZOP-QUERY'];
  f.boundary.protectedScopes = [{path: 'src/entry.js', functionPath: 'collect.inner'}];
  f.write('src/entry.js', 'function collect(){function inner(){} function innerOther(){}}');
  f.save(); f.commit('S1 激活嵌套函数'); assert.equal(cli(f).status, 0);
  f.boundary.protectedScopes[0].functionPath = 'collect'; f.save(); assert.equal(cli(f).status, 0);
  f.commit('S2 扩大保护到父函数');
  f.boundary.protectedScopes[0].functionPath = 'collect.inner'; f.save(); assert.equal(cli(f).status, 1);
  f.boundary.protectedScopes[0].functionPath = 'collect.innerOther'; f.save(); assert.equal(cli(f).status, 1);
});


test('R3 精确历史动态 op 不能复制到新函数或在 active 沿用，退出通知仅准确允许', t => {
  const source = 'function send(worker, op){worker.postMessage({op});}';
  const b = boundary('ARCH-PUBLICATION-RECOVERY-ENTRY', { protectedScopes: [{path:'src/dispatch.js',functionPath:null}] });
  let saved;
  clean(fixture(t, {'src/dispatch.js':source}, b, ({scanned,allowlist}) => {
    const site = scanned.sites.find(s => s.type === 'call');
    saved = {id:'old-op',rule:'ARCH-STATIC-COVERAGE',from:site.from,evidenceId:site.evidenceId,functionPath:site.functionPath,
      originalCommit:baseline,reason:'固定基线旧动态操作待授权迁移',governance:'G1',removeWhen:'完成授权事务并激活后删除'};
    allowlist.exceptions.push(saved);
  }).result);
  denied(fixture(t, {'src/dispatch.js':source.replace('send(', 'other(')}, b, ({allowlist}) => allowlist.exceptions.push(saved)).result, 'ARCH-STATIC-COVERAGE');
  denied(fixture(t, {'src/dispatch.js':source}, {...b,state:'active',governance:'G1'}, ({allowlist}) => allowlist.exceptions.push(saved)).result, 'ARCH-STATIC-COVERAGE');
  const notification = 'function onExit(notify, op){notify({op});}';
  let exact;
  clean(fixture(t, {'src/dispatch.js':notification}, b, ({scanned,config}) => {
    const site = scanned.sites.find(s => s.type === 'call');
    exact={rule:'ARCH-PUBLICATION-RECOVERY-ENTRY',from:site.from,functionPath:site.functionPath,callee:site.callee,evidenceId:site.evidenceId,reason:'退出通知不发送 worker 指令'};
    config.boundaries[0].allowedSites=[exact];
  }).result);
  denied(fixture(t, {'src/dispatch.js':notification.replace('notify({op})', 'notify({op: "recover"})')}, {...b,allowedSites:[exact]}).result, 'ARCH-PUBLICATION-RECOVERY-ENTRY');
});

test('R4 未知 factory 可变别名失败关闭，明确的参数默认回调通过', t => {
  const b=boundary('ARCH-TASK-ADAPTER',{protectedScopes:[{path:'src/task.js',functionPath:'run'}]});
  denied(fixture(t,{'src/task.js':'let settle = unknownFactory(); function run(){settle();}'},b).result,'ARCH-STATIC-COVERAGE');
  clean(fixture(t,{'src/task.js':'function run(options){const {execute = () => {}} = options; execute();}'},b).result);
});

test('R4 合法调用精确登记不能传给同函数的另一个 AST 位置', t => {
  const b=boundary('ARCH-TASK-ADAPTER',{protectedScopes:[{path:'src/task.js',functionPath:'run'}]});
  let saved;
  clean(fixture(t,{'src/task.js':'function run(){let values = getPaths();values = values.concat([]);}'},b,({scanned,config})=>{
    const site=scanned.sites.find(s=>s.type==='call'&&s.method==='concat');
    saved={rule:'ARCH-TASK-ADAPTER',from:site.from,functionPath:site.functionPath,callee:site.callee||site.method,evidenceId:site.evidenceId,reason:'已核对数组拼接职责'};
    config.boundaries[0].allowedSites=[saved];
  }).result);
  denied(fixture(t,{'src/task.js':'function run(){let values = getPaths();values = values.concat([other]);}'},{...b,allowedSites:[saved]}).result,'ARCH-STATIC-COVERAGE');
});

test('R5 RegExp.exec 是合法文本解析，不与未知 handle.exec 混同', t => {
  const b=boundary('ARCH-BIZOP-QUERY',{protectedScopes:[{path:'src/query.js',functionPath:null}]});
  clean(fixture(t,{'src/query.js':'function read(text){const date = /[0-9]+/;return date.exec(text);}'},b).result);
  denied(fixture(t,{'src/query.js':'function read(){return getHandle().exec("SELECT 1");}'},b).result,'ARCH-STATIC-COVERAGE');
});

test('R8 path.resolve 的相对参数使用扫描根目录，不受检查器进程 cwd 影响', t => {
  const f=fixture(t,{'src/launcher.js':"const {Worker}=require('node:worker_threads');const path=require('node:path');new Worker(path.resolve('src/worker.js'));",'src/worker.js':''},boundary('ARCH-CYCLE'));
  clean(f.result);assert.deepEqual(f.scanned.edges.filter(e=>e.kind==='worker').map(e=>e.to),['src/worker.js']);
});
