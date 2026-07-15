'use strict';

const FUND_TYPES = Object.freeze({
  REVERSAL: 'Reversal',
  INBOUND: 'Inbound'
});

const GROUP_TEXT_FIELDS = Object.freeze([
  'Payee Name',
  'Payee CardNo',
  'Drawee Name',
  'Drawee CardNo',
  'Channel',
  'Currency'
]);

const DOCUMENT_IDENTITY_FIELDS = Object.freeze(['userNo', 'accountNo', 'businessDepartment']);

const MANUAL_REASON_CODES = Object.freeze({
  BANK_REVERSAL_COUNT_NOT_ONE: 'duplicate-inbound-bank-reversal-count-not-one',
  BANK_INBOUND_COUNT_NOT_TWO: 'duplicate-inbound-bank-inbound-count-not-two',
  MPT_CANDIDATE_COUNT_ZERO: 'duplicate-inbound-mpt-candidate-count-zero',
  MPT_CANDIDATE_COUNT_MULTIPLE: 'duplicate-inbound-mpt-candidate-count-multiple',
  MPT_CANDIDATES_NOT_DISTINCT: 'duplicate-inbound-mpt-candidates-not-distinct',
  MPT_CANDIDATE_REUSED_ACROSS_GROUPS: 'duplicate-inbound-mpt-candidate-reused-across-groups',
  MPT_OPP_BU_EMPTY: 'duplicate-inbound-mpt-opp-bu-empty',
  MPT_OPP_BU_CONFLICT: 'duplicate-inbound-mpt-opp-bu-conflict',
  DOCUMENT_ORDER_ID_EMPTY: 'duplicate-inbound-document-order-id-empty',
  DOCUMENT_CANDIDATE_COUNT_ZERO: 'duplicate-inbound-document-candidate-count-zero',
  DOCUMENT_CANDIDATE_COUNT_MULTIPLE: 'duplicate-inbound-document-candidate-count-multiple',
  DOCUMENT_CANDIDATES_NOT_DISTINCT: 'duplicate-inbound-document-candidates-not-distinct',
  DOCUMENT_IDENTITY_FIELD_EMPTY: 'duplicate-inbound-document-identity-field-empty',
  DOCUMENT_IDENTITY_FIELDS_CONFLICT: 'duplicate-inbound-document-identity-fields-conflict',
  DOCUMENT_BUSINESS_DEPARTMENT_MISMATCH: 'duplicate-inbound-document-business-department-mismatch'
});

const ERROR_CODES = Object.freeze({
  EMPTY_AMOUNT: 'duplicate-inbound-empty-amount',
  INVALID_AMOUNT: 'duplicate-inbound-invalid-amount',
  INVALID_BANK_ROW: 'duplicate-inbound-invalid-bank-row',
  INVALID_CANDIDATE_GROUP: 'duplicate-inbound-invalid-candidate-group',
  INVALID_MPT_CANDIDATE_COLLECTION: 'duplicate-inbound-invalid-mpt-candidate-collection',
  INVALID_MPT_RAW_JSON: 'duplicate-inbound-invalid-mpt-raw-json',
  INVALID_DOCUMENT_CANDIDATE_COLLECTION: 'duplicate-inbound-invalid-document-candidate-collection',
  CONSERVATION_FAILED: 'duplicate-inbound-conservation-failed'
});

const MAX_DECIMAL_TEXT_LENGTH = 100000;

class DuplicateInboundMatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DuplicateInboundMatchError';
    this.code = code;
    Object.assign(this, details);
  }
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function originalText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function trimmedText(value) {
  return originalText(value).trim();
}

function renderErrorValue(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  try {
    return String(value);
  } catch (_error) {
    return '<无法转为字符串>';
  }
}

function amountError(code, value, context, reason) {
  const fieldName = context.fieldName || '金额';
  const bizId = originalText(context.bizId);
  const rowText = context.excelRowNumber === null || context.excelRowNumber === undefined
    ? ''
    : `，银行源行${context.excelRowNumber}`;
  const bizText = bizId === '' ? '' : `，BizId=${bizId}`;
  return new DuplicateInboundMatchError(
    code,
    `${fieldName}“${renderErrorValue(value)}”无效${rowText}${bizText}：${reason}`,
    {
      fieldName,
      value,
      fundType: context.fundType,
      bizId,
      sourceOrdinal: context.sourceOrdinal,
      excelRowNumber: context.excelRowNumber
    }
  );
}

/**
 * 将普通十进制金额规范为稳定字符串；不使用 Number 做金额等值比较。
 * 接受字符串、有限 number 和 bigint，拒绝指数、千分位、空值及其它类型。
 */
function normalizeDuplicateInboundAmount(value, context = {}) {
  if (value === null || value === undefined) {
    throw amountError(ERROR_CODES.EMPTY_AMOUNT, value, context, '相关金额不能为空');
  }
  if (!['string', 'number', 'bigint'].includes(typeof value)) {
    throw amountError(ERROR_CODES.INVALID_AMOUNT, value, context, '只接受普通十进制文本');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw amountError(ERROR_CODES.INVALID_AMOUNT, value, context, '不接受 NaN 或 Infinity');
  }

  const text = String(value).trim();
  if (text === '') {
    throw amountError(ERROR_CODES.EMPTY_AMOUNT, value, context, '相关金额不能为空');
  }
  if (text.length > MAX_DECIMAL_TEXT_LENGTH) {
    throw amountError(ERROR_CODES.INVALID_AMOUNT, value, context, '十进制文本过长');
  }

  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text);
  if (!match) {
    throw amountError(
      ERROR_CODES.INVALID_AMOUNT,
      value,
      context,
      '格式应为不含指数或千分位的普通十进制数'
    );
  }

  const negative = match[1] === '-';
  let integerPart = match[2] === undefined ? '0' : match[2];
  let fractionPart = match[2] === undefined ? match[4] : (match[3] || '');
  integerPart = integerPart.replace(/^0+/, '') || '0';
  fractionPart = fractionPart.replace(/0+$/, '');
  const unsigned = fractionPart === '' ? integerPart : `${integerPart}.${fractionPart}`;
  if (unsigned === '0') return '0';
  return negative ? `-${unsigned}` : unsigned;
}

