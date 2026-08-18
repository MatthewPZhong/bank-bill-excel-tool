// 重复入金匹配端到端：银行+单据 -> 全月份临时 INBOUND MPT -> 匹配 -> 双 sheet 导出。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { AppDatabase } = require('../../src/backend/database');
const runDataStore = require('../../src/backend/run-data-store');
const { BILL_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');
const {
  INBOUND_FIELDS,
  MPT_DELIMITER
} = require('../../src/main-process/pre-fund-reconciliation/mpt-schema');
const {
  createDuplicateInboundMatchService
} = require('../../src/main-process/duplicate-inbound-match/service');

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ label, detail });
}

function assertEq(actual, expected, label) {
  assertTrue(Object.is(actual, expected), label, `expected=${expected} actual=${actual}`);
}

function bankRow(values = {}) {
  return BANK_STATEMENT_FIELDS.map((field) => values[field] ?? '');
}

function writeBankFile(filePath) {
  const common = {
    Channel: 'CIT', MerchantId: 'MERCHANT-1', Currency: 'USD',
    'Payee Name': 'PZ-PRIVATE-PAYEE', 'Payee CardNo': 'PZ-PRIVATE-PAYEE-CARD',
    'Drawee Name': 'PZ-PRIVATE-DRAWEE', 'Drawee CardNo': 'PZ-PRIVATE-DRAWEE-CARD'
  };
  const rows = [
    bankRow({ ...common, BizId: 'BIZ-R', BillDate: '2026-07-14', FundType: 'Reversal', 'Debit Amount': '99.00' }),
    bankRow({ ...common, BizId: 'BIZ-I1', FundType: 'Inbound', 'Credit Amount': '99', ReconciliationId: 'RECON-1' }),
    bankRow({ ...common, BizId: 'BIZ-I2', FundType: 'Inbound', 'Credit Amount': '99.0', ReconciliationId: 'RECON-2' }),
    bankRow({
      BizId: 'MANUAL-R', FundType: 'Reversal', 'Debit Amount': '5', Channel: 'CIT',
      MerchantId: 'MERCHANT-1', Currency: 'USD', 'Payee Name': 'M', 'Payee CardNo': '1',
      'Drawee Name': 'N', 'Drawee CardNo': '2'
    })
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([BANK_STATEMENT_FIELDS.slice(), ...rows]),
    '渠道对账单'
  );
  XLSX.writeFile(workbook, filePath);
}

function documentRow(values = {}) {
  return BILL_HEADERS.map((field) => values[field] ?? '');
}

