// v2.1.12 需求1 T-vcc-3 — VCC业务OP计算：session 层 + 发生额/期末OP 计算（资金红线 🔴）
//
// 核心业务语义（spec §0.2 已拍板，勿改）：
//   发生额入 = direction==='入' 的 recon_amount 求和
//   发生额出 = direction==='出' 的 recon_amount 求和
//   发生额   = 发生额入 − 发生额出
//   期末OP   = 期初OP（用户手输）+ 发生额
//   月份归属 = 流水「账单日期」bill_date_raw 所在月（YYYY-MM）
//
// 资金红线 🔴（spec §6.1 + Q5/Q6/Q8）：
//   1) 精度：金额一律「乘 100 转整数分 + 整数求和 + 最后除回」，避免 0.1+0.2!==0.3 浮点漂移；
//      金额对外/落库一律字符串（TEXT）。
//   2) 混币种全量合并（Q6=H 拍板）：所有币种 recon_amount 不分币种相加；currency 列存涉及币种列表或 MIXED。
//   3) 整批拒绝（Q8）：出入方向非「入/出」、对账金额非数值、一次导入多月份混杂 → 整批拒绝 + 错误行清单（不静默跳过）。
//   4) 空对账金额 → 计为 0 分（不报错，spec Q5）；空账单日期行无法定月 → 整批拒绝。
//
// 范式蓝本：src/main-process/bank-bu-recon-session.js（createXxxSession({getDb})）
//          src/main-process/biz-op-recon-session.js（parseSignedAmount / 整批拒绝）

const runRepository = require('../backend/vcc-op-calc-db/run-repository');
const path = require('node:path');
const { streamFlowFile } = require('../backend/vcc-op-calc-import/reader');
const {
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT
} = require('../backend/vcc-op-calc-db/columns');
const {
  centsToAmountString,
  extractYearMonth,
  normalizeDirection,
  parseAmountToCents,
  validateAndExtractRow
} = require('./vcc-op-calc/parser-core');
const { runVccParserPipeline } = require('./vcc-op-calc/parser-pipeline');
const { canonicalJsonSnapshot } = require('./background-execution/canonical-json-v1');
const { saveVccOpRunWithReceipt } = require('./vcc-op-calc/save-run-contract');

class VccComputeSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VccComputeSnapshotError';
    this.code = code;
  }
}

// ---------------- 核心计算（资金红线 🔴） ----------------

// 扫描所有文件 rows：统计总条数 + 定唯一月份（资金红线 🔴 整批拒绝）。
// 入参 fileResults = [{ fileName, rows }]
// 返回 { ok:true, yearMonth, totalRows } 或 { ok:false, errorRows:[{ fileName, rowIndex, reason }] }
//   非法方向 / 非数值金额 / 空账单日期 → 收集为 errorRows；
//   多月份混杂（含跨文件）→ 追加一条 errorRows（rowIndex=0，reason 列出涉及月份）。
function scan(fileResults) {
  const list = Array.isArray(fileResults) ? fileResults : [];
  const errorRows = [];
  const months = new Set();
  let totalRows = 0;

  for (const fr of list) {
    const fileName = fr && fr.fileName ? fr.fileName : '';
    const rows = fr && Array.isArray(fr.rows) ? fr.rows : [];
    for (const r of rows) {
      totalRows += 1;
      const res = validateAndExtractRow(r);
      if (!res.ok) {
        errorRows.push({ fileName, rowIndex: r._rowIndex || 0, reason: res.reason });
        continue;
      }
      months.add(res.yearMonth);
    }
  }

  if (totalRows === 0) {
    return { ok: false, errorRows: [{ fileName: '', rowIndex: 0, reason: '所选文件无有效数据行' }] };
  }

  // 多月份混杂（含跨文件）→ 整批拒绝（spec Q8：一次导入应为同一流水月）
  if (months.size > 1) {
    errorRows.push({
      fileName: '',
      rowIndex: 0,
      reason: `一次导入流水跨多个月份（${[...months].sort().join(', ')}），请按月分开导入`
    });
  }

  if (errorRows.length > 0) {
    return { ok: false, errorRows };
  }

  return { ok: true, yearMonth: [...months][0], totalRows };
}

