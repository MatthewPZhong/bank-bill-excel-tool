# Spec — v3.0.3 迭代（收单导入/对账性能批次 + 状态框「渠道:场景序号」明细 + USER_GUIDE 补全）

> 状态：**已完成**（四个块 / 10 个 PR 全部实施并 release-check 全绿：unit 2179 / integration 22 脚本 1086 断言 / smoke 全模块 PASS）｜ 来源分支：`v3.0.2` → `v3.0.3` 开发分支 ｜ 目标版本：**3.0.3**
> 性质：🔴 含资金敏感区（块 A 收单导入/对账落在金额/币种入库真理源 + 对账 SQL；块 B 改资金对账处理模块展示层 + hitScenarios 统计结构）。
> **本 spec 为 v3.0.3 迭代变更目录入口**，统筹三块相对独立的需求；产品需求见 `docs/iterations/v3.0.3/PRD-v3.0.3.md`。

---

## 一、本迭代 3 块需求与依赖关系

| 块 | 需求 | 一句话 | 性质 | 实施级 spec |
|----|------|--------|------|-------------|
| A | 收单单据模块导入/对账性能优化（P0 跨平台 + W Windows 专项） | flow 停写 raw_json + 预计算 + 索引瘦身 + 单遍 JOIN stats + PRAGMA/checkpoint/闸值 + OneDrive 提示 | 🔴 资金红线 | `changes/acquiring-import-recon-perf/spec.md`（§九 PR-A~D） |
| B | 资金对账数据处理模块状态框显示「渠道:场景序号」明细 | 状态框 `场景 1、3` 多渠道下有歧义 → 改 `JPM:1、3 / CITI:2` 按渠道分组 | 🟡 展示层 + hitScenarios 统计结构（带 fallback 兼容） | 本 spec §三 |
| C | USER_GUIDE 重点补缺 + 口语化 | 新增 6 章节（备份恢复/设置/排错/链接表/场景管理/Windows 性能）+ §1.4 等术语密集章口语化 | 🟢 纯文档 | 本 spec §四 |
| D | 通用引擎抽取（导入侧）+ 收单迁移（P1 列裁剪 + W4 挪 worker 经此达成） | yauzl 基座参数化 + 列白名单 + 多文件 worker 并行管道 + 收单首迁 | 🔴 资金红线（导入链路换引擎，byte-for-byte contract 锁） | changes/big-table-import-engine/spec.md（撰写中） |

**依赖关系**：

- 三块**相对独立、无强耦合**，可并行实施。
- 块 A 与块 B 都触及「对账」字样，但作用面不同：块 A 在**收单单据币种校验模块**（acquiring-bill-currency，独立的导入/对账子系统）；块 B 在**资金对账数据处理模块**（bank-statement 主链路：reconciliation-orchestrator / scenario-dispatcher 的展示层 + hitScenarios；⚠️ 不是「业务OP数据核对」biz-op-recon）——二者代码路径不重叠。
- 块 C 块 A 的 Windows 性能建议（性能批次 PR-D 原计划写入 USER_GUIDE 的「Windows 性能建议」一节）**合流到块 C 的「⑥ Windows 性能建议」章节**，避免两处分别动 USER_GUIDE 造成冲突——即 PR-D 不再单独改 USER_GUIDE，由 PR-F 统一收口（详见 §五 PR 编排）。
- **块 D 依赖块 A**：块 D（通用引擎导入侧抽取 + 收单迁移）**依赖块 A 的 PR-A~D 先落地**——引擎复用块 A 确立的存储契约（停写 raw_json / per-row 预计算 / covering 索引瘦身 / PRAGMA 4 处同步），收单作为引擎的首个迁移用户，迁移后导入结果须与块 A 落地后的产物 byte-for-byte 一致。引擎**仅做导入侧**；对账侧 keyset 分页不在本迭代（30w 量级 OFFSET 无感，留 500w 模块），与块 A §八阶段 2 中的 keyset 一致不做。

---

## 二、块 A：收单导入/对账性能批次（引用，不复制）

