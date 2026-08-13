// v3.0.5 PR-3（Part B Phase 1）— 收单 per-月侧库编排层 🔴🔴 资金红线（差异表数据完整性）
//
// 职责：在 main.js IPC handler 与既有 session/worker 之间插一层，把 acquiring 的 run 级三表
//   （flow/bill/diff_imports + 侧库内 runs 影子表）的读写路由到 per-月侧库文件，主库只保留
//   runs 元数据镜像行（side_db_rel_path + 侧库 runId + summary + 路径/状态），实现：
//     - 写路径切换：import / runCheck 全部落侧库（runCheckCore 5 阶段、JOIN SQL、epsilon 零改动 —
//       它只是拿到「侧库 db 句柄 / 侧库 dbPath」而非主库）。
//     - 双源读路径（B-D2）：主库 runs 行有 side_db_rel_path → 读侧库；NULL → 读主库旧表（历史 run 零变化）。
//     - retention 文件级二态（B-D4）：整文件删 / 仅保留 diff（侧库内删 flow/bill imports 行）。
//     - 孤儿双向兜底（B.6）：扫侧库目录 vs 主库 runs 元数据，有文件无元数据删文件、有元数据无文件标失效。
//
// 关键不变量：
//   1. 🔴 runCheckCore / writer / run-repository 的 SQL 一字不改；它们在「侧库 db 句柄」上运行 = 在主库上运行
//      （三表同库 JOIN 自洽）。parity byte-for-byte 由 acquiring-side-db-parity.js 集成脚本锁死。
//   2. 主库 runs 镜像行：summary（total/matched/mismatch/unmatched）+ status + diff_file_path + report_file_path
//      + side_db_rel_path（非空标识侧库 run）+ side_run_id（侧库自增 runId，写盘/重导出按 month 取最新即可，
//      不强依赖；保留便于排查）。镜像写在 runCheck 成功返回后由本层落主库。
//   3. UI 列表/状态/导出走主库 runs 镜像（getLatestRun 等）；差异 xlsx 物理文件在 exports/（filesystem），
//      export handler 读 diff_file_path 直接 copy，不读 DB diff_rows → 侧库迁移对 export 透明。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const session = require('./acquiring-bill-currency-session');
const importRepo = require('../backend/acquiring-bill-currency-db/import-repository');
const runRepo = require('../backend/acquiring-bill-currency-db/run-repository');
const runDataStore = require('../backend/run-data-store');
const { appendModuleLog } = require('../backend/logger');

const MODULE = runDataStore.MODULE_ACQUIRING;
const RUNS_TABLE = 'acquiring_bill_currency_runs';

// ── 主库 runs 镜像行 helpers（侧库 run → 主库元数据，含 side_db_rel_path）──

