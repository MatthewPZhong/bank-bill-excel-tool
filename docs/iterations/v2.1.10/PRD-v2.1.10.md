# PRD — v2.1.10 β 迭代：runCheck 跨进程化 + SQL JOIN 分批 + raw_json 体积治理 + FK CASCADE

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（2026-05-28 起草） |
| 目标版本 | `v2.1.10`（minor — 架构级：runCheck 跨进程 + DB schema 不可逆 FK 改造） |
| 起始版本 | `v2.1.9`（α 已提 PR #53；β 启动节奏按用户拍板：α 提 PR 后立即开 β 分支） |
| 起草日期 | 2026-05-28 |
| 起草人 | PM |
| 状态 | 起草中（v0.1，待 spec 评审；4 主线全部 backlog v0.1 已锁定） |
| 关联文档 | `backlog.md` v0.1（β 范围）/ `spec.md` v0.1（待写）/ `tasks.md` v0.1（待写）/ `manual-test-checklist.md` v0.1（待写） |
| 涉及模块 | 收单单据币种校验（A3 worker / A4 chunked / N4-cont-1 raw_json / N4-cont-2 FK CASCADE）+ 全局 DB 基建（复用 SR-backup-1 + 沿用 v2.1.9 N5 channels FK 范式）+ 全局架构（worker 进程边界 + lastActiveTs 跨进程同步） |
| 工作分支 | `v2.1.10`（基于 main，已建好；`package.json.version` = `2.1.10-beta.1`） |
| 依赖 | v2.1.9 α 已上线产物：N5 channels FK 范式（ON UPDATE CASCADE） / SR-backup-1 backup API（VACUUM INTO） / N1' idle 30min cleanup 计时器 / N1-settings idle 阈值 settings 化 / N4 重构 createBackupFn 注入范式 / SR-log-1 全局告警日志 |
| package.json.version | 已 bump 到 `2.1.10-beta.1`（建分支时） |

---

## 一、版本目标 & 范围

### 1.1 4 主线打包（用户已拍板）

| 编号 | 主题 | 性质 | 风险 | 工期 |
|---|---|---|---|---|
| **A3** | `acquiring-bill-currency-session.runCheck` 跨进程化（worker_threads / utilityProcess 二选一） | 🔴 架构级 · 跨进程 IPC | 🔴 HIGH | ~1.5 周 |
| **A4** | SQL JOIN chunked LIMIT/OFFSET 分批跑（与 A3 联合评估 — A3 落地后看是否仍必要） | 性能优化 | 🟡 MID | ~0.5 周 |
| **N4-cont-1** | 收单单据 `bill_imports.raw_json` 历史保留体积治理（手动清入口 + 滚动保留窗口） | 体积治理 · UX | 🟡 MID | ~5 天 |
| **N4-cont-2** | FK CASCADE 改造（`diff_rows.bill_import_id` / `run_id` 加 `ON DELETE CASCADE`） | 🔴 DB schema 不可逆 | 🔴 HIGH | ~3 天 |

**β 合计预估**：~4 周（PM 上限估算 — 含 Phase 0 POC + 集成测试 + USER_GUIDE）

### 1.2 用户故事

| 角色 | 故事 | 主线 |
|---|---|---|
| 财务用户（500w 行收单数据） | 点开始运行后，主窗口不应卡死 / 不应弹"无响应"对话框；运行中能继续点其他模块按钮（如查看历史 run） | A3（+ A4 兜底） |
| 财务用户（重复运行多月份对账） | DB 文件不应无限膨胀 — 一年累计 10+ 月数据后仍能正常打开、备份、迁移 | N4-cont-1 |
| 财务用户（误操作删 run） | 删一个 run 时，对应差异行（diff_rows）应自动清掉；不应残留孤儿数据 | N4-cont-2 |
| 开发者（接手项目） | runCheck 异常时主进程不应崩溃；worker 错误 stack 必须完整回传 | A3 |
| 开发者（升级 v2.1.9 → v2.1.10） | DB schema 改造必须有自动备份 + 失败回滚；用户数据不丢 | N4-cont-2（复用 SR-backup-1） |

### 1.3 必做

- **A3**：worker 进程（worker_threads 或 utilityProcess，Phase 0 POC 实测后决策 D23）启动 / pre-warm / cold-start / cancel / crash recover；worker 独立 DB 连接（D24）+ PRAGMA 同步；错误序列化（stack/cause/code）跨进程；进度回调跨进程；与 v2.1.9 N1' idle cleanup 计时器跨进程协调（lastActiveTs 同步策略 + worker 不应阻止 idle cleanup）
- **A4**：基于 Phase 0 POC + A3 实测决策（D25）— 若 A3 worker 化后主进程已不阻塞且 worker 内 SQL 时长可接受 → 不做；若 worker 内 SQL 仍 > 30s → chunked 分批跑（chunk size 10w / 50w / 100w 待 spec 拍板）
- **N4-cont-1**：(1) settings 表新增 `acquiring_bill_raw_json_retention_months`（默认 6 月）+ `acquiring_bill_raw_json_retention_max_mb`（默认 500MB）；(2) 收单单据模块面板加「清理历史 raw_json」按钮 — 弹确认框 → 计算清理范围 → 二次确认 → 执行；(3) 启动期自动按保留窗口标记超期数据（不立即删，等用户主动清）；(4) 失败 / 中途取消 graceful + 活动日志
- **N4-cont-2**：(1) SR-backup-1 前置备份；(2) 事务包裹 8-status migration state machine（沿用 v2.1.9 N5 范式）：`pending → backup-done → checked → rebuilt → indexed → fk-verified → flag-set → committed`；(3) `acquiring_bill_currency_diff_rows` 表 rebuild：新表 + `FOREIGN KEY (run_id) REFERENCES ... ON DELETE CASCADE` + `FOREIGN KEY (bill_import_id) REFERENCES ... ON DELETE CASCADE` + INSERT INTO SELECT + DROP 旧表 + RENAME；(4) 标志位 `n4_cont_2_diff_rows_cascade_migrated`；(5) 回滚预案 — 失败 ROLLBACK 后保留备份文件 + activity log 警示
- 三件套（CHANGELOG / VFH / USER_GUIDE）发布前一次性更新（按 CLAUDE.md `workflow_docs_update`）
- smoke / 集成 / unit：A3（≥ 8 用例：worker 启动、cancel、crash、错误序列化、进度回传、idle 跨进程、PRAGMA 同步、DB 连接独立性）+ A4（若做：≥ 3 用例：chunk 边界 / 中断恢复 / 性能对比）+ N4-cont-1（≥ 5 用例：保留窗口触发 / 手动清确认 / 无数据 / 仅 1 条 / 中途取消）+ N4-cont-2（≥ 6 用例：跨版本升级 / CASCADE 验证 / 回滚 / 老数据 backfill / 标志位幂等 / fk-verified 校验）+ **0 regression 硬约束**（v2.1.9 已上线 9 主题全部回归通过）

