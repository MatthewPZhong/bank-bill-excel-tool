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

test('v3.1.8 版本号与三份用户文档保持已批准但尚未发布状态', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.equal(packageJson.version, '3.1.8');
  assert.equal(packageLock.version, '3.1.8');
  assert.equal(packageLock.packages[''].version, '3.1.8');
  assert.match(changelog, /^## 3\.1\.8 - Unreleased$/m);
  assert.match(history, /^## v3\.1\.8（待发布，人工门禁已通过）$/m);
  assert.match(guide, /^版本：`v3\.1\.8`（未发布，已批准进入发布流程）$/m);
  assert.match(guide, /v3\.1\.8 尚未发布/);
  assert.match(changelog, /人工发布门禁 6\/6 通过/);
  assert.match(history, /已批准发布、待 annotated tag \+ Windows Release workflow \+ 公开资产复核/);
  assert.match(guide, /该状态不表示 tag、Release 或正式下载资产已经存在/);
  assert.doesNotMatch(changelog, /^## 3\.1\.8 - 20\d{2}-\d{2}-\d{2}$/m);

  const changelogCandidate = changelog.slice(
    changelog.indexOf('## 3.1.8 - Unreleased'),
    changelog.indexOf('## 3.1.7')
  );
  const historyCandidate = history.slice(
    history.indexOf('## v3.1.8（待发布，人工门禁已通过）'),
    history.indexOf('## v3.1.7')
  );
  const guideSummaryStart = guide.indexOf('> **v3.1.8 VCC财务OP校验发布准备已批准**');
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
  for (const obsolete of [
    'Pending 模板为正式 48 列',
    '财务余额使用 Excel 看到的显示值',
    '归档后该账期永久冻结',
    '首次使用或某主体没有上月归档',
    '只恢复最近已归档结果'
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

test('v3.1.8 iteration PRD 与 PR 归档锁定人工 6/6 PASS 且 Release 仍 pending', () => {
  const prd = read('docs/iterations/v3.1.8/PRD-v3.1.8.md');
  const preflight = read('changes/3.1.8/preflight.md');
  const prArchive = read('docs/prs/PR124-v3.1.8.md');

  assert.match(prd, /^# bank-bill-excel-tool 3\.1\.8 PRD 索引$/m);
  assert.match(prd, /> 目标版本：`3\.1\.8`/);
  assert.match(prd, /> 状态：已批准进入正式发布流程（尚未创建 tag\/Release）/);
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
  assert.match(prd, /在 tag、Release 与四项公开资产实际创建并回读前/);
  assert.match(preflight, /main@e36bd9a/);
  assert.match(preflight, /31310190290/);
  assert.match(preflight, /自动化平台门禁已闭合/);
  assert.match(preflight, /^### 人工发布门禁确认（2026-08-09）$/m);
  assert.match(preflight, /六项均已实际完成，授权记录为通过并继续正式发布/);
  assert.match(preflight, /授权记录时间为 `2026-08-09 20:31:09 \+0800`/);
  assert.match(preflight, /pull\/130#issuecomment-5231526107/);
  const gateSection = preflight.slice(preflight.indexOf('### 人工发布门禁确认（2026-08-09）'));
  assert.equal((gateSection.match(/\| PASS \|/g) || []).length, 6);
  assert.match(gateSection, /真实约 700 万行、多 sheet 工具箱极限文件压力验证/);
  assert.match(gateSection, /当前仍未创建 `v3\.1\.8` annotated tag 或 GitHub Release/);
  assert.match(prArchive, /^pr: 124$/m);
  assert.match(prArchive, /^merged: 2026-08-09 \(e36bd9a9c161becfbb72ab97bf41963d63012089\)$/m);
  assert.match(prArchive, /^released: pending$/m);
  assert.match(prArchive, /v3\.1\.8` tag 不存在/);
  assert.match(prArchive, /六项均已实际完成，授权记录为通过并继续正式发布/);
  assert.match(prArchive, /pull\/130#issuecomment-5231526107/);
  assert.equal((prArchive.match(/^\d\. PASS —/gm) || []).length, 6);
  assert.match(prArchive, /不提前证明 tag、Release 或公开资产已经存在/);
});
