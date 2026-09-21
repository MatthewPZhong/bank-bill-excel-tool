'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { checkPolicyHistory } = require('../../../../scripts/architecture/policy-history');
const projectPolicy = require('../../../../architecture/boundaries.json');

const POLICY_PATH = 'architecture/boundaries.json';
const ALLOWLIST_PATH = 'architecture/legacy-allowlist.json';
const REPAIRS_PATH = 'architecture/policy-history-repairs.json';

function createPolicyRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  function write(relative, value) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  function commit(message = 'fixture') { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); }
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Architecture Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  write('src/entry.js', 'module.exports = {};\n');
  write('src/consumer.js', "require('./entry');\n");
  const plannedBoundaries = structuredClone(projectPolicy.boundaries);
  for (const planned of plannedBoundaries) {
    if (['production-graph', 'platform-core'].includes(planned.id)) {
      planned.state = 'active';
      planned.activationEvidence = [];
      planned.requiredConsumers = [];
      for (const entrypoint of planned.entrypoints) write(entrypoint, 'module.exports = {};\n');
    } else planned.state = 'pending';
  }
  write('tests/behavior.js', '// 明确的公开行为验证入口。\n');
  write('index.html', '<!doctype html><title>fixture</title>\n');
  const baseline = commit('S0 无配置');
  const boundary = {
    id: 'fixture-core', governance: 'G8', owner: 'fixture', state: 'active', rules: ['ARCH-PLATFORM-CORE'],
    entrypoints: ['src/entry.js'], allowedLocal: ['src/entry.js'], allowedExternal: ['node:crypto'],
    requiredConsumers: [{ from: 'src/consumer.js', to: 'src/entry.js', kind: 'require', importedNames: [] }],
    activationEvidence: ['tests/behavior.js'], protectedScopes: [], restrictedApis: [], allowedSites: [],
    compositionEntrypoints: [], globals: [], factory: null, allowedApiFields: {}, deprecatedEntrypoints: [], directory: null
  };
  const fixture = { root, git, write, commit, baseline, boundary,
    config: { schemaVersion: 1, factBaseline: baseline, bootstrap: { factBaseline: baseline, mode: 'first-introduction' }, boundaries: [boundary, ...plannedBoundaries], generatedModules: [], dynamicLoads: [], policyChanges: [] },
    allowlist: { schemaVersion: 1, factBaseline: baseline, exceptions: [] }
  };
  fixture.save = () => { write(POLICY_PATH, fixture.config); write(ALLOWLIST_PATH, fixture.allowlist); };
  fixture.check = (against = 'HEAD') => checkPolicyHistory({ root, config: fixture.config, allowlist: fixture.allowlist, against });
  fixture.change = (at, field, from, to) => {
    write('docs/migration.md', '精确迁移旧入口和生产消费者，原禁止能力保持；核查真实调用方向及验证入口。\n');
    const entry = { sourceCommit: at, sourcePolicyBlob: git('rev-parse', `${at}:${POLICY_PATH}`), boundaryId: boundary.id, field, from, to, reason: '入口与消费者按同一迁移合同迁移', designDoc: 'docs/migration.md' };
    fixture.config.policyChanges.push(entry);
    return entry;
  };
  fixture.moveConsumer = (at, target) => {
    const from = structuredClone(boundary.requiredConsumers);
    boundary.requiredConsumers = from.map((consumer) => ({ ...consumer, to: target }));
    write('src/consumer.js', `require('./${path.posix.basename(target, '.js')}');\n`);
    fixture.change(at, 'requiredConsumers', from, structuredClone(boundary.requiredConsumers));
  };
  fixture.repair = (at, rebuilt = fixture.config, relative = POLICY_PATH) => {
    const originalBlob = git('rev-parse', `${at}:${relative}`);
    const repairedPath = `architecture/policy-history-repairs/${originalBlob}.json`;
    const bytes = `${JSON.stringify(rebuilt, null, 2)}\n`;
    write(repairedPath, bytes);
    write('docs/history-repair.md', '原始配置仅末尾括号前多一个逗号；重建删除该逗号，保留全部边界、消费者及禁止能力。\n');
    const entry = { path: relative, originalBlob, sourceCommits: [at], repairedPath,
      repairedSha256: crypto.createHash('sha256').update(bytes).digest('hex'), reason: '仅修复末尾多余逗号，保留完整语义', reviewEvidence: 'docs/history-repair.md' };
    write(REPAIRS_PATH, { schemaVersion: 1, repairs: [entry] });
    return entry;
  };
  fixture.save();
  return fixture;
}

module.exports = { createPolicyRepository, POLICY_PATH, ALLOWLIST_PATH, REPAIRS_PATH };
