'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../../src/backend/vcc-financial-op-db/migrations');
const repository = require('../../../../src/backend/vcc-financial-op-db/repository');
const {
  SOURCE_TYPES,
  SUPPORTED_CURRENCIES,
  SYSTEM_OP_HEADERS
} = require('../../../../src/backend/vcc-financial-op/definitions');
const { inspectSourceFile } = require('../../../../src/backend/vcc-financial-op/workbook-reader');
const {
  serializeError,
  deserializeError
} = require('../../../../src/main-process/serialize-error');
const {
  systemAmountRead,
  systemBalanceLexicalTokens,
  readSystemOpSnapshots,
  importSystemOpGroup,
  systemRecordResult
} = require('../../../../src/backend/vcc-financial-op/system-op-importer');
const { importFiles } = require('../../../../src/backend/vcc-financial-op/import-service');
const { hashSourceFiles } = require('../../../../src/backend/vcc-financial-op/source-lineage');

const TEMPLATE_PATH = path.join(
  __dirname,
  '../../../../assets/VCC财务OP校验/系统财务OP.xlsx'
);

function createDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  ensureVccFinancialOpTablesSupport(db);
  return db;
}

function tempDir(t, prefix = 'vcc-system-op-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function balances(seed = 1) {
  return Object.fromEntries(
    SUPPORTED_CURRENCIES.map((currency, index) => [currency, seed + index + 0.25])
  );
}

function sourceCurrency(currency) {
  return currency;
}

function systemDataRows(snapshots) {
  return snapshots.flatMap((snapshot) => {
    const currencies = snapshot.currencies || SUPPORTED_CURRENCIES;
    return currencies.map((currency) => ({
      账单日期: snapshot.date || '2026-05-31',
      主体: snapshot.subject,
      业务部门: snapshot.department === undefined ? 'VCC' : snapshot.department,
      币种: sourceCurrency(currency),
      OP发生额: 0,
      '发生额（入）': 0,
      '发生额（出）': 0,
      本期移除Pending金额: 0,
      调账金额: 0,
      OP期末余额: 0,
      pending余额: 0,
      费用项: 0,
      财务余额: snapshot.balances[currency],
      主体变动发生额: 0,
      财务主体余额: snapshot.balances[currency],
      创建时间: '2026-07-03 09:37:43'
    }));
  });
}

function writeWorkbook(t, {
  snapshots = [{ subject: 'PPHK', balances: balances() }],
  rows,
  headers = SYSTEM_OP_HEADERS,
  leadingRows = [],
  fileName = 'system-op.xlsx',
  sheetName = 'System',
  duplicateSheet = false,
  date1904 = false,
  mutateSheet
} = {}) {
  const dir = tempDir(t);
  const dataRows = rows || systemDataRows(snapshots);
  const matrix = [
    ...leadingRows,
    headers,
    ...dataRows.map((row) => headers.map((header) => (
      Object.hasOwn(row, header) ? row[header] : ''
    )))
  ];
  const workbook = XLSX.utils.book_new();
  if (date1904) workbook.Workbook = { WBProps: { date1904: true } };
  const sheet = XLSX.utils.aoa_to_sheet(matrix);
  if (typeof mutateSheet === 'function') mutateSheet(sheet, leadingRows.length + 2);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  if (duplicateSheet) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), `${sheetName}-2`);
  }
  const filePath = path.join(dir, fileName);
  XLSX.writeFile(workbook, filePath);
  return { filePath, sheetName };
}

async function rewriteWorksheetXml(filePath, transform, { relocateTo = '' } = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const sheetTag = workbookXml.match(/<sheet\b[^>]*>/)[0];
  const relationshipId = sheetTag.match(/\br:id="([^"]+)"/)[1];
  const relationshipsPath = 'xl/_rels/workbook.xml.rels';
  let relationshipsXml = await zip.file(relationshipsPath).async('string');
  const relationshipTag = relationshipsXml.match(new RegExp(
    `<Relationship\\b(?=[^>]*\\bId="${relationshipId}")[^>]*>`
  ))[0];
  const originalTarget = relationshipTag.match(/\bTarget="([^"]+)"/)[1];
  const originalEntry = originalTarget.startsWith('/')
    ? originalTarget.slice(1)
    : `xl/${originalTarget}`;
  const originalXml = await zip.file(originalEntry).async('string');
  const rewrittenXml = transform(originalXml);
  assert.notEqual(rewrittenXml, originalXml, 'worksheet XML fixture 必须实际发生变化');

  if (relocateTo) {
    const targetEntry = `xl/${relocateTo}`;
    const rewrittenRelationship = relationshipTag.replace(
      /\bTarget="[^"]+"/,
      `Target="${relocateTo}"`
    );
    relationshipsXml = relationshipsXml.replace(relationshipTag, rewrittenRelationship);
    zip.file(relationshipsPath, relationshipsXml);
    zip.remove(originalEntry);
    zip.file(targetEntry, rewrittenXml);
  } else {
    zip.file(originalEntry, rewrittenXml);
  }
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function replaceCellValue(xml, cellReference, rawToken) {
  const cellPattern = new RegExp(
    `(<c\\b(?=[^>]*\\br="${cellReference}")[^>]*>[\\s\\S]*?<v>)[^<]*(</v>[\\s\\S]*?</c>)`
  );
  assert.match(xml, cellPattern);
  return xml.replace(cellPattern, `$1${rawToken}$2`);
}

function duplicateCell(xml, cellReference) {
  const cellPattern = new RegExp(
    `(<c\\b(?=[^>]*\\br="${cellReference}")[^>]*>[\\s\\S]*?</c>)`
  );
  assert.match(xml, cellPattern);
  return xml.replace(cellPattern, '$1$1');
}

function importFile(entry) {
  return { filePath: entry.filePath, sheetName: entry.sheetName };
}

test('系统财务OP导入结果保留全部异常计数供界面汇总', () => {
  const result = systemRecordResult({
    id: 7,
    batch_id: 'batch-7',
    target_month: '2026-05',
    source_type: SOURCE_TYPES.SYSTEM_OP,
    status: 'failed_validation',
    raw_count: 2,
    inserted_count: 0,
    skipped_count: 0,
    invalid_key_count: 3,
    conflict_count: 4,
    format_error_count: 5,
    rolled_back_count: 6,
    error_message: '校验失败'
  });

  assert.equal(result.invalidKeyCount, 3);
  assert.equal(result.conflictCount, 4);
  assert.equal(result.formatErrorCount, 5);
  assert.equal(result.rolledBackCount, 6);
});

test('系统财务OP正式资产逐列表头与识别契约一致', async () => {
  const workbook = XLSX.readFile(TEMPLATE_PATH);
  assert.equal(workbook.SheetNames.length, 1);
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    raw: false,
    defval: ''
  });
  assert.deepEqual(matrix[0], SYSTEM_OP_HEADERS);

  const inspected = await inspectSourceFile(TEMPLATE_PATH);
  assert.equal(inspected.sourceType, SOURCE_TYPES.SYSTEM_OP);
  assert.equal(inspected.headerRow, 1);
  assert.equal(inspected.requiresSubject, false);
});

test('系统财务OP按正式行式模板读取主体、九币种和完整原始血缘', (t) => {
  const entry = writeWorkbook(t);
  const snapshots = readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName);
  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.equal(snapshot.targetMonth, '2026-05');
  assert.equal(snapshot.subject, 'PPHK');
  assert.equal(snapshot.sourceRow, 2);
  assert.equal(snapshot.balances.AUD, '1.25');
  assert.equal(snapshot.balances.CNY, '3.25');
  assert.equal(snapshot.balances.USD, '9.25');
  const raw = JSON.parse(snapshot.rawJson);
  assert.deepEqual(raw.displayHeaders, SYSTEM_OP_HEADERS);
  assert.equal(raw.rows.length, 9);
  const cny = raw.rows.find((row) => row.sourceCurrency === 'CNY');
  assert.equal(cny.normalizedCurrency, 'CNY');
  assert.equal(Object.hasOwn(snapshot.balances, 'CNH'), false);
});

