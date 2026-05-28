// v2.1.10 A3 Phase 1 T09 — runCheckCore byte-for-byte contract test
//
// ⚠️ 资金红线：worker 内执行 runCheckCore 必须与主进程直调 runCheckCore 行为 byte-for-byte 一致。
//
// 验证策略：
//   - 两个独立 tmpdir（A 主进程 / B worker 进程）
//   - 同一份 fixture（30 行单据 / 流水 — 含币种差异 / 全匹配 / 缺流水 三类）
//   - A：用 AppDatabase + session.runCheckCore 直接跑
//   - B：用 AppDatabase import 后关 main connection，用 workerPool.dispatchRunCheck 跑
//   - 对比：diff_rows 表内容（按 reconId 排序后 row-by-row 比对所有列）
//   - stats（totalBillRows / matchedRows / mismatchRows / unmatchedRows）也对比
//   - 通过则证明：worker 路径不破坏 SQL JOIN 算法 / 不引入隐式 race / DB 连接独立性 OK
//
// fixture：
//   - 5 行 USD-USD 全匹配
//   - 3 行 USD-EUR 币种差异（mismatch）
//   - 2 行 仅 bill 无 flow（unmatched）
//   合计 10 行 bill / 8 行 flow / 期望 diff_rows = 3（仅 mismatch）

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { AppDatabase } = require('../../../src/backend/database');
const session = require('../../../src/main-process/acquiring-bill-currency-session');
const pool = require('../../../src/main-process/run-check-worker-pool');
const { FLOW_HEADERS, BILL_HEADERS } = require('../../../src/backend/acquiring-bill-currency-db/columns');

function makeFlow(date, id, flowCcy, billCcy) {
  const r = new Array(48).fill('');
  r[0] = date;
  r[6] = id;
  r[12] = '100';
  r[13] = flowCcy;
  r[28] = '100';
  r[29] = billCcy;
  return r;
}

function makeBill(date, id, currency) {
  const r = new Array(26).fill('');
  r[0] = date;
  r[14] = id;
  r[18] = '100';
  r[19] = currency;
  return r;
}

const FIXTURE_DATE = '2026-04-15';
const FIXTURE_MONTH = '2026-04';

async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

