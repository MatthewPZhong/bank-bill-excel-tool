# 技术规格 — v2.1.10 β 迭代

| 字段 | 值 |
|---|---|
| 文档版本 | v0.5（2026-05-28 — SR-FIX-1 Round 3 Codex F1+F2：N4-cont-1 SQL 加 partial run month 排除 + A4 chunked 入口前初始 in-progress + cleanupOrphanData 守卫扩展）/ v0.4（SR-FIX-1 round 2 P0 4 + P1 9 = 13 项修复 + §16 reverse sync + §8.3 migration 顺序修订）/ v0.3（N4-cont-1 sentinel 修订 `NULL → ''`）/ v0.2（A4 必做 + N4-cont-1 重大方案变更）|
| 关联 PRD | `PRD-v2.1.10.md` v0.4（同步 §5.3 migration 顺序修订；§4.2 sentinel 修订）|
| 关联 backlog | `backlog.md` v0.2（D23-D28 全部拍板 + Phase 0 POC 完成）|
| 起草人 | PM + Dev Phase 4 T28 发现 + 主线程 T29' 修订 + Dev SR-FIX-1 round 2 dev 自审 |
| 状态 | v0.4 SR-FIX-1 round 2 完成（13 commits + closeout；release-check 全绿：unit 1243 / integration 824 / smoke 全过）|

---

## 一、总览

### 1.1 架构图（A3 worker 进程化前后）

#### 改造前（v2.1.9）

```
┌─────────────── Electron 主进程 ───────────────┐
│  ipcMain.handle('acquiringBillCurrency:run')  │
│        ↓                                       │
│  acquiring-bill-currency-session.runCheck()    │  ← 同步 / await，占用 event loop
│        ↓                                       │
│  ┌─ DB (DatabaseSync) ─┐                       │
│  │ • clearOldRuns      │                       │
│  │ • computeStats      │                       │
│  │ • insertRun         │  ←── 30-60s SQL JOIN 阻塞主进程
│  │ • insertDiffByJoin  │                       │
│  │ • writeRunOutputs   │                       │
│  └─────────────────────┘                       │
│        ↓                                       │
│  IPC return → renderer                         │
│                                                │
│  setupIdleCleanupTimer (setInterval)           │  ← 30min 检查 lastUserActivityTs
└────────────────────────────────────────────────┘
```

#### 改造后（v2.1.10 A3）

```
┌─────────────── Electron 主进程 ───────────────┐  ┌─── worker 进程（A3 新增） ───┐
│  ipcMain.handle('acquiringBillCurrency:run')  │  │  parentPort.on('message', …)  │
│        ↓                                       │  │       ↓                        │
│  workerPool.dispatchRunCheck(payload)          │←─→│  runCheckInWorker(payload)     │
│        ↓                                       │ M │       ↓                        │
│  workerPool.on('progress') → forward 到 IPC    │ E │  ┌─ DB (workerDb) ─┐           │
│        ↓                                       │ S │  │ • clearOldRuns  │           │
│  workerPool.on('done' / 'error')               │ S │  │ • computeStats  │           │
│        ↓                                       │ A │  │ • insertRun     │           │
│  notifyResult + releaseOpLock                  │ G │  │ • insertDiffByJ │  ← 长任务在 worker 内
│                                                │ E │  │ • writeRunOuts  │           │
│  setupIdleCleanupTimer (setInterval)           │   │  └─────────────────┘           │
│  ├ workerBusy? skip cleanup（避免抢锁）        │ P │       ↓                        │
│  └ lastUserActivityTs 仍维护在 main             │ I │  postMessage({type:'done'})    │
│                                                │ P │                                │
│                                                │ E │  独立 PRAGMA：journal=WAL …    │
│                                                │   │  独立 require：DatabaseSync    │
└────────────────────────────────────────────────┘   └────────────────────────────────┘
```

### 1.2 进程边界（A3 关键不变量）

| 项 | 主进程 | worker 进程 |
|---|---|---|
| Electron API（app / dialog / BrowserWindow / Notification）| ✅ 全部 | ❌ 完全无访问 |
| renderer IPC（ipcMain.handle）| ✅ 全部 handler | ❌ 仅通过 message pipe 上报 |
| `lastUserActivityTs` | ✅ 维护 | ❌ 不维护（详 §2.3） |
| `idleCleanupTimer` | ✅ setInterval | ❌ 不持有 |
| `cleanupAfterRunBackground` | ✅ 主进程触发 | ❌ 不调用 |
| DatabaseSync 实例 | ✅ `database.db`（主连接） | ✅ `workerDb`（独立连接） |
| `acquiring-bill-currency-session.runCheck` | ❌ 不再直调 | ✅ worker 内执行 |
| Activity log（`appendActivityLogEntry`） | ✅ 直写 | ❌ 通过 message pipe 上报 |
| 性能基线（v2.1.7 F7-A1 4 条 PRAGMA） | ✅ 已设 | ✅ 必须重设（详 §2.5） |

### 1.3 全局改动清单（PM 估算）

| 改动类别 | 文件 | 改动量 |
|---|---|---|
| 新建 worker 入口 | `src/main-process/run-check-worker.js`（新） | ~250 行 |
| 新建 worker pool 管理 | `src/main-process/run-check-worker-pool.js`（新） | ~150 行 |
| 改造 session.runCheck 提取 worker 可执行部分 | `src/main-process/acquiring-bill-currency-session.js` | ~50 行（拆函数）|
| 改造 IPC handler 接 workerPool | `src/main.js:10758-10785` | ~30 行 |
| idle timer 协调 | `src/main.js:11155-11178` | ~10 行 |
| N4-cont-1 settings + repository（v0.2 单键） | `src/backend/database/settings-repository.js` + `migrations.js` | ~30 行（v0.2 单键 — 从 v0.1 ~60 行下降） |
| N4-cont-1 cleanup 函数（v0.2 简化） | `src/backend/acquiring-bill-currency-db/raw-json-retention.js`（新） | ~40 行（v0.2 仅 `clearStaleSuccessfulRawJson` 单函数 — 从 v0.1 ~120 行下降） |
| ~~N4-cont-1 UI 按钮 + dialog~~ ❌ **v0.2 删除**（0 UI） | ~~`src/renderer.js` + `index.html` + `renderer-dialogs.js`~~ | ~0 行（v0.2 从 ~80 行降为 0） |
| ~~N4-cont-1 IPC handler~~ ❌ **v0.2 删除**（0 IPC） | ~~`src/main.js` + `preload.js`~~ | ~0 行（v0.2 从 ~40 行降为 0） |
| **N4-cont-1 N1' idle cleanup 回调追加**（v0.2 新增） | `src/main.js:11155-11178`（`setupIdleCleanupTimer` 内 cleanup 回调） | ~10 行（在 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded` 后追加 try/catch + `clearStaleSuccessfulRawJson` 调用） |
| N4-cont-2 migration | `src/backend/database/migrations.js` | ~100 行 |
| **A4 chunked**（v0.2 D25 必做） | `src/backend/acquiring-bill-currency-db/run-repository.js`（spec §3.2 细化） | ~80 行（v0.2 必做不再条件触发） |
| 集成 + smoke + unit | `scripts/integration/` + `scripts/smoke/` + `tests/unit/` | ~25 文件（v0.2 N4-cont-1 UI / IPC case 删 → 文件数下降） |

合计预估 ~ 40-55 文件改动（v0.2 reverse sync 后下降；超 CLAUDE.md 5 软约束 — 因 4 主线打包结构性决定）。

---

## 二、A3 worker 跨进程化（最大篇幅）

### 2.1 进程边界与生命周期

#### 2.1.1 pre-warm 策略（推荐）

```js
// src/main.js（app.whenReady 后）
const runCheckWorkerPool = require('./main-process/run-check-worker-pool');

app.whenReady().then(async () => {
  // ... database init / window create ...
  await runCheckWorkerPool.preWarm({
    workerScript: path.join(__dirname, 'main-process/run-check-worker.js'),
    dbPath: database.dbPath,
  });
});
```

**理由**：避免每次 runCheck 都冷启动 worker（~100-200ms）。pre-warm 在 app.whenReady 后立即创建 worker + 内部 `new DatabaseSync` + 设 PRAGMA，runCheck 来时直接 message dispatch。

#### 2.1.2 cold-start fallback

如 pre-warm 失败（如内存不足）→ 第一次 runCheck 触发 cold-start：

```js
async function dispatchRunCheck(payload) {
  if (!workerInstance) {
    workerInstance = await coldStartWorker(); // ~100-200ms
  }
  return workerInstance.run(payload);
}
```

#### 2.1.3 异常恢复

