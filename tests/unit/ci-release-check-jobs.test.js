'use strict';

// v3.2.15 B43：Windows CI 把 release-check 拆成并行 job。门禁不降低：
//   - 各并行 job 的检查命令合起来恰好是 package.json 的 release-check（单测、集成测试的分片合起来是全部）；
//   - 每个并行 job 都沿用 smoke-test 的 v3.2.1 final gate 守卫、exact head checkout、修复血缘与 release-check 运行条件；
//   - smoke-test 依赖全部并行 job，依赖失败时仍运行并在汇总步骤失败（必需检查不会显示为 skipped）；
//   - 必需检查名 smoke-test、build 不变；发布 workflow 仍完整运行 release-check。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { RELEASE_CHECK_JOBS, verifyReleaseCheckJobs } = require('../../scripts/ci/verify-release-check-jobs');

const ROOT = path.join(__dirname, '..', '..');
// Windows checkout 可能把换行转为 CRLF，统一为 LF 后再按行结构解析。
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/build-windows.yml');

function jobText(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `缺少 job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const normalize = (text) => text.split(/\r?\n/).map((line) => line.trim()).join(' ').trim();

function stepText(job, stepName) {
  const start = job.indexOf(`- name: ${stepName}\n`);
  assert.notEqual(start, -1, `缺少步骤 ${stepName}`);
  const next = job.indexOf('\n      - name: ', start + 1);
  return next === -1 ? job.slice(start) : job.slice(start, next);
}

function stepCondition(step) {
  const match = step.match(/if: >-\s*\n([\s\S]*?)\n\s*(?:run|shell):/);
  assert.ok(match, '步骤缺少 if: >- 条件');
  return normalize(match[1]);
}

const STEP_NAMES = {
  'release-check-static': 'Run lint, architecture and smoke checks',
  'release-check-unit': 'Run unit tests shard',
  'release-check-integration': 'Run integration tests shard'
};

test('并行 job 的检查命令合起来恰好是 package.json 的 release-check', () => {
  const pkg = JSON.parse(read('package.json'));
  const releaseCheck = pkg.scripts['release-check'].split('&&').map((part) => part.trim());
  assert.deepEqual(Object.values(RELEASE_CHECK_JOBS).flat(), releaseCheck, '顺序也与 release-check 一致');
  assert.deepEqual(Object.keys(STEP_NAMES), Object.keys(RELEASE_CHECK_JOBS));
  for (const [jobName, commands] of Object.entries(RELEASE_CHECK_JOBS)) {
    const step = stepText(jobText(jobName), STEP_NAMES[jobName]);
    assert.match(step, new RegExp(`\\n\\s*run: ${commands.join(' && ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`), jobName);
  }
  assert.doesNotMatch(jobText('smoke-test'), /npm run release-check/, 'smoke-test 不再重复跑完整 release-check');
  assert.match(read('.github/workflows/release-windows.yml'), /run: npm run release-check/, '发布 workflow 仍完整运行 release-check');
});

test('单测 5 片、集成测试 2 片：matrix 与分片参数一致，失败不取消其他分片', () => {
  const unit = jobText('release-check-unit');
  assert.match(unit, /strategy:\s*\n\s*fail-fast: false\s*\n\s*matrix:\s*\n\s*shard: \[1, 2, 3, 4, 5\]/);
  assert.match(unit, /UNIT_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/5/);
  const integration = jobText('release-check-integration');
  assert.match(integration, /strategy:\s*\n\s*fail-fast: false\s*\n\s*matrix:\s*\n\s*shard: \[1, 2\]/);
  assert.match(integration, /INTEGRATION_SHARD: \$\{\{ matrix\.shard \}\}\/2/);
  assert.match(integration, /INTEGRATION_CONCURRENCY: '2'/);
  const staticJob = jobText('release-check-static');
  assert.match(staticJob, /- name: Resolve architecture policy comparison\s*\n\s*id: architecture-policy/);
  assert.match(stepText(staticJob, STEP_NAMES['release-check-static']),
    /ARCHITECTURE_BASE_REF: \$\{\{ steps\.architecture-policy\.outputs\.base \}\}/);
});

