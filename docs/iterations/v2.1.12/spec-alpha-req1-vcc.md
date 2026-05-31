# v2.1.12 α · 需求1 spec — 新建第 6 模块「VCC业务OP计算」

> 状态：草稿（PM 撰写中）
> 范围：仅需求1（新建第 6 模块）。立项已拍板，勿改版本/范围。
> 计算语义已定：**期末OP = 期初OP + 发生额；发生额 = 发生额入 − 发生额出**。

## 0 概述

### 0.1 目标
新建**第 6 个模块「VCC业务OP计算」**（`module.id = vcc-op-calc`，暂定）。UI 复用第 4 模块「月度银行对账单BU回填校验」(`bank-bu-recon`) 的面板/按钮/状态框样式，仅把「导出差异」按钮替换为「显示余额」。

### 0.2 核心业务语义（已拍板，勿改）
| 概念 | 公式 |
|---|---|
| 发生额 | `发生额 = 发生额入 − 发生额出` |
| 期末OP | `期末OP = 期初OP + 发生额` |
| 月份归属 | 期末OP 月份 = 导入流水所在月；期初OP = 用户手填的"导入流水上月"OP |

### 0.3 与现有模块的区分（避免混淆，必读）
| 项 | 第 5 模块（已存在） | 第 6 模块（本需求） |
|---|---|---|
| 名称 | 业务OP数据**核对** | VCC业务OP**计算** |
| module.id | `biz-op-recon`（`src/renderer.js:71-73`） | `vcc-op-calc`（新，待拍 Q-命名） |
| IPC 命名空间 | `bizOpRecon:*`（`src/main.js:10434`） | `vccOpCalc:*`（新） |
| 输入 | 业务OP 文件 + 流水文件，按 BU 维度核对，导出差异 | **仅流水文件**，按月聚合发生额出/入算期末OP，落本地表 + 显示余额 |
| 是否对账 | 是（账户号匹配 + 期末余额比对） | 否（纯求和 + 加法） |

> ⚠️ 重名风险：需求文案里的"业务OP""发生额入/出"与第 5 模块流水/业务OP 表的同名列（`src/backend/biz-op-recon-db/columns.js:25-27`）字面相同但**语义与数据来源不同**，spec 全程用「VCC业务OP计算 / vcc-op-calc」前缀消歧。

### 0.4 范式蓝本出处（本模块照抄结构）
| 层 | 蓝本文件:行 |
|---|---|
| 模块注册 | `src/renderer.js:66-69`（bankBuRecon 注册）→ 仿写第 6 项 |
| 面板隐藏控制 | `src/renderer.js:1364-1370` |
| DOM 缓存 | `src/renderer.js:288-292`（5 项） |
| UI 状态机/handler | `src/renderer.js:3950-4167`（import/run/export 三流程） |
| session 层 | `src/main-process/bank-bu-recon-session.js` 全文 |
| reader | `src/backend/bank-bu-recon-import/reader.js` |
| 列常量 | `src/backend/bank-bu-recon-db/columns.js` |
| run repo | `src/backend/bank-bu-recon-db/run-repository.js` |
| DB 迁移 | `src/backend/database/migrations.js:1575-1709` |
| preload | `src/preload.js:277-292` |
| IPC handler | `src/main.js:10236-10430`（含 `trackedIpcHandle` 范式） |
| dialog 工厂 | `src/renderer-dialogs.js:9364-9760`（MonthPicker / FileImportPrompt / Reconcile / Export） |

### 0.5 调研踩坑记录（回写 knowledge 候选）
- 本机系统 `grep` 因 `LANG=` 为空 + `src/main.js` 含 NUL 字节（offset ~123265）会把文件判为 binary 静默跳过，导致 `grep` 查 main.js 一律 0 命中。**必须用 `rg --text`**（ripgrep）。证据：`rg` 命中 `src/main.js:208`，`grep` 同模式 rc=1。

## 1 数据模型（表结构）

### 1.1 持久化选型（回答 section 必答①）
**结论：用主 DB `tool-data.sqlite` 新建表，不用文件。**
理由：完全照抄 bank-bu-recon 范式（`migrations.js:1575-1709` 已在主 DB 建 3 表 + 索引），`createXxxSession({ getDb: () => database && database.db })` 现成（`src/main.js:208`）；"显示余额"按月下拉查询用 SQL `GROUP BY year_month` 最省事（仿 `bank-bu-recon-session.js:224 listSuccessMonths`）。文件方案需另写读写/锁/并发，无收益。

### 1.2 表设计
需求是"汇总落本地**一张表**"。但"各文件发生额出/入"是明细（一次运行多文件），"月份级期末OP"是汇总。两者粒度不同，**推荐 2 表**（见 Q3，若用户坚持字面"一张表"则退化为 1 表 + JSON 列，不推荐）。

