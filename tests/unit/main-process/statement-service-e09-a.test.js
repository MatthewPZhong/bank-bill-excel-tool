'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../src/main-process/background-execution/execution-policy-registry');
const {
  createResourceGovernor
} = require('../../../src/main-process/background-execution/resource-governor');
const {
  createExecutionSupervisor
} = require('../../../src/main-process/background-execution/supervisor');
const {
  createWorkerThreadAdapter
} = require('../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const {
  createStatementImportResult,
  STATEMENT_RESULT_VALIDATORS
} = require('../../../src/main-process/statement-worker/contracts');
const {
  createStatementImportRequest,
  createStatementTemplateCatalogEntry,
  createStatementTemplateEvidence
} = require('../../../src/main-process/statement-worker/import-contracts');
const {
  buildStatementImportCandidate,
  createStatementServiceState
} = require('../../../src/main-process/statement-worker/session-state');
const {
  createStatementWorkerEntryRegistry
} = require('../../../src/main-process/statement-worker/runtime-bindings');
const {
  sourceSnapshotFromStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  resolveStatementSourceIdentity
} = require('../../../src/main-process/statement-worker/source-identity');

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
const STATIC_KEY_FIXTURE = path.join(path.dirname(POLICY_FIXTURE), 'static-key-manifest.v3.2.x.json');

function createPolicyRegistry(options = {}) {
  const fixture = JSON.parse(fs.readFileSync(POLICY_FIXTURE, 'utf8'));
  const policies = Object.entries(fixture.actions)
    .filter(([actionKey]) => actionKey.startsWith('statement:'))
    .map(([, policy]) => structuredClone(policy));
  if (typeof options.policyMutation === 'function') {
    policies.forEach((policy) => options.policyMutation(policy));
  }
  const entryRegistry = createStaticRegistry(createStatementWorkerEntryRegistry({
    workerData: options.workerData
  })).freeze();
  const validatorBindings = {};
  for (const policy of policies) {
    validatorBindings[policy.result.validatorKey] = STATEMENT_RESULT_VALIDATORS[policy.actionKey];
    for (const validatorKey of [
      policy.artifacts.technicalValidatorKey,
      policy.artifacts.businessValidatorKey
    ].filter(Boolean)) {
      validatorBindings[validatorKey] = () => true;
    }
  }
  const validatorRegistry = createStaticRegistry(validatorBindings).freeze();
  return createExecutionPolicyRegistry({
    policies,
    entryRegistry,
    validatorRegistry,
    staticKeys: JSON.parse(fs.readFileSync(STATIC_KEY_FIXTURE, 'utf8')),
    generatedAt: '2026-08-28T00:00:00.000Z',
    baselineRef: 'e09-a-statement-service'
  }).freeze();
}

