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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-rereview-r7-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/shell.js'), source);
  const config = { schemaVersion: 1, factBaseline: '1'.repeat(40), bootstrap: { factBaseline: '1'.repeat(40), mode: 'first-introduction' },
    boundaries: [{ ...actual.boundaries.find(b => b.id === id), state: 'pending' }], generatedModules: [], dynamicLoads: [], policyChanges: [] };
  return evaluateRules(scan(root, config), config, { schemaVersion: 1, factBaseline: config.factBaseline, exceptions: [] }, { root });
}
function received(source) {
  let input;
  const capture = value => { input = value; };
  const window = { desktopApi: { outsideScope() { return true; } },
    BankStatementController: { createBankStatementController: capture }, StatementController: { createStatementController: capture } };
  vm.runInNewContext(source, { window, flag: true }); return input;
}
const mount = api => `window.BankStatementController.createBankStatementController({api:${api}});`;
const denied = result => assert.ok(result.violations.some(v => ['ARCH-RENDERER-SCOPE', 'ARCH-STATIC-COVERAGE'].includes(v.rule)), JSON.stringify(result.violations));
const clean = result => assert.deepEqual(result.violations, []);
const defaults = [
  ['missing member', 'function select({api=shared}){return api;}', 'select({})'],
  ['undefined member', 'function select({api=shared}){return api;}', 'select({api:undefined})'],
  ['undefined alias', 'const missing=undefined;function select({api=shared}){return api;}', 'select({api:missing})'],
  ['missing parameter', 'function select(api=shared){return api;}', 'select()'],
  ['undefined parameter', 'function select(api=shared){return api;}', 'select(undefined)'],
  ['renamed member', 'function select({api:value=shared}){return value;}', 'select({})'],
  ['nested defaults', 'function select({box:{api=shared}={}}={}){return api;}', 'select()'],
  ['array missing element', 'function select([api=shared]){return api;}', 'select([])'],
  ['array hole', 'function select([api=shared]){return api;}', 'select([,])'],
  ['bound missing member', 'function select({api=shared}){return api;}const bound=select.bind(null,{});', 'bound()'],
  ['bound undefined', 'function select(api=shared){return api;}const bound=select.bind(null,undefined);', 'bound()'],
  ['forwarded default', 'function select({api=shared}){return api;}function forward(box){return select(box);}', 'forward({})'],
  ['previous parameter default', 'function select(first=shared,api=first){return api;}', 'select()'],
  ['conditional undefined', 'function select(api=shared){return api;}const provided={run(){}};', 'select(flag?undefined:provided)'],
  ['unknown input', 'function select(api=shared){return api;}', 'select(window.chosen)'],
];
for (const [name, helper, call] of defaults) test(`RR7-01 ${name} 保留默认来源并拒绝越权`, t => {
  const source = 'const shared={run(){}};' + helper + `const alias=${call};alias.outsideScope=window.desktopApi.outsideScope;` + mount('shared');
  assert.equal(received(source).api.outsideScope(), true); denied(evaluate(t, source));
});
const provided = [
  ['member', 'function select({api=shared}){return api;}', 'select({api:other})'],
  ['parameter', 'function select(api=shared){return api;}', 'select(other)'],
  ['bound', 'function select(api=shared){return api;}const bound=select.bind(null,other);', 'bound()'],
  ['nested', 'function select({box:{api=shared}={}}={}){return api;}', 'select({box:{api:other}})'],
  ['shadowed undefined', 'function select(api=shared){return api;}function forward(undefined){return select(undefined);}', 'forward(other)'],
];
for (const [name, helper, call] of provided) test(`RR7-01 provided ${name} 不污染默认对象`, t => {
  const source = 'const shared={run(){}};const other={run(){}};' + helper + `const alias=${call};alias.outsideScope=window.desktopApi.outsideScope;` + mount('shared');
  assert.deepEqual(Object.keys(received(source).api), ['run']); clean(evaluate(t, source));
});
for (const [expression, allowed] of [['null', true], ['false', true], ['0', true], ["''", true], ['undefined', false], ['', false]]) {
  test(`RR7-01 默认值只对 undefined 或省略实参生效：${expression || 'omitted'}`, t => {
    const source = `function select(value=window.desktopApi){return value;}window.StatementController.createStatementController({initialInfo:select(${expression})});`;
    assert.equal(typeof received(source).initialInfo?.outsideScope === 'function', !allowed);
    const result = evaluate(t, source, 'renderer-statement'); if (allowed) clean(result); else denied(result);
  });
}
for (const shared of [false, true]) test(`RR7-01 默认对象字面量 ${shared ? '同实例写入拒绝' : '不同调用实例隔离'}`, t => {
  const source = 'function provide(api={run(){}}){return api;}const clean=provide();const other=' + (shared ? 'clean' : 'provide()') + ';other.outsideScope=window.desktopApi.outsideScope;' + mount('clean');
  assert.equal(typeof received(source).api.outsideScope === 'function', shared);
  const result = evaluate(t, source); if (shared) denied(result); else clean(result);
});
test('RR7-01 默认表达式的成员读取使用调用时点', t => {
  const source = 'const envelope={api:{run(){}}};function select(api=envelope.api){return api;}envelope.api={run(){}};const alias=select();alias.outsideScope=window.desktopApi.outsideScope;' + mount('envelope.api');
  assert.equal(received(source).api.outsideScope(), true); denied(evaluate(t, source));
});
test('RR7-01 控制器装配 helper 显式传参不继承默认对象的越权字段', t => {
  const source = 'const shared={run(){},outsideScope:window.desktopApi.outsideScope};function mount(api=shared){' + mount('api') + '}mount({run(){}});';
  assert.deepEqual(Object.keys(received(source).api), ['run']); clean(evaluate(t, source));
});
