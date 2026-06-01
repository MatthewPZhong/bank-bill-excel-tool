// v2.1.6 T6 — 收单单据币种校验：对账运行 + 差异行 CRUD
// 主 DB (tool-data.sqlite) acquiring_bill_currency_runs + acquiring_bill_currency_diff_rows
// ⚠️ 资金红线：spec §5.2 核心 SQL JOIN 在 `insertDiffRowsByJoin`

const RUNS_TABLE = 'acquiring_bill_currency_runs';
const DIFF_TABLE = 'acquiring_bill_currency_diff_rows';
const FLOW_TABLE = 'acquiring_bill_currency_flow_imports';
const BILL_TABLE = 'acquiring_bill_currency_bill_imports';

// ⚠️ 资金红线 ⚠️ — v2.1.12 β.1-T2 — chunked 比对 SQL 共用片段（DRY 防漂移）
//
// 单 worker 路径（insertDiffRowsByJoinChunked.chunkStmt）与多 worker 路径
// （buildSelectOnlyChunkSql → run-check-multiworker.runWriteSplitChunks）必须输出
// **完全相同的行（内容 + 物理顺序）**。二者的区别仅在 SELECT 投影头：
//   - 单 worker：`INSERT INTO diff_rows (...) SELECT ?, b.id, f.settle_currency, ... <BODY>`
//   - 多 worker：`SELECT b.id AS bill_import_id, f.settle_currency AS flow_currency, ... <BODY>`
// 其余（FROM 子查询 ORDER BY id ASC LIMIT ? OFFSET ? + INNER JOIN + WHERE）**必须一字不差**。
// 若两处 SQL body 不同步 → byte-for-byte 立即漂移（本任务最大风险）。故 body 抽成单一常量共享。
//
// 占位符约定（两路径一致）：BODY 含 3 个 `?`，顺序固定为 [monthKey, limit, offset]。
//   - 单 worker chunkStmt 在 BODY 之前还有 1 个 `?`(run_id) → 绑定顺序 [runId, monthKey, limit, offset]
//   - 多 worker SELECT-only 无 run_id（run_id 由主进程汇总时作 prefixValues 注入）→ 绑定 [monthKey, limit, offset]
//
// CASE 表达式（diff_type 判定）也共用 —— 单/多 worker 各自带或不带别名，但表达式本体一致。
const DIFF_TYPE_CASE_SQL = `CASE
        WHEN b.settle_currency_norm IS NULL OR b.settle_currency_norm = '' THEN 'bill_currency_missing'
        ELSE 'currency_mismatch'
      END`;

// FROM / JOIN / WHERE 尾段（含子查询 ORDER BY id ASC LIMIT ? OFFSET ?）—— 单/多 worker 共享，一字不改。
//   注：SQLite 的 INSERT ... SELECT ... LIMIT 不支持复合 OFFSET 时 ORDER BY 跨 batch 稳定 ——
//   改用子查询先按 b.id 排序 + LIMIT/OFFSET 限定本批 bill_id 范围，外层 JOIN flow 比对
//   性能：b.id 是 INTEGER PRIMARY KEY AUTOINCREMENT，B-tree 索引天然有序，LIMIT/OFFSET 高效
const DIFF_JOIN_BODY_SQL = `FROM (
      SELECT id, month_key, recon_main_id, settle_currency_norm
      FROM ${BILL_TABLE}
      WHERE month_key = ?
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    ) b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')`;

// 单 worker chunked INSERT 全文（INSERT 头 + run_id 占位 + 业务列 + 共用 BODY）
//   绑定顺序：[runId, monthKey, limit, offset]
const CHUNK_INSERT_SELECT_SQL = `INSERT INTO ${DIFF_TABLE} (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    SELECT
      ?,
      b.id,
      f.settle_currency,
      f.settle_amount_abs,
      ${DIFF_TYPE_CASE_SQL}
    ${DIFF_JOIN_BODY_SQL}`;

// ⚠️ 资金红线 ⚠️ — v2.1.12 β.1-T2 — 多 worker 路径的只读 SELECT（去掉 INSERT 头 + run_id 占位，列加别名）
//   - 与 CHUNK_INSERT_SELECT_SQL **共用 DIFF_TYPE_CASE_SQL + DIFF_JOIN_BODY_SQL**（防漂移）
//   - 输出列别名顺序 = [bill_import_id, flow_currency, flow_amount_abs, diff_type]（= partColumns）
//   - 绑定顺序：[monthKey, limit, offset]（run_id 由主进程汇总时作 prefixValues 注入，不在此 SQL 内）
//   - worker 端 run-check-multiworker-worker.writeChunkToTemp 用本 SQL 的输出列名取值写 temp db
function buildSelectOnlyChunkSql() {
  return `SELECT
      b.id AS bill_import_id,
      f.settle_currency AS flow_currency,
      f.settle_amount_abs AS flow_amount_abs,
      ${DIFF_TYPE_CASE_SQL} AS diff_type
    ${DIFF_JOIN_BODY_SQL}`;
}

