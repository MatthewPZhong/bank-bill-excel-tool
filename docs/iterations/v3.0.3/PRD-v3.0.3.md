# PRD - 网银账单小助手 v3.0.3

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.3 |
| 日期 | 2026-06-10 |
| 作者 | PM |
| 状态 | 定稿（分批实施中：PR-E/F 先行，性能批次 PR-A~D 待用户离线 review） |
| 模块 | 收单单据模块（acquiring-bill-currency 导入/对账）、资金对账数据处理模块（bank-statement 主链路 scenario-dispatcher 状态框）、USER_GUIDE 用户手册 |
| 依赖 | v3.0.2 baseline（从 `v3.0.2` 或 `main` 切 `v3.0.3` 开发分支）；块 A 实施级设计 `changes/acquiring-import-recon-perf/spec.md`（§九，O-4 已纳入 v3.0.3）；本迭代不依赖未合并 PR |
| 风险等级 | 🔴 高（块 A 收单导入/对账落在金额/币种入库真理源 + 对账 SQL；块 B 改资金对账处理模块展示层 + hitScenarios 统计结构，需 fallback 兼容） |
| 范围来源 | 块 A：`changes/acquiring-import-recon-perf/spec.md`（用户 2026-06-10 调研定案）；块 B/C：team-lead 2026-06-10 调研定案 |

> **本 PRD 是 v3.0.3 迭代的需求索引 + 正文**。本迭代含 3 块相对独立、分属三个领域的需求，作为评审与实施的单一入口；变更目录入口见 `changes/v3.0.3/spec.md`，块 A 实施级技术设计见 `changes/acquiring-import-recon-perf/spec.md §九`。

---

## 一、需求概述

本次包含 **4 块需求**（块 A/B/C 分属三个不同领域、相对独立、可并行；块 D 为 2026-06-10 范围扩容，依赖块 A 落地）：

1. **块 A — 收单单据模块导入/对账性能优化**（🔴 资金红线）—— 用户反馈「收单单据模块的导入文件和对账速度太慢」+ 针对 Windows 端（SSD）专项优化。通过 flow 侧停写零消费的 raw_json、插入函数 per-row 开销预计算、冗余索引清理 + covering 升级、对账 stats 两 JOIN 合并为一遍，叠加 Windows 专项（temp_store=MEMORY、大事务后 checkpoint、多 worker 行数闸下调、OneDrive 检测提示），把 30-50 万行导入/对账提速并大幅压缩库体积。实施级设计已完整落在 `changes/acquiring-import-recon-perf/spec.md`。
2. **块 B — 资金对账数据处理模块状态框显示「渠道:场景序号」明细**（🟡 展示层 + 统计结构）—— 现状态框运行后显示 `已处理：45 行命中（场景 1、3），3 警告`，其中场景序号是「每渠道内 1-based 序号」，多渠道下「场景 1」有歧义；且 hitScenarios 按 `scenario.id` 去重，同场景在第二个渠道命中会被吞掉。改为按渠道分组展示 `JPM:1、3 / CITI:2`，去重键改 `渠道:场景id`，并加状态框滚动护栏。
3. **块 C — USER_GUIDE 重点补缺 + 口语化**（🟢 纯文档）—— 用户手册存在缺口（缺备份恢复、设置参数、错误排查、链接表操作详解、场景管理通用指南、Windows 性能建议等章节），且 §1.4 等术语密集章节对非技术用户不友好。新增 6 章节 + 对术语密集章节口语化改写（保留 ⭐/🔴 标记惯例），预计 +600-900 行。
4. **块 D — 通用引擎抽取（导入侧）+ 收单迁移**（🔴 资金红线，2026-06-10 范围扩容）—— 用户 §九 review 通过后拍板把「通用引擎抽取」「P1 解析列裁剪」「W4 导入挪 worker」三项从「不做」反转为本迭代做。架构定盘：**P1 与 W4 不在收单模块内单独实现，而是作为通用引擎（导入侧）的两个内建能力（列白名单 + 多文件 worker 并行解析→单写 INSERT 管道），通过「引擎抽取 + 收单迁移为首个用户」一次性达成**（避免做两遍）。引擎本迭代**只做导入侧**（对账侧 keyset 分页不做，留 500w 模块），收单作为首个迁移用户，迁移后导入结果须与块 A 落地后产物 byte-for-byte 一致。块 D **依赖块 A 的 PR-A~D 先落地**（复用其存储契约），引擎实施级设计另见 `changes/big-table-import-engine/spec.md`（team-lead 撰写中）。

预期结果：收单导入/对账显著提速且库体积大幅下降（Windows 写放大链收编）、状态框多渠道场景命中可清晰区分、用户手册补齐操作类内容并更易读。

> ⚠️ **版本定级说明**：块 A 含「性能优化 + 存储契约变更」、块 B 含「展示与统计结构变更」、块 C 为「文档」。三块一并收口为 **v3.0.3** 发布。块 A 是否在本迭代落地取决于用户对 `changes/acquiring-import-recon-perf/spec.md §九` 的离线 review；块 B/C 先行。

---

## 二、背景与目标

### 2.1 背景

