'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n');
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

function isStableAtLeastV320(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  if (!match) return false;
  const [, majorText, minorText, patchText] = match;
  const current = [majorText, minorText, patchText].map(Number);
  return current[0] > 3 ||
    (current[0] === 3 && current[1] > 2) ||
    (current[0] === 3 && current[1] === 2 && current[2] >= 0);
}

test('v3.2.0 closeout同步当前版本、冻结文档与三份发布说明', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.equal(isStableAtLeastV320(packageJson.version), true);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(
    guide,
    new RegExp('^版本：`v' + packageJson.version.replaceAll('.', '\\.') + '`$', 'm')
  );

  assert.equal(
    read('changes/3.2.0/spec.md'),
    read('changes/background-execution-v3.2.x-contract-baseline/changes/3.2.0/spec.md')
  );
  assert.equal(
    read('changes/3.2.0/techdoc.md'),
    read('changes/background-execution-v3.2.x-contract-baseline/changes/3.2.0/techdoc.md')
  );

  const currentChangelog = section(
    changelog,
    '## 3.2.0 - 2026-09-03（正式发布候选）'
  );
  const currentHistory = section(
    history,
    '## v3.2.0（2026-09-03，正式发布候选）'
  );
  const historicalGuide = paragraph(
    guide,
    '> **v3.2.0 公共后台执行底座与 VCC OP Pipeline**'
  );

  for (const document of [currentChangelog, currentHistory, historicalGuide]) {
    assert.match(document, /Supervisor/);
    assert.match(document, /VCC/);
    assert.match(document, /金额\/币种|金额、币种/);
    assert.match(document, /Workbook|Excel/);
    assert.match(document, /production.*关闭|生产仍关闭/s);
    assert.match(document, /Windows/);
    assert.match(document, /人工验收|人工复核|人工门禁/);
    assert.match(document, /Issue #220|发布负责人/);
    assert.doesNotMatch(
      document,
      /production(?:\s|`)已启用|production enablement 已启用|effective worker 已启用/
    );
  }

  assert.match(currentChangelog, /受保护 PR/);
  assert.match(currentChangelog, /annotated tag/);
  assert.match(currentChangelog, /内置 `release-check`/);
  assert.match(currentChangelog, /`scan:vars` \/ `check:vars` 未运行/);
});