// 多 worker 路径列契约（顺序敏感 — byte-for-byte 列映射）
//   partColumns：SELECT 输出别名顺序 = temp db 业务列顺序
//   targetColumns：目标表列 = [run_id(prefix)] + partColumns
const MULTIWORKER_PART_COLUMNS = ['bill_import_id', 'flow_currency', 'flow_amount_abs', 'diff_type'];
const MULTIWORKER_TARGET_COLUMNS = ['run_id', 'bill_import_id', 'flow_currency', 'flow_amount_abs', 'diff_type'];

// v0.14 fix12：显式传 ranAt（ISO 8601 带 Z 后缀），不再依赖 SQLite DEFAULT CURRENT_TIMESTAMP（返回 UTC 无 Z 后缀）
// caller 应传 new Date().toISOString()；caller 不传时仍依赖 DEFAULT（向后兼容旧调用方但语义模糊）
function insertRun(db, { monthKey, totalBillRows, matchedRows, mismatchRows, unmatchedRows, status = 'success', ranAt = null }) {
  if (ranAt) {
    const stmt = db.prepare(`
      INSERT INTO ${RUNS_TABLE}
        (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(monthKey, ranAt, totalBillRows, matchedRows, mismatchRows, unmatchedRows, status);
    return Number(result.lastInsertRowid);
  }
  // fallback：依赖 schema DEFAULT CURRENT_TIMESTAMP（UTC 无 Z）
  const stmt = db.prepare(`
    INSERT INTO ${RUNS_TABLE}
      (month_key, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(monthKey, totalBillRows, matchedRows, mismatchRows, unmatchedRows, status);
  return Number(result.lastInsertRowid);
}

function getRunById(db, runId) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id = ?`).get(runId) || null;
}

function getLatestRun(db, monthKey) {
  return db.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE month_key = ? ORDER BY ran_at DESC, id DESC LIMIT 1`).get(monthKey) || null;
}

// v0.8 fix5：run 完成后写盘成功时回填 diff/report 路径（写盘失败不应回滚 run 记录，仅日志）
function updateRunPaths(db, { runId, diffFilePath, reportFilePath }) {
  db.prepare(`UPDATE ${RUNS_TABLE} SET diff_file_path = ?, report_file_path = ? WHERE id = ?`)
    .run(diffFilePath || null, reportFilePath || null, runId);
}

// PR #50 NewF2：写盘失败后 run.status 改 'success-no-files'，让 cleanupOrphanData 跳过此类可恢复 run
function updateRunStatus(db, { runId, status }) {
  db.prepare(`UPDATE ${RUNS_TABLE} SET status = ? WHERE id = ?`).run(status, runId);
}

// v2.1.8 N1：cleanup 延迟触发标志位（β 方案 — cleanup 移出对账链路）
//   runCheck 成功后 SET=1 → app.before-quit / 进入模块时检查 → 触发清理 → 完成后 SET=0
//   幂等：多次 SET 1 等价；mark 时不查重
function markCleanupPending(db, { runId }) {
  db.prepare(`UPDATE ${RUNS_TABLE} SET cleanup_pending = 1 WHERE id = ?`).run(runId);
}

function clearCleanupPending(db, { runId }) {
  db.prepare(`UPDATE ${RUNS_TABLE} SET cleanup_pending = 0 WHERE id = ?`).run(runId);
}

// 列出所有 cleanup_pending=1 的 runs（按 ran_at 升序，先入先清；spec §三 N1-D4 串行清避免事务冲突）
function listPendingCleanupRuns(db) {
  return db.prepare(`
    SELECT id, month_key, ran_at, status
    FROM ${RUNS_TABLE}
    WHERE cleanup_pending = 1
    ORDER BY ran_at ASC
  `).all();
}

// 清空某月历史 runs + diff_rows（重新运行前调用，避免累积旧 diff_rows）
function clearRunsByMonth(db, monthKey) {
  db.prepare(`DELETE FROM ${DIFF_TABLE} WHERE run_id IN (SELECT id FROM ${RUNS_TABLE} WHERE month_key = ?)`).run(monthKey);
  db.prepare(`DELETE FROM ${RUNS_TABLE} WHERE month_key = ?`).run(monthKey);
}

// 🔴 v2.1.12 β.1 self-review C2（资金红线）：清掉某 run 已插入的 diff_rows（只清本 run，不动 runs 行 / 别的 run）。
//   用于：① MW 汇总半途失败的 catch 兜底（见 insertDiffRowsByJoinMultiWorker）；
//        ② resume 从 chunk 0 重跑前清残留——MW run 在 merge 期被硬杀/cancel-terminate/OOM（不经 catch）
//           会留下部分已 COMMIT 的 chunk + chunk_progress 恒 -1 → resume 单 worker 从 0 全跑，
//           若不先清则 diff_rows 翻倍。resumeFromChunkIndex===0（无可信已完成 chunk）时调用即安全。
function clearDiffRowsByRunId(db, runId) {
  db.prepare(`DELETE FROM ${DIFF_TABLE} WHERE run_id = ?`).run(runId);
}

// ⚠️ 资金红线 ⚠️ — spec §5.2 核心 SQL
// INNER JOIN flow + bill 按 (month_key, recon_main_id)；仅当 settle_currency_norm 不一致时写入 diff_rows
// diff_type:
//   - 单据 settle_currency_norm 为空/NULL → 'bill_currency_missing'
//   - 否则 → 'currency_mismatch'
// 入库时已 LOWER+TRIM 归一到 settle_currency_norm，此处直接比较（spec §5.3 + §3.1/§3.2 实现优化）
// v0.7 fix4：DB 字段重命名 currency_norm → settle_currency_norm / recon_amount_abs → settle_amount_abs
// diff_rows.flow_currency / flow_amount_abs 列名保留（避免 schema 二次变更），内容指向流水侧 settle_*
//
// v2.1.10 A4 T18 — 保留 `insertDiffRowsByJoin` 单条 SQL 版本：
//   1. unit test / 集成测试用作 byte-for-byte contract test 基线（chunked vs non-chunked 必须一致）
//   2. 小数据档（行数 < 1 个 chunk）回退路径优势：单条 SQL 无事务切换开销
//   3. session.runCheckCore 不再直调此函数，改调 insertDiffRowsByJoinChunked（含 chunk=∞ 等价路径）
function insertDiffRowsByJoin(db, { runId, monthKey }) {
  const stmt = db.prepare(`
    INSERT INTO ${DIFF_TABLE} (run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
    SELECT
      ?,
      b.id,
      f.settle_currency,
      f.settle_amount_abs,
      CASE
        WHEN b.settle_currency_norm IS NULL OR b.settle_currency_norm = '' THEN 'bill_currency_missing'
        ELSE 'currency_mismatch'
      END
    FROM ${BILL_TABLE} b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE b.month_key = ?
      AND COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')
  `);
  const result = stmt.run(runId, monthKey);
  return Number(result.changes);
}

// ⚠️ 资金红线 ⚠️ — v2.1.10 A4 T18 — chunked 分批版本（spec §三）
//
// 核心改造目标（PRD §四 D25 必做）：
//   1. cancel 响应 < 5s — 每 chunk 之间 throwIfCancelled → 单 chunk 大小决定 cancel 延迟
//   2. 进度回调精细化 — 每 chunk 完成后 onChunkDone({ chunkIndex, totalChunks, processedRows, elapsedMs })
//   3. 内存峰值 < 200MB — chunk size 10w 行 JOIN 中间结果可控
//
// 事务边界（关键不变量 — 与 session.runCheckCore 协调）：
//   - caller (session.runCheckCore) 已开 BEGIN 包裹 stage 1-3 (clearOldRuns / computeStats / insertRun)
//   - 进 stage 4' 前 caller 必须 COMMIT 主事务 → 让 stage 4' 各 chunk 独立 BEGIN/COMMIT
//   - 各 chunk 内 BEGIN → INSERT (LIMIT/OFFSET 拆) → COMMIT；失败仅 ROLLBACK 本批
//   - cancel 在 chunk 间触发（chunk 内 SQL 不可中断；单 chunk 通常 < 5s）
//
// chunk 数据切片策略（v2.1.10 选定）：
//   - 按 bill_imports.id 排序 + LIMIT/OFFSET（id 自增，单调；OFFSET = chunkIndex * chunkSize）
//   - 单 chunk SQL：在 b.id 子查询里限定 id 范围 → JOIN flow + 比对币种 → INSERT diff_rows
//   - 数据集稳定性：bill_imports 在 runCheckCore 启动时已 COMMIT（import 阶段先完）；chunked 期间无新 bill 插入
//
// 入参：
//   - db                     : 主进程 / worker 共用的 DatabaseSync 实例
//   - { runId, monthKey }    : 与 insertDiffRowsByJoin 一致
//   - chunkSize              : 单 chunk 行数（行/批；默认 100000 由 caller 注入 settings 值）
//   - onChunkDone            : 每 chunk COMMIT 后回调 { chunkIndex, totalChunks, processedRows, insertedDiffRows, elapsedMs }
//   - cancelToken            : 可选；每 chunk 之间 throwIfCancelled
//   - resumeFromChunkIndex   : 可选；T19 resume 路径从指定 chunk 起跑（默认 0 = 全新）
//
// 返回：{ totalChunks, totalProcessedBillRows, totalInsertedDiffRows, lastCompletedChunkIndex }
//   - lastCompletedChunkIndex = -1 表示 0 chunk（空 bill 表）
//   - cancel 抛错前 caller 应捕获 + 写 chunk_progress { lastCompletedChunkIndex, totalChunks, status:'partial' }
function insertDiffRowsByJoinChunked(db, {
  runId,
  monthKey,
  chunkSize = 100000,
  onChunkDone = null,
  cancelToken = null,
  resumeFromChunkIndex = 0,
} = {}) {
  if (!runId || typeof runId !== 'number') {
    throw new Error('insertDiffRowsByJoinChunked: runId 必填且为 number');
  }
  if (!monthKey) {
    throw new Error('insertDiffRowsByJoinChunked: monthKey 必填');
  }
  const cs = Number(chunkSize);
  if (!Number.isInteger(cs) || cs < 1) {
    throw new Error(`insertDiffRowsByJoinChunked: chunkSize 必须为正整数，收到：${JSON.stringify(chunkSize)}`);
  }
  const resumeIdx = Number(resumeFromChunkIndex);
  if (!Number.isInteger(resumeIdx) || resumeIdx < 0) {
    throw new Error(`insertDiffRowsByJoinChunked: resumeFromChunkIndex 必须为非负整数，收到：${JSON.stringify(resumeFromChunkIndex)}`);
  }

  // 步骤 1：COUNT(*) 算出本月总 bill 行数 → 推 totalChunks
  //   注：caller 已 COMMIT 主事务，此 SELECT 可看见 stage 1-3 写入（包括 runs 行）
  const totalBillRows = db.prepare(`
    SELECT COUNT(*) AS c FROM ${BILL_TABLE} WHERE month_key = ?
  `).get(monthKey).c;
  const totalChunks = totalBillRows === 0 ? 0 : Math.ceil(totalBillRows / cs);

  // 0 chunk 边界（空 bill 表）— 直接返回，不触发 onChunkDone
  if (totalChunks === 0) {
    return {
      totalChunks: 0,
      totalProcessedBillRows: 0,
      totalInsertedDiffRows: 0,
      lastCompletedChunkIndex: -1,
    };
  }

  // resume 边界校验：resumeFromChunkIndex >= totalChunks 等价 nothing-to-do
  if (resumeIdx >= totalChunks) {
    return {
      totalChunks,
      totalProcessedBillRows: 0,
      totalInsertedDiffRows: 0,
      lastCompletedChunkIndex: totalChunks - 1, // 等价 complete
    };
  }

  // chunked INSERT SQL — 用 id 范围子查询 + JOIN flow 比对币种
  //   v2.1.12 β.1-T2：SQL body 抽到模块级 CHUNK_INSERT_SELECT_SQL（与多 worker SELECT-only 共用
  //   DIFF_TYPE_CASE_SQL + DIFF_JOIN_BODY_SQL 片段，防 byte-for-byte 漂移；语义/绑定顺序不变）
  const chunkStmt = db.prepare(CHUNK_INSERT_SELECT_SQL);

  let totalProcessedBillRows = 0;
  let totalInsertedDiffRows = 0;
  let lastCompletedChunkIndex = resumeIdx - 1; // 起步 -1（resumeIdx=0 时），实际起跑从 chunk 0

  for (let chunkIndex = resumeIdx; chunkIndex < totalChunks; chunkIndex++) {
    // cancel 检查在 chunk 之间（chunk 内 SQL 不可中断；单 chunk < 5s = cancel 响应 < 5s）
    //   throwIfCancelled 抛 CancelError；caller 捕获后写 chunk_progress { status:'partial' }
    if (cancelToken && typeof cancelToken.throwIfCancelled === 'function') {
      cancelToken.throwIfCancelled(`sql-joining-chunk-${chunkIndex}`);
    } else if (cancelToken && cancelToken.cancelled) {
      // 兜底：cancelToken 是 plain object（无 throwIfCancelled 方法）
      const err = new Error(`runCheck cancelled at chunk=${chunkIndex}`);
      err.name = 'CancelError';
      err.stage = `sql-joining-chunk-${chunkIndex}`;
      throw err;
    }

    const chunkT0 = Date.now();
    const offset = chunkIndex * cs;
    const expectedRows = Math.min(cs, totalBillRows - offset);

    // 各 chunk 独立 BEGIN / COMMIT — 失败仅 ROLLBACK 本批；已 COMMIT 批保留 → resume 不重复
    db.exec('BEGIN');
    let chunkInsertedRows = 0;
    try {
      const result = chunkStmt.run(runId, monthKey, cs, offset);
      chunkInsertedRows = Number(result.changes);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_e) { /* 已 ROLLBACK 或事务已结束 */ }
      // 透传错误 — caller (session.runCheckCore) 决策记 chunk_progress { status:'partial' } 或抛
      throw err;
    }

    lastCompletedChunkIndex = chunkIndex;
    totalProcessedBillRows += expectedRows;
    totalInsertedDiffRows += chunkInsertedRows;

    if (typeof onChunkDone === 'function') {
      try {
        onChunkDone({
          chunkIndex,
          totalChunks,
          processedRows: expectedRows,
          insertedDiffRows: chunkInsertedRows,
          elapsedMs: Date.now() - chunkT0,
        });
      } catch (_callbackErr) {
        // 回调抛错不阻塞主循环（caller 责任处理；防止 progress 回调 bug 卡 chunked）
      }
    }
  }

  return {
    totalChunks,
    totalProcessedBillRows,
    totalInsertedDiffRows,
    lastCompletedChunkIndex,
  };
}