| 块 / 需求 | 为什么做 | 用户 / 业务价值 | 当前问题 |
|----------|---------|----------------|---------|
| 块 A 性能 | 用户反馈「收单单据模块的导入文件和对账速度太慢」+ 要求针对 Windows（SSD）专项优化 | 30 万行/月真实清结算数据的导入/对账提速；Windows 写放大链收编、库体积大幅下降 | 50 万行导入 ≈ 22s（解析 ~13s + INSERT ~8.6s），单月库 ~600MB-1GB；瓶颈实测见 spec §一（flow raw_json 零消费却写 1.2KB/行、插入函数 per-row require/indexOf、两表各 2 个冗余索引、对账同一大 JOIN 跑 3 遍、Windows raw_json→WAL→checkpoint 物理写 ~2GB 被 Defender 扫两遍） |
| 块 B 状态框 | 用户在多渠道场景下看状态框「场景 1」无法区分是哪个渠道的场景 1；同场景跨渠道命中会丢显示 | 多渠道命中结果可清晰区分、不漏显 | `src/renderer.js` ~3409-3413 显示 `场景 1、3`；`displayIndex` 是每渠道内 1-based 序号（v2.1.8 N3-D1 与场景管理 UI 序号统一），多渠道有歧义；hitScenarios（`scenario-dispatcher.js` `runChannelBatch` ~:343 / legacy ~:196）结构 `{id, displayIndex, name}` 无渠道字段，且按 `scenario.id` 去重 → 场景与渠道多对多（`scenario_applicable_channels` 表）时同场景第二渠道命中被吞 |
| 块 C 手册 | 用户手册缺操作类内容、术语密集章节对非技术用户不友好 | 降低使用门槛、减少答疑、补齐排错/备份等运维类指引 | USER_GUIDE 缺「数据备份与恢复 / 设置参数指南 / 错误排查与日志查看 / 链接表管理操作详解 / 场景管理通用指南 / Windows 性能建议」章节；§1.4 等章节术语密集、版本演进分散 |

### 2.2 目标

- **块 A**：按 `changes/acquiring-import-recon-perf/spec.md §九` 实施 PR-A~PR-D：
  - PR-A：flow `insertFlowRow` 停写 raw_json（写 `''`，无 migration）+ bill 字段映射预计算 + `computeRunStats` 单遍 JOIN（含空集 `COALESCE` 防护、币种比较谓词与 chunked INSERT 同源）+ 等值 unit/contract。
  - PR-B：删 4 个冗余索引、建 2 个 covering v2 索引（`(month_key, recon_main_id, settle_currency_norm)`）+ EXPLAIN QUERY PLAN 验证无全表扫描回归。
  - PR-C：`PRAGMA temp_store = MEMORY`（4 处同步：database.js + 2 个 worker + import-worker.js）+ 导入大事务 COMMIT 后 `wal_checkpoint(TRUNCATE)`（失败仅记日志）+ 多 worker 行数闸 `MULTIWORKER_MIN_TOTAL_ROWS` 100w→30w。
  - PR-D：win32 下导出目录含 OneDrive 时启动单次 `Notification` 提示 + settings 防重 key（USER_GUIDE「Windows 性能建议」移交块 C PR-F 统一收口）。
  - 🔴 **资金红线放行闸**：P0-1/P0-4 前后对同一 fixture 跑全流程（导入→对账→writer 输出）byte-for-byte 一致（spec §六-1 contract）。
  - **开工前提**：用户完成 spec §九 离线 review。
- **块 B**：
  - `scenario-dispatcher.js`（双维路径）：hitScenarios 元素加 `channelId`/`channelName`（push 处从当前批次 channel 上下文取）；去重键 `scenario.id` → `` `${channelId}:${scenario.id}` ``；`scenarioHitCount` 原语义不动；legacy 单维路径结构保持不变（21+ 测试 0 regression）。
  - `renderer.js`：状态框格式改为按 `channelName` 分组、每渠道一行、组内 `displayIndex` 顿号连接、半角冒号（`JPM:1、3 / CITI:2`）；旧 `processingResult` 持久化数据（无 `channelName`）fallback 现状格式 `场景 1、3`。
  - `styles-gemini-extra.css`：`#bankStatementStatusBox` 加 `max-height`（≈140px ≈ 7 行）+ `overflow-y: auto`（status-box 是 flex `align-items: center`，多行滚动需验证顶部内容可达，必要时覆盖 `align-items`）。
- **块 C**：USER_GUIDE 新增 6 章节（①数据备份与恢复 ②设置参数指南 ③错误排查与日志查看 ④链接表管理操作详解（从 §1.4 独立成节）⑤场景管理通用指南（C1-C4 对比/优先级 0-3/渠道分组/新建流程）⑥Windows 性能建议（块 A PR-D 的 USER_GUIDE 部分合流于此））+ §1.4 等术语密集章节口语化改写（版本演进收拢、正文改操作视角大白话、保留 ⭐/🔴 标记惯例）。

### 2.3 明确不做（非目标）

- **引擎仅做导入侧**（2026-06-10 范围扩容后的新非目标）：块 D 通用引擎本迭代**只做导入侧**——对账侧 keyset 分页（OFFSET→keyset）**不做**（30w 典型量级 OFFSET 无感，留给未来 500w 模块）；其他模块（pending 挂账 / biz-op 业务OP / vcc / linked-table）迁移引擎**不在本迭代**，留后续迭代。（注：原「不做 P1 解析列裁剪 / 不做通用引擎抽取 / 不做 W4 导入挪 worker」三条 2026-06-10 已反转为块 D 本迭代做，见 §一-4 与 §5.4，对应 spec O-5/O-7/W4。）
- **不动 R1/R4/R5 进 hitScenarios**：块 B 仅改 hitScenarios（R2 dispatcher 产出）的结构与去重；R1/R4/R5 有 orchestrator 独立统计字段，范围不变。
- **不改对账逻辑 / 行改写**：块 B 仅改展示层 + hitScenarios 统计结构，不动任何对账算法或行级改写。
- **块 C 不动代码**：纯文档；块 A 的 OneDrive 检测提示等代码改动在 PR-D，不在块 C。
- 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE 版本条目）在 v3.0.3 **转正发布时**统一更新版本号条目（块 C 的 USER_GUIDE 正文 PR-F 单独成 PR，但版本号条目随发版收尾）。

---

## 三、代码现状（必须有出处）

