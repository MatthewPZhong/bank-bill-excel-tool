'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FUND_TYPES,
  MANUAL_REASON_CODES,
  ERROR_CODES,
  DuplicateInboundMatchError,
  normalizeDuplicateInboundAmount,
  buildDuplicateInboundGroups,
  resolveDuplicateInboundMptMatches,
  resolveDuplicateInboundDocumentMatches
} = require('../../../../src/main-process/duplicate-inbound-match/matching-engine');

function bankEntry({
  fundType,
  bizId,
  amount = '100.00',
  sourceOrdinal,
  channel = 'CH',
  currency = 'USD',
  payeeName = 'Payee',
  payeeCardNo = 'P-001',
  draweeName = 'Drawee',
  draweeCardNo = 'D-001',
  overrides = {}
}) {
  const row = {
    BizId: bizId,
    FundType: fundType,
    'Credit Amount': fundType && String(fundType).trim() === FUND_TYPES.INBOUND ? amount : '',
    'Debit Amount': fundType && String(fundType).trim() === FUND_TYPES.REVERSAL ? amount : '',
    'Payee Name': payeeName,
    'Payee CardNo': payeeCardNo,
    'Drawee Name': draweeName,
    'Drawee CardNo': draweeCardNo,
    Channel: channel,
    Currency: currency,
    ...overrides
  };
  return {
    sourceOrdinal,
    excelRowNumber: Number(sourceOrdinal) + 2,
    row
  };
}

function groupRows(prefix, sourceStart, overrides = {}) {
  return [
    bankEntry({
      fundType: FUND_TYPES.REVERSAL,
      bizId: `${prefix}-R`,
      sourceOrdinal: sourceStart,
      ...overrides
    }),
    bankEntry({
      fundType: FUND_TYPES.INBOUND,
      bizId: `${prefix}-I1`,
      sourceOrdinal: sourceStart + 1,
      ...overrides
    }),
    bankEntry({
      fundType: FUND_TYPES.INBOUND,
      bizId: `${prefix}-I2`,
      sourceOrdinal: sourceStart + 2,
      ...overrides
    })
  ];
}

function mptCandidate(id, overrides = {}, rawJsonOverride) {
  const rawObject = {
    business: 'BUSINESS',
    oppBu: 'OPP-BU',
    clientId: 'CLIENT',
    accId: 'ACCOUNT',
    orderId: `ORDER-${id}`,
    ...overrides
  };
  return {
    id,
    rawJson: rawJsonOverride === undefined ? JSON.stringify(rawObject) : rawJsonOverride
  };
}

function documentCandidate(id, orderId, overrides = {}) {
  return {
    rowId: id,
    fileName: 'document.xlsx',
    sourceOrdinal: Number(id) - 1,
    excelRowNumber: Number(id) + 1,
    businessOrderNo: orderId,
    businessOrderKey: orderId,
    userNo: ' DOCUMENT-USER ',
    accountNo: ' 000-DOCUMENT-ACCOUNT ',
    businessDepartment: ' OPP-BU ',
    ...overrides
  };
}

function buildSuccessfulMptResult(prefix = 'DOCUMENT') {
  const groupingResult = buildDuplicateInboundGroups(groupRows(prefix, 1));
  const candidates = candidateMapFor(groupingResult, (inboundRow) => [
    mptCandidate(inboundRow.bizId, {
      oppBu: ' OPP-BU ',
      orderId: inboundRow.bizId.endsWith('I1') ? ' ORDER-1 ' : ' ORDER-2 '
    })
  ]);
  return {
    groupingResult,
    mptResult: resolveDuplicateInboundMptMatches({
      groupingResult,
      mptCandidatesByInbound: candidates
    })
  };
}

function candidateMapFor(groupingResult, resolver) {
  const result = new Map();
  for (const group of groupingResult.candidateGroups) {
    for (const inboundRow of group.inboundRows) {
      result.set(inboundRow.bankRowKey, resolver(inboundRow, group));
    }
  }
  return result;
}

function expectModuleError(code) {
  return (error) => {
    assert.ok(error instanceof DuplicateInboundMatchError);
    assert.equal(error.code, code);
    return true;
  };
}

