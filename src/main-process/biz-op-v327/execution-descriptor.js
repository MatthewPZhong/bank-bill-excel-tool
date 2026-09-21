'use strict';

const path = require('node:path');
const { BIZ_OP_V327_POLICIES: policies, validateBizOpCandidateResult, validateBizOpExportResult } = require('./policies');
const { archivePolicies } = require('./archive-task-policies');
const { createDescriptor, validatorBindings } = require('../execution-descriptors/descriptor-builder');

function createModuleExecutionDescriptor(context = {}) {
  const authority = context.bizOpV327;
  function bindInput({ actionKey, operationKey, input }) {
    if (!authority) throw Object.assign(new Error('业务 OP 缺少 Main 输入授权'), { code: 'BIZOP_RUNTIME_AUTHORITY_REQUIRED' });
    return authority.bindInput({ actionKey, operationKey, input });
  }
  function beforeDispatch(identity) {
    if (!authority) throw Object.assign(new Error('业务 OP 缺少 Main 运行授权'), { code: 'BIZOP_RUNTIME_AUTHORITY_REQUIRED' });
    return authority.beforeDispatch(identity);
  }
  const entry = path.resolve(__dirname, 'worker-entry.js');
  return createDescriptor({
    moduleId: 'biz-op-v327', policies, archivePolicies, registration: context.registration,
    entries: policies.map((policy) => ({ key: policy.entryKey, value: entry })),
    validators: validatorBindings(policies, (policy) => policy.commit.kind === 'none'
      ? validateBizOpCandidateResult : validateBizOpExportResult),
    mainBindings: policies.map((policy) => ({ actionKey: policy.actionKey,
      bindInput, beforeDispatch, defaultUnits: null }))
  });
}

module.exports = { policies, createModuleExecutionDescriptor };
