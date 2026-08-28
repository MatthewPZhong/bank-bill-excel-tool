'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const StyledXLSX = require('xlsx-js-style');

const {
  buildMappedRows,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../../../src/backend/file-service');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('../../../src/main-process/background-execution/execution-policy-registry');
const {
  assertFinanceSafeValue
} = require('../../../src/main-process/background-execution/error-codec');
const { createResourceGovernor } = require('../../../src/main-process/background-execution/resource-governor');
const { createExecutionSupervisor } = require('../../../src/main-process/background-execution/supervisor');
const {
  createWorkerThreadAdapter
} = require('../../../src/main-process/background-execution/adapters/worker-thread-adapter');
const {
  normalizeFilePlanV1
} = require('../../../src/main-process/archive-center/file-plan');
const {
  sourceSnapshotFromStat
} = require('../../../src/main-process/archive-center/source-snapshot');
const {
  STATEMENT_RESULT_VALIDATORS,
  createStatementFinanceSafeValueDelegate
} = require('../../../src/main-process/statement-worker/contracts');
const {
  createStatementTemplateEvidence
} = require('../../../src/main-process/statement-worker/import-contracts');
const {
  createStatementWorkerEntryRegistry
} = require('../../../src/main-process/statement-worker/runtime-bindings');
const {
  executeStatementGeneration,
  resolveArtifactPlans
} = require('../../../src/main-process/statement-worker/generation');
const {
  MAX_ARTIFACT_BYTES,
  createStatementGenerationExecuteRequest,
  validateStatementGenerationResult
} = require('../../../src/main-process/statement-worker/generation-contracts');
const {
  cleanupStatementStagingResources,
  journalPublisher,
  validateAndPublishStatementGeneration,
  validateBusinessArtifacts,
  validateTechnicalArtifacts
} = require('../../../src/main-process/statement-worker/publication');
const {
  createMainExpectedArtifactDescriptor,
  createStatementArtifactLineage,
  createStatementBusinessEvidence,
  createStatementCellContractEvidence
} = require('../../../src/main-process/statement-worker/artifact-descriptor');

const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE_ROOT = path.join(
  ROOT,
  'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid'
);
const POLICY_FIXTURE = path.join(FIXTURE_ROOT, 'policy-registry.v3.2.x.json');
const STATIC_KEYS = path.join(FIXTURE_ROOT, 'static-key-manifest.v3.2.x.json');
const ACTIONS = ['statement:import', 'statement:generate-current', 'statement:generate-all'];
const BALANCE_TEMPLATE_PATH = path.join(ROOT, 'assets', '余额账单模版.xlsx');
const DETAIL_HEADERS = Object.freeze([
  'BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'
]);
const BALANCE_HEADERS = Object.freeze(XLSX.utils.sheet_to_json(
  XLSX.readFile(BALANCE_TEMPLATE_PATH, { raw: true }).Sheets.balance,
  { header: 1, defval: '', raw: true }
)[0]);

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-e09-c-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeStatement(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Date', 'Credit', 'Debit', 'Currency', 'Account'],
    ...rows
  ]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function writeRows(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function writeDetailArtifact(filePath, records, headers = DETAIL_HEADERS) {
  writeWorkbookRows({ rows: [headers, ...records], outputFilePath: filePath });
  return filePath;
}

function balanceRecord(values = {}) {
  return BALANCE_HEADERS.map((header) => ({
    银行名称: '中行',
    所在地: '上海',
    币种: 'USD',
    银行账号: 'M001',
    账单日期: '2026-08-01',
    期初余额: 0,
    期初可用余额: 0,
    期末余额: 10,
    期末可用余额: 10,
    ...values
  })[header]);
}

function writeBalanceArtifact(filePath, records) {
  writeBalanceWorkbook({
    templateFilePath: BALANCE_TEMPLATE_PATH,
    records,
    templateFields: BALANCE_HEADERS,
    outputFilePath: filePath
  });
  return filePath;
}

function expectedArtifact({
  artifactKey,
  kind,
  ordinal,
  stagingResourceId,
  records,
  inputRows = records.length,
  headers = kind === 'detail' ? DETAIL_HEADERS : BALANCE_HEADERS,
  warningSummary = { count: 0, byType: {}, manualBalanceRequired: false },
  sessionRevision = 1,
  inputEvidenceHash = 'a'.repeat(64)
}) {
  return createMainExpectedArtifactDescriptor({
    version: 1,
    artifactKey,
    kind,
    ordinal,
    stagingResourceId,
    sheetName: kind === 'detail' ? 'COMMON' : 'balance',
    headers,
    rowCounts: { input: inputRows, output: records.length },
    businessEvidence: createStatementBusinessEvidence({ kind, headers, records }),
    cellContractEvidence: createStatementCellContractEvidence({
      kind,
      headers,
      records,
      balanceTemplatePath: BALANCE_TEMPLATE_PATH
    }),
    warningSummary,
    sessionRevision,
    inputEvidenceHash,
    lineage: createStatementArtifactLineage({
      kind,
      balanceTemplatePath: BALANCE_TEMPLATE_PATH
    })
  });
}

function generationResult({
  scope = 'current',
  artifacts,
  sessionRevision = 1,
  inputEvidenceHash = 'a'.repeat(64),
  warningSummary = { count: 0, byType: {}, manualBalanceRequired: false }
}) {
  return {
    status: 'generated',
    scope,
    artifacts: artifacts.map(({ artifactKey, generationPath, inputRows, outputRows }) => {
      const bytes = fs.readFileSync(generationPath);
      return {
        artifactKey,
        generationPath,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        rowCounts: { input: inputRows, output: outputRows },
        warningSummary,
        sessionRevision,
        inputEvidenceHash
      };
    }),
    warningSummary,
    sessionRevision,
    inputEvidenceHash
  };
}

function source(filePath) {
  return {
    resourceId: path.basename(filePath),
    snapshot: sourceSnapshotFromStat(fs.lstatSync(filePath, { bigint: true }))
  };
}

function templateEvidence() {
  return createStatementTemplateEvidence({
    templateId: 'template-e09-c',
    templateName: '中行-上海',
    expectedSourceHeaders: ['Date', 'Credit', 'Debit', 'Currency', 'Account'],
    orderedTargetFields: ['BillDate', 'Credit Amount', 'Debit Amount', 'Currency', 'MerchantId'],
    mappingByField: {
      BillDate: 'Date',
      'Credit Amount': 'Credit',
      'Debit Amount': 'Debit',
      Currency: 'Currency',
      MerchantId: 'Account'
    },
    accountMappingByBankId: {},
    currencyMappings: [],
    amountMappingRules: { nameSourceField: '', accountSourceField: '', signedAmountSourceField: '' },
    amountSplitByField: null,
    billSplitMerge: null,
    dateParseOrder: 'auto'
  });
}

function policyRegistry(workerData) {
  const fixture = JSON.parse(fs.readFileSync(POLICY_FIXTURE, 'utf8'));
  const policies = ACTIONS.map((action) => structuredClone(fixture.actions[action]));
  const entries = createStaticRegistry(createStatementWorkerEntryRegistry({ workerData })).freeze();
  const validators = createStaticRegistry(Object.fromEntries(policies.map((policy) => [
    policy.result.validatorKey,
    STATEMENT_RESULT_VALIDATORS[policy.actionKey]
  ]).concat(policies.flatMap((policy) => [
    [policy.artifacts.technicalValidatorKey, () => true],
    [policy.artifacts.businessValidatorKey, () => true]
  ].filter(([key]) => key))))).freeze();
  return createExecutionPolicyRegistry({
    policies,
    entryRegistry: entries,
    validatorRegistry: validators,
    staticKeys: JSON.parse(fs.readFileSync(STATIC_KEYS, 'utf8')),
    generatedAt: '2026-08-28T00:00:00.000Z',
    baselineRef: 'e09-c-statement-generation'
  }).freeze();
}

function harness(workerData) {
  const registry = policyRegistry(workerData);
  const governor = createResourceGovernor({
    budgets: {
      cpuSlots: 4,
      workerThreadSlots: 4,
      utilityProcessSlots: 1,
      ioHeavySlots: 4,
      memoryBytes: 1024 * 1024 * 1024
    }
  });
  return createExecutionSupervisor({
    policyRegistry: registry,
    resourceGovernor: governor,
    workerThreadAdapter: createWorkerThreadAdapter(),
    initTimeoutMs: 5000,
    executionTimeoutMs: 10000
  });
}

function request(actionKey, input, ordinal) {
  const operationKey = `statement-e09-c-operation-${ordinal}`;
  const taskKey = actionKey === 'statement:import'
    ? 'file:import'
    : actionKey === 'statement:generate-current'
      ? 'file:export-detail'
      : 'monthly-balance:export';
  return {
    actionKey,
    operationKey,
    jobId: `statement-e09-c-job-${ordinal}`,
    production: false,
    input,
    context: {
      kind: 'operation',
      value: {
        taskRunId: `statement-e09-c-task-${ordinal}`,
        taskKey,
        moduleId: 'statement',
        parentRunId: 'statement-e09-c-parent',
        operationKey
      }
    },
    units: []
  };
}

function tokenFrom(interaction) {
  return {
    tokenId: interaction.tokenId,
    purpose: interaction.purpose,
    serviceGeneration: interaction.serviceGeneration,
    sessionRevision: interaction.sessionRevision,
    expiresAt: interaction.expiresAt,
    allowedChoiceDigest: interaction.allowedChoiceDigest
  };
}

function outputRows(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: '',
    raw: true
  }).slice(1);
}

