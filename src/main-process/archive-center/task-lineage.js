'use strict';

const LINEAGE_KINDS = new Set(['dataset-input', 'run-output']);

function requiredLineageText(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`LineageIntentV1.${field} 必须是非空字符串`);
  }
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`LineageIntentV1.${field} 必须是非空字符串`);
  return normalized;
}

function normalizeLineageIntentV1(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('LineageIntentV1 必须是对象');
  }
  const sourceContractVersion = value.sourceContractVersion;
  const expectedKeys = ['inputRole', 'kind', 'lineageKey', 'producerTaskRunId', 'sourceContractVersion', 'version'];
  if (![0, 1].includes(sourceContractVersion)
      || value.version !== 1
      || Object.keys(value).sort().join('\u0000') !== expectedKeys.join('\u0000')) {
    throw new TypeError('LineageIntentV1 字段或版本非法');
  }
  const kind = requiredLineageText(value.kind, 'kind');
  if (!LINEAGE_KINDS.has(kind)) throw new TypeError(`LineageIntentV1.kind 非法：${kind}`);
  const producerTaskRunId = sourceContractVersion === 0
    ? null
    : requiredLineageText(value.producerTaskRunId, 'producerTaskRunId');
  if (sourceContractVersion === 0 && value.producerTaskRunId !== null) {
    throw new TypeError('contract-v0 lineage 的 producerTaskRunId 必须为 null');
  }
  return Object.freeze({
    version: 1,
    kind,
    lineageKey: requiredLineageText(value.lineageKey, 'lineageKey'),
    inputRole: requiredLineageText(value.inputRole, 'inputRole'),
    sourceContractVersion,
    producerTaskRunId
  });
}

function lineageIntentKey(intent) {
  return [intent.kind, intent.lineageKey, intent.inputRole].join('\u0000');
}

function compareLineageIntents(left, right) {
  const leftKey = lineageIntentKey(left);
  const rightKey = lineageIntentKey(right);
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function normalizeLineageIntentsV1(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('lineageIntents 必须是数组');
  const normalized = value.map(normalizeLineageIntentV1)
    .sort(compareLineageIntents);
  for (let index = 1; index < normalized.length; index += 1) {
    if (lineageIntentKey(normalized[index - 1]) === lineageIntentKey(normalized[index])) {
      throw new TypeError('lineageIntents 存在重复的 kind/key/role');
    }
  }
  return Object.freeze(normalized);
}

module.exports = {
  normalizeLineageIntentsV1
};
