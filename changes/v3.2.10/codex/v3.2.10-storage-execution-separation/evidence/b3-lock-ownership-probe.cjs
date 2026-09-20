'use strict';

// G6 B3 只读取证。命令须在本功能 worktree 根执行：
// node changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence/b3-lock-ownership-probe.cjs
// 从实际 main.js 原文提取锁函数和 failureListener；未重写其分支/释放逻辑。
// vm 只替换 Electron/日志/安装状态等外界依赖；pool 和 worker 使用实际源文件。
// 数据库、输出均为本次私有临时 fixture。不会读取或修改用户业务数据。
// 0 退出码表示探针执行完成，JSON defectConfirmed 才表示是否复现缺陷；不是切片验收 PASS。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const root = process.cwd();
const pool = require(path.join(root, 'src/main-process/run-check-worker-pool'));
const { AppDatabase } = require(path.join(root, 'src/backend/database'));
const mainSource = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sourceRange(source, start, finish) {
  return { startLine: source.slice(0, start).split('\n').length, endLine: source.slice(0, finish).split('\n').length };
}
function getMainBindings() {
  const lockStart = mainSource.indexOf('const acquiringBillCurrencyOperationLock =');
  const lockEnd = mainSource.indexOf('// v3.0.11 需求3', lockStart);
  const listenerCall = 'runCheckWorkerPool.setFailureListener(';
  const listenerStart = mainSource.indexOf(listenerCall + '(info) => {') + listenerCall.length;
  const listenerEnd = mainSource.indexOf('\n      });', listenerStart) + 8;
  if (lockStart < 0 || lockEnd < lockStart || listenerStart < listenerCall.length || listenerEnd < listenerStart) {
    throw new Error('Main 提取锚点变化；请核对实际函数，不能继续使用过期探针');
  }
  const lockSource = mainSource.slice(lockStart, lockEnd);
  const listenerSource = mainSource.slice(listenerStart, listenerEnd);
  const context = vm.createContext({
    businessOperationRegistry: { isInstallTransitionActive: () => false },
    INSTALL_BUSY_MESSAGE: 'busy',
    appendActivityLogEntry() {},
    database: null,
    Notification: { isSupported: () => false },
  });
  vm.runInContext(lockSource + ';globalThis.acquire=tryAcquireAcquiringBillCurrencyOpLock;globalThis.lock=acquiringBillCurrencyOperationLock;', context);
  return {
    context,
    listener: vm.runInContext('(' + listenerSource + ')', context),
    extraction: {
      lock: { ...sourceRange(mainSource, lockStart, lockEnd), sha256: sha256(lockSource) },
      listener: { ...sourceRange(mainSource, listenerStart, listenerEnd), sha256: sha256(listenerSource) },
    },
  };
}

async function probeIdleFailure(dir) {
  const dbPath = path.join(dir, 'idle.sqlite');
  new DatabaseSync(dbPath).close();
  const { context, listener, extraction } = getMainBindings();
  await pool.preWarm(dbPath);
  const before = pool.getStatus();
  const firstPrepare = context.acquire('run', '2026-04');
  let failureInfo;
  const failure = new Promise((resolve) => pool.setFailureListener((info) => {
    failureInfo = info;
    listener(info);
    resolve();
  }));
  pool.__test_only_post__({ type: '__crash_for_test__', code: 1 });
  await failure;
  const lockAfterIdleFailure = JSON.parse(JSON.stringify(context.lock));
  const secondPrepare = context.acquire('run', '2026-05');
  await pool.__reset_for_test__();
  return {
    extraction,
    before,
    firstPrepare,
    hadActiveJob: failureInfo.hadActiveJob,
    failureSource: failureInfo.source,
    lockAfterIdleFailure,
    secondPrepare,
    defectConfirmed: firstPrepare.acquired && !failureInfo.hadActiveJob && !lockAfterIdleFailure.inFlight && secondPrepare.acquired,
    scope: '真实 idle worker exit + 实际 Main 锁/回调；复现两个 prepare 均获同一模块锁，不声称已经证明两个活跃 MW 同目录重叠',
  };
}