| 块 / 需求 | 相关文件 | 当前行为 | 已知限制 |
|----------|---------|---------|---------|
| 块 A·flow raw_json | `src/backend/acquiring-bill-currency-db/import-repository.js` `insertFlowRow`（~47-71） | 构造 48 字段 rawObj + `JSON.stringify` 写 `raw_json` 列（~1.2KB/行） | 🔴 全库 grep 无 flow raw_json SELECT（零消费）；writer 只读 `bill_raw_json`，对账 SQL 只取币种/金额单列 → 白写，INSERT 8.64s/50w、单月库 1013MB |
| 块 A·插入 per-row 开销 | 同上 `insertBillRow`（:89-94）/ `insertFlowRow`（:61） | 每行 `require('./columns')` + 9×`BILL_HEADERS.indexOf()` | per-row 重复开销，bill INSERT 3.85s/50w |
| 块 A·冗余索引 | `src/backend/database/migrations.js`（:2498-2531） | 两表各 `idx_*_join`（与 UNIQUE 完全重复）+ `idx_*_month`（UNIQUE 左前缀） | 每行 INSERT 多维护 2 个 B-tree；对账 JOIN 探测回表读含 raw_json 宽行 |
| 块 A·对账 stats | `src/backend/acquiring-bill-currency-db/run-repository.js` `computeRunStats`（:561-584） | matched + mismatch 两个全量 JOIN COUNT + stage 4' INSERT 再 JOIN = 同一大 JOIN 跑 3 遍 | 重复 JOIN + 回表，对账 DB 段 0.97s（热）可降至 0.43s |
| 块 A·Windows 写放大 | `src/backend/database.js`（:86-94 仅 4 条 PRAGMA） | 无 temp_store、无主动 checkpoint | raw_json 1GB → WAL 1GB → COMMIT 后 checkpoint 再写 1GB = 物理写 ~2GB，NTFS+Defender 扫两遍 |
| 块 A·多 worker 闸 | `src/main-process/acquiring-bill-currency-session.js` `MULTIWORKER_MIN_TOTAL_ROWS`（:209）= 1000000 | <100w 行回退单 worker | 30-50w 典型量级被闸挡住、用不上多核（注释自记 POC 50w plan-b 2.31-2.70x 正收益） |
| 块 B·状态框显示 | `src/renderer.js`（~3409-3413） | 显示 `已处理：45 行命中（场景 1、3），3 警告` | 「场景 1」多渠道有歧义；无渠道分组；无滚动护栏（无 max-height） |
| 块 B·hitScenarios 产出 | `src/main-process/scenario-dispatcher.js` `runChannelBatch`（~:343）/ legacy（~:196） | hitScenarios 元素 `{id, displayIndex, name}`，按 `scenario.id` 去重 | 无 channelId/channelName；🔴 场景与渠道多对多（`scenario_applicable_channels` 表），同场景第二渠道命中被去重吞掉 |
| 块 B·displayIndex 语义 | scenario-dispatcher.js / 场景管理 UI | `displayIndex` = 每渠道内 1-based 序号（v2.1.8 N3-D1 与场景管理 UI 序号统一） | 多渠道下序号不带渠道前缀即有歧义 |
| 块 B·状态框样式 | `src/styles-gemini-extra.css` `#bankStatementStatusBox` | flex `align-items: center`，无 max-height | 多行内容自动撑高推挤 control-row（渠道×场景理论无上限，典型 3-8 行） |
| 块 C·用户手册 | `docs/USER_GUIDE.md` | 缺备份恢复/设置/排错/链接表操作/场景管理/Windows 性能章节；§1.4 等术语密集、版本演进分散 | 非技术用户门槛高、运维类内容缺失 |

> 块 A 完整现状与瓶颈实测证据（B1-B5）见 `changes/acquiring-import-recon-perf/spec.md §一`，本表为索引摘要。

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 收单单据模块 | acquiring-bill-currency 子系统，含流水（flow）+ 单据（bill）两表导入与两表 SQL JOIN 等值对账；块 A 的优化对象 |
| raw_json | 导入时落库的整行原始字段 JSON；bill 侧 v2.1.8 N4 已瘦身，flow 侧本迭代 P0-1 停写（零消费实证） |
| covering index | 覆盖索引；P0-3 把 join 索引升级为 `(month_key, recon_main_id, settle_currency_norm)`，对账 JOIN 探测 index-only 不回表 |
| 单遍 JOIN stats | P0-4 把 matched/mismatch 两个 JOIN COUNT 合并为一条 `COUNT(*) + SUM(CASE WHEN <币种不等> THEN 1 ELSE 0 END)` |
| PRAGMA 4 处同步 | `temp_store=MEMORY` 等 PRAGMA 必须在 database.js + run-check-worker.js + run-check-multiworker-worker.js + import-worker.js 四处一致追加（spec §2.5 契约） |
| hitScenarios | R2 dispatcher（scenario-dispatcher.js）产出的命中场景列表，供资金对账数据处理模块状态框展示 + processingStats 持久化读回；块 B 改其结构与去重键 |
| displayIndex | 场景在某渠道内的 1-based 序号（v2.1.8 N3-D1 与场景管理 UI 序号统一）；多渠道下需配渠道前缀才无歧义 |
| 渠道:场景序号 | 块 B 新展示格式 `channelName:displayIndex`（半角冒号），按渠道分组、每渠道一行、组内顿号连接（如 `JPM:1、3`） |
| 双维路径 / legacy 单维路径 | scenario-dispatcher.js 的两条执行路径；块 B 仅改双维路径（加渠道字段 + 新去重键），legacy 单维路径结构不变（21+ 测试 0 regression） |
| processingResult | 资金对账数据处理结果的持久化对象（含 hitScenarios）；块 B 对旧落库数据（无 channelName）fallback 现状格式 |

---

## 五、功能详细描述

### 5.1 块 A：收单单据模块导入/对账性能优化

> 块 A 的输入/输出/边界、改造方案（P0-1~P0-4 + W1/W2/W3/W5）、预期效果、实施级改动点（PR-A~PR-D 的文件/函数/行号/前后形态、受影响测试、验收、回滚）**全部见** `changes/acquiring-import-recon-perf/spec.md`，本 PRD 不复制。

#### 5.1.1 说明

