# 技术规格 — v2.1.10 β 迭代

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（2026-05-28 起草） |
| 关联 PRD | `PRD-v2.1.10.md` v0.1（4 主线 + D23-D28 倾向） |
| 关联 backlog | `backlog.md` v0.1（β 范围锁定） |
| 起草人 | PM |
| 状态 | 起草中（v0.1，待 Phase 0 POC + spec 评审；A3 部分含"待 POC 数据回写"占位） |

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
| N4-cont-1 settings + repository | `src/backend/database/settings-repository.js` + `migrations.js` | ~60 行 |
| N4-cont-1 cleanup 函数 | `src/backend/acquiring-bill-currency-db/raw-json-retention.js`（新） | ~120 行 |
| N4-cont-1 UI 按钮 + dialog | `src/renderer.js` + `index.html` + `renderer-dialogs.js` | ~80 行 |
| N4-cont-1 IPC handler | `src/main.js` + `preload.js` | ~40 行 |
| N4-cont-2 migration | `src/backend/database/migrations.js` | ~100 行 |
| A4（条件）chunked | `src/backend/acquiring-bill-currency-db/run-repository.js`（待 spec §三细化）| ~60 行（条件触发） |
| 集成 + smoke + unit | `scripts/integration/` + `scripts/smoke/` + `tests/unit/` | ~30 文件 |

合计预估 ~ 50-70 文件改动（超 CLAUDE.md 5 软约束 — 因 4 主线打包结构性决定）。

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
| **启动延迟**（cold-start） | 主进程 perf.now() → worker init-done | < 200ms | 待 POC | 待 POC |
| **IPC 延迟**（双向 message round-trip） | 主进程 send ping → worker reply pong 1000 次平均 | < 10ms | 待 POC | 待 POC |
| **错误堆栈完整度** | worker 内人为 throw new Error('test') → 主进程 catch 后 err.stack 含 worker 函数行号 | stack 含 worker 内文件路径 + 行号 | 待 POC | 待 POC |
| **cancel 响应延迟** | worker 内执行 5s sleep → 主进程 1s 时发 cancel → worker exit | < 1s | 待 POC | 待 POC |

#### 2.6.2 POC 脚本位置

```
scripts/poc/v2.1.10-a3-worker-threads.js     # worker_threads 实测
scripts/poc/v2.1.10-a3-utility-process.js    # utilityProcess 实测
scripts/poc/v2.1.10-a3-comparison.md         # Phase 0 Dev 报告（待写）
```

#### 2.6.3 POC 通过后回写

Phase 0 完成后 Dev 必须：
1. 在 spec §2.6 表格"实测"列填数据
2. 在 backlog.md §"待 spec 阶段决策点"D23 行填最终拍板（worker_threads / utilityProcess）
3. 启动 Phase 1（主线 worker 框架）

---

## 三、A4 SQL JOIN chunked 分批（D25 = 待 A3 落地后评估）

### 3.1 触发条件

A3 Phase 2 联调完成后 Dev 在 500w × 2 行真实数据上跑 → 测：

| 指标 | 阈值 | 决策 |
|---|---|---|
| worker 内单条 INSERT-FROM-SELECT-JOIN 时长 | < 30s | A4 closure（不做）|
| worker 内单条 SQL 时长 | ≥ 30s | A4 触发，按下述细化 |
| worker cancel 响应延迟 | < 5s | A4 closure |
| worker cancel 响应延迟 | ≥ 5s | A4 触发（chunked 解决 cancel 粒度问题）|

### 3.2 若触发的设计（待 Phase 3 决策后细化）

#### 3.2.1 chunk size 候选

| chunk size | 优点 | 缺点 |
|---|---|---|
| 10w 行 | cancel 粒度细，进度回调精细 | 总耗时 + 5-10%（事务切换开销）|
| 50w 行 | 平衡点 | — |
| 100w 行 | 总耗时影响最小 | cancel 粒度粗 |

PM 倾向：50w 行（待 Phase 3 实测拍板）

#### 3.2.2 实现伪代码