async function setupTmpDbWithFixture() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-test-'));
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  // fixture rows
  const flowRows = [];
  const billRows = [];

  // 5 行全匹配（USD-USD）
  for (let i = 1; i <= 5; i++) {
    flowRows.push(makeFlow(FIXTURE_DATE, `MATCH-${i}`, 'USD', 'USD'));
    billRows.push(makeBill(FIXTURE_DATE, `MATCH-${i}`, 'USD'));
  }
  // 3 行币种差异（流水 USD，单据 EUR）
  for (let i = 1; i <= 3; i++) {
    flowRows.push(makeFlow(FIXTURE_DATE, `MISMATCH-${i}`, 'USD', 'USD'));
    billRows.push(makeBill(FIXTURE_DATE, `MISMATCH-${i}`, 'EUR'));
  }
  // 2 行仅 bill 无 flow
  for (let i = 1; i <= 2; i++) {
    billRows.push(makeBill(FIXTURE_DATE, `UNMATCHED-${i}`, 'JPY'));
  }

  const flowFile = path.join(tmpdir, 'flow.xlsx');
  const billFile = path.join(tmpdir, 'bill.xlsx');
  await writeXlsx(flowFile, FLOW_HEADERS, flowRows);
  await writeXlsx(billFile, BILL_HEADERS, billRows);

  await session.importFlowFiles({ db: db.db, monthKey: FIXTURE_MONTH, filePaths: [flowFile] });
  await session.importBillFiles({ db: db.db, monthKey: FIXTURE_MONTH, filePaths: [billFile] });

  return {
    tmpdir,
    dbPath,
    db,
    cleanup() {
      try { db.db.close(); } catch (_e) {}
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

// 读 diff_rows 表所有列 + stats，按 recon_main_id 排序便于比对
function snapshotDiffRowsAndStats(db) {
  const stats = db.prepare(`
    SELECT total_bill_rows, matched_rows, mismatch_rows, unmatched_rows
    FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1
  `).get();
  // diff_rows 表所有列（取 run_id 最大的 — 即本次 run）
  const rows = db.prepare(`
    SELECT * FROM acquiring_bill_currency_diff_rows
    WHERE run_id = (SELECT MAX(id) FROM acquiring_bill_currency_runs)
    ORDER BY bill_import_id
  `).all();
  // 去掉时间相关 / id 相关字段（不同 tmpdir 间不可比），仅保留业务字段
  const normalized = rows.map((row) => {
    const cleaned = { ...row };
    delete cleaned.id;           // diff_rows.id 自增
    delete cleaned.run_id;       // run_id 自增
    delete cleaned.bill_import_id; // bill_imports.id 自增（两 tmpdir 独立）
    return cleaned;
  });
  return { stats, rows: normalized, rowCount: rows.length };
}

test.describe('runCheckCore byte-for-byte contract', () => {

  test.afterEach(async () => {
    await pool.__reset_for_test__();
  });

  test('主进程直调 vs worker pool dispatch — diff_rows + stats byte-for-byte 一致', async () => {
    // tmpdir A：主进程直调 runCheckCore
    const A = await setupTmpDbWithFixture();
    const B = await setupTmpDbWithFixture();
    try {
      // ── A: 主进程直调 ──
      const resultA = await session.runCheckCore({
        db: A.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: A.tmpdir,
      });
      const snapA = snapshotDiffRowsAndStats(A.db.db);

      // ── B: worker pool dispatch ──
      // 关掉 main connection，让 worker 独占（避免 WAL 模式下并发干扰）
      B.db.db.close();
      const resultB = await pool.dispatchRunCheck(
        { __dbPath: B.dbPath, monthKey: FIXTURE_MONTH, storageRoot: B.tmpdir },
        {}
      );
      // 重新打开 B 的 main connection 读结果
      const Bdb2 = new (require('../../../src/backend/database').AppDatabase)(B.dbPath);
      Bdb2.init();
      const snapB = snapshotDiffRowsAndStats(Bdb2.db);
      Bdb2.db.close();
      // 修正 B 的 cleanup（已 close 不能再 close）
      B.db.db = { close: () => {} };

      // ── 断言 stats 完全一致 ──
      assert.equal(resultA.totalBillRows, resultB.totalBillRows, 'totalBillRows 一致');
      assert.equal(resultA.matchedRows, resultB.matchedRows, 'matchedRows 一致');
      assert.equal(resultA.mismatchRows, resultB.mismatchRows, 'mismatchRows 一致');
      assert.equal(resultA.unmatchedRows, resultB.unmatchedRows, 'unmatchedRows 一致');

      // ── 断言 fixture 预期值 ──
      assert.equal(resultA.totalBillRows, 10, 'fixture totalBillRows=10');
      assert.equal(resultA.matchedRows, 8, 'fixture matchedRows=8 (5 matched + 3 mismatch 都按 reconId 配对到 flow)');
      assert.equal(resultA.mismatchRows, 3, 'fixture mismatchRows=3');
      assert.equal(resultA.unmatchedRows, 2, 'fixture unmatchedRows=2');

      // ── 断言 diff_rows 表内容 byte-for-byte 一致 ──
      assert.equal(snapA.rowCount, snapB.rowCount, 'diff_rows 行数一致');
      assert.equal(snapA.rowCount, 3, 'diff_rows = 3 行（mismatch）');
      assert.equal(snapA.stats.total_bill_rows, snapB.stats.total_bill_rows, 'stats.total_bill_rows 一致');
      assert.equal(snapA.stats.matched_rows, snapB.stats.matched_rows, 'stats.matched_rows 一致');
      assert.equal(snapA.stats.mismatch_rows, snapB.stats.mismatch_rows, 'stats.mismatch_rows 一致');
      assert.equal(snapA.stats.unmatched_rows, snapB.stats.unmatched_rows, 'stats.unmatched_rows 一致');

      // 每行（去掉自增 id）业务字段完全一致
      for (let i = 0; i < snapA.rows.length; i++) {
        assert.deepEqual(
          snapA.rows[i],
          snapB.rows[i],
          `diff_rows[${i}] byte-for-byte 一致`
        );
      }
    } finally {
      A.cleanup();
      B.cleanup();
    }
  });

  test('runCheck 和 runCheckCore 是同一函数引用（alias）', () => {
    assert.strictEqual(session.runCheck, session.runCheckCore, 'runCheck === runCheckCore（alias 引用同一函数）');
  });

  test('runCheckCore 直接 throw（monthKey 缺失）', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      await assert.rejects(
        () => session.runCheckCore({ db: ctx.db.db, monthKey: null, storageRoot: ctx.tmpdir }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('monthKey'));
          return true;
        }
      );
    } finally {
      ctx.cleanup();
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // v2.1.10 A3 Phase 2 T13 — cancelToken 透传 5 阶段间检查
  // ─────────────────────────────────────────────────────────────────

  test('T13.1 — 不传 cancelToken（向后兼容；runCheckCore 行为不变）', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      const result = await session.runCheckCore({
        db: ctx.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: ctx.tmpdir,
      });
      assert.equal(typeof result.runId, 'number', 'runId 是 number');
      assert.equal(result.totalBillRows, 10, 'totalBillRows=10');
      assert.equal(result.mismatchRows, 3, 'mismatchRows=3（fixture）');
      // 不传 cancelToken 应与 v2.1.10 Phase 1 路径完全一致
    } finally {
      ctx.cleanup();
    }
  });

  test('T13.2 — cancelToken.cancelled=true 在 stage 1 (clearing-old-runs) → CancelError + ROLLBACK + DB 无锁残留', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      // 提前 cancel — clearOldRuns 后第一个 check 点立即抛
      const cancelToken = session.createCancelToken();
      cancelToken.cancel();

      let caught;
      try {
        await session.runCheckCore({
          db: ctx.db.db,
          monthKey: FIXTURE_MONTH,
          storageRoot: ctx.tmpdir,
          cancelToken,
        });
      } catch (e) { caught = e; }

      assert.ok(caught, '应 throw');
      assert.equal(caught.name, 'CancelError', `应是 CancelError（实际 name=${caught && caught.name}）`);
      assert.ok(caught.stage, `应带 stage 字段（实际 stage=${caught && caught.stage}）`);
      // 第一个 check 点是 clearing-old-runs；既可能命中 stage 1（clearing-old-runs）也可能命中
      // 启动前快路径（before-start，仅 worker 内）— 这里直调 runCheckCore 走 stage 1 路径
      assert.equal(caught.stage, 'clearing-old-runs', 'stage 应是 clearing-old-runs');

      // DB 无锁残留：手动再起一个事务应成功
      assert.doesNotThrow(() => {
        ctx.db.db.exec('BEGIN');
        ctx.db.db.exec('ROLLBACK');
      }, 'ROLLBACK 后 DB 可正常开新事务');

      // 没有 run 记录写入
      const runCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_runs').get().c;
      assert.equal(runCount, 0, 'cancel 后无 run 记录');
    } finally {
      ctx.cleanup();
    }
  });

  test('T13.3 — cancelToken 在 stage 4 chunked 边界（chunk 0 之前）→ throwIfCancelled + 无 diff_rows 残留', async () => {
    // v2.1.10 A4 T18 改造后：stage 4 (sql-joining) 改为 stage 4' chunked，单 SQL 在事务内不可中断
    //   原"第 4 次 cancel check 命中 sql-joining"语义升级为"chunked 第 0 个 chunk 前 throwIfCancelled"
    //   stage 名变化：'sql-joining' → 'sql-joining-chunk-0'（chunked 内 cancel 边界更精细）
    const ctx = await setupTmpDbWithFixture();
    try {
      // 用 wrapper token：到 stage 4' chunked 边界（第 4 次 check）才 cancel
      // 注意：chunked 内 throwIfCancelled 内部会读 .cancelled getter（getter 计数 +1）
      let cancelled = false;
      let checkCount = 0;
      const cancelToken = {
        get cancelled() {
          checkCount++;
          // 前 3 个 check 点（stage 1-3 主事务内）返回 false，第 4 个（chunk 0 边界）返回 true
          if (checkCount >= 4 && !cancelled) cancelled = true;
          return cancelled;
        },
        cancel() { cancelled = true; },
        throwIfCancelled(stage) {
          if (this.cancelled) {
            const CancelErrorCtor = session.CancelError;
            throw new CancelErrorCtor(`runCheck cancelled at stage=${stage}`, { stage });
          }
        },
      };

      let caught;
      try {
        await session.runCheckCore({
          db: ctx.db.db,
          monthKey: FIXTURE_MONTH,
          storageRoot: ctx.tmpdir,
          cancelToken,
        });
      } catch (e) { caught = e; }

      assert.ok(caught, '应 throw');
      assert.equal(caught.name, 'CancelError');
      // v2.1.10 A4 T18：chunked 边界命中 stage 名为 'sql-joining-chunk-N'（精细化 cancel 时机）
      assert.equal(caught.stage, 'sql-joining-chunk-0', '应在 chunked 第 0 chunk 边界命中');

      // 事务边界：主事务 stage 1-3 已 COMMIT（v2.1.10 A4 T18 改造）
      //   ⚠️ 改造前 stage 4 在主事务内 → cancel ROLLBACK 撤销 runs 写入
      //   改造后 stage 4' 在主事务外 → cancel 时 runs 行已落库（chunk_progress 标 partial 供 resume）
      assert.doesNotThrow(() => {
        ctx.db.db.exec('BEGIN');
        ctx.db.db.exec('ROLLBACK');
      });

      // runs 表已有 1 行（stage 1-3 主事务 COMMIT 写入）
      const runCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_runs').get().c;
      assert.equal(runCount, 1, 'stage 4 cancel — runs 已 COMMIT（v2.1.10 A4 T18 事务边界改造）');

      // chunked 在第 0 chunk 之前抛 → 无 diff_rows 写入
      const diffCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
      assert.equal(diffCount, 0, 'chunk 0 之前 cancel — 无 diff_rows 写入');

      // chunk_progress 应标 partial（caller 决策 resume）
      const run = ctx.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
      assert.ok(run.chunk_progress, 'chunk_progress 已写入');
      const progress = JSON.parse(run.chunk_progress);
      assert.equal(progress.status, 'partial', 'chunk_progress.status=partial');
    } finally {
      ctx.cleanup();
    }
  });

  test('T13.4 — cancelToken 在 stage 5 (写盘前；chunked 全部完成后) → CancelError 但 DB 数据已落库', async () => {
    // v2.1.10 A4 T18 改造后：stage 5 = chunked 全部完成 + 写盘前 cancel check
    //   getter check count 路径（fixture 10 行 < chunk size 10w → totalChunks=1）：
    //     1. clearing-old-runs (主事务内 .cancelled)
    //     2. computing-stats (主事务内 .cancelled)
    //     3. inserting-run (主事务内 .cancelled)
    //     4. chunk 0 之前 throwIfCancelled → 内部读 .cancelled
    //     5. before-writing-xlsx (.cancelled)
    //   第 5 次 check 命中 → CancelError stage='before-writing-xlsx'
    const ctx = await setupTmpDbWithFixture();
    try {
      let cancelled = false;
      let checkCount = 0;
      const cancelToken = {
        get cancelled() {
          checkCount++;
          // 前 4 个 false，第 5 个 true（before-writing-xlsx）
          if (checkCount >= 5 && !cancelled) cancelled = true;
          return cancelled;
        },
        cancel() { cancelled = true; },
        throwIfCancelled(stage) {
          if (this.cancelled) {
            const CancelErrorCtor = session.CancelError;
            throw new CancelErrorCtor(`runCheck cancelled at stage=${stage}`, { stage });
          }
        },
      };

      let caught;
      try {
        await session.runCheckCore({
          db: ctx.db.db,
          monthKey: FIXTURE_MONTH,
          storageRoot: ctx.tmpdir,
          cancelToken,
        });
      } catch (e) { caught = e; }

      assert.ok(caught, '应 throw');
      assert.equal(caught.name, 'CancelError');
      assert.equal(caught.stage, 'before-writing-xlsx', '应在 before-writing-xlsx 阶段命中');

      // 注意：stage 5 时 chunked 已完成 + chunk 各 BEGIN/COMMIT 已结束；run 数据 + diff_rows 已落库
      const runCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_runs').get().c;
      assert.equal(runCount, 1, 'COMMIT 后 run 已落库（cancel 不撤销）');
      const run = ctx.db.db.prepare('SELECT * FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(run.diff_file_path, null, 'cancel 在写盘前 — diff_file_path 仍为 NULL');
      assert.equal(run.report_file_path, null, 'cancel 在写盘前 — report_file_path 仍为 NULL');

      // chunk_progress 应标 complete（chunked 已完整跑完，仅写盘被 cancel）
      assert.ok(run.chunk_progress, 'chunk_progress 已写入');
      const progress = JSON.parse(run.chunk_progress);
      assert.equal(progress.status, 'complete', 'chunked 完整 → chunk_progress.status=complete');
      assert.equal(progress.totalChunks, 1, 'fixture 10 行 / chunkSize 10w = 1 chunk');
      assert.equal(progress.lastCompletedChunkIndex, 0, 'chunk 0 已完成');

      // diff_rows 应有 3 行（fixture 3 个 mismatch；chunked 已完整跑完）
      const diffCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_diff_rows').get().c;
      assert.equal(diffCount, 3, 'chunked 已完整跑完 — diff_rows 写入 3 行');
    } finally {
      ctx.cleanup();
    }
  });

  test('T13.5 — createCancelToken 接口（cancelled / cancel / throwIfCancelled）', () => {
    const token = session.createCancelToken();
    assert.equal(token.cancelled, false, '初始 cancelled=false');
    assert.doesNotThrow(() => token.throwIfCancelled('test'), '未 cancel 时 throwIfCancelled 不抛');
    token.cancel();
    assert.equal(token.cancelled, true, 'cancel() 后 cancelled=true');
    assert.throws(
      () => token.throwIfCancelled('test-stage'),
      (err) => err.name === 'CancelError' && err.stage === 'test-stage',
      'cancel 后 throwIfCancelled 抛 CancelError + 带 stage'
    );
  });

  test('T13.6 — CancelError 类（name + stage 字段 + 继承 Error）', () => {
    const err = new session.CancelError('test msg', { stage: 'foo' });
    assert.equal(err.name, 'CancelError');
    assert.equal(err.message, 'test msg');
    assert.equal(err.stage, 'foo');
    assert.ok(err instanceof Error, 'CancelError 是 Error 子类');
  });

  // ─────────────────────────────────────────────────────────────────
  // v2.1.10 A4 T19 — resumeFromRun 续跑 + idempotent
  // ─────────────────────────────────────────────────────────────────

  test('T19-session.1 — resumeFromRun 中途 cancel 后 resume → 与全新 run byte-for-byte 一致', async () => {
    // A: 全新 run（baseline）
    const A = await setupTmpDbWithFixture();
    const B = await setupTmpDbWithFixture();
    try {
      const resultA = await session.runCheckCore({
        db: A.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: A.tmpdir,
      });

      // B: 第一段 chunked 在第 1 个 chunk 边界 cancel → resume 续跑 → 与 A 比对
      // 用 chunk=2（fixture 10 行 → 5 chunks）让 cancel 容易切片
      let cancelled = false;
      let checkCount = 0;
      const cancelToken = {
        get cancelled() { return cancelled; },
        cancel() { cancelled = true; },
        throwIfCancelled(stage) {
          checkCount++;
          // chunk 2 边界 cancel（先跑 chunk 0/1 完成）
          if (checkCount >= 3) cancelled = true;
          if (cancelled) {
            const CancelErrorCtor = session.CancelError;
            throw new CancelErrorCtor(`cancelled at ${stage}`, { stage });
          }
        },
      };

      let caughtFirst;
      try {
        await session.runCheckCore({
          db: B.db.db,
          monthKey: FIXTURE_MONTH,
          storageRoot: B.tmpdir,
          chunkSize: 2,
          cancelToken,
        });
      } catch (e) { caughtFirst = e; }
      assert.ok(caughtFirst, '第一段应抛 CancelError');
      assert.equal(caughtFirst.name, 'CancelError');
      assert.equal(caughtFirst.stage, 'sql-joining-chunk-2', '第一段在 chunk 2 边界 cancel');

      // 验证：B 第一段 chunk 0/1 已写入；run.chunk_progress=partial
      const runB = B.db.db.prepare('SELECT * FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
      assert.ok(runB.chunk_progress, 'chunk_progress 已写');
      const progressFirst = JSON.parse(runB.chunk_progress);
      assert.equal(progressFirst.status, 'partial');

      // B 第二段：resumeFromRun = { runId, lastCompletedChunkIndex }（不传 cancelToken）
      const resultBResume = await session.runCheckCore({
        db: B.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: B.tmpdir,
        chunkSize: 2,
        resumeFromRun: {
          runId: runB.id,
          lastCompletedChunkIndex: progressFirst.lastCompletedChunkIndex,
        },
      });

      // resume 复用旧 runId
      assert.equal(resultBResume.runId, runB.id, 'resume 复用旧 runId');

      // 比对 stats（resume 后旧 run 行的 stats 复用）— mismatch_rows / total_bill_rows 一致
      assert.equal(resultBResume.totalBillRows, resultA.totalBillRows);
      assert.equal(resultBResume.mismatchRows, resultA.mismatchRows);

      // 比对 diff_rows 内容（按 reconId 排序后 byte-for-byte）
      const snapA = snapshotDiffRowsAndStats(A.db.db);
      const snapB = snapshotDiffRowsAndStats(B.db.db);
      assert.equal(snapA.rowCount, snapB.rowCount, 'diff_rows 行数一致（resume 后）');
      for (let i = 0; i < snapA.rows.length; i++) {
        assert.deepEqual(snapA.rows[i], snapB.rows[i], `resume 后 diff_rows[${i}] byte-for-byte 一致`);
      }

      // resume 后 chunk_progress=complete
      const runBAfter = B.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs WHERE id = ?').get(runB.id);
      const progressAfter = JSON.parse(runBAfter.chunk_progress);
      assert.equal(progressAfter.status, 'complete', 'resume 后 chunk_progress.status=complete');
    } finally {
      A.cleanup();
      B.cleanup();
    }
  });

  test('T19-session.2 — resumeFromRun.runId 不存在 → throw', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      await assert.rejects(
        () => session.runCheckCore({
          db: ctx.db.db,
          monthKey: FIXTURE_MONTH,
          storageRoot: ctx.tmpdir,
          resumeFromRun: { runId: 99999, lastCompletedChunkIndex: 0 },
        }),
        /resumeFromRun: runId=99999 不存在/
      );
    } finally {
      ctx.cleanup();
    }
  });

  test('T19-session.3 — resumeFromRun.runId month_key 不匹配 → throw', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      // 先跑一个 2026-04 的 run，拿 runId；然后用 2026-05 月份 resume 应 throw
      const result = await session.runCheckCore({
        db: ctx.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: ctx.tmpdir,
      });
      await assert.rejects(
        () => session.runCheckCore({
          db: ctx.db.db,
          monthKey: '2026-05', // 不一致
          storageRoot: ctx.tmpdir,
          resumeFromRun: { runId: result.runId, lastCompletedChunkIndex: 0 },
        }),
        /month_key=2026-04 与请求 monthKey=2026-05 不一致/
      );
    } finally {
      ctx.cleanup();
    }
  });

  test('T19-session.4 — chunkSize 默认 100000（不传时）vs 显式传值', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      // 不传 chunkSize → effectiveChunkSize=100000 → totalChunks=1 (10 行 < 10w)
      const result = await session.runCheckCore({
        db: ctx.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: ctx.tmpdir,
      });
      assert.equal(typeof result.runId, 'number');
      const run = ctx.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs WHERE id = ?').get(result.runId);
      const progress = JSON.parse(run.chunk_progress);
      assert.equal(progress.totalChunks, 1, '默认 chunkSize 100000 / 10 行 = 1 chunk');
    } finally {
      ctx.cleanup();
    }
  });

  // v2.1.10 SR-FIX-1 Round 5 G1 — setRunChunkProgress(in-progress) 提前到 COMMIT 后任何 await 前
  //   证明：COMMIT 之后立即写入 chunk_progress.status='in-progress'，不是在 stage 4' 入口
  //   验证方法：用 onProgress hook 在 stage='sql-joining' 时抛错（这是 COMMIT 后第一个 await 之后的第一个 onProgress）
  //     → runCheckCore catches 抛错；此时若 in-progress 占位已在 COMMIT 后写入，则 chunk_progress IS NOT NULL
  //     → 若仍在旧位置（chunked 入口前），则要等 stage 4' onProgress 触发后才写 → 抛错时 chunk_progress IS NULL
  //   Round 4 F2 兜底前置：chunk_progress 必须 IS NOT NULL，failureListener 才能识别为可恢复
  test('T19-session.5 — Round 5 G1：setRunChunkProgress(in-progress) 在 COMMIT 后立即写入（COMMIT → 首 await 之间窗口期 0 缝隙）', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      // 用 onProgress hook 在 stage 4' 入口（sql-joining）抛错模拟 crash
      //   注意：sql-joining 是 COMMIT 之后第一个 onProgress 事件
      //   如果 in-progress 写入在 COMMIT 后（Round 5 G1 修复后），此时 chunk_progress 应已写入
      //   如果还在旧位置（chunked 入口前），此时 chunk_progress 仍是 NULL（旧 bug）
      let caught;
      try {
        await session.runCheckCore({
          db: ctx.db.db,
          monthKey: FIXTURE_MONTH,
          storageRoot: ctx.tmpdir,
          onProgress: (ev) => {
            if (ev.stage === 'sql-joining' && !ev.chunkIndex && ev.chunkIndex !== 0) {
              // chunk 0 的 sql-joining 事件（mismatchHint 字段标识入口事件）
              if (ev.mismatchHint !== undefined) {
                throw new Error('SIMULATED_CRASH_AT_SQL_JOINING_ENTRY');
              }
            }
          },
        });
      } catch (e) { caught = e; }

      // 模拟 crash 应该传播出来
      assert.ok(caught, '应 throw（模拟 crash）');
      assert.match(caught.message, /SIMULATED_CRASH/, 'crash error 被传播');

      // 关键验证：chunk_progress 必须已写入（in-progress），证明 Round 5 G1 写入提前生效
      //   旧 bug：chunk_progress IS NULL → 5.1 失败
      const run = ctx.db.db.prepare('SELECT chunk_progress FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1').get();
      assert.ok(run, '5.0 runs 行 COMMIT 后已落库');
      assert.ok(run.chunk_progress, '5.1 Round 5 G1：COMMIT 后窗口期 chunk_progress IS NOT NULL（旧 bug 此处 IS NULL）');

      const progress = JSON.parse(run.chunk_progress);
      assert.equal(progress.status, 'in-progress', '5.2 chunk_progress.status=in-progress（Round 5 G1 占位）');
      assert.equal(progress.lastCompletedChunkIndex, -1, '5.3 lastCompletedChunkIndex=-1（占位起始值）');
      assert.equal(progress.totalChunks, 0, '5.4 totalChunks=0（占位起始值；待 onChunkDone 覆盖）');

      // 验证 Round 4 F1 链路兼容：listPartialRuns 应能命中 in-progress
      const partials = require('../../../src/backend/acquiring-bill-currency-db/run-repository').listPartialRuns(ctx.db.db, FIXTURE_MONTH);
      assert.equal(partials.length, 1, '5.5 listPartialRuns 命中 in-progress run（Round 4 F1 状态机扩展兼容）');
      assert.equal(partials[0].chunk_progress.status, 'in-progress', '5.6 partials[0].status=in-progress');
    } finally {
      ctx.cleanup();
    }
  });

  // v2.1.10 SR-FIX-1 Round 6 H1 — setRunChunkProgress(in-progress) 与 INSERT runs 同事务原子提交
  //   证明：setRunChunkProgress 在 BEGIN/COMMIT 内，COMMIT 之前；runs 行与 chunk_progress 同事务可见
  //   验证策略：
  //     5.7 / 5.8 / 5.9 — 正常路径：COMMIT 后立即查 runs.chunk_progress IS NOT NULL（与 Round 5 G1 行为相同 — H1 不改变可见性）
  //     5.10 / 5.11 — 模拟"COMMIT 前异常"：safeRollback 后 runs 行不存在 → chunk_progress 也不存在（同事务原子回滚）
  //     5.12 — 模拟硬终止：直接 close DB 不 commit 模拟进程崩 → 重开 DB 后 runs 行不存在（已 ROLLBACK 不可见）
  //   关键不变量：runs 行与 chunk_progress 不存在"runs 已写入但 chunk_progress IS NULL"的中间态
  test('T19-session.6 — Round 6 H1：setRunChunkProgress 与 INSERT runs 同事务原子提交（COMMIT 前写入）', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      // 正常路径：直接跑 runCheckCore 完整一次，再检查 chunk_progress 落地时机
      //   注：H1 修复后 chunk_progress 在 COMMIT 内写入；外部观察行为与 Round 5 G1（COMMIT 后立即写）不可区分
      //   但内部一致性更强：runs 行与 chunk_progress 同事务可见（不存在中间态）
      let crashSnapshot = null;
      await session.runCheckCore({
        db: ctx.db.db,
        monthKey: FIXTURE_MONTH,
        storageRoot: ctx.tmpdir,
        onProgress: (ev) => {
          // stage='sql-joining' 是 COMMIT 之后第一个 onProgress 事件
          //   H1 修复后：此时查 runs，chunk_progress 必须已写入（同事务）
          if (ev.stage === 'sql-joining' && ev.mismatchHint !== undefined && ev.chunkIndex === undefined) {
            const run = ctx.db.db.prepare(
              'SELECT chunk_progress FROM acquiring_bill_currency_runs ORDER BY id DESC LIMIT 1'
            ).get();
            crashSnapshot = run ? run.chunk_progress : null;
          }
        },
      });

      assert.ok(crashSnapshot, '5.7 stage 4 入口时 runs.chunk_progress 已可见（H1 同事务原子 → COMMIT 后立即可见）');
      const snapshotProgress = JSON.parse(crashSnapshot);
      assert.equal(snapshotProgress.status, 'in-progress', '5.8 COMMIT 后立即可见的 chunk_progress.status=in-progress');
      assert.equal(snapshotProgress.lastCompletedChunkIndex, -1, '5.9 占位 lastCompletedChunkIndex=-1');
    } finally {
      ctx.cleanup();
    }
  });

  // T19-session.7 — Round 6 H1：模拟 stage 3 之后 stage 4 入口前异常 → safeRollback 确保 runs 与 chunk_progress 一致回滚
  //   关键：H1 修复前，setRunChunkProgress 在 COMMIT 之后；若 stage 3 cancelToken 命中 → safeRollback 撤销 runs
  //     但若 cancelToken 命中"COMMIT 之后 ↔ setRunChunkProgress 之前"硬终止 → runs 已 COMMIT 但 chunk_progress NULL
  //   H1 修复后，COMMIT 与 setRunChunkProgress 同事务 → 不可能出现 runs 已 COMMIT 但 chunk_progress NULL 的中间态
  test('T19-session.7 — Round 6 H1：cancel at inserting-run（COMMIT 之前）→ safeRollback runs + chunk_progress 同事务回滚', async () => {
    const ctx = await setupTmpDbWithFixture();
    try {
      // 第 3 次 check 点 (inserting-run) cancel → safeRollback 撤销整事务
      let checkCount = 0;
      const cancelToken = {
        get cancelled() {
          checkCount++;
          if (checkCount >= 3) return true;
          return false;
        },
        cancel() {},
        throwIfCancelled() { /* unused */ },
      };
      let caught;
      try {
        await session.runCheckCore({
          db: ctx.db.db,
          monthKey: FIXTURE_MONTH,
          storageRoot: ctx.tmpdir,
          cancelToken,
        });
      } catch (e) { caught = e; }
      assert.ok(caught, '7.1 cancel 抛错');
      assert.equal(caught.name, 'CancelError', '7.2 CancelError');
      // safeRollback 撤销整事务（包括 INSERT runs）
      const runCount = ctx.db.db.prepare('SELECT COUNT(*) c FROM acquiring_bill_currency_runs').get().c;
      assert.equal(runCount, 0, '7.3 stage 3 cancel → safeRollback → runs 行也回滚（事务原子性保证）');
      // chunk_progress 也回滚（同事务）
      const partials = require('../../../src/backend/acquiring-bill-currency-db/run-repository').listPartialRuns(ctx.db.db, FIXTURE_MONTH);
      assert.equal(partials.length, 0, '7.4 chunk_progress 同事务回滚（H1 同事务原子提交保证不可能 NULL 残留）');
    } finally {
      ctx.cleanup();
    }
  });
});