- **输入**：30-50 万行（典型 ~30 万行/月）收单流水/单据 xlsx；Windows + SSD 环境。
- **输出**：导入/对账提速（30-50 万行流水导入 ~9-14s、对账 DB 段 ~0.3-0.45s）、单月库体积 ~50-80MB（×0.08）；对账结果与 diff/report 输出 **byte-for-byte 不变**。
- **边界条件**：
  - 🔴 P0-1/P0-4 落在资金红线（金额/币种入库 + 对账 SQL）→ 以 spec §六-1 contract（同 fixture 全流程 byte-for-byte）为放行闸。
  - flow raw_json 永久停写（spec O-1 已决；存量数据不动；未来若需流水侧原始行还原则无数据——已确认无该消费）。
  - PRAGMA 4 处同步（漏一处 → 主/worker 连接行为漂移）。
  - W2 checkpoint 失败仅记日志、不影响导入成功语义。
  - W3 闸值只影响快慢不影响结果（单/多 worker byte-for-byte contract 已锁）；D33 内存闸 + workerCount settings 兜底。

#### 5.1.2 影响范围

- **后端**：`import-repository.js`（停写 raw_json + 预计算）、`run-repository.js`（stats 合并）、`migrations.js`（索引 migration）、`database.js` + `run-check-worker.js` + `run-check-multiworker-worker.js` + `import-worker.js`（PRAGMA）、`acquiring-bill-currency-session.js`（checkpoint + 闸值）。
- **前端**：`main.js`（win32 OneDrive 检测提示 + settings 防重 key）。
- **数据 / schema**：P0-1 无 migration（`raw_json TEXT NOT NULL` 由 `''` 满足）；P0-3 幂等索引 migration（DROP 4 + CREATE 2 covering v2）。
- **对外接口影响**：无新增 IPC。
- **兼容性影响**：存量库启动期跑 P0-3 migration（30w 行建 covering ~1-2s）；存量行 raw_json 不动（仅新导入写 `''`）。

#### 5.1.3 UI Mockup（如适用）

无新增 UI（PR-D OneDrive 提示复用 Electron `Notification`，文字见 spec §9.4）。

---

### 5.2 块 B：资金对账数据处理模块状态框「渠道:场景序号」明细

#### 5.2.1 说明

- **输入**：多渠道场景跑批后的 hitScenarios（含命中场景的 `id` / `displayIndex` / `name`，本迭代新增 `channelId` / `channelName`）。
- **输出**：状态框按渠道分组展示命中场景序号，每渠道一行、组内顿号连接、半角冒号：

  ```
  已处理：45 行命中（场景
  JPM:1、3
  CITI:2），3 警告
  ```

- **边界条件**：
  - 去重键由 `scenario.id` 改为 `` `${channelId}:${scenario.id}` ``——同场景跨渠道各保留一条，不再被吞。
  - 🔴 **legacy 单维路径结构不变**（21+ 测试 0 regression 硬约束）：渠道字段/新去重键只加在双维路径。
  - 🔴 **fallback 兼容**：旧 `processingResult` 持久化数据（无 `channelName`）→ 回退现状格式 `场景 1、3`。
  - `scenarioHitCount` 原语义不动（命中计数口径不随去重键变化语义）。
  - 状态框 `max-height`（≈140px ≈ 7 行）+ `overflow-y: auto` 作为爆框护栏；status-box 是 flex `align-items: center`，多行滚动需验证顶部内容可达（必要时覆盖 `align-items`）。

#### 5.2.2 影响范围

- **前端**：`src/renderer.js`（状态框格式：按 channelName 分组 + fallback）；`src/styles-gemini-extra.css`（`#bankStatementStatusBox` max-height + 滚动）。
- **后端 / 引擎**：`src/main-process/scenario-dispatcher.js`（双维路径 hitScenarios 加 channelId/channelName + 去重键改 `渠道:场景id`；legacy 单维路径不动）。
- **数据 / 配置**：hitScenarios 元素新增 `channelId` / `channelName`（运行态结构 + processingResult 持久化）；无 DB schema/migration。
- **对外接口影响**：无新增 IPC。
- **兼容性影响**：旧 processingResult（无 channelName）renderer fallback 现状格式；legacy 单维路径消费方零回归。

#### 5.2.3 UI Mockup（如适用）

```
[资金对账数据处理模块 - 状态框 bankStatementStatusBox]

  ── 多渠道命中（新格式）─────────────────────
  已处理：45 行命中（场景
  JPM:1、3
  CITI:2），3 警告
  （超过 ~7 行时框内出现垂直滚动条，不再撑高推挤下方 control-row）

  ── 旧持久化数据 / legacy 单维路径（fallback）──
  已处理：45 行命中（场景 1、3），3 警告
```

---

### 5.3 块 C：USER_GUIDE 重点补缺 + 口语化

#### 5.3.1 说明

- **输入**：现有 `docs/USER_GUIDE.md`（缺操作类章节、术语密集）。
- **输出**：新增 6 章节 + §1.4 等术语密集章节口语化改写，预计 +600-900 行。
  - 新增 6 章节：①数据备份与恢复 ②设置参数指南 ③错误排查与日志查看 ④链接表管理操作详解（从 §1.4 独立成节）⑤场景管理通用指南（C1-C4 对比/优先级 0-3/渠道分组/新建流程）⑥Windows 性能建议（块 A PR-D 的 USER_GUIDE 部分合流于此）。
  - §1.4 等术语密集章节口语化：版本演进收拢、正文改操作视角大白话、保留 ⭐/🔴 标记惯例。
- **边界条件**：
  - 纯文档，不动任何代码。
  - 块 A 的 Windows 性能建议在 ⑥ 统一收口（PR-D 不再单独改 USER_GUIDE）。
  - 由专职 USER_GUIDE agent 负责正文撰写。

#### 5.3.2 影响范围

- **文档**：`docs/USER_GUIDE.md`（新增 6 章节 + §1.4 等口语化）。
- **前端 / 后端 / 数据 / 接口**：无。
- **兼容性影响**：无（纯文档）。

