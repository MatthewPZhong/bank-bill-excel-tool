// v2.0.0-beta.3 PR #32a：exceljs 标黄输出 + error-report 写出
// v2.0.0-beta.4：error-report 加「可能原因」列（5 列），文案来自 file-service/error-causes.js
//
// 仅本模块（bank-statement-process）使用 exceljs；
// 其他 3 模块（statementGenerator / newAccountGenerator / pendingReconciliation）继续 SheetJS。
//
// 核心能力：
//   - writeBankStatementOutput：仅修改行 + 单元格黄底 + 表头
//   - writeErrorReport：5 列（时间戳 / 场景名 / 对账ID / 原因 / 可能原因）
//     v3.0.4 F3：第 3 列由内部 _rowId（row_N，多文件合并后全局重编号，对用户无意义）
//     改为银行行 ReconciliationId；取值三级回退 reconciliationId → reconId（R1 专用）→ rowId → ''
//
// 标黄约定：
//   cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }

const ExcelJS = require('exceljs');
const { errorCodeToCause } = require('../backend/file-service/error-causes');
const { applyWatermark } = require('./workbook-watermark');
// v3.0.4 块 F 修订 R2 Q14：Payment线下调拨核对 sheet 用——银行 44 列契约列序 + 中台 26 列签名列序。
const { BANK_STATEMENT_FIELDS } = require('../constants/bank-statement-fields');
const { ZHONGTAI_DISPATCH_ORDER_SIGNATURE } = require('../constants/table-signatures');
const { PAYMENT_OFFLINE_FIELD_MAP: POF } = require('../constants/payment-offline-allocation-fields');

const YELLOW_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFF00' }
};

// 内部字段（不写入 xlsx）
// v2.1.9 N5 T25：Sheet 3 撤除 — 改独立报表，详 scenario-hit-rows-writer.js
//   _hitChannelKey / _matchStatus / _matchedChannelId / _fallbackChannelId 也归此类（v2.1.9 dispatcher 注入）
//   v2.1.9 D16=b（2026-05-27 用户拍板）：新增 _hitChannelId（writer 用此查 channels.label 写「匹配渠道」列）
//
// 实现说明（v2.1.8 self-review SR4 + v2.1.9 N5 续）：
//   writer 实际不消费此 Set — 投影写盘走 `headers.map(h => row[h])`（buildSheetData / writeBankStatementOutput），
//   headers 来源是 reader 校验过的 44 列固定表头，`_` 前缀字段不会进 headers → 投影自动过滤。
//   本 Set 是声明式枚举，便于 grep 追溯哪些字段属"内部"；未来若 writer 改为遍历 row keys 写盘，
//   必须用此 Set 显式过滤（防 _ 前缀字段泄漏）。
const INTERNAL_FIELDS = new Set([
  '_rowId',
  '_modifiedColumns',
  '_hitScenarioId',
  '_hitScenarioDisplayIndex',
  '_hitScenarioName',
  // v2.1.9 N5（dispatcher 双维调度注入）
  '_hitChannelKey',
  '_matchStatus',
  '_matchedChannelId',
  '_fallbackChannelId',
  // v2.1.9 D16=b（2026-05-27 用户拍板）
  '_hitChannelId'
]);

function buildSheetData(rows, headers) {
  const dataRows = rows.map((row) => headers.map((h) => row[h]));
  return [headers, ...dataRows];
}

// v2.1.7 round 3 F8 (spec §9.8.4)：stripInternalFields helper
//   过滤 _ 前缀字段（如 _rowId / _hitScenarioId / _modifiedColumns），返回干净对象
//   未命中场景行 sheet 不应暴露内部诊断字段（用户期望"原始银行对账单行所有列"）
//   注：写 sheet 用 headers 投影，本 helper 主要给未来需要 JSON 输出场景用
function stripInternalFields(row) {
  const cleaned = {};
  for (const k of Object.keys(row)) {
    if (!k.startsWith('_')) cleaned[k] = row[k];
  }
  return cleaned;
}

