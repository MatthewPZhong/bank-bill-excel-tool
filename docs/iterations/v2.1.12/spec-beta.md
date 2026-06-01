# v2.1.12 β 阶段 Spec（总纲）

> 状态：draft v0.1（2026-05-31）｜阶段：β（性能架构）｜版本：`v2.1.12-beta.N` → 收敛 stable `v2.1.12`
> 立项结论见 `backlog.md`「立项拍板结论（v0.2）」§β 阶段；决策点 D29-D36 沿用 `docs/iterations/v2.1.11/backlog.md`。
> 起草方式：team-lead 接手起草（α 阶段经验：本环境 agent 多次中断，spec 这类基础件主线程直接写更稳）。
> ⚠️ 本阶段 = 🔴 **资金红线**（byte-for-byte 一致性）+ 🔴 **并发红线**（SQLite WAL single-writer / SQLITE_BUSY）+ 🟡 OOM。**Phase 0 POC 是进实现的硬门槛**。

---

## 1 β 范围总览

β = v2.1.12 立项时就规划、α 发布后顺延的**性能架构阶段**（`backlog.md:106-111`）。两个主题：

| 主题 | 内容 | 风险 | 粗估 |
|---|---|---|---|
| **A3-multi-worker** | 多 worker pool 并行 chunk + write-splitting，目标 acquiringBillCurrency 500w 行 18s → 7-9s（2-3x）| 🔴 SQLITE_BUSY / byte-for-byte / OOM · **必做 POC** | ~2 周 |
| **A3-spread** | `runCheckCore` 提取 + worker 化扩散到 bankBuRecon / bankStatement / reconIdFix | 🟡 各模块业务差异 | ~4 周 |

**β 合计粗估 ~6 周**，与立项一致。

### 1.1 分阶段交付建议（team-lead — 小批次执行 · CLAUDE.md 规则 5）

6 周一锤子风险高（资金红线 + 并发红线 + 跨 6 模块）。建议拆 3 个可独立发布的子阶段，每段一个 `-beta.N` + 各自 byte-for-byte 验收：

| 子阶段 | 范围 | 价值 | 依赖 | 粗估 |
|---|---|---|---|---|
| **β.1** | Phase 0 POC + **acquiringBillCurrency 多 worker**（已 worker 化，有真实 500w 行性能痛点）| 验证整个多 worker 前提 + 拿下核心加速 | 无（复用 v2.1.10 框架）| ~2 周 |
| **β.2** | **bizOpRecon + pending A3 化**（提取 runCheckCore + worker 入口）**+ 多 worker** | 两个还没 worker 化的对账模块并行 | β.1 多 worker 框架落地 | ~2 周 |
| **β.3** | **A3-spread**：bankBuRecon / bankStatement / reconIdFix worker 化（D36 可只做反馈最卡的）| 主进程不卡扩散 | β.1 框架 | ~2 周 |

> **team-lead 推荐**：先做 **β.1**（POC 是一切前提；acquiringBillCurrency 是唯一有实测 500w 行性能数据的模块）。
>
> ✅ **用户拍板（2026-05-31）：做完整 β**（β.1 + β.2 + β.3 三段全做，~6 周）。仍按 3 子阶段顺序推进（β.1 框架落地后才能复用到 β.2/β.3）；**POC-first 硬门槛对全 β 生效**（见 §5 / §8）。

### 1.2 不做边界（β）
- 不换 DB 引擎（DuckDB / PostgreSQL — `v2.1.11 backlog:54-55` 评估极高风险，明确不做）
- 不做 F5-cont C4 算法重写（立项❌不做，`backlog.md:93`）
- DB worker 跨线程共享连接（`node:sqlite` DatabaseSync 不支持，`backlog.md:60`）
- bill_imports / flow_imports 加 CASCADE 到 runs（资金真理源不可跟随 run 删，`backlog.md:60`）

---

## 2 代码现状（事实基础 · 有出处）

### 2.1 已落地：单 worker（v2.1.10 A3）

