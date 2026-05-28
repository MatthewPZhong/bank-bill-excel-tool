# Manual Test Checklist — v2.1.10 β

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（2026-05-28 起草） |
| 关联文档 | `PRD-v2.1.10.md` v0.1 / `spec.md` v0.1 / `tasks.md` v0.1 / `backlog.md` v0.1 |
| 测试范围 | β 4 主线 — A3 runCheck 跨进程化 + A4 SQL JOIN chunked（条件触发） + N4-cont-1 raw_json 体积治理 + N4-cont-2 FK CASCADE 改造 + 0 regression（v2.1.9 α 9 主题全集） |
| 测试节奏 | Phase 0 完成后用户手测 → 每 Phase 完成后用户手测 → 全 Phase 完成后跑 release-check + 用户验收 |
| 必做 case 数 | **≥ 22**（A3 ≥ 8 / A4 ≥ 3 / N4-cont-1 ≥ 5 / N4-cont-2 ≥ 6）+ 0 regression 9 主题 |
| **危险等级** | 🔴 **本版 4 主线均高危**：跨进程架构改造 / DB schema 不可逆 / raw_json 删除不可逆 / FK CASCADE 不可逆 |

---

## 一、测试环境准备

### 1.1 检出与基线

- [ ] 检出 `v2.1.10` 分支（基于 main，已建好）
- [ ] `cat package.json | grep '"version"'` = `"version": "2.1.10-beta.1"`
- [ ] `npm install` 无报错
- [ ] `npm run smoke` v2.1.9 baseline 全绿（0 regression 起点）
- [ ] `npm run test:unit` v2.1.9 baseline 全绿（≥ 415 case，含 SR-log-1 unit ≥ 12）
- [ ] `npm run test:integration` v2.1.9 baseline 全绿（≥ 1606 断言）

### 1.2 数据备份（强制）

> 🔴 **危险操作**：v2.1.10 包含 **DB schema 不可逆改造（N4-cont-2 FK CASCADE）** 与 **raw_json 不可逆清理（N4-cont-1）**。每次升级前必须备份。

- [ ] 启动 v2.1.9 稳定版（如已安装）→ 用 SR-backup-1 backup API 手工触发一次完整备份（USER_GUIDE → 故障排查 → 备份数据库）
- [ ] 备份当前 `<userData>/tool-data.sqlite` 到 `<userData>/backups/manual-pre-v2.1.10-{YYYYMMDD}.sqlite`
- [ ] 备份 `Documents/网银账单生成小助手/exports/` 最近 1 个月输出（用户验收对照）
- [ ] 备份 `Documents/网银账单生成小助手/logs/` 最近 1 个月（SR-log-1 历史）

### 1.3 跨版本 fixture 准备（N4-cont-2 必需）

> N4-cont-2 §6.1 要求验证 **v2.1.7 → v2.1.8 → v2.1.9 → v2.1.10** 完整升级路径。准备以下 4 个 fixture：

| fixture 名 | 来源 | DB schema 特征 |
|---|---|---|
| `tool-data-v2.1.7-fixture.sqlite` | v2.1.7 baseline 库 | 无 `acquiring_bill_currency_diff_rows` 表（v2.1.8 N4 才引入） |
| `tool-data-v2.1.8-fixture.sqlite` | v2.1.8 N4 已落 | `bill_imports.raw_json` 已瘦身 9 字段 / `diff_rows` 表存在 / FK 无 CASCADE / 无 `n5_channels_migrated` |
| `tool-data-v2.1.9-fixture.sqlite` | v2.1.9 α 已落 | `channels` 表存在 / `scenarios.channel_id` 列存在 / `n5_channels_migrated='1'` / `bill_raw_json_v2_migrated='1'` / `diff_rows` FK 仍无 CASCADE |
| `tool-data-v2.1.9-with-data.sqlite` | v2.1.9 上线后真实库（用户提供） | 含跨月 raw_json 数据 ≥ 100MB / 含 ≥ 100 行 diff_rows |

- [ ] 4 个 fixture 全部存档到 `tests/fixtures/v2.1.10-cross-upgrade/`
- [ ] 验证可读：每个 fixture 用 sqlite3 客户端打开，运行 `PRAGMA schema_version;` + `PRAGMA foreign_key_check;` 0 violation

### 1.4 跨平台 matrix

| OS | 必测项 | 备注 |
|---|---|---|
| **Windows 10/11** | 全部 Phase + worker_threads 路径分隔符 + DB backup 文件 lock 行为 | 主开发平台；A3 worker 路径 `path.join` 跨平台必须验 |
| **macOS（开发机）** | A3 worker / N4-cont-1 / N4-cont-2 / 0 regression 主路径 | 二级平台；不卡 release |

### 1.5 工具准备

- [ ] sqlite3 客户端（CLI 或 DB Browser for SQLite）
- [ ] `jq` 用于解析 SR-log-1 JSON Lines 日志
- [ ] DevTools console（renderer 端验证）
- [ ] Activity Monitor / Process Explorer（监控 worker 进程是否真起来）

### 1.6 测试日历

- [ ] Phase 0（POC）完成 → §二验收
- [ ] Phase 1 完成 → §三 A3 部分验收（worker 框架 + DB + 错误序列化）
- [ ] Phase 2 完成 → §三 A3 联调验收（idle + cancel + crash）
- [ ] Phase 3 完成（若 A4 触发）→ §四验收
- [ ] Phase 4 完成 → §五 N4-cont-1 验收
- [ ] Phase 5 完成 → §六 N4-cont-2 验收（**🔴 跨版本路径必跑**）
- [ ] Phase 6 完成 → §七 0 regression + §八 跨平台 + §九 性能 + §十签收

---

## 二、Phase 0 — D23 POC 验证（A3 worker_threads vs utilityProcess 实测）

### 2.1 POC 脚本就绪

> 关联 task：T03 / T04 / T05

- [ ] `scripts/poc/v2.1.10-a3-worker-threads.js` 存在 + 可独立 `node` 跑通
- [ ] `scripts/poc/v2.1.10-a3-utility-process.js` 存在 + 可通过 Electron 主进程启动跑通
- [ ] `scripts/poc/v2.1.10-a3-comparison.md` 报告存在 + 4 项指标对比表已填

### 2.2 4 项实测目标核验

| 项 | 通过标准 | worker_threads 实测 | utilityProcess 实测 | 是否合格 |
|---|---|---|---|---|
| **启动延迟（cold-start）** | < 200ms | ___ ms（待填） | ___ ms（待填） | [ ] |
| **IPC 延迟（双向 round-trip 1000 次平均）** | < 10ms | ___ ms（待填） | ___ ms（待填） | [ ] |
| **错误堆栈完整度** | stack 含 worker 内文件路径 + 行号 | [ ] 通过 / [ ] 不过 | [ ] 通过 / [ ] 不过 | [ ] |
| **cancel 响应延迟（5s sleep + 1s 时 cancel）** | < 1s | ___ ms（待填） | ___ ms（待填） | [ ] |

### 2.3 决策回写验证

- [ ] `docs/iterations/v2.1.10/spec.md §2.6` 实测列已填
- [ ] `docs/iterations/v2.1.10/backlog.md` D23 行最终拍板 = ___（worker_threads / utilityProcess）+ 决策理由 ≥ 100 字
- [ ] PRD-v2.1.10.md §四 D23 行 PM 倾向已更新为最终拍板

