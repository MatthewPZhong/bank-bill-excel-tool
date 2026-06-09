// v2.1.9 N6 (T31-T32, D18=a)：updateBankStatementUi 4 状态文案外层不再带冒号后 `\n`
//   设计意图：内层 updateStatusBox `String(message).replace(/：/g, '：\n')` 统一处理 → 外层不能重复 \n
//   spec.md §7.3 / tasks.md T31
//
// 单元测试形态：grep 银行对账单文案模板字符串 — 不引 DOM / 不模拟 Electron renderer
//   仅校验 `已导出：\n` / `已导入：\n` 模式从源文件消失（v2.1.7 round 2 R3 内层设计的前提）
//   配套：preview 截图回归（手测验视觉）

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_PATH = path.join(__dirname, '..', '..', 'src', 'renderer.js');
const source = fs.readFileSync(RENDERER_PATH, 'utf8');

describe('updateBankStatementUi — N6 状态框换行修复 (v2.1.9 T31)', () => {
  test('外层文案 `已导出：` 后不再有 \\n（删冗余）', () => {
    // 模板字面量 `已导出：\n${...}` 在源码中应为 0 命中
    const matches = source.match(/已导出：\\n/g) || [];
    assert.strictEqual(matches.length, 0,
      `源文件还存在 ${matches.length} 处 \`已导出：\\n\`，应删除（内层 updateStatusBox 已统一处理）`);
  });

  test('外层文案 `已导入：` 后不再有 \\n（删冗余）', () => {
    const matches = source.match(/已导入：\\n/g) || [];
    assert.strictEqual(matches.length, 0,
      `源文件还存在 ${matches.length} 处 \`已导入：\\n\`，应删除`);
  });

  test('外层文案仍含「已导出：」「已导入：」字符串（仅删 \\n，不删字面）', () => {
    assert.ok(source.includes('已导出：${ex.mainFileName}'),
      '源文件应保留 `已导出：${ex.mainFileName}` 模板字面');
    // v3.0.0 需求1：「已导入：」后注入半角冒号的「渠道-地区」前缀 channelRegionPrefix（前缀为空时兜底原文案）。
    //   字面随之变为 `已导入：${channelRegionPrefix}${bs.fileName}`；下方仍校验「已导入：」+ 文件名变量未被删。
    assert.ok(source.includes('已导入：${channelRegionPrefix}${bs.fileName}'),
      '源文件应保留 `已导入：${channelRegionPrefix}${bs.fileName}` 模板字面（v3.0.0 需求1 前缀注入）');
  });

  // v3.0.0 需求1 护栏：前缀分隔必须用半角 ':'、组合间顿号 '、'，绝不用全角「：」
  //   （updateStatusBox 对全角「：」自动补 \n 会把前缀与文件名打断到两行）。
  test('渠道-地区前缀使用半角冒号（channelRegionPrefix 用 `:` 不用全角「：」）', () => {
    assert.ok(source.includes("`${combos.join('、')}:`"),
      "前缀拼接应为 `${combos.join('、')}:`（半角冒号 + 顿号），避免全角「：」触发自动换行");
    // 前缀字面中不得出现全角「：」（否则 updateStatusBox 会在前缀后强制换行）
    assert.ok(!source.includes("${combos.join('、')}："),
      '前缀拼接不得使用全角「：」（会被 updateStatusBox 自动换行打断「前缀+文件名同行」）');
  });

  test('行间换行 `\\nerror-report：` 与 `\\n不平账结果表：` 保留（非冒号后冗余）', () => {
    assert.ok(source.includes('\\nerror-report：${ex.errorReportName}'),
      '`\\nerror-report：` 行间换行应保留');
    assert.ok(source.includes('\\n不平账结果表：${gw.fileName}'),
      '`\\n不平账结果表：` 行间换行应保留');
  });

  test('updateStatusBox 内层 `String(message).replace(/：/g, "：\\n")` 设计保留（v2.1.7 R3 不动）', () => {
    // 内层处理冒号→换行的逻辑必须仍在文件里（否则单换行依赖会失效）
    assert.ok(source.includes("String(message).replace(/：/g, '：\\n')"),
      'updateStatusBox 内层 replace `：` → `：\\n` 必须保留（v2.1.7 round 2 R3 §8.4.2 设计）');
  });
});