// upsert 主库 runs 镜像行（同 monthKey 保留单镜像行：先删该月旧镜像，再插新；与 clearRunsByMonth 月级语义一致）。
//   注：主库镜像不带 diff_rows（diff 在侧库）；仅记 summary + 路径 + side_db_rel_path + 侧库 runId。
//   side_run_id 复用既有列承载？— 主库镜像行用 status/summary/路径列；side_run_id 经 chunk_progress？否。
//   决策：主库镜像只用既有列 + 新 side_db_rel_path；侧库 runId 不入主库（重导出/写盘按 month 取侧库最新 run）。
function upsertMainRunMirror(mainDb, { monthKey, relPath, stats, status, diffFilePath, reportFilePath, ranAt }) {
  mainDb.exec('BEGIN');
  try {
    // 月级覆盖：删该月旧主库镜像行（侧库已 clearRunsByMonth 月内清旧 run；主库镜像也保留单行最新）
    mainDb.prepare(`DELETE FROM ${RUNS_TABLE} WHERE month_key = ?`).run(monthKey);
    mainDb.prepare(`
      INSERT INTO ${RUNS_TABLE}
        (month_key, ran_at, total_bill_rows, matched_rows, mismatch_rows, unmatched_rows, status,
         diff_file_path, report_file_path, side_db_rel_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      monthKey,
      ranAt,
      stats.totalBillRows,
      stats.matchedRows,
      stats.mismatchRows,
      stats.unmatchedRows,
      status,
      diffFilePath || null,
      reportFilePath || null,
      relPath
    );
    mainDb.exec('COMMIT');
  } catch (err) {
    try { mainDb.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
    throw err;
  }
}

// ── 写路径：import（落侧库）──

// import flow/bill：打开（必要时建）该月侧库，把导入路由到侧库 db / 侧库 dbPath。
//   引擎路径走侧库 dbPath（worker 自开侧库连接写）；回退路径走侧库 db 句柄（reader-handrolled 直调）。
//   userDataDir = path.dirname(database.dbPath)。
async function importFiles({ userDataDir, kind, monthKey, filePaths, onProgress, overwrite = false, batchContext }) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try {
    const fn = overwrite
      ? (kind === 'flow' ? session.importFlowFilesWithOverwrite : session.importBillFilesWithOverwrite)
      : (kind === 'flow' ? session.importFlowFiles : session.importBillFiles);
    // session 内部 resolveDbPath(sideDb) → 侧库文件路径 → 引擎 worker 自开侧库连接；
    //   回退路径用 sideDb 句柄直接 INSERT。两路都落侧库。
    return await fn({ db: sideDb, monthKey, filePaths, onProgress, batchContext });
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
}

// peek 预检：existingCount 需查侧库（该月已导入行数）。侧库不存在 → existingCount=0（首次导入）。
//   monthKey 来自首文件解析（与既有 peekImportTarget 同语义）；本层只在拿到 monthKey 后查侧库就绪。
async function peekImportTarget({ userDataDir, kind, filePaths }) {
  // peek 的表头校验 + 月份提取不依赖 DB（引擎/旧 reader 读 xlsx），用内存库占位拿 monthKey 再查侧库。
  //   复用 session.peekImportTarget 的「读 xlsx 取 monthKey」逻辑：传一个临时 sideDb（按解析出的 month
  //   还无法预知 → 先用 in-memory 占位 db 走 peek 拿 monthKey，再单独查侧库 existingCount）。
  // 简化：session.peekImportTarget 内 getMonthReadiness 依赖传入 db；这里先用「先解析 monthKey 再查侧库」。
  //   但 session.peekImportTarget 一次性返回 monthKey + existingCount，需 db。故传一个空 in-memory 占位库
  //   只为拿 monthKey（existingCount 占位 0），随后用真实侧库覆盖 existingCount。
  const placeholder = new DatabaseSync(':memory:');
  // 占位库需有两表（getMonthReadiness COUNT 用）；建最小 schema（仅 month_key 列即可 COUNT 出 0）。
  placeholder.exec(`
    CREATE TABLE acquiring_bill_currency_flow_imports (month_key TEXT);
    CREATE TABLE acquiring_bill_currency_bill_imports (month_key TEXT);
  `);
  let monthKey;
  try {
    const peeked = await session.peekImportTarget({ db: placeholder, kind, filePaths });
    monthKey = peeked.monthKey;
  } finally {
    try { placeholder.close(); } catch (_e) { /* swallow */ }
  }
  // 真实 existingCount：查该月侧库（不存在 → 0）
  let existingCount = 0;
  const sideDbFilePath = runDataStore.sideDbPath(userDataDir, MODULE, monthKey);
  if (fs.existsSync(sideDbFilePath)) {
    // prepare 阶段必须严格只读：openSideDb 会 mkdir、执行 PRAGMA 并跑幂等 DDL，不能用于覆盖确认预检。
    // 这里直接以 readOnly 打开既有侧库；不存在时上面的 exists 分支返回 0，既不建目录也不建库。
    const sideDb = new DatabaseSync(sideDbFilePath, { readOnly: true });
    try {
      const readiness = importRepo.getMonthReadiness(sideDb, monthKey);
      existingCount = kind === 'flow' ? readiness.flowCount : readiness.billCount;
    } finally {
      try { sideDb.close(); } catch (_e) { /* swallow */ }
    }
  }
  return { monthKey, existingCount, kind };
}

// ── 写路径：runCheck（侧库内跑 + 主库镜像）──

// runCheck 经 worker pool dispatch：worker 打开「该月侧库 dbPath」跑 runCheckCore（5 阶段全在侧库）。
//   成功后本层把 summary + 路径 + side_db_rel_path 镜像写主库 runs（UI/导出读主库镜像）。
//   返回 worker 的 result（含侧库 runId / stats / diffFilePath / reportFilePath）。
//   dispatchFn：注入 runCheckWorkerPool.dispatchRunCheck（main.js 传入，避免本层 require electron 链）。
async function runCheckViaSideDb({ userDataDir, monthKey, storageRoot, chunkSize, workerCount, tempDir, batchContext, dispatchFn, dispatchCallbacks, mainDb }) {
  // 确保侧库存在（import 已建；防御性 open 一次建表后立即 close — worker 会自开侧库连接）
  const sideDbFilePath = runDataStore.sideDbPath(userDataDir, MODULE, monthKey);
  if (!fs.existsSync(sideDbFilePath)) {
    // 侧库不存在 = 该月未导入 → runCheckCore 会抛「流水/单据表尚未导入」；建空库让错误信息一致
    const tmp = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
    try { /* 仅建表 */ } finally { try { tmp.close(); } catch (_e) { /* swallow */ } }
  }

  // worker pool dispatch：__dbPath = 侧库路径（worker 自开侧库连接，多 worker 子 worker 也用此路径）
  const result = await dispatchFn(
    {
      __dbPath: sideDbFilePath,
      monthKey,
      storageRoot,
      chunkSize,
      workerCount,
      tempDir,
      batchContext,
    },
    dispatchCallbacks
  );

  // 成功 → 主库 runs 镜像（summary + 路径 + side_db_rel_path）。
  //   worker 已在侧库内写 runs/diff + 写盘 diff.xlsx + 回填侧库 runs.diff_file_path；
  //   这里把镜像落主库供 UI getLatestRun/listMonths/export 读。
  const relPath = runDataStore.sideDbRelPath(MODULE, monthKey);
  upsertMainRunMirror(mainDb, {
    monthKey,
    relPath,
    stats: {
      totalBillRows: result.totalBillRows,
      matchedRows: result.matchedRows,
      mismatchRows: result.mismatchRows,
      unmatchedRows: result.unmatchedRows,
    },
    status: 'success',
    diffFilePath: result.diffFilePath || null,
    reportFilePath: result.reportFilePath || null,
    ranAt: new Date().toISOString(),
  });

  return result;
}

function resumeError(message, code = 'ACQUIRING_RUN_RESUME_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function runFileEvidence(filePath) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return null;
  let stat;
  try {
    stat = fs.statSync(normalized);
  } catch (_error) {
    throw resumeError(`run 输出文件不存在：${normalized}`);
  }
  if (!stat.isFile()) throw resumeError(`run 输出路径不是文件：${normalized}`);
  return {
    filePath: normalized,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function runEvidence(run) {
  return {
    id: Number(run.id),
    monthKey: String(run.month_key || ''),
    ranAt: String(run.ran_at || ''),
    totalBillRows: Number(run.total_bill_rows),
    matchedRows: Number(run.matched_rows),
    mismatchRows: Number(run.mismatch_rows),
    unmatchedRows: Number(run.unmatched_rows),
    status: String(run.status || ''),
    diffFile: runFileEvidence(run.diff_file_path),
    reportFile: runFileEvidence(run.report_file_path)
  };
}

function sameRunResult(left, right) {
  return Boolean(
    left
    && right
    && left.month_key === right.month_key
    && Number(left.total_bill_rows) === Number(right.total_bill_rows)
    && Number(left.matched_rows) === Number(right.matched_rows)
    && Number(left.mismatch_rows) === Number(right.mismatch_rows)
    && Number(left.unmatched_rows) === Number(right.unmatched_rows)
    && String(left.status || '') === String(right.status || '')
    && String(left.diff_file_path || '') === String(right.diff_file_path || '')
    && String(left.report_file_path || '') === String(right.report_file_path || '')
  );
}

function prepareRunExport({ userDataDir, mainDb, monthKey }) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    throw resumeError('monthKey 格式错误（应为 YYYY-MM）');
  }
  const mirror = runRepo.getLatestRun(mainDb, monthKey);
  if (!mirror) throw resumeError(`月份 ${monthKey} 暂无 run 记录，请先点「开始运行」`);

  let source = 'main';
  let run = mirror;
  let dbPath = '';
  if (mirror.side_db_rel_path) {
    const expectedRelPath = runDataStore.sideDbRelPath(MODULE, monthKey);
    if (mirror.side_db_rel_path !== expectedRelPath) {
      throw resumeError(`月份 ${monthKey} 的侧库镜像路径与选择结果不一致`);
    }
    dbPath = runDataStore.sideDbPath(userDataDir, MODULE, monthKey);
    if (!fs.existsSync(dbPath)) throw resumeError(`月份 ${monthKey} 的侧库文件不存在`);
    const sideDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const candidates = sideDb.prepare(`
        SELECT * FROM ${RUNS_TABLE} WHERE month_key = ?
      `).all(monthKey).filter((candidate) => sameRunResult(candidate, mirror));
      if (candidates.length !== 1) {
        throw resumeError(`月份 ${monthKey} 的主库镜像无法唯一对应侧库 run`);
      }
      [run] = candidates;
      source = 'side';
    } finally {
      try { sideDb.close(); } catch (_error) { /* swallow */ }
    }
  }
  const diffFile = runFileEvidence(run.diff_file_path);
  if (!diffFile) throw resumeError(`月份 ${monthKey} 的差异表文件不存在，请重新「开始运行」`);
  const runId = Number(run.id);
  const flowIdentity = {
    type: 'business-run-id',
    value: `acquiring-run:${source}:${monthKey}:${runId}`
  };
  return {
    source,
    dbPath,
    monthKey,
    runId,
    mirrorId: Number(mirror.id),
    diffFilePath: diffFile.filePath,
    evidence: JSON.stringify({
      source,
      monthKey,
      runId,
      mirrorId: Number(mirror.id),
      mirror: runEvidence({ ...mirror, report_file_path: null }),
      sourceRun: runEvidence({ ...run, report_file_path: null })
    }),
    flowIdentity,
    flowPlan: { startsNewFlow: false, flowIdentity }
  };
}

function assertRunExportFresh({ userDataDir, mainDb, prepared }) {
  const current = prepareRunExport({
    userDataDir,
    mainDb,
    monthKey: prepared.monthKey
  });
  if (current.evidence !== prepared.evidence
      || JSON.stringify(current.flowIdentity) !== JSON.stringify(prepared.flowIdentity)) {
    throw resumeError('收单差异运行结果在导出确认期间已变化，请重新导出');
  }
}

function readResumeTarget(db, { monthKey, runId, allowCompleted = false }) {
  let run = null;
  let progress = null;
  if (runId !== undefined && runId !== null && runId !== '') {
    const normalizedRunId = Number(runId);
    if (!Number.isSafeInteger(normalizedRunId) || normalizedRunId < 1) {
      throw resumeError('runId 格式错误');
    }
    run = runRepo.getRunById(db, normalizedRunId);
    if (!run || run.month_key !== monthKey) {
      throw resumeError(`run ${normalizedRunId} 不存在或不属于月份 ${monthKey}`);
    }
    progress = runRepo.getRunChunkProgress(db, normalizedRunId);
  } else {
    const candidates = runRepo.listPartialRuns(db, monthKey);
    if (candidates.length > 0) {
      run = candidates[0];
      progress = candidates[0].chunk_progress;
    }
    if (!run && allowCompleted) {
      const completed = db.prepare(`
        SELECT * FROM ${RUNS_TABLE}
        WHERE month_key = ? AND chunk_progress IS NOT NULL
      `).all(monthKey).filter((candidate) => {
        const candidateProgress = runRepo.getRunChunkProgress(db, Number(candidate.id));
        if (!candidateProgress || candidateProgress.status !== 'complete') return false;
        try {
          return Boolean(runRepo.readRunProgressBatchContext(candidateProgress));
        } catch (_error) {
          return false;
        }
      });
      if (completed.length > 1) {
        throw resumeError(`月份 ${monthKey} 存在多个已完成恢复候选，无法确定原任务`);
      }
      if (completed.length === 1) {
        [run] = completed;
        progress = runRepo.getRunChunkProgress(db, Number(run.id));
      }
    }
  }
  if (!run || !progress) {
    throw resumeError(`月份 ${monthKey} 暂无可恢复 run`);
  }
  if (!['partial', 'in-progress', 'data-complete'].includes(progress.status)
      && !(allowCompleted && progress.status === 'complete')) {
    throw resumeError(`run ${run.id} 状态为 ${progress.status}，无需 resume`);
  }
  return { run, progress };
}

function openResumeSource({ userDataDir, mainDb, mainDbPath, monthKey }) {
  const sideDbFilePath = runDataStore.sideDbPath(userDataDir, MODULE, monthKey);
  if (fs.existsSync(sideDbFilePath)) {
    const db = new DatabaseSync(sideDbFilePath, { readOnly: true });
    return { db, dbPath: sideDbFilePath, source: 'side', close: true };
  }
  return { db: mainDb, dbPath: mainDbPath, source: 'main', close: false };
}

// Fresh run 的 prepare 阶段只读探测已绑定 exact-seven 的可恢复 run。
// 返回原 batchContext 交由主进程核对权威 taskStatus；legacy/no-context run 不在这里猜测所有权。
function findBoundResumableRun({ userDataDir, mainDb, mainDbPath, monthKey }) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const source = openResumeSource({ userDataDir, mainDb, mainDbPath, monthKey });
  try {
    for (const run of runRepo.listPartialRuns(source.db, monthKey)) {
      const batchContext = runRepo.readRunProgressBatchContext(run.chunk_progress);
      if (!batchContext) continue;
      return {
        source: source.source,
        dbPath: source.dbPath,
        monthKey,
        runId: Number(run.id),
        progress: { ...run.chunk_progress },
        batchContext
      };
    }
    return null;
  } finally {
    if (source.close) {
      try { source.db.close(); } catch (_error) { /* swallow */ }
    }
  }
}

function prepareRunResume({ userDataDir, mainDb, mainDbPath, monthKey, runId }) {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    throw resumeError('monthKey 格式错误（应为 YYYY-MM）');
  }
  const source = openResumeSource({ userDataDir, mainDb, mainDbPath, monthKey });
  try {
    const target = readResumeTarget(source.db, {
      monthKey,
      runId,
      allowCompleted: source.source === 'side'
    });
    const batchContext = runRepo.readRunProgressBatchContext(target.progress);
    const completed = target.progress.status === 'complete';
    if (completed && (!batchContext || target.run.status !== 'success')) {
      throw resumeError(`run ${target.run.id} 已完成但缺少可恢复的原批次证据`);
    }
    const completedRunEvidence = completed ? runEvidence(target.run) : null;
    if (completed && (!completedRunEvidence.diffFile || !completedRunEvidence.reportFile)) {
      throw resumeError(`run ${target.run.id} 已完成但输出文件证据不完整`);
    }
    // 侧库是在 v3.0.5 引入，早于 v3.1.9 batchContext。升级前已存在的 partial/in-progress
    // side run 因此可以合法缺少上下文；与主库 legacy run 一样，首次 resume 用稳定 identity
    // 预留/复用一个兼容批次，并在 worker 开始前回填到原 run。
    const stableRunIdentity = `${source.source}:${monthKey}:${Number(target.run.id)}`;
    const evidence = {
      source: source.source,
      monthKey,
      runId: Number(target.run.id)
    };
    const recovery = batchContext
      ? { batchContext, evidence }
      : {
        legacy: true,
        evidence
      };
    return {
      source: source.source,
      dbPath: source.dbPath,
      monthKey,
      runId: Number(target.run.id),
      progress: { ...target.progress },
      progressEvidence: JSON.stringify(target.progress),
      mode: completed ? 'completed' : 'resume',
      ...(completed ? { runEvidence: completedRunEvidence } : {}),
      recovery,
      taskRunId: batchContext
        ? batchContext.taskRunId
        : `acquiring-resume:${stableRunIdentity}`,
      operationKey: batchContext
        ? batchContext.operationKey
        : `acquiringBillCurrency:run:resume:${stableRunIdentity}`,
      flowPlan: batchContext
        ? null
        : {
          startsNewFlow: false,
          flowIdentity: {
            type: 'business-run-id',
            value: `acquiring-run:${stableRunIdentity}`
          }
        }
    };
  } finally {
    if (source.close) {
      try { source.db.close(); } catch (_error) { /* swallow */ }
    }
  }
}

function assertRunResumeFresh({ userDataDir, mainDb, mainDbPath, prepared }) {
  const source = openResumeSource({
    userDataDir,
    mainDb,
    mainDbPath,
    monthKey: prepared.monthKey
  });
  try {
    if (source.source !== prepared.source || source.dbPath !== prepared.dbPath) {
      throw resumeError('恢复数据源在任务开始前已变化');
    }
    const target = readResumeTarget(source.db, {
      monthKey: prepared.monthKey,
      runId: prepared.runId,
      allowCompleted: prepared.mode === 'completed'
    });
    if (JSON.stringify(target.progress) !== prepared.progressEvidence) {
      throw resumeError(`run ${prepared.runId} 的恢复进度在任务开始前已变化`);
    }
    const currentContext = runRepo.readRunProgressBatchContext(target.progress);
    const expectedContext = prepared.recovery.batchContext || null;
    if (JSON.stringify(currentContext) !== JSON.stringify(expectedContext)) {
      throw resumeError(`run ${prepared.runId} 的批次上下文在任务开始前已变化`);
    }
    if (prepared.mode === 'completed'
        && JSON.stringify(runEvidence(target.run)) !== JSON.stringify(prepared.runEvidence)) {
      throw resumeError(`run ${prepared.runId} 的已完成结果在任务开始前已变化`);
    }
  } finally {
    if (source.close) {
      try { source.db.close(); } catch (_error) { /* swallow */ }
    }
  }
}

function persistRunResumeBatchContext({ userDataDir, mainDb, prepared, batchContext }) {
  let db = mainDb;
  let close = false;
  if (prepared.source === 'side') {
    db = new DatabaseSync(prepared.dbPath);
    close = true;
  }
  try {
    const current = runRepo.getRunChunkProgress(db, prepared.runId);
    if (!current || !['partial', 'in-progress', 'data-complete'].includes(current.status)) {
      throw resumeError(`run ${prepared.runId} 已不可恢复`);
    }
    const currentBatchContext = runRepo.readRunProgressBatchContext(current);
    if (currentBatchContext) {
      if (JSON.stringify(currentBatchContext) !== JSON.stringify(batchContext)) {
        throw resumeError(
          `run ${prepared.runId} 已绑定其它批次上下文`,
          'ACQUIRING_RUN_BATCH_CONTEXT_CONFLICT'
        );
      }
      return currentBatchContext;
    }
    runRepo.setRunChunkProgress(db, {
      runId: prepared.runId,
      lastCompletedChunkIndex: current.lastCompletedChunkIndex,
      totalChunks: current.totalChunks,
      status: current.status,
      chunkSize: current.chunkSize,
      batchContext
    });
    return runRepo.readRunProgressBatchContext(
      runRepo.getRunChunkProgress(db, prepared.runId)
    );
  } finally {
    if (close) {
      try { db.close(); } catch (_error) { /* swallow */ }
    }
  }
}

async function resumeRunCheck({
  prepared,
  storageRoot,
  chunkSize,
  batchContext,
  dispatchFn,
  dispatchCallbacks,
  mainDb
}) {
  if (prepared.mode === 'completed') {
    ensureCompletedMainRunMirror(mainDb, prepared);
    return {
      runId: prepared.runId,
      totalBillRows: prepared.runEvidence.totalBillRows,
      matchedRows: prepared.runEvidence.matchedRows,
      mismatchRows: prepared.runEvidence.mismatchRows,
      unmatchedRows: prepared.runEvidence.unmatchedRows,
      diffFilePath: prepared.runEvidence.diffFile && prepared.runEvidence.diffFile.filePath,
      reportFilePath: prepared.runEvidence.reportFile && prepared.runEvidence.reportFile.filePath
    };
  }
  const result = await dispatchFn({
    __dbPath: prepared.dbPath,
    monthKey: prepared.monthKey,
    storageRoot,
    chunkSize,
    batchContext,
    resumeFromRun: {
      runId: prepared.runId,
      lastCompletedChunkIndex: prepared.progress.lastCompletedChunkIndex
    }
  }, dispatchCallbacks);

  if (prepared.source === 'side') {
    upsertMainRunMirror(mainDb, {
      monthKey: prepared.monthKey,
      relPath: runDataStore.sideDbRelPath(MODULE, prepared.monthKey),
      stats: {
        totalBillRows: result.totalBillRows,
        matchedRows: result.matchedRows,
        mismatchRows: result.mismatchRows,
        unmatchedRows: result.unmatchedRows,
      },
      status: 'success',
      diffFilePath: result.diffFilePath || null,
      reportFilePath: result.reportFilePath || null,
      ranAt: new Date().toISOString(),
    });
  }
  return result;
}

function mainMirrorMatchesCompletedRun(row, prepared) {
  const evidence = prepared.runEvidence;
  return Boolean(
    row
    && row.month_key === prepared.monthKey
    && row.side_db_rel_path === runDataStore.sideDbRelPath(MODULE, prepared.monthKey)
    && Number(row.total_bill_rows) === evidence.totalBillRows
    && Number(row.matched_rows) === evidence.matchedRows
    && Number(row.mismatch_rows) === evidence.mismatchRows
    && Number(row.unmatched_rows) === evidence.unmatchedRows
    && String(row.status || '') === evidence.status
    && String(row.diff_file_path || '') === String(evidence.diffFile && evidence.diffFile.filePath || '')
    && String(row.report_file_path || '') === String(evidence.reportFile && evidence.reportFile.filePath || '')
  );
}

function ensureCompletedMainRunMirror(mainDb, prepared) {
  if (!prepared || prepared.source !== 'side' || prepared.mode !== 'completed'
      || !prepared.runEvidence) {
    throw resumeError('已完成 run 的主库镜像恢复证据不完整');
  }
  const existing = mainDb.prepare(`
    SELECT * FROM ${RUNS_TABLE} WHERE month_key = ?
  `).all(prepared.monthKey);
  if (existing.length === 1 && mainMirrorMatchesCompletedRun(existing[0], prepared)) {
    return { created: false, runId: Number(existing[0].id) };
  }
  upsertMainRunMirror(mainDb, {
    monthKey: prepared.monthKey,
    relPath: runDataStore.sideDbRelPath(MODULE, prepared.monthKey),
    stats: {
      totalBillRows: prepared.runEvidence.totalBillRows,
      matchedRows: prepared.runEvidence.matchedRows,
      mismatchRows: prepared.runEvidence.mismatchRows,
      unmatchedRows: prepared.runEvidence.unmatchedRows
    },
    status: prepared.runEvidence.status,
    diffFilePath: prepared.runEvidence.diffFile && prepared.runEvidence.diffFile.filePath,
    reportFilePath: prepared.runEvidence.reportFile && prepared.runEvidence.reportFile.filePath,
    ranAt: prepared.runEvidence.ranAt
  });
  return {
    created: true,
    runId: Number(mainDb.prepare(`
      SELECT id FROM ${RUNS_TABLE} WHERE month_key = ?
    `).get(prepared.monthKey).id)
  };
}

// ── 双源读路径（B-D2）──

// listMonths：合并侧库目录的 month（新 run）+ 主库旧表 imports 的 month（历史 run）。
//   侧库 month：扫 run-data/{module}/ 目录文件名。
//   主库 month：importRepo.listMonths(mainDb)（历史主库 imports；新 run 不再写主库 imports 故不重复）。
function listMonthsDualSource({ userDataDir, mainDb }) {
  const set = new Set();
  // 侧库（新 run）
  for (const f of runDataStore.listSideDbFiles(userDataDir, MODULE)) set.add(f.monthKey);
  // 主库旧表（历史 run，双源过渡）
  try {
    for (const m of importRepo.listMonths(mainDb)) set.add(m);
  } catch (_e) { /* 主库表异常不阻断侧库 month */ }
  // 降序（与 importRepo.listMonths ORDER BY month_key DESC 口径一致）
  return Array.from(set).sort().reverse();
}

// getSessionStatus：双源——侧库存在 → 读侧库 readiness + 主库 runs 镜像；否则读主库旧表（历史 run 零变化）。
function getSessionStatusDualSource({ userDataDir, mainDb, monthKey }) {
  if (!monthKey) return { monthKey: null, flowReady: false, billReady: false, latestRun: null };
  if (runDataStore.sideDbExists(userDataDir, MODULE, monthKey)) {
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
    let readiness;
    try {
      readiness = importRepo.getMonthReadiness(sideDb, monthKey);
    } finally {
      try { sideDb.close(); } catch (_e) { /* swallow */ }
    }
    // latestRun 取主库镜像（UI 一致；镜像在 runCheck 成功后落）
    const latestRun = runRepo.getLatestRun(mainDb, monthKey);
    return {
      monthKey,
      flowReady: readiness.flowReady,
      billReady: readiness.billReady,
      flowCount: readiness.flowCount,
      billCount: readiness.billCount,
      latestRun: latestRun ? mapLatestRun(latestRun) : null,
    };
  }
  // 历史主库 run（双源过渡）— 既有 session.getSessionStatus 行为零变化
  return session.getSessionStatus({ db: mainDb, monthKey });
}

function mapLatestRun(run) {
  return {
    id: run.id,
    ran_at: run.ran_at,
    total_bill_rows: run.total_bill_rows,
    matched_rows: run.matched_rows,
    mismatch_rows: run.mismatch_rows,
    unmatched_rows: run.unmatched_rows,
    status: run.status,
  };
}

// ── retention 文件级二态（B-D4，只对新 run / 侧库）──

// 整文件删（覆盖删除该月 / 孤儿 / cleanup 的月级回收）：删侧库文件 + 主库镜像行。
function deleteMonthSideDb({ userDataDir, mainDb, monthKey }) {
  const r = runDataStore.deleteSideDb(userDataDir, MODULE, monthKey);
  // 删主库镜像行（双源一致：以侧库文件存在性为准——文件删了镜像也清）
  try {
    mainDb.prepare(`DELETE FROM ${RUNS_TABLE} WHERE month_key = ? AND side_db_rel_path IS NOT NULL`).run(monthKey);
  } catch (_e) { /* swallow — 镜像删失败不阻断文件删 */ }
  return r;
}

// 仅保留 diff（retention 二态另一态）：侧库内删 flow/bill imports 行（diff_rows 保留供重导出）。
//   实现取简单者：直接 DELETE imports 行（不 VACUUM 重建——侧库小，碎片成本可忽略；
//   且差异 xlsx 物理文件在 exports/，重导出走 copy 不读 imports）。
//   ⚠️ diff_rows.bill_import_id FK → bill_imports(id) ON DELETE CASCADE：删 bill 会级联删 diff！
//   故「仅保留 diff」只删 flow_imports（与主库 cleanupAfterRunBackground includeDiff=false 同语义：
//   保留 bill+diff，仅清 flow）。这是文件级二态在 per-月模型的精确映射。
function trimMonthSideDbKeepDiff({ userDataDir, monthKey }) {
  if (!runDataStore.sideDbExists(userDataDir, MODULE, monthKey)) {
    return { flowDeleted: 0, skipped: 'no-side-db' };
  }
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try {
    sideDb.exec('BEGIN');
    let flowDeleted = 0;
    try {
      const r = sideDb.prepare('DELETE FROM acquiring_bill_currency_flow_imports WHERE month_key = ?').run(monthKey);
      flowDeleted = r.changes || 0;
      sideDb.exec('COMMIT');
    } catch (err) {
      try { sideDb.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
      throw err;
    }
    return { flowDeleted };
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
}

// ── 孤儿双向兜底（B.6）——启动扫描 ──

// 双向兜底：
//   ① 有文件无元数据 → 删文件 + log（侧库文件存在但主库无对应 side_db 镜像行）。
//   ② 有元数据无文件 → 标记主库镜像行失效（status='side-db-missing'，UI 降级显示「数据已清理」，不崩溃）。
//   一致性原则：以侧库文件存在性为准（spec §B.6）。
//   返回 { deletedOrphanFiles:[], invalidatedRuns:[] }。
function reconcileOrphans({ userDataDir, mainDb }) {
  const stats = { deletedOrphanFiles: [], invalidatedRuns: [] };

  // 主库侧库镜像行（side_db_rel_path 非空）
  let mirrorRows = [];
  try {
    mirrorRows = mainDb.prepare(
      `SELECT id, month_key, side_db_rel_path, status FROM ${RUNS_TABLE} WHERE side_db_rel_path IS NOT NULL`
    ).all();
  } catch (_e) {
    mirrorRows = []; // 列不存在等异常 → 视为无镜像（不阻断文件侧扫描）
  }
  const mirrorByMonth = new Map();
  for (const row of mirrorRows) mirrorByMonth.set(row.month_key, row);

  // 侧库文件
  const files = runDataStore.listSideDbFiles(userDataDir, MODULE);
  const fileMonths = new Set(files.map((f) => f.monthKey));

  // ① 有文件无元数据 → 仅删空壳（codex PR#73 复审修复 P1，对齐 bank-bu/biz-op）
  //   import-only（已导入未跑对账，侧库有 flow/bill 数据但无 mirror）= 有效中间态，删它会丢导入数据 → 保留；
  //   仅删「侧库内 flow/bill imports 皆空」的崩溃残留空壳 / open 失败的损坏文件。
  for (const f of files) {
    if (!mirrorByMonth.has(f.monthKey)) {
      let isEmptyShell = false;
      try {
        const sideDb = runDataStore.openSideDb(userDataDir, MODULE, f.monthKey);
        try {
          const readiness = importRepo.getMonthReadiness(sideDb, f.monthKey);
          isEmptyShell = (readiness.flowCount === 0 && readiness.billCount === 0);
        } finally {
          try { sideDb.close(); } catch (_e) { /* swallow */ }
        }
      } catch (_e) {
        isEmptyShell = true; // 文件损坏 → 删
      }
      if (!isEmptyShell) continue; // import-only 有效导入数据 → 保留（防丢数据）
      const r = runDataStore.deleteSideDbByPath(f.path);
      if (r.deleted) {
        stats.deletedOrphanFiles.push(f.monthKey);
        appendModuleLog({
          level: 'info', source: 'main', domain: 'acquiring-bill-currency',
          message: '[acquiring-bill-currency] 孤儿侧库文件清理（空壳/损坏，无 imports 无镜像）',
          details: [`monthKey=${f.monthKey}`, `path=${f.path}`],
        });
      }
    }
  }

  // ② 有元数据无文件 → 标记失效（不崩溃，UI 降级）
  for (const row of mirrorRows) {
    if (!fileMonths.has(row.month_key) && row.status !== 'side-db-missing') {
      try {
        mainDb.prepare(`UPDATE ${RUNS_TABLE} SET status = 'side-db-missing' WHERE id = ?`).run(row.id);
        stats.invalidatedRuns.push(row.month_key);
        appendModuleLog({
          level: 'warning', source: 'main', domain: 'acquiring-bill-currency',
          message: '[acquiring-bill-currency] 侧库文件缺失，run 标记失效（有元数据无文件）',
          details: [`monthKey=${row.month_key}`, `runId=${row.id}`, `side_db_rel_path=${row.side_db_rel_path}`],
        });
      } catch (_e) { /* 单行标记失败不阻断 */ }
    }
  }

  return stats;
}

module.exports = {
  MODULE,
  importFiles,
  peekImportTarget,
  runCheckViaSideDb,
  prepareRunResume,
  findBoundResumableRun,
  prepareRunExport,
  assertRunExportFresh,
  assertRunResumeFresh,
  persistRunResumeBatchContext,
  resumeRunCheck,
  listMonthsDualSource,
  getSessionStatusDualSource,
  deleteMonthSideDb,
  trimMonthSideDbKeepDiff,
  reconcileOrphans,
  upsertMainRunMirror,
};