test('系统财务OP财务余额严格优先使用 Excel raw 数值并记录显示差异', (t) => {
  const input = balances();
  input.AUD = 123.45;
  const entry = writeWorkbook(t, {
    snapshots: [{ subject: 'PPHK', balances: input }],
    mutateSheet(sheet, firstDataRow) {
      const ref = XLSX.utils.encode_cell({ r: firstDataRow - 1, c: 12 });
      sheet[ref].z = '0.0';
    }
  });
  const [snapshot] = readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName);
  assert.equal(snapshot.balances.AUD, '123.45');
  const raw = JSON.parse(snapshot.rawJson);
  const aud = raw.rows.find((row) => row.normalizedCurrency === 'AUD');
  assert.equal(aud.balanceEvidence.source, 'raw-numeric');
  assert.equal(aud.balanceEvidence.canonicalValue, '123.45');
  assert.equal(aud.balanceEvidence.auditCode, 'amount-display-raw-mismatch');
});

test('系统财务OP raw-first 覆盖大额两位小数、公式缓存、文本会计负数和横线零值', (t) => {
  const input = balances();
  input.AUD = 135886024.59;
  input.CAD = '(1,234.56)';
  input.CNY = '-';
  input.EUR = 3.25;
  const entry = writeWorkbook(t, {
    snapshots: [{ subject: 'PPHK', balances: input }],
    mutateSheet(sheet, firstDataRow) {
      const aud = XLSX.utils.encode_cell({ r: firstDataRow - 1, c: 12 });
      sheet[aud].z = '0.0';
      const eur = XLSX.utils.encode_cell({ r: firstDataRow + 2, c: 12 });
      sheet[eur] = { t: 'n', f: '1+2.25', v: 3.25, z: 'General' };
    }
  });
  const [snapshot] = readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName);
  assert.equal(snapshot.balances.AUD, '135886024.59');
  assert.equal(snapshot.balances.CAD, '-1234.56');
  assert.equal(snapshot.balances.CNY, '0');
  assert.equal(snapshot.balances.EUR, '3.25');
  const raw = JSON.parse(snapshot.rawJson);
  const eur = raw.rows.find((row) => row.normalizedCurrency === 'EUR');
  assert.equal(eur.balanceEvidence.rawTokenSource, 'ooxml-worksheet-v');
  assert.equal(eur.balanceEvidence.rawLexicalToken, '3.25');
});

test('系统财务OP直接按 worksheet v token 拒绝正负超精度值，避免 SheetJS Number 先吞分币', async (t) => {
  for (const [fileName, rawToken] of [
    ['positive-cent-loss.xlsx', '90071992547409.91'],
    ['negative-cent-loss.xlsx', '-90071992547409.91']
  ]) {
    const entry = writeWorkbook(t, { fileName });
    await rewriteWorksheetXml(
      entry.filePath,
      (xml) => replaceCellValue(xml, 'M2', rawToken)
    );
    let caught = null;
    assert.throws(
      () => readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName),
      (error) => {
        caught = error;
        return error.code === 'amount-precision-invalid'
          && /15 位有效数字/.test(error.message);
      }
    );
    const restored = deserializeError(serializeError(caught));
    assert.equal(restored.code, 'amount-precision-invalid');
    assert.deepEqual(restored.context, {
      sourceRow: 2,
      fieldName: '财务余额',
      sheetName: entry.sheetName
    });
  }
});

test('系统财务OP通过 workbook relationship 定位 worksheet，并保留合法精度边界 lexical 证据', async (t) => {
  const entry = writeWorkbook(t, { fileName: 'lexical-boundary.xlsx' });
  await rewriteWorksheetXml(
    entry.filePath,
    (xml) => replaceCellValue(xml, 'M2', '9999999999999.99'),
    { relocateTo: 'worksheets/sheet7.xml' }
  );
  const [snapshot] = readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName);
  assert.equal(snapshot.balances.AUD, '9999999999999.99');
  const raw = JSON.parse(snapshot.rawJson);
  const aud = raw.rows.find((row) => row.normalizedCurrency === 'AUD');
  assert.equal(aud.balanceEvidence.rawTokenSource, 'ooxml-worksheet-v');
  assert.equal(aud.balanceEvidence.rawLexicalToken, '9999999999999.99');
  assert.equal(aud.balanceEvidence.canonicalValue, '9999999999999.99');
});

test('系统财务OP缺少 OOXML lexical 时仅允许可证明分币安全的 Number fallback', () => {
  const safe = systemAmountRead('123.45', 123.45, { label: 'fallback-safe' });
  assert.equal(safe.canonicalValue, '123.45');
  assert.equal(safe.evidence.rawTokenSource, 'sheetjs-number-fallback');
  const safeFifteenDigitInteger = systemAmountRead(
    '999999999999999',
    999999999999999,
    { label: 'fallback-safe-integer' }
  );
  assert.equal(safeFifteenDigitInteger.canonicalValue, '999999999999999');
  assert.equal(safeFifteenDigitInteger.evidence.rawTokenSource, 'sheetjs-number-fallback');
  assert.throws(
    () => systemAmountRead('90071992547409.9', 90071992547409.9, { label: 'fallback-unsafe' }),
    (error) => error.code === 'amount-precision-invalid'
      && /无法保证两位小数精度/.test(error.message)
  );
});

test('系统财务OP worksheet 重复财务余额 cell 时稳定失败关闭而不回退 Number', async (t) => {
  const entry = writeWorkbook(t, { fileName: 'duplicate-balance-cell.xlsx' });
  await rewriteWorksheetXml(
    entry.filePath,
    (xml) => duplicateCell(xml, 'M2')
  );
  assert.throws(
    () => readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName),
    (error) => {
      assert.equal(error.code, 'amount-precision-invalid');
      assert.match(error.message, /第 2 行财务余额单元格重复/);
      assert.equal(error.context.sourceRow, 2);
      return true;
    }
  );
});

test('系统财务OP worksheet XML 为空或结构损坏时返回稳定精度错误及定位上下文', () => {
  const workbook = {
    Workbook: { Sheets: [{ name: 'System', id: 'rId1' }] },
    files: {
      'xl/_rels/workbook.xml.rels': {
        content: Buffer.from([
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1"',
          ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"',
          ' Target="worksheets/sheet1.xml"/>',
          '</Relationships>'
        ].join(''))
      },
      'xl/worksheets/sheet1.xml': {
        content: Buffer.alloc(0)
      }
    }
  };
  for (const worksheetXml of ['', '<worksheet><sheetData>']) {
    workbook.files['xl/worksheets/sheet1.xml'].content = Buffer.from(worksheetXml);
    assert.throws(
      () => systemBalanceLexicalTokens(workbook, 'System'),
      (error) => {
        assert.equal(error.code, 'amount-precision-invalid');
        assert.match(error.message, /worksheet XML 结构无效/);
        assert.equal(error.context.sheetName, 'System');
        assert.equal(error.context.entryPath, 'xl/worksheets/sheet1.xml');
        return true;
      }
    );
  }
});

