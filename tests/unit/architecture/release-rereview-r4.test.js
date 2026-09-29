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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r4-'));
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
const illegal = [
  ['conditional alias identities', 'function provide(){return {run(){}};}const clean=provide();const other={};const alias=true?clean:other;alias.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['conditional nested identities', 'function provide(){return {run(){}};}const clean=provide();const other={};const alias=true?{api:clean}:{api:other};alias.api.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['shared closure return', 'function make(){const shared={run(){}};return function provide(){return shared;};}const provide=make();const clean=provide();const other=provide();other.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['forwarded bound shared argument', 'const shared={run(){}};function provide(api){return api;}const bound=provide.bind(null,shared);const clean=bound();const other=bound();other.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['bound factory', 'function provide(){return {run(){}};}const bound=provide.bind(null);const api=bound();const alias=api;alias.outsideScope=window.desktopApi.outsideScope;', 'api'],
  ['multiple bind', 'function provide(){return {run(){}};}const bound=provide.bind(null).bind(null);const api=bound();const alias=api;alias.outsideScope=window.desktopApi.outsideScope;', 'api'],
  ['nested member alias', 'function provide(){return {api:{run(){}}};}const envelope=provide();const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;', 'envelope.api'],
  ['nested member escape', 'function provide(){return {api:{run(){}}};}const envelope=provide();Object.assign(envelope.api,window.desktopApi);', 'envelope.api'],
  ['bound nested destructuring', 'function provide(){return {nested:{api:{run(){}}}};}const bound=provide.bind(null);const envelope=bound();const {api}=envelope.nested;api.outsideScope=window.desktopApi.outsideScope;', 'envelope.nested.api'],
  ['wrapper factory', 'function provide(){return {run(){}};}function wrapper(){return provide();}const api=wrapper();const alias=api;alias.outsideScope=window.desktopApi.outsideScope;', 'api'],
  ['shared return', 'const shared={run(){}};function provide(){return shared;}const clean=provide();const other=provide();other.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['shared nested return', 'const shared={run(){}};function provide(){return {api:shared};}const clean=provide();const other=provide();other.api.outsideScope=window.desktopApi.outsideScope;', 'clean.api'],
  ['shared bound return', 'const shared={run(){}};function provide(){return shared;}const bound=provide.bind(null);const clean=bound();const other=bound();Object.assign(other,window.desktopApi);', 'clean'],
  ['same factory local write', 'function provide(){const api={run(){}};api.outsideScope=window.desktopApi.outsideScope;return api;}const api=provide();', 'api']
];
for (const [name, setup, api] of illegal) test(`RR4-01/02 ${name} 的真实越权对象必须拒绝`, t => {
  const source = setup + mount(api); assert.equal(received(source).outsideScope(), true);
  const result = renderer(t, source);
  assert.ok(result.violations.some(v => ['ARCH-RENDERER-SCOPE', 'ARCH-STATIC-COVERAGE'].includes(v.rule)), JSON.stringify(result.violations));
});
const legal = [
  ['distinct closure allocations', 'function make(){const shared={run(){}};return function provide(){return shared;};}const clean=make()();const other=make()();other.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['distinct direct calls', 'function provide(){return {run(){}};}const clean=provide();const other=provide();other.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['distinct bound calls', 'function provide(){return {run(){}};}const bound=provide.bind(null);const clean=bound();const other=bound();other.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['distinct nested members', 'function provide(){return {api:{run(){}}};}const clean=provide();const other=provide();other.api.outsideScope=window.desktopApi.outsideScope;', 'clean.api'],
  ['distinct nested escapes', 'function provide(){return {api:{run(){}}};}const clean=provide();const other=provide();Object.assign(other.api,window.desktopApi);', 'clean.api'],
  ['distinct wrapper calls', 'function provide(){return {run(){}};}function wrapper(){return provide();}const clean=wrapper();const other=wrapper();other.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['distinct local declarations', 'function provide(){const api={run(){}};return api;}const clean=provide();const other=provide();other.outsideScope=window.desktopApi.outsideScope;', 'clean'],
  ['bound nested without writes', 'function provide(){return {api:{run(){}}};}const envelope=provide.bind(null)();', 'envelope.api'],
  ['distinct spread copies', 'const shared={run(){}};function provide(){return {...shared};}const clean=provide();const other=provide();other.outsideScope=window.desktopApi.outsideScope;', 'clean']
];
for (const [name, setup, api] of legal) test(`RR4-02 ${name} 不得被其他实例污染`, t => {
  const source = setup + mount(api); assert.deepEqual(Object.keys(received(source)), ['run']); clean(renderer(t, source));
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
const callbacks = [
  ['reduce', 'return [entry].reduce(recoverPreparingIntent,runtime);'],
  ['reduceRight', 'return [entry].reduceRight(recoverPreparingIntent,runtime);'],
  ['map', 'return [runtime].map(recoverPreparingIntent);'],
  ['forEach', 'return [runtime].forEach(recoverPreparingIntent);'],
  ['bound callback', 'return [entry].forEach(recoverPreparingIntent.bind(null,runtime));'],
  ['static callback container', 'const callbacks=[recoverPreparingIntent];return [entry].reduce(callbacks[0],runtime);'],
  ['returned callback', 'function identity(fn){return fn;}return [entry].reduce(identity(recoverPreparingIntent),runtime);'],
  ['helper forwarded callback', 'function fold(fn,r,e){return [e].reduce(fn,r);}return fold(recoverPreparingIntent,runtime,entry);']
];
for (const [name, body] of callbacks) test(`RR4-03 ${name} 执行的受限回调入口必须授权`, t => {
  const source = recoverySource(body); assert.equal(writes(source), 1);
  const result = fixture(t, { [raw]: source }, recovery); denied(result, 'ARCH-PUBLICATION-RECOVERY-ENTRY');
  assert.ok(result.violations.some(v => v.rule === 'ARCH-PUBLICATION-RECOVERY-ENTRY' &&
    ['prepareToolboxPublication', 'prepareToolboxPublication.fold'].includes(v.functionPath)), '诊断应落在执行回调的调用方');
});
test('RR4-03 未执行参数、普通同名函数、未选成员和正常迭代回调保持合法', t => {
  for (const body of [
    'function ignore(fn){return 1;}return ignore(recoverPreparingIntent);',
    'return [runtime].map(function recoverPreparingIntent(){return 1;});',
    'const callbacks=[recoverPreparingIntent,()=>1];return [entry].map(callbacks[1]);',
    'return [entry].reduce((r)=>r,runtime);'
  ]) { const source = recoverySource(body); assert.equal(writes(source), 0); clean(fixture(t, { [raw]: source }, recovery)); }
});
test('RR4-03 准确回调授权位置生效，其他调用位置不能借用', t => {
  const authorize = (scanned, boundary) => {
    const site = scanned.sites.find(s => s.type === 'call' && s.functionPath === 'prepareToolboxPublication' && s.args?.[0]?.functionPath === 'recoverPreparingIntent');
    assert.ok(site);
    boundary.allowedSites = [...boundary.allowedSites, { rule: 'ARCH-PUBLICATION-RECOVERY-ENTRY', from: site.from,
      functionPath: site.functionPath, callee: site.callee || site.method, evidenceId: site.evidenceId, reason: '仅用于验证精确授权位置的测试夹具' }];
  };
  clean(fixture(t, { [raw]: recoverySource('return [entry].reduce(recoverPreparingIntent,runtime);') }, recovery, authorize));
  denied(fixture(t, { [raw]: recoverySource('[entry].reduce(recoverPreparingIntent,runtime);return [entry].reduceRight(recoverPreparingIntent,runtime);') }, recovery, authorize), 'ARCH-PUBLICATION-RECOVERY-ENTRY');
});
