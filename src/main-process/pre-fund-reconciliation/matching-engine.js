'use strict';

const crypto = require('node:crypto');

const {
  BANK_ROW_CLASSIFICATION,
  BankRowValidationError,
  canonicalizeDecimal,
  trimCell,
  classifyBankRow,
  toInvalidBothNonzeroError
} = require('./bank-row');
const { resolveBankRuleEligibility } = require('./reconciliation-rules');

const GATEWAY_SOURCE = Object.freeze({
  TEMPORARY: '临时网关对账单',
  PERSISTENT: '网关对账单'
});

const FINGERPRINT_FIELDS = Object.freeze([
  'date',
  'channel',
  'merchantId',
  'orderId',
  'billReconId',
  'currency',
  'amount',
  'tradeType',
  'realChannel',
  'clearingNetwork'
]);

const FIELD_ALIASES = Object.freeze({
  reconciliationId: ['reconciliationId', 'reconciliationid', 'ReconciliationId', 'reconciliation_id'],
  date: ['date', 'BillDate', 'Billdate', 'billDate', 'bill_date'],
  channel: ['channel', 'Channel', 'Bank'],
  merchantId: ['merchantId', 'MerchantId', 'merchantid', 'merchant_id'],
  orderId: ['orderId', 'OrderId', 'orderid', 'order_id'],
  billReconId: ['billReconId', 'ReconBillBizId', 'reconBillBizId', 'recon_bill_biz_id'],
  currency: ['currency', 'Currency'],
  amount: ['amount', 'Amount'],
  tradeType: ['tradeType', 'TradeType', 'tradetype'],
  name: ['name', 'Name'],
  cardNo: ['cardNo', 'CardNo', 'card_no'],
  realChannel: ['realChannel', '真实渠道'],
  clearingNetwork: ['clearingNetwork', '清算网络']
});

class GatewayPoolEmptyError extends Error {
  constructor(message, stats) {
    super(message);
    this.name = 'GatewayPoolEmptyError';
    this.code = 'pre-fund-gateway-pool-empty';
    this.stats = stats;
  }
}

class GatewayRowValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GatewayRowValidationError';
    this.code = details.code || 'pre-fund-gateway-row-invalid';
    Object.assign(this, details);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unwrapGatewayRow(entry) {
  if (!isPlainObject(entry)) return { envelope: {}, row: {} };
  const nested = isPlainObject(entry.row) ? entry.row : null;
  return { envelope: entry, row: nested || entry };
}

function readOwnValue(object, aliases) {
  let firstDefined;
  for (const alias of aliases) {
    if (!Object.prototype.hasOwnProperty.call(object, alias)) continue;
    const value = object[alias];
    if (firstDefined === undefined) firstDefined = value;
    if (value !== null && value !== undefined && trimCell(value) !== '') return value;
  }
  return firstDefined;
}

function readGatewayValue(entry, field) {
  const aliases = FIELD_ALIASES[field] || [field];
  const { envelope, row } = unwrapGatewayRow(entry);
  const envelopeValue = readOwnValue(envelope, aliases);
  if (envelopeValue !== undefined && envelopeValue !== null && trimCell(envelopeValue) !== '') {
    return envelopeValue;
  }
  const rowValue = readOwnValue(row, aliases);
  return rowValue === undefined || rowValue === null ? '' : rowValue;
}

function gatewayLocation(entry, source, sourceIndex) {
  const { envelope, row } = unwrapGatewayRow(entry);
  const sourceFileName = trimCell(
    envelope.sourceFileName
    || envelope.fileName
    || row.sourceFileName
    || row.sourceFile
  );
  const sourceRowNumber = envelope.sourceRowNumber
    ?? envelope.rowNumber
    ?? row.sourceRowNumber
    ?? row.sourceRow
    ?? envelope.id
    ?? (sourceIndex + 1);
  return {
    source,
    sourceFileName,
    sourceRowNumber,
    sourceRecordId: envelope.id ?? row.id ?? null,
    monthKey: trimCell(envelope.monthKey || row.monthKey),
    sourceIndex
  };
}