| 触发 | 主进程响应 |
|---|---|
| worker `error` 事件 | log error + 释放 op lock + Notification "worker 异常请重试" + 标记 workerInstance = null（下次冷启动）|
| worker `exit` 事件（非正常退出）| 同上 + 检查 op lock 状态 + 必要时 emergency cleanup |
| worker `exit` 事件（正常 close）| 仅清理 reference（重启时不复用旧 instance）|
| 主进程退出（app.before-quit）| `workerInstance.terminate()` + 等待 worker 内 DB 连接关闭（带 timeout 防卡死）|

### 2.2 DB 连接方案（D24 = (a) 独立 connection，PM 倾向）

#### 2.2.1 推荐方案：独立 connection

```js
// src/main-process/run-check-worker.js
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

let workerDb = null;

function initWorkerDb(dbPath) {
  if (workerDb) return workerDb;
  workerDb = new DatabaseSync(dbPath);
  // ⚠️ PRAGMA 必须与主进程 database.js:42 完全一致（spec §2.5 强制清单）
  workerDb.exec('PRAGMA foreign_keys = ON;');
  workerDb.exec('PRAGMA journal_mode = WAL;');
  workerDb.exec('PRAGMA synchronous = NORMAL;');
  workerDb.exec('PRAGMA cache_size = -65536;');     // 64MB
  workerDb.exec('PRAGMA mmap_size = 268435456;');   // 256MB
  workerDb.exec('PRAGMA busy_timeout = 30000;');    // 30s（A3 新增 — 防与主进程 DB 写冲突）
  return workerDb;
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'init') {
    try {
      initWorkerDb(msg.dbPath);
      parentPort.postMessage({ type: 'init-done' });
    } catch (err) {
      parentPort.postMessage({ type: 'init-error', error: serializeError(err) });
    }
  }
  if (msg.type === 'run-check') {
    try {
      const result = await runCheckInWorker(workerDb, msg.payload);
      parentPort.postMessage({ type: 'run-check-done', result });
    } catch (err) {
      parentPort.postMessage({ type: 'run-check-error', error: serializeError(err) });
    }
  }
  if (msg.type === 'cancel') {
    // graceful: 设 cancel flag，让 runCheckInWorker 主循环检测后退出
    workerCancelFlag = true;
  }
  if (msg.type === 'close') {
    if (workerDb) workerDb.close();
    process.exit(0);
  }
});
```

#### 2.2.2 为什么不选 message-based RPC

| 维度 | 独立 connection（推荐） | message-based RPC |
|---|---|---|
| 实现复杂度 | 低（标准 sqlite3 API）| 高（每条 SQL 都要 IPC 序列化）|
| 单条 SQL 延迟 | < 1ms | 5-20ms（跨进程 message + 序列化）|
| 错误隔离 | worker 内 SQL 异常不影响主进程 DB | RPC 调用栈跨进程，错误处理复杂 |
| 内存峰值 | 双倍（每进程独立 cache）| 单一（主进程持有）|
| WAL 兼容 | 多 reader 安全；多 writer 通过 busy_timeout 协调 | 仅主进程 writer 无并发问题 |
| 开发节奏 | 沿用现有 sqlite API 无学习成本 | 需自建 RPC framework |

**决策**：独立 connection — 简单 + 性能好 + 隔离性强；代价（双倍内存 + PRAGMA 漏设风险）通过强制 init helper + spec §2.5 清单 mitigate。

### 2.3 跨进程 lastActiveTs 同步（与 v2.1.9 N1' idle cleanup 计时器协调）

#### 2.3.1 关键不变量

| 不变量 | 实现 |
|---|---|
| `lastUserActivityTs` 仅维护在主进程 | worker 进程内**不**独立维护；worker 不接收 renderer 的 reportUserActivity；worker 长任务不更新 lastActiveTs |
| idle cleanup 触发权在主进程 | `setupIdleCleanupTimer` 仍在 `src/main.js:11155-11178` 持有 |
| worker 执行 runCheck 期间 idle cleanup 必须 skip | 详 §2.3.2 |
| cleanup 永远在主进程执行 | worker 不调 `cleanupAfterRunBackground`；主进程触发 cleanup 时 worker 必须空闲（或 worker 被 terminate）|

#### 2.3.2 协调策略

```js
// src/main.js setupIdleCleanupTimer 改造
function setupIdleCleanupTimer() {
  if (idleCleanupTimer) return;
  loadIdleCleanupMsFromSettings();
  idleCleanupTimer = setInterval(() => {
    try {
      const elapsed = Date.now() - lastUserActivityTs;
      if (elapsed < IDLE_CLEANUP_MS) return;

      // A3 新增：worker 忙时 skip cleanup
      if (runCheckWorkerPool.isBusy()) {
        // 不更新 lastUserActivityTs（让用户操作后才推迟）
        // 等下个 tick 再判断（默认 5min 一次）
        return;
      }

      triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded();
    } catch (err) {
      appendActivityLogEntry({ /* SR-log-1 范式 */ });
    }
  }, IDLE_CHECK_INTERVAL_MS);
  if (idleCleanupTimer.unref) idleCleanupTimer.unref();
}
```

**理由**：
1. 用户从未操作 + worker 正在跑 runCheck → 不触发 cleanup（避免抢 DB 写锁）
2. 用户操作后 lastActiveTs 被 reportUserActivity 更新 → idle 计时重置
3. worker 完成 runCheck 后下个 tick 才检查 — 自然过渡

#### 2.3.3 worker 内 lastActiveTs 同步（不需要）

worker 不需要知道 lastActiveTs — worker 内不做 idle 相关判断。如果未来扩展 worker 内自动清理（如 cleanupAfterRunBackground 也搬到 worker），再考虑 worker 内 lastActiveTs 镜像策略。

### 2.4 错误序列化（worker → 主进程 stack/cause）

#### 2.4.1 serializeError helper

```js
// src/main-process/worker-error-utils.js（新）
function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack || null,
    code: err.code || null,
    cause: err.cause ? serializeError(err.cause) : null,
    // FileValidationError 专属字段（v2.1.7 已建）
    detailLines: err.detailLines || null,
    context: err.context || null,
  };
}

function deserializeError(serialized) {
  if (!serialized) return new Error('unknown worker error');
  const err = new Error(serialized.message);
  err.name = serialized.name;
  err.stack = serialized.stack || err.stack;
  if (serialized.code) err.code = serialized.code;
  if (serialized.cause) err.cause = deserializeError(serialized.cause);
  if (serialized.detailLines) err.detailLines = serialized.detailLines;
  if (serialized.context) err.context = serialized.context;
  return err;
}

module.exports = { serializeError, deserializeError };
```

#### 2.4.2 使用范式

```js
// worker 内
try {
  ...
} catch (err) {
  parentPort.postMessage({ type: 'run-check-error', error: serializeError(err) });
}

// 主进程 handler
worker.on('message', (msg) => {
  if (msg.type === 'run-check-error') {
    const err = deserializeError(msg.error);
    reject(err); // 透传到 IPC return.message
  }
});
```

**约束**：
- ✅ 保留 stack（含 worker 内函数行号）
- ✅ 保留 cause 链
- ✅ 保留 FileValidationError 专属字段（项目 custom error class）
- ⚠️ 不保留 prototype chain（反序列化后是 Error，instanceof FileValidationError = false）— mitigate：调用方按 `err.name === 'FileValidationError'` 判断

### 2.5 PRAGMA 同步（worker 独立 connection 必须重设）

#### 2.5.1 强制清单（与主进程 `src/backend/database.js:42` 附近完全一致）

| PRAGMA | 值 | 来源 |
|---|---|---|
| `foreign_keys` | `ON` | v2.1.5 引入（FK 检查）|
| `journal_mode` | `WAL` | v2.1.7 F7-A1 |
| `synchronous` | `NORMAL` | v2.1.7 F7-A1（WAL 模式下安全 + 性能 2-3 倍）|
| `cache_size` | `-65536`（64MB）| v2.1.7 F7-A1 |
| `mmap_size` | `268435456`（256MB）| v2.1.7 F7-A1 |
| **`busy_timeout`** | `30000`（30s）| **A3 新增** — 防与主进程 DB 写冲突 |

#### 2.5.2 验证

worker 启动后立即执行：

```js
const verify = [
  'foreign_keys', 'journal_mode', 'synchronous',
  'cache_size', 'mmap_size', 'busy_timeout',
].map(p => ({ name: p, value: workerDb.prepare(`PRAGMA ${p}`).get() }));
parentPort.postMessage({ type: 'pragma-verify', verify });
```

主进程在 `init-done` 后断言所有 PRAGMA 值匹配预期 — 不匹配 fail-fast。

