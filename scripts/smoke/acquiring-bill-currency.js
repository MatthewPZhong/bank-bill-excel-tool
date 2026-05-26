// v2.1.6 Module B T10 — 收单单据币种校验 smoke 用例
// 覆盖 spec §九 Case A-H（含 fix1）+ Case I（fix2 inlineStr + data descriptor）+ Module A A1 watermark 集成断言

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const yazl = require('yazl');

const { AppDatabase } = require('../../src/backend/database');
const { FLOW_HEADERS, BILL_HEADERS, WRITER_OUTPUT_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');
const session = require('../../src/main-process/acquiring-bill-currency-session');
const writer = require('../../src/main-process/acquiring-bill-currency-writer');
const reader = require('../../src/backend/acquiring-bill-currency-import/reader');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
  } else {
    failed += 1;
    failures.push({ label, actual, expected });
  }
}

function assertTrue(cond, label) {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push({ label, actual: false, expected: true });
  }
}

async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers.slice());
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

// v0.7 fix4：reader 入库取 r[28]/r[29]（通道清算金额/币种），旧 r[12]/r[13] 保留填值仅给 raw_json 留底
// 第 5/6 个参数为可选 settleAmount / settleCurrency；不传时默认同 amount / currency（Case A-I 向后兼容）
function makeFlow(id, billDate, amount, currency, settleAmount, settleCurrency) {
  const r = new Array(48).fill('');
  r[0] = billDate;                              // 账单日期
  r[6] = id;                                     // 对账主Id
  r[12] = String(amount);                        // 对账金额（v0.7 仅留底）
  r[13] = currency;                              // 币种（v0.7 仅留底）
  r[28] = String(settleAmount !== undefined ? settleAmount : amount);  // 通道清算金额（v0.7 对账用）
  r[29] = settleCurrency !== undefined ? settleCurrency : currency;     // 通道清算币种（v0.7 对账用）
  return r;
}

function makeBill(id, billDate, amount, currency) {
  const r = new Array(26).fill('');
  r[0] = billDate;       // 账单日期
  r[14] = id;             // 主对账Id
  r[18] = String(amount); // 对账金额
  r[19] = currency;       // 对账币种
  return r;
}

function setupTmpDb() {
  const tmpdir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'abc-smoke-'));
  const db = new AppDatabase(path.join(tmpdir, 't.sqlite'));
  db.init();
  // PR #50 reviewer finding F1：Windows CI 上 fs.rmSync 不能先于 DB close（DatabaseSync 句柄占用 .sqlite 文件 → EBUSY）
  // 所有 case 用 cleanup() 代替手写 rmSync，强制先 close 再 rm
  const cleanup = () => {
    try { db.db.close(); } catch (_e) { /* 已 close 或异常 */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* 已删 / 锁住 → swallow */ }
  };
  return { tmpdir, db, cleanup };
}

async function caseA_happyPath() {
  // 流水 5 行 / 单据 5 行（1 行不一致 + 4 行一致）
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const flowFile = path.join(tmpdir, 'flow.xlsx');
    const billFile = path.join(tmpdir, 'bill.xlsx');
    const date = '2026-03-01';
    await writeXlsx(flowFile, FLOW_HEADERS, [
      makeFlow('A1', date, '10', 'USD'),
      makeFlow('A2', date, '-20', 'USD'),
      makeFlow('A3', date, '30', 'USD'),
      makeFlow('A4', date, '40', 'USD'),
      makeFlow('A5', date, '50', 'USD')
    ]);
    await writeXlsx(billFile, BILL_HEADERS, [
      makeBill('A1', date, '10', 'USD'),
      makeBill('A2', date, '20', 'EUR'),
      makeBill('A3', date, '30', 'USD'),
      makeBill('A4', date, '40', 'USD'),
      makeBill('A5', date, '50', 'USD')
    ]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [flowFile] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [billFile] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03' });

    assertEq(r.totalBillRows, 5, 'A.totalBillRows');
    assertEq(r.matchedRows, 5, 'A.matchedRows');
    assertEq(r.mismatchRows, 1, 'A.mismatchRows');
    assertEq(r.unmatchedRows, 0, 'A.unmatchedRows');

    // v0.8 fix5：跑 run 时同步产出 diff + report；writeRunOutputs 单文件单 sheet
    const exp = await writer.writeRunOutputs({ db: db.db, runId: r.runId, monthKey: '2026-03', storageRoot: tmpdir, runElapsedMs: 0 });
    assertTrue(exp.diffFilePath && exp.diffFilePath.endsWith('.xlsx'), 'A.diffFilePath');
    assertEq(exp.diffRowCount, 1, 'A.diffRowCount');
    assertTrue(exp.reportFilePath && fs.existsSync(exp.reportFilePath), 'A.reportFilePath 存在');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(exp.diffFilePath);
    const ws = wb.worksheets[0];
    assertEq(ws.columnCount, 29, 'A.columns=29');
    assertEq(ws.rowCount, 2, 'A.rowCount=2(表头+1差异)');
    assertEq(ws.getRow(1).values.slice(-4), [WRITER_OUTPUT_HEADERS[25], '单据_对账币种', '流水_通道清算币种', '流水_通道清算金额'], 'A.末4列表头');
    assertEq(ws.getRow(2).values.slice(-3), ['EUR', 'USD', '20'], 'A.差异行末3列');
    // A1 watermark 断言
    assertEq(wb.lastModifiedBy, 'pzhong', 'A1.watermark.lastModifiedBy');
  } finally {
    cleanup();
  }
}

async function caseB_duplicateReconId() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const flowFile = path.join(tmpdir, 'flow.xlsx');
    const date = '2026-03-01';
    await writeXlsx(flowFile, FLOW_HEADERS, [
      makeFlow('B1', date, '10', 'USD'),
      makeFlow('B1', date, '20', 'EUR')  // 重复
    ]);

    let threw = false;
    let errName = null;
    try {
      await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [flowFile] });
    } catch (e) {
      threw = true;
      errName = e && e.name;
    }
    assertTrue(threw, 'B.整批拒绝');
    assertEq(errName, 'ImportValidationError', 'B.errType');

    // ROLLBACK 后表里应该没数据
    const count = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_flow_imports').get().c;
    assertEq(count, 0, 'B.ROLLBACK 生效');
  } finally {
    cleanup();
  }
}

async function caseC_billCurrencyMissing() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-01';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [makeFlow('C1', date, '10', 'USD')]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [makeBill('C1', date, '10', '')]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03' });
    assertEq(r.mismatchRows, 1, 'C.mismatchRows');

    const diff = db.db.prepare('SELECT diff_type FROM acquiring_bill_currency_diff_rows').get();
    assertEq(diff.diff_type, 'bill_currency_missing', 'C.diff_type');
  } finally {
    cleanup();
  }
}

