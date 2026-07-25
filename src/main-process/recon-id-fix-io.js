// v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块 IO 层
// spec §五.1 / §三 / §四
//
// 职责：
//   readReconIdFixFile(filePath)   — 读旧 4 sheet；gateway 模式兼容 3.0.14 新 5/6 sheet
//   writeReconIdFixOutput({...})   — 写「订单修复」单 sheet（15 列）
//
// 读：SheetJS（与 v2.0.0-beta.3 bank-statement-io.js 同模式）
// 写：xlsx-js-style（避免引入 exceljs；与 pending-session.js 同模式 + 表头字号 10pt）

const path = require('node:path');
const fs = require('node:fs');
const XLSX = require('xlsx');
const XLSXStyle = require('xlsx-js-style');
const { applyWatermark } = require('./workbook-watermark');
const {
  DUPLICATE_GATEWAY_HEADERS
} = require('./pre-fund-reconciliation/output-mapper');

const { FileValidationError } = require('../backend/file-service/common');
const {
  RECON_RESULT_FIELDS,
  BUSINESS_BILL_FIELDS,
  OPPONENT_BILL_FIELDS,
  ORDER_REPAIR_FIELDS,
  RECON_RESULT_SHEET_NAME,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME
} = require('../constants/recon-id-fix-fields');
// v2.1.0-beta.3 T9：网关对账子模式 sheet 名 + 字段常量
const {
  GATEWAY_BILL_FIELDS,
  CHANNEL_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  GATEWAY_BILL_SHEET_NAME,
  CHANNEL_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
} = require('../constants/gateway-bill-recon-fields');

// v3.0.14「前置资金对账」导出格式。C4 只消费网关/渠道/订单修复 sheet，
// 但导入时仍严格校验结果 sheet，避免把结构损坏的文件静默当成有效输入。
const PRE_FUND_UNBALANCED_SHEET_NAME = '不平结果';
const PRE_FUND_BALANCED_SHEET_NAME = '平账结果';
const PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME = '重复网关账单';
const PRE_FUND_SOURCE_FIELD = '对账数据来源';
const PRE_FUND_FUND_TYPE_FIELD = 'FundType';
const PRE_FUND_UNBALANCED_FIELDS_LEGACY = Object.freeze([
  PRE_FUND_SOURCE_FIELD,
  ...RECON_RESULT_FIELDS_GATEWAY
]);
const PRE_FUND_UNBALANCED_FIELDS = Object.freeze([
  PRE_FUND_SOURCE_FIELD,
  ...RECON_RESULT_FIELDS_GATEWAY.slice(0, 4),
  PRE_FUND_FUND_TYPE_FIELD,
  ...RECON_RESULT_FIELDS_GATEWAY.slice(4)
]);
const PRE_FUND_BALANCED_FIELDS = Object.freeze([
  '网关-数据来源', '网关-BillDate', '网关-Channel', '网关-MerchantId', '网关-OrderId',
  '网关-ReconBillBizId', '网关-reconciliationId', '网关-Currency', '网关-Amount',
  '网关-TradeType', '网关-name', '网关-cardNo', '网关-真实渠道', '网关-清算网络',
  '对账结果', '银行-数据来源', '银行-BillDate', '银行-ValueDate', '银行-Channel',
  '银行-地区', '银行-MerchantId', '银行-ReconciliationId', '银行-ChannelOrderNo',
  '银行-name', '银行-cardNo', '银行-Currency', '银行-Credit Amount', '银行-Debit Amount',
  '银行-FundType', '银行-清算网络', '银行-OriginBillId'
]);

