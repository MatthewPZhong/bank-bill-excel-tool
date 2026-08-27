'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  STATEMENT_ACTION_PURPOSES,
  STATEMENT_RESOURCE_CONTRACT,
  STATEMENT_RESULT_VALIDATORS,
  createStatementInteractionRequiredResult,
  createStatementPublicInteractionDto,
  createStatementStatusDto,
  createStatementTokenHandleDto
} = require('../../../src/main-process/statement-worker/contracts');
const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../src/main-process/background-execution/execution-policy-registry');
const {
  estimateStatementPendingInteractionFootprint,
  estimateStatementServiceStateFootprint,
  estimateStatementValueBytes,
  roundStatementReservationBytes
} = require('../../../src/main-process/statement-worker/state-footprint');
const {
  createJobEnvelope,
  serializeEnvelope
} = require('../../../src/main-process/background-execution/protocol');
const {
  utf8Size
} = require('../../../src/main-process/background-execution/protocol-validator');
const {
  validateResultBody
} = require('../../../src/main-process/background-execution/supervisor');

const ROOT = path.join(__dirname, '..', '..', '..');
const POLICY_FIXTURE = path.join(
  ROOT,
  'changes',
  'background-execution-v3.2.x-contract-baseline',
  'changes',
  'background-execution',
  'validation',
  'fixtures',
  'valid',
  'policy-registry.v3.2.x.json'
);
const STATIC_KEY_FIXTURE = path.join(
  path.dirname(POLICY_FIXTURE),
  'static-key-manifest.v3.2.x.json'
);
const STATEMENT_ACTION_KEYS = Object.freeze([
  'statement:generate-all',
  'statement:generate-current',
  'statement:import',
  'statement:resolve-big-account',
  'statement:resolve-manual-balance'
]);

function createStatementPolicyRegistry() {
  const fixture = JSON.parse(fs.readFileSync(POLICY_FIXTURE, 'utf8'));
  const policies = STATEMENT_ACTION_KEYS.map((actionKey) => fixture.actions[actionKey]);
  const entryBindings = {};
  const validatorBindings = {};
  for (const policy of policies) {
    entryBindings[policy.entryKey] = { path: '/app/statement-service.js' };
    validatorBindings[policy.result.validatorKey] = STATEMENT_RESULT_VALIDATORS[policy.actionKey];
    for (const key of [
      policy.artifacts.technicalValidatorKey,
      policy.artifacts.businessValidatorKey
    ].filter(Boolean)) {
      validatorBindings[key] = () => true;
    }
  }
  const entryRegistry = createStaticRegistry(entryBindings).freeze();
  const validatorRegistry = createStaticRegistry(validatorBindings).freeze();
  return createExecutionPolicyRegistry({
    policies,
    entryRegistry,
    validatorRegistry,
    staticKeys: JSON.parse(fs.readFileSync(STATIC_KEY_FIXTURE, 'utf8')),
    generatedAt: '2026-08-28T00:00:00.000Z',
    baselineRef: 'e09-p0-statement-contract'
  }).freeze();
}

function statementEventEnvelope({ actionKey, operation, payload }, policyRegistry) {
  const operationKey = `operation-${actionKey.replace(/[^a-z]+/g, '-')}`;
  return createJobEnvelope({
    direction: 'event',
    operation,
    actionKey,
    operationKey,
    jobId: `job-${actionKey.replace(/[^a-z]+/g, '-')}`,
    workerInstanceId: 'statement-service-worker-1',
    serviceGeneration: 3,
    unitId: null,
    seq: 1,
    context: {
      kind: 'operation',
      value: {
        taskRunId: 'statement-task-run-1',
        taskKey: 'statement-task',
        moduleId: 'statement',
        parentRunId: 'statement-parent-run-1',
        operationKey
      }
    },
    payload
  }, { policyRegistry });
}

function token(overrides = {}) {
  return {
    tokenId: 'opaque-token-1',
    purpose: 'big-account',
    serviceGeneration: 3,
    sessionKey: 'template:17',
    sessionRevision: 9,
    expiresAt: 1787847300000,
    allowedChoiceDigest: 'a'.repeat(64),
    reservationId: 'reservation-1',
    ...overrides
  };
}

