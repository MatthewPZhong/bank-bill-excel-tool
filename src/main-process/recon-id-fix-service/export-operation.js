'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { fromProtocolError } = require('../background-execution/error-codec');
const { canonicalJsonSnapshot } = require('../background-execution/protocol-validator');
const { normalizeFilePlanV1 } = require('../archive-center/file-plan');
const { publishToolboxPublicationAsync } = require('../toolbox-output-publication-dispatch');
const { pathsAlias } = require('../toolbox-target-identity');
const { freezeWorkerBatchContext } = require('../archive-center/worker-batch-context');
const { readReconFixArtifactEvidence } = require('./artifact-evidence');
const { reconFixEvidenceSha256 } = require('./evidence-projection');
const {
  assertReconFixEvidenceSettlementAdmission
} = require('./evidence-settlement-admission');
const {
  RECON_FIX_EXPORT_ACTION,
  validateReconFixExportAuthority,
  validateReconFixExportResult,
  validateReconFixJpmResult,
  validateReconFixServiceResult
} = require('./policies');

const RECON_FIX_EXPORT_SOURCE_OPERATION = 'recon-id-fix:export';

function exportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function exactResultReference(result) {
  const isReadonlyResult = validateReconFixServiceResult(result) && result.kind === 'readonly-result';
  const isJpmResult = validateReconFixJpmResult(result);
  const summary = result && result.kind === 'readonly-result'
    ? result.summary
    : result && result.boundedSummary;
  if ((!isReadonlyResult && !isJpmResult) ||
      !Number.isSafeInteger(result.serviceGeneration) || result.serviceGeneration < 1 ||
      !Number.isSafeInteger(result.revision) || result.revision < 1 ||
      typeof result.resultHandle !== 'string' || !/^[a-f0-9]{64}$/.test(result.resultHandle) ||
      !validateReconFixExportAuthority(result.exportAuthority) ||
      !summary || !Number.isSafeInteger(summary.fixedRowCount) || summary.fixedRowCount < 0 ||
      !Number.isSafeInteger(summary.unmatchedRowCount) || summary.unmatchedRowCount < 0 ||
      summary.fixedRowCount + summary.unmatchedRowCount < 1) {
    throw exportError('RECON_FIX_EXPORT_RESULT_REFERENCE_INVALID', 'ReconFix export 缺少 exact result identity/revision');
  }
  const authority = canonicalJsonSnapshot(result.exportAuthority);
  const { authorityDigest, ...authorityBody } = authority;
  if (authority.resultHandle !== result.resultHandle ||
      authorityDigest !== reconFixEvidenceSha256(authorityBody)) {
    throw exportError(
      'RECON_FIX_EXPORT_RESULT_REFERENCE_INVALID',
      'ReconFix export authority 未绑定 exact result handle/digest'
    );
  }
  return Object.freeze({
    serviceGeneration: result.serviceGeneration,
    revision: result.revision,
    resultHandle: result.resultHandle,
    fixedRowCount: summary.fixedRowCount,
    unmatchedRowCount: summary.unmatchedRowCount,
    authority
  });
}

function freezeReconFixExportBatchAuthority(options) {
  let batchContext;
  try {
    batchContext = freezeWorkerBatchContext(options.batchContext, { required: true });
  } catch (_error) {
    throw exportError('RECON_FIX_EXPORT_BATCH_CONTEXT_INVALID', 'ReconFix export 缺少 exact batch authority');
  }
  if (batchContext.moduleId !== 'recon-fix' ||
      batchContext.taskKey !== RECON_FIX_EXPORT_SOURCE_OPERATION) {
    throw exportError(
      'RECON_FIX_EXPORT_BATCH_CONTEXT_INVALID',
      'ReconFix export batch authority 的 action/task/module 不一致'
    );
  }
  const context = Object.freeze({
    kind: 'operation',
    value: Object.freeze({
      taskRunId: batchContext.taskRunId,
      taskKey: batchContext.taskKey,
      moduleId: batchContext.moduleId,
      parentRunId: batchContext.parentRunId,
      operationKey: batchContext.operationKey
    })
  });
  if ((options.operationKey !== undefined && options.operationKey !== batchContext.operationKey) ||
      (options.context !== undefined && !isDeepStrictEqual(options.context, context))) {
    throw exportError(
      'RECON_FIX_EXPORT_BATCH_CONTEXT_INVALID',
      'ReconFix export runtime identity 与 batch authority 不一致'
    );
  }
  return Object.freeze({ batchContext, context, operationKey: batchContext.operationKey });
}