test('金额按十进制文本规范化且不经过浮点近似', () => {
  assert.equal(normalizeDuplicateInboundAmount('001.23000'), '1.23');
  assert.equal(normalizeDuplicateInboundAmount('+.5000'), '0.5');
  assert.equal(normalizeDuplicateInboundAmount('-000.000'), '0');
  assert.equal(
    normalizeDuplicateInboundAmount('900719925474099312345.12000'),
    '900719925474099312345.12'
  );
  assert.equal(normalizeDuplicateInboundAmount(12.5), '12.5');
});

test('相关金额为空或非法时抛带模块 code 的硬错误', () => {
  for (const value of [null, undefined, '', '   ']) {
    assert.throws(
      () => normalizeDuplicateInboundAmount(value),
      expectModuleError(ERROR_CODES.EMPTY_AMOUNT)
    );
  }
  for (const value of ['abc', '1e3', '1,000', NaN, Infinity, {}, []]) {
    assert.throws(
      () => normalizeDuplicateInboundAmount(value),
      expectModuleError(ERROR_CODES.INVALID_AMOUNT)
    );
  }
});

test('FundType 只在 trim 后大小写敏感识别，并只校验对应方向金额', () => {
  const rows = [
    bankEntry({
      fundType: ' Reversal ',
      bizId: 'R',
      amount: '10.00',
      sourceOrdinal: 1,
      overrides: { 'Credit Amount': '无关非法值' }
    }),
    bankEntry({
      fundType: ' Inbound ',
      bizId: 'I1',
      amount: '10',
      sourceOrdinal: 2,
      overrides: { 'Debit Amount': '无关非法值' }
    }),
    bankEntry({
      fundType: FUND_TYPES.INBOUND,
      bizId: 'I2',
      amount: '10.0',
      sourceOrdinal: 3
    }),
    bankEntry({
      fundType: 'reversal',
      bizId: 'IGNORED-LOWER',
      sourceOrdinal: 4,
      overrides: { 'Credit Amount': '坏', 'Debit Amount': '也坏' }
    }),
    bankEntry({
      fundType: 'Inbound ',
      bizId: 'IGNORED-UPPER',
      sourceOrdinal: 5,
      overrides: { FundType: 'INBOUND', 'Credit Amount': '坏' }
    })
  ];

  const result = buildDuplicateInboundGroups(rows);
  assert.equal(result.candidateGroups.length, 1);
  assert.equal(result.candidateGroups[0].amount, '10');
  assert.equal(result.stats.reversalRowCount, 1);
  assert.equal(result.stats.inboundRowCount, 2);
  assert.equal(result.stats.ignoredFundTypeRowCount, 2);
});

test('分组文本保留原值：null 为空、其余 String，不 trim 且大小写敏感', () => {
  const rows = [
    bankEntry({
      fundType: FUND_TYPES.REVERSAL,
      bizId: 'NULL-R',
      sourceOrdinal: 1,
      payeeName: null,
      payeeCardNo: 123
    }),
    bankEntry({
      fundType: FUND_TYPES.INBOUND,
      bizId: 'NULL-I1',
      sourceOrdinal: 2,
      payeeName: '',
      payeeCardNo: '123'
    }),
    bankEntry({
      fundType: FUND_TYPES.INBOUND,
      bizId: 'NULL-I2',
      sourceOrdinal: 3,
      payeeName: null,
      payeeCardNo: 123
    }),
    ...groupRows('SPACE', 20, { payeeName: ' ' }),
    ...groupRows('CASE-LOWER', 30, { payeeName: 'payee' }),
    ...groupRows('CASE-UPPER', 40, { payeeName: 'Payee' })
  ];
  const result = buildDuplicateInboundGroups(rows);

  assert.equal(result.candidateGroups.length, 4);
  const nullAndEmpty = result.candidateGroups.filter((group) => group.payeeName === '');
  assert.equal(nullAndEmpty.length, 1);
  assert.equal(nullAndEmpty[0].relatedRows.length, 3);
  assert.equal(nullAndEmpty[0].payeeCardNo, '123');
  assert.ok(result.candidateGroups.some((group) => group.payeeName === ' '));
  assert.ok(result.candidateGroups.some((group) => group.payeeName === 'payee'));
  assert.ok(result.candidateGroups.some((group) => group.payeeName === 'Payee'));
});

