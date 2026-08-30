'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const readBuffer = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath));
const FROZEN_SPEC_SHA256 = '1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d';

function normalizeLineEndingsForHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  // latin1 让每个字节一一映射，只折叠 CRLF/CR，不改变 UTF-8 内容的其它字节。
  return Buffer.from(bytes.toString('latin1').replace(/\r\n?/g, '\n'), 'latin1');
}

function normalizedTextSha256(value) {
  return crypto
    .createHash('sha256')
    .update(normalizeLineEndingsForHash(value))
    .digest('hex');
}

function markdownSection(source, heading, level = 2) {
  const start = source.indexOf(heading);
  assert.ok(start >= 0, `缺少 section：${heading}`);
  const nextHeading = `\n${'#'.repeat(level)} `;
  const end = source.indexOf(nextHeading, start + heading.length);
  return source.slice(start, end >= 0 ? end : source.length);
}

function sectionBetweenMarkers(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `缺少 section 起点：${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `缺少 section 终点：${endMarker}`);
  return source.slice(start, end);
}

const V314_MANUAL_ITEMS = [
  ['Windows packaged VCC', /Windows packaged VCC/],
  ['Windows 10/11 Setup/portable', /Windows 10\/11 Setup\/portable/],
  ['SmartScreen', /SmartScreen/],
  ['v3.1.13 -> v3.1.14', /v3\.1\.13 -> v3\.1\.14/],
  ['production/latest', /production\/latest/]
];

const V314_ASSETS = [
  ['bank-bill-excel-tool-portable-3.1.14.exe', '99,874,669', '964944f588bfe4ca38b73bc9e45af3d795a5d05fec48ab1b52d942c541e02781'],
  ['bank-bill-excel-tool-setup-3.1.14.exe', '100,371,449', 'e71e17aa0525b92ca9d15c508ef48cd783ed24ebdd63ace82cb693a1920503df'],
  ['bank-bill-excel-tool-setup-3.1.14.exe.blockmap', '105,515', '831edeaa11a2e4015f812b81d794c38c9c7fed98fb179f05607bcf635c87ef10'],
  ['latest.yml', '372', '9dea317367aa36cde238c672b870151613686538da035a3f4472984a3a491a2c']
];

const MANUAL_STATUS_PATTERN = /MANUAL\s*\/\s*NOT RUN/;
const AGGREGATE_MANUAL_STATUS_PATTERN = /(?:全部范围|上述五项人工范围|以上五项人工范围|这些人工项)[^。；\n]{0,40}MANUAL\s*\/\s*NOT RUN/;

function manualBoundaryRecords(section) {
  const lines = section.split('\n').map((line) => line.trim());
  const records = lines.filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^-\s+/.test(lines[index])) continue;
    const listLines = [];
    let cursor = index;
    while (cursor < lines.length && /^-\s+/.test(lines[cursor])) {
      listLines.push(lines[cursor]);
      cursor += 1;
    }
    while (cursor < lines.length && !lines[cursor]) cursor += 1;
    if (cursor < lines.length && AGGREGATE_MANUAL_STATUS_PATTERN.test(lines[cursor])) {
      records.push([...listLines, lines[cursor]].join('\n'));
    }
    index = cursor - 1;
  }

  return records;
}

function isManualItemBound(record, itemPattern) {
  const clauses = record.split(/[；;\n]/);
  if (clauses.some((clause) => itemPattern.test(clause) && MANUAL_STATUS_PATTERN.test(clause))) {
    return true;
  }
  return itemPattern.test(record) && AGGREGATE_MANUAL_STATUS_PATTERN.test(record);
}

function hasUnnegatedManualPassClaim(record, itemPattern) {
  const positivePattern = /验收通过|已经通过|已验证|\bPASS\b/g;
  const manualScopeReferencePattern = /(?:这些人工项|上述五项(?:人工范围|人工项目)?|以上五项(?:人工范围|人工项目)?|五项人工范围|全部人工范围|全部范围)/;

  for (const clause of record.split(/[；。\n]/)) {
    for (const match of clause.matchAll(positivePattern)) {
      const prefix = clause.slice(0, match.index);
      if (!itemPattern.test(prefix) && !manualScopeReferencePattern.test(prefix)) continue;
      const localPrefix = prefix.split(/(?:但|却|然而|不过)/).pop();
      const negated = /(?:不是|不构成|不等于|不表示|不代表|不被|不得|不能|不可|尚未|仍未|未|没有)[^；。\n]{0,80}$/.test(localPrefix);
      if (!negated) return true;
    }
  }
  return false;
}

function assertV314ManualBoundary(section, label) {
  const records = manualBoundaryRecords(section);
  for (const [itemLabel, itemPattern] of V314_MANUAL_ITEMS) {
    assert.match(section, itemPattern, `${label} 缺少人工边界：${itemLabel}`);
    for (const record of records.filter((candidate) => itemPattern.test(candidate))) {
      assert.equal(
        hasUnnegatedManualPassClaim(record, itemPattern),
        false,
        `${label} 不得把 ${itemLabel} 写成 PASS / 已验证 / 已经通过 / 验收通过：${record}`
      );
    }
    assert.ok(
      records.some((record) => isManualItemBound(record, itemPattern)),
      `${label} 必须把 ${itemLabel} 在其条目或清单汇总中绑定为 MANUAL / NOT RUN`
    );
  }
}

function v314AssetEvidenceEntries(document) {
  const assetNamePattern = /bank-bill-excel-tool-setup-3\.1\.14\.exe\.blockmap|bank-bill-excel-tool-setup-3\.1\.14\.exe(?!\.blockmap)|bank-bill-excel-tool-portable-3\.1\.14\.exe|latest\.yml/g;
  const entries = [];

  for (const line of document.split('\n')) {
    const matches = [...line.matchAll(assetNamePattern)];
    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      entries.push({
        fileName: current[0],
        text: line.slice(current.index, next ? next.index : line.length)
      });
    }
  }

  return entries;
}

function assertV314AssetEvidence(document, label) {
  const entries = v314AssetEvidenceEntries(document);
  for (const [fileName, size, sha256] of V314_ASSETS) {
    assert.ok(
      entries.some((entry) => (
        entry.fileName === fileName
        && entry.text.includes(size)
        && entry.text.includes(sha256)
      )),
      `${label} 缺少绑定的资产三元组：${fileName} -> ${size} -> ${sha256}`
    );
  }
}

test('v3.1.14 人工边界与资产三元组 helper 拒绝局部旁路', () => {
  const validManualBoundary = '- Windows packaged VCC、Windows 10/11 Setup/portable、SmartScreen、`v3.1.13 -> v3.1.14` 与 `production/latest` 均为 `MANUAL / NOT RUN`；技术 Release 完成不表示这些人工项已验证或 PASS。';
  const validWorkflowPassBoundary = '- Windows packaged VCC、Windows 10/11 Setup/portable、SmartScreen、`v3.1.13 -> v3.1.14` 与 `production/latest` 均为 `MANUAL / NOT RUN`；Windows Release workflow PASS。';
  const validWorkflowPassWithManualNegation = '- Windows packaged VCC、Windows 10/11 Setup/portable、SmartScreen、`v3.1.13 -> v3.1.14` 与 `production/latest` 五项均 `MANUAL / NOT RUN`；Windows Release workflow PASS，但不表示这些人工项已验证。';
  assert.doesNotThrow(() => assertV314ManualBoundary(validManualBoundary, '合法人工边界反例'));
  assert.doesNotThrow(() => assertV314ManualBoundary(validWorkflowPassBoundary, '合法 workflow PASS 反例'));
  assert.doesNotThrow(() => assertV314ManualBoundary(validWorkflowPassWithManualNegation, '合法 workflow PASS 加人工否定控制'));
  for (const positiveClaim of ['PASS', '已验证', '已经通过', '验收通过']) {
    const invalidManualBoundary = `- Windows packaged VCC ${positiveClaim}；Windows 10/11 Setup/portable、SmartScreen、\`v3.1.13 -> v3.1.14\` 与 \`production/latest\` 仍为 \`MANUAL / NOT RUN\`。`;
    assert.throws(
      () => assertV314ManualBoundary(invalidManualBoundary, `非法人工边界反例：${positiveClaim}`),
      /Windows packaged VCC.*PASS \/ 已验证 \/ 已经通过 \/ 验收通过/
    );
  }
  const invalidContrastBoundaries = ['但', '却', '然而', '不过'].map(
    (contrast) => `- Windows packaged VCC 仍未执行，${contrast}已验证；Windows 10/11 Setup/portable、SmartScreen、\`v3.1.13 -> v3.1.14\` 与 \`production/latest\` 仍为 \`MANUAL / NOT RUN\`。`
  );
  invalidContrastBoundaries.push('- Windows packaged VCC 尚未执行但已经通过人工验收；Windows 10/11 Setup/portable、SmartScreen、`v3.1.13 -> v3.1.14` 与 `production/latest` 仍为 `MANUAL / NOT RUN`。');
  for (const invalidContrastBoundary of invalidContrastBoundaries) {
    assert.throws(
      () => assertV314ManualBoundary(invalidContrastBoundary, '非法转折边界反例'),
      /Windows packaged VCC.*PASS \/ 已验证 \/ 已经通过 \/ 验收通过/
    );
  }

  const validAssetEvidence = [
    '- portable `bank-bill-excel-tool-portable-3.1.14.exe`：`99,874,669` bytes / SHA-256 `964944f588bfe4ca38b73bc9e45af3d795a5d05fec48ab1b52d942c541e02781`。',
    '- Setup `bank-bill-excel-tool-setup-3.1.14.exe`：`100,371,449` bytes / SHA-256 `e71e17aa0525b92ca9d15c508ef48cd783ed24ebdd63ace82cb693a1920503df`；blockmap `bank-bill-excel-tool-setup-3.1.14.exe.blockmap`：`105,515` bytes / SHA-256 `831edeaa11a2e4015f812b81d794c38c9c7fed98fb179f05607bcf635c87ef10`。',
    '- `latest.yml`：`372` bytes / SHA-256 `9dea317367aa36cde238c672b870151613686538da035a3f4472984a3a491a2c`。'
  ].join('\n');
  assert.doesNotThrow(() => assertV314AssetEvidence(validAssetEvidence, '合法资产反例'));

  const swappedExeShaEvidence = validAssetEvidence
    .replace('964944f588bfe4ca38b73bc9e45af3d795a5d05fec48ab1b52d942c541e02781', '__PORTABLE_SHA__')
    .replace('e71e17aa0525b92ca9d15c508ef48cd783ed24ebdd63ace82cb693a1920503df', '964944f588bfe4ca38b73bc9e45af3d795a5d05fec48ab1b52d942c541e02781')
    .replace('__PORTABLE_SHA__', 'e71e17aa0525b92ca9d15c508ef48cd783ed24ebdd63ace82cb693a1920503df');
  assert.throws(
    () => assertV314AssetEvidence(swappedExeShaEvidence, '对调资产反例'),
    /缺少绑定的资产三元组/
  );
});

