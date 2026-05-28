// v2.1.6 T6 — 收单单据币种校验：session 层 + 对账算法（⚠️ 资金红线）
//
// 提供给 main.js 的 IPC handler 调用的高阶接口：
//   - importFlowFiles({ db, filePaths, importedAt, onProgress })  — 大事务包多 xlsx
//   - importBillFiles({ db, filePaths, importedAt, onProgress })  — 大事务包多 xlsx
//   - runCheck({ db, monthKey })                                  — 跑对账（spec §5）
//   - getSessionStatus({ db, monthKey })                          — UI 状态查询
//   - clearMonth({ db, monthKey })                                — 清空某月所有数据
//   - listMonths({ db })                                          — 月份下拉数据源
//
// 资金红线 ⚠️：
//   - 导入：表头校验 + 月份归属 + 主对账Id 唯一（任一失败 → ROLLBACK 整批）
//   - 对账：spec §5.2 SQL JOIN（在 run-repository.insertDiffRowsByJoin）

const fs = require('node:fs');
const importReader = require('../backend/acquiring-bill-currency-import/reader');
const importRepo = require('../backend/acquiring-bill-currency-db/import-repository');
const runRepo = require('../backend/acquiring-bill-currency-db/run-repository');
// v2.1.9 SR-log-1 (T32h)：替换 console.warn/error → appendModuleLog 双写
const { appendModuleLog } = require('../backend/logger');

function nowIso() {
  return new Date().toISOString();
}

// fix3 鲁棒化：吞掉 "no active transaction" 错，避免 ROLLBACK 异常掩盖主错
// catch 块用此函数代替 db.exec('ROLLBACK') 保证 throw 的是业务错而非 ROLLBACK 二次错
function safeRollback(db) {
  try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
}

// fix3 设计决策：BEGIN 不主动 ROLLBACK 清理。
//   理由：主动清理会破坏「同进程其他 IPC 路径正在进行的事务」（async handler 让出 event loop 时
//   另一个 IPC 进入 BEGIN 的并发场景）。真正的并发防御靠 handler 级 mutex（main.js
//   acquiringBillCurrencyImportLock）。此函数仅作语义包装。
function safeBegin(db) {
  db.exec('BEGIN');
}

// 大事务导入多个 xlsx（任一失败整体 ROLLBACK，spec §3.3 "整批拒绝"）
// kind: 'flow' | 'bill'
// v0.8 fix5：caller 必传 monthKey（用户弹窗选的），reader 把它当 expectedMonthKey 校验所有行
async function importFilesInTransaction({ db, kind, monthKey, filePaths, onProgress }) {
  if (!monthKey) throw new Error(`${kind === 'flow' ? '流水' : '单据'}导入：monthKey 必填`);
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error(`${kind === 'flow' ? '流水表' : '单据表'}：未选择任何文件`);
  }
  const importedAt = nowIso();
  const importFn = kind === 'flow' ? importReader.importFlowFile : importReader.importBillFile;

  safeBegin(db);
  try {
    let totalImported = 0;
    const perFileStats = [];

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      if (onProgress) onProgress({ stage: 'reading', fileIndex: i, fileCount: filePaths.length, filePath });
      const result = await importFn({
        db,
        filePath,
        importedAt,
        expectedMonthKey: monthKey,
        onProgress: (p) => {
          // v2.1.7 round 2 R2：fileCount 在 ...p 之后（后置 = 覆盖；reader 不带 fileCount 但防御性写法保证 source-of-truth）
          //   renderer formatAcquiringBillCurrencyProgress 用 ev.fileCount 显示 "(i/n 个文件)"；缺失时 fallback "?"（spec §8.3）
          if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p, fileCount: filePaths.length });
        }
      });
      totalImported += result.importedCount;
      perFileStats.push(result);
    }

    db.exec('COMMIT');
    return { monthKey, fileCount: filePaths.length, totalImported, perFileStats };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

async function importFlowFiles({ db, monthKey, filePaths, onProgress }) {
  return importFilesInTransaction({ db, kind: 'flow', monthKey, filePaths, onProgress });
}

async function importBillFiles({ db, monthKey, filePaths, onProgress }) {
  return importFilesInTransaction({ db, kind: 'bill', monthKey, filePaths, onProgress });
}