function createHarness(options = {}) {
  const harnessOptions = options;
  const policyRegistry = createPolicyRegistry({
    ...options,
    workerData: {
      ...(options.workerData || {}),
      ...(options.sourceRoot ? { statementSourceRoot: options.sourceRoot } : {})
    }
  });
  const baseGovernor = createResourceGovernor({
    budgets: {
      cpuSlots: 4,
      workerThreadSlots: 4,
      utilityProcessSlots: 1,
      ioHeavySlots: 4,
      memoryBytes: 1024 * 1024 * 1024
    }
  });
  const resourceGovernor = typeof options.wrapGovernor === 'function'
    ? options.wrapGovernor(baseGovernor)
    : baseGovernor;
  const trace = [];
  const diagnostics = [];
  const workerHandles = [];
  const nativeAdapter = createWorkerThreadAdapter();
  const workerThreadAdapter = Object.freeze({
    kind: 'worker-thread',
    start(startOptions) {
      const handle = nativeAdapter.start({
        ...startOptions,
        onMessage(message) {
          trace.push(structuredClone(message));
          startOptions.onMessage(message);
        }
      });
      workerHandles.push(handle);
      const send = handle.send.bind(handle);
      return Object.freeze({
        ...handle,
        send(message, transferList) {
          trace.push(structuredClone(message));
          if (typeof harnessOptions.onHostSend === 'function' &&
              harnessOptions.onHostSend(message, () => send(message, transferList)) === true) {
            return undefined;
          }
          return send(message, transferList);
        }
      });
    }
  });
  return {
    policyRegistry,
    resourceGovernor,
    baseGovernor,
    diagnostics,
    trace,
    workerHandles,
    supervisor: createExecutionSupervisor({
      policyRegistry,
      resourceGovernor,
      workerThreadAdapter,
      diagnostics: (event) => diagnostics.push(event),
      initTimeoutMs: 5000,
      executionTimeoutMs: 10000
    })
  };
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function writeStatement(filePath, rows) {
  writeWorkbook(filePath, [
    ['日期', '贷', '借', '币种', '账号'],
    ...rows
  ]);
}

function writeWorkbook(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function source(filePath, templateRef = 'direct', resourceId = path.basename(filePath)) {
  return {
    resourceId,
    snapshot: sourceSnapshotFromStat(fs.statSync(filePath, { bigint: true })),
    templateRef
  };
}

async function privateSource(filePath, templateRef = 'direct') {
  return resolveStatementSourceIdentity(
    source(filePath, templateRef),
    filePath
  );
}

function templateSnapshot(overrides = {}) {
  return {
    templateId: 'template-direct',
    templateName: '测试银行-Direct',
    expectedSourceHeaders: ['日期', '贷', '借', '币种', '账号'],
    orderedTargetFields: ['Bill Date', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
    mappingByField: {
      'Bill Date': '日期',
      'Credit Amount': '贷',
      'Debit Amount': '借',
      Currency: '币种',
      MerchantId: '账号'
    },
    accountMappingByBankId: {},
    currencyMappings: [],
    amountMappingRules: {
      nameSourceField: '',
      accountSourceField: '',
      signedAmountSourceField: ''
    },
    amountSplitByField: null,
    billSplitMerge: null,
    dateParseOrder: 'auto',
    ...overrides
  };
}

function templateEvidence(overrides = {}) {
  return createStatementTemplateEvidence(templateSnapshot(overrides));
}

function sessionOwner(overrides = {}) {
  return {
    sessionKey: 'template-direct',
    templateId: 'template-direct',
    templateName: '测试银行-Direct',
    ...overrides
  };
}

function templateCatalogEntry(templateRef, evidence) {
  return createStatementTemplateCatalogEntry(templateRef, evidence.snapshot);
}

function importPayload(sources, evidence = templateEvidence(), options = {}) {
  const defaultRef = options.templateRef || 'direct';
  const templateCatalog = options.templateCatalog || [
    templateCatalogEntry(defaultRef, evidence)
  ];
  return {
    command: 'import',
    sessionOwner: options.sessionOwner || sessionOwner({
      sessionKey: options.sessionKey || evidence.snapshot.templateId,
      templateId: options.ownerTemplateId || evidence.snapshot.templateId,
      templateName: options.ownerTemplateName || evidence.snapshot.templateName
    }),
    sources: sources.map((item) => ({
      ...item,
      templateRef: item.templateRef || defaultRef
    })),
    templateCatalog
  };
}

function normalizeTestInput(input) {
  if (!input || input.command !== 'import' || !input.templateEvidence) return input;
  return importPayload(input.sources, input.templateEvidence, { sessionKey: input.sessionKey });
}

function executionRequest(input, ordinal, actionKey = 'statement:import') {
  const operationKey = `statement-import-operation-${ordinal}`;
  return {
    actionKey,
    operationKey,
    jobId: `statement-import-job-${ordinal}`,
    production: false,
    input: normalizeTestInput(input),
    context: {
      kind: 'operation',
      value: {
        taskRunId: `statement-task-${ordinal}`,
        taskKey: actionKey,
        moduleId: 'statement',
        parentRunId: `statement-parent-${ordinal}`,
        operationKey
      }
    },
    units: []
  };
}

test('真实 Supervisor/ServiceHost/Worker 连续 import 稳定推进 batch 与 revision', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstPath = path.join(tempDir, 'first.xlsx');
  const secondPath = path.join(tempDir, 'second.xlsx');
  writeStatement(firstPath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  writeStatement(secondPath, [
    ['2026-08-02', '', 3, 'EUR', 'M002'],
    ['2026-08-03', 4, '', 'USD', 'M003']
  ]);
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const evidence = templateEvidence();

  const first = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(firstPath)],
    templateEvidence: evidence
  }, 1));
  assert.equal(first.outcome, 'completed');
  assert.equal(first.result.status, 'imported');
  assert.equal(first.result.summary.serviceGeneration, 1);
  assert.equal(first.result.summary.sessionRevision, 1);
  assert.equal(first.result.summary.batchCount, 1);
  assert.equal(first.result.summary.fileCount, 1);
  assert.equal(first.result.summary.rowCount, 1);
  assert.equal(first.result.session.entryCount, 1);
  assert.equal(first.result.session.currentBatchId, 'statement-batch-1-1');

  const second = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(secondPath)],
    templateEvidence: evidence
  }, 2));
  assert.equal(second.outcome, 'completed');
  assert.equal(second.result.summary.sessionRevision, 2);
  assert.equal(second.result.summary.batchCount, 2);
  assert.equal(second.result.summary.fileCount, 2);
  assert.equal(second.result.summary.rowCount, 3);
  assert.equal(second.result.session.entryCount, 2);
  assert.deepEqual(second.result.session.importedEntryIds, ['statement-entry-1-2']);
  assert.equal(second.result.session.currentBatchId, 'statement-batch-1-2');

  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 3));
  assert.equal(status.outcome, 'completed');
  assert.equal(status.result.status, 'status');
  assert.deepEqual(status.result.summary, second.result.summary);

  const operations = harness.trace.map((message) => message.operation);
  assert.ok(operations.includes('resource:request'));
  assert.ok(operations.includes('resource:grant'));
  assert.ok(operations.includes('resource:adopted'));
  assert.ok(operations.includes('resource:adopt-ack'));
});

test('import result以entryCount保持跨1024文件session有界且不伪造文件数上限', () => {
  const result = createStatementImportResult({
    status: 'imported',
    summary: {
      serviceGeneration: 1,
      sessionRevision: 2,
      sessionCount: 1,
      batchCount: 2,
      fileCount: 1025,
      rowCount: 1025,
      pendingInteractionCount: 0,
      pendingInteractions: [],
      activePhase: 'idle'
    },
    session: {
      sessionKey: 'template-direct',
      currentBatchId: 'statement-batch-1-2',
      entryCount: 1025,
      importedEntryIds: ['statement-entry-1-1025']
    }
  });
  assert.equal(result.session.entryCount, 1025);
  assert.deepEqual(result.session.importedEntryIds, ['statement-entry-1-1025']);
  assert.equal(Object.hasOwn(result.session, 'entryIds'), false);
});