function bigAccountPrompt(overrides = {}) {
  return {
    status: 'select-big-account',
    message: '请选择本次使用的大账号 / 币种',
    selectionMode: 'multi-row',
    templateId: 17,
    rows: [{ index: 0, label: '1.', sourceRowNumber: 2, fileName: '账单.xlsx' }],
    rowsWithEmptyBlocks: [
      { index: 0, label: '1.', sourceRowNumber: 2, fileName: '账单.xlsx' }
    ],
    bigAccounts: [{ merchantId: 'M001', currencies: ['USD'], isMultiCurrency: false }],
    expandedBigAccountOptions: [
      { merchantId: 'M001', currency: 'USD', accountNature: 'client' }
    ],
    fixedAssignments: [],
    ...overrides
  };
}

function manualBalancePrompt(overrides = {}) {
  return {
    templateName: '中行-上海',
    bankName: '中行',
    merchantId: 'M001',
    currency: 'USD',
    targetBillDate: '2026-08-01',
    queueIndex: 1,
    queueTotal: 2,
    ...overrides
  };
}

function scopeGenerationPrompt(kind = 'detail') {
  const fieldLabel = kind === 'detail' ? '明细' : '余额';
  return {
    status: 'select-export-scope',
    kind,
    options: [
      { scope: 'current', label: `导出当前批次文件的${fieldLabel}` },
      { scope: 'all', label: `导出所有批次文件的${fieldLabel}` }
    ]
  };
}

test('Statement E09-P0资源/token合同与五个canonical policy逐字段一致且production保持false', () => {
  const fixture = JSON.parse(fs.readFileSync(POLICY_FIXTURE, 'utf8'));
  for (const actionKey of STATEMENT_ACTION_KEYS) {
    const policy = fixture.actions[actionKey];
    assert.ok(policy, `缺少 canonical policy：${actionKey}`);
    assert.equal(policy.mode, 'thread-single');
    assert.equal(policy.lifetime, 'service');
    assert.equal(policy.adapterKind, 'native');
    assert.equal(policy.production.enabled, false);
    assert.equal(policy.production.effectiveMode, 'legacy');
    assert.equal(policy.service.serviceKey, STATEMENT_RESOURCE_CONTRACT.serviceKey);
    assert.equal(
      policy.service.stateFootprintEstimatorKey,
      STATEMENT_RESOURCE_CONTRACT.stateFootprintEstimatorKey
    );
    assert.deepEqual(
      policy.service.resourceControl.allowedRequestKinds,
      STATEMENT_RESOURCE_CONTRACT.allowedRequestKinds
    );
    assert.equal(
      policy.service.resourceControl.maxPendingRequests,
      STATEMENT_RESOURCE_CONTRACT.maxPendingRequests
    );
    assert.equal(
      policy.service.resourceControl.grantTimeoutMs,
      STATEMENT_RESOURCE_CONTRACT.grantTimeoutMs
    );
    assert.equal(
      policy.service.resourceControl.adoptionTimeoutMs,
      STATEMENT_RESOURCE_CONTRACT.adoptionTimeoutMs
    );
    assert.equal(
      policy.resources.persistentState.memoryBytes,
      STATEMENT_RESOURCE_CONTRACT.persistentStateBudgetBytes
    );
    assert.equal(
      policy.resources.pendingInteraction.memoryBytes,
      STATEMENT_RESOURCE_CONTRACT.pendingInteractionBudgetBytes
    );
    assert.equal(policy.service.statusMaxBytes, STATEMENT_RESOURCE_CONTRACT.statusMaxBytes);
    assert.equal(
      policy.protocolLimits.commandMaxBytes,
      STATEMENT_RESOURCE_CONTRACT.protocolEnvelopeMaxBytes
    );
    assert.equal(
      policy.protocolLimits.eventMaxBytes,
      STATEMENT_RESOURCE_CONTRACT.protocolEnvelopeMaxBytes
    );
    assert.deepEqual(policy.service.tokenPolicy, {
      enabled: true,
      maxOutstanding: STATEMENT_RESOURCE_CONTRACT.tokenMaxOutstanding,
      ttlMs: STATEMENT_RESOURCE_CONTRACT.tokenTtlMs,
      singleUse: STATEMENT_RESOURCE_CONTRACT.tokenSingleUse
    });
  }
});