function firstPresent(object, keys) {
  for (const key of keys) {
    if (!own(object, key)) continue;
    const value = object[key];
    if (value !== null && value !== undefined && originalText(value) !== '') return value;
  }
  return undefined;
}

function normalizeOrderValue(value, fallback) {
  if (value === null || value === undefined || originalText(value).trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unwrapBankEntry(entry, inputIndex) {
  if (!isObjectRecord(entry)) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_BANK_ROW,
      `银行输入第${inputIndex + 1}项必须是对象`,
      { inputIndex }
    );
  }
  const row = isObjectRecord(entry.row)
    ? entry.row
    : (isObjectRecord(entry.rawRow) ? entry.rawRow : entry);
  if (!isObjectRecord(row)) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_BANK_ROW,
      `银行输入第${inputIndex + 1}项未包含有效行对象`,
      { inputIndex }
    );
  }

  const sourceOrdinalValue = firstPresent(entry, ['sourceOrdinal', 'source_ordinal'])
    ?? firstPresent(row, ['_sourceOrdinal', 'sourceOrdinal', 'source_ordinal']);
  const excelRowValue = firstPresent(entry, ['excelRowNumber', 'sourceRowNumber', 'source_row_number'])
    ?? firstPresent(row, ['_excelRowNumber', 'excelRowNumber', 'sourceRowNumber']);
  const excelRowNumber = normalizeOrderValue(excelRowValue, null);
  const sourceOrdinal = normalizeOrderValue(
    sourceOrdinalValue,
    excelRowNumber === null ? inputIndex : excelRowNumber
  );
  return { row, sourceOrdinal, excelRowNumber, inputIndex };
}

function compareBankRecords(left, right) {
  return (left.sourceOrdinal - right.sourceOrdinal)
    || ((left.excelRowNumber ?? left.inputIndex) - (right.excelRowNumber ?? right.inputIndex))
    || (left.inputIndex - right.inputIndex);
}

function structuredKey(values) {
  return JSON.stringify(values);
}

function bankRowKey(record) {
  return structuredKey(['bank-row', record.bizId, record.sourceOrdinal, record.inputIndex]);
}

function addReasonCount(reasonCounts, codes) {
  for (const code of new Set(codes || [])) {
    reasonCounts[code] = (reasonCounts[code] || 0) + 1;
  }
}

function buildBankManualReasons(reversalCount, inboundCount) {
  const reasons = [];
  if (reversalCount !== 1) {
    reasons.push({
      code: MANUAL_REASON_CODES.BANK_REVERSAL_COUNT_NOT_ONE,
      reversalCount,
      inboundCount,
      message: `银行分组含${reversalCount}条 Reversal，要求恰好1条`
    });
  }
  if (inboundCount !== 2) {
    reasons.push({
      code: MANUAL_REASON_CODES.BANK_INBOUND_COUNT_NOT_TWO,
      reversalCount,
      inboundCount,
      message: `银行分组含${inboundCount}条 Inbound，要求恰好2条`
    });
  }
  return reasons;
}

function materializeBankGroup(group, stage, reasons = []) {
  const reversalRows = group.reversalRows.slice().sort(compareBankRecords);
  const inboundRows = group.inboundRows.slice().sort(compareBankRecords);
  const relatedRows = [...reversalRows, ...inboundRows].sort(compareBankRecords);
  return {
    groupKey: group.groupKey,
    amount: group.amount,
    payeeName: group.payeeName,
    payeeCardNo: group.payeeCardNo,
    draweeName: group.draweeName,
    draweeCardNo: group.draweeCardNo,
    channel: group.channel,
    currency: group.currency,
    reversalRows,
    inboundRows,
    relatedRows,
    firstSourceOrdinal: relatedRows[0].sourceOrdinal,
    firstInputIndex: relatedRows[0].inputIndex,
    stage,
    reasonCodes: [...new Set(reasons.map((reason) => reason.code))],
    reasons
  };
}

function compareGroups(left, right) {
  return (left.firstSourceOrdinal - right.firstSourceOrdinal)
    || (left.firstInputIndex - right.firstInputIndex)
    || String(left.groupKey).localeCompare(String(right.groupKey));
}

function assertIterable(value, label) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError(`${label}必须是可迭代对象`);
  }
  return value;
}

/**
 * 第一阶段：按金额及六个原值文本字段分组银行行。
 * 仅 1 Reversal + 2 Inbound 进入 candidate；含 Reversal 的其它形态整组转人工；纯 Inbound 只统计。
 */
