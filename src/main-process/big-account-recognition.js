function normalizeCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function normalizeAccountNature(value) {
  return normalizeCell(value) === 'own' ? 'own' : 'client';
}

function stripSpecialCharsForMatch(value) {
  return String(value || '').replace(/[\s\-_()（）[\]【】]/g, '');
}

function matchMerchantIds(cellValue, merchantId, options = {}) {
  const { allowSubstring = true } = options;
  const a = normalizeCell(cellValue);
  const b = normalizeCell(merchantId);
  if (!a || !b) return 'none';
  if (a === b) return 'exact';
  const sa = stripSpecialCharsForMatch(a);
  const sb = stripSpecialCharsForMatch(b);
  if (sa && sb && sa === sb) return 'fuzzy';
  if (allowSubstring && sa && sb && (sa.includes(sb) || sb.includes(sa))) return 'fuzzy';
  return 'none';
}

function normalizeMaintainedBigAccounts(maintainedBigAccounts = []) {
  const rows = [];

  (Array.isArray(maintainedBigAccounts) ? maintainedBigAccounts : []).forEach((item) => {
    const merchantId = normalizeCell(item && item.merchantId);
    if (!merchantId) return;
    const accountNature = normalizeAccountNature(item && item.accountNature);
    const pushRow = (currency) => rows.push({
      merchantId,
      currency: normalizeCell(currency),
      accountNature
    });

    if (Array.isArray(item.currencies)) {
      const currencies = Array.from(new Set(
        item.currencies
          .map((currency) => normalizeCell(currency))
          .filter((currency) => currency !== '')
      ));
      if (currencies.length) {
        currencies.forEach(pushRow);
      } else {
        pushRow(item.currency);
      }
      return;
    }

    pushRow(item && item.currency);
  });

  return rows;
}

function buildDetailLines({ sourceFileName, templateName, extractedMerchantId }) {
  return [
    `文件名：${normalizeCell(sourceFileName) || 'N/A'}`,
    `识别值：${normalizeCell(extractedMerchantId) || '(空)'}`,
    `模板名：${normalizeCell(templateName) || 'N/A'}`
  ];
}

function resolveRecognizedBigAccount({
  extractedMerchantId,
  extractedCurrency,
  maintainedBigAccounts,
  sourceFileName,
  templateName
} = {}) {
  const merchantId = normalizeCell(extractedMerchantId);
  const currency = normalizeCell(extractedCurrency);

  if (!merchantId) {
    return {
      status: 'failed',
      code: 'BIG_ACCOUNT_NOT_RECOGNIZED',
      message: '未识别到大账号，请检查导入文件或先在“维护大账号”中维护后重新导入。',
      detailLines: buildDetailLines({ sourceFileName, templateName, extractedMerchantId: merchantId })
    };
  }

  const candidates = normalizeMaintainedBigAccounts(maintainedBigAccounts)
    .filter((item) => item.merchantId === merchantId);

  if (!candidates.length) {
    return {
      status: 'failed',
      code: 'BIG_ACCOUNT_NOT_MAINTAINED',
      message: `识别到大账号「${merchantId}」，但当前模板的大账号库未维护该账号，请先维护后重新导入。`,
      detailLines: buildDetailLines({ sourceFileName, templateName, extractedMerchantId: merchantId })
    };
  }

  const uniqueCandidates = [];
  const seenKeys = new Set();
  candidates.forEach((candidate) => {
    const key = `${candidate.merchantId}\u0000${candidate.currency}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    uniqueCandidates.push(candidate);
  });

  if (uniqueCandidates.length === 1) {
    return {
      status: 'ok',
      selectedBigAccount: { ...uniqueCandidates[0] }
    };
  }

  if (currency) {
    const currencyMatches = uniqueCandidates.filter((candidate) => candidate.currency === currency);
    if (currencyMatches.length === 1) {
      return {
        status: 'ok',
        selectedBigAccount: { ...currencyMatches[0] }
      };
    }
  }

  return {
    status: 'needs-selection',
    candidates: uniqueCandidates.map((candidate) => ({ ...candidate })),
    message: `识别到大账号「${merchantId}」，但币种无法唯一确定，请选择本次使用的大账号 / 币种。`,
    detailLines: buildDetailLines({ sourceFileName, templateName, extractedMerchantId: merchantId })
  };
}

module.exports = {
  normalizeMaintainedBigAccounts,
  matchMerchantIds,
  resolveRecognizedBigAccount
};