test('Main token handle冻结TechDoc exact字段，Renderer DTO剥离reservation并拒绝private rows/path', () => {
  const handle = createStatementTokenHandleDto(token());
  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual(Object.keys(handle), [
    'allowedChoiceDigest',
    'expiresAt',
    'purpose',
    'reservationId',
    'serviceGeneration',
    'sessionKey',
    'sessionRevision',
    'tokenId'
  ]);

  const publicDto = createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt()
  });
  assert.equal(Object.isFrozen(publicDto), true);
  assert.equal(Object.hasOwn(publicDto, 'reservationId'), false);
  assert.equal(Object.hasOwn(publicDto, 'sessionKey'), false);
  assert.equal(publicDto.prompt.rows[0].fileName, '账单.xlsx');

  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: { ...bigAccountPrompt(), detailRows: [['Credit Amount'], ['100']] }
    }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_PRIVATE_FIELD'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: { ...bigAccountPrompt(), sourceFilePath: '/Users/name/private.xlsx' }
    }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_PRIVATE_FIELD'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: { ...bigAccountPrompt(), sessionKey: 'template:17' }
    }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_PRIVATE_FIELD'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: bigAccountPrompt({
        rows: Array.from({ length: 1024 }, (_, index) => ({
          index,
          label: `${index + 1}.`,
          sourceRowNumber: index + 2,
          fileName: 'x'.repeat(512)
        }))
      })
    }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_TOO_LARGE'
  );
});

test('三类真实Statement prompt按purpose exact冻结并拒绝未知字段、二维原始行与purpose错配', () => {
  const manual = createStatementPublicInteractionDto({
    token: token({ purpose: 'manual-balance' }),
    prompt: manualBalancePrompt()
  });
  assert.deepEqual(manual.prompt, manualBalancePrompt());

  const scope = createStatementPublicInteractionDto({
    token: token({ purpose: 'scope-generation' }),
    prompt: scopeGenerationPrompt('balance')
  });
  assert.deepEqual(scope.prompt, scopeGenerationPrompt('balance'));

  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const selectionStart = mainSource.indexOf('function buildBigAccountSelectionRequiredResult(');
  const previewStart = mainSource.indexOf('function buildBigAccountPreviewResult(', selectionStart);
  const previewEnd = mainSource.indexOf('\nfunction ', previewStart + 1);
  assert.ok(selectionStart >= 0 && previewStart > selectionStart && previewEnd > previewStart);
  assert.doesNotMatch(
    mainSource.slice(selectionStart, previewStart),
    /contextId/,
    '真实展示DTO本身不含legacy Main handle'
  );
  assert.match(
    mainSource.slice(previewStart, previewEnd),
    /contextId/,
    'legacy preview只为Main全局pending lookup追加旧handle'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: bigAccountPrompt({ contextId: 'legacy-context-1' })
    }),
    (error) => error.code === 'STATEMENT_DTO_KEYS_INVALID'
  );

  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: bigAccountPrompt({ unknown: true })
    }),
    (error) => error.code === 'STATEMENT_DTO_KEYS_INVALID'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: bigAccountPrompt({ rows: [['2026-08-01', 'M001', 'USD', '100']] })
    }),
    (error) => error.code === 'STATEMENT_DTO_SHAPE_INVALID'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token({ purpose: 'manual-balance' }),
      prompt: bigAccountPrompt()
    }),
    (error) => error.code === 'STATEMENT_DTO_KEYS_INVALID'
  );
});

