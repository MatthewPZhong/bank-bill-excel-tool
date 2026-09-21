'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPolicyRepository, POLICY_PATH, ALLOWLIST_PATH, REPAIRS_PATH } = require('./fixtures/policy-repository');
const { checkPolicyHistory } = require('../../../scripts/architecture/policy-history');
const { scan } = require('../../../scripts/architecture/scan');
const { evaluateRules } = require('../../../scripts/architecture/rules');

function inputFailure(action, pattern) {
  assert.throws(action, (error) => error.exitCode === 2 && (!pattern || pattern.test(error.message)));
}
function hasViolation(result, field) { assert.ok(result.violations.some((item) => item.field === field), JSON.stringify(result.violations)); }
function brokenHistory(fixture, relative = POLICY_PATH) {
  fixture.commit('S1 已激活');
  const value = relative === POLICY_PATH ? fixture.config : fixture.allowlist;
  fixture.write(relative, JSON.stringify(value).replace(/}$/, ',}'));
  const broken = fixture.commit('S2 JSON 语法损坏');
  fixture.save();
  return broken;
}

test('首次无配置 bootstrap 可用，当前配置和 Git 历史保持只读、确定性', (t) => {
  const fixture = createPolicyRepository(t);
  const before = fixture.git('status', '--porcelain');
  const first = fixture.check();
  assert.deepEqual(first, fixture.check());
  assert.deepEqual(first.violations, []);
  assert.equal(first.policyHistory.bootstrapCommit, null);
  assert.equal(first.policyComparedWith, fixture.baseline);
  assert.equal(fixture.git('status', '--porcelain'), before);
});

test('S0 → S1 active → S2 pending 的所有事件基线均保留真实 HEAD 历史', (t) => {
  const fixture = createPolicyRepository(t);
  const s1 = fixture.commit('S1 active');
  fixture.boundary.state = 'pending';
  fixture.boundary.entrypoints = [];
  fs.unlinkSync(path.join(fixture.root, 'src/entry.js'));
  fixture.save();
  const s2 = fixture.commit('S2 降级并删除');
  for (const [event, against] of [['local', 'HEAD'], ['PR', fixture.baseline], ['push', fixture.baseline], ['tag', s2], ['manual', s2], ['explicit', s1]]) {
    const result = fixture.check(against);
    hasViolation(result, 'state');
    assert.ok(result.policyHistory.historicalActiveIds.includes('fixture-core'), event);
    assert.ok(result.policyHistory.roots.includes(s2), event);
  }
  fixture.boundary.state = 'active';
  fixture.boundary.entrypoints = ['src/entry.js'];
  fixture.write('src/entry.js', 'module.exports = {};\n');
  fixture.save();
  fixture.commit('S3 恢复底线');
  assert.deepEqual(fixture.check(fixture.baseline).violations, []);
});

test('merge 另一父链的 active 不能被 first-parent 当前 pending 隐藏', (t) => {
  const fixture = createPolicyRepository(t);
  fixture.git('checkout', '-qb', 'activated');
  const activated = fixture.commit('侧分支激活');
  fixture.git('checkout', '-q', 'main');
  fixture.boundary.state = 'pending';
  fixture.save();
  fixture.commit('主分支待激活');
  fixture.git('merge', '--no-ff', '-s', 'ours', '-m', '合并侧分支历史', 'activated');
  const result = fixture.check(fixture.baseline);
  assert.ok(result.violations.some((item) => item.sourceCommit === activated && item.field === 'state'));
});

test('历史配置暂时删除可前向恢复，active id 改名仍失败', (t) => {
  const fixture = createPolicyRepository(t);
  fixture.commit();
  fs.unlinkSync(path.join(fixture.root, POLICY_PATH));
  inputFailure(() => fixture.check(), /当前缺少/);
  fixture.commit('历史删除配置');
  fixture.save();
  assert.deepEqual(fixture.check().violations, []);
  assert.ok(fixture.check().policyHistory.diagnostics.some((item) => item.path === POLICY_PATH));
  fixture.boundary.id = 'renamed-core';
  fixture.save();
  hasViolation(fixture.check(), 'state');
});

