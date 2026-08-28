'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { fromProtocolError } = require('../background-execution/error-codec');
const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const {
  assertFilePlanFresh,
  normalizeFilePlanV1
} = require('../archive-center/file-plan');
const { freezeWorkerBatchContext } = require('../archive-center/worker-batch-context');
const { pathsAlias } = require('../toolbox-target-identity');
const { publishVccFinancialOpOutputs } = require('../vcc-financial-op-output-recovery');
const {
  assertVccExportAuthorityEqual
} = require('./authority');
const {
  loadValidationContext,
  validateVccSubjectArtifact
} = require('./artifact-evidence');
const {
  VCC_EXPORT_SINGLE_ACTION,
  VCC_EXPORT_SUBJECTS_ACTION,
  validateVccExportSingleResult,
  validateVccExportSubjectsResult
} = require('./policies');

const VCC_EXPORT_SOURCE_OPERATION = 'vccFinancialOp:export:result';
const VCC_EXPORT_RECOVERY_PATH_LIMIT = 100;
const VCC_EXPORT_CLEANUP_DIAGNOSTIC_LIMIT = 8;
const UUID_TOKEN_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function dispatchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw dispatchError(code, `${label} exact keys 非法`);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeRecoveryPaths(error, generationPaths) {
  const merged = [];
  const seen = new Set();
  const candidates = [
    ...generationPaths,
    ...(Array.isArray(error.recoveryPaths) ? error.recoveryPaths : [])
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    merged.push(candidate);
    if (merged.length >= VCC_EXPORT_RECOVERY_PATH_LIMIT) break;
  }
  error.recoveryPaths = merged;
}

function appendCleanupDiagnostics(error, failures) {
  if (failures.length === 0 || !error || typeof error !== 'object') return;
  const additions = [
    `VCC task-private cleanup 未完成：${failures.length} 项`
  ];
  for (const failure of failures.slice(0, VCC_EXPORT_CLEANUP_DIAGNOSTIC_LIMIT)) {
    const code = failure && failure.code && /^[A-Z0-9_]+$/.test(failure.code)
      ? failure.code
      : 'UNKNOWN';
    additions.push(`VCC task-private cleanup error：${code}`);
  }
  error.detailLines = [
    ...(Array.isArray(error.detailLines) ? error.detailLines : []),
    ...additions
  ];
}

function cleanupGenerationArtifacts(generations, error) {
  const cleanupPaths = new Set();
  const failures = [];
  const patternsByDirectory = new Map();
  for (const item of generations) {
    const generationPath = item.generationPath;
    cleanupPaths.add(generationPath);
    const directory = path.dirname(generationPath);
    const patterns = patternsByDirectory.get(directory) || [];
    patterns.push(new RegExp(
      `^${escapeRegExp(path.basename(generationPath))}\\.${UUID_TOKEN_PATTERN}\\.tmp$`
    ));
    patternsByDirectory.set(directory, patterns);
  }
  for (const [directory, patterns] of patternsByDirectory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (scanError) {
      failures.push(scanError);
      continue;
    }
    for (const entry of entries) {
      if (patterns.some((pattern) => pattern.test(entry.name))) {
        cleanupPaths.add(path.join(directory, entry.name));
      }
    }
  }
  for (const cleanupPath of cleanupPaths) {
    try { fs.rmSync(cleanupPath, { force: true }); } catch (cleanupError) {
      failures.push(cleanupError);
    }
  }
  appendCleanupDiagnostics(error, failures);
}

function freezeTaskAuthority(value, batchContext) {
  exactKeys(
    value,
    ['action', 'taskGeneration', 'taskRunId'],
    'VCC_EXPORT_TASK_AUTHORITY_INVALID',
    'VCC export task authority'
  );
  if (value.action !== 'export-result' ||
      !Number.isSafeInteger(value.taskGeneration) || value.taskGeneration < 0 ||
      value.taskRunId !== batchContext.taskRunId) {
    throw dispatchError(
      'VCC_EXPORT_TASK_AUTHORITY_INVALID',
      'VCC export activeTask/taskGeneration/taskRunId authority 非法'
    );
  }
  return Object.freeze({
    action: value.action,
    taskGeneration: value.taskGeneration,
    taskRunId: value.taskRunId
  });
}

