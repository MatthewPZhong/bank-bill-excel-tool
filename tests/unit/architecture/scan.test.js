'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan, parse, parseScripts, createAnalysis, fingerprint } = require('../../../scripts/architecture/scan');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

function targets(result, from = 'src/main.js') {
  return result.edges.filter((edge) => edge.from === from).map((edge) => [edge.to, edge.kind]);
}

test('CJS/ESM/re-export、const 模板及本地 JSON 解析，共同口径单独去重', (t) => {
  const root = fixture(t, {
    'src/main.js': "const name='./dep'; const load=require; load(name); require('./dep'); require(`./dep`); require('./config.json'); require('fs/promises');",
    'src/module.mjs': "import { value as local } from './dep.js'; export { value } from './dep.js'; export * from './dep.js'; import('./dep.js');",
    'src/dep.js': 'exports.value=1;', 'src/config.json': '{}'
  });
  const result = scan(root);
  assert.equal(result.coverage.scannedFiles, 3);
  assert.equal(result.coverage.literalEdges, 2);
  assert.equal(result.parseErrors.length, 0);
  assert.ok(targets(result).some(([to]) => to === 'src/config.json'));
  assert.ok(targets(result).some(([to]) => to === 'node:fs/promises'));
  assert.deepEqual(new Set(result.edges.filter((edge) => edge.from === 'src/module.mjs').map((edge) => edge.kind)), new Set(['import', 'export', 'dynamic-import']));
  assert.deepEqual(result.edges.find((edge) => edge.kind === 'import').importedNames, ['value']);
});

test('require/window/globalThis 的函数、block、catch 遮蔽及 var 提升不制造依赖', (t) => {
  const root = fixture(t, {
    'src/main.js': `function a(require, window) { require('./missing'); window.Other(); }
      { const require = () => {}; require('./missing2'); }
      try {} catch (globalThis) { globalThis.Other(); }
      function b() { require('./hoisted'); var require; }
      require('./dep'); window.Other();`, 'src/dep.js': '', 'src/other.js': ''
  });
  const config = { boundaries: [{ id: 'global', entrypoints: ['src/other.js'], globals: [{ path: 'src/other.js', exportsGlobal: ['Other'] }] }] };
  const result = scan(root, config);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(targets(result), [['src/dep.js', 'require'], ['src/other.js', 'classic-global']]);
});

test('不可变别名解析 Worker/path.join/resolve/URL，候选集完整形成 worker 边', (t) => {
  const root = fixture(t, {
    'src/main.js': `const {Worker: W}=require('worker_threads'); const path=require('node:path');
      const entry=path.join(__dirname,'worker.js'); const Launch=W; new Launch(entry);
      const {fork}=require('node:child_process'); fork(path.resolve(__dirname,'worker.js'));
      new W(flag ? path.join(__dirname,'worker.js') : path.join(__dirname,'second.cjs'));`,
    'src/url.mjs': "import {Worker} from 'node:worker_threads'; new Worker(new URL('./worker.js', import.meta.url));",
    'src/worker.js': '', 'src/second.cjs': ''
  });
  const result = scan(root);
  assert.equal(result.dynamicSites.length, 0);
  assert.equal(result.coverage.workerEdges, 5);
  assert.ok(result.edges.some((edge) => edge.from === 'src/url.mjs' && edge.kind === 'worker' && edge.to === 'src/worker.js'));
});

test('非字面量 loader、未知 worker 和 createRequire/resolve 登记具体指纹，合同目标进入图', (t) => {
  const root = fixture(t, {
    'src/main.js': `const load=require; load(name); import(other);
      const { Worker }=require('node:worker_threads'); new Worker(filename);
      require.resolve('./dep'); const {createRequire}=require('node:module'); createRequire(filename);`,
    'src/dep.js': ''
  });
  const first = scan(root);
  assert.equal(first.dynamicSites.length, 5);
  assert.ok(first.dynamicSites.every((site) => /^[a-f0-9]{64}$/.test(site.evidenceId) && site.line > 0));
  const result = scan(root, { dynamicLoads: first.dynamicSites.map((site) => ({ from: site.from, functionPath: site.functionPath, evidenceId: site.evidenceId, allowedTargets: ['src/dep.js'] })) });
  assert.equal(result.edges.filter((edge) => edge.dynamic).length, 5);
  assert.ok(result.edges.some((edge) => edge.kind === 'worker' && edge.to === 'src/dep.js'));
});

test('路径大小写、本地缺失、仓库越界不能静默解析', (t) => {
  const root = fixture(t, { 'src/main.js': "require('./thing'); require('./absent'); require('../../outside');", 'src/Thing.js': '' });
  assert.deepEqual(scan(root).unresolved.map((entry) => entry.reason), ['case-mismatch', 'missing', 'outside-root']);
});