test('保护字段完整比较：scope、operation、规则、消费者、证据、全局及装配不能放宽', (t) => {
  const fixture = createPolicyRepository(t);
  Object.assign(fixture.boundary, {
    protectedScopes: [{ path: 'src/entry.js', functionPath: 'collect' }],
    restrictedApis: [{ path: 'src/raw.js', exportNames: ['recover'], operations: ['recover'] }],
    globals: [{ path: 'src/entry.js', exportsGlobal: ['fixtureFactory'], consumesGlobals: [] }],
    factory: { path: 'src/entry.js', name: 'fixtureFactory', parameters: ['api'] },
    allowedApiFields: { api: ['read'] }, directory: 'src',
    compositionEntrypoints: [{ path: 'src/consumer.js', importedNames: ['create'], allowedTargets: ['src/entry.js'] }]
  });
  fixture.save();
  fixture.commit('完整保护字段');
  const base = structuredClone(fixture.boundary);
  const mutations = [
    ['protectedScopes', []], ['restrictedApis', [{ path: 'src/raw.js', exportNames: ['recover'], operations: [] }]],
    ['requiredConsumers', []], ['activationEvidence', []], ['entrypoints', []], ['rules', ['ARCH-STATIC-COVERAGE']],
    ['allowedLocal', ['src/entry.js', 'src/business.js']], ['allowedExternal', ['node:crypto', 'node:fs']],
    ['compositionEntrypoints', [{ path: 'src/consumer.js', importedNames: ['create', 'recover'], allowedTargets: ['src/entry.js'] }]],
    ['allowedSites', [{ rule: 'ARCH-PLATFORM-CORE', from: 'src/entry.js', functionPath: null, callee: 'recover', evidenceId: 'a'.repeat(64), reason: '新增允许入口' }]],
    ['allowedApiFields', { api: ['read', 'write'] }], ['allowedApiFields', {}], ['globals', []], ['factory', null], ['directory', null], ['governance', 'G3']
  ];
  for (const [field, value] of mutations) {
    Object.assign(fixture.boundary, structuredClone(base), { [field]: value });
    fixture.save();
    hasViolation(fixture.check(), field);
  }
  Object.assign(fixture.boundary, base, { allowedExternal: [], allowedApiFields: { api: [] }, compositionEntrypoints: [], protectedScopes: [{ path: 'src/entry.js', functionPath: null }] });
  fixture.save();
  assert.deepEqual(fixture.check().violations, []);
});

test('未全域激活时退役入口仍保留成员、替代入口和证据约束', t => {
  const f = createPolicyRepository(t);
  f.boundary.state = 'pending';
  f.boundary.deprecatedEntrypoints = [{ path: 'src/old.js', replacementPaths: ['src/entry.js'], exportNames: ['read'],
    existingConsumers: [], state: 'retired', retirementEvidence: ['tests/behavior.js'] }];
  f.save(); f.commit('先退役一个旧入口，其他切片仍 pending');
  const retired = structuredClone(f.boundary.deprecatedEntrypoints[0]);
  for (const change of [{ exportNames: [] }, { replacementPaths: ['src/unrelated.js'] }, { retirementEvidence: ['tests/other.js'] }]) {
    f.boundary.deprecatedEntrypoints = [{ ...retired, ...change }]; f.save();
    hasViolation(f.check(), 'deprecatedEntrypoints');
  }
});

test('合法路径迁移需准确 source commit/blob/value/设计证据，A→B→A 不按值误判循环', (t) => {
  const fixture = createPolicyRepository(t);
  const s1 = fixture.commit('A');
  const original = [...fixture.boundary.entrypoints];
  fixture.boundary.entrypoints = ['src/moved.js'];
  fixture.write('src/moved.js', 'module.exports = {};\n');
  fixture.save();
  hasViolation(fixture.check(), 'entrypoints');
  fixture.change(s1, 'entrypoints', original, ['src/moved.js']);
  fixture.moveConsumer(s1, 'src/moved.js');
  fixture.save();
  assert.deepEqual(fixture.check().violations, []);
  const s2 = fixture.commit('B');
  fixture.boundary.entrypoints = original;
  fixture.change(s2, 'entrypoints', ['src/moved.js'], original);
  fixture.moveConsumer(s2, 'src/entry.js');
  fixture.save();
  assert.deepEqual(fixture.check().violations, []);
  assert.equal(fixture.check().policyHistory.appliedPolicyChanges.length, 2);
  fixture.config.policyChanges.at(-1).sourcePolicyBlob = '0'.repeat(40);
  fixture.save();
  inputFailure(() => fixture.check(), /原始提交/);
});

