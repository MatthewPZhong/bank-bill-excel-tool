'use strict';

const { SUPPORTED_CURRENCIES } = require('./definitions');

const ADJUSTMENT_LINEAGE_NAME_PREFIX = 'VCC_ADJUSTMENT_V1_';
const MAX_EXCEL_DEFINED_NAME_LENGTH = 255;
const SAFE_EXCEL_DEFINED_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROW_KEY_PATTERN = /^v1:([a-f0-9]{64})$/;
const LINEAGE_NAME_PATTERN = /^VCC_ADJUSTMENT_V1_([a-f0-9]{64})_([A-Z]{3})$/;

function encodeAdjustmentLineageName(rowKey, currency) {
  const rowKeyMatch = ROW_KEY_PATTERN.exec(String(rowKey || ''));
  if (!rowKeyMatch) throw new Error(`调整 rowKey 非法：${String(rowKey || '')}`);
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw new Error(`调整币种非法：${String(currency || '')}`);
  const name = `${ADJUSTMENT_LINEAGE_NAME_PREFIX}${rowKeyMatch[1]}_${currency}`;
  if (name.length > MAX_EXCEL_DEFINED_NAME_LENGTH
      || !SAFE_EXCEL_DEFINED_NAME_PATTERN.test(name)
      || /^[A-Za-z]{1,3}\d+$/.test(name)) {
    throw new Error('调整血缘名称不符合 Excel defined name 白名单');
  }
  return name;
}

function parseAdjustmentLineageName(name) {
  const token = String(name || '');
  if (token.length > MAX_EXCEL_DEFINED_NAME_LENGTH
      || !SAFE_EXCEL_DEFINED_NAME_PATTERN.test(token)) return null;
  const match = LINEAGE_NAME_PATTERN.exec(token);
  if (!match || !SUPPORTED_CURRENCIES.includes(match[2])) return null;
  return { rowKey: `v1:${match[1]}`, currency: match[2] };
}

module.exports = {
  ADJUSTMENT_LINEAGE_NAME_PREFIX,
  MAX_EXCEL_DEFINED_NAME_LENGTH,
  SAFE_EXCEL_DEFINED_NAME_PATTERN,
  ROW_KEY_PATTERN,
  encodeAdjustmentLineageName,
  parseAdjustmentLineageName
};
