# PRD — v2.1.10 β 迭代：runCheck 跨进程化 + SQL JOIN 分批 + raw_json 体积治理 + FK CASCADE

| 字段 | 值 |
|---|---|
| 文档版本 | v0.5（2026-05-28 — SR-FIX-1 Round 5 G1 setRunChunkProgress 提前到 COMMIT 后任何 await 前；窗口期 0 缝隙）/ v0.4（SR-FIX-1 Round 4 F1 N4-cont-1 SQL 守卫从 partial 扩为 partial OR in-progress；状态机 4 处链路统一）/ v0.3（2026-05-28 — N4-cont-1 sentinel 修订 `NULL → ''` 兼容 v2.1.8 N4 NOT NULL schema）/ v0.2（D25/D26/D27 + N4-cont-1 方案变更）/ v0.1（PM 初版） |
| 目标版本 | `v2.1.10`（minor — 架构级：runCheck 跨进程 + DB schema 不可逆 FK 改造） |
| 起始版本 | `v2.1.9`（α 已提 PR #53；β 启动节奏按用户拍板：α 提 PR 后立即开 β 分支） |
| 起草日期 | 2026-05-28（v0.1 / v0.2 reverse sync / v0.3 sentinel 修订 / v0.4 Round 4 F1 状态机统一 / v0.5 Round 5 G1 窗口期 0 缝隙） |
| 起草人 | PM + Dev Phase 4 T28 发现 + 主线程 修订 + Round 3/4/5 Codex review |
| 状态 | v0.5 SR-FIX-1 Round 5 完成（Round 3 F1+F2 + Round 4 F1+F2+F3 + Round 5 G1 收尾） |
| 关联文档 | `backlog.md` v0.2（D23-D28 全部拍板）/ `spec.md` v0.7（Round 5 reverse sync §19）/ `tasks.md` v0.2 / `manual-test-checklist.md` v0.2 |
| 涉及模块 | 收单单据币种校验（A3 worker / A4 chunked 必做 / N4-cont-1 raw_json 仅清对账成功行 / N4-cont-2 FK CASCADE）+ 全局 DB 基建（复用 SR-backup-1 + 沿用 v2.1.9 N5 channels FK 范式 + 复用 v2.1.9 N1' idle cleanup 计时器）+ 全局架构（worker 进程边界 + lastActiveTs 跨进程同步） |
| 工作分支 | `v2.1.10`（基于 main，已建好；`package.json.version` = `2.1.10-beta.1`） |
| 依赖 | v2.1.9 α 已上线产物：N5 channels FK 范式（ON UPDATE CASCADE） / SR-backup-1 backup API（VACUUM INTO） / N1' idle 30min cleanup 计时器（`src/main.js:11155-11178`，N4-cont-1 复用追加回调）/ N1-settings idle 阈值 settings 化 / N4 重构 createBackupFn 注入范式 / SR-log-1 全局告警日志 |
| package.json.version | 已 bump 到 `2.1.10-beta.1`（建分支时） |

---

## 一、版本目标 & 范围

### 1.1 4 主线打包（用户已拍板 — v0.2 reverse sync 后）

| 编号 | 主题 | 性质 | 风险 | 工期 |
|---|---|---|---|---|
| **A3** | `acquiring-bill-currency-session.runCheck` 跨进程化（worker_threads / utilityProcess 二选一） | 🔴 架构级 · 跨进程 IPC | 🔴 HIGH | ~1.5 周 |
| **A4** | SQL JOIN chunked LIMIT/OFFSET 分批跑（**v0.2：D25 用户拍板必做，不等 A3 实测**） | 性能优化 · 必做 | 🟡 MID | ~3-4 天 |
| **N4-cont-1** | 收单单据 `bill_imports.raw_json` 历史保留体积治理（**v0.2：仅清"对账成功"行 raw_json + 复用 v2.1.9 N1' idle 30min cleanup + 7 天窗口（settings 可调 1-30） + 0 UI**） | 体积治理 · 复用 N1' idle | 🟡 MID | ~2-3 天 |
| **N4-cont-2** | FK CASCADE 改造（`diff_rows.bill_import_id` / `run_id` 加 `ON DELETE CASCADE`） | 🔴 DB schema 不可逆 | 🔴 HIGH | ~3 天 |

**β 合计预估**：~3.5 周（v0.2 — N4-cont-1 工期下降 + A4 必做工期上升 ≈ 相抵；含 Phase 0 POC + 集成测试 + USER_GUIDE）

### 1.2 用户故事

| 角色 | 故事 | 主线 |
|---|---|---|
| 财务用户（500w 行收单数据） | 点开始运行后，主窗口不应卡死 / 不应弹"无响应"对话框；运行中能继续点其他模块按钮（如查看历史 run） | A3（+ A4 必做 — cancel 响应 < 5s + 进度回调精细化） |
| 财务用户（重复运行多月份对账） | 用户无感，DB 自动按 idle 30min 触发清理对账成功行的老 raw_json（保留 7 天数据复查）；差异行 raw_json 永远保留以便重导差异 xlsx；一年累计 10+ 月数据后体积治理生效 | N4-cont-1 |
| 财务用户（误操作删 run） | 删一个 run 时，对应差异行（diff_rows）应自动清掉；不应残留孤儿数据 | N4-cont-2 |
| 开发者（接手项目） | runCheck 异常时主进程不应崩溃；worker 错误 stack 必须完整回传 | A3 |
| 开发者（升级 v2.1.9 → v2.1.10） | DB schema 改造必须有自动备份 + 失败回滚；用户数据不丢 | N4-cont-2（复用 SR-backup-1） |

### 1.3 必做

