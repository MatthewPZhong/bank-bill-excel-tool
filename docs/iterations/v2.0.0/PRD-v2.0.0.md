# PRD - 网银账单小助手 v2.0.0

> **版本：v1（定稿）**
> v0 的 10 个 OT 已全部收到用户答案；本版本为 PM v1 定稿。决策摘要见 §十。

| 项目 | 内容 |
|------|------|
| 版本 | v2.0.0（v1 定稿）|
| 日期 | 2026-04-23 |
| 作者 | PM（team 协作）|
| 状态 | 定稿（v1） |
| 模块 | 新增顶级模块：月度 Pending 数据核对 |
| 依赖 | v1.5.3（PR #23 协作基建已 merged 到 main，v2.0.0 已同步） |
| 基版本 | 2.0.0-beta.1（commit `c81937c` 基线，v2.0.0 分支）|

---

## 一、需求概述

本次 v2.0.0 第一个需求：

1. **新增顶级模块：月度 Pending 数据核对**
   - 用户导入 Pending.xlsx 数据，以月为维度存库
   - 在规则管理里配置"对账字段（匹配 key）+ 对账内容（比对字段）"
   - 选取"上上月 + 上月"两份相邻月份数据进行对账运算，输出三类差异（`new` / `missing` / `changed`）
   - 结果按月份 label 持久化，支持导出 .xlsx（单月 + 所有月份汇总两种形态）

作为 v2.0.0 的**第一个大模块**，本次落地承载顶级模块切换 UI 改造（按钮 → 下拉）和新数据栈（独立 SQLite `tool-data-pending.sqlite`）两项基础设施。后续 v2.0.0 若有其他需求再追加到本 PRD。

---

## 二、背景与目标

### 2.1 背景

**R1 — 月度 Pending 对账手工化，急需工具化**

- 用户（财务/运营）每月对账要比对"上上月"和"上月"两份 Pending 数据，找出新增、消失、变更的行
- 当前操作：手工 Excel VLOOKUP + 肉眼比对，文件最大可达**数百万行**（估 300 万行 × 31 列，见 §4.1）
- 痛点：
  - 慢：肉眼找差异不可靠，易漏
  - 不可追溯：Excel 手工比对结果不存档，回溯要重做
  - 单模板：当前应用两个顶级模块都是账单生成链路，没有"Pending 对账"链路

**R1 — 目标**：工具化一条 `导入 → 入库 → 规则化对账 → 差异落库 → 导出 xlsx` 链路；加入审计留底（旧月份覆盖前自动保存为 xlsx）；对比运算可复用历史规则（单条全局规则，但每次运算快照规则配置）。

### 2.2 目标

- 新增独立顶级模块 `月度 Pending 数据核对`，顶部模块切换由按钮改为下拉（3 选 1）
- 单月数据可由**多个 .xlsx 合并导入**，所有文件表头必须与 `assets/Pending.xlsx` 模板**严格一致**
- 规则配置单条全局（对账字段 + 对账内容），全部选项从模板表头字段生成
- 运算必须在相邻月份之间进行（`YYYY-MM` 字符串比较，跨年 `2025-12 ↔ 2026-01` 也算相邻）
- 差异结果持久化，支持按月单独导出 + 按月汇总导出
- 导入/运算**不阻塞 UI**（child process / utilityProcess）

### 2.3 明确不做

- 不支持 CSV / PDF 导入（仅 .xlsx）
- 不支持单月差异总条数超过 **1,048,576 行**（XLSX 单 sheet 上限；业务承诺不会超）
- 不提供规则 "多条具名库"（v2.0.0 规则是**全局唯一**，下一次保存覆盖当前；历史差异 record 保存规则 JSON 快照做回溯即可）
- 不自动运行（必须用户手动点"开始运行"）
- 不支持非相邻月份对账
- 不修改现有"网银账单生成"和"新开账户余额账单生成"两个模块的业务逻辑
- 不实现 UI 级别的规则编辑器（只用多选下拉，不做自由文本条件）
- 不做 CLAUDE.md Branch Structure 里提到的 v3.0.0 的其他需求

---

## 三、代码现状（必须有出处）

