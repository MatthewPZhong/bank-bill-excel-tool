// v2.1.0-beta.1 PR-B：recon-id-fix-io 集成 smoke 测试
// spec §九.2

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const XLSX = require('xlsx');

const {
  readReconIdFixFile,
  writeReconIdFixOutput,
  writeUnmatchedReport,
  buildMainOutputFileName,
  buildUnmatchedReportFileName,
  sanitizeFileName,
  UNMATCHED_REPORT_HEADERS,
  UNMATCHED_REPORT_SHEET_NAME,
  RECON_RESULT_SHEET_NAME,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME,
  PRE_FUND_UNBALANCED_SHEET_NAME,
  PRE_FUND_BALANCED_SHEET_NAME,
  PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME,
  PRE_FUND_UNBALANCED_FIELDS,
  PRE_FUND_BALANCED_FIELDS,
  DUPLICATE_GATEWAY_HEADERS
} = require('../../src/main-process/recon-id-fix-io');
const {
  RECON_RESULT_FIELDS,
  BUSINESS_BILL_FIELDS,
  OPPONENT_BILL_FIELDS,
  ORDER_REPAIR_FIELDS
} = require('../../src/constants/recon-id-fix-fields');
const {
  GATEWAY_BILL_FIELDS,
  CHANNEL_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  GATEWAY_BILL_SHEET_NAME,
  CHANNEL_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME_GATEWAY
} = require('../../src/constants/gateway-bill-recon-fields');
const { FileValidationError } = require('../../src/backend/file-service/common');

function makeMultiSheetXlsx(sheets, savePath) {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, headers, rows }) => {
    const aoa = [headers, ...rows];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, sheet, name);
  });
  XLSX.writeFile(wb, savePath);
}

function buildFullSheetSet(opts = {}) {
  const reconRows = opts.reconRows || [];
  const businessRows = opts.businessRows || [];
  const opponentRows = opts.opponentRows || [];
  return [
    { name: RECON_RESULT_SHEET_NAME, headers: RECON_RESULT_FIELDS.slice(), rows: reconRows },
    { name: BUSINESS_BILL_SHEET_NAME, headers: BUSINESS_BILL_FIELDS.slice(), rows: businessRows },
    { name: OPPONENT_BILL_SHEET_NAME, headers: OPPONENT_BILL_FIELDS.slice(), rows: opponentRows },
    { name: ORDER_REPAIR_SHEET_NAME, headers: ORDER_REPAIR_FIELDS.slice(), rows: [] }
  ];
}

