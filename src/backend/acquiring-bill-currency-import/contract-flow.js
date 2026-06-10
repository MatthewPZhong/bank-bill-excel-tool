// 收单流水（flow）大表导入引擎契约模块（v3.0.3 PR-H · 🔴🔴 资金红线）
//
// 职责：把收单流水导入的「列契约 + 行变换 + 错误三态 + 月份提取 + 表头校验 + 覆盖删除 + 批错误文案」
//   声明为引擎（big-table-import）可消费的契约，供 import-worker / engine require（路径 + contractOptions 可序列化）。
//   语义逐项 byte-for-byte 平移自现行链路：
//     - mapRow            ← import-repository.insertFlowRow（取值列 6/28/29 + parseAmountAbs + normalizeCurrency + raw_json 恒 ''）
//     - insertSql         ← import-repository.FLOW_INSERT_SQL（列序严格一致：10 列，raw_json 占位 ''）
//     - monthKeyOf        ← validator.extractMonthKey（账单日期列 0 → 'YYYY-MM'）
//     - validateHeaders   ← validator.validateFlowHeaders（收单流水表 48 列严格校验）
//     - formatBatchError  ← reader streamImportOneFile 整批拒绝文案（`${sourceFile}：导入失败 N 行（...）` + `第 N 行：reason`）
//     - deleteSqlForOverwrite ← import-repository.deleteMonthBySide(flow) 的 DELETE 语句
//
// 🔴 为何复制 insertFlowRow 逻辑而不 require import-repository：
//   回退路径（reader-handrolled → import-repository）必须保持 import-repository 一字不改且仍被引用；
//   契约模块独立平移其行变换逻辑，避免双向耦合。任何对 insertFlowRow 取值/归一语义的修改都必须同步本文件
//   （已用全链对比集成脚本 acquiring-engine-migration.js byte-for-byte 锁死新旧两路一致）。
//
// 约束（引擎 worker require 安全性）：
//   - 仅 require 收单 columns（纯常量）+ validator（纯函数，依赖链止于 columns）——均无 Electron / SQLite 依赖。
//   - 无模块级可变状态；importedAt 等批级参数经 contractOptions（工厂入参）注入闭包，不读全局。

'use strict';

const { FLOW_HEADERS, FLOW_KEY_COLUMN_INDICES } = require('../acquiring-bill-currency-db/columns');
const { validateFlowHeaders, extractMonthKey } = require('./validator');

// 错误累积上限：与引擎 import-worker / 收单 reader 同口径（MAX_COLLECTED_ERRORS=100）。
const MAX_COLLECTED_ERRORS = 100;

// flow 入库实际消费 4/48 列：账单日期 0（monthKey 源）/ 对账主Id 6 / 通道清算金额 28 / 通道清算币种 29。
//   白名单 = FLOW_KEY_COLUMN_INDICES 全集（单一出处，跟随常量调整）；必须 ⊇ requiredColumns（contract.js 校验）。
const FLOW_VALUE_WHITELIST = Object.values(FLOW_KEY_COLUMN_INDICES);

// flow INSERT 列序：与 import-repository.FLOW_INSERT_SQL 严格一致（10 列）。
//   raw_json 列恒写 ''（P0-1/O-1 决议：flow raw_json 永久停写，schema NOT NULL 由 '' 满足）。
const FLOW_INSERT_SQL = `
  INSERT INTO acquiring_bill_currency_flow_imports
    (month_key, source_file, source_row_index, recon_main_id, settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// 覆盖导入：按月份单侧 DELETE flow_imports（语义平移 import-repository.deleteMonthBySide(kind='flow')）。
const FLOW_DELETE_SQL = 'DELETE FROM acquiring_bill_currency_flow_imports WHERE month_key = ?';

// ── 以下两个 helper 逐字平移 import-repository（不 require，见文件头说明）──

// 平移 import-repository.normalizeCurrency：trim + lower（空/空白 → ''）。
function normalizeCurrency(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

// 平移 import-repository.parseAmountAbs：去千分位 → Number → 非有限抛错 → Math.abs().toString()（保留输入精度）。
//   空值由 mapRow 提前判定（settle_amount === '' → settle_amount_abs = ''），不进此函数。
function parseAmountAbs(value, fieldLabel = '通道清算金额') {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${fieldLabel}为空，无法解析`);
  }
  const num = Number(String(value).trim().replace(/,/g, ''));
  if (!Number.isFinite(num)) {
    throw new Error(`${fieldLabel}无法解析为数值："${value}"`);
  }
  return Math.abs(num).toString();
}

