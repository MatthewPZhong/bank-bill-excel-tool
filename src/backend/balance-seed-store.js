const fs = require('node:fs');
const path = require('node:path');
const { FileValidationError, normalizeCell, parseNumericValue } = require('./file-service');

const BALANCE_SEED_GENERATION_METHODS = Object.freeze({
  statement: '账单里的余额',
  calculated: '通过发生额计算',
  manual: '人工录入'
});

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTemplateName(templateName) {
  const [bankName, ...locationParts] = String(templateName || '').split('-');

  return {
    bankName: bankName || '',
    location: locationParts.join('-')
  };
}

function getBalanceSeedsDir(storageRoot) {
  return path.join(storageRoot, 'balance-seeds');
}

function getBalanceSeedFilePath(storageRoot, bankName) {
  const safeBankName = (sanitizeFileName(bankName) || 'unknown-bank').replace(/\s+/g, '-');
  return path.join(getBalanceSeedsDir(storageRoot), `${safeBankName}.json`);
}

function readBalanceSeedRecords(storageRoot, bankName) {
  const filePath = getBalanceSeedFilePath(storageRoot, bankName);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const rawContent = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(rawContent);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((record) => ({
        merchantId: normalizeCell(record.merchantId),
        currency: normalizeCell(record.currency),
        billDate: normalizeCell(record.billDate),
        endBalance: parseNumericValue(record.endBalance),
        templateName: normalizeCell(record.templateName),
        generationMethod: normalizeCell(record['生成方式'] || record.generationMethod) || BALANCE_SEED_GENERATION_METHODS.manual,
        updatedAt: normalizeCell(record.updatedAt)
      }))
      .filter((record) => record.merchantId !== '' && record.billDate !== '' && record.endBalance !== null);
  } catch (error) {
    throw new FileValidationError('FILE_READ', '本地余额种子文件损坏，请检查或删除后重试', {
      context: {
        balanceSeedFilePath: filePath
      },
      detailLines: [`余额种子文件：${filePath}`]
    });
  }
}

function writeBalanceSeedRecords(storageRoot, bankName, records) {
  const filePath = getBalanceSeedFilePath(storageRoot, bankName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const normalizedRecords = records
    .map((record) => ({
      merchantId: normalizeCell(record.merchantId),
      currency: normalizeCell(record.currency),
      billDate: normalizeCell(record.billDate),
      endBalance: parseNumericValue(record.endBalance),
      templateName: normalizeCell(record.templateName),
      '生成方式': normalizeCell(record.generationMethod || record['生成方式']) || BALANCE_SEED_GENERATION_METHODS.manual,
      updatedAt: normalizeCell(record.updatedAt)
    }))
    .filter((record) => record.merchantId !== '' && record.billDate !== '' && record.endBalance !== null)
    .sort((left, right) => {
      return `${left.merchantId}|${left.currency}|${left.billDate}`.localeCompare(
        `${right.merchantId}|${right.currency}|${right.billDate}`
      );
    });

  fs.writeFileSync(filePath, `${JSON.stringify(normalizedRecords, null, 2)}\n`, 'utf8');
  return filePath;
}

function findPreviousBalanceSeed(storageRoot, { bankName, merchantId, currency, beforeBillDate }) {
  const records = readBalanceSeedRecords(storageRoot, bankName)
    .filter((record) => {
      return (
        record.merchantId === normalizeCell(merchantId) &&
        record.currency === normalizeCell(currency) &&
        record.billDate < normalizeCell(beforeBillDate)
      );
    })
    .sort((left, right) => left.billDate.localeCompare(right.billDate));

  return records.length ? records[records.length - 1] : null;
}

function upsertBalanceSeedRecord(
  storageRoot,
  {
    templateName,
    merchantId,
    currency,
    billDate,
    endBalance,
    generationMethod = BALANCE_SEED_GENERATION_METHODS.manual,
    overwrite = false
  }
) {
  const bankName = splitTemplateName(templateName).bankName;
  const records = readBalanceSeedRecords(storageRoot, bankName);
  const normalizedRecord = {
    merchantId: normalizeCell(merchantId),
    currency: normalizeCell(currency),
    billDate: normalizeCell(billDate),
    endBalance: parseNumericValue(endBalance),
    templateName: normalizeCell(templateName),
    generationMethod: normalizeCell(generationMethod) || BALANCE_SEED_GENERATION_METHODS.manual,
    updatedAt: new Date().toISOString()
  };
  const existingIndex = records.findIndex((record) => {
    return (
      record.merchantId === normalizedRecord.merchantId &&
      record.currency === normalizedRecord.currency &&
      record.billDate === normalizedRecord.billDate
    );
  });

  if (existingIndex >= 0 && !overwrite) {
    return {
      status: 'confirm-overwrite',
      existingRecord: records[existingIndex],
      incomingRecord: normalizedRecord
    };
  }

  if (existingIndex >= 0) {
    records[existingIndex] = normalizedRecord;
  } else {
    records.push(normalizedRecord);
  }

  return {
    status: 'success',
    filePath: writeBalanceSeedRecords(storageRoot, bankName, records),
    record: normalizedRecord
  };
}

module.exports = {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  getBalanceSeedFilePath,
  getBalanceSeedsDir,
  readBalanceSeedRecords,
  splitTemplateName,
  upsertBalanceSeedRecord,
  writeBalanceSeedRecords
};