test('import contract冻结session owner、template catalog/source ref并拒绝篡改与未知/重复ref', () => {
  const evidence = templateEvidence();
  const snapshot = { sizeBytes: 1, mtimeMs: 2, ctimeMs: 3, ino: '4' };
  const input = importPayload([{ resourceId: 'source-1', snapshot, templateRef: 'direct' }], evidence);
  assert.equal(createStatementImportRequest(input).sources[0].resourceId, 'source-1');
  assert.equal(createStatementImportRequest(input).sessionOwner.sessionKey, 'template-direct');

  const tampered = structuredClone(input);
  tampered.templateCatalog[0].snapshot.templateName = '被篡改模板';
  assert.throws(
    () => createStatementImportRequest(tampered),
    (error) => error.code === 'STATEMENT_IMPORT_TEMPLATE_EVIDENCE_INVALID'
  );

  assert.throws(
    () => createStatementImportRequest({
      ...input,
      sources: [
        { resourceId: 'source-1', snapshot, templateRef: 'direct' },
        { resourceId: 'source-1', snapshot, templateRef: 'direct' }
      ]
    }),
    (error) => error.code === 'STATEMENT_IMPORT_SOURCE_DUPLICATE'
  );

  assert.throws(
    () => createStatementImportRequest({
      ...input,
      sources: [{
        resourceId: 'source-1',
        snapshot,
        templateRef: 'direct',
        path: '/private/source.xlsx'
      }]
    }),
    (error) => error.code === 'STATEMENT_IMPORT_KEYS_INVALID'
  );

  const privateTemplate = structuredClone(evidence.snapshot);
  privateTemplate.mappingByField.private = { detailRows: [['private']] };
  assert.throws(
    () => createStatementTemplateEvidence(privateTemplate),
    (error) => error.code === 'STATEMENT_IMPORT_PRIVATE_STATE_FORBIDDEN'
  );

  assert.throws(
    () => createStatementImportRequest({
      ...input,
      sources: [{ resourceId: 'source-1', snapshot, templateRef: 'missing' }]
    }),
    (error) => error.code === 'STATEMENT_IMPORT_TEMPLATE_REF_UNKNOWN'
  );

  assert.throws(
    () => createStatementImportRequest({
      ...input,
      templateCatalog: [input.templateCatalog[0], input.templateCatalog[0]]
    }),
    (error) => error.code === 'STATEMENT_IMPORT_TEMPLATE_REF_DUPLICATE'
  );

  const reused = createStatementImportRequest({
    ...input,
    sources: [
      { resourceId: 'source-1', snapshot, templateRef: 'direct' },
      { resourceId: 'source-2', snapshot, templateRef: 'direct' }
    ]
  });
  assert.equal(reused.templateCatalog.length, 1);
  assert.deepEqual(reused.sources.map((item) => item.templateRef), ['direct', 'direct']);

  assert.throws(
    () => createStatementImportRequest({
      ...input,
      templateCatalog: [
        input.templateCatalog[0],
        { ...input.templateCatalog[0], templateRef: 'same-template-second-ref' }
      ]
    }),
    (error) => error.code === 'STATEMENT_IMPORT_TEMPLATE_ID_DUPLICATE'
  );
});

test('parent session同batch按source templateRef使用父子配置并保持来源顺序与golden', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-parent-child-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const parentPath = path.join(tempDir, 'parent.xlsx');
  const childPath = path.join(tempDir, 'child.xlsx');
  writeWorkbook(parentPath, [
    ['父日期', '父贷', '父币', '父账号'],
    ['2026-08-10', '12.5', '美元', ' P 001 ']
  ]);
  writeWorkbook(childPath, [
    ['子日期', '子金额', '子币', '子账号'],
    ['2026-08-11', '-7', '港币', ' C 001 ']
  ]);
  const parentEvidence = templateEvidence({
    templateId: 'template-parent',
    templateName: '测试银行-父模板',
    expectedSourceHeaders: ['父日期', '父贷', '父币', '父账号'],
    mappingByField: {
      'Bill Date': '父日期',
      'Credit Amount': '父贷',
      'Debit Amount': '',
      Currency: '父币',
      MerchantId: '父账号'
    },
    currencyMappings: [{ aliases: ['美元'], englishCode: 'USD' }]
  });
  const childEvidence = templateEvidence({
    templateId: 'template-child',
    templateName: '测试银行-子模板',
    expectedSourceHeaders: ['子日期', '子金额', '子币', '子账号'],
    mappingByField: {
      'Bill Date': '子日期',
      Currency: '子币',
      MerchantId: '子账号'
    },
    currencyMappings: [{ aliases: ['港币'], englishCode: 'HKD' }],
    amountMappingRules: {
      nameSourceField: '',
      accountSourceField: '',
      signedAmountSourceField: '子金额'
    }
  });
  const state = createStatementServiceState(3);
  const candidate = await buildStatementImportCandidate(state, importPayload([
    await privateSource(parentPath, 'parent-ref'),
    await privateSource(childPath, 'child-ref')
  ], parentEvidence, {
    sessionOwner: sessionOwner({
      sessionKey: 'parent-session-key',
      templateId: 'template-parent',
      templateName: '测试银行-父模板'
    }),
    templateCatalog: [
      templateCatalogEntry('parent-ref', parentEvidence),
      templateCatalogEntry('child-ref', childEvidence)
    ]
  }));

  const session = candidate.state.sessions.get('parent-session-key');
  assert.equal(candidate.result.sessionKey, 'parent-session-key');
  assert.equal(session.templateId, 'template-parent');
  assert.deepEqual(session.fileEntries.map((entry) => entry.templateRef), [
    'parent-ref',
    'child-ref'
  ]);
  assert.deepEqual(session.fileEntries.map((entry) => entry.matchedTemplateId), [
    'template-parent',
    'template-child'
  ]);
  assert.deepEqual(session.batches[0].entryIds, session.fileEntries.map((entry) => entry.id));
  assert.deepEqual(session.fileEntries[0].detailRows.slice(), [
    ['Bill Date', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
    ['2026-08-10', '12.5', '', 'USD', 'P001']
  ]);
  assert.deepEqual(session.fileEntries[1].detailRows.slice(), [
    ['Bill Date', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
    ['2026-08-11', '', '7', 'HKD', 'C001']
  ]);
  assert.deepEqual(
    session.templateEvidenceByDigest.get(parentEvidence.digest),
    parentEvidence.snapshot
  );
  assert.deepEqual(
    session.templateEvidenceByDigest.get(childEvidence.digest),
    childEvidence.snapshot
  );
});

test('__FILENAME_MAPPING__ owner按source ref而非catalog顺序映射并保留matchedTemplateId', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-filename-map-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const alphaPath = path.join(tempDir, 'alpha.xlsx');
  const betaPath = path.join(tempDir, 'beta.xlsx');
  writeWorkbook(alphaPath, [
    ['A日期', 'A贷', 'A币', 'A账号'],
    ['2026-08-12', '88', '欧元', 'A 001']
  ]);
  writeWorkbook(betaPath, [
    ['B日期', 'B金额', 'B币', 'B账号'],
    ['2026-08-13', '-9', '日元', 'B 001']
  ]);
  const alphaEvidence = templateEvidence({
    templateId: 'template-alpha',
    templateName: '文件名模板-A',
    expectedSourceHeaders: ['A日期', 'A贷', 'A币', 'A账号'],
    mappingByField: {
      'Bill Date': 'A日期',
      'Credit Amount': 'A贷',
      'Debit Amount': '',
      Currency: 'A币',
      MerchantId: 'A账号'
    },
    currencyMappings: [{ aliases: ['欧元'], englishCode: 'EUR' }]
  });
  const betaEvidence = templateEvidence({
    templateId: 'template-beta',
    templateName: '文件名模板-B',
    expectedSourceHeaders: ['B日期', 'B金额', 'B币', 'B账号'],
    mappingByField: {
      'Bill Date': 'B日期',
      Currency: 'B币',
      MerchantId: 'B账号'
    },
    currencyMappings: [{ aliases: ['日元'], englishCode: 'JPY' }],
    amountMappingRules: {
      nameSourceField: '',
      accountSourceField: '',
      signedAmountSourceField: 'B金额'
    }
  });
  const candidate = await buildStatementImportCandidate(
    createStatementServiceState(4),
    importPayload([
      await privateSource(betaPath, 'beta-ref'),
      await privateSource(alphaPath, 'alpha-ref')
    ], alphaEvidence, {
      sessionOwner: sessionOwner({
        sessionKey: '__FILENAME_MAPPING__',
        templateId: '__FILENAME_MAPPING__',
        templateName: '按文件名映射模板'
      }),
      templateCatalog: [
        templateCatalogEntry('alpha-ref', alphaEvidence),
        templateCatalogEntry('beta-ref', betaEvidence)
      ]
    })
  );

  const session = candidate.state.sessions.get('__FILENAME_MAPPING__');
  assert.deepEqual(session.fileEntries.map((entry) => entry.templateRef), [
    'beta-ref',
    'alpha-ref'
  ]);
  assert.deepEqual(session.fileEntries.map((entry) => entry.matchedTemplateId), [
    'template-beta',
    'template-alpha'
  ]);
  assert.deepEqual(session.fileEntries[0].detailRows.slice(1), [
    ['2026-08-13', '', '9', 'JPY', 'B001']
  ]);
  assert.deepEqual(session.fileEntries[1].detailRows.slice(1), [
    ['2026-08-12', '88', '', 'EUR', 'A001']
  ]);
});