function buildDuplicateInboundGroups(bankRows) {
  const groups = new Map();
  const stats = {
    inputRowCount: 0,
    relevantRowCount: 0,
    ignoredFundTypeRowCount: 0,
    reversalRowCount: 0,
    inboundRowCount: 0,
    groupCount: 0,
    candidateGroupCount: 0,
    candidateRowCount: 0,
    manualGroupCount: 0,
    manualRowCount: 0,
    pureInboundGroupCount: 0,
    pureInboundRowCount: 0,
    reasonCounts: {}
  };

  let inputIndex = 0;
  for (const entry of assertIterable(bankRows, 'bankRows')) {
    const unwrapped = unwrapBankEntry(entry, inputIndex);
    inputIndex += 1;
    stats.inputRowCount += 1;
    const fundType = trimmedText(unwrapped.row.FundType);
    if (fundType !== FUND_TYPES.REVERSAL && fundType !== FUND_TYPES.INBOUND) {
      stats.ignoredFundTypeRowCount += 1;
      continue;
    }

    const amountField = fundType === FUND_TYPES.REVERSAL ? 'Debit Amount' : 'Credit Amount';
    const bizId = originalText(unwrapped.row.BizId);
    const amount = normalizeDuplicateInboundAmount(unwrapped.row[amountField], {
      fieldName: amountField,
      fundType,
      bizId,
      sourceOrdinal: unwrapped.sourceOrdinal,
      excelRowNumber: unwrapped.excelRowNumber
    });
    const textValues = GROUP_TEXT_FIELDS.map((field) => originalText(unwrapped.row[field]));
    const groupKey = structuredKey([amount, ...textValues]);
    const record = {
      bankRowKey: '',
      bizId,
      fundType,
      amount,
      sourceOrdinal: unwrapped.sourceOrdinal,
      excelRowNumber: unwrapped.excelRowNumber,
      inputIndex: unwrapped.inputIndex,
      row: unwrapped.row
    };
    record.bankRowKey = bankRowKey(record);

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        amount,
        payeeName: textValues[0],
        payeeCardNo: textValues[1],
        draweeName: textValues[2],
        draweeCardNo: textValues[3],
        channel: textValues[4],
        currency: textValues[5],
        reversalRows: [],
        inboundRows: []
      });
    }
    const group = groups.get(groupKey);
    if (fundType === FUND_TYPES.REVERSAL) {
      group.reversalRows.push(record);
      stats.reversalRowCount += 1;
    } else {
      group.inboundRows.push(record);
      stats.inboundRowCount += 1;
    }
    stats.relevantRowCount += 1;
  }

  const candidateGroups = [];
  const manualGroups = [];
  for (const group of groups.values()) {
    const reversalCount = group.reversalRows.length;
    const inboundCount = group.inboundRows.length;
    if (reversalCount === 0) {
      stats.pureInboundGroupCount += 1;
      stats.pureInboundRowCount += inboundCount;
      continue;
    }
    if (reversalCount === 1 && inboundCount === 2) {
      const candidate = materializeBankGroup(group, 'bank-candidate');
      candidateGroups.push(candidate);
      stats.candidateGroupCount += 1;
      stats.candidateRowCount += candidate.relatedRows.length;
      continue;
    }

    const reasons = buildBankManualReasons(reversalCount, inboundCount);
    const manual = materializeBankGroup(group, 'bank-manual', reasons);
    manualGroups.push(manual);
    stats.manualGroupCount += 1;
    stats.manualRowCount += manual.relatedRows.length;
    addReasonCount(stats.reasonCounts, manual.reasonCodes);
  }

  candidateGroups.sort(compareGroups);
  manualGroups.sort(compareGroups);
  stats.groupCount = groups.size;
  const accountedRelevantRowCount = stats.candidateRowCount
    + stats.manualRowCount
    + stats.pureInboundRowCount;
  stats.conservation = {
    inputRowCount: stats.inputRowCount,
    classifiedInputRowCount: stats.relevantRowCount + stats.ignoredFundTypeRowCount,
    relevantRowCount: stats.relevantRowCount,
    accountedRelevantRowCount,
    isBalanced: stats.inputRowCount === stats.relevantRowCount + stats.ignoredFundTypeRowCount
      && stats.relevantRowCount === accountedRelevantRowCount
  };
  if (!stats.conservation.isBalanced) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.CONSERVATION_FAILED,
      '重复入金银行分组行数不守恒',
      { stats }
    );
  }

  return { candidateGroups, manualGroups, stats };
}

function lookupInboundCandidates(mapping, inboundRow, group) {
  if (mapping === null || mapping === undefined) return [];
  if (typeof mapping === 'function') return mapping(inboundRow, group);
  if (mapping instanceof Map) {
    if (mapping.has(inboundRow.bankRowKey)) return mapping.get(inboundRow.bankRowKey);
    if (inboundRow.bizId !== '' && mapping.has(inboundRow.bizId)) return mapping.get(inboundRow.bizId);
    if (mapping.has(inboundRow.row)) return mapping.get(inboundRow.row);
    return [];
  }
  if (isObjectRecord(mapping)) {
    if (own(mapping, inboundRow.bankRowKey)) return mapping[inboundRow.bankRowKey];
    if (inboundRow.bizId !== '' && own(mapping, inboundRow.bizId)) return mapping[inboundRow.bizId];
    return [];
  }
  throw new DuplicateInboundMatchError(
    ERROR_CODES.INVALID_MPT_CANDIDATE_COLLECTION,
    'mptCandidatesByInbound 必须是 Map、普通对象或函数'
  );
}

function candidateArray(value, inboundRow) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.slice();
  if (typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
    return Array.from(value);
  }
  throw new DuplicateInboundMatchError(
    ERROR_CODES.INVALID_MPT_CANDIDATE_COLLECTION,
    `BizId=${inboundRow.bizId} 的 MPT candidates 必须是可迭代对象`,
    { bankRowKey: inboundRow.bankRowKey, bizId: inboundRow.bizId }
  );
}

