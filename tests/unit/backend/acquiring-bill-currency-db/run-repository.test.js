// v2.1.10 A4 T18 / T19 — run-repository chunked + chunk_progress unit test
//
// 覆盖（spec §三 + tasks T18 / T19）：
//   T18.1：chunk size 边界（5000 行 / chunk=2000 → 3 chunks；最后 chunk 不满）
//   T18.2：chunk size > 数据行数（5000 行 / chunk=10w → 1 chunk）
//   T18.3：chunk size = 数据行数（5000 行 / chunk=5000 → 1 chunk）
//   T18.4：cancelToken 在 chunk 1 完成 / chunk 2 中触发 → chunk 1 保留 / chunk 2 ROLLBACK / status 'partial'
//   T18.5：byte-for-byte 验证 5000 行 non-chunked vs chunked (chunk=2000) 结果一致
//   T18.6：chunkSize 入参验证（< 1 / 非整数）→ throw
//   T18.7：runId 缺失 → throw
//   T18.8：空 bill 表 → totalChunks=0 / lastCompletedChunkIndex=-1（不触发 onChunkDone）
//   T18.9：onChunkDone 回调抛错不阻塞主循环
//   T19.1：getRunChunkProgress 读 NULL 列 → null
//   T19.2：setRunChunkProgress + getRunChunkProgress round-trip（in-progress / partial / complete）
//   T19.3：setRunChunkProgress invalid status → throw
//   T19.4：resumeFromChunkIndex 跳过已完成 chunk
//
// fixture：
//   - 共 N 行 bill，每行带 mismatch（settle_currency=USD vs flow EUR）→ N 行 diff_rows
//   - 不依赖 importRepo（直接 raw INSERT 极简 fixture）

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const runRepo = require('../../../../src/backend/acquiring-bill-currency-db/run-repository');
const {
  ensureAcquiringBillCurrencyTablesSupport,
  ensureAcquiringBillCurrencyRunsCleanupPending,
  ensureAcquiringBillCurrencyRunsChunkProgress,
} = require('../../../../src/backend/database/migrations');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  // 建表 + 加 chunk_progress 列
  // 也建 app_settings 让 settings migration 不抛
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureAcquiringBillCurrencyTablesSupport(db);
  ensureAcquiringBillCurrencyRunsCleanupPending(db);
  ensureAcquiringBillCurrencyRunsChunkProgress(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

// ─────────────────────────────────────────────────────────────────
// fixture helper：插 N 行 bill (settle_currency_norm='usd') + 对应 flow (settle_currency_norm='eur')
//   bill JOIN flow 按 recon_main_id 命中；币种不一致 → N 行 diff_rows
// ─────────────────────────────────────────────────────────────────
function seedMismatchRows(db, { monthKey, count }) {
  // bill_imports schema：无 settle_amount / settle_amount_abs；仅 settle_currency + settle_currency_norm
  const billStmt = db.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, imported_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // flow_imports schema：含 settle_amount / settle_amount_abs
  const flowStmt = db.prepare(`
    INSERT INTO acquiring_bill_currency_flow_imports
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, settle_amount, settle_amount_abs, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (let i = 1; i <= count; i++) {
      const reconId = `R-${i}`;
      billStmt.run(monthKey, 'bill.xlsx', i, reconId, 'USD', 'usd', now, '{}');
      flowStmt.run(monthKey, 'flow.xlsx', i, reconId, 'EUR', 'eur', '100', '100', '{}', now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function insertRun(db, monthKey, count) {
  return runRepo.insertRun(db, {
    monthKey,
    ranAt: new Date().toISOString(),
    totalBillRows: count,
    matchedRows: count,
    mismatchRows: count,
    unmatchedRows: 0,
    status: 'success',
  });
}

// ─────────────────────────────────────────────────────────────────
// T18 — insertDiffRowsByJoinChunked
// ─────────────────────────────────────────────────────────────────
test.describe('T18 — insertDiffRowsByJoinChunked', () => {

  test('T18.1 — chunk size 边界（5000 行 / chunk=2000 → 3 chunks；最后 chunk 不满）', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 5000 });
    const runId = insertRun(db, monthKey, 5000);

    const chunkDoneEvents = [];
    const result = runRepo.insertDiffRowsByJoinChunked(db, {
      runId,
      monthKey,
      chunkSize: 2000,
      onChunkDone: (ev) => chunkDoneEvents.push(ev),
    });

    assert.equal(result.totalChunks, 3, '5000 / 2000 = 3 chunks');
    assert.equal(result.totalProcessedBillRows, 5000, '总处理 bill 行 = 5000');
    assert.equal(result.totalInsertedDiffRows, 5000, '总 INSERT diff_rows = 5000');
    assert.equal(result.lastCompletedChunkIndex, 2, '最后 chunk = index 2');

    // 验证 diff_rows 实际写入
    const diffCount = db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assert.equal(diffCount, 5000);

    // onChunkDone 触发次数 = totalChunks
    assert.equal(chunkDoneEvents.length, 3, 'onChunkDone 触发 3 次');
    assert.equal(chunkDoneEvents[0].chunkIndex, 0);
    assert.equal(chunkDoneEvents[0].processedRows, 2000, 'chunk 0 期望 2000 行');
    assert.equal(chunkDoneEvents[0].insertedDiffRows, 2000);
    assert.equal(chunkDoneEvents[1].chunkIndex, 1);
    assert.equal(chunkDoneEvents[1].processedRows, 2000, 'chunk 1 期望 2000 行');
    assert.equal(chunkDoneEvents[2].chunkIndex, 2);
    assert.equal(chunkDoneEvents[2].processedRows, 1000, 'chunk 2 (最后) 期望 1000 行');
    // 每次回调都带 totalChunks / elapsedMs
    chunkDoneEvents.forEach((ev) => {
      assert.equal(ev.totalChunks, 3);
      assert.ok(typeof ev.elapsedMs === 'number' && ev.elapsedMs >= 0);
    });
  });

  test('T18.2 — chunk size > 数据行数（5000 行 / chunk=100000 → 1 chunk）', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 5000 });
    const runId = insertRun(db, monthKey, 5000);

    const result = runRepo.insertDiffRowsByJoinChunked(db, {
      runId,
      monthKey,
      chunkSize: 100000,
    });

    assert.equal(result.totalChunks, 1, 'ceil(5000 / 100000) = 1');
    assert.equal(result.totalProcessedBillRows, 5000);
    assert.equal(result.totalInsertedDiffRows, 5000);
    assert.equal(result.lastCompletedChunkIndex, 0);
  });

  test('T18.3 — chunk size = 数据行数（5000 行 / chunk=5000 → 1 chunk）', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 5000 });
    const runId = insertRun(db, monthKey, 5000);

    const result = runRepo.insertDiffRowsByJoinChunked(db, {
      runId,
      monthKey,
      chunkSize: 5000,
    });

    assert.equal(result.totalChunks, 1);
    assert.equal(result.totalProcessedBillRows, 5000);
    assert.equal(result.lastCompletedChunkIndex, 0);
  });

  test('T18.4 — cancelToken 在 chunk 1 完成 / chunk 2 之前触发 → chunk 0/1 保留 + chunk 2 未跑', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 5000 });
    const runId = insertRun(db, monthKey, 5000);

    // cancelToken：chunk 0 / 1 边界前不 cancel；chunk 2 边界前抛
    let cancelled = false;
    let checkCount = 0;
    const cancelToken = {
      get cancelled() { return cancelled; },
      cancel() { cancelled = true; },
      throwIfCancelled(stage) {
        checkCount++;
        // chunked 内 throwIfCancelled 调用顺序：chunk 0 前 (1) / chunk 1 前 (2) / chunk 2 前 (3)
        if (checkCount >= 3) cancelled = true;
        if (cancelled) {
          const err = new Error(`cancelled at ${stage}`);
          err.name = 'CancelError';
          err.stage = stage;
          throw err;
        }
      },
    };

    let caught;
    try {
      runRepo.insertDiffRowsByJoinChunked(db, {
        runId,
        monthKey,
        chunkSize: 2000,
        cancelToken,
      });
    } catch (e) { caught = e; }

    assert.ok(caught, '应 throw');
    assert.equal(caught.name, 'CancelError');
    assert.equal(caught.stage, 'sql-joining-chunk-2', '在 chunk 2 边界命中');

    // chunk 0 / 1 已 COMMIT → diff_rows 有 4000 行（chunk 0 2000 + chunk 1 2000）
    const diffCount = db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assert.equal(diffCount, 4000, 'chunk 0/1 COMMIT 保留；chunk 2 未跑');

    // DB 无锁残留（chunk 2 边界 cancel 抛错前未 BEGIN）
    assert.doesNotThrow(() => {
      db.exec('BEGIN');
      db.exec('ROLLBACK');
    });
  });

  test('T18.5 — byte-for-byte 验证：5000 行 non-chunked vs chunked(chunk=2000) 结果一致', () => {
    // 两个 monthKey 跑 — non-chunked 与 chunked 各自独立 + diff_rows 排序后对比
    const monthA = '2026-04';
    const monthB = '2026-05';
    seedMismatchRows(db, { monthKey: monthA, count: 5000 });
    seedMismatchRows(db, { monthKey: monthB, count: 5000 });

    const runA = insertRun(db, monthA, 5000);
    const runB = insertRun(db, monthB, 5000);

    // A：non-chunked（旧路径）
    const changesA = runRepo.insertDiffRowsByJoin(db, { runId: runA, monthKey: monthA });
    // B：chunked
    const resultB = runRepo.insertDiffRowsByJoinChunked(db, {
      runId: runB,
      monthKey: monthB,
      chunkSize: 2000,
    });

    assert.equal(changesA, 5000);
    assert.equal(resultB.totalInsertedDiffRows, 5000);

    // 对比 diff_rows 内容（按 bill_import_id 序的 flow_currency / flow_amount_abs / diff_type）
    // 各自取 (bill.recon_main_id, d.flow_currency, d.flow_amount_abs, d.diff_type) 排序
    const rowsA = db.prepare(`
      SELECT b.recon_main_id AS reconId, d.flow_currency, d.flow_amount_abs, d.diff_type
      FROM acquiring_bill_currency_diff_rows d
      INNER JOIN acquiring_bill_currency_bill_imports b ON b.id = d.bill_import_id
      WHERE d.run_id = ?
      ORDER BY reconId ASC
    `).all(runA);
    const rowsB = db.prepare(`
      SELECT b.recon_main_id AS reconId, d.flow_currency, d.flow_amount_abs, d.diff_type
      FROM acquiring_bill_currency_diff_rows d
      INNER JOIN acquiring_bill_currency_bill_imports b ON b.id = d.bill_import_id
      WHERE d.run_id = ?
      ORDER BY reconId ASC
    `).all(runB);

    assert.equal(rowsA.length, rowsB.length, '行数一致');
    for (let i = 0; i < rowsA.length; i++) {
      assert.deepEqual(rowsA[i], rowsB[i], `第 ${i} 行 byte-for-byte 一致`);
    }
  });

  test('T18.6 — chunkSize 入参验证（< 1 / 非整数）→ throw', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 100 });
    const runId = insertRun(db, monthKey, 100);

    assert.throws(
      () => runRepo.insertDiffRowsByJoinChunked(db, { runId, monthKey, chunkSize: 0 }),
      /chunkSize/
    );
    assert.throws(
      () => runRepo.insertDiffRowsByJoinChunked(db, { runId, monthKey, chunkSize: -1 }),
      /chunkSize/
    );
    assert.throws(
      () => runRepo.insertDiffRowsByJoinChunked(db, { runId, monthKey, chunkSize: 'abc' }),
      /chunkSize/
    );
    assert.throws(
      () => runRepo.insertDiffRowsByJoinChunked(db, { runId, monthKey, chunkSize: 1.5 }),
      /chunkSize/
    );
  });

  test('T18.7 — runId / monthKey 缺失 → throw', () => {
    assert.throws(
      () => runRepo.insertDiffRowsByJoinChunked(db, { monthKey: '2026-04' }),
      /runId/
    );
    assert.throws(
      () => runRepo.insertDiffRowsByJoinChunked(db, { runId: 1 }),
      /monthKey/
    );
  });

  test('T18.8 — 空 bill 表 → totalChunks=0 / lastCompletedChunkIndex=-1', () => {
    const monthKey = '2026-04';
    // 不 seed 任何数据 — bill 表为空
    const runId = insertRun(db, monthKey, 0);

    const chunkDoneEvents = [];
    const result = runRepo.insertDiffRowsByJoinChunked(db, {
      runId,
      monthKey,
      chunkSize: 10000,
      onChunkDone: (ev) => chunkDoneEvents.push(ev),
    });

    assert.equal(result.totalChunks, 0);
    assert.equal(result.totalProcessedBillRows, 0);
    assert.equal(result.totalInsertedDiffRows, 0);
    assert.equal(result.lastCompletedChunkIndex, -1);
    assert.equal(chunkDoneEvents.length, 0, 'onChunkDone 不触发');
  });

  test('T18.9 — onChunkDone 回调抛错不阻塞主循环', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 4000 });
    const runId = insertRun(db, monthKey, 4000);

    let invokeCount = 0;
    const result = runRepo.insertDiffRowsByJoinChunked(db, {
      runId,
      monthKey,
      chunkSize: 2000,
      onChunkDone: () => {
        invokeCount++;
        throw new Error('onChunkDone callback throws');
      },
    });

    assert.equal(result.totalChunks, 2);
    assert.equal(invokeCount, 2, 'onChunkDone 仍被调用 2 次（每 chunk 一次）');
    const diffCount = db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assert.equal(diffCount, 4000, '全部 diff_rows 已写入');
  });

});

// ─────────────────────────────────────────────────────────────────
// T19 — chunk_progress get/set
// ─────────────────────────────────────────────────────────────────
test.describe('T19 — chunk_progress get/set', () => {

  test('T19.1 — getRunChunkProgress 读 NULL 列 → null', () => {
    const monthKey = '2026-04';
    const runId = insertRun(db, monthKey, 0);
    assert.equal(runRepo.getRunChunkProgress(db, runId), null);
  });

  test('T19.2 — setRunChunkProgress + getRunChunkProgress round-trip', () => {
    const runId = insertRun(db, '2026-04', 0);

    runRepo.setRunChunkProgress(db, {
      runId,
      lastCompletedChunkIndex: 0,
      totalChunks: 3,
      status: 'in-progress',
    });
    let progress = runRepo.getRunChunkProgress(db, runId);
    assert.deepEqual(progress, { lastCompletedChunkIndex: 0, totalChunks: 3, status: 'in-progress' });

    runRepo.setRunChunkProgress(db, {
      runId,
      lastCompletedChunkIndex: 1,
      totalChunks: 3,
      status: 'partial',
    });
    progress = runRepo.getRunChunkProgress(db, runId);
    assert.equal(progress.status, 'partial');
    assert.equal(progress.lastCompletedChunkIndex, 1);

    runRepo.setRunChunkProgress(db, {
      runId,
      lastCompletedChunkIndex: 2,
      totalChunks: 3,
      status: 'complete',
    });
    progress = runRepo.getRunChunkProgress(db, runId);
    assert.equal(progress.status, 'complete');
    assert.equal(progress.lastCompletedChunkIndex, 2);
  });

  test('T19.3 — setRunChunkProgress invalid status → throw', () => {
    const runId = insertRun(db, '2026-04', 0);
    assert.throws(
      () => runRepo.setRunChunkProgress(db, {
        runId,
        lastCompletedChunkIndex: 0,
        totalChunks: 1,
        status: 'invalid-status',
      }),
      /status/
    );
  });

  test('T19.4 — resumeFromChunkIndex 复用 — 第一段 chunk 0/1 完成 + 第二段从 chunk 2 起跑（byte-for-byte 一致 / idempotent）', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 8000 });
    const runId = insertRun(db, monthKey, 8000);

    // 第一段：用 cancelToken 在 chunk 2 边界 cancel（chunk 0 / 1 完成）
    let cancelled = false;
    let checkCount = 0;
    const cancelToken = {
      get cancelled() { return cancelled; },
      throwIfCancelled(stage) {
        checkCount++;
        // chunked 内 cancel check：chunk 0 前 (1) / chunk 1 前 (2) / chunk 2 前 (3) ...
        if (checkCount >= 3) cancelled = true;
        if (cancelled) {
          const err = new Error(`cancelled at ${stage}`);
          err.name = 'CancelError';
          err.stage = stage;
          throw err;
        }
      },
    };

    let caught;
    try {
      runRepo.insertDiffRowsByJoinChunked(db, {
        runId,
        monthKey,
        chunkSize: 2000,
        cancelToken,
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.stage, 'sql-joining-chunk-2', '第一段在 chunk 2 边界 cancel');

    // 验证 chunk 0/1 已写入
    let diffCount = db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assert.equal(diffCount, 4000, '第一段 chunk 0/1 → 4000 diff_rows 写入');

    // 第二段：resume from chunk 2 — 不传 cancelToken，跑到完
    const resumeResult = runRepo.insertDiffRowsByJoinChunked(db, {
      runId,
      monthKey,
      chunkSize: 2000,
      resumeFromChunkIndex: 2,
    });

    assert.equal(resumeResult.totalChunks, 4);
    assert.equal(resumeResult.totalProcessedBillRows, 4000, 'resume 仅跑 chunk 2/3 → 4000 行');
    assert.equal(resumeResult.totalInsertedDiffRows, 4000);
    assert.equal(resumeResult.lastCompletedChunkIndex, 3);

    // 总 diff_rows = 第一段 4000 + 第二段 4000 = 8000（无重复）
    diffCount = db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assert.equal(diffCount, 8000, 'resume 后 diff_rows 总数 = 8000（无重复）');

    // 第二段后期望 diff_rows.bill_import_id DISTINCT 数 = 8000（每行恰好 1 个 diff）
    const distinctBillIds = db.prepare(
      'SELECT COUNT(DISTINCT bill_import_id) c FROM acquiring_bill_currency_diff_rows'
    ).get().c;
    assert.equal(distinctBillIds, 8000, '每行 bill 仅对应 1 行 diff（无重复 — idempotent）');
  });

  test('T19.5 — resumeFromChunkIndex >= totalChunks → 等价 nothing-to-do', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 4000 });
    const runId = insertRun(db, monthKey, 4000);

    const result = runRepo.insertDiffRowsByJoinChunked(db, {
      runId,
      monthKey,
      chunkSize: 2000,
      resumeFromChunkIndex: 10, // 远 > totalChunks=2
    });

    assert.equal(result.totalChunks, 2);
    assert.equal(result.totalProcessedBillRows, 0, 'nothing-to-do');
    assert.equal(result.totalInsertedDiffRows, 0);
    assert.equal(result.lastCompletedChunkIndex, 1, 'lastCompletedChunkIndex = totalChunks - 1（等价 complete）');
    const diffCount = db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
    assert.equal(diffCount, 0, '无 diff_rows 写入');
  });

  test('T19.6 — resumeFromChunkIndex 入参验证（负数 / 非整数）→ throw', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 1000 });
    const runId = insertRun(db, monthKey, 1000);

    assert.throws(
      () => runRepo.insertDiffRowsByJoinChunked(db, {
        runId, monthKey, chunkSize: 500, resumeFromChunkIndex: -1,
      }),
      /resumeFromChunkIndex/
    );
    assert.throws(
      () => runRepo.insertDiffRowsByJoinChunked(db, {
        runId, monthKey, chunkSize: 500, resumeFromChunkIndex: 'abc',
      }),
      /resumeFromChunkIndex/
    );
  });

  // v2.1.10 SR-FIX-1 round 2 P1-5：listPartialRuns API
  test('T19.7 — listPartialRuns 返回某月所有 chunk_progress.status="partial" 的 runs（SR-FIX-1 round 2 P1-5）', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 100 });
    // 3 个 run：partial / complete / partial（按 ran_at 升序）
    const r1 = insertRun(db, monthKey, 100);
    runRepo.setRunChunkProgress(db, { runId: r1, lastCompletedChunkIndex: 0, totalChunks: 3, status: 'partial' });
    const r2 = insertRun(db, monthKey, 100);
    runRepo.setRunChunkProgress(db, { runId: r2, lastCompletedChunkIndex: 2, totalChunks: 3, status: 'complete' });
    const r3 = insertRun(db, monthKey, 100);
    runRepo.setRunChunkProgress(db, { runId: r3, lastCompletedChunkIndex: 1, totalChunks: 3, status: 'partial' });

    // 不同月份的 partial run — 不应混入
    seedMismatchRows(db, { monthKey: '2026-05', count: 100 });
    const rOther = insertRun(db, '2026-05', 100);
    runRepo.setRunChunkProgress(db, { runId: rOther, lastCompletedChunkIndex: 0, totalChunks: 3, status: 'partial' });

    const partials = runRepo.listPartialRuns(db, monthKey);
    assert.strictEqual(partials.length, 2, 'T19.7.1 含 2 个 partial run（r1 + r3）');
    // 按 ran_at DESC + id DESC — r3 在前（id 大）
    assert.strictEqual(partials[0].id, r3, 'T19.7.2 第一个 = 最近 partial（r3）');
    assert.strictEqual(partials[1].id, r1, 'T19.7.3 第二个 = 较老 partial（r1）');
    // chunk_progress 字段已解析
    assert.strictEqual(partials[0].chunk_progress.status, 'partial', 'T19.7.4 chunk_progress.status=partial');
    assert.strictEqual(partials[0].chunk_progress.lastCompletedChunkIndex, 1, 'T19.7.5 lastCompletedChunkIndex=1');
    assert.strictEqual(partials[0].chunk_progress.totalChunks, 3, 'T19.7.6 totalChunks=3');
    // 不含 complete run
    assert.ok(!partials.find(p => p.id === r2), 'T19.7.7 不含 complete run');
    // 不含其他月份 partial
    assert.ok(!partials.find(p => p.id === rOther), 'T19.7.8 不含其他月份 partial run');
  });

  test('T19.8 — listPartialRuns monthKey 缺失 / 无 run → 空数组', () => {
    assert.deepStrictEqual(runRepo.listPartialRuns(db, ''), [], 'T19.8.1 空 monthKey → []');
    assert.deepStrictEqual(runRepo.listPartialRuns(db, null), [], 'T19.8.2 null monthKey → []');
    assert.deepStrictEqual(runRepo.listPartialRuns(db, '2099-99'), [], 'T19.8.3 无 run 月份 → []');
  });

  // v2.1.10 SR-FIX-1 round 2 P1-7：模拟 worker crash 后兜底 in-progress → partial
  //   生产路径：failureListener 内扫所有 chunk_progress IS NOT NULL 的 runs → status='in-progress' → 改 'partial'
  //   本 case 验证 setRunChunkProgress 接受 in-progress / partial round-trip + 兜底改 partial 后 listPartialRuns 能命中
  test('T19.9 — chunk_progress status in-progress → 兜底改 partial 后 listPartialRuns 能命中（SR-FIX-1 round 2 P1-7）', () => {
    const monthKey = '2026-04';
    seedMismatchRows(db, { monthKey, count: 100 });
    const runId = insertRun(db, monthKey, 100);

    // 模拟 worker 跑 chunk 1/3 完成后 crash — chunk_progress 停留 in-progress
    runRepo.setRunChunkProgress(db, { runId, lastCompletedChunkIndex: 1, totalChunks: 3, status: 'in-progress' });
    const before = runRepo.getRunChunkProgress(db, runId);
    assert.strictEqual(before.status, 'in-progress', 'T19.9.1 crash 前 status=in-progress');

    // 验证 listPartialRuns 此时不命中（只看 partial）
    const partialsBefore = runRepo.listPartialRuns(db, monthKey);
    assert.strictEqual(partialsBefore.length, 0, 'T19.9.2 兜底前 listPartialRuns 不命中 in-progress');

    // 模拟 main.js failureListener 兜底改 in-progress → partial
    runRepo.setRunChunkProgress(db, {
      runId,
      lastCompletedChunkIndex: before.lastCompletedChunkIndex,
      totalChunks: before.totalChunks,
      status: 'partial',
    });

    // listPartialRuns 现在能命中
    const partialsAfter = runRepo.listPartialRuns(db, monthKey);
    assert.strictEqual(partialsAfter.length, 1, 'T19.9.3 兜底后 listPartialRuns 命中 1');
    assert.strictEqual(partialsAfter[0].id, runId, 'T19.9.4 命中正确的 runId');
    assert.strictEqual(partialsAfter[0].chunk_progress.lastCompletedChunkIndex, 1, 'T19.9.5 兜底保留 lastCompletedChunkIndex');
  });

});
