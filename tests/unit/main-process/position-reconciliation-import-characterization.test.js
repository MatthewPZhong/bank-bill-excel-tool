'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  readBankFiles,
  readSourceFile,
  readSourceFiles,
  rowValues
} = require('../../../src/main-process/position-reconciliation/readers');
const {
  deriveLinkedRows
} = require('../../../src/main-process/position-reconciliation/derivation');
const {
  createPositionReconciliationService
} = require('../../../src/main-process/position-reconciliation/service');
const {
  BANK_SHEET_NAME,
  SOURCE_DEFINITIONS,
  SOURCE_DISPLAY_ORDER,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const {
  BANK_STATEMENT_FIELDS
} = require('../../../src/constants/bank-statement-fields');

const ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_PATH = path.join(ROOT, 'assets', '平盘银行对账单.xlsx');

function writeWorkbook(filePath, sheets, options = {}) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const headers = sheet.headers || [];
    const rows = sheet.rows || [];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        headers,
        ...rows.map((row) => headers.map((header) => row[header] ?? ''))
      ]),
      sheet.name
    );
  }
  if (options.date1904) {
    workbook.Workbook = workbook.Workbook || {};
    workbook.Workbook.WBProps = {
      ...(workbook.Workbook.WBProps || {}),
      date1904: true
    };
  }
  XLSX.writeFile(workbook, filePath);
}

function bankRow(overrides = {}) {
  return {
    BizId: 'BANK-CHAR-1',
    BillDate: '2026-07-20',
    Channel: 'DBS',
    地区: 'HK',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': 100,
    'Debit Amount': 0,
    FundType: 'Inbound',
    ...overrides
  };
}

function sourceRows() {
  return {
    [SOURCE_TYPES.FUND_TRANSFER]: {
      调拨单号: 'FT-CHAR-1',
      调拨状态: '付款成功',
      渠道流水号: 'FT-RID-1',
      交易时间: '2026-07-20',
      '付款账户（卡号）': 'PAY-1',
      '收款账户（卡号）': 'REC-1',
      付款金额: 100,
      付款币种: 'USD',
      收款金额: 95,
      收款币种: 'EUR'
    },
    [SOURCE_TYPES.TEST_PAYMENT]: {
      付款单号: 'TEST-CHAR-1',
      付款状态: '付款成功',
      渠道流水号: 'TEST-RID-1',
      源金额: 100,
      源币种: 'USD',
      目标金额: 95,
      目标币种: 'EUR',
      创建时间: '2026-07-20'
    },
    [SOURCE_TYPES.GATEWAY_INBOUND]: {
      bizId: 'IN-CHAR-1',
      billDate: '2026-07-20',
      tradeType: 'Inbound-VA',
      reconId: 'IN-RID-1',
      channel: 'DBS',
      merchantId: 'M001',
      currency: 'USD',
      amount: 100,
      originOutboundCurrency: 'EUR'
    },
    [SOURCE_TYPES.GATEWAY_OUTBOUND]: {
      账单日期: '2026-07-20',
      渠道名称: 'DBS',
      账户号: 'M001',
      交易类型: 'Outbound',
      主对账id: 'OUT-RID-1',
      业务单号: 'OUT-CHAR-1',
      币种: 'USD',
      金额: 100,
      原始币种: 'EUR',
      原始金额: 95,
      银行扣款币种: 'USD'
    },
    [SOURCE_TYPES.BANK_ACCOUNT]: {
      账户状态: '正常',
      账户性质: '自有',
      币种: 'USD',
      银行账号: 'OWN-CHAR-1'
    }
  };
}

function sourceFile(dir, sourceType, rows, name = `${sourceType}.xlsx`) {
  const definition = SOURCE_DEFINITIONS[sourceType];
  const filePath = path.join(dir, name);
  writeWorkbook(filePath, [{
    name: `${definition.sourceName}-数据`,
    headers: definition.headers,
    rows
  }]);
  return filePath;
}

