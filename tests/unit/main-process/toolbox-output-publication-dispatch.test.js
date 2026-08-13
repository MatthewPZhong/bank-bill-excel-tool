'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_WORKER_ENTRY,
  createToolboxPublicationDispatcher
} = require('../../../src/main-process/toolbox-output-publication-dispatch');

const BUSY_WORKER = path.join(
  __dirname,
  '__fixtures__',
  'toolbox-publication-stub-busy.js'
);
const CRASH_RECOVER_WORKER = path.join(
  __dirname,
  '__fixtures__',
  'toolbox-publication-stub-crash-recover.js'
);
const LIFECYCLE_WORKER = path.join(
  __dirname,
  '__fixtures__',
  'toolbox-publication-stub-lifecycle.js'
);

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

const BATCH_CONTEXT = Object.freeze({
  batchId: 51,
  batchNumber: '2026-08-11-002',
  taskRunId: 'toolbox-task-2',
  taskKey: 'toolbox:merge',
  moduleId: 'toolbox',
  parentRunId: 'toolbox-parent-2',
  operationKey: 'toolbox:merge:toolbox-task-2'
});

test.describe('toolbox output publication worker dispatch', () => {
  test('正式发布必须携带 exact7 batchContext，恢复扫描不伪造新批次', async () => {
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: BUSY_WORKER
    });
    assert.throws(
      () => dispatcher.publish({ taskId: 'missing-context' }),
      /batchContext 缺失/
    );
    assert.throws(
      () => dispatcher.publish({
        taskId: 'partial-context',
        batchContext: { batchId: 1 }
      }),
      /batchNumber.*不能为空/
    );
    await dispatcher.recover({ userDataDir: 'startup-recovery' });
  });

  test('FIFO 串行发布/恢复作业，同步忙 worker 不阻塞主线程 heartbeat', async () => {
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: BUSY_WORKER
    });
    const starts = [];
    let heartbeatTicks = 0;
    const timer = setInterval(() => {
      heartbeatTicks += 1;
    }, 10);
    const startedAt = Date.now();
    try {
      const first = dispatcher.recover({
        userDataDir: 'first',
        onProgress(payload) {
          if (payload.checkpoint === 'start') starts.push(payload.context);
        }
      });
      const second = dispatcher.recover({
        userDataDir: 'second',
        onProgress(payload) {
          if (payload.checkpoint === 'start') starts.push(payload.context);
        }
      });
      await Promise.all([first, second]);
    } finally {
      clearInterval(timer);
    }

    assert.deepEqual(starts.map((item) => item.label), ['first', 'second']);
    assert.ok(
      starts[1].startedAt - starts[0].startedAt >= 100,
      '第二个 worker 必须等第一个作业结束后才能启动'
    );
    assert.ok(Date.now() - startedAt >= 250);
    assert.ok(heartbeatTicks >= 10, `主线程 heartbeat 应持续执行，实际 ${heartbeatTicks} 次`);
  });

  test('发布 worker 异常退出时先在同一队列项执行恢复，再向调用方返回失败', async () => {
    const root = makeRoot('toolbox-publication-dispatch-crash-');
    const generationDir = path.join(root, 'generation');
    const outputDir = path.join(root, 'output');
    const userDataDir = path.join(root, 'user-data');
    fs.mkdirSync(generationDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const sourcePath = path.join(generationDir, 'result.xlsx');
    const targetPath = path.join(outputDir, 'result.xlsx');
    fs.writeFileSync(sourcePath, 'generated-v2');
    fs.writeFileSync(targetPath, 'original-v1');
    const sourceStat = fs.statSync(sourcePath);
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: CRASH_RECOVER_WORKER
    });
    try {
      await assert.rejects(
        dispatcher.publish({
          taskId: 'crash-then-recover',
          artifacts: [{
            sourcePath,
            byteSize: sourceStat.size,
            sha256: sha256File(sourcePath)
          }],
          targets: [{ targetPath }],
          userDataDir,
          batchContext: BATCH_CONTEXT,
          requireValidatedArtifacts: true
        }),
        (error) => {
          assert.equal(error.name, 'ToolboxPublicationWorkerError');
          assert.match(error.message, /worker.*退出|worker.*异常/i);
          assert.ok(
            error.detailLines.some((line) => line.includes('已执行自动恢复'))
          );
          return true;
        }
      );
      assert.equal(
        fs.readFileSync(path.join(userDataDir, 'recovery-ran.txt'), 'utf8'),
        'recovered'
      );
      assert.equal(fs.readFileSync(targetPath, 'utf8'), 'original-v1');
      const residualPublicationFiles = fs.readdirSync(outputDir)
        .filter((name) => name.startsWith('.toolbox-publish-'));
      assert.deepEqual(residualPublicationFiles, []);
      const index = JSON.parse(fs.readFileSync(
        path.join(userDataDir, 'toolbox-publish-journal-index.json'),
        'utf8'
      ));
      assert.deepEqual(index.entries, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('worker 在 committed 后退出时，恢复 exact7 与输出描述并向原 lifecycle 报成功', async () => {
    const root = makeRoot('toolbox-publication-dispatch-committed-');
    const generationDir = path.join(root, 'generation');
    const outputDir = path.join(root, 'output');
    const userDataDir = path.join(root, 'user-data');
    fs.mkdirSync(generationDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const sourcePath = path.join(generationDir, 'result.xlsx');
    const targetPath = path.join(outputDir, 'result.xlsx');
    fs.writeFileSync(sourcePath, 'generated-v2');
    fs.writeFileSync(targetPath, 'original-v1');
    const sourceStat = fs.statSync(sourcePath);
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: CRASH_RECOVER_WORKER
    });
    try {
      const result = await dispatcher.publish({
        taskId: 'committed-crash-recover',
        artifacts: [{
          sourcePath,
          byteSize: sourceStat.size,
          sha256: sha256File(sourcePath),
          fileName: 'result.xlsx'
        }],
        targets: [{ targetPath }],
        userDataDir,
        batchContext: BATCH_CONTEXT,
        requireValidatedArtifacts: true
      });
      assert.equal(result.committed, true);
      assert.equal(result.recoveredAfterWorkerExit, true);
      assert.deepEqual(result.batchContext, BATCH_CONTEXT);
      assert.deepEqual(
        result.files.map((file) => [file.role, file.sourceOperation, file.filePath]),
        [['output', 'toolbox:merge', targetPath]]
      );
      assert.equal(fs.readFileSync(targetPath, 'utf8'), 'generated-v2');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('transport error 必须等原 worker exit 后才启动 recovery worker', async () => {
    const events = [];
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: LIFECYCLE_WORKER,
      onWorkerExit({ op }) {
        events.push(`exit:${op}`);
      }
    });

    await assert.rejects(
      dispatcher.publish({
        taskId: 'transport-error',
        artifacts: [],
        targets: [],
        userDataDir: 'transport-recovery-root',
        batchContext: BATCH_CONTEXT,
        onProgress(payload) {
          if (payload.checkpoint === 'start') {
            events.push(`start:${payload.context.label}`);
          }
        }
      }),
      (error) => {
        assert.equal(error.name, 'ToolboxPublicationWorkerError');
        assert.ok(error.detailLines.some((line) => line.includes('已执行自动恢复')));
        return true;
      }
    );

    assert.deepEqual(events, [
      'start:transport-error',
      'exit:publish',
      'start:transport-recovery-root',
      'exit:recover'
    ]);
  });

  test('正常 done 后必须等 worker exit 才释放下一个 FIFO 作业', async () => {
    const events = [];
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: LIFECYCLE_WORKER,
      onWorkerExit({ op }) {
        events.push(`exit:${op}`);
      }
    });
    const onProgress = (payload) => {
      if (payload.checkpoint === 'start') {
        events.push(`start:${payload.context.label}`);
      }
    };

    const first = dispatcher.recover({
      userDataDir: 'normal-first',
      onProgress
    });
    const second = dispatcher.recover({
      userDataDir: 'normal-second',
      onProgress
    });
    await Promise.all([first, second]);

    assert.deepEqual(events, [
      'start:normal-first',
      'exit:recover',
      'start:normal-second',
      'exit:recover'
    ]);
  });

  test('business error 后必须等 worker exit 才释放下一个 FIFO 作业', async () => {
    const events = [];
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: LIFECYCLE_WORKER,
      onWorkerExit({ op }) {
        events.push(`exit:${op}`);
      }
    });
    const onProgress = (payload) => {
      if (payload.checkpoint === 'start') {
        events.push(`start:${payload.context.label}`);
      }
    };

    const failed = dispatcher.publish({
      taskId: 'business-error',
      artifacts: [],
      targets: [],
      userDataDir: 'business-error-root',
      batchContext: BATCH_CONTEXT,
      onProgress
    });
    const next = dispatcher.recover({
      userDataDir: 'after-business-error',
      onProgress
    });
    await assert.rejects(failed, /lifecycle fixture business error/);
    await next;

    assert.deepEqual(events, [
      'start:business-error',
      'exit:publish',
      'start:after-business-error',
      'exit:recover'
    ]);
  });

  test('真实 worker 的人工恢复错误跨线程保留临时目录保护与恢复路径', async () => {
    const root = makeRoot('toolbox-publication-dispatch-manual-');
    const userDataDir = path.join(root, 'user-data');
    const outputDir = path.join(root, 'output');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const journalPath = path.join(outputDir, '.legacy-v1.journal.json');
    const indexPath = path.join(userDataDir, 'toolbox-publish-journal-index.json');
    fs.writeFileSync(indexPath, JSON.stringify({
      version: 1,
      entries: [{
        taskId: 'legacy-v1-worker-manual',
        journalAbsolutePath: journalPath,
        createdAt: '2026-07-30T00:00:00.000Z'
      }]
    }));
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: DEFAULT_WORKER_ENTRY
    });

    try {
      await assert.rejects(
        dispatcher.recover({ userDataDir }),
        (error) => {
          assert.equal(error.name, 'ToolboxPublicationManualRecoveryError');
          assert.equal(error.preserveTemporaryFiles, true);
          assert.ok(error.recoveryPaths.includes(indexPath));
          assert.ok(error.recoveryPaths.includes(journalPath));
          return true;
        }
      );
      assert.ok(fs.existsSync(indexPath));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('真实 worker 完成已验证大产物发布，主线程定时器持续执行', async () => {
    const root = makeRoot('toolbox-publication-dispatch-real-');
    const generationDir = path.join(root, 'generation');
    const outputDir = path.join(root, 'output');
    const userDataDir = path.join(root, 'user-data');
    fs.mkdirSync(generationDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const sourcePath = path.join(generationDir, 'large.xlsx');
    const targetPath = path.join(outputDir, 'large.xlsx');
    const size = 64 * 1024 * 1024;
    const fd = fs.openSync(sourcePath, 'w');
    fs.ftruncateSync(fd, size);
    fs.closeSync(fd);
    const sha256 = sha256File(sourcePath);
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: DEFAULT_WORKER_ENTRY
    });
    let heartbeatTicks = 0;
    const timer = setInterval(() => {
      heartbeatTicks += 1;
    }, 5);
    try {
      const result = await dispatcher.publish({
        taskId: 'real-worker-heartbeat',
        artifacts: [{
          sourcePath,
          byteSize: size,
          sha256,
          outputId: 'real-1',
          fileName: 'large.xlsx'
        }],
        targets: [{ targetPath }],
        userDataDir,
        batchContext: BATCH_CONTEXT,
        requireValidatedArtifacts: true
      });
      assert.equal(result.committed, true);
      assert.equal(fs.statSync(targetPath).size, size);
      assert.equal(sha256File(targetPath), sha256);
      assert.ok(
        heartbeatTicks >= 2,
        `真实发布期间主线程 heartbeat 应继续执行，实际 ${heartbeatTicks} 次`
      );
    } finally {
      clearInterval(timer);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('真实 worker 哈希 256MiB 产物期间目标 A→B，二次确认拒绝覆盖且不留 committed receipt', async () => {
    const root = makeRoot('toolbox-publication-dispatch-confirmation-race-');
    const generationDir = path.join(root, 'generation');
    const outputDir = path.join(root, 'output');
    const userDataDir = path.join(root, 'user-data');
    fs.mkdirSync(generationDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const sourcePath = path.join(generationDir, 'large.xlsx');
    const targetPath = path.join(outputDir, 'confirmed.xlsx');
    const replacementPath = path.join(outputDir, 'replacement.xlsx');
    const size = 256 * 1024 * 1024;
    const fd = fs.openSync(sourcePath, 'w');
    fs.ftruncateSync(fd, size);
    fs.closeSync(fd);
    const sha256 = sha256File(sourcePath);
    fs.writeFileSync(targetPath, 'CONFIRMED-A');
    const targetStat = fs.lstatSync(targetPath);
    const expectedTargetSnapshot = {
      exists: true,
      snapshot: {
        sizeBytes: targetStat.size,
        mtimeMs: targetStat.mtimeMs,
        ctimeMs: targetStat.ctimeMs,
        ino: targetStat.ino
      }
    };
    const dispatcher = createToolboxPublicationDispatcher({
      workerScriptPath: DEFAULT_WORKER_ENTRY
    });
    let targetReplaced = false;
    try {
      await assert.rejects(
        dispatcher.publish({
          taskId: 'real-worker-confirmation-race',
          artifacts: [{
            sourcePath,
            byteSize: size,
            sha256,
            fileName: 'confirmed.xlsx'
          }],
          targets: [{ targetPath, expectedTargetSnapshot }],
          userDataDir,
          batchContext: BATCH_CONTEXT,
          requireValidatedArtifacts: true,
          onProgress(payload) {
            if (!targetReplaced
                && payload.checkpoint === 'prepare:before-generation-inspect') {
              fs.writeFileSync(replacementPath, 'LATEST-B');
              fs.renameSync(replacementPath, targetPath);
              targetReplaced = true;
            }
          }
        }),
        (error) => (
          error && error.code === 'TOOLBOX_PUBLICATION_TARGET_CHANGED_SINCE_CONFIRMATION'
        )
      );
      assert.equal(targetReplaced, true);
      assert.equal(fs.readFileSync(targetPath, 'utf8'), 'LATEST-B');
      const indexPath = path.join(userDataDir, 'toolbox-publish-journal-index.json');
      if (fs.existsSync(indexPath)) {
        assert.deepEqual(JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries, []);
      }
      assert.deepEqual(
        fs.readdirSync(outputDir).filter((name) => name.startsWith('.toolbox-publish-')),
        []
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