// ⚠️ 资金红线 ⚠️ — v2.1.12 β.1-T2 — 多 worker write-splitting 入口（plan-b）
//
// 决策 A（spec §4 D-β-1）：**只服务全新 run**；resume run 由 caller gate 走单 worker（本函数不处理 resume）。
//
// 与单 worker insertDiffRowsByJoinChunked 的关系：
//   - totalChunks 口径完全一致（COUNT(*) bill WHERE month_key / chunkSize 向上取整）
//   - 每 chunk 的 [monthKey, limit, offset] 与单 worker chunkStmt.run(runId, monthKey, cs, offset) 一致
//   - chunkIndex 0..N-1 升序汇总 → byte-for-byte 等价单 worker 逐 chunk INSERT...SELECT
//   - run_id 由 prefixValues=[runId] 在主进程汇总 INSERT 时注入（SELECT-only SQL 内不含 run_id）
//
// 失败保守处理（任务要点 5 — 不留半套数据）：
//   runWriteSplitChunks 是「全有或全无」：reader 阶段任一 worker 失败 → reject（汇总未执行）；
//   但汇总阶段（mergeTempDbsInOrder）按 chunk 升序逐个独立 BEGIN/COMMIT —— 若汇总到第 K 个 chunk 失败，
//   前 K-1 个已 COMMIT 会残留。故本函数在 catch 里**主动清掉本 run 已插入的 diff_rows**（DELETE WHERE run_id），
//   再透传错误。caller（runCheckCore）据此标 chunk_progress 让后续走单 worker 重跑。务必不留半套数据。
//
// 入参：
//   - db                  : 主进程目标 DB connection（汇总 INSERT + 失败清理；caller 持有）
//   - { runId, monthKey } : 与单 worker 一致
//   - chunkSize           : 单 chunk 行数（caller 自适应分片后注入；正整数）
//   - dbPath              : 主源 sqlite 路径（worker 各自 open 只读 connection）
//   - workerCount         : worker 数 M（caller 按 settings/行数/OOM 决策；必须 ≥1）
//   - tempDir             : temp db 存放目录（caller 提供 run 专属目录；模块写 part-<ci>.sqlite）
//   - onChunkDone         : 可选，每 chunk 汇总进度回调 { chunkIndex, totalChunks, processedRows?, insertedDiffRows?, elapsedMs? }
//                           （与单 worker onChunkDone 同名，便于 caller 复用 chunk_progress 更新逻辑；
//                            注：多 worker 的「完成」语义 = reader 完成该 chunk，processedRows 为本 chunk SELECT 命中前的 bill 行数估算）
//
// 返回（与单 worker insertDiffRowsByJoinChunked 同形状）：
//   { totalChunks, totalProcessedBillRows, totalInsertedDiffRows, lastCompletedChunkIndex }
//   - lastCompletedChunkIndex = totalChunks - 1（成功路径全跑完）；-1 表示 0 chunk
async function insertDiffRowsByJoinMultiWorker(db, {
  runId,
  monthKey,
  chunkSize,
  dbPath,
  workerCount,
  tempDir,
  onChunkDone = null,
} = {}) {
  if (!runId || typeof runId !== 'number') {
    throw new Error('insertDiffRowsByJoinMultiWorker: runId 必填且为 number');
  }
  if (!monthKey) {
    throw new Error('insertDiffRowsByJoinMultiWorker: monthKey 必填');
  }
  const cs = Number(chunkSize);
  if (!Number.isInteger(cs) || cs < 1) {
    throw new Error(`insertDiffRowsByJoinMultiWorker: chunkSize 必须为正整数，收到：${JSON.stringify(chunkSize)}`);
  }
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('insertDiffRowsByJoinMultiWorker: dbPath 必填（worker 各自 open 只读 connection）');
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`insertDiffRowsByJoinMultiWorker: workerCount 必须 ≥1 整数，收到：${JSON.stringify(workerCount)}`);
  }
  if (!tempDir || typeof tempDir !== 'string') {
    throw new Error('insertDiffRowsByJoinMultiWorker: tempDir 必填');
  }

  // 步骤 1：totalChunks 口径与单 worker 完全一致
  const totalBillRows = db.prepare(`
    SELECT COUNT(*) AS c FROM ${BILL_TABLE} WHERE month_key = ?
  `).get(monthKey).c;
  const totalChunks = totalBillRows === 0 ? 0 : Math.ceil(totalBillRows / cs);

  // 0 chunk 边界（空 bill 表）— 与单 worker 返回一致，不起 worker
  if (totalChunks === 0) {
    return {
      totalChunks: 0,
      totalProcessedBillRows: 0,
      totalInsertedDiffRows: 0,
      lastCompletedChunkIndex: -1,
    };
  }

  // 步骤 2：build chunks 列表（chunkIndex 0..N-1 + [monthKey, limit, offset]，与单 worker offset 口径一致）
  const chunks = [];
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    chunks.push({ chunkIndex, bindParams: [monthKey, cs, chunkIndex * cs] });
  }

  // 步骤 3：调多 worker 执行器（lazy require 避免循环依赖 / 启动开销）
  const mw = require('../../main-process/run-check-multiworker');
  const selectSql = buildSelectOnlyChunkSql();

  let result;
  try {
    result = await mw.runWriteSplitChunks({
      db,
      dbPath,
      workerCount,
      chunks,
      selectSql,
      partColumns: MULTIWORKER_PART_COLUMNS,
      targetTable: DIFF_TABLE,
      targetColumns: MULTIWORKER_TARGET_COLUMNS,
      prefixValues: [runId],
      tempDir,
      onProgress: (ev) => {
        // 透传到单 worker 同名 onChunkDone（caller 复用 chunk_progress 更新）
        if (typeof onChunkDone === 'function') {
          try {
            onChunkDone({
              chunkIndex: ev.chunkIndex,
              totalChunks: ev.totalChunks,
              processedRows: Math.min(cs, totalBillRows - ev.chunkIndex * cs),
              insertedDiffRows: ev.rowCount,
              elapsedMs: 0,
            });
          } catch (_e) { /* 回调抛错不阻塞主流程 */ }
        }
      },
    });
  } catch (mwErr) {
    // 🔴 失败保守处理：清掉本 run 已插入的 diff_rows（防汇总半途 COMMIT 残留），再透传错误。
    //   单独 BEGIN/COMMIT；清理失败也不掩盖原始 mwErr（清理错仅吞，原错优先抛）。
    try {
      db.exec('BEGIN');
      try {
        clearDiffRowsByRunId(db, runId);
        db.exec('COMMIT');
      } catch (_delInner) {
        try { db.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
      }
    } catch (_delOuter) {
      // BEGIN 都失败（事务状态异常）— 吞掉，优先抛原始 mwErr
    }
    throw mwErr;
  }

  // 成功路径：全部 chunk 跑完
  return {
    totalChunks,
    totalProcessedBillRows: totalBillRows,
    totalInsertedDiffRows: result.insertedRows,
    lastCompletedChunkIndex: totalChunks - 1,
  };
}

