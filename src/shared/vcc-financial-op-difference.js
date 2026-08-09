(function initVccFinancialOpDifference(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.__vccFinancialOpDifference = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createVccFinancialOpDifferenceApi() {
  'use strict';

  const CANONICAL_DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
  const ZERO_DECIMAL_PATTERN = /^-?0(?:\.0+)?$/;

  function assertCanonicalDifference(value) {
    if (typeof value !== 'string' || !CANONICAL_DECIMAL_PATTERN.test(value)) {
      throw new TypeError(`生效差异必须是规范十进制字符串：${String(value)}`);
    }
    return value;
  }

  function isEffectiveDifferenceZero(value) {
    return ZERO_DECIMAL_PATTERN.test(assertCanonicalDifference(value));
  }

  return Object.freeze({
    assertCanonicalDifference,
    isEffectiveDifferenceZero
  });
}));
