'use strict';
// v2.1.12 codex review Critical 修复回归测试：parseRowXml cell 属性顺序无关（🔴资金红线）
// 背景：旧 CELL_OPEN_RE 写死 `<c\s+r="..."` 要求 r 是第一个属性，OOXML 不保证属性顺序，
//   合法单元格 <c s="2" r="N2"><v>金额</v></c>（s 在 r 前）会被漏读 → 金额列按空值计 0 → 少算发生额。
//   修复后从 attrs 任意位置提取 r/t。本测试锁定该行为，防回归。

const { test } = require('node:test');
const assert = require('node:assert');
const { parseRowXml } = require('../../../../src/backend/pending-import/streaming-xlsx-reader');

test('parseRowXml: r 为第一个属性（基线，不回归）', () => {
  const cells = parseRowXml('<row r="1"><c r="A1"><v>10</v></c><c r="B1"><v>20.5</v></c></row>', 28, null);
  assert.strictEqual(cells[0], '10');
  assert.strictEqual(cells[1], '20.5');
});

test('parseRowXml: 🔴 s 在 r 之前的 styled cell — 金额不漏读（Critical 回归）', () => {
  const cells = parseRowXml('<row r="2"><c r="A2"><v>1</v></c><c s="2" r="B2"><v>123.45</v></c></row>', 28, null);
  assert.strictEqual(cells[1], '123.45', 's 在 r 前的金额单元格不能漏成空（否则按 0 入账）');
});

test('parseRowXml: t 在 r 之前的 shared string cell — 类型正确解析', () => {
  const cells = parseRowXml('<row r="1"><c t="s" r="A1"><v>1</v></c></row>', 28, ['x', 'BU-001']);
  assert.strictEqual(cells[0], 'BU-001');
});

test('parseRowXml: 多属性任意顺序(s,t,r) + 大额金额精确（资金红线）', () => {
  const cells = parseRowXml('<row r="3"><c r="A3" t="s"><v>0</v></c><c s="5" t="n" r="D3"><v>2223798.77</v></c></row>', 28, ['ACC']);
  assert.strictEqual(cells[0], 'ACC');
  assert.strictEqual(cells[3], '2223798.77');
});

test('parseRowXml: 自闭合空 cell <c r=".."/> 不影响相邻列', () => {
  const cells = parseRowXml('<row r="1"><c r="A1"><v>5</v></c><c r="B1"/><c r="C1"><v>7</v></c></row>', 28, null);
  assert.strictEqual(cells[0], '5');
  assert.strictEqual(cells[1], '');
  assert.strictEqual(cells[2], '7');
});

test('parseRowXml: 自闭合 cell 属性顺序无关 <c s=.. r=../>', () => {
  const cells = parseRowXml('<row r="1"><c s="2" r="A1"/><c r="B1"><v>9</v></c></row>', 28, null);
  assert.strictEqual(cells[0], '');
  assert.strictEqual(cells[1], '9');
});

// v3.0.8 BUG3 回归：<v> 带属性（xml:space="preserve"）的字符串不能被读成空串。
//   SheetJS / Excel 写「含首尾空格的字符串」会输出 <c t="str"><v xml:space="preserve"> A </v></c>；
//   旧正则 /<v>...<\/v>/ 不匹配带属性的 <v> → 该格静默丢失（工具箱合表/拆表读任意用户表头/数据时丢字）。
test('parseRowXml: <v xml:space="preserve"> 含空格字符串不丢（BUG3 回归）', () => {
  const cells = parseRowXml('<row r="1"><c r="A1" t="str"><v xml:space="preserve"> A </v></c><c r="B1" t="str"><v>B</v></c></row>', 28, null);
  assert.strictEqual(cells[0], ' A ', '<v> 带属性时值不丢（含首尾空格原样）');
  assert.strictEqual(cells[1], 'B', '裸 <v> 仍正常（向后兼容）');
});

test('parseRowXml: <v> 带属性的数字单元格不漏读（资金红线，<v> 属性容忍）', () => {
  // 防御：理论上数字格也可能带 <v> 属性 → 必须照常读出，不能漏算金额
  const cells = parseRowXml('<row r="1"><c r="A1" t="n"><v xml:space="preserve">123.45</v></c></row>', 28, null);
  assert.strictEqual(cells[0], '123.45');
});
