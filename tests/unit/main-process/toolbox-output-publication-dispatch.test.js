'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
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

const { createTestPublicationHarness, createTestPublicationOwner } = require('../../helpers/publication-authority');
test.describe('toolbox output publication worker dispatch', () => {
  test('未绑定 dispatcher 与 raw recover 在任何 worker 之前拒绝', async () => {
    const events = [];
    const dispatcher = createToolboxPublicationDispatcher({ onWorkerExit: () => events.push('exit') });
    await assert.rejects(dispatcher.publish({ taskId: 'missing-authority', userDataDir: '/tmp/unused' }), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
    await assert.rejects(dispatcher.recover({ userDataDir: '/tmp/unused' }), { code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED' });
    assert.deepEqual(events, []);
  });

  test('正式 publish exact-7 仍在 structured-clone receiver 校验', async () => {
    const root = makeRoot('publication-exact7-');
    const { dispatcher, recovery } = createTestPublicationHarness(root);
    try {
      await assert.rejects(dispatcher.publish({ taskId: 'missing-context' }), /batchContext 缺失/);
      await assert.rejects(dispatcher.publish({ taskId: 'partial-context', batchContext: { batchId: 1 } }), /exact-7/);
      const result = await recovery.recover({ reason: 'startup', taskIds: ['absent'] });
      assert.deepEqual(result.observation.absentTaskIds, ['absent']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('FIFO 覆盖 discover/authorize/execute 两 worker 且同步 busy 不阻塞主线程 heartbeat', async () => {
    const root = makeRoot('publication-fifo-');
    const events = [];
    const { recovery } = createTestPublicationHarness(root, { dispatcherOptions: {
      workerScriptPath: BUSY_WORKER, onWorkerExit({ op }) { events.push(`exit:${op}`); }
    } });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const onProgress = () => events.push('start');
    try {
      await Promise.all([recovery.recover({ reason: 'startup', onProgress }), recovery.recover({ reason: 'business-retry', onProgress })]);
      assert.deepEqual(events, ['start', 'exit:discover-recovery', 'start', 'exit:execute-recovery',
        'start', 'exit:discover-recovery', 'start', 'exit:execute-recovery']);
      assert.ok(ticks >= 20);
    } finally { clearInterval(timer); fs.rmSync(root, { recursive: true, force: true }); }
  });

  for (const committed of [false, true]) {
    test(`真实发布 worker ${committed ? '提交后' : '目标 rename 后'}退出，当前 FIFO 内自动授权恢复`, async () => {
      const root = makeRoot('publication-crash-');
      const generation = path.join(root, 'generation');
      fs.mkdirSync(generation);
      const sourcePath = path.join(generation, 'source.xlsx');
      const outputDir = path.join(root, 'out');
      fs.mkdirSync(outputDir);
      const targetPath = path.join(outputDir, 'result.xlsx');
      fs.writeFileSync(sourcePath, 'new'); fs.writeFileSync(targetPath, 'old');
      const events = [];
      const { dispatcher } = createTestPublicationHarness(path.join(root, 'user-data'), { dispatcherOptions: {
        workerScriptPath: CRASH_RECOVER_WORKER, onWorkerExit({ op }) { events.push(op); }
      } });
      try {
        const promise = dispatcher.publish({ taskId: committed ? 'committed-crash-recover' : 'crash-then-recover',
          artifacts: [{ sourcePath, byteSize: 3, sha256: sha256File(sourcePath) }], targets: [{ targetPath }],
          batchContext: BATCH_CONTEXT, requireValidatedArtifacts: true });
        if (committed) {
          const result = await promise;
          assert.equal(result.recoveredAfterWorkerExit, true);
          assert.equal(result.pendingArchiveHandoff, true);
          assert.deepEqual(result.batchContext, BATCH_CONTEXT);
        } else {
          await assert.rejects(promise, (error) => error.isToolboxPublicationTransportError === true && error.detailLines.some((line) => line.includes('授权恢复')));
        }
        assert.equal(fs.readFileSync(targetPath, 'utf8'), committed ? 'new' : 'old');
        assert.deepEqual(events, ['discover-recovery', 'execute-recovery', 'publish', 'discover-recovery', 'execute-recovery']);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const mode of ['transport-error', 'business-error', 'normal']) {
    test(`${mode}：全部 worker 真 exit 后才释放 observation lease 和 FIFO`, async () => {
      const root = makeRoot('publication-exit-');
      const events = [];
      const owner = createTestPublicationOwner({ async acquireObservation(request) {
        events.push(`acquire:${request.reason}`);
        return { verifyScope: () => true, release() { events.push(`release:${request.reason}`); } };
      } });
      const { dispatcher, recovery } = createTestPublicationHarness(root, { owners: [owner], dispatcherOptions: {
        workerScriptPath: LIFECYCLE_WORKER, onWorkerExit({ op }) { events.push(`exit:${op}`); }
      } });
      try {
        const first = dispatcher.publish({ taskId: mode, batchContext: BATCH_CONTEXT,
          onProgress(payload) { events.push(`start:${payload.context.label.split(':')[0]}`); } });
        const second = recovery.recover({ reason: 'business-retry', onProgress(payload) { events.push(`next:${payload.context.label.split(':')[0]}`); } });
        if (mode === 'normal') await first;
        else await assert.rejects(first, mode === 'business-error' ? /business error/ : /worker/);
        await second;
        const publishExit = events.indexOf('exit:publish');
        const nextStart = events.indexOf('next:discover-recovery');
        assert.ok(publishExit >= 0 && nextStart > publishExit);
        const firstRelease = events.indexOf('release:publish-preflight');
        assert.ok(firstRelease > publishExit);
        if (mode === 'transport-error') {
          assert.ok(events.slice(publishExit + 1, firstRelease).includes('exit:execute-recovery'));
          assert.equal(events.filter((event) => event === 'acquire:publish-preflight').length, 1);
          assert.equal(events.filter((event) => event.includes('acquire:transport')).length, 0);
        }
        assert.ok(events.lastIndexOf('exit:execute-recovery') < events.indexOf('release:business-retry'));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('done/terminate Promise 先结算但真实 exit 延迟时，lease 和公共 Promise 继续保持', async () => {
    const { Worker } = require('node:worker_threads');
    const originalTerminate = Worker.prototype.terminate;
    const root = makeRoot('publication-delayed-exit-');
    let doneCount = 0; let exitCount = 0; let released = false; let settled = false;
    // 模拟 terminate 请求已接受但尚未 exit；真实线程由 close 后延时自行退出。
    Worker.prototype.terminate = function terminateAccepted() { return Promise.resolve(0); };
    const owner = createTestPublicationOwner({ async acquireObservation() {
      return { verifyScope: () => true, release() { released = true; assert.equal(exitCount, 2); } };
    } });
    const { recovery } = createTestPublicationHarness(root, { owners: [owner], dispatcherOptions: {
      workerScriptPath: path.join(__dirname, '__fixtures__/toolbox-publication-stub-delayed-exit.js'),
      onWorkerExit() { exitCount += 1; }
    } });
    try {
      const pending = recovery.recover({ reason: 'startup', onProgress() { doneCount += 1; } })
        .then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(doneCount, 1);
      assert.equal(exitCount, 0);
      assert.equal(released, false);
      assert.equal(settled, false);
      await pending;
      assert.equal(doneCount, 2); assert.equal(exitCount, 2); assert.equal(released, true);
    } finally { Worker.prototype.terminate = originalTerminate; fs.rmSync(root, { recursive: true, force: true }); }
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
    const { dispatcher, recovery } = createTestPublicationHarness(userDataDir);

    try {
      await assert.rejects(
        recovery.recover({ reason: 'startup' }),
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
    const { dispatcher } = createTestPublicationHarness(userDataDir);
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
    const { dispatcher } = createTestPublicationHarness(userDataDir);
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