| 组件 | 文件 | 现状 |
|---|---|---|
| worker pool（单例）| `src/main-process/run-check-worker-pool.js` | **单 worker**，lazy init，crash recovery，op lock 互斥（同 monthKey）；`dispatchRunCheck` 一次只跑一个 job（`run-check-worker-pool.js:323` `if (activeJob) throw`）|
| worker 入口 | `src/main-process/run-check-worker.js:162` | 硬编码 `require('./acquiring-bill-currency-session')` + `session.runCheckCore` → **当前 worker 仅服务 acquiringBillCurrency** |
| 纯函数核心 | `src/main-process/acquiring-bill-currency-session.js:217` `runCheckCore({db,monthKey,storageRoot,onProgress,cancelToken,chunkSize,resumeFromRun})` | 无 Electron 依赖，worker / 主进程直调 byte-for-byte 一致（contract test 已有）|
| chunked 写入 | `acquiring-bill-currency-session.js:345` stage 4' | **`INSERT INTO diff_rows ... BY SQL JOIN`**：读和写在**同一条 SQL** 内，各 chunk 独立 BEGIN/COMMIT，chunkSize 默认 100000（`:227`）|
| DB 并发 PRAGMA | `run-check-worker.js:48-55` | worker 独立 connection + `busy_timeout=30000`（防写冲突 SQLITE_BUSY）|

### 2.2 未 worker 化（β 要做的）

| 模块 | 现状 | 子阶段 |
|---|---|---|
| **bizOpRecon** 业务运营对账 | 主进程同步，runCheck 未提取 runCheckCore | β.2 |
| **pending** 月度 pending 核对 | 主进程同步 | β.2 |
| **bankBuRecon** 单据对账 | 主进程同步 | β.3 |
| **bankStatement** 银行对账单生成 | 主进程同步 | β.3 |
| **reconIdFix** ReconID 修复 | 主进程同步 | β.3 |

> ⚠️ 注意：v2.1.11 backlog 曾写「bizOpRecon + pending 已在 v2.1.11 worker 化」(`v2.1.11 backlog:169`) — **与现状不符**：v2.1.11 实际只做了 T1/T2/T3，性能主线全部顺延。本 spec 以代码现状为准（reverse sync）。

### 2.3 write-splitting 的核心改造点（🔴 并发红线）

当前 stage 4' 是 `INSERT INTO diff_rows SELECT ... JOIN ...`（单 SQL 内完成读+写）。多 worker 并行直接跑这条 SQL → N 个 worker 同时 INSERT → SQLite WAL single-writer → **SQLITE_BUSY 30s 等待**。

write-splitting 改造（`v2.1.11 backlog:70-82`）：
```
主进程：按 OFFSET/LIMIT 拆 N chunks → 分发给 M worker
worker 1..M：并行执行 SELECT JOIN（只读，WAL 下并发 SELECT 不冲突）→ 中间结果行 message 回主进程
主进程：汇总 → 单 writer 批量 INSERT diff_rows（串行）
```
理论加速上限 ~3-4x（INSERT 串行段占 ~20%）。**POC 必须实测此结构是否成立、加速比是否达标、byte-for-byte 是否一致。**

---

## 3 全局风险红线汇总（CLAUDE.md 规则 7）

| 来源 | 红线 | 级别 | 防御 |
|---|---|---|---|
| A3-multi-worker | 多 worker 并行结果与单 worker **byte-for-byte 一致**（diff_rows 内容/顺序）| 🔴 资金 | contract test 多档数据集（500 / 5000 / 5w / 500w）+ 保留单 worker fallback 路径 |
| A3-multi-worker | 多 worker INSERT 写竞争 → SQLITE_BUSY 30s | 🔴 并发 | write-splitting（D30）— reader 并行、writer 单一串行；POC 实测 |
| A3-multi-worker | OOM 低配机器（M worker × ~800MB peak）| 🟡 | D33 默认 worker=2 + 动态降级 + settings 可调 |
| A3-spread | 各模块 runCheck 提取 runCheckCore 时业务逻辑差异 | 🟡 | 每模块独立 byte-for-byte contract test |

**合并前硬要求**：β.1 必须有「真实大数据（≥百万行）多 worker vs 单 worker diff_rows byte-for-byte 一致 + 加速比实测」证据，不能只靠小 fixture 单测（对标 α 需求5 资金红线门槛）。