test('persistent reservation grant 与 adopt-ack 前 candidate 不产生可见状态', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-adopt-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'candidate.xlsx');
  writeStatement(inputPath, [['2026-08-01', 12, '', 'USD', 'M001']]);
  let releaseGrant = null;
  let releaseAck = null;
  const harness = createHarness({
    sourceRoot: tempDir,
    onHostSend(message, dispatch) {
      if (message.operation === 'resource:grant' && !releaseGrant) {
        releaseGrant = dispatch;
        return true;
      }
      if (message.operation === 'resource:adopt-ack' && !releaseAck) {
        releaseAck = dispatch;
        return true;
      }
      return false;
    }
  });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  let settled = false;
  const execution = harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(inputPath)],
    templateEvidence: templateEvidence()
  }, 'atomic')).then((result) => {
    settled = true;
    return result;
  });

  await waitFor(
    () => releaseGrant !== null || settled,
    `resource grant; trace=${JSON.stringify(harness.trace.map((message) => message.operation))}`
  );
  if (settled) await execution;
  assert.equal(settled, false);
  assert.equal(harness.trace.some((message) => message.operation === 'job:done'), false);
  releaseGrant();
  await waitFor(() => releaseAck !== null, 'resource adopt ack');
  assert.equal(settled, false);
  assert.equal(harness.trace.some((message) => message.operation === 'job:done'), false);
  releaseAck();
  const result = await execution;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.result.summary.sessionRevision, 1);
});

test('reservation reject 保留旧 session/revision 且 candidate 不半采用', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-reject-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstPath = path.join(tempDir, 'first.xlsx');
  const rejectedPath = path.join(tempDir, 'rejected.xlsx');
  writeStatement(firstPath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  writeStatement(rejectedPath, [['2026-08-02', '', 5, 'EUR', 'M002']]);
  let persistentCalls = 0;
  const harness = createHarness({
    sourceRoot: tempDir,
    wrapGovernor(governor) {
      return Object.freeze({
        ...governor,
        acquirePersistentReservation(request) {
          persistentCalls += 1;
          if (persistentCalls === 2) {
            const error = new Error('injected reservation rejection');
            error.code = 'RESOURCE_BUDGET_UNAVAILABLE';
            return Promise.reject(error);
          }
          return governor.acquirePersistentReservation(request);
        }
      });
    }
  });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const evidence = templateEvidence();
  const first = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(firstPath)],
    templateEvidence: evidence
  }, 'reject-1'));
  assert.equal(first.result.summary.sessionRevision, 1);

  const rejected = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(rejectedPath)],
    templateEvidence: evidence
  }, 'reject-2'));
  assert.equal(rejected.outcome, 'failed');
  assert.equal(rejected.error.code, 'STATEMENT_RESERVATION_REJECTED');

  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 'reject-status'));
  assert.equal(status.result.summary.sessionRevision, 1);
  assert.equal(status.result.summary.fileCount, 1);
  assert.equal(status.result.summary.rowCount, 1);
});

test('source candidate evidence 失败保留旧 session/revision', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-source-fail-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstPath = path.join(tempDir, 'first.xlsx');
  const changedPath = path.join(tempDir, 'changed.xlsx');
  writeStatement(firstPath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  writeStatement(changedPath, [['2026-08-02', 2, '', 'EUR', 'M002']]);
  const staleSource = source(changedPath);
  writeStatement(changedPath, [['2026-08-02', 200, '', 'EUR', 'M002']]);
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const evidence = templateEvidence();
  await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(firstPath)],
    templateEvidence: evidence
  }, 'source-fail-1'));
  const failed = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [staleSource],
    templateEvidence: evidence
  }, 'source-fail-2'));
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error.code, 'BANK_STATEMENT_SOURCE_CHANGED_DURING_IMPORT');
  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 'source-fail-status'));
  assert.equal(status.result.summary.sessionRevision, 1);
  assert.equal(status.result.summary.fileCount, 1);
  assert.equal(status.result.summary.rowCount, 1);
});

