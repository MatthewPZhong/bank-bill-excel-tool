# Spec — v2.1.8 资金红线评审 + 设计决策

| 字段 | 值 |
|---|---|
| 文档版本 | v0.10（2026-05-26 — **N4 新立项**：「导出差异表字段瘦身」按模版 9 列 + diff_rows 3 列 = 12 列；DB raw_json 也瘦身（破坏性 migration），4 项决策全锁；详 §五）；v0.9 FK 反向同步；v0.8 N1 方案重设 idle 30min + 差异保留；v0.7 GATEWAY_RECON_FIELDS 反向同步；v0.6 「自取值」改 assign-gw；v0.5 F5 范围收敛；v0.4 移除 TEST.xlsx；v0.3 T08 改 F5-D4；v0.2 27 决策；v0.1 起草 |
| 关联 PRD | `PRD-v2.1.8.md` v0.1 |
| 关联 tasks | `tasks.md`（待建） |
| 评审范围 | F5（算法重设）/ A3（跨进程）/ N1（cleanup 移出对账链路）/ N2（配置数据结构变更）/ N3（IPC 字段重命名 + 新 Sheet） |
| 评审豁免 | A4（决策依赖 A3）/ G1（不动业务代码） |

---

## 一、F5 — C4 manyToOne 算法重设 🔴

### 1.1 算法不变量（不可破坏）

- **资金平衡**：`Σ(left subset amount) === right.amount`（subset-sum 等式必须成立）
- **网关单向消费**：每条网关 right 行最多匹配 1 个 left subset
- **first-match-wins**：scenario 命中后 left 行进 rowLockSet 不再被其他 scenario 消费
- **modifiedRows + unmatchedRows = inputRows**（v2.1.7 F8 护栏）

### 1.2 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| F5-D1 ✅ | maxSize 放开策略 | (a) 完全放开 / (b) 按金额量级动态 / (c) 按 candidates pool size 动态 | **(c)**：pool ≤ 12 全跑；12-20 maxSize=12；> 20 maxSize=10 + warn |
| F5-D2 ✅ | manyToOne 遍历顺序 | (a) 子集大小降序 / (b) 金额降序 / (c) 复合 | **(c)**：金额降序 + 子集大小降序 |
| F5-D3 ✅ | currency 字段过滤 | (a) 加 / (b) 不加 | **(a)**：加 |
| F5-D4 🔄 | BillDate 字符串化位置 | (a) reader 入口 / (b) 引擎入口 | **(b) 引擎入口**（T08 Reverse Sync 2026-05-22 改 — (a) 影响共用函数 sheetToObjects 跨 8 sheet 全部字段，资金红线扩面；(b) 仅在 `c4-recon-id-fix.js:1058-1065` gateway 映射段把 createTime number → ISO 字符串后赋给 BillDate，影响面收敛到 c4 引擎一处）|
| F5-D5 ✅ | 性能护栏 | (a) 单渠道超时降级 / (b) 全局超时 / (c) 不做 | **(a)**：candidates > 25 → 降级 maxSize=8 + 日志 |

### 1.3 fixture 文件映射（2026-05-22 验证）

| spec 代号 | 实际文件名 | 大小 | sheet 结构 |
|---|---|---|---|
| **TEST2.xlsx** | `资金对账导出不平_ADM转JPM 多笔订单对一笔资金-TEST2.xlsx` | 46KB | 对账结果(76) + 网关账单(67) + 渠道账单(73) + **订单修复(57 行)** |
| ~~TEST.xlsx~~ | (历史快照，不作 acceptance) | 42KB | 与 TEST2 前 3 sheet 相同 + 订单修复(0 行) |

**关键性质**：两个文件**前 3 sheet 输入数据完全相同**，仅第 4 sheet「订单修复」不同。
**Reverse Sync v0.4（2026-05-22 用户拍板）**：TEST.xlsx 不作 acceptance ——
- 与 TEST2 前 3 sheet 完全相同 → 算法跑出来必然相同结果 → 无法用"0 行"做回归护栏
- TEST.xlsx 仅作"v2.1.6 算法 bug 历史快照"参考，不进 smoke / 不做断言

### 1.4 F5 acceptance criteria（用户 2026-05-22 拍板，v0.4 修订）

```
输入：TEST2.xlsx 前 3 sheet（对账结果 + 网关账单 + 渠道账单）
真实 scenario 配置：ADM（DB 导出，2026-05-22 T12 实测确认）：
  matchRules: { oneToOne: false, oneToMany: false, manyToOne: true }
  billTypes: MerchantId='6300156616' / merchantId='6300156616'
  reconGroups: Amount/receiveAmount locked
  output: { mode: 'opp', commonId: { source: 'main', suffix: '' } }
  billDateRange: { enabled: true, days: 5 }

F5 跑完后输出「订单修复」sheet：
  - 行数 = 57（= TEST2.xlsx 第 4 sheet A1:N58 数据行）
  - 渠道命中数（unique Reference） = 10
  - 与 TEST2.xlsx 第 4 sheet 逐行等价（按 ReconID 维度）

T12 实测分布（spec F5-D1 档位影响）：
  默认（safety-floor=8）: 28 行 / 9 Ref（= v2.1.7 单点 fix baseline）
  maxSize=16（甜点）:      43 行 / 8 Ref（最佳，距 57 行差 14 行 / 2 Ref）
  maxSize=20+:            21 行 / 6 Ref（非线性退步，PRD §10.3 根因 #4 类似现象）
```