---

## 4 决策点（✅ 2026-05-31 用户全盘采纳倾向 · 沿用 D29-D36）

> 🔴 D30 / D33 直接关系资金与并发红线。用户已全盘采纳下列倾向；POC（§5 P0-4）仍会用实测复核 D30。

| ID | 主题 | 采纳方案（已拍板 → POC 实测校准）|
|---|---|---|
| **D29** | worker 默认数量 | `os.cpus().length - 2`（≥1）封顶，settings 可调；**POC 实测 M=4 即达加速甜点，M=8 几乎不再涨**（2.32 vs 2.31 / 2.70 vs 2.67）→ 默认上限 4 即可，避免 OOM |
| **D30** 🔴 | write-splitting 方案 | ⚠️ **POC 推翻原 (a) 倾向 → 采用 (b) 每 worker temp table + ATTACH 汇总**：plan-b 全档优于 plan-a（保持 C 层批量 INSERT；plan-a 主进程逐行 INSERT 退化）。实测 50万行 plan-b 2.31-2.70x vs plan-a 2.02-2.53x |
| **D31** | 小数据回退 | **POC 实锤**：5万行多 worker 仅 0.22-0.39x（远慢于单 worker，worker 启动开销 dwarfs 工作量）→ 必须回退单 worker。阈值需结合行数 **AND** chunk 数（chunk 数 < worker 数则并行无收益）|
| **D32** | 跨模块 pool 共享 | (a) 每模块独立 pool（避免跨模块写锁调度复杂度）；跨模块并发跑时默认串行 |
| **D33** 🔴 | OOM 防御 | settings 默认 worker=2，高级可调 4；**POC 50万行/M=8 峰值 RSS 2.2GB（含造数）**→ 500万行需 500万真实数据手测确认峰值，动态按可用内存降级 |
| **D34** | 进度聚合 | 不排序流式（按 worker 完成顺序合并 progress，总进度 = Σ 各 worker 已完成 chunk / 总 chunk）|
| **D36** | A3-spread 范围 | 先做用户实际反馈「主进程卡」的模块 |

> 🔴 **POC 新发现（β.1 关键设计输入）**：加速比强依赖 **chunk 数 >> worker 数**。production 当前默认 `chunkSize=100000`（`acquiring-bill-currency-session.js:227`）在 50万行只切 5 chunks，喂不饱 4+ worker → 仅 1.52x。多 worker 路径必须**调小 chunkSize 或自动按 `chunk 数 = k × worker 数` 反推**（POC：chunk=10000/50chunks 时 2.70x）。β.1 实现须含此自适应分片逻辑。

> **D-β-1 resume 策略（2026-05-31 用户拍板 = A）**：β.1 多 worker **只服务全新 run**；resume（断点续跑）run **回退现有单 worker 路径**。理由：resume 是 v2.1.10 SR-FIX-1 Round 4/5/6 反复加固的 idempotent/race 雷区（`acquiring-bill-currency-session.js:347-350,396-426`），多 worker 让其价值缩水（run 变快、崩溃窗口小）；且 T-b1-1 的 byte-for-byte 契约保证「全新跑多worker + resume单worker」混合安全（同行同序、chunkSize 持久化对齐）。**非架构限制**——resume×多worker 列为 follow-up（放宽 multiworker 模块 chunkIndex「0..N-1 连续」校验为「升序无重复」+ 补 resume×MW contract test，~2-3 天）。

---

## 5 Phase 0 POC 计划（🔴 实现前硬门槛 · 委托 dev）

POC 是 β 全阶段的前提——验证「多 worker write-splitting 真能 2-3x 且 byte-for-byte」这个核心假设。**POC 不达标则 β 方案需重新评估**（可能回退到 SQL 索引优化等低 ROI 方案）。