test('canonical source alias 允许 identity streaming read 但在 candidate mutation/resource request/adopt 前 fail closed 并保留旧 revision', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-canonical-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'a.xlsx');
  writeStatement(inputPath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const evidence = templateEvidence();
  const sourceEvidence = source(inputPath);
  const imported = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [sourceEvidence],
    templateEvidence: evidence
  }, 'canonical-initial'));
  assert.equal(imported.outcome, 'completed');
  assert.equal(imported.result.summary.sessionRevision, 1);

  for (const [ordinal, alias] of ['./a.xlsx', 'sub/../a.xlsx'].entries()) {
    const jobId = `statement-import-job-canonical-alias-${ordinal}`;
    const failed = await harness.supervisor.execute(executionRequest({
      command: 'import',
      sessionKey: 'template-direct',
      sources: [
        sourceEvidence,
        { resourceId: alias, snapshot: sourceEvidence.snapshot }
      ],
      templateEvidence: evidence
    }, `canonical-alias-${ordinal}`));
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.error.code, 'STATEMENT_SOURCE_CANONICAL_DUPLICATE');
    assert.equal(harness.trace.some((message) =>
      message.jobRef && message.jobRef.jobId === jobId &&
      message.operation === 'resource:request'), false);
    const status = await harness.supervisor.execute(executionRequest(
      { command: 'status' },
      `canonical-status-${ordinal}`
    ));
    assert.equal(status.result.summary.serviceGeneration, 1);
    assert.equal(status.result.summary.sessionRevision, 1);
    assert.equal(status.result.summary.fileCount, 1);
    assert.equal(status.result.summary.rowCount, 1);
  }
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-fatal'), false);
});

test('source identity对batch/跨session别名与内容重复fail closed且不误拒独立来源', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-source-identity-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const originalPath = path.join(tempDir, 'source.xlsx');
  const hardlinkPath = path.join(tempDir, 'hardlink.xlsx');
  const symlinkPath = path.join(tempDir, 'symlink.xlsx');
  const aliasDir = path.join(tempDir, 'directory-alias');
  const contentCopyPath = path.join(tempDir, 'content-copy.xlsx');
  const sameNameDir = path.join(tempDir, 'same-name');
  const sameNamePath = path.join(sameNameDir, 'source.xlsx');
  const caseNameDir = path.join(tempDir, 'case-name');
  const caseNamePath = path.join(caseNameDir, 'SOURCE.XLSX');
  const legitimatePath = path.join(tempDir, 'legitimate.xlsx');
  writeStatement(originalPath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  fs.linkSync(originalPath, hardlinkPath);
  fs.symlinkSync('source.xlsx', symlinkPath, 'file');
  fs.symlinkSync('.', aliasDir, 'dir');
  fs.copyFileSync(originalPath, contentCopyPath);
  fs.mkdirSync(sameNameDir);
  fs.mkdirSync(caseNameDir);
  writeStatement(sameNamePath, [['2026-08-02', 20, '', 'EUR', 'M002']]);
  writeStatement(caseNamePath, [['2026-08-03', 30, '', 'JPY', 'M003']]);
  writeStatement(legitimatePath, [['2026-08-04', 40, '', 'HKD', 'M004']]);
  const identityProbe = (await privateSource(originalPath)).sourceIdentity;
  assert.deepEqual(Object.keys(identityProbe), [
    'version',
    'canonicalPathSha256',
    'legacyBasenameSha256',
    'deviceId',
    'inode',
    'fileIdReliable',
    'sizeBytes',
    'contentSha256'
  ]);
  assert.match(identityProbe.canonicalPathSha256, /^[0-9a-f]{64}$/);
  assert.match(identityProbe.legacyBasenameSha256, /^[0-9a-f]{64}$/);
  assert.match(identityProbe.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(identityProbe).includes(tempDir), false);
  assert.equal(JSON.stringify(identityProbe).includes('source.xlsx'), false);
  assert.equal(JSON.stringify(identityProbe).includes('M001'), false);
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const evidence = templateEvidence();
  const resourceId = (filePath) => path.relative(tempDir, filePath);

  async function assertRejected(input, ordinal, expectedCode, expectedRevision, expectedFileCount) {
    const request = executionRequest(input, ordinal);
    const failed = await harness.supervisor.execute(request);
    assert.equal(failed.outcome, 'failed', ordinal);
    assert.equal(failed.error.code, expectedCode, ordinal);
    const jobTrace = harness.trace.filter((message) =>
      message.jobId === request.jobId ||
      (message.jobRef && message.jobRef.jobId === request.jobId));
    assert.equal(jobTrace.some((message) => message.operation === 'resource:request'), false, ordinal);
    assert.equal(jobTrace.some((message) => message.operation === 'resource:adopted'), false, ordinal);
    const status = await harness.supervisor.execute(executionRequest(
      { command: 'status' },
      `${ordinal}-status`
    ));
    assert.equal(status.result.summary.serviceGeneration, 1, ordinal);
    assert.equal(status.result.summary.sessionRevision, expectedRevision, ordinal);
    assert.equal(status.result.summary.fileCount, expectedFileCount, ordinal);
    return failed;
  }

  await assertRejected(importPayload([
    source(originalPath, 'direct', resourceId(originalPath)),
    source(hardlinkPath, 'direct', resourceId(hardlinkPath))
  ], evidence), 'batch-hardlink', 'STATEMENT_SOURCE_FILE_ID_DUPLICATE', 0, 0);

  const imported = await harness.supervisor.execute(executionRequest(importPayload([
    source(originalPath, 'direct', resourceId(originalPath))
  ], evidence), 'identity-initial'));
  assert.equal(imported.outcome, 'completed');
  assert.equal(imported.result.summary.sessionRevision, 1);
  assert.deepEqual(imported.result.session.importedEntryIds, ['statement-entry-1-1']);
  assert.equal(imported.result.session.currentBatchId, 'statement-batch-1-1');

  for (const [ordinal, filePath, expectedCode] of [
    ['file-symlink', symlinkPath, 'STATEMENT_SOURCE_CANONICAL_DUPLICATE'],
    ['directory-symlink', path.join(aliasDir, 'source.xlsx'), 'STATEMENT_SOURCE_CANONICAL_DUPLICATE'],
    ['same-content-copy', contentCopyPath, 'STATEMENT_SOURCE_CONTENT_DUPLICATE'],
    ['same-basename', sameNamePath, 'STATEMENT_SOURCE_NAME_DUPLICATE'],
    ['case-variant', caseNamePath, 'STATEMENT_SOURCE_NAME_DUPLICATE']
  ]) {
    await assertRejected(importPayload([
      source(filePath, 'direct', resourceId(filePath))
    ], evidence), ordinal, expectedCode, 1, 1);
  }

  await assertRejected(importPayload([
    source(originalPath, 'direct', resourceId(originalPath))
  ], evidence, {
    sessionOwner: sessionOwner({
      sessionKey: 'another-session',
      templateId: 'another-owner',
      templateName: '另一个父会话'
    })
  }), 'cross-session', 'STATEMENT_SOURCE_CANONICAL_DUPLICATE', 1, 1);

  writeStatement(originalPath, [['2026-08-05', 500, '', 'CNY', 'M005']]);
  await assertRejected(importPayload([
    source(originalPath, 'direct', resourceId(originalPath))
  ], evidence), 'source-replacement', 'STATEMENT_SOURCE_CANONICAL_DUPLICATE', 1, 1);

  const legitimate = await harness.supervisor.execute(executionRequest(importPayload([
    source(legitimatePath, 'direct', resourceId(legitimatePath))
  ], evidence), 'legitimate-distinct'));
  assert.equal(legitimate.outcome, 'completed');
  assert.equal(legitimate.result.summary.sessionRevision, 2);
  assert.equal(legitimate.result.summary.fileCount, 2);
  assert.equal(legitimate.result.summary.rowCount, 2);
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-fatal'), false);
});