// v2.1.16-beta.6 需求 B（PRD §三 / TECH §需求B 🔴 资金红线：对账主产物破坏性格式变更）：
//   预加工导出由旧「渠道对账单 + 未命中场景行」双 sheet 重构为「未命中场景 + 命中场景」双 sheet。
//
// rows（= modifiedRows）: Array<{ ...原列, _rowId, _modifiedColumns: Set<columnName>, _hitScenarioId, _hitScenarioDisplayIndex, _hitScenarioName }>
// headers: Array<string>（44 列原表头）
// savePath: 绝对路径（含 .xlsx）
// unmatchedRows: Array<{...原列}> | null（未命中行；null → 不输出 sheet1，仅命中 sheet）
// modifications: Array<{ rowId, column, oldValue, newValue, scenarioId, scenarioName }> | null
//   命中明细列数据源（D9）。rowId === modifiedRows 行的 _rowId（已核实，见 PR 报告）：
//   engine-utils.js record(rowId,...) → rowId 来自 ensureRowId(row)=row._rowId；
//   bank-statement-io.js readBankStatement 注入 row._rowId='row_idx'。
//
// sheet1「未命中场景」：A1 加粗提示 + 第 2 行表头 + 第 3 行起 unmatchedRows
//   （FundType==='Mark without result' 数据值的行排前，其余随后 — D8）
// sheet2「命中场景」：第一列「命中明细」+ 原 headers；命中行保留标黄（D5）；命中明细多条以 \n 拼接（B-Q2）
const MARK_WITHOUT_RESULT = 'Mark without result';
const SHEET1_UNMATCHED_NAME = '未命中场景';
const SHEET2_HIT_NAME = '命中场景';
const SHEET1_A1_NOTICE = '请检查，导入前请删除该sheet';
const HIT_DETAIL_HEADER = '命中明细';