test('分组键使用结构化编码，特殊文本不会发生分隔符碰撞', () => {
  const result = buildDuplicateInboundGroups([
    ...groupRows('A', 1, { payeeName: 'a|b', payeeCardNo: 'c' }),
    ...groupRows('B', 10, { payeeName: 'a', payeeCardNo: 'b|c' })
  ]);
  assert.equal(result.candidateGroups.length, 2);
  for (const group of result.candidateGroups) {
    const decoded = JSON.parse(group.groupKey);
    assert.equal(decoded.length, 7);
    assert.equal(decoded[0], '100');
  }
  assert.notEqual(result.candidateGroups[0].groupKey, result.candidateGroups[1].groupKey);
});

test('Channel 和 Currency 均参与分组并严格隔离', () => {
  const result = buildDuplicateInboundGroups([
    ...groupRows('BASE', 1),
    ...groupRows('CHANNEL', 10, { channel: 'ch' }),
    ...groupRows('CURRENCY', 20, { currency: 'usd' })
  ]);
  assert.equal(result.candidateGroups.length, 3);
  assert.deepEqual(
    result.candidateGroups.map((group) => [group.channel, group.currency]),
    [['CH', 'USD'], ['ch', 'USD'], ['CH', 'usd']]
  );
});

test('BizId 不进入分组键，1 Reversal + 2 Inbound 形成 candidate', () => {
  const result = buildDuplicateInboundGroups(groupRows('BIZ', 1));
  assert.equal(result.candidateGroups.length, 1);
  assert.equal(result.manualGroups.length, 0);
  assert.deepEqual(
    result.candidateGroups[0].relatedRows.map((row) => row.bizId),
    ['BIZ-R', 'BIZ-I1', 'BIZ-I2']
  );
  assert.equal(result.stats.candidateGroupCount, 1);
  assert.equal(result.stats.candidateRowCount, 3);
});

test('可直接消费侧库读回的 _sourceOrdinal/_excelRowNumber 行形态', () => {
  const directRows = groupRows('SIDE-DB', 8)
    .map((entry) => ({
      ...entry.row,
      _sourceOrdinal: entry.sourceOrdinal,
      _excelRowNumber: entry.excelRowNumber
    }))
    .reverse();
  const result = buildDuplicateInboundGroups(directRows);
  assert.deepEqual(
    result.candidateGroups[0].relatedRows.map((row) => row.sourceOrdinal),
    [8, 9, 10]
  );
  assert.deepEqual(
    result.candidateGroups[0].relatedRows.map((row) => row.excelRowNumber),
    [10, 11, 12]
  );
});

test('1+0、1+1、1+3、2+N 均转人工并保留组内所有相关行', () => {
  const rows = [
    bankEntry({ fundType: FUND_TYPES.REVERSAL, bizId: '10-R', sourceOrdinal: 1, channel: '1+0' }),
    bankEntry({ fundType: FUND_TYPES.REVERSAL, bizId: '11-R', sourceOrdinal: 10, channel: '1+1' }),
    bankEntry({ fundType: FUND_TYPES.INBOUND, bizId: '11-I', sourceOrdinal: 11, channel: '1+1' }),
    bankEntry({ fundType: FUND_TYPES.REVERSAL, bizId: '13-R', sourceOrdinal: 20, channel: '1+3' }),
    ...[1, 2, 3].map((index) => bankEntry({
      fundType: FUND_TYPES.INBOUND,
      bizId: `13-I${index}`,
      sourceOrdinal: 20 + index,
      channel: '1+3'
    })),
    ...[1, 2].map((index) => bankEntry({
      fundType: FUND_TYPES.REVERSAL,
      bizId: `2N-R${index}`,
      sourceOrdinal: 30 + index,
      channel: '2+N'
    })),
    ...[1, 2].map((index) => bankEntry({
      fundType: FUND_TYPES.INBOUND,
      bizId: `2N-I${index}`,
      sourceOrdinal: 32 + index,
      channel: '2+N'
    }))
  ];

  const result = buildDuplicateInboundGroups(rows);
  assert.equal(result.candidateGroups.length, 0);
  assert.equal(result.manualGroups.length, 4);
  assert.deepEqual(result.manualGroups.map((group) => group.relatedRows.length), [1, 2, 4, 4]);
  assert.deepEqual(result.manualGroups.map((group) => group.firstSourceOrdinal), [1, 10, 20, 31]);
  assert.equal(
    result.stats.reasonCounts[MANUAL_REASON_CODES.BANK_INBOUND_COUNT_NOT_TWO],
    3
  );
  assert.equal(
    result.stats.reasonCounts[MANUAL_REASON_CODES.BANK_REVERSAL_COUNT_NOT_ONE],
    1
  );
});

