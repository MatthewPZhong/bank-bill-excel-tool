# 任务拆分 — v2.1.10 β 迭代

| 字段 | 值 |
|---|---|
| 文档版本 | v0.2（2026-05-28 reverse sync — A4 必做 / N4-cont-1 重大方案变更 / N4-cont-1 task 范围更新） |
| 关联 PRD | `PRD-v2.1.10.md` v0.2 |
| 关联 spec | `spec.md` v0.2 |
| 起草人 | PM |
| 状态 | v0.2 reverse synced（A4 改"必做"工期 ~3-4 天 / N4-cont-1 工期 ~5 天 → ~2-3 天；T17 删除决策点；T22-T28 重写）|

---

## 一、任务总览（β 范围）

按 Phase 拆分，**每 Phase 独立可验收**；Phase 0 强制前置（worker 架构选型 POC），其他 Phase 之间存在依赖（详 §二依赖图）。

| Phase | 标题 | 范围 | 工期预估 | 主线 |
|---|---|---|---|---|
| **Phase 0** | D23 POC（worker_threads vs utilityProcess 实测）| 4 项实测目标 + Dev 调研报告回写 spec/backlog | ~2-3 天 | A3 |
| **Phase 1** | A3 worker 框架 + DB 连接 + 错误序列化 | worker 入口 + worker pool + serializeError + PRAGMA 同步 | ~5-7 天 | A3 |
| **Phase 2** | A3 N1' idle cleanup 跨进程对接 + 联调 | idle timer 协调 + cancel / crash recover + 性能基线 | ~3-5 天 | A3 |
| **Phase 3**（v0.2 改"实施"）| A4 chunked 实施（D25 已拍板必做，不再决策点）| chunked 拆分 + 10w chunk size + idempotent + 性能基线 | ~3-4 天（v0.2 必做）| A4 |
| **Phase 4**（v0.2 重写）| N4-cont-1 raw_json 体积治理（独立可并行）| settings 单键 + clearStaleSuccessfulRawJson 函数 + 集成到 N1' idle cleanup 回调（无 UI / 无 IPC）| ~2-3 天（v0.2 从 ~4-5 天下降）| N4-cont-1 |
| **Phase 5** | N4-cont-2 FK CASCADE（复用 SR-backup-1 backup）| migration + 8-status state machine + 回滚预案 | ~3 天 | N4-cont-2 |
| **Phase 6** | 集成测试 + USER_GUIDE + CHANGELOG + 三件套 | 集成 ~29-31 case / unit ~54 case / 文档三件套 / preview 回归（v0.2 删 N4-cont-1 UI 回归）| ~3-5 天 | 全部 |
| **SR-FIX** | self-review 修复预留位 | PR 提交后 self-review 发现的 finding 修复 | ~1-3 天（视发现量）| 全部 |

**β 合计**：~ 3.5 周（v0.2 reverse sync — N4-cont-1 工期下降 + A4 工期上升 ≈ 相抵；PM 上限估算）

---

## 二、Phase 间依赖图

```
Phase 0 (POC) ──────────────────────────────────► 必须先于 Phase 1
                                                            │
                                          ┌─────────────────┴─────────────────┐
                                          ▼                                   ▼
Phase 1 (A3 worker 框架) ────► Phase 2 (A3 + idle 联调) ────► Phase 3 (A4 决策)
                                          │
                                          ├──────► Phase 4 (N4-cont-1) ──┐
                                          │       （独立可并行 Phase 0 之后开始）│
                                          │                              ▼
                                          ├──────► Phase 5 (N4-cont-2) ──┤
                                          │       （独立可并行；与 N4-cont-1 同收单模块，建议合一 commit 节奏）
                                          │                              ▼
                                          └──────► Phase 6 (集成+文档+回归) + SR-FIX
```

**关键约束**：
1. Phase 0 必须先完成（POC 决定 D23 / D24 实施细节）
2. Phase 1-2 必须连续（A3 框架 + idle 联调一体）
3. Phase 4 / Phase 5 与 Phase 1-3 可并行（不同模块，独立可启动）
4. Phase 6 / SR-FIX 必须在所有功能 Phase 完成后

---