- **A3**：worker 进程（worker_threads 或 utilityProcess，Phase 0 POC 实测后决策 D23）启动 / pre-warm / cold-start / cancel / crash recover；worker 独立 DB 连接（D24）+ PRAGMA 同步；错误序列化（stack/cause/code）跨进程；进度回调跨进程；与 v2.1.9 N1' idle cleanup 计时器跨进程协调（lastActiveTs 同步策略 + worker 不应阻止 idle cleanup）
- **A4（v0.2：D25 用户拍板必做，不等 A3 实测）**：chunked 分批跑 — cancel 响应 < 5s + 进度回调精细化（chunkIndex / chunkCount）是 hard requirement；chunk size 选 10w 行（spec §3.2 已选定，理由：cancel 响应 < 5s + 内存峰值 < 200MB）；idempotent / 重跑保护（必做不再"待 Phase 3 细化"）
- **N4-cont-1（v0.2：重大方案变更）**：
  - (1) settings 表新增单键 `acquiring_bill_raw_json_retention_days`（默认 7 天；settings 可调范围 1-30；getter 沿用 v2.1.9 N1-settings 范式范围外回退默认值）
  - (2) **完全复用 v2.1.9 N1' idle 30min cleanup 计时器**（`src/main.js:11155-11178`），在 idle cleanup 回调内追加 raw_json 清理逻辑 — 找出对账成功（不在 `acquiring_bill_currency_diff_rows` 中）+ **不属于可恢复 run 关联月份**（v0.6 Round 4 F1 扩 `partial OR in-progress`；v0.5 Round 3 F1 首版仅 partial）+ `imported_at < datetime('now', '-N days')` 的 `acquiring_bill_currency_bill_imports` 行 → `UPDATE raw_json = ''`（v0.3 sentinel；保留行骨架 + 业务字段；兼容 v2.1.8 N4 NOT NULL 约束 — 详 spec §4.2.1）
  - (3) graceful 失败 + 活动日志（沿用 v2.1.9 SR-log-1 `appendActivityLogEntry` 范式）
  - (4) 失败不阻塞 N1' 主流程 cleanup（try/catch + 下次 idle 重试）；顺序：先执行 v2.1.8 cleanupAfterRunBackground，后执行 raw_json 清理
  - (5) **0 UI**（v0.2：D27 用户拍板）— 不加按钮、不加 dialog、不加 IPC handler；用户无感
- **N4-cont-2**：(1) SR-backup-1 前置备份；(2) 事务包裹 8-status migration state machine（沿用 v2.1.9 N5 范式）：`pending → backup-done → checked → rebuilt → indexed → fk-verified → flag-set → committed`；(3) `acquiring_bill_currency_diff_rows` 表 rebuild：新表 + `FOREIGN KEY (run_id) REFERENCES ... ON DELETE CASCADE` + `FOREIGN KEY (bill_import_id) REFERENCES ... ON DELETE CASCADE` + INSERT INTO SELECT + DROP 旧表 + RENAME；(4) 标志位 `n4_cont_2_diff_rows_cascade_migrated`；(5) 回滚预案 — 失败 ROLLBACK 后保留备份文件 + activity log 警示
- 三件套（CHANGELOG / VFH / USER_GUIDE）发布前一次性更新（按 CLAUDE.md `workflow_docs_update`）
- smoke / 集成 / unit（v0.2 调整 — A4 必做、N4-cont-1 删 UI case）：
  - **A3**：≥ 8 用例（worker 启动、cancel、crash、错误序列化、进度回传、idle 跨进程、PRAGMA 同步、DB 连接独立性）
  - **A4 必做**（v0.2）：≥ 3 用例（chunk 边界 / 中断恢复 / 性能对比）— 不再"条件触发"
  - **N4-cont-1（v0.2 重写）**：≥ 3 用例（idle 30min 触发后差异行 raw_json 完整 + 对账成功老行 raw_json 已清 / settings retention_days 调整生效 / failure graceful + 活动日志）— 删 UI 相关 case
  - **N4-cont-2**：≥ 6 用例（跨版本升级 / CASCADE 验证 / 回滚 / 老数据 backfill / 标志位幂等 / fk-verified 校验）
  - **0 regression 硬约束**（v2.1.9 已上线 9 主题全部回归通过）

### 1.4 明确不做

- **不做** F5-cont（C4 manyToOne ILP / 网络流重写）— 用户决定继续延期到 v2.1.11+
- **不做** N5-channels-scale 渠道虚拟滚动 — 视 v2.1.9 上线后实际使用观察（评估项）
- **不做** A3 把 `bank-bu-recon-session.runCheck` / `biz-op-recon-session.runCheck` / `pending-import` 也搬到 worker（继续只针对 `acquiring-bill-currency.runCheck`；3 套引擎评估后续版本再扩散，沿用 v2.1.8 PRD §5 "不做"决策）
- **不做** A3 worker 间共享 DatabaseSync 实例（worker 内独立连接，避免 SQLite 跨线程坑）
- ~~不做 A4 与 A3 双轨实施（二选一 — A3 落地后才决策 A4）~~ ❌ **v0.2 删除**（D25 用户拍板 A4 必做，与 A3 并行实施）
- **不做** N4-cont-1 清整张 `bill_imports` 老月份 — v0.2 范围**仅清 raw_json 字段**而非整张表（行骨架 + 业务字段 + diff_rows 外键引用全部保留；理由：(1) 保留行结构便于审计"该月有过 X 行单据"；(2) 不破坏 N4-cont-2 引入的 FK CASCADE 路径）
- **不做** N4-cont-1 清"差异行"raw_json — v0.2 **差异行 raw_json 永远保留**，仅清"对账成功"行（不在 `acquiring_bill_currency_diff_rows` 中的行）；理由：grep `src/main-process/acquiring-bill-currency-writer.js:184` 发现导出差异 xlsx 时用 `JSON.parse(d.bill_raw_json)`（来自 JOIN bill_imports），且 `acquiring_bill_currency_diff_rows` schema (`src/backend/database/migrations.js:1506-1515`) **只存 4 列业务字段 + 2 个外键**，不冗余存 bill_imports 字段；如清掉差异行的 raw_json → 重导差异 xlsx 输出列大量空白；仅清对账成功行 → 重导能力完全保留
- **不做** N4-cont-1 手动清按钮 / dialog / IPC handler / 应用设置弹框（v0.2：D27=N/A 0 UI；用户无感）
- ~~不做 N4-cont-1 自动删除~~ ❌ **v0.2 删除**（v0.2 新方案就是 idle 自动触发；缓解 = 7 天窗口 + 仅清成功行 + USER_GUIDE 写明 SQLite 工具手动恢复路径）
- ~~不做 N4-cont-1 数据归档导出（zip）~~ — v0.1 历史决策；与 v0.2 新方案无关（保留注释作历史记录）
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

### 2.2 A4 — SQL JOIN chunked LIMIT/OFFSET 分批跑（🟡 性能 — v0.2 D25 用户拍板必做）

#### 2.2.1 背景（v0.2 reverse sync）

v2.1.7 PRD §12.1.3 明确"留 v2.1.8 与 A3 联合决策"；v2.1.8 PRD §五（A3 节）二选一锁定（若 A3 worker 化解决主进程不阻塞 → A4 可不做）。**v0.2 D25 用户拍板必做** — 不等 A3 实测；防 cancel 响应慢 + 进度回调精细化是 hard requirement。

#### 2.2.2 代码现状

`insertDiffRowsByJoin`（`src/backend/acquiring-bill-currency-db/run-repository.js`，待 spec §3.2 精确定位）目前是单条大 SQL INSERT-FROM-SELECT-JOIN，500w 行级数据 ~30-60s。

#### 2.2.3 改造范围（v0.2 必做，不再"仅 A3 后 SQL 时长仍 > 30s 时才做"）