// v2.1.10 A4 T19 — chunk_progress 列读写 API（JSON 序列化）
//   值结构：{ lastCompletedChunkIndex, totalChunks, status: 'in-progress' | 'partial' | 'complete', chunkSize? }
//   - in-progress: 刚开始 chunked stage 4'，totalChunks 已算出（lastCompletedChunkIndex=-1）
//   - partial: cancel 或 crash 中途；lastCompletedChunkIndex 指向最后一个 COMMIT 的 chunk
//   - complete: 所有 chunk 都 COMMIT 完毕
//
// v2.1.10 SR-FIX-1 Round 6 H4：新增 chunkSize 字段（资金红线 — 防 resume 时 chunk size 变化导致行 skip/重复）
//   触发场景（Codex Round 5 四复审 P2 资金红线 finding）：
//     原 partial run 用 chunkSize=100000；用户改 settings 到 chunkSize=10000 后重启 → resume handler 读
//     当前 settings → insertDiffRowsByJoinChunked 用 OFFSET=chunkIndex*chunkSize → 偏移计算错位
//     → diff_rows 行 skip 或重复（与 baseline byte-for-byte 不一致）
//   修复：把 chunkSize 存进 chunk_progress JSON，resume 时优先复用持久化值（不读当前 settings）
//   兼容：老 partial run（升级前的 chunk_progress 没 chunkSize 字段）→ resume handler fallback 当前 settings + warning
function setRunChunkProgress(db, { runId, lastCompletedChunkIndex, totalChunks, status, chunkSize }) {
  if (!runId || typeof runId !== 'number') {
    throw new Error('setRunChunkProgress: runId 必填');
  }
  if (!status || !['in-progress', 'partial', 'complete'].includes(status)) {
    throw new Error(`setRunChunkProgress: status 必须是 in-progress / partial / complete，收到：${JSON.stringify(status)}`);
  }
  const payload = {
    lastCompletedChunkIndex: Number.isFinite(lastCompletedChunkIndex) ? lastCompletedChunkIndex : -1,
    totalChunks: Number.isFinite(totalChunks) ? totalChunks : 0,
    status,
  };
  // Round 6 H4：chunkSize 可选 — 显式传值才写入；不传时不写（向后兼容旧 caller / 旧 row）
  if (Number.isInteger(chunkSize) && chunkSize > 0) {
    payload.chunkSize = chunkSize;
  }
  db.prepare(`UPDATE ${RUNS_TABLE} SET chunk_progress = ? WHERE id = ?`).run(JSON.stringify(payload), runId);
}

