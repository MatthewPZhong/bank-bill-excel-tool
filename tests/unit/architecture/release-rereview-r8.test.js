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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r8-'));
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
const ipcCases = [
  ['plain projected parameter', 'function select(api=shared){return api;}', 'select(info.api)'],
  ['destructured IPC member', 'function select({api=shared}){return api;}', 'select(info)'],
  ['projected member wrapper', 'function select({api=shared}){return api;}', 'select({api:info.api})'],
  ['bound undefined projection', 'function select(api=shared){return api;}', 'select.bind(null,info.api)()'],
  ['forwarded projection', 'function select(api=shared){return api;}function forward(value){return select(value);}', 'forward(info.api)'],
  ['nested IPC projection', 'function select(api=shared){return api;}', 'select(info.backgroundConfig.api)'],
];
for (const [name, helper, call] of ipcCases) test(`RR8-01 ${name} 保留可能默认来源`, async t => {
  const source = 'const shared={run(){}};' + helper + 'async function run(){const info=await window.desktopApi.app.getInfo();' +
    `const alias=${call};alias.outsideScope=window.desktopApi.outsideScope;` + mount('shared') + '}run();';
  const { input, reads } = await received(source);
  assert.equal(reads, 1); assert.equal(input.api.outsideScope(), true); denied(evaluate(t, source));
});
test('RR8-01 IPC 根值也不能仅凭数据标签排除 undefined', async t => {
  const source = 'const shared={run(){}};function select(api=shared){return api;}async function run(){const alias=select(await window.desktopApi.app.getInfo());alias.outsideScope=window.desktopApi.outsideScope;' + mount('shared') + '}run();';
  assert.equal((await received(source, undefined)).input.api.outsideScope(), true); denied(evaluate(t, source));
});
test('RR8-01 未声明字段存在性时即使 stub 恰好提供值仍保留默认候选', async t => {
  const source = 'const shared={run(){}};function select(api=shared){return api;}async function run(){const info=await window.desktopApi.app.getInfo();const alias=select(info.backgroundConfig);alias.outsideScope=window.desktopApi.outsideScope;' + mount('shared') + '}run();';
  assert.deepEqual(Object.keys((await received(source)).input.api), ['run']); denied(evaluate(t, source));
});
test('RR8-01 显式构造的对象可证明已提供，内部 IPC 数据不污染默认对象', async t => {
  const source = 'const shared={run(){}};function select(api=shared){return api;}async function run(){const info=await window.desktopApi.app.getInfo();const alias=select({data:info.backgroundConfig});alias.outsideScope=window.desktopApi.outsideScope;' + mount('shared') + '}run();';
  assert.deepEqual(Object.keys((await received(source)).input.api), ['run']); clean(evaluate(t, source));
});
for (const unsafe of [false, true]) test(`RR8-01 IPC 与默认候选的数据合同：${unsafe ? '能力拒绝' : '纯数据允许'}`, async t => {
  const source = `function select(info=${unsafe ? 'window.desktopApi' : '{label:"default"}'}){return info;}async function run(){const info=await window.desktopApi.app.getInfo();window.StatementController.createStatementController({initialInfo:select(info.missing)});}run();`;
  const value = (await received(source)).input.initialInfo;
  assert.equal(typeof value.outsideScope === 'function', unsafe);
  const result = evaluate(t, source, 'renderer-statement'); if (unsafe) denied(result); else clean(result);
});
for (const explicit of [false, true]) test(`RR8-01 IPC Promise 的成员不会证明实参存在：${explicit ? '显式值允许' : '默认其他频道拒绝'}`, async t => {
  const source = "const {ipcRenderer}=require('electron');function mount(category=ipcRenderer.invoke('other')){window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:category}});}mount(" +
    (explicit ? "'business'" : "ipcRenderer.invoke('app:get-info').reconIdFixBillCategory") + ');';
  const calls = []; let input;
  vm.runInNewContext(source, { require() { return { ipcRenderer: { async invoke(channel) { calls.push(channel); return { channel, reconIdFixBillCategory: 'business' }; } } }; },
    window: { ReconIdFixController: { createReconIdFixController(value) { input = value; } } } });
  assert.deepEqual(calls, explicit ? [] : ['app:get-info', 'other']);
  const result = await input.config.initialBillCategory;
  assert.equal(explicit ? result : result.channel, explicit ? 'business' : 'other');
  const evaluated = evaluate(t, source, 'renderer-recon-id-fix'); if (explicit) clean(evaluated); else denied(evaluated);
});
const provide = 'function provide(){return {api:{run(){}}};}const old=provide();const current=provide();';
const arrayCases = [
  ['parameter destructuring', 'const list=[old];list[0]=current;function select([{api}]){return api;}const alias=select(list);', 'current.api', false],
  ['direct slot member', 'const list=[old];list[0]=current;const alias=list[0].api;', 'current.api', false],
  ['local destructuring', 'const list=[old];list[0]=current;const [{api:alias}]=list;', 'current.api', false],
  ['object pattern slot', 'const list=[old];list[0]=current;function select({0:{api}}){return api;}const alias=select(list);', 'current.api', false],
  ['array alias writes', 'const list=[old];const holder=list;holder[0]=current;const alias=list[0].api;', 'current.api', false],
  ['static string index', 'const list=[old];list["0"]=current;const alias=list["0"].api;', 'current.api', false],
  ['nested array', 'const list=[[old]];list[0][0]=current;const alias=list[0][0].api;', 'current.api', false],
  ['nested envelope', 'const envelope={list:[old]};envelope.list[0]=current;const alias=envelope.list[0].api;', 'current.api', false],
  ['bound selector', 'const list=[old];function select([{api}]){return api;}const bound=select.bind(null,list);list[0]=current;const alias=bound();', 'current.api', false],
  ['factory array result', 'function listFactory(){return [old];}const list=listFactory();list[0]=current;const alias=list[0].api;', 'current.api', false],
  ['same factory instance', 'function listFactory(){return [old];}const list=listFactory();const holder=list;holder[0]=current;const alias=list[0].api;', 'current.api', false],
  ['distinct factory instances', 'function listFactory(){return [old];}const list=listFactory();const other=listFactory();other[0]=current;const alias=list[0].api;', 'current.api', true],
  ['captured before replacement', 'const list=[old];function select([{api}]){return api;}const alias=select(list);list[0]=current;', 'current.api', true],
  ['direct alias before replacement', 'const list=[old];const alias=list[0].api;list[0]=current;', 'current.api', true],
  ['unrelated slot', 'const list=[old,old];list[1]=current;const alias=list[0].api;', 'current.api', true],
  ['overwritten former slot', 'const list=[old];const middle=provide();list[0]=middle;const alias=list[0].api;list[0]=current;', 'current.api', true],
  ['last static replacement', 'const list=[old];list[0]=provide();list[0]=current;const alias=list[0].api;', 'current.api', false],
  ['no replacement control', 'const list=[current];function select([{api}]){return api;}const alias=select(list);', 'current.api', false],
  ['object key control', 'const list={0:old};list[0]=current;const alias=list[0].api;', 'current.api', false],
  ['conditional write', 'const list=[old];if(flag)list[0]=current;const alias=list[0].api;', 'current.api', false],
  ['spread after replacement', 'const list=[old];list[0]=current;const copy=[...list];const alias=copy[0].api;', 'current.api', false],
  ['spread before replacement', 'const list=[old];const copy=[...list];list[0]=current;const alias=copy[0].api;', 'current.api', true],
  ['empty array static slot', 'const list=[];list[0]=current;const alias=list[0].api;', 'current.api', false],
  ['hole static slot', 'const list=[,];list[0]=current;const alias=list[0].api;', 'current.api', false],
  ['helper fixed slot', 'const list=[old];function replace(value){value[0]=current;}replace(list);const alias=list[0].api;', 'current.api', false],
  ['unknown index', 'window.slot=0;const list=[old];list[window.slot]=current;const alias=list[0].api;', 'current.api', false],
];
for (const [name, setup, api, safe] of arrayCases) test(`RR8-02 ${name} ${safe ? '保持隔离' : '拒绝越权'}`, async t => {
  const source = provide + setup + 'alias.outsideScope=window.desktopApi.outsideScope;' + mount(api);
  assert.equal(typeof (await received(source)).input.api.outsideScope === 'function', !safe);
  const result = evaluate(t, source); if (safe) clean(result); else denied(result);
});
for (const operation of ['list.splice(0,1,current)', 'list.fill(current)', 'list.length=0;list.push(current)', 'delete list[0];list[0]=current']) {
  test(`RR8-02 不支持的数组改写明确拒绝：${operation}`, async t => {
    const source = provide + `const list=[old];${operation};const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;` + mount('current.api');
    assert.equal((await received(source)).input.api.outsideScope(), true); denied(evaluate(t, source));
  });
}
for (const unsafe of [false, true]) test(`RR8-02 数组槽位替换后的纯数据合同：${unsafe ? '能力拒绝' : '数据允许'}`, async t => {
  const source = `const list=[{label:'old'}];list[0]=${unsafe ? 'window.desktopApi' : '{label:"new"}'};window.StatementController.createStatementController({initialInfo:list});`;
  assert.equal(typeof (await received(source)).input.initialInfo[0].outsideScope === 'function', unsafe);
  const result = evaluate(t, source, 'renderer-statement'); if (unsafe) denied(result); else clean(result);
});
test('RR8-02 整体数据注入不能让后列未执行分支掩盖能力', async t => {
  const source = 'const list=[{}];if(flag)list[0]=window.desktopApi;if(!flag)list[0]={};window.StatementController.createStatementController({initialInfo:list});';
  assert.equal((await received(source)).input.initialInfo[0].outsideScope(), true); denied(evaluate(t, source, 'renderer-statement'));
});