## 三、Phase 0 — D23 POC（worker_threads vs utilityProcess 实测）

> **强制前置**：本 Phase 不完成不能启动 Phase 1（架构选型未拍板）。

### T01 — 建立 v2.1.10 工作分支
- **状态**：✅ 已完成（建分支时 `package.json.version = 2.1.10-beta.1`）
- **验证**：`git branch` 显示 `v2.1.10` 当前分支 + `cat package.json | grep version` = `2.1.10-beta.1`

### T02 — 基线 scan:vars + check:vars
- **目的**：建立 v2.1.10 起点重要变量命中基线
- **动作**：`npm run scan:vars` + `npm run check:vars`
- **产出**：保留输出报告，对比 spec §九 重要变量预测
- **验证**：报告生成 + 0 报错

### T03 — POC 脚本编写（worker_threads 路径）
- **位置**：`scripts/poc/v2.1.10-a3-worker-threads.js`
- **内容**：
  - 最小可执行 worker，内部 `new DatabaseSync(dbPath)` + 设 6 条 PRAGMA + 执行 1 条 SELECT
  - 主进程 perf.now() 测启动延迟 + 1000 次 message round-trip 测 IPC 延迟 + 人为 throw 测 stack + 5s sleep + 1s 时 cancel 测 cancel 延迟
- **验证**：脚本可独立 `node scripts/poc/v2.1.10-a3-worker-threads.js` 跑通 + 4 项指标输出

### T04 — POC 脚本编写（utilityProcess 路径）
- **位置**：`scripts/poc/v2.1.10-a3-utility-process.js`
- **内容**：同 T03，换成 Electron utilityProcess API
- **注意**：utilityProcess 必须在 Electron 主进程内启动（不能独立 `node` 跑）— 写成 `npm run start:poc:utility-process` 的形式
- **验证**：脚本可启动 + 4 项指标输出

### T05 — POC 报告 + spec/backlog 回写
- **位置**：`scripts/poc/v2.1.10-a3-comparison.md`
- **内容**：4 项指标对比表 + 推荐架构 + 风险列表
- **回写**：spec §2.6 实测列 + backlog D23 拍板（worker_threads / utilityProcess）+ 决策理由
- **验证**：spec.md / backlog.md 已更新；Dev 通知 PM / team-lead 审议
- **跟主线映射**：A3 (前置)

---

## 四、Phase 1 — A3 worker 框架 + DB 连接 + 错误序列化

> 依赖：Phase 0 已完成 + D23 拍板

### T06 — worker 入口脚本
- **位置**：`src/main-process/run-check-worker.js`（新建，~250 行）
- **内容**：
  - parentPort.on('message', ...) 处理 init / run-check / cancel / close
  - `initWorkerDb(dbPath)` helper（含 6 条 PRAGMA 强制清单 — spec §2.5）
  - `runCheckInWorker(workerDb, payload)` — 调用 session.runCheck 等价逻辑
  - PRAGMA verify 步骤（spec §2.5.2）
- **验证**：unit test `tests/unit/main-process/run-check-worker.test.js` 12 case 全绿
- **跟主线映射**：A3-1 / A3-2

### T07 — worker pool 管理
- **位置**：`src/main-process/run-check-worker-pool.js`（新建，~150 行）
- **内容**：
  - `preWarm({ workerScript, dbPath })`
  - `dispatchRunCheck(payload)` — 返回 Promise（解 done / 拒 error）
  - `isBusy()` — 用于 idle timer 协调（spec §2.3.2）
  - `cancel()` / `terminate()`
  - worker error / exit 事件处理 → 释放 op lock + Notification
- **验证**：unit test `tests/unit/main-process/run-check-worker-pool.test.js` 10 case 全绿
- **跟主线映射**：A3-1 / A3-7

### T08 — 错误序列化工具
- **位置**：`src/main-process/worker-error-utils.js`（新建，~80 行）
- **内容**：spec §2.4 完整 serializeError / deserializeError 实现
- **验证**：unit test `tests/unit/main-process/worker-error-utils.test.js` 8 case（含 FileValidationError 专属字段 + cause 链）
- **跟主线映射**：A3-3