test('多次准确迁移链的中间字段必须属于后续父链版本', (t) => {
  const fixture = createPolicyRepository(t);
  const s1 = fixture.commit('A');
  fixture.change(s1, 'entrypoints', ['src/entry.js'], ['src/b.js']);
  fixture.moveConsumer(s1, 'src/b.js');
  fixture.boundary.entrypoints = ['src/b.js'];
  fixture.write('src/b.js', 'module.exports = {};\n');
  fixture.save();
  const s2 = fixture.commit('B');
  fixture.change(s2, 'entrypoints', ['src/b.js'], ['src/c.js']);
  fixture.moveConsumer(s2, 'src/c.js');
  fixture.boundary.entrypoints = ['src/c.js'];
  fixture.write('src/c.js', 'module.exports = {};\n');
  fixture.save();
  assert.deepEqual(fixture.check().violations, []);
  assert.equal(fixture.check().policyHistory.appliedPolicyChanges.length, 4);
});

test('入口迁移不能仅创建空文件并将仍有生产消费者的旧能力移出保护', (t) => {
  const fixture = createPolicyRepository(t);
  const s1 = fixture.commit();
  fixture.boundary.entrypoints = ['src/unused.js'];
  fixture.write('src/unused.js', 'module.exports = {};\n');
  fixture.change(s1, 'entrypoints', ['src/entry.js'], ['src/unused.js']);
  fixture.save();
  hasViolation(fixture.check(), 'entrypoints');
  fixture.moveConsumer(s1, 'src/unused.js');
  fixture.save();
  assert.deepEqual(fixture.check().violations, []);
});

test('scope 迁移不能把仍存在的违规 collect 排除，仅真实函数改名可迁移', (t) => {
  const fixture = createPolicyRepository(t);
  fixture.boundary.rules = ['ARCH-BIZOP-QUERY'];
  fixture.boundary.protectedScopes = [{ path: 'src/entry.js', functionPath: null }];
  fixture.write('src/entry.js', "function collect(catalog) { return catalog.db.prepare('SELECT * FROM archive_artifacts'); }\nfunction safe() {}\nmodule.exports = { collect, safe };\n");
  fixture.save();
  const s1 = fixture.commit('真实 SQL 保护范围');
  const before = evaluateRules(scan(fixture.root, fixture.config), fixture.config, fixture.allowlist, { root: fixture.root });
  assert.ok(before.violations.some((item) => item.rule === 'ARCH-BIZOP-QUERY'));
  fixture.change(s1, 'protectedScopes', structuredClone(fixture.boundary.protectedScopes), [{ path: 'src/entry.js', functionPath: 'safe' }]);
  fixture.boundary.protectedScopes = [{ path: 'src/entry.js', functionPath: 'safe' }];
  fixture.save();
  hasViolation(fixture.check(), 'protectedScopes');

  const renamed = createPolicyRepository(t);
  renamed.boundary.rules = ['ARCH-BIZOP-QUERY'];
  renamed.boundary.protectedScopes = [{ path: 'src/entry.js', functionPath: 'collect' }];
  renamed.write('src/entry.js', 'function collect(catalog) { return catalog.queries.list(); }\nmodule.exports = { collect };\n');
  renamed.save();
  const original = renamed.commit();
  renamed.change(original, 'protectedScopes', structuredClone(renamed.boundary.protectedScopes), [{ path: 'src/entry.js', functionPath: 'readFacts' }]);
  renamed.boundary.protectedScopes[0].functionPath = 'readFacts';
  renamed.write('src/entry.js', 'function readFacts(catalog) { return catalog.queries.list(); }\nmodule.exports = { readFacts };\n');
  renamed.save();
  assert.deepEqual(renamed.check().violations, []);
});

test('policyChanges 不能解绑原规则或者豁免 active 身份', (t) => {
  const fixture = createPolicyRepository(t);
  const s1 = fixture.commit();
  fixture.change(s1, 'rules', ['ARCH-PLATFORM-CORE'], ['ARCH-STATIC-COVERAGE']);
  fixture.boundary.rules = ['ARCH-STATIC-COVERAGE'];
  fixture.save();
  hasViolation(fixture.check(), 'rules');
  fixture.config.policyChanges = [];
  fixture.change(s1, 'state', 'active', 'pending');
  fixture.boundary.state = 'pending';
  fixture.save();
  inputFailure(() => fixture.check(), /不能豁免/);
});

