// v2.1.2 T2 — 月度银行对账单BU回填校验 smoke
// 资金红线核心路径 8 用例（A-E + F-H 大小写边界）+ 覆盖导入回归（PR #43 Codex P1）
//
// 验证（spec §四 v0.8/v0.9）：
//   A 1:1 全等 → status=success / matched=4 / buDiff=0 / nm=0
//   B 1:1 部分差异 → buDiff=2 (P+B 双侧标黄)
//   C 1:N 部分差异 → P 不标，仅标差异 B 行（精准子对）
//   D N:1 部分差异 → B 不标，仅标差异 P 行
//   E N:M → status=success（不中断），nm=1，异常 sheet 1 行
//   F BU 大小写归一 → buDiff=0（v0.9 normalizeBu 含 toLowerCase）
//   G BU 真差异 → buDiff=2
//   H 对账单号大小写不归一 → matched=0（normalizeKey 仅 trim）
//   I 覆盖导入清旧 run（PR #43 Codex P1）→ 重新导入后 listSuccessMonths 不再含旧月份

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const monthRepo = require('../../src/backend/bank-bu-recon-db/month-repository');
const {
  createBankBuReconSession,
  runReconciliation,
  normalizeKey,
  normalizeBu
} = require('../../src/main-process/bank-bu-recon-session');
const { writeDiffWorkbook } = require('../../src/main-process/bank-bu-recon-writer');

function pendRow(rIdx, recon, bu) {
  return {
    _rowIndex: rIdx, pending_biz_id: 'P' + rIdx, recon_id: recon, finance_bu: bu,
    bill_date: '', pending_type: '', fund_type: '', entity: '', biz_dept: '', counter_dept: '',
    channel: '', account_no: '', amount: '', currency: '', bank_period: '', balance_period: '',
    remark: '', status: '', update_time: '', operator: '', bu_fix_flag: ''
  };
}
function bankRow(rIdx, recon, bu) {
  return {
    _rowIndex: rIdx, biz_id: 'B' + rIdx, reconciliation_id: recon, remark_bu: bu,
    account_entity: '', account_bu: '', bill_date: '', value_date: '', channel: '', region: '',
    merchant_id: '', currency: '', credit_amount: '', debit_amount: '', channel_order_no: '',
    customer_ref: '', account_reference: '', transaction_description: '', extra_information: '',
    payment_detail: '', payee_name: '', payee_card_no: '', drawee_name: '', drawee_card_no: '',
    by_order_of_beneficiary: '', extra_fee: '', trade_channel: '', fund_type: '',
    remark_description: '', datasource: '', fill_method: '', related_account: '',
    auto_category_rule: '', categorized_by: '', clearing_network: '', last_modified_time: '',
    recon_amount: '', origin_bill_id: '', fx_channel: '', fx_recon_id: '',
    buy_currency: '', buy_amount: '', sell_currency: '', sell_amount: '', split_info: ''
  };
}

