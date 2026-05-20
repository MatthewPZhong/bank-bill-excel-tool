// v2.0.0-beta.3：C1 提取 ReconId 算法引擎
// PRD §7.1 / §10 决策 D2.1-D2.3
// v2.1.7 F1：行 3 条件聚合支持 AND/OR 切换（PRD §六 / spec §二）
//   - config.conditionsLogic 'AND' / 'OR'；缺失时 fallback 'OR'（向下兼容旧 scenario）
//
// 行为：
//   1. 行不满足条件 → 该场景对该行不命中（first-match-wins 不锁定）
//      - logic='OR'：任一条件 true 即命中（与 v2.1.6 一致）
//      - logic='AND'：所有条件 true 才命中
//   2. extractByFeature.enabled 时：
//      - regex 公式：[A-Z]{englishExtraN}<featureCode>\d{digitCount}
//      - englishExtraN = totalLength - len(featureCode) - digitCount
//      - 在 searchFields 各字段中 matchAll
//      - 多字段结果"值一致"才写入；不一致 → warn + 不写入（该行不命中）
//   3. extractByOtherField.field 时：直接复制该字段值到 ReconciliationId
//   4. 写入前若 ReconciliationId 原值非空 → warn（仍执行覆盖）

const {
  ensureRowId,
  evaluateCondition,
  isEmptyValue,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue
} = require('./engine-utils');

const RECONCILIATION_ID_COLUMN = 'ReconciliationId';

function buildFeatureRegex({ featureCode, digitCount, totalLength }) {
  const englishExtraN = totalLength - String(featureCode || '').length - Number(digitCount);
  if (englishExtraN < 0) {
    throw new Error(`非法特征参数：总位数 ${totalLength} - 数字位数 ${digitCount} - 特征码长度 ${String(featureCode || '').length} = ${englishExtraN} < 0`);
  }
  if (englishExtraN === 0) {
    return new RegExp(`${featureCode}\\d{${digitCount}}`, 'g');
  }
  return new RegExp(`[A-Z]{${englishExtraN}}${featureCode}\\d{${digitCount}}`, 'g');
}

// v2.1.7 F1：按 logic（'AND' / 'OR'）聚合条件
//   - logic === 'AND' → 全部条件 true 才命中（conditions.every）
//   - 其它（含 'OR' / undefined / 任意非 'AND' 值）→ 任一条件 true 即命中（conditions.some），保持 v2.1.6 行为
//   - 没有条件 → 任意行都不命中（保守，与原 rowMatchesAnyCondition 一致）
function rowMatchesConditions(row, conditions, logic) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return false;
  }
  const fn = (logic === 'AND') ? 'every' : 'some';
  return conditions[fn]((cond) => evaluateCondition(row, cond));
}

function findReconIdValueForRow(row, scenarioConfig, warnings, scenario) {
  const featureBlock = scenarioConfig.extractByFeature;
  if (featureBlock && featureBlock.enabled) {
    const regex = buildFeatureRegex({
      featureCode: featureBlock.featureCode,
      digitCount: featureBlock.digitCount,
      totalLength: featureBlock.totalLength
    });

    const allMatches = []; // { field, value }
    (featureBlock.searchFields || []).forEach((field) => {
      const cellValue = normalizeCellValue(row[field]);
      if (!cellValue) return;
      // 重新创建 regex（避免 lastIndex 副作用）
      const fieldRegex = new RegExp(regex.source, 'g');
      let match;
      while ((match = fieldRegex.exec(cellValue)) !== null) {
        allMatches.push({ field, value: match[0] });
      }
    });

    if (allMatches.length === 0) {
      return null;
    }

    const distinctValues = Array.from(new Set(allMatches.map((m) => m.value)));
    if (distinctValues.length === 1) {
      return distinctValues[0];
    }

    // 多字段值不一致 → warn + 不写入
    warnings.push({
      rowId: row._rowId,
      code: 'inconsistent-recon-id-values',
      message: `多字段提取出 ${distinctValues.length} 个不同 ReconId 候选值: ${distinctValues.join(' / ')}，跳过该行`,
      fields: allMatches.map((m) => `${m.field}=${m.value}`).join(', ')
    });
    return null;
  }

  const otherField = scenarioConfig.extractByOtherField;
  if (otherField && otherField.field) {
    const cellValue = normalizeCellValue(row[otherField.field]);
    if (!cellValue) return null;
    return cellValue;
  }

  // 都没勾 → 不会有产出
  return null;
}

function runC1Scenario(scenario, bankRows) {
  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const modCollector = makeModificationCollector();
  const config = scenario.config || {};
  const conditions = config.conditions || [];
  // v2.1.7 F1：取 conditionsLogic；缺失或非 'AND' → fallback 'OR'（向下兼容旧 scenario）
  const conditionsLogic = (config.conditionsLogic === 'AND') ? 'AND' : 'OR';

  bankRows.forEach((row, index) => {
    const rowId = ensureRowId(row, index);
    if (!rowMatchesConditions(row, conditions, conditionsLogic)) return;

    const reconIdValue = findReconIdValueForRow(row, config, {
      push: (payload) => warningCollector.push(payload)
    }, scenario);
    if (reconIdValue === null) return;

    const oldValue = normalizeCellValue(row[RECONCILIATION_ID_COLUMN]);
    if (oldValue === reconIdValue) {
      // 值未变，不算修改（first-match-wins 不锁定）
      return;
    }

    row[RECONCILIATION_ID_COLUMN] = reconIdValue;
    modCollector.record(rowId, RECONCILIATION_ID_COLUMN, oldValue, reconIdValue);
  });

  return {
    lockedRowIds: modCollector.listLockedRowIds(),
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  };
}

// findReconIdValueForRow 内部 push warning 用临时 push 接口；为了保留 collector 唯一性，包一层
function pushWarningProxy(originalCollector) {
  return {
    push: originalCollector.push
  };
}

module.exports = {
  RECONCILIATION_ID_COLUMN,
  buildFeatureRegex,
  runC1Scenario
};