test('系统财务OP raw 数值超过两位小数或安全范围时拒绝且不舍入', (t) => {
  for (const [fileName, invalidValue] of [
    ['three-decimals.xlsx', 1.234],
    ['unsafe-number.xlsx', Number.MAX_SAFE_INTEGER + 1]
  ]) {
    const input = balances();
    input.AUD = invalidValue;
    const entry = writeWorkbook(t, {
      snapshots: [{ subject: 'PPHK', balances: input }],
      fileName
    });
    assert.throws(
      () => readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName),
      (error) => error.code === 'amount-precision-invalid'
    );
  }
});

test('系统财务OP表头位于第 20 行之后时识别和正式导入仍使用同一范围', async (t) => {
  const leadingRows = Array.from({ length: 24 }, (_unused, index) => [`说明 ${index + 1}`]);
  const entry = writeWorkbook(t, { leadingRows, fileName: 'late-header.xlsx' });
  const inspected = await inspectSourceFile(entry.filePath);
  assert.equal(inspected.headerRow, 25);
  const [snapshot] = readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName);
  assert.equal(snapshot.sourceRow, 26);
});

test('系统财务OP缺列、多列或调换顺序均给出正式模板差异提示', async (t) => {
  const variants = [];
  variants.push(writeWorkbook(t, {
    headers: SYSTEM_OP_HEADERS.filter((header) => header !== '财务余额'),
    fileName: 'missing-header.xlsx'
  }));
  variants.push(writeWorkbook(t, {
    headers: [...SYSTEM_OP_HEADERS, '额外列'],
    fileName: 'extra-header.xlsx'
  }));
  const swapped = [...SYSTEM_OP_HEADERS];
  [swapped[12], swapped[13]] = [swapped[13], swapped[12]];
  variants.push(writeWorkbook(t, { headers: swapped, fileName: 'swapped-header.xlsx' }));

  for (const entry of variants) {
    await assert.rejects(
      inspectSourceFile(entry.filePath),
      (error) => {
        assert.match(error.message, /系统财务OP表头与正式模板不一致/);
        assert.ok(error.detailLines.some((line) => line.includes('系统财务OP.xlsx')));
        assert.ok(error.detailLines.some((line) => line.includes('第 ')));
        return true;
      }
    );
    assert.throws(
      () => readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName),
      (error) => {
        assert.match(error.message, /系统财务OP表头与正式模板不一致/);
        assert.ok(error.detailLines.some((line) => line.includes('系统财务OP.xlsx')));
        assert.ok(error.detailLines.some((line) => line.includes('第 ')));
        return true;
      }
    );
  }
});

test('旧 YYMMOP 横表不再被系统财务OP宽松识别', async (t) => {
  const dir = tempDir(t, 'vcc-system-op-legacy-');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['', '', ...SUPPORTED_CURRENCIES],
    ['', '2605OP', ...SUPPORTED_CURRENCIES.map(() => 0)],
    ['', '系统', ...SUPPORTED_CURRENCIES.map(() => 1)]
  ]), 'Legacy');
  const filePath = path.join(dir, 'legacy-system-op.xlsx');
  XLSX.writeFile(workbook, filePath);

  await assert.rejects(
    inspectSourceFile(filePath),
    (error) => {
      assert.match(error.message, /无法识别为 VCC 财务OP校验原表/);
      assert.ok(error.detailLines.some((line) => line.includes('旧 YYMMOP 横表不再支持')));
      return true;
    }
  );
});

test('同一工作簿存在多处系统财务OP表头时拒绝静默选第一处', async (t) => {
  const entry = writeWorkbook(t, { duplicateSheet: true, fileName: 'ambiguous-system.xlsx' });
  await assert.rejects(inspectSourceFile(entry.filePath), /检测到多处系统财务OP完整表头/);
  assert.throws(
    () => readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName),
    /正式导入时检测到多个可识别业务表/
  );
});

test('系统财务OP正式导入二次拒绝 1904 日期系统', (t) => {
  const entry = writeWorkbook(t, { date1904: true, fileName: 'date-1904.xlsx' });
  assert.throws(
    () => readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName),
    /暂不支持 1904 日期系统/
  );
});

test('系统财务OP按所选账期筛选，并支持一个文件形成多个主体快照', (t) => {
  const entry = writeWorkbook(t, {
    snapshots: [
      { subject: 'PPHK', date: '2026-04-30', balances: balances(50) },
      { subject: 'PPHK', date: '2026-05-31', balances: balances(1) },
      { subject: 'PPUS', date: '2026-05-31', balances: balances(20) }
    ]
  });
  const snapshots = readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.subject), ['PPHK', 'PPUS']);
  assert.equal(snapshots[0].balances.AUD, '1.25');
  assert.equal(snapshots[1].balances.AUD, '20.25');

  const db = createDb();
  t.after(() => db.close());
  repository.createImportBatch(db, { id: 'multi-subject', targetMonth: '2026-05', fileCount: 1 });
  const record = importSystemOpGroup({
    db,
    batchId: 'multi-subject',
    targetMonth: '2026-05',
    files: [importFile(entry)]
  });
  assert.equal(record.status, 'success');
  assert.equal(record.raw_count, 2);
  assert.equal(record.inserted_count, 2);
});

test('系统财务OP拒绝非法日期、非VCC部门、空主体和空财务余额', (t) => {
  const invalidCases = [
    {
      name: 'invalid-date.xlsx',
      snapshot: { subject: 'PPHK', date: 'not-a-date', balances: balances() },
      expected: /账单日期.*无法解析/
    },
    {
      name: 'wrong-department.xlsx',
      snapshot: { subject: 'PPHK', department: 'OTHER', balances: balances() },
      expected: /业务部门.*必须为 VCC/
    },
    {
      name: 'blank-subject.xlsx',
      snapshot: { subject: '', balances: balances() },
      expected: /主体.*不能为空/
    },
    {
      name: 'blank-balance.xlsx',
      snapshot: { subject: 'PPHK', balances: { ...balances(), AUD: '' } },
      expected: /财务余额.*值不能为空/
    }
  ];

  for (const invalid of invalidCases) {
    const entry = writeWorkbook(t, {
      snapshots: [invalid.snapshot],
      fileName: invalid.name
    });
    assert.throws(
      () => readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName),
      invalid.expected
    );
  }
});

test('系统财务OP缺失规范币种仍拒绝，CNH 作为 CNY 业务行且原始审计保留 CNH', (t) => {
  const missing = writeWorkbook(t, {
    snapshots: [{
      subject: 'PPHK',
      balances: balances(),
      currencies: SUPPORTED_CURRENCIES.filter((currency) => currency !== 'USD')
    }],
    fileName: 'missing-currency.xlsx'
  });
  assert.throws(
    () => readSystemOpSnapshots(missing.filePath, '2026-05', missing.sheetName),
    /缺少系统财务OP币种：USD/
  );

  const cnhRows = systemDataRows([{ subject: 'PPHK', balances: balances() }]);
  const cnhIndex = cnhRows.findIndex((row) => row.币种 === 'CNY');
  cnhRows[cnhIndex] = { ...cnhRows[cnhIndex], 币种: ' CNH ' };
  const cnhEntry = writeWorkbook(t, {
    rows: cnhRows,
    fileName: 'incoming-cnh.xlsx'
  });
  const [snapshot] = readSystemOpSnapshots(cnhEntry.filePath, '2026-05', cnhEntry.sheetName);
  assert.equal(snapshot.balances.CNY, '3.25');
  assert.equal(Object.hasOwn(snapshot.balances, 'CNH'), false);
  const raw = JSON.parse(snapshot.rawJson);
  const cnhAuditRow = raw.rows.find((row) => row.sourceCurrency === 'CNH');
  assert.equal(cnhAuditRow.normalizedCurrency, 'CNY');
  assert.equal(cnhAuditRow.displayValues[SYSTEM_OP_HEADERS.indexOf('币种')], ' CNH ');

  const lowerRows = systemDataRows([{ subject: 'PPHK', balances: balances() }]);
  lowerRows[cnhIndex] = { ...lowerRows[cnhIndex], 币种: 'cnh' };
  const lowerCnh = writeWorkbook(t, { rows: lowerRows, fileName: 'lower-cnh.xlsx' });
  assert.throws(
    () => readSystemOpSnapshots(lowerCnh.filePath, '2026-05', lowerCnh.sheetName),
    /币种.*cnh.*仅允许|币种.*仅允许.*cnh/
  );
  const mixedRows = systemDataRows([{ subject: 'PPHK', balances: balances() }]);
  mixedRows[cnhIndex] = { ...mixedRows[cnhIndex], 币种: 'Cnh' };
  const mixedCnh = writeWorkbook(t, { rows: mixedRows, fileName: 'mixed-cnh.xlsx' });
  assert.throws(
    () => readSystemOpSnapshots(mixedCnh.filePath, '2026-05', mixedCnh.sheetName),
    /币种.*Cnh.*仅允许|币种.*仅允许.*Cnh/
  );
});