### 1.5 回归保护矩阵（v0.4 修订）

| 用例 | 输入 | v2.1.7 baseline | v2.1.8 期望 | T12 实测 |
|---|---|---|---|---|
| TEST2.xlsx 期望基线 | 真实 ADM scenario | 28 行 / 9 Ref | ≥ 57 行 / 10 Ref | 28-43 行（按 maxSize 档位） |
| TEST2.xlsx T54SWIC494447 子集 | 16 行 = 9,751,101 | 漏（maxSize=8） | 命中 | 部分场景命中（待 spec F5-D1 二次评估） |
| TEST2.xlsx T54SWIC506630 子集 | 11 行 | 漏（maxSize=8） | 命中 | 部分场景命中 |
| TEST2.xlsx T54SWIC470181 子集 | 4M 子池 | 漏（被前面渠道抢） | 命中 | 待验证 |
| 19+ 个 smoke suite | 现有 | 全绿 | 全绿（0 regression） | ✅ 全绿（T08-T11 实测） |

~~TEST.xlsx（0 命中样本）~~ — 已从 v0.4 移除（与 TEST2 输入相同无法独立验证）

### 1.4 G1 协同 unit case 列表

F5 实现过程中必须落的 unit case：

- `parseBillDateMs` 接受 number 序列号（Excel 日期）→ ms（fix BillDate 数字日期）
- `findBestAmountSubset(candidates, target, maxSize=12)` → 子集（验证放开 maxSize）
- `findBestAmountSubset` candidates > 25 → 自动降级 maxSize=8（验证 D5 护栏）
- `tryManyToOnePool` 遍历顺序：金额降序 → 大子集优先（验证 D2）
- `tryManyToOnePool` currency 过滤前后候选池大小（验证 D3）

---

## 二、A3 — runCheck 跨进程化 🔴

### 2.1 IPC / 进程间契约（不可破坏）

- **session.runCheck onProgress 5 阶段语义**（v2.1.7 F6 已固化）：`importing → counting-stats → inserting-run → sql-joining → writing-xlsx → updating-paths`
- **错误类型**：`FileValidationError` 结构（code / message / detail lines / context）必须跨进程保留
- **取消语义**：用户取消后 DB 无锁残留、无 ghost runs 行
- **runId 唯一性**：单次 runCheck 全程使用同一 runId

### 2.2 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| A3-D1 ✅ | 跨进程方案 | (a) worker_threads / (b) utilityProcess | **(b)** Electron utilityProcess |
| A3-D2 ✅ | DB 连接 | worker 内独立打开 + 同 PRAGMA | **独立**，复用 `database.js` 启动钩子 |
| A3-D3 ✅ | 进度回调链路 | (a) 每 stage / (b) 100ms 节流 | **(b)** 100ms 节流（沿用 F6 范式） |
| A3-D4 ✅ | 错误序列化 | (a) JSON.stringify / (b) structuredClone / (c) 自定义协议 | **(c)** 包装 `{ type:'FileValidationError', code, message, detailLines, context }`，main 端反序列化 new FileValidationError() |
| A3-D5 ✅ | 取消协议 | (a) worker.terminate() / (b) postMessage('cancel') + worker 主动检查 | **(b)** + worker 每阶段入口检查 cancel flag |
| A3-D6 ✅ | 冷启动时机 | (a) 预启动 / (b) lazy / (c) 单例常驻 | **(c)** 单例常驻，worker 异常退出 main 自动重启 |

### 2.3 改动影响面

| 文件 | 改动 |
|---|---|
| `src/main-process/acquiring-bill-currency-session.js` | 拆 runCheck 可跨进程部分（去 Electron 依赖） |
| `src/main-process/acquiring-bill-currency-worker.js`（新建） | worker entry，包含 runCheck 主循环 |
| `src/main-process/acquiring-bill-currency-worker-host.js`（新建） | main 端 worker 单例 + 消息桥接 |
| `src/main.js:10281` | handler 改为通过 worker-host 调度 |
| `src/preload.js` | progress 订阅 API 不变 |
| `src/backend/database.js` | 抽出 PRAGMA 启动钩子函数，worker 端复用 |

### 2.4 回归保护矩阵

| 用例 | 验证手段 |
|---|---|
| 500w 行 runCheck 主窗口仍可交互 | 手测 |
| FileValidationError 跨进程保留 | smoke |
| 取消后 DB 无锁残留 | smoke + pragma_user_count check |
| worker 崩溃自动重启 | smoke kill worker |
| 进度回调 5 阶段依次到达 | 手测 + smoke |
| 19 个 smoke suite 全跑 | npm run smoke |

---

## 三、N1 — cleanup 改 idle 30min 触发 + 差异数据保留（v0.8 方案重设）