test('Statement exact result validator通过真实冻结PolicyRegistry暴露路径感知finance-safe delegate', () => {
  const policyRegistry = createStatementPolicyRegistry();
  assert.equal(policyRegistry.isFrozen(), true);
  for (const actionKey of STATEMENT_ACTION_KEYS) {
    const policy = policyRegistry.get(actionKey);
    const binding = policyRegistry.getBinding(actionKey, 'result.validatorKey');
    assert.equal(binding, STATEMENT_RESULT_VALIDATORS[actionKey]);
    assert.equal(typeof binding.allowFinanceSafeValue, 'function');
    assert.deepEqual(
      STATEMENT_ACTION_PURPOSES[actionKey],
      actionKey === 'statement:import'
        ? ['big-account', 'manual-balance']
        : actionKey.startsWith('statement:generate-')
          ? ['manual-balance', 'scope-generation']
          : ['manual-balance']
    );
    assert.equal(policy.production.enabled, false);
    assert.equal(policy.production.effectiveMode, 'legacy');
    assert.equal(policy.production.effectiveWorkerCount, 0);
  }
});

test('16/20位merchantId仅在三purpose真实progress/done wrapper的exact domain slot通过', () => {
  const policyRegistry = createStatementPolicyRegistry();
  const bigInteraction = createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt({
      bigAccounts: [{
        merchantId: '6222021234567890',
        currencies: ['USD'],
        isMultiCurrency: false
      }],
      expandedBigAccountOptions: [{
        merchantId: '62220212345678901234',
        currency: 'USD',
        accountNature: 'client'
      }],
      fixedAssignments: [{
        merchantId: '6217001234567890',
        currency: 'USD',
        rowIndex: 0
      }]
    })
  });
  assert.doesNotThrow(() => statementEventEnvelope({
    actionKey: 'statement:import',
    operation: 'job:progress',
    payload: { progress: bigInteraction }
  }, policyRegistry));
  const bigResult = createStatementInteractionRequiredResult({
    status: 'interaction-required',
    interaction: bigInteraction
  }, 'statement:import');
  assert.doesNotThrow(() => statementEventEnvelope({
    actionKey: 'statement:import',
    operation: 'job:done',
    payload: { result: bigResult }
  }, policyRegistry));
  assert.deepEqual(
    validateResultBody(
      policyRegistry.get('statement:import'),
      bigResult,
      policyRegistry.getBinding('statement:import', 'result.validatorKey')
    ),
    bigResult
  );

  const manualInteraction = createStatementPublicInteractionDto({
    token: token({ purpose: 'manual-balance' }),
    prompt: manualBalancePrompt({ merchantId: '62220212345678901234' })
  });
  assert.doesNotThrow(() => statementEventEnvelope({
    actionKey: 'statement:resolve-manual-balance',
    operation: 'job:progress',
    payload: { progress: manualInteraction }
  }, policyRegistry));
  const manualResult = createStatementInteractionRequiredResult({
    status: 'interaction-required',
    interaction: manualInteraction
  }, 'statement:resolve-manual-balance');
  assert.doesNotThrow(() => statementEventEnvelope({
    actionKey: 'statement:resolve-manual-balance',
    operation: 'job:done',
    payload: { result: manualResult }
  }, policyRegistry));
  assert.doesNotThrow(() => validateResultBody(
    policyRegistry.get('statement:resolve-manual-balance'),
    manualResult,
    policyRegistry.getBinding('statement:resolve-manual-balance', 'result.validatorKey')
  ));

  const scopeInteraction = createStatementPublicInteractionDto({
    token: token({ purpose: 'scope-generation' }),
    prompt: scopeGenerationPrompt('detail')
  });
  const scopeResult = createStatementInteractionRequiredResult({
    status: 'interaction-required',
    interaction: scopeInteraction
  }, 'statement:generate-current');
  assert.doesNotThrow(() => statementEventEnvelope({
    actionKey: 'statement:generate-current',
    operation: 'job:progress',
    payload: { progress: scopeInteraction }
  }, policyRegistry));
  assert.doesNotThrow(() => statementEventEnvelope({
    actionKey: 'statement:generate-current',
    operation: 'job:done',
    payload: { result: scopeResult }
  }, policyRegistry));
  assert.doesNotThrow(() => validateResultBody(
    policyRegistry.get('statement:generate-current'),
    scopeResult,
    policyRegistry.getBinding('statement:generate-current', 'result.validatorKey')
  ));
});

