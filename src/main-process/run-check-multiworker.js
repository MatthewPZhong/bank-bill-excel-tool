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
//   2. crash recovery —— worker 'error'/'exit' 事件 → reject 该 worker 在跑的 chunk → 整体 reject（plan-b 全有或全无）
//   3. temp db 清理 —— 无论成功/失败/crash，finally 清掉所有已知 temp db 文件（不泄漏）
//   4. PRAGMA / 错误序列化 —— 复用 serialize-error.js + 与 run-check-worker.js 同款 6 条 PRAGMA（worker 文件内）
//   5. workerCount 由调用方传入（模块不决定默认值 —— OOM 降级 / 甜点 M=4 由 caller 按 settings + 行数决策）
//
// 进程边界（与 run-check-worker-pool.js 一致）：
//   - 不访问 Electron API；不持有 idle timer；不直写 activity log
//   - onProgress 回调透传给 caller（caller 负责聚合到 IPC progress / activity log）
//
// 本模块此刻无生产调用方（T-b1-2 才接入 runCheckCore）—— 纯新增、零回归。

'use strict';

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

// 启动单个 worker 并发 init（指向只读主源 dbPath + 注入 selectSql / partColumns）
function startWorker(dbPath, selectSql, partColumns, initTimeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let worker;
    try {
      worker = new Worker(resolveWorkerScript());
    } catch (e) {
      return reject(e);
    }
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      worker.off('message', onMsg);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMsg = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'init-done') {
        if (settled) return;
        settled = true; cleanup(); resolve(worker);
      } else if (msg.type === 'init-error') {
        if (settled) return;
        settled = true; cleanup();
        try { worker.terminate(); } catch (_e) { /* swallow */ }
        reject(deserializeFromMessage(msg.error));
      }
    };
    const onError = (err) => {
      if (settled) return;
      settled = true; cleanup();
      try { worker.terminate(); } catch (_e) { /* swallow */ }
      reject(new Error(`multiworker init 期 error 事件：${err && err.message ? err.message : String(err)}`));
    };
    const onExit = (code) => {
      if (settled) return;
      settled = true; cleanup();
      reject(new Error(`multiworker init 期意外 exit（code=${code}）`));
    };
    worker.on('message', onMsg);
    worker.once('error', onError);
    worker.once('exit', onExit);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true; cleanup();
      try { worker.terminate(); } catch (_e) { /* swallow */ }
      reject(new Error(`multiworker init 超时（${initTimeoutMs}ms）— 强制 terminate`));
    }, initTimeoutMs);
    worker.postMessage({ type: 'init', dbPath, selectSql, partColumns });
  });
}