> **v0.8 方案变更说明（2026-05-26）**：
> 用户在 β 方案落地后（commit 30247da）提出两项语义级修订：
> 1. **触发改 idle 30min** — 主链路从 `app.before-quit` 改为「应用闲置 30 分钟后台自动清」；before-quit 降级为退出兜底，进入模块降级为崩溃恢复兜底
> 2. **差异数据不清** — `acquiring_bill_currency_diff_rows` 表不清；只清 flow + bill 两张输入表
>
> v0.8 设计 = **三层触发**（idle 主 + before-quit 退出兜底 + 进入模块崩溃恢复兜底）+ **DB cleanup_pending 列保留**（多触发点共用判断依据）+ **runs 记录保留**（diff 是有效数据，runs 删则 diff 变 ghost 被 Phase 3 误清）

### 3.1 不变量

- runCheck 数据完整性：DB 已 COMMIT 的数据不允许丢失
- 启动期孤儿清理（`cleanupOrphanData`）保留 Phase 3 ghost-diff 清理（仅清真孤儿）
- 已有 mutex lock 仍保持 import/run/export/cleanup 互斥
- **新**：差异表 `acquiring_bill_currency_diff_rows` 为有效输出数据，**runCheck/idle/退出兜底/进入模块兜底** 4 个常规触发点不清 diff
- **新**：cleanup 完成后 runs 记录保留（避免 diff 变 ghost）；重跑同 monthKey 仍走 P1 `clearRunsByMonth` 覆盖旧 diff
- **新（v0.9 实施反向同步）**：**bill_imports 也保留**。FK 约束 `diff_rows.bill_import_id REFERENCES bill_imports(id)`（migrations.js:1073-1074，无 `ON DELETE CASCADE`）→ 保留 diff 必须连带保留 bill。flow_imports 无 FK 约束，可独立清。常规触发点 `cleanupAfterRunBackground(includeDiff=false)` **仅清 flow_imports**
- **新**：`cleanupOrphanData` Phase 2 孤儿 run（status≠success）数据脏 → **清 diff + bill + flow + 删 runs 记录**（保持 v0.6 行为，避免脏数据沉淀；顺序：先 diff 解 FK → bill → flow）

### 3.2 关键决策点

#### 3.2.1 差异保留语义（N1''-D1 ~ D5，2026-05-26 锁定）

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| N1''-D1 ✅ | 差异数据保留策略 | (a) 永久 / (b) 滚动 N 月 / (c) 每 monthKey 保留最新 1 run，重跑覆盖 / (d) 手动清入口 | **(c)** 与"重新运行 = 重做"语义对齐 |
| N1''-D2 ✅ | `cleanupOrphanData` Phase 3 ghost-diff 清理 | (a) 保留 / (b) 完全停 | **(a)** 仅清真孤儿（run_id 不在 runs），与差异保留不冲突 |
| N1''-D3 ✅ | cleanup 完成后 runs 记录处理 | (a) 删 / (b) 保留 | **(b)** runs 是 diff 元数据，删则 diff 变 ghost 被 Phase 3 误清 |
| N1''-D4 ✅ | 重跑同 monthKey 是否清旧 diff | (a) 不清累积 / (b) 重跑覆盖 / (c) round 维度并存 | **(b)** runCheck P1 `clearRunsByMonth` 保留覆盖语义 |
| N1''-D5 ✅ | UI 加"手动清空差异"入口 | (a) 加 / (b) 不加 | **(b)** v2.1.8 范围控制；v2.1.9 评估 |

#### 3.2.2 idle 触发机制（N1''-D6 ~ D13，2026-05-26 锁定）

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| N1''-D6 ✅ | "闲置"定义 | (a) renderer 无操作 / (b) main 无 IPC / (c) AND | **(c)** 避免后台 SQL 中误判 |
| N1''-D7 ✅ | 计时器位置 | (a) main 内置 / (b) renderer 上报 + main 维护 | **(b)** renderer 节流上报 user-activity，main 维护 lastActiveTs + setInterval 检查 |
| N1''-D8 ✅ | 闲置阈值 | (a) 硬编码 30min / (b) settings 可配 / (c) ENV | **(a)** 常量 `IDLE_CLEANUP_MS = 30 * 60 * 1000`；v2.1.9 评估 (b) |
| N1''-D9 ✅ | 触发中用户回来 | (a) 让 cleanup 跑完 UI 显忙 / (b) 中断 / (c) 当前 batch 完，剩余推迟 | **(c)** 当前 batch 跑完即让出（mutex 保证 import/run 抢锁），剩余下次 idle 再清 |
| N1''-D10 ✅ | before-quit 钩子去留 | (a) 删 / (b) 保留为退出兜底 / (c) 保留但静默 | **(c)** 保留（防没闲够就退）+ 简化为静默（删模态框/进度 IPC）|
| N1''-D11 ✅ | 进入模块兜底去留 | (a) 删 / (b) 保留 | **(b)** 保留（崩溃恢复兜底，DB cleanup_pending 列 + listMonths 入口）|
| N1''-D12 ✅ | DB `cleanup_pending` 列去留 | (a) 删 / (b) 保留 | **(b)** 保留（3 触发点共用判断依据） |
| N1''-D13 ✅ | idle 触发的 toast | (a) 静默 / (b) toast 提示 / (c) 仅失败弹错 | **(a)** 用户已闲置 30min 大概率不在看屏；失败留下次进入模块兜底补救 + console.error |

