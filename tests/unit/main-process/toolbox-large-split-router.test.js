// v3.0.9 T5 — 工具箱「按字段值拆分」大文件隔离 worker 通道路由单测
//
// 覆盖 src/main-process/toolbox-large-split-router.js 的 shouldUseLargeChannel(filePath)：
//   判定：.xlsx 且（worksheet 数 ≥2 或 单 worksheet 解压尺寸 ≥1.5GB）→ true（大通道）；
//   fail-closed：非 .xlsx / 单 sheet 小文件 / collectEntrySizes 抛异常 → false（普通通道）。
//
// 两类用例：
//   A) mock collectEntrySizes 返回不同 Map（精确控制 worksheet 数与解压尺寸，含无法真实造的 ≥1.5GB）；
//   B) 真实夹具回归：SheetJS 程序生成真实 .xlsx，不 mock，端到端验证 router 与真实 collectEntrySizes 接缝。
//
// 🔴 关键回归锁：单 sheet 小文件必须 false（保普通通道零回归，AC1-3）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

// router 通过模块对象调用 sizePreflight.collectEntrySizes，故此处覆盖同一模块对象的属性即可拦截。
const sizePreflight = require('../../../src/backend/pending-import/xlsx-size-preflight');
const router = require('../../../src/main-process/toolbox-large-split-router');
const { shouldUseLargeChannel, SINGLE_WORKSHEET_LARGE_BYTES } = router;

const SS = 'xl/sharedStrings.xml';
const realCollectEntrySizes = sizePreflight.collectEntrySizes;

// 用给定 Map 覆盖 collectEntrySizes；返回还原函数。
function stubSizes(map) {
  sizePreflight.collectEntrySizes = async () => map;
  return () => { sizePreflight.collectEntrySizes = realCollectEntrySizes; };
}

// 让 collectEntrySizes 抛异常；返回还原函数。
function stubThrow(err) {
  sizePreflight.collectEntrySizes = async () => { throw err; };
  return () => { sizePreflight.collectEntrySizes = realCollectEntrySizes; };
}

// 每个用例后兜底还原（即便用例内忘了还原也不污染后续）。
test.afterEach(() => {
  sizePreflight.collectEntrySizes = realCollectEntrySizes;
});

// ---- A 组：mock collectEntrySizes 控制 Map ----

test('常量自检：阈值 = 1.5GB（1610612736）', () => {
  assert.equal(SINGLE_WORKSHEET_LARGE_BYTES, 1610612736);
});