function rawGatewayBusinessJson(entry, location = {}) {
  const nestedRow = isPlainObject(entry) && isPlainObject(entry.row) ? entry.row : null;
  try {
    // MPT 与持久网关游标都优先附带落库时的原始业务 JSON，必须逐字符保留。
    if (isPlainObject(entry) && typeof entry.rawJson === 'string') return entry.rawJson;
    // 兼容旧持久游标：envelope 只承载 DB 定位元数据，fallback 仅序列化 entry.row。
    if (nestedRow) return JSON.stringify(nestedRow);
    const { row } = unwrapGatewayRow(entry);
    return JSON.stringify(row);
  } catch (error) {
    throw new GatewayRowValidationError(
      `网关账单原始业务行无法序列化（${formatGatewayLocation(location)}）`,
      { code: 'pre-fund-invalid-gateway-raw-json', cause: error, ...location }
    );
  }
}

function validateDateParts(year, month, day, value, location) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    throw new GatewayRowValidationError(
      `网关账单日期“${String(value)}”无效（${formatGatewayLocation(location)}）`,
      { code: 'pre-fund-invalid-gateway-date', value, ...location }
    );
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function canonicalizeDate(value, options = {}) {
  if (value === null || value === undefined || trimCell(value) === '') {
    if (options.allowEmpty !== false) return '';
    throw new GatewayRowValidationError(
      `网关账单日期不能为空（${formatGatewayLocation(options.location || {})}）`,
      { code: 'pre-fund-empty-gateway-date', ...(options.location || {}) }
    );
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new GatewayRowValidationError(
        `网关账单日期对象无效（${formatGatewayLocation(options.location || {})}）`,
        { code: 'pre-fund-invalid-gateway-date', value, ...(options.location || {}) }
      );
    }
    return validateDateParts(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
      value,
      options.location || {}
    );
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const wholeDays = Math.trunc(value);
    const date = new Date(Date.UTC(1899, 11, 30) + wholeDays * 86400000);
    return validateDateParts(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      value,
      options.location || {}
    );
  }

  const text = trimCell(value);
  const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/);
  if (!match) {
    throw new GatewayRowValidationError(
      `网关账单日期“${text}”无法规范为 YYYY-MM-DD（${formatGatewayLocation(options.location || {})}）`,
      { code: 'pre-fund-invalid-gateway-date', value, ...(options.location || {}) }
    );
  }
  return validateDateParts(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    value,
    options.location || {}
  );
}

function formatGatewayLocation(location = {}) {
  const source = trimCell(location.source) || '网关账单';
  const file = trimCell(location.sourceFileName);
  const row = location.sourceRowNumber;
  return [source, file ? `文件「${file}」` : '', row !== undefined ? `第${row}行` : '']
    .filter(Boolean)
    .join('，');
}

function normalizeGatewayFingerprintFields(entry, options = {}) {
  const location = options.location || gatewayLocation(entry, options.source || '', options.sourceIndex || 0);
  let amount;
  try {
    amount = canonicalizeDecimal(readGatewayValue(entry, 'amount'), {
      allowEmpty: true,
      label: '网关 amount'
    });
  } catch (error) {
    throw new GatewayRowValidationError(
      `网关账单金额无效（${formatGatewayLocation(location)}）：${error.message}`,
      { code: 'pre-fund-invalid-gateway-amount', cause: error, ...location }
    );
  }

  return {
    date: canonicalizeDate(readGatewayValue(entry, 'date'), { allowEmpty: true, location }),
    channel: trimCell(readGatewayValue(entry, 'channel')),
    merchantId: trimCell(readGatewayValue(entry, 'merchantId')),
    orderId: trimCell(readGatewayValue(entry, 'orderId')),
    billReconId: trimCell(readGatewayValue(entry, 'billReconId')),
    currency: trimCell(readGatewayValue(entry, 'currency')),
    amount,
    tradeType: trimCell(readGatewayValue(entry, 'tradeType')),
    realChannel: trimCell(readGatewayValue(entry, 'realChannel')),
    clearingNetwork: trimCell(readGatewayValue(entry, 'clearingNetwork'))
  };
}

