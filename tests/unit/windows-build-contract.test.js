'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('Windows PR 对任意目标分支跑 release-check、x64 完整构建与 check-dist', () => {
  const workflow = read('.github/workflows/build-windows.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\n\s*- '\*\*'/);
  assert.match(workflow, /Run release checks\s*\n\s*run: npm run release-check/);
  assert.doesNotMatch(workflow, /if:\s*github\.event_name\s*!=\s*'pull_request'/);

  const buildJob = workflow.slice(workflow.indexOf('\n  build:'));
  assert.match(buildJob, /npm run prepare:dist\s*\n\s*npx electron-builder/);
  assert.match(buildJob, /npx electron-builder --win --x64 --publish never/);
  assert.match(buildJob, /node scripts\/check-dist-size\.js/);
  assert.match(buildJob, /dist\/bank-bill-excel-tool-setup-\*\.exe/);
  assert.match(buildJob, /dist\/bank-bill-excel-tool-portable-\*\.exe/);
});

test('Windows 本地与发布构建全部锁定 x64，避免检查陈旧 win-unpacked', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(
    packageJson.scripts['prepare:dist'],
    'npm run check:packaged-inputs && npm run prebuild:meta'
  );
  for (const scriptName of ['dist:win', 'dist:win:setup', 'dist:win:portable']) {
    assert.match(packageJson.scripts[scriptName], /^npm run prepare:dist &&/);
    assert.match(packageJson.scripts[scriptName], /electron-builder --win(?:\s+(?:nsis|portable))? --x64 --publish never/);
  }
  assert.match(read('.github/workflows/release-windows.yml'), /electron-builder --win --x64 --publish never/);
  assert.match(read('scripts/check-dist-size.js'), /断言④包内版本不匹配/);
  assert.match(read('scripts/check-dist-size.js'), /断言⑤包内构建提交不匹配/);
});