### 2.4 阻断条件

- [ ] 若 4 项指标某项不合格 → 停止启动 Phase 1，回到 spec §2 调整方案

---

## 三、A3 — runCheck 跨进程化（强制 ≥ 8 case）

> 关联 task：T06 / T07 / T08 / T09 / T10 / T11 / T12 / T13 / T14 / T15 / T16

### 3.1 worker 启动 / pre-warm / cold-start

#### 3.1.1 pre-warm 启动延迟

**准备**：v2.1.10 干净安装；空 DB。

**步骤**：
1. 启动应用，观察 activity log
2. grep `[A3 worker]` 关键字

**预期**：
- [ ] activity log 含 `[A3 worker] pre-warm 启动`
- [ ] activity log 含 `[A3 worker] pre-warm 完成` 时间戳与启动间隔 < 200ms
- [ ] activity log 含 `[A3 worker] PRAGMA verify 通过`（6 条全设）
- [ ] 进程列表中可见 worker 子进程 / 子线程

**实际**：__________
**关联 task**：T06 / T07

#### 3.1.2 cold-start fallback（pre-warm 失败路径）

**准备**：人为破坏 pre-warm（如临时改 `dbPath = '/tmp/non-exist'`，或在 worker init 内 throw）。

**步骤**：
1. 启动应用，pre-warm 应失败 → 主进程 catch + 标记 workerInstance = null
2. 触发一次 runCheck（如导入 fixture → 点开始运行）
3. 观察 activity log

**预期**：
- [ ] activity log 含 `[A3 worker] pre-warm 失败：<错误信息>`（不阻塞主进程启动）
- [ ] runCheck 触发时 activity log 含 `[A3 worker] cold-start 启动`
- [ ] cold-start 完成后 runCheck 正常执行
- [ ] cold-start 耗时记录 < 200ms（Phase 0 POC baseline）

**实际**：__________
**关联 task**：T07

### 3.2 worker 取消 / 中断

#### 3.2.1 cancel 响应（执行中取消）

**准备**：导入 500w 行 fixture 数据；准备点开始运行。

**步骤**：
1. 点「开始运行」→ 状态框显示进度
2. 等 1-2 秒（确保 worker 已进入 SQL JOIN 阶段）
3. 点「取消」按钮
4. 观察响应

**预期**：
- [ ] cancel 后 ≤ 5s worker 进程退出（Activity Monitor 验证）
- [ ] 主进程 op lock 释放（活动日志 `[A3 worker] op lock 释放`）
- [ ] DB 无锁残留（再次点开始运行可立即重跑，不抛 SQLITE_BUSY）
- [ ] worker 内当前事务 ROLLBACK（数据库无半成品 diff_rows）
- [ ] renderer 状态框显示 `已取消`

**实际**：__________
**关联 task**：T13

#### 3.2.2 cancel 在事务中（边界）

**准备**：构造一个长事务场景（如 N4-cont-2 migration 进行中也复用同一 cancel 路径，或 A4 chunked 进行到第 N 批中间）。

**步骤**：
1. 触发 runCheck
2. 在 worker 内事务 BEGIN 后、COMMIT 前发 cancel
3. 验证 ROLLBACK

**预期**：
- [ ] worker 收到 cancel → ROLLBACK 当前事务 → exit
- [ ] DB 行数对比：取消前 ≈ 取消后（无部分插入）
- [ ] activity log 含 `[A3 worker] cancel 触发 ROLLBACK`

**实际**：__________
**关联 task**：T13

### 3.3 worker 异常崩溃恢复

> 🔴 **危险路径**：worker crash 后主进程 op lock 必须释放，否则用户无法再次执行任何 runCheck。

#### 3.3.1 worker 人为 process.exit(1) 模拟

**准备**：在 `src/main-process/run-check-worker.js` 加临时 dev-only hook：`if (process.env.CRASH_WORKER === '1') process.exit(1);`，环境变量启动应用。

**步骤**：
1. 启动应用（带 `CRASH_WORKER=1`）
2. 触发 runCheck
3. 观察 worker exit 事件

**预期**：
- [ ] 主进程收到 worker `exit` 事件（exitCode = 1）
- [ ] 主进程 op lock 释放（activity log `[A3 worker] crash 后释放 op lock`）
- [ ] Notification 弹出「worker 异常请重试」
- [ ] workerInstance = null 标记
- [ ] 下次 runCheck 触发 cold-start（验证 §3.1.2 路径）

**实际**：__________
**关联 task**：T14

#### 3.3.2 worker 内 throw 未捕获异常

**准备**：在 `runCheckInWorker` 内人为 throw new Error('test crash');（dev-only 标志位）。

**步骤**：
1. 启动应用
2. 触发 runCheck
3. 观察主进程 catch 路径

**预期**：
- [ ] 主进程 catch 错误 → err.stack 含 worker 内文件路径（`run-check-worker.js`）+ 行号
- [ ] err.name = 'Error'，err.message = 'test crash'
- [ ] renderer 状态框显示原错误信息
- [ ] worker 进程未崩溃（仅当前 runCheck 失败，下次可重试不需 cold-start）
- [ ] activity log 含 `[A3 worker] runCheck failed: test crash` + stack

**实际**：__________
**关联 task**：T08 / T11

### 3.4 主进程退出时 worker 清理

**准备**：v2.1.10 应用启动 + pre-warm worker。

**步骤**：
1. 应用启动完成
2. Activity Monitor 确认 worker 进程存在
3. 关闭应用窗口（command-Q / 关闭按钮）
4. 等待 5s
5. 再查 Activity Monitor

**预期**：
- [ ] worker 进程同步退出（不残留孤儿进程）
- [ ] worker 内 DB 连接已 close（无 `tool-data.sqlite-wal` / `-shm` 残留 lock）
- [ ] activity log 含 `[A3 worker] terminate on app quit`
- [ ] 进程退出耗时 ≤ 3s（防卡死）

**实际**：__________
**关联 task**：T07

### 3.5 lastActiveTs 跨进程同步（idle cleanup 触发协调）

#### 3.5.1 worker 忙时 idle cleanup 不触发

**准备**：
- 调小 idle 阈值便于测试：`sqlite3 tool-data.sqlite "UPDATE app_settings SET setting_value='1' WHERE setting_key='acquiring_bill_idle_cleanup_minutes';"`
- 重启应用

**步骤**：
1. 触发 runCheck（500w 行数据，预期 worker 跑 ≥ 2 min）
2. 模拟用户离开（不触发任何 UI 操作）
3. 等 2 分钟（idle 阈值 1 min 已超过）
4. 观察 activity log

**预期**：
- [ ] activity log **不**含 `[idle cleanup] 触发`（worker 忙时 skip）
- [ ] worker 仍在执行（Activity Monitor 验证）
- [ ] activity log 含 `[idle cleanup] worker busy, skip`（如有 debug log）
- [ ] worker 完成 runCheck 后下一个 tick 触发 cleanup（如无新活动）

**实际**：__________
**关联 task**：T12 / T15

#### 3.5.2 worker 空闲 + 用户离开 → idle cleanup 正常触发

**准备**：同 §3.5.1。

**步骤**：
1. 不触发 runCheck（worker pre-warm 但空闲）
2. 模拟用户离开
3. 等 idle 阈值（1 min）+ 5min check interval