| POC 项 | 验证内容 | 通过标准 |
|---|---|---|
| **P0-1 write-splitting 可行性** | 把 stage 4' 的 `INSERT...SELECT` 拆成 worker SELECT JOIN → 主进程 INSERT，跑通 | 无 SQLITE_BUSY、结果行数与单 worker 一致 |
| **P0-2 加速基线** | M=2/4/8 worker 在 5w / 50w / 500w 行的总耗时 vs 单 worker baseline | 500w 行 ≥ 2x 加速（达不到则方案存疑）|
| **P0-3 byte-for-byte** | 多 worker diff_rows 内容/顺序与单 worker `INSERT...SELECT` 完全一致 | 逐行 diff 0 差异 |
| **P0-4 D30 方案对比** | (a) 主进程汇总单 writer vs (b) temp table ATTACH | 出加速比 + 复杂度结论，定 D30 |
| **P0-5 内存峰值** | M worker 并行 500w 行的 RSS 峰值 | 出 OOM 风险数据，定 D33 默认 worker 数 |

产出：`scripts/poc/v2.1.12-beta-multiworker-{lib,worker,poc}.js`（commit b6f7e57 + 7fc0ae8）+ POC 结论回填本 spec §4 D30 + §5.1。

### 5.1 ✅ POC 实测结论（2026-05-31 · GO）

测试条件：合成数据 50万行（diff 15万行）/ 5万行；M=2/4/8；chunkSize 100000(5chunks) / 25000(20chunks) / 10000(50chunks)。baseline = 单 worker 逐 chunk `INSERT...SELECT`（生产 stage 4' 同 SQL）。

| P0 项 | 通过标准 | 结果 | 实测 |
|---|---|---|---|
| P0-1 write-splitting 可行 | 无 SQLITE_BUSY + 行数一致 | ✅ PASS | 所有档 `busy=false`，diff 行数 150059 全一致 |
| P0-3 byte-for-byte 🔴 | 逐行 0 差异 | ✅ PASS | 所有 chunk数/M/方案 `equal=true firstDiffAt=-1`（含 chunk 数变化）|
| P0-2 加速基线 | 500w 行 ≥ 2x | ✅ PASS（50万实测）| plan-b 50chunks **2.70x**(M=4/8) / 20chunks 2.31x / 5chunks 1.52x |
| P0-4 D30 方案对比 | 出加速比 + 复杂度结论 | ✅ → **选 (b)** | plan-b 全档 > plan-a（plan-a 主进程逐行 INSERT 退化为瓶颈）|
| P0-5 内存峰值 | 出 OOM 数据 | ✅ | 50万/M=8 峰值 RSS 2191MB（含造数）|

**go/no-go 结论：GO（plan-b）**。
1. **加速 ≥2x：达标**（plan-b 2.31-2.70x @ M=4，前提 chunk 数 >> worker 数）。
2. **byte-for-byte：始终一致**（资金红线 PASS）。
3. **D30 推荐 (b)** temp table + ATTACH 汇总。
4. **无阻塞性发现**；3 个 β.1 关键设计输入：① 多 worker 路径需调小 chunkSize/自适应分片（见 §4 末注）② M=4 为甜点（D29）③ 小数据回退（D31）。
5. ⚠️ **遗留验证**：本 POC 用合成数据 + 代表性 SELECT JOIN，非生产 runCheckCore 全链路、非 500万真实数据。**500万真实数据端到端 + byte-for-byte 人工核对仍是 β.1 合并前硬门槛**（§3）。

---

## 6 测试策略

| 层 | 覆盖 |
|---|---|
| unit（`node:test`）| worker pool 多 worker 调度 / chunk 分发 / 进度聚合 / crash recovery（扩 `run-check-worker-pool.test.js`）；write-splitting 汇总逻辑 |
| **byte-for-byte contract** 🔴 | 多 worker vs 单 worker vs 主进程直调，diff_rows 三方一致，多档数据集（500 / 5000 / 5w）|
| integration | runCheck IPC 契约（多 worker 路径）；cancel / resume 在多 worker 下的行为 |
| smoke | acquiringBillCurrency 多 worker 端到端 + 零回归断言 |
| 资金红线手测 | 真实 ≥百万行大文件，多 worker vs 单 worker 结果人工核对 + 加速比实测 |
| 总闸 | `npm run release-check` 全绿 + 提 PR 前 `/check-vars`（命中 `runCheckCore` / `dispatchRunCheck` Risk-sensitive）|