// fix1（spec §3.4）：覆盖导入 — 先清单侧（流水或单据）再导入；
// 包在一个大事务里，任一步失败整体 ROLLBACK（旧数据保留）。
async function importFilesWithOverwrite({ db, kind, monthKey, filePaths, onProgress }) {
  if (!monthKey) throw new Error(`${kind === 'flow' ? '流水' : '单据'}覆盖导入：monthKey 必填`);
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error(`${kind === 'flow' ? '流水表' : '单据表'}：未选择任何文件`);
  }
  const importedAt = nowIso();
  const importFn = kind === 'flow' ? importReader.importFlowFile : importReader.importBillFile;

  safeBegin(db);
  try {
    // 先 DELETE 单侧
    const { deletedCount } = importRepo.deleteMonthBySide(db, { kind, monthKey });

    // 再 INSERT
    let detectedMonthKey = monthKey;
    let totalImported = 0;
    const perFileStats = [];
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];
      if (onProgress) onProgress({ stage: 'reading', fileIndex: i, fileCount: filePaths.length, filePath });
      const result = await importFn({
        db,
        filePath,
        importedAt,
        expectedMonthKey: detectedMonthKey,
        onProgress: (p) => {
          // v2.1.7 round 2 R2：同 importFilesInTransaction（spec §8.3）
          if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p, fileCount: filePaths.length });
        }
      });
      // 防御：detectedMonthKey 已是 peek 出来的值，新文件 monthKey 应一致；
      // 若不一致 importFlowFile 内部已抛跨月错（expectedMonthKey 不匹配）
      if (!detectedMonthKey) detectedMonthKey = result.monthKey;
      totalImported += result.importedCount;
      perFileStats.push(result);
    }

    db.exec('COMMIT');
    return { monthKey: detectedMonthKey, fileCount: filePaths.length, totalImported, deletedCount, perFileStats };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

async function importFlowFilesWithOverwrite({ db, monthKey, filePaths, onProgress }) {
  return importFilesWithOverwrite({ db, kind: 'flow', monthKey, filePaths, onProgress });
}

async function importBillFilesWithOverwrite({ db, monthKey, filePaths, onProgress }) {
  return importFilesWithOverwrite({ db, kind: 'bill', monthKey, filePaths, onProgress });
}

// fix1（spec §3.4）+ fix2（spec §3.5）：peek + 已有行预检（不进事务，async）
// 返回：{ monthKey, existingCount, kind }
async function peekImportTarget({ db, kind, filePaths }) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error(`${kind === 'flow' ? '流水表' : '单据表'}：未选择任何文件`);
  }
  const { monthKey } = await importReader.peekMonthKeyFromFile({ kind, filePath: filePaths[0] });
  const readiness = importRepo.getMonthReadiness(db, monthKey);
  const existingCount = kind === 'flow' ? readiness.flowCount : readiness.billCount;
  return { monthKey, existingCount, kind };
}

// v2.1.10 A3 Phase 2 T13 — CancelError：可中断 runCheckCore 的专用错误类
//   - 调用方按 err.name === 'CancelError' 识别（worker 跨进程后 instanceof 不可靠 — 见 serialize-error 注释）
//   - 业务语义：用户主动取消（cancel button），不是真正的失败
//   - main.js IPC handler 应识别此 error 不弹错误 Notification，仅 toast「已取消」
class CancelError extends Error {
  constructor(message, options = {}) {
    super(message || 'runCheck cancelled by user');
    this.name = 'CancelError';
    if (options.stage) this.stage = options.stage;
  }
}

// v2.1.10 A3 Phase 2 T13 — cancelToken 工厂（unit test / 集成测试用；生产由 worker pool 自动注入）
//   接口：{ get cancelled, throwIfCancelled }
//   生产逻辑：worker 收到 'cancel' message → token.cancelled = true（不立刻 throw，让 runCheckCore 在下个 check 点 throw）
function createCancelToken() {
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() { cancelled = true; },
    throwIfCancelled(stage) {
      if (cancelled) throw new CancelError(`runCheck cancelled at stage=${stage || 'unknown'}`, { stage });
    },
  };
}