| 需求点 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 顶部模块切换 | `index.html:31`（`<button id="moduleSwitcherBtn">`）/ `src/renderer.js:39-40`（`MODULES = Object.freeze({...})`）/ `src/renderer.js:178`（`elements.moduleSwitcherBtn`）/ `src/renderer.js:1068-1090`（切换动画 + 状态同步） | 按钮点击 → 展开式切换器，2 选 1（statementGenerator / newAccountGenerator）| UI 只支持 2 项；改为 3 项需改按钮为下拉或 tab |
| state.currentModule | `src/renderer.js:90` | 默认 `MODULES.statementGenerator.id`；R1 要扩 3 选 | — |
| 主 DB `AppDatabase` | `src/backend/database.js`（门面）+ `src/backend/database/migrations.js` | 使用 `node:sqlite` DatabaseSync 指向 `{userData}/tool-data.sqlite` | 本次新增独立 DB 文件 `tool-data-pending.sqlite` 避免污染主 DB |
| xlsx 解析入口 | `src/backend/file-service/readers.js:1-23` 等 | 通过 `readRows` / `extractHeaders` 读 xlsx；大文件暂无 child process | 300 万行在主进程会阻塞 |
| PDF 解析的 child process 范式 | `src/backend/file-service/readers.js:3,23`（`execFileSync` + `pdf-worker.js`）| PDF 单独开子进程 parse，避免主进程卡死 | 本次借鉴这个范式做 xlsx child worker |
| 资源文件约定 | `assets/*.xlsx`（如 `币种映射表.xlsx`、`余额账单模版.xlsx`）| 内置资源放 `assets/`，打包时 `electron-builder.files: ["assets/**/*"]` 会包进来 | R1 `assets/Pending.xlsx` 已复制到位 |
| 文件存储目录 | `Documents/网银账单生成小助手/` 下的 `exports/` `error-reports/` `balance-seeds/` `templates/` | 本地文件系统分类存放 | R1 新增 `pending-archives/{YYYY-MM}/` 留底 |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| Pending 模板 | 内置模板 `assets/Pending.xlsx`，31 列，表头固定（见 §4.1）|
| 对账字段（match key）| 规则里多选的列集合，作为 JOIN key 判断"上月哪条 ↔ 上上月哪条" |
| 对账内容（compare field）| 规则里多选的列集合，在 key 匹配后检查这些列是否有值变化 |
| 差异 type | 三种：`new`（上月有 / 上上月无）、`missing`（上上月有 / 上月无）、`changed`（两月都有但对账内容变了）|
| 月份 label | 差异 record 的月份归属；约定等于"上月"的 `YYYY-MM`（Q-13）|
| 规则快照 | 每次运算时，把当前全局规则 `{对账字段, 对账内容}` JSON 序列化后随差异 record 存档 |
| 留底 | 覆盖导入同月份时，旧月份数据以 xlsx 写到 `Documents/网银账单生成小助手/pending-archives/{YYYY-MM}/{原文件名}-backup-{YYYYMMDDThhmmss}.xlsx` |
| 报错文件 | 多文件合并导入时行级冲突的明细，以 xlsx 导出供用户下载 |
| 差异 record | 一次"开始运行"的结果条目，key = `(上上月, 上月, 运算时间戳)`，附规则快照 + diff_type + 行内容引用 |

### 4.1 Pending.xlsx 模板表头（31 列）

从 `assets/Pending.xlsx` Sheet1 第 1 行抽取：

```
pending类型 / pending资金类型 / 账单类型 / billDate / valueDate / 平账账期 /
业务BU / 对手业务BU / 财务BU / 主体 / 对账类型 / recon_id / 金额 / 币种 /
order_no / acc_id / finish_time / 穿透ID / channel / merchant_id / bank_ref /
对账明细ID / 对账单ID / PendingBizId / 备注 / 计算金额 / 计算币种 /
是否拆分Pending / 穿透节点ID / 业务部门（流水）/ 主体（流水）
```

**关键列**：`pending资金类型`（注意首字母小写 p；导出差异分 sheet 的依据）

**~~已知可能值~~（OT-9 撤销 @ 2026-04-24，见 §十）**：~~`提现` / `退票` / `充值`~~。真实样本里观察到 `入金` 等其它值；**不再做枚举校验**，允许任意文本（含空值）入库；导出差异按 `pending资金类型` **实际出现值**动态分 sheet（writer 已按此实现）。

---

## 五、功能详细描述

### 5.1 顶级模块切换 UI：按钮改下拉

#### 5.1.1 UI 变更

**原状**：`index.html:31` 的按钮 `<button id="moduleSwitcherBtn">` + 点击后的切换动画展开。

**改为**：`<select id="topModuleSelect">` 下拉，三项枚举值：

1. `网银账单生成`（默认选中 = 向后兼容）
2. `新开账户余额账单生成`
3. `月度 Pending 数据核对`（本次新增）

下拉切换立即生效（不需要"确认"按钮）。

#### 5.1.2 state 扩展

- `src/renderer.js:39-40` 的 `MODULES` 枚举增一条 `pendingReconciliation`
- `state.currentModule` 增一种值；切换到 Pending 模块时 hide 现有两个模块的容器 DOM，show 新的 Pending 容器 DOM

#### 5.1.3 默认选项 / 持久化

- 新鲜启动：默认 `网银账单生成`（向后兼容）
- 用户刚切过 Pending 模块 → 关闭应用 → 重新打开：**不记忆**，仍默认 `网银账单生成`（v2.0.0 初期不做持久化，简化交互）

> **⚠️ 待澄清 OT-2**：是否记忆上次选择？默认不做（OT-2 = 待用户拍板）

### 5.2 Pending 模块整体布局

两行布局：

```
┌────────────────────────────────────────────────────────────────────┐
│  [规则管理]   [导入文件]   [开始运行]                               │   ← 第一行（3 按钮）
│                                                                    │
│  [导出差异]   [状态框 —————————————————————————————————]            │   ← 第二行（1 按钮 + 状态框）
└────────────────────────────────────────────────────────────────────┘
```

- 状态框位于"导入文件"和"开始运行"下侧，横跨剩余宽度
- 按钮样式复用现有"secondary-btn" / 主按钮 CSS 类

### 5.3 规则管理

#### 5.3.1 弹窗结构

点"规则管理"按钮，弹出 modal（两列 side-by-side，"对账字段" 列每行下拉左侧有序号 `1. 2. 3. ...` + 右侧问号 tooltip）：

```
┌────────────────────────────────────────────────────────────────┐
│ Pending 数据对账规则                                           │
├────────────────────────────────────────────────────────────────┤
│   对账字段 (?)                      对账内容                   │
│                                                                 │
│   1. [下拉 ▾]  [新增]               [下拉 ▾]  [新增]           │
│   2. [下拉 ▾]  [删除]               [下拉 ▾]  [删除]           │
│   3. [下拉 ▾]  [删除]                                           │
│                                                                 │
│                                           [完成] [取消]        │
└────────────────────────────────────────────────────────────────┘
```

- **序号 = 匹配优先级**：与 `matchFields` 数组顺序一致，engine 按序号逐轮 fallback 配对（见 §5.5.4）
- **问号 tooltip 文案**：「序号即匹配优先级：按序号逐轮 fallback，任一字段相等即视为同一笔。」
- 对账内容列无序号、无 tooltip（对账内容字段间无优先级；语义是"任一字段不等即 changed"）

