'use strict';

const { DatabaseSync } = require('node:sqlite');

const channelsRepository = require('../../backend/database/channels-repository');
const fundTransferAccountMappingRepository = require('../../backend/database/fund-transfer-account-mapping-repository');
const linkedTableRepository = require('../../backend/database/linked-table-repository');
const scenariosRepository = require('../../backend/database/scenarios-repository');
const { canonicalSha256, canonicalJsonSnapshot } = require('../background-execution/canonical-json-v1');
const { resolveFundTransferDatePolicy } = require('../fund-transfer-date-policy');
const {
  checkFundTransferReconRowsAgainstMapping,
  createFundTransferReconAmbiguityWarning
} = require('../fund-transfer-recon-builder');
const { C4_CATEGORIES } = require('../scenario-dispatcher');
const {
  buildR5ChannelMissingDiagnosticPrefilter,
  createR5ChannelMissingDiagnosticSource
} = require('../scenario-engines/r5-fund-transfer-backfill');

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
  const reconSourceMidEnabled = paymentOfflineEnabled || configuredReconSourceMidEnabled;
  return Object.freeze({
    refundBackfillEnabled,
    paymentOfflineEnabled,
    reconSourceMidEnabled,
    dbsChargeScenarioEnabled,
    // v3.2.22：R5s2 走网关来源（按账户映射匹配网关 merchantid），与 main.js r5s2GatewaySourceEnabled 同口径。
    r5s2GatewaySourceEnabled: Boolean(owner) && !reconSourceMidEnabled
  });
}

// v3.2.22（🔴 资金红线）：账户映射摘要。调拨对账单派生（big_account）与 R5s2 网关来源须用同一份映射：
//   Main 派生完成时把派生所用映射的摘要写入 derivationEvidence.accountMappingSignature，worker 接受派生行前
//   与只读快照中的映射摘要核对，防派生后、快照前映射被改导致新旧口径混用。
function createAccountMappingSignature(accountMappingMap) {
  const entries = accountMappingMap instanceof Map ? Array.from(accountMappingMap.entries()) : [];
  return canonicalSha256(entries);
}

