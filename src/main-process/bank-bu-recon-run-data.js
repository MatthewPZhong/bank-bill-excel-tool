// v3.0.5 PR-4（Part B Phase 2）— 月度银行对账单BU回填校验 per-月侧库编排层 🔴🔴 资金红线
//
// 职责：在 main.js IPC handler 与既有 bank-bu-recon-session / month-repository / run-repository 之间插一层，
//   把 run 级批量数据（pending_imports / bank_imports / runs 三表）的读写路由到 per-月侧库文件，
//   主库只保留 runs 元数据镜像行（side_db_rel_path + summary + status + run_at），实现：
//     - 写路径切换：importMonth 全部落侧库（importMonthAtomic 在「侧库 db 句柄」上运行 = 主库上运行）。
//     - run inline 直跑（bank-bu 无 worker）：runReconciliation(侧库 db) → 侧库 insertRun 拿 runId
//       → 主库 runs 镜像 upsert。
//     - 双源读路径（B-D2）：侧库存在 → 读侧库；不存在 → 读主库旧表（历史 run 零变化）。
//     - 导出：lastRunCache 侧库化后失效 → 走重跑路径（loadExportDataByRun / aggregateExportData
//       逐月 open 侧库重跑 runReconciliation 拿 matched/buDiff/nmAnomalies）。
//     - 孤儿双向兜底（B.6）：扫侧库目录 vs 主库 runs 镜像。
//
// 关键不变量：
//   1. 🔴 runReconciliation / writer / month-repository 的算法/SQL 一字不改；它们在「侧库 db 句柄」上运行
//      = 在主库上运行（同库自洽）。parity byte-for-byte 由 bank-bu-recon-side-db-parity.js 集成脚本锁死。
//   2. bank-bu 无 diff_rows 表（差异实时算不落库）；主库镜像只记 summary + 路径 + side_db_rel_path + status。
//   3. 一个 yearMonth 对应一个侧库文件 month-{yearMonth}.sqlite（yearMonth 本身即 YYYY-MM 格式）。

'use strict';

const fs = require('node:fs');

const session = require('./bank-bu-recon-session');
const monthRepository = require('../backend/bank-bu-recon-db/month-repository');
const runRepository = require('../backend/bank-bu-recon-db/run-repository');
const runDataStore = require('../backend/run-data-store');
const { appendModuleLog } = require('../backend/logger');

const MODULE = runDataStore.MODULE_BANK_BU;
const RUNS_TABLE = 'bank_bu_recon_runs';

// ── 主库 runs 镜像行 helpers（侧库 run → 主库元数据，含 side_db_rel_path）──

