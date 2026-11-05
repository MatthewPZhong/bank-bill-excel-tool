'use strict';

// v3.2.15 B43：集成测试 runner 的分片、并发与独占脚本。本地默认（不分片、并发 1）保持按脚本名串行；
//   分片合起来恰好覆盖全部脚本，汇总、退出码与 §七 回写不受执行顺序影响，分片运行不回写 §七。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  HEAVY_SCRIPTS_FIRST,
  isExclusiveScript,
  parseConcurrency,
  parseShard,
  runScripts,
  selectShardScripts
} = require('../../../scripts/integration-runner');

const ROOT = path.join(__dirname, '..', '..', '..');
const ALL_SCRIPTS = fs.readdirSync(path.join(ROOT, 'scripts', 'integration'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => name.slice(0, -3));

test('分片与并发参数：未设置为不分片、并发 1；格式不对时报错', () => {
  assert.equal(parseShard(undefined), null);
  assert.equal(parseShard(''), null);
  assert.deepEqual(parseShard('2/2'), { index: 2, total: 2 });
  for (const value of ['0/2', '3/2', '1/0', '2', 'x/y']) assert.throws(() => parseShard(value), /INTEGRATION_SHARD/, value);
  assert.equal(parseConcurrency(undefined), 1);
  assert.equal(parseConcurrency(' 3 '), 3);
  for (const value of ['0', '-1', '1.5', 'two']) assert.throws(() => parseConcurrency(value), /INTEGRATION_CONCURRENCY/, value);
});

test('当前全部集成脚本按 2、3 片分配：不重不漏，耗时最长的脚本分到不同的片', () => {
  for (const total of [2, 3]) {
    const shards = Array.from({ length: total }, (_value, index) => selectShardScripts(ALL_SCRIPTS, { index: index + 1, total }));
    const flat = shards.flat();
    assert.equal(flat.length, ALL_SCRIPTS.length, `${total} 片总数`);
    assert.deepEqual([...flat].sort(), [...ALL_SCRIPTS].sort(), `${total} 片合起来是全部脚本`);
    shards.forEach((shard) => assert.deepEqual(shard, [...shard].sort(), '每片按脚本名排序'));
    const heavyPresent = HEAVY_SCRIPTS_FIRST.filter((name) => ALL_SCRIPTS.includes(name)).slice(0, total);
    const owners = heavyPresent.map((name) => shards.findIndex((shard) => shard.includes(name)));
    assert.equal(new Set(owners).size, total, `最长的 ${total} 个脚本各在一片`);
  }
  assert.deepEqual(selectShardScripts(['b', 'a'], null), ['a', 'b'], '不分片时按脚本名排序');
});

test('独占名单：Electron、内存 / 准入 / 耗时相关脚本独占，普通业务脚本可并发', () => {
  for (const name of ['renderer-lifecycle', 'packaged-memory-identity', 'toolbox-large-file-stream', 'toolbox-low-memory-foundation',
    'production-memory-qualification', 'toolbox-rows-csv-admission', 'big-table-import-engine', 'background-execution-pure-compute-canary',
    'acquiring-bill-currency-idle-cleanup', 'publication-legacy-concurrency', 'biz-op-query-boundary', 'vcc-financial-op-result-workbook']) {
    assert.equal(isExclusiveScript(name), true, name);
  }
  for (const name of ['release-notes-upgrade-prompt', 'statement-balance-gap', 'vcc-input-template-version', 'archive-center-permanent-delete']) {
    assert.equal(isExclusiveScript(name), false, name);
  }
  for (const name of HEAVY_SCRIPTS_FIRST) assert.ok(ALL_SCRIPTS.includes(name), `耗时清单中的 ${name} 须是现有脚本`);
});

function fakeRunner({ durations = {}, failing = [] } = {}) {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const runOne = async (name) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push({ type: 'start', name, active });
    await new Promise((resolve) => setTimeout(resolve, durations[name] ?? 5));
    active -= 1;
    events.push({ type: 'end', name });
    return { name, ok: !failing.includes(name) };
  };
  return { runOne, events, maxActive: () => maxActive };
}

test('并发 1：按脚本名逐个运行，与原 runner 一致', async () => {
  const fake = fakeRunner();
  const names = ['c-plain', 'toolbox-x', 'a-plain', 'b-plain'];
  const results = await runScripts(names, { concurrency: 1, runOne: fake.runOne });
  assert.equal(fake.maxActive(), 1);
  assert.deepEqual(fake.events.filter((event) => event.type === 'start').map((event) => event.name), ['a-plain', 'b-plain', 'c-plain', 'toolbox-x']);
  assert.deepEqual(results.map((result) => result.name), ['a-plain', 'b-plain', 'c-plain', 'toolbox-x']);
});