test('纯 Inbound 分组只统计，不进入 candidate 或 manual', () => {
  const result = buildDuplicateInboundGroups([
    bankEntry({ fundType: FUND_TYPES.INBOUND, bizId: 'I1', sourceOrdinal: 1 }),
    bankEntry({ fundType: FUND_TYPES.INBOUND, bizId: 'I2', sourceOrdinal: 2 }),
    bankEntry({ fundType: FUND_TYPES.INBOUND, bizId: 'I3', sourceOrdinal: 3 })
  ]);
  assert.equal(result.candidateGroups.length, 0);
  assert.equal(result.manualGroups.length, 0);
  assert.equal(result.stats.pureInboundGroupCount, 1);
  assert.equal(result.stats.pureInboundRowCount, 3);
  assert.equal(result.stats.conservation.isBalanced, true);
});

test('MPT 每条 Inbound 恰好一条、两条候选不同且 oppBu 一致时成功', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('OK', 1));
  const candidates = candidateMapFor(groupingResult, (inboundRow) => [
    mptCandidate(inboundRow.bizId, {
      business: inboundRow.bizId.endsWith('I1') ? 'BUSINESS-A' : 'BUSINESS-B',
      oppBu: ' OPP-BU ',
      clientId: 'CLIENT ',
      accId: ' ACCOUNT',
      orderId: ''
    })
  ]);

  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.finalSuccessGroups.length, 1);
  assert.equal(result.manualGroups.length, 0);
  assert.deepEqual(result.finalSuccessGroups[0].commonMptFields, {
    oppBu: 'OPP-BU'
  });
  assert.deepEqual(
    result.finalSuccessGroups[0].inboundMatches.map((match) => match.mptCandidate.orderId),
    ['', '']
  );
  assert.equal(result.stats.conservation.isBalanced, true);
});

test('MPT oppBu 任一为空时整组转人工，orderId 留给单据阶段校验', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('EMPTY', 1));
  const candidates = candidateMapFor(groupingResult, (inboundRow) => [
    mptCandidate(inboundRow.bizId, {
      oppBu: inboundRow.bizId.endsWith('I1') ? null : ' ',
      clientId: '',
      accId: undefined,
      orderId: ''
    })
  ]);
  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.finalSuccessGroups.length, 0);
  assert.equal(result.manualGroups.length, 1);
  assert.ok(result.manualGroups[0].reasonCodes.includes(MANUAL_REASON_CODES.MPT_OPP_BU_EMPTY));
});

test('任一 Inbound 的 MPT 候选为 0 条时整组转人工', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('ZERO', 1));
  const candidates = candidateMapFor(groupingResult, (inboundRow) => (
    inboundRow.bizId.endsWith('I1') ? [] : [mptCandidate('ONLY')]
  ));
  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.finalSuccessGroups.length, 0);
  assert.equal(result.manualGroups.length, 1);
  assert.ok(result.manualGroups[0].reasonCodes.includes(MANUAL_REASON_CODES.MPT_CANDIDATE_COUNT_ZERO));
  assert.equal(result.stats.reasonCounts[MANUAL_REASON_CODES.MPT_CANDIDATE_COUNT_ZERO], 1);
});

