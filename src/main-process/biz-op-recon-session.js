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
// v2.1.12-beta β.2-T2：导入 worker 化 spawn 方（纯 Node 测试路径用；Electron 走 utilityProcess）
const { spawn } = require('node:child_process');

const importsRepository = require('../backend/biz-op-recon-db/imports-repository');
const flowImportsRepository = require('../backend/biz-op-recon-db/flow-imports-repository');
const runRepository = require('../backend/biz-op-recon-db/run-repository');
// v2.1.9 SR-log-1 (T32h)：替换 console.warn → appendModuleLog 双写
//   不用解构赋值（smoke / unit spy 可改 logger.appendModuleLog 单点劫持）
const logger = require('../backend/logger');
const {
  BIZ_OP_ACCOUNT_KEY_DB_COLUMN,
  BIZ_OP_END_BALANCE_DB_COLUMN,
  BIZ_OP_BU_FIELD_DB_COLUMN,
  FLOW_BU_FIELD_DB_COLUMN,
  FLOW_DIRECTION_DB_COLUMN,
  FLOW_ACCOUNT_KEY_DB_COLUMN,
  FLOW_RECON_AMOUNT_DB_COLUMN,
  AMOUNT_EPSILON
} = require('../backend/biz-op-recon-db/columns');
const {
  validateBizOpRow,
  validateFlowRow
} = require('../backend/biz-op-recon-import/validator');

// ---------------- 常量（spec §5.0） ----------------

// 资金红线 ⚠️ ：1 分钱容差（v2.1.3-fix7-M2 单一真理来源在 columns.js，本文件 import 后 re-export）
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

