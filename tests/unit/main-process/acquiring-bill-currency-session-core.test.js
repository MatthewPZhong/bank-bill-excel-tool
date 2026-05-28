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
});