function assertDerivationPrepared(flags, meta, derivationEvidence, accountMappingSignature) {
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
  if (derivationEvidence.accountMappingSignature !== accountMappingSignature) {
    throw new FundReconEvidenceError(
      'FUND_RECON_DERIVATION_ACCOUNT_MAPPING_STALE',
      '调拨派生证据与当前账户映射不一致，请重新运行',
      { expectedAccountMappingSignature: accountMappingSignature }
    );
  }
  return canonicalJsonSnapshot({
    prepared: true,
    signature: derivationEvidence.signature,
    sourceSignature: derivationEvidence.sourceSignature,
    accountMappingSignature: derivationEvidence.accountMappingSignature
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

function createEvidenceSignature({ scenarios, datePolicy, linkedMeta, derivation, reconRows, accountMapping = [] }) {
  return canonicalSha256({
    scenarios,
    datePolicy,
    linkedMeta,
    derivation,
    // v3.2.22：R5s2 网关来源与多对多检测器网关侧按账户映射取值，映射变化须使已跑结果失效。
    accountMapping,
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
  const accountMappingRepo = options.fundTransferAccountMappingRepository || fundTransferAccountMappingRepository;

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
      // v3.2.22（🔴 资金红线）：与主路径同口径读账户映射（链接表账户号 → 清结算系统银行账号），供调拨派生核对、R5s2 网关来源与
      //   多对多检测器网关侧使用；先读再核对派生证据，保证派生行与网关匹配用的是同一份映射；有序 entries 进入证据签名。
      //   本轮没有任何映射消费方（调拨来源 / DBS-Charge / 网关来源均关闭）时不读，按空映射处理（与 main.js 同边界）。
      const accountMappingConsumersEnabled = flags.reconSourceMidEnabled || flags.dbsChargeScenarioEnabled ||
        flags.r5s2GatewaySourceEnabled;
      const accountMappingMap = accountMappingConsumersEnabled
        ? accountMappingRepo.getMappingMap(snapshot.db)
        : new Map();
      const accountMappingSnapshot = canonicalJsonSnapshot(Array.from(accountMappingMap.entries()));
      const derivation = assertDerivationPrepared(
        flags,
        linkedMeta,
        derivationEvidence,
        createAccountMappingSignature(accountMappingMap)
      );
      const channels = Array.isArray(bankRows)
        ? bankRows.map((row) => row && row.Channel != null ? String(row.Channel).trim() : '')
        : [];
      // v3.2.22：与主路径一致，R5s2 网关来源且映射非空时，读池的同一次扫描（快照事务内）另暂存池外诊断候选（id 与键摘要），
      //   R5 运行时在同一只读快照事务内按 id 回读摘要对得上的候选再裁决账户映射缺渠道告警，不进可写池。
      const r5ChannelMissingDiagnosticPrefilter = includeRows && flags.r5s2GatewaySourceEnabled
        ? buildR5ChannelMissingDiagnosticPrefilter(accountMappingMap)
        : null;
      const readPools = includeRows
        ? linkedRepo.readGatewayBillRowPoolsByChannels(
          snapshot.db,
          channels,
          r5ChannelMissingDiagnosticPrefilter ? { outOfPoolDiagnostic: r5ChannelMissingDiagnosticPrefilter } : undefined
        )
        : null;
      const gatewayPools = readPools
        ? { exactRows: readPools.exactRows, c3Rows: readPools.c3Rows }
        : { exactRows: [], c3Rows: [] };
      const r5ChannelMissingDiagnosticSource = r5ChannelMissingDiagnosticPrefilter
        ? createR5ChannelMissingDiagnosticSource({
          accountMappingMap,
          bankChannels: channels,
          prefilter: r5ChannelMissingDiagnosticPrefilter,
          readRowsByIds: (ids, onRow) => linkedRepo.readGatewayBillRowsByIds(snapshot.db, ids, onRow)
        })
        : null;
      const depositRows = includeRows && flags.refundBackfillEnabled
        ? linkedRepo.readLinkedTableRows(snapshot.db, 'bank-deposit')
        : [];
      const needsReconRows = flags.reconSourceMidEnabled || flags.dbsChargeScenarioEnabled;
      const reconRows = includeRows && needsReconRows
        ? linkedRepo.readFundTransferReconRows(snapshot.db)
        : [];
      // v3.2.22（🔴 资金红线）：与主路径同口径逐行核对派生行的大账号（按原始收付款账号与快照映射重算）；不一致即拒绝
      //   （派生证据的映射摘要相同也可能是旧规则生成的表）。有转义写法、大账号留空的行时追加主路径同一条结构化告警，
      //   使 worker 与主路径对相同输入报告相同的未参与匹配行数。
      let initialWarnings = resolution.warnings;
      if (reconRows.length > 0) {
        const { staleCount, ambiguousMappedAccountCount } = checkFundTransferReconRowsAgainstMapping(reconRows, accountMappingMap);
        if (staleCount > 0) {
          throw new FundReconEvidenceError(
            'FUND_RECON_DERIVATION_ACCOUNT_MAPPING_STALE',
            `调拨对账单有 ${staleCount} 行的大账号与当前账户映射不一致，请重新运行`,
            { staleCount }
          );
        }
        if (ambiguousMappedAccountCount > 0) {
          initialWarnings = [...resolution.warnings, createFundTransferReconAmbiguityWarning(ambiguousMappedAccountCount)];
        }
      }
      const scenarioSnapshot = canonicalJsonSnapshot(scenarios);
      const datePolicySnapshot = canonicalJsonSnapshot(resolution.policy);
      const evidenceSignature = createEvidenceSignature({
        scenarios: scenarioSnapshot,
        datePolicy: datePolicySnapshot,
        linkedMeta,
        derivation,
        reconRows,
        accountMapping: accountMappingSnapshot
      });
      return {
        db: snapshot.db,
        close: snapshot.close,
        deps: { channelsRepo, db: snapshot.db },
        scenarios,
        datePolicy: resolution.policy,
        initialWarnings,
        flags,
        gatewayPools,
        r5ChannelMissingDiagnosticSource,
        depositRows,
        reconRows,
        accountMappingMap,
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
  createAccountMappingSignature,
  createEvidenceSignature,
  createFundReconEvidenceProvider,
  detailedScenarios,
  enabledConsumerFlags,
  openReadSnapshot
};
