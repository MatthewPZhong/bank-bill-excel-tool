// v2.1.3 — 业务OP数据核对 smoke 测试
// 资金红线核心路径 17 用例（A-Q）+ helper 单测
//
// 验证（spec §九 + PRD §6.1 18 项拍板）：
//   A 核心对账：测算金额差异 + epsilon=1e-2 边界（资金红线 #1/#6）
//   B 多 OP 行精准标差异（#6 拍板 A 1:N 逐行独立比）
//   C 账户号增减差异（T-1 有 T-2 无来源 T-1 / T-2 有 T-1 无来源 T-2，拍板 C）
//   D 流水累加 + 出入方向（#3 拍板：入=+ 出=- 其他=NaN，资金红线 ⚠️）
//   E 业务OP 行整批拒绝 + 失败报告（#1 + #5 拍板，资金红线 ⚠️）
//   F 日期区间导出（v2.1.3-fix6 拍板回滚：单 sheet 合并 + 按 data_date 升序 + 同日内 account_no 升序）
//   G BU 隔离（#7 拍板 C normalizeBu trim+lower，资金红线 ⚠️）
//   H 重新导入清空旧 runs + diff_rows（#15 拍板 A，资金红线 P1 fix 回归）
//   I 多 OP 账户精准统计（资金红线 ⚠️ fix3.1 回归）
//   J 多 OP 相等行也进 diff_rows（v2.1.3 fix5 选项 B，资金红线 ⚠️）
//   L T-2 end_balance NaN silent drop（v2.1.3-fix7-I3 回归，资金红线 ⚠️）
//   M BU 大小写重新导入（v2.1.3-fix7-C1 回归，资金红线 ⚠️）
//   N Billdate ≠ data_date console.warn（M5 spec § 6.2 已声明的调试线索）
//   O I2 BU 名落库前 trim 归一防回归（round 2 R2-I3b，资金红线 ⚠️）
//   P 流水重导清"该 date 跨所有 BU"的旧 runs/diff_rows（PR #45 round 3 P1 fix，资金红线 ⚠️）
//   Q 业务OP 重导清"下一日 / 同 BU"的旧 runs/diff_rows（PR #45 round 4 P1 fix，资金红线 ⚠️）

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/biz-op-recon-session');
const writer = require('../../src/main-process/biz-op-recon-writer');
const importsRepo = require('../../src/backend/biz-op-recon-db/imports-repository');
const flowRepo = require('../../src/backend/biz-op-recon-db/flow-imports-repository');
const runRepo = require('../../src/backend/biz-op-recon-db/run-repository');
const { validateBizOpRow, validateFlowRow } = require('../../src/backend/biz-op-recon-import/validator');

// 工厂函数：构造一行业务OP（22 个非必填字段 + 必填字段）
function opRow(rIdx, bu, accountNo, opts = {}) {
  const begin = opts.begin == null ? 0 : opts.begin;
  const amount = opts.amount == null ? 0 : opts.amount;
  const amountIn = opts.amountIn == null ? Math.max(amount, 0) : opts.amountIn;
  const amountOut = opts.amountOut == null ? Math.max(-amount, 0) : opts.amountOut;
  const end = opts.end == null ? (begin + amount) : opts.end;
  return {
    _rowIndex: rIdx,
    bill_date_raw: opts.billDate || '',
    bu_name: bu,
    customer_no: '',
    entity: '',
    account_no: accountNo,
    account_type: '',
    currency: opts.currency || 'CNY',
    begin_balance: String(begin),
    amount: String(amount),
    amount_in: String(amountIn),
    amount_out: String(amountOut),
    end_balance: String(end),
    end_available_balance: '',
    end_frozen_balance: '',
    last_updated: '',
    channel: '',
    pp_card_id: '',
    bank_card_no: '',
    extra_info: '',
    account_status: '',
    biz_id: '',
    sys_created_at: '',
    sys_updated_at: ''
  };
}

// 工厂函数：构造一行流水
function flowR(rIdx, buDept, accountNo, direction, amount) {
  return {
    _rowIndex: rIdx,
    biz_id: 'F' + rIdx,
    bill_date_raw: '',
    origin_biz_id: '',
    main_account: '',
    company_entity: '',
    flow_type: '',
    bu_dept: buDept,
    recon_main_id: '',
    direction,
    flow_no: '',
    user_no: '',
    account_no: accountNo,
    split_type: '',
    recon_amount: String(amount),
    currency: 'CNY',
    account_type: '',
    flow_start_at: '',
    flow_end_at: '',
    channel: '',
    merchant_id: '',
    value_date: '',
    bank_ref: '',
    pending_flag: '',
    flow_biz_id: '',
    trace_id: '',
    operator: '',
    sys_created_at: '',
    sys_updated_at: ''
  };
}