test('拒绝仓库外 symlink，内部 symlink 与循环有明确覆盖结果', (t) => {
  const root = fixture(t, { 'src/main.js': "require('./escape.js');", 'src/okay.js': '' });
  fs.symlinkSync(os.tmpdir(), path.join(root, 'src', 'outside'));
  fs.symlinkSync(path.join(os.tmpdir(), 'outside.js'), path.join(root, 'src', 'escape.js'));
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src', 'loop'));
  const result = scan(root);
  assert.ok(result.unresolved.some((entry) => entry.reason === 'symlink-outside-root'));
  assert.ok(result.unresolved.some((entry) => entry.reason === 'symlink-cycle'));
});

test('每个生产扩展名必有解析结果，测试及生成目录不进入生产图', (t) => {
  const root = fixture(t, {
    'src/a.js': 'function {', 'src/b.cjs': 'export const value=1;', 'src/c.mjs': 'export const okay=1;',
    'src/fixtures/invalid.js': 'function {', 'tests/a.js': 'function {', 'dist/a.js': 'function {'
  });
  const result = scan(root);
  assert.equal(result.coverage.scannedFiles, 3);
  assert.equal(result.coverage.parsedFiles, 1);
  assert.deepEqual(result.parseErrors.map((error) => error.from), ['src/a.js', 'src/b.cjs']);
});

test('HTML tokenizer 识别属性顺序/单双引号并忽略注释与非执行 script', () => {
  const scripts = parseScripts(`<!-- <script src='fake.js'></script> -->
    <script data-x='>' defer src="./src/first.js"></script>
    <script src='./src/second.js' type='module'></script>
    <script type='application/json'>{"fake":"<script src='x'>"}</script>`);
  assert.deepEqual(scripts.map((script) => script.src), ['./src/first.js', './src/second.js']);
  assert.equal(scripts[0].defer, true);
  assert.throws(() => parseScripts('<script src="broken></script>'), /未关闭/);
  assert.throws(() => parseScripts('<script src="a" src="b"></script>'), /重复/);
});

test('classic 全局别名与自由工厂读形成边；外部/inline/missing script 明示覆盖失败', (t) => {
  const root = fixture(t, {
    'src/factory.js': 'window.Factory=()=>{};',
    'src/main.js': 'const browser=window; browser.Factory(); Factory(); function local(Factory) { Factory(); }',
    'index.html': '<script src="./src/factory.js"></script><script src="src/main.js"></script><script src="https://x.test/x.js"></script><script>run()</script><script src="./missing.js"></script>'
  });
  const config = { boundaries: [{ id: 'factory', entrypoints: ['src/factory.js'], globals: [{ path: 'src/factory.js', exportsGlobal: ['Factory'] }] }] };
  const result = scan(root, config);
  assert.equal(result.coverage.globalEdges, 2);
  assert.deepEqual(result.scripts.slice(0, 2).map((script) => script.path), ['src/factory.js', 'src/main.js']);
  assert.deepEqual(result.unresolved.map((entry) => entry.reason), ['non-local-script', 'inline-script-not-covered', 'missing']);
});

test('modalRoot 经 elements/context/const/default parameter 追溯，普通 DOM remove 不误报', (t) => {
  const root = fixture(t, { 'src/main.js': `const elements={modalRoot:document.getElementById('modalRoot')};
    const alias=elements.modalRoot; alias.innerHTML=''; alias.appendChild(document.createElement('div'));
    function nested(context) { const {elements}=context; elements.modalRoot.replaceChildren(); }
    function withDefault({modalRoot=document.querySelector('#modalRoot')}) { modalRoot.appendChild(overlay); }
    const overlay=document.createElement('div'); alias.appendChild(overlay); const copy=overlay; copy.remove();
    const row=document.createElement('tr'); row.remove();` });
  const result = scan(root);
  const writes = result.sites.filter((site) => site.type === 'modal-write');
  assert.equal(writes.length, 6);
  assert.equal(writes.filter((site) => site.operation === 'remove').length, 1);
});

test('治理操作点回溯 imported API、catalog.db alias、SQL 与 factory scoped 实参', (t) => {
  const root = fixture(t, {
    'src/main.js': `const {recover: raw}=require('./api'); const again=raw; again('recover');
      function collect(catalog) { const db=catalog.db; db.prepare('SELECT * FROM archive_artifacts'); }
      function privateState() { const state={own:true}; Factory({api:{read:()=>{}},panel:state}); }
      window.Factory({api:window.desktopApi});`, 'src/api.js': 'exports.recover=()=>{};'
  });
  const result = scan(root);
  const recover = result.sites.find((site) => site.type === 'call' && site.operation === 'recover');
  assert.deepEqual(recover.binding, { from: 'src/api.js', importedNames: ['recover'] });
  assert.equal(result.sites.find((site) => site.type === 'db-operation').callee, 'catalog.db.prepare');
  assert.equal(result.sites.find((site) => site.type === 'db-operation').sql.value, 'SELECT * FROM archive_artifacts');
  const factory = result.sites.find((site) => site.type === 'call' && site.callee === 'Factory');
  assert.equal(factory.args[0].properties.panel.bindingFunctionPath, 'privateState');
  assert.deepEqual(factory.args[0].properties.api.properties.read.kind, 'function');
});

