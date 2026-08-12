'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  authorizePositionImportApply,
  assertPositionRecoveryInputsUnchanged,
  positionCommittedRecoveryArchiveFiles,
  positionRecoveryCleanupInputPaths,
  positionUncommittedRecoveryInputPaths,
  positionRecoveryArchiveFiles,
  positionArchiveIntentEvidence,
  positionBusinessStateForResult,
  positionPersistentStagingProtectionPaths,
  positionReconciliationFailureResult,
  runPositionOperationLifecycle,
  settlePositionRecoveredTask,
  settlePositionArchiveResult
} = require('../../../src/main-process/position-reconciliation/operation-lifecycle');
const {
  assertStagedInputUnchanged,
  hashFileSha256Sync
} = require('../../../src/main-process/position-reconciliation/input-staging');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');

const SUCCESS_STATUSES = new Set(['ok', 'success']);
const INPUT_EVIDENCE = Object.freeze({
  sourceSnapshot: Object.freeze({
    sizeBytes: 10,
    mtimeMs: 20,
    ctimeMs: 30,
    ino: 40
  }),
  sha256: 'a'.repeat(64),
  sizeBytes: 10
});

function checkpoint(generation) {
  return {
    identity: 'position-side-db',
    generation,
    token: `generation-${generation}`
  };
}

function failureResult(error) {
  return positionReconciliationFailureResult(error);
}

test('用户取消导入返回 cancelled，其他异常仍返回 failed', () => {
  const cancelled = positionReconciliationFailureResult(Object.assign(
    new Error('平盘导入已取消'),
    { code: 'position-import-cancelled' }
  ));
  assert.deepEqual(cancelled, {
    status: 'cancelled',
    code: 'position-import-cancelled',
    message: '平盘导入已取消',
    detailLines: []
  });

  const failed = positionReconciliationFailureResult(Object.assign(
    new Error('写入失败'),
    { code: 'position-write-failed', detailLines: ['detail'] }
  ));
  assert.deepEqual(failed, {
    status: 'failed',
    code: 'position-write-failed',
    message: '写入失败',
    detailLines: ['detail']
  });
});

test('暂存保护集合同时包含持久 outbox 与当前主库 pending 输入', () => {
  assert.deepEqual(positionPersistentStagingProtectionPaths(
    ['/tmp/outbox.xlsx'],
    {
      archiveFiles: [
        {
          filePath: '/tmp/pending.xlsx',
          role: 'input',
          sourceSnapshot: INPUT_EVIDENCE.sourceSnapshot,
          sha256: INPUT_EVIDENCE.sha256,
          sizeBytes: INPUT_EVIDENCE.sizeBytes
        },
        {
          filePath: '/tmp/result.xlsx',
          role: 'output',
          beforeSnapshot: null
        }
      ]
    }
  ), ['/tmp/outbox.xlsx', '/tmp/pending.xlsx']);
  assert.equal(positionPersistentStagingProtectionPaths([], {
    archiveFiles: [{ role: 'input', filePath: '' }]
  }), null);
  assert.equal(positionPersistentStagingProtectionPaths(null, null), null);
});

async function runHarness({
  operationToken,
  baseCheckpoint,
  currentCheckpoint,
  businessResult,
  archiveResult,
  archiveFiles = [],
  beforeArchive,
  persistRecovery
}) {
  let pending = null;
  let syncedCheckpoint = null;
  let cleanupCount = 0;
  const durableReferences = [];
  const warnings = [];
  const result = await runPositionOperationLifecycle({
    operationToken,
    pending: {
      operationToken,
      channel: 'position-reconciliation:source:prepare-import',
      baseCheckpoint,
      archiveRequired: true,
      archiveState: 'awaiting-intent',
      businessState: 'running',
      archiveFiles
    },
    writeInitialPending: (value) => {
      pending = structuredClone(value);
    },
    runInContext: (task) => task(),
    operation: async () => {
      if (beforeArchive) await beforeArchive();
      pending = {
        ...pending,
        businessState: positionBusinessStateForResult(businessResult, SUCCESS_STATUSES)
      };
      return settlePositionArchiveResult({
        result: businessResult,
        archiveTask: Promise.resolve(archiveResult),
        runtime: { stagingPaths: ['/tmp/position-staging'] },
        persistRecovery: () => (
          persistRecovery
            ? persistRecovery({ pending, currentCheckpoint })
            : null
        ),
        markDurable: (value) => {
          durableReferences.push(value);
          pending = {
            ...pending,
            archiveState: 'durable',
            archiveReference: value.batchId || value.outboxId || ''
          };
        },
        markIncomplete: (value) => {
          pending = {
            ...pending,
            archiveState: 'incomplete',
            archiveWarning: value && value.warning
              ? value.warning
              : value || null
          };
        },
        cleanup: () => {
          cleanupCount += 1;
        },
        reportFailure: (warning) => {
          warnings.push(warning);
        }
      });
    },
    readPending: () => pending,
    syncCheckpoint: () => {
      syncedCheckpoint = structuredClone(currentCheckpoint);
    },
    clearPending: () => {
      pending = null;
    },
    failureResult
  });
  return {
    result,
    pending,
    syncedCheckpoint,
    cleanupCount,
    durableReferences,
    warnings
  };
}

