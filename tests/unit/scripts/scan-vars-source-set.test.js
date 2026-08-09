'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCANNER_PATH = path.join(REPO_ROOT, 'scripts', 'scan-vars.js');

test('scan-vars 只统计 Git 已跟踪 JS，排除 ignored/generated 与普通 untracked 文件', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-vars-source-set-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(fixtureRoot, '.gitignore'), 'src/generated.js\n');
  fs.copyFileSync(SCANNER_PATH, path.join(fixtureRoot, 'scripts', 'scan-vars.js'));
  fs.writeFileSync(
    path.join(fixtureRoot, 'src', 'tracked.js'),
    'const TRACKED_TOKEN = 1;\nmodule.exports = TRACKED_TOKEN;\n'
  );
  fs.writeFileSync(
    path.join(fixtureRoot, 'src', 'generated.js'),
    'const GENERATED_TOKEN = 1;\nmodule.exports = GENERATED_TOKEN;\n'
  );
  fs.writeFileSync(
    path.join(fixtureRoot, 'src', 'untracked.js'),
    'const UNTRACKED_TOKEN = 1;\nmodule.exports = UNTRACKED_TOKEN;\n'
  );

  execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot });
  execFileSync(
    'git',
    ['add', '.gitignore', 'package.json', 'scripts/scan-vars.js', 'src/tracked.js'],
    { cwd: fixtureRoot }
  );
  execFileSync(
    process.execPath,
    ['scripts/scan-vars.js', '--out-md', 'report.md', '--out-json', 'report.json', '--silent'],
    { cwd: fixtureRoot }
  );

  const report = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'report.json'), 'utf8'));
  const reportText = fs.readFileSync(path.join(fixtureRoot, 'report.md'), 'utf8');
  const serialized = JSON.stringify(report);
  assert.equal(report.meta.sourceSet, 'git-tracked-js');
  assert.equal(report.meta.totalFiles, 1);
  assert.match(serialized, /TRACKED_TOKEN/);
  assert.doesNotMatch(serialized, /GENERATED_TOKEN|UNTRACKED_TOKEN|generated\.js|untracked\.js/);
  assert.match(reportText, /Git 已跟踪 `\.js`（排除 ignored\/generated\/untracked）/);
});