**预期**：
- [ ] activity log 含 `[idle cleanup] 触发` + `[idle cleanup] flow + bill cleanup 完成`
- [ ] worker 进程仍存活（worker 不参与 cleanup 触发，仅主进程触发）

**实际**：__________
**关联 task**：T12

### 3.6 PRAGMA 同步验证

> spec §2.5 强制清单：worker 内独立连接必须设 6 条 PRAGMA。

**准备**：在 worker 内加 dev-only IPC：`{ type: 'pragma-dump' }` → worker 返回各 PRAGMA 值。

**步骤**：
1. 启动应用，pre-warm 完成
2. DevTools console 触发：`window.desktopApi.devTools.dumpWorkerPragma()`（如已暴露）
3. 验证返回值

**预期**：
| PRAGMA | 期望值 | 实际值 | 是否一致 |
|---|---|---|---|
| `foreign_keys` | 1（ON） | ___ | [ ] |
| `journal_mode` | wal | ___ | [ ] |
| `synchronous` | 1（NORMAL） | ___ | [ ] |
| `cache_size` | -65536 | ___ | [ ] |
| `mmap_size` | 268435456 | ___ | [ ] |
| `busy_timeout` | 30000 | ___ | [ ] |

- [ ] 6 条全一致 → 通过
- [ ] 任一不一致 → fail-fast，记录到 bug-log，回 Phase 1 修复

**关联 task**：T06

### 3.7 DB 连接独立性 stress（SQLITE_BUSY 压测）

> 关键风险：worker + 主进程双连接同时写 → SQLITE_BUSY。

**准备**：
- v2.1.10 应用启动
- 准备一个会触发主进程 DB 写入的并发操作（如保存模板 / 修改 settings）

**步骤**：
1. 触发 runCheck（worker 开始大量写 diff_rows）
2. 同时（间隔 < 100ms）在 renderer 触发主进程 DB 写：
   - 保存账户映射模板
   - 修改 settings（如改 idle 阈值）
   - 新增渠道
3. 重复 10 次
4. 观察是否触发 SQLITE_BUSY

**预期**：
- [ ] 0 次 SQLITE_BUSY（busy_timeout 30s 内自动等待）
- [ ] 所有主进程操作正常完成
- [ ] worker 内 runCheck 正常完成
- [ ] activity log 无 `SQLITE_BUSY` 关键字

**实际**：__________
**关联 task**：T06（busy_timeout PRAGMA 验证）

### 3.8 错误序列化（stack/cause/code 完整）

#### 3.8.1 普通 Error 序列化

**步骤**：worker 内 throw new Error('test'); → 主进程 catch。

**预期**：
- [ ] err.name = 'Error'
- [ ] err.message = 'test'
- [ ] err.stack 含 `at runCheckInWorker (.../run-check-worker.js:XX:XX)`
- [ ] err.code = null（未设）

**关联 task**：T08

#### 3.8.2 FileValidationError 序列化（项目 custom error class）

**步骤**：worker 内 throw new FileValidationError({ code: 'FV-001', message: 'test', detailLines: ['line1', 'line2'], context: { file: 'a.xlsx' } }); → 主进程 catch。

**预期**：
- [ ] err.name = 'FileValidationError'
- [ ] err.message = 'test'
- [ ] err.code = 'FV-001'
- [ ] err.detailLines 数组完整（['line1', 'line2']）
- [ ] err.context = { file: 'a.xlsx' }
- [ ] err.stack 含 worker 内行号
- ⚠️ **注意**：反序列化后 `err instanceof FileValidationError = false`（无 prototype 链）— 调用方按 `err.name === 'FileValidationError'` 判断（spec §2.4.2 已声明）

**关联 task**：T08

#### 3.8.3 错误 cause 链序列化

**步骤**：worker 内：
```js
const inner = new Error('inner');
const outer = new Error('outer', { cause: inner });
throw outer;
```

**预期**：
- [ ] err.message = 'outer'
- [ ] err.cause.message = 'inner'
- [ ] err.cause.stack 完整

**关联 task**：T08

### 3.9 进度回调跨进程（5 阶段 + 节流）

**准备**：runCheck 5 阶段（clearOldRuns / computeStats / insertRun / insertDiffByJoin / writeRunOutputs）。

**步骤**：
1. 触发 runCheck
2. renderer DevTools 监听 IPC channel `acquiringBillCurrency:run:progress`
3. 记录所有事件 + 时间戳

**预期**：
- [ ] 5 阶段全部触发对应 `{ stage: '<name>' }` 事件
- [ ] 进度事件按时间序到达（无乱序）
- [ ] 高频阶段（如 insertDiffByJoin chunked）节流策略保持（每秒 ≤ 5 个事件）
- [ ] renderer 状态框文案对应 5 阶段（不卡某一阶段）
- [ ] worker 完成后 1s 内收到 `{ type: 'done' }`

**实际**：__________
**关联 task**：T10 / T11

### 3.10 A3 case 计数

- [ ] §3.1 启动 / pre-warm / cold-start — 2 case
- [ ] §3.2 取消 / 中断 — 2 case
- [ ] §3.3 异常崩溃恢复 — 2 case
- [ ] §3.4 主进程退出清理 — 1 case
- [ ] §3.5 idle cleanup 协调 — 2 case
- [ ] §3.6 PRAGMA 同步 — 1 case
- [ ] §3.7 DB 连接独立性 stress — 1 case
- [ ] §3.8 错误序列化 — 3 case
- [ ] §3.9 进度回调 — 1 case
- **总计：15 case ≥ 8（PRD §1.3 必做）**

---

## 四、A4 — SQL JOIN chunked（条件触发，≥ 3 case）

> 关联 task：T17 / T18 / T19 / T20 / T21
> **决策门**：T17 基于 A3 Phase 2 性能基线决策。若 worker 内单条 SQL < 30s 且 cancel < 5s → A4 closure，跳过本章节。

### 4.1 T17 决策结果回写

- [ ] T17 决策 = ___（做 / 不做）
- [ ] 若不做：本章节其余跳过；PRD §一 / spec §三 已回写 D25 = (a)
- [ ] 若做：继续 §4.2-4.4

### 4.2 chunk size 边界（若做 A4）

#### 4.2.1 10w 行 chunk

**准备**：500w 行 fixture；chunkSize = 100000（手动改 settings 或代码默认值）。

**步骤**：
1. 触发 runCheck
2. 观察进度事件 chunkCount + chunkIndex
3. 测总耗时

**预期**：
- [ ] chunkCount = 50（500w / 10w）
- [ ] 进度事件 50 个（每批 1 个）
- [ ] 总耗时记录：___ s（与 §4.2.2/4.2.3 对比）
- [ ] 每批之间 cancel 响应 < 1s

**实际**：__________
**关联 task**：T18 / T21

#### 4.2.2 50w 行 chunk（PM 倾向 baseline）

**准备**：同上；chunkSize = 500000。

**预期**：
- [ ] chunkCount = 10
- [ ] 进度事件 10 个
- [ ] 总耗时 ___ s
- [ ] cancel 响应 < 3s（chunk 粒度大）

**实际**：__________
**关联 task**：T18 / T21

#### 4.2.3 100w 行 chunk

**准备**：同上；chunkSize = 1000000。

**预期**：
- [ ] chunkCount = 5
- [ ] 总耗时最小但 cancel 响应最大
- [ ] cancel 响应 < 5s（接近不分批）

