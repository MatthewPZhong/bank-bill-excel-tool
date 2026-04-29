// v2.0.0-beta.3：C3 资金对账不平 join 算法引擎
// PRD §7.3 / §10 决策 D4
//
// 行为：
//   1. 对 bankRow 遍历 gwRows，按 reconFields AND 比对
//   2. 多行满足 → 取第一条 + warn（数据脏）
//   3. 没匹配 → 该场景对该行不命中（first-match-wins 不锁定）
//   4. 配对成功 → 写 assign.bankField = chosen[assign.gwField]
//   5. 写入前若 bankRow[assign.bankField] 原值非空 → warn（仍执行覆盖）

const {
  ensureRowId,
  isEmptyValue,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber,
  valuesEqual
} = require('./engine-utils');

const { BANK_STATEMENT_VIRTUAL_AMOUNT_ABS } = require('../../constants/bank-statement-fields');

// C3 银行对账单字段含特殊"发生额绝对值"，从 Credit Amount + Debit Amount 计算
function getBankRowValueForC3(bankRow, fieldName) {
  if (fieldName === BANK_STATEMENT_VIRTUAL_AMOUNT_ABS) {
    const credit = parseNumber(bankRow['Credit Amount']);
    const debit = parseNumber(bankRow['Debit Amount']);
    if (credit === null && debit === null) return null;
    return Math.abs((credit || 0) - (debit || 0));
  }
  return bankRow[fieldName];
}

// 数值字段启发式（与 C2 保持一致）
function isNumericFieldName(fieldName) {
  const name = String(fieldName || '');
  return /Amount|Fee|金额|数额|发生额/.test(name);
}

function gwMatchesBank(gwRow, bankRow, reconFields) {
  return reconFields.every((rf) => {
    const numeric = isNumericFieldName(rf.gwField) || isNumericFieldName(rf.bankField);
    const bankValue = getBankRowValueForC3(bankRow, rf.bankField);
    return valuesEqual(gwRow[rf.gwField], bankValue, { numeric });
  });
}

function runC3Scenario(scenario, bankRows, gwRows) {
  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const modCollector = makeModificationCollector();
  const config = scenario.config || {};
  const reconFields = config.reconFields || [];
  const assign = config.assign || {};

  if (!Array.isArray(gwRows) || gwRows.length === 0) {
    warningCollector.push({
      rowId: null,
      code: 'no-gateway-rows',
      message: '资金对账不平结果（网关账单）数据为空，C3 场景无法运行'
    });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }
  if (reconFields.length === 0) {
    warningCollector.push({
      rowId: null,
      code: 'invalid-config',
      message: '对账字段至少需要 1 行'
    });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }
  if (!assign.gwField || !assign.bankField) {
    warningCollector.push({
      rowId: null,
      code: 'invalid-config',
      message: '对账成立后赋值必须指定网关账单字段 + 银行对账单字段'
    });
    return {
      lockedRowIds: modCollector.listLockedRowIds(),
      modifications: modCollector.listModifications(),
      warnings: warningCollector.list()
    };
  }

  bankRows.forEach((bankRow, index) => {
    const rowId = ensureRowId(bankRow, index);
    const matched = gwRows.filter((gwRow) => gwMatchesBank(gwRow, bankRow, reconFields));
    if (matched.length === 0) return;

    if (matched.length > 1) {
      warningCollector.push({
        rowId,
        code: 'multi-gateway-match',
        message: `bankRow 在网关账单中匹配到 ${matched.length} 行，取第一条（数据脏）`
      });
    }
    const chosen = matched[0];

    const newValue = normalizeCellValue(chosen[assign.gwField]);
    if (newValue === '') return; // 网关账单的源字段为空 → 不写入

    const oldValue = normalizeCellValue(bankRow[assign.bankField]);
    if (oldValue === newValue) return; // 值未变，不算修改

    bankRow[assign.bankField] = newValue;
    modCollector.record(rowId, assign.bankField, oldValue, newValue);
  });

  return {
    lockedRowIds: modCollector.listLockedRowIds(),
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  };
}

module.exports = {
  getBankRowValueForC3,
  gwMatchesBank,
  runC3Scenario
};
