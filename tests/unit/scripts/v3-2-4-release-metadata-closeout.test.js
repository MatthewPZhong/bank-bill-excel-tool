'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8')
    .replace(/\r\n?/g, '\n');
}

function section(document, heading) {
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, 'missing heading: ' + heading);
  const next = document.indexOf('\n## ', start + heading.length);
  return document.slice(start, next === -1 ? document.length : next);
}

function paragraph(document, marker) {
  const start = document.indexOf(marker);
  assert.notEqual(start, -1, 'missing marker: ' + marker);
  const next = document.indexOf('\n\n', start + marker.length);
  return document.slice(start, next === -1 ? document.length : next);
}

test('v3.2.4 closeout 同步当前版本、冻结文档、历史 evidence 与三份发布说明', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');
  const historicalSnapshot = JSON.parse(read(
    'changes/background-execution-r3-2-4-release-evidence/release-evidence.json'
  ));

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = packageJson.version.split('.').map(Number);
  assert.ok(
    major > 3 || (major === 3 && minor > 2) ||
      (major === 3 && minor === 2 && patch >= 4),
    '当前稳定版本不得倒退到 v3.2.4 之前'
  );
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(
    guide,
    new RegExp('^版本：`v' + packageJson.version.replace(/\./g, '\\.') + '`$', 'm')
  );

  assert.equal(historicalSnapshot.release, '3.2.4');
  assert.equal(historicalSnapshot.packageVersion, '3.2.3');
  assert.equal(historicalSnapshot.packageVersionBumped, false);
  assert.equal(historicalSnapshot.authority.productionEnabledCount, 0);
  assert.equal(historicalSnapshot.actions.length, 6);
  for (const action of historicalSnapshot.actions) {
    assert.equal(action.currentPolicy.production.enabled, false);
    assert.equal(action.currentPolicy.production.effectiveMode, 'legacy');
    assert.equal(action.currentPolicy.production.effectiveWorkerCount, 0);
    assert.equal(action.decision.enabled, false);
    assert.equal(action.rollback.productionMutationAllowed, false);
  }

  assert.equal(
    read('changes/3.2.4/spec.md'),
    read('changes/background-execution-v3.2.x-contract-baseline/changes/3.2.4/spec.md')
  );
  assert.equal(
    read('changes/3.2.4/techdoc.md'),
    read('changes/background-execution-v3.2.x-contract-baseline/changes/3.2.4/techdoc.md')
  );

  const currentChangelog = section(
    changelog,
    '## 3.2.4 - 2026-08-30（版本分支技术收口，未发布）'
  );
  const currentHistory = section(
    history,
    '## v3.2.4（2026-08-30，版本分支技术收口，未发布）'
  );
  const currentGuide = paragraph(
    guide,
    '> **v3.2.4 ReconFix / VCC Financial OP 后台执行基础**'
  );

  for (const document of [currentChangelog, currentHistory, currentGuide]) {
    assert.match(document, /ReconFix|对账单修复/);
    assert.match(document, /JPM/);
    assert.match(document, /VCC/);
    assert.match(document, /Publisher/);
    assert.match(document, /Recovery Hold|恢复/);
    assert.match(document, /production.*关闭|生产仍关闭/s);
    assert.match(document, /Windows/);
    assert.match(document, /人工复核/);
    assert.doesNotMatch(
      document,
      /production(?:\s|`)已启用|资金[^\n]{0,40}(?:已经|已)通过人工复核|资金[^\n]{0,40}(?:人工复核|门禁)：?\s*PASS/
    );
  }

  for (const document of [currentChangelog, currentHistory, guide]) {
    assert.match(document, /金额\/币种|金额、币种/);
    assert.match(document, /Workbook|Excel/);
    assert.match(document, /receipt/);
  }

  assert.match(currentChangelog, /不合并 `main`/);
  assert.match(currentChangelog, /不创建 tag/);
  assert.match(
    currentChangelog,
    /`release-check`、`check-vars`、`scan:vars`.*跳过/s
  );
});