function assertTaskAuthorityEqual(expected, actual) {
  if (canonicalSha256(expected) !== canonicalSha256(actual)) {
    throw dispatchError(
      'VCC_EXPORT_TASK_AUTHORITY_STALE',
      'VCC export activeTask/taskGeneration authority 已变化'
    );
  }
}

function freezeBatchAuthority(options) {
  let batchContext;
  try {
    batchContext = freezeWorkerBatchContext(options.batchContext, { required: true });
  } catch (_error) {
    throw dispatchError('VCC_EXPORT_BATCH_CONTEXT_INVALID', 'VCC export 缺少 exact batch authority');
  }
  if (batchContext.moduleId !== 'vcc-financial-op' ||
      batchContext.taskKey !== VCC_EXPORT_SOURCE_OPERATION ||
      (options.operationKey !== undefined && options.operationKey !== batchContext.operationKey)) {
    throw dispatchError(
      'VCC_EXPORT_BATCH_CONTEXT_INVALID',
      'VCC export batch/action/operation authority 不一致'
    );
  }
  return Object.freeze({
    batchContext,
    context: Object.freeze({
      kind: 'operation',
      value: Object.freeze({
        taskRunId: batchContext.taskRunId,
        taskKey: batchContext.taskKey,
        moduleId: batchContext.moduleId,
        parentRunId: batchContext.parentRunId,
        operationKey: batchContext.operationKey
      })
    })
  });
}

function canonicalFilePlan(filePlan, outputCount) {
  if (!filePlan || filePlan.version !== 1 || filePlan.allocation !== 'eager' ||
      !Array.isArray(filePlan.inputs) || filePlan.inputs.length !== 0 ||
      !Array.isArray(filePlan.outputs) || filePlan.outputs.length !== outputCount ||
      Object.keys(filePlan).sort().join(',') !== 'allocation,inputs,outputs,version') {
    throw dispatchError('VCC_EXPORT_FILE_PLAN_INVALID', 'VCC export FilePlan set 非法');
  }
  let canonical;
  try { canonical = normalizeFilePlanV1(filePlan); } catch (_error) {
    throw dispatchError('VCC_EXPORT_FILE_PLAN_INVALID', 'VCC export FilePlan identity 非法');
  }
  const expectedOutputKeys = [
    'aliasKey', 'artifactKey', 'direction', 'filePath', 'originalName',
    'role', 'sourceOperation', 'targetSnapshot'
  ].sort().join(',');
  for (let index = 0; index < canonical.outputs.length; index += 1) {
    const supplied = filePlan.outputs[index];
    const output = canonical.outputs[index];
    if (Object.keys(supplied).sort().join(',') !== expectedOutputKeys ||
        supplied.direction !== 'output' || supplied.role !== 'output' ||
        supplied.sourceOperation !== VCC_EXPORT_SOURCE_OPERATION ||
        path.extname(output.filePath).toLowerCase() !== '.xlsx' ||
        canonicalSha256(supplied) !== canonicalSha256(output)) {
      throw dispatchError(
        'VCC_EXPORT_FILE_PLAN_INVALID',
        'VCC export FilePlan set/order/target snapshot 已变化'
      );
    }
  }
  return canonical;
}

function assertStagingDirectory(stagingDirectory) {
  const resolved = path.resolve(String(stagingDirectory || ''));
  if (resolved !== stagingDirectory) {
    throw dispatchError('VCC_EXPORT_STAGING_INVALID', 'VCC task-private staging 必须是规范绝对路径');
  }
  let stat;
  try { stat = fs.lstatSync(resolved); } catch (_error) {
    throw dispatchError('VCC_EXPORT_STAGING_INVALID', 'VCC task-private staging 不存在');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw dispatchError('VCC_EXPORT_STAGING_INVALID', 'VCC task-private staging 必须是真实目录');
  }
  return resolved;
}