function exactRuntimeEvidenceSettlementAdmission(options, runtime) {
  const owned = assertReconFixEvidenceSettlementAdmission(
    runtime.reconFixEvidenceSettlementAdmission
  );
  const supplied = assertReconFixEvidenceSettlementAdmission(
    options.evidenceSettlementAdmission
  );
  if (supplied !== owned) {
    throw exportError(
      'RECON_FIX_EVIDENCE_SETTLEMENT_OWNER_MISMATCH',
      'ReconFix export evidence admission 不属于当前 Main/runtime owner'
    );
  }
  return owned;
}

function assertStagingDirectory(stagingDirectory) {
  const resolved = path.resolve(String(stagingDirectory || ''));
  if (resolved !== stagingDirectory) {
    throw exportError('RECON_FIX_EXPORT_STAGING_INVALID', 'task-private staging 必须是规范绝对路径');
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw exportError('RECON_FIX_EXPORT_STAGING_INVALID', 'task-private staging 必须是真实普通目录');
  }
  return resolved;
}

function expectedArtifactKinds(reference) {
  const kinds = [];
  if (reference.fixedRowCount > 0) kinds.push('main');
  if (reference.unmatchedRowCount > 0) kinds.push('unmatched');
  return kinds;
}

function canonicalReconFixFilePlan(filePlan, expectedKinds) {
  if (!filePlan || filePlan.version !== 1 || filePlan.allocation !== 'eager' ||
      !Array.isArray(filePlan.inputs) || filePlan.inputs.length !== 0 ||
      !Array.isArray(filePlan.outputs) || filePlan.outputs.length !== expectedKinds.length ||
      Object.keys(filePlan).sort().join(',') !== 'allocation,inputs,outputs,version') {
    throw exportError('RECON_FIX_EXPORT_FILE_PLAN_INVALID', 'ReconFix export FilePlan artifact set 非法');
  }
  let canonical;
  try {
    canonical = normalizeFilePlanV1(filePlan);
  } catch (_error) {
    throw exportError('RECON_FIX_EXPORT_FILE_PLAN_INVALID', 'ReconFix export FilePlan 路径身份非法');
  }
  const expectedOutputKeys = [
    'aliasKey', 'artifactKey', 'direction', 'filePath', 'originalName',
    'role', 'sourceOperation', 'targetSnapshot'
  ].sort().join(',');
  for (let index = 0; index < canonical.outputs.length; index += 1) {
    const supplied = filePlan.outputs[index];
    const normalized = canonical.outputs[index];
    if (Object.keys(supplied).sort().join(',') !== expectedOutputKeys ||
        supplied.direction !== 'output' || supplied.role !== 'output' ||
        supplied.sourceOperation !== RECON_FIX_EXPORT_SOURCE_OPERATION ||
        supplied.filePath !== normalized.filePath ||
        supplied.originalName !== normalized.originalName ||
        supplied.aliasKey !== normalized.aliasKey ||
        supplied.artifactKey !== normalized.artifactKey ||
        JSON.stringify(supplied.targetSnapshot) !== JSON.stringify(normalized.targetSnapshot)) {
      throw exportError(
        'RECON_FIX_EXPORT_FILE_PLAN_INVALID',
        'ReconFix export FilePlan ownership/alias/snapshot 已变化'
      );
    }
  }
  return canonical;
}