test('真实 Supervisor/ServiceHost/Worker 以token+revision+evidence生成current/all并写SQLite审计回读', async (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  const storage = path.join(root, 'storage');
  fs.mkdirSync(staging);
  fs.mkdirSync(storage);
  const first = path.join(root, 'first.xlsx');
  const second = path.join(root, 'second.xlsx');
  writeStatement(first, [['2026-08-01', 10, '', 'USD', 'M001']]);
  writeStatement(second, [['2026-08-02', '', 3, 'EUR', 'M002']]);
  const supervisor = harness({
    statementSourceRoot: root,
    statementStagingRoot: staging,
    statementStorageRoot: storage,
    statementBalanceTemplatePath: path.join(ROOT, 'assets', '余额账单模版.xlsx')
  });
  t.after(async () => supervisor.shutdown({ forceServices: true, timeoutMs: 5000 }));
  const evidence = templateEvidence();
  for (const [index, filePath] of [first, second].entries()) {
    const imported = await supervisor.execute(request('statement:import', {
      command: 'import',
      sessionKey: 'template-e09-c',
      sources: [source(filePath)],
      templateEvidence: evidence
    }, index + 1));
    assert.equal(imported.outcome, 'completed');
  }

  async function generate(actionKey, resourceId, ordinal) {
    const prepared = await supervisor.execute(request(actionKey, {
      command: 'prepare-generation', sessionKey: 'template-e09-c', kind: 'detail'
    }, ordinal));
    assert.equal(prepared.outcome, 'completed', JSON.stringify(prepared));
    assert.equal(prepared.result.status, 'interaction-required');
    const input = {
      command: 'generate',
      token: tokenFrom(prepared.result.interaction),
      sessionKey: 'template-e09-c',
      sessionRevision: 2,
      kind: 'detail',
      artifacts: [{ kind: 'detail', artifactKey: `artifact-${resourceId}`, stagingResourceId: resourceId }]
    };
    if (actionKey === 'statement:generate-current') {
      const staleRevision = await supervisor.execute(request(actionKey, {
        ...input,
        sessionRevision: 1
      }, ordinal + 1));
      assert.equal(staleRevision.outcome, 'failed');
      assert.equal(staleRevision.error.code, 'STATEMENT_TOKEN_STALE');
      const invalidChoice = await supervisor.execute(request(actionKey, {
        ...input,
        kind: 'balance',
        artifacts: [{
          kind: 'balance',
          artifactKey: `artifact-invalid-${resourceId}`,
          stagingResourceId: `invalid-${resourceId}`
        }]
      }, ordinal + 4));
      assert.equal(invalidChoice.outcome, 'failed');
      assert.equal(invalidChoice.error.code, 'STATEMENT_GENERATION_CHOICE_INVALID');
    }
    const generated = await supervisor.execute(request(actionKey, input, ordinal + 2));
    assert.equal(generated.outcome, 'completed', JSON.stringify(generated));
    assert.equal(generated.result.status, 'generated');
    const replay = await supervisor.execute(request(actionKey, input, ordinal + 3));
    assert.equal(replay.outcome, 'failed');
    assert.equal(replay.error.code, 'STATEMENT_TOKEN_STALE');
    return generated.result.artifacts[0];
  }

  const current = await generate('statement:generate-current', 'current/detail.xlsx', 10);
  const all = await generate('statement:generate-all', 'all/detail.xlsx', 20);
  assert.equal(outputRows(current.generationPath).length, 1);
  assert.equal(outputRows(all.generationPath).length, 2);
  assert.equal(current.rowCounts.output, 1);
  assert.equal(all.rowCounts.output, 2);
  assert.notEqual(current.inputEvidenceHash, all.inputEvidenceHash);

  const crossPrepared = await supervisor.execute(request('statement:generate-current', {
    command: 'prepare-generation', sessionKey: 'template-e09-c', kind: 'detail'
  }, 25));
  const crossScope = await supervisor.execute(request('statement:generate-all', {
    command: 'generate',
    token: tokenFrom(crossPrepared.result.interaction),
    sessionKey: 'template-e09-c',
    sessionRevision: 2,
    kind: 'detail',
    artifacts: [{ kind: 'detail', artifactKey: 'artifact-cross-all', stagingResourceId: 'cross/all.xlsx' }]
  }, 26));
  assert.equal(crossScope.outcome, 'completed');
  assert.equal(crossScope.result.artifacts[0].rowCounts.output, 2);

  const evidencePrepared = await supervisor.execute(request('statement:generate-all', {
    command: 'prepare-generation', sessionKey: 'template-e09-c', kind: 'detail'
  }, 30));
  writeStatement(first, [['2026-08-01', 999, '', 'USD', 'M001']]);
  const changed = await supervisor.execute(request('statement:generate-all', {
    command: 'generate',
    token: tokenFrom(evidencePrepared.result.interaction),
    sessionKey: 'template-e09-c',
    sessionRevision: 2,
    kind: 'detail',
    artifacts: [{ kind: 'detail', artifactKey: 'artifact-changed', stagingResourceId: 'changed/detail.xlsx' }]
  }, 31));
  assert.equal(changed.outcome, 'failed');
  assert.equal(changed.error.code, 'STATEMENT_GENERATION_INPUT_STALE');
  assert.equal(fs.existsSync(path.join(staging, 'changed/detail.xlsx')), false);

  const database = new DatabaseSync(path.join(root, 'audit.sqlite'));
  t.after(() => database.close());
  database.exec('CREATE TABLE artifacts(scope TEXT PRIMARY KEY, size INTEGER, sha256 TEXT, row_count INTEGER)');
  const insert = database.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?)');
  insert.run('current', current.size, current.sha256, current.rowCounts.output);
  insert.run('all', all.size, all.sha256, all.rowCounts.output);
  assert.deepEqual(database.prepare('SELECT scope, row_count FROM artifacts ORDER BY scope').all()
    .map((row) => ({ ...row })), [
    { scope: 'all', row_count: 2 },
    { scope: 'current', row_count: 1 }
  ]);
});

