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

function assertBefore(document, earlier, later) {
  const earlierIndex = document.indexOf(earlier);
  const laterIndex = document.indexOf(later);
  assert.notEqual(earlierIndex, -1, 'missing marker: ' + earlier);
  assert.notEqual(laterIndex, -1, 'missing marker: ' + later);
  assert.ok(earlierIndex < laterIndex, earlier + ' must precede ' + later);
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
    '## 3.2.4 - 2026-09-04（正式发布候选）'
  );
  const currentHistory = section(
    history,
    '## v3.2.4（2026-09-04，正式发布候选）'
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
    assert.match(document, /人工验收|人工复核|人工门禁/);
    assert.match(document, /Issue #220|发布负责人/);
    assert.doesNotMatch(
      document,
      /production(?:\s|`)已启用|production enablement 已启用|effective worker 已启用/
    );
  }

  for (const document of [currentChangelog, currentHistory, guide]) {
    assert.match(document, /金额\/币种|金额、币种/);
    assert.match(document, /Workbook|Excel/);
    assert.match(document, /receipt/);
  }

  assert.match(currentChangelog, /PENDING_HUMAN_REVIEW/);
  assert.match(currentChangelog, /NOT_RUN/);
  assert.match(currentChangelog, /受保护 PR/);
  assert.match(currentChangelog, /唯一 annotated tag/);
  assert.match(currentChangelog, /内置 `release-check`/);
  assert.match(currentChangelog, /`scan:vars` \/ `check:vars` \/ `release-check` 未运行/);
  assert.doesNotMatch(currentChangelog, /### 正式发布结论/);

  for (const [document, headings] of [
    [changelog, ['## 3.2.4 - 2026-09-04', '## 3.2.3 - 2026-09-04',
      '## 3.2.2 - 2026-09-04', '## 3.2.1 - 2026-09-03',
      '## 3.2.0 - 2026-09-03']],
    [history, ['## v3.2.4（2026-09-04', '## v3.2.3（2026-09-04',
      '## v3.2.2（2026-09-04', '## v3.2.1（2026-09-03',
      '## v3.2.0（2026-09-03']]
  ]) {
    for (let index = 1; index < headings.length; index += 1) {
      assertBefore(document, headings[index - 1], headings[index]);
    }
  }

  assertBefore(
    guide,
    '> **v3.2.4 ReconFix / VCC Financial OP 后台执行基础**',
    '> **v3.2.3 Statement / NewAccount 后台执行基础**'
  );
});
