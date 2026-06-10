// v2.1.6 T5 — 收单单据币种校验：导入数据仓储层
// 职责：流水/单据两表的批量 INSERT + 月份枚举 + 清月数据
// 事务由调用方（session）控制；本仓储仅提供 prepared statement + 单行 run
//
// v0.7 fix4：流水侧入库取列从「币种/对账金额」（订单视角）改为「通道清算币种/通道清算金额」（清算视角），
//   DB 列名 recon_amount/recon_amount_abs/currency/currency_norm → settle_amount/settle_amount_abs/settle_currency/settle_currency_norm
//
// ⚠️ 资金红线：
//   - flow_imports 入库时 settle_amount_abs = ABS(parseFloat(settle_amount))；若解析失败抛错
//   - settle_currency_norm = trim+lower(settle_currency) 入库时归一，用于 SQL JOIN 比对
//   - 任何写入路径异常 → 调用方 ROLLBACK

const FLOW_INSERT_SQL = `
  INSERT INTO acquiring_bill_currency_flow_imports
    (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const BILL_INSERT_SQL = `
  INSERT INTO acquiring_bill_currency_bill_imports
    (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const { normalizeBillDate } = require('../acquiring-bill-currency-import/validator');

// P0-2（acquiring-import-recon-perf）：模块顶部一次性 require columns + 预计算字段下标映射，
//   替换原 insertBillRow 内每行 `require('./columns')` + 9×`BILL_HEADERS.indexOf()`（per-row 开销）。
//   通用模式（spec §8.3 留缝）：「headers 契约 → 下标映射」的纯数据，不内联业务专名，便于 O-7 引擎复用。
//   注：P0-1 落地后 flow 侧已不再构造 raw_json，故不再需要 FLOW_HEADERS（此处只用 BILL 侧 2 个常量）。
const { BILL_HEADERS, TEMPLATE_BILL_HEADERS } = require('./columns');

// TEMPLATE 9 字段 → BILL_HEADERS 下标（模块加载时一次性算出；过滤掉不在 BILL_HEADERS 的字段做防御）
const TEMPLATE_BILL_KEY_INDICES = TEMPLATE_BILL_HEADERS
  .map((key) => [key, BILL_HEADERS.indexOf(key)])
  .filter(([, idx]) => idx >= 0);

function normalizeCurrency(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function parseAmountAbs(value, fieldLabel = '通道清算金额') {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${fieldLabel}为空，无法解析`);
  }
  const num = Number(String(value).trim().replace(/,/g, ''));
  if (!Number.isFinite(num)) {
    throw new Error(`${fieldLabel}无法解析为数值："${value}"`);
  }
  // 保留输入精度（用 toFixed 会丢精度，直接 Math.abs 后 toString）
  return Math.abs(num).toString();
}

// row 形态：{ rowIndex (源 xlsx 1-based 行号), values (按 FLOW_HEADERS 顺序的 48 个值) }
// v0.7 fix4：取列 12/13 → 28/29（通道清算金额/通道清算币种）
// v0.9 fix6：通道清算金额允许为空（与通道清算币种对称，业务上 4 种流水子类型不走通道清算 ~0.6% 行）
function insertFlowRow(stmt, { monthKey, sourceFile, row, importedAt }) {
  const { rowIndex, values } = row;
  const reconMainId = String(values[6] /* 对账主Id */ || '').trim();
  if (!reconMainId) {
    throw new Error(`第 ${rowIndex} 行：对账主Id 为空`);
  }
  const settleAmountRaw = values[28] /* 通道清算金额（v0.7 fix4 从 values[12] 切换） */;
  const settleAmount = String(settleAmountRaw || '').trim();
  // v0.9 fix6：空值允许（4 种非清算流水子类型 ~0.6% 行）；非空则 parseAmountAbs 校验数值合法性
  const settleAmountAbs = settleAmount === '' ? '' : parseAmountAbs(settleAmountRaw, '通道清算金额');
  const settleCurrency = String(values[29] /* 通道清算币种（v0.7 fix4 从 values[13] 切换） */ || '').trim();
  const settleCurrencyNorm = normalizeCurrency(values[29]);
  // P0-1 决议（acquiring-import-recon-perf · O-1 已决 2026-06-10）：flow raw_json 永久停写，写 ''。
  //   依据：全代码库零消费实证 —— writer 仅读 bill_raw_json（writer.js）；对账 SQL 只取
  //   settle_currency_norm / settle_amount 单列；差异表「流水侧」字段来自 diff_rows.flow_currency /
  //   flow_amount_abs 快照列（run-repository.insertDiffRowsByJoin 写入），不依赖 flow_imports.raw_json。
  //   schema `raw_json TEXT NOT NULL` 由 '' 满足（无需 migration；存量行不动）。
  //   连带：随 rawObj 删除原「账单日期」normalizeBillDate 调用（它只服务 raw_json 内容；
  //   month_key 来自 reader 层 extractMonthKey，不受影响）。bill 侧的 normalizeBillDate 调用保留。
  stmt.run(monthKey, sourceFile, rowIndex, reconMainId, settleAmount, settleAmountAbs, settleCurrency, settleCurrencyNorm, '', importedAt);
}

// v0.7 fix4：单据侧列号不变（仍 values[19] 即「对账币种」），仅 DB 字段名同步为 settle_currency
function insertBillRow(stmt, { monthKey, sourceFile, row, importedAt }) {
  const { rowIndex, values } = row;
  const reconMainId = String(values[14] /* 主对账Id */ || '').trim();
  if (!reconMainId) {
    throw new Error(`第 ${rowIndex} 行：主对账Id 为空`);
  }
  const settleCurrency = String(values[19] /* 对账币种（语义即清算视角） */ || '').trim();
  const settleCurrencyNorm = normalizeCurrency(values[19]);
  // v2.1.8 N4 + self-review SR7（PR #52 Matthew Finding 1）：
  //   raw_json 改用 TEMPLATE_BILL_HEADERS 仅写 9 模版字段（非 BILL_HEADERS 全 26 列）
  //   契约闭环：v2.1.8 起 bill_imports.raw_json **永远** 仅含 9 字段
  //     - 老库：N4 migration ensureBillRawJsonV2Slim 瘦身（commit 37299cf）
  //     - 新写：本函数按 TEMPLATE_BILL_HEADERS 投影（本 commit）
  //   下游消费方仅 writer.js + run-repository 4 处 SQL json_extract '$."账单日期"'
  //   都在 9 字段内，无 break
  // P0-2（acquiring-import-recon-perf）：原每行 `require('./columns')` + 9×`indexOf` 改用
  //   模块顶部预计算的 TEMPLATE_BILL_KEY_INDICES（纯等价重构，行为零变化）。
  const rawObj = {};
  for (const [key, idx] of TEMPLATE_BILL_KEY_INDICES) {
    rawObj[key] = values[idx] === undefined ? '' : String(values[idx]);
  }
  // PR #50 reviewer finding F2：raw_json 写入前归一化「账单日期」为 YYYY-MM-DD（writer fmtSheetName / SQL GROUP BY 依赖）
  //   注：「账单日期」是 TEMPLATE_BILL_HEADERS[0]，本归一化仍生效
  rawObj['账单日期'] = normalizeBillDate(rawObj['账单日期']);
  const rawJson = JSON.stringify(rawObj);
  stmt.run(monthKey, sourceFile, rowIndex, reconMainId, settleCurrency, settleCurrencyNorm, rawJson, importedAt);
}

function prepareFlowInsert(db) {
  return db.prepare(FLOW_INSERT_SQL);
}

function prepareBillInsert(db) {
  return db.prepare(BILL_INSERT_SQL);
}

// 用户主动清某月数据（spec §七 IPC clearMonth）— 包 4 张表
// fix3：catch 块 ROLLBACK 用 try/catch 包裹，避免 ROLLBACK 异常掩盖主错
//   并发防御由 caller（main.js handler mutex）保证，本函数不主动清理事务
function clearMonth(db, monthKey) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM acquiring_bill_currency_diff_rows WHERE run_id IN (SELECT id FROM acquiring_bill_currency_runs WHERE month_key = ?)').run(monthKey);
    db.prepare('DELETE FROM acquiring_bill_currency_runs WHERE month_key = ?').run(monthKey);
    db.prepare('DELETE FROM acquiring_bill_currency_flow_imports WHERE month_key = ?').run(monthKey);
    db.prepare('DELETE FROM acquiring_bill_currency_bill_imports WHERE month_key = ?').run(monthKey);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;
  }
}

// fix1（spec §3.4）：覆盖导入时单侧清理 — 只清流水或单据，不动 runs / diff_rows
// 调用方持有事务时不应再开 BEGIN；这里用调用方传入的 db 直接 DELETE。
// kind: 'flow' | 'bill'
function deleteMonthBySide(db, { kind, monthKey }) {
  if (kind !== 'flow' && kind !== 'bill') {
    throw new Error(`deleteMonthBySide：unknown kind ${kind}`);
  }
  const table = kind === 'flow' ? 'acquiring_bill_currency_flow_imports' : 'acquiring_bill_currency_bill_imports';
  const result = db.prepare(`DELETE FROM ${table} WHERE month_key = ?`).run(monthKey);
  return { deletedCount: result.changes || 0 };
}

// v0.11 fix8：run 成功 + 文件落盘后自动清原始数据
// 删 diff_rows (按 run_id) + flow_imports/bill_imports (按 month_key)；不动 runs（保留路径+统计）
// caller（session）负责事务包；本函数无 BEGIN
function deleteRawDataAndDiffRows(db, { monthKey, runId }) {
  const diffResult = db.prepare('DELETE FROM acquiring_bill_currency_diff_rows WHERE run_id = ?').run(runId);
  const flowResult = db.prepare('DELETE FROM acquiring_bill_currency_flow_imports WHERE month_key = ?').run(monthKey);
  const billResult = db.prepare('DELETE FROM acquiring_bill_currency_bill_imports WHERE month_key = ?').run(monthKey);
  return {
    diffDeleted: diffResult.changes || 0,
    flowDeleted: flowResult.changes || 0,
    billDeleted: billResult.changes || 0
  };
}

// 月份下拉数据源：flow + bill 已导入月份的 union
function listMonths(db) {
  const rows = db.prepare(`
    SELECT DISTINCT month_key FROM acquiring_bill_currency_flow_imports
    UNION
    SELECT DISTINCT month_key FROM acquiring_bill_currency_bill_imports
    ORDER BY month_key DESC
  `).all();
  return rows.map((r) => r.month_key);
}

// 某月数据就绪检查（session 用）
function getMonthReadiness(db, monthKey) {
  const flowCount = db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_flow_imports WHERE month_key = ?').get(monthKey).c;
  const billCount = db.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = ?').get(monthKey).c;
  return { flowCount, billCount, flowReady: flowCount > 0, billReady: billCount > 0 };
}

module.exports = {
  prepareFlowInsert,
  prepareBillInsert,
  insertFlowRow,
  insertBillRow,
  clearMonth,
  deleteMonthBySide,
  deleteRawDataAndDiffRows,
  listMonths,
  getMonthReadiness,
  normalizeCurrency,
  parseAmountAbs
};