test('Main在全部technical/business readback前Publisher=0，tamper与multi artifact失败不发布', async (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  const targets = path.join(root, 'targets');
  fs.mkdirSync(staging);
  fs.mkdirSync(targets);
  const generationPath = path.join(staging, 'detail.xlsx');
  writeStatement(generationPath, [['2026-08-01', 10, '', 'USD', 'M001']]);
  const finalPath = path.join(targets, 'detail.xlsx');
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{ filePath: finalPath, role: 'output', sourceOperation: 'statement:generate-current' }]
  });
  const stat = fs.lstatSync(generationPath);
  const crypto = require('node:crypto');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(generationPath)).digest('hex');
  const manifest = {
    status: 'generated',
    scope: 'current',
    artifacts: [{
      artifactKey: filePlan.outputs[0].artifactKey,
      generationPath,
      size: stat.size,
      sha256,
      rowCounts: { input: 1, output: 1 },
      warningSummary: { count: 0, byType: {}, manualBalanceRequired: false },
      sessionRevision: 1,
      inputEvidenceHash: 'a'.repeat(64)
    }],
    warningSummary: { count: 0, byType: {}, manualBalanceRequired: false },
    sessionRevision: 1,
    inputEvidenceHash: 'a'.repeat(64)
  };
  const expectedArtifacts = [expectedArtifact({
    artifactKey: filePlan.outputs[0].artifactKey,
    kind: 'detail',
    ordinal: 0,
    stagingResourceId: 'detail.xlsx',
    records: [['2026-08-01', 'M001', 'USD', 10, '']]
  })];
  assert.equal(validateTechnicalArtifacts({
    result: manifest,
    filePlan,
    stagingRoot: staging,
    expectedArtifacts
  }).length, 1);
  assert.throws(
    () => validateTechnicalArtifacts({
      result: manifest,
      filePlan,
      stagingRoot: staging,
      expectedArtifacts: [expectedArtifact({
        artifactKey: filePlan.outputs[0].artifactKey,
        kind: 'detail',
        ordinal: 0,
        stagingResourceId: 'detail.xlsx',
        records: [['2026-08-01', 'M001', 'USD', 10, '']],
        sessionRevision: 2
      })]
    }),
    (error) => error.code === 'STATEMENT_GENERATION_SESSION_EVIDENCE_MISMATCH'
  );
  const bytes = fs.readFileSync(generationPath);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(generationPath, bytes);
  let publisherCalls = 0;
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result: manifest,
      filePlan,
      stagingRoot: staging,
      expectedArtifacts,
      taskId: 'statement-tamper',
      userDataDir: path.join(root, 'user-data'),
      publisher: async () => { publisherCalls += 1; }
    }),
    (error) => error.code === 'STATEMENT_GENERATION_ARTIFACT_TAMPERED'
  );
  assert.equal(publisherCalls, 0);
  assert.equal(fs.existsSync(finalPath), false);
});

test('现有journal Publisher对current/all多artifact执行全有或全无并在失败后清理generation', async (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  const targets = path.join(root, 'targets');
  const userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(staging);
  fs.mkdirSync(targets);
  const generationPaths = [path.join(staging, 'detail.xlsx'), path.join(staging, 'balance.xlsx')];
  const targetPaths = [path.join(targets, 'detail.xlsx'), path.join(targets, 'balance.xlsx')];
  const publisherOptionHijackPath = path.join(root, 'publisher-option-hijack.xlsx');
  const detailRecords = [['2026-08-01', 'M001', 'USD', '1234567890123456', '']];
  const balanceRecords = [balanceRecord()];
  const writeArtifacts = () => {
    writeDetailArtifact(generationPaths[0], detailRecords);
    writeBalanceArtifact(generationPaths[1], balanceRecords);
  };
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: targetPaths.map((filePath) => ({
      filePath,
      role: 'output',
      sourceOperation: 'statement:generate-all'
    }))
  });
  const buildManifest = () => {
    const artifacts = generationPaths.map((generationPath, index) => {
      const bytes = fs.readFileSync(generationPath);
      return {
        artifactKey: filePlan.outputs[index].artifactKey,
        generationPath,
        size: bytes.length,
        sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
        rowCounts: { input: 1, output: 1 },
        warningSummary: { count: 0, byType: {}, manualBalanceRequired: false },
        sessionRevision: 3,
        inputEvidenceHash: 'b'.repeat(64)
      };
    });
    return {
      status: 'generated',
      scope: 'all',
      artifacts,
      warningSummary: { count: 0, byType: {}, manualBalanceRequired: false },
      sessionRevision: 3,
      inputEvidenceHash: 'b'.repeat(64)
    };
  };
  const expectedArtifacts = [
    expectedArtifact({
      artifactKey: filePlan.outputs[0].artifactKey,
      kind: 'detail',
      ordinal: 0,
      stagingResourceId: 'detail.xlsx',
      records: detailRecords,
      sessionRevision: 3,
      inputEvidenceHash: 'b'.repeat(64)
    }),
    expectedArtifact({
      artifactKey: filePlan.outputs[1].artifactKey,
      kind: 'balance',
      ordinal: 1,
      stagingResourceId: 'balance.xlsx',
      records: balanceRecords,
      sessionRevision: 3,
      inputEvidenceHash: 'b'.repeat(64)
    })
  ];

  writeArtifacts();
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result: buildManifest(),
      filePlan,
      stagingRoot: staging,
      expectedArtifacts,
      taskId: 'statement-publisher-rollback',
      userDataDir,
      balanceTemplatePath: BALANCE_TEMPLATE_PATH,
      publisherOptions: {
        checkpoint(name, context) {
          if (name === 'publish:before-publish' && context.index === 1) {
            throw new Error('injected second artifact publication failure');
          }
        }
      }
    }),
    (error) => error.code === 'TOOLBOX_PUBLICATION_FAILED'
  );
  assert.deepEqual(targetPaths.map((filePath) => fs.existsSync(filePath)), [false, false]);
  assert.deepEqual(generationPaths.map((filePath) => fs.existsSync(filePath)), [false, false]);

  writeArtifacts();
  const published = await validateAndPublishStatementGeneration({
    result: buildManifest(),
    filePlan,
    stagingRoot: staging,
    expectedArtifacts,
    taskId: 'statement-publisher-success',
    userDataDir,
    balanceTemplatePath: BALANCE_TEMPLATE_PATH,
    publisherOptions: {
      taskId: 'publisher-option-hijack',
      userDataDir: path.join(root, 'publisher-option-user-data'),
      artifacts: [],
      targets: [{ targetPath: publisherOptionHijackPath }],
      requireValidatedArtifacts: false
    }
  });
  assert.equal(published.publication.committed, true);
  assert.deepEqual(targetPaths.map((filePath) => fs.existsSync(filePath)), [true, true]);
  assert.equal(fs.existsSync(publisherOptionHijackPath), false);
  assert.deepEqual(generationPaths.map((filePath) => fs.existsSync(filePath)), [false, false]);
});

test('task-owned staging逐级拒绝ancestor symlink，technical/default Publisher/restart cleanup均不越界', async (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  const outsideDirectory = path.join(root, 'outside');
  const targetDirectory = path.join(root, 'targets');
  fs.mkdirSync(staging);
  fs.mkdirSync(outsideDirectory);
  fs.mkdirSync(targetDirectory);
  const outsideArtifact = path.join(outsideDirectory, 'detail.xlsx');
  const records = [['2026-08-01', 'M001', 'USD', 10, '']];
  writeDetailArtifact(outsideArtifact, records);
  const linkDirectory = path.join(staging, 'task');
  fs.symlinkSync(outsideDirectory, linkDirectory, 'dir');
  const lexicalArtifact = path.join(linkDirectory, 'detail.xlsx');
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{
      filePath: path.join(targetDirectory, 'detail.xlsx'),
      role: 'output',
      sourceOperation: 'statement:generate-current'
    }]
  });
  const expectedArtifacts = [expectedArtifact({
    artifactKey: filePlan.outputs[0].artifactKey,
    kind: 'detail',
    ordinal: 0,
    stagingResourceId: 'task/detail.xlsx',
    records
  })];
  const outsideManifest = generationResult({
    artifacts: [{
      artifactKey: filePlan.outputs[0].artifactKey,
      generationPath: lexicalArtifact,
      inputRows: 1,
      outputRows: 1
    }]
  });
  assert.throws(
    () => validateTechnicalArtifacts({
      result: outsideManifest,
      filePlan,
      stagingRoot: staging,
      expectedArtifacts
    }),
    (error) => error.code === 'STATEMENT_GENERATION_PATH_INVALID'
  );
  let publisherCalls = 0;
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result: outsideManifest,
      filePlan,
      stagingRoot: staging,
      expectedArtifacts,
      taskId: 'statement-ancestor-symlink',
      userDataDir: path.join(root, 'user-data'),
      publisher: async () => { publisherCalls += 1; }
    }),
    (error) => error.code === 'STATEMENT_GENERATION_PATH_INVALID'
  );
  assert.equal(publisherCalls, 0);
  assert.equal(fs.existsSync(outsideArtifact), true, 'technical/finally不得删除symlink祖先外文件');
  const cleanup = cleanupStatementStagingResources({
    stagingRoot: staging,
    resourceIds: ['task/detail.xlsx']
  });
  assert.deepEqual(cleanup.disposed, []);
  assert.equal(cleanup.warnings.length, 1);
  assert.equal(fs.existsSync(outsideArtifact), true, 'restart cleanup不得跟随祖先symlink');

  fs.unlinkSync(linkDirectory);
  fs.mkdirSync(linkDirectory);
  writeDetailArtifact(lexicalArtifact, records);
  const ownedManifest = generationResult({
    artifacts: [{
      artifactKey: filePlan.outputs[0].artifactKey,
      generationPath: lexicalArtifact,
      inputRows: 1,
      outputRows: 1
    }]
  });
  const technicalArtifacts = validateTechnicalArtifacts({
    result: ownedManifest,
    filePlan,
    stagingRoot: staging,
    expectedArtifacts
  });
  fs.rmSync(linkDirectory, { recursive: true, force: true });
  fs.symlinkSync(outsideDirectory, linkDirectory, 'dir');
  assert.throws(
    () => journalPublisher({
      taskId: 'statement-publisher-ancestor-race',
      userDataDir: path.join(root, 'publisher-user-data'),
      technicalArtifacts,
      stagingRoot: staging
    }),
    (error) => error.code === 'STATEMENT_GENERATION_PATH_INVALID'
  );
  assert.equal(fs.existsSync(filePlan.outputs[0].filePath), false);
  assert.equal(fs.existsSync(outsideArtifact), true, 'default Publisher前复核不得发布/删除外部文件');
});

