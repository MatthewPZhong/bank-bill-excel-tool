'use strict';

const path = require('node:path');

const { mergeBankStatementRows } = require('../bank-statement-merge');
const { runReconciliation } = require('../reconciliation-orchestrator');
const { createFundReconArtifactGenerator } = require('./artifact-generator');
const { createFundReconEvidenceProvider } = require('./evidence-provider');
const {
  FUND_RECON_ACTIONS
} = require('./policies');
const {
  readBankSource,
  readGatewaySource,
  readRefundSource
} = require('./source-readers');
const { estimateFundReconStateFootprint } = require('./state-footprint');

class FundReconServiceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'FundReconServiceError';
    this.code = code;
    this.details = details;
  }
}

function emptyState() {
  return Object.freeze({
    bankSession: null,
    gatewaySession: null,
    refundSession: null,
    processingResult: null,
    stateRevision: 0
  });
}

function stableSummary(state) {
  return Object.freeze({
    bankRowCount: state.bankSession && Array.isArray(state.bankSession.rows)
      ? state.bankSession.rows.length
      : 0,
    hasGateway: Boolean(state.gatewaySession),
    hasProcessingResult: Boolean(state.processingResult),
    hasRefund: Boolean(state.refundSession),
    sourceFileCount: [
      ...(state.bankSession && Array.isArray(state.bankSession.sourceFiles)
        ? state.bankSession.sourceFiles
        : []),
      ...(state.gatewaySession ? [state.gatewaySession.fileName] : []),
      ...(state.refundSession ? [state.refundSession.fileName] : [])
    ].length
  });
}

function requirePlainInput(value, label = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new FundReconServiceError('FUND_RECON_INPUT_INVALID', `${label} 必须是 plain object`);
  }
  return value;
}

function assertNotAborted(signal) {
  if (!signal || !signal.aborted) return;
  throw new FundReconServiceError('FUND_RECON_SHUTDOWN', 'FundRecon Service 正在关闭');
}

function requireDatabasePath(input) {
  if (typeof input.databasePath !== 'string' || input.databasePath.trim().length === 0) {
    throw new FundReconServiceError(
      'FUND_RECON_DATABASE_PATH_REQUIRED',
      'FundRecon run/export 需要 databasePath'
    );
  }
  return path.resolve(input.databasePath);
}

function compactResult(operation, state, extra = {}) {
  return Object.freeze({
    status: 'ok',
    operation,
    stateRevision: state.stateRevision,
    summary: stableSummary(state),
    ...extra
  });
}

function normalizeImportSources(input) {
  const sources = Array.isArray(input.sources) ? input.sources : [];
  if (sources.length === 0 || sources.length > 64) {
    throw new FundReconServiceError('FUND_RECON_IMPORT_SOURCES_INVALID', 'import sources 数量必须为 1-64');
  }
  return sources.map((raw, index) => {
    const source = requirePlainInput(raw, `sources[${index}]`);
    if (!['bank', 'gateway', 'refund'].includes(source.kind) ||
        typeof source.filePath !== 'string' || source.filePath.length === 0) {
      throw new FundReconServiceError('FUND_RECON_IMPORT_SOURCE_INVALID', `sources[${index}] 非法`);
    }
    return Object.freeze({
      kind: source.kind,
      filePath: path.resolve(source.filePath),
      ...(source.sheetName ? { sheetName: String(source.sheetName) } : {})
    });
  });
}

function buildImportedCandidate(previous, input, readers, now) {
  const sources = normalizeImportSources(input);
  const bankSources = sources.filter((source) => source.kind === 'bank');
  const gatewaySources = sources.filter((source) => source.kind === 'gateway');
  const refundSources = sources.filter((source) => source.kind === 'refund');
  if (gatewaySources.length > 1 || refundSources.length > 1) {
    throw new FundReconServiceError(
      'FUND_RECON_IMPORT_ROLE_DUPLICATE',
      '同一 import command 最多包含一份 gateway 和一份 refund 文件'
    );
  }
  let bankSession = previous.bankSession;
  if (bankSources.length > 0) {
    let rows = [];
    let headers = [];
    const sourceFiles = [];
    for (const source of bankSources) {
      const parsed = readers.bank(source);
      const merged = mergeBankStatementRows(rows, parsed.rows, headers, parsed.headers);
      rows = merged.rows;
      headers = merged.headers;
      sourceFiles.push(parsed.fileName);
    }
    bankSession = Object.freeze({
      filePath: bankSources.length === 1 ? bankSources[0].filePath : '',
      fileName: sourceFiles.join('、'),
      sourceFiles: Object.freeze(sourceFiles),
      rows,
      headers,
      importedAt: now()
    });
  }
  const gatewaySession = gatewaySources.length > 0
    ? Object.freeze({ ...readers.gateway(gatewaySources[0]), importedAt: now() })
    : (bankSources.length > 0 ? null : previous.gatewaySession);
  const refundSession = refundSources.length > 0
    ? Object.freeze({ ...readers.refund(refundSources[0]), importedAt: now() })
    : (bankSources.length > 0 ? null : previous.refundSession);
  return Object.freeze({
    bankSession,
    gatewaySession,
    refundSession,
    processingResult: null,
    stateRevision: previous.stateRevision + 1
  });
}