test('四个future action在解析payload与申请resource前返回bounded unsupported且不改变已有session', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-wrong-action-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const importedPath = path.join(tempDir, 'imported.xlsx');
  const unreadPath = path.join(tempDir, 'must-not-read.xlsx');
  writeStatement(importedPath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  writeStatement(unreadPath, [['2026-08-02', 20, '', 'EUR', 'M002']]);
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const evidence = templateEvidence();
  const imported = await harness.supervisor.execute(executionRequest(importPayload([
    source(importedPath)
  ], evidence), 'wrong-action-initial'));
  assert.equal(imported.outcome, 'completed');
  assert.equal(imported.result.summary.sessionRevision, 1);

  const unreadSource = source(unreadPath);
  fs.unlinkSync(unreadPath);
  const wrongActions = [
    ['statement:generate-current', importPayload([unreadSource], evidence)],
    ['statement:generate-all', { command: 'status' }],
    ['statement:resolve-big-account', { command: 'status', extra: 'must-not-parse' }],
    ['statement:resolve-manual-balance', {
      ...importPayload([unreadSource], evidence),
      extra: { rows: [['must-not-parse']] }
    }]
  ];
  for (const [index, [actionKey, input]] of wrongActions.entries()) {
    const ordinal = `wrong-action-${index}`;
    const request = executionRequest(input, ordinal, actionKey);
    const failed = await harness.supervisor.execute(request);
    assert.equal(failed.outcome, 'failed', actionKey);
    assert.equal(failed.error.code, 'STATEMENT_ACTION_UNSUPPORTED', actionKey);
    assert.ok(Buffer.byteLength(JSON.stringify(failed.error), 'utf8') < 4096, actionKey);
    const jobTrace = harness.trace.filter((message) =>
      message.jobId === request.jobId ||
      (message.jobRef && message.jobRef.jobId === request.jobId));
    assert.deepEqual(jobTrace.map((message) => message.operation), [
      'job:start',
      'job:error'
    ], actionKey);
    assert.equal(jobTrace.some((message) => message.operation === 'resource:request'), false, actionKey);
    assert.equal(jobTrace.some((message) => message.operation === 'resource:adopted'), false, actionKey);
  }

  const status = await harness.supervisor.execute(executionRequest(
    { command: 'status' },
    'wrong-action-status'
  ));
  assert.equal(status.outcome, 'completed');
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 1);
  assert.equal(status.result.summary.sessionCount, 1);
  assert.equal(status.result.summary.fileCount, 1);
  assert.equal(status.result.summary.rowCount, 1);
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-fatal'), false);
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-job-callback-error'), false);
});

test('E09-B 大账号交互上下文保持 blocked，不创建 token/DTO/本地 Map', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-blocked-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'blocked.xlsx');
  writeStatement(inputPath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  const snapshot = structuredClone(templateEvidence().snapshot);
  snapshot.mappingByField.MerchantId = '__FIXED__:__MULTI_BIG_ACCOUNT__';
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const blocked = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(inputPath)],
    templateEvidence: createStatementTemplateEvidence(snapshot)
  }, 'blocked'));
  assert.equal(blocked.outcome, 'failed');
  assert.equal(blocked.error.code, 'STATEMENT_BIG_ACCOUNT_INTERACTION_BLOCKED');
  assert.equal(harness.trace.some((message) => message.operation === 'resource:request'), false);
  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 'blocked-status'));
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.equal(status.result.summary.pendingInteractionCount, 0);
  assert.deepEqual(status.result.summary.pendingInteractions, []);
});

test('新 import candidate 清空旧 revision artifact qualification 与 future token seam', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-invalidate-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'candidate.xlsx');
  writeStatement(inputPath, [['2026-08-01', 5, '', 'USD', 'M001']]);
  const state = createStatementServiceState(7);
  state.artifactQualifications.set('revision-0/artifact', { qualified: true });
  state.futureTokenContext = { revision: 0, privateValue: 'blocked-seam' };
  const evidence = templateEvidence();
  const candidate = await buildStatementImportCandidate(
    state,
    importPayload([await privateSource(inputPath)], evidence)
  );
  assert.equal(candidate.state.sessionRevision, 1);
  assert.equal(candidate.state.artifactQualifications.size, 0);
  assert.equal(candidate.state.futureTokenContext, null);
  assert.equal(state.artifactQualifications.size, 1);
  assert.deepEqual(state.futureTokenContext, { revision: 0, privateValue: 'blocked-seam' });
});

