'use strict';

const runRepository = require('../../backend/vcc-op-calc-db/run-repository');
const receiptRepository = require('../../backend/vcc-op-calc-db/operation-receipt-repository');
const { freezeWorkerOperationContext } = require('../archive-center/worker-operation-context');
const {
  PARSER_RESULT_MAX_BYTES,
  centsToAmountString,
  parseAmountToCents
} = require('./parser-core');
const {
  canonicalJsonSnapshot,
  canonicalSha256
} = require('../background-execution/canonical-json-v1');

const VCC_OP_SAVE_RUN_ACTION_KEY = 'vcc-op:save-run';
const VCC_OP_SAVE_RUN_TASK_KEY = 'vccOpCalc:run:save';
const VCC_OP_SAVE_RUN_MODULE_ID = 'vcc-op-calc';
const VCC_COMPUTE_SNAPSHOT_HASH_VERSION = 1;
const VCC_SAVE_RUN_INSPECTION_EVIDENCE_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const COMMITTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class VccOpSaveRunContractError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'VccOpSaveRunContractError';
    this.code = code;
    this.outcome = options.outcome || null;
    this.recoveryRequired = options.recoveryRequired === true;
    this.preserveArchiveTaskRun = options.preserveArchiveTaskRun === true;
    this.boundedEvidence = options.boundedEvidence || null;
    this.recoveryIdentity = options.recoveryIdentity || null;
  }
}

function fail(code, message) {
  throw new VccOpSaveRunContractError(code, message);
}

function failUnknown(expected, boundedEvidence) {
  throw new VccOpSaveRunContractError(
    'VCC_OP_SAVE_RUN_OUTCOME_UNKNOWN',
    'VCC 业务 OP 保存结果存在冲突或不完整证据，需要恢复检查',
    {
      outcome: 'unknown',
      recoveryRequired: true,
      preserveArchiveTaskRun: true,
      boundedEvidence,
      // 仅供 Main/later coordinator 的进程内 typed seam；Renderer DTO 不透传本对象。
      // identity 来自 Main Task owner 与冻结 snapshot，不含文件路径或 snapshot 明文。
      recoveryIdentity: Object.freeze({
        actionKey: expected.actionKey,
        operationKey: expected.operationKey,
        taskRunId: expected.taskRunId,
        computeSnapshotHash: expected.computeSnapshotHash,
        yearMonth: expected.yearMonth,
        inputFileCount: expected.inputFileCount,
        beginOp: expected.beginOp
      })
    }
  );
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('VCC saveRun contract 需要 DatabaseSync');
  }
}

function normalizeOperationOwner(ownerInput) {
  let owner;
  try {
    owner = freezeWorkerOperationContext(ownerInput, { required: true });
  } catch (_error) {
    fail('VCC_OP_SAVE_RUN_OWNER_INVALID', 'saveRun 缺少 Main TaskLifecycle exact owner');
  }
  if (owner.taskKey !== VCC_OP_SAVE_RUN_TASK_KEY
      || owner.moduleId !== VCC_OP_SAVE_RUN_MODULE_ID) {
    fail('VCC_OP_SAVE_RUN_OWNER_MISMATCH', 'saveRun Task owner 与 canonical action binding 不一致');
  }
  return owner;
}

function addSafeCents(left, right, code, message) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) fail(code, message);
  return value;
}

function subtractSafeCents(left, right, code, message) {
  const value = left - right;
  if (!Number.isSafeInteger(value)) fail(code, message);
  return value;
}

function normalizeCanonicalAmount(value, label) {
  if (typeof value !== 'string') fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', `${label} 必须是金额字符串`);
  const parsed = parseAmountToCents(value);
  if (!parsed.ok || parsed.empty || !Number.isSafeInteger(parsed.cents)) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', `${label} 不是安全整数分金额`);
  }
  const canonical = centsToAmountString(parsed.cents);
  if (canonical !== value) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', `${label} 必须使用两位小数 canonical 金额`);
  }
  return parsed.cents;
}

function normalizeOpeningBalance(value) {
  const parsed = parseAmountToCents(value);
  if (!parsed.ok || parsed.empty || !Number.isSafeInteger(parsed.cents)) {
    fail('VCC_OP_SAVE_RUN_OPENING_BALANCE_INVALID', '期初OP 无效：必须为安全整数分数值');
  }
  return Object.freeze({
    cents: parsed.cents,
    value: centsToAmountString(parsed.cents)
  });
}

