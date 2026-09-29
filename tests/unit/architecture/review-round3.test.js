'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const policy = require('../../../architecture/boundaries.json');
const positionPath = 'src/main-process/position-reconciliation/task-owner.js';
const positionImport = "const position=require('./main-process/position-reconciliation/task-owner');";
function fixture(t, files, boundaries = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-r3-regression-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive:true});
    fs.writeFileSync(path.join(root, file), source);
  }
  const config = {...policy, boundaries, generatedModules:[], dynamicLoads:[], policyChanges:[]};
  const scanned = scan(root, config);
  return {root, scanned, result:evaluateRules(scanned, config, {schemaVersion:1, factBaseline:policy.factBaseline, exceptions:[]}, {root})};
}
function task(t, source) {
  const boundary = structuredClone(policy.boundaries.find(b => b.id === 'business-task-adapters'));
  // 此处验证最小调用图，规则仍执行；生产入口与消费者的激活闭合另由真实 release 验证。
  boundary.state = 'pending';
  return fixture(t, {'src/main.js':source, [positionPath]:'exports.settle=()=>{};'}, [boundary]);
}
const denied = (result, rule) => assert.ok(result.violations.some(v => v.rule === rule), JSON.stringify(result.violations));
const clean = result => assert.deepEqual(result.violations, []);
function forkFixture(t, call) {
  return fixture(t, {'src/launcher.cjs':"const {fork}=require('node:child_process');const path=require('node:path');"+call,
    'src/worker.cjs':"console.log('wrong-worker');", 'src/jobs/src/worker.cjs':"console.log('expected-worker');"});
}
function forkRuntime(f) {
  const result = spawnSync(process.execPath, ['src/launcher.cjs', '--example'], {cwd:f.root,encoding:'utf8',timeout:10000});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'expected-worker');
}
function correctWorker(f) {
  clean(f.result);assert.deepEqual(f.scanned.dynamicSites, []);
  assert.deepEqual(f.scanned.edges.filter(e => e.kind === 'worker').map(e => e.to), ['src/jobs/src/worker.cjs']);
}

test('R3-01 本地服务返回 Position 方法引用，与包装调用一致拒绝', t => {
  for (const returned of ['{settle:position.settle}', '{settle(){return position.settle();}}']) {
    const source=positionImport+`function createService(){return ${returned};}const service=createService();function runArchiveAwareOperation(){return service.settle();}`;
    const calls=[];vm.runInNewContext(source+';runArchiveAwareOperation();',{require:()=>({settle:()=>calls.push('Position.settle')})});
    assert.deepEqual(calls,['Position.settle']);
    const f=task(t,source);denied(f.result,'ARCH-TASK-ADAPTER');
    assert.ok(f.result.violations.some(v=>v.dependencyPath?.includes(positionPath)),JSON.stringify(f.result.violations));
  }
});

for (const [name, argv] of [['运行时数组','process.argv.slice(2)'],['undefined','undefined']]) {
  test(`R3-02 fork 三参数 ${name} 保留明确 cwd，与真实子进程一致`, t => {
    const f=forkFixture(t,`const argv=${argv};fork('./src/worker.cjs',argv,{cwd:path.join(__dirname,'jobs')});`);
    forkRuntime(f);correctWorker(f);
  });
}

test('R3-01 成员路径穿过嵌套返回、const 别名、候选和绑定，仍定位受限模块', t => {
  const cases = [
    ["function createService(){return {group:{settle:position.settle}};}const service=createService();", 'service.group.settle()'],
    ["const build=()=>({settle:position.settle});function createService(){return build();}const service=createService();", 'service.settle()'],
    ["function createService(){const picked=position.settle;return Object.freeze({settle:picked});}const service=createService();", 'service.settle()'],
    ["function createService(flag){return flag?{settle:position.settle}:{settle(){return 1;}};}const service=createService(flag);", 'service.settle()'],
    ["function createService(){return {settle:position.settle};}let service=createService();", 'service.settle()'],
    ["function createService(){return {settle:position.settle};}const service=createService();const invoke=service.settle;", 'invoke()'],
    ["function createService(){return {settle:position.settle};}const service=createService();", 'service["settle"]()'],
    ["function createService(){return {settle:position.settle};}const service=createService();const invoke=service.settle.bind(service);", 'invoke()'],
    ["function createService(){return {settle:position.settle.bind(position)};}const service=createService();", 'service.settle()']
  ];
  for (const [setup, invoke] of cases) {
    const result=task(t,positionImport+setup+`function runArchiveAwareOperation(){${invoke};}`).result;
    assert.ok(result.violations.some(v=>v.rule==='ARCH-TASK-ADAPTER'),setup+invoke+JSON.stringify(result.violations));
  }
});