// v2.1.0-beta.3 T9：按 subMode 选择 sheet 名 + 字段常量集合
function getSheetConfigBySubMode(subMode) {
  if (subMode === 'gateway') {
    return {
      reconResultSheetName: RECON_RESULT_SHEET_NAME_GATEWAY,
      mainBillSheetName: GATEWAY_BILL_SHEET_NAME,
      oppBillSheetName: CHANNEL_BILL_SHEET_NAME,
      orderRepairSheetName: ORDER_REPAIR_SHEET_NAME_GATEWAY,
      reconResultFields: RECON_RESULT_FIELDS_GATEWAY,
      mainBillFields: GATEWAY_BILL_FIELDS,
      oppBillFields: CHANNEL_BILL_FIELDS,
      orderRepairFields: ORDER_REPAIR_FIELDS_GATEWAY
    };
  }
  // business（默认，保持现状）
  return {
    reconResultSheetName: RECON_RESULT_SHEET_NAME,
    mainBillSheetName: BUSINESS_BILL_SHEET_NAME,
    oppBillSheetName: OPPONENT_BILL_SHEET_NAME,
    orderRepairSheetName: ORDER_REPAIR_SHEET_NAME,
    reconResultFields: RECON_RESULT_FIELDS,
    mainBillFields: BUSINESS_BILL_FIELDS,
    oppBillFields: OPPONENT_BILL_FIELDS,
    orderRepairFields: ORDER_REPAIR_FIELDS
  };
}

// ===== 共用：把 sheet 转换成对象数组 + 严格列校验 =====
// 模式与 bank-statement-io.js sheetToObjects 一致；为保留 sheetName 在 detailLines 里区分
function sheetToObjects(sheet, expectedHeaders, sheetName) {
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  if (!aoa.length) {
    // 空 sheet（连表头都没）→ 视为"列校验失败"
    throw new FileValidationError(
      'invalid-column-count',
      `sheet「${sheetName}」为空，无法读取表头`,
      { detailLines: [`期望表头：${expectedHeaders.join(' / ')}`] }
    );
  }
  const actualHeaders = aoa[0].map((h) => (h === undefined || h === null ? '' : String(h)));
  if (actualHeaders.length !== expectedHeaders.length) {
    throw new FileValidationError(
      'invalid-column-count',
      `sheet「${sheetName}」表头列数不符：期望 ${expectedHeaders.length} 列，实际 ${actualHeaders.length} 列`,
      {
        detailLines: [
          `期望表头：${expectedHeaders.join(' / ')}`,
          `实际表头：${actualHeaders.join(' / ')}`
        ]
      }
    );
  }
  const mismatched = [];
  expectedHeaders.forEach((expected, idx) => {
    if (actualHeaders[idx] !== expected) {
      mismatched.push(`第 ${idx + 1} 列：期望 "${expected}"，实际 "${actualHeaders[idx]}"`);
    }
  });
  if (mismatched.length > 0) {
    throw new FileValidationError(
      'invalid-column-name',
      `sheet「${sheetName}」表头列名不符（${mismatched.length} 处）`,
      { detailLines: mismatched }
    );
  }
  // 不取 rows，只取 headers（仅用于「订单修复」sheet 模板）
  const rows = aoa.slice(1).map((rowArr) => {
    const obj = {};
    expectedHeaders.forEach((h, idx) => {
      obj[h] = rowArr[idx] ?? '';
    });
    return obj;
  });
  return { headers: expectedHeaders.slice(), rows };
}

function validateSheetHeadersOnly(sheet, expectedHeaders, sheetName) {
  const decodedRange = sheet && sheet['!ref']
    ? XLSX.utils.decode_range(sheet['!ref'])
    : { s: { r: 0, c: 0 }, e: { r: 0, c: expectedHeaders.length - 1 } };
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    range: {
      s: { r: 0, c: 0 },
      e: { r: 0, c: Math.max(decodedRange.e.c, expectedHeaders.length - 1) }
    }
  });
  if (!aoa.length) {
    throw new FileValidationError(
      'invalid-column-count',
      `sheet「${sheetName}」为空，无法读取表头`,
      { detailLines: [`期望表头：${expectedHeaders.join(' / ')}`] }
    );
  }
  const headerOnlySheet = XLSX.utils.aoa_to_sheet([aoa[0]]);
  sheetToObjects(headerOnlySheet, expectedHeaders, sheetName);
}

function readSheetOrThrow(wb, sheetName) {
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    throw new FileValidationError(
      'missing-sheet',
      `单据对账文件缺少 sheet「${sheetName}」`,
      { detailLines: [`实际 sheets：${wb.SheetNames.join(' / ')}`] }
    );
  }
  return sheet;
}

