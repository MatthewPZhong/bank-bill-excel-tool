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

const taskBoundary = () => boundary('ARCH-TASK-ADAPTER', { protectedScopes: [{path:'src/main.js',functionPath:'run'}], restrictedApis:[{path:'src/position.js',exportNames:['settle'],operations:[]}] });
const recoveryBoundary = () => boundary('ARCH-PUBLICATION-RECOVERY-ENTRY', {protectedScopes:[{path:'src/dispatch.js',functionPath:null}]});
const queryBoundary = () => boundary('ARCH-BIZOP-QUERY', {protectedScopes:[{path:'src/query.js',functionPath:'read'}]});
const rendererBoundary = () => boundary('ARCH-RENDERER-SCOPE', {entrypoints:['src/controller.js'],factory:{path:'src/controller.js',name:'createProbe',parameters:['panel','api']},allowedApiFields:{panel:['querySelector','querySelectorAll'],api:['import','scenarios.list']}});
function renderer(t, expression, setup = '') {
  return fixture(t, {'src/controller.js':'window.createProbe = options => options;', 'src/shell.js': setup + `window.createProbe(${expression});`},rendererBoundary()).result;
}

test('R2-01 工厂来源检查传递闭包；局部 getter 的 const/let 返回值同样受保护', t => {
  const cases = [
    "const {create}=require('./task-factory'); const service=create(); function run(){service.settle();}",
    "const position=require('./position'); function getSettle(){return position.settle;} const settle=getSettle(); function run(){settle();}",
    "const position=require('./position'); function getSettle(){return position.settle;} let settle=getSettle(); function run(){settle();}"
  ];
  for(const source of cases) {
    let calls=0;vm.runInNewContext(source+';run();',{require:name=> name==='./task-factory'?{create:()=>({settle:()=>calls++})}:{settle:()=>calls++}});assert.equal(calls,1);
    const f=fixture(t,{'src/main.js':source,'src/task-factory.js':"exports.create=()=>require('./position');",'src/position.js':'exports.settle=()=>{};'},taskBoundary());
    denied(f.result,'ARCH-TASK-ADAPTER');
  }
  clean(fixture(t,{'src/main.js':"const {create}=require('./task-factory'); const service=create();function run(){service.execute();}",'src/task-factory.js':'exports.create=()=>({execute(){}});'},taskBoundary()).result);
});

test('R2-02 bound postMessage 保留消息及部分实参；未知操作失败关闭', t => {
  for(const code of [
    'const send=worker.postMessage.bind(worker);send(message);',
    'const send=worker.postMessage.bind(worker,message);send();',
    'worker.postMessage.call(worker,message);',
    'worker.postMessage.apply(worker,[message]);'
  ]) {
    const source=`function sendMessage(worker,message){${code}}`;
    let op;vm.runInNewContext(source+';sendMessage(worker,{op:"recover"});',{worker:{postMessage:m=>op=m.op}});assert.equal(op,'recover');
    denied(fixture(t,{'src/dispatch.js':source},recoveryBoundary()).result,'ARCH-STATIC-COVERAGE');
  }
  clean(fixture(t,{'src/dispatch.js':'function sendMessage(worker){const send=worker.postMessage.bind(worker);send({op:"publish"});}'},recoveryBoundary()).result);
  denied(fixture(t,{'src/dispatch.js':'function sendMessage(worker){const send=worker.postMessage.bind(worker,{op:"recover"});send();}'},recoveryBoundary()).result,'ARCH-PUBLICATION-RECOVERY-ENTRY');
});