async function probeNestedExit() {
  const results = [];
  for (let i = 0; i < 6; i += 1) {
    const shared = new SharedArrayBuffer(8);
    const values = new Int32Array(shared);
    const childSource = `const{workerData,parentPort}=require('node:worker_threads');const v=new Int32Array(workerData);parentPort.postMessage('ready');while(true)Atomics.add(v,0,1);`;
    const parentSource = `const{Worker,parentPort,workerData}=require('node:worker_threads');const child=new Worker(${JSON.stringify(childSource)},{eval:true,workerData});child.once('message',()=>parentPort.postMessage('ready'));parentPort.on('message',m=>{if(m==='crash')throw Error('parent crash fixture');if(m==='exit')process.exit(1);});`;
    const parent = new Worker(parentSource, { eval: true, workerData: shared });
    let errorObserved = false;
    let incrementsDuringError = null;
    parent.on('error', () => {
      errorObserved = true;
      const before = Atomics.load(values, 0);
      const deadline = Date.now() + 60;
      while (Date.now() < deadline) { /* 主线程等待期间子 worker 仍有独立 CPU 调度机会 */ }
      incrementsDuringError = Atomics.load(values, 0) - before;
    });
    const exited = new Promise((resolve) => parent.once('exit', resolve));
    await new Promise((resolve) => parent.once('message', resolve));
    const mode = ['uncaught-error', 'process.exit', 'terminate'][i % 3];
    if (i % 3 === 0) parent.postMessage('crash');
    else if (i % 3 === 1) parent.postMessage('exit');
    else await parent.terminate();
    const exitCode = await exited;
    const atExit = Atomics.load(values, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    results.push({ mode, exitCode, errorObserved, incrementsDuringError, incrementsAfterExit: Atomics.load(values, 0) - atExit });
  }
  return {
    results,
    scope: '真实 Node nested worker 的 SAB 持续自增探针；未见 error/exit 后继续写入，仅是当前 Node/macOS 实测，不冒充 Electron/Windows 保证',
  };
}

async function probeConcurrentDispatch(dir) {
  const dbPath = path.join(dir, 'dispatch.sqlite');
  const appDb = new AppDatabase(dbPath);
  appDb.init();
  const db = appDb.db;
  db.exec('BEGIN');
  const flow = db.prepare(`INSERT INTO acquiring_bill_currency_flow_imports(month_key,source_file,source_row_index,recon_main_id,settle_amount,settle_amount_abs,settle_currency,settle_currency_norm,raw_json) VALUES(?,?,?,?,?,?,?,?,?)`);
  const bill = db.prepare(`INSERT INTO acquiring_bill_currency_bill_imports(month_key,source_file,source_row_index,recon_main_id,settle_currency,settle_currency_norm,raw_json) VALUES(?,?,?,?,?,?,?)`);
  for (let i = 0; i < 240; i += 1) {
    flow.run('2026-04', 'fixture-flow.xlsx', i + 2, `ID-${i}`, '100', '100', 'USD', 'usd', '{}');
    bill.run('2026-04', 'fixture-bill.xlsx', i + 2, `ID-${i}`, 'EUR', 'eur', JSON.stringify({ '账单日期': '2026-04-15' }));
  }
  db.exec('COMMIT');
  db.close();
  await pool.preWarm(dbPath);
  const payload = { __dbPath: dbPath, monthKey: '2026-04', storageRoot: dir, chunkSize: 40, workerCount: 2, tempDir: path.join(dir, '.mw-tmp'), __forceMultiWorkerForTest: true };
  let first = { state: 'pending' };
  let second = { state: 'pending' };
  pool.dispatchRunCheck(payload, { onProgress() {} }).then(
    (result) => { first = { state: 'fulfilled', runId: result.runId }; },
    (error) => { first = { state: 'rejected', message: error.message }; }
  );
  pool.dispatchRunCheck(payload, { onProgress() {} }).then(
    (result) => { second = { state: 'fulfilled', runId: result.runId }; },
    (error) => { second = { state: 'rejected', message: error.message }; }
  );
  const started = Date.now();
  while (second.state === 'pending' && Date.now() - started < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const whenSecondSettled = { first: { ...first }, second: { ...second }, pool: pool.getStatus() };
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const reader = new DatabaseSync(dbPath);
  const persistedRuns = reader.prepare('SELECT id,chunk_progress FROM acquiring_bill_currency_runs ORDER BY id').all();
  const diffCount = reader.prepare('SELECT COUNT(*) AS c FROM acquiring_bill_currency_diff_rows').get().c;
  reader.close();
  const afterWork = { first: { ...first }, second: { ...second }, pool: pool.getStatus(), persistedRuns, diffCount };
  await pool.__reset_for_test__();
  return {
    whenSecondSettled,
    afterWork,
    scope: '模拟两个已放行 prepare 的 execute 同时调用真实 pool/worker/session；worker 内部 activeJob 会拒绝第二个 run，本探针未证明两个 MW 同目录并行；记录 pool activeJob 提前检查/覆盖造成的悬空 caller',
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-b3-lock-probe-'));
  const report = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    worktree: root,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    mainSha256: sha256(mainSource),
    poolSha256: sha256(fs.readFileSync(path.join(root, 'src/main-process/run-check-worker-pool.js'))),
  };
  try {
    report.idleFailure = await probeIdleFailure(dir);
    report.nestedExit = await probeNestedExit();
    report.concurrentDispatch = await probeConcurrentDispatch(dir);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.__reset_for_test__();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
