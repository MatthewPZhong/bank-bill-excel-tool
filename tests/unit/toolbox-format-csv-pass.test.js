'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FileValidationError } = require('../../src/backend/file-service/common');
const { readRows } = require('../../src/backend/file-service/readers');
const {
  CSV_SHEET_NAME,
  TOOLBOX_PROJECTION_PROFILES,
  ToolboxCsvCancelledError,
  openToolboxCsvPass,
  projectOutputCell,
  projectToolboxRowValues,
  toMatchValue
} = require('../../src/backend/toolbox-format');

const tempDirectories = [];

test.after(() => {
  for (const directory of tempDirectories) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_error) {}
  }
});

function createCsv(name, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-format-csv-'));
  tempDirectories.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('CSV pass 用默认样式包装旧 reader 字符串矩阵，长编号与词法值不转型', async () => {
  const filePath = createCsv(
    'legacy.csv',
    Buffer.from(
      '\uFEFF ID ,"说明","长编号","科学词法","空列"\r\n' +
      '" 001 ","第一行\n第二行","12345678901234567890","1E+20",\r\n' +
      ',,  ,,\r\n' +
      '"quote ""value"""," tail ",0007,1e-7,\r\n',
      'utf8'
    )
  );
  const legacyRows = readRows(filePath);
  const pass = await openToolboxCsvPass(filePath, { sourceRegistryId: 'csv-fixture' });
  try {
    assert.equal(pass.format, 'csv');
    assert.equal(pass.sourceFile, 'legacy.csv');
    assert.equal(pass.sourceRegistryId, 'csv-fixture');
    assert.equal(pass.getSourceRegistry(), pass.sourceRegistry);
    assert.equal(pass.getSourceRegistry('another-registry'), null);
    assert.equal(pass.sheets.length, 1);
    assert.deepEqual(
      [pass.sheets[0].name, pass.sheets[0].state, pass.sheets[0].sheetIndex],
      [CSV_SHEET_NAME, 'visible', 0]
    );

    const metas = [];
    const rows = [];
    const summary = await pass.scanSheet(0, {
      onSheetMeta: (meta) => metas.push(meta),
      onRow: (row) => rows.push(row)
    });

    assert.equal(metas.length, 1);
    assert.equal(summary.rowCount, legacyRows.length);
    assert.equal(summary.rowCount, 3, '旧 CSV reader 会跳过纯空行');
    assert.equal(summary.explicitCellCount, legacyRows.reduce((sum, row) => sum + row.length, 0));
    assert.equal(summary.maxColumnIndex, 4);
    assert.deepEqual(
      rows.map((row) => projectToolboxRowValues(
        row,
        TOOLBOX_PROJECTION_PROFILES.CSV_LEGACY
      )),
      legacyRows,
      '适配前后的 CSV 字符串矩阵必须完全一致'
    );

    const meta = metas[0];
    assert.equal(meta.name, CSV_SHEET_NAME);
    assert.equal(meta.date1904, false);
    assert.equal(meta.defaultColWidth, null);
    assert.equal(meta.defaultRowHeight, null);
    assert.deepEqual(meta.columns, []);
    assert.equal(meta.sourceRegistryId, 'csv-fixture');

    assert.equal(toMatchValue(rows[0].cells[0], 'csv-legacy'), 'ID');
    assert.equal(rows[1].cells[0].rawLexicalValue, ' 001 ');
    assert.equal(toMatchValue(rows[1].cells[0], 'csv-legacy'), '001');
    assert.equal(rows[1].cells[1].rawLexicalValue, '第一行\n第二行');
    assert.equal(rows[2].cells[0].rawLexicalValue, 'quote "value"');

    const longId = rows[1].cells[2];
    const scientific = rows[1].cells[3];
    assert.equal(longId.cellType, 'text');
    assert.equal(projectOutputCell(longId).value, '12345678901234567890');
    assert.equal(projectOutputCell(scientific).value, '1E+20');
    assert.equal(longId.sourceFormat, 'General');
    assert.equal(longId.effectiveStyleRef.sourceRegistryId, 'csv-fixture');
    assert.equal(
      longId.effectiveStyleRef.styleRef,
      pass.sourceRegistry.defaultStyleRef
    );
    assert.equal(
      pass.sourceRegistry.get(longId.effectiveStyleRef.styleRef).numFmt,
      'General'
    );

    const sheetCallbacks = [];
    const sheetSummaries = await pass.scanSheets({
      onSheetMeta: (_meta, sheet) => sheetCallbacks.push(`meta:${sheet.name}`),
      onRow: (_row, _meta, sheet) => sheetCallbacks.push(`row:${sheet.name}`)
    });
    assert.equal(sheetSummaries.length, 1);
    assert.equal(sheetSummaries[0].rowCount, 3);
    assert.deepEqual(sheetCallbacks, [
      'meta:CSV',
      'row:CSV',
      'row:CSV',
      'row:CSV'
    ]);
  } finally {
    pass.close();
  }
});

test('空文件与纯空 CSV 都作为单个 0 行伪 Sheet 扫描', async () => {
  const fixtures = [
    createCsv('empty.csv', ''),
    createCsv('blank.csv', '\r\n,,\n"  ", \r\n')
  ];

  for (const filePath of fixtures) {
    const pass = await openToolboxCsvPass(filePath);
    try {
      let metaCount = 0;
      let rowCount = 0;
      const summary = await pass.scanSheet(pass.sheets[0], {
        onSheetMeta: () => { metaCount += 1; },
        onRow: () => { rowCount += 1; }
      });
      assert.equal(metaCount, 1);
      assert.equal(rowCount, 0);
      assert.equal(summary.rowCount, 0);
      assert.equal(summary.explicitCellCount, 0);
      assert.equal(summary.maxColumnIndex, -1);
      assert.equal(summary.cancelled, false);
    } finally {
      pass.close();
    }
  }
});

test('预取消与扫描中取消均抛专用错误，pass 可在取消后重新扫描', async () => {
  const filePath = createCsv('cancel.csv', 'H1,H2\na,1\nb,2\n');
  const pass = await openToolboxCsvPass(filePath);
  try {
    await assert.rejects(
      () => pass.scanSheets({ cancelToken: { cancelled: true } }),
      (error) => error instanceof ToolboxCsvCancelledError &&
        error.code === 'TOOLBOX_CSV_CANCELLED'
    );

    const cancelToken = { cancelled: false };
    let partialRowCount = 0;
    await assert.rejects(
      () => pass.scanSheet(0, {
        cancelToken,
        onRow: () => {
          partialRowCount += 1;
          cancelToken.cancelled = true;
        }
      }),
      ToolboxCsvCancelledError
    );
    assert.equal(partialRowCount, 1);

    let completeRowCount = 0;
    const summary = await pass.scanSheet(0, {
      onRow: () => { completeRowCount += 1; }
    });
    assert.equal(completeRowCount, 3);
    assert.equal(summary.rowCount, 3);
  } finally {
    pass.close();
  }
});

test('文件读取失败沿用 FileValidationError，关闭后拒绝扫描', async () => {
  const missingPath = path.join(
    os.tmpdir(),
    `toolbox-format-missing-${process.pid}-${Date.now()}.csv`
  );
  await assert.rejects(
    () => openToolboxCsvPass(missingPath),
    (error) => {
      assert.ok(error instanceof FileValidationError);
      assert.equal(error.code, 'FILE_READ');
      assert.equal(error.message, '文件为空或不可读，请重新导入');
      return true;
    }
  );

  const filePath = createCsv('closed.csv', 'H\nvalue\n');
  const pass = await openToolboxCsvPass(filePath);
  pass.close();
  await assert.rejects(() => pass.scanSheet(0), /已关闭/);
});
