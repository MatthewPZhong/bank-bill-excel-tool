'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  isSupportedCurrentPackageVersion
} = require('../../../scripts/validate-v3-2-2-release-evidence');

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

function assertBefore(document, earlier, later) {
  const earlierIndex = document.indexOf(earlier);
  const laterIndex = document.indexOf(later);
  assert.notEqual(earlierIndex, -1, 'missing marker: ' + earlier);
  assert.notEqual(laterIndex, -1, 'missing marker: ' + later);
  assert.ok(earlierIndex < laterIndex, earlier + ' must precede ' + later);
}

test('v3.2.2 closeout同步当前版本、冻结文档与三份发布说明', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.equal(isSupportedCurrentPackageVersion(packageJson.version), true);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(
    guide,
    new RegExp('^版本：`v' + packageJson.version.replaceAll('.', '\\.') + '`$', 'm')
  );

  for (const version of ['3.2.0', '3.2.1', '3.2.2']) {
    assert.equal(
      read(`changes/${version}/spec.md`),
      read(`changes/background-execution-v3.2.x-contract-baseline/changes/${version}/spec.md`)
    );
    assert.equal(
      read(`changes/${version}/techdoc.md`),
      read(`changes/background-execution-v3.2.x-contract-baseline/changes/${version}/techdoc.md`)
    );
  }

  const currentChangelog = section(changelog, '## 3.2.2 - 2026-08-31（版本分支技术收口，未发布）');
  const currentHistory = section(history, '## v3.2.2（2026-08-31，版本分支技术收口，未发布）');
  const historicalGuide = paragraph(
    guide,
    '> **v3.2.2 FundRecon / Duplicate / BankBU 后台执行基础**'
  );

  for (const document of [currentChangelog, currentHistory, historicalGuide]) {
    assert.match(document, /FundRecon/);
    assert.match(document, /Duplicate|重复入金/);
    assert.match(document, /BankBU|月度银行对账单 BU/);
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
  }

  assert.match(currentChangelog, /不合并 `main`/);
  assert.match(currentChangelog, /不创建 tag/);
  assert.match(currentChangelog, /`release-check`、`check-vars`、`scan:vars`.*跳过/s);

  for (const [document, headings] of [
    [changelog, ['## 3.2.2 - 2026-08-31', '## 3.2.1 - 2026-08-31', '## 3.2.0 - 2026-08-31', '## 3.1.14 - 2026-08-21']],
    [history, ['## v3.2.2（2026-08-31', '## v3.2.1（2026-08-31', '## v3.2.0（2026-08-31', '## v3.1.14（2026-08-21']]
  ]) {
    for (let index = 1; index < headings.length; index += 1) {
      assertBefore(document, headings[index - 1], headings[index]);
    }
  }

  assertBefore(
    guide,
    '> **v3.2.2 FundRecon / Duplicate / BankBU 后台执行基础**',
    '> **v3.2.1 Toolbox / PreFund 受控后台执行**'
  );
  assertBefore(
    guide,
    '> **v3.2.1 Toolbox / PreFund 受控后台执行**',
    '> **v3.2.0 公共后台执行底座与 VCC OP Pipeline**'
  );
});