function rawMptValue(candidate) {
  if (own(candidate, 'rawJson')) return candidate.rawJson;
  if (own(candidate, 'raw_json')) return candidate.raw_json;
  if (own(candidate, 'row')) return candidate.row;
  return candidate;
}

function parseMptRawObject(candidate, context) {
  if (!isObjectRecord(candidate)) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_MPT_RAW_JSON,
      'MPT candidate 必须是对象',
      context
    );
  }
  const rawValue = rawMptValue(candidate);
  let rawObject;
  let rawJson;
  if (typeof rawValue === 'string') {
    rawJson = rawValue;
    try {
      rawObject = JSON.parse(rawValue);
    } catch (cause) {
      throw new DuplicateInboundMatchError(
        ERROR_CODES.INVALID_MPT_RAW_JSON,
        `MPT raw JSON 损坏（BizId=${context.bizId}）`,
        { ...context, cause }
      );
    }
  } else if (isObjectRecord(rawValue)) {
    rawObject = rawValue;
    try {
      rawJson = JSON.stringify(rawValue);
    } catch (cause) {
      throw new DuplicateInboundMatchError(
        ERROR_CODES.INVALID_MPT_RAW_JSON,
        `MPT raw JSON 无法序列化（BizId=${context.bizId}）`,
        { ...context, cause }
      );
    }
  } else {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_MPT_RAW_JSON,
      `MPT raw JSON 顶层必须是对象（BizId=${context.bizId}）`,
      context
    );
  }
  if (!isObjectRecord(rawObject)) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_MPT_RAW_JSON,
      `MPT raw JSON 顶层必须是对象（BizId=${context.bizId}）`,
      context
    );
  }
  return { rawJson, rawObject };
}

function explicitCandidateIdentity(candidate) {
  for (const field of ['candidateId', 'id', 'sourceRecordId', 'mptRowId']) {
    if (!own(candidate, field)) continue;
    const value = candidate[field];
    if (value === null || value === undefined || originalText(value) === '') continue;
    const namespace = field === 'candidateId'
      ? []
      : [candidate.monthKey, candidate.sourceType, candidate.sourceBatch];
    return {
      candidateId: value,
      candidateKey: structuredKey([
        'mpt-id',
        ...namespace.map(originalText),
        field,
        originalText(value)
      ])
    };
  }
  return null;
}

function locationCandidateKey(candidate) {
  const sourceRow = firstPresent(candidate, [
    'sourceRowNumber',
    'sourceOrdinal',
    'source_ordinal',
    'rowNumber'
  ]);
  if (sourceRow === undefined) return '';
  return structuredKey([
    'mpt-location',
    originalText(candidate.monthKey),
    originalText(candidate.sourceType),
    originalText(candidate.sourceBatch),
    originalText(candidate.sourceDate),
    originalText(candidate.sourceFileName || candidate.fileName),
    originalText(sourceRow)
  ]);
}

function candidateIdentity(candidate, identityState) {
  const explicitIdentity = explicitCandidateIdentity(candidate);
  if (explicitIdentity) return explicitIdentity;
  const locationKey = locationCandidateKey(candidate);
  if (locationKey !== '') return { candidateId: null, candidateKey: locationKey };
  if (!identityState.objectKeys.has(candidate)) {
    identityState.nextObjectKey += 1;
    identityState.objectKeys.set(
      candidate,
      structuredKey(['mpt-object', identityState.nextObjectKey])
    );
  }
  return { candidateId: null, candidateKey: identityState.objectKeys.get(candidate) };
}

function normalizeMptCandidate(candidate, identityState, context) {
  const { rawJson, rawObject } = parseMptRawObject(candidate, context);
  const identity = candidateIdentity(candidate, identityState);
  return {
    ...identity,
    oppBu: trimmedText(rawObject.oppBu),
    orderId: trimmedText(rawObject.orderId),
    rawJson,
    rawObject,
    sourceCandidate: candidate
  };
}

function validateCandidateGroup(group) {
  if (
    !isObjectRecord(group)
    || !Array.isArray(group.reversalRows)
    || !Array.isArray(group.inboundRows)
    || !Array.isArray(group.relatedRows)
    || group.reversalRows.length !== 1
    || group.inboundRows.length !== 2
  ) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_CANDIDATE_GROUP,
      '第二阶段只接受 1 Reversal + 2 Inbound 的 candidate group',
      { groupKey: group && group.groupKey }
    );
  }
}

function pushReason(state, code, details) {
  state.reasonCodeSet.add(code);
  state.reasons.push({ code, ...details });
}

function decorateAndSortGroups(groups) {
  return groups
    .map((group, inputIndex) => ({ group, inputIndex }))
    .sort((left, right) => compareGroups(left.group, right.group) || (left.inputIndex - right.inputIndex))
    .map(({ group }) => group);
}

function reasonCodesOf(group) {
  if (Array.isArray(group.reasonCodes)) return group.reasonCodes;
  if (Array.isArray(group.reasons)) return group.reasons.map((reason) => reason && reason.code).filter(Boolean);
  return [];
}

function groupRowCount(group) {
  return Array.isArray(group.relatedRows) ? group.relatedRows.length : 0;
}