### T09 — session.runCheck 提取 worker 可执行部分
- **位置**：`src/main-process/acquiring-bill-currency-session.js`
- **内容**：
  - 提取 `runCheck` 内 DB / 算法部分到独立函数（如 `runCheckCore(workerDb, monthKey, storageRoot)`）
  - 原 `runCheck` 改为 facade（兼容老调用方）
- **验证**：smoke 0 regression + unit 既有 case 全过
- **跟主线映射**：A3-1

### T10 — IPC handler 接 workerPool
- **位置**：`src/main.js:10758-10785`
- **内容**：
  - `acquiringBillCurrency:run` handler 改为 `await runCheckWorkerPool.dispatchRunCheck(...)`
  - onProgress 改为 worker pool 内部 forward
  - 保留 notifyResult / releaseOpLock 路径
- **验证**：smoke 全过 + 手测 runCheck 正常返回
- **跟主线映射**：A3-4

### T11 — Phase 1 集成测试
- **位置**：`scripts/integration/acquiring-bill-currency-worker.js`（新建）
- **内容**：
  - worker 启动 / pre-warm / cold-start delay
  - PRAGMA verify
  - DB 连接独立性（worker 内 SELECT 不影响主进程）
  - 错误序列化（worker 内 throw → 主进程 catch stack 完整）
  - 进度回调 5 阶段事件
  - 8+ case
- **验证**：`npm run test:integration` 全过

---

## 五、Phase 2 — A3 N1' idle cleanup 跨进程对接 + 联调

> 依赖：Phase 1 已完成

### T12 — setupIdleCleanupTimer 协调改造
- **位置**：`src/main.js:11155-11178`
- **内容**：spec §2.3.2 — 加 `if (runCheckWorkerPool.isBusy()) return;` 守卫
- **验证**：unit + 集成（idle 触发时机不变 + worker 忙时 skip）
- **跟主线映射**：A3-5

### T13 — cancel 语义联调
- **位置**：renderer.js cancel 按钮（待 spec 阶段精确定位）+ main.js IPC handler `acquiringBillCurrency:run:cancel`（新）+ workerPool.cancel()
- **内容**：
  - renderer 加 cancel 按钮（如已有则复用）
  - main IPC handler 转发 cancel → workerPool → worker → 设 cancelFlag
  - worker 内主循环检测 cancelFlag → graceful exit + ROLLBACK 当前事务
- **验证**：手测 + 集成（cancel 后 5s 内 worker exit + op lock 释放）
- **跟主线映射**：A3-6

### T14 — worker crash recover
- **位置**：`src/main-process/run-check-worker-pool.js`
- **内容**：
  - worker `error` 事件 → 释放 op lock + Notification + 标记 workerInstance = null
  - worker `exit`（非正常）事件 → 同上
  - 下次 dispatchRunCheck 触发 coldStart
- **验证**：集成（人为 process.exit(1) 模拟 crash → 主进程感知）
- **跟主线映射**：A3-7

### T15 — Phase 2 集成测试
- **位置**：`scripts/integration/acquiring-bill-currency-worker-crash.js`（新建）+ `scripts/integration/acquiring-bill-currency-idle-cleanup-worker.js`（新建）
- **内容**：
  - crash recover 4+ case
  - idle cleanup 跨进程协调 5+ case（worker 忙时 skip / worker 完成后下个 tick 触发）
- **验证**：`npm run test:integration` 全过

### T16 — 性能基线对比
- **位置**：`scripts/perf/v2.1.10-a3-worker-vs-mainprocess.js`（新建）
- **内容**：同一份 500w 数据 worker vs main 跑时长 / 内存峰值对比
- **验证**：报告生成 + worker 路径不应慢 main 5% 以上（性能 budget）
- **跟主线映射**：A3 (后期验证)

---

## 六、Phase 3 — A4 chunked 实施（v0.2：D25 用户拍板必做，不再决策点）

> 依赖：Phase 2 已完成 + 性能基线报告（不再决策门 — D25 已锁定必做）
> v0.2 reverse sync：T17 删除（不再决策点）；T18-T21 改"实施"任务（不再"若 T17 决策做"）

### ~~T17 — D25 决策点~~ ❌ **v0.2 删除**

