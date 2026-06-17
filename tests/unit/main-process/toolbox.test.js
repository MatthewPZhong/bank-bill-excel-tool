// v3.0.8 需求1：工具箱🧰（合表 / 拆表）核心纯逻辑单测
//
// 覆盖 src/main-process/toolbox.js 的纯变换函数（不碰 Electron / 文件 IO）：
//   formatTimestamp12       12 位时间戳 YYYYMMDDHHmm（24 小时制，补零）
//   assertHeadersIdentical  合表表头一致性校验（全等 + 不一致抛 ToolboxHeaderMismatchError 带 detailLines）
//   mergeAoaRows            多文件 aoa 合并 = [首表头, ...各文件数据行（切表头）]
//   computeValuesByField    各字段去重值（normalize + 去重 + 首现序）
//   filterRowsByFieldValues 按字段值过滤（多选值→单结果，含命中任一值的行）
//   buildMergeFileName / buildSplitFileName  文件名模板（带 12 位时间戳 + sanitize）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ToolboxHeaderMismatchError,
  formatTimestamp12,
  assertHeadersIdentical,
  mergeAoaRows,
  computeValuesByField,
  filterRowsByFieldValues,
  createValuesByFieldAccumulator,
  createRowFilter,
  buildMergeFileName,
  buildSplitFileName
} = require('../../../src/main-process/toolbox');

// 复刻 main.js sanitizeFileName（line 456）—— 单测注入等价实现验证文件名拼接
function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

test.describe('formatTimestamp12', () => {
  test('YYYYMMDDHHmm 12 位（补零，24 小时制）', () => {
    const ts = formatTimestamp12(new Date(2026, 0, 2, 3, 4)); // 2026-01-02 03:04
    assert.equal(ts, '202601020304');
    assert.equal(ts.length, 12);
  });

  test('下午时间用 24 小时制（21:09 → 2109 不是 0909）', () => {
    const ts = formatTimestamp12(new Date(2026, 11, 31, 21, 9)); // 2026-12-31 21:09
    assert.equal(ts, '202612312109');
  });

  test('始终 12 位数字字符串', () => {
    const ts = formatTimestamp12(new Date());
    assert.match(ts, /^\d{12}$/);
  });
});

test.describe('assertHeadersIdentical', () => {
  test('全部相同 → 返回基准表头副本（不抛）', () => {
    const base = assertHeadersIdentical([['A', 'B', 'C'], ['A', 'B', 'C']], ['f1.xlsx', 'f2.xlsx']);
    assert.deepEqual(base, ['A', 'B', 'C']);
  });

  test('单文件 → 返回其表头（不抛）', () => {
    assert.deepEqual(assertHeadersIdentical([['A', 'B']], ['only.xlsx']), ['A', 'B']);
  });

  test('列序不同 → 抛 ToolboxHeaderMismatchError（顺序敏感）', () => {
    assert.throws(
      () => assertHeadersIdentical([['A', 'B'], ['B', 'A']], ['f1.xlsx', 'f2.xlsx']),
      ToolboxHeaderMismatchError
    );
  });

  test('大小写不同 → 抛（大小写敏感）', () => {
    assert.throws(
      () => assertHeadersIdentical([['A', 'B'], ['A', 'b']], ['f1.xlsx', 'f2.xlsx']),
      ToolboxHeaderMismatchError
    );
  });

  test('列数不同 → 抛', () => {
    assert.throws(
      () => assertHeadersIdentical([['A', 'B'], ['A', 'B', 'C']], ['f1.xlsx', 'f2.xlsx']),
      ToolboxHeaderMismatchError
    );
  });

  test('抛错携带不一致文件名 + detailLines（前端 alert 用）', () => {
    try {
      assertHeadersIdentical([['A', 'B'], ['A', 'X']], ['base.xlsx', 'bad.xlsx']);
      assert.fail('应抛 ToolboxHeaderMismatchError');
    } catch (err) {
      assert.ok(err instanceof ToolboxHeaderMismatchError);
      assert.match(err.message, /bad\.xlsx/);
      assert.match(err.message, /base\.xlsx/);
      assert.ok(Array.isArray(err.detailLines) && err.detailLines.length >= 2);
    }
  });

  test('空表头列表 → 抛（无文件可合并）', () => {
    assert.throws(() => assertHeadersIdentical([], []), ToolboxHeaderMismatchError);
  });

  test('ToolboxHeaderMismatchError 是 Error 子类且 name 正确（handler 据 name 判定）', () => {
    const err = new ToolboxHeaderMismatchError('x', ['l1']);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ToolboxHeaderMismatchError');
    assert.deepEqual(err.detailLines, ['l1']);
  });
});

