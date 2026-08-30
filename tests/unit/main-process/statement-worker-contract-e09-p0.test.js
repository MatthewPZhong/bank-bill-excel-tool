'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  STATEMENT_ACTION_PURPOSES,
  STATEMENT_RESOURCE_CONTRACT,
  STATEMENT_RESULT_VALIDATORS,
  createStatementBalanceSeedOverwritePrivateContextDto,
  createStatementBalanceSeedOverwritePromptDto,
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
  parseAndValidateEnvelope,
  serializeEnvelope
} = require('../../../src/main-process/background-execution/protocol');
const {
  utf8Size
} = require('../../../src/main-process/background-execution/protocol-validator');
const {
  createExecutionSupervisor,
  validateResultBody
} = require('../../../src/main-process/background-execution/supervisor');
const {
  createResourceGovernor
} = require('../../../src/main-process/background-execution/resource-governor');

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

function statementEventForCommand(
  command,
  operation,
  payload,
  policyRegistry,
  validate = true,
  seq = 1
) {
  return createJobEnvelope({
    direction: 'event',
    operation,
    actionKey: command.actionKey,
    operationKey: command.operationKey,
    jobId: command.jobId,
    workerInstanceId: command.workerInstanceId,
    serviceGeneration: command.serviceGeneration,
    unitId: null,
    seq,
    context: command.context,
    payload
  }, validate ? { policyRegistry } : { validate: false });
}

function createStatementSupervisorHarness(policyRegistry, onJobStart) {
  const resourceGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 16,
      workerThreadSlots: 16,
      utilityProcessSlots: 4,
      ioHeavySlots: 16,
      memoryBytes: 2 * 1024 * 1024 * 1024
    }
  });
  const serviceHost = Object.freeze({
    async openJob(openRequest) {
      return {
        workerInstanceId: 'statement-supervisor-worker',
        serviceGeneration: 3,
        createdGeneration: false,
        baseLeaseId: 'statement-supervisor-base',
        baseResources: policyRegistry.get(openRequest.actionKey).resources.base,
        ready: Promise.resolve(),
        send(message) {
          if (message.operation === 'job:start') onJobStart(message, openRequest);
        },
        close() {},
        async terminate() {}
      };
    },
    async closeService() { return false; },
    stopAcceptingNewServices() {},
    async shutdown() { return Object.freeze([]); },
    snapshot() { return Object.freeze({ services: Object.freeze([]) }); }
  });
  return createExecutionSupervisor({ policyRegistry, resourceGovernor, serviceHost });
}