async function runReconIdFixIoSmokeTests() {
  const tmpDir = path.join(__dirname, '..', '..', '.tmp-smoke-recon-id-fix-io');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // ===== R1：4 sheet 完整 → readReconIdFixFile 成功 =====
  {
    const filePath = path.join(tmpDir, 'all-4-sheets.xlsx');
    const businessRow = BUSINESS_BILL_FIELDS.map((f, i) => `b-${i}`);
    const opponentRow = OPPONENT_BILL_FIELDS.map((f, i) => `o-${i}`);
    const reconRow = RECON_RESULT_FIELDS.map((f, i) => `r-${i}`);
    makeMultiSheetXlsx(buildFullSheetSet({
      reconRows: [reconRow],
      businessRows: [businessRow, businessRow],
      opponentRows: [opponentRow]
    }), filePath);
    const result = readReconIdFixFile(filePath);
    assert.strictEqual(result.fileName, 'all-4-sheets.xlsx', 'R1 fileName');
    assert.strictEqual(result.sheets.reconResult.length, 1, 'R1 reconResult 1 行');
    assert.strictEqual(result.sheets.businessBills.length, 2, 'R1 businessBills 2 行');
    assert.strictEqual(result.sheets.opponentBills.length, 1, 'R1 opponentBills 1 行');
    assert.deepStrictEqual(result.sheets.fixTemplate.headers, ORDER_REPAIR_FIELDS.slice(), 'R1 fixTemplate headers');
    assert.deepStrictEqual(result.sheets.fixTemplate.rows, [], 'R1 fixTemplate rows 空');
  }

  // ===== R2：缺「对账结果」sheet → missing-sheet =====
  {
    const filePath = path.join(tmpDir, 'missing-recon.xlsx');
    const sheets = buildFullSheetSet().filter((s) => s.name !== RECON_RESULT_SHEET_NAME);
    makeMultiSheetXlsx(sheets, filePath);
    assert.throws(
      () => readReconIdFixFile(filePath),
      (err) => err instanceof FileValidationError && err.code === 'missing-sheet',
      'R2 应抛 missing-sheet'
    );
  }

  // ===== R3：缺「业务部门账单」sheet =====
  {
    const filePath = path.join(tmpDir, 'missing-business.xlsx');
    const sheets = buildFullSheetSet().filter((s) => s.name !== BUSINESS_BILL_SHEET_NAME);
    makeMultiSheetXlsx(sheets, filePath);
    assert.throws(
      () => readReconIdFixFile(filePath),
      (err) => err instanceof FileValidationError && err.code === 'missing-sheet',
      'R3 应抛 missing-sheet'
    );
  }

  // ===== R4：缺「对手部门账单」sheet =====
  {
    const filePath = path.join(tmpDir, 'missing-opp.xlsx');
    const sheets = buildFullSheetSet().filter((s) => s.name !== OPPONENT_BILL_SHEET_NAME);
    makeMultiSheetXlsx(sheets, filePath);
    assert.throws(
      () => readReconIdFixFile(filePath),
      (err) => err instanceof FileValidationError && err.code === 'missing-sheet',
      'R4 应抛 missing-sheet'
    );
  }

  // ===== R5：缺「订单修复」sheet =====
  {
    const filePath = path.join(tmpDir, 'missing-fix.xlsx');
    const sheets = buildFullSheetSet().filter((s) => s.name !== ORDER_REPAIR_SHEET_NAME);
    makeMultiSheetXlsx(sheets, filePath);
    assert.throws(
      () => readReconIdFixFile(filePath),
      (err) => err instanceof FileValidationError && err.code === 'missing-sheet',
      'R5 应抛 missing-sheet'
    );
  }

  // ===== R6：表头列数不符（业务部门账单缺 1 列）=====
  {
    const filePath = path.join(tmpDir, 'invalid-cols.xlsx');
    const sheets = [
      { name: RECON_RESULT_SHEET_NAME, headers: RECON_RESULT_FIELDS.slice(), rows: [] },
      { name: BUSINESS_BILL_SHEET_NAME, headers: BUSINESS_BILL_FIELDS.slice(0, -1), rows: [] }, // 少 1 列
      { name: OPPONENT_BILL_SHEET_NAME, headers: OPPONENT_BILL_FIELDS.slice(), rows: [] },
      { name: ORDER_REPAIR_SHEET_NAME, headers: ORDER_REPAIR_FIELDS.slice(), rows: [] }
    ];
    makeMultiSheetXlsx(sheets, filePath);
    assert.throws(
      () => readReconIdFixFile(filePath),
      (err) => err instanceof FileValidationError && err.code === 'invalid-column-count',
      'R6 应抛 invalid-column-count'
    );
  }

  // ===== R7：表头列名错位（业务部门账单第 1 列改名）=====
  {
    const filePath = path.join(tmpDir, 'invalid-col-name.xlsx');
    const wrong = BUSINESS_BILL_FIELDS.slice();
    wrong[0] = 'WrongHeader';
    const sheets = [
      { name: RECON_RESULT_SHEET_NAME, headers: RECON_RESULT_FIELDS.slice(), rows: [] },
      { name: BUSINESS_BILL_SHEET_NAME, headers: wrong, rows: [] },
      { name: OPPONENT_BILL_SHEET_NAME, headers: OPPONENT_BILL_FIELDS.slice(), rows: [] },
      { name: ORDER_REPAIR_SHEET_NAME, headers: ORDER_REPAIR_FIELDS.slice(), rows: [] }
    ];
    makeMultiSheetXlsx(sheets, filePath);
    assert.throws(
      () => readReconIdFixFile(filePath),
      (err) => err instanceof FileValidationError && err.code === 'invalid-column-name',
      'R7 应抛 invalid-column-name'
    );
  }

  // ===== R8：writeReconIdFixOutput round-trip — 写完再读断言数据一致 =====
  {
    const savePath = path.join(tmpDir, 'output.xlsx');
    const fixedRows = [
      { BillDate: '2026-04-01', Bank: '工行', MerchantId: 'M1', OrderId: 'OID-1', DataSource: 'src', OppBu: 'opp', OriginBillSource: 'rcpt', BillType: 'biz', Type: 0, Reference: 'R0001', Currency: 'CNY', Amount: 100.5, OriginBillBizId: 'OB1', ReconBillBizId: 'RB1', SubBizType: 'sbt-A' },
      { BillDate: '2026-04-02', Bank: '建行', MerchantId: 'M2', OrderId: 'OID-2', DataSource: 'src', OppBu: 'opp', OriginBillSource: 'rcpt', BillType: 'biz', Type: 2, Reference: 'COMMON-FIX', Currency: 'USD', Amount: '200', OriginBillBizId: 'OB2', ReconBillBizId: 'RB2', SubBizType: '' }
    ];
    const w = await writeReconIdFixOutput({ fixedRows, savePath });
    assert.strictEqual(w.rowCount, 2, 'R8 写入 2 行');
    assert.ok(fs.existsSync(savePath), 'R8 文件存在');
    // round-trip：读回来
    const wb = XLSX.readFile(savePath);
    assert.deepStrictEqual(wb.SheetNames, [ORDER_REPAIR_SHEET_NAME], 'R8 sheet 名仅 1 个');
    const sheet = wb.Sheets[ORDER_REPAIR_SHEET_NAME];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
    assert.strictEqual(aoa.length, 3, 'R8 读回 1 表头 + 2 行');
    assert.deepStrictEqual(aoa[0], ORDER_REPAIR_FIELDS.slice(), 'R8 表头与常量一致');
    // 第 1 行 OrderId
    assert.strictEqual(aoa[1][3], 'OID-1', 'R8 第 1 行 OrderId');
    // 第 2 行 Reference
    assert.strictEqual(aoa[2][9], 'COMMON-FIX', 'R8 第 2 行 Reference');
    // 第 1 行 Type 数字
    assert.strictEqual(aoa[1][8], 0, 'R8 第 1 行 Type=0');
  }

  // ===== R9：buildMainOutputFileName / sanitizeFileName =====
  {
    const name1 = buildMainOutputFileName('普通场景名', '202604301230');
    assert.match(name1, /^单据对账修复-202604301230-普通场景名\.xlsx$/, 'R9 正常文件名');
    const name2 = buildMainOutputFileName('test/scenario:1', '202604301230');
    // / 和 : 都被 sanitize 成 _
    assert.match(name2, /^单据对账修复-202604301230-test_scenario_1\.xlsx$/, 'R9 危险字符 sanitize');
    // sanitizeFileName 直接调用
    assert.strictEqual(sanitizeFileName('  trailing  '), 'trailing', 'R9 trim 尾空格');
    assert.strictEqual(sanitizeFileName(''), '_', 'R9 空名兜底为 _');
    assert.strictEqual(sanitizeFileName('CON'), '_CON', 'R9 Windows 保留名');
  }

  // ===== R10（Round 3）：writeUnmatchedReport round-trip =====
  {
    const savePath = path.join(tmpDir, 'unmatched.xlsx');
    const unmatchedRows = [
      { 场景名: '基金', 单据来源: '主', OrderId: 'O-1', BillDate: '2026-04-09', Amount: 100, 未配原因: '1v1 严格 BillDate 未匹配' },
      { 场景名: '基金', 单据来源: '从', OrderId: 'O-2', BillDate: '2026-04-09', Amount: 200, 未配原因: '池子内 BillDate ±1day 未匹配' },
      { 场景名: '基金', 单据来源: '从', OrderId: 'O-3', BillDate: '2026-04-08', Amount: 300, 未配原因: '未勾 1v多/多v1，跳过' }
    ];
    const w = await writeUnmatchedReport({ unmatchedRows, savePath });
    assert.strictEqual(w.rowCount, 3, 'R10 unmatched 写入 3 行');
    assert.ok(fs.existsSync(savePath), 'R10 unmatched 文件存在');
    const wb = XLSX.readFile(savePath);
    assert.deepStrictEqual(wb.SheetNames, [UNMATCHED_REPORT_SHEET_NAME], 'R10 sheet 名 = 未匹配单据');
    const sheet = wb.Sheets[UNMATCHED_REPORT_SHEET_NAME];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
    assert.strictEqual(aoa.length, 4, 'R10 1 表头 + 3 行');
    assert.deepStrictEqual(aoa[0], Array.from(UNMATCHED_REPORT_HEADERS), 'R10 表头匹配 6 列');
    assert.strictEqual(aoa[1][0], '基金', 'R10 第 1 行场景名');
    assert.strictEqual(aoa[1][1], '主', 'R10 第 1 行 单据来源 = 主');
    assert.strictEqual(aoa[1][5], '1v1 严格 BillDate 未匹配', 'R10 第 1 行未配原因');
  }

  // ===== R11（Round 3）：unmatchedRows = [] 也写空表头 =====
  {
    const savePath = path.join(tmpDir, 'unmatched-empty.xlsx');
    const w = await writeUnmatchedReport({ unmatchedRows: [], savePath });
    assert.strictEqual(w.rowCount, 0, 'R11 unmatched=[] 写入 0 行');
    assert.ok(fs.existsSync(savePath), 'R11 文件仍生成');
    const wb = XLSX.readFile(savePath);
    const sheet = wb.Sheets[UNMATCHED_REPORT_SHEET_NAME];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
    assert.strictEqual(aoa.length, 1, 'R11 仅 1 行表头');
    assert.deepStrictEqual(aoa[0], Array.from(UNMATCHED_REPORT_HEADERS), 'R11 表头存在');
  }

  // ===== R12（Round 3）：buildUnmatchedReportFileName 命名 =====
  {
    const name1 = buildUnmatchedReportFileName('基金', '202605091427');
    assert.match(name1, /^单据对账修复-未匹配-202605091427-基金\.xlsx$/, 'R12 正常文件名');
    const name2 = buildUnmatchedReportFileName('test/recon:fix', '202605091427');
    assert.match(name2, /^单据对账修复-未匹配-202605091427-test_recon_fix\.xlsx$/, 'R12 危险字符 sanitize');
  }

  // ===== R13（Round 5 P3-B）：buildUnmatchedReportFileName 联动主文件 basename =====
  {
    // 用户改主名为 4月对账.xlsx → unmatched = 4月对账-未匹配.xlsx
    const n1 = buildUnmatchedReportFileName('基金', '202605091427', '4月对账.xlsx');
    assert.strictEqual(n1, '4月对账-未匹配.xlsx', 'R13 联动主名（带 .xlsx）');
    // 大小写不敏感的扩展名
    const n2 = buildUnmatchedReportFileName('基金', '202605091427', 'MyReport.XLSX');
    assert.strictEqual(n2, 'MyReport-未匹配.xlsx', 'R13 联动主名（.XLSX 大写）');
    // 主名不带扩展名
    const n3 = buildUnmatchedReportFileName('基金', '202605091427', 'plain-name');
    assert.strictEqual(n3, 'plain-name-未匹配.xlsx', 'R13 联动主名（无扩展名）');
    // 主名含 sanitize 应当处理的字符
    const n4 = buildUnmatchedReportFileName('基金', '202605091427', 'bad/name:1.xlsx');
    assert.strictEqual(n4, 'bad_name_1-未匹配.xlsx', 'R13 联动主名 sanitize 危险字符');
    // 旧 2 参签名不变（向后兼容）
    const nOld = buildUnmatchedReportFileName('基金', '202605091427');
    assert.match(nOld, /^单据对账修复-未匹配-202605091427-基金\.xlsx$/, 'R13 旧 2 参签名兼容');
    // 第 3 参 null 等价于不传
    const nNull = buildUnmatchedReportFileName('基金', '202605091427', null);
    assert.strictEqual(nNull, nOld, 'R13 第 3 参 null = 不传');
  }

  // ===== R14（v3.0.14）：C4 兼容 6-sheet，校验后忽略重复审计数据 =====
  {
    const filePath = path.join(tmpDir, 'pre-fund-six-sheets.xlsx');
    const resultValues = RECON_RESULT_FIELDS_GATEWAY.map((field) => `result-${field}`);
    makeMultiSheetXlsx([
      {
        name: PRE_FUND_UNBALANCED_SHEET_NAME,
        headers: PRE_FUND_UNBALANCED_FIELDS.slice(),
        rows: [['导入银行对账单', ...resultValues]]
      },
      {
        name: PRE_FUND_BALANCED_SHEET_NAME,
        headers: PRE_FUND_BALANCED_FIELDS.slice(),
        rows: []
      },
      { name: GATEWAY_BILL_SHEET_NAME, headers: GATEWAY_BILL_FIELDS.slice(), rows: [] },
      { name: CHANNEL_BILL_SHEET_NAME, headers: CHANNEL_BILL_FIELDS.slice(), rows: [] },
      {
        name: ORDER_REPAIR_SHEET_NAME_GATEWAY,
        headers: ORDER_REPAIR_FIELDS_GATEWAY.slice(),
        rows: []
      },
      {
        name: PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME,
        headers: DUPLICATE_GATEWAY_HEADERS.slice(),
        rows: [[
          'PF-1-1', '被折叠记录', 1, 1, 'reconciliationId+10字段指纹完全重复',
          'fp-1', '网关对账单', 'linked_gateway_bill#2', '2026-07-01', 'CIT',
          'M1', 'O1', 'B1', 'R1', 'USD', '10', 'PAY', 'Alice', '1234',
          'CIT', 'SWIFT', '{"id":2}'
        ]]
      }
    ], filePath);

    const result = readReconIdFixFile(filePath, 'gateway');
    assert.strictEqual(result.sheets.reconResult.length, 1, 'R14 读取不平结果 1 行');
    assert.strictEqual(
      result.sheets.reconResult[0]['账单日期'],
      'result-账单日期',
      'R14 去除来源列后字段位置不偏移'
    );
    assert.strictEqual(
      Object.hasOwn(result.sheets.reconResult[0], '对账数据来源'),
      false,
      'R14 C4 不透传前置资金对账来源列'
    );
    assert.deepStrictEqual(
      Object.keys(result.sheets),
      ['reconResult', 'businessBills', 'opponentBills', 'fixTemplate'],
      'R14 重复审计 sheet 不进入 C4 业务数据'
    );
  }

  console.log('  recon-id-fix-io smoke: 14 / 14 PASS');
}

module.exports = { runReconIdFixIoSmokeTests };
