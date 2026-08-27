'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  splitTemplateName
} = require('../backend/balance-seed-store');
const { readBalanceAdjustments, resolveBalanceAdjustment } = require('../backend/balance-adjustment-store');
const {
  buildDetailExportRows,
  calculateEndingBalanceFromAmounts,
  extractHeaders,
  FileValidationError,
  inferEndingBalance,
  normalizeCell,
  parseDateValue,
  parseNumericValue,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../backend/file-service');
const {
  cloneRowsWithMetadata,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  resolveSinglePreparedFieldValue
} = require('./statement-session');
const { createStatementGenerationHelpers } = require('./statement-generation');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateLabel(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function today() {
  return formatDateLabel(new Date());
}

function buildDateRangeLabel(billDates) {
  const sorted = [...new Set(billDates)].sort();
  if (sorted.length === 0) return '';
  return sorted.length === 1 ? sorted[0] : `${sorted[0]}~${sorted[sorted.length - 1]}`;
}

function buildFieldIndexMap(headerRow) {
  const result = new Map();
  headerRow.forEach((value, index) => {
    const key = normalizeCell(value);
    if (key && !result.has(key)) result.set(key, index);
  });
  return result;
}

function parseRequiredBillDates(detailRows) {
  const index = buildFieldIndexMap(detailRows[0] || []).get('BillDate');
  if (index === undefined) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
  const dates = [];
  for (const row of detailRows.slice(1)) {
    const raw = row[index];
    if (!normalizeCell(raw)) continue;
    const parsed = parseDateValue(raw);
    if (!parsed) throw new FileValidationError('FILE_READ', `账单日期存在无效值：${normalizeCell(raw)}`);
    dates.push(formatDateLabel(parsed));
  }
  if (!dates.length) throw new FileValidationError('FILE_READ', '导入文件中未找到有效的 BillDate');
  return dates;
}

function numeric(raw, label, allowBlank) {
  if (!normalizeCell(raw)) return allowBlank ? null : 0;
  const value = parseNumericValue(raw);
  if (value === null) throw new FileValidationError('FILE_READ', `${label} 不是有效数字`);
  return value;
}

function balanceTemplateRow(fields, values) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [normalizeCell(key), value]));
  return fields.map((field) => {
    const normalizedField = normalizeCell(field);
    return normalized.has(normalizedField) ? normalized.get(normalizedField) : '';
  });
}

function balancePrompt(templateName, bankName, merchantId, currency, targetBillDate) {
  return { templateName, bankName, merchantId, currency, targetBillDate };
}

function seededBalance(previous, resolver, prompt, required) {
  if (previous !== null) return previous;
  const seed = typeof resolver === 'function' ? resolver(prompt) : null;
  if (seed !== null && seed !== undefined) return seed;
  if (required) {
    throw new FileValidationError('BALANCE_SEED_REQUIRED', '因首次导入余额，请导入上一个账单日余额用于余额校验', {
      context: prompt
    });
  }
  return null;
}