#### 5.3.2 下拉选项

两个下拉的**可选项完全相同**：都是 §4.1 的 31 个表头字段。启动时 `assets/Pending.xlsx` 读一次缓存，整个会话期间不刷新（Q-5）。

#### 5.3.3 交互

- 对账字段多选 —— 至少选 1 项（否则无法做 JOIN，阻止保存）；"新增/删除"按钮动态扩缩行数，序号随 DOM 行序实时重排
- 对账内容多选 —— 可以空（空时 changed 类型差异恒为 0，只剩 new / missing）
- **两个下拉可以选重叠列吗**：允许，但建议不选（业务上 key 不需要同时当 value 比对）；不做强制阻止

#### 5.3.4 退出保存流程

用户在多选下拉有值的情况下，点击下拉**以外**的地方时：

1. 立刻弹出确认框，标题 `请确认筛选的字段：`，下方展示当前勾选的两组列名
2. 用户点"确认" → 规则 upsert 到 DB（覆盖旧规则；单条全局唯一）
3. 用户点"取消" → 丢弃当前未保存的选择，关闭弹窗

#### 5.3.5 规则存储

`tool-data-pending.sqlite` 表 `rule`（单行，id 固定 `'__GLOBAL__'`）：

```sql
CREATE TABLE rule (
  id TEXT PRIMARY KEY,                -- 固定 '__GLOBAL__'
  match_fields TEXT NOT NULL,          -- JSON 数组 ['pending类型', 'order_no', ...]
  compare_fields TEXT NOT NULL,         -- JSON 数组 ['金额', '币种', ...]
  updated_at TEXT NOT NULL              -- ISO8601
);
```

### 5.4 导入文件

#### 5.4.1 多文件选择

点"导入文件"按钮 → 系统文件选择对话框，**`multiSelections: true`**，`filters: [{ name: 'Excel', extensions: ['xlsx'] }]`。

一次导入可选 1~N 个 .xlsx 文件，全部计为**同一个月**的数据。

#### 5.4.2 表头校验

对选中的**每一个** xlsx 文件：

- 读 Sheet1 第 1 行
- 与 §4.1 模板表头按**顺序 + 内容**严格比对
- 任一文件不一致 → 状态框报错：`表头字段不一致，请检查并重新导入。`（整批拒绝，不入库任一文件）

#### 5.4.3 年月选择

所有文件表头校验通过后：

- 弹出日期选取框，下拉选"年份"（当前年-9 到当前年+1）+ "月份"（1-12）
- 确认后 → 该批文件全部归为 `{year}-{month}` 的 Pending 数据

#### 5.4.4 覆盖提醒

若 `{year}-{month}` 已有数据：

1. 弹提醒框：`{year}年{month}月已有 Pending 数据，继续将覆盖原数据。`
2. 用户点"确认"：
   - **先留底**：把旧月份的所有行**导出为一个或多个 xlsx**（按导入时的原文件名恢复），写到 `Documents/网银账单生成小助手/pending-archives/{year}-{month}/{原文件名}-backup-{YYYYMMDDThhmmss}.xlsx`
   - 已跑过的关联差异 record 标记作废（或直接删除，TechDoc 定）
   - 新数据入库
3. 用户点"取消" → 中止，回退状态

#### 5.4.5 多文件行级冲突检测

多文件合并成一个月时，可能出现两个文件**完全相同的行**（所有 31 列值都一样）。业务上这是"重复提交"，视为异常：

- 检测方式：对每行 31 列值拼串算 hash，全月内出现 >1 次的 hash 即冲突
- 任一冲突 → 整批导入失败
- 状态框报错：`导入失败，发现 N 条重复行，点击导出报错文件查看明细。`（点击状态框链接可导出**报错文件** xlsx，列：所在文件名 + 行号 + 31 列内容）

#### 5.4.6 事务性

- 单次多文件导入全部 INSERT 包在一个 SQLite transaction 里
- 任一文件校验失败 / 行级冲突 / INSERT 异常 → **全量 rollback**
- 留底动作也要保证失败不落脏数据

#### 5.4.7 性能

- 单文件最高 **约 300 万行 / 15 列** 用户口径；模板实际 31 列
  （⚠️ OT-1 请用户确认列数；以下假设以模板 31 列为准）
- 解析走 child process（参考 `src/backend/file-service/pdf-worker.js` 范式）
- 批量 INSERT 使用 `prepared statement` + `BEGIN/COMMIT`
- 目标：**300 万行导入 < 3 分钟**（§九）

#### 5.4.8 状态栏流程文案

| 条件 | 状态框文案 |
|---|---|
| 未设置规则 | `初次使用请确认用来筛选的字段~` |
| 已设置规则 + 无任何月份数据 | `请导入 Pending 数据。` |
| 已导入 ≥1 月 + 未运行 + 无本会话导入 / 运行结果 | `欢迎使用小助手` |
| 本会话有最新对账结果 | `对账完成：{上月} vs {上上月} 找出 {N} 条差异（...）` |
| 本会话有最新导入完成 | `{YYYY-MM} 数据已导入（{rowCount} 行）。...` |
| 导入中 | `正在导入 {YYYY-MM}：{file}（已处理 N 行）` |
| 对账中 | `正在对账 {上月} vs {上上月}...` |
| 表头不一致报错 | `表头字段不一致，请检查并重新导入。` |
| 行级冲突报错 | `导入失败，发现 {N} 条重复行，[点击导出报错文件]。` |

### 5.5 开始运行（对账）

#### 5.5.1 弹窗结构

点"开始运行" → 弹 modal：

