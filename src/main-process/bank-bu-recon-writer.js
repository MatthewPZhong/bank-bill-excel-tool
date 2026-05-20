// v2.1.2 T2 — 月度银行对账单BU回填校验：差异表 writer
// 用 exceljs（项目已含 dep；spec §3.7 决策，复用 src/main-process/exceljs-writer.js 黄底范式）
// 3-sheet 输出：Pending（20 列）+ 银行对账单（44 列）+ 异常（5 列，v0.8 新增 N:M 异常组）
// BU 差异行整行黄底（FFFFFF00）
// 文件名：月度银行对账单BU回填校验_{YYYYMM}_{HHMMSS}.xlsx

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { applyWatermark } = require('./workbook-watermark');

const {
  PENDING_GUANLI_HEADERS,
  PENDING_GUANLI_DB_COLUMNS,
  BANK_HEADERS,
  BANK_DB_COLUMNS,
  DIFF_OUTPUT_PENDING_SHEET,
  DIFF_OUTPUT_BANK_SHEET
} = require('../backend/bank-bu-recon-db/columns');

// v0.8 新增：第 3 个「异常」sheet 表头（OPEN ISSUE #10 重新拍板 Q2=C）
const DIFF_OUTPUT_ANOMALY_SHEET = '异常';
const ANOMALY_HEADERS = ['对账单号', 'Pending 匹配数量', '银行匹配数量', 'Pending 行号', '银行对账单行号'];
const ANOMALY_HEADERS_AGGREGATE = ['对账月份', ...ANOMALY_HEADERS];

function anomalyRowToArray(a) {
  return [
    a.key,
    a.pendingCount,
    a.bankCount,
    (a.pendingRowIndices || []).join(', '),
    (a.bankRowIndices || []).join(', ')
  ];
}

const YELLOW_FILL = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFF00' }
};

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function buildOutputPath(storageRoot, yearMonth) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const dir = path.join(storageRoot, 'exports', dateStr);
  fs.mkdirSync(dir, { recursive: true });
  const yyyymm = yearMonth.replace('-', '');
  const fileName = `月度银行对账单BU回填校验_${yyyymm}_${formatTimestamp()}.xlsx`;
  return path.join(dir, fileName);
}

function rowDbObjectToArray(row, dbColumns) {
  return dbColumns.map((col) => row[col] ?? '');
}

async function writeDiffWorkbook({
  storageRoot,
  yearMonth,
  matchedPending,
  matchedBank,
  buDiffPendingIds,
  buDiffBankIds,
  nmAnomalies = [],   // v0.8: N:M 异常组写入第 3 个 sheet
  // v0.5: 用户另存为路径优先于默认 buildOutputPath
  overrideSavePath = null
}) {
  const savePath = overrideSavePath || buildOutputPath(storageRoot, yearMonth);
  const workbook = new ExcelJS.Workbook();

  // Sheet 1: Pending（20 列）
  const pendingSheet = workbook.addWorksheet(DIFF_OUTPUT_PENDING_SHEET);
  pendingSheet.addRow(PENDING_GUANLI_HEADERS.slice());
  pendingSheet.getRow(1).font = { bold: true, size: 10 };

  matchedPending.forEach((row) => {
    const dataRow = pendingSheet.addRow(rowDbObjectToArray(row, PENDING_GUANLI_DB_COLUMNS));
    if (buDiffPendingIds && buDiffPendingIds.has(row.id)) {
      dataRow.eachCell((cell) => {
        cell.fill = YELLOW_FILL;
      });
    }
  });

  // Sheet 2: 银行对账单（44 列）
  const bankSheet = workbook.addWorksheet(DIFF_OUTPUT_BANK_SHEET);
  bankSheet.addRow(BANK_HEADERS.slice());
  bankSheet.getRow(1).font = { bold: true, size: 10 };

  matchedBank.forEach((row) => {
    const dataRow = bankSheet.addRow(rowDbObjectToArray(row, BANK_DB_COLUMNS));
    if (buDiffBankIds && buDiffBankIds.has(row.id)) {
      dataRow.eachCell((cell) => {
        cell.fill = YELLOW_FILL;
      });
    }
  });

  // Sheet 3: 异常（v0.8 新增 — N:M 异常组）
  // 即使 nmAnomalies 为空也生成此 sheet（仅表头），保持输出一致性
  const anomalySheet = workbook.addWorksheet(DIFF_OUTPUT_ANOMALY_SHEET);
  anomalySheet.addRow(ANOMALY_HEADERS.slice());
  anomalySheet.getRow(1).font = { bold: true, size: 10 };
  (nmAnomalies || []).forEach((a) => {
    anomalySheet.addRow(anomalyRowToArray(a));
  });

  applyWatermark(workbook);
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

// v0.5 新增：跨月汇总差异表 writer
// 单 xlsx + 3 sheet（Pending / 银行对账单 / 异常 v0.8）
// matchedMonths 形态：[{yearMonth, matchedPending, matchedBank, buDiffPendingIds, buDiffBankIds, nmAnomalies}]
async function writeAggregateDiffWorkbook({ matchedMonths, savePath }) {
  const workbook = new ExcelJS.Workbook();

  // Sheet 1: Pending — 表头 = ['对账月份', ...PENDING_GUANLI_HEADERS]
  const pendingSheet = workbook.addWorksheet(DIFF_OUTPUT_PENDING_SHEET);
  pendingSheet.addRow(['对账月份', ...PENDING_GUANLI_HEADERS]);
  pendingSheet.getRow(1).font = { bold: true, size: 10 };

  for (const m of matchedMonths) {
    for (const row of m.matchedPending) {
      const dataRow = pendingSheet.addRow([m.yearMonth, ...rowDbObjectToArray(row, PENDING_GUANLI_DB_COLUMNS)]);
      if (m.buDiffPendingIds && m.buDiffPendingIds.has(row.id)) {
        dataRow.eachCell((cell) => { cell.fill = YELLOW_FILL; });
      }
    }
  }

  // Sheet 2: 银行对账单 — 表头 = ['对账月份', ...BANK_HEADERS]
  const bankSheet = workbook.addWorksheet(DIFF_OUTPUT_BANK_SHEET);
  bankSheet.addRow(['对账月份', ...BANK_HEADERS]);
  bankSheet.getRow(1).font = { bold: true, size: 10 };

  for (const m of matchedMonths) {
    for (const row of m.matchedBank) {
      const dataRow = bankSheet.addRow([m.yearMonth, ...rowDbObjectToArray(row, BANK_DB_COLUMNS)]);
      if (m.buDiffBankIds && m.buDiffBankIds.has(row.id)) {
        dataRow.eachCell((cell) => { cell.fill = YELLOW_FILL; });
      }
    }
  }

  // Sheet 3: 异常（v0.8 新增）— 跨月 N:M 异常合并
  const anomalySheet = workbook.addWorksheet(DIFF_OUTPUT_ANOMALY_SHEET);
  anomalySheet.addRow(ANOMALY_HEADERS_AGGREGATE.slice());
  anomalySheet.getRow(1).font = { bold: true, size: 10 };
  for (const m of matchedMonths) {
    (m.nmAnomalies || []).forEach((a) => {
      anomalySheet.addRow([m.yearMonth, ...anomalyRowToArray(a)]);
    });
  }

  applyWatermark(workbook);
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}

module.exports = {
  writeDiffWorkbook,
  writeAggregateDiffWorkbook,
  buildOutputPath,
  YELLOW_FILL,
  DIFF_OUTPUT_ANOMALY_SHEET,
  ANOMALY_HEADERS,
  ANOMALY_HEADERS_AGGREGATE
};
