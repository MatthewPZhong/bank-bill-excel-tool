'use strict';

const path = require('node:path');
const { NEW_ACCOUNT_GENERATION_POLICY, NEW_ACCOUNT_SAVE_AS_POLICY } = require('./policies');
const { validateNewAccountGenerationResult } = require('./generation-contract');
const { NEW_ACCOUNT_SAVE_AS_ACTION, runNewAccountArtifactCopyInline,
  validateNewAccountSaveAsResult } = require('./artifact-copy');
const { estimateNewAccountGenerationPhaseResources } = require('./resource-estimator');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, passthroughInput, validatorBindings } = require('../execution-descriptors/descriptor-builder');

const policies = Object.freeze([NEW_ACCOUNT_GENERATION_POLICY, NEW_ACCOUNT_SAVE_AS_POLICY]);

function createModuleExecutionDescriptor(context = {}) {
  const generationEntry = Object.freeze({
    path: path.resolve(__dirname, 'worker-entry.js'),
    cancellationTerminalErrorCodes: Object.freeze(['NEW_ACCOUNT_GENERATION_CANCELLED'])
  });
  return createDescriptor({
    moduleId: 'new-account', policies, archivePolicies, registration: context.registration,
    entries: policies.map((policy) => ({ key: policy.entryKey,
      value: policy.actionKey === NEW_ACCOUNT_SAVE_AS_ACTION ? runNewAccountArtifactCopyInline : generationEntry })),
    validators: validatorBindings(policies, (policy) => policy.actionKey === NEW_ACCOUNT_SAVE_AS_ACTION
      ? validateNewAccountSaveAsResult : validateNewAccountGenerationResult),
    resourceProfiles: [{ key: NEW_ACCOUNT_GENERATION_POLICY.resources.profile,
      value: estimateNewAccountGenerationPhaseResources }],
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput: passthroughInput, beforeDispatch: null, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