**实际**：__________
**关联 task**：T18 / T21

#### 4.2.4 chunk 边界精确性

**准备**：500w + 17 行（不能被 chunkSize 整除）；chunkSize = 500000。

**预期**：
- [ ] chunkCount = 11（10 整批 + 1 余批 17 行）
- [ ] 最后批 INSERT 17 行不漏不重
- [ ] 总 diff_rows 行数 = ground truth 一致

**实际**：__________
**关联 task**：T18

### 4.3 中断恢复（idempotent / 重跑保护）

**准备**：500w 行 fixture；chunkSize = 500000。

**步骤**：
1. 触发 runCheck
2. 第 5 批进行中时点取消
3. 验证 DB 中已 INSERT 的 diff_rows 行数 = 0（前 4 批被 N4-cont-2 CASCADE 清掉）
4. 再次点开始运行
5. 验证最终 diff_rows 行数与无中断时一致

**预期**：
- [ ] cancel 后 `SELECT COUNT(*) FROM acquiring_bill_currency_diff_rows WHERE run_id = ?(取消的 run_id)` = 0
- [ ] 重跑后 clearOldRuns 删旧 run → N4-cont-2 CASCADE 清旧 diff_rows
- [ ] 新 run 完成后 diff_rows 总数 = ground truth
- [ ] 重跑 idempotent（无跨 run 数据污染）

**实际**：__________
**关联 task**：T19

### 4.4 性能对比（A3 vs A3+A4）

**准备**：
- 500w 行 fixture
- 各跑 3 次取中位数

**步骤**：
1. A3 路径（不分批，单条大 SQL）跑 3 次
2. A3+A4 路径（chunkSize = 50w）跑 3 次

**预期**：
| 指标 | A3 单条 | A3+A4 50w 分批 | 差异 |
|---|---|---|---|
| 总耗时 | ___ s | ___ s | ≤ +10%（性能 budget） |
| 内存峰值 | ___ MB | ___ MB | A3+A4 应更低 |
| cancel 响应 | ___ s | ___ s | A3+A4 应明显更快 |

- [ ] A3+A4 总耗时不应慢 A3 单条超过 10%
- [ ] A3+A4 cancel 响应 < A3 单条
- [ ] 结论：是否启用 chunked = ___（建议 / 不建议）

**关联 task**：T21

### 4.5 A4 case 计数

- [ ] §4.2 chunk size — 4 case
- [ ] §4.3 中断恢复 — 1 case
- [ ] §4.4 性能对比 — 1 case
- **总计：6 case ≥ 3（PRD §1.3 必做）**（若 T17=不做则本章全部 N/A）

---

## 五、N4-cont-1 — raw_json 体积治理（强制 ≥ 5 case）

> 关联 task：T22 / T23 / T24 / T25 / T26 / T27 / T28
> 🔴 **危险操作**：raw_json 清理**不可逆**。本章 §5.2 强制验证二次确认；§5.4 验证取消路径。

### 5.1 启动期"标记超期"算法验证（保留窗口）

#### 5.1.1 默认值兼容（v2.1.9 → v2.1.10 升级）

**准备**：v2.1.9 老库 fixture（settings 表无 `acquiring_bill_raw_json_retention_months` / `_max_mb` 键）。

**步骤**：
1. 替换 `<userData>/tool-data.sqlite` 为 v2.1.9 fixture
2. 启动 v2.1.10
3. 验证 settings 默认值

**预期**：
- [ ] migration 自动 INSERT OR IGNORE 2 键
- [ ] `SELECT setting_value FROM app_settings WHERE setting_key='acquiring_bill_raw_json_retention_months'` = `'6'`
- [ ] `SELECT setting_value FROM app_settings WHERE setting_key='acquiring_bill_raw_json_retention_max_mb'` = `'500'`
- [ ] activity log 含 `[N4-cont-1 settings] 默认值 INSERT`

**实际**：__________
**关联 task**：T22

#### 5.1.2 启动期"标记超期"计算

**准备**：v2.1.9 fixture 含跨月数据（如 2025-01 ~ 2026-05 共 17 个月）+ 总 raw_json ≥ 100MB。

**步骤**：
1. 启动 v2.1.10
2. 等待启动期 N4-cont-1 calculate 完成
3. 查 activity log

**预期**：
- [ ] activity log 含 `[N4-cont-1] 标记 X 行超期，预估 Y MB`
- [ ] 标记的月份范围正确（最近 6 月内不标记，超过的标记）
- [ ] 启动不阻塞（无 unresponsive 弹窗）
- [ ] 仅"标记"不删（DB 中 bill_imports 行数不变）

**实际**：__________
**关联 task**：T23 / T24

### 5.2 手动清入口按钮 + 确认 dialog 二次确认

> 🔴 **危险操作高亮**：清理后 raw_json = '{}'，**不可恢复**。二次确认是关键安全门。

#### 5.2.1 按钮位置 + 文案

**步骤**：
1. 启动应用
2. 进入「收单单据币种校验」模块面板
3. 找「清理历史 raw_json 数据」按钮

**预期**：
- [ ] 按钮位于面板顶部工具栏（与「开始运行」/「导出差异」同行）
- [ ] 按钮 hover tooltip = 「按保留窗口（默认 6 月 / 500MB）清理超期 raw_json 数据，释放磁盘空间」
- [ ] 按钮样式与「导出差异」一致（secondary-btn）
- [ ] 无数据时按钮 disabled 或显示 tooltip「当前无超期数据」

**实际**：__________
**关联 task**：T25

#### 5.2.2 弹确认框文案 + 数据预估

**准备**：fixture 含 4 个月超期数据（约 120MB）。

**步骤**：
1. 点「清理历史 raw_json 数据」按钮
2. 等待弹框出现

**预期**：弹框内容含：
- [ ] 标题：「清理历史 raw_json 数据」
- [ ] 「当前保留窗口：最近 6 月 + 500MB 上限」
- [ ] 「待清理数据」段：月份范围 + 行数 + 预估释放 MB
- [ ] 🔴 **「⚠️ 此操作不可逆」警示文案 + 建议先备份 DB 提示**
- [ ] 「输入「确认」二次确认」段 + 文本框
- [ ] 底部 [取消] / [确认清理] 按钮

**实际**：__________
**关联 task**：T26

#### 5.2.3 二次确认输入校验

**步骤**：
1. 弹框打开
2. 不输入 / 输入「ok」/ 输入「确認」（繁体）/ 输入空白
3. 点「确认清理」

**预期**：
- [ ] 不输入 → 提示「请在输入框中输入「确认」二字才能执行清理」
- [ ] 输入「ok」→ 提示同上
- [ ] 输入「確認」→ 提示同上（必须简体「确认」）
- [ ] 输入空白 → trim 后视为不输入

**实际**：__________
**关联 task**：T26

#### 5.2.4 二次确认通过 → 执行删除

**步骤**：
1. 弹框打开
2. 输入「确认」（精确匹配）
3. 点「确认清理」

**预期**：
- [ ] 进度条 / 状态文案显示进度（如每 10000 行更新）
- [ ] 完成后弹「清理完成：已更新 X 行，raw_json 共释放 Y MB」
- [ ] 验证 DB：`SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE id IN (清理 id 列表) LIMIT 5` 全部 = `'{}'`
- [ ] bill_imports **行数不变**（保留行结构 + 元数据，仅清 raw_json 内容）
- [ ] diff_rows 不受影响（bill_import_id FK 仍有效）
- [ ] activity log 含 `[N4-cont-1] 清理完成 ...`