test('merchantId例外对错误action/purpose/path/parent/unknown key保持fail closed', () => {
  const policyRegistry = createStatementPolicyRegistry();
  const account = '62220212345678901234';
  const bigInteraction = createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt({
      bigAccounts: [{ merchantId: account, currencies: ['USD'], isMultiCurrency: false }],
      expandedBigAccountOptions: [{
        merchantId: account,
        currency: 'USD',
        accountNature: 'client'
      }],
      fixedAssignments: [{ merchantId: account, currency: 'USD', rowIndex: 0 }]
    })
  });

  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:resolve-big-account',
      operation: 'job:progress',
      payload: { progress: bigInteraction }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/progress/prompt/bigAccounts/0/merchantId'
  );

  const wrongPath = structuredClone(bigInteraction);
  wrongPath.prompt.message = account;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:import',
      operation: 'job:progress',
      payload: { progress: wrongPath }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/progress/prompt/message'
  );

  const wrongParent = structuredClone(bigInteraction);
  wrongParent.prompt.bigAccounts[0].unknown = true;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:import',
      operation: 'job:progress',
      payload: { progress: wrongParent }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/progress/prompt/bigAccounts/0/merchantId'
  );

  for (const field of ['expandedBigAccountOptions', 'fixedAssignments']) {
    const wrongItemParent = structuredClone(bigInteraction);
    wrongItemParent.prompt[field][0].unknown = true;
    assert.throws(
      () => statementEventEnvelope({
        actionKey: 'statement:import',
        operation: 'job:progress',
        payload: { progress: wrongItemParent }
      }, policyRegistry),
      (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
        error.path === `/payload/progress/prompt/${field}/0/merchantId`
    );
  }

  const wrongManualParent = structuredClone(createStatementPublicInteractionDto({
    token: token({ purpose: 'manual-balance' }),
    prompt: manualBalancePrompt({ merchantId: account })
  }));
  wrongManualParent.prompt.queueTotal = 0;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:resolve-manual-balance',
      operation: 'job:progress',
      payload: { progress: wrongManualParent }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/progress/prompt/merchantId'
  );

  const privateFileName = structuredClone(bigInteraction);
  privateFileName.prompt.rows[0].fileName = account;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:import',
      operation: 'job:progress',
      payload: { progress: privateFileName }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/progress/prompt/rows/0/fileName'
  );

  const scopeWithMerchant = structuredClone(createStatementPublicInteractionDto({
    token: token({ purpose: 'scope-generation' }),
    prompt: scopeGenerationPrompt('balance')
  }));
  scopeWithMerchant.prompt.merchantId = account;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:generate-all',
      operation: 'job:progress',
      payload: { progress: scopeWithMerchant }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/progress/prompt/merchantId'
  );

  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:import',
      operation: 'job:done',
      payload: { result: bigInteraction }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/result/prompt/bigAccounts/0/merchantId'
  );

  const wrongPurposeInteraction = structuredClone(bigInteraction);
  wrongPurposeInteraction.purpose = 'manual-balance';
  const wrongPurposeResult = {
    status: 'interaction-required',
    interaction: wrongPurposeInteraction
  };
  assert.doesNotThrow(() => statementEventEnvelope({
    actionKey: 'statement:import',
    operation: 'job:done',
    payload: { result: wrongPurposeResult }
  }, policyRegistry));
  assert.throws(
    () => validateResultBody(
      policyRegistry.get('statement:import'),
      wrongPurposeResult,
      policyRegistry.getBinding('statement:import', 'result.validatorKey')
    ),
    (error) => error.code === 'RESULT_VALIDATION_FAILED'
  );

  const unknownResultKey = {
    status: 'interaction-required',
    interaction: bigInteraction,
    rawRows: []
  };
  assert.throws(
    () => validateResultBody(
      policyRegistry.get('statement:import'),
      unknownResultKey,
      policyRegistry.getBinding('statement:import', 'result.validatorKey')
    ),
    (error) => error.code === 'RESULT_VALIDATION_FAILED'
  );
});

