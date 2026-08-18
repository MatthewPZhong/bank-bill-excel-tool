// v3.0.5 PR-4（Part B Phase 2）— 业务OP数据核对 per-月侧库编排层 🔴🔴 资金红线
//
// 职责：在 main.js IPC handler 与既有 biz-op-recon-session / import-worker / repositories 之间插一层，
//   把 run 级批量数据（imports / flow_imports / runs / diff_rows 四表）的读写路由到 per-月侧库文件，
//   主库只保留 runs 元数据镜像行（side_db_rel_path + summary + status），实现：
//     - 导入写路径：runBizOpImport / runFlowImport 传「该月侧库 dbPath」给 worker（worker 自开侧库连接
//       + ensureBizOpReconTablesSupport 幂等建侧库表 = 与 run-data-store DDL 同 schema）。
//     - 对账 inline 直跑（biz-op 无 runCheck worker）：runReconciliation(侧库 db) → 侧库 insertRun
//       → 主库 runs 镜像 upsert。
//     - 双源读路径（B-D2）：侧库存在 → 遍历侧库；不存在 → 读主库旧表（历史数据零变化）。
//     - 导出：走侧库（loadExportDb 解析该 run 所在侧库给 writer）。
//     - 孤儿双向兜底（B.6）：扫侧库目录 vs 主库 runs 镜像。
//
// 🔴 月初/月末跨月边界（biz-op per-month 单库自洽的命门，画清边界）：
//   biz-op imports 按 date 分片，侧库按「对账归属月」= month(date)。对账要求 T-1(date) + T-2(date-1) 同库。
//   per-month 下仅【月初第一天】的 T-2(上月末) 跨月。采纳「月末 D 冗余副本到 D+1 月侧库」方案：
//     ① 导入 D（月末，month(D)≠month(D+1)）：除正常落 month(D) 侧库外，额外把 D 的 (D,BU) imports 行
//        冗余落 month(D+1) 侧库（作 D+1 对账的 T-2 基线）。
//     ② 对账 date（月初）：month(date) 侧库已含 T-2 冗余副本 → runReconciliation 单库自洽，算法零改动；
//        diff source_row_id 指向 month(date) 侧库行 → 导出 getRowById 命中 byte-for-byte。
//     ③ 月末 D/D+1 写清边界：worker 在 month(D) 侧库内已清 (D,BU)+(D+1,BU)；跨月时编排层补清
//        month(D+1) 侧库的 (D,BU)[旧冗余副本] + (D+1,BU)（重导刷新一致）。
//   详见本文件 importBizOpFiles 内注释 + changes/size-startup-optimization/phase234-impl-spec.md §2.4。
//
// 关键不变量：
//   1. 🔴 runReconciliation / 4 步算法 / import-worker 校验语义 / writer 一字不改；在侧库 db 上运行 = 主库上运行。
//      parity byte-for-byte 由 biz-op-recon-side-db-parity.js 集成脚本锁死。
//   2. 主库镜像行：按 (data_date, bu_name) 存（biz-op run 粒度 = (date,BU)）+ side_db_rel_path（= month 侧库相对路径）。

'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const session = require('./biz-op-recon-session');
const importsRepository = require('../backend/biz-op-recon-db/imports-repository');
const datasetHeadRepository = require('../backend/biz-op-recon-db/dataset-head-repository');
const monthEndCopyIntents = require('../backend/biz-op-recon-db/month-end-copy-intent-repository');
const runRepository = require('../backend/biz-op-recon-db/run-repository');
const runDataStore = require('../backend/run-data-store');
const { appendModuleLog } = require('../backend/logger');
const {
  BIZ_OP_MODULE_ID,
  BIZ_OP_RUN_TASK_KEY,
  bizOpRunLineagePlan,
  bizOpRunOutputIntent
} = require('./biz-op-archive-lineage');

const MODULE = runDataStore.MODULE_BIZ_OP;
const RUNS_TABLE = 'biz_op_recon_runs';
const BIZ_OP_IMPORT_TASK_KEY = 'bizOpRecon:import:run-biz-op';

// date（YYYY-MM-DD）→ monthKey（YYYY-MM）。
function monthOf(date) {
  return String(date).slice(0, 7);
}

// ── 主库 runs 镜像行 helpers（侧库 run → 主库元数据，含 side_db_rel_path）──