未覆盖：第 3 层 UI 编排单测（靠 smoke + 手测）；OOM 极端低配机（靠 D33 默认值兜底 + 手测一档低内存）。

---

## 7 任务拆分 / 排期（供 team-lead 委托 dev · β.1 优先）

> 委托策略：α 经验 agent 在本环境不稳定 → dev 任务切**极小粒度（单文件单任务）+ 强制增量提交**；POC / 框架 / contract test 分开委托。提 PR 约束见 MEMORY `workflow_no_tester_no_auto_pr`（用户手测循环结束 + 明确说"提 PR"后才提）。

**β.1（先做）**：
1. **T-b1-0 Phase 0 POC**（§5，硬门槛）→ 结论回填 spec
2. T-b1-1 worker pool 单→多（pool 管理 M worker，复用 crash recovery / op lock）
3. T-b1-2 write-splitting：主进程拆 chunk 分发 + 汇总单 writer INSERT（按 D30 POC 结论）
4. T-b1-3 进度聚合（D34）+ 小数据回退单 worker（D31）+ OOM 降级（D33）
5. T-b1-4 byte-for-byte contract test 多档 + 单 worker fallback 路径
6. T-b1-5 settings 加 worker 数配置项（D29/D33）+ 文档三件套

**β.2 / β.3**：待 β.1 POC + 实测后另拆（提取 runCheckCore 范式复用 β.1 框架）。

---

## 8 开放问题 / 下一步

### ✅ 已拍板（2026-05-31）
- **Q-β-1 分阶段范围** → **做完整 β**（β.1+β.2+β.3 ~6 周），按 3 子阶段顺序推进。
- **Q-β-2 决策点** → **全盘采纳** §4 D29-D34/D36 倾向（POC P0-4 仍实测复核 D30）。
- **Q-β-3 POC-first 门槛** → **认可**：POC 不达标（500w 行 < 2x 加速 或 byte-for-byte 不一致）则停下重评方案，不硬上实现。

### 下一步
1. ✅ 拍板完成。
2. ✅ Phase 0 POC 完成（GO）→ 结论已回填 §4 D30 + §5.1。
3. ✅ β.1 实现完成（T-b1-1/2/3，acquiring 多 worker 已激活 + byte-for-byte 锁 + 嵌套拓扑验证）；β.1-T4（500万手测 + version + docs + PR）待用户手测 + 提 PR。
4. β.2 **重定向**（见 §9）。

---

## 9 β.2/β.3 重定向（2026-05-31 reverse sync · ⚠️ 推翻 v2.1.11 backlog 假设）

> 触发：β.1 完成后摸 bizOpRecon / pending 代码现状，发现原 backlog「bizOpRecon + pending reconcile 复用 multi-worker」**与代码事实冲突**（CLAUDE.md 规则 2）。用户确认真实痛点 = **导入百万行 xlsx**（非 reconcile）。

### 9.1 可行性事实（有出处）

| 模块·操作 | 代码现状 | 是否适配 multi-worker write-splitting |
|---|---|---|
| acquiring·对账 | chunked `INSERT...SELECT JOIN` 500万行 | ✅ 是（β.1 已做 2.3x）|
| **bizOpRecon·导入** | `biz-op-recon-import/reader.js:60` **SheetJS `XLSX.readFile`** 全量进内存，主线程同步；非流式非 worker | ❌ 否——导入瓶颈是**内存/阻塞**非 CPU 并行；SheetJS 撞 V8 512MB 上限静默返回空（需求1 实测）。reader 注释假设 <10万行，**实际超百万** |
| pending·导入 | `pending-session.js:34` spawn `pending-import/worker.js` + `streaming-xlsx-reader` | ✅ 已流式 + worker 化（已解，无需动）|
| bizOpRecon·对账 | JS 层按账户日聚合（`biz-op-recon-session.js:293`）| ❌ 否——JS 聚合非 JOIN、小规模 |
| pending·对账 | 多轮**有状态 JS 配对**（`engine.js:96-132` 跨轮 matched Set）~500ms | ❌ 否——全局状态无法独立 chunk；并行化算错对账=资金红线事故 |