function buildGatewayFingerprint(entry, options = {}) {
  const fields = normalizeGatewayFingerprintFields(entry, options);
  return fingerprintFromFields(fields);
}

function fingerprintFromFields(fields) {
  const canonicalValues = FINGERPRINT_FIELDS.map((field) => fields[field]);
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalValues), 'utf8')
    .digest('hex');
}

function normalizeGatewayCandidate(entry, source, sourceIndex) {
  const location = gatewayLocation(entry, source, sourceIndex);
  if (entry && entry.rawJsonInvalid === true) {
    throw new GatewayRowValidationError(
      `网关账单原始数据损坏（${formatGatewayLocation(location)}）`,
      { code: 'pre-fund-invalid-gateway-raw-json', ...location }
    );
  }
  const reconciliationId = trimCell(readGatewayValue(entry, 'reconciliationId'));
  const { row } = unwrapGatewayRow(entry);
  // 空 ID 行必定排除，不应因该行无关的日期/金额脏值被升级为整次运行失败。
  const fields = reconciliationId === ''
    ? {
        date: trimCell(readGatewayValue(entry, 'date')),
        channel: trimCell(readGatewayValue(entry, 'channel')),
        merchantId: trimCell(readGatewayValue(entry, 'merchantId')),
        orderId: trimCell(readGatewayValue(entry, 'orderId')),
        billReconId: trimCell(readGatewayValue(entry, 'billReconId')),
        currency: trimCell(readGatewayValue(entry, 'currency')),
        amount: trimCell(readGatewayValue(entry, 'amount')),
        tradeType: trimCell(readGatewayValue(entry, 'tradeType')),
        realChannel: trimCell(readGatewayValue(entry, 'realChannel')),
        clearingNetwork: trimCell(readGatewayValue(entry, 'clearingNetwork'))
      }
    : normalizeGatewayFingerprintFields(entry, { location, source, sourceIndex });
  return {
    source,
    sourcePriority: source === GATEWAY_SOURCE.TEMPORARY ? 0 : 1,
    sourceOrder: sourceIndex,
    sourceIndex,
    location,
    reconciliationId,
    fingerprint: reconciliationId === '' ? '' : fingerprintFromFields(fields),
    fields,
    name: trimCell(readGatewayValue(entry, 'name')),
    cardNo: trimCell(readGatewayValue(entry, 'cardNo')),
    rawJson: rawGatewayBusinessJson(entry, location),
    rawEntry: entry,
    rawRow: row
  };
}

function buildBankMatchCriteria(bankRow) {
  if (!isPlainObject(bankRow)) {
    throw new TypeError('银行匹配条件必须来自派生后的银行行对象');
  }
  const rawRow = isPlainObject(bankRow.rawRow) ? bankRow.rawRow : bankRow;
  const ruleEligibility = resolveBankRuleEligibility(rawRow.FundType, bankRow.transactionType);
  return {
    reconciliationId: trimCell(bankRow.reconciliationId),
    channel: trimCell(bankRow.channel),
    amount: canonicalizeDecimal(bankRow.matchingAmount ?? bankRow.amount, { label: '银行对账金额' }),
    currency: trimCell(bankRow.currency),
    allowedGatewayTradeTypes: ruleEligibility.allowedGatewayTradeTypes,
    ruleEligibility
  };
}

function gatewayCandidateMatches(candidate, criteria) {
  if (!candidate || !criteria) return false;
  const fields = candidate.fields || {};
  return candidate.reconciliationId === criteria.reconciliationId
    && fields.channel === criteria.channel
    && fields.amount === criteria.amount
    && fields.currency === criteria.currency
    && criteria.allowedGatewayTradeTypes.includes(fields.tradeType);
}

function assertSyncIterable(value, label) {
  if (value === null || value === undefined) return [];
  if (typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError(`${label}必须是可迭代对象`);
  }
  return value;
}