async function caseD_multiFile1to1() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-01';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [
      makeFlow('D1', date, '10', 'USD'), makeFlow('D2', date, '20', 'USD')
    ]);
    await writeXlsx(path.join(tmpdir, 'billA.xlsx'), BILL_HEADERS, [makeBill('D1', date, '10', 'EUR')]); // 1 差异
    await writeXlsx(path.join(tmpdir, 'billB.xlsx'), BILL_HEADERS, [makeBill('D2', date, '20', 'USD')]); // 0 差异

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'billA.xlsx'), path.join(tmpdir, 'billB.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03' });
    // v0.8 fix5：合并所有 source_file 到单文件单 sheet
    const exp = await writer.writeRunOutputs({ db: db.db, runId: r.runId, monthKey: '2026-03', storageRoot: tmpdir, runElapsedMs: 0 });

    assertEq(exp.diffRowCount, 1, 'D.合并后 1 差异行（来自 billA）');
    assertTrue(exp.diffFilePath && fs.existsSync(exp.diffFilePath), 'D.diff 文件存在');
    assertTrue(exp.reportFilePath && fs.existsSync(exp.reportFilePath), 'D.report 文件存在');
  } finally {
    cleanup();
  }
}

async function caseE_currencyCaseNormalize() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-01';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [
      makeFlow('E1', date, '10', 'USD'),
      makeFlow('E2', date, '20', 'usd'),
      makeFlow('E3', date, '30', ' USD ')
    ]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [
      makeBill('E1', date, '10', 'usd'),
      makeBill('E2', date, '20', 'USD'),
      makeBill('E3', date, '30', 'USD')
    ]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03' });
    assertEq(r.mismatchRows, 0, 'E.大小写/空格归一后视为一致');
  } finally {
    cleanup();
  }
}

async function caseF_headerMismatch() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    // 故意少 1 列
    const badHeaders = FLOW_HEADERS.slice(0, 47);
    const r = new Array(47).fill('');
    r[0] = '2026-03-01';
    r[6] = 'F1';
    r[12] = '10';
    r[13] = 'USD';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), badHeaders, [r]);

    let threw = false;
    let errName = null;
    try {
      await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    } catch (e) {
      threw = true;
      errName = e && e.name;
    }
    assertTrue(threw, 'F.表头不匹配整批拒绝');
    assertEq(errName, 'ImportValidationError', 'F.errType');
  } finally {
    cleanup();
  }
}

async function caseG_unmatchedNotInDiff() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-01';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [makeFlow('G1', date, '10', 'USD')]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [
      makeBill('G1', date, '10', 'USD'),
      makeBill('G2', date, '20', 'EUR')  // unmatched
    ]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03' });

    assertEq(r.totalBillRows, 2, 'G.totalBillRows');
    assertEq(r.matchedRows, 1, 'G.matchedRows');
    assertEq(r.unmatchedRows, 1, 'G.unmatchedRows=1 (G2)');
    assertEq(r.mismatchRows, 0, 'G.mismatchRows=0 (G1 一致 / G2 unmatched 不入 diff)');
  } finally {
    cleanup();
  }
}

// fix1 (spec §3.4) — H1：已有数据 → peek 返回 overwrite-required（不进事务）
async function caseH1_peekOverwriteRequired() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-01';
    const billFile = path.join(tmpdir, 'bill.xlsx');
    await writeXlsx(billFile, BILL_HEADERS, [
      makeBill('H1A', date, '10', 'USD'),
      makeBill('H1B', date, '20', 'USD')
    ]);
    // 先导入一次（DB 有 2 行）
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [billFile] });
    const before = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports').get().c;
    assertEq(before, 2, 'H1.首次导入后行数=2');

    // peek（不进事务）
    const peeked = await session.peekImportTarget({ db: db.db, kind: 'bill', filePaths: [billFile] });
    assertEq(peeked.monthKey, '2026-03', 'H1.peek monthKey');
    assertEq(peeked.existingCount, 2, 'H1.peek existingCount=2');
    assertEq(peeked.kind, 'bill', 'H1.peek kind');

    // DB 行数不变（peek 不动数据）
    const after = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports').get().c;
    assertEq(after, 2, 'H1.peek 后行数不变');
  } finally {
    cleanup();
  }
}

// fix1 (spec §3.4) — H2：已有数据 → confirmOverwrite=true → 单侧清+导入；不动 runs/diff_rows
async function caseH2_overwriteImport() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-01';
    const flowFile = path.join(tmpdir, 'flow.xlsx');
    await writeXlsx(flowFile, FLOW_HEADERS, [makeFlow('H2A', date, '10', 'USD')]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [makeBill('H2A', date, '10', 'USD')]);
    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [flowFile] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });

    // 跑 1 次 run，留 runs 记录（H2 验证覆盖导入不动 runs）
    const r1 = await session.runCheck({ db: db.db, monthKey: '2026-03' });
    assertEq(r1.matchedRows, 1, 'H2.先 run 一次（留 runs 记录）');
    const runsBefore = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_runs').get().c;
    assertEq(runsBefore, 1, 'H2.runs 表 1 条记录');

    // 新流水文件：覆盖导入（同月份，不同 ID）
    const flowFile2 = path.join(tmpdir, 'flow2.xlsx');
    await writeXlsx(flowFile2, FLOW_HEADERS, [
      makeFlow('H2B', date, '20', 'USD'),
      makeFlow('H2C', date, '30', 'USD')
    ]);
    const result = await session.importFlowFilesWithOverwrite({
      db: db.db,
      monthKey: '2026-03',
      filePaths: [flowFile2]
    });
    assertEq(result.totalImported, 2, 'H2.覆盖导入新增 2 行');
    assertEq(result.deletedCount, 1, 'H2.清旧 1 行');

    // 流水表只剩新数据 2 行
    const flowCount = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_flow_imports').get().c;
    assertEq(flowCount, 2, 'H2.流水表行数=2（旧清新增）');

    // 单据表未动（仍为 1 行）
    const billCount = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports').get().c;
    assertEq(billCount, 1, 'H2.单据表未受影响（仍 1 行）');

    // runs / diff_rows 不动
    const runsAfter = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_runs').get().c;
    assertEq(runsAfter, 1, 'H2.runs 表未变');
  } finally {
    cleanup();
  }
}

