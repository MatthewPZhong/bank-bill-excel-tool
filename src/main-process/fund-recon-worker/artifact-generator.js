'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const channelsRepository = require('../../backend/database/channels-repository');
const linkedTableRepository = require('../../backend/database/linked-table-repository');
const {
  writeBankStatementMainOutput,
  writeErrorReportOutputToPath
} = require('../bank-statement-io');
const { writePlatformCleanupOutput } = require('../platform-cleanup-writer');
const { writeRefundBackfillOutput } = require('../refund-backfill-writer');
const { writeScenarioHitRows } = require('../scenario-hit-rows-writer');
const {
  buildStaleHitReminder,
  normalizeBizIdKey,
  pickStaleHits
} = require('../scenario-engines/r5-refund-order-backfill');

const OUTPUT_KINDS = Object.freeze([
  'error-report',
  'main',
  'hit-scenarios',
  'platform-cleanup',
  'refund-backfill'
]);

class FundReconArtifactError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'FundReconArtifactError';
    this.code = code;
    this.details = details;
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new FundReconArtifactError('FUND_RECON_FILE_PLAN_INVALID', `${label} 必须是 plain object`);
  }
  return value;
}

function resolveInside(rootPath, candidatePath, label) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new FundReconArtifactError('FUND_RECON_STAGING_ESCAPE', `${label} 必须位于 stagingRoot 内`);
  }
  return candidate;
}

function assertPhysicalParentInside(rootPath, candidatePath, label) {
  const physicalRoot = fs.realpathSync(rootPath);
  const physicalParent = fs.realpathSync(path.dirname(candidatePath));
  if (physicalParent !== physicalRoot && !physicalParent.startsWith(`${physicalRoot}${path.sep}`)) {
    throw new FundReconArtifactError(
      'FUND_RECON_STAGING_SYMLINK_ESCAPE',
      `${label} 的物理父目录必须位于 stagingRoot 内`
    );
  }
}

