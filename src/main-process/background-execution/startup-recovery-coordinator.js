'use strict';

const { canonicalSha256, canonicalJsonSnapshot } = require('./canonical-json-v1');
const {
  observationRequestKey,
  observationScopeKey,
  transitionRequestKey
} = require('./recovery-control-contract');
const {
  normalizeRecoveryInspectionResult,
  normalizeRecoverySource,
  normalizeSettlementRecoveryResult
} = require('./recovery-source');

const DEFAULT_TRANSIENT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 25;
const DEFAULT_BACKOFF_MAX_MS = 250;

class StartupRecoveryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'StartupRecoveryError';
    this.code = code;
    this.details = details;
  }
}

function requireDependency(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`StartupRecoveryCoordinator 需要 ${label}.${method}`);
  }
  return value;
}

function errorCode(error, fallback) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(error.code)
    ? error.code
    : fallback;
}

function sourceKey(source) {
  return `${source.sourceKind}\u0000${source.sourceRef}`;
}

function sameOwner(left, right) {
  return left.actionKey === right.actionKey
    && left.operationKey === right.operationKey
    && left.taskRunId === right.taskRunId;
}

function holdIdFor(source) {
  return `hold:v1:${canonicalSha256([source.sourceKind, source.sourceRef])}`;
}

function safeSummaryFor(source, reasonCode) {
  return Object.freeze({
    reasonCode,
    sourceKind: source.sourceKind,
    sourceRef: source.sourceRef
  });
}

function intentSource(intent, resolvePolicy) {
  if (intent.evidenceHash !== canonicalSha256(intent.boundedEvidence)) {
    throw Object.assign(new Error('Critical Intent evidence hash 与持久 bounded evidence 不一致'), {
      code: 'RECOVERY_INTENT_EVIDENCE_HASH_MISMATCH'
    });
  }
  const sourceKind = intent.coordinationKind === 'main-owned-settlement'
    ? 'target-post-image'
    : 'critical-intent';
  const policy = resolvePolicy(intent.actionKey);
  const settlementKey = sourceKind === 'target-post-image'
    ? policy && policy.commit && policy.commit.settlementKey
    : null;
  return normalizeRecoverySource({
    contractVersion: 1,
    sourceKind,
    sourceRef: `${sourceKind}:${intent.intentId}`,
    actionKey: intent.actionKey,
    operationKey: intent.operationKey,
    taskRunId: intent.taskRunId,
    conflictScopeKey: intent.conflictScopeKey,
    inspectorKey: intent.inspectorKey,
    settlementKey: settlementKey || null,
    intentId: intent.intentId,
    evidenceVersion: intent.evidenceVersion,
    boundedEvidence: intent.boundedEvidence
  });
}

