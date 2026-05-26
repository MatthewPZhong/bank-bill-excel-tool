// v2.1.8 N1' idle 触发集成验证脚本
//   目标：在脚本环境下模拟 setupIdleCleanupTimer 触发的完整链路（无需真 30min 等待 + 无 mainWindow / mutex 依赖）
//   覆盖：
//     1. idle 阈值判定逻辑（lastUserActivityTs + IDLE_CLEANUP_MS）
//     2. listPendingCleanupRuns 找 cleanup_pending=1 的 run
//     3. cleanupAfterRunBackground (includeDiff=false 默认) 仅清 flow
//     4. clearCleanupPending 完成后标志位归零
//     5. bill_imports + diff_rows + runs 保留（FK 约束 + 业务保留语义）
//
// 用法：node scripts/test-v2.1.8-n1-idle.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/acquiring-bill-currency-session');
const runRepo = require('../../src/backend/acquiring-bill-currency-db/run-repository');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../src/backend/acquiring-bill-currency-db/columns');

// 与 main.js setupIdleCleanupTimer 保持同一值（spec v0.10 §3.2.2 N1''-D8）
const IDLE_CLEANUP_MS = 30 * 60 * 1000;

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

function setupTmpDb() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'n1-idle-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();
  const cleanup = () => {
    try { db.db.close(); } catch (_e) { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  };
  return { tmpdir, dbPath, db, cleanup };
}

// 模拟 main.js setupIdleCleanupTimer 触发的核心步骤（无 mainWindow / mutex 依赖）
//   - 判定 idle 达标
//   - 查 cleanup_pending=1 runs
//   - 串行调 cleanupAfterRunBackground（includeDiff=false 默认）
//   - 完成后 clearCleanupPending
//   返回 { triggered, pendingCount, cleanedCount }
async function simulateIdleTrigger(db, lastUserActivityTs) {
  const now = Date.now();
  const elapsed = now - lastUserActivityTs;
  if (elapsed < IDLE_CLEANUP_MS) {
    return { triggered: false, reason: 'not-idle-yet', elapsed };
  }
  const pendingRuns = runRepo.listPendingCleanupRuns(db);
  if (!pendingRuns || pendingRuns.length === 0) {
    return { triggered: false, reason: 'no-pending', pendingCount: 0 };
  }
  let cleanedCount = 0;
  for (const run of pendingRuns) {
    await session.cleanupAfterRunBackground({
      db,
      monthKey: run.month_key,
      runId: run.id
      // includeDiff 默认 false → 仅清 flow_imports
    });
    runRepo.clearCleanupPending(db, { runId: run.id });
    cleanedCount++;
  }
  return { triggered: true, pendingCount: pendingRuns.length, cleanedCount };
}

