// v2.0.0-beta.3 PR #32a：银行对账单处理模块的 IO 层
// PRD §7.5 / spec.md F3
//
// 职责：
//   readBankStatement(filePath)         — 读「渠道对账单」sheet（44 列校验 + _rowId 注入）
//   readGatewayRecon(filePath)          — 读「网关账单」sheet（31 列校验）
//   writeBankStatementMainOutput(...)   — 调 exceljs-writer 写主输出（含标黄）+ 文件名规则
//   writeErrorReportOutput(...)         — 调 exceljs-writer 写 error-report
//
// 读取仍用 SheetJS（复用现有 readers.js 的 parser）；写出用 exceljs（标黄能力）。

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const { FileValidationError } = require('../backend/file-service/common');
const { BANK_STATEMENT_FIELDS } = require('../constants/bank-statement-fields');
const { GATEWAY_RECON_FIELDS } = require('../constants/gateway-recon-fields');
const {
  writeBankStatementOutput,
  writeErrorReport
} = require('./exceljs-writer');

const BANK_STATEMENT_SHEET_NAME = '渠道对账单';
const GATEWAY_RECON_SHEET_NAME = '网关账单';

// 把 sheet 转换成对象数组（用 header 数组当 key）
function sheetToObjects(sheet, expectedHeaders) {
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  if (!aoa.length) {
    return { headers: [], rows: [] };
  }
  const actualHeaders = aoa[0].map((h) => (h === undefined || h === null ? '' : String(h)));
  // 列校验：必须与 expectedHeaders 完全一致（顺序 + 长度）
  if (actualHeaders.length !== expectedHeaders.length) {
    throw new FileValidationError(
      'invalid-column-count',
      `表头列数不符：期望 ${expectedHeaders.length} 列，实际 ${actualHeaders.length} 列`,
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
      `表头列名不符（${mismatched.length} 处）`,
      { detailLines: mismatched }
    );
  }

  const rows = aoa.slice(1).map((rowArr) => {
    const obj = {};
    expectedHeaders.forEach((h, idx) => {
      obj[h] = rowArr[idx] ?? '';
    });
    return obj;
  });

  return { headers: expectedHeaders.slice(), rows };
}

// ===== readBankStatement =====
function readBankStatement(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new FileValidationError('file-not-found', `文件不存在：${filePath}`);
  }
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[BANK_STATEMENT_SHEET_NAME];
  if (!sheet) {
    throw new FileValidationError(
      'missing-sheet',
      `银行对账单文件缺少 sheet「${BANK_STATEMENT_SHEET_NAME}」`,
      { detailLines: [`实际 sheets：${wb.SheetNames.join(' / ')}`] }
    );
  }
  const { headers, rows } = sheetToObjects(sheet, BANK_STATEMENT_FIELDS);
  // 注入 _rowId（与 PR #31 ensureRowId 兼容）
  rows.forEach((r, idx) => {
    r._rowId = `row_${idx}`;
  });
  return {
    filePath,
    fileName: path.basename(filePath),
    rows,
    headers,
    rowCount: rows.length
  };
}

// ===== readGatewayRecon =====
function readGatewayRecon(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new FileValidationError('file-not-found', `文件不存在：${filePath}`);
  }
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[GATEWAY_RECON_SHEET_NAME];
  if (!sheet) {
    throw new FileValidationError(
      'missing-sheet',
      `资金对账文件缺少 sheet「${GATEWAY_RECON_SHEET_NAME}」`,
      { detailLines: [`实际 sheets：${wb.SheetNames.join(' / ')}`] }
    );
  }
  const { rows } = sheetToObjects(sheet, GATEWAY_RECON_FIELDS);
  return {
    filePath,
    fileName: path.basename(filePath),
    gwRows: rows,
    rowCount: rows.length
  };
}

// ===== 文件名规则 =====
function buildTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds())
  ].join('');
}

function buildDateDir() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sanitizeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

// 主输出文件名：YYYYMMDDhhmmss-<场景名>.xlsx 或 YYYYMMDDhhmmss-多场景.xlsx
function buildMainOutputFileName(modifiedRows, timestamp = buildTimestamp()) {
  const hitNames = new Set();
  modifiedRows.forEach((r) => {
    if (r._hitScenarioName) hitNames.add(r._hitScenarioName);
  });
  if (hitNames.size === 0) {
    return `${timestamp}-空命中.xlsx`;
  }
  if (hitNames.size === 1) {
    const onlyName = sanitizeFileName(Array.from(hitNames)[0]);
    return `${timestamp}-${onlyName}.xlsx`;
  }
  return `${timestamp}-多场景.xlsx`;
}

function ensureDateDir(exportRootDir) {
  const dir = path.join(exportRootDir, buildDateDir());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ===== writeBankStatementMainOutput =====
async function writeBankStatementMainOutput({ modifiedRows, headers, exportRootDir, timestamp }) {
  if (!Array.isArray(modifiedRows)) {
    throw new Error('writeBankStatementMainOutput: modifiedRows 必须是数组');
  }
  const ts = timestamp ?? buildTimestamp();
  const dir = ensureDateDir(exportRootDir);
  const fileName = buildMainOutputFileName(modifiedRows, ts);
  const savePath = path.join(dir, fileName);
  const result = await writeBankStatementOutput(modifiedRows, headers, savePath);
  return { ...result, fileName };
}

// ===== writeErrorReportOutput =====
async function writeErrorReportOutput({ warnings, exportRootDir, timestamp }) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  const ts = timestamp ?? buildTimestamp();
  const dir = ensureDateDir(exportRootDir);
  const fileName = `${ts}-error-report.xlsx`;
  const savePath = path.join(dir, fileName);
  const result = await writeErrorReport(warnings, savePath);
  return { ...result, fileName };
}

module.exports = {
  BANK_STATEMENT_SHEET_NAME,
  GATEWAY_RECON_SHEET_NAME,
  readBankStatement,
  readGatewayRecon,
  writeBankStatementMainOutput,
  writeErrorReportOutput,
  buildMainOutputFileName,
  buildTimestamp,
  buildDateDir,
  sanitizeFileName
};