function freezeReconFixArtifactBindings(artifactBindings, filePlan, authority) {
  if (!Array.isArray(artifactBindings) ||
      artifactBindings.length !== authority.artifacts.length) {
    throw exportError(
      'RECON_FIX_EXPORT_ARTIFACT_BINDING_INVALID',
      'ReconFix export 缺少 exact Main-owned artifact binding'
    );
  }
  const expectedKeys = 'artifactKind,outputArtifactKey,targetPath';
  return Object.freeze(artifactBindings.map((binding, index) => {
    const expectedArtifact = authority.artifacts[index];
    const output = filePlan.outputs[index];
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).sort().join(',') !== expectedKeys ||
        binding.artifactKind !== expectedArtifact.artifactKind ||
        binding.outputArtifactKey !== output.artifactKey ||
        binding.targetPath !== output.filePath) {
      throw exportError(
        'RECON_FIX_EXPORT_ARTIFACT_BINDING_INVALID',
        'ReconFix export artifact kind/key/target binding 与 FilePlan 不一致'
      );
    }
    return Object.freeze({
      artifactKind: binding.artifactKind,
      outputArtifactKey: binding.outputArtifactKey,
      targetPath: binding.targetPath
    });
  }));
}

function createReconFixExportInputFromReference({
  artifactBindings,
  filePlan,
  stagingDirectory
}, reference) {
  const stagingRoot = assertStagingDirectory(stagingDirectory);
  const kinds = expectedArtifactKinds(reference);
  const canonicalFilePlan = canonicalReconFixFilePlan(filePlan, kinds);
  const bindings = freezeReconFixArtifactBindings(
    artifactBindings,
    canonicalFilePlan,
    reference.authority
  );
  const artifacts = bindings.map((binding, outputIndex) => {
    const artifactKind = binding.artifactKind;
    const generationPath = path.join(
      stagingRoot,
      `${String(outputIndex).padStart(3, '0')}-${artifactKind}.xlsx`
    );
    for (const output of canonicalFilePlan.outputs) {
      if (pathsAlias(fs, generationPath, output.filePath, {
        allowMissingParentLexicalFallback: true
      })) {
        throw exportError('RECON_FIX_EXPORT_PATH_ALIAS', 'task-private artifact 不能与正式目标别名重合');
      }
    }
    return Object.freeze({
      outputIndex,
      artifactKind,
      outputArtifactKey: binding.outputArtifactKey,
      generationPath
    });
  });
  return Object.freeze({
    expectedServiceGeneration: reference.serviceGeneration,
    expectedRevision: reference.revision,
    expectedExportAuthorityDigest: reference.authority.authorityDigest,
    resultHandle: reference.resultHandle,
    stagingDirectory: stagingRoot,
    artifacts: Object.freeze(artifacts)
  });
}

function createReconFixExportInput(options) {
  return createReconFixExportInputFromReference(options, exactResultReference(options.result));
}

function assertCurrentEvidence(reference, currentEvidence) {
  const authority = reference.authority;
  if (!currentEvidence ||
      Object.keys(currentEvidence).sort().join(',') !== [
        'inputEvidenceHash', 'linkedEvidenceHash', 'resultHandle', 'revision',
        'scenarioSnapshotHash', 'serviceGeneration'
      ].sort().join(',') ||
      currentEvidence.serviceGeneration !== reference.serviceGeneration ||
      currentEvidence.revision !== reference.revision ||
      currentEvidence.resultHandle !== reference.resultHandle) {
    throw exportError('RECON_FIX_EXPORT_RESULT_STALE', 'Main Join 发现 Service result identity/revision 已变化');
  }
  if (currentEvidence.inputEvidenceHash !== authority.inputEvidenceHash) {
    throw exportError('RECON_FIX_EXPORT_INPUT_EVIDENCE_STALE', 'Main Join 发现 input evidence 已变化');
  }
  if (currentEvidence.scenarioSnapshotHash !== authority.scenarioSnapshotHash) {
    throw exportError('RECON_FIX_EXPORT_SCENARIO_STALE', 'Main Join 发现 scenario evidence 已变化');
  }
  if (currentEvidence.linkedEvidenceHash !== authority.linkedEvidenceHash) {
    throw exportError('RECON_FIX_EXPORT_LINKED_EVIDENCE_STALE', 'Main Join 发现 linked evidence 已变化');
  }
}

