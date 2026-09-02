'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const JSZip = require('jszip');
const XLSX = require('xlsx');

const { writeBalanceWorkbook } = require('../../../src/backend/file-service');
const { extractHeaders } = require('../../../src/backend/file-service/readers');
const {
  locateSheets,
  openZipWithEntries
} = require('../../../src/backend/big-table-import/zip-reader');
const {
  prepareNewAccountGeneration,
  readBackAndValidate,
  readBackAndValidateCooperatively
} = require('../../../src/main-process/new-account/generation-core');
const {
  loadNewAccountSharedStrings,
  scanNewAccountWorksheetRows
} = require('../../../src/main-process/new-account/strict-worksheet-readback');

const TEMPLATE_PATH = path.resolve(__dirname, '../../../assets/余额账单模版.xlsx');
const WORKSHEET_OPEN = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'new-account-strict-readback-'));
}

async function mutateWorksheet(sourcePath, targetPath, mutate) {
  const zip = await JSZip.loadAsync(fs.readFileSync(sourcePath));
  const entry = zip.file('xl/worksheets/sheet1.xml');
  assert.ok(entry, '测试workbook缺少sheet1.xml');
  const original = await entry.async('string');
  const changed = mutate(original);
  assert.notEqual(changed, original, '测试mutation必须命中worksheet XML');
  zip.file('xl/worksheets/sheet1.xml', changed);
  fs.writeFileSync(targetPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function mutateSharedStrings(filePath, mutate) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const entry = zip.file('xl/sharedStrings.xml');
  assert.ok(entry, '测试workbook缺少sharedStrings.xml');
  const original = await entry.async('string');
  const changed = mutate(original);
  assert.notEqual(changed, original, '测试mutation必须命中sharedStrings XML');
  zip.file('xl/sharedStrings.xml', changed);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function writeSyntheticWorkbook(dir, name, sheetXml) {
  const basePath = path.join(dir, `${name}-base.xlsx`);
  const targetPath = path.join(dir, `${name}.xlsx`);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['shared-zero']]), 'balance');
  XLSX.writeFile(workbook, basePath, { bookSST: true });
  await mutateWorksheet(basePath, targetPath, () => sheetXml);
  return targetPath;
}

function openZipEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function strictRows(filePath, expectedColumnCount) {
  const opened = await openZipWithEntries(path.basename(filePath), filePath, {
    rejectDuplicateEntries: true
  });
  try {
    const sheets = await locateSheets(opened.zip, opened.entries);
    assert.equal(sheets.length, 1);
    const sharedStrings = await loadNewAccountSharedStrings(
      opened.zip,
      opened.entries.get('xl/sharedStrings.xml') || null
    );
    const stream = await openZipEntryStream(opened.zip, opened.entries.get(sheets[0].entryPath));
    const rows = [];
    await scanNewAccountWorksheetRows({
      stream,
      expectedColumnCount,
      sharedStrings,
      onRow(row) { rows.push(row); }
    });
    return rows.filter((row) => row.hasAnyCellValue).map((row) => row.values);
  } finally {
    try { opened.zip.close(); } catch (_) {}
  }
}

function oldRawRows(filePath) {
  const workbook = XLSX.readFile(filePath, {
    cellDates: false,
    cellNF: true,
    cellStyles: true,
    raw: true
  });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    blankrows: false,
    defval: '',
    raw: true
  });
}