### 1.4 明确不做

- **不做** F5-cont（C4 manyToOne ILP / 网络流重写）— 用户决定继续延期到 v2.1.11+
- **不做** N5-channels-scale 渠道虚拟滚动 — 视 v2.1.9 上线后实际使用观察（评估项）
- **不做** A3 把 `bank-bu-recon-session.runCheck` / `biz-op-recon-session.runCheck` / `pending-import` 也搬到 worker（继续只针对 `acquiring-bill-currency.runCheck`；3 套引擎评估后续版本再扩散，沿用 v2.1.8 PRD §5 "不做"决策）
- **不做** A3 worker 间共享 DatabaseSync 实例（worker 内独立连接，避免 SQLite 跨线程坑）
- **不做** A4 与 A3 双轨实施（二选一 — A3 落地后才决策 A4）
- **不做** N4-cont-1 自动删除（默认仅"标记超期"，删除一定要用户主动触发；理由：raw_json 一旦删不可逆）
- **不做** N4-cont-1 数据归档导出（仅删，不导出归档 zip；如需保留请用户自行 SR-backup-1 备份后清）
- **不做** N4-cont-2 顺带改其他表 FK（仅 `acquiring_bill_currency_diff_rows` 2 个 FK；详 D28 倾向）
- **不做** N4-cont-2 把 `bill_imports.bill_imports_id` / `flow_imports.flow_imports_id` 加 CASCADE（出于资金红线 — bill_imports 是数据真理源，不能跟随 run 删除消失）
- **不做** SR-log-1 v2.1.10 双写删旧（v2.1.9 D34=a 锁双写 1 版本 = v2.1.9；v2.1.10 评估删旧 = 留到 v2.1.10 self-review 后期或 v2.1.11）
- **不做** SR-log-1 永久保留日志的批量清理 UI（v2.1.9 D36=a 仅文件系统暴露；评估留 v2.1.11+）

---

## 二、主题详述

### 2.1 A3 — runCheck 跨进程化（🔴 架构级）

#### 2.1.1 背景

v2.1.7 F7-A1（PRAGMA WAL / synchronous=NORMAL / mmap_size）+ F7-A2（writer 阶段索引 + ANALYZE）+ F7-B1（Notification）是**短期缓解**，预计 unresponsive 概率降低 30-50%。v2.1.8 SR4 + v2.1.9 上线后用户反馈仍有"应用无响应"弹窗（500w × 2 行级数据 8-15 min 跨度）。

**A3 是根本解** — 把 `acquiring-bill-currency-session.runCheck`（`src/main-process/acquiring-bill-currency-session.js:172`）整体搬到 worker 进程，主进程事件循环完全不被 SQL JOIN / xlsx 写盘阻塞。

#### 2.1.2 代码现状（基于 grep）