#### 表 A：`vcc_op_calc_runs`（按"月份"一行 = 一次计算汇总，对外即用户说的"那张表"）
| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `year_month` | TEXT NOT NULL | 流水所在月 `YYYY-MM`（期末OP 归属月） |
| `run_at` | TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP | 时间戳 |
| `file_count` | INTEGER NOT NULL | 本次导入文件数 |
| `total_amount_out` | TEXT NOT NULL | 全部文件发生额出合计（字符串存，见 Q5 精度） |
| `total_amount_in` | TEXT NOT NULL | 全部文件发生额入合计 |
| `total_amount` | TEXT NOT NULL | 总发生额 = in − out |
| `begin_op` | TEXT NOT NULL | 用户手输期初OP（上月OP） |
| `end_op` | TEXT NOT NULL | 计算期末OP = begin_op + total_amount |
| `currency` | TEXT | 涉及币种（Q6=混币种全量计算）：单一币种存该币种；多币种存币种列表（如 `CNY,USD`）或 `MIXED` |

唯一约束候选：`UNIQUE(year_month)` 还是允许同月多次运行历史？→ 见 Q4。bank-bu-recon 是**允许多 run**（`run-repository.js:48 listRuns ORDER BY run_at DESC`，"显示余额"取最新）。推荐沿用"允许多 run + 查询取 MAX(id)"。

#### 表 B：`vcc_op_calc_run_files`（每次运行的逐文件发生额明细，回答"各文件发生额出/入/总额"）
| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | |
| `run_id` | INTEGER NOT NULL | FK → `vcc_op_calc_runs.id` |
| `file_name` | TEXT NOT NULL | 源文件名 |
| `row_count` | INTEGER NOT NULL | 该文件流水条数 |
| `amount_out` | TEXT NOT NULL | 该文件发生额出 |
| `amount_in` | TEXT NOT NULL | 该文件发生额入 |
| `amount` | TEXT NOT NULL | 该文件发生额 = in − out |

索引：`idx_vcc_runs_month ON vcc_op_calc_runs(year_month, run_at DESC)`（仿 `migrations.js:1707`）；`idx_vcc_files_run ON vcc_op_calc_run_files(run_id)`。

> ⚠️ **资金红线**：金额求和 + 期初/期末OP 属资金计算，须人工复核精度策略（Q5）与 in/out 列识别（Q2）。

### 1.3 是否落"流水原始行"？
bank-bu-recon 会落每行原始数据到 `*_imports` 表（`migrations.js:1586/1625`）供导出差异回溯。本模块"显示余额"只展示聚合数 3 项（输入OP/总发生额/计算OP），**不需要逐行原始数据**。推荐：**不建 imports 明细表**，导入时流式累加 out/in 即可（见 Q3 / §2）。若后续要"导出"原始行另议。

## 2 UI 流程状态机

### 2.1 面板元素（仿 `src/renderer.js:288-292` 的 5 项 DOM）
- `vccOpCalcModulePanel`（面板容器）
- `vccOpCalcImportBtn`（「导入文件」）
- `vccOpCalcRunBtn`（「开始运行」）
- `vccOpCalcShowBalanceBtn`（「显示余额」，**替换 bank-bu-recon 的 exportBtn 位置**，样式/大小/位置不变）
- `vccOpCalcStatusBox`（状态框）

### 2.2 状态机（仿 `src/renderer.js:3952` 注释的状态模型）
```
[空闲] →(点导入文件)→ [选文件中] →(选好多文件)→ [统计中]
   →(弹框: 流水月份 + 总条数, 用户确认)→ [已确认]
   →(后台统计 发生额出/入)→ [统计完成: 状态框"完成"]   ← 此时「开始运行」亮
   →(点开始运行)→ 弹框[显示 发生额出/入/总发生额 + 输入期初OP] →(点计算)→
       弹框内显示[期末OP] + 落库(表A/B) → [运行完成]   ← 此时「显示余额」亮
[任意态] →(点显示余额)→ 弹框[月份单选下拉 + 查看] →(点查看)→ 显示[输入OP/总发生额/计算OP]
```

### 2.3 按钮可用性（仿 `applyBankBuReconButtonState` `renderer.js:3969`）
| 按钮 | enable 条件 |
|---|---|
| 导入文件 | 永远 enable |
| 开始运行 | 存在"已统计完成但未落库"的当前会话（见 Q1：会话态存哪） |
| 显示余额 | 后端至少 1 条 `vcc_op_calc_runs` 记录（仿 `listSuccessMonths().length>0` `renderer.js:3975`） |