test('存档完成后会等待异步清理结束再返回业务结果', async () => {
  let releaseCleanup;
  let cleanupFinished = false;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const settling = settlePositionArchiveResult({
    result: { status: 'success' },
    archiveTask: Promise.resolve({ status: 'success' }),
    runtime: { cleanupPaths: ['/tmp/position-staging'] },
    persistRecovery: () => null,
    markDurable: () => undefined,
    cleanup: async () => {
      await cleanupGate;
      cleanupFinished = true;
    },
    reportFailure: () => undefined,
    registrationFailureResult: () => ({ status: 'failed' })
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupFinished, false);
  releaseCleanup();
  assert.deepEqual(await settling, { status: 'success' });
  assert.equal(cleanupFinished, true);
});

test('账户表 prepare 不建空存档且清除 pending，apply 后正式存档并推进 checkpoint', async () => {
  const prepared = await runHarness({
    operationToken: 'prepare-account',
    baseCheckpoint: checkpoint(0),
    currentCheckpoint: checkpoint(0),
    businessResult: {
      status: 'ok',
      successCount: 0,
      confirmationCount: 1,
      archiveDeferred: true,
      inputPaths: []
    },
    archiveResult: { handled: false }
  });
  assert.equal(prepared.result.status, 'ok');
  assert.equal(prepared.pending, null);
  assert.deepEqual(prepared.syncedCheckpoint, checkpoint(0));
  assert.equal(prepared.cleanupCount, 1);
  assert.deepEqual(prepared.durableReferences, [{ handled: false }]);

  const applied = await runHarness({
    operationToken: 'apply-account',
    baseCheckpoint: checkpoint(0),
    currentCheckpoint: checkpoint(1),
    businessResult: {
      status: 'ok',
      successCount: 1,
      confirmationCount: 0,
      inputPaths: ['/tmp/account-staged.xlsx']
    },
    archiveFiles: [{
      filePath: '/tmp/account-staged.xlsx',
      role: 'input',
      ...INPUT_EVIDENCE
    }],
    archiveResult: { batchId: 'archive-batch-1' }
  });
  assert.equal(applied.result.status, 'ok');
  assert.equal(applied.pending, null);
  assert.deepEqual(applied.syncedCheckpoint, checkpoint(1));
  assert.equal(applied.cleanupCount, 1);
  assert.deepEqual(applied.durableReferences, [{ batchId: 'archive-batch-1' }]);
});

test('输出已发布但业务状态落库失败时登记 outbox、保留文件并清除 pending', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'position-output-recovery-'));
  const outputPath = path.join(directory, 'result.xlsx');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outbox = [];
  const recovered = await runHarness({
    operationToken: 'export-state-failed',
    baseCheckpoint: checkpoint(0),
    currentCheckpoint: checkpoint(0),
    businessResult: {
      status: 'failed',
      code: 'position-export-state-failed',
      message: 'markRunExported failed'
    },
    archiveFiles: [{
      filePath: outputPath,
      role: 'output',
      beforeSnapshot: null
    }],
    beforeArchive: () => {
      fs.writeFileSync(outputPath, 'published-result');
    },
    archiveResult: { handled: false },
    persistRecovery: ({ pending, currentCheckpoint }) => {
      const evidence = positionArchiveIntentEvidence(pending, currentCheckpoint, {
        statSync: fs.statSync,
        sourceSnapshotFromStat,
        sourceSnapshotMatchesStat
      });
      if (!evidence.requiresPersistence) return null;
      const intent = { outboxId: 'position-outbox-1' };
      outbox.push(intent);
      return intent;
    }
  });
  assert.equal(recovered.result.code, 'position-export-state-failed');
  assert.equal(recovered.pending, null);
  assert.deepEqual(recovered.syncedCheckpoint, checkpoint(0));
  assert.equal(recovered.cleanupCount, 1);
  assert.deepEqual(outbox, [{ outboxId: 'position-outbox-1' }]);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'published-result');
});

