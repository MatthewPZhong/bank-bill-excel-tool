'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOURCE_TYPES,
  getSourceDefinition,
  normalizeLegacyStoredCurrency
} = require('../../../../src/backend/vcc-financial-op/definitions');
const {
  HASH_VERSION,
  PENDING_HASH_VERSION,
  mapDetailRow,
  monthEndIso
} = require('../../../../src/backend/vcc-financial-op/row-mapper');

function valuesFor(sourceType, fields) {
  const definition = getSourceDefinition(sourceType);
  return definition.headers.map((header) => Object.hasOwn(fields, header) ? fields[header] : '');
}

function map(sourceType, fields, options = {}) {
  return mapDetailRow({
    sourceType,
    values: valuesFor(sourceType, fields),
    targetMonth: options.targetMonth || '2026-06',
    assignedSubject: options.assignedSubject,
    sourceFile: options.sourceFile || 'sample.xlsx',
    sheetName: 'sheet1',
    sourceRow: 2,
    keyCellType: options.keyCellType
  });
}

test('非通道明细保留前导零业务键，并按 in/out 生成有符号发生额', () => {
  const inbound = map(SOURCE_TYPES.RECHARGE, {
    订单号: ' 000123 ',
    BillDate: '2026-06-09',
    公司主体: 'PPHK',
    出入方向: 'in',
    我方币种: 'USD',
    我方到账金额: '1.25',
    业务部门: 'VCC',
    对手部门: 'OPS',
    业务子类型: '充值'
  });
  const outbound = map(SOURCE_TYPES.FEE_FX, {
    订单号: '9',
    BillDate: '2026-06-09',
    公司主体: 'PPHK',
    出入方向: 'out',
    我方币种: 'EUR',
    我方到账金额: '2.50',
    业务部门: 'VCC',
    业务子类型: '手续费'
  });

  assert.equal(inbound.idempotencyKeyRaw, ' 000123 ');
  assert.equal(inbound.idempotencyKey, '000123');
  assert.equal(inbound.signedAmount, '1.25');
  assert.equal(outbound.signedAmount, '-2.5');
  assert.equal(inbound.disposition, null);
});

test('通道 CITI 使用交易金额，非 CITI 按 billdate 月末分支取值', () => {
  const common = {
    账单日期: '2026-06-13',
    渠道订单号: 'channel-1',
    借贷方向: 'out',
    MID: 'MID-1'
  };
  const citi = map(SOURCE_TYPES.CHANNEL, {
    ...common,
    通道名称: 'CITI',
    交易金额: '2.3842323E7',
    交易币种: 'USD'
  }, { assignedSubject: 'PPHK' });
  const beforeMonthEnd = map(SOURCE_TYPES.CHANNEL, {
    ...common,
    渠道订单号: 'channel-2',
    通道名称: 'HIGHNOTE',
    billdate: '2026-06-30',
    结算币种: 'USD',
    实际到账金额: '12.60',
    清算币种: 'EUR',
    清算金额: '999'
  }, { assignedSubject: 'PPHK' });
  const afterMonthEnd = map(SOURCE_TYPES.CHANNEL, {
    ...common,
    渠道订单号: 'channel-3',
    通道名称: 'HIGHNOTE',
    billdate: '2026-07-01',
    结算币种: 'USD',
    实际到账金额: '12.60',
    清算币种: 'EUR',
    清算金额: '8.75'
  }, { assignedSubject: 'PPHK' });

  assert.equal(monthEndIso('2026-06'), '2026-06-30');
  assert.equal(citi.statCurrency, 'USD');
  assert.equal(citi.signedAmount, '-23842323');
  assert.equal(beforeMonthEnd.statCurrency, 'USD');
  assert.equal(beforeMonthEnd.signedAmount, '-12.6');
  assert.equal(afterMonthEnd.statCurrency, 'EUR');
  assert.equal(afterMonthEnd.signedAmount, '-8.75');
});

