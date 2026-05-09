// v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块 IO 层
// spec §五.1 / §三 / §四
//
// 职责：
//   readReconIdFixFile(filePath)   — 读 4 sheet（对账结果 / 业务部门账单 / 对手部门账单 / 订单修复）
//   writeReconIdFixOutput({...})   — 写「订单修复」单 sheet（15 列）
//
// 读：SheetJS（与 v2.0.0-beta.3 bank-statement-io.js 同模式）
// 写：xlsx-js-style（避免引入 exceljs；与 pending-session.js 同模式 + 表头字号 10pt）

const path = require('node:path');
const fs = require('node:fs');
const XLSX = require('xlsx');
const XLSXStyle = require('xlsx-js-style');

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

// ===== readReconIdFixFile =====
// 返回 { filePath, fileName, sheets: { reconResult, businessBills, opponentBills, fixTemplate }, importedAt }
function readReconIdFixFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new FileValidationError('file-not-found', `文件不存在：${filePath}`);
  }
  const wb = XLSX.readFile(filePath);
  // spec §五.1 4 sheet 缺一即 missing-sheet
  const reconSheet = readSheetOrThrow(wb, RECON_RESULT_SHEET_NAME);
  const businessSheet = readSheetOrThrow(wb, BUSINESS_BILL_SHEET_NAME);
  const opponentSheet = readSheetOrThrow(wb, OPPONENT_BILL_SHEET_NAME);
  const fixSheet = readSheetOrThrow(wb, ORDER_REPAIR_SHEET_NAME);

  const reconResultObj = sheetToObjects(reconSheet, RECON_RESULT_FIELDS, RECON_RESULT_SHEET_NAME);
  const businessObj = sheetToObjects(businessSheet, BUSINESS_BILL_FIELDS, BUSINESS_BILL_SHEET_NAME);
  const opponentObj = sheetToObjects(opponentSheet, OPPONENT_BILL_FIELDS, OPPONENT_BILL_SHEET_NAME);
  // 「订单修复」sheet 仅校验表头（PRD §六.4.1 + spec §五.1）
  const fixObj = sheetToObjects(fixSheet, ORDER_REPAIR_FIELDS, ORDER_REPAIR_SHEET_NAME);

  return {
    filePath,
    fileName: path.basename(filePath),
    sheets: {
      reconResult: reconResultObj.rows,
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

function buildMainOutputFileName(scenarioName, timestamp = buildTimestampMinute()) {
  const safeName = sanitizeFileName(scenarioName);
  return `单据对账修复-${timestamp}-${safeName}.xlsx`;
}

// PR-B Round 3（Decision 3，2026-05-09）：未匹配 report 文件名
//   默认（无 mainFileBaseName）：`单据对账修复-未匹配-YYYYMMDDHHmm-{sanitize(name)}.xlsx`
//
// PR #36 self-review round 5（P3-B，2026-05-09）：联动用户主文件名
//   传入 mainFileBaseName（用户在 saveDialog 里改过的主文件 basename，含或不含 .xlsx 扩展）
//   时输出 `{stem}-未匹配.xlsx`，stem = mainFileBaseName 去掉末尾 .xlsx（不区分大小写）；
//   mainFileBaseName 仍走 sanitizeFileName 防御危险字符。
//   旧签名 buildUnmatchedReportFileName(name, timestamp) 保持兼容（smoke 老用例不动）。
function buildUnmatchedReportFileName(scenarioName, timestamp = buildTimestampMinute(), mainFileBaseName = null) {
  if (mainFileBaseName) {
    let stem = String(mainFileBaseName);
    // 去掉末尾 .xlsx（不区分大小写）
    stem = stem.replace(/\.xlsx$/i, '');
    const safeStem = sanitizeFileName(stem);
    return `${safeStem}-未匹配.xlsx`;
  }
  const safeName = sanitizeFileName(scenarioName);
  return `单据对账修复-未匹配-${timestamp}-${safeName}.xlsx`;
}

// ===== writeReconIdFixOutput =====
// 单 sheet「订单修复」+ 表头 = ORDER_REPAIR_FIELDS（15 列）+ 表头字号 10pt
// fixedRows 每行 = { BillDate, Bank, MerchantId, ..., SubBizType }
async function writeReconIdFixOutput({ fixedRows, savePath }) {
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

  // 构造 aoa：第 0 行是表头，后面是数据行
  const aoa = [ORDER_REPAIR_FIELDS.slice()];
  for (const row of fixedRows) {
    aoa.push(ORDER_REPAIR_FIELDS.map((col) => {
      const v = row[col];
      if (v === null || v === undefined) return '';
      return v;
    }));
  }
  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  applyHeaderRowFont(ws);

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, ORDER_REPAIR_SHEET_NAME);
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
  ORDER_REPAIR_SHEET_NAME
};