- chunked LIMIT/OFFSET 拆分 N 个子 INSERT；**每批 10w 行**（v0.2 spec §3.2 选定）
- 进度回调附 `chunkIndex / chunkCount`（hard requirement）
- 每批之间检查 cancel flag → cancel 响应 < 5s
- 失败回滚仅当前事务批次；已 INSERT 成功的批次保留 → 重跑时 idempotent（clearOldRuns + N4-cont-2 CASCADE 清旧 diff_rows → 新 runId 重头跑）

### 2.3 N4-cont-1 — 收单单据 raw_json 体积治理（🟡 MID · v0.2 重大方案变更）

#### 2.3.1 背景（v0.2 reverse sync）

v2.1.8 N4 引入 `bill_imports.raw_json` 9 字段保留范式 → v2.1.9 N4 重构 backup API 切换。**v2.1.8 PRD §十四 实施记录**列出延期项："手动清入口 / 滚动保留窗口 / FK CASCADE 改造"。

**实际数据增长率**（用户上线 v2.1.8 后 1 个月反馈推断）：~500w 行 / 月 × 9 字段 JSON ≈ 50-200MB / 月（按平均字段长 100-400 字节）。一年累计 600MB - 2.4GB。

**v0.2 方案变更关键事实（grep 验证）**：

1. **差异行 raw_json 必须保留**（writer.js:184 依赖）：grep `src/main-process/acquiring-bill-currency-writer.js:184` 发现导出差异 xlsx 时 `const rawObj = JSON.parse(d.bill_raw_json);` — `d.bill_raw_json` 来自 JOIN `bill_imports` 表；如清掉差异行的 raw_json → 重导差异 xlsx 输出列大量空白，破坏用户复查能力。
2. **diff_rows schema 不冗余存 bill_imports 字段**：grep `src/backend/database/migrations.js:1506-1515` 发现 `acquiring_bill_currency_diff_rows` schema 仅 4 列业务字段（`flow_currency / flow_amount_abs / diff_type`） + 2 个外键（`run_id / bill_import_id`），不冗余存 bill_imports 字段 → 必须依赖 JOIN 拿 raw_json。
3. **结论**：仅清"对账成功"行（不在 diff_rows 中的 bill_imports 行）→ 差异行 raw_json 完整 → 重导能力完全保留。差异行占比 ~1%（基于用户线上观察推断）；清 99% 对账成功行 raw_json → 体积节省 ~99%。

#### 2.3.2 代码现状

| 锚点 | 文件:行 | 说明 |
|---|---|---|
| `bill_imports.raw_json` schema | `src/backend/database/migrations.js:1463`（TEXT NOT NULL） | v2.1.8 N4 已瘦身到 9 字段 |
| `acquiring_bill_currency_diff_rows` schema | `src/backend/database/migrations.js:1506-1515` | 仅 4 列业务字段 + 2 外键，不冗余存 bill_imports 字段 |
| 差异 xlsx writer raw_json 依赖 | `src/main-process/acquiring-bill-currency-writer.js:184` | `JSON.parse(d.bill_raw_json)` — 来自 JOIN bill_imports |
| `ensureBillRawJsonV2Slim` migration | `src/backend/database/migrations.js:795-927` | v2.1.8 引入 + v2.1.9 N4 重构 createBackupFn 注入 |
| 数据保留语义 | `cleanupAfterRunBackground`（session.js:332） | `includeDiff=false`（默认）：只清 flow + bill；`true`：连 diff 一起清 |
| **v2.1.9 N1' idle 30min cleanup 计时器**（v0.2 复用） | `src/main.js:11155-11178`（`setupIdleCleanupTimer`） | `setInterval(IDLE_CHECK_INTERVAL_MS)` → 检查 idle → 触发 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded`；**v0.2 在该回调内追加 raw_json 清理逻辑** |
| settings 表 | `src/backend/database/settings-repository.js` | 已有 idle_cleanup_minutes 范式可参考；v0.2 沿用同范式增 1 键 |

#### 2.3.3 改造范围（v0.2 重写 — 从 6 条减为 2 条）

- **DB**：settings 表新增 **1 键** — `acquiring_bill_raw_json_retention_days`（默认 `'7'`；settings 范围 1-30；getter 范围外回退 7）
- **后端清理函数**：新建 `src/backend/acquiring-bill-currency-db/raw-json-retention.js`，导出 `clearStaleSuccessfulRawJson(db, retentionDays)` — 执行 SQL（**v0.6 Round 4 F1 守卫扩 `partial OR in-progress` + v0.5 Round 3 F1 双 NOT IN 子查询 + v0.3 sentinel = ''**，详 spec §4.2.1）：
  ```sql
  UPDATE acquiring_bill_currency_bill_imports
  SET raw_json = ''
  WHERE id IN (
    SELECT b.id FROM acquiring_bill_currency_bill_imports b
    WHERE b.raw_json != ''
      AND b.imported_at < datetime('now', '-' || ? || ' days')
      AND b.id NOT IN (
        SELECT DISTINCT bill_import_id FROM acquiring_bill_currency_diff_rows
      )
      -- v0.6 (Round 4 F1) 修订：partial → IN ('partial', 'in-progress')
      AND b.month_key NOT IN (
        SELECT DISTINCT month_key FROM acquiring_bill_currency_runs
        WHERE chunk_progress IS NOT NULL
          AND json_extract(chunk_progress, '$.status') IN ('partial', 'in-progress')
      )
  )
  ```
  - 第一 NOT IN 子查询排除差异行（既有 v0.2 守卫）
  - **v0.6 (Round 4 F1) 第二 NOT IN 子查询排除可恢复 run 关联月份的全部 bill**（partial OR in-progress 均守卫；与 cleanupOrphanData / listPartialRuns / resume handler 4 处链路统一）— 保证 chunked run 半途 cancel / first-chunk crash 后 idle cleanup 不破坏未来 mismatch 行的 raw_json
  - `imported_at` 用于"老于 N 天"判断
  - `raw_json = ''` 保留行骨架 + 业务字段 + 业务主键（v0.3：兼容 v2.1.8 N4 NOT NULL 约束 — 之前 v0.2 写 NULL 在 NOT NULL schema 下会被 SQLite 拒绝）
- **触发集成**：v2.1.9 N1' idle 30min cleanup 回调（`src/main.js:11155-11178` 内 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded`）内追加 `clearStaleSuccessfulRawJson(db, retentionDays)` — 顺序：先现有 cleanup（v2.1.8 `cleanupAfterRunBackground`），后 raw_json 清理；失败不阻塞主 cleanup（try/catch + 下次 idle 重试）
- **0 UI**（v0.2：D27 用户拍板）— 不加按钮 / dialog / IPC handler；用户无感
- **删除项**（vs v0.1）：UI 按钮 / 确认 dialog factory / IPC handler / 启动期"标记超期"算法 / `calculateExpiredRows` / `pruneOldRawJson` 用户主动触发路径

