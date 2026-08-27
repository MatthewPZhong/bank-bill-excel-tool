'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  STATEMENT_RESOURCE_CONTRACT,
  createStatementPublicInteractionDto,
  createStatementStatusDto,
  createStatementTokenHandleDto
} = require('../../../src/main-process/statement-worker/contracts');
const {
  estimateStatementPendingInteractionFootprint,
  estimateStatementServiceStateFootprint,
  estimateStatementValueBytes,
  roundStatementReservationBytes
} = require('../../../src/main-process/statement-worker/state-footprint');

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
const STATEMENT_ACTION_KEYS = Object.freeze([
  'statement:generate-all',
  'statement:generate-current',
  'statement:import',
  'statement:resolve-big-account',
  'statement:resolve-manual-balance'
]);

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
    prompt: {
      status: 'select-big-account',
      rows: [{ index: 0, label: '1.', sourceRowNumber: 2, fileName: '账单.xlsx' }],
      choices: [{ merchantId: 'M001', currencies: ['USD'] }]
    }
  });
  assert.equal(Object.isFrozen(publicDto), true);
  assert.equal(Object.hasOwn(publicDto, 'reservationId'), false);
  assert.equal(Object.hasOwn(publicDto, 'sessionKey'), false);
  assert.equal(publicDto.prompt.rows[0].fileName, '账单.xlsx');

  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: { detailRows: [['Credit Amount'], ['100']] }
    }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_PRIVATE_FIELD'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: { evidence: { sourceFilePath: '/Users/name/private.xlsx' } }
    }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_PRIVATE_FIELD'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: { evidence: { sessionKey: 'template:17' } }
    }),
    (error) => error.code === 'STATEMENT_PUBLIC_DTO_PRIVATE_FIELD'
  );
  assert.throws(
    () => createStatementPublicInteractionDto({
      token: token(),
      prompt: { message: 'x'.repeat(STATEMENT_RESOURCE_CONTRACT.publicInteractionMaxBytes) }
    }),
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

test('E09-P0 contract/footprint未接入Main live IPC或background runtime', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const backgroundIndex = fs.readFileSync(
    path.join(ROOT, 'src', 'main-process', 'background-execution', 'index.js'),
    'utf8'
  );
  assert.equal(mainSource.includes("require('./main-process/statement-worker"), false);
  assert.equal(backgroundIndex.includes('statement-worker'), false);
});