test('存档失败已形成持久重试后清理函数只处理未受保护暂存', async () => {
  const recovered = await runHarness({
    operationToken: 'archive-persistent-retry',
    baseCheckpoint: checkpoint(0),
    currentCheckpoint: checkpoint(1),
    businessResult: { status: 'ok', inputPaths: ['/tmp/input.xlsx'] },
    archiveFiles: [{
      filePath: '/tmp/input.xlsx',
      role: 'input',
      ...INPUT_EVIDENCE
    }],
    archiveResult: {
      archiveFailed: true,
      persistentRetryAvailable: true,
      outboxId: 'position-outbox-retry',
      warning: { message: 'archive copy failed' }
    }
  });
  assert.equal(recovered.result.status, 'ok');
  assert.equal(recovered.pending, null);
  assert.deepEqual(recovered.syncedCheckpoint, checkpoint(1));
  assert.equal(recovered.cleanupCount, 1);
  // TaskLifecycle 是唯一告警拥有者；position settle 不重复上报同一存档失败。
  assert.deepEqual(recovered.warnings, []);
});

test('正式存档与持久重试都失败时原样返回业务成功并保留 incomplete pending', async () => {
  const failed = await runHarness({
    operationToken: 'archive-double-failure',
    baseCheckpoint: checkpoint(0),
    currentCheckpoint: checkpoint(1),
    businessResult: { status: 'ok', inputPaths: ['/tmp/input.xlsx'] },
    archiveFiles: [{
      filePath: '/tmp/input.xlsx',
      role: 'input',
      ...INPUT_EVIDENCE
    }],
    archiveResult: {
      archiveFailed: true,
      persistentRetryAvailable: false,
      warning: { message: 'archive and outbox failed' }
    }
  });
  assert.equal(failed.result.status, 'ok');
  assert.deepEqual(failed.result.inputPaths, ['/tmp/input.xlsx']);
  assert.equal(failed.pending.operationToken, 'archive-double-failure');
  assert.equal(failed.pending.archiveState, 'incomplete');
  assert.equal(failed.syncedCheckpoint, null);
  assert.equal(failed.cleanupCount, 0);
  assert.deepEqual(failed.warnings, []);
});

function recoveredTaskFixture(terminalOutcome) {
  const calls = [];
  const batchContext = {
    batchId: 91,
    batchNumber: '2026-08-10-091',
    taskRunId: 'position-operation-91',
    taskKey: 'position-reconciliation:run',
    moduleId: 'position-reconciliation-process',
    parentRunId: 'position-parent-91',
    operationKey: 'position:position-operation-91:run'
  };
  const batch = {
    id: 91,
    taskStatus: 'running',
    taskRunId: batchContext.taskRunId,
    moduleId: batchContext.moduleId,
    parentRunId: batchContext.parentRunId,
    operationKey: batchContext.operationKey
  };
  const success = async (name, payload) => {
    calls.push([name, payload]);
    batch.taskStatus = name;
    return { ok: true, batch: { ...batch } };
  };
  return {
    calls,
    pending: {
      operationToken: batchContext.taskRunId,
      batchContext,
      terminalOutcome
    },
    archiveService: {
      getBatch: async () => ({ ok: true, batch: { ...batch } }),
      completeTaskBatch: (_id, payload) => success('succeeded', payload),
      failTaskBatch: (_id, payload) => success('failed', payload),
      cancelTaskBatch: (_id, payload) => success('cancelled', payload)
    }
  };
}

test('启动恢复按持久 succeeded outcome 终结原 task', async () => {
  const fixture = recoveredTaskFixture({ taskStatus: 'succeeded', code: '', message: '' });
  const settled = await settlePositionRecoveredTask(fixture);
  assert.equal(settled.outcome.taskStatus, 'succeeded');
  assert.deepEqual(fixture.calls.map((call) => call[0]), ['succeeded']);
});

test('启动恢复按持久 cancelled outcome 终结原 task', async () => {
  const fixture = recoveredTaskFixture({
    taskStatus: 'cancelled',
    code: 'position-import-cancelled',
    message: '用户取消导入'
  });
  const settled = await settlePositionRecoveredTask(fixture);
  assert.equal(settled.outcome.taskStatus, 'cancelled');
  assert.deepEqual(fixture.calls.map((call) => call[0]), ['cancelled']);
  assert.equal(fixture.calls[0][1].reason, '用户取消导入');
});