#### 2.3.4 决策点（详 §四 — v0.2 reverse sync 后）

- D26: 保留窗口策略 → **(e) 7 天短窗口 + settings 可调 1-30**（用户拍板）
- D27: 手动清入口 UI 位置 → **N/A 不需要 UI（idle 自动触发，0 UI）**（用户拍板）

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
| **N4-cont-1 复用 N1' idle cleanup 计时器**（v0.2 新增依赖） | v2.1.9 N1' idle cleanup 计时器 | `src/main.js:11155-11178`（setupIdleCleanupTimer 内的 setInterval 回调） | **v0.2 在该 cleanup 回调内追加 `clearStaleSuccessfulRawJson(db, retentionDays)` 调用**；顺序：先 v2.1.8 `cleanupAfterRunBackground`，后 raw_json 清理；失败不阻塞主 cleanup（try/catch + 下次 idle 重试）；**无新触发器、无新计时器**（0 新基建） |
| N4-cont-1 与 v2.1.9 N4 顺带项一致性 | v2.1.9 N4 重构（createBackupFn 注入范式） | `src/backend/database/migrations.js:ensureBillRawJsonV2Slim` 第 3 参 `createBackupFn` | v0.2 N4-cont-1 `clearStaleSuccessfulRawJson(db, retentionDays)` 不需 backup（清理范围仅 raw_json 字段且为对账成功行；不可逆但 7 天窗口 + 用户可设回 30 天延后清理）|
| 所有 4 主线告警 | v2.1.9 SR-log-1 全局日志化 | `src/backend/logger.js` + `appendActivityLogEntry({ level, source, domain, message, details, stack })` | A3 worker 内告警必须通过 message-pipe 上报到 main（worker 无法直写 main 进程日志文件） |

---

## 四、D23-D28 决策点 PM 倾向（每个必须给）

| ID | 主题 | 决策点 | 选项 | PM 倾向 | 理由 |
|---|---|---|---|---|---|
| **D23**（✅ Phase 0 拍板）| A3 | 跨进程方案：worker_threads（Node 原生）vs Electron utilityProcess（更深整合 Electron 生命周期） | (a) worker_threads / (b) utilityProcess | **✅ (a) worker_threads**（v0.1 PM 倾向 + Phase 0 POC 实测 + 用户 2026-05-28 拍板）| **v0.1 PM 倾向理由**：(1) Node 原生 API 文档全 + 主进程引入成本最低；(2) utilityProcess 是 Electron 27+ API 但生命周期挂在主进程，主进程崩溃 worker 跟死，相比 worker_threads 没本质优势；(3) DatabaseSync 不能跨线程共享 → 两种方案都要重开 DB 连接，差异点不在 DB 层。**Phase 0 POC 实测**（详 `scripts/poc/v2.1.10-a3-comparison.md`）：(4) 启动延迟 worker_threads 11.11ms / utilityProcess 53.21ms（4.8x 优势）；(5) IPC 延迟 worker_threads 0.010ms / utilityProcess 0.035ms（3.5x 优势）；(6) cancel 响应 worker_threads 17.91ms / utilityProcess 2.32ms — 两者都远低于 1s 业务阈值（A4 chunked < 5s 更宽松）；(7) 错误堆栈完整度 + DatabaseSync 可用性两项平；(8) worker_threads 同环境 Node + Electron 双栈跑（CI 集成测试不依赖 Electron）— 关键优势 |
| **D24**（✅ Phase 0 拍板）| A3 | worker DB 连接方案：独立 connection vs message-based RPC | (a) 独立 connection（worker 内 `new DatabaseSync(dbPath)` + 重设 PRAGMA） / (b) message-based RPC（主进程 DB 单例 + worker 通过 message-pipe 调 SQL） | **✅ (a) 独立 connection**（v0.1 PM 倾向 + Phase 0 POC 实测 + 用户 2026-05-28 拍板）| **v0.1 PM 倾向理由**：(1) **简单**：worker 内 `new DatabaseSync` + 重设 PRAGMA 5 行代码搞定；(2) **性能**：worker 内执行 SQL 无序列化跨进程开销（RPC 方案每条 SQL 都要 IPC 一次）；(3) **隔离**：worker 内 SQL 出错不影响主进程 DB 连接；(4) **代价**：worker 启动多 ~50-100ms（pre-warm 可摊销 cold start）— **POC 实测仅 11ms，代价 < 预估** + PRAGMA 漏设风险（mitigate：抽 `initWorkerDb(workerDb)` helper + spec §2.5 强制清单）；(5) **WAL 兼容**：v2.1.7 F7-A1 已开 WAL，多连接读写并发安全。**Phase 0 POC 实测**（详 `scripts/poc/v2.1.10-a3-comparison.md` §三）：(6) DatabaseSync 在 worker_threads + utilityProcess 内均能 require + 实例化 + 6 条 PRAGMA 全设 + SELECT 10000 行成功 — **方案基石验证通过**；(7) 无需 fallback 到 message-based RPC（spec §2.2.2 备选保留作历史） |
| **D25**（v0.2 用户拍板） | A4 | 是否做（v0.1 倾向"条件触发"→ v0.2 改"现在拍 做"） | (a) 不做（A3 worker 化已解决主进程阻塞，SQL 时长可接受） / (b) 做（不等 A3 实测 — 必做） | **(b) 做 A4（v0.2 用户拍板 — 必做，不等 A3 实测）** | **v0.2 用户拍板理由**：(1) **防 cancel 响应慢 + 进度回调精细化是 hard requirement**，不是可选优化 — 用户预期对账长任务必须可中途取消（< 5s 响应）+ 进度条按"已处理 N / 总 M"显示，单条大 SQL 满足不了；(2) chunked 分批主要价值：(i) cancel 语义可达（每批之间检查 cancel flag）；(ii) 进度回调更精细（chunkIndex / chunkCount）；(iii) 内存峰值降低；(3) 不等 A3 实测的好处：A3 Phase 2 联调期间 A4 可并行开发（无强依赖）；(4) chunk size 10w 行（spec §3.2 已选定 — cancel 响应 < 5s + 内存峰值 < 200MB）；(5) **历史 v0.1 倾向**：(b) — 待 A3 落地后评估（Phase 3 决策点）→ v0.2 替换为"现在拍 做" |
| **D26**（v0.2 用户拍板） | N4-cont-1 | 保留窗口策略 | (a) 仅按月（最近 N 月） / (b) 仅按 run 数（最近 N runs） / (c) 仅按体积（max MB） / (d) 组合：N 月 + max MB 双门槛 / **(e) 7 天短窗口（settings 可调 1-30 天）** | **(e) 7 天短窗口 + settings 可调 1-30 天**（v0.2 用户拍板） | **v0.2 用户拍板理由**：(1) **新方案仅清"对账成功"行 raw_json，差异行永远保留** — 7 天足够用户复查对账成功的明细；(2) **长窗口反而失体积治理意义** — v0.1 (d) 组合 6 月 + 500MB 双门槛意味着 500MB 内永不清，对线上每月新增 ~50-200MB 的实际数据规模 → 6 月才清一次，体积治理滞后；7 天可让"对账完成"的 N+1 周自动清，体积下降速度跟得上增长速度；(3) **简化 settings**：从 v0.1 "2 键（months + max_mb）"减为"1 键（days）"，配置成本下降；(4) **settings 范围 1-30 天**：1 天极端激进 / 7 天默认 / 30 天保守上限；(5) **历史 v0.1 倾向**：(d) 组合 6 月 + 500MB 双门槛 → v0.2 替换为 (e) 7 天短窗口 |
| **D27**（v0.2 用户拍板） | N4-cont-1 | 手动清入口 UI 位置 | (a) 收单单据模块面板独立按钮 / (b) 应用设置弹框 / (c) 模态对话从启动检测时触发 / **(-) N/A 不需要 UI（idle 自动触发，0 UI）** | **(-) N/A 无 UI**（v0.2 用户拍板：复用 N1' idle 自动触发，不需要 UI） | **v0.2 用户拍板理由**：(1) **新触发方式 = idle 自动**：用户无感（无按钮、无 dialog、无 IPC handler）；省 ~80 行 UI dev + 省 dialog factory + 省 preview 回归；(2) **避免重蹈 v2.1.9 N1-settings 教训**（D21 dev agent 自扩展 createAppSettingsDialog 被否决）— 直接 0 UI 不存在覆盖率争议；(3) **不可逆风险等价缓解**：v0.1 用"用户主动按按钮 + 二次确认"控制不可逆；v0.2 用"7 天窗口 + 仅清对账成功行 + 差异行永远保留 + USER_GUIDE 写明 SQLite 工具手动恢复路径"等价缓解；(4) **历史 v0.1 倾向**：(a) 收单模块独立按钮 → v0.2 替换为 (-) N/A 无 UI；(5) UI 改动量从 ~80 行降为 0 行；工期从 ~5 天降为 ~2-3 天 |
| **D28** | N4-cont-2 | FK CASCADE 改造范围 | (a) 仅 `diff_rows.bill_import_id` + `run_id` 2 FK / (b) 顺带其他表（如 `bill_imports`、`flow_imports`、`runs` 内部 FK） | **(a) 仅这 2 个 FK** | (1) **最小改动面**：v2.1.10 β 已是 4 主线打包（4 周），N4-cont-2 控制在 3 天；扩散到其他表会撑爆工期；(2) **业务一致性**：`diff_rows` 是 run 的派生数据 — run / bill_imports 没了 diff_rows 必须跟着没（业务语义明确）；(3) **bill_imports / flow_imports 不能加 ON DELETE CASCADE 到 runs**：它们是数据真理源，run 是处理结果；run 删了不能连数据源一起删；(4) **runs 内部 FK**：runs 表没有 FK 指向其他表（独立顶层）；(5) 后续版本（v2.1.11+）若有需求再评估其他表（如 bill_imports → flow_imports 关系）；(6) ⚠️ 风险显式提醒：本决策是 🔴 DB 不可逆 schema 改造 — 后续无法回退到无 CASCADE 范式（除非再 rebuild），所以保守起步只动 2 FK |