function assertStagingTargetAbsent(targetPath) {
  try {
    fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new FundReconArtifactError(
    'FUND_RECON_STAGING_TARGET_EXISTS',
    `staging target 已存在：${path.basename(targetPath)}`
  );
}

function normalizeStagingPlan(rawPlan) {
  const plan = requirePlainObject(rawPlan, 'stagingPlan');
  if (plan.version !== 1 || typeof plan.stagingRoot !== 'string' || !plan.stagingRoot) {
    throw new FundReconArtifactError('FUND_RECON_FILE_PLAN_INVALID', 'stagingPlan version/stagingRoot 非法');
  }
  const outputs = Array.isArray(plan.outputs) ? plan.outputs : [];
  if (outputs.length === 0 || outputs.length > OUTPUT_KINDS.length) {
    throw new FundReconArtifactError('FUND_RECON_FILE_PLAN_INVALID', 'stagingPlan outputs 数量非法');
  }
  const seenKinds = new Set();
  const seenPaths = new Set();
  const normalizedOutputs = outputs.map((raw, index) => {
    const item = requirePlainObject(raw, `stagingPlan.outputs[${index}]`);
    if (!OUTPUT_KINDS.includes(item.kind) || seenKinds.has(item.kind)) {
      throw new FundReconArtifactError('FUND_RECON_FILE_PLAN_INVALID', `输出 kind 非法或重复：${String(item.kind)}`);
    }
    seenKinds.add(item.kind);
    if (typeof item.stagingPath !== 'string' || !item.stagingPath) {
      throw new FundReconArtifactError('FUND_RECON_FILE_PLAN_INVALID', `输出 ${item.kind} 缺少 stagingPath`);
    }
    const stagingPath = resolveInside(plan.stagingRoot, item.stagingPath, `输出 ${item.kind}`);
    if (seenPaths.has(stagingPath)) {
      throw new FundReconArtifactError('FUND_RECON_FILE_PLAN_INVALID', '不同输出不能共用 stagingPath');
    }
    seenPaths.add(stagingPath);
    return Object.freeze({
      kind: item.kind,
      stagingPath
    });
  });
  if (typeof plan.manifestPath !== 'string' || !plan.manifestPath ||
      typeof plan.manifestArtifactKey !== 'string' || !plan.manifestArtifactKey) {
    throw new FundReconArtifactError('FUND_RECON_FILE_PLAN_INVALID', 'stagingPlan 缺少 manifest identity');
  }
  const manifestPath = resolveInside(plan.stagingRoot, plan.manifestPath, 'manifestPath');
  if (seenPaths.has(manifestPath)) {
    throw new FundReconArtifactError('FUND_RECON_FILE_PLAN_INVALID', 'manifestPath 不能与业务输出共用路径');
  }
  return Object.freeze({
    stagingRoot: path.resolve(plan.stagingRoot),
    manifestPath,
    manifestArtifactKey: plan.manifestArtifactKey,
    outputs: Object.freeze(normalizedOutputs)
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  let byteSize = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      const nextSize = byteSize + chunk.length;
      if (!Number.isSafeInteger(nextSize)) {
        stream.destroy(new FundReconArtifactError(
          'FUND_RECON_ARTIFACT_TOO_LARGE',
          'staged artifact byteSize 超过安全整数范围'
        ));
        return;
      }
      byteSize = nextSize;
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return Object.freeze({
    byteSize,
    sha256: hash.digest('hex')
  });
}

function assertRequiredOutputKinds(plan, processingResult) {
  const actual = new Set(plan.outputs.map((output) => output.kind));
  const required = new Set();
  if (processingResult.errorReport.length > 0) required.add('error-report');
  if (processingResult.modifiedRows.length > 0 || processingResult.unmatchedRows.length > 0) {
    required.add('main');
  }
  if (processingResult.modifiedRows.some((row) => row && row._hitScenarioId != null)) {
    required.add('hit-scenarios');
  }
  if (processingResult.platformCleanupRows.length > 0) required.add('platform-cleanup');
  if (processingResult.refundBackfillRows.length > 0 || processingResult.refundUnmatchedRows.length > 0) {
    required.add('refund-backfill');
  }
  const missing = [...required].filter((kind) => !actual.has(kind));
  const extra = [...actual].filter((kind) => !required.has(kind));
  if (missing.length || extra.length) {
    throw new FundReconArtifactError(
      'FUND_RECON_FILE_PLAN_MISMATCH',
      'stagingPlan 与本轮输出资格不一致',
      { missing, extra }
    );
  }
}

function prepareRefundSettlement(processingResult, evidenceSnapshot, readMarkers) {
  const rows = Array.isArray(processingResult.refundBackfillRows)
    ? processingResult.refundBackfillRows.map((row) => ({ ...row }))
    : [];
  const bizIds = [...new Set((processingResult.refundHitDepositBizIds || [])
    .map(normalizeBizIdKey)
    .filter(Boolean))];
  if (bizIds.length === 0) {
    return Object.freeze({
      rows,
      markerSettlement: Object.freeze({ status: 'not-applicable', runId: null, bizIds: [], reasonCode: null })
    });
  }
  try {
    if (!evidenceSnapshot || !evidenceSnapshot.db) throw new Error('evidence snapshot unavailable');
    const markerMap = readMarkers(evidenceSnapshot.db, bizIds);
    const staleHits = pickStaleHits(bizIds, markerMap, processingResult.runId);
    const staleByBizId = new Map(staleHits.map((item) => [item.bizId, item.lastHitAt]));
    for (const row of rows) {
      const bizId = normalizeBizIdKey(row && row._bridgeDepositBizId);
      if (!bizId || !staleByBizId.has(bizId)) continue;
      const reminder = buildStaleHitReminder(bizId, staleByBizId.get(bizId));
      row['匹配命中详情'] = `${row['匹配命中详情'] ? `${row['匹配命中详情']}\n` : ''}${reminder}`;
    }
    return Object.freeze({
      rows,
      markerSettlement: Object.freeze({
        status: 'ready',
        runId: String(processingResult.runId),
        bizIds: Object.freeze(bizIds),
        reasonCode: null
      })
    });
  } catch (_error) {
    // 与 legacy 一致：marker 是观测增强。读取失败不阻断产物，但绝不能推进 marker。
    return Object.freeze({
      rows,
      markerSettlement: Object.freeze({
        status: 'skipped',
        runId: null,
        bizIds: [],
        reasonCode: 'marker-read-failed'
      })
    });
  }
}

function createFundReconArtifactGenerator(options = {}) {
  const writers = Object.freeze({
    main: options.writeBankStatementMainOutput || writeBankStatementMainOutput,
    error: options.writeErrorReportOutputToPath || writeErrorReportOutputToPath,
    hit: options.writeScenarioHitRows || writeScenarioHitRows,
    cleanup: options.writePlatformCleanupOutput || writePlatformCleanupOutput,
    refund: options.writeRefundBackfillOutput || writeRefundBackfillOutput
  });
  const listChannels = options.listChannels || channelsRepository.listChannels;
  const readMarkers = options.readBankDepositHitMarkers || linkedTableRepository.readBankDepositHitMarkers;

  return Object.freeze({
    async generate({ processingResult, bankSession, evidenceSnapshot, stagingPlan }) {
      const plan = normalizeStagingPlan(stagingPlan);
      assertRequiredOutputKinds(plan, processingResult);
      fs.mkdirSync(plan.stagingRoot, { recursive: true });
      const plannedPaths = [...plan.outputs.map((output) => output.stagingPath), plan.manifestPath];
      for (const plannedPath of plannedPaths) {
        fs.mkdirSync(path.dirname(plannedPath), { recursive: true });
        assertPhysicalParentInside(plan.stagingRoot, plannedPath, plannedPath);
        assertStagingTargetAbsent(plannedPath);
      }
      const channels = evidenceSnapshot && evidenceSnapshot.db
        ? listChannels(evidenceSnapshot.db)
        : [];
      const refundSettlement = prepareRefundSettlement(processingResult, evidenceSnapshot, readMarkers);
      const generated = [];
      try {
        for (const output of plan.outputs) {
          if (output.kind === 'error-report') {
            await writers.error({
              warnings: processingResult.errorReport,
              outputPath: output.stagingPath,
              bankRows: [...processingResult.modifiedRows, ...processingResult.unmatchedRows]
            });
          } else if (output.kind === 'main') {
            await writers.main({
              modifiedRows: processingResult.modifiedRows,
              unmatchedRows: processingResult.unmatchedRows,
              headers: bankSession.headers,
              modifications: processingResult.modifications,
              paymentOfflinePairs: processingResult.paymentOfflineMatchedPairs,
              manyToManyRows: processingResult.manyToManyReviewRows,
              mainFilePath: output.stagingPath
            });
          } else if (output.kind === 'hit-scenarios') {
            const hitRows = processingResult.modifiedRows.filter((row) => row && row._hitScenarioId != null);
            await writers.hit(hitRows, bankSession.filePath || bankSession.fileName, {
              outputPath: output.stagingPath,
              channels
            });
          } else if (output.kind === 'platform-cleanup') {
            await writers.cleanup(processingResult.platformCleanupRows, output.stagingPath);
          } else if (output.kind === 'refund-backfill') {
            await writers.refund(
              refundSettlement.rows,
              processingResult.refundUnmatchedRows,
              output.stagingPath
            );
          }
          const identity = await sha256File(output.stagingPath);
          generated.push(Object.freeze({ kind: output.kind, stagingPath: output.stagingPath, ...identity }));
        }
        const manifest = Object.freeze({
          version: 1,
          evidenceSignature: processingResult.evidenceSignature,
          outputs: Object.freeze(generated),
          settlement: Object.freeze({
            refundHitMarkers: refundSettlement.markerSettlement
          })
        });
        const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
        await fs.promises.writeFile(plan.manifestPath, bytes, { flag: 'wx' });
        return Object.freeze({
          artifactKey: plan.manifestArtifactKey,
          stagingPath: plan.manifestPath,
          byteSize: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        });
      } catch (error) {
        await Promise.allSettled(plannedPaths.map((plannedPath) => fs.promises.unlink(plannedPath)));
        throw error;
      }
    }
  });
}

module.exports = {
  FundReconArtifactError,
  OUTPUT_KINDS,
  assertPhysicalParentInside,
  createFundReconArtifactGenerator,
  normalizeStagingPlan,
  prepareRefundSettlement,
  sha256File
};
