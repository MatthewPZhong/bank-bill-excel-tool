// v2.1.10 N4-cont-1 Phase 4 集成测试（T28）
//
// 覆盖（PRD §1.3 + spec §七 ≥ 3 case ≥ 15 断言）：
//   case 1: idle 触发后差异行 raw_json 完整 + 对账成功老行 raw_json 已清
//     1.1 差异行（在 diff_rows 中）raw_json 全部保留 — writer.js:184 重导差异 xlsx 不丢字段
//     1.2 对账成功老行（imported_at < 7 天前 + 不在 diff_rows）raw_json 全清
//     1.3 对账成功新行（imported_at ≥ 7 天内）raw_json 保留
//     1.4 idle cleanup 完成后 clearedCount 与 SQL 实际 UPDATE 行数一致
//
//   case 2: settings retention_days 调整生效（1 / 7 默认 / 30 / 范围外回退）
//     2.1 retention_days=1 → 老于 1 天的行全清；新于 1 天保留
//     2.2 retention_days=30 → 30 天前才清；29 天的行保留
//     2.3 retention_days=7（默认）→ 7 天边界正确（8 天清，6 天保留）
//     2.4 settings 范围外 0 → getter 回退默认 7 → 行为按 7 天
//     2.5 settings 范围外 31 → getter 回退默认 7 → 行为按 7 天
//
//   case 3: failure graceful + activity log
//     3.1 模拟 DROP diff_rows 表 → clearStaleSuccessfulRawJson throw
//     3.2 函数 throw 后差异行 raw_json 必须全保留（资金红线 fail-safe）
//     3.3 整体集成调用方（仿 main.js setupIdleCleanupTimer 回调）try/catch 捕获后流程继续
//
// 跑：node scripts/integration/v2.1.10-n4-cont-1-phase4.js
// 期望：N/N PASS（≥ 15 断言）

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const {
  clearStaleSuccessfulRawJson,
} = require('../../src/backend/acquiring-bill-currency-db/raw-json-retention');
const settingsRepo = require('../../src/backend/database/settings-repository');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++;
  failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++;
  failures.push({ label, actual: cond, expected: true });
}

// === Fixture：建临时 DB + 含 bill_imports + runs + diff_rows ===
function setupTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-cont-1-phase4-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  return { appDb, dir, dbPath };
}

function teardown({ appDb, dir }) {
  try { appDb.db.close(); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
}

function nowMinusDays(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function insertBill(db, { id, reconId, raw, importedAt, monthKey = '2026-04' }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports
      (id, month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, 'fix.xlsx', ?, ?, 'USD', 'usd', ?, ?)
  `).run(id, monthKey, id, reconId, raw, importedAt);
}

function insertRun(db, { id, monthKey = '2026-04' }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_runs (id, month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
    VALUES (?, ?, 0, 0, 0, 0, 'complete')
  `).run(id, monthKey);
}

function insertDiff(db, { runId, billImportId }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_diff_rows
      (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    VALUES (?, ?, 'EUR', '100', 'currency-mismatch')
  `).run(runId, billImportId);
}

// ============================================================
// case 1: idle 触发后差异行 raw_json 完整 + 对账成功老行 raw_json 已清
// ============================================================
async function case1_idleCleanupRespectsDiffRows() {
  const ctx = setupTempDb();
  try {
    // fixture: 100 行 bill — 30 老于 7 天 + 70 新于 7 天；前 20 行（混含老新）进 diff_rows
    const old = nowMinusDays(10);
    const recent = nowMinusDays(3);
    for (let i = 1; i <= 30; i++) {
      insertBill(ctx.appDb.db, { id: i, reconId: `R-${i}`, raw: `{"i":${i}}`, importedAt: old });
    }
    for (let i = 31; i <= 100; i++) {
      insertBill(ctx.appDb.db, { id: i, reconId: `R-${i}`, raw: `{"i":${i}}`, importedAt: recent });
    }
    insertRun(ctx.appDb.db, { id: 1 });
    // 20 行差异（id 1-10 老 + id 31-40 新）— 含老有新交叉
    for (let i = 1; i <= 10; i++) insertDiff(ctx.appDb.db, { runId: 1, billImportId: i });
    for (let i = 31; i <= 40; i++) insertDiff(ctx.appDb.db, { runId: 1, billImportId: i });

    // 调用清理（默认 retentionDays=7）
    const retentionDays = ctx.appDb.getAcquiringBillRawJsonRetentionDays();
    assertEq(retentionDays, 7, 'case 1.0: getter 返回默认 7');

    const result = clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays });

    // 1.1: 差异行（id 1-10 + 31-40）raw_json 必须全部保留
    const diffKept = ctx.appDb.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id IN (SELECT bill_import_id FROM acquiring_bill_currency_diff_rows)
        AND raw_json != ''
    `).get().c;
    assertEq(diffKept, 20, 'case 1.1: 差异行（20 行）raw_json 全部保留 — 资金红线');

    // 1.2: 对账成功 + 老于 7 天行 raw_json 全清（id 11-30，20 行）
    const oldSuccessCleared = ctx.appDb.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE raw_json = ''
        AND imported_at < datetime('now', '-7 days')
        AND id NOT IN (SELECT bill_import_id FROM acquiring_bill_currency_diff_rows)
    `).get().c;
    assertEq(oldSuccessCleared, 20, 'case 1.2: 对账成功老行 raw_json 全清（sentinel \'\'；20 行）');

    // 1.3: 对账成功 + 新于 7 天行 raw_json 保留（id 41-100，60 行）
    const newSuccessKept = ctx.appDb.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE raw_json != ''
        AND imported_at >= datetime('now', '-7 days')
        AND id NOT IN (SELECT bill_import_id FROM acquiring_bill_currency_diff_rows)
    `).get().c;
    assertEq(newSuccessKept, 60, 'case 1.3: 对账成功新行 raw_json 保留（60 行）');

    // 1.4: clearedCount 与实际 UPDATE 行数一致（应该是 20）
    assertEq(result.clearedCount, 20, 'case 1.4: clearedCount 与实际 UPDATE 一致');
    assertTrue(result.elapsedMs >= 0, 'case 1.4b: elapsedMs ≥ 0');
  } finally {
    teardown(ctx);
  }
}