```
┌─────────────────────────────────────────────────┐
│ 请选取需要比对 Pending 数据的月份                │
├─────────────────────────────────────────────────┤
│ 上上个月 Pending 文件  [单选下拉 ▾]              │
│ 上个月 Pending 文件    [单选下拉 ▾]              │
│                                                  │
│                               [取消] [完成]     │
└─────────────────────────────────────────────────┘
```

两个下拉的选项：`pending_months` 表里当前所有月份，按 `YYYY-MM desc` 排序。

#### 5.5.2 月份校验

点"完成" → 二次确认框 → 点确认后：

- 校验上上月 < 上月（字符串比较 `YYYY-MM`）
- 校验相邻：上月的上一个月 == 上上月（按日历计算：`2025-12` 的上一个月 == `2025-11`；跨年 `2026-01` 上一月 == `2025-12`）
- 不相邻 → 弹错框：`选取的月份不是相邻月份，请重新选择。`，点确认回到弹窗（保留已选值）

#### 5.5.3 ~~预计完成时间~~（已移除 — 2026-04-24 Reverse Sync #6）

**决策**：删除 benchmark 预估功能。

**原因**：
- benchmark 代码写于 v1 SQL 语义（NOT EXISTS），engine 在 Reverse Sync #5 切到 JS 层 Map 配对后，两条路径的 per-row cost 差一个数量级
- 实测偏差极大：用户看到"预计 3 分 20 秒"，实际几秒完成
- 真实 engine 已经够快（243 万行 4.31 秒），无预估必要

**实施**：
- `src/backend/pending-reconcile/benchmark.js` 整文件删除
- 撤回 IPC `pending:reconcile:benchmark` + preload `pending.reconcile.benchmark`
- 状态栏文案简化为 `正在对账 {上月} vs {上上月}...`（无预估时间）

#### 5.5.4 对账运算（A1 fallback 语义 — 2026-04-24 Reverse Sync）

**同一笔定义**：按对账字段顺序做 N 轮 fallback 配对。只要**任一**对账字段能在剩余未匹配行里配上，就视为同一笔。

**算法**：
1. 初始 `matched_upper_ids = ∅`，`matched_lower_ids = ∅`
2. 对每个 `match_field_i`（按 UI 顺序）：
   - 从两月取未 matched 的行（排除 NULL/空值 key）
   - 按 `match_field_i` 值分组，组内按 `pending_rows.id` 升序
   - 同一分组内 upper 和 lower 行**按序号 1 对 1 配对**（`min(upper.length, lower.length)` 对）
   - 配对成功的行加入 `matched_*_ids`
3. 三类差异判定：
   - **changed**：配对成功对 + `compare_fields` 任一列不等
   - **new**：lower 月行不在 `matched_lower_ids` 里
   - **missing**：upper 月行不在 `matched_upper_ids` 里

**实现**：SQL 只做每轮 `(id, match_field)` 的覆盖索引扫描（ORDER BY id 免 sort），JS 层做 Map 分组 + 1 对 1 配对（`Set<id>` 跟踪已匹配）。配对完成后 SQL 做最后的 changed/new/missing 三段 INSERT。243.68 万行实测 ~4 秒。

**changed 比对口径**（OT-8 延续）：`compare_fields` 逐列 `IS NOT` 比较，NULL-safe（两 NULL 视相等；NULL vs 非 NULL 视不等）。字符串层面严格相等，`金额="100.00"` vs `金额="100"` 视不等。

**match 比对口径**：单轮内 `=` 比较，NULL 不参与配对（无效 key 直接流到下一轮或最终 new/missing）。

#### 5.5.5 结果落库

差异 record 的 key = `(上上月, 上月, 运算时间戳)`。每次"开始运行"新增一条，历史不覆盖（Q-20 保留所有版本）。

落库 schema（详见 §八）：

- `diff_runs`（一次运算一行）：upper_month / lower_month / rule_snapshot / created_at / stats
- `diff_rows`（差异明细）：run_id / type / upper_row_id / lower_row_id

#### 5.5.6 完成状态

运算完成，状态栏显示：

- 无差异：`对账完成：{上月} vs {上上月} 无差异。`
- 有差异：`对账完成：{上月} vs {上上月} 找出 {N} 条差异（{newCount} 新增 / {missingCount} 消失 / {changedCount} 变更），可点击"导出差异"另存。`

### 5.6 导出差异

#### 5.6.1 按钮启用条件

- `diff_runs` 表有**任意历史 run** → 启用（打开模块时即判定，不限于本会话运行过）
- 空表 → 禁用（置灰）
- 实现：模块 `initialize` 期间调 `listAllRuns()`，若返回非空则设置 `state.pending.latestRunId = allRuns[0].id`（已按 `created_at DESC, id DESC` 排序，`[0]` 即最新）

#### 5.6.2 导出形态（OT-10 = 单月选 run，汇总取最新）

点"导出差异" → 弹选择框（标题左上加粗；月份下拉窄、Run 下拉宽、平行于同一基线）：

```
┌──────────────────────────────────────────────────────────┐
│ 导出月份范围                                              │
├──────────────────────────────────────────────────────────┤
│ ○ 导出指定月份                                            │
│                                     Run                  │
│     [月份 ▾]     [Run 下拉（displays created_at + 规则） ▾] │
│                                                           │
│ ○ 导出所有月份汇总（每月取最新 run）                       │
│                                                           │
│                                       [导出] [取消]      │
└──────────────────────────────────────────────────────────┘
```

- 月份下拉左边对齐"导出指定月份"文本左边（缩进 22px 跳过 radio 宽度）
- "Run" 文本位于 Run 下拉的左上角（`align-items: flex-end` 让两下拉按底部对齐成平行 → "Run" header 自然浮在 Run 下拉之上）
- 按钮顺序：左 `[导出]` / 右 `[取消]`（与其他弹窗相反）