function statementSupervisorRequest(onProgress, overrides = {}) {
  const operationKey = 'statement-supervisor-operation';
  return {
    actionKey: 'statement:import',
    operationKey,
    jobId: 'statement-supervisor-job',
    input: {},
    context: {
      kind: 'operation',
      value: {
        taskRunId: 'statement-supervisor-task-run',
        taskKey: 'statement-supervisor-task',
        moduleId: 'statement',
        parentRunId: 'statement-supervisor-parent-run',
        operationKey
      }
    },
    onProgress,
    ...overrides
  };
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

function balanceSeedOverwritePrompt(overrides = {}) {
  return {
    ...createStatementBalanceSeedOverwritePromptDto(),
    ...overrides
  };
}

function legacyMainMismatchMessage(failedFileNames) {
  return failedFileNames
    .map((name) => `${name}的账户个数或账户号匹配不上（账户个数和账户号都匹配不上），请检查。`)
    .join('\n');
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

function statementStatusInput(overrides = {}) {
  return {
    serviceGeneration: 3,
    sessionRevision: 9,
    sessionCount: 1,
    batchCount: 2,
    fileCount: 3,
    rowCount: 1200,
    pendingInteractionCount: 0,
    pendingInteractions: [],
    activePhase: 'idle',
    ...overrides
  };
}

function assertStatusPendingInteractionsError(pendingInteractions, count, expectedCode) {
  assert.throws(
    () => createStatementStatusDto(statementStatusInput({
      pendingInteractionCount: count,
      pendingInteractions
    })),
    (error) => error.code === expectedCode
  );
}

function formattedBigAccountInteraction() {
  return createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt({
      bigAccounts: [{
        merchantId: '6222 0212 3456 7890',
        currencies: ['USD'],
        isMultiCurrency: false
      }, {
        merchantId: '62220212345678901234',
        currencies: ['EUR'],
        isMultiCurrency: false
      }],
      expandedBigAccountOptions: [{
        merchantId: '6222-0212-3456-7890-1234',
        currency: 'USD',
        accountNature: 'client'
      }],
      fixedAssignments: [{
        merchantId: '6217 0012-3456 7890',
        currency: 'USD',
        rowIndex: 0
      }]
    })
  });
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
  assert.equal(publicDto.prompt.rows[0].fileName, '来源文件 1');
  assert.equal(publicDto.prompt.rowsWithEmptyBlocks[0].fileName, '来源文件 1');

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
  const rawNameHeavy = createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt({
      rows: Array.from({ length: 1024 }, (_, index) => ({
        index,
        label: `${index + 1}.`,
        sourceRowNumber: index + 2,
        fileName: `${'6'.repeat(480)}-${index}`.slice(0, 512)
      }))
    })
  });
  assert.equal(rawNameHeavy.prompt.rows[0].fileName, '来源文件 1');
  assert.equal(rawNameHeavy.prompt.rows[1023].fileName, '来源文件 1024');
  assert.equal(JSON.stringify(rawNameHeavy).includes('6'.repeat(32)), false);

  const mismatch = createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt({
      status: 'remember-order-mismatch',
      message: `原始文件：${'6222021234567890.xlsx、'.repeat(200)}`,
      rows: [
        { index: 0, label: '1.', sourceRowNumber: 2, fileName: '6222021234567890.xlsx' },
        { index: 1, label: '2.', sourceRowNumber: 2, fileName: '客户私有目录.xlsx' }
      ],
      rowsWithEmptyBlocks: [
        { index: 0, label: '1.', sourceRowNumber: 2, fileName: '6222021234567890.xlsx' },
        { index: 1, label: '2.', sourceRowNumber: 2, fileName: '客户私有目录.xlsx' }
      ],
      failedFileNames: ['客户私有目录.xlsx', '6222021234567890.xlsx'],
      forceMode: 'fixed'
    })
  });
  assert.deepEqual(mismatch.prompt.rows.map((row) => row.fileName), ['来源文件 1', '来源文件 2']);
  assert.deepEqual(mismatch.prompt.failedFileNames, ['来源文件 2', '来源文件 1']);
  assert.equal(
    mismatch.prompt.message,
    '部分来源文件的账户个数或账户号无法自动匹配，请检查后重新选择（共2个：来源文件 2、来源文件 1）'
  );
  assert.doesNotMatch(JSON.stringify(mismatch), /6222021234567890|客户私有目录/);

  const boundedMismatch = createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt({
      status: 'remember-order-mismatch',
      message: `旧实现会拼接：${'6222021234567890.xlsx、'.repeat(1024)}`,
      failedFileNames: Array.from(
        { length: 1024 },
        (_, index) => `${String(index).padStart(4, '0')}-${'x'.repeat(507)}`
      ),
      forceMode: 'unfixed'
    })
  });
  assert.equal(boundedMismatch.prompt.failedFileNames.length, 1024);
  assert.ok(boundedMismatch.prompt.message.length < 1024);
  assert.match(boundedMismatch.prompt.message, /共1024个/);
  assert.ok(utf8Size(boundedMismatch) < STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes);

  const maxLegacyBasenames = Array.from({ length: 1024 }, (_, index) => {
    const prefix = `${String(index).padStart(4, '0')}-`;
    return `${prefix}${'x'.repeat(255 - prefix.length)}`;
  });
  const legacyMessage = legacyMainMismatchMessage(maxLegacyBasenames);
  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(
    mainSource,
    /failedFileNames\s*\.map\(\(name\) => `\$\{name\}的账户个数或账户号匹配不上（账户个数和账户号都匹配不上），请检查。`\)\s*\.join\('\\n'\)/,
    '测试拼接公式必须与Main真实legacy producer保持一致'
  );
  assert.ok(
    Buffer.byteLength(legacyMessage, 'utf8') >
      STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes,
    'alias前必定丢弃的legacy message可合法超过public DTO ceiling'
  );
  const maxLegacyMismatch = createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt({
      status: 'remember-order-mismatch',
      message: legacyMessage,
      failedFileNames: maxLegacyBasenames,
      forceMode: 'unfixed'
    })
  });
  const maxLegacyResult = createStatementInteractionRequiredResult({
    status: 'interaction-required',
    interaction: maxLegacyMismatch
  }, 'statement:import');
  const policyRegistry = createStatementPolicyRegistry();
  assert.equal(policyRegistry.isFrozen(), true);
  const maxLegacyEnvelope = statementEventEnvelope({
    actionKey: 'statement:import',
    operation: 'job:done',
    payload: { result: maxLegacyResult }
  }, policyRegistry);
  const maxLegacySerialized = serializeEnvelope(maxLegacyEnvelope, { policyRegistry });
  assert.ok(utf8Size(maxLegacyMismatch) < STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes);
  assert.ok(
    Buffer.byteLength(maxLegacySerialized, 'utf8') <
      STATEMENT_RESOURCE_CONTRACT.protocolEnvelopeMaxBytes
  );
  assert.doesNotMatch(maxLegacySerialized, new RegExp(maxLegacyBasenames[0]));
  assert.doesNotThrow(() => validateResultBody(
    policyRegistry.get('statement:import'),
    maxLegacyResult,
    policyRegistry.getBinding('statement:import', 'result.validatorKey')
  ));
  for (const message of ['', null]) {
    assert.throws(
      () => createStatementPublicInteractionDto({
        token: token(),
        prompt: bigAccountPrompt({ message })
      }),
      (error) => error.code === 'STATEMENT_DTO_TEXT_INVALID'
    );
  }
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

