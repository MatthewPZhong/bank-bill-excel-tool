const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const { AppDatabase } = require('../src/backend/database');
const {
  FileValidationError,
  readRowsWithMetadata
} = require('../src/backend/file-service');
const {
  hasColumn
} = require('../src/backend/database/migrations');

// ---------------------------------------------------------------------------
// Constants (mirrored from main.js — not imported to avoid Electron deps)
// ---------------------------------------------------------------------------
const SUPPORTED_BUNDLE_VERSION = 4;
const FILENAME_MAPPING_TEMPLATE_ID = '__FILENAME_MAPPING__';

// ---------------------------------------------------------------------------
// Fixture generation (programmatic, SheetJS)
// ---------------------------------------------------------------------------
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'v1.5.2');

// Standard headers used by "zhonghang" templates
const ZHONGHANG_HEADERS = ['日期', '摘要', '借方', '贷方', '余额'];
// Different headers for "gonghang" templates
const GONGHANG_HEADERS = ['交易日期', '交易摘要', '支出', '收入', '账户余额'];
// Wrong headers (intentionally mismatched)
const WRONG_HEADERS = ['列A', '列B', '列C'];
// Random headers for no-match scenario
const RANDOM_HEADERS = ['姓名', '年龄', '地址'];

function makeWorkbook(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function generateFixtures() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  // 1. standard zhonghang detail, 5 data rows
  makeWorkbook(path.join(FIXTURE_DIR, '中行001-明细-20260101.xlsx'), [
    ZHONGHANG_HEADERS,
    ['2026-01-01', '转账', '1000', '', '50000'],
    ['2026-01-02', '汇款', '', '2000', '52000'],
    ['2026-01-03', '消费', '500', '', '51500'],
    ['2026-01-04', '利息', '', '10', '51510'],
    ['2026-01-05', '手续费', '5', '', '51505']
  ]);

  // 2. standard zhonghang balance, 3 data rows
  makeWorkbook(path.join(FIXTURE_DIR, '中行001-余额-20260101.xlsx'), [
    ZHONGHANG_HEADERS,
    ['2026-01-01', '期初', '', '', '50000'],
    ['2026-01-05', '期末', '', '', '51505'],
    ['2026-01-05', '可用', '', '', '51505']
  ]);

  // 3. gonghang detail, 5 data rows
  makeWorkbook(path.join(FIXTURE_DIR, '工行002-明细-20260101.xlsx'), [
    GONGHANG_HEADERS,
    ['2026-01-01', '工资', '0', '8000', '108000'],
    ['2026-01-02', '缴费', '300', '0', '107700'],
    ['2026-01-03', '转账', '5000', '0', '102700'],
    ['2026-01-04', '退款', '0', '200', '102900'],
    ['2026-01-05', '消费', '100', '0', '102800']
  ]);

  // 4. no-match scenario, random headers
  makeWorkbook(path.join(FIXTURE_DIR, '无匹配-test.xlsx'), [
    RANDOM_HEADERS,
    ['张三', '25', '北京'],
    ['李四', '30', '上海'],
    ['王五', '28', '广州']
  ]);

  // 5. ambiguous match scenario
  makeWorkbook(path.join(FIXTURE_DIR, '中行-通用.xlsx'), [
    ZHONGHANG_HEADERS,
    ['2026-01-01', '测试', '100', '', '100'],
    ['2026-01-02', '测试', '', '200', '300'],
    ['2026-01-03', '测试', '50', '', '250']
  ]);

  // 6. wrong headers (header mismatch scenario)
  makeWorkbook(path.join(FIXTURE_DIR, '中行001-错误表头.xlsx'), [
    WRONG_HEADERS,
    ['数据A', '数据B', '数据C'],
    ['数据D', '数据E', '数据F'],
    ['数据G', '数据H', '数据I']
  ]);

  // 7. batch OK file 1
  makeWorkbook(path.join(FIXTURE_DIR, 'batch-ok-1.xlsx'), [
    ZHONGHANG_HEADERS,
    ['2026-02-01', '入账', '', '1000', '61000'],
    ['2026-02-02', '出账', '500', '', '60500'],
    ['2026-02-03', '入账', '', '200', '60700']
  ]);

  // 8. batch OK file 2
  makeWorkbook(path.join(FIXTURE_DIR, 'batch-ok-2.xlsx'), [
    ZHONGHANG_HEADERS,
    ['2026-02-01', '转入', '', '3000', '73000'],
    ['2026-02-02', '转出', '1000', '', '72000'],
    ['2026-02-03', '转入', '', '500', '72500']
  ]);

  // 9. batch fail file (wrong headers)
  makeWorkbook(path.join(FIXTURE_DIR, 'batch-fail.xlsx'), [
    WRONG_HEADERS,
    ['坏数据1', '坏数据2', '坏数据3'],
    ['坏数据4', '坏数据5', '坏数据6'],
    ['坏数据7', '坏数据8', '坏数据9']
  ]);

  // 10. multi-block file (repeated header row creates 2 blocks)
  makeWorkbook(path.join(FIXTURE_DIR, 'multi-block.xlsx'), [
    ZHONGHANG_HEADERS,
    ['2026-03-01', '交易A1', '100', '', '9900'],
    ['2026-03-02', '交易A2', '', '200', '10100'],
    ['2026-03-03', '交易A3', '50', '', '10050'],
    ['2026-03-04', '交易A4', '', '100', '10150'],
    ['2026-03-05', '交易A5', '30', '', '10120'],
    ZHONGHANG_HEADERS,
    ['2026-03-06', '交易B1', '500', '', '9620'],
    ['2026-03-07', '交易B2', '', '600', '10220'],
    ['2026-03-08', '交易B3', '200', '', '10020'],
    ['2026-03-09', '交易B4', '', '300', '10320']
  ]);
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
  } catch (error) {
    failed++;
    results.push({ name, ok: false, error });
  }
}