// upsert 主库 runs 镜像行（同 (date, BU) 保留单镜像行：先删该 (date,BU) 旧镜像，再插新）。
//   主库镜像不含 imports/diff（在侧库）；仅记 summary + side_db_rel_path + status。
//   ⚠️ 与侧库 clearRunsAndDiffsByDateBu 月内清旧 run 语义一致——主库镜像也保留 (date,BU) 单行最新。
// 返回主库镜像行 id —— 🔴 对外（UI / 导出 handler）的 runId 真值（侧库 insertRun 的自增 id 是侧库内部 id，
//   与主库镜像 id 不同命名空间；UI 从 run 结果拿 runId 再传给 export，必须用主库镜像 id；导出再由镜像
//   (date,BU) 反查侧库内 run id 查 diff_rows，见 openExportContextByRun）。
function upsertMainRunMirror(mainDb, {
  date, buName, relPath, stats, status, archiveTaskRunId = null
}) {
  let mirrorId;
  mainDb.exec('BEGIN');
  try {
    runRepository.assertNoUnacknowledgedArchiveRunByDateBu(mainDb, date, buName);
    // 月级覆盖按 (date,BU)：用 LOWER(TRIM(bu_name)) 与对账 normalizeBu 语义一致（防大小写副本残留）。
    mainDb.prepare(
      `DELETE FROM ${RUNS_TABLE} WHERE data_date = ? AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?))`
    ).run(date, buName);
    const r = mainDb.prepare(`
      INSERT INTO ${RUNS_TABLE}
        (data_date, bu_name, status,
         t1_op_total, t2_op_total, flow_total,
         amount_diff_count, multi_op_account_count, t2_anomaly_account_count,
         t1_not_t2_count, t2_not_t1_count, export_path, side_db_rel_path,
         archive_contract_version, archive_task_run_id, archive_terminal_ack_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      date,
      buName,
      status,
      stats.t1OpTotal,
      stats.t2OpTotal,
      stats.flowTotal,
      stats.amountDiffCount,
      stats.multiOpAccountCount,
      stats.t2AnomalyAccountCount,
      stats.t1NotT2Count,
      stats.t2NotT1Count,
      null,
      relPath,
      archiveTaskRunId ? 1 : 0,
      archiveTaskRunId
    );
    mirrorId = Number(r.lastInsertRowid);
    mainDb.exec('COMMIT');
  } catch (err) {
    try { mainDb.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
    throw err;
  }
  return mirrorId;
}

// ── 写路径：业务OP 导入（落侧库 + 月末跨月冗余副本/补清）──

// runBizOpImport：worker 路径传该月侧库 dbPath。月末跨月时补写 D+1 月侧库的 T-2 冗余副本 + 补清。
//   params 透传 biz-op-recon-session.runBizOpImportViaWorker 所需（date / filePath / readBizOpFile /
//     writeBizOpErrorReportXlsx / errorReportsDir / onProgress / maxRowErrors），但 dbPath 由本层覆盖为侧库路径。
async function runBizOpImport({ userDataDir, runBizOpImportViaWorker, params }) {
  const { date } = params;
  const monthKey = monthOf(date);
  const nextDate = session.addOneDay(date);
  const nextMonth = monthOf(nextDate);
  // 确保该月侧库存在（worker 也会建，但先建保证后续 readback / 补清能 open）。
  const sideDbPath = runDataStore.sideDbPath(userDataDir, MODULE, monthKey);
  ensureSideDbExists(userDataDir, monthKey);

  // worker 在 month(date) 侧库内：清 (date,BU)+(D+1,BU) + clearByDateBu(date,BU) + INSERT（同月 D+1 已被清）。
  // 月末且下月侧库已存在时，worker 在当前月 COMMIT 前按首个 BU 只读复核下月 D/D+1；
  // 成功后下月复制事务仍会复核一次，覆盖两次检查之间的并发变化。
  //   传侧库 db 句柄作无 dbPath fallback 用（worker 入口优先 dbPath）；getDb 返回侧库连接。
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  let monthEndCopyPlan = null;
  if (nextMonth !== monthKey) {
    if (runDataStore.sideDbExists(userDataDir, MODULE, nextMonth)) {
      const nextSideDb = runDataStore.openSideDb(userDataDir, MODULE, nextMonth);
      nextSideDb.close();
    }
    monthEndCopyPlan = {
      targetDbPath: runDataStore.sideDbPath(userDataDir, MODULE, nextMonth),
      targetMonth: nextMonth,
      dataDate: date,
      nextDate
    };
  }
  let result;
  try {
    result = await runBizOpImportViaWorker(sideDb, {
      ...params,
      dbPath: sideDbPath,
      datasetSeed: {
        datasetId: randomUUID(),
        producerTaskRunId: params.batchContext.taskRunId
      },
      monthEndCopyPlan
    });
  } catch (error) {
    if (monthEndCopyPlan
        && monthEndCopyIntents.getByTaskRunId(sideDb, params.batchContext.taskRunId)) {
      error.preserveArchiveFileTask = true;
    }
    throw error;
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }

  // 仅成功导入才处理跨月（rejected/error 未改任何数据，无需补清/冗余）。
  if (result && result.status === 'success') {
    if (monthEndCopyPlan) {
      try {
        applyMonthEndCopyIntent({
          userDataDir,
          sourceMonth: monthKey,
          sourceTaskRunId: params.batchContext.taskRunId
        });
      } catch (error) {
        error.preserveArchiveFileTask = true;
        throw error;
      }
    }
  }
  return result;
}

function monthEndCopyConflict(message, cause) {
  const error = new Error(message);
  error.code = 'BIZ_OP_MONTH_END_COPY_RECOVERY_CONFLICT';
  error.blocksArchiveStartup = true;
  if (cause) error.cause = cause;
  return error;
}

function assertIntentHead(intent, head, location) {
  if (!head
      || head.datasetId !== intent.datasetId
      || head.datasetVersion !== intent.datasetVersion
      || head.producerTaskRunId !== intent.producerTaskRunId
      || head.archiveContractVersion !== 1) {
    throw monthEndCopyConflict(`Biz OP 月末复制 ${location} dataset identity 不一致`);
  }
}

// exact intent 是 source COMMIT 与 target COMMIT 之间的 durable owner。
// target transaction 可重复执行；intent 只在 Archive File Task terminal 后由 caller 删除。
function applyMonthEndCopyIntent({ userDataDir, sourceMonth, sourceTaskRunId }) {
  const sourceDb = runDataStore.openSideDb(userDataDir, MODULE, sourceMonth);
  let intent;
  let dRows;
  let sourceHead;
  try {
    intent = monthEndCopyIntents.getByTaskRunId(sourceDb, sourceTaskRunId);
    if (!intent) {
      throw monthEndCopyConflict('Biz OP 月末复制 intent 不存在');
    }
    if (monthOf(intent.dataDate) !== sourceMonth
        || monthOf(session.addOneDay(intent.dataDate)) !== intent.targetMonth) {
      throw monthEndCopyConflict('Biz OP 月末复制 intent 月份身份不一致');
    }
    dRows = importsRepository.getRowsByDateBu(
      sourceDb,
      intent.dataDate,
      intent.normalizedBu
    );
    sourceHead = datasetHeadRepository.getHead(
      sourceDb,
      'op',
      intent.dataDate,
      intent.normalizedBu
    );
    assertIntentHead(intent, sourceHead, 'source');
    if (dRows.length === 0) {
      throw monthEndCopyConflict('Biz OP 月末复制 source rows 不存在');
    }
  } finally {
    try { sourceDb.close(); } catch (_e) { /* swallow */ }
  }

  const sourceBu = dRows[0].bu_name;
  const nextDate = session.addOneDay(intent.dataDate);
  const nextSideDb = runDataStore.openSideDb(userDataDir, MODULE, intent.targetMonth);
  try {
    nextSideDb.exec('BEGIN');
    try {
      runRepository.clearRunsAndDiffsByDateBu(nextSideDb, intent.dataDate, sourceBu);
      runRepository.clearRunsAndDiffsByDateBu(nextSideDb, nextDate, sourceBu);
      importsRepository.clearByDateBu(nextSideDb, intent.dataDate, sourceBu);
      const copyRows = dRows.map((r) => importRowToReaderShape(r));
      importsRepository.insertRows(nextSideDb, intent.dataDate, copyRows);
      datasetHeadRepository.writeHead(nextSideDb, {
        kind: 'op',
        dataDate: intent.dataDate,
        buName: sourceBu,
        identity: {
          datasetId: intent.datasetId,
          datasetVersion: intent.datasetVersion,
          producerTaskRunId: intent.producerTaskRunId,
          archiveContractVersion: 1
        }
      });
      nextSideDb.exec('COMMIT');
    } catch (err) {
      try { nextSideDb.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
      throw err;
    }
  } finally {
    try { nextSideDb.close(); } catch (_e) { /* swallow */ }
  }
  appendModuleLog({
    level: 'info', source: 'main', domain: 'biz-op-recon',
    message: '[biz-op-recon] 月末跨月冗余副本写入下月侧库（D 作 D+1 对账 T-2 基线）',
    details: [
      `date=${intent.dataDate}`,
      `bu=${sourceBu}`,
      `from=${sourceMonth}`,
      `to=${intent.targetMonth}`,
      `taskRunId=${intent.sourceTaskRunId}`,
      `rows=${dRows.length}`
    ]
  });
  return intent;
}

function acknowledgeMonthEndCopyIntent({ userDataDir, dataDate, sourceTaskRunId }) {
  const sourceDb = runDataStore.openSideDb(userDataDir, MODULE, monthOf(dataDate));
  try {
    return { removed: monthEndCopyIntents.remove(sourceDb, sourceTaskRunId) };
  } finally {
    sourceDb.close();
  }
}

function assertTargetCopyApplied({ userDataDir, intent }) {
  if (!runDataStore.sideDbExists(userDataDir, MODULE, intent.targetMonth)) {
    throw monthEndCopyConflict('Biz OP 月末复制 target side DB 不存在');
  }
  const targetDb = runDataStore.openSideDb(userDataDir, MODULE, intent.targetMonth);
  try {
    const head = datasetHeadRepository.getHead(
      targetDb,
      'op',
      intent.dataDate,
      intent.normalizedBu
    );
    assertIntentHead(intent, head, 'target');
  } finally {
    targetDb.close();
  }
}

function assertNoPendingMonthEndCopyForRun({ userDataDir, date, buName }) {
  const previousDate = session.subOneDay(date);
  const sourceMonth = monthOf(previousDate);
  if (sourceMonth === monthOf(date)
      || !runDataStore.sideDbExists(userDataDir, MODULE, sourceMonth)) return;
  const sourceDb = runDataStore.openSideDb(userDataDir, MODULE, sourceMonth);
  try {
    monthEndCopyIntents.assertNoPending(
      sourceDb,
      previousDate,
      session.normalizeBu(buName)
    );
  } finally {
    sourceDb.close();
  }
}

// DB imports 行（含 id/data_date/bu_name/row_index/imported_at 元数据）→ insertRows 可消费的 reader 风格行。
//   insertRows 用 row[col]（BIZ_OP_DB_COLUMNS）+ row._rowIndex；元数据列（id/imported_at）被忽略。
function importRowToReaderShape(row) {
  // 直接拷贝所有列（insertRows 只取 BIZ_OP_DB_COLUMNS + _rowIndex；多余键如 id/imported_at 无害被忽略）。
  const out = {};
  for (const k of Object.keys(row)) out[k] = row[k];
  out._rowIndex = row.row_index;
  return out;
}

// ── 写路径：流水导入（落侧库，无跨月）──

// runFlowImport：worker/engine 路径传该月侧库 dbPath。flow 按 date 清（不跨 BU 不跨日）→ 无跨月问题。
async function runFlowImport({ userDataDir, runFlowImportViaWorker, params }) {
  const { date } = params;
  const monthKey = monthOf(date);
  const sideDbPath = runDataStore.sideDbPath(userDataDir, MODULE, monthKey);
  ensureSideDbExists(userDataDir, monthKey);
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try {
    const previous = datasetHeadRepository.getHead(sideDb, 'flow', date);
    return await runFlowImportViaWorker(sideDb, {
      ...params,
      dbPath: sideDbPath,
      datasetSeed: {
        datasetId: randomUUID(),
        producerTaskRunId: params.batchContext.taskRunId,
        expectedDatasetId: previous ? previous.datasetId : null,
        expectedDatasetVersion: previous ? previous.datasetVersion : 0
      }
    });
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
}

// ── 写路径：对账 inline 直跑（侧库 + 主库镜像）──

// runViaSideDb：open month(date) 侧库 → runReconciliation → 侧库 insertRun（已含在 runReconciliation 内）
//   → 主库镜像 upsert。runReconciliation 内部已 insertRun + insertDiffRows（同事务），本层只取 runId + 镜像。
function runViaSideDb({ userDataDir, mainDb, date, buName, taskRunId, expectedDatasets }) {
  const monthKey = monthOf(date);
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  let out;
  try {
    // 🔴 算法零改动：runReconciliation 内读 T-1(date)+T-2(date-1)+flow(date) 全在 month(date) 侧库
    //   （月初 T-2 由月末冗余副本保证在库；见文件头注释 §跨月边界）→ 单库自洽。
    //   runReconciliation 内部已 insertRun(sideDb) + insertDiffRows（同事务）；out.runId 是侧库内部 run id。
    out = session.runReconciliation(sideDb, {
      date,
      buName,
      archiveReceipt: { archiveContractVersion: 1, archiveTaskRunId: taskRunId },
      expectedDatasets
    });
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
  // 主库镜像（summary + side_db_rel_path + status）；返回 mirrorId 作对外 runId（UI/导出用）。
  let runId;
  try {
    runId = upsertMainRunMirror(mainDb, {
      date,
      buName,
      relPath: runDataStore.sideDbRelPath(MODULE, monthKey),
      stats: out.stats,
      status: 'success',
      archiveTaskRunId: taskRunId
    });
  } catch (mirrorError) {
    try {
      deleteSideRunReceiptByTaskRunId({ userDataDir, monthKey, taskRunId });
    } catch (compensationError) {
      compensationError.code = 'BIZ_OP_MIRROR_COMPENSATION_FAILED';
      compensationError.preserveArchiveTaskRun = true;
      compensationError.cause = mirrorError;
      throw compensationError;
    }
    throw mirrorError;
  }
  return {
    runId,
    stats: out.stats,
    runLocator: `biz-op:${runDataStore.sideDbRelPath(MODULE, monthKey)}#${out.runId}`
  };
}

function deleteSideRunReceiptByTaskRunId({ userDataDir, monthKey, taskRunId }) {
  const sideDb = runDataStore.openExistingSideDb(
    runDataStore.sideDbPath(userDataDir, MODULE, monthKey)
  );
  try {
    sideDb.exec('BEGIN');
    try {
      const deleted = runRepository.deleteArchiveRunByTaskRunId(sideDb, taskRunId);
      sideDb.exec('COMMIT');
      return deleted;
    } catch (error) {
      sideDb.exec('ROLLBACK');
      throw error;
    }
  } finally {
    sideDb.close();
  }
}

function prepareRunLineage({ userDataDir, date, buName }) {
  assertNoPendingMonthEndCopyForRun({ userDataDir, date, buName });
  const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthOf(date));
  try {
    return bizOpRunLineagePlan(sideDb, { date, buName });
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
}

// ── 双源读路径（B-D2）——遍历侧库 + 主库旧表 ──

// 模块状态：importedDateBuPairs（去重）+ buList + flowImportedDates。双源（侧库目录所有月 + 主库旧表）。
function getStatusDualSource({ userDataDir, mainDb }) {
  const pairKey = (date, bu) => `${date}|${bu}`;
  const pairs = new Map(); // pairKey → { date, buName, rowCount }
  const buCount = new Map(); // buName → count
  const flowDates = new Map(); // date → rowCount

  const flowRepo = require('../backend/biz-op-recon-db/flow-imports-repository');

  // 侧库（新数据）：逐月聚合。
  for (const f of runDataStore.listSideDbFiles(userDataDir, MODULE)) {
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, f.monthKey);
    try {
      for (const p of importsRepository.listImportedDateBuPairs(sideDb)) {
        const k = pairKey(p.date, p.buName);
        // 去重：同 (date,BU) 多侧库（月末冗余副本）只算一次，rowCount 取较大（避免副本翻倍）。
        const prev = pairs.get(k);
        if (!prev || p.rowCount > prev.rowCount) pairs.set(k, { date: p.date, buName: p.buName, rowCount: p.rowCount });
      }
      for (const b of importsRepository.listDistinctBus(sideDb)) {
        buCount.set(b.buName, (buCount.get(b.buName) || 0) + b.count);
      }
      for (const d of flowRepo.listImportedDates(sideDb)) {
        flowDates.set(d.date, (flowDates.get(d.date) || 0) + d.rowCount);
      }
    } finally {
      try { sideDb.close(); } catch (_e) { /* swallow */ }
    }
  }
  // 主库旧表（历史，双源过渡）：不覆盖侧库已有键。
  try {
    for (const p of importsRepository.listImportedDateBuPairs(mainDb)) {
      const k = pairKey(p.date, p.buName);
      if (!pairs.has(k)) pairs.set(k, p);
    }
    for (const b of importsRepository.listDistinctBus(mainDb)) {
      if (!buCount.has(b.buName)) buCount.set(b.buName, b.count);
    }
    for (const d of flowRepo.listImportedDates(mainDb)) {
      if (!flowDates.has(d.date)) flowDates.set(d.date, d.rowCount);
    }
  } catch (_e) { /* swallow */ }

  const importedDateBuPairs = Array.from(pairs.values())
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.buName < b.buName ? -1 : 1)));
  const buList = Array.from(buCount.entries())
    .map(([buName, count]) => ({ buName, count }))
    .sort((a, b) => (a.buName < b.buName ? -1 : a.buName > b.buName ? 1 : 0));
  const flowImportedDates = Array.from(flowDates.entries())
    .map(([date, rowCount]) => ({ date, rowCount }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return { importedDateBuPairs, buList, flowImportedDates };
}

// BU 下拉枚举（双源去重）。
function listBuDualSource({ userDataDir, mainDb }) {
  return getStatusDualSource({ userDataDir, mainDb }).buList;
}

// check-single-day：某 BU 是否仅 1 日数据（#11）。双源——遍历侧库 + 主库旧表所有 date。
function checkSingleDayDualSource({ userDataDir, mainDb, buName }) {
  const dates = collectBuDatesDualSource({ userDataDir, mainDb, buName });
  const sorted = Array.from(dates).sort();
  return {
    onlyOneDay: sorted.length === 1,
    count: sorted.length,
    latestDate: sorted.length > 0 ? sorted[sorted.length - 1] : null
  };
}

// 收集某 BU（normalizeBu）已导入的全部 date（去重；含冗余副本不影响——Set 去重）。
function collectBuDatesDualSource({ userDataDir, mainDb, buName }) {
  const norm = session.normalizeBu(buName);
  const dates = new Set();
  const addFromDb = (db) => {
    for (const p of importsRepository.listImportedDateBuPairs(db)) {
      if (session.normalizeBu(p.buName) === norm) dates.add(p.date);
    }
  };
  for (const f of runDataStore.listSideDbFiles(userDataDir, MODULE)) {
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, f.monthKey);
    try { addFromDb(sideDb); } finally { try { sideDb.close(); } catch (_e) { /* swallow */ } }
  }
  try { addFromDb(mainDb); } catch (_e) { /* swallow */ }
  return dates;
}

