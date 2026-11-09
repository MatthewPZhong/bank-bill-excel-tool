'use strict';

// v3.2.16：MerchantId「原始账单仅有币种无账户号」— 按每条输出行的最终币种回填大账号。
// 配置来自模板的【映射管理】（template_currency_big_accounts），一个币种只对应一个大账号。
// 会输出的明细行币种为空或未维护时整批阻断（spec D1），不按块识别、不弹选择大账号。

const path = require('node:path');

const { FileValidationError, normalizeCell } = require('./common');
const { parseNumericValue } = require('./normalizers');

const CURRENCY_BIG_ACCOUNT_UNMAPPED = 'CURRENCY_BIG_ACCOUNT_UNMAPPED';
const CURRENCY_BIG_ACCOUNT_CONFIG_MISSING = 'CURRENCY_BIG_ACCOUNT_CONFIG_MISSING';
const CURRENCY_BIG_ACCOUNT_DETAIL_GROUP_LIMIT = 20;
const CURRENCY_BIG_ACCOUNT_DETAIL_ROW_LIMIT = 10;

function normalizeCurrencyKey(value) {
  return normalizeCell(value).toUpperCase();
}

function buildCurrencyBigAccountLookup(pairs = []) {
  const lookup = new Map();
  (Array.isArray(pairs) ? pairs : []).forEach((pair) => {
    const currency = normalizeCurrencyKey(pair && pair.currency);
    const merchantId = normalizeCell(pair && pair.merchantId);
    if (currency && merchantId && !lookup.has(currency)) {
      lookup.set(currency, merchantId);
    }
  });
  return lookup;
}

function createConfigMissingError(templateName) {
  const name = normalizeCell(templateName);
  return new FileValidationError(
    CURRENCY_BIG_ACCOUNT_CONFIG_MISSING,
    `模板${name ? `「${name}」` : ''}的 MerchantId 为「原始账单仅有币种无账户号」，但未在【映射管理】中维护币种与大账号，请先维护后重新导入`,
    { context: { templateName: name } }
  );
}

// 与 buildDetailExportRows 的口径一致：收入、支出两列都存在且都为空或 0 的行不进明细。
function isRowKeptInOutput(mappedRow, creditAmountIndex, debitAmountIndex) {
  if (creditAmountIndex < 0 || debitAmountIndex < 0) {
    return true;
  }
  const isZeroOrBlank = (value) => normalizeCell(value) === '' || parseNumericValue(value) === 0;
  return !(isZeroOrBlank(mappedRow[creditAmountIndex]) && isZeroOrBlank(mappedRow[debitAmountIndex]));
}

// 在 buildMappedRows 生成全部行之后执行：此时 Currency 已是最终值（含币种映射表换算、拆分行的币种），
// 与 MerchantId、Currency 在目标字段中的先后顺序无关。命中行回填大账号，并把 Currency 写成大写代码，
// 保证余额分组键 MerchantId@@Currency 与配置一致。未命中的行 MerchantId 留空；只要有会输出的行未命中就抛错。
function applyCurrencyBigAccountMapping({
  mappedRows,
  rowMetas = [],
  orderedTargetFields = [],
  mapping,
  inputFilePath = ''
}) {
  if (!mapping) {
    throw createConfigMissingError('');
  }

  const lookup = buildCurrencyBigAccountLookup(mapping.pairs);
  if (!lookup.size) {
    throw createConfigMissingError(mapping.templateName);
  }

  const merchantIdIndex = orderedTargetFields.indexOf('MerchantId');
  if (merchantIdIndex < 0) {
    return;
  }

  const currencyIndex = orderedTargetFields.indexOf('Currency');
  if (currencyIndex < 0) {
    throw new FileValidationError(
      CURRENCY_BIG_ACCOUNT_CONFIG_MISSING,
      'MerchantId 为「原始账单仅有币种无账户号」时，模板必须包含 Currency 字段',
      { context: { templateName: normalizeCell(mapping.templateName) } }
    );
  }

  const creditAmountIndex = orderedTargetFields.indexOf('Credit Amount');
  const debitAmountIndex = orderedTargetFields.indexOf('Debit Amount');
  const groups = new Map();

  mappedRows.slice(1).forEach((mappedRow, index) => {
    if (!Array.isArray(mappedRow)) {
      return;
    }

    const rawCurrency = normalizeCell(mappedRow[currencyIndex]);
    const currencyKey = rawCurrency.toUpperCase();
    const merchantId = currencyKey ? lookup.get(currencyKey) : undefined;

    if (merchantId) {
      mappedRow[merchantIdIndex] = merchantId;
      mappedRow[currencyIndex] = currencyKey;
      return;
    }

    mappedRow[merchantIdIndex] = '';

    if (!isRowKeptInOutput(mappedRow, creditAmountIndex, debitAmountIndex)) {
      return;
    }

    const sourceRowNumber = rowMetas[index] && rowMetas[index].sourceRowNumber
      ? rowMetas[index].sourceRowNumber
      : index + 2;
    if (!groups.has(currencyKey)) {
      groups.set(currencyKey, { currency: rawCurrency, rowNumbers: [], seenRowNumbers: new Set() });
    }
    const group = groups.get(currencyKey);
    // 拆分 / 合并明细账单时同一源行可能产出多条明细，行号只记一次（Set 去重，避免大文件整列未维护时退化成平方级）
    if (!group.seenRowNumbers.has(sourceRowNumber)) {
      group.seenRowNumbers.add(sourceRowNumber);
      group.rowNumbers.push(sourceRowNumber);
    }
  });

  if (!groups.size) {
    return;
  }

  const fileName = inputFilePath ? path.basename(inputFilePath) : '';
  throw buildCurrencyBigAccountUnmappedError(Array.from(groups.values()).map((group) => ({
    templateName: normalizeCell(mapping.templateName),
    fileName,
    currency: group.currency,
    rowNumbers: group.rowNumbers
  })));
}