test('反射与非字面量全局成员显式记录；同名局部对象不被当作浏览器', (t) => {
  const root = fixture(t, { 'src/main.js': `window[key](); const browser=globalThis; browser[key](); eval(code); new Function(code);
    function local(window, eval) { window[key](); eval(code); }` });
  const result = scan(root);
  assert.equal(result.sites.filter((site) => site.type === 'reflection').length, 4);
});

test('规范 AST 指纹不随空白/注释改变，相同函数内重复点按 occurrence 区分', (t) => {
  const root = fixture(t, { 'src/main.js': "function run(){require(name);require(name);}" });
  const first = scan(root);
  fs.writeFileSync(path.join(root, 'src/main.js'), 'function run() {\n // 注释\n require ( name );\nrequire(name);\n}');
  const next = scan(root);
  assert.deepEqual(first.dynamicSites.map((site) => site.evidenceId), next.dynamicSites.map((site) => site.evidenceId));
  assert.notEqual(first.dynamicSites[0].evidenceId, first.dynamicSites[1].evidenceId);
  assert.equal(fingerprint(parse('let n=1;', 'x.js').body[0]), fingerprint(parse('let n = 1; // 注释', 'x.js').body[0]));
});

test('扫描只解析源码不执行副作用，重复输入输出排序确定', (t) => {
  const root = fixture(t, { 'src/main.js': "require('node:fs').writeFileSync('/must-not-be-created','side effect'); throw new Error('do not run');" });
  const before = fs.readFileSync(path.join(root, 'src/main.js'));
  const a = scan(root); const b = scan(root);
  assert.deepEqual(a.coverage, b.coverage);
  assert.deepEqual(a.edges, b.edges);
  assert.deepEqual(a.sites, b.sites);
  assert.deepEqual(fs.readFileSync(path.join(root, 'src/main.js')), before);
});

test('分析 helper 公开 scope、parent 与 canonical const alias，不读取生产执行值', (t) => {
  const root = fixture(t, { 'src/main.js': '' });
  const ast = parse('function outer(catalog) { const db=catalog.db; function inner(){ db.exec(sql); } }', 'src/main.js');
  const analysis = createAnalysis(ast, 'src/main.js', root);
  const call = analysis.nodes.find((node) => node.type === 'CallExpression');
  assert.equal(analysis.functionPath(call), 'outer.inner');
  assert.deepEqual(analysis.describe(call.callee).chain, ['catalog', 'db', 'exec']);
  assert.equal(analysis.parents.get(call).type, 'ExpressionStatement');
});

test('Worker 注入候选、可变 Electron alias、helper 返回与局部普通构造器有区别', (t) => {
  const root = fixture(t, {
    'src/main.js': `const {Worker}=require('node:worker_threads'); const path=require('node:path');
      const WorkerClass=options.WorkerClass || Worker; new WorkerClass(path.join(__dirname,'worker.js'));
      function start({Constructor=Worker}) { new Constructor(filename); }
      let utility; utility=require('electron').utilityProcess; utility.fork(path.join(__dirname,'worker.js'));
      function loadUtility(){const electron=require('electron'); return electron ? electron.utilityProcess : null;}
      const workerHost=provided || loadUtility(); workerHost.fork(path.join(__dirname,'worker.js'));
      function local(){const Worker=class {}; new Worker('./not-a-production-worker.js');}`,
    'src/worker.js': ''
  });
  const result = scan(root);
  assert.equal(result.coverage.workerEdges, 3);
  assert.equal(result.dynamicSites.filter((site) => site.kind === 'worker').length, 1);
  assert.equal(result.unresolved.length, 0);
});

test('scoped API 的 Object.freeze 保留字段来源，全量 API 冻结及 Object 遮蔽不被误认为安全', (t) => {
  const root = fixture(t, { 'src/main.js': `const scoped=Object.freeze({read:()=>{}}); Factory({api:scoped});
    Factory({api:Object.freeze(window.desktopApi)});
    function local(Object){Factory({api:Object.freeze({read:()=>{}})});}` });
  const factories = scan(root).sites.filter((site) => site.type === 'call' && site.callee === 'Factory');
  assert.equal(factories[0].args[0].properties.api.kind, 'object');
  assert.equal(factories[0].args[0].properties.api.properties.read.kind, 'function');
  assert.deepEqual(factories[1].args[0].properties.api.chain, ['window', 'desktopApi']);
  assert.equal(factories[2].args[0].properties.api.kind, 'call-result');
});

test('模块加载方法和绑定别名记录真实能力，局部 module/globalThis/require 遮蔽不误报', (t) => {
  const root = fixture(t, { 'src/main.js': `module.require('node:fs'); globalThis.require('node:fs');
    const load=require.bind(null); load('node:fs'); const opaque=identity(require);
    function local(module,globalThis,require) {module.require('node:fs');globalThis.require('node:fs');const load=require.bind(null);load('node:fs');}
    if(typeof require==='function') {} ` });
  const result = scan(root);
  assert.equal(result.edges.filter((edge) => edge.to === 'node:fs').length, 2);
  assert.equal(result.dynamicSites.length, 2);
  assert.equal(result.dynamicSites.filter((site) => site.functionPath !== null).length, 0);
});
