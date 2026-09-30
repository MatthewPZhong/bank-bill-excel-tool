// v2.1.12 β.1-T1 — 多 worker write-splitting（plan-b）生产编排模块
//
// 自包含模块：把已验证的 POC plan-b（scripts/poc/v2.1.12-beta-multiworker-poc.js#runPlanB）
// 提升为生产用、可被 runCheckCore 接入的「多 worker write-splitting」机制。
//
// plan-b 机制（spec §4 D30 / §5.1 POC 实测 GO）：
//   1. 主进程按 chunks 列表分发给 M 个 worker（round-robin 队列，每 worker 同时只跑 1 个 chunk）
//   2. 每 worker 并行执行只读 SELECT JOIN（WAL 下并发 SELECT 不冲突）→ 写自己的 temp db（无跨 worker 写竞争）
//   3. 主进程（单一 connection、串行）按 chunkIndex 升序 ATTACH 各 temp db → INSERT...SELECT 汇总到目标表 → DETACH
//
// 🔴🔴 资金红线 —— byte-for-byte 物理顺序不变量（本模块核心契约）：
//   目标表插入顺序必须等价于单 worker 逐 chunk INSERT...SELECT（生产 run-repository.js#insertDiffRowsByJoinChunked）：
//     = chunk 0,1,2... 升序  ×  每 chunk 内 SELECT 返回顺序（worker temp db 的 seq ASC）
//   实现保证：
//     - worker 写 temp db 的 diff_part.seq AUTOINCREMENT = SELECT 返回顺序（worker 文件保证）
//     - 主进程汇总 **严格按 chunkIndex 0..N-1 升序** 逐个 ATTACH + `ORDER BY seq ASC` INSERT（即使 worker 乱序完成）
//   单测（tests/unit/main-process/run-check-multiworker.test.js）锁死此不变量（含乱序完成场景）。
//
// 🔴 并发红线 —— 无 SQLITE_BUSY：
//   reader 阶段全部是只读 SELECT（worker 各自 connection，WAL 下并发不冲突）；
//   writer 阶段只有主进程单一 connection 串行 INSERT（无并发写）→ 无写竞争。
//
// 与 POC 的差异（生产化加固）：
//   1. SQL 不写死 —— selectSql / partColumns 由调用方注入（业务无关；T-b1-2 接入时传 run-repository 同款 SELECT）
//   2. crash recovery —— worker 'error'/'exit' 事件 → reject 该 worker 在跑的 chunk → 整体 reject
//   3. temp db 清理 —— 无论成功/失败/crash，finally 清掉所有已知 temp db 文件（不泄漏）
//   4. PRAGMA / 错误序列化 —— 复用 serialize-error.js + 与 run-check-worker.js 同款 6 条 PRAGMA（worker 文件内）
//   5. workerCount 由调用方传入（模块不决定默认值 —— OOM 降级 / 甜点 M=4 由 caller 按 settings + 行数决策）
//
// 进程边界（与 run-check-worker-pool.js 一致）：
//   - 不访问 Electron API；不持有 idle timer；不直写 activity log
//   - onProgress 回调透传给 caller（caller 负责聚合到 IPC progress / activity log）
//
// 生产由 Acquiring 调用链装配；执行器只拥有本次 worker 组及派发 part，不推进 run 状态。

'use strict';
const { memoryCarrierAdmission } = require('./memory-activity');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_SCRIPT_PATH = path.join(__dirname, 'run-check-multiworker-worker.js');
const { PART_TABLE } = require('./run-check-multiworker-worker');

// 反序列化 worker message 中的 error（复用生产 serialize-error.js）
function deserializeFromMessage(serialized) {
  if (!serialized) return new Error('multiworker unknown error');
  try {
    return require('./serialize-error').deserializeError(serialized);
  } catch (_e) {
    const err = new Error(serialized.message || 'unknown');
    if (serialized.name) err.name = serialized.name;
    if (serialized.code) err.code = serialized.code;
    return err;
  }
}

// 测试专用：允许注入备用 worker script（模拟 init crash / chunk crash）。生产代码不调用。
let workerScriptOverride = null;
function resolveWorkerScript() {
  return workerScriptOverride || WORKER_SCRIPT_PATH;
}
function __test_only_set_worker_script__(scriptPath) {
  workerScriptOverride = scriptPath || null;
}