function validateComputeSnapshot(snapshotInput) {
  const snapshot = canonicalJsonSnapshot(snapshotInput, { maxBytes: PARSER_RESULT_MAX_BYTES });
  if (!YEAR_MONTH_PATTERN.test(snapshot.yearMonth || '')) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot yearMonth 非法');
  }
  if (!snapshot.totals || typeof snapshot.totals !== 'object' || Array.isArray(snapshot.totals)) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot totals 缺失');
  }
  if (!Array.isArray(snapshot.perFile) || snapshot.perFile.length < 1) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot perFile 必须至少包含一个文件');
  }
  if (snapshot.computeSnapshotContractVersion !== undefined
      && snapshot.computeSnapshotContractVersion !== 1) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot contract version 不受支持');
  }
  if (snapshot.inputEvidenceHash !== undefined
      && !SHA256_PATTERN.test(snapshot.inputEvidenceHash)) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot inputEvidenceHash 非法');
  }

  let sumRows = 0;
  let sumOutCents = 0;
  let sumInCents = 0;
  for (const file of snapshot.perFile) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot perFile 行非法');
    }
    if (typeof file.fileName !== 'string') {
      fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot fileName 必须是字符串');
    }
    if (!Number.isSafeInteger(file.rowCount) || file.rowCount < 0) {
      fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot rowCount 必须是非负安全整数');
    }
    if (!Number.isSafeInteger(file.amountOutCents)
        || !Number.isSafeInteger(file.amountInCents)
        || !Number.isSafeInteger(file.amountCents)) {
      fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot 文件金额分必须是安全整数');
    }
    const amountOut = normalizeCanonicalAmount(file.amountOut, 'perFile.amountOut');
    const amountIn = normalizeCanonicalAmount(file.amountIn, 'perFile.amountIn');
    const amount = normalizeCanonicalAmount(file.amount, 'perFile.amount');
    if (amountOut !== file.amountOutCents
        || amountIn !== file.amountInCents
        || amount !== file.amountCents
        || amount !== subtractSafeCents(
          amountIn,
          amountOut,
          'VCC_OP_SAVE_RUN_SNAPSHOT_INVALID',
          'Compute Snapshot 文件发生额超出安全整数范围'
        )) {
      fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot 文件金额字符串/整数分不一致');
    }
    sumRows = addSafeCents(
      sumRows,
      file.rowCount,
      'VCC_OP_SAVE_RUN_SNAPSHOT_INVALID',
      'Compute Snapshot 总行数超出安全整数范围'
    );
    sumOutCents = addSafeCents(
      sumOutCents,
      file.amountOutCents,
      'VCC_OP_SAVE_RUN_SNAPSHOT_INVALID',
      'Compute Snapshot 发生额出超出安全整数范围'
    );
    sumInCents = addSafeCents(
      sumInCents,
      file.amountInCents,
      'VCC_OP_SAVE_RUN_SNAPSHOT_INVALID',
      'Compute Snapshot 发生额入超出安全整数范围'
    );
  }

  const totals = snapshot.totals;
  if (!Number.isSafeInteger(totals.totalOutCents)
      || !Number.isSafeInteger(totals.totalInCents)
      || !Number.isSafeInteger(totals.totalAmountCents)) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot totals 金额分必须是安全整数');
  }
  const totalOut = normalizeCanonicalAmount(totals.totalOut, 'totals.totalOut');
  const totalIn = normalizeCanonicalAmount(totals.totalIn, 'totals.totalIn');
  const totalAmount = normalizeCanonicalAmount(totals.totalAmount, 'totals.totalAmount');
  const expectedTotalAmount = subtractSafeCents(
    sumInCents,
    sumOutCents,
    'VCC_OP_SAVE_RUN_SNAPSHOT_INVALID',
    'Compute Snapshot 总发生额超出安全整数范围'
  );
  if (totalOut !== totals.totalOutCents
      || totalIn !== totals.totalInCents
      || totalAmount !== totals.totalAmountCents
      || totals.totalOutCents !== sumOutCents
      || totals.totalInCents !== sumInCents
      || totals.totalAmountCents !== expectedTotalAmount) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot totals 与 perFile 不守恒');
  }
  if (snapshot.totalRows !== undefined && snapshot.totalRows !== sumRows) {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot totalRows 与 perFile 不守恒');
  }
  if (totals.currency !== null && typeof totals.currency !== 'string') {
    fail('VCC_OP_SAVE_RUN_SNAPSHOT_INVALID', 'Compute Snapshot currency 非法');
  }

  return Object.freeze({
    snapshot,
    yearMonth: snapshot.yearMonth,
    totals,
    perFile: snapshot.perFile,
    inputFileCount: snapshot.perFile.length,
    totalRows: sumRows
  });
}