test('Pending credit/debit 两侧金额方向和错币标识符合 spec', () => {
  const credit = map(SOURCE_TYPES.PENDING, {
    PendingBizId: 'pending-1',
    平账账期: '2026-06-01',
    主体: 'PPHK',
    对账类型: 'VCC_clearing_credit',
    channel: 'CITI',
    金额: '16.55',
    币种: 'USD',
    流水_币种: 'USD',
    流水_对账金额: '16.55'
  });
  const debit = map(SOURCE_TYPES.PENDING, {
    PendingBizId: 'pending-2',
    平账账期: '2026-06-01',
    主体: 'PPHK',
    对账类型: 'VCC_clearing_debit',
    channel: 'CITI',
    金额: '3.78',
    币种: 'EUR',
    流水_币种: 'USD',
    流水_对账金额: '3.78'
  });

  assert.equal(credit.pendingAmount, '-16.55');
  assert.equal(credit.flowAmount, '16.55');
  assert.equal(credit.currencyMismatch, 0);
  assert.equal(debit.pendingAmount, '3.78');
  assert.equal(debit.flowAmount, '-3.78');
  assert.equal(debit.currencyMismatch, 1);
});

test('零值、负值、空金额和未知 Pending 类型按显式公式或异常处理', () => {
  const zeroInbound = map(SOURCE_TYPES.RECHARGE, {
    订单号: 'zero-in', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'USD', 我方到账金额: '0'
  });
  const negativeOutbound = map(SOURCE_TYPES.RECHARGE, {
    订单号: 'negative-out', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'out', 我方币种: 'USD', 我方到账金额: '-2.5'
  });
  const blankAmount = map(SOURCE_TYPES.RECHARGE, {
    订单号: 'blank-amount', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'USD', 我方到账金额: ''
  });
  const negativePending = map(SOURCE_TYPES.PENDING, {
    PendingBizId: 'negative-pending', 平账账期: '2026-06', 主体: 'PPHK',
    对账类型: 'VCC_clearing_credit', 金额: '-3', 币种: 'USD',
    流水_币种: 'USD', 流水_对账金额: '-4'
  });
  const unknownPendingType = map(SOURCE_TYPES.PENDING, {
    PendingBizId: 'unknown-pending', 平账账期: '2026-06', 主体: 'PPHK',
    对账类型: '入金', 金额: '3', 币种: 'USD',
    流水_币种: 'USD', 流水_对账金额: '4'
  });

  assert.equal(zeroInbound.signedAmount, '0');
  assert.equal(negativeOutbound.signedAmount, '2.5');
  assert.equal(blankAmount.disposition, 'format_error');
  assert.match(blankAmount.validationMessage, /值不能为空/);
  assert.equal(negativePending.pendingAmount, '3');
  assert.equal(negativePending.flowAmount, '-4');
  assert.equal(unknownPendingType.disposition, 'format_error');
  assert.match(unknownPendingType.validationMessage, /对账类型仅允许/);
});

test('空业务键、跨账期、未知方向和非标准大小写币种进入互斥异常类别', () => {
  const blankKey = map(SOURCE_TYPES.RECHARGE, {
    订单号: ' ', BillDate: '2026-06-01', 公司主体: 'PPHK'
  });
  const wrongMonth = map(SOURCE_TYPES.RECHARGE, {
    订单号: '1', BillDate: '2026-05-31', 公司主体: 'PPHK'
  });
  const badDirection = map(SOURCE_TYPES.RECHARGE, {
    订单号: '2', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'IN', 我方币种: 'USD', 我方到账金额: '1'
  });
  const cnyCurrency = map(SOURCE_TYPES.RECHARGE, {
    订单号: '3', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'CNY', 我方到账金额: '1'
  });
  const lowerCnhCurrency = map(SOURCE_TYPES.RECHARGE, {
    订单号: '4', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'cnh', 我方到账金额: '1'
  });
  const mixedCnhCurrency = map(SOURCE_TYPES.RECHARGE, {
    订单号: '5', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'Cnh', 我方到账金额: '1'
  });

  assert.equal(blankKey.disposition, 'invalid_key');
  assert.equal(wrongMonth.disposition, 'format_error');
  assert.equal(badDirection.disposition, 'format_error');
  assert.equal(cnyCurrency.disposition, null);
  assert.equal(cnyCurrency.statCurrency, 'CNY');
  assert.equal(lowerCnhCurrency.disposition, 'format_error');
  assert.match(lowerCnhCurrency.validationMessage, /cnh.*不在支持币种/);
  assert.equal(mixedCnhCurrency.disposition, 'format_error');
  assert.match(mixedCnhCurrency.validationMessage, /Cnh.*不在支持币种/);
});