function getRunChunkProgress(db, runId) {
  const row = db.prepare(`SELECT chunk_progress FROM ${RUNS_TABLE} WHERE id = ?`).get(runId);
  if (!row || !row.chunk_progress) return null;
  try {
    return JSON.parse(row.chunk_progress);
  } catch (_e) {
    // 防御：旧数据或破坏的 JSON → 视为 null（caller 视为不可 resume）
    return null;
  }
}

// v2.1.10 SR-FIX-1 round 2 P1-5：列出某月所有「可恢复」chunk_progress 状态的 runs
//   触发场景：resume handler 入参不带 runId → 自动找该月最近一个可恢复 run
//   原 resume handler 只取 getLatestRun（最近 1 个 run）→ 如最近 run 是 complete（如刚跑完新 run），
//   前一个 run 是 partial → 用户无法 resume 前一个 partial
//   修复后：扫该月所有可恢复 run.chunk_progress → 按 ran_at DESC 返回 → caller 取第一个
//   性能：每月一般 1-2 个 run；扫描成本 O(N)；JSON 解析 cost 小
//
// v2.1.10 SR-FIX-1 Round 4 F1：扩为 partial OR in-progress 一起返回
//   触发场景：first-chunk crash（onChunkDone 触发前 worker die）+ failureListener 未及时把 in-progress 兜底转 partial
//     → chunk_progress 停留 'in-progress'（Round 3 F2 入口写入）
//     → 用户重启后调 resume → listPartialRuns 不命中 in-progress → 无法 resume
//   修复：SQL 直接 IN ('partial', 'in-progress')，与 cleanupOrphanData 守卫范畴对齐
//     - 函数名保留 listPartialRuns（语义扩为「可恢复 runs」；不改名避免 PR diff 噪音）
//     - caller (resume handler) 已经做 progress.status 二次校验（IN ('partial','in-progress')）
function listPartialRuns(db, monthKey) {
  if (!monthKey) return [];
  const rows = db.prepare(`
    SELECT id, month_key, ran_at, status, chunk_progress
    FROM ${RUNS_TABLE}
    WHERE month_key = ? AND chunk_progress IS NOT NULL
    ORDER BY ran_at DESC, id DESC
  `).all(monthKey);
  const result = [];
  for (const row of rows) {
    try {
      const progress = JSON.parse(row.chunk_progress);
      // v2.1.10 Round 4 F1：partial OR in-progress 均视为可恢复
      if (progress && (progress.status === 'partial' || progress.status === 'in-progress')) {
        result.push({
          id: row.id,
          month_key: row.month_key,
          ran_at: row.ran_at,
          status: row.status,
          chunk_progress: progress,
        });
      }
    } catch (_e) {
      // 破坏的 JSON 跳过（与 getRunChunkProgress 防御一致）
    }
  }
  return result;
}