test('retired 不能复活或删除登记，当前恢复后通过', (t) => {
  const fixture = createPolicyRepository(t);
  fixture.boundary.deprecatedEntrypoints = [{ path: 'src/old.js', replacementPaths: ['src/entry.js'], exportNames: null, existingConsumers: [], state: 'retired', retirementEvidence: ['tests/behavior.js'] }];
  fixture.save();
  fixture.commit();
  fixture.boundary.deprecatedEntrypoints[0].state = 'compat';
  fixture.save();
  hasViolation(fixture.check(), 'deprecatedEntrypoints');
  fixture.boundary.deprecatedEntrypoints = [];
  fixture.save();
  hasViolation(fixture.check(), 'deprecatedEntrypoints');
});

test('精确历史例外删除可以通过，提交删除后不能复活或扩散', (t) => {
  const fixture = createPolicyRepository(t);
  const exception = { id: 'legacy', rule: 'ARCH-MODAL-OWNER', from: 'src/entry.js', evidenceId: '1'.repeat(64), functionPath: null, originalCommit: fixture.baseline, reason: '旧挂载入口等待迁移', governance: 'G3', removeWhen: '宿主迁移完成' };
  fixture.allowlist.exceptions.push(exception);
  fixture.save();
  fixture.commit();
  fixture.allowlist.exceptions = [];
  fixture.save();
  assert.deepEqual(fixture.check().violations, []);
  fixture.commit('移除已消失例外');
  fixture.allowlist.exceptions = [exception];
  fixture.save();
  hasViolation(fixture.check(), 'exceptions');
});

test('boundaries 暂时缺失的提交仍保留其 allowlist 收缩事实', (t) => {
  const fixture = createPolicyRepository(t);
  const exception = { id: 'legacy', rule: 'ARCH-MODAL-OWNER', from: 'src/entry.js', evidenceId: '1'.repeat(64), functionPath: null, originalCommit: fixture.baseline, reason: '旧挂载入口等待迁移', governance: 'G3', removeWhen: '宿主迁移完成' };
  fixture.allowlist.exceptions = [exception];
  fixture.save();
  fixture.commit();
  fixture.allowlist.exceptions = [];
  fixture.save();
  fs.unlinkSync(path.join(fixture.root, POLICY_PATH));
  fixture.commit('同时收缩例外与临时删除 boundaries');
  fixture.allowlist.exceptions = [exception];
  fixture.save();
  hasViolation(fixture.check(), 'exceptions');
});

test('历史例外允许精确一对一搬迁，完整来源链不能扩大数量或受限成员', (t) => {
  const fixture = createPolicyRepository(t);
  const exception = { id: 'legacy', rule: 'ARCH-MODAL-OWNER', from: 'src/entry.js', evidenceId: '1'.repeat(64), functionPath: null, originalCommit: fixture.baseline, reason: '旧挂载入口等待迁移', governance: 'G3', removeWhen: '宿主迁移完成' };
  fixture.allowlist.exceptions = [exception];
  fixture.save();
  const s1 = fixture.commit();
  const moved = { ...exception, from: 'src/moved.js', evidenceId: '2'.repeat(64) };
  fixture.allowlist.exceptions = [moved];
  fixture.write('docs/move-exception.md', '同一兼容挂载实现移入新文件，旧入口删除，准确替换指纹；不增加第二个豁免位置。\n');
  fixture.config.policyChanges = [{ sourceCommit: s1, sourcePolicyBlob: fixture.git('rev-parse', `${s1}:${ALLOWLIST_PATH}`), boundaryId: '$allowlist', field: 'exceptions', from: [exception], to: [moved], reason: '同一旧实现迁移，保留原始事实基线身份', designDoc: 'docs/move-exception.md' }];
  fixture.save();
  assert.deepEqual(fixture.check().violations, []);
  const extra = { ...moved, id: 'duplicate', from: 'src/duplicate.js' };
  fixture.allowlist.exceptions.push(extra);
  fixture.config.policyChanges[0].to.push(extra);
  fixture.save();
  hasViolation(fixture.check(), 'exceptions');
});

