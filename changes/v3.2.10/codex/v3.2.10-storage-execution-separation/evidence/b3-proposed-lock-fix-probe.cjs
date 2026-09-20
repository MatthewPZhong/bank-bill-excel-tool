'use strict';

// 待批准方案实验，不是已实施验收。仅在内存 source 字符串应用同目录 .diff，不写 src/main.js。
// 复用 b3-lock-ownership-probe 的源码提取/真实 pool idle crash 取证方式，缩小到锁归属场景。
// 命令（worktree 根）：node changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence/b3-proposed-lock-fix-probe.cjs
// 使用真实 Node worker、真实 pool、自建空 SQLite；VM 只装配 Main 锁/prepare 锁片段/failure listener。
// 本探针不执行完整 IPC prepare/execute、active job、取消、GUI 或 Windows 文件占用验收。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const root = process.cwd();
const mainPath = path.join(root, 'src/main.js');
const pool = require(path.join(root, 'src/main-process/run-check-worker-pool'));
const mainSource = fs.readFileSync(mainPath, 'utf8');
const patch = fs.readFileSync(path.join(__dirname, 'b3-proposed-lock-fix.diff'), 'utf8');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

// 在内存逐行核对并应用 unified diff；任何锚点失配都停止实验，禁止悄悄使用过期方案。
function applyPatchToSource(source, diff) {
  const sourceLines = source.split('\n');
  const patchLines = diff.split('\n');
  assert.equal(patchLines[0], '--- a/src/main.js');
  assert.equal(patchLines[1], '+++ b/src/main.js');
  let cursor = 0;
  let i = 2;
  let hunks = 0;
  const output = [];
  while (i < patchLines.length && patchLines[i]) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patchLines[i++]);
    assert.ok(hunk, '预期 unified diff hunk');
    hunks++;
    const start = Number(hunk[1]) - 1;
    assert.ok(start >= cursor, 'hunk 不可重叠或倒序');
    output.push(...sourceLines.slice(cursor, start));
    cursor = start;
    let removed = 0;
    let added = 0;
    while (i < patchLines.length && patchLines[i] && !patchLines[i].startsWith('@@')) {
      const line = patchLines[i++];
      const prefix = line[0];
      const body = line.slice(1);
      assert.ok([' ', '-', '+'].includes(prefix));
      if (prefix !== '+') {
        assert.equal(sourceLines[cursor++], body, '方案 diff 与当前 Main 不匹配');
        removed++;
      }
      if (prefix !== '-') {
        output.push(body);
        added++;
      }
    }
    assert.equal(removed, Number(hunk[2] || 1));
    assert.equal(added, Number(hunk[4] || 1));
  }
  assert.ok(hunks > 0);
  output.push(...sourceLines.slice(cursor));
  return output.join('\n');
}

function extractBindings(source) {
  const lockStart = source.indexOf('const acquiringBillCurrencyOperationLock =');
  const lockEnd = source.indexOf('// v3.0.11 需求3', lockStart);
  const listenerCall = 'runCheckWorkerPool.setFailureListener(';
  const listenerStart = source.indexOf(listenerCall + '(info) => {') + listenerCall.length;
  const listenerEnd = source.indexOf('\n      });', listenerStart) + 8;
  const prepareStart = source.indexOf("      const lock = tryAcquireOpLock('run', monthKey);");
  const prepareEnd = source.indexOf('      return {\n        proceed: true,\n        monthKey,', prepareStart);
  assert.ok(lockStart >= 0 && lockEnd > lockStart && listenerStart >= listenerCall.length && listenerEnd > listenerStart);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  const lockSource = source.slice(lockStart, lockEnd);
  const listenerSource = source.slice(listenerStart, listenerEnd);
  const prepareSource = source.slice(prepareStart, prepareEnd);
  const logEntries = [];
  const context = vm.createContext({
    businessOperationRegistry: { isInstallTransitionActive: () => false },
    INSTALL_BUSY_MESSAGE: 'busy',
    appendActivityLogEntry(entry) { logEntries.push(entry); },
    database: null,
    Notification: { isSupported: () => false },
  });
  vm.runInContext(lockSource + `
    const tryAcquireOpLock = tryAcquireAcquiringBillCurrencyOpLock;
    const releaseOpLock = releaseAcquiringBillCurrencyOpLock;
    globalThis.lock = acquiringBillCurrencyOperationLock;
    globalThis.prepare = function(monthKey) {
      ${prepareSource}
      return { proceed: true, releaseLock, onAbandon: releaseLock };
    };
  `, context);
  return {
    context, logEntries,
    listener: vm.runInContext('(' + listenerSource + ')', context),
    extraction: {
      lockSha256: hash(lockSource),
      prepareLockAndReleaseSha256: hash(prepareSource),
      failureListenerSha256: hash(listenerSource),
    },
  };
}