// list-ready-dates（#12）：三件齐日期。双源——逐月侧库各跑 listReadyDates（每库 T-1/T-2 含冗余副本自洽）合并。
function listReadyDatesDualSource({ userDataDir, mainDb, buName }) {
  const dates = new Set();
  for (const f of runDataStore.listSideDbFiles(userDataDir, MODULE)) {
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, f.monthKey);
    try {
      for (const r of runRepository.listReadyDates(sideDb, buName)) dates.add(r.date);
    } finally {
      try { sideDb.close(); } catch (_e) { /* swallow */ }
    }
  }
  // 主库旧表历史（双源过渡）。
  try {
    for (const r of runRepository.listReadyDates(mainDb, buName)) dates.add(r.date);
  } catch (_e) { /* swallow */ }
  return Array.from(dates).sort((a, b) => (a < b ? 1 : -1)).map((date) => ({ date }));
}

// list-success-dates（#13）：导出指定日期下拉。主库镜像（侧库 run 镜像 + 历史主库 run 都在主库）。
function listSuccessDatesDualSource({ mainDb, buName }) {
  return runRepository.listSuccessDates(mainDb, buName);
}

// run:history（debug）：主库镜像 listRunsByDateBu。
function listRunsDualSource({ mainDb, date, buName }) {
  return runRepository.listRunsByDateBu(mainDb, date, buName);
}