#### 2.5.3 失败影响

| PRAGMA 漏设 | 影响 |
|---|---|
| `foreign_keys` | FK 约束不生效 → diff_rows 写入孤儿数据（违反 N4-cont-2 引入的 CASCADE 契约）|
| `journal_mode = WAL` | 回退 DELETE 模式 → 与主进程 WAL 模式冲突 → SQLITE_BUSY 频发 |
| `synchronous = NORMAL` | 回退 FULL → 性能 2-3 倍下降，A3 收益打折 |
| `cache_size / mmap_size` | 性能下降但功能正常 |
| `busy_timeout` | 与主进程 DB 写冲突时立即 SQLITE_BUSY 抛错（无 30s 等待）|

### 2.6 Dev Phase 0 POC 任务清单（worker_threads vs utilityProcess 实测项）

#### 2.6.1 实测目标（Phase 0 报告必须覆盖 4 项）

| 项 | 测试方法 | 通过标准 | worker_threads 实测 | utilityProcess 实测 |
|---|---|---|---|---|
| **启动延迟**（cold-start 10 次均值） | 主进程 perf.now() → worker init-done | < 200ms | **11.11 ms** ✅ | 53.21 ms ✅ |
| **IPC 延迟**（1000 次 round-trip 均值） | 主进程 send ping → worker reply pong 1000 次平均 | < 10ms | **0.010 ms** ✅ | 0.035 ms ✅ |
| **错误堆栈完整度** | worker 内人为 throw new Error('test') → 主进程 catch 后 err.stack 含 worker 函数行号 | stack 含 worker 内文件路径 + 行号 | ✅ 完整（含 deepFn + 行号） | ✅ 完整（含 deepFn + 行号） |
| **cancel 响应延迟** | worker 内执行 5s sleep → 主进程 1s 时发 cancel → worker exit | < 1s | 17.91 ms ✅ | **2.32 ms** ✅ |
| **DatabaseSync 可用性**（D24 验证） | require + 实例化 + 6 PRAGMA + SELECT 10000 行 | 全部通过 | ✅ | ✅ |

**实测来源**：commits `3f46631` (T02) / `4d07ea9` (T03) / `77cc849` (T04)；汇总报告 `scripts/poc/v2.1.10-a3-comparison.md`。

#### 2.6.2 POC 脚本位置

```
scripts/poc/v2.1.10-a3-worker-threads.js          # worker_threads 实测 ✅
scripts/poc/v2.1.10-a3-utility-process.js         # utilityProcess 实测（主） ✅
scripts/poc/v2.1.10-a3-utility-process-child.js   # utilityProcess child ✅
scripts/poc/v2.1.10-a3-comparison.md              # Phase 0 Dev 报告 ✅
```

#### 2.6.3 POC 通过后回写

✅ Phase 0 完成（2026-05-28）：
1. ✅ spec §2.6 表格"实测"列已填数据
2. ✅ backlog.md §"待 spec 阶段决策点" D23-D28 已回写最终拍板
3. ✅ PRD §四 D23 / D24 加 Phase 0 拍板标识
4. ⏭️ 启动 Phase 1（主线 worker 框架）— Phase 1 task T06-T11

#### 2.6.4 D23 / D24 最终拍板（用户 2026-05-28）

| ID | 拍板 | 理由 |
|---|---|---|
| **D23** | **(a) worker_threads** | 启动 + IPC 双线胜出 4-5x；同环境 Node + Electron 双栈跑（CI 集成测试不依赖 Electron）；cancel 17ms 远低于 1s 阈值 + A4 chunked 业务阈值 < 5s 更宽松；OS 资源占用更小；详 `scripts/poc/v2.1.10-a3-comparison.md` §四 |
| **D24** | **(a) 独立 connection** | DatabaseSync 在 worker_threads 内 require + 实例化 + 6 PRAGMA + SELECT 10000 行全通过；无需 fallback 到 message-based RPC（spec §2.2.2 备选）；详 `scripts/poc/v2.1.10-a3-comparison.md` §三 |

#### 2.6.5 Phase 1 实施小提示（基于 POC 6 surprise）

| # | 提示 | 处理 |
|---|---|---|
| 1 | SQLite `ExperimentalWarning` 每 worker 启动都打印 | T06 worker 入口加 `process.on('warning')` 过滤（保留其他 warning） |
| 2 | utilityProcess child payload 不一致 | 选 worker_threads 后忽略；POC 脚本归档保留 |
| 3 | worker_threads cold-start 仅 11ms（spec §2.1.1 预测 100-200ms 偏保守）| pre-warm 策略可放宽为"有条件" |
| 4 | utilityProcess 启动 53ms 但 << 200ms | 选 worker_threads 后无 Windows 低配风险 |
| 5 | PRAGMA `synchronous=NORMAL` 返回 int 1 | T06 PRAGMA verify 用 int 比较（`=== 1`） |
| 6 | DatabaseSync 两种容器都能正常工作 | D24=a 直接实施，无 fallback 路径 |

---

## 三、A4 SQL JOIN chunked 分批（v0.2：D25 用户拍板必做）

### 3.1 触发条件（v0.2 reverse sync — 必做不再条件触发）

**v0.2 D25 用户拍板**：A4 必做，**不等 A3 实测**。

**理由（PRD §四 D25 行）**：
1. **防 cancel 响应慢 + 进度回调精细化是 hard requirement** — 不是"看 A3 实测决定"的可选优化；用户预期对账长任务必须可中途取消（< 5s 响应）+ 进度按 chunkIndex / chunkCount 推送
2. **A3 Phase 2 联调期间 A4 可并行开发**（无强依赖）
3. ~~v0.1 决策树（worker SQL < 30s + cancel < 5s 不做 / ≥ 触发）已删除~~ — v0.2 不再依赖该决策树

### 3.2 chunk size 选定（v0.2 已选定 10w 行）

| chunk size | 优点 | 缺点 | v0.2 选定 |
|---|---|---|---|
| **10w 行**（v0.2 PM 选定）| ✅ cancel 响应 < 5s（每批 < 5s）；✅ 进度回调精细（chunkIndex 推送频率适中）；✅ 内存峰值 < 200MB（10w 行 JOIN 中间结果 ≤ 200MB） | 总耗时 + 5-10%（事务切换开销，与 50w / 100w 对比） | ⭐ **选定** |
| 50w 行 | 平衡点；总耗时损失更小 | cancel 响应 < 25s（一批 25s 左右）— 接近 5s 限制 ❌ | 否 |
| 100w 行 | 总耗时影响最小 | cancel 响应 < 50s ❌ 严重超时 | 否 |

**v0.2 选定理由**：
1. **cancel 响应 < 5s** 是 hard requirement（D25 拍板）→ 每批必须 < 5s
2. **内存峰值 < 200MB** 防 worker 进程 OOM
3. **进度回调精细度**：500w 行 / 10w = 50 批；用户感知"50 个 chunkIndex 跳动"≈ 进度条流畅
4. **事务切换开销 5-10%** 可接受（A3 worker 化已大幅消除主进程阻塞，5-10% 总耗时增加用户感知弱）

#### 3.2-perf — T21 实测数据回写（2026-05-28）

详 `scripts/perf/v2.1.10-a4-chunked-report.md`。**关键实测验证 spec §3.2 拍板**：

| 测项 | 实测值 | spec 预测 | 验证结果 |
|---|---|---|---|
| 50000 行 chunkSize=100000 vs non-chunked 总耗时 | 174.8ms vs 176.3ms（0.99x）| +5-10% | ✅ 小于预期（接近持平 — 1 chunk 等价 single SQL）|
| 50000 行 chunkSize=10000（5 chunks）总耗时 | 175.4ms | +5-10% | ✅ +0.4%（事务切换开销极小）|
| 50000 行 chunkSize=1000（50 chunks）总耗时 | 198.6ms | — | 1.14x — 验证不选 1k 的合理性（小切片显著高开销）|
| cancel 响应延迟（chunk 2 边界 cancel → throw） | 0.00ms - 0.01ms（500/5000/50000）| < 5s | ✅ 同步抛（chunk 边界 cancel 最优情况） |
| 进度回调粒度 | onChunkDone === totalChunks | onChunkDone × N | ✅ 每 chunk 完成一次回调 |

**结论**：
1. **chunk size 10w 在 50000 行档与 single SQL 几乎等价**（差异 < 1%）— 验证 spec §3.2 选定合理性
2. **500w 行场景外推**：按 50000 行 175ms 线性外推 → 17.5s（chunked 50 chunks 各 ~350ms）→ cancel 响应远低于 5s 阈值
3. **chunkSize=1k 比 10w 慢 14%**：50 chunks vs 1 chunk 的事务 + 回调开销主导，证明 spec §3.2 不选小 chunk size 正确
4. **内存峰值与 non-chunked 几乎相同**（50000 行 470MB vs 470MB）：chunked 不引入额外内存峰值