test('R3-01 无法解释的返回成员失败关闭，不能退回零诊断', t => {
  for (const returned of ['{settle:externalFactory()}', '{...methods}', '{get settle(){return position.settle;}}', '{}', 'unknownService', 'createService()']) {
    denied(task(t,positionImport+`function createService(){return ${returned};}const service=createService();function runArchiveAwareOperation(){service.settle();}`).result,'ARCH-STATIC-COVERAGE');
  }
  denied(task(t,positionImport+'function createService(){return {settle:position.settle};}const service=createService();function runArchiveAwareOperation(key){service[key]();}').result,'ARCH-STATIC-COVERAGE');
});

test('R3-01 纯服务和显式 adapter 注入允许，不按整个 Main import 拒绝', t => {
  for (const source of [
    'function createService(){return {execute(){return 1;}};}const service=createService();function runArchiveAwareOperation(){return service.execute();}',
    'const execute=()=>1;function createService(){return {execute};}const service=createService();function runArchiveAwareOperation(){return service.execute();}',
    'function createService(){return {execute(){return 1;},settle:position.settle};}const service=createService();function runArchiveAwareOperation(){return service.execute();}',
    'function runArchiveAwareOperation(adapter){return adapter.execute();}function compose(){return position.settle();}',
    'function runArchiveAwareOperation(adapter){const {execute}=adapter;return execute();}',
    'function createService(adapter){return {execute:adapter.execute};}function runArchiveAwareOperation(adapter){return createService(adapter).execute();}'
  ]) clean(task(t,positionImport+source).result);
});

test('R3-02 argv 类型与已知 options 分离，null 和间接调用保持真实 cwd', t => {
  for (const call of [
    "fork('./src/worker.cjs',null,{cwd:path.join(__dirname,'jobs')});",
    "const start=fork.bind(null,'./src/worker.cjs',process.argv.slice(2),{cwd:path.join(__dirname,'jobs')});start();",
    "fork.call(null,'./src/worker.cjs',undefined,{cwd:path.join(__dirname,'jobs')});",
    "fork.apply(null,['./src/worker.cjs',process.argv.slice(2),{cwd:path.join(__dirname,'jobs')}]);",
    "fork('./src/worker.cjs',{cwd:path.join(__dirname,'jobs')},{cwd:__dirname});"
  ]) { const f=forkFixture(t,call);forkRuntime(f);correctWorker(f); }
});

test('R3-02 options 候选准确解析；未知或被对象重载覆盖的 cwd 仍报覆盖错误', t => {
  const f=forkFixture(t,"fork('./src/worker.cjs',flag?[]:{cwd:path.join(__dirname,'jobs')},{cwd:path.join(__dirname,'jobs')});");
  correctWorker(f);
  for (const call of [
    "fork('./src/worker.cjs',process.argv.slice(2),{cwd:unknown});",
    "fork('./src/worker.cjs',undefined,options);",
    "fork('./src/worker.cjs',{cwd:unknown},{cwd:path.join(__dirname,'jobs')});",
    "fork('./src/worker.cjs',unknown);"
  ]) {
    const current=forkFixture(t,call);denied(current.result,'ARCH-STATIC-COVERAGE');
    assert.ok(current.scanned.dynamicSites.some(s=>s.reason==='unresolved-fork-cwd'));
    assert.deepEqual(current.scanned.edges.filter(e=>e.kind==='worker'),[]);
  }
});


test('R3-01 本地 JSON 数据读取保持合法，reviver 或遮蔽来源不能冒充原生数据', t => {
  clean(task(t,`function read(){return JSON.parse('[]');}function runArchiveAwareOperation(){return read().slice();}`).result);
  clean(task(t,`function read(){let value;value=JSON.parse('{"files":[]}');return value;}function runArchiveAwareOperation(){return read().files.map(item=>item);}`).result);
  for (const source of [
    positionImport+`function read(){return JSON.parse('{}',()=>({slice:position.settle}));}function runArchiveAwareOperation(){read().slice();}`,
    `const JSON=externalFactory();function read(){return JSON.parse('{}');}function runArchiveAwareOperation(){read().slice();}`
  ]) assert.ok(task(t,source).result.violations.length);
});

test('R3-02 未知第二参数可能是 options 对象，不得静默只扫描第三参数 cwd', t => {
  const f=forkFixture(t,"function getArgs(){return {cwd:path.join(__dirname,'jobs')};}fork('./src/worker.cjs',getArgs(),{cwd:'.'});");
  forkRuntime(f);
  denied(f.result,'ARCH-STATIC-COVERAGE');
  assert.deepEqual(f.scanned.edges.filter(e=>e.kind==='worker'),[]);
});