// ── 导出（走侧库）──

// 解析某 run 的导出所需 db + 元数据（导出 writer 读 diff_rows + imports）。
//   入参 runId = 主库镜像 id（UI 从 run 结果拿）。主库镜像拿 (date,BU) + side_db_rel_path。
//   🔴 writer 用 getDiffRowsByRun(db, exportRunId) 查 diff_rows——侧库 diff_rows.run_id 是侧库内部 run id，
//     与主库镜像 id 不同命名空间！故侧库路径需反查侧库内该 (date,BU) 最新 run id 作 exportRunId。
//   返回 { db, sideDb(可 null,需 close), run, exportRunId } 或 null。
//     - 侧库 run：db=侧库, exportRunId=侧库内 (date,BU) 最新 run id。
//     - 历史主库 run（side_db_rel_path NULL）：db=主库, exportRunId=主库 runId（与镜像 id 同库自洽）。
function openExportContextByRun({ userDataDir, mainDb, runId }) {
  const run = runRepository.getRunById(mainDb, runId);
  if (!run) return null;
  if (run.side_db_rel_path) {
    const monthKey = monthOf(run.data_date);
    if (runDataStore.sideDbExists(userDataDir, MODULE, monthKey)) {
      const sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
      // 反查侧库内该 (date,BU) 最新 run id（侧库 clearRunsAndDiffsByDateBu 月内清旧 → 最多一条）。
      const sideRuns = runRepository.listRunsByDateBu(sideDb, run.data_date, run.bu_name);
      const exportRunId = sideRuns.length > 0 ? sideRuns[0].id : null;
      return { db: sideDb, sideDb, run, exportRunId };
    }
  }
  return { db: mainDb, sideDb: null, run, exportRunId: runId };
}

