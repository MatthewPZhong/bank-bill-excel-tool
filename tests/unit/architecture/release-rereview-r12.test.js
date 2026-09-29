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

function evaluate(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r12-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/shell.js'), source);
  fs.writeFileSync(path.join(root, 'src/preload.js'),
    "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('desktopApi',{app:{getInfo:()=>ipcRenderer.invoke('app:get-info')}});");
  const config = {
    schemaVersion: 1, factBaseline: '1'.repeat(40),
    bootstrap: { factBaseline: '1'.repeat(40), mode: 'first-introduction' },
    boundaries: [{ ...actual.boundaries.find(boundary => boundary.id === 'renderer-bank-statement'), state: 'pending' }],
    generatedModules: [], dynamicLoads: [], policyChanges: [],
  };
  return evaluateRules(scan(root, config), config,
    { schemaVersion: 1, factBaseline: config.factBaseline, exceptions: [] }, { root });
}

async function runtime(source) {
  let input;
  const window = {
    desktopApi: { outsideScope() { return true; }, app: { async getInfo() { return { version: '3.2.10' }; } } },
    BankStatementController: { createBankStatementController(value) { input = value; } },
  };
  const same = await vm.runInNewContext(source, { window });
  return { same, input };
}

function check(t, source, unsafe) {
  const result = evaluate(t, source);
  const violations = result.violations.filter(item => ['ARCH-RENDERER-SCOPE', 'ARCH-STATIC-COVERAGE'].includes(item.rule));
  if (unsafe) assert.ok(violations.length > 0, JSON.stringify(result.violations));
  else assert.deepEqual(result.violations, []);
}

const arrays = 'function provide(){return {api:{run(){}}};}const old=provide(),clean=provide();' +
  'function make(value){const args=[];args.push(value);return args;}';
for (const [name, setup, unsafe] of [
  ['helper 重排写入后的数组', 'const list=[...make(old)];function reorder(target){target.reverse();}list[1]=clean;reorder(list);const alias=list[0].api;', true],
  ['helper 写入并重排', 'const list=[...make(old)];function refill(target,value){target[1]=value;target.reverse();}refill(list,clean);const alias=list[0].api;', true],
  ['helper 重排之后才写入其他槽位', 'const list=[...make(old)];function reorder(target){target.reverse();}reorder(list);list[1]=clean;const alias=list[0].api;', false],
  ['helper 只写入已重排数组的其他槽位', 'const list=[...make(old)];function write(target,value){target[1]=value;}list.reverse();write(list,clean);const alias=list[0].api;', false],
  ['直接重排仍保留写入来源', 'const list=[...make(old)];list[1]=clean;list.reverse();const alias=list[0].api;', true],
  ['捕获别名后才重排', 'const list=[...make(old)];const alias=list[0].api;list[1]=clean;list.reverse();', false],
  ['对象参数 先写后重排', 'const list=[...make(old)];function reorder(box){box.target.reverse();}list[1]=clean;reorder({target:list});const alias=list[0].api;', true],
  ['对象参数 先重排后写', 'const list=[...make(old)];function reorder(box){box.target.reverse();}reorder({target:list});list[1]=clean;const alias=list[0].api;', false],
  ['解构参数 先写后重排', 'const list=[...make(old)];function reorder({target}){target.reverse();}list[1]=clean;reorder({target:list});const alias=list[0].api;', true],
  ['解构参数 先重排后写', 'const list=[...make(old)];function reorder({target}){target.reverse();}reorder({target:list});list[1]=clean;const alias=list[0].api;', false],
  ['嵌套 helper 先写后重排', 'const list=[...make(old)];function inner(target){target.reverse();}function reorder(value){inner(value);}list[1]=clean;reorder(list);const alias=list[0].api;', true],
  ['嵌套 helper 先重排后写', 'const list=[...make(old)];function inner(target){target.reverse();}function reorder(value){inner(value);}reorder(list);list[1]=clean;const alias=list[0].api;', false],
]) test(`RR12-01 ${name}`, async t => {
  const source = arrays + setup + 'alias.outsideScope=window.desktopApi.outsideScope;' +
    'window.BankStatementController.createBankStatementController({api:clean.api});alias===clean.api;';
  const observed = await runtime(source);
  assert.equal(observed.same, unsafe);
  assert.equal(typeof observed.input.api.outsideScope === 'function', unsafe);
  check(t, source, unsafe);
});