v0.2 D25 用户拍板必做（PRD §四 D25 行），不再 Phase 3 决策点。Phase 3 直接进入 T18-T21 实施。

### T18 — chunked 分批拆分（v0.2 必做）
- **位置**：`src/backend/acquiring-bill-currency-db/run-repository.js`
- **内容**：spec §3.2.1 伪代码实现；**chunk size 默认 10w**（v0.2 spec §3.2 已选定，理由：cancel 响应 < 5s + 内存峰值 < 200MB）；可后续 settings 化
- **验证**：smoke + unit + 集成
- **跟主线映射**：A4

### T19 — chunked idempotent / 重跑保护（v0.2 必做）
- **位置**：同上 + session.runCheck 调用方
- **内容**：spec §3.3 — 中途 cancel ROLLBACK 当前批；clearOldRuns + N4-cont-2 CASCADE 保证重跑无残留
- **验证**：集成（中途 cancel → 重跑数据正确）

### T20 — Phase 3 集成测试（v0.2 必做）
- **位置**：`scripts/integration/acquiring-bill-currency-sql-chunked.js`（新建）
- **内容**：3+ case（chunk 边界 / 中断恢复 / 性能对比）
- **验证**：`npm run test:integration` 全过

### T21 — A4 性能验证（v0.2 必做）
- **位置**：`scripts/perf/v2.1.10-a4-chunked-vs-single.js`（新建）
- **内容**：chunk size 10w（默认）/ 50w / 100w 对比；验证 v0.2 spec §3.2 选定 10w 的合理性
- **验证**：报告生成 + 数据回写 spec §3.2（实测列）

---

## 七、Phase 4 — N4-cont-1 raw_json 体积治理（v0.2 重写 · 独立可并行）

> 依赖：Phase 0 完成后即可启动（与 Phase 1-3 并行）
> v0.2 reverse sync：整体重写 — 工期从 ~5 天 → ~2-3 天；T22 改单键 + T23 改 clearStaleSuccessfulRawJson；T24 改"集成到 N1' idle cleanup 回调"；T25-T27 删除（无 UI / 无 dialog / 无 IPC）；T28 集成测试改 ≥ 3 case

### T22 — settings 单键 + migration（v0.2 简化）
- **位置**：`src/backend/database/migrations.js` + `src/backend/database/settings-repository.js`
- **内容**：spec §4.1.1 + §4.1.2 — 单键 `acquiring_bill_raw_json_retention_days`（默认 `'7'`；范围 1-30；外回退 7）+ `ensureAcquiringBillRawJsonRetentionSettings(db)` migration + `getAcquiringBillRawJsonRetentionDays(db)` getter
- **验证**：unit + smoke（启动后 settings 表 1 键存在 + getter 范围外回退）
- **跟主线映射**：N4-cont-1

### T23 — raw-json-retention.js 新建（v0.2 重写 · 极简）
- **位置**：`src/backend/acquiring-bill-currency-db/raw-json-retention.js`（新建）
- **内容**：spec §4.2.1 单函数 `clearStaleSuccessfulRawJson(db, retentionDays)`：
  - 核心 SQL：`UPDATE acquiring_bill_currency_bill_imports SET raw_json = NULL WHERE id IN (NOT IN 子查询排除差异行 + imported_at 老于 N 天 + raw_json IS NOT NULL)`
  - 返回 `{ affectedRows }`
- **验证**：unit test `tests/unit/backend/acquiring-bill-currency-db/raw-json-retention.test.js` 8 case 全绿（差异行排除 + 7 天边界 + NULL idempotent + 0 行触发）
- **跟主线映射**：N4-cont-1

### T24 — 集成到 N1' idle cleanup 回调（v0.2 改"复用"）
- **位置**：`src/main.js:11155-11178`（`setupIdleCleanupTimer` 内的 setInterval 回调）
- **内容**：spec §4.3.1 改造 — 在 `triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded` 后**追加** `clearStaleSuccessfulRawJson(db, retentionDays)` 调用（独立 try/catch + activity log + 失败不阻塞主 cleanup）
- **验证**：集成 — idle 触发后 activity log 含 `[N4-cont-1] idle cleanup raw_json 清理完成 affected=X`；失败时 activity log 含 ERROR + 主 cleanup 已完成
- **跟主线映射**：N4-cont-1（v0.2 复用 v2.1.9 N1' idle 30min cleanup 时序）