test('overwrite confirmation冻结manual-balance单token的exact private/public result且拒绝重对象', () => {
  const privateContextInput = {
    kind: 'balance-seed-overwrite',
    purpose: 'manual-balance',
    serviceGeneration: 3,
    sessionRevision: 9,
    record: {
      bankName: '中行',
      merchantId: '6222 0212 3456 7890',
      currency: 'USD',
      billDate: '2026-07-31',
      endBalance: 1234.56,
      templateName: '中行-上海',
      generationMethod: '人工录入',
      existingIndex: 0
    },
    freshnessEvidence: {
      recordsDigest: 'b'.repeat(64),
      inputSourcesDigest: 'c'.repeat(64),
      statementSessionKey: 'template:17',
      currentBatchId: 'batch-2',
      scope: 'all'
    },
    inputSourceCount: 2,
    allowedChoiceDigest: 'a'.repeat(64)
  };
  const privateContext = createStatementBalanceSeedOverwritePrivateContextDto(privateContextInput);
  const interaction = createStatementPublicInteractionDto({
    token: token({ purpose: 'manual-balance' }),
    prompt: balanceSeedOverwritePrompt()
  });
  const publicResult = createStatementInteractionRequiredResult({
    status: 'interaction-required',
    interaction
  }, 'statement:resolve-manual-balance');

  assert.equal(Object.isFrozen(privateContext), true);
  assert.deepEqual(publicResult, {
    interaction: {
      allowedChoiceDigest: 'a'.repeat(64),
      expiresAt: 1787847300000,
      prompt: balanceSeedOverwritePrompt(),
      purpose: 'manual-balance',
      serviceGeneration: 3,
      sessionRevision: 9,
      tokenId: 'opaque-token-1'
    },
    status: 'interaction-required'
  });
  assert.equal(Object.hasOwn(publicResult.interaction.prompt, 'tokenId'), false);
  assert.equal(Object.hasOwn(publicResult.interaction, 'contextId'), false);
  assert.doesNotMatch(
    JSON.stringify(privateContext),
    /storageRoot|records\"|inputFilePaths|importContext|session\"|assertFresh|contextId/
  );
  assert.throws(
    () => createStatementBalanceSeedOverwritePrivateContextDto({
      ...privateContextInput,
      assertFresh() {}
    }),
    (error) => error.code === 'STATEMENT_DTO_KEYS_INVALID'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: balanceSeedOverwritePrompt()
    }),
    (error) => ['STATEMENT_PUBLIC_DTO_STATUS_INVALID', 'STATEMENT_DTO_KEYS_INVALID'].includes(
      error.code
    )
  );
  assert.throws(
    () => createStatementInteractionRequiredResult({
      status: 'interaction-required',
      interaction
    }, 'statement:import'),
    (error) => error.code === 'STATEMENT_RESULT_PURPOSE_INVALID'
  );
  for (const prompt of [
    balanceSeedOverwritePrompt({ status: 'overwrite' }),
    balanceSeedOverwritePrompt({ message: '确认吗？' }),
    balanceSeedOverwritePrompt({ unknown: true })
  ]) {
    assert.throws(
      () => createStatementPublicInteractionDto({
        token: token({ purpose: 'manual-balance' }),
        prompt
      }),
      (error) => [
        'STATEMENT_BALANCE_SEED_OVERWRITE_PROMPT_INVALID',
        'STATEMENT_DTO_KEYS_INVALID'
      ].includes(error.code)
    );
  }
  assert.equal(
    Object.hasOwn(
      require('../../../src/main-process/statement-worker/contracts'),
      'createStatementBalanceSeedOverwriteContinuationDto'
    ),
    false,
    '不得保留绕过canonical result wrapper的孤立overwrite transport'
  );
});