### 2.4 弹框清单与字段（回答 section 必答③）
| 弹框 | 触发 | 字段 | 蓝本工厂 |
|---|---|---|---|
| **F1 月份+条数确认框** | 选完文件、统计完总条数后 | 只读展示：流水月份 `YYYY-MM`、总条数 N；按钮[确认]/[取消] | 仿 `createBankBuReconFileImportPromptDialog`（`renderer-dialogs.js:9539`，纯展示 + 确认） |
| **F2 计算框** | 点「开始运行」 | 只读：发生额出 / 发生额入 / 总发生额；输入框：期初OP（数字）；按钮[计算]；点计算后**同框追加显示**期末OP + [保存/关闭] | 新建（结构仿 Reconcile `renderer-dialogs.js:9624`，把 select 换成只读数值行 + 1 个 input + 计算结果行） |
| **F3 显示余额框** | 点「显示余额」 | 月份单选下拉（数据源 = 后端 distinct year_month）+ [查看]；点查看后展示该月：输入OP / 总发生额 / 计算OP | 仿 `createBankBuReconExportDialog`（`renderer-dialogs.js:9697`，去掉 radio，留月份 select + 结果展示区） |

### 2.5 "显示余额"是面板内还是弹框（回答 section 必答④）
**推荐：弹框**（与「导出差异」位置一致、改动最小，复用 ExportDialog 结构）。面板内嵌展示需改 HTML 布局、与"样式位置大小不变"约束冲突。→ 见 Q7。

### 2.6 月份从哪来（F1 展示的"流水月份"）
✅ **已定（C 拍板 2026-05-30）**：VCC 导入**流水对账单（28 列，同第5模块 FLOW 格式）**，月份取「**账单日期**」`bill_date_raw`（`biz-op-recon-db/columns.js:83`）。一文件内多月份混杂的处理见 Q8（推荐整批拒绝，一次导入应为同一流水月）。

## 3 改动点清单（IPC / preload / renderer / dialog / DB 迁移）

> 全部为**新增**，不改现有 5 模块逻辑。新增文件命名 `vcc-op-calc-*`。

### 3.1 DB 迁移（`src/backend/database/migrations.js`，仿 1575-1709）
- 新增 `CREATE TABLE IF NOT EXISTS vcc_op_calc_runs`（§1.2 表A）
- 新增 `CREATE TABLE IF NOT EXISTS vcc_op_calc_run_files`（§1.2 表B）
- 新增 2 索引。迁移幂等（CLAUDE.md 约定）。

### 3.2 后端列常量（新建 `src/backend/vcc-op-calc-db/columns.js`，复用第5模块 FLOW 定义）
✅ **已定（C 拍板 2026-05-30）**：输入 = 流水对账单 28 列（`biz-op-recon-db/columns.js:81-110`），可直接 require 复用其 `FLOW_COLUMN_DEFS`/`FLOW_HEADERS`/`flowHeaderToDbColumn`，避免重复维护表头。
- 语义锚点（引用第5模块流水列）：`direction`(出入方向, `:90`)、`recon_amount`(对账金额=金额, `:95`)、`bill_date_raw`(账单日期=定月份, `:83`)、`currency`(币种, `:96`)
- **发生额口径**：发生额入 = `direction==='入'` 的 `recon_amount` 求和；发生额出 = `direction==='出'` 的求和；发生额 = 入 − 出（出入方向合法值待 dev 核实流水真实取值，非法值按 Q8 整批拒绝）

### 3.3 reader（新建 `src/backend/vcc-op-calc-import/reader.js`，仿 bank-bu-recon-import/reader.js）
- `readFlowFile(filePath)` → 表头校验（仿 `buildFileReader` `reader.js:49`）+ 返回 rows
- validator（新建 `validator.js`，仿 bank-bu-recon-import/validator.js）

### 3.4 session（新建 `src/main-process/vcc-op-calc-session.js`，仿 bank-bu-recon-session.js）
- `createVccOpCalcSession({ getDb })`
- `parseSignedAmount(direction, amount)` 风格的出/入归类（**复用 biz-op-recon-session.js:75 逻辑**：入/出判定）→ 但本模块**分别累加 out 与 in**，不合并符号
- `aggregateFiles(fileResults)` → `{ totalOut, totalIn, totalAmount, perFile:[...] }`（**混币种全量**：所有币种 `recon_amount` 不分币种合并求和，Q6）
- `saveRun({ yearMonth, perFile, totals, beginOp })` → 算 endOp = beginOp + totalAmount，写表A/B，返回 runId（仿 `run-repository.insertRun`）
- `listCalculatedMonths()` → distinct year_month（仿 `listSuccessMonths` session.js:224）
- `getMonthResult(yearMonth)` → 取最新 run 的 {beginOp, totalAmount, endOp}（"显示余额"用）

### 3.5 run repo（新建 `src/backend/vcc-op-calc-db/run-repository.js`，仿 run-repository.js）
- `insertRun` / `insertRunFiles` / `listRuns` / `getRun` / `listDistinctMonths` / `getLatestRunByMonth`