// 契约工厂：contractOptions = { importedAt }（批级固定时间戳；engine/worker 把 session 传入的 importedAt 透传到此）。
//   返回引擎契约对象（schema 见 big-table-import/contract.js）。
function createContract(options = {}) {
  const importedAt = options && options.importedAt ? String(options.importedAt) : '';

  return {
    expectedHeaders: FLOW_HEADERS,
    valueColumnWhitelist: FLOW_VALUE_WHITELIST,
    requiredColumns: FLOW_VALUE_WHITELIST, // mapRow/monthKeyOf 实际消费列（contract.js 校验白名单 ⊇ 此集合）

    // 表头校验：直接复用收单 validateFlowHeaders（返回 { ok } | { ok:false, error, detailLines }）。
    validateHeaders(cells) {
      return validateFlowHeaders(cells);
    },

    // monthKey 提取：账单日期列 0 → 'YYYY-MM'（与 reader onRow 内 extractMonthKey 同源）。
    monthKeyOf({ values }) {
      return extractMonthKey(values[FLOW_KEY_COLUMN_INDICES.billDate]);
    },

    // 行变换：逐字平移 import-repository.insertFlowRow。
    //   ⚠️ ctx.sourceFile 由 engine import-worker 注入（spec §2.3 ctx；逐文件动态，不能走 contractOptions）。
    //   返回 { params }（INSERT 绑定，列序对齐 FLOW_INSERT_SQL）| { skip } | { error:{rowIndex,reason} }。
    //   rowIndex 用源 xlsx 真实行号 rowR（与收单 reader 行级错误 `第 ${rowIndex} 行` 一致）。
    mapRow({ rowR, values, ctx }) {
      const sourceFile = (ctx && ctx.sourceFile) ? ctx.sourceFile : '';
      // 对账主Id（列 6）非空校验 —— 平移 insertFlowRow：空 → 抛「第 N 行：对账主Id 为空」。
      const reconMainId = String(values[6] || '').trim();
      if (!reconMainId) {
        return { error: { rowIndex: rowR, reason: '对账主Id 为空' } };
      }
      // 通道清算金额（列 28）：空允许（4 种非清算流水子类型）；非空则 parseAmountAbs 校验数值合法性。
      const settleAmountRaw = values[28];
      const settleAmount = String(settleAmountRaw || '').trim();
      let settleAmountAbs;
      try {
        settleAmountAbs = settleAmount === '' ? '' : parseAmountAbs(settleAmountRaw, '通道清算金额');
      } catch (amtErr) {
        // 平移 reader：insertRow 抛错 → 累积为行级错误（reason = 错误 message）。
        return { error: { rowIndex: rowR, reason: amtErr && amtErr.message ? amtErr.message : String(amtErr) } };
      }
      const settleCurrency = String(values[29] || '').trim();
      const settleCurrencyNorm = normalizeCurrency(values[29]);
      // monthKey 入库值 = 账单日期列 0 提取（与 engine 跨月校验基准同源；engine 已保证只有同月行入库）。
      const monthKey = extractMonthKey(values[FLOW_KEY_COLUMN_INDICES.billDate]);
      // 列序严格对齐 FLOW_INSERT_SQL：month_key, source_file, source_row_index, recon_main_id,
      //   settle_amount, settle_amount_abs, settle_currency, settle_currency_norm, raw_json(''), imported_at。
      return {
        params: [
          monthKey, sourceFile, rowR, reconMainId,
          settleAmount, settleAmountAbs, settleCurrency, settleCurrencyNorm, '', importedAt
        ]
      };
    },

    insertSql: FLOW_INSERT_SQL,

    deleteSqlForOverwrite: FLOW_DELETE_SQL,
    deleteParamsFromMonthKey(monthKey) {
      return [monthKey];
    },

    // 整批拒绝文案：byte-for-byte 平移收单 reader streamImportOneFile 的错误重组。
    //   收单语义：事务内逐文件串行，首个出错文件即 throw（后续文件不读）→ 错误永远是「首个出错文件」的：
    //     message     = `${sourceFile}：导入失败 N 行（已达上限，提前终止 | 已读完）`
    //     detailLines = 前 20 条 `第 ${rowIndex} 行：${reason}` + （超 20 时）`...（共 N 个错误，仅列前 20 个）`
    //   引擎跨文件汇总后调本函数；为对齐收单「首个出错文件优先」语义，本函数只取首个出错文件的错误重组。
    //   入参 { collectedErrors:[{sourceFile,rowIndex,reason}], errorTotal, perFileErrorTotals:Map<sourceFile,count> }。
    //   返回 { message, detailLines, name }；name='ImportValidationError' 让 session/handler 既有识别零改动。
    formatBatchError({ collectedErrors, errorTotal, perFileErrorTotals }) {
      const errs = Array.isArray(collectedErrors) ? collectedErrors : [];
      // 首个出错文件（collectedErrors 已按 engine 写入顺序=文件序累积，首条即首个出错文件）。
      const firstFile = errs.length > 0 ? errs[0].sourceFile : '';
      const fileErrs = errs.filter((e) => e.sourceFile === firstFile);
      // 该文件错误总数（engine 传 perFileErrorTotals 精确计数；缺失时回退按样本数估算）。
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

    // 表头错 / peek 错的对外错误类名（引擎据此设 error.name；保 session/handler 识别 ImportValidationError）。
    errorName: 'ImportValidationError'
  };
}

module.exports = {
  createContract,
  // 供单测直接驱动（不起 worker）。
  FLOW_VALUE_WHITELIST,
  FLOW_INSERT_SQL,
  FLOW_DELETE_SQL,
  MAX_COLLECTED_ERRORS
};