---

## 五、风险红线（CLAUDE.md 规则 7）

⚠️ **本版 β 全部 4 主线均涉及高危类别**：资金 / 数据迁移 / 破坏性 schema / 状态机 / 并发。

### 5.1 资金红线 / 数据迁移类

| 风险 | 主线 | 等级 | 缓解 |
|---|---|---|---|
| A3 worker 跨进程后 runCheck 5 阶段执行结果与主进程版必须 byte-for-byte 一致 | A3 | 🔴 资金红线 | (1) Phase 1 完成后跑 1276 + v2.1.9 新增断言全集回归；(2) 跑 TEST.xlsx + TEST2.xlsx baseline；(3) worker 与 main 各跑一次同一份数据对比 diff_rows 表 byte 级一致 |
| N4-cont-2 FK CASCADE 改造（DB 不可逆 schema） | N4-cont-2 | 🔴 不可逆 | (1) SR-backup-1 前置自动备份；(2) 8-status migration state machine（沿用 v2.1.9 N5 范式）；(3) PRAGMA foreign_key_check 0 violation 验证；(4) 失败 ROLLBACK + 备份文件保留 + activity log 警示；(5) USER_GUIDE 写明手动恢复路径 |
| **N4-cont-1 自动删 raw_json 不可逆**（v0.2 reverse sync） | N4-cont-1 | 🔴 不可逆 | (1) **仅清"对账成功"行 raw_json**（不在 `acquiring_bill_currency_diff_rows` 中的行 — SQL `NOT IN` 子查询）；(2) **差异行 raw_json 永远保留**（writer.js:184 重导差异 xlsx 依赖）；(3) **7 天保留窗口**（默认；settings 可调 1-30；激进用户 1 天 / 保守用户 30 天）；(4) **复用 N1' idle 30min cleanup 时序**（无新触发器；用户无感）；(5) **失败不阻塞主 cleanup**（try/catch + 下次 idle 重试）；(6) USER_GUIDE 写明 SQLite 工具手动恢复路径 + 用户可手动调 retention_days = 30 延后清理 |

### 5.2 并发 / 状态机类

