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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r9-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/shell.js'), source);
  fs.writeFileSync(path.join(root, 'src/preload.js'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('desktopApi',{app:{getInfo:()=>ipcRenderer.invoke('app:get-info')}});");
  const config = { schemaVersion: 1, factBaseline: '1'.repeat(40), bootstrap: { factBaseline: '1'.repeat(40), mode: 'first-introduction' },
    boundaries: [{ ...actual.boundaries.find(b => b.id === id), state: 'pending' }], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  return evaluateRules(scan(root, config), config, { schemaVersion: 1, factBaseline: config.factBaseline, exceptions: [] }, { root });
}
async function received(source, ...responses) {
  const info = responses.length ? responses[0] : { backgroundConfig: {} };
  let input; let reads = 0;
  const capture = value => { input = value; };
  const window = { desktopApi: { outsideScope() { return true; }, app: { async getInfo() { reads++; return info; } } },
    BankStatementController: { createBankStatementController: capture }, StatementController: { createStatementController: capture } };
  await vm.runInNewContext(source, { window, flag: true }); return { input, reads };
}
const mount = api => `window.BankStatementController.createBankStatementController({api:${api}});`;
const denied = result => assert.ok(result.violations.some(v => ['ARCH-RENDERER-SCOPE', 'ARCH-STATIC-COVERAGE'].includes(v.rule)), JSON.stringify(result.violations));
const clean = result => assert.deepEqual(result.violations, []);
const defaults = 'const shared={run(){}},provided={run(){}};function select(api=shared){return api;}';
const logicalCases = [
  ['IPC missing field', 'info.api && provided'],
  ['explicit undefined', 'undefined && provided'],
  ['static missing member', '({}).api && provided'],
  ['nested AND result', '(info.api && provided) && provided'],
  ['nested right AND', 'true && (info.api && provided)'],
  ['known true with missing right', 'true && info.api'],
  ['parameter projection', 'project(info.api) && provided', 'function project(value){return value;}'],
  ['bound default selector', 'info.api && provided', '', 'select.bind(null,VALUE)()'],
  ['destructured default selector', 'info.api && provided', 'function pick({api=shared}){return api;}', 'pick({api:VALUE})'],
  ['OR default control', 'info.api || undefined'],
  ['nullish default control', 'info.api ?? undefined'],
];
for (const [name, expression, helper = '', call = 'select(VALUE)'] of logicalCases) test(`RR9-01 ${name} 拒绝默认对象越权`, async t => {
  const source = defaults + helper + 'async function run(){const info=await window.desktopApi.app.getInfo();const alias=' +
    call.replace('VALUE', expression) + ';alias.outsideScope=window.desktopApi.outsideScope;' + mount('shared') + '}run();';
  assert.equal((await received(source)).input.api.outsideScope(), true); denied(evaluate(t, source));
});
for (const left of ['true', '1', '"present"', '({})', '[]', '(function(){})', '/present/']) test(`RR9-01 确定真值 ${left} 只返回右侧`, async t => {
  const source = defaults + `const alias=select(${left} && provided);alias.outsideScope=window.desktopApi.outsideScope;` + mount('shared');
  assert.deepEqual(Object.keys((await received(source)).input.api), ['run']); clean(evaluate(t, source));
});
for (const left of ['false', '0', '""', 'null']) test(`RR9-01 确定假值 ${left} 不触发 undefined 默认`, async t => {
  const source = defaults + `const alias=select(${left} && provided);if(alias && typeof alias==='object')alias.outsideScope=window.desktopApi.outsideScope;` + mount('shared');
  assert.deepEqual(Object.keys((await received(source)).input.api), ['run']); clean(evaluate(t, source));
});
for (const unsafe of [false, true]) test(`RR9-01 短路默认的数据合同 ${unsafe ? '能力拒绝' : '纯数据允许'}`, async t => {
  const source = `function select(info=${unsafe ? 'window.desktopApi' : '{label:"default"}'}){return info;}async function run(){const info=await window.desktopApi.app.getInfo();window.StatementController.createStatementController({initialInfo:select(info.api && "data")});}run();`;
  assert.equal(typeof (await received(source)).input.initialInfo.outsideScope === 'function', unsafe);
  const result = evaluate(t, source, 'renderer-statement'); if (unsafe) denied(result); else clean(result);
});
for (const left of ['false', 'null', '0', '""']) test(`RR9-01 纯数据短路 ${left} 不读取右侧完整 API`, async t => {
  const source = `window.StatementController.createStatementController({initialInfo:${left} && window.desktopApi});`;
  assert.equal(typeof (await received(source)).input.initialInfo?.outsideScope, 'undefined'); clean(evaluate(t, source, 'renderer-statement'));
});
const provide = 'function provide(){return {api:{run(){}}};}const old=provide();const current=provide();';
const arrayCases = [
  ['push literal', 'const list=[];list.push(...[current]);'],
  ['splice literal', 'const list=[old];list.splice(...[0,1,current]);'],
  ['unshift literal', 'const list=[];list.unshift(...[current]);'],
  ['fill literal', 'const list=[old];list.fill(...[current]);'],
  ['push named array', 'const args=[current];const list=[];list.push(...args);'],
  ['push nested spread', 'const args=[current];const list=[];list.push(...[...args]);'],
  ['push replaced argument slot', 'const args=[old];args[0]=current;const list=[];list.push(...args);'],
  ['push extended argument array', 'const args=[];args[0]=current;const list=[];list.push(...args);'],
  ['push factory argument array', 'function args(){return [current];}const list=[];list.push(...args());'],
  ['push helper parameter', 'const list=[];function append(target,value){target.push(...[value]);}append(list,current);'],
  ['splice helper parameter', 'const list=[old];function replace(target,value){target.splice(...[0,1,value]);}replace(list,current);'],
  ['direct push control', 'const list=[];list.push(current);'],
  ['spread copy after replacement', 'const args=[old];args[0]=current;const copy=[...args];const list=[];list.push(...copy);'],
  ['unknown prefix still preserves visible object', 'const list=[];window.values=[];list.push(...[...window.values,current]);'],
  ['spread after source mutator', 'const args=[];args.push(current);const list=[];list.push(...args);'],
];
for (const [name, setup] of arrayCases) test(`RR9-02 ${name} 保留插入对象来源`, async t => {
  const source = provide + setup + 'const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;' + mount('current.api');
  assert.equal((await received(source)).input.api.outsideScope(), true); denied(evaluate(t, source));
});
for (const [name, setup] of [
  ['source replacement after push', 'const args=[old];const list=[];list.push(...args);args[0]=current;'],
  ['spread copy before replacement', 'const args=[old];const copy=[...args];args[0]=current;const list=[];list.push(...copy);'],
  ['unrelated receiver', 'const list=[old];const other=[];other.push(...[current]);'],
  ['separate factory array', 'function args(){return [old];}const first=args();const second=args();second[0]=current;const list=[];list.push(...first);'],
]) test(`RR9-02 ${name} 保持旧对象隔离`, async t => {
  const source = provide + setup + 'const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;' + mount('current.api');
  assert.deepEqual(Object.keys((await received(source)).input.api), ['run']); clean(evaluate(t, source));
});
for (const unsafe of [false, true]) test(`RR9-01 已暴露对象的真值证明不扩大 API 授权：${unsafe ? '完整 API 拒绝' : '窄对象允许'}`, async t => {
  const source = 'const narrow={run(){}};' + mount(`window.desktopApi && ${unsafe ? 'window.desktopApi' : 'narrow'}`);
  assert.equal(typeof (await received(source)).input.api.outsideScope === 'function', unsafe);
  const result = evaluate(t, source); if (unsafe) denied(result); else clean(result);
});
test('RR9-01 未解析的对象实参逃逸继续保守拒绝纯数据组合', async t => {
  const source = 'function select(info={label:"default"}){return info;}async function run(){const info=await window.desktopApi.app.getInfo();window.StatementController.createStatementController({initialInfo:select(info.api && {})});}run();';
  assert.equal((await received(source)).input.initialInfo.label, 'default'); denied(evaluate(t, source, 'renderer-statement'));
});
