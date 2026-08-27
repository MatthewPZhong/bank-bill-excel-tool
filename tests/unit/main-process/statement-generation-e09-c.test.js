'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const { buildMappedRows } = require('../../../src/backend/file-service');

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
  executeStatementGeneration
} = require('../../../src/main-process/statement-worker/generation');
const {
  createStatementGenerationExecuteRequest,
  validateStatementGenerationResult
} = require('../../../src/main-process/statement-worker/generation-contracts');
const {
  cleanupStatementStagingResources,
  validateAndPublishStatementGeneration,
  validateTechnicalArtifacts
} = require('../../../src/main-process/statement-worker/publication');

const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE_ROOT = path.join(
  ROOT,
  'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid'
);
const POLICY_FIXTURE = path.join(FIXTURE_ROOT, 'policy-registry.v3.2.x.json');
const STATIC_KEYS = path.join(FIXTURE_ROOT, 'static-key-manifest.v3.2.x.json');
const ACTIONS = ['statement:import', 'statement:generate-current', 'statement:generate-all'];

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
  assert.equal(validateTechnicalArtifacts({ result: manifest, filePlan, stagingRoot: staging }).length, 1);
  const bytes = fs.readFileSync(generationPath);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(generationPath, bytes);
  let publisherCalls = 0;
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result: manifest,
      filePlan,
      stagingRoot: staging,
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
  const writeArtifacts = () => {
    writeStatement(generationPaths[0], [['2026-08-01', 10, '', 'USD', 'M001']]);
    writeStatement(generationPaths[1], [['2026-08-01', 10, '', 'USD', 'M001']]);
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

  writeArtifacts();
  await assert.rejects(
    validateAndPublishStatementGeneration({
      result: buildManifest(),
      filePlan,
      stagingRoot: staging,
      taskId: 'statement-publisher-rollback',
      userDataDir,
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
    taskId: 'statement-publisher-success',
    userDataDir
  });
  assert.equal(published.publication.committed, true);
  assert.deepEqual(targetPaths.map((filePath) => fs.existsSync(filePath)), [true, true]);
  assert.deepEqual(generationPaths.map((filePath) => fs.existsSync(filePath)), [false, false]);
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
        { kind: 'detail', artifactKey: 'artifact-balance-detail', stagingResourceId: 'balance/detail.xlsx' },
        { kind: 'balance', artifactKey: 'artifact-balance', stagingResourceId: 'balance/balance.xlsx' }
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
});
