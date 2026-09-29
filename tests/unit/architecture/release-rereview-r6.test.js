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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r6-'));
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


const patterns = [
  ['object parameter','function select({api}){return api;}','select(envelope)'],
  ['renamed parameter','function select({api:selected}){return selected;}','select(envelope)'],
  ['nested parameter','function select({box:{api}}){return api;}','select({box:envelope})'],
  ['computed fixed parameter','function select({["api"]:api}){return api;}','select(envelope)'],
  ['bound parameter','function select({api}){return api;}const bound=select.bind(null,envelope);','bound()'],
  ['default with provided member','function select({api={run(){}}}){return api;}','select(envelope)'],
  ['helper forwarding','function select({api}){return api;}function forward(box){return select(box);}','forward(envelope)'],
  ['nested array parameter','function select([{api}]){return api;}','select([envelope])'],
  ['ordinary member control','function select(value){return value.api;}','select(envelope)'],
];
for(const [name,helper,call] of patterns) for(const detached of [false,true]) test(`RR6-01 ${name} ${detached?'旧别名保持分离':'新别名越权拒绝'}`,t=>{
  const setup='function provide(){return {api:{run(){}}};}const envelope=provide();'+helper;
  const capture=`const alias=${call};`;const replace='envelope.api={run(){}};';
  const source=setup+(detached?capture+replace:replace+capture)+'alias.outsideScope=window.desktopApi.outsideScope;'+mount('envelope.api');
  const api=received(source);assert.equal(typeof api.outsideScope==='function',!detached);
  if(detached)clean(renderer(t,source));else assert.ok(renderer(t,source).violations.some(v=>['ARCH-RENDERER-SCOPE','ARCH-STATIC-COVERAGE'].includes(v.rule)));
});
test('RR6-01 同工厂不同实例经解构参数后仍隔离',t=>{
  const source='function provide(){return {api:{run(){}}};}function select({api}){return api;}const envelope=provide();const other=provide();envelope.api={run(){}};other.api={run(){}};const alias=select(other);alias.outsideScope=window.desktopApi.outsideScope;'+mount('envelope.api');
  assert.deepEqual(Object.keys(received(source)),['run']);clean(renderer(t,source));
});
for(const dirty of [false,true])test(`RR6-01 解构参数捕获对象直接注入 ${dirty?'越权拒绝':'保持合法'}`,t=>{
 const source='function provide(){return {api:{run(){}}};}const envelope=provide();function select({api}){return api;}const alias=select(envelope);envelope.api={run(){}};'+(dirty?'alias':'envelope.api')+'.outsideScope=window.desktopApi.outsideScope;'+mount('alias');
 assert.equal(typeof received(source).outsideScope==='function',dirty);
 const result=renderer(t,source);if(dirty)assert.ok(result.violations.length);else clean(result);
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


const overrides = [
 ['object parameter','function change(box){box.handlers.includes=fn=>fn(runtime,entry);}const handlers=[];change({handlers});return handlers.includes(recoverPreparingIntent);'],
 ['destructured parameter','function change({handlers}){handlers.includes=fn=>fn(runtime,entry);}const handlers=[];change({handlers});return handlers.includes(recoverPreparingIntent);'],
 ['nested parameter','function change({box:{handlers}}){handlers.indexOf=fn=>fn(runtime,entry);}const handlers=[];change({box:{handlers}});return handlers.indexOf(recoverPreparingIntent);'],
 ['array parameter','function change([box]){box.handlers.includes=fn=>fn(runtime,entry);}const handlers=[];change([{handlers}]);return handlers.includes(recoverPreparingIntent);'],
 ['prototype parameter','function change(proto){proto.includes=fn=>fn(runtime,entry);}change(Array.prototype);return [].includes(recoverPreparingIntent);'],
 ['prototype nested parameter','function change({box:{proto}}){proto.lastIndexOf=fn=>fn(runtime,entry);}change({box:{proto:Array.prototype}});return [].lastIndexOf(recoverPreparingIntent);'],
 ['forwarded parameter','function change({handlers}){handlers.includes=fn=>fn(runtime,entry);}function forward(box){change(box);}const handlers=[];forward({handlers});return handlers.includes(recoverPreparingIntent);'],
 ['returned parameter','function identity(box){return box;}function change(box){identity(box).handlers.includes=fn=>fn(runtime,entry);}const handlers=[];change({handlers});return handlers.includes(recoverPreparingIntent);'],
 ['bound parameter','function change({handlers}){handlers.includes=fn=>fn(runtime,entry);}const handlers=[];const bound=change.bind(null,{handlers});bound();return handlers.includes(recoverPreparingIntent);'],
 ['projected unknown escape','const handlers=[];globalThis.change({handlers});return handlers.includes(recoverPreparingIntent);'],
 ['returned container unknown escape','function wrap(handlers){return {handlers};}const handlers=[];globalThis.change(wrap(handlers));return handlers.includes(recoverPreparingIntent);'],
 ['prototype unknown escape','globalThis.change({proto:Array.prototype});return [].includes(recoverPreparingIntent);'],
 ['real reduce','return [entry].reduce(recoverPreparingIntent,runtime);']
];
for(const [name,body] of overrides)test(`RR6-02 ${name} 不能冒充原生比较`,t=>{
 const source=recoverySource(body);if(!name.includes('unknown'))assert.equal(writes(source),1);
 denied(fixture(t,{[raw]:source},recovery),'ARCH-PUBLICATION-RECOVERY-ENTRY');
});
const safe = [
 ['native includes','const handlers=[recoverPreparingIntent];return handlers.includes(recoverPreparingIntent);'],
 ['projected compare','function contains(box,fn){return box.handlers.includes(fn);}return contains({handlers:[recoverPreparingIntent]},recoverPreparingIntent);'],
 ['destructured compare','function contains({handlers},fn){return handlers.indexOf(fn);}return contains({handlers:[recoverPreparingIntent]},recoverPreparingIntent);'],
 ['different array mutated','function change({handlers}){handlers.includes=fn=>fn(runtime,entry);}const handlers=[recoverPreparingIntent];change({handlers:[]});return handlers.includes(recoverPreparingIntent);'],
 ['different object prototype','function change(proto){proto.includes=fn=>fn(runtime,entry);}change({});return [recoverPreparingIntent].includes(recoverPreparingIntent);'],
 ['comparison helper without writes','function inspect({handlers}){return handlers.length;}const handlers=[recoverPreparingIntent];inspect({handlers});return handlers.includes(recoverPreparingIntent);']
];
for(const [name,body] of safe)test(`RR6-02 ${name} 保持合法`,t=>{
 const source=recoverySource(body);assert.equal(writes(source),0);clean(fixture(t,{[raw]:source},recovery));
});