function createStats() {
  return {
    bankInputRows: 0,
    bankParticipatingRows: 0,
    bankMatchedRows: 0,
    bankMissingGatewayRows: 0,
    bankZeroAmountRows: 0,
    bankEmptyReconciliationIdRows: 0,
    bankInvalidBothNonzeroRows: 0,
    gatewayInputRows: 0,
    gatewayEmptyReconciliationIdRows: 0,
    gatewayDuplicateFoldedRows: 0,
    gatewayCandidateRows: 0,
    gatewayUnconsumedRows: 0,
    bankRuleUnmappedRows: 0,
    bankRuleDirectionMismatchRows: 0,
    bankRuleNoGatewayTradeTypeRows: 0
  };
}

function buildGatewayPools({ temporaryGatewayRows, persistentGatewayRows }, stats = createStats()) {
  const pools = new Map();
  const seen = new Map();
  const duplicateGroupsByKey = new Map();
  const warnings = [];
  let eventOrder = 0;

  const consumeSource = (rows, source) => {
    let sourceIndex = 0;
    for (const entry of assertSyncIterable(rows, `${source} rows`)) {
      stats.gatewayInputRows += 1;
      const location = gatewayLocation(entry, source, sourceIndex);
      const reconciliationId = trimCell(readGatewayValue(entry, 'reconciliationId'));
      sourceIndex += 1;

      // 空 ID 不参与任何匹配或指纹折叠；先排除，避免无关日期/金额脏值阻断本次运行。
      if (reconciliationId === '') {
        stats.gatewayEmptyReconciliationIdRows += 1;
        warnings.push({
          code: 'pre-fund-gateway-empty-reconciliation-id',
          source,
          location,
          message: `${formatGatewayLocation(location)}对账ID为空，已排除匹配`
        });
        continue;
      }

      const candidate = normalizeGatewayCandidate(entry, source, sourceIndex - 1);
      candidate.sourceOrder = eventOrder;
      eventOrder += 1;

      const duplicateKey = JSON.stringify([candidate.reconciliationId, candidate.fingerprint]);
      const kept = seen.get(duplicateKey);
      if (kept) {
        stats.gatewayDuplicateFoldedRows += 1;
        let duplicateGroup = duplicateGroupsByKey.get(duplicateKey);
        if (!duplicateGroup) {
          duplicateGroup = {
            foldRecordId: `PF-MEM-${duplicateGroupsByKey.size + 1}`,
            channel: kept.fields.channel,
            firstEventOrder: candidate.sourceOrder,
            fingerprint: kept.fingerprint,
            keptCandidate: kept,
            foldedCandidates: []
          };
          duplicateGroupsByKey.set(duplicateKey, duplicateGroup);
        }
        duplicateGroup.foldedCandidates.push(candidate);
        warnings.push({
          code: 'pre-fund-gateway-complete-duplicate-folded',
          reconciliationId: candidate.reconciliationId,
          keptLocation: kept.location,
          duplicateLocation: candidate.location,
          message: `网关对账ID「${candidate.reconciliationId}」存在10字段完全重复记录，已保留${formatGatewayLocation(kept.location)}并折叠${formatGatewayLocation(candidate.location)}`
        });
        continue;
      }

      seen.set(duplicateKey, candidate);
      if (!pools.has(candidate.reconciliationId)) {
        pools.set(candidate.reconciliationId, { candidates: [], consumedIndexes: new Set() });
      }
      pools.get(candidate.reconciliationId).candidates.push(candidate);
      stats.gatewayCandidateRows += 1;
    }
  };

  consumeSource(temporaryGatewayRows || [], GATEWAY_SOURCE.TEMPORARY);
  consumeSource(persistentGatewayRows || [], GATEWAY_SOURCE.PERSISTENT);
  return {
    pools,
    duplicateGroups: [...duplicateGroupsByKey.values()],
    warnings,
    stats
  };
}

/**
 * 大数据生产路径：逐条规范候选并交给 side-DB adapter 去重，不在内存建立全量池。
 * insertCandidate(candidate) 返回 true 表示插入，false 表示同 reconId+fingerprint 已存在。
 */