// 关闭一组 worker（发 close → 等 exit；超时 terminate 兜底）
//   ⚠️ 已 exit 的 worker（crash 路径，标记 w.__exited）直接跳过 —— 否则对死 worker 等 'exit' 事件
//      永远不触发（事件已过），白白阻塞到 timeout（crash case 的 5s 卡顿来源）
async function closePool(workers, timeoutMs = 5000) {
  await Promise.all(workers.map((w) => new Promise((resolve) => {
    if (!w || w.__exited) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    const timer = setTimeout(() => { try { w.terminate(); } catch (_e) { /* swallow */ } finish(); }, timeoutMs);
    w.on('exit', () => { clearTimeout(timer); finish(); });
    try { w.postMessage({ type: 'close' }); } catch (_e) { clearTimeout(timer); try { w.terminate(); } catch (_e2) {} finish(); }
  })));
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
 * @param {number} [opts.closeTimeoutMs]    pool shutdown 超时（默认 5000）
 * @returns {Promise<{ insertedRows:number, totalChunks:number, workerCount:number }>}
 *
 * 失败语义（plan-b 全有或全无）：任一 worker chunk 失败 / crash → reject（已 ATTACH 部分不汇总）；
 *   temp db 文件无论成败都在 finally 清理。调用方负责事务/重跑保护（本模块不写 run 表）。
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
    onProgress = null,
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
  let workers = [];

  try {
    // ── 启动 effectiveWorkerCount 个 worker（并发 init）──
    workers = await Promise.all(
      Array.from({ length: effectiveWorkerCount }, () => startWorker(dbPath, selectSql, partColumns, initTimeoutMs))
    );
    // 持久 exit 标记 —— crash 路径下 closePool 据此跳过已死 worker（不空等 'exit' 事件到 timeout）
    for (const w of workers) {
      w.__exited = false;
      w.once('exit', () => { w.__exited = true; });
    }

    // ── reader 阶段：worker 池领 chunk 写各自 temp db（round-robin 队列）──
    //   chunk 派发顺序无所谓（汇总按 chunkIndex 升序）；每 worker 同时只跑 1 个 chunk。
    let nextIdx = 0;
    let completedChunks = 0;
    // 任一 chunk 失败/crash 即置 aborted —— 存活 worker loop 领新 chunk 前自停，
    //   防 crash 后存活 worker 继续写新 temp 文件、与 finally 的 cleanup 竞争造成 temp 泄漏。
    let aborted = false;
    let firstError = null;

    // 把一个 chunk 任务包成 Promise；同时挂 worker 级 error/exit 监听 → crash 时 reject 本 chunk
    function dispatchChunkToWorker(worker, chunkSpec) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const jobId = `c-${chunkSpec.chunkIndex}`;
        const tempDbPath = path.join(tempDir, `part-${chunkSpec.chunkIndex}.sqlite`);
        const cleanup = () => {
          worker.off('message', onMsg);
          worker.off('error', onErr);
          worker.off('exit', onExit);
        };
        const onMsg = (msg) => {
          if (!msg || msg.jobId !== jobId) return;
          if (msg.type === 'temp-done') {
            if (settled) return;
            settled = true; cleanup();
            tempPaths[chunkSpec.chunkIndex] = msg.tempDbPath;
            resolve(msg);
          } else if (msg.type === 'error') {
            if (settled) return;
            settled = true; cleanup();
            // worker 即使 chunk 出错也已 / 可能已建 temp 文件 — 记下路径供 finally 清理
            tempPaths[chunkSpec.chunkIndex] = tempDbPath;
            reject(deserializeFromMessage(msg.error));
          }
        };
        const onErr = (err) => {
          if (settled) return;
          settled = true; cleanup();
          tempPaths[chunkSpec.chunkIndex] = tempDbPath;
          reject(new Error(`multiworker chunk=${chunkSpec.chunkIndex} worker error 事件：${err && err.message ? err.message : String(err)}`));
        };
        const onExit = (code) => {
          if (settled) return;
          if (code === 0) return; // 正常 close 不该在跑 chunk 时发生；忽略由其他路径处理
          settled = true; cleanup();
          tempPaths[chunkSpec.chunkIndex] = tempDbPath;
          const e = new Error(`multiworker chunk=${chunkSpec.chunkIndex} worker 异常 exit（code=${code}）`);
          e.workerFailureSource = 'exit';
          reject(e);
        };
        worker.on('message', onMsg);
        worker.once('error', onErr);
        worker.once('exit', onExit);
        worker.postMessage({
          type: 'select-chunk-to-temp',
          jobId,
          chunkIndex: chunkSpec.chunkIndex,
          bindParams: chunkSpec.bindParams,
          tempDbPath,
        });
      });
    }

    async function workerLoop(worker) {
      while (true) {
        if (aborted) break; // 已有 chunk 失败 → 停止领新 chunk（不再写新 temp）
        const i = nextIdx++;
        if (i >= totalChunks) break;
        const chunkSpec = chunks[i];
        let res;
        try {
          res = await dispatchChunkToWorker(worker, chunkSpec);
        } catch (err) {
          // 记下首个错误 + 置 aborted；不在 loop 内 throw（用 allSettled 等所有 loop 收尾后统一 reject，
          //   保证 finally cleanup 时没有 loop 还在写 temp 文件）
          if (!aborted) { aborted = true; firstError = err; }
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

    // 等所有 loop 收尾（allSettled — 不会因首个失败而提前继续主流程）；任一失败则统一 reject（plan-b 全有或全无）
    await Promise.all(workers.map((w) => workerLoop(w)));
    if (aborted) {
      throw firstError || new Error('multiworker reader 阶段失败（未知原因）');
    }

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
    try { await closePool(workers, closeTimeoutMs); } catch (_e) { /* swallow */ }
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
    closePool,
    cleanupTempFiles,
    startWorker,
    PART_TABLE,
  },
  __test_only_set_worker_script__,
};