### 3.3 改动影响面

| 文件 | 改动 |
|---|---|
| `src/backend/database/migrations.js` | **保留** v0.7 migration（cleanup_pending 列）|
| `src/backend/acquiring-bill-currency-db/run-repository.js` | **保留** v0.7 三个 API（markCleanupPending / clearCleanupPending / listPendingCleanupRuns）|
| `src/main-process/acquiring-bill-currency-session.js` | **改 cleanupAfterRunBackground**：新增 `includeDiff=false` 参数；默认 false 时**只清 flow_imports**（bill 受 FK 约束必须保留）；true 时清 3 表（diff → bill → flow 顺序）；**Phase 2 调用显式传 `includeDiff: true`** 清脏数据 + 仍删 runs |
| `src/main.js` runCheck handler | **保留** v0.7 解耦改造（不再 setImmediate 触发）|
| `src/main.js` app.before-quit 钩子 | **简化**：保留串行 cleanup 逻辑 + 删模态框相关 IPC 广播；改为静默执行（D10=c）|
| `src/main.js` 新增 idle 计时器 | `setupIdleCleanupTimer()`：维护 lastActiveTs + `setInterval` 检查 + 满 30min 触发 cleanup |
| `src/main.js` acquiringBillCurrency IPC 入口 | **保留** v0.7 listMonths 兜底触发（D11=b）|
| `src/preload.js` | **新增** `reportUserActivity()` API；**删** `onCleanupQuitProgress` / `onCleanupQuitStart` / `onCleanupQuitDone` 订阅 API（模态框无用了）|
| `src/renderer.js` | **新增** mousemove/keydown/click 节流监听（10s）+ `desktopApi.reportUserActivity()`；**删** 退出进度模态框 UI 代码 |

### 3.4 回归保护

| 用例 | 期望 |
|---|---|
| runCheck 成功后 DB 数据 | flow/bill 表数据待清；**diff 表数据保留**；cleanup_pending=1 |
| idle 30min 触发 cleanup | 模拟无活动 30min → cleanupAfterRunBackground 后台跑 → flow/bill 清空 + **diff 保留** + cleanup_pending=0 |
| idle 触发中用户回来 | 当前 batch 跑完即让出 mutex；剩余下次 idle 再清 |
| before-quit 退出兜底 | 用户闲置不到 30min 就退出 → cleanup 仍跑（静默串行）|
| 进入模块崩溃恢复兜底 | 应用强杀后重启 → listMonths 入口检测 cleanup_pending=1 → 后台 setImmediate 清 |
| 重跑同月份 | runCheck P1 `clearRunsByMonth` 覆盖旧 diff（保留单 monthKey × 1 run × 1 diff 语义）|
| 启动期孤儿清理仍工作 | cleanupOrphanData Phase 2 不删 runs 记录；Phase 3 仍清真孤儿 ghost-diff |

### 3.5 ⚠️ 数据保留策略变更（资金红线提醒）

| 项 | β 方案（v0.7）| 新方案（v0.9）|
|---|---|---|
| diff_rows 表 | 每 run 后清 | **永久保留**（直到重跑同 monthKey 覆盖）|
| flow_imports 表 | idle / 退出 / 进入兜底清 | 同前 |
| bill_imports 表 | idle / 退出 / 进入兜底清 | **保留**（diff_rows.bill_import_id FK 约束，无 CASCADE）|
| runs 表 | cleanupOrphanData 删 | **cleanup 后保留**（diff 元数据）|
| SQLite 体积 | 过性，runCheck 完很快回落 | **持续增长**（flow 清 + bill/diff/runs 保留），需 v2.1.9 评估手动清入口 / 滚动保留窗口 |
| UI"历史月份" | 每月 1 项 | 同前（runCheck 覆盖语义不变）|

### 3.6 v0.9 FK 约束反向同步（2026-05-26 T31b 实施发现）

实施 `session.js` 改造时跑 smoke caseP 报 `FOREIGN KEY constraint failed on acquiring_bill_currency_bill_imports`。

**根因**：`migrations.js:1073-1074`

```sql
CREATE TABLE acquiring_bill_currency_diff_rows (
  ...
  FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),
  FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id)
);
```

**两个 FK 都无 `ON DELETE CASCADE`** → 保留 diff 必须连带保留：
1. `runs`（已在 D3 决策保留）
2. `bill_imports`（**v0.9 新发现，本次同步**）

**flow_imports** 与 diff_rows 无 FK 关系 → 仍可独立清。

**评估替代方案**：
- Schema 改 `ON DELETE SET NULL` 或 `CASCADE`：破坏性 schema 变更，要 migration 重建表
- diff_rows 改 NULL bill_import_id 后再删 bill：丢失关联，对账上下文无法回溯
- **采纳**：bill_imports 保留（最小变更，语义自然）；v2.1.9 可评估 schema 优化