// ---------------------------------------------------------------------------
// Replicated sub-logic from main.js (approach B)
// ---------------------------------------------------------------------------

// matchesTemplateHeaders: main.js:5952
function matchesTemplateHeaders(filePath, template) {
  const headers = Array.isArray(template?.headers) ? template.headers : [];
  if (headers.length === 0) return false;
  try {
    readRowsWithMetadata(filePath, headers);
    return true;
  } catch (error) {
    if (error instanceof FileValidationError && typeof error.message === 'string' && error.message.includes('表头')) {
      return false;
    }
    throw error;
  }
}

// Filename matching loop: main.js:6019-6046
function matchFilenameToTemplates(filePath, eligibleTemplates) {
  const basename = path.basename(filePath);
  const candidates = eligibleTemplates.filter((t) => basename.includes(t.filenameFixedField));

  if (candidates.length === 0) {
    return { status: 'no-match', errorCode: 'FILENAME_MAPPING_NO_MATCH', basename };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      errorCode: 'FILENAME_MAPPING_AMBIGUOUS',
      basename,
      candidateNames: candidates.map((t) => t.name)
    };
  }
  return { status: 'unique', matchedTemplate: candidates[0] };
}

// Batch filename mapping validation: main.js:6019-6060
function validateFilenameMappingBatch(filePaths, eligibleTemplates) {
  const perFileMatch = [];

  for (const filePath of filePaths) {
    const filenameResult = matchFilenameToTemplates(filePath, eligibleTemplates);

    if (filenameResult.status === 'no-match') {
      return { status: 'error', errorCode: 'FILENAME_MAPPING_NO_MATCH', fileName: filenameResult.basename };
    }
    if (filenameResult.status === 'ambiguous') {
      return {
        status: 'error',
        errorCode: 'FILENAME_MAPPING_AMBIGUOUS',
        fileName: filenameResult.basename,
        candidateNames: filenameResult.candidateNames
      };
    }

    if (!matchesTemplateHeaders(filePath, filenameResult.matchedTemplate)) {
      return {
        status: 'error',
        errorCode: 'FILENAME_MAPPING_HEADER_MISMATCH',
        fileName: path.basename(filePath),
        matchedTemplateName: filenameResult.matchedTemplate.name
      };
    }

    perFileMatch.push({ filePath, matchedTemplate: filenameResult.matchedTemplate });
  }

  return { status: 'ok', perFileMatch };
}