// 资金红线 ⚠️ v2.1.3 PR #45 round 4 P1 fix：T → T+1 字符串日期加一（与 subOneDay 对偶）
//
// 用途：业务OP 重导某日 D 的 (date, BU) 时，须同时清"下一日 D+1 / 同 BU"的旧 runs/diff_rows
//   - D 业务OP 既是 D 当日对账的 T-1（与 D 流水合算）
//   - D 业务OP 也是 D+1 对账的 T-2（作为 T-2 期末余额基线）
//   重导 D 后只清当天会留下 D+1 的旧 run，导出按旧 runId 仍是基于旧 T-2 算的差异 → 资金事故
//
// helper 位置决策（避免 round 2 review M4 双源风险）：
//   - subOneDay 已存在 session.js + run-repository.js 双源（前者用于 runReconciliation/runBizOpImportAsync，
//     后者用于 listReadyDates SQL 内部）
//   - addOneDay 仅 runBizOpImportAsync 用 → 单源放 session.js（与同函数 subOneDay 对称、易维护）
//   - 不再让 run-repository.js 二次实现 addOneDay
//
// 实现细节：与 subOneDay 完全对称，UTC 日期 + setUTCDate(+1) 避免本地时区抢跑
function addOneDay(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
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
//
// 返回 { map, anomalyAccountSet }：
//   map：account_no → calcT1（T-2 期末 + 流水净额）
//   anomalyAccountSet：T-2 该账户号唯一行（或所有行）end_balance 全 NaN → silent drop 风险账户
//     资金红线 ⚠️ v2.1.3-fix7-I3：原实现 NaN 行 continue 后，下游 compareT1OpWithComputed 因 calcT1
//     undefined 又 continue → 该账户号在差异表完全不出现，导出文件看不出"丢账户"。修复：暴露集合让上层
//     summary.t2AnomalyAccountCount 累加 + console.warn 输出，便于人工核查
function computeT1Op(t2OpRows, flowAggMap) {
  const map = new Map();
  const anomalyAccountSet = new Set();   // 资金红线 ⚠️ fix7-I3：T-2 NaN 账户号
  const validAccountSet = new Set();
  for (const r of t2OpRows) {
    const accKey = normalizeAccountKey(r[BIZ_OP_ACCOUNT_KEY_DB_COLUMN]);
    if (!accKey) continue;
    const t2EndBal = parseAmount(r[BIZ_OP_END_BALANCE_DB_COLUMN]);
    if (Number.isNaN(t2EndBal)) {
      // 资金红线 ⚠️ fix7-I3：单条 NaN 不立即标 anomaly（同账户号可能有其他有效行）
      // 仅当该账户号所有行都 NaN 时才标 — 在循环结束后比较 valid vs anomaly 集合
      anomalyAccountSet.add(accKey);
      continue;
    }
    validAccountSet.add(accKey);
    // 若 T-2 同账户号 N 条：spec §3.4.1 步 4.2.a 描述是"对每行 r"，所以同账户号多行
    // 这里 map.set 会覆盖；按 spec 5.2 第一段也是 map.set（同账户号 N 条取最后一行）
    // 但流水 flowSum 累加值是一致的（按账户号聚合），所以同账户号取任意一行的期末 + 同一 flowSum 都是一个候选基线
    // 业务上 T-2 同账户号多 OP 行的"期末余额"理论上一致（同账户号同日同期末），所以这里 map.set 覆盖等价取一个
    // 资金红线 review 注释：若 T-2 同账户号期末不一致，computed 取最后一行 — 这是 spec §5.2 原文
    const flowSum = flowAggMap.get(accKey) || 0;
    map.set(accKey, t2EndBal + flowSum);
  }
  // 资金红线 ⚠️ fix7-I3：仅保留"完全 silent drop"的账户号（即所有行都 NaN，没有任何 valid 行）
  for (const acc of validAccountSet) anomalyAccountSet.delete(acc);
  return { map, anomalyAccountSet };
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
  // 资金红线 ⚠️ v2.1.3-fix7-I3：computeT1Op 返回 { map, anomalyAccountSet }
  // anomalyAccountSet：T-2 该账户号所有行 end_balance 全 NaN 的账户集合
  const { map: calcT1ByAccount, anomalyAccountSet: t2AnomalyAccounts } = computeT1Op(t2OpRows, flowSumByAccount);

  // 资金红线 ⚠️ fix7-I3：每个 anomaly 账户号写一条日志（不阻断对账，仅人工排查线索）
  // v2.1.9 SR-log-1：替换 console.warn → 日志上报；用 logger.appendModuleLog 便于 smoke spy
  for (const acc of t2AnomalyAccounts) {
    logger.appendModuleLog({
      level: 'warning',
      source: 'main',
      domain: 'biz-op-recon',
      message: '[biz-op-recon] T-2 end_balance NaN silent drop',
      details: [
        `date=${t2Date}`,
        `bu=${buName}`,
        `account=${acc}`,
        '该账户在 T-1 实际 OP 与差异表均不可见，请检查源文件期末余额字段'
      ]
    });
  }

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
    t2NotT1Count: onlyInT2.length,
    // 资金红线 ⚠️ v2.1.3-fix7-I3：T-2 end_balance NaN 导致 silent drop 的账户号数量
    // 状态栏 / 对话框可拼一段 "T-2 异常 N 个账户" 文案（仅警示，不阻断导出）
    t2AnomalyAccountCount: t2AnomalyAccounts.size
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

  // 资金红线 ⚠️ v2.1.3-fix7-I2：落库前把所有行 bu_name 改写为 firstBu（已 trim）
  // 校验阶段用 normalizeBu 比较仅做相等性判断，原始字面值（含首尾空白 / 大小写差）会落进 DB；
  // 但 listDistinctBus 不做 normalize → 下拉框出现 'BU-A' / ' BU-A '/'bu-a' 多个 entry，
  // 用户视觉混乱；选保守方案保留首字母大小写但去首尾空白（不强制 lower）。
  for (const r of rows) {
    r.bu_name = firstBu;
  }

  // 全部通过 → 同事务：#15 清旧 runs + imports → INSERT
  // 资金红线 ⚠️ v2.1.3 PR #45 round 4 P1 fix：业务OP 重导 (D, BU) 必须同时清"D+1 / 同 BU"的旧 runs
  //   - D 业务OP 既是 D 当日对账的 T-1，也是 D+1 对账的 T-2
  //   - 旧实现仅清 D 同 BU，留下 D+1 同 BU 的旧 run → listSuccessDates 仍含 D+1 → export:date
  //     按旧 runId 读旧 diff_rows，而旧 diff_rows 是基于旧 T-2 算出 → 资金事故
  //   - 业务OP 跨 BU 隔离（spec §4.2 #7 拍板 C），所以 D+1 也按"同 BU"清，不像流水跨 BU
  db.exec('BEGIN');
  try {
    runRepository.clearRunsAndDiffsByDateBu(db, date, firstBu);
    runRepository.clearRunsAndDiffsByDateBu(db, addOneDay(date), firstBu);
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

  // 资金红线 ⚠️ v2.1.3 PR #45 round 3 P1 fix：流水重导必须清该 date 跨所有 BU 的旧 runs/diff_rows
  //   背景：流水按 date 跨所有 BU 共用（spec §4.2 #4 拍板 A）；重导后所有该 date 的旧 run 都失效
  //   （旧 run 的对账结果是基于旧流水算出的，源换了但 diff_rows 仍是旧流水算的 → 资金事故）
  //   - 业务OP 重导走 clearRunsAndDiffsByDateBu（按 (date, BU) 粒度）— 不变
  //   - 流水重导走 clearRunsAndDiffsByDate（按 date 粒度，跨所有 BU）— 本 fix 新增
  db.exec('BEGIN');
  try {
    runRepository.clearRunsAndDiffsByDate(db, date);
    flowImportsRepository.clearByDate(db, date);
    flowImportsRepository.insertRows(db, date, rows);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { status: 'success', totalCount: rows.length };
}

// ---------------- worker 化导入入口（β.2-T2，资金红线 🔴） ----------------
//
// 仿 src/main-process/pending-session.js runImport：spawn child-process worker（流式读 + 事务内边校验
//   边 INSERT），解析 stdout JSON 行（progress/rejected/header-error/complete），按退出码收敛。
//   语义零改变：worker 内保住整批拒绝 / (date,BU)+D+1 替换原子事务 / bu_name 改写 / flow 跨 BU 清；
//   失败报告 xlsx 仍在主进程写（worker emit 的 errorRows 带 rawRow）。
//
// 路径只拼字符串（不 require worker 模块）——worker 反向 require 本 session 取 addOneDay/normalizeBu，
//   若此处 require worker 会造成循环依赖。
const WORKER_SCRIPT = path.resolve(__dirname, '../backend/biz-op-recon-import/import-worker.js');
const NODE_MAX_OLD_SPACE_MB = 8192;

// Electron 下用 utilityProcess.fork（真正 Node 子进程，--max-old-space-size 生效）；
//   纯 Node 测试下 require('electron') 抛错 → fallback spawn(process.execPath)。
let electronUtilityProcess = null;
try {
  electronUtilityProcess = require('electron').utilityProcess;
} catch (_err) {
  // 非 Electron 运行时；保持 spawn 兜底
}

// 统一收敛 worker stdout 事件 + 退出码 → 与旧同步 runBizOpImportAsync/runFlowImportAsync 同形返回值。
//   kind='bizOp'|'flow'；writeErrorReport({ errorRows }) → Promise<errorReportPath>（report=true 时调用）。
function spawnImportWorker({ kind, dbPath, date, filePath, onProgress, writeErrorReport, maxRowErrors }) {
  return new Promise((resolve) => {
    const jobMeta = { dbPath, kind, date, filePath };
    if (Number.isFinite(maxRowErrors) && maxRowErrors > 0) jobMeta.maxRowErrors = maxRowErrors;

    let stdoutBuf = '';
    let stderrBuf = '';
    const events = [];

    function onStdoutChunk(chunk) {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_e) { ev = { type: 'raw', line }; }
        events.push(ev);
        if (typeof onProgress === 'function' && ev.type === 'progress') {
          try { onProgress(ev); } catch (_progErr) { /* swallow */ }
        }
      }
    }

    async function finalize(code) {
      // flush 残余（worker exit 前最后一行可能未带 \n）
      if (stdoutBuf.trim()) {
        try { events.push(JSON.parse(stdoutBuf.trim())); } catch (_e) { events.push({ type: 'raw', line: stdoutBuf.trim() }); }
        stdoutBuf = '';
      }

      if (code === 0) {
        const complete = events.find((e) => e.type === 'complete');
        if (complete) {
          if (kind === 'bizOp') {
            resolve({ status: 'success', buName: complete.buName, validCount: complete.validCount });
          } else {
            resolve({ status: 'success', totalCount: complete.totalCount, validCount: complete.validCount });
          }
          return;
        }
        resolve({ status: 'error', message: 'worker 正常退出但缺 complete 事件', detailLines: [] });
        return;
      }

      // code !== 0：rejected（校验失败）/ header-error / fatal
      const rejected = events.find((e) => e.type === 'rejected');
      if (rejected) {
        // I2（β.2 review fix）：worker 回传 rowErrorTotal（全量真实错误数）+ truncated（是否超 maxRowErrors 被截）。
        //   透传给写报告逻辑（报告顶部标注截断）+ 上行到结果（renderer 可显示「共 N 条」），避免静默截断。
        const rowErrorTotal = Number.isFinite(rejected.rowErrorTotal)
          ? rejected.rowErrorTotal
          : (rejected.errorRows || []).length;
        const truncated = rejected.truncated === true;
        let errorReportPath = null;
        // report=true → 主进程写失败报告 xlsx（worker emit errorRows 带 rawRow）
        if (rejected.report && typeof writeErrorReport === 'function') {
          try {
            errorReportPath = await writeErrorReport({
              errorRows: rejected.errorRows,
              firstBu: rejected.firstBu,
              rowErrorTotal,
              truncated
            });
          } catch (wErr) {
            // 报告写失败不吞——仍返回 rejected，但记录写报告异常（不阻断拒绝结论）
            errorReportPath = null;
            logger.appendModuleLog({
              level: 'warning',
              source: 'main',
              domain: 'biz-op-recon',
              message: '[biz-op-recon] 失败报告写盘异常',
              details: [`kind=${kind}`, `date=${date}`, `err=${wErr && wErr.message ? wErr.message : String(wErr)}`]
            });
          }
        }
        resolve({
          status: 'rejected',
          errorReportPath,
          errorRows: (rejected.errorRows || []).map((e) => ({ rowIndex: e.rowIndex, reason: e.reason })),
          rowErrorTotal,
          truncated
        });
        return;
      }

      const headerErr = events.find((e) => e.type === 'header-error');
      if (headerErr) {
        // 表头/读取失败：与旧同步路径（reader throw FileValidationError → IPC catch）同形返回
        resolve({ status: 'error', message: headerErr.message, detailLines: headerErr.detailLines || [] });
        return;
      }

      const fatal = events.find((e) => e.type === 'fatal');
      const msg = fatal ? fatal.message : `worker 异常退出（code=${code}）\nstderr=${stderrBuf.trim().slice(0, 800)}`;
      resolve({ status: 'error', message: msg, detailLines: [] });
    }

    if (electronUtilityProcess) {
      const worker = electronUtilityProcess.fork(WORKER_SCRIPT, [JSON.stringify(jobMeta)], {
        execArgv: [`--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`],
        env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}` },
        stdio: 'pipe'
      });
      worker.stdout.on('data', onStdoutChunk);
      worker.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
      worker.on('exit', (code) => { finalize(code); });
    } else {
      const worker = spawn(process.execPath, [
        `--max-old-space-size=${NODE_MAX_OLD_SPACE_MB}`,
        WORKER_SCRIPT,
        JSON.stringify(jobMeta)
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      worker.stdout.on('data', onStdoutChunk);
      worker.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
      worker.on('error', (err) => {
        resolve({ status: 'error', message: 'worker spawn 失败：' + err.message, detailLines: [] });
      });
      worker.on('close', (code) => { finalize(code); });
    }
  });
}

// 业务OP 导入（默认 worker 路径）。无 dbPath → fallback 旧同步 runBizOpImportAsync（测试 / 兜底）。
//   params: { date, filePath, dbPath, writeBizOpErrorReportXlsx, errorReportsDir, onProgress, maxRowErrors,
//             readBizOpFile? }（readBizOpFile 仅 fallback 用）
async function runBizOpImportViaWorker(db, params) {
  const {
    date, filePath, dbPath,
    writeBizOpErrorReportXlsx, errorReportsDir,
    onProgress, maxRowErrors
  } = params;

  if (!dbPath) {
    // 回退旧同步路径（保持 contract 基线 / 无 dbPath 环境可用）
    return runBizOpImportAsync(db, params);
  }

  return spawnImportWorker({
    kind: 'bizOp',
    dbPath, date, filePath, onProgress, maxRowErrors,
    writeErrorReport: async ({ errorRows, firstBu, rowErrorTotal, truncated }) => {
      const saveDir = path.join(errorReportsDir, date);
      const fileName = makeBizOpErrorReportFileName(firstBu, date);
      // I2：透传 rowErrorTotal/truncated → 报告顶部标注截断
      return writeBizOpErrorReportXlsx({ date, buName: firstBu, errorRows, saveDir, fileName, rowErrorTotal, truncated });
    }
  });
}

// 流水导入（默认 worker 路径）。无 dbPath → fallback 旧同步 runFlowImportAsync。
async function runFlowImportViaWorker(db, params) {
  const {
    date, filePath, dbPath,
    writeFlowErrorReportXlsx, errorReportsDir,
    onProgress, maxRowErrors
  } = params;

  if (!dbPath) {
    return runFlowImportAsync(db, params);
  }

  return spawnImportWorker({
    kind: 'flow',
    dbPath, date, filePath, onProgress, maxRowErrors,
    writeErrorReport: async ({ errorRows, rowErrorTotal, truncated }) => {
      const saveDir = path.join(errorReportsDir, date);
      const fileName = makeFlowErrorReportFileName(date);
      // I2：透传 rowErrorTotal/truncated → 报告顶部标注截断
      return writeFlowErrorReportXlsx({ date, errorRows, saveDir, fileName, rowErrorTotal, truncated });
    }
  });
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
  addOneDay,
  formatTimestamp,
  formatDateCompact,
  formatTimeCompact,

  // 算法
  aggregateFlowByAccount,
  computeT1Op,
  compareT1OpWithComputed,
  diffT1AndT2Accounts,
  runReconciliation,

  // 整批拒绝 + 失败报告流程（旧同步路径，作 contract 基线 / 无 dbPath 兜底）
  runBizOpImportAsync,
  runFlowImportAsync,

  // worker 化导入入口（β.2-T2，默认走 worker；无 dbPath 回退旧同步）
  runBizOpImportViaWorker,
  runFlowImportViaWorker,

  // 文件名 helper
  makeBizOpErrorReportFileName,
  makeFlowErrorReportFileName,
  makeSingleDateDiffFileName,
  makeDateRangeDiffFileName,

  // session factory
  createBizOpReconSession
};