test('R2-03 bound prepare/exec 保留 DB 身份；getter 后的别名不能隐藏 SQL', t => {
  for(const code of [
    "const prepare=handle.prepare.bind(handle);return prepare('SELECT * FROM facts').all();",
    "const prepare=handle.prepare.bind(handle,'SELECT * FROM facts');return prepare().all();",
    "return handle.prepare.call(handle,'SELECT * FROM facts').all();",
    "return handle.prepare.apply(handle,['SELECT * FROM facts']).all();"
  ]) {
    const source=`function getHandle(catalog){return catalog.db;}function read(catalog){const handle=getHandle(catalog);${code}}`;
    const sql=[];vm.runInNewContext(source+';read(catalog);',{catalog:{db:{prepare:s=>{sql.push(s);return {all:()=>[]};}}}});assert.deepEqual(sql,['SELECT * FROM facts']);
    denied(fixture(t,{'src/query.js':source},queryBoundary()).result,'ARCH-STATIC-COVERAGE');
  }
  clean(fixture(t,{'src/query.js':'function read(text){const pattern=/[0-9]+/;const exec=pattern.exec.bind(pattern);return exec(text);}'},queryBoundary()).result);
});

test('R2-04 单个 DOM panel 来源合法；document/全局根/动态节点/API 注入仍拒绝', t => {
  const panel={nodeType:1};let received;vm.runInNewContext("window.createProbe({panel:document.getElementById('bank-statement-panel')});",{document:{getElementById:()=>panel},window:{createProbe:input=>received=input}});assert.equal(received.panel,panel);
  for(const expression of ["document.getElementById('bank-statement-panel')", "document.querySelector('#bank-statement-panel')", "Object.freeze(document.getElementById('bank-statement-panel'))"]) {
    clean(renderer(t,'{panel,api:{import(){}}}',`const panel=${expression};`));
  }
  for(const expression of ['document','document.body','window.desktopApi',"document.getElementById('modalRoot')",'document.getElementById(id)',"document.querySelector('body')",'getPanel()']) {
    assert.ok(renderer(t,`{panel:${expression},api:{import(){}}}`).violations.length,expression);
  }
  assert.ok(renderer(t,"{api:document.getElementById('bank-statement-panel')}").violations.length);
});

test('R2-05 scoped API 可以精确挑选方法，不能夹带完整 API/namespace/未授权成员', t => {
  let received,calls=0;vm.runInNewContext('window.createProbe({api:Object.freeze({import:window.desktopApi.bankStatement.import})});',{window:{desktopApi:{bankStatement:{import:()=>calls++,run(){}}},createProbe:input=>received=input}});received.api.import();assert.equal(calls,1);assert.deepEqual(Object.keys(received.api),['import']);
  for(const expression of [
    '{api:Object.freeze({import:window.desktopApi.bankStatement.import})}',
    '{api:{import:desktopApi.bankStatement.import}}',
    '{api:{scenarios:{list:window.desktopApi.scenarios.list}}}'
  ]) clean(renderer(t,expression));
  for(const expression of [
    '{api:window.desktopApi}', '{api:window.desktopApi.bankStatement}',
    '{api:{import:window.desktopApi}}', '{api:{import:window.desktopApi.bankStatement}}',
    '{api:{run:window.desktopApi.bankStatement.run}}', '{api:{scenarios:window.desktopApi.scenarios}}',
    '{api:{scenarios:{list:window.desktopApi.channels.list}}}'
  ]) assert.ok(renderer(t,expression).violations.length,expression);
});

test('R2-06 active 工厂按公开导出解析具名表达式、const alias、对象导出；私有同名不算', t => {
  const f=createPolicyRepository(t);f.boundary.rules=['ARCH-RENDERER-SCOPE'];
  f.boundary.factory={path:'src/entry.js',name:'createProbe',parameters:['api']};f.boundary.allowedApiFields={api:['read']};
  f.write('src/shell.js','window.createProbe({api:{read(){return 1;}}});');
  for(const source of [
    'window.createProbe=function buildController(options){return options;};',
    'const buildController=options=>options;window.createProbe=buildController;',
    'const buildController=options=>options;window.group=Object.freeze({createProbe:buildController});',
    'function buildController(options){return options;}module.exports={createProbe:buildController};'
  ]) { f.write('src/entry.js',source);f.write('src/shell.js',(source.includes('module.exports') ? "require('./entry').createProbe" : source.includes('window.group') ? 'window.group.createProbe' : 'window.createProbe') + '({api:{read(){return 1;}}});');f.save();const result=cli(f);assert.equal(result.status,0,result.stdout+result.stderr); }
  f.write('src/entry.js','function createProbe(options){return options;}');f.save();assert.equal(cli(f).status,1);
  f.write('src/entry.js','window.createProbe=unknown();');f.save();assert.equal(cli(f).status,1);
});

