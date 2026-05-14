// v2.1.3 T3 — 业务OP数据核对：session 层 + 4 步对账算法（资金红线 ⚠️）
//
// 关键 OPEN ISSUE 拍板固化点（spec §五 + PRD §6.1）：
//   #1 业务OP 双重校验 → validateBizOpRow（在 ../backend/biz-op-recon-import/validator.js）
//   #3 流水出入方向 → parseSignedAmount（本文件） + validateFlowRow（validator.js）
//      仅允许中文「入」/「出」；入=+ 出=-；其他 → NaN（资金红线 ⚠️）
//   #4 业务OP 同 (date, BU) 替换 + 原子事务 → runBizOpImport 内
//   #5 校验失败整批拒绝 + 失败报告 xlsx → runBizOpImport / runFlowImport
//   #6 1:N 逐行精准标差异 → compareT1OpWithComputed
//   #7 normalizeBu trim+toLowerCase → normalizeBu（本文件）
//   #10 三类差异都进 diff_rows（cmp_t2 非空 OR cmp_amount=='不相等' 才写入）
//   #12 listReadyDates 前置 enable（run-repository.js）
//   #15 重新导入清空旧 runs + diff_rows → runBizOpImport 内事务
//
// 4 步算法（spec §3.4 + §5.1）：
//   步 4.1 aggregateFlowByAccount  按账户号汇总流水 signedAmount
//   步 4.2.a computeT1Op           T-2 期末 + 流水累加 = 计算 T-1 期末（按账户号）
//   步 4.2.b compareT1OpWithComputed 逐行独立比 T-1 OP 实际 vs 计算（#6 拍板 A）
//   步 4.3   diffT1AndT2Accounts   账户号差集（T-1 vs T-2）

const fs = require('node:fs');
const path = require('node:path');

const importsRepository = require('../backend/biz-op-recon-db/imports-repository');
const flowImportsRepository = require('../backend/biz-op-recon-db/flow-imports-repository');
const runRepository = require('../backend/biz-op-recon-db/run-repository');
const {
  BIZ_OP_ACCOUNT_KEY_DB_COLUMN,
  BIZ_OP_END_BALANCE_DB_COLUMN,
  BIZ_OP_BU_FIELD_DB_COLUMN,
  FLOW_BU_FIELD_DB_COLUMN,
  FLOW_DIRECTION_DB_COLUMN,
  FLOW_ACCOUNT_KEY_DB_COLUMN,
  FLOW_RECON_AMOUNT_DB_COLUMN
} = require('../backend/biz-op-recon-db/columns');
const {
  validateBizOpRow,
  validateFlowRow
} = require('../backend/biz-op-recon-import/validator');

// ---------------- 常量（spec §5.0） ----------------

// 资金红线 ⚠️ ：1 分钱容差
const AMOUNT_EPSILON = 1e-2;
const VALID_DIRECTION_IN = '入';
const VALID_DIRECTION_OUT = '出';

// ---------------- helper 函数（spec §5.2） ----------------

// 账户号匹配 key：仅 trim（不大小写归一；账户号是资金 key，原值精确比较）
function normalizeAccountKey(v) {
  if (v == null) return '';
  return String(v).trim();
}

