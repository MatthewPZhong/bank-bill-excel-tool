'use strict';

const { BIZ_OP_HEADERS, FLOW_HEADERS } = require('../../backend/biz-op-recon-db/columns');
const { classifyExcelNumberFormat } = require('../../backend/toolbox-format/number-date');
const { canonicalizeDecimal, addCanonicalDecimals, subtractCanonicalDecimals,
  compareCanonicalDecimals, absoluteDecimal } = require('../financial-decimal');

const CELL_CONTRACT_VERSION = 'bizop-cell-v1-e01-e03';
const RULE_VERSION = 'bizop-interval-v1';
const OP_COLUMNS = Object.freeze(['billdate', 'bu_name', 'customer_no', 'entity', 'account_no', 'account_type',
  'currency', 'begin_balance', 'amount', 'amount_in', 'amount_out', 'end_balance']);
const FLOW_COLUMNS = Object.freeze(['bill_date', 'bu_dept', 'company_entity', 'account_no', 'account_type',
  'currency', 'direction', 'recon_amount', 'flow_no']);
const FLOW_PROJECTION = Object.freeze([1, 6, 4, 11, 15, 14, 8, 13, 9]);

function reject(message) { const error = new Error(message); error.code = 'BIZOP_CELL_INVALID'; throw error; }
function cellText(cell) {
  if (!cell || cell.cellType === 'blank') return '';
  return String(['number', 'date'].includes(cell.cellType) ? cell.rawLexicalValue : cell.decodedSemanticValue ?? '').trim();
}
function accountText(cell, required = true) {
  if (!cell || cell.cellType === 'blank' || cellText(cell) === '') {
    if (required) reject('账户不能为空');
    return '';
  }
  if (cell.cellType === 'text') return cellText(cell);
  if (cell.cellType !== 'number') reject('账户必须是文本或可信整数');
  const token = canonicalizeDecimal(cell.rawLexicalValue);
  if (!/^\d{1,15}$/.test(token)) reject('数值账户只接受不超过 15 位的非负整数；长账户请使用文本');
  const format = cell.sourceFormat || 'General';
  if (format === 'General' || format === '@') return token;
  if (/^0+$/.test(format)) return token.padStart(format.length, '0');
  reject('数值账户包含复杂显示格式，无法确定真实身份');
}
function amountText(cell) {
  if (!cell || !['number', 'text'].includes(cell.cellType)) reject('金额必须是有效十进制数');
  return canonicalizeDecimal(cell.cellType === 'number' ? cell.rawLexicalValue : cell.decodedSemanticValue);
}
function dateText(cell) {
  if (!cell) reject('账期不能为空');
  if (cell.cellType === 'number') {
    if (!classifyExcelNumberFormat(cell.sourceFormat || 'General').isDateLike) reject('数值账期必须有明确日期格式，不能猜测普通数字');
    const token = canonicalizeDecimal(cell.rawLexicalValue);
    if (!/^\d{1,7}(?:\.\d+)?$/.test(token)) reject('Excel 日期序号无效');
    const day = Number(token.split('.')[0]);
    const date1904 = cell.sourceDateSystem === 1904;
    if ((!date1904 && day < 1) || (!date1904 && day === 60) || day > (date1904 ? 2957003 : 2958465)) {
      reject('Excel 日期越界或属于虚构的 1900-02-29');
    }
    return new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31)
      + (day - (!date1904 && day > 60 ? 1 : 0)) * 86400000).toISOString().slice(0, 10);
  }
  if (!['text', 'date'].includes(cell.cellType)) reject('账期类型无效');
  const text = cellText(cell);
  const token = /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
  const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/.exec(token);
  if (!match) reject('日期须为年在前的明确日期，不接受歧义日期或时区');
  const year = Number(match[1]); const month = Number(match[3]); const day = Number(match[4]);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day
      || Number(match[5] || 0) > 23 || Number(match[6] || 0) > 59 || Number(match[7] || 0) > 59) reject('日期不存在或时间越界');
  return value.toISOString().slice(0, 10);
}
function structuralErrors(row, width) {
  const errors = [];
  for (const cell of row.cells) {
    if (cell.hasFormula) errors.push(`第 ${cell.columnIndex + 1} 列含公式，请提供原始值`);
    if (cell.cellType === 'error') errors.push(`第 ${cell.columnIndex + 1} 列含 Excel 错误值`);
    if (cell.columnIndex >= width && (cell.hasFormula || cellText(cell) !== '')) errors.push(`第 ${cell.columnIndex + 1} 列超出原表模板`);
  }
  return errors;
}
function detectHeader(row) {
  if (row.rowIndex !== 1) reject('表头必须位于第一行');
  const cells = new Map(row.cells.map((cell) => [cell.columnIndex, cell]));
  for (const [kind, headers] of [['OP', BIZ_OP_HEADERS], ['FLOW', FLOW_HEADERS]]) {
    if (!structuralErrors(row, headers.length).length && headers.every((header, index) => cellText(cells.get(index)) === header)) return kind;
  }
  reject('表头必须完整匹配 OP 23 列或流水 28 列原表，不能回导生成表');
}
function createImportAdapter(kind) {
  if (!['OP', 'FLOW'].includes(kind)) throw new TypeError('未知导入类型');
  const headers = kind === 'OP' ? BIZ_OP_HEADERS : FLOW_HEADERS;
  let firstBu = null;
  let firstDate = null;
  return Object.freeze({
    adapt(row) {
      const errors = structuralErrors(row, headers.length);
      const cells = new Map(row.cells.map((cell) => [cell.columnIndex, cell]));
      if (!errors.length && row.cells.every((cell) => cellText(cell) === '')) return { blank: true };
      const values = headers.map((_, index) => cellText(cells.get(index)));
      const normalize = (index, parser, optional = false) => {
        try { if (!optional || values[index] !== '') values[index] = parser(cells.get(index)); }
        catch (error) { errors.push(`${headers[index]}：${error.message}`); }
      };
      const dateIndex = kind === 'OP' ? 0 : 1;
      const buIndex = kind === 'OP' ? 1 : 6;
      const accountIndex = kind === 'OP' ? 4 : 11;
      const currencyIndex = kind === 'OP' ? 6 : 14;
      normalize(dateIndex, dateText);
      normalize(accountIndex, accountText);
      // 投影外的日期/金额也按相同原列合同校验；空的可选描述列保持为空。
      for (const index of (kind === 'OP' ? [14, 21, 22] : [16, 17, 20, 26, 27])) normalize(index, dateText, true);
      for (const index of (kind === 'OP' ? [7, 8, 9, 10, 11] : [13])) normalize(index, amountText);
      if (kind === 'OP') for (const index of [12, 13]) normalize(index, amountText, true);
      const bu = values[buIndex].toLowerCase();
      if (!bu || !['text', 'number'].includes(cells.get(buIndex)?.cellType)) errors.push('业务方 / 业务部门不能为空且须为文本或编号');
      values[currencyIndex] = values[currencyIndex].toUpperCase();
      if (!values[currencyIndex] || cells.get(currencyIndex)?.cellType !== 'text') errors.push('币种必须是非空文本');
      if (bu) {
        if (firstBu !== null && firstBu !== bu) errors.push('一个输入文件只能包含一个 BU');
        else firstBu = bu;
      }
      const dataDate = /^\d{4}-\d{2}-\d{2}$/.test(values[dateIndex]) ? values[dateIndex] : null;
      if (kind === 'OP' && dataDate) {
        if (firstDate !== null && firstDate !== dataDate) errors.push('一个 OP 输入文件只能包含一个账期');
        else firstDate = dataDate;
      }
      if (kind === 'FLOW' && !['入', '出'].includes(values[8])) errors.push('出入方向只接受“入”或“出”');
      // 流水单号仅作来源定位，不是账户键；保留文本/原始数值词元，不扩大 E01 账户准入限制。
      if (kind === 'OP' && !errors.length) {
        const d1 = absoluteDecimal(subtractCanonicalDecimals(values[8], subtractCanonicalDecimals(values[9], values[10])));
        const d2 = absoluteDecimal(subtractCanonicalDecimals(values[11], addCanonicalDecimals(values[7], values[8])));
        if (compareCanonicalDecimals(d1, '0.01') > 0) errors.push(`发生额不等于入减出，差额 ${d1}`);
        if (compareCanonicalDecimals(d2, '0.01') > 0) errors.push(`期末不等于期初加发生额，差额 ${d2}`);
      }
      return { kind, dataDate, bu, values: kind === 'OP' ? values.slice(0, 12) : FLOW_PROJECTION.map((index) => values[index]),
        key: [bu, values[accountIndex], values[currencyIndex]], sourceRow: row.rowIndex, errors };
    }
  });
}

module.exports = { CELL_CONTRACT_VERSION, RULE_VERSION, OP_COLUMNS, FLOW_COLUMNS, detectHeader,
  createImportAdapter, cellText, accountText, amountText, dateText };