#### 5.3.3 UI Mockup（如适用）

无（文档章节调整，非界面）。

---

### 5.4 块 D：通用引擎抽取（导入侧）+ 收单迁移

> 块 D 的实施级设计（yauzl 基座参数化、列白名单、多文件 worker 并行管道、PR-G/H 拆分、contract test harness 等）见 `changes/big-table-import-engine/spec.md`（team-lead 撰写中），本 PRD 仅定范围与达成路径、不复制设计。范围概述同步见 `changes/v3.0.3/spec.md §四之五`。

#### 5.4.1 说明

- **输入**：收单单据模块现有 yauzl + 手写字节扫描导入链路；30-50 万行（典型 ~30 万行/月）、未来 500w 行量级的多文件单 sheet xlsx。
- **输出**：
  - 一组带契约参数的共享库（导入侧，暂名 `src/backend/big-table-import/`），内建**列白名单** + **多文件 worker 并行解析 → 单写 INSERT 管道**两项能力；
  - 收单单据模块改造为引擎的**首个迁移用户**（导入链路从「模块内自有 reader + 编排」切换为「声明契约 + 调用引擎」）；
  - **W4 导入挪 worker 经引擎达成**（引擎「多文件 worker 并行管道」在收单上生效，导入期间主界面可操作不卡顿）。
- **边界条件**：
  - 🔴 引擎迁移后收单导入结果须与块 A 落地后的产物 **byte-for-byte 一致**（contract 锁）。
  - 引擎本迭代**只做导入侧**——对账侧 keyset 分页不做（30w 量级 OFFSET 无感，留 500w 模块）。
  - 除收单外的存量导入模块（pending / biz-op / vcc / linked-table）迁移引擎**不在本迭代**，留后续。
  - **块 D 依赖块 A 的 PR-A~D 先落地**（复用其存储契约：停写 raw_json / per-row 预计算 / covering 索引瘦身 / PRAGMA 4 处同步）。
  - ⚠️ **P1 解析列裁剪不在块 D 内、由独立 PR-P1 先做**（见 §6.1 AC-A7）：PR-P1 在收单 `reader-handrolled.js` 内实现列白名单 + allEmpty 等价判定 + 与 sax 基线的 byte-for-byte contract harness，不等引擎；引擎（PR-G/H）后续平移该实现并复用 harness。

#### 5.4.2 影响范围

- **后端**：新增 `src/backend/big-table-import/**`（暂名，引擎导入侧）；收单导入链路相关文件改为调用引擎（具体文件以引擎 spec 为准）。PR-P1 改 `src/backend/acquiring-bill-currency-import/reader-handrolled.js`（列白名单 + allEmpty 等价）。
- **前端**：无（导入挪 worker 后主界面可操作为体验改善，不新增 UI）。
- **数据 / schema**：复用块 A 既有存储契约，无新增 migration（以引擎 spec 为准）。
- **对外接口影响**：无新增 IPC（导入入口契约化，对外形态不变）。
- **兼容性影响**：🔴 收单导入链路换引擎 + PR-P1 改解析裁剪——均以 byte-for-byte contract test 为放行闸；其他模块不迁、零影响。

#### 5.4.3 UI Mockup（如适用）

无（引擎为后端抽取；导入挪 worker 仅改善导入期间主界面响应性，无新增界面）。

---

## 六、验收标准

> 本章节共 **20 条** AC（块 A 7 条 / 块 B 6 条 / 块 C 3 条 / 块 D 4 条）。块 A 的完整 PR 级验收/回滚另见 `changes/acquiring-import-recon-perf/spec.md §九`；块 D 以 `changes/big-table-import-engine/spec.md` 为准。

### 6.1 块 A：收单导入/对账性能 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC-A1 | 🔴 P0-1/P0-4 前后对同一 fixture 跑全流程（导入→对账→writer 输出），runs 统计行 / diff_rows 全表 / diff.xlsx 内容 **byte-for-byte 一致**（spec §六-1 资金红线放行闸） |
| AC-A2 | PR-A：flow `insertFlowRow` 写 `raw_json=''`（无 migration、存量行不动）；bill 字段映射预计算等价；`computeRunStats` 新旧 4 字段全等（空表/全 match/全 mismatch/NULL+'' 币种/多月共存）；bench flow INSERT ≥4x、bill ≥1.7x（Mac 口径） |
| AC-A3 | PR-B：幂等 migration 删 4 冗余索引 + 建 2 covering v2 索引；EXPLAIN QUERY PLAN 全部 acquiring SQL 无全表扫描回归（`USING [COVERING] INDEX`）；对账结果与迁移前一致；bench 对账段 ≥1.8x（Mac 口径） |
| AC-A4 | PR-C：`temp_store=MEMORY` 4 处 PRAGMA 清单 diff 一致 + worker verify 通过；导入大事务后 `wal_checkpoint(TRUNCATE)`（失败仅日志不影响导入）；`MULTIWORKER_MIN_TOTAL_ROWS`=300000，手测 30w+ 行对账走多 worker（无 fallback 诊断字段） |
| AC-A5 | PR-D：win32 且导出目录含 OneDrive → 启动单次 `Notification` 提示；settings 防重 key 置位后不再重复提示；非 win32 / 非 OneDrive 路径不提示 |
| AC-A6 | `npm run release-check` 全绿（unit + integration + smoke，含 v2.1.10 a3/a4、v2.1.12 contract）；每 PR 前 `/check-vars` + 版本 bump 前 `npm run scan:vars` |
| AC-A7 | PR-P1/P1b 解析列裁剪（**2026-06-10 五次修订收口**）：列白名单 + 直接定位 + allEmpty 等价判定 + 与 sax 基线 byte-for-byte 三方 contract harness 全部落地、三层测试全绿；解析段实测 **1.20x**（50w：12.0s→9.98s，bench 含物理地板解剖留档 `tmp/bench-p1-whitelist.js`）。原 ≥1.5x 目标经实测解剖证明在当前行切块架构下不可达（上限 ~1.4x），**剩余性能债务转块 D PR-G 量化目标**（字节层 row-scanner 单文件 ≥2x + 多文件并行 ≈3x），harness 供 PR-G/H 复用 |

