// v3.0.9 子任务 T2：有界去重累加器单测
//
// 覆盖 src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js：
//   - 某列恰好 N 个去重值 → 不截断、全保留
//   - 某列 N+1 个 → 截断到前 N，且截断后再喂大量该列行内存不增（result 长度恒 = N、Set 已丢弃）
//   - 首现序保持
//   - merge 合并去重 + 顺序正确（遵守 N 上限 + 首现序）
//   - 全局 maxTotalDistinct 闸生效（病态宽表防护）
//   - 🚩 契约锁：result() 返回值不含 truncated / distinctSeen 字段（前端零改动）
//   - 空串 / 纯空白不计入
//   - 归一化口径与 toolbox.js 现状一致（trim、null/undefined→''）
//
// 阈值通过 options 注入小值以便断言截断行为（生产默认 N=1000 / maxTotalDistinct=200000）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBoundedValuesAccumulator,
  DEFAULT_MAX_DISTINCT_PER_FIELD,
  DEFAULT_MAX_TOTAL_DISTINCT
} = require('../../../../src/backend/toolbox-xlsx-stream/bounded-values-accumulator');

// 喂 n 行：第 col 列值为 prefix+0..n-1（各行其余列空），制造单列 n 个去重值。
function feedDistinctValues(acc, colIdx, totalCols, count, prefix = 'v') {
  for (let i = 0; i < count; i += 1) {
    const row = new Array(totalCols).fill('');
    row[colIdx] = `${prefix}${i}`;
    acc.addRow(row);
  }
}

test.describe('默认阈值导出', () => {
  test('N=1000 / maxTotalDistinct=200000', () => {
    assert.equal(DEFAULT_MAX_DISTINCT_PER_FIELD, 1000);
    assert.equal(DEFAULT_MAX_TOTAL_DISTINCT, 200000);
  });
});

