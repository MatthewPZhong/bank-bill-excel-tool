// 收单单据（bill）大表导入引擎契约模块（v3.0.3 PR-H · 🔴🔴 资金红线）
//
// 职责：把收单单据导入的列契约 / 行变换 / 错误三态 / 月份提取 / 表头校验 / 覆盖删除 / 批错误文案
//   声明为引擎（big-table-import）可消费的契约。语义逐项 byte-for-byte 平移现行链路：
//     - mapRow            ← import-repository.insertBillRow（取列 14/19 + raw_json 写 9 模版字段 + 账单日期归一化）
//     - insertSql         ← import-repository.BILL_INSERT_SQL（列序严格一致：8 列）
//     - monthKeyOf        ← validator.extractMonthKey（账单日期列 0）
//     - validateHeaders   ← validator.validateBillHeaders（收单单据表 26 列严格校验）
//     - formatBatchError  ← reader streamImportOneFile 整批拒绝文案（首个出错文件优先，与 flow 契约同口径）
//     - deleteSqlForOverwrite ← import-repository.deleteMonthBySide(bill) 的 DELETE 语句
//
// 🔴 白名单 = null（全列解码）：O-5 五次修订 / spec §5 决议——bill 全 26 列里 raw_json 写 9 模版字段，
//   裁剪收益评估留后续单独 PR；本契约 valueColumnWhitelist 传 null（行为与全列解码逐字节相同，零风险）。
//
// 🔴 为何复制 insertBillRow 逻辑而不 require import-repository：见 contract-flow.js 头部同款说明
//   （回退路径 import-repository 一字不改且仍被引用；契约独立平移，避免双向耦合）。
//
// 约束：仅 require 收单 columns（纯常量）+ validator（纯函数）——无 Electron/SQLite 依赖，worker require 安全；
//   无模块级可变状态；importedAt 经 contractOptions 注入。

'use strict';

const { BILL_HEADERS, BILL_KEY_COLUMN_INDICES, TEMPLATE_BILL_HEADERS } = require('../acquiring-bill-currency-db/columns');
const { validateBillHeaders, extractMonthKey, normalizeBillDate } = require('./validator');

const MAX_COLLECTED_ERRORS = 100;

// TEMPLATE 9 字段 → BILL_HEADERS 下标（模块加载时一次性算出，过滤掉不在 BILL_HEADERS 的字段做防御）。
//   逐字平移 import-repository.TEMPLATE_BILL_KEY_INDICES（同样的预计算，避免 per-row indexOf）。
const TEMPLATE_BILL_KEY_INDICES = TEMPLATE_BILL_HEADERS
  .map((key) => [key, BILL_HEADERS.indexOf(key)])
  .filter(([, idx]) => idx >= 0);

// requiredColumns：mapRow（列 14 主对账Id / 列 19 对账币种 / raw_json 的 9 模版字段下标）∪ monthKeyOf（列 0）。
//   ⚠️ whitelist=null 时 contract.js 不做「白名单 ⊇ requiredColumns」校验，但仍如实声明（越界 sanity + 文档契约）。
const BILL_REQUIRED_COLUMNS = Array.from(new Set([
  BILL_KEY_COLUMN_INDICES.billDate,        // 0
  BILL_KEY_COLUMN_INDICES.reconMainId,     // 14
  BILL_KEY_COLUMN_INDICES.settleCurrency,  // 19
  ...TEMPLATE_BILL_KEY_INDICES.map(([, idx]) => idx)
])).sort((a, b) => a - b);

