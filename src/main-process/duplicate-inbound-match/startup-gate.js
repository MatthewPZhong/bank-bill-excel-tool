'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const mirrorRepository = require('../../backend/database/duplicate-inbound-match-run-repository');
const {
  createRecoveryControlReadRepository
} = require('../background-execution/critical/recovery-control-read-repository');
const { createRecoveryHoldGate } = require('../background-execution/recovery-hold-gate');
const {
  DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
  exactOperationInspection,
  operationSource,
  sideOperationSnapshots
} = require('./startup-recovery');

const DUPLICATE_STARTUP_GATE_CONTRACT_VERSION = 1;

class DuplicateManagedStartupGateError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'DuplicateManagedStartupGateError';
    this.code = code;
  }
}

function normalizeDuplicateStartupGateDescriptor(raw) {
  const ready = Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) &&
    raw.contractVersion === DUPLICATE_STARTUP_GATE_CONTRACT_VERSION &&
    raw.startupRecoveryReady === true);
  return Object.freeze({
    contractVersion: DUPLICATE_STARTUP_GATE_CONTRACT_VERSION,
    startupRecoveryReady: ready
  });
}

function createDuplicateManagedStartupGate(rawDescriptor) {
  const descriptor = normalizeDuplicateStartupGateDescriptor(rawDescriptor);

  function assertOperationAllowed(runtime, options = {}) {
    if (!descriptor.startupRecoveryReady) {
      throw new DuplicateManagedStartupGateError(
        'DUPLICATE_STARTUP_GATE_UNAVAILABLE',
        'Duplicate managed Service缺少已完成的startup recovery门禁'
      );
    }
    if (!runtime || typeof runtime.userDataDir !== 'string' ||
        typeof runtime.databasePath !== 'string') {
      throw new DuplicateManagedStartupGateError(
        'DUPLICATE_STARTUP_GATE_UNAVAILABLE',
        'Duplicate managed Service缺少持久门禁runtime身份'
      );
    }
    const databasePath = path.resolve(runtime.databasePath);
    if (!fs.existsSync(databasePath)) {
      throw new DuplicateManagedStartupGateError(
        'DUPLICATE_STARTUP_GATE_UNAVAILABLE',
        'Duplicate managed Service主库门禁不可用'
      );
    }

    let db;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 30000;');
      const readRepository = createRecoveryControlReadRepository(db);
      createRecoveryHoldGate(readRepository).assertNoRecoveryHold({
        conflictScopeKey: DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY
      });
      if (options.initializing === true) {
        const userDataDir = path.resolve(runtime.userDataDir);
        const side = sideOperationSnapshots(userDataDir);
        const mirrors = mirrorRepository.listRunMirrors(db);
        const receiptKeys = new Set(side.operations.map((item) => (
          `${item.receipt.actionKey}\0${item.receipt.operationKey}`
        )));
        const orphanMirror = mirrors.some((mirror) => !mirror.operationKey ||
          !mirror.producerTaskRunId || !receiptKeys.has(`duplicate:run\0${mirror.operationKey}`));
        const unresolvedOperation = side.operations.some((item) => {
          const source = operationSource({
            actionKey: item.receipt.actionKey,
            operationKey: item.receipt.operationKey,
            producerTaskRunId: item.receipt.producerTaskRunId
          });
          const inspection = exactOperationInspection({
            userDataDir,
            listRunMirrors: () => mirrors,
            getRecoveryAuditBySource: (sourceRef) => (
              mirrorRepository.getRecoveryAuditBySource(db, sourceRef)
            )
          }, source);
          return !['committed', 'compensated'].includes(inspection.outcome);
        });
        if (side.legacyResidue || orphanMirror || unresolvedOperation) {
          throw new DuplicateManagedStartupGateError(
            'DUPLICATE_STARTUP_RESIDUE_UNRESOLVED',
            'Duplicate managed Service检测到未归因持久证据，禁止自动冷启动'
          );
        }
      }
      return true;
    } catch (error) {
      if (error && (error.code === 'RECOVERY_HOLD_ACTIVE' ||
          error instanceof DuplicateManagedStartupGateError)) {
        throw error;
      }
      throw new DuplicateManagedStartupGateError(
        'DUPLICATE_STARTUP_GATE_UNAVAILABLE',
        'Duplicate managed Service无法核对持久startup/Hold门禁',
        { cause: error }
      );
    } finally {
      if (db) db.close();
    }
  }

  return Object.freeze({ assertOperationAllowed, descriptor });
}

module.exports = {
  DUPLICATE_STARTUP_GATE_CONTRACT_VERSION,
  DuplicateManagedStartupGateError,
  createDuplicateManagedStartupGate,
  normalizeDuplicateStartupGateDescriptor
};
