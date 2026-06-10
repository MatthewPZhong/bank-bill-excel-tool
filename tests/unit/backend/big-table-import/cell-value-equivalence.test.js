'use strict';
// 引擎 row-scanner 的 cell 取值/判空函数（非正则手写版）与收单 reader-handrolled（含正则 TV_RE）
//   在全形态 cell body 上 byte-for-byte 等价（🔴 资金红线 — 取值语义不得漂移）。
//   覆盖：inlineStr 多 <t> 取最后 / 末尾空 run / 自闭合 <t/> / 公式 <f> / number 原文 / s 查表 /
//         越界·NaN 索引 / XML 实体 / 带属性的 <t ...>/<v ...> / 空 body。

const { test } = require('node:test');
const assert = require('node:assert');

const engine = require('../../../../src/backend/big-table-import/row-scanner');
const hand = require('../../../../src/backend/acquiring-bill-currency-import/reader-handrolled');

// 全形态 body 样本 + type + sharedStrings 组合
const SS = ['有内容', '', 'USD', '中文&值', '混合'];
const cases = [
  // [body, type]
  ['<is><t>X</t></is>', 'inlineStr'],
  ['<is><t>P</t><t>Q</t></is>', 'inlineStr'],          // 多 t 取最后 Q
  ['<is><t>P</t><t></t></is>', 'inlineStr'],           // 末尾空 run → 取最后 ''
  ['<is><t></t></is>', 'inlineStr'],                    // 空 t
  ['<t>裸t</t>', 'inlineStr'],                           // 无 <is> 包裹的 t
  ['<t xml:space="preserve"> 保留空格 </t>', 'inlineStr'],  // 带属性的 <t ...>
  ['<v>123</v>', 'n'],
  ['<v>1000.00</v>', 'n'],                              // 尾零小数原文
  ['<v>1.5e3</v>', 'n'],                                // 科学计数原文
  ['<v>1398765432109876543</v>', 'n'],                 // 大数原文
  ['<v></v>', 'n'],                                     // 空 v
  ['', 'n'],                                            // 空 body
  ['<f>SUM(A:A)</f>', 'n'],                             // 仅公式 → 无采集
  ['<f>SUM(A:A)</f><v>123.45</v>', 'n'],                // 公式 + v → 取 v
  ['<v>&amp;</v>', 'n'],                                // 实体
  ['<v>amp&amp;lt&lt;gt&gt;</v>', 'n'],                 // 多实体
  ['<v>&#65;&#x42;</v>', 'n'],                          // 数字字符引用
  ['<v xml:space="preserve">5</v>', 'n'],               // 带属性的 <v ...>
  ['<v>0</v>', 's'],                                    // s 索引 0 → 有内容
  ['<v>1</v>', 's'],                                    // s 索引 1 → 空串
  ['<v>2</v>', 's'],                                    // s 索引 2 → USD
  ['<v>3</v>', 's'],                                    // s 索引 3 → 中文&值
  ['<v>99</v>', 's'],                                   // 越界 → ''
  ['<v>bad</v>', 's'],                                  // NaN → ''
  ['<v>5</v>', 's'],                                    // 越界（SS 长 5，idx 5 越界）→ ''
  ['<is><t>A</t></is>', 's'],                           // s 型但 body 是 t（畸形）→ 取 <v>... 无 v → ''
  ['<v>1</v>', 'str'],                                  // str 型取 v 原文
  ['<is><t>S</t></is>', 'str']                          // str 型多按 inlineStr 取 t
];

test.describe('big-table-import cell 取值/判空 与 reader-handrolled byte-for-byte 等价', () => {
  test('cellValueFromBody 全形态等价', () => {
    for (const [body, type] of cases) {
      const ev = engine.cellValueFromBody(body, type, SS);
      const hv = hand.cellValueFromBody(body, type, SS);
      assert.equal(ev, hv, `cellValueFromBody 不一致 type=${type} body="${body}"（engine="${ev}" hand="${hv}"）`);
    }
  });

  test('cellHasText 全形态等价（且 ≡ 取值 !== ""）', () => {
    for (const [body, type] of cases) {
      const eh = engine.cellHasText(body, type, SS);
      const hh = hand.cellHasText(body, type, SS);
      assert.equal(eh, hh, `cellHasText 不一致 type=${type} body="${body}"（engine=${eh} hand=${hh}）`);
      // 自洽：cellHasText ≡ (cellValueFromBody !== '')
      assert.equal(eh, engine.cellValueFromBody(body, type, SS) !== '', `engine 自洽 type=${type} body="${body}"`);
    }
  });

  test('xmlUnescape 与 reader-handrolled 暴露的实体解码一致（经 cellValueFromBody 数字位）', () => {
    // 通过 number cell 走 xmlUnescape 路径对照
    const samples = ['a&amp;b', '&lt;&gt;', '&quot;&apos;', '&#65;&#x4a;', 'no-entity', '&amp;&amp;'];
    for (const s of samples) {
      const body = `<v>${s}</v>`;
      assert.equal(engine.cellValueFromBody(body, 'n', SS), hand.cellValueFromBody(body, 'n', SS), `实体解码不一致 "${s}"`);
    }
  });
});