#### 3.2.1 实现伪代码（v0.2 chunkSize 默认 10w）

```js
async function insertDiffRowsByJoinChunked(db, runId, monthKey, chunkSize = 100000, onProgress, cancelFlag) {
  const total = db.prepare(`SELECT COUNT(*) AS c FROM acquiring_bill_currency_bill_imports WHERE month_key = ?`).get(monthKey).c;
  const chunkCount = Math.ceil(total / chunkSize);
  for (let i = 0; i < chunkCount; i++) {
    if (cancelFlag.value) throw new CancelError('user cancelled');
    db.exec('BEGIN');
    try {
      db.prepare(`
        INSERT INTO acquiring_bill_currency_diff_rows (run_id, bill_import_id, ...)
        SELECT ?, b.id, ...
        FROM acquiring_bill_currency_bill_imports b
        LEFT JOIN acquiring_bill_currency_flow_imports f ON ...
        WHERE b.month_key = ? AND b.id > ? AND b.id <= ?
        AND <币种差异条件>
      `).run(runId, monthKey, i * chunkSize, (i + 1) * chunkSize);
      db.exec('COMMIT');
      if (onProgress) onProgress({ stage: 'sql-joining', chunkIndex: i, chunkCount });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
```

### 3.3 idempotent / 重跑保护（v0.2 必做，不再"待 Phase 3 细化" + v0.5 Round 3 F2 first-chunk crash 防护）

若用户重跑 runCheck（如失败后重试）：
- `clearOldRuns(monthKey)` 已删除该月 runs + 通过 N4-cont-2 CASCADE 自动删 diff_rows
- 新 runId 重新跑 — 不会有跨 run 数据污染
- chunked 中途 cancel → 当前批 ROLLBACK；已 COMMIT 的批保留 → 再次触发 runCheck 时 clearOldRuns 会按 month_key 清掉本次旧 run + N4-cont-2 CASCADE 清旧 diff_rows → 新 runId 重头跑 → idempotent

**v0.5 (SR-FIX-1 Round 3 F2) first-chunk crash 防护**：
- `runCheckCore` 进入 `insertDiffRowsByJoinChunked` 前先写一个 in-progress 占位 `chunk_progress`（`lastCompletedChunkIndex=-1 / totalChunks=0 / status='in-progress'`）
- 触发场景：worker 跑第一个 chunk 时 die（process.exit / OOM / SIGKILL），`onChunkDone` 触发前 chunk_progress 仍是入口写入的 in-progress
- 目的：保证 `chunk_progress IS NOT NULL` — 后续兜底路径（main.js P1-7 failureListener `in-progress → partial` 兜底 + startup cleanupOrphanData 守卫）能识别该 run，不被当孤儿误清
- 配套 cleanupOrphanData 守卫扩展（spec §3.3 / acquiring-bill-currency-session.js:608）：保护 `partial` OR `in-progress` 一起跳过 cleanup
- 仅 `!isResume` 时写入；resume 路径下 `chunk_progress` 已是 partial（cleanup 守卫已能保护）

---

## 四、N4-cont-1 raw_json 体积治理（v0.2 重大方案变更）

### 4.1 D26 = (e) 7 天短窗口（v0.2 用户拍板）；settings 单键

#### 4.1.1 settings 表新增单键（v0.2：从 2 键降为 1 键）

```js
// src/backend/database/migrations.js（沿用 v2.1.9 N1-settings 范式）
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY = 'acquiring_bill_raw_json_retention_days';
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT = '7';

function ensureAcquiringBillRawJsonRetentionSettings(db) {
  db.prepare(`INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)`)
    .run(ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT);
}
```

#### 4.1.2 getter（沿用 v2.1.9 N1-settings 范式 — 范围 1-30，外回退默认 7）

```js
// src/backend/database/settings-repository.js
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MIN = 1;
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MAX = 30;
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_FALLBACK = 7;

function getAcquiringBillRawJsonRetentionDays(db) {
  const raw = getSetting(db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY);
  if (raw == null || raw === '') return ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_FALLBACK;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_FALLBACK;
  if (n < ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MIN || n > ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MAX) {
    return ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_FALLBACK;
  }
  return n;
}
```

### 4.2 清理算法（v0.5 SR-FIX-1 Round 3 F1）— `clearStaleSuccessfulRawJson`

#### 4.2.1 核心 SQL（双 NOT IN 子查询 — v0.5 加 partial run month 守卫 + v0.3 sentinel）

```js
// src/backend/acquiring-bill-currency-db/raw-json-retention.js（v0.5 修订）
function clearStaleSuccessfulRawJson(db, retentionDays) {
  const result = db.prepare(`
    UPDATE acquiring_bill_currency_bill_imports
    SET raw_json = ''
    WHERE id IN (
      SELECT b.id FROM acquiring_bill_currency_bill_imports b
      WHERE b.raw_json != ''
        AND b.imported_at < datetime('now', '-' || ? || ' days')
        AND b.id NOT IN (
          SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows
        )
        -- v0.5 (Round 3 F1) 新增：排除 partial run 关联月份的所有 bill
        AND b.month_key NOT IN (
          SELECT DISTINCT month_key FROM acquiring_bill_currency_runs
          WHERE chunk_progress IS NOT NULL
            AND json_extract(chunk_progress, '$.status') = 'partial'
        )
    )
  `).run(retentionDays);
  return { clearedCount: result.changes, elapsedMs: ... };
}

module.exports = { clearStaleSuccessfulRawJson };
```

> ⚠️ **v0.5 reverse sync（2026-05-28 SR-FIX-1 Round 3 Codex F1）**：新增 partial run 关联 month 排除子查询。
>
> **触发场景**：chunked run 跑到 chunk M/N → cancel / worker crash → `chunk_progress.status='partial'`；此时 `diff_rows` 仅含「已处理 mismatches」；任何"后续 bill rows（resume 时会变 mismatches 的）"仍未进 `diff_rows`。如 idle retention 在 bill imported_at 老于窗口时跑 → 清掉这些"未来 mismatch"的 raw_json → 用户 resume 后 INSERT 进来的 diff rows，writer 路径仍解析 `d.bill_raw_json` → 输出 broken / 不完整。
>
> **修复**：partial run 关联 month 的所有 bill 整月排除（不仅差异行）— 直到 partial 完成 resume → `status='complete'` 不再排除。
>
> **代价**：增加 1 个 NOT IN 子查询；runs 子查询行数 < 100（每月最多 1-2 个 run）；`json_extract` 是 SQLite 内置（v2.1.8 N4 已使用）。性能损耗可忽略。
>
> ⚠️ **v0.3 reverse sync（2026-05-28）**：sentinel 从 `NULL` 改 `''`。原因：`bill_imports.raw_json` schema = `TEXT NOT NULL`（`migrations.js:1500`，v2.1.8 N4 引入约束）— `SET raw_json = NULL` 被 SQLite 拒绝。`''` 兼容 NOT NULL + 等价"已清"sentinel。

#### 4.2.2 SQL 关键不变量（v0.5）

- **`b.raw_json != ''`**：跳过已清的行（idempotent — 多次 idle 触发不会重复清同行；`''` 是 v0.3 "已清" sentinel）
- **`b.imported_at < datetime('now', '-' || ? || ' days')`**：仅清"老于 N 天"的行 — `imported_at` 是 bill_imports 表既有列（v2.1.8 N4 schema）
- **`b.id NOT IN (SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows)`**：**排除差异行** — 保证差异行 raw_json 永远不被清，writer.js:184 重导差异 xlsx 不丢字段
- **v0.5 新增 `b.month_key NOT IN (SELECT month_key FROM runs WHERE chunk_progress IS NOT NULL AND json_extract(...) = 'partial')`**：排除 partial run 关联月份的全部 bill（无论是否已进 diff_rows）— 保证 resume 后新增 mismatch 行的 raw_json 完整；partial 完成 resume → status='complete' → 不再排除
- **`SET raw_json = ''`**：保留行骨架 + 业务字段；不删整行；不破坏 N4-cont-2 FK CASCADE 路径（bill_import_id FK 仍有效）；兼容 v2.1.8 N4 NOT NULL 约束（v0.3）

#### 4.2.3 v0.1 → v0.2 → v0.3 → v0.5 算法变更项