test('每个并行 job 沿用 smoke-test 的 final gate 守卫、exact head checkout、修复血缘与 release-check 运行条件', () => {
  const smoke = jobText('smoke-test');
  const expectedGuard = stepCondition(stepText(smoke, 'Reject unauthorized v3.2.1 final-gate invocation'));
  const expectedLineage = stepCondition(stepText(smoke, 'Verify authorized v3.2.1 repair lineage'));
  const expectedRun = stepCondition(stepText(smoke, 'Run release checks'));
  const checkoutRef = "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
  for (const jobName of Object.keys(RELEASE_CHECK_JOBS)) {
    const job = jobText(jobName);
    const guardAt = job.indexOf('- name: Reject unauthorized v3.2.1 final-gate invocation');
    const checkoutAt = job.indexOf('- name: Checkout');
    const lineageAt = job.indexOf('- name: Verify authorized v3.2.1 repair lineage');
    const setupAt = job.indexOf('- name: Setup Node.js');
    assert.ok(guardAt !== -1 && guardAt < checkoutAt && checkoutAt < lineageAt && lineageAt < setupAt, `${jobName} 步骤顺序`);
    const guard = stepText(job, 'Reject unauthorized v3.2.1 final-gate invocation');
    assert.equal(stepCondition(guard), expectedGuard, `${jobName} 守卫条件`);
    assert.match(guard, /exit 1/);
    assert.equal(stepCondition(stepText(job, 'Verify authorized v3.2.1 repair lineage')), expectedLineage, `${jobName} 血缘条件`);
    assert.ok(job.includes(checkoutRef), `${jobName} checkout 绑定 PR head`);
    assert.match(job, /uses: actions\/checkout@v6\s*\n\s*with:\s*\n\s*fetch-depth: 0/);
    assert.equal(stepCondition(stepText(job, STEP_NAMES[jobName])), expectedRun, `${jobName} 运行条件`);
    assert.match(job, /runs-on: windows-latest/);
  }
});

test('smoke-test 依赖全部并行 job，依赖失败也运行并由汇总步骤失败；build 仍依赖 smoke-test', () => {
  const smoke = jobText('smoke-test');
  assert.match(smoke, /needs: \[release-check-static, release-check-unit, release-check-integration\]/);
  assert.match(smoke, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(jobText('build'), /needs: smoke-test/);
  const jobs = [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((match) => match[1]);
  assert.deepEqual(jobs, ['bizop-durability-contract', 'release-check-static', 'release-check-unit',
    'release-check-integration', 'smoke-test', 'build'], 'smoke-test 紧接在 build 之前（v3.2.1 证据校验按此切分）');
});

test('汇总核对：全部 success 才通过；失败、跳过、取消、缺失或输入无效都不通过', () => {
  const all = Object.fromEntries(Object.keys(RELEASE_CHECK_JOBS).map((job) => [job, { result: 'success', outputs: {} }]));
  assert.equal(verifyReleaseCheckJobs(JSON.stringify(all)).ok, true);
  for (const result of ['failure', 'skipped', 'cancelled']) {
    const verdict = verifyReleaseCheckJobs(JSON.stringify({ ...all, 'release-check-unit': { result } }));
    assert.equal(verdict.ok, false, result);
    assert.ok(verdict.lines.some((line) => line.startsWith(`FAIL release-check-unit：${result}`)));
  }
  const missing = { ...all };
  delete missing['release-check-integration'];
  assert.equal(verifyReleaseCheckJobs(JSON.stringify(missing)).ok, false);
  for (const raw of ['', 'not json', '[]', 'null']) assert.equal(verifyReleaseCheckJobs(raw).ok, false, raw);
});