test('overwrite result经真实Registry/Protocol/validateResult/Supervisor接受且tamper/错action/错purpose拒绝', async () => {
  const policyRegistry = createStatementPolicyRegistry();
  assert.equal(policyRegistry.isFrozen(), true);
  const interaction = createStatementPublicInteractionDto({
    token: token({ purpose: 'manual-balance' }),
    prompt: balanceSeedOverwritePrompt()
  });
  const result = createStatementInteractionRequiredResult({
    status: 'interaction-required',
    interaction
  }, 'statement:resolve-manual-balance');
  const binding = policyRegistry.getBinding(
    'statement:resolve-manual-balance',
    'result.validatorKey'
  );

  assert.equal(binding, STATEMENT_RESULT_VALIDATORS['statement:resolve-manual-balance']);
  assert.doesNotThrow(() => statementEventEnvelope({
    actionKey: 'statement:resolve-manual-balance',
    operation: 'job:done',
    payload: { result }
  }, policyRegistry));
  assert.deepEqual(
    validateResultBody(policyRegistry.get('statement:resolve-manual-balance'), result, binding),
    result
  );

  const tamperedMessage = structuredClone(result);
  tamperedMessage.interaction.prompt.message = '确认覆盖吗？';
  const wrongPurpose = structuredClone(result);
  wrongPurpose.interaction.purpose = 'big-account';
  for (const invalid of [tamperedMessage, wrongPurpose]) {
    assert.throws(
      () => validateResultBody(
        policyRegistry.get('statement:resolve-manual-balance'),
        invalid,
        binding
      ),
      (error) => error.code === 'RESULT_VALIDATION_FAILED'
    );
  }
  assert.throws(
    () => validateResultBody(
      policyRegistry.get('statement:import'),
      result,
      policyRegistry.getBinding('statement:import', 'result.validatorKey')
    ),
    (error) => error.code === 'RESULT_VALIDATION_FAILED'
  );

  const supervisor = createStatementSupervisorHarness(policyRegistry, (command, openRequest) => {
    openRequest.onMessage(statementEventForCommand(
      command,
      'job:done',
      { result },
      policyRegistry
    ));
  });
  const completed = await supervisor.execute(statementSupervisorRequest(
    () => {},
    {
      actionKey: 'statement:resolve-manual-balance',
      jobId: 'statement-supervisor-overwrite-canonical'
    }
  ));
  assert.equal(completed.outcome, 'completed');
  assert.deepEqual(completed.result, result);
  await supervisor.shutdown({ timeoutMs: 1000 });

  const wrongActionSupervisor = createStatementSupervisorHarness(
    policyRegistry,
    (command, openRequest) => {
      openRequest.onMessage(statementEventForCommand(
        command,
        'job:done',
        { result },
        policyRegistry
      ));
    }
  );
  const rejected = await wrongActionSupervisor.execute(statementSupervisorRequest(
    () => {},
    {
      actionKey: 'statement:import',
      jobId: 'statement-supervisor-overwrite-wrong-action'
    }
  ));
  assert.equal(rejected.outcome, 'transport-lost');
  assert.equal(rejected.terminalSource, 'protocol-error');
  assert.equal(rejected.error.code, 'RESULT_VALIDATION_FAILED');
  assert.equal(rejected.result, null);
  await wrongActionSupervisor.shutdown({ timeoutMs: 1000 });
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

test('纯数字/空格/连字符merchantId仅在三purpose真实done wrapper的四个domain slot通过', () => {
  const policyRegistry = createStatementPolicyRegistry();
  const bigInteraction = formattedBigAccountInteraction();
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
    prompt: manualBalancePrompt({ merchantId: '6222 0212 3456 7890 1234' })
  });
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
    operation: 'job:done',
    payload: { result: scopeResult }
  }, policyRegistry));
  assert.doesNotThrow(() => validateResultBody(
    policyRegistry.get('statement:generate-current'),
    scopeResult,
    policyRegistry.getBinding('statement:generate-current', 'result.validatorKey')
  ));
});

