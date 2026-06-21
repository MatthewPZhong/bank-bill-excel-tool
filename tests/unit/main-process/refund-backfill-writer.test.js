// v2.1.16-beta.4 ③ R5 场景4：refund-backfill-writer 单元测试（🔴 资金红线）
// v3.0.10 改造：sheet1 命中字段标黄（需求3.1）；sheet2 改 13 列（删「结果类型」「退款单号」、银行段 10→12）+ 报错/提示前缀（需求3.2）。
//   退款回填输出细化：银行段 10→12（加 Extra Information + Drawee Name）→ sheet1 31→33、sheet2 11→13。
//
// 覆盖范围（writeRefundBackfillOutput 契约，详 src/main-process/refund-backfill-writer.js）：
//   1. 双 sheet：回填模板 + 未匹配报错
//   2. sheet1 第 1 行 = 33 列表头，顺序严格 = REFUND_TEMPLATE_HEADERS；
//      E 列 = 命中类型；F 列 = 匹配命中详情；银行 12 列含 Debit Amount/Extra Information/Drawee Name，绝不含 Credit Amount
//   3. sheet1 数据行值按表头投影正确
//   4. sheet2 表头 13 列（v3.0.10：REFUND_BANK_COLUMNS 12 + 报错/提示信息），无「结果类型」「退款单号」
//   5. sheet2 银行未匹配行正确落列（缺 key → ''）；报错/提示靠信息列前缀区分
//   6. 表头行加粗
//   7. 返回 { filePath, fileName } 正确；atomic write 不留半文件
//   8. writer 能消费引擎 runRound5RefundOrderBackfill 真实产出
//   9. v3.0.10 需求3.1：sheet1 标黄（argb FFFFFF00、仅 _matchedColumns 列黄、空/无 _matchedColumns 无黄、列偏移 i+1）
//   10. v3.0.10 需求3.2：sheet2 空 backfill 仍输出 13 列表头
//
// 读回用 ExcelJS（与 platform-cleanup-writer.test.js 范式一致）：cell 索引从 1 起；
//   ExcelJS 读回空串 cell.value 为 null。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  writeRefundBackfillOutput,
  BACKFILL_SHEET_NAME,
  UNMATCHED_SHEET_NAME,
  UNMATCHED_HEADERS
} = require('../../../src/main-process/refund-backfill-writer');
const {
  REFUND_TEMPLATE_HEADERS,
  REFUND_BANK_COLUMNS,
  REFUND_RO_COLUMNS
} = require('../../../src/constants/refund-backfill-fields');
const {
  RESULT_ERROR,
  RESULT_NOTICE
} = require('../../../src/main-process/scenario-engines/r5-refund-order-backfill');

// ---------- Fixtures ----------

// 造一条回填模板行（含 REFUND_TEMPLATE_HEADERS 全 33 键），仿引擎 buildBackfillRow 形状。
//   matchedColumns（可选）：v3.0.10 需求3.1 命中标黄列（已是过滤后 sheet1 列）。
function makeBackfillRow(idx, matchedColumns) {
  const row = {
    '退款单号': `RO_${idx}`,
    '状态': 'SUCCESS',
    '渠道流水号': `RECON_${idx}`,
    '渠道退款时间': '2026-06-01',
    '命中类型': '精准命中',
    '匹配命中详情': `"银行对账单ChannelOrderNo里的CO${idx}"匹配上了"refund order银行打款流水号的CO${idx}"`
  };
  // 银行 12 字段原数据（按 REFUND_BANK_COLUMNS 顺序；v3.0.10 含 Extra Information / Payment Detail / Drawee Name）
  row['BillDate'] = '2026-06-01';
  row['Channel'] = 'JPM';
  row['地区'] = 'HK';
  row['MerchantId'] = `M00${idx}`;
  row['Currency'] = 'USD';
  row['Debit Amount'] = idx * 100;
  row['ReconciliationId'] = `RECON_${idx}`;
  row['ChannelOrderNo'] = `CO${idx}`;
  row['CustomerRef'] = `REF_${idx}`;
  row['Extra Information'] = `EI_${idx}`;   // v3.0.10 新增（第 10 列）
  row['Payment Detail'] = `PD_${idx}`;
  row['Drawee Name'] = `DN_${idx}`;         // v3.0.10 新增（第 12 列）
  // 中台 15 字段原数据（按 REFUND_RO_COLUMNS 顺序，O4）；'流水号' 与「退款单号」同值（用户要求双列）
  row['流水号'] = `RO_${idx}`;
  row['加款单号'] = `ADD_${idx}`;
  row['渠道名称'] = 'JPMorgan';
  row['银行大账号'] = `M00${idx}`;
  row['虚拟卡号'] = `VC_${idx}`;
  row['原加款金额'] = idx * 100;
  row['退款金额'] = idx * 100;
  row['币种'] = 'USD';
  row['付款人名称'] = `NAME_${idx}`;
  row['付款卡号'] = `CARD_${idx}`;
  row['附言'] = `MEMO_${idx}`;
  row['客户号'] = `CUST_${idx}`;
  row['账户号'] = `ACCT_${idx}`;
  row['银行打款流水号'] = `CO${idx}`;
  row['valueDate'] = '2026-06-01';
  if (Array.isArray(matchedColumns)) row._matchedColumns = matchedColumns;
  return row;
}