### 6.2 块 B：状态框「渠道:场景序号」明细 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC-B1 | 多渠道命中时状态框按 channelName 分组、每渠道一行、组内 displayIndex 顿号连接、半角冒号（如 `JPM:1、3` / `CITI:2`） |
| AC-B2 | 🔴 去重键改 `` `${channelId}:${scenario.id}` `` 后，同一场景在第二个渠道命中**不再被吞**（双维路径各渠道各保留一条） |
| AC-B3 | 🔴 旧 `processingResult` 持久化数据（无 channelName）→ 状态框 fallback 现状格式 `场景 1、3`，不报错 |
| AC-B4 | 🔴 legacy 单维路径结构保持不变（21+ 测试 0 regression）；`scenarioHitCount` 原语义不变 |
| AC-B5 | 状态框 `#bankStatementStatusBox` 加 max-height（≈140px ≈ 7 行）+ overflow-y:auto；多渠道多行时不撑高推挤 control-row，滚动到顶可见第一行（必要时覆盖 align-items） |
| AC-B6 | dispatcher unit 覆盖新结构 + 新去重键 + 多渠道命中 fixture + legacy 不回归；`npm run preview` 回归通过（前端硬约束） |

### 6.3 块 C：USER_GUIDE 补全 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC-C1 | USER_GUIDE 新增 6 章节齐全：①数据备份与恢复 ②设置参数指南 ③错误排查与日志查看 ④链接表管理操作详解（从 §1.4 独立成节）⑤场景管理通用指南（C1-C4 对比/优先级 0-3/渠道分组/新建流程）⑥Windows 性能建议（块 A 性能批次部分合流） |
| AC-C2 | §1.4 等术语密集章节完成口语化改写：版本演进收拢、正文改操作视角大白话、保留 ⭐/🔴 标记惯例 |
| AC-C3 | 块 C 不动任何代码；块 A PR-D 的 Windows 性能建议在 ⑥ 统一收口（PR-D 不再单独改 USER_GUIDE） |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 块 A 收单全链资金红线 | 30w 行真实流水/单据 → 导入 → 对账 → diff.xlsx | 改动前后各跑一次 | 耗时下降；runs 统计 / diff_rows / diff.xlsx byte-for-byte 一致（AC-A1） |
| 块 A 多 worker 闸生效 | 30w+ 行对账 | W3 生效 | progress 出现 multiWorker 路径、无 fallback 诊断字段（AC-A4） |
| 块 A 索引迁移 | 老 schema 库启动 | 存量库 | P0-3 migration 跑通、对账结果与迁移前一致、EXPLAIN 无回归（AC-A3） |
| 块 B 多渠道分组显示 | 多渠道场景跑批 | ≥2 渠道、同场景跨渠道命中 | 状态框按渠道分组 `JPM:1、3 / CITI:2`、同场景第二渠道不被吞（AC-B1/B2） |
| 块 B 旧数据 fallback | 加载旧 processingResult（无 channelName） | 历史落库数据 | 状态框 fallback 现状格式 `场景 1、3`、不报错（AC-B3） |
| 块 B 滚动护栏 | 多渠道多行命中（>7 行） | — | 框内出现滚动条、不推挤 control-row、滚动到顶可见第一行（AC-B5） |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 块 A OneDrive 提示 | win32 导出目录置于 OneDrive 路径 | win32 | 启动单次 Notification 提示、防重 key 生效（AC-A5） |
| 块 A bench 复跑 | `tmp/bench-acquiring-opt.js` 改动前后 | — | flow INSERT ≥4x / bill ≥1.7x / 对账段 ≥1.8x（Mac 口径）（AC-A2/A3） |
| 块 B legacy 单维不回归 | 单维路径跑批 | — | legacy hitScenarios 结构不变、scenarioHitCount 语义不变（AC-B4） |
| 块 C 手册可读性 | 阅读新增章节 + §1.4 口语化 | — | 6 章节齐全、§1.4 大白话、⭐/🔴 标记保留（AC-C1/C2） |

### 7.3 不测项与原因

