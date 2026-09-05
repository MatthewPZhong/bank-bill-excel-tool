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
  assert.notEqual(start, -1, `missing heading: ${heading}`);
  const next = document.indexOf('\n## ', start + heading.length);
  return document.slice(start, next === -1 ? document.length : next);
}

function assertBefore(document, earlier, later) {
  const earlierIndex = document.indexOf(earlier);
  const laterIndex = document.indexOf(later);
  assert.notEqual(earlierIndex, -1, `missing marker: ${earlier}`);
  assert.notEqual(laterIndex, -1, `missing marker: ${later}`);
  assert.ok(earlierIndex < laterIndex, `${earlier} must precede ${later}`);
}

test('v3.2.5 metadata、三份发布文档与 54-action evidence 一致收口', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const snapshot = JSON.parse(read(
    'changes/background-execution-r3-2-5-release-evidence/release-evidence.json'
  ));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = packageJson.version.split('.').map(Number);
  assert.ok(
    major > 3 || (major === 3 && minor > 2) ||
      (major === 3 && minor === 2 && patch >= 5),
    '当前稳定版本不得倒退到 v3.2.5 之前'
  );
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(
    guide,
    new RegExp('^版本：`v' + packageJson.version.replace(/\./g, '\\.') + '`$', 'm')
  );
  assert.equal(snapshot.release, '3.2.5');
  assert.equal(snapshot.packageVersion, '3.2.5');
  assert.equal(snapshot.actions.length, 54);
  assert.equal(snapshot.authority.capabilityInventory.implementedCount, 36);
  assert.equal(snapshot.authority.capabilityInventory.legacyOnlyCount, 16);
  assert.equal(snapshot.authority.capabilityInventory.platformCanaryCount, 2);
  assert.equal(snapshot.authority.coverage.coveredActionSurfaceCount, 324);
  assert.equal(snapshot.authority.coverage.expectedActionSurfaceCount, 324);
  assert.equal(snapshot.globalDecision.productionEnabledCount, 0);
  assert.equal(snapshot.globalDecision.legacyEffectiveCount, 54);

  const currentChangelog = section(
    changelog,
    '## 3.2.5 - 2026-09-05（正式发布候选）'
  );
  const currentHistory = section(
    history,
    '## v3.2.5（2026-09-05，正式发布候选）'
  );
  const currentGuide = guide.slice(0, guide.indexOf('\n---'));

  for (const document of [currentChangelog, currentHistory, currentGuide]) {
    assert.match(document, /54[^\n]{0,40}action/i);
    assert.match(document, /production[^\n]{0,50}(?:关闭|未启用)/i);
    assert.match(document, /Windows[^\n]{0,80}(?:NOT_RUN|未运行|未执行)/i);
    assert.match(document, /资金[^\n]{0,80}(?:PENDING_HUMAN_REVIEW|人工复核)/i);
    assert.match(document, /Issue #220|发布负责人/);
    assert.doesNotMatch(document, /production(?:\s|`)已启用|资金[^\n]{0,40}(?:人工复核|门禁)：?\s*PASS/i);
  }

  assert.match(currentChangelog, /金额\/币种/);
  assert.match(currentChangelog, /Workbook/);
  assert.match(currentChangelog, /receipt/);
  assert.match(currentChangelog, /受保护 PR/);
  assert.match(currentChangelog, /唯一 annotated tag/);
  assert.match(currentChangelog, /内置 `release-check`/);
  assert.match(currentChangelog, /本地 `release-check` \/ `check-vars` \/ `scan:vars` 未运行/);
  assert.doesNotMatch(currentChangelog, /### 正式发布结论/);

  for (const [document, headings] of [
    [changelog, ['## 3.2.5 - 2026-09-05', '## 3.2.4 - 2026-09-04',
      '## 3.2.3 - 2026-09-04', '## 3.2.2 - 2026-09-04',
      '## 3.2.1 - 2026-09-03', '## 3.2.0 - 2026-09-03']],
    [history, ['## v3.2.5（2026-09-05', '## v3.2.4（2026-09-04',
      '## v3.2.3（2026-09-04', '## v3.2.2（2026-09-04',
      '## v3.2.1（2026-09-03', '## v3.2.0（2026-09-03']]
  ]) {
    for (let index = 1; index < headings.length; index += 1) {
      assertBefore(document, headings[index - 1], headings[index]);
    }
  }
});