function hashVccOpComputeSnapshot(snapshotInput) {
  const validated = validateComputeSnapshot(snapshotInput);
  return Object.freeze({
    ...validated,
    hashVersion: VCC_COMPUTE_SNAPSHOT_HASH_VERSION,
    computeSnapshotHash: canonicalSha256({
      contractVersion: VCC_COMPUTE_SNAPSHOT_HASH_VERSION,
      computeSnapshot: validated.snapshot
    }, { maxBytes: PARSER_RESULT_MAX_BYTES + 256 })
  });
}

function validateExpectedIdentity(input = {}) {
  const actionKey = String(input.actionKey || '').trim();
  const operationKey = String(input.operationKey || '').trim();
  const taskRunId = String(input.taskRunId || '').trim();
  if (actionKey !== VCC_OP_SAVE_RUN_ACTION_KEY) {
    fail('VCC_OP_SAVE_RUN_ACTION_MISMATCH', 'saveRun actionKey 非 canonical 值');
  }
  if (!operationKey || !taskRunId) {
    fail('VCC_OP_SAVE_RUN_IDENTITY_INVALID', 'saveRun operationKey/taskRunId 缺失');
  }
  if (!SHA256_PATTERN.test(input.computeSnapshotHash || '')) {
    fail('VCC_OP_SAVE_RUN_IDENTITY_INVALID', 'saveRun Compute Snapshot hash 非法');
  }
  if (!YEAR_MONTH_PATTERN.test(input.yearMonth || '')) {
    fail('VCC_OP_SAVE_RUN_IDENTITY_INVALID', 'saveRun yearMonth 非法');
  }
  if (!Number.isSafeInteger(input.inputFileCount) || input.inputFileCount < 1) {
    fail('VCC_OP_SAVE_RUN_IDENTITY_INVALID', 'saveRun inputFileCount 非法');
  }
  const openingBalance = normalizeOpeningBalance(input.beginOp);
  return Object.freeze({
    actionKey,
    operationKey,
    taskRunId,
    computeSnapshotHash: input.computeSnapshotHash,
    yearMonth: input.yearMonth,
    inputFileCount: input.inputFileCount,
    beginOp: openingBalance.value,
    beginCents: openingBalance.cents
  });
}

function inspectPersistedRun(run, files) {
  if (!run || !Number.isSafeInteger(run.id) || run.id < 1) {
    return Object.freeze({ complete: false, reasonCode: 'RUN_MISSING' });
  }
  if (!Number.isSafeInteger(run.file_count) || run.file_count < 1
      || !Array.isArray(files) || files.length !== run.file_count) {
    return Object.freeze({ complete: false, reasonCode: 'RUN_FILE_COUNT_INCOMPLETE' });
  }
  let sumOutCents = 0;
  let sumInCents = 0;
  try {
    for (const file of files) {
      if (!Number.isSafeInteger(file.row_count) || file.row_count < 0) {
        return Object.freeze({ complete: false, reasonCode: 'RUN_ROW_COUNT_INVALID' });
      }
      const amountOut = normalizeCanonicalAmount(file.amount_out, 'run_file.amount_out');
      const amountIn = normalizeCanonicalAmount(file.amount_in, 'run_file.amount_in');
      const amount = normalizeCanonicalAmount(file.amount, 'run_file.amount');
      if (amount !== subtractSafeCents(
        amountIn,
        amountOut,
        'VCC_OP_SAVE_RUN_PERSISTED_RUN_INVALID',
        'run_file 发生额超出安全整数范围'
      )) {
        return Object.freeze({ complete: false, reasonCode: 'RUN_FILE_AMOUNT_MISMATCH' });
      }
      sumOutCents = addSafeCents(
        sumOutCents,
        amountOut,
        'VCC_OP_SAVE_RUN_PERSISTED_RUN_INVALID',
        'run_file 发生额出合计超出安全整数范围'
      );
      sumInCents = addSafeCents(
        sumInCents,
        amountIn,
        'VCC_OP_SAVE_RUN_PERSISTED_RUN_INVALID',
        'run_file 发生额入合计超出安全整数范围'
      );
    }
    const totalOut = normalizeCanonicalAmount(run.total_amount_out, 'run.total_amount_out');
    const totalIn = normalizeCanonicalAmount(run.total_amount_in, 'run.total_amount_in');
    const totalAmount = normalizeCanonicalAmount(run.total_amount, 'run.total_amount');
    const beginOp = normalizeCanonicalAmount(run.begin_op, 'run.begin_op');
    const endOp = normalizeCanonicalAmount(run.end_op, 'run.end_op');
    if (totalOut !== sumOutCents
        || totalIn !== sumInCents
        || totalAmount !== subtractSafeCents(
          sumInCents,
          sumOutCents,
          'VCC_OP_SAVE_RUN_PERSISTED_RUN_INVALID',
          'run 总发生额超出安全整数范围'
        )
        || endOp !== addSafeCents(
          beginOp,
          totalAmount,
          'VCC_OP_SAVE_RUN_PERSISTED_RUN_INVALID',
          'run 期末OP超出安全整数范围'
        )) {
      return Object.freeze({ complete: false, reasonCode: 'RUN_AMOUNT_CONSERVATION_FAILED' });
    }
  } catch (error) {
    if (error instanceof VccOpSaveRunContractError) {
      return Object.freeze({ complete: false, reasonCode: 'RUN_AMOUNT_INVALID' });
    }
    throw error;
  }
  return Object.freeze({ complete: true, reasonCode: null });
}

