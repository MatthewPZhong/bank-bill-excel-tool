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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r13-'));
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

async function runtime(source, hasEnum) {
  let input;
  const window = {
    desktopApi: { outsideScope() { return true; }, app: { async getInfo() { return { version: '3.2.10', hasEnum }; } } },
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

const prefix = 'const old={run(){}},clean={run(){}},box={api:old};function replace(){box.api=clean;}';
const capture = 'const alias=box.api;alias.outsideScope=window.desktopApi.outsideScope;';
const mount = api => `window.BankStatementController.createBankStatementController({api:${api}});return alias===${api};`;
const asyncBody = body => `async function run(){const info=await window.desktopApi.app.getInfo();${body}}run();`;

for (const [name, call, changedWhen] of [
  ['if', 'if(info.hasEnum)replace();', true],
  ['else', 'if(info.hasEnum){}else replace();', false],
  ['三元', 'info.hasEnum?replace():null;', true],
  ['短路 AND', 'info.hasEnum&&replace();', true],
  ['短路 OR', 'info.hasEnum||replace();', false],
  ['空值合并', '(info.hasEnum?null:true)??replace();', true],
  ['switch', 'switch(info.hasEnum){case true:replace();break;}', true],
  ['for 零次循环', 'for(let i=0;i<Number(info.hasEnum);i++){replace();}', true],
  ['while 零次循环', 'let flag=info.hasEnum;while(flag){replace();flag=false;}', true],
  ['for-of 空数组', 'for(const item of info.hasEnum?[1]:[]){replace();}', true],
  ['catch 未进入', 'try{if(info.hasEnum)throw new Error();}catch{replace();}', true],
  ['for-in 空对象', 'for(const key in info.hasEnum?{a:1}:{}){replace();}', true],
]) test(`RR13-01 ${name} 保留未执行 helper 的旧成员`, async t => {
  const source = prefix + asyncBody(call + capture + mount('old'));
  for (const flag of [false, true]) {
    const observed = await runtime(source, flag);
    assert.equal(observed.same, flag !== changedWhen);
    assert.equal(typeof observed.input.api.outsideScope === 'function', flag !== changedWhen);
  }
  check(t, source, true);
});

for (const [name, definitions, body, api, unsafe] of [
  ['if 条件位置必执行', '', 'if((replace(),info.hasEnum)){}'+capture, 'old', false],
  ['逻辑左侧必执行', '', 'replace()||info.hasEnum;'+capture, 'old', false],
  ['for 初始化必执行', '', 'for(replace();false;){}'+capture, 'old', false],
  ['while 条件位置必执行', '', 'while((replace(),false)){}'+capture, 'old', false],
  ['for-of 可迭代值必执行', '', 'for(const item of (replace(),[])){}'+capture, 'old', false],
  ['do-while 首轮必执行', '', 'do{replace();}while(false);'+capture, 'old', false],
  ['字面量真值分支必执行', '', 'if(true)replace();'+capture, 'old', false],
  ['字面量 AND 右侧必执行', '', 'true&&replace();'+capture, 'old', false],
  ['条件调用后直接确定覆盖', '', 'if(info.hasEnum)replace();box.api=clean;'+capture, 'old', false],
  ['条件调用后 helper 确定覆盖', 'function overwrite(){box.api=clean;}', 'if(info.hasEnum)replace();overwrite();'+capture, 'old', false],
  ['无条件替换后读取旧对象', '', 'replace();'+capture, 'old', false],
  ['无条件替换后读取新对象', '', 'replace();'+capture, 'clean', true],
  ['调用前捕获的别名', '', 'const alias=box.api;replace();alias.outsideScope=window.desktopApi.outsideScope;', 'clean', false],
  ['条件外层调用内层 helper', 'function outer(){replace();}', 'if(info.hasEnum)outer();'+capture, 'old', true],
  ['外层 helper 内部条件调用', 'function outer(flag){if(flag)replace();}', 'outer(info.hasEnum);'+capture, 'old', true],
  ['嵌套 helper 无条件替换', 'function outer(){replace();}', 'outer();'+capture, 'old', false],
  ['读写共同处于一个条件块', '', 'if(info.hasEnum){replace();'+capture+mount('old')+'}else{window.BankStatementController.createBankStatementController({api:old});return false;}', null, false],
  ['helper 在调用前已捕获别名', 'function captureAlias(){return box.api;}', 'const alias=captureAlias();if(info.hasEnum)replace();alias.outsideScope=window.desktopApi.outsideScope;', 'clean', false],
]) test(`RR13-01 ${name}`, async t => {
  const source = prefix + definitions + asyncBody(body + (api ? mount(api) : ''));
  let actualUnsafe = false;
  for (const flag of [false, true]) {
    const observed = await runtime(source, flag);
    actualUnsafe ||= typeof observed.input.api.outsideScope === 'function';
  }
  assert.equal(actualUnsafe, unsafe);
  check(t, source, unsafe);
});

for (const [name, declare, read] of [
  ['数组固定槽位', 'const box=[old];function replace(){box[0]=clean;}', 'box[0]'],
  ['工厂调用帧', 'function make(){const box={api:old};function replace(){box.api=clean;}if(flag)replace();return box;}const box=make();', 'box.api'],
]) test(`RR13-01 ${name} 保留条件旧来源`, async t => {
  const body = name === '工厂调用帧' ? declare : declare + 'if(flag)replace();';
  const source = 'const old={run(){}},clean={run(){}};' + asyncBody('const flag=info.hasEnum;' + body +
    `const alias=${read};alias.outsideScope=window.desktopApi.outsideScope;` + mount('old'));
  for (const flag of [false, true]) {
    const observed = await runtime(source, flag);
    assert.equal(observed.same, !flag);
    assert.equal(typeof observed.input.api.outsideScope === 'function', !flag);
  }
  check(t, source, true);
});
