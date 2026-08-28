'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');

const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
const {
  TOOLBOX_GENERATION_ACTIONS,
  generationEvidencePath,
  normalizeGenerationEvidence,
  validateToolboxGenerationResult
} = require('../../../src/main-process/toolbox-background/generation-contract');
const {
  assertFinanceSafeValue
} = require('../../../src/main-process/background-execution/error-codec');
const {
  executeMergeGeneration,
  executeSplitGeneration
} = require('../../../src/main-process/toolbox-background/generation-core');
const {
  createGenerationInput,
  generateValidateAndPublish
} = require('../../../src/main-process/toolbox-background/generation-validator');
const {
  TOOLBOX_GENERATION_POLICIES
} = require('../../../src/main-process/toolbox-background/policies');
const {
  VCC_EXPORT_SINGLE_ACTION,
  VCC_EXPORT_SINGLE_POLICY,
  VCC_EXPORT_SUBJECTS_ACTION,
  VCC_EXPORT_SUBJECTS_POLICY
} = require('../../../src/main-process/vcc-financial-op-output/policies');
const {
  createBackgroundExecutionRuntime: createBackgroundExecutionRuntimeRaw,
  createBackgroundExecutionRuntimeManager,
  isBackgroundExecutionProductionEnabled
} = require('../../../src/main-process/background-execution/runtime');
const { mergeToolboxFilesToXlsx } = require('../../../src/main-process/toolbox-merge-io');
const { writeToolboxRows } = require('../../../src/main-process/toolbox-output-writer');

const TEST_GIBIBYTE = 1024 ** 3;

function createBackgroundExecutionRuntime(options = {}) {
  return createBackgroundExecutionRuntimeRaw({
    availableParallelism: 4,
    freeMemoryBytes: 8 * TEST_GIBIBYTE,
    totalMemoryBytes: 16 * TEST_GIBIBYTE,
    ...options
  });
}

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(label = 'toolbox-background-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  tmpDirs.push(dir);
  return dir;
}

async function writeWorkbook(filePath, rows, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheetName || 'Data');
  for (const row of rows) sheet.addRow(row);
  if (options.style) {
    sheet.getRow(1).font = { bold: true };
    sheet.getColumn(2).width = 22;
    if (sheet.rowCount > 1) sheet.getCell('B2').numFmt = '@';
  }
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

async function workbookProjection(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    rows: Array.from({ length: sheet.rowCount }, (_, index) =>
      sheet.getRow(index + 1).values.slice(1).map((value) => {
        if (value instanceof Date) return value.toISOString();
        return value == null ? '' : value;
      })),
    firstRowBold: Boolean(sheet.getCell('A1').font && sheet.getCell('A1').font.bold),
    secondColumnWidth: sheet.getColumn(2).width,
    firstDataNumFmt: sheet.getCell('B2').numFmt
  }));
}

function createFilePlan(inputs, outputPath, actionKey) {
  return normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: inputs.map((filePath) => ({
      filePath,
      originalName: path.basename(filePath),
      role: 'toolbox-source',
      sourceOperation: actionKey
    })),
    outputs: [{
      filePath: outputPath,
      originalName: path.basename(outputPath),
      role: 'toolbox-output',
      sourceOperation: actionKey
    }]
  });
}

function batchContext(operationKey = 'toolbox-background-test') {
  return Object.freeze({
    batchId: 1,
    batchNumber: 'BATCH-E04-A',
    taskRunId: 'task-run-e04-a',
    taskKey: 'task.toolbox:e04-a',
    moduleId: 'toolbox',
    parentRunId: 'parent-run-e04-a',
    operationKey
  });
}

function completedRuntime(result, captures) {
  return Object.freeze({
    async execute(request) {
      captures.push(structuredClone(request));
      return Object.freeze({
        outcome: 'completed',
        terminalSource: 'job:done',
        result
      });
    }
  });
}

