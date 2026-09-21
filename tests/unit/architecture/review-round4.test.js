'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const policy = require('../../../architecture/boundaries.json');
const operation = 'settlePositionArchiveResult';
const privateFunction = `function ${operation}(){calls.push('settled');}`;
const pureFunction = "function executePure(){calls.push('pure');}";
function fixture(t, source, configure = () => {}, file = 'src/main.js', extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-r4-regression-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  for (const [name, text] of Object.entries({[file]:source,...extraFiles})) {
    fs.mkdirSync(path.dirname(path.join(root,name)), {recursive:true});fs.writeFileSync(path.join(root,name),text);
  }
  const boundary=structuredClone(policy.boundaries.find(b=>b.id==='business-task-adapters'));
  const config={...policy,boundaries:[boundary],generatedModules:[],dynamicLoads:[],policyChanges:[]};
  configure(boundary);
  const scanned=scan(root,config);
  return {root,scanned,result:evaluateRules(scanned,config,{schemaVersion:1,factBaseline:policy.factBaseline,exceptions:[]},{root})};
}
function runtime(source, expected, invoke = 'runArchiveAwareOperation()') {
  const calls=[];vm.runInNewContext(source+';'+invoke,{calls});assert.deepEqual(calls,expected);
}
const denied=result=>assert.ok(result.violations.some(v=>v.rule==='ARCH-TASK-ADAPTER'),JSON.stringify(result.violations));
const clean=result=>assert.deepEqual(result.violations,[]);

test('R4-01 同文件受限操作经返回成员调用，与直接/包装调用一致拒绝', t => {
  const source=privateFunction+`function createService(){return {settle:${operation}};}const service=createService();function runArchiveAwareOperation(){service.settle();}`;
  runtime(source,['settled']);denied(fixture(t,source).result);
  for(const body of [`${operation}();`,`const service={settle(){${operation}();}};service.settle();`]) {
    const control=privateFunction+`function runArchiveAwareOperation(){${body}}`;runtime(control,['settled']);denied(fixture(t,control).result);
  }
  const allowed=pureFunction+'function createService(){return {settle:executePure};}const service=createService();function runArchiveAwareOperation(){service.settle();}';
  runtime(allowed,['pure']);clean(fixture(t,allowed).result);
});

test('R4-01 全部登记的本地操作经嵌套、别名、候选与绑定都受限', t => {
  const operations=policy.boundaries.find(b=>b.id==='business-task-adapters').restrictedApis.find(api=>api.path==='src/main.js').operations;
  assert.ok(operations.includes(operation));
  for(const name of operations) {
    const variants=[
      [`function createService(){return {settle:${name}};}const service=createService();`,'service.settle()'],
      [`const invoke=${name};function createService(){return {group:{settle:invoke}};}const service=createService();`,'service.group.settle()'],
      [`function createService(){return {settle:${name}};}const service=createService();const invoke=service.settle;`,'invoke()'],
      [`function createService(flag){return flag?{settle:${name}}:{settle:executePure};}const service=createService(true);`,'service.settle()'],
      [`function createService(){return {settle:${name}};}const service=createService();const invoke=service.settle.bind(service);`,'invoke()'],
      [`function createService(){return {settle:${name}};}const service=createService();`,'service.settle.call(service)'],
      [`function createService(){return {settle:${name}};}const service=createService();`,'service.settle.apply(service,[])']
    ];
    for(const [setup,invoke] of variants) {
      const source=`function ${name}(){calls.push('settled');}`+pureFunction+setup+`function runArchiveAwareOperation(){${invoke};}`;
      runtime(source,['settled']);denied(fixture(t,source).result);
    }
  }
});

test('R4-01 配置绑定解析到函数表达式、const 与 bound 别名的实际身份', t => {
  for(const definition of [
    `const ${operation}=()=>calls.push('settled');`,
    `const ${operation}=function performSettlement(){calls.push('settled');};`,
    `function performSettlement(){calls.push('settled');}const ${operation}=performSettlement;`,
    `function performSettlement(){calls.push('settled');}const ${operation}=performSettlement.bind(null);`
  ]) {
    for(const invoke of [`${operation}()`, 'service.settle()']) {
      const source=definition+`function createService(){return {settle:${operation}};}const service=createService();function runArchiveAwareOperation(){${invoke};}`;
      runtime(source,['settled']);denied(fixture(t,source).result);
    }
  }
});

test('R4-01 精确词法身份不误伤局部同名、显式注入和独立 composition', t => {
  const controls=[
    [privateFunction+`function createService(){function ${operation}(){calls.push('pure');}return {settle:${operation}};}const service=createService();function runArchiveAwareOperation(){service.settle();}`, 'runArchiveAwareOperation()'],
    [privateFunction+`function runArchiveAwareOperation(){function ${operation}(){calls.push('pure');}${operation}();}`, 'runArchiveAwareOperation()'],
    [privateFunction+`function runArchiveAwareOperation(${operation}){${operation}();}`, "runArchiveAwareOperation(()=>calls.push('pure'))"],
    [privateFunction+pureFunction+`function createService(){return {settle:${operation},execute:executePure};}const service=createService();function runArchiveAwareOperation(){service.execute();}`, 'runArchiveAwareOperation()'],
    [privateFunction+pureFunction+`function compose(){${operation}();}function runArchiveAwareOperation(adapter){adapter.execute();}`, 'runArchiveAwareOperation({execute:executePure})']
  ];
  for(const [source,invoke] of controls) {runtime(source,['pure'],invoke);clean(fixture(t,source).result);}
});

test('R4-01 同名函数在其他源文件不继承 Main 的 operation 限制', t => {
  const source=privateFunction+`function createService(){return {settle:${operation}};}const service=createService();function runArchiveAwareOperation(){service.settle();}`;
  clean(fixture(t,source,b=>{b.protectedScopes=[{path:'src/other.js',functionPath:'runArchiveAwareOperation'}];},'src/other.js').result);
});

test('R4-01 精确 allowedSite 仍有效，迁移调用作用域不能继承授权', t => {
  const source=privateFunction+`function createService(){return {settle:${operation}};}const service=createService();function runArchiveAwareOperation(){service.settle();}`;
  const initial=fixture(t,source);
  const site=initial.scanned.sites.find(s=>s.type==='call'&&s.functionPath==='runArchiveAwareOperation');
  const allowed={rule:'ARCH-TASK-ADAPTER',from:site.from,functionPath:site.functionPath,callee:site.callee||site.method,evidenceId:site.evidenceId,reason:'fixture 中已审查的准确合法调用，用于验证授权不可搬迁。'};
  clean(fixture(t,source,b=>b.allowedSites.push(allowed)).result);
  const moved=source.replace('function runArchiveAwareOperation(){service.settle();}', 'function runArchiveAwareOperation(){function invoke(){service.settle();}invoke();}');
  denied(fixture(t,moved,b=>b.allowedSites.push(allowed)).result);
});


test('R4-01 已登记的 Main 导入操作保留直接调用保护', t => {
  const source=`const {${operation}}=require('./operation-lifecycle');function runArchiveAwareOperation(){${operation}();}`;
  denied(fixture(t,source,()=>{},'src/main.js',{'src/operation-lifecycle.js':`exports.${operation}=()=>{};`}).result);
});