// 统计发生额出/入/总额 + perFile（不落库，资金红线 🔴 整数分累加）。
// 入参 fileResults = [{ fileName, rows }]
// 返回 { ok:true, yearMonth, totals:{ totalOutCents, totalInCents, totalAmountCents, totalOut, totalIn, totalAmount, currency }, perFile:[...] }
//   或 { ok:false, errorRows:[...] }（整批拒绝，口径与 scan 完全一致）。
// 口径（spec §0.2 / §3.2，混币种全量合并 Q6）：
//   发生额入 = direction==='入' 的 cents 求和；发生额出 = direction==='出' 的 cents 求和；
//   发生额 = 入 − 出（整数分相减后除回）；所有币种不分币种合并。
function computeAmounts(fileResults) {
  // 先用 scan 做整批校验 + 定月份（口径单一，避免双份校验逻辑漂移）
  const scanResult = scan(fileResults);
  if (!scanResult.ok) {
    return { ok: false, errorRows: scanResult.errorRows };
  }
  const yearMonth = scanResult.yearMonth;

  const list = Array.isArray(fileResults) ? fileResults : [];
  let totalInCents = 0;
  let totalOutCents = 0;
  const currencySet = new Set();
  const perFile = [];

  for (const fr of list) {
    const fileName = fr && fr.fileName ? fr.fileName : '';
    const rows = fr && Array.isArray(fr.rows) ? fr.rows : [];
    let fileInCents = 0;
    let fileOutCents = 0;
    let fileRowCount = 0;
    for (const r of rows) {
      const res = validateAndExtractRow(r);
      // scan 已保证全行合法，这里 res.ok 必为 true（防御性二次保护）
      if (!res.ok) continue;
      fileRowCount += 1;
      if (res.direction === VALID_DIRECTION_IN) {
        fileInCents += res.cents;
        totalInCents += res.cents;
      } else {
        fileOutCents += res.cents;
        totalOutCents += res.cents;
      }
      if (res.currency) currencySet.add(res.currency);
    }
    const fileAmountCents = fileInCents - fileOutCents;
    perFile.push({
      fileName,
      rowCount: fileRowCount,
      amountOutCents: fileOutCents,
      amountInCents: fileInCents,
      amountCents: fileAmountCents,
      amountOut: centsToAmountString(fileOutCents),
      amountIn: centsToAmountString(fileInCents),
      amount: centsToAmountString(fileAmountCents)
    });
  }

  const totalAmountCents = totalInCents - totalOutCents;
  // 涉及币种：单一 → 该币种；多 → 排序列表（spec §1.2 currency 列）；空 → null
  const currencyList = [...currencySet].filter((c) => c !== '').sort();
  let currency = null;
  if (currencyList.length === 1) currency = currencyList[0];
  else if (currencyList.length > 1) currency = currencyList.join(',');

  return {
    ok: true,
    yearMonth,
    totals: {
      totalOutCents,
      totalInCents,
      totalAmountCents,
      totalOut: centsToAmountString(totalOutCents),
      totalIn: centsToAmountString(totalInCents),
      totalAmount: centsToAmountString(totalAmountCents),
      currency
    },
    perFile
  };
}

// ---------------- session factory ----------------