/**
 * 第二阶段：解析每条 Inbound 的 MPT candidates，并执行唯一、不同、全局不复用及主体字段一致性校验。
 * 推荐传入第一阶段 groupingResult；也可单独传 candidateGroups、initialManualGroups 和 bankStats。
 * mptCandidatesByInbound 支持 Map（bankRowKey/BizId/原始行对象）、普通对象或 `(inboundRow) => iterable`。
 * MPT candidate 应提供全局稳定 candidateId；兼容 id+monthKey、来源定位，最后才回退到对象身份。
 */
function resolveDuplicateInboundMptMatches(options = {}) {
  const groupingResult = isObjectRecord(options.groupingResult) ? options.groupingResult : null;
  const candidateGroups = Array.from(assertIterable(
    options.candidateGroups ?? (groupingResult && groupingResult.candidateGroups) ?? [],
    'candidateGroups'
  ));
  const initialManualGroups = Array.from(assertIterable(
    options.initialManualGroups ?? (groupingResult && groupingResult.manualGroups) ?? [],
    'initialManualGroups'
  ));
  const bankStats = options.bankStats ?? (groupingResult && groupingResult.stats) ?? null;
  const sortedCandidates = decorateAndSortGroups(candidateGroups);
  const identityState = { objectKeys: new WeakMap(), nextObjectKey: 0 };
  const ownersByCandidateKey = new Map();

  const groupStates = sortedCandidates.map((group, groupIndex) => {
    validateCandidateGroup(group);
    const inboundRows = group.inboundRows.slice().sort(compareBankRecords);
    const inboundCandidateSets = inboundRows.map((inboundRow) => {
      const rawCandidates = candidateArray(
        lookupInboundCandidates(options.mptCandidatesByInbound, inboundRow, group),
        inboundRow
      );
      const candidates = rawCandidates.map((candidate, candidateIndex) => normalizeMptCandidate(
        candidate,
        identityState,
        {
          groupKey: group.groupKey,
          bankRowKey: inboundRow.bankRowKey,
          bizId: inboundRow.bizId,
          candidateIndex
        }
      ));
      for (const candidate of candidates) {
        if (!ownersByCandidateKey.has(candidate.candidateKey)) {
          ownersByCandidateKey.set(candidate.candidateKey, new Set());
        }
        ownersByCandidateKey.get(candidate.candidateKey).add(groupIndex);
      }
      return { inboundRow, candidates };
    });
    return {
      group,
      groupIndex,
      inboundCandidateSets,
      reasons: [],
      reasonCodeSet: new Set()
    };
  });

  const sharedCandidateKeys = new Set(
    [...ownersByCandidateKey.entries()]
      .filter(([, owners]) => owners.size > 1)
      .map(([candidateKey]) => candidateKey)
  );
  const finalSuccessGroups = [];
  const mptManualGroups = [];

  for (const state of groupStates) {
    for (const set of state.inboundCandidateSets) {
      if (set.candidates.length === 0) {
        pushReason(state, MANUAL_REASON_CODES.MPT_CANDIDATE_COUNT_ZERO, {
          bankRowKey: set.inboundRow.bankRowKey,
          bizId: set.inboundRow.bizId,
          candidateCount: 0,
          message: `Inbound BizId=${set.inboundRow.bizId} 未找到 MPT candidate`
        });
      } else if (set.candidates.length > 1) {
        pushReason(state, MANUAL_REASON_CODES.MPT_CANDIDATE_COUNT_MULTIPLE, {
          bankRowKey: set.inboundRow.bankRowKey,
          bizId: set.inboundRow.bizId,
          candidateCount: set.candidates.length,
          message: `Inbound BizId=${set.inboundRow.bizId} 找到${set.candidates.length}条 MPT candidates`
        });
      }
    }

    const sharedInGroup = [...new Set(
      state.inboundCandidateSets
        .flatMap((set) => set.candidates)
        .map((candidate) => candidate.candidateKey)
        .filter((candidateKey) => sharedCandidateKeys.has(candidateKey))
    )];
    if (sharedInGroup.length > 0) {
      pushReason(state, MANUAL_REASON_CODES.MPT_CANDIDATE_REUSED_ACROSS_GROUPS, {
        candidateKeys: sharedInGroup,
        message: 'MPT candidate 被多个银行分组共享，所有受影响分组均转人工'
      });
    }

    const exactlyOneEach = state.inboundCandidateSets.every((set) => set.candidates.length === 1);
    if (exactlyOneEach) {
      const first = state.inboundCandidateSets[0].candidates[0];
      const second = state.inboundCandidateSets[1].candidates[0];
      if (first.candidateKey === second.candidateKey) {
        pushReason(state, MANUAL_REASON_CODES.MPT_CANDIDATES_NOT_DISTINCT, {
          candidateKey: first.candidateKey,
          message: '两条 Inbound 指向同一条 MPT candidate'
        });
      }
      if (first.oppBu === '' || second.oppBu === '') {
        pushReason(state, MANUAL_REASON_CODES.MPT_OPP_BU_EMPTY, {
          firstOppBu: first.oppBu,
          secondOppBu: second.oppBu,
          message: '两条 MPT candidate 的 oppBu 均须非空'
        });
      }
      if (first.oppBu !== second.oppBu) {
        pushReason(state, MANUAL_REASON_CODES.MPT_OPP_BU_CONFLICT, {
          firstOppBu: first.oppBu,
          secondOppBu: second.oppBu,
          message: '两条 MPT candidate 的 oppBu 不一致'
        });
      }
    }

    const reasonCodes = [...state.reasonCodeSet];
    if (reasonCodes.length > 0) {
      mptManualGroups.push({
        ...state.group,
        stage: 'mpt-manual',
        reasonCodes,
        reasons: state.reasons,
        inboundCandidateSets: state.inboundCandidateSets
      });
      continue;
    }

    const inboundMatches = state.inboundCandidateSets.map((set) => ({
      inboundRow: set.inboundRow,
      mptCandidate: set.candidates[0]
    }));
    finalSuccessGroups.push({
      ...state.group,
      stage: 'success',
      reasonCodes: [],
      reasons: [],
      inboundMatches,
      commonMptFields: { oppBu: inboundMatches[0].mptCandidate.oppBu }
    });
  }

  finalSuccessGroups.sort(compareGroups);
  mptManualGroups.sort(compareGroups);
  const manualGroups = decorateAndSortGroups([...initialManualGroups, ...mptManualGroups]);
  const reasonCounts = {};
  for (const group of manualGroups) addReasonCount(reasonCounts, reasonCodesOf(group));

  const candidateRowCount = sortedCandidates.reduce((sum, group) => sum + groupRowCount(group), 0);
  const finalSuccessRowCount = finalSuccessGroups.reduce((sum, group) => sum + groupRowCount(group), 0);
  const mptManualRowCount = mptManualGroups.reduce((sum, group) => sum + groupRowCount(group), 0);
  const bankManualRowCount = initialManualGroups.reduce((sum, group) => sum + groupRowCount(group), 0);
  const manualRowCount = bankManualRowCount + mptManualRowCount;
  const accountedCandidateGroupCount = finalSuccessGroups.length + mptManualGroups.length;
  const accountedCandidateRowCount = finalSuccessRowCount + mptManualRowCount;
  const hasFullBankContext = Boolean(groupingResult)
    || (bankStats !== null && own(options, 'initialManualGroups'));
  const bankRelevantRowCount = hasFullBankContext ? Number(bankStats.relevantRowCount) : null;
  const pureInboundRowCount = hasFullBankContext ? Number(bankStats.pureInboundRowCount) : null;
  const accountedBankRelevantRowCount = hasFullBankContext
    ? finalSuccessRowCount + manualRowCount + pureInboundRowCount
    : null;
  const candidateBalanced = sortedCandidates.length === accountedCandidateGroupCount
    && candidateRowCount === accountedCandidateRowCount;
  const bankBalanced = !hasFullBankContext
    || bankRelevantRowCount === accountedBankRelevantRowCount;

  const stats = {
    candidateGroupCount: sortedCandidates.length,
    finalSuccessGroupCount: finalSuccessGroups.length,
    bankManualGroupCount: initialManualGroups.length,
    mptManualGroupCount: mptManualGroups.length,
    manualGroupCount: manualGroups.length,
    candidateRowCount,
    finalSuccessRowCount,
    bankManualRowCount,
    mptManualRowCount,
    manualRowCount,
    reasonCounts,
    conservation: {
      candidateGroupCount: sortedCandidates.length,
      accountedCandidateGroupCount,
      candidateRowCount,
      accountedCandidateRowCount,
      bankRelevantRowCount,
      accountedBankRelevantRowCount,
      pureInboundRowCount,
      isBalanced: candidateBalanced && bankBalanced
    }
  };
  if (!candidateBalanced || !bankBalanced) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.CONSERVATION_FAILED,
      '重复入金 MPT 解析结果不守恒',
      { stats }
    );
  }

  return { finalSuccessGroups, manualGroups, stats };
}