### 3.6 IPC handler（`src/main.js`，仿 10236-10430，用 `trackedIpcHandle` 给资金/运行类）
| channel | 类型 | 说明 |
|---|---|---|
| `vccOpCalc:import:pick-files` | handle | 多选 xlsx（`dialog.showOpenDialog` properties 含 `multiSelections`，仿 10268） |
| `vccOpCalc:import:scan` | trackedIpcHandle | 读多文件→统计总条数+定月份，返回 {yearMonth, totalRows}（供 F1） |
| `vccOpCalc:run:compute-amounts` | trackedIpcHandle | 统计发生额出/入/总额，返回 totals + perFile（供 F2 展示，**不落库**） |
| `vccOpCalc:run:save` | trackedIpcHandle | 收 beginOp → 算 endOp → 落表A/B，返回 {runId, endOp} |
| `vccOpCalc:balance:list-months` | handle | distinct year_month（供 F3 下拉） |
| `vccOpCalc:balance:get` | handle | 入参 yearMonth → {beginOp, totalAmount, endOp}（供 F3 查看） |

> handler 数量取决于会话态切分（Q1）：若 scan 与 compute 结果缓存在 main 进程内存会话（仿 `lastRunCache` session.js:154），可省去重复读文件。

### 3.7 preload（`src/preload.js`，仿 277-292）
新增 `vccOpCalc: { pickFiles, scan, computeAmounts, save, listBalanceMonths, getBalance }` 命名空间，逐个 `ipcRenderer.invoke('vccOpCalc:*')`。

### 3.8 renderer 状态机（`src/renderer.js`）
- MODULES 注册新增第 6 项 `vccOpCalc: { id:'vcc-op-calc', name:'VCC业务OP计算' }`（仿 66-69）
- 面板隐藏控制新增分支（仿 1364-1370，调 `restoreVccOpCalcPanelState`）
- DOM 缓存新增 5 项（仿 288-292）
- 新增 `vccOpCalcState` + `applyVccOpCalcButtonState` + `handleVccOpCalcImport/Run/ShowBalance`（仿 3950-4167）
- **会话态**：扫描/统计的中间结果（yearMonth、totals、perFile）存 renderer `vccOpCalcState` 还是 main 进程？→ Q1

### 3.9 dialog 工厂（`src/renderer-dialogs.js`，仿 9364-9760）
- 新增 `createVccOpCalcConfirmDialog`（F1）、`createVccOpCalcComputeDialog`（F2）、`createVccOpCalcShowBalanceDialog`（F3）
- 注册到导出列表（仿 `renderer-dialogs.js:9324-9331`）

### 3.10 HTML（`index.html`）
新增 `#vccOpCalcModulePanel` 面板块 + 模块切换入口（菜单/tab）。**须定位现有模块入口注册处**（Q-待 dev 在 index.html 找 bank-bu-recon 面板块照抄；本 spec 未读 index.html，标为 dev 实现细节）。

### 3.11 previews（按 MEMORY `workflow_frontend_previews`）
新增前端面板 → 须补 `npm run preview` 入口（4 处），提 PR 前重跑。

### 3.12 不改动
现有 5 模块全部文件、`bizOpRecon:*` / `bankBuRecon:*` handler、既有 DB 表 — 零改动。

## 4 验收标准

| # | 验收点 |
|---|---|
| AC1 | 主界面出现第 6 模块「VCC业务OP计算」，面板/按钮/状态框样式与第 4 模块一致，仅「导出差异」位变为「显示余额」 |
| AC2 | 点「导入文件」可多选 xlsx；选完弹 F1 显示流水月份 + 总条数；取消则状态框不变 |
| AC3 | F1 确认后状态框统计发生额出/入并显示"完成"；此时「开始运行」由灰变亮 |
| AC4 | 点「开始运行」弹 F2，显示发生额出/入/总发生额（=入−出）；输入期初OP 点计算后显示期末OP（=期初OP+总发生额）数值正确 |
| AC5 | F2 计算后，表A 新增 1 行（month/总额/期初/期末/时间戳），表B 新增 N 行（每文件出/入/总额）；「显示余额」变亮 |
| AC6 | 点「显示余额」弹 F3，月份单选下拉列出已计算月份；选月点查看显示该月 输入OP/总发生额/计算OP，与 AC4/AC5 落库值一致 |
| AC7 | 金额计算精度符合 Q5 拍板口径（资金红线，需测试用例覆盖正/负/小数/空值流水行） |
| AC8 | 出入方向非法值（非「入」「出」）处理符合 Q2 拍板（拒绝或跳过），不静默算错 |
| AC9 | 现有 5 模块功能回归无影响（`npm run release-check` PASS） |
| AC10 | 🔴 混币种流水：发生额出/入/总额 = 所有币种 `对账金额` 不分币种合并求和（全量口径）；测试覆盖单币种 + 混币种两种数据集 |

未覆盖（明确排除）：导出 Excel（本模块只"显示"不"导出"，需求未要求）；跨月汇总（需求未提）。

## 5 开放问题（带推荐）

> 标 ★ = 阻塞实现、最该先拍。

