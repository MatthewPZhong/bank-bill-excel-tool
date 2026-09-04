'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createDuplicateInboundMatchService } = require('./service');
const { createDuplicateMirrorDatabase } = require('./mirror-database');
const { DUPLICATE_ACTIONS } = require('./policies');
const { createDuplicateManagedStartupGate } = require('./startup-gate');
const { estimateDuplicateStateFootprint } = require('./state-footprint');

const DUPLICATE_EXPORT_STAGING_PLAN_VERSION = 1;
const FILE_PLAN_OUTPUT_ARTIFACT_KEY_PATTERN = /^output-[a-f0-9]{64}$/;

class DuplicateManagedServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DuplicateManagedServiceError';
    this.code = code;
  }
}

function emptySummary() {
  return Object.freeze({ bankRowCount: 0, documentRowCount: 0, canRun: false, canExport: false });
}

function summaryFromService(service) {
  if (!service || typeof service.status !== 'function') {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_STATUS_UNAVAILABLE',
      'Duplicate Service缺少真实status资格'
    );
  }
  const status = service.status();
  return Object.freeze({
    bankRowCount: status && status.bank ? Number(status.bank.rowCount) || 0 : 0,
    documentRowCount: status && status.document ? Number(status.document.rowCount) || 0 : 0,
    canRun: Boolean(status && status.canRun === true),
    canExport: Boolean(status && status.canExport === true)
  });
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new DuplicateManagedServiceError('DUPLICATE_INPUT_INVALID', `${label}必须是plain object`);
  }
  return value;
}

function runtimeIdentity(raw) {
  const value = requirePlainObject(raw, 'runtime');
  const fields = ['userDataDir', 'databasePath', 'mailTemplatePath', 'bankTemplatePath'];
  const result = {};
  for (const field of fields) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) {
      throw new DuplicateManagedServiceError('DUPLICATE_RUNTIME_INVALID', `runtime.${field}不能为空`);
    }
    result[field] = path.resolve(value[field]);
  }
  return Object.freeze(result);
}

function sameRuntime(left, right) {
  return left && Object.keys(left).every((key) => left[key] === right[key]);
}

function exportPlanObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_FILE_PLAN_INVALID',
      `${label}必须是plain object`
    );
  }
  return value;
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return Boolean(relative && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeDuplicateExportStagingPlan(rawPlan) {
  const plan = exportPlanObject(rawPlan, 'stagingPlan');
  if (plan.version !== DUPLICATE_EXPORT_STAGING_PLAN_VERSION ||
      typeof plan.stagingRoot !== 'string' || !path.isAbsolute(plan.stagingRoot)) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_FILE_PLAN_INVALID',
      'Duplicate export stagingPlan version/stagingRoot非法'
    );
  }
  if (!Array.isArray(plan.outputs) || plan.outputs.length !== 1) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_FILE_PLAN_INVALID',
      'Duplicate export stagingPlan必须且只能包含一个输出'
    );
  }
  const output = exportPlanObject(plan.outputs[0], 'stagingPlan.outputs[0]');
  if (typeof output.artifactKey !== 'string' ||
      !FILE_PLAN_OUTPUT_ARTIFACT_KEY_PATTERN.test(output.artifactKey) ||
      typeof output.stagingPath !== 'string' || !path.isAbsolute(output.stagingPath)) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_FILE_PLAN_INVALID',
      'Duplicate export输出缺少规范FilePlan artifactKey或绝对stagingPath'
    );
  }
  const stagingRoot = path.resolve(plan.stagingRoot);
  const stagingPath = path.resolve(output.stagingPath);
  if (!isPathInside(stagingRoot, stagingPath)) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_STAGING_ESCAPE',
      'Duplicate export stagingPath必须位于task-private stagingRoot内'
    );
  }
  return Object.freeze({
    version: DUPLICATE_EXPORT_STAGING_PLAN_VERSION,
    stagingRoot,
    output: Object.freeze({ artifactKey: output.artifactKey, stagingPath })
  });
}

function prepareDuplicateExportStaging(plan, fsImpl) {
  let rootStat;
  try {
    rootStat = fsImpl.lstatSync(plan.stagingRoot);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new DuplicateManagedServiceError(
        'DUPLICATE_EXPORT_STAGING_ROOT_INVALID',
        'Duplicate export stagingRoot必须由Main预先分配且已存在'
      );
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_STAGING_ROOT_INVALID',
      'Duplicate export stagingRoot必须是普通目录且不能是符号链接'
    );
  }
  const targetPath = plan.output.stagingPath;
  const targetParent = path.dirname(targetPath);
  let parentStat;
  try {
    parentStat = fsImpl.lstatSync(targetParent);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new DuplicateManagedServiceError(
        'DUPLICATE_EXPORT_STAGING_PARENT_INVALID',
        'Duplicate export stagingPath父目录必须由Main预先分配且已存在'
      );
    }
    throw error;
  }
  if (parentStat.isSymbolicLink()) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_STAGING_SYMLINK_ESCAPE',
      'Duplicate export stagingPath父目录不能是符号链接'
    );
  }
  if (!parentStat.isDirectory()) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_STAGING_PARENT_INVALID',
      'Duplicate export stagingPath父目录必须是普通目录'
    );
  }
  const physicalRoot = fsImpl.realpathSync(plan.stagingRoot);
  const physicalParent = fsImpl.realpathSync(targetParent);
  if (physicalParent !== physicalRoot && !isPathInside(physicalRoot, physicalParent)) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_STAGING_SYMLINK_ESCAPE',
      'Duplicate export stagingPath物理父目录越过task-private stagingRoot'
    );
  }
  try {
    fsImpl.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return targetPath;
    throw error;
  }
  throw new DuplicateManagedServiceError(
    'DUPLICATE_EXPORT_STAGING_TARGET_EXISTS',
    'Duplicate export staging target必须不存在'
  );
}