**根因**：multi-worker write-splitting 解决「大计算量·算得慢」（acquiring JOIN）；导入百万 xlsx 的痛点是「大文件·内存装不下+卡主线程」，对症解是 **流式 reader + worker**（需求1 VCC / pending 已验证范式），二者是不同工具。详见对话推导。

### 9.2 重定向后的 β.2（替换原「bizOpRecon/pending reconcile multi-worker」）

**新 β.2 = bizOpRecon 导入流式改造**（仿 `pending-import/worker.js` 成熟范式）：
- `readBizOpFile` / `readFlowFile` 的 SheetJS `XLSX.readFile` → 复用 `pending-import/streaming-xlsx-reader.js` 的 `readXlsxStreamed(file, (cells,rowIdx)=>{})` 逐行回调
- 导入移入 child-process worker（仿 pending：jobMeta + 边流式读边分批 INSERT，避免百万行全堆 JS 数组 OOM）
- 🔴 **必须保持语义不变**：表头校验（`validateBizOpHeaders`/`validateFlowHeaders`）+ 校验失败**整批拒绝** + **失败报告 xlsx** + 同 `(date,BU)` 替换原子事务 + `_rowIndex`(Excel 行号) + `isRowMeaningful` 跳过；contract test 锁旧 SheetJS reader vs 新流式 reader 同输出。

### 9.3 β.3（A3-spread）— 待评估
- bankBuRecon / bankStatement / reconIdFix：很可能同样是 JS 层/特殊算法（reconIdFix=C4 subset-sum，立项已明确不动），multi-worker 大概率不适用；**先摸形态再定**（导入是否也 SheetJS→流式候选）。本版是否做待 β.2 后定。

### 9.4 β.2 任务拆分
- **T-b2-1**：`biz-op-recon-import` 加流式 reader（复用 streaming-xlsx-reader）+ contract test 锁与 SheetJS reader byte-level 同输出（表头校验/行映射/_rowIndex/isRowMeaningful 一致）
- **T-b2-2**：bizOpRecon 导入 worker 化（仿 pending worker：边流式边分批 INSERT + 失败报告 + (date,BU) 替换原子事务）+ session/IPC 改 spawn worker
- **T-b2-3**：集成测试（百万行级 fixture 端到端）+ release-check 全绿 + 真实大文件手测

### 9.5 T-b2-2 详细设计（2026-05-31 实现 · 仿 `pending-import/worker.js`）

**链路**：`main.js IPC handler` → `biz-op-recon-session.runBizOpImportViaWorker / runFlowImportViaWorker`（spawn 方）→ child process `biz-op-recon-import/import-worker.js`（流式读 + 事务插）→ stdout JSON 行 → session 解析 → 拒绝时 session 用 worker emit 的 errorRows 调 `writeBizOpErrorReportXlsx`/`writeFlowErrorReportXlsx` 写盘。

**jobMeta**：`{ dbPath, kind:'bizOp'|'flow', date, filePath, maxRowErrors }`（dbPath = `database.dbPath` 主 DB tool-data.sqlite；与 acquiring worker 同库 WAL 并发，已生产验证）。

**输出协议（每行一 JSON）**：
- `{type:'progress', dataRows:N}`（每 progressInterval 行）
- `{type:'rejected', errorRows:[{rowIndex,reason,rawRow}], rowErrorTotal, truncated, firstBu?}`（整批拒绝；含 rawRow 供主进程写报告；ROLLBACK 已在 worker 完成）
- `{type:'header-error', errorCode, message, detailLines}`（表头/读取失败，FileValidationError 映射；ROLLBACK）
- `{type:'complete', status:'success', buName?/totalCount?, validCount}`（COMMIT）

**退出码**：0 成功 / 1 校验失败（rejected / header-error）/ 2 系统错。