async function probe(source, label, dir, expectFixed) {
  const dbPath = path.join(dir, `${label}.sqlite`);
  new DatabaseSync(dbPath).close();
  const { context, listener, extraction, logEntries } = extractBindings(source);
  await pool.preWarm(dbPath);
  const before = pool.getStatus();
  assert.equal(before.workerAlive, true);
  assert.equal(before.busy, false);
  const owner = context.prepare('2026-04');
  assert.equal(owner.proceed, true);
  const failureInfo = await new Promise((resolve) => {
    pool.setFailureListener((info) => {
      listener(info);
      resolve(info);
    });
    pool.__test_only_post__({ type: '__crash_for_test__', code: 1 });
  });
  assert.equal(failureInfo.hadActiveJob, false, '必须是真实 idle pool worker 失败');
  const afterFailure = JSON.parse(JSON.stringify(context.lock));
  const second = context.prepare('2026-05');
  const report = {
    label, sourceSha256: hash(source), extraction,
    workerBeforeFailure: { workerAlive: before.workerAlive, busy: before.busy },
    failure: { source: failureInfo.source, hadActiveJob: failureInfo.hadActiveJob },
    firstPrepare: { proceed: owner.proceed },
    afterIdleFailure: afterFailure,
    secondPrepare: second.proceed ? { proceed: true } : JSON.parse(JSON.stringify(second)),
    activityLogRecorded: logEntries.some((entry) => entry.domain === 'acquiring-bill-currency'),
  };
  if (expectFixed) {
    assert.equal(afterFailure.inFlight, true);
    assert.equal(afterFailure.monthKey, '2026-04');
    assert.equal(second.proceed, false);
    assert.equal(second.result.status, 'busy');
    owner.releaseLock();
    assert.equal(context.lock.inFlight, false);
    const next = context.prepare('2026-05');
    assert.equal(next.proceed, true);
    owner.releaseLock();
    assert.equal(context.lock.inFlight, true, '旧 owner 幂等 release 不应清掉后继 prepare 的锁');
    assert.equal(context.lock.monthKey, '2026-05');
    const third = context.prepare('2026-06');
    assert.equal(third.proceed, false);
    assert.equal(third.result.status, 'busy');
    next.onAbandon();
    assert.equal(context.lock.inFlight, false);
    report.ownerReleaseThenNextPrepare = { nextProceed: next.proceed, oldOwnerSecondReleaseKeptNewLock: true, thirdStatus: third.result.status, nextOnAbandonReleased: true };
    report.proposedInvariantHeld = true;
  } else {
    assert.equal(afterFailure.inFlight, false);
    assert.equal(second.proceed, true);
    second.releaseLock();
    owner.releaseLock();
    report.currentDefectReproduced = true;
  }
  await pool.__reset_for_test__();
  return report;
}

(async () => {
  const proposedSource = applyPatchToSource(mainSource, patch);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-b3-proposed-lock-'));
  const report = {
    recordedAt: new Date().toISOString(),
    state: '待批准方案实验；生产 Main 未修改；不作为已实施 B3 验收',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    worktree: root,
    currentMainSha256: hash(mainSource),
    proposedMainSha256: hash(proposedSource),
    proposedDiffSha256: hash(patch),
  };
  try {
    report.current = await probe(mainSource, 'current', dir, false);
    report.proposed = await probe(proposedSource, 'proposed', dir, true);
    assert.equal(report.current.extraction.lockSha256, report.proposed.extraction.lockSha256);
    assert.equal(report.current.extraction.prepareLockAndReleaseSha256, report.proposed.extraction.prepareLockAndReleaseSha256);
    assert.equal(hash(fs.readFileSync(mainPath)), hash(mainSource), '探针期间真实 Main 必须保持不变');
    report.productionMainUnchanged = true;
    report.proposedExperimentPassed = true;
    report.boundary = '实际 pool/worker idle crash + Main 原锁函数/prepare锁与release闭包/failure listener的VM装配；仅source字符串应用diff。未覆盖完整IPC prepare/execute、active job失败、取消、Windows/Electron或两个真实MW共享目录；等待用户批准后才能实施并取得相称回归证据。';
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.__reset_for_test__();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
