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

test('v3.2.5 metadata、三份发布文档与 54-action evidence 一致收口', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const snapshot = JSON.parse(read(
    'changes/background-execution-r3-2-5-release-evidence/release-evidence.json'
  ));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.equal(packageJson.version, '3.2.5');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(guide, /^版本：`v3\.2\.5`$/m);
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
    '## 3.2.5 - 2026-08-31（版本分支技术收口，未发布）'
  );
  const currentHistory = section(
    history,
    '## v3.2.5（2026-08-31，版本分支技术收口，未发布）'
  );
  const currentGuide = guide.slice(0, guide.indexOf('\n---'));

  for (const document of [currentChangelog, currentHistory, currentGuide]) {
    assert.match(document, /54[^\n]{0,40}action/i);
    assert.match(document, /production[^\n]{0,50}(?:关闭|未启用)/i);
    assert.match(document, /Windows[^\n]{0,80}(?:NOT_RUN|未运行)/i);
    assert.match(document, /资金[^\n]{0,80}(?:PENDING_HUMAN_REVIEW|人工复核)/i);
    assert.doesNotMatch(document, /production(?:\s|`)已启用|资金[^\n]{0,40}(?:人工复核|门禁)：?\s*PASS/i);
  }

  assert.match(currentChangelog, /金额\/币种/);
  assert.match(currentChangelog, /Workbook/);
  assert.match(currentChangelog, /receipt/);
  assert.match(currentChangelog, /不合并 `main`/);
  assert.match(currentChangelog, /不创建 tag/);
  assert.match(currentChangelog, /`release-check`、`check-vars`、`scan:vars`[^\n]*跳过/);
});