### ~~T25 — UI：收单单据面板加按钮~~ ❌ **v0.2 删除**（D27 = N/A 无 UI）

### ~~T26 — UI：确认 dialog factory~~ ❌ **v0.2 删除**（D27 = N/A 无 UI）

### ~~T27 — IPC handler~~ ❌ **v0.2 删除**（D27 = N/A 无 UI；无 IPC）

### T28 — Phase 4 集成测试（v0.2 重写 ≥ 3 case）
- **位置**：`scripts/integration/acquiring-bill-currency-raw-json-retention.js`（新建）
- **内容**（v0.2 重写）：
  - case 1：idle 30min 触发后 — 差异行 raw_json 完整（`SELECT COUNT(*) FROM bill_imports b WHERE b.raw_json IS NOT NULL AND b.id IN (SELECT bill_import_id FROM diff_rows)` = 全部差异行数）+ 对账成功老行 raw_json 已清（`SELECT COUNT(*) WHERE raw_json IS NULL AND imported_at < datetime('now', '-7 days') AND id NOT IN diff_rows` = 所有对账成功老行数）
  - case 2：settings retention_days 调整生效（1 天 / 30 天 / 7 天默认 / 范围外 0 / 31 回退）
  - case 3：failure graceful + 活动日志（模拟 raw_json SQL 抛错 → activity log 含 ERROR + 主 cleanup 已完成）
- **验证**：`npm run test:integration` 全过

---

## 八、Phase 5 — N4-cont-2 FK CASCADE（复用 SR-backup-1 backup）

> 依赖：Phase 0 完成后即可启动（与 Phase 1-4 并行；但建议与 Phase 4 同收单模块合一 commit 节奏）

### T29 — ensureDiffRowsCascadeMigration_v2_1_10 实现
- **位置**：`src/backend/database/migrations.js`
- **内容**：spec §5.2 + §5.3 完整 8-status state machine
- **验证**：unit test `tests/unit/backend/database/migrations-n4-cont-2.test.js` 12 case 全绿（含各 status 进度 + 幂等 + ROLLBACK）
- **跟主线映射**：N4-cont-2

### T30 — 集成 ensureDiffRowsCascadeMigration_v2_1_10 到启动期
- **位置**：`src/backend/database.js`（AppDatabase.init）
- **内容**：
  - 在 ensureBillRawJsonV2Slim（N4）之后调用
  - 传 `createBackupFn = (label) => this.createBackup(label)`
- **验证**：smoke 启动 + 老库 fixture 验证
- **跟主线映射**：N4-cont-2

### T31 — Phase 5 集成测试
- **位置**：`scripts/integration/acquiring-bill-currency-fk-cascade-migration.js`（新建）
- **内容**：spec §5.3.2 各 status + §5.4 回滚
  - migration 自动备份
  - schema 改造完成（CASCADE 已加）
  - foreign_key_check 0 violation
  - 关联删除（删 run → diff_rows 自动清）
  - 老数据保留
  - migration 幂等
  - 故障注入 ROLLBACK
  - 6+ case
- **验证**：`npm run test:integration` 全过
- **跟主线映射**：N4-cont-2

---

## 九、Phase 6 — 集成测试 + USER_GUIDE + CHANGELOG + 三件套

> 依赖：Phase 1-5 全部完成（v0.2 A4 已锁必做 — Phase 3 无决策门）

### T32 — release-check gate
- **动作**：`npm run release-check`
- **验证**：smoke + unit + integration 三段全绿 + 累计断言数 ≥ 1806（v2.1.9 baseline 1606 + 本版 ~200）

### T33 — check-vars
- **动作**：`npm run check:vars`
- **验证**：
  - 0 新增 Critical 命中（或命中已在 spec §九 范围）
  - PR body 准备粘贴 check-vars 报告
  - 重要变量升格评估（如 `diff_rows` FK schema 升格 Critical）

### T34 — preview 回归
- **动作**：`npm run preview` + `npm run preview:account`（v0.2：N4-cont-1 已无 UI 改动，preview 仅验 A3 / A4 / N4-cont-2 路径未引入视觉副作用 — 通常一致）
- **验证**：截图归档 + 与 v2.1.9 baseline 视觉无外溢