test('系统 OP 同主体 CNY+CNH 归一后仅拒绝该主体，其他完整主体继续', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const badRows = systemDataRows([{ subject: 'PPHK', balances: balances() }]);
  const cnyRow = badRows.find((row) => row.币种 === 'CNY');
  badRows.push({ ...cnyRow, 币种: 'CNH' });
  const goodRows = systemDataRows([{ subject: 'PPUS', balances: balances(20) }]);
  const entry = writeWorkbook(t, {
    rows: [...badRows, ...goodRows],
    fileName: 'duplicate-normalized-cny.xlsx'
  });

  repository.createImportBatch(db, {
    id: 'duplicate-normalized-cny', targetMonth: '2026-05', fileCount: 1
  });
  const record = importSystemOpGroup({
    db,
    batchId: 'duplicate-normalized-cny',
    targetMonth: '2026-05',
    files: [importFile(entry)]
  });

  assert.equal(record.status, 'success_with_skips');
  assert.equal(record.raw_count, 2);
  assert.equal(record.inserted_count, 1);
  assert.equal(record.format_error_count, 1);
  assert.equal(record.rolled_back_count, 0);
  assert.deepEqual(
    db.prepare('SELECT subject FROM vcc_fin_op_system_snapshots ORDER BY subject')
      .all().map((row) => row.subject),
    ['PPUS']
  );
  const anomaly = db.prepare(`
    SELECT category, source_row, abnormal_fields_json, description
    FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
  `).get(record.id);
  assert.equal(anomaly.category, 'format_error');
  assert.deepEqual(JSON.parse(anomaly.abnormal_fields_json), ['币种']);
  assert.match(anomaly.description, /币种 CNY.*重复/);
  const rejectedAudit = db.prepare(`
    SELECT disposition, raw_json FROM vcc_fin_op_system_snapshot_attempts
    WHERE import_record_id = ? AND subject = 'PPHK'
  `).get(record.id);
  assert.equal(rejectedAudit.disposition, 'rolled_back');
  const auditRows = JSON.parse(rejectedAudit.raw_json).rows;
  assert.ok(auditRows.some((row) => row.sourceCurrency === 'CNY' && row.normalizedCurrency === 'CNY'));
  assert.ok(auditRows.some((row) => row.sourceCurrency === 'CNH' && row.normalizedCurrency === 'CNY'));
});

test('系统 OP 跨文件同主体 CNY+CNH 无论余额是否相同均主体级拒绝，完整其他主体继续', (t) => {
  for (const [suffix, cnhSeed] of [['same', 1], ['different', 99]]) {
    const db = createDb();
    t.after(() => db.close());
    const cny = writeWorkbook(t, {
      snapshots: [{ subject: 'PPHK', balances: balances(1) }],
      fileName: `cross-file-cny-${suffix}.xlsx`
    });
    const cnhRows = systemDataRows([{ subject: 'PPHK', balances: balances(cnhSeed) }]);
    const cnyIndex = cnhRows.findIndex((row) => row.币种 === 'CNY');
    cnhRows[cnyIndex] = { ...cnhRows[cnyIndex], 币种: 'CNH' };
    const cnh = writeWorkbook(t, {
      rows: cnhRows,
      fileName: `cross-file-cnh-${suffix}.xlsx`
    });
    const good = writeWorkbook(t, {
      snapshots: [{ subject: 'PPUS', balances: balances(20) }],
      fileName: `cross-file-good-${suffix}.xlsx`
    });
    const batchId = `cross-file-normalized-duplicate-${suffix}`;
    repository.createImportBatch(db, { id: batchId, targetMonth: '2026-05', fileCount: 3 });

    const record = importSystemOpGroup({
      db,
      batchId,
      targetMonth: '2026-05',
      files: [importFile(cny), importFile(cnh), importFile(good)]
    });

    assert.equal(record.status, 'success_with_skips', suffix);
    assert.equal(record.raw_count, 2, suffix);
    assert.equal(record.inserted_count, 1, suffix);
    assert.equal(record.format_error_count, 1, suffix);
    assert.equal(record.conflict_count, 0, suffix);
    assert.deepEqual(
      db.prepare('SELECT subject FROM vcc_fin_op_system_snapshots ORDER BY subject')
        .all().map((row) => row.subject),
      ['PPUS'],
      suffix
    );
    const anomaly = db.prepare(`
      SELECT category, description FROM vcc_fin_op_import_anomalies
      WHERE import_record_id = ?
    `).get(record.id);
    assert.equal(anomaly.category, 'format_error', suffix);
    assert.match(anomaly.description, /CNH 归一为 CNY.*同批 CNY 重复/, suffix);
    const rejectedAudits = db.prepare(`
      SELECT disposition, raw_json FROM vcc_fin_op_system_snapshot_attempts
      WHERE import_record_id = ? AND subject = 'PPHK' ORDER BY id
    `).all(record.id);
    assert.equal(rejectedAudits.length, 2, suffix);
    assert.ok(rejectedAudits.every((row) => row.disposition === 'rolled_back'), suffix);
    const sourceTokens = rejectedAudits.flatMap((row) => (
      JSON.parse(row.raw_json).rows.map((auditRow) => auditRow.sourceCurrency)
    ));
    assert.ok(sourceTokens.includes('CNY') && sourceTokens.includes('CNH'), suffix);
  }
});