function processingResultFromRun(result, context) {
  return Object.freeze({
    modifiedRows: result.modifiedRows,
    unmatchedRows: result.unmatchedRows,
    modifications: result.modifications,
    errorReport: result.errorReport,
    stats: result.stats,
    platformCleanupRows: result.platformCleanupRows || [],
    refundBackfillRows: result.refundBackfillRows || [],
    refundUnmatchedRows: result.refundUnmatchedRows || [],
    refundHitDepositBizIds: result.refundHitDepositBizIds || [],
    paymentOfflineMatchedPairs: result.paymentOfflineMatchedPairs || [],
    manyToManyReviewRows: result.manyToManyReviewRows || [],
    runId: context.runId,
    ranAt: context.ranAt,
    evidenceSignature: context.evidenceSignature,
    evidence: context.evidence,
    databasePath: context.databasePath,
    derivationEvidence: context.derivationEvidence || null
  });
}

function createFundReconService(options = {}) {
  const evidenceProvider = options.evidenceProvider || createFundReconEvidenceProvider();
  const artifactGenerator = options.artifactGenerator || createFundReconArtifactGenerator();
  const reconcile = options.runReconciliation || runReconciliation;
  const estimateFootprint = options.estimateFootprint || estimateFundReconStateFootprint;
  const now = options.now || Date.now;
  const readers = Object.freeze({
    bank: options.readBankSource || readBankSource,
    gateway: options.readGatewaySource || readGatewaySource,
    refund: options.readRefundSource || readRefundSource
  });
  let state = emptyState();
  let active = false;

  async function publishCandidate(candidate, context, jobContext) {
    if (!jobContext || typeof jobContext.adoptCandidate !== 'function') {
      throw new FundReconServiceError(
        'FUND_RECON_ADOPTION_REQUIRED',
        'FundRecon mutation 必须通过 PersistentReservation adoption'
      );
    }
    const footprint = estimateFootprint(candidate);
    await jobContext.adoptCandidate(candidate, Object.freeze({
      candidateRevision: candidate.stateRevision,
      memoryBytes: footprint.estimatedBytes,
      operation: context
    }));
    state = candidate;
    return candidate;
  }

  async function executeImport(input, jobContext) {
    assertNotAborted(jobContext.signal);
    const candidate = buildImportedCandidate(state, input, readers, now);
    await publishCandidate(candidate, 'import', jobContext);
    return compactResult('import', state);
  }

  async function executeRun(input, jobContext) {
    if (!state.bankSession) {
      throw new FundReconServiceError('FUND_RECON_BANK_REQUIRED', '请先导入银行对账单');
    }
    const databasePath = requireDatabasePath(input);
    const snapshot = evidenceProvider.openRunSnapshot({
      databasePath,
      bankRows: state.bankSession.rows,
      derivationEvidence: input.derivationEvidence || null
    });
    try {
      assertNotAborted(jobContext.signal);
      const workingBankRows = structuredClone(state.bankSession.rows);
      const workingRefundRows = state.refundSession ? structuredClone(state.refundSession.rows) : [];
      const workingReconRows = structuredClone(snapshot.reconRows);
      const dispatchReconRows = snapshot.flags.dbsChargeScenarioEnabled
        ? structuredClone(snapshot.reconRows)
        : [];
      const auditRows = snapshot.flags.dbsChargeScenarioEnabled ? dispatchReconRows : workingReconRows;
      const result = await reconcile({
        bankRows: workingBankRows,
        gwRows: snapshot.gatewayPools.exactRows,
        c3GwRows: snapshot.gatewayPools.c3Rows,
        scenarios: snapshot.scenarios,
        deps: snapshot.deps,
        refundContext: {
          refundOrderRows: workingRefundRows,
          depositRows: structuredClone(snapshot.depositRows)
        },
        fundTransferReconContext: { reconRows: workingReconRows },
        dispatchReconContext: { dispatchReconRows },
        fundTransferAuditContext: { reconRows: auditRows },
        fundTransferDatePolicy: snapshot.datePolicy,
        initialWarnings: snapshot.initialWarnings,
        onProgress: jobContext.onProgress
      });
      assertNotAborted(jobContext.signal);
      const processingResult = processingResultFromRun(result, {
        runId: state.bankSession.importedAt,
        ranAt: now(),
        evidenceSignature: snapshot.evidenceSignature,
        evidence: snapshot.evidence,
        databasePath,
        derivationEvidence: input.derivationEvidence || null
      });
      const candidate = Object.freeze({
        bankSession: state.bankSession,
        gatewaySession: state.gatewaySession,
        refundSession: state.refundSession,
        processingResult,
        stateRevision: state.stateRevision + 1
      });
      await publishCandidate(candidate, 'run', jobContext);
      return compactResult('run', state, {
        evidenceSignature: processingResult.evidenceSignature,
        stats: processingResult.stats
      });
    } finally {
      snapshot.close();
    }
  }

  async function executeExport(input, jobContext) {
    if (!state.bankSession || !state.processingResult) {
      throw new FundReconServiceError('FUND_RECON_RESULT_REQUIRED', '请先运行资金对账再导出');
    }
    const databasePath = requireDatabasePath(input);
    if (databasePath !== state.processingResult.databasePath) {
      throw new FundReconServiceError('FUND_RECON_DATABASE_CHANGED', '导出数据库身份与运行时不一致');
    }
    const current = evidenceProvider.openRunSnapshot({
      databasePath,
      bankRows: state.bankSession.rows,
      derivationEvidence: state.processingResult.derivationEvidence
    });
    try {
      if (current.evidenceSignature !== state.processingResult.evidenceSignature) {
        throw new FundReconServiceError(
          'FUND_RECON_RESULT_STALE',
          '场景、链接表或日期策略已变化，请重新运行后再导出'
        );
      }
      assertNotAborted(jobContext.signal);
      const artifact = await artifactGenerator.generate({
        processingResult: state.processingResult,
        bankSession: state.bankSession,
        evidenceSnapshot: current,
        stagingPlan: input.stagingPlan
      });
      return Object.freeze({
        status: 'ok',
        operation: 'export',
        stateRevision: state.stateRevision,
        summary: stableSummary(state),
        evidenceSignature: state.processingResult.evidenceSignature,
        artifacts: Object.freeze([artifact])
      });
    } finally {
      current.close();
    }
  }

  async function execute(actionKey, rawInput, jobContext = {}) {
    if (active) {
      throw new FundReconServiceError('SERVICE_BUSY', 'FundRecon Service 正在执行另一条命令');
    }
    const input = requirePlainInput(rawInput);
    active = true;
    try {
      if (actionKey === FUND_RECON_ACTIONS.IMPORT) return await executeImport(input, jobContext);
      if (actionKey === FUND_RECON_ACTIONS.RUN) return await executeRun(input, jobContext);
      if (actionKey === FUND_RECON_ACTIONS.EXPORT) return await executeExport(input, jobContext);
      throw new FundReconServiceError('FUND_RECON_ACTION_UNKNOWN', `未知 FundRecon action：${String(actionKey)}`);
    } finally {
      active = false;
    }
  }

  return Object.freeze({
    execute,
    async invalidate(reason, jobContext = {}) {
      if (active) throw new FundReconServiceError('SERVICE_BUSY', 'FundRecon Service 正在执行另一条命令');
      active = true;
      try {
        if (!state.processingResult) return false;
        const candidate = Object.freeze({
          bankSession: state.bankSession,
          gatewaySession: state.gatewaySession,
          refundSession: state.refundSession,
          processingResult: null,
          stateRevision: state.stateRevision + 1
        });
        await publishCandidate(candidate, `invalidate:${String(reason || 'unspecified')}`, jobContext);
        return true;
      } finally {
        active = false;
      }
    },
    inspectForTest() {
      return state;
    },
    status() {
      return Object.freeze({
        active,
        stateRevision: state.stateRevision,
        stableSummary: stableSummary(state)
      });
    }
  });
}

module.exports = {
  FundReconServiceError,
  buildImportedCandidate,
  createFundReconService,
  emptyState,
  processingResultFromRun,
  requireDatabasePath,
  stableSummary
};