// ============================================================
// case 2: settings retention_days 调整生效
// ============================================================
async function case2_retentionDaysAdjustable() {
  // 2.1: retention=1 — 老于 1 天的清；新于 1 天保留
  {
    const ctx = setupTempDb();
    try {
      insertBill(ctx.appDb.db, { id: 1, reconId: 'A', raw: '{}', importedAt: nowMinusDays(2) });  // 老
      insertBill(ctx.appDb.db, { id: 2, reconId: 'B', raw: '{}', importedAt: nowMinusDays(0.5) }); // 新（12h 前）
      settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.appDb.db, 1);
      const days = ctx.appDb.getAcquiringBillRawJsonRetentionDays();
      assertEq(days, 1, 'case 2.1a: retention=1 生效');
      const r = clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays: days });
      assertEq(r.clearedCount, 1, 'case 2.1b: 2 天前清，0.5 天前保留 → clearedCount=1');
      const a = ctx.appDb.db.prepare('SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE id=1').get();
      const b = ctx.appDb.db.prepare('SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE id=2').get();
      assertEq(a.raw_json, '', 'case 2.1c: id=1 已清（sentinel = \'\')');
      assertEq(b.raw_json, '{}', 'case 2.1d: id=2 保留');
    } finally {
      teardown(ctx);
    }
  }

  // 2.2: retention=30 — 29 天前保留；31 天前清
  {
    const ctx = setupTempDb();
    try {
      insertBill(ctx.appDb.db, { id: 1, reconId: 'A', raw: '{}', importedAt: nowMinusDays(29) });
      insertBill(ctx.appDb.db, { id: 2, reconId: 'B', raw: '{}', importedAt: nowMinusDays(31) });
      settingsRepo.setAcquiringBillRawJsonRetentionDays(ctx.appDb.db, 30);
      const days = ctx.appDb.getAcquiringBillRawJsonRetentionDays();
      assertEq(days, 30, 'case 2.2a: retention=30 生效');
      const r = clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays: days });
      assertEq(r.clearedCount, 1, 'case 2.2b: 31 天清，29 天保留');
    } finally {
      teardown(ctx);
    }
  }

  // 2.3: retention=7（默认）— 8 天清，6 天保留
  {
    const ctx = setupTempDb();
    try {
      insertBill(ctx.appDb.db, { id: 1, reconId: 'A', raw: '{}', importedAt: nowMinusDays(8) });
      insertBill(ctx.appDb.db, { id: 2, reconId: 'B', raw: '{}', importedAt: nowMinusDays(6) });
      const days = ctx.appDb.getAcquiringBillRawJsonRetentionDays();
      assertEq(days, 7, 'case 2.3a: 默认 retention=7');
      const r = clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays: days });
      assertEq(r.clearedCount, 1, 'case 2.3b: 8 天清，6 天保留');
    } finally {
      teardown(ctx);
    }
  }

  // 2.4: sqlite UPDATE 写非法值 0 → getter 回退 7 → 行为按 7 天
  {
    const ctx = setupTempDb();
    try {
      insertBill(ctx.appDb.db, { id: 1, reconId: 'A', raw: '{}', importedAt: nowMinusDays(8) });
      insertBill(ctx.appDb.db, { id: 2, reconId: 'B', raw: '{}', importedAt: nowMinusDays(6) });
      // 用 setSetting 绕过 setter 校验直接写 '0'（< MIN=1）
      settingsRepo.setSetting(ctx.appDb.db, 'acquiring_bill_raw_json_retention_days', '0');
      const days = ctx.appDb.getAcquiringBillRawJsonRetentionDays();
      assertEq(days, 7, 'case 2.4a: sqlite UPDATE 0 → getter 回退默认 7（资金红线兜底）');
      const r = clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays: days });
      assertEq(r.clearedCount, 1, 'case 2.4b: 用回退 7 → 8 天清');
    } finally {
      teardown(ctx);
    }
  }

  // 2.5: sqlite UPDATE 写非法值 31 → getter 回退 7
  {
    const ctx = setupTempDb();
    try {
      insertBill(ctx.appDb.db, { id: 1, reconId: 'A', raw: '{}', importedAt: nowMinusDays(8) });
      settingsRepo.setSetting(ctx.appDb.db, 'acquiring_bill_raw_json_retention_days', '31');
      const days = ctx.appDb.getAcquiringBillRawJsonRetentionDays();
      assertEq(days, 7, 'case 2.5a: sqlite UPDATE 31 → getter 回退默认 7');
    } finally {
      teardown(ctx);
    }
  }
}