// 月内统计：单据总数 / matched（JOIN 上的） / mismatch / unmatched（单据有 ID 但流水无）
function computeRunStats(db, { monthKey }) {
  const totalBillRows = db.prepare(`SELECT COUNT(*) AS c FROM ${BILL_TABLE} WHERE month_key = ?`).get(monthKey).c;

  const matchedRows = db.prepare(`
    SELECT COUNT(*) AS c
    FROM ${BILL_TABLE} b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE b.month_key = ?
  `).get(monthKey).c;

  const mismatchRows = db.prepare(`
    SELECT COUNT(*) AS c
    FROM ${BILL_TABLE} b
    INNER JOIN ${FLOW_TABLE} f
      ON f.month_key = b.month_key AND f.recon_main_id = b.recon_main_id
    WHERE b.month_key = ?
      AND COALESCE(b.settle_currency_norm, '') <> COALESCE(f.settle_currency_norm, '')
  `).get(monthKey).c;

  const unmatchedRows = totalBillRows - matchedRows;

  return { totalBillRows, matchedRows, mismatchRows, unmatchedRows };
}

// writer 用：按 source_file 拉某 run 的 diff 行 + 原始 raw_json
function listDiffRowsBySourceFile(db, { runId, sourceFile }) {
  return db.prepare(`
    SELECT
      b.raw_json AS bill_raw_json,
      b.source_row_index AS bill_source_row_index,
      d.flow_currency,
      d.flow_amount_abs,
      d.diff_type
    FROM ${DIFF_TABLE} d
    INNER JOIN ${BILL_TABLE} b ON b.id = d.bill_import_id
    WHERE d.run_id = ? AND b.source_file = ?
    ORDER BY b.source_row_index ASC
  `).all(runId, sourceFile);
}

