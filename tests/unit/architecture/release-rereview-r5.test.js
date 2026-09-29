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
function fixture(t, files, boundary, authorize = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r5-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), source);
  }
  const config = { schemaVersion: 1, factBaseline: '1'.repeat(40), bootstrap: { factBaseline: '1'.repeat(40), mode: 'first-introduction' },
    boundaries: [{ ...boundary, state: 'pending' }], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  const scanned = scan(root, config);
  if (authorize) authorize(scanned, config.boundaries[0]);
  return evaluateRules(scanned, config, { schemaVersion: 1, factBaseline: config.factBaseline, exceptions: [] }, { root });
}
const clean = result => assert.deepEqual(result.violations, []);
const denied = (result, rule) => assert.ok(result.violations.some(v => v.rule === rule), JSON.stringify(result.violations));
const bank = actual.boundaries.find(b => b.id === 'renderer-bank-statement');
const mount = api => `window.BankStatementController.createBankStatementController({api:${api}});`;
function renderer(t, source) { return fixture(t, { 'src/shell.js': source }, bank); }
function received(source) {
  let input;
  const window = { desktopApi: { outsideScope() { return true; } }, BankStatementController: { createBankStatementController(value) { input = value; } } };
  vm.runInNewContext(source, { window }); return input.api;
}

