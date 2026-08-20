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
  const smokeJob = workflow.slice(workflow.indexOf('\n  smoke-test:'), workflow.indexOf('\n  build:'));
  assert.match(smokeJob, /uses: actions\/checkout@v6\s*\n\s*with:\s*\n\s*fetch-depth: 0/);
  assert.match(workflow, /Run release checks\s*\n\s*run: npm run release-check/);
  assert.match(workflow, /Verify Windows startup process adapter semantics\s*\n\s*env:\s*\n\s*WINDOWS_STARTUP_PROCESS_ADAPTER_REAL_TEST: '1'\s*\n\s*run: node --test tests\/unit\/scripts\/startup-process-adapter\.test\.js/);
  assert.ok(
    workflow.indexOf('Run release checks')
      < workflow.indexOf('Verify Windows startup process adapter semantics'),
    '真实 Windows 进程探针必须在全量 release-check 之后独立串行运行'
  );
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
  const releaseWorkflow = read('.github/workflows/release-windows.yml');
  assert.match(releaseWorkflow, /electron-builder --win --x64 --publish never/);
  assert.match(releaseWorkflow, /Verify Windows startup process adapter semantics\s*\n\s*env:\s*\n\s*WINDOWS_STARTUP_PROCESS_ADAPTER_REAL_TEST: '1'\s*\n\s*run: node --test tests\/unit\/scripts\/startup-process-adapter\.test\.js/);
  assert.ok(
    releaseWorkflow.indexOf('Run release checks')
      < releaseWorkflow.indexOf('Verify Windows startup process adapter semantics'),
    '发布工作流同样必须先跑全量门禁，再串行执行真实 Windows 进程探针'
  );
  assert.match(read('scripts/check-dist-size.js'), /断言④包内版本不匹配/);
  assert.match(read('scripts/check-dist-size.js'), /断言⑤包内构建提交不匹配/);
});

test('真实 Windows 进程探针不与全量单测并发，只由专用工作流环境显式开启', () => {
  const adapterTest = read('tests/unit/scripts/startup-process-adapter.test.js');
  assert.match(
    adapterTest,
    /process\.env\.WINDOWS_STARTUP_PROCESS_ADAPTER_REAL_TEST !== '1'/
  );
});