**spec §3.2.1 N1''-D1 ~ D5 语义不变**，仅 §3.1 + §3.3 + §3.5 加 bill_imports 同步条目。

---

## 三.1、N4 — 收单差异表输出字段瘦身（v0.10 新立项）🔴 资金红线 + 破坏性 migration

> **背景**（2026-05-26）：v2.1.8 N1' 落地后用户反馈差异表 xlsx 字段冗余（29 列 → 用户实际只看 9 列模版字段 + 流水侧 3 列），同时关注 DB bill_imports 表长期保留导致体积膨胀。新立项 N4 = **输出契约瘦身（writer）+ DB raw_json 瘦身（破坏性 migration）双绑定**。

### 4.1 不变量

- 模版（assets/收单币种校验导出差异表模版.xlsx）= 字段契约 truth source
- 输出列结构按模版顺序（PM 推荐 D3=a）
- 差异判定算法 / diff_rows 表结构 / runCheck 流程不变
- bill_imports 表已抽出的关键列（month_key / source_file / source_row_index / recon_main_id / settle_currency / settle_currency_norm）保留（FK + JOIN 依赖）
- 删的是 **raw_json 内的 17 个非模版字段值**，不是表结构

### 4.2 关键决策点（4 项全锁）

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| N4-D1 ✅ | 差异类型列（diff_type）是否新增到输出 | (a) 加 / (b) 不加 | **(b) 不加** —— 沿用现状，不暴露 currency_mismatch/missing 区分到用户输出 |
| N4-D2 ✅ | 「单据_对账币种」(BILL raw 副本) 去留 | (a) 删 / (b) 保留 | **(b) 保留** —— 与模版"对账币种"列共存 |
| N4-D3 ✅ | 列顺序 | (a) 模版 9 列原序 + 末尾追加 diff_rows / (b) BILL_HEADERS 原序保留 9 列 | **(a) 模版原序** |
| N4-D4 ✅ | 是否同时改 DB schema 瘦身 bill_imports.raw_json | (a) 仅改 writer / (b) DB raw_json 也瘦身（破坏性）/ (c) 视图 | **(b) DB 也瘦身** —— 破坏性 migration，永久删 17 字段值 |
| 模版处理 ✅ | 模版补齐 | (a) 补齐到 12 列 / (b) 仅 9 列 writer 加 3 列 | **(a) 模版补齐 12 列** —— 模版即 truth |

### 4.3 12 列最终结构（D1-D3 + 模版 12 列）

| # | 列名 | 来源 |
|---|---|---|
| 1 | 账单日期 | bill raw_json |
| 2 | originBillBizId | bill raw_json |
| 3 | 单据类型 | bill raw_json |
| 4 | 主对账Id | bill raw_json |
| 5 | 业务订单号 | bill raw_json |
| 6 | 对账金额 | bill raw_json |
| 7 | 对账币种 | bill raw_json |
| 8 | valueDate | bill raw_json |
| 9 | channel | bill raw_json |
| 10 | 单据_对账币种 | bill raw_json['对账币种'] 副本（保留 D2=b）|
| 11 | 流水_通道清算币种 | diff_rows.flow_currency |
| 12 | 流水_通道清算金额 | diff_rows.flow_amount_abs |

### 4.4 raw_json 17 字段永久删除清单

```
ReconBillBizId, 公司主体, 业务部门, 对手部门, 订单创建来源, 财务BU,
账单类型, 业务子类型, 交易类型, 对账子类型, 单据状态, 用户编号,
账户号, 账户类型, remark, 创建时间, 完成时间
```

### 4.5 改动影响面

| 文件 | 改动 |
|---|---|
| `assets/收单币种校验导出差异表模版.xlsx` | 补齐 9 → 12 列（追加列 10/11/12）|
| `src/backend/acquiring-bill-currency-db/columns.js` | 新增 `TEMPLATE_BILL_HEADERS`（9 列）+ `WRITER_OUTPUT_HEADERS_V2`（12 列）；旧 `WRITER_OUTPUT_HEADERS` 标记 deprecated 保留参照 |
| `src/main-process/acquiring-bill-currency-writer.js` | `writeDiffWorkbook` 循环改：按 TEMPLATE_BILL_HEADERS 取 raw_json（9 字段）+ 第 10 列副本 + 11/12 列 flow 字段；29→12 |
| `src/backend/database/migrations.js` | 新增 `ensureBillRawJsonV2Slim`：备份 DB → 事务包裹批量 rewrite raw_json → 标志位 settings.bill_raw_json_v2_migrated=1 |
| `src/backend/database.js` | 绑定 + 调用 ensureBillRawJsonV2Slim（migration 链 startup 时）|
| `scripts/smoke/acquiring-bill-currency.js` | caseR 列数断言 29→12；新加 caseN4_billRawJsonSlimMigration |
| `rules/important-variables.md` | 新增 N4 条目（WRITER_OUTPUT_HEADERS 改 V2 / TEMPLATE_BILL_HEADERS / ensureBillRawJsonV2Slim） |