test('adoption preparation failure 在 resource request 前丢弃 candidate 并保留旧 session', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-adopt-fail-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstPath = path.join(tempDir, 'first.xlsx');
  const failedPath = path.join(tempDir, 'failed.xlsx');
  writeStatement(firstPath, [['2026-08-01', 1, '', 'USD', 'M001']]);
  writeStatement(failedPath, [['2026-08-02', 2, '', 'EUR', 'M002']]);
  const harness = createHarness({
    sourceRoot: tempDir,
    workerData: { statementFaultInjection: { failBeforeAdoptOrdinal: 2 } }
  });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const evidence = templateEvidence();
  await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(firstPath)],
    templateEvidence: evidence
  }, 'adopt-fail-1'));
  const failed = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(failedPath)],
    templateEvidence: evidence
  }, 'adopt-fail-2'));
  assert.equal(failed.outcome, 'failed', JSON.stringify({
    trace: harness.trace.map((message) => message.operation),
    diagnostics: harness.diagnostics
  }));
  assert.equal(failed.error.code, 'STATEMENT_ADOPTION_FAILED');
  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 'adopt-fail-status'));
  assert.equal(status.result.summary.sessionRevision, 1);
  assert.equal(status.result.summary.fileCount, 1);
  assert.equal(harness.baseGovernor.snapshot().activeLeases.filter(
    (lease) => lease.kind === 'persistent'
  ).length, 1);
});

test('grant 后 adoption timeout reject 保留旧 session 且同一 Service 可继续 status', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-adopt-timeout-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstPath = path.join(tempDir, 'first.xlsx');
  const timeoutPath = path.join(tempDir, 'timeout.xlsx');
  writeStatement(firstPath, [['2026-08-01', 1, '', 'USD', 'M001']]);
  writeStatement(timeoutPath, [['2026-08-02', 2, '', 'EUR', 'M002']]);
  const harness = createHarness({
    sourceRoot: tempDir,
    workerData: { statementFaultInjection: { withholdAdoptOrdinal: 2 } },
    policyMutation(policy) {
      policy.service.resourceControl.adoptionTimeoutMs = 20;
    }
  });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const evidence = templateEvidence();
  await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(firstPath)],
    templateEvidence: evidence
  }, 'adopt-timeout-1'));
  const failed = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(timeoutPath)],
    templateEvidence: evidence
  }, 'adopt-timeout-2'));
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error.code, 'STATEMENT_ADOPTION_TIMEOUT');
  const secondJobTrace = harness.trace.filter((message) =>
    message.jobRef && message.jobRef.jobId === 'statement-import-job-adopt-timeout-2');
  assert.equal(secondJobTrace.some((message) => message.operation === 'resource:grant'), true);
  assert.equal(secondJobTrace.some((message) => message.operation === 'resource:adopted'), false);
  assert.equal(secondJobTrace.some((message) =>
    message.operation === 'resource:revoke' &&
      message.payload.reasonCode === 'adoption-timeout'), true);
  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 'adopt-timeout-status'));
  assert.equal(status.result.summary.serviceGeneration, 1);
  assert.equal(status.result.summary.sessionRevision, 1);
  assert.equal(status.result.summary.fileCount, 1);
});

test('adoption 前取消丢弃 candidate 并保持空 session', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-cancel-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'cancel.xlsx');
  writeStatement(inputPath, [['2026-08-01', 9, '', 'USD', 'M001']]);
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const control = harness.supervisor.start(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(inputPath)],
    templateEvidence: templateEvidence()
  }, 'cancel'));
  control.cancel({ reason: 'user-requested' });
  const cancelled = await control.promise;
  assert.equal(cancelled.outcome, 'cancelled');
  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 'cancel-status'));
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.equal(status.result.summary.sessionCount, 0);
});

test('shutdown 对 attached native Worker 桥接取消终态并收口 exact late reject', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-shutdown-reject-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const initialPath = path.join(tempDir, 'initial.xlsx');
  const inputPath = path.join(tempDir, 'cancel.xlsx');
  writeStatement(initialPath, [['2026-07-31', 4, '', 'USD', 'M000']]);
  writeStatement(inputPath, [['2026-08-01', 9, '', 'USD', 'M001']]);
  let persistentCalls = 0;
  const harness = createHarness({
    sourceRoot: tempDir,
    wrapGovernor(governor) {
      return Object.freeze({
        ...governor,
        acquirePersistentReservation(request) {
          persistentCalls += 1;
          if (persistentCalls === 1) return governor.acquirePersistentReservation(request);
          return new Promise((resolve, reject) => {
            const rejectCancelled = () => {
              const error = new Error('injected pending admission cancellation');
              error.code = 'ADMISSION_CANCELLED';
              queueMicrotask(() => reject(error));
            };
            if (request.signal.aborted) rejectCancelled();
            else request.signal.addEventListener('abort', rejectCancelled, { once: true });
          });
        }
      });
    }
  });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const initialRequest = executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(initialPath)],
    templateEvidence: templateEvidence()
  }, 'shutdown-reject-initial');
  const initial = await harness.supervisor.execute(initialRequest);
  assert.equal(initial.outcome, 'completed');
  assert.equal(initial.result.summary.sessionRevision, 1);
  const request = executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(inputPath)],
    templateEvidence: templateEvidence()
  }, 'shutdown-reject');
  const control = harness.supervisor.start(request);
  await waitFor(() => harness.trace.some((message) =>
    message.operation === 'resource:request' &&
    message.jobRef && message.jobRef.jobId === request.jobId), 'pending resource request');

  const report = await harness.supervisor.shutdown({ timeoutMs: 5000 });
  const result = await control.promise;
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(report.cancelledJobs, [request.jobId]);
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.equal(harness.trace.some((message) =>
    message.operation === 'job:cancel' && message.jobId === request.jobId), true);
  assert.equal(harness.trace.some((message) =>
    message.operation === 'job:error' && message.jobId === request.jobId &&
    message.payload.error.code === 'STATEMENT_IMPORT_CANCELLED'), true);
  assert.equal(harness.trace.some((message) =>
    message.operation === 'resource:reject' &&
    message.jobRef && message.jobRef.jobId === request.jobId), true);
  assert.equal(harness.trace.some((message) =>
    message.operation === 'resource:revoke' &&
    message.jobRef && message.jobRef.jobId === initialRequest.jobId), true);
  assert.equal(harness.trace.some((message) =>
    message.operation === 'resource:release' &&
    message.jobRef && message.jobRef.jobId === initialRequest.jobId), true);
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-fatal'), false);
  assert.equal(harness.diagnostics.some((event) =>
    event.type === 'service-generation-closed' && event.reason === 'service-crash'), false);
  assert.equal(harness.baseGovernor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.baseGovernor.snapshot().activeDependencyCount, 0);
});