| # | 问题 | 推荐 |
|---|---|---|
| **Q1 ★** | 扫描总条数(F1)、统计发生额(F2)的中间结果存哪？renderer 内存 `vccOpCalcState`，还是 main 进程会话（仿 `lastRunCache`），还是每步重读文件？ | **存 main 进程会话**（仿 `bank-bu-recon-session.js:154 lastRunCache`）：选完文件后读一次缓存原始 rows，scan/compute/save 复用，避免多次读盘 + 路径在 renderer 丢失。F2 的 perFile 也由会话持有，save 时直接落库。 |
| **Q2 ★** | 「发生额出/入」从流水哪些列统计？(a) 复用第5模块 28 列 FLOW 模板（用「出入方向」+「对账金额」，仿 `parseSignedAmount`）；(b) 流水文件本就有独立「发生额（入）」「发生额（出）」两列（如业务OP 表 `columns.js:26-27`）直接读；(c) 全新模板。**还需定"用哪列定月份"**（账单日期/流水完成时间/valueDate）。 | 倾向 **(a) 复用「出入方向」direction + 一个金额列**，因为这是第5模块流水的既有结构（`biz-op-recon-db/columns.js:90,95`），财务侧流水文件格式大概率相同；「入」累加进 totalIn、「出」累加进 totalOut。月份取「账单日期」。**但必须用户确认流水文件真实列名/样例**，否则表头校验会全拒。 |
| **Q3 ★** | 持久化"一张表"字面 vs 明细需求：用 §1.2 的 2 表（runs + run_files），还是严格 1 表？是否需要落流水原始行？ | **2 表，不落原始行**。用户口语"一张表"指对外可查的月度汇总（表A），逐文件明细是其下钻（表B）。原始行无展示/导出需求，不存。 |
| Q4 | 同一流水月份多次运行：覆盖（UNIQUE month）还是留历史多 run？"显示余额"取最新还是让用户选 run？ | **留历史 + 显示余额取该月最新 run**（仿 bank-bu-recon 多 run + `MAX(id)`）。简单、可回溯、与既有范式一致。 |
| **Q5 ★** | 金额精度口径（资金红线）：JS Number 浮点求和会有 0.1+0.2 误差。用整数分、还是 decimal 库、还是 `toFixed(2)` 字符串？空/非数字流水行如何计入？ | **建议引入 decimal 计算或统一"乘 100 转整数分求和最后除回"**；金额列存 TEXT 避免浮点漂移。空值跳过、非数字值按 Q8 拒绝。**此条必须人工复核**（资金红线）。需确认项目是否已有 decimal 工具（dev 核 `file-service/normalizers.js` 的金额归一是否可复用）。 |
| Q6 | 多币种处理 | ✅ **已定（用户拍板 2026-05-30）：支持混币种，计算全量发生额** —— 所有币种 `对账金额`(recon_amount) 按出入方向**不分币种合并求和**（发生额入/出/总额、期末OP 均为跨币种合计数）。🔴 资金红线口径：此为"不区分币种的金额合计"，非按币种的真实货币余额，已经用户确认。表A `currency` 列存涉及币种列表或 `MIXED`。 |
| Q7 | "显示余额"面板内 vs 弹框 | **弹框**（§2.5，复用 ExportDialog 结构，符合"按钮位置大小不变"）。 |
| Q8 | 出入方向非法值 / 月份不一致行的处理：整批拒绝 + 错误报告（仿第5模块"整批拒绝"），还是跳过该行？ | **倾向整批拒绝 + 错误报告对话框**（仿 biz-op-recon 资金红线 `#5 整批拒绝`，`biz-op-recon-session.js:5`），资金计算不容静默跳过。月份：若一个文件内多月份混杂，报错（一次导入应为同一流水月）。 |
| Q9 | module.id / 名称最终命名：`vcc-op-calc` / 「VCC业务OP计算」是否 OK？（id 一旦定，DB CHECK 约束 + 数十处引用难改，见 `renderer.js:58` 警示） | 采用 `vcc-op-calc`，与既有 kebab-case 一致；先确认无更短代号需求。 |
| Q10 | F2 期初OP 输入校验：必填？允许负数？格式（整数/小数/带千分位）？ | 必填、允许负数与小数、按 Q5 同口径解析；空或非数字禁用「计算」按钮。 |

## 6 任务拆分建议（供 team-lead 拆 dev 任务）

> 全部新增、不改现有 5 模块；建议一任务一 commit。依赖 Q1/Q2/Q3/Q5/Q6 拍板后启动。