// BU 比较：trim + toLowerCase（#7 拍板 C，与 v2.1.2 normalizeBu 完全一致）
function normalizeBu(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

// 数值解析（容忍千分位 `,` + 首尾空白 + 空字符串）
function parseAmount(v) {
  if (v == null || v === '') return NaN;
  const n = Number(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// 出入方向 → 正负号（#3 拍板，资金红线 ⚠️）
// 仅允许中文「入」/「出」；入=+ 出=-；其他 → NaN
// 注意：导入阶段已通过 validateFlowRow 拦截非「入/出」值；本函数是对账阶段二次保护
function parseSignedAmount(direction, amount) {
  const num = parseAmount(amount);
  if (Number.isNaN(num)) return NaN;
  const dir = String(direction == null ? '' : direction).trim();
  if (dir === VALID_DIRECTION_IN) return +num;
  if (dir === VALID_DIRECTION_OUT) return -num;
  return NaN;
}

// T → T-1 字符串日期减一（按字符串处理避免时区）
// 直接用 UTC 日期 + setUTCDate 避开本地时区抢跑
function subOneDay(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// 紧凑日期格式 YYYYMMDD（用于文件名）
function formatDateCompact(yyyymmdd) {
  if (!yyyymmdd) return '';
  return String(yyyymmdd).replace(/-/g, '');
}

// HHMMSS 时分秒（用于文件名）
function formatTimeCompact(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// ---------------- 4 步对账算法（spec §5.2 资金红线核心） ----------------

// 步骤 4.1：流水按账户号汇总 signedAmount（#3 + #7 联动）
// flowRows：已通过 normalizeBu 过滤的同 BU 流水（也可传全部行 + 在函数内过滤）
// buName：用于过滤；若上层已过滤，可传 null
function aggregateFlowByAccount(flowRows, buName) {
  const map = new Map();
  const buKey = buName == null ? null : normalizeBu(buName);
  for (const r of flowRows) {
    if (buKey != null && normalizeBu(r[FLOW_BU_FIELD_DB_COLUMN]) !== buKey) continue;
    const accKey = normalizeAccountKey(r[FLOW_ACCOUNT_KEY_DB_COLUMN]);
    if (!accKey) continue;
    const signed = parseSignedAmount(r[FLOW_DIRECTION_DB_COLUMN], r[FLOW_RECON_AMOUNT_DB_COLUMN]);
    if (Number.isNaN(signed)) continue;
    map.set(accKey, (map.get(accKey) || 0) + signed);
  }
  return map;
}

// 步骤 4.2.a：T-2 期末 + 流水累加 = 计算 T-1 期末（按账户号汇总单值）
// 注意：T-2 业务 OP 同账户号 N 条时，按 row_index 顺序累加期末（即把"T-2 该账户的所有 OP 行"汇总
// 成单一基线），spec §5.2 原文是"对 T-2 业务 OP 行"循环累加 — 若 T-2 同账户号 N 条则隐含 SUM
function computeT1Op(t2OpRows, flowAggMap) {
  const map = new Map();
  for (const r of t2OpRows) {
    const accKey = normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]);
    if (!accKey) continue;
    const t2EndBal = parseAmount(r[BIZ_OP_END_BALANCE_DB_COLUMN]);
    if (Number.isNaN(t2EndBal)) continue;
    // 若 T-2 同账户号 N 条：spec §3.4.1 步 4.2.a 描述是"对每行 r"，所以同账户号多行
    // 这里 map.set 会覆盖；按 spec 5.2 第一段也是 map.set（同账户号 N 条取最后一行）
    // 但流水 flowSum 累加值是一致的（按账户号聚合），所以同账户号取任意一行的期末 + 同一 flowSum 都是一个候选基线
    // 业务上 T-2 同账户号多 OP 行的"期末余额"理论上一致（同账户号同日同期末），所以这里 map.set 覆盖等价取一个
    // 资金红线 review 注释：若 T-2 同账户号期末不一致，computed 取最后一行 — 这是 spec §5.2 原文
    const flowSum = flowAggMap.get(accKey) || 0;
    map.set(accKey, t2EndBal + flowSum);
  }
  return map;
}

// 步骤 4.2.b：T-1 OP 与计算 T-1 OP 逐行独立对账（#6 拍板 A，资金红线 ⚠️）
// 返回：{ diffRows: [...], stats: { amountDiffCount, multiOpAccountCount } }
// diffRows 元素格式：{ source_table:'T1', source_row_id, cmp_t2:'', multi_op_flag:'是'/'否', cmp_amount:'相等'|'不相等', amount_diff:'<diff>'|'' }
//
// v2.1.3 fix5 选项 B（拍板）：
//   - 单 OP 行（isMulti='否'）：仅"不相等"进表（保持原 #10 拍板 A 语义）
//   - 多 OP 行（isMulti='是'）：N 行全进表，相等/不相等都进
//     · 相等行 meta：cmp_t2='' / multi_op_flag='是' / cmp_amount='相等' / amount_diff=''
//     · 不相等行 meta：同原逻辑（cmp_amount='不相等' / amount_diff=<diff>）
//   - stats.amountDiffCount 仍只统计"不相等"行（状态栏「测算金额差异 N 笔」语义保持）
//   - 进表条件：「比对T-2日 非空 OR 比对测算金额=='不相等' OR 同账户号多个OP=='是'」
function compareT1OpWithComputed(t1OpRows, computedT1Map) {
  // 先按账户号分组 T-1 行（多 OP 检测）
  const t1ByAccount = new Map();
  for (const r of t1OpRows) {
    const accKey = normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]);
    if (!accKey) continue;
    if (!t1ByAccount.has(accKey)) t1ByAccount.set(accKey, []);
    t1ByAccount.get(accKey).push(r);
  }

  const diffRows = [];
  let amountDiffCount = 0;
  let multiOpAccountCount = 0;

  for (const [accKey, t1Rows] of t1ByAccount) {
    const calcT1 = computedT1Map.get(accKey);
    if (calcT1 === undefined) continue;  // T-1 有 T-2 无场景，§5.1 步骤 5.a 单独处理

    const isMulti = t1Rows.length > 1 ? '是' : '否';
    if (t1Rows.length > 1) multiOpAccountCount += 1;

    for (const r of t1Rows) {
      const t1End = parseAmount(r[BIZ_OP_END_BALANCE_DB_COLUMN]);
      if (Number.isNaN(t1End)) continue;  // 导入已拦截，这里二次保护
      const diff = Math.abs(t1End - calcT1);
      if (diff > AMOUNT_EPSILON) {
        // 不相等 → 进 diff 表（#10 拍板 A）
        diffRows.push({
          source_table: 'T1',
          source_row_id: r.id,
          cmp_t2: '',
          multi_op_flag: isMulti,
          cmp_amount: '不相等',
          amount_diff: String(diff)
        });
        amountDiffCount += 1;
      } else if (isMulti === '是') {
        // v2.1.3 fix5 选项 B：多 OP 相等行也进 diff 表
        // 用途：业务方需在差异表看到"该多 OP 账户号"的所有行（含相等行），以便人工核对全貌
        // amountDiffCount 不累加 → 状态栏「测算金额差异」语义保持仅"不相等"
        diffRows.push({
          source_table: 'T1',
          source_row_id: r.id,
          cmp_t2: '',
          multi_op_flag: '是',
          cmp_amount: '相等',
          amount_diff: ''
        });
      }
      // 单 OP 相等 → 不进 diff 表（#10 拍板 A：只导出"有差异"的行）
    }
  }

  return { diffRows, stats: { amountDiffCount, multiOpAccountCount } };
}

// 步骤 4.3：T-1 vs T-2 账户号差集
// 返回：{ onlyInT1: [...rows], onlyInT2: [...rows] }
// onlyInT1：T-1 表中账户号不在 T-2 中的所有行（一个账户号 N 行全部进，spec §5.1 步 5.a 用全部 T-1 行）
// onlyInT2：T-2 表中账户号不在 T-1 中的所有行（同上，spec §5.1 步 5.b 用 T-2 行）
function diffT1AndT2Accounts(t1OpRows, t2OpRows) {
  const t1AccSet = new Set();
  const t2AccSet = new Set();
  for (const r of t1OpRows) {
    t1AccSet.add(normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]));
  }
  for (const r of t2OpRows) {
    t2AccSet.add(normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]));
  }

  const onlyInT1 = [];
  const onlyInT2 = [];
  for (const r of t1OpRows) {
    const k = normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]);
    if (!t2AccSet.has(k)) onlyInT1.push(r);
  }
  for (const r of t2OpRows) {
    const k = normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]);
    if (!t1AccSet.has(k)) onlyInT2.push(r);
  }
  return { onlyInT1, onlyInT2 };
}