test.describe('每列封顶 N', () => {
  test('恰好 N 个去重值 → 不截断、全保留', () => {
    const N = 5;
    const acc = createBoundedValuesAccumulator({ maxDistinctPerField: N });
    acc.setHeaders(['A', 'B']);
    feedDistinctValues(acc, 0, 2, N); // A 列恰好 5 个去重值

    const result = acc.result();
    assert.equal(result.A.length, N, 'A 列应保留全部 N 个');
    assert.deepEqual(result.A, ['v0', 'v1', 'v2', 'v3', 'v4']);
    // 恰好 N 时 collectValue 在第 N 个值放入后即触发封顶（length>=N），属于「全保留 + 标记封顶」边界，
    // 这是预期：前 N 个全保留，后续若有新值才被丢弃。
  });

  test('N+1 个去重值 → 截断到前 N（首现序）', () => {
    const N = 5;
    const acc = createBoundedValuesAccumulator({ maxDistinctPerField: N });
    acc.setHeaders(['A']);
    feedDistinctValues(acc, 0, 1, N + 1); // 6 个去重值

    const result = acc.result();
    assert.equal(result.A.length, N, '应截断到前 N');
    assert.deepEqual(result.A, ['v0', 'v1', 'v2', 'v3', 'v4'], '保留首现的前 N 个，丢弃第 N+1 个');
  });

  test('截断后再喂大量该列行 → result 长度恒 = N（内存不增：Set 已丢弃）', () => {
    const N = 10;
    const acc = createBoundedValuesAccumulator({ maxDistinctPerField: N });
    acc.setHeaders(['A']);
    feedDistinctValues(acc, 0, 1, N); // 先放满 N 个（v0..v9）

    // 已封顶：内部 Set 应被丢弃（truncatedFields 含 A），后续大量新值不再收集。
    const statsAfterFull = acc.getInternalStats();
    assert.ok(statsAfterFull.truncatedFields.includes('A'), '放满 N 后该列应已封顶');

    // 再喂 100000 个全新去重值（模拟超高基数列后续行）。
    feedDistinctValues(acc, 0, 1, 100000, 'after');

    const result = acc.result();
    assert.equal(result.A.length, N, '截断后 result 长度必须恒 = N，不随后续行增长');
    assert.deepEqual(result.A, ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
    // distinctSeen 也不应继续增长（该列 collectValue 提前 return）。
    assert.equal(acc.getInternalStats().distinctSeen, N, '封顶后不再累加去重总数');
  });

  test('多列各自独立封顶：高基数列截断、低基数列全保留', () => {
    const N = 3;
    const acc = createBoundedValuesAccumulator({ maxDistinctPerField: N });
    acc.setHeaders(['low', 'high']);
    // low 列 2 个去重值（不截断），high 列 10 个（截断到 3）。
    for (let i = 0; i < 10; i += 1) {
      acc.addRow([`L${i % 2}`, `H${i}`]);
    }
    const result = acc.result();
    assert.deepEqual(result.low, ['L0', 'L1'], 'low 列全保留');
    assert.equal(result.high.length, N, 'high 列截断到 N');
    assert.deepEqual(result.high, ['H0', 'H1', 'H2']);
  });
});

test.describe('首现序', () => {
  test('去重保留首次出现顺序（非排序、非末现）', () => {
    const acc = createBoundedValuesAccumulator();
    acc.setHeaders(['ch']);
    ['gateway', 'wallet', 'gateway', 'bank', 'wallet', 'bank'].forEach((v) => acc.addRow([v]));
    assert.deepEqual(acc.result().ch, ['gateway', 'wallet', 'bank'], '按首现序，不重排');
  });
});

test.describe('空串 / 纯空白不计入', () => {
  test('null / undefined / 空串 / 纯空白（trim 后空）跳过', () => {
    const acc = createBoundedValuesAccumulator();
    acc.setHeaders(['x']);
    acc.addRow([null]);
    acc.addRow([undefined]);
    acc.addRow(['']);
    acc.addRow(['   ']);
    acc.addRow(['\t\n ']);
    acc.addRow(['real']);
    acc.addRow(['  trimmed  ']); // 前后空白被 trim
    const result = acc.result();
    assert.deepEqual(result.x, ['real', 'trimmed'], '空白值跳过、值被 trim');
  });

  test('数字 / 其它类型按 String(value).trim() 归一', () => {
    const acc = createBoundedValuesAccumulator();
    acc.setHeaders(['n']);
    acc.addRow([123]);
    acc.addRow([123]); // 与上一行去重（String 后相同）
    acc.addRow([' 456 ']);
    assert.deepEqual(acc.result().n, ['123', '456']);
  });

  test('addRow 非数组 / 空行不报错', () => {
    const acc = createBoundedValuesAccumulator();
    acc.setHeaders(['a']);
    acc.addRow(null);
    acc.addRow(undefined);
    acc.addRow([]);
    assert.deepEqual(acc.result().a, []);
  });
});

test.describe('同名表头列索引覆盖（与 toolbox.js 现状一致）', () => {
  test('重复同名表头 → 后者覆盖前者的列索引', () => {
    const acc = createBoundedValuesAccumulator();
    acc.setHeaders(['dup', 'dup']); // 同名，列索引 0 与 1，后者（1）覆盖
    acc.addRow(['col0', 'col1']);
    // 单键 dup，取覆盖后的列索引 1 → 'col1'
    assert.deepEqual(acc.result().dup, ['col1']);
  });
});

test.describe('全局 maxTotalDistinct 闸', () => {
  test('跨所有列去重总数达上限 → 停止所有列新增', () => {
    // maxTotalDistinct=5，每列 N 设大（不让单列先封顶），3 列各喂不同值，总数到 5 即停。
    const acc = createBoundedValuesAccumulator({
      maxDistinctPerField: 1000,
      maxTotalDistinct: 5
    });
    acc.setHeaders(['a', 'b', 'c']);
    // 第 1 行：a1,b1,c1 → 总数 3；第 2 行：a2,b2,c2 → a2(4) b2(5) 触顶，c2 不再收集。
    acc.addRow(['a1', 'b1', 'c1']);
    acc.addRow(['a2', 'b2', 'c2']);
    // 后续行整体被丢弃。
    acc.addRow(['a3', 'b3', 'c3']);

    const result = acc.result();
    const total = result.a.length + result.b.length + result.c.length;
    assert.equal(total, 5, '全局去重总数封顶在 maxTotalDistinct');
    assert.ok(acc.getInternalStats().totalCapReached, '全局兜底应已触发');
    // 触顶前已收集的保持首现序。
    assert.deepEqual(result.a, ['a1', 'a2']);
    assert.deepEqual(result.b, ['b1', 'b2']);
    assert.deepEqual(result.c, ['c1'], 'c 在第 2 行触顶前只收到 c1');
  });
});

test.describe('merge 合并', () => {
  test('合并另一累加器：去重 + 首现序（本累加器现状在前，other 追加未见值）', () => {
    const a = createBoundedValuesAccumulator();
    a.setHeaders(['ch']);
    ['gateway', 'wallet'].forEach((v) => a.addRow([v]));

    const b = createBoundedValuesAccumulator();
    b.setHeaders(['ch']);
    ['wallet', 'bank', 'gateway', 'card'].forEach((v) => b.addRow([v]));

    a.merge(b);
    // a 原有 gateway,wallet；b 追加未见的 bank,card（wallet/gateway 已去重）。
    assert.deepEqual(a.result().ch, ['gateway', 'wallet', 'bank', 'card']);
  });

  test('merge 接受裸 { field: string[] } 快照', () => {
    const a = createBoundedValuesAccumulator();
    a.setHeaders(['x']);
    a.addRow(['p']);
    a.merge({ x: ['p', 'q', '  q  ', 'r'] }); // p 去重、q 去重（trim 后同）、r 新增
    assert.deepEqual(a.result().x, ['p', 'q', 'r']);
  });

  test('merge 遵守 N 上限', () => {
    const N = 3;
    const a = createBoundedValuesAccumulator({ maxDistinctPerField: N });
    a.setHeaders(['x']);
    a.addRow(['a']);
    a.addRow(['b']);
    a.merge({ x: ['c', 'd', 'e'] }); // a,b,c → 满 3，d/e 丢弃
    assert.equal(a.result().x.length, N);
    assert.deepEqual(a.result().x, ['a', 'b', 'c']);
  });

  test('merge 未知列动态新增', () => {
    const a = createBoundedValuesAccumulator();
    a.setHeaders(['x']);
    a.addRow(['1']);
    a.merge({ y: ['2', '3'] }); // y 列原本不存在
    assert.deepEqual(a.result().x, ['1']);
    assert.deepEqual(a.result().y, ['2', '3']);
  });

  test('merge(null / 非对象) 安全无操作', () => {
    const a = createBoundedValuesAccumulator();
    a.setHeaders(['x']);
    a.addRow(['1']);
    a.merge(null);
    a.merge(undefined);
    a.merge(42);
    assert.deepEqual(a.result().x, ['1']);
  });
});

test.describe('🚩 契约锁：result() 不含截断元数据（前端零改动）', () => {
  test('result() 只回 { field: string[] }，无 truncated / distinctSeen / totalCapReached 字段', () => {
    const N = 2;
    const acc = createBoundedValuesAccumulator({ maxDistinctPerField: N });
    acc.setHeaders(['A', 'B']);
    // 制造截断 + 全局统计，确保即便内部有元数据也绝不外泄。
    feedDistinctValues(acc, 0, 2, 50); // A 列截断
    acc.addRow(['', 'b1']);

    const result = acc.result();

    // 仅有表头键。
    assert.deepEqual(Object.keys(result).sort(), ['A', 'B']);
    // 绝不含任何截断 / 统计元数据键。
    for (const forbidden of [
      'truncated',
      'truncatedFields',
      'distinctSeen',
      'totalCapReached',
      'maxDistinctPerField',
      'maxTotalDistinct'
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(result, forbidden),
        false,
        `result() 不得含 ${forbidden} 字段`
      );
    }
    // 每个值都是纯 string[]。
    for (const field of Object.keys(result)) {
      assert.ok(Array.isArray(result[field]), `${field} 必须是数组`);
      result[field].forEach((v) => assert.equal(typeof v, 'string', `${field} 元素必须是 string`));
    }
  });

  test('与现状 createValuesByFieldAccumulator.result() 结构同构（同 ≤N 输入下逐字节一致）', () => {
    // 去重值 ≤N 时，本模块输出应与现状无界累加器逐字节一致（小文件零回归的基础）。
    const {
      createValuesByFieldAccumulator
    } = require('../../../../src/main-process/toolbox');

    const headers = ['渠道', '币种', '状态'];
    const rows = [
      ['gateway', 'CNY', 'success'],
      ['wallet', 'USD', 'pending'],
      ['gateway', 'CNY', 'success'],
      ['bank', 'HKD', 'success'],
      ['', '', ''], // 空行
      ['wallet', 'JPY', 'failed']
    ];

    const legacy = createValuesByFieldAccumulator(headers);
    rows.forEach((r) => legacy.addRow(r));

    const bounded = createBoundedValuesAccumulator();
    bounded.setHeaders(headers);
    rows.forEach((r) => bounded.addRow(r));

    // JSON.stringify 逐字节比对（键顺序由 headers 顺序决定，两者一致）。
    assert.equal(
      JSON.stringify(bounded.result()),
      JSON.stringify(legacy.result()),
      '去重值 ≤N 时本模块与现状无界累加器 result() 必须逐字节一致'
    );
  });
});

test.describe('setHeaders 重复调用重置', () => {
  test('再次 setHeaders 重置已收集状态', () => {
    const acc = createBoundedValuesAccumulator();
    acc.setHeaders(['old']);
    acc.addRow(['v']);
    acc.setHeaders(['new']);
    acc.addRow(['w']);
    const result = acc.result();
    assert.deepEqual(Object.keys(result), ['new']);
    assert.deepEqual(result.new, ['w']);
  });
});

test('__proto__ 表头在 Worker 有界累加器中保持 own key', () => {
  const acc = createBoundedValuesAccumulator();
  acc.setHeaders(['__proto__']);
  acc.addRow(['PAYPAL']);
  const result = acc.result();
  assert.equal(Object.prototype.hasOwnProperty.call(result, '__proto__'), true);
  assert.deepEqual(result.__proto__, ['PAYPAL']);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).__proto__, ['PAYPAL']);
});
