'use strict';

const { normalizeCellValue } = require('../scenario-engines/engine-utils');
const { toDate } = require('../scenario-engines/engine-date-utils');
const {
  AUDIT_FIELDS,
  HIT_TYPES,
  SOURCE_TYPES,
  REASON_CODES,
  PAIR_BY_FUND_TYPE,
  BANK_IDENTIFIER_FIELDS
} = require('./contracts');
const {
  absoluteAmount,
  validateDirection,
  positionBankAmountWithExtraFee,
  sourceAmountToCents
} = require('./decimal');
const {
  buildLogicalAccounts,
  identifyAccountPair
} = require('./logical-accounts');

const PRECISE_PAYMENT_STATUS = '付款成功';
const FUZZY_PAYMENT_STATUSES = new Set(['付款失败', '已提交渠道', '剔除']);

function uniqueMessages(messages) {
  return Array.from(new Set((messages || []).filter(Boolean)));
}

function sourceRecords(rows, sourceType) {
  return (Array.isArray(rows) ? rows : []).map((entry, index) => {
    const row = entry && typeof entry === 'object' && entry.row && typeof entry.row === 'object'
      ? entry.row
      : entry;
    return {
      row: row && typeof row === 'object' ? row : {},
      index,
      sourceType,
      metadata: row === entry ? null : entry
    };
  });
}

function buildReconIndex(records) {
  const index = new Map();
  for (const record of records) {
    const reconId = normalizeCellValue(record.row && record.row.ReconID);
    if (reconId === '') continue;
    if (!index.has(reconId)) index.set(reconId, []);
    index.get(reconId).push(record);
  }
  return index;
}

function makeBankRecord(row, index) {
  const inputRow = row && typeof row === 'object' ? row : {};
  const resultRow = {
    ...inputRow,
    [AUDIT_FIELDS.DETAIL]: '',
    [AUDIT_FIELDS.TYPE]: '',
    [AUDIT_FIELDS.MATCH_DETAIL]: ''
  };
  const bizId = normalizeCellValue(inputRow.BizId || inputRow._positionBizId);
  const explicitRowId = normalizeCellValue(inputRow._rowId || inputRow._positionBankId);
  return {
    inputRow,
    row: resultRow,
    index,
    rowId: explicitRowId || bizId || `position-row-${index}`,
    bizId,
    originalFundType: normalizeCellValue(inputRow.FundType),
    definition: PAIR_BY_FUND_TYPE.get(normalizeCellValue(inputRow.FundType)) || null,
    outcome: null
  };
}