test('精确 policyChanges 也不能将保护范围或受限 operation 清空', (t) => {
  const fixture = createPolicyRepository(t);
  fixture.boundary.protectedScopes = [{ path: 'src/entry.js', functionPath: 'collect' }];
  fixture.boundary.restrictedApis = [{ path: 'src/raw.js', exportNames: ['recover'], operations: ['recover'] }];
  fixture.save();
  const s1 = fixture.commit();
  fixture.change(s1, 'protectedScopes', structuredClone(fixture.boundary.protectedScopes), []);
  fixture.change(s1, 'restrictedApis', structuredClone(fixture.boundary.restrictedApis), [{ path: 'src/raw.js', exportNames: ['recover'], operations: [] }]);
  fixture.change(s1, 'entrypoints', ['src/entry.js'], []);
  fixture.boundary.protectedScopes = [];
  fixture.boundary.restrictedApis[0].operations = [];
  fixture.boundary.entrypoints = [];
  fixture.save();
  const result = fixture.check();
  for (const field of ['protectedScopes', 'restrictedApis', 'entrypoints']) hasViolation(result, field);
});

test('policyChanges.to 必须通过原字段 schema，错误值受控返回输入错误', (t) => {
  const fixture = createPolicyRepository(t);
  fixture.boundary.restrictedApis = [{ path: 'src/raw.js', exportNames: ['recover'], operations: ['recover'] }];
  fixture.save();
  const s1 = fixture.commit();
  fixture.change(s1, 'restrictedApis', structuredClone(fixture.boundary.restrictedApis), [null]);
  fixture.save();
  inputFailure(() => fixture.check(), /policyChanges.to/);
});

test('工厂有序参数变化不能被集合相等忽略', (t) => {
  const fixture = createPolicyRepository(t);
  fixture.boundary.factory = { path: 'src/entry.js', name: 'create', parameters: ['api', 'ui'] };
  fixture.save();
  fixture.commit();
  fixture.boundary.factory.parameters.reverse();
  fixture.save();
  hasViolation(fixture.check(), 'factory');
});

test('shallow、不可读 ref、非祖先 baseline、缺 blob 不得降为首次配置', (t) => {
  const fixture = createPolicyRepository(t);
  const s1 = fixture.commit();
  inputFailure(() => fixture.check('0'.repeat(40)), /全零/);
  inputFailure(() => fixture.check('missing-ref'));
  const unrelated = fixture.git('commit-tree', fixture.git('rev-parse', 'HEAD^{tree}'), '-m', '无共同祖先的事件提交');
  inputFailure(() => fixture.check(unrelated), /不是历史根.*祖先/);
  fs.writeFileSync(path.join(fixture.root, '.git/shallow'), `${s1}\n`);
  inputFailure(() => fixture.check(), /shallow/);
  fs.unlinkSync(path.join(fixture.root, '.git/shallow'));
  const blob = fixture.git('rev-parse', `HEAD:${POLICY_PATH}`);
  fs.unlinkSync(path.join(fixture.root, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  inputFailure(() => fixture.check(), /缺失对象|不可读取/);
});

test('子目录不能借用父仓库 HEAD 伪装独立 root', (t) => {
  const fixture = createPolicyRepository(t);
  fixture.write(`nested/${POLICY_PATH}`, fixture.config);
  fixture.write(`nested/${ALLOWLIST_PATH}`, fixture.allowlist);
  inputFailure(() => checkPolicyHistory({ root: path.join(fixture.root, 'nested'), config: fixture.config, allowlist: fixture.allowlist }), /不能借用父仓库历史/);
});

test('AC22：无登记默认失败；准确语法重建通过并显示每个历史身份', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  inputFailure(() => fixture.check(fixture.baseline), /commit=.*path=.*blob=/);
  const repair = fixture.repair(broken);
  fixture.save();
  fixture.commit('S3 完整恢复');
  const result = fixture.check(fixture.baseline);
  assert.deepEqual(result.violations, []);
  assert.equal(result.policyHistory.historyRepairsApplied[0].originalBlob, repair.originalBlob);
  assert.ok(result.policyHistory.historyRepairsApplied[0].sourceCommits.includes(broken));
  fixture.boundary.state = 'pending';
  fixture.save();
  hasViolation(fixture.check(), 'state');
  fixture.boundary.state = 'active';
  fixture.boundary.entrypoints = [];
  fixture.save();
  hasViolation(fixture.check(), 'entrypoints');
});

test('AC22：allowlist 语法重建同样保留精确例外底线', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture, ALLOWLIST_PATH);
  inputFailure(() => fixture.check(), /legacy-allowlist/);
  fixture.repair(broken, fixture.allowlist, ALLOWLIST_PATH);
  assert.deepEqual(fixture.check().violations, []);
  assert.equal(fixture.check().policyHistory.historyRepairsApplied[0].path, ALLOWLIST_PATH);
});