// 银行未匹配行（含 REFUND_BANK_COLUMNS 12 列 + 报错/提示信息），仿引擎 buildUnmatchedBankRow（v3.0.10：保留 结果类型 key、信息列带前缀）
function makeUnmatchedBankRow(idx, resultType, info) {
  const row = { '结果类型': resultType }; // v3.0.10：引擎仍挂 结果类型 key（仅不进 sheet2 投影）
  row['BillDate'] = '2026-06-02';
  row['Channel'] = 'JPM';
  row['地区'] = 'US';
  row['MerchantId'] = `MX0${idx}`;
  row['Currency'] = 'EUR';
  row['Debit Amount'] = idx * 200;
  row['ReconciliationId'] = `RX_${idx}`;
  row['ChannelOrderNo'] = `CX${idx}`;
  row['CustomerRef'] = `RFX_${idx}`;
  row['Extra Information'] = `EIX_${idx}`;  // v3.0.10 新增（第 10 列）
  row['Payment Detail'] = `PDX_${idx}`;
  row['Drawee Name'] = `DNX_${idx}`;        // v3.0.10 新增（第 12 列）
  // v3.0.10 需求3.2：报错/提示并入信息列前缀
  row['报错/提示信息'] = (resultType === RESULT_ERROR ? '【报错】' : '【提示】') + info;
  return row;
}

const YELLOW_ARGB = 'FFFFFF00';
const cellArgb = (cell) => cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb;
const isYellow = (cell) => cellArgb(cell) === YELLOW_ARGB;

let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-backfill-writer-'));
});

test.afterEach(() => {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    tmpDir = null;
  }
});