test('任一 Inbound 的 MPT 候选为 N 条时整组转人工', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('MANY', 1));
  const candidates = candidateMapFor(groupingResult, (inboundRow) => (
    inboundRow.bizId.endsWith('I1')
      ? [mptCandidate('A'), mptCandidate('B')]
      : [mptCandidate('C')]
  ));
  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.finalSuccessGroups.length, 0);
  assert.ok(result.manualGroups[0].reasonCodes.includes(MANUAL_REASON_CODES.MPT_CANDIDATE_COUNT_MULTIPLE));
});

test('两条 Inbound 指向同一 MPT 候选时整组转人工', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('SAME', 1));
  const shared = mptCandidate('SHARED');
  const candidates = candidateMapFor(groupingResult, () => [shared]);
  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.finalSuccessGroups.length, 0);
  assert.ok(result.manualGroups[0].reasonCodes.includes(MANUAL_REASON_CODES.MPT_CANDIDATES_NOT_DISTINCT));
});

test('跨组共享 MPT 候选时所有受影响组都转人工，不做贪心占用', () => {
  const groupingResult = buildDuplicateInboundGroups([
    ...groupRows('LATE', 20, { channel: 'LATE' }),
    ...groupRows('EARLY', 1, { channel: 'EARLY' }),
    ...groupRows('MIDDLE', 10, { channel: 'MIDDLE' })
  ]);
  const sharedA = mptCandidate('SHARED-A');
  const sharedB = mptCandidate('SHARED-B');
  const candidates = candidateMapFor(groupingResult, (inboundRow) => {
    if (inboundRow.bizId === 'EARLY-I1' || inboundRow.bizId === 'MIDDLE-I1') return [sharedA];
    if (inboundRow.bizId === 'MIDDLE-I2' || inboundRow.bizId === 'LATE-I1') return [sharedB];
    return [mptCandidate(`UNIQUE-${inboundRow.bizId}`)];
  });

  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.finalSuccessGroups.length, 0);
  assert.equal(result.manualGroups.length, 3);
  assert.deepEqual(result.manualGroups.map((group) => group.firstSourceOrdinal), [1, 10, 20]);
  assert.ok(result.manualGroups.every((group) => (
    group.reasonCodes.includes(MANUAL_REASON_CODES.MPT_CANDIDATE_REUSED_ACROSS_GROUPS)
  )));
  assert.equal(
    result.stats.reasonCounts[MANUAL_REASON_CODES.MPT_CANDIDATE_REUSED_ACROSS_GROUPS],
    3
  );
});

test('显式相同 candidate id 即使包装对象不同也视为全运行复用', () => {
  const groupingResult = buildDuplicateInboundGroups([
    ...groupRows('A', 1, { channel: 'A' }),
    ...groupRows('B', 10, { channel: 'B' })
  ]);
  const candidates = candidateMapFor(groupingResult, (inboundRow) => {
    if (inboundRow.bizId === 'A-I1' || inboundRow.bizId === 'B-I1') {
      return [mptCandidate('SAME-ID')];
    }
    return [mptCandidate(inboundRow.bizId)];
  });
  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.manualGroups.length, 2);
});

test('MPT oppBu trim 后冲突转人工', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('OPP-BU-CONFLICT', 1));
  const candidates = candidateMapFor(groupingResult, (inboundRow) => [
    mptCandidate(inboundRow.bizId, {
      oppBu: inboundRow.bizId.endsWith('I1') ? ' VALUE ' : 'OTHER'
    })
  ]);
  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.finalSuccessGroups.length, 0);
  assert.ok(result.manualGroups[0].reasonCodes.includes(MANUAL_REASON_CODES.MPT_OPP_BU_CONFLICT));
});

