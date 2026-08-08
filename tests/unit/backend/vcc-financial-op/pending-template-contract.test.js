'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const {
  SOURCE_TYPES,
  PENDING_HEADERS,
  PENDING_V1_HEADERS
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  PENDING_TEMPLATE_FILE_SHA256,
  PENDING_TEMPLATE_HEADER_SHA256,
  PENDING_TEMPLATE_RANGE,
  headerFingerprint,
  sha256
} = require('../../../../src/backend/vcc-financial-op/pending-template-contract');
const {
  inspectSourceFile,
  streamDetailRows
} = require('../../../../src/backend/vcc-financial-op/workbook-reader');

const ASSET_PATH = path.join(
  __dirname,
  '../../../../assets/VCC财务OP校验/VCC_移除归档Pending账单.xlsx'
);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-pending-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeHeaders(t, headers, { fileName = 'pending.xlsx', duplicate = false } = {}) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers]), 'Pending');
  if (duplicate) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers]), 'Pending-2');
  }
  const filePath = path.join(tempDir(t), fileName);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

test('Pending 金标准资产锁定 SHA、46 列、A1:AT1 与表头指纹', async () => {
  assert.equal(sha256(fs.readFileSync(ASSET_PATH)), PENDING_TEMPLATE_FILE_SHA256);
  const workbook = XLSX.readFile(ASSET_PATH);
  assert.equal(workbook.SheetNames.length, 1);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  assert.equal(sheet['!ref'], PENDING_TEMPLATE_RANGE);
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  assert.equal(matrix[0].length, 46);
  assert.deepEqual(matrix[0], PENDING_HEADERS);
  assert.equal(headerFingerprint(matrix[0]), PENDING_TEMPLATE_HEADER_SHA256);
  assert.equal(PENDING_HEADERS.includes('是否错币'), false);
  assert.equal(PENDING_HEADERS.includes('金额差'), false);

  const inspected = await inspectSourceFile(ASSET_PATH);
  assert.equal(inspected.sourceType, SOURCE_TYPES.PENDING);
  assert.equal(inspected.headerRow, 1);
  const streamed = await streamDetailRows(ASSET_PATH, SOURCE_TYPES.PENDING, {
    onDataRow() { throw new Error('金标准模板不应包含数据行'); }
  });
  assert.equal(streamed.rowCount, 0);
});
test('Pending 缺列、增列、换序和下划线变化均按最新契约失败关闭', async (t) => {
  const variants = [];
  variants.push(writeHeaders(t, PENDING_HEADERS.filter((header) => header !== '金额'), {
    fileName: 'missing.xlsx'
  }));
  variants.push(writeHeaders(t, [...PENDING_HEADERS, '额外列'], { fileName: 'extra.xlsx' }));
  const swapped = [...PENDING_HEADERS];
  [swapped[10], swapped[11]] = [swapped[11], swapped[10]];
  variants.push(writeHeaders(t, swapped, { fileName: 'swapped.xlsx' }));
  const renamed = [...PENDING_HEADERS];
  renamed[28] = '流水账单日期';
  variants.push(writeHeaders(t, renamed, { fileName: 'underscore.xlsx' }));

  for (const filePath of variants) {
    await assert.rejects(
      inspectSourceFile(filePath),
      (error) => {
        assert.equal(error.code, 'pending-template-contract-mismatch');
        assert.match(error.message, /Pending 原表表头与最新正式模板不一致/);
        assert.ok(error.detailLines.some((line) => /第 \d+ 列/.test(line)));
        return true;
      }
    );
    await assert.rejects(
      streamDetailRows(filePath, SOURCE_TYPES.PENDING, { onDataRow() {} }),
      (error) => error.code === 'pending-template-contract-mismatch'
    );
  }
});

test('Pending 重复业务 sheet 与旧 48 列模板均明确拒绝', async (t) => {
  const duplicate = writeHeaders(t, PENDING_HEADERS, {
    fileName: 'duplicate.xlsx',
    duplicate: true
  });
  await assert.rejects(inspectSourceFile(duplicate), /检测到多张校验原表 sheet/);

  const legacy = writeHeaders(t, PENDING_V1_HEADERS, { fileName: 'legacy-48.xlsx' });
  await assert.rejects(
    inspectSourceFile(legacy),
    (error) => {
      assert.equal(error.code, 'pending-template-contract-mismatch');
      assert.match(error.message, /模板已更新，请使用 46 列/);
      assert.ok(error.detailLines.some((line) => line.includes('是否错币')));
      return true;
    }
  );
  await assert.rejects(
    streamDetailRows(legacy, SOURCE_TYPES.PENDING, { onDataRow() {} }),
    (error) => error.code === 'pending-template-contract-mismatch'
  );
});