function writeDocumentFile(filePath) {
  const rows = ['ORDER-JUNE', 'ORDER-JULY'].map((orderId, index) => documentRow({
    originBillBizId: `DOCUMENT-${index + 1}`,
    '业务订单号': orderId,
    '用户编号': 'PZ-DOCUMENT-USER-0001',
    '账户号': 'PZ-DOCUMENT-ACCOUNT-0001',
    '业务部门': 'OPP-BU-X'
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([BILL_HEADERS.slice(), ...rows]),
    '单据对账单'
  );
  XLSX.writeFile(workbook, filePath);
}

function inboundRow(overrides = {}) {
  const values = {
    batchNo: 'MPT_INBOUND_20260630', billDate: '2026-06-30', channel: 'CIT',
    merchantId: 'MERCHANT-1', business: 'BUSINESS-X', tradeType: 'Inbound-VA',
    oppBu: 'OPP-BU-X',
    orderId: 'ORDER-X', reconId: 'RECON-X', billReconId: 'BILL-X', clientId: 'CLIENT-X',
    accId: 'ACCOUNT-X', cardNo: 'CARD-X', currency: 'USD', originAmount: '99', fee: '0',
    amount: '99', payerName: 'PAYER', payerAccount: 'PAYER-CARD', valueDate: '2026-06-30',
    bookDate: '2026-06-30', created: '2026-06-30 01:00:00', tradeScope: 'INBOUND',
    businessDate: '2026-06-30', realChannel: 'CIT', clearingNetwork: 'SWIFT', batchSeq: '1',
    ...overrides
  };
  return INBOUND_FIELDS.map((field) => values[field] ?? '');
}

function writeMptFile(root, sourceDate, sequence, rows) {
  const filePath = path.join(root, `MPT_INBOUND_GATEWAY_${sourceDate}${sequence}.txt`);
  const header = [sourceDate, `MPT_INBOUND_${sourceDate}`, String(rows.length)];
  fs.writeFileSync(
    filePath,
    `${[header, ...rows].map((row) => row.join(MPT_DELIMITER)).join('\n')}\n`,
    'utf8'
  );
  return filePath;
}

function containsPrivateInputData(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const contents = fs.readFileSync(filePath);
  return contents.includes(Buffer.from('PZ-PRIVATE-', 'utf8'))
    || contents.includes(Buffer.from('PZ-DOCUMENT-', 'utf8'));
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-inbound-e2e-'));
  const dbPath = path.join(root, 'tool-data.sqlite');
  const database = new AppDatabase(dbPath);
  console.log('==== 重复入金匹配端到端验证 ====');
  try {
    database.init();
    const service = createDuplicateInboundMatchService({
      userDataDir: root,
      database,
      mailTemplatePath: path.resolve(__dirname, '../../assets/重复入金召回邮件模板.xlsx'),
      bankTemplatePath: path.resolve(__dirname, '../../assets/银行对账单.xlsx'),
      now: () => new Date(2026, 6, 14, 12, 0, 0)
    });

    const juneMpt = writeMptFile(root, '20260630', '001', [
      inboundRow({ reconId: 'RECON-1', orderId: 'ORDER-JUNE', batchSeq: '1' })
    ]);
    const julyMpt = writeMptFile(root, '20260701', '001', [
      inboundRow({
        batchNo: 'MPT_INBOUND_20260701', billDate: '2026-07-01', valueDate: '2026-07-01',
        bookDate: '2026-07-01', created: '2026-07-01 01:00:00', businessDate: '2026-07-01',
        reconId: 'RECON-2', orderId: 'ORDER-JULY', batchSeq: '1'
      })
    ]);
    await service.tempStore.importLegacyFile(juneMpt);
    await service.tempStore.importLegacyFile(julyMpt);
    assertEq(service.tempStore.listBatches().length, 2, 'MPT 两个月份批次均持久化');

    const bankFile = path.join(root, '银行对账单.xlsx');
    const documentFile = path.join(root, '单据对账单.xlsx');
    writeBankFile(bankFile);
    writeDocumentFile(documentFile);
    const imported = await service.importFiles([documentFile, bankFile]);
    assertEq(imported.bank.rowCount, 4, '银行标准 46 列导入 4 行');
    assertEq(imported.bank.reversalCount, 2, '识别两条 Reversal');
    assertEq(imported.bank.inboundCount, 2, '识别两条 Inbound');
    assertEq(imported.document.rowCount, 2, '单据标准 26 列流式导入 2 行');
    assertTrue(service.status().canRun, '银行与单据均导入后允许运行');

    const result = await service.run();
    assertEq(result.summary.finalSuccessGroupCount, 1, '跨月份 MPT 完成一个成功组');
    assertEq(result.summary.manualGroupCount, 1, '1+0 组进入人工判定');
    assertEq(result.summary.manualRowCount, 1, '人工 sheet 保留该组全部一行');
    assertTrue(result.summary.reversalConservation.isBalanced, 'Reversal 成功/人工分流守恒');

    const outputPath = path.join(root, service.buildDefaultFileName());
    await service.export({ savePath: outputPath });
    const output = XLSX.readFile(outputPath, { raw: true });
    assertEq(output.SheetNames.join('|'), '邮件模板|匹配不成功需人工判定', '导出固定双 sheet 与顺序');
    const mail = XLSX.utils.sheet_to_json(output.Sheets['邮件模板'], { defval: '' });
    const manual = XLSX.utils.sheet_to_json(output.Sheets['匹配不成功需人工判定'], { defval: '' });
    assertEq(mail.length, 1, '邮件模板输出一个成功组');
    assertEq(mail[0]['加款单号'], 'ORDER-JUNE、ORDER-JULY', '加款单号按银行 Inbound 源顺序拼接');
    assertEq(mail[0]['业务来源'], 'OPP-BU-X', 'MPT oppBu 回填业务来源正确');
    assertEq(mail[0]['客户号'], 'PZ-DOCUMENT-USER-0001', '客户号从单据用户编号取得');
    assertEq(mail[0]['账户号'], 'PZ-DOCUMENT-ACCOUNT-0001', '账户号从单据账户号取得');
    assertEq(manual.length, 1, '人工 sheet 输出一行');
    assertTrue(String(manual[0]['人工判定原因']).includes('0条 Inbound'), '人工原因明确数量不符');

    const mirror = database.listDuplicateInboundMatchRunMirrors().at(-1);
    assertEq(mirror.status, 'success', '主库只记录轻量成功镜像');
    assertEq(mirror.summary.mailRowCount, 1, '主库镜像仅含汇总计数');
    assertEq(mirror.documentFileName, '单据对账单.xlsx', '主库镜像只保存单据文件名');
    assertTrue(!containsPrivateInputData(dbPath), '主库文件不含银行姓名卡号或单据身份字段');
    assertTrue(!containsPrivateInputData(`${dbPath}-wal`), '主库 WAL 不含银行姓名卡号或单据身份字段');

    const extraMpt = writeMptFile(root, '20260702', '001', [
      inboundRow({
        batchNo: 'MPT_INBOUND_20260702', billDate: '2026-07-02', valueDate: '2026-07-02',
        bookDate: '2026-07-02', created: '2026-07-02 01:00:00', businessDate: '2026-07-02',
        reconId: 'UNRELATED', orderId: 'UNRELATED', batchSeq: '1'
      })
    ]);
    await service.tempStore.importLegacyFile(extraMpt);
    assertTrue(service.status().run.stale, 'MPT 快照变化后旧结果标记 stale');
    assertTrue(!service.status().canExport, 'MPT 快照变化后禁止旧结果导出');

    const restarted = createDuplicateInboundMatchService({
      userDataDir: root,
      database,
      mailTemplatePath: path.resolve(__dirname, '../../assets/重复入金召回邮件模板.xlsx'),
      bankTemplatePath: path.resolve(__dirname, '../../assets/银行对账单.xlsx')
    });
    assertTrue(
      !restarted.status().bank && !restarted.status().document && !restarted.status().run,
      '应用重启语义回收银行、单据会话与运行结果'
    );
    assertEq(
      runDataStore.listSideDbFiles(root, runDataStore.MODULE_DUPLICATE_INBOUND_MATCH).length,
      0,
      '应用重启语义物理删除银行、单据与运行结果侧库'
    );
    assertEq(restarted.tempStore.listBatches().length, 3, '应用重启语义不清理持久 MPT 批次');
  } catch (error) {
    failed += 1;
    failures.push({ label: '未捕获异常', detail: error && error.stack ? error.stack : String(error) });
  } finally {
    if (database.db) database.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('FAILURES:');
    for (const failure of failures) console.error(`- ${failure.label}: ${failure.detail}`);
    console.error(`==== ${passed}/${passed + failed} PASS ====`);
    process.exit(1);
  }
  console.log(`==== ${passed}/${passed} PASS ====`);
}

run();