function createStartupRecoveryCoordinator(options = {}) {
  const readRepository = requireDependency(options.readRepository, 'listOpenCriticalIntents', 'readRepository');
  const inspectorRegistry = requireDependency(options.inspectorRegistry, 'get', 'inspectorRegistry');
  const providerRegistry = requireDependency(options.providerRegistry, 'list', 'providerRegistry');
  const ownerRepository = requireDependency(options.requestOwnerRepository, 'reserveTransitionRequest', 'requestOwnerRepository');
  const attemptRepository = requireDependency(options.observationAttemptRepository, 'allocateNextObservationAttempt', 'observationAttemptRepository');
  const controlRepository = requireDependency(options.recoveryControlRepository, 'runInControlTransaction', 'recoveryControlRepository');
  const resolvePolicy = typeof options.resolvePolicy === 'function' ? options.resolvePolicy : (() => null);
  const planTransitions = typeof options.planTransitions === 'function'
    ? options.planTransitions
    : (() => []);
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const transientAttempts = options.transientAttempts === undefined
    ? DEFAULT_TRANSIENT_ATTEMPTS
    : options.transientAttempts;
  if (!Number.isSafeInteger(transientAttempts) || transientAttempts < 1 || transientAttempts > 10) {
    throw new TypeError('transientAttempts 必须是 1..10');
  }
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  if (!Number.isSafeInteger(backoffBaseMs) || backoffBaseMs < 0
      || !Number.isSafeInteger(backoffMaxMs) || backoffMaxMs < backoffBaseMs) {
    throw new TypeError('backoff 配置非法');
  }

  function reserveTransition(transition, safePayload) {
    return ownerRepository.reserveTransitionRequest({
      requestKey: transitionRequestKey(transition),
      transition,
      safePayload
    });
  }

  function reserveObservation(source, eventType, safePayload, lineage = {}) {
    const scope = {
      eventType,
      actionKey: source.actionKey,
      operationKey: source.operationKey,
      taskRunId: source.taskRunId,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      batchId: lineage.batchId ?? null,
      intentId: lineage.intentId ?? source.intentId ?? null,
      holdId: lineage.holdId ?? null,
      recoveryAttemptId: lineage.recoveryAttemptId ?? null
    };
    const scopeKey = observationScopeKey(scope);
    const attempt = attemptRepository.resumePreparedObservationAttempt(scopeKey)
      || attemptRepository.allocateNextObservationAttempt(scope);
    const draft = {
      ...scope,
      observationAttemptId: attempt.observationAttemptId,
      safePayload
    };
    return ownerRepository.reserveObservationRequest({
      requestKey: observationRequestKey(draft),
      observationScopeKey: scopeKey,
      event: draft
    });
  }

  function holdTransition(source, reasonCode) {
    const summary = safeSummaryFor(source, reasonCode);
    return {
      entityKind: 'recovery-hold',
      command: 'create-or-get',
      input: {
        contractVersion: 1,
        holdId: holdIdFor(source),
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        intentId: source.intentId ?? null,
        actionKey: source.actionKey,
        operationKey: source.operationKey,
        taskRunId: source.taskRunId,
        conflictScopeKey: source.conflictScopeKey,
        reasonCode,
        safeSummary: summary,
        evidenceHash: canonicalSha256(summary)
      }
    };
  }

  function normalizePlannedTransitions(value) {
    if (!Array.isArray(value)) throw new TypeError('planTransitions 必须返回数组');
    return value.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
          || !item.transition || !item.safePayload) {
        throw new TypeError('planned transition 必须包含 transition/safePayload');
      }
      return reserveTransition(item.transition, item.safePayload);
    });
  }

  function writeAtomic(observation, transitions) {
    return controlRepository.runInControlTransaction((tx) => Object.freeze({
      observation: observation ? tx.appendObservationEvent(observation) : null,
      transitions: Object.freeze(transitions.map((request) => tx.transitionWithRecoveryEvent(request)))
    }));
  }

  function createHoldWithObservation(source, eventType, safePayload, reasonCode, extraTransitions = []) {
    const hold = holdTransition(source, reasonCode);
    const holdRequest = reserveTransition(hold, { reasonCode });
    const observation = reserveObservation(source, eventType, safePayload, {
      holdId: hold.input.holdId
    });
    return writeAtomic(observation, [holdRequest, ...extraTransitions]);
  }

  function holdOrLinkObservation(
    source,
    activeHold,
    eventType,
    safePayload,
    reasonCode,
    extraTransitions = []
  ) {
    if (!activeHold) {
      return createHoldWithObservation(
        source,
        eventType,
        safePayload,
        reasonCode,
        extraTransitions
      );
    }
    const blockedByOtherHold = activeHold.sourceKind !== source.sourceKind
      || activeHold.sourceRef !== source.sourceRef;
    const observation = reserveObservation(source, eventType, blockedByOtherHold
      ? { ...safePayload, disposition: 'blocked-by-active-scope-hold' }
      : safePayload, { holdId: activeHold.holdId });
    return writeAtomic(observation, extraTransitions);
  }

  async function backoff(attemptNumber) {
    const ms = Math.min(backoffMaxMs, backoffBaseMs * (2 ** Math.max(0, attemptNumber - 1)));
    if (ms > 0) await sleep(ms);
  }

  async function inspectSource(source, activeHold) {
    const blockedByOtherHold = activeHold
      && (activeHold.sourceKind !== source.sourceKind || activeHold.sourceRef !== source.sourceRef);
    let inspector;
    try {
      inspector = inspectorRegistry.get(source.inspectorKey);
    } catch (error) {
      holdOrLinkObservation(source, activeHold, 'inspection-failed-transient', {
        errorCode: 'RECOVERY_INSPECTOR_NOT_FOUND',
        thresholdReached: true
      }, 'INSPECTOR_UNAVAILABLE');
      throw new StartupRecoveryError(
        'STARTUP_RECOVERY_INSPECTOR_MISSING',
        `持久 RecoverySource 缺少 Inspector：${source.inspectorKey}`,
        { sourceKind: source.sourceKind, sourceRef: source.sourceRef }
      );
    }

    for (let attempt = 1; attempt <= transientAttempts; attempt += 1) {
      try {
        const inspection = normalizeRecoveryInspectionResult(source, await inspector(source));
        const safePayload = blockedByOtherHold
          ? { outcome: inspection.outcome, disposition: 'blocked-by-active-scope-hold' }
          : { outcome: inspection.outcome, evidenceHash: inspection.evidenceHash };
        const observation = reserveObservation(source, 'inspection-completed', safePayload, {
          holdId: activeHold ? activeHold.holdId : null
        });
        if (blockedByOtherHold) {
          writeAtomic(observation, []);
          return Object.freeze({ source, inspection, blocked: true, hold: activeHold });
        }
        return Object.freeze({ source, inspection, observation, blocked: false, hold: activeHold || null });
      } catch (error) {
        if (error && error.name === 'RecoverySourceValidationError') {
          holdOrLinkObservation(source, activeHold, 'inspection-failed-transient', {
            errorCode: error.code,
            thresholdReached: true
          }, 'INSPECTOR_UNAVAILABLE');
          throw new StartupRecoveryError(
            'STARTUP_RECOVERY_INSPECTION_INVALID',
            'Inspector 返回不符合 RecoveryInspectionResultV1 的结果',
            { sourceKind: source.sourceKind, sourceRef: source.sourceRef, errorCode: error.code }
          );
        }
        const thresholdReached = attempt === transientAttempts;
        const safePayload = {
          errorCode: errorCode(error, 'INSPECTOR_TRANSIENT_FAILURE'),
          thresholdReached
        };
        if (blockedByOtherHold) {
          holdOrLinkObservation(
            source,
            activeHold,
            'inspection-failed-transient',
            safePayload,
            'INSPECTOR_UNAVAILABLE'
          );
          return Object.freeze({ source, inspection: null, blocked: true, hold: activeHold });
        }
        if (thresholdReached) {
          holdOrLinkObservation(
            source,
            activeHold,
            'inspection-failed-transient',
            safePayload,
            'INSPECTOR_UNAVAILABLE'
          );
          return Object.freeze({ source, inspection: null, blocked: true, transientFailure: true });
        }
        writeAtomic(reserveObservation(source, 'inspection-failed-transient', safePayload, {
          holdId: activeHold ? activeHold.holdId : null
        }), []);
        await backoff(attempt);
      }
    }
    throw new StartupRecoveryError('STARTUP_RECOVERY_UNREACHABLE', 'Inspector retry loop 非法退出');
  }

  function immediateIntentTransitions(source, inspection) {
    if (!source.intentId) return [];
    const intent = readRepository.getCriticalIntentById(source.intentId);
    if (!intent || intent.state === 'closed') return [];
    const items = [];
    if (inspection.outcome === 'committed') {
      if (intent.state === 'acked') {
        items.push({
          transition: {
            entityKind: 'critical-intent',
            command: 'mark-committed',
            intentId: intent.intentId,
            expectedState: 'acked',
            receiptRef: { inspectionEvidenceHash: inspection.evidenceHash }
          },
          safePayload: { outcome: 'committed' }
        });
      } else if (intent.state !== 'committed') {
        return [];
      }
      // worker-critical没有后续Main-owned settlement。将 committed 结果丢失的
      // Intent close 与 inspection observation / Task / Batch / Hold transition 放进
      // 同一个RecoveryControl事务，避免启动中断留下半收口状态。
      if (!source.settlementKey) {
        items.push({
          transition: {
            entityKind: 'critical-intent',
            command: 'close',
            intentId: intent.intentId,
            expectedState: 'committed',
            result: { outcome: 'completed', recoveredFrom: 'committed-result-lost' }
          },
          safePayload: { outcome: 'committed', closed: true }
        });
      }
    } else if (['not-committed', 'compensated'].includes(inspection.outcome)
        && ['prepared', 'acked'].includes(intent.state)) {
      items.push({
        transition: {
          entityKind: 'critical-intent',
          command: 'mark-recovered',
          intentId: intent.intentId,
          expectedState: intent.state,
          inspection
        },
        safePayload: { outcome: inspection.outcome }
      });
      items.push({
        transition: {
          entityKind: 'critical-intent',
          command: 'close',
          intentId: intent.intentId,
          expectedState: 'recovered',
          result: { outcome: inspection.outcome }
        },
        safePayload: { outcome: inspection.outcome, closed: true }
      });
    }
    return items;
  }

  async function recoverWithProvider(source, inspection, activeHold) {
    let provider;
    try {
      provider = providerRegistry.get(source.settlementKey);
    } catch (_error) {
      holdOrLinkObservation(source, activeHold, 'settlement-failed-transient', {
        errorCode: 'RECOVERY_PROVIDER_NOT_FOUND',
        thresholdReached: true
      }, 'SETTLEMENT_PROVIDER_UNAVAILABLE');
      throw new StartupRecoveryError(
        'STARTUP_RECOVERY_PROVIDER_MISSING',
        `持久 RecoverySource 缺少 Provider：${source.settlementKey}`,
        { sourceKind: source.sourceKind, sourceRef: source.sourceRef }
      );
    }

    writeAtomic(reserveObservation(source, 'settlement-resumed', {
      inspectionEvidenceHash: inspection.evidenceHash
    }, { holdId: activeHold ? activeHold.holdId : null }), normalizePlannedTransitions(
      planTransitions({ phase: 'settlement-resumed', source, inspection })
    ));

    for (let attempt = 1; attempt <= transientAttempts; attempt += 1) {
      let result;
      try {
        result = normalizeSettlementRecoveryResult(source, inspection, await provider.recover(source, inspection));
      } catch (error) {
        if (error && error.name === 'RecoverySourceValidationError') {
          holdOrLinkObservation(source, activeHold, 'settlement-failed-transient', {
            errorCode: error.code,
            thresholdReached: true
          }, 'SETTLEMENT_PROVIDER_UNAVAILABLE');
          throw new StartupRecoveryError(
            'STARTUP_RECOVERY_SETTLEMENT_RESULT_INVALID',
            'Provider 返回不符合 SettlementRecoveryResultV1 的结果',
            { sourceKind: source.sourceKind, sourceRef: source.sourceRef, errorCode: error.code }
          );
        }
        const thresholdReached = attempt === transientAttempts;
        const payload = { errorCode: errorCode(error, 'SETTLEMENT_TRANSIENT_FAILURE'), thresholdReached };
        if (thresholdReached) {
          holdOrLinkObservation(
            source,
            activeHold,
            'settlement-failed-transient',
            payload,
            'SETTLEMENT_PROVIDER_UNAVAILABLE'
          );
          return Object.freeze({ outcome: 'transient-failure', held: true });
        }
        writeAtomic(reserveObservation(source, 'settlement-failed-transient', payload, {
          holdId: activeHold ? activeHold.holdId : null
        }), []);
        await backoff(attempt);
        continue;
      }

      if (result.outcome === 'transient-failure') {
        const thresholdReached = attempt === transientAttempts;
        const payload = { errorCode: result.safeError.code, thresholdReached };
        if (thresholdReached) {
          holdOrLinkObservation(
            source,
            activeHold,
            'settlement-failed-transient',
            payload,
            'SETTLEMENT_PROVIDER_UNAVAILABLE'
          );
          return Object.freeze({ ...result, held: true });
        }
        writeAtomic(reserveObservation(source, 'settlement-failed-transient', payload, {
          holdId: activeHold ? activeHold.holdId : null
        }), []);
        await backoff(attempt);
        continue;
      }

      const terminal = result.outcome === 'terminal-failure';
      const planned = normalizePlannedTransitions(planTransitions({
        phase: 'settlement-result', source, inspection, settlement: result
      }));
      if (terminal) {
        const holdReason = result.safeError.code === 'DURABILITY_BARRIER_UNAVAILABLE'
          ? 'DURABILITY_BARRIER_UNAVAILABLE'
          : 'SETTLEMENT_PROVIDER_UNAVAILABLE';
        holdOrLinkObservation(source, activeHold, 'settlement-failed-transient', {
          errorCode: result.safeError.code,
          terminal: true
        }, holdReason, planned);
        return Object.freeze({ ...result, held: true });
      }
      if (result.outcome === 'completed' && source.intentId) {
        const intent = readRepository.getCriticalIntentById(source.intentId);
        if (intent && intent.state === 'committed') {
          planned.push(reserveTransition({
            entityKind: 'critical-intent',
            command: 'close',
            intentId: intent.intentId,
            expectedState: 'committed',
            result
          }, { outcome: 'completed' }));
        }
      }
      writeAtomic(null, planned);
      return result;
    }
    throw new StartupRecoveryError('STARTUP_RECOVERY_UNREACHABLE', 'Provider retry loop 非法退出');
  }

  async function recoverSource(source, activeHold = null) {
    const inspected = await inspectSource(source, activeHold);
    if (inspected.blocked || !inspected.inspection) return inspected;
    const inspection = inspected.inspection;
    const immediateItems = immediateIntentTransitions(source, inspection);
    if (['partially-committed', 'unknown'].includes(inspection.outcome)) {
      const transitions = [
        ...normalizePlannedTransitions(planTransitions({
          phase: 'inspection-hold',
          source,
          inspection,
          holdId: activeHold ? activeHold.holdId : holdIdFor(source)
        }))
      ];
      let holdId = activeHold ? activeHold.holdId : null;
      if (!activeHold) {
        const hold = holdTransition(source, inspection.outcome === 'unknown'
          ? 'INSPECTION_UNKNOWN'
          : 'PARTIALLY_COMMITTED');
        transitions.unshift(reserveTransition(hold, { outcome: inspection.outcome }));
        holdId = hold.input.holdId;
      }
      writeAtomic(inspected.observation, transitions);
      return Object.freeze({ source, inspection, held: true, holdId });
    }

    const immediate = [
      ...immediateItems.map((item) => reserveTransition(item.transition, item.safePayload)),
      ...normalizePlannedTransitions(planTransitions({
        phase: 'inspection-result',
        source,
        inspection,
        holdId: activeHold ? activeHold.holdId : holdIdFor(source)
      }))
    ];
    writeAtomic(inspected.observation, immediate);
    if (inspection.outcome === 'committed' && source.settlementKey) {
      return recoverWithProvider(source, inspection, activeHold);
    }
    return Object.freeze({ source, inspection, held: false });
  }

  async function scanAndRecover() {
    const activeHolds = readRepository.listActiveRecoveryHolds();
    const activeByScope = new Map(activeHolds.map((hold) => [hold.conflictScopeKey, hold]));
    const candidates = [];
    for (const intent of readRepository.listOpenCriticalIntents()) {
      try {
        candidates.push(intentSource(intent, resolvePolicy));
      } catch (error) {
        const rawSource = {
          sourceKind: intent.coordinationKind === 'main-owned-settlement'
            ? 'target-post-image'
            : 'critical-intent',
          sourceRef: `${intent.coordinationKind === 'main-owned-settlement' ? 'target-post-image' : 'critical-intent'}:${intent.intentId}`,
          intentId: intent.intentId,
          actionKey: intent.actionKey,
          operationKey: intent.operationKey,
          taskRunId: intent.taskRunId,
          conflictScopeKey: intent.conflictScopeKey
        };
        const hold = holdTransition(
          rawSource,
          error && error.code === 'RECOVERY_INTENT_EVIDENCE_HASH_MISMATCH'
            ? 'INSPECTION_UNKNOWN'
            : 'SETTLEMENT_PROVIDER_UNAVAILABLE'
        );
        writeAtomic(null, [reserveTransition(hold, { errorCode: errorCode(error, 'RECOVERY_SOURCE_INVALID') })]);
        throw new StartupRecoveryError(
          'STARTUP_RECOVERY_INTENT_SOURCE_INVALID',
          'Open Critical Intent 无法转换为 RecoverySourceV1',
          { intentId: intent.intentId }
        );
      }
    }
    for (const { key, provider } of providerRegistry.list()) {
      let sources;
      try {
        sources = await provider.listOpenSources();
      } catch (error) {
        throw new StartupRecoveryError(
          'STARTUP_RECOVERY_PROVIDER_ENUMERATION_FAILED',
          `Provider source 枚举失败：${key}`,
          { providerKey: key, errorCode: errorCode(error, 'PROVIDER_ENUMERATION_FAILED') }
        );
      }
      if (!Array.isArray(sources)) {
        throw new StartupRecoveryError(
          'STARTUP_RECOVERY_PROVIDER_ENUMERATION_INVALID',
          `Provider 必须返回 RecoverySourceV1[]：${key}`
        );
      }
      for (const source of sources) {
        const normalized = normalizeRecoverySource(source);
        if (normalized.settlementKey !== key) {
          throw new StartupRecoveryError(
            'STARTUP_RECOVERY_PROVIDER_SOURCE_KEY_MISMATCH',
            `Provider ${key} 返回了其他 settlementKey 的 source`
          );
        }
        candidates.push(normalized);
      }
    }

    const deduped = new Map();
    const collisions = [];
    for (const source of candidates) {
      const key = sourceKey(source);
      const existing = deduped.get(key);
      if (!existing) deduped.set(key, source);
      else if (!sameOwner(existing, source)) {
        collisions.push({ source: existing, reasonCode: 'RECOVERY_SOURCE_OWNER_CONFLICT' });
      } else if (canonicalSha256(existing) !== canonicalSha256(source)) {
        collisions.push({ source: existing, reasonCode: 'RECOVERY_SOURCE_IDENTITY_CONFLICT' });
      }
    }
    for (const collision of collisions) {
      const left = collision.source;
      const existingHold = activeByScope.get(left.conflictScopeKey);
      if (!existingHold) {
        const hold = holdTransition(left, collision.reasonCode);
        writeAtomic(null, [reserveTransition(hold, {
          outcome: 'unknown',
          disposition: collision.reasonCode === 'RECOVERY_SOURCE_OWNER_CONFLICT'
            ? 'owner-conflict'
            : 'source-identity-conflict'
        })]);
        activeByScope.set(left.conflictScopeKey, readRepository.getRecoveryHoldBySource(
          left.sourceKind,
          left.sourceRef
        ));
      }
      deduped.delete(sourceKey(left));
    }

    for (const hold of activeHolds) {
      if (hold.sourceKind === 'manual') continue;
      if (!deduped.has(`${hold.sourceKind}\u0000${hold.sourceRef}`)) {
        throw new StartupRecoveryError(
          'STARTUP_RECOVERY_HOLD_SOURCE_MISSING',
          'Active non-manual hold 未能从 Intent/Provider 重新取得 RecoverySourceV1',
          { holdId: hold.holdId }
        );
      }
    }

    const decisions = [];
    const ordered = [...deduped.values()].sort((left, right) => {
      const scope = left.conflictScopeKey.localeCompare(right.conflictScopeKey);
      return scope || sourceKey(left).localeCompare(sourceKey(right));
    });
    for (const source of ordered) {
      decisions.push(await recoverSource(source, activeByScope.get(source.conflictScopeKey) || null));
      const activeHold = readRepository.getActiveRecoveryHoldByScope(source.conflictScopeKey);
      if (activeHold) activeByScope.set(source.conflictScopeKey, activeHold);
      else activeByScope.delete(source.conflictScopeKey);
    }
    return Object.freeze({
      sourceCount: ordered.length,
      activeHoldCount: readRepository.listActiveRecoveryHolds().length,
      decisions: Object.freeze(decisions.map((decision) => canonicalJsonSnapshot(decision)))
    });
  }

  return Object.freeze({ recoverSource, scanAndRecover });
}

module.exports = {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  DEFAULT_TRANSIENT_ATTEMPTS,
  StartupRecoveryError,
  createStartupRecoveryCoordinator
};
