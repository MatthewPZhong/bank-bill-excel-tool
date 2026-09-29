'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseTapSummary } = require('../../scripts/run-unit-tests');

function fixture(t, { fail = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(name, source) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  write('scripts/run-unit-tests.js', fs.readFileSync(path.join(__dirname, '../../scripts/run-unit-tests.js')));
  write('tests/unit/root.test.js', "require('node:test')('root', () => {});\n");
  write('tests/unit/中文 nested/deep/child.test.js',
    `require('node:test')('nested', () => { ${fail ? "throw new Error('fixture failure');" : ''} });\n`);
  write('tests/unit/中文 nested/helper.js', "throw new Error('helper must not execute');\n");
  write('tests/unit/ignored.spec.js', "throw new Error('spec must not execute');\n");
  write('tests/integration/ignored.test.js', "throw new Error('integration must not execute');\n");
  return root;
}

function run(root, args = []) {
  const env = { ...process.env, UNIT_TEST_CONCURRENCY: '1' };
  // 此处启动独立的 CLI；不继承外层 node:test 的内部二进制 reporter 上下文。
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  return spawnSync(process.execPath, ['scripts/run-unit-tests.js', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024
  });
}

test('unit runner 原生发现保持嵌套及中文路径，排除 helper、spec 与 integration', t => {
  const root = fixture(t);
  const result = run(root);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(parseTapSummary(result.stdout), {
    tests: 2, pass: 2, fail: 0, duration_ms: parseTapSummary(result.stdout).duration_ms
  });
  assert.match(result.stdout, /unit 文件数：2/);
  const logs = fs.readdirSync(path.join(root, 'logs/unit-tests'));
  assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(root, 'logs/unit-tests', logs[0]), 'utf8'), /退出码：0/);
});

test('unit runner 原生发现继续传播失败退出码和失败汇总', t => {
  const result = run(fixture(t, { fail: true }));
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const summary = parseTapSummary(result.stdout);
  assert.equal(summary.tests, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
  assert.match(result.stdout, /fixture failure/);
});

test('unit runner 原生发现保留覆盖率模式和同一测试集合', t => {
  const result = run(fixture(t), ['--coverage']);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(parseTapSummary(result.stdout).pass, 2);
  assert.match(result.stdout, /start of coverage report/);
  assert.match(result.stdout, /end of coverage report/);
});