// 对账核心（⚠️ 资金红线，spec §5）
// v0.8 fix5：跑 run 时同步产出 diff + report 到 exports/{date}/acquiring-bill-currency/(report/)
// v2.1.7 F6：新增 onProgress 入参（守护式埋点，旧 caller 无 onProgress 时行为不变）
//   阶段事件：clearing-old-runs / computing-stats / inserting-run / sql-joining / writing-xlsx / updating-paths
//   spec §6.2 / PRD §六
//
// v2.1.10 A3 T09：抽出 `runCheckCore(args)` 纯函数 — worker 内可直接调（无 Electron API 依赖）
//   原 `runCheck` 保留作 alias 透传（向后兼容所有既有 caller — main.js IPC handler / 集成测试）
//   contract test（scripts/integration/v2.1.10-a3-phase1.js）验证：
//     - 直 require 跑 vs worker pool dispatch 跑 → diff_rows 表内容 byte-for-byte 一致
//
// v2.1.10 A3 Phase 2 T13：cancelToken 可选入参（spec §2.1.3 + spec §3.2 cancel < 5s）
//   - cancelToken 必须可选（向后兼容；主进程直调 / unit test / smoke 都不传 cancelToken）
//   - 在 5 阶段间插 cancelToken?.throwIfCancelled(stage)
//   - 事务中 cancel → safeRollback + throw CancelError（保证 DB 无锁残留）
//   - 写盘阶段不可中断（writer.writeRunOutputs 已经在事务外；中断会留半个 xlsx）
//   - byte-for-byte 不变（不传 cancelToken 时行为完全等价 v2.1.10 Phase 1）
//
// v2.1.10 A4 Phase 3 T18 / T19 — chunked stage 4'：
//   - stage 1-3 (clearOldRuns / computeStats / insertRun) 仍在主事务里
//   - 主事务在 stage 4' 前 COMMIT — 让 stage 4' 各 chunk 独立 BEGIN/COMMIT
//   - stage 4' (insertDiffRowsByJoinChunked) 每 chunk 之间 cancelToken.throwIfCancelled
//   - chunk size 来自 caller 的 chunkSize 参数（main.js IPC 注入 settings 值；默认 100000）
//   - chunked 中途 cancel → 抛 CancelError（带 stage='sql-joining-chunk-N'）；caller 写 chunk_progress
//   - T19 resume 路径：caller 传 resumeFromRun 复用 runId 跳过 stage 1-3，stage 4' 从 lastCompletedChunkIndex+1 跑
//
// 流程：
//   1. 清空该月历史 runs + diff_rows（避免累积）（仅全新 run；resume 跳过）
//   2. 统计 totalBillRows / matched / mismatch / unmatched（仅全新 run；resume 复用旧 runs 行）
//   3. 创建 runs 记录拿 runId（仅全新 run；resume 复用旧 runId）
//   4'. chunked INSERT diff_rows BY SQL JOIN（spec §3 + §5.2）— 各 chunk 独立 BEGIN/COMMIT
//   5. 调 writer 同步生成 diff.xlsx + report.xlsx；UPDATE runs.diff_file_path/report_file_path 回填
//   6. SET chunk_progress.status='complete' + 返回 stats + filePaths
// 关键不变量：写盘失败不应回滚 DB 事务（数据已 COMMIT 有效）；写盘错误仅 throw 给 caller
async function runCheckCore({ db, monthKey, storageRoot, onProgress, cancelToken, chunkSize, resumeFromRun }) {
  if (!monthKey) {
    throw new Error('runCheck：monthKey 必填');
  }

  const runT0 = Date.now();
  let runId;
  let stats;
  let chunkedResult;
  // v2.1.10 A4 T18：chunkSize 默认 100000（spec §3.2 拍板）— caller 不传时也 chunked（小数据档 totalChunks=1 等价 single SQL）
  const effectiveChunkSize = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : 100000;
  // v2.1.10 A4 T19：resume 路径 — caller 传 resumeFromRun = { runId, lastCompletedChunkIndex } 复用旧 runId
  //   resumeFromRun.runId 必须存在 + status='partial'（caller 已验）；本函数仅按入参跳 stage 1-3
  const isResume = !!(resumeFromRun && resumeFromRun.runId && Number.isInteger(resumeFromRun.runId));

  // resume 路径下先校验 runId 一致性（防 readiness 错误信息掩盖 resume 入参错）
  //   - runId 不存在 → 抛"不存在"
  //   - month_key 不匹配 → 抛 mismatch
  //   - 之后再做 readiness check（resume 场景流水/单据不应被清，理论 readiness=true；防御性保留）
  if (isResume) {
    const existingRunForCheck = runRepo.getRunById(db, resumeFromRun.runId);
    if (!existingRunForCheck) {
      throw new Error(`resumeFromRun: runId=${resumeFromRun.runId} 不存在`);
    }
    if (existingRunForCheck.month_key !== monthKey) {
      throw new Error(`resumeFromRun: runId=${resumeFromRun.runId} month_key=${existingRunForCheck.month_key} 与请求 monthKey=${monthKey} 不一致`);
    }
  }

  const { flowReady, billReady } = importRepo.getMonthReadiness(db, monthKey);
  if (!flowReady) throw new Error(`${monthKey}：流水表尚未导入`);
  if (!billReady) throw new Error(`${monthKey}：单据表尚未导入`);

  if (!isResume) {
    // ── 全新 run 路径 — stage 1-3 主事务 ──
    safeBegin(db);
    try {
      // v2.1.7 F6 埋点 1/6：清理历史 runs
      if (onProgress) {
        onProgress({ phase: 'run', stage: 'clearing-old-runs' });
        await new Promise((r) => setImmediate(r));
      }
      runRepo.clearRunsByMonth(db, monthKey);
      // v2.1.10 T13 cancel check 1/5（事务中 — cancel 触发 safeRollback + throw）
      if (cancelToken && cancelToken.cancelled) {
        safeRollback(db);
        throw new CancelError('runCheck cancelled at stage=clearing-old-runs', { stage: 'clearing-old-runs' });
      }

      // v2.1.7 F6 埋点 2/6：统计行数
      if (onProgress) {
        onProgress({ phase: 'run', stage: 'computing-stats' });
        await new Promise((r) => setImmediate(r));
      }
      stats = runRepo.computeRunStats(db, { monthKey });
      // v2.1.10 T13 cancel check 2/5
      if (cancelToken && cancelToken.cancelled) {
        safeRollback(db);
        throw new CancelError('runCheck cancelled at stage=computing-stats', { stage: 'computing-stats' });
      }

      // v2.1.7 F6 埋点 3/6：创建 run 记录
      if (onProgress) {
        onProgress({ phase: 'run', stage: 'inserting-run' });
        await new Promise((r) => setImmediate(r));
      }
      runId = runRepo.insertRun(db, {
        monthKey,
        // v0.14 fix12：显式传 ISO 8601（带 Z 后缀），避免依赖 SQLite DEFAULT CURRENT_TIMESTAMP（返回 UTC 无后缀，writer 显示时容易错位）
        ranAt: nowIso(),
        totalBillRows: stats.totalBillRows,
        matchedRows: stats.matchedRows,
        mismatchRows: stats.mismatchRows,
        unmatchedRows: stats.unmatchedRows,
        status: 'success'
      });
      // v2.1.10 T13 cancel check 3/5
      if (cancelToken && cancelToken.cancelled) {
        safeRollback(db);
        throw new CancelError('runCheck cancelled at stage=inserting-run', { stage: 'inserting-run' });
      }
      // v2.1.10 A4 T18：主事务 COMMIT — 让 stage 4' chunked 各 chunk 独立 BEGIN/COMMIT
      db.exec('COMMIT');
    } catch (error) {
      safeRollback(db);
      throw error;
    }
  } else {
    // ── resume 路径 — 跳过 stage 1-3 复用旧 runId / 旧 stats ──
    //   入参校验已在函数顶部 isResume 分支完成（runId 存在 + month_key 一致）
    runId = resumeFromRun.runId;
    const existingRun = runRepo.getRunById(db, runId);
    // 重读 runs 行 — 复用 stats 给后续 sanity check / writer
    stats = {
      totalBillRows: existingRun.total_bill_rows,
      matchedRows: existingRun.matched_rows,
      mismatchRows: existingRun.mismatch_rows,
      unmatchedRows: existingRun.unmatched_rows,
    };
    if (onProgress) {
      onProgress({ phase: 'run', stage: 'resuming-from-chunk', resumeRunId: runId });
      await new Promise((r) => setImmediate(r));
    }
  }

  // ── stage 4' chunked INSERT diff_rows ──
  //   主事务已 COMMIT；进入 chunked 区域（各 chunk 独立 BEGIN/COMMIT）
  // v2.1.7 F6 埋点 4/6：SQL JOIN 比对币种（耗时大头）→ chunked 模式
  if (onProgress) {
    onProgress({ phase: 'run', stage: 'sql-joining', mismatchHint: stats.mismatchRows });
    await new Promise((r) => setImmediate(r));
  }

  const resumeFromChunkIndex = isResume && Number.isInteger(resumeFromRun.lastCompletedChunkIndex)
    ? resumeFromRun.lastCompletedChunkIndex + 1
    : 0;

  try {
    chunkedResult = runRepo.insertDiffRowsByJoinChunked(db, {
      runId,
      monthKey,
      chunkSize: effectiveChunkSize,
      cancelToken,
      resumeFromChunkIndex,
      onChunkDone: ({ chunkIndex, totalChunks, processedRows, insertedDiffRows: chunkInsertedDiffRows, elapsedMs }) => {
        // 每 chunk 完成后 — 更新 chunk_progress（in-progress 直至最后一 chunk 改 complete）
        // 失败不抛（caller catch 写 partial）；progress 回调透传 caller
        try {
          runRepo.setRunChunkProgress(db, {
            runId,
            lastCompletedChunkIndex: chunkIndex,
            totalChunks,
            status: (chunkIndex + 1 >= totalChunks) ? 'complete' : 'in-progress',
          });
        } catch (_progressErr) {
          // chunk_progress 写失败不阻断主循环（unit test 防御；生产 SQLITE_BUSY 极少）
        }
        if (onProgress) {
          onProgress({
            phase: 'run',
            stage: 'sql-joining',
            chunkIndex,
            totalChunks,
            processedRows,
            insertedDiffRows: chunkInsertedDiffRows,
            elapsedMs,
          });
        }
      },
    });
  } catch (chunkedErr) {
    // chunked 中途异常（cancel 或 SQL 错）— 失败 chunk 已自行 ROLLBACK 本批；已 COMMIT 批保留
    //   写 chunk_progress { status:'partial' } 让 caller 决策 resume / 弃
    //   ⚠️ 关键 idempotent 不变量：复用 onChunkDone 已正确写入的 progress（lastCompletedChunkIndex / totalChunks），
    //      仅把 status 改 'partial'；若 onChunkDone 从未触发（chunk 0 边界即 cancel）→ 写 -1 / 0 兜底
    try {
      const existingProgress = runRepo.getRunChunkProgress(db, runId);
      if (existingProgress) {
        // onChunkDone 已写过至少一次 — 复用其值（lastCompletedChunkIndex 指向最后一个 COMMIT 成功的 chunk）
        runRepo.setRunChunkProgress(db, {
          runId,
          lastCompletedChunkIndex: existingProgress.lastCompletedChunkIndex,
          totalChunks: existingProgress.totalChunks,
          status: 'partial',
        });
      } else {
        // onChunkDone 从未触发（chunk 0 之前 cancel；或 chunkedResult.totalChunks=0 边界）
        runRepo.setRunChunkProgress(db, {
          runId,
          lastCompletedChunkIndex: -1,
          totalChunks: 0,
          status: 'partial',
        });
      }
    } catch (_progressErr) {
      // chunk_progress 写失败 — 不阻塞错误透传（caller 不能 resume 也只能重跑）
    }
    throw chunkedErr;
  }

  // sanity check：mismatchRows（统计口径）与实际 INSERT 行数应一致（chunked 累计后比对）
  if (chunkedResult.totalInsertedDiffRows !== stats.mismatchRows && !isResume) {
    // resume 路径下 totalInsertedDiffRows 只是本次 chunked 的累计（不含上次已 COMMIT 的 diff）— 跳过 sanity check
    // 不抛错（数据已提交），但记日志供后续审计
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报
    appendModuleLog({
      level: 'warning',
      source: 'main',
      domain: 'acquiring-bill-currency',
      message: '[acquiring-bill-currency] diff row count mismatch',
      details: [
        `stats.mismatchRows=${stats.mismatchRows}`,
        `chunked INSERT total=${chunkedResult.totalInsertedDiffRows}`,
        `totalChunks=${chunkedResult.totalChunks}`,
      ]
    });
  }

  // chunked 成功后 — chunk_progress 已被 onChunkDone 标记为 complete（最后一 chunk 时）
  //   0 chunk 边界（totalChunks=0）— 显式补一次 status='complete'（onChunkDone 不会触发）
  if (chunkedResult.totalChunks === 0) {
    try {
      runRepo.setRunChunkProgress(db, {
        runId,
        lastCompletedChunkIndex: -1,
        totalChunks: 0,
        status: 'complete',
      });
    } catch (_progressErr) { /* 不阻塞主流程 */ }
  }

  // v2.1.10 T13 cancel check 5/5（写盘前 — 非事务期；cancel 不 ROLLBACK）
  //   说明：写盘阶段开始后不可中断（writer 内部分文件可能已落盘 — 部分 xlsx 残留更糟）
  //   COMMIT 后 cancel 仍返回 CancelError，但 run 数据已落库；caller 决策保留（success-no-files）或人工清
  if (cancelToken && cancelToken.cancelled) {
    throw new CancelError('runCheck cancelled at stage=before-writing-xlsx (DB COMMIT 已完成)', { stage: 'before-writing-xlsx' });
  }

  // v0.8 fix5：DB 事务成功后同步写盘 diff + report
  const runElapsedMs = Date.now() - runT0;
  let diffFilePath = null;
  let reportFilePath = null;
  if (storageRoot) {
    try {
      // v2.1.7 F6 埋点 5/6：写 xlsx
      if (onProgress) onProgress({ phase: 'run', stage: 'writing-xlsx' });
      const writer = require('./acquiring-bill-currency-writer');
      const out = await writer.writeRunOutputs({ db, runId, monthKey, storageRoot, runElapsedMs });
      diffFilePath = out.diffFilePath;
      reportFilePath = out.reportFilePath;

      // v2.1.7 F6 埋点 6/6：回填路径
      if (onProgress) onProgress({ phase: 'run', stage: 'updating-paths' });
      runRepo.updateRunPaths(db, { runId, diffFilePath, reportFilePath });
    } catch (writeError) {
      // PR #50 NewF2：写盘失败不回滚 DB；run.status 改 'success-no-files'（数据有效但文件未生成）
      // 让 cleanupOrphanData 识别此状态为「可恢复」不清数据；用户可手动修复路径/权限后重跑 / 重新生成
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[acquiring-bill-currency] run 写盘失败（DB 已 COMMIT，run.status → success-no-files）',
        details: [writeError && writeError.message ? writeError.message : String(writeError)],
        stack: writeError && writeError.stack ? writeError.stack : undefined
      });
      try {
        runRepo.updateRunStatus(db, { runId, status: 'success-no-files' });
      } catch (statusErr) {
        // v2.1.9 SR-log-1：替换 console.error → 日志上报
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'acquiring-bill-currency',
          message: '[acquiring-bill-currency] updateRunStatus 失败',
          details: [statusErr && statusErr.message ? statusErr.message : String(statusErr)],
          stack: statusErr && statusErr.stack ? statusErr.stack : undefined
        });
      }
      throw writeError;
    }
  }

  // v0.12 fix9：cleanup 不再在 runCheck 内同步做（避免 UI 卡几分钟）
  // caller（main.js handler）在 handler return success 后通过 setImmediate 异步触发 cleanupAfterRunBackground
  // runCheck 仅返回 cleanupNeeded 标识 + 文件路径 + runId
  // v2.1.8 N1：β 方案 cleanup 移出对账链路 — runCheck 成功后 SET cleanup_pending=1，
  //   不再立即触发清理；交给 app.before-quit（主）+ 进入模块时（兜底）
  //   main.js handler 的 setImmediate(cleanupAfterRunBackground) 已移除
  const cleanupNeeded = !!(storageRoot && diffFilePath && reportFilePath
    && fs.existsSync(diffFilePath) && fs.existsSync(reportFilePath));
  if (cleanupNeeded) {
    try {
      runRepo.markCleanupPending(db, { runId });
    } catch (markErr) {
      // 标志位写失败不阻断 runCheck 成功（用户感知不到），仅日志
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[acquiring-bill-currency] markCleanupPending 失败',
        details: [markErr && markErr.message ? markErr.message : String(markErr)],
        stack: markErr && markErr.stack ? markErr.stack : undefined
      });
    }
  }

  return { runId, ...stats, diffFilePath, reportFilePath, cleanupNeeded };
}

