'use strict';

const FUND_TRANSFER_OWNER_CATEGORY = 'builtin-fixed';
const FUND_TRANSFER_OWNER_FUNC_CATEGORY = 'platform-order';
const FUND_TRANSFER_OWNER_SUB_CATEGORY = 'fund-transfer-backfill';
const FUND_TRANSFER_POLICY_SCENARIO_NAME = '调拨日期策略配置';
const FUND_TRANSFER_POLICY_SCHEMA_VERSION = 1;
const DEFAULT_DATE_MATCH_ENABLED = true;
const DEFAULT_DATE_TOLERANCE_DAYS = 1;
const MIN_DATE_TOLERANCE_DAYS = 1;
const MAX_DATE_TOLERANCE_DAYS = 999;

class FundTransferPolicyConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FundTransferPolicyConfigError';
    this.code = code;
    this.conflicts = Array.isArray(details.conflicts) ? details.conflicts : [];
    this.ownerCount = Number(details.ownerCount) || 0;
  }
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasFundTransferReservedSignature(scenario) {
  const config = scenario && scenario.config;
  return Boolean(
    scenario
    && scenario.category === FUND_TRANSFER_OWNER_CATEGORY
    && isObjectRecord(config)
    && config.funcCategory === FUND_TRANSFER_OWNER_FUNC_CATEGORY
    && config.subCategory === FUND_TRANSFER_OWNER_SUB_CATEGORY
  );
}

function isCanonicalFundTransferOwner(scenario) {
  return hasFundTransferReservedSignature(scenario)
    && scenario.isBuiltin === true;
}

function describeScenario(scenario) {
  return Object.freeze({
    id: scenario && scenario.id != null ? Number(scenario.id) : null,
    name: scenario && scenario.name != null ? String(scenario.name) : '',
    category: scenario && scenario.category != null ? String(scenario.category) : '',
    isBuiltin: Boolean(scenario && scenario.isBuiltin === true)
  });
}

function cloneValue(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const array = [];
    seen.set(value, array);
    value.forEach((item) => array.push(cloneValue(item, seen)));
    return array;
  }
  const object = {};
  seen.set(value, object);
  Object.keys(value).forEach((key) => {
    object[key] = cloneValue(value[key], seen);
  });
  return object;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.keys(value).forEach((key) => deepFreeze(value[key], seen));
  return Object.freeze(value);
}

function normalizeForStableStringify(value, seen = new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (Number.isFinite(value)) return value;
    return { $type: 'number', value: String(value) };
  }
  if (type === 'undefined') return { $type: 'undefined' };
  if (type === 'bigint') return { $type: 'bigint', value: String(value) };
  if (type !== 'object') return { $type: type, value: String(value) };
  if (seen.has(value)) {
    throw new Error('stableStringify: 不支持循环引用');
  }
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((item) => normalizeForStableStringify(item, seen));
  } else {
    normalized = {};
    Object.keys(value).sort().forEach((key) => {
      normalized[key] = normalizeForStableStringify(value[key], seen);
    });
  }
  seen.delete(value);
  return normalized;
}

function stableStringify(value) {
  return JSON.stringify(normalizeForStableStringify(value));
}

function describeRawConfigValue(config, key) {
  if (!isObjectRecord(config) || !Object.prototype.hasOwnProperty.call(config, key)) {
    return { type: 'missing', value: undefined };
  }
  const value = config[key];
  if (value === null) return { type: 'null', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'number') return { type: 'number', value };
  return { type: 'other', value: cloneValue(value) };
}

function makeWarning(code, message, scenarioId = null) {
  return Object.freeze({
    scenarioId: scenarioId == null ? null : Number(scenarioId),
    scenarioName: FUND_TRANSFER_POLICY_SCENARIO_NAME,
    rowId: null,
    code,
    message
  });
}

function makeSignature({
  ownerState,
  ownerScenarioId,
  ownerCount,
  rawDateMatchEnabled,
  rawDateToleranceDays,
  enabled,
  toleranceDays
}) {
  return stableStringify({
    schemaVersion: FUND_TRANSFER_POLICY_SCHEMA_VERSION,
    ownerState,
    ownerScenarioId,
    ownerCount,
    raw: {
      dateMatchEnabled: rawDateMatchEnabled,
      dateToleranceDays: rawDateToleranceDays
    },
    effective: {
      enabled,
      toleranceDays
    }
  });
}