test('🔴 单 sheet 小 .xlsx → false（关键回归锁：普通通道零回归）', async () => {
  const restore = stubSizes(new Map([
    [SS, 2048],
    ['xl/worksheets/sheet1.xml', 50000]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/small.xlsx'), false);
  } finally {
    restore();
  }
});

test('多 sheet（2 worksheet）.xlsx → true（大通道）', async () => {
  const restore = stubSizes(new Map([
    [SS, 4096],
    ['xl/worksheets/sheet1.xml', 50000],
    ['xl/worksheets/sheet2.xml', 60000]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/multi.xlsx'), true);
  } finally {
    restore();
  }
});

test('多 sheet（3 worksheet）小尺寸 .xlsx → true（worksheet 数优先于尺寸）', async () => {
  const restore = stubSizes(new Map([
    [SS, 1024],
    ['xl/worksheets/sheet1.xml', 100],
    ['xl/worksheets/sheet2.xml', 100],
    ['xl/worksheets/sheet3.xml', 100]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/three.xlsx'), true);
  } finally {
    restore();
  }
});

test('单 worksheet 解压 = 1.5GB（恰等阈值，≥）→ true', async () => {
  const restore = stubSizes(new Map([
    [SS, 4096],
    ['xl/worksheets/sheet1.xml', SINGLE_WORKSHEET_LARGE_BYTES]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/big.xlsx'), true);
  } finally {
    restore();
  }
});

test('单 worksheet 解压 > 1.5GB → true', async () => {
  const restore = stubSizes(new Map([
    [SS, 4096],
    ['xl/worksheets/sheet1.xml', SINGLE_WORKSHEET_LARGE_BYTES + 1]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/big.xlsx'), true);
  } finally {
    restore();
  }
});

test('单 worksheet 解压 < 1.5GB（阈值 -1）→ false', async () => {
  const restore = stubSizes(new Map([
    [SS, 4096],
    ['xl/worksheets/sheet1.xml', SINGLE_WORKSHEET_LARGE_BYTES - 1]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/justunder.xlsx'), false);
  } finally {
    restore();
  }
});

// ---- codex P2：单 sheet 但 sharedStrings 超阈值也走大通道 ----

test('常量自检：sharedStrings 阈值 = 1.2GB（1288490188）', () => {
  assert.equal(router.SHARED_STRINGS_LARGE_BYTES, 1288490188);
});

test('单 sheet 小 worksheet 但 sharedStrings ≥1.2GB → true（codex P2：高基数长文本 SST 也走大通道，避免小路径 JSZip 全量载 SST OOM）', async () => {
  const restore = stubSizes(new Map([
    [SS, router.SHARED_STRINGS_LARGE_BYTES],          // SST 恰达阈值（≥）
    ['xl/worksheets/sheet1.xml', 50000]               // worksheet 远小于 1.5GB
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/bigsst.xlsx'), true);
  } finally {
    restore();
  }
});

test('单 sheet sharedStrings 略低于 1.2GB（阈值 -1）→ false（🔴 小文件零回归）', async () => {
  const restore = stubSizes(new Map([
    [SS, router.SHARED_STRINGS_LARGE_BYTES - 1],
    ['xl/worksheets/sheet1.xml', 50000]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/justundersst.xlsx'), false);
  } finally {
    restore();
  }
});

test('.csv → false（fail-closed，不调 collectEntrySizes）', async () => {
  let called = false;
  sizePreflight.collectEntrySizes = async () => { called = true; return new Map(); };
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/data.csv'), false);
    assert.equal(called, false, '.csv 不应触发 collectEntrySizes');
  } finally {
    sizePreflight.collectEntrySizes = realCollectEntrySizes;
  }
});

test('.xls → false（fail-closed，不调 collectEntrySizes）', async () => {
  let called = false;
  sizePreflight.collectEntrySizes = async () => { called = true; return new Map(); };
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/legacy.xls'), false);
    assert.equal(called, false, '.xls 不应触发 collectEntrySizes');
  } finally {
    sizePreflight.collectEntrySizes = realCollectEntrySizes;
  }
});

test('collectEntrySizes 抛异常 → false（fail-closed）', async () => {
  const restore = stubThrow(new Error('zip central directory unreadable'));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/broken.xlsx'), false);
  } finally {
    restore();
  }
});

test('空路径 / null / undefined → false（fail-closed）', async () => {
  assert.equal(await shouldUseLargeChannel(''), false);
  assert.equal(await shouldUseLargeChannel(null), false);
  assert.equal(await shouldUseLargeChannel(undefined), false);
});

// 边界：collectEntrySizes 返回里没有任何 worksheet entry（异常/损坏 xlsx）→ fail-closed false。
test('0 个 worksheet（仅 sharedStrings）→ false（fail-closed）', async () => {
  const restore = stubSizes(new Map([[SS, 4096]]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/no-sheet.xlsx'), false);
  } finally {
    restore();
  }
});

// 边界：单 worksheet 尺寸为非数字（异常形态）→ fail-closed false。
test('单 worksheet 尺寸非数字 → false（fail-closed）', async () => {
  const restore = stubSizes(new Map([
    [SS, 4096],
    ['xl/worksheets/sheet1.xml', undefined]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/weird.xlsx'), false);
  } finally {
    restore();
  }
});

// 边界：collectEntrySizes 返回非 Map（异常形态）→ fail-closed false。
test('collectEntrySizes 返回非 Map → false（fail-closed）', async () => {
  sizePreflight.collectEntrySizes = async () => null;
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/weird2.xlsx'), false);
  } finally {
    sizePreflight.collectEntrySizes = realCollectEntrySizes;
  }
});

// 大小写不敏感扩展名：.XLSX 也判为 xlsx。
test('.XLSX（大写）单 sheet 小 → false（扩展名大小写不敏感且 fail-closed）', async () => {
  const restore = stubSizes(new Map([
    [SS, 2048],
    ['xl/worksheets/sheet1.xml', 50000]
  ]));
  try {
    assert.equal(await shouldUseLargeChannel('/tmp/UPPER.XLSX'), false);
  } finally {
    restore();
  }
});

// ---- B 组：真实夹具回归（不 mock，验证 router 与真实 collectEntrySizes 接缝）----

test('真实夹具：单 sheet 小 .xlsx（真实 collectEntrySizes）→ false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-router-real-'));
  const fp = path.join(dir, 'single.xlsx');
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['日期', '渠道', '金额'], ['2026-06-18', 'NET', 100]]);
    XLSX.utils.book_append_sheet(wb, ws, 'COMMON');
    XLSX.writeFile(wb, fp);
    assert.equal(await shouldUseLargeChannel(fp), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实夹具：多 sheet .xlsx（真实 collectEntrySizes）→ true', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-router-real-'));
  const fp = path.join(dir, 'multi.xlsx');
  try {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([['日期', '渠道'], ['2026-06-18', 'NET']]);
    const ws2 = XLSX.utils.aoa_to_sheet([['日期', '渠道'], ['2026-06-19', 'WAP']]);
    XLSX.utils.book_append_sheet(wb, ws1, 'S1');
    XLSX.utils.book_append_sheet(wb, ws2, 'S2');
    XLSX.writeFile(wb, fp);
    assert.equal(await shouldUseLargeChannel(fp), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实夹具：.csv（真实路径）→ false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbx-router-real-'));
  const fp = path.join(dir, 'data.csv');
  try {
    fs.writeFileSync(fp, '日期,渠道,金额\n2026-06-18,NET,100\n', 'utf8');
    assert.equal(await shouldUseLargeChannel(fp), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