function lookupDocumentCandidateValue(mapping, orderId, inboundMatch, group) {
  if (mapping === null || mapping === undefined) return [];
  if (typeof mapping === 'function') return mapping(orderId, inboundMatch, group);
  if (mapping instanceof Map) return mapping.get(orderId) ?? [];
  if (isObjectRecord(mapping)) return own(mapping, orderId) ? mapping[orderId] : [];
  throw new DuplicateInboundMatchError(
    ERROR_CODES.INVALID_DOCUMENT_CANDIDATE_COLLECTION,
    'documentCandidatesByOrderId 必须是 Map、普通对象或函数'
  );
}

function normalizeDocumentCandidateCollection(value, orderId) {
  if (value === null || value === undefined) return { candidateCount: 0, candidates: [] };
  const source = Array.isArray(value)
    ? { candidateCount: value.length, candidates: value }
    : value;
  if (!isObjectRecord(source) || !Array.isArray(source.candidates)) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_DOCUMENT_CANDIDATE_COLLECTION,
      `加款单号=${orderId} 的单据 candidates 格式无效`
    );
  }
  const candidateCount = Number(source.candidateCount);
  if (!Number.isSafeInteger(candidateCount) || candidateCount < source.candidates.length) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_DOCUMENT_CANDIDATE_COLLECTION,
      `加款单号=${orderId} 的单据 candidateCount 无效`
    );
  }
  return { candidateCount, candidates: source.candidates.slice() };
}