function inspectVccOpSaveRunEvidence(db, expectedInput) {
  assertDatabase(db);
  const expected = validateExpectedIdentity(expectedInput);
  const receipts = receiptRepository.listOperationReceipts(
    db,
    expected.actionKey,
    expected.operationKey
  );
  if (receipts.length === 0) {
    return Object.freeze({
      outcome: 'not-committed',
      runId: null,
      run: null,
      boundedEvidence: Object.freeze({
        receiptCount: 0,
        operationEvidencePresent: false,
        runPresent: false,
        runComplete: false,
        metadataMatches: false
      })
    });
  }
  if (receipts.length !== 1) {
    return Object.freeze({
      outcome: 'unknown',
      runId: null,
      run: null,
      boundedEvidence: Object.freeze({
        receiptCount: receipts.length,
        operationEvidencePresent: true,
        runPresent: false,
        runComplete: false,
        metadataMatches: false,
        reasonCode: 'RECEIPT_NOT_UNIQUE'
      })
    });
  }

  const receipt = receipts[0];
  const run = runRepository.getRun(db, receipt.runId);
  const files = run ? runRepository.getRunFiles(db, receipt.runId) : [];
  const associatedReceipts = Number.isSafeInteger(receipt.runId)
    ? receiptRepository.listRunReceipts(db, receipt.runId)
    : [];
  const persisted = inspectPersistedRun(run, files);
  const committedAtValid = typeof receipt.committedAt === 'string'
    && COMMITTED_AT_PATTERN.test(receipt.committedAt)
    && Number.isFinite(Date.parse(receipt.committedAt));
  const metadataMatches = receipt.actionKey === expected.actionKey
    && receipt.operationKey === expected.operationKey
    && receipt.producerTaskRunId === expected.taskRunId
    && receipt.computeSnapshotHash === expected.computeSnapshotHash
    && receipt.yearMonth === expected.yearMonth
    && receipt.inputFileCount === expected.inputFileCount
    && associatedReceipts.length === 1;
  const runMatches = Boolean(run)
    && run.year_month === expected.yearMonth
    && run.file_count === expected.inputFileCount
    && run.begin_op === expected.beginOp;
  const committed = metadataMatches && runMatches && persisted.complete && committedAtValid;
  const reasonCode = committed
    ? null
    : !metadataMatches
      ? 'RECEIPT_METADATA_CONFLICT'
      : !run
        ? 'RECEIPT_RUN_MISSING'
        : !runMatches
          ? 'RECEIPT_RUN_CONFLICT'
          : !committedAtValid
            ? 'RECEIPT_TIME_INVALID'
            : persisted.reasonCode;
  const boundedEvidence = Object.freeze({
    receiptCount: 1,
    operationEvidencePresent: true,
    runPresent: Boolean(run),
    runComplete: persisted.complete,
    metadataMatches,
    runMatches,
    committedAtValid,
    associatedReceiptCount: associatedReceipts.length,
    persistedFileCount: files.length,
    runId: Number.isSafeInteger(receipt.runId) ? receipt.runId : null,
    reasonCode
  });
  return Object.freeze({
    outcome: committed ? 'committed' : 'unknown',
    runId: Number.isSafeInteger(receipt.runId) ? receipt.runId : null,
    run: committed ? Object.freeze({ ...run }) : null,
    boundedEvidence
  });
}

function invokeFault(injectFault, stage, context) {
  if (typeof injectFault === 'function') injectFault(stage, Object.freeze({ ...context }));
}

function rollbackOpenTransaction(db) {
  try { db.exec('ROLLBACK'); } catch (_error) { /* 原错误优先；SQLite 已自动回滚时 no-op */ }
}