| 锚点 | 文件:行 | 当前行为 |
|---|---|---|
| `runCheck` 函数 | `src/main-process/acquiring-bill-currency-session.js:172` | async；入参 `{ db, monthKey, storageRoot, onProgress }`；执行 5 阶段：clearOldRuns → computeStats → insertRun → insertDiffRowsByJoin → writeRunOutputs；主进程内同步执行 |
| `runCheck` IPC handler | `src/main.js:10758-10785` | `trackedIpcHandle('acquiringBillCurrency:run', ...)`；await session.runCheck → notifyResult → return；占用主进程 event loop |
| `IDLE_CLEANUP_MS` 计时器 | `src/main.js:11155-11178` | `setInterval(IDLE_CHECK_INTERVAL_MS)` 检查 `Date.now() - lastUserActivityTs ≥ IDLE_CLEANUP_MS`；触发 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded` |
| `lastUserActivityTs` | `src/main.js:31, 3972` | `let lastUserActivityTs = Date.now()`；renderer 节流上报后 main 更新 |
| `cleanupAfterRunBackground` | `src/main-process/acquiring-bill-currency-session.js:332` | 退出兜底 + idle 触发；分批 DELETE flow/bill；调用方主进程 (`src/main.js:11090, 11244`) |
| PRAGMA 设置 | `src/backend/database.js:42` 附近 | `foreign_keys=ON` + WAL + synchronous=NORMAL + cache_size + mmap_size（v2.1.7 F7-A1）|

#### 2.1.3 改造范围

| 子任务 | 改动 | 风险 |
|---|---|---|
| A3-1 | 新建 `src/main-process/run-check-worker.js`（worker 入口）：参考 `src/main-process/acquiring-bill-currency-session.js` 的 `runCheck` 函数提取可跨进程部分 | 🔴 跨进程数据序列化 |
| A3-2 | worker 内独立打开 DB 连接（D24 倾向：独立 connection）+ 重设全部 PRAGMA（v2.1.7 F7-A1 4 条） | 🔴 PRAGMA 漏设导致性能回退 |
| A3-3 | 错误序列化：worker 抛错通过 `{ message, stack, code, cause }` JSON 包装回主进程 → 主进程 throw new Error 重建 + 透传到 IPC return | 🟡 stack 不完整 |
| A3-4 | 进度回调：worker `parentPort.postMessage({ type: 'progress', stage, ... })` → 主进程 listener → forward 到 renderer（v2.1.7 F6 IPC channel `acquiringBillCurrency:run:progress` 链路不变） | 🟡 节流策略需保持 |
| A3-5 | lastActiveTs 跨进程同步（详 spec §2.3） + worker 内长任务不应阻止 idle cleanup 触发 | 🔴 worker 与 idle timer 状态错位风险 |
| A3-6 | 取消语义：worker 内执行期收到 `{ type: 'cancel' }` → graceful 终止 + DB 无锁残留 | 🟡 取消时机如发生在事务中需 ROLLBACK |
| A3-7 | 进程崩溃恢复：worker 异常退出 → 主进程感知 `error` / `exit` 事件 → 释放 op lock + 通知用户 | 🟡 防主进程死锁 |

#### 2.1.4 决策点（详 §四）

- D23: worker_threads vs utilityProcess（Phase 0 POC 实测）
- D24: DB 连接方案（独立 connection vs message-based RPC）

### 2.2 A4 — SQL JOIN chunked LIMIT/OFFSET 分批跑（🟡 性能 — 条件触发）

#### 2.2.1 背景

v2.1.7 PRD §12.1.3 明确"留 v2.1.8 与 A3 联合决策"；v2.1.8 PRD §五（A3 节）二选一锁定（若 A3 worker 化解决主进程不阻塞 → A4 可不做）。本版 D25 倾向：**待 A3 落地后评估**（Phase 3 触发）。

#### 2.2.2 代码现状

`insertDiffRowsByJoin`（`src/backend/acquiring-bill-currency-db/run-repository.js`，待 spec 阶段精确定位）目前是单条大 SQL INSERT-FROM-SELECT-JOIN，500w 行级数据 ~30-60s。

#### 2.2.3 改造范围（仅 A3 后 SQL 时长仍 > 30s 时才做）

- chunked LIMIT/OFFSET 拆分 N 个子 INSERT；每批 ~10w 行
- 进度回调附 `chunkIndex / chunkCount`
- 失败回滚仅当前事务批次，已 INSERT 成功的批次保留 → 重跑时 idempotent（按 month_key + recon_main_id 去重 → 或全部 DELETE 重跑）

### 2.3 N4-cont-1 — 收单单据 raw_json 历史保留体积治理（🟡 MID）

#### 2.3.1 背景

v2.1.8 N4 引入 `bill_imports.raw_json` 9 字段保留范式 → v2.1.9 N4 重构 backup API 切换。**v2.1.8 PRD §十四 实施记录**列出延期项："手动清入口 / 滚动保留窗口 / FK CASCADE 改造"。

**实际数据增长率**（用户上线 v2.1.8 后 1 个月反馈推断）：~500w 行 / 月 × 9 字段 JSON ≈ 50-200MB / 月（按平均字段长 100-400 字节）。一年累计 600MB - 2.4GB。

#### 2.3.2 代码现状

| 锚点 | 文件:行 | 说明 |
|---|---|---|
| `bill_imports.raw_json` schema | `src/backend/database/migrations.js:1463`（TEXT NOT NULL） | v2.1.8 N4 已瘦身到 9 字段 |
| `ensureBillRawJsonV2Slim` migration | `src/backend/database/migrations.js:795-927` | v2.1.8 引入 + v2.1.9 N4 重构 createBackupFn 注入 |
| 数据保留语义 | `cleanupAfterRunBackground`（session.js:332） | `includeDiff=false`（默认）：只清 flow + bill；`true`：连 diff 一起清 |
| 启动期 orphan cleanup | `session.js:418-424` Phase 1/2/3 | 复用 `cleanupAfterRunBackground` 清 orphan runs |
| settings 表 | `src/backend/database/settings-repository.js` | 已有 idle_cleanup_minutes 范式可参考 |
| 收单单据面板 UI | `src/renderer.js` / `index.html`（待 spec 精确定位） | v2.1.9 N1-settings dev agent 自扩展 ⚙️ 按钮被否决，此处 D27 倾向"收单模块独立按钮"避免重蹈 |

#### 2.3.3 改造范围

- **DB**：settings 表新增 2 键 — `acquiring_bill_raw_json_retention_months`（默认 6 月）+ `acquiring_bill_raw_json_retention_max_mb`（默认 500MB）
- **后端 cleanup 入口**：`cleanupOldRawJson(db, retentionMonths, maxMb)` 函数 — 计算超期数据 → 返回 `{ candidateRows, totalSizeMb }` 给 UI 弹确认框
- **执行删除**：`pruneOldRawJson(db, candidateRowIds)` 函数 — 事务包裹 + 分批 UPDATE raw_json = '{}' 或 DELETE bill_imports 行（D26 子决策点）
- **UI**：收单单据模块面板加「清理历史 raw_json」按钮（D27 倾向）→ 点击触发 calc + 弹确认框（含数据量 + 月份范围 + 预估释放 MB）→ 用户输入"确认"二次确认 → 执行
- **启动期**：仅"标记"超期，不删（避免启动期阻塞 + 避免用户没感知就丢数据）

#### 2.3.4 决策点（详 §四）

- D26: 保留窗口策略（最近 N 月 / N 个 run / N MB / 组合）
- D27: 手动清入口 UI 位置（收单模块独立按钮 / 应用设置弹框 / 模态对话）

### 2.4 N4-cont-2 — FK CASCADE 改造（🔴 DB 不可逆）

#### 2.4.1 背景

v2.1.8 N4 引入 `acquiring_bill_currency_diff_rows` 表 + FK（无 CASCADE，详 `src/backend/database/migrations.js:1506-1515`）。当 user / 后端逻辑删除一个 run（`DELETE FROM acquiring_bill_currency_runs WHERE id = ?`）或 bill_imports 行时，对应 diff_rows **不会**自动清，留下孤儿数据 → 体积增长 + 查询噪声。

**v2.1.9 N5 已锁定 FK 范式**：`scenarios.channel_id REFERENCES channels(id) ON UPDATE CASCADE`（不带 ON DELETE CASCADE，spec §3.2 明确禁删用 UI 双保护）。N4-cont-2 区别：**带** ON DELETE CASCADE — 因为 diff_rows 是 run 的派生数据，run 没了 diff_rows 必须跟着没（业务语义一致）。

#### 2.4.2 代码现状

```sql
-- src/backend/database/migrations.js:1506-1515 当前 schema
CREATE TABLE IF NOT EXISTS acquiring_bill_currency_diff_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  bill_import_id INTEGER NOT NULL,
  flow_currency TEXT,
  flow_amount_abs TEXT,
  diff_type TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),               -- ⚠️ 无 ON DELETE CASCADE
  FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id) -- ⚠️ 无 ON DELETE CASCADE
);
```

#### 2.4.3 改造范围

- **SR-backup-1 前置**：复用 v2.1.9 `createBackup(db, 'pre-N4-cont-2', backupDir)`（VACUUM INTO）
- **新 migration 函数** `ensureDiffRowsCascadeMigration_v2_1_10` in `src/backend/database/migrations.js`
- **8-status state machine**（沿用 v2.1.9 N5 范式）：详 spec §5.3
- **rebuild 策略**（SQLite 不支持 ALTER FK，必须 rebuild）：
  1. 建新表 `acquiring_bill_currency_diff_rows_new`（schema 一致 + 加 `ON DELETE CASCADE`）
  2. `INSERT INTO new SELECT * FROM old`
  3. `DROP TABLE old`
  4. `ALTER TABLE new RENAME TO acquiring_bill_currency_diff_rows`
  5. 重建索引 `idx_acquiring_bill_currency_diff_run`
  6. `PRAGMA foreign_key_check` 验证 0 violation
- **标志位**：`settings.n4_cont_2_diff_rows_cascade_migrated='1'`
- **回滚预案**：失败 ROLLBACK + 备份文件保留（手动恢复路径文档化）+ activity log error

#### 2.4.4 决策点（详 §四）

- D28: 改造范围（仅 diff_rows 2 FK / 顺带其他表）

---

## 三、与 v2.1.9 α 的强依赖

复用 backlog v0.1 §"与 v2.1.9 α 的强依赖"表格 + 加细节：

| v2.1.10 依赖项 | v2.1.9 α 提供 | 代码出处 | 复用方式 |
|---|---|---|---|
| 跨进程化备份（A3 worker 内 DB 备份 + N4-cont-2 migration 备份） | SR-backup-1 sqlite backup API（VACUUM INTO 范式） | `src/backend/database/backup.js` + `database.js` createBackup 实例方法 | 直接调 `database.createBackup('pre-A3-worker-init')` / `database.createBackup('pre-N4-cont-2')`；white-listed label `[A-Za-z0-9_-]` |
| N4-cont-2 FK 范式延续 | v2.1.9 N5 已锁 channels FK 范式（ON UPDATE CASCADE） | `src/backend/database/migrations.js:996` + N5 spec §3.2 | N4-cont-2 改 ON DELETE CASCADE（注意：N5 是禁删 + UI 双保护；N4-cont-2 是自动 cascade — 业务语义不同） |
| A3 worker 进程内 idle cleanup 协调 | v2.1.9 N1' idle cleanup 计时器 + N1-settings 阈值 settings 化 | `src/main.js:11119-11178`（setupIdleCleanupTimer + loadIdleCleanupMsFromSettings） | A3 worker 启动后必须 (1) 不阻止主进程 idle timer 触发；(2) worker 内 lastActiveTs 不要独立维护（详 spec §2.3）；(3) worker 在执行 runCheck 期间 idle cleanup 应 skip（避免抢占 DB 写锁） |
| N4-cont-1 与 v2.1.9 N4 顺带项一致性 | v2.1.9 N4 重构（createBackupFn 注入范式） | `src/backend/database/migrations.js:ensureBillRawJsonV2Slim` 第 3 参 `createBackupFn` | N4-cont-1 cleanupOldRawJson / pruneOldRawJson 函数沿用同一签名风格（依赖注入） |
| 所有 4 主线告警 | v2.1.9 SR-log-1 全局日志化 | `src/backend/logger.js` + `appendActivityLogEntry({ level, source, domain, message, details, stack })` | A3 worker 内告警必须通过 message-pipe 上报到 main（worker 无法直写 main 进程日志文件） |

---

## 四、D23-D28 决策点 PM 倾向（每个必须给）

| ID | 主题 | 决策点 | 选项 | PM 倾向 | 理由 |
|---|---|---|---|---|---|
| **D23** | A3 | 跨进程方案：worker_threads（Node 原生）vs Electron utilityProcess（更深整合 Electron 生命周期） | (a) worker_threads / (b) utilityProcess | **(a) worker_threads + Phase 0 POC 验证后确认** | (1) Node 原生 API 文档全 + 主进程引入成本最低；(2) utilityProcess 是 Electron 27+ API 但**生命周期挂在主进程**，主进程崩溃 worker 跟死，相比 worker_threads 没本质优势；(3) DatabaseSync 不能跨线程共享 → 两种方案都要重开 DB 连接，差异点不在 DB 层；(4) Phase 0 POC 仍要实测 — `npm start` 启动一个最小 runCheck 子集，测启动延迟、进程间消息延迟、错误堆栈完整度、cancel 响应延迟 4 项；如 worker_threads 实测有不可接受问题（如 DatabaseSync require 在 worker 内异常）则切回 (b) |
| **D24** | A3 | worker DB 连接方案：独立 connection vs message-based RPC | (a) 独立 connection（worker 内 `new DatabaseSync(dbPath)` + 重设 PRAGMA） / (b) message-based RPC（主进程 DB 单例 + worker 通过 message-pipe 调 SQL） | **(a) 独立 connection** | (1) **简单**：worker 内 `new DatabaseSync` + 重设 PRAGMA 5 行代码搞定；(2) **性能**：worker 内执行 SQL 无序列化跨进程开销（RPC 方案每条 SQL 都要 IPC 一次）；(3) **隔离**：worker 内 SQL 出错不影响主进程 DB 连接；(4) **代价**：worker 启动多 ~50-100ms（pre-warm 可摊销 cold start）+ PRAGMA 漏设风险（mitigate：抽 `initWorkerDb(workerDb)` helper + spec §2.5 强制清单）；(5) **WAL 兼容**：v2.1.7 F7-A1 已开 WAL，多连接读写并发安全；(6) Phase 0 POC 必须实测：两个连接同时写时是否会触发 SQLITE_BUSY |
| **D25** | A4 | 是否做（条件触发） | (a) 不做（A3 worker 化已解决主进程阻塞，SQL 时长可接受） / (b) 做（A3 落地后实测 SQL 时长仍 > 30s 触发 chunked） | **(b) — 待 A3 落地后评估（Phase 3 决策点）** | (1) PM 不能现在拍 (a)：A3 worker 化只解决"主进程阻塞"，但 worker 内 SQL 时长本身不变（仍 30-60s）— 若 worker 长时间执行单条 SQL，cancel 响应慢、内存峰值高、错误堆栈丢上下文；(2) chunked 分批主要价值：(i) 取消语义可达（每批之间检查 cancel flag）；(ii) 进度回调更精细（chunkIndex / chunkCount）；(iii) 内存峰值降低；(3) 但 chunked 引入额外复杂度：跨批一致性 + 失败回滚 + 重跑 idempotent；(4) 决策路径：A3 Phase 2 联调完后跑 500w × 2 行真实数据 → 若 worker 内单条 INSERT-FROM-SELECT-JOIN < 30s 且取消响应 < 5s → 不做（更新本节为 (a) + closure A4）；否则做（spec 阶段补 §三细节） |
| **D26** | N4-cont-1 | 保留窗口策略：最近 N 月 / N 个 run / N MB / 组合 | (a) 仅按月（最近 N 月） / (b) 仅按 run 数（最近 N runs） / (c) 仅按体积（max MB） / (d) **组合**：N 月 + max MB 双门槛（任一超过即标记） | **(d) 组合：最近 6 月 + 500MB 上限（任一超过即"标记"，等用户主动清）** | (1) **按月**直观符合财务对账周期感（季度报表、年报）；(2) **按 MB**保护磁盘资源（防止 1 个月 500w 行的极端用户撑爆 1GB）；(3) **组合双门槛**：早超期的月份先标记（如 7 月数据 + 当前 12 月，超 6 月）；体积爆掉时按 month_key 升序优先标记最老的；(4) **默认值理由**：6 月覆盖大多数财务对账场景（季度 + 半年）；500MB 是普通用户磁盘可接受峰值；(5) **不选纯 run 数**：1 月可能多次重导 run → 用 run 数标记策略易误删近期数据；(6) settings 可调（5-12 月 / 100-2000MB） |
| **D27** | N4-cont-1 | 手动清入口 UI 位置 | (a) 收单单据模块面板独立按钮 / (b) 应用设置弹框 / (c) 模态对话从启动检测时触发 | **(a) 收单单据模块面板独立按钮** | (1) **场景一致性**：N4-cont-1 是收单单据专属功能（其他 6 模块不涉及），按钮放在收单模块面板符合用户心智模型；(2) **避免重蹈 v2.1.9 N1-settings 教训**：D21 dev agent 自扩展 createAppSettingsDialog + ⚙️ 按钮被用户否决（覆盖率不足）；本版 D27 明确"收单模块独立按钮"防止重演；(3) **不选 (b) 应用设置弹框**：应用设置是全局配置（如 idle 阈值），数据清理是业务操作，混杂违反 SRP；(4) **不选 (c) 启动检测**：启动期阻塞 UI（v2.1.9 N5 migration 已是启动期事件，再叠加易触发 unresponsive）；(5) 文案："清理历史 raw_json 数据"（按钮）+ 弹确认框（数据量 + 月份范围 + 预估释放 MB + 「输入 '确认' 二次确认」）|
| **D28** | N4-cont-2 | FK CASCADE 改造范围 | (a) 仅 `diff_rows.bill_import_id` + `run_id` 2 FK / (b) 顺带其他表（如 `bill_imports`、`flow_imports`、`runs` 内部 FK） | **(a) 仅这 2 个 FK** | (1) **最小改动面**：v2.1.10 β 已是 4 主线打包（4 周），N4-cont-2 控制在 3 天；扩散到其他表会撑爆工期；(2) **业务一致性**：`diff_rows` 是 run 的派生数据 — run / bill_imports 没了 diff_rows 必须跟着没（业务语义明确）；(3) **bill_imports / flow_imports 不能加 ON DELETE CASCADE 到 runs**：它们是数据真理源，run 是处理结果；run 删了不能连数据源一起删；(4) **runs 内部 FK**：runs 表没有 FK 指向其他表（独立顶层）；(5) 后续版本（v2.1.11+）若有需求再评估其他表（如 bill_imports → flow_imports 关系）；(6) ⚠️ 风险显式提醒：本决策是 🔴 DB 不可逆 schema 改造 — 后续无法回退到无 CASCADE 范式（除非再 rebuild），所以保守起步只动 2 FK |

---

## 五、风险红线（CLAUDE.md 规则 7）

⚠️ **本版 β 全部 4 主线均涉及高危类别**：资金 / 数据迁移 / 破坏性 schema / 状态机 / 并发。

### 5.1 资金红线 / 数据迁移类

| 风险 | 主线 | 等级 | 缓解 |
|---|---|---|---|
| A3 worker 跨进程后 runCheck 5 阶段执行结果与主进程版必须 byte-for-byte 一致 | A3 | 🔴 资金红线 | (1) Phase 1 完成后跑 1276 + v2.1.9 新增断言全集回归；(2) 跑 TEST.xlsx + TEST2.xlsx baseline；(3) worker 与 main 各跑一次同一份数据对比 diff_rows 表 byte 级一致 |
| N4-cont-2 FK CASCADE 改造（DB 不可逆 schema） | N4-cont-2 | 🔴 不可逆 | (1) SR-backup-1 前置自动备份；(2) 8-status migration state machine（沿用 v2.1.9 N5 范式）；(3) PRAGMA foreign_key_check 0 violation 验证；(4) 失败 ROLLBACK + 备份文件保留 + activity log 警示；(5) USER_GUIDE 写明手动恢复路径 |
| N4-cont-1 raw_json 删除不可逆 | N4-cont-1 | 🔴 不可逆 | (1) 默认仅"标记"不自动删；(2) 手动清入口要求"输入 '确认' 二次确认"防误触；(3) 删前 SR-backup-1 备份提示（用户选项 — 默认不备份避免双倍磁盘占用，但 USER_GUIDE 强调先备份） |

### 5.2 并发 / 状态机类

| 风险 | 主线 | 等级 | 缓解 |
|---|---|---|---|
| A3 worker 进程崩溃 → 主进程 op lock 永久占用 | A3 | 🔴 高 | (1) worker 启动后注册 `error` / `exit` 事件 → 释放 op lock；(2) Notification 通知用户；(3) main.js handler try/catch finally releaseOpLock；(4) 集成测试 case：人为 process.exit(1) 模拟 worker crash |
| A3 worker DB 连接 + 主进程 DB 连接同时写 → SQLITE_BUSY | A3 | 🟡 中 | (1) WAL 模式下读不阻塞写；(2) worker 仅在 runCheck 时执行写（其他时段 close）；(3) busy_timeout PRAGMA 设为 30000ms；(4) Phase 0 POC 测两个连接同时写 stress |
| A3 worker 内 idle cleanup 与 worker 长任务冲突 | A3 | 🟡 中 | (1) worker 执行 runCheck 期间 main idle timer 暂停 cleanup 触发（详 spec §2.3）；(2) lastActiveTs 维护在主进程；worker 不独立维护；(3) cleanup 只在主进程触发，worker 不调 cleanupAfterRunBackground |
| N4-cont-2 migration 期间用户操作（如启动 runCheck） | N4-cont-2 | 🟡 中 | (1) migration 必须在 app.whenReady 之前完成（启动期）；(2) UI 在 migration 完成前禁用所有操作按钮；(3) failure 状态 UI 显示"启动失败请联系支持"+ 不进入主界面 |

### 5.3 兼容性 / 升级路径

| 风险 | 主线 | 等级 | 缓解 |
|---|---|---|---|
| v2.1.9 → v2.1.10 升级时 N4-cont-2 migration + N4-cont-1 settings 同时引入 | N4-cont-2 + N4-cont-1 | 🟡 中 | (1) migration 顺序固定：先 N4-cont-2 schema rebuild，后 N4-cont-1 settings INSERT OR IGNORE；(2) settings 失败 fallback 默认值（6 月 / 500MB） |
| A3 worker 化对老 v2.1.9 N5 channels FK 透明 | A3 | 🟢 低 | worker 内独立 connection 自动加载所有 schema，FK 沿用 |

### 5.4 强制要求（CLAUDE.md 规则 7）

1. **spec 阶段必须有专门 reviewer 审 4 主线**（特别 A3 worker 与 N4-cont-2 FK 改造）
2. **实施前必须确认 DB 备份策略**（A3 / N4-cont-2 都依赖 SR-backup-1）
3. **集成测试硬约束**：4 主线累计新增 ≥ 22 用例（A3:8+ / A4:3+ 条件 / N4-cont-1:5+ / N4-cont-2:6+），0 regression
4. **PR 提交前必须跑** `/check-vars` skill（重要变量 check）
5. **A3 worker 进入主线代码前必须 Phase 0 POC 报告**：worker_threads vs utilityProcess 4 项实测结果（启动延迟 / IPC 延迟 / 错误堆栈 / cancel 响应）回写 spec + backlog

---

## 六、不在本版本范围

| 主题 | 原因 | 下一步 |
|---|---|---|
| **F5-cont C4 manyToOne ILP/网络流重写** | 用户 2026-05-27 拍板继续延期；需要单独 spec 评估算法范式（subset-sum DFS+剪枝 → ILP/网络流）+ 资金红线评审；本版 β 已是 4 主线打包，无带宽再扩 | v2.1.11+ 评估 |
| **N5-channels-scale** 渠道枚举膨胀 UI 虚拟滚动 | 触发条件未达（v2.1.9 上线后观察渠道平均创建数量；如普遍 > 50 个则启动；否则继续延） | v2.1.9 上线 1-2 月后评估 |
| **A3 扩散到 bank-bu-recon / biz-op-recon** | 沿用 v2.1.8 PRD §5 决策：先针对 acquiring-bill-currency 单引擎验证，跑通 1-2 版本再扩散；3 套引擎一起做风险倍增 | v2.1.11+ 评估 |
| **A3 worker 间 DatabaseSync 共享** | SQLite DatabaseSync 设计上不支持跨线程共享，避免踩坑 | 不做（语言层面限制） |
| **N4-cont-1 raw_json 自动删除** | 一旦删不可逆 — 默认仅"标记"超期，用户主动触发 | 不做（资金红线兜底） |
| **N4-cont-1 数据归档导出（zip）** | 增加 UX 复杂度且与"清理"功能正交；如需保留请用户先 SR-backup-1 备份 | v2.1.11+ 评估 |
| **N4-cont-2 顺带其他表 FK CASCADE** | D28=a 控制最小改动面；其他表 FK 业务语义需要单独评估 | v2.1.11+ 评估 |
| **N4-cont-2 把 bill_imports / flow_imports 加 CASCADE 到 runs** | bill_imports / flow_imports 是数据真理源；不能跟随 run 删 | 不做（资金红线兜底） |
| **SR-log-1 双写删旧（app_activity_log.txt）** | v2.1.9 D34=a 锁双写 1 版本 = v2.1.9；评估留 v2.1.10 self-review 后期或 v2.1.11 | v2.1.10 收尾或 v2.1.11 评估 |
| **SR-log-1 永久保留日志的批量清理 UI** | v2.1.9 D36=a 仅文件系统暴露 | v2.1.11+ 评估 |

---

## 七、验收矩阵

| 验收项 | 主线 | 验证方式 | 预期 |
|---|---|---|---|
| Phase 0 POC 实测报告（worker_threads vs utilityProcess） | A3 | Dev 提交 Phase 0 报告（写入 spec §2.6 实测数据） | 4 项指标实测数据齐全 + D23 最终拍板 |
| worker 启动 + cold-start delay | A3 | smoke + 性能脚本 | cold-start < 200ms |
| worker pre-warm 后 runCheck 启动 < 50ms | A3 | 性能脚本 | < 50ms |
| worker DB 连接独立性（独立 PRAGMA） | A3 | 集成测试 | worker 内 `PRAGMA journal_mode` 返回 WAL + cache_size = 65536 等 4 条 PRAGMA 全设 |
| worker 错误序列化（stack/cause 完整回传） | A3 | 集成测试 | 主进程 catch 到的 err.stack 含 worker 内函数行号 |
| worker 进度回调（5 阶段 + chunkIndex） | A3 | 手测 + 集成 | renderer 收到 5 阶段事件 + 文案对应 |
| worker cancel 响应 | A3 | smoke + 手测 | cancel 后 5s 内 worker exit + 主进程 op lock 释放 |
| worker crash 恢复 | A3 | smoke（人为 process.exit(1)） | 主进程感知 + 释放 op lock + Notification 通知 |
| idle cleanup 跨进程协调 | A3 | 集成测试 | worker 执行期间 idle timer 不触发 cleanup（避免抢锁） |
| **0 regression**：v2.1.9 9 主题 + v2.1.8 集成测试断言全集 | A3 | release-check + 集成测试 | 累计 ≥ 1606 断言（v2.1.9 baseline）全 PASS |
| A4 chunked 触发条件（若做） | A4 | spec §三决策 | 若 A3 落地后 SQL 时长 > 30s → 触发；否则 closure |
| A4 chunked 中断恢复（若做） | A4 | 集成测试 | 中途 cancel → 重跑 idempotent |
| N4-cont-1 settings 默认值 | N4-cont-1 | smoke | 启动后 settings 表 `acquiring_bill_raw_json_retention_months='6'` + `_max_mb='500'` |
| N4-cont-1 启动期"标记超期" | N4-cont-1 | 集成测试 | 启动后 activity log 含 `[N4-cont-1] 标记 X 行超期，预估 Y MB` |
| N4-cont-1 手动清按钮 → 弹确认框 | N4-cont-1 | 手测 | 收单单据面板有按钮 + 点击弹确认框 + 含数据量统计 |
| N4-cont-1 二次确认 → 执行删除 | N4-cont-1 | 手测 + smoke | 输入"确认"后 raw_json = '{}' 或行删除（按 D26 子决策） |
| N4-cont-1 边界（无数据 / 仅 1 条） | N4-cont-1 | 集成测试 | 无数据时按钮 disabled / 仅 1 条仍能正常清 |
| N4-cont-2 migration 自动备份 | N4-cont-2 | 启动 + 集成测试 | `<userData>/backups/tool-data-bak-pre-N4-cont-2-{timestamp}.sqlite` 存在 |
| N4-cont-2 schema 改造完成 | N4-cont-2 | sqlite3 + 集成 | `PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')` 显示 ON DELETE CASCADE × 2 |
| N4-cont-2 PRAGMA foreign_key_check 0 violation | N4-cont-2 | migration 末尾 | 0 violation |
| N4-cont-2 关联删除验证（删 run → diff_rows 自动清） | N4-cont-2 | 集成测试 | `DELETE FROM acquiring_bill_currency_runs WHERE id = ?` 后 `SELECT COUNT(*) FROM diff_rows WHERE run_id = ?` = 0 |
| N4-cont-2 老数据保留（已存在的 runs / diff_rows） | N4-cont-2 | 集成测试 | 升级后老数据 row count 不变 |
| N4-cont-2 migration 幂等 | N4-cont-2 | 启动 2 次 | 第二次 activity log 含 `[N4-cont-2] 已迁移，跳过` |
| N4-cont-2 migration 失败回滚 | N4-cont-2 | 故障注入 | ROLLBACK 后 schema 回到 v2.1.9 状态 + 备份保留 |
| 4 主线 PR 提交前 check-vars 全过 | 全部 | `npm run check:vars` | 0 新增 Critical 命中（或命中已在 spec 范围） |