function deriveBalanceRecords({
  detailRows,
  templateName,
  balanceTemplateFields,
  mode = 'statement',
  resolvePreviousEndBalance = null,
  balanceAdjustments = []
}) {
  const indexes = buildFieldIndexMap(detailRows[0] || []);
  const balanceIndex = indexes.get('Balance');
  const dateIndex = indexes.get('BillDate');
  const merchantIndex = indexes.get('MerchantId');
  const rowMetas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];
  if (mode === 'statement' && balanceIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模板未配置 Balance 字段，无法生成余额账单');
  }
  if (dateIndex === undefined) throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
  if (merchantIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模板启用 Balance 时必须映射 MerchantId 字段');
  }
  const groups = new Map();
  const missingMerchantIdRows = [];
  detailRows.slice(1).forEach((row, rowIndex) => {
    const rawDate = row[dateIndex];
    if (!normalizeCell(rawDate)) return;
    const parsedDate = parseDateValue(rawDate);
    if (!parsedDate) throw new FileValidationError('FILE_READ', `账单日期存在无效值：${normalizeCell(rawDate)}`);
    const merchantId = normalizeCell(row[merchantIndex]);
    if (!merchantId) {
      missingMerchantIdRows.push({
        sourceRowNumber: rowMetas[rowIndex]?.sourceRowNumber || rowIndex + 2,
        dateLabel: formatDateLabel(parsedDate)
      });
      return;
    }
    const dateLabel = formatDateLabel(parsedDate);
    const currency = normalizeCell(row[indexes.get('Currency')]);
    const key = `${merchantId}@@${currency}`;
    if (!groups.has(key)) groups.set(key, { merchantId, currency, dates: new Map() });
    const group = groups.get(key);
    if (!group.dates.has(dateLabel)) group.dates.set(dateLabel, []);
    group.dates.get(dateLabel).push({
      balanceValue: mode === 'statement' ? numeric(row[balanceIndex], `${dateLabel} 的 Balance`, true) : null,
      creditAmount: numeric(row[indexes.get('Credit Amount')], `${dateLabel} 的 Credit Amount`, false),
      debitAmount: numeric(row[indexes.get('Debit Amount')], `${dateLabel} 的 Debit Amount`, false)
    });
  });
  if (missingMerchantIdRows.length) {
    throw new FileValidationError(
      'FILE_READ',
      '当前模板启用 Balance 时，导入文件中的 MerchantId 不能为空',
      {
        detailLines: missingMerchantIdRows.map(
          (row) => `第${row.sourceRowNumber}行，账单日期：${row.dateLabel}`
        ),
        context: { templateName }
      }
    );
  }
  const orderedGroups = [...groups.values()].sort((left, right) =>
    left.merchantId.localeCompare(right.merchantId, 'zh-Hans-CN') ||
    left.currency.localeCompare(right.currency, 'zh-Hans-CN'));
  if (!orderedGroups.length) {
    throw new FileValidationError('FILE_READ', '导入文件中未找到可用于余额账单的账单日期');
  }
  const bank = splitTemplateName(templateName);
  const records = [];
  const seedRecords = [];
  const billDates = new Set();
  for (const group of orderedGroups) {
    let previousEndBalance = null;
    let lastAdjustment = 0;
    for (const dateLabel of [...group.dates.keys()].sort()) {
      const entries = group.dates.get(dateLabel);
      const prompt = balancePrompt(templateName, bank.bankName, group.merchantId, group.currency, dateLabel);
      let endBalance;
      if (mode === 'calculated') {
        endBalance = calculateEndingBalanceFromAmounts({
          previousEndBalance: seededBalance(previousEndBalance, resolvePreviousEndBalance, prompt, true),
          entries
        });
      } else {
        const ambiguous = new Set(entries.filter((entry) => entry.balanceValue !== null)
          .map((entry) => Number(Number(entry.balanceValue).toFixed(2)))).size > 1;
        const effectivePrevious = previousEndBalance === null && ambiguous
          ? seededBalance(previousEndBalance, resolvePreviousEndBalance, prompt, true)
          : previousEndBalance;
        try {
          endBalance = inferEndingBalance({ previousEndBalance: effectivePrevious, entries, dateLabel });
        } catch (error) {
          if (error instanceof FileValidationError && error.code === 'FILE_READ' &&
              previousEndBalance === null && ambiguous && effectivePrevious !== null) {
            throw new FileValidationError('BALANCE_SEED_REQUIRED', '因首次导入余额，请导入上一个账单日余额用于余额校验', {
              context: prompt
            });
          }
          throw error;
        }
      }
      const cumulative = resolveBalanceAdjustment(balanceAdjustments, {
        merchantId: group.merchantId, currency: group.currency, dateLabel
      });
      const incrementalAdjustment = Math.round((cumulative - lastAdjustment) * 100) / 100;
      if (incrementalAdjustment && endBalance !== null) {
        endBalance = Math.round((endBalance + incrementalAdjustment) * 100) / 100;
      }
      lastAdjustment = cumulative;
      previousEndBalance = endBalance;
      billDates.add(dateLabel);
      records.push(balanceTemplateRow(balanceTemplateFields, {
        银行名称: bank.bankName, 所在地: bank.location, 币种: group.currency,
        银行账号: group.merchantId, 账单日期: dateLabel, 期初余额: '',
        期初可用余额: '', 期末余额: endBalance, 期末可用余额: ''
      }));
      seedRecords.push({
        merchantId: group.merchantId, currency: group.currency, billDate: dateLabel, endBalance,
        generationMethod: mode === 'calculated'
          ? BALANCE_SEED_GENERATION_METHODS.calculated
          : BALANCE_SEED_GENERATION_METHODS.statement
      });
    }
  }
  return { records, billDates: [...billDates].sort(), seedRecords };
}

