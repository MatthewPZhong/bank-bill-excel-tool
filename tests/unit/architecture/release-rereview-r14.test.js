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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r14-'));
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

const prefix = 'const old={run(){}},clean={run(){}},box={api:old};';
const helper = 'function replace(){box.api=clean;}';
const capture = 'const alias=box.api;alias.outsideScope=window.desktopApi.outsideScope;';
const mount = 'window.BankStatementController.createBankStatementController({api:old});return alias===old;';
const asyncBody = body => `async function run(){const info=await window.desktopApi.app.getInfo();${body}}run();`;

for (const [name, body, oldFor] of [
  ['break 跳过 body 写入', 'do{if(info.hasEnum)break;box.api=clean;}while(false);', [false,true]],
  ['continue 跳过 body 写入', 'do{if(info.hasEnum)continue;box.api=clean;}while(false);', [false,true]],
  ['break 跳过 test 写入', 'do{if(info.hasEnum)break;}while((box.api=clean,false));', [false,true]],
  ['break 跳过 helper', 'do{if(info.hasEnum)break;replace();}while(false);', [false,true]],
  ['continue 跳过 helper', 'do{if(info.hasEnum)continue;replace();}while(false);', [false,true]],
  ['break 跳过 test helper', 'do{if(info.hasEnum)break;}while((replace(),false));', [false,true]],
  ['写入在 break 前', 'do{box.api=clean;if(info.hasEnum)break;}while(false);', [false,false]],
  ['写入在 continue 前', 'do{box.api=clean;if(info.hasEnum)continue;}while(false);', [false,false]],
  ['helper 在 break 前', 'do{replace();if(info.hasEnum)break;}while(false);', [false,false]],
  ['continue 仍执行 test 写入', 'do{if(info.hasEnum)continue;}while((box.api=clean,false));', [false,false]],
  ['continue 仍执行 test helper', 'do{if(info.hasEnum)continue;}while((replace(),false));', [false,false]],
  ['内层循环 break 不跳过外层写入', 'do{do{if(info.hasEnum)break;}while(false);box.api=clean;}while(false);', [false,false]],
  ['内层循环 continue 不跳过外层写入', 'do{do{if(info.hasEnum)continue;}while(false);replace();}while(false);', [false,false]],
  ['switch break 不跳过循环后续写入', 'do{switch(info.hasEnum){case true:break;}box.api=clean;}while(false);', [false,false]],
  ['switch 内 continue 跳过循环写入', 'do{switch(info.hasEnum){case true:continue;}box.api=clean;}while(false);', [false,true]],
  ['label break 跳过 test', 'outer:do{do{if(info.hasEnum)break outer;}while(false);}while((box.api=clean,false));', [false,true]],
  ['外层 continue 跳过内层 test', 'outer:do{do{if(info.hasEnum)continue outer;}while((box.api=clean,false));}while(false);', [false,true]],
  ['本层 label continue 仍执行 test', 'outer:do{if(info.hasEnum)continue outer;}while((box.api=clean,false));', [false,false]],
  ['label block break 跳过写入', 'outer:{do{if(info.hasEnum)break outer;}while(false);box.api=clean;}', [false,true]],
  ['内部 label break 不跳过后续写入', 'do{inner:{if(info.hasEnum)break inner;}box.api=clean;}while(false);', [false,false]],
  ['字面量 false break 不可达', 'do{if(false)break;box.api=clean;}while(false);', [false,false]],
  ['字面量 true 的 else break 不可达', 'do{if(true){}else break;box.api=clean;}while(false);', [false,false]],
  ['零次内层循环的 label break 不可达', 'outer:do{while(false){break outer;}box.api=clean;}while(false);', [false,false]],
  ['finally 写入在 break 离开前完成', 'do{try{if(info.hasEnum)break;}finally{box.api=clean;}}while(false);', [false,false]],
  ['finally 内 continue 跳过后续写入', 'do{try{}finally{if(info.hasEnum)continue;box.api=clean;}}while(false);', [false,true]],
  ['跳过写入后外层确定覆盖', 'do{if(info.hasEnum)break;box.api=clean;}while(false);box.api=clean;', [false,false]],
  ['for 初始化保持必执行', 'for(box.api=clean;false;){}', [false,false]],
  ['while 零次 body 保留旧来源', 'while(info.hasEnum){box.api=clean;break;}', [true,false]],
]) test(`RR14-01 ${name}`, async t => {
  const source = prefix + (body.includes('replace()') ? helper : '') + asyncBody(body + capture + mount);
  for (const [index, flag] of [false,true].entries()) {
    const observed = await runtime(source, flag);
    assert.equal(observed.same, oldFor[index]);
    assert.equal(typeof observed.input.api.outsideScope === 'function', oldFor[index]);
    if (oldFor[index]) assert.equal(observed.input.api.outsideScope(), true);
  }
  check(t, source, oldFor.some(Boolean));
});

for (const [name, declarations, body, accessor] of [
  ['helper 内部 do 跳过写入', 'function replace(flag){do{if(flag)break;box.api=clean;}while(false);}', 'replace(info.hasEnum);', 'box.api'],
  ['嵌套 helper 调用位置跳过写入', 'function inner(){box.api=clean;}function replace(flag){do{if(flag)continue;inner();}while(false);}', 'replace(info.hasEnum);', 'box.api'],
  ['数组槽位同样保留跳过来源', 'const list=[old];', 'do{if(info.hasEnum)break;list[0]=clean;}while(false);', 'list[0]'],
]) test(`RR14-01 ${name}`, async t => {
  const source = 'const old={run(){}},clean={run(){}},box={api:old};' + declarations +
    asyncBody(body + `const alias=${accessor};alias.outsideScope=window.desktopApi.outsideScope;` + mount);
  for (const flag of [false,true]) {
    const observed = await runtime(source, flag);
    assert.equal(observed.same, flag);
    assert.equal(typeof observed.input.api.outsideScope === 'function', flag);
  }
  check(t, source, true);
});

for (const jump of ['break', 'continue']) test(`RR14-01 ${jump} 同时跳过写入和本轮读取时不污染安全装配`, async t => {
  const source = prefix + helper + asyncBody(`do{if(info.hasEnum)${jump};replace();` + capture + mount +
    '}while(false);window.BankStatementController.createBankStatementController({api:old});return false;');
  for (const flag of [false,true]) {
    const observed = await runtime(source, flag);
    assert.equal(observed.same, false);
    assert.equal(typeof observed.input.api.outsideScope, 'undefined');
  }
  check(t, source, false);
});

test('RR14-01 break 跳过写入但 finally 仍读取时保留旧来源', async t => {
  const source = prefix + asyncBody('do{try{if(info.hasEnum)break;box.api=clean;}finally{' + capture + mount + '}}while(false);');
  for (const flag of [false,true]) {
    const observed = await runtime(source, flag);
    assert.equal(observed.same, flag);
    assert.equal(typeof observed.input.api.outsideScope === 'function', flag);
  }
  check(t, source, true);
});