test('系统 OP 跨文件软错主体仍参与 CNY/CNH 并集且完整同主体不会旁路提升', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const cny = writeWorkbook(t, {
    snapshots: [{ subject: 'PPHK', balances: balances(1) }],
    fileName: 'soft-error-cny.xlsx'
  });
  const cnhRows = systemDataRows([{ subject: 'PPHK', balances: balances(1) }]);
  const cnyIndex = cnhRows.findIndex((row) => row.币种 === 'CNY');
  const usdIndex = cnhRows.findIndex((row) => row.币种 === 'USD');
  cnhRows[cnyIndex] = { ...cnhRows[cnyIndex], 币种: 'CNH' };
  cnhRows[usdIndex] = { ...cnhRows[usdIndex], 财务余额: '' };
  const softError = writeWorkbook(t, {
    rows: cnhRows,
    fileName: 'soft-error-cnh.xlsx'
  });
  const good = writeWorkbook(t, {
    snapshots: [{ subject: 'PPUS', balances: balances(20) }],
    fileName: 'soft-error-good.xlsx'
  });
  repository.createImportBatch(db, {
    id: 'soft-error-normalized-duplicate', targetMonth: '2026-05', fileCount: 3
  });

  const record = importSystemOpGroup({
    db,
    batchId: 'soft-error-normalized-duplicate',
    targetMonth: '2026-05',
    files: [importFile(cny), importFile(softError), importFile(good)]
  });

  assert.equal(record.status, 'success_with_skips');
  assert.equal(record.raw_count, 2);
  assert.equal(record.inserted_count, 1);
  assert.equal(record.format_error_count, 1);
  assert.deepEqual(
    db.prepare('SELECT subject FROM vcc_fin_op_system_snapshots ORDER BY subject')
      .all().map((row) => row.subject),
    ['PPUS']
  );
  const rejectedAudits = db.prepare(`
    SELECT raw_json FROM vcc_fin_op_system_snapshot_attempts
    WHERE import_record_id = ? AND subject = 'PPHK' ORDER BY id
  `).all(record.id);
  assert.equal(rejectedAudits.length, 2);
  const auditRows = rejectedAudits.flatMap((row) => JSON.parse(row.raw_json).rows);
  assert.equal(auditRows.length, 18);
  assert.ok(auditRows.some((row) => row.sourceCurrency === 'CNY'));
  assert.ok(auditRows.some((row) => row.sourceCurrency === 'CNH'));
  assert.ok(auditRows.every((row) => row.normalizedCurrency !== 'CNH'));
  const rejectedUsd = auditRows.find((row) => (
    row.sourceCurrency === 'USD'
    && row.displayValues[SYSTEM_OP_HEADERS.indexOf('财务余额')] === ''
  ));
  assert.equal(rejectedUsd.normalizedCurrency, 'USD');
  assert.match(rejectedUsd.balanceEvidence.validationMessage, /财务余额.*无效/);
});

test('系统 OP 模板外列异常先保留标准列审计并拒绝同主体全部快照', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const badRows = systemDataRows([{ subject: 'PPHK', balances: balances(1) }]);
  const cnyRow = badRows.find((row) => row.币种 === 'CNY');
  badRows.push({ ...cnyRow, 币种: 'CNH' });
  const goodRows = systemDataRows([{ subject: 'PPUS', balances: balances(20) }]);
  const allRows = [...badRows, ...goodRows];
  const cnhSourceRow = 1 + badRows.length;
  const entry = writeWorkbook(t, {
    rows: allRows,
    fileName: 'extra-column-cnh-audit.xlsx',
    mutateSheet(sheet) {
      sheet[`Q${cnhSourceRow}`] = { t: 's', v: 'extra-value' };
      sheet['!ref'] = `A1:Q${allRows.length + 1}`;
    }
  });
  repository.createImportBatch(db, {
    id: 'extra-column-cnh-audit', targetMonth: '2026-05', fileCount: 1
  });

  const record = importSystemOpGroup({
    db,
    batchId: 'extra-column-cnh-audit',
    targetMonth: '2026-05',
    files: [importFile(entry)]
  });

  assert.equal(record.status, 'success_with_skips');
  assert.equal(record.raw_count, 2);
  assert.equal(record.inserted_count, 1);
  assert.equal(record.format_error_count, 1);
  assert.deepEqual(
    db.prepare('SELECT subject FROM vcc_fin_op_system_snapshots ORDER BY subject')
      .all().map((row) => row.subject),
    ['PPUS']
  );
  const rejected = db.prepare(`
    SELECT disposition, raw_json FROM vcc_fin_op_system_snapshot_attempts
    WHERE import_record_id = ? AND subject = 'PPHK'
  `).get(record.id);
  assert.equal(rejected.disposition, 'rolled_back');
  const auditRows = JSON.parse(rejected.raw_json).rows;
  assert.equal(auditRows.length, 10);
  assert.ok(auditRows.some((row) => (
    row.sourceCurrency === 'CNY' && row.normalizedCurrency === 'CNY'
  )));
  assert.ok(auditRows.some((row) => (
    row.sourceCurrency === 'CNH' && row.normalizedCurrency === 'CNY'
  )));
  const extraAnomaly = db.prepare(`
    SELECT source_row, abnormal_fields_json FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND description LIKE '%模板外%'
  `).get(record.id);
  assert.equal(extraAnomaly.source_row, cnhSourceRow);
  assert.deepEqual(JSON.parse(extraAnomaly.abnormal_fields_json), ['第17列']);
});