test('AC22：错 blob/hash/path、越界、缺 evidence 和空重建均拒绝', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  const valid = fixture.repair(broken);
  for (const edit of [
    { originalBlob: 'f'.repeat(40) }, { repairedSha256: 'f'.repeat(64) }, { path: 'architecture/other.json' },
    { repairedPath: '../escape.json' }, { reviewEvidence: 'docs/missing.md' }, { sourceCommits: [fixture.baseline] }
  ]) {
    fixture.write(REPAIRS_PATH, { schemaVersion: 1, repairs: [{ ...valid, ...edit }] });
    inputFailure(() => fixture.check());
  }
  const bytes = '{}\n';
  fixture.write(valid.repairedPath, bytes);
  fixture.write(REPAIRS_PATH, { schemaVersion: 1, repairs: [{ ...valid, repairedSha256: crypto.createHash('sha256').update(bytes).digest('hex') }] });
  inputFailure(() => fixture.check(), /schema/);
});

test('AC22：可解析弱化配置、未知 schema 和当前 schema 错误不能借历史 repair', (t) => {
  const fixture = createPolicyRepository(t);
  const s1 = fixture.commit();
  fixture.boundary.state = 'pending';
  fixture.save();
  const s2 = fixture.commit('可解析弱化');
  fixture.boundary.state = 'active';
  fixture.save();
  fixture.repair(s2);
  inputFailure(() => fixture.check(), /不能替代可解析/);
  fs.unlinkSync(path.join(fixture.root, REPAIRS_PATH));
  fixture.config.schemaVersion = 2;
  fixture.save();
  fixture.commit('未知 schema');
  fixture.config.schemaVersion = 1;
  fixture.save();
  inputFailure(() => fixture.check(), /schema/);
  fixture.config.factBaseline = s1;
  fixture.allowlist.factBaseline = s1;
  fixture.config.bootstrap.factBaseline = s1;
  fixture.save();
  inputFailure(() => fixture.check(), /固定事实基线已存在/);
});

test('当前配置语法损坏或不完整 bootstrap 不能使用任何历史重建出口', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  fixture.repair(broken);
  fixture.write(POLICY_PATH, '{');
  inputFailure(() => fixture.check(), /JSON 语法损坏/);
  fixture.save();
  fixture.config.boundaries = fixture.config.boundaries.filter((boundary) => boundary.id !== 'bizop-query-q1');
  fixture.save();
  inputFailure(() => fixture.check(), /完整计划子边界/);
});

test('AC22：从未完整有效的错误 hash 登记可前向修正，诊断保留', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  const valid = fixture.repair(broken);
  fixture.write(REPAIRS_PATH, { schemaVersion: 1, repairs: [{ ...valid, repairedSha256: 'f'.repeat(64) }] });
  fixture.commit('hash 笔误');
  fixture.write(REPAIRS_PATH, { schemaVersion: 1, repairs: [valid] });
  fixture.commit('前向修正 hash');
  const result = fixture.check();
  assert.deepEqual(result.violations, []);
  assert.ok(result.policyHistory.diagnostics.some((entry) => /hash 不匹配/.test(entry.message)));
});

