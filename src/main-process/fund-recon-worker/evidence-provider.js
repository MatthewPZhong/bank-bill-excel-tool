'use strict';

const { DatabaseSync } = require('node:sqlite');

const channelsRepository = require('../../backend/database/channels-repository');
const linkedTableRepository = require('../../backend/database/linked-table-repository');
const scenariosRepository = require('../../backend/database/scenarios-repository');
const { canonicalSha256, canonicalJsonSnapshot } = require('../background-execution/canonical-json-v1');
const { resolveFundTransferDatePolicy } = require('../fund-transfer-date-policy');
const { C4_CATEGORIES } = require('../scenario-dispatcher');

class FundReconEvidenceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'FundReconEvidenceError';
    this.code = code;
    this.details = details;
  }
}

function openReadSnapshot(databasePath) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) {
    throw new FundReconEvidenceError('FUND_RECON_DATABASE_PATH_REQUIRED', 'FundRecon run 需要 databasePath');
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON;');
    db.exec('BEGIN');
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  return {
    db,
    close() {
      if (closed) return;
      closed = true;
      try { db.exec('ROLLBACK'); } catch (_error) { /* snapshot 已结束 */ }
      db.close();
    }
  };
}

function detailedScenarios(db) {
  return scenariosRepository.listScenarios(db).map((summary) => {
    const detail = scenariosRepository.getScenario(db, summary.id);
    if (!detail) return null;
    const applicableChannelIds = detail.category === 'builtin-fixed'
      ? scenariosRepository.getApplicableChannelIds(db, summary.id)
      : null;
    return {
      ...detail,
      displayIndex: summary.displayIndex,
      channelId: summary.channelId,
      _applicableChannelIds: applicableChannelIds
    };
  }).filter(Boolean);
}

function enabledConsumerFlags(scenarios, fundTransferDatePolicy) {
  const refundBackfillEnabled = scenarios.some((scenario) =>
    scenario && scenario.category === 'builtin-fixed' && scenario.config &&
    scenario.config.funcCategory === 'platform-order' &&
    scenario.config.subCategory === 'refund-order-backfill');
  const owner = scenarios.find((scenario) =>
    String(scenario && scenario.id) === String(fundTransferDatePolicy.ownerScenarioId));
  const paymentOfflineEnabled = Boolean(owner && owner.config && owner.config.paymentOfflineBackfill &&
    owner.config.paymentOfflineBackfill.enabled === true);
  const configuredReconSourceMidEnabled = Boolean(owner && owner.config && owner.config.reconSourceMid !== false);
  const dbsChargeScenarioEnabled = scenarios.some((scenario) =>
    scenario && scenario.config && scenario.config.funcCategory === 'dbs-charge-fund-check');
  return Object.freeze({
    refundBackfillEnabled,
    paymentOfflineEnabled,
    reconSourceMidEnabled: paymentOfflineEnabled || configuredReconSourceMidEnabled,
    dbsChargeScenarioEnabled
  });
}

function assertDerivationPrepared(flags, meta, derivationEvidence) {
  if (!flags.reconSourceMidEnabled && !flags.dbsChargeScenarioEnabled) return null;
  if (!derivationEvidence || derivationEvidence.prepared !== true ||
      typeof derivationEvidence.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(derivationEvidence.signature)) {
    throw new FundReconEvidenceError(
      'FUND_RECON_DERIVATION_NOT_PREPARED',
      '调拨对账单消费方已启用，但 Main 未提供本轮实时派生完成证据'
    );
  }
  const expectedSourceSignature = canonicalSha256(meta['mid-allocation']);
  if (derivationEvidence.sourceSignature !== expectedSourceSignature) {
    throw new FundReconEvidenceError(
      'FUND_RECON_DERIVATION_SOURCE_STALE',
      '调拨派生证据与当前 mid-allocation 快照不一致，请重新运行',
      { expectedSourceSignature }
    );
  }
  return canonicalJsonSnapshot({
    prepared: true,
    signature: derivationEvidence.signature,
    sourceSignature: derivationEvidence.sourceSignature
  });
}