**实际**：__________
**关联 task**：T23 / T27

### 5.3 边界：无数据 / 仅 1 条 / 当月数据不清

#### 5.3.1 无数据

**准备**：空 DB（全新安装）。

**步骤**：进入收单模块 → 点按钮。

**预期**：
- [ ] 按钮 disabled 或点击后弹框显示「当前无超期数据」
- [ ] 不进入二次确认流程
- [ ] 0 行被清

**实际**：__________
**关联 task**：T23 / T25

#### 5.3.2 仅 1 条超期数据

**准备**：fixture 仅 1 行 raw_json（如 2025-01 月份 1 条）。

**步骤**：触发清理流程。

**预期**：
- [ ] 弹框正常显示「1 行 / 预估 X KB」
- [ ] 二次确认后清成功
- [ ] DB 该行 raw_json = '{}'

**实际**：__________
**关联 task**：T23

#### 5.3.3 当月数据不清（保留窗口边界）

**准备**：fixture 含当月数据（如当前 2026-05）+ 老数据。

**步骤**：触发清理流程。

**预期**：
- [ ] 标记的范围 < 6 月前（即 2025-11 及更老）
- [ ] 当月数据（2026-05）+ 最近 6 月内（2025-12 ~ 2026-05）**不**被标记
- [ ] 清理后当月 raw_json 完整保留

**实际**：__________
**关联 task**：T23（边界条件）

### 5.4 中途取消（graceful + 活动日志）

> 🔴 **危险路径**：清理中途取消不能留下部分清空 + 部分完整的混乱状态。

**准备**：fixture 含 10w+ 行待清。

**步骤**：
1. 触发清理流程，二次确认通过
2. 清理进度到 30% 时点「取消」
3. 验证 DB 状态

**预期**：
- [ ] 取消后弹「清理已取消：已更新 X 行」
- [ ] DB 中已 UPDATE 的行 raw_json = '{}'，未 UPDATE 的行原样保留（事务边界明确）
- [ ] 重新触发清理可继续清剩余（idempotent）
- [ ] activity log 含 `[N4-cont-1] 用户取消清理`

**实际**：__________
**关联 task**：T23 / T27

### 5.5 settings 调整（5-12 月 / 100-2000MB）

> PRD §四 D26 PM 倾向：不提供 UI，沿用 v2.1.9 N1-settings 经验，仅 sqlite3 改 settings 表。

**步骤**：
1. `sqlite3 tool-data.sqlite "UPDATE app_settings SET setting_value='3' WHERE setting_key='acquiring_bill_raw_json_retention_months';"`
2. 重启应用
3. 验证保留窗口生效

**预期**：
- [ ] 标记范围变为 3 月前（更激进）
- [ ] 弹框显示当前保留窗口「最近 3 月 + 500MB 上限」
- [ ] 重启后值持久化

**步骤（范围外回退测试）**：
1. `UPDATE ... SET setting_value='0'`（小于 min=1）
2. 重启应用

**预期**：
- [ ] getter 回退默认 6（settings-repository.js getAcquiringBillRawJsonRetentionMonths spec §4.1.2）
- [ ] 应用行为按 6 月

**实际**：__________
**关联 task**：T22

### 5.6 N4-cont-1 case 计数

- [ ] §5.1 启动期标记 — 2 case
- [ ] §5.2 手动清按钮 + 二次确认 — 4 case
- [ ] §5.3 边界 — 3 case
- [ ] §5.4 中途取消 — 1 case
- [ ] §5.5 settings 调整 — 2 case
- **总计：12 case ≥ 5（PRD §1.3 必做）**

---

## 六、N4-cont-2 — FK CASCADE 改造（强制 ≥ 6 case）

> 关联 task：T29 / T30 / T31
> 🔴 **危险操作**：DB schema **不可逆改造**。必须先 SR-backup-1 备份。本章 §6.1 强制跨版本路径全跑。

### 6.1 跨版本升级（v2.1.7 → v2.1.8 → v2.1.9 → v2.1.10 完整路径）

> 🔴 **强制项**：本节验证 4 个升级路径，每条单独清空 `<userData>` 后重跑。

#### 6.1.1 v2.1.7 → v2.1.10 一步升级

**准备**：v2.1.7 fixture（无 diff_rows 表）。

**步骤**：
1. 清空 `<userData>` → 替换 `tool-data.sqlite` 为 v2.1.7 fixture
2. 启动 v2.1.10
3. 观察 migration 链

**预期**：
- [ ] migration 顺序：N4（v2.1.8 引入 raw_json 9 字段瘦身）→ N5（v2.1.9 channels）→ N4-cont-2（v2.1.10 FK CASCADE）
- [ ] 每个 migration 都有 SR-backup-1 备份
- [ ] activity log 4 段：N4 备份 + N5 备份 + N4-cont-2 备份 + 各 migration 成功
- [ ] 最终 schema 含 `acquiring_bill_currency_diff_rows` 表 + FK CASCADE
- [ ] PRAGMA foreign_key_check 0 violation

**实际**：__________
**关联 task**：T29 / T30

#### 6.1.2 v2.1.8 → v2.1.10 升级

**准备**：v2.1.8 fixture（diff_rows 表存在 / FK 无 CASCADE / 无 channels）。

**步骤**：同 6.1.1。

**预期**：
- [ ] migration 顺序：N5（v2.1.9）→ N4-cont-2（v2.1.10）
- [ ] N5 migration 自动备份 → 成功 + 通用渠道 INSERT
- [ ] N4-cont-2 migration 自动备份 → schema rebuild → CASCADE 已加
- [ ] 老 diff_rows 数据保留（行数不变）

**实际**：__________
**关联 task**：T29 / T30

#### 6.1.3 v2.1.9 → v2.1.10 升级（标准路径）

**准备**：v2.1.9 fixture（channels 已落 / FK 仍无 CASCADE）。

**步骤**：同 6.1.1。

**预期**：
- [ ] N4-cont-2 migration **单独**触发（N4 / N5 已迁过，跳过）
- [ ] activity log 含 `[N4-cont-2 migration] 自动备份完成`
- [ ] activity log 含 `[N4-cont-2 migration] 成功`
- [ ] 备份文件 `<userData>/backups/tool-data-bak-pre-N4-cont-2-{timestamp}.sqlite` 存在
- [ ] 8-status state machine 各 status activity log 可见
- [ ] settings `n4_cont_2_diff_rows_cascade_migrated='1'`

**实际**：__________
**关联 task**：T29 / T30

#### 6.1.4 v2.1.9-with-data → v2.1.10 升级（真实数据）

**准备**：用户真实 v2.1.9 库（含跨月 raw_json ≥ 100MB / diff_rows ≥ 100 行）。

**步骤**：同 6.1.1。

**预期**：
- [ ] N4-cont-2 migration 耗时记录（用户感知）
- [ ] migration 期间 UI 锁定（§6.7 验证）
- [ ] 老数据完整（diff_rows 行数 + 内容前后一致）
- [ ] 老数据可正常查（如查看历史 run 详情）

**实际**：__________
**关联 task**：T29 / T30

### 6.2 CASCADE 验证（删 run → diff_rows 自动清；删 bill_import → diff_rows 自动清）