// ========================================================================
// 1) 双 sheet：回填模板 + 未匹配报错
// ========================================================================
test('① workbook 含「回填模板」+「未匹配报错」两个 sheet', async () => {
  const savePath = path.join(tmpDir, '中台退款订单回填-2026_06_01_1200.xlsx');
  await writeRefundBackfillOutput([makeBackfillRow(1)], [makeUnmatchedBankRow(1, RESULT_ERROR, 'x')], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  assert.strictEqual(BACKFILL_SHEET_NAME, '回填模板');
  assert.strictEqual(UNMATCHED_SHEET_NAME, '未匹配报错');
  assert.ok(wb.getWorksheet('回填模板'), 'workbook 应含「回填模板」sheet');
  assert.ok(wb.getWorksheet('未匹配报错'), 'workbook 应含「未匹配报错」sheet');
});

// ========================================================================
// 2) sheet1 表头 33 列且顺序 = REFUND_TEMPLATE_HEADERS
// ========================================================================
test('② sheet1 表头 33 列顺序正确；E=命中类型 F=匹配命中详情；银行 12 列含 Debit 不含 Credit；中台 15 列', async () => {
  const savePath = path.join(tmpDir, 'h.xlsx');
  await writeRefundBackfillOutput([makeBackfillRow(1)], [], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('回填模板');
  const headerRow = sheet.getRow(1);

  assert.strictEqual(REFUND_TEMPLATE_HEADERS.length, 33, 'REFUND_TEMPLATE_HEADERS 应为 33 列');
  const actualHeaders = REFUND_TEMPLATE_HEADERS.map((_, i) => headerRow.getCell(i + 1).value);
  assert.deepStrictEqual(actualHeaders, REFUND_TEMPLATE_HEADERS.slice(), 'sheet1 表头顺序应严格等于 REFUND_TEMPLATE_HEADERS');

  assert.strictEqual(actualHeaders[4], '命中类型', 'E 列应为「命中类型」');
  assert.strictEqual(actualHeaders[5], '匹配命中详情', 'F 列应为「匹配命中详情」');

  // 银行段第 7 列起 12 列（固定 6 列后）；slice(6, 18) = 6 + 12。
  const bankCols = actualHeaders.slice(6, 18);
  assert.strictEqual(bankCols.length, 12, '银行段应为 12 列');
  assert.deepStrictEqual(bankCols, REFUND_BANK_COLUMNS.slice(), '银行段应严格等于 REFUND_BANK_COLUMNS');

  assert.ok(bankCols.includes('Debit Amount'), '银行段应含 Debit Amount');
  assert.ok(bankCols.includes('Extra Information'), 'v3.0.10：银行段应含 Extra Information');
  assert.ok(bankCols.includes('Payment Detail'), 'O3：银行段应含 Payment Detail');
  assert.ok(bankCols.includes('Drawee Name'), 'v3.0.10：银行段应含 Drawee Name');
  assert.ok(!bankCols.includes('Credit Amount'), '银行段绝不应含 Credit Amount');
  assert.ok(!actualHeaders.includes('Credit Amount'), 'sheet1 全表头绝不应含 Credit Amount');

  const roCols = actualHeaders.slice(18);
  assert.strictEqual(roCols.length, 15, '中台段应为 15 列');
  assert.deepStrictEqual(roCols, REFUND_RO_COLUMNS.slice(), '中台段应严格等于 REFUND_RO_COLUMNS');
});

// ========================================================================
// 3) sheet1 数据行值按表头投影正确
// ========================================================================
test('③ sheet1 数据行值按表头投影正确（E 命中类型 + F 命中详情 + 银行/中台字段）', async () => {
  const row1 = makeBackfillRow(1);
  const row2 = makeBackfillRow(2);
  const savePath = path.join(tmpDir, 'd.xlsx');
  await writeRefundBackfillOutput([row1, row2], [], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('回填模板');

  [row1, row2].forEach((srcRow, rowIdx) => {
    const dataRow = sheet.getRow(rowIdx + 2);
    REFUND_TEMPLATE_HEADERS.forEach((h, colIdx) => {
      assert.strictEqual(
        dataRow.getCell(colIdx + 1).value,
        srcRow[h],
        `第 ${rowIdx + 2} 行 列「${h}」值应为 ${srcRow[h]}`
      );
    });
  });

  const hitTypeColIdx = REFUND_TEMPLATE_HEADERS.indexOf('命中类型');
  assert.strictEqual(sheet.getRow(2).getCell(hitTypeColIdx + 1).value, row1['命中类型'], 'E 列应为命中类型');
  const detailColIdx = REFUND_TEMPLATE_HEADERS.indexOf('匹配命中详情');
  assert.strictEqual(sheet.getRow(2).getCell(detailColIdx + 1).value, row1['匹配命中详情'], 'F 列应为命中详情');
  const debitColIdx = REFUND_TEMPLATE_HEADERS.indexOf('Debit Amount');
  assert.strictEqual(sheet.getRow(2).getCell(debitColIdx + 1).value, row1['Debit Amount'], 'Debit Amount 列值应正确');
  // O4：「流水号」与「退款单号」同值但分两列
  const serialColIdx = REFUND_TEMPLATE_HEADERS.indexOf('流水号');
  const refundNoColIdx = REFUND_TEMPLATE_HEADERS.indexOf('退款单号');
  assert.notStrictEqual(serialColIdx, refundNoColIdx, '流水号 与 退款单号 应为两列');
  assert.strictEqual(sheet.getRow(2).getCell(serialColIdx + 1).value, sheet.getRow(2).getCell(refundNoColIdx + 1).value, '流水号 与 退款单号 同值');
});

// ========================================================================
// 4) v3.0.10 需求3.2：sheet2 表头 13 列，无「结果类型」「退款单号」
// ========================================================================
test('④ sheet2 表头 13 列（REFUND_BANK_COLUMNS 12 + 报错/提示信息），无「结果类型」「退款单号」', async () => {
  const savePath = path.join(tmpDir, 'u.xlsx');
  await writeRefundBackfillOutput([], [makeUnmatchedBankRow(1, RESULT_ERROR, '关联到 2 条退款订单')], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('未匹配报错');

  assert.strictEqual(UNMATCHED_HEADERS.length, 13, 'UNMATCHED_HEADERS 应为 13 列');
  assert.ok(!UNMATCHED_HEADERS.includes('结果类型'), 'v3.0.10：删「结果类型」列');
  assert.ok(!UNMATCHED_HEADERS.includes('退款单号'), 'v3.0.10：删「退款单号」列');
  assert.deepStrictEqual(UNMATCHED_HEADERS.slice(), [...REFUND_BANK_COLUMNS, '报错/提示信息'], 'sheet2 = 银行 12 列 + 报错/提示信息');

  const actualHeaders = UNMATCHED_HEADERS.map((_, i) => sheet.getRow(1).getCell(i + 1).value);
  assert.deepStrictEqual(actualHeaders, UNMATCHED_HEADERS.slice(), 'sheet2 表头顺序应严格等于 UNMATCHED_HEADERS');
});

// ========================================================================
// 5) sheet2 银行未匹配行正确落列；报错/提示靠信息列前缀区分
// ========================================================================
test('⑤ sheet2 银行未匹配行正确落列；报错/提示靠【报错】/【提示】前缀区分；缺 key → 空', async () => {
  const errRow = makeUnmatchedBankRow(1, RESULT_ERROR, '关联到 2 条退款订单，无法消歧，请人工介入');
  const noticeRow = makeUnmatchedBankRow(2, RESULT_NOTICE, '未能关联到任何退款订单');
  const savePath = path.join(tmpDir, 'h2.xlsx');
  await writeRefundBackfillOutput([], [errRow, noticeRow], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('未匹配报错');

  const colIdx = (h) => UNMATCHED_HEADERS.indexOf(h) + 1;
  const cellVal = (r, h) => sheet.getRow(r).getCell(colIdx(h)).value;

  // 报错行（第 2 行）：12 列银行字段全落 + 信息列以【报错】开头
  REFUND_BANK_COLUMNS.forEach((c) => {
    assert.strictEqual(cellVal(2, c), errRow[c], `报错行 银行列「${c}」应正确落列`);
  });
  assert.strictEqual(cellVal(2, '报错/提示信息'), errRow['报错/提示信息']);
  assert.ok(String(cellVal(2, '报错/提示信息')).startsWith('【报错】'), '报错行信息列以【报错】开头');

  // 提示行（第 3 行）：信息列以【提示】开头
  assert.ok(String(cellVal(3, '报错/提示信息')).startsWith('【提示】'), '提示行信息列以【提示】开头');

  // 「结果类型」key 虽在 row 上，但不进 sheet2 投影 → sheet2 无该列（UNMATCHED_HEADERS 已无）
  assert.ok(!UNMATCHED_HEADERS.includes('结果类型'), 'sheet2 投影不含 结果类型');
});

// ========================================================================
// 6) 表头行加粗（两个 sheet）
// ========================================================================
test('⑥ 两个 sheet 表头行均加粗', async () => {
  const savePath = path.join(tmpDir, 'bold.xlsx');
  await writeRefundBackfillOutput([makeBackfillRow(1)], [makeUnmatchedBankRow(1, RESULT_ERROR, 'x')], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  ['回填模板', '未匹配报错'].forEach((name) => {
    const sheet = wb.getWorksheet(name);
    assert.ok(sheet.getRow(1).font && sheet.getRow(1).font.bold === true, `${name} 表头应加粗`);
  });
});

// ========================================================================
// 7) 返回 { filePath, fileName } 正确；atomic write 不留半文件
// ========================================================================
test('⑦ 返回 { filePath, fileName } 正确，且 atomic 不留 .tmp 半文件', async () => {
  const fileName = '中台退款订单回填-2026_06_01_1200.xlsx';
  const savePath = path.join(tmpDir, fileName);
  const result = await writeRefundBackfillOutput([makeBackfillRow(1)], [makeUnmatchedBankRow(1, RESULT_ERROR, 'x')], savePath);

  assert.strictEqual(result.filePath, savePath);
  assert.strictEqual(result.fileName, fileName);
  assert.ok(fs.existsSync(savePath), '最终文件应存在');
  assert.ok(!fs.existsSync(`${savePath}.tmp`), 'tmp 文件应已被 rename 清理');
});

// ========================================================================
// 8) writer 能消费引擎真实产出（端到端形状对齐；v3.0.10：bank-only 提示 + S1 回填）
// ========================================================================
test('⑧ writer 能消费引擎真实产出（backfillRows + 银行未匹配行）', async () => {
  const {
    runRound5RefundOrderBackfill
  } = require('../../../src/main-process/scenario-engines/r5-refund-order-backfill');

  // 造一组：1 条 bank 命中 1 条 refund（S1）→ backfill；
  //         外加 1 条 bank-only（不同唯一值无 refund）→ 银行未匹配提示行（①形状，带【提示】前缀）。
  const bankRows = [
    {
      _rowId: 'row_0',
      FundType: 'Ach Return',
      MerchantId: 'ACC1', Currency: 'USD',
      'Credit Amount': '', 'Debit Amount': 100,
      ChannelOrderNo: 'PAY123', CustomerRef: '',
      ReconciliationId: 'RECONX', BillDate: '2026-06-01',
      Channel: '', '地区': '', 'Extra Information': '', 'Payment Detail': '',
      'Drawee Name': '', 'Drawee CardNo': '', 'Payee CardNo': ''
    },
    {
      _rowId: 'row_1',
      FundType: 'Ach Return',
      MerchantId: 'ACC2', Currency: 'USD', // 不同大账号 → 不与 row_0 / refund 同组 → bank-only
      'Credit Amount': '', 'Debit Amount': 200,
      ChannelOrderNo: 'NOPE', CustomerRef: '',
      ReconciliationId: 'RECONY', BillDate: '2026-06-01',
      Channel: '', '地区': '', 'Extra Information': '', 'Payment Detail': '',
      'Drawee Name': '', 'Drawee CardNo': '', 'Payee CardNo': ''
    }
  ];
  const refundOrderRows = [
    {
      _rowId: 'ro_0', '状态': 'SUBMITTED',
      '银行大账号': 'ACC1', '币种': 'USD', '退款金额': 100,
      '银行打款流水号': 'PAY123', '流水号': 'SERIAL_MATCH'
    }
  ];

  const { backfillRows, unmatchedRows } = runRound5RefundOrderBackfill(bankRows, refundOrderRows, []);
  assert.ok(backfillRows.length >= 1, '应至少产出 1 条回填行');
  assert.ok(unmatchedRows.length >= 1, '应至少产出 1 条银行未匹配行');

  const savePath = path.join(tmpDir, 'engine.xlsx');
  const result = await writeRefundBackfillOutput(backfillRows, unmatchedRows, savePath);
  assert.ok(fs.existsSync(result.filePath), '引擎产出应成功写出文件');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const s1 = wb.getWorksheet('回填模板');
  const s2 = wb.getWorksheet('未匹配报错');

  // sheet1 第 1 条回填行：退款单号 = SERIAL_MATCH、状态 = SUCCESS
  assert.strictEqual(s1.getRow(2).getCell(1).value, 'SERIAL_MATCH', 'sheet1 退款单号应为命中 refund 流水号');
  assert.strictEqual(s1.getRow(2).getCell(2).value, 'SUCCESS', 'sheet1 状态应回填 SUCCESS');

  // sheet2 银行未匹配行（①形状）：MerchantId = ACC2，信息列带【提示】前缀
  const merchantColIdx = UNMATCHED_HEADERS.indexOf('MerchantId') + 1;
  const infoColIdx = UNMATCHED_HEADERS.indexOf('报错/提示信息') + 1;
  let found = false;
  for (let r = 2; r <= unmatchedRows.length + 1; r++) {
    if (s2.getRow(r).getCell(merchantColIdx).value === 'ACC2'
        && String(s2.getRow(r).getCell(infoColIdx).value || '').startsWith('【提示】')) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'sheet2 应含 ACC2 的银行未匹配-提示行（①形状，带【提示】前缀）');
});

// ========================================================================
// 9) v3.0.10 需求3.1：sheet1 命中字段标黄
// ========================================================================
test('⑨ sheet1 标黄：仅 _matchedColumns 列填黄（argb FFFFFF00），其余列无填充', async () => {
  // 命中 S1：标黄 ChannelOrderNo + 银行打款流水号（均∈sheet1）。
  const matched = ['ChannelOrderNo', '银行打款流水号'];
  const row = makeBackfillRow(1, matched);
  const savePath = path.join(tmpDir, 'yellow.xlsx');
  await writeRefundBackfillOutput([row], [], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('回填模板');
  const dataRow = sheet.getRow(2);

  REFUND_TEMPLATE_HEADERS.forEach((h, i) => {
    const cell = dataRow.getCell(i + 1);
    if (matched.includes(h)) {
      assert.ok(isYellow(cell), `命中列「${h}」（第 ${i + 1} 列）应填黄 FFFFFF00`);
    } else {
      assert.ok(!isYellow(cell), `非命中列「${h}」（第 ${i + 1} 列）不应填黄`);
    }
  });
});

test('⑨ sheet1 标黄列偏移正确：标的是 REFUND_TEMPLATE_HEADERS[i] 对应第 i+1 列（无前导列）', async () => {
  // 单列命中 valueDate（ro 段末列），验证列偏移 i+1 落在正确单元格。
  const matched = ['valueDate'];
  const row = makeBackfillRow(1, matched);
  const savePath = path.join(tmpDir, 'offset.xlsx');
  await writeRefundBackfillOutput([row], [], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('回填模板');
  const dataRow = sheet.getRow(2);

  const idx = REFUND_TEMPLATE_HEADERS.indexOf('valueDate');
  assert.ok(idx >= 0);
  assert.ok(isYellow(dataRow.getCell(idx + 1)), `valueDate 应标在第 ${idx + 1} 列（i+1，无前导列）`);
  // 相邻列不应误标
  assert.ok(!isYellow(dataRow.getCell(idx)), '左邻列不应误标（防列偏移 +0/+2 错位）');
  if (idx + 2 <= REFUND_TEMPLATE_HEADERS.length) {
    assert.ok(!isYellow(dataRow.getCell(idx + 2)), '右邻列不应误标');
  }
});

test('⑨ 无 _matchedColumns / 空数组 → 整行无标黄', async () => {
  const rowNoMatch = makeBackfillRow(1); // 无 _matchedColumns
  const rowEmptyMatch = makeBackfillRow(2, []); // 空数组
  const savePath = path.join(tmpDir, 'nomark.xlsx');
  await writeRefundBackfillOutput([rowNoMatch, rowEmptyMatch], [], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const sheet = wb.getWorksheet('回填模板');

  [2, 3].forEach((rowNo) => {
    REFUND_TEMPLATE_HEADERS.forEach((_, i) => {
      assert.ok(!isYellow(sheet.getRow(rowNo).getCell(i + 1)), `第 ${rowNo} 行 第 ${i + 1} 列不应标黄（无/空 _matchedColumns）`);
    });
  });
});

// ========================================================================
// 10) 空 backfillRows / unmatchedRows → 仍输出含表头空 sheet
// ========================================================================
test('⑩ 空 backfill + 空 unmatched → 两 sheet 仍输出表头（sheet2 仍 13 列）', async () => {
  const savePath = path.join(tmpDir, 'empty.xlsx');
  await writeRefundBackfillOutput([], [], savePath);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(savePath);
  const s1 = wb.getWorksheet('回填模板');
  const s2 = wb.getWorksheet('未匹配报错');

  const s1Headers = REFUND_TEMPLATE_HEADERS.map((_, i) => s1.getRow(1).getCell(i + 1).value);
  assert.deepStrictEqual(s1Headers, REFUND_TEMPLATE_HEADERS.slice(), '空 backfill → sheet1 仍输出 33 列表头');

  const s2Headers = UNMATCHED_HEADERS.map((_, i) => s2.getRow(1).getCell(i + 1).value);
  assert.deepStrictEqual(s2Headers, UNMATCHED_HEADERS.slice(), '空 unmatched → sheet2 仍输出 13 列表头');
});