test('非通道 CNH 在业务层归一 CNY，raw audit 保留原值且规范哈希兼容 CNY', () => {
  const common = {
    订单号: 'cnh-non-channel', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方到账金额: '12.34'
  };
  const cnh = map(SOURCE_TYPES.RECHARGE, { ...common, 我方币种: ' CNH ' });
  const cny = map(SOURCE_TYPES.RECHARGE, { ...common, 我方币种: ' CNY ' });
  const differentSpacing = map(SOURCE_TYPES.RECHARGE, { ...common, 我方币种: 'CNY' });

  assert.equal(cnh.disposition, null);
  assert.equal(cnh.statCurrency, 'CNY');
  assert.equal(cnh.hashVersion, HASH_VERSION);
  assert.equal(HASH_VERSION, 2);
  assert.equal(JSON.parse(cnh.rawJson)[cnh.definition.indexes.我方币种], ' CNH ');
  assert.equal(cnh.contentHash, cny.contentHash);
  assert.notEqual(cnh.contentHash, differentSpacing.contentHash);
});

test('通道只归一实际参与业务的交易、清算或结算币种列', () => {
  const common = {
    账单日期: '2026-06-13', 借贷方向: 'in', MID: 'MID-CNH'
  };
  const citiCnh = map(SOURCE_TYPES.CHANNEL, {
    ...common, 渠道订单号: 'citi-cnh', 通道名称: 'CITI',
    交易金额: '10', 交易币种: 'CNH', 清算币种: 'cnh', 结算币种: 'BAD'
  }, { assignedSubject: 'PPHK' });
  const citiCny = map(SOURCE_TYPES.CHANNEL, {
    ...common, 渠道订单号: 'citi-cnh', 通道名称: 'CITI',
    交易金额: '10', 交易币种: 'CNY', 清算币种: 'cnh', 结算币种: 'BAD'
  }, { assignedSubject: 'PPHK' });
  const clearing = map(SOURCE_TYPES.CHANNEL, {
    ...common, 渠道订单号: 'clearing-cnh', 通道名称: 'HIGHNOTE', billdate: '2026-07-01',
    清算金额: '20', 清算币种: 'CNH', 交易币种: 'bad', 结算币种: 'cnh'
  }, { assignedSubject: 'PPHK' });
  const settlement = map(SOURCE_TYPES.CHANNEL, {
    ...common, 渠道订单号: 'settlement-cnh', 通道名称: 'HIGHNOTE', billdate: '2026-06-30',
    实际到账金额: '30', 结算币种: 'CNH', 交易币种: 'bad', 清算币种: 'cnh'
  }, { assignedSubject: 'PPHK' });
  const unusedSpellingChanged = map(SOURCE_TYPES.CHANNEL, {
    ...common, 渠道订单号: 'citi-cnh', 通道名称: 'CITI',
    交易金额: '10', 交易币种: 'CNY', 清算币种: 'CNH', 结算币种: 'BAD'
  }, { assignedSubject: 'PPHK' });

  assert.deepEqual(
    [citiCnh, clearing, settlement].map((row) => [row.disposition, row.statCurrency, row.signedAmount]),
    [[null, 'CNY', '10'], [null, 'CNY', '20'], [null, 'CNY', '30']]
  );
  assert.equal(citiCnh.contentHash, citiCny.contentHash);
  assert.notEqual(citiCny.contentHash, unusedSpellingChanged.contentHash);
});

