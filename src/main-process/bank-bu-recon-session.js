// v2.1.2 T2 — 月度银行对账单BU回填校验：session 层 + 对账算法
// 资金红线（PRD §六.2 OPEN ISSUE #10 拍板）：
//   - 严格 1:1 匹配（Pending.主对账单号 ↔ 银行对账单.ReconciliationId）
//   - 任何 1:N / N:1 / N:M 异常 → 运行立即中断 + 异常报告 + 弹窗
// BU 比较语义（PRD §六 OPEN ISSUE #5 拍板）：
//   - normalize(v): null/undefined/'' → ''；其余 String(v).trim()
//   - 不做大小写归一化（财务 BU 是受控枚举，可审计）

const fs = require('node:fs');
const path = require('node:path');

const monthRepository = require('../backend/bank-bu-recon-db/month-repository');
const runRepository = require('../backend/bank-bu-recon-db/run-repository');
const {
  PENDING_MATCH_KEY_DB_COLUMN,
  PENDING_DIFF_FIELD_DB_COLUMN,
  BANK_MATCH_KEY_DB_COLUMN,
  BANK_DIFF_FIELD_DB_COLUMN
} = require('../backend/bank-bu-recon-db/columns');

// v0.9 (OPEN ISSUE #5 改 C 拍板)：拆为 normalizeKey + normalizeBu
//   - normalizeKey：对账单号匹配 — 仅 trim，不大小写归一（保持 v0.4 原行为）
//   - normalizeBu：BU 字段比较 — trim + toLowerCase（容忍 BU 命名大小写差异，如 Flowmore vs FlowMore）
function normalizeKey(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function normalizeBu(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase();
}

// v0.9 兼容：保留 normalize 别名指向 normalizeKey（其它模块可能引用）
const normalize = normalizeKey;

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// 对账算法（spec §3.6 v0.8 重写 — OPEN ISSUE #10 重新拍板）
// 资金红线规则：
//   - 1:1 / 1:N / N:1 视为对账成功 → 走 BU 比较（精准标差异子对）
//   - N:M（双侧 ≥2）视为数据异常 → 跳过 BU 比较，加入 nmAnomalies 列表
//   - 永远 status='success'（不再有 failed_anomaly 中断分支）
// 返回：{ status:'success', stats, matchedPending, matchedBank, buDiffPendingIds, buDiffBankIds, nmAnomalies }
function runReconciliation(db, yearMonth) {
  const pendingRows = monthRepository.getPendingRows(db, yearMonth);
  const bankRows = monthRepository.getBankRows(db, yearMonth);

  // 步骤 1：按 normalize 后 key 构建索引
  const pendingByKey = new Map();
  const bankByKey = new Map();
  for (const r of pendingRows) {
    const key = normalizeKey(r[PENDING_MATCH_KEY_DB_COLUMN]);
    if (!key) continue;
    if (!pendingByKey.has(key)) pendingByKey.set(key, []);
    pendingByKey.get(key).push(r);
  }
  for (const r of bankRows) {
    const key = normalizeKey(r[BANK_MATCH_KEY_DB_COLUMN]);
    if (!key) continue;
    if (!bankByKey.has(key)) bankByKey.set(key, []);
    bankByKey.get(key).push(r);
  }

  // 步骤 2：按 key 分类处理（4 路：1:1 / 1:N / N:1 / N:M）
  const matchedPending = [];
  const matchedBank = [];
  const buDiffPendingIds = new Set();
  const buDiffBankIds = new Set();
  const nmAnomalies = [];
  let nmPendingRowCount = 0;
  let nmBankRowCount = 0;

  const allKeys = new Set([...pendingByKey.keys(), ...bankByKey.keys()]);
  for (const key of allKeys) {
    const P = pendingByKey.get(key) || [];
    const B = bankByKey.get(key) || [];
    if (P.length === 0 || B.length === 0) continue;  // 单侧未匹上对面，不进入差异表

    if (P.length === 1 && B.length === 1) {
      // 1:1
      matchedPending.push(P[0]);
      matchedBank.push(B[0]);
      if (normalizeBu(P[0][PENDING_DIFF_FIELD_DB_COLUMN]) !== normalizeBu(B[0][BANK_DIFF_FIELD_DB_COLUMN])) {
        buDiffPendingIds.add(P[0].id);
        buDiffBankIds.add(B[0].id);
      }
    } else if (P.length === 1 && B.length >= 2) {
      // 1:N — Pending 行不标黄；银行行逐一比 BU，仅标不等的
      const pBu = normalizeBu(P[0][PENDING_DIFF_FIELD_DB_COLUMN]);
      matchedPending.push(P[0]);
      for (const b of B) {
        matchedBank.push(b);
        if (normalizeBu(b[BANK_DIFF_FIELD_DB_COLUMN]) !== pBu) {
          buDiffBankIds.add(b.id);
        }
      }
    } else if (P.length >= 2 && B.length === 1) {
      // N:1 — 银行行不标黄；Pending 行逐一比 BU，仅标不等的
      const bBu = normalizeBu(B[0][BANK_DIFF_FIELD_DB_COLUMN]);
      matchedBank.push(B[0]);
      for (const p of P) {
        matchedPending.push(p);
        if (normalizeBu(p[PENDING_DIFF_FIELD_DB_COLUMN]) !== bBu) {
          buDiffPendingIds.add(p.id);
        }
      }
    } else {
      // N:M（双侧 ≥2）— 整组跳过 BU 比较，加入异常 sheet
      nmAnomalies.push({
        key,
        pendingCount: P.length,
        bankCount: B.length,
        pendingRowIndices: P.map((r) => r.row_index),
        bankRowIndices: B.map((r) => r.row_index)
      });
      nmPendingRowCount += P.length;
      nmBankRowCount += B.length;
    }
  }

  const stats = {
    pendingTotal: pendingRows.length,
    bankTotal: bankRows.length,
    matchedCount: matchedPending.length + matchedBank.length,  // 双侧对账成功行数总和
    buDiffCount: buDiffPendingIds.size + buDiffBankIds.size,   // 标黄行数总和
    pendingUnmatched: pendingRows.length - matchedPending.length - nmPendingRowCount,
    bankUnmatched: bankRows.length - matchedBank.length - nmBankRowCount,
    nmAnomalyCount: nmAnomalies.length
  };

  return {
    status: 'success',
    stats,
    matchedPending,
    matchedBank,
    buDiffPendingIds,
    buDiffBankIds,
    nmAnomalies
  };
}

// v0.8 已删除 writeAnomalyReport / describeAnomalyType
// 原因：N:M 异常不再生成 .txt 报告，改为写入差异表 Sheet 3「异常」（spec §3.8 v0.8 废弃）
// 1:N / N:1 不再视为异常（spec §6.2 v0.5 → v0.8 重新拍板）

function createBankBuReconSession({ getDb, getStorageRoot }) {
  let lastRunCache = null;   // { yearMonth, runId, result } — 用于 export 时直接复用 matchedPending/matchedBank

  function importMonth(yearMonth, pendingRows, bankRows) {
    const db = getDb();
    monthRepository.clearMonth(db, yearMonth);
    const pCount = monthRepository.insertPendingRows(db, yearMonth, pendingRows);
    const bCount = monthRepository.insertBankRows(db, yearMonth, bankRows);
    return { pendingCount: pCount, bankCount: bCount };
  }

  function listMonths() {
    return monthRepository.listMonths(getDb());
  }

  function getMonthMeta(yearMonth) {
    return monthRepository.getMonthMeta(getDb(), yearMonth);
  }

  function run(yearMonth) {
    const db = getDb();
    const result = runReconciliation(db, yearMonth);
    // v0.8: 永远 status=success；nmAnomalyCount 字段记录 N:M 异常组数（写入 runs 表 anomaly_count 字段重新定义）

    const runId = runRepository.insertRun(db, {
      yearMonth,
      status: 'success',
      pendingTotal: result.stats.pendingTotal,
      bankTotal: result.stats.bankTotal,
      matchedCount: result.stats.matchedCount,
      buDiffCount: result.stats.buDiffCount,
      pendingUnmatched: result.stats.pendingUnmatched,
      bankUnmatched: result.stats.bankUnmatched,
      anomalyCount: result.stats.nmAnomalyCount   // v0.8 重新定义：N:M 异常组数
    });
    lastRunCache = { yearMonth, runId, result };
    return {
      status: 'success',
      runId,
      stats: result.stats
    };
  }

  function getLastRunResult(runId) {
    if (!lastRunCache || lastRunCache.runId !== runId) return null;
    return lastRunCache.result;
  }

  function recordExportPath(runId, exportPath) {
    runRepository.updateRunExportPath(getDb(), runId, exportPath);
  }

  function getRun(runId) {
    return runRepository.getRun(getDb(), runId);
  }

  function listRuns(yearMonth) {
    return runRepository.listRuns(getDb(), yearMonth);
  }

  // v0.5 新增：列出所有"两侧都已导入"的月份（用于「开始运行」弹窗）
  // 返回 [{yearMonth, pendingCount, bankCount}] 倒序
  function listReadyMonths() {
    const all = monthRepository.listMonths(getDb());
    return all.filter((m) => m.pendingCount > 0 && m.bankCount > 0);
  }

  // v0.5 新增：列出所有"有 status=success run"的月份（用于「导出差异」「指定月份」下拉）
  // 返回 [{yearMonth, latestSuccessRunId, latestSuccessAt}] 倒序
  function listSuccessMonths() {
    const db = getDb();
    return db.prepare(`
      SELECT
        year_month AS yearMonth,
        MAX(id) AS latestSuccessRunId,
        MAX(run_at) AS latestSuccessAt
      FROM bank_bu_recon_runs
      WHERE status = 'success'
      GROUP BY year_month
      ORDER BY year_month DESC
    `).all();
  }

  // v0.5 新增：跨月汇总导出 — 收集每月最新 success run 的 matched 数据
  // 返回 { months: [{yearMonth, runId, matchedPending, matchedBank, buDiffPendingIds, buDiffBankIds}], skippedMonths }
  // skippedMonths 是该月最新 run 是 failed_anomaly 的月份（OPEN ISSUE Q7 拍板：跳过 + alert）
  function aggregateLatestSuccessRuns() {
    const db = getDb();
    // 取每月最新 run（不论 status）
    const latestPerMonth = db.prepare(`
      SELECT id, year_month, status FROM bank_bu_recon_runs
      WHERE id IN (
        SELECT MAX(id) FROM bank_bu_recon_runs GROUP BY year_month
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
      // 重跑算法拿 matched + buDiffIds（不缓存，因为跨 session 后 lastRunCache 失效）
      const result = runReconciliation(db, row.year_month);
      if (result.status !== 'success') {
        // 数据已变（比如导入数据后又被覆盖），算异常处理
        skippedMonths.push(row.year_month);
        continue;
      }
      months.push({
        yearMonth: row.year_month,
        runId: row.id,
        matchedPending: result.matchedPending,
        matchedBank: result.matchedBank,
        buDiffPendingIds: result.buDiffPendingIds,
        buDiffBankIds: result.buDiffBankIds,
        nmAnomalies: result.nmAnomalies   // v0.8: 跨月汇总也带 N:M 异常
      });
    }
    return { months, skippedMonths };
  }

  // v0.5 新增：指定 runId 拿 matched + buDiffIds（用于「指定月份」导出）
  function loadRunResultByRunId(runId) {
    const run = runRepository.getRun(getDb(), runId);
    if (!run || run.status !== 'success') return null;
    // 优先用缓存
    const cached = getLastRunResult(runId);
    if (cached) return { yearMonth: run.year_month, ...cached };
    // 重跑算法
    const result = runReconciliation(getDb(), run.year_month);
    if (result.status !== 'success') return null;
    return { yearMonth: run.year_month, ...result };
  }

  return {
    importMonth,
    listMonths,
    getMonthMeta,
    run,
    getLastRunResult,
    recordExportPath,
    getRun,
    listRuns,
    listReadyMonths,
    listSuccessMonths,
    aggregateLatestSuccessRuns,
    loadRunResultByRunId
  };
}

module.exports = {
  createBankBuReconSession,
  runReconciliation,
  normalize,        // v0.9: 别名指向 normalizeKey（兼容旧 import）
  normalizeKey,
  normalizeBu,
  formatTimestamp
};