test('invalid/outside/schema/hash manifest不取得删除权限且保留原始错误', async (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  const targets = path.join(root, 'targets');
  fs.mkdirSync(staging);
  fs.mkdirSync(targets);
  const outsideArtifact = path.join(root, 'outside.xlsx');
  const records = [['2026-08-01', 'M001', 'USD', 10, '']];
  writeDetailArtifact(outsideArtifact, records);
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{
      filePath: path.join(targets, 'detail.xlsx'),
      role: 'output',
      sourceOperation: 'statement:generate-current'
    }]
  });
  const expectedArtifacts = [expectedArtifact({
    artifactKey: filePlan.outputs[0].artifactKey,
    kind: 'detail',
    ordinal: 0,
    stagingResourceId: 'owned/detail.xlsx',
    records
  })];
  const outsideResult = generationResult({
    artifacts: [{
      artifactKey: filePlan.outputs[0].artifactKey,
      generationPath: outsideArtifact,
      inputRows: 1,
      outputRows: 1
    }]
  });
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result: outsideResult,
      filePlan,
      stagingRoot: staging,
      expectedArtifacts,
      taskId: 'statement-outside-manifest',
      userDataDir: path.join(root, 'outside-user-data')
    }),
    (error) => error.code === 'STATEMENT_GENERATION_OWNERSHIP_MISMATCH'
  );
  assert.equal(fs.existsSync(outsideArtifact), true);

  const invalidSchema = { ...outsideResult, unexpected: true };
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result: invalidSchema,
      filePlan,
      stagingRoot: staging,
      expectedArtifacts,
      taskId: 'statement-invalid-schema',
      userDataDir: path.join(root, 'schema-user-data')
    }),
    (error) => error.code === 'STATEMENT_GENERATION_MANIFEST_INVALID'
  );
  assert.equal(fs.existsSync(outsideArtifact), true);

  const ownedDirectory = path.join(staging, 'owned');
  fs.mkdirSync(ownedDirectory);
  const ownedArtifact = path.join(ownedDirectory, 'detail.xlsx');
  writeDetailArtifact(ownedArtifact, records);
  const badHash = generationResult({
    artifacts: [{
      artifactKey: filePlan.outputs[0].artifactKey,
      generationPath: ownedArtifact,
      inputRows: 1,
      outputRows: 1
    }]
  });
  badHash.artifacts[0].sha256 = '0'.repeat(64);
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result: badHash,
      filePlan,
      stagingRoot: staging,
      expectedArtifacts,
      taskId: 'statement-invalid-hash',
      userDataDir: path.join(root, 'hash-user-data')
    }),
    (error) => error.code === 'STATEMENT_GENERATION_ARTIFACT_TAMPERED'
  );
  assert.equal(fs.existsSync(ownedArtifact), false, 'Main-owned且归属有效的staging可清理');
  assert.equal(fs.existsSync(outsideArtifact), true, 'hash/schema失败不得删除外部manifest路径');
});

test('Worker写前与Main技术校验拒绝dot/case/Unicode/hardlink artifact alias集合', async (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  assert.throws(
    () => resolveArtifactPlans(staging, [
      { kind: 'detail', artifactKey: 'detail', stagingResourceId: 'same.xlsx' },
      { kind: 'balance', artifactKey: 'balance', stagingResourceId: './same.xlsx' }
    ]),
    (error) => error.code === 'STATEMENT_GENERATION_STAGING_PATH_INVALID'
  );
  assert.throws(
    () => resolveArtifactPlans(staging, [
      { kind: 'detail', artifactKey: 'detail', stagingResourceId: 'caf\u00e9.xlsx' },
      { kind: 'balance', artifactKey: 'balance', stagingResourceId: 'cafe\u0301.xlsx' }
    ]),
    (error) => error.code === 'STATEMENT_GENERATION_STAGING_PATH_INVALID'
  );
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.throws(
      () => resolveArtifactPlans(staging, [
        { kind: 'detail', artifactKey: 'detail', stagingResourceId: 'Case.xlsx' },
        { kind: 'balance', artifactKey: 'balance', stagingResourceId: 'case.xlsx' }
      ]),
      (error) => error.code === 'STATEMENT_GENERATION_STAGING_PATH_INVALID'
    );
  }

  const records = [['2026-08-01', 'M001', 'USD', 10, '']];
  const detailPath = path.join(staging, 'detail.xlsx');
  const balanceAliasPath = path.join(staging, 'balance.xlsx');
  writeDetailArtifact(detailPath, records);
  fs.linkSync(detailPath, balanceAliasPath);
  const targetRoot = path.join(root, 'targets');
  fs.mkdirSync(targetRoot);
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: ['detail.xlsx', 'balance.xlsx'].map((name) => ({
      filePath: path.join(targetRoot, name),
      role: 'output',
      sourceOperation: 'statement:generate-all'
    }))
  });
  const balanceRecords = [balanceRecord()];
  const expectedArtifacts = [
    expectedArtifact({
      artifactKey: filePlan.outputs[0].artifactKey,
      kind: 'detail',
      ordinal: 0,
      stagingResourceId: 'detail.xlsx',
      records
    }),
    expectedArtifact({
      artifactKey: filePlan.outputs[1].artifactKey,
      kind: 'balance',
      ordinal: 1,
      stagingResourceId: 'balance.xlsx',
      records: balanceRecords
    })
  ];
  const result = generationResult({
    scope: 'all',
    artifacts: [detailPath, balanceAliasPath].map((generationPath, index) => ({
      artifactKey: filePlan.outputs[index].artifactKey,
      generationPath,
      inputRows: 1,
      outputRows: 1
    }))
  });
  let publisherCalls = 0;
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result,
      filePlan,
      stagingRoot: staging,
      expectedArtifacts,
      taskId: 'statement-hardlink-alias',
      userDataDir: path.join(root, 'user-data'),
      balanceTemplatePath: BALANCE_TEMPLATE_PATH,
      publisher: async () => { publisherCalls += 1; }
    }),
    (error) => error.code === 'STATEMENT_GENERATION_PATH_INVALID'
  );
  assert.equal(publisherCalls, 0);
  assert.equal(fs.existsSync(detailPath), true, 'hardlink alias不授予清理权限');
  assert.equal(fs.existsSync(balanceAliasPath), true, 'hardlink alias集合保留供审计清理');
});