test('MPT clientId/accId 冲突不再影响成功', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('MPT-LEGACY-FIELDS', 1));
  const candidates = candidateMapFor(groupingResult, (inboundRow) => [
    mptCandidate(inboundRow.bizId, {
      oppBu: 'OPP-BU',
      clientId: inboundRow.bizId.endsWith('I1') ? 'CLIENT-A' : 'CLIENT-B',
      accId: inboundRow.bizId.endsWith('I1') ? 'ACCOUNT-A' : 'ACCOUNT-B'
    })
  ]);
  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.equal(result.finalSuccessGroups.length, 1);
  assert.deepEqual(result.finalSuccessGroups[0].commonMptFields, { oppBu: 'OPP-BU' });
});

test('单据按两条 MPT orderId 唯一命中不同记录并提供最终客户、账户和业务部门', () => {
  const { groupingResult, mptResult } = buildSuccessfulMptResult();
  const documents = new Map([
    ['ORDER-1', [documentCandidate(1, 'ORDER-1')]],
    ['ORDER-2', [documentCandidate(2, 'ORDER-2')]]
  ]);
  const result = resolveDuplicateInboundDocumentMatches({
    mptResult,
    bankStats: groupingResult.stats,
    documentCandidatesByOrderId: documents
  });

  assert.equal(result.finalSuccessGroups.length, 1);
  assert.equal(result.manualGroups.length, 0);
  assert.deepEqual(result.finalSuccessGroups[0].commonDocumentFields, {
    userNo: 'DOCUMENT-USER',
    accountNo: '000-DOCUMENT-ACCOUNT',
    businessDepartment: 'OPP-BU'
  });
  assert.deepEqual(
    result.finalSuccessGroups[0].documentMatches.map((match) => match.orderId),
    ['ORDER-1', 'ORDER-2']
  );
  assert.equal(result.stats.conservation.isBalanced, true);
});

test('MPT orderId 为空时仅对应银行组转人工', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('EMPTY-ORDER', 1));
  const candidates = candidateMapFor(groupingResult, (inboundRow) => [
    mptCandidate(inboundRow.bizId, {
      oppBu: 'OPP-BU',
      orderId: inboundRow.bizId.endsWith('I1') ? ' ' : 'ORDER-2'
    })
  ]);
  const mptResult = resolveDuplicateInboundMptMatches({
    groupingResult,
    mptCandidatesByInbound: candidates
  });
  const result = resolveDuplicateInboundDocumentMatches({
    mptResult,
    bankStats: groupingResult.stats,
    documentCandidatesByOrderId: new Map([
      ['ORDER-2', [documentCandidate(2, 'ORDER-2')]]
    ])
  });

  assert.equal(result.finalSuccessGroups.length, 0);
  assert.equal(result.documentManualGroups.length, 1);
  assert.ok(result.manualGroups[0].reasonCodes.includes(MANUAL_REASON_CODES.DOCUMENT_ORDER_ID_EMPTY));
  assert.equal(result.stats.conservation.isBalanced, true);
});

test('单据零候选、多候选或两个单号命中同一行时整组转人工', async (t) => {
  await t.test('零候选', () => {
    const { groupingResult, mptResult } = buildSuccessfulMptResult('DOCUMENT-ZERO');
    const result = resolveDuplicateInboundDocumentMatches({
      mptResult,
      bankStats: groupingResult.stats,
      documentCandidatesByOrderId: new Map([
        ['ORDER-2', [documentCandidate(2, 'ORDER-2')]]
      ])
    });
    assert.ok(result.manualGroups[0].reasonCodes.includes(
      MANUAL_REASON_CODES.DOCUMENT_CANDIDATE_COUNT_ZERO
    ));
  });

  await t.test('多候选按真实 candidateCount 判定', () => {
    const { groupingResult, mptResult } = buildSuccessfulMptResult('DOCUMENT-MULTIPLE');
    const result = resolveDuplicateInboundDocumentMatches({
      mptResult,
      bankStats: groupingResult.stats,
      documentCandidatesByOrderId: new Map([
        ['ORDER-1', {
          candidateCount: 3,
          candidates: [documentCandidate(1, 'ORDER-1'), documentCandidate(3, 'ORDER-1')]
        }],
        ['ORDER-2', [documentCandidate(2, 'ORDER-2')]]
      ])
    });
    assert.ok(result.manualGroups[0].reasonCodes.includes(
      MANUAL_REASON_CODES.DOCUMENT_CANDIDATE_COUNT_MULTIPLE
    ));
  });

  await t.test('不同单号命中同一单据行', () => {
    const { groupingResult, mptResult } = buildSuccessfulMptResult('DOCUMENT-SAME');
    const first = documentCandidate(1, 'ORDER-1');
    const sameRow = documentCandidate(1, 'ORDER-2');
    const result = resolveDuplicateInboundDocumentMatches({
      mptResult,
      bankStats: groupingResult.stats,
      documentCandidatesByOrderId: new Map([
        ['ORDER-1', [first]],
        ['ORDER-2', [sameRow]]
      ])
    });
    assert.ok(result.manualGroups[0].reasonCodes.includes(
      MANUAL_REASON_CODES.DOCUMENT_CANDIDATES_NOT_DISTINCT
    ));
  });
});

