const fs = require('node:fs');
const path = require('node:path');
const { normalizeCell } = require('./file-service/common');
const { sumAmounts } = require('./file-service/normalizers');

function sanitizeBankName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .trim() || 'unknown-bank';
}

function getBalanceAdjustmentFilePath(storageRoot, bankName) {
  return path.join(storageRoot, 'balance-adjustments', `${sanitizeBankName(bankName)}.json`);
}

function normalizeEffectiveDate(dateString) {
  const trimmed = normalizeCell(dateString);
  const match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return trimmed;
  return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
}

function parseNumericValue(value) {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (normalized === '') return null;
  const num = Number(normalized);
  return isNaN(num) ? null : num;
}

function readBalanceAdjustments(storageRoot, bankName) {
  const filePath = getBalanceAdjustmentFilePath(storageRoot, bankName);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((record) => ({
        merchantId: normalizeCell(record.merchantId),
        currency: normalizeCell(record.currency),
        effectiveDate: normalizeCell(record.effectiveDate),
        adjustmentValue: parseNumericValue(record.adjustmentValue),
        remark: normalizeCell(record.remark),
        templateName: normalizeCell(record.templateName),
        updatedAt: normalizeCell(record.updatedAt)
      }))
      .filter((record) =>
        record.merchantId !== '' &&
        record.effectiveDate !== '' &&
        record.adjustmentValue !== null
      );
  } catch (_error) {
    return [];
  }
}

function writeBalanceAdjustments(storageRoot, bankName, records) {
  const filePath = getBalanceAdjustmentFilePath(storageRoot, bankName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const normalizedRecords = records.map((record) => ({
    merchantId: normalizeCell(record.merchantId),
    currency: normalizeCell(record.currency),
    effectiveDate: normalizeEffectiveDate(record.effectiveDate),
    adjustmentValue: record.adjustmentValue,
    remark: normalizeCell(record.remark),
    templateName: normalizeCell(record.templateName),
    updatedAt: new Date().toISOString()
  }));

  fs.writeFileSync(filePath, `${JSON.stringify(normalizedRecords, null, 2)}\n`, 'utf8');
}

// 截至当日的附加值累计额；按各值小数位求和，避免多条附加值累加出浮点尾差（v3.2.17 D2）。
function resolveBalanceAdjustment(adjustments, { merchantId, currency, dateLabel }) {
  return sumAmounts(adjustments
    .filter((record) =>
      record.merchantId === merchantId &&
      record.currency === currency &&
      record.effectiveDate <= dateLabel
    )
    .map((record) => record.adjustmentValue || 0));
}

module.exports = {
  readBalanceAdjustments,
  writeBalanceAdjustments,
  resolveBalanceAdjustment
};
