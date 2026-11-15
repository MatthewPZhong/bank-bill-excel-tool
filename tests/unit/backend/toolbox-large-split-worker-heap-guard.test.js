// 工具箱拆分 Worker 堆监控阈值：按本 Worker 实际堆上限换算，旧 4 GB 通道仍为 3 GB。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HEAP_USED_LIMIT_BYTES,
  heapUsedLimitFor,
  ToolboxWorkerMemoryLimitError
} = require('../../../src/backend/toolbox-xlsx-stream/large-split-worker');

const MiB = 1024 ** 2;

test('4096 MB 旧导出通道的监控阈值仍为 3 GB', () => {
  assert.equal(heapUsedLimitFor(4096 * MiB), HEAP_USED_LIMIT_BYTES);
});

test('获批读取档（460 / 153 MB）的阈值落在堆上限之内，监控能先于 V8 强杀触发', () => {
  for (const limitMb of [460, 153]) {
    const threshold = heapUsedLimitFor(limitMb * MiB);
    assert.equal(threshold, Math.floor(limitMb * MiB * 0.9));
    assert.ok(threshold < limitMb * MiB);
  }
});

test('取不到有效堆上限时退回 3 GB 固定阈值', () => {
  for (const value of [undefined, 0, -1, Number.NaN]) assert.equal(heapUsedLimitFor(value), HEAP_USED_LIMIT_BYTES);
});

test('内存上限提示按实际上限显示，不足 1 GB 用 MB', () => {
  const small = new ToolboxWorkerMemoryLimitError(420 * MiB, heapUsedLimitFor(460 * MiB));
  assert.equal(small.message, '文件数据量过大，超出处理能力');
  assert.match(small.detailLines[0], /约 420 MB，超出当前拆分通道的处理上限（约 414 MB）/);

  const large = new ToolboxWorkerMemoryLimitError(3.2 * 1024 * MiB);
  assert.match(large.detailLines[0], /约 3\.20 GB，超出当前拆分通道的处理上限（约 3\.00 GB）/);
});