---

## 八、文档三件套登记（发版前一次性更新）

按 CLAUDE.md `workflow_docs_update` + README 约束，下列文档**版本号 bump 时统一更新**：

- [ ] `CHANGELOG.md` — v2.1.10 章节 + 4 主线高亮 + **N4-cont-2 FK CASCADE 不可逆变更警告** + A3 worker 架构改造（影响开发者排错路径）+ N4-cont-1 raw_json 体积治理（用户感知：磁盘 / 清理）
- [ ] `docs/VERSION_FEATURE_HISTORY.md` — v2.1.10 历史栏 + runCheck 跨进程化 + raw_json 体积治理 + FK CASCADE
- [ ] `docs/USER_GUIDE.md` —
  - 「收单单据币种校验」章节新增「raw_json 历史保留与清理」段（保留窗口默认值 + 手动清入口 + 二次确认 + 不可逆警告）
  - 「故障排查」章节新增「DB 备份恢复路径」段（路径 `<userData>/backups/tool-data-bak-pre-{label}-{timestamp}.sqlite`；恢复方法：关闭应用 → 复制覆盖 tool-data.sqlite → 重启）
  - 「故障排查」章节新增「worker 进程异常」段（A3 worker crash 后用户感知 + 应对：重试 runCheck；持续失败 → 查日志 `logs/{YYYY-MM}/{MM-DD}/error.log`）