function selectedIndexesForAction(actionKey, authority, value) {
  if (actionKey === VCC_EXPORT_SUBJECTS_ACTION) {
    const expected = authority.subjects.map((_subject, index) => index);
    if (value !== undefined && canonicalSha256(value) !== canonicalSha256(expected)) {
      throw dispatchError('VCC_EXPORT_SUBJECT_COVERAGE_INVALID', 'export-subjects 必须唯一覆盖全部 subjectIndex');
    }
    return Object.freeze(expected);
  }
  if (actionKey !== VCC_EXPORT_SINGLE_ACTION || !Array.isArray(value) || value.length !== 1 ||
      !Number.isSafeInteger(value[0]) || value[0] < 0 || value[0] >= authority.subjects.length) {
    throw dispatchError('VCC_EXPORT_SUBJECT_COVERAGE_INVALID', 'export-single 必须选择 exact-one subjectIndex');
  }
  return Object.freeze([value[0]]);
}

function createGenerationInput({
  actionKey,
  authority,
  filePlan,
  selectedSubjectIndexes,
  stagingDirectory,
  taskAuthority
}) {
  const stagingRoot = assertStagingDirectory(stagingDirectory);
  const plan = canonicalFilePlan(filePlan, selectedSubjectIndexes.length);
  const generations = selectedSubjectIndexes.map((subjectIndex, outputIndex) => {
    const subject = authority.subjects[subjectIndex];
    const generationPath = path.join(
      stagingRoot,
      `${String(outputIndex).padStart(3, '0')}-${subject.subjectDigest.slice(0, 16)}.xlsx`
    );
    if (fs.existsSync(generationPath)) {
      throw dispatchError('VCC_EXPORT_STAGING_COLLISION', 'VCC generation path 已被占用');
    }
    for (const output of plan.outputs) {
      if (pathsAlias(fs, generationPath, output.filePath, {
        allowMissingParentLexicalFallback: true
      })) {
        throw dispatchError('VCC_EXPORT_PATH_ALIAS', 'VCC generation path 不能与正式目标别名');
      }
    }
    return Object.freeze({
      subjectIndex,
      outputArtifactKey: plan.outputs[outputIndex].artifactKey,
      generationPath
    });
  });
  return Object.freeze({
    contractVersion: 1,
    authority,
    task: taskAuthority,
    generations: Object.freeze(generations),
    actionKey,
    filePlan: plan,
    stagingRoot
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function validateJoin({ generation, executionResult, snapshot, assetsDir }) {
  const validator = generation.actionKey === VCC_EXPORT_SINGLE_ACTION
    ? validateVccExportSingleResult
    : validateVccExportSubjectsResult;
  if (!validator(executionResult) || executionResult.authorityDigest !== generation.authority.authorityDigest ||
      executionResult.runId !== generation.authority.runId ||
      executionResult.targetMonth !== generation.authority.targetMonth ||
      executionResult.resultRevision !== generation.authority.resultRevision ||
      executionResult.inputFingerprint !== generation.authority.inputFingerprint ||
      executionResult.archiveStateDigest !== generation.authority.archiveStateDigest ||
      canonicalSha256(executionResult.task) !== canonicalSha256(generation.task) ||
      executionResult.artifacts.length !== generation.generations.length) {
    throw dispatchError('VCC_EXPORT_MANIFEST_AUTHORITY_MISMATCH', 'VCC Worker manifest authority 不一致');
  }
  const validationContext = await loadValidationContext(assetsDir);
  const realStagingRoot = fs.realpathSync(generation.stagingRoot);
  const artifacts = [];
  for (let index = 0; index < generation.generations.length; index += 1) {
    const expected = generation.generations[index];
    const claimed = executionResult.artifacts[index];
    const subjectAuthority = generation.authority.subjects[expected.subjectIndex];
    const output = generation.filePlan.outputs[index];
    if (claimed.subjectIndex !== expected.subjectIndex ||
        claimed.outputArtifactKey !== expected.outputArtifactKey ||
        claimed.outputArtifactKey !== output.artifactKey ||
        claimed.subjectDigest !== subjectAuthority.subjectDigest ||
        claimed.businessDigest !== subjectAuthority.businessDigest ||
        claimed.resultRowCount !== subjectAuthority.resultRowCount ||
        claimed.pendingRowCount !== subjectAuthority.pendingRowCount) {
      throw dispatchError('VCC_EXPORT_ARTIFACT_ORDER_MISMATCH', 'VCC artifact subjectIndex/set/order 不一致');
    }
    let stat;
    try { stat = fs.lstatSync(expected.generationPath); } catch (_error) {
      throw dispatchError('VCC_EXPORT_ARTIFACT_MISSING', 'VCC generation artifact 不存在');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== claimed.byteSize ||
        fs.realpathSync(expected.generationPath) !==
          path.join(realStagingRoot, path.basename(expected.generationPath)) ||
        generation.filePlan.outputs.some((candidate) => pathsAlias(
          fs,
          expected.generationPath,
          candidate.filePath,
          { allowMissingParentLexicalFallback: true }
        ))) {
      throw dispatchError('VCC_EXPORT_ARTIFACT_IDENTITY_INVALID', 'VCC generation path/size/alias 非法');
    }
    // eslint-disable-next-line no-await-in-loop
    if (await sha256File(expected.generationPath) !== claimed.sha256) {
      throw dispatchError('VCC_EXPORT_ARTIFACT_HASH_MISMATCH', 'VCC generation artifact SHA-256 不一致');
    }
    // eslint-disable-next-line no-await-in-loop
    const business = await validateVccSubjectArtifact({
      artifactPath: expected.generationPath,
      snapshot,
      subjectIndex: expected.subjectIndex,
      validationContext
    });
    if (canonicalSha256(business) !== canonicalSha256({
      subjectIndex: claimed.subjectIndex,
      subjectDigest: claimed.subjectDigest,
      businessDigest: claimed.businessDigest,
      resultRowCount: claimed.resultRowCount,
      pendingRowCount: claimed.pendingRowCount
    })) {
      throw dispatchError('VCC_EXPORT_BUSINESS_EVIDENCE_MISMATCH', 'VCC artifact 业务回读不一致');
    }
    artifacts.push(Object.freeze({
      ...business,
      outputArtifactKey: claimed.outputArtifactKey,
      generationPath: expected.generationPath,
      targetPath: output.filePath,
      targetSnapshot: output.targetSnapshot,
      byteSize: claimed.byteSize,
      sha256: claimed.sha256
    }));
  }
  return Object.freeze(artifacts);
}

async function generateValidateAndPublishVccExport(options = {}) {
  if (![VCC_EXPORT_SINGLE_ACTION, VCC_EXPORT_SUBJECTS_ACTION].includes(options.actionKey)) {
    throw new TypeError('VCC one-shot export actionKey 非法');
  }
  if (!options.runtime || typeof options.runtime.execute !== 'function' ||
      typeof options.readCurrentSnapshot !== 'function' ||
      typeof options.readCurrentTaskAuthority !== 'function') {
    throw new TypeError('VCC one-shot export 缺少 runtime/authority reader');
  }
  const { batchContext, context } = freezeBatchAuthority(options);
  const taskA = freezeTaskAuthority(await options.readCurrentTaskAuthority(), batchContext);
  const snapshotA = await options.readCurrentSnapshot();
  assertVccExportAuthorityEqual(options.expectedAuthority, snapshotA.authority);
  const selectedSubjectIndexes = selectedIndexesForAction(
    options.actionKey,
    snapshotA.authority,
    options.selectedSubjectIndexes
  );
  const generation = createGenerationInput({
    actionKey: options.actionKey,
    authority: snapshotA.authority,
    filePlan: options.filePlan,
    selectedSubjectIndexes,
    stagingDirectory: options.stagingDirectory,
    taskAuthority: taskA
  });
  try {
    const execution = await options.runtime.execute({
      actionKey: options.actionKey,
      operationKey: batchContext.operationKey,
      production: false,
      context,
      input: {
        contractVersion: generation.contractVersion,
        authority: generation.authority,
        task: generation.task,
        generations: generation.generations
      }
    });
    if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
      if (execution && execution.error) throw fromProtocolError(execution.error);
      throw dispatchError('VCC_EXPORT_GENERATION_FAILED', 'VCC one-shot Writer generation 失败');
    }
    const taskB = freezeTaskAuthority(await options.readCurrentTaskAuthority(), batchContext);
    assertTaskAuthorityEqual(taskA, taskB);
    const snapshotB = await options.readCurrentSnapshot();
    assertVccExportAuthorityEqual(snapshotA.authority, snapshotB.authority);
    const artifacts = await validateJoin({
      generation,
      executionResult: execution.result,
      snapshot: snapshotB,
      assetsDir: options.assetsDir
    });
    const finalPlan = canonicalFilePlan(options.filePlan, artifacts.length);
    assertFilePlanFresh(finalPlan);
    const taskBeforePublish = freezeTaskAuthority(
      await options.readCurrentTaskAuthority(),
      batchContext
    );
    assertTaskAuthorityEqual(taskA, taskBeforePublish);
    const snapshotBeforePublish = await options.readCurrentSnapshot();
    assertVccExportAuthorityEqual(snapshotA.authority, snapshotBeforePublish.authority);
    const publication = await publishVccFinancialOpOutputs({
      batchContext,
      generationFilePaths: artifacts.map((artifact) => artifact.generationPath),
      expectedArtifacts: artifacts.map((artifact) => Object.freeze({
        byteSize: artifact.byteSize,
        sha256: artifact.sha256
      })),
      targetFilePaths: artifacts.map((artifact) => artifact.targetPath),
      targetSnapshots: artifacts.map((artifact) => artifact.targetSnapshot),
      publishPublication: options.publishPublication,
      recoverPublications: options.recoverPublications,
      recoverIntoArchive: options.recoverIntoArchive,
      userDataDir: options.userDataDir,
      archiveCenter: options.archiveCenter,
      settleManifestArtifacts: options.settleManifestArtifacts
    });
    return Object.freeze({
      actionKey: options.actionKey,
      runId: snapshotA.authority.runId,
      targetMonth: snapshotA.authority.targetMonth,
      resultRevision: snapshotA.authority.resultRevision,
      filePaths: Object.freeze(artifacts.map((artifact) => artifact.targetPath)),
      artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze({
        subjectIndex: artifact.subjectIndex,
        subjectDigest: artifact.subjectDigest,
        businessDigest: artifact.businessDigest,
        resultRowCount: artifact.resultRowCount,
        pendingRowCount: artifact.pendingRowCount,
        outputArtifactKey: artifact.outputArtifactKey,
        targetPath: artifact.targetPath,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256
      }))),
      publication
    });
  } catch (error) {
    if (error && error.preserveTemporaryFiles === true) {
      mergeRecoveryPaths(
        error,
        generation.generations.map((item) => item.generationPath)
      );
    } else {
      cleanupGenerationArtifacts(generation.generations, error);
    }
    throw error;
  }
}

module.exports = {
  VCC_EXPORT_SOURCE_OPERATION,
  canonicalFilePlan,
  createGenerationInput,
  freezeBatchAuthority,
  freezeTaskAuthority,
  generateValidateAndPublishVccExport,
  selectedIndexesForAction,
  validateJoin
};