async function runBizOpReconSmokeTests() {
  const tmpDb = path.join(os.tmpdir(), 'smoke-biz-op-recon-' + Date.now() + '.sqlite');
  const tmpRoot = path.join(os.tmpdir(), 'smoke-biz-op-recon-store-' + Date.now());
  fs.mkdirSync(tmpRoot, { recursive: true });
  const appDb = new AppDatabase(tmpDb);
  appDb.init();
  const db = appDb.db;

  let count = 0;
  function check(label, cond, msg) {
    count += 1;
    assert(cond, `[biz-op-recon] ${label} ${msg || 'assert failed'}`);
  }

  // === helper 单测（资金红线 helper） ===
  check('H1 subOneDay 普通日', session.subOneDay('2026-05-12') === '2026-05-11');
  check('H2 subOneDay 月初', session.subOneDay('2026-05-01') === '2026-04-30');
  check('H3 subOneDay 年初', session.subOneDay('2026-01-01') === '2025-12-31');
  check('H4 subOneDay 闰年 3-1', session.subOneDay('2024-03-01') === '2024-02-29');
  check('H5 parseSignedAmount 入', session.parseSignedAmount('入', '100') === 100);
  check('H6 parseSignedAmount 出', session.parseSignedAmount('出', '100') === -100);
  check('H7 parseSignedAmount DEBIT NaN', Number.isNaN(session.parseSignedAmount('DEBIT', '100')));
  check('H8 parseSignedAmount 空 NaN', Number.isNaN(session.parseSignedAmount('', '100')));
  check('H9 parseSignedAmount 千分位', session.parseSignedAmount('入', '1,000.50') === 1000.5);
  check('H10 normalizeBu trim+lower', session.normalizeBu('  BU-A  ') === 'bu-a');
  check('H11 normalizeBu null', session.normalizeBu(null) === '');
  check('H12 normalizeAccountKey trim only', session.normalizeAccountKey('  A001  ') === 'A001');
  check('H13 normalizeAccountKey 大小写保留', session.normalizeAccountKey('Acc001') === 'Acc001');

  // === validateBizOpRow（资金红线 #1 双重校验） ===
  check('V1 双重校验 通过', validateBizOpRow({ begin_balance:'1000', amount:'50', amount_in:'80', amount_out:'30', end_balance:'1050' }).ok === true);
  check('V2 (1) 失败 发生额!=入-出',
    validateBizOpRow({ begin_balance:'1000', amount:'100', amount_in:'80', amount_out:'30', end_balance:'1100' }).ok === false);
  check('V3 (2) 失败 期末!=期初+发生额',
    validateBizOpRow({ begin_balance:'1000', amount:'50', amount_in:'80', amount_out:'30', end_balance:'1100' }).ok === false);
  check('V4 epsilon 边界 1e-2 内通过',
    validateBizOpRow({ begin_balance:'1000', amount:'50.005', amount_in:'80', amount_out:'30', end_balance:'1050.005' }).ok === true);
  check('V5 epsilon 边界 1e-2 外失败',
    validateBizOpRow({ begin_balance:'1000', amount:'50', amount_in:'80', amount_out:'30', end_balance:'1050.05' }).ok === false);
  check('V6 非数值失败',
    validateBizOpRow({ begin_balance:'abc', amount:'50', amount_in:'80', amount_out:'30', end_balance:'1050' }).ok === false);

  // === validateFlowRow（资金红线 #3 出入方向） ===
  check('VF1 通过 入', validateFlowRow({ direction:'入', recon_amount:'100', account_no:'A1' }).ok === true);
  check('VF2 通过 出', validateFlowRow({ direction:'出', recon_amount:'100', account_no:'A1' }).ok === true);
  check('VF3 DEBIT 拒绝', validateFlowRow({ direction:'DEBIT', recon_amount:'100', account_no:'A1' }).ok === false);
  check('VF4 空方向拒绝', validateFlowRow({ direction:'', recon_amount:'100', account_no:'A1' }).ok === false);
  check('VF5 金额非数值拒绝', validateFlowRow({ direction:'入', recon_amount:'xyz', account_no:'A1' }).ok === false);
  check('VF6 账户号空拒绝', validateFlowRow({ direction:'入', recon_amount:'100', account_no:'' }).ok === false);

  // ========================================================================
  // Case A：核心对账（资金红线 #1/#6 epsilon=1e-2）
  // T-2 (2026-05-11)：A001 期末=1000；A002 期末=2000；A003 期末=500
  // T-1 (2026-05-12)：A001 期末=1070；A002 期末=2500.005（边界内 → 相等）；A003 期末=600
  // 流水 (2026-05-12)：A001 入 100 / A001 出 30 / A002 入 500（→ A001 +70, A002 +500）
  // 计算 T-1: A001=1000+70=1070 ✓；A002=2000+500=2500 ≈ 2500.005（差 0.005 < 1e-2 ✓）；A003 无流水变动 = 500 vs 实际 600 → 不相等
  // 期望: amountDiffCount=1 (A003)，t1NotT2Count=0, t2NotT1Count=0
  // ========================================================================
  importsRepo.insertRows(db, '2026-05-11', [
    opRow(2, 'BU-A', 'A001', { begin:900, amount:100, amountIn:100, amountOut:0, end:1000 }),
    opRow(3, 'BU-A', 'A002', { begin:1500, amount:500, amountIn:500, amountOut:0, end:2000 }),
    opRow(4, 'BU-A', 'A003', { begin:400, amount:100, amountIn:100, amountOut:0, end:500 })
  ]);
  importsRepo.insertRows(db, '2026-05-12', [
    opRow(2, 'BU-A', 'A001', { begin:1000, amount:70, amountIn:100, amountOut:30, end:1070 }),
    opRow(3, 'BU-A', 'A002', { begin:2000, amount:500.005, amountIn:500.005, amountOut:0, end:2500.005 }),
    opRow(4, 'BU-A', 'A003', { begin:500, amount:100, amountIn:100, amountOut:0, end:600 })  // 计算 500 但实际 600 → 不相等
  ]);
  flowRepo.insertRows(db, '2026-05-12', [
    flowR(2, 'BU-A', 'A001', '入', 100),
    flowR(3, 'BU-A', 'A001', '出', 30),
    flowR(4, 'BU-A', 'A002', '入', 500)
  ]);

  const resA = session.runReconciliation(db, { date:'2026-05-12', buName:'BU-A' });
  check('A status', resA.runId > 0);
  check('A t1OpTotal=3', resA.stats.t1OpTotal === 3);
  check('A t2OpTotal=3', resA.stats.t2OpTotal === 3);
  check('A flowTotal=3', resA.stats.flowTotal === 3);
  check('A amountDiffCount=1 (A003)', resA.stats.amountDiffCount === 1);
  check('A t1NotT2Count=0', resA.stats.t1NotT2Count === 0);
  check('A t2NotT1Count=0', resA.stats.t2NotT1Count === 0);
  check('A multiOpAccountCount=0', resA.stats.multiOpAccountCount === 0);

  // 清理 A 的数据
  importsRepo.clearByDateBu(db, '2026-05-11', 'BU-A');
  importsRepo.clearByDateBu(db, '2026-05-12', 'BU-A');
  flowRepo.clearByDate(db, '2026-05-12');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-12', 'BU-A');

  // ========================================================================
  // Case B：多 OP 行 1:N 精准标差异（#6 拍板 A + fix5 选项 B）
  // T-2 (2026-05-11)：B001 期末=1000
  // T-1 (2026-05-12)：B001 三条行（多 OP）：期末分别 1070 / 1100 / 1050
  // 流水 (2026-05-12)：B001 入 70 → 计算 T-1=1000+70=1070
  // 期望: P[0]=相等 P[1]=不相等(差30) P[2]=不相等(差20)
  // → amountDiffCount=2（仅"不相等"行计入），multiOpAccountCount=1（B001 是多 OP）
  // fix5 选项 B：多 OP 3 行全进 diff_rows（1 相等 + 2 不相等），全部 multi_op_flag='是'
  // ========================================================================
  importsRepo.insertRows(db, '2026-05-11', [
    opRow(2, 'BU-B', 'B001', { begin:900, amount:100, amountIn:100, amountOut:0, end:1000 })
  ]);
  importsRepo.insertRows(db, '2026-05-12', [
    opRow(2, 'BU-B', 'B001', { begin:1000, amount:70, amountIn:100, amountOut:30, end:1070 }),
    opRow(3, 'BU-B', 'B001', { begin:1000, amount:100, amountIn:100, amountOut:0, end:1100 }),
    opRow(4, 'BU-B', 'B001', { begin:1000, amount:50, amountIn:50, amountOut:0, end:1050 })
  ]);
  flowRepo.insertRows(db, '2026-05-12', [
    flowR(2, 'BU-B', 'B001', '入', 100),
    flowR(3, 'BU-B', 'B001', '出', 30)
  ]);
  const resB = session.runReconciliation(db, { date:'2026-05-12', buName:'BU-B' });
  check('B amountDiffCount=2 (仅不相等行计入)', resB.stats.amountDiffCount === 2);
  check('B multiOpAccountCount=1', resB.stats.multiOpAccountCount === 1);
  const diffsB = runRepo.getDiffRowsByRun(db, resB.runId);
  // fix5 选项 B：多 OP 3 行全进，1 相等 + 2 不相等
  check('B diff_rows 3 行 (fix5 多 OP 全进)', diffsB.length === 3);
  diffsB.forEach((d, i) => {
    check(`B diff[${i}].multi_op_flag=是`, d.multi_op_flag === '是');
    check(`B diff[${i}].source_table=T1`, d.source_table === 'T1');
  });
  const bEqualCount = diffsB.filter(d => d.cmp_amount === '相等').length;
  const bNotEqualCount = diffsB.filter(d => d.cmp_amount === '不相等').length;
  check('B 相等行 1 行 (fix5 多 OP 相等也进)', bEqualCount === 1);
  check('B 不相等行 2 行', bNotEqualCount === 2);
  // 相等行 amount_diff 应为空字符串
  diffsB.filter(d => d.cmp_amount === '相等').forEach((d) => {
    check('B 相等行 amount_diff=空', d.amount_diff === '' || d.amount_diff == null);
  });
  // 不相等行 amount_diff 非空
  diffsB.filter(d => d.cmp_amount === '不相等').forEach((d) => {
    check('B 不相等行 amount_diff 非空', d.amount_diff && d.amount_diff !== '');
  });

  importsRepo.clearByDateBu(db, '2026-05-11', 'BU-B');
  importsRepo.clearByDateBu(db, '2026-05-12', 'BU-B');
  flowRepo.clearByDate(db, '2026-05-12');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-12', 'BU-B');

  // ========================================================================
  // Case C：账户号增减差异（T-1有T-2无 / T-2有T-1无；拍板 C 来源不同）
  // T-2：C001, C002, C004（C4 是销户）
  // T-1：C001, C002, C003（C3 是新增）
  // 流水：C001/C002 余额对得上（不造差异）
  // 期望: t1NotT2Count=1 (C003)，t2NotT1Count=1 (C004)；
  //        diff_rows 含 C003 (source_table='T1', cmp_t2='T-1有T-2无') + C004 (source_table='T2', cmp_t2='T-2有T-1无')
  // ========================================================================
  importsRepo.insertRows(db, '2026-05-11', [
    opRow(2, 'BU-C', 'C001', { begin:1000, amount:0, amountIn:0, amountOut:0, end:1000 }),
    opRow(3, 'BU-C', 'C002', { begin:2000, amount:0, amountIn:0, amountOut:0, end:2000 }),
    opRow(4, 'BU-C', 'C004', { begin:500, amount:0, amountIn:0, amountOut:0, end:500 })  // 销户
  ]);
  importsRepo.insertRows(db, '2026-05-12', [
    opRow(2, 'BU-C', 'C001', { begin:1000, amount:0, amountIn:0, amountOut:0, end:1000 }),
    opRow(3, 'BU-C', 'C002', { begin:2000, amount:0, amountIn:0, amountOut:0, end:2000 }),
    opRow(4, 'BU-C', 'C003', { begin:0, amount:300, amountIn:300, amountOut:0, end:300 })  // 新增
  ]);
  flowRepo.insertRows(db, '2026-05-12', [
    flowR(2, 'BU-C', 'C003', '入', 300)  // 新增账户的流水
  ]);
  const resC = session.runReconciliation(db, { date:'2026-05-12', buName:'BU-C' });
  check('C t1NotT2Count=1', resC.stats.t1NotT2Count === 1);
  check('C t2NotT1Count=1', resC.stats.t2NotT1Count === 1);
  const diffsC = runRepo.getDiffRowsByRun(db, resC.runId);
  const t1NotT2Row = diffsC.find(d => d.cmp_t2 === 'T-1有T-2无');
  const t2NotT1Row = diffsC.find(d => d.cmp_t2 === 'T-2有T-1无');
  check('C t1NotT2 source=T1', t1NotT2Row && t1NotT2Row.source_table === 'T1');
  check('C t2NotT1 source=T2 (拍板 C)', t2NotT1Row && t2NotT1Row.source_table === 'T2');

  importsRepo.clearByDateBu(db, '2026-05-11', 'BU-C');
  importsRepo.clearByDateBu(db, '2026-05-12', 'BU-C');
  flowRepo.clearByDate(db, '2026-05-12');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-12', 'BU-C');

  // ========================================================================
  // Case D：流水累加 + 出入方向（资金红线 #3）
  // 5 行流水：3 入（+100, +200, +50）, 2 出（-30, -120）→ 净 +200
  // T-2: D001 期末=1000；T-1: D001 期末=1200（应相等）
  // ========================================================================
  importsRepo.insertRows(db, '2026-05-11', [
    opRow(2, 'BU-D', 'D001', { begin:900, amount:100, amountIn:100, amountOut:0, end:1000 })
  ]);
  importsRepo.insertRows(db, '2026-05-12', [
    opRow(2, 'BU-D', 'D001', { begin:1000, amount:200, amountIn:350, amountOut:150, end:1200 })
  ]);
  flowRepo.insertRows(db, '2026-05-12', [
    flowR(2, 'BU-D', 'D001', '入', 100),
    flowR(3, 'BU-D', 'D001', '入', 200),
    flowR(4, 'BU-D', 'D001', '入', 50),
    flowR(5, 'BU-D', 'D001', '出', 30),
    flowR(6, 'BU-D', 'D001', '出', 120)
  ]);
  const resD = session.runReconciliation(db, { date:'2026-05-12', buName:'BU-D' });
  check('D 流水累加正确 amountDiffCount=0', resD.stats.amountDiffCount === 0);

  // 资金红线：parseSignedAmount 边界 & aggregateFlowByAccount
  const aggMap = session.aggregateFlowByAccount(
    [flowR(2, 'BU-D', 'D001', '入', 100), flowR(3, 'BU-D', 'D001', '出', 30)],
    'BU-D'
  );
  check('D 累加 100 - 30 = 70', aggMap.get('D001') === 70);

  importsRepo.clearByDateBu(db, '2026-05-11', 'BU-D');
  importsRepo.clearByDateBu(db, '2026-05-12', 'BU-D');
  flowRepo.clearByDate(db, '2026-05-12');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-12', 'BU-D');

  // ========================================================================
  // Case E：业务OP 行整批拒绝 + 失败报告（#1 + #5 拍板）
  // 构造 5 行 xlsx；第 3 行 (1) 失败 / 第 5 行 (2) 失败
  // 期望：runBizOpImportAsync 返回 {status:'rejected'}；imports 表 0 行；error report xlsx 生成
  // ========================================================================
  const tmpXlsxE = path.join(tmpRoot, 'case-E.xlsx');
  {
    const XLSX = require('xlsx');
    const { BIZ_OP_HEADERS } = require('../../src/backend/biz-op-recon-db/columns');
    const rows = [BIZ_OP_HEADERS];
    // 5 行数据；第 3 行违反 (1)，第 5 行违反 (2)
    function rowArr(bu, acc, begin, amt, amtIn, amtOut, end) {
      // 按 BIZ_OP_HEADERS 顺序构造
      const obj = {
        'Billdate': '', '业务方': bu, '客户编号': '', '主体': '', '账户号': acc,
        '账户类型': '', '币种': 'CNY', '期初余额': begin, '发生额': amt,
        '发生额（入）': amtIn, '发生额（出）': amtOut, '期末余额': end,
        '期末可用余额': '', '期末冻结余额': '', '最近更新时间': '', '通道': '',
        'ppCardId': '', '银行卡号': '', '扩展信息': '', '账户状态': '',
        'BizId': '', '清结算系统创建时间': '', '清结算系统更新时间': ''
      };
      return BIZ_OP_HEADERS.map(h => obj[h]);
    }
    rows.push(rowArr('BU-E', 'E001', 100, 50, 80, 30, 150));   // 通过：50 == 80-30, 150 == 100+50
    rows.push(rowArr('BU-E', 'E002', 200, 30, 50, 20, 230));   // 通过：30 == 50-20, 230 == 200+30
    rows.push(rowArr('BU-E', 'E003', 100, 100, 80, 30, 200));  // (1) 失败：100 != 80-30=50
    rows.push(rowArr('BU-E', 'E004', 300, 20, 50, 30, 320));   // 通过：20 == 50-30, 320 == 300+20
    rows.push(rowArr('BU-E', 'E005', 100, 50, 80, 30, 200));   // (2) 失败：200 != 100+50=150
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'sheet');
    XLSX.writeFile(wb, tmpXlsxE);
  }
  const { readBizOpFile } = require('../../src/backend/biz-op-recon-import/reader');
  const resE = await session.runBizOpImportAsync(db, {
    date: '2026-05-13',
    filePath: tmpXlsxE,
    readBizOpFile,
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(tmpRoot, 'error-reports')
  });
  check('E status=rejected', resE.status === 'rejected');
  check('E errorRows.length=2', resE.errorRows.length === 2);
  check('E errorRows[0].rowIndex=4 (Excel 第 4 行 = 数据行 3)', resE.errorRows[0].rowIndex === 4);
  check('E errorRows[1].rowIndex=6', resE.errorRows[1].rowIndex === 6);
  check('E errorReportPath exists', fs.existsSync(resE.errorReportPath));
  // 验证 imports 表 0 行（事务回滚）
  const importsAfterE = importsRepo.getRowsByDateBu(db, '2026-05-13', 'BU-E');
  check('E imports 表 0 行（整批拒绝）', importsAfterE.length === 0);

  // 验证失败报告 xlsx 含 2 行 + 25 列表头
  const wbE = new ExcelJS.Workbook();
  await wbE.xlsx.readFile(resE.errorReportPath);
  const wsE = wbE.worksheets[0];
  check('E 失败报告 row count = 3 (header + 2 data)', wsE.rowCount === 3);
  check('E 失败报告 col 24 = 失败行号', wsE.getRow(1).getCell(24).value === '失败行号');
  check('E 失败报告 col 25 = 失败原因', wsE.getRow(1).getCell(25).value === '失败原因');

  // ========================================================================
  // Case F：日期区间导出（v2.1.3-fix6 拍板回滚：单 sheet 合并）
  // 构造 2026-05-10 / 11 / 12 三日 success run，每日 2 个账户 (F002, F001) 均有 amount_diff 差异；
  // 导出区间 09-13。
  // 期望:
  //   sheetCount = 1（合并）；rowCount = 6（3 日 × 2 账户）
  //   sheet 名 = '差异'；skippedDates = [09, 13]
  //   行序：data_date 升序 + 同日内 account_no 升序
  //   第 1 列 Billdate 由 sourceRow 携带，用于人工区分日期
  // ========================================================================
  // 故意先 F002 后 F001 写入，验证排序后输出顺序为 F001→F002
  // 各日 end_balance 单调递增，flowSum=0 → 每日 calcT1 ≠ T-1 end → 6 行 amount_diff
  const endByDay = {
    '2026-05-09': 1000,
    '2026-05-10': 1100,
    '2026-05-11': 1300,
    '2026-05-12': 1500
  };
  for (const d of Object.keys(endByDay)) {
    importsRepo.insertRows(db, d, [
      opRow(2, 'BU-F', 'F002', { begin:0, amount:0, amountIn:0, amountOut:0, end:endByDay[d], billDate:d }),
      opRow(3, 'BU-F', 'F001', { begin:0, amount:0, amountIn:0, amountOut:0, end:endByDay[d], billDate:d })
    ]);
  }
  // 流水 = 0（与 T-2 end_balance 单纯透传 → T-2 end ≠ T-1 end → 产 amount_diff）
  flowRepo.insertRows(db, '2026-05-10', []);
  flowRepo.insertRows(db, '2026-05-11', []);
  flowRepo.insertRows(db, '2026-05-12', []);
  session.runReconciliation(db, { date:'2026-05-10', buName:'BU-F' });
  session.runReconciliation(db, { date:'2026-05-11', buName:'BU-F' });
  session.runReconciliation(db, { date:'2026-05-12', buName:'BU-F' });

  const rangeOutPath = path.join(tmpRoot, 'range-F.xlsx');
  const rangeResult = await writer.writeDateRangeDiffWorkbook({
    db,
    buName: 'BU-F',
    startDate: '2026-05-09',
    endDate: '2026-05-13',
    savePath: rangeOutPath
  });
  check('F sheetCount=1 (v2.1.3-fix6 单 sheet)', rangeResult.sheetCount === 1);
  check('F rowCount=6 (3 日 × 2 账户)', rangeResult.rowCount === 6);
  check('F skippedDates=[09, 13]',
    rangeResult.skippedDates.length === 2 &&
    rangeResult.skippedDates.includes('2026-05-09') &&
    rangeResult.skippedDates.includes('2026-05-13'));

  const wbF = new ExcelJS.Workbook();
  await wbF.xlsx.readFile(rangeOutPath);
  check('F worksheets.length=1', wbF.worksheets.length === 1);
  check('F sheet 名 = 差异', wbF.worksheets[0].name === '差异');
  const wsF = wbF.worksheets[0];
  check('F row count = 7 (header + 6 data)', wsF.rowCount === 7);

  // 行序校验：data_date 升序（第 1 列 Billdate）+ 同日内 account_no 升序（第 5 列）
  // BIZ_OP_HEADERS: 1=Billdate, 5=账户号
  let prevDate = '';
  let prevAccWithinDate = '';
  let dateMonotonic = true;
  let accMonotonic = true;
  for (let r = 2; r <= wsF.rowCount; r += 1) {
    const billdate = String(wsF.getRow(r).getCell(1).value || '');
    const accNo = String(wsF.getRow(r).getCell(5).value || '');
    if (billdate < prevDate) dateMonotonic = false;
    if (billdate === prevDate && accNo < prevAccWithinDate) accMonotonic = false;
    if (billdate !== prevDate) prevAccWithinDate = '';
    prevDate = billdate;
    prevAccWithinDate = accNo;
  }
  check('F 行序：data_date 不递减', dateMonotonic);
  check('F 行序：同日内 account_no 不递减', accMonotonic);

  // 验证表头第 1 列 = Billdate（人工依赖此列区分日期，拍板回滚 #14）
  check('F 表头 col 1 = Billdate', wsF.getRow(1).getCell(1).value === 'Billdate');
  check('F 表头 col 5 = 账户号', wsF.getRow(1).getCell(5).value === '账户号');

  // 子用例：区间内 0 差异 → 占位 sheet
  const rangeEmptyPath = path.join(tmpRoot, 'range-F-empty.xlsx');
  const rangeEmptyResult = await writer.writeDateRangeDiffWorkbook({
    db,
    buName: 'BU-F-EMPTY-NEVER',  // 不存在的 BU → 0 success run → 占位 sheet
    startDate: '2026-05-09',
    endDate: '2026-05-13',
    savePath: rangeEmptyPath
  });
  check('F 空区间 sheetCount=0', rangeEmptyResult.sheetCount === 0);
  check('F 空区间 rowCount=0', rangeEmptyResult.rowCount === 0);
  const wbFEmpty = new ExcelJS.Workbook();
  await wbFEmpty.xlsx.readFile(rangeEmptyPath);
  check('F 空区间 占位 sheet 名 = 无差异数据', wbFEmpty.worksheets[0].name === '无差异数据');

  // 子用例：normalizeDateToISO helper 直接验证（用于 Billdate vs data_date 告警比对）
  check('F helper ISO 透传', writer.normalizeDateToISO('2026-05-10') === '2026-05-10');
  check('F helper 斜杠', writer.normalizeDateToISO('2026/5/10') === '2026-05-10');
  check('F helper 紧凑', writer.normalizeDateToISO('20260510') === '2026-05-10');
  check('F helper 空 → null', writer.normalizeDateToISO('') === null);
  check('F helper null → null', writer.normalizeDateToISO(null) === null);

  // ========================================================================
  // Case G：BU 隔离 + normalizeBu 大小写容忍（#7 拍板 C）
  // 流水含 'BU-G' / 'bu-g' / '  BU-G  '（全部应归一为 'bu-g'）
  // T-2/T-1 业务OP 用 'BU-G'；其他 BU 'BU-X' 不应被串入
  // ========================================================================
  importsRepo.insertRows(db, '2026-05-15', [
    opRow(2, 'BU-G', 'G001', { begin:1000, amount:0, amountIn:0, amountOut:0, end:1000 }),
    opRow(3, 'BU-X', 'X001', { begin:99999, amount:0, amountIn:0, amountOut:0, end:99999 })  // 不应被对账串入
  ]);
  importsRepo.insertRows(db, '2026-05-16', [
    opRow(2, 'BU-G', 'G001', { begin:1000, amount:300, amountIn:300, amountOut:0, end:1300 }),
    opRow(3, 'BU-X', 'X001', { begin:99999, amount:0, amountIn:0, amountOut:0, end:99999 })
  ]);
  flowRepo.insertRows(db, '2026-05-16', [
    flowR(2, 'BU-G', 'G001', '入', 100),
    flowR(3, 'bu-g', 'G001', '入', 100),
    flowR(4, '  BU-G  ', 'G001', '入', 100),
    flowR(5, 'BU-X', 'X001', '入', 999)  // 不应被 BU-G 流水累加
  ]);
  const resG = session.runReconciliation(db, { date:'2026-05-16', buName:'BU-G' });
  check('G amountDiffCount=0 (流水 100+100+100=300 = 实际 +300)', resG.stats.amountDiffCount === 0);
  check('G flowTotal=3 (BU-G 三个变体)', resG.stats.flowTotal === 3);
  check('G t1OpTotal=1 (仅 BU-G G001)', resG.stats.t1OpTotal === 1);
  check('G t2OpTotal=1', resG.stats.t2OpTotal === 1);

  // ========================================================================
  // Case H：重新导入清空旧 runs（#15 拍板 A，资金红线 P1 fix 回归）
  // 步骤：跑 Case A 的对账 → 拿到 runId → 验证 listSuccessDates 含该日期
  //       再 import 同 (date, BU) 新数据 → 验证 runs/diff_rows 已清空
  // ========================================================================
  importsRepo.clearByDateBu(db, '2026-05-15', 'BU-G');
  importsRepo.clearByDateBu(db, '2026-05-16', 'BU-G');
  flowRepo.clearByDate(db, '2026-05-16');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-16', 'BU-G');

  // 构造 H 用例：2026-06-01 BU-H 数据 + run
  importsRepo.insertRows(db, '2026-05-31', [opRow(2, 'BU-H', 'H001', { begin:1000, amount:0, amountIn:0, amountOut:0, end:1000 })]);
  importsRepo.insertRows(db, '2026-06-01', [opRow(2, 'BU-H', 'H001', { begin:1000, amount:0, amountIn:0, amountOut:0, end:1000 })]);
  flowRepo.insertRows(db, '2026-06-01', []);
  const resH0 = session.runReconciliation(db, { date:'2026-06-01', buName:'BU-H' });
  check('H0 init run 已落 runId', resH0.runId > 0);
  const successH0 = runRepo.listSuccessDates(db, 'BU-H');
  check('H0 listSuccessDates 含 2026-06-01', successH0.some(s => s.date === '2026-06-01'));

  // 模拟重新导入：业务OP 重新导入相同 (date, BU)，验证 runs/diff_rows 清空
  const tmpXlsxH = path.join(tmpRoot, 'case-H.xlsx');
  {
    const XLSX = require('xlsx');
    const { BIZ_OP_HEADERS } = require('../../src/backend/biz-op-recon-db/columns');
    function rowArr(bu, acc, begin, amt, amtIn, amtOut, end) {
      const obj = {
        'Billdate': '', '业务方': bu, '客户编号': '', '主体': '', '账户号': acc,
        '账户类型': '', '币种': 'CNY', '期初余额': begin, '发生额': amt,
        '发生额（入）': amtIn, '发生额（出）': amtOut, '期末余额': end,
        '期末可用余额': '', '期末冻结余额': '', '最近更新时间': '', '通道': '',
        'ppCardId': '', '银行卡号': '', '扩展信息': '', '账户状态': '',
        'BizId': '', '清结算系统创建时间': '', '清结算系统更新时间': ''
      };
      return BIZ_OP_HEADERS.map(h => obj[h]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      BIZ_OP_HEADERS,
      rowArr('BU-H', 'H001', 1000, 0, 0, 0, 1000)
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'sheet');
    XLSX.writeFile(wb, tmpXlsxH);
  }
  const resH1 = await session.runBizOpImportAsync(db, {
    date: '2026-06-01',
    filePath: tmpXlsxH,
    readBizOpFile,
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(tmpRoot, 'error-reports')
  });
  check('H1 重新导入 success', resH1.status === 'success');
  const successH1 = runRepo.listSuccessDates(db, 'BU-H');
  check('H1 重新导入后 listSuccessDates 不含 2026-06-01（旧 runs 已清）',
    !successH1.some(s => s.date === '2026-06-01'),
    '资金红线 P1：重新导入未清旧 run → 旧 runId 套到新数据上');
  const diffsAfterH = runRepo.getDiffRowsByRun(db, resH0.runId);
  check('H1 旧 run 的 diff_rows 已清', diffsAfterH.length === 0);

  // 清理 H 用例
  importsRepo.clearByDateBu(db, '2026-05-31', 'BU-H');
  importsRepo.clearByDateBu(db, '2026-06-01', 'BU-H');
  flowRepo.clearByDate(db, '2026-06-01');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-06-01', 'BU-H');

  // ========================================================================
  // Case I：多 OP 账户精准统计（资金红线 ⚠️ fix3.1 回归）
  //
  // 场景：T-1 业务OP 含同账户号 3 条数据，期末 1070 / 1100 / 1050；流水净 +70 → 计算 T-1=1070
  //       2 行不相等（1100 / 1050）、1 行相等（1070）→ amountDiffCount=2 / multiOpAccountCount=1
  //
  // 资金红线 ⚠️：Case B 已覆盖"T-2 同账户号在场"的多 OP，这里补"T-1 多 OP 但 T-2 无该账户号"
  //   触发 §5.1 步 5.a 单独处理路径；fix3.1 前 multiOpAccountCount 漏统计（onlyInT1 路径不进
  //   compareT1OpWithComputed 的 multiOp 计数，状态栏「多 OP 账户 N 个」永远显示 0）
  //
  // 子用例 I-1：T-2 有该账户号 + T-1 多 OP（与 B 同形，验证未回归）
  // 子用例 I-2：T-2 无该账户号 + T-1 多 OP（onlyInT1 路径；fix3.1 核心回归）
  // ========================================================================

  // I-1：T-2 有 I001 期末=1000；T-1 含 I001 三条（1070/1100/1050）+ 流水 +70
  importsRepo.insertRows(db, '2026-05-11', [
    opRow(2, 'BU-I', 'I001', { begin:900, amount:100, amountIn:100, amountOut:0, end:1000 })
  ]);
  importsRepo.insertRows(db, '2026-05-12', [
    opRow(2, 'BU-I', 'I001', { begin:1000, amount:70, amountIn:100, amountOut:30, end:1070 }),
    opRow(3, 'BU-I', 'I001', { begin:1000, amount:100, amountIn:100, amountOut:0, end:1100 }),
    opRow(4, 'BU-I', 'I001', { begin:1000, amount:50, amountIn:50, amountOut:0, end:1050 })
  ]);
  flowRepo.insertRows(db, '2026-05-12', [
    flowR(2, 'BU-I', 'I001', '入', 100),
    flowR(3, 'BU-I', 'I001', '出', 30)
  ]);
  const resI1 = session.runReconciliation(db, { date:'2026-05-12', buName:'BU-I' });
  check('I-1 multiOpAccountCount=1 (T-2 有 + T-1 多 OP)', resI1.stats.multiOpAccountCount === 1);
  check('I-1 amountDiffCount=2', resI1.stats.amountDiffCount === 2);
  check('I-1 t1NotT2Count=0', resI1.stats.t1NotT2Count === 0);

  importsRepo.clearByDateBu(db, '2026-05-11', 'BU-I');
  importsRepo.clearByDateBu(db, '2026-05-12', 'BU-I');
  flowRepo.clearByDate(db, '2026-05-12');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-12', 'BU-I');

  // I-2：T-2 完全无 J001（onlyInT1）；T-1 含 J001 三条 + J002 一条
  //   J001 三条期末 1070 / 1100 / 1050 → 进 §5.1 步 5.a 路径
  //   J002 一条期末 500 → 单 OP，但同样 onlyInT1
  //   流水：J001 入 100 / J001 出 30（J001 流水累加无效，因 T-2 无该账户号 → calcT1 undefined）
  //
  // 注意：T-2 必须有数据才能跑对账 — 因此放 1 个 OTHER001 占位（会进 onlyInT2 → +1 diff 行）
  //
  // 期望：amountDiffCount=0（onlyInT1 行不进测算金额对账）
  //       t1NotT2Count=4（J001×3 + J002×1）；t2NotT1Count=1（OTHER001）
  //       multiOpAccountCount=1（仅 J001 是多 OP；OTHER001 在 T-2 不参与 T-1 多 OP 判定）
  //       diff_rows 5 行：J001×3 multi_op_flag='是' / J002×1 multi_op_flag='否' / OTHER001×1 (来源 T-2)
  importsRepo.insertRows(db, '2026-05-11', [
    opRow(2, 'BU-J', 'OTHER001', { begin:900, amount:0, amountIn:0, amountOut:0, end:900 })  // T-2 占位但不重叠 J*
  ]);
  importsRepo.insertRows(db, '2026-05-12', [
    opRow(2, 'BU-J', 'J001', { begin:1000, amount:70, amountIn:100, amountOut:30, end:1070 }),
    opRow(3, 'BU-J', 'J001', { begin:1000, amount:100, amountIn:100, amountOut:0, end:1100 }),
    opRow(4, 'BU-J', 'J001', { begin:1000, amount:50, amountIn:50, amountOut:0, end:1050 }),
    opRow(5, 'BU-J', 'J002', { begin:500, amount:0, amountIn:0, amountOut:0, end:500 })
  ]);
  flowRepo.insertRows(db, '2026-05-12', [
    flowR(2, 'BU-J', 'J001', '入', 100),
    flowR(3, 'BU-J', 'J001', '出', 30)
  ]);
  const resI2 = session.runReconciliation(db, { date:'2026-05-12', buName:'BU-J' });
  check('I-2 amountDiffCount=0 (onlyInT1 行不进测算金额对账)', resI2.stats.amountDiffCount === 0);
  check('I-2 t1NotT2Count=4 (J001×3 + J002×1)', resI2.stats.t1NotT2Count === 4);
  check('I-2 t2NotT1Count=1 (OTHER001)', resI2.stats.t2NotT1Count === 1);
  check('I-2 multiOpAccountCount=1 (仅 J001 多 OP)', resI2.stats.multiOpAccountCount === 1,
    '资金红线 ⚠️ fix3.1：onlyInT1 路径需累加 multi OP 账户数');

  const diffsI2 = runRepo.getDiffRowsByRun(db, resI2.runId);
  check('I-2 diff_rows 5 行 (J001×3 + J002×1 + OTHER001×1)', diffsI2.length === 5);
  const j001Diffs = diffsI2.filter(d => {
    const src = importsRepo.getRowById(db, d.source_row_id);
    return src && src.account_no === 'J001';
  });
  const j002Diffs = diffsI2.filter(d => {
    const src = importsRepo.getRowById(db, d.source_row_id);
    return src && src.account_no === 'J002';
  });
  const t2Diffs = diffsI2.filter(d => d.source_table === 'T2');
  check('I-2 J001 三行均 multi_op_flag=是', j001Diffs.length === 3 && j001Diffs.every(d => d.multi_op_flag === '是'));
  check('I-2 J002 一行 multi_op_flag=否', j002Diffs.length === 1 && j002Diffs[0].multi_op_flag === '否');
  check('I-2 T-2 有 T-1 无行 multi_op_flag=否', t2Diffs.length === 1 && t2Diffs[0].multi_op_flag === '否');
  check('I-2 T-1 来源 4 行 cmp_t2=T-1有T-2无',
    diffsI2.filter(d => d.source_table === 'T1').every(d => d.cmp_t2 === 'T-1有T-2无'));
  check('I-2 T-1 来源行 cmp_amount 空', diffsI2.filter(d => d.source_table === 'T1').every(d => d.cmp_amount === ''));

  importsRepo.clearByDateBu(db, '2026-05-11', 'BU-J');
  importsRepo.clearByDateBu(db, '2026-05-12', 'BU-J');
  flowRepo.clearByDate(db, '2026-05-12');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-12', 'BU-J');

  // I-3：onlyInT1 同账户号 N 行（多 OP）防重复累加（资金红线边界）
  //   T-2 无 K001；T-1 含 K001 五条 + K002 五条（K002 也是多 OP）→ multiOpAccountCount 应 = 2（不是 10）
  importsRepo.insertRows(db, '2026-05-11', [
    opRow(2, 'BU-K', 'OTHER002', { begin:1, amount:0, amountIn:0, amountOut:0, end:1 })
  ]);
  importsRepo.insertRows(db, '2026-05-12', [
    opRow(2, 'BU-K', 'K001', { begin:0, amount:0, amountIn:0, amountOut:0, end:100 }),
    opRow(3, 'BU-K', 'K001', { begin:0, amount:0, amountIn:0, amountOut:0, end:200 }),
    opRow(4, 'BU-K', 'K001', { begin:0, amount:0, amountIn:0, amountOut:0, end:300 }),
    opRow(5, 'BU-K', 'K001', { begin:0, amount:0, amountIn:0, amountOut:0, end:400 }),
    opRow(6, 'BU-K', 'K001', { begin:0, amount:0, amountIn:0, amountOut:0, end:500 }),
    opRow(7, 'BU-K', 'K002', { begin:0, amount:0, amountIn:0, amountOut:0, end:600 }),
    opRow(8, 'BU-K', 'K002', { begin:0, amount:0, amountIn:0, amountOut:0, end:700 }),
    opRow(9, 'BU-K', 'K002', { begin:0, amount:0, amountIn:0, amountOut:0, end:800 }),
    opRow(10, 'BU-K', 'K002', { begin:0, amount:0, amountIn:0, amountOut:0, end:900 }),
    opRow(11, 'BU-K', 'K002', { begin:0, amount:0, amountIn:0, amountOut:0, end:1000 })
  ]);
  flowRepo.insertRows(db, '2026-05-12', []);
  const resI3 = session.runReconciliation(db, { date:'2026-05-12', buName:'BU-K' });
  check('I-3 multiOpAccountCount=2 (两个账户号各 5 行，去重)', resI3.stats.multiOpAccountCount === 2);
  check('I-3 t1NotT2Count=10', resI3.stats.t1NotT2Count === 10);

  importsRepo.clearByDateBu(db, '2026-05-11', 'BU-K');
  importsRepo.clearByDateBu(db, '2026-05-12', 'BU-K');
  flowRepo.clearByDate(db, '2026-05-12');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-12', 'BU-K');

  // ========================================================================
  // Case J：多 OP 相等行也进 diff_rows（v2.1.3 fix5 选项 B，资金红线 ⚠️）
  //
  // 拍板背景：用户拍板选项 B — 多 OP N 行全进差异表（含相等行）
  // PRD §3.5.4 → §3.5.5（fix5 反向同步）：进表条件改为
  //   「比对T-2日 非空 OR 比对测算金额=='不相等' OR 同账户号多个OP=='是'」
  //
  // 场景：T-2 (2026-05-11) ACC-MULTI 期末=100
  //       T-1 (2026-05-12) ACC-MULTI × 3 行（期末 100 / 101 / 100）
  //       流水 (2026-05-12)：ACC-MULTI 入 0 → 计算 T-1 = 100
  //       → 3 行：1070(=100) 相等 / 1100(=101) 不相等(差1) / 1050(=100) 相等
  //
  // 期望：
  //   - 3 行全进 diff_rows（fix5 核心）
  //   - 全 multi_op_flag='是'
  //   - cmp_amount: 相等 × 2 / 不相等 × 1
  //   - amount_diff: 相等行 = '' / 不相等行 = '1' (Math.abs(101-100))
  //   - stats.amountDiffCount = 1（仅"不相等"，语义保持）
  //   - stats.multiOpAccountCount = 1
  //   - writer 单日导出 xlsx：3 行（不含表头）
  // ========================================================================
  importsRepo.insertRows(db, '2026-05-11', [
    opRow(2, 'B2B', 'ACC-MULTI', { begin:50, amount:50, amountIn:50, amountOut:0, end:100 })
  ]);
  importsRepo.insertRows(db, '2026-05-12', [
    opRow(2, 'B2B', 'ACC-MULTI', { begin:100, amount:0, amountIn:0, amountOut:0, end:100 }),
    opRow(3, 'B2B', 'ACC-MULTI', { begin:100, amount:1, amountIn:1, amountOut:0, end:101 }),
    opRow(4, 'B2B', 'ACC-MULTI', { begin:100, amount:0, amountIn:0, amountOut:0, end:100 })
  ]);
  flowRepo.insertRows(db, '2026-05-12', []);  // 0 流水 → 计算 T-1 = T-2 期末 = 100

  const resJ = session.runReconciliation(db, { date:'2026-05-12', buName:'B2B' });
  const diffsJ = runRepo.getDiffRowsByRun(db, resJ.runId);

  // 1. 3 行全进
  check('J diff_rows 3 行 (多 OP N 行全进)', diffsJ.length === 3);

  // 2. 3 行 source_table 全 T1
  check('J 3 行均 source_table=T1', diffsJ.every(d => d.source_table === 'T1'));

  // 3. 3 行 multi_op_flag 全 '是'
  check('J 3 行均 multi_op_flag=是', diffsJ.every(d => d.multi_op_flag === '是'));

  // 4. cmp_amount: 相等 × 2 + 不相等 × 1
  const jEqualCount = diffsJ.filter(d => d.cmp_amount === '相等').length;
  const jNotEqualCount = diffsJ.filter(d => d.cmp_amount === '不相等').length;
  check('J 相等行 2 行', jEqualCount === 2);
  check('J 不相等行 1 行', jNotEqualCount === 1);

  // 5. amount_diff: 相等行 = '' / 不相等行 ≈ 1
  diffsJ.filter(d => d.cmp_amount === '相等').forEach((d) => {
    check('J 相等行 amount_diff=空', d.amount_diff === '' || d.amount_diff == null);
  });
  const jNotEqualRow = diffsJ.find(d => d.cmp_amount === '不相等');
  check('J 不相等行 amount_diff ≈ 1', jNotEqualRow && Math.abs(Number(jNotEqualRow.amount_diff) - 1) <= 0.01);

  // 6. summary 不变
  check('J amountDiffCount=1 (仅不相等行)', resJ.stats.amountDiffCount === 1,
    '资金红线 ⚠️：状态栏「测算金额差异」语义保持仅"不相等"');
  check('J multiOpAccountCount=1', resJ.stats.multiOpAccountCount === 1);
  check('J t1NotT2Count=0', resJ.stats.t1NotT2Count === 0);
  check('J t2NotT1Count=0', resJ.stats.t2NotT1Count === 0);

  // 7. writer 单日导出 xlsx：3 行（不含表头）
  const jOutPath = path.join(tmpRoot, 'case-J.xlsx');
  const jWriteResult = await writer.writeSingleDateDiffWorkbook({
    db,
    date: '2026-05-12',
    buName: 'B2B',
    runId: resJ.runId,
    savePath: jOutPath
  });
  check('J writer rowCount=3', jWriteResult.rowCount === 3);
  const wbJ = new ExcelJS.Workbook();
  await wbJ.xlsx.readFile(jOutPath);
  const wsJ = wbJ.worksheets[0];
  // rowCount 含表头 → 数据 3 行 = 总 4 行
  check('J xlsx 总行数 4 (header + 3 data)', wsJ.rowCount === 4);
  check('J xlsx sheet 名 = ISO 日期', wsJ.name === '2026-05-12');

  importsRepo.clearByDateBu(db, '2026-05-11', 'B2B');
  importsRepo.clearByDateBu(db, '2026-05-12', 'B2B');
  flowRepo.clearByDate(db, '2026-05-12');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-12', 'B2B');

  // ========================================================================
  // Case L：T-2 end_balance NaN silent drop（v2.1.3-fix7-I3 回归，资金红线 ⚠️）
  //
  // round 2 R2-I3a swap：原 code 编号 Case M ↔ spec §9.11 Case L 对齐（先 I3 NaN）
  //
  // 拍板：保守方案 — console.warn + summary.t2AnomalyAccountCount，不动 diff_rows schema
  //
  // 场景：T-2 (2026-05-25) M001 期末='abc'（NaN，绕过 import 校验直接 insertRows）+ M002 期末=500
  //       T-1 (2026-05-26) M001 期末=100 + M002 期末=500
  //       流水 (2026-05-26) 空
  //       → M001 因 T-2 NaN silent drop（既不进 amount diff 也不进账户号差集，因为 T-2 set 含它）
  //         M002 期末相等 → 无差异
  //       → summary.t2AnomalyAccountCount === 1 (M001) + console.warn 至少 1 次
  // ========================================================================
  // spy console.warn
  const origWarn = console.warn;
  const warnLogs = [];
  console.warn = (...args) => { warnLogs.push(args.join(' ')); };
  try {
    importsRepo.insertRows(db, '2026-05-25', [
      opRow(2, 'BU-M', 'M001', { begin:0, amount:0, amountIn:0, amountOut:0, end:0 }),  // 占位
      opRow(3, 'BU-M', 'M002', { begin:0, amount:500, amountIn:500, amountOut:0, end:500 })
    ]);
    // 直接改 M001 那一行的 end_balance 为 'abc' 模拟 NaN（绕过 validator）
    db.prepare(`UPDATE biz_op_recon_imports SET end_balance = 'abc' WHERE data_date = ? AND account_no = ?`)
      .run('2026-05-25', 'M001');
    importsRepo.insertRows(db, '2026-05-26', [
      opRow(2, 'BU-M', 'M001', { begin:0, amount:100, amountIn:100, amountOut:0, end:100 }),
      opRow(3, 'BU-M', 'M002', { begin:0, amount:0, amountIn:0, amountOut:0, end:500 })
    ]);
    flowRepo.insertRows(db, '2026-05-26', []);

    const resL = session.runReconciliation(db, { date:'2026-05-26', buName:'BU-M' });
    check('L summary.t2AnomalyAccountCount=1 (M001)', resL.stats.t2AnomalyAccountCount === 1,
      `资金红线 ⚠️ fix7-I3：T-2 NaN 账户号未计入 anomaly summary，实际 ${resL.stats.t2AnomalyAccountCount}`);
    const m001Warned = warnLogs.some(l => l.includes('M001') && l.includes('NaN silent drop'));
    check('L console.warn 含 M001 NaN silent drop 提示', m001Warned,
      `资金红线 ⚠️ fix7-I3：警告未输出，警告日志：${JSON.stringify(warnLogs)}`);
    // v2.1.3 round 1（spec §4.3）：DB 持久化验证 — t2_anomaly_account_count 列写入正确
    const dbRowL = db.prepare('SELECT t2_anomaly_account_count FROM biz_op_recon_runs WHERE id = ?').get(resL.runId);
    check('L DB 持久化 t2_anomaly_account_count = 1',
      dbRowL && dbRowL.t2_anomaly_account_count === 1,
      `spec §4.3：runs 表未持久化 anomaly count，实际行=${JSON.stringify(dbRowL)}`);
  } finally {
    console.warn = origWarn;
  }

  importsRepo.clearByDateBu(db, '2026-05-25', 'BU-M');
  importsRepo.clearByDateBu(db, '2026-05-26', 'BU-M');
  flowRepo.clearByDate(db, '2026-05-26');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-26', 'BU-M');

  // ========================================================================
  // Case M：BU 大小写重新导入（v2.1.3-fix7-C1 回归，资金红线 ⚠️）
  //
  // round 2 R2-I3a swap：原 code 编号 Case L ↔ spec §9.12 Case M 对齐（C1 大小写）
  //
  // 拍板：clearByDateBu 改用 LOWER(TRIM(bu_name)) 与其他 4 个查询函数对齐
  //
  // 场景：
  //   1) 第 1 次直接 insertRows: bu_name='BU-A' 3 行（模拟首次 import）
  //   2) 第 2 次跑 runBizOpImportAsync xlsx 业务方='bu-a'（大小写差） 4 行
  //      → 落库前 clearByDateBu 应 DELETE 旧 'BU-A' 3 行 → INSERT 新 'bu-a' 4 行
  //   3) 期望：getRowsByDateBu(date, 'bu-a') 返回 4 行（不是 3+4=7 行）
  //
  // 资金红线 ⚠️：原 bug clearByDateBu 用精确 = 比较 → 大小写不同的旧 BU 行 silently 残留 →
  // 对账时 normalizeBu 一致 → 同一账户号被算两次（'BU-A' + 'bu-a'）→ 期末余额翻倍
  // ========================================================================
  importsRepo.insertRows(db, '2026-05-20', [
    opRow(2, 'BU-A', 'L001', { begin:0, amount:100, amountIn:100, amountOut:0, end:100 }),
    opRow(3, 'BU-A', 'L002', { begin:0, amount:200, amountIn:200, amountOut:0, end:200 }),
    opRow(4, 'BU-A', 'L003', { begin:0, amount:300, amountIn:300, amountOut:0, end:300 })
  ]);
  // 验证首次 insert 已落 3 行
  const beforeM = importsRepo.getRowsByDateBu(db, '2026-05-20', 'BU-A');
  check('M 首次落库 3 行（基线）', beforeM.length === 3);

  // 第 2 次：xlsx 业务方='bu-a'（小写）
  const tmpXlsxM = path.join(tmpRoot, 'case-M.xlsx');
  {
    const XLSX = require('xlsx');
    const { BIZ_OP_HEADERS } = require('../../src/backend/biz-op-recon-db/columns');
    function rowArrM(bu, acc, begin, amt, amtIn, amtOut, end) {
      const obj = {
        'Billdate': '', '业务方': bu, '客户编号': '', '主体': '', '账户号': acc,
        '账户类型': '', '币种': 'CNY', '期初余额': begin, '发生额': amt,
        '发生额（入）': amtIn, '发生额（出）': amtOut, '期末余额': end,
        '期末可用余额': '', '期末冻结余额': '', '最近更新时间': '', '通道': '',
        'ppCardId': '', '银行卡号': '', '扩展信息': '', '账户状态': '',
        'BizId': '', '清结算系统创建时间': '', '清结算系统更新时间': ''
      };
      return BIZ_OP_HEADERS.map(h => obj[h]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      BIZ_OP_HEADERS,
      rowArrM('bu-a', 'L101', 0, 10, 10, 0, 10),
      rowArrM('bu-a', 'L102', 0, 20, 20, 0, 20),
      rowArrM('bu-a', 'L103', 0, 30, 30, 0, 30),
      rowArrM('bu-a', 'L104', 0, 40, 40, 0, 40)
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'sheet');
    XLSX.writeFile(wb, tmpXlsxM);
  }
  const resM = await session.runBizOpImportAsync(db, {
    date: '2026-05-20',
    filePath: tmpXlsxM,
    readBizOpFile,
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(tmpRoot, 'error-reports')
  });
  check('M 第 2 次 import success', resM.status === 'success');

  // 关键 assertion：getRowsByDateBu('bu-a') 返回 4 行（旧 'BU-A' 3 行已清）
  const afterM_lower = importsRepo.getRowsByDateBu(db, '2026-05-20', 'bu-a');
  check('M 第 2 次 import 后 getRowsByDateBu(bu-a) = 4 行（旧 BU-A 已清）',
    afterM_lower.length === 4,
    `资金红线 ⚠️ fix7-C1：clearByDateBu 大小写不一致漏清 → 实际 ${afterM_lower.length} 行`);
  // 用大写查也应是 4 行（normalize 一致）
  const afterM_upper = importsRepo.getRowsByDateBu(db, '2026-05-20', 'BU-A');
  check('M 大写 BU-A 查询同样 4 行（normalize 等价）', afterM_upper.length === 4);

  importsRepo.clearByDateBu(db, '2026-05-20', 'BU-A');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-20', 'BU-A');

  // ========================================================================
  // Case N：Billdate ≠ data_date console.warn（M5 spec § 6.2 已声明的调试线索）
  //
  // 场景：构造 1 行 OP T-1 = 2026-05-13 但 sourceRow.bill_date_raw='2026-05-12'
  //       且产生差异 → 进入区间导出 collected
  //       → console.warn 拦截至少 1 次
  // ========================================================================
  const origWarn2 = console.warn;
  const warnLogs2 = [];
  console.warn = (...args) => { warnLogs2.push(args.join(' ')); };
  try {
    // T-2 期末 1000；T-1 期末 1100（产差）；Billdate 字段故意写成前一日
    importsRepo.insertRows(db, '2026-06-09', [
      opRow(2, 'BU-N', 'N001', { begin:900, amount:100, amountIn:100, amountOut:0, end:1000, billDate:'2026-06-09' })
    ]);
    importsRepo.insertRows(db, '2026-06-10', [
      opRow(2, 'BU-N', 'N001', { begin:1000, amount:100, amountIn:100, amountOut:0, end:1100, billDate:'2026-06-08' })  // 故意 ≠ data_date
    ]);
    flowRepo.insertRows(db, '2026-06-10', []);
    session.runReconciliation(db, { date:'2026-06-10', buName:'BU-N' });

    const nOutPath = path.join(tmpRoot, 'case-N-range.xlsx');
    await writer.writeDateRangeDiffWorkbook({
      db,
      buName: 'BU-N',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      savePath: nOutPath
    });
    const billdateWarned = warnLogs2.some(l => l.includes('Billdate') && l.includes('不一致'));
    check('N console.warn 含 Billdate vs data_date 不一致提示', billdateWarned,
      `M5 spec § 6.2：Billdate 不一致 console.warn 未触发，警告日志：${JSON.stringify(warnLogs2)}`);
  } finally {
    console.warn = origWarn2;
  }

  importsRepo.clearByDateBu(db, '2026-06-09', 'BU-N');
  importsRepo.clearByDateBu(db, '2026-06-10', 'BU-N');
  flowRepo.clearByDate(db, '2026-06-10');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-06-10', 'BU-N');

  // ========================================================================
  // Case O：I2 BU 名落库前 trim 归一防回归（round 2 R2-I3b 新增，资金红线 ⚠️）
  //
  // 拍板（round 1 I2）：runBizOpImportAsync 落库前把所有行 bu_name 改写为 firstBu.trim()
  // → DB 内 bu_name 始终是 trim 后值；listDistinctBus 不会出现 '  BU-A  ' / 'BU-A' 两条 distinct
  //
  // 场景：两次 runBizOpImportAsync（相同 date=2026-06-20）：
  //   1) 第 1 次 xlsx 业务方='  BU-A  '（含首尾空白）3 行
  //   2) 第 2 次 xlsx 业务方='BU-A'（已 trim）2 行
  //      → 第 2 次落库前 clearByDateBu('BU-A') 经 LOWER(TRIM) 命中第 1 次的 'BU-A' 行 → 全清
  //      → 最终 DB 只剩第 2 次 2 行
  //
  // 资金红线 ⚠️：原 bug（fix7-I2 之前）— 首尾空白 BU 落库后下拉显示两条 / clearByDateBu
  //   按精确 = 漏清 → 同 BU 数据被双倍累加
  // ========================================================================
  const tmpXlsxO1 = path.join(tmpRoot, 'case-O-1.xlsx');
  const tmpXlsxO2 = path.join(tmpRoot, 'case-O-2.xlsx');
  {
    const XLSX = require('xlsx');
    const { BIZ_OP_HEADERS } = require('../../src/backend/biz-op-recon-db/columns');
    function rowArrO(bu, acc, begin, amt, amtIn, amtOut, end) {
      const obj = {
        'Billdate': '', '业务方': bu, '客户编号': '', '主体': '', '账户号': acc,
        '账户类型': '', '币种': 'CNY', '期初余额': begin, '发生额': amt,
        '发生额（入）': amtIn, '发生额（出）': amtOut, '期末余额': end,
        '期末可用余额': '', '期末冻结余额': '', '最近更新时间': '', '通道': '',
        'ppCardId': '', '银行卡号': '', '扩展信息': '', '账户状态': '',
        'BizId': '', '清结算系统创建时间': '', '清结算系统更新时间': ''
      };
      return BIZ_OP_HEADERS.map(h => obj[h]);
    }
    // 第 1 次：业务方='  BU-A  '（首尾空白）3 行
    const wb1 = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([
      BIZ_OP_HEADERS,
      rowArrO('  BU-A  ', 'O001', 0, 100, 100, 0, 100),
      rowArrO('  BU-A  ', 'O002', 0, 200, 200, 0, 200),
      rowArrO('  BU-A  ', 'O003', 0, 300, 300, 0, 300)
    ]);
    XLSX.utils.book_append_sheet(wb1, ws1, 'sheet');
    XLSX.writeFile(wb1, tmpXlsxO1);
    // 第 2 次：业务方='BU-A'（无空白）2 行
    const wb2 = XLSX.utils.book_new();
    const ws2 = XLSX.utils.aoa_to_sheet([
      BIZ_OP_HEADERS,
      rowArrO('BU-A', 'O101', 0, 50, 50, 0, 50),
      rowArrO('BU-A', 'O102', 0, 60, 60, 0, 60)
    ]);
    XLSX.utils.book_append_sheet(wb2, ws2, 'sheet');
    XLSX.writeFile(wb2, tmpXlsxO2);
  }
  const resO1 = await session.runBizOpImportAsync(db, {
    date: '2026-06-20',
    filePath: tmpXlsxO1,
    readBizOpFile,
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(tmpRoot, 'error-reports')
  });
  check('O 第 1 次 import success', resO1.status === 'success');
  const resO2 = await session.runBizOpImportAsync(db, {
    date: '2026-06-20',
    filePath: tmpXlsxO2,
    readBizOpFile,
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(tmpRoot, 'error-reports')
  });
  check('O 第 2 次 import success', resO2.status === 'success');

  // 1. listDistinctBus 中 BU-A* 系应只返回 1 行（不是 '  BU-A  ' + 'BU-A' 两条）
  // 注：listDistinctBus 不 normalize 返回原值，因此前面 case 残留的 BU-F/BU-X 无关，仅看 BU-A 系
  const distinctO = importsRepo.listDistinctBus(db);
  const distinctOAVariants = distinctO.filter(b => String(b.buName || '').trim().toUpperCase() === 'BU-A');
  check('O listDistinctBus 中 BU-A 系=1 条（首尾空白已 trim 归一）',
    distinctOAVariants.length === 1,
    `资金红线 ⚠️ fix7-I2：BU 名首尾空白未 trim → 下拉两条；实际 ${distinctOAVariants.length} 条 ${JSON.stringify(distinctOAVariants)}`);

  // 2. distinct[0].buName === 'BU-A'（trim 后字面值）
  check('O distinct[0].buName=BU-A（落库前 trim 改写后字面值）',
    distinctOAVariants[0] && distinctOAVariants[0].buName === 'BU-A',
    `资金红线 ⚠️ fix7-I2：DB bu_name 未 trim 改写；实际=${JSON.stringify(distinctOAVariants[0])}`);

  // 3. getRowsByDateBu('BU-A') = 2 行（仅第 2 次；第 1 次被 clearByDateBu trim 归一后清掉）
  const rowsByBuO = importsRepo.getRowsByDateBu(db, '2026-06-20', 'BU-A');
  check('O getRowsByDateBu(BU-A)=2 行（C1+I2 联动；第 1 次已清）',
    rowsByBuO.length === 2,
    `资金红线 ⚠️：第 1 次 3 行未被 clearByDateBu 清；实际 ${rowsByBuO.length} 行`);

  // 4. 用 '  BU-A  ' 查询同样 2 行（C1 LOWER+TRIM 仍命中）
  const rowsByBuOWhite = importsRepo.getRowsByDateBu(db, '2026-06-20', '  BU-A  ');
  check('O getRowsByDateBu(  BU-A  )=2 行（C1 LOWER+TRIM 容忍空白）',
    rowsByBuOWhite.length === 2,
    `资金红线 ⚠️ fix7-C1：getRowsByDateBu 未对查询参数 TRIM；实际 ${rowsByBuOWhite.length} 行`);

  importsRepo.clearByDateBu(db, '2026-06-20', 'BU-A');
  runRepo.clearRunsAndDiffsByDateBu(db, '2026-06-20', 'BU-A');

  // ========================================================================
  // Case P：流水重导清"该 date 跨所有 BU"的旧 runs/diff_rows（资金红线 ⚠️ PR #45 round 3 P1 fix）
  //
  // 背景：流水按 date 跨所有 BU 共用（spec §4.2 #4 拍板 A），重导后 ALL 该 date 的旧 runs 失效
  //   原 bug：runFlowImportAsync 仅 clearByDate(flow_imports) 不清 runs/diff_rows → 用户重导
  //   流水后 listSuccessDates 仍显示旧 success run，export:date 按旧 runId 读旧 diff_rows，
  //   而旧 diff_rows 是基于旧流水算出的 → 源换了导出仍是旧数据 → 资金事故
  //
  // 与 Case H（业务OP 重导清单 BU 的 runs）的关键区别：
  //   - Case H：clearRunsAndDiffsByDateBu(date, BU) — 仅清单 BU
  //   - Case P：clearRunsAndDiffsByDate(date) — 清该 date 跨所有 BU（流水级）
  //
  // 步骤：
  //   1) 业务OP 导入 BU-P1 + BU-P2 两个 BU（同 date=2026-07-10 + T-2=2026-07-09）
  //   2) 流水第 1 次导入（含 BU-P1 + BU-P2 两 BU 的流水）
  //   3) 跑两次对账（BU-P1 + BU-P2）→ runs 表有 2 行 success run
  //   4) 流水第 2 次导入（同 date 不同内容，仅含 BU-P1 流水）
  //   5) 验证：runs 表两行 success run 全部消失（按 date 清，不按 BU）
  //   6) 验证：listSuccessDates(BU-P1)=空 / listSuccessDates(BU-P2)=空
  //   7) 验证：旧 runId 在 DB 中不存在 / getDiffRowsByRun(旧 runId) = 空
  // ========================================================================

  // 步 1：业务OP 导入 BU-P1 + BU-P2（T-2=2026-07-09 + T-1=2026-07-10）
  importsRepo.insertRows(db, '2026-07-09', [
    opRow(2, 'BU-P1', 'P101', { begin:0, amount:1000, amountIn:1000, amountOut:0, end:1000 }),
    opRow(3, 'BU-P2', 'P201', { begin:0, amount:2000, amountIn:2000, amountOut:0, end:2000 })
  ]);
  importsRepo.insertRows(db, '2026-07-10', [
    opRow(2, 'BU-P1', 'P101', { begin:1000, amount:100, amountIn:100, amountOut:0, end:1100 }),
    opRow(3, 'BU-P2', 'P201', { begin:2000, amount:200, amountIn:200, amountOut:0, end:2200 })
  ]);

  // 步 2：流水第 1 次导入（含两 BU；BU-P1 +100 / BU-P2 +200）
  flowRepo.insertRows(db, '2026-07-10', [
    flowR(2, 'BU-P1', 'P101', '入', 100),
    flowR(3, 'BU-P2', 'P201', '入', 200)
  ]);

  // 步 3：跑两次对账（BU-P1 + BU-P2），两 run 都应是 success
  const resP_run1 = session.runReconciliation(db, { date:'2026-07-10', buName:'BU-P1' });
  const resP_run2 = session.runReconciliation(db, { date:'2026-07-10', buName:'BU-P2' });
  check('P 步 3 BU-P1 run 落 runId', resP_run1.runId > 0);
  check('P 步 3 BU-P2 run 落 runId', resP_run2.runId > 0);

  const successP_BU1_before = runRepo.listSuccessDates(db, 'BU-P1');
  const successP_BU2_before = runRepo.listSuccessDates(db, 'BU-P2');
  check('P 步 3 listSuccessDates(BU-P1) 含 2026-07-10',
    successP_BU1_before.some(s => s.date === '2026-07-10'));
  check('P 步 3 listSuccessDates(BU-P2) 含 2026-07-10',
    successP_BU2_before.some(s => s.date === '2026-07-10'));

  // 步 4：流水第 2 次导入（同 date=2026-07-10，仅含 BU-P1 一条；模拟用户改了源流水重导）
  const tmpXlsxFlowP = path.join(tmpRoot, 'case-P-flow.xlsx');
  {
    const XLSX = require('xlsx');
    const { FLOW_HEADERS } = require('../../src/backend/biz-op-recon-db/columns');
    function flowRowArrP(bizId, bu, acc, dir, amt) {
      const obj = {};
      FLOW_HEADERS.forEach(h => { obj[h] = ''; });
      obj['BizId'] = bizId;
      obj['业务部门'] = bu;
      obj['出入方向'] = dir;
      obj['账户编号'] = acc;
      obj['对账金额'] = amt;
      obj['币种'] = 'CNY';
      return FLOW_HEADERS.map(h => obj[h]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      FLOW_HEADERS,
      flowRowArrP('FP1', 'BU-P1', 'P101', '入', '999')
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'sheet');
    XLSX.writeFile(wb, tmpXlsxFlowP);
  }
  const { readFlowFile } = require('../../src/backend/biz-op-recon-import/reader');
  const resP_flow2 = await session.runFlowImportAsync(db, {
    date: '2026-07-10',
    filePath: tmpXlsxFlowP,
    readFlowFile,
    writeFlowErrorReportXlsx: writer.writeFlowErrorReportXlsx,
    errorReportsDir: path.join(tmpRoot, 'error-reports')
  });
  check('P 步 4 流水第 2 次 import success', resP_flow2.status === 'success');

  // 步 5：runs 表两行 success run 全部消失（按 date 清，不按 BU）
  const successP_BU1_after = runRepo.listSuccessDates(db, 'BU-P1');
  const successP_BU2_after = runRepo.listSuccessDates(db, 'BU-P2');
  check('P 步 5 listSuccessDates(BU-P1) 不再含 2026-07-10（旧 BU-P1 run 已清）',
    !successP_BU1_after.some(s => s.date === '2026-07-10'),
    '资金红线 P1：流水重导未清 BU-P1 旧 run → export:date 按旧 runId 读旧 diff_rows');
  check('P 步 5 listSuccessDates(BU-P2) 不再含 2026-07-10（旧 BU-P2 run 已清）',
    !successP_BU2_after.some(s => s.date === '2026-07-10'),
    '资金红线 P1：流水重导未清 BU-P2 旧 run → 跨 BU 影响（流水按 date 共用）');

  // 步 6：旧 runId getRunById 应返回 null（runs 表已删）
  const oldRun1 = runRepo.getRunById(db, resP_run1.runId);
  const oldRun2 = runRepo.getRunById(db, resP_run2.runId);
  check('P 步 6 旧 BU-P1 runId 在 runs 表已不存在', oldRun1 === null);
  check('P 步 6 旧 BU-P2 runId 在 runs 表已不存在', oldRun2 === null);

  // 步 7：getDiffRowsByRun(旧 runId) = 空（diff_rows 已先于 runs 删除）
  const oldDiff1 = runRepo.getDiffRowsByRun(db, resP_run1.runId);
  const oldDiff2 = runRepo.getDiffRowsByRun(db, resP_run2.runId);
  check('P 步 7 旧 BU-P1 run 的 diff_rows 已清', oldDiff1.length === 0);
  check('P 步 7 旧 BU-P2 run 的 diff_rows 已清', oldDiff2.length === 0);

  // 清理 P 用例
  importsRepo.clearByDateBu(db, '2026-07-09', 'BU-P1');
  importsRepo.clearByDateBu(db, '2026-07-09', 'BU-P2');
  importsRepo.clearByDateBu(db, '2026-07-10', 'BU-P1');
  importsRepo.clearByDateBu(db, '2026-07-10', 'BU-P2');
  flowRepo.clearByDate(db, '2026-07-10');
  runRepo.clearRunsAndDiffsByDate(db, '2026-07-10');

  // ========================================================================
  // Case Q：业务OP 重导清"下一日 / 同 BU"的旧 runs/diff_rows（资金红线 ⚠️ PR #45 round 4 P1 fix）
  //
  // 背景：业务OP 某日 D 既是 D 当日对账的 T-1（与 D 流水合算），
  //   也是 D+1 对账的 T-2（作为 T-2 期末余额基线）
  //   原 bug：runBizOpImportAsync 仅清 (D, BU) → 留下 (D+1, BU) 旧 run，
  //   listSuccessDates 仍含 D+1 → export:date 按旧 runId 读旧 diff_rows，
  //   而旧 diff_rows 是基于旧 T-2 算出 → 源 T-2 已换，导出仍是旧 T-2 数 → 资金事故
  //
  // 与 Case H（业务OP 重导清单 BU 当日 runs）+ Case P（流水重导跨 BU）的关键区别：
  //   - Case H：clearRunsAndDiffsByDateBu(D, BU) — 清当天同 BU
  //   - Case Q：clearRunsAndDiffsByDateBu(D, BU) + clearRunsAndDiffsByDateBu(D+1, BU) — 清当天 + 下一日同 BU
  //   - Case P：clearRunsAndDiffsByDate(D) — 流水跨 BU 全清
  //
  // 步骤：
  //   1) 业务OP T-2=2026-07-09/BU-A 导入
  //   2) 业务OP T-1=2026-07-10/BU-A 导入
  //   3) 流水 T-1=2026-07-10 导入（仅 BU-A，不影响 Case Q 验证主题）
  //   4) 跑 2026-07-10/BU-A 对账 → 拿 runId
  //   5) 重导 2026-07-09/BU-A 业务OP（同 date 不同内容；模拟用户改源数据）
  //   6) 验证：
  //      a. listSuccessDates(BU-A) 不含 2026-07-10（旧 run 已清）
  //      b. getRunById(旧 runId) === null（runs 表已删）
  //      c. getDiffRowsByRun(旧 runId).length === 0（diff_rows 已先于 runs 删）
  //      d. addOneDay helper 单元正确：'2026-07-09' → '2026-07-10' / 月末跨月 / 闰年
  // ========================================================================

  // helper 单元测试（Q 步 0：addOneDay 4 条边界）
  check('Q0a addOneDay 普通日', session.addOneDay('2026-07-09') === '2026-07-10');
  check('Q0b addOneDay 月末跨月', session.addOneDay('2026-05-31') === '2026-06-01');
  check('Q0c addOneDay 年末跨年', session.addOneDay('2025-12-31') === '2026-01-01');
  check('Q0d addOneDay 闰年 2-29', session.addOneDay('2024-02-29') === '2024-03-01');

  // 步 1+2：业务OP T-2 + T-1 导入（BU-A 单 BU；与 Case A 完全无干扰：用 2026-07-09/10 + BU-Q）
  // 注：避开 BU-A 防与前置 case 相互污染（Case G 也用 BU-A 但 date 不同，仍稳妥换 BU-Q）
  importsRepo.insertRows(db, '2026-07-09', [
    opRow(2, 'BU-Q', 'Q001', { begin:0, amount:1000, amountIn:1000, amountOut:0, end:1000 })
  ]);
  importsRepo.insertRows(db, '2026-07-10', [
    opRow(2, 'BU-Q', 'Q001', { begin:1000, amount:100, amountIn:100, amountOut:0, end:1100 })
  ]);

  // 步 3：流水 T-1 导入（BU-Q +100 → 计算 T-1 = 1000+100 = 1100 ≈ 实际 1100 → 无差异）
  flowRepo.insertRows(db, '2026-07-10', [
    flowR(2, 'BU-Q', 'Q001', '入', 100)
  ]);

  // 步 4：跑 2026-07-10/BU-Q 对账 → 拿 runId
  const resQ_run = session.runReconciliation(db, { date:'2026-07-10', buName:'BU-Q' });
  check('Q 步 4 BU-Q 2026-07-10 run 落 runId', resQ_run.runId > 0);

  // 验证旧 run 状态（前置：listSuccessDates 应含 2026-07-10）
  const successQ_before = runRepo.listSuccessDates(db, 'BU-Q');
  check('Q 步 4 listSuccessDates(BU-Q) 含 2026-07-10（前置）',
    successQ_before.some(s => s.date === '2026-07-10'));

  // 步 5：重导 2026-07-09/BU-Q 业务OP（同 date 不同内容 → 模拟用户重导 T-2 源数据）
  const tmpXlsxQ = path.join(tmpRoot, 'case-Q-bizop.xlsx');
  {
    const XLSX = require('xlsx');
    const { BIZ_OP_HEADERS } = require('../../src/backend/biz-op-recon-db/columns');
    function rowArrQ(bu, acc, begin, amt, amtIn, amtOut, end) {
      const obj = {
        'Billdate': '', '业务方': bu, '客户编号': '', '主体': '', '账户号': acc,
        '账户类型': '', '币种': 'CNY', '期初余额': begin, '发生额': amt,
        '发生额（入）': amtIn, '发生额（出）': amtOut, '期末余额': end,
        '期末可用余额': '', '期末冻结余额': '', '最近更新时间': '', '通道': '',
        'ppCardId': '', '银行卡号': '', '扩展信息': '', '账户状态': '',
        'BizId': '', '清结算系统创建时间': '', '清结算系统更新时间': ''
      };
      return BIZ_OP_HEADERS.map(h => obj[h]);
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      BIZ_OP_HEADERS,
      // 重导：T-2 期末改为 2000（与原 1000 不同 → 源换了）
      rowArrQ('BU-Q', 'Q001', 1000, 1000, 1000, 0, 2000)
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'sheet');
    XLSX.writeFile(wb, tmpXlsxQ);
  }
  const resQ_reimport = await session.runBizOpImportAsync(db, {
    date: '2026-07-09',
    filePath: tmpXlsxQ,
    readBizOpFile,
    writeBizOpErrorReportXlsx: writer.writeBizOpErrorReportXlsx,
    errorReportsDir: path.join(tmpRoot, 'error-reports')
  });
  check('Q 步 5 业务OP 重导 success', resQ_reimport.status === 'success');

  // 步 6.a：listSuccessDates(BU-Q) 不再含 2026-07-10（旧 run 已清）— 资金红线核心验证
  const successQ_after = runRepo.listSuccessDates(db, 'BU-Q');
  check('Q 步 6a listSuccessDates(BU-Q) 不再含 2026-07-10（下一日旧 run 已清）',
    !successQ_after.some(s => s.date === '2026-07-10'),
    '资金红线 P1：业务OP 重导未清下一日旧 run → export:date 按旧 runId 导出基于旧 T-2 算的差异');

  // 步 6.b：getRunById(旧 runId) === null
  const oldRunQ = runRepo.getRunById(db, resQ_run.runId);
  check('Q 步 6b 旧 BU-Q 2026-07-10 runId 在 runs 表已不存在', oldRunQ === null);

  // 步 6.c：getDiffRowsByRun(旧 runId) === []
  const oldDiffQ = runRepo.getDiffRowsByRun(db, resQ_run.runId);
  check('Q 步 6c 旧 BU-Q 2026-07-10 run 的 diff_rows 已清', oldDiffQ.length === 0);

  // 清理 Q 用例
  importsRepo.clearByDateBu(db, '2026-07-09', 'BU-Q');
  importsRepo.clearByDateBu(db, '2026-07-10', 'BU-Q');
  flowRepo.clearByDate(db, '2026-07-10');
  runRepo.clearRunsAndDiffsByDate(db, '2026-07-10');

  // 清理
  if (db && typeof db.close === 'function') db.close();
  fs.unlinkSync(tmpDb);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`[biz-op-recon] ${count}/${count} smoke tests passed`);
}

module.exports = {
  runBizOpReconSmokeTests
};
