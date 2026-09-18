'use strict';

const { toolboxGenerationPolicy } = require('../toolbox-background/policies');
const { ROWS_ACTION, MAX_ROW_SPLIT_FILES } = require('./contracts');

const base = toolboxGenerationPolicy(ROWS_ACTION);
const ROWS_POLICY = Object.freeze({
  ...base,
  description: 'v3.2.9 按行拆分：保真缓存及顺序输出，仅在 Worker 内生成',
  entryKey: `executor.${ROWS_ACTION}`,
  resources: {
    ...base.resources,
    profile: `resource.${ROWS_ACTION}`,
    phase: { ...base.resources.phase, memoryBytes: 1024 ** 3 }
  },
  commit: {
    ...base.commit,
    inspectorKey: `inspector.${ROWS_ACTION}`,
    conflictScopeResolverKey: `scope.${ROWS_ACTION}`,
    settlementKey: `settlement.${ROWS_ACTION}`
  },
  result: { ...base.result, maxBytes: 4096, validatorKey: `result-validator.${ROWS_ACTION}` },
  artifacts: {
    ...base.artifacts,
    maxArtifacts: MAX_ROW_SPLIT_FILES,
    technicalValidatorKey: `technical-validator.${ROWS_ACTION}`,
    businessValidatorKey: `business-validator.${ROWS_ACTION}`,
    publisherKey: `publisher.${ROWS_ACTION}`
  },
  featureFlag: `feature.${ROWS_ACTION}`,
  legacyStrategyKey: null,
  production: {
    ...base.production,
    enabled: true,
    effectiveMode: 'thread-single',
    effectiveWorkerCount: 1,
    downgradeReason: null
  }
});

module.exports = { ROWS_POLICY };
