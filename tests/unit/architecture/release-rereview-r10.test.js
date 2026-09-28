'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');
const actual = require('../../../architecture/boundaries.json');

function evaluate(t, source, id = 'renderer-bank-statement') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r10-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/shell.js'), source);
  fs.writeFileSync(path.join(root, 'src/preload.js'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('desktopApi',{app:{getInfo:()=>ipcRenderer.invoke('app:get-info')}});");
  const config = {
    schemaVersion: 1, factBaseline: '1'.repeat(40),
    bootstrap: { factBaseline: '1'.repeat(40), mode: 'first-introduction' },
    boundaries: [{ ...actual.boundaries.find(boundary => boundary.id === id), state: 'pending' }],
    generatedModules: [], dynamicLoads: [], policyChanges: [],
  };
  return evaluateRules(scan(root, config), config, { schemaVersion: 1, factBaseline: config.factBaseline, exceptions: [] }, { root });
}

async function received(source, info = { backgroundConfig: {} }) {
  let input; let reads = 0;
  const capture = value => { input = value; };
  const window = {
    desktopApi: { outsideScope() { return true; }, app: { async getInfo() { reads++; return info; } } },
    BankStatementController: { createBankStatementController: capture },
    StatementController: { createStatementController: capture },
  };
  const result = await vm.runInNewContext(source, { window, flag: true });
  return { input, result, reads };
}

const mount = api => `window.BankStatementController.createBankStatementController({api:${api}});`;
const denied = result => assert.ok(result.violations.some(violation => ['ARCH-RENDERER-SCOPE', 'ARCH-STATIC-COVERAGE'].includes(violation.rule)), JSON.stringify(result.violations));
const clean = result => assert.deepEqual(result.violations, []);
const defaults = 'const shared={run(){}},provided={run(){}};function select(api=shared){return api;}';
const mutate = "if(alias && (typeof alias==='object' || typeof alias==='function'))alias.outsideScope=window.desktopApi.outsideScope;";

// 两个注入目标使用相同表达式，避免仅靠静态诊断掩盖对象身份选择错误。
const logicalCases = [
  ['undefined AND/OR', '(undefined && provided) || provided'],
  ['undefined AND/nullish', '(undefined && provided) ?? provided'],
  ['missing member AND/OR', '(({}).api && provided) || provided'],
  ['missing member AND/nullish', '(({}).api && provided) ?? provided'],
  ['null AND/OR', '(null && provided) || provided'],
  ['null AND/nullish', '(null && provided) ?? provided'],
  ['false AND/OR', '(false && provided) || provided'],
  ['zero AND/OR', '(0 && provided) || provided'],
  ['empty string AND/OR', '("" && provided) || provided'],
  ['truthy AND/OR', '(true && provided) || shared'],
  ['truthy AND/nullish', '(1 && provided) ?? shared'],
  ['known object OR', 'provided || shared'],
  ['known object nullish', 'provided ?? shared'],
  ['nested right OR', 'true && ((undefined && provided) || provided)'],
  ['nested outer AND', '((undefined && provided) ?? provided) && provided'],
  ['nested nullish and OR', '((undefined && provided) ?? null) || provided'],
  ['bound default selector', '(undefined && provided) || provided', '', 'select.bind(null,VALUE)()'],
  ['forwarded default selector', '(undefined && provided) ?? provided', 'function forward(value){return value;}', 'select(forward(VALUE))'],
  ['destructured default selector', '(undefined && provided) || provided', 'function pick({api=shared}){return api;}', 'pick({api:VALUE})'],
];
for (const [name, expression, helper = '', call = 'select(VALUE)'] of logicalCases) {
  for (const unsafe of [false, true]) test(`RR10-01 ${name} ${unsafe ? '同对象越权拒绝' : '独立默认对象允许'}`, async t => {
    const target = unsafe ? 'provided' : 'shared';
    const source = defaults + helper + `const alias=${call.replace('VALUE', expression)};` + mutate + mount(target) +
      `({sameTarget:alias===${target},sameProvided:alias===provided});`;
    const runtime = await received(source);
    assert.equal(runtime.result.sameTarget, unsafe);
    assert.equal(runtime.result.sameProvided, true);
    assert.equal(typeof runtime.input.api.outsideScope === 'function', unsafe);
    if (unsafe) assert.equal(runtime.input.api.outsideScope(), true);
    else assert.deepEqual(Object.keys(runtime.input.api), ['run']);
    const result = evaluate(t, source);
    if (unsafe) denied(result); else clean(result);
  });
}

for (const left of ['false', '0', '""']) test(`RR10-01 nullish 保留非空假值 ${left}，不引入默认对象`, async t => {
  const source = defaults + `const alias=select((${left} && provided) ?? shared);` + mutate + mount('shared') +
    `({sameShared:alias===shared,sameLeft:alias===${left}});`;
  const runtime = await received(source);
  assert.equal(runtime.result.sameShared, false);
  assert.equal(runtime.result.sameLeft, true);
  assert.deepEqual(Object.keys(runtime.input.api), ['run']);
  clean(evaluate(t, source));
});

for (const expression of ['(undefined && provided) || shared', '(undefined && provided) ?? shared', '(null && provided) ?? shared']) {
  test(`RR10-01 实际选择 shared 的对照 ${expression}`, async t => {
    const source = defaults + `const alias=select(${expression});` + mutate + mount('shared') + 'alias===shared;';
    const runtime = await received(source);
    assert.equal(runtime.result, true);
    assert.equal(runtime.input.api.outsideScope(), true);
    denied(evaluate(t, source));
  });
}

for (const operator of ['||', '??']) test(`RR10-01 未知 IPC 经 AND/${operator} 排除 undefined 默认来源`, async t => {
  const source = defaults + `async function run(){const info=await window.desktopApi.app.getInfo();const alias=select((info.api && provided) ${operator} provided);` +
    mutate + mount('shared') + 'return {sameShared:alias===shared,sameProvided:alias===provided};}run();';
  for (const value of [undefined, null, false, 0, '', true, { enabled: true }]) {
    const runtime = await received(source, { api: value });
    assert.equal(runtime.reads, 1);
    assert.equal(runtime.result.sameShared, false);
    assert.equal(runtime.result.sameProvided, operator === '||' || value == null || Boolean(value));
    assert.deepEqual(Object.keys(runtime.input.api), ['run']);
  }
  clean(evaluate(t, source));
});

for (const operator of ['||', '??']) test(`RR10-01 未知 IPC 经 AND/${operator} 保留可能选中的 shared`, async t => {
  const source = defaults + `async function run(){const info=await window.desktopApi.app.getInfo();const alias=select((info.api && provided) ${operator} shared);` +
    mutate + mount('shared') + 'return alias===shared;}run();';
  const runtime = await received(source, {});
  assert.equal(runtime.reads, 1);
  assert.equal(runtime.result, true);
  assert.equal(runtime.input.api.outsideScope(), true);
  const truthy = await received(source, { api: true });
  assert.equal(truthy.result, false);
  assert.deepEqual(Object.keys(truthy.input.api), ['run']);
  denied(evaluate(t, source));
});

for (const operator of ['||', '??']) test(`RR10-01 未知 IPC 经 AND/${operator} 的右侧 undefined 仍触发默认`, async t => {
  const source = defaults + `async function run(){const info=await window.desktopApi.app.getInfo();const alias=select((info.api && provided) ${operator} undefined);` +
    mutate + mount('shared') + 'return {sameShared:alias===shared,sameProvided:alias===provided};}run();';
  const absent = await received(source, {});
  assert.equal(absent.reads, 1);
  assert.equal(absent.result.sameShared, true);
  assert.equal(absent.input.api.outsideScope(), true);
  const truthy = await received(source, { api: true });
  assert.equal(truthy.result.sameShared, false);
  assert.equal(truthy.result.sameProvided, true);
  assert.deepEqual(Object.keys(truthy.input.api), ['run']);
  const falsy = await received(source, { api: false });
  assert.equal(falsy.result.sameShared, operator === '||');
  assert.equal(typeof falsy.input.api.outsideScope === 'function', operator === '||');
  denied(evaluate(t, source));
});

for (const unsafe of [false, true]) test(`RR10-01 逻辑简化后 ${unsafe ? '完整 API 仍拒绝' : '纯数据仍允许'}`, async t => {
  const source = `window.StatementController.createStatementController({initialInfo:(undefined && window.desktopApi) ?? ${unsafe ? 'window.desktopApi' : '{label:"safe"}'}});`;
  const runtime = await received(source);
  assert.equal(typeof runtime.input.initialInfo.outsideScope === 'function', unsafe);
  const result = evaluate(t, source, 'renderer-statement');
  if (unsafe) denied(result); else clean(result);
});

const provide = 'function provide(){return {api:{run(){}}};}const old=provide();const current=provide();';
const arrayCases = [
  ['factory empty fixed slot', 'function make(value){const args=[];args[0]=value;return args;}const list=[];list.push(...make(current));'],
  ['factory empty push', 'function make(value){const args=[];args.push(value);return args;}const list=[];list.push(...make(current));'],
  ['factory empty unshift', 'function make(value){const args=[];args.unshift(value);return args;}const list=[];list.push(...make(current));'],
  ['factory empty splice', 'function make(value){const args=[];args.splice(0,0,value);return args;}const list=[];list.push(...make(current));'],
  ['bound factory fixed slot', 'function make(value){const args=[];args[0]=value;return args;}const bound=make.bind(null,current);const list=[];list.push(...bound());'],
  ['bound factory push', 'function make(value){const args=[];args.push(value);return args;}const bound=make.bind(null,current);const list=[];list.push(...bound());'],
  ['forwarded factory fixed slot', 'function make(value){const args=[];args[0]=value;return args;}function forward(value){return make(value);}const list=[];list.push(...forward(current));'],
  ['forwarded factory push', 'function make(value){const args=[];args.push(value);return args;}function forward(value){return make(value);}const list=[];list.push(...forward(current));'],
  ['helper fills factory slot', 'function put(target,value){target[0]=value;}function make(value){const args=[];put(args,value);return args;}const list=[];list.push(...make(current));'],
  ['helper fills factory push', 'function put(target,value){target.push(value);}function make(value){const args=[];put(args,value);return args;}const list=[];list.push(...make(current));'],
  ['factory spread argument push', 'function make(value){const args=[];args.push(...[value]);return args;}const list=[];list.push(...make(current));'],
  ['factory initialized slot replacement control', 'function make(value){const args=[old];args[0]=value;return args;}const list=[];list.push(...make(current));'],
  ['literal spread factory fixed slot', 'function make(value){const args=[];args[0]=value;return args;}const list=[...make(current)];'],
  ['literal spread factory push', 'function make(value){const args=[];args.push(value);return args;}const list=[...make(current)];'],
  ['outer splice factory spread', 'function make(value){const args=[];args[0]=value;return args;}const list=[old];list.splice(...[0,1,...make(current)]);'],
];
for (const [name, setup] of arrayCases) test(`RR10-02 ${name} 保留工厂返回数组元素身份`, async t => {
  const source = provide + setup + 'const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;' + mount('current.api') + 'alias===current.api;';
  const runtime = await received(source);
  assert.equal(runtime.result, true);
  assert.equal(runtime.input.api.outsideScope(), true);
  denied(evaluate(t, source));
});

const safeArrayCases = [
  ['independent fixed-slot factory instances', 'function make(value){const args=[];args[0]=value;return args;}const first=make(old);const second=make(current);const list=[];list.push(...first);'],
  ['independent push factory instances', 'function make(value){const args=[];args.push(value);return args;}const first=make(old);const second=make(current);const list=[];list.push(...first);'],
  ['replace returned source after spread', 'function make(value){const args=[];args[0]=value;return args;}const args=make(old);const list=[];list.push(...args);args[0]=current;'],
  ['old alias before returned slot replacement', 'function make(value){const args=[];args[0]=value;return args;}const args=make(old);const list=[args[0]];args[0]=current;'],
  ['literal copy before returned slot replacement', 'function make(value){const args=[];args[0]=value;return args;}const args=make(old);const copy=[...args];args[0]=current;const list=[];list.push(...copy);'],
  ['unrelated receiver factory spread', 'function make(value){const args=[];args.push(value);return args;}const list=[old];const other=[];other.push(...make(current));'],
];
for (const [name, setup] of safeArrayCases) test(`RR10-02 ${name} 保持旧对象隔离`, async t => {
  const source = provide + setup + 'const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;' + mount('current.api') +
    '({sameCurrent:alias===current.api,sameOld:alias===old.api,oldExtra:old.api.outsideScope()});';
  const runtime = await received(source);
  assert.equal(runtime.result.sameCurrent, false);
  assert.equal(runtime.result.sameOld, true);
  assert.equal(runtime.result.oldExtra, true);
  assert.deepEqual(Object.keys(runtime.input.api), ['run']);
  clean(evaluate(t, source));
});

test('RR10 既有保守边界：未解析对象逃逸不因本轮修复变为允许', async t => {
  const source = 'function select(info={label:"default"}){return info;}async function run(){const info=await window.desktopApi.app.getInfo();window.StatementController.createStatementController({initialInfo:select(info.api && {})});}run();';
  assert.equal((await received(source)).input.initialInfo.label, 'default');
  denied(evaluate(t, source, 'renderer-statement'));
});

// 闭包捕获与 helper 同名参数必须按声明函数区分，不能混用调用栈的名称槽位。
const adjacentCases = [
  ['shared-helper-independent-safe', false, 'function put(target,value){target.push(value);}function make(value){const args=[];put(args,value);return args;}const first=make(old);const second=make(current);const list=[...first];'],
  ['shared-helper-independent-unsafe', true, 'function put(target,value){target.push(value);}function make(value){const args=[];put(args,value);return args;}const first=make(old);const second=make(current);const list=[...second];'],
  ['lexical-capture-shadow-safe', false, 'function make(value){function retain(){return value;}function helper(value){return retain();}const args=[];args.push(helper(current));return args;}const list=[...make(old)];'],
  ['lexical-capture-shadow-unsafe', true, 'function make(value){function retain(){return value;}function helper(value){return retain();}const args=[];args.push(helper(old));return args;}const list=[...make(current)];'],
  ['sibling-factory-local-helper-safe', false, 'function first(value){function put(target,value){target[0]=value;}const args=[];put(args,value);return args;}function second(value){function put(target,value){target.push(value);}const args=[];put(args,value);return args;}const one=first(old);const two=second(current);const list=[...one];'],
  ['sibling-factory-local-helper-unsafe', true, 'function first(value){function put(target,value){target[0]=value;}const args=[];put(args,value);return args;}function second(value){function put(target,value){target.push(value);}const args=[];put(args,value);return args;}const one=first(old);const two=second(current);const list=[...two];'],
];
for (const [name, unsafe, setup] of adjacentCases) test(`RR10-02 参数归属 ${name}`, async t => {
  const source = provide + setup + 'const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;' + mount('current.api') + 'alias===current.api;';
  const runtime = await received(source);
  assert.equal(runtime.result, unsafe);
  assert.equal(typeof runtime.input.api.outsideScope === 'function', unsafe);
  const result = evaluate(t, source); if (unsafe) denied(result); else clean(result);
});

// 相同结构合并不能丢失候选来源，也不能把单分支的非空证明提升为全部分支事实。
for (const unsafe of [false, true]) test(`RR10 合并不确定数组来源 ${unsafe ? '保留第二分支' : '保持独立对象'}`, async t => {
  const source = provide + 'function make(value){const args=[];args.push(value);return args;}window.choose=false;' +
    `const list=(window.choose ? [...make(old)] : [...make(${unsafe ? 'current' : 'old'})]) || [];` +
    'const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;' + mount('current.api') + 'alias===current.api;';
  const runtime = await received(source);
  assert.equal(runtime.result, unsafe);
  assert.equal(typeof runtime.input.api.outsideScope === 'function', unsafe);
  const result = evaluate(t, source); if (unsafe) denied(result); else clean(result);
});
for (const operator of ['||', '??']) test(`RR10 相同 IPC 候选经 ${operator} 合并仍保留 undefined 默认来源`, async t => {
  const source = defaults + `async function run(){const info=await window.desktopApi.app.getInfo();const alias=select(info.api ${operator} info.api);` +
    mutate + mount('shared') + 'return alias===shared;}run();';
  const runtime = await received(source, {});
  assert.equal(runtime.result, true);
  assert.equal(runtime.input.api.outsideScope(), true);
  denied(evaluate(t, source));
});