Run 下拉显示格式示例：

```
2026-04-23 14:30:00  差异 42 条  规则 {order_no × 金额,币种}
2026-04-22 09:15:00  差异 35 条  规则 {order_no × 金额}
```

单个月份只有 1 个 run 时，Run 下拉自动选中该唯一值，不需用户确认。

#### 5.6.3 单月导出

选"指定月份 = {上月}" + "Run = 某次运算"：

- 取该 `run_id` 对应的差异明细
- 文件结构：
  - **Sheet1** 名 `汇总`：所有差异行。列 = 31 原列 + `diff_type` + `pair_id` + `change_side` + `changed_fields` + 按 run 快照里的 `compare_fields` 动态展开的 `<field>_before` / `<field>_after` 列 + 末尾可选的 `金额_diff` / `计算金额_diff`
  - **Sheet2~N** 名为 `{pending资金类型 值}`：按**行自身** `pending资金类型` 的实际值动态建 sheet；若 changed pair 两行资金类型不同，两行各自落到对应 sheet
  - **[可选] Sheet** 名 `pending资金类型差异`：仅在 `compare_fields` 含 `pending资金类型` 时出现；收录 changed pair 中 `pending资金类型` 发生变更的那些对（before/after 双行）；无差异则空表（仅 header）
- 文件名：`月度Pending差异-{上月}-run{YYYYMMDDThhmmss}.xlsx`（时间戳=该 run 的 created_at）

#### 5.6.4 所有月份汇总导出

- 每个月份对**只取最新 run**（避免跨月混规则版本造成的统计混乱）
- **Sheet1** 名 `按月维度区别汇总`：所有月份 label 最新 run 的差异串联，最老 → 最新；不同 label 之间用空行 + 月份 label 标题隔开
- **Sheet2** 名 `汇总`：全部差异行平铺（不分月份）
- 列扩展策略：各月份最新 run 的规则快照可能不同（规则被改过），`compare_fields` 并集展开为列；某 run 不含的列留空
- 文件名：`月度Pending差异-汇总-{最早月份}至{最新月份}.xlsx`

#### 5.6.5 变更前后值列结构（changed 行展成 2 行）

对规则里 `compare_fields = ['金额', '币种']` 的例子，一对 changed pair 展成 **before + after 两行**：

| 原 31 列 | diff_type | pair_id | change_side | changed_fields | 金额_before | 金额_after | 币种_before | 币种_after | 金额_diff |
|---|---|---|---|---|---|---|---|---|---|
| ...上上月快照 (upper_id=5)... | `changed` | `5_12` | `before` | 金额 | 100 | 150 | USD | USD | 50 |
| ...上月快照 (lower_id=12)... | `changed` | `5_12` | `after` | 金额 | 100 | 150 | USD | USD | 50 |
| ...上月行内容... | `new` | — | — | — | — | — | — | — | — |
| ...上上月行内容... | `missing` | — | — | — | — | — | — | — | — |

- `changed`：**一对变两行**，同 pair_id 共享 `changed_fields` / `_before` / `_after` / `_diff`；`change_side=before` 行的 31 原列用上上月快照，`change_side=after` 用上月快照
- `new`：1 行，原 31 列用**上月版本**；`pair_id` / `change_side` / `changed_fields` / `_before` / `_after` / `_diff` 全空
- `missing`：1 行，原 31 列用**上上月版本**；同上全空
- 行序：跨 pair 按 `upper_id` 升序（即 SQL `diff_rows.id` 升序）；一对内 `before → after`
- `金额_diff` / `计算金额_diff`：仅当 `compare_fields` 含对应字段时出列；值 = `parseFloat(lower) - parseFloat(upper)`；解析失败留空
- `changed_fields`：逗号分隔列出该 pair 里 upper ≠ lower 的 compareField 名（字符串比较，空值统一当 `''`）

#### 5.6.6 导出文件保存位置

默认另存为对话框（和现有 `Documents/网银账单生成小助手/exports/{日期}/` 一致的模式）。

---

## 六、验收标准

> 本章节共 **21 条** AC。

### 6.1 顶级模块切换 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 顶部显示下拉 `topModuleSelect`，3 个选项（网银账单生成 / 新开账户余额账单生成 / 月度 Pending 数据核对）|
| AC1-2 | 首次启动默认选中"网银账单生成"；切换到 Pending 后关闭重开仍默认"网银账单生成"（OT-2）|
| AC1-3 | 切换时立即 hide/show 对应模块容器，不弹框不需确认 |

### 6.2 规则管理 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 规则管理弹窗两个下拉选项均为 §4.1 的 31 列（从 `assets/Pending.xlsx` 读取）|
| AC2-2 | 对账字段至少选 1 项；对账内容可空 |
| AC2-3 | 点击下拉以外任意区域 → 弹确认框，显示当前勾选内容；确认 upsert DB，取消丢弃 |
| AC2-4 | 同一会话多次修改：新规则覆盖旧规则（`rule.updated_at` 更新）|
| AC2-5 | 对账字段每行下拉左侧有序号（1., 2., 3., ...），序号等于 `matchFields` 数组下标 + 1，反映 engine fallback 轮次优先级；新增/删除行时序号实时重排 |
| AC2-6 | 对账字段 header 右侧有问号 tooltip，文案说明序号即匹配优先级；对账内容 header 无 tooltip 且文本横向中心对齐到其下拉中心 |

