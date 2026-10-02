'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  assertPackagedInputsClean,
  inspectPackagedInputs
} = require('../../../scripts/check-packaged-inputs');

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function createFixtureRepo(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-inputs-test-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<main>fixture</main>');
  fs.writeFileSync(path.join(repoRoot, 'assets', 'tracked.xlsx'), 'tracked');
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), '*.log\nsrc/build-info.js\n');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    build: {
      files: [
        'index.html',
        'package.json',
        'assets/**/*',
        'src/**/*',
        '!assets/app-icon-source.png',
        '!assets/.~*.xlsx'
      ]
    }
  }));
  git(repoRoot, ['init', '--quiet']);
  git(repoRoot, ['add', '.gitignore', 'index.html', 'package.json', 'assets/tracked.xlsx']);
  git(repoRoot, [
    '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'fixture'
  ]);
  // 上次构建残留的 ignored generated input 会在 gate 通过后被覆写，不应误阻断。
  fs.writeFileSync(path.join(repoRoot, 'src', 'build-info.js'), 'stale-generated');
  return repoRoot;
}

test('packaged-input gate 允许 clean CI checkout', (t) => {
  const repoRoot = createFixtureRepo(t);
  const report = assertPackagedInputsClean(repoRoot);
  assert.deepEqual(report.dirtyTracked, []);
  assert.deepEqual(report.untracked, []);
});

test('packaged-input gate 拒绝 build.files 会收录的未跟踪文件', (t) => {
  const repoRoot = createFixtureRepo(t);
  fs.writeFileSync(path.join(repoRoot, 'assets', 'private-input.xlsx'), 'private');
  fs.writeFileSync(path.join(repoRoot, 'assets', '.private-input.xlsx'), 'private-dotfile');
  fs.writeFileSync(path.join(repoRoot, 'assets', 'private-input.log'), 'ignored-private');
  const report = inspectPackagedInputs(repoRoot);
  assert.deepEqual(report.untracked, [
    'assets/.private-input.xlsx',
    'assets/private-input.log',
    'assets/private-input.xlsx'
  ]);
  assert.throws(
    () => assertPackagedInputsClean(repoRoot),
    (error) => error && error.code === 'PACKAGED_INPUTS_DIRTY'
  );
});

test('packaged-input gate 不把明确排除的未跟踪素材当作 packaged input', (t) => {
  const repoRoot = createFixtureRepo(t);
  fs.writeFileSync(path.join(repoRoot, 'assets', 'app-icon-source.png'), 'source');
  fs.writeFileSync(path.join(repoRoot, 'assets', '.~open.xlsx'), 'lock');
  const report = assertPackagedInputsClean(repoRoot);
  assert.deepEqual(report.untracked, []);
});

test('packaged-input gate 拒绝 build.files 内 tracked dirty 文件', (t) => {
  const repoRoot = createFixtureRepo(t);
  fs.appendFileSync(path.join(repoRoot, 'index.html'), '\n<!-- dirty -->');
  assert.deepEqual(inspectPackagedInputs(repoRoot).dirtyTracked, ['index.html']);
  assert.throws(
    () => assertPackagedInputsClean(repoRoot),
    (error) => error && error.code === 'PACKAGED_INPUTS_DIRTY'
  );
});


function addLockFileSet(repoRoot) {
  const filename = path.join(repoRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'));
  // 普通 matcher 的排除不能抹掉独立 FileSet 会带入包中的 lock。
  pkg.build.files.push('!package-lock.json', { from: '.', to: '.', filter: ['package-lock.json'] });
  fs.writeFileSync(filename, JSON.stringify(pkg));
  git(repoRoot, ['add', 'package.json']);
  git(repoRoot, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'lock mapping']);
}

test('独立 FileSet 中的未跟踪 lock 仍被打包输入门禁拒绝', (t) => {
  const root = createFixtureRepo(t);
  addLockFileSet(root);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  assert.deepEqual(inspectPackagedInputs(root).untracked, ['package-lock.json']);
  assert.throws(() => assertPackagedInputsClean(root), { code: 'PACKAGED_INPUTS_DIRTY' });
});

test('独立 FileSet 中已跟踪 lock 干净时通过，修改或删除时拒绝', (t) => {
  const root = createFixtureRepo(t);
  addLockFileSet(root);
  const lock = path.join(root, 'package-lock.json');
  fs.writeFileSync(lock, '{}');
  git(root, ['add', 'package-lock.json']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'lock']);
  assert.deepEqual(assertPackagedInputsClean(root).dirtyTracked, []);
  fs.appendFileSync(lock, '\n');
  assert.deepEqual(inspectPackagedInputs(root).dirtyTracked, ['package-lock.json']);
  assert.throws(() => assertPackagedInputsClean(root), { code: 'PACKAGED_INPUTS_DIRTY' });
  fs.unlinkSync(lock);
  assert.deepEqual(inspectPackagedInputs(root).dirtyTracked, ['package-lock.json']);
});

test('打包输入门禁拒绝未支持的文件映射，不能静默缩小检查范围', (t) => {
  const root = createFixtureRepo(t);
  const filename = path.join(root, 'package.json');
  for (const fileSet of [
    { from: '..', to: '.', filter: ['package-lock.json'] },
    { from: '.', to: 'elsewhere', filter: ['package-lock.json'] },
    { from: '.', to: '.', filter: [] },
    { from: '.', to: '.', filter: ['package-lock.json'], unknown: true }
  ]) {
    fs.writeFileSync(filename, JSON.stringify({ build: { files: [fileSet] } }));
    assert.throws(() => inspectPackagedInputs(root), /不支持的文件映射/);
  }
});
