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

function isStableAtLeastV321(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  if (!match) return false;
  const current = match.slice(1).map(Number);
  return current[0] > 3 ||
    (current[0] === 3 && current[1] > 2) ||
    (current[0] === 3 && current[1] === 2 && current[2] >= 1);
}

test('v3.2.1 closeout同步当前版本、冻结文档、前序收口与三份发布说明', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.equal(isStableAtLeastV321(packageJson.version), true);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(
    guide,
    new RegExp('^版本：`v' + packageJson.version.replaceAll('.', '\\.') + '`$', 'm')
  );

  for (const version of ['3.2.0', '3.2.1']) {
    assert.equal(
      read(`changes/${version}/spec.md`),
      read(`changes/background-execution-v3.2.x-contract-baseline/changes/${version}/spec.md`)
    );
    assert.equal(
      read(`changes/${version}/techdoc.md`),
      read(`changes/background-execution-v3.2.x-contract-baseline/changes/${version}/techdoc.md`)
    );
  }

  const currentChangelog = section(
    changelog,
    '## 3.2.1 - 2026-09-03（正式发布候选）'
  );
  const currentHistory = section(
    history,
    '## v3.2.1（2026-09-03，正式发布候选）'
  );
  const historicalGuide = paragraph(
    guide,
    '> **v3.2.1 Toolbox / PreFund 受控后台执行**'
  );

  for (const document of [currentChangelog, currentHistory, historicalGuide]) {
    assert.match(document, /Toolbox/);
    assert.match(document, /PreFund/);
    assert.match(document, /第二 Writer.*拒绝|第二 Writer gate.*rejected|E04-C.*rejected/s);
    assert.match(document, /单一 Writer|单 Writer|single Writer|FIFO Publisher/i);
    assert.match(document, /金额\/币种|金额、币种|金额、币种/);
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
  assert.match(changelog, /^## 3\.2\.0 - 2026-09-03（正式发布）$/m);
  assert.match(history, /^## v3\.2\.0（2026-09-03，正式发布）$/m);
});