#### 6.2.1 删 run → diff_rows CASCADE

**准备**：v2.1.10 升级后的库，含 ≥ 1 个 run + 对应 diff_rows ≥ 10 行。

**步骤**：
1. 记录 run_id = X 对应 diff_rows 行数 = N
2. `DELETE FROM acquiring_bill_currency_runs WHERE id = X`
3. 查询 `SELECT COUNT(*) FROM acquiring_bill_currency_diff_rows WHERE run_id = X`

**预期**：
- [ ] DELETE run 成功（无 FK 违反）
- [ ] diff_rows 行数 = 0（CASCADE 自动清）
- [ ] 总 diff_rows 表大小 减少 N 行

**实际**：__________
**关联 task**：T31

#### 6.2.2 删 bill_import → diff_rows CASCADE

**准备**：同上 + ≥ 1 个 bill_import 对应 diff_rows ≥ 1 行。

**步骤**：
1. 记录 bill_import_id = Y 对应 diff_rows 行数 = M
2. `DELETE FROM acquiring_bill_currency_bill_imports WHERE id = Y`
3. 查询 `SELECT COUNT(*) FROM acquiring_bill_currency_diff_rows WHERE bill_import_id = Y`

**预期**：
- [ ] DELETE bill_import 成功
- [ ] diff_rows 行数 = 0
- [ ] ⚠️ **注意**：bill_imports / flow_imports 表本身 **不** 加 CASCADE 到 runs（spec §6.2 + PRD §四 D28 已声明）。本步骤验证 diff_rows → bill_imports CASCADE 单向

**实际**：__________
**关联 task**：T31

### 6.3 回滚验证（migration 失败 → 备份恢复路径）

> 🔴 **危险路径**：migration 失败必须有备份 + USER_GUIDE 手动恢复路径。

#### 6.3.1 故障注入 → 自动 ROLLBACK

**准备**：在 `ensureDiffRowsCascadeMigration_v2_1_10` 中故意在 `rebuilt` status 后 throw。

**步骤**：
1. 启动 v2.1.10（带故障注入）
2. 观察 migration 失败路径
3. 验证 DB 状态

**预期**：
- [ ] activity log 含 `[N4-cont-2 migration] rebuilt 阶段失败 → ROLLBACK`
- [ ] DB schema 回到 v2.1.9 状态（diff_rows FK 无 CASCADE）
- [ ] 备份文件 `tool-data-bak-pre-N4-cont-2-{timestamp}.sqlite` 保留
- [ ] settings 未 set `n4_cont_2_diff_rows_cascade_migrated`
- [ ] 应用启动失败 / UI 显示「启动失败请联系支持」（§6.7）

**实际**：__________
**关联 task**：T29 / T31

#### 6.3.2 手动恢复路径（USER_GUIDE 文档化）

**步骤**：参考 USER_GUIDE「故障排查」段：
1. 关闭应用
2. 备份当前 `tool-data.sqlite` 为 `tool-data-failed.sqlite`
3. 从 `<userData>/backups/tool-data-bak-pre-N4-cont-2-{timestamp}.sqlite` 复制为 `tool-data.sqlite`
4. `sqlite3 tool-data.sqlite "DELETE FROM app_settings WHERE setting_key='n4_cont_2_diff_rows_cascade_migrated';"`
5. 重启应用

**预期**：
- [ ] 应用启动成功（回到 v2.1.9 状态）
- [ ] 用户数据完整
- [ ] N4-cont-2 migration 重新触发（成功或仍失败需进一步定位）

**实际**：__________
**关联 task**：T35（USER_GUIDE）

### 6.4 老数据 backfill

**准备**：v2.1.9 fixture 含老 diff_rows ≥ 100 行。

**步骤**：
1. 升级到 v2.1.10
2. 验证 INSERT INTO new SELECT * FROM old 全量迁

**预期**：
- [ ] 升级后 diff_rows 行数 = 升级前
- [ ] 抽查 5 条记录 column 值（run_id / bill_import_id / flow_currency / flow_amount_abs / diff_type）一致
- [ ] id 序列连续（AUTOINCREMENT 保留原值）
- [ ] 索引 `idx_acquiring_bill_currency_diff_run` 已重建（PRAGMA index_list 验证）

**实际**：__________
**关联 task**：T29

### 6.5 标志位幂等（重启 2 次不重做）

**准备**：v2.1.10 已成功 migrate 完成的库。

**步骤**：
1. 重启应用第 1 次
2. 重启应用第 2 次
3. 观察 activity log

**预期**：
- [ ] 每次重启 activity log 含 `[N4-cont-2 migration] 已迁移，跳过`
- [ ] 无新备份文件生成
- [ ] schema 不变
- [ ] 耗时 ms 级（仅查 settings 标志位）

**实际**：__________
**关联 task**：T29

### 6.6 fk-verified 校验（PRAGMA foreign_key_check 0 violation）

**步骤**：
1. v2.1.10 升级完成后
2. sqlite3 客户端执行：`PRAGMA foreign_key_check;`
3. 验证输出

**预期**：
- [ ] 返回空（0 violation）
- [ ] 如有 violation → migration 应已在 `fk-verified` status fail-fast（参考 spec §5.3.2）

**步骤（破坏性验证 — 仅 dev 环境）**：
1. 升级前在 fixture 库中人为插入 orphan diff_rows（run_id 指向不存在的 run）
2. 升级到 v2.1.10
3. 验证 migration fail-fast

**预期**：
- [ ] `checked` status 即报错（升级前 PRAGMA foreign_key_check 已检查）
- [ ] activity log 含 violation 详情 + abort
- [ ] DB 不变

**实际**：__________
**关联 task**：T29

### 6.7 migration 期间 UI 锁定

**准备**：在 N4-cont-2 migration 中加 5s sleep（dev-only）模拟长时间 migration。

**步骤**：
1. 启动 v2.1.10
2. migration 期间尝试点 UI 按钮

**预期**：
- [ ] migration 完成前 UI 不可点击（如启动屏 / 等待文案）
- [ ] 或主窗口未渲染（migration 在 app.whenReady 前完成）
- [ ] migration 完成后 UI 正常加载

**实际**：__________
**关联 task**：T30（启动期集成）

### 6.8 N4-cont-2 case 计数

- [ ] §6.1 跨版本升级 — 4 case
- [ ] §6.2 CASCADE 验证 — 2 case
- [ ] §6.3 回滚 — 2 case
- [ ] §6.4 老数据 backfill — 1 case
- [ ] §6.5 标志位幂等 — 1 case
- [ ] §6.6 fk-verified — 2 case
- [ ] §6.7 UI 锁定 — 1 case
- **总计：13 case ≥ 6（PRD §1.3 必做）**

---

## 七、0 regression 硬约束（v2.1.9 已上线 9 主题）

> 关联 PRD §1.3 必做 + 验收矩阵「累计 ≥ 1606 断言全 PASS」。
> 本章每条勾选项含 v2.1.9 已落实代码出处（防回归遗漏）。

### 7.1 N5 channels（FK 范式不变 — ON UPDATE CASCADE）

**代码出处**：`src/backend/database/migrations.js:996` channels.id FOREIGN KEY ON UPDATE CASCADE（v2.1.9 N5 锁定范式，**不带** ON DELETE — 因为 channels 禁删 + UI 双保护）。

