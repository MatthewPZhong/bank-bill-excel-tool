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
const {
  VCC_DIRECTION_DB_COLUMN,
  VCC_RECON_AMOUNT_DB_COLUMN,
  VCC_BILL_DATE_DB_COLUMN,
  VCC_CURRENCY_DB_COLUMN,
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT
} = require('../backend/vcc-op-calc-db/columns');

// ---------------- 金额精度 helper（资金红线 🔴 整数分） ----------------

// 解析金额 → 整数「分」（资金红线 🔴 精度核心）。
// 策略：Number 解析（容忍千分位 `,` + 首尾空白）→ 乘 100 → Math.round 到整数分。
//   - Math.round 而非 |0/parseInt：吸收 0.1*100=10.000000000000002 这类浮点尾差（关键，否则求和漂移）。
//   - 流水金额最多 2 位小数（财务对账规模），round 到分无业务精度损失。
// 返回 { ok, cents, empty }：
//   - 空字符串 / null → { ok:true, cents:0, empty:true }（计 0，不报错，spec Q5）
//   - 非数值 → { ok:false }（调用方整批拒绝，spec Q8）
function parseAmountToCents(v) {
  if (v == null) return { ok: true, cents: 0, empty: true };
  const s = String(v).trim();
  if (s === '') return { ok: true, cents: 0, empty: true };
  const num = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(num)) return { ok: false };
  // 乘 100 转分 + Math.round 吸收浮点尾差（资金红线 🔴）
  const cents = Math.round(num * 100);
  return { ok: true, cents, empty: false };
}

// 整数分 → 金额字符串（除回 100，固定 2 位小数；负号保留）。
// 用 (cents/100).toFixed(2)：cents 是整数，除 100 后 toFixed(2) 无浮点风险（整数/100 精确可表示到分）。
function centsToAmountString(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

// 整数分字符串相加 / 相减（输入输出都走 cents，避免中途转浮点）
// 这里直接用 JS 安全整数运算（分级别金额远小于 Number.MAX_SAFE_INTEGER）

// ---------------- 月份 helper ----------------

// 从账单日期原始值解析 YYYY-MM（资金红线相关：定月份口径）。
// 容忍 'YYYY-MM-DD' / 'YYYY/MM/DD' / 'YYYY-MM-DD HH:mm:ss' / 'YYYY.MM.DD' / 'YYYYMMDD' / 'YYYY-MM'。
// 纯字符串解析（不 new Date，避免时区抢跑）；无法解析 → null（调用方整批拒绝）。
function extractYearMonth(billDateRaw) {
  if (billDateRaw == null) return null;
  const s = String(billDateRaw).trim();
  if (s === '') return null;
  // 1) YYYY[-/.]MM 起头（带或不带日/时间）
  let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:[ T].*)?$/);
  if (m) {
    const month = String(m[2]).padStart(2, '0');
    if (Number(month) >= 1 && Number(month) <= 12) return `${m[1]}-${month}`;
    return null;
  }
  // 2) 纯数字 YYYYMMDD / YYYYMM
  m = s.match(/^(\d{4})(\d{2})(\d{2})?$/);
  if (m) {
    const month = m[2];
    if (Number(month) >= 1 && Number(month) <= 12) return `${m[1]}-${month}`;
    return null;
  }
  return null;
}

// ---------------- 出入方向 helper ----------------

// 归一出入方向（trim，不做大小写归一；中文「入」「出」）。返回 '入' / '出' / 原 trim 值（非法）。
function normalizeDirection(v) {
  return String(v == null ? '' : v).trim();
}

// ---------------- 核心计算（资金红线 🔴） ----------------

// 单行校验 + 提取（scan/computeAmounts 共用，保证整批拒绝口径单一）。
// 返回 { ok:true, direction, cents, yearMonth, currency } 或 { ok:false, reason }。
// 资金红线 🔴：
//   - 出入方向非「入/出」 → 拒绝
//   - 对账金额非数值（非空） → 拒绝；空 → cents=0（计 0）
//   - 账单日期无法解析 YYYY-MM → 拒绝（无法定月）
function validateAndExtractRow(row) {
  const direction = normalizeDirection(row[VCC_DIRECTION_DB_COLUMN]);
  if (direction !== VALID_DIRECTION_IN && direction !== VALID_DIRECTION_OUT) {
    return { ok: false, reason: `出入方向非法：实际值 "${row[VCC_DIRECTION_DB_COLUMN] == null ? '' : row[VCC_DIRECTION_DB_COLUMN]}"，仅允许 "入" 或 "出"` };
  }

  const amt = parseAmountToCents(row[VCC_RECON_AMOUNT_DB_COLUMN]);
  if (!amt.ok) {
    return { ok: false, reason: `对账金额非数值：${row[VCC_RECON_AMOUNT_DB_COLUMN]}` };
  }

  const yearMonth = extractYearMonth(row[VCC_BILL_DATE_DB_COLUMN]);
  if (!yearMonth) {
    return { ok: false, reason: `账单日期无法解析月份：${row[VCC_BILL_DATE_DB_COLUMN] == null ? '' : row[VCC_BILL_DATE_DB_COLUMN]}` };
  }

  const currency = String(row[VCC_CURRENCY_DB_COLUMN] == null ? '' : row[VCC_CURRENCY_DB_COLUMN]).trim();
  return { ok: true, direction, cents: amt.cents, yearMonth, currency };
}

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