test.describe('v3.1.3 旧平盘导入 characterization', () => {
  test('SheetJS raw reader 的值、类型、负零、公式缓存、错误单元格和物理行号保持固定', () => {
    const date = new Date(2026, 6, 20, 12, 34, 56);
    const sheet = {
      A1: { t: 's', v: 'string' },
      B1: { t: 's', v: 'number' },
      C1: { t: 's', v: 'boolean' },
      D1: { t: 's', v: 'date' },
      E1: { t: 's', v: 'formula' },
      F1: { t: 's', v: 'error' },
      G1: { t: 's', v: 'negative-zero' },
      H1: { t: 's', v: 'long-id' },
      A3: { t: 's', v: '  raw text  ' },
      B3: { t: 'n', v: 1.25 },
      C3: { t: 'b', v: true },
      D3: { t: 'd', v: date },
      E3: { t: 'n', v: 2, f: '1+1' },
      F3: { t: 'e', v: 0x07 },
      G3: { t: 'n', v: -0 },
      H3: { t: 's', v: '001234567890123456' },
      '!ref': 'A1:H3'
    };

    const rows = rowValues(sheet);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].__rowNum__, 2);
    assert.equal(rows[1][0], '  raw text  ');
    assert.equal(rows[1][1], 1.25);
    assert.equal(typeof rows[1][1], 'number');
    assert.equal(rows[1][2], true);
    assert.equal(typeof rows[1][2], 'boolean');
    assert.ok(rows[1][3] instanceof Date);
    assert.equal(rows[1][3].getTime(), date.getTime());
    assert.equal(rows[1][4], 2);
    assert.equal(rows[1][5], '');
    assert.ok(Object.is(rows[1][6], -0));
    assert.equal(rows[1][7], '001234567890123456');
  });

  test('真实 XLSX shared/inline/formula/rich-text/1904 日期系统保持旧 SheetJS 类型契约', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-char-cell-forms-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // SheetJS 0.18.x serializes a JS Date through the host's historical local
    // timezone offset and may round the reconstructed timestamp by 1ms. Noon
    // keeps this type-contract fixture away from an unrelated day boundary.
    const expectedDate = new Date(2026, 0, 2, 12);

    for (const bookSST of [false, true]) {
      const workbook = XLSX.utils.book_new();
      workbook.Workbook = { WBProps: { date1904: true } };
      const sheet = {
        A1: { t: 's', v: 'plain' },
        B1: { t: 'str', v: 'formula text', f: '"formula text"' },
        C1: { t: 'b', v: true, f: '1=1' },
        D1: { t: 'n', v: 42, f: '40+2' },
        E1: { t: 's', v: 'Rich', r: '<r><rPr><b/></rPr><t>Rich</t></r>' },
        F1: { t: 'd', v: expectedDate },
        G1: { t: 's', v: '001234567890123456' },
        H1: { t: 'n', v: -0 },
        '!ref': 'A1:H1'
      };
      XLSX.utils.book_append_sheet(workbook, sheet, 'CellForms');
      const filePath = path.join(dir, bookSST ? 'shared.xlsx' : 'inline.xlsx');
      XLSX.writeFile(workbook, filePath, { bookSST });

      const reread = XLSX.readFile(filePath, { cellDates: true, raw: true });
      const values = rowValues(reread.Sheets.CellForms)[0];
      assert.equal(values[0], 'plain');
      assert.equal(values[1], 'formula text');
      assert.equal(typeof values[1], 'string');
      assert.equal(values[2], true);
      assert.equal(typeof values[2], 'boolean');
      assert.equal(values[3], 42);
      assert.equal(typeof values[3], 'number');
      assert.equal(values[4], 'Rich');
      assert.ok(values[5] instanceof Date);
      assert.ok(Math.abs(values[5].getTime() - expectedDate.getTime()) <= 1);
      assert.equal(values[6], '001234567890123456');
      assert.equal(values[7], 0);
      assert.equal(Object.is(values[7], -0), false);
    }
  });

  test('银行只读取渠道对账单且允许额外 sheet，46 列行序、日期类型和 hash 稳定', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-char-bank-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'bank.xlsx');
    // Use a non-boundary time so this test characterizes bank row/date/hash
    // behavior instead of SheetJS's host-timezone Excel epoch residue.
    const excelDate = new Date(2026, 6, 20, 12);
    writeWorkbook(filePath, [
      { name: '说明', headers: ['说明'], rows: [{ 说明: '忽略' }] },
      {
        name: BANK_SHEET_NAME,
        headers: BANK_STATEMENT_FIELDS,
        rows: [
          bankRow({ BizId: 'BANK-CHAR-1', BillDate: excelDate }),
          bankRow({ BizId: 'BANK-CHAR-2', BillDate: '2026-07-21' })
        ]
      }
    ]);

    const parsed = readBankFiles([filePath]);
    assert.deepEqual(parsed.records.map((row) => ({
      bizId: row.bizId,
      sourceSheet: row.sourceSheet,
      sourceRowNumber: row.sourceRowNumber,
      importOrder: row.importOrder,
      billDate: row.billDate,
      billDateIsDate: row.originalRow.BillDate instanceof Date
    })), [
      {
        bizId: 'BANK-CHAR-1',
        sourceSheet: BANK_SHEET_NAME,
        sourceRowNumber: 2,
        importOrder: 0,
        billDate: '2026-07-20',
        billDateIsDate: true
      },
      {
        bizId: 'BANK-CHAR-2',
        sourceSheet: BANK_SHEET_NAME,
        sourceRowNumber: 3,
        importOrder: 1,
        billDate: '2026-07-21',
        billDateIsDate: false
      }
    ]);
    assert.match(parsed.contentHash, /^[a-f0-9]{64}$/);
  });

  test('来源允许无关 sheet，多个可识别业务 sheet 时保持 ambiguous 首因', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-char-sheets-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const rows = sourceRows();
    const transfer = SOURCE_DEFINITIONS[SOURCE_TYPES.FUND_TRANSFER];
    const outbound = SOURCE_DEFINITIONS[SOURCE_TYPES.GATEWAY_OUTBOUND];
    const singlePath = path.join(dir, 'single.xlsx');
    const ambiguousPath = path.join(dir, 'ambiguous.xlsx');
    writeWorkbook(singlePath, [
      { name: '说明', headers: ['说明'], rows: [{ 说明: '忽略' }] },
      { name: '业务', headers: transfer.headers, rows: [rows[SOURCE_TYPES.FUND_TRANSFER]] }
    ]);
    writeWorkbook(ambiguousPath, [
      { name: '调拨', headers: transfer.headers, rows: [rows[SOURCE_TYPES.FUND_TRANSFER]] },
      { name: '出账', headers: outbound.headers, rows: [rows[SOURCE_TYPES.GATEWAY_OUTBOUND]] }
    ]);

    assert.equal(readSourceFile(singlePath).sourceType, SOURCE_TYPES.FUND_TRANSFER);
    assert.throws(
      () => readSourceFile(ambiguousPath),
      (error) => (
        error.code === 'position-source-ambiguous'
        && error.detailLines.length === 2
        && error.detailLines[0].startsWith('调拨 →')
        && error.detailLines[1].startsWith('出账 →')
      )
    );
  });

  test('五类来源结果顺序、同文件折叠、账户过滤和派生 0/隐藏/可见/双腿保持固定', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-char-sources-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const rows = sourceRows();
    const paths = [
      sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [
        rows[SOURCE_TYPES.FUND_TRANSFER],
        rows[SOURCE_TYPES.FUND_TRANSFER]
      ]),
      sourceFile(dir, SOURCE_TYPES.TEST_PAYMENT, [rows[SOURCE_TYPES.TEST_PAYMENT]]),
      sourceFile(dir, SOURCE_TYPES.GATEWAY_INBOUND, [rows[SOURCE_TYPES.GATEWAY_INBOUND]]),
      sourceFile(dir, SOURCE_TYPES.GATEWAY_OUTBOUND, [rows[SOURCE_TYPES.GATEWAY_OUTBOUND]]),
      sourceFile(dir, SOURCE_TYPES.BANK_ACCOUNT, [
        rows[SOURCE_TYPES.BANK_ACCOUNT],
        { ...rows[SOURCE_TYPES.BANK_ACCOUNT], 账户状态: '注销', 银行账号: 'CLOSED-1' }
      ])
    ];

    const parsed = readSourceFiles(paths);
    assert.deepEqual(parsed.map((item) => item.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(parsed.map((item) => item.sourceType), [...SOURCE_DISPLAY_ORDER]);
    assert.equal(parsed[0].rowCount, 1);
    assert.equal(parsed[0].collapsedDuplicateCount, 1);
    assert.equal(parsed[4].rowCount, 1);

    const derivedCounts = Object.fromEntries(parsed.map((item) => {
      const links = deriveLinkedRows(item.sourceType, item.records);
      return [item.sourceType, {
        total: links.length,
        visible: links.filter((link) => link.visible).length,
        legs: links.map((link) => link.legIndex)
      }];
    }));
    assert.deepEqual(derivedCounts, {
      [SOURCE_TYPES.FUND_TRANSFER]: { total: 2, visible: 2, legs: [0, 1] },
      [SOURCE_TYPES.TEST_PAYMENT]: { total: 1, visible: 1, legs: [0] },
      [SOURCE_TYPES.GATEWAY_INBOUND]: { total: 1, visible: 1, legs: [0] },
      [SOURCE_TYPES.GATEWAY_OUTBOUND]: { total: 1, visible: 1, legs: [0] },
      [SOURCE_TYPES.BANK_ACCOUNT]: { total: 1, visible: 1, legs: [0] }
    });

    const zeroTest = readSourceFile(sourceFile(
      dir,
      SOURCE_TYPES.TEST_PAYMENT,
      [{ ...rows[SOURCE_TYPES.TEST_PAYMENT], 付款单号: 'TEST-ZERO', 源金额: 0 }],
      'test-zero.xlsx'
    ));
    assert.deepEqual(deriveLinkedRows(zeroTest.sourceType, zeroTest.records), []);

    const hiddenInbound = readSourceFile(sourceFile(
      dir,
      SOURCE_TYPES.GATEWAY_INBOUND,
      [{
        ...rows[SOURCE_TYPES.GATEWAY_INBOUND],
        bizId: 'IN-HIDDEN',
        originOutboundCurrency: 'USD'
      }],
      'inbound-hidden.xlsx'
    ));
    assert.equal(deriveLinkedRows(hiddenInbound.sourceType, hiddenInbound.records)[0].visible, false);
  });

  test('旧 service 数据库快照锁定五类来源、链接、revision、checkpoint 和确认语义', (t) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-char-db-'));
    const service = createPositionReconciliationService({
      userDataDir,
      templatePath: TEMPLATE_PATH
    });
    t.after(() => {
      service.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    });
    const rows = sourceRows();
    const paths = SOURCE_DISPLAY_ORDER.map((sourceType) => (
      sourceFile(userDataDir, sourceType, [rows[sourceType]])
    ));

    const prepared = service.prepareSourceImport(paths);
    assert.deepEqual(prepared.results.map((result) => result.status), [
      'ok', 'ok', 'ok', 'ok', 'needs-confirmation'
    ]);
    assert.equal(prepared.successCount, 4);
    assert.equal(prepared.confirmationCount, 1);
    const account = prepared.results[4];
    service.applySourceImport(account.token);

    assert.deepEqual(
      service.store.listRawSummary().map((item) => [item.sourceType, item.rowCount]),
      SOURCE_DISPLAY_ORDER.map((sourceType) => [sourceType, 1])
    );
    assert.deepEqual(
      service.store.listLinkedSummary().map((item) => [item.sourceType, item.rowCount]),
      [
        [SOURCE_TYPES.FUND_TRANSFER, 2],
        [SOURCE_TYPES.TEST_PAYMENT, 1],
        [SOURCE_TYPES.GATEWAY_INBOUND, 1],
        [SOURCE_TYPES.GATEWAY_OUTBOUND, 1],
        [SOURCE_TYPES.BANK_ACCOUNT, 1]
      ]
    );
    for (const sourceType of SOURCE_DISPLAY_ORDER) {
      assert.equal(service.store.getRevision('source', sourceType), 1);
      assert.equal(service.store.getRevision('linked', sourceType), 1);
    }
    assert.equal(service.persistenceCheckpoint().generation, 5);
    assert.equal(
      Number(service.store.db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_operation_inputs
      `).get().count),
      5
    );
    assert.equal(
      Number(service.store.db.prepare(`
        SELECT COUNT(*) AS count
        FROM position_checkpoint_history
      `).get().count),
      6
    );
  });

  test('旧 reader 对外错误仍以物理顺序中的第一条非法行为准', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'position-char-error-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const rows = sourceRows();
    const filePath = sourceFile(dir, SOURCE_TYPES.FUND_TRANSFER, [
      { ...rows[SOURCE_TYPES.FUND_TRANSFER], 付款币种: '' },
      { ...rows[SOURCE_TYPES.FUND_TRANSFER], 调拨单号: 'FT-CHAR-2', 收款币种: '' }
    ]);

    assert.throws(
      () => readSourceFile(filePath),
      (error) => (
        error.code === 'position-source-row-invalid'
        && /第 2 行/.test(error.message)
        && error.detailLines[0] === '付款币种为空'
      )
    );
  });
});
