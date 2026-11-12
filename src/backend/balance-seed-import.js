'use strict';

// v3.2.17：补录余额「导入余额文件」——解析余额文件并按待补录账号提取上一账单日余额。
//   只读：readBalanceSeedImportFile 读文件，解析与匹配为纯函数；写种子仍走现有人工补录链路（逐个账号）。
//   文件按表头列名识别：银行账号、币种、账单日期、期末余额（与本工具导出的余额账单同名，其他列忽略）。
//   期末余额按人工补录原值使用：本工具导出的余额已含余额附加值，用户已知并接受（spec D2）。

const XLSX = require('xlsx');
const {
  FileValidationError,
  normalizeCell,
  parseDateValue,
  parseNumericValue,
  readRows
} = require('./file-service');
const { roundAmount } = require('./file-service/normalizers');

const BALANCE_IMPORT_COLUMNS = Object.freeze({
  merchantId: '银行账号',
  currency: '币种',
  billDate: '账单日期',
  endBalance: '期末余额'
});
const REQUIRED_HEADERS = Object.freeze(Object.values(BALANCE_IMPORT_COLUMNS));
const HEADER_SCAN_ROW_LIMIT = 10;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateLabel(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeCurrency(value) {
  return normalizeCell(value).toUpperCase();
}

// 银行账号存成 Excel 数字时，原值不一定等于用户看到的账号，按无效行跳过、让该账号落到手工录入（不错配）：
//   - Excel 数字只保留 15 位有效数字，达到 16 位（或带小数、超出安全整数）的已被截断，截断后的文本可能等于另一个账号；
//   - 数字格式会改变显示（如 000000 把 123 显示为 000123），原值去掉了前导 0，可能等于另一个账号。
//   因此只有显示文本与原值完全一致时才采用；拿不到显示文本（displayValue 为 undefined）时一律不采用。
const EXCEL_EXACT_INTEGER_LIMIT = 1e15;

function normalizeAccountCell(value, displayValue) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Math.abs(value) >= EXCEL_EXACT_INTEGER_LIMIT) return '';
    const text = String(value);
    if (displayValue === undefined || normalizeCell(displayValue) !== text) return '';
    return text;
  }
  return normalizeCell(value);
}

// 读余额文件：rows 为 readRows 的原值（与账单导入同一读取口径）；另取同一工作表的显示文本
//   （仅用于核对数字型银行账号）与工作簿日期系统（1904 / 1900，用于换算序列号形式的账单日期）。
//   CSV 等没有工作簿元数据、或读取失败时 date1904 为 null（日期系统未知），序列号形式的账单日期随之不采用；
//   读取失败时 displayRows 也为 null，数字型账号随之不采用。
function readBalanceSeedImportFile(filePath) {
  const rows = readRows(filePath);
  let displayRows = null;
  let date1904 = null;
  try {
    const workbook = XLSX.readFile(filePath, { cellDates: false, dense: true, raw: false });
    const workbookProps = workbook.Workbook && workbook.Workbook.WBProps;
    date1904 = workbookProps ? Boolean(workbookProps.date1904) : null;
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : null;
    const candidate = sheet
      ? XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '', raw: false })
      : null;
    displayRows = Array.isArray(candidate) && candidate.length === rows.length ? candidate : null;
  } catch (_error) {
    displayRows = null;
    date1904 = null;
  }
  return { rows, displayRows, date1904 };
}

// 账单日期按共享日期解析口径（parseDateValue），序列号分支（数字单元格，或去掉时间后缀后的纯数字文本）
//   按工作簿日期系统换算：date1904 为 null（日期系统未知，如 CSV）时序列号形式的日期不采用。
function parseBillDateCell(value, date1904) {
  const excelDateSystem = date1904 === null ? 'unknown' : (date1904 ? '1904' : '1900');
  return parseDateValue(value, { excelDateSystem });
}

function findHeaderRow(rows) {
  const limit = Math.min(rows.length, HEADER_SCAN_ROW_LIMIT);
  let bestMissing = REQUIRED_HEADERS;
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const cells = Array.isArray(rows[rowIndex]) ? rows[rowIndex].map((cell) => normalizeCell(cell)) : [];
    const missing = REQUIRED_HEADERS.filter((header) => !cells.includes(header));
    if (!missing.length) {
      return {
        rowIndex,
        indexes: Object.fromEntries(Object.entries(BALANCE_IMPORT_COLUMNS)
          .map(([key, header]) => [key, cells.indexOf(header)]))
      };
    }
    if (missing.length < bestMissing.length) bestMissing = missing;
  }
  throw new FileValidationError(
    'BALANCE_IMPORT_HEADER_MISSING',
    `余额文件缺少列：${bestMissing.join('、')}`,
    { detailLines: [`余额文件前 ${HEADER_SCAN_ROW_LIMIT} 行里需要有一行表头同时包含：${REQUIRED_HEADERS.join('、')}`] }
  );
}