// bill INSERT 列序：与 import-repository.BILL_INSERT_SQL 严格一致（8 列）。
const BILL_INSERT_SQL = `
  INSERT INTO acquiring_bill_currency_bill_imports
    (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const BILL_DELETE_SQL = 'DELETE FROM acquiring_bill_currency_bill_imports WHERE month_key = ?';

// 平移 import-repository.normalizeCurrency。
function normalizeCurrency(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function createContract(options = {}) {
  const importedAt = options && options.importedAt ? String(options.importedAt) : '';

  return {
    expectedHeaders: BILL_HEADERS,
    valueColumnWhitelist: null, // O-5/spec §5：bill 不裁剪（全列解码，零行为变化）
    requiredColumns: BILL_REQUIRED_COLUMNS,

    validateHeaders(cells) {
      return validateBillHeaders(cells);
    },

    monthKeyOf({ values }) {
      return extractMonthKey(values[BILL_KEY_COLUMN_INDICES.billDate]);
    },

    // 行变换：逐字平移 import-repository.insertBillRow。
    mapRow({ rowR, values, ctx }) {
      const sourceFile = (ctx && ctx.sourceFile) ? ctx.sourceFile : '';
      // 主对账Id（列 14）非空校验 —— 平移 insertBillRow：空 → 「第 N 行：主对账Id 为空」。
      const reconMainId = String(values[14] || '').trim();
      if (!reconMainId) {
        return { error: { rowIndex: rowR, reason: '主对账Id 为空' } };
      }
      const settleCurrency = String(values[19] || '').trim();
      const settleCurrencyNorm = normalizeCurrency(values[19]);
      // raw_json：仅写 9 模版字段（TEMPLATE_BILL_KEY_INDICES），账单日期归一化为 YYYY-MM-DD。
      const rawObj = {};
      for (const [key, idx] of TEMPLATE_BILL_KEY_INDICES) {
        rawObj[key] = values[idx] === undefined ? '' : String(values[idx]);
      }
      rawObj['账单日期'] = normalizeBillDate(rawObj['账单日期']);
      const rawJson = JSON.stringify(rawObj);
      const monthKey = extractMonthKey(values[BILL_KEY_COLUMN_INDICES.billDate]);
      // 列序严格对齐 BILL_INSERT_SQL：month_key, source_file, source_row_index, recon_main_id,
      //   settle_currency, settle_currency_norm, raw_json, imported_at。
      return {
        params: [
          monthKey, sourceFile, rowR, reconMainId,
          settleCurrency, settleCurrencyNorm, rawJson, importedAt
        ]
      };
    },

    insertSql: BILL_INSERT_SQL,

    deleteSqlForOverwrite: BILL_DELETE_SQL,
    deleteParamsFromMonthKey(monthKey) {
      return [monthKey];
    },

    // 整批拒绝文案：与 contract-flow 同口径（首个出错文件优先，byte-for-byte 平移收单 reader）。
    formatBatchError({ collectedErrors, errorTotal, perFileErrorTotals }) {
      const errs = Array.isArray(collectedErrors) ? collectedErrors : [];
      const firstFile = errs.length > 0 ? errs[0].sourceFile : '';
      const fileErrs = errs.filter((e) => e.sourceFile === firstFile);
      const fileTotal = (perFileErrorTotals && perFileErrorTotals.get && Number.isFinite(perFileErrorTotals.get(firstFile)))
        ? perFileErrorTotals.get(firstFile)
        : fileErrs.length;
      const reachedLimit = fileTotal >= MAX_COLLECTED_ERRORS;
      const message = `${firstFile}：导入失败 ${fileTotal} 行（${reachedLimit ? '已达上限，提前终止' : '已读完'}）`;
      const detailLines = fileErrs.slice(0, 20).map((e) => `第 ${e.rowIndex} 行：${e.reason}`).concat(
        fileTotal > 20 ? [`...（共 ${fileTotal} 个错误，仅列前 20 个）`] : []
      );
      return { message, detailLines, name: 'ImportValidationError' };
    },

    errorName: 'ImportValidationError'
  };
}

module.exports = {
  createContract,
  BILL_INSERT_SQL,
  BILL_DELETE_SQL,
  BILL_REQUIRED_COLUMNS,
  MAX_COLLECTED_ERRORS
};
