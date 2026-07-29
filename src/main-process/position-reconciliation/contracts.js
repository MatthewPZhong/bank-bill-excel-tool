'use strict';

const {
  AUDIT_HEADERS,
  MATCH_TYPES,
  SOURCE_TYPES,
  FUND_TYPE_PAIRS
} = require('./constants');

const AUDIT_FIELDS = Object.freeze({
  DETAIL: AUDIT_HEADERS[0],
  TYPE: AUDIT_HEADERS[1],
  MATCH_DETAIL: AUDIT_HEADERS[2]
});

const HIT_TYPES = MATCH_TYPES;

const REASON_CODES = Object.freeze({
  DIRECTION_INVALID: 'position-direction-invalid',
  IDENTIFIER_NOT_FOUND: 'position-identifier-not-found',
  IDENTIFIER_CONFLICT: 'position-identifier-conflict',
  CANDIDATE_NOT_FOUND: 'position-candidate-not-found',
  CANDIDATE_MULTIPLE: 'position-candidate-multiple',
  COUNTERPARTY_REUSED: 'position-counterparty-reused',
  EVIDENCE_INVALID: 'position-evidence-invalid',
  TRANSFER_OUT_NOT_FOUND: 'position-transfer-out-not-found',
  TRANSFER_OUT_MULTIPLE: 'position-transfer-out-multiple',
  OWN_ACCOUNT_NOT_FOUND: 'position-own-account-not-found',
  OWN_ACCOUNT_MULTIPLE: 'position-own-account-multiple',
  OTHER_ACCOUNT_NOT_FOUND: 'position-other-account-not-found',
  OTHER_ACCOUNT_MULTIPLE: 'position-other-account-multiple',
  ACCOUNT_CONFLICT: 'position-account-conflict'
});

function pairDefinition(index, definition) {
  const [baseFundType, fxFundType] = FUND_TYPE_PAIRS[index];
  return Object.freeze({
    ...definition,
    baseFundType,
    fxFundType
  });
}

const PAIR_DEFINITIONS = Object.freeze([
  pairDefinition(0, {
    key: 'inbound',
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    direction: 'credit'
  }),
  pairDefinition(1, {
    key: 'outbound',
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    direction: 'debit'
  }),
  pairDefinition(2, {
    key: 'fund-transfer-in',
    sourceType: SOURCE_TYPES.FUND_TRANSFER,
    direction: 'credit'
  }),
  pairDefinition(3, {
    key: 'fund-transfer-out',
    sourceType: SOURCE_TYPES.FUND_TRANSFER,
    direction: 'debit'
  }),
  pairDefinition(4, {
    key: 'ach-return',
    sourceType: SOURCE_TYPES.GATEWAY_OUTBOUND,
    direction: 'debit'
  }),
  pairDefinition(5, {
    key: 'wire-return',
    sourceType: SOURCE_TYPES.GATEWAY_INBOUND,
    direction: 'credit'
  }),
  pairDefinition(6, {
    key: 'others',
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    direction: null
  }),
  pairDefinition(7, {
    key: 'revenue-clear',
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    direction: null
  }),
  pairDefinition(8, {
    key: 'treasury-fund',
    sourceType: SOURCE_TYPES.BANK_ACCOUNT,
    direction: null
  }),
  pairDefinition(9, {
    key: 'test',
    sourceType: SOURCE_TYPES.TEST_PAYMENT,
    direction: 'test-debit'
  })
]);

const PAIR_BY_FUND_TYPE = new Map();
for (const definition of PAIR_DEFINITIONS) {
  PAIR_BY_FUND_TYPE.set(definition.baseFundType, definition);
  PAIR_BY_FUND_TYPE.set(definition.fxFundType, definition);
}

const BANK_IDENTIFIER_FIELDS = Object.freeze([
  'ReconciliationId',
  'ChannelOrderNo',
  'CustomerRef'
]);

module.exports = {
  AUDIT_FIELDS,
  HIT_TYPES,
  SOURCE_TYPES,
  REASON_CODES,
  PAIR_DEFINITIONS,
  PAIR_BY_FUND_TYPE,
  BANK_IDENTIFIER_FIELDS
};