> 块 A 的现状/瓶颈定位、改造方案、预期效果、OPEN 决策、实施级详细设计（PR-A~PR-D 的改动点/测试/验收/回滚）**全部见** `changes/acquiring-import-recon-perf/spec.md`，本 spec 不复制其内容。

- **设计与 PR-A~D 编排**：见该 spec **§九 实施级详细设计**（PR-A 停写 flow raw_json + 预计算 + stats 合并；PR-B 索引瘦身 + covering；PR-C W1 temp_store + W2 checkpoint + W3 闸值；PR-D W5 OneDrive 检测提示 + USER_GUIDE）。
- **🔴 开工前提**：用户完成该 spec **§九 离线 review**（O-4 二次修订已决：纳入 v3.0.3 迭代）。在用户 review 通过前，PR-A~D 不开工。
- **版本归属**：该 spec O-4 已更新为「纳入 v3.0.3 迭代」，顶部状态头目标版本指回本 spec。
- **USER_GUIDE 收口调整**：PR-D 原含的 USER_GUIDE「Windows 性能建议」改由块 C 的 PR-F 统一写入（§一依赖关系已述）；PR-D 仅保留 `main.js` OneDrive 检测提示 + settings 防重 key 部分。

---

## 三、块 B：状态框「渠道:场景序号」明细（详细设计 · 已定案）

### 3.1 现状与根因（已查实）

- **状态框现状**：资金对账数据处理模块状态框 `bankStatementStatusBox` 运行后显示 `已处理：45 行命中（场景 1、3），3 警告`（`src/renderer.js` ~3409-3413）。
- **displayIndex 语义**：`displayIndex` 是**每渠道内 1-based 序号**（v2.1.8 N3-D1 与场景管理 UI 序号统一）。多渠道下「场景 1」**有歧义**——不同渠道各自有「场景 1」，用户无法区分。
- **hitScenarios 产出**：由 R2 dispatcher 产出（`scenario-dispatcher.js` `runChannelBatch` ~:343 / legacy ~:196），元素结构 `{id, displayIndex, name}`，**无渠道字段**。
- **去重缺陷**：hitScenarios **按 `scenario.id` 去重**——但场景与渠道是**多对多**（`scenario_applicable_channels` 表）；同一场景在第二个渠道命中时会被**去重吞掉**（看不到它在第二个渠道也命中了）。
- **范围边界**：R1/R4/R5 **不进** hitScenarios（orchestrator 有独立统计字段），本需求范围不变。

### 3.2 改动点（三处）

**改动点 1 · `src/main-process/scenario-dispatcher.js`（双维路径）**

- hitScenarios 元素**加 `channelId` / `channelName`**：push 处从当前批次 channel 上下文取（`runChannelBatch` 的渠道循环已持有当前 channel）。
- **去重键** `scenario.id` → `` `${channelId}:${scenario.id}` ``：同场景在不同渠道命中各自保留一条，不再被吞。
- `scenarioHitCount` **原语义不动**（仍是命中场景计数口径，不随去重键变化语义）。
- **legacy 单维路径**（~:196）**结构保持不变**（21+ 测试 0 regression 硬约束）：legacy 不加渠道字段；renderer 对**无 channelName 的数据 fallback 旧格式**。

**改动点 2 · `src/renderer.js`（状态框格式）**

- 格式改为按 `channelName` 分组、每渠道一行、组内 `displayIndex` 顿号连接、半角冒号：

  ```
  已处理：45 行命中（场景
  JPM:1、3
  CITI:2），3 警告
  ```

- **fallback**：旧 `processingResult` 持久化数据（无 `channelName`）→ **回退现状格式** `场景 1、3`（兼容历史落库数据）。

**改动点 3 · `src/styles-gemini-extra.css`（状态框护栏）**

- `#bankStatementStatusBox` 加 `max-height`（≈140px ≈ 7 行）+ `overflow-y: auto`。
- ⚠️ status-box 是 `flex` `align-items: center`；多行滚动时需**验证顶部内容可达**（必要时覆盖 `align-items`，保证滚动到顶能看到第一行）。