### 4.6 raw_json 下游使用调研（确认 17 字段删除无 break）

| 调用方 | 字段 | 是否在 9 模版 |
|---|---|---|
| `writer.js:180` JSON.parse 取 26 字段 | 全部 | 改造目标，本次重写 |
| `run-repository.js:173, 196` SQL `json_extract '$."账单日期"'` | 账单日期 | ✅ #1 |
| `smoke acquiring-bill-currency:1045-1046` 断言 | 账单日期 | ✅ #1 |
| 其他 | 无 | — |

**结论**：17 字段删除在代码层面 0 break；模版 9 字段中「账单日期」是高频访问字段（writer multi-sheet 分组 + SQL ORDER BY），瘦身后仍存在。

### 4.7 风险（🔴 资金红线 + 破坏性 migration）

- 🔴 **对外输出契约破坏性变更**：现有用户 Excel 自动化 / VBA / Power Query 基于 29 列结构 → 升级后报错
- 🔴 **DB 数据不可逆**：17 字段值永久删除；历史月份差异表重导出也少这些列；不能 undo
- 🔴 **migration 中断风险**：half-rewritten raw_json → 事务包裹 + 失败回滚 + 标志位防重入
- 🟡 **首次启动备份耗时**：DB 大时备份可能 5-30 秒；用 sqlite backup API 保证一致性
- 🟡 **磁盘空间**：备份文件保留永久（用户主动清）；提示用户备份位置

### 4.8 启动期备份策略

```
触发：migration 进入前检测 settings.bill_raw_json_v2_migrated 未设置
备份位置：<userData>/backups/tool-data-bak-pre-N4-<YYYYMMDDThhmmss>.sqlite
备份方式：sqlite backup API（保证一致性，DB 可能在使用）
保留策略：永久（用户主动清，N4 不加 UI 清理入口）
失败处理：备份失败 → migration 不启动 → activityLog 记录 → 下次启动重试
```

---

## 四、N2 — 场景配置数据结构变更

### 4.1 不变量

- 旧 scenario 必须 graceful 升级（用户场景库已沉淀，不能丢）
- 模板 bundle v3 reader 必须能读 v2.1.8 新字段（向前兼容）
- 引擎 `c3-gateway-recon-join.js` 已有命中路径不受影响

### 4.2 数据结构变更

#### 旧（v2.1.7 及之前）
```js
config_json.assign = {
  gwField: "Amount",
  bankField: "Credit Amount"
}
```

#### 新（v2.1.8）
```js
config_json.assign = {
  gwField: "Amount",
  bankField: "Credit Amount",          // 'direct' 模式仍保留
  mode: 'direct' | 'custom',           // 新增
  customValue: "用户填写的字符串"      // 'custom' 模式
}
```

### 4.3 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| N2-D1 🔄 | 'custom' 模式 sentinel 设计（v0.6 修订）| (a) 加到 assign-bank / (b) 加到 assign-gw | **(b) 加到 assign-gw（数据源）— 用 sentinel `__CUSTOM__`**，UI label 显示"自取值"；assign.mode='custom' 时 gwField='__CUSTOM__' + customValue=用户输入；旧 reader 看到 gwField='__CUSTOM__' 取 chosen.row['__CUSTOM__']=undefined → normalizeCellValue → '' → graceful 降级（不破坏） |
| N2-D2 ✅ | migration 触发时机 | (a) 启动 / (b) lazy / (c) 首次保存 | **(a)** 启动 migration（v0.6 不变 — 给旧 gateway-recon-join scenario 补 assign.mode='direct'） |
| N2-D3 ✅ | "自取值" UI label 文案 | (a) "自取值" / (b) "自定义值" / (c) "固定值" | **(a)** 按用户原话 |
| N2-D4 ✅ | bundle import 行为 | (a) 自动补 mode='direct' / (b) 报错 | **(a)** 静默升级 |
| N2-D5 ✅ | bundle export 行为 | (a) 永远导 / (b) mode='direct' 时省略 | **(b)** 省略，体积更小 + 旧 reader 兼容 |
| **N2-D6 🆕** | UI 中"自取值"位置（v0.6 新增） | 从上向下第 2 位（"请选择..."占位符之后、所有真实字段之前） | 按用户原话定 |

### 4.4 模板 bundle 兼容性测试

| 场景 | 期望 |
|---|---|
| v2.1.7 bundle 导入 v2.1.8 | scenario 自动补 mode='direct'，行为不变 |
| v2.1.8 bundle（含 custom）导入 v2.1.7 | reader 忽略 mode/customValue，按 direct 路径走，bankField=`__CUSTOM__` 时引擎 fallback 不赋值 + warning |
| v2.1.8 bundle（全 direct）导入 v2.1.7 | mode/customValue 字段缺省，行为完全一致 |

### 4.5 回归保护

| 用例 | 期望 |
|---|---|
| 旧 scenario 自动升级 | 启动后 DB 查询确认 mode='direct' |
| 新建 scenario 选「自取值」+ 保存 | DB 存 mode='custom' + customValue |
| 新建 scenario 选「自取值」+ 空 customValue + 保存 | 校验报错 |
| 引擎 mode='custom' 跑通 | 输出列填 customValue |
| 引擎 mode='direct' 跑通 | 输出列填 chosen.row[gwField]（行为不变） |