function saveVccOpRunWithReceipt(options = {}) {
  const db = options.db;
  assertDatabase(db);
  const owner = normalizeOperationOwner(options.operationOwner);
  let hashed = null;
  let expected = null;
  let endOp = null;
  let transactionOpen = false;
  let runId = null;
  let outcome = 'committed';
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    invokeFault(options.injectFault, 'after-begin', { operationKey: owner.operationKey });

    // 重放合同先读取 operation receipt；不从月份/金额/最新 run 猜测。
    // 随后的 canonical hash/资金守恒校验只验证调用方冻结 postimage，不重读输入文件或重算业务。
    receiptRepository.listOperationReceipts(db, VCC_OP_SAVE_RUN_ACTION_KEY, owner.operationKey);
    hashed = hashVccOpComputeSnapshot(options.computeSnapshot);
    expected = validateExpectedIdentity({
      actionKey: VCC_OP_SAVE_RUN_ACTION_KEY,
      operationKey: owner.operationKey,
      taskRunId: owner.taskRunId,
      computeSnapshotHash: hashed.computeSnapshotHash,
      yearMonth: hashed.yearMonth,
      inputFileCount: hashed.inputFileCount,
      beginOp: options.beginOp
    });
    const endCents = addSafeCents(
      expected.beginCents,
      hashed.totals.totalAmountCents,
      'VCC_OP_SAVE_RUN_END_BALANCE_UNSAFE',
      '期末OP 超出安全整数分范围'
    );
    endOp = centsToAmountString(endCents);

    const existing = inspectVccOpSaveRunEvidence(db, expected);
    if (existing.outcome === 'committed') {
      runId = existing.runId;
      outcome = 'recovered-existing-commit';
      db.exec('COMMIT');
      transactionOpen = false;
      invokeFault(options.injectFault, 'after-replay-commit', { operationKey: owner.operationKey, runId });
      return Object.freeze({
        runId,
        endOp: existing.run.end_op,
        beginOp: existing.run.begin_op,
        yearMonth: existing.run.year_month,
        outcome
      });
    }
    if (existing.outcome === 'unknown') failUnknown(expected, existing.boundedEvidence);

    // opening balance、snapshot 金额/行数守恒与 hash 都已在持有 IMMEDIATE transaction
    // 时复核；之后才允许写业务 run。
    runId = runRepository.insertRun(db, {
      yearMonth: hashed.yearMonth,
      fileCount: hashed.inputFileCount,
      totalAmountOut: hashed.totals.totalOut,
      totalAmountIn: hashed.totals.totalIn,
      totalAmount: hashed.totals.totalAmount,
      beginOp: expected.beginOp,
      endOp,
      currency: hashed.totals.currency
    });
    runRepository.insertRunFiles(db, runId, hashed.perFile.map((file) => ({
      fileName: file.fileName,
      rowCount: file.rowCount,
      amountOut: file.amountOut,
      amountIn: file.amountIn,
      amount: file.amount
    })));
    invokeFault(options.injectFault, 'after-run-insert', { operationKey: owner.operationKey, runId });
    invokeFault(options.injectFault, 'before-receipt-insert', { operationKey: owner.operationKey, runId });
    receiptRepository.insertOperationReceipt(db, {
      actionKey: VCC_OP_SAVE_RUN_ACTION_KEY,
      operationKey: owner.operationKey,
      producerTaskRunId: owner.taskRunId,
      runId,
      yearMonth: hashed.yearMonth,
      computeSnapshotHash: hashed.computeSnapshotHash,
      inputFileCount: hashed.inputFileCount
    });
    invokeFault(options.injectFault, 'after-receipt-insert', { operationKey: owner.operationKey, runId });
    db.exec('COMMIT');
    transactionOpen = false;
    invokeFault(options.injectFault, 'after-commit', { operationKey: owner.operationKey, runId });
  } catch (error) {
    if (transactionOpen) rollbackOpenTransaction(db);
    throw error;
  }

  return Object.freeze({
    runId,
    endOp,
    beginOp: expected.beginOp,
    yearMonth: hashed.yearMonth,
    outcome
  });
}

module.exports = {
  VCC_COMPUTE_SNAPSHOT_HASH_VERSION,
  VCC_OP_SAVE_RUN_ACTION_KEY,
  VCC_OP_SAVE_RUN_MODULE_ID,
  VCC_OP_SAVE_RUN_TASK_KEY,
  VCC_SAVE_RUN_INSPECTION_EVIDENCE_VERSION,
  VccOpSaveRunContractError,
  hashVccOpComputeSnapshot,
  inspectVccOpSaveRunEvidence,
  normalizeOperationOwner,
  saveVccOpRunWithReceipt,
  validateComputeSnapshot,
  validateExpectedIdentity
};