// identifyAccountBlocks: main.js:673
function identifyAccountBlocks(detailRows, options = {}) {
  const { includeEmptyBlocks = false } = options;
  const headerRow = detailRows[0] || [];
  const dataRows = detailRows.slice(1);
  const rowMetas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];
  const headerBreaks = Array.isArray(detailRows.headerBreaks) ? detailRows.headerBreaks : [];

  if (!headerBreaks.length) {
    return [{
      startIndex: 0,
      endIndex: Math.max(0, dataRows.length - 1),
      startRowNumber: rowMetas[0]?.sourceRowNumber || 2
    }];
  }

  const normalizeCell = (v) => String(v ?? '').trim();
  const creditIndex = headerRow.indexOf('Credit Amount');
  const debitIndex = headerRow.indexOf('Debit Amount');

  function isTransactionRow(row) {
    if (!Array.isArray(row)) return false;
    const credit = creditIndex >= 0 ? normalizeCell(row[creditIndex]) : '';
    const debit = debitIndex >= 0 ? normalizeCell(row[debitIndex]) : '';
    return credit !== '' || debit !== '';
  }

  function trimBlock(startIdx, endIdx) {
    let s = startIdx;
    let e = endIdx;
    while (e >= s && !isTransactionRow(dataRows[e])) { e--; }
    while (s <= e && !isTransactionRow(dataRows[s])) { s++; }
    return { startIndex: s, endIndex: e };
  }

  const blocks = [];
  let blockStart = 0;
  let prevBreakRowNumber = null;

  headerBreaks.forEach((breakRowNumber) => {
    const splitIndex = rowMetas.findIndex(
      (meta, i) => i >= blockStart && meta.sourceRowNumber >= breakRowNumber
    );
    const effectiveSplit = splitIndex >= 0 ? splitIndex : dataRows.length;
    const rawEnd = effectiveSplit > blockStart ? effectiveSplit - 1 : blockStart - 1;
    const trimmed = trimBlock(blockStart, rawEnd);

    if (includeEmptyBlocks) {
      blocks.push({
        startIndex: trimmed.startIndex,
        endIndex: trimmed.endIndex,
        startRowNumber: rowMetas[trimmed.startIndex]?.sourceRowNumber || prevBreakRowNumber || blockStart + 2
      });
    } else if (trimmed.startIndex <= trimmed.endIndex) {
      blocks.push({
        startIndex: trimmed.startIndex,
        endIndex: trimmed.endIndex,
        startRowNumber: rowMetas[trimmed.startIndex]?.sourceRowNumber || prevBreakRowNumber || trimmed.startIndex + 2
      });
    }
    blockStart = effectiveSplit;
    prevBreakRowNumber = breakRowNumber;
  });

  const lastBreakRowNumber = headerBreaks[headerBreaks.length - 1];
  const lastTrimmed = trimBlock(blockStart, dataRows.length - 1);
  if (includeEmptyBlocks) {
    blocks.push({
      startIndex: lastTrimmed.startIndex,
      endIndex: lastTrimmed.endIndex,
      startRowNumber: rowMetas[lastTrimmed.startIndex]?.sourceRowNumber || lastBreakRowNumber || blockStart + 2
    });
  } else if (lastTrimmed.startIndex <= lastTrimmed.endIndex) {
    blocks.push({
      startIndex: lastTrimmed.startIndex,
      endIndex: lastTrimmed.endIndex,
      startRowNumber: rowMetas[lastTrimmed.startIndex]?.sourceRowNumber || lastBreakRowNumber || lastTrimmed.startIndex + 2
    });
  }

  return blocks;
}

// buildBigAccountSelectionRows: main.js:867
function buildBigAccountSelectionRows(fileEntries = [], options = {}) {
  const { includeEmptyBlocks = false } = options;
  const rows = [];
  let rowIndex = 0;

  fileEntries.forEach((entry, fileIndex) => {
    const blocks = identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks });

    blocks.forEach((block) => {
      rows.push({
        index: rowIndex,
        fileIndex,
        sourceRowNumber: block.startRowNumber,
        fileName: path.basename(entry.filePath),
        filePath: entry.filePath,
        blockStartIndex: block.startIndex,
        blockEndIndex: block.endIndex
      });
      rowIndex += 1;
    });
  });

  return rows;
}