const factory = 'function provide(){return {api:{run(){}}};}const envelope=provide();';
const bad = [
  ['late factory declaration','const envelope=provide();envelope.api={run(){}};const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;function provide(){const value={api:{run(){}}};value.api={run(){}};return value;}','envelope.api'],
  ['helper reads after replacement',factory+'function select(){return envelope.api;}envelope.api={run(){}};const alias=select();alias.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['conditional replacement',factory+'const other=provide();const target=true?envelope:other;envelope.api={run(){}};const alias=target.api;alias.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['replacement inside factory','function provide(){const envelope={api:{run(){}}};envelope.api={run(){}};return envelope;}const envelope=provide();const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['member replacement', factory+'const clean={run(){}};envelope.api=clean;const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['literal member replacement', 'const envelope={api:{run(){}}};const clean={run(){}};envelope.api=clean;const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['replacement escape', factory+'envelope.api={run(){}};const alias=envelope.api;Object.assign(alias,window.desktopApi);', 'envelope.api'],
  ['bound replacement', 'function provide(){return {api:{run(){}}};}const envelope=provide.bind(null)();envelope.api={run(){}};const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['destructured replacement', factory+'envelope.api={run(){}};const {api}=envelope;api.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['computed replacement', factory+'envelope["api"]={run(){}};const alias=envelope["api"];alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['parent alias replacement', factory+'const parent=envelope;parent.api={run(){}};const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['nested replacement', 'function provide(){return {nested:{api:{run(){}}}};}const envelope=provide();envelope.nested.api={run(){}};const alias=envelope.nested.api;alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.nested.api'],
  ['multiple replacements', factory+'const first={run(){}};envelope.api=first;envelope.api={run(){}};const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['captured old object injected', factory+'const alias=envelope.api;envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;', 'alias'],
  ['copied replacement identity', factory+'envelope.api={run(){}};const copy={...envelope};copy.api.outsideScope=window.desktopApi.outsideScope;', 'envelope.api']
];
for(const [name,setup,api] of bad) test(`RR5-01 ${name} 的越权写入必须拒绝`,t=>{
  const source=setup+mount(api); assert.equal(received(source).outsideScope(),true);
  assert.ok(renderer(t,source).violations.some(v=>['ARCH-RENDERER-SCOPE','ARCH-STATIC-COVERAGE'].includes(v.rule)),name);
});
const good = [
  ['late factory detached alias','const envelope=provide();const alias=envelope.api;envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;function provide(){const value={api:{run(){}}};value.api={run(){}};return value;}','envelope.api'],
  ['helper captures before replacement',factory+'function select(){return envelope.api;}const alias=select();envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['shallow copied detached member',factory+'const copy={...envelope};envelope.api={run(){}};copy.api.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['detached alias',factory+'const alias=envelope.api;envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['detached literal alias','const envelope={api:{run(){}}};const alias=envelope.api;envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['detached destructured alias',factory+'const {api}=envelope;envelope.api={run(){}};api.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['detached escape',factory+'const alias=envelope.api;envelope.api={run(){}};Object.assign(alias,window.desktopApi);','envelope.api'],
  ['detached middle object',factory+'envelope.api={run(){}};const alias=envelope.api;envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['unmodified replacement',factory+'envelope.api={run(){}};','envelope.api'],
  ['different instances','function provide(){return {api:{run(){}}};}const envelope=provide();const other=provide();other.api={run(){}};other.api.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
  ['captured clean old object',factory+'const alias=envelope.api;envelope.api={run(){}};envelope.api.outsideScope=window.desktopApi.outsideScope;','alias']
];
for(const [name,setup,api] of good) test(`RR5-01 ${name} 保持合法`,t=>{
  const source=setup+mount(api); assert.deepEqual(Object.keys(received(source)),['run']); clean(renderer(t,source));
});
const recovery = actual.boundaries.find(b => b.id === 'publication-recovery-entry');
const raw = 'src/main-process/toolbox-output-publication.js';
function recoverySource(body) {
  return `function recoverPreparingIntent(runtime,entry){return runtime.remove(entry);}\nfunction prepareToolboxPublication(runtime,entry){${body}}\nmodule.exports={prepareToolboxPublication};`;
}
function writes(source) {
  const module = { exports: {} }; let count = 0;
  vm.runInNewContext(source, { module }); module.exports.prepareToolboxPublication({ remove() { count += 1; } }, {}); return count;
}

const dataCalls = [
  ['indirect includes','const handlers=[recoverPreparingIntent];return handlers.includes.call(handlers,recoverPreparingIntent);'],
  ['helper does not execute value','function ignore(list,fn){return list.includes(fn);}return ignore([recoverPreparingIntent],recoverPreparingIntent);'],
  ['includes','const handlers=[recoverPreparingIntent];return handlers.includes(recoverPreparingIntent);'],
  ['indexOf','const handlers=[recoverPreparingIntent];return handlers.indexOf(recoverPreparingIntent);'],
  ['lastIndexOf','const handlers=[recoverPreparingIntent];return handlers.lastIndexOf(recoverPreparingIntent);'],
  ['computed includes','const handlers=[recoverPreparingIntent];return handlers["includes"](recoverPreparingIntent);'],
  ['array alias','const handlers=[recoverPreparingIntent];const alias=handlers;return alias.includes(recoverPreparingIntent);'],
  ['helper array parameter','function contains(list,fn){return list.includes(fn);}return contains([recoverPreparingIntent],recoverPreparingIntent);'],
  ['source comparison helper','function contains(list,fn){return list[0]===fn;}return contains([recoverPreparingIntent],recoverPreparingIntent);'],
];
for(const [name,body] of dataCalls)test(`RR5-02 ${name} 不执行函数值`,t=>{
  const source=recoverySource(body);assert.equal(writes(source),0);clean(fixture(t,{[raw]:source},recovery));
});
const executions = [
  ['reduce invokes function accumulator','return [entry].reduce(fn=>fn(runtime,entry),recoverPreparingIntent);'],
  ['helper overrides array','function change(list){list.includes=fn=>fn(runtime,entry);}const handlers=[];change(handlers);return handlers.includes(recoverPreparingIntent);'],
  ['prototype override','Array.prototype.includes=fn=>fn(runtime,entry);return [].includes(recoverPreparingIntent);'],
  ['helper receives custom object','function contains(list,fn){return list.includes(fn);}const handlers={includes(fn){return fn(runtime,entry);}};return contains(handlers,recoverPreparingIntent);'],
  ['reduce','return [entry].reduce(recoverPreparingIntent,runtime);'],
  ['forEach','return [runtime].forEach(recoverPreparingIntent);'],
  ['custom includes','const handlers={includes(fn){return fn(runtime,entry);}};return handlers.includes(recoverPreparingIntent);'],
  ['array override','const handlers=[];handlers.includes=fn=>fn(runtime,entry);return handlers.includes(recoverPreparingIntent);'],
  ['array alias override','const handlers=[];const alias=handlers;alias.includes=fn=>fn(runtime,entry);return handlers.includes(recoverPreparingIntent);'],
  ['array helper override','const handlers=[];Object.assign(handlers,{includes(fn){return fn(runtime,entry);}});return handlers.includes(recoverPreparingIntent);'],
  ['unknown receiver','return globalThis.handlers.includes(recoverPreparingIntent);']
];
for(const [name,body] of executions)test(`RR5-02 ${name} 仍检查受限入口`,t=>{
  const source=recoverySource(body);
  if(name!=='unknown receiver')assert.equal(writes(source),1);
  denied(fixture(t,{[raw]:source},recovery),'ARCH-PUBLICATION-RECOVERY-ENTRY');
});
