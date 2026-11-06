'use strict';

// 设置 → 账户管理：解析导入的清结算系统银行账户表（.xlsx / .xls）。
//   逐个工作表比较第 1 行表头（去首尾空格、去掉末尾空列），与当前识别结构完全一致的工作表必须恰好一个；
//   与平盘链接原始表的识别口径相同（SheetJS cellDates + raw）。单元格按显示用文本入库。

const XLSX = require('xlsx');

const { describeHeaderMismatch, normalizeHeaders } = require('../../backend/file-service/header-structure-diff');

const pad = (number) => String(number).padStart(2, '0');

function dateText(value) {
  if (Number.isNaN(value.getTime())) return '';
  const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  if (!value.getHours() && !value.getMinutes() && !value.getSeconds()) return day;
  return `${day} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

// 字符串去首尾空格；数值转字符串；日期按本地时间；布尔为 TRUE / FALSE。
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dateText(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(Object.is(value, -0) ? 0 : value);
  }
  return String(value).trim();
}

// 按列字母取值，保留物理行号（跳过空行后行号仍对应 Excel）。
function sheetRows(sheet) {
  const records = XLSX.utils.sheet_to_json(sheet, { header: 'A', defval: '', raw: true, blankrows: false });
  return records.map((record) => {
    const values = [];
    for (const [columnName, value] of Object.entries(record)) {
      values[XLSX.utils.decode_col(columnName)] = value;
    }
    return { values, rowIndex: Number.isSafeInteger(record.__rowNum__) ? record.__rowNum__ : null };
  });
}

function headersEqual(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function failure(message, detailLines = []) {
  return { ok: false, message, detailLines };
}

// expectedHeaders：当前识别结构的表头；structureName / versionLabel 用于差异明细；channelHeader 为渠道列名。
function parseBankAccountWorkbook(bytes, { fileName, expectedHeaders, structureName, versionLabel = '', channelHeader }) {
  let workbook;
  try {
    workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true, raw: true });
  } catch (error) {
    return failure(`无法读取 Excel：${fileName}`, [error && error.message ? error.message : String(error)]);
  }
  const sheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
  if (!sheetNames.length) return failure(`文件中没有工作表：${fileName}`);

  const sheets = [];
  const matches = [];
  for (const name of sheetNames) {
    const rows = sheetRows(workbook.Sheets[name]);
    const headers = normalizeHeaders(rows.length && rows[0].rowIndex === 0 ? rows[0].values : []);
    sheets.push({ name, headers });
    if (headersEqual(headers, expectedHeaders)) matches.push({ name, rows });
  }
  if (!matches.length) {
    return failure(
      `无法识别为清结算银行账户表：${fileName}`,
      describeHeaderMismatch({ sheets, candidates: [{ name: structureName, headers: expectedHeaders, versionLabel }] })
    );
  }
  if (matches.length > 1) {
    return failure(
      `文件中有 ${matches.length} 个工作表与清结算银行账户表结构一致，无法确定使用哪一个：${fileName}`,
      matches.map((match) => `工作表「${match.name}」`)
    );
  }

  const [match] = matches;
  const channelIndex = expectedHeaders.indexOf(channelHeader);
  const rows = [];
  for (const row of match.rows.slice(1)) {
    const values = expectedHeaders.map((_header, index) => cellText(row.values[index]));
    if (values.every((value) => value === '')) continue;
    rows.push({
      excelRowNumber: row.rowIndex === null ? rows.length + 2 : row.rowIndex + 1,
      channel: channelIndex >= 0 ? values[channelIndex] : '',
      values
    });
  }
  return { ok: true, sheetName: match.name, rows };
}

module.exports = {
  cellText,
  parseBankAccountWorkbook
};
