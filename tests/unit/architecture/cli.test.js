'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseArguments, FACT_BASELINE } = require('../../../scripts/check-architecture');
const { selectPolicyBase, main: ciMain } = require('../../../scripts/architecture/ci-policy-base');
const root = path.resolve(__dirname, '../../..');
const cli = path.join(root, 'scripts/check-architecture.js');

function command(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ARCHITECTURE_BASE_REF: '', ...env } });
}

test('显式 root 或离线克隆仍不能把项目已知事实基线换成后来的空配置提交', t => {
  const f = cliRepository(t);
  // 只读本地对象库，不修改项目 ref；模拟保留了真实项目历史的离线检查仓库。
  const objects = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd: root, encoding: 'utf8' }).trim();
  f.write('.git/objects/info/alternates', objects + '\n');
  const result = f.run();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /不能替换固定 v3.2.9/);
});

test('参数显式、CLI对比提交优先，未知参数或相对证据路径报输入错误', () => {
  assert.equal(parseArguments([], {}).against, 'HEAD');
  assert.equal(parseArguments(['--against', FACT_BASELINE], { ARCHITECTURE_BASE_REF: 'HEAD' }).against, FACT_BASELINE);
  assert.equal(parseArguments([], { ARCHITECTURE_BASE_REF: FACT_BASELINE }).against, FACT_BASELINE);
  for (const args of [['--accept-all'], ['--root', '.'], ['--json', 'x.json'], ['--against'], ['--against', '--all'], ['--against', 'HEAD', '--against', 'HEAD']]) {
    assert.throws(() => parseArguments(args, {}));
    assert.equal(command(args).status, 2);
  }
});