### 3.3 爆框评估结论（2026-06-10 已评估）

- **水平**：不会溢出（`width: 100%` + `pre-line` 换行）。
- **垂直**：无 `max-height` 时多行会**自动撑高、推挤 control-row**；渠道×场景组合理论无上限（典型 3-8 行）。
- **护栏** = `max-height` + 滚动（改动点 3）。

### 3.4 测试

- **dispatcher unit**：覆盖新结构（含 channelId/channelName）+ 新去重键（`channelId:scenarioId`）+ **多渠道命中 fixture**（同场景跨渠道各保留一条）+ **legacy 不回归**（单维路径结构不变）。
- **preview 回归**：`npm run preview`（前端硬约束）。
- **手测**：多渠道全链（导入 → 跑场景 → 状态框分组显示正确 + 滚动护栏生效）。

---

## 四、块 C：USER_GUIDE 重点补缺 + 口语化（范围 · 已定案）

> 由专职 USER_GUIDE agent 负责正文撰写，本 spec 仅定范围与约束。预计 **+600-900 行**。

### 4.1 新增 6 章节

| # | 新增章节 | 内容要点 |
|---|---------|---------|
| ① | 数据备份与恢复 | SQLite DB / 导出 / balance-seeds / 模板库 等数据位置与备份恢复操作 |
| ② | 设置参数指南 | 各项设置参数含义与推荐值 |
| ③ | 错误排查与日志查看 | 错误报告位置、活动日志（`app_activity_log.txt`）查看、常见报错定位 |
| ④ | 链接表管理操作详解 | 从 §1.4 独立成节，专门讲链接表管理操作 |
| ⑤ | 场景管理通用指南 | C1-C4 对比 / 优先级 0-3 / 渠道分组 / 新建流程 |
| ⑥ | Windows 性能建议 | **块 A 性能批次 PR-D 的 USER_GUIDE 部分合流于此**（Defender 排除项、OneDrive 重定向、与本批次性能改进的关系） |

### 4.2 口语化改写

- `§1.4` 等**术语密集章节**口语化改写：
  - 版本演进**收拢**（把分散的版本演进说明归并）；
  - 正文改**操作视角大白话**（站在用户操作步骤角度，少术语）；
  - **保留 ⭐/🔴 标记惯例**（既有重要/红线标记不动）。

### 4.3 约束

- 块 C 是**纯文档**，不动任何代码。
- 块 A 的 Windows 性能建议在此统一收口（PR-D 不再单独改 USER_GUIDE）。

---

## 四之五、块 D：通用引擎抽取（导入侧）+ 收单迁移（范围 · 2026-06-10 立项）

> 2026-06-10 范围扩容：用户拍板把「通用引擎抽取」「P1 解析列裁剪」「W4 导入挪 worker」三项从「不做」反转为本迭代做。架构定盘：**P1 与 W4 不在收单模块内单独实现，而是作为通用引擎（导入侧）的两个内建能力，通过「引擎抽取 + 收单迁移为首个用户」一次性达成**（避免做两遍）。引擎实施级设计 spec 由 team-lead 另行撰写至 `changes/big-table-import-engine/spec.md`，本 spec 仅定范围与达成路径、不复制设计。

### 4.5.1 范围（本迭代做）

- **引擎导入侧抽取**：把收单现有 yauzl + 手写字节扫描解析、rels 正解 sheet 定位、prepared INSERT 管道、大事务/整批拒绝/peek 预检/覆盖导入/checkpoint 等机械部分抽成带契约参数的共享库（形态见引擎 spec），并内建两项能力——**列白名单**（解析时按契约裁剪取值列）+ **多文件 worker 并行解析 → 单写 INSERT 管道**。
- **收单迁移为首个用户**：收单单据模块改造为引擎的第一个迁移用户，其导入链路从「模块内自有 reader + 编排」切换到「声明契约 + 调用引擎」。
- **P1 / W4 经由引擎达成**：P1 解析列裁剪 = 引擎「列白名单」能力在收单契约上生效；W4 导入挪 worker = 引擎「多文件 worker 并行管道」在收单上生效。二者不在收单 reader 内单独写一遍。