function formatRowNumbers(rowNumbers) {
  const shown = rowNumbers.slice(0, CURRENCY_BIG_ACCOUNT_DETAIL_ROW_LIMIT).join('、');
  return rowNumbers.length > CURRENCY_BIG_ACCOUNT_DETAIL_ROW_LIMIT
    ? `第 ${shown} 行…等 ${rowNumbers.length} 行`
    : `第 ${shown} 行`;
}

function buildCurrencyBigAccountUnmappedError(issues = []) {
  const normalizedIssues = (Array.isArray(issues) ? issues : []).map((issue) => ({
    templateName: normalizeCell(issue && issue.templateName),
    fileName: normalizeCell(issue && issue.fileName),
    currency: normalizeCell(issue && issue.currency),
    rowNumbers: Array.isArray(issue && issue.rowNumbers) ? issue.rowNumbers.slice() : []
  }));
  const rowCount = normalizedIssues.reduce((sum, issue) => sum + issue.rowNumbers.length, 0);
  const fileCount = new Set(normalizedIssues.map((issue) => `${issue.templateName}\u0000${issue.fileName}`)).size;
  const detailLines = normalizedIssues
    .slice(0, CURRENCY_BIG_ACCOUNT_DETAIL_GROUP_LIMIT)
    .map((issue) => {
      const templatePart = issue.templateName ? `模板「${issue.templateName}」` : '';
      const filePart = issue.fileName ? `文件「${issue.fileName}」` : '';
      return `${templatePart}${filePart}币种「${issue.currency || '（空）'}」：${formatRowNumbers(issue.rowNumbers)}`;
    });

  if (normalizedIssues.length > CURRENCY_BIG_ACCOUNT_DETAIL_GROUP_LIMIT) {
    detailLines.push(`另有 ${normalizedIssues.length - CURRENCY_BIG_ACCOUNT_DETAIL_GROUP_LIMIT} 组未列出`);
  }

  return new FileValidationError(
    CURRENCY_BIG_ACCOUNT_UNMAPPED,
    `有 ${rowCount} 行明细的币种为空或未在【映射管理】中维护大账号${fileCount > 1 ? `（涉及 ${fileCount} 个文件）` : ''}，已取消本次导入，未生成任何文件。请在映射关系管理中 MerchantId 的【映射管理】里补充后重新导入`,
    { detailLines, context: { currencyBigAccountIssues: normalizedIssues } }
  );
}

function isCurrencyBigAccountUnmappedError(error) {
  return Boolean(error && error.code === CURRENCY_BIG_ACCOUNT_UNMAPPED);
}

// 把一次未维护错误里的分组逐项并入 target。分组数不受展示上限约束（如 Currency 误映射到流水号列时每个值一组），
// 不用 push(...array)：展开过大的数组会超过函数参数上限，抛出的 RangeError 会盖掉本来的业务错误。
function appendCurrencyBigAccountIssues(target, error) {
  const collected = error && error.context && Array.isArray(error.context.currencyBigAccountIssues)
    ? error.context.currencyBigAccountIssues
    : [];
  for (const issue of collected) {
    target.push(issue);
  }
  return target;
}

// 逐项执行 fn；币种未维护的错误先收集、继续处理后面的文件，最后汇总成一次报错（spec D1 跨文件列出）。
// 其他错误照常立即抛出。
function mapEachCollectingCurrencyBigAccountIssues(items, fn) {
  const results = [];
  const issues = [];
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    try {
      results.push(fn(item, index));
    } catch (error) {
      if (!isCurrencyBigAccountUnmappedError(error)) {
        throw error;
      }
      appendCurrencyBigAccountIssues(issues, error);
      results.push(undefined);
    }
  });
  if (issues.length) {
    throw buildCurrencyBigAccountUnmappedError(issues);
  }
  return results;
}

module.exports = {
  CURRENCY_BIG_ACCOUNT_CONFIG_MISSING,
  CURRENCY_BIG_ACCOUNT_UNMAPPED,
  appendCurrencyBigAccountIssues,
  applyCurrencyBigAccountMapping,
  buildCurrencyBigAccountLookup,
  buildCurrencyBigAccountUnmappedError,
  createConfigMissingError,
  isCurrencyBigAccountUnmappedError,
  mapEachCollectingCurrencyBigAccountIssues
};