test('CI 使用真实 PR/push 对比，tag/manual 用已核对 HEAD，不能以空基线恢复', () => {
  const head = 'a'.repeat(40), before = 'b'.repeat(40);
  const common = { head, expectedHead: head, eventBase: before };
  assert.equal(selectPolicyBase({ ...common, eventName: 'pull_request' }), before);
  assert.equal(selectPolicyBase({ ...common, eventName: 'push', refType: 'branch' }), before);
  assert.equal(selectPolicyBase({ ...common, eventName: 'push', refType: 'tag' }), head);
  assert.equal(selectPolicyBase({ ...common, eventName: 'workflow_dispatch' }), head);
  for (const eventBase of ['', undefined, '0'.repeat(40)]) assert.throws(() => selectPolicyBase({ ...common, eventName: 'push', eventBase }));
  assert.throws(() => selectPolicyBase({ ...common, eventName: 'workflow_dispatch', expectedHead: before }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-ci-'));
  try {
    const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const output = path.join(dir, 'output');
    assert.equal(ciMain({ GITHUB_EVENT_NAME: 'workflow_dispatch', ARCHITECTURE_EXPECTED_HEAD: actualHead, GITHUB_OUTPUT: output }, root), actualHead);
    assert.equal(fs.readFileSync(output, 'utf8'), `base=${actualHead}\n`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('现有 CI 使用同一完整门禁且全量获取历史，tag/main guard 保留', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:architecture'], 'node scripts/check-architecture.js');
  assert.equal(pkg.scripts['release-check'], 'npm run lint && npm run check:architecture && npm run smoke && npm run test:unit && npm run test:integration');
  assert.equal(pkg.devDependencies.acorn, '8.17.0');
  for (const name of ['build-windows.yml', 'release-windows.yml']) {
    const yaml = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    assert.match(yaml, /fetch-depth: 0/);
    assert.match(yaml, /run: node scripts\/architecture\/ci-policy-base\.js/);
    assert.match(yaml, /ARCHITECTURE_BASE_REF: \$\{\{ steps\.architecture-policy\.outputs\.base \}\}/);
    assert.match(yaml, /github\.event\.pull_request\.base\.sha/);
    assert.match(yaml, /github\.event\.before/);
    assert.match(yaml, /run: npm run release-check/);
  }
  assert.match(fs.readFileSync(path.join(root, '.github/workflows/release-windows.yml'), 'utf8'), /Release tag must point to the current main commit/);
});

// 真实 Git 历史 + scanner/rules/CLI 的集成回归，不加载 fixture 业务代码。
function cliRepository(t) {
  const { createPolicyRepository } = require('./fixtures/policy-repository');
  const f = createPolicyRepository(t);
  // 复用合成仓库的激活状态；生产 release 的激活证据不属于这个最小 Git fixture。
  const production = structuredClone(f.config);
  production.factBaseline = f.baseline;
  production.bootstrap.factBaseline = f.baseline;
  production.dynamicLoads = [];
  production.generatedModules = [];
  production.policyChanges = [];
  for (const b of production.boundaries) {
    if (b.state !== 'active') continue;
    for (const entry of b.entrypoints) f.write(entry, 'module.exports = {};\n');
    for (const evidence of b.activationEvidence) f.write(evidence, '// fixture行为入口\n');
  }
  f.config = production;
  f.save();
  f.run = (args = [], env = {}) => command(['--root', f.root, ...args], env);
  return f;
}

test('CLI确定性、默认只读、不执行业务；显式报告与失败出口真实生效', t => {
  const f = cliRepository(t);
  const marker = path.join(f.root, 'should-never-execute');
  f.write('src/never-run.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`);
  f.save(); f.commit('S1 complete bootstrap');
  const status = f.git('status', '--porcelain', '--untracked-files=all');
  const first = f.run(), second = f.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(f.git('status', '--porcelain', '--untracked-files=all'), status);
  const report = path.join(f.root, 'report.json');
  assert.equal(f.run(['--json', report]).status, 0);
  const json = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.ok(json.limitations.length >= 4);
  assert.ok(json.coverage.pendingBoundaries.length > 0);
  f.write('src/a.js', "require('./b');\n"); f.write('src/b.js', "require('./a');\n");
  assert.equal(f.run().status, 1);
  f.write('src/b.js', 'function {');
  assert.equal(f.run().status, 2);
  assert.equal(f.run(['--json', path.join(f.root, 'missing', 'report.json')]).status, 2);
});

test('CLI事件参数不能遗忘 S1 active，修复当前树可以前向恢复', t => {
  const f = cliRepository(t);
  f.commit('S1 active core');
  const active = f.config.boundaries.find(b => b.id === 'fixture-core');
  const entry = active.entrypoints[0];
  active.state = 'pending'; fs.unlinkSync(path.join(f.root, entry)); f.save();
  f.commit('S2 attempted downgrade');
  for (const env of [{}, { GITHUB_EVENT_NAME: 'pull_request', ARCHITECTURE_BASE_REF: f.baseline },
    { GITHUB_EVENT_NAME: 'push', ARCHITECTURE_BASE_REF: f.baseline },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', ARCHITECTURE_BASE_REF: 'HEAD' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', ARCHITECTURE_BASE_REF: 'HEAD' }]) {
    const result = f.run([], env); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /ARCH-POLICY-HISTORY/);
  }
  active.state = 'active'; f.write(entry, 'module.exports = {};'); f.save();
  assert.equal(f.run(['--against', f.baseline]).status, 0);
  fs.unlinkSync(path.join(f.root, 'architecture/boundaries.json'));
  assert.equal(f.run().status, 2);
});

test('AC22：真实 CI 事件选基线后，CLI 同样要求精确 repair 并保留激活约束', t => {
  const f = cliRepository(t);
  f.commit('S1 active');
  f.write('architecture/boundaries.json', JSON.stringify(f.config).replace(/}$/, ',}'));
  const broken = f.commit('S2 仅末尾逗号损坏');
  f.save();
  f.commit('S3 当前语法恢复');
  const head = f.git('rev-parse', 'HEAD');
  const events = [{ name: 'local' }, { name: 'pull_request', type: 'branch' }, { name: 'push', type: 'branch' },
    { name: 'push', type: 'tag' }, { name: 'workflow_dispatch', type: 'branch' }];
  const invoke = event => {
    let base = 'HEAD';
    if (event.name !== 'local') {
      const output = path.join(f.root, 'ci-output');
      fs.rmSync(output, { force: true });
      ciMain({ GITHUB_EVENT_NAME: event.name, GITHUB_REF_TYPE: event.type,
        ARCHITECTURE_EVENT_BASE: f.baseline, ARCHITECTURE_EXPECTED_HEAD: head, GITHUB_OUTPUT: output }, f.root);
      base = fs.readFileSync(output, 'utf8').trim().slice('base='.length);
    }
    return f.run([], { ARCHITECTURE_BASE_REF: base, ARCHITECTURE_EXPECTED_HEAD: head });
  };
  for (const event of events) {
    const result = invoke(event);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /无有效 repair/);
  }
  const repair = f.repair(broken);
  for (const event of events) {
    const result = invoke(event);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(repair.originalBlob));
    assert.ok(result.stdout.includes(repair.reviewEvidence));
  }
  const active = f.config.boundaries.find(b => b.id === 'fixture-core');
  active.state = 'pending'; f.save();
  for (const event of events) assert.equal(invoke(event).status, 1, event.name);
  active.state = 'active'; f.save();
  fs.unlinkSync(path.join(f.root, active.entrypoints[0]));
  for (const event of events) assert.equal(invoke(event).status, 1, event.name);
});
