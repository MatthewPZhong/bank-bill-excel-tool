const FIXED_FIELD_VALUE_PREFIX = '__FIXED__:';
const MERCHANT_ID_MULTI_ACCOUNT_MARKER = '__MULTI_BIG_ACCOUNT__';

function normalizeText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function parseJsonArray(rawValue) {
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function groupBigAccountRows(rows) {
  const groupMap = new Map();

  rows.forEach((row) => {
    const merchantId = normalizeText(row.merchantId);
    const currency = normalizeText(row.currency);

    if (!merchantId) {
      return;
    }

    if (!groupMap.has(merchantId)) {
      groupMap.set(merchantId, {
        merchantId,
        currencies: [],
        isMultiCurrency: false
      });
    }

    if (currency) {
      groupMap.get(merchantId).currencies.push(currency);
    }
  });

  return Array.from(groupMap.values()).map((item) => {
    const currencies = Array.from(new Set(item.currencies.filter((value) => value !== '')));
    return {
      merchantId: item.merchantId,
      currencies,
      isMultiCurrency: currencies.length > 1
    };
  });
}

function buildTemplateSummaryFromRow(row) {
  const merchantIdMappedField = normalizeText(row.merchantIdMappedField);
  const merchantIdCustomValue = merchantIdMappedField.startsWith(FIXED_FIELD_VALUE_PREFIX)
    ? merchantIdMappedField.slice(FIXED_FIELD_VALUE_PREFIX.length)
    : '';
  const singleBigAccountMerchantId = normalizeText(row.singleBigAccountMerchantId);
  const bigAccountCount = Number(row.bigAccountCount || 0);
  let bigAccountSummary = '未设置';
  let bigAccountMode = 'unset';

  if (merchantIdMappedField.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
    if (bigAccountCount > 0) {
      if (bigAccountCount === 1 && singleBigAccountMerchantId) {
        bigAccountSummary = singleBigAccountMerchantId;
        bigAccountMode = 'single';
      } else {
        bigAccountSummary = `${bigAccountCount}个`;
        bigAccountMode = 'multiple';
      }
    } else if (merchantIdCustomValue && merchantIdCustomValue !== MERCHANT_ID_MULTI_ACCOUNT_MARKER) {
      bigAccountSummary = merchantIdCustomValue;
      bigAccountMode = 'single';
    } else {
      bigAccountSummary = '未设置';
      bigAccountMode = 'unset';
    }
  } else if (merchantIdMappedField) {
    bigAccountSummary = '来自账单';
    bigAccountMode = 'from-source';
  }

  return {
    id: row.id,
    templateKey: normalizeText(row.templateKey),
    name: row.name,
    sourceFileName: row.sourceFileName,
    headers: parseJsonArray(row.headersJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mappingCount: Number(row.mappingCount || 0),
    bigAccountCount,
    bigAccountMode,
    bigAccountSummary
  };
}

module.exports = {
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_MULTI_ACCOUNT_MARKER,
  buildTemplateSummaryFromRow,
  groupBigAccountRows,
  normalizeText,
  parseJsonArray
};
