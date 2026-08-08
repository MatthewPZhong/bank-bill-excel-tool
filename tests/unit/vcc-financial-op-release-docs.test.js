'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('v3.1.8 版本号与三份用户文档保持发布候选状态', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));
  const changelog = read('CHANGELOG.md');
  const history = read('docs/VERSION_FEATURE_HISTORY.md');
  const guide = read('docs/USER_GUIDE.md');

  assert.equal(packageJson.version, '3.1.8');
  assert.equal(packageLock.version, '3.1.8');
  assert.equal(packageLock.packages[''].version, '3.1.8');
  assert.match(changelog, /^## 3\.1\.8 - Unreleased$/m);
  assert.match(history, /^## v3\.1\.8（待发布）$/m);
  assert.match(guide, /^版本：`v3\.1\.8`（发布候选）$/m);
  assert.match(guide, /v3\.1\.8 尚未发布/);
  assert.doesNotMatch(changelog, /^## 3\.1\.8 - 20\d{2}-\d{2}-\d{2}$/m);

  const changelogCandidate = changelog.slice(
    changelog.indexOf('## 3.1.8 - Unreleased'),
    changelog.indexOf('## 3.1.7')
  );
  const historyCandidate = history.slice(
    history.indexOf('## v3.1.8（待发布）'),
    history.indexOf('## v3.1.7')
  );
  const guideSummaryStart = guide.indexOf('> **v3.1.8 VCC财务OP校验发布候选**');
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

test('仓库内最终 Spec 修正发布文档路径并保留来源哈希证据', () => {
  const spec = read('changes/3.1.8/spec.md');
  const notes = read('changes/3.1.8/implementation-notes.md');
  const sectionStart = spec.indexOf('### 10.4');
  const sectionEnd = spec.indexOf('\n### ', sectionStart + 1);
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
  const releaseDocs = spec.slice(sectionStart, sectionEnd);

  assert.match(releaseDocs, /`docs\/VERSION_FEATURE_HISTORY\.md`/);
  assert.match(releaseDocs, /`docs\/USER_GUIDE\.md`/);
  assert.doesNotMatch(releaseDocs, /`USER_GUIDE\.html`/);
  assert.match(notes, /9f3af33df52907499ec673b20f808b7615e7edf10231a33508c8eb5acd2a76de/);
  assert.match(notes, /changes\/3\.1\.8\/spec\.md/);
});