function readGatewayReconResult(wb, cfg) {
  const legacySheet = wb.Sheets[cfg.reconResultSheetName];
  if (legacySheet) {
    return sheetToObjects(legacySheet, cfg.reconResultFields, cfg.reconResultSheetName).rows;
  }

  const unbalancedSheet = wb.Sheets[PRE_FUND_UNBALANCED_SHEET_NAME];
  if (!unbalancedSheet) {
    throw new FileValidationError(
      'missing-sheet',
      `网关对账文件缺少 sheet「${cfg.reconResultSheetName}」或「${PRE_FUND_UNBALANCED_SHEET_NAME}」`,
      { detailLines: [`实际 sheets：${wb.SheetNames.join(' / ')}`] }
    );
  }

  const headerRows = XLSX.utils.sheet_to_json(unbalancedSheet, { header: 1, raw: true });
  const actualHeaders = headerRows.length > 0
    ? headerRows[0].map((header) => (
      header === undefined || header === null ? '' : String(header)
    ))
    : [];
  const supportedFields = actualHeaders.length === PRE_FUND_UNBALANCED_FIELDS_LEGACY.length
    ? PRE_FUND_UNBALANCED_FIELDS_LEGACY
    : PRE_FUND_UNBALANCED_FIELDS;
  const parsed = sheetToObjects(
    unbalancedSheet,
    supportedFields,
    PRE_FUND_UNBALANCED_SHEET_NAME
  );
  const balancedSheet = readSheetOrThrow(wb, PRE_FUND_BALANCED_SHEET_NAME);
  sheetToObjects(
    balancedSheet,
    PRE_FUND_BALANCED_FIELDS,
    PRE_FUND_BALANCED_SHEET_NAME
  );

  // C4 既有内部契约仍是旧 19 列；来源列和 FundType 只用于前置资金对账审计。
  return parsed.rows.map((row) => {
    const legacyRow = {};
    for (const field of cfg.reconResultFields) legacyRow[field] = row[field];
    return legacyRow;
  });
}

// ===== readReconIdFixFile =====
// 返回 { filePath, fileName, sheets: { reconResult, businessBills, opponentBills, fixTemplate }, importedAt }
// v2.1.0-beta.3 T9：加 subMode 参数（'business' | 'gateway'），按 mode 选 sheet 名 + 字段常量
//   sheets 输出 key 名（businessBills / opponentBills）保留不变，gateway 模式下分别承载网关账单/渠道账单数据
function readReconIdFixFile(filePath, subMode = 'business') {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new FileValidationError('file-not-found', `文件不存在：${filePath}`);
  }
  const cfg = getSheetConfigBySubMode(subMode);
  let wb;
  if (subMode === 'gateway') {
    const headerWorkbook = XLSX.readFile(filePath, { sheetRows: 1 });
    if (headerWorkbook.Sheets[PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME]) {
      validateSheetHeadersOnly(
        headerWorkbook.Sheets[PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME],
        DUPLICATE_GATEWAY_HEADERS,
        PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME
      );
    }
    const businessSheetNames = [
      cfg.reconResultSheetName,
      PRE_FUND_UNBALANCED_SHEET_NAME,
      PRE_FUND_BALANCED_SHEET_NAME,
      cfg.mainBillSheetName,
      cfg.oppBillSheetName,
      cfg.orderRepairSheetName
    ];
    wb = XLSX.readFile(filePath, { sheets: businessSheetNames });
    // 保留完整名称列表供 missing-sheet 错误展示，但重复审计数据没有进入本次解析结果。
    wb.SheetNames = headerWorkbook.SheetNames.slice();
  } else {
    wb = XLSX.readFile(filePath);
  }
  // business 模式仍要求旧 4 sheet；gateway 模式兼容 3.0.14 的新结果和重复审计 sheet。
  const reconResultRows = subMode === 'gateway'
    ? readGatewayReconResult(wb, cfg)
    : sheetToObjects(
      readSheetOrThrow(wb, cfg.reconResultSheetName),
      cfg.reconResultFields,
      cfg.reconResultSheetName
    ).rows;
  const businessSheet = readSheetOrThrow(wb, cfg.mainBillSheetName);
  const opponentSheet = readSheetOrThrow(wb, cfg.oppBillSheetName);
  const fixSheet = readSheetOrThrow(wb, cfg.orderRepairSheetName);

  const businessObj = sheetToObjects(businessSheet, cfg.mainBillFields, cfg.mainBillSheetName);
  const opponentObj = sheetToObjects(opponentSheet, cfg.oppBillFields, cfg.oppBillSheetName);
  // 「订单修复」sheet 仅校验表头（PRD §六.4.1 + spec §五.1）
  const fixObj = sheetToObjects(fixSheet, cfg.orderRepairFields, cfg.orderRepairSheetName);

  return {
    filePath,
    fileName: path.basename(filePath),
    sheets: {
      reconResult: reconResultRows,
      businessBills: businessObj.rows,
      opponentBills: opponentObj.rows,
      fixTemplate: { headers: fixObj.headers, rows: [] }
    },
    importedAt: Date.now()
  };
}

