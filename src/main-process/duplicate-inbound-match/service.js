'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { readBankStatement } = require('../bank-statement-io');
const {
  createDuplicateInboundMatchStore,
  MODULE
} = require('../../backend/duplicate-inbound-match-store');
const {
  createPreFundReconciliationStore
} = require('../../backend/pre-fund-reconciliation-store');
const {
  SOURCE_TYPE_INBOUND
} = require('../pre-fund-reconciliation/mpt-schema');
const runDataStore = require('../../backend/run-data-store');
const {
  duplicateSideDbRelPath,
  sameDuplicateSideDbRelPath
} = require('../../backend/duplicate-inbound-match-side-db-identity');
const operationReceipts = require('./operation-receipt-repository');
const {
  FUND_TYPES,
  buildDuplicateInboundGroups,
  resolveDuplicateInboundMptMatches,
  resolveDuplicateInboundDocumentMatches
} = require('./matching-engine');
const {
  streamDocumentStatement
} = require('./document-statement-reader');
const { identifyInputFiles } = require('./input-classifier');
const {
  pickBankFields,
  prepareStoredBankRows,
  validateBizIds
} = require('./import-model');
const {
  consumeDuplicateInputSpool,
  validateDuplicateInputSpool,
  validateDuplicateSpoolPair
} = require('./spool-reader');
const {
  buildDefaultFileName,
  writeDuplicateInboundWorkbook
} = require('./excel-writer');

const MAIL_REMARK = '重复入账后被Reverse';

class DuplicateInboundMatchServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DuplicateInboundMatchServiceError';
    this.code = code;
    Object.assign(this, details);
  }
}

function localMonthKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('重复入金运行日期无效');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeOperationIdentity(raw, actionKey) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.actionKey !== actionKey || typeof raw.operationKey !== 'string' ||
      !raw.operationKey || raw.operationKey.trim() !== raw.operationKey ||
      typeof raw.producerTaskRunId !== 'string' || !raw.producerTaskRunId ||
      raw.producerTaskRunId.trim() !== raw.producerTaskRunId) {
    throw new DuplicateInboundMatchServiceError(
      'duplicate-inbound-operation-identity-invalid',
      `重复入金 ${actionKey} operation identity非法`
    );
  }
  return Object.freeze({
    actionKey,
    operationKey: raw.operationKey,
    producerTaskRunId: raw.producerTaskRunId
  });
}

function importEvidenceHash(bankFileHash, documentFileHash) {
  return stableHash({
    evidenceVersion: 1,
    bankFileHash: String(bankFileHash || ''),
    documentFileHash: String(documentFileHash || '')
  });
}

