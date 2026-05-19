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
  // raw_json：用 FLOW_HEADERS 作为 key 序列化（writer 还原原 xlsx 时按 key 取值）
  const rawObj = {};
  const FLOW_HEADERS = require('./columns').FLOW_HEADERS;
  for (let i = 0; i < FLOW_HEADERS.length; i++) {
    rawObj[FLOW_HEADERS[i]] = values[i] === undefined ? '' : String(values[i]);
  }
  const rawJson = JSON.stringify(rawObj);
  stmt.run(monthKey, sourceFile, rowIndex, reconMainId, settleAmount, settleAmountAbs, settleCurrency, settleCurrencyNorm, rawJson, importedAt);
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
  const rawObj = {};
  const BILL_HEADERS = require('./columns').BILL_HEADERS;
  for (let i = 0; i < BILL_HEADERS.length; i++) {
    rawObj[BILL_HEADERS[i]] = values[i] === undefined ? '' : String(values[i]);
  }
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