### 6.3 导入文件 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 文件选择支持多选 .xlsx；非 xlsx 扩展名不出现在文件选择器中 |
| AC3-2 | 任一文件表头不完全匹配 §4.1 → 整批拒绝，状态框显示 `表头字段不一致...` |
| AC3-3 | 表头通过 → 弹年月选择；确认后批量数据归为该月 |
| AC3-4 | 重复导入同月 → 弹提醒框；确认后旧数据留底到 `pending-archives/` 再覆盖入库 |
| AC3-5 | 多文件合并时出现全列值重复的行（hash 冲突）→ 整批失败，状态框提示 + 导出报错文件 |
| AC3-6 | 单文件 300 万行 / 31 列的导入**不阻塞 UI**（child process）|
| AC3-7 | 导入完成，`pending_months` 表新增一条；`pending_rows` 批量入库，行数等于总行数 |

### 6.4 开始运行 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC4-1 | 弹窗下拉显示 `pending_months` 表所有月份（`YYYY-MM desc`）|
| AC4-2 | 点完成 → 二次确认 → 校验相邻（跨年算相邻）|
| AC4-3 | 不相邻 → 错框 + 保留已选；相邻 → 继续 |
| ~~AC4-4~~ | ~~预计时间估算~~（2026-04-24 移除，见 §5.5.3）|
| AC4-5 | 对账运算产出三类差异（new / missing / changed），落 `diff_runs` + `diff_rows` 表 |
| AC4-6 | 状态栏显示最终统计：`对账完成：{上月} vs {上上月} 找出 N 条差异（X 新增 / Y 消失 / Z 变更）` |

### 6.5 导出差异 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC5-1 | `diff_runs` 空 → "导出差异" 按钮置灰（有历史 run 时打开模块即可用）|
| AC5-2 | 单月导出：Sheet1 = 汇总；Sheet2~N 按行自身 `pending资金类型` 分组 |
| AC5-3 | 汇总导出：Sheet1 = 按月维度区别汇总（最老→最新，空行分隔）；Sheet2 = 总汇总 |
| AC5-4 | 差异 xlsx 列 = 31 原列 + `diff_type` + `pair_id` + `change_side` + `changed_fields` + 规则里 `compare_fields` 动态展开 `_before` / `_after` + 末尾可选 `金额_diff` / `计算金额_diff` |
| AC5-5 | `changed` pair 展 2 行：before = 上上月快照、after = 上月快照，同 `pair_id`；`new` 行原列用上月版本；`missing` 行原列用上上月版本；new/missing 的新增元数据列全空 |
| AC5-6 | `compare_fields` 含 `pending资金类型` → 导出 xlsx 多一张 `pending资金类型差异` sheet，仅收录资金类型变更的 pair；无变更时空表（仅 header） |
| AC5-7 | `compare_fields` 含 `金额` / `计算金额` → 末尾出对应 `_diff` 列；changed 行值 = `parseFloat(lower) - parseFloat(upper)`，解析失败或 new/missing 留空 |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| P0-1 首次切到 Pending 模块 | 点下拉选 "月度 Pending 数据核对" | 新鲜安装 | 下拉三项齐；Pending 布局显示；状态框 `初次使用请确认用来筛选的字段~` |
| P0-2 规则首次保存 | 规则弹窗勾 `order_no`（字段）+ `金额`（内容）→ 点下拉外部 → 确认 | — | DB `rule` 表有一行；状态框变 `请导入 Pending 数据。` |
| P0-3 单文件导入 | 导入一个 10 万行的 Pending.xlsx，选 `2026-03` | 规则已设 | 状态框显示进度 → 成功；`pending_months` + `pending_rows` 有数据 |
| P0-4 表头不一致 | 导入一个少一列的 .xlsx | — | 状态框 `表头字段不一致...`；DB 无写入 |
| P0-5 多文件同月合并 | 导入文件 A（5 万行）+ 文件 B（7 万行）→ 选 `2026-03`（无冲突行） | — | 总 12 万行入库到 `2026-03` |
| P0-6 多文件行级冲突 | A 和 B 里有 1 条完全重复行 | — | 状态框提示 1 条冲突；点链接下载报错 xlsx；DB 未写入 |
| P0-7 重复月份覆盖 | `2026-03` 已有；再次导入到 `2026-03` | P0-3 已跑 | 弹覆盖确认；确认后旧数据留底到 `pending-archives/2026-03/`；新数据入库 |
| P0-8 对账相邻月 | 导入 `2026-02` + `2026-03` → 开始运行选 02+03 | — | 通过校验，产出差异；状态栏完整统计 |
| P0-9 对账非相邻 | 导入 `2026-01` + `2026-03` → 选 01+03 | — | 错框 `选取的月份不是相邻月份...`，保留已选 |
| P0-10 对账跨年相邻 | 导入 `2025-12` + `2026-01` → 选 | — | 通过校验 |
| P0-11 无差异场景 | 两月数据完全一致 | — | 状态栏 `对账完成：... 无差异。`；导出按钮依然可用（但导出是空汇总）|
| P0-12 单月导出 | 按 P0-8 跑完 → 导出指定月 2026-03 | — | xlsx 产出；Sheet1 汇总；Sheet2+ 按 `pending资金类型` 分组 |
| P0-13 汇总导出 | 多次运行（跨 2 个月份对）后汇总导出 | — | Sheet1 按月分区；Sheet2 总汇总 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| P1-1 大文件性能 | 导入 300 万行文件 | 配 8GB 以上内存机器 | < 3 分钟完成；UI 不卡死；状态栏进度可见 |
| P1-2 规则覆盖 | 同一会话多次规则修改 | — | 最后一次为准；旧规则不影响新差异运算 |
| P1-3 规则变更后重跑 | 跑 run1 → 改规则 → 跑 run2 同月份对 | — | 两条 `diff_run` 都在；导出"最新"取 run2；规则快照分别存 |
| P1-4 取消覆盖 | P0-7 场景里点"取消" | — | 原数据不变，无留底文件写出，状态回退 |
| P1-5 年月选择边界 | 选 2017-01 / 2027-12 | — | 可选 |
| P1-6 并发保护 | 运算中再点"开始运行" | — | 按钮置灰 / 弹"上一个运算还在进行"提示 |
| P1-7 child process 意外退出 | 解析过程中 kill 子进程 | — | 主进程 catch；状态栏报错；DB rollback |
| P1-8 导出时跨行样式 | xlsx 列标题字体是否延续 v1.5.3 Courier New 约定 | — | **（OT-3）PRD v0 暂未规定**—— 建议和 v1.5.3 一致 |