function setEquals(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function lookupByBankIdentifiers(bankRow, reconIndex) {
  const fieldMatches = [];
  for (const field of BANK_IDENTIFIER_FIELDS) {
    const value = normalizeCellValue(bankRow && bankRow[field]);
    if (value === '') continue;
    const records = reconIndex.get(value) || [];
    if (records.length > 0) fieldMatches.push({ field, value, records });
  }

  if (fieldMatches.length === 0) {
    return {
      ok: false,
      code: REASON_CODES.IDENTIFIER_NOT_FOUND,
      hitType: HIT_TYPES.UNMATCHED,
      message: '银行对账标识未命中链接表 ReconID'
    };
  }

  const matchSets = fieldMatches.map((entry) => new Set(entry.records));
  const firstSet = matchSets[0];
  if (matchSets.some((set) => !setEquals(firstSet, set))) {
    return {
      ok: false,
      code: REASON_CODES.IDENTIFIER_CONFLICT,
      hitType: HIT_TYPES.MANUAL,
      message: '银行不同对账标识命中了不同链接记录',
      fieldMatches
    };
  }

  const records = Array.from(firstSet);
  const evidenceByRecord = new Map();
  for (const record of records) {
    evidenceByRecord.set(record, fieldMatches
      .filter((entry) => entry.records.includes(record))
      .map((entry) => ({ field: entry.field, value: entry.value })));
  }
  return {
    ok: true,
    records,
    fieldMatches,
    evidenceByRecord
  };
}

function formatIdentifierEvidence(evidence) {
  return (evidence || []).map((item) => `${item.field}=${item.value}`).join('、');
}

function consumedSourceMessage(sourceRow, bankRecord) {
  const runId = Number(sourceRow && sourceRow._consumedByRunId);
  if (!Number.isInteger(runId) || runId <= 0) return '';
  const bankBizId = normalizeCellValue(sourceRow && sourceRow._consumedByBankBizId);
  if (bankBizId && bankBizId === normalizeCellValue(bankRecord && bankRecord.bizId)) return '';
  return `链接记录已被已确认运行#${runId}${bankBizId ? `的银行BizId=${bankBizId}` : ''}消费`;
}

function compareLocalCalendarDays(left, right) {
  const leftDate = toDate(left);
  const rightDate = toDate(right);
  if (!leftDate || !rightDate) return null;
  const leftDay = leftDate.getFullYear() * 10000 + (leftDate.getMonth() + 1) * 100 + leftDate.getDate();
  const rightDay = rightDate.getFullYear() * 10000 + (rightDate.getMonth() + 1) * 100 + rightDate.getDate();
  if (leftDay < rightDay) return -1;
  if (leftDay > rightDay) return 1;
  return 0;
}

function failureEvaluation(bankRecord, code, hitType, message, reasons = []) {
  return {
    bankRecord,
    edges: [],
    failure: {
      code,
      hitType,
      message,
      reasons: uniqueMessages([message, ...reasons])
    }
  };
}

function candidateEvaluation(bankRecord, edges, manualReasons, mismatchReasons) {
  if (edges.length > 0) return { bankRecord, edges, failure: null };
  if (manualReasons.length > 0) {
    const reasons = uniqueMessages(manualReasons);
    return failureEvaluation(
      bankRecord,
      REASON_CODES.EVIDENCE_INVALID,
      HIT_TYPES.MANUAL,
      reasons.join('；'),
      reasons
    );
  }
  const reasons = uniqueMessages(mismatchReasons);
  return failureEvaluation(
    bankRecord,
    REASON_CODES.CANDIDATE_NOT_FOUND,
    HIT_TYPES.UNMATCHED,
    reasons.join('；') || '没有满足完整条件的链接候选',
    reasons
  );
}

function directionFailure(bankRecord) {
  const result = validateDirection(bankRecord.row, bankRecord.definition.direction);
  if (result.ok) return null;
  return failureEvaluation(
    bankRecord,
    REASON_CODES.DIRECTION_INVALID,
    HIT_TYPES.MANUAL,
    result.message,
    [result.message]
  );
}

function gatewayRouteMatches(definition, sourceRow) {
  if (definition.key === 'inbound') return normalizeCellValue(sourceRow.tradeType) === 'Inbound-VA';
  if (definition.key === 'wire-return') return normalizeCellValue(sourceRow.tradeType) === 'WireReturn';
  if (definition.key === 'ach-return') return normalizeCellValue(sourceRow['交易类型']) === 'AchReturn';
  if (definition.key === 'outbound') {
    const tradeType = normalizeCellValue(sourceRow['交易类型']);
    return tradeType !== '' && tradeType !== 'AchReturn';
  }
  return false;
}

function evaluateInboundCurrency(definition, bankRow, sourceRow) {
  const bankCurrency = normalizeCellValue(bankRow.Currency);
  const orderCurrency = normalizeCellValue(sourceRow.Currency);
  const originCurrency = normalizeCellValue(sourceRow.originOutboundCurrency);
  if (bankCurrency === '' || orderCurrency === '') {
    return { ok: false, manual: true, message: '银行币种或网关订单币种为空' };
  }

  if (
    originCurrency !== ''
    && bankCurrency === orderCurrency
    && orderCurrency !== originCurrency
  ) {
    return {
      ok: true,
      targetFundType: definition.fxFundType,
      hitType: HIT_TYPES.PRECISE,
      detail: `订单币种${orderCurrency}、原始出金币种${originCurrency}、银行币种${bankCurrency}证明涉及换汇`
    };
  }
  if (bankCurrency === orderCurrency && originCurrency === orderCurrency) {
    return {
      ok: true,
      targetFundType: definition.baseFundType,
      hitType: HIT_TYPES.PRECISE,
      detail: `原始出金币种、订单币种和银行币种均为${bankCurrency}，判定不涉及换汇`
    };
  }
  return { ok: false, manual: true, message: '网关入账币种组合无法唯一判定是否换汇' };
}

function evaluateOutboundCurrency(definition, bankRow, sourceRow) {
  const bankCurrency = normalizeCellValue(bankRow.Currency);
  const orderCurrency = normalizeCellValue(sourceRow.Currency);
  const originCurrency = normalizeCellValue(sourceRow['原始币种']);
  if (bankCurrency === '' || orderCurrency === '') {
    return { ok: false, manual: true, message: '银行币种或网关订单币种为空' };
  }

  if (orderCurrency !== bankCurrency) {
    return {
      ok: true,
      targetFundType: definition.fxFundType,
      hitType: HIT_TYPES.PRECISE,
      detail: `订单币种${orderCurrency}不等于银行币种${bankCurrency}，精准判定涉及换汇`
    };
  }

  const originAmount = absoluteAmount(sourceRow['原始金额'], '原始金额');
  if (
    originCurrency !== ''
    && originCurrency !== bankCurrency
    && originAmount.ok
    && originAmount.value !== '0'
  ) {
    return {
      ok: true,
      targetFundType: definition.fxFundType,
      hitType: HIT_TYPES.FUZZY,
      detail: `订单币种等于银行币种${bankCurrency}，但原始币种${originCurrency}不同且原始金额非0，模糊判定涉及换汇`
    };
  }

  if (!originAmount.ok && normalizeCellValue(sourceRow['原始金额']) !== '') {
    return { ok: false, manual: true, message: '网关出账原始金额不是合法金额' };
  }
  return {
    ok: false,
    manual: true,
    message: '网关出账记录不满足精准或模糊换汇条件，按规则不得自动移除FX'
  };
}

function evaluateGatewayBank(bankRecord, pool) {
  const invalidDirection = directionFailure(bankRecord);
  if (invalidDirection) return invalidDirection;

  const lookup = lookupByBankIdentifiers(bankRecord.row, pool.reconIndex);
  if (!lookup.ok) {
    return failureEvaluation(bankRecord, lookup.code, lookup.hitType, lookup.message);
  }

  const manualReasons = [];
  const mismatchReasons = [];
  const edges = [];
  const bankMerchantId = normalizeCellValue(bankRecord.row.MerchantId);

  for (const sourceRecord of lookup.records) {
    const sourceRow = sourceRecord.row;
    if (!gatewayRouteMatches(bankRecord.definition, sourceRow)) {
      mismatchReasons.push('ReconID命中的网关记录交易类型不属于当前场景');
      continue;
    }
    const sourceMerchantId = normalizeCellValue(sourceRow.MerchantId);
    if (bankMerchantId === '' || sourceMerchantId === '') {
      manualReasons.push('银行或网关 MerchantId 为空');
      continue;
    }
    if (bankMerchantId !== sourceMerchantId) {
      mismatchReasons.push('银行 MerchantId 与网关 MerchantId 不一致');
      continue;
    }

    const currencyResult = pool.sourceType === SOURCE_TYPES.GATEWAY_INBOUND
      ? evaluateInboundCurrency(bankRecord.definition, bankRecord.row, sourceRow)
      : evaluateOutboundCurrency(bankRecord.definition, bankRecord.row, sourceRow);
    if (!currencyResult.ok) {
      (currencyResult.manual ? manualReasons : mismatchReasons).push(currencyResult.message);
      continue;
    }
    const consumedMessage = consumedSourceMessage(sourceRow, bankRecord);
    if (consumedMessage) {
      manualReasons.push(consumedMessage);
      continue;
    }
    const identifierEvidence = lookup.evidenceByRecord.get(sourceRecord) || [];
    edges.push({
      sourceRecord,
      targetFundType: currencyResult.targetFundType,
      hitType: currencyResult.hitType,
      detail: `${formatIdentifierEvidence(identifierEvidence)}；MerchantId=${bankMerchantId}；${currencyResult.detail}`,
      identifierEvidence
    });
  }
  return candidateEvaluation(bankRecord, edges, manualReasons, mismatchReasons);
}

function transferTargetFundType(definition, sourceRow) {
  const payCurrency = normalizeCellValue(sourceRow['付款币种']);
  const receiveCurrency = normalizeCellValue(sourceRow['收款币种']);
  if (payCurrency === '' || receiveCurrency === '') {
    return { ok: false, message: '调拨付款币种或收款币种为空' };
  }
  return {
    ok: true,
    payCurrency,
    receiveCurrency,
    targetFundType: payCurrency === receiveCurrency
      ? definition.baseFundType
      : definition.fxFundType
  };
}

function evaluateTransferBank(bankRecord, pool, options = {}) {
  const bankAmount = positionBankAmountWithExtraFee(bankRecord.row, bankRecord.definition.direction);
  if (!bankAmount.ok) {
    return failureEvaluation(
      bankRecord,
      REASON_CODES.DIRECTION_INVALID,
      HIT_TYPES.MANUAL,
      bankAmount.message
    );
  }

  const lookup = lookupByBankIdentifiers(bankRecord.row, pool.reconIndex);
  if (!lookup.ok) {
    return failureEvaluation(bankRecord, lookup.code, lookup.hitType, lookup.message);
  }

  const manualReasons = [];
  const mismatchReasons = [];
  const edges = [];
  const bankMerchantId = normalizeCellValue(bankRecord.row.MerchantId);
  const bankCurrency = normalizeCellValue(bankRecord.row.Currency);

  for (const sourceRecord of lookup.records) {
    const sourceRow = sourceRecord.row;
    if (normalizeCellValue(sourceRow.FundType) !== bankRecord.definition.baseFundType) {
      mismatchReasons.push('ReconID命中的调拨腿方向不属于当前场景');
      continue;
    }
    if (normalizeCellValue(sourceRow['调拨状态']) !== PRECISE_PAYMENT_STATUS) {
      mismatchReasons.push('调拨状态不是付款成功');
      continue;
    }

    const sourceMerchantId = normalizeCellValue(sourceRow.MerchantId);
    const sourceCurrency = normalizeCellValue(sourceRow.Currency);
    if (bankMerchantId === '' || sourceMerchantId === '' || bankCurrency === '' || sourceCurrency === '') {
      manualReasons.push('银行或调拨链接表的账号、币种为空');
      continue;
    }
    if (bankMerchantId !== sourceMerchantId) {
      mismatchReasons.push('银行 MerchantId 与调拨腿 MerchantId 不一致');
      continue;
    }
    if (bankCurrency !== sourceCurrency) {
      mismatchReasons.push('银行 Currency 与调拨腿 Currency 不一致');
      continue;
    }

    const sourceAmount = sourceAmountToCents(sourceRow.Amount, '调拨 Amount');
    if (!sourceAmount.ok) {
      manualReasons.push(sourceAmount.message);
      continue;
    }
    if (bankAmount.cents !== sourceAmount.cents) {
      mismatchReasons.push('银行含手续费金额与调拨 Amount 不一致');
      continue;
    }

    const transactionDateComparison = compareLocalCalendarDays(
      bankRecord.row.BillDate,
      sourceRow['交易时间']
    );
    if (transactionDateComparison === null) {
      manualReasons.push('银行 BillDate 或调拨交易时间不是合法日期');
      continue;
    }
    if (transactionDateComparison < 0) {
      mismatchReasons.push('银行 BillDate 早于调拨交易时间');
      continue;
    }

    let outEvidence = null;
    if (bankRecord.definition.key === 'fund-transfer-in') {
      outEvidence = options.resolveTransferOut
        ? options.resolveTransferOut(sourceRecord)
        : { ok: false, code: REASON_CODES.TRANSFER_OUT_NOT_FOUND, message: '缺少对应 FundTransfer-out 银行行' };
      if (!outEvidence.ok) {
        manualReasons.push(outEvidence.message);
        continue;
      }
      const outDateComparison = compareLocalCalendarDays(
        bankRecord.row.BillDate,
        outEvidence.bankRow.BillDate
      );
      if (outDateComparison === null) {
        manualReasons.push('FundTransfer-in 或对应 FundTransfer-out 的 BillDate 不是合法日期');
        continue;
      }
      if (outDateComparison < 0) {
        mismatchReasons.push('FundTransfer-in BillDate 早于对应 FundTransfer-out BillDate');
        continue;
      }
    }

    const target = transferTargetFundType(bankRecord.definition, sourceRow);
    if (!target.ok) {
      manualReasons.push(target.message);
      continue;
    }
    const consumedMessage = consumedSourceMessage(sourceRow, bankRecord);
    if (consumedMessage) {
      manualReasons.push(consumedMessage);
      continue;
    }
    const identifierEvidence = lookup.evidenceByRecord.get(sourceRecord) || [];
    const outDetail = outEvidence
      ? `；对应FundTransfer-out BillDate=${normalizeCellValue(outEvidence.bankRow.BillDate)}`
      : '';
    edges.push({
      sourceRecord,
      targetFundType: target.targetFundType,
      hitType: HIT_TYPES.PRECISE,
      detail:
        `${formatIdentifierEvidence(identifierEvidence)}；MerchantId=${bankMerchantId}；Currency=${bankCurrency}；` +
        `银行含手续费金额=${bankAmount.total}；调拨币种=${target.payCurrency}→${target.receiveCurrency}${outDetail}`,
      identifierEvidence
    });
  }
  return candidateEvaluation(bankRecord, edges, manualReasons, mismatchReasons);
}

function evaluateTestBank(bankRecord, pool) {
  const invalidDirection = directionFailure(bankRecord);
  if (invalidDirection) return invalidDirection;

  const lookup = lookupByBankIdentifiers(bankRecord.row, pool.reconIndex);
  if (!lookup.ok) {
    return failureEvaluation(bankRecord, lookup.code, lookup.hitType, lookup.message);
  }

  const manualReasons = [];
  const mismatchReasons = [];
  const edges = [];
  const bankCurrency = normalizeCellValue(bankRecord.row.Currency);

  for (const sourceRecord of lookup.records) {
    const sourceRow = sourceRecord.row;
    const status = normalizeCellValue(sourceRow['付款状态']);
    if (status !== PRECISE_PAYMENT_STATUS && !FUZZY_PAYMENT_STATUSES.has(status)) {
      mismatchReasons.push('测试付款状态不在可匹配范围');
      continue;
    }
    const targetCurrency = normalizeCellValue(sourceRow['目标币种']);
    if (bankCurrency === '' || targetCurrency === '') {
      manualReasons.push('银行币种或测试付款目标币种为空');
      continue;
    }
    const consumedMessage = consumedSourceMessage(sourceRow, bankRecord);
    if (consumedMessage) {
      manualReasons.push(consumedMessage);
      continue;
    }
    const identifierEvidence = lookup.evidenceByRecord.get(sourceRecord) || [];
    const isFuzzy = FUZZY_PAYMENT_STATUSES.has(status);
    edges.push({
      sourceRecord,
      targetFundType: bankCurrency === targetCurrency
        ? bankRecord.definition.baseFundType
        : bankRecord.definition.fxFundType,
      hitType: isFuzzy ? HIT_TYPES.FUZZY : HIT_TYPES.PRECISE,
      detail:
        `${formatIdentifierEvidence(identifierEvidence)}；银行Debit非0；银行币种=${bankCurrency}；` +
        `目标币种=${targetCurrency}；付款状态=${status}` +
        (isFuzzy ? '，按异常付款状态模糊命中' : ''),
      identifierEvidence
    });
  }
  return candidateEvaluation(bankRecord, edges, manualReasons, mismatchReasons);
}

function accountDetail(pair, targetFundType) {
  const ownAliases = pair.own.matches.flatMap((match) => match.aliases);
  const otherAliases = pair.other.matches.flatMap((match) => match.aliases);
  return (
    `自有账户别名=${Array.from(new Set(ownAliases)).join('/')}，币种=${pair.own.account.currency}；` +
    `非自有账户别名=${Array.from(new Set(otherAliases)).join('/')}，` +
    `账户性质=${pair.other.account.nature}，币种=${pair.other.account.currency}；` +
    `判定FundType=${targetFundType}`
  );
}

function evaluateAccountBank(bankRecord, logicalAccounts) {
  const pair = identifyAccountPair(bankRecord.row, logicalAccounts);
  if (!pair.ok) {
    return failureEvaluation(
      bankRecord,
      pair.code,
      HIT_TYPES.MANUAL,
      pair.message
    );
  }
  const targetFundType = pair.own.account.currency === pair.other.account.currency
    ? bankRecord.definition.baseFundType
    : bankRecord.definition.fxFundType;
  return {
    bankRecord,
    edges: [{
      sourceRecord: {
        sourceType: SOURCE_TYPES.BANK_ACCOUNT,
        row: {
          ownLogicalAccount: pair.own.account,
          otherLogicalAccount: pair.other.account
        },
        index: null
      },
      targetFundType,
      hitType: HIT_TYPES.PRECISE,
      detail: accountDetail(pair, targetFundType),
      accountPair: pair
    }],
    failure: null,
    accountOnly: true
  };
}

function manualFromEvaluation(evaluation, code, message, reasons = []) {
  return {
    bankRecord: evaluation.bankRecord,
    edge: null,
    failure: {
      code,
      hitType: HIT_TYPES.MANUAL,
      message,
      reasons: uniqueMessages([message, ...reasons])
    }
  };
}

function resolveStrictOneToOne(evaluations) {
  const sourceToBanks = new Map();
  for (const evaluation of evaluations) {
    for (const edge of evaluation.edges) {
      if (!sourceToBanks.has(edge.sourceRecord)) sourceToBanks.set(edge.sourceRecord, new Set());
      sourceToBanks.get(edge.sourceRecord).add(evaluation.bankRecord);
    }
  }

  return evaluations.map((evaluation) => {
    if (evaluation.failure) {
      return { bankRecord: evaluation.bankRecord, edge: null, failure: evaluation.failure };
    }
    if (evaluation.edges.length !== 1) {
      return manualFromEvaluation(
        evaluation,
        REASON_CODES.CANDIDATE_MULTIPLE,
        `满足完整条件的链接候选为${evaluation.edges.length}条，严格1:1要求恰好1条`
      );
    }
    const edge = evaluation.edges[0];
    const bankCount = sourceToBanks.get(edge.sourceRecord).size;
    if (bankCount !== 1) {
      return manualFromEvaluation(
        evaluation,
        REASON_CODES.COUNTERPARTY_REUSED,
        `同一链接记录被${bankCount}条银行行候选命中，严格1:1禁止按顺序抢占`
      );
    }
    return { bankRecord: evaluation.bankRecord, edge, failure: null };
  });
}

function selectedBankIdentity(records) {
  const objectRows = new Set(records.map((record) => record.inputRow));
  const bizIds = new Set(records.map((record) => record.bizId).filter(Boolean));
  return { objectRows, bizIds };
}

function isSelectedHistoricalRow(row, identity) {
  if (identity.objectRows.has(row)) return true;
  const bizId = normalizeCellValue(row && row.BizId);
  return bizId !== '' && identity.bizIds.has(bizId);
}

function buildTransferOutResolver({
  transferPool,
  transferOutResolutions,
  selectedRecords,
  allUnarchivedBankRows
}) {
  const matchedBySource = new Map();
  for (const resolution of transferOutResolutions) {
    if (!resolution.edge) continue;
    if (!matchedBySource.has(resolution.edge.sourceRecord)) {
      matchedBySource.set(resolution.edge.sourceRecord, []);
    }
    matchedBySource.get(resolution.edge.sourceRecord).push(resolution.bankRecord.row);
  }

  const outSourcesByOrder = new Map();
  for (const record of transferPool.records) {
    if (normalizeCellValue(record.row.FundType) !== 'FundTransfer-out') continue;
    const orderNo = normalizeCellValue(record.row['调拨单号']);
    if (orderNo === '') continue;
    if (!outSourcesByOrder.has(orderNo)) outSourcesByOrder.set(orderNo, []);
    outSourcesByOrder.get(orderNo).push(record);
  }

  const identity = selectedBankIdentity(selectedRecords);
  const historicalRows = (Array.isArray(allUnarchivedBankRows) ? allUnarchivedBankRows : [])
    .filter((row) => row && typeof row === 'object' && !isSelectedHistoricalRow(row, identity));
  const historicalBySource = new Map();
  const ambiguousHistoricalSources = new Set();
  for (let index = 0; index < historicalRows.length; index += 1) {
    const row = historicalRows[index];
    const definition = PAIR_BY_FUND_TYPE.get(normalizeCellValue(row.FundType));
    if (!definition || definition.key !== 'fund-transfer-out') continue;
    const bankRecord = makeBankRecord(row, index);
    const evaluation = evaluateTransferBank(bankRecord, transferPool);
    if (evaluation.failure || evaluation.edges.length === 0) continue;
    for (const edge of evaluation.edges) {
      if (!historicalBySource.has(edge.sourceRecord)) historicalBySource.set(edge.sourceRecord, []);
      historicalBySource.get(edge.sourceRecord).push(row);
      if (evaluation.edges.length !== 1) ambiguousHistoricalSources.add(edge.sourceRecord);
    }
  }
  const cache = new Map();

  return (inSourceRecord) => {
    if (cache.has(inSourceRecord)) return cache.get(inSourceRecord);
    const orderNo = normalizeCellValue(inSourceRecord.row && inSourceRecord.row['调拨单号']);
    const siblingSources = outSourcesByOrder.get(orderNo) || [];
    if (orderNo === '' || siblingSources.length !== 1) {
      const result = {
        ok: false,
        code: siblingSources.length > 1
          ? REASON_CODES.TRANSFER_OUT_MULTIPLE
          : REASON_CODES.TRANSFER_OUT_NOT_FOUND,
        message: siblingSources.length > 1
          ? `调拨单号${orderNo || '为空'}存在${siblingSources.length}条FundTransfer-out链接腿`
          : `调拨单号${orderNo || '为空'}缺少唯一FundTransfer-out链接腿`
      };
      cache.set(inSourceRecord, result);
      return result;
    }

    const sibling = siblingSources[0];
    const candidates = [
      ...(matchedBySource.get(sibling) || []),
      ...(historicalBySource.get(sibling) || [])
    ];

    let result;
    if (candidates.length === 1 && !ambiguousHistoricalSources.has(sibling)) {
      result = { ok: true, bankRow: candidates[0], sourceRecord: sibling };
    } else if (candidates.length === 0) {
      result = {
        ok: false,
        code: REASON_CODES.TRANSFER_OUT_NOT_FOUND,
        message: `调拨单号${orderNo}未找到唯一的FundTransfer-out银行行`
      };
    } else {
      result = {
        ok: false,
        code: REASON_CODES.TRANSFER_OUT_MULTIPLE,
        message: `调拨单号${orderNo}找到${candidates.length}条FundTransfer-out银行行`
      };
    }
    cache.set(inSourceRecord, result);
    return result;
  };
}

function applyResolvedOutcome(resolution, collections) {
  const { bankRecord } = resolution;
  if (resolution.failure) {
    const failure = resolution.failure;
    bankRecord.row[AUDIT_FIELDS.TYPE] = failure.hitType;
    bankRecord.row[AUDIT_FIELDS.MATCH_DETAIL] = failure.message;
    bankRecord.outcome = {
      rowId: bankRecord.rowId,
      index: bankRecord.index,
      pairKey: bankRecord.definition && bankRecord.definition.key,
      oldFundType: bankRecord.originalFundType,
      newFundType: bankRecord.originalFundType,
      changed: false,
      hitType: failure.hitType,
      detail: failure.message,
      difference: true,
      reasonCode: failure.code,
      reasons: failure.reasons || [failure.message],
      sourceType: bankRecord.definition && bankRecord.definition.sourceType
    };
    collections.differences.push({
      ...bankRecord.outcome,
      bankRow: bankRecord.row
    });
    return;
  }

  const edge = resolution.edge;
  bankRecord.matchedEdge = edge;
  const changed = bankRecord.originalFundType !== edge.targetFundType;
  if (changed) {
    bankRecord.row.FundType = edge.targetFundType;
    bankRecord.row[AUDIT_FIELDS.DETAIL] =
      `FundType：${bankRecord.originalFundType}→${edge.targetFundType}`;
    collections.modifications.push({
      rowId: bankRecord.rowId,
      column: 'FundType',
      oldValue: bankRecord.originalFundType,
      newValue: edge.targetFundType
    });
  }
  bankRecord.row[AUDIT_FIELDS.TYPE] = edge.hitType;
  bankRecord.row[AUDIT_FIELDS.MATCH_DETAIL] = edge.detail;
  bankRecord.outcome = {
    rowId: bankRecord.rowId,
    index: bankRecord.index,
    pairKey: bankRecord.definition.key,
    oldFundType: bankRecord.originalFundType,
    newFundType: edge.targetFundType,
    changed,
    hitType: edge.hitType,
    detail: edge.detail,
    difference: false,
    reasonCode: null,
    reasons: [],
    sourceType: edge.sourceRecord.sourceType,
    sourceIndex: edge.sourceRecord.index
  };
  collections.matches.push({
    ...bankRecord.outcome,
    bankRow: bankRecord.row,
    sourceRow: edge.sourceRecord.row,
    sourceRecord: edge.sourceRecord
  });
}

function applyNotApplicable(bankRecord) {
  const detail = '当前FundType不属于平盘资金性质校验支持的十组类型';
  bankRecord.row[AUDIT_FIELDS.TYPE] = HIT_TYPES.NOT_APPLICABLE;
  bankRecord.row[AUDIT_FIELDS.MATCH_DETAIL] = detail;
  bankRecord.outcome = {
    rowId: bankRecord.rowId,
    index: bankRecord.index,
    pairKey: null,
    oldFundType: bankRecord.originalFundType,
    newFundType: bankRecord.originalFundType,
    changed: false,
    hitType: HIT_TYPES.NOT_APPLICABLE,
    detail,
    difference: false,
    reasonCode: null,
    reasons: [],
    sourceType: null
  };
}

function makePool(rows, sourceType) {
  const records = sourceRecords(rows, sourceType);
  return {
    sourceType,
    records,
    reconIndex: buildReconIndex(records)
  };
}

function linkedInputRows(input, sourceType, explicitField) {
  if (Array.isArray(input[explicitField])) return input[explicitField];
  const linkedRows = input.linkedRows;
  return linkedRows && Array.isArray(linkedRows[sourceType]) ? linkedRows[sourceType] : [];
}

function buildCompatibilityRow(bankRecord) {
  const outcome = bankRecord.outcome;
  const edge = bankRecord.matchedEdge || null;
  const sourceRow = edge && edge.sourceRecord && edge.sourceRecord.row;
  const sourceLegIndex = sourceRow && Number(sourceRow._sourceLegIndex);
  const identifierEvidence = edge && Array.isArray(edge.identifierEvidence)
    ? edge.identifierEvidence
    : [];
  const lineage = outcome.difference
    ? {
        pairKey: outcome.pairKey,
        sourceType: outcome.sourceType,
        reasonCode: outcome.reasonCode,
        reasons: outcome.reasons
      }
    : {
        pairKey: outcome.pairKey,
        sourceType: outcome.sourceType,
        sourceIndex: outcome.sourceIndex,
        sourceLinkRowId: sourceRow && sourceRow._linkRowId,
        sourceBusinessKey: sourceRow && sourceRow._sourceBusinessKey,
        ...(sourceRow && sourceRow._sourceRecordKey
          ? { sourceRecordKey: sourceRow._sourceRecordKey }
          : {}),
        sourceRowNumber: sourceRow && sourceRow._sourceRowNumber,
        sourceLegIndex: Number.isInteger(sourceLegIndex) && sourceLegIndex >= 0
          ? sourceLegIndex
          : null,
        identifiers: identifierEvidence
      };
  return {
    bizId: bankRecord.bizId,
    bankRow: bankRecord.row,
    resultFundType: outcome.newFundType,
    hitType: outcome.hitType,
    detail: outcome.detail,
    outcome: outcome.difference
      ? 'difference'
      : (outcome.hitType === HIT_TYPES.NOT_APPLICABLE ? 'not-applicable' : 'matched'),
    isDifference: outcome.difference,
    lineage
  };
}

/**
 * 平盘资金性质校验纯算法引擎。
 *
 * 输入、链接行和历史银行行均只读；返回新银行行对象及匹配/差异血缘。
 */
function runPositionFundNatureCheck(input = {}) {
  const bankRecords = (Array.isArray(input.bankRows) ? input.bankRows : [])
    .map((row, index) => makeBankRecord(row, index));
  const inboundPool = makePool(
    linkedInputRows(input, SOURCE_TYPES.GATEWAY_INBOUND, 'gatewayInboundRows'),
    SOURCE_TYPES.GATEWAY_INBOUND
  );
  const outboundPool = makePool(
    linkedInputRows(input, SOURCE_TYPES.GATEWAY_OUTBOUND, 'gatewayOutboundRows'),
    SOURCE_TYPES.GATEWAY_OUTBOUND
  );
  const transferPool = makePool(
    linkedInputRows(input, SOURCE_TYPES.FUND_TRANSFER, 'fundTransferRows'),
    SOURCE_TYPES.FUND_TRANSFER
  );
  const testPool = makePool(
    linkedInputRows(input, SOURCE_TYPES.TEST_PAYMENT, 'testPaymentRows'),
    SOURCE_TYPES.TEST_PAYMENT
  );
  const logicalAccounts = buildLogicalAccounts(
    linkedInputRows(input, SOURCE_TYPES.BANK_ACCOUNT, 'bankAccountRows')
  );
  const collections = { modifications: [], matches: [], differences: [] };

  const gatewayInboundEvaluations = [];
  const gatewayOutboundEvaluations = [];
  const transferOutEvaluations = [];
  const transferInRecords = [];
  const testEvaluations = [];
  const accountEvaluations = [];

  for (const record of bankRecords) {
    if (!record.definition) {
      applyNotApplicable(record);
      continue;
    }
    switch (record.definition.sourceType) {
      case SOURCE_TYPES.GATEWAY_INBOUND:
        gatewayInboundEvaluations.push(evaluateGatewayBank(record, inboundPool));
        break;
      case SOURCE_TYPES.GATEWAY_OUTBOUND:
        gatewayOutboundEvaluations.push(evaluateGatewayBank(record, outboundPool));
        break;
      case SOURCE_TYPES.FUND_TRANSFER:
        if (record.definition.key === 'fund-transfer-in') transferInRecords.push(record);
        else transferOutEvaluations.push(evaluateTransferBank(record, transferPool));
        break;
      case SOURCE_TYPES.TEST_PAYMENT:
        testEvaluations.push(evaluateTestBank(record, testPool));
        break;
      case SOURCE_TYPES.BANK_ACCOUNT:
        accountEvaluations.push(evaluateAccountBank(record, logicalAccounts));
        break;
      default:
        applyNotApplicable(record);
        break;
    }
  }

  const initialResolutionGroups = [
    resolveStrictOneToOne(gatewayInboundEvaluations),
    resolveStrictOneToOne(gatewayOutboundEvaluations),
    resolveStrictOneToOne(transferOutEvaluations),
    resolveStrictOneToOne(testEvaluations)
  ];
  const transferOutResolutions = initialResolutionGroups[2];
  for (const resolutions of initialResolutionGroups) {
    for (const resolution of resolutions) applyResolvedOutcome(resolution, collections);
  }
  for (const evaluation of accountEvaluations) {
    const resolution = evaluation.failure
      ? { bankRecord: evaluation.bankRecord, edge: null, failure: evaluation.failure }
      : { bankRecord: evaluation.bankRecord, edge: evaluation.edges[0], failure: null };
    applyResolvedOutcome(resolution, collections);
  }

  const resolveTransferOut = buildTransferOutResolver({
    transferPool,
    transferOutResolutions,
    selectedRecords: bankRecords,
    allUnarchivedBankRows: Array.isArray(input.allUnarchivedBankRows)
      ? input.allUnarchivedBankRows
      : input.allBankRows
  });
  const transferInEvaluations = transferInRecords.map((record) => (
    evaluateTransferBank(record, transferPool, { resolveTransferOut })
  ));
  for (const resolution of resolveStrictOneToOne(transferInEvaluations)) {
    applyResolvedOutcome(resolution, collections);
  }

  for (const record of bankRecords) {
    if (!record.outcome) {
      throw new Error(`平盘资金性质校验行去向守恒失败：${record.rowId}`);
    }
  }

  const outcomes = bankRecords.map((record) => record.outcome);
  const rows = bankRecords.map(buildCompatibilityRow);
  return {
    rows,
    resultRows: bankRecords.map((record) => record.row),
    outcomes,
    modifications: collections.modifications,
    matches: collections.matches,
    differences: collections.differences,
    logicalAccounts,
    summary: {
      total: bankRecords.length,
      matched: collections.matches.length,
      changed: collections.modifications.length,
      differences: collections.differences.length,
      notApplicable: outcomes.filter((outcome) => outcome.hitType === HIT_TYPES.NOT_APPLICABLE).length
    }
  };
}

module.exports = {
  runPositionFundNatureCheck,
  compareLocalCalendarDays,
  lookupByBankIdentifiers,
  resolveStrictOneToOne,
  evaluateInboundCurrency,
  evaluateOutboundCurrency
};