test('启动恢复按持久真实异常 outcome 终结原 task 为 failed', async () => {
  const fixture = recoveredTaskFixture({
    taskStatus: 'failed',
    code: 'position-worker-crashed',
    message: 'utility process exited'
  });
  const settled = await settlePositionRecoveredTask(fixture);
  assert.equal(settled.outcome.taskStatus, 'failed');
  assert.deepEqual(fixture.calls.map((call) => call[0]), ['failed']);
  assert.equal(fixture.calls[0][1].code, 'position-worker-crashed');
});

test('启动恢复仅把与目标一致的既有终态视为幂等，冲突终态 fail-closed', async () => {
  const same = recoveredTaskFixture({ taskStatus: 'succeeded', code: '', message: '' });
  same.archiveService.completeTaskBatch = async () => ({
    ok: false,
    code: 'ARCHIVE_TASK_STATUS_CONFLICT',
    batch: { taskStatus: 'succeeded' }
  });
  const settled = await settlePositionRecoveredTask(same);
  assert.equal(settled.outcome.taskStatus, 'succeeded');

  const conflict = recoveredTaskFixture({ taskStatus: 'succeeded', code: '', message: '' });
  conflict.archiveService.completeTaskBatch = async () => ({
    ok: false,
    code: 'ARCHIVE_TASK_STATUS_CONFLICT',
    message: 'already cancelled',
    batch: { taskStatus: 'cancelled' }
  });
  await assert.rejects(
    settlePositionRecoveredTask(conflict),
    /already cancelled/
  );
});

test('启动恢复通过 ArchiveService facade 读不到原批次时失败', async () => {
  const fixture = recoveredTaskFixture({ taskStatus: 'succeeded', code: '', message: '' });
  fixture.archiveService.getBatch = async () => ({
    ok: false,
    code: 'ARCHIVE_BATCH_NOT_FOUND',
    message: '存档批次不存在'
  });
  await assert.rejects(
    settlePositionRecoveredTask(fixture),
    /存档批次不存在/
  );
  assert.deepEqual(fixture.calls, []);
});

test('启动恢复拒绝终结与持久 batchContext 身份不一致的批次', async () => {
  const fixture = recoveredTaskFixture({ taskStatus: 'succeeded', code: '', message: '' });
  const originalGetBatch = fixture.archiveService.getBatch;
  fixture.archiveService.getBatch = async (batchId) => {
    const lookup = await originalGetBatch(batchId);
    return {
      ...lookup,
      batch: { ...lookup.batch, operationKey: 'position:another-operation' }
    };
  };
  await assert.rejects(
    settlePositionRecoveredTask(fixture),
    /batchContext 与原任务批次身份不一致/
  );
  assert.deepEqual(fixture.calls, []);
});

test('output-only 平盘导出恢复无需伪造 input 提交凭证', () => {
  const output = {
    filePath: '/tmp/position-output-only.xlsx',
    role: 'output',
    beforeSnapshot: null
  };
  const committed = positionCommittedRecoveryArchiveFiles({
    operationToken: 'position-output-only',
    archiveFiles: [output]
  }, []);
  assert.deepEqual(committed, [output]);
});