---

## 五、N3 — 银行对账单：场景号修复 + Sheet 3 导出

### 5.1 不变量

- `modifiedRows + unmatchedRows = inputRows`（v2.1.7 F8 护栏）
- Sheet 1（渠道对账单）+ Sheet 2（未命中场景行）格式不变
- first-match-wins 行为不变

### 5.2 关键决策点

| # | 决策 | 选项 | 锁定方案 |
|---|---|---|---|
| N3-D1 ✅ | displayIndex 派发口径 | (a) repository 层附 / (b) dispatcher 入参时 main.js 算 / (c) UI 与 main 各算 | **(a)** `scenarios-repository.listScenarios` 返回时附 displayIndex，UI 和引擎共享 |
| N3-D2 ✅ | IPC 字段重命名 | `hitScenarioIds` → `hitScenarios: [{id, displayIndex, name}]` | **是**，grep 所有调用方同步 |
| N3-D3 ✅ | Sheet 3 名称 | "命中场景行" | ✓ 用户已拍板 |
| N3-D4 ✅ | 命中场景列位置 | 末尾 | ✓ 用户已拍板 |
| N3-D5 ✅ | 命中场景列值格式 | `[${displayIndex}] ${scenarioName}` | ✓ 用户已拍板 |
| N3-D6 ✅ | Sheet 3 行排序 | (a) inputRows 原顺序 / (b) 按场景分组 | **(a)** 与 Sheet 1 一致，对照查 |

### 5.3 displayIndex 派发口径（D1 详细）

`src/backend/database/scenarios-repository.js`：

```js
function listScenarios(db) {
  const rows = db.prepare('SELECT * FROM scenarios ORDER BY sort_order ASC, id ASC').all();
  return rows.map((row, idx) => ({
    ...row,
    displayIndex: idx + 1  // 1-based 按 UI 显示顺序
  }));
}
```

dispatcher 拿到的 scenarios 数组每个元素都已含 displayIndex；UI `renderer-dialogs.js:5506` 也用同一份。

### 5.4 改动影响面

| 文件 | 改动 |
|---|---|
| `src/backend/database/scenarios-repository.js` | `listScenarios` 返回时附 `displayIndex` |
| `src/main-process/scenario-dispatcher.js:99` | `hitScenarioIds.push(scenario.id)` → `hitScenarios.push({id, displayIndex, name})` |
| `src/main.js:3045` | IPC return 字段 `stats.hitScenarioIds` → `stats.hitScenarios` |
| `src/renderer.js:3319` | 状态框文案改用 `displayIndex` |
| `src/main-process/exceljs-writer.js` | 新增 Sheet 3 写入分支 + 「命中场景」列拼装 |
| `src/main-process/bank-bu-recon-writer.js` 或 `bank-statement-io.js` | exceljs-writer 入参可能需扩展（传 scenarios 映射） |

### 5.5 回归保护

| 用例 | 期望 |
|---|---|
| 状态框序号 = 场景管理 UI 序号 | 手测对比 |
| Sheet 3 行数 = modifiedRows.length | smoke |
| Sheet 3 「命中场景」列值 = `[序号] 场景名称` | smoke |
| Sheet 1 列结构不变 | smoke diff vs v2.1.7 baseline |
| Sheet 2 列结构不变 | smoke diff vs v2.1.7 baseline |
| modifiedRows + unmatchedRows = inputRows | smoke |

---

## 六、整体并行带宽

### 6.1 用户决策（2026-05-22）

✅ **v2.1.8 单版本走完 7 项**（不拆 v2.1.8a / v2.1.8b）

### 6.2 PM 建议串并行

```
Week 1:
  - G1：框架搭建 + 第 1 层 8 个文件铺设
  - F5：spec 阶段 + TEST2.xlsx fixture 准备（与 G1 c4-recon-id-fix unit case 协同）

Week 2:
  - G1：第 1 层剩余 + 第 2 层启动
  - F5：实现 + smoke
  - N2：实现 + dialog + migration

Week 3:
  - G1：第 2 层完成
  - N1：实现 + app.before-quit + migration
  - N3：实现 + dispatcher + writer

Week 4:
  - A3：spec + worker 搭建
  - F5 / N1 / N2 / N3 round 反馈循环

Week 5:
  - A3：实现完成 + smoke
  - A4：决策（做 / 不做）
  - 三件套更新 + check-vars + PR
```

### 6.3 阻塞依赖

- F5 算法重设 → blocks → G1 c4-recon-id-fix unit case
- A3 设计完成 → blocks → A4 决策
- N3-1 displayIndex 派发 → blocks → N3-2 Sheet 3 列值

---

## 七、重要变量升格评估

**v2.1.7 baseline scan:vars 已跑**（2026-05-22）：85 files / 853 top-level names / A-share 146。

PRD 涉及的关键变量在 baseline 中的 A-share 数据：