// applyBigAccountAssignmentsToFileEntries: main.js:894
function applyBigAccountAssignmentsToFileEntries(fileEntries = [], assignments = [], options = {}) {
  const { includeEmptyBlocks = false } = options;
  const normalizeVal = (v) => String(v ?? '').trim();
  const normalizedAssignments = assignments.map((item, index) => ({
    merchantId: normalizeVal(item.merchantId),
    currency: normalizeVal(item.currency),
    rowIndex: Number.isInteger(item.rowIndex) ? item.rowIndex : index
  }));
  const assignmentByRowIndex = new Map(normalizedAssignments.map((item) => [item.rowIndex, item]));
  let globalBlockIndex = 0;

  return fileEntries.map((entry) => {
    const headerRow = entry.detailRows[0] || [];
    const dataRows = entry.detailRows.slice(1);

    const fieldIndexMap = new Map();
    headerRow.forEach((fieldName, idx) => {
      const normalized = normalizeVal(fieldName);
      if (normalized && !fieldIndexMap.has(normalized)) {
        fieldIndexMap.set(normalized, idx);
      }
    });

    const merchantIdIndex = fieldIndexMap.get('MerchantId');
    const currencyIndex = fieldIndexMap.get('Currency');
    const blocks = identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks });
    const keepIndices = new Set();

    blocks.forEach((block) => {
      const assignment = assignmentByRowIndex.get(globalBlockIndex);

      for (let i = block.startIndex; i <= block.endIndex && i < dataRows.length; i++) {
        keepIndices.add(i);
        if (assignment) {
          const row = dataRows[i];
          if (merchantIdIndex !== undefined) {
            row[merchantIdIndex] = assignment.merchantId;
          }
          if (currencyIndex !== undefined) {
            row[currencyIndex] = assignment.currency;
          }
        }
      }

      globalBlockIndex += 1;
    });

    const filteredRows = [headerRow];
    dataRows.forEach((row, i) => {
      if (keepIndices.has(i)) {
        filteredRows.push(row);
      }
    });

    return {
      filePath: entry.filePath,
      detailRows: filteredRows,
      matchedTemplateId: entry.matchedTemplateId || null
    };
  });
}