test('Main-owned descriptor拒绝manifest自洽但sheet/header/kind/record/formula/type/style/lineage错误的workbook', async (t) => {
  const root = tempRoot(t);
  const correctDetailRecords = [['2026-08-01', 'M001', 'USD', 10, '']];
  const correctBalanceRecords = [balanceRecord()];

  async function rewriteWorkbookEntry(filePath, entryPath, mutate) {
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const entry = zip.file(entryPath);
    assert.ok(entry, `${entryPath} must exist`);
    const original = await entry.async('string');
    const changed = mutate(original);
    assert.notEqual(changed, original, `${entryPath} mutation must change bytes`);
    zip.file(entryPath, changed);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  }

  async function addWrongTextFontStyle(filePath) {
    await rewriteWorkbookEntry(filePath, 'xl/styles.xml', (xml) => xml
      .replace(/<fonts count="3"([^>]*)>/, '<fonts count="4"$1>')
      .replace(
        '</fonts>',
        '<font><sz val="11"/><name val="Arial"/></font></fonts>'
      )
      .replace(/<cellXfs count="7">/, '<cellXfs count="8">')
      .replace(
        '</cellXfs>',
        '<xf numFmtId="49" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs>'
      ));
  }

  async function rejectCase({
    name,
    kind = 'detail',
    expectedRecords = kind === 'detail' ? correctDetailRecords : correctBalanceRecords,
    headers = kind === 'detail' ? DETAIL_HEADERS : BALANCE_HEADERS,
    writeInvalid,
    expectedCode
  }) {
    const caseRoot = path.join(root, name);
    const staging = path.join(caseRoot, 'staging');
    const targets = path.join(caseRoot, 'targets');
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(targets, { recursive: true });
    const stagingResourceId = `${name}.xlsx`;
    const generationPath = path.join(staging, stagingResourceId);
    await writeInvalid(generationPath, caseRoot);
    const filePlan = normalizeFilePlanV1({
      version: 1,
      allocation: 'eager',
      inputs: [],
      outputs: [{
        filePath: path.join(targets, `${kind}.xlsx`),
        role: 'output',
        sourceOperation: 'statement:generate-current'
      }]
    });
    const expectedArtifacts = [expectedArtifact({
      artifactKey: filePlan.outputs[0].artifactKey,
      kind,
      ordinal: 0,
      stagingResourceId,
      records: expectedRecords,
      headers
    })];
    const result = generationResult({
      artifacts: [{
        artifactKey: filePlan.outputs[0].artifactKey,
        generationPath,
        inputRows: expectedRecords.length,
        outputRows: expectedRecords.length
      }]
    });
    let publisherCalls = 0;
    await assert.rejects(
      validateAndPublishStatementGeneration({
        result,
        filePlan,
        stagingRoot: staging,
        expectedArtifacts,
        taskId: `statement-business-${name}`,
        userDataDir: path.join(caseRoot, 'user-data'),
        balanceTemplatePath: BALANCE_TEMPLATE_PATH,
        publisher: async () => { publisherCalls += 1; }
      }),
      (error) => error.code === expectedCode,
      name
    );
    assert.equal(publisherCalls, 0, `${name}: Publisher必须为0`);
    assert.equal(fs.existsSync(filePlan.outputs[0].filePath), false, `${name}: 不得生成正式目标`);
    assert.equal(fs.existsSync(generationPath), false, `${name}: task-owned失败staging应清理`);
  }

  await rejectCase({
    name: 'wrong-sheet',
    writeInvalid(filePath) {
      writeWorkbookRows({
        rows: [DETAIL_HEADERS, ...correctDetailRecords],
        outputFilePath: filePath,
        sheetName: 'Sheet1'
      });
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_KIND_INVALID'
  });
  await rejectCase({
    name: 'wrong-header',
    writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords, [
        'BillDate', 'MerchantID', 'Currency', 'Credit Amount', 'Debit Amount'
      ]);
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_HEADERS_INVALID'
  });
  await rejectCase({
    name: 'kind-swap',
    writeInvalid(filePath) {
      writeBalanceArtifact(filePath, correctBalanceRecords);
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_KIND_INVALID'
  });
  await rejectCase({
    name: 'wrong-date',
    writeInvalid(filePath) {
      writeDetailArtifact(filePath, [['2026-08-02', 'M001', 'USD', 10, '']]);
    },
    expectedCode: 'STATEMENT_GENERATION_BUSINESS_EVIDENCE_MISMATCH'
  });
  await rejectCase({
    name: 'wrong-account',
    writeInvalid(filePath) {
      writeDetailArtifact(filePath, [['2026-08-01', 'M999', 'USD', 10, '']]);
    },
    expectedCode: 'STATEMENT_GENERATION_BUSINESS_EVIDENCE_MISMATCH'
  });
  await rejectCase({
    name: 'wrong-currency',
    writeInvalid(filePath) {
      writeDetailArtifact(filePath, [['2026-08-01', 'M001', 'EUR', 10, '']]);
    },
    expectedCode: 'STATEMENT_GENERATION_BUSINESS_EVIDENCE_MISMATCH'
  });
  await rejectCase({
    name: 'wrong-amount',
    writeInvalid(filePath) {
      writeDetailArtifact(filePath, [['2026-08-01', 'M001', 'USD', 11, '']]);
    },
    expectedCode: 'STATEMENT_GENERATION_BUSINESS_EVIDENCE_MISMATCH'
  });
  await rejectCase({
    name: 'amount-direction',
    writeInvalid(filePath) {
      writeDetailArtifact(filePath, [['2026-08-01', 'M001', 'USD', 10, 3]]);
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_AMOUNT_INVALID'
  });
  await rejectCase({
    name: 'wrong-cell-type',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) =>
        xml.replace(/<c r="B2"[^>]*>[\s\S]*?<\/c>/, '<c r="B2" s="6"><v>1001</v></c>'));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_INVALID'
  });
  await rejectCase({
    name: 'wrong-cell-format',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) =>
        xml.replace(/<c r="B2" s="\d+"/, '<c r="B2" s="2"'));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_INVALID'
  });
  await rejectCase({
    name: 'wrong-style',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) =>
        xml.replace(/<c r="A1" s="\d+"/, '<c r="A1" s="0"'));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_STYLE_INVALID'
  });
  await rejectCase({
    name: 'single-quote-style',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await addWrongTextFontStyle(filePath);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) =>
        xml.replace('<c r="B2" s="5"', "<c r=\"B2\" s = '7'"));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_CONTRACT_MISMATCH'
  });
  await rejectCase({
    name: 'comment-style-spoof',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) => xml
        .replace('<c r="A1" s="3"', '<c r="A1" s="0"')
        .replace('</sheetData>', '</sheetData><!-- <c r="A1" s="3"> -->'));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_STYLE_INVALID'
  });
  await rejectCase({
    name: 'relationship-style-decoy',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
      const sheetEntry = zip.file('xl/worksheets/sheet1.xml');
      assert.ok(sheetEntry, 'sheet1.xml must exist');
      const decoyXml = await sheetEntry.async('string');
      const actualXml = decoyXml.replace('<c r="A1" s="3"', '<c r="A1" s="0"');
      assert.notEqual(actualXml, decoyXml, 'actual worksheet mutation must change bytes');
      zip.file('xl/worksheets/sheet2.xml', actualXml);
      const relationships = await zip.file('xl/_rels/workbook.xml.rels').async('string');
      zip.file(
        'xl/_rels/workbook.xml.rels',
        relationships.replace('Target="worksheets/sheet1.xml"', 'Target="worksheets/sheet2.xml"')
      );
      const contentTypes = await zip.file('[Content_Types].xml').async('string');
      zip.file(
        '[Content_Types].xml',
        contentTypes.replace(
          'PartName="/xl/worksheets/sheet1.xml"',
          'PartName="/xl/worksheets/sheet2.xml"'
        )
      );
      fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_STYLE_INVALID'
  });
  await rejectCase({
    name: 'duplicate-cell-coordinate',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) =>
        xml.replace('</c><c r="B1"', '</c><c r="A1" s="3" t="str"><v>BillDate</v></c><c r="B1"'));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_STYLE_INVALID'
  });
  await rejectCase({
    name: 'invalid-explicit-style',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) =>
        xml.replace('<c r="A1" s="3"', '<c r="A1" s="+3"'));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_STYLE_INVALID'
  });
  await rejectCase({
    name: 'wrong-watermark',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'docProps/core.xml', (xml) =>
        xml.replace('>pzhong</cp:lastModifiedBy>', '>unexpected-author</cp:lastModifiedBy>'));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_WATERMARK_INVALID'
  });
  await rejectCase({
    name: 'header-formula',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) =>
        xml.replace(
          /(<c r="A1"[^>]*>)(<v>BillDate<\/v>)/,
          '$1<f>WEBSERVICE(&quot;https://formula.invalid&quot;)</f>$2'
        ));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_INVALID'
  });
  await rejectCase({
    name: 'data-formula',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/worksheets/sheet1.xml', (xml) =>
        xml.replace(
          /(<c r="B2"[^>]*>)(<v>M001<\/v>)/,
          '$1<f>WEBSERVICE(&quot;https://formula.invalid&quot;)</f>$2'
        ));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_INVALID'
  });
  const narrativeHeaders = [...DETAIL_HEADERS, 'Narrative'];
  const narrativeRecords = [['2026-08-01', 'M001', 'USD', 10, '', '1001']];
  await rejectCase({
    name: 'non-special-string-to-numeric',
    headers: narrativeHeaders,
    expectedRecords: narrativeRecords,
    writeInvalid(filePath) {
      writeDetailArtifact(filePath, [
        ['2026-08-01', 'M001', 'USD', 10, '', 1001]
      ], narrativeHeaders);
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_CONTRACT_MISMATCH'
  });
  await rejectCase({
    name: 'data-font',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/styles.xml', (xml) =>
        xml.replace(
          '<font><sz val="11"/><name val="Calibri"/></font>',
          '<font><sz val="11"/><name val="Arial"/></font>'
        ));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_CONTRACT_MISMATCH'
  });
  await rejectCase({
    name: 'data-font-extended-flags',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/styles.xml', (xml) =>
        xml.replace(
          '<font><sz val="11"/><name val="Calibri"/></font>',
          '<font><outline/><shadow/><condense/><extend/><sz val="11"/><name val="Calibri"/></font>'
        ));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_CONTRACT_MISMATCH'
  });
  await rejectCase({
    name: 'header-bold-color',
    async writeInvalid(filePath) {
      writeDetailArtifact(filePath, correctDetailRecords);
      await rewriteWorkbookEntry(filePath, 'xl/styles.xml', (xml) =>
        xml.replace(
          '<font><sz val="10"/><name val="Courier New"/></font>',
          '<font><b/><color rgb="FFFF0000"/><sz val="10"/><name val="Courier New"/></font>'
        ));
    },
    expectedCode: 'STATEMENT_GENERATION_WORKBOOK_CELL_CONTRACT_MISMATCH'
  });
  await rejectCase({
    name: 'zero-balance-hidden-record',
    kind: 'balance',
    expectedRecords: [],
    writeInvalid(filePath) {
      writeBalanceArtifact(filePath, correctBalanceRecords);
    },
    expectedCode: 'STATEMENT_GENERATION_ROW_COUNTS_MISMATCH'
  });
  await rejectCase({
    name: 'wrong-lineage',
    kind: 'balance',
    writeInvalid(filePath, caseRoot) {
      const alternateTemplate = path.join(caseRoot, 'alternate-balance-template.xlsx');
      const workbook = StyledXLSX.readFile(BALANCE_TEMPLATE_PATH, {
        raw: true,
        cellNF: true,
        cellStyles: true
      });
      workbook.Sheets.balance['!cols'] = workbook.Sheets.balance['!cols'] || [];
      workbook.Sheets.balance['!cols'][3] = {
        ...(workbook.Sheets.balance['!cols'][3] || {}),
        width: 42
      };
      StyledXLSX.writeFile(workbook, alternateTemplate);
      writeBalanceWorkbook({
        templateFilePath: alternateTemplate,
        records: correctBalanceRecords,
        templateFields: BALANCE_HEADERS,
        outputFilePath: filePath
      });
    },
    expectedCode: 'STATEMENT_GENERATION_TEMPLATE_LINEAGE_INVALID'
  });
});