test('损坏存档文件清单在任何 archive 状态下都禁止同步 checkpoint 和清除 pending', async () => {
  const cases = [
    {
      label: 'archiveRequired=false',
      pending: {
        operationToken: 'invalid-not-required',
        archiveRequired: false,
        archiveState: 'not-required',
        archiveFiles: [{ filePath: 123 }]
      }
    },
    {
      label: 'archiveRequired 缺失',
      pending: {
        operationToken: 'invalid-legacy',
        archiveState: 'awaiting-intent'
      }
    },
    {
      label: 'archiveState=durable',
      pending: {
        operationToken: 'invalid-durable',
        archiveRequired: true,
        archiveState: 'durable',
        archiveFiles: [{ filePath: '   ' }]
      }
    },
    {
      label: 'input 缺少解析时摘要',
      pending: {
        operationToken: 'invalid-input-evidence',
        archiveRequired: true,
        archiveState: 'intent-recorded',
        archiveFiles: [{ filePath: '/tmp/input.xlsx', role: 'input' }]
      }
    },
    {
      label: 'output 缺少写出前快照字段',
      pending: {
        operationToken: 'invalid-output-evidence',
        archiveRequired: true,
        archiveState: 'intent-recorded',
        archiveFiles: [{ filePath: '/tmp/output.xlsx', role: 'output' }]
      }
    }
  ];

  for (const item of cases) {
    let persistedPending = null;
    let syncCount = 0;
    let clearCount = 0;
    const result = await runPositionOperationLifecycle({
      operationToken: item.pending.operationToken,
      pending: item.pending,
      writeInitialPending: (value) => {
        persistedPending = structuredClone(value);
      },
      runInContext: (task) => task(),
      operation: async () => ({ status: 'ok' }),
      readPending: () => persistedPending,
      syncCheckpoint: () => {
        syncCount += 1;
      },
      clearPending: () => {
        clearCount += 1;
        persistedPending = null;
      },
      failureResult
    });

    assert.equal(result.status, 'failed', item.label);
    assert.match(result.message, /存档文件清单损坏/, item.label);
    assert.equal(syncCount, 0, item.label);
    assert.equal(clearCount, 0, item.label);
    assert.notEqual(persistedPending, null, item.label);
  }
});

test('恢复 input 只复用 pending 的解析时证据，不重新抓取当前文件快照', () => {
  let outputSnapshotCaptureCount = 0;
  const files = positionRecoveryArchiveFiles({
    archiveFiles: [{
      filePath: '/tmp/staged-input.xlsx',
      role: 'input',
      ...INPUT_EVIDENCE
    }]
  }, {
    captureOutputSnapshot: () => {
      outputSnapshotCaptureCount += 1;
      return {
        sizeBytes: 999,
        mtimeMs: 999,
        ctimeMs: 999
      };
    }
  });

  assert.equal(outputSnapshotCaptureCount, 0);
  assert.deepEqual(files, [{
    filePath: '/tmp/staged-input.xlsx',
    role: 'input',
    sourceSnapshot: INPUT_EVIDENCE.sourceSnapshot,
    expectedSha256: INPUT_EVIDENCE.sha256,
    sizeBytes: INPUT_EVIDENCE.sizeBytes
  }]);
});

test('恢复只保留 side DB 已提交的文件级输入，prepared 输入不存档也不阻断已提交输入', () => {
  const firstPath = path.resolve('/tmp/position-committed-A.xlsx');
  const secondPath = path.resolve('/tmp/position-prepared-B.xlsx');
  const outputPath = path.resolve('/tmp/position-output.xlsx');
  const firstPending = {
    filePath: firstPath,
    role: 'input',
    sourceType: 'gateway-inbound',
    ...INPUT_EVIDENCE
  };
  const secondPending = {
    filePath: secondPath,
    role: 'input',
    sourceType: 'gateway-outbound',
    sourceSnapshot: { ...INPUT_EVIDENCE.sourceSnapshot, ino: 41 },
    sha256: 'b'.repeat(64),
    sizeBytes: INPUT_EVIDENCE.sizeBytes
  };
  const outputPending = {
    filePath: outputPath,
    role: 'output',
    beforeSnapshot: null,
    requiredInputPaths: [firstPath]
  };
  const aggregateOutputPending = {
    filePath: path.resolve('/tmp/position-output-aggregate.xlsx'),
    role: 'output',
    beforeSnapshot: null,
    requiredInputPaths: [firstPath, secondPath]
  };

  const filtered = positionCommittedRecoveryArchiveFiles({
    operationToken: 'multi-file-operation',
    archiveFiles: [
      firstPending,
      secondPending,
      outputPending,
      aggregateOutputPending
    ]
  }, [{
    operationToken: 'multi-file-operation',
    sourceType: firstPending.sourceType,
    role: 'input',
    filePath: firstPath,
    sourceSnapshot: firstPending.sourceSnapshot,
    sha256: firstPending.sha256,
    sizeBytes: firstPending.sizeBytes
  }]);

  assert.deepEqual(filtered, [firstPending, outputPending]);
  assert.deepEqual(
    positionUncommittedRecoveryInputPaths({
      operationToken: 'multi-file-operation',
      archiveFiles: [
        firstPending,
        secondPending,
        outputPending,
        aggregateOutputPending
      ]
    }, filtered),
    [secondPath]
  );
  assert.deepEqual(
    positionRecoveryCleanupInputPaths({
      operationToken: 'multi-file-operation',
      archiveFiles: [firstPending, secondPending, outputPending, aggregateOutputPending]
    }, filtered, { code: 'ARCHIVE_OPERATION_DELETED' }),
    [firstPath, secondPath]
  );
});