// ===== 文件名规则（spec §三 / PRD §七.5）=====
// 主输出文件名：单据对账修复-YYYYMMDDHHmm-{sanitize(scenarioName)}.xlsx
function buildTimestampMinute() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    pad(d.getHours()),
    pad(d.getMinutes())
  ].join('');
}

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

// 与 bank-statement-io.js sanitizeFileName 完全一致（字符级）
function sanitizeFileName(name, maxLen = 100) {
  let s = String(name || '');
  s = s.replace(/[\x00-\x1F\x7F]/g, '_');
  s = s.replace(/[\\/:*?"<>|]/g, '_');
  s = s.replace(/[. ]+$/, '');
  s = s.trim();
  if (s === '') return '_';
  const upperBase = s.toUpperCase().replace(/\.[^.]*$/, '');
  if (WINDOWS_RESERVED_NAMES.has(upperBase)) {
    s = `_${s}`;
  }
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// v2.1.0-beta.3 T9：文件名前缀按 subMode 切换
//   business → "单据对账修复-..."（保持现状）
//   gateway  → "网关对账修复-..."
function buildMainOutputFileName(scenarioName, timestamp = buildTimestampMinute(), subMode = 'business') {
  const safeName = sanitizeFileName(scenarioName);
  const prefix = subMode === 'gateway' ? '网关对账修复' : '单据对账修复';
  return `${prefix}-${timestamp}-${safeName}.xlsx`;
}

// PR-B Round 3（Decision 3，2026-05-09）：未匹配 report 文件名
//   默认（无 mainFileBaseName）：`单据对账修复-未匹配-YYYYMMDDHHmm-{sanitize(name)}.xlsx`
//
// PR #36 self-review round 5（P3-B，2026-05-09）：联动用户主文件名
//   传入 mainFileBaseName（用户在 saveDialog 里改过的主文件 basename，含或不含 .xlsx 扩展）
//   时输出 `{stem}-未匹配.xlsx`，stem = mainFileBaseName 去掉末尾 .xlsx（不区分大小写）；
//   mainFileBaseName 仍走 sanitizeFileName 防御危险字符。
//   旧签名 buildUnmatchedReportFileName(name, timestamp) 保持兼容（smoke 老用例不动）。
// v2.1.0-beta.3 T9：默认 fallback 文件名前缀按 subMode 切换（mainFileBaseName 联动路径不变）
function buildUnmatchedReportFileName(scenarioName, timestamp = buildTimestampMinute(), mainFileBaseName = null, subMode = 'business') {
  if (mainFileBaseName) {
    let stem = String(mainFileBaseName);
    // 去掉末尾 .xlsx（不区分大小写）
    stem = stem.replace(/\.xlsx$/i, '');
    const safeStem = sanitizeFileName(stem);
    return `${safeStem}-未匹配.xlsx`;
  }
  const safeName = sanitizeFileName(scenarioName);
  const prefix = subMode === 'gateway' ? '网关对账修复' : '单据对账修复';
  return `${prefix}-未匹配-${timestamp}-${safeName}.xlsx`;
}

// ===== writeReconIdFixOutput =====
// 单 sheet「订单修复」+ 表头 = ORDER_REPAIR_FIELDS（business 15 列含 SubBizType / gateway 14 列不含）+ 表头字号 10pt
// v2.1.0-beta.3 T9：加 subMode 参数，按 mode 选输出列模板 + sheet 名
async function writeReconIdFixOutput({ fixedRows, savePath, subMode = 'business' }) {
  if (!Array.isArray(fixedRows)) {
    throw new Error('writeReconIdFixOutput: fixedRows 必须是数组');
  }
  if (!savePath) {
    throw new Error('writeReconIdFixOutput: 需提供 savePath（用户保存路径）');
  }
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const cfg = getSheetConfigBySubMode(subMode);
  // 构造 aoa：第 0 行是表头，后面是数据行
  const aoa = [cfg.orderRepairFields.slice()];
  for (const row of fixedRows) {
    aoa.push(cfg.orderRepairFields.map((col) => {
      const v = row[col];
      if (v === null || v === undefined) return '';
      return v;
    }));
  }
  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  applyHeaderRowFont(ws);

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, cfg.orderRepairSheetName);
  applyWatermark(wb);
  XLSXStyle.writeFile(wb, savePath);

  return {
    filePath: savePath,
    fileName: path.basename(savePath),
    rowCount: fixedRows.length
  };
}

// PR-B Round 3（Decision 3，2026-05-09）：unmatched report writer
// 单 sheet「未匹配单据」+ 6 列表头 + 表头字号 10pt
// unmatchedRows 每行 = { 场景名, 单据来源, OrderId, BillDate, Amount, 未配原因 }
const UNMATCHED_REPORT_HEADERS = Object.freeze([
  '场景名', '单据来源', 'OrderId', 'BillDate', 'Amount', '未配原因'
]);
const UNMATCHED_REPORT_SHEET_NAME = '未匹配单据';

async function writeUnmatchedReport({ unmatchedRows, savePath }) {
  if (!Array.isArray(unmatchedRows)) {
    throw new Error('writeUnmatchedReport: unmatchedRows 必须是数组');
  }
  if (!savePath) {
    throw new Error('writeUnmatchedReport: 需提供 savePath（用户保存路径）');
  }
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const aoa = [UNMATCHED_REPORT_HEADERS.slice()];
  for (const row of unmatchedRows) {
    aoa.push(UNMATCHED_REPORT_HEADERS.map((col) => {
      const v = row && row[col];
      if (v === null || v === undefined) return '';
      return v;
    }));
  }
  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  applyHeaderRowFont(ws);

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, UNMATCHED_REPORT_SHEET_NAME);
  applyWatermark(wb);
  XLSXStyle.writeFile(wb, savePath);

  return {
    filePath: savePath,
    fileName: path.basename(savePath),
    rowCount: unmatchedRows.length
  };
}

// 表头字号 10pt（与 pending-session.js 完全相同的实现）
function applyHeaderRowFont(worksheet, headerRowIndex = 0) {
  if (!worksheet || !worksheet['!ref']) return;
  const range = XLSXStyle.utils.decode_range(worksheet['!ref']);
  if (headerRowIndex < range.s.r || headerRowIndex > range.e.r) return;
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    const addr = XLSXStyle.utils.encode_cell({ r: headerRowIndex, c });
    const cell = worksheet[addr];
    if (!cell) continue;
    const existingStyle = cell.s || {};
    const existingFont = existingStyle.font || {};
    cell.s = {
      ...existingStyle,
      font: { ...existingFont, sz: 10 }
    };
  }
}

module.exports = {
  readReconIdFixFile,
  writeReconIdFixOutput,
  writeUnmatchedReport,                  // Round 3 新增
  buildMainOutputFileName,
  buildUnmatchedReportFileName,          // Round 3 新增
  buildTimestampMinute,
  sanitizeFileName,
  UNMATCHED_REPORT_HEADERS,              // Round 3 新增
  UNMATCHED_REPORT_SHEET_NAME,           // Round 3 新增
  // 暴露给 smoke 测试
  RECON_RESULT_SHEET_NAME,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME,
  PRE_FUND_UNBALANCED_SHEET_NAME,
  PRE_FUND_BALANCED_SHEET_NAME,
  PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME,
  PRE_FUND_UNBALANCED_FIELDS,
  PRE_FUND_UNBALANCED_FIELDS_LEGACY,
  PRE_FUND_BALANCED_FIELDS,
  DUPLICATE_GATEWAY_HEADERS
};