function normalizeDocumentCandidate(candidate, identityState, context) {
  if (!isObjectRecord(candidate)) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_DOCUMENT_CANDIDATE_COLLECTION,
      `加款单号=${context.orderId} 的单据 candidate 必须是对象`
    );
  }
  let documentRowKey = '';
  const explicitId = firstPresent(candidate, ['documentRowKey', 'rowId', 'id']);
  if (explicitId !== undefined) {
    documentRowKey = structuredKey(['document-row-id', originalText(explicitId)]);
  } else {
    const excelRowNumber = firstPresent(candidate, ['excelRowNumber', 'sourceRowNumber']);
    const fileName = firstPresent(candidate, ['fileName', 'sourceFileName']);
    if (excelRowNumber !== undefined || fileName !== undefined) {
      documentRowKey = structuredKey([
        'document-location',
        originalText(fileName),
        originalText(excelRowNumber)
      ]);
    } else {
      if (!identityState.objectKeys.has(candidate)) {
        identityState.nextObjectKey += 1;
        identityState.objectKeys.set(candidate, structuredKey(['document-object', identityState.nextObjectKey]));
      }
      documentRowKey = identityState.objectKeys.get(candidate);
    }
  }
  return {
    documentRowKey,
    rowId: firstPresent(candidate, ['rowId', 'id']) ?? '',
    fileName: originalText(firstPresent(candidate, ['fileName', 'sourceFileName'])),
    sourceOrdinal: normalizeOrderValue(firstPresent(candidate, ['sourceOrdinal', 'source_ordinal']), null),
    excelRowNumber: normalizeOrderValue(firstPresent(candidate, ['excelRowNumber', 'sourceRowNumber']), null),
    businessOrderNo: originalText(firstPresent(candidate, ['businessOrderNo', '业务订单号'])),
    businessOrderKey: trimmedText(firstPresent(candidate, ['businessOrderKey', 'businessOrderNo', '业务订单号'])),
    userNo: trimmedText(firstPresent(candidate, ['userNo', '用户编号'])),
    accountNo: trimmedText(firstPresent(candidate, ['accountNo', '账户号'])),
    businessDepartment: trimmedText(firstPresent(candidate, ['businessDepartment', '业务部门'])),
    sourceCandidate: candidate
  };
}

function validateMptSuccessGroup(group) {
  validateCandidateGroup(group);
  if (!Array.isArray(group.inboundMatches) || group.inboundMatches.length !== 2) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.INVALID_CANDIDATE_GROUP,
      '单据阶段只接受含两条 MPT 匹配的成功组',
      { groupKey: group.groupKey }
    );
  }
}

/**
 * 第三阶段：以两条 MPT orderId 唯一匹配单据，校验单据身份字段并完成最终分流。
 */