// ============================================================
// case 3: failure graceful + activity log
// ============================================================
async function case3_failureGraceful() {
  const ctx = setupTempDb();
  try {
    // fixture: 10 bill 全部老于 7 天 + 5 行进 diff_rows
    for (let i = 1; i <= 10; i++) {
      insertBill(ctx.appDb.db, { id: i, reconId: `R-${i}`, raw: `{"i":${i}}`, importedAt: nowMinusDays(30) });
    }
    insertRun(ctx.appDb.db, { id: 1 });
    for (let i = 1; i <= 5; i++) insertDiff(ctx.appDb.db, { runId: 1, billImportId: i });

    // 验证 baseline：raw_json 全部 IS NOT NULL
    const beforeKept = ctx.appDb.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json != ''"
    ).get().c;
    assertEq(beforeKept, 10, 'case 3.0: baseline 10 行 raw_json 全保留');

    // 3.1: 人为破坏 — DROP diff_rows 表
    ctx.appDb.db.exec('DROP TABLE acquiring_bill_currency_diff_rows');

    // 3.2: clearStaleSuccessfulRawJson 必须 throw（NOT IN 子查询找不到表）
    let thrownErr = null;
    try {
      clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays: 7 });
    } catch (err) {
      thrownErr = err;
    }
    assertTrue(thrownErr !== null, 'case 3.1: DROP diff_rows 后函数必须 throw');
    assertTrue(/no such table/i.test(thrownErr && thrownErr.message || ''), 'case 3.2: 错误信息含 "no such table"');

    // 3.3: 函数 throw 后 raw_json 必须全部保留（资金红线 fail-safe）
    const afterKept = ctx.appDb.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json != ''"
    ).get().c;
    assertEq(afterKept, 10, 'case 3.3: 🔴 资金红线 — throw 后 raw_json 必须全部保留（绝无误清）');

    // 3.4: 仿 main.js setupIdleCleanupTimer 回调 — 包外层 try/catch 验证调用方流程不崩
    let outerCaught = null;
    let outerFlowContinued = false;
    try {
      try {
        clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays: 7 });
      } catch (rawJsonErr) {
        // main.js T24 集成范式：捕获 + 仅记日志 + 不阻塞
        outerCaught = rawJsonErr;
      }
      // 模拟主 cleanup 后续仍可执行
      outerFlowContinued = true;
    } catch (err) {
      // 不应进这里
    }
    assertTrue(outerCaught !== null, 'case 3.4a: 集成 try/catch 捕获到错误');
    assertTrue(outerFlowContinued, 'case 3.4b: 集成调用方流程不阻塞，仍能继续');
  } finally {
    teardown(ctx);
  }
}

