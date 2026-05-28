// v2.1.10 N4-cont-1 T23 (Phase 4)：raw_json idle 自动清理函数 unit test
//
// v0.6 (2026-05-28 SR-FIX-1 Round 4 F1)：partial → IN ('partial', 'in-progress')
//   原因：Codex Round 3 复审指出 Round 3 修复只覆盖 partial；first-chunk crash 残留的 in-progress 没被守卫排除
//   修复：SQL `IN ('partial', 'in-progress')`；加 Case 12-13 覆盖 in-progress month 排除
//
// v0.5 (2026-05-28 SR-FIX-1 Round 3 F1)：partial run 守卫
//   原因：Codex review 指出 chunked run 半途 cancel/crash 后，"后续 bill rows"未进 diff_rows
//     如 idle cleanup 此时跑会清掉这些"未来差异行"的 raw_json → resume 后 writer 输出 broken
//   修复：SQL 加 month_key NOT IN partial-run-months 子查询；fixture 加 chunk_progress 列 + 加 Case 9-10 覆盖
//
// v0.3 (2026-05-28): sentinel 从 NULL 改 ''（spec §4.2 reverse sync）
//   原因：bill_imports.raw_json schema = `TEXT NOT NULL`（migrations.js:1500，v2.1.8 N4）
//   修复：fixture 改用真实 NOT NULL schema + 断言改 raw_json = '' 而非 null
//
// 资金红线：本函数不可逆 UPDATE raw_json = ''；双 NOT IN 子查询是数据保护核心
//   必须 ≥ 8 unit case 覆盖差异行排除 + 可恢复 run 排除两层守卫边界
//
// 覆盖（spec §4.2 v0.6 + T23 require）：
//   1. NOT IN 子查询正常排除差异行（100 行 bill + 50 差异 + retention=1 → 仅 50 非差异行被清；50 差异行 raw_json 保留）
//   2. imported_at 边界（retention=7 天）：8 天前清；6 天前不清
//   3. raw_json 已 '' 的行不重复 UPDATE（idempotent — sentinel 守卫）
//   4. 空表 → clearedCount=0 + 无错误
//   5. 全是差异行 → clearedCount=0
//   6. 🔴 资金红线 fail case：人为破坏 diff_rows 表（DROP）→ 函数 throw 而非错清差异行
//   7. SQL injection 防护：retentionDays 非法字符串/对象 → 入口校验 throw（参数化绑定本身防 injection）
//   8. db 入参无效 → throw
//   9. **v0.5 (Round 3 F1) — partial run 关联 month 全部保留**（差异行 + 非差异行均 raw_json 保留 → clearedCount=0）
//   10. **v0.5 (Round 3 F1) — partial run 完成 resume → status='complete' → 非差异行可被清**
//   11. **v0.5 (Round 3 F1) — 跨月份 partial run 不影响其他月份的清理**
//   12. **v0.6 (Round 4 F1) — in-progress run 关联 month 整月排除**（first-chunk crash 残留路径）
//   13. **v0.6 (Round 4 F1) — partial + in-progress 混合月份均整月排除；complete + 无 progress 月份正常清**

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');
const {
  clearStaleSuccessfulRawJson,
} = require('../../../../src/backend/acquiring-bill-currency-db/raw-json-retention');