// v0.12 fix9：异步分批 cleanup（caller setImmediate 排队，不阻塞 UI）
// 每批 50000 行 DELETE + setImmediate 让出 event loop，避免 UI 长时间 not responding
// 单独事务：每批 DELETE 自包含 safeBegin/COMMIT，失败仅记日志不抛
//
// v2.1.8 N1' (v0.7)：新增 `includeDiff` 参数（默认 false）
//   - false → 只清 flow_imports（runCheck/idle/退出兜底/进入模块兜底 4 触发点用）
//             ⚠️ bill_imports **也保留**：diff_rows.bill_import_id FK → bill_imports.id（无 CASCADE），
//                差异保留语义自然延伸到"差异关联的 bill 也保留"（bill 是差异行源数据快照）
//             flow_imports 与 diff_rows 无 FK 引用，可独立清
//   - true  → 清 3 表（cleanupOrphanData Phase 2 调用，孤儿 run 数据脏，需整体清掉）
//             Phase 2 先清 diff（解 FK 引用）→ 再清 bill → 清 flow
//   差异保留策略：每 monthKey 保留最新 1 run 的 diff，重跑由 P1 clearRunsByMonth 覆盖（spec §3.2.1 N1''-D1）
//   FK 约束依据：migrations.js:1073-1074 diff_rows.bill_import_id REFERENCES bill_imports(id)
async function cleanupAfterRunBackground({ db, monthKey, runId, onProgress, includeDiff = false }) {
  const BATCH = 50000;
  const tables = [];
  if (includeDiff) {
    // includeDiff=true：清 3 表，顺序 diff → bill → flow（先清子表解 FK）
    tables.push({ name: 'acquiring_bill_currency_diff_rows', where: 'run_id = ?', param: runId });
    tables.push({ name: 'acquiring_bill_currency_bill_imports', where: 'month_key = ?', param: monthKey });
  }
  // 默认 includeDiff=false：仅清 flow_imports（bill_imports 保留以维持 FK）
  tables.push({ name: 'acquiring_bill_currency_flow_imports', where: 'month_key = ?', param: monthKey });

  const stats = { diffDeleted: 0, flowDeleted: 0, billDeleted: 0 };
  const keyMap = {
    acquiring_bill_currency_diff_rows: 'diffDeleted',
    acquiring_bill_currency_flow_imports: 'flowDeleted',
    acquiring_bill_currency_bill_imports: 'billDeleted'
  };

  for (const t of tables) {
    // SQLite 子查询限定 LIMIT 实现分批删除（rowid 是隐式主键）
    const sql = `DELETE FROM ${t.name} WHERE rowid IN (SELECT rowid FROM ${t.name} WHERE ${t.where} LIMIT ${BATCH})`;
    while (true) {
      safeBegin(db);
      let changes = 0;
      try {
        const result = db.prepare(sql).run(t.param);
        changes = result.changes || 0;
        db.exec('COMMIT');
      } catch (err) {
        safeRollback(db);
        // v2.1.9 SR-log-1：替换 console.error → 日志上报（单 batch 失败 → 跳出本表循环，下表继续）
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'acquiring-bill-currency',
          message: `[acquiring-bill-currency] cleanup batch failed on ${t.name}`,
          details: [err && err.message ? err.message : String(err)],
          stack: err && err.stack ? err.stack : undefined
        });
        break;
      }
      stats[keyMap[t.name]] += changes;
      if (onProgress) onProgress({ table: t.name, deleted: stats[keyMap[t.name]] });
      if (changes < BATCH) break;
      // 让 event loop 喘一口气，UI 能响应用户操作
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return stats;
}