// fix2 (spec §3.5) — Case I：inlineStr 格式 xlsx + yazl data descriptor 模式 ZIP
// 验证 reader（yauzl + sax）能正确读取真实清结算导出格式（fflate/unzipper 拒解的格式）
function buildInlineStrXlsx(filePath, sheetXmlBody) {
  // sheetXmlBody = "<sheetData>...</sheetData>" 内容
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:AV2"/>
${sheetXmlBody}
</worksheet>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?>
<sst count="0" uniqueCount="0" xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`;

  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(contentTypes), '[Content_Types].xml');
    zip.addBuffer(Buffer.from(rels), '_rels/.rels');
    zip.addBuffer(Buffer.from(workbook), 'xl/workbook.xml');
    zip.addBuffer(Buffer.from(workbookRels), 'xl/_rels/workbook.xml.rels');
    zip.addBuffer(Buffer.from(sst), 'xl/sharedStrings.xml');
    zip.addBuffer(Buffer.from(sheetXml), 'xl/worksheets/sheet1.xml');
    zip.end();
    const ws = fs.createWriteStream(filePath);
    zip.outputStream.pipe(ws);
    ws.on('close', resolve);
    ws.on('error', reject);
  });
}

function inlineCell(col, rowR, val) {
  return `<c r="${col}${rowR}" t="inlineStr"><is><t>${val}</t></is></c>`;
}

async function caseI_inlineStrDataDescriptor() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    // 构造 flow xlsx：表头 1 行（48 列 FLOW_HEADERS）+ 数据 1 行
    const cols = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','AA','AB','AC','AD','AE','AF','AG','AH','AI','AJ','AK','AL','AM','AN','AO','AP','AQ','AR','AS','AT','AU','AV'];
    const headerCells = FLOW_HEADERS.map((h, i) => inlineCell(cols[i], 1, h)).join('');
    const dataValues = new Array(48).fill('');
    dataValues[0] = '2026-03-15';   // 账单日期
    dataValues[6] = 'I1';            // 对账主Id
    dataValues[12] = '99.50';        // 对账金额（v0.7 仅留底）
    dataValues[13] = 'USD';          // 币种（v0.7 仅留底）
    dataValues[28] = '99.50';        // 通道清算金额（v0.7 对账用）
    dataValues[29] = 'USD';          // 通道清算币种（v0.7 对账用）
    const dataCells = dataValues.map((v, i) => inlineCell(cols[i], 2, v)).join('');

    const sheetBody = `<sheetData>
<row r="1">${headerCells}</row>
<row r="2">${dataCells}</row>
</sheetData>`;

    const flowFile = path.join(tmpdir, 'inlineStr-flow.xlsx');
    await buildInlineStrXlsx(flowFile, sheetBody);

    // 验证文件确实是 data descriptor 模式（yauzl 能开但 SheetJS dense 拒）
    // 直接用 reader 读取
    const peeked = await reader.peekMonthKeyFromFile({ kind: 'flow', filePath: flowFile });
    assertEq(peeked.monthKey, '2026-03', 'I.peek monthKey from inlineStr xlsx');

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [flowFile] });
    const dbRows = db.db.prepare('SELECT recon_main_id, settle_currency, settle_currency_norm, settle_amount, settle_amount_abs FROM acquiring_bill_currency_flow_imports').all();
    assertEq(dbRows.length, 1, 'I.import 1 行');
    assertEq(dbRows[0].recon_main_id, 'I1', 'I.recon_main_id');
    assertEq(dbRows[0].settle_currency, 'USD', 'I.settle_currency (inlineStr 解析)');
    assertEq(dbRows[0].settle_currency_norm, 'usd', 'I.settle_currency_norm');
    assertEq(dbRows[0].settle_amount, '99.50', 'I.settle_amount');
    assertEq(dbRows[0].settle_amount_abs, '99.5', 'I.settle_amount_abs');
  } finally {
    cleanup();
  }
}

// fix4 (spec §3.1 §5.2) — Case J：通道清算币种与原币种不同，按 settle_currency 比对而非 currency
// flow.[13]=USD（订单币种）+ flow.[29]=EUR（通道清算）+ bill.[19]=EUR（对账币种）→ matched, mismatch=0
async function caseJ_settleCurrencyMatching() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-15';
    const flowRow = new Array(48).fill('');
    flowRow[0] = date; flowRow[6] = 'J1'; flowRow[12] = '100'; flowRow[13] = 'USD'; flowRow[28] = '100'; flowRow[29] = 'EUR';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [flowRow]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [makeBill('J1', date, '100', 'EUR')]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03' });

    assertEq(r.totalBillRows, 1, 'J.totalBillRows');
    assertEq(r.matchedRows, 1, 'J.matched=1（按 settle_currency EUR↔EUR 比对）');
    assertEq(r.mismatchRows, 0, 'J.mismatch=0（不再被订单币种 USD ≠ EUR 误判）');
  } finally {
    cleanup();
  }
}

// fix4 — Case K：流水通道清算币种 ≠ 单据对账币种 → mismatch
async function caseK_settleCurrencyMismatch() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-15';
    const flowRow = new Array(48).fill('');
    flowRow[0] = date; flowRow[6] = 'K1'; flowRow[12] = '50'; flowRow[13] = 'CNY'; flowRow[28] = '50'; flowRow[29] = 'USD';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [flowRow]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [makeBill('K1', date, '50', 'EUR')]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03' });
    assertEq(r.mismatchRows, 1, 'K.mismatch=1');

    const diff = db.db.prepare('SELECT flow_currency, flow_amount_abs, diff_type FROM acquiring_bill_currency_diff_rows').get();
    assertEq(diff.flow_currency, 'USD', 'K.diff_rows.flow_currency=USD（来自流水 settle_currency 原值）');
    assertEq(diff.flow_amount_abs, '50', 'K.diff_rows.flow_amount_abs=50');
    assertEq(diff.diff_type, 'currency_mismatch', 'K.diff_type');
  } finally {
    cleanup();
  }
}

// fix4 — Case L：流水通道清算币种为空 + 单据对账币种有值 → mismatch（currency_mismatch，非 bill_currency_missing）
async function caseL_flowSettleCurrencyEmpty() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-15';
    const flowRow = new Array(48).fill('');
    flowRow[0] = date; flowRow[6] = 'L1'; flowRow[12] = '10'; flowRow[13] = 'USD'; flowRow[28] = '10'; flowRow[29] = '';  // 通道清算币种空
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [flowRow]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [makeBill('L1', date, '10', 'EUR')]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03' });
    assertEq(r.mismatchRows, 1, 'L.mismatch=1（流水侧空 ≠ 单据 EUR）');

    const diff = db.db.prepare('SELECT flow_currency, diff_type FROM acquiring_bill_currency_diff_rows').get();
    assertEq(diff.flow_currency, '', 'L.flow_currency 入库为空字符串');
    assertEq(diff.diff_type, 'currency_mismatch', 'L.diff_type（单据有值 → mismatch 而非 missing）');
  } finally {
    cleanup();
  }
}

// fix8 (spec v0.11 §3.4) — Case P：run 成功后默认 cleanup 仅清 flow/bill，**保留 diff_rows**（v2.1.8 N1' v0.7）
//   差异保留是有效输出数据；idle/退出/进入兜底 4 触发点都默认 includeDiff=false
//   仅 cleanupOrphanData Phase 2 显式 includeDiff: true 清孤儿 run 脏数据（caseQ 覆盖）
async function caseP_cleanupAfterRun() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-01';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [
      makeFlow('P1', date, '10', 'USD'),
      makeFlow('P2', date, '20', 'USD')
    ]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [
      makeBill('P1', date, '10', 'USD'),
      makeBill('P2', date, '20', 'EUR')  // P2 币种差异
    ]);
    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });

    // v0.12 fix9：跑 run 仅落盘 + 标记 cleanupNeeded；cleanup 通过 cleanupAfterRunBackground 异步分批跑
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03', storageRoot: tmpdir });

    // 断言 1：diff/report 文件存在
    assertTrue(r.diffFilePath && fs.existsSync(r.diffFilePath), 'P.diff 文件存在');
    assertTrue(r.reportFilePath && fs.existsSync(r.reportFilePath), 'P.report 文件存在');

    // 断言 2 (fix9 修订)：runCheck 仅标记 cleanupNeeded=true，但不立即清；原始数据此时仍在
    assertEq(r.cleanupNeeded, true, 'P.cleanupNeeded=true');
    const flowBefore = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports').get().c;
    const billBefore = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports').get().c;
    const diffBefore = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assertEq(flowBefore, 2, 'P.flow_imports 在 runCheck 后仍未清');
    assertEq(billBefore, 2, 'P.bill_imports 在 runCheck 后仍未清');
    assertEq(diffBefore, 1, 'P.diff_rows 在 runCheck 后仍未清');

    // 显式调 cleanupAfterRunBackground（模拟 main.js handler 的 setImmediate 后台触发；includeDiff 默认 false）
    const cleanupStats = await session.cleanupAfterRunBackground({ db: db.db, monthKey: '2026-03', runId: r.runId });

    // v2.1.8 N1' (v0.7) 断言 3：cleanup 默认 includeDiff=false → 仅清 flow；bill + diff 保留
    //   ⚠️ FK 约束：diff_rows.bill_import_id REFERENCES bill_imports.id（无 CASCADE）
    //              保留 diff 必须连带保留 bill；flow 与 diff_rows 无 FK，可独立清
    const flowAfter = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports').get().c;
    const billAfter = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports').get().c;
    const diffAfter = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assertEq(flowAfter, 0, 'P.flow_imports cleanup 后已清');
    assertEq(billAfter, 2, 'P.bill_imports 默认保留（diff_rows FK 约束）');
    assertEq(diffAfter, 1, 'P.diff_rows 默认 includeDiff=false → 保留');

    // 断言 4：runs 保留（含路径）
    const runs = db.db.prepare('SELECT id, diff_file_path, report_file_path FROM acquiring_bill_currency_runs').all();
    assertEq(runs.length, 1, 'P.runs 保留 1 条');
    assertEq(runs[0].diff_file_path, r.diffFilePath, 'P.runs.diff_file_path 正确');
    assertEq(runs[0].report_file_path, r.reportFilePath, 'P.runs.report_file_path 正确');

    // v2.1.8 N1' (v0.7) 断言 5：cleanupStats.bill/diffDeleted=0（默认 includeDiff=false 仅清 flow）
    assertEq(cleanupStats.flowDeleted, 2, 'P.cleanupStats.flowDeleted=2');
    assertEq(cleanupStats.billDeleted, 0, 'P.cleanupStats.billDeleted=0（默认 includeDiff=false 不清 bill）');
    assertEq(cleanupStats.diffDeleted, 0, 'P.cleanupStats.diffDeleted=0（默认 includeDiff=false 不清 diff）');
  } finally {
    cleanup();
  }
}

// v2.1.8 N1' (v0.7) — Case P2：cleanupAfterRunBackground 显式 includeDiff:true → 清 3 表（cleanupOrphanData Phase 2 路径）
async function caseP2_cleanupAfterRunIncludeDiff() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-04-01';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [makeFlow('P2x', date, '50', 'USD')]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [makeBill('P2x', date, '50', 'EUR')]);
    await session.importFlowFiles({ db: db.db, monthKey: '2026-04', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-04', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-04', storageRoot: tmpdir });

    // includeDiff=true 模式
    const stats = await session.cleanupAfterRunBackground({
      db: db.db, monthKey: '2026-04', runId: r.runId, includeDiff: true
    });
    assertEq(stats.flowDeleted, 1, 'P2.flowDeleted=1');
    assertEq(stats.billDeleted, 1, 'P2.billDeleted=1');
    assertEq(stats.diffDeleted, 1, 'P2.diffDeleted=1（includeDiff=true 时清 diff）');

    const flowAfter = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports').get().c;
    const billAfter = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports').get().c;
    const diffAfter = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assertEq(flowAfter, 0, 'P2.flow_imports 已清');
    assertEq(billAfter, 0, 'P2.bill_imports 已清');
    assertEq(diffAfter, 0, 'P2.diff_rows includeDiff=true → 已清');
  } finally {
    cleanup();
  }
}

// fix6 (spec v0.9 §3.1) — Case O：流水「通道清算金额」为空允许入库（与币种对称，业务上 4 种非清算子类型）
async function caseO_settleAmountEmpty() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-15';
    // 流水 1: 金额币种都空（非清算流水）+ 有对应单据
    const flowRowEmpty = new Array(48).fill('');
    flowRowEmpty[0] = date; flowRowEmpty[6] = 'O_EMPTY'; flowRowEmpty[12] = '10'; flowRowEmpty[13] = 'USD';
    flowRowEmpty[28] = ''; // 通道清算金额空
    flowRowEmpty[29] = ''; // 通道清算币种也空
    // 流水 2: 正常清算流水
    const flowRowNormal = new Array(48).fill('');
    flowRowNormal[0] = date; flowRowNormal[6] = 'O_NORMAL'; flowRowNormal[12] = '20'; flowRowNormal[13] = 'USD';
    flowRowNormal[28] = '20'; flowRowNormal[29] = 'USD';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [flowRowEmpty, flowRowNormal]);

    // 单据：两行都有币种（与流水 O_EMPTY/O_NORMAL 对应）
    const billEmpty = makeBill('O_EMPTY', date, '10', 'EUR'); // 与流水侧空形成「流水空 vs 单据有」
    const billNormal = makeBill('O_NORMAL', date, '20', 'USD'); // 与流水侧一致 → 不入差异
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [billEmpty, billNormal]);

    // 入库不应抛错
    let threw = false;
    try {
      await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
      await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    } catch (e) {
      threw = true;
    }
    assertTrue(!threw, 'O.金额空入库成功');

    // O.1 入库 sanity check
    const dbRows = db.db.prepare("SELECT settle_amount, settle_amount_abs, settle_currency, settle_currency_norm FROM acquiring_bill_currency_flow_imports WHERE recon_main_id = 'O_EMPTY'").all();
    assertEq(dbRows.length, 1, 'O.flow O_EMPTY 入库 1 行');
    assertEq(dbRows[0].settle_amount, '', 'O.settle_amount 空字符串');
    assertEq(dbRows[0].settle_amount_abs, '', 'O.settle_amount_abs 空字符串');
    assertEq(dbRows[0].settle_currency, '', 'O.settle_currency 空字符串');
    assertEq(dbRows[0].settle_currency_norm, '', 'O.settle_currency_norm 空字符串');

    // O.2（PR #50 NewF1 修正）：run 后，空金额/币种行**保留参与对账**，作为「流水空 vs 单据有」mismatch 入 diff_rows
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03', storageRoot: tmpdir });
    assertEq(r.mismatchRows, 1, 'O.run 后 mismatch_rows = 1（O_EMPTY 流水空 vs O_EMPTY 单据 EUR）');
    assertEq(r.matchedRows, 2, 'O.run 后 matched_rows = 2（两行都 INNER JOIN 上）');

    // 注意：fix9 cleanup 是 main.js handler 异步触发的；smoke 走 session.runCheck 不触发 cleanup
    // 所以 diff_rows 这里还在
    const diffRows = db.db.prepare("SELECT flow_currency, flow_amount_abs, diff_type FROM acquiring_bill_currency_diff_rows WHERE run_id = ?").all(r.runId);
    assertEq(diffRows.length, 1, 'O.diff_rows 含 1 行（流水空对单据非空）');
    assertEq(diffRows[0].flow_currency, '', 'O.diff_rows.flow_currency = 空字符串（流水侧 settle_currency 原值）');
    assertEq(diffRows[0].flow_amount_abs, '', 'O.diff_rows.flow_amount_abs = 空字符串（流水侧 settle_amount_abs 原值）');
    // spec §5.2 SQL CASE 判 diff_type 看单据侧 settle_currency_norm — 单据有币种 → currency_mismatch（不是 bill_currency_missing）
    assertEq(diffRows[0].diff_type, 'currency_mismatch', 'O.diff_type = currency_mismatch（单据侧有币种）');
  } finally {
    cleanup();
  }
}

// fix5 (spec §3.3) — Case M：用户选月份 ≠ xlsx 内账单日期月份 → 整批拒绝（跨月份混杂）
async function caseM_userMonthMismatch() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    // xlsx 账单日期是 2026-04
    const flowFile = path.join(tmpdir, 'flow.xlsx');
    await writeXlsx(flowFile, FLOW_HEADERS, [makeFlow('M1', '2026-04-15', '10', 'USD')]);

    // 用户选月份 2026-03（与 xlsx 不一致）
    let threw = false;
    let errMsg = null;
    let detailLines = null;
    try {
      await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [flowFile] });
    } catch (e) {
      threw = true;
      errMsg = e.message || '';
      detailLines = e.detailLines || [];
    }
    assertTrue(threw, 'M.跨月份拒绝');
    assertTrue(errMsg.includes('导入失败'), 'M.错误信息含「导入失败」');
    assertTrue(detailLines.some((line) => line.includes('跨月份混杂')), 'M.detailLines 含「跨月份混杂」');

    // ROLLBACK 后表里应该没数据
    const count = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_flow_imports').get().c;
    assertEq(count, 0, 'M.ROLLBACK 生效');
  } finally {
    cleanup();
  }
}

// fix1 (spec §3.4) — H3：peek 时表头不匹配 → 抛错（不进事务）
async function caseH3_peekHeaderMismatch() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    // 故意少 1 列
    const badHeaders = BILL_HEADERS.slice(0, 25);
    const r = new Array(25).fill('');
    r[0] = '2026-03-01';
    r[14] = 'H3';
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), badHeaders, [r]);

    let threw = false;
    let errName = null;
    try {
      await session.peekImportTarget({ db: db.db, kind: 'bill', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    } catch (e) {
      threw = true;
      errName = e && e.name;
    }
    assertTrue(threw, 'H3.peek 表头不匹配抛错');
    assertEq(errName, 'ImportValidationError', 'H3.errType');

    // DB 仍为空（不进事务）
    const count = db.db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports').get().c;
    assertEq(count, 0, 'H3.peek 失败后 DB 仍空');
  } finally {
    cleanup();
  }
}

// fix10 (spec v0.13 §5.4) — Case Q：cleanupOrphanData 处理 ① status != 'success' 的孤儿 run + ② status='success' 但文件丢失的 run；正常 success+file-exists run 不受影响
async function caseQ_cleanupOrphanData() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    // 步骤 1：跑一个正常 success run（month 2026-01），不调 cleanupAfterRunBackground，模拟 fix9 path 但 cleanup 未跑
    const dateA = '2026-01-15';
    await writeXlsx(path.join(tmpdir, 'flow-a.xlsx'), FLOW_HEADERS, [makeFlow('OK1', dateA, '10', 'USD')]);
    await writeXlsx(path.join(tmpdir, 'bill-a.xlsx'), BILL_HEADERS, [makeBill('OK1', dateA, '10', 'USD')]);
    await session.importFlowFiles({ db: db.db, monthKey: '2026-01', filePaths: [path.join(tmpdir, 'flow-a.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-01', filePaths: [path.join(tmpdir, 'bill-a.xlsx')] });
    const okRun = await session.runCheck({ db: db.db, monthKey: '2026-01', storageRoot: tmpdir });
    // 此时 OK run 在 runs 表 status='success' + diff/report 文件存在 → 不是孤儿
    // 但 flow/bill imports 仍在（cleanup 未跑），符合「正常 success run + imports 未清」场景

    // 步骤 2：手工 INSERT 一个 status='running' 的孤儿 run（模拟 fix3 之前 OOM 或 fix9 异常退出）
    const orphanRunInsert = db.db.prepare(
      "INSERT INTO acquiring_bill_currency_runs (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status) VALUES ('2026-02', ?, 100, 50, 50, 0, 'running')"
    ).run(new Date().toISOString());
    const orphanRunId = Number(orphanRunInsert.lastInsertRowid);

    // 关联 bill_imports（同月 2026-02）
    for (let i = 0; i < 3; i++) {
      db.db.prepare(
        "INSERT INTO acquiring_bill_currency_bill_imports (month_key, recon_main_id, settle_currency, settle_currency_norm, raw_json, source_file, source_row_index, imported_at) VALUES ('2026-02', ?, 'EUR', 'eur', '{}', 'fake.xlsx', ?, ?)"
      ).run(`ORPHAN${i}`, i + 2, new Date().toISOString());
    }
    const billIds = db.db.prepare("SELECT id FROM acquiring_bill_currency_bill_imports WHERE month_key='2026-02'").all();
    // 关联 diff_rows（用孤儿 run_id 和孤儿 bill_import_id）
    for (const b of billIds) {
      db.db.prepare(
        "INSERT INTO acquiring_bill_currency_diff_rows (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type) VALUES (?, ?, 'USD', '100', 'currency_mismatch')"
      ).run(orphanRunId, b.id);
    }
    // 关联 flow_imports
    db.db.prepare(
      "INSERT INTO acquiring_bill_currency_flow_imports (month_key, recon_main_id, settle_currency, settle_currency_norm, settle_amount, settle_amount_abs, raw_json, source_file, source_row_index, imported_at) VALUES ('2026-02', 'ORPHAN0', 'USD', 'usd', '100', '100', '{}', 'fake.xlsx', 2, ?)"
    ).run(new Date().toISOString());

    // 断言初始状态
    const orphanRunsBefore = db.db.prepare("SELECT COUNT(*) c FROM acquiring_bill_currency_runs WHERE status='running'").get().c;
    assertEq(orphanRunsBefore, 1, 'Q.before: 1 orphan run (status=running)');

    // 步骤 3：调 cleanupOrphanData
    const stats = await session.cleanupOrphanData({ db: db.db });

    // 断言 cleanup 结果：孤儿 run 被识别并清理
    assertEq(stats.orphanRunIds.length, 1, 'Q.stats.orphanRunIds.length=1');
    assertEq(stats.orphanRunIds[0], orphanRunId, 'Q.stats.orphanRunIds[0] = orphan run id');
    assertEq(stats.deletedDiff, 3, 'Q.stats.deletedDiff=3');
    assertEq(stats.deletedFlow, 1, 'Q.stats.deletedFlow=1');
    assertEq(stats.deletedBill, 3, 'Q.stats.deletedBill=3');
    assertEq(stats.deletedRuns, 1, 'Q.stats.deletedRuns=1');

    // 断言孤儿 run 已删
    const orphanRunsAfter = db.db.prepare("SELECT COUNT(*) c FROM acquiring_bill_currency_runs WHERE status='running'").get().c;
    assertEq(orphanRunsAfter, 0, 'Q.after: orphan run deleted');

    // 断言 OK run 未受影响（status='success' + 文件存在 → 不是孤儿）
    const okRunStill = db.db.prepare("SELECT id, diff_file_path, report_file_path FROM acquiring_bill_currency_runs WHERE id = ?").get(okRun.runId);
    assertTrue(!!okRunStill, 'Q.OK run still exists');
    assertEq(okRunStill.diff_file_path, okRun.diffFilePath, 'Q.OK run.diff_file_path 保留');

    // 断言 2026-02 月的 imports 全清（属于孤儿 run）
    const feb_flow = db.db.prepare("SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports WHERE month_key='2026-02'").get().c;
    const feb_bill = db.db.prepare("SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports WHERE month_key='2026-02'").get().c;
    assertEq(feb_flow, 0, 'Q.2026-02 flow_imports 已清');
    assertEq(feb_bill, 0, 'Q.2026-02 bill_imports 已清');

    // 步骤 4：模拟「status='success' 但文件丢失」场景 — 手工删 OK run 的 diff 文件
    fs.unlinkSync(okRun.diffFilePath);
    const stats2 = await session.cleanupOrphanData({ db: db.db });

    // 断言：文件丢失的 OK run 也被识别为孤儿
    assertEq(stats2.orphanRunIds.length, 1, 'Q2.stats.orphanRunIds.length=1（diff file missing）');
    assertEq(stats2.orphanRunIds[0], okRun.runId, 'Q2.stats.orphanRunIds[0] = OK run id');
    assertEq(stats2.deletedRuns, 1, 'Q2.stats.deletedRuns=1');

    // 断言：runs 表全清
    const runsCount = db.db.prepare("SELECT COUNT(*) c FROM acquiring_bill_currency_runs").get().c;
    assertEq(runsCount, 0, 'Q2.runs 全清');

    // 步骤 5：调一次 cleanupOrphanData on empty DB → 应安全返回（无孤儿）
    const stats3 = await session.cleanupOrphanData({ db: db.db });
    assertEq(stats3.orphanRunIds.length, 0, 'Q3.empty DB orphanRunIds=0');
    assertEq(stats3.deletedDiff, 0, 'Q3.deletedDiff=0');
    assertEq(stats3.deletedRuns, 0, 'Q3.deletedRuns=0');
  } finally {
    cleanup();
  }
}

// fix11 (spec v0.14 §6.3.1) — Case R：writer 按账单日期切分多 sheet（≤ 1,048,575 行/sheet）+ 资金红线 sum==mismatch_rows
// 分为 R1（planSegments 纯函数 unit test）+ R2（实跑 run 验证 sheet 结构）
async function caseR_multiSheetSplit() {
  // ============================================================
  // R1: planSegments 单元测试（不需 DB / fixture）
  // ============================================================
  const writer = require('../../src/main-process/acquiring-bill-currency-writer');
  const { planSegments, fmtSheetName, MAX_DATA_ROWS_PER_SHEET } = writer;

  // R1.a: 0 差异行 → 单个空 segment
  {
    const segs = planSegments([]);
    assertEq(segs.length, 1, 'R1.a.0 差异行 segments 长度 = 1');
    assertEq(segs[0].rowCount, 0, 'R1.a.0 差异行 segments[0].rowCount = 0');
  }

  // R1.b: 单日小数据 → 1 个 segment
  {
    const segs = planSegments([{ billDate: '2026-03-01', count: 100 }]);
    assertEq(segs.length, 1, 'R1.b 单日 100 行 → 1 segment');
    assertEq(segs[0].startDate, '2026-03-01', 'R1.b startDate');
    assertEq(segs[0].endDate, '2026-03-01', 'R1.b endDate');
    assertEq(segs[0].rowCount, 100, 'R1.b rowCount');
    assertEq(fmtSheetName(segs[0]), '2026-03-01~03-01', 'R1.b 单日 sheet 名');
  }

  // R1.c: 跨多日小数据 → 1 个 segment
  {
    const segs = planSegments([
      { billDate: '2026-03-01', count: 1000 },
      { billDate: '2026-03-15', count: 2000 },
      { billDate: '2026-03-31', count: 3000 }
    ]);
    assertEq(segs.length, 1, 'R1.c 跨多日 6000 行 → 1 segment');
    assertEq(segs[0].rowCount, 6000, 'R1.c rowCount');
    assertEq(fmtSheetName(segs[0]), '2026-03-01~03-31', 'R1.c sheet 名');
  }

  // R1.d: 触发切分（构造刚好超 1M 的分布）
  {
    const counts = [];
    // 26 个日期 × 50000 行 = 1.3M 行 → 应切 2 个 segment（segment 1 = ~1M / segment 2 = ~300k）
    for (let i = 1; i <= 26; i++) {
      counts.push({ billDate: `2026-03-${pad2(i)}`, count: 50000 });
    }
    const segs = planSegments(counts);
    assertTrue(segs.length >= 2, 'R1.d 触发切分 segments >= 2');
    // sum 对账（资金红线）
    const total = segs.reduce((s, x) => s + x.rowCount, 0);
    assertEq(total, 1300000, 'R1.d 总行数对账 sum(rowCount) == 1.3M');
    // 每 sheet 不超过 MAX
    for (const seg of segs) {
      assertTrue(seg.rowCount <= MAX_DATA_ROWS_PER_SHEET, `R1.d 每 sheet <= ${MAX_DATA_ROWS_PER_SHEET}`);
    }
    // sheet 名升序排列
    for (let i = 1; i < segs.length; i++) {
      assertTrue(segs[i].startDate >= segs[i - 1].endDate, `R1.d sheet ${i} startDate 升序`);
    }
  }

  // R1.e: 同日单日超过 MAX → 允许同日跨 sheet（spec 注释 "同一日期内的行不切开" 是软约束）
  // 实际算法：单日超 MAX 时强制写入（不切开），允许超过
  {
    const segs = planSegments([{ billDate: '2026-03-01', count: 1500000 }]);
    assertEq(segs.length, 1, 'R1.e 单日 1.5M 行 → 仍 1 segment（同日不切开）');
    assertEq(segs[0].rowCount, 1500000, 'R1.e rowCount');
  }

  // R1.f: fmtSheetName 跨月场景
  {
    const sn = fmtSheetName({ startDate: '2026-03-29', endDate: '2026-04-05', rowCount: 100 });
    assertEq(sn, '2026-03-29~04-05', 'R1.f 跨月 sheet 名');
  }

  // ============================================================
  // R2: 实跑 run 验证 sheet 结构（小 fixture 不触发切分，但验证 1 diff sheet + 1 summary sheet = 2 sheet）
  // ============================================================
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-10';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [
      makeFlow('R1', date, '10', 'USD'),
      makeFlow('R2', date, '20', 'USD')
    ]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [
      makeBill('R1', date, '10', 'EUR'), // 差异
      makeBill('R2', date, '20', 'USD')  // 一致
    ]);
    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03', storageRoot: tmpdir });

    // 断言 diff 文件存在 + 含 2 个 sheet（1 diff + 1 summary）
    assertTrue(r.diffFilePath && fs.existsSync(r.diffFilePath), 'R2.diff 文件存在');
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.readFile(r.diffFilePath);
    const sheetNames = wb.worksheets.map((ws) => ws.name);
    assertEq(sheetNames.length, 2, 'R2.workbook 含 2 sheet（1 diff + 1 summary）');
    // 第 1 sheet = diff sheet（命名 YYYY-MM-DD~MM-DD）
    assertTrue(/^\d{4}-\d{2}-\d{2}~\d{2}-\d{2}$/.test(sheetNames[0]), `R2.sheet 1 名格式 = ${sheetNames[0]}`);
    // 第 2 sheet = 运行结果汇总
    assertEq(sheetNames[1], '运行结果汇总', 'R2.sheet 2 = 运行结果汇总');
    // 资金红线对账（runs.mismatchRows 是 source of truth；xlsx 行数验证靠 sheet.actualRowCount）
    assertEq(r.mismatchRows, 1, 'R2.runs.mismatchRows = 1');
    const diffSheet = wb.worksheets[0];
    assertEq(diffSheet.actualRowCount - 1, 1, 'R2.diff sheet 数据行数 (减表头) = 1');
  } finally {
    cleanup();
  }
}

// fix12 (spec v0.14 §6.6) — Case S：ran_at 时区修复（DB 存 ISO 8601 带 Z + writer 显示转本地）
async function caseS_ranAtTimezone() {
  const writer = require('../../src/main-process/acquiring-bill-currency-writer');
  const { formatRanAtLocal } = writer;

  // S1: formatRanAtLocal 处理 ISO 8601 带 Z
  {
    // "2026-05-19T14:51:20.000Z" UTC → 北京时间 22:51:20（本地时区运行此 smoke 时取 Asia/Shanghai）
    const local = formatRanAtLocal('2026-05-19T14:51:20.000Z');
    // 期望格式 "YYYY-MM-DD HH:MM:SS"（不含 Z）
    assertTrue(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(local), `S1.ISO 8601 输出格式 = ${local}`);
    assertTrue(!local.includes('Z'), 'S1.不含 Z');
    assertTrue(!local.includes('T'), 'S1.不含 T');
  }

  // S2: formatRanAtLocal 处理无 Z 的 UTC 字符串（旧 SQLite CURRENT_TIMESTAMP 兼容）
  {
    const local = formatRanAtLocal('2026-05-19 14:51:20');
    assertTrue(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(local), `S2.无 Z 字符串输出格式 = ${local}`);
    // 与 S1 同 UTC → 转出来应该一样
    assertEq(local, formatRanAtLocal('2026-05-19T14:51:20.000Z'), 'S2.无 Z 与带 Z 解析结果一致');
  }

  // S3: 空/无效输入
  {
    assertEq(formatRanAtLocal(''), '', 'S3.空字符串');
    assertEq(formatRanAtLocal(null), '', 'S3.null');
    assertEq(formatRanAtLocal('invalid'), 'invalid', 'S3.无效字符串原样返回');
  }

  // S4: 实跑 run 后断言 runs.ran_at 含 'Z' 后缀（ISO 8601）
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-10';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [makeFlow('S1', date, '10', 'USD')]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [makeBill('S1', date, '10', 'EUR')]);
    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03', storageRoot: tmpdir });

    const run = db.db.prepare('SELECT ran_at FROM acquiring_bill_currency_runs WHERE id = ?').get(r.runId);
    assertTrue(run.ran_at && run.ran_at.endsWith('Z'), `S4.runs.ran_at 含 Z 后缀 = ${run.ran_at}`);
    assertTrue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(run.ran_at), 'S4.runs.ran_at ISO 8601 格式');
  } finally {
    cleanup();
  }
}

// PR #50 round 3 NewF1 — Case ExtraCol：表头列多（额外尾列）应被 validator 拒绝
async function caseExtraColumn_headerStrictness() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    // 在 FLOW_HEADERS（48 列）后面加 1 列「多余列」生成 49 列表头
    const extraFlowHeaders = [...FLOW_HEADERS, '多余列'];
    const dataRow = new Array(49).fill('');
    dataRow[0] = '2026-03-10'; dataRow[6] = 'E1'; dataRow[28] = '10'; dataRow[29] = 'USD';
    dataRow[48] = '多余值'; // 第 49 列数据
    await writeXlsx(path.join(tmpdir, 'flow-extra.xlsx'), extraFlowHeaders, [dataRow]);

    let err = null;
    try {
      await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow-extra.xlsx')] });
    } catch (e) {
      err = e;
    }
    assertTrue(!!err, 'ExtraCol.列多 xlsx 应被拒');
    assertTrue(err && /表头列数不匹配/.test(String(err.message || '')), `ExtraCol.错误信息含「表头列数不匹配」：${err && err.message}`);
    // validator: error.message = "...模板 48 列，文件 49 列"，detailLines = [模板表头, 文件表头]
    const msg = String((err && err.message) || '');
    assertTrue(msg.includes('48 列') && msg.includes('49 列'), `ExtraCol.error.message 含模板列数 + 文件列数：${msg}`);
    // detailLines 应含「多余列」文本（文件表头序列化里）
    const detailStr = (err && err.detailLines || []).join('|');
    assertTrue(detailStr.includes('多余列'), `ExtraCol.detailLines 含「多余列」额外列名：${detailStr.slice(0, 300)}...`);
  } finally {
    cleanup();
  }
}

// PR #50 reviewer finding F2 — Case F2：账单日期 `YYYY/MM/DD` 归一化为 YYYY-MM-DD + writer sheet 名不含 `/`
async function caseF2_billDateNormalize() {
  const validator = require('../../src/backend/acquiring-bill-currency-import/validator');
  const writer = require('../../src/main-process/acquiring-bill-currency-writer');
  const { normalizeBillDate } = validator;
  const { fmtSheetName } = writer;

  // 单元：normalizeBillDate 各种输入格式
  assertEq(normalizeBillDate('2026-03-10'), '2026-03-10', 'F2.YYYY-MM-DD 不变');
  assertEq(normalizeBillDate('2026/3/10'), '2026-03-10', 'F2.YYYY/M/D → YYYY-MM-DD');
  assertEq(normalizeBillDate('2026/03/10'), '2026-03-10', 'F2.YYYY/MM/DD → YYYY-MM-DD');
  assertEq(normalizeBillDate('2026-3-10 03:45:56'), '2026-03-10', 'F2.YYYY-M-D HH:MM:SS → YYYY-MM-DD（去时间）');
  assertEq(normalizeBillDate('2026/3/10 03:45:56'), '2026-03-10', 'F2.YYYY/M/D HH:MM:SS → YYYY-MM-DD');
  assertEq(normalizeBillDate(''), '', 'F2.空字符串');
  assertEq(normalizeBillDate(null), '', 'F2.null');
  assertEq(normalizeBillDate('invalid'), 'invalid', 'F2.无法解析原样返回（reader 已校验，不会走到）');

  // 单元：fmtSheetName 防御性 sanitize — 即使 startDate/endDate 含 `/`（绕过归一化），输出 sheet 名不含 `/`
  const safeName = fmtSheetName({ startDate: '2026/03/01', endDate: '2026/03/10', rowCount: 100 });
  assertTrue(!safeName.includes('/'), `F2.sheet 名不含 /：${safeName}`);
  assertTrue(safeName.length <= 31, `F2.sheet 名长度 <= 31：${safeName} (${safeName.length})`);

  // 集成：reader 入库 `YYYY/M/D` 后 raw_json 「账单日期」字段 = YYYY-MM-DD
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    // 用 YYYY/M/D 格式
    const flowRow = new Array(48).fill('');
    flowRow[0] = '2026/3/10'; flowRow[6] = 'F2_1'; flowRow[28] = '100'; flowRow[29] = 'USD';
    const billRow = new Array(26).fill('');
    billRow[0] = '2026/3/10'; billRow[14] = 'F2_1'; billRow[18] = '100'; billRow[19] = 'EUR';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [flowRow]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [billRow]);

    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });

    // 断言：raw_json 「账单日期」字段是归一化后的 YYYY-MM-DD
    const flowJson = db.db.prepare("SELECT raw_json FROM acquiring_bill_currency_flow_imports WHERE recon_main_id = 'F2_1'").get().raw_json;
    const billJson = db.db.prepare("SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE recon_main_id = 'F2_1'").get().raw_json;
    assertEq(JSON.parse(flowJson)['账单日期'], '2026-03-10', 'F2.flow raw_json 账单日期归一化');
    assertEq(JSON.parse(billJson)['账单日期'], '2026-03-10', 'F2.bill raw_json 账单日期归一化');

    // 集成：跑 run + 输出 diff xlsx，sheet 名不含 `/`
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03', storageRoot: tmpdir });
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.readFile(r.diffFilePath);
    for (const ws of wb.worksheets) {
      assertTrue(!ws.name.includes('/'), `F2.diff sheet 名「${ws.name}」不含 /`);
      assertTrue(!ws.name.includes('\\'), `F2.diff sheet 名「${ws.name}」不含 \\`);
    }
  } finally {
    cleanup();
  }
}

// fix13 (spec v0.14 §6.3.2) — Case T：report 嵌入 diff 末尾 sheet「运行结果汇总」+ 不生成独立 report.xlsx
async function caseT_reportEmbeddedInDiff() {
  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    const date = '2026-03-10';
    await writeXlsx(path.join(tmpdir, 'flow.xlsx'), FLOW_HEADERS, [makeFlow('T1', date, '10', 'USD')]);
    await writeXlsx(path.join(tmpdir, 'bill.xlsx'), BILL_HEADERS, [makeBill('T1', date, '10', 'EUR')]);
    await session.importFlowFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'flow.xlsx')] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-03', filePaths: [path.join(tmpdir, 'bill.xlsx')] });
    const r = await session.runCheck({ db: db.db, monthKey: '2026-03', storageRoot: tmpdir });

    // T1: diff 文件存在
    assertTrue(r.diffFilePath && fs.existsSync(r.diffFilePath), 'T1.diff 文件存在');

    // T2: reportFilePath 兼容字段 = diffFilePath（指向同文件）
    assertEq(r.reportFilePath, r.diffFilePath, 'T2.reportFilePath == diffFilePath');

    // T3: exports/{date}/acquiring-bill-currency/report/ 子目录**不存在**（fix13 删除）
    const reportDir = path.join(path.dirname(r.diffFilePath), 'report');
    assertTrue(!fs.existsSync(reportDir), `T3.exports 不再生成 report/ 子目录 (${reportDir})`);

    // T4: diff workbook 末尾 sheet name = '运行结果汇总'
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.readFile(r.diffFilePath);
    const sheetNames = wb.worksheets.map((ws) => ws.name);
    assertEq(sheetNames[sheetNames.length - 1], '运行结果汇总', 'T4.末尾 sheet = 运行结果汇总');

    // T5: 运行结果汇总 sheet 含 11 区块（验证第 1 行 + 含「运行时间」+「mismatch_rows」等关键字）
    const summarySheet = wb.worksheets.find((ws) => ws.name === '运行结果汇总');
    assertTrue(!!summarySheet, 'T5.找到运行结果汇总 sheet');
    let foundRunTime = false;
    let foundMismatchKey = false;
    let runTimeValue = null;
    summarySheet.eachRow((row) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (c) => cells.push(c.value));
      if (cells[0] === '运行时间') {
        foundRunTime = true;
        runTimeValue = cells[1];
      }
      if (typeof cells[0] === 'string' && cells[0].includes('mismatch_rows')) {
        foundMismatchKey = true;
      }
    });
    assertTrue(foundRunTime, 'T5.summary 含「运行时间」行');
    assertTrue(foundMismatchKey, 'T5.summary 含 mismatch_rows 行');

    // T6: 运行时间字段是本地格式（fix12 转换）— 不含 Z / T，符合 YYYY-MM-DD HH:MM:SS
    assertTrue(typeof runTimeValue === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(runTimeValue), `T6.运行时间是本地格式 = ${runTimeValue}`);
    assertTrue(!String(runTimeValue).includes('Z'), 'T6.运行时间不含 Z');
  } finally {
    cleanup();
  }
}

// helper for Case R: 2-digit pad
function pad2(n) {
  return String(n).padStart(2, '0');
}

async function runAcquiringBillCurrencySmokeTests() {
  await caseA_happyPath();
  await caseB_duplicateReconId();
  await caseC_billCurrencyMissing();
  await caseD_multiFile1to1();
  await caseE_currencyCaseNormalize();
  await caseF_headerMismatch();
  await caseG_unmatchedNotInDiff();
  await caseH1_peekOverwriteRequired();
  await caseH2_overwriteImport();
  await caseH3_peekHeaderMismatch();
  await caseI_inlineStrDataDescriptor();
  await caseJ_settleCurrencyMatching();
  await caseK_settleCurrencyMismatch();
  await caseL_flowSettleCurrencyEmpty();
  await caseM_userMonthMismatch();
  await caseO_settleAmountEmpty();
  await caseP_cleanupAfterRun();
  await caseP2_cleanupAfterRunIncludeDiff();
  await caseQ_cleanupOrphanData();
  await caseR_multiSheetSplit();
  await caseS_ranAtTimezone();
  await caseT_reportEmbeddedInDiff();
  await caseF2_billDateNormalize();
  await caseExtraColumn_headerStrictness();

  const total = passed + failed;
  if (failed === 0) {
    console.log(`[acquiring-bill-currency] ${passed}/${total} smoke tests passed`);
  } else {
    console.error(`[acquiring-bill-currency] ${passed}/${total} smoke tests passed, ${failed} failed:`);
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    throw new Error('acquiring-bill-currency smoke test failed');
  }
}

module.exports = { runAcquiringBillCurrencySmokeTests };