test('AC22：有效绑定之后坏 manifest 不抹除底线，当前必须恢复原 hash', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  const valid = fixture.repair(broken);
  fixture.commit('完整有效修复');
  fixture.write(REPAIRS_PATH, '{');
  fixture.commit('坏 manifest');
  fs.unlinkSync(path.join(fixture.root, REPAIRS_PATH));
  inputFailure(() => fixture.check(), /保留历史完整有效/);
  fixture.write(REPAIRS_PATH, { schemaVersion: 1, repairs: [valid] });
  assert.deepEqual(fixture.check().violations, []);
  const weak = structuredClone(fixture.config);
  weak.boundaries[0].state = 'pending';
  fixture.repair(broken, weak);
  inputFailure(() => fixture.check(), /保留历史完整有效/);
});

test('AC22：只改 snapshot/evidence 的提交逐次核对，首次有效时才固定 hash', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  const valid = fixture.repair(broken);
  fs.unlinkSync(path.join(fixture.root, valid.reviewEvidence));
  fixture.commit('先登记但无审查材料');
  fixture.write(valid.reviewEvidence, '补齐精确语法差异说明和保留边界依据。\n');
  fixture.commit('只补审查材料，绑定首次有效');
  fixture.write(valid.repairedPath, '{}\n');
  fixture.commit('只损坏 snapshot');
  fixture.repair(broken);
  const result = fixture.check();
  assert.deepEqual(result.violations, []);
  assert.ok(result.policyHistory.diagnostics.some((entry) => /缺少重建快照或审查依据/.test(entry.message)));
  assert.ok(result.policyHistory.diagnostics.some((entry) => /hash 不匹配/.test(entry.message)));
  const weak = structuredClone(fixture.config);
  weak.boundaries[0].state = 'pending';
  fixture.repair(broken, weak);
  inputFailure(() => fixture.check(), /保留历史完整有效/);
});

test('AC22：merge 两父链中的完整有效不同 hash 无法任意选取', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  fixture.git('checkout', '-qb', 'repair-side');
  fixture.repair(broken);
  fixture.commit('侧分支准确修复');
  fixture.git('checkout', '-q', 'main');
  fixture.save();
  const alternative = structuredClone(fixture.config);
  alternative.boundaries[0].activationEvidence.push('tests/additional.js');
  fixture.write('tests/additional.js', '// 补充证据。\n');
  fixture.repair(broken, alternative);
  fixture.commit('主分支不同完整修复');
  fixture.git('merge', '--no-ff', '-s', 'ours', '-m', '合并两个 repair 历史', 'repair-side');
  inputFailure(() => fixture.check(), /两个完整有效但不一致/);
});

test('AC22：修复某个 blob 不覆盖相邻未知坏 blob，旧 --against 无法规避', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  fixture.repair(broken);
  fixture.commit('首次准确修复');
  fixture.write(POLICY_PATH, '{another broken JSON');
  fixture.commit('另一损坏 blob');
  fixture.save();
  inputFailure(() => fixture.check(fixture.baseline), /无有效 repair/);
});

test('AC22：repair snapshot 与 evidence 禁止 symlink，历史缺对象仍为输入错误', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  const repair = fixture.repair(broken);
  const evidence = path.join(fixture.root, repair.reviewEvidence);
  fs.unlinkSync(evidence);
  fs.symlinkSync('../tests/behavior.js', evidence);
  inputFailure(() => fixture.check(), /symlink/);
  fs.unlinkSync(evidence);
  fixture.write(repair.reviewEvidence, '准确原始差异与重建理由。\n');
  fixture.commit('完整绑定');
  const blob = fixture.git('rev-parse', `HEAD:${repair.repairedPath}`);
  fs.unlinkSync(path.join(fixture.root, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  inputFailure(() => fixture.check(), /缺失对象|不可读取/);
});

test('AC22：从未有效的历史 symlink manifest 可前向替换为合法普通文件', (t) => {
  const fixture = createPolicyRepository(t);
  const broken = brokenHistory(fixture);
  const valid = fixture.repair(broken);
  fs.unlinkSync(path.join(fixture.root, REPAIRS_PATH));
  fs.symlinkSync('../docs/history-repair.md', path.join(fixture.root, REPAIRS_PATH));
  fixture.commit('无效 symlink 登记');
  fs.unlinkSync(path.join(fixture.root, REPAIRS_PATH));
  fixture.write(REPAIRS_PATH, { schemaVersion: 1, repairs: [valid] });
  const result = fixture.check();
  assert.deepEqual(result.violations, []);
  assert.ok(result.policyHistory.diagnostics.some((item) => /普通文件/.test(item.message)));
});