| 任务 | 内容 | 依赖 | 工期 |
|---|---|---|---|
| T-vcc-1 | DB 迁移（表A `vcc_op_calc_runs` + 表B `vcc_op_calc_run_files` + 2 索引）+ 列常量 `vcc-op-calc-db/columns.js` + `run-repository.js` | Q3 表设计 | ~0.5 天 |
| T-vcc-2 | reader + validator（流水文件读取/表头校验，仿 bank-bu-recon-import）| Q2 列来源 | ~0.5–1 天 |
| T-vcc-3 | session（统计总条数/定月份、累加发生额出入、算期末OP、落库、按月查询）🔴资金 | Q1 会话态 / Q5 精度 | ~1–1.5 天 |
| T-vcc-4 | IPC handler（6 channel，资金/运行类用 `trackedIpcHandle`）+ preload 命名空间 | T-vcc-3 | ~0.5 天 |
| T-vcc-5 | renderer：MODULES 注册第 6 项 + 面板隐藏控制 + DOM 缓存 5 项 + `vccOpCalcState` + 状态机 handler | — | ~1 天 |
| T-vcc-6 | 3 个 dialog 工厂（F1 确认框 / F2 计算框 / F3 显示余额框）| T-vcc-5 | ~1 天 |
| T-vcc-7 | `index.html` 面板块 + 模块切换入口（定位 bank-bu-recon 块照抄）| T-vcc-5 | ~0.5 天 |
| T-vcc-8 | previews 入口（4 处，MEMORY `workflow_frontend_previews`）+ 截图回归 | 全部 UI | ~0.5 天 |
| T-vcc-9 | 测试：unit（session 计算/精度/正负/小数/空值）+ smoke + 资金红线用例 + `release-check` 回归 | 全部 | ~1 天 |

**合计 ~6.5–8 天**（不含开放问题澄清往返）。关键路径：T-vcc-1 → T-vcc-3 → T-vcc-4 → 前端 T-vcc-5/6/7。

### 6.1 ⚠️ 资金红线 review 要点（CLAUDE.md 规则 7）
- 金额求和（发生额出/入合计）+ 期末OP = 期初OP + 发生额 属**资金计算**：精度策略（Q5）、出入方向识别（Q2/Q8）、空值/非数字行处理（Q8）必须人工复核 + 测试用例覆盖。
- 命中 `rules/important-variables.md`：本模块为全新代码，无既有 Critical 变量改动，但新增 session 计算逻辑建议提 PR 时跑 `/check-vars` 评估是否登记 `vcc-op-calc-session` 金额累加/精度常量。

---

## 7 后端已完成（commit d2050b0）+ 前端对接交接（2026-05-31）

**后端状态**：DB 迁移（`vcc_op_calc_runs` + `vcc_op_calc_run_files` + FK + 索引）+ `vcc-op-calc-db/columns.js`（复用流水 28 列）+ `run-repository.js` + `vcc-op-calc-import/reader.js`+`validator.js` + `vcc-op-calc-session.js`（整数分精度 / 混币种全量 / 整批拒绝 / 期末OP=期初+发生额）+ main.js 6 IPC + preload —— **已 commit `d2050b0`**。session 资金红线单测 17（`tests/unit/main-process/vcc-op-calc-session.test.js`）；全量 **unit 1380** 无回归。⚠️ 后端由 dev agent 写、team-lead 补单测验证（dev socket 断未自测）。

**前端对接 API**（renderer 调 `window.desktopApi.vccOpCalc.*`，已暴露 `preload.js:316-322`）：

| preload 方法 | IPC channel | 返回 |
|---|---|---|
| `pickFiles()` | `vccOpCalc:import:pick-files` | 多选 xlsx 路径 |
| `scan(payload)` | `vccOpCalc:import:scan` | `{ok,yearMonth,totalRows}` 或 `{ok:false,errorRows}`（整批拒绝）|
| `computeAmounts()` | `vccOpCalc:run:compute-amounts` | `{totals:{totalOut,totalIn,totalAmount,currency},perFile}` |
| `save({beginOp})` | `vccOpCalc:run:save` | `{runId,endOp,beginOp,yearMonth}` |
| `listBalanceMonths()` | `vccOpCalc:balance:list-months` | `[{yearMonth,...}]`（对象数组）|
| `getBalance({yearMonth})` | `vccOpCalc:balance:get` | `{beginOp,totalAmount,endOp,currency,...}` |

**前端待做**（本 spec §2 UI 状态机 + §3.8-3.11）：
- `renderer.js`：MODULES 注册第 6 项 `vccOpCalc{id:'vcc-op-calc',name:'VCC业务OP计算'}`（仿 :66-69）+ 面板隐藏控制（仿 :1364-1374）+ DOM 缓存 5 项（仿 :288-292）+ `vccOpCalcState` + handleImport/Run/ShowBalance（仿 bank-bu-recon :3950-4210）
- `renderer-dialogs.js`：F1 月份确认 / F2 计算框（发生额 + 输入期初OP + 计算期末OP）/ F3 显示余额（仿 :9364-9760）
- `index.html`：`#vccOpCalcModulePanel` 面板块 + 模块切换入口；「导出差异」位 → 「显示余额」按钮
- previews：补 4 处入口（MEMORY `workflow_frontend_previews`）+ 截图回归

**新会话启动**：读本 spec + `git log`（后端 `d2050b0`）→ 做前端 → `release-check` + preview + 手测（需求5/6/1 一起）→ T8 文档三件套（CHANGELOG/VERSION_FEATURE_HISTORY/USER_GUIDE）→ α bump `-alpha.1` + 提 PR（提 PR 前 `/check-vars`）。