async function runBankBuReconSmokeTests() {
  const tmpDb = path.join(require('node:os').tmpdir(), 'smoke-bbr-' + Date.now() + '.sqlite');
  const tmpRoot = path.join(require('node:os').tmpdir(), 'smoke-bbr-store-' + Date.now());
  fs.mkdirSync(tmpRoot, { recursive: true });
  const appDb = new AppDatabase(tmpDb);
  appDb.init();
  const session = createBankBuReconSession({
    getDb: () => appDb.db,
    getStorageRoot: () => tmpRoot
  });

  let count = 0;
  function check(label, cond, msg) {
    count += 1;
    assert(cond, `[bank-bu-recon] ${label} ${msg || 'assert failed'}`);
  }

  // === normalize 单测（v0.9 OPEN ISSUE #5）===
  check('N1 normalizeKey trim', normalizeKey('  REC-001  ') === 'REC-001');
  check('N2 normalizeKey 大小写保留', normalizeKey('REC-Aa01') === 'REC-Aa01');
  check('N3 normalizeBu trim+lowercase', normalizeBu('Flowmore') === 'flowmore');
  check('N4 normalizeBu 大小写归一', normalizeBu('Flowmore') === normalizeBu('FlowMore'));
  check('N5 normalizeBu 空值', normalizeBu(null) === '' && normalizeBu(undefined) === '' && normalizeBu('') === '');

  // === Case A: 1:1 全等 ===
  session.importMonth('2026-01', [pendRow(2, 'A', 'BU1'), pendRow(3, 'B', 'BU2')], [bankRow(2, 'A', 'BU1'), bankRow(3, 'B', 'BU2')]);
  let r = session.run('2026-01');
  check('A status', r.status === 'success');
  check('A matched=4', r.stats.matchedCount === 4);
  check('A buDiff=0', r.stats.buDiffCount === 0);
  check('A nm=0', r.stats.nmAnomalyCount === 0);

  // === Case B: 1:1 部分差异 ===
  session.importMonth('2026-02', [pendRow(2, 'C', 'BU1'), pendRow(3, 'D', 'BU3')], [bankRow(2, 'C', 'BU1'), bankRow(3, 'D', 'BUX')]);
  r = session.run('2026-02');
  check('B status', r.status === 'success');
  check('B matched=4', r.stats.matchedCount === 4);
  check('B buDiff=2 (P+B 双侧)', r.stats.buDiffCount === 2);

  // === Case C: 1:N 部分差异（P 不标，仅 B[1] 标）===
  session.importMonth('2026-03', [pendRow(2, 'E', 'BU1')], [bankRow(2, 'E', 'BU1'), bankRow(3, 'E', 'BU_BAD'), bankRow(4, 'E', 'BU1')]);
  r = session.run('2026-03');
  check('C status', r.status === 'success');
  check('C matched=4', r.stats.matchedCount === 4);
  check('C buDiff=1', r.stats.buDiffCount === 1);
  const reconC = runReconciliation(appDb.db, '2026-03');
  check('C P 不标 (buDiffPendingIds.size=0)', reconC.buDiffPendingIds.size === 0);
  check('C 仅 B[1] 标 (buDiffBankIds.size=1)', reconC.buDiffBankIds.size === 1);

  // === Case D: N:1 部分差异（B 不标，仅 P[1] 标）===
  session.importMonth('2026-04', [pendRow(2, 'F', 'BU1'), pendRow(3, 'F', 'BU_BAD'), pendRow(4, 'F', 'BU1')], [bankRow(2, 'F', 'BU1')]);
  r = session.run('2026-04');
  check('D status', r.status === 'success');
  check('D matched=4', r.stats.matchedCount === 4);
  check('D buDiff=1', r.stats.buDiffCount === 1);
  const reconD = runReconciliation(appDb.db, '2026-04');
  check('D 仅 P[1] 标 (buDiffPendingIds.size=1)', reconD.buDiffPendingIds.size === 1);
  check('D B 不标 (buDiffBankIds.size=0)', reconD.buDiffBankIds.size === 0);

  // === Case E: N:M 异常（不中断 + 写 Sheet 3）===
  session.importMonth('2026-05', [pendRow(2, 'G', 'BU1'), pendRow(3, 'G', 'BU2')], [bankRow(2, 'G', 'BU1'), bankRow(3, 'G', 'BU2')]);
  r = session.run('2026-05');
  check('E status (不中断)', r.status === 'success');
  check('E matched=0', r.stats.matchedCount === 0);
  check('E nm=1', r.stats.nmAnomalyCount === 1);

  // === Case E 导出验证 异常 sheet ===
  const reconE = runReconciliation(appDb.db, '2026-05');
  const xpathE = path.join(tmpRoot, 'caseE.xlsx');
  await writeDiffWorkbook({
    storageRoot: tmpRoot, yearMonth: '2026-05',
    matchedPending: reconE.matchedPending, matchedBank: reconE.matchedBank,
    buDiffPendingIds: reconE.buDiffPendingIds, buDiffBankIds: reconE.buDiffBankIds,
    nmAnomalies: reconE.nmAnomalies, overrideSavePath: xpathE
  });
  const wbE = new ExcelJS.Workbook();
  await wbE.xlsx.readFile(xpathE);
  check('E 3 sheet (Pending/银行对账单/异常)', wbE.worksheets.map(s => s.name).join(',') === 'Pending,银行对账单,异常');
  const anoSheet = wbE.getWorksheet('异常');
  check('E 异常 sheet 表头第 1 列=对账单号', anoSheet.getRow(1).getCell(1).value === '对账单号');
  check('E 异常 sheet 行 1 含对账单号 G', anoSheet.getRow(2).getCell(1).value === 'G');
  check('E 异常 sheet 行 1 行号合并', anoSheet.getRow(2).getCell(4).value === '2, 3' && anoSheet.getRow(2).getCell(5).value === '2, 3');

  // === Case F: BU 大小写归一（v0.9）===
  session.importMonth('2026-06', [pendRow(2, 'H1', 'Flowmore'), pendRow(3, 'H2', 'FLOWMORE')], [bankRow(2, 'H1', 'FlowMore'), bankRow(3, 'H2', 'flowmore')]);
  r = session.run('2026-06');
  check('F BU 大小写归一 buDiff=0', r.stats.buDiffCount === 0);

  // === Case G: BU 真差异 ===
  session.importMonth('2026-07', [pendRow(2, 'I', 'Flowmore')], [bankRow(2, 'I', 'OtherBU')]);
  r = session.run('2026-07');
  check('G BU 真差异 buDiff=2', r.stats.buDiffCount === 2);

  // === Case H: 对账单号大小写不归一 ===
  session.importMonth('2026-08', [pendRow(2, 'rec1', 'BU1')], [bankRow(2, 'REC1', 'BU1')]);
  r = session.run('2026-08');
  check('H 对账单号大小写未归一 matched=0', r.stats.matchedCount === 0);
  check('H Pending unmatched=1', r.stats.pendingUnmatched === 1);
  check('H 银行 unmatched=1', r.stats.bankUnmatched === 1);

  // === Case I: 覆盖导入清旧 run（PR #43 Codex P1 资金红线 regression）===
  // 先验证 2026-01 还在 listSuccessMonths
  let successMonths = session.listSuccessMonths();
  check('I0 covered: 2026-01 在 listSuccessMonths', successMonths.some(m => m.yearMonth === '2026-01'));
  // 重新导入 2026-01（覆盖）
  session.importMonth('2026-01', [pendRow(2, 'NEW', 'BU1')], [bankRow(2, 'NEW', 'BU1')]);
  // 立即查 — 旧 run 应该已被清
  successMonths = session.listSuccessMonths();
  check('I1 覆盖导入后 2026-01 已无 success run', !successMonths.some(m => m.yearMonth === '2026-01'),
    '资金红线：覆盖导入未清旧 run，会导致旧 runId 套到新数据上');

  // 清理（AppDatabase 无 close 方法；DatabaseSync 直接 close）
  if (appDb.db && typeof appDb.db.close === 'function') appDb.db.close();
  fs.unlinkSync(tmpDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`[bank-bu-recon] ${count}/${count} smoke tests passed`);
}

module.exports = {
  runBankBuReconSmokeTests
};