function freezeRunLocator({ userDataDir, mainDb, runId }) {
  const mirror = runRepository.getRunById(mainDb, runId);
  if (!mirror) throw new Error(`Biz OP run #${runId} 不存在`);
  if (!mirror.side_db_rel_path) {
    return Object.freeze({
      mirrorRunId: mirror.id,
      sideDbRelPath: null,
      sideRunId: mirror.id,
      date: mirror.data_date,
      buName: mirror.bu_name,
      archiveTaskRunId: null
    });
  }
  const sideDb = runDataStore.openExistingSideDb(
    runDataStore.resolveFromRel(userDataDir, mirror.side_db_rel_path)
  );
  try {
    const sideRun = mirror.archive_contract_version === 1
      ? runRepository.getRunByArchiveTaskRunId(sideDb, mirror.archive_task_run_id)
      : runRepository.listRunsByDateBu(sideDb, mirror.data_date, mirror.bu_name)[0];
    if (!sideRun) throw new Error(`Biz OP run #${runId} 的 side receipt 不存在`);
    if (sideRun.data_date !== mirror.data_date
        || session.normalizeBu(sideRun.bu_name) !== session.normalizeBu(mirror.bu_name)) {
      throw new Error(`Biz OP run #${runId} 的 mirror 与 side receipt 不一致`);
    }
    return Object.freeze({
      mirrorRunId: mirror.id,
      sideDbRelPath: mirror.side_db_rel_path,
      sideRunId: sideRun.id,
      date: sideRun.data_date,
      buName: sideRun.bu_name,
      archiveTaskRunId: sideRun.archive_contract_version === 1
        ? sideRun.archive_task_run_id
        : null
    });
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
}

function freezeRangeRunSelection({ userDataDir, mainDb, buName, startDate, endDate }) {
  const selected = runRepository.listSuccessDatesInRange(mainDb, buName, startDate, endDate)
    .map(({ runId }) => freezeRunLocator({ userDataDir, mainDb, runId }));
  return Object.freeze({
    runLocators: Object.freeze(selected),
    lineageIntents: Object.freeze(selected.map((locator) => bizOpRunOutputIntent({
      sideDbRelPath: locator.sideDbRelPath || 'legacy-main',
      sideRunId: locator.sideRunId,
      archiveTaskRunId: locator.archiveTaskRunId
    })))
  });
}

function openExportContextByLocator({ userDataDir, mainDb, locator }) {
  if (!locator.sideDbRelPath) {
    const run = runRepository.getRunById(mainDb, locator.sideRunId);
    if (!run) throw new Error(`Biz OP legacy run #${locator.sideRunId} 不存在`);
    return { db: mainDb, sideDb: null, run, exportRunId: run.id };
  }
  const sideDb = runDataStore.openExistingSideDb(
    runDataStore.resolveFromRel(userDataDir, locator.sideDbRelPath)
  );
  const run = runRepository.getRunById(sideDb, locator.sideRunId);
  if (!run || run.data_date !== locator.date
      || session.normalizeBu(run.bu_name) !== session.normalizeBu(locator.buName)
      || (locator.archiveTaskRunId && run.archive_task_run_id !== locator.archiveTaskRunId)) {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
    throw new Error('Biz OP frozen run locator 与 side DB 不一致');
  }
  return { db: sideDb, sideDb, run, exportRunId: run.id };
}

// ⚠️ 区间导出（export:date-range）跨多日多月：writer 用单 db 读多个 run 的 diff + imports。
//   per-month 下区间可能跨多个侧库文件——单 db 句柄读不全。
//   决策：区间导出构造一个【临时内存合并 db】，把区间内所有 success run 对应的 run + diff_rows + imports
//     合并进内存 db，在合并 db 上跑 writer（writer / listSuccessDatesInRange / getRowById 零改动）。
//   🔴 跨月 id 冲突：不同月侧库各自自增 → run.id / imports.id 可能撞（如各自 id=1）。复制时按
//     【每个 (date,BU) 源一个 id 偏移量】重映射 run.id（→ diff.run_id）+ imports.id（→ diff.source_row_id），
//     保关系不变 + 全局唯一。偏移量足够大（IMPORT_ID_OFFSET）避免不同源区间重叠。
//   合并 db 是只读消费（仅供 writer SELECT），不回写任何侧库。
const RANGE_RUN_ID_STRIDE = 1000000;      // 每源 run.id 偏移步长（区间内 run 数远小于此）
const RANGE_IMPORT_ID_STRIDE = 100000000; // 每源 imports.id 偏移步长（单日 imports 数远小于此）
function buildRangeExportDb({ userDataDir, mainDb, buName, startDate, endDate }) {
  const { DatabaseSync } = require('node:sqlite');
  const memDb = new DatabaseSync(':memory:');
  // 建 biz-op 4 表（与侧库同 schema，writer 只读 runs/diff_rows/imports）。
  memDb.exec(runDataStore.SIDE_DB_DDL_BIZ_OP);

  // 主库镜像取区间内 success run（按 (date,BU)，listSuccessDatesInRange 已 date 升序）。
  const successRuns = runRepository.listSuccessDatesInRange(mainDb, buName, startDate, endDate);
  let sourceIndex = 0;
  for (const { date } of successRuns) {
    const monthKey = monthOf(date);
    let srcDb;
    let sideDb = null;
    const mirror = mainDb.prepare(
      `SELECT side_db_rel_path FROM ${RUNS_TABLE} WHERE data_date = ? AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?)) ORDER BY id DESC LIMIT 1`
    ).get(date, buName);
    if (mirror && mirror.side_db_rel_path && runDataStore.sideDbExists(userDataDir, MODULE, monthKey)) {
      sideDb = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
      srcDb = sideDb;
    } else {
      srcDb = mainDb; // 历史主库 run
    }
    try {
      // 每源独立 id 偏移（避免跨月侧库自增 id 撞车）。
      const runIdOffset = sourceIndex * RANGE_RUN_ID_STRIDE;
      const importIdOffset = sourceIndex * RANGE_IMPORT_ID_STRIDE;
      copyRunIntoMemDb(srcDb, memDb, date, buName, { runIdOffset, importIdOffset });
    } finally {
      if (sideDb) { try { sideDb.close(); } catch (_e) { /* swallow */ } }
    }
    sourceIndex += 1;
  }
  return memDb;
}

function buildFrozenRangeExportDb({ userDataDir, mainDb, runLocators }) {
  const { DatabaseSync } = require('node:sqlite');
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(runDataStore.SIDE_DB_DDL_BIZ_OP);
  const groups = new Map();
  runLocators.forEach((locator, sourceIndex) => {
    const sourceKey = locator.sideDbRelPath || '<main>';
    if (!groups.has(sourceKey)) groups.set(sourceKey, []);
    groups.get(sourceKey).push({ locator, sourceIndex });
  });
  try {
    for (const [sourceKey, selections] of groups) {
      const sideDb = sourceKey === '<main>'
        ? null
        : runDataStore.openExistingSideDb(
            runDataStore.resolveFromRel(userDataDir, sourceKey)
          );
      const srcDb = sideDb || mainDb;
      try {
        srcDb.exec('BEGIN');
        for (const { locator, sourceIndex } of selections) {
          copyRunIntoMemDb(srcDb, memDb, locator.date, locator.buName, {
            runIdOffset: sourceIndex * RANGE_RUN_ID_STRIDE,
            importIdOffset: sourceIndex * RANGE_IMPORT_ID_STRIDE,
            sourceRunId: locator.sideRunId,
            expectedArchiveTaskRunId: locator.archiveTaskRunId
          });
        }
        srcDb.exec('COMMIT');
      } catch (error) {
        try { srcDb.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
        throw error;
      } finally {
        if (sideDb) { try { sideDb.close(); } catch (_e) { /* swallow */ } }
      }
    }
    return memDb;
  } catch (error) {
    try { memDb.close(); } catch (_e) { /* swallow */ }
    throw error;
  }
}

// 把 srcDb 中某 (date,BU) 的最新 success run + 其 diff_rows + 涉及的 imports 行复制进 memDb，
//   id 加偏移（run.id += runIdOffset，imports.id += importIdOffset；diff.run_id / diff.source_row_id 同步偏移），
//   保持 run↔diff 与 diff↔imports 关系不变（writer getDiffRowsByRun + getRowById 自洽）。
function copyRunIntoMemDb(srcDb, memDb, date, buName, {
  runIdOffset = 0, importIdOffset = 0, sourceRunId = null,
  expectedArchiveTaskRunId = null
} = {}) {
  // srcDb 该 (date,BU) 最新 run（listSuccessDates 取 MAX(id)）。
  const runRow = sourceRunId == null
    ? srcDb.prepare(`
      SELECT * FROM ${RUNS_TABLE}
      WHERE data_date = ? AND LOWER(TRIM(bu_name)) = LOWER(TRIM(?)) AND status = 'success'
      ORDER BY id DESC LIMIT 1
    `).get(date, buName)
    : srcDb.prepare(`SELECT * FROM ${RUNS_TABLE} WHERE id = ? AND status = 'success'`).get(sourceRunId);
  if (!runRow) {
    if (sourceRunId != null) throw new Error('Biz OP frozen range run 不存在');
    return;
  }
  if (sourceRunId != null && (runRow.data_date !== date
      || session.normalizeBu(runRow.bu_name) !== session.normalizeBu(buName)
      || (expectedArchiveTaskRunId && runRow.archive_task_run_id !== expectedArchiveTaskRunId))) {
    throw new Error('Biz OP frozen range locator 与 run identity 不一致');
  }
  const newRunId = runRow.id + runIdOffset;
  memDb.prepare(`
    INSERT OR REPLACE INTO ${RUNS_TABLE}
      (id, data_date, bu_name, run_at, status, t1_op_total, t2_op_total, flow_total,
       amount_diff_count, multi_op_account_count, t2_anomaly_account_count,
       t1_not_t2_count, t2_not_t1_count, export_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newRunId, runRow.data_date, runRow.bu_name, runRow.run_at, runRow.status,
    runRow.t1_op_total, runRow.t2_op_total, runRow.flow_total,
    runRow.amount_diff_count, runRow.multi_op_account_count, runRow.t2_anomaly_account_count,
    runRow.t1_not_t2_count, runRow.t2_not_t1_count, runRow.export_path
  );
  // 复制 diff_rows（id + run_id + source_row_id 同步偏移）。
  const diffRows = srcDb.prepare(`SELECT * FROM biz_op_recon_diff_rows WHERE run_id = ?`).all(runRow.id);
  const insDiff = memDb.prepare(`
    INSERT OR REPLACE INTO biz_op_recon_diff_rows
      (id, run_id, data_date, bu_name, source_table, source_row_id, cmp_t2, multi_op_flag, cmp_amount, amount_diff)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const neededImportIds = new Set();
  for (const dr of diffRows) {
    insDiff.run(
      dr.id + runIdOffset, newRunId, dr.data_date, dr.bu_name, dr.source_table,
      dr.source_row_id + importIdOffset, dr.cmp_t2, dr.multi_op_flag, dr.cmp_amount, dr.amount_diff
    );
    neededImportIds.add(dr.source_row_id);
  }
  // 复制涉及的 imports 行（id 偏移；writer getRowById(source_row_id+offset) 命中）。
  if (neededImportIds.size > 0) {
    const BIZ_OP_DB_COLUMNS = require('../backend/biz-op-recon-db/columns').BIZ_OP_DB_COLUMNS;
    const dataCols = ['data_date', 'bu_name', 'row_index', ...BIZ_OP_DB_COLUMNS, 'imported_at'];
    const insCols = ['id', ...dataCols];
    const ph = insCols.map(() => '?').join(', ');
    const insImp = memDb.prepare(`INSERT OR REPLACE INTO biz_op_recon_imports (${insCols.join(', ')}) VALUES (${ph})`);
    const selImp = srcDb.prepare(`SELECT id, ${dataCols.join(', ')} FROM biz_op_recon_imports WHERE id = ?`);
    for (const impId of neededImportIds) {
      const impRow = selImp.get(impId);
      if (!impRow && sourceRunId != null) {
        throw new Error(`Biz OP frozen range run 缺少 source row #${impId}`);
      }
      if (impRow) insImp.run(impRow.id + importIdOffset, ...dataCols.map((c) => impRow[c]));
    }
  }
}

// 记录导出路径（更新主库镜像行 export_path）。
function recordExportPath({ mainDb, runId, exportPath }) {
  runRepository.updateRunExportPath(mainDb, runId, exportPath);
}

// 取主库镜像 run（导出 handler 校验用）。
function getMirrorRun({ mainDb, runId }) {
  return runRepository.getRunById(mainDb, runId);
}

function statsFromRun(run) {
  return {
    t1OpTotal: run.t1_op_total,
    t2OpTotal: run.t2_op_total,
    flowTotal: run.flow_total,
    amountDiffCount: run.amount_diff_count,
    multiOpAccountCount: run.multi_op_account_count,
    t2AnomalyAccountCount: run.t2_anomaly_account_count,
    t1NotT2Count: run.t1_not_t2_count,
    t2NotT1Count: run.t2_not_t1_count
  };
}

function acknowledgeRunByTaskRun({ userDataDir, mainDb, taskRunId }) {
  const mirror = runRepository.getRunByArchiveTaskRunId(mainDb, taskRunId);
  if (!mirror || !mirror.side_db_rel_path) {
    throw new Error('Biz OP TaskRun 对应的主库 run mirror 不存在');
  }
  const sideDb = runDataStore.openExistingSideDb(
    runDataStore.resolveFromRel(userDataDir, mirror.side_db_rel_path)
  );
  try {
    const sideRun = runRepository.getRunByArchiveTaskRunId(sideDb, taskRunId);
    if (!sideRun) throw new Error('Biz OP TaskRun 对应的 side run receipt 不存在');
    runRepository.acknowledgeArchiveTerminal(mainDb, mirror.id, taskRunId);
    runRepository.acknowledgeArchiveTerminal(sideDb, sideRun.id, taskRunId);
    return { mirror, sideRun };
  } finally {
    try { sideDb.close(); } catch (_e) { /* swallow */ }
  }
}

function finalizeRunTerminalIntent({
  route,
  record,
  terminalOutcome,
  terminalResult,
  userDataDir,
  mainDb
}) {
  if (!route || route.route !== 'biz-op-run') {
    throw new Error(`不支持的 Biz OP terminal 路由：${route && route.route || '<empty>'}`);
  }
  const actualStatus = terminalResult && terminalResult.taskRun
    ? terminalResult.taskRun.status
    : terminalOutcome && terminalOutcome.taskStatus;
  if (actualStatus !== 'succeeded') return null;
  const owner = record && record.payload && record.payload.owner;
  const ownerTaskRunId = owner && owner.kind === 'operation'
    ? owner.operationContext && owner.operationContext.taskRunId
    : null;
  if (ownerTaskRunId !== route.taskRunId) {
    throw new Error('Biz OP terminal outbox owner 与 run receipt 不一致');
  }
  return acknowledgeRunByTaskRun({ userDataDir, mainDb, taskRunId: ownerTaskRunId });
}

function recoveryConflict(message) {
  const error = new Error(message);
  error.code = 'ARCHIVE_BIZ_OP_RUN_RECOVERY_CONFLICT';
  error.blocksArchiveStartup = true;
  return error;
}

async function bindRecoveredRunFlow({ archiveService, taskRun, mirrorRunId }) {
  const identity = {
    moduleId: BIZ_OP_MODULE_ID,
    identityType: 'business-run-id',
    identityValue: String(mirrorRunId),
    parentRunId: taskRun.parentRunId,
    sourceTaskRunId: taskRun.taskRunId
  };
  const bound = await archiveService.bindFlowAnchor(identity);
  if (bound && bound.ok !== false) return;
  const persisted = await archiveService.persistTaskFlowBindIntent(identity);
  if (!persisted || persisted.ok === false) {
    throw recoveryConflict(`Biz OP run mirror #${mirrorRunId} 的业务流程身份无法持久接管`);
  }
}

async function recoverRunReceipts({ userDataDir, mainDb, archiveService }) {
  let recovered = 0;
  for (const file of runDataStore.listSideDbFiles(userDataDir, MODULE)) {
    const sideDb = runDataStore.openSideDb(userDataDir, MODULE, file.monthKey);
    try {
      for (const receipt of runRepository.listUnacknowledgedArchiveRuns(sideDb)) {
        const taskRun = archiveService.repository.getTaskRun(receipt.archive_task_run_id);
        if (!taskRun || taskRun.moduleId !== BIZ_OP_MODULE_ID
            || taskRun.taskKey !== BIZ_OP_RUN_TASK_KEY) {
          throw recoveryConflict(`Biz OP run #${receipt.id} 的 Archive TaskRun 身份不一致`);
        }
        if (!['running', 'interrupted', 'succeeded'].includes(taskRun.status)) {
          throw recoveryConflict(
            `Biz OP run #${receipt.id} 的 Archive TaskRun 已由 ${taskRun.status} 终结`
          );
        }
        if (taskRun.status === 'interrupted') {
          const reopened = await archiveService.beginTaskRunRecovery(taskRun.taskRunId);
          if (!reopened || reopened.ok === false) {
            throw recoveryConflict(`Biz OP run #${receipt.id} 的 Archive TaskRun 无法恢复`);
          }
        }
        const expectedRelPath = runDataStore.sideDbRelPath(MODULE, file.monthKey);
        let mirror = runRepository.getRunByArchiveTaskRunId(mainDb, taskRun.taskRunId);
        if (mirror && (mirror.data_date !== receipt.data_date
            || session.normalizeBu(mirror.bu_name) !== session.normalizeBu(receipt.bu_name)
            || mirror.side_db_rel_path !== expectedRelPath)) {
          throw recoveryConflict(`Biz OP run #${receipt.id} 的主库 mirror 与 side receipt 不一致`);
        }
        if (!mirror && taskRun.status === 'succeeded') {
          runRepository.acknowledgeArchiveTerminal(sideDb, receipt.id, taskRun.taskRunId);
          recovered += 1;
          continue;
        }
        if (!mirror) {
          const mirrorId = upsertMainRunMirror(mainDb, {
            date: receipt.data_date,
            buName: receipt.bu_name,
            relPath: expectedRelPath,
            stats: statsFromRun(receipt),
            status: 'success',
            archiveTaskRunId: taskRun.taskRunId
          });
          mirror = runRepository.getRunById(mainDb, mirrorId);
        }
        await bindRecoveredRunFlow({
          archiveService,
          taskRun,
          mirrorRunId: mirror.id
        });
        if (taskRun.status !== 'succeeded') {
          const locator = `biz-op:${mirror.side_db_rel_path}#${receipt.id}`;
          const finished = await archiveService.finishTaskRun(taskRun.taskRunId, {
            taskStatus: 'succeeded',
            metadata: { bizOpRunLocator: locator }
          });
          if (!finished || finished.ok === false) {
            throw recoveryConflict(`Biz OP run #${receipt.id} 的 Archive terminal 未完成`);
          }
        }
        runRepository.acknowledgeArchiveTerminal(mainDb, mirror.id, taskRun.taskRunId);
        runRepository.acknowledgeArchiveTerminal(sideDb, receipt.id, taskRun.taskRunId);
        recovered += 1;
      }
    } finally {
      try { sideDb.close(); } catch (_e) { /* swallow */ }
    }
  }
  return { recovered };
}

function fileBatchOwnerForCopyIntent(archiveService, taskRun) {
  const batch = archiveService.repository.getBatchByOperationKey(
    taskRun.moduleId,
    taskRun.operationKey
  );
  if (!batch || batch.taskRunId !== taskRun.taskRunId) {
    throw monthEndCopyConflict('Biz OP 月末复制的 Archive File Batch 身份不一致');
  }
  return {
    batch,
    batchContext: {
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      taskRunId: batch.taskRunId,
      taskKey: batch.taskKey,
      moduleId: batch.moduleId,
      parentRunId: batch.parentRunId,
      operationKey: batch.operationKey
    },
    manifest: batch.metadata._fileManifest
  };
}

async function recoverMonthEndCopyIntents({ userDataDir, archiveService }) {
  let recovered = 0;
  for (const file of runDataStore.listSideDbFiles(userDataDir, MODULE)) {
    const sourceDb = runDataStore.openSideDb(userDataDir, MODULE, file.monthKey);
    let intents;
    try {
      intents = monthEndCopyIntents.list(sourceDb);
    } finally {
      sourceDb.close();
    }
    for (const intent of intents) {
      try {
        const taskRun = archiveService.repository.getTaskRun(intent.sourceTaskRunId);
        if (!taskRun || taskRun.moduleId !== BIZ_OP_MODULE_ID
            || taskRun.taskKey !== BIZ_OP_IMPORT_TASK_KEY) {
          throw monthEndCopyConflict('Biz OP 月末复制的 Archive TaskRun 身份不一致');
        }
        if (taskRun.status === 'succeeded') {
          assertTargetCopyApplied({ userDataDir, intent });
          acknowledgeMonthEndCopyIntent({
            userDataDir,
            dataDate: intent.dataDate,
            sourceTaskRunId: intent.sourceTaskRunId
          });
          recovered += 1;
          continue;
        }
        if (!['running', 'interrupted'].includes(taskRun.status)) {
          throw monthEndCopyConflict(
            `Biz OP 月末复制的 Archive TaskRun 已由 ${taskRun.status} 终结`
          );
        }
        const owner = fileBatchOwnerForCopyIntent(archiveService, taskRun);
        const reopened = await archiveService.beginFileTaskRecovery(owner.batchContext, {
          manifestIdentity: owner.manifest.identity
        });
        if (!reopened || reopened.ok === false) {
          throw monthEndCopyConflict('Biz OP 月末复制的 Archive File Task 无法恢复');
        }
        const settled = await archiveService.settleManifestArtifacts({
          batchContext: owner.batchContext,
          files: owner.manifest.artifactKeys
            .map((artifactKey) => ({ artifactKey }))
        });
        if (!settled || settled.durable !== true) {
          throw monthEndCopyConflict('Biz OP 月末复制的输入 evidence 未形成耐久结果');
        }
        applyMonthEndCopyIntent({
          userDataDir,
          sourceMonth: file.monthKey,
          sourceTaskRunId: intent.sourceTaskRunId
        });
        const finished = await archiveService.finishFileTask(
          intent.sourceTaskRunId,
          owner.batch.id,
          {
            taskStatus: 'succeeded',
            metadata: { bizOpMonthEndCopyRecovered: true }
          }
        );
        if (!finished || finished.ok === false) {
          throw monthEndCopyConflict('Biz OP 月末复制的 Archive terminal 未完成');
        }
        acknowledgeMonthEndCopyIntent({
          userDataDir,
          dataDate: intent.dataDate,
          sourceTaskRunId: intent.sourceTaskRunId
        });
        recovered += 1;
      } catch (error) {
        if (error && error.blocksArchiveStartup === true) throw error;
        throw monthEndCopyConflict('Biz OP 月末复制恢复失败', error);
      }
    }
  }
  return { recovered };
}

// ── retention / 孤儿双向兜底 ──

// 确保该月侧库存在（建表）。
function ensureSideDbExists(userDataDir, monthKey) {
  const db = runDataStore.openSideDb(userDataDir, MODULE, monthKey);
  try { /* 仅建表 */ } finally { try { db.close(); } catch (_e) { /* swallow */ } }
}

// 删整月侧库文件 + 主库该月所有 (date,BU) 镜像行。
function deleteMonthSideDb({ userDataDir, mainDb, monthKey }) {
  const r = runDataStore.deleteSideDb(userDataDir, MODULE, monthKey);
  try {
    // 删该月所有 date 的镜像行（data_date LIKE 'YYYY-MM%'）。
    mainDb.prepare(
      `DELETE FROM ${RUNS_TABLE} WHERE data_date LIKE ? AND side_db_rel_path IS NOT NULL`
    ).run(monthKey + '%');
  } catch (_e) { /* swallow */ }
  return r;
}

// 孤儿双向兜底（B.6）：① 有文件无 imports 无镜像（空壳/损坏）→ 删文件；② 有镜像无文件 → 标失效。
function reconcileOrphans({ userDataDir, mainDb }) {
  const stats = { deletedOrphanFiles: [], invalidatedRuns: [] };

  let mirrorRows = [];
  try {
    mirrorRows = mainDb.prepare(
      `SELECT id, data_date, side_db_rel_path, status FROM ${RUNS_TABLE} WHERE side_db_rel_path IS NOT NULL`
    ).all();
  } catch (_e) {
    mirrorRows = [];
  }
  // 镜像涉及的月份集合。
  const mirrorMonths = new Set(mirrorRows.map((r) => monthOf(r.data_date)));

  const files = runDataStore.listSideDbFiles(userDataDir, MODULE);
  const fileMonths = new Set(files.map((f) => f.monthKey));

  // ① 有文件无镜像月 → 仅删空壳（无 imports 也无 flow，判定崩溃残留）。
  for (const f of files) {
    if (mirrorMonths.has(f.monthKey)) continue;
    let isEmptyShell = false;
    try {
      const sideDb = runDataStore.openSideDb(userDataDir, MODULE, f.monthKey);
      try {
        const flowRepo = require('../backend/biz-op-recon-db/flow-imports-repository');
        const impCount = importsRepository.listImportedDateBuPairs(sideDb).length;
        const flowCount = flowRepo.listImportedDates(sideDb).length;
        isEmptyShell = (impCount === 0 && flowCount === 0);
      } finally {
        try { sideDb.close(); } catch (_e) { /* swallow */ }
      }
    } catch (_e) {
      isEmptyShell = true; // 文件损坏 → 删
    }
    if (isEmptyShell) {
      const r = runDataStore.deleteSideDbByPath(f.path);
      if (r.deleted) {
        stats.deletedOrphanFiles.push(f.monthKey);
        appendModuleLog({
          level: 'info', source: 'main', domain: 'biz-op-recon',
          message: '[biz-op-recon] 孤儿侧库文件清理（空壳/损坏，无 imports/flow 无镜像）',
          details: [`monthKey=${f.monthKey}`, `path=${f.path}`]
        });
      }
    }
  }

  // ② 有镜像无文件月 → 标失效（不崩溃，UI 降级）。
  for (const row of mirrorRows) {
    const monthKey = monthOf(row.data_date);
    if (!fileMonths.has(monthKey) && row.status !== 'side-db-missing') {
      try {
        mainDb.prepare(`UPDATE ${RUNS_TABLE} SET status = 'side-db-missing' WHERE id = ?`).run(row.id);
        stats.invalidatedRuns.push(`${row.data_date}`);
        appendModuleLog({
          level: 'warning', source: 'main', domain: 'biz-op-recon',
          message: '[biz-op-recon] 侧库文件缺失，run 标记失效（有镜像无文件）',
          details: [`date=${row.data_date}`, `runId=${row.id}`, `side_db_rel_path=${row.side_db_rel_path}`]
        });
      } catch (_e) { /* swallow */ }
    }
  }

  return stats;
}

module.exports = {
  MODULE,
  monthOf,
  runBizOpImport,
  runFlowImport,
  runViaSideDb,
  prepareRunLineage,
  applyMonthEndCopyIntent,
  acknowledgeMonthEndCopyIntent,
  getStatusDualSource,
  listBuDualSource,
  checkSingleDayDualSource,
  listReadyDatesDualSource,
  listSuccessDatesDualSource,
  listRunsDualSource,
  openExportContextByRun,
  openExportContextByLocator,
  freezeRunLocator,
  freezeRangeRunSelection,
  buildRangeExportDb,
  buildFrozenRangeExportDb,
  recordExportPath,
  getMirrorRun,
  acknowledgeRunByTaskRun,
  finalizeRunTerminalIntent,
  recoverRunReceipts,
  recoverMonthEndCopyIntents,
  deleteMonthSideDb,
  reconcileOrphans,
  upsertMainRunMirror
};