function createVccOpCalcSession({ getDb }) {
  // 中间结果缓存（仿 bank-bu-recon-session.js:154 lastRunCache）：
  //   选完文件后 scan/compute 的原始 rows + 统计结果存这里，save 时直接落库，避免重读盘。
  let lastScanCache = null;   // { fileResults, yearMonth, totalRows }
  let lastComputeCache = null; // { yearMonth, totals, perFile }

  // 扫描（缓存原始 rows + 月份 + 总条数）。
  // 成功 → 缓存 fileResults 供后续 compute/save 复用（避免重读盘，spec Q1）；失败清缓存。
  function scanFiles(fileResults) {
    const result = scan(fileResults);
    if (result.ok) {
      lastScanCache = { fileResults, yearMonth: result.yearMonth, totalRows: result.totalRows };
      lastComputeCache = null;  // 新扫描使旧 compute 结果失效
    } else {
      lastScanCache = null;
      lastComputeCache = null;
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
    const result = computeAmounts(fr);
    if (result.ok) {
      lastComputeCache = { yearMonth: result.yearMonth, totals: result.totals, perFile: result.perFile };
    } else {
      lastComputeCache = null;
    }
    return result;
  }

  // 落库（资金红线 🔴：收 beginOp → 算 endOp = beginOp + 发生额 → 原子写表 A/B），返回 { runId, endOp }。
  // beginOp 解析走 parseAmountToCents（与发生额同口径整数分）；endOp = beginCents + totalAmountCents。
  // totals/perFile 优先用入参，缺省回退 lastComputeCache。
  function saveRun({ yearMonth, perFile, totals, beginOp } = {}) {
    const effTotals = totals || (lastComputeCache && lastComputeCache.totals);
    const effPerFile = perFile || (lastComputeCache && lastComputeCache.perFile);
    const effYearMonth = yearMonth || (lastComputeCache && lastComputeCache.yearMonth);

    if (!effTotals || !effPerFile || !effYearMonth) {
      throw new Error('saveRun 缺少统计结果（请先 computeFiles）');
    }

    // 期初OP 解析（资金红线 🔴）：必填、允许负数/小数；空或非数值 → 拒绝（spec Q10）
    const beginParsed = parseAmountToCents(beginOp);
    if (!beginParsed.ok || beginParsed.empty) {
      throw new Error('期初OP 无效：必须为数值（允许负数/小数）');
    }
    const beginCents = beginParsed.cents;
    const totalAmountCents = Number(effTotals.totalAmountCents) || 0;
    const endCents = beginCents + totalAmountCents;   // 期末OP = 期初OP + 发生额（整数分相加）

    const beginOpStr = centsToAmountString(beginCents);
    const endOpStr = centsToAmountString(endCents);

    const db = getDb();
    if (!db) throw new Error('数据库未初始化');

    // 原子事务：runs + run_files 同落（资金红线：避免"汇总落了明细没落"的半截状态）
    db.exec('BEGIN');
    let runId;
    try {
      runId = runRepository.insertRun(db, {
        yearMonth: effYearMonth,
        fileCount: effPerFile.length,
        totalAmountOut: effTotals.totalOut,
        totalAmountIn: effTotals.totalIn,
        totalAmount: effTotals.totalAmount,
        beginOp: beginOpStr,
        endOp: endOpStr,
        currency: effTotals.currency
      });
      runRepository.insertRunFiles(db, runId, effPerFile.map((f) => ({
        fileName: f.fileName,
        rowCount: f.rowCount,
        amountOut: f.amountOut,
        amountIn: f.amountIn,
        amount: f.amount
      })));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // 落库成功后清缓存（一次会话完成；下次导入重新 scan）
    lastScanCache = null;
    lastComputeCache = null;

    return { runId, endOp: endOpStr, beginOp: beginOpStr, yearMonth: effYearMonth };
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
    lastScanCache = null;
    lastComputeCache = null;
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
  scan,
  computeAmounts,

  // 常量
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT,

  // session factory
  createVccOpCalcSession
};