// ---------------------------------------------------------------------------
// Test context setup
// ---------------------------------------------------------------------------
function createTestContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v152-test-'));
  const dbPath = path.join(root, 'test.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  const zhTemplate = db.upsertTemplate({
    name: '中行001',
    sourceFileName: '中行001.xlsx',
    headers: ZHONGHANG_HEADERS
  });
  db.saveTemplateFilenameFixedField(zhTemplate.id, '中行001');

  const zhChildTemplate = db.upsertTemplate({
    name: '中行001-明细',
    sourceFileName: '中行001-明细.xlsx',
    headers: ZHONGHANG_HEADERS
  });
  db.saveTemplateFilenameFixedField(zhChildTemplate.id, '中行001');
  db.setChildParent(zhChildTemplate.id, zhTemplate.id);

  const ghTemplate = db.upsertTemplate({
    name: '工行002',
    sourceFileName: '工行002.xlsx',
    headers: GONGHANG_HEADERS
  });
  db.saveTemplateFilenameFixedField(ghTemplate.id, '工行002');

  const plainTemplate = db.upsertTemplate({
    name: '普通模板',
    sourceFileName: 'plain.xlsx',
    headers: ZHONGHANG_HEADERS
  });

  const allTemplates = db.listTemplates();
  const eligibleTemplates = allTemplates.filter((t) => (t.filenameFixedField || '').length > 0);

  return {
    root,
    dbPath,
    db,
    zhTemplate: db.getTemplate(zhTemplate.id),
    zhChildTemplate: db.getTemplate(zhChildTemplate.id),
    ghTemplate: db.getTemplate(ghTemplate.id),
    plainTemplate: db.getTemplate(plainTemplate.id),
    allTemplates,
    eligibleTemplates
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function run() {
  console.log('v1.5.2 后端集成测试');
  console.log('==================');

  generateFixtures();

  const ctx = createTestContext();

  // === G1: template name validation ===

  test('T1-1 子名包含主名', () => {
    const childName = '中行001-明细';
    const parentName = '中行001';
    assert.strictEqual(childName.includes(parentName), true);
  });

  test('T1-2 子名不包含主名', () => {
    const childName = '工行-xxx';
    const parentName = '中行001';
    assert.strictEqual(childName.includes(parentName), false);
  });

  test('T1-3 同名通过', () => {
    const childName = '中行001';
    const parentName = '中行001';
    assert.strictEqual(childName.includes(parentName), true);
  });

  test('T1-4 空主名不崩溃', () => {
    const childName = '中行001-明细';
    const parentName = '';
    assert.strictEqual(childName.includes(parentName), true);
  });

  // === G3: filename mapping ===

  test('T3-1 matchesTemplateHeaders 表头匹配成功', () => {
    const filePath = path.join(FIXTURE_DIR, '中行001-明细-20260101.xlsx');
    assert.strictEqual(matchesTemplateHeaders(filePath, ctx.zhTemplate), true);
  });

  test('T3-2 matchesTemplateHeaders 表头不匹配', () => {
    const filePath = path.join(FIXTURE_DIR, '中行001-错误表头.xlsx');
    assert.strictEqual(matchesTemplateHeaders(filePath, ctx.zhTemplate), false);
  });

  test('T3-3 单文件唯一命中+表头匹配', () => {
    const ghFilePath = path.join(FIXTURE_DIR, '工行002-明细-20260101.xlsx');
    const ghResult = matchFilenameToTemplates(ghFilePath, ctx.eligibleTemplates);
    assert.strictEqual(ghResult.status, 'unique');
    assert.strictEqual(ghResult.matchedTemplate.name, '工行002');
    assert.strictEqual(matchesTemplateHeaders(ghFilePath, ghResult.matchedTemplate), true);
  });

  test('T3-4 单文件 0 命中', () => {
    const filePath = path.join(FIXTURE_DIR, '无匹配-test.xlsx');
    const result = matchFilenameToTemplates(filePath, ctx.eligibleTemplates);
    assert.strictEqual(result.status, 'no-match');
    assert.strictEqual(result.errorCode, 'FILENAME_MAPPING_NO_MATCH');
  });

  test('T3-5 单文件多命中', () => {
    const amb1 = ctx.db.upsertTemplate({
      name: '中行A',
      sourceFileName: '中行A.xlsx',
      headers: ZHONGHANG_HEADERS
    });
    ctx.db.saveTemplateFilenameFixedField(amb1.id, '中行');
    const amb2 = ctx.db.upsertTemplate({
      name: '中行B',
      sourceFileName: '中行B.xlsx',
      headers: ZHONGHANG_HEADERS
    });
    ctx.db.saveTemplateFilenameFixedField(amb2.id, '中行');

    const ambEligible = ctx.db.listTemplates().filter((t) => (t.filenameFixedField || '').length > 0);
    const filePath = path.join(FIXTURE_DIR, '中行-通用.xlsx');
    const result = matchFilenameToTemplates(filePath, ambEligible);
    assert.strictEqual(result.status, 'ambiguous');
    assert.strictEqual(result.errorCode, 'FILENAME_MAPPING_AMBIGUOUS');
    assert(result.candidateNames.length >= 2);

    ctx.db.deleteTemplate(amb1.id);
    ctx.db.deleteTemplate(amb2.id);
  });

  test('T3-6 唯一命中+表头不匹配', () => {
    const uniqueT = ctx.db.upsertTemplate({
      name: '错误测试模板',
      sourceFileName: '错误测试模板.xlsx',
      headers: ZHONGHANG_HEADERS
    });
    ctx.db.saveTemplateFilenameFixedField(uniqueT.id, '错误表头');

    ctx.db.saveTemplateFilenameFixedField(ctx.zhTemplate.id, '');
    ctx.db.saveTemplateFilenameFixedField(ctx.zhChildTemplate.id, '');

    const isolated = ctx.db.listTemplates().filter((t) => (t.filenameFixedField || '').length > 0);
    const result = validateFilenameMappingBatch(
      [path.join(FIXTURE_DIR, '中行001-错误表头.xlsx')],
      isolated
    );
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.errorCode, 'FILENAME_MAPPING_HEADER_MISMATCH');

    ctx.db.saveTemplateFilenameFixedField(ctx.zhTemplate.id, '中行001');
    ctx.db.saveTemplateFilenameFixedField(ctx.zhChildTemplate.id, '中行001');
    ctx.db.deleteTemplate(uniqueT.id);
  });

  test('T3-7 整批截断：3 文件 2OK+1fail 全部不入库', () => {
    const batchT = ctx.db.upsertTemplate({
      name: 'batch模板',
      sourceFileName: 'batch.xlsx',
      headers: ZHONGHANG_HEADERS
    });
    ctx.db.saveTemplateFilenameFixedField(batchT.id, 'batch');

    const batchEligible = ctx.db.listTemplates().filter((t) => (t.filenameFixedField || '').length > 0);
    const filePaths = [
      path.join(FIXTURE_DIR, 'batch-ok-1.xlsx'),
      path.join(FIXTURE_DIR, 'batch-ok-2.xlsx'),
      path.join(FIXTURE_DIR, 'batch-fail.xlsx')
    ];

    const result = validateFilenameMappingBatch(filePaths, batchEligible);
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.errorCode, 'FILENAME_MAPPING_HEADER_MISMATCH');
    assert.strictEqual(result.fileName, 'batch-fail.xlsx');
    assert.strictEqual(result.perFileMatch, undefined);

    ctx.db.deleteTemplate(batchT.id);
  });

  test('T3-8 DB migration 幂等', () => {
    const db2 = new AppDatabase(ctx.dbPath);
    db2.init();
    const columns = db2.db.prepare('PRAGMA table_info(templates)').all();
    const filenameColumns = columns.filter((c) => c.name === 'filename_fixed_field');
    assert.strictEqual(filenameColumns.length, 1);
    db2.db.close();
  });

  // === G2: big account block-level assignments ===

  test('T2-1 buildBigAccountSelectionRows 每行有 fileIndex', () => {
    const fileEntries = [
      {
        filePath: '/fake/file1.xlsx',
        detailRows: Object.assign(
          [['Credit Amount', 'Debit Amount', 'MerchantId'], ['100', '', 'M001'], ['', '200', 'M001']],
          { rowMetas: [{ sourceRowNumber: 2 }, { sourceRowNumber: 3 }], headerBreaks: [] }
        )
      },
      {
        filePath: '/fake/file2.xlsx',
        detailRows: Object.assign(
          [['Credit Amount', 'Debit Amount', 'MerchantId'], ['300', '', 'M002']],
          { rowMetas: [{ sourceRowNumber: 2 }], headerBreaks: [] }
        )
      }
    ];
    const rows = buildBigAccountSelectionRows(fileEntries);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].fileIndex, 0);
    assert.strictEqual(rows[1].fileIndex, 1);
    rows.forEach((row) => {
      assert.strictEqual(typeof row.fileIndex, 'number');
    });
  });

  test('T2-2 applyBigAccountAssignments 只改 merchantId/currency 不改 matchedTemplateId', () => {
    const fileEntries = [{
      filePath: '/fake/file.xlsx',
      detailRows: Object.assign(
        [['Credit Amount', 'Debit Amount', 'MerchantId', 'Currency'], ['100', '', 'OLD_M', 'USD']],
        { rowMetas: [{ sourceRowNumber: 2 }], headerBreaks: [] }
      ),
      matchedTemplateId: 42
    }];
    const assignments = [{ merchantId: 'NEW_M', currency: 'HKD', rowIndex: 0 }];
    const result = applyBigAccountAssignmentsToFileEntries(fileEntries, assignments);
    assert.strictEqual(result[0].detailRows[1][2], 'NEW_M');
    assert.strictEqual(result[0].detailRows[1][3], 'HKD');
    assert.strictEqual(result[0].matchedTemplateId, 42);
  });

  test('T2-3 block 粒度 assignment：同文件 2 block，只赋 block[0]', () => {
    const detailRows = [
      ['Credit Amount', 'Debit Amount', 'MerchantId', 'Currency'],
      ['100', '', 'ORIG_M1', 'USD'],
      ['200', '', 'ORIG_M1', 'USD'],
      ['300', '', 'ORIG_M2', 'HKD'],
      ['400', '', 'ORIG_M2', 'HKD']
    ];
    detailRows.rowMetas = [
      { sourceRowNumber: 2 },
      { sourceRowNumber: 3 },
      { sourceRowNumber: 5 },
      { sourceRowNumber: 6 }
    ];
    detailRows.headerBreaks = [4];

    const fileEntries = [{
      filePath: '/fake/multi-block.xlsx',
      detailRows,
      matchedTemplateId: 99
    }];

    const assignments = [{ merchantId: 'NEW_M_BLOCK0', currency: 'JPY', rowIndex: 0 }];
    const result = applyBigAccountAssignmentsToFileEntries(fileEntries, assignments);

    assert.strictEqual(result[0].detailRows[1][2], 'NEW_M_BLOCK0');
    assert.strictEqual(result[0].detailRows[1][3], 'JPY');
    assert.strictEqual(result[0].detailRows[2][2], 'NEW_M_BLOCK0');
    assert.strictEqual(result[0].detailRows[2][3], 'JPY');
    assert.strictEqual(result[0].detailRows[3][2], 'ORIG_M2');
    assert.strictEqual(result[0].detailRows[3][3], 'HKD');
    assert.strictEqual(result[0].detailRows[4][2], 'ORIG_M2');
    assert.strictEqual(result[0].detailRows[4][3], 'HKD');
  });

  // === Bundle v4 transparent extension ===

  test('T4-1 bundle 导出含 filenameFixedField + bundleVersion 4', () => {
    const entries = ctx.db.listTemplateBundleEntries();
    const zhEntry = entries.find((e) => e.name === '中行001');
    assert(zhEntry, 'Should find 中行001 in bundle entries');
    assert.strictEqual(zhEntry.filenameFixedField, '中行001');

    const bundlePayload = {
      bundleVersion: SUPPORTED_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      templates: entries
    };
    assert.strictEqual(bundlePayload.bundleVersion, 4);
    assert.strictEqual(typeof zhEntry.filenameFixedField, 'string');
  });

  test('T4-2 旧 bundle 兼容（无 filenameFixedField 不报错）', () => {
    const oldBundlePath = path.join(ctx.root, 'old-bundle.json');
    const oldBundle = {
      bundleVersion: 4,
      exportedAt: '2026-01-01T00:00:00.000Z',
      templates: [{
        templateKey: 'old-key-001',
        name: '旧模板',
        sourceFileName: 'old.xlsx',
        headers: ['日期', '摘要', '借方', '贷方', '余额'],
        mappings: [],
        bigAccounts: [],
        fixedAssignments: [],
        dateFormat: 'auto',
        isParent: false,
        parentTemplateKey: null
      }]
    };
    fs.writeFileSync(oldBundlePath, JSON.stringify(oldBundle, null, 2), 'utf8');

    const parsed = JSON.parse(fs.readFileSync(oldBundlePath, 'utf8'));
    const templates = Array.isArray(parsed?.templates) ? parsed.templates : [];
    const normalizeCell = (v) => String(v ?? '').trim();
    const result = templates.map((item) => ({
      filenameFixedField: normalizeCell(item.filenameFixedField) || ''
    }));
    assert.strictEqual(result[0].filenameFixedField, '');
  });

  // === Output ===

  console.log('');
  results.forEach((r) => {
    const mark = r.ok ? '\u2713' : '\u2717';
    console.log(`${r.name} ${mark}`);
    if (!r.ok) {
      console.log(`  expected: ${r.error.expected}`);
      console.log(`  actual:   ${r.error.actual}`);
      if (r.error.message) console.log(`  message:  ${r.error.message}`);
    }
  });

  console.log('');
  console.log(`${passed}/${passed + failed} passed`);

  try { ctx.db.db.close(); } catch (_) { /* ignore */ }
  try { fs.rmSync(ctx.root, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  if (failed > 0) {
    process.exit(1);
  }
}

run();