### 7.3 不测项与原因

- **CSV 导入**：明确不做
- **PDF 导入**：明确不做
- **单月差异 >105 万行**：业务承诺不超
- **规则导出 / 导入**：v2.0.0 不做（后续版本再加）
- **跨两台机器数据同步**：不做
- **历史差异 record 手动清理 UI**：不做（DB 文件独立，用户可直接删）

---

## 八、数据 / 状态 / 安全影响

### 8.1 数据结构变更

**新增独立 SQLite 文件**：`{userData}/tool-data-pending.sqlite`

**表结构**（TechDoc 细化，PRD 给出概要）：

```sql
CREATE TABLE rule (
  id TEXT PRIMARY KEY,                  -- 固定 '__GLOBAL__'
  match_fields TEXT NOT NULL,            -- JSON 数组
  compare_fields TEXT NOT NULL,          -- JSON 数组
  updated_at TEXT NOT NULL
);

CREATE TABLE pending_months (
  year_month TEXT PRIMARY KEY,           -- '2026-03'
  imported_at TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  source_files TEXT NOT NULL             -- JSON 数组 ['filename1.xlsx', ...]
);

CREATE TABLE pending_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_month TEXT NOT NULL,
  row_hash TEXT NOT NULL,                -- 31 列拼串 SHA-1（行级冲突检测）
  -- 31 列各一列 TEXT（原列名，NULL 表示缺失）
  pending类型 TEXT, pending资金类型 TEXT, 账单类型 TEXT, ...
  -- INDEX (year_month, row_hash)
);

CREATE TABLE diff_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upper_month TEXT NOT NULL,             -- 上上月
  lower_month TEXT NOT NULL,             -- 上月
  rule_snapshot TEXT NOT NULL,           -- JSON 快照 {match_fields, compare_fields}
  created_at TEXT NOT NULL,
  stat_new INTEGER NOT NULL,
  stat_missing INTEGER NOT NULL,
  stat_changed INTEGER NOT NULL
);

CREATE TABLE diff_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- 'new' | 'missing' | 'changed'
  upper_row_id INTEGER,                  -- pending_rows.id，changed/missing 时有值
  lower_row_id INTEGER                   -- pending_rows.id，changed/new 时有值
  -- INDEX (run_id, type)
);
```

### 8.2 状态流转变更

- renderer `state` 新增：`currentTopModule`（扩 3 选 1）、`pending.rule`（缓存当前规则）、`pending.months`（已导入月份列表）、`pending.runningRunId`（运算中标记）
- main 进程新增：`pendingDb`（第二个 DatabaseSync 句柄）、`pendingWorker`（child process 句柄，懒启动）

### 8.3 权限 / 安全

- 仅本地文件读写（与现有模块同权限等级）
- 留底路径在 `Documents/网银账单生成小助手/pending-archives/` 下，用户可自行删除
- **⚠️ 风险（资金敏感）**：Pending 数据含金额 / 币种 / 资金类型，虽然本地单机无同步风险，但误覆盖会丢数据 → 已用"覆盖前留底"缓解（§5.4.4）

### 8.4 回滚策略

- 数据损坏：删 `tool-data-pending.sqlite` 文件即可清空（main DB 不受影响，v1.5.3 基础设施仍可用）
- 代码回滚：整个 Pending 模块代码隔离在 `src/main-process/pending/` + `src/renderer-pending.js` + `src/backend/pending-db.js` 等新文件，反向删除即可

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | v1.5.3 现有两个模块零改动；新模块用独立 DB 文件；顶部切换 UI 重做但不影响 v1.5.3 功能 |
| 性能 | 300 万行 / 31 列 xlsx 导入 **< 5 分钟**（M1/M2 级机器；child process 带 `--max-old-space-size=8192` 参数；Dev sign-off OT-T1 后从 3 分钟放宽至 5 分钟）；对账 SQL 运行 < 1 分钟 |
| 内存 | 主进程内存使用不超过导入前的 +100MB（所有重负载跑 child process）|
| 鲁棒性 | 单文件导入事务化；行级冲突整批 rollback；运算失败 DB 状态不污染 |
| 可观测 | 状态框全流程提示；错误报告 xlsx 可导出审计 |
| 打包 | `assets/Pending.xlsx` 通过 `electron-builder.files: ["assets/**/*"]` 已自动包含 |
| 导出样式 | 差异 xlsx 第 1 行表头字体延续 v1.5.3 Courier New 约定（OT-3）；数据区字体不动 |

---

## 十、决策记录

v0 的 10 个 OT 已由用户逐条拍板，结果如下：