test('系统 OP 非目标月、非法日期或目标月空主体的模板外列保持单条 unknown 基线异常', (t) => {
  const cases = [
    {
      suffix: 'other-month',
      row: { date: '2026-04-30', subject: 'PPHK' }
    },
    {
      suffix: 'invalid-date',
      row: { date: 'bad-date', subject: 'PPHK' }
    },
    {
      suffix: 'blank-subject',
      row: { date: '2026-05-31', subject: '' }
    }
  ];
  for (const testCase of cases) {
    const db = createDb();
    t.after(() => db.close());
    const goodRows = systemDataRows([{ subject: 'PPUS', balances: balances(20) }]);
    const extraRow = {
      ...systemDataRows([{ subject: testCase.row.subject, balances: balances(1) }])[0],
      账单日期: testCase.row.date,
      主体: testCase.row.subject
    };
    const rows = [...goodRows, extraRow];
    const sourceRow = rows.length + 1;
    const entry = writeWorkbook(t, {
      rows,
      fileName: `extra-column-${testCase.suffix}.xlsx`,
      mutateSheet(sheet) {
        sheet[`Q${sourceRow}`] = { t: 's', v: 'extra-value' };
        sheet['!ref'] = `A1:Q${sourceRow}`;
      }
    });
    const batchId = `extra-column-${testCase.suffix}`;
    repository.createImportBatch(db, { id: batchId, targetMonth: '2026-05', fileCount: 1 });

    const record = importSystemOpGroup({
      db,
      batchId,
      targetMonth: '2026-05',
      files: [importFile(entry)]
    });

    assert.equal(record.status, 'success_with_skips', testCase.suffix);
    assert.equal(record.raw_count, 2, testCase.suffix);
    assert.equal(record.inserted_count, 1, testCase.suffix);
    assert.equal(record.format_error_count, 1, testCase.suffix);
    assert.equal(record.anomaly_count, 1, testCase.suffix);
    assert.deepEqual(
      db.prepare('SELECT subject FROM vcc_fin_op_system_snapshots').all().map((row) => row.subject),
      ['PPUS'],
      testCase.suffix
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshot_attempts
      WHERE import_record_id = ? AND subject = 'PPHK'
    `).get(record.id).n, 0, testCase.suffix);
    const anomaly = db.prepare(`
      SELECT category, source_row, abnormal_fields_json, description
      FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
    `).get(record.id);
    assert.equal(anomaly.category, 'format_error', testCase.suffix);
    assert.equal(anomaly.source_row, sourceRow, testCase.suffix);
    assert.deepEqual(JSON.parse(anomaly.abnormal_fields_json), ['第17列'], testCase.suffix);
    assert.match(anomaly.description, /模板外的第 17 列/, testCase.suffix);
  }
});

test('系统 OP 跨文件纯 CNY 或纯 CNH 重复维持既有幂等分类，不误判归一双写', (t) => {
  for (const sourceToken of ['CNY', 'CNH']) {
    const db = createDb();
    t.after(() => db.close());
    const makeRows = () => {
      const rows = systemDataRows([{ subject: 'PPHK', balances: balances() }]);
      if (sourceToken === 'CNH') {
        const index = rows.findIndex((row) => row.币种 === 'CNY');
        rows[index] = { ...rows[index], 币种: 'CNH' };
      }
      return rows;
    };
    const first = writeWorkbook(t, {
      rows: makeRows(), fileName: `pure-${sourceToken}-first.xlsx`
    });
    const second = writeWorkbook(t, {
      rows: makeRows(), fileName: `pure-${sourceToken}-second.xlsx`
    });
    const batchId = `pure-${sourceToken}-duplicates`;
    repository.createImportBatch(db, { id: batchId, targetMonth: '2026-05', fileCount: 2 });

    const record = importSystemOpGroup({
      db, batchId, targetMonth: '2026-05', files: [importFile(first), importFile(second)]
    });

    assert.equal(record.status, 'success_with_skips', sourceToken);
    assert.equal(record.raw_count, 2, sourceToken);
    assert.equal(record.inserted_count, 1, sourceToken);
    assert.equal(record.skipped_count, 1, sourceToken);
    assert.equal(record.format_error_count, 0, sourceToken);
    assert.equal(record.conflict_count, 0, sourceToken);
  }
});

test('系统 OP 历史 CNY 与新 CNH 规范余额相同则幂等跳过且不改历史审计', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const cnyEntry = writeWorkbook(t, { fileName: 'system-cny.xlsx' });
  const cnhRows = systemDataRows([{ subject: 'PPHK', balances: balances() }]);
  const cnyIndex = cnhRows.findIndex((row) => row.币种 === 'CNY');
  cnhRows[cnyIndex] = { ...cnhRows[cnyIndex], 币种: 'CNH' };
  const cnhEntry = writeWorkbook(t, { rows: cnhRows, fileName: 'system-cnh.xlsx' });

  repository.createImportBatch(db, { id: 'system-cny', targetMonth: '2026-05', fileCount: 1 });
  const first = importSystemOpGroup({
    db, batchId: 'system-cny', targetMonth: '2026-05', files: [importFile(cnyEntry)]
  });
  const original = db.prepare(`
    SELECT content_hash, raw_json FROM vcc_fin_op_system_snapshots WHERE subject = 'PPHK'
  `).get();
  repository.createImportBatch(db, { id: 'system-cnh', targetMonth: '2026-05', fileCount: 1 });
  const replay = importSystemOpGroup({
    db, batchId: 'system-cnh', targetMonth: '2026-05', files: [importFile(cnhEntry)]
  });

  assert.equal(first.status, 'success');
  assert.equal(replay.status, 'all_skipped');
  assert.equal(replay.skipped_count, 1);
  const stored = db.prepare(`
    SELECT content_hash, raw_json FROM vcc_fin_op_system_snapshots WHERE subject = 'PPHK'
  `).get();
  assert.equal(stored.content_hash, original.content_hash);
  assert.equal(stored.raw_json, original.raw_json);
  const replayAudit = db.prepare(`
    SELECT raw_json FROM vcc_fin_op_system_snapshot_attempts
    WHERE import_record_id = ? AND disposition = 'idempotent_skip'
  `).get(replay.id);
  assert.equal(
    JSON.parse(replayAudit.raw_json).rows.find((row) => row.sourceCurrency === 'CNH').normalizedCurrency,
    'CNY'
  );
});

test('系统财务OP同账期同主体同内容跳过，异内容冲突不覆盖', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const firstFile = writeWorkbook(t, { fileName: 'first.xlsx' });
  const sameFile = writeWorkbook(t, { fileName: 'same.xlsx' });
  const changedFile = writeWorkbook(t, {
    snapshots: [{ subject: 'PPHK', balances: { ...balances(), USD: 99.25 } }],
    fileName: 'changed.xlsx'
  });

  repository.createImportBatch(db, { id: 'b1', targetMonth: '2026-05', fileCount: 1 });
  const first = importSystemOpGroup({
    db, batchId: 'b1', targetMonth: '2026-05', files: [importFile(firstFile)]
  });
  repository.createImportBatch(db, { id: 'b2', targetMonth: '2026-05', fileCount: 1 });
  const same = importSystemOpGroup({
    db, batchId: 'b2', targetMonth: '2026-05', files: [importFile(sameFile)]
  });
  repository.createImportBatch(db, { id: 'b3', targetMonth: '2026-05', fileCount: 1 });
  const changed = importSystemOpGroup({
    db, batchId: 'b3', targetMonth: '2026-05', files: [importFile(changedFile)]
  });

  assert.equal(first.status, 'success');
  assert.equal(same.status, 'all_skipped');
  assert.equal(changed.status, 'failed_conflict');
  assert.equal(same.anomaly_count, 0);
  assert.equal(changed.anomaly_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots').get().n, 1);
  const stored = db.prepare('SELECT balances_json FROM vcc_fin_op_system_snapshots').get();
  assert.equal(JSON.parse(stored.balances_json).USD, '9.25');
  const accepted = db.prepare(`
    SELECT attempt.disposition, attempt.existing_snapshot_id,
           attempt.source_file, attempt.sheet_name, attempt.source_row,
           attempt.raw_json, snapshot.id AS snapshot_id
    FROM vcc_fin_op_system_snapshot_attempts attempt
    JOIN vcc_fin_op_system_snapshots snapshot
      ON snapshot.id = attempt.existing_snapshot_id
    WHERE attempt.disposition = 'accepted'
  `).get();
  assert.equal(accepted.disposition, 'accepted');
  assert.equal(accepted.existing_snapshot_id, accepted.snapshot_id);
  assert.equal(accepted.source_file, 'first.xlsx');
  assert.equal(accepted.sheet_name, firstFile.sheetName);
  assert.equal(accepted.source_row, 2);
  assert.ok(accepted.raw_json.includes('PPHK'));
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshot_attempts
    WHERE disposition = 'idempotent_skip'
  `).get().n, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshot_attempts
    WHERE disposition = 'idempotent_conflict'
  `).get().n, 1);
  const anomaly = db.prepare(`
    SELECT category, idempotency_key, abnormal_fields_json, diff_fields_json
    FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
  `).get(changed.id);
  assert.equal(anomaly.category, 'idempotent_conflict');
  assert.equal(anomaly.idempotency_key, 'PPHK');
  assert.deepEqual(JSON.parse(anomaly.abnormal_fields_json), ['财务余额']);
  assert.deepEqual(JSON.parse(anomaly.diff_fields_json), ['财务余额']);
});

test('系统财务OP校验表生成时间只随新增主体快照刷新', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const firstFile = writeWorkbook(t, { fileName: 'generated-system-first.xlsx' });
  const secondFile = writeWorkbook(t, {
    snapshots: [{ subject: 'PPUS', balances: balances(20) }],
    fileName: 'generated-system-second.xlsx'
  });

  repository.createImportBatch(db, { id: 'generated-system-1', targetMonth: '2026-05', fileCount: 1 });
  importSystemOpGroup({
    db,
    batchId: 'generated-system-1',
    targetMonth: '2026-05',
    files: [importFile(firstFile)]
  });
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET generated_at = '2000-01-01 00:00:00'
    WHERE target_month = '2026-05' AND dataset_type = ?
  `).run(SOURCE_TYPES.SYSTEM_OP);

  repository.createImportBatch(db, { id: 'generated-system-skip', targetMonth: '2026-05', fileCount: 1 });
  const skipped = importSystemOpGroup({
    db,
    batchId: 'generated-system-skip',
    targetMonth: '2026-05',
    files: [importFile(firstFile)]
  });
  assert.equal(skipped.status, 'all_skipped');
  assert.equal(db.prepare(`
    SELECT generated_at FROM vcc_fin_op_datasets
    WHERE target_month = '2026-05' AND dataset_type = ?
  `).get(SOURCE_TYPES.SYSTEM_OP).generated_at, '2000-01-01 00:00:00');

  repository.createImportBatch(db, { id: 'generated-system-2', targetMonth: '2026-05', fileCount: 1 });
  const inserted = importSystemOpGroup({
    db,
    batchId: 'generated-system-2',
    targetMonth: '2026-05',
    files: [importFile(secondFile)]
  });
  assert.equal(inserted.status, 'success');
  assert.equal(db.prepare(`
    SELECT generated_at FROM vcc_fin_op_datasets
    WHERE target_month = '2026-05' AND dataset_type = ?
  `).get(SOURCE_TYPES.SYSTEM_OP).generated_at, inserted.finished_at);
});