**🔴 worker 内五条资金红线保住法**：
1. **整批拒绝**：worker 内 `BEGIN` → 流式读，第一个数据行定 `firstBu`（bizOp）→ 立即在事务内执行 clear（见 §4）→ 逐行 BU 一致 + `validateBizOpRow`（bizOp）/ `validateFlowRow`（flow），累积 errorRows（上限 maxRowErrors，仅前 N 条带 rawRow，但 rowErrorTotal 计全量），通过的行才 INSERT。流完：errorRows 非空 → `ROLLBACK`（不入任何行）+ emit rejected；全通过 → COMMIT。
2. **(date,BU)+D+1 替换原子事务**（bizOp）：首个数据行回调内（事务已 BEGIN）执行 `clearRunsAndDiffsByDateBu(date,firstBu)` + `clearRunsAndDiffsByDateBu(addOneDay(date),firstBu)` + `clearByDateBu(date,firstBu)`，与后续 INSERT 同一 BEGIN…COMMIT；任一错或 errorRows → ROLLBACK 全回滚。
3. **bu_name 改写**：INSERT 前每行 `bu_name = firstBu`（trim 保大小写）。
4. **失败报告 xlsx**：worker 不写盘（ExcelJS 留主进程，仿 pending）；emit rejected 的 errorRows 带 rawRow → 主进程 session 写 `writeBizOpErrorReportXlsx`，返回 errorReportPath。
5. **flow 差异**：flow 不分 BU、无 BU 一致性校验、无 firstBu / bu_name 改写；clear = `clearRunsAndDiffsByDate(date)`（跨所有 BU）+ `clearByDate(date)`（非 ByDateBu）；空文件→rejected `rowIndex:0`。

**rows.length===0**（无有效数据行）：流完 dataRows===0 → emit rejected `[{rowIndex:0,reason:'文件无有效数据行'}]`（与旧同步语义一致）。

**回退**：保留旧同步 `runBizOpImportAsync`/`runFlowImportAsync`（contract 基线 + 测试 + 无 dbPath 兜底）；默认走 worker。session 暴露 `runBizOpImportViaWorker(db,{...,dbPath,onProgress})`，无 dbPath 时内部 fallback 旧同步路径。

---

## 10 收单(acquiring)导入提速 —— 新增 β 工作项（2026-06-01 POC 实测 · reverse sync）

> 触发：用户实测反馈「**收单的导入**慢」。β.1 做的是收单**对账**（runCheck JOIN multi-worker），**从未碰过收单导入**。profile POC 定位瓶颈 → 解析器 make-or-break 对比 → 锁定最优架构。**这是 β 漏掉的真实痛点**。

### 10.1 瓶颈定位（POC 实测，scripts/poc/v2.1.12-acquiring-import-{clean-timing,insert-bench,parser-compare}.js）

收单导入现状链路：`acquiring-bill-currency-import/reader.js` = **yauzl（流式解压）+ sax（流式 XML 解析）**，逐行 `insertFlowRow`（含 `JSON.stringify(raw_json)` + SQL）。

| 段 | 50万行实测 | 占比 |
|---|---|---|
| 完整导入（clean-timing 真实 prod 路径）| **121.82s** | 100% |
| └ 解析（sax，A 档：真实 reader.importFlowFile + no-op insert）| **109.47s** | **~90%** 🔴 |
| └ insert + raw_json（Cins 端到端 − C 解析 ≈ 21.86 − 12.64）| ~9.2s | ~7% |

→ **瓶颈 = sax 解析（~90%）**。批量 INSERT / raw_json 精简（早期误判的方向）合计仅省 <6%，鸡肋。

### 10.2 解析器对比（make-or-break · fixture 50万/100万行 × 48列 全 inlineStr，134MB/267MB，解压后 1.8GB/3.8GB）

| 档 | 解压 | 解析引擎 | 500K | 100万 | 峰值RSS | 100万结局 |
|---|---|---|---|---|---|---|
| **A 现状** | yauzl | **sax 库** | 109.5s | 233.4s | 241/253MB | ✓ 慢 |
| **B pending范式** | **JSZip** | 手写扫描 | 10.5s | 💥 | 292MB | **崩**`uncompressed data size mismatch` |
| **C 最优** | **yauzl** | **手写扫描** | **12.6s** | **25.5s** | **169/237MB** | ✓ 跑通+最省内存 |

