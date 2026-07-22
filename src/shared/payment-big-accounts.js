(function initPaymentBigAccounts(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.__paymentBigAccounts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPaymentBigAccountsApi() {
  'use strict';

  function failure(reason, message) {
    return { ok: false, reason, message, accounts: [], normalized: '' };
  }

  function parsePaymentBigAccounts(value) {
    const raw = value == null ? '' : String(value);
    if (raw.trim() === '') {
      return failure('empty', '请填写大账号');
    }
    if (raw.includes(',') || raw.includes('，')) {
      return failure('invalid-separator', '多个大账号请使用中文顿号“、”分隔');
    }

    const accounts = raw.split('、').map((item) => item.trim());
    if (accounts.some((item) => item === '')) {
      return failure('empty-segment', '大账号之间只能使用单个顿号“、”分隔，不能有空账号');
    }

    const seen = new Set();
    for (const account of accounts) {
      if (seen.has(account)) {
        return failure('duplicate', `大账号“${account}”重复，请删除重复项`);
      }
      seen.add(account);
    }

    return {
      ok: true,
      reason: '',
      message: '',
      accounts,
      normalized: accounts.join('、')
    };
  }

  return Object.freeze({ parsePaymentBigAccounts });
}));