function cleanupDuplicateExportStaging(fsImpl, stagingPath, primaryError) {
  try {
    fsImpl.rmSync(stagingPath, { force: true });
  } catch (cleanupError) {
    const error = new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_STAGING_CLEANUP_FAILED',
      'Duplicate export失败且task-private staging清理失败'
    );
    error.cause = primaryError;
    error.cleanupError = cleanupError;
    throw error;
  }
}

function artifactFor(filePath, artifactKey, fsImpl) {
  const stat = fsImpl.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DuplicateManagedServiceError(
      'DUPLICATE_EXPORT_STAGING_OUTPUT_INVALID',
      'Duplicate export staging输出必须是普通文件且不能是符号链接'
    );
  }
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let byteSize = 0;
    const stream = fsImpl.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      const nextSize = byteSize + chunk.length;
      if (!Number.isSafeInteger(nextSize)) {
        stream.destroy(new DuplicateManagedServiceError(
          'DUPLICATE_EXPORT_ARTIFACT_TOO_LARGE',
          'Duplicate export staging输出超过安全整数范围'
        ));
        return;
      }
      byteSize = nextSize;
      hash.update(chunk);
    });
    stream.on('end', () => resolve(Object.freeze({
      artifactKey,
      stagingPath: path.resolve(filePath),
      byteSize,
      sha256: hash.digest('hex')
    })));
  });
}