test('并发 k：独占脚本单独运行，其余最多 k 个同时运行；结果按脚本名排序，失败保留', async () => {
  const fake = fakeRunner({ durations: { 'a-plain': 30, 'b-plain': 5, 'c-plain': 5, 'd-plain': 20 }, failing: ['c-plain'] });
  const names = ['d-plain', 'renderer-lifecycle', 'c-plain', 'toolbox-large-file-stream', 'b-plain', 'a-plain'];
  const results = await runScripts(names, { concurrency: 3, runOne: fake.runOne });
  assert.ok(fake.maxActive() <= 3);
  assert.ok(fake.maxActive() > 1, '普通脚本确实并发运行');
  for (const event of fake.events.filter((item) => item.type === 'start' && isExclusiveScript(item.name))) {
    assert.equal(event.active, 1, `${event.name} 运行时没有其他脚本`);
  }
  const exclusiveEnd = Math.max(...fake.events.map((event, index) => (event.type === 'end' && isExclusiveScript(event.name) ? index : -1)));
  const sharedStart = Math.min(...fake.events.map((event, index) => (event.type === 'start' && !isExclusiveScript(event.name) ? index : Infinity)));
  assert.ok(exclusiveEnd < sharedStart, '独占脚本全部结束后才开始并发');
  assert.deepEqual(results.map((result) => [result.name, result.ok]), [
    ['a-plain', true], ['b-plain', true], ['c-plain', false], ['d-plain', true],
    ['renderer-lifecycle', true], ['toolbox-large-file-stream', true]
  ]);
});

// 真实 CLI：在临时仓库里放 runner 与几个假脚本，验证退出码、分片不回写 §七、完整运行回写 §七。
function cliFixture(t, { failing = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-runner-parallel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  write('scripts/integration-runner.js', fs.readFileSync(path.join(ROOT, 'scripts', 'integration-runner.js')));
  const pass = (count) => `setTimeout(() => console.log('==== ${count}/${count} PASS ===='), 20);\n`;
  write('scripts/integration/alpha-one.js', pass(1));
  write('scripts/integration/beta-two.js', pass(2));
  write('scripts/integration/toolbox-gamma.js', pass(3));
  write('scripts/integration/delta-four.js', failing
    ? "console.log('==== 0/1 PASS ===='); console.error('FAILURES: x'); process.exit(1);\n"
    : pass(4));
  write('rules/integration-test-policy.md', '# 规则\n\n## 七、当前集成测试清单（自动同步）\n\n旧清单\n\n## 八、其他\n');
  return root;
}

function runCli(root, env = {}) {
  const childEnv = { ...process.env, ...env };
  if (!('INTEGRATION_SHARD' in env)) delete childEnv.INTEGRATION_SHARD;
  if (!('INTEGRATION_CONCURRENCY' in env)) delete childEnv.INTEGRATION_CONCURRENCY;
  return spawnSync(process.execPath, ['scripts/integration-runner.js'], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 60000 });
}

test('CLI 并发运行全部脚本：全部通过时回写 §七，清单按脚本名排序', (t) => {
  const root = cliFixture(t);
  const result = runCli(root, { INTEGRATION_CONCURRENCY: '3' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /==== integration runner: 4 个脚本，并发 3（独占 1 个先单独运行） ====/);
  const policy = fs.readFileSync(path.join(root, 'rules', 'integration-test-policy.md'), 'utf8');
  const rows = policy.split('\n').filter((line) => line.startsWith('| `'));
  assert.deepEqual(rows.map((line) => line.split('`')[1]), ['alpha-one.js', 'beta-two.js', 'delta-four.js', 'toolbox-gamma.js']);
  assert.match(policy, /## 八、其他/);
  assert.match(result.stdout, /并发实际用时 \d+ms/);
});

test('CLI 分片运行：只跑本片、不回写 §七；任一失败时退出码非 0', (t) => {
  const root = cliFixture(t);
  const before = fs.readFileSync(path.join(root, 'rules', 'integration-test-policy.md'), 'utf8');
  const ran = ['1/2', '2/2'].map((shard) => {
    const result = runCli(root, { INTEGRATION_SHARD: shard, INTEGRATION_CONCURRENCY: '2' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`分片运行（第 ${shard} 片），不回写`));
    return [...result.stdout.matchAll(/✓ (\S+) /g)].map((match) => match[1]);
  });
  assert.deepEqual(ran.flat().sort(), ['alpha-one', 'beta-two', 'delta-four', 'toolbox-gamma']);
  assert.equal(fs.readFileSync(path.join(root, 'rules', 'integration-test-policy.md'), 'utf8'), before);

  const failed = runCli(cliFixture(t, { failing: true }), { INTEGRATION_CONCURRENCY: '2' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /✗ delta-four/);
  assert.match(failed.stderr, /1 个集成脚本失败/);

  const invalid = runCli(root, { INTEGRATION_SHARD: '3/2' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /INTEGRATION_SHARD 须为 i\/n/);
});