test('部分提交恢复遇到未声明输入依赖的旧输出时 fail closed', () => {
  const firstPath = path.resolve('/tmp/position-legacy-output-A.xlsx');
  const secondPath = path.resolve('/tmp/position-legacy-output-B.xlsx');
  const firstPending = {
    filePath: firstPath,
    role: 'input',
    sourceType: 'fund-transfer',
    ...INPUT_EVIDENCE
  };
  const secondPending = {
    filePath: secondPath,
    role: 'input',
    sourceType: 'test-payment',
    sourceSnapshot: { ...INPUT_EVIDENCE.sourceSnapshot, ino: 51 },
    sha256: 'd'.repeat(64),
    sizeBytes: INPUT_EVIDENCE.sizeBytes
  };
  assert.throws(
    () => positionCommittedRecoveryArchiveFiles({
      operationToken: 'legacy-output-operation',
      archiveFiles: [firstPending, secondPending, {
        filePath: path.resolve('/tmp/position-legacy-shared-report.xlsx'),
        role: 'output',
        beforeSnapshot: null
      }]
    }, [{
      operationToken: 'legacy-output-operation',
      sourceType: firstPending.sourceType,
      role: 'input',
      filePath: firstPath,
      sourceSnapshot: firstPending.sourceSnapshot,
      sha256: firstPending.sha256,
      sizeBytes: firstPending.sizeBytes
    }]),
    (error) => error && error.code === 'position-side-data-invalid'
  );
});

test('恢复文件级提交凭证与 pending 不一致时 fail closed', () => {
  const pendingPath = path.resolve('/tmp/position-pending-input.xlsx');
  const pending = {
    operationToken: 'proof-mismatch-operation',
    archiveFiles: [{
      filePath: pendingPath,
      role: 'input',
      sourceType: 'gateway-inbound',
      ...INPUT_EVIDENCE
    }]
  };
  const baseProof = {
    operationToken: pending.operationToken,
    sourceType: 'gateway-inbound',
    role: 'input',
    filePath: pendingPath,
    sourceSnapshot: INPUT_EVIDENCE.sourceSnapshot,
    sha256: INPUT_EVIDENCE.sha256,
    sizeBytes: INPUT_EVIDENCE.sizeBytes
  };

  assert.deepEqual(
    positionCommittedRecoveryArchiveFiles(pending, []),
    [],
    'pending 无提交凭证应视为 prepared，不得存档'
  );
  assert.throws(
    () => positionCommittedRecoveryArchiveFiles(pending, [{
      ...baseProof,
      filePath: path.resolve('/tmp/position-journal-only.xlsx')
    }]),
    (error) => error && error.code === 'position-side-data-invalid'
  );
  assert.throws(
    () => positionCommittedRecoveryArchiveFiles(pending, [{
      ...baseProof,
      sha256: 'c'.repeat(64)
    }]),
    (error) => error && error.code === 'position-side-data-invalid'
  );
  assert.throws(
    () => positionCommittedRecoveryArchiveFiles({
      operationToken: pending.operationToken,
      archiveFiles: [{
        filePath: path.resolve('/tmp/position-output-only.xlsx'),
        role: 'output',
        beforeSnapshot: null
      }]
    }, [baseProof]),
    (error) => error && error.code === 'position-side-data-invalid',
    'journal 有输入但 pending 丢失输入时必须阻断'
  );
});

test('恢复前暂存输入字节变化时 fail closed，不允许继续登记恢复意图', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'position-recovery-input-change-'));
  const inputPath = path.join(directory, 'input.xlsx');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(inputPath, 'version-A-contents');
  const before = fs.statSync(inputPath);
  const pending = {
    archiveFiles: [{
      filePath: inputPath,
      role: 'input',
      sourceSnapshot: sourceSnapshotFromStat(before),
      sha256: hashFileSha256Sync(inputPath).sha256,
      sizeBytes: before.size
    }]
  };
  fs.writeFileSync(inputPath, 'version-B-contents');
  fs.utimesSync(inputPath, before.atime, before.mtime);
  let recoveryIntentCount = 0;

  assert.throws(
    () => {
      assertPositionRecoveryInputsUnchanged(pending, assertStagedInputUnchanged);
      recoveryIntentCount += 1;
    },
    (error) => error && error.code === 'position-staged-input-changed'
  );
  assert.equal(recoveryIntentCount, 0);
  assert.equal(fs.existsSync(inputPath), true);
});