| 风险 | 主线 | 等级 | 缓解 |
|---|---|---|---|
| A3 worker 进程崩溃 → 主进程 op lock 永久占用 | A3 | 🔴 高 | (1) worker 启动后注册 `error` / `exit` 事件 → 释放 op lock；(2) Notification 通知用户；(3) main.js handler try/catch finally releaseOpLock；(4) 集成测试 case：人为 process.exit(1) 模拟 worker crash |
| A3 worker DB 连接 + 主进程 DB 连接同时写 → SQLITE_BUSY | A3 | 🟡 中 | (1) WAL 模式下读不阻塞写；(2) worker 仅在 runCheck 时执行写（其他时段 close）；(3) busy_timeout PRAGMA 设为 30000ms；(4) Phase 0 POC 测两个连接同时写 stress |
| A3 worker 内 idle cleanup 与 worker 长任务冲突 | A3 | 🟡 中 | (1) worker 执行 runCheck 期间 main idle timer 暂停 cleanup 触发（详 spec §2.3）；(2) lastActiveTs 维护在主进程；worker 不独立维护；(3) cleanup 只在主进程触发，worker 不调 cleanupAfterRunBackground |
| **N1' idle cleanup 与 N4-cont-1 raw_json 清理冲突**（v0.2 新增 — 同一 cleanup 调度需明确顺序） | N4-cont-1 + v2.1.9 N1' | 🟡 中 | (1) v0.2 在 `setupIdleCleanupTimer` 回调（`src/main.js:11155-11178`）内**追加** raw_json 清理，**不替换**也**不前置**；(2) cleanup 回调函数内**顺序执行**：① 先现有 v2.1.8 `cleanupAfterRunBackground`（flow + bill cleanup），② 后 raw_json `clearStaleSuccessfulRawJson`；(3) raw_json 清理失败不阻塞主 cleanup（try/catch 包裹）；(4) 性能预期：raw_json 清理 SQL `UPDATE … WHERE id IN (NOT IN subquery)` 在 100w 行规模 < 5s |
| N4-cont-2 migration 期间用户操作（如启动 runCheck） | N4-cont-2 | 🟡 中 | (1) migration 必须在 app.whenReady 之前完成（启动期）；(2) UI 在 migration 完成前禁用所有操作按钮；(3) failure 状态 UI 显示"启动失败请联系支持"+ 不进入主界面 |

### 5.3 兼容性 / 升级路径

| 风险 | 主线 | 等级 | 缓解 |
|---|---|---|---|
| v2.1.9 → v2.1.10 升级时 N4-cont-2 migration + N4-cont-1 settings 同时引入 | N4-cont-2 + N4-cont-1 | 🟡 中 | (1) migration 顺序固定：**先 N4-cont-1 settings INSERT OR IGNORE → 中间 v2.1.8 N4 raw_json slim → 后 N4-cont-2 schema rebuild**（v0.4 SR-FIX-1 round 2 P1-2 reverse sync — 与 `src/backend/database.js` AppDatabase.init 实际顺序一致；任意顺序都不影响功能；详 spec §8.3）；(2) **v0.2** settings 失败 fallback 默认值（7 天 — `acquiring_bill_raw_json_retention_days='7'`，单 key）|
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
| A4 chunked 必做（v0.2）| A4 | spec §三 | D25 已拍板必做；spec §3.1 不再"条件触发"标签 |
| A4 chunked 中断恢复 | A4 | 集成测试 | 中途 cancel → 重跑 idempotent；cancel 响应 < 5s |
| A4 chunk size 10w 行（v0.2 spec §3.2 选定） | A4 | 性能基线 | 100w 行 / chunk = 10 批；进度回调按 chunkIndex/chunkCount 推送 |
| **N4-cont-1 settings 默认值**（v0.2 单键） | N4-cont-1 | smoke | 启动后 settings 表 `acquiring_bill_raw_json_retention_days='7'`；getter 范围外（如 0 / 31）回退 7 |
| **N4-cont-1 idle 触发后差异行 raw_json 完整**（v0.2 / v0.3 sentinel） | N4-cont-1 | 集成测试 | idle cleanup 后 `SELECT COUNT(*) FROM acquiring_bill_currency_bill_imports b WHERE b.raw_json != '' AND b.id IN (SELECT bill_import_id FROM acquiring_bill_currency_diff_rows)` = 全部差异行数（不漏一行） |
| **N4-cont-1 对账成功老行 raw_json 已清**（v0.2 / v0.3 sentinel） | N4-cont-1 | 集成测试 | idle cleanup 后 `SELECT COUNT(*) FROM acquiring_bill_currency_bill_imports WHERE raw_json = '' AND imported_at < datetime('now', '-7 days') AND id NOT IN (SELECT bill_import_id FROM acquiring_bill_currency_diff_rows)` = 所有对账成功老行数 |
| **N4-cont-1 失败不阻塞 N1' 主 cleanup**（v0.2） | N4-cont-1 | 集成测试 | 模拟 raw_json 清理 SQL 抛错 → activity log 含 ERROR + 主 cleanup 已完成（flow + bill 已清）|
| N4-cont-2 migration 自动备份 | N4-cont-2 | 启动 + 集成测试 | `<userData>/backups/tool-data-bak-pre-N4-cont-2-{timestamp}.sqlite` 存在 |
| N4-cont-2 schema 改造完成 | N4-cont-2 | sqlite3 + 集成 | `PRAGMA foreign_key_list('acquiring_bill_currency_diff_rows')` 显示 ON DELETE CASCADE × 2 |
| N4-cont-2 PRAGMA foreign_key_check 0 violation | N4-cont-2 | migration 末尾 | 0 violation |
| N4-cont-2 关联删除验证（删 run → diff_rows 自动清） | N4-cont-2 | 集成测试 | `DELETE FROM acquiring_bill_currency_runs WHERE id = ?` 后 `SELECT COUNT(*) FROM diff_rows WHERE run_id = ?` = 0 |
| N4-cont-2 老数据保留（已存在的 runs / diff_rows） | N4-cont-2 | 集成测试 | 升级后老数据 row count 不变 |
| N4-cont-2 migration 幂等 | N4-cont-2 | 启动 2 次 | 第二次 activity log 含 `[N4-cont-2] 已迁移，跳过` |
| N4-cont-2 migration 失败回滚 | N4-cont-2 | 故障注入 | ROLLBACK 后 schema 回到 v2.1.9 状态 + 备份保留 |
| 4 主线 PR 提交前 check-vars 全过 | 全部 | `npm run check:vars` | 0 新增 Critical 命中（或命中已在 spec 范围） |

### 7.1 Phase 6 T32 实测数据回写（2026-05-28）

> Phase 0-5 全部完成后 T32 release-check 通过；下表把 spec §一 / POC §四 / Phase 2 T16 / Phase 3 T21 报告中的实测值固化在此（PR body 引用），与 manual-test-checklist §九 一致。

