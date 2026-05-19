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
          if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p });
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
          if (onProgress) onProgress({ stage: 'inserting', fileIndex: i, ...p });
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

// 对账核心（⚠️ 资金红线，spec §5）
// v0.8 fix5：跑 run 时同步产出 diff + report 到 exports/{date}/acquiring-bill-currency/(report/)
// 流程：
//   1. 清空该月历史 runs + diff_rows（避免累积）
//   2. 统计 totalBillRows / matched / mismatch / unmatched
//   3. 创建 runs 记录拿 runId
//   4. INSERT diff_rows BY SQL JOIN（spec §5.2）
//   5. COMMIT（数据落库，事务结束）
//   6. 调 writer 同步生成 diff.xlsx + report.xlsx；UPDATE runs.diff_file_path/report_file_path 回填
//   7. 返回 stats + filePaths
// 关键不变量：写盘失败不应回滚 DB 事务（数据已 COMMIT 有效）；写盘错误仅 throw 给 caller
async function runCheck({ db, monthKey, storageRoot }) {
  if (!monthKey) {
    throw new Error('runCheck：monthKey 必填');
  }
  const { flowReady, billReady } = importRepo.getMonthReadiness(db, monthKey);
  if (!flowReady) throw new Error(`${monthKey}：流水表尚未导入`);
  if (!billReady) throw new Error(`${monthKey}：单据表尚未导入`);

  const runT0 = Date.now();
  let runId;
  let stats;
  let insertedDiffRows;

  safeBegin(db);
  try {
    runRepo.clearRunsByMonth(db, monthKey);
    stats = runRepo.computeRunStats(db, { monthKey });
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
    insertedDiffRows = runRepo.insertDiffRowsByJoin(db, { runId, monthKey });
    db.exec('COMMIT');

    // sanity check：mismatchRows（统计口径）与实际 INSERT 行数应一致
    if (insertedDiffRows !== stats.mismatchRows) {
      // 不抛错（数据已提交），但记日志供后续审计
      // eslint-disable-next-line no-console
      console.warn(`[acquiring-bill-currency] diff row count mismatch: stats.mismatchRows=${stats.mismatchRows} vs INSERT changes=${insertedDiffRows}`);
    }
  } catch (error) {
    safeRollback(db);
    throw error;
  }

  // v0.8 fix5：DB 事务成功后同步写盘 diff + report
  const runElapsedMs = Date.now() - runT0;
  let diffFilePath = null;
  let reportFilePath = null;
  if (storageRoot) {
    try {
      const writer = require('./acquiring-bill-currency-writer');
      const out = await writer.writeRunOutputs({ db, runId, monthKey, storageRoot, runElapsedMs });
      diffFilePath = out.diffFilePath;
      reportFilePath = out.reportFilePath;
      runRepo.updateRunPaths(db, { runId, diffFilePath, reportFilePath });
    } catch (writeError) {
      // 写盘失败不回滚 DB；run 记录 status 改 'success-no-files' 表示数据有效但文件未生成
      // eslint-disable-next-line no-console
      console.error('[acquiring-bill-currency] run 写盘失败（DB 已 COMMIT）:', writeError && writeError.message);
      throw writeError;
    }
  }

  // v0.12 fix9：cleanup 不再在 runCheck 内同步做（避免 UI 卡几分钟）
  // caller（main.js handler）在 handler return success 后通过 setImmediate 异步触发 cleanupAfterRunBackground
  // runCheck 仅返回 cleanupNeeded 标识 + 文件路径 + runId
  const cleanupNeeded = !!(storageRoot && diffFilePath && reportFilePath
    && fs.existsSync(diffFilePath) && fs.existsSync(reportFilePath));

  return { runId, ...stats, diffFilePath, reportFilePath, cleanupNeeded };
}

// v0.12 fix9：异步分批 cleanup（caller setImmediate 排队，不阻塞 UI）
// 每批 50000 行 DELETE + setImmediate 让出 event loop，避免 UI 长时间 not responding
// 单独事务：每批 DELETE 自包含 safeBegin/COMMIT，失败仅记日志不抛
async function cleanupAfterRunBackground({ db, monthKey, runId, onProgress }) {
  const BATCH = 50000;
  const tables = [
    { name: 'acquiring_bill_currency_diff_rows', where: 'run_id = ?', param: runId },
    { name: 'acquiring_bill_currency_flow_imports', where: 'month_key = ?', param: monthKey },
    { name: 'acquiring_bill_currency_bill_imports', where: 'month_key = ?', param: monthKey }
  ];

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
        // eslint-disable-next-line no-console
        console.error(`[acquiring-bill-currency] cleanup batch failed on ${t.name}:`, err && err.message);
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
// 孤儿定义：① runs.status != 'success'；② runs.status='success' 但 diff/report 文件丢失（fix7 之前 OOM 闪退后 writer 中途崩，DB 已 COMMIT 但 xlsx 未生成）
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
  for (const run of allRuns) {
    const fileBroken = !run.diff_file_path || !run.report_file_path
      || !fs.existsSync(run.diff_file_path) || !fs.existsSync(run.report_file_path);
    if (run.status !== 'success' || fileBroken) {
      orphanRuns.push(run);
    }
  }

  if (orphanRuns.length === 0) {
    // 仍跑 Phase 3（ghost diff_rows 兜底）
  } else if (onProgress) {
    onProgress({ phase: 'orphan-scan', orphanRunCount: orphanRuns.length });
  }

  // Phase 2：对每个 orphan 复用 cleanupAfterRunBackground 分批清 + DELETE run 记录
  for (const run of orphanRuns) {
    try {
      const result = await cleanupAfterRunBackground({
        db,
        monthKey: run.month_key,
        runId: run.id,
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
        // eslint-disable-next-line no-console
        console.error(`[acquiring-bill-currency] cleanupOrphanData delete run ${run.id} failed:`, err && err.message);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[acquiring-bill-currency] cleanupOrphanData orphan run ${run.id} failed:`, err && err.message);
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
        // eslint-disable-next-line no-console
        console.error('[acquiring-bill-currency] cleanupOrphanData ghost-diff batch failed:', err && err.message);
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

module.exports = {
  importFlowFiles,
  importBillFiles,
  importFlowFilesWithOverwrite,
  importBillFilesWithOverwrite,
  peekImportTarget,
  runCheck,
  cleanupAfterRunBackground,
  cleanupOrphanData,
  getSessionStatus,
  clearMonth,
  listMonths
};