// ============================================================
// case 4: v0.5 (Round 3 F1) — partial run 整月保护 + resume 后可清的端到端
//   触发场景：chunked run 跑到 chunk M/N → cancel → chunk_progress.status='partial'
//   验证：clearStaleSuccessfulRawJson 跳过整月 bill；resume → status='complete' → 非差异行可被清
// ============================================================
async function case4_partialRunIntegralProtection() {
  const ctx = setupTempDb();
  try {
    // fixture: 100 行 bill 全 imported_at = 10 天前 + month_key='2026-03'
    //   30 行进 diff_rows + run.chunk_progress = partial
    const old = nowMinusDays(10);
    for (let i = 1; i <= 100; i++) {
      insertBill(ctx.appDb.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.appDb.db, { id: 1, monthKey: '2026-03' });
    for (let i = 1; i <= 30; i++) insertDiff(ctx.appDb.db, { runId: 1, billImportId: i });

    // 写 partial chunk_progress（模拟 chunked cancel）
    const partialProgress = JSON.stringify({ lastCompletedChunkIndex: 1, totalChunks: 3, status: 'partial' });
    ctx.appDb.db.prepare('UPDATE acquiring_bill_currency_runs SET chunk_progress = ? WHERE id = 1').run(partialProgress);

    // 4.1: clearStaleSuccessfulRawJson 跳过整月 — clearedCount=0
    const r1 = clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays: 1 });
    assertEq(r1.clearedCount, 0,
      'case 4.1: 🟠 v0.5 partial run 整月排除 → clearedCount=0（端到端：N4-cont-1 SQL × A4 chunked partial run）');

    // 4.2: 差异行 + 非差异行 raw_json 均保留
    const keptAfterPartial = ctx.appDb.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key='2026-03' AND raw_json != ''"
    ).get().c;
    assertEq(keptAfterPartial, 100, 'case 4.2: partial 状态下 100 行 raw_json 全保留');

    // 4.3: 模拟 resume 完成 → chunk_progress.status='complete'
    const completeProgress = JSON.stringify({ lastCompletedChunkIndex: 2, totalChunks: 3, status: 'complete' });
    ctx.appDb.db.prepare('UPDATE acquiring_bill_currency_runs SET chunk_progress = ? WHERE id = 1').run(completeProgress);

    const r2 = clearStaleSuccessfulRawJson(ctx.appDb.db, { retentionDays: 1 });
    assertEq(r2.clearedCount, 70,
      'case 4.3: resume → complete 后 → 70 非差异行被清（partial month 守卫解除）');

    // 4.4: 差异行 raw_json 仍保留（NOT IN diff_rows 守卫）
    const diffKept = ctx.appDb.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id IN (SELECT bill_import_id FROM acquiring_bill_currency_diff_rows)
        AND raw_json != ''
    `).get().c;
    assertEq(diffKept, 30, 'case 4.4: resume 完成后差异行 raw_json 仍保留（NOT IN diff_rows 守卫不变）');

    // 4.5: 非差异行 raw_json 已清
    const nonDiffCleared = ctx.appDb.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id NOT IN (SELECT bill_import_id FROM acquiring_bill_currency_diff_rows)
        AND raw_json = ''
    `).get().c;
    assertEq(nonDiffCleared, 70, 'case 4.5: 非差异行 raw_json 已清（sentinel = \'\')');
  } finally {
    teardown(ctx);
  }
}

// === 执行 ===
(async () => {
  await case1_idleCleanupRespectsDiffRows();
  await case2_retentionDaysAdjustable();
  await case3_failureGraceful();
  await case4_partialRunIntegralProtection();

  const total = passed + failed;
  console.log(`[v2.1.10-n4-cont-1-phase4] ${passed}/${total} PASS`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.label}`);
      console.log(`    actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    }
    process.exit(1);
  }
})().catch((err) => {
  console.error('integration test crashed:', err);
  process.exit(2);
});