### 4.5.2 不做（本迭代非目标）

- **对账侧 keyset 分页不做**：引擎本迭代**只做导入侧**；对账侧 keyset 分页（OFFSET→keyset）仍不做——30w 典型量级 OFFSET 无感，留给未来 500w 模块（与块 A §八阶段 2 / O 决策表一致）。
- **其他模块迁移引擎不做**：除收单外的存量导入模块（pending 挂账 / biz-op 业务OP / vcc / linked-table 等，见块 A spec §8.5 适配清单）迁移引擎**不在本迭代**，留后续迭代。

### 4.5.3 P1 / W4 的达成路径（说明）

| 原独立项 | 本迭代达成方式 | 落点 |
|---------|---------------|------|
| P1 解析列裁剪（flow 仅需 4/48 列） | 引擎「列白名单」内建能力 + 收单契约声明取值列 | 引擎导入侧 + 收单迁移契约 |
| W4 导入挪 worker | 引擎「多文件 worker 并行解析 → 单写 INSERT 管道」 + 收单首迁 | 引擎导入侧 + 收单迁移 |

### 4.5.4 依赖与设计引用

- **依赖块 A**：块 D 依赖块 A 的 PR-A~D 先落地——引擎复用块 A 确立的存储契约（停写 raw_json / per-row 预计算 / covering 索引瘦身 / PRAGMA 4 处同步）；收单迁移后导入结果须与块 A 落地后产物 **byte-for-byte 一致**（contract 锁）。
- **设计引用**：引擎实施级设计（yauzl 基座参数化、列白名单、多文件并行管道、PR-G/H 拆分、contract test harness 等）见 `changes/big-table-import-engine/spec.md`（team-lead 撰写中），本 spec 不复制。

---

## 五、实施编排（PR 级）

> 小批次约束：单 PR ≤ 3-5 文件；commit message 格式 `[v3.0.3] <简述>`（不加 AI 署名）。