function scanBalanceSeedStatus({ detailRows, templateName }, storageRoot) {
  const indexes = buildFieldIndexMap(detailRows[0] || []);
  const merchantIndex = indexes.get('MerchantId');
  const currencyIndex = indexes.get('Currency');
  const dateIndex = indexes.get('BillDate');
  if (merchantIndex === undefined || dateIndex === undefined) return { total: 0, missing: 0 };
  const earliest = new Map();
  for (const row of detailRows.slice(1)) {
    const merchantId = normalizeCell(row[merchantIndex]);
    const currency = currencyIndex === undefined ? '' : normalizeCell(row[currencyIndex]);
    const parsed = parseDateValue(row[dateIndex]);
    if (!merchantId || !parsed) continue;
    const dateLabel = formatDateLabel(parsed);
    const key = `${merchantId}@@${currency}`;
    if (!earliest.has(key) || dateLabel < earliest.get(key).dateLabel) {
      earliest.set(key, { merchantId, currency, dateLabel });
    }
  }
  const bankName = splitTemplateName(templateName).bankName;
  const missingIndexByKey = new Map();
  let missing = 0;
  for (const [key, account] of earliest) {
    if (!findPreviousBalanceSeed(storageRoot, { bankName, ...account, beforeBillDate: account.dateLabel })) {
      missing += 1;
      missingIndexByKey.set(key, missing);
    }
  }
  return { total: earliest.size, missing, missingIndexByKey };
}

function createGenerationHelpers(options) {
  const storageRoot = path.resolve(options.storageRoot);
  const balanceTemplatePath = path.resolve(options.balanceTemplatePath);
  const artifactPaths = options.artifactPaths;
  const usedKinds = new Set();
  fs.mkdirSync(storageRoot, { recursive: true });
  return createStatementGenerationHelpers({
    appendLog() { throw new Error('Statement generation system failure'); },
    buildDateRangeLabel,
    buildDetailExportRows,
    buildFieldIndexMap,
    buildStatementOutputFilePath({ kind, templateName, merchantId, outputTag, dateRangeLabel, internalSuffix }) {
      if (!artifactPaths[kind] || usedKinds.has(kind)) throw new Error(`Unplanned Statement artifact: ${kind}`);
      usedKinds.add(kind);
      const dateLabel = dateRangeLabel || today();
      const displayMerchantId = merchantId && merchantId.length > 4 ? merchantId.slice(-4) : merchantId;
      const fileName = displayMerchantId
        ? `${templateName}-${displayMerchantId}-${outputTag}-${dateLabel}.xlsx`
        : `${templateName}-${outputTag}-${dateLabel}.xlsx`;
      return {
        outputFilePath: artifactPaths[kind],
        outputFileName: fileName,
        internalSuffix
      };
    },
    cloneRowsWithMetadata,
    deriveBalanceRecords,
    ensureStorageRoot: () => storageRoot,
    extractHeaders,
    FileValidationError,
    findPreviousBalanceSeed,
    getBalanceTemplatePath: () => balanceTemplatePath,
    getStatementSessionEntries,
    mergeMappedDetailRows,
    normalizeCell,
    parseRequiredBillDates,
    readBalanceAdjustments,
    resolveSinglePreparedFieldValue,
    scanBalanceSeedStatus: (input) => scanBalanceSeedStatus(input, storageRoot),
    splitTemplateName,
    // E09-C Worker is staging-only. Automatic seed persistence remains outside the dormant path
    // until it can join an explicit Main settlement boundary.
    storeGeneratedBalanceSeeds() {},
    writeBalanceWorkbook,
    writeWorkbookRows
  });
}

module.exports = {
  buildDateRangeLabel,
  buildFieldIndexMap,
  createGenerationHelpers,
  deriveBalanceRecords,
  parseRequiredBillDates,
  scanBalanceSeedStatus
};