function stageGatewayCandidatesIterative(options = {}) {
  if (typeof options.insertCandidate !== 'function') {
    throw new TypeError('stageGatewayCandidatesIterative 必须提供 insertCandidate(candidate)');
  }
  const stats = options.stats || createStats();
  const warnings = [];
  let eventOrder = 0;

  const consumeSource = (rows, source) => {
    let sourceIndex = 0;
    for (const entry of assertSyncIterable(rows, `${source} rows`)) {
      stats.gatewayInputRows += 1;
      const location = gatewayLocation(entry, source, sourceIndex);
      const reconciliationId = trimCell(readGatewayValue(entry, 'reconciliationId'));
      if (reconciliationId === '') {
        stats.gatewayEmptyReconciliationIdRows += 1;
        warnings.push({
          code: 'pre-fund-gateway-empty-reconciliation-id',
          source,
          location,
          message: `${formatGatewayLocation(location)}对账ID为空，已排除匹配`
        });
        sourceIndex += 1;
        continue;
      }

      const candidate = normalizeGatewayCandidate(entry, source, sourceIndex);
      candidate.sourceOrder = eventOrder;
      eventOrder += 1;
      sourceIndex += 1;
      if (options.insertCandidate(candidate) === false) {
        stats.gatewayDuplicateFoldedRows += 1;
        warnings.push({
          code: 'pre-fund-gateway-complete-duplicate-folded',
          reconciliationId: candidate.reconciliationId,
          duplicateLocation: candidate.location,
          message: `网关对账ID「${candidate.reconciliationId}」存在10字段完全重复记录，已折叠${formatGatewayLocation(candidate.location)}`
        });
        continue;
      }
      stats.gatewayCandidateRows += 1;
    }
  };

  consumeSource(options.temporaryGatewayRows || [], GATEWAY_SOURCE.TEMPORARY);
  consumeSource(options.persistentGatewayRows || [], GATEWAY_SOURCE.PERSISTENT);
  if (options.requireGatewayRows !== false && stats.gatewayCandidateRows === 0) {
    throw new GatewayPoolEmptyError(
      '临时网关账单和现有网关账单均无可参与匹配的非空对账ID数据，请先导入或维护网关账单。',
      { ...stats }
    );
  }
  return { stats, warnings };
}

function unwrapBankEntry(entry) {
  if (isPlainObject(entry) && isPlainObject(entry.row)) {
    const context = {};
    const fileName = entry.fileName || entry.sourceFileName;
    const excelRowNumber = entry.excelRowNumber ?? entry.sourceRowNumber;
    if (fileName !== undefined && fileName !== null && trimCell(fileName) !== '') {
      context.fileName = fileName;
    }
    if (excelRowNumber !== undefined && excelRowNumber !== null) {
      context.excelRowNumber = excelRowNumber;
    }
    return {
      row: entry.row,
      context
    };
  }
  return { row: entry, context: {} };
}

function assertConservation(stats) {
  const outputCount = stats.bankMatchedRows + stats.bankMissingGatewayRows;
  if (stats.bankParticipatingRows !== outputCount) {
    throw new Error(
      `前置资金对账行数不守恒：参与银行行${stats.bankParticipatingRows}行，平账${stats.bankMatchedRows}行，不平${stats.bankMissingGatewayRows}行`
    );
  }
  return true;
}

/**
 * 大数据生产路径：银行行逐条分类，并通过 consumeGatewayCandidate 从 side DB 严格消费一个五条件候选。
 * onBalanced/onUnbalanced 可直接映射并写结果表；函数自身不保留全量结果数组。
 */