| # | 问题 | 结论 | 落地位置 |
|---|------|------|---------|
| OT-1 | 单文件列数 | **以模板 31 列为准**（用户最初说"15 列"是口误） | §4.1 |
| OT-2 | 顶部下拉跨启动记忆 | **不记忆**，默认"网银账单生成" | §5.1.3 |
| OT-3 | 导出差异 xlsx 字体 | **延续 v1.5.3 Courier New** 表头约定（TechDoc 在 writer 接入 xlsx-js-style 字体注入） | §九（新增）|
| OT-4 | `pending_rows` 非 key 列索引 | **TechDoc 定**（PRD 层搁置，权衡磁盘 vs 查询） | TechDoc |
| ~~OT-5~~ | ~~benchmark 采样行数~~ | ~~固定 10000 行~~（2026-04-24 移除 benchmark，见 §5.5.3） | ~~§5.5.3~~ |
| OT-6 | 报错文件格式 | **xlsx**（与现有 `error-reports/` 对齐） | §5.4.5 |
| OT-7 | 运算中用户关应用 | **child process kill + DB rollback**；保证无脏数据 | §五 / §P1-7 |
| OT-8 | `changed` 比对口径 | **按值严格相等**（字符串 `===`，非 hash） | §5.5.4 |
| OT-9 | `pending资金类型` 枚举 | ~~{提现/退票/充值} 三种枚举校验~~ **2026-04-24 撤销**：真实样本出现 `入金` 等其他值，改为**任意文本允许入库**；导出按实际值动态分 sheet | §4.1 / §5.4 |
| OT-10 | 历史 run 是否可导出 | **单月选 run（支持历史）；汇总取每月最新 run** | §5.6.2 / §5.6.4 |

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-04-23 | v0 初稿（10 个 OT 待定）|
| 2026-04-23 | v1 定稿（OT-1~OT-10 已回写到 §4.1 / §5.1.3 / §5.4 / §5.5 / §5.6 / §九；§十 由"待澄清"改为"决策记录"）|
| 2026-04-24 | **Reverse Sync v1→v1.1**：T12 真实样本测试发现 OT-9 枚举不完整（样本出现 `入金`）→ **撤销**枚举校验；同时发现 xlsx 库读不了大 inline-string 文件 → **换 ExcelJS**；worker 改**流式 INSERT** 防 OOM；engine/benchmark 加**复合索引**性能修复（对账 15 分钟 → 2.85 秒）。见 `changes/v2.0.0/log.md` 2026-04-24 段。|
| 2026-04-24 | **Reverse Sync #6 — UX 打磨 + 导出格式增强**（用户手工测试反馈）：① 状态框初始文案"已导入..."→"欢迎使用小助手"；② 导出差异按钮由"本会话有 run"放宽为"DB 有任意历史 run"；③ 规则管理弹窗对账字段加序号 1./2./... + tooltip；④ 对账内容 header 水平居中到其下拉中心；⑤ 删除 benchmark（失真严重，见 §5.5.3）；⑥ 导出月份范围弹窗 UI 重新排布（详见 §5.6.2）；⑦ 对账确认框月份值加粗；⑧ **导出差异输出格式重大增强** changed pair 展开为 before/after 双行，新增 `pair_id / change_side / changed_fields` 元数据列 + 可选 `金额_diff / 计算金额_diff` + 可选 `pending资金类型差异` sheet（见 §5.6.3 / §5.6.5 / AC5-6 / AC5-7）。见 `changes/v2.0.0/log.md`。|

---

## 十二、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。

### PR #24（2026-04-24 merged，`cb934d9b`） — Reverse Sync #6 + Codex 二次 review 修复

**主线改动**（8 项）：

1. 状态框 idle 文案改 "欢迎使用小助手"（`src/renderer-pending.js` §5.4.8）
2. 导出差异按钮放宽：DB 有任意历史 run 即启用（`src/renderer-pending.js` initialize + §5.6.1）
3. 规则弹窗对账字段加序号 `1./2./...` + header `?` tooltip（§5.3.1 + AC2-5/6）
4. 对账内容 header 水平居中到下拉中心（`.pending-rule-column-aligned` 类）
5. 删除 benchmark 整模块（`pending-reconcile/benchmark.js` / IPC / preload / UI 调用 / test T5 / T12-3，见 §5.5.3）
6. 导出月份范围弹窗 UI 重排（`.pending-export-cols` 样式族，见 §5.6.2）
7. 对账确认框月份值 `<strong>` 加粗
8. **⚠️ 资金敏感** 导出差异格式增强：changed pair 展 before/after 双行；新增 `pair_id / change_side / changed_fields` 元数据列；compareFields 含金额/计算金额 → `_diff` 列；含 `pending资金类型` → 专门 sheet（§5.6.3 / §5.6.5 / AC5-6/7）

**Codex 二次 review 修复**（2 P1 finding）：

9. **Finding 1** `writer.js` aggregate 越权重算：`buildExportRowsForDiff` 签名拆 `runCompareFields`（值）+ `headerCompareFields`（列位），符合 PRD §5.6.4 "某 run 不含的列留空"
10. **Finding 2** `month-repository.deleteMonth` 未级联：覆盖导入时手动 DELETE 涉及该月的 `diff_runs` + `diff_rows`，修复 orphan 指向已删除行的风险（FK CASCADE 因 PRAGMA off 未生效）

**自我 review**：T5 金额数据改 500→888，让 Finding 1 回归真正可挂（原测试金额巧合相等，changed_fields 断言旧 bug 下也通过）。

**测试**：pending-export 22 → **66 断言**（新增 T3 空资金类型 sheet / T4 资金类型双行 / T5 aggregate 独立性 / T6 级联清理）；pending-reconcile 22 / pending-session 19 / smoke 均绿。

**文件改动**：13 个（首轮）+ 5 个（修复轮）+ 1 个（强化 T5）= 共 15 unique 文件涉及。

**Commits**（合并后消失于 v2.0.0 线性历史）：
- `2cbc4b9` 主线
- `7b86dc9` Codex finding fix
- `73cf68c` self-review T5 强化
- `cb934d9` merge commit