/**
 * 解析余额文件的行（readRows 结果）。displayRows 为同一工作表的显示文本（readBalanceSeedImportFile），
 * 只用于核对数字型银行账号，不传时数字型账号一律跳过；date1904 为工作簿日期系统，
 * 不传按 1900 系统，传 null（未知，如 CSV）时序列号形式（数字或纯数字文本）的账单日期一律跳过。
 * @returns {{ records: Array<{merchantId, currency, billDate, endBalance, rowNumber}>, skippedRowCount: number }}
 */
function parseBalanceSeedImportRows(rows, { displayRows = null, date1904 = false } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeDisplayRows = Array.isArray(displayRows) && displayRows.length === safeRows.length ? displayRows : null;
  const { rowIndex: headerRowIndex, indexes } = findHeaderRow(safeRows);
  const records = [];
  let skippedRowCount = 0;
  safeRows.slice(headerRowIndex + 1).forEach((row, offset) => {
    const cells = Array.isArray(row) ? row : [];
    const raw = Object.fromEntries(Object.entries(indexes).map(([key, index]) => [key, cells[index]]));
    if (Object.values(raw).every((value) => normalizeCell(value) === '')) return;
    const displayCells = safeDisplayRows ? safeDisplayRows[headerRowIndex + 1 + offset] : null;
    const accountDisplay = Array.isArray(displayCells) ? displayCells[indexes.merchantId] : undefined;
    const merchantId = normalizeAccountCell(raw.merchantId, accountDisplay);
    const parsedDate = parseBillDateCell(raw.billDate, date1904);
    const endBalance = parseNumericValue(raw.endBalance);
    if (!merchantId || !parsedDate || endBalance === null) {
      skippedRowCount += 1;
      return;
    }
    records.push({
      merchantId,
      currency: normalizeCurrency(raw.currency),
      billDate: formatDateLabel(parsedDate),
      endBalance,
      rowNumber: headerRowIndex + offset + 2
    });
  });
  return { records, skippedRowCount };
}

function manualAccount(account, reason) {
  return { ...account, billDate: '', endBalance: null, source: 'manual', reason };
}

/**
 * 按待补录账号（银行账号 + 币种）取早于当前账单日期的最近一天的期末余额。
 *   - 该日只有一个余额（按分去重）→ source='file'
 *   - 该日有多个不同余额，或没有早于当前账单日期的余额 → source='manual'，附原因，由用户手工录入
 * 账号按文本精确匹配（去首尾空格）；币种不区分大小写。
 */
function matchBalanceSeedImport(records, pendingAccounts) {
  const safeRecords = Array.isArray(records) ? records : [];
  const accounts = (Array.isArray(pendingAccounts) ? pendingAccounts : []).map((pending) => {
    const account = {
      merchantId: normalizeCell(pending && pending.merchantId),
      currency: normalizeCell(pending && pending.currency),
      targetBillDate: normalizeCell(pending && pending.targetBillDate)
    };
    const currencyKey = normalizeCurrency(account.currency);
    const sameAccount = safeRecords.filter((record) => (
      record.merchantId === account.merchantId && record.currency === currencyKey
    ));
    if (!sameAccount.length) {
      return manualAccount(account, '文件中没有该账号');
    }
    const candidates = sameAccount.filter((record) => (
      !account.targetBillDate || record.billDate < account.targetBillDate
    ));
    if (!candidates.length) {
      return manualAccount(account, `文件中没有该账号早于 ${account.targetBillDate} 的余额`);
    }
    const latestDate = candidates.reduce((latest, record) => (record.billDate > latest ? record.billDate : latest), '');
    const sameDay = candidates.filter((record) => record.billDate === latestDate);
    const distinctAmounts = new Set(sameDay.map((record) => roundAmount(record.endBalance)));
    if (distinctAmounts.size > 1) {
      return manualAccount(account, `文件中 ${latestDate} 有多个不同余额`);
    }
    return {
      ...account,
      billDate: latestDate,
      endBalance: sameDay[0].endBalance,
      source: 'file',
      reason: ''
    };
  });
  const matchedCount = accounts.filter((account) => account.source === 'file').length;
  return {
    accounts,
    matchedCount,
    manualCount: accounts.length - matchedCount
  };
}

module.exports = {
  BALANCE_IMPORT_COLUMNS,
  matchBalanceSeedImport,
  parseBalanceSeedImportRows,
  readBalanceSeedImportFile
};