async function validateReconFixExportJoin({
  artifactBindings,
  filePlan,
  generationInput,
  reference,
  result
}) {
  if (!validateReconFixExportResult(result)) {
    throw exportError('RECON_FIX_EXPORT_MANIFEST_INVALID', 'ReconFix Worker artifact manifest 非法');
  }
  const authority = reference.authority;
  if (result.serviceGeneration !== generationInput.expectedServiceGeneration ||
      result.revision !== generationInput.expectedRevision ||
      result.resultHandle !== generationInput.resultHandle ||
      result.serviceGeneration !== reference.serviceGeneration ||
      result.revision !== reference.revision ||
      result.resultHandle !== reference.resultHandle) {
    throw exportError('RECON_FIX_EXPORT_RESULT_STALE', 'Main Join 的 Worker result identity/revision 与请求不一致');
  }
  if (generationInput.expectedExportAuthorityDigest !== authority.authorityDigest ||
      result.exportAuthorityDigest !== authority.authorityDigest ||
      result.runKind !== authority.runKind || result.subMode !== authority.subMode ||
      result.inputEvidenceHash !== authority.inputEvidenceHash ||
      result.scenarioSnapshotHash !== authority.scenarioSnapshotHash ||
      result.linkedEvidenceHash !== authority.linkedEvidenceHash ||
      result.summary.fixedRowCount !== authority.fixedRowCount ||
      result.summary.unmatchedRowCount !== authority.unmatchedRowCount ||
      result.summary.warningCount !== authority.warningCount ||
      result.summary.resultDigest !== authority.resultDigest ||
      result.summary.artifactCount !== authority.artifacts.length) {
    throw exportError(
      'RECON_FIX_EXPORT_AUTHORITY_MISMATCH',
      'Main Join 的 Worker manifest 与 generation 前 authority 不一致'
    );
  }
  if (generationInput.artifacts.length !== result.artifacts.length) {
    throw exportError('RECON_FIX_EXPORT_FILE_PLAN_INVALID', 'Main Join 的 FilePlan artifact set 不一致');
  }
  const expectedKinds = generationInput.artifacts.map((artifact) => artifact.artifactKind);
  const canonicalFilePlan = canonicalReconFixFilePlan(filePlan, expectedKinds);
  const bindings = freezeReconFixArtifactBindings(
    artifactBindings,
    canonicalFilePlan,
    authority
  );
  const stagingRoot = assertStagingDirectory(generationInput.stagingDirectory);
  const realStagingRoot = fs.realpathSync(stagingRoot);
  const validated = [];
  for (let index = 0; index < result.artifacts.length; index += 1) {
    const artifact = result.artifacts[index];
    const expected = generationInput.artifacts[index];
    const output = canonicalFilePlan.outputs[index];
    const binding = bindings[index];
    const expectedBusiness = authority.artifacts[index];
    if (artifact.outputIndex !== index || artifact.artifactKind !== expected.artifactKind ||
        artifact.artifactKind !== expectedBusiness.artifactKind ||
        artifact.artifactKind !== binding.artifactKind ||
        artifact.outputArtifactKey !== expected.outputArtifactKey ||
        artifact.outputArtifactKey !== binding.outputArtifactKey ||
        artifact.outputArtifactKey !== output.artifactKey ||
        binding.targetPath !== output.filePath ||
        path.dirname(expected.generationPath) !== stagingRoot) {
      throw exportError('RECON_FIX_EXPORT_ARTIFACT_ORDER_MISMATCH', 'Main Join 的 artifact set/order/ownership 不一致');
    }
    let stat;
    try { stat = fs.lstatSync(expected.generationPath); } catch (_error) {
      throw exportError('RECON_FIX_EXPORT_ARTIFACT_MISSING', 'ReconFix staging artifact 不存在');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== artifact.byteSize ||
        fs.realpathSync(expected.generationPath) !==
          path.join(realStagingRoot, path.basename(expected.generationPath)) ||
        canonicalFilePlan.outputs.some((candidate) => pathsAlias(
          fs,
          expected.generationPath,
          candidate.filePath,
          { allowMissingParentLexicalFallback: true }
        ))) {
      throw exportError('RECON_FIX_EXPORT_ARTIFACT_IDENTITY_INVALID', 'ReconFix staging artifact path/size/alias 非法');
    }
    for (let previous = 0; previous < index; previous += 1) {
      if (pathsAlias(fs, expected.generationPath, generationInput.artifacts[previous].generationPath, {
        allowMissingParentLexicalFallback: true
      })) {
        throw exportError('RECON_FIX_EXPORT_ARTIFACT_IDENTITY_INVALID', 'ReconFix staging artifacts 互相别名冲突');
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const sha256 = await hashFile(expected.generationPath);
    if (sha256 !== artifact.sha256) {
      throw exportError('RECON_FIX_EXPORT_ARTIFACT_HASH_MISMATCH', 'ReconFix staging artifact SHA-256 不一致');
    }
    // eslint-disable-next-line no-await-in-loop
    const business = await readReconFixArtifactEvidence(
      expected.generationPath,
      artifact.artifactKind,
      authority.subMode
    );
    if (business.sheetName !== expectedBusiness.sheetName ||
        business.headersDigest !== expectedBusiness.headersDigest ||
        business.recordsDigest !== expectedBusiness.recordsDigest ||
        business.rowCount !== expectedBusiness.rowCount ||
        artifact.sheetName !== expectedBusiness.sheetName ||
        artifact.headersDigest !== expectedBusiness.headersDigest ||
        artifact.recordsDigest !== expectedBusiness.recordsDigest ||
        artifact.rowCount !== expectedBusiness.rowCount ||
        business.headerFontSize !== artifact.style.headerFontSize ||
        business.lastAuthor !== artifact.style.lastAuthor ||
        business.headerFontSize !== 10 || business.lastAuthor !== 'pzhong' ||
        artifact.lineage.exportAuthorityDigest !== authority.authorityDigest ||
        artifact.lineage.inputEvidenceHash !== authority.inputEvidenceHash ||
        artifact.lineage.scenarioSnapshotHash !== authority.scenarioSnapshotHash ||
        artifact.lineage.linkedEvidenceHash !== authority.linkedEvidenceHash ||
        artifact.lineage.resultDigest !== authority.resultDigest) {
      throw exportError('RECON_FIX_EXPORT_BUSINESS_EVIDENCE_MISMATCH', 'ReconFix staging artifact 业务回读或 lineage 不一致');
    }
    const expectedRows = expectedBusiness.rowCount;
    if (artifact.rowCount !== expectedRows) {
      throw exportError('RECON_FIX_EXPORT_ROW_COUNT_MISMATCH', 'ReconFix artifact rowCount 与 result 不守恒');
    }
    validated.push(Object.freeze({
      outputIndex: index,
      outputId: `recon-fix-${artifact.artifactKind}`,
      artifactKind: artifact.artifactKind,
      outputArtifactKey: artifact.outputArtifactKey,
      generationPath: expected.generationPath,
      targetPath: output.filePath,
      targetSnapshot: output.targetSnapshot,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      rowCount: artifact.rowCount,
      lineage: artifact.lineage
    }));
  }
  return Object.freeze(validated);
}

async function publishReconFixExportArtifacts(options, artifacts) {
  const publish = options.publishPublication || publishToolboxPublicationAsync;
  const { batchContext } = freezeReconFixExportBatchAuthority({
    batchContext: options.batchContext
  });
  return publish({
    taskId: `recon-fix-export-${batchContext.taskRunId}-${crypto.randomUUID()}`,
    artifacts: artifacts.map((artifact) => ({
      sourcePath: artifact.generationPath,
      outputId: artifact.outputId,
      fileName: path.basename(artifact.targetPath),
      byteSize: artifact.byteSize,
      sha256: artifact.sha256
    })),
    targets: artifacts.map((artifact) => ({
      targetPath: artifact.targetPath,
      expectedTargetSnapshot: artifact.targetSnapshot
    })),
    protectedSourcePaths: [],
    userDataDir: options.userDataDir,
    batchContext,
    archiveInputFiles: [],
    allowEmptyArchiveInputs: true
  });
}

async function generateValidateAndPublishReconFixExport(options = {}) {
  const runtime = options.runtime;
  if (!runtime || typeof runtime.reserveServiceOperation !== 'function') {
    throw new TypeError('ReconFix export background runtime 缺失');
  }
  if (typeof options.readCurrentEvidence !== 'function') {
    throw new TypeError('ReconFix export Main evidence reader 缺失');
  }
  const batchAuthority = freezeReconFixExportBatchAuthority(options);
  const reference = exactResultReference(options.result);
  const evidenceAdmission = exactRuntimeEvidenceSettlementAdmission(options, runtime);
  const evidenceLease = evidenceAdmission.acquireSettlement({
    operationKey: batchAuthority.operationKey,
    resultHandle: reference.resultHandle
  });
  try {
    const reservation = runtime.reserveServiceOperation({
      actionKey: RECON_FIX_EXPORT_ACTION,
      operationKey: batchAuthority.operationKey
    });
    try {
      const generationInput = createReconFixExportInputFromReference(options, reference);
      const currentEvidence = await options.readCurrentEvidence(reference);
      assertCurrentEvidence(reference, currentEvidence);
      const execution = await reservation.execute({
        actionKey: RECON_FIX_EXPORT_ACTION,
        operationKey: batchAuthority.operationKey,
        production: options.production === true,
        context: batchAuthority.context,
        input: generationInput
      });
      if (!execution || execution.outcome !== 'completed' || execution.terminalSource !== 'job:done') {
        if (execution && execution.error) throw fromProtocolError(execution.error);
        throw exportError('RECON_FIX_EXPORT_GENERATION_FAILED', 'ReconFix Worker staging 生成失败');
      }
      const artifacts = await validateReconFixExportJoin({
        artifactBindings: options.artifactBindings,
        filePlan: options.filePlan,
        generationInput,
        reference,
        result: execution.result
      });
      const expectedKinds = generationInput.artifacts.map((artifact) => artifact.artifactKind);
      const finalFilePlan = canonicalReconFixFilePlan(options.filePlan, expectedKinds);
      freezeReconFixArtifactBindings(options.artifactBindings, finalFilePlan, reference.authority);
      const publication = await publishReconFixExportArtifacts({
        ...options,
        batchContext: batchAuthority.batchContext
      }, artifacts);
      return Object.freeze({
        artifacts,
        summary: Object.freeze({
          fixedRowCount: reference.authority.fixedRowCount,
          unmatchedRowCount: reference.authority.unmatchedRowCount,
          warningCount: reference.authority.warningCount,
          resultDigest: reference.authority.resultDigest,
          artifactCount: reference.authority.artifacts.length
        }),
        publication
      });
    } finally {
      reservation.release();
    }
  } finally {
    evidenceLease.release();
  }
}

module.exports = {
  canonicalReconFixFilePlan,
  createReconFixExportInput,
  exactResultReference,
  freezeReconFixArtifactBindings,
  freezeReconFixExportBatchAuthority,
  generateValidateAndPublishReconFixExport,
  publishReconFixExportArtifacts,
  validateReconFixExportJoin
};