function replaceCell(xml, ref, replacement) {
  const pattern = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*>[\\s\\S]*?<\\/c>`);
  assert.match(xml, pattern, `测试workbook缺少${ref}`);
  return xml.replace(pattern, replacement);
}

function replaceCellReference(xml, from, to) {
  const pattern = new RegExp(`(<c\\b[^>]*\\br=")${from}("[^>]*>)`);
  assert.match(xml, pattern, `测试workbook缺少${from}`);
  return xml.replace(pattern, (_match, prefix, suffix) => `${prefix}${to}${suffix}`);
}

function replaceDimension(xml, replacement) {
  const pattern = /<dimension\b[^>]*\/>/;
  assert.match(xml, pattern, '测试workbook缺少dimension');
  return xml.replace(pattern, replacement);
}

function workbookDimension(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  return workbook.Sheets[workbook.SheetNames[0]]['!ref'];
}

function createFixture(dir, bankAccount) {
  const headers = extractHeaders(TEMPLATE_PATH);
  const prepared = prepareNewAccountGeneration({
    payload: {
      accounts: [{
        bankName: '测试银行',
        location: '上海',
        bankAccount,
        openingDate: '2026-03-01',
        isMultiCurrency: false,
        currency: 'CNY',
        currencies: ['CNY']
      }]
    },
    balanceTemplateFields: headers,
    today: new Date(2026, 2, 2)
  });
  const sourcePath = path.join(dir, 'source.xlsx');
  writeBalanceWorkbook({
    templateFilePath: TEMPLATE_PATH,
    records: prepared.records,
    templateFields: headers,
    outputFilePath: sourcePath
  });
  return {
    sourcePath,
    expected: {
      sheetName: XLSX.readFile(TEMPLATE_PATH).SheetNames[0],
      headers,
      records: prepared.records
    }
  };
}

async function assertOldAndStreamingReject({ bankAccount, replacement }) {
  const dir = tempDir();
  try {
    const fixture = createFixture(dir, bankAccount);
    const mutatedPath = path.join(dir, 'mutated.xlsx');
    await mutateWorksheet(fixture.sourcePath, mutatedPath, (xml) => (
      replaceCell(xml, 'D2', replacement)
    ));
    assert.throws(
      () => readBackAndValidate(mutatedPath, fixture.expected),
      (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_RECORDS_MISMATCH'
    );
    await assert.rejects(
      readBackAndValidateCooperatively(
        mutatedPath,
        fixture.expected,
        new AbortController().signal
      )
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('numeric leading-zero账户不能被流式字符串解码伪装为原账号', async () => {
  await assertOldAndStreamingReject({
    bankAccount: '00123',
    replacement: '<c r="D2"><v>00123</v></c>'
  });
});

test('boolean账户不能被流式字符串1伪装为原账号', async () => {
  await assertOldAndStreamingReject({
    bankAccount: '1',
    replacement: '<c r="D2" t="b"><v>1</v></c>'
  });
});

test('outer row与cell ref行号错位必须fail closed', async () => {
  await assertOldAndStreamingReject({
    bankAccount: '00123',
    replacement: '<c r="D3" t="str"><v>00123</v></c>'
  });
});

test('strict t=d原始空白必须fail closed，canonical/Zulu仍与legacy raw业务回读等价', async () => {
  const dir = tempDir();
  const validValues = ['2026-03-01', '2026-03-01T00:00:00Z'];
  const strictInvalidValues = [
    ' 2026-03-01',
    '2026-03-01 ',
    ' 2026-03-01 ',
    '\t2026-03-01',
    '2026-03-01\t',
    '\n2026-03-01',
    '',
    '   '
  ];
  // SheetJS legacy oracle 对带空白 t=d 的解释依赖宿主时区；仅空值两类稳定拒绝。
  const legacyStableRejectValues = new Set(['', '   ']);
  try {
    const fixture = createFixture(dir, '00123');
    for (const [index, value] of validValues.entries()) {
      const mutatedPath = path.join(dir, `date-valid-${index}.xlsx`);
      await mutateWorksheet(fixture.sourcePath, mutatedPath, (xml) => (
        replaceCell(xml, 'E2', `<c r="E2" t="d"><v>${value}</v></c>`)
      ));
      const oldResult = readBackAndValidate(mutatedPath, fixture.expected);
      const strictResult = await readBackAndValidateCooperatively(
        mutatedPath,
        fixture.expected,
        new AbortController().signal
      );
      assert.deepEqual(strictResult, oldResult);
    }
    for (const [index, value] of strictInvalidValues.entries()) {
      const mutatedPath = path.join(dir, `date-invalid-${index}.xlsx`);
      await mutateWorksheet(fixture.sourcePath, mutatedPath, (xml) => (
        replaceCell(xml, 'E2', `<c r="E2" t="d"><v>${value}</v></c>`)
      ));
      if (legacyStableRejectValues.has(value)) {
        assert.throws(
          () => readBackAndValidate(mutatedPath, fixture.expected),
          (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_RECORDS_MISMATCH'
        );
      }
      await assert.rejects(
        readBackAndValidateCooperatively(
          mutatedPath,
          fixture.expected,
          new AbortController().signal
        ),
        (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_CELL_INVALID'
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cell ref必须canonical回编码，D02/长前导零不能冒充D2', async () => {
  const dir = tempDir();
  const invalidReferences = ['D02', 'D0002', `D${'0'.repeat(128)}2`];
  try {
    const fixture = createFixture(dir, '00123');
    for (const [index, reference] of invalidReferences.entries()) {
      const mutatedPath = path.join(dir, `cell-ref-leading-zero-${index}.xlsx`);
      await mutateWorksheet(fixture.sourcePath, mutatedPath, (xml) => (
        replaceCellReference(xml, 'D2', reference)
      ));
      assert.throws(
        () => readBackAndValidate(mutatedPath, fixture.expected),
        (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_RECORDS_MISMATCH'
      );
      await assert.rejects(
        readBackAndValidateCooperatively(
          mutatedPath,
          fixture.expected,
          new AbortController().signal
        ),
        (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_COORDINATE_INVALID'
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outer row r=02按旧raw数值语义兼容，canonical cell refs仍保持业务等价', async () => {
  const dir = tempDir();
  try {
    const fixture = createFixture(dir, '00123');
    const mutatedPath = path.join(dir, 'outer-row-leading-zero.xlsx');
    await mutateWorksheet(fixture.sourcePath, mutatedPath, (xml) => {
      assert.match(xml, /<row\b[^>]*\br="2"/);
      return xml.replace(
        /(<row\b[^>]*\br=")2("[^>]*>)/,
        (_match, prefix, suffix) => `${prefix}02${suffix}`
      );
    });
    const oldResult = readBackAndValidate(mutatedPath, fixture.expected);
    const strictResult = await readBackAndValidateCooperatively(
      mutatedPath,
      fixture.expected,
      new AbortController().signal
    );
    assert.deepEqual(strictResult, oldResult);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Reviewer反例：dimension A1:I1截断真实业务行时旧raw与strict均拒绝', async () => {
  const dir = tempDir();
  try {
    const fixture = createFixture(dir, '00123');
    const mutatedPath = path.join(dir, 'dimension-truncated.xlsx');
    await mutateWorksheet(fixture.sourcePath, mutatedPath, (xml) => (
      replaceDimension(xml, '<dimension ref="A1:I1"/>')
    ));
    assert.throws(
      () => readBackAndValidate(mutatedPath, fixture.expected),
      (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_RECORDS_MISMATCH'
    );
    await assert.rejects(
      readBackAndValidateCooperatively(
        mutatedPath,
        fixture.expected,
        new AbortController().signal
      ),
      (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict dimension拒绝missing/duplicate/expanded/shifted/reversed/out-of-range/absolute/multi-area', async () => {
  const dir = tempDir();
  const variants = [
    ['missing', ''],
    ['missing-ref', '<dimension/>'],
    ['duplicate', '<dimension ref="A1:I2"/><dimension ref="A1:I2"/>'],
    ['truncated', '<dimension ref="A1"/>'],
    ['expanded-column', '<dimension ref="A1:J2"/>'],
    ['expanded-row', '<dimension ref="A1:I3"/>'],
    ['shifted', '<dimension ref="B1:I2"/>'],
    ['reversed', '<dimension ref="I2:A1"/>'],
    ['column-out-of-range', '<dimension ref="A1:XFE2"/>'],
    ['row-out-of-range', '<dimension ref="A1:I1048577"/>'],
    ['absolute', '<dimension ref="$A$1:$I$2"/>'],
    ['multi-area-space', '<dimension ref="A1:I2 A3:I3"/>'],
    ['multi-area-comma', '<dimension ref="A1:I2,J1:J2"/>'],
    ['malformed', '<dimension ref="A1:I2x"/>'],
    ['leading-zero-start', '<dimension ref="A01:I2"/>'],
    ['leading-zero-end', '<dimension ref="A1:I02"/>'],
    ['long-leading-zero', `<dimension ref="A${'0'.repeat(128)}1:I2"/>`]
  ];
  try {
    const fixture = createFixture(dir, '00123');
    for (const [name, replacement] of variants) {
      const mutatedPath = path.join(dir, `dimension-${name}.xlsx`);
      await mutateWorksheet(fixture.sourcePath, mutatedPath, (xml) => (
        replaceDimension(xml, replacement)
      ));
      await assert.rejects(
        strictRows(mutatedPath, 9),
        (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID',
        name
      );
    }

    const permissiveOldRefs = new Map([
      ['missing', 'A1:I2'],
      ['duplicate', 'A1:I2'],
      ['expanded-column', 'A1:J2'],
      ['reversed', 'A1:I2'],
      ['absolute', 'A1:I2'],
      ['leading-zero-start', 'A1:I2'],
      ['leading-zero-end', 'A1:I2']
    ]);
    for (const [name, expectedRef] of permissiveOldRefs) {
      assert.equal(workbookDimension(path.join(dir, `dimension-${name}.xlsx`)), expectedRef);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merge refs必须canonical回编码并拒绝端点前导零', async () => {
  const dir = tempDir();
  const invalidMergeReferences = [
    'A01:C2',
    'A1:C02',
    `A${'0'.repeat(128)}1:C2`,
    `A1:C${'0'.repeat(128)}2`
  ];
  try {
    for (const [index, reference] of invalidMergeReferences.entries()) {
      const filePath = await writeSyntheticWorkbook(
        dir,
        `merge-leading-zero-${index}`,
        `${WORKSHEET_OPEN}<dimension ref="A1:C2"/><sheetData>` +
          '<row r="1"><c r="A1" t="str"><v>start</v></c></row>' +
          '<row r="2"><c r="C2" t="str"><v>end</v></c></row></sheetData>' +
          `<mergeCells count="1"><mergeCell ref="${reference}"/></mergeCells></worksheet>`
      );
      assert.doesNotThrow(() => oldRawRows(filePath));
      await assert.rejects(
        strictRows(filePath, 3),
        (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_DIMENSION_INVALID'
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict dimension接受empty A1、冻结header-only尾随空行与真实1-row writer', async () => {
  const dir = tempDir();
  try {
    const emptyPath = await writeSyntheticWorkbook(
      dir,
      'dimension-empty',
      `${WORKSHEET_OPEN}<dimension ref="A1"/><sheetData/></worksheet>`
    );
    assert.deepEqual(await strictRows(emptyPath, 1), oldRawRows(emptyPath));

    const headers = extractHeaders(TEMPLATE_PATH);
    const headerOnlyPath = path.join(dir, 'dimension-header-only.xlsx');
    writeBalanceWorkbook({
      templateFilePath: TEMPLATE_PATH,
      records: [],
      templateFields: headers,
      outputFilePath: headerOnlyPath
    });
    assert.equal(workbookDimension(headerOnlyPath), 'A1:I2');
    assert.deepEqual(await strictRows(headerOnlyPath, headers.length), oldRawRows(headerOnlyPath));

    const fixture = createFixture(dir, '00123');
    assert.equal(workbookDimension(fixture.sourcePath), 'A1:I2');
    assert.deepEqual(await strictRows(fixture.sourcePath, headers.length), oldRawRows(fixture.sourcePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict dimension used range计入merge、styled blank、formula cached与multi-letter trailing cell', async () => {
  const dir = tempDir();
  try {
    const mergedPath = await writeSyntheticWorkbook(
      dir,
      'dimension-merged',
      `${WORKSHEET_OPEN}<dimension ref="A1:C1"/><sheetData>` +
        '<row r="1"><c r="A1" t="str"><v>merged</v></c></row></sheetData>' +
        '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>'
    );
    assert.deepEqual(await strictRows(mergedPath, 3), oldRawRows(mergedPath));

    const mixedPath = await writeSyntheticWorkbook(
      dir,
      'dimension-mixed-used-range',
      `${WORKSHEET_OPEN}<dimension ref="A1:AA3"/><sheetData>` +
        '<row r="1"><c r="A1" t="str"><v>start</v></c></row>' +
        '<row r="2"><c r="K2"><f>1+1</f><v>2</v></c></row>' +
        '<row r="3"><c r="AA3" s="1"/></row></sheetData></worksheet>'
    );
    assert.deepEqual(await strictRows(mixedPath, 27), oldRawRows(mixedPath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict typed projection与旧SheetJS raw oracle覆盖全部合法cell type/formula cached', async () => {
  const dir = tempDir();
  try {
    const headers = Array.from({ length: 16 }, (_, index) => (
      `<c r="${XLSX.utils.encode_col(index)}1" t="inlineStr"><is><t>H${index}</t></is></c>`
    )).join('');
    const sheetXml = `${WORKSHEET_OPEN}<dimension ref="A1:P2"/><sheetData>` +
      `<row r="1">${headers}</row><row r="2">` +
      '<c r="A2"><v>0</v></c>' +
      '<c r="B2" t="n"><v>-1</v></c>' +
      '<c r="C2" t="n"><v>1.25</v></c>' +
      '<c r="D2" t="n"><v>1e3</v></c>' +
      '<c r="E2" t="b"><v>1</v></c>' +
      '<c r="F2" t="b"><v>0</v></c>' +
      '<c r="G2" t="d"><v>2020-01-02T00:00:00Z</v></c>' +
      '<c r="H2" t="s"><v>0</v></c>' +
      '<c r="I2" t="inlineStr"><is><r><t>A&amp;</t></r>' +
      '<rPh sb="0" eb="1"><t>ignored-phonetic</t></rPh><r><t>B</t></r></is></c>' +
      '<c r="J2" t="str"><v>00123</v></c>' +
      '<c r="K2"><f>1+1</f><v>2</v></c>' +
      '<c r="L2" t="str"><f>&quot;x&quot;</f><v>cached</v></c>' +
      '<c r="M2" t="e"><v>#DIV/0!</v></c>' +
      '<c r="N2" t="e"><v>#NULL!</v></c>' +
      '<c r="O2" t="b"><v>true</v></c>' +
      '<c r="P2" t="b"><v>false</v></c>' +
      '</row></sheetData></worksheet>';
    const filePath = await writeSyntheticWorkbook(dir, 'typed-matrix', sheetXml);
    await mutateSharedStrings(filePath, (xml) => xml.replace(
      '<si><t>shared-zero</t></si>',
      '<si><r><t>shared-</t></r><rPh sb="0" eb="1"><t>ignored-phonetic</t></rPh>' +
        '<r><t>zero</t></r></si>'
    ));
    assert.deepEqual(await strictRows(filePath, 16), oldRawRows(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict projection与旧oracle保持XML实体、多字母列、blank/missing/sparse rows/cells等价', async () => {
  const dir = tempDir();
  try {
    const sheetXml = `${WORKSHEET_OPEN}<dimension ref="A1:AA5"/><sheetData>` +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>A&amp;&lt;&#x41;</t></is></c>' +
      '<c r="AA1" t="str"><v>AA</v></c></row>' +
      '<row r="2"><c r="B2"/><c r="D2" t="str"></c></row>' +
      '<row r="3"/>' +
      '<row r="5"><c r="A5" t="n"><v>0</v></c><c r="AA5" t="inlineStr"><is><t>Z</t></is></c></row>' +
      '</sheetData></worksheet>';
    const filePath = await writeSyntheticWorkbook(dir, 'sparse-matrix', sheetXml);
    assert.deepEqual(await strictRows(filePath, 27), oldRawRows(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict projection拒绝row/cell缺失、重复、乱序、错位和Excel范围越界坐标', async () => {
  const dir = tempDir();
  const invalidRows = [
    '<row><c r="A1" t="str"><v>x</v></c></row>',
    '<row r="0"><c r="A0" t="str"><v>x</v></c></row>',
    '<row r="2"/><row r="2"/>',
    '<row r="3"/><row r="2"/>',
    '<row r="1048577"/>',
    '<row r="2"><c t="str"><v>x</v></c></row>',
    '<row r="2"><c r="A3" t="str"><v>x</v></c></row>',
    '<row r="2"><c r="A2" t="str"><v>x</v></c><c r="A2" t="str"><v>y</v></c></row>',
    '<row r="2"><c r="B2" t="str"><v>x</v></c><c r="A2" t="str"><v>y</v></c></row>',
    '<row r="2"><c r="XFE2" t="str"><v>x</v></c></row>',
    '<row r="2"><c r="a2" t="str"><v>x</v></c></row>',
    '<row r="2"><c r="A2x" t="str"><v>x</v></c></row>'
  ];
  try {
    for (const [index, rowXml] of invalidRows.entries()) {
      const filePath = await writeSyntheticWorkbook(
        dir,
        `invalid-coordinate-${index}`,
        `${WORKSHEET_OPEN}<dimension ref="A1:B2"/><sheetData>${rowXml}</sheetData></worksheet>`
      );
      await assert.rejects(
        strictRows(filePath, 9),
        (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_COORDINATE_INVALID'
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict projection拒绝shared越界、非法type payload、非有限/unsafe数值和无cache公式', async () => {
  const dir = tempDir();
  const invalidCells = [
    '<c r="A1" t="s"><v>9</v></c>',
    '<c r="A1" t="s"><v>-1</v></c>',
    '<c r="A1" t="n"><v>NaN</v></c>',
    '<c r="A1" t="n"><v>Infinity</v></c>',
    '<c r="A1" t="n"><v>9007199254740992</v></c>',
    '<c r="A1" t="n"><v>1x</v></c>',
    '<c r="A1" t="b"><v>2</v></c>',
    '<c r="A1" t="d"><v>not-a-date</v></c>',
    '<c r="A1" t="e"><v>#UNKNOWN!</v></c>',
    '<c r="A1" t="unknown"><v>x</v></c>',
    '<c r="A1"><f>1+1</f></c>',
    '<c r="A1"><is><t>x</t></is></c>',
    '<c r="A1" t="inlineStr"><v>x</v><is><t>x</t></is></c>'
  ];
  try {
    for (const [index, cellXml] of invalidCells.entries()) {
      const filePath = await writeSyntheticWorkbook(
        dir,
        `invalid-cell-${index}`,
        `${WORKSHEET_OPEN}<dimension ref="A1"/><sheetData>` +
          `<row r="1">${cellXml}</row></sheetData></worksheet>`
      );
      await assert.rejects(
        strictRows(filePath, 9),
        (error) => ['NEW_ACCOUNT_WORKBOOK_CELL_INVALID', 'NEW_ACCOUNT_WORKBOOK_SHARED_STRING_INVALID']
          .includes(error.code)
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict projection拒绝截断XML与未知实体', async () => {
  const dir = tempDir();
  const invalidXml = [
    `${WORKSHEET_OPEN}<dimension ref="A1"/><sheetData>` +
      '<row r="1"><c r="A1" t="str"><v>x</v></c>',
    `${WORKSHEET_OPEN}<dimension ref="A1"/><sheetData>` +
      '<row r="1"><c r="A1" t="str"><v>&unknown;</v></c></row>' +
      '</sheetData></worksheet>',
    '<notWorksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1"/><sheetData/></notWorksheet>',
    `${WORKSHEET_OPEN}<dimension ref="A1"/><wrapper><sheetData/></wrapper></worksheet>`,
    `${WORKSHEET_OPEN}<dimension ref="A1"/><sheetData><unknown/></sheetData></worksheet>`
  ];
  try {
    for (const [index, sheetXml] of invalidXml.entries()) {
      const filePath = await writeSyntheticWorkbook(dir, `invalid-xml-${index}`, sheetXml);
      await assert.rejects(
        strictRows(filePath, 9),
        (error) => error.code === 'NEW_ACCOUNT_WORKBOOK_XML_INVALID'
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