// 单元格值规整为字符串（用于 FundType 排序判等 + 命中明细拼接）
//   null/undefined → ''；其它原样 String()（数据值精确匹配，不 trim 不改大小写）
function cellToString(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

// 把一行的 modifications（多条字段级变更）拼成命中明细文本：
//   每条 `<命中场景:"场景名";"字段名";变更前:"旧值";变更后:"新值">`，多条用换行分隔（B-Q2）
function buildHitDetail(mods) {
  if (!Array.isArray(mods) || mods.length === 0) return '';
  return mods
    .map((m) => `<命中场景:"${cellToString(m.scenarioName)}";"${cellToString(m.column)}";`
      + `变更前:"${cellToString(m.oldValue)}";变更后:"${cellToString(m.newValue)}">`)
    .join('\n');
}

// ===== v3.0.4 块 F 修订 R2 Q14：Payment线下调拨核对 3 sheet =====
//   pairs 项 = { bankRow, orderRow, round, oldReconciliationId, dayDiff }（引擎产出，见
//   r5-payment-offline-allocation-backfill.js 返回值）。pairs 为 null/空数组 → 完全不加 sheet（主文件形态零变化）。
const PAYMENT_OFFLINE_SHEET = Object.freeze({
  match: '匹配对照',
  bankRaw: '银行行-原始',
  orderRaw: '订单行-原始'
});
// 匹配轮次内部值 → 中文展示
const PAYMENT_OFFLINE_ROUND_LABEL = Object.freeze({
  main: '主轮',
  'date-tolerance': '容差轮',
  'relaxed-week': '兜底轮'
});
// 「匹配对照」sheet 表头（15 + 配对序号；列序见 spec §R2.3 导出）
const PAYMENT_OFFLINE_MATCH_HEADERS = Object.freeze([
  '配对序号', '匹配轮次', 'BillDate', 'Credit Amount', 'Currency', '原ReconciliationId',
  '回填值(渠道流水号)', '调拨单号', '交易时间', '收款金额', '收款币种', '付款渠道', '收款渠道',
  '银行周', '订单周', '天数差'
]);

// 在 workbook 追加 3 核对 sheet（仅 pairs 非空数组时调用）。
//   bankHeaders：银行 44 列契约列序（BANK_STATEMENT_FIELDS）；orderHeaders：中台 26 列签名列序。
function appendPaymentOfflineSheets(workbook, pairs) {
  const { weekTag, parseFtaDate } = require('./scenario-engines/engine-week-utils');
  // 真实 app 链路中 mid 行来自链接表 raw_json：「交易时间」是字符串 Excel 序列号（如 '46179'）、
  //   「收款金额」是字符串数字（如 '7587133'）。引擎匹配走 toDate/parseNumber 不受影响，但「匹配对照」sheet
  //   若原样写入会显示无法阅读的 46179 → 仅本 shet 的 4 个值列规整展示形态（两张「-原始」sheet 保持忠实 dump）。
  const { toDate } = require('./scenario-engines/engine-date-utils');
  const { parseNumber } = require('./scenario-engines/engine-utils');
  // 日期列：toDate 解析后取【本地时区】年月日 'YYYY-MM-DD'（⚠️ 禁 toISOString——UTC 转换会差一天）；失败回退原值。
  const fmtDate = (value) => {
    const d = toDate(value);
    if (!d) return value;
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };
  // 金额列：parseNumber 解析为数字写入；失败（null）回退原值。
  const fmtNumber = (value) => {
    const n = parseNumber(value);
    return n === null ? value : n;
  };
  // ① 匹配对照
  const sm = workbook.addWorksheet(PAYMENT_OFFLINE_SHEET.match);
  sm.addRow([...PAYMENT_OFFLINE_MATCH_HEADERS]);
  sm.getRow(1).font = { bold: true, size: 10 };
  pairs.forEach((p, idx) => {
    const b = p.bankRow || {};
    const o = p.orderRow || {};
    const billDate = b[POF.bank.billDate];
    const txTime = o[POF.mid.txTime];
    sm.addRow([
      idx + 1,
      PAYMENT_OFFLINE_ROUND_LABEL[p.round] || cellToString(p.round),
      // BillDate / 交易时间：规整为 'YYYY-MM-DD'（序列号/多格式字符串 → 可读日期）
      fmtDate(billDate),
      // Credit Amount / 收款金额：规整为数字（字符串数字 → number）
      fmtNumber(b[POF.bank.creditAmount]),
      b[POF.bank.currency],
      // 原值：引擎覆盖前捕获的 oldReconciliationId（非银行行当前最新值）
      cellToString(p.oldReconciliationId),
      o[POF.mid.channelSerialNo],
      o[POF.mid.dispatchNo],
      fmtDate(txTime),
      fmtNumber(o[POF.mid.payeeAmount]),
      o[POF.mid.payeeCurrency],
      // 付款渠道：26 列签名 idx22（出款行，仅核对展示，非引擎筛选列）
      o['付款渠道'],
      o[POF.mid.receiveChannel],
      // 银行周 = weekTag(BillDate)（银行行【自身】周数，非 join 桶键）；订单周 = weekTag(调拨单号 FTA 日期）。
      //   两列肉眼可见「订单周 = 银行周 + 1」的关系（如银行周 2619 / 订单周 2620），对齐用户已核对的桌面模拟文件。
      weekTag(billDate),
      weekTag(parseFtaDate(o[POF.mid.dispatchNo])),
      p.dayDiff
    ]);
  });

  // ② 银行行-原始：配对序号 + 44 列契约列（复用 stripInternalFields 剥 _ 内部字段）
  const sb = workbook.addWorksheet(PAYMENT_OFFLINE_SHEET.bankRaw);
  sb.addRow(['配对序号', ...BANK_STATEMENT_FIELDS]);
  sb.getRow(1).font = { bold: true, size: 10 };
  pairs.forEach((p, idx) => {
    const cleaned = stripInternalFields(p.bankRow || {});
    sb.addRow([idx + 1, ...BANK_STATEMENT_FIELDS.map((h) => cleaned[h])]);
  });

  // ③ 订单行-原始：配对序号 + 中台 26 列签名列序
  const orderHeaders = ZHONGTAI_DISPATCH_ORDER_SIGNATURE.expectedHeaders;
  const so = workbook.addWorksheet(PAYMENT_OFFLINE_SHEET.orderRaw);
  so.addRow(['配对序号', ...orderHeaders]);
  so.getRow(1).font = { bold: true, size: 10 };
  pairs.forEach((p, idx) => {
    const o = p.orderRow || {};
    so.addRow([idx + 1, ...orderHeaders.map((h) => o[h])]);
  });
}

// v3.0.4 块 F 修订 R2 Q14：paymentOfflinePairs 非空时在既有 2 sheet 后追加 3 核对 sheet；null/空 → 主文件形态零变化。
async function writeBankStatementOutput(rows, headers, savePath, unmatchedRows = null, modifications = null, paymentOfflinePairs = null) {
  const workbook = new ExcelJS.Workbook();

  // ===== sheet1「未命中场景」=====
  //   仅当 caller 显式传 unmatchedRows（Array）时输出（向下兼容旧 caller 不传 → 仅命中 sheet）。
  //   即使 0 行也输出含 A1 提示 + 表头的空 sheet（AC B-5）。
  if (Array.isArray(unmatchedRows)) {
    const s1 = workbook.addWorksheet(SHEET1_UNMATCHED_NAME);
    // 第 1 行 A1：加粗提示（B-1）
    const a1 = s1.getCell('A1');
    a1.value = SHEET1_A1_NOTICE;
    a1.font = { bold: true };

    // 排序：FundType 数据值 === 'Mark without result' 的行排前，其余随后（D8 / B-2）
    //   稳定排序：filter 两段拼接保留各段原始相对顺序
    const markFirst = unmatchedRows.filter((r) => cellToString(r && r['FundType']) === MARK_WITHOUT_RESULT);
    const others = unmatchedRows.filter((r) => cellToString(r && r['FundType']) !== MARK_WITHOUT_RESULT);
    const sortedUnmatched = [...markFirst, ...others];

    // 第 2 行表头（B-Q1 已定：加表头），第 3 行起数据（headers 投影自动过滤 _ 前缀诊断列）
    const headerRow2 = s1.getRow(2);
    headers.forEach((h, idx) => { headerRow2.getCell(idx + 1).value = h; });
    headerRow2.font = { bold: true, size: 10 };
    sortedUnmatched.forEach((row, rowIdx) => {
      const r = s1.getRow(rowIdx + 3);
      headers.forEach((h, colIdx) => { r.getCell(colIdx + 1).value = row[h]; });
    });
  }

  // ===== sheet2「命中场景」=====
  //   第一列「命中明细」+ 原 headers；命中行保留标黄（D5）。
  //   空数组（全未命中）仍输出含表头的空 sheet（AC B-5）。
  const s2 = workbook.addWorksheet(SHEET2_HIT_NAME);
  const hitHeaders = [HIT_DETAIL_HEADER, ...headers];
  s2.addRow(hitHeaders);
  s2.getRow(1).font = { bold: true, size: 10 };

  // 按 rowId group modifications（rowId === row._rowId，已核实）
  const modsByRowId = new Map();
  if (Array.isArray(modifications)) {
    modifications.forEach((m) => {
      if (!m || m.rowId === undefined || m.rowId === null) return;
      if (!modsByRowId.has(m.rowId)) modsByRowId.set(m.rowId, []);
      modsByRowId.get(m.rowId).push(m);
    });
  }

  rows.forEach((row, rowIdx) => {
    const mods = modsByRowId.get(row._rowId) || [];
    const detail = buildHitDetail(mods);
    const cells = [detail, ...headers.map((h) => row[h])];
    const r = s2.addRow(cells);
    // 命中明细列多行换行显示（B-Q2）
    r.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    // 保留原标黄（D5）：_modifiedColumns 对应单元格黄底；命中明细列后移 1 → colIdx + 2
    const modifiedColumns = row._modifiedColumns;
    if (modifiedColumns && modifiedColumns.size > 0) {
      headers.forEach((header, colIdx) => {
        if (!modifiedColumns.has(header)) return;
        r.getCell(colIdx + 2).fill = YELLOW_FILL;
      });
    }
  });

  // ===== v3.0.4 块 F 修订 R2 Q14：追加 Payment线下调拨核对 3 sheet =====
  //   pairs 为 null / 非数组 / 空数组 → 完全不加 sheet（未勾选/无命中时主文件形态零变化）。
  if (Array.isArray(paymentOfflinePairs) && paymentOfflinePairs.length > 0) {
    appendPaymentOfflineSheets(workbook, paymentOfflinePairs);
  }

  applyWatermark(workbook);
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

// v3.0.4 F3：error-report 第 3 列「对账ID」取值——三级回退链。
//   ReconciliationId 可能是 number（bank-statement-io readBankStatement raw 读入），
//   判空须 String(v).trim()；空串 / null / undefined 视为未命中继续回退。
function resolveReconIdCell(w) {
  const candidates = [w.reconciliationId, w.reconId, w.rowId];
  for (const v of candidates) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return '';
}

// warnings: Array<{ scenarioId, scenarioName, rowId, code, message, reconciliationId?, reconId? }>
//   v3.0.4 F3：第 3 列「对账ID」取值三级回退——
//     reconciliationId（caller enrich 注入的银行行 ReconciliationId，String+trim 非空）
//       → reconId（R1 'multi-bank-match-r1' warning 自带专用字段，rowId=null 时兜底）
//       → rowId（旧 shape 调用方未传 bankRows 时回退 _rowId，向后兼容）→ ''
//   注：引擎 warning 其余透传字段（fields/matchedRowIds/phase/severity 等）不写盘。
// savePath: 绝对路径（含 .xlsx）
async function writeErrorReport(warnings, savePath) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('error-report');

  const headers = ['时间戳', '场景名', '对账ID', '原因', '可能原因'];
  sheet.addRow(headers);
  // 表头加粗 + 字号 10（v2.0.0 GA：所有导出表头统一 size 10）
  sheet.getRow(1).font = { bold: true, size: 10 };

  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  warnings.forEach((w) => {
    sheet.addRow([
      timestamp,
      w.scenarioName ?? `场景 #${w.scenarioId}`,
      resolveReconIdCell(w),
      w.message ?? w.code ?? '',
      errorCodeToCause(w.code)
    ]);
  });

  applyWatermark(workbook);
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

module.exports = {
  writeBankStatementOutput,
  writeErrorReport,
  resolveReconIdCell,      // v3.0.4 F3：error-report 第 3 列「对账ID」三级回退（unit 直测）
  stripInternalFields,     // v2.1.7 round 3 F8 (spec §9.8.4)
  YELLOW_FILL,
  INTERNAL_FIELDS,
  // v2.1.16-beta.6 需求 B：双 sheet 重构（单测 + caller 引用）
  buildHitDetail,
  SHEET1_UNMATCHED_NAME,
  SHEET2_HIT_NAME,
  SHEET1_A1_NOTICE,
  HIT_DETAIL_HEADER,
  MARK_WITHOUT_RESULT
};
