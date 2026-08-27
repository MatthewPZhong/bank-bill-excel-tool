'use strict';

const runDataStore = require('../../backend/run-data-store');
const { captureMirrorPreimage, commitMirrorCas, postImageFromSide } = require('./mirror-repository');
const { readSideOperation } = require('./outcome-inspector');
const { normalizeOperationIdentity, requireMonth } = require('./identity');

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

      async function prepareCritical(critical) {
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
        const persisted = await options.persistCriticalIntent(boundedEvidence);
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

  return Object.freeze({ withRunOperationLock });
}

module.exports = { createBankBuMainCoordinator };