// 计算 T-1 表内同账户号的行数（多 OP 检测，"T-1有T-2无" 行的 multi_op_flag 用到）
function countAccountRows(rows, accKey) {
  let n = 0;
  for (const r of rows) {
    if (normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]) === accKey) n += 1;
  }
  return n;
}

// ---------------- 总编排：runReconciliation（资金红线核心） ----------------

// 跑一次对账：4 步算法 + 落 run + 落 diff_rows
// 返回：{ runId, stats }
function runReconciliation(db, { date, buName }) {
  const t2Date = subOneDay(date);

  // 1. 取数（SQL 已用 LOWER(TRIM(...)) 过滤 BU，#7 拍板 C）
  const t1OpRows = importsRepository.getRowsByDateBu(db, date, buName);
  const t2OpRows = importsRepository.getRowsByDateBu(db, t2Date, buName);
  const flowRows = flowImportsRepository.getRowsByDateBu(db, date, buName);

  // 2. 步 4.1：流水按账户号汇总
  const flowSumByAccount = aggregateFlowByAccount(flowRows, null);  // 上层 SQL 已过滤 BU

  // 3. 步 4.2.a：T-2 期末 + 流水累加 = 计算 T-1 期末
  const calcT1ByAccount = computeT1Op(t2OpRows, flowSumByAccount);

  // 4. 步 4.2.b：1:N 逐行独立比（资金红线 ⚠️）
  const { diffRows, stats } = compareT1OpWithComputed(t1OpRows, calcT1ByAccount);

  // 5. 步 4.3：账户号差集
  const { onlyInT1, onlyInT2 } = diffT1AndT2Accounts(t1OpRows, t2OpRows);

  // 5.a：T-1 有 T-2 无 → 进 diff 表，cmp_t2='T-1有T-2无'，整行标黄（#10 拍板 A）
  // 资金红线 ⚠️ fix3.1：onlyInT1 账户号在 compareT1OpWithComputed 中因 calcT1===undefined 被 continue 跳过，
  // 这里必须补统计 multiOpAccountCount，否则状态栏「多 OP 账户 N 个」漏 onlyInT1 中的多 OP 账户
  // （PRD §3.5.1：'同账户号多个OP' 基于 T-1 表 row 数，与 T-2 是否存在无关）
  const multiOpAccountSeen = new Set();  // 防同账户号 N 行循环 N 次重复累加
  for (const r of onlyInT1) {
    const accKey = normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]);
    const isMulti = countAccountRows(t1OpRows, accKey) > 1 ? '是' : '否';
    if (isMulti === '是' && !multiOpAccountSeen.has(accKey)) {
      multiOpAccountSeen.add(accKey);
      stats.multiOpAccountCount += 1;
    }
    diffRows.push({
      source_table: 'T1',
      source_row_id: r.id,
      cmp_t2: 'T-1有T-2无',
      multi_op_flag: isMulti,
      cmp_amount: '',
      amount_diff: ''
    });
  }

  // 5.b：T-2 有 T-1 无 → 进 diff 表，cmp_t2='T-2有T-1无'；来源行 T-2（拍板 C）；
  //      不参与 T-1 表多 OP 判定，multi_op_flag 固定 '否'
  for (const r of onlyInT2) {
    diffRows.push({
      source_table: 'T2',
      source_row_id: r.id,
      cmp_t2: 'T-2有T-1无',
      multi_op_flag: '否',
      cmp_amount: '',
      amount_diff: ''
    });
  }

  // 6. 落 run + 落 diff_rows（同事务）
  const aggregateStats = {
    t1OpTotal: t1OpRows.length,
    t2OpTotal: t2OpRows.length,
    flowTotal: flowRows.length,
    amountDiffCount: stats.amountDiffCount,
    multiOpAccountCount: stats.multiOpAccountCount,
    t1NotT2Count: onlyInT1.length,
    t2NotT1Count: onlyInT2.length
  };

  db.exec('BEGIN');
  let runId;
  try {
    runId = runRepository.insertRun(db, {
      date,
      buName,
      status: 'success',
      stats: aggregateStats
    });
    runRepository.insertDiffRows(db, runId, date, buName, diffRows);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { runId, stats: aggregateStats };
}

