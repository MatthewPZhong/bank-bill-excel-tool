'use strict';

// 平盘链接原始表的必用列（SOURCE_REQUIRED_FIELDS）逐类完整性：设置 → 模板文件的新结构可以改名、删除非必用列，
// 所以校验、过滤分类、派生与逻辑账户识别只能读取各类自己的必用列。每类构造一行完整数据与一行只含必用列的数据，
// 两者经同一套函数处理的结果必须一致；任一处按名读取了非必用列，只含必用列的行结果就会不同。
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SOURCE_DEFINITIONS,
  SOURCE_REQUIRED_FIELDS,
  SOURCE_TYPES
} = require('../../../src/main-process/position-reconciliation/constants');
const { classifySourceRow, validateSourceRow } = require('../../../src/main-process/position-reconciliation/readers');
const { deriveLinkedRows } = require('../../../src/main-process/position-reconciliation/derivation');
const { buildLogicalAccounts } = require('../../../src/main-process/position-reconciliation/logical-accounts');

const BUSINESS_VALUES = Object.freeze({
  [SOURCE_TYPES.FUND_TRANSFER]: {
    调拨单号: 'FT-1', 调拨状态: '付款成功', 渠道流水号: 'FT-RID', 交易时间: '2026-07-20',
    '付款账户（卡号）': 'PAY-1', '收款账户（卡号）': 'REC-1', 付款金额: '100', 付款币种: 'USD',
    收款金额: '95', 收款币种: 'EUR', 换汇渠道: 'BANK-FX'
  },
  [SOURCE_TYPES.TEST_PAYMENT]: {
    付款单号: 'TP-1', 付款状态: '付款成功', 渠道流水号: 'TP-RID', 源金额: '100', 源币种: 'USD',
    目标金额: '95', 目标币种: 'EUR', 付款渠道: 'DBS', 银行流水号: 'BANK-REF', 创建时间: '2026-07-20'
  },
  [SOURCE_TYPES.GATEWAY_INBOUND]: {
    bizId: 'IN-1', billDate: '2026-07-20', tradeType: 'Inbound-VA', reconId: 'IN-RID', channel: 'DBS',
    merchantId: 'M001', currency: 'USD', originOutboundCurrency: 'EUR'
  },
  [SOURCE_TYPES.GATEWAY_OUTBOUND]: {
    业务单号: 'OUT-1', 账单日期: '2026-07-20', 渠道名称: 'DBS', 账户号: 'M001', 交易类型: 'Outbound',
    主对账id: 'OUT-RID', 币种: 'USD', 原始币种: 'EUR', 原始金额: '95', 银行扣款币种: 'USD'
  },
  [SOURCE_TYPES.BANK_ACCOUNT]: {
    账户状态: '正常', 账户性质: '自有', 币种: 'USD', 银行账号: 'ACC-1', 系统账号: 'SYS-1'
  }
});

// 完整行：非必用列也填上能改变结果的值（与必用列同值的干扰项），确保“读了非必用列”会让结果不同。
function fullRow(sourceType) {
  const business = BUSINESS_VALUES[sourceType];
  return Object.fromEntries(SOURCE_DEFINITIONS[sourceType].headers.map((header) => [
    header,
    Object.hasOwn(business, header) ? business[header] : `非必用-${header}`
  ]));
}

function requiredOnlyRow(sourceType) {
  const row = fullRow(sourceType);
  return Object.fromEntries(SOURCE_REQUIRED_FIELDS[sourceType].map((header) => [header, row[header]]));
}

function pick(row, fields) {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

function outcome(sourceType, row) {
  const validation = validateSourceRow(sourceType, row);
  const classification = classifySourceRow(sourceType, row);
  const derived = deriveLinkedRows(sourceType, [{
    sourceType,
    businessKey: validation.businessKey,
    eventDate: validation.eventDate,
    monthKey: validation.monthKey,
    sourceRowNumber: 2,
    row
  }]);
  // 账户表的链接行即原始行，只比较必用列；其余链接行是固定派生列，整行比较。
  const linkRows = derived.map((item) => ({
    visible: item.visible,
    row: sourceType === SOURCE_TYPES.BANK_ACCOUNT ? pick(item.row, SOURCE_REQUIRED_FIELDS[sourceType]) : item.row
  }));
  return { validation, disposition: classification.disposition, filter: classification.filter, linkRows };
}

for (const sourceType of Object.values(SOURCE_TYPES)) {
  test(`${SOURCE_DEFINITIONS[sourceType].sourceName}：只含必用列的行与完整行的校验、分类与派生结果一致`, () => {
    const full = outcome(sourceType, fullRow(sourceType));
    assert.equal(full.validation.errors.length, 0, JSON.stringify(full.validation.errors));
    assert.ok(full.linkRows.length > 0, '样例行应派生出链接行');
    assert.deepEqual(outcome(sourceType, requiredOnlyRow(sourceType)), full);
  });
}

test('清结算银行账户表：逻辑账户识别只读必用列', () => {
  // rows 是原样携带的原始行（导出用），不参与识别；其余字段（别名、币种、性质、有效性）只能来自必用列。
  const strip = (accounts) => accounts.map(({ rows: _rows, ...account }) => account);
  const full = buildLogicalAccounts([fullRow(SOURCE_TYPES.BANK_ACCOUNT)]);
  assert.ok(full.length > 0);
  assert.deepEqual(strip(buildLogicalAccounts([requiredOnlyRow(SOURCE_TYPES.BANK_ACCOUNT)])), strip(full));
});

test('必用列都在内置表头中，主键与日期列属于各自的必用列', () => {
  for (const sourceType of Object.values(SOURCE_TYPES)) {
    const definition = SOURCE_DEFINITIONS[sourceType];
    const required = SOURCE_REQUIRED_FIELDS[sourceType];
    assert.deepEqual(required.filter((header) => !definition.headers.includes(header)), [], sourceType);
    for (const field of [definition.keyField, definition.dateField].filter(Boolean)) {
      assert.ok(required.includes(field), `${sourceType}：${field}`);
    }
  }
});