**步骤**：
1. v2.1.10 升级后
2. sqlite3 验证 `PRAGMA foreign_key_list('scenarios')`

**预期**：
- [ ] scenarios.channel_id FK 仍为 `ON UPDATE CASCADE`（不带 ON DELETE）
- [ ] 「通用」渠道 (id=1, is_builtin=1) 仍存在
- [ ] 渠道删除保护仍生效（UI + DB 双保护）

**实际**：__________

### 7.2 SR-backup-1 backup API（VACUUM INTO）

**代码出处**：`src/backend/database/backup.js` + `src/backend/database.js` createBackup 实例方法（v2.1.9 引入）。

**步骤**：
1. v2.1.10 启动
2. 手工触发一次备份（USER_GUIDE → 备份数据库）

**预期**：
- [ ] 备份文件 `<userData>/backups/tool-data-bak-{label}-{timestamp}.sqlite` 生成
- [ ] 文件大小 ≈ tool-data.sqlite 大小
- [ ] 无 .tmp / .partial 半文件残留
- [ ] activity log 含 `[backup] 完成`
- [ ] N4-cont-2 migration 也复用同一 API（§6.1 已验证）

**实际**：__________

### 7.3 N1' idle 30min cleanup 计时器

**代码出处**：`src/main.js:11119-11178` setupIdleCleanupTimer + loadIdleCleanupMsFromSettings（v2.1.9 引入）。

**步骤**：
1. 启动应用
2. 不触发任何 UI 操作
3. 等 idle 阈值（默认 30min；可临时改 settings 加速）

**预期**：
- [ ] 触发 cleanup（activity log `[idle cleanup] 触发`）
- [ ] flow + bill cleanup 完成（diff 不清，与 v2.1.9 一致）
- [ ] **新增（v2.1.10 A3）**：worker 忙时 skip（§3.5.1 已验证）

**实际**：__________

### 7.4 N1-settings idle 阈值 settings 化

**代码出处**：`src/backend/database/migrations.js` + `settings-repository.js` `acquiring_bill_idle_cleanup_minutes`（v2.1.9 引入）。

**步骤**：
1. `sqlite3 ... "UPDATE ... SET setting_value='60'"`
2. 重启应用
3. 触发 idle 计时

**预期**：
- [ ] 计时器周期 = 60min（行为 60 * 60 * 1000 ms）
- [ ] 设置持久化
- [ ] 范围外（< 5 或 > 180）回退默认 30

**实际**：__________

### 7.5 N4 重构 createBackupFn 注入范式

**代码出处**：`src/backend/database/migrations.js:ensureBillRawJsonV2Slim` 第 3 参 createBackupFn（v2.1.9 N4 重构）。

**步骤**：
1. v2.1.7 fixture（含 raw_json 26 字段）→ v2.1.10 升级
2. 验证 N4 migration 顺利完成

**预期**：
- [ ] N4 migration 触发 createBackupFn → 自动备份
- [ ] raw_json 缩减到 9 字段
- [ ] **新增（v2.1.10）**：N4-cont-2 也用同范式 createBackupFn（§6.1 已验证）

**实际**：__________

### 7.6 SR-log-1 全局告警日志

**代码出处**：`src/backend/logger.js` + `appendActivityLogEntry({ level, source, domain, message, details, stack })`（v2.1.9 引入）。

**步骤**：
1. 触发一次 setStatus(msg, 'error')
2. 检查 `Documents/网银账单生成小助手/logs/{YYYY-MM}/{MM-DD}/error.log`

**预期**：
- [ ] 文件存在 + JSON Lines 格式
- [ ] 字段含 ts / level / source / domain / message / details
- [ ] **新增（v2.1.10）**：A3 worker 内告警通过 message pipe 上报到 main 后写入同一日志（spec §6.1 关键不变量）

**实际**：__________

### 7.7 SR-FIX-1 dispatcher per-channel batch

**代码出处**：`src/main-process/scenario-dispatcher.js`（v2.1.9 SR-FIX-1 合并前修补）。

**步骤**：
1. `npm run test:unit -- tests/unit/main-process/scenario-dispatcher.test.js`

**预期**：
- [ ] 既有 50+ case 全绿（含 C3 阶段 A/B + 1v1 红线 + 笛卡尔配对 + 跨阶段 gw 边界）
- [ ] 0 regression

**实际**：__________

### 7.8 SR-FIX-1 UNIQUE 复合 channel_id+name

**代码出处**：`src/backend/database/migrations.js` ensureScenariosChannelNameUnique（v2.1.9 SR-FIX-1）。

**步骤**：
1. v2.1.10 升级后
2. sqlite3 `PRAGMA index_list('scenarios')`

**预期**：
- [ ] 含 `scenarios_channel_name_unique` 索引
- [ ] 同 channel 同名 INSERT 拒绝
- [ ] 跨 channel 同名 INSERT 允许（D39 修复）

**实际**：__________

### 7.9 SR-FIX-1 applyScenarioBundleImport refactor

**代码出处**：`src/main-process/scenario-bundle-import.js`（v2.1.9 SR-FIX-1）。

**步骤**：
1. 导入 v2.1.9 多渠道 bundle（含跨 channel 同名场景）
2. 验证导入结果

**预期**：
- [ ] 跨 channel 同名场景允许并存
- [ ] 同 channel 同名场景拒绝 + 跳过
- [ ] friendly error 文案正确

**实际**：__________

### 7.10 0 regression 跑批

- [ ] `npm run smoke` 全绿
- [ ] `npm run test:unit` ≥ 415 case 全绿（v2.1.9 baseline + v2.1.10 新增 ~63）
- [ ] `npm run test:integration` ≥ 1606 断言全 PASS（v2.1.9 baseline + v2.1.10 新增 ~200）
- [ ] `npm run release-check` 全绿
- [ ] `npm run check:vars` 输出 0 新增 Critical 命中（或命中已在 spec §九 范围）

---

## 八、跨平台兼容（Windows / macOS）

### 8.1 worker_threads 路径分隔符（Windows）