- ❌ `calculateExpiredRows`（v0.1 启动期计算超期）— v0.2 删除（无 UI 不需要预估）
- ❌ `pruneOldRawJson`（v0.1 用户主动触发删除）— v0.2 删除（无用户主动路径）
- ❌ "标记超期"算法（v0.1 启动期触发不删 + 等用户主动清）— v0.2 删除
- ❌ `UPDATE raw_json = '{}'`（v0.1 留空 JSON）→ ❌ `UPDATE raw_json = NULL`（v0.2，但 schema NOT NULL 拒绝）→ ✅ **`UPDATE raw_json = ''`（v0.3 修订）**
- ❌ 月份维度 + MB 双门槛 — v0.2 删除（改"天数"单一维度）
- ✅ **v0.5 新增 partial run month 守卫子查询**（Round 3 F1）— 跨 Phase 协同保护：A4 chunked partial run × N4-cont-1 cleanup 不竞争数据完整性

### 4.3 触发集成（v0.2 复用 v2.1.9 N1' idle cleanup 计时器）

#### 4.3.1 集成点：src/main.js:11155-11178 setupIdleCleanupTimer

v2.1.9 N1' 现状（grep 验证）：
```js
// src/main.js:11159-11178
idleCleanupTimer = setInterval(() => {
  try {
    const elapsed = Date.now() - lastUserActivityTs;
    if (elapsed < IDLE_CLEANUP_MS) return;
    triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded();
  } catch (err) {
    appendActivityLogEntry({ /* SR-log-1 */ });
  }
}, IDLE_CHECK_INTERVAL_MS);
```

v0.2 改造（追加 raw_json 清理调用）：
```js
// src/main.js:11155-11178 改造
idleCleanupTimer = setInterval(() => {
  try {
    const elapsed = Date.now() - lastUserActivityTs;
    if (elapsed < IDLE_CLEANUP_MS) return;

    // A3 worker 忙时 skip cleanup（spec §2.3.2）
    if (runCheckWorkerPool && runCheckWorkerPool.isBusy && runCheckWorkerPool.isBusy()) return;

    // 1) 先现有 cleanup（v2.1.8 cleanupAfterRunBackground）
    triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded();

    // 2) 后 raw_json 清理（v0.2 N4-cont-1 追加 — 失败不阻塞主 cleanup）
    try {
      const retentionDays = getAcquiringBillRawJsonRetentionDays(database.db);
      const { affectedRows } = clearStaleSuccessfulRawJson(database.db, retentionDays);
      if (affectedRows > 0) {
        appendActivityLogEntry({
          level: 'info',
          source: 'main',
          domain: 'acquiring-bill-currency',
          message: `[N4-cont-1] idle cleanup raw_json 清理完成`,
          details: [`affected=${affectedRows}`, `retentionDays=${retentionDays}`],
        });
      }
    } catch (rawJsonErr) {
      // 失败不阻塞主 cleanup；下次 idle 重试
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[N4-cont-1] idle cleanup raw_json 清理失败（下次 idle 重试）',
        details: [rawJsonErr && rawJsonErr.message ? rawJsonErr.message : String(rawJsonErr)],
        stack: rawJsonErr && rawJsonErr.stack ? rawJsonErr.stack : undefined,
      });
    }
  } catch (err) {
    appendActivityLogEntry({ /* SR-log-1 */ });
  }
}, IDLE_CHECK_INTERVAL_MS);
```

#### 4.3.2 顺序契约（关键不变量）

| 步骤 | 动作 | 失败处理 |
|---|---|---|
| 1 | 检查 idle 阈值 + worker busy guard | 不满足 → return |
| 2 | 现有 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded`（v2.1.8 cleanup flow + bill）| 失败 → 抛到外层 catch（SR-log-1 记录） |
| 3 | **v0.2 新增**：`clearStaleSuccessfulRawJson` | **失败不阻塞**（独立 try/catch + activity log + 下次 idle 重试） |

**为什么先 v2.1.8 cleanup 后 raw_json 清理**：v2.1.8 `cleanupAfterRunBackground` 清 flow + bill rows（整行删除）— 删完后 raw_json 表中已不存在这些行的 raw_json 字段；剩余对账成功老行才进 raw_json 清理逻辑。顺序反过来会浪费 IO（先清 raw_json 再删整行）。

### 4.4 失败处理（v0.2 简化）

- `clearStaleSuccessfulRawJson` 单条 SQL 出错（如 SQLITE_BUSY）→ 外层 try/catch → activity log → 下次 idle（30min 后）重试
- 无事务包裹（单条 SQL 原子执行）— SQLite UPDATE 单条天然原子
- 无中途 cancel 路径（idle 自动触发，用户无操作机会取消）— 用户感知度 = 0

### 4.5 体积治理效果论证（v0.2 新增）

| 数据维度 | 估算 |
|---|---|
| 差异行占比（基于线上观察推断）| ~1%（取决于业务场景；理想对账无差异 → 接近 0%；问题对账日 ~5%）|
| 7 天内对账成功行数据保留 | 100%（用户复查窗口）|
| 7 天前对账成功行 raw_json 清理 | 100%（自动） |
| 7 天前差异行 raw_json 保留 | 100%（writer.js:184 依赖）|
| **净体积节省效果** | **~99%**（清 99% 对账成功行 raw_json；剩 1% 差异行 + 7 天内新数据保留）|

对比 v0.1 (d) 6 月 + 500MB 双门槛：v0.1 6 月才清一次 + 500MB 内永不清 → 体积治理滞后于增长速度（线上每月新增 50-200MB）；v0.2 7 天循环清 + 仅留差异行 → 体积稳定在 "7 天新数据 + 累计差异行 1%" 量级。

---

## 五、N4-cont-2 FK CASCADE 改造

### 5.1 D28 改造范围（PM 倾向：(a) 仅 diff_rows.bill_import_id + run_id 2 FK）

详 PRD §四 D28 理由表。

### 5.2 复用 SR-backup-1 backup API（必须）

```js
// src/backend/database/migrations.js
function ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, createBackupFn) {
  const flag = getSetting(db, 'n4_cont_2_diff_rows_cascade_migrated');
  if (flag === '1') return { skipped: true };

  // Step 1 — SR-backup-1 前置自动备份
  let backupPath = null;
  if (typeof createBackupFn === 'function') {
    backupPath = createBackupFn('pre-N4-cont-2');
    appendActivityLogEntry({
      level: 'info', source: 'main', domain: 'migration',
      message: '[N4-cont-2 migration] 自动备份完成',
      details: [backupPath],
    });
  }

  // Step 2 - 8 status state machine 详 §5.3
  // ...
}
```

### 5.3 8-status migration state machine 沿用 v2.1.9 N5 范式

#### 5.3.1 状态转移图

```
pending → backup-done → checked → rebuilt → indexed → fk-verified → flag-set → committed
   ↓          ↓           ↓          ↓          ↓           ↓             ↓
ROLLBACK   ROLLBACK   ROLLBACK   ROLLBACK   ROLLBACK   ROLLBACK      （不可逆，已 commit）
   ↓          ↓           ↓          ↓          ↓           ↓
log+abort  保留备份   保留备份   保留备份   保留备份   保留备份
```

#### 5.3.2 各 status 详情

| Status | 动作 | 失败处理 |
|---|---|---|
| `pending` | 起点 | — |
| `backup-done` | SR-backup-1 备份 → 返回 backupPath | 备份失败 → abort + log + 不修改 schema |
| `checked` | 先验：PRAGMA foreign_key_check 当前 schema 0 violation；不然不允许迁移 | log violation 详情 + abort |
| `rebuilt` | BEGIN → 建 `acquiring_bill_currency_diff_rows_new`（带 CASCADE） → INSERT INTO new SELECT old → DROP old → RENAME new → old | ROLLBACK + 保留备份 + log error |
| `indexed` | 重建 `idx_acquiring_bill_currency_diff_run` 索引 | 同上 |
| `fk-verified` | PRAGMA foreign_key_check 验证 0 violation | 同上 — fail-fast 防数据破坏 |
| `flag-set` | INSERT OR REPLACE INTO app_settings (`n4_cont_2_diff_rows_cascade_migrated`, '1') | 同上 |
| `committed` | COMMIT 事务（除 backup 外整段事务）| 不可逆 — 已成功 |

#### 5.3.3 关键 DDL

```sql
-- Step rebuilt
CREATE TABLE acquiring_bill_currency_diff_rows_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  bill_import_id INTEGER NOT NULL,
  flow_currency TEXT,
  flow_amount_abs TEXT,
  diff_type TEXT NOT NULL,
  -- ⭐ v2.1.10 N4-cont-2 关键改动
  FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id) ON DELETE CASCADE
);

INSERT INTO acquiring_bill_currency_diff_rows_new
  SELECT * FROM acquiring_bill_currency_diff_rows;

