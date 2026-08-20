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

test('v3.1.12 版本号与三份用户文档同步实际迭代和最终验收状态', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');
  const mainSource = read('src/main.js');

  assert.equal(packageJson.version, '3.1.12');
  assert.equal(packageLock.version, '3.1.12');
  assert.equal(packageLock.packages[''].version, '3.1.12');
  assert.ok(packageJson.build.files.includes('docs/USER_GUIDE.md'));
  assert.match(mainSource, /path\.join\(app\.getAppPath\(\), 'docs', 'USER_GUIDE\.md'\)/);
  assert.match(changelog, /^## 3\.1\.12 - 2026-08-20$/m);
  assert.match(history, /^## v3\.1\.12（2026-08-20）$/m);
  assert.match(guide, /^版本：`v3\.1\.12`$/m);

  const currentChangelog = changelog.slice(0, changelog.indexOf('## 3.1.11'));
  const currentHistory = history.slice(0, history.indexOf('## v3.1.11'));
  const currentGuide = guide.slice(0, guide.indexOf('\n---'));
  for (const currentSection of [currentChangelog, currentHistory, currentGuide]) {
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