test('VCC 参与币种字段矩阵仅接受 trim 后大写 CNY/CNH', () => {
  const cases = [
    {
      label: 'recharge 我方币种',
      sourceType: SOURCE_TYPES.RECHARGE,
      fields: { 订单号: 'matrix-recharge', BillDate: '2026-06-01', 公司主体: 'PPHK', 出入方向: 'in', 我方到账金额: '1' },
      field: '我方币种'
    },
    {
      label: 'fee_fx 我方币种',
      sourceType: SOURCE_TYPES.FEE_FX,
      fields: { 订单号: 'matrix-fee', BillDate: '2026-06-01', 公司主体: 'PPHK', 出入方向: 'in', 我方到账金额: '1' },
      field: '我方币种'
    },
    {
      label: 'CITI 交易币种',
      sourceType: SOURCE_TYPES.CHANNEL,
      fields: { 账单日期: '2026-06-01', 渠道订单号: 'matrix-citi', 借贷方向: 'in', 通道名称: 'CITI', 交易金额: '1' },
      field: '交易币种',
      options: { assignedSubject: 'PPHK' }
    },
    {
      label: '非 CITI 结算币种',
      sourceType: SOURCE_TYPES.CHANNEL,
      fields: { 账单日期: '2026-06-01', 渠道订单号: 'matrix-settlement', 借贷方向: 'in', 通道名称: 'HIGHNOTE', billdate: '2026-06-30', 实际到账金额: '1' },
      field: '结算币种',
      options: { assignedSubject: 'PPHK' }
    },
    {
      label: '非 CITI 清算币种',
      sourceType: SOURCE_TYPES.CHANNEL,
      fields: { 账单日期: '2026-06-01', 渠道订单号: 'matrix-clearing', 借贷方向: 'in', 通道名称: 'HIGHNOTE', billdate: '2026-07-01', 清算金额: '1' },
      field: '清算币种',
      options: { assignedSubject: 'PPHK' }
    },
    {
      label: 'Pending 币种',
      sourceType: SOURCE_TYPES.PENDING,
      fields: { PendingBizId: 'matrix-pending', 平账账期: '2026-06', 主体: 'PPHK', 对账类型: 'VCC_clearing_credit', 金额: '1', 流水_币种: 'CNY', 流水_对账金额: '1' },
      field: '币种'
    },
    {
      label: 'Pending 流水_币种',
      sourceType: SOURCE_TYPES.PENDING,
      fields: { PendingBizId: 'matrix-flow', 平账账期: '2026-06', 主体: 'PPHK', 对账类型: 'VCC_clearing_credit', 金额: '1', 币种: 'CNY', 流水_对账金额: '1' },
      field: '流水_币种'
    }
  ];

  for (const testCase of cases) {
    for (const accepted of [' CNY ', ' CNH ']) {
      const row = map(
        testCase.sourceType,
        { ...testCase.fields, [testCase.field]: accepted },
        testCase.options
      );
      assert.equal(row.disposition, null, `${testCase.label} 接受 ${accepted}`);
    }
    for (const rejected of ['cnh', 'Cnh']) {
      const row = map(
        testCase.sourceType,
        { ...testCase.fields, [testCase.field]: rejected },
        testCase.options
      );
      assert.equal(row.disposition, 'format_error', `${testCase.label} 拒绝 ${rejected}`);
    }
  }
});

test('通道实际币种列一旦可确定，common 与分支后续失败也使用规范哈希', () => {
  const citiFields = {
    账单日期: '2026-05-31', 渠道订单号: 'early-citi', 借贷方向: 'in',
    通道名称: 'CITI', 交易金额: '1'
  };
  const crossMonthCnh = map(SOURCE_TYPES.CHANNEL, {
    ...citiFields, 交易币种: 'CNH'
  }, { assignedSubject: 'PPHK' });
  const crossMonthCny = map(SOURCE_TYPES.CHANNEL, {
    ...citiFields, 交易币种: 'CNY'
  }, { assignedSubject: 'PPHK' });
  const missingSubjectCnh = map(SOURCE_TYPES.CHANNEL, {
    ...citiFields, 账单日期: '2026-06-01', 渠道订单号: 'early-subject', 交易币种: 'CNH'
  }, { assignedSubject: '' });
  const missingSubjectCny = map(SOURCE_TYPES.CHANNEL, {
    ...citiFields, 账单日期: '2026-06-01', 渠道订单号: 'early-subject', 交易币种: 'CNY'
  }, { assignedSubject: '' });
  const invalidDateCnh = map(SOURCE_TYPES.CHANNEL, {
    ...citiFields, 账单日期: 'bad-date', 渠道订单号: 'early-invalid-date', 交易币种: 'CNH'
  }, { assignedSubject: 'PPHK' });
  const invalidDateCny = map(SOURCE_TYPES.CHANNEL, {
    ...citiFields, 账单日期: 'bad-date', 渠道订单号: 'early-invalid-date', 交易币种: 'CNY'
  }, { assignedSubject: 'PPHK' });

  assert.equal(crossMonthCnh.disposition, 'format_error');
  assert.equal(crossMonthCnh.contentHash, crossMonthCny.contentHash);
  assert.equal(missingSubjectCnh.disposition, 'format_error');
  assert.equal(missingSubjectCnh.contentHash, missingSubjectCny.contentHash);
  assert.equal(invalidDateCnh.disposition, 'format_error');
  assert.equal(invalidDateCnh.contentHash, invalidDateCny.contentHash);
  assert.equal(JSON.parse(crossMonthCnh.rawJson)[crossMonthCnh.definition.indexes.交易币种], 'CNH');
});