test.describe('mergeAoaRows', () => {
  test('双文件合并 = [首表头, ...各文件数据行]（切掉各自表头行）', () => {
    const a = [['H1', 'H2'], ['a1', 'a2'], ['a3', 'a4']];
    const b = [['H1', 'H2'], ['b1', 'b2']];
    const merged = mergeAoaRows([a, b]);
    assert.deepEqual(merged, [['H1', 'H2'], ['a1', 'a2'], ['a3', 'a4'], ['b1', 'b2']]);
  });

  test('合并行数 = 各文件数据行之和 + 1 表头行', () => {
    const a = [['H'], ['1'], ['2'], ['3']]; // 3 数据行
    const b = [['H'], ['4'], ['5']]; // 2 数据行
    const merged = mergeAoaRows([a, b]);
    assert.equal(merged.length, 1 + 3 + 2);
    assert.equal(merged.length - 1, 5, '数据行 = 3 + 2');
  });

  test('表头唯一（只取首文件表头一次，不重复各文件表头）', () => {
    const a = [['H1', 'H2'], ['a1', 'a2']];
    const b = [['H1', 'H2'], ['b1', 'b2']];
    const merged = mergeAoaRows([a, b]);
    const headerOccurrences = merged.filter((r) => r[0] === 'H1' && r[1] === 'H2').length;
    assert.equal(headerOccurrences, 1, '表头行只出现一次');
  });

  test('单文件 → 原样（表头 + 其数据行）', () => {
    const a = [['H'], ['x'], ['y']];
    assert.deepEqual(mergeAoaRows([a]), [['H'], ['x'], ['y']]);
  });

  test('某文件只有表头无数据行 → 只贡献 0 数据行', () => {
    const a = [['H'], ['x']];
    const b = [['H']]; // 仅表头
    const merged = mergeAoaRows([a, b]);
    assert.deepEqual(merged, [['H'], ['x']]);
  });

  test('空列表 → []', () => {
    assert.deepEqual(mergeAoaRows([]), []);
  });

  test('合并结果是行副本（不与源 aoa 共享引用）', () => {
    const a = [['H'], ['x']];
    const merged = mergeAoaRows([a]);
    merged[1][0] = 'MUTATED';
    assert.equal(a[1][0], 'x', '改 merged 不影响源 aoa');
  });
});

test.describe('computeValuesByField', () => {
  test('各字段去重值 + 首现序', () => {
    const headers = ['H1', 'H2'];
    const aoa = [['H1', 'H2'], ['x', '1'], ['y', '1'], ['x', '2']];
    const vbf = computeValuesByField(headers, aoa);
    assert.deepEqual(vbf.H1, ['x', 'y']);
    assert.deepEqual(vbf.H2, ['1', '2']);
  });

  test('normalize（trim）后去重（" x " 与 "x" 视为同值）', () => {
    const vbf = computeValuesByField(['H'], [['H'], [' x '], ['x'], ['x ']]);
    assert.deepEqual(vbf.H, ['x']);
  });

  test('空串不计入去重值', () => {
    const vbf = computeValuesByField(['H'], [['H'], [''], ['  '], ['a'], [null], ['b']]);
    assert.deepEqual(vbf.H, ['a', 'b']);
  });

  test('全空列 → 空数组（前端该字段多选下拉为空）', () => {
    const vbf = computeValuesByField(['H1', 'H2'], [['H1', 'H2'], ['a', ''], ['b', '']]);
    assert.deepEqual(vbf.H1, ['a', 'b']);
    assert.deepEqual(vbf.H2, []);
  });

  test('每个表头都有 key（即使无值也是空数组）', () => {
    const vbf = computeValuesByField(['H1', 'H2', 'H3'], [['H1', 'H2', 'H3']]);
    assert.deepEqual(Object.keys(vbf).sort(), ['H1', 'H2', 'H3']);
    assert.deepEqual(vbf.H1, []);
  });
});