function maximalBigAccountPublicDto() {
  const rows = Array.from({ length: 1024 }, (_, index) => ({
    index,
    label: `${index + 1}.`,
    sourceRowNumber: index + 2,
    fileName: ''
  }));
  const prompt = bigAccountPrompt({ rows });
  let dto = createStatementPublicInteractionDto({ token: token(), prompt });
  let remaining = STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes - utf8Size(dto);
  for (const row of rows) {
    const count = Math.min(512, remaining);
    row.fileName = 'x'.repeat(count);
    remaining -= count;
    if (remaining === 0) break;
  }
  assert.equal(remaining, 0, '合法summary rows必须能填满保守inner ceiling');
  dto = createStatementPublicInteractionDto({ token: token(), prompt });
  assert.equal(utf8Size(dto), STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes);
  return { dto, prompt, rows };
}

test('最大合法public interaction经真实最大route/context Protocol envelope仍可发送，+1 byte预先拒绝', () => {
  const { dto, prompt, rows } = maximalBigAccountPublicDto();
  const operationKey = 'o'.repeat(512);
  const envelope = createJobEnvelope({
    direction: 'event',
    operation: 'job:progress',
    actionKey: 'statement:resolve-big-account',
    operationKey,
    jobId: 'j'.repeat(160),
    workerInstanceId: 'w'.repeat(160),
    serviceGeneration: 3,
    unitId: null,
    seq: 1,
    context: {
      kind: 'operation',
      value: {
        taskRunId: 'r'.repeat(512),
        taskKey: 'k'.repeat(512),
        moduleId: 'm'.repeat(512),
        parentRunId: 'p'.repeat(512),
        operationKey
      }
    },
    payload: { progress: dto }
  }, { policyRegistry: JSON.parse(fs.readFileSync(POLICY_FIXTURE, 'utf8')) });
  const serialized = serializeEnvelope(envelope, {
    policyRegistry: JSON.parse(fs.readFileSync(POLICY_FIXTURE, 'utf8'))
  });
  const wrapperBytes = Buffer.byteLength(serialized) - utf8Size(dto);
  assert.ok(wrapperBytes <= STATEMENT_RESOURCE_CONTRACT.publicInteractionWireReserveBytes);
  assert.ok(Buffer.byteLength(serialized) <= STATEMENT_RESOURCE_CONTRACT.protocolEnvelopeMaxBytes);

  const expandableRow = rows.find((row) => row.fileName.length < 512);
  assert.ok(expandableRow, '至少一行仍可在单字段上合法增加一个byte');
  expandableRow.fileName += 'x';
  assert.throws(
    () => createStatementPublicInteractionDto({ token: token(), prompt }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_TOO_LARGE'
  );
});

test('Token/status DTO对extra key、getter、Proxy、digest和outstanding数量fail closed且零getter读取', () => {
  assert.throws(
    () => createStatementTokenHandleDto({ ...token(), privateContext: {} }),
    (error) => error.code === 'STATEMENT_DTO_KEYS_INVALID'
  );
  assert.throws(
    () => createStatementTokenHandleDto(token({ allowedChoiceDigest: 'ABC' })),
    (error) => error.code === 'STATEMENT_TOKEN_DIGEST_INVALID'
  );

  let getterReads = 0;
  const getterToken = token();
  Object.defineProperty(getterToken, 'tokenId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'opaque-token-1';
    }
  });
  assert.throws(
    () => createStatementTokenHandleDto(getterToken),
    (error) => error.code === 'STATEMENT_DTO_PROPERTY_INVALID'
  );
  assert.equal(getterReads, 0);
  assert.throws(
    () => createStatementTokenHandleDto(new Proxy(token(), {})),
    (error) => error.code === 'STATEMENT_DTO_SHAPE_INVALID'
  );

  let promptGetterReads = 0;
  const hostilePrompt = {};
  Object.defineProperty(hostilePrompt, 'detailRows', {
    enumerable: true,
    get() {
      promptGetterReads += 1;
      return [];
    }
  });
  assert.throws(
    () => createStatementPublicInteractionDto({ token: token(), prompt: hostilePrompt }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_JSON_INVALID'
  );
  assert.equal(promptGetterReads, 0);

  const status = createStatementStatusDto({
    serviceGeneration: 3,
    sessionRevision: 9,
    sessionCount: 1,
    batchCount: 2,
    fileCount: 3,
    rowCount: 1200,
    pendingInteractionCount: 1,
    pendingInteractions: [{ purpose: 'manual-balance', expiresAt: 1787847300000 }],
    activePhase: 'waiting-user'
  });
  assert.deepEqual(status.pendingInteractions, [
    { expiresAt: 1787847300000, purpose: 'manual-balance' }
  ]);
  assert.equal(JSON.stringify(status).includes('tokenId'), false);
  assert.equal(JSON.stringify(status).includes('reservation'), false);

  assert.throws(
    () => createStatementStatusDto({
      serviceGeneration: 3,
      sessionRevision: 9,
      sessionCount: 1,
      batchCount: 2,
      fileCount: 3,
      rowCount: 1200,
      pendingInteractionCount: 2,
      pendingInteractions: [
        { purpose: 'big-account', expiresAt: 1787847300000 },
        { purpose: 'manual-balance', expiresAt: 1787847300001 }
      ],
      activePhase: 'waiting-user'
    }),
    (error) => error.code === 'STATEMENT_STATUS_INTERACTION_COUNT_INVALID'
  );
});