| 变量 | 跨文件数 | 备注 |
|---|---|---|
| `parseBillDateMs` | 10 | A-share，已跨 10 文件，F5 改动必须 review 全部 |
| `findBestAmountSubset` | 4 | A-share，F5 算法重设核心 |
| `tryManyToOnePool` | 4 | A-share，F5 遍历顺序改造核心 |
| `cleanupAfterRunBackground` | 3 | A-share，N1 触发链路改造 |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | A-share，N2 枚举新增（含 preload 双写坑） |

Phase 0 T02 启动后需对照 `rules/important-variables.md` 评估升格。

| 变量 | 文件 | 当前层级 | 评估建议 |
|---|---|---|---|
| `findBestAmountSubset` | c4-recon-id-fix.js | Critical（已在表） | 保持 |
| `tryManyToOnePool` | c4-recon-id-fix.js | Important-skeleton（已在表？待 grep） | 评估升 Critical（F5 改动重大） |
| `parseBillDateMs` | c4-recon-id-fix.js | 待评估 | 至少 Important-skeleton |
| `cleanup_pending`（DB 新列） | acquiring_bill_currency_runs | 新增 | Risk-sensitive |
| `cleanupAfterRunBackground` | acquiring-bill-currency-session.js | Important-skeleton（已在表？待 grep） | 保持 + 添加 N1-β 触发时机 review 要点 |
| `config_json.assign` | scenarios | 接口契约（待评估） | Risk-sensitive |
| `hitScenarioIds` → `hitScenarios` | scenario-dispatcher.js + main.js + renderer.js | IPC 字段（待评估） | Risk-sensitive（重命名 + 结构变更） |
| `INTERNAL_FIELDS` | exceljs-writer.js | 待评估 | Important-skeleton |
| `displayIndex` | scenarios-repository.js + UI + main | 新增 | Risk-sensitive（跨多层一致性） |
| `BANK_STATEMENT_FIELDS_FOR_C3` | constants/bank-statement-fields.js | 待评估 | Important-skeleton（preload 双写） |

---

## 八、用户最终确认（2026-05-22）

- [x] F5 5 个决策点（F5-D1 ~ D5）✅ 全部按推荐
- [x] A3 6 个决策点（A3-D1 ~ D6）✅ 全部按推荐（A3-D1 = Electron utilityProcess）
- [x] N1 5 个决策点（N1-D1 ~ D5）✅ 全部按推荐
- [x] N2 5 个决策点（N2-D1 ~ D5）✅ 全部按推荐
- [x] N3 6 个决策点（N3-D1 ~ D6）✅ 全部按推荐（N3-D1 = repository 层附 displayIndex）
- [x] 整体并行带宽 5 周 ✅ 已拍板单版本走完

**用户决策口径**：「全按推荐」（2026-05-22）

**Reverse Sync 修订记录**：
- v0.3: F5-D4 reader 入口 → 引擎入口（2026-05-22 T08 实施前调研发现 sheetToObjects 共用函数影响 8 sheet × N 字段，资金红线扩面）— 用户 2026-05-22 拍板方案 C
- v0.4: 移除 TEST.xlsx acceptance（2026-05-22 T12 实测发现 TEST/TEST2 前 3 sheet 相同，算法跑出来必然相同，无法独立验证）— 用户 2026-05-22 拍板「不要看 TEST.xlsx，是错的」
- v0.5: F5 范围收敛 v2.1.8 / 根因 #5 延期 v2.1.9（2026-05-26 T12 深挖发现 subset-sum 剪枝在大 pool 下误剪正确解 — 孤立测试证据：仅 16 行 candidates + maxSize=30 ✅ 0ms 找到；38 行 pool + maxSize=30 ❌ 找不到，需 ILP/网络流范式重写超出 v2.1.8 范围）— 用户 2026-05-26 拍板「先别做 F5 了」
- v0.6: N2 「自取值」加在 assign-gw（数据源）而非 assign-bank（写入目标）— v0.2 当初按用户原话"第二下拉框"字面理解为 assign-bank，但 c3 引擎语义（:158-172 `newValue = chosen.row[assign.gwField]` 然后 `bankRow[assign.bankField] = newValue`）表明 assign-bank 是写入目标必须真实字段名，"自取值"作为数据源应在 assign-gw；用户 2026-05-26 拍板方案 A；spec 数据 shape 不变（mode + customValue），仅 UI 加入下拉的位置改
- v0.7: N2 实施前发现 GATEWAY_RECON_FIELDS 被 bank-statement-io.js:114 `sheetToObjects(sheet, GATEWAY_RECON_FIELDS)` 用作网关账单**reader 表头校验**（加 '__CUSTOM__' 字段会破坏读文件 + 影响 :5908 validFields / :6131 renderC3ConditionRow / :6212 reconFields 字段下拉）；改为仅在 `assign-gw` select 渲染时单独拼接 `<option value="__CUSTOM__">自取值</option>`，constants 保持不变；GATEWAY_RECON_FIELDS 从 important-variables.md 撤回 Important-skeleton 升格

---

**当前状态**：v0.2 定稿。等 v2.1.7 → main 合并 + 用户给「启动 Phase 0」信号后，按 tasks.md T01-T42 推进。