---

## 8 前端实现期发现 + 修订（2026-05-31 本会话回写，规则3 Reverse Sync）

### 8.1 🔴 后端 gap：ALL_MODULE_IDS 漏注册 vcc-op-calc（前端开工前修复）
`src/backend/database/settings-repository.js:96-105` 的 `ALL_MODULE_IDS` 白名单遗漏 `'vcc-op-calc'`（dev agent `d2050b0` 写后端时漏，重蹈该常量注释 line 94-95 记录的 v2.1.2/v2.1.3 历史 bug）。后果：`setCurrentModule`/`setEnabledModules`（line 120/225）对该 id 抛 `Invalid module id`，模块无法启用/持久化/被🔄收纳弹窗勾选。
- 修复：`ALL_MODULE_IDS` 追加 `'vcc-op-calc'`；单测 `settings-repository.test.js:42` 断言 `length` 8→9 + 补 `includes('vcc-op-calc')`。
- `DEFAULT_ENABLED_MODULES`（3 个核心模块）**不改**：遵循 new-account/pending/bank-bu-recon/biz-op-recon/acquiring 等非核心模块惯例，vcc-op-calc 默认隐藏，用户经🔄收纳弹窗启用。
- 闭环：收纳弹窗数据源 = renderer `Object.values(MODULES)`（renderer.js:5076），故 MODULES 加第 6 项 + ALL_MODULE_IDS 加白名单两边齐 = 用户可勾选启用。

### 8.2 后端真实 IPC 返回契约（修订 §7 表，**以代码为准**）
§7 表的 `{ok,...}` / `[{yearMonth,...}]` 与 dev 实际实现不符。前端按以下真实契约对接（出处 `main.js:10715-10815` + `vcc-op-calc-session.js`）：
- `scan`/`computeAmounts`/`save` 均为 `{ status:'success'|'rejected'|'error', ... }`（**非 `ok` 布尔**）
  - scan success：`{status,yearMonth,totalRows,fileCount}`；rejected：`{status,errorRows:[{fileName,rowIndex,reason}]}`；error：`{status,message[,code,detailLines,context]}`
  - computeAmounts success：`{status,yearMonth,totals:{totalOut,totalIn,totalAmount,currency,...Cents},perFile:[{fileName,rowCount,amountOut,amountIn,amount,...Cents}]}`
  - save success：`{status,runId,endOp,beginOp,yearMonth}`
- `listBalanceMonths` 返回 **`string[]`**（main 已 `.map(m=>m.yearMonth)`），非对象数组
- `getBalance` 返回 `{runId,yearMonth,runAt,fileCount,beginOp,totalAmount,totalAmountOut,totalAmountIn,endOp,currency}` 或 `null`

### 8.3 F2 计算框语义（资金红线🔴 锁定）
点「计算」= 调 `save({beginOp})`（后端整数分算 endOp + 原子落库），框内展示后端返回 endOp + 标「已保存」，按钮转「关闭」。**前端绝不自行计算 `beginOp+totalAmount`**（资金红线：避免浮点 + 口径分叉）。与 spec §2.2「点计算→落库」一致；§2.4 的「[保存/关闭]」按钮即此「关闭」。

---

## 9 流式读取改造（2026-05-31 手测实测定案，规则1/2/3 Reverse Sync）

### 9.1 背景：SheetJS 读不了真实流水文件（实测铁证）
手测真实流水 `1397997307790624768_1.xlsx`：**78.7 万行**（dimension `A1:AB787315`）/ worksheet XML **811 MB** / sharedStrings 138 MB。
- SheetJS `XLSX.readFile` 全量加载：worksheet 811MB **> V8 单字符串上限 536,870,888 字节(512MB)**，读不成字符串、静默返回空 `Sheets` → reader（`vcc-op-calc-import/reader.js:73`）误报「sheet 内容为空（无表头）」。**增大内存无用**（字符串硬上限，非堆）。
- 实测 `exceljs` streaming `WorkbookReader`：**16.9s** 读通 78.7 万行，发生额(入−出)=**2,223,798.77**，9 混币种，0 非法方向/0 空金额，峰值 RSS 2GB。项目已装 `exceljs@4.4.0`+`sax`+`yauzl`，**无新依赖**。
- 用户拍板（2026-05-31）：① VCC + 第5模块一并改流式；② 流水常态**百万行级** → 加读取进度反馈。