// ─────────────────────────────────────────────────────────────────
// worker 生命周期（每次 runWriteSplitChunks 起一组临时 worker，跑完即 shutdown — 不做常驻单例）
//   理由：本模块定位为 runCheckCore 内一次 chunked 写入的并行执行器，生命周期 = 单次 run；
//        常驻 pool（跨 run 复用）由上层 run-check-worker-pool 范式负责，β.1 框架不在此处耦合。
// ─────────────────────────────────────────────────────────────────

// 每组立即登记所有已创建线程；初始化结果与退出所有权分别维护。
function createWorkerGroup(closeTimeoutMs, batchContext) {
  const group = { records: [], firstError: null, stopped: false, closeTimeoutMs,
    taskRunId: batchContext && batchContext.taskRunId };
  group.fail = (error) => {
    if (!group.firstError) group.firstError = error;
    group.stopped = true;
    for (const record of group.records) {
      if (record.cancelInit) record.cancelInit(group.firstError);
      stopWorker(record, closeTimeoutMs);
    }
  };
  return group;
}

function registerWorker(group, worker) {
  let resolveExit;
  const record = { worker, workerId: worker.threadId, exited: false, initSettled: false,
    stopPromise: null, stopping: false, terminateStarted: false, shutdownErrors: [],
    exitPromise: new Promise((resolve) => { resolveExit = resolve; }) };
  group.records.push(record);
  const onError = (error) => {
    if (record.onError) record.onError(error);
    else if (!record.stopping) group.fail(new Error(`multiworker worker error 事件：${error.message}`));
  };
  record.confirmExit = (code) => {
    if (record.exited) return;
    record.exited = true;
    record.exitCode = code;
    resolveExit();
    worker.off('error', onError);
    if (record.onExit) record.onExit(code);
    else if (!record.stopping) group.fail(new Error(`multiworker worker 意外 exit（code=${code}）`));
  };
  worker.on('error', onError);
  worker.once('exit', record.confirmExit);
  record.reportShutdownError = (phase, error) => {
    record.shutdownErrors.push({ phase, error });
    process.emitWarning(
      `multiworker shutdown worker=${record.workerId} taskRunId=${group.taskRunId || 'unassigned'} phase=${phase}: ${error.message}`,
      { code: 'MULTIWORKER_TERMINATE_FAILED' }
    );
  };
  return record;
}

// 启动只表达 init 就绪/失败；任何失败交给组停止，退出屏障由 finally 持有。
function startWorker(group, dbPath, selectSql, partColumns, batchContext, initTimeoutMs) {
  if (group.stopped) return Promise.reject(group.firstError);
  let record;
  try {
    record = registerWorker(group, memoryCarrierAdmission(null).observe(new Worker(resolveWorkerScript())));
  } catch (error) {
    group.fail(error);
    return Promise.reject(error);
  }
  const { worker } = record;
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      if (record.initSettled) return;
      record.initSettled = true;
      clearTimeout(timer);
      worker.off('message', onMsg);
      record.onError = null;
      record.onExit = null;
      record.cancelInit = null;
      if (error) reject(error);
      else resolve(record);
    };
    const onMsg = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'init-done') finish(group.stopped ? group.firstError : null);
      else if (msg.type === 'init-error') group.fail(deserializeFromMessage(msg.error));
    };
    record.cancelInit = finish;
    record.onError = (error) => group.fail(new Error(`multiworker init 期 error 事件：${error && error.message ? error.message : String(error)}`));
    record.onExit = (code) => group.fail(new Error(`multiworker init 期意外 exit（code=${code}）`));
    worker.on('message', onMsg);
    timer = setTimeout(() => {
      group.fail(new Error(`multiworker init 超时（${initTimeoutMs}ms）— 强制 terminate`));
    }, initTimeoutMs);
    try { worker.postMessage({ type: 'init', dbPath, selectSql, partColumns, batchContext }); }
    catch (error) { group.fail(error); }
  });
}

