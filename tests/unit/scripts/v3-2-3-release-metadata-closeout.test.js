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

test('v3.2.3 closeout 同步当前版本、冻结文档与三份发布说明', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');
  const historicalSnapshot = JSON.parse(read(
    'changes/background-execution-r3-2-3-release-evidence/release-evidence.json'
  ));

  assert.equal(packageJson.version, '3.2.3');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(guide, /^版本：`v3\.2\.3`$/m);

  assert.equal(historicalSnapshot.release, '3.2.3');
  assert.equal(historicalSnapshot.packageVersion, '3.1.14');
  assert.equal(historicalSnapshot.packageVersionBumped, false);

  assert.equal(
    read('changes/3.2.3/spec.md'),
    read('changes/background-execution-v3.2.x-contract-baseline/changes/3.2.3/spec.md')
  );
  assert.equal(
    read('changes/3.2.3/techdoc.md'),
    read('changes/background-execution-v3.2.x-contract-baseline/changes/3.2.3/techdoc.md')
  );

  const currentChangelog = section(
    changelog,
    '## 3.2.3 - 2026-09-04（正式发布候选）'
  );
  const currentHistory = section(
    history,
    '## v3.2.3（2026-09-04，正式发布候选）'
  );
  const currentGuide = paragraph(
    guide,
    '> **v3.2.3 Statement / NewAccount 后台执行基础**'
  );

  for (const document of [currentChangelog, currentHistory, currentGuide]) {
    assert.match(document, /Statement/);
    assert.match(document, /NewAccount/);
    assert.match(document, /token/);
    assert.match(document, /Publisher/);
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
    assert.match(document, /余额/);
    assert.match(document, /Workbook|Excel/);
    assert.match(document, /Recovery Hold|恢复/);
  }

  assert.match(currentChangelog, /受保护 PR/);
  assert.match(currentChangelog, /annotated tag/);
  assert.match(currentChangelog, /内置 `release-check`/);
  assert.match(currentChangelog, /`scan:vars` \/ `check:vars` \/ `release-check` 未运行/);
  assert.doesNotMatch(currentChangelog, /### 正式发布结论/);

  assert.match(changelog, /^## 3\.2\.2 - 2026-09-04（正式发布）$/m);
  assert.match(history, /^## v3\.2\.2（2026-09-04，正式发布）$/m);
  assert.match(changelog, /main` 为 `c2d23f5981b1b2218b0988cf13e7e048e02ced46`/);
  assert.match(changelog, /run `33835873671`/);

  for (const [document, headings] of [
    [changelog, ['## 3.2.3 - 2026-09-04', '## 3.2.2 - 2026-09-04',
      '## 3.2.1 - 2026-09-03', '## 3.2.0 - 2026-09-03']],
    [history, ['## v3.2.3（2026-09-04', '## v3.2.2（2026-09-04',
      '## v3.2.1（2026-09-03', '## v3.2.0（2026-09-03']]
  ]) {
    for (let index = 1; index < headings.length; index += 1) {
      assertBefore(document, headings[index - 1], headings[index]);
    }
  }

  assertBefore(
    guide,
    '> **v3.2.3 Statement / NewAccount 后台执行基础**',
    '> **v3.2.2 FundRecon / Duplicate / BankBU 后台执行基础**'
  );
});