test('系统财务OP归档后允许精确重放但拒绝新增主体快照', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const firstFile = writeWorkbook(t, { fileName: 'archive-first.xlsx' });
  const sameFile = writeWorkbook(t, { fileName: 'archive-same.xlsx' });
  const newSubjectFile = writeWorkbook(t, {
    snapshots: [{ subject: 'PPUS', balances: balances(20) }],
    fileName: 'archive-new-subject.xlsx'
  });
  const invalidSubjectFile = writeWorkbook(t, {
    snapshots: [{ subject: '', balances: balances(30) }],
    fileName: 'archive-invalid-subject.xlsx'
  });

  repository.createImportBatch(db, { id: 'archive-b1', targetMonth: '2026-05', fileCount: 1 });
  importSystemOpGroup({
    db, batchId: 'archive-b1', targetMonth: '2026-05', files: [importFile(firstFile)]
  });
  const runId = Number(db.prepare(`
    INSERT INTO vcc_fin_op_runs (target_month, status, input_revisions_json)
    VALUES ('2026-05', 'archived', '{}')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO vcc_fin_op_archives (target_month, subject, balances_json, run_id)
    VALUES ('2026-05', 'PPHK', ?, ?)
  `).run(JSON.stringify(balances()), runId);
  db.prepare(`
    UPDATE vcc_fin_op_datasets SET data_status = 'archived', archived_run_id = ?
    WHERE target_month = '2026-05'
  `).run(runId);

  repository.createImportBatch(db, { id: 'archive-b2', targetMonth: '2026-05', fileCount: 1 });
  const replay = importSystemOpGroup({
    db, batchId: 'archive-b2', targetMonth: '2026-05', files: [importFile(sameFile)]
  });
  repository.createImportBatch(db, { id: 'archive-b3', targetMonth: '2026-05', fileCount: 2 });
  const rejected = importSystemOpGroup({
    db,
    batchId: 'archive-b3',
    targetMonth: '2026-05',
    files: [importFile(newSubjectFile), importFile(invalidSubjectFile)]
  });

  assert.equal(replay.status, 'all_skipped');
  assert.equal(rejected.status, 'failed_validation');
  assert.match(rejected.error_message, /已归档/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots').get().n, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshot_attempts
    WHERE import_record_id = ? AND disposition = 'rolled_back'
  `).get(rejected.id).n, 1);
  assert.equal(rejected.format_error_count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_import_anomalies
    WHERE import_record_id = ? AND category = 'system_subject_error'
  `).get(rejected.id).n, SUPPORTED_CURRENCIES.length);
});

test('同批同主体系统财务OP异内容冲突互相关联以供双侧核对', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const firstFile = writeWorkbook(t, { fileName: 'batch-first.xlsx' });
  const changedFile = writeWorkbook(t, {
    snapshots: [{ subject: 'PPHK', balances: { ...balances(), USD: 88.25 } }],
    fileName: 'batch-changed.xlsx'
  });
  repository.createImportBatch(db, { id: 'same-batch', targetMonth: '2026-05', fileCount: 2 });

  const record = importSystemOpGroup({
    db,
    batchId: 'same-batch',
    targetMonth: '2026-05',
    files: [importFile(firstFile), importFile(changedFile)]
  });

  assert.equal(record.status, 'failed_conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots').get().n, 0);
  const attempts = db.prepare(`
    SELECT id, comparison_attempt_id
    FROM vcc_fin_op_system_snapshot_attempts
    ORDER BY id
  `).all();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].comparison_attempt_id, attempts[1].id);
  assert.equal(attempts[1].comparison_attempt_id, attempts[0].id);
});