test('通道规范哈希保留导入指定主体边界，同主体 CNY/CNH 相同、换主体冲突', () => {
  const fields = {
    账单日期: '2026-06-01', 渠道订单号: 'channel-subject-hash', 借贷方向: 'in',
    通道名称: 'CITI', 交易金额: '1'
  };
  const cnhPphk = map(SOURCE_TYPES.CHANNEL, {
    ...fields, 交易币种: 'CNH'
  }, { assignedSubject: 'PPHK' });
  const cnyPphk = map(SOURCE_TYPES.CHANNEL, {
    ...fields, 交易币种: 'CNY'
  }, { assignedSubject: 'PPHK' });
  const cnyPpus = map(SOURCE_TYPES.CHANNEL, {
    ...fields, 交易币种: 'CNY'
  }, { assignedSubject: 'PPUS' });

  assert.equal(cnhPphk.contentHash, cnyPphk.contentHash);
  assert.notEqual(cnyPphk.contentHash, cnyPpus.contentHash);
});

test('通道 invalid_key 在实际币种列可确定时仍形成 canonical anomaly hash', () => {
  const pairs = [
    {
      label: 'CITI 空 key',
      fields: { 账单日期: '2026-06-01', 渠道订单号: '', 通道名称: 'CITI', 交易金额: '1' },
      field: '交易币种',
      options: { assignedSubject: 'PPHK' }
    },
    {
      label: 'CITI 非文本 key',
      fields: { 账单日期: '2026-06-01', 渠道订单号: '123', 通道名称: 'CITI', 交易金额: '1' },
      field: '交易币种',
      options: { assignedSubject: 'PPHK', keyCellType: 'n' }
    },
    {
      label: '非 CITI 有效 billdate 空 key',
      fields: {
        账单日期: '2026-06-01', 渠道订单号: '', 通道名称: 'HIGHNOTE',
        billdate: '2026-07-01', 清算金额: '1'
      },
      field: '清算币种',
      options: { assignedSubject: 'PPHK' }
    }
  ];
  for (const testCase of pairs) {
    const cnh = map(SOURCE_TYPES.CHANNEL, {
      ...testCase.fields, [testCase.field]: 'CNH'
    }, testCase.options);
    const cny = map(SOURCE_TYPES.CHANNEL, {
      ...testCase.fields, [testCase.field]: 'CNY'
    }, testCase.options);
    assert.equal(cnh.disposition, 'invalid_key', testCase.label);
    assert.equal(cnh.contentHash, cny.contentHash, testCase.label);
    assert.equal(JSON.parse(cnh.rawJson)[cnh.definition.indexes[testCase.field]], 'CNH', testCase.label);
  }
});