- 块 A P1 解析列裁剪 / 通用引擎抽取：本迭代不做（非目标 §2.3），无需测。
- 块 A 500w 行量级：本迭代标尺 30-50 万行；500w 推演见 spec §八（阶段 2），不在本迭代测。
- 块 B R1/R4/R5 命中显示：R1/R4/R5 不进 hitScenarios（orchestrator 独立统计字段），范围不变，不测。
- 块 B 对账算法 / 行改写：本迭代仅改展示层 + hitScenarios 统计结构，不动对账逻辑，无需回归其算法。
- 块 C：纯文档，无功能测试（以 review 为准）。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 块 A：P0-1 无 migration（`raw_json TEXT NOT NULL` 由 `''` 满足、存量行不动）；P0-3 幂等索引 migration（DROP 4 冗余索引 + CREATE 2 covering v2 `(month_key, recon_main_id, settle_currency_norm)`）。块 B：hitScenarios 运行态/持久化元素新增 `channelId`/`channelName`，无 DB schema/migration。块 C：无。 |
| 状态流转变更 | 块 A：导入大事务 COMMIT 后新增 `wal_checkpoint(TRUNCATE)`（失败仅日志、不改导入成功语义）；多 worker 闸 100w→30w（仅影响快慢、不影响结果，单/多 worker byte-for-byte contract 已锁）。块 B：hitScenarios 去重键 `scenario.id`→`渠道:场景id`（去重粒度变细、命中计数口径不变）。块 C：无。 |
| 权限 / 安全 | 不涉及鉴权 / 敏感数据外发。🔴 红线在块 A：①收单导入是金额/币种入库真理源（P0-1 停写 raw_json + P0-2 预计算不得改变入库值）；②对账 SQL（P0-4 单遍 JOIN stats + P0-3 covering 不得改变对账结果）——以 §六 AC-A1 byte-for-byte contract 为放行闸。块 B 改资金对账处理模块展示层 + hitScenarios 统计结构（不改对账逻辑/行改写，需 fallback 兼容旧落库数据）。 |
| 回滚策略 | 块 A：PR-A 单 commit revert（无 schema/数据迁移）；PR-B 反向 migration（DROP v2 + 重建旧 4 索引，回滚 commit 保留旧建索引段供 IF NOT EXISTS 自愈）；PR-C 三项互不依赖可独立 revert（W3 = 常量改回）；PR-D revert。块 B：dispatcher/renderer/CSS 各自 revert（去重键/格式还原；渠道字段为新增可选，旧消费方忽略）。块 C：文档 revert。建议在 `docs/ROLLBACK.md` 补 v3.0.3 段。 |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 块 A：P0-1 存量行 raw_json 不动（仅新导入写 `''`）；P0-3 migration 幂等、新老库一致。块 B：旧 processingResult（无 channelName）renderer fallback 现状格式；legacy 单维路径结构不变（21+ 测试 0 regression）；hitScenarios 新增字段对旧消费方为可选。块 C：纯文档无兼容问题。 |
| 性能 | 块 A 是性能需求本体：30-50 万行流水导入 ~9-14s（1.5x）、对账 DB 段 ~0.3-0.45s（2.2x）、单月库 ~50-80MB（×0.08）；Windows 写放大链 ×0.08；多 worker 在 30w+ 生效叠加多核。块 B 展示层改动不引入额外对账开销（仅 push 时多带两字段、去重键字符串拼接）。 |
| 鲁棒性 | 块 A：W2 checkpoint 失败仅记日志不抛、不影响导入成功语义；PRAGMA 4 处同步防主/worker 漂移；P0-4 空集 `SUM()` 必带 `COALESCE(...,0)`、币种比较谓词与 chunked INSERT 同源防漂移。块 B：renderer 对缺 channelName 数据 fallback、状态框 max-height+滚动护栏防爆框。 |

---

## 十、待澄清问题

> 块 A 关键决策已在 `changes/acquiring-import-recon-perf/spec.md §四` OPEN 决策表全部拍板（O-1~O-7）；块 B/C 设计已由 team-lead 调研定案。本迭代需求层面无未决项，仅余开工前提。

- [ ] **块 A 开工前提**：用户完成 `changes/acquiring-import-recon-perf/spec.md §九` 离线 review（review 通过 PR-A~D 才开工）。
- [x] **块 A O-4 版本归属** ✅ 已决（2026-06-10 二次修订）：纳入 v3.0.3 迭代（原「并入 v3.0.2」修订为本迭代）。
- [x] **块 A O-1 flow raw_json 永久停写** ✅ 已决（零消费实证；diff 快照列已够；存量数据不动）。
- [x] **块 A O-2 W3 闸值 100w→30w 本批合入** ✅ 已决（POC 50w plan-b 2.31-2.70x；D33 内存闸 + workerCount settings 兜底）。
- [x] **块 A O-3 W5 形态** ✅ 已决：启动检测提示 + USER_GUIDE 文档（USER_GUIDE 部分合流块 C PR-F）。
- [x] **块 B 去重键 / 格式 / fallback** ✅ team-lead 调研定案：去重键 `渠道:场景id`、按 channelName 分组半角冒号、旧数据 fallback 现状格式、legacy 单维路径不变。
- [x] **块 B 状态框爆框护栏** ✅ 已评估（2026-06-10）：水平不溢出；垂直用 max-height（≈140px≈7行）+ overflow-y:auto。
- [x] **块 C 范围** ✅ 定案：6 新章节 + §1.4 口语化；块 A Windows 性能建议合流块 C ⑥。

---

## 十一、风险提示（人工复核）

> 🔴 资金红线：块 A 落在收单金额/币种入库真理源 + 对账 SQL；块 B 改资金对账处理模块展示层 + hitScenarios 统计结构。实施与评审务必逐项复核。

🔴 **资金红线**

1. **块 A 收单导入/对账**（落在金额/币种入库真理源 + 对账 SQL）：P0-1 停写 raw_json / P0-2 预计算不得改变入库值；P0-4 单遍 JOIN stats / P0-3 covering 不得改变对账结果——以 §六 **AC-A1（同 fixture 全流程 byte-for-byte）** 为放行闸。完整风险清单（PRAGMA 4 处同步、migration 在存量库 DROP/CREATE、W2 checkpoint 失败容忍）见 `changes/acquiring-import-recon-perf/spec.md §七`。**开工前提 = 用户完成 spec §九 离线 review**。
2. **块 B 改资金对账处理模块**：🔴 仅改**展示层 + hitScenarios 统计结构，不改对账逻辑、不改行改写**。hitScenarios 消费方 = ①状态框（实时展示）②`processingStats` 持久化读回（历史落库数据）——**改结构必须 fallback 兼容**（renderer 对无 channelName 的旧数据回退现状格式）。🔴 **legacy 单维路径结构不变**（21+ 测试 0 regression 硬约束）：去重键/渠道字段只加在双维路径。

⚠️ **流程 / 兼容**

- 块 A 与块 B 都涉「资金对账」字样，但代码路径不重叠：块 A 在收单单据模块（acquiring-bill-currency），块 B 在资金对账数据处理模块（bank-statement 主链路 scenario-dispatcher 展示层，非业务OP数据核对 biz-op-recon）。
- 块 C 的 USER_GUIDE「Windows 性能建议」与块 A PR-D 原计划的 USER_GUIDE 改动合流于块 C PR-F，避免两处分别动 USER_GUIDE 冲突。
- **每个 PR 前** `npm run scan:vars` + `/check-vars`（块 A 触及导入/对账重要变量；块 B 触及 hitScenarios / processingResult 展示统计）；前端改动（块 B renderer/CSS）重跑对应 `npm run preview`。