function createVccOpCalcSession({
  getDb,
  parserPipeline = runVccParserPipeline,
  saveRunFaultInjector = null
}) {
  // 中间结果缓存（仿 bank-bu-recon-session.js:154 lastRunCache）：
  //   选完文件后 scan/compute 的原始 rows + 统计结果存这里，save 时直接落库，避免重读盘。
  let lastScanCache = null;   // { fileResults, yearMonth, totalRows }
  let lastComputeCache = null; // immutable { yearMonth, totals, perFile, ...pipeline evidence }
  let scanGeneration = 0;
  let activeParserScan = null;

  function abortActiveParserScan() {
    const active = activeParserScan;
    if (!active) return;
    activeParserScan = null;
    active.superseded = true;
    active.controller.abort();
  }

  function linkParserScanAbortSignal(source, target) {
    if (!source) return () => {};
    if (source.aborted) {
      target.abort();
      return () => {};
    }
    const abort = () => target.abort();
    source.addEventListener('abort', abort, { once: true });
    return () => source.removeEventListener('abort', abort);
  }

  // 每次新 scan/clear 都先取消旧 Parser scan 并失效 snapshot。若注入的 Pipeline
  // 不响应 signal，generation CAS 仍保证迟到任务不能覆盖新 Compute Snapshot。
  function beginScanGeneration() {
    abortActiveParserScan();
    scanGeneration += 1;
    lastScanCache = null;
    lastComputeCache = null;
    return scanGeneration;
  }

  function assertCurrentScanGeneration(generation) {
    if (generation !== scanGeneration) {
      throw new VccComputeSnapshotError(
        'VCC_COMPUTE_SCAN_SUPERSEDED',
        'VCC 扫描结果已被更新的任务取代'
      );
    }
  }

  function adoptComputeSnapshot(snapshot, generation) {
    assertCurrentScanGeneration(generation);
    const owned = canonicalJsonSnapshot(snapshot);
    lastComputeCache = owned;
    return owned;
  }

  // 扫描（缓存原始 rows + 月份 + 总条数）。
  // 成功 → 缓存 fileResults 供后续 compute/save 复用（避免重读盘，spec Q1）；失败清缓存。
  function scanFiles(fileResults) {
    beginScanGeneration();
    const result = scan(fileResults);
    if (result.ok) {
      lastScanCache = { fileResults, yearMonth: result.yearMonth, totalRows: result.totalRows };
    }
    return result;
  }

  // 统计发生额（缓存 totals + perFile，不落库）。
  // 优先用 scan 缓存的 fileResults（若调用方未传 fileResults）；传了则以传入为准并刷新缓存。
  function computeFiles(fileResults) {
    const fr = fileResults || (lastScanCache && lastScanCache.fileResults);
    if (!fr) {
      return { ok: false, errorRows: [{ fileName: '', rowIndex: 0, reason: '无可统计的文件（请先选择文件）' }] };
    }
    const generation = beginScanGeneration();
    const result = computeAmounts(fr);
    if (result.ok) {
      adoptComputeSnapshot({ yearMonth: result.yearMonth, totals: result.totals, perFile: result.perFile }, generation);
    }
    return result;
  }

  // 流式扫描+统计（spec §9，大文件路径）：一次流式读所有文件，边读边聚合（不存全量行），
  //   合并 scan+compute（避免读两遍 ≈34s）。资金红线🔴：聚合口径完全复用 validateAndExtractRow /
  //   centsToAmountString / VALID_DIRECTION_IN，与同步 scan/computeAmounts 完全一致。
  //   成功 → 缓存 lastComputeCache 供 saveRun；errorRows 上限 MAX_ERRORS（百万行场景防 OOM）；多月份混杂整批拒绝。
  //   返回 { ok, yearMonth, totalRows, totals, perFile } 或 { ok:false, errorRows, errorCount }。
  async function streamScanAndCompute(filePaths, { onProgress } = {}) {
    const list = Array.isArray(filePaths) ? filePaths : [];
    const MAX_ERRORS = 100;
    const errorRows = [];
    let errorCount = 0;
    const months = new Set();
    const currencySet = new Set();
    let totalRows = 0;
    let totalInCents = 0;
    let totalOutCents = 0;
    const perFile = [];

    // 新一轮流式读使旧缓存失效；generation 防止旧异步任务迟到覆盖。
    const generation = beginScanGeneration();

    for (const fp of list) {
      const fileName = path.basename(fp);
      let fileInCents = 0;
      let fileOutCents = 0;
      let fileRowCount = 0;
      await streamFlowFile(fp, {
        onDataRow: (row) => {
          totalRows += 1;
          fileRowCount += 1;
          const res = validateAndExtractRow(row);
          if (!res.ok) {
            errorCount += 1;
            if (errorRows.length < MAX_ERRORS) {
              errorRows.push({ fileName, rowIndex: row._rowIndex || 0, reason: res.reason });
            }
            return;
          }
          months.add(res.yearMonth);
          if (res.direction === VALID_DIRECTION_IN) {
            fileInCents += res.cents;
            totalInCents += res.cents;
          } else {
            fileOutCents += res.cents;
            totalOutCents += res.cents;
          }
          if (res.currency) currencySet.add(res.currency);
        },
        onProgress: () => {
          if (typeof onProgress === 'function') onProgress(totalRows);
        }
      });
      perFile.push({
        fileName,
        rowCount: fileRowCount,
        amountOutCents: fileOutCents,
        amountInCents: fileInCents,
        amountCents: fileInCents - fileOutCents,
        amountOut: centsToAmountString(fileOutCents),
        amountIn: centsToAmountString(fileInCents),
        amount: centsToAmountString(fileInCents - fileOutCents)
      });
    }

    assertCurrentScanGeneration(generation);

    if (totalRows === 0) {
      return { ok: false, errorRows: [{ fileName: '', rowIndex: 0, reason: '所选文件无有效数据行' }], errorCount: 1 };
    }
    // 多月份混杂（含跨文件）→ 整批拒绝（spec Q8：一次导入应为同一流水月）
    if (months.size > 1) {
      errorCount += 1;
      errorRows.push({
        fileName: '',
        rowIndex: 0,
        reason: `一次导入流水跨多个月份（${[...months].sort().join(', ')}），请按月分开导入`
      });
    }
    if (errorRows.length > 0) {
      return { ok: false, errorRows, errorCount };
    }

    const totalAmountCents = totalInCents - totalOutCents;
    const currencyList = [...currencySet].filter((c) => c !== '').sort();
    let currency = null;
    if (currencyList.length === 1) currency = currencyList[0];
    else if (currencyList.length > 1) currency = currencyList.join(',');

    const totals = {
      totalOutCents,
      totalInCents,
      totalAmountCents,
      totalOut: centsToAmountString(totalOutCents),
      totalIn: centsToAmountString(totalInCents),
      totalAmount: centsToAmountString(totalAmountCents),
      currency
    };
    const yearMonth = [...months][0];

    // 返回成功前先原子采用；compute-amounts 只会看到完整、冻结的 postimage。
    adoptComputeSnapshot({ yearMonth, totals, perFile }, generation);

    return { ok: true, yearMonth, totalRows, totals, perFile };
  }

  // E03-A Parser Pipeline seam。policy 仍 production.enabled=false，默认 IPC 不在本 PR 切换；
  // 一旦后续 gate 启用，scan Task 也必须在本方法完成 snapshot adoption 后才能返回 success。
  async function parserPipelineScanAndCompute(inputs, options = {}) {
    const generation = beginScanGeneration();
    const active = {
      controller: new AbortController(),
      superseded: false
    };
    activeParserScan = active;
    let unlinkCallerAbort = () => {};
    try {
      unlinkCallerAbort = linkParserScanAbortSignal(options.signal, active.controller);
      const result = await parserPipeline(inputs, {
        ...options,
        signal: active.controller.signal
      });
      assertCurrentScanGeneration(generation);
      if (!result || result.ok !== true) return result;
      const snapshot = adoptComputeSnapshot(result.snapshot, generation);
      return canonicalJsonSnapshot({
        ok: true,
        yearMonth: snapshot.yearMonth,
        totalRows: snapshot.totalRows,
        totals: snapshot.totals,
        perFile: snapshot.perFile
      });
    } catch (error) {
      // Session 自己发起的 supersession 保留既有 generation 错误合同；调用方
      // AbortSignal 触发的取消则继续透传 Pipeline cancellation。
      if (active.superseded) assertCurrentScanGeneration(generation);
      throw error;
    } finally {
      unlinkCallerAbort();
      if (activeParserScan === active) activeParserScan = null;
    }
  }

  // E03-B 落库：Main Task owner + 冻结 Compute Snapshot + run/files/receipt 同一
  // BEGIN IMMEDIATE transaction。显式 totals/perFile/yearMonth 仅保留给既有内部调用；
  // 生产 Main handler 只使用当前 adopted snapshot，owner 不接收 Renderer payload。
  function saveRun({ yearMonth, perFile, totals, beginOp, operationOwner } = {}) {
    const hasExplicitSnapshot = yearMonth !== undefined
      || perFile !== undefined
      || totals !== undefined;
    const computeSnapshot = hasExplicitSnapshot
      ? canonicalJsonSnapshot({
          yearMonth: yearMonth || (lastComputeCache && lastComputeCache.yearMonth),
          totals: totals || (lastComputeCache && lastComputeCache.totals),
          perFile: perFile || (lastComputeCache && lastComputeCache.perFile)
        })
      : lastComputeCache;
    if (!computeSnapshot) {
      throw new Error('saveRun 缺少统计结果（请先 computeFiles）');
    }
    const db = getDb();
    if (!db) throw new Error('数据库未初始化');
    const saved = saveVccOpRunWithReceipt({
      db,
      computeSnapshot,
      beginOp,
      operationOwner,
      injectFault: saveRunFaultInjector
    });

    // 新 COMMIT 或唯一 receipt replay 均完成本次会话；COMMIT 后测试故障抛错时
    // saveVccOpRunWithReceipt 不返回，因此保留 cache 供显式恢复/取证。
    beginScanGeneration();
    return saved;
  }

  // distinct 已计算月份（"显示余额"下拉），倒序 [{ yearMonth, latestRunId, latestRunAt }]
  function listCalculatedMonths() {
    const db = getDb();
    if (!db) return [];
    return runRepository.listDistinctMonths(db);
  }

  // 取某月最新 run 的 { beginOp, totalAmount, endOp, currency, ... }（"显示余额"查看）。
  // 返回 null（该月无 run）；金额字段保持字符串原值（落库即 TEXT，不二次运算，资金红线）。
  function getMonthResult(yearMonth) {
    const db = getDb();
    if (!db) return null;
    const run = runRepository.getLatestRunByMonth(db, yearMonth);
    if (!run) return null;
    return {
      runId: run.id,
      yearMonth: run.year_month,
      runAt: run.run_at,
      fileCount: run.file_count,
      beginOp: run.begin_op,
      totalAmount: run.total_amount,
      totalAmountOut: run.total_amount_out,
      totalAmountIn: run.total_amount_in,
      endOp: run.end_op,
      currency: run.currency
    };
  }

  // 清缓存（切换 / 取消时调用）
  function clearCache() {
    beginScanGeneration();
  }

  // 读缓存（供 IPC handler 在 save 时复用 scan/compute 的中间结果）
  function getScanCache() {
    return lastScanCache;
  }
  function getComputeCache() {
    return lastComputeCache;
  }

  return {
    scanFiles,
    computeFiles,
    streamScanAndCompute,
    parserPipelineScanAndCompute,
    saveRun,
    listCalculatedMonths,
    getMonthResult,
    clearCache,
    getScanCache,
    getComputeCache
  };
}

module.exports = {
  // helper（供单测直接调用）
  parseAmountToCents,
  centsToAmountString,
  extractYearMonth,
  normalizeDirection,
  validateAndExtractRow,
  scan,
  computeAmounts,

  // 常量
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT,

  VccComputeSnapshotError,

  // session factory
  createVccOpCalcSession
};