// v0.13 fix10：启动期孤儿数据清理
// 触发：app.whenReady + migration 完成后，main.js setImmediate 后台调
// 孤儿定义（PR #50 NewF2 修正）：
//   ① runs.status != 'success' AND runs.status != 'success-no-files'（真正异常：中断 / OOM 闪退 / 强制退出）
//   ② runs.status='success' 但 diff/report 文件丢失（fix7 之前 OOM 闪退后 writer 中途崩，DB 已 COMMIT 但 xlsx 未生成）
//   ③ runs.status='success-no-files' → 跳过（NewF2：可恢复 run，用户可重跑 / 修复路径后再导出，cleanup 不动数据）
// Phase 1 收集 orphan runs → Phase 2 对每个 orphan 复用 cleanupAfterRunBackground + DELETE run 记录 → Phase 3 兜底清 ghost diff_rows（run_id 不在 runs 表）
// 用户感知：main.js 加 onProgress 回调更新主面板状态文案「清理上次未完成的对账数据中…」
// 失败容忍：单条 orphan 清理抛错只 console.error，不中断整个 cleanup 流程
async function cleanupOrphanData({ db, onProgress }) {
  const stats = { orphanRunIds: [], deletedDiff: 0, deletedFlow: 0, deletedBill: 0, deletedRuns: 0 };

  // Phase 1：扫所有 run 找孤儿
  const allRuns = db.prepare(
    'SELECT id, month_key, status, diff_file_path, report_file_path FROM acquiring_bill_currency_runs'
  ).all();

  const orphanRuns = [];
  // v2.1.10 SR-FIX-1 round 2 P0-1：chunked partial run 保护
  //   触发场景：chunked stage 4' 跑到 chunk M/N → cancel / worker crash → chunk_progress.status='partial'
  //     runs.status='success'（stage 3 写时已落，writer 阶段未跑 → diff_file_path=null）→ fileBroken=true
  //     v2.1.10 N4-cont-2 之前：cleanupOrphanData 把 partial run 当孤儿清掉 → 用户重启后无法 resume
  //   修复（spec §3.3 / §5.4 idempotent + tasks T19 resumeFromRun 设计意图）：
  //     如果 run 处于 chunk_progress.status='partial' 状态 → 视为「待 resume」非「孤儿」→ 保留供下次 resume IPC 调用
  //     对配套测试：scripts/integration/v2.1.10-a4-phase3.js 新增 case 验证「partial run 跨 cleanupOrphanData 仍存活」
  for (const run of allRuns) {
    // NewF2：'success-no-files' 是可恢复状态，跳过 cleanup
    if (run.status === 'success-no-files') continue;
    const fileBroken = !run.diff_file_path || !run.report_file_path
      || !fs.existsSync(run.diff_file_path) || !fs.existsSync(run.report_file_path);
    if (run.status !== 'success' || fileBroken) {
      // v2.1.10 SR-FIX-1 round 2 P0-1：partial chunked run 不当孤儿（A4 resume 路径保护）
      let chunkProgress = null;
      try {
        chunkProgress = runRepo.getRunChunkProgress(db, run.id);
      } catch (_e) {
        // chunk_progress 列不存在 / JSON 解析失败 → 视为无 progress，按既有 fileBroken 逻辑当孤儿
        chunkProgress = null;
      }
      if (chunkProgress && chunkProgress.status === 'partial') {
        // 跳过 — 保留供 resume IPC 调用（acquiringBillCurrency:run:resume）
        continue;
      }
      orphanRuns.push(run);
    }
  }

  if (orphanRuns.length === 0) {
    // 仍跑 Phase 3（ghost diff_rows 兜底）
  } else if (onProgress) {
    onProgress({ phase: 'orphan-scan', orphanRunCount: orphanRuns.length });
  }

  // Phase 2：对每个 orphan 复用 cleanupAfterRunBackground 分批清 + DELETE run 记录
  // v2.1.8 N1' (v0.7)：孤儿 run 数据脏（status≠success / 文件丢失），传 includeDiff: true 整体清掉
  //   常规触发点（runCheck/idle/退出/进入兜底）默认 includeDiff=false 保留有效 diff；
  //   仅 Phase 2 这里显式打开，避免脏 diff 沉淀（spec §3.1 / §3.2.1 N1''-D3 仅约束常规 cleanup 后 runs 保留）
  for (const run of orphanRuns) {
    try {
      const result = await cleanupAfterRunBackground({
        db,
        monthKey: run.month_key,
        runId: run.id,
        includeDiff: true,
        onProgress: (p) => { if (onProgress) onProgress({ phase: 'orphan-run', runId: run.id, ...p }); }
      });
      stats.deletedDiff += result.diffDeleted;
      stats.deletedFlow += result.flowDeleted;
      stats.deletedBill += result.billDeleted;

      safeBegin(db);
      try {
        const r = db.prepare('DELETE FROM acquiring_bill_currency_runs WHERE id = ?').run(run.id);
        db.exec('COMMIT');
        stats.deletedRuns += r.changes || 0;
        stats.orphanRunIds.push(run.id);
      } catch (err) {
        safeRollback(db);
        // v2.1.9 SR-log-1：替换 console.error → 日志上报；单 orphan 删除失败容忍继续
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'acquiring-bill-currency',
          message: `[acquiring-bill-currency] cleanupOrphanData delete run ${run.id} failed`,
          details: [err && err.message ? err.message : String(err)],
          stack: err && err.stack ? err.stack : undefined
        });
      }
    } catch (err) {
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: `[acquiring-bill-currency] cleanupOrphanData orphan run ${run.id} failed`,
        details: [err && err.message ? err.message : String(err)],
        stack: err && err.stack ? err.stack : undefined
      });
    }
  }

  // Phase 3：兜底清 ghost diff_rows（run_id 不在 runs 表的孤儿差异行）
  let ghostCount = 0;
  try {
    ghostCount = db.prepare(
      'SELECT COUNT(*) as c FROM acquiring_bill_currency_diff_rows WHERE run_id NOT IN (SELECT id FROM acquiring_bill_currency_runs)'
    ).get().c;
  } catch (err) {
    // 表不存在等异常 → 跳过
    ghostCount = 0;
  }

  if (ghostCount > 0) {
    if (onProgress) onProgress({ phase: 'ghost-diff-scan', ghostCount });
    const BATCH = 50000;
    const sql = `DELETE FROM acquiring_bill_currency_diff_rows WHERE rowid IN (SELECT rowid FROM acquiring_bill_currency_diff_rows WHERE run_id NOT IN (SELECT id FROM acquiring_bill_currency_runs) LIMIT ${BATCH})`;
    while (true) {
      safeBegin(db);
      let changes = 0;
      try {
        const result = db.prepare(sql).run();
        changes = result.changes || 0;
        db.exec('COMMIT');
      } catch (err) {
        safeRollback(db);
        // v2.1.9 SR-log-1：替换 console.error → 日志上报；ghost-diff batch 失败 → 跳出本表循环
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'acquiring-bill-currency',
          message: '[acquiring-bill-currency] cleanupOrphanData ghost-diff batch failed',
          details: [err && err.message ? err.message : String(err)],
          stack: err && err.stack ? err.stack : undefined
        });
        break;
      }
      stats.deletedDiff += changes;
      if (onProgress) onProgress({ phase: 'ghost-diff', deleted: changes });
      if (changes < BATCH) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return stats;
}