test('普通来源 apply 只有在 manifest 文件证据持久化后才签发 grant', () => {
  const operationToken = 'operation-authorized';
  const archiveManifestHash = 'b'.repeat(64);
  const schemaFingerprint = 'c'.repeat(64);
  const archivePath = path.resolve('/tmp/position-authorized.xlsx');
  let pending = {
    operationToken,
    archiveRequired: true,
    archiveState: 'awaiting-intent',
    archiveFiles: []
  };
  const preflightReady = {
    archiveManifestHash,
    acceptedOrdinaryInputFiles: [{
      archivePath,
      sourceType: 'gateway-outbound',
      stagedSnapshot: INPUT_EVIDENCE.sourceSnapshot,
      stagedSha256: INPUT_EVIDENCE.sha256,
      stagedSizeBytes: INPUT_EVIDENCE.sizeBytes
    }]
  };
  const grant = authorizePositionImportApply({
    preflightReady,
    currentCheckpoint: checkpoint(4),
    schemaFingerprint,
    readPending: () => structuredClone(pending),
    writePending: (value, ownerToken) => {
      assert.equal(ownerToken, operationToken);
      pending = structuredClone(value);
    },
    recordArchiveIntentFiles: (files, role, ownerToken) => {
      assert.equal(role, 'input');
      assert.equal(ownerToken, operationToken);
      pending = {
        ...pending,
        archiveState: 'intent-recorded',
        archiveFiles: structuredClone(files)
      };
    }
  });

  assert.deepEqual(grant, {
    operationToken,
    archiveManifestHash,
    schemaFingerprint,
    baseCheckpoint: checkpoint(4)
  });
  assert.equal(pending.archiveManifestHash, archiveManifestHash);
  assert.equal(pending.archiveFiles.length, 1);
  assert.equal(pending.archiveFiles[0].filePath, archivePath);
});

test('含过滤行的普通来源在 grant 前同时持久化异常报告证据', () => {
  const operationToken = 'operation-with-anomaly-report';
  const reportSnapshot = { ...INPUT_EVIDENCE.sourceSnapshot, ino: 88 };
  const reportSha256 = '8'.repeat(64);
  let pending = {
    operationToken,
    archiveRequired: true,
    archiveState: 'awaiting-intent',
    archiveFiles: []
  };
  const roles = [];
  const grant = authorizePositionImportApply({
    preflightReady: {
      archiveManifestHash: '7'.repeat(64),
      acceptedOrdinaryInputFiles: [{
        archivePath: '/tmp/position-with-anomaly-input.xlsx',
        sourceType: 'fund-transfer',
        stagedSnapshot: INPUT_EVIDENCE.sourceSnapshot,
        stagedSha256: INPUT_EVIDENCE.sha256,
        stagedSizeBytes: INPUT_EVIDENCE.sizeBytes
      }],
      outputFiles: [{
        filePath: '/tmp/position-anomaly-report.xlsx',
        artifactKey: 'source-import-anomaly-report',
        requiredInputPaths: ['/tmp/position-with-anomaly-input.xlsx'],
        sourceSnapshot: reportSnapshot,
        expectedSha256: reportSha256,
        sizeBytes: reportSnapshot.sizeBytes
      }]
    },
    currentCheckpoint: checkpoint(5),
    schemaFingerprint: '6'.repeat(64),
    readPending: () => structuredClone(pending),
    writePending: (value) => {
      pending = structuredClone(value);
    },
    recordArchiveIntentFiles: (files, role, ownerToken) => {
      assert.equal(ownerToken, operationToken);
      roles.push(role);
      pending = {
        ...pending,
        archiveState: 'intent-recorded',
        archiveFiles: [...pending.archiveFiles, ...structuredClone(files)]
      };
    }
  });

  assert.equal(grant.operationToken, operationToken);
  assert.deepEqual(roles, ['input', 'output']);
  assert.equal(pending.archiveFiles.length, 2);
  assert.equal(pending.archiveFiles[1].role, 'output');
  assert.equal(pending.archiveFiles[1].artifactKey, 'source-import-anomaly-report');
  assert.equal(pending.archiveFiles[1].sha256, reportSha256);
  assert.deepEqual(
    pending.archiveFiles[1].requiredInputPaths,
    [path.resolve('/tmp/position-with-anomaly-input.xlsx')]
  );
});

