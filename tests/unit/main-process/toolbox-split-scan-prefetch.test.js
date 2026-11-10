'use strict';

// 元数据扫描顺带预取字段可选值：完整收集的字段必须与单独 scanSplitFieldValues 的结果完全一致；
// 超出单字段数量 / 字节或合计字节上限的字段整列放弃，留给单独扫描。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanSplitMetadata, scanSplitFieldValues } = require('../../../src/main-process/toolbox-split-scan');

function csvFixture(t, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-prefetch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'input.csv');
  fs.writeFileSync(filePath, text);
  return filePath;
}

const ROWS = [
  '商户,币种,备注,空列',
  'NET001, CNY ,a,',
  'NET002,USD,b,',
  ',CNY,c,',
  'NET001,USD,d,',
  'NET003,CNY,e,'
].join('\n');

test('不传取值预算时元数据结果不含预取字段', async (t) => {
  const filePath = csvFixture(t, ROWS);
  const result = await scanSplitMetadata(filePath, {});
  assert.deepEqual(result, { headers: ['商户', '币种', '备注', '空列'], dataRowCount: 5 });
});

test('完整预取的字段与单独扫描一致，超出单字段数量上限的字段被放弃', async (t) => {
  const filePath = csvFixture(t, ROWS);
  const budget = { maxValues: 3, maxValueBytes: 1024 * 1024 };
  const result = await scanSplitMetadata(filePath, budget);
  assert.deepEqual(result.headers, ['商户', '币种', '备注', '空列']);
  assert.equal(result.dataRowCount, 5);
  const prefetched = new Map(result.prefetchedValues);
  // 备注有 5 个不同值，超过上限 3，整列放弃
  assert.deepEqual([...prefetched.keys()], ['商户', '币种', '空列']);
  for (const [field, values] of prefetched) {
    const single = await scanSplitFieldValues(filePath, field, budget);
    assert.deepEqual(values, single.values, field);
  }
  await assert.rejects(scanSplitFieldValues(filePath, '备注', budget), { code: 'TOOLBOX_SPLIT_VALUES_BUDGET_EXCEEDED' });
});

test('单字段字节上限与合计字节上限超出时放弃对应字段', async (t) => {
  const filePath = csvFixture(t, ROWS);
  // 每个短值计费 64 + 字节数；商户三值约 216 字节，币种两值约 140 字节，合计上限 300 只容得下先满的一列
  const result = await scanSplitMetadata(filePath, { maxValues: 100, maxValueBytes: 300 });
  const prefetched = new Map(result.prefetchedValues);
  assert.equal(prefetched.has('备注'), false);
  assert.equal(prefetched.size < 3, true);
  for (const [field, values] of prefetched) {
    const single = await scanSplitFieldValues(filePath, field, { maxValues: 100, maxValueBytes: 300 });
    assert.deepEqual(values, single.values, field);
  }
});