### 9.2 设计：流式读 + 边读边聚合（VCC，纯聚合 — 简单）
- **reader**（`vcc-op-calc-import/reader.js`）：改 `exceljs` `WorkbookReader` 流式逐行，新增 `async streamFlowFile(filePath, {onRow, onProgress, signal})`；首行 `validateFlowHeaders` 校验（口径不变）。
- **session**（`vcc-op-calc-session.js`）：合并 scan+compute 为**一次流式读**（避免读两遍 ≈34s），流式聚合 `{yearMonth, totalRows, totals, perFile, errorRows}` 缓存，**不存原始行**。
  - 🔴 **资金红线**：helper（`parseAmountToCents`/`extractYearMonth`/`validateAndExtractRow`/`centsToAmountString`）**完全复用、口径不变**，仅数据来源 数组→流。改后**必须重跑单测 + 用真实文件核销 2,223,798.77**。
  - 整批拒绝 `errorRows` 加上限（前 100 条 + 总数；可 fail-fast）。
- **IPC**：scan handler 流式读+聚合并缓存；compute handler 返回缓存（不重读）；save 用缓存+beginOp。新增进度事件 `vccOpCalc:scan:progress`（每 5 万行）。
- **preload**：新增 `onScanProgress` 订阅（仿 `acquiringBillCurrency` `onImportProgress`，返回 unsubscribe，renderer finally 退订防泄漏）。
- **renderer**：状态框流式更新「正在读取 X / Y 万行…」。
- **内存**：不存全量行 → 内存恒定（主要 = exceljs sharedStrings cache）；百万行级**须实测内存上限** + 评估 Electron 主进程 `max-old-space-size`。

### 9.3 第5模块（biz-op-recon）流式改造 — ⚠️ 待评估细化（复杂度高于 VCC）
biz-op-recon 是「对账」（账户匹配 + 余额比对），**大概率需保留全量行做 join**（不像 VCC 纯聚合可边读边丢）。流式下百万行不能驻留内存 → 或需**落 SQLite 临时表分块对账**，触及已上线模块核心对账逻辑，**回归风险高**。
- 先评估 `biz-op-recon-session` run 数据流（是否需保留行），再细化方案；**可能建议分阶段**（VCC 先行，biz-op-recon 独立子任务）。

### 9.4 task 拆分
| task | 内容 | 资金红线 |
|---|---|---|
| S1 | vcc reader 流式（exceljs `streamFlowFile`）+ 单测 | |
| S2 | vcc session 流式聚合（合并 scan+compute）+ 单测 + **真实文件核销 2,223,798.77** | 🔴 |
| S3 | main IPC 流式对接 + 进度事件 + preload 订阅 | |
| S4 | renderer 进度 UI（状态框流式更新） | |
| S5 | biz-op-recon 评估 + 流式改造（按 §9.3 评估结果，可能分阶段） | 🔴 |
| S6 | release-check + 真实大文件手测 + 内存评估 | |

### 9.5 资金红线 review🔴
session 流式聚合是金额求和核心改动：聚合口径必须与现有完全一致（复用 helper）；新增「真实大文件核销」测试（2,223,798.77）；提 PR 跑 `/check-vars`。

### 9.6 reader 最终选型：JSZip（exceljs data descriptor 缺陷，2026-05-31 手测定案，取代 §9.2 的 exceljs 方案）
手测真实文件 exceljs streaming 报 `invalid signature: 0x41d`。根因（实测确认）：
- 用户部分文件用 zip **data descriptor**（流式导出：general purpose bit3 set，local file header 的 size/CRC=0，真实值在每个 entry 数据后的 descriptor）。
- exceljs 的 `unzipper` 按 local header 流式读 → 遇 data descriptor 错位 → `invalid signature`。`yauzl`/`JSZip` 走 central directory（有正确 size/offset）→ 能读。这解释「同批文件部分能读部分报错」。
- 另发现：部分大文件（昨天那批 250MB）是 zip 截断损坏（重新导出后恢复，149-163MB 有效）；部分文件多 sheet（透视 Sheet1 + 数据 sheet2）。

**`reader.js` 重写为 JSZip**：复用自研 `pending-import/streaming-xlsx-reader` 的 `parseRowXml`/`readSharedStrings`（同一套 JSZip + SAX 扫 `<row>`）+ 多 sheet 定位（找表头匹配的数据表）+ 损坏文件友好提示 + 进度回调。
- 性能实测（811MB worksheet）：JSZip **7.8s / RSS 778MB** vs exceljs 16.9s / 2GB —— 全面更优 + 支持 data descriptor。
- 真实文件核销：单 sheet **2,223,798.77** ✓、data-descriptor 文件 300000 行 ✓、多 sheet 819831 行 ✓。
- 🔴 资金红线：session 聚合口径完全未动（reader 只换「喂数据的方式」），核销值不变。
- 副带：JSZip 走 central directory 无 exceljs 的 worksheet/model race → 移除 exceljs 时代加的全量读 fallback；单测 flaky 消除。
- ⚠️ 长期：JSZip 当前 `loadAsync` 全量 buffer + `readSharedStrings` 全量数组（778MB）仍高于自研 pending reader（~MB）。若迁 worker pool（见 worker pool 讨论：worker ~1GB 上限 + 自研 reader 是并行前提）需进一步优化 sharedStrings 内存。
