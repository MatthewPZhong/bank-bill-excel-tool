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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r11-'));
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

const defaults = 'const shared={run(){}},provided={run(){}},fallback={api:provided};function select(api=shared){return api;}';
for (const operator of ['||', '??']) {
  test(`RR11-01 ${operator} 父对象非空不证明 api 成员存在`, async t => {
    const source = defaults + `async function run(){const info=await window.desktopApi.app.getInfo();const alias=select((info ${operator} fallback).api);` +
      'alias.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:shared});return alias===shared;}run();';
    const observed = await runtime(source);
    assert.equal(observed.same, true);
    assert.equal(observed.input.api.outsideScope(), true);
    check(t, source, true);
  });
  test(`RR11-01 ${operator} 成员自身回退仍允许独立对象`, async t => {
    const source = defaults + `async function run(){const info=await window.desktopApi.app.getInfo();const alias=select(info.api ${operator} provided);` +
      'alias.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:shared});return alias===shared;}run();';
    const observed = await runtime(source);
    assert.equal(observed.same, false);
    assert.deepEqual(Object.keys(observed.input.api), ['run']);
    check(t, source, false);
  });
}

const arrays = 'function provide(){return {api:{run(){}}};}const old=provide(),clean=provide();' +
  'function make(value){const args=[];args.push(value);return args;}';
const mounted = 'alias.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:clean.api});return alias===clean.api;';
for (const [name, setup, unsafe] of [
  ['reverse', 'const list=[...make(old)];list[1]=clean;list.reverse();const alias=list[0].api;', true],
  ['shift', 'const list=[...make(old)];list[1]=clean;list.shift();const alias=list[0].api;', true],
  ['splice', 'const list=[...make(old)];list[1]=clean;list.splice(0,1);const alias=list[0].api;', true],
  ['没有重排', 'const list=[...make(old)];list[1]=clean;const alias=list[0].api;', false],
  ['重排后才写入其他槽位', 'const list=[...make(old)];list.reverse();list[1]=clean;const alias=list[0].api;', false],
  ['独立数组写入', 'const list=[...make(old)],other=[];other[1]=clean;list.reverse();const alias=list[0].api;', false],
  ['直接读取被写入槽位', 'const list=[...make(old)];list[1]=clean;const alias=list[1].api;', true],
]) test(`RR11-02 ${name} 来源与时点`, async t => {
  const source = arrays + setup + 'function run(){' + mounted + '}run();';
  const observed = await runtime(source);
  assert.equal(observed.same, unsafe);
  assert.equal(typeof observed.input.api.outsideScope === 'function', unsafe);
  check(t, source, unsafe);
});