function scripts(t,html) {
  return fixture(t,{'src/service.js':'window.service={read(){}};','src/controller.js':'window.service.read();','index.html':html},[
    boundary('ARCH-RENDERER-SCOPE',{id:'service',entrypoints:['src/service.js'],globals:[{path:'src/service.js',exportsGlobal:['service'],consumesGlobals:[]}]}),
    boundary('ARCH-RENDERER-SCOPE',{id:'consumer',entrypoints:['src/controller.js'],allowedLocal:['src/service.js'],globals:[{path:'src/controller.js',exportsGlobal:[],consumesGlobals:['service']}]})
  ]);
}
test('R2-07 前序同步 provider 确定先于 async consumer，反向和异步 provider 不保证', t => {
  clean(scripts(t,'<script src="src/service.js"></script><script async src="src/controller.js"></script>').result);
  for(const html of [
    '<script async src="src/controller.js"></script><script src="src/service.js"></script>',
    '<script async src="src/service.js"></script><script src="src/controller.js"></script>',
    '<script defer src="src/service.js"></script><script async src="src/controller.js"></script>'
  ]) denied(scripts(t,html).result,'ARCH-RENDERER-SCOPE');
});

test('R2-08 fork 两种 options 重载尊重静态 cwd，与真实子进程一致', t => {
  for(const call of [
    "fork('./src/worker.cjs',{cwd:path.join(__dirname,'jobs')});",
    "fork('./src/worker.cjs',[],{cwd:path.join(__dirname,'jobs')});"
  ]) {
    const f=fixture(t,{'src/launcher.cjs':"const {fork}=require('node:child_process');const path=require('node:path');"+call,
      'src/worker.cjs':"throw Error('wrong root');",'src/src/worker.cjs':"throw Error('wrong module');",'src/jobs/src/worker.cjs':"console.log('expected-worker');"},boundary('ARCH-CYCLE'));
    const runtime=spawnSync(process.execPath,['src/launcher.cjs'],{cwd:f.root,encoding:'utf8',timeout:10000});assert.equal(runtime.status,0,runtime.stderr);assert.match(runtime.stdout,/expected-worker/);
    clean(f.result);assert.deepEqual(f.scanned.edges.filter(e=>e.kind==='worker').map(e=>e.to),['src/jobs/src/worker.cjs']);
  }
});

test('R2-09 textarea/title/raw text 内的伪 template 结束标记不激活惰性脚本', t => {
  for(const name of ['textarea','title','style','xmp','iframe','noembed','noframes','noscript']) {
    const html=`<template><${name}></template></${name}><script src="src/service.js"></script></template><script src="src/controller.js"></script>`;
    const f=scripts(t,html);assert.deepEqual(f.scanned.scripts.map(s=>s.path),['src/controller.js'],name);denied(f.result,'ARCH-STATIC-COVERAGE');
  }
});

test('R2-01 未知 const/let 工厂结果失败关闭，已解析纯本地返回函数允许', t => {
  for(const keyword of ['const','let']) denied(fixture(t,{'src/main.js':`${keyword} settle=externalFactory();function run(){settle();}`},taskBoundary()).result,'ARCH-STATIC-COVERAGE');
  clean(fixture(t,{'src/main.js':'function getExecute(){return () => 1;}const execute=getExecute();function run(){execute();}'},taskBoundary()).result);
  denied(fixture(t,{'src/main.js':'function getExecute(){return getExecute();}const execute=getExecute();function run(){execute();}'},taskBoundary()).result,'ARCH-STATIC-COVERAGE');
});