```js
async function insertDiffRowsByJoinChunked(db, runId, monthKey, chunkSize = 500000, onProgress, cancelFlag) {
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

### 3.3 idempotent / 重跑保护

若用户重跑 runCheck（如失败后重试）：
- `clearOldRuns(monthKey)` 已删除该月 runs + 通过 N4-cont-2 CASCADE 自动删 diff_rows
- 新 runId 重新跑 — 不会有跨 run 数据污染

---

## 四、N4-cont-1 raw_json 体积治理

### 4.1 D26 保留窗口策略（PM 倾向：(d) 组合 6 月 + 500MB）

#### 4.1.1 settings 表新增 2 键

```js
// src/backend/database/migrations.js（沿用 v2.1.9 N1-settings 范式）
const ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_KEY = 'acquiring_bill_raw_json_retention_months';
const ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_DEFAULT = '6';
const ACQUIRING_BILL_RAW_JSON_RETENTION_MAX_MB_KEY = 'acquiring_bill_raw_json_retention_max_mb';
const ACQUIRING_BILL_RAW_JSON_RETENTION_MAX_MB_DEFAULT = '500';

function ensureAcquiringBillRawJsonRetentionSettings(db) {
  db.prepare(`INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)`)
    .run(ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_KEY, ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_DEFAULT);
  db.prepare(`INSERT OR IGNORE INTO app_settings (setting_key, setting_value) VALUES (?, ?)`)
    .run(ACQUIRING_BILL_RAW_JSON_RETENTION_MAX_MB_KEY, ACQUIRING_BILL_RAW_JSON_RETENTION_MAX_MB_DEFAULT);
}
```

#### 4.1.2 getter（沿用 v2.1.9 N1-settings 范式 — 范围外回退默认）

```js
// src/backend/database/settings-repository.js
const ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_MIN = 1;
const ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_MAX = 24;
const ACQUIRING_BILL_RAW_JSON_RETENTION_MAX_MB_MIN = 100;
const ACQUIRING_BILL_RAW_JSON_RETENTION_MAX_MB_MAX = 5000;

function getAcquiringBillRawJsonRetentionMonths(db) {
  const raw = getSetting(db, ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_KEY);
  if (raw == null || raw === '') return 6;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 6;
  if (n < ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_MIN || n > ACQUIRING_BILL_RAW_JSON_RETENTION_MONTHS_MAX) {
    return 6;
  }
  return n;
}
// getAcquiringBillRawJsonRetentionMaxMb 类似
```

#### 4.1.3 "标记超期" 算法（启动期触发，不删）

```js
// src/backend/acquiring-bill-currency-db/raw-json-retention.js（新）
function calculateExpiredRows(db, retentionMonths, maxMb) {
  const cutoffMonth = computeCutoffMonth(retentionMonths); // e.g. 当前 12 月 - 6 = 7 月
  const sizeRow = db.prepare(`
    SELECT month_key, SUM(LENGTH(raw_json)) AS bytes, COUNT(*) AS rows
    FROM acquiring_bill_currency_bill_imports
    GROUP BY month_key
    ORDER BY month_key ASC
  `).all();

  const expiredByMonth = sizeRow.filter(r => r.month_key < cutoffMonth);
  const expiredByMonthBytes = expiredByMonth.reduce((s, r) => s + r.bytes, 0);

  // 双门槛：任一超过即标记
  let expired = expiredByMonth;
  let total = sizeRow.reduce((s, r) => s + r.bytes, 0);
  if (total > maxMb * 1024 * 1024) {
    // 按 month_key 升序追加最老的，直到 total - expired <= maxMb
    let cumulative = expiredByMonthBytes;
    for (const r of sizeRow) {
      if (r.month_key >= cutoffMonth) break;
      // 已在 expiredByMonth 内
    }
    // 继续追加未超期但触发 MB 上限的
    for (const r of sizeRow) {
      if (r.month_key < cutoffMonth) continue;
      if (total - cumulative <= maxMb * 1024 * 1024) break;
      expired.push(r);
      cumulative += r.bytes;
    }
  }

  return {
    months: expired.map(r => r.month_key),
    totalRows: expired.reduce((s, r) => s + r.rows, 0),
    totalBytes: expired.reduce((s, r) => s + r.bytes, 0),
  };
}
```

### 4.2 D27 手动清入口 UI 位置（PM 倾向：(a) 收单单据模块独立按钮）

#### 4.2.1 UI 位置

收单单据币种校验模块面板顶部工具栏（与「开始运行」/ 「导出差异」按钮同行）新增按钮：

```html
<button id="acquiringBillRawJsonCleanupBtn" class="secondary-btn">
  清理历史 raw_json 数据