// === Fixture：建 acquiring_bill_currency_bill_imports + acquiring_bill_currency_diff_rows 两表 ===
//   schema 必须与 src/backend/database/migrations.js:1492 + :1543 一致（关键列 + FK）
//   ⚠️ v0.3：raw_json 必须 NOT NULL DEFAULT ''（与生产 schema 一致，防 v0.2 漏洞复现）
//   bill_imports 的 imported_at 列用 ISO 字符串（与 datetime('now', '-? days') 比较）
function setupTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-json-retention-fn-test-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_bill_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (month_key, recon_main_id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      total_bill_rows INTEGER NOT NULL DEFAULT 0,
      matched_rows INTEGER NOT NULL DEFAULT 0,
      mismatch_rows INTEGER NOT NULL DEFAULT 0,
      unmatched_rows INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'complete',
      chunk_progress TEXT
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_diff_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      bill_import_id INTEGER NOT NULL,
      flow_currency TEXT,
      flow_amount_abs TEXT,
      diff_type TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),
      FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id)
    );
  `);
  return { db, dir, dbPath };
}

function teardown({ db, dir }) {
  try { db.close(); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
}

// 用 ISO + 偏移天数构造历史 imported_at 字符串（datetime('now') SQLite UTC）
function nowMinusDays(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // 用 SQLite datetime('now') 的等价格式 'YYYY-MM-DD HH:MM:SS'
  // 注：SQLite 的 datetime('now') 默认 UTC，本测试 fixture 也用 UTC
  const iso = d.toISOString().replace('T', ' ').slice(0, 19);
  return iso;
}

function insertBill(db, { id, monthKey, reconId, raw, importedAt }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports
      (id, month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES (?, ?, 'fix.xlsx', ?, ?, 'USD', 'usd', ?, ?)
  `).run(id, monthKey, id, reconId, raw, importedAt);
}