test('单据身份字段为空、冲突或业务部门与 oppBu 不一致时整组转人工', async (t) => {
  const cases = [
    {
      name: '字段为空',
      firstOverrides: { userNo: ' ' },
      secondOverrides: { userNo: '' },
      reasonCode: MANUAL_REASON_CODES.DOCUMENT_IDENTITY_FIELD_EMPTY
    },
    {
      name: '字段冲突',
      firstOverrides: { accountNo: 'ACCOUNT-A' },
      secondOverrides: { accountNo: 'ACCOUNT-B' },
      reasonCode: MANUAL_REASON_CODES.DOCUMENT_IDENTITY_FIELDS_CONFLICT
    },
    {
      name: '业务部门与 oppBu 不一致',
      firstOverrides: { businessDepartment: 'OTHER-BU' },
      secondOverrides: { businessDepartment: 'OTHER-BU' },
      reasonCode: MANUAL_REASON_CODES.DOCUMENT_BUSINESS_DEPARTMENT_MISMATCH
    }
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const { groupingResult, mptResult } = buildSuccessfulMptResult(`IDENTITY-${item.name}`);
      const result = resolveDuplicateInboundDocumentMatches({
        mptResult,
        bankStats: groupingResult.stats,
        documentCandidatesByOrderId: new Map([
          ['ORDER-1', [documentCandidate(1, 'ORDER-1', item.firstOverrides)]],
          ['ORDER-2', [documentCandidate(2, 'ORDER-2', item.secondOverrides)]]
        ])
      });
      assert.equal(result.finalSuccessGroups.length, 0);
      assert.ok(result.manualGroups[0].reasonCodes.includes(item.reasonCode));
      assert.equal(result.stats.conservation.isBalanced, true);
    });
  }
});

test('MPT raw JSON 损坏或顶层非对象时抛硬错误', () => {
  for (const rawJson of ['{broken', '[]', 'null', '"text"']) {
    const groupingResult = buildDuplicateInboundGroups(groupRows(`RAW-${rawJson}`, 1));
    let first = true;
    const candidates = candidateMapFor(groupingResult, (inboundRow) => {
      if (first) {
        first = false;
        return [mptCandidate(inboundRow.bizId, {}, rawJson)];
      }
      return [mptCandidate(inboundRow.bizId)];
    });
    assert.throws(
      () => resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates }),
      expectModuleError(ERROR_CODES.INVALID_MPT_RAW_JSON)
    );
  }
});

test('两阶段均不修改银行输入、candidate groups 或 MPT candidates', () => {
  const bankRows = groupRows('PURE', 1);
  const bankSnapshot = structuredClone(bankRows);
  const groupingResult = buildDuplicateInboundGroups(bankRows);
  assert.deepEqual(bankRows, bankSnapshot);

  const first = mptCandidate('PURE-1');
  const second = mptCandidate('PURE-2');
  const mptSnapshot = structuredClone([first, second]);
  const candidates = new Map([
    [groupingResult.candidateGroups[0].inboundRows[0].bankRowKey, [first]],
    [groupingResult.candidateGroups[0].inboundRows[1].bankRowKey, [second]]
  ]);
  const groupSnapshot = structuredClone(groupingResult);
  resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });
  assert.deepEqual(groupingResult, groupSnapshot);
  assert.deepEqual([first, second], mptSnapshot);
});