// closeTimeout 只是优雅关闭期限；terminate 的发出、抛错或 reject 均不是退出确认。
function stopWorker(record, timeoutMs) {
  if (record.stopPromise) return record.stopPromise;
  record.stopping = true;
  record.stopPromise = (async () => {
    if (record.exited) return;
    let timer;
    const terminate = () => {
      if (record.exited || record.terminateStarted) return;
      record.terminateStarted = true;
      clearTimeout(timer);
      try {
        Promise.resolve(record.worker.terminate()).then(record.confirmExit, (error) => {
          if (!record.exited) record.reportShutdownError('terminate', error);
        });
      } catch (error) {
        if (!record.exited) record.reportShutdownError('terminate', error);
      }
    };
    timer = setTimeout(terminate, timeoutMs);
    try { record.worker.postMessage({ type: 'close' }); }
    catch (_error) { terminate(); }
    await record.exitPromise;
    clearTimeout(timer);
  })();
  return record.stopPromise;
}

async function closePool(records, timeoutMs = 5000) {
  await Promise.all(records.map((record) => stopWorker(record, timeoutMs)));
}

// 清理所有 temp db 文件（含 WAL/SHM 旁文件）—— 无论成功/失败/crash 都调，防泄漏
function cleanupTempFiles(tempPaths) {
  for (const p of tempPaths) {
    if (!p) continue;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.rmSync(p + suffix, { force: true }); } catch (_e) { /* swallow */ }
    }
  }
}