test('all scope全量0输出以rowCounts+warning可观测并通过相同Publisher边界发布header-only workbook', async (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  const storage = path.join(root, 'storage');
  const targets = path.join(root, 'targets');
  fs.mkdirSync(staging);
  fs.mkdirSync(storage);
  fs.mkdirSync(targets);
  const inputPath = writeRows(path.join(root, 'zero.xlsx'), [
    ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
    ['2026-08-01', 'M001', 'USD', 0, 0]
  ]);
  const detailRows = buildMappedRows({
    inputFilePath: inputPath,
    orderedTargetFields: DETAIL_HEADERS,
    mappingByField: {
      BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
      'Credit Amount': 'Credit', 'Debit Amount': 'Debit'
    }
  });
  const filePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{
      filePath: path.join(targets, 'zero-detail.xlsx'),
      role: 'output',
      sourceOperation: 'statement:generate-all'
    }]
  });
  const generationPath = path.join(staging, 'zero/detail.xlsx');
  const inputEvidenceHash = '9'.repeat(64);
  const result = executeStatementGeneration({
    session: {
      generationConfig: {
        template: { name: '中行-上海' },
        mappingByTargetField: {
          BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
          'Credit Amount': 'Credit', 'Debit Amount': 'Debit'
        },
        balanceRequested: false
      }
    },
    entries: [{
      id: 'zero',
      filePath: inputPath,
      detailRows,
      sourceEvidence: { resourceId: 'zero.xlsx', snapshot: source(inputPath).snapshot }
    }],
    request: {
      sessionRevision: 1,
      artifacts: [{
        kind: 'detail',
        artifactKey: filePlan.outputs[0].artifactKey,
        stagingResourceId: 'zero/detail.xlsx'
      }]
    },
    scope: 'all',
    inputEvidenceHash,
    stagingRoot: staging,
    storageRoot: storage,
    balanceTemplatePath: BALANCE_TEMPLATE_PATH
  });
  assert.deepEqual(result.artifacts[0].rowCounts, { input: 1, output: 0 });
  assert.deepEqual(result.warningSummary, {
    count: 1,
    byType: { 'detail-row-skipped': 1 },
    manualBalanceRequired: false
  });
  const expectedArtifacts = [expectedArtifact({
    artifactKey: filePlan.outputs[0].artifactKey,
    kind: 'detail',
    ordinal: 0,
    stagingResourceId: 'zero/detail.xlsx',
    records: [],
    inputRows: 1,
    warningSummary: result.warningSummary,
    inputEvidenceHash
  })];
  const published = await validateAndPublishStatementGeneration({
    result,
    filePlan,
    stagingRoot: staging,
    expectedArtifacts,
    taskId: 'statement-zero-output',
    userDataDir: path.join(root, 'user-data')
  });
  assert.equal(published.publication.committed, true);
  assert.equal(outputRows(filePlan.outputs[0].filePath).length, 0);
  assert.equal(fs.existsSync(generationPath), false);

  const balanceGenerationPath = writeBalanceArtifact(path.join(staging, 'zero/balance.xlsx'), []);
  const balanceFilePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{
      filePath: path.join(targets, 'zero-balance.xlsx'),
      role: 'output',
      sourceOperation: 'statement:generate-all'
    }]
  });
  const balanceResult = generationResult({
    scope: 'all',
    artifacts: [{
      artifactKey: balanceFilePlan.outputs[0].artifactKey,
      generationPath: balanceGenerationPath,
      inputRows: 1,
      outputRows: 0
    }],
    inputEvidenceHash,
    warningSummary: result.warningSummary
  });
  const balanceExpectedArtifacts = [expectedArtifact({
    artifactKey: balanceFilePlan.outputs[0].artifactKey,
    kind: 'balance',
    ordinal: 0,
    stagingResourceId: 'zero/balance.xlsx',
    records: [],
    inputRows: 1,
    warningSummary: result.warningSummary,
    inputEvidenceHash
  })];
  const balancePublished = await validateAndPublishStatementGeneration({
    result: balanceResult,
    filePlan: balanceFilePlan,
    stagingRoot: staging,
    expectedArtifacts: balanceExpectedArtifacts,
    taskId: 'statement-zero-balance-output',
    userDataDir: path.join(root, 'balance-user-data'),
    balanceTemplatePath: BALANCE_TEMPLATE_PATH
  });
  assert.equal(balancePublished.publication.committed, true);
  assert.equal(outputRows(balanceFilePlan.outputs[0].filePath)
    .filter((row) => row.some((value) => value !== '')).length, 0);
  assert.equal(fs.existsSync(balanceGenerationPath), false);
});