// v0.8 fix5：合并所有 source_file 的差异行，按 source_file + source_row_index 排序
function listAllDiffRowsByRun(db, { runId }) {
  return db.prepare(`
    SELECT
      b.raw_json AS bill_raw_json,
      b.source_file AS bill_source_file,
      b.source_row_index AS bill_source_row_index,
      d.flow_currency,
      d.flow_amount_abs,
      d.diff_type
    FROM ${DIFF_TABLE} d
    INNER JOIN ${BILL_TABLE} b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
    ORDER BY b.source_file ASC, b.source_row_index ASC
  `).all(runId);
}

// v0.14 fix11：writer 多 sheet 用 — 统计每个账单日期的 diff 行数（按 bill_imports.raw_json '账单日期'）
// 返回 [{ billDate: '2026-03-01', count: 80000 }, ...] 按 billDate ASC
// 用 json_extract 路径 $."账单日期"（中文 key 需引号包裹）
function getBillDateCounts(db, { runId }) {
  return db.prepare(`
    SELECT
      json_extract(b.raw_json, '$."账单日期"') AS bill_date,
      COUNT(*) AS c
    FROM ${DIFF_TABLE} d
    INNER JOIN ${BILL_TABLE} b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
    GROUP BY bill_date
    ORDER BY bill_date ASC
  `).all(runId).map((r) => ({ billDate: r.bill_date || '', count: r.c }));
}