> 风险：worker script 路径在 Windows 下用 `path.join(__dirname, 'main-process/run-check-worker.js')` 可能产生 `\` 路径，worker_threads 是否兼容需实测。

**步骤**：
1. Windows 10 + Windows 11 各跑一次完整 A3 流程（§3.1 ~ §3.9）
2. 重点验证 worker 启动 + DB 路径

**预期**：
- [ ] worker 正常启动（无路径错误）
- [ ] worker 内 DB path（`<userData>/tool-data.sqlite`）正确加载
- [ ] activity log 中文件路径用反斜杠 `\` 显示（Windows 风格）

**实际**：__________

### 8.2 DB backup 文件 lock 行为（Windows）

> 风险：Windows 文件锁更严格，备份期间 tool-data.sqlite 可能被 lock。

**步骤**：
1. Windows 启动 v2.1.10
2. 触发 N4-cont-2 migration（含自动 SR-backup-1 备份）
3. 同时尝试在文件管理器复制 tool-data.sqlite

**预期**：
- [ ] SR-backup-1 备份成功（VACUUM INTO 不需独占锁）
- [ ] 文件管理器复制可能失败 / 成功（取决于 Windows 版本）—— **不阻塞 migration**
- [ ] migration 完成后 lock 释放

**实际**：__________

### 8.3 N4-cont-1 大文件 IO（Windows）

**步骤**：
1. Windows 准备 ≥ 500MB raw_json fixture
2. 触发清理流程
3. 测耗时 + 内存峰值

**预期**：
- [ ] 清理在 5min 内完成（500MB / 10000 行批次）
- [ ] 内存峰值 < 1GB
- [ ] 进度回调正常更新（不卡死）

**实际**：__________

### 8.4 macOS 必测项（开发机）

- [ ] §三 A3 全部 case
- [ ] §五 N4-cont-1 主路径（§5.2 / §5.4）
- [ ] §六 N4-cont-2 §6.1.3（v2.1.9 → v2.1.10 标准路径）
- [ ] §七 0 regression 跑批

**实际**：__________

---

## 九、性能基线对比

> 关联 task：T16（A3 性能基线）+ T21（A4 chunked 性能）

| 指标 | v2.1.9 baseline | v2.1.10 目标 | 实测 | 是否达标 |
|---|---|---|---|---|
| runCheck 500w 行总耗时 | ___ s | ≤ baseline + 5% | ___ s | [ ] |
| 主进程 unresponsive 触发频率 | ___ 次/小时 | 0 次/小时（A3 worker 化后） | ___ 次/小时 | [ ] |
| worker cold-start 延迟 | N/A | < 200ms | ___ ms | [ ] |
| worker pre-warm 后 runCheck 启动延迟 | N/A | < 50ms | ___ ms | [ ] |
| DB 文件大小（6 月数据保留） | ___ MB | ≤ baseline（按保留窗口） | ___ MB | [ ] |
| N4-cont-1 清理 100MB raw_json 耗时 | N/A | < 30s | ___ s | [ ] |
| N4-cont-2 migration 耗时（100w 行 diff_rows） | N/A | < 10s | ___ s | [ ] |
| worker 内 cancel 响应延迟 | N/A | < 5s | ___ s | [ ] |
| 应用启动延迟（含 pre-warm + 标记超期） | ___ s | ≤ baseline + 1s | ___ s | [ ] |

### 9.1 性能 budget 守护

- [ ] runCheck 总耗时不慢 v2.1.9 baseline 超过 5%（worker 化代价 + 跨进程消息开销）
- [ ] 应用启动延迟不增加超过 1s（pre-warm + 标记超期）
- [ ] 0 unresponsive 弹窗触发（A3 worker 化的核心收益）

---

## 十、签收

### 10.1 PM 签收

- [ ] PRD §七 验收矩阵全部项已勾选
- [ ] 4 主线必做 case 数达标（A3 ≥ 8 / A4 ≥ 3 / N4-cont-1 ≥ 5 / N4-cont-2 ≥ 6）
- [ ] 0 regression §七 9 主题全 PASS
- [ ] 跨平台 §八 Windows / macOS 主路径 PASS
- [ ] 性能 §九 9 指标全达标
- [ ] D23 POC 决策已回写 spec / backlog
- [ ] D25 A4 决策已回写
- [ ] 文档三件套已更新（CHANGELOG / VFH / USER_GUIDE）
- [ ] check-vars 0 新增 Critical 命中

**PM 签收人**：__________
**签收日期**：__________

### 10.2 Dev 签收

- [ ] release-check 全绿
- [ ] check-vars 报告已贴 PR body
- [ ] N4-cont-2 备份恢复路径已 USER_GUIDE 文档化
- [ ] A3 worker crash 恢复路径已集成测试覆盖
- [ ] N4-cont-1 二次确认 + 不可逆警示 UI 已实装
- [ ] 跨版本升级路径（v2.1.7 → v2.1.8 → v2.1.9 → v2.1.10）已全跑
- [ ] PR 草稿归档到 `docs/prs/PR{N}-v2.1.10.md`

**Dev 签收人**：__________
**签收日期**：__________

### 10.3 用户验收

- [ ] 用户拍板 D23 POC 最终决策（worker_threads / utilityProcess）
- [ ] 用户拍板 D25 A4 是否做
- [ ] 用户拍板 D26 raw_json 清理执行方式（UPDATE 留行 / DELETE 整行）
- [ ] 用户拍板 D27 raw_json UI 入口位置（收单模块按钮）
- [ ] 用户拍板 D28 FK CASCADE 改造范围（仅 2 FK）
- [ ] 用户在真实数据上验收 N4-cont-2 升级路径
- [ ] 用户在真实数据上验收 N4-cont-1 清理流程（重点二次确认 + 不可逆警示）
- [ ] 用户在真实数据上验收 A3 worker 化后 unresponsive 0 触发
- [ ] 用户拍板 β release（β → main 或继续 SR-FIX）

**用户签收人**：__________
**签收日期**：__________

---

## 十一、Bug 报告模板

发现问题时按以下格式记录到 `docs/iterations/v2.1.10/bug-log.md`（待 dev 阶段创建）：

```markdown
### BUG-001 — 简短标题

- **发现日期**：2026-XX-XX
- **测试阶段**：Phase X / §X.X
- **复现步骤**：
  1. ...
- **预期行为**：...
- **实际行为**：...
- **严重程度**：🔴 Critical / 🟡 Important / 🟢 Minor
- **关联 task**：TXX
- **关联主线**：A3 / A4 / N4-cont-1 / N4-cont-2 / 0 regression
- **修复 commit**：（dev 修复后回填）
```

---

## 十二、风险提醒清单（CLAUDE.md 规则 7）

> ⚠️ **本版 4 主线均涉及高危类别**：跨进程架构 / DB schema 不可逆 / 资金红线 / 状态机 / 并发。每条都要红字提醒人工复核。

| 风险点 | 主线 | 等级 | 测试章节 |
|---|---|---|---|
| 🔴 A3 worker 跨进程后 runCheck 结果必须 byte-for-byte 一致 | A3 | 资金红线 | §三 + §七 0 regression |
| 🔴 A3 worker crash → 主进程 op lock 永久占用 | A3 | 死锁 | §3.3 必跑 |
| 🔴 N4-cont-2 FK CASCADE schema 不可逆 | N4-cont-2 | 数据迁移 | §6.1 跨版本路径 + §6.3 回滚 |
| 🔴 N4-cont-1 raw_json 删除不可逆 | N4-cont-1 | 数据丢失 | §5.2 二次确认 必跑 |
| 🔴 A3 worker DB 连接 + 主进程 DB 写冲突 | A3 | 并发 | §3.7 SQLITE_BUSY stress 必跑 |
| 🟡 跨版本升级路径（v2.1.7 → v2.1.10）必须验证 | N4-cont-2 | 数据迁移 | §6.1.1 ~ §6.1.4 全跑 |
| 🟡 A4 chunked 中断恢复 idempotent | A4 | 数据一致 | §4.3 必跑 |
| 🟡 worker 进程退出时 DB 连接 close（防 .wal / .shm 残留） | A3 | 资源泄漏 | §3.4 必跑 |
| 🟡 N4-cont-2 migration 期间 UI 锁定 | N4-cont-2 | 并发 | §6.7 必跑 |
| 🟡 idle cleanup 与 worker 长任务冲突 | A3 | 状态机 | §3.5 必跑 |

---

**当前状态**：v0.1（2026-05-28 — 起草完毕；Phase 0 POC 完成后启动 §二验收）。
**下一步**：用户审 manual-test-checklist → Phase 0 POC 启动（worker_threads vs utilityProcess 实测）→ Phase 0 完成后 §二验收 → Phase 1 启动 → 逐 Phase 手测。