test.describe('filterRowsByFieldValues', () => {
  test('单值过滤 → [表头, ...命中行]', () => {
    const aoa = [['H1', 'H2'], ['x', '1'], ['y', '2'], ['x', '3']];
    const res = filterRowsByFieldValues(aoa, 'H1', ['x']);
    assert.equal(res.fieldFound, true);
    assert.equal(res.matchedCount, 2);
    assert.deepEqual(res.rows, [['H1', 'H2'], ['x', '1'], ['x', '3']]);
  });

  test('多选值 → 单结果（含命中任一值的行）', () => {
    const aoa = [['C'], ['a'], ['b'], ['c'], ['a']];
    const res = filterRowsByFieldValues(aoa, 'C', ['a', 'c']);
    assert.equal(res.matchedCount, 3);
    assert.deepEqual(res.rows, [['C'], ['a'], ['c'], ['a']]);
  });

  test('值按 normalize 比对命中（" a " 选项命中 "a" 单元格）', () => {
    const aoa = [['C'], ['a'], ['b']];
    const res = filterRowsByFieldValues(aoa, 'C', [' a ']);
    assert.equal(res.matchedCount, 1);
  });

  test('命中 0 行 → matchedCount=0，rows 仅表头', () => {
    const aoa = [['C'], ['a'], ['b']];
    const res = filterRowsByFieldValues(aoa, 'C', ['zzz']);
    assert.equal(res.matchedCount, 0);
    assert.deepEqual(res.rows, [['C']]);
  });

  test('字段不在表头 → fieldFound=false（handler 据此回 failed）', () => {
    const aoa = [['C'], ['a']];
    const res = filterRowsByFieldValues(aoa, 'NOPE', ['a']);
    assert.equal(res.fieldFound, false);
    assert.equal(res.matchedCount, 0);
  });

  test('按列索引定位（同名字段取第一处列；非首列字段也能命中）', () => {
    const aoa = [['H1', 'H2'], ['x', 'keep'], ['y', 'drop']];
    const res = filterRowsByFieldValues(aoa, 'H2', ['keep']);
    assert.equal(res.matchedCount, 1);
    assert.deepEqual(res.rows[1], ['x', 'keep']);
  });
});

// v3.0.8 BUG3：流式增量版必须与全量版口径完全一致（逐行 feed 接口 vs 全量 aoa）。
test.describe('createValuesByFieldAccumulator（流式去重，口径同 computeValuesByField）', () => {
  test('逐行 feed 结果 ≡ 全量 computeValuesByField', () => {
    const headers = ['H1', 'H2'];
    const dataRows = [['x', '1'], ['y', '1'], ['x', '2'], [' x ', '2'], ['', '3']];
    const acc = createValuesByFieldAccumulator(headers);
    dataRows.forEach((r) => acc.addRow(r));
    const streamed = acc.result();
    // 与全量版（aoa 含表头行）对拍
    const full = computeValuesByField(headers, [headers, ...dataRows]);
    assert.deepEqual(streamed, full);
    assert.deepEqual(streamed.H1, ['x', 'y'], 'trim 去重 + 首现序');
    assert.deepEqual(streamed.H2, ['1', '2', '3']);
  });

  test('空串不计 + 每个表头都有 key', () => {
    const acc = createValuesByFieldAccumulator(['H1', 'H2', 'H3']);
    acc.addRow(['a', '', 'z']);
    acc.addRow(['b', '   ', 'z']);
    const res = acc.result();
    assert.deepEqual(res.H1, ['a', 'b']);
    assert.deepEqual(res.H2, [], '全空列空数组');
    assert.deepEqual(res.H3, ['z'], '重复值去重');
    assert.deepEqual(Object.keys(res).sort(), ['H1', 'H2', 'H3']);
  });

  test('非数组行安全跳过', () => {
    const acc = createValuesByFieldAccumulator(['H']);
    acc.addRow(null);
    acc.addRow(undefined);
    acc.addRow(['a']);
    assert.deepEqual(acc.result().H, ['a']);
  });
});