// upsert 主库 runs 镜像行（同 yearMonth 保留单镜像行：先删该月旧镜像，再插新）。
//   主库镜像不含 pending/bank imports（在侧库）；仅记 summary + side_db_rel_path + status + run_at。
//   返回主库镜像行的 id —— 🔴 这是对外（UI / 导出 handler）的 runId 真值（侧库 insertRun 的自增 id
//   是侧库内部 id，与主库镜像 id 不同命名空间；UI 从 run 结果拿 runId 再传给 export，必须用主库镜像 id）。
function upsertMainRunMirror(mainDb, { yearMonth, relPath, stats, status, runAt }) {
  let mirrorId;
  mainDb.exec('BEGIN');
  try {
    mainDb.prepare(`DELETE FROM ${RUNS_TABLE} WHERE year_month = ?`).run(yearMonth);
    const r = mainDb.prepare(`
      INSERT INTO ${RUNS_TABLE}
        (year_month, run_at, status, pending_total, bank_total, matched_count, bu_diff_count,
         pending_unmatched, bank_unmatched, anomaly_count, side_db_rel_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      yearMonth,
      runAt,
      status,
      stats.pendingTotal,
      stats.bankTotal,
      stats.matchedCount,
      stats.buDiffCount,
      stats.pendingUnmatched,
      stats.bankUnmatched,
      stats.nmAnomalyCount,
      relPath
    );
    mirrorId = Number(r.lastInsertRowid);
    mainDb.exec('COMMIT');
  } catch (err) {
    try { mainDb.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
    throw err;
  }
  return mirrorId;
}

// ── 写路径：importMonth（落侧库）──

// 覆盖导入（pending + bank）原子事务落该月侧库。import 不写主库镜像（镜像在 run 成功后写）。
//   返回 monthRepository.importMonthAtomic 的 { pendingCount, bankCount }。
function importMonth({ userDataDir, yearMonth, pendingRows, bankRows }) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, yearMonth);
  try {
    return monthRepository.importMonthAtomic(sideDb, yearMonth, pendingRows, bankRows);
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
}

// ── 写路径：runViaSideDb（侧库 inline 直跑 + 主库镜像）──

// inline 跑对账（bank-bu 无 worker）：open 侧库 → runReconciliation → 侧库 insertRun → 主库镜像 upsert。
//   返回 { runId（侧库自增）, stats }（与 session.run 返回形态一致，供 handler 上行）。
function runViaSideDb({ userDataDir, mainDb, yearMonth }) {
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, yearMonth);
  let result;
  try {
    // 🔴 算法零改动：runReconciliation 在侧库 db 上跑 = 在主库上跑（同库自洽）。
    result = session.runReconciliation(sideDb, yearMonth);
    // 侧库内也落 run 行（保侧库自洽 + 重导清旧 run 语义；侧库 runId 内部用，不对外）。
    runRepository.insertRun(sideDb, {
      yearMonth,
      status: 'success',
      pendingTotal: result.stats.pendingTotal,
      bankTotal: result.stats.bankTotal,
      matchedCount: result.stats.matchedCount,
      buDiffCount: result.stats.buDiffCount,
      pendingUnmatched: result.stats.pendingUnmatched,
      bankUnmatched: result.stats.bankUnmatched,
      anomalyCount: result.stats.nmAnomalyCount
    });
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
  // 主库镜像（summary + side_db_rel_path + status）；返回的 mirrorId 是对外 runId 真值（UI/导出用）。
  const runId = upsertMainRunMirror(mainDb, {
    yearMonth,
    relPath: runDataStore.sideDbRelPath(MODULE, yearMonth),
    stats: result.stats,
    status: 'success',
    runAt: new Date().toISOString()
  });
  return { runId, stats: result.stats };
}

// ── 双源读路径（B-D2）──

// listMonths：合并侧库目录 month（新数据）+ 主库旧表 month（历史，双源过渡）。
//   返回 [{ yearMonth, pendingCount, bankCount, runCount, latestRunAt }]（与 monthRepository.listMonths 同形）。
function listMonthsDualSource({ userDataDir, mainDb }) {
  const out = new Map(); // yearMonth → entry
  // 侧库（新数据）：逐月 open 取 meta + 主库镜像 latestRun。
  for (const f of runDataStore.listSideDbFiles(userDataDir, MODULE)) {
    const ym = f.monthKey;
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, ym);
    let meta;
    try {
      meta = monthRepository.getMonthMeta(sideDb, ym);
    } finally {
      try { sideDb.close(); } catch (_e) { /* swallow */ }
    }
    const mirror = runRepository.getLatestRun(mainDb, ym);
    out.set(ym, {
      yearMonth: ym,
      pendingCount: meta.pendingCount,
      bankCount: meta.bankCount,
      runCount: mirror ? 1 : 0,
      latestRunAt: mirror ? mirror.run_at : null
    });
  }
  // 主库旧表（历史，双源过渡）：不覆盖侧库已有 month。
  try {
    for (const m of monthRepository.listMonths(mainDb)) {
      if (out.has(m.yearMonth)) continue;
      out.set(m.yearMonth, m);
    }
  } catch (_e) { /* 主库表异常不阻断侧库 month */ }
  return Array.from(out.values()).sort((a, b) => (a.yearMonth < b.yearMonth ? 1 : a.yearMonth > b.yearMonth ? -1 : 0));
}

// status：双源——侧库存在 → 读侧库 meta + 主库镜像 latestRun；否则读主库旧表。
function getStatusDualSource({ userDataDir, mainDb, yearMonth }) {
  if (runDataStore.sideDbExists(userDataDir, MODULE, yearMonth)) {
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, yearMonth);
    let meta;
    try {
      meta = monthRepository.getMonthMeta(sideDb, yearMonth);
    } finally {
      try { sideDb.close(); } catch (_e) { /* swallow */ }
    }
    const latestRun = runRepository.getLatestRun(mainDb, yearMonth);
    return { meta, latestRun };
  }
  // 历史主库（双源过渡）— 既有行为零变化
  const meta = monthRepository.getMonthMeta(mainDb, yearMonth);
  const latestRun = runRepository.listRuns(mainDb, yearMonth)[0] || null;
  return { meta, latestRun };
}

// listReadyMonths：两侧都已导入（pending>0 && bank>0）的月份。双源。
function listReadyMonthsDualSource({ userDataDir, mainDb }) {
  return listMonthsDualSource({ userDataDir, mainDb })
    .filter((m) => m.pendingCount > 0 && m.bankCount > 0)
    .map((m) => m.yearMonth);
}

// listSuccessMonths：有 status='success' run 的月份。主库镜像（侧库 run 镜像在主库）+ 主库旧表历史。
//   返回 [{ yearMonth, latestSuccessRunId, latestSuccessAt }]（与 session.listSuccessMonths 同形）。
function listSuccessMonthsDualSource({ mainDb }) {
  // 主库 runs 表（侧库 run 镜像 + 历史主库 run 都在此表）→ 直接 GROUP BY 即覆盖双源。
  return mainDb.prepare(`
    SELECT
      year_month AS yearMonth,
      MAX(id) AS latestSuccessRunId,
      MAX(run_at) AS latestSuccessAt
    FROM ${RUNS_TABLE}
    WHERE status = 'success'
    GROUP BY year_month
    ORDER BY year_month DESC
  `).all();
}

// run:history：主库镜像 listRuns（侧库 run 镜像在主库 + 历史主库 run）。
function listRunsDualSource({ mainDb, yearMonth }) {
  return runRepository.listRuns(mainDb, yearMonth);
}

// ── 导出（重跑路径，lastRunCache 侧库化后失效）──

// 加载指定 run 的导出数据（matched/buDiff/nmAnomalies）。
//   主库镜像行拿 yearMonth + side_db_rel_path → 侧库存在则 open 侧库重跑；
//   否则（历史主库 run，side_db_rel_path NULL）在主库重跑（双源过渡）。
//   返回 { yearMonth, matchedPending, matchedBank, buDiffPendingIds, buDiffBankIds, nmAnomalies } 或 null。
function loadExportDataByRun({ userDataDir, mainDb, runId }) {
  const run = runRepository.getRun(mainDb, runId);
  if (!run || run.status !== 'success') return null;
  const yearMonth = run.year_month;
  let db;
  let sideDb = null;
  if (run.side_db_rel_path && runDataStore.sideDbExists(userDataDir, MODULE, yearMonth)) {
    sideDb = runDataStore.openSideDb(userDataDir, MODULE, yearMonth);
    db = sideDb;
  } else {
    db = mainDb; // 历史主库 run（双源过渡）
  }
  try {
    const result = session.runReconciliation(db, yearMonth);
    if (result.status !== 'success') return null;
    return {
      yearMonth,
      matchedPending: result.matchedPending,
      matchedBank: result.matchedBank,
      buDiffPendingIds: result.buDiffPendingIds,
      buDiffBankIds: result.buDiffBankIds,
      nmAnomalies: result.nmAnomalies
    };
  } finally {
    if (sideDb) { try { sideDb.close(); } catch (_e) { /* swallow */ } }
  }
}

// 跨月汇总导出数据：每月最新成功镜像 → 逐月 open 侧库（或主库历史）重跑。
//   返回 { months: [...], skippedMonths }（与 session.aggregateLatestSuccessRuns 同形）。
function aggregateExportData({ userDataDir, mainDb }) {
  // 主库 runs 表取每月最新 run（侧库镜像 + 历史主库 run 都在此表）。
  const latestPerMonth = mainDb.prepare(`
    SELECT id, year_month, status, side_db_rel_path FROM ${RUNS_TABLE}
    WHERE id IN (
      SELECT MAX(id) FROM ${RUNS_TABLE} GROUP BY year_month
    )
    ORDER BY year_month ASC
  `).all();

  const months = [];
  const skippedMonths = [];
  for (const row of latestPerMonth) {
    if (row.status !== 'success') {
      skippedMonths.push(row.year_month);
      continue;
    }
    const ym = row.year_month;
    let db;
    let sideDb = null;
    if (row.side_db_rel_path && runDataStore.sideDbExists(userDataDir, MODULE, ym)) {
      sideDb = runDataStore.openSideDb(userDataDir, MODULE, ym);
      db = sideDb;
    } else {
      db = mainDb;
    }
    try {
      const result = session.runReconciliation(db, ym);
      if (result.status !== 'success') {
        skippedMonths.push(ym);
        continue;
      }
      months.push({
        yearMonth: ym,
        runId: row.id,
        matchedPending: result.matchedPending,
        matchedBank: result.matchedBank,
        buDiffPendingIds: result.buDiffPendingIds,
        buDiffBankIds: result.buDiffBankIds,
        nmAnomalies: result.nmAnomalies
      });
    } finally {
      if (sideDb) { try { sideDb.close(); } catch (_e) { /* swallow */ } }
    }
  }
  return { months, skippedMonths };
}

// 取主库镜像 run（导出 handler 校验 run 是否存在/成功用）。
function getMirrorRun({ mainDb, runId }) {
  return runRepository.getRun(mainDb, runId);
}

// 记录导出路径（更新主库镜像行 export_path）。
function recordExportPath({ mainDb, runId, exportPath }) {
  runRepository.updateRunExportPath(mainDb, runId, exportPath);
}

// ── retention / 孤儿双向兜底 ──

// 删整月侧库文件 + 主库镜像行（覆盖删除该月 / 孤儿清理）。
function deleteMonthSideDb({ userDataDir, mainDb, yearMonth }) {
  const r = runDataStore.deleteSideDb(userDataDir, MODULE, yearMonth);
  try {
    mainDb.prepare(`DELETE FROM ${RUNS_TABLE} WHERE year_month = ? AND side_db_rel_path IS NOT NULL`).run(yearMonth);
  } catch (_e) { /* swallow — 镜像删失败不阻断文件删 */ }
  return r;
}

// 孤儿双向兜底（B.6）：① 有文件无元数据 → 删文件；② 有元数据无文件 → 标记主库镜像失效。
//   一致性原则：以侧库文件存在性为准。返回 { deletedOrphanFiles:[], invalidatedRuns:[] }。
//   ⚠️ bank-bu 侧库文件含 imports（import 后即有文件，但可能无 run 镜像）——孤儿判定只针对
//      「有 side_db_rel_path 镜像但文件丢失」与「有文件但主库无任何痕迹（既无镜像也无旧表数据）」。
//      为避免误删「已导入未运行」的侧库文件（主库无 run 镜像但侧库有 imports 是正常态），
//      ① 分支只在「文件无对应镜像 AND 文件内也无 imports（空壳）」时删——但空壳判定需 open 文件。
//      简化稳妥：① 仅删「主库无镜像」的侧库文件中**确实是孤儿**（文件存在但其月既无主库镜像 run
//      又无侧库 imports 数据）的空壳；有 imports 的文件保留（用户已导入待运行/已运行）。
function reconcileOrphans({ userDataDir, mainDb }) {
  const stats = { deletedOrphanFiles: [], invalidatedRuns: [] };

  let mirrorRows = [];
  try {
    mirrorRows = mainDb.prepare(
      `SELECT id, year_month, side_db_rel_path, status FROM ${RUNS_TABLE} WHERE side_db_rel_path IS NOT NULL`
    ).all();
  } catch (_e) {
    mirrorRows = [];
  }
  const mirrorByMonth = new Map();
  for (const row of mirrorRows) mirrorByMonth.set(row.year_month, row);

  const files = runDataStore.listSideDbFiles(userDataDir, MODULE);
  const fileMonths = new Set(files.map((f) => f.monthKey));

  // ① 有文件无镜像 → 仅删「空壳」（侧库内无 imports 数据，判定为崩溃残留）。
  for (const f of files) {
    if (mirrorByMonth.has(f.monthKey)) continue;
    let isEmptyShell = false;
    try {
      const sideDb = runDataStore.openSideDb(userDataDir, MODULE, f.monthKey);
      try {
        const meta = monthRepository.getMonthMeta(sideDb, f.monthKey);
        isEmptyShell = (meta.pendingCount === 0 && meta.bankCount === 0);
      } finally {
        try { sideDb.close(); } catch (_e) { /* swallow */ }
      }
    } catch (_e) {
      // open 失败（文件损坏）→ 视为孤儿删除
      isEmptyShell = true;
    }
    if (isEmptyShell) {
      const r = runDataStore.deleteSideDbByPath(f.path);
      if (r.deleted) {
        stats.deletedOrphanFiles.push(f.monthKey);
        appendModuleLog({
          level: 'info', source: 'main', domain: 'bank-bu-recon',
          message: '[bank-bu-recon] 孤儿侧库文件清理（空壳/损坏，无 imports 无镜像）',
          details: [`yearMonth=${f.monthKey}`, `path=${f.path}`]
        });
      }
    }
  }

  // ② 有镜像无文件 → 标记失效（不崩溃，UI 降级）。
  for (const row of mirrorRows) {
    if (!fileMonths.has(row.year_month) && row.status !== 'side-db-missing') {
      try {
        mainDb.prepare(`UPDATE ${RUNS_TABLE} SET status = 'side-db-missing' WHERE id = ?`).run(row.id);
        stats.invalidatedRuns.push(row.year_month);
        appendModuleLog({
          level: 'warning', source: 'main', domain: 'bank-bu-recon',
          message: '[bank-bu-recon] 侧库文件缺失，run 标记失效（有镜像无文件）',
          details: [`yearMonth=${row.year_month}`, `runId=${row.id}`, `side_db_rel_path=${row.side_db_rel_path}`]
        });
      } catch (_e) { /* 单行标记失败不阻断 */ }
    }
  }

  return stats;
}

module.exports = {
  MODULE,
  importMonth,
  runViaSideDb,
  listMonthsDualSource,
  getStatusDualSource,
  listReadyMonthsDualSource,
  listSuccessMonthsDualSource,
  listRunsDualSource,
  loadExportDataByRun,
  aggregateExportData,
  getMirrorRun,
  recordExportPath,
  deleteMonthSideDb,
  reconcileOrphans,
  upsertMainRunMirror
};