function resolveFundTransferDatePolicy(scenarios) {
  const allScenarios = Array.isArray(scenarios) ? scenarios.filter(Boolean) : [];
  const owners = allScenarios.filter(isCanonicalFundTransferOwner);
  const reservedConflicts = allScenarios.filter(
    (scenario) => hasFundTransferReservedSignature(scenario)
      && !isCanonicalFundTransferOwner(scenario)
  );

  if (reservedConflicts.length > 0) {
    const conflicts = reservedConflicts.map(describeScenario);
    const conflictText = conflicts
      .map((item) => `id=${item.id == null ? '?' : item.id}「${item.name || '(未命名)'}」`)
      .join('、');
    throw new FundTransferPolicyConfigError(
      'fund-transfer-policy-reserved-signature-conflict',
      `发现非系统场景占用调拨回填保留签名：${conflictText}。请在场景管理中删除冲突后重试。`,
      { conflicts, ownerCount: owners.length }
    );
  }

  if (owners.length > 1) {
    const conflicts = owners.map(describeScenario);
    const conflictText = conflicts
      .map((item) => `id=${item.id == null ? '?' : item.id}「${item.name || '(未命名)'}」`)
      .join('、');
    throw new FundTransferPolicyConfigError(
      'fund-transfer-policy-duplicate-owner',
      `发现 ${owners.length} 个调拨回填系统配置载体：${conflictText}。为避免错误匹配，本次处理已停止，请人工修复重复内置场景。`,
      { conflicts, ownerCount: owners.length }
    );
  }

  if (owners.length === 0) {
    const rawDateMatchEnabled = { type: 'missing', value: undefined };
    const rawDateToleranceDays = { type: 'missing', value: undefined };
    const signature = makeSignature({
      ownerState: 'missing',
      ownerScenarioId: null,
      ownerCount: 0,
      rawDateMatchEnabled,
      rawDateToleranceDays,
      enabled: DEFAULT_DATE_MATCH_ENABLED,
      toleranceDays: DEFAULT_DATE_TOLERANCE_DAYS
    });
    return Object.freeze({
      policy: Object.freeze({
        enabled: DEFAULT_DATE_MATCH_ENABLED,
        toleranceDays: DEFAULT_DATE_TOLERANCE_DAYS,
        ownerScenarioId: null,
        signature
      }),
      warnings: Object.freeze([
        makeWarning(
          'fund-transfer-policy-owner-missing',
          '未找到“调拨回填功能管理”系统配置，已临时使用默认日期策略：启用日期匹配，允许 ±1 天。请修复本机配置后重新处理。'
        )
      ]),
      ownerScenario: null
    });
  }

  const owner = owners[0];
  const ownerScenarioId = owner.id == null ? null : Number(owner.id);
  const config = isObjectRecord(owner.config) ? owner.config : {};
  const rawDateMatchEnabled = describeRawConfigValue(config, 'dateMatchEnabled');
  const rawDateToleranceDays = describeRawConfigValue(config, 'dateToleranceDays');
  const warnings = [];

  let enabled = DEFAULT_DATE_MATCH_ENABLED;
  if (rawDateMatchEnabled.type === 'boolean') {
    enabled = rawDateMatchEnabled.value;
  } else if (rawDateMatchEnabled.type !== 'missing') {
    warnings.push(makeWarning(
      'fund-transfer-policy-invalid-date-enabled',
      '“调拨单匹配日期”开关配置无效，已按默认值“启用”处理。请在“调拨回填功能管理”中重新保存。',
      ownerScenarioId
    ));
  }

  let toleranceDays = DEFAULT_DATE_TOLERANCE_DAYS;
  if (rawDateToleranceDays.type === 'number'
    && Number.isInteger(rawDateToleranceDays.value)
    && rawDateToleranceDays.value >= MIN_DATE_TOLERANCE_DAYS
    && rawDateToleranceDays.value <= MAX_DATE_TOLERANCE_DAYS) {
    toleranceDays = rawDateToleranceDays.value;
  } else if (rawDateToleranceDays.type !== 'missing') {
    warnings.push(makeWarning(
      'fund-transfer-policy-invalid-tolerance-days',
      '“调拨单匹配日期”天数配置无效，已按默认值 ±1 天处理。允许范围为 1–999 的整数，请重新保存。',
      ownerScenarioId
    ));
  }

  const signature = makeSignature({
    ownerState: 'single',
    ownerScenarioId,
    ownerCount: 1,
    rawDateMatchEnabled,
    rawDateToleranceDays,
    enabled,
    toleranceDays
  });
  const ownerScenario = deepFreeze(cloneValue(owner));
  return Object.freeze({
    policy: Object.freeze({
      enabled,
      toleranceDays,
      ownerScenarioId,
      signature
    }),
    warnings: Object.freeze(warnings),
    ownerScenario
  });
}

module.exports = {
  DEFAULT_DATE_MATCH_ENABLED,
  DEFAULT_DATE_TOLERANCE_DAYS,
  FUND_TRANSFER_OWNER_CATEGORY,
  FUND_TRANSFER_OWNER_FUNC_CATEGORY,
  FUND_TRANSFER_OWNER_SUB_CATEGORY,
  FUND_TRANSFER_POLICY_SCENARIO_NAME,
  FUND_TRANSFER_POLICY_SCHEMA_VERSION,
  MAX_DATE_TOLERANCE_DAYS,
  MIN_DATE_TOLERANCE_DAYS,
  FundTransferPolicyConfigError,
  hasFundTransferReservedSignature,
  isCanonicalFundTransferOwner,
  resolveFundTransferDatePolicy,
  stableStringify
};