test.describe('createRowFilter（流式过滤，口径同 filterRowsByFieldValues）', () => {
  test('命中行 ≡ 全量 filterRowsByFieldValues 的 matchedCount/内容', () => {
    const headers = ['H1', 'H2'];
    const dataRows = [['x', '1'], ['y', '2'], ['x', '3']];
    const f = createRowFilter(headers, 'H1', ['x']);
    assert.equal(f.fieldFound, true);
    const matched = dataRows.filter((r) => f.matches(r));
    // 全量对拍
    const full = filterRowsByFieldValues([headers, ...dataRows], 'H1', ['x']);
    assert.equal(matched.length, full.matchedCount);
    assert.deepEqual(matched, full.rows.slice(1));
  });

  test('多选值 + normalize 比对命中（" a " 选项命中 "a" 单元格）', () => {
    const f = createRowFilter(['C'], 'C', [' a ', 'c']);
    assert.equal(f.matches(['a']), true);
    assert.equal(f.matches(['c']), true);
    assert.equal(f.matches(['b']), false);
  });

  test('字段不在表头 → fieldFound=false，matches 恒 false', () => {
    const f = createRowFilter(['C'], 'NOPE', ['a']);
    assert.equal(f.fieldFound, false);
    assert.equal(f.matches(['a']), false);
  });

  test('非首列字段也能定位命中', () => {
    const f = createRowFilter(['H1', 'H2'], 'H2', ['keep']);
    assert.equal(f.colIdx, 1);
    assert.equal(f.matches(['x', 'keep']), true);
    assert.equal(f.matches(['x', 'drop']), false);
  });
});

test.describe('buildMergeFileName / buildSplitFileName', () => {
  test('合并文件名 = 合并-YYYYMMDDHHmm.xlsx', () => {
    const name = buildMergeFileName(new Date(2026, 0, 2, 3, 4));
    assert.equal(name, '合并-202601020304.xlsx');
    assert.match(name, /^合并-\d{12}\.xlsx$/);
  });

  test('拆分文件名 = 拆分-{值拼接 sanitize}-YYYYMMDDHHmm.xlsx', () => {
    const name = buildSplitFileName(['VAL'], sanitizeFileName, new Date(2026, 0, 2, 3, 4));
    assert.equal(name, '拆分-VAL-202601020304.xlsx');
    assert.match(name, /^拆分-.+-\d{12}\.xlsx$/);
  });

  test('多值用 _ 拼接', () => {
    const name = buildSplitFileName(['a', 'b'], sanitizeFileName, new Date(2026, 0, 2, 3, 4));
    assert.equal(name, '拆分-a_b-202601020304.xlsx');
  });

  test('非法字符经 sanitizeFileName 去除（/ : * → -）', () => {
    const name = buildSplitFileName(['a/b', 'c:d'], sanitizeFileName, new Date(2026, 0, 2, 3, 4));
    assert.match(name, /^拆分-.+-\d{12}\.xlsx$/);
    assert.ok(!name.includes('/'), '不含非法 /');
    assert.ok(!name.includes(':'), '不含非法 :');
  });

  test('超长拼接截断（≤80 字符值段）', () => {
    const longVals = Array.from({ length: 50 }, (_v, i) => `value${i}`);
    const name = buildSplitFileName(longVals, sanitizeFileName, new Date(2026, 0, 2, 3, 4));
    // 提取「拆分-」与「-时间戳.xlsx」之间的值段
    const m = name.match(/^拆分-(.+)-\d{12}\.xlsx$/);
    assert.ok(m, '文件名匹配模板');
    assert.ok(m[1].length <= 80, '值段截断到 ≤80 字符');
  });

  test('全空值 → 兜底「子集」', () => {
    const name = buildSplitFileName(['', '  '], sanitizeFileName, new Date(2026, 0, 2, 3, 4));
    assert.equal(name, '拆分-子集-202601020304.xlsx');
  });
});