test('R2-02/03 多次绑定、解构和候选别名保持相同敏感能力', t => {
  for(const body of [
    'const {postMessage}=worker;const send=postMessage.bind(worker);send(message);',
    'const once=worker.postMessage.bind(worker,message);const twice=once.bind(null);twice();',
    'let send=worker.postMessage.bind(worker);send(message);',
    'const send=flag?worker.postMessage.bind(worker):worker.postMessage.bind(worker);send(message);',
    'worker.postMessage.bind(worker).call(null,message);',
    'worker.postMessage.apply(worker,args);'
  ]) denied(fixture(t,{'src/dispatch.js':`function sendMessage(worker,message,flag,args){${body}}`},recoveryBoundary()).result,'ARCH-STATIC-COVERAGE');
  for(const method of ['prepare','exec']) {
    denied(fixture(t,{'src/query.js':`function read(catalog){const invoke=catalog.db.${method}.bind(catalog.db);invoke('SELECT 1');}`},queryBoundary()).result,'ARCH-BIZOP-QUERY');
  }
});

test('R2-04/05 DOM/API 原生对象的局部 const 别名合法，未知或全对象仍不能替代', t => {
  clean(renderer(t,'{panel,api:{import:importFile}}',"const doc=document;const panel=doc.getElementById('bank-statement-panel');const {import:importFile}=window.desktopApi.bankStatement;"));
  assert.ok(renderer(t,'{api:{import:root}}','const root=window.desktopApi;').violations.length);
  assert.ok(renderer(t,'{panel:document.querySelector(selector)}').violations.length);
});

test('R2-08 动态 cwd/不可解释 options 失败关闭，静态候选和绝对目标保留准确集合', t => {
  const files={'src/a/worker.cjs':'','src/b/worker.cjs':''};
  for(const options of ['options','{cwd: supplied}', '{...options,cwd:"src/a"}']) {
    const f=fixture(t,{...files,'src/launcher.cjs':`const {fork}=require('node:child_process');fork('./worker.cjs',${options});`},boundary('ARCH-CYCLE'));
    denied(f.result,'ARCH-STATIC-COVERAGE');assert.ok(f.scanned.dynamicSites.some(s=>s.reason==='unresolved-fork-cwd'));
  }
  const f=fixture(t,{...files,'src/launcher.cjs':"const {fork}=require('node:child_process');fork('./worker.cjs',[],{cwd:flag?'src/a':'src/b'});"},boundary('ARCH-CYCLE'));
  clean(f.result);assert.deepEqual(f.scanned.edges.filter(e=>e.kind==='worker').map(e=>e.to),['src/a/worker.cjs','src/b/worker.cjs']);
  const absolute=fixture(t,{...files,'src/launcher.cjs':"const {fork}=require('node:child_process');const path=require('node:path');fork(path.join(__dirname,'a/worker.cjs'),unknownOptions);"},boundary('ARCH-CYCLE'));
  clean(absolute.result);assert.deepEqual(absolute.scanned.edges.filter(e=>e.kind==='worker').map(e=>e.to),['src/a/worker.cjs']);
  denied(fixture(t,{'src/launcher.js':"require('node:child_process').fork(99);"},boundary('ARCH-CYCLE')).result,'ARCH-STATIC-COVERAGE');
});

test('R2-08 fork 绑定与 call/apply 使用相同的路径/cwd 解析', t => {
  for(const code of [
    "const start=fork.bind(null,'./worker.cjs',[],{cwd:'src/jobs'});start();",
    "fork.call(null,'./worker.cjs',{cwd:'src/jobs'});",
    "fork.apply(null,['./worker.cjs',[],{cwd:'src/jobs'}]);"
  ]) {
    const f=fixture(t,{'src/launcher.cjs':"const {fork}=require('node:child_process');"+code,'src/jobs/worker.cjs':''},boundary('ARCH-CYCLE'));
    clean(f.result);assert.deepEqual(f.scanned.edges.filter(e=>e.kind==='worker').map(e=>e.to),['src/jobs/worker.cjs']);
  }
});