async function run() {
  console.log('==== v2.1.8 N1\' idle 触发集成验证 ====');

  const { tmpdir, db, cleanup } = setupTmpDb();
  try {
    // ============================================================
    // Step 1：准备数据 + 跑 runCheck（runCheck 内部会 markCleanupPending=1）
    // ============================================================
    const date = '2026-04-15';
    const flowFile = path.join(tmpdir, 'flow.xlsx');
    const billFile = path.join(tmpdir, 'bill.xlsx');

    function makeFlow(id, currency) {
      const r = new Array(48).fill('');
      r[0] = date; r[6] = id; r[12] = '100'; r[13] = currency; r[28] = '100'; r[29] = currency;
      return r;
    }
    function makeBill(id, currency) {
      const r = new Array(26).fill('');
      r[0] = date; r[14] = id; r[18] = '100'; r[19] = currency;
      return r;
    }
    await writeXlsx(flowFile, FLOW_HEADERS, [makeFlow('I1', 'USD'), makeFlow('I2', 'USD')]);
    await writeXlsx(billFile, BILL_HEADERS, [makeBill('I1', 'USD'), makeBill('I2', 'EUR')]);  // I2 币种差异

    await session.importFlowFiles({ db: db.db, monthKey: '2026-04', filePaths: [flowFile] });
    await session.importBillFiles({ db: db.db, monthKey: '2026-04', filePaths: [billFile] });

    const r = await session.runCheck({ db: db.db, monthKey: '2026-04', storageRoot: tmpdir });
    assertTrue(!!r.runId, 'Step1.runCheck 返回 runId');

    // 验证 runCheck 后 cleanup_pending=1
    const runRow = db.db.prepare(`SELECT cleanup_pending FROM acquiring_bill_currency_runs WHERE id = ?`).get(r.runId);
    assertEq(runRow.cleanup_pending, 1, 'Step1.runCheck 后 cleanup_pending=1');

    // 验证 import 数据 + diff 数据都还在
    const flowCount0 = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports').get().c;
    const billCount0 = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports').get().c;
    const diffCount0 = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assertEq(flowCount0, 2, 'Step1.flow_imports=2');
    assertEq(billCount0, 2, 'Step1.bill_imports=2');
    assertEq(diffCount0, 1, 'Step1.diff_rows=1');

    // ============================================================
    // Step 2：idle 还没达标 → 不触发
    // ============================================================
    const recentTs = Date.now() - (IDLE_CLEANUP_MS - 1000);  // 比阈值少 1 秒
    const result2 = await simulateIdleTrigger(db.db, recentTs);
    assertEq(result2.triggered, false, 'Step2.idle 未达标 → triggered=false');
    assertEq(result2.reason, 'not-idle-yet', 'Step2.reason=not-idle-yet');

    // 数据应保持不变
    const flowCount1 = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports').get().c;
    assertEq(flowCount1, 2, 'Step2.flow_imports 仍未清');

    // ============================================================
    // Step 3：idle 达标 → 触发 cleanup
    // ============================================================
    const oldTs = Date.now() - IDLE_CLEANUP_MS - 5000;  // 超阈值 5 秒
    const result3 = await simulateIdleTrigger(db.db, oldTs);
    assertEq(result3.triggered, true, 'Step3.idle 达标 → triggered=true');
    assertEq(result3.pendingCount, 1, 'Step3.pendingCount=1');
    assertEq(result3.cleanedCount, 1, 'Step3.cleanedCount=1');

    // ============================================================
    // Step 4：验证 cleanup 后状态
    //   - flow_imports 清掉
    //   - bill_imports 保留（FK 约束 + 业务保留语义）
    //   - diff_rows 保留（有效输出，spec §3.2.1 N1''-D1）
    //   - runs 保留（diff 元数据，spec §3.2.1 N1''-D3）
    //   - cleanup_pending 归零（spec N1''-D7 标志位幂等）
    // ============================================================
    const flowCount2 = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports').get().c;
    const billCount2 = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports').get().c;
    const diffCount2 = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    const runsCount2 = db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_runs').get().c;
    assertEq(flowCount2, 0, 'Step4.flow_imports 已清（idle 触发默认 includeDiff=false 仅清 flow）');
    assertEq(billCount2, 2, 'Step4.bill_imports 保留（FK 约束）');
    assertEq(diffCount2, 1, 'Step4.diff_rows 保留（有效输出）');
    assertEq(runsCount2, 1, 'Step4.runs 保留（diff 元数据）');

    const cleanupPending = db.db.prepare(`SELECT cleanup_pending FROM acquiring_bill_currency_runs WHERE id = ?`).get(r.runId);
    assertEq(cleanupPending.cleanup_pending, 0, 'Step4.cleanup_pending=0 (clearCleanupPending OK)');

    // ============================================================
    // Step 5：第二次 idle 触发 → 无 pending → 不再触发
    // ============================================================
    const result5 = await simulateIdleTrigger(db.db, oldTs);
    assertEq(result5.triggered, false, 'Step5.second idle → triggered=false (no pending)');
    assertEq(result5.reason, 'no-pending', 'Step5.reason=no-pending');
  } finally {
    cleanup();
  }

  // ============================================================
  // Step 6（SR3 强化）：多 run 累积串行清（spec §3.2.1 N1''-D4）
  //   模拟用户连续跑多个月 runCheck，全部 cleanup_pending=1，idle 触发后按 listPendingCleanupRuns 顺序串行清
  // ============================================================
  const { tmpdir: m6tmpdir, db: m6db, cleanup: m6cleanup } = setupTmpDb();
  try {
    const months = ['2026-01', '2026-02', '2026-03'];
    for (const monthKey of months) {
      const date = `${monthKey}-15`;
      const ff = path.join(m6tmpdir, `flow-${monthKey}.xlsx`);
      const bf = path.join(m6tmpdir, `bill-${monthKey}.xlsx`);
      function makeFlow(id, currency) {
        const r = new Array(48).fill(''); r[0]=date; r[6]=id; r[12]='50'; r[13]=currency; r[28]='50'; r[29]=currency; return r;
      }
      function makeBill(id, currency) {
        const r = new Array(26).fill(''); r[0]=date; r[14]=id; r[18]='50'; r[19]=currency; return r;
      }
      await writeXlsx(ff, FLOW_HEADERS, [makeFlow(`${monthKey}-A`, 'USD')]);
      await writeXlsx(bf, BILL_HEADERS, [makeBill(`${monthKey}-A`, 'EUR')]); // 币种差异
      await session.importFlowFiles({ db: m6db.db, monthKey, filePaths: [ff] });
      await session.importBillFiles({ db: m6db.db, monthKey, filePaths: [bf] });
      await session.runCheck({ db: m6db.db, monthKey, storageRoot: m6tmpdir });
    }

    // 3 个 run 全部 cleanup_pending=1
    const pendingCount = m6db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_runs WHERE cleanup_pending=1`).get().c;
    assertEq(pendingCount, 3, 'Step6.3 个 run 全部 cleanup_pending=1');

    // 单次 idle 触发应一次性串行清完所有
    const result6 = await simulateIdleTrigger(m6db.db, Date.now() - IDLE_CLEANUP_MS - 5000);
    assertEq(result6.triggered, true, 'Step6.idle 达标 → 触发');
    assertEq(result6.pendingCount, 3, 'Step6.pendingCount=3（串行清 3 run）');
    assertEq(result6.cleanedCount, 3, 'Step6.cleanedCount=3');

    // 所有 run 的 cleanup_pending 都应归零
    const pendingAfter = m6db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_runs WHERE cleanup_pending=1`).get().c;
    assertEq(pendingAfter, 0, 'Step6.所有 cleanup_pending 归零');

    // 3 个月 flow 全清，bill/diff/runs 全保留
    const flowM6 = m6db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports`).get().c;
    const billM6 = m6db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports`).get().c;
    const diffM6 = m6db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows`).get().c;
    const runsM6 = m6db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_runs`).get().c;
    assertEq(flowM6, 0, 'Step6.全 3 月 flow 清完');
    assertEq(billM6, 3, 'Step6.3 月 bill 全保留');
    assertEq(diffM6, 3, 'Step6.3 月 diff 全保留');
    assertEq(runsM6, 3, 'Step6.3 月 runs 全保留');
  } finally {
    m6cleanup();
  }

  // ============================================================
  // Step 7（SR3 强化）：cleanupOrphanData Phase 2 多 monthKey 孤儿 run FK 边界
  //   模拟 2 个不同 monthKey 的孤儿 run（status='running'）；Phase 2 顺序清 diff → bill → flow
  //   验证：FK 约束下两个 monthKey 都能成功清完不报错
  // ============================================================
  const { tmpdir: m7tmpdir, db: m7db, cleanup: m7cleanup } = setupTmpDb();
  try {
    const now = new Date().toISOString();
    // 2 个孤儿 run（不同 monthKey）
    for (const monthKey of ['2026-04', '2026-05']) {
      const insert = m7db.db.prepare(`
        INSERT INTO acquiring_bill_currency_runs
        (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
        VALUES (?, ?, 5, 3, 2, 0, 'running')
      `).run(monthKey, now);
      const runId = Number(insert.lastInsertRowid);
      // 关联 bill（2 行）
      for (let i = 0; i < 2; i++) {
        m7db.db.prepare(`
          INSERT INTO acquiring_bill_currency_bill_imports
          (month_key, recon_main_id, settle_currency, settle_currency_norm, raw_json, source_file, source_row_index, imported_at)
          VALUES (?, ?, 'EUR', 'eur', '{}', 'fake.xlsx', ?, ?)
        `).run(monthKey, `ORPHAN-${monthKey}-${i}`, i + 2, now);
      }
      const billIds = m7db.db.prepare(`SELECT id FROM acquiring_bill_currency_bill_imports WHERE month_key=?`).all(monthKey);
      // 关联 diff（每个 bill 1 行 diff）
      for (const b of billIds) {
        m7db.db.prepare(`
          INSERT INTO acquiring_bill_currency_diff_rows (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
          VALUES (?, ?, 'USD', '100', 'currency_mismatch')
        `).run(runId, b.id);
      }
      // 关联 flow（1 行）
      m7db.db.prepare(`
        INSERT INTO acquiring_bill_currency_flow_imports
        (month_key, recon_main_id, settle_currency, settle_currency_norm, settle_amount, settle_amount_abs, raw_json, source_file, source_row_index, imported_at)
        VALUES (?, 'O', 'USD', 'usd', '100', '100', '{}', 'fake.xlsx', 2, ?)
      `).run(monthKey, now);
    }

    const before = {
      runs: m7db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_runs`).get().c,
      bill: m7db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports`).get().c,
      diff: m7db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows`).get().c,
      flow: m7db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_flow_imports`).get().c
    };
    assertEq(before.runs, 2, 'Step7.before runs=2');
    assertEq(before.bill, 4, 'Step7.before bill=4');
    assertEq(before.diff, 4, 'Step7.before diff=4');
    assertEq(before.flow, 2, 'Step7.before flow=2');

    // cleanupOrphanData Phase 2 应顺序清 diff → bill → flow（不抛 FK 错）
    const stats = await session.cleanupOrphanData({ db: m7db.db });
    assertEq(stats.orphanRunIds.length, 2, 'Step7.识别 2 orphan runs');
    assertEq(stats.deletedDiff, 4, 'Step7.deletedDiff=4（每 run 2 diff）');
    assertEq(stats.deletedBill, 4, 'Step7.deletedBill=4');
    assertEq(stats.deletedFlow, 2, 'Step7.deletedFlow=2');
    assertEq(stats.deletedRuns, 2, 'Step7.deletedRuns=2（孤儿 run 元数据删除）');

    const after = {
      runs: m7db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_runs`).get().c,
      bill: m7db.db.prepare(`SELECT COUNT(*) c FROM acquiring_bill_currency_bill_imports`).get().c
    };
    assertEq(after.runs, 0, 'Step7.runs 全清');
    assertEq(after.bill, 0, 'Step7.bill 全清（FK 解开顺序正确）');
  } finally {
    m7cleanup();
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