**关键结论**：
1. **解析引擎 sax→手写 = 8.7x(500K)/9.1x(100万)**（A vs C 同用 yauzl 解压，唯一变量是 sax↔手写 → 纯属解析器）。sax 慢在每 cell ~7 次 JS 事件回调（50万行×48列×7 ≈ 1.68 亿次）。
2. **JSZip 在 100万行(~3.8GB 解压 entry)崩**（B），而 **yauzl 同文件读得好好的**（A/C 出满 100万行）→ pending 的 `streaming-xlsx-reader`（JSZip）有大 entry 上限，**收单不能照搬**。
3. **最优 = yauzl + 手写扫描**（C）：现状两个 reader 都不是最佳——收单=yauzl+sax(慢)、pending=JSZip+手写(大文件崩)；C 各取所长，且**内存最低**（yauzl 流式无整文件 buffer）。
4. **正确性闸**：手写 `parseRowXml` 与 sax 在真实 48 列 inlineStr 数据前 3000 行 × 48 列 **0 差异**（byte-level 一致）。

### 10.3 端到端实测（Cins = C 解析 + 真实 insertFlowRow 含 raw_json+SQL，与现状同口径）

| | 500K | 100万 | 500万(外推) |
|---|---|---|---|
| 现状(sax) | 121.82s | ~245s | ~20min |
| **新(yauzl+手写)** | **21.86s** | **45.44s** | **~3.8min** |
| **加速** | **5.6x(实测)** | ~5.4x | ~5.5x |

换解析器后瓶颈转移：parse 12.6s(58%) / insert+raw_json 9.2s(42%) 接近均衡 → 届时**批量 INSERT 才有边际价值**（二期，省 ~2-3s），raw_json 是数据源不可删。

### 10.4 任务（β 新增 · ✅ 2026-06-01 用户 greenlight「现在就做」· 🔴 资金红线）

- ✅ **T-acq-import-1（完成 · commit 0ec2ec4/d54f766）**：新建 `acquiring-bill-currency-import/reader-handrolled.js`（yauzl 解压 + sharedStrings 走 sax 复用 + sheet 扫描换**手写**）。**未引入 JSZip**（POC 实测 JSZip 100万行崩）。⚠️ **未复用** `streaming-xlsx-reader.parseRowXml`——它对 number 做 `parseFloat→String("1000.00")→"1000"` 会丢小数改写金额；改写专用 `parseAcquiringRowXml`，数字 cell 取 `<v>` 原文本逐字对齐 sax。reader.js 纯追加导出 helper（零函数体改动，作基线+回滚）。**生产路径已切**（`acquiring-bill-currency-session.js:16` 单行 require，一行可回滚）。
- ✅ **T-acq-import-2 🔴（完成 · commit f90bec6/e4d78e1）**：byte-for-byte 闸双层——① contract test 18 用例（含 🔴 sharedStrings `t="s"` 路径 + number cell + 稀疏行 + 中文实体 + 表头列少/多/错 + peek），sax vs 手写全等；② **真实规模 scalediff**：50万/100万行全行 SHA1+importedCount+monthKey **完全一致**（`scripts/poc/v2.1.12-acquiring-import-parser-compare.js scalediff`）。release-check 全绿（unit 1467 + integration 952 + smoke acquiring 203）。
- ⏳ **T-acq-import-3（待用户）**：500万真实数据手测（🔴 合并门槛，对标 β.1-T4）→ 通过后 version bump `beta.2` + 文档三件套 + `/check-vars` + 提 PR（待用户「提 PR」）。

> ⚠️ **未覆盖/遗留**：① 已覆盖 sharedStrings `t="s"` 路径（contract #6，手工 yazl fixture + sax loadSharedStrings 复用 → 串表 byte-identical）。② number cell：已做到**零差异**（取原文本，非「已知差异」放行）；inlineStr 真实数据本不触发。③ **500万真实数据手测仍是合并前硬门槛**（fixture 是仿真数据，非真实清结算文件；真实文件可能有 sax/手写容错路径差异的畸形 XML——手测覆盖）。④ bill 路径（26 列）contract 已覆盖正常+表头，但 scalediff 仅测 flow（48 列）；bill 大文件手测随 500万一并验。