// 主进程汇总：按 chunkIndex 升序逐个 ATTACH temp db → INSERT...SELECT 到目标表 → DETACH
//   🔴 顺序不变量：chunk 0..N-1 升序 + `ORDER BY seq ASC`（worker temp db seq = SELECT 返回顺序）
//   targetColumns 顺序必须与 partColumns 一一对应（caller 保证）；prefixValues 是每行固定前缀值（如 run_id）
function mergeTempDbsInOrder(db, {
  tempPaths,         // tempPaths[chunkIndex] = temp db 路径（升序数组，可能含 undefined 表示空 chunk）
  targetTable,
  targetColumns,     // 目标表列名（含 prefix 列；顺序：prefixColumns... + partColumns...）
  partColumnNames,   // temp db diff_part 业务列名（顺序 = SELECT 输出列别名）
  prefixValues,      // 前缀列值数组（每行固定，前 prefixValues.length 列由它提供，不来自 temp db）
}) {
  let inserted = 0;
  const targetColsSql = targetColumns.join(', ');
  const prefixPlaceholders = prefixValues.map(() => '?');
  // SELECT 列：前缀占位符（?,?...） + temp db 业务列
  const selectColsSql = [...prefixPlaceholders, ...partColumnNames].join(', ');
  const insertSelectSql = `
    INSERT INTO ${targetTable} (${targetColsSql})
    SELECT ${selectColsSql}
    FROM tmp.${PART_TABLE}
    ORDER BY seq ASC
  `;

  for (let ci = 0; ci < tempPaths.length; ci++) {
    const tp = tempPaths[ci];
    if (!tp) continue; // 空 chunk（worker SELECT 返回 0 行也会建空 temp db；undefined 仅在防御性留位时出现）
    if (!fs.existsSync(tp)) continue;
    const escaped = tp.replace(/'/g, "''");
    db.exec(`ATTACH DATABASE '${escaped}' AS tmp`);
    try {
      db.exec('BEGIN');
      try {
        const stmt = db.prepare(insertSelectSql);
        const r = stmt.run(...prefixValues);
        inserted += Number(r.changes);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
        throw e;
      }
    } finally {
      // 确保 DETACH（否则下一 chunk ATTACH AS tmp 会因同名占用失败）
      try { db.exec('DETACH DATABASE tmp'); } catch (_e) { /* swallow */ }
    }
  }
  return inserted;
}

// ─────────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────────

/**
 * runWriteSplitChunks —— 多 worker write-splitting（plan-b）执行一批 chunked 写入。
 *
 * @param {object} opts
 * @param {DatabaseSync} opts.db            主进程目标 DB connection（汇总 INSERT 用；调用方持有）
 * @param {string} opts.dbPath              主源 sqlite 路径（worker 各自 open 只读 connection）
 * @param {number} opts.workerCount         worker 数（M）—— 调用方按 settings/行数/OOM 决策，模块不设默认
 * @param {Array<object>} opts.chunks       chunk 列表，每项 { chunkIndex, bindParams }
 *                                            - chunkIndex：0..N-1（汇总顺序的真理源）
 *                                            - bindParams：传给 selectSql 的绑定参数数组（占位符顺序由 caller 定）
 * @param {string} opts.selectSql           只读业务 SELECT JOIN（输出列别名顺序 = partColumns）；worker prepare
 * @param {Array<string>} opts.partColumns  SELECT 输出 / temp db 业务列名（顺序敏感）
 * @param {string} opts.targetTable         汇总目标表名
 * @param {Array<string>} opts.targetColumns 目标表列名（顺序：prefixColumns... + partColumns...）
 * @param {Array<*>} [opts.prefixValues]    每行固定前缀列值（如 [runId]）；默认 []
 * @param {string} opts.tempDir             temp db 存放目录（caller 提供；模块只写 part-<ci>.sqlite，清理也在此）
 * @param {function} [opts.onProgress]      (ev) => void，ev = { completedChunks, totalChunks, chunkIndex, rowCount }
 * @param {number} [opts.initTimeoutMs]     单 worker init 超时（默认 10000，与单 worker pool 一致）
 * @param {number} [opts.closeTimeoutMs]    优雅关闭期限（默认 5000）；超时后仍等待真实退出
 * @returns {Promise<{ insertedRows:number, totalChunks:number, workerCount:number }>}
 *
 * 失败语义：reader 失败不开始汇总；merge 逐 chunk 事务，失败可能保留此前已合并的行。
 *   finally 确认全部已创建 worker 退出后清理本次派发的 part；调用方负责按 run 清理/续跑。
 */
async function runWriteSplitChunks(opts) {
  const {
    db,
    dbPath,
    workerCount,
    chunks,
    selectSql,
    partColumns,
    targetTable,
    targetColumns,
    prefixValues = [],
    tempDir,
    batchContext,
    onProgress = null,
    cancelToken = null,
    initTimeoutMs = 10000,
    closeTimeoutMs = 5000,
  } = opts || {};

  // ── 入参校验（fail-fast；契约破坏宁可抛错不静默降级 — 资金红线模块）──
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new Error('runWriteSplitChunks：db 必填（DatabaseSync connection）');
  }
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('runWriteSplitChunks：dbPath 必填');
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`runWriteSplitChunks：workerCount 必须是 ≥1 整数（实际 ${workerCount}）`);
  }
  if (!Array.isArray(chunks)) {
    throw new Error('runWriteSplitChunks：chunks 必须是数组');
  }
  if (!selectSql || typeof selectSql !== 'string') {
    throw new Error('runWriteSplitChunks：selectSql 必填');
  }
  if (!Array.isArray(partColumns) || partColumns.length === 0) {
    throw new Error('runWriteSplitChunks：partColumns 必须是非空数组');
  }
  const partColumnNames = partColumns.map((c) => (typeof c === 'string' ? c : c && c.name));
  for (const name of partColumnNames) {
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`runWriteSplitChunks：partColumns 含非法列名 ${JSON.stringify(name)}`);
    }
  }
  if (!targetTable || typeof targetTable !== 'string') {
    throw new Error('runWriteSplitChunks：targetTable 必填');
  }
  if (!Array.isArray(targetColumns) || targetColumns.length === 0) {
    throw new Error('runWriteSplitChunks：targetColumns 必须是非空数组');
  }
  if (!Array.isArray(prefixValues)) {
    throw new Error('runWriteSplitChunks：prefixValues 必须是数组');
  }
  // 列数一致性：targetColumns = prefixValues + partColumns（顺序对齐，byte-for-byte 列映射前提）
  if (targetColumns.length !== prefixValues.length + partColumnNames.length) {
    throw new Error(
      `runWriteSplitChunks：targetColumns(${targetColumns.length}) 必须 = prefixValues(${prefixValues.length}) + partColumns(${partColumnNames.length})`
    );
  }
  if (!tempDir || typeof tempDir !== 'string') {
    throw new Error('runWriteSplitChunks：tempDir 必填');
  }
  // v2.1.12 β.1-T3：确保 tempDir 存在（recursive 幂等）。
  //   caller 传入的 tempDir（如 main.js 的 storageRoot/.mw-tmp）可能尚未创建；
  //   worker 写 part-<ci>.sqlite 前目录不存在会报 SQLITE "unable to open database file"。
  //   集成测试 v2.1.12-beta-multiworker-nested 抓到此真实路径（caller 提供 tempDir 时无人 mkdir）。
  fs.mkdirSync(tempDir, { recursive: true });
  // chunkIndex 校验：必须是 0..N-1 连续无重复（汇总按下标定位 tempPaths，缺位/越界会破坏顺序契约）
  const totalChunks = chunks.length;
  if (totalChunks === 0) {
    return { insertedRows: 0, totalChunks: 0, workerCount };
  }
  const seen = new Set();
  for (const c of chunks) {
    if (!c || !Number.isInteger(c.chunkIndex) || c.chunkIndex < 0 || c.chunkIndex >= totalChunks) {
      throw new Error(`runWriteSplitChunks：chunk.chunkIndex 必须是 0..${totalChunks - 1} 整数（实际 ${c && c.chunkIndex}）`);
    }
    if (seen.has(c.chunkIndex)) {
      throw new Error(`runWriteSplitChunks：chunk.chunkIndex 重复 ${c.chunkIndex}`);
    }
    seen.add(c.chunkIndex);
  }

  // M 封顶到 chunk 数（chunk 数 < worker 数时多起的 worker 无活干 — 见 spec §4 末注；caller 也应预判回退）
  const effectiveWorkerCount = Math.min(workerCount, totalChunks);

  const tempPaths = new Array(totalChunks).fill(undefined); // tempPaths[chunkIndex] = temp db 路径
  const group = createWorkerGroup(closeTimeoutMs, batchContext);

  try {
    // ── 启动 effectiveWorkerCount 个 worker（并发 init）──
    const initResults = await Promise.allSettled(
      Array.from({ length: effectiveWorkerCount }, () => (
        startWorker(group, dbPath, selectSql, partColumns, batchContext, initTimeoutMs)
      ))
    );
    if (group.firstError) throw group.firstError;
    const workers = initResults.map((result) => result.value);

    // ── reader 阶段：worker 池领 chunk 写各自 temp db（round-robin 队列）──
    //   chunk 派发顺序无所谓（汇总按 chunkIndex 升序）；每 worker 同时只跑 1 个 chunk。
    let nextIdx = 0;
    let completedChunks = 0;
    // 任一 chunk 失败/crash 即停止本组派发 —— 存活 worker loop 领新 chunk 前自停，
    //   防 crash 后存活 worker 继续写新 temp 文件、与 finally 的 cleanup 竞争造成 temp 泄漏。

    // 把一个 chunk 任务包成 Promise；同时挂 worker 级 error/exit 监听 → crash 时 reject 本 chunk
    function dispatchChunkToWorker(record, chunkSpec) {
      const { worker } = record;
      return new Promise((resolve, reject) => {
        let settled = false;
        const jobId = `c-${chunkSpec.chunkIndex}`;
        const tempDbPath = path.join(tempDir, `part-${chunkSpec.chunkIndex}.sqlite`);
        const cleanup = () => {
          worker.off('message', onMsg);
          record.onError = null;
          record.onExit = null;
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          tempPaths[chunkSpec.chunkIndex] = tempDbPath;
          // Node 的 worker error 与 exit 可能在同一调用栈发出；首错必须同步登记，
          // 不能等 await 的 catch，否则后续 exit 会先覆盖原 reader 错误。
          group.fail(error);
          reject(error);
        };
        const onMsg = (msg) => {
          if (!msg || msg.jobId !== jobId) return;
          if (msg.type === 'temp-done') {
            if (settled) return;
            settled = true; cleanup();
            tempPaths[chunkSpec.chunkIndex] = msg.tempDbPath;
            resolve(msg);
          } else if (msg.type === 'error') {
            fail(deserializeFromMessage(msg.error));
          }
        };
        const onErr = (err) => {
          fail(new Error(`multiworker chunk=${chunkSpec.chunkIndex} worker error 事件：${err && err.message ? err.message : String(err)}`));
        };
        const onExit = (code) => {
          const error = new Error(`multiworker chunk=${chunkSpec.chunkIndex} worker 异常 exit（code=${code}）`);
          error.workerFailureSource = 'exit';
          fail(error);
        };
        worker.on('message', onMsg);
        record.onError = onErr;
        record.onExit = onExit;
        // 发送失败也可能已创建部分资源，始终只登记本次派发的精确路径。
        tempPaths[chunkSpec.chunkIndex] = tempDbPath;
        if (record.exited) { onExit(record.exitCode); return; }
        try { worker.postMessage({
          type: 'select-chunk-to-temp',
          jobId,
          chunkIndex: chunkSpec.chunkIndex,
          bindParams: chunkSpec.bindParams,
          tempDbPath,
        }); } catch (error) {
          fail(error);
        }
      });
    }

    async function workerLoop(worker) {
      while (true) {
        if (group.stopped) break; // 已有 chunk 失败 → 停止领新 chunk（不再写新 temp）
        // PR #57 review P2：cancel 响应（与单 worker run-repository.js:279 同语义，每 chunk 之间 check）。
        //   cancelToken.cancelled → 停止派发新 chunk + abort（reader 阶段中止 → 下方 merge 不执行 → 无 diff_rows
        //   写入；catch 仍 clearDiffRowsByRunId 兜底）。cancel 延迟 ≤ 在飞 chunk 完成时间（受自适应分片约束）。
        //   修 review「MW 仅在全部 worker 完成+提交后才查取消、违反手册 <5s」。
        if (cancelToken && cancelToken.cancelled) {
          const e = new Error('multiworker cancelled');
          e.name = 'CancelError'; // 与 session CancelError 同名识别（跨模块不用 instanceof）
          group.fail(e);
          break;
        }
        const i = nextIdx++;
        if (i >= totalChunks) break;
        const chunkSpec = chunks[i];
        let res;
        try {
          res = await dispatchChunkToWorker(worker, chunkSpec);
        } catch (err) {
          // 记下首个错误并停止本组；不在 loop 内 throw（用 allSettled 等所有 loop 收尾后统一 reject，
          //   保证 finally cleanup 时没有 loop 还在写 temp 文件）
          group.fail(err);
          break;
        }
        completedChunks++;
        if (typeof onProgress === 'function') {
          try {
            onProgress({
              completedChunks,
              totalChunks,
              chunkIndex: chunkSpec.chunkIndex,
              rowCount: res.rowCount,
            });
          } catch (_e) { /* swallow — progress 回调抛错不影响主流程 */ }
        }
      }
    }

    // 等所有 loop 收尾（allSettled — 不会因首个失败而提前继续主流程）；reader 任一失败则拒绝并跳过汇总
    const loopResults = await Promise.allSettled(workers.map((record) => workerLoop(record)));
    const failedLoop = loopResults.find((result) => result.status === 'rejected');
    if (failedLoop) group.fail(failedLoop.reason);
    if (group.firstError) throw group.firstError;

    // ── writer 阶段：主进程单一 connection 串行按 chunkIndex 升序 ATTACH 汇总（🔴 顺序不变量）──
    const insertedRows = mergeTempDbsInOrder(db, {
      tempPaths,
      targetTable,
      targetColumns,
      partColumnNames,
      prefixValues,
    });

    return { insertedRows, totalChunks, workerCount: effectiveWorkerCount };
  } finally {
    // 1. 关 worker 池（即使中途 reject，也要回收子线程）
    await closePool(group.records, closeTimeoutMs);
    // 2. 清 temp db（无论成功/失败/crash 都清 — 不泄漏）
    cleanupTempFiles(tempPaths);
  }
}

// ─────────────────────────────────────────────────────────────────
// 辅助：默认 temp dir 工厂（caller 可用；模块不强制 — caller 也可传 run 专属目录）
// ─────────────────────────────────────────────────────────────────
function makeTempDir(prefix = 'mw-writesplit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanupDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
}

module.exports = {
  runWriteSplitChunks,
  makeTempDir,
  cleanupDir,
  // 测试 / 高级用法导出
  __test_only__: {
    mergeTempDbsInOrder,
    cleanupTempFiles,
    PART_TABLE,
  },
  __test_only_set_worker_script__,
};