DROP TABLE acquiring_bill_currency_diff_rows;

ALTER TABLE acquiring_bill_currency_diff_rows_new RENAME TO acquiring_bill_currency_diff_rows;

CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_diff_run
  ON acquiring_bill_currency_diff_rows(run_id);
```

### 5.4 回滚预案

#### 5.4.1 失败自动回滚

ROLLBACK 后：
- schema 回到 v2.1.9 状态（无 CASCADE）
- 备份文件保留 `<userData>/backups/tool-data-bak-pre-N4-cont-2-{timestamp}.sqlite`
- activity log 含 ROLLBACK 原因 + 备份路径

#### 5.4.2 手动恢复路径（USER_GUIDE 文档化）

如 ROLLBACK 后启动应用仍异常：
1. 关闭应用
2. 备份当前 `<userData>/tool-data.sqlite` 为 `tool-data-failed.sqlite`
3. 从 `<userData>/backups/tool-data-bak-pre-N4-cont-2-{timestamp}.sqlite` 复制为 `tool-data.sqlite`
4. 删除 settings 表 `n4_cont_2_diff_rows_cascade_migrated` 键（如有）
5. 重启应用 — 应回到 v2.1.9 schema 状态

---

## 六、与 v2.1.9 N1' / N5 / SR-backup-1 / N4 顺带项的对接细节

### 6.1 与 N1' idle cleanup 对接（详 §2.3 + §4.3）

- `lastUserActivityTs` 仅主进程维护
- worker 忙时 skip cleanup（避免抢锁）
- worker 完成后下个 idle tick 自然过渡
- **v0.2 新增**：N4-cont-1 raw_json 清理**完全复用 N1' idle cleanup 时序**（`src/main.js:11155-11178`） — 无新计时器；cleanup 回调内顺序：① 现有 v2.1.8 cleanup → ② v0.2 raw_json 清理（独立 try/catch + 失败不阻塞主 cleanup）

### 6.2 与 N5 channels FK 范式对接

- v2.1.9 N5 范式：`scenarios.channel_id REFERENCES channels(id) ON UPDATE CASCADE`（**不带** ON DELETE — 因为 channels 禁删，UI 双保护）
- v2.1.10 N4-cont-2 范式：`diff_rows.{run_id,bill_import_id} REFERENCES ... ON DELETE CASCADE`（**带** ON DELETE — 因为 diff_rows 是派生数据，业务语义跟随删除）
- ⚠️ 两者范式不同是**有意为之**（业务语义决定），不是不一致 — spec 显式说明避免后续 reviewer 误判

### 6.3 与 SR-backup-1 backup API 对接

- 所有 4 主线 migration / 体积治理操作都通过 `database.createBackup(label)` 复用
- label 命名规范：`pre-{label}`（label 仅 `[A-Za-z0-9_-]`）
- 本版新增 label：`pre-A3-worker-init`（A3 启动前可选备份）/ `pre-N4-cont-2`（N4-cont-2 migration）
- ~~`pre-raw-json-prune`（N4-cont-1 用户清理前可选备份）~~ ❌ **v0.2 删除**：N4-cont-1 改 idle 自动触发无用户主动路径；不做 backup（缓解 = 7 天窗口 + 仅清成功行 + USER_GUIDE 手动恢复路径）

### 6.4 与 N4 顺带项重构（v2.1.9）一致性

- v2.1.9 `ensureBillRawJsonV2Slim(db, dbPath, createBackupFn)` 引入第 3 参 createBackupFn 注入范式
- 本版 N4-cont-2 `ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, createBackupFn)` 沿用同一签名
- **v0.2 N4-cont-1** `clearStaleSuccessfulRawJson(db, retentionDays)` 极简签名 — 不依赖 createBackupFn（无备份策略，由 7 天窗口 + 仅清成功行 + USER_GUIDE 手动恢复路径等价缓解）

---

## 七、测试矩阵

### 7.1 单元测试（unit）

| 文件 | 测试函数 | case 数（预估） |
|---|---|---|
| `tests/unit/main-process/run-check-worker.test.js` | initWorkerDb + serializeError + deserializeError | 12 |
| `tests/unit/main-process/run-check-worker-pool.test.js` | preWarm / dispatch / cancel / crash recover | 10 |
| `tests/unit/main-process/worker-error-utils.test.js` | serializeError / deserializeError（含 FileValidationError）| 8 |
| `tests/unit/backend/acquiring-bill-currency-db/raw-json-retention.test.js`（v0.2 重写） | clearStaleSuccessfulRawJson / 差异行排除验证 / 7 天边界 / NULL idempotent / 0 行触发 | 8（v0.2 从 v0.1 15 case 下降 — 算法简化）|
| `tests/unit/backend/database/migrations-n4-cont-2.test.js` | ensureDiffRowsCascadeMigration_v2_1_10 各 status / 幂等 / ROLLBACK | 12 |
| `tests/unit/backend/database/settings-repository-raw-json-retention.test.js`（v0.2 简化为单 key） | getter 范围外回退（< 1 / > 30 / 非数字 / 空）| 4（v0.2 从 v0.1 6 case 下降 — 单 key）|

合计 ~54 unit case（v0.2 reverse sync 后 — 从 v0.1 ~63 下降；N4-cont-1 简化）

### 7.2 集成测试（integration）

| 脚本 | case 数（预估） | 主线 |
|---|---|---|
| `scripts/integration/acquiring-bill-currency-worker.js` | 8+ | A3 |
| `scripts/integration/acquiring-bill-currency-worker-crash.js` | 4+ | A3 |
| `scripts/integration/acquiring-bill-currency-idle-cleanup-worker.js`（v0.2 扩展验证 raw_json 清理共存）| 5+ | A3 + v2.1.9 N1' + v0.2 N4-cont-1 raw_json 集成 |
| `scripts/integration/acquiring-bill-currency-sql-chunked.js`（v0.2 必做）| 3+ | A4（v0.2 D25 用户拍板必做）|
| `scripts/integration/acquiring-bill-currency-raw-json-retention.js`（v0.2 重写）| 3+ | N4-cont-1（v0.2：idle 触发 + 差异行保留 + retention_days settings 生效；删 UI case）|
| `scripts/integration/acquiring-bill-currency-fk-cascade-migration.js` | 6+ | N4-cont-2 |

合计 ~ 29-31 集成 case（v0.2 reverse sync — A4 case 从条件改必做；N4-cont-1 case 数 5+ → 3+ 删 UI）；累计断言数预估 v2.1.9 baseline 1606 + ~180 = ~1786

### 7.3 smoke

| 脚本 | 改动 |
|---|---|
| `scripts/smoke/acquiring-bill-currency.js` | 加 worker 路径覆盖 + N4-cont-1 cleanup 覆盖 |

### 7.4 性能基线（独立脚本，不入 release-check）

| 脚本 | 测试 |
|---|---|
| `scripts/perf/v2.1.10-a3-worker-vs-mainprocess.js` | 同一份 500w 数据 worker vs main 跑时长对比 |
| `scripts/perf/v2.1.10-a4-chunked-vs-single.js`（条件）| chunk size 10w / 50w / 100w 对比 |

---

## 八、兼容性 & 破坏性变更清单

### 8.1 破坏性变更

| 变更 | 影响 | 缓解 |
|---|---|---|
| `acquiring_bill_currency_diff_rows` 表 FK 加 ON DELETE CASCADE | 删 run 后 diff_rows 自动消失（业务上一致，但用户脚本如依赖"删 run 不影响 diff_rows"会受影响）| CHANGELOG 显著位置警告 + USER_GUIDE 强调 |
| `runCheck` 改为 worker 内执行 | 开发者排错路径变 — stack 含 worker 函数行号；activity log domain 含 'worker'  | 文档化 |
| `bill_imports.raw_json` 可能被批量清成 '{}' | 用户脚本如读 raw_json 字段会拿到空对象（按月划分）| USER_GUIDE 强调清理前先备份 |

### 8.2 兼容性

| 项 | 兼容性 |
|---|---|
| v2.1.9 已上线 9 主题（N5/N6/N7/SR-backup-1/G1-cont/SR-policy-1/N1-settings/N4 重构/SR-log-1） | ✅ 全兼容；0 regression 硬约束 |
| v2.1.8 集成测试 ~1276 断言 | ✅ 全兼容；release-check gate |
| TEST.xlsx / TEST2.xlsx baseline | ✅ A3 worker 化后必须 byte-for-byte 一致 |

### 8.3 N4-cont-1 / N4-cont-2 顺序（v0.4 SR-FIX-1 round 2 P1-2 reverse sync）

migration 顺序固定（启动期，与 `src/backend/database.js` AppDatabase.init 实际顺序一致）：
1. **先 N4-cont-1 settings**（`ensureAcquiringBillCurrencyRawJsonRetentionSettings`） — INSERT OR IGNORE seed default=7（database.js:300）
2. 中间 **v2.1.8 N4 raw_json slim**（`ensureBillRawJsonV2Slim`）— 已发版迁移（database.js:310）
3. **后 N4-cont-2 schema rebuild**（`ensureDiffRowsCascadeMigration_v2_1_10`）— FK CASCADE 改造（database.js:363）

理由：
- **任意顺序都不影响功能**（settings INSERT OR IGNORE 与 schema rebuild 互不依赖）
- 固定为"settings 先 / schema 后" — settings 注入完毕后，启动期即可读 retention_days；schema 改造放在最后（与 v2.1.8 N4 raw_json slim 在同一 try-catch 段，集中处理 migration 异常）
- N4-cont-2 显式不依赖 N4-cont-1 settings；database.js:359-360 已注释说明"settings INSERT OR IGNORE 与 schema rebuild 互不影响；固定为 settings 在前便于排查"

**v0.3 之前 spec 描述（"先 N4-cont-2 schema → 后 N4-cont-1 settings"）与 code 现状相反，v0.4 reverse sync 更新本节描述与 code 一致**（finding 决策：不改 code 顺序，避免触发 schema migration 链路风险；改 spec 跟随 code）。

---

## 九、风险红线总结（CLAUDE.md 规则 7）

### 9.1 资金红线 / 数据迁移

详 PRD §五。

### 9.2 重要变量影响（待 scan:vars 详查）

| 层级 | 变量 | 文件 | 影响 |
|---|---|---|---|
| 🔴 Critical | `acquiring_bill_currency_diff_rows` FK schema | migrations.js:1506-1515 | **新增 CASCADE 范式** — 升格 Critical |
| 🔴 Critical（已存）| `runAllScenarios` / scenario-dispatcher | scenario-dispatcher.js | A3 worker 内独立执行 — 范畴扩 |
| 🟡 Important-skeleton | `IDLE_CLEANUP_MS` + `lastUserActivityTs` + `setupIdleCleanupTimer` | main.js:11119-11178 | A3 改造 idle timer 协调 |
| 🟡 Important-skeleton（新）| `runCheckWorkerPool` / `workerInstance` | run-check-worker-pool.js（新）| 新增 |
| 🟡 Important-skeleton（新）| `serializeError` / `deserializeError` | worker-error-utils.js（新）| 新增 |
| 🟢 Risk-sensitive | `bill_imports.raw_json` | migrations.js + N4-cont-1 cleanup | 内容契约扩 — **v0.2** 增加"对账成功老行可被自动 NULL 清空"语义（差异行永远保留 — writer.js:184 依赖）|
| 🟢 Runtime-state | `n4_cont_2_diff_rows_cascade_migrated` settings | migrations.js | 新增 migration 标志位 |
| 🟢 Runtime-state | `acquiring_bill_raw_json_retention_days` settings（v0.2 单 key — 从 v0.1 2 key 降为 1）| settings-repository.js | v0.2 新增 1 键（默认 7 / 范围 1-30）|
| 🟢 Runtime-state（v0.2 新增 / v0.3 sentinel 修订）| `clearStaleSuccessfulRawJson` | acquiring-bill-currency-db/raw-json-retention.js（新）| v0.2 新增 + v0.3 sentinel 改 `''`：单 SQL UPDATE WHERE NOT IN 排除差异行；idempotent（`raw_json != ''` 守卫；兼容 v2.1.8 N4 NOT NULL schema）|

---

## 十、spec 评审 checklist

- [ ] PRD §四 D23-D28 全部 PM 倾向已给（含 D23 "待 POC" 占位）
- [ ] §2.5 PRAGMA 强制清单与主进程 `database.js:42` 完全一致
- [ ] §2.6 Phase 0 POC 4 项实测目标明确
- [ ] §5.3 8-status state machine 沿用 v2.1.9 N5 范式
- [ ] §6.2 FK 范式差异（N5 vs N4-cont-2）显式说明
- [ ] §六 与 v2.1.9 N1' / N5 / SR-backup-1 / N4 顺带项的对接细节齐全
- [ ] §七 测试矩阵覆盖 4 主线
- [ ] §八 破坏性变更清单 + 缓解
- [ ] §九 重要变量影响清单（待 scan:vars 详查）

---

**当前状态**：v0.2（2026-05-28 reverse synced — D25/D26/D27 用户拍板 + N4-cont-1 重大方案变更已落 §三 / §四 / §六 / §七 / §九；A3 部分 POC 实测项仍待 Phase 0 填）。
**下一步**：通知 Dev 启动 Phase 0 POC（worker_threads vs utilityProcess 实测 — D23/D24 最终拍板）→ Phase 0 完成后回写 §2.6 实测列 + backlog D23 拍板 → Phase 1。N4-cont-1 / N4-cont-2 / A4 可与 Phase 1 并行（独立模块；无强依赖）。

---

## 十六、SR-FIX-1 — 合并前 self-review 修复（v0.4 reverse sync）

> v0.4 立项（2026-05-28 — Phase 0-6 全部完成 + 37 commits 后 dev self-review 输出 21 findings；用户拍板 Round 2 全修 P0 + P1）。
>
> 关联文档：`docs/iterations/v2.1.10/sr-fix-1-round1-findings.md`（Round 1 finding 详单）

### 16.1 现状审计（Round 1 finding 数量）

| 分级 | 数量 | 说明 |
|---|---:|---|
| 🔴 P0 Critical（合并前必修） | 4 | cleanupOrphanData × chunked partial / worker init-error brick / before-quit 缺 shutdown / cleanup 顺序契约 |
| 🟡 P1 Important（合并前修） | 9 | 文档遗漏 sentinel / spec/code 顺序倒置 / state machine 缺 'checked' / IPC handler CancelError UX / resume scan / worker 单测 / chunk_progress 兜底 / USER_GUIDE 警告 / forwarder 注释 |
| 🟢 P2 Minor（合并后可补 patch） | 8 | 注释 / typo / fixture / 边界 — 留 v2.1.10 后续 patch 或 v2.1.11+ |
| **合计** | **21** | Round 2 全修 P0 + P1 = 13 项 |

### 16.2 Round 2 修复清单（13 项 P0 + P1）

| Finding | 严重度 | 修复 commit | 修复说明 |
|---|---|---|---|
| **P0-1** cleanupOrphanData × chunked partial run | 🔴 | `0e4a87e` | session.js:582 cleanupOrphanData fileBroken 判定加 chunk_progress 检查 — partial 状态 continue 保留（A4 resume 路径保护）；phase3 集成 case 4（15 子断言） |
| **P0-2** worker init-error 后 brick | 🔴 | `45bd81e` | run-check-worker-pool.js:200-208 init-error 分支加 workerInitPromise=null + workerInstance=null + w.terminate() — 下次 dispatch 触发 cold-start；pool unit case 17 |
| **P0-3** before-quit 缺 workerPool.shutdown | 🔴 | `d16ec19` | main.js before-quit 加 needsWorkerShutdown helper + shutdownWorkerPoolGracefully helper — workerAlive=true 时 preventDefault + 异步 ① shutdown worker → ② cleanup pending → ③ app.quit |
| **P0-4** idle cleanup 顺序契约（spec §4.3.2 不符）| 🔴 | `ea2a443` | trigger 改返 Promise（早返回路径 Promise.resolve；执行路径 finally resolve）— idle tick 改 async + 在 trigger 后 await 再调 raw_json |
| **P1-1** tasks + manual-test-checklist 5 处 sentinel 残留 | 🟡 | `e8aec42` | tasks T23/T28 + manual-test §5.1 (3) + §10.3 D26 全部 `NULL` → `''` / `IS NULL` → `= ''` / `IS NOT NULL` → `!= ''`；保留 1 处 v0.3 修订标记 |
| **P1-2** spec §8.3 + PRD §5.3 migration 顺序倒置 | 🟡 | `b3e3c5d` | spec §8.3 改写匹配 code 现状（N4-cont-1 settings → N4 slim → N4-cont-2 schema）；PRD §5.3 同步；不动 code（避免触发 schema migration 风险）|
| **P1-3** ensureDiffRowsCascadeMigration 缺 'checked' status | 🟡 | `058c167` | migrations.js Step 4 backup-done 后加 Step 4.5 'checked' — 跑 PRAGMA foreign_key_check；如有 violation → status='pre-fk-violation' + 备份保留；migrations-n4-cont-2 unit case 13 |
| **P1-4** IPC handler CancelError 走 error 路径 | 🟡 | `ad207f9` | notifyAcquiringBillCurrencyResult 加 'cancelled' kind；run / resume IPC handler catch 加 `err.name === 'CancelError'` 守卫 → return status='cancelled' + 短 toast |
| **P1-5** resume handler 只扫最近 1 run | 🟡 | `c8c7cf8` | run-repository.js 新增 listPartialRuns(db, monthKey) API；resume handler 改造（payloadRunId 不传时扫所有 partial 取最近）；run-repository unit T19.7 + T19.8 |
| **P1-6** tasks T06 描述与实际不符 | 🟡 | `2432ffe` | tasks.md T06 \"验证\"章节重写 reverse sync — pool 17 case 已覆盖（含 P0-2 case 17）；不单独建 run-check-worker.test.js |
| **P1-7** worker crash 时 chunk_progress 不 partial | 🟡 | `ab4f06b` | main.js failureListener 内（hadActiveJob=true）扫所有 chunk_progress IS NOT NULL → status='in-progress' → 改 'partial' 兜底；run-repository unit T19.9 |
| **P1-8** USER_GUIDE 缺 partial run 警告 | 🟡 | `0bcd365` | USER_GUIDE §1.8.12 资金红线契约后追加 \"Resume 边界条件\" 5 项（P0-1 修复后跨重启可 resume / P1-7 worker crash 兜底 / v2.1.11+ UI / 不想 resume 重跑路径）|
| **P1-9** createRunProgressForwarder 注释过时 | 🟡 | `4ef2cc3` | main.js:10599 注释改 \"每 run 6 + chunkCount 事件\" + chunkCount > 100 节流 TODO（v2.1.11+）|

### 16.3 测试增量（Round 2 完成后）

| 阶段 | Round 1 baseline | Round 2 完成后 | 增量 |
|---|---:|---:|---:|
| unit | 1238 case / 297 suites | **1243 case / 297 suites** | +5（P0-2 / P1-3 / P1-5 ×2 / P1-7 = 5）|
| integration | 809 断言 / 15 脚本 | **824 断言 / 15 脚本** | +15（phase3 case 4 — P0-1 cleanupOrphanData × partial run 15 子断言） |
| smoke | 全过 | **全过** | 0 regression |

### 16.4 资金红线护栏（Round 2 维持）

1. **`clearStaleSuccessfulRawJson`** NOT IN 子查询排除差异行 — 不变（P1-1 仅文档修订；P0-4 顺序契约不影响 SQL）
2. **`runCheckCore`** worker vs main byte-for-byte — 不变（A3 P0-2 init-error reset 不影响 runCheck 正常路径；phase3 P0-1 case 4 验证 cleanup 不破坏 partial run 数据）
3. **`ensureDiffRowsCascadeMigration_v2_1_10`** 8-status state machine — 加 'checked' status；pre-FK violation 拒绝 migration 保护老数据（P1-3）
4. **`cleanupOrphanData`** partial run 保护 — P0-1 修复后 partial run 不被启动期清掉；FK CASCADE 范畴扩 + idempotent 保持

### 16.5 Round 2 → Round 3 建议

- **跑 release-check 全绿**（unit 1243 / integration 824 / smoke 全过）— ✅ closeout commit 已跑
- **可选 Codex review**（参考 v2.1.9 SR-FIX-1 Round 3 范式 — 主线程协调）
- **用户测试** — manual-test-checklist §5（N4-cont-1）+ §6（N4-cont-2）+ §三（A3 worker）+ §四（A4 chunked）+ §10.3 用户验收
- **rules/important-variables.md 升格评估**（留 Round 3 collective — 候选：`listPartialRuns` / `needsWorkerShutdown` / `shutdownWorkerPoolGracefully` 是否升 Important-skeleton）

---

## 十七、SR-FIX-1 Round 3 — Codex review 抓 finding 修复（v0.5 reverse sync）

> v0.5 立项（2026-05-28 — PR #54 已 push 后 Codex 自动 review 2026-05-28T09:16 完成，抓 2 finding；用户拍板修 F1 资金红线 + F2 P2 边界）

### 17.1 Codex finding 清单

| Finding | 严重度 | 位置 | 描述 |
|---|---|---|---|
| **F1** | 🟠 P1（资金红线 — Round 2 dev 漏抓的跨 Phase 协同 bug）| `src/backend/acquiring-bill-currency-db/raw-json-retention.js:55` | chunked run 半途 cancel/crash 时，`diff_rows` 仅含「已处理 mismatches」；后续 bill rows 仍未进 diff_rows。idle retention 在 bill imported_at 老于窗口时跑 → 清掉这些"未来 mismatch"raw_json → resume 后 writer 路径仍解析 `d.bill_raw_json` → 输出 broken / 不完整 |
| **F2** | 🟢 P2（小概率边界 case，1 commit 小改）| `src/main-process/acquiring-bill-currency-session.js:335` | worker 跑第一个 chunk 时 die（onChunkDone 触发前），chunk_progress 从未写入；crash listener（P1-7）只把已存在的 in-progress 转 partial；startup cleanup（P0-1）只保护 partial → first-chunk crash 后 run 被当孤儿无法 resume |

### 17.2 Round 3 修复清单（2 项 F1 + F2 + closeout）

| Finding | 严重度 | 修复 commit | 修复说明 |
|---|---|---|---|
| **F1** N4-cont-1 SQL 排除 partial run 关联 month | 🟠 | `d8f6446` | `raw-json-retention.js:CLEAR_STALE_SQL` 加第二个 NOT IN 子查询：`b.month_key NOT IN (SELECT month_key FROM runs WHERE chunk_progress IS NOT NULL AND json_extract($.status)='partial')`；解除条件：`status='complete'` 后下次 idle 可清；unit case 9-11 +3 (88 → 96 断言)；integration n4-cont-1-phase4 case 4 +5 (23 → 28 断言) |
| **F2** chunked 入口前初始 in-progress + cleanupOrphanData 守卫扩展 | 🟢 | `334a470` | `runCheckCore` 进 chunked 前先写 `{lastCompletedChunkIndex:-1, totalChunks:0, status:'in-progress'}`（仅 `!isResume`）；`cleanupOrphanData` 守卫扩为 `partial OR in-progress` 一起保护；unit T19.10 +1；integration a4-phase3 case 5 +7 (40 → 47 断言) |

### 17.3 测试增量（Round 3 完成后）

| 阶段 | Round 2 baseline | Round 3 完成后 | 增量 |
|---|---:|---:|---:|
| unit | 1243 case | **1247 case** | +4（raw-json-retention Case 9-11 = 3 + run-repository T19.10 = 1）|
| integration | 824 断言 | **836 断言** | +12（n4-cont-1-phase4 case 4 = 5 + a4-phase3 case 5 = 7）|
| smoke | 全过 | **全过** | 0 regression |

### 17.4 资金红线护栏（Round 3 维持 + 加强）

1. **`clearStaleSuccessfulRawJson`** 双 NOT IN 子查询（v0.5）：
   - 第一 NOT IN 排除差异行（既有 v0.2 守卫不变）
   - 第二 NOT IN 排除 partial run 关联月份的全部 bill（v0.5 Round 3 F1 新增 — 跨 Phase 协同保护）
2. **`runCheckCore` chunked 入口前 in-progress 占位**（v0.5 Round 3 F2）：
   - 保证 `chunk_progress IS NOT NULL` — first-chunk crash 后兜底路径能识别
   - byte-for-byte 不破坏（cancel 路径 catch 块仍覆盖入口 in-progress → partial）
3. **`cleanupOrphanData`** 守卫范畴扩展 — 从 partial 扩为 partial OR in-progress（idempotent 保持，FK CASCADE 范畴扩 + bill_imports 不被错清）

### 17.5 Round 3 → Round 4 建议

- **release-check 全绿**（unit 1247 / integration 836 / smoke 全过）— ✅ closeout commit 已跑
- **PR #54 自动同步**（git push 后）— 不重命名草稿 `docs/prs/PR54-v2.1.10.md`
- **用户测试**（manual-test-checklist 不需新增 — F1+F2 修复在既有 chunked / N4-cont-1 测试覆盖范畴）
- **可选 Round 4 Codex review**（如新发现 finding；本次 Round 3 修复 byte-for-byte 兼容 + 双 NOT IN 子查询性能验证已在 phase4 fixture 通过 — Round 4 风险低）

---

**当前状态**：v0.5（2026-05-28 SR-FIX-1 Round 3 完成 — Round 2 13 commits + Round 3 F1+F2+closeout 3 commits）。
**下一步**：通知主线程 → 验证 push / 用户测试 / merge 决策。
