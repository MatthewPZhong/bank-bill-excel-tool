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
const modulePath = './main-process/position-reconciliation/operation-lifecycle';
const imported = `const {${operation}}=require('${modulePath}');`;
const factory = `function makeSettlement(){return function performSettlement(){calls.push('settled');};}const ${operation}=makeSettlement();`;
const service = `function createService(){return {settle:${operation}};}const service=createService();`;
const protectedCall = invocation => `function runArchiveAwareOperation(){${invocation};}`;
function fixture(t, source, configure = () => {}, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-r5-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { 'src/main.js': source,
    [`src/${modulePath.slice(2)}.js`]: `exports.${operation}=()=>{};exports.executePure=()=>{};`, ...extraFiles };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const boundary = structuredClone(policy.boundaries.find(b => b.id === 'business-task-adapters'));
  // 最小调用图 fixture 仍执行规则，不继承真实 release 的整套入口激活证据。
  boundary.state = 'pending';
  configure(boundary);
  const config = { ...policy, boundaries: [boundary], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  const scanned = scan(root, config);
  return { root, scanned, result: evaluateRules(scanned, config,
    { schemaVersion: 1, factBaseline: policy.factBaseline, exceptions: [] }, { root }) };
}
function runtime(source, expected) {
  const calls = [];
  const exports = { [operation]: () => calls.push('settled'), executePure: () => calls.push('pure') };
  vm.runInNewContext(source + ';runArchiveAwareOperation();', { calls, flag: true, require: () => exports });
  assert.deepEqual(calls, expected);
}
const denied = result => assert.ok(result.violations.some(v => v.rule === 'ARCH-TASK-ADAPTER'), JSON.stringify(result.violations));
const clean = result => assert.deepEqual(result.violations, []);

test('R5-01 生产同源导入的受限 operation 经工厂返回成员也被拒绝', t => {
  const source = imported + service + protectedCall('service.settle()');
  runtime(source, ['settled']);
  const { result, scanned } = fixture(t, source);
  assert.deepEqual(scanned.dynamicSites, []);
  denied(result);
  denied(fixture(t, imported + protectedCall(`${operation}()`)).result);
  denied(fixture(t, imported + `function createService(){return {settle(){${operation}();}};}const service=createService();` + protectedCall('service.settle()')).result);
});

test('R5-01 受限 operation 的本地工厂初始化与调用使用同一函数身份', t => {
  for (const invocation of [`${operation}()`, 'service.settle()']) {
    const source = factory + service + protectedCall(invocation);
    runtime(source, ['settled']);
    denied(fixture(t, source).result);
  }
});

test('R5-01 导入绑定的服务成员、嵌套别名、候选及 bind/call/apply 都保留身份', t => {
  const definitions = [
    imported,
    `const lifecycle=require('${modulePath}');const ${operation}=lifecycle.${operation};`,
    `const {${operation}:selected}=require('${modulePath}');const ${operation}=selected;`,
    `const {${operation}:selected}=require('${modulePath}');const ${operation}=selected.bind(null);`
  ];
  const routes = [
    [service, 'service.settle()'],
    [`function createService(){return {group:{settle:${operation}}};}const service=createService();const send=service.group.settle;`, 'send()'],
    [`function createService(){return flag?{settle:${operation}}:{settle(){calls.push('pure');}};}const service=createService();`, 'service.settle()'],
    [service + 'const send=service.settle.bind(service);', 'send()'],
    [service, 'service.settle.call(service)'],
    [service, 'service.settle.apply(service,[])'],
    [`function createService(){return {settle:${operation}};}const {settle:send}=createService();`, 'send()']
  ];
  for (const definition of definitions) for (const [setup, invocation] of routes) {
    const source = definition + setup + protectedCall(invocation);
    runtime(source, ['settled']); denied(fixture(t, source).result);
  }
});

test('R5-01 ES import 的默认、具名与 namespace 配置绑定按完整导出身份检查', t => {
  for (const definition of [
    `import {${operation}} from '${modulePath}.js';`,
    `import {${operation} as chosen} from '${modulePath}.js';const ${operation}=chosen;`,
    `import * as lifecycle from '${modulePath}.js';const ${operation}=lifecycle.${operation};`,
    `import ${operation} from '${modulePath}.js';`
  ]) denied(fixture(t, definition + service + protectedCall('service.settle()')).result);
});

test('R5-01 本地返回函数经过配置别名、嵌套工厂与 destructuring 都不能绕过', t => {
  for (const definition of [
    factory,
    `function makeSettlement(){return ()=>calls.push('settled');}const ${operation}=makeSettlement();`,
    `function makeSettlement(){return function performSettlement(){calls.push('settled');};}const chosen=makeSettlement();const ${operation}=chosen.bind(null);`,
    `function makeSettlement(){return function performSettlement(){calls.push('settled');};}function outer(){return makeSettlement();}const ${operation}=outer();`,
    `function makeService(){return {settle(){calls.push('settled');},execute(){calls.push('pure');}};}const {settle:${operation}}=makeService();`,
    `function makeService(){return {group:{settle(){calls.push('settled');}}};}const {group:{settle:${operation}}}=makeService();`,
    `function performSettlement(){calls.push('settled');}const {chosen:${operation}}={chosen:performSettlement};`
  ]) {
    for (const invocation of [`${operation}()`, 'service.settle()']) {
      const source = definition + service + protectedCall(invocation);
      runtime(source, ['settled']); denied(fixture(t, source).result);
    }
  }
});

test('R5-01 同工厂其他方法和工厂调用本身不继承返回能力的禁令', t => {
  const definitions = [
    `function makeService(){return {settle(){calls.push('settled');},execute(){calls.push('pure');}};}const service=makeService();const ${operation}=service.settle;`,
    `function makeService(){return {settle:function execute(){calls.push('settled');},execute:function execute(){calls.push('pure');}};}const service=makeService();const ${operation}=service.settle;`,
    `function makeService(){return {settle(){calls.push('settled');},execute(){calls.push('pure');}};}const {settle:${operation},execute}=makeService();const service={execute};`
  ];
  for (const definition of definitions) {
    const source = definition + protectedCall('makeService();service.execute()');
    runtime(source, ['pure']); clean(fixture(t, source).result);
    denied(fixture(t, definition + protectedCall(`${operation}()`)).result);
  }
});

test('R5-01 同模块其他导出与其他模块同名导出不被扩大禁用', t => {
  const variants = [
    imported + `const {executePure}=require('${modulePath}');function makeService(){return {settle:${operation},execute:executePure};}const service=makeService();`,
    `const {nested:{${operation}}}=require('${modulePath}');const {executePure}=require('${modulePath}');const service={execute:executePure};`,
    imported + `const {${operation}:execute}=require('./other');const service={execute};`
  ];
  for (const setup of variants) clean(fixture(t, setup + protectedCall('service.execute()'), () => {}, {
    'src/other.js': `exports.${operation}=()=>{};`
  }).result);
  const source = variants[0] + protectedCall('service.execute()');
  runtime(source, ['pure']);
  // 同一模块的不同嵌套成员不能因末段方法名相同而混为一谈。
  const nested = `const lib=require('${modulePath}');const ${operation}=lib.position.settle;const service={execute:lib.pure.settle};`;
  clean(fixture(t, nested + protectedCall('service.execute()')).result);
  denied(fixture(t, nested + protectedCall(`${operation}()`)).result);
});

test('R5-01 局部遮蔽、显式参数注入与独立 composition 仍合法', t => {
  for (const definition of [imported, factory]) {
    for (const body of [
      `function ${operation}(){calls.push('pure');}const service={settle:${operation}};service.settle();`,
      `const ${operation}=()=>calls.push('pure');${operation}();`,
      `function invoke(${operation}){${operation}();}invoke(()=>calls.push('pure'));`
    ]) {
      const source = definition + protectedCall(body);
      runtime(source, ['pure']); clean(fixture(t, source).result);
    }
    clean(fixture(t, definition + service + 'function domainComposition(){service.settle();}function runArchiveAwareOperation(adapter){adapter.execute();}').result);
  }
});

test('R5-01 未解释的配置绑定明确报 coverage，不用原始拼写当作解析成功', t => {
  for (const definition of [
    `const make=require('${modulePath}').make;const ${operation}=make();`,
    `const ${operation}=unknownFactory();`,
    `function make(){return make();}const ${operation}=make();`,
    `function make(){return flag?()=>{}:unknownFactory();}const ${operation}=make();`
  ]) {
    const result = fixture(t, definition + service + protectedCall('service.settle()')).result;
    assert.ok(result.violations.some(v => v.rule === 'ARCH-STATIC-COVERAGE' && v.message.includes('配置绑定')), JSON.stringify(result.violations));
  }
});

test('R5-01 导入与工厂初始化目标仍按准确 allowedSite 授权，作用域搬迁不能复用', t => {
  for (const definition of [imported, factory]) {
    const source = definition + service + protectedCall('service.settle()');
    const initial = fixture(t, source);
    const site = initial.scanned.sites.find(s => s.type === 'call' && s.functionPath === 'runArchiveAwareOperation');
    const allowed = { rule: 'ARCH-TASK-ADAPTER', from: site.from, functionPath: site.functionPath,
      callee: site.callee || site.method, evidenceId: site.evidenceId, reason: 'fixture 中核对过的准确装配位置，禁止移动后继承授权。' };
    clean(fixture(t, source, b => b.allowedSites.push(allowed)).result);
    const moved = definition + service + protectedCall('function forward(){service.settle();}forward()');
    denied(fixture(t, moved, b => b.allowedSites.push(allowed)).result);
  }
});

test('R5-01 let/var 解构及后续赋值按选中成员检查，其他成员仍合法', t => {
  for (const kind of ['let', 'var']) {
    const definition = `${kind} {${operation},executePure}=require('${modulePath}');`;
    const bad = definition + service + protectedCall('service.settle()');
    runtime(bad, ['settled']); denied(fixture(t, bad).result);
    const good = definition + protectedCall('executePure()');
    runtime(good, ['pure']); clean(fixture(t, good).result);
    const reassigned = `function performSettlement(){calls.push('settled');}${kind} {chosen:${operation}}={chosen:()=>{}};${operation}=performSettlement;`;
    const source = reassigned + service + protectedCall('service.settle()');
    runtime(source, ['settled']); denied(fixture(t, source).result);
  }
});

test('R5-01 同名具名函数表达式的不同工厂返回值按实际 AST 身份区分', t => {
  const definition = `const makeSettlement=function create(){return function act(){calls.push('settled');};};
    const makePure=function create(){return function act(){calls.push('pure');};};
    const ${operation}=makeSettlement();const execute=makePure();`;
  const good = definition + protectedCall('execute()');
  runtime(good, ['pure']); clean(fixture(t, good).result);
  const bad = definition + service + protectedCall('service.settle()');
  runtime(bad, ['settled']); denied(fixture(t, bad).result);
});