test('shutdown 取消后 exact late grant 经 revoke/release 完整结算且不 crash generation', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-shutdown-grant-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const initialPath = path.join(tempDir, 'initial.xlsx');
  const inputPath = path.join(tempDir, 'cancel.xlsx');
  writeStatement(initialPath, [['2026-07-31', 4, '', 'USD', 'M000']]);
  writeStatement(inputPath, [['2026-08-01', 9, '', 'USD', 'M001']]);
  let releaseGrant = null;
  let grantOrdinal = 0;
  const harness = createHarness({
    sourceRoot: tempDir,
    onHostSend(message, dispatch) {
      if (message.operation === 'resource:grant') grantOrdinal += 1;
      if (message.operation === 'resource:grant' && grantOrdinal === 2 && !releaseGrant) {
        releaseGrant = dispatch;
        return true;
      }
      if (message.operation === 'job:cancel' && releaseGrant) {
        const dispatchGrant = releaseGrant;
        releaseGrant = null;
        dispatch();
        dispatchGrant();
        return true;
      }
      return false;
    }
  });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const initialRequest = executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(initialPath)],
    templateEvidence: templateEvidence()
  }, 'shutdown-grant-initial');
  const initial = await harness.supervisor.execute(initialRequest);
  assert.equal(initial.outcome, 'completed');
  assert.equal(initial.result.summary.sessionRevision, 1);
  const request = executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(inputPath)],
    templateEvidence: templateEvidence()
  }, 'shutdown-grant');
  const control = harness.supervisor.start(request);
  await waitFor(() => releaseGrant !== null, 'withheld resource grant');

  const report = await harness.supervisor.shutdown({ timeoutMs: 5000 });
  const result = await control.promise;
  const jobTrace = harness.trace.filter((message) =>
    (message.jobRef && message.jobRef.jobId === request.jobId) || message.jobId === request.jobId);
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(report.cancelledJobs, [request.jobId]);
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  for (const operation of ['resource:grant', 'resource:revoke', 'resource:release', 'resource:release-ack']) {
    assert.equal(jobTrace.some((message) => message.operation === operation), true, operation);
  }
  assert.equal(harness.trace.some((message) =>
    message.operation === 'resource:revoke' &&
    message.jobRef && message.jobRef.jobId === initialRequest.jobId), true);
  assert.equal(harness.trace.some((message) =>
    message.operation === 'resource:release' &&
    message.jobRef && message.jobRef.jobId === initialRequest.jobId), true);
  assert.equal(harness.diagnostics.some((event) => event.type === 'service-fatal'), false);
  assert.equal(harness.diagnostics.some((event) =>
    event.type === 'service-generation-closed' && event.reason === 'service-crash'), false);
  assert.equal(harness.baseGovernor.snapshot().activeLeaseCount, 0);
  assert.equal(harness.baseGovernor.snapshot().activeDependencyCount, 0);
});

test('Service crash 丢失内存 session 且新 generation 不扫描已发布文件恢复', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-crash-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'source.xlsx');
  const publishedPath = path.join(tempDir, 'published-history.xlsx');
  writeStatement(inputPath, [['2026-08-01', 7, '', 'USD', 'M001']]);
  writeStatement(publishedPath, [['2026-07-31', 99, '', 'USD', 'OLD']]);
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const imported = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(inputPath)],
    templateEvidence: templateEvidence()
  }, 'crash-import'));
  assert.equal(imported.result.summary.sessionRevision, 1);
  await harness.workerHandles[0].worker.terminate();
  await waitFor(
    () => harness.diagnostics.some((event) => event.type === 'service-fatal'),
    'service crash cleanup'
  );
  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 'crash-status'));
  assert.equal(status.result.summary.serviceGeneration, 2);
  assert.equal(status.result.summary.sessionRevision, 0);
  assert.equal(status.result.summary.sessionCount, 0);
  assert.equal(status.result.summary.fileCount, 0);
  assert.equal(fs.existsSync(publishedPath), true);
});

test('Worker→Main result/status/control 均为 bounded DTO 且不泄露 rows/path/private context', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-a-private-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, 'private-source.xlsx');
  writeStatement(inputPath, [['2026-08-01', 11, '', 'USD', 'M001']]);
  const harness = createHarness({ sourceRoot: tempDir });
  t.after(async () => { await harness.supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }); });
  const imported = await harness.supervisor.execute(executionRequest({
    command: 'import',
    sessionKey: 'template-direct',
    sources: [source(inputPath)],
    templateEvidence: templateEvidence()
  }, 'private'));
  const status = await harness.supervisor.execute(executionRequest({ command: 'status' }, 'private-status'));
  const protocolTrace = harness.trace;
  const forbiddenKey = /^(detailRows|fileEntries|preparedBatch|preparedRows|privateContext|selectedBigAccount|filePath|path)$/i;
  function scan(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.equal(forbiddenKey.test(key), false, `forbidden key leaked: ${key}`);
      scan(item);
    }
  }
  scan(imported.result);
  scan(status.result);
  protocolTrace.forEach(scan);
  assert.ok(Buffer.byteLength(JSON.stringify(status.result), 'utf8') < 1024 * 1024);
  assert.equal(JSON.stringify(protocolTrace).includes(inputPath), false);
});

test('live IPC 与 canonical production=false/legacy/0 静态门禁保持不变', () => {
  const fixture = JSON.parse(fs.readFileSync(POLICY_FIXTURE, 'utf8'));
  for (const [actionKey, policy] of Object.entries(fixture.actions)) {
    if (!actionKey.startsWith('statement:')) continue;
    assert.equal(policy.production.enabled, false);
    assert.equal(policy.production.effectiveMode, 'legacy');
    assert.equal(policy.production.effectiveWorkerCount, 0);
  }
  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const backgroundIndex = fs.readFileSync(
    path.join(ROOT, 'src', 'main-process', 'background-execution', 'index.js'),
    'utf8'
  );
  assert.equal(mainSource.includes("require('./main-process/statement-worker"), false);
  assert.equal(backgroundIndex.includes('statement-worker'), false);
});