---

## 十二、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-10 | 初稿：建立 v3.0.3 迭代 PRD，统筹 3 块需求（块 A 收单导入/对账性能批次 — 引用 `changes/acquiring-import-recon-perf/spec.md §九`，O-4 已改纳入 v3.0.3；块 B 资金对账数据处理模块状态框「渠道:场景序号」明细 — dispatcher 新结构+新去重键 / renderer 分组格式+fallback / CSS 护栏；块 C USER_GUIDE 重点补缺 6 章节 + §1.4 口语化）。AC 共 15 条（块 A 6 / 块 B 6 / 块 C 3）；非目标含 P1 解析列裁剪暂缓、通用引擎阶段 2 不在本迭代、W4 导入挪 worker 另案；里程碑 PR-E/F 先行、PR-A~D 待用户 §九 review。块 B/C 由 team-lead 调研定案，块 A 设计照 `acquiring-import-recon-perf/spec.md` |
| 2026-06-10（二） | **范围扩张（用户 §九 review 通过后拍板）**：新增块 D = 通用大表导入引擎抽取（仅导入侧）+ P1 解析列裁剪转独立 PR-P1 先做 + W4 导入挪 worker 经引擎达成——三项原非目标全部纳入本迭代。块 D 实施级设计另立 `changes/big-table-import-engine/spec.md` |
| 2026-06-10（三） | **实施收尾**：四块 / 10 PR 全部落地，release-check 全绿（详见下方「十三、实施记录」） |

## 十三、实施记录（2026-06-10 收尾）

四个块全部实施完成并验收：`npm run release-check` exit 0（unit **2179/2179**、integration **22 脚本 1086/1086 断言**、smoke 全模块 PASS）。

| PR | 块 | 交付 | 关键验收数字 |
|----|----|------|-------------|
| PR-A | A | flow raw_json 永久停写（O-1）+ bill 模板键列预计算 | flow 导入段 **6.36x** |
| PR-B | A | 索引瘦身 v2 迁移（DROP 4 + 2 covering）+ 单遍 JOIN stats | 对账统计段 **5.2x**；chunked SQL byte-identical |
| PR-C | A | PRAGMA temp_store 契约补齐 ×2 + W2 COMMIT 后 checkpoint + 多 worker 阈值 30w（O-2） | pragma smoke 27/27 |
| PR-D | A | Windows OneDrive 存储检测一次性提示（W5/O-3） | unit 全绿 |
| PR-P1 | A | 解析列白名单（flow 4/48）+ 直接定位 + 三方 contract harness | 解析段 **1.20x** 收口（O-5 五次修订：实测天花板 ~1.4x，债务转 PR-G） |
| PR-E | B | hitScenarios +channelId/channelName、去重键 `${channelId}:${scenario.id}`、状态框按渠道分组换行 + fallback + max-height 滚动护栏 | dispatcher 既有 21+ 测试 0 回归；preview 已回归 |
| PR-F | C | USER_GUIDE 6 新章节 + §1.4 口语化 | 文档自查通过 |
| PR-G1 | D | 引擎核心：zip-reader（rels 正解 + 多 sheet 显式报错）/ row-scanner **单遍字节状态机** / contract 白名单三层防护 | 50w 解析段 4.26s vs P1b 9.87s = **2.32x**（偿清 P1 债务）；四方 harness 全等 |
| PR-G2 | D | 管道 + worker 化：多文件并行解析 + 按文件序单写 + cancel + PRAGMA 第 5 处 + 内存闸 | 4-worker **3.06x**；并行=串行 byte-for-byte 含 rowid；cancel<5s |
| PR-H | D | 收单首迁：契约模块 contract-flow/bill + session dispatch 引擎 worker + **单行回退开关 `USE_BIG_TABLE_IMPORT_ENGINE`** | 全链对比 **34 断言** byte-for-byte（六场景）；50w 端到端 11.2s→7.3s（1.53x）；**W4 达成**（导入全程主进程零阻塞） |

**已知限制（记录在案）**：
1. 100w 单文件解析 1.96x，略低于 2x 目标（差 1.6%，单遍扫描需过全部 48 cell 结构的运行时约束；50w 验收基准 2.32x 达标；多文件并行 3.06x 叠加后对 500w 端到端目标无影响）
2. 引擎 v1 不拆分逐文件 importedCount，session 返回的 perFileStats 为占位数组（现有 renderer 不消费该字段，安全）
3. 🔴 金额/币种解析函数（`parseAmountAbs`/`normalizeCurrency`）在 contract-flow/bill 与 import-repository 为双副本：**改任一侧必须同步另一侧**——`acquiring-engine-migration.js` 集成脚本（新旧两路 byte-for-byte）+ `rules/important-variables.md` Critical 条目已锁

**Review 修复（commit 54d8107，PR #70 合并前 codex+自查双轮）**：
1. 契约 mapRow 前置账单日期校验——坏日期行原报「跨月份混杂：期望 X，实际 null」，修复后与旧 reader 逐字符一致（「账单日期无法解析为月份："bad"」，校验顺序对齐旧 reader：日期最先）
2. peekImportTarget 引擎开关 true 时走 `engine.peekFirstFile`（rels 正解）——修复前唯一 sheet 非 sheet1.xml 命名的合法文件在预检即被旧 reader 拒绝，引擎 rels 防御项主 UI 流程不可达
3. peekFirstFile API 防呆：白名单数组自动归一 Set + errorName 改名下沉（修复中暴露的两个隐藏 bug，分别被迁移脚本场景⑧与 smoke H3 抓住）
4. 迁移对比集成脚本 34 → **45 断言**（新增场景⑦中途行坏日期两路逐字符相等、场景⑧ sheet2.xml 命名文件引擎可达）

> PR #70 已于 2026-06-10 合并进 main（merge commit）；PR body 归档于 `docs/prs/PR70-v3.0.3.md`（integrated: true）。