// v0.14 fix11：writer 多 sheet 用 — 按账单日期范围分批拉 diff 行
// 同账单日期内按 source_file + source_row_index 排序保持稳定
function listDiffRowsByDateRange(db, { runId, startDate, endDate, limit, offset }) {
  return db.prepare(`
    SELECT
      b.raw_json AS bill_raw_json,
      d.flow_currency,
      d.flow_amount_abs
    FROM ${DIFF_TABLE} d
    INNER JOIN ${BILL_TABLE} b ON b.id = d.bill_import_id
    WHERE d.run_id = ?
      AND COALESCE(json_extract(b.raw_json, '$."账单日期"'), '') >= ?
      AND COALESCE(json_extract(b.raw_json, '$."账单日期"'), '') <= ?
    ORDER BY json_extract(b.raw_json, '$."账单日期"') ASC, b.source_file ASC, b.source_row_index ASC
    LIMIT ? OFFSET ?
  `).all(runId, startDate, endDate, limit, offset);
}

// writer 用：拉某 run 涉及的所有 source_file（按用户导入的单据文件名 1 对 1 输出）
function listSourceFilesByRun(db, { runId, monthKey }) {
  return db.prepare(`
    SELECT DISTINCT source_file
    FROM ${BILL_TABLE}
    WHERE month_key = ?
    ORDER BY source_file ASC
  `).all(monthKey).map((r) => r.source_file);
}

module.exports = {
  insertRun,
  getRunById,
  getLatestRun,
  updateRunPaths,
  updateRunStatus,
  clearRunsByMonth,
  clearDiffRowsByRunId,
  insertDiffRowsByJoin,
  // v2.1.10 A4 T18 / T19：chunked 分批 + chunk_progress
  insertDiffRowsByJoinChunked,
  // v2.1.12 β.1-T2：多 worker write-splitting 入口（plan-b）+ SELECT-only SQL（共用 body 防漂移）
  insertDiffRowsByJoinMultiWorker,
  buildSelectOnlyChunkSql,
  MULTIWORKER_PART_COLUMNS,
  MULTIWORKER_TARGET_COLUMNS,
  setRunChunkProgress,
  getRunChunkProgress,
  // v2.1.10 SR-FIX-1 round 2 P1-5：列出某月所有 partial run（用于 resume handler）
  listPartialRuns,
  computeRunStats,
  listDiffRowsBySourceFile,
  listAllDiffRowsByRun,
  getBillDateCounts,
  listDiffRowsByDateRange,
  listSourceFilesByRun,
  // v2.1.8 N1：cleanup 延迟触发标志位 API
  markCleanupPending,
  clearCleanupPending,
  listPendingCleanupRuns
};
