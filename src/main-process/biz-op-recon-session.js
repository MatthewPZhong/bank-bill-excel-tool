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
const { DatabaseSync } = require('node:sqlite');
// v2.1.12-beta β.2-T2：导入 worker 化 spawn 方（纯 Node 测试路径用；Electron 走 utilityProcess）
const { spawn } = require('node:child_process');

const importsRepository = require('../backend/biz-op-recon-db/imports-repository');
const datasetHeadRepository = require('../backend/biz-op-recon-db/dataset-head-repository');
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

// 月末 OP 当前月事务的提交前门禁。调用方只在已存在的下月侧库上形成内部 intent；
// 这里复用 date+BU guard 只读 D/D+1，不创建数据、不按月份或 latest 推断 owner。
function assertBizOpMonthEndAdmission(monthEndAdmission, buName) {
  if (!monthEndAdmission) return;
  const db = new DatabaseSync(monthEndAdmission.dbPath, { readOnly: true });
  try {
    runRepository.assertNoUnacknowledgedArchiveRunByDateBu(
      db,
      monthEndAdmission.date,
      buName
    );
    runRepository.assertNoUnacknowledgedArchiveRunByDateBu(
      db,
      monthEndAdmission.nextDate,
      buName
    );
  } finally {
    db.close();
  }
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
function runReconciliationCore(db, { date, buName, archiveReceipt, expectedDatasets, legacy }) {
  const t2Date = subOneDay(date);

  db.exec('BEGIN');
  try {
    if (!legacy) {
      const t1Head = datasetHeadRepository.getHead(db, 'op', date, buName);
      const t2Head = datasetHeadRepository.getHead(db, 'op', t2Date, buName);
      const flowHead = datasetHeadRepository.getHead(db, 'flow', date);
      if (!t1Head || t1Head.datasetId !== expectedDatasets.t1DatasetId
          || !t2Head || t2Head.datasetId !== expectedDatasets.t2DatasetId
          || !flowHead || flowHead.datasetId !== expectedDatasets.flowDatasetId) {
        throw new Error('Biz OP 对账来源 dataset 已变化，请重新运行');
      }
    }

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

  let runId;
    runId = legacy
      ? runRepository.insertRun(db, {
        date,
        buName,
        status: 'success',
        stats: aggregateStats
      })
      : runRepository.insertArchiveRun(db, {
      date,
      buName,
      stats: aggregateStats,
      archiveTaskRunId: archiveReceipt.archiveTaskRunId
    });
    runRepository.insertDiffRows(db, runId, date, buName, diffRows);
    db.exec('COMMIT');
    return { runId, stats: aggregateStats };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function runReconciliation(db, { date, buName, archiveReceipt, expectedDatasets }) {
  if (!archiveReceipt || typeof archiveReceipt !== 'object' || Array.isArray(archiveReceipt)
      || Object.keys(archiveReceipt).length !== 2
      || archiveReceipt.archiveContractVersion !== 1
      || typeof archiveReceipt.archiveTaskRunId !== 'string'
      || !archiveReceipt.archiveTaskRunId.trim()) {
    throw new TypeError('Biz OP 对账必须携带 exact v1 Archive receipt');
  }
  if (!expectedDatasets || typeof expectedDatasets !== 'object' || Array.isArray(expectedDatasets)
      || Object.keys(expectedDatasets).length !== 3
      || ['t1DatasetId', 't2DatasetId', 'flowDatasetId'].some(
        (key) => typeof expectedDatasets[key] !== 'string' || !expectedDatasets[key].trim()
      )) {
    throw new TypeError('Biz OP 对账必须携带 exact 三源 dataset identity');
  }
  return runReconciliationCore(db, {
    date,
    buName,
    archiveReceipt: Object.freeze({ ...archiveReceipt }),
    expectedDatasets: Object.freeze({ ...expectedDatasets }),
    legacy: false
  });
}

function runLegacyReconciliation(db, { date, buName }) {
  return runReconciliationCore(db, { date, buName, legacy: true });
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
    errorReportsDir,
    datasetSeed
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
    const identity = datasetHeadRepository.nextDatasetIdentity(
      datasetHeadRepository.getHead(db, 'op', date, firstBu),
      datasetSeed.producerTaskRunId,
      () => datasetSeed.datasetId
    );
    runRepository.clearRunsAndDiffsByDateBu(db, date, firstBu);
    runRepository.clearRunsAndDiffsByDateBu(db, addOneDay(date), firstBu);
    importsRepository.clearByDateBu(db, date, firstBu);
    importsRepository.insertRows(db, date, rows);
    assertBizOpMonthEndAdmission(params.monthEndAdmission, firstBu);
    datasetHeadRepository.writeHead(db, {
      kind: 'op', dataDate: date, buName: firstBu, identity
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { status: 'success', buName: firstBu, validCount: rows.length };
}

// 流水导入同步 fallback（无 dbPath 兜底路径 / contract 基线）。
// 🔴 v3.0.2 需求1b（资金红线 R-1 / R-7）：支持 filePaths 多文件**合并到同一 date、单事务、单次 clear**，
//   语义必须与 worker 路径（import-worker.js runFlowImport）一致：
//   先把所有文件流式读出合并成 rows（边读边累加，记来源文件名）→ 全部读完后判 rows 为空 / 校验聚合
//   errorRows → 全通过才在**一个事务内** clearByDate 一次 + insert 合并后的全量行（整批拒绝语义保持）。
//   兼容旧入参：仅传 filePath（单数）时归一为 [filePath]，单文件 byte 级等价旧行为（错误报告/行数一致）。
async function runFlowImportAsync(db, params) {
  const {
    date,
    filePath,
    filePaths,
    readFlowFile,
    writeFlowErrorReportXlsx,
    errorReportsDir,
    datasetSeed
  } = params;

  // 入参归一：优先 filePaths（多文件）；否则回退单数 filePath（旧 contract / 兜底）。
  const files = Array.isArray(filePaths) && filePaths.length > 0
    ? filePaths
    : (filePath ? [filePath] : []);
  if (files.length === 0) {
    return { status: 'rejected', errorReportPath: null, errorRows: [{ rowIndex: 0, reason: '未选择文件' }] };
  }
  const multiFile = files.length > 1;   // 多文件才在错误原因标注来源文件名（单文件保回归）

  // 逐文件读出并合并（来源文件名随行携带，供多文件错误定位）。读取失败（表头/损坏）直接抛，
  //   与旧单文件同形（IPC catch → status:error），此时未进事务、DB 无任何改动。
  const rows = [];
  for (const fp of files) {
    const res = readFlowFile(fp);
    const fileName = (res && res.fileName) || path.basename(fp);
    for (const r of (res.rows || [])) {
      r._sourceFile = fileName;   // 标注来源（多文件错误报告/原因用；单文件不体现于 reason）
      rows.push(r);
    }
  }

  if (rows.length === 0) {
    return { status: 'rejected', errorReportPath: null, errorRows: [{ rowIndex: 0, reason: '文件无有效数据行' }] };
  }

  const errorRows = [];
  for (const r of rows) {
    const result = validateFlowRow(r);
    if (!result.ok) {
      // 多文件：原因前缀标注来源文件名，便于定位「哪个文件第几行错」；单文件保持原 reason（回归一致）。
      const reason = multiFile && r._sourceFile ? `[${r._sourceFile}] ${result.reason}` : result.reason;
      errorRows.push({ rowIndex: r._rowIndex, reason, rawRow: r });
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
  // 🔴 v3.0.2 需求1b：clearByDate 在事务内**只调用一次**（合并后整批 insert），与 worker 单次 clear 同语义；
  //   绝不循环「clear+insert」（否则后导文件清掉先导文件已插入行）。
  db.exec('BEGIN');
  try {
    const previous = datasetHeadRepository.getHead(db, 'flow', date);
    datasetHeadRepository.assertExpectedHead(previous, datasetSeed);
    const datasetIdentity = datasetHeadRepository.nextDatasetIdentity(
      previous,
      datasetSeed.producerTaskRunId,
      () => datasetSeed.datasetId
    );
    runRepository.clearRunsAndDiffsByDate(db, date);
    flowImportsRepository.clearByDate(db, date);
    flowImportsRepository.insertRows(db, date, rows);
    datasetHeadRepository.writeHead(db, {
      kind: 'flow', dataDate: date, identity: datasetIdentity
    });
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

// ════════════════════════════════════════════════════════════════════════════════
// v3.0.4 块 C（PR-D）：biz-op 流水（flow）侧导入迁移大表导入引擎（JSZip→yauzl 基座解除崩点；
//   child_process→worker_threads 拓扑统一；多文件并行）。🔴 资金红线（流水入库真理源）。
//   bizOp（业务OP）侧不迁（OPEN-1 拍板）：runBizOpImportViaWorker / import-worker bizOp 分支一字不改。
//
// 🔴 单行回退开关：USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW=false 即回退原 utilityProcess + import-worker.js 全旧链路
//   （import-worker.js / flow-imports-repository.js / run-repository.js / reader-streamed.js 一字不改保留可达）。
//   出引擎相关问题时拨 false 一行即恢复 v3.0.3 行为。生产默认走引擎（env 未设 → true）。
//   测试经 env BIZOP_FLOW_FORCE_LEGACY_IMPORT=1 强制旧路径做对照（仿 pending PENDING_FORCE_LEGACY_IMPORT）。
// ════════════════════════════════════════════════════════════════════════════════
const USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW =
  process.env.BIZOP_FLOW_FORCE_LEGACY_IMPORT === '1' ? false : true;

// 引擎共享 dispatch（OPEN-2：不收编收单；pending/biz-op flow 复用，§四共享模块）。
const { dispatchEngineImport } = require('./big-table-import-dispatch');
// flow 契约模块绝对路径（worker require 必须可序列化定位：路径 + contractOptions）。
const BIZOP_FLOW_CONTRACT_PATH = require.resolve('../backend/biz-op-recon-import/contract-flow');
// 流水 DB 列（引擎错误 cells（表头序 28 列）→ rawRow（snake_case key）重建用）。
const { FLOW_DB_COLUMNS: BIZOP_FLOW_DB_COLUMNS } = require('../backend/biz-op-recon-db/columns');
// F2（PR #71 SR）：引擎捕获的 cells 是 row-scanner 未归一原始值；restore 重建 rawRow 时逐格 normalizeCell（trim）
//   对齐旧链路 reader-streamed.js:220 `obj[dbColumns[i]] = normalizeCell(cells[i])`（byte-for-byte rawRow 命门）。
const { normalizeCell: normalizeFlowCell } = require('../backend/file-service/common');
// 引擎 worker_threads 堆上限（R-5）：替代旧 utilityProcess 8GB child（与 pending 同口径）。
const BIZOP_FLOW_ENGINE_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 4096 };

// Electron 下用 utilityProcess.fork（真正 Node 子进程，--max-old-space-size 生效）；
//   纯 Node 测试下 require('electron') 抛错 → fallback spawn(process.execPath)。
let electronUtilityProcess = null;
try {
  electronUtilityProcess = require('electron').utilityProcess;
} catch (_err) {
  // 非 Electron 运行时；保持 spawn 兜底
}

// ── v3.0.4 块 C（PR-D）：引擎错误对象 → 还原现行 flow rejected 形态（errorRows + rowErrorTotal + truncated）──
//   引擎整批拒绝抛 BigTableImportError，挂 structuredImportErrors
//     = { collectedErrors:[{sourceFile,rowIndex,reason[,cells]}], rowErrorTotal, rowErrorTruncated }（见 engine.js）。
//   还原规则（byte-for-byte 对齐旧 import-worker.js runFlowImport rejected 协议 + spawnImportWorker 消费形态）：
//     - 有 structuredImportErrors.collectedErrors（行级校验错：validateFlowRow 不过）→ 每条还原为
//       { rowIndex, reason, rawRow }（rawRow 由 cells（表头序 28 列）按 FLOW_DB_COLUMNS 重建，含 _rowIndex；
//        供 writeFlowErrorReportXlsx → flowRowToArray(rawRow) 逐列产出，与旧链路 reader 输出的 rawRow byte-for-byte 同形）。
//       → { status:'rejected', report:true, errorRows, rowErrorTotal, truncated }。
//     - 无行级错误（表头错 / 空文件 / 系统错）→ { status:'error', message, detailLines }
//       （对齐旧链路 header-error / fatal → spawnImportWorker { status:'error', message, detailLines }）。
//   返回与 spawnImportWorker 同形的 result 对象。
function restoreFlowEngineError(err, { writeErrorReport, multiFile = false }) {
  const structured = err && err.structuredImportErrors;
  const kind = structured && structured.kind;

  // F1（PR #71 SR）批级空数据 → 旧链路特殊 rejected 形态（report=false，errorRows 固定一条）。
  //   引擎 contract-flow rejectEmptyBatch 在事务内拒绝抛 BigTableImportError(kind='emptyBatch')；此处还原
  //   import-worker.js:356-365 形态 { status:'rejected', report:false, errorRows:[{rowIndex:0, reason:'文件无有效数据行'}] }。
  if (kind === 'emptyBatch') {
    return {
      status: 'rejected',
      report: false,
      errorRows: [{ rowIndex: 0, reason: '文件无有效数据行' }],
      rowErrorTotal: 1,
      truncated: false
    };
  }

  // F2 第 2 点（PR #71 SR）表头错 → 必须保旧 header-error 的 { status:'error', message, detailLines } 形态，
  //   不能因 collectedErrors 非空（多文件混批：一文件表头错 + 一文件行级错时 collectedErrors 已含行级错）被
  //   下方行级 rejected 分支误降级。据 kind==='header' 精确分流（引擎对表头错挂 kind='header'）。
  if (kind === 'header') {
    const message = (err && err.message) ? err.message : '流水导入失败';
    const detailLines = (err && Array.isArray(err.detailLines)) ? err.detailLines : [];
    return { status: 'error', message, detailLines };
  }

  if (structured && Array.isArray(structured.collectedErrors) && structured.collectedErrors.length > 0) {
    // 行级校验错（整批拒绝，report=true）。
    const errorRows = structured.collectedErrors.map((e) => {
      const rowIndex = e.rowIndex != null ? e.rowIndex : '';
      // F2 第 4 点（PR #71 SR）行级错误来源文件归属：多文件时 reason 加 `[文件名] ` 前缀，
      //   逐字对齐旧链路 import-worker.js:319-321 `multiFile ? `[${sourceName}] ${result.reason}` : result.reason`
      //   （sourceName = path.basename，引擎 collectedErrors.sourceFile 已是 basename）。单文件不加前缀（保回归）。
      const baseReason = e.reason != null ? e.reason : '';
      const reason = (multiFile && e.sourceFile) ? `[${e.sourceFile}] ${baseReason}` : baseReason;
      // F2 第 3 点（PR #71 SR）cells 归一修正：引擎 captureRowValues 取的是 row-scanner **未归一**原始值
      //   （import-worker.js:143 values.slice() 不 trim）；旧链路 rawRow 是 normalizeCell(cell)（reader-streamed.js:220
      //   逐格 trim）。故此处对每格 normalizeCell 再建 rawRow，byte-for-byte 对齐旧链路 rawRow（修正旧注释写反）。
      let rawRow;
      if (Array.isArray(e.cells)) {
        rawRow = {};
        for (let i = 0; i < BIZOP_FLOW_DB_COLUMNS.length; i++) {
          rawRow[BIZOP_FLOW_DB_COLUMNS[i]] = normalizeFlowCell(e.cells[i]);
        }
        rawRow._rowIndex = rowIndex;
      }
      return { rowIndex, reason, rawRow };
    });
    return {
      status: 'rejected',
      report: true,
      errorRows,
      rowErrorTotal: Number.isFinite(structured.rowErrorTotal) ? structured.rowErrorTotal : errorRows.length,
      truncated: structured.rowErrorTruncated === true,
      writeErrorReport
    };
  }
  // 空文件 / 系统错（无 kind 或 kind 非上述）→ { status:'error', message, detailLines }（对齐旧 header-error/fatal）。
  const message = (err && err.message) ? err.message : '流水导入失败';
  const detailLines = (err && Array.isArray(err.detailLines)) ? err.detailLines : [];
  return { status: 'error', message, detailLines };
}

// ── v3.0.4 块 C（PR-D）：flow 引擎路径导入实现 ──
//   dispatch 引擎 worker（mode='overwrite'，date 级覆盖删除 2 条 clear + flow 30 参 INSERT + 多文件单事务清一次累加）。
//   成功 → { status:'success', totalCount, validCount }（与旧链路 complete 事件形态一致）。
//   失败 → 引擎抛 BigTableImportError，restoreFlowEngineError 还原为 rejected/error 形态；report=true 时写失败报告 xlsx。
//   进度 → 引擎每 1w 行 { sourceFile, importedCount } 适配为现行 onProgress({ type:'progress', dataRows })。
async function runFlowImportViaEngine({
  dbPath, date, filePaths, onProgress, writeErrorReport, maxRowErrors, batchContext,
  datasetSeed
}) {
  try {
    const engineResult = await dispatchEngineImport({
      dbPath,
      files: filePaths,
      contractModulePath: BIZOP_FLOW_CONTRACT_PATH,
      contractOptions: { date, datasetSeed },
      mode: 'overwrite',
      batchContext,
      // monthKey 不传：契约 monthKeyOf=null ⇒ 引擎 baseMonthKey=null 旁路跨月校验（flow 单日由 date 入参）。
      resourceLimits: BIZOP_FLOW_ENGINE_RESOURCE_LIMITS,
      onEngineProgress: (ev) => {
        if (typeof onProgress !== 'function') return;
        // 适配为现行 onProgress 形态（旧链路 import-worker emit { type:'progress', dataRows }）：
        //   引擎并行解析无逐文件指针 → dataRows 取全局累计 importedCount（renderer 显示累计已导入行数）。
        try {
          onProgress({ type: 'progress', dataRows: ev.importedCount });
        } catch (_e) { /* swallow */ }
      },
      onLog: (entry) => {
        try {
          logger.appendModuleLog({
            level: entry.level || 'info', source: 'main', domain: 'biz-op-recon',
            message: entry.message || '[big-table-import] log',
            details: Array.isArray(entry.details) ? entry.details : undefined
          });
        } catch (_e) { /* swallow */ }
      }
    });
    // 成功：还原旧链路 flow complete 形态（totalCount/validCount = 引擎写入总行数）。
    //   🔴 F1（PR #71 SR）数据丢失回归修复：空批整批拒绝改由引擎在事务内处理（contract-flow rejectEmptyBatch）。
    //     原 session 事后判 validCount===0 返回 rejected 的写法有数据丢失 bug——overwrite 模式引擎事务头已 DELETE
    //     且无错误 COMMIT 后，session 才事后判空，删除已落盘而无新数据净入。现引擎在 COMMIT 前判 totalImported===0
    //     → 抛 BigTableImportError（kind='emptyBatch'）走整批 ROLLBACK，DELETE 与零行 INSERT 同事务原子撤销，
    //     由下方 catch → restoreFlowEngineError（kind==='emptyBatch' 分支）还原旧 rejected 形态。
    //     故成功路径不再出现 totalImported===0（空批已在引擎侧拒绝抛错）。
    const validCount = engineResult ? engineResult.totalImported : 0;
    return { status: 'success', totalCount: validCount, validCount };
  } catch (err) {
    // F2 第 4 点（PR #71 SR）：多文件时行级错误 reason 加 `[文件名] ` 前缀（对齐旧链路 import-worker multiFile）。
    const multiFile = Array.isArray(filePaths) && filePaths.length > 1;
    const restored = restoreFlowEngineError(err, { writeErrorReport, multiFile });
    if (restored.status === 'rejected') {
      // report=true → 主进程写失败报告 xlsx（cells 重建的 rawRow），与 spawnImportWorker rejected 分支同路。
      let errorReportPath = null;
      if (restored.report && typeof writeErrorReport === 'function') {
        try {
          errorReportPath = await writeErrorReport({
            errorRows: restored.errorRows,
            rowErrorTotal: restored.rowErrorTotal,
            truncated: restored.truncated
          });
        } catch (wErr) {
          errorReportPath = null;
          logger.appendModuleLog({
            level: 'warning', source: 'main', domain: 'biz-op-recon',
            message: '[biz-op-recon] 失败报告写盘异常（引擎路径）',
            details: [`date=${date}`, `err=${wErr && wErr.message ? wErr.message : String(wErr)}`]
          });
        }
      }
      return {
        status: 'rejected',
        errorReportPath,
        // 与 spawnImportWorker 一致：上行 errorRows 仅保留 rowIndex/reason（不含 rawRow）。
        errorRows: restored.errorRows.map((e) => ({ rowIndex: e.rowIndex, reason: e.reason })),
        rowErrorTotal: restored.rowErrorTotal,
        truncated: restored.truncated
      };
    }
    return { status: 'error', message: restored.message, detailLines: restored.detailLines };
  }
}

// 统一收敛 worker stdout 事件 + 退出码 → 与旧同步 runBizOpImportAsync/runFlowImportAsync 同形返回值。
//   kind='bizOp'|'flow'；writeErrorReport({ errorRows }) → Promise<errorReportPath>（report=true 时调用）。
//   bizOp 传 filePath（单数，不变）；flow 传 filePaths（v3.0.2 需求1b 多文件合并，单进程单事务单次 clear）。
function spawnImportWorker({
  kind, dbPath, date, filePath, filePaths, onProgress, writeErrorReport, maxRowErrors,
  batchContext, datasetSeed, monthEndAdmission
}) {
  return new Promise((resolve) => {
    const jobMeta = { dbPath, kind, date, batchContext };
    if (kind === 'bizOp') jobMeta.datasetSeed = datasetSeed;
    if (kind === 'bizOp' && monthEndAdmission) {
      jobMeta.monthEndAdmission = monthEndAdmission;
    }
    if (kind === 'flow') jobMeta.datasetSeed = datasetSeed;
    if (Array.isArray(filePaths) && filePaths.length > 0) {
      jobMeta.filePaths = filePaths;     // flow：多文件数组
    } else if (filePath) {
      jobMeta.filePath = filePath;       // bizOp：单文件（不变）
    }
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
    onProgress, maxRowErrors, batchContext, datasetSeed, monthEndAdmission
  } = params;

  if (!dbPath) {
    // 回退旧同步路径（保持 contract 基线 / 无 dbPath 环境可用）
    return runBizOpImportAsync(db, params);
  }

  return spawnImportWorker({
    kind: 'bizOp',
    dbPath, date, filePath, onProgress, maxRowErrors, batchContext, datasetSeed,
    monthEndAdmission,
    writeErrorReport: async ({ errorRows, firstBu, rowErrorTotal, truncated }) => {
      const saveDir = path.join(errorReportsDir, date);
      const fileName = makeBizOpErrorReportFileName(firstBu, date);
      // I2：透传 rowErrorTotal/truncated → 报告顶部标注截断
      return writeBizOpErrorReportXlsx({ date, buName: firstBu, errorRows, saveDir, fileName, rowErrorTotal, truncated });
    }
  });
}

// 流水导入（默认 worker 路径）。无 dbPath → fallback 旧同步 runFlowImportAsync。
// 🔴 v3.0.2 需求1b：接收 filePaths（多文件数组）透传 worker（单进程单事务合并到 date、单次 clear）。
//   兼容旧入参：仅 filePath（单数）时归一为 [filePath]；同步 fallback 也接收 filePaths（params 整体透传）。
async function runFlowImportViaWorker(db, params) {
  const {
    date, filePath, filePaths, dbPath,
    writeFlowErrorReportXlsx, errorReportsDir,
    onProgress, maxRowErrors, batchContext, datasetSeed
  } = params;

  // 入参归一：优先 filePaths（多文件）；否则回退单数 filePath。
  const files = Array.isArray(filePaths) && filePaths.length > 0
    ? filePaths
    : (filePath ? [filePath] : []);

  if (!dbPath) {
    // 同步 fallback：透传 filePaths（runFlowImportAsync 内部已支持多文件合并）。
    return runFlowImportAsync(db, { ...params, filePaths: files });
  }

  // 失败报告写盘闭包（引擎路径 + 旧 worker 路径共用，writeErrorReport 形态一致）。
  const writeErrorReport = async ({ errorRows, rowErrorTotal, truncated }) => {
    const saveDir = path.join(errorReportsDir, date);
    const fileName = makeFlowErrorReportFileName(date);
    // I2：透传 rowErrorTotal/truncated → 报告顶部标注截断
    return writeFlowErrorReportXlsx({ date, errorRows, saveDir, fileName, rowErrorTotal, truncated });
  };

  // ── v3.0.4 块 C（PR-D）：引擎路径（默认）。dbPath 已确保（上方 !dbPath 已 fallback）；
  //   BIZOP_FLOW_FORCE_LEGACY_IMPORT=1 → 回退旧 import-worker.js（spawnImportWorker，下方）。
  if (USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW) {
    return runFlowImportViaEngine({
      dbPath, date, filePaths: files, onProgress, maxRowErrors, writeErrorReport,
      batchContext, datasetSeed
    });
  }

  // ── 回退旧链路（BIZOP_FLOW_FORCE_LEGACY_IMPORT=1）：utilityProcess/spawn + import-worker.js 全旧路径 ──
  return spawnImportWorker({
    kind: 'flow',
    dbPath, date, filePaths: files, onProgress, maxRowErrors, batchContext, datasetSeed,
    writeErrorReport
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

  function run(params) {
    return runReconciliation(getDb(), params);
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
  assertBizOpMonthEndAdmission,
  formatTimestamp,
  formatDateCompact,
  formatTimeCompact,

  // 算法
  aggregateFlowByAccount,
  computeT1Op,
  compareT1OpWithComputed,
  diffT1AndT2Accounts,
  runLegacyReconciliation,
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
