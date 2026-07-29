'use strict';

// 资金写入引擎共享的银行借贷方向校验器。
// 只判断银行行真实 Credit / Debit 双列，不读取也不信任 FundType。

const { canonicalizeDecimal } = require('../financial-decimal');

const BANK_DIRECTION_FIELDS = Object.freeze({
  DEBIT: Object.freeze({
    expectedField: 'Debit Amount',
    oppositeField: 'Credit Amount'
  }),
  CREDIT: Object.freeze({
    expectedField: 'Credit Amount',
    oppositeField: 'Debit Amount'
  })
});

function parseOptionalDecimal(value, label) {
  try {
    const canonical = canonicalizeDecimal(value, { label, allowEmpty: true });
    return canonical === ''
      ? { state: 'empty', value: null }
      : { state: 'valid', value: canonical };
  } catch (_error) {
    return { state: 'invalid', value: null };
  }
}

/**
 * 严格校验银行行是否符合期望的真实借贷方向。
 *
 * @param {Object} bankRow
 * @param {'DEBIT'|'CREDIT'} expectedDirection
 * @returns {{
 *   ok: boolean,
 *   code: 'ok'|'expected-empty'|'expected-invalid'|'expected-zero'|
 *     'opposite-invalid'|'opposite-nonzero'|'unsupported-direction'
 * }}
 */
function validateBankDirection(bankRow, expectedDirection) {
  const fields = BANK_DIRECTION_FIELDS[expectedDirection];
  if (!fields) return { ok: false, code: 'unsupported-direction' };

  const row = bankRow && typeof bankRow === 'object' ? bankRow : {};
  const expected = parseOptionalDecimal(row[fields.expectedField], fields.expectedField);
  if (expected.state === 'empty') return { ok: false, code: 'expected-empty' };
  if (expected.state === 'invalid') return { ok: false, code: 'expected-invalid' };
  if (expected.value === '0') return { ok: false, code: 'expected-zero' };

  const opposite = parseOptionalDecimal(row[fields.oppositeField], fields.oppositeField);
  if (opposite.state === 'invalid') return { ok: false, code: 'opposite-invalid' };
  if (opposite.state === 'valid' && opposite.value !== '0') {
    return { ok: false, code: 'opposite-nonzero' };
  }

  return { ok: true, code: 'ok' };
}

module.exports = {
  BANK_DIRECTION_FIELDS,
  validateBankDirection
};