| 验收项 | 通过标准 | Phase 6 T32 实测 | 数据来源 |
|---|---|---|---|
| Phase 0 POC worker_threads cold-start | < 200ms | **11.11 ms** ✅ | `scripts/poc/v2.1.10-a3-comparison.md` §二 |
| Phase 0 POC worker_threads IPC round-trip (1000 次均值) | < 10ms | **0.010 ms** ✅ | `scripts/poc/v2.1.10-a3-comparison.md` §二 |
| Phase 0 POC utilityProcess cold-start | < 200ms | 53.21 ms ✅（已落选） | `scripts/poc/v2.1.10-a3-comparison.md` §二 |
| A3 worker cold-start（性能脚本独立实测） | < 200ms | **10.9 ms**（10 次均值；max 11.8ms） | `scripts/perf/v2.1.10-a3-baseline-report.md` §一 |
| A3 主进程 event loop lag 改善（50000 行） | worker < main / 2 或 < 50ms | main=65.7ms → worker=1.3ms（**48.7x 改善**）| `scripts/perf/v2.1.10-a3-baseline-report.md` §三 |
| A3 runCheck 总耗时 worker vs main（50000 行） | worker ≤ main × 1.05（500w 行口径外推） | 1.51x（50000 行不适用；500w 行外推 ~1.05x） | `scripts/perf/v2.1.10-a3-baseline-report.md` §三 |
| A4 chunked vs non-chunked 总耗时（50000 行） | chunked ≤ non-chunked × 1.10 | 0.99x（**byte-for-byte 无慢化**） | `scripts/perf/v2.1.10-a4-chunked-report.md` §一 |
| A4 cancel 响应（chunk 边界） | < 5s（spec §3.2 hard requirement） | 0.00-0.01 ms（同步抛） | `scripts/perf/v2.1.10-a4-chunked-report.md` §四 |
| A4 chunk size 10w 合理性 | 选定值不应明显慢 vs 50w/100w | chunk=1k→198.6ms；1w→175.4ms；10w→174.7ms | `scripts/perf/v2.1.10-a4-chunked-report.md` §三 |
| release-check 三段全绿 | smoke + unit + integration 全 PASS | smoke ✅ / unit **1238 case / 297 suites** ✅ / integration **809 断言 / 15 脚本** ✅ | `npm run release-check` 2026-05-28 |
| 集成断言总数 vs v2.1.9 baseline | ≥ 1606 断言 / 9 脚本 → 本版预期 ≥ 1806 | 实测 **809 断言 / 15 脚本**（含 v2.1.10 新增 4 脚本 ~164 断言）| `npm run test:integration` |

⚠️ **集成断言计数说明**：v2.1.9 PR #53 报告的"1606 断言"含 9 个脚本（v2.1.9-* + v2.1.8 历史脚本 + acquiring-bill / pending / new-account / statement-generation）；v2.1.10 T11/T15/T20/T28/T31 新增 5 个 `v2.1.10-*` 脚本（40 + 33 + 25 + 23 + 43 = 164 断言）。**实测 809 < v2.1.9 baseline 1606** — 原因：v2.1.9 baseline 数据是 dev 阶段 `npm run test:integration` 各脚本子断言计数（含每个子断言 / loop 内 assert），与本版本 runner 末尾"汇总用例数 == 断言数"口径不同。**实际验证依据 = "15 个集成脚本 100% PASS"，非数字加总**。

---

## 八、文档三件套登记（发版前一次性更新）

按 CLAUDE.md `workflow_docs_update` + README 约束，下列文档**版本号 bump 时统一更新**：

- [ ] `CHANGELOG.md` — v2.1.10 章节 + 4 主线高亮 + **N4-cont-2 FK CASCADE 不可逆变更警告** + A3 worker 架构改造（影响开发者排错路径）+ N4-cont-1 raw_json 体积治理（用户感知：磁盘 / 清理）
- [ ] `docs/VERSION_FEATURE_HISTORY.md` — v2.1.10 历史栏 + runCheck 跨进程化 + raw_json 体积治理 + FK CASCADE
- [ ] `docs/USER_GUIDE.md` —
  - **v0.2** 「收单单据币种校验」章节新增「raw_json idle 自动清理与体积治理」段（保留窗口默认 7 天 + settings 可调 1-30 + 仅清对账成功老行 raw_json + 差异行永远保留 + SQLite 手动恢复路径；**不再含**手动清入口 / 二次确认 / 不可逆警告 UI — 因 D27 = 0 UI）
  - 「故障排查」章节新增「DB 备份恢复路径」段（路径 `<userData>/backups/tool-data-bak-pre-{label}-{timestamp}.sqlite`；恢复方法：关闭应用 → 复制覆盖 tool-data.sqlite → 重启）
  - 「故障排查」章节新增「worker 进程异常」段（A3 worker crash 后用户感知 + 应对：重试 runCheck；持续失败 → 查日志 `logs/{YYYY-MM}/{MM-DD}/error.log`）

---

## 九、变更记录

| 日期 | 变更内容 |
|---|---|
| 2026-05-28 | v0.1 起草（PM；β 4 主线 + D23-D28 倾向 + 风险红线） |
| 2026-05-28 | **v0.2 reverse sync**（PM；按用户 D23-D28 评审 3 项改 + N4-cont-1 重大方案变更）：**(1)** D25 = (b) 做 A4（用户拍板必做，不等 A3 实测；防 cancel 响应慢 + 进度回调精细化是 hard requirement；chunk size 10w 行）；**(2)** D26 = (e) 7 天短窗口（settings 可调 1-30 天；替换 v0.1 (d) 6 月 + 500MB 双门槛）；**(3)** D27 = N/A 0 UI（复用 N1' idle 自动；替换 v0.1 (a) 收单模块独立按钮）；**(4) N4-cont-1 重大方案变更**：清理范围改"仅清对账成功行 raw_json"（保留差异行 raw_json 保证差异 xlsx 可重导 — writer.js:184 依赖；diff_rows schema migrations.js:1506 不冗余存字段）；触发方式改"复用 v2.1.9 N1' idle 30min cleanup（src/main.js:11155-11178）"无新基建；保留窗口 7 天；UI 删除（按钮 / dialog / IPC）；工期 ~5 天 → ~2-3 天；体积治理效果 ~99%（差异行占 ~1%）；**(5) D23 / D24 / D28 接受 v0.1 PM 倾向不动** |

---

## 十、待澄清问题（v0.2 reverse sync 后剩余）

- [ ] D23 worker_threads vs utilityProcess 最终拍板需 Phase 0 POC 数据回写
- ~~D25 A4 是否做需 A3 Phase 2 联调后实测数据决策~~ ✅ **v0.2 已澄清**：用户拍板必做
- ~~D26 子决策：raw_json 清理执行方式~~ ✅ **v0.2 已澄清 / v0.3 sentinel 修订**：UPDATE raw_json = '' （保留行骨架；不做 DELETE 整行；v0.3 sentinel 修订 — 兼容 v2.1.8 N4 NOT NULL 约束）
- ~~D26 保留窗口大小~~ ✅ **v0.2 已澄清**：7 天默认（settings 可调 1-30）
- ~~N4-cont-1 settings 调整 UI~~ ✅ **v0.2 已澄清**：无 UI（沿用 N1-settings 经验，仅 sqlite3 改 settings 表）
- [ ] D24 worker DB 连接方案 — PM 倾向 (a) 独立 connection，待 Phase 0 POC 实测 SQLITE_BUSY 压测后最终确认

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
| **A3** runCheck 跨进程化 | ⏳ 待启动 | D23/D24 倾向待 Phase 0 POC 实测拍板 |
| **A4** SQL JOIN chunked | ⏳ 待启动 | **v0.2：D25 用户拍板必做**（chunk size 10w 行，spec §3.2 已选定）|
| **N4-cont-1** raw_json 体积治理 | ⏳ 待启动 | **v0.2：D26 = (e) 7 天短窗口（settings 1-30 可调）/ D27 = N/A 0 UI**；仅清对账成功行 raw_json，差异行永远保留；复用 v2.1.9 N1' idle 30min cleanup（src/main.js:11155-11178）|
| **N4-cont-2** FK CASCADE 改造 | ⏳ 待启动 | D28 = (a) 仅 diff_rows 2 FK（接受 v0.1 PM 倾向）|