---

## 九、变更记录

| 日期 | 变更内容 |
|---|---|
| 2026-05-28 | v0.1 起草（PM；β 4 主线 + D23-D28 倾向 + 风险红线） |

---

## 十、待澄清问题

- [ ] D23 worker_threads vs utilityProcess 最终拍板需 Phase 0 POC 数据回写
- [ ] D25 A4 是否做需 A3 Phase 2 联调后实测数据决策
- [ ] D26 子决策：raw_json 清理执行方式 — UPDATE raw_json = '{}'（保留行 + 删内容）/ DELETE 整行（连带 bill_imports 行）— 需 spec 阶段拍板（PM 倾向 UPDATE 留行；保留 bill 元数据便于审计）
- [ ] N4-cont-1 settings 调整 UI：是否提供 UI 改保留窗口（PM 倾向：不做 UI，沿用 v2.1.9 N1-settings 经验，仅 sqlite3 改 settings 表）— 需用户拍板

---

## 十一、实施记录（dev 阶段填）

### PR #X — v2.1.10 β 发版（待提交）

- **PR**：待创建
- **分支**：v2.1.10 → main
- **commit 数**：待统计
- **完整改动记录**：待归档 `docs/prs/PR{N}-v2.1.10.md`

#### 主题完成度

| 主题 | 状态 | 备注 |
|---|---|---|
| **A3** runCheck 跨进程化 | ⏳ 待启动 | 6 决策（D23-D28）PM 倾向待 spec 评审 |
| **A4** SQL JOIN chunked | ⏳ 待评估 | 待 A3 Phase 2 联调后决策（D25） |
| **N4-cont-1** raw_json 体积治理 | ⏳ 待启动 | D26 = (d) 6 月 + 500MB / D27 = (a) 收单模块独立按钮（PM 倾向） |
| **N4-cont-2** FK CASCADE 改造 | ⏳ 待启动 | D28 = (a) 仅 diff_rows 2 FK（PM 倾向） |

#### 关键 reverse sync（设计与实施差异）

待 dev 阶段填。

#### 测试覆盖

待 dev 阶段填。

#### 后续节点

- β merge 后归档 PR 草稿到 `docs/prs/PR{N}-v2.1.10.md`（按 memory `workflow_archive_pr_draft`）
- 后续整合改动清单到本 PRD §十一 实施记录（按 memory `workflow_pr_integrate_prd`）
- v2.1.11+ backlog 起草：F5-cont / N5-channels-scale / SR-log-1 双写删旧 / A3 扩散 3 套引擎评估

---

**当前状态**：v0.1（2026-05-28 — β 4 主线 PRD 起草完毕，D23-D28 全部给 PM 倾向，待 spec 评审 + Phase 0 POC）。
**下一步**：用户审 PRD → spec.md 起草 → Phase 0 POC（worker_threads vs utilityProcess 实测）→ 启动 Phase 1。