test('Pending 双侧 CNH/CNY 归一后不判错币，raw audit 与规范哈希各守边界', () => {
  const common = {
    PendingBizId: 'pending-cnh', 平账账期: '2026-06', 主体: 'PPHK',
    对账类型: 'VCC_clearing_credit', 金额: '5', 流水_对账金额: '5'
  };
  const cnhCny = map(SOURCE_TYPES.PENDING, {
    ...common, 币种: ' CNH ', 流水_币种: ' CNY '
  });
  const cnyCnh = map(SOURCE_TYPES.PENDING, {
    ...common, 币种: ' CNY ', 流水_币种: ' CNH '
  });
  const usd = map(SOURCE_TYPES.PENDING, {
    ...common, 币种: 'CNH', 流水_币种: 'USD'
  });

  assert.equal(PENDING_HASH_VERSION, 3);
  assert.equal(cnhCny.hashVersion, PENDING_HASH_VERSION);
  assert.deepEqual(
    [cnhCny.pendingCurrency, cnhCny.flowCurrency, cnhCny.currencyMismatch],
    ['CNY', 'CNY', 0]
  );
  assert.deepEqual(
    [cnyCnh.pendingCurrency, cnyCnh.flowCurrency, cnyCnh.currencyMismatch],
    ['CNY', 'CNY', 0]
  );
  assert.equal(cnhCny.contentHash, cnyCnh.contentHash);
  assert.equal(usd.currencyMismatch, 1);
  const raw = JSON.parse(cnhCny.rawJson);
  assert.equal(raw[cnhCny.definition.indexes.币种], ' CNH ');
  assert.equal(raw[cnhCny.definition.indexes.流水_币种], ' CNY ');
});

test('历史读取边界只把精确 CNH 映射为 CNY，不放宽其他非规范币种', () => {
  assert.equal(normalizeLegacyStoredCurrency('CNH'), 'CNY');
  assert.equal(normalizeLegacyStoredCurrency(' CNY '), 'CNY');
  assert.equal(normalizeLegacyStoredCurrency('cnh'), 'cnh');
  assert.equal(normalizeLegacyStoredCurrency('usd'), 'usd');
});

test('金额超过两位小数或 Excel 有效数字上限时进入格式异常且不做舍入', () => {
  const tooPrecise = map(SOURCE_TYPES.RECHARGE, {
    订单号: 'precision-1', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'USD', 我方到账金额: '1.234'
  });
  const tooLong = map(SOURCE_TYPES.RECHARGE, {
    订单号: 'precision-2', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'USD', 我方到账金额: '12345678901234.56'
  });

  assert.equal(tooPrecise.disposition, 'format_error');
  assert.match(tooPrecise.validationMessage, /最多支持 2 位小数/);
  assert.equal(tooLong.disposition, 'format_error');
  assert.match(tooLong.validationMessage, /15 位有效数字/);
});

test('账期字段接受 YYYY-MM、YYYYMM 和 Excel 数值日期字符串', () => {
  const pendingWithMonth = map(SOURCE_TYPES.PENDING, {
    PendingBizId: 'month-1', 平账账期: '2026-06', 主体: 'PPHK',
    对账类型: 'VCC_clearing_credit', 金额: '1', 币种: 'USD',
    流水_币种: 'USD', 流水_对账金额: '1'
  });
  const pendingWithCompactMonth = map(SOURCE_TYPES.PENDING, {
    PendingBizId: 'month-2', 平账账期: '202606', 主体: 'PPHK',
    对账类型: 'VCC_clearing_credit', 金额: '1', 币种: 'USD',
    流水_币种: 'USD', 流水_对账金额: '1'
  });
  const excelSerial = String((
    Date.UTC(2026, 5, 9) - Date.UTC(1899, 11, 30)
  ) / (24 * 60 * 60 * 1000));
  const rechargeWithSerial = map(SOURCE_TYPES.RECHARGE, {
    订单号: 'serial-date', BillDate: excelSerial, 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'USD', 我方到账金额: '1'
  });

  assert.equal(pendingWithMonth.disposition, null);
  assert.equal(pendingWithCompactMonth.disposition, null);
  assert.equal(rechargeWithSerial.disposition, null);
});

test('超长文本业务键无损保留，数值型业务键明确拒绝', () => {
  const longTextKey = '123456789012345678901234567890';
  const textKey = map(SOURCE_TYPES.RECHARGE, {
    订单号: longTextKey, BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'USD', 我方到账金额: '1'
  }, { keyCellType: 's' });
  const numericKey = map(SOURCE_TYPES.RECHARGE, {
    订单号: '1234567890123456', BillDate: '2026-06-01', 公司主体: 'PPHK',
    出入方向: 'in', 我方币种: 'USD', 我方到账金额: '1'
  }, { keyCellType: 'n' });

  assert.equal(textKey.disposition, null);
  assert.equal(textKey.idempotencyKey, longTextKey);
  assert.equal(numericKey.disposition, 'invalid_key');
  assert.match(numericKey.validationMessage, /必须在 Excel 中存为文本/);
});
