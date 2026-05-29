// v2.1.11 T2 — 移除归档 Pending 文件读取器
//   覆盖：46 列表头正常解析 + 索引字段抽取 / 缺表头(空文件)报错 / 列数不符报错 /
//        数字 sheet 名取第一个 sheet / 空行跳过 / raw 全 46 列保留。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  readRemovedPendingFile,
  REMOVED_PENDING_COLUMNS,
  INDEX_FIELDS,
  ERROR_CODE
} = require('../../../../src/backend/pending-import/removed-reader');
const { FileValidationError } = require('../../../../src/backend/file-service/common');

let tmpDir;
test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'removed-reader-'));
});
test.afterEach(() => {
  if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} tmpDir = null; }
});

// 写一个 xlsx（aoa = 2D 数组），sheet 名可指定
function writeXlsx(aoa, sheetName = 'Sheet1') {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const file = path.join(tmpDir, `removed-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  XLSX.writeFile(wb, file);
  return file;
}

// 构造一条完整 46 列数据行（按列序填值，可覆盖指定列）
function makeDataRow(overrides = {}) {
  return REMOVED_PENDING_COLUMNS.map((col) => (overrides[col] !== undefined ? overrides[col] : `v_${col}`));
}

test.describe('readRemovedPendingFile — 正常解析', () => {
  test('46 列表头 + 1 数据行 → 解析出 1 行，raw 含全 46 列', () => {
    const header = REMOVED_PENDING_COLUMNS.slice();
    const dataRow = makeDataRow({ order_no: 'O123', recon_id: 'R456', 金额: '88.88', channel: 'CH', merchant_id: 'M9', bank_ref: 'BR1' });
    const file = writeXlsx([header, dataRow]);

    const result = readRemovedPendingFile(file);
    assert.equal(result.totalRows, 1);
    assert.equal(result.rows.length, 1);
    // raw 全 46 列
    assert.equal(Object.keys(result.rows[0].raw).length, REMOVED_PENDING_COLUMNS.length);
    for (const col of REMOVED_PENDING_COLUMNS) {
      assert.ok(col in result.rows[0].raw, `raw 应含列 ${col}`);
    }
    // headerRow 用模板表头
    assert.deepEqual(result.headerRow, REMOVED_PENDING_COLUMNS);
  });

  test('索引字段从 raw 抽到顶层（order_no/recon_id/金额/channel/merchant_id/bank_ref）', () => {
    const header = REMOVED_PENDING_COLUMNS.slice();
    const dataRow = makeDataRow({
      order_no: 'O123', recon_id: 'R456', 金额: '88.88',
      channel: 'CH', merchant_id: 'M9', bank_ref: 'BR1'
    });
    const file = writeXlsx([header, dataRow]);
    const row = readRemovedPendingFile(file).rows[0];
    assert.equal(row.order_no, 'O123');
    assert.equal(row.recon_id, 'R456');
    assert.equal(row['金额'], '88.88');
    assert.equal(row.channel, 'CH');
    assert.equal(row.merchant_id, 'M9');
    assert.equal(row.bank_ref, 'BR1');
    // 索引字段集合与导出常量一致
    assert.deepEqual(INDEX_FIELDS.slice(), ['order_no', 'recon_id', '金额', 'channel', 'merchant_id', 'bank_ref']);
  });

  test('多数据行 + 中间空行被跳过', () => {
    const header = REMOVED_PENDING_COLUMNS.slice();
    const r1 = makeDataRow({ order_no: 'A' });
    const empty = REMOVED_PENDING_COLUMNS.map(() => '');
    const r2 = makeDataRow({ order_no: 'B' });
    const file = writeXlsx([header, r1, empty, r2]);
    const result = readRemovedPendingFile(file);
    assert.equal(result.totalRows, 2);
    assert.equal(result.rows[0].order_no, 'A');
    assert.equal(result.rows[1].order_no, 'B');
  });

  test('cell 值前后空白被 trim（normalizeCell）', () => {
    const header = REMOVED_PENDING_COLUMNS.slice();
    const dataRow = makeDataRow({ order_no: '  O-trim  ' });
    const file = writeXlsx([header, dataRow]);
    const row = readRemovedPendingFile(file).rows[0];
    assert.equal(row.order_no, 'O-trim');
    assert.equal(row.raw.order_no, 'O-trim');
  });
});

test.describe('readRemovedPendingFile — 数字 sheet 名取第一个 sheet（D-T2-4）', () => {
  test('sheet 名是大数字 ID 字符串 → 仍取第一个 sheet 正常解析', () => {
    const header = REMOVED_PENDING_COLUMNS.slice();
    const dataRow = makeDataRow({ order_no: 'NUM-SHEET' });
    // 模板真实 sheet 名形如 "1405800876820465666"（超 JS 安全整数）
    const file = writeXlsx([header, dataRow], '1405800876820465666');

    const result = readRemovedPendingFile(file);
    assert.equal(result.sourceSheetName, '1405800876820465666');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].order_no, 'NUM-SHEET');
  });

  test('多 sheet 时取第一个（第二个 sheet 内容被忽略）', () => {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([REMOVED_PENDING_COLUMNS.slice(), makeDataRow({ order_no: 'FIRST' })]);
    const ws2 = XLSX.utils.aoa_to_sheet([REMOVED_PENDING_COLUMNS.slice(), makeDataRow({ order_no: 'SECOND' })]);
    XLSX.utils.book_append_sheet(wb, ws1, '999111222333');
    XLSX.utils.book_append_sheet(wb, ws2, 'other');
    const file = path.join(tmpDir, 'multi.xlsx');
    XLSX.writeFile(wb, file);

    const result = readRemovedPendingFile(file);
    assert.equal(result.sourceSheetName, '999111222333');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].order_no, 'FIRST');
  });
});

test.describe('readRemovedPendingFile — 报错路径', () => {
  test('空 sheet（无表头）→ FileValidationError', () => {
    const file = writeXlsx([]);
    assert.throws(
      () => readRemovedPendingFile(file),
      (err) => {
        assert.ok(err instanceof FileValidationError);
        assert.equal(err.code, ERROR_CODE);
        return true;
      }
    );
  });

  test('表头列数不足（少 1 列）→ FileValidationError', () => {
    const shortHeader = REMOVED_PENDING_COLUMNS.slice(0, REMOVED_PENDING_COLUMNS.length - 1);
    const file = writeXlsx([shortHeader, shortHeader.map(() => 'x')]);
    assert.throws(
      () => readRemovedPendingFile(file),
      (err) => {
        assert.ok(err instanceof FileValidationError);
        assert.equal(err.code, ERROR_CODE);
        assert.match(err.message, /列数不匹配/);
        return true;
      }
    );
  });

  test('表头内容不符（某列错名）→ FileValidationError', () => {
    const badHeader = REMOVED_PENDING_COLUMNS.slice();
    badHeader[11] = '错误列名';   // 原应为 recon_id
    const file = writeXlsx([badHeader, makeDataRow()]);
    assert.throws(
      () => readRemovedPendingFile(file),
      (err) => {
        assert.ok(err instanceof FileValidationError);
        assert.equal(err.code, ERROR_CODE);
        assert.match(err.message, /第 12 列不匹配/);
        return true;
      }
    );
  });

  test('文件不存在 → FileValidationError（读取失败）', () => {
    assert.throws(
      () => readRemovedPendingFile(path.join(tmpDir, 'nope.xlsx')),
      (err) => {
        assert.ok(err instanceof FileValidationError);
        assert.equal(err.code, ERROR_CODE);
        return true;
      }
    );
  });
});

test.describe('readRemovedPendingFile — 真实模板 assets/移除归档Pending账单.xlsx', () => {
  test('真实模板表头 46 列校验通过（仅表头无数据 → totalRows=0）', () => {
    const real = path.join(__dirname, '..', '..', '..', '..', 'assets', '移除归档Pending账单.xlsx');
    if (!fs.existsSync(real)) {
      // 模板缺失不让测试硬挂（assets 由用户提供）；跳过
      return;
    }
    const result = readRemovedPendingFile(real);
    assert.deepEqual(result.headerRow, REMOVED_PENDING_COLUMNS);
    assert.equal(result.headerRow.length, 46);
    assert.equal(typeof result.sourceSheetName, 'string');
  });
});