test('分组与最终结果均按银行源行稳定排序，并保持全链路行守恒', () => {
  const successRows = groupRows('SUCCESS', 10, { channel: 'SUCCESS' });
  const mptManualRows = groupRows('MPT-MANUAL', 30, { channel: 'MPT-MANUAL' });
  const bankManualRows = [
    bankEntry({ fundType: FUND_TYPES.REVERSAL, bizId: 'BANK-R', sourceOrdinal: 20, channel: 'BANK-MANUAL' }),
    bankEntry({ fundType: FUND_TYPES.INBOUND, bizId: 'BANK-I', sourceOrdinal: 21, channel: 'BANK-MANUAL' })
  ];
  const pureInboundRows = [
    bankEntry({ fundType: FUND_TYPES.INBOUND, bizId: 'PURE-I1', sourceOrdinal: 40, channel: 'PURE' }),
    bankEntry({ fundType: FUND_TYPES.INBOUND, bizId: 'PURE-I2', sourceOrdinal: 41, channel: 'PURE' })
  ];
  const ignored = bankEntry({ fundType: 'Other', bizId: 'IGNORED', sourceOrdinal: 50, channel: 'IGNORED' });
  const input = [
    ...mptManualRows.slice().reverse(),
    ignored,
    ...pureInboundRows.slice().reverse(),
    ...bankManualRows.slice().reverse(),
    ...successRows.slice().reverse()
  ];
  const groupingResult = buildDuplicateInboundGroups(input);

  assert.deepEqual(groupingResult.candidateGroups.map((group) => group.firstSourceOrdinal), [10, 30]);
  assert.equal(groupingResult.stats.inputRowCount, 11);
  assert.equal(groupingResult.stats.relevantRowCount, 10);
  assert.equal(groupingResult.stats.candidateRowCount, 6);
  assert.equal(groupingResult.stats.manualRowCount, 2);
  assert.equal(groupingResult.stats.pureInboundRowCount, 2);
  assert.equal(groupingResult.stats.conservation.accountedRelevantRowCount, 10);
  assert.equal(groupingResult.stats.conservation.isBalanced, true);

  const candidates = candidateMapFor(groupingResult, (inboundRow) => (
    inboundRow.bizId.startsWith('MPT-MANUAL')
      ? []
      : [mptCandidate(inboundRow.bizId)]
  ));
  const result = resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates });

  assert.deepEqual(result.finalSuccessGroups.map((group) => group.firstSourceOrdinal), [10]);
  assert.deepEqual(result.manualGroups.map((group) => group.firstSourceOrdinal), [20, 30]);
  assert.equal(result.stats.finalSuccessRowCount, 3);
  assert.equal(result.stats.manualRowCount, 5);
  assert.equal(result.stats.conservation.candidateGroupCount, 2);
  assert.equal(result.stats.conservation.accountedCandidateGroupCount, 2);
  assert.equal(result.stats.conservation.bankRelevantRowCount, 10);
  assert.equal(result.stats.conservation.accountedBankRelevantRowCount, 10);
  assert.equal(result.stats.conservation.isBalanced, true);
  assert.equal(
    result.stats.reasonCounts[MANUAL_REASON_CODES.BANK_INBOUND_COUNT_NOT_TWO],
    1
  );
  assert.equal(
    result.stats.reasonCounts[MANUAL_REASON_CODES.MPT_CANDIDATE_COUNT_ZERO],
    1
  );
});

test('第二阶段发现银行全局行数不守恒时硬失败', () => {
  const groupingResult = buildDuplicateInboundGroups(groupRows('BROKEN-CONSERVATION', 1));
  groupingResult.stats.relevantRowCount += 1;
  const candidates = candidateMapFor(groupingResult, (inboundRow) => [
    mptCandidate(inboundRow.bizId)
  ]);
  assert.throws(
    () => resolveDuplicateInboundMptMatches({ groupingResult, mptCandidatesByInbound: candidates }),
    expectModuleError(ERROR_CODES.CONSERVATION_FAILED)
  );
});