test('主进程异常报告存档意图保留预检声明的输入依赖', () => {
  const mainSource = fs.readFileSync(
    path.resolve(__dirname, '../../../src/main.js'),
    'utf8'
  );
  const start = mainSource.indexOf('function recordPositionArchiveIntentFiles');
  const end = mainSource.indexOf('\nfunction markPositionBusinessOutcome', start);
  assert.ok(start >= 0 && end > start, '应能定位主进程存档意图转换函数');
  const implementation = mainSource.slice(start, end);
  assert.match(
    implementation,
    /requiredInputPaths:\s*descriptor\.requiredInputPaths/,
    '异常报告 requiredInputPaths 必须进入 pending，不能在主进程转换时丢失'
  );
  assert.match(
    implementation,
    /function recordPositionArchiveIntentFiles\(filePaths, role, explicitOperationToken = ''\)/,
    'utilityProcess 授权回调必须能显式传入 pending operation token'
  );
  assert.match(
    implementation,
    /explicitOperationToken \|\| \(context && context\.operationToken\)/,
    '显式 owner token 应优先于可能丢失的 AsyncLocalStorage 上下文'
  );
});

test('异常报告与筛选结果均在 writer 前登记 output intent，取消 ACK 接原批次 CAS', () => {
  const mainSource = fs.readFileSync(
    path.resolve(__dirname, '../../../src/main.js'),
    'utf8'
  );
  const anomalyStart = mainSource.indexOf("trackedIpcHandle('position-reconciliation:source:export-anomaly'");
  const cancelStart = mainSource.indexOf("ipcMain.handle('position-reconciliation:import:cancel'", anomalyStart);
  const filteredStart = mainSource.indexOf("trackedIpcHandle('position-reconciliation:run:export-filtered'");
  const importResultStart = mainSource.indexOf("trackedIpcHandle(\n    'position-reconciliation:run:import-result'", filteredStart);
  assert.ok(anomalyStart >= 0 && cancelStart > anomalyStart);
  assert.ok(filteredStart >= 0 && importResultStart > filteredStart);
  const anomaly = mainSource.slice(anomalyStart, cancelStart);
  const filtered = mainSource.slice(filteredStart, importResultStart);
  assert.ok(
    anomaly.indexOf("recordPositionArchiveIntentFiles([prepared.savePath], 'output')")
      < anomaly.indexOf('exportAnomalyReport('),
    '异常报告必须先登记 output intent 再发布'
  );
  assert.ok(
    filtered.indexOf("recordPositionArchiveIntentFiles([prepared.savePath], 'output')")
      < filtered.indexOf('exportRunFilteredSources('),
    '筛选结果必须先登记 output intent 再发布'
  );
  const cancelEnd = mainSource.indexOf("trackedIpcHandle(\n    'position-reconciliation:mappings:save'", cancelStart);
  const cancel = mainSource.slice(cancelStart, cancelEnd);
  assert.match(cancel, /cancelActiveImport\(jobId, \(\) => \([\s\S]*archiveTaskLifecycle\.cancelActive/);
  assert.match(cancel, /context\.taskRunId === active\.operationToken/);
});

test('普通来源 manifest 与 pending 文件证据不一致时禁止签发 grant', () => {
  const operationToken = 'operation-rejected';
  let pending = {
    operationToken,
    archiveRequired: true,
    archiveFiles: []
  };
  assert.throws(
    () => authorizePositionImportApply({
      preflightReady: {
        archiveManifestHash: 'd'.repeat(64),
        acceptedOrdinaryInputFiles: [{
          archivePath: '/tmp/position-rejected.xlsx',
          sourceType: 'gateway-outbound',
          stagedSnapshot: INPUT_EVIDENCE.sourceSnapshot,
          stagedSha256: INPUT_EVIDENCE.sha256,
          stagedSizeBytes: INPUT_EVIDENCE.sizeBytes
        }]
      },
      currentCheckpoint: checkpoint(0),
      schemaFingerprint: 'e'.repeat(64),
      readPending: () => structuredClone(pending),
      writePending: (value) => {
        pending = structuredClone(value);
      },
      recordArchiveIntentFiles: (files) => {
        pending = {
          ...pending,
          archiveFiles: [{
            ...structuredClone(files[0]),
            sha256: 'f'.repeat(64)
          }]
        };
      }
    }),
    /文件证据与预检 manifest 不一致/
  );
  assert.equal(pending.archiveManifestHash, undefined);
});