test('v3.1.14 正式文档锁定 VCC 修复、实际发布证据与人工边界', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');
  const preflight = read('changes/3.1.14/preflight.md');
  const spec = read('changes/3.1.14/spec.md');
  const techdoc = read('changes/3.1.14/techdoc.md');
  const implementationNotes = read('changes/3.1.14/implementation-notes.md');
  const runbook = read('docs/WINDOWS_RELEASE_RUNBOOK.md');

  const currentVersion = packageJson.version;
  const currentParts = currentVersion.split('.').map(Number);
  assert.match(currentVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(
    currentParts[0] > 3 ||
      (currentParts[0] === 3 && currentParts[1] > 1) ||
      (currentParts[0] === 3 && currentParts[1] === 1 && currentParts[2] >= 14),
    '当前稳定版本不得倒退到 v3.1.14 之前'
  );
  assert.equal(packageLock.version, currentVersion);
  assert.equal(packageLock.packages[''].version, currentVersion);
  assert.match(changelog, /^## 3\.1\.14 - 2026-08-21$/m);
  assert.match(history, /^## v3\.1\.14（2026-08-21）$/m);
  assert.match(
    guide,
    new RegExp('^版本：`v' + currentVersion.replaceAll('.', '\\.') + '`$', 'm')
  );

  const currentChangelog = markdownSection(changelog, '## 3.1.14 - 2026-08-21');
  const currentHistory = markdownSection(history, '## v3.1.14（2026-08-21）');
  const currentGuide = guide.slice(0, guide.indexOf('\n---'));
  const currentGuideDetail = sectionBetweenMarkers(
    guide,
    '> **v3.1.14 VCC 财务 OP 大批量导入修复**',
    '> **v3.1.13 工具箱、存档中心与状态框调整**'
  );
  const guideReleaseBoundary = sectionBetweenMarkers(
    guide,
    '#### v3.1.14 发布与人工验证边界',
    '### 1.11.9 设置里的存档中心'
  );
  const releaseRecord = markdownSection(runbook, '## v3.1.14 发布记录');

  const v314CurrentSections = [
    ['CHANGELOG v3.1.14', currentChangelog],
    ['VERSION_FEATURE_HISTORY v3.1.14', currentHistory],
    ['USER_GUIDE v3.1.14 详细条目', currentGuideDetail],
    ['USER_GUIDE v3.1.14 发布边界', guideReleaseBoundary],
    ['preflight', preflight],
    ['spec', spec],
    ['techdoc', techdoc],
    ['implementation notes', implementationNotes],
    ['Runbook v3.1.14', releaseRecord]
  ];
  for (const [label, section] of v314CurrentSections) {
    assertV314ManualBoundary(section, label);
    assert.match(section, /正式技术发布|正式发布为.*latest stable Release|技术 Release/s);
  }

  const releaseIdentityDocuments = [
    currentChangelog,
    currentHistory,
    preflight,
    spec,
    techdoc,
    implementationNotes,
    releaseRecord
  ];
  const releaseRuleDocuments = [currentChangelog, preflight, spec, techdoc, implementationNotes, releaseRecord];
  for (const releaseDocument of releaseIdentityDocuments) {
    assert.match(releaseDocument, /PR #162/);
    assert.match(releaseDocument, /1cc5999c62e4666d56b542e37e54529f6177e6bc/);
    assert.match(releaseDocument, /PR #163/);
    assert.match(releaseDocument, /225d07d17a7c211348ba549734aaf84f602253cb/);
    assert.match(releaseDocument, /annotated tag/);
    assert.match(releaseDocument, /fee1498311854a69fea666fe275511da89d99836/);
    assert.match(releaseDocument, /32508170702/);
    assert.match(releaseDocument, /https:\/\/github\.com\/MatthewPZhong\/bank-bill-excel-tool\/actions\/runs\/32508170702/);
    assert.match(releaseDocument, /https:\/\/github\.com\/MatthewPZhong\/bank-bill-excel-tool\/releases\/tag\/v3\.1\.14/);
    assert.match(releaseDocument, /latest stable Release|默认 latest/);
  }

  for (const releaseDocument of releaseRuleDocuments) {
    assert.match(releaseDocument, /PR #163 body/);
    assert.match(releaseDocument, /实际批准人/);
    assert.match(releaseDocument, /完整豁免范围/);
    assert.match(releaseDocument, /理由/);
    assert.match(releaseDocument, /发布后逐项补做/);
    assert.match(releaseDocument, /Verify tag and main/);
    assert.match(releaseDocument, /冻结窗口[^。\n]*(?:执行|闭合)|冻结[^。\n]*窗口[^。\n]*(?:执行|闭合)/);
    assert.match(releaseDocument, /(?:首轮成功|首轮全部 15 步|没有触发受控重跑|未触发重跑|未重跑)/);
    assert.match(releaseDocument, /Release(?:\/资产| 与资产| 和资产)[^。\n]*(?:均|都)[^。\n]*(?:未创建|尚未创建)/);
    assert.match(releaseDocument, /基础设施瞬时故障/);
    assert.match(releaseDocument, /代码、tag、commit(?:、|和)打包输入[^。\n]*不变/);
    assert.match(releaseDocument, /产品、元数据(?:或|、)打包输入/);
    assert.match(releaseDocument, /Release 已创建后/);
    assert.match(releaseDocument, /(?:不|不得|不可)删除、替换或重传/);
  }

  const assetEvidenceDocuments = [techdoc, implementationNotes, releaseRecord];
  for (const [index, document] of assetEvidenceDocuments.entries()) {
    assertV314AssetEvidence(document, ['techdoc', 'implementation notes', 'Runbook v3.1.14'][index]);
    assert.match(document, /2026-08-21T17:58:41\.566Z/);
    assert.match(document, /QmsR5uVGyBSwB1A8w7J70WyiIgqEE7HOLfZVXhxWPh91G3uREMH21u3tWcj\+wYnB6T3fBvMydQevH6\+fwUll4g==/);
    assert.match(document, /无凭据公开 HTTPS GET/);
    assert.match(document, /Windows PE32 GUI \/ Nullsoft Installer/);
    assert.match(document, /认证下载与匿名下载逐字节一致/);
    assert.match(document, /isImmutable=false/);
  }
  for (const document of [techdoc, implementationNotes, releaseRecord]) {
    assert.match(document, /2026-08-21T17:58:54Z/);
    assert.match(document, /公开、非 draft、非 prerelease/);
    assert.match(document, /tagName=v3\.1\.14/);
  }

  for (const durableDocument of [currentChangelog, currentHistory, currentGuide, currentGuideDetail, guideReleaseBoundary, spec]) {
    assert.doesNotMatch(durableDocument, /长期候选口径|当前为迭代版本|尚未发布为 stable Release|当前 latest stable Release 仍为 v3\.1\.13/);
  }

  for (const document of [spec, techdoc]) {
    assert.match(document, /v3\.1\.14/);
    assert.match(document, /2026-08-21/);
    assert.match(document, /147af9a736b7daaf7a1cdd17eff3535fdc62cd98/);
    assert.match(document, /发布代码基线[\s\S]*PR #162[\s\S]*1cc5999c62e4666d56b542e37e54529f6177e6bc/);
    assert.match(document, /idx_vcc_fin_op_staging_comparison/);
    assert.match(document, /WHERE comparison_import_row_id IS NOT NULL/);
    assert.match(document, /VCC_STORAGE_CONTRACT_VERSION.*(?:保持|继续).*2/s);
    assert.match(document, /committing/);
    assert.match(document, /classifyAndPromote/);
    assert.match(document, /cancelRequested/);
    assert.match(document, /正在取消导入并回滚本次未完成数据…/);
    assert.match(document, /120 秒/);
    assert.match(document, /batchId === batchContext\.taskRunId/);
    assert.match(document, /代码回滚|应用代码回滚/);
    assert.match(document, /索引.*保留|保留.*索引/s);
    assert.doesNotMatch(document, /committing[^\n]{0,80}整批[^\n]{0,30}一次/);
    assert.doesNotMatch(document, /成功进入分类后/);
  }

  assert.match(
    spec,
    /全部文件完成读取[\s\S]*每个文件在解析后通过 SHA 核对[\s\S]*最终取消\/空表检查通过[\s\S]*最终读取事务 COMMIT 后[\s\S]*调用 `classifyAndPromote\(\)` 前/
  );
  assert.match(spec, /充值清退与 Pending 同批正常导入时分别上报，共两次/);
  assert.match(spec, /系统财务 OP 不参与明细 phase 计数/);
  assert.match(spec, /分类事务启动或执行失败时[\s\S]*committing 仍然有效/);
  assert.match(spec, /本章节|AC-14/);
  assert.equal((spec.match(/\| AC-\d{2} \|/g) || []).length, 14);

  assert.match(
    techdoc,
    /每累计 50,000 行：[\s\S]*COMMIT 当前 staging 事务[\s\S]*autocommit UPDATE import_record\.raw_count[\s\S]*BEGIN IMMEDIATE/
  );
  assert.match(techdoc, /每个文件解析完成后执行 SHA 二次核对/);
  assert.match(techdoc, /COMMIT 最终读取事务[\s\S]*committing progress[\s\S]*classifyAndPromote/);
  assert.match(techdoc, /function buildImportProgressStatus\(progress, cancelRequested\)/);
  assert.match(techdoc, /if \(cancelRequested\) return null/);
  assert.match(techdoc, /无 phase 的旧事件返回“正在导入”/);
  assert.match(techdoc, /组合三份样本只记录整批总耗时，以及 reading\/committing\/结果返回的事件时间点/);
  assert.match(techdoc, /单独用一个 sourceType 测量该组 committing 回调至该次结果返回/);

  const samples = [
    ['VCC充值清退明细_2026-07_PPHK.xlsx', 'dc9a7f4f63c9aa5eb5cb80ccc1ebb57aa77fbe1c3856825f9e97a640ba40e529', '8,747,409'],
    ['移除归档Pending账单.xlsx', 'a669d5b66b98e4ba360330d7624deb3ce5edc4e1353402d6fc6c90606cbaa7b4', '8,045,959'],
    ['财务OP (3).xlsx', 'b7ae6554ec7db4fb229190eb26d641e0c2d7d1926871762bb42a3317267e08f0', '4,948']
  ];
  for (const document of [spec, techdoc]) {
    for (const [fileName, sha256, sizeBytes] of samples) {
      assert.ok(document.includes(fileName), fileName);
      assert.ok(document.includes(sha256), sha256);
      assert.ok(document.includes(sizeBytes), sizeBytes);
    }
    assert.match(document, /主体×币种金额守恒/);
    assert.match(document, /dataset revision/);
  }
});

test('v3.1.13 版本号、功能资料与正式发布证据同步工具箱、存档中心和状态框迭代', () => {
  const packageJson = JSON.parse(read('package.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');
  const spec = read('changes/3.1.13/spec.md');
  const techdoc = read('changes/3.1.13/techdoc.md');
  const implementationNotes = read('changes/3.1.13/implementation-notes.md');
  const runbook = read('docs/WINDOWS_RELEASE_RUNBOOK.md');
  const mainSource = read('src/main.js');

  assert.ok(packageJson.build.files.includes('docs/USER_GUIDE.md'));
  assert.match(mainSource, /path\.join\(app\.getAppPath\(\), 'docs', 'USER_GUIDE\.md'\)/);
  assert.match(changelog, /^## 3\.1\.13 - 2026-08-20$/m);
  assert.match(history, /^## v3\.1\.13（2026-08-20）$/m);
  const currentChangelog = changelog.slice(
    changelog.indexOf('## 3.1.13'),
    changelog.indexOf('## 3.1.12')
  );
  const currentHistory = history.slice(
    history.indexOf('## v3.1.13'),
    history.indexOf('## v3.1.12')
  );
  const currentGuide = guide.slice(
    guide.indexOf('> **v3.1.13 工具箱'),
    guide.indexOf('> **v3.1.12 网银源文件')
  );
  for (const currentSection of [currentChangelog, currentHistory, currentGuide, spec, techdoc]) {
    assert.match(currentSection, /工具箱/);
    assert.match(currentSection, /状态框/);
    assert.match(currentSection, /返回/);
    assert.match(currentSection, /存档中心/);
    assert.match(currentSection, /平盘对账数据处理/);
    assert.match(currentSection, /对账单修复/);
    assert.match(currentSection, /欢迎使用小助手/);
    assert.match(currentSection, /状态框.*(?:星星|星形).*SVG|(?:星星|星形).*SVG.*状态框/s);
  }
  for (const currentSection of [currentChangelog, currentHistory]) {
    assert.match(currentSection, /关闭按钮.*隐藏|隐藏.*关闭按钮/);
    assert.match(currentSection, /覆盖全部/);
    assert.match(currentSection, /正式技术发布完成|正式发布结论/);
    assert.doesNotMatch(currentSection, /正式发布准备与人工边界/);
  }
  assert.match(currentGuide, /v3\.1\.13 已于 2026-08-21.*正式发布为.*latest stable Release/s);
  assert.match(currentGuide, /Setup、portable、blockmap 与 `latest\.yml` 四项资产.*无凭据回读/s);
  assert.doesNotMatch(currentGuide, /在打 tag 前定稿|尚未标记为正式发布|latest stable Release 仍为.*v3\.1\.12/);
  for (const currentSection of [currentChangelog, currentHistory, currentGuide, spec, techdoc]) {
    assert.match(currentSection, /正式技术发布|正式发布为.*latest stable Release|技术 Release/s);
    assert.match(currentSection, /MANUAL \/ NOT RUN|人工边界.*未验证|仍未人工验证|不能把.*已通过/s);
  }
  for (const releaseDocument of [currentChangelog, currentHistory, implementationNotes, runbook]) {
    assert.match(releaseDocument, /PR #159/);
    assert.match(releaseDocument, /9e68c0339427a91c1948f73bfae66f0a76d17b5c/);
    assert.match(releaseDocument, /PR #160/);
    assert.match(releaseDocument, /099f2c9c8078c83785d71c499a68f2a818ab8c7c/);
    assert.match(releaseDocument, /annotated tag/);
    assert.match(releaseDocument, /5d5c9c828869bc82931cd1861f4cff3a099b5f32/);
    assert.match(releaseDocument, /32455995895/);
  }
  for (const releaseDocument of [currentChangelog, currentHistory, implementationNotes, runbook, techdoc]) {
    assert.match(releaseDocument, /15 秒.*超时|15 秒硬超时/s);
    assert.match(releaseDocument, /重跑/);
  }
  for (const releaseDocument of [currentChangelog, currentHistory, runbook]) {
    assert.match(releaseDocument, /latest stable Release/);
    assert.match(releaseDocument, /Setup/);
    assert.match(releaseDocument, /portable/);
    assert.match(releaseDocument, /blockmap/);
    assert.match(releaseDocument, /latest\.yml/);
  }
  for (const releaseEvidence of [implementationNotes, runbook]) {
    assert.match(releaseEvidence, /0316f86d0300f33a034596863c295aec7cd31111de916892389c16117b63b06a/);
    assert.match(releaseEvidence, /918f858bffa1611ecce5fb8400c1da33fa62867bafd721b692a997b302be07ef/);
    assert.match(releaseEvidence, /4m7H4Xxq72n2u7Js89A0j\/z2yORmKgaFA4P5l9EYWYBe5r8acJgRKb68\/9slLPFhN2bBiMS5a7OFlplmDmwpJg==/);
  }
  assert.match(runbook, /^## v3\.1\.13 发布记录$/m);
  assert.doesNotMatch(runbook, /^## v3\.1\.13 发布准备$/m);
  assert.match(runbook, /Windows 10\/11 Setup\/portable/);
  assert.match(runbook, /v3\.1\.12 -> v3\.1\.13/);
  assert.match(runbook, /production\/latest/);
  assert.match(runbook, /MANUAL \/ NOT RUN/);
  assert.match(runbook, /isImmutable=false/);
  assert.match(spec, /宽度固定为该宽度的两倍，即 144px/);
  assert.match(spec, /不修改 Excel 内容、格式保真、筛选、批次、存档、原子发布或恢复合同/);
  assert.match(techdoc, /S = L \+ L = 144px/);
  assert.match(techdoc, /running = mergeInFlight \|\| splitImportInFlight \|\| splitExportInFlight/);
  assert.match(techdoc, /response 0.*FilePlan.*临时目录.*正式目标写入前/s);
  for (const currentSection of [currentChangelog, currentHistory, spec, techdoc]) {
    assert.match(currentSection, /日期.*(?:默认|选择框).*空|默认.*空.*日期/s);
    assert.match(currentSection, /运行次数/);
    assert.match(currentSection, /最新批次/);
    assert.match(currentSection, /存储统计/);
    assert.match(currentSection, /维护.*(?:提示|提示栏)|(?:提示|提示栏).*维护/s);
    assert.match(currentSection, /静默|不再|不展示/);
  }
  assert.match(guide, /v3\.1\.13 起，存档中心日期选择框默认为空/);
  assert.match(guide, /不再显示“存储统计”、文件总大小、运行次数和最新批次/);
  assert.match(guide, /顶部提示栏不会显示维护启动、进度、完成、失败/);
  assert.match(guide, /列表加载、迁移、删除等用户操作的结果和错误仍会正常提示/);
  assert.match(guide, /首次成功加载时状态框显示“欢迎使用小助手”/);
  assert.match(guide, /自动切回模块不会覆盖/);
  assert.match(spec, /自动同步返回失败结果或抛出异常/);
  assert.match(techdoc, /updateStatus.*成功同步后是否投影摘要/);
});

test('v3.1.12 三份用户文档保留实际迭代和最终发布验收状态', () => {
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');
  const runbook = read('docs/WINDOWS_RELEASE_RUNBOOK.md');

  assert.match(changelog, /^## 3\.1\.12 - 2026-08-20$/m);
  assert.match(history, /^## v3\.1\.12（2026-08-20）$/m);

  const releaseChangelog = changelog.slice(
    changelog.indexOf('## 3.1.12'),
    changelog.indexOf('## 3.1.11')
  );
  const releaseHistory = history.slice(
    history.indexOf('## v3.1.12'),
    history.indexOf('## v3.1.11')
  );
  for (const currentSection of [releaseChangelog, releaseHistory]) {
    assert.match(currentSection, /GitHub Releases/);
    assert.match(currentSection, /验收完成/);
    assert.match(currentSection, /授权.*合并|授权合并/);
    assert.doesNotMatch(
      currentSection,
      /v3\.1\.12 当前为未发布候选|v3\.1\.12（未发布|## 3\.1\.12 - 未发布/
    );
    assert.doesNotMatch(currentSection, /业务行为与 v3\.1\.11 相同/);
  }
  assert.match(changelog, /确认期变化比较/);
  assert.match(history, /CNY\/CNH/);
  assert.match(guide, /第一行左侧显示“存档位置”、右侧显示【变更】/);
  assert.match(guide, /新导入允许用标准大写 CNH/);
  assert.match(guide, /v3\.1\.12[\s\S]{0,500}已于 2026-08-20 正式发布为 latest stable Release/);

  for (const document of [changelog, history, runbook]) {
    assert.match(document, /已于 2026-08-20 正式发布|正式发布完成|v3\.1\.12 发布记录/);
    assert.match(document, /latest stable Release/);
    assert.match(document, /Setup/);
    assert.match(document, /portable/);
    assert.match(document, /blockmap/);
    assert.match(document, /latest\.yml/);
    assert.match(document, /在线升级.*(?:canary|人工)|production\/latest/);
  }
  assert.match(guide, /latest stable Release/);
  assert.match(guide, /四项 Windows 资产已公开/);
  for (const document of [changelog, history, runbook]) {
    assert.match(document, /PR #157/);
    assert.match(document, /a8c632bad119eab6bca27b949dfb5956805cf3ae/);
    assert.match(document, /annotated tag/);
    assert.match(document, /97462b6062dda9a31d409691b0d2c2dec94f0650/);
    assert.match(document, /32393079026/);
  }
  assert.match(runbook, /336d309751e918efa1e4a7eed366fd4a68facbe74724176b0f9b60bdf76b23eb/);
  assert.match(runbook, /dc753d024c9d4734a117871cc248b6a7a40ac4d5e558c78ca962b70599ada4fa/);
  assert.doesNotMatch(runbook, /^## v3\.1\.12 纠正发布准备$/m);
  assert.doesNotMatch(runbook, /v3\.1\.12 只提升应用版本并修正随包用户指南/);
});

test('v3.1.11 三份用户文档保留正式发布证据并记录随包指南缺陷', () => {
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');
  const runbook = read('docs/WINDOWS_RELEASE_RUNBOOK.md');

  assert.match(changelog, /^## 3\.1\.11 - 2026-08-19$/m);
  assert.match(history, /^## v3\.1\.11（2026-08-19）$/m);
  for (const document of [changelog, history, guide]) {
    assert.match(document, /真实文件证据|非空文件清单|有文件才建批次/);
    assert.match(document, /不占用批次号|不推进序号|不推进批次号/);
    assert.match(document, /已于 2026-08-19[\s\S]{0,80}正式发布|正式发布完成|正式发布与验收/);
    assert.match(document, /PR #150/);
    assert.match(document, /真实数据库/);
    assert.match(document, /资金.*血缘|资金\/文件血缘|文件与资金血缘/);
    assert.match(document, /Windows 10\/11/);
    assert.match(document, /未使用.*豁免/);
    assert.match(document, /annotated tag/);
    assert.match(document, /latest stable Release/);
    assert.match(document, /四项公开资产/);
  }
  for (const document of [changelog, history, runbook]) {
    assert.match(document, /v3\.1\.11[\s\S]{0,160}未发布候选|未发布候选[\s\S]{0,160}v3\.1\.11/);
    assert.match(document, /不替换|不覆盖|不可变发布规则/);
    assert.match(document, /v3\.1\.12|更高补丁版本/);
  }
});

test('v3.1.10 三份用户文档保持正式发布历史和三项门禁结论', () => {
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.match(changelog, /^## 3\.1\.10 - 2026-08-17$/m);
  assert.match(history, /^## v3\.1\.10（2026-08-17）$/m);

  for (const document of [changelog, history, guide]) {
    assert.match(document, /已于 2026-08-17[\s\S]{0,80}正式发布/);
    assert.match(document, /PR #148/);
    assert.match(document, /27\.42\s*GB/);
    assert.match(document, /至少\s*75%|下降\s*75%/);
    assert.match(document, /Windows installer\/portable/);
    assert.match(document, /WAL|SQLite/);
    assert.match(document, /主体×九币种|主体.*九币种/);
    assert.match(document, /三项[\s\S]{0,80}PASS|三项发布门禁均已通过/);
    assert.match(document, /Windows[\s\S]{0,80}未使用.*豁免|Windows 门禁未使用豁免/);
    assert.match(document, /annotated tag/);
    assert.match(document, /latest stable Release/);
    assert.match(document, /四项公开资产/);
  }
});

test('v3.1.9 三份用户文档保持正式发布历史', () => {
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.match(changelog, /^## 3\.1\.9 - 2026-08-13$/m);
  assert.match(history, /^## v3\.1\.9（2026-08-13）$/m);
  assert.match(guide, /v3\.1\.9 已于 2026-08-13 正式发布/);
  for (const document of [changelog, history, guide]) {
    assert.match(document, /annotated tag/);
    assert.match(document, /latest stable Release/);
    assert.match(document, /四项公开资产/);
  }
});

test('v3.1.10 记录真实库与资金不可豁免且 Windows 门禁本次未使用豁免', () => {
  const spec = read('changes/3.1.10/spec.md');
  const preflight = read('changes/3.1.10/preflight.md');
  const tasks = read('changes/3.1.10/tasks.md');

  for (const document of [spec, preflight, tasks]) {
    assert.match(document, /真实库|27\.42GB|27\.42 GB/);
    assert.match(document, /资金|九币种/);
    assert.match(document, /不可豁免|不得使用 Windows Release Runbook 豁免|必须通过/);
    assert.match(document, /Windows[\s\S]{0,100}未使用.*豁免|Windows 门禁未使用.*豁免/);
    assert.match(document, /PASS|均已通过/);
  }
  assert.doesNotMatch(spec, /三项均通过，或.*Windows Release Runbook/);
});

test('v3.1.8 三份用户文档保持正式发布历史', () => {
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.match(changelog, /^## 3\.1\.8 - 2026-08-09$/m);
  assert.match(history, /^## v3\.1\.8（2026-08-09）$/m);
  assert.match(guide, /v3\.1\.8 已于 2026-08-09 正式发布/);
  assert.match(changelog, /人工发布门禁 6\/6 通过/);
  assert.match(history, /annotated tag、Windows Release workflow、latest stable Release 和四项公开资产已完成回读/);
  assert.match(guide, /自动化与技术 Release 不替代真实月份、主体和九币种的财务人工核对/);

  const changelogCandidate = changelog.slice(
    changelog.indexOf('## 3.1.8 - 2026-08-09'),
    changelog.indexOf('## 3.1.7')
  );
  const historyCandidate = history.slice(
    history.indexOf('## v3.1.8（2026-08-09）'),
    history.indexOf('## v3.1.7')
  );
  const guideSummaryStart = guide.indexOf('> **v3.1.8 VCC财务OP校验正式发布**');
  const guideSummaryEnd = guide.indexOf('> **v3.1.0 平盘资金性质校验**');
  assert.ok(guideSummaryStart >= 0 && guideSummaryEnd > guideSummaryStart);
  const guideSummary = guide.slice(guideSummaryStart, guideSummaryEnd);
  for (const candidate of [changelogCandidate, historyCandidate]) {
    assert.match(candidate, /统一生成 64 位 Windows 安装版和便携版/);
    assert.doesNotMatch(candidate, /PR 证据链|distribution guard|arm64|当前 x64 构建/);
    assert.doesNotMatch(
      candidate,
      /幂等血缘|内容指纹|语义锚点|幂等哈希|契约版本|失败关闭|完整契约/
    );
  }
  for (const candidate of [changelogCandidate, historyCandidate, guideSummary]) {
    assert.doesNotMatch(candidate, /语义模板|金标准/);
    assert.doesNotMatch(candidate, /Unreleased|待发布|尚未发布|仍未正式发布|仍待正式 tag/);
  }
});

test('v3.1.8 用户手册锁定输入、调整、状态与导出契约', () => {
  const guide = read('docs/USER_GUIDE.md');
  const sectionStart = guide.indexOf('## 1.14 VCC财务OP校验');
  const sectionEnd = guide.indexOf('\n---', sectionStart);
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
  const section = guide.slice(sectionStart, sectionEnd);

  for (const expected of [
    '46 列 `VCC_移除归档Pending账单.xlsx`',
    '`A1:AT1`',
    '`135886024.59`',
    '前四张明细校验表均必须至少有 1 条当前有效数据',
    '调整值必须非 0，最多 2 位小数、15 位有效数字',
    '调整原因去掉首尾空格后必须为 1～500 字',
    '修改结果不会覆盖基础业务行，而是新增一条可审计、不可变的增量调整记录',
    '每个结果行的每个币种只能保存一次调整',
    '固定首月标记',
    '只允许解归档当前最新已归档月',
    '较新的“已归档”或“已计算”结果都会作为依赖',
    '仅解归档而不删除会留下“已计算”结果，仍会阻断更早月份',
    '删除该月全部未归档结果',
    '再按时间正序逐月重新运行并归档',
    'M/N 列',
    '默认打印宽度为 A:L',
    'Windows installer 和 portable',
    '对生产数据库副本做只读扫描',
    '发现异常时只阻断并交由人工处理，不自动修复或改写资金事实',
    '逐主体、逐九币种核对账期、方向、金额、Pending J:K、基础值、人工调整值、生效余额、系统差异和结果颜色',
    '确认上月准确归档的生效余额进入下月期初'
  ]) {
    assert.ok(section.includes(expected), `用户手册缺少 v3.1.8 契约：${expected}`);
  }
  assert.match(section, /预览后状态发生变化时[\s\S]*不修改任何余额、结果或数据集状态/);
  assert.match(section, /从最新月开始[\s\S]*解归档较新月份[\s\S]*删除该月全部未归档结果/);
  assert.match(section, /已保存调整的一次性约束不会因解归档重置/);
  assert.match(section, /自动测试通过不代表资金人工验收完成|不能替代完整历史验证/);
  assert.match(section, /已成为 v3\.1\.8 正式发布的人工门禁证据/);
  assert.match(section, /annotated tag `v3\.1\.8`、Windows Release workflow 和四项公开资产回读均已完成/);
  assert.match(section, /v3\.1\.8 已于 2026-08-09 正式发布/);
  for (const obsolete of [
    'Pending 模板为正式 48 列',
    '财务余额使用 Excel 看到的显示值',
    '归档后该账期永久冻结',
    '首次使用或某主体没有上月归档',
    '只恢复最近已归档结果',
    '允许进入 annotated tag',
    '在正式 Release 创建并完成资产回读前',
    '仍将 v3.1.8 标为未发布'
  ]) {
    assert.equal(section.includes(obsolete), false, `用户手册仍含旧口径：${obsolete}`);
  }
});

test('仓库内最终 Spec 只修正两处业务路径并锁定三阶段哈希证据', () => {
  const spec = read('changes/3.1.8/spec.md');
  const notes = read('changes/3.1.8/implementation-notes.md');
  const preflight = read('changes/3.1.8/preflight.md');
  const currentSpecSha256 = normalizedTextSha256(readBuffer('changes/3.1.8/spec.md'));
  const sectionStart = spec.indexOf('### 10.4');
  const sectionEnd = spec.indexOf('\n### ', sectionStart + 1);
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
  const releaseDocs = spec.slice(sectionStart, sectionEnd);

  assert.match(releaseDocs, /`docs\/VERSION_FEATURE_HISTORY\.md`/);
  assert.match(releaseDocs, /`docs\/USER_GUIDE\.md`/);
  assert.doesNotMatch(releaseDocs, /`USER_GUIDE\.html`/);
  assert.equal(currentSpecSha256, FROZEN_SPEC_SHA256);
  assert.match(notes, /9f3af33df52907499ec673b20f808b7615e7edf10231a33508c8eb5acd2a76de/);
  assert.match(notes, /018675fb6da6a07a72b8a7b23a28928dd8eb643b02592d0320714628f55221d8/);
  assert.match(notes, /1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d/);
  assert.match(notes, /五处(?: Markdown )?换行格式修复/);
  assert.match(notes, /changes\/3\.1\.8\/spec\.md/);
  assert.match(preflight, /业务内容只修正 §10\.4 的两处真实文档路径/);
  assert.match(preflight, /五处纯格式修复/);
  assert.match(preflight, /格式修复前、仅完成路径修正的阶段哈希/);
  assert.match(preflight, /CRLF\/CR.*LF/);
  assert.match(preflight, new RegExp(FROZEN_SPEC_SHA256));
});

test('Spec 冻结内容哈希跨 LF、CRLF 与 CR checkout 稳定且内容变化仍失败', () => {
  const normalizedSpec = normalizeLineEndingsForHash(readBuffer('changes/3.1.8/spec.md'));
  const lfText = normalizedSpec.toString('utf8');
  const crlfText = lfText.replace(/\n/g, '\r\n');
  const crText = lfText.replace(/\n/g, '\r');
  const changedText = lfText.replace('docs/USER_GUIDE.md', 'docs/USER_GUIDE.html');

  assert.notEqual(changedText, lfText, '内容变化夹具必须实际改动 Spec');
  assert.equal(normalizedTextSha256(lfText), FROZEN_SPEC_SHA256);
  assert.equal(normalizedTextSha256(crlfText), FROZEN_SPEC_SHA256);
  assert.equal(normalizedTextSha256(crText), FROZEN_SPEC_SHA256);
  assert.notEqual(normalizedTextSha256(changedText), FROZEN_SPEC_SHA256);
});

test('v3.1.9 VCC CNY 与异常过滤修订在 Spec 和 TechDoc 中保持一致', () => {
  const erratumSpec = read(
    'changes/3.1.8/erratum/VCC财务OP-3.1.8卡顿与旧归档兼容纠错Spec-v2.md'
  );
  const erratumTechDoc = read(
    'changes/3.1.8/erratum/VCC财务OP-3.1.8卡顿与旧归档兼容纠错TechDoc-v1.1.md'
  );
  const currentSpec = read('changes/3.1.9/spec.md');
  const frozenSpecSha = normalizedTextSha256(readBuffer('changes/3.1.8/spec.md'));

  assert.equal(frozenSpecSha, FROZEN_SPEC_SHA256, '历史 v3.1.8 Spec 不得被当前修订改写');
  assert.match(erratumSpec, /document-version: `2\.1`/);
  assert.match(erratumTechDoc, /document-version: `1\.2`/);
  for (const document of [erratumSpec, erratumTechDoc, currentSpec]) {
    assert.match(document, /AUD[\s\S]*CAD[\s\S]*CNY[\s\S]*EUR[\s\S]*GBP[\s\S]*HKD[\s\S]*JPY[\s\S]*SGD[\s\S]*USD/);
    assert.match(document, /CNY.*CNH|CNH.*CNY/);
    assert.match(document, /异常.*过滤|过滤.*异常/);
    assert.match(document, /主体.*九币种|九币种.*主体/);
    assert.match(document, /hard failure|整组失败关闭/);
    assert.match(document, /vcc-currency-migration-blocked/);
    assert.match(document, /48c8161484128e63a6e3e60724336f2433a8f23687695d980720c59a9dec2053/);
  }
  assert.match(erratumSpec, /rawCount = insertedCount \+ skippedCount/);
  assert.match(erratumTechDoc, /currency_contract_version=2/);
  assert.match(currentSpec, /不得显示零行假成功|零行假成功/);
});

test('v3.1.8 iteration PRD 与 PR 归档锁定人工 6/6 PASS 和正式 Release 证据', () => {
  const prd = read('docs/iterations/v3.1.8/PRD-v3.1.8.md');
  const preflight = read('changes/3.1.8/preflight.md');
  const prArchive = read('docs/prs/PR124-v3.1.8.md');
  const notes = read('changes/3.1.8/implementation-notes.md');

  assert.match(prd, /^# bank-bill-excel-tool 3\.1\.8 PRD 索引$/m);
  assert.match(prd, /> 目标版本：`3\.1\.8`/);
  assert.match(prd, /> 状态：已正式发布（2026-08-09）/);
  assert.ok(prd.includes('[`changes/3.1.8/spec.md`](../../../changes/3.1.8/spec.md)'));
  assert.match(prd, /^## 2\. 范围$/m);
  assert.match(prd, /^## 3\. 非目标$/m);
  assert.match(prd, /^## 4\. 验收索引$/m);
  assert.match(prd, /^## 5\. 人工发布门禁（6\/6 已通过）$/m);
  assert.match(prd, /spec\.md#11-测试计划/);
  assert.match(prd, /spec\.md#12-验收矩阵/);
  assert.match(prd, /spec\.md#15-definition-of-done/);
  assert.match(prd, /preflight\.md#人工发布门禁确认2026-08-09/);
  assert.match(prd, /真实约 700 万行、多 sheet 工具箱极限文件/);
  assert.match(prd, /人工门禁现为 6\/6 PASS/);
  assert.match(prd, /^## 6\. 正式发布结果$/m);
  assert.match(preflight, /main@e36bd9a/);
  assert.match(preflight, /31310190290/);
  assert.match(preflight, /自动化平台门禁已闭合/);
  assert.match(preflight, /^### 人工发布门禁确认（2026-08-09）$/m);
  assert.match(preflight, /六项均已实际完成，授权记录为通过并继续正式发布/);
  assert.match(preflight, /授权记录时间为 `2026-08-09 20:31:09 \+0800`/);
  assert.match(preflight, /pull\/130#issuecomment-5231526107/);
  const gateStart = preflight.indexOf('### 人工发布门禁确认（2026-08-09）');
  const formalReleaseStart = preflight.indexOf('\n## 正式发布结果（2026-08-09）');
  assert.ok(gateStart >= 0 && formalReleaseStart > gateStart);
  const gateSection = preflight.slice(gateStart, formalReleaseStart);
  assert.equal((gateSection.match(/\| PASS \|/g) || []).length, 6);
  assert.match(gateSection, /真实约 700 万行、多 sheet 工具箱极限文件压力验证/);
  assert.match(prArchive, /^pr: 124$/m);
  assert.match(prArchive, /^merged: 2026-08-09 \(e36bd9a9c161becfbb72ab97bf41963d63012089\)$/m);
  assert.match(prArchive, /^released: 2026-08-09 \(v3\.1\.8\)$/m);
  assert.match(prArchive, /六项均已实际完成，授权记录为通过并继续正式发布/);
  assert.match(prArchive, /pull\/130#issuecomment-5231526107/);
  assert.equal((prArchive.match(/^\d\. PASS —/gm) || []).length, 6);
  assert.match(prArchive, /^### 正式发布证据（2026-08-09）$/m);
  assert.match(notes, /^### 正式发布证据（2026-08-09）$/m);

  for (const expected of [
    '普通 merge commit `688ae2cb4a85d2fe8d74bdbefb06c6e3056ddcfa`',
    '发布分支未删除',
    'tag object 为 `eabe485a0393abac09a202420d7a92b4d2d28726`',
    'peeled commit 与发布时 `main` 均为 `688ae2cb4a85d2fe8d74bdbefb06c6e3056ddcfa`',
    'Release workflow run 31314412353',
    'https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/31314412353',
    'job `93247225343`',
    '`2026-08-09T12:53:34Z`',
    '`2026-08-09T13:24:20Z`',
    'unit `4801/4802`（1 expected skip）',
    'integration `48/48` scripts 且 `2459/2459` 可计数断言',
    'smoke PASS',
    'main panel `6/6`',
    '大文件 `50/50` / 475269ms',
    '拆分 `31/31` / 401655ms',
    'Release v3.1.8',
    'https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.8',
    'ID `367485098`',
    '`published_at=2026-08-09T13:24:16Z`',
    '`/releases/latest` 返回同一 tag',
    'draft=false、prerelease=false',
    '公开 `browser_download_url` 无 Authorization 独立下载',
    'Release 自定义资产集合恰好四项',
    '`version=3.1.8`',
    '`path` 与 `files[0].url` 均为 `bank-bill-excel-tool-setup-3.1.8.exe`',
    '`files[0].size=100183781`',
    '8x/2kU12ea1qpsTlOve2TH9kbL9ObSR6i5jkhv/viYWaQcOPVucD8di4uoEeTKtA/apHeMuBrbLLtfkFzKUGRw==',
    'NSIS/self-extractor 外层 PE Machine 为 `0x14c`',
    'Setup 与 portable 外层文件头均为 `MZ`',
    '`清结算小助手.exe` 均为 202,799,104 bytes',
    '7c01f36352e98815fe902add3a17608278c316f2fc6b8cc460f3645db5d73e0d',
    'PE Machine `0x8664`（x86-64）',
    '它是业务合同，不承载可变发布状态'
  ]) {
    assert.ok(preflight.includes(expected), `preflight 缺少正式发布证据：${expected}`);
  }

  const assetsSection = preflight.slice(
    preflight.indexOf('### exactly 四项公开资产'),
    preflight.indexOf('### updater 与 PE 架构')
  );
  const expectedAssetRows = [
    '| `bank-bill-excel-tool-portable-3.1.8.exe` | `507535165` | 99,686,916 | `3fe4572b519428a7b749a860130287ada6450fd631f039f258240671ab4c79ab` |',
    '| `bank-bill-excel-tool-setup-3.1.8.exe` | `507535166` | 100,183,781 | `f2348f6f14d039113568e25b7770eff049ce6fc2af2e246d7261a6c6969351a9` |',
    '| `bank-bill-excel-tool-setup-3.1.8.exe.blockmap` | `507535163` | 105,382 | `c57e6723010de00c5af235c8f5a6ff1646be7d6729d0590f15a8c4458e4b5c91` |',
    '| `latest.yml` | `507535164` | 369 | `9ffb50d6cdca2bb49ad06ecfce9c160fafe80ca4cea009e1e0e20e62ac92c1ba` |'
  ];
  for (const expected of expectedAssetRows) {
    assert.ok(assetsSection.includes(expected), `公开资产表缺少精确映射：${expected}`);
  }
  assert.equal((assetsSection.match(/^\| `[^`]+` \| `\d+` \|/gm) || []).length, 4);
});
