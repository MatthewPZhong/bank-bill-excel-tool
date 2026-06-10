'use strict';
// 大表导入引擎 row-scanner 单元级测试（直接驱动导出的纯函数 + 列号/转义工具）。
//   四方 harness 已锁端到端 byte-for-byte；本文件补单元级语义（rowBytesToValues 行内解析 / 列号互逆 /
//   xmlUnescape），确保所有导出 API 有直接覆盖。

const { test } = require('node:test');
const assert = require('node:assert');
const rs = require('../../../../src/backend/big-table-import/row-scanner');

// 把一行字符串转 Buffer
function buf(s) { return Buffer.from(s, 'utf8'); }

test.describe('big-table-import row-scanner 单元', () => {

  test('columnLetterToIndex / indexToColumnLetters 严格互逆', () => {
    const samples = [0, 1, 25, 26, 27, 51, 52, 701, 702];
    for (const i of samples) {
      assert.equal(rs.columnLetterToIndex(rs.indexToColumnLetters(i)), i, `互逆 idx=${i}`);
    }
    assert.equal(rs.indexToColumnLetters(0), 'A');
    assert.equal(rs.indexToColumnLetters(6), 'G');
    assert.equal(rs.indexToColumnLetters(28), 'AC');
    assert.equal(rs.indexToColumnLetters(29), 'AD');
    assert.equal(rs.columnLetterToIndex('AV'), 47);
  });

  test('xmlUnescape：具名实体 + 数字字符引用 + 无实体短路', () => {
    assert.equal(rs.xmlUnescape('no-entity'), 'no-entity');
    assert.equal(rs.xmlUnescape('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f');
    assert.equal(rs.xmlUnescape('&#65;&#x42;'), 'AB');
    assert.equal(rs.xmlUnescape('中&amp;文'), '中&文');
  });

  test('rowBytesToValues：全列模式（whitelist=null）逐 cell 取值', () => {
    const b = buf('<c r="A2" t="inlineStr"><is><t>2026-03-10</t></is></c>'
      + '<c r="B2"><v>123.45</v></c>'
      + '<c r="C2" t="inlineStr"><is><t>中文&amp;值</t></is></c>');
    const { values, hasAnyCellText } = rs.rowBytesToValues(b, 0, b.length, 5, [], null, false);
    assert.equal(values[0], '2026-03-10');
    assert.equal(values[1], '123.45', '无 t number 取 <v> 原文');
    assert.equal(values[2], '中文&值', 'inlineStr 实体解码');
    assert.equal(values[3], '');
    assert.equal(hasAnyCellText, true);
  });

  test('rowBytesToValues：白名单模式仅取目标列，外列恒空，hasAnyCellText 探测覆盖外列', () => {
    const b = buf('<c r="A2" t="inlineStr"><is><t>仅外列</t></is></c>'   // col 0 外（白名单 {1,3}）
      + '<c r="B2"><v>X1</v></c>'                                          // col 1 内
      + '<c r="D2"><v>X3</v></c>');                                        // col 3 内
    const wl = new Set([1, 3]);
    const { values, hasAnyCellText } = rs.rowBytesToValues(b, 0, b.length, 5, [], wl, false);
    assert.equal(values[0], '', '白名单外列恒空');
    assert.equal(values[1], 'X1');
    assert.equal(values[3], 'X3');
    assert.equal(hasAnyCellText, true, '白名单外列(col0)有值 → 探测到 → hasAnyCellText=true');
  });

  test('rowBytesToValues：仅白名单外列有值 → values 全空但 hasAnyCellText=true（退化探测）', () => {
    const b = buf('<c r="A2" t="inlineStr"><is><t>外</t></is></c>');   // col 0 外（白名单 {1,3}）
    const wl = new Set([1, 3]);
    const { values, hasAnyCellText } = rs.rowBytesToValues(b, 0, b.length, 5, [], wl, false);
    assert.equal(values.every((v) => v === ''), true, 'values 全空');
    assert.equal(hasAnyCellText, true, '探测覆盖白名单外列 → 不被误判空行');
  });

  test('rowBytesToValues：全空行（无 cell 有值）→ hasAnyCellText=false', () => {
    const b = buf('<c r="A2"><v></v></c><c r="B2" t="inlineStr"><is><t></t></is></c>');
    const { hasAnyCellText } = rs.rowBytesToValues(b, 0, b.length, 5, [], null, false);
    assert.equal(hasAnyCellText, false);
  });

  test('rowBytesToValues：表头行（isHeaderRow=true）白名单不生效，全列收集（动态数组）', () => {
    const b = buf('<c r="A1" t="inlineStr"><is><t>列0</t></is></c>'
      + '<c r="B1" t="inlineStr"><is><t>列1</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><t>列2</t></is></c>');
    const wl = new Set([1]);   // 即使传白名单
    const { values } = rs.rowBytesToValues(b, 0, b.length, 2, [], wl, true);   // expectedLen=2 但表头不截断
    assert.equal(values[0], '列0');
    assert.equal(values[1], '列1');
    assert.equal(values[2], '列2', '表头行全列收集（不受 expectedLen 截断，供 validator 检测列多）');
  });

  test('rowBytesToValues：s 型查 SST + 越界/NaN → 空', () => {
    const ss = ['甲', '乙'];
    const b = buf('<c r="A2" t="s"><v>0</v></c>'    // 甲
      + '<c r="B2" t="s"><v>1</v></c>'              // 乙
      + '<c r="C2" t="s"><v>9</v></c>'              // 越界 → ''
      + '<c r="D2" t="s"><v>x</v></c>');            // NaN → ''
    const { values } = rs.rowBytesToValues(b, 0, b.length, 5, ss, null, false);
    assert.equal(values[0], '甲');
    assert.equal(values[1], '乙');
    assert.equal(values[2], '');
    assert.equal(values[3], '');
  });

  test('rowBytesToValues：同列重复 → 后者覆盖（对齐 sax）', () => {
    const b = buf('<c r="A2" t="inlineStr"><is><t>前</t></is></c>'
      + '<c r="A2" t="inlineStr"><is><t>后</t></is></c>');
    const { values } = rs.rowBytesToValues(b, 0, b.length, 5, [], null, false);
    assert.equal(values[0], '后', '同列出现两次取后者');
  });

  test('rowBytesToValues：无 r 属性 cell 跳过；自闭合 cell 取值空', () => {
    const b = buf('<c t="inlineStr"><is><t>无r</t></is></c>'   // 无 r → 跳过
      + '<c r="B2"/>'                                          // 自闭合 → ''
      + '<c r="C2"><v>有值</v></c>');
    const { values, hasAnyCellText } = rs.rowBytesToValues(b, 0, b.length, 5, [], null, false);
    assert.equal(values[1], '');
    assert.equal(values[2], '有值');
    assert.equal(hasAnyCellText, true, 'col2 有值');
  });
});
