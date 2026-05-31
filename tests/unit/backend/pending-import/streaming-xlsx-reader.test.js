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