| PR | 块 | 内容 | 涉及文件 | 前提 / 顺序 |
|----|----|------|---------|------------|
| **PR-E** | B | 状态框渠道:场景明细：dispatcher（新结构 + 新去重键）+ renderer（分组格式 + fallback）+ CSS（max-height + 滚动）+ dispatcher unit + preview 回归 | `scenario-dispatcher.js`, `renderer.js`, `styles-gemini-extra.css`, `tests/unit/**`, （preview 回归） | ✅ **已完成**：hitScenarios 加 channelId/channelName + 去重键 `${channelId}:${scenario.id}`；renderer 按渠道分行 `JPM:1、3`/`CITI:2` + 无 channelName fallback 旧格式；CSS max-height 140px + 滚动；legacy 单维 0 regression；preview 已回归 |
| **PR-F** | C | USER_GUIDE 重点补缺 + 口语化（6 新章节 + §1.4 等口语化；块 A Windows 性能建议合流于此） | `docs/USER_GUIDE.md` | ✅ **已完成**：新增 6 章（备份恢复/设置/排错/链接表/场景管理/Windows 性能）+ §1.4 术语段口语化（保留 ⭐/🔴 标记） |
| **PR-A** | A | P0-1 停写 flow raw_json + P0-2 预计算 + P0-4 stats 合并 + unit/contract | `import-repository.js`, `run-repository.js`, `tests/unit/**` | ✅ **已完成**：flow raw_json 永久停写（恒写 `''`、无 migration、存量不动）+ bill 键列下标预计算 → **flow 导入段 6.36x**；stats 单遍 JOIN + COALESCE 空集守卫 |
| **PR-B** | A | P0-3 索引瘦身 + covering 升级 + EXPLAIN 验证 | `migrations.js`, `scripts/integration/**` | ✅ **已完成**：DROP 4 冗余索引 + 建 2 covering 索引；3 次 JOIN 合 1 → **对账统计段 5.2x**；EXPLAIN 无全表扫描回归 |
| **PR-C** | A | W1 temp_store + W2 checkpoint + W3 闸值（PRAGMA 4 处同步） | `database.js`, `run-check-worker.js`, `run-check-multiworker-worker.js`, `import-worker.js`, `acquiring-bill-currency-session.js` | ✅ **已完成**：`temp_store=MEMORY` 补齐（run-check-multiworker-worker + biz-op import-worker 两处）+ 收单导入 COMMIT 后 `wal_checkpoint(TRUNCATE)`（W2）+ 多 worker 阈值 30w 行（O-2 直接合入） |
| **PR-D** | A | W5 OneDrive 检测提示 + settings 防重 key（USER_GUIDE 部分移交 PR-F） | `main.js`, settings-repository（防重 key） | ✅ **已完成**：Windows OneDrive 存储检测一次性提醒（W5/O-3）；USER_GUIDE 部分由 PR-F 收口 |
| **PR-P1** | A | P1 解析列裁剪（O-5 四次修订 2026-06-10：**独立先做，不经引擎**）：收单 reader-handrolled 内列白名单（4/48 列）+ allEmpty 等价判定 + 与 sax 基线 byte-for-byte contract harness | `reader-handrolled.js`, `tests/**`（harness，供 PR-H 复用） | ✅ **已完成**：列白名单（flow 4/48）+ 直接定位 → 解析段 **1.20x** 收口（O-5 五次修订：实测天花板 ~1.4x，性能债务转块 D PR-G 字节层；harness 已供 PR-G/H 复用） |
| **PR-G1** | D | 引擎核心（zip-reader + row-scanner + contract 三层防护）纯新增不接线 | `src/backend/big-table-import/{zip-reader,row-scanner,contract}.js` + unit | ✅ **已完成**：zip-reader rels 正解定位唯一 sheet（多 sheet 显式报错）+ 🔴 row-scanner **单遍字节状态机**（Buffer 扫 `<row` + 白名单 ref 串直接定位 + 局部解码）+ contract 三层防护；**50w 解析段 4.26s vs P1b 9.87s = 2.32x**（偿清 P1 债务）；四方 harness（sax≡手写全列≡P1b≡引擎）全等 |
| **PR-G2** | D | 管道 + worker 化（engine/pipeline/import-worker + pool dispatch）纯新增 | `src/backend/big-table-import/{engine,pipeline,import-worker,engine-worker-entry}.js` + 集成脚本 | ✅ **已完成**：多文件并行解析 → 按文件序单写 INSERT（rowid 序=串行 byte-for-byte）；**4-worker 3.06x**、cancel<5s、PRAGMA **第 5 处契约**、内存闸（freemem<2GB 降并行度） |
| **PR-H** | D | 收单迁移为引擎首个用户（**W4 挪 worker 经此达成**）+ byte-for-byte contract test（复用 PR-P1 harness） | contract-flow/bill.js + `acquiring-bill-currency-session.js` + 集成回归 | ✅ **已完成**：契约模块 contract-flow（白名单 `{0,6,28,29}`）/bill（全列）；session dispatch 引擎 worker（接口对 main.js 不变）；🔴 **单行回退开关 `USE_BIG_TABLE_IMPORT_ENGINE`**；新旧全链对比集成脚本 **34 断言**（成功/UNIQUE 冲突/跨月/坏表头/overwrite/bill raw_json 六场景逐行含 rowid + 报错逐字符 byte-for-byte）；**50w 端到端 11.2s→7.3s（1.53x）**，导入全程主进程零阻塞（**W4 达成**） |

> **版本号 bump 与文档三件套**：`package.json.version` bump 至 `3.0.3` + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）发版收尾时**统一**更新（中间 PR 不 bump、不动三件套——USER_GUIDE 的块 C 正文 PR-F 单独成 PR，但版本号条目在发版收尾时补）。

---

## 六、🔴 风险段（人工复核点）

### 6.1 块 A（引用）