### T35 — USER_GUIDE 更新
- **位置**：`docs/USER_GUIDE.md`
- **内容**：
  - **v0.2** 「收单单据币种校验」章节加「raw_json idle 自动清理与体积治理」段（仅清对账成功老行 raw_json + 差异行永远保留 + 7 天保留窗口默认 + settings 可调 1-30 + SQLite 手动恢复路径）
  - 「故障排查」章节加「DB 备份恢复路径」段
  - 「故障排查」章节加「worker 进程异常」段
- **验证**：文档审阅 + 截图对照

### T36 — CHANGELOG / VFH 三件套
- **位置**：`CHANGELOG.md` + `docs/VERSION_FEATURE_HISTORY.md`
- **内容**：v2.1.10 章节 + 4 主线高亮 + N4-cont-2 不可逆变更警告
- **验证**：文档审阅 + 与 v2.1.9 章节风格对齐

### T37 — 版本号 bump（如 β → stable）
- **位置**：`package.json`
- **内容**：β release 时从 `2.1.10-beta.1` → 必要时 `2.1.10-beta.2`（递增 commit 数）或最终 `2.1.10`
- **验证**：`npm run scan:vars` 重跑 + 三件套同步

---

## 十、SR-FIX — self-review 修复预留位

> 触发：PR 提交后 PR 草稿 self-review 发现 finding（参考 v2.1.9 SR-FIX-1 模式）

### TSR1 — self-review checklist
- **动作**：参考 v2.1.9 PR #53 SR-FIX-1 范式（spec §16 sections）
- **重点**：
  - A3 worker 序列化路径是否覆盖所有 Error 子类（FileValidationError / TypeError / SQLITE_BUSY error 等）
  - N4-cont-2 migration 在含跨版本数据时是否正确处理（v2.1.7 老库 → v2.1.8 N4 → v2.1.9 → v2.1.10）
  - N4-cont-1 边界 case（用户在清理弹框打开期间，启动 runCheck 是否冲突）
- **跟主线映射**：全部

### TSR2 — finding 分级修复
- **Critical（合并前必修）**：资金 / 数据迁移 / FK 违反 / worker crash 死锁
- **Important（合并前修）**：UI 文案 / 日志 / activity log domain 一致性
- **Minor（合并后可补 patch）**：注释 / typo / 单测 case 补全

---

## 十一、commit / PR 节奏建议

按 CLAUDE.md `feedback_delegate_dev_agent` + 项目 git 偏好：
- 一 Phase 一 commit；message 推荐 `[v2.1.10] feat: phase X — A3 worker 框架` / `[v2.1.10] fix(self-review): SR1 N4-cont-2 边界`
- 不主动 push；用户拍板提 PR 后 team-lead 执行（按 memory `workflow_no_tester_no_auto_pr`）
- 不加 `Co-Authored-By` AI 署名（按 CLAUDE.md Conventions）

---

## 十二、与 backlog v0.1 主题映射

| 主线 | 主要 Phase | 主要 task |
|---|---|---|
| **A3** runCheck 跨进程化 | Phase 0 / 1 / 2 | T03-T16 |
| **A4** SQL JOIN chunked（v0.2 必做） | Phase 3 | T18-T21（v0.2 删 T17 决策点；改"实施"任务） |
| **N4-cont-1** raw_json 体积治理（v0.2 重写） | Phase 4 | T22-T24 + T28（v0.2 删 T25-T27 — 无 UI / 无 dialog / 无 IPC） |
| **N4-cont-2** FK CASCADE | Phase 5 | T29-T31 |
| 全部（收尾） | Phase 6 | T32-T37 |
| 全部（修复） | SR-FIX | TSR1-TSR2 |

---

**当前状态**：v0.2（2026-05-28 reverse synced — A4 改必做 / N4-cont-1 task 重写工期下降 / T17 删除 / T25-T27 删除）。
**下一步**：通知 Dev 启动 Phase 0 T03-T05（worker_threads vs utilityProcess POC）。Phase 4 / Phase 5 与 Phase 1-3 并行。
