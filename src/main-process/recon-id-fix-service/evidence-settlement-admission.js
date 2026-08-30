'use strict';

const RECON_FIX_EVIDENCE_WRITER_KINDS = Object.freeze({
  SCENARIO: 'scenario',
  BOC_LINKED: 'boc-linked',
  JPM_IMPORT: 'jpm-import'
});

const VALID_WRITER_KINDS = new Set(Object.values(RECON_FIX_EVIDENCE_WRITER_KINDS));
const admissionStates = new WeakMap();

function admissionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
}

function assertOperationKey(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw admissionError(
      'RECON_FIX_EVIDENCE_ADMISSION_INVALID',
      `${label} 缺少 operationKey`
    );
  }
}

function assertReconFixEvidenceSettlementAdmission(admission) {
  if (!admissionStates.has(admission)) {
    throw admissionError(
      'RECON_FIX_EVIDENCE_SETTLEMENT_ADMISSION_REQUIRED',
      'ReconFix export 缺少 Main/runtime owner 的 evidence settlement admission'
    );
  }
  return admission;
}

function createReconFixEvidenceSettlementAdmission() {
  const state = {
    settlementToken: null,
    writerTokens: new Set()
  };
  const admission = Object.freeze({
    acquireSettlement(authority) {
      if (!exactKeys(authority, ['operationKey', 'resultHandle'])) {
        throw admissionError(
          'RECON_FIX_EVIDENCE_ADMISSION_INVALID',
          'ReconFix evidence settlement authority 必须是 exact operationKey/resultHandle'
        );
      }
      assertOperationKey(authority.operationKey, 'ReconFix evidence settlement authority');
      if (typeof authority.resultHandle !== 'string' || !/^[a-f0-9]{64}$/.test(authority.resultHandle)) {
        throw admissionError(
          'RECON_FIX_EVIDENCE_ADMISSION_INVALID',
          'ReconFix evidence settlement authority 缺少 exact resultHandle'
        );
      }
      if (state.settlementToken || state.writerTokens.size > 0) {
        throw admissionError(
          'RECON_FIX_EVIDENCE_SETTLEMENT_BUSY',
          'ReconFix evidence 已有 active settlement/writer'
        );
      }
      const token = Object.freeze({});
      state.settlementToken = token;
      let released = false;
      return Object.freeze({
        identity: Object.freeze({
          kind: 'settlement',
          operationKey: authority.operationKey,
          resultHandle: authority.resultHandle
        }),
        release() {
          if (released) return false;
          if (state.settlementToken !== token) {
            throw admissionError(
              'RECON_FIX_EVIDENCE_SETTLEMENT_LEASE_STALE',
              'ReconFix evidence settlement lease owner 已变化'
            );
          }
          released = true;
          state.settlementToken = null;
          return true;
        }
      });
    },
    runWriter(authority, work) {
      if (!exactKeys(authority, ['operationKey', 'writerKind']) ||
          !VALID_WRITER_KINDS.has(authority && authority.writerKind)) {
        throw admissionError(
          'RECON_FIX_EVIDENCE_ADMISSION_INVALID',
          'ReconFix evidence writer authority 必须是 exact writerKind/operationKey'
        );
      }
      assertOperationKey(authority.operationKey, 'ReconFix evidence writer authority');
      if (typeof work !== 'function') {
        throw new TypeError('ReconFix evidence writer admission 需要 work 函数');
      }
      if (state.settlementToken) {
        throw admissionError(
          'RECON_FIX_EVIDENCE_SETTLEMENT_BUSY',
          'ReconFix export settlement 期间禁止修改 authoritative evidence'
        );
      }
      const token = Object.freeze({});
      state.writerTokens.add(token);
      let released = false;
      const release = () => {
        if (released) return false;
        released = true;
        return state.writerTokens.delete(token);
      };
      let result;
      try {
        result = work();
      } catch (error) {
        release();
        throw error;
      }
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(release);
      }
      release();
      return result;
    }
  });
  admissionStates.set(admission, state);
  return admission;
}

module.exports = {
  RECON_FIX_EVIDENCE_WRITER_KINDS,
  assertReconFixEvidenceSettlementAdmission,
  createReconFixEvidenceSettlementAdmission
};
