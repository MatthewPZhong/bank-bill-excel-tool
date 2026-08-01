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
  positionUncommittedRecoveryInputPaths,
  positionRecoveryArchiveFiles,
  positionArchiveIntentEvidence,
  positionBusinessStateForResult,
  positionPersistentStagingProtectionPaths,
  positionReconciliationFailureResult,
  runPositionOperationLifecycle,
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
        cleanup: () => {
          cleanupCount += 1;
        },
        reportFailure: (warning) => {
          warnings.push(warning);
        },
        registrationFailureResult: (_result, warning) => ({
          status: 'failed',
          code: 'archive-retry-registration-failed',
          message: warning && warning.message ? warning.message : 'archive failed'
        })
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
  assert.deepEqual(recovered.warnings, [{ message: 'archive copy failed' }]);
});

test('正式存档与持久重试都失败时保留 pending 并返回禁止重试错误', async () => {
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
  assert.equal(failed.result.code, 'archive-retry-registration-failed');
  assert.equal(failed.pending.operationToken, 'archive-double-failure');
  assert.equal(failed.pending.archiveState, 'awaiting-intent');
  assert.equal(failed.syncedCheckpoint, null);
  assert.equal(failed.cleanupCount, 0);
  assert.deepEqual(failed.warnings, [{ message: 'archive and outbox failed' }]);
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
    recordArchiveIntentFiles: (files, role) => {
      assert.equal(role, 'input');
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
    recordArchiveIntentFiles: (files, role) => {
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