test('footprint覆盖Statement数组metadata/共享引用/循环图并按50% headroom页对齐', () => {
  const rows = [['BillDate', 'Credit Amount'], ['2026-08-01', '100']];
  rows.rowMetas = [{ sourceRowNumber: 2 }];
  rows.issues = [{ type: 'currency-unmapped', rawValue: '测试币' }];
  Object.defineProperty(rows, 'recognitionBasis', {
    enumerable: false,
    value: { version: 1, accounts: ['M001'] }
  });
  const state = {
    sessions: new Map([['template:1', { fileEntries: [{ detailRows: rows }] }]]),
    stableSummary: { rowCount: 1 },
    duplicateReference: rows
  };
  state.self = state;

  const withoutMetadata = [['BillDate', 'Credit Amount'], ['2026-08-01', '100']];
  assert.ok(
    estimateStatementValueBytes(rows) > estimateStatementValueBytes(withoutMetadata),
    '数组自定义 metadata 必须纳入 footprint'
  );
  const footprint = estimateStatementServiceStateFootprint(state);
  assert.equal(footprint.estimatedBytes, roundStatementReservationBytes(
    Math.ceil(footprint.rawBytes * 3 / 2)
  ));
  assert.equal(footprint.estimatedBytes % 4096, 0);
  assert.equal(footprint.budgetBytes, STATEMENT_RESOURCE_CONTRACT.persistentStateBudgetBytes);
});