function linkedMetaSnapshot(db) {
  return Object.freeze(Object.fromEntries(
    ['gateway-bill', 'bank-deposit', 'mid-allocation'].map((tableKey) => [
      tableKey,
      canonicalJsonSnapshot(linkedTableRepository.getLinkedTableMeta(db, tableKey))
    ])
  ));
}

function createEvidenceSignature({ scenarios, datePolicy, linkedMeta, derivation, reconRows }) {
  return canonicalSha256({
    scenarios,
    datePolicy,
    linkedMeta,
    derivation,
    derivedReconRows: {
      rowCount: reconRows.length,
      sha256: canonicalSha256(reconRows)
    }
  });
}

function createFundReconEvidenceProvider(options = {}) {
  const openSnapshot = options.openSnapshot || openReadSnapshot;
  const linkedRepo = options.linkedTableRepository || linkedTableRepository;
  const scenarioRepo = options.scenariosRepository || scenariosRepository;
  const channelsRepo = options.channelsRepository || channelsRepository;

  function buildSnapshot({ databasePath, bankRows, derivationEvidence, includeRows = true }) {
    const snapshot = openSnapshot(databasePath);
    try {
      const allScenarios = scenarioRepo === scenariosRepository
        ? detailedScenarios(snapshot.db)
        : scenarioRepo.listDetailedScenarios(snapshot.db);
      const enabled = allScenarios.filter((scenario) => scenario.enabled === 1 || scenario.enabled === true);
      const scenarios = enabled.filter((scenario) => !C4_CATEGORIES.includes(scenario.category));
      const resolution = resolveFundTransferDatePolicy(allScenarios);
      const flags = enabledConsumerFlags(scenarios, resolution.policy);
      const linkedMeta = linkedRepo === linkedTableRepository
        ? linkedMetaSnapshot(snapshot.db)
        : linkedRepo.readMetaSnapshot(snapshot.db);
      const derivation = assertDerivationPrepared(flags, linkedMeta, derivationEvidence);
      const channels = Array.isArray(bankRows)
        ? bankRows.map((row) => row && row.Channel != null ? String(row.Channel).trim() : '')
        : [];
      const gatewayPools = includeRows
        ? linkedRepo.readGatewayBillRowPoolsByChannels(snapshot.db, channels)
        : { exactRows: [], c3Rows: [] };
      const depositRows = includeRows && flags.refundBackfillEnabled
        ? linkedRepo.readLinkedTableRows(snapshot.db, 'bank-deposit')
        : [];
      const needsReconRows = flags.reconSourceMidEnabled || flags.dbsChargeScenarioEnabled;
      const reconRows = includeRows && needsReconRows
        ? linkedRepo.readFundTransferReconRows(snapshot.db)
        : [];
      const scenarioSnapshot = canonicalJsonSnapshot(scenarios);
      const datePolicySnapshot = canonicalJsonSnapshot(resolution.policy);
      const evidenceSignature = createEvidenceSignature({
        scenarios: scenarioSnapshot,
        datePolicy: datePolicySnapshot,
        linkedMeta,
        derivation,
        reconRows
      });
      return {
        db: snapshot.db,
        close: snapshot.close,
        deps: { channelsRepo, db: snapshot.db },
        scenarios,
        datePolicy: resolution.policy,
        initialWarnings: resolution.warnings,
        flags,
        gatewayPools,
        depositRows,
        reconRows,
        evidenceSignature,
        evidence: Object.freeze({
          scenarios: scenarioSnapshot,
          datePolicy: datePolicySnapshot,
          linkedMeta,
          derivation
        })
      };
    } catch (error) {
      snapshot.close();
      throw error;
    }
  }

  return Object.freeze({
    openRunSnapshot(input) {
      return buildSnapshot({ ...input, includeRows: true });
    },
    readCurrentSignature(input) {
      const current = buildSnapshot({ ...input, includeRows: true });
      try {
        return current.evidenceSignature;
      } finally {
        current.close();
      }
    }
  });
}

module.exports = {
  FundReconEvidenceError,
  createEvidenceSignature,
  createFundReconEvidenceProvider,
  detailedScenarios,
  enabledConsumerFlags,
  openReadSnapshot
};