function createDuplicateManagedService(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const createMirrorDatabase = options.createMirrorDatabase || createDuplicateMirrorDatabase;
  const createLegacyService = options.createLegacyService || createDuplicateInboundMatchService;
  const estimateFootprint = options.estimateFootprint || estimateDuplicateStateFootprint;
  const startupGate = options.startupGate || createDuplicateManagedStartupGate(
    options.startupGateDescriptor
  );
  if (!startupGate || typeof startupGate.assertOperationAllowed !== 'function') {
    throw new TypeError('Duplicate managed Service需要startupGate');
  }
  let service = null;
  let mirrorDatabase = null;
  let runtime = null;
  let stateRevision = 0;
  let stableSummary = emptySummary();
  let active = false;
  let closed = false;

  function assertOpen() {
    if (closed) throw new DuplicateManagedServiceError('DUPLICATE_SERVICE_CLOSED', 'Duplicate Service已关闭');
  }

  function ensureService(input) {
    const next = runtimeIdentity(input.runtime);
    if (runtime && !sameRuntime(runtime, next)) {
      throw new DuplicateManagedServiceError('DUPLICATE_RUNTIME_CHANGED', 'Duplicate Service runtime身份不可变');
    }
    startupGate.assertOperationAllowed(next, { initializing: !service });
    if (!service) {
      runtime = next;
      mirrorDatabase = createMirrorDatabase(runtime.databasePath);
      service = createLegacyService({
        userDataDir: runtime.userDataDir,
        database: mirrorDatabase,
        mailTemplatePath: runtime.mailTemplatePath,
        bankTemplatePath: runtime.bankTemplatePath
      });
    }
    return service;
  }

  function refreshStableSummary() {
    if (service) stableSummary = summaryFromService(service);
    return stableSummary;
  }

  async function adopt(jobContext, operation) {
    if (!jobContext || typeof jobContext.adoptCandidate !== 'function') {
      throw new DuplicateManagedServiceError(
        'DUPLICATE_ADOPTION_REQUIRED',
        'Duplicate mutation必须等待PersistentReservation adopt ACK'
      );
    }
    // candidate在ACK前只能作为adoption payload存在，不能写入对外稳定快照。
    const candidateSummary = summaryFromService(service);
    const candidateRevision = stateRevision + 1;
    const footprint = estimateFootprint({ runtime, summary: candidateSummary });
    await jobContext.adoptCandidate({ summary: candidateSummary }, {
      candidateRevision,
      memoryBytes: footprint.estimatedBytes,
      operation
    });
    stateRevision = candidateRevision;
    stableSummary = candidateSummary;
  }

  function compact(operation, extra = {}) {
    return Object.freeze({
      status: 'ok',
      operation,
      stateRevision,
      summary: stableSummary,
      ...extra
    });
  }

  async function executeImport(input, jobContext) {
    const current = ensureService(input);
    stateRevision += 1;
    stableSummary = emptySummary();
    let imported = false;
    let durableCommit = false;
    try {
      let result;
      if (input.pairedImport) {
        if (typeof jobContext.awaitPreparedImport !== 'function' ||
            typeof current.importPreparedSpools !== 'function') {
          throw new DuplicateManagedServiceError(
            'DUPLICATE_PAIRED_IMPORT_UNAVAILABLE',
            'Duplicate paired import依赖未完整注册'
          );
        }
        // command一经Service接受，旧generation内session/lastRun资格立即失效；
        // Parser仍只产生private spool，不在此之前触碰side/Main DB或adopt。
        current.detachCommittedSession();
        await jobContext.awaitPreparedImport();
        result = await current.importPreparedSpools(
          input.pairedImport,
          jobContext.onProgress,
          jobContext.operationIdentity,
          jobContext.signal
        );
      } else {
        result = await current.importFiles(
          input.filePaths, jobContext.onProgress, jobContext.operationIdentity
        );
      }
      imported = true;
      durableCommit = Boolean(result && result.durableCommit);
      await adopt(jobContext, 'import');
      return compact('import');
    } catch (error) {
      if (imported) {
        try {
          if (durableCommit && typeof current.detachCommittedSession === 'function') {
            current.detachCommittedSession();
          } else {
            current.invalidateForNewImport();
          }
        } catch (_cleanupError) { /* 原错误优先 */ }
      }
      throw error;
    }
  }

  async function executeRun(input, jobContext) {
    const current = ensureService(input);
    stateRevision += 1;
    stableSummary = Object.freeze({ ...summaryFromService(current), canExport: false });
    let completed = false;
    let durableCommit = false;
    try {
      const result = await current.run({
        onProgress: jobContext.onProgress,
        operationIdentity: jobContext.operationIdentity
      });
      completed = true;
      durableCommit = Boolean(result && result.durableCommit);
      await adopt(jobContext, 'run');
      return compact('run', { runId: Number(result.runId) });
    } catch (error) {
      if (completed) {
        try {
          if (durableCommit && typeof current.detachCommittedRun === 'function') {
            current.detachCommittedRun();
          } else {
            current.clearPreviousRun();
          }
        } catch (_cleanupError) { /* 原错误优先 */ }
      }
      throw error;
    }
  }

  async function executeExport(input, jobContext) {
    if (Object.hasOwn(input, 'savePath')) {
      throw new DuplicateManagedServiceError(
        'DUPLICATE_EXPORT_FILE_PLAN_INVALID',
        'Duplicate managed export不得接收正式savePath'
      );
    }
    const plan = normalizeDuplicateExportStagingPlan(input.stagingPlan);
    const stagingPath = prepareDuplicateExportStaging(plan, fsImpl);
    const current = ensureService(input);
    try {
      await current.export({ savePath: stagingPath, onProgress: jobContext.onProgress });
      const artifact = await artifactFor(stagingPath, plan.output.artifactKey, fsImpl);
      return compact('export', { artifacts: Object.freeze([artifact]) });
    } catch (error) {
      cleanupDuplicateExportStaging(fsImpl, stagingPath, error);
      throw error;
    }
  }

  async function execute(actionKey, rawInput, jobContext = {}) {
    assertOpen();
    if (active) throw new DuplicateManagedServiceError('SERVICE_BUSY', 'Duplicate Service正在执行另一条命令');
    const input = requirePlainObject(rawInput, 'input');
    active = true;
    try {
      if (jobContext.signal && jobContext.signal.aborted) {
        throw new DuplicateManagedServiceError('DUPLICATE_SHUTDOWN', 'Duplicate Service正在关闭');
      }
      if (actionKey === DUPLICATE_ACTIONS.IMPORT) return await executeImport(input, jobContext);
      if (actionKey === DUPLICATE_ACTIONS.RUN) return await executeRun(input, jobContext);
      if (actionKey === DUPLICATE_ACTIONS.EXPORT) return await executeExport(input, jobContext);
      throw new DuplicateManagedServiceError('DUPLICATE_ACTION_UNKNOWN', `未知Duplicate action：${actionKey}`);
    } finally {
      refreshStableSummary();
      active = false;
    }
  }

  return Object.freeze({
    execute,
    status() {
      return Object.freeze({
        active,
        closed,
        stateRevision,
        // Legacy Service会在PersistentReservation adopt ACK前先持有candidate。
        // managed边界在命令active期间只发布最后一个稳定快照，避免绕过adopt。
        stableSummary: active ? stableSummary : refreshStableSummary()
      });
    },
    close() {
      if (active) throw new DuplicateManagedServiceError('SERVICE_BUSY', 'Duplicate Service仍在执行命令');
      if (closed) return;
      closed = true;
      if (mirrorDatabase) mirrorDatabase.close();
      service = null;
      mirrorDatabase = null;
      runtime = null;
      stableSummary = emptySummary();
    }
  });
}

module.exports = {
  DuplicateManagedServiceError,
  createDuplicateManagedService,
  emptySummary,
  normalizeDuplicateExportStagingPlan,
  prepareDuplicateExportStaging,
  runtimeIdentity,
  summaryFromService
};