test('state与pending interaction使用独立预算，超限和hostile graph在reservation前拒绝', () => {
  const privateContext = {
    purpose: 'big-account',
    fileEntries: [{ detailRows: [['MerchantId'], ['M001']] }],
    allowedChoices: [{ merchantId: 'M001', currencies: ['USD'] }]
  };
  const footprint = estimateStatementPendingInteractionFootprint(privateContext);
  assert.equal(footprint.kind, 'pending-interaction');
  assert.equal(footprint.budgetBytes, STATEMENT_RESOURCE_CONTRACT.pendingInteractionBudgetBytes);

  assert.throws(
    () => estimateStatementPendingInteractionFootprint(privateContext, { budgetBytes: 4095 }),
    (error) => error.code === 'STATEMENT_PENDING_INTERACTION_BUDGET_EXCEEDED'
  );
  assert.throws(
    () => estimateStatementPendingInteractionFootprint(privateContext, {
      budgetBytes: STATEMENT_RESOURCE_CONTRACT.pendingInteractionBudgetBytes + 1
    }),
    /may only tighten/
  );
  assert.throws(
    () => estimateStatementServiceStateFootprint({ callback() {} }),
    (error) => error.code === 'STATEMENT_FOOTPRINT_TYPE_FORBIDDEN'
  );
  const getterState = {};
  Object.defineProperty(getterState, 'rows', { enumerable: true, get: () => [] });
  assert.throws(
    () => estimateStatementServiceStateFootprint(getterState),
    (error) => error.code === 'STATEMENT_FOOTPRINT_ACCESSOR_FORBIDDEN'
  );
  assert.throws(
    () => estimateStatementServiceStateFootprint(new Proxy({ rows: [] }, {})),
    (error) => error.code === 'STATEMENT_FOOTPRINT_PROXY_FORBIDDEN'
  );
  class HostileMap extends Map {
    *[Symbol.iterator]() {
      throw new Error('must not iterate');
    }
  }
  assert.throws(
    () => estimateStatementServiceStateFootprint({ sessions: new HostileMap() }),
    (error) => error.code === 'STATEMENT_FOOTPRINT_PROTOTYPE_FORBIDDEN'
  );
});

test('production-shape不需要binary，large view/slice/shared backing均O(1)拒绝且own getter零读取', () => {
  const sharedBacking = new ArrayBuffer(1024);
  assert.throws(
    () => estimateStatementValueBytes({
      left: new Uint8Array(sharedBacking, 0, 512),
      right: new Uint8Array(sharedBacking, 512, 512)
    }),
    (error) => error.code === 'STATEMENT_FOOTPRINT_BINARY_FORBIDDEN'
  );

  const whole = Buffer.allocUnsafeSlow(1024);
  const slice = whole.subarray(100, 200);
  assert.throws(
    () => estimateStatementValueBytes(slice),
    (error) => error.code === 'STATEMENT_FOOTPRINT_BINARY_FORBIDDEN'
  );

  let getterReads = 0;
  const hostile = new Uint8Array(4);
  Object.defineProperty(hostile, 'metadata', {
    enumerable: true,
    get() {
      getterReads += 1;
      return { retained: 'x'.repeat(1000) };
    }
  });
  assert.throws(
    () => estimateStatementValueBytes(hostile),
    (error) => error.code === 'STATEMENT_FOOTPRINT_BINARY_FORBIDDEN'
  );
  assert.equal(getterReads, 0);

  const largeView = new Uint8Array(16 * 1024 * 1024);
  const startedAt = process.hrtime.bigint();
  assert.throws(
    () => estimateStatementValueBytes(largeView),
    (error) => error.code === 'STATEMENT_FOOTPRINT_BINARY_FORBIDDEN'
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 250, `large view必须快速拒绝，实际${elapsedMs.toFixed(2)}ms`);
});

test('Map/Set只接受exact built-in无own retained graph且不消费变异iterator', () => {
  const map = new Map([['key', { value: 1 }]]);
  map.extra = { retained: true };
  assert.throws(
    () => estimateStatementValueBytes(map),
    (error) => error.code === 'STATEMENT_FOOTPRINT_BUILTIN_OWN_STATE_FORBIDDEN'
  );

  let iteratorReads = 0;
  const set = new Set(['value']);
  Object.defineProperty(set, Symbol.iterator, {
    enumerable: false,
    value() {
      iteratorReads += 1;
      throw new Error('must not iterate');
    }
  });
  assert.throws(
    () => estimateStatementValueBytes(set),
    (error) => error.code === 'STATEMENT_FOOTPRINT_BUILTIN_OWN_STATE_FORBIDDEN'
  );
  assert.equal(iteratorReads, 0);
});

test('E09-P0 contract/footprint未接入Main live IPC或background runtime', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const backgroundIndex = fs.readFileSync(
    path.join(ROOT, 'src', 'main-process', 'background-execution', 'index.js'),
    'utf8'
  );
  assert.equal(mainSource.includes("require('./main-process/statement-worker"), false);
  assert.equal(backgroundIndex.includes('statement-worker'), false);
});