function runEvidenceHash(importId, bankFileHash, documentFileHash, snapshotHash) {
  return stableHash({
    evidenceVersion: 1,
    importBundleId: Number(importId),
    bankFileHash: String(bankFileHash || ''),
    documentFileHash: String(documentFileHash || ''),
    snapshotHash: String(snapshotHash || '')
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertImportNotAborted(signal) {
  if (!signal || signal.aborted !== true) return;
  throw new DuplicateInboundMatchServiceError(
    'DUPLICATE_SHUTDOWN',
    'Duplicate Service正在关闭'
  );
}

function toText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function trimText(value) {
  return toText(value).trim();
}

function countFundTypes(rows) {
  let reversalCount = 0;
  let inboundCount = 0;
  for (const row of rows) {
    const fundType = trimText(row.FundType);
    if (fundType === FUND_TYPES.REVERSAL) reversalCount += 1;
    if (fundType === FUND_TYPES.INBOUND) inboundCount += 1;
  }
  return { reversalCount, inboundCount };
}

function batchSnapshotEntry(batch) {
  return {
    batchId: Number(batch.id),
    monthKey: batch.monthKey,
    sourceType: batch.sourceType,
    sourceBatch: batch.sourceBatch,
    sourceDate: batch.sourceDate,
    sourceFileName: batch.sourceFileName,
    sourceFileSequence: Number(batch.sourceFileSequence) || 0,
    contentHash: batch.contentHash,
    declaredRowCount: Number(batch.declaredRowCount) || 0,
    rowCount: Number(batch.rowCount) || 0,
    importedAt: batch.importedAt
  };
}

function compareSnapshotEntries(left, right) {
  return String(left.monthKey).localeCompare(String(right.monthKey))
    || String(left.sourceBatch).localeCompare(String(right.sourceBatch))
    || String(left.sourceFileName).localeCompare(String(right.sourceFileName))
    || left.sourceFileSequence - right.sourceFileSequence;
}

function reasonText(group) {
  const messages = Array.isArray(group.reasons)
    ? group.reasons.map((reason) => trimText(reason && reason.message)).filter(Boolean)
    : [];
  return [...new Set(messages)].join('；') || '未满足自动匹配条件';
}

function mirrorSafeError(error) {
  const code = error && error.code ? String(error.code) : 'duplicate-inbound-match-failed';
  return new Error(`重复入金匹配运行失败（${code}）`);
}

function countManualReversals(groups) {
  return groups.reduce(
    (sum, group) => sum + group.relatedRows.filter((record) => record.fundType === FUND_TYPES.REVERSAL).length,
    0
  );
}

function recoveryRequiredError() {
  return new DuplicateInboundMatchServiceError(
    'duplicate-inbound-recovery-required',
    '重复入金存在已提交但未完成确认的运行，请先完成持久恢复'
  );
}

function frozenJsonCopy(value) {
  if (value == null) return value;
  const copied = JSON.parse(JSON.stringify(value));
  const freeze = (item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copied);
}

function exactManagedMirror(mirror, expected) {
  return Boolean(mirror && mirror.status === 'success' &&
    mirror.operationKey === expected.operationKey &&
    mirror.producerTaskRunId === expected.producerTaskRunId &&
    mirror.inputEvidenceHash === expected.inputEvidenceHash &&
    mirror.monthKey === expected.monthKey &&
    mirror.sideRunId === expected.sideRunId &&
    mirror.snapshotHash === expected.snapshotHash &&
    mirror.resultDigest === expected.resultDigest &&
    mirror.bankFileName === expected.bankFileName &&
    mirror.bankFileHash === expected.bankFileHash &&
    mirror.documentFileName === expected.documentFileName &&
    mirror.documentFileHash === expected.documentFileHash &&
    sameDuplicateSideDbRelPath(mirror.sideDbRelPath, expected.sideDbRelPath) &&
    isDeepStrictEqual(mirror.summary, expected.summary));
}

function exactRecoveryLatchPostImage(latch, expected) {
  return Boolean(latch &&
    latch.actionKey === expected.actionKey &&
    latch.operationKey === expected.operationKey &&
    latch.producerTaskRunId === expected.producerTaskRunId &&
    latch.inputEvidenceHash === expected.inputEvidenceHash &&
    latch.monthKey === expected.monthKey &&
    latch.importBundleId === expected.importBundleId &&
    (latch.sideRunId == null || latch.sideRunId === expected.sideRunId) &&
    latch.snapshotHash === expected.snapshotHash &&
    latch.bankFileName === expected.bankFileName &&
    latch.bankFileHash === expected.bankFileHash &&
    latch.documentFileName === expected.documentFileName &&
    latch.documentFileHash === expected.documentFileHash &&
    sameDuplicateSideDbRelPath(latch.sideDbRelPath, expected.sideDbRelPath) &&
    (latch.resultDigest == null || latch.resultDigest === expected.resultDigest) &&
    (latch.summary == null || isDeepStrictEqual(latch.summary, expected.summary)));
}

function runInvalidationActions(label, actions) {
  const errors = [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const error = new Error(
      `${label}存在多项失败：${errors.map((item) => item && item.message ? item.message : item).join('；')}`,
      { cause: errors[0] }
    );
    error.errors = errors;
    throw error;
  }
}

function toMptLineage(inboundRow, candidate, candidateCount) {
  const source = candidate && candidate.sourceCandidate ? candidate.sourceCandidate : {};
  return {
    bankBizId: inboundRow.bizId,
    bankSourceOrdinal: inboundRow.sourceOrdinal,
    candidateCount: Number(candidateCount) || 0,
    candidateKey: candidate ? candidate.candidateKey : '',
    candidateId: source.candidateId ?? (candidate ? candidate.candidateId : '') ?? '',
    monthKey: source.monthKey ?? '',
    rowId: source.id ?? '',
    sourceType: source.sourceType ?? '',
    sourceBatch: source.sourceBatch ?? '',
    sourceFileName: source.sourceFileName ?? '',
    sourceRowNumber: source.sourceRowNumber ?? ''
  };
}

function toDocumentLineage(orderId, candidate, candidateCount) {
  return {
    orderId,
    candidateCount: Number(candidateCount) || 0,
    documentRowKey: candidate ? candidate.documentRowKey : '',
    rowId: candidate ? candidate.rowId : '',
    fileName: candidate ? candidate.fileName : '',
    sourceOrdinal: candidate ? candidate.sourceOrdinal : null,
    excelRowNumber: candidate ? candidate.excelRowNumber : null,
    businessOrderKey: candidate ? candidate.businessOrderKey : ''
  };
}

class DuplicateInboundMatchService {
  constructor({
    userDataDir,
    database,
    mailTemplatePath,
    bankTemplatePath,
    fileHasher = hashFile,
    bankReader = readBankStatement,
    now = () => new Date()
  }) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new TypeError('重复入金匹配 service 需要 userDataDir');
    }
    if (!database) throw new TypeError('重复入金匹配 service 需要 database');
    const mirrorMethods = [
      'createDuplicateInboundMatchRunMirror',
      'finishDuplicateInboundMatchRunMirror',
      'failDuplicateInboundMatchRunMirror',
      'markDuplicateInboundMatchRunMirrorUnavailable',
      'listDuplicateInboundMatchRunMirrors'
    ];
    for (const method of mirrorMethods) {
      if (typeof database[method] !== 'function') {
        throw new TypeError(`重复入金匹配 database 缺少 ${method}`);
      }
    }
    this.userDataDir = path.resolve(userDataDir);
    this.database = database;
    this.mailTemplatePath = mailTemplatePath;
    this.bankTemplatePath = bankTemplatePath;
    this.fileHasher = fileHasher;
    this.bankReader = bankReader;
    this.now = now;
    this.store = createDuplicateInboundMatchStore(this.userDataDir, { operationReceipts });
    this.tempStore = createPreFundReconciliationStore(this.userDataDir);
    this.bankSession = null;
    this.documentSession = null;
    this.lastRun = null;
    this.recoveryLatch = null;
  }

  assertImportAllowedByRecoveryLatch() {
    if (this.recoveryLatch) throw recoveryRequiredError();
  }

  assertRunAllowedByRecoveryLatch(operationIdentity, inputEvidenceHash) {
    const latch = this.recoveryLatch;
    if (!latch) return;
    const exact = operationIdentity && operationIdentity.actionKey === latch.actionKey &&
      operationIdentity.operationKey === latch.operationKey &&
      operationIdentity.producerTaskRunId === latch.producerTaskRunId &&
      inputEvidenceHash === latch.inputEvidenceHash && this.bankSession &&
      this.bankSession.monthKey === latch.monthKey &&
      this.bankSession.importId === latch.importBundleId;
    if (!exact) throw recoveryRequiredError();
  }

  latchRecovery(expected, outcome) {
    if (outcome === 'committed') {
      this.recoveryLatch = null;
      return;
    }
    this.recoveryLatch = Object.freeze({
      ...expected,
      summary: frozenJsonCopy(expected.summary),
      outcome: outcome === 'partially-committed' ? outcome : 'unknown'
    });
    this.lastRun = null;
  }

  observeManagedRunCommit(expected) {
    try {
      const receipt = this.store.findOperationReceipt(expected.actionKey, expected.operationKey);
      const mirrors = this.database.listDuplicateInboundMatchRunMirrors()
        .filter((mirror) => mirror.operationKey === expected.operationKey);
      if (!receipt) {
        const pendingRun = this.store.getRun(expected.monthKey, expected.sideRunId);
        const exactRunningPlaceholder = pendingRun && pendingRun.status === 'running' &&
          pendingRun.id === expected.sideRunId && pendingRun.importId === expected.importBundleId &&
          pendingRun.monthKey === expected.monthKey &&
          pendingRun.snapshotHash === expected.snapshotHash && pendingRun.resultDigest === null;
        const notCommitted = mirrors.length === 0 && (!pendingRun || exactRunningPlaceholder);
        return Object.freeze({
          outcome: notCommitted ? 'not-committed' : 'unknown',
          receipt: null,
          result: null,
          mirror: null,
          expected
        });
      }
      const result = this.store.readCommittedResult(receipt.monthKey, receipt.sideRunId);
      const receiptMatches = receipt && receipt.actionKey === expected.actionKey &&
        receipt.operationKey === expected.operationKey &&
        receipt.producerTaskRunId === expected.producerTaskRunId &&
        receipt.phase === 'run-side-committed' && receipt.monthKey === expected.monthKey &&
        receipt.importBundleId === expected.importBundleId &&
        receipt.sideRunId === expected.sideRunId &&
        receipt.inputEvidenceHash === expected.inputEvidenceHash;
      const run = result && result.run;
      const resultMatches = receiptMatches && run && run.status === 'success' &&
        run.id === expected.sideRunId && run.importId === expected.importBundleId &&
        run.monthKey === expected.monthKey && run.snapshotHash === expected.snapshotHash &&
        (expected.resultDigest == null || run.resultDigest === expected.resultDigest) &&
        (expected.summary == null || isDeepStrictEqual(run.summary, expected.summary));
      if (!resultMatches) {
        return Object.freeze({ outcome: 'unknown', receipt, result, mirror: null, expected });
      }
      const authoritativeExpected = Object.freeze({
        ...expected,
        resultDigest: run.resultDigest,
        summary: run.summary
      });
      if (mirrors.length === 0) {
        return Object.freeze({
          outcome: 'partially-committed',
          receipt,
          result,
          mirror: null,
          expected: authoritativeExpected
        });
      }
      if (mirrors.length === 1 && exactManagedMirror(mirrors[0], authoritativeExpected)) {
        return Object.freeze({
          outcome: 'committed',
          receipt,
          result,
          mirror: mirrors[0],
          expected: authoritativeExpected
        });
      }
      return Object.freeze({
        outcome: 'unknown', receipt, result, mirror: null, expected: authoritativeExpected
      });
    } catch (_error) {
      return Object.freeze({
        outcome: 'unknown', receipt: null, result: null, mirror: null, expected
      });
    }
  }

  reconcileManagedRunFailure(expected) {
    const observed = this.observeManagedRunCommit(expected);
    if (observed.outcome !== 'not-committed') {
      this.latchRecovery(observed.expected || expected, observed.outcome);
      return observed;
    }
    try {
      const deleted = this.store.deleteRun(expected.monthKey, expected.sideRunId);
      if (deleted) return observed;
      const after = this.observeManagedRunCommit(expected);
      if (after.outcome === 'not-committed') return after;
      this.latchRecovery(after.expected || expected, after.outcome);
      return after;
    } catch (_cleanupError) {
      // cleanup与receipt写入由同一side DB BEGIN IMMEDIATE互斥；任何拒绝或异常都要
      // 再读authoritative状态并poison generation，不能继续猜测“仍未提交”。
      const after = this.observeManagedRunCommit(expected);
      this.latchRecovery(after.expected || expected,
        after.outcome === 'not-committed' ? 'unknown' : after.outcome);
      return after;
    }
  }

  completeManagedMirror(expected) {
    const before = this.observeManagedRunCommit(expected);
    if (before.outcome === 'committed') {
      this.latchRecovery(expected, 'committed');
      return before;
    }
    if (before.outcome !== 'partially-committed') {
      this.latchRecovery(before.expected || expected, 'unknown');
      throw recoveryRequiredError();
    }
    let writerError = null;
    try {
      this.database.createCommittedDuplicateInboundMatchRunMirror({
        monthKey: expected.monthKey,
        sideRunId: expected.sideRunId,
        snapshotHash: expected.snapshotHash,
        resultDigest: expected.resultDigest,
        bankFileName: expected.bankFileName,
        bankFileHash: expected.bankFileHash,
        documentFileName: expected.documentFileName,
        documentFileHash: expected.documentFileHash,
        sideDbRelPath: expected.sideDbRelPath,
        summary: expected.summary,
        actionKey: expected.actionKey,
        operationKey: expected.operationKey,
        producerTaskRunId: expected.producerTaskRunId,
        inputEvidenceHash: expected.inputEvidenceHash
      });
    } catch (error) {
      writerError = error;
    }
    // Writer 抛错可能发生在 Main commit 之后；必须重读 side receipt/result 与 Main mirror
    // 才能决定成功、partial 或 unknown，禁止凭异常类型猜测持久状态。
    const after = this.observeManagedRunCommit(expected);
    this.latchRecovery(after.expected || expected, after.outcome);
    if (after.outcome === 'committed') return after;
    if (writerError) throw writerError;
    throw recoveryRequiredError();
  }

  revokeSuccessfulMirrors(message) {
    for (const mirror of this.database.listDuplicateInboundMatchRunMirrors()) {
      if (mirror.status !== 'success') continue;
      const updated = this.database.markDuplicateInboundMatchRunMirrorUnavailable(
        mirror.id,
        'superseded',
        message
      );
      if (!updated) throw new Error(`重复入金主库运行镜像失效写入失败：${mirror.id}`);
    }
  }

  invalidateForNewImport() {
    // 先撤销内存资格，再做可能失败的镜像/文件清理；清理失败也不得恢复旧输入或旧导出。
    this.bankSession = null;
    this.documentSession = null;
    this.lastRun = null;
    runInvalidationActions('重复入金新导入失效处理', [
      () => this.revokeSuccessfulMirrors('已选择新的银行与单据对账单，旧运行结果已失效'),
      () => this.store.clearAll()
    ]);
  }

  buildMptSnapshot() {
    const batches = this.tempStore.listBatches({ sourceType: SOURCE_TYPE_INBOUND })
      .map(batchSnapshotEntry)
      .sort(compareSnapshotEntries);
    return {
      sourceType: SOURCE_TYPE_INBOUND,
      batchCount: batches.length,
      batches
    };
  }

  currentMptSnapshot() {
    const snapshot = this.buildMptSnapshot();
    return { snapshot, snapshotHash: stableHash(snapshot) };
  }

  unavailableLastRun(status, mirrorMessage, userMessage) {
    const updated = this.database.markDuplicateInboundMatchRunMirrorUnavailable(
      this.lastRun.mirrorRunId,
      status,
      mirrorMessage
    );
    if (!updated) {
      throw new Error(`重复入金主库运行镜像失效写入失败：${this.lastRun.mirrorRunId}`);
    }
    return {
      available: false,
      unavailable: true,
      stale: false,
      message: userMessage
    };
  }

  inspectLastRun() {
    if (!this.lastRun) return { available: false, unavailable: false, stale: false };
    const sidePath = runDataStore.sideDbPath(this.userDataDir, MODULE, this.lastRun.monthKey);
    if (!fs.existsSync(sidePath)) {
      return this.unavailableLastRun(
        'missing-side-db',
        '重复入金运行结果侧库不存在',
        '重复入金运行结果侧库不存在，请重新导入并运行'
      );
    }
    let run;
    try {
      const validated = this.store.validateRunResult(
        this.lastRun.monthKey,
        this.lastRun.sideRunId
      );
      run = validated && validated.run;
    } catch (_error) {
      return this.unavailableLastRun(
        'invalid-side-db',
        '重复入金运行结果侧库不可读',
        '重复入金运行结果不可读，请重新导入并运行'
      );
    }
    if (!run || run.status !== 'success' ||
        (this.lastRun.resultDigest && run.resultDigest !== this.lastRun.resultDigest)) {
      return this.unavailableLastRun(
        'invalid-side-db',
        '重复入金运行结果记录缺失或状态非法',
        '重复入金运行结果不可用，请重新运行'
      );
    }
    const current = this.currentMptSnapshot();
    const stale = current.snapshotHash !== this.lastRun.snapshotHash;
    return {
      available: !stale,
      unavailable: false,
      stale,
      message: stale ? '临时中台入金网关账单已变化，请重新运行' : '',
      run
    };
  }

  status() {
    const availability = this.recoveryLatch
      ? { available: false, unavailable: true, stale: false, message: '' }
      : this.inspectLastRun();
    const run = this.lastRun
      ? {
        id: this.lastRun.mirrorRunId,
        summary: { ...this.lastRun.summary },
        stale: availability.stale,
        unavailable: availability.unavailable,
        unavailableMessage: availability.message || ''
      }
      : null;
    const resultCount = run
      ? Number(run.summary.mailRowCount || 0) + Number(run.summary.manualRowCount || 0)
      : 0;
    return {
      status: 'ok',
      bank: this.bankSession
        ? {
          fileName: this.bankSession.fileName,
          rowCount: this.bankSession.rowCount,
          reversalCount: this.bankSession.reversalCount,
          inboundCount: this.bankSession.inboundCount,
          importedAt: this.bankSession.importedAt
        }
        : null,
      document: this.documentSession
        ? {
          fileName: this.documentSession.fileName,
          rowCount: this.documentSession.rowCount,
          matchableRowCount: this.documentSession.matchableRowCount,
          emptyBusinessOrderCount: this.documentSession.emptyBusinessOrderCount,
          importedAt: this.documentSession.importedAt
        }
        : null,
      run,
      canRun: Boolean(!this.recoveryLatch && this.bankSession && this.documentSession),
      canExport: Boolean(!this.recoveryLatch && this.lastRun && availability.available && resultCount > 0)
    };
  }

  detachCommittedSession() {
    this.bankSession = null;
    this.documentSession = null;
    this.lastRun = null;
  }

  detachCommittedRun() {
    this.lastRun = null;
  }

  restoreImportReceipt(receipt) {
    const imported = this.store.getImport(receipt.monthKey, receipt.importBundleId);
    if (!imported) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-import-receipt-target-missing',
        'Duplicate import receipt对应side bundle不存在'
      );
    }
    const rows = this.store.readBankRows(receipt.monthKey, receipt.importBundleId);
    const counts = countFundTypes(rows);
    this.bankSession = {
      monthKey: receipt.monthKey,
      importId: imported.id,
      fileName: imported.bank.fileName,
      fileHash: imported.bank.contentHash,
      rowCount: imported.bank.rowCount,
      reversalCount: counts.reversalCount,
      inboundCount: counts.inboundCount,
      importedAt: imported.importedAt
    };
    this.documentSession = {
      monthKey: receipt.monthKey,
      importId: imported.id,
      fileName: imported.document.fileName,
      fileHash: imported.document.contentHash,
      rowCount: imported.document.rowCount,
      matchableRowCount: imported.document.matchableRowCount,
      emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount,
      importedAt: imported.importedAt
    };
    this.lastRun = null;
    return imported;
  }

  async importFiles(filePaths, onProgress, rawOperationIdentity = null) {
    this.assertImportAllowedByRecoveryLatch();
    const operationIdentity = normalizeOperationIdentity(rawOperationIdentity, 'duplicate:import');
    if (operationIdentity) {
      const receipt = this.store.findOperationReceipt(
        operationIdentity.actionKey, operationIdentity.operationKey
      );
      if (receipt) {
        const inputs = await identifyInputFiles(filePaths);
        const [bankFileHash, documentFileHash] = await Promise.all([
          this.fileHasher(inputs.bank.filePath),
          this.fileHasher(inputs.document.filePath)
        ]);
        if (receipt.producerTaskRunId !== operationIdentity.producerTaskRunId ||
            receipt.inputEvidenceHash !== importEvidenceHash(bankFileHash, documentFileHash)) {
          throw new DuplicateInboundMatchServiceError(
            'duplicate-inbound-operation-identity-conflict',
            '同一Duplicate import operationKey的owner或输入证据冲突'
          );
        }
        const imported = this.restoreImportReceipt(receipt);
        return {
          status: 'ok',
          replayed: true,
          durableCommit: true,
          bank: {
            fileName: imported.bank.fileName,
            rowCount: imported.bank.rowCount,
            reversalCount: this.bankSession.reversalCount,
            inboundCount: this.bankSession.inboundCount
          },
          document: {
            fileName: imported.document.fileName,
            rowCount: imported.document.rowCount,
            matchableRowCount: imported.document.matchableRowCount,
            emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount
          }
        };
      }
    }
    if (operationIdentity) this.detachCommittedSession();
    else this.invalidateForNewImport();
    try {
      return await this.importFilesAfterInvalidation(filePaths, onProgress, operationIdentity);
    } catch (error) {
      this.bankSession = null;
      this.documentSession = null;
      this.lastRun = null;
      try {
        if (!operationIdentity) this.store.clearAll();
      } catch (cleanupError) {
        throw new DuplicateInboundMatchServiceError(
          'duplicate-inbound-import-rollback-failed',
          `导入失败且临时数据回收失败：${cleanupError.message || cleanupError}`,
          { cause: error, cleanupError }
        );
      }
      throw error;
    }
  }

  async importFilesAfterInvalidation(filePaths, onProgress, operationIdentity = null) {
    if (onProgress) onProgress({ stage: 'classify', message: '正在识别银行对账单和单据对账单...' });
    await yieldToEventLoop();

    const inputs = await identifyInputFiles(filePaths);
    if (onProgress) onProgress({ stage: 'read-bank', message: '正在校验银行对账单...' });
    await yieldToEventLoop();
    const [bankFileHash, documentFileHash] = await Promise.all([
      this.fileHasher(inputs.bank.filePath),
      this.fileHasher(inputs.document.filePath)
    ]);
    const parsed = this.bankReader(inputs.bank.filePath);
    const storedRows = prepareStoredBankRows(parsed.rows);
    const bankHashAfterRead = await this.fileHasher(inputs.bank.filePath);
    if (bankHashAfterRead !== bankFileHash) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-input-changed-during-import',
        '读取银行对账单期间文件发生变化，请重新选择文件'
      );
    }
    const { reversalCount, inboundCount } = countFundTypes(parsed.rows);
    const monthKey = localMonthKey(this.now());
    const inputEvidenceHash = importEvidenceHash(bankFileHash, documentFileHash);
    if (onProgress) onProgress({ stage: 'persist', message: '正在保存银行与单据导入会话...' });
    await yieldToEventLoop();
    const imported = await this.store.createImportBundle({
      monthKey,
      bank: {
        fileName: parsed.fileName,
        contentHash: bankFileHash,
        rows: storedRows
      },
      document: {
        fileName: inputs.document.fileName,
        contentHash: documentFileHash
      },
      beforeCommit: operationIdentity ? async () => {
        const [bankHashAfter, documentHashAfter] = await Promise.all([
          this.fileHasher(inputs.bank.filePath),
          this.fileHasher(inputs.document.filePath)
        ]);
        if (bankHashAfter !== bankFileHash || documentHashAfter !== documentFileHash) {
          throw new DuplicateInboundMatchServiceError(
            'duplicate-inbound-input-changed-during-import',
            '导入期间输入文件发生变化，请重新选择文件'
          );
        }
      } : null,
      operationReceipt: operationIdentity ? {
        ...operationIdentity,
        phase: 'import-side-committed',
        inputEvidenceHash
      } : null,
      writeDocumentRows: (insertRow) => streamDocumentStatement(inputs.document.filePath, {
        onRow: insertRow,
        onProgress: (progress) => {
          if (onProgress) onProgress({ stage: 'read-document', ...progress });
        }
      })
    });
    if (!operationIdentity) {
      const [bankHashAfter, documentHashAfter] = await Promise.all([
        this.fileHasher(inputs.bank.filePath),
        this.fileHasher(inputs.document.filePath)
      ]);
      if (bankHashAfter !== bankFileHash || documentHashAfter !== documentFileHash) {
        throw new DuplicateInboundMatchServiceError(
          'duplicate-inbound-input-changed-during-import',
          '导入期间输入文件发生变化，请重新选择文件'
        );
      }
    }
    const importedAt = this.now().toISOString();
    this.bankSession = {
      monthKey,
      importId: imported.id,
      fileName: parsed.fileName,
      fileHash: bankFileHash,
      rowCount: parsed.rows.length,
      reversalCount,
      inboundCount,
      importedAt
    };
    this.documentSession = {
      monthKey,
      importId: imported.id,
      fileName: imported.document.fileName,
      fileHash: documentFileHash,
      rowCount: imported.document.rowCount,
      matchableRowCount: imported.document.matchableRowCount,
      emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount,
      importedAt
    };
    if (onProgress) onProgress({ stage: 'done', message: '银行对账单和单据对账单导入完成' });
    return {
      status: 'ok',
      durableCommit: Boolean(operationIdentity),
      bank: {
        fileName: parsed.fileName,
        rowCount: parsed.rows.length,
        reversalCount,
        inboundCount
      },
      document: {
        fileName: imported.document.fileName,
        rowCount: imported.document.rowCount,
        matchableRowCount: imported.document.matchableRowCount,
        emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount
      }
    };
  }

  async importPreparedSpools(
    rawPairedImport,
    onProgress,
    rawOperationIdentity = null,
    signal = null
  ) {
    this.assertImportAllowedByRecoveryLatch();
    const operationIdentity = normalizeOperationIdentity(rawOperationIdentity, 'duplicate:import');
    if (!operationIdentity) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-operation-identity-invalid',
        'Duplicate paired import必须绑定managed operation identity'
      );
    }
    if (onProgress) {
      onProgress({ stage: 'validate-spools', message: '正在完整校验银行与单据解析结果...' });
    }
    await yieldToEventLoop();
    // 两份spool、role/source/job/op/owner identity与完整行守恒全部通过前，
    // 禁止进入side事务或Main reservation adoption。
    const pair = await validateDuplicateSpoolPair(rawPairedImport);
    const bankFileHash = pair.bank.source.sha256;
    const documentFileHash = pair.document.source.sha256;
    const inputEvidenceHash = importEvidenceHash(bankFileHash, documentFileHash);
    const receipt = this.store.findOperationReceipt(
      operationIdentity.actionKey, operationIdentity.operationKey
    );
    if (receipt) {
      if (receipt.producerTaskRunId !== operationIdentity.producerTaskRunId ||
          receipt.inputEvidenceHash !== inputEvidenceHash) {
        throw new DuplicateInboundMatchServiceError(
          'duplicate-inbound-operation-identity-conflict',
          '同一Duplicate import operationKey的owner或输入证据冲突'
        );
      }
      const imported = this.restoreImportReceipt(receipt);
      return {
        status: 'ok',
        replayed: true,
        durableCommit: true,
        bank: {
          fileName: imported.bank.fileName,
          rowCount: imported.bank.rowCount,
          reversalCount: this.bankSession.reversalCount,
          inboundCount: this.bankSession.inboundCount
        },
        document: {
          fileName: imported.document.fileName,
          rowCount: imported.document.rowCount,
          matchableRowCount: imported.document.matchableRowCount,
          emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount
        }
      };
    }

    const bankRows = [];
    await consumeDuplicateInputSpool(pair.bank, (row) => { bankRows.push(row); });
    const { reversalCount, inboundCount } = countFundTypes(
      bankRows.map((row) => row.raw)
    );
    const monthKey = localMonthKey(this.now());
    if (onProgress) {
      onProgress({ stage: 'persist', message: '正在单事务采用银行与单据解析结果...' });
    }
    await yieldToEventLoop();
    assertImportNotAborted(signal);
    const imported = await this.store.createImportBundle({
      monthKey,
      bank: {
        fileName: pair.bank.source.fileName,
        contentHash: bankFileHash,
        rows: bankRows
      },
      document: {
        fileName: pair.document.source.fileName,
        contentHash: documentFileHash
      },
      // COMMIT前再次完整读取两个task-private artifact与源文件identity，关闭
      // validate/consume之间及consume/commit之间的TOCTOU窗口。
      beforeCommit: async () => {
        await Promise.all([
          validateDuplicateInputSpool(pair.bank),
          validateDuplicateInputSpool(pair.document)
        ]);
      },
      // async权威复核完成后才检查abort；该同步guard之后，store到receipt
      // insert与COMMIT之间不得再出现yield。
      beforeCommitGuard: () => { assertImportNotAborted(signal); },
      operationReceipt: {
        ...operationIdentity,
        phase: 'import-side-committed',
        inputEvidenceHash
      },
      writeDocumentRows: (insertRow) => consumeDuplicateInputSpool(pair.document, insertRow)
    });
    const importedAt = this.now().toISOString();
    this.bankSession = {
      monthKey,
      importId: imported.id,
      fileName: pair.bank.source.fileName,
      fileHash: bankFileHash,
      rowCount: pair.bank.counts.rowCount,
      reversalCount,
      inboundCount,
      importedAt
    };
    this.documentSession = {
      monthKey,
      importId: imported.id,
      fileName: pair.document.source.fileName,
      fileHash: documentFileHash,
      rowCount: imported.document.rowCount,
      matchableRowCount: imported.document.matchableRowCount,
      emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount,
      importedAt
    };
    this.lastRun = null;
    if (onProgress) {
      onProgress({ stage: 'done', message: '银行对账单和单据对账单导入完成' });
    }
    return {
      status: 'ok',
      durableCommit: true,
      bank: {
        fileName: pair.bank.source.fileName,
        rowCount: pair.bank.counts.rowCount,
        reversalCount,
        inboundCount
      },
      document: {
        fileName: imported.document.fileName,
        rowCount: imported.document.rowCount,
        matchableRowCount: imported.document.matchableRowCount,
        emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount
      }
    };
  }

  clearPreviousRun() {
    // 新 run 一经请求，旧结果立即失效；即使侧库删除失败也不能继续导出旧结果。
    this.lastRun = null;
    runInvalidationActions('重复入金新运行失效处理', [
      () => this.revokeSuccessfulMirrors('已开始新的重复入金匹配运行，旧结果已回收'),
      () => {
        if (this.bankSession) this.store.clearRuns(this.bankSession.monthKey);
      }
    ]);
  }

  buildMailRows(successGroups) {
    return successGroups.map((group) => {
      const reversal = group.reversalRows[0];
      const orderIds = group.inboundMatches
        .slice()
        .sort((left, right) => left.inboundRow.sourceOrdinal - right.inboundRow.sourceOrdinal)
        .map((match) => trimText(match.mptCandidate.orderId))
        .filter(Boolean);
      return {
        sourceOrdinal: reversal.sourceOrdinal,
        output: {
          BillDate: reversal.row.BillDate ?? '',
          Channel: reversal.row.Channel ?? '',
          MerchantId: reversal.row.MerchantId ?? '',
          Currency: reversal.row.Currency ?? '',
          'Debit Amount': reversal.row['Debit Amount'] ?? '',
          '加款单号': orderIds.join('、'),
          '业务来源': group.commonMptFields.oppBu,
          '客户号': group.commonDocumentFields.userNo,
          '账户号': group.commonDocumentFields.accountNo,
          '备注': MAIL_REMARK
        }
      };
    }).sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  }

  buildManualRows(manualGroups) {
    return manualGroups.flatMap((group, groupOrder) => {
      const reason = reasonText(group);
      return group.relatedRows
        .slice()
        .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal)
        .map((record) => ({
          groupOrder,
          rowOrder: record.sourceOrdinal,
          reason,
          raw: pickBankFields(record.row)
        }));
    });
  }

  buildAuditRows(successGroups, manualGroups) {
    const groups = [
      ...successGroups.map((group) => ({ group, disposition: 'success' })),
      ...manualGroups.map((group) => ({ group, disposition: 'manual' }))
    ].sort((left, right) => (
      left.group.firstSourceOrdinal - right.group.firstSourceOrdinal
      || left.group.firstInputIndex - right.group.firstInputIndex
      || String(left.group.groupKey).localeCompare(String(right.group.groupKey))
    ));
    return groups.map(({ group, disposition }, groupOrder) => {
      const bankLineage = group.relatedRows.map((record) => ({
        bizId: record.bizId,
        fundType: record.fundType,
        sourceOrdinal: record.sourceOrdinal,
        excelRowNumber: record.excelRowNumber
      }));
      const mptLineage = Array.isArray(group.inboundMatches)
        ? group.inboundMatches.map((match) => toMptLineage(match.inboundRow, match.mptCandidate, 1))
        : (group.inboundCandidateSets || []).flatMap((set) => (
          set.candidates.length > 0
            ? set.candidates.map((candidate) => toMptLineage(
              set.inboundRow,
              candidate,
              set.candidateCount
            ))
            : [toMptLineage(set.inboundRow, null, set.candidateCount)]
        ));
      const documentLineage = Array.isArray(group.documentMatches)
        ? group.documentMatches.map((match) => toDocumentLineage(
          match.orderId,
          match.documentCandidate,
          1
        ))
        : (group.documentCandidateSets || []).flatMap((set) => (
          set.candidates.length > 0
            ? set.candidates.map((candidate) => toDocumentLineage(
              set.orderId,
              candidate,
              set.candidateCount
            ))
            : [toDocumentLineage(set.orderId, null, set.candidateCount)]
        ));
      return {
        groupOrder,
        disposition,
        reasonCodes: group.reasonCodes || [],
        bankLineage,
        mptLineage,
        documentLineage
      };
    });
  }

  async run({ onProgress, operationIdentity: rawOperationIdentity = null } = {}) {
    if (!this.bankSession || !this.documentSession) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-input-missing',
        '请先同时导入银行对账单和单据对账单'
      );
    }
    const operationIdentity = normalizeOperationIdentity(rawOperationIdentity, 'duplicate:run');
    const before = this.currentMptSnapshot();
    const inputEvidenceHash = runEvidenceHash(
      this.bankSession.importId,
      this.bankSession.fileHash,
      this.documentSession.fileHash,
      before.snapshotHash
    );
    this.assertRunAllowedByRecoveryLatch(operationIdentity, inputEvidenceHash);
    if (!operationIdentity) this.clearPreviousRun();
    if (operationIdentity) {
      let receipt;
      try {
        receipt = this.store.findOperationReceipt(
          operationIdentity.actionKey, operationIdentity.operationKey
        );
      } catch (error) {
        this.latchRecovery(this.recoveryLatch || {
          ...operationIdentity,
          inputEvidenceHash,
          monthKey: this.bankSession.monthKey,
          sideRunId: null,
          importBundleId: this.bankSession.importId,
          snapshotHash: before.snapshotHash,
          resultDigest: null,
          bankFileName: this.bankSession.fileName,
          bankFileHash: this.bankSession.fileHash,
          documentFileName: this.documentSession.fileName,
          documentFileHash: this.documentSession.fileHash,
          sideDbRelPath: duplicateSideDbRelPath(this.bankSession.monthKey),
          summary: null
        }, 'unknown');
        throw new DuplicateInboundMatchServiceError(
          'duplicate-inbound-run-receipt-unreadable',
          'Duplicate run receipt不可唯一读取',
          { cause: error }
        );
      }
      if (receipt) {
        const receiptExpected = {
          actionKey: receipt.actionKey,
          operationKey: receipt.operationKey,
          producerTaskRunId: receipt.producerTaskRunId,
          inputEvidenceHash: receipt.inputEvidenceHash,
          monthKey: receipt.monthKey,
          sideRunId: receipt.sideRunId,
          importBundleId: receipt.importBundleId,
          snapshotHash: before.snapshotHash,
          resultDigest: null,
          bankFileName: this.bankSession.fileName,
          bankFileHash: this.bankSession.fileHash,
          documentFileName: this.documentSession.fileName,
          documentFileHash: this.documentSession.fileHash,
          sideDbRelPath: duplicateSideDbRelPath(receipt.monthKey),
          summary: null
        };
        if (receipt.producerTaskRunId !== operationIdentity.producerTaskRunId ||
            receipt.monthKey !== this.bankSession.monthKey ||
            receipt.importBundleId !== this.bankSession.importId ||
            receipt.inputEvidenceHash !== inputEvidenceHash) {
          this.latchRecovery(receiptExpected, 'unknown');
          throw new DuplicateInboundMatchServiceError(
            'duplicate-inbound-operation-identity-conflict',
            '同一Duplicate run operationKey的owner或输入证据冲突'
          );
        }
        let result;
        try {
          result = this.store.readCommittedResult(receipt.monthKey, receipt.sideRunId);
        } catch (error) {
          this.latchRecovery(receiptExpected, 'unknown');
          throw new DuplicateInboundMatchServiceError(
            'duplicate-inbound-run-receipt-target-unreadable',
            'Duplicate run receipt对应committed side结果不可读',
            { cause: error }
          );
        }
        const committedRun = result && result.run;
        if (!committedRun || committedRun.status !== 'success') {
          this.latchRecovery(receiptExpected, 'unknown');
          throw new DuplicateInboundMatchServiceError(
            'duplicate-inbound-run-receipt-target-missing',
            'Duplicate run receipt对应committed side结果不存在'
          );
        }
        const expected = {
          actionKey: operationIdentity.actionKey,
          operationKey: operationIdentity.operationKey,
          producerTaskRunId: operationIdentity.producerTaskRunId,
          inputEvidenceHash,
          monthKey: receipt.monthKey,
          sideRunId: receipt.sideRunId,
          importBundleId: receipt.importBundleId,
          snapshotHash: committedRun.snapshotHash,
          resultDigest: committedRun.resultDigest,
          bankFileName: this.bankSession.fileName,
          bankFileHash: this.bankSession.fileHash,
          documentFileName: this.documentSession.fileName,
          documentFileHash: this.documentSession.fileHash,
          sideDbRelPath: duplicateSideDbRelPath(receipt.monthKey),
          summary: committedRun.summary
        };
        if (this.recoveryLatch && !exactRecoveryLatchPostImage(this.recoveryLatch, expected)) {
          this.latchRecovery(this.recoveryLatch, 'unknown');
          throw recoveryRequiredError();
        }
        const completed = this.completeManagedMirror(expected);
        this.lastRun = {
          monthKey: receipt.monthKey,
          sideRunId: receipt.sideRunId,
          mirrorRunId: completed.mirror.id,
          snapshotHash: committedRun.snapshotHash,
          resultDigest: committedRun.resultDigest,
          summary: committedRun.summary
        };
        return {
          status: 'success',
          runId: completed.mirror.id,
          summary: { ...committedRun.summary },
          replayed: true,
          durableCommit: true
        };
      }
    }
    if (this.recoveryLatch) {
      this.latchRecovery(this.recoveryLatch, 'unknown');
      throw recoveryRequiredError();
    }
    if (operationIdentity) this.detachCommittedRun();
    let sideRunId = null;
    let mirrorRunId = null;
    let sideCommitted = false;
    let managedMirrorCommitted = false;
    let managedExpected = null;
    try {
      sideRunId = this.store.createRun({
        monthKey: this.bankSession.monthKey,
        importId: this.bankSession.importId,
        snapshot: before.snapshot,
        snapshotHash: before.snapshotHash
      });
      if (operationIdentity) {
        managedExpected = {
          actionKey: operationIdentity.actionKey,
          operationKey: operationIdentity.operationKey,
          producerTaskRunId: operationIdentity.producerTaskRunId,
          inputEvidenceHash,
          monthKey: this.bankSession.monthKey,
          sideRunId,
          snapshotHash: before.snapshotHash,
          resultDigest: null,
          importBundleId: this.bankSession.importId,
          bankFileName: this.bankSession.fileName,
          bankFileHash: this.bankSession.fileHash,
          documentFileName: this.documentSession.fileName,
          documentFileHash: this.documentSession.fileHash,
          sideDbRelPath: duplicateSideDbRelPath(this.bankSession.monthKey),
          summary: null
        };
      }
      if (!operationIdentity) {
        mirrorRunId = this.database.createDuplicateInboundMatchRunMirror({
          monthKey: this.bankSession.monthKey,
          sideRunId,
          snapshotHash: before.snapshotHash,
          bankFileName: this.bankSession.fileName,
          bankFileHash: this.bankSession.fileHash,
          documentFileName: this.documentSession.fileName,
          documentFileHash: this.documentSession.fileHash,
          sideDbRelPath: runDataStore.sideDbRelPath(MODULE, this.bankSession.monthKey)
        });
      }

      if (onProgress) onProgress({ stage: 'bank-group', message: '正在分组银行 Reversal 与 Inbound...' });
      await yieldToEventLoop();
      const bankRows = this.store.readBankRows(this.bankSession.monthKey, this.bankSession.importId);
      const grouping = buildDuplicateInboundGroups(bankRows);
      const lookupCriteria = grouping.candidateGroups.flatMap((group) => group.inboundRows.map((row) => ({
        lookupId: row.bankRowKey,
        channel: row.row.Channel,
        merchantId: row.row.MerchantId,
        reconciliationId: row.row.ReconciliationId
      })));

      if (onProgress) onProgress({ stage: 'mpt-match', message: '正在匹配临时中台入金网关账单...' });
      await yieldToEventLoop();
      const candidatesByInbound = this.tempStore.lookupInboundRows(lookupCriteria);
      const mptResolved = resolveDuplicateInboundMptMatches({
        groupingResult: grouping,
        mptCandidatesByInbound: candidatesByInbound
      });

      if (onProgress) onProgress({ stage: 'document-match', message: '正在匹配单据对账单并校验身份字段...' });
      await yieldToEventLoop();
      const orderIds = mptResolved.finalSuccessGroups.flatMap((group) => (
        group.inboundMatches.map((match) => match.mptCandidate.orderId)
      ));
      const documentCandidatesByOrderId = this.store.lookupDocumentRows(
        this.documentSession.monthKey,
        this.documentSession.importId,
        orderIds
      );
      const resolved = resolveDuplicateInboundDocumentMatches({
        mptResult: mptResolved,
        documentCandidatesByOrderId,
        bankStats: grouping.stats
      });

      const after = this.currentMptSnapshot();
      if (after.snapshotHash !== before.snapshotHash) {
        throw new DuplicateInboundMatchServiceError(
          'duplicate-inbound-mpt-changed-during-run',
          '运行期间临时中台入金网关账单发生变化，请重新运行'
        );
      }

      const successReversals = resolved.finalSuccessGroups.length;
      const manualReversals = countManualReversals(resolved.manualGroups);
      if (grouping.stats.reversalRowCount !== successReversals + manualReversals) {
        throw new DuplicateInboundMatchServiceError(
          'duplicate-inbound-reversal-conservation-failed',
          `Reversal 行数不守恒：输入 ${grouping.stats.reversalRowCount}，成功 ${successReversals}，人工 ${manualReversals}`
        );
      }

      const mailRows = this.buildMailRows(resolved.finalSuccessGroups);
      const manualRows = this.buildManualRows(resolved.manualGroups);
      const auditRows = this.buildAuditRows(resolved.finalSuccessGroups, resolved.manualGroups);
      const summary = {
        inputRowCount: grouping.stats.inputRowCount,
        relevantRowCount: grouping.stats.relevantRowCount,
        ignoredFundTypeRowCount: grouping.stats.ignoredFundTypeRowCount,
        reversalRowCount: grouping.stats.reversalRowCount,
        inboundRowCount: grouping.stats.inboundRowCount,
        bankGroupCount: grouping.stats.groupCount,
        bankCandidateGroupCount: grouping.stats.candidateGroupCount,
        mptSuccessGroupCount: resolved.stats.mptSuccessGroupCount,
        finalSuccessGroupCount: resolved.stats.finalSuccessGroupCount,
        bankManualGroupCount: resolved.stats.bankManualGroupCount,
        mptManualGroupCount: resolved.stats.mptManualGroupCount,
        documentManualGroupCount: resolved.stats.documentManualGroupCount,
        manualGroupCount: resolved.stats.manualGroupCount,
        mailRowCount: mailRows.length,
        manualRowCount: manualRows.length,
        auditGroupCount: auditRows.length,
        pureInboundGroupCount: grouping.stats.pureInboundGroupCount,
        pureInboundRowCount: grouping.stats.pureInboundRowCount,
        documentRowCount: this.documentSession.rowCount,
        documentMatchableRowCount: this.documentSession.matchableRowCount,
        documentEmptyBusinessOrderCount: this.documentSession.emptyBusinessOrderCount,
        reasonCounts: resolved.stats.reasonCounts,
        reversalConservation: {
          input: grouping.stats.reversalRowCount,
          success: successReversals,
          manual: manualReversals,
          isBalanced: true
        }
      };

      if (managedExpected) managedExpected = { ...managedExpected, summary };
      const finishedRun = this.store.finishRun({
        monthKey: this.bankSession.monthKey,
        runId: sideRunId,
        summary,
        mailRows,
        manualRows,
        auditRows,
        operationReceipt: operationIdentity ? {
          ...operationIdentity,
          phase: 'run-side-committed',
          importBundleId: this.bankSession.importId,
          inputEvidenceHash
        } : null
      });
      sideCommitted = true;
      if (operationIdentity) {
        managedExpected = {
          ...managedExpected,
          resultDigest: finishedRun.resultDigest,
        };
        const completed = this.completeManagedMirror(managedExpected);
        mirrorRunId = completed.mirror.id;
        managedMirrorCommitted = true;
      } else {
        this.database.finishDuplicateInboundMatchRunMirror(mirrorRunId, summary);
      }
      this.lastRun = {
        monthKey: this.bankSession.monthKey,
        sideRunId,
        mirrorRunId,
        snapshotHash: before.snapshotHash,
        resultDigest: finishedRun.resultDigest,
        summary
      };
      if (onProgress) onProgress({ stage: 'done', message: '重复入金匹配完成' });
      return {
        status: 'success',
        runId: mirrorRunId,
        summary: { ...summary },
        durableCommit: Boolean(operationIdentity)
      };
    } catch (error) {
      if (sideRunId !== null && !sideCommitted) {
        if (operationIdentity && managedExpected) {
          try {
            this.reconcileManagedRunFailure(managedExpected);
          } catch (_sideError) {
            // 观察本身异常时也绝不能回退到delete；保留完整identity poison本generation。
            this.latchRecovery(managedExpected, 'unknown');
          }
        } else {
          try {
            this.store.failRun(this.bankSession.monthKey, sideRunId, error);
          } catch (_sideError) { /* 原错误优先 */ }
        }
      }
      if (mirrorRunId !== null && !(operationIdentity && managedMirrorCommitted)) {
        try {
          this.database.failDuplicateInboundMatchRunMirror(mirrorRunId, mirrorSafeError(error));
        } catch (_mirrorError) { /* 原错误优先 */ }
      }
      this.lastRun = null;
      throw error;
    }
  }

  async export({ savePath, onProgress } = {}) {
    if (this.recoveryLatch) throw recoveryRequiredError();
    if (!this.lastRun) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-run-missing',
        '请先运行重复入金匹配'
      );
    }
    const availability = this.inspectLastRun();
    if (!availability.available) {
      throw new DuplicateInboundMatchServiceError(
        availability.stale ? 'duplicate-inbound-run-stale' : 'duplicate-inbound-run-unavailable',
        availability.message || '运行结果不可用，请重新运行'
      );
    }
    let result;
    try {
      result = this.store.readResult(this.lastRun.monthKey, this.lastRun.sideRunId);
    } catch (error) {
      this.unavailableLastRun(
        'invalid-side-db',
        '重复入金运行结果明细不可读或行数不守恒',
        '重复入金运行结果不可用，请重新导入并运行'
      );
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-run-unavailable',
        '重复入金运行结果不可用，请重新导入并运行',
        { cause: error }
      );
    }
    if (!result) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-run-unavailable',
        '运行结果不可用，请重新运行'
      );
    }
    if (result.mailRows.length + result.manualRows.length === 0) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-export-empty',
        '本次运行没有成功邮件行或人工判定行，无法导出'
      );
    }
    if (onProgress) onProgress({ stage: 'write', message: '正在写入重复入金结果文件...' });
    await yieldToEventLoop();
    const written = await writeDuplicateInboundWorkbook({
      mailTemplatePath: this.mailTemplatePath,
      bankTemplatePath: this.bankTemplatePath,
      savePath,
      mailRows: result.mailRows,
      manualRows: result.manualRows
    });
    if (onProgress) onProgress({ stage: 'done', message: '重复入金结果文件已生成' });
    return written;
  }

  buildDefaultFileName(value = this.now()) {
    return buildDefaultFileName(value);
  }
}

function createDuplicateInboundMatchService(options) {
  return new DuplicateInboundMatchService(options);
}

module.exports = {
  MAIL_REMARK,
  DuplicateInboundMatchServiceError,
  DuplicateInboundMatchService,
  createDuplicateInboundMatchService,
  identifyInputFiles,
  localMonthKey,
  stableHash,
  validateBizIds,
  mirrorSafeError
};