function resolveDuplicateInboundDocumentMatches(options = {}) {
  const mptResult = isObjectRecord(options.mptResult) ? options.mptResult : null;
  const candidateGroups = Array.from(assertIterable(
    options.candidateGroups ?? (mptResult && mptResult.finalSuccessGroups) ?? [],
    'candidateGroups'
  ));
  const initialManualGroups = Array.from(assertIterable(
    options.initialManualGroups ?? (mptResult && mptResult.manualGroups) ?? [],
    'initialManualGroups'
  ));
  const mptStats = options.mptStats ?? (mptResult && mptResult.stats) ?? {};
  const bankStats = options.bankStats ?? null;
  const identityState = { objectKeys: new WeakMap(), nextObjectKey: 0 };
  const finalSuccessGroups = [];
  const documentManualGroups = [];

  for (const group of decorateAndSortGroups(candidateGroups)) {
    validateMptSuccessGroup(group);
    const state = { reasons: [], reasonCodeSet: new Set() };
    const inboundMatches = group.inboundMatches
      .slice()
      .sort((left, right) => compareBankRecords(left.inboundRow, right.inboundRow));
    const documentCandidateSets = inboundMatches.map((inboundMatch, matchIndex) => {
      const orderId = trimmedText(inboundMatch.mptCandidate.orderId);
      if (orderId === '') {
        pushReason(state, MANUAL_REASON_CODES.DOCUMENT_ORDER_ID_EMPTY, {
          matchIndex,
          bizId: inboundMatch.inboundRow.bizId,
          message: `Inbound BizId=${inboundMatch.inboundRow.bizId} 对应的 MPT 加款单号为空`
        });
        return { inboundMatch, orderId, candidateCount: 0, candidates: [] };
      }
      const collection = normalizeDocumentCandidateCollection(
        lookupDocumentCandidateValue(options.documentCandidatesByOrderId, orderId, inboundMatch, group),
        orderId
      );
      const candidates = collection.candidates.map((candidate) => normalizeDocumentCandidate(
        candidate,
        identityState,
        { orderId, groupKey: group.groupKey }
      ));
      if (collection.candidateCount === 0) {
        pushReason(state, MANUAL_REASON_CODES.DOCUMENT_CANDIDATE_COUNT_ZERO, {
          matchIndex,
          orderId,
          candidateCount: 0,
          message: `加款单号=${orderId} 未找到单据对账单`
        });
      } else if (collection.candidateCount > 1) {
        pushReason(state, MANUAL_REASON_CODES.DOCUMENT_CANDIDATE_COUNT_MULTIPLE, {
          matchIndex,
          orderId,
          candidateCount: collection.candidateCount,
          message: `加款单号=${orderId} 找到${collection.candidateCount}条单据对账单`
        });
      }
      return {
        inboundMatch,
        orderId,
        candidateCount: collection.candidateCount,
        candidates
      };
    });

    const exactlyOneEach = documentCandidateSets.every((set) => set.candidateCount === 1);
    if (exactlyOneEach) {
      const first = documentCandidateSets[0].candidates[0];
      const second = documentCandidateSets[1].candidates[0];
      if (!first || !second) {
        throw new DuplicateInboundMatchError(
          ERROR_CODES.INVALID_DOCUMENT_CANDIDATE_COLLECTION,
          '单据 candidateCount=1 时必须携带对应候选行'
        );
      }
      if (first.documentRowKey === second.documentRowKey) {
        pushReason(state, MANUAL_REASON_CODES.DOCUMENT_CANDIDATES_NOT_DISTINCT, {
          documentRowKey: first.documentRowKey,
          message: '两个加款单号命中同一条单据对账单'
        });
      }
      const emptyFields = DOCUMENT_IDENTITY_FIELDS.filter(
        (field) => first[field] === '' || second[field] === ''
      );
      if (emptyFields.length > 0) {
        pushReason(state, MANUAL_REASON_CODES.DOCUMENT_IDENTITY_FIELD_EMPTY, {
          emptyFields,
          message: `两条单据对账单的 ${emptyFields.join('/')} 均须非空`
        });
      }
      const conflictFields = DOCUMENT_IDENTITY_FIELDS.filter((field) => first[field] !== second[field]);
      if (conflictFields.length > 0) {
        pushReason(state, MANUAL_REASON_CODES.DOCUMENT_IDENTITY_FIELDS_CONFLICT, {
          conflictFields,
          message: `两条单据对账单的 ${conflictFields.join('/')} 不一致`
        });
      }
      const oppBu = trimmedText(group.commonMptFields && group.commonMptFields.oppBu);
      if (first.businessDepartment !== oppBu || second.businessDepartment !== oppBu) {
        pushReason(state, MANUAL_REASON_CODES.DOCUMENT_BUSINESS_DEPARTMENT_MISMATCH, {
          oppBu,
          firstBusinessDepartment: first.businessDepartment,
          secondBusinessDepartment: second.businessDepartment,
          message: '单据对账单业务部门与 MPT oppBu 不一致'
        });
      }
    }

    const reasonCodes = [...state.reasonCodeSet];
    if (reasonCodes.length > 0) {
      documentManualGroups.push({
        ...group,
        stage: 'document-manual',
        reasonCodes,
        reasons: state.reasons,
        inboundMatches,
        documentCandidateSets
      });
      continue;
    }

    const documentMatches = documentCandidateSets.map((set) => ({
      inboundMatch: set.inboundMatch,
      orderId: set.orderId,
      documentCandidate: set.candidates[0]
    }));
    finalSuccessGroups.push({
      ...group,
      stage: 'success',
      reasonCodes: [],
      reasons: [],
      inboundMatches,
      documentMatches,
      commonDocumentFields: Object.fromEntries(
        DOCUMENT_IDENTITY_FIELDS.map((field) => [field, documentMatches[0].documentCandidate[field]])
      )
    });
  }

  finalSuccessGroups.sort(compareGroups);
  documentManualGroups.sort(compareGroups);
  const manualGroups = decorateAndSortGroups([...initialManualGroups, ...documentManualGroups]);
  const reasonCounts = {};
  for (const group of manualGroups) addReasonCount(reasonCounts, reasonCodesOf(group));

  const finalSuccessRowCount = finalSuccessGroups.reduce((sum, group) => sum + groupRowCount(group), 0);
  const documentManualRowCount = documentManualGroups.reduce((sum, group) => sum + groupRowCount(group), 0);
  const initialManualRowCount = initialManualGroups.reduce((sum, group) => sum + groupRowCount(group), 0);
  const manualRowCount = initialManualRowCount + documentManualRowCount;
  const mptSuccessBalanced = candidateGroups.length === finalSuccessGroups.length + documentManualGroups.length;
  const hasFullBankContext = bankStats && Number.isFinite(Number(bankStats.relevantRowCount));
  const accountedBankRelevantRowCount = hasFullBankContext
    ? finalSuccessRowCount + manualRowCount + Number(bankStats.pureInboundRowCount || 0)
    : null;
  const bankBalanced = !hasFullBankContext
    || Number(bankStats.relevantRowCount) === accountedBankRelevantRowCount;
  const stats = {
    candidateGroupCount: Number(mptStats.candidateGroupCount ?? candidateGroups.length),
    mptSuccessGroupCount: candidateGroups.length,
    finalSuccessGroupCount: finalSuccessGroups.length,
    bankManualGroupCount: Number(mptStats.bankManualGroupCount || 0),
    mptManualGroupCount: Number(mptStats.mptManualGroupCount || 0),
    documentManualGroupCount: documentManualGroups.length,
    manualGroupCount: manualGroups.length,
    finalSuccessRowCount,
    bankManualRowCount: Number(mptStats.bankManualRowCount || 0),
    mptManualRowCount: Number(mptStats.mptManualRowCount || 0),
    documentManualRowCount,
    manualRowCount,
    reasonCounts,
    conservation: {
      mptSuccessGroupCount: candidateGroups.length,
      accountedMptSuccessGroupCount: finalSuccessGroups.length + documentManualGroups.length,
      bankRelevantRowCount: hasFullBankContext ? Number(bankStats.relevantRowCount) : null,
      accountedBankRelevantRowCount,
      pureInboundRowCount: hasFullBankContext ? Number(bankStats.pureInboundRowCount || 0) : null,
      isBalanced: mptSuccessBalanced && bankBalanced
    }
  };
  if (!stats.conservation.isBalanced) {
    throw new DuplicateInboundMatchError(
      ERROR_CODES.CONSERVATION_FAILED,
      '重复入金单据解析结果不守恒',
      { stats }
    );
  }
  return { finalSuccessGroups, manualGroups, documentManualGroups, stats };
}

module.exports = {
  FUND_TYPES,
  GROUP_TEXT_FIELDS,
  DOCUMENT_IDENTITY_FIELDS,
  MANUAL_REASON_CODES,
  ERROR_CODES,
  DuplicateInboundMatchError,
  normalizeDuplicateInboundAmount,
  buildDuplicateInboundGroups,
  resolveDuplicateInboundMptMatches,
  resolveDuplicateInboundDocumentMatches
};