test('E09-C generation复用四金额mapped rows并保持warning/行序，混合币种余额业务等价', (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  const storage = path.join(root, 'storage');
  fs.mkdirSync(staging);
  fs.mkdirSync(storage);
  const fields = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'];
  const cases = [
    ['direct', [
      ['Date', 'Account', 'Curr', 'Credit', 'Debit'],
      ['2026-08-01', 'M001', 'USD', '100', ''],
      ['2026-08-02', 'M001', 'USD', '', '40'],
      ['2026-08-03', 'M001', 'USD', '0', '0']
    ], {
      mappingByField: {
        BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
        'Credit Amount': 'Credit', 'Debit Amount': 'Debit'
      }
    }, 2, 1],
    ['signed', [
      ['Date', 'Account', 'Curr', 'Amount'],
      ['2026-08-01', 'M001', 'USD', '+123.45'],
      ['2026-08-02', 'M001', 'USD', '-54.3']
    ], {
      mappingByField: { BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr' },
      amountMappingRules: { signedAmountSourceField: 'Amount' }
    }, 2, 0],
    ['field', [
      ['Date', 'Account', 'Curr', 'Type', 'Amount'],
      ['2026-08-01', 'M001', 'USD', 'IN', '70'],
      ['2026-08-02', 'M001', 'USD', 'OUT', '20']
    ], {
      mappingByField: { BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr' },
      amountSplitByField: {
        enabled: true,
        rules: [
          { conditionField: 'Type', conditionValue: 'IN', mappedField: 'Amount', targetField: 'Credit Amount' },
          { conditionField: 'Type', conditionValue: 'OUT', mappedField: 'Amount', targetField: 'Debit Amount' }
        ]
      }
    }, 2, 0],
    ['bill', [
      ['Date', 'Account', 'Curr', 'Credit1', 'Debit1', 'Credit2', 'Debit2'],
      ['2026-08-01', 'M001', 'USD', '150', '', '', '40'],
      ['2026-08-02', 'M001', 'USD', '60', '', '', '60']
    ], {
      mappingByField: { BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr' },
      billSplitMerge: {
        enabled: true,
        reuseModuleMapping: true,
        billSplitRows: [
          { seqNo: 1, rowStatus: 'completed', currencySourceField: 'Curr', creditSourceField: 'Credit1', debitSourceField: 'Debit1', mergedGroupSeq: 1 },
          { seqNo: 2, rowStatus: 'completed', currencySourceField: 'Curr', creditSourceField: 'Credit2', debitSourceField: 'Debit2', mergedGroupSeq: 1 }
        ],
        billSplitAmountRules: [],
        signedAmountSourceField: '',
        signedAmountTargetSeqNos: [],
        byFieldAmountTargetSeqNos: []
      }
    }, 1, 0]
  ];

  for (const [name, rawRows, mapping, expectedRows, expectedWarnings] of cases) {
    const sourcePath = writeRows(path.join(root, `${name}.xlsx`), rawRows);
    const detailRows = buildMappedRows({
      inputFilePath: sourcePath,
      orderedTargetFields: fields,
      mappingByField: mapping.mappingByField,
      amountMappingRules: mapping.amountMappingRules,
      amountSplitByField: mapping.amountSplitByField,
      billSplitMerge: mapping.billSplitMerge
    });
    const session = {
      generationConfig: {
        template: { name: '中行-上海' },
        mappingByTargetField: mapping.mappingByField,
        balanceRequested: false
      }
    };
    const entry = {
      id: name,
      filePath: sourcePath,
      detailRows,
      sourceEvidence: { resourceId: path.basename(sourcePath), snapshot: source(sourcePath).snapshot }
    };
    const result = executeStatementGeneration({
      session,
      entries: [entry],
      request: {
        sessionRevision: 1,
        artifacts: [{ kind: 'detail', artifactKey: `artifact-${name}`, stagingResourceId: `${name}.xlsx` }]
      },
      scope: 'current',
      inputEvidenceHash: 'c'.repeat(64),
      stagingRoot: staging,
      storageRoot: storage,
      balanceTemplatePath: path.join(ROOT, 'assets', '余额账单模版.xlsx')
    });
    assert.equal(result.artifacts[0].rowCounts.output, expectedRows, name);
    assert.equal(result.warningSummary.count, expectedWarnings, name);
  }

  const balanceSource = writeRows(path.join(root, 'mixed-balance.xlsx'), [
    ['Date', 'Account', 'Curr', 'Credit', 'Debit', 'EndBalance'],
    ['2026-08-01', 'M001', 'USD', '100', '', '1000'],
    ['2026-08-02', 'M001', 'USD', '100', '', '1100'],
    ['2026-08-02', 'M001', 'EUR', '', '20', '900']
  ]);
  const balanceFields = fields.concat('Balance');
  const balanceRows = buildMappedRows({
    inputFilePath: balanceSource,
    orderedTargetFields: balanceFields,
    mappingByField: {
      BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
      'Credit Amount': 'Credit', 'Debit Amount': 'Debit', Balance: 'EndBalance'
    }
  });
  const balanceEntry = {
    id: 'balance',
    filePath: balanceSource,
    detailRows: balanceRows,
    sourceEvidence: { resourceId: 'mixed-balance.xlsx', snapshot: source(balanceSource).snapshot }
  };
  const validationTargets = path.join(root, 'validation-targets');
  fs.mkdirSync(validationTargets);
  const validationFilePlan = normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: ['detail.xlsx', 'balance.xlsx'].map((name) => ({
      filePath: path.join(validationTargets, name),
      role: 'output',
      sourceOperation: 'statement:generate-all'
    }))
  });
  const balanceResult = executeStatementGeneration({
    session: {
      generationConfig: {
        template: { name: '中行-上海' },
        mappingByTargetField: { MerchantId: 'Account', Balance: 'EndBalance' },
        balanceRequested: true,
        balanceMode: 'statement'
      }
    },
    entries: [balanceEntry],
    request: {
      sessionRevision: 1,
      artifacts: [
        {
          kind: 'detail',
          artifactKey: validationFilePlan.outputs[0].artifactKey,
          stagingResourceId: 'balance/detail.xlsx'
        },
        {
          kind: 'balance',
          artifactKey: validationFilePlan.outputs[1].artifactKey,
          stagingResourceId: 'balance/balance.xlsx'
        }
      ]
    },
    scope: 'all',
    inputEvidenceHash: 'd'.repeat(64),
    stagingRoot: staging,
    storageRoot: storage,
    balanceTemplatePath: path.join(ROOT, 'assets', '余额账单模版.xlsx')
  });
  assert.equal(balanceResult.artifacts.length, 2);
  assert.equal(balanceResult.warningSummary.count, 0);
  assert.deepEqual(outputRows(balanceResult.artifacts[1].generationPath).map((row) => [row[2], row[7]]), [
    ['EUR', 900],
    ['USD', 1000],
    ['USD', 1100]
  ]);
  const expectedArtifacts = [
    expectedArtifact({
      artifactKey: validationFilePlan.outputs[0].artifactKey,
      kind: 'detail',
      ordinal: 0,
      stagingResourceId: 'balance/detail.xlsx',
      headers: fields,
      inputRows: 3,
      records: [
        ['2026-08-01', 'M001', 'USD', 100, ''],
        ['2026-08-02', 'M001', 'USD', 100, ''],
        ['2026-08-02', 'M001', 'EUR', '', 20]
      ],
      inputEvidenceHash: 'd'.repeat(64)
    }),
    expectedArtifact({
      artifactKey: validationFilePlan.outputs[1].artifactKey,
      kind: 'balance',
      ordinal: 1,
      stagingResourceId: 'balance/balance.xlsx',
      inputRows: 3,
      records: [
        balanceRecord({
          币种: 'EUR', 账单日期: '2026-08-02', 期初余额: '', 期初可用余额: '',
          期末余额: 900, 期末可用余额: ''
        }),
        balanceRecord({
          币种: 'USD', 账单日期: '2026-08-01', 期初余额: '', 期初可用余额: '',
          期末余额: 1000, 期末可用余额: ''
        }),
        balanceRecord({
          币种: 'USD', 账单日期: '2026-08-02', 期初余额: '', 期初可用余额: '',
          期末余额: 1100, 期末可用余额: ''
        })
      ],
      inputEvidenceHash: 'd'.repeat(64)
    })
  ];
  const technicalArtifacts = validateTechnicalArtifacts({
    result: balanceResult,
    filePlan: validationFilePlan,
    stagingRoot: staging,
    expectedArtifacts
  });
  assert.equal(validateBusinessArtifacts(technicalArtifacts, {
    balanceTemplatePath: BALANCE_TEMPLATE_PATH
  }), technicalArtifacts);
});

test('kill/restart后Main按已知resource清理未发布staging且拒绝越界/symlink', (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  fs.mkdirSync(path.join(staging, 'task-1'));
  const abandoned = path.join(staging, 'task-1', 'detail.xlsx');
  fs.writeFileSync(abandoned, 'abandoned-after-worker-kill');
  const outside = path.join(root, 'outside.xlsx');
  fs.writeFileSync(outside, 'formal-history');
  const link = path.join(staging, 'task-1', 'link.xlsx');
  fs.symlinkSync(outside, link);
  const cleanup = cleanupStatementStagingResources({
    stagingRoot: staging,
    resourceIds: ['task-1/detail.xlsx', 'task-1/link.xlsx', '../outside.xlsx']
  });
  assert.deepEqual(cleanup.disposed, [abandoned]);
  assert.equal(cleanup.warnings.length, 2);
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.existsSync(outside), true, '已正式发布历史和越界目标不受staging cleanup影响');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('空scope、越界resource与partial writer failure均在Publisher前失败并清理全部staging', (t) => {
  const root = tempRoot(t);
  const staging = path.join(root, 'staging');
  const storage = path.join(root, 'storage');
  fs.mkdirSync(staging);
  fs.mkdirSync(storage);
  const inputPath = writeRows(path.join(root, 'input.xlsx'), [
    ['Date', 'Account', 'Curr', 'Credit', 'Debit', 'Balance'],
    ['2026-08-01', 'M001', 'USD', 10, '', 100]
  ]);
  const detailRows = buildMappedRows({
    inputFilePath: inputPath,
    orderedTargetFields: ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance'],
    mappingByField: {
      BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr',
      'Credit Amount': 'Credit', 'Debit Amount': 'Debit', Balance: 'Balance'
    }
  });
  const entry = {
    id: 'partial',
    filePath: inputPath,
    detailRows,
    sourceEvidence: { resourceId: 'input.xlsx', snapshot: source(inputPath).snapshot }
  };
  const session = {
    generationConfig: {
      template: { name: '中行-上海' },
      mappingByTargetField: { MerchantId: 'Account', Balance: 'Balance' },
      balanceRequested: true,
      balanceMode: 'statement'
    }
  };
  const common = {
    session,
    scope: 'all',
    inputEvidenceHash: 'e'.repeat(64),
    stagingRoot: staging,
    storageRoot: storage,
    balanceTemplatePath: path.join(root, 'missing-balance-template.xlsx')
  };
  assert.throws(
    () => executeStatementGeneration({
      ...common,
      entries: [],
      request: { sessionRevision: 1, artifacts: [{ kind: 'detail', artifactKey: 'empty', stagingResourceId: 'empty.xlsx' }] }
    }),
    (error) => error.code === 'STATEMENT_GENERATION_EMPTY_SCOPE'
  );
  assert.throws(
    () => executeStatementGeneration({
      ...common,
      entries: [entry],
      request: { sessionRevision: 1, artifacts: [{ kind: 'detail', artifactKey: 'escape', stagingResourceId: '../escape.xlsx' }] }
    }),
    (error) => error.code === 'STATEMENT_GENERATION_STAGING_PATH_INVALID'
  );
  const danglingTarget = path.join(root, 'dangling-created-outside.xlsx');
  fs.symlinkSync(danglingTarget, path.join(staging, 'dangling.xlsx'));
  assert.throws(
    () => executeStatementGeneration({
      ...common,
      entries: [entry],
      request: { sessionRevision: 1, artifacts: [{ kind: 'detail', artifactKey: 'link', stagingResourceId: 'dangling.xlsx' }] }
    }),
    (error) => error.code === 'STATEMENT_GENERATION_STAGING_PATH_INVALID'
  );
  assert.throws(
    () => executeStatementGeneration({
      ...common,
      entries: [entry],
      request: {
        sessionRevision: 1,
        artifacts: [
          { kind: 'detail', artifactKey: 'partial-detail', stagingResourceId: 'partial/detail.xlsx' },
          { kind: 'balance', artifactKey: 'partial-balance', stagingResourceId: 'partial/balance.xlsx' }
        ]
      }
    }),
    (error) => error.code === 'STATEMENT_GENERATION_ARTIFACT_MISSING'
  );
  assert.throws(
    () => executeStatementGeneration({
      ...common,
      session: {
        generationConfig: {
          ...session.generationConfig,
          balanceMode: 'calculated'
        }
      },
      balanceTemplatePath: path.join(ROOT, 'assets', '余额账单模版.xlsx'),
      entries: [entry],
      request: {
        sessionRevision: 1,
        artifacts: [
          { kind: 'detail', artifactKey: 'manual-detail', stagingResourceId: 'manual/detail.xlsx' },
          { kind: 'balance', artifactKey: 'manual-balance', stagingResourceId: 'manual/balance.xlsx' }
        ]
      }
    }),
    (error) => error.code === 'STATEMENT_MANUAL_BALANCE_REQUIRED'
  );
  assert.deepEqual([
    fs.existsSync(path.join(staging, 'partial/detail.xlsx')),
    fs.existsSync(path.join(staging, 'partial/balance.xlsx')),
    fs.existsSync(path.join(staging, 'manual/detail.xlsx')),
    fs.existsSync(path.join(staging, 'manual/balance.xlsx')),
    fs.existsSync(danglingTarget),
    fs.existsSync(path.join(root, 'escape.xlsx'))
  ], [false, false, false, false, false, false]);
});

test('generation request/manifest严格限制artifact顺序、相对resource与bounded warning summary', () => {
  const token = {
    tokenId: 'd61a5b74-241d-4bd0-a848-592ca6c3bdf8',
    purpose: 'scope-generation',
    serviceGeneration: 1,
    sessionRevision: 1,
    expiresAt: Date.now() + 1000,
    allowedChoiceDigest: 'f'.repeat(64)
  };
  assert.throws(
    () => createStatementGenerationExecuteRequest({
      command: 'generate', token, sessionKey: 'session', sessionRevision: 1, kind: 'both',
      artifacts: [
        { kind: 'balance', artifactKey: 'balance', stagingResourceId: 'balance.xlsx' },
        { kind: 'detail', artifactKey: 'detail', stagingResourceId: 'detail.xlsx' }
      ]
    }),
    (error) => error.code === 'STATEMENT_GENERATION_ARTIFACT_ORDER_INVALID'
  );
  assert.throws(
    () => createStatementGenerationExecuteRequest({
      command: 'generate', token, sessionKey: 'session', sessionRevision: 1, kind: 'detail',
      artifacts: [{ kind: 'detail', artifactKey: 'detail', stagingResourceId: path.resolve('detail.xlsx') }]
    }),
    (error) => error.code === 'STATEMENT_GENERATION_STAGING_RESOURCE_INVALID'
  );
  assert.throws(
    () => createStatementGenerationExecuteRequest({
      command: 'generate', token, sessionKey: 'session', sessionRevision: 1, kind: 'both',
      artifacts: [
        { kind: 'detail', artifactKey: 'detail-dot', stagingResourceId: 'same.xlsx' },
        { kind: 'balance', artifactKey: 'balance-dot', stagingResourceId: './same.xlsx' }
      ]
    }),
    (error) => error.code === 'STATEMENT_GENERATION_STAGING_RESOURCE_INVALID'
  );
  assert.throws(
    () => createStatementGenerationExecuteRequest({
      command: 'generate', token, sessionKey: 'session', sessionRevision: 1, kind: 'both',
      artifacts: [
        { kind: 'detail', artifactKey: 'detail-unicode', stagingResourceId: 'caf\u00e9.xlsx' },
        { kind: 'balance', artifactKey: 'balance-unicode', stagingResourceId: 'cafe\u0301.xlsx' }
      ]
    }),
    (error) => error.code === 'STATEMENT_GENERATION_STAGING_RESOURCE_ALIAS'
  );
  const warningTypes = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`warning-${index}`, 1]));
  assert.equal(validateStatementGenerationResult({
    status: 'generated',
    scope: 'all',
    artifacts: [{
      artifactKey: 'detail', generationPath: path.resolve('detail.xlsx'), size: 1,
      sha256: 'a'.repeat(64), rowCounts: { input: 1, output: 1 },
      warningSummary: { count: 17, byType: warningTypes, manualBalanceRequired: false },
      sessionRevision: 1, inputEvidenceHash: 'b'.repeat(64)
    }],
    warningSummary: { count: 17, byType: warningTypes, manualBalanceRequired: false },
    sessionRevision: 1,
    inputEvidenceHash: 'b'.repeat(64)
  }), false);

  const userDirectoryManifest = {
    status: 'generated', scope: 'current',
    artifacts: [{
      artifactKey: 'detail', generationPath: '/Users/alice/task-staging/detail.xlsx', size: 1,
      sha256: 'a'.repeat(64), rowCounts: { input: 1, output: 1 },
      warningSummary: { count: 0, byType: {}, manualBalanceRequired: false },
      sessionRevision: 1, inputEvidenceHash: 'b'.repeat(64)
    }],
    warningSummary: { count: 0, byType: {}, manualBalanceRequired: false },
    sessionRevision: 1,
    inputEvidenceHash: 'b'.repeat(64)
  };
  assertFinanceSafeValue(
    { payload: { result: userDirectoryManifest } },
    'finance-safe-v1',
    '',
    { allowValue: createStatementFinanceSafeValueDelegate('statement:generate-current') }
  );
  assert.equal(validateStatementGenerationResult({
    ...userDirectoryManifest,
    artifacts: [{
      ...userDirectoryManifest.artifacts[0],
      size: MAX_ARTIFACT_BYTES + 1
    }]
  }), false);
});