test('E04-A/B policy 与 Main source selector 保持 production false，真实用户路径不伪装 canary', () => {
  assert.deepEqual(
    TOOLBOX_GENERATION_POLICIES.map((policy) => policy.actionKey),
    [
      TOOLBOX_GENERATION_ACTIONS.MERGE,
      TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
      TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
    ]
  );
  for (const policy of TOOLBOX_GENERATION_POLICIES) {
    assert.equal(
      policy.mode,
      policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
        ? 'thread-pool'
        : 'thread-single'
    );
    assert.equal(policy.lifetime, 'job');
    assert.equal(policy.adapterKind, 'native');
    assert.equal(policy.commit.kind, 'main-settlement');
    assert.equal(policy.context.kind, 'operation');
    assert.equal(policy.context.validatorKey, 'exact-5');
    assert.equal(
      policy.artifacts.maxArtifacts,
      policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT ? 8 : 1
    );
    assert.equal(policy.production.enabled, false);
    assert.equal(policy.production.effectiveMode, 'legacy');
    assert.equal(isBackgroundExecutionProductionEnabled(policy.actionKey), false);
  }
  const multiPolicy = TOOLBOX_GENERATION_POLICIES.find(
    (policy) => policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
  );
  assert.equal(multiPolicy.workUnits.requestedMaxWorkers, 1);
  assert.equal(multiPolicy.resources.compound.childrenMax, 1);
  assert.equal(multiPolicy.resources.phase.workerThreadSlots, 1);
  assert.equal(multiPolicy.resources.compound.childResource.workerThreadSlots, 1);

  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../src/main.js'), 'utf8');
  assert.equal((mainSource.match(/backgroundExecutionRuntimeManager\.get\(\)/g) || []).length, 5);
  assert.equal((mainSource.match(/generateValidateAndPublishToolboxArtifact\(\{/g) || []).length, 2);
  assert.equal((mainSource.match(/generateValidateAndPublishMultiOutput\(\{/g) || []).length, 1);
  assert.equal((mainSource.match(/production:\s*true/g) || []).length >= 3, true);
  assert.doesNotMatch(mainSource, /generateValidateAndPublishToolboxArtifact\(\{[\s\S]{0,900}?production:\s*false/);
  assert.match(mainSource, /shouldUseLargeChannel[\s\S]*?dispatchLargeSplit/);
  assert.match(mainSource, /async function publishToolboxArtifacts[\s\S]*?publishToolboxPublicationAsync/);
});

test('E04-B runtime预算完整计入Scanner phase与一个Writer child，idle/shutdown不泄漏', async () => {
  const runtime = createBackgroundExecutionRuntime({
    shutdownTimeoutMs: 10000,
    availableParallelism: 4,
    freeMemoryBytes: 3 * 1024 ** 3,
    memoryHardCeilingBytes: 4 * 1024 ** 3,
    systemReserveBytes: 1024 ** 3
  });
  const snapshot = runtime.resourceGovernor.snapshot();
  assert.deepEqual(runtime.policyRegistry.list().map((policy) => policy.actionKey), [
    TOOLBOX_GENERATION_ACTIONS.MERGE,
    TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
    TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT,
    'pre-fund:mpt-import',
    'pre-fund:mpt-repair-import',
    'recon-fix:import',
    'recon-fix:run-readonly',
    'recon-fix:run-jpm',
    'recon-fix:export',
    VCC_EXPORT_SINGLE_ACTION,
    VCC_EXPORT_SUBJECTS_ACTION
  ]);
  for (const policy of runtime.policyRegistry.list()) {
    assert.equal(policy.production.enabled, false);
  }
  assert.equal(snapshot.budgets.cpuSlots, 2);
  assert.equal(snapshot.budgets.workerThreadSlots, 3);
  assert.equal(snapshot.budgets.utilityProcessSlots, 1);
  assert.equal(snapshot.budgets.ioHeavySlots, 2);
  assert.equal(snapshot.budgets.memoryBytes, 2 * 1024 ** 3);
  const multiPolicy = TOOLBOX_GENERATION_POLICIES.find(
    (policy) => policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
  );
  assert.deepEqual(multiPolicy.resources.base, {
    cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0,
    ioHeavySlots: 0, memoryBytes: 0
  });
  assert.deepEqual(multiPolicy.resources.phase, {
    cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
    ioHeavySlots: 1, memoryBytes: 201326592
  });
  assert.deepEqual(multiPolicy.resources.compound.childResource, {
    cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
    ioHeavySlots: 1, memoryBytes: 201326592
  });
  assert.deepEqual(VCC_EXPORT_SINGLE_POLICY.resources, {
    profile: 'resource.vcc-financial-op:export-single',
    base: {
      cpuSlots: 0, workerThreadSlots: 0, utilityProcessSlots: 0,
      ioHeavySlots: 0, memoryBytes: 0
    },
    phase: {
      cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
      ioHeavySlots: 1, memoryBytes: 201326592
    },
    compound: null,
    lowMemoryBehavior: 'queue',
    admissionPriority: 'normal'
  });
  assert.deepEqual(VCC_EXPORT_SUBJECTS_POLICY.resources, {
    profile: 'resource.vcc-financial-op:export-subjects',
    base: {
      cpuSlots: 0, workerThreadSlots: 1, utilityProcessSlots: 0,
      ioHeavySlots: 0, memoryBytes: 33554432
    },
    phase: {
      cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
      ioHeavySlots: 1, memoryBytes: 268435456
    },
    compound: {
      topologyKey: 'topology.vcc-financial-op:export-subjects',
      childrenMax: 4,
      childResource: {
        cpuSlots: 1, workerThreadSlots: 1, utilityProcessSlots: 0,
        ioHeavySlots: 1, memoryBytes: 268435456
      }
    },
    lowMemoryBehavior: 'downgrade-to-single',
    admissionPriority: 'normal'
  });
  assert.deepEqual(snapshot.activeUsage, {
    cpuSlots: 0,
    workerThreadSlots: 0,
    utilityProcessSlots: 0,
    ioHeavySlots: 0,
    memoryBytes: 0
  });
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(runtime.resourceGovernor.snapshot().activeUsage, snapshot.activeUsage);
});

test('generation result 接受真实 writer 的结构化 warning sample，不改变既有 warning 语义', async () => {
  const dir = makeTempDir('toolbox-background-warning-');
  const generationPath = path.join(dir, 'warning.xlsx');
  const writerResult = await writeToolboxRows({
    savePath: generationPath,
    normalizedHeaders: ['Date'],
    writeRows: async (emit) => emit({
      rowIndex: 2,
      cells: [{
        isExplicitCell: true,
        columnIndex: 0,
        sourceFile: '/tmp/6222021234567890.xlsx',
        sourceSheet: 'Data',
        cellRef: 'A2',
        decodedSemanticValue: { kind: 'iso-date', lexical: '12000-01-01' }
      }]
    })
  });
  const sample = writerResult.warningSummary.warningSamples[0];
  assert.deepEqual(Object.keys(sample).sort(), [
    'cellRef', 'code', 'message', 'sourceFileName', 'sourceSheet'
  ]);
  assert.equal(sample.code, 'toolbox-date-text-fallback');
  assert.equal(sample.sourceFileName, '6222021234567890.xlsx');
  const evidence = normalizeGenerationEvidence({
    schemaVersion: 1,
    normalizedHeaders: ['Date'],
    warningSummary: writerResult.warningSummary
  });
  const evidenceBytes = Buffer.from(JSON.stringify(evidence));
  const result = {
    schemaVersion: 1,
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
    artifacts: [{
      outputId: 'split-1',
      outputArtifactKey: `output-${'a'.repeat(64)}`,
      byteSize: writerResult.byteSize,
      sha256: writerResult.sha256,
      dataRowCount: writerResult.dataRowCount,
      sheetCount: writerResult.sheetCount,
      matchedCount: writerResult.dataRowCount,
      warningCount: writerResult.warningSummary.warningCount,
      evidenceArtifact: {
        byteSize: evidenceBytes.length,
        sha256: crypto.createHash('sha256').update(evidenceBytes).digest('hex')
      },
      styleStats: writerResult.styleStats
    }],
    summary: {
      sourceFileCount: 1,
      inputSheetCount: 1,
      inputDataRowCount: 1,
      outputDataRowCount: 1,
      skippedHiddenSheetCount: 0,
      skippedEmptySheetCount: 0
    }
  };
  assert.equal(validateToolboxGenerationResult(result, result.actionKey), true);
  assert.doesNotThrow(() => assertFinanceSafeValue(result));
  assert.equal(JSON.stringify(result).includes('6222021234567890'), false);
  assert.equal(evidence.warningSummary.warningSamples[0].cellRef, 'A2');
});

test('Main 在 Publisher 前完成 ownership/stat/size/hash/业务回读，失败 0 次、成功 1 次', async () => {
  const dir = makeTempDir('toolbox-background-validator-');
  const sourcePath = await writeWorkbook(path.join(dir, 'source.xlsx'), [
    ['Group', 'LongId'],
    ['A', '001234567890123456789'],
    ['B', '999999999999999999999']
  ], { style: true });
  const finalPath = path.join(dir, 'final.xlsx');
  const filePlan = createFilePlan(
    [sourcePath],
    finalPath,
    TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE
  );
  const baseGenerationPath = path.join(dir, 'base-generation.xlsx');
  const baseInput = createGenerationInput({
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
    filePlan,
    generationPath: baseGenerationPath,
    operationConfig: { field: 'Group', values: ['A'] }
  });
  const baseResult = await executeSplitGeneration(baseInput, new AbortController().signal);

  async function runCase(name, mutate, options = {}) {
    const generationPath = path.join(dir, `${name}.xlsx`);
    fs.copyFileSync(baseGenerationPath, generationPath);
    const evidencePath = generationEvidencePath(generationPath);
    fs.copyFileSync(generationEvidencePath(baseGenerationPath), evidencePath);
    let result = structuredClone(baseResult);
    if (mutate) result = await mutate(result, generationPath, evidencePath);
    const captures = [];
    let publisherCalls = 0;
    const invoke = () => generateValidateAndPublish({
      runtime: completedRuntime(result, captures),
      actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
      filePlan,
      batchContext: batchContext(`toolbox-${name}`),
      generationPath,
      operationConfig: { field: 'Group', values: ['A'] },
      production: false,
      requireNonEmptySplit: options.requireNonEmptySplit !== false,
      publisher: async (artifacts) => {
        publisherCalls += 1;
        assert.equal(artifacts.length, 1);
        assert.notEqual(path.resolve(artifacts[0].generationPath), path.resolve(finalPath));
        return { taskId: `publish-${name}` };
      }
    });
    if (options.errorCode || options.errorName) {
      await assert.rejects(invoke, (error) => (
        options.errorCode ? error.code === options.errorCode : error.name === options.errorName
      ));
    } else {
      const generated = await invoke();
      assert.equal(generated.publication.taskId, `publish-${name}`);
    }
    assert.equal(publisherCalls, options.errorCode || options.errorName ? 0 : 1);
    assert.equal(captures.length, 1);
    return captures[0];
  }

  const successRequest = await runCase('success');
  assert.equal(successRequest.production, false);
  assert.deepEqual(Object.keys(successRequest.context.value), [
    'taskRunId', 'taskKey', 'moduleId', 'parentRunId', 'operationKey'
  ]);
  assert.deepEqual(Object.keys(successRequest.input), [
    'schemaVersion', 'sources', 'operation', 'generation'
  ]);
  assert.deepEqual(Object.keys(successRequest.input.sources[0]), ['filePath', 'sourceSnapshot']);
  assert.deepEqual(Object.keys(successRequest.input.generation), [
    'outputId', 'outputArtifactKey', 'generationPath'
  ]);
  assert.equal(Object.hasOwn(baseResult.artifacts[0], 'generationPath'), false);
  assert.equal(Object.hasOwn(baseResult.artifacts[0], 'normalizedHeaders'), false);
  assert.equal(Object.hasOwn(baseResult.artifacts[0], 'warningSummary'), false);
  assert.equal(JSON.stringify(successRequest.input).includes(finalPath), false);
  assert.equal(fs.existsSync(finalPath), false, 'generation Worker/Main validator 均不得写正式目标');

  await runCase('ownership', (result) => {
    result.artifacts[0].outputArtifactKey = `output-${'b'.repeat(64)}`;
    return result;
  }, { errorCode: 'TOOLBOX_GENERATION_OWNERSHIP_MISMATCH' });
  await runCase('missing', (result, generationPath) => {
    fs.rmSync(generationPath, { force: true });
    return result;
  }, { errorCode: 'TOOLBOX_GENERATION_ARTIFACT_MISSING' });
  await runCase('evidence-missing', (result, _generationPath, evidencePath) => {
    fs.rmSync(evidencePath, { force: true });
    return result;
  }, { errorCode: 'TOOLBOX_GENERATION_EVIDENCE_MISSING' });
  await runCase('evidence-tamper', (result, _generationPath, evidencePath) => {
    const bytes = fs.readFileSync(evidencePath);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    fs.writeFileSync(evidencePath, bytes);
    return result;
  }, { errorCode: 'TOOLBOX_GENERATION_EVIDENCE_HASH_MISMATCH' });
  await runCase('tamper', (result, generationPath) => {
    const bytes = fs.readFileSync(generationPath);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    fs.writeFileSync(generationPath, bytes);
    return result;
  }, { errorCode: 'TOOLBOX_GENERATION_ARTIFACT_HASH_MISMATCH' });
  await runCase('business-mismatch', (result, _generationPath, evidencePath) => {
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.normalizedHeaders = ['Wrong', 'Headers'];
    const evidenceBytes = Buffer.from(JSON.stringify(evidence));
    fs.writeFileSync(evidencePath, evidenceBytes);
    result.artifacts[0].evidenceArtifact = {
      byteSize: evidenceBytes.length,
      sha256: crypto.createHash('sha256').update(evidenceBytes).digest('hex')
    };
    return result;
  }, { errorName: 'ToolboxOutputValidationError' });

  let failedPublisherCalls = 0;
  await assert.rejects(
    generateValidateAndPublish({
      runtime: {
        async execute() {
          return {
            outcome: 'failed',
            terminalSource: 'job:error',
            error: {
              code: 'TOOLBOX_GENERATION_FAILED',
              message: 'generation failed',
              stage: 'execute',
              detailLines: []
            }
          };
        }
      },
      actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
      filePlan,
      batchContext: batchContext('toolbox-generation-failure'),
      generationPath: path.join(dir, 'failed.xlsx'),
      operationConfig: { field: 'Group', values: ['A'] },
      production: false,
      publisher: async () => { failedPublisherCalls += 1; }
    }),
    (error) => error.code === 'TOOLBOX_GENERATION_FAILED'
  );
  assert.equal(failedPublisherCalls, 0);

  const zeroPath = path.join(dir, 'zero.xlsx');
  const zeroInput = createGenerationInput({
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
    filePlan,
    generationPath: zeroPath,
    operationConfig: { field: 'Group', values: ['missing'] }
  });
  const zeroResult = await executeSplitGeneration(zeroInput, new AbortController().signal);
  let zeroPublisherCalls = 0;
  await assert.rejects(
    generateValidateAndPublish({
      runtime: completedRuntime(zeroResult, []),
      actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
      filePlan,
      batchContext: batchContext('toolbox-zero-hit'),
      generationPath: zeroPath,
      operationConfig: { field: 'Group', values: ['missing'] },
      production: false,
      requireNonEmptySplit: true,
      publisher: async () => { zeroPublisherCalls += 1; }
    }),
    (error) => error.code === 'TOOLBOX_SPLIT_NO_MATCHES' &&
      error.message === '所选值在源文件中无匹配行，未生成文件'
  );
  assert.equal(zeroPublisherCalls, 0);

  const realGenerationPath = path.join(dir, 'real-worker-split.xlsx');
  const realRuntime = createBackgroundExecutionRuntime({ shutdownTimeoutMs: 10000 });
  let realPublisherCalls = 0;
  const realGenerated = await generateValidateAndPublish({
    runtime: realRuntime,
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
    filePlan,
    batchContext: batchContext('toolbox-real-worker-split'),
    generationPath: realGenerationPath,
    operationConfig: { field: 'Group', values: ['A'] },
    production: false,
    requireNonEmptySplit: true,
    publisher: async (artifacts) => {
      realPublisherCalls += 1;
      assert.equal(artifacts[0].matchedCount, 1);
      assert.deepEqual(artifacts[0].normalizedHeaders, ['Group', 'LongId']);
      return { taskId: 'real-worker-split-publication' };
    }
  });
  assert.equal(realGenerated.artifact.matchedCount, 1);
  assert.equal(realPublisherCalls, 1);
  const realShutdown = await realRuntime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(realShutdown.leakedTransports, []);
  assert.deepEqual(realShutdown.errors, []);
});

test('真实 native Worker 保持 merge 内容/格式等价、main-settlement 无 receipt 且 Main event loop 可推进', async () => {
  const dir = makeTempDir('toolbox-background-worker-');
  const first = await writeWorkbook(path.join(dir, 'first.xlsx'), [
    ['Name', 'LongId'],
    ['A', '001234567890123456789']
  ], { style: true });
  const secondRows = [['Name', 'LongId']];
  for (let index = 0; index < 2500; index += 1) {
    secondRows.push([`B-${index}`, String(index).padStart(21, '0')]);
  }
  const second = await writeWorkbook(path.join(dir, 'second.xlsx'), secondRows, { style: true });
  const finalPath = path.join(dir, 'final.xlsx');
  const filePlan = createFilePlan(
    [first, second],
    finalPath,
    TOOLBOX_GENERATION_ACTIONS.MERGE
  );
  const workerPath = path.join(dir, 'worker.xlsx');
  const legacyPath = path.join(dir, 'legacy.xlsx');
  const input = createGenerationInput({
    actionKey: TOOLBOX_GENERATION_ACTIONS.MERGE,
    filePlan,
    generationPath: workerPath,
    operationConfig: { sheetBaseName: 'COMMON' }
  });
  const runtime = createBackgroundExecutionRuntime({ shutdownTimeoutMs: 10000 });
  const context = {
    kind: 'operation',
    value: {
      taskRunId: 'native-merge-task',
      taskKey: 'task.toolbox:merge',
      moduleId: 'toolbox',
      parentRunId: 'native-merge-parent',
      operationKey: 'native-merge-operation'
    }
  };
  await assert.rejects(
    runtime.execute({
      actionKey: TOOLBOX_GENERATION_ACTIONS.MERGE,
      operationKey: context.value.operationKey,
      production: true,
      context,
      input
    }),
    (error) => error.code === 'POLICY_PRODUCTION_DISABLED'
  );

  let eventLoopTicks = 0;
  const timer = setInterval(() => { eventLoopTicks += 1; }, 2);
  const execution = await runtime.execute({
    actionKey: TOOLBOX_GENERATION_ACTIONS.MERGE,
    operationKey: context.value.operationKey,
    production: false,
    context,
    input
  });
  clearInterval(timer);
  assert.equal(execution.outcome, 'completed');
  assert.equal(execution.terminalSource, 'job:done');
  assert.equal(execution.receiptHint, null);
  assert.ok(eventLoopTicks >= 2, `native generation 期间 Main event loop 仅推进 ${eventLoopTicks} ticks`);
  assert.equal(validateToolboxGenerationResult(
    execution.result,
    TOOLBOX_GENERATION_ACTIONS.MERGE
  ), true);
  assert.equal(Object.hasOwn(execution.result.artifacts[0], 'generationPath'), false);
  assert.equal(JSON.stringify(execution.result).includes(workerPath), false);
  assert.doesNotThrow(() => assertFinanceSafeValue(execution.result));
  assert.equal(fs.existsSync(generationEvidencePath(workerPath)), true);

  const legacy = await mergeToolboxFilesToXlsx({
    filePaths: [first, second],
    savePath: legacyPath,
    sheetBaseName: 'COMMON'
  });
  assert.equal(execution.result.summary.outputDataRowCount, legacy.dataRowCount);
  assert.deepEqual(await workbookProjection(workerPath), await workbookProjection(legacyPath));
  assert.equal(fs.existsSync(finalPath), false);

  const report = await runtime.shutdown({ timeoutMs: 10000 });
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
});

test('quit shutdown 会取消在途 one-shot generation 并收净 transport/资源', async () => {
  const dir = makeTempDir('toolbox-background-cancel-');
  const rows = [['Group', 'Value']];
  for (let index = 0; index < 6000; index += 1) rows.push(['A', `value-${index}`]);
  const sourcePath = await writeWorkbook(path.join(dir, 'source.xlsx'), rows);
  const finalPath = path.join(dir, 'final.xlsx');
  const generationPath = path.join(dir, 'generation.xlsx');
  const filePlan = createFilePlan(
    [sourcePath],
    finalPath,
    TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE
  );
  const input = createGenerationInput({
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
    filePlan,
    generationPath,
    operationConfig: { field: 'Group', values: ['A'] }
  });
  const operationKey = 'native-split-shutdown';
  const runtime = createBackgroundExecutionRuntime({ shutdownTimeoutMs: 10000 });
  const executionPromise = runtime.execute({
    actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
    operationKey,
    production: false,
    context: {
      kind: 'operation',
      value: {
        taskRunId: 'native-split-task',
        taskKey: 'task.toolbox:split-single',
        moduleId: 'toolbox',
        parentRunId: 'native-split-parent',
        operationKey
      }
    },
    input
  });
  const report = await runtime.shutdown({ timeoutMs: 10000 });
  const execution = await executionPromise;
  assert.equal(execution.outcome, 'cancelled');
  assert.deepEqual(report.cancelledJobs, [execution.jobId]);
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.equal(fs.existsSync(generationPath), false);
  assert.equal(fs.existsSync(generationEvidencePath(generationPath)), false);
  assert.equal(fs.existsSync(finalPath), false);
});

test('Main runtime manager clean shutdown 并发可重入，rollback 后只懒创建一个替代 runtime', async () => {
  let factoryCalls = 0;
  let stopCalls = 0;
  let shutdownCalls = 0;
  let releaseShutdown;
  const pendingShutdown = new Promise((resolve) => { releaseShutdown = resolve; });
  const manager = createBackgroundExecutionRuntimeManager({
    runtimeFactory() {
      factoryCalls += 1;
      return {
        stopAcceptingNewJobs() { stopCalls += 1; },
        shutdown() {
          shutdownCalls += 1;
          return pendingShutdown.then(() => ({ leakedTransports: [], errors: [] }));
        }
      };
    }
  });
  assert.equal(manager.get(), manager.get());
  assert.equal(factoryCalls, 1);
  const first = manager.shutdown();
  const second = manager.shutdown();
  assert.equal(first, second);
  assert.equal(stopCalls, 1);
  assert.equal(shutdownCalls, 1);
  assert.throws(() => manager.get(), (error) => error.code === 'BACKGROUND_EXECUTION_RUNTIME_CLOSING');
  releaseShutdown();
  await first;
  assert.throws(() => manager.get(), (error) => error.code === 'BACKGROUND_EXECUTION_RUNTIME_CLOSING');
  assert.deepEqual(manager.snapshot(), {
    active: false,
    closing: true,
    shutdownPending: false
  });
  manager.resume();
  assert.equal(manager.get(), manager.get());
  assert.equal(factoryCalls, 2);
});

test('Main runtime manager incomplete shutdown 保留同一 owner，重试前 fail closed', async () => {
  let factoryCalls = 0;
  let stopCalls = 0;
  let shutdownCalls = 0;
  const runtime = {
    stopAcceptingNewJobs() { stopCalls += 1; },
    shutdown() {
      shutdownCalls += 1;
      if (shutdownCalls === 1) {
        return Promise.resolve({ leakedTransports: ['job-leak'], errors: [] });
      }
      return Promise.resolve({ leakedTransports: [], errors: [] });
    }
  };
  const manager = createBackgroundExecutionRuntimeManager({
    runtimeFactory() {
      factoryCalls += 1;
      return runtime;
    }
  });

  assert.equal(manager.get(), runtime);
  await manager.shutdown();
  assert.equal(factoryCalls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(shutdownCalls, 1);
  assert.throws(
    () => manager.resume(),
    (error) => error.code === 'BACKGROUND_EXECUTION_RUNTIME_SHUTDOWN_UNRESOLVED'
  );

  await manager.shutdown();
  assert.equal(factoryCalls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(shutdownCalls, 2);
  manager.resume();
});

test('Main runtime manager shutdown throw 保留 owner 并禁止 resume', async () => {
  let factoryCalls = 0;
  let shutdownCalls = 0;
  const runtime = {
    stopAcceptingNewJobs() {},
    shutdown() {
      shutdownCalls += 1;
      throw new Error('shutdown transport failed');
    }
  };
  const manager = createBackgroundExecutionRuntimeManager({
    runtimeFactory() {
      factoryCalls += 1;
      return runtime;
    }
  });

  manager.get();
  await assert.rejects(manager.shutdown(), /shutdown transport failed/);
  assert.throws(
    () => manager.resume(),
    (error) => error.code === 'BACKGROUND_EXECUTION_RUNTIME_SHUTDOWN_UNRESOLVED'
  );
  await assert.rejects(manager.shutdown(), /shutdown transport failed/);
  assert.equal(factoryCalls, 1);
  assert.equal(shutdownCalls, 2);
});

test('Main runtime manager no-runtime clean shutdown 允许 rollback 并在首次 get 创建', async () => {
  let factoryCalls = 0;
  const runtime = {};
  const manager = createBackgroundExecutionRuntimeManager({
    runtimeFactory() {
      factoryCalls += 1;
      return runtime;
    }
  });

  const report = await manager.shutdown();
  assert.deepEqual(report.leakedTransports, []);
  assert.deepEqual(report.errors, []);
  assert.equal(factoryCalls, 0);
  assert.equal(manager.snapshot().closing, true);
  manager.resume();
  assert.equal(manager.snapshot().closing, false);
  assert.equal(manager.get(), runtime);
  assert.equal(factoryCalls, 1);
});