function reconcileBankRowsIterative(options = {}) {
  if (typeof options.consumeGatewayCandidate !== 'function') {
    throw new TypeError('reconcileBankRowsIterative 必须提供 consumeGatewayCandidate(criteria, bankOrdinal)');
  }
  const stats = options.stats || createStats();
  const warnings = Array.isArray(options.warnings) ? options.warnings : [];
  const onBalanced = typeof options.onBalanced === 'function' ? options.onBalanced : () => {};
  const onUnbalanced = typeof options.onUnbalanced === 'function' ? options.onUnbalanced : () => {};
  const onSkipped = typeof options.onSkipped === 'function' ? options.onSkipped : () => {};
  let inputIndex = 0;

  for (const entry of assertSyncIterable(options.bankRows || [], 'bankRows')) {
    const { row, context: entryContext } = unwrapBankEntry(entry);
    const rowContext = {
      ...(options.bankContext || {}),
      ...entryContext,
      inputIndex
    };
    const bankOrdinal = inputIndex;
    inputIndex += 1;
    stats.bankInputRows += 1;

    let classified;
    try {
      classified = classifyBankRow(row, rowContext);
    } catch (error) {
      if (error instanceof BankRowValidationError) error.stats = { ...stats };
      throw error;
    }

    if (classified.classification === BANK_ROW_CLASSIFICATION.INVALID_BOTH_NONZERO) {
      stats.bankInvalidBothNonzeroRows += 1;
      throw toInvalidBothNonzeroError(classified, { ...stats });
    }
    if (classified.classification === BANK_ROW_CLASSIFICATION.ZERO_AMOUNT) {
      stats.bankZeroAmountRows += 1;
      onSkipped(classified);
      continue;
    }
    if (classified.classification === BANK_ROW_CLASSIFICATION.EMPTY_RECONCILIATION_ID) {
      stats.bankEmptyReconciliationIdRows += 1;
      warnings.push({
        code: 'pre-fund-bank-empty-reconciliation-id',
        fileName: classified.sourceFileName,
        excelRowNumber: classified.excelRowNumber,
        message: `银行账单文件「${classified.sourceFileName}」Excel第${classified.excelRowNumber ?? '未知'}行对账ID为空，已排除匹配且不计入缺网关账单`
      });
      onSkipped(classified);
      continue;
    }

    stats.bankParticipatingRows += 1;
    const criteria = buildBankMatchCriteria(classified);
    const eligibility = criteria.ruleEligibility;
    if (!eligibility.eligible) {
      if (eligibility.code === 'bank-fund-type-unmapped') stats.bankRuleUnmappedRows += 1;
      if (eligibility.code === 'bank-rule-direction-mismatch') stats.bankRuleDirectionMismatchRows += 1;
      if (eligibility.code === 'bank-rule-no-gateway-trade-type') stats.bankRuleNoGatewayTradeTypeRows += 1;
    }
    const gatewayRow = eligibility.eligible
      ? options.consumeGatewayCandidate(criteria, bankOrdinal)
      : null;
    if (gatewayRow) {
      stats.bankMatchedRows += 1;
      onBalanced({
        reconciliationId: classified.reconciliationId,
        bankRow: classified,
        gatewayRow
      });
    } else {
      stats.bankMissingGatewayRows += 1;
      onUnbalanced(classified, eligibility.eligible
        ? '未找到同时满足对账ID、渠道、金额、币种和类型规则的网关账单'
        : eligibility.reason);
    }
  }

  if (typeof options.countUnconsumedGatewayRows === 'function') {
    stats.gatewayUnconsumedRows = Number(options.countUnconsumedGatewayRows()) || 0;
  }
  assertConservation(stats);
  return { stats, warnings };
}