test('done merchantId例外对错误action/purpose/path/parent/unknown key保持fail closed', () => {
  const policyRegistry = createStatementPolicyRegistry();
  const account = '6222 0212 3456 7890 1234';
  const bigInteraction = formattedBigAccountInteraction();
  const interactionResult = (interaction) => ({
    status: 'interaction-required',
    interaction
  });

  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:resolve-big-account',
      operation: 'job:done',
      payload: { result: interactionResult(bigInteraction) }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/result/interaction/prompt/bigAccounts/0/merchantId'
  );

  const wrongPath = structuredClone(bigInteraction);
  wrongPath.prompt.message = account;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:import',
      operation: 'job:done',
      payload: { result: interactionResult(wrongPath) }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/result/interaction/prompt/message'
  );

  const wrongParent = structuredClone(bigInteraction);
  wrongParent.prompt.bigAccounts[0].unknown = true;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:import',
      operation: 'job:done',
      payload: { result: interactionResult(wrongParent) }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/result/interaction/prompt/bigAccounts/0/merchantId'
  );

  for (const field of ['expandedBigAccountOptions', 'fixedAssignments']) {
    const wrongItemParent = structuredClone(bigInteraction);
    wrongItemParent.prompt[field][0].unknown = true;
    assert.throws(
      () => statementEventEnvelope({
        actionKey: 'statement:import',
        operation: 'job:done',
        payload: { result: interactionResult(wrongItemParent) }
      }, policyRegistry),
      (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
        error.path === `/payload/result/interaction/prompt/${field}/0/merchantId`
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
      operation: 'job:done',
      payload: { result: interactionResult(wrongManualParent) }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/result/interaction/prompt/merchantId'
  );

  const privateFileName = structuredClone(bigInteraction);
  privateFileName.prompt.rows[0].fileName = account;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:import',
      operation: 'job:done',
      payload: { result: interactionResult(privateFileName) }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/result/interaction/prompt/rows/0/fileName'
  );

  const safeButUnaliasedFileName = structuredClone(bigInteraction);
  safeButUnaliasedFileName.prompt.rows[0].fileName = 'customer-statement.xlsx';
  const safeButUnaliasedMessage = structuredClone(bigInteraction);
  safeButUnaliasedMessage.prompt.message = '临时展示消息';
  const mismatchInteraction = createStatementPublicInteractionDto({
    token: token(),
    prompt: bigAccountPrompt({
      status: 'remember-order-mismatch',
      failedFileNames: ['statement-a.xlsx'],
      forceMode: 'fixed'
    })
  });
  const safeButUnaliasedFailedName = structuredClone(mismatchInteraction);
  safeButUnaliasedFailedName.prompt.failedFileNames[0] = 'statement-a.xlsx';
  for (const unaliasedInteraction of [
    safeButUnaliasedFileName,
    safeButUnaliasedMessage,
    safeButUnaliasedFailedName
  ]) {
    const unaliasedResult = interactionResult(unaliasedInteraction);
    assert.doesNotThrow(() => statementEventEnvelope({
      actionKey: 'statement:import',
      operation: 'job:done',
      payload: { result: unaliasedResult }
    }, policyRegistry));
    assert.throws(
      () => validateResultBody(
        policyRegistry.get('statement:import'),
        unaliasedResult,
        policyRegistry.getBinding('statement:import', 'result.validatorKey')
      ),
      (error) => error.code === 'RESULT_VALIDATION_FAILED'
    );
  }

  const scopeWithMerchant = structuredClone(createStatementPublicInteractionDto({
    token: token({ purpose: 'scope-generation' }),
    prompt: scopeGenerationPrompt('balance')
  }));
  scopeWithMerchant.prompt.merchantId = account;
  assert.throws(
    () => statementEventEnvelope({
      actionKey: 'statement:generate-all',
      operation: 'job:done',
      payload: { result: interactionResult(scopeWithMerchant) }
    }, policyRegistry),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' &&
      error.path === '/payload/result/interaction/prompt/merchantId'
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
  const wrongPurposeResult = interactionResult(wrongPurposeInteraction);
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

test('真实Supervisor在onProgress前拒绝含full-account的Statement interaction progress且接受合法done', async () => {
  const policyRegistry = createStatementPolicyRegistry();
  const validInteraction = formattedBigAccountInteraction();
  const wrongPurpose = structuredClone(validInteraction);
  wrongPurpose.purpose = 'manual-balance';
  const privateExtra = structuredClone(validInteraction);
  privateExtra.prompt.detailRows = [['MerchantId'], ['6222 0212 3456 7890']];
  const nonArrayContainer = structuredClone(validInteraction);
  nonArrayContainer.prompt.bigAccounts = {
    0: nonArrayContainer.prompt.bigAccounts[0]
  };

  for (const [index, progress] of [
    validInteraction,
    wrongPurpose,
    privateExtra,
    nonArrayContainer
  ].entries()) {
    const observed = [];
    const supervisor = createStatementSupervisorHarness(policyRegistry, (command, openRequest) => {
      openRequest.onMessage(statementEventForCommand(
        command,
        'job:progress',
        { progress },
        policyRegistry,
        false
      ));
    });
    const result = await supervisor.execute(statementSupervisorRequest(
      (value) => observed.push(value),
      { jobId: `statement-supervisor-progress-${index}` }
    ));
    assert.equal(result.terminalSource, 'protocol-error');
    assert.equal(result.error.code, 'PROTOCOL_PRIVACY_VIOLATION');
    assert.deepEqual(observed, []);
    await supervisor.shutdown({ timeoutMs: 1000 });
  }

  const observed = [];
  const doneResult = createStatementInteractionRequiredResult({
    status: 'interaction-required',
    interaction: validInteraction
  }, 'statement:import');
  const supervisor = createStatementSupervisorHarness(policyRegistry, (command, openRequest) => {
    openRequest.onMessage(statementEventForCommand(
      command,
      'job:done',
      { result: doneResult },
      policyRegistry
    ));
  });
  const completed = await supervisor.execute(statementSupervisorRequest(
    (value) => observed.push(value),
    { jobId: 'statement-supervisor-done' }
  ));
  assert.equal(completed.outcome, 'completed');
  assert.deepEqual(completed.result, doneResult);
  assert.deepEqual(observed, []);
  await supervisor.shutdown({ timeoutMs: 1000 });
});

test('真实Supervisor让generic-safe M001/scope progress进入onProgress但不产生waiting-user/settlement终态', async () => {
  const policyRegistry = createStatementPolicyRegistry();
  const m001Interaction = createStatementPublicInteractionDto({
    token: token({ purpose: 'manual-balance' }),
    prompt: manualBalancePrompt()
  });
  const scopeInteraction = createStatementPublicInteractionDto({
    token: token({ purpose: 'scope-generation' }),
    prompt: scopeGenerationPrompt()
  });
  const observed = [];
  const supervisor = createStatementSupervisorHarness(policyRegistry, (command, openRequest) => {
    openRequest.onMessage(statementEventForCommand(
      command,
      'job:progress',
      { progress: m001Interaction },
      policyRegistry,
      true,
      1
    ));
    openRequest.onMessage(statementEventForCommand(
      command,
      'job:progress',
      { progress: scopeInteraction },
      policyRegistry,
      true,
      2
    ));
    openRequest.onMessage(statementEventForCommand(
      command,
      'job:error',
      {
        error: {
          code: 'STATEMENT_PROGRESS_BOUNDARY_STOP',
          message: '结束通用progress边界验证',
          stage: 'execute',
          detailLines: []
        }
      },
      policyRegistry,
      true,
      3
    ));
  });
  const execution = await supervisor.execute(statementSupervisorRequest(
    (value) => observed.push(value),
    {
      actionKey: 'statement:generate-current',
      jobId: 'statement-supervisor-generic-safe-progress'
    }
  ));

  assert.equal(policyRegistry.get('statement:generate-current').commit.kind, 'main-settlement');
  assert.deepEqual(observed, [m001Interaction, scopeInteraction]);
  assert.equal(execution.outcome, 'failed');
  assert.equal(execution.terminalSource, 'job:error');
  assert.equal(execution.result, null);
  assert.equal(execution.receiptHint, null);
  assert.equal(execution.error.code, 'STATEMENT_PROGRESS_BOUNDARY_STOP');
  await supervisor.shutdown({ timeoutMs: 1000 });
});

function maximalBigAccountPublicDto() {
  const bigAccounts = Array.from({ length: 1024 }, () => ({
    merchantId: 'M',
    currencies: ['USD'],
    isMultiCurrency: false
  }));
  const prompt = bigAccountPrompt({ bigAccounts });
  let dto = createStatementPublicInteractionDto({ token: token(), prompt });
  let remaining = STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes - utf8Size(dto);
  for (const account of bigAccounts) {
    const count = Math.min(511, remaining);
    account.merchantId += 'x'.repeat(count);
    remaining -= count;
    if (remaining === 0) break;
  }
  assert.equal(remaining, 0, '合法domain summary必须能填满保守inner ceiling');
  dto = createStatementPublicInteractionDto({ token: token(), prompt });
  assert.equal(utf8Size(dto), STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes);
  return { dto, prompt, bigAccounts };
}

test('最大合法public interaction经真实done route/context发送，inner +1与真实over-wire拒绝', () => {
  const { dto, prompt, bigAccounts } = maximalBigAccountPublicDto();
  const policyRegistry = createStatementPolicyRegistry();
  const result = createStatementInteractionRequiredResult({
    status: 'interaction-required',
    interaction: dto
  }, 'statement:import');
  const operationKey = 'o'.repeat(512);
  const envelope = createJobEnvelope({
    direction: 'event',
    operation: 'job:done',
    actionKey: 'statement:import',
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
    payload: { result }
  }, { policyRegistry });
  const serialized = serializeEnvelope(envelope, { policyRegistry });
  const wrapperBytes = Buffer.byteLength(serialized) - utf8Size(dto);
  assert.ok(wrapperBytes <= STATEMENT_RESOURCE_CONTRACT.publicInteractionWireReserveBytes);
  assert.ok(Buffer.byteLength(serialized) <= STATEMENT_RESOURCE_CONTRACT.protocolEnvelopeMaxBytes);
  assert.deepEqual(parseAndValidateEnvelope(serialized, { policyRegistry }), envelope);

  const overWire = serialized + ' '.repeat(
    STATEMENT_RESOURCE_CONTRACT.protocolEnvelopeMaxBytes - Buffer.byteLength(serialized) + 1
  );
  assert.equal(
    Buffer.byteLength(overWire),
    STATEMENT_RESOURCE_CONTRACT.protocolEnvelopeMaxBytes + 1
  );
  assert.throws(
    () => parseAndValidateEnvelope(overWire, { policyRegistry }),
    (error) => error.code === 'PROTOCOL_MESSAGE_TOO_LARGE' &&
      error.details.actualBytes === STATEMENT_RESOURCE_CONTRACT.protocolEnvelopeMaxBytes + 1
  );

  const expandableAccount = bigAccounts.find((account) => account.merchantId.length < 512);
  assert.ok(expandableAccount, '至少一个domain summary字段仍可合法增加一个byte');
  expandableAccount.merchantId += 'x';
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

  const status = createStatementStatusDto(statementStatusInput({
    pendingInteractionCount: 1,
    pendingInteractions: [{ purpose: 'manual-balance', expiresAt: 1787847300000 }],
    activePhase: 'waiting-user'
  }));
  assert.deepEqual(status.pendingInteractions, [
    { expiresAt: 1787847300000, purpose: 'manual-balance' }
  ]);
  assert.equal(JSON.stringify(status).includes('tokenId'), false);
  assert.equal(JSON.stringify(status).includes('reservation'), false);

  assert.throws(
    () => createStatementStatusDto(statementStatusInput({
      pendingInteractionCount: 2,
      pendingInteractions: [
        { purpose: 'big-account', expiresAt: 1787847300000 },
        { purpose: 'manual-balance', expiresAt: 1787847300001 }
      ],
      activePhase: 'waiting-user'
    })),
    (error) => error.code === 'STATEMENT_STATUS_INTERACTION_COUNT_INVALID'
  );
});

test('status pendingInteractions在任何item读取前冻结exact Array shape、count和单token上限', () => {
  const emptyStatus = createStatementStatusDto(statementStatusInput());
  assert.equal(emptyStatus.pendingInteractionCount, 0);
  assert.deepEqual(emptyStatus.pendingInteractions, []);

  const oneStatus = createStatementStatusDto(statementStatusInput({
    pendingInteractionCount: 1,
    pendingInteractions: [{ purpose: 'big-account', expiresAt: 1787847300000 }],
    activePhase: 'waiting-user'
  }));
  assert.deepEqual(oneStatus.pendingInteractions, [
    { expiresAt: 1787847300000, purpose: 'big-account' }
  ]);

  let accessorReads = 0;
  const accessorIndex = [];
  Object.defineProperty(accessorIndex, '0', {
    enumerable: true,
    configurable: true,
    get() {
      accessorReads += 1;
      return { purpose: 'big-account', expiresAt: 1787847300000 };
    }
  });
  assertStatusPendingInteractionsError(
    accessorIndex,
    1,
    'STATEMENT_STATUS_INTERACTIONS_INVALID'
  );
  assert.equal(accessorReads, 0);

  let proxyTraps = 0;
  const proxyArray = new Proxy([], {
    get(target, key, receiver) {
      proxyTraps += 1;
      return Reflect.get(target, key, receiver);
    },
    getPrototypeOf(target) {
      proxyTraps += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      proxyTraps += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      proxyTraps += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  });
  assertStatusPendingInteractionsError(proxyArray, 0, 'STATEMENT_STATUS_INTERACTIONS_INVALID');
  assert.equal(proxyTraps, 0);

  const sparse = new Array(1);
  const extraKey = [];
  extraKey.privateContext = {};
  const symbolKey = [];
  symbolKey[Symbol('private')] = {};
  const customPrototype = [];
  Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
  for (const [value, count] of [
    [sparse, 1],
    [extraKey, 0],
    [symbolKey, 0],
    [customPrototype, 0],
    [Object.create(Array.prototype), 0]
  ]) {
    assertStatusPendingInteractionsError(value, count, 'STATEMENT_STATUS_INTERACTIONS_INVALID');
  }

  let overlimitItemReads = 0;
  const overlimit = [];
  Object.defineProperty(overlimit, '0', {
    enumerable: true,
    configurable: true,
    get() {
      overlimitItemReads += 1;
      return { purpose: 'big-account', expiresAt: 1787847300000 };
    }
  });
  overlimit.length = 2;
  assertStatusPendingInteractionsError(
    overlimit,
    1,
    'STATEMENT_STATUS_INTERACTION_COUNT_INVALID'
  );
  assert.equal(overlimitItemReads, 0);

  assertStatusPendingInteractionsError(
    accessorIndex,
    0,
    'STATEMENT_STATUS_INTERACTION_COUNT_INVALID'
  );
  assert.equal(accessorReads, 0);

  let overcountProxyTraps = 0;
  const overcountProxy = new Proxy([], {
    get() {
      overcountProxyTraps += 1;
      return undefined;
    },
    ownKeys() {
      overcountProxyTraps += 1;
      return ['length'];
    }
  });
  assertStatusPendingInteractionsError(
    overcountProxy,
    2,
    'STATEMENT_STATUS_INTERACTION_COUNT_INVALID'
  );
  assert.equal(overcountProxyTraps, 0);
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