function insertDiff(db, { runId, billImportId, diffType = 'currency-mismatch' }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_diff_rows
      (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    VALUES (?, ?, 'EUR', '100', ?)
  `).run(runId, billImportId, diffType);
}

function insertRun(db, { id, monthKey = '2026-04', chunkProgress = null }) {
  db.prepare(`
    INSERT INTO acquiring_bill_currency_runs (id, month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status, chunk_progress)
    VALUES (?, ?, 0, 0, 0, 0, 'complete', ?)
  `).run(id, monthKey, chunkProgress);
}

// v0.5 helper：写 partial / complete chunk_progress JSON 到指定 run
function setChunkProgress(db, { runId, status, lastCompletedChunkIndex = 1, totalChunks = 3 }) {
  const payload = JSON.stringify({ lastCompletedChunkIndex, totalChunks, status });
  db.prepare('UPDATE acquiring_bill_currency_runs SET chunk_progress = ? WHERE id = ?').run(payload, runId);
}

describe('clearStaleSuccessfulRawJson — NOT IN 子查询资金红线 (v0.5 partial run 守卫 + v0.3 sentinel)', () => {
  let ctx;
  beforeEach(() => { ctx = setupTempDb(); });
  afterEach(() => { teardown(ctx); });

  test('Case 1: NOT IN 子查询正常排除差异行（100 行 bill + 50 差异 + retention=1 → 仅 50 非差异行清；差异行 raw_json 保留）', () => {
    // fixture: 100 行 bill 全部 imported_at = 10 天前；50 行进 diff_rows；retention=1 → 全部老于 1 天
    const old = nowMinusDays(10);
    for (let i = 1; i <= 100; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 1 });
    for (let i = 1; i <= 50; i++) {
      insertDiff(ctx.db, { runId: 1, billImportId: i });  // 1-50 进 diff_rows
    }

    const before = ctx.db.prepare("SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json != ''").get().c;
    assert.strictEqual(before, 100, '初始 100 行都有 raw_json');

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });
    assert.strictEqual(result.clearedCount, 50, '应清 50 非差异行');
    assert.ok(result.elapsedMs >= 0, 'elapsedMs 字段存在');

    // 差异行（id 1-50）raw_json 全部保留
    const diffRowsKept = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id <= 50 AND raw_json != ''
    `).get().c;
    assert.strictEqual(diffRowsKept, 50, '🔴 资金红线：差异行 raw_json 必须全部保留');

    // 非差异行（id 51-100）raw_json 全部清空（sentinel = ''）
    const nonDiffCleared = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id > 50 AND raw_json = ''
    `).get().c;
    assert.strictEqual(nonDiffCleared, 50, '非差异行 raw_json 全清（sentinel = \'\')');
  });

  test('Case 2: imported_at 边界（retention=7 天）— 8 天前清；6 天前不清', () => {
    insertBill(ctx.db, { id: 1, monthKey: '2026-03', reconId: 'A', raw: '{}', importedAt: nowMinusDays(8) });
    insertBill(ctx.db, { id: 2, monthKey: '2026-03', reconId: 'B', raw: '{}', importedAt: nowMinusDays(6) });
    // 不进 diff_rows → 两行都是对账成功

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(result.clearedCount, 1, '仅 8 天前的行被清');

    const rowA = ctx.db.prepare('SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE id=1').get();
    const rowB = ctx.db.prepare('SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE id=2').get();
    assert.strictEqual(rowA.raw_json, '', '8 天前行 raw_json 已清（sentinel = \'\')');
    assert.strictEqual(rowB.raw_json, '{}', '6 天前行 raw_json 保留');
  });

  test('Case 3: raw_json 已 \'\' 的行不重复 UPDATE（idempotent — 多次 idle 触发安全）', () => {
    insertBill(ctx.db, { id: 1, monthKey: '2026-03', reconId: 'A', raw: '{}', importedAt: nowMinusDays(10) });
    insertBill(ctx.db, { id: 2, monthKey: '2026-03', reconId: 'B', raw: '', importedAt: nowMinusDays(10) });  // 已 sentinel
    insertBill(ctx.db, { id: 3, monthKey: '2026-03', reconId: 'C', raw: '', importedAt: nowMinusDays(10) });  // 已 sentinel

    // 第一次清：仅 id=1（id=2/3 已 ''）
    const r1 = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(r1.clearedCount, 1, '第一次仅清 id=1');

    // 第二次清：已无 raw_json != '' 的行 → 0
    const r2 = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(r2.clearedCount, 0, '第二次幂等 — 无 UPDATE');

    // 第三次清：同样 0
    const r3 = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(r3.clearedCount, 0, '第三次幂等 — 无 UPDATE');
  });

  test('Case 4: 空表 → clearedCount=0 + 无错误', () => {
    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 7 });
    assert.strictEqual(result.clearedCount, 0);
    assert.ok(result.elapsedMs >= 0);
  });

  test('Case 5: 全是差异行 → clearedCount=0（NOT IN 子查询全排除）', () => {
    insertRun(ctx.db, { id: 1 });
    for (let i = 1; i <= 10; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: '{}', importedAt: nowMinusDays(30) });
      insertDiff(ctx.db, { runId: 1, billImportId: i });
    }
    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });
    assert.strictEqual(result.clearedCount, 0, '全是差异行 → 0 清');

    // 验证全部 10 行 raw_json 保留
    const kept = ctx.db.prepare("SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json != ''").get().c;
    assert.strictEqual(kept, 10, '全部差异行 raw_json 保留');
  });

  test('Case 6: 🔴 资金红线 fail case — 人为破坏 diff_rows 表（DROP）→ 函数 throw 而非错清差异行', () => {
    insertRun(ctx.db, { id: 1 });
    for (let i = 1; i <= 10; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: '{}', importedAt: nowMinusDays(30) });
    }
    // 5 行进 diff_rows
    for (let i = 1; i <= 5; i++) {
      insertDiff(ctx.db, { runId: 1, billImportId: i });
    }
    // 人为破坏：DROP diff_rows 表
    ctx.db.exec('DROP TABLE acquiring_bill_currency_diff_rows');

    // 函数应抛 SQL error，而不是错清差异行（如 NOT IN 子查询找不到表时 SQL 应抛而非返回 NULL/empty 误清全部）
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 }),
      /no such table.*acquiring_bill_currency_diff_rows/i,
      '🔴 资金红线：diff_rows 表丢失时函数必须 throw，绝不能错清差异行 raw_json'
    );

    // 验证 raw_json 全部保留（没有任何被清）
    const kept = ctx.db.prepare("SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json != ''").get().c;
    assert.strictEqual(kept, 10, '🔴 资金红线：throw 后 raw_json 必须全部保留（绝无误清）');
  });

  test('Case 7: SQL injection 防护 — retentionDays 入口严校验 + 参数化绑定双重防御', () => {
    // 写一些数据，确保即使发生 injection 也能观察到错误清空（fail-safe）
    for (let i = 1; i <= 10; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: '{}', importedAt: nowMinusDays(30) });
    }

    // 7.1: 非整数字符串 '1 OR 1=1' — 入口严校验 throw
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: '1 OR 1=1' }),
      /retentionDays 必须是 ≥ 1 的整数/,
      'SQL injection 字符串入口拦截'
    );

    // 7.2: 浮点数 1.5 — 入口严校验 throw
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1.5 }),
      /retentionDays 必须是 ≥ 1 的整数/
    );

    // 7.3: null/undefined/对象 — 入口严校验 throw
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: null }),
      /retentionDays 必须是 ≥ 1 的整数/
    );
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: undefined }),
      /retentionDays 必须是 ≥ 1 的整数/
    );
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: { evil: true } }),
      /retentionDays 必须是 ≥ 1 的整数/
    );

    // 7.4: 0 / 负数 — 入口严校验 throw（防御回退 0 误清未来数据）
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 0 }),
      /retentionDays 必须是 ≥ 1 的整数/
    );
    assert.throws(
      () => clearStaleSuccessfulRawJson(ctx.db, { retentionDays: -1 }),
      /retentionDays 必须是 ≥ 1 的整数/
    );

    // 7.5: 验证 throw 后 raw_json 全保留（没有任何误清）
    const kept = ctx.db.prepare("SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json != ''").get().c;
    assert.strictEqual(kept, 10, '入口校验 throw 后 raw_json 必须全部保留');
  });

  test('Case 8: db 入参无效 → throw', () => {
    assert.throws(
      () => clearStaleSuccessfulRawJson(null, { retentionDays: 7 }),
      /db 参数无效/
    );
    assert.throws(
      () => clearStaleSuccessfulRawJson({}, { retentionDays: 7 }),
      /db 参数无效/
    );
  });

  // v0.5 (2026-05-28 SR-FIX-1 Round 3 F1)：partial run 关联 month 整月排除
  //   触发场景：chunked run 跑到 chunk M/N → cancel / worker crash → chunk_progress.status='partial'
  //     diff_rows 此时仅含「已处理 mismatches」；剩余 bill 行未处理
  //     如 idle cleanup 跑 → 清掉"未来 mismatch"的 raw_json → resume 后 writer 输出 broken
  //   修复（Round 3 F1）：partial run 关联 month 整月排除 — 直到 status='complete'
  test('Case 9: 🟠 资金红线 v0.5 — partial run 关联 month 整月排除（差异行 + 非差异行均保留）', () => {
    // fixture：100 行 bill 全部 imported_at = 10 天前 + month_key='2026-03'
    //   50 行进 diff_rows；run.chunk_progress.status='partial'（模拟 chunked run 半途 cancel）
    const old = nowMinusDays(10);
    for (let i = 1; i <= 100; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 1, monthKey: '2026-03' });
    for (let i = 1; i <= 50; i++) {
      insertDiff(ctx.db, { runId: 1, billImportId: i });
    }
    // 人造 partial chunk_progress（模拟 cancel chunk 2/3）
    setChunkProgress(ctx.db, { runId: 1, status: 'partial', lastCompletedChunkIndex: 1, totalChunks: 3 });

    const beforeKept = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json != ''"
    ).get().c;
    assert.strictEqual(beforeKept, 100, 'Case 9.0: baseline 100 行 raw_json 全保留');

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });
    assert.strictEqual(result.clearedCount, 0,
      'Case 9.1: 🟠 资金红线 — partial run 关联 month 整月排除 → clearedCount=0');

    // 差异行 raw_json 保留（既有 NOT IN diff_rows 守卫）
    const diffKept = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id <= 50 AND raw_json != ''
    `).get().c;
    assert.strictEqual(diffKept, 50, 'Case 9.2: 差异行 raw_json 全部保留（既有守卫）');

    // 非差异行 raw_json 也保留（v0.5 新增 partial run month 守卫）
    const nonDiffKept = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id > 50 AND raw_json != ''
    `).get().c;
    assert.strictEqual(nonDiffKept, 50,
      'Case 9.3: 🟠 partial run 关联 month 的非差异行 raw_json 也保留（v0.5 Round 3 F1 新增守卫）');
  });

  test('Case 10: v0.5 — partial run 完成 resume → status="complete" → 非差异行可被清', () => {
    // fixture 与 Case 9 相同；但 chunk_progress.status='complete'（模拟 resume 完成）
    const old = nowMinusDays(10);
    for (let i = 1; i <= 100; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 1, monthKey: '2026-03' });
    for (let i = 1; i <= 50; i++) {
      insertDiff(ctx.db, { runId: 1, billImportId: i });
    }
    // chunk_progress=complete（resume 完成后状态）
    setChunkProgress(ctx.db, { runId: 1, status: 'complete', lastCompletedChunkIndex: 2, totalChunks: 3 });

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });
    assert.strictEqual(result.clearedCount, 50,
      'Case 10.1: complete status 不再触发 month 排除 → 50 非差异行被清');

    // 差异行仍保留
    const diffKept = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id <= 50 AND raw_json != ''
    `).get().c;
    assert.strictEqual(diffKept, 50, 'Case 10.2: 差异行 raw_json 仍保留');

    // 非差异行已清
    const nonDiffCleared = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id > 50 AND raw_json = ''
    `).get().c;
    assert.strictEqual(nonDiffCleared, 50, 'Case 10.3: 非差异行 raw_json 已清（sentinel = \'\')');
  });

  test('Case 11: v0.5 — 跨月份 partial run 不影响其他月份的清理', () => {
    // fixture：月 A (2026-03) 有 partial run（应整月保护）；月 B (2026-04) 无 run（应正常清）
    const old = nowMinusDays(10);
    // 月 A：30 行 bill + 10 差异
    for (let i = 1; i <= 30; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `RA-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 1, monthKey: '2026-03' });
    for (let i = 1; i <= 10; i++) insertDiff(ctx.db, { runId: 1, billImportId: i });
    setChunkProgress(ctx.db, { runId: 1, status: 'partial' });

    // 月 B：20 行 bill 全部非差异（无 run）
    for (let i = 101; i <= 120; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-04', reconId: `RB-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });

    // 月 A：全保留（partial run 整月排除）
    const monthAKept = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = '2026-03' AND raw_json != ''"
    ).get().c;
    assert.strictEqual(monthAKept, 30, 'Case 11.1: 月 A（partial run）30 行全保留');

    // 月 B：全清（无 partial run，全部非差异行）
    const monthBCleared = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = '2026-04' AND raw_json = ''"
    ).get().c;
    assert.strictEqual(monthBCleared, 20, 'Case 11.2: 月 B（无 partial run）20 行全清');

    assert.strictEqual(result.clearedCount, 20, 'Case 11.3: clearedCount 仅含月 B 的 20 行');
  });

  // v0.6 (2026-05-28 SR-FIX-1 Round 4 F1)：partial → IN ('partial', 'in-progress')
  //   触发场景：first-chunk crash（worker 跑第一个 chunk 时 die，onChunkDone 触发前）
  //     → chunk_progress 停留 'in-progress'（Round 3 F2 入口写入）
  //     → 如 failureListener 未及时兜底（重启场景）+ idle cleanup 此时跑
  //     → 原 v0.5 SQL `= 'partial'` 不命中 in-progress → 清掉"未来 mismatch"raw_json
  //   修复：SQL `IN ('partial', 'in-progress')`
  test('Case 12: 🟠 资金红线 v0.6 — in-progress run 关联 month 整月排除（first-chunk crash 残留路径）', () => {
    // fixture：100 行 bill 全部 imported_at = 10 天前 + month_key='2026-03'
    //   30 行进 diff_rows；run.chunk_progress.status='in-progress'（模拟 first-chunk crash 残留）
    const old = nowMinusDays(10);
    for (let i = 1; i <= 100; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `R-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 1, monthKey: '2026-03' });
    for (let i = 1; i <= 30; i++) {
      insertDiff(ctx.db, { runId: 1, billImportId: i });
    }
    // 模拟 first-chunk crash + 重启 — chunk_progress 是 Round 3 F2 入口写入的初始 in-progress
    setChunkProgress(ctx.db, { runId: 1, status: 'in-progress', lastCompletedChunkIndex: -1, totalChunks: 0 });

    const beforeKept = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE raw_json != ''"
    ).get().c;
    assert.strictEqual(beforeKept, 100, 'Case 12.0: baseline 100 行 raw_json 全保留');

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });
    assert.strictEqual(result.clearedCount, 0,
      'Case 12.1: 🟠 资金红线 — in-progress run 关联 month 整月排除 → clearedCount=0');

    // 差异行 raw_json 保留（既有 NOT IN diff_rows 守卫）
    const diffKept = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id <= 30 AND raw_json != ''
    `).get().c;
    assert.strictEqual(diffKept, 30, 'Case 12.2: 差异行 raw_json 全部保留（既有守卫）');

    // 非差异行 raw_json 也保留（v0.6 新增 in-progress month 守卫）
    const nonDiffKept = ctx.db.prepare(`
      SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports
      WHERE id > 30 AND raw_json != ''
    `).get().c;
    assert.strictEqual(nonDiffKept, 70,
      'Case 12.3: 🟠 in-progress run 关联 month 的非差异行 raw_json 也保留（v0.6 Round 4 F1 新增守卫）');
  });

  test('Case 13: v0.6 — partial + in-progress 混合月份均整月排除；complete + 无 progress 月份正常清', () => {
    // fixture：4 个月
    //   - 月 A (2026-01) → partial run → 整月保护
    //   - 月 B (2026-02) → in-progress run → 整月保护
    //   - 月 C (2026-03) → complete run → 非差异行可清
    //   - 月 D (2026-04) → 无 run → 全部非差异行可清
    const old = nowMinusDays(10);

    // 月 A：20 行 + partial chunk_progress
    for (let i = 1; i <= 20; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-01', reconId: `RA-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 1, monthKey: '2026-01' });
    setChunkProgress(ctx.db, { runId: 1, status: 'partial', lastCompletedChunkIndex: 1, totalChunks: 3 });

    // 月 B：20 行 + in-progress chunk_progress（first-chunk crash 路径）
    for (let i = 21; i <= 40; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-02', reconId: `RB-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 2, monthKey: '2026-02' });
    setChunkProgress(ctx.db, { runId: 2, status: 'in-progress', lastCompletedChunkIndex: -1, totalChunks: 0 });

    // 月 C：20 行 + complete chunk_progress + 5 行 diff_rows
    for (let i = 41; i <= 60; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-03', reconId: `RC-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }
    insertRun(ctx.db, { id: 3, monthKey: '2026-03' });
    for (let i = 41; i <= 45; i++) insertDiff(ctx.db, { runId: 3, billImportId: i });
    setChunkProgress(ctx.db, { runId: 3, status: 'complete', lastCompletedChunkIndex: 2, totalChunks: 3 });

    // 月 D：20 行 + 无 run
    for (let i = 61; i <= 80; i++) {
      insertBill(ctx.db, { id: i, monthKey: '2026-04', reconId: `RD-${i}`, raw: `{"k":${i}}`, importedAt: old });
    }

    const result = clearStaleSuccessfulRawJson(ctx.db, { retentionDays: 1 });

    // 月 A（partial）：20 行全保留
    const monthAKept = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = '2026-01' AND raw_json != ''"
    ).get().c;
    assert.strictEqual(monthAKept, 20, 'Case 13.1: 月 A（partial）20 行全保留');

    // 月 B（in-progress）：20 行全保留（Round 4 F1 新增）
    const monthBKept = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = '2026-02' AND raw_json != ''"
    ).get().c;
    assert.strictEqual(monthBKept, 20, 'Case 13.2: 月 B（in-progress）20 行全保留（v0.6 Round 4 F1 守卫）');

    // 月 C（complete）：15 非差异行清，5 差异行保留
    const monthCKept = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = '2026-03' AND raw_json != ''"
    ).get().c;
    assert.strictEqual(monthCKept, 5, 'Case 13.3: 月 C（complete）5 差异行保留 + 15 非差异行清');

    // 月 D（无 run）：20 行全清
    const monthDCleared = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = '2026-04' AND raw_json = ''"
    ).get().c;
    assert.strictEqual(monthDCleared, 20, 'Case 13.4: 月 D（无 run）20 行全清');

    assert.strictEqual(result.clearedCount, 35, 'Case 13.5: clearedCount = 月 C 15 + 月 D 20 = 35');
  });
});