function reconcilePreFundRows(options = {}) {
  const stats = createStats();
  const {
    pools,
    duplicateGroups,
    warnings: gatewayWarnings
  } = buildGatewayPools({
    temporaryGatewayRows: options.temporaryGatewayRows || [],
    persistentGatewayRows: options.persistentGatewayRows || []
  }, stats);

  if (options.requireGatewayRows !== false && stats.gatewayCandidateRows === 0) {
    throw new GatewayPoolEmptyError(
      '临时网关账单和现有网关账单均无可参与匹配的非空对账ID数据，请先导入或维护网关账单。',
      { ...stats }
    );
  }

  const balancedPairs = [];
  const unbalancedBankRows = [];
  const zeroAmountBankRows = [];
  const emptyReconciliationIdBankRows = [];
  const warnings = gatewayWarnings.slice();
  let inputIndex = 0;

  for (const entry of assertSyncIterable(options.bankRows || [], 'bankRows')) {
    const { row, context: entryContext } = unwrapBankEntry(entry);
    const rowContext = {
      ...(options.bankContext || {}),
      ...entryContext,
      inputIndex
    };
    inputIndex += 1;
    stats.bankInputRows += 1;

    let classified;
    try {
      classified = classifyBankRow(row, rowContext);
    } catch (error) {
      if (error instanceof BankRowValidationError) error.stats = { ...stats };
      throw error;
    }

    if (classified.classification === BANK_ROW_CLASSIFICATION.INVALID_BOTH_NONZERO) {
      stats.bankInvalidBothNonzeroRows += 1;
      throw toInvalidBothNonzeroError(classified, { ...stats });
    }
    if (classified.classification === BANK_ROW_CLASSIFICATION.ZERO_AMOUNT) {
      stats.bankZeroAmountRows += 1;
      zeroAmountBankRows.push(classified);
      continue;
    }
    if (classified.classification === BANK_ROW_CLASSIFICATION.EMPTY_RECONCILIATION_ID) {
      stats.bankEmptyReconciliationIdRows += 1;
      emptyReconciliationIdBankRows.push(classified);
      warnings.push({
        code: 'pre-fund-bank-empty-reconciliation-id',
        fileName: classified.sourceFileName,
        excelRowNumber: classified.excelRowNumber,
        message: `银行账单文件「${classified.sourceFileName}」Excel第${classified.excelRowNumber ?? '未知'}行对账ID为空，已排除匹配且不计入缺网关账单`
      });
      continue;
    }

    stats.bankParticipatingRows += 1;
    const pool = pools.get(classified.reconciliationId);
    const criteria = buildBankMatchCriteria(classified);
    const eligibility = criteria.ruleEligibility;
    if (!eligibility.eligible) {
      if (eligibility.code === 'bank-fund-type-unmapped') stats.bankRuleUnmappedRows += 1;
      if (eligibility.code === 'bank-rule-direction-mismatch') stats.bankRuleDirectionMismatchRows += 1;
      if (eligibility.code === 'bank-rule-no-gateway-trade-type') stats.bankRuleNoGatewayTradeTypeRows += 1;
    }
    let matchedIndex = -1;
    if (pool && eligibility.eligible) {
      matchedIndex = pool.candidates.findIndex((candidate, candidateIndex) => (
        !pool.consumedIndexes.has(candidateIndex)
        && gatewayCandidateMatches(candidate, criteria)
      ));
    }
    if (matchedIndex >= 0) {
      const gatewayRow = pool.candidates[matchedIndex];
      pool.consumedIndexes.add(matchedIndex);
      balancedPairs.push({
        reconciliationId: classified.reconciliationId,
        bankRow: classified,
        gatewayRow
      });
      stats.bankMatchedRows += 1;
    } else {
      unbalancedBankRows.push({
        ...classified,
        unbalancedReason: eligibility.eligible
          ? '未找到同时满足对账ID、渠道、金额、币种和类型规则的网关账单'
          : eligibility.reason
      });
      stats.bankMissingGatewayRows += 1;
    }
  }

  for (const pool of pools.values()) {
    stats.gatewayUnconsumedRows += pool.candidates.length - pool.consumedIndexes.size;
  }
  assertConservation(stats);

  return {
    balancedPairs,
    unbalancedBankRows,
    skippedBankRows: {
      zeroAmount: zeroAmountBankRows,
      emptyReconciliationId: emptyReconciliationIdBankRows
    },
    duplicateGroups,
    warnings,
    stats
  };
}

module.exports = {
  GATEWAY_SOURCE,
  FINGERPRINT_FIELDS,
  FIELD_ALIASES,
  GatewayPoolEmptyError,
  GatewayRowValidationError,
  canonicalizeDecimal,
  canonicalizeDate,
  rawGatewayBusinessJson,
  readGatewayValue,
  normalizeGatewayFingerprintFields,
  buildGatewayFingerprint,
  fingerprintFromFields,
  normalizeGatewayCandidate,
  buildBankMatchCriteria,
  gatewayCandidateMatches,
  buildGatewayPools,
  stageGatewayCandidatesIterative,
  assertConservation,
  reconcileBankRowsIterative,
  reconcilePreFundRows
};