test('系统快照混合精确重放、冲突和新主体时只过滤冲突并提升新主体', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const baseline = writeWorkbook(t, { fileName: 'baseline-system.xlsx' });
  repository.createImportBatch(db, { id: 'baseline-batch', targetMonth: '2026-05', fileCount: 1 });
  importSystemOpGroup({
    db, batchId: 'baseline-batch', targetMonth: '2026-05', files: [importFile(baseline)]
  });
  const same = writeWorkbook(t, { fileName: 'same-system.xlsx' });
  const firstConflict = writeWorkbook(t, {
    snapshots: [{ subject: 'PPUS', balances: balances(20) }],
    fileName: 'ppus-1.xlsx'
  });
  const secondConflict = writeWorkbook(t, {
    snapshots: [{ subject: 'PPUS', balances: balances(30) }],
    fileName: 'ppus-2.xlsx'
  });
  const newSubject = writeWorkbook(t, {
    snapshots: [{ subject: 'PPSG', balances: balances(40) }],
    fileName: 'ppsg-new.xlsx'
  });
  repository.createImportBatch(db, { id: 'mixed-system-batch', targetMonth: '2026-05', fileCount: 4 });

  const record = importSystemOpGroup({
    db,
    batchId: 'mixed-system-batch',
    targetMonth: '2026-05',
    files: [importFile(same), importFile(firstConflict), importFile(secondConflict), importFile(newSubject)]
  });

  assert.equal(record.status, 'success_with_skips');
  assert.equal(record.raw_count, 4);
  assert.equal(record.inserted_count, 1);
  assert.equal(record.skipped_count, 1);
  assert.equal(record.conflict_count, 2);
  assert.equal(record.rolled_back_count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots').get().n, 2);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots WHERE subject = 'PPSG'
  `).get().n, 1);
});

test('系统快照同主体的精确重放与异内容在失败批次内分别归类', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const baseline = writeWorkbook(t, { fileName: 'baseline-same-subject.xlsx' });
  repository.createImportBatch(db, { id: 'same-subject-baseline', targetMonth: '2026-05', fileCount: 1 });
  importSystemOpGroup({
    db,
    batchId: 'same-subject-baseline',
    targetMonth: '2026-05',
    files: [importFile(baseline)]
  });

  const same = writeWorkbook(t, { fileName: 'same-existing.xlsx' });
  const changed = writeWorkbook(t, {
    snapshots: [{ subject: 'PPHK', balances: { ...balances(), USD: 88.25 } }],
    fileName: 'changed-existing.xlsx'
  });
  repository.createImportBatch(db, { id: 'same-subject-mixed', targetMonth: '2026-05', fileCount: 2 });
  const record = importSystemOpGroup({
    db,
    batchId: 'same-subject-mixed',
    targetMonth: '2026-05',
    files: [importFile(same), importFile(changed)]
  });

  assert.equal(record.status, 'failed_conflict');
  assert.equal(record.raw_count, 2);
  assert.equal(record.skipped_count, 1);
  assert.equal(record.conflict_count, 1);
  assert.equal(record.rolled_back_count, 0);
  const attempts = db.prepare(`
    SELECT source_file, disposition, existing_snapshot_id
    FROM vcc_fin_op_system_snapshot_attempts
    WHERE import_record_id = ?
    ORDER BY source_file
  `).all(record.id);
  assert.deepEqual(attempts.map((item) => [item.source_file, item.disposition]), [
    ['changed-existing.xlsx', 'idempotent_conflict'],
    ['same-existing.xlsx', 'idempotent_skip']
  ]);
  assert.ok(attempts.every((item) => item.existing_snapshot_id));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots').get().n, 1);
  assert.equal(
    JSON.parse(db.prepare('SELECT balances_json FROM vcc_fin_op_system_snapshots').get().balances_json).USD,
    '9.25'
  );
});

test('系统财务OP跨文件格式异常只过滤异常数据并提升完整快照', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const validFile = writeWorkbook(t, { fileName: 'valid-system.xlsx' });
  const invalidFile = writeWorkbook(t, {
    snapshots: [{ subject: '', balances: balances(20) }],
    fileName: 'invalid-system.xlsx'
  });
  repository.createImportBatch(db, { id: 'mixed-validity', targetMonth: '2026-05', fileCount: 2 });

  const record = importSystemOpGroup({
    db,
    batchId: 'mixed-validity',
    targetMonth: '2026-05',
    files: [importFile(validFile), importFile(invalidFile)]
  });

  assert.equal(record.status, 'success_with_skips');
  assert.equal(record.raw_count, 2);
  assert.equal(record.inserted_count, 1);
  assert.equal(record.format_error_count, 1);
  assert.equal(record.rolled_back_count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots').get().n, 1);
  const attempt = db.prepare(`
    SELECT disposition, source_file FROM vcc_fin_op_system_snapshot_attempts
  `).get();
  assert.equal(attempt.disposition, 'accepted');
  assert.equal(attempt.source_file, 'valid-system.xlsx');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_errors').get().n, 0);
  const anomaly = db.prepare(`
    SELECT category, source_file_name, source_row, abnormal_fields_json
    FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
  `).get(record.id);
  assert.equal(record.anomaly_count, SUPPORTED_CURRENCIES.length);
  assert.equal(anomaly.category, 'system_subject_error');
  assert.equal(anomaly.source_file_name, 'invalid-system.xlsx');
  assert.equal(anomaly.source_row, 2);
  assert.deepEqual(JSON.parse(anomaly.abnormal_fields_json), ['主体']);
  assert.equal(
    record.raw_count,
    record.inserted_count + record.skipped_count + record.invalid_key_count
      + record.conflict_count + record.format_error_count + record.rolled_back_count
  );
});

test('系统财务OP同文件多主体部分格式错误时提升完整主体并过滤异常主体', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const entry = writeWorkbook(t, {
    snapshots: [
      { subject: 'PPHK', balances: balances() },
      { subject: 'PPUS', department: 'OTHER', balances: balances(20) }
    ],
    fileName: 'mixed-subject-validity.xlsx'
  });

  assert.throws(
    () => readSystemOpSnapshots(entry.filePath, '2026-05', entry.sheetName),
    (error) => {
      assert.match(error.message, /业务部门.*必须为 VCC/);
      assert.equal(error.parsedSnapshots.length, 1);
      assert.equal(error.parsedSnapshots[0].subject, 'PPHK');
      return true;
    }
  );

  repository.createImportBatch(db, { id: 'mixed-subject-validity', targetMonth: '2026-05', fileCount: 1 });
  const record = importSystemOpGroup({
    db,
    batchId: 'mixed-subject-validity',
    targetMonth: '2026-05',
    files: [importFile(entry)]
  });

  assert.equal(record.status, 'success_with_skips');
  assert.equal(record.raw_count, 2);
  assert.equal(record.inserted_count, 1);
  assert.equal(record.format_error_count, 1);
  assert.equal(record.rolled_back_count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_system_snapshots').get().n, 1);
  const attempt = db.prepare(`
    SELECT subject, disposition, raw_json
    FROM vcc_fin_op_system_snapshot_attempts
    WHERE disposition = 'accepted'
  `).get();
  assert.equal(attempt.subject, 'PPHK');
  assert.equal(attempt.disposition, 'accepted');
  assert.equal(JSON.parse(attempt.raw_json).rows.length, 9);
  const rejectedAttempt = db.prepare(`
    SELECT subject, disposition, raw_json
    FROM vcc_fin_op_system_snapshot_attempts
    WHERE disposition = 'rolled_back'
  `).get();
  assert.equal(rejectedAttempt.subject, 'PPUS');
  assert.equal(JSON.parse(rejectedAttempt.raw_json).rows.length, 9);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vcc_fin_op_import_errors').get().n, 0);
  const anomaly = db.prepare(`
    SELECT category, source_file_name, source_row, abnormal_fields_json
    FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
  `).get(record.id);
  assert.equal(anomaly.category, 'system_subject_error');
  assert.equal(anomaly.source_file_name, 'mixed-subject-validity.xlsx');
  assert.equal(anomaly.source_row, 11);
  assert.deepEqual(JSON.parse(anomaly.abnormal_fields_json), ['业务部门']);
});

test('系统 OP 多文件第二份最终 SHA/size 不一致时 failImportBatch 精确关联失败来源', async (t) => {
  const db = createDb();
  t.after(() => db.close());
  const firstFile = writeWorkbook(t, {
    snapshots: [{ subject: 'PPHK', balances: balances(10) }],
    fileName: 'system-first.xlsx'
  });
  const secondFile = writeWorkbook(t, {
    snapshots: [{ subject: 'PPUS', balances: balances(20) }],
    fileName: 'system-second.xlsx'
  });
  const files = [
    { ...firstFile, sourceType: SOURCE_TYPES.SYSTEM_OP },
    { ...secondFile, sourceType: SOURCE_TYPES.SYSTEM_OP }
  ];
  const hashedFiles = await hashSourceFiles(files);
  const archiveHandoffFiles = hashedFiles.map((file, index) => ({
    filePath: file.filePath,
    sourceType: file.sourceType,
    sourceOrdinal: index + 1,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    taskRunId: 'system-second-sha-mismatch',
    archiveArtifactId: index + 1
  }));
  const originalCreateImportSource = repository.createImportSource;
  repository.createImportSource = function createAndMutateSecondSource(targetDb, recordId, source) {
    const sourceId = originalCreateImportSource(targetDb, recordId, source);
    if (source.sourceOrdinal === 2) fs.appendFileSync(secondFile.filePath, Buffer.from([0]));
    return sourceId;
  };
  let failure;
  try {
    await importFiles({
      db,
      batchId: 'system-second-sha-mismatch',
      targetMonth: '2026-05',
      files,
      archiveHandoffFiles
    });
  } catch (error) {
    failure = error;
  } finally {
    repository.createImportSource = originalCreateImportSource;
  }
  assert.ok(failure);
  assert.equal(failure.code, 'vcc-source-changed');
  assert.equal(failure.context.sourceOrdinal, 2);
  assert.equal(failure.context.fileName, 'system-second.xlsx');
  const record = db.prepare(`
    SELECT * FROM vcc_fin_op_import_records
    WHERE batch_id = 'system-second-sha-mismatch'
  `).get();
  const secondSource = db.prepare(`
    SELECT * FROM vcc_fin_op_import_sources
    WHERE import_record_id = ? AND source_ordinal = 2
  `).get(record.id);
  assert.equal(failure.context.importSourceId, Number(secondSource.id));
  const restoredFailure = deserializeError(serializeError(failure));
  assert.deepEqual(restoredFailure.context, {
    importSourceId: Number(secondSource.id),
    sourceOrdinal: 2,
    fileName: 'system-second.xlsx'
  });
  const anomaly = db.prepare(`
    SELECT import_source_id, source_file_name, category
    FROM vcc_fin_op_import_anomalies WHERE import_record_id = ?
  `).get(record.id);
  assert.deepEqual({ ...anomaly }, {
    import_source_id: Number(secondSource.id),
    source_file_name: 'system-second.xlsx',
    category: 'file_failure'
  });
  const exported = [...repository.iterateExportableImportAnomalies(db, record.id)];
  assert.equal(exported.length, 1);
  assert.equal(exported[0].source_file_name, 'system-second.xlsx');
});