// ---------------- 整批拒绝 + 失败报告流程（spec §5.4，资金红线 ⚠️） ----------------
//
// 设计要点：
//   - writer.writeXxxErrorReport 是 async（fs.promises 写盘）
//   - SQLite 事务在 node:sqlite DatabaseSync 必须同步运行，所以校验失败时走"事务外异步写报告"路径
//   - 校验通过时所有事务相关代码在同一同步上下文内执行
//   - 上层 IPC handler 必须 await runBizOpImportAsync / runFlowImportAsync

async function runBizOpImportAsync(db, params) {
  const {
    date,
    filePath,
    readBizOpFile,
    writeBizOpErrorReportXlsx,
    errorReportsDir
  } = params;

  const { rows } = readBizOpFile(filePath);

  if (rows.length === 0) {
    return { status: 'rejected', errorReportPath: null, errorRows: [{ rowIndex: 0, reason: '文件无有效数据行' }] };
  }

  const firstBu = String(rows[0].bu_name || '').trim();
  if (!firstBu) {
    return { status: 'rejected', errorReportPath: null, errorRows: [{ rowIndex: rows[0]._rowIndex, reason: '业务方为空' }] };
  }

  // BU 一致性 + 双重校验
  const buNormalized = normalizeBu(firstBu);
  const errorRows = [];
  for (const r of rows) {
    if (normalizeBu(r.bu_name) !== buNormalized) {
      errorRows.push({
        rowIndex: r._rowIndex,
        reason: `业务方不一致：首行为 "${firstBu}"，本行为 "${r.bu_name}"`,
        rawRow: r
      });
      continue;
    }
    const result = validateBizOpRow(r);
    if (!result.ok) {
      errorRows.push({ rowIndex: r._rowIndex, reason: result.reason, rawRow: r });
    }
  }

  // #5 拍板：任一失败 → 整批拒绝
  if (errorRows.length > 0) {
    const saveDir = path.join(errorReportsDir, date);
    const fileName = makeBizOpErrorReportFileName(firstBu, date);
    const errorReportPath = await writeBizOpErrorReportXlsx({
      date, buName: firstBu, errorRows, saveDir, fileName
    });
    return {
      status: 'rejected',
      errorReportPath,
      errorRows: errorRows.map(e => ({ rowIndex: e.rowIndex, reason: e.reason }))
    };
  }

  // 全部通过 → 同事务：#15 清旧 runs + imports → INSERT
  db.exec('BEGIN');
  try {
    runRepository.clearRunsAndDiffsByDateBu(db, date, firstBu);
    importsRepository.clearByDateBu(db, date, firstBu);
    importsRepository.insertRows(db, date, rows);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { status: 'success', buName: firstBu, validCount: rows.length };
}

async function runFlowImportAsync(db, params) {
  const {
    date,
    filePath,
    readFlowFile,
    writeFlowErrorReportXlsx,
    errorReportsDir
  } = params;

  const { rows } = readFlowFile(filePath);

  if (rows.length === 0) {
    return { status: 'rejected', errorReportPath: null, errorRows: [{ rowIndex: 0, reason: '文件无有效数据行' }] };
  }

  const errorRows = [];
  for (const r of rows) {
    const result = validateFlowRow(r);
    if (!result.ok) {
      errorRows.push({ rowIndex: r._rowIndex, reason: result.reason, rawRow: r });
    }
  }

  if (errorRows.length > 0) {
    const saveDir = path.join(errorReportsDir, date);
    const fileName = makeFlowErrorReportFileName(date);
    const errorReportPath = await writeFlowErrorReportXlsx({
      date, errorRows, saveDir, fileName
    });
    return {
      status: 'rejected',
      errorReportPath,
      errorRows: errorRows.map(e => ({ rowIndex: e.rowIndex, reason: e.reason }))
    };
  }

  db.exec('BEGIN');
  try {
    flowImportsRepository.clearByDate(db, date);
    flowImportsRepository.insertRows(db, date, rows);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { status: 'success', totalCount: rows.length };
}

// ---------------- 文件名生成 helper ----------------

// #9 拍板 A 文件名格式
function makeBizOpErrorReportFileName(buName, date) {
  const cleanBu = String(buName || 'UNKNOWN').replace(/[\\\/:*?"<>|]/g, '_');
  return `业务OP校验失败报告_${cleanBu}_${formatDateCompact(date)}_${formatTimeCompact()}.xlsx`;
}

function makeFlowErrorReportFileName(date) {
  return `流水对账单校验失败报告_${formatDateCompact(date)}_${formatTimeCompact()}.xlsx`;
}

function makeSingleDateDiffFileName(buName, date) {
  const cleanBu = String(buName || 'UNKNOWN').replace(/[\\\/:*?"<>|]/g, '_');
  return `业务OP数据核对_${cleanBu}_${formatDateCompact(date)}_${formatTimeCompact()}.xlsx`;
}

function makeDateRangeDiffFileName(buName, startDate, endDate) {
  const cleanBu = String(buName || 'UNKNOWN').replace(/[\\\/:*?"<>|]/g, '_');
  return `业务OP数据核对_${cleanBu}_${formatDateCompact(startDate)}-${formatDateCompact(endDate)}_${formatTimeCompact()}.xlsx`;
}

// ---------------- session factory ----------------

function createBizOpReconSession({ getDb, getStorageRoot }) {
  function getStatus() {
    const db = getDb();
    return {
      importedDateBuPairs: importsRepository.listImportedDateBuPairs(db),
      buList: importsRepository.listDistinctBus(db),
      flowImportedDates: flowImportsRepository.listImportedDates(db)
    };
  }

  function listBu() {
    return importsRepository.listDistinctBus(getDb());
  }

  function checkSingleDay(buName) {
    const db = getDb();
    const count = importsRepository.countDistinctDatesByBu(db, buName);
    const latestDate = importsRepository.getLatestDateByBu(db, buName);
    return {
      onlyOneDay: count === 1,
      count,
      latestDate
    };
  }

  function listReadyDates(buName) {
    return runRepository.listReadyDates(getDb(), buName);
  }

  function listSuccessDates(buName) {
    return runRepository.listSuccessDates(getDb(), buName);
  }

  function listSuccessDatesInRange(buName, startDate, endDate) {
    return runRepository.listSuccessDatesInRange(getDb(), buName, startDate, endDate);
  }

  function run({ date, buName }) {
    return runReconciliation(getDb(), { date, buName });
  }

  function getRun(runId) {
    return runRepository.getRunById(getDb(), runId);
  }

  function getDiffRowsByRun(runId) {
    return runRepository.getDiffRowsByRun(getDb(), runId);
  }

  function recordExportPath(runId, exportPath) {
    runRepository.updateRunExportPath(getDb(), runId, exportPath);
  }

  return {
    getStatus,
    listBu,
    checkSingleDay,
    listReadyDates,
    listSuccessDates,
    listSuccessDatesInRange,
    run,
    getRun,
    getDiffRowsByRun,
    recordExportPath
  };
}

module.exports = {
  // 常量
  AMOUNT_EPSILON,
  VALID_DIRECTION_IN,
  VALID_DIRECTION_OUT,

  // helper
  normalizeAccountKey,
  normalizeBu,
  parseAmount,
  parseSignedAmount,
  subOneDay,
  formatTimestamp,
  formatDateCompact,
  formatTimeCompact,

  // 算法
  aggregateFlowByAccount,
  computeT1Op,
  compareT1OpWithComputed,
  diffT1AndT2Accounts,
  runReconciliation,

  // 整批拒绝 + 失败报告流程
  runBizOpImportAsync,
  runFlowImportAsync,

  // 文件名 helper
  makeBizOpErrorReportFileName,
  makeFlowErrorReportFileName,
  makeSingleDateDiffFileName,
  makeDateRangeDiffFileName,

  // session factory
  createBizOpReconSession
};