// UI 状态查询：当前选中月份的导入就绪 + 最近 run
function getSessionStatus({ db, monthKey }) {
  if (!monthKey) return { monthKey: null, flowReady: false, billReady: false, latestRun: null };
  const readiness = importRepo.getMonthReadiness(db, monthKey);
  const latestRun = runRepo.getLatestRun(db, monthKey);
  return {
    monthKey,
    flowReady: readiness.flowReady,
    billReady: readiness.billReady,
    flowCount: readiness.flowCount,
    billCount: readiness.billCount,
    latestRun: latestRun ? {
      id: latestRun.id,
      ran_at: latestRun.ran_at,
      total_bill_rows: latestRun.total_bill_rows,
      matched_rows: latestRun.matched_rows,
      mismatch_rows: latestRun.mismatch_rows,
      unmatched_rows: latestRun.unmatched_rows,
      status: latestRun.status
    } : null
  };
}

function clearMonth({ db, monthKey }) {
  if (!monthKey) throw new Error('clearMonth：monthKey 必填');
  importRepo.clearMonth(db, monthKey);
  return { ok: true };
}

function listMonths({ db }) {
  return importRepo.listMonths(db);
}

// v2.1.10 A3 T09：runCheck 是 runCheckCore 的 alias（向后兼容）
//   - 既有 caller（main.js IPC handler / 集成测试 / smoke）调 runCheck 行为不变
//   - worker 端（src/main-process/run-check-worker.js）也通过 alias 复用，
//     T06 暂直接 require session.runCheck；contract test 验证两条路径结果一致
//   - 后续如 runCheck 需要做 worker / 主进程语义分歧（如 worker 内不调 backup API），可解耦此 alias
const runCheck = runCheckCore;

module.exports = {
  importFlowFiles,
  importBillFiles,
  importFlowFilesWithOverwrite,
  importBillFilesWithOverwrite,
  peekImportTarget,
  runCheck,
  runCheckCore, // v2.1.10 A3 T09：worker 端可直接调用的纯函数版本
  cleanupAfterRunBackground,
  cleanupOrphanData,
  getSessionStatus,
  clearMonth,
  listMonths,
  // v2.1.10 A3 Phase 2 T13：cancel 工具
  CancelError,
  createCancelToken
};