</button>
```

#### 4.2.2 文案

按钮 hover tooltip：「按保留窗口（默认 6 月 / 500MB）清理超期 raw_json 数据，释放磁盘空间」

#### 4.2.3 弹确认框文案

```
┌─────────────────────────────────────────────┐
│  清理历史 raw_json 数据                     │
├─────────────────────────────────────────────┤
│  当前保留窗口：最近 6 月 + 500MB 上限       │
│                                              │
│  待清理数据：                                │
│  • 月份范围：2025-08 ~ 2025-11（4 月）       │
│  • 行数：1,234,567 行                        │
│  • 预估释放：~120 MB                         │
│                                              │
│  ⚠️ 此操作不可逆。建议先备份 DB：           │
│  [应用菜单 → 备份数据库] (或 sqlite3 客户端) │
│                                              │
│  输入「确认」二次确认：                      │
│  [        输入框        ]                    │
│                                              │
│            [取消]   [确认清理]               │
└─────────────────────────────────────────────┘
```

#### 4.2.4 二次确认校验

```js
function onConfirmClick() {
  if (input.value.trim() !== '确认') {
    setStatus('请在输入框中输入「确认」二字才能执行清理', 'warning');
    return;
  }
  triggerCleanup();
}
```

### 4.3 数据迁移路径

#### 4.3.1 清理执行方式（PM 倾向：UPDATE raw_json = '{}' 留行 + 删内容）

```js
function pruneOldRawJson(db, candidateRowIds) {
  db.exec('BEGIN');
  try {
    const stmt = db.prepare(`UPDATE acquiring_bill_currency_bill_imports SET raw_json = '{}' WHERE id = ?`);
    let updated = 0;
    for (const id of candidateRowIds) {
      stmt.run(id);
      updated++;
      // 每 10000 行 yield event loop（沿用 v2.1.8 N4 范式）
      if (updated % 10000 === 0 && onProgress) onProgress({ updated, total: candidateRowIds.length });
    }
    db.exec('COMMIT');
    return { updated };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

**理由**：
- ✅ 保留 bill_imports 行结构 + month_key + recon_main_id + settle_currency 等业务关键字段
- ✅ 只清最大体积消耗的 raw_json（9 字段 JSON 内容）
- ✅ 用户审计仍能看到「这个月有过 X 行单据」
- ✅ diff_rows 外键 bill_import_id 仍指向有效行（不破坏 N4-cont-2 引入的 CASCADE）
- ✅ raw_json='{}' 是合法 JSON，下游读不会异常

#### 4.3.2 如果用户想"彻底删除"

留 v2.1.11+ 评估提供 `DELETE FROM bill_imports WHERE id IN (?)` 路径（带 ON DELETE CASCADE 自动清 diff_rows）

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

### 6.1 与 N1' idle cleanup 对接（详 §2.3）

- `lastUserActivityTs` 仅主进程维护
- worker 忙时 skip cleanup（避免抢锁）
- worker 完成后下个 idle tick 自然过渡

### 6.2 与 N5 channels FK 范式对接

- v2.1.9 N5 范式：`scenarios.channel_id REFERENCES channels(id) ON UPDATE CASCADE`（**不带** ON DELETE — 因为 channels 禁删，UI 双保护）
- v2.1.10 N4-cont-2 范式：`diff_rows.{run_id,bill_import_id} REFERENCES ... ON DELETE CASCADE`（**带** ON DELETE — 因为 diff_rows 是派生数据，业务语义跟随删除）
- ⚠️ 两者范式不同是**有意为之**（业务语义决定），不是不一致 — spec 显式说明避免后续 reviewer 误判

### 6.3 与 SR-backup-1 backup API 对接

- 所有 4 主线 migration / 体积治理操作都通过 `database.createBackup(label)` 复用
- label 命名规范：`pre-{label}`（label 仅 `[A-Za-z0-9_-]`）
- 本版新增 label：`pre-A3-worker-init`（A3 启动前可选备份）/ `pre-N4-cont-2`（N4-cont-2 migration）/ `pre-raw-json-prune`（N4-cont-1 用户清理前可选备份）

### 6.4 与 N4 顺带项重构（v2.1.9）一致性

- v2.1.9 `ensureBillRawJsonV2Slim(db, dbPath, createBackupFn)` 引入第 3 参 createBackupFn 注入范式
- 本版 N4-cont-2 `ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, createBackupFn)` 沿用同一签名
- 本版 N4-cont-1 `cleanupOldRawJson(db, retentionMonths, maxMb)` + `pruneOldRawJson(db, candidateRowIds, createBackupFn?)`（备份可选）

---

## 七、测试矩阵

### 7.1 单元测试（unit）

| 文件 | 测试函数 | case 数（预估） |
|---|---|---|
| `tests/unit/main-process/run-check-worker.test.js` | initWorkerDb + serializeError + deserializeError | 12 |
| `tests/unit/main-process/run-check-worker-pool.test.js` | preWarm / dispatch / cancel / crash recover | 10 |
| `tests/unit/main-process/worker-error-utils.test.js` | serializeError / deserializeError（含 FileValidationError）| 8 |
| `tests/unit/backend/acquiring-bill-currency-db/raw-json-retention.test.js` | calculateExpiredRows / pruneOldRawJson / 边界 | 15 |
| `tests/unit/backend/database/migrations-n4-cont-2.test.js` | ensureDiffRowsCascadeMigration_v2_1_10 各 status / 幂等 / ROLLBACK | 12 |
| `tests/unit/backend/database/settings-repository-raw-json-retention.test.js` | getter 范围外回退 | 6 |

合计 ~63 unit case

### 7.2 集成测试（integration）

| 脚本 | case 数（预估） | 主线 |
|---|---|---|
| `scripts/integration/acquiring-bill-currency-worker.js` | 8+ | A3 |
| `scripts/integration/acquiring-bill-currency-worker-crash.js` | 4+ | A3 |
| `scripts/integration/acquiring-bill-currency-idle-cleanup-worker.js` | 5+ | A3 + v2.1.9 N1' 协调 |
| `scripts/integration/acquiring-bill-currency-sql-chunked.js`（条件）| 3+ | A4（若做） |
| `scripts/integration/acquiring-bill-currency-raw-json-retention.js` | 5+ | N4-cont-1 |
| `scripts/integration/acquiring-bill-currency-fk-cascade-migration.js` | 6+ | N4-cont-2 |

合计 ~ 28-31 集成 case；累计断言数预估 v2.1.9 baseline 1606 + ~200 = ~1806

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

### 8.3 N4-cont-1 / N4-cont-2 顺序

migration 顺序固定（启动期）：
1. 先 N4-cont-2 schema rebuild（FK CASCADE 改造）
2. 后 N4-cont-1 settings INSERT OR IGNORE（注入默认值）

理由：N4-cont-1 启动期"标记超期"逻辑依赖 settings 已存在；N4-cont-2 不依赖 settings；先做 schema 再做 settings 不会冲突。

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
| 🟢 Risk-sensitive | `bill_imports.raw_json` | migrations.js + N4-cont-1 cleanup | 内容契约扩 — 增加"可被清空"语义 |
| 🟢 Runtime-state | `n4_cont_2_diff_rows_cascade_migrated` settings | migrations.js | 新增 migration 标志位 |
| 🟢 Runtime-state | `acquiring_bill_raw_json_retention_*` settings | settings-repository.js | 新增 2 键 |

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

**当前状态**：v0.1（2026-05-28 — spec 起草完毕；A3 POC 实测项空表占位待 Phase 0 填）。
**下一步**：用户审 spec → Dev 启动 Phase 0 POC（worker_threads vs utilityProcess 实测）→ Phase 0 完成后回写 §2.6 实测列 + backlog D23 拍板 → Phase 1。