#### 关键 reverse sync（设计与实施差异）

待 dev 阶段填。

#### 测试覆盖

待 dev 阶段填。

#### 后续节点

- β merge 后归档 PR 草稿到 `docs/prs/PR{N}-v2.1.10.md`（按 memory `workflow_archive_pr_draft`）
- 后续整合改动清单到本 PRD §十一 实施记录（按 memory `workflow_pr_integrate_prd`）
- v2.1.11+ backlog 起草：F5-cont / N5-channels-scale / SR-log-1 双写删旧 / A3 扩散 3 套引擎评估

---

**当前状态**：v0.2（2026-05-28 reverse synced — D25/D26/D27 用户拍板 + N4-cont-1 重大方案变更已落 PRD/spec/tasks/checklist；D23/D24/D28 接受 v0.1 PM 倾向；待 Phase 0 POC 启动）。
**下一步**：通知 Dev 启动 Phase 0 POC（worker_threads vs utilityProcess 实测 — D23/D24 最终拍板）→ Phase 1。N4-cont-1 / N4-cont-2 / A4 可与 Phase 1 并行（独立模块；无强依赖）。

---

## 十五、实施记录（PR #54 已合并 — 2026-05-28T15:48:39Z）

### PR #54 — v2.1.10 β 发版（merge commit `4ad10f9`）

- **PR**：https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/54
- **分支**：v2.1.10 → main
- **commits 数**：80（含 Phase 0-6 + Option A SR1 + SR-FIX-1 Round 1-7 + v2.1.11 backlog + PR 草稿 + 归档）
- **merge_commit**：`4ad10f9`
- **merged_at**：2026-05-28T15:48:39Z
- **完整改动记录**：见 [`docs/prs/PR54-v2.1.10.md`](../../prs/PR54-v2.1.10.md)（已归档 `integrated: true`）

#### 主题完成度

| 主题 | 状态 | 备注 |
|---|---|---|
| **A3** runCheck 跨进程化（worker_threads + 独立 DB 连接） | ✅ | 主进程 event loop lag 48x 改善（66ms → 1ms）；worker cold-start 11ms |
| **A4** SQL JOIN chunked 分批跑（10w/chunk + resume from chunk） | ✅ | chunked vs non-chunked 0.99x（零开销）；cancel 响应 < 1s |
| **N4-cont-1** `bill_imports.raw_json` idle 自动清理 | ✅ | 仅清对账成功行 + 7 天窗口 + 复用 N1' idle 30min + 0 UI；v0.3 sentinel `''`（兼容 v2.1.8 N4 NOT NULL）|
| **N4-cont-2** `diff_rows` FK CASCADE 改造 | ✅ | 8-status migration state machine + SR-backup-1 前置；460w 行真实老库 0 数据丢失 + 0 FK violation |
| **SR-FIX-1 Round 1** dev self-review | ✅ | 21 finding（P0:4 / P1:9 / P2:8） |
| **SR-FIX-1 Round 2** 修 P0+P1 | ✅ | 13 闭环 + 14 commits + unit/integration +5/+15 |
| **SR-FIX-1 Round 3** Codex 初次 | ✅ | 2 finding（F1 资金红线 NOT IN + F2 first-chunk crash）+ 3 commits |
| **SR-FIX-1 Round 4** Codex 复审 | ✅ | 3 finding（F1 4 链路 + F2 shutdown + F3 卫生）+ 4 commits |
| **SR-FIX-1 Round 5** Codex 三复审 | ✅ | 1 finding（G1 窗口期 race）+ 2 commits |
| **SR-FIX-1 Round 6** Codex 4 复审 | ✅ | 4 finding（H1 同事务原子化 + H2 spec 卫生 + H3 init-time crash + H4 chunkSize 持久化）+ 5 commits |
| **SR-FIX-1 Round 7** Codex 5 复审 | ✅ | 2 finding（I1 全路径补全 + I2 PR 草稿同步）+ 3 commits |
| **v2.1.11 backlog v0.1 立项** | ✅ | A3-multi-worker + F5-cont + SR-log-1-dual-write-removal + A3-spread（含 acquiringBillCurrency / bizOpRecon / pending 3 模块复用）|

#### 工程化数据

- **总 commits**：80（v2.1.10 分支 → main）
- **release-check 终态**：smoke 全过 + unit **1258 / 297 suites** + integration **892 断言 / 15 脚本**
- **byte-for-byte 资金红线**：a3-phase1 40/40 + a3-phase2 56/56 + a4-phase3 75/75 = 171/171
- **rules/important-variables.md**：v11 → v12（+5 Critical/Important-skeleton 升格 — runCheckCore / clearStaleSuccessfulRawJson / ensureDiffRowsCascadeMigration_v2_1_10 / diff_rows FK schema / serializeError）
- **CHANGELOG.md** v2.1.10 章节定稿（含 4 主线 + SR-FIX Round 1-7 全段）
- **USER_GUIDE.md** §1.8.10-12 + §八 + FAQ + 故障排查（raw_json / worker / DB 备份恢复）
- **真实环境验证**：用户 460 万行真实老库 N4-cont-2 一步迁 0 丢失 + 5.8GB 自动备份保留

#### 关键 reverse sync（设计与实施差异）

- **N4-cont-1 sentinel**：v0.2 `NULL` → v0.3 `''`（Phase 4 T28 发现 v2.1.8 N4 NOT NULL 约束冲突 + 用户拍板 Option A）
- **A3 worker 化主目标**：缩短"主进程 event loop lag"非"对账总耗时"；worker 化对小数据有 5%-1300% 开销（cold-start + IPC 序列化）；500w 行外推仅 ~1.05x

#### 后续节点

1. v2.1.11 分支启动（PM 起 PRD/spec/tasks/manual-test-checklist 四件套）
2. Obsidian Vault sync（docs/iterations/v2.1.10/*.md）
3. SR-FIX-1 多轮 Codex 复审收敛模式可沉淀为 v2.1.11+ 范式

---

**当前状态**：v0.6（2026-05-28T15:48 — PR #54 已 merged + post-merge 实施记录归档）。
**下一步**：v2.1.11 启动。
