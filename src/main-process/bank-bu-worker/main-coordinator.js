'use strict';

const { isDeepStrictEqual } = require('node:util');

const runDataStore = require('../../backend/run-data-store');
const { captureMirrorPreimage, commitMirrorCas, postImageFromSide } = require('./mirror-repository');
const receiptRepository = require('./operation-receipt-repository');
const {
  completeMirrorFromCommittedSide,
  inspectImportOutcome,
  inspectRunOutcome,
  readSideOperation
} = require('./outcome-inspector');
const { normalizeOperationIdentity, requireMonth } = require('./identity');
const { BANK_BU_ACTIONS } = require('./policies');
const { BANK_BU_SINGLETON_UNIT_ID } = require('./singleton-unit');

const MUTATION_ACTIONS = new Set([BANK_BU_ACTIONS.IMPORT_MONTH, BANK_BU_ACTIONS.RUN]);

function coordinatorError(code, message) {
  return Object.assign(new Error(message), { code });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createBankBuMainCoordinator(options = {}) {
  if (!options.mainDb || typeof options.withOperationLock !== 'function' ||
      typeof options.persistCriticalIntent !== 'function') {
    throw new TypeError('BankBU Main coordinator依赖不完整');
  }
  const mainDb = options.mainDb;

  async function withRunOperationLock(identity, work) {
    if (!identity || typeof work !== 'function') throw new TypeError('BankBU run lock参数非法');
    const yearMonth = requireMonth(identity.yearMonth);
    const operationIdentity = normalizeOperationIdentity({
      actionKey: 'bank-bu:run',
      operationKey: identity.operationKey,
      producerTaskRunId: identity.producerTaskRunId
    }, 'bank-bu:run');
    if (typeof identity.userDataDir !== 'string' || !identity.userDataDir) {
      throw new TypeError('BankBU run lock缺少userDataDir');
    }
    return options.withOperationLock(yearMonth, async () => {
      let preparedEvidence = null;
      let settled = false;

      async function prepareCritical(critical, metadata = null) {
        if (preparedEvidence) throw new Error('BankBU同一locked run重复prepare critical');
        if (!critical || critical.yearMonth !== yearMonth ||
            critical.expectedNewOperationKey !== operationIdentity.operationKey ||
            !/^[a-f0-9]{64}$/.test(critical.inputEvidenceHash || '')) {
          throw new Error('BankBU critical payload与locked operation identity不一致');
        }
        const preimage = captureMirrorPreimage(mainDb, critical.yearMonth);
        const boundedEvidence = Object.freeze({
          yearMonth: critical.yearMonth,
          operationKey: operationIdentity.operationKey,
          producerTaskRunId: operationIdentity.producerTaskRunId,
          inputEvidenceHash: critical.inputEvidenceHash,
          expectedNewOperationKey: operationIdentity.operationKey,
          preimage
        });
        const persisted = await options.persistCriticalIntent(boundedEvidence, metadata);
        if (!persisted || typeof persisted.intentId !== 'string' || !persisted.intentId) {
          throw new Error('BankBU Critical Intent未持久化，禁止ACK');
        }
        preparedEvidence = boundedEvidence;
        return Object.freeze({ intentId: persisted.intentId, boundedEvidence });
      }

      async function settleRun() {
        if (!preparedEvidence || settled) throw new Error('BankBU locked run settle状态非法');
        const side = readSideOperation(identity.userDataDir, preparedEvidence);
        if (!side || side.conflict) {
          const error = new Error('BankBU side receipt/run identity不可用');
          error.code = 'BANK_BU_SIDE_IDENTITY_UNAVAILABLE';
          throw error;
        }
        const postImage = postImageFromSide({
          yearMonth: preparedEvidence.yearMonth,
          sideRun: side.sideRun,
          receipt: side.receipt,
          relPath: runDataStore.sideDbRelPath(
            runDataStore.MODULE_BANK_BU, preparedEvidence.yearMonth
          )
        });
        const result = commitMirrorCas(mainDb, preparedEvidence.preimage, postImage);
        settled = true;
        return result;
      }

      return work(Object.freeze({ prepareCritical, settleRun }));
    });
  }

  const sessionsByRoute = new Map();
  const sessionsByIntent = new Map();

  function assertSupervisorDependencies() {
    const callbacks = [
      'markCriticalCommitted', 'closeCriticalIntent', 'loadCriticalIntent', 'createRecoveryHold'
    ];
    if (typeof options.userDataDir !== 'string' || !options.userDataDir ||
        callbacks.some((name) => typeof options[name] !== 'function')) {
      throw new TypeError('BankBU Supervisor coordinator持久化/恢复依赖不完整');
    }
  }

  function routeKey(input) {
    return `${input.jobId}\u0000${input.unitId}`;
  }

  function exactSupervisorInput(input) {
    if (!input || !MUTATION_ACTIONS.has(input.actionKey) ||
        input.unitId !== BANK_BU_SINGLETON_UNIT_ID ||
        typeof input.parentOperationKey !== 'string' || !input.parentOperationKey ||
        typeof input.taskRunId !== 'string' || !input.taskRunId ||
        typeof input.jobId !== 'string' || !input.jobId ||
        !input.critical || input.critical.operationKind !==
          (input.actionKey === BANK_BU_ACTIONS.RUN ? 'run' : 'import')) {
      throw coordinatorError(
        'BANK_BU_SUPERVISOR_IDENTITY_INVALID',
        'BankBU Supervisor singleton mutation identity非法'
      );
    }
    const yearMonth = requireMonth(input.critical.yearMonth);
    if (!/^[a-f0-9]{64}$/.test(input.critical.inputEvidenceHash || '') ||
        (input.actionKey === BANK_BU_ACTIONS.RUN &&
          input.critical.expectedNewOperationKey !== input.parentOperationKey)) {
      throw coordinatorError(
        'BANK_BU_SUPERVISOR_CRITICAL_INVALID',
        'BankBU Supervisor critical evidence非法'
      );
    }
    return Object.freeze({
      actionKey: input.actionKey,
      operationKey: input.parentOperationKey,
      producerTaskRunId: input.taskRunId,
      yearMonth
    });
  }

  function criticalMetadata(input) {
    return Object.freeze({
      actionKey: input.actionKey,
      operationKey: input.parentOperationKey,
      taskRunId: input.taskRunId,
      jobId: input.jobId,
      unitId: input.unitId,
      fileOperationKey: input.parentOperationKey
    });
  }

  async function prepareImportCritical(input, identity) {
    const boundedEvidence = Object.freeze({
      yearMonth: identity.yearMonth,
      operationKey: identity.operationKey,
      producerTaskRunId: identity.producerTaskRunId,
      inputEvidenceHash: input.critical.inputEvidenceHash
    });
    const persisted = await options.persistCriticalIntent(
      boundedEvidence, criticalMetadata(input)
    );
    if (!persisted || typeof persisted.intentId !== 'string' || !persisted.intentId) {
      throw coordinatorError(
        'BANK_BU_CRITICAL_INTENT_NOT_PERSISTED',
        'BankBU import Critical Intent未持久化，禁止ACK'
      );
    }
    return Object.freeze({ intentId: persisted.intentId, boundedEvidence });
  }

  async function openLockedSession(input, identity) {
    const key = routeKey(input);
    if (sessionsByRoute.has(key)) {
      throw coordinatorError('BANK_BU_SUPERVISOR_SESSION_DUPLICATE', 'BankBU singleton unit重复prepare');
    }
    const ready = deferred();
    const release = deferred();
    const session = {
      key,
      input,
      identity,
      tools: null,
      intentId: null,
      boundedEvidence: null,
      receipt: null,
      mirror: null,
      combinedReceipt: null,
      release,
      released: false,
      lockPromise: null
    };
    sessionsByRoute.set(key, session);
    const work = async (tools) => {
      session.tools = tools;
      ready.resolve();
      await release.promise;
    };
    session.lockPromise = (identity.actionKey === BANK_BU_ACTIONS.RUN
      ? withRunOperationLock({
        yearMonth: identity.yearMonth,
        userDataDir: options.userDataDir,
        operationKey: identity.operationKey,
        producerTaskRunId: identity.producerTaskRunId
      }, work)
      : options.withOperationLock(identity.yearMonth, async () => work(Object.freeze({
        prepareCritical: () => prepareImportCritical(input, identity)
      }))));
    session.lockPromise.catch((error) => ready.reject(error));
    try {
      await ready.promise;
      return session;
    } catch (error) {
      sessionsByRoute.delete(key);
      throw error;
    }
  }

  async function releaseSession(session) {
    if (!session || session.released) return;
    session.released = true;
    session.release.resolve();
    try {
      await session.lockPromise;
    } finally {
      sessionsByRoute.delete(session.key);
      if (session.intentId) sessionsByIntent.delete(session.intentId);
    }
  }

  async function prepareAndAck(input) {
    assertSupervisorDependencies();
    const identity = exactSupervisorInput(input);
    const session = await openLockedSession(input, identity);
    try {
      const prepared = await session.tools.prepareCritical(
        input.critical,
        criticalMetadata(input)
      );
      session.intentId = prepared.intentId;
      session.boundedEvidence = prepared.boundedEvidence;
      const existing = sessionsByIntent.get(session.intentId);
      if (existing && existing !== session) {
        throw coordinatorError(
          'BANK_BU_CRITICAL_INTENT_IN_USE',
          'BankBU Critical Intent正在由另一个singleton unit处理'
        );
      }
      sessionsByIntent.set(session.intentId, session);
      return Object.freeze({
        intentId: session.intentId,
        fileOperationKey: identity.operationKey
      });
    } catch (error) {
      await releaseSession(session);
      throw error;
    }
  }

  function sessionFor(input) {
    const session = sessionsByIntent.get(input.intentId);
    if (!session || session.key !== routeKey(input) ||
        session.identity.actionKey !== input.actionKey ||
        session.identity.operationKey !== input.fileOperationKey ||
        session.identity.producerTaskRunId !== input.taskRunId) {
      throw coordinatorError(
        'BANK_BU_CRITICAL_INTENT_SESSION_MISSING',
        'BankBU Supervisor callback缺少matching locked session'
      );
    }
    return session;
  }

  function verifyReceipt(session, rawReceipt) {
    const receipt = receiptRepository.normalizeExactOperationReceipt(rawReceipt);
    const identity = session.identity;
    if (receipt.actionKey !== identity.actionKey ||
        receipt.operationKey !== identity.operationKey ||
        receipt.producerTaskRunId !== identity.producerTaskRunId ||
        receipt.yearMonth !== identity.yearMonth ||
        receipt.inputEvidenceHash !== session.boundedEvidence.inputEvidenceHash) {
      throw coordinatorError(
        'BANK_BU_SIDE_RECEIPT_IDENTITY_CONFLICT',
        'BankBU Worker receipt与Critical Intent identity冲突'
      );
    }
    if (identity.actionKey === BANK_BU_ACTIONS.RUN) {
      const side = readSideOperation(options.userDataDir, session.boundedEvidence);
      if (!side || side.conflict || !isDeepStrictEqual(side.receipt, receipt)) {
        throw coordinatorError(
          'BANK_BU_SIDE_RECEIPT_NOT_AUTHORITATIVE',
          'BankBU run receipt不能由side DB权威回读'
        );
      }
    } else {
      const inspected = inspectImportOutcome({
        userDataDir: options.userDataDir,
        yearMonth: identity.yearMonth,
        operationKey: identity.operationKey,
        producerTaskRunId: identity.producerTaskRunId,
        inputEvidenceHash: session.boundedEvidence.inputEvidenceHash
      });
      if (inspected.outcome !== 'committed' ||
          !isDeepStrictEqual(inspected.receipt, receipt)) {
        throw coordinatorError(
          'BANK_BU_SIDE_RECEIPT_NOT_AUTHORITATIVE',
          'BankBU import receipt不能由side DB权威回读'
        );
      }
    }
    return receipt;
  }

  async function observeReceipt(input) {
    const session = sessionFor(input);
    const receipt = verifyReceipt(session, input.receipt);
    session.receipt = receipt;
    if (session.identity.actionKey === BANK_BU_ACTIONS.RUN) {
      const committed = await session.tools.settleRun();
      session.mirror = committed.mirror;
      assertRunMirrorIdentity(session, session.mirror);
    }
    session.combinedReceipt = combinedReceipt(session, session.mirror);
    await options.markCriticalCommitted(Object.freeze({
      intentId: session.intentId,
      boundedEvidence: session.boundedEvidence,
      receipt: session.combinedReceipt
    }));
    return Object.freeze({
      receiptHint: Object.freeze({
        receiptKind: 'module-local',
        receiptIdentity: `${receipt.actionKey}:${receipt.operationKey}:${receipt.sideRunId || 'dataset'}`
      })
    });
  }

  function combinedReceipt(session, mirror) {
    return Object.freeze({
      side: session.receipt,
      main: mirror ? Object.freeze({
        mirrorId: mirror.mirrorId,
        yearMonth: mirror.yearMonth,
        operationKey: mirror.operationKey,
        sideRunId: mirror.sideRunId,
        inputEvidenceHash: mirror.inputEvidenceHash,
        stableHash: mirror.stableHash
      }) : null
    });
  }

  function assertRunMirrorIdentity(session, mirror) {
    if (!mirror || !Number.isSafeInteger(mirror.mirrorId) || mirror.mirrorId < 1 ||
        mirror.operationKey !== session.identity.operationKey ||
        mirror.sideRunId !== session.receipt.sideRunId ||
        mirror.inputEvidenceHash !== session.boundedEvidence.inputEvidenceHash ||
        !/^[a-f0-9]{64}$/.test(mirror.stableHash || '')) {
      throw coordinatorError(
        'BANK_BU_MAIN_MIRROR_IDENTITY_CONFLICT',
        'BankBU Main mirror未保存matching operationKey/sideRunId/mirrorId/stableHash'
      );
    }
  }

  async function settleSession(session, result) {
    if (session.identity.actionKey === BANK_BU_ACTIONS.RUN) {
      assertRunMirrorIdentity(session, session.mirror);
      if (Number(result.sideRunId) !== session.mirror.sideRunId) {
        throw coordinatorError(
          'BANK_BU_SUPERVISOR_RESULT_IDENTITY_CONFLICT',
          'BankBU unit result的sideRunId与已持久双identity receipt冲突'
        );
      }
    }
    if (!session.combinedReceipt ||
        !isDeepStrictEqual(session.combinedReceipt.side, session.receipt) ||
        (session.identity.actionKey === BANK_BU_ACTIONS.RUN
          ? !session.combinedReceipt.main ||
            session.combinedReceipt.main.mirrorId !== session.mirror.mirrorId
          : session.combinedReceipt.main !== null)) {
      throw coordinatorError(
        'BANK_BU_COMBINED_RECEIPT_IDENTITY_CONFLICT',
        'BankBU unit done缺少matching side/Main combined receipt'
      );
    }
    await options.closeCriticalIntent(Object.freeze({
      intentId: session.intentId,
      outcome: 'committed',
      receipt: session.combinedReceipt,
      result
    }));
    await releaseSession(session);
    return Object.freeze({
      outcome: 'committed', receipt: session.combinedReceipt, mirror: session.mirror
    });
  }

  async function settleCommitted(input) {
    const session = sessionFor(input);
    if (!session.receipt || !input.result || input.result.operation !==
        (session.identity.actionKey === BANK_BU_ACTIONS.RUN ? 'run' : 'import-month') ||
        input.result.inputEvidenceHash !== session.boundedEvidence.inputEvidenceHash ||
        !input.result.receipt ||
        !isDeepStrictEqual(
          receiptRepository.normalizeExactOperationReceipt(input.result.receipt),
          session.receipt
        )) {
      throw coordinatorError(
        'BANK_BU_SUPERVISOR_RESULT_IDENTITY_CONFLICT',
        'BankBU unit result与side receipt identity冲突'
      );
    }
    return settleSession(session, input.result);
  }

  async function inspectEvidence(actionKey, boundedEvidence) {
    if (actionKey === BANK_BU_ACTIONS.IMPORT_MONTH) {
      return inspectImportOutcome({
        userDataDir: options.userDataDir,
        yearMonth: boundedEvidence.yearMonth,
        operationKey: boundedEvidence.operationKey,
        producerTaskRunId: boundedEvidence.producerTaskRunId,
        inputEvidenceHash: boundedEvidence.inputEvidenceHash
      });
    }
    return inspectRunOutcome({
      mainDb,
      userDataDir: options.userDataDir,
      criticalEvidence: boundedEvidence
    });
  }

  async function recoverEvidence(actionKey, boundedEvidence) {
    let inspection = await inspectEvidence(actionKey, boundedEvidence);
    if (actionKey === BANK_BU_ACTIONS.RUN && inspection.outcome === 'partially-committed') {
      inspection = completeMirrorFromCommittedSide({
        mainDb,
        userDataDir: options.userDataDir,
        criticalEvidence: boundedEvidence
      });
    }
    return inspection;
  }

  async function resolveUncertain(input) {
    assertSupervisorDependencies();
    const session = sessionsByIntent.get(input.intentId) || null;
    let stored = null;
    if (!session) stored = await options.loadCriticalIntent(input.intentId);
    const actionKey = session ? session.identity.actionKey : stored && stored.actionKey;
    const boundedEvidence = session ? session.boundedEvidence : stored && stored.boundedEvidence;
    if (!MUTATION_ACTIONS.has(actionKey) || !boundedEvidence) {
      throw coordinatorError(
        'BANK_BU_CRITICAL_INTENT_MISSING',
        'BankBU recovery缺少持久化Critical Intent evidence'
      );
    }
    const operationKey = session ? session.identity.operationKey : stored.operationKey;
    const taskRunId = session ? session.identity.producerTaskRunId : stored.taskRunId;
    if ((session && session.key !== routeKey(input)) ||
        actionKey !== input.actionKey || operationKey !== input.fileOperationKey ||
        taskRunId !== input.taskRunId || boundedEvidence.operationKey !== operationKey ||
        boundedEvidence.producerTaskRunId !== taskRunId) {
      throw coordinatorError(
        'BANK_BU_RECOVERY_IDENTITY_CONFLICT',
        'BankBU recovery callback与持久化Intent identity冲突'
      );
    }
    let inspection;
    try {
      inspection = session
        ? await recoverEvidence(actionKey, boundedEvidence)
        : await options.withOperationLock(
          boundedEvidence.yearMonth,
          () => recoverEvidence(actionKey, boundedEvidence)
        );
      if (inspection.outcome === 'committed' || inspection.outcome === 'not-committed') {
        let receipt = null;
        if (inspection.outcome === 'committed' && actionKey === BANK_BU_ACTIONS.RUN) {
          const side = readSideOperation(options.userDataDir, boundedEvidence);
          if (side && !side.conflict) receipt = side.receipt;
        } else if (inspection.outcome === 'committed') {
          receipt = inspection.receipt;
        }
        const mirror = inspection.mirror || null;
        await options.closeCriticalIntent(Object.freeze({
          intentId: input.intentId,
          outcome: inspection.outcome,
          receipt: receipt ? Object.freeze({
            side: receipt,
            main: mirror ? combinedReceipt({ receipt }, mirror).main : null
          }) : null,
          result: null
        }));
      } else {
        await options.createRecoveryHold(Object.freeze({
          intentId: input.intentId,
          actionKey,
          yearMonth: boundedEvidence.yearMonth,
          operationKey: boundedEvidence.operationKey,
          outcome: inspection.outcome,
          reason: inspection.reason || 'bank-bu-identity-unknown'
        }));
      }
      return Object.freeze({
        ...inspection,
        ...(inspection.outcome === 'unknown' ? { held: true } : {})
      });
    } finally {
      if (session) await releaseSession(session);
    }
  }

  return Object.freeze({
    observeReceipt,
    prepareAndAck,
    resolveUncertain,
    settleCommitted,
    withRunOperationLock
  });
}

module.exports = { createBankBuMainCoordinator };