- 块 A 的资金红线（P0-1/P0-4 落在金额/币种入库 + 对账 SQL）、PRAGMA 4 处同步契约、migration 在存量库 DROP/CREATE INDEX、W2 checkpoint 失败容忍——**全部见** `changes/acquiring-import-recon-perf/spec.md §七 风险清单 + §九 各 PR 验收/回滚**。开工前提 = 用户 §九 离线 review 完成。

### 6.2 块 B（状态框渠道:场景明细）

- 改动**仅在资金对账处理模块的展示层 + 统计结构**，**不改对账逻辑、不改行改写**（R1/R4/R5 独立统计字段不动，hitScenarios 仅供展示与持久化读回）。
- 🔴 **hitScenarios 消费方** = ① 状态框（实时展示）；② `processingStats` 持久化读回（历史落库数据）。**改结构必须 fallback 兼容**——renderer 对无 `channelName` 的旧数据回退现状格式（改动点 2 已含）。
- 🔴 **legacy 单维路径结构不变**（21+ 测试 0 regression 硬约束）：去重键/渠道字段只加在双维路径。

### 6.3 通用

- **每个 PR 前** `npm run scan:vars` + `/check-vars`（块 B 触及 hitScenarios / processingResult 等展示统计；块 A 触及导入/对账重要变量）。
- 前端改动（块 B renderer/CSS）提 PR 前重跑对应 `npm run preview`（前端硬约束）。

---

## 七、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-10 | 初稿：建立 v3.0.3 迭代变更入口，统筹 3 块需求（收单性能批次引用 / 状态框渠道:场景明细 / USER_GUIDE 补全）；块 A 引用 `acquiring-import-recon-perf/spec.md` §九（O-4 已改纳入 v3.0.3）；块 B 详细设计定案（dispatcher 新结构+新去重键 / renderer 分组格式+fallback / CSS 护栏）；块 C 范围定案（6 新章节 + §1.4 口语化，块 A Windows 性能建议合流）；PR 编排 PR-E/F 先行、PR-A~D 待用户 §九 review |
| 2026-06-10 | 范围扩容：用户 §九 离线 review 通过，PR-A~D 前提解除（开工中）；O-5/O-7/W4 三项从「不做」反转——通用引擎抽取（仅导入侧）+ P1 解析列裁剪 + W4 导入挪 worker 立项为**块 D**（P1/W4 经引擎「列白名单」「多文件 worker 并行管道」达成，收单为首个迁移用户）；块 D 依赖块 A，设计另见 `changes/big-table-import-engine/spec.md`（撰写中），追加 PR-G/H 占位；对账侧 keyset 仍不做 |
| 2026-06-10（二） | **P1 路径修订（用户拍板，O-5 四次修订）**：P1 从「经引擎达成」改为**独立 PR-P1 先做**（收单 reader-handrolled 内实现：列白名单 + allEmpty 等价判定 + 与 sax 基线 contract harness；收益立刻到手 + 单变量归因 + harness 先建供引擎 PR-H 复用）；W4 仍经引擎（PR-G/H）达成；PR 编排表同步（PR-P1 加入、PR-G/H 描述去 P1） |
| 2026-06-10（三） | **迭代收尾（全部实施完成）**：四个块 / 10 个 PR 全部落地并 release-check 全绿（unit 2179 / integration 22 脚本 1086 断言 / smoke 全模块 PASS）。块 A：flow 导入段 6.36x（PR-A）/ 对账统计段 5.2x（PR-B）/ PRAGMA temp_store + W2 checkpoint + 多 worker 30w 阈值（PR-C）/ OneDrive 提示（PR-D）/ 解析段 1.20x 收口（PR-P1，债务转块 D）。块 B：状态框渠道:场景分行 + fallback + 滚动护栏（PR-E）。块 C：USER_GUIDE 6 新章 + 口语化（PR-F）。块 D：PR-G1/G2/H 从占位转实施完成——引擎核心单遍字节状态机 2.32x（解析 50w 4.26s vs P1b 9.87s）、4-worker 并行 3.06x、收单首迁端到端 1.53x（11.2s→7.3s）、全链 34 断言 byte-for-byte、单行回退开关 `USE_BIG_TABLE_IMPORT_ENGINE`、W4 达成（导入全程主进程零阻塞）。PR 总表全部状态置 ✅ 已完成 |
