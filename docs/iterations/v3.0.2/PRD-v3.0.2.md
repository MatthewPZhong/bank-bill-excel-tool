# PRD - 网银账单小助手 v3.0.2

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.2 |
| 日期 | 2026-06-10 |
| 作者 | PM |
| 状态 | 定稿（已实施，reverse-sync 用户修订 + 实施记录） |
| 模块 | 业务OP数据核对（biz-op-recon）、对账单修复（recon-id-fix，含 business / gateway 两子模式）、网关对账单修复场景配置 |
| 依赖 | v3.0.1 baseline（从 v3.0.1 或 main 切 `v3.0.2` 开发分支）；本迭代不依赖未合并 PR |
| 风险等级 | 🔴 高（需求1b 流水批量导入含资金红线：必须单进程单事务合并、单次 `clearByDate`；需求3 字段取值赋值含资金红线：不污染原始行、分组 seq 全程 Number、idEnabled=false 保留原值） |
| 范围来源 | 已批准实施计划 `~/.claude/plans/3-0-2-1-op-3-0-1-immutable-flask.md`（唯一事实来源） |

> **本 PRD 是 v3.0.2 迭代的需求索引 + 正文**。本迭代含 3 项相对独立、分属三个模块的需求，作为评审与实施的单一入口；技术实现见同目录 `TECH_DESIGN-v3.0.2.md`，变更目录入口见 `changes/v3.0.2/spec.md`。

---

## 一、需求概述

本次包含 **3 项需求**（分属三个不同模块）：

1. **业务OP数据核对「导入流水表」批量多选导入 + 回滚 v3.0.1 左列平移**（🔴 资金红线）—— 「导入流水表文件」当前只能单文件导入，改为一次导入同一天的多个流水表文件（共享同一日期，合并入库）；同时回滚 v3.0.1 给该模块左列做的「整体右移」前端平移调整（用户认为不需要）。
2. **「对账单 ReconID 修复」模块改名「对账单修复」**（🟢 纯前端文案）—— 模块显示名 + 用户可见的两个场景类别 label 去掉「ReconID」字样；内部 id / IPC 模块标识 / usage-stats 统计 key 全部不动。
3. **网关对账单修复 - 场景配置新增「修复订单字段取值」**（🔴 资金红线）—— 在新增/修改场景对话框：原「订单修复ID取值」行改名「修复订单ID取值」并加「启用该功能」开关；新增「修复订单字段取值」功能（独立开关 + 多行规则），匹配成功后把从边渠道字段值赋给主边网关字段，叠加到现有订单修复导出。

预期结果：批量导入提效（同一天多个流水表一次合并入库）、模块命名更简洁、网关对账修复支持「跨账单字段回填」并随订单修复文件一起导出。

> ⚠️ **版本定级说明**：需求1b（流水批量导入）与需求3（修复订单字段取值）均为「功能新增」级别（语义化版本通常计 MINOR），需求1a（回滚平移）/ 需求2（改名）为 PATCH 级。经实施计划已批准，3 项一并收口为 **v3.0.2** 发布。

---

## 二、背景与目标

### 2.1 背景

| 需求 | 为什么做 | 用户 / 业务价值 | 当前问题 |
|------|---------|----------------|---------|
| 需求1a | 用户反馈 v3.0.1 给业务OP核对模块左列做的「整体右移」不需要 | 还原观感，避免误导布局 | v3.0.1 需求2 在 `styles-gemini-extra.css` 加了 `#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px); }`，用户希望撤销 |
| 需求1b | 用户需一次导入同一天的多个流水表文件 | 批量提效，省去逐文件导入 | 现状「导入流水表」只支持单文件（`pickFlowFile` 单选 + `runFlowImport({date, filePath})` 单数）；用户需对同一天多个流水表文件合并导入 |
| 需求2 | 模块名称含「ReconID」过技术化，用户希望简洁 | 命名直观、降低非技术用户理解成本 | 顶部模块切换器显示「对账单 ReconID 修复」、场景类别下拉显示「单据对账 ReconID 修复」/「网关对账单 ReconID 修复」，均带「ReconID」字样 |
| 需求3 | 网关对账修复目前只能回填一个对账号（Reference / ID 取值），用户需把从边（渠道）账单的其它字段值回填到主边（网关）账单 | 支持「跨账单字段回填」，一次对账修复即可补齐更多字段，随订单修复文件一起导出 | 现状 `c4-recon-id-fix.js` 仅支持 ID 取值（Reference 赋值），无「按规则把从边字段值赋给主边字段」的能力；且 ID 取值为强制必填，无法跳过 |

### 2.2 目标

- **需求1a**：删除 v3.0.1 给业务OP核对模块左列加的 `transform: translateX(85.5px)` 平移规则，左列两元素回到 v3.0.1 之前位置；保留同段其它 v3.0.1 样式（`.gateway-recon-picker-card`、`.linked-table-delete-range-card`）不动。
- **需求1b**：「导入流水表」改为「先选一个日期 → 多选文件 → 全部合并导入到该日期」；多文件合并 = 该日期的完整流水快照（与「重导替换该日期」语义一致）；🔴 **必须单进程单事务合并、单次 `clearByDate`**，禁止循环调用现有 `runFlowImport`（否则后文件清掉前文件刚插入的行 → 静默丢数据）；任一行校验失败 → 整批拒绝（聚合错误报告）；单文件场景与现状行为完全一致。
- **需求2**：仅改 3 处用户可见 UI 字符串（模块显示名 + 两个场景类别 label）去掉「ReconID」；内部 id（`recon-id-fix` / `gateway-recon-id-fix`）/ IPC 模块标识 / usage-stats 统计 key / DB schema CHECK 约束全部不动（统计连续、零风险）。
- **需求3**：
  - 原「订单修复ID取值」行改名「修复订单ID取值」，新增「启用该功能」开关（`idEnabled`，默认勾选保持现有必填；取消勾选则跳过 Reference 赋值与校验，Reference 保留网关账单原值）。
  - 新增独立的「修复订单字段取值」功能（`fieldValue.enabled`，默认关；可与 ID 取值同时启用）：多行规则，每行 = 下拉1（主边分组 seq）+ 下拉2（网关字段 `GATEWAY_BILL_FIELDS`）+「取」+ 下拉3（从边分组 seq）+ 下拉4（渠道字段 `CHANNEL_BILL_FIELDS`）+「新增」按钮；匹配成功后按 `_types` 分组过滤生效，命中则取从边渠道字段值赋给主边网关字段。
  - 赋值叠加到现有订单修复导出（14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板，目标列落在 14 列内才体现于导出）。

### 2.3 明确不做

- **不改** 业务OP 文件（`kind='bizOp'`）的导入流程——本迭代批量导入仅针对流水表（`kind='flow'`），`runBizOpImport` 不动（需求1b 范围限定）。
- **不改** 其它链接表 / 对账引擎编排器 / R 系列引擎——需求3 仅扩 `c4-recon-id-fix.js`（gateway 子模式 C4 引擎）。
- **不动** 内部 id / IPC 模块标识 / usage-stats 统计 key / DB schema CHECK 约束（需求2 改名仅触用户可见 UI 字符串，沿用 v2.1.14「银行对账单处理→资金对账数据处理」先例）。
- **不做** config 的 DB migration、**不 bump** scenarios bundle 的版本号——需求3 的 `config.output.idEnabled` / `config.fieldValue` 是自由 JSON 新增可选字段，旧应用忽略、旧 bundle 入口兜底默认（`src/backend/scenarios-bundle-io.js` 既有「新增可选字段透传」先例）。
- **不改** business 子模式的引擎 / UI 行为——business 与 gateway 共用 config schema，但 `fieldValue` 仅 `cfg._subMode==='gateway'` 消费，business 不读。
- 三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）在 v3.0.2 **转正发布时**统一更新（本 PRD 不含其正文）。

---

## 三、代码现状（必须有出处）

| 需求 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 需求1a·平移 CSS | `src/styles-gemini-extra.css:3373-3376` | v3.0.1 加 `#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px); }` | 用户认为不需要，需删除 |
| 需求1b·前端选择 | `src/renderer.js` `importFlowStage`（约 5380 / 5392-5395） | `pickFlowFile` 取单个 `filePath`；`runFlowImport({date, filePath})` 单数；状态文案按单文件 | 只能单文件导入 |
| 需求1b·文件对话框 | `src/main.js:10762-10770` `pick-flow-file` handler | `properties` 不含 `multiSelections`，返回单 `filePath` | 无法多选 |
| 需求1b·运行 handler | `src/main.js:10811-10838` `run-flow` handler | 接收单 `filePath` 传 worker | 单数参数 |
| 需求1b·worker 入口 | `src/main-process/biz-op-recon-session.js` `runFlowImportViaWorker`(721) + `spawnImportWorker`(569) | jobMeta 带单 `filePath` | 单文件 |
| 需求1b·worker 核心 | `src/backend/biz-op-recon-import/import-worker.js` `runFlowImport`(268) + jobMeta 校验(391-397) | 单 date 落库 = `clearRunsAndDiffsByDate(date)`(289) + `flowImportsRepository.clearByDate(date)`(290) 清空该日期跨所有 BU 旧流水 → 再 INSERT，整个在一个事务内（`cleared` 标志 271/295 保证只清一次） | 🔴 若循环调用，第 2 个文件的 `clearByDate` 会清掉第 1 个文件刚插入的行 → 只剩最后一个文件（资金事故） |
| 需求1b·同步 fallback | `src/main-process/biz-op-recon-session.js` `runFlowImportAsync`(491) | 无 dbPath 兜底路径，单文件单次 clear + insert | 需与 worker 同语义改造 |
| 需求2·模块名 | `src/renderer.js:66` | `reconIdFix.name: '对账单 ReconID 修复'`（顶部模块切换器显示名） | 含「ReconID」 |
| 需求2·类别 label | `src/renderer-dialogs.js:7553` / `:7554` | `{ value: 'recon-id-fix', label: '单据对账 ReconID 修复' }` / `{ value: 'gateway-recon-id-fix', label: '网关对账单 ReconID 修复' }` | 含「ReconID」 |
| 需求2·统计 key（不动） | `src/backend/usage-stats.js:33` | `FUNCTION_REGISTRY` key `'对账单 ReconID 修复'`，与 `main.js` `trackedIpcHandle('recon-id-fix:*', '对账单 ReconID 修复', ...)`（3 处）配对 | 🔴 改 key 会断统计连续性，**绝不改动** |
| 需求3·引擎分类 | `src/main-process/scenario-engines/c4-recon-id-fix.js` `classifyRows`(97) | 返回行浅克隆 `Object.assign({}, row, { _types: Set<seq>, _rowIdx })`(111)，带全部原始字段 | `_types` 是 `Set<Number>`，存字符串会导致 `has` 恒 false |
| 需求3·输出基行 | `c4-recon-id-fix.js` `buildOutputRow`(588) / `computeReferenceGateway`(616) | `buildOutputRow` 只读 `srcRow` + `overrides`；`computeReferenceGateway` 算 Reference | 仅支持 Reference 赋值，无字段级 override |
| 需求3·三 apply 函数 | `c4-recon-id-fix.js` `apply1v1Assignment`(908) / `apply1vNAssignment`(965) / `applyNv1Assignment`(1033) | 各匹配类型把 Type/Amount/Reference 写入 fixedRows | 无 fieldValue override 合并 |
| 需求3·引擎入口 | `c4-recon-id-fix.js` `runC4Scenario`(1159) | 已有沿调用链注入 `cfg._subMode` / `cfg._billDateDays` 的兜底先例 | 无 `idEnabled` / `fieldValue` 兜底 |
| 需求3·dialog 工厂 | `src/renderer-dialogs.js` `createScenarioConfigDialogC4`(9096) | business / gateway 共用；gateway 字段下拉(9091) 用 `GATEWAY_BILL_FIELDS`/`CHANNEL_BILL_FIELDS`（38-39 从 `appConstants` 取） | 无 idEnabled 开关、无 fieldValue UI |
| 需求3·默认配置 | `src/renderer-dialogs.js` `createDefaultScenarioConfig`(7611) | 不含 `output.idEnabled` / `fieldValue` 默认 | 缺省字段 |
| 需求3·校验 | `src/renderer-dialogs.js` `validateScenarioDraft`(7726，gateway output 段约 7900-7965) | 校验 output.mode 必填 / 1v多禁 main / commonId | 无 idEnabled 跳过分支、无 fieldValue 校验 |
| 需求3·字段常量源 | `src/constants/gateway-bill-recon-fields.js`（`GATEWAY_BILL_FIELDS` 14、`CHANNEL_BILL_FIELDS` 22，只读） | 网关 / 渠道账单列名常量 | 只读，本期不改 |
| 需求3·config 透传 | `src/backend/scenarios-bundle-io.js` | bundle 导出 / 导入对 config_json 自由 JSON 透传 | 既有「新增可选字段旧应用忽略」先例，无需 migration / bump |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 业务OP数据核对 | 模块 id `biz-op-recon`，含两类导入：业务OP 文件（`kind='bizOp'`）+ 流水表文件（`kind='flow'`）；本期批量导入仅涉及流水表 |
| 流水表批量导入 | 需求1b 目标语义：先选一个日期 → 多选多个流水表文件 → 单进程单事务合并入库到该日期（多文件 = 该日期完整流水快照） |
| 单次 clearByDate | 多文件合并时，`flowImportsRepository.clearByDate(date)` 在事务内只执行一次（首个数据行触发），之后各文件累加 INSERT |
| 对账单修复 | 改名后的模块显示名（原「对账单 ReconID 修复」），module id 仍 `recon-id-fix`；含 business（单据对账）+ gateway（网关对账单）两子模式 |
| 修复订单ID取值 | 需求3 改名后的「订单修复ID取值」行，对应 `config.output`（Reference 赋值）；新增 `idEnabled` 开关 |
| 修复订单字段取值 | 需求3 新增功能，对应 `config.fieldValue`（独立开关 + 多行规则），按 `_types` 分组匹配后把从边渠道字段值赋给主边网关字段 |
| 主边 / 从边 | gateway 子模式下：主边（main）= 网关账单（输出基行）；从边（opp）= 渠道账单（取值源）。`config.billTypes` 中 `side==='main'` / `side==='opp'` 区分 |
| 分组 seq | `config.billTypes` 每个账单类型的序号（`seq`），用于 `_types.has(seq)` 匹配；🔴 必须存 Number |
| ID 取值 / 字段取值 | 需求3 两个独立开关：ID 取值 = `修复订单ID取值`（`output.idEnabled`）；字段取值 = `修复订单字段取值`（`fieldValue.enabled`） |
| 订单修复导出 | gateway 子模式 C4 引擎产出的 `fixedRows`，走「导出文件」按 14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板导出 |

---

## 五、功能详细描述

### 5.1 需求 1：业务OP流水表批量导入 + 回滚 v3.0.1 平移

#### 5.1.1 说明

**需求1a（回滚平移，纯 CSS）**
- **输入**：无（纯静态布局）。
- **输出**：删除 `styles-gemini-extra.css:3373-3376` 的 `#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px); }` 规则，业务OP核对模块左列两元素回到 v3.0.1 之前位置。
- **边界条件**：保留同段其它 v3.0.1 样式（`.gateway-recon-picker-card`、`.linked-table-delete-range-card`）不动；`index.html` 面板结构、`renderer.js` 逻辑不改。

**需求1b（流水表批量导入，🔴 资金红线）**
- **输入**：用户在业务OP核对模块「导入流水表」先选一个日期 → 多选多个流水表 xlsx/csv 文件。
- **输出**：所有文件合并导入到该日期；导入状态显示「导入 N 个文件共 M 行」。
- **边界条件**：
  - 🔴 **单进程单事务合并、单次 `clearByDate`**：`BEGIN` → 首个数据行触发 `clearByDate` 只清一次（沿用现有 `cleared` 标志）→ 依次遍历所有文件边读边校验边 INSERT（累加）→ 全通过 `COMMIT`，任一行失败 `ROLLBACK` + rejected。
  - **语义** = 多文件合并为该 date 的完整流水快照（与「重导替换该 date」语义一致，须在状态/文档提示「批量导入会替换该日期已有流水」）。
  - 任一文件任一行校验失败 → **整批拒绝**（聚合错误报告，建议标注来源文件名）。
  - **单文件回归**：`filePaths` 长度为 1 时，行为与现状完全一致。

#### 5.1.2 影响范围

- **前端**：`src/renderer.js` `importFlowStage`（`pickFlowFile` 取 `filePaths`；`runFlowImport({date, filePaths})`；状态文案「导入 N 个文件共 M 行」）；`src/styles-gemini-extra.css`（删平移规则，需求1a）。
- **后端**：`src/main.js` `pick-flow-file`（加 `multiSelections`，返回 `filePaths`）+ `run-flow`（接收并校验非空数组）；`src/main-process/biz-op-recon-session.js`（`runFlowImportViaWorker` / `spawnImportWorker` jobMeta 带 `filePaths`；`runFlowImportAsync` 同步 fallback 多文件合并单次 clear）；`src/backend/biz-op-recon-import/import-worker.js`（`runFlowImport` 遍历 `filePaths`、单次 clear、累加 INSERT、聚合 errorRows + jobMeta 校验改 `filePaths`）。
- **对外接口影响**：IPC `bizOpRecon.pickFlowFile` 返回 `filePaths`（数组）；`bizOpRecon.runFlowImport` 入参 `filePaths`（数组）。`src/preload.js` 若有参数白名单需放行 `filePaths`（透传则无需改）。
- **兼容性影响**：单文件场景（`filePaths` 长度 1）必须与现状行为完全一致（回归保护）。业务OP 文件（`kind='bizOp'`）不在范围、不动。

#### 5.1.3 UI Mockup

```
[业务OP数据核对 - 导入流水表]
  步骤1：选择数据日期   [ 2026-06-01 ▾ ]
  步骤2：[ 选择流水表文件（可多选）]   ← 多选文件对话框
         已选 3 个文件：flow_a.xlsx / flow_b.xlsx / flow_c.xlsx
  步骤3：[ 开始导入 ]
         ⚠️ 批量导入会替换该日期（2026-06-01）已有流水

  ── 导入完成 ──────────────────────────────
  导入 3 个文件共 12,840 行（合并到 2026-06-01）

  ── 任一行校验失败 ──────────────────────────
  本批导入失败：第 2 个文件（flow_b.xlsx）第 88 行金额非法 → 整批已回滚，未入任何行
```

---

### 5.2 需求 2：「对账单 ReconID 修复」模块改名「对账单修复」

#### 5.2.1 说明

- **输入**：无（纯静态文案）。
- **输出**：仅改 3 处用户可见 UI 字符串去掉「ReconID」：
  - 顶部模块切换器显示名：「对账单 ReconID 修复」→「对账单修复」。
  - 场景类别 label：「单据对账 ReconID 修复」→「单据对账修复」。
  - 场景类别 label：「网关对账单 ReconID 修复」→「网关对账单修复」。
- **边界条件**：内部 id / IPC 模块标识 / usage-stats 统计 key / scenario category / DB schema CHECK 约束**全部不动**；注释内的「ReconID 修复」字样保留（不影响 UI）。实施时确认 `getCategoryDialogTitle`（renderer-dialogs.js:7689）及主面板其它可见文案不含「ReconID」（已知对话框标题为「新增场景/修改场景」，不受影响）。

#### 5.2.2 影响范围

- **前端**：`src/renderer.js:66`（模块名）；`src/renderer-dialogs.js:7553` / `:7554`（两个类别 label）。
- **后端 / 数据 / 兼容性**：无改动。
- 🔴 **绝不改动**（资金 / 统计连续性）：
  - `src/backend/usage-stats.js:33` `FUNCTION_REGISTRY` key `'对账单 ReconID 修复'`。
  - `src/main.js` 中 `trackedIpcHandle('recon-id-fix:*', '对账单 ReconID 修复', ...)` 第二参（3 处，与上面 key 配对）。
  - 模块 id `recon-id-fix` / scenario category `recon-id-fix` / `gateway-recon-id-fix` / DB schema CHECK 约束。

#### 5.2.3 UI Mockup

```
顶部模块切换器：     对账单 ReconID 修复     →     对账单修复
场景类别下拉：       单据对账 ReconID 修复   →     单据对账修复
                    网关对账单 ReconID 修复 →     网关对账单修复
（内部 id / 统计 key / IPC 标识全部不变 → 计数连续、零回归）
```

---

### 5.3 需求 3：网关对账单修复「修复订单字段取值」

#### 5.3.1 说明

- **输入**：在网关子模式新增/修改场景对话框配置：
  - 「修复订单ID取值」行的「启用该功能」开关（`output.idEnabled`，默认勾选）。
  - 「修复订单字段取值」开关（`fieldValue.enabled`，默认关）+ 多行规则。
- **输出**：跑对账后，每条匹配成功的记录按 `fieldValue.rules` 把从边渠道字段值赋给主边网关字段，叠加进 `fixedRows`，随订单修复「导出文件」按 14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板导出。
- **边界条件**：
  - 🔴 **赋值不污染原始行对象**：只写新建的 `overrides` 对象，绝不触碰 `mainRow` / `oppRow`。
  - 🔴 **分组 seq 全程 Number**：`mainTypeSeq` / `oppTypeSeq` 必须存 Number；`_types.has` 用 `Number(rule.xxxTypeSeq)`，类型不符则规则静默失效（最隐蔽的资金 bug）。
  - 🔴 **idEnabled=false**：不把 Reference 放进 overrides → `buildOutputRow` 取 srcRow 原值（网关账单 Reference 列），即「保留原始对账号，不赋值」，比清空更安全。
  - 命中规则取从边渠道字段值，`null` / `undefined` → `''`（不阻断）。
  - 两功能独立开关，可同时启用；目标列落在 14 列模板内才体现于导出，超出则导出不体现且不报错。
  - **（用户修订）「修复订单字段取值」仅「网关1v1渠道」模式可用**：勾选「网关1v多渠道」或「网关多v1渠道」时，「修复订单字段取值」不可用——UI 开关自动禁用 + 灰显 + 显示「仅"网关1v1渠道"模式可用」提示 + 自动取消启用；校验拦截；引擎入口 gate 强制 `fieldValue.enabled=false`，`apply1vN`/`applyNv1` 不做字段取值（**双重防御**）。
  - **（用户修订）两功能区垂直布局**：「修复订单ID取值」「修复订单字段取值」两个 gateway row 改垂直布局——标题行（label + tooltip + 「启用该功能」开关）在上，内容（三选一 radio / 4 下拉规则行）在下方。
  - ⚠️ 1v多 匹配时，若目标列 = Amount 会覆盖拆账值（用户显式配置语义，tooltip 标注）；因上一条「仅 1v1 可用」修订，1v多 / 多v1 实际不会触发字段取值，此条仅保留语义说明。

#### 5.3.2 影响范围

- **前端**：`src/renderer-dialogs.js`——`createScenarioConfigDialogC4`(9096) 内：改名「订单修复ID取值」→「修复订单ID取值」、加 `idEnabled` 开关 + `renderOutput()` 灰显联动、新增「修复订单字段取值」row + `renderFieldValue()` 多行规则 UI；`createDefaultScenarioConfig`(7611) 加默认；`validateScenarioDraft`(7726) 加 idEnabled 跳过分支 + fieldValue 校验。
- **后端 / 引擎**：`src/main-process/scenario-engines/c4-recon-id-fix.js`——新 helper `applyFieldValueOverrides`（导出供单测）；三 apply 函数 gateway 分支合并 overrides；`runC4Scenario`(1159) 入口兜底 `idEnabled` / `fieldValue`。
- **配置 / 数据库**：`config.output.idEnabled`（boolean，默认 true）+ `config.fieldValue`（`{enabled:false, rules:[]}`）写入 config_json（自由 JSON）；**无需 DB migration、无需 bump bundleVersion**。
- **对外接口影响**：无新增 IPC。`src/backend/scenarios-bundle-io.js` bundle 导出/导入透传新字段（旧 bundle 入口兜底默认）。
- **兼容性影响**：旧场景（无新字段）默认 `idEnabled=true` / `fieldValue` 关，行为零回归；business 子模式共用 schema 但引擎/UI 不消费 `fieldValue`。

#### 5.3.3 UI Mockup（含用户修订：垂直布局 + 1v1 限定）

```
[新增场景 / 修改场景 - 网关对账单修复]
  ...（账单类型分组配置 billTypes：main/opp + seq）...
  匹配模式：○ 网关1v1渠道   ○ 网关1v多渠道   ○ 网关多v1渠道

  ┌─ 修复订单ID取值                         ☑ 启用该功能 ─┐   ← 改名 + 新增开关（标题行在上）
  │  ○ 网关账单   ○ 渠道账单   ○ 自取值 [____]            │   ← 内容在下（取消勾选 → 整块灰显 disabled）
  └──────────────────────────────────────────────────┘

  ┌─ 修复订单字段取值                       ☐ 启用该功能 ─┐   ← 新增功能（标题行在上）
  │  [主分组▾] 的 [网关字段▾]  取  [从分组▾] 的 [渠道字段▾]  [新增] │   ← 内容在下：多行规则
  │  [主分组▾] 的 [网关字段▾]  取  [从分组▾] 的 [渠道字段▾]  [×]   │
  └──────────────────────────────────────────────────┘

  ── 当匹配模式 = 网关1v多渠道 / 网关多v1渠道 时（用户修订）──
  ┌─ 修复订单字段取值              ☐(禁用·灰显)  仅"网关1v1渠道"模式可用 ─┐
  │  （规则区灰显，已启用的自动取消；校验拦截；引擎入口强制 enabled=false）   │
  └──────────────────────────────────────────────────────────┘

  语义：仅「网关1v1渠道」模式下，匹配成功（main._types.has(主分组seq) && opp._types.has(从分组seq)）后，
        overrides[网关字段] = 渠道账单[渠道字段] → 叠加进订单修复导出（落 14 列模板才体现）
```

---

## 六、验收标准

> 本章节共 **21 条** AC（需求3 因用户修订「限定网关1v1渠道 + 垂直布局」新增 AC3-13/14/15，由 18 条增至 21 条）。

### 6.1 需求 1：业务OP流水表批量导入 + 回滚平移 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1a-1 | 业务OP核对模块左列两元素回到 v3.0.1 之前位置（无 `translateX(85.5px)` 平移）；同段 `.gateway-recon-picker-card` / `.linked-table-delete-range-card` 样式无变化 |
| AC1b-1 | 「导入流水表」先选一个日期 → 多选 3 个流水表文件 → 全部合并导入到该日期，库内行数 = 3 个文件行数之和（单次 clear，无互相覆盖丢失） |
| AC1b-2 | 多文件中任一文件任一行校验失败 → 整批拒绝（ROLLBACK），表保持导入前状态、不留半批；错误报告聚合并标注来源文件名 |
| AC1b-3 | 单文件导入（`filePaths` 长度 1）行为与 v3.0.1 现状完全一致（回归） |
| AC1b-4 | 批量导入完成后状态显示「导入 N 个文件共 M 行」；并明示「批量导入会替换该日期已有流水」 |
| AC1b-5 | 🔴 worker / 同步 fallback 两条路径语义一致：均单次 `clearByDate` + 累加 INSERT，绝不循环调用 `runFlowImport` |
| AC1b-6 | 业务OP 文件导入（`kind='bizOp'`）行为不变（不在本需求范围） |

### 6.2 需求 2：模块改名 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 顶部模块切换器显示「对账单修复」（不再含「ReconID」） |
| AC2-2 | 场景类别下拉显示「单据对账修复」「网关对账单修复」（不再含「ReconID」） |
| AC2-3 | usage-stats 计数连续：`FUNCTION_REGISTRY` key `'对账单 ReconID 修复'` 与 `main.js` `trackedIpcHandle` 第二参（3 处）未改，导入/运行/导出计数正常累计 |
| AC2-4 | 模块 id `recon-id-fix` / scenario category / DB schema CHECK 约束未改，场景新建/编辑/运行正常 |

### 6.3 需求 3：网关对账单修复「修复订单字段取值」AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 「订单修复ID取值」行显示为「修复订单ID取值」并带「启用该功能」开关；默认勾选，行为与改前一致（Reference 必填赋值） |
| AC3-2 | 取消「修复订单ID取值」勾选 → 三选一 radio + commonId 子行灰显 disabled；跑对账时 Reference 取网关账单原值（非空串），不报「ID取值必填」校验错 |
| AC3-3 | 「修复订单字段取值」默认关；开启后至少配 1 条规则、每条四字段非空，否则校验拦截 |
| AC3-4 | 字段取值规则 1v1 匹配 → overrides[网关字段] = 渠道账单[渠道字段]（取共同 rightRow），赋值正确 |
| AC3-5 |（用户修订）匹配模式含「网关1v多渠道」→ 字段取值**不生效**（限定网关1v1渠道：引擎入口 gate 强制 `fieldValue.enabled=false`、`apply1vN` 不赋值），主边字段保网关原值 |
| AC3-6 |（用户修订）匹配模式含「网关多v1渠道」→ 字段取值**不生效**（限定网关1v1渠道：引擎入口 gate 强制关闭、`applyNv1` 不赋值），主边字段保网关原值 |
| AC3-7 | 🔴 `applyFieldValueOverrides` 调用后 `mainRow` / `oppRow` 字段未被修改（只写新建 overrides，不污染原始行） |
| AC3-8 | 🔴 规则 `mainTypeSeq` / `oppTypeSeq` 以字符串存入也能命中（引擎 `Number()` 归一）；类型不符不应静默吞掉数据——校验保证存 Number |
| AC3-9 | 目标列超出 14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板 → 导出不体现该列且不报错 |
| AC3-10 | ID 取值（关）+ 字段取值（开）可同时生效（独立开关）；规则按 `_types` 分组过滤，仅命中分组的行赋值 |
| AC3-11 | 旧场景（config 无 `idEnabled` / `fieldValue`）加载/运行不报错，默认 `idEnabled=true` / `fieldValue` 关，行为零回归；business 子模式不消费 fieldValue |
| AC3-13 |（用户修订）匹配模式 = 「网关1v多渠道」/「网关多v1渠道」时，「修复订单字段取值」开关自动禁用 + 灰显 + 显示「仅"网关1v1渠道"模式可用」；已启用的自动取消；保存校验拦截「非 1v1 却启用字段取值」 |
| AC3-14 |（用户修订）🔴 引擎入口 gate：非「网关1v1渠道」时强制 `fieldValue.enabled=false`，`apply1vN`/`applyNv1` 不做字段取值（即便 config 残留启用标记也不生效，双重防御） |
| AC3-15 |（用户修订）「修复订单ID取值」「修复订单字段取值」两个 row 为垂直布局：标题行（label + tooltip + 启用开关）在上、内容（radio / 规则行）在下 |
| AC3-12 | `npm run release-check` 全绿（unit / integration / smoke）；前端改动重跑对应 `npm run preview:*` |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 流水多文件合并 | 选日期 → 多选 3 个流水表 | 该日期库内已有流水 | 3 个文件全合并、行数累加、单次 clear、无丢失（AC1b-1/5） |
| 流水批量整批拒绝 | 多选含 1 个非法行文件 | — | 整批 ROLLBACK、不留半批、聚合错误报告（AC1b-2） |
| 流水单文件回归 | 单选 1 个流水表 | — | 与 v3.0.1 行为一致（AC1b-3） |
| 字段取值 1v1 | 网关场景配 1v1 字段取值规则 → 导入 → 跑对账 | gateway 子模式 ≥1 场景 | 订单修复导出体现 overrides[网关字段]=渠道值（AC3-4/9） |
| 字段取值 1v多/多v1 限定 | 勾「网关1v多渠道」/「多v1」后试启用字段取值 | — | 开关禁用+灰显+提示「仅网关1v1渠道可用」+自动取消；引擎不赋值、主边字段保原值（AC3-5/6/13/14） |
| idEnabled=false 保留原值 | 取消「修复订单ID取值」勾选 → 跑对账 | — | Reference 取网关账单原值、不报必填校验（AC3-2） |
| 模块改名 | 打开模块切换器 + 场景类别下拉 | — | 显示「对账单修复」「单据对账修复」「网关对账单修复」（AC2-1/2） |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 回滚平移回归 | 打开业务OP核对模块 | — | 左列回到平移前位置；另：场景框 / 删除弹框样式不变（AC1a-1） |
| 两开关同时启用 | idEnabled 关 + fieldValue 开 | — | 两者独立生效、规则按分组过滤（AC3-10） |
| 旧场景兼容 | 加载 v3.0.1 已有 gateway 场景 | 无新字段 | 默认 idEnabled=true / fieldValue 关、行为零回归（AC3-11） |
| 目标列超模板 | 字段取值目标列不在 14 列内 | — | 导出不体现、不报错（AC3-9） |
| 统计连续性 | 多次导入/运行/导出 | — | usage-stats 计数正常累计（AC2-3） |

### 7.3 不测项与原因

- business 子模式的 fieldValue 行为：本期 business 不消费 fieldValue（仅 gateway 读），无需测。
- 其它链接表 / 对账引擎编排器 / R 系列引擎：本期不改，无需回归其内部算法。
- 业务OP 文件（`kind='bizOp'`）批量导入：明确不做（仅流水表 `kind='flow'`），无需测。
- config DB migration / bundle 版本升级：本期无（自由 JSON 新增可选字段），无需测迁移路径。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 需求3 `config.output.idEnabled`（boolean，默认 true）+ `config.fieldValue`（`{enabled:false, rules:[{mainTypeSeq:Number, mainField, oppTypeSeq:Number, oppField}]}`）写入 scenario config_json（自由 JSON）；**无需 DB migration、无需 bump bundleVersion**。需求 1/2 无数据结构变更。 |
| 状态流转变更 | 需求1b 流水导入落库语义：单文件 → 多文件单事务合并（多文件 = 该 date 完整快照，与「重导替换该 date」一致，单次 `clearByDate`）。需求 2/3 无状态机变化。 |
| 权限 / 安全 | 不涉及鉴权 / 敏感数据外发。属本地 SQLite 资金对账数据，🔴 红线在：①需求1b 流水批量导入的数据完整性（单事务合并、单次 clear、整批拒绝）；②需求3 字段取值赋值的正确性（不污染原始行、seq 全程 Number、idEnabled=false 保留原值）。 |
| 回滚策略 | 需求1a：还原删除的 CSS 规则。需求2：还原 3 处 UI 字符串。需求1b：还原 `runFlowImport` 单 `filePath` 签名 + handler 单选。需求3：config 新增字段为可选（旧应用忽略，向后兼容）；引擎/UI/校验回滚 = 还原对应函数。建议在 `docs/ROLLBACK.md` 补 v3.0.2 段。 |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 需求3 config 新增可选字段，旧应用忽略、旧 bundle 入口兜底默认 `idEnabled=true` / `fieldValue` 关，旧场景零回归。需求1b 单文件场景（`filePaths` 长度 1）行为与现状完全一致。 |
| 性能 | 需求1b 流水批量导入不得退化为逐文件自动提交，须单进程单事务合并（沿用 worker 流式骨架 + `cleared` 标志单次 clear）；多文件累加 INSERT 不重复清空。 |
| 鲁棒性 | 需求1b 单事务、任一行/任一文件失败全 ROLLBACK，不留半批。需求3 `applyFieldValueOverrides` 命中失败/空值不阻断（`null`/`undefined`→`''`），seq 类型不符由校验前置拦截（存 Number）。 |
| 可观测 | 需求1b 导入完成框显式报「导入 N 个文件共 M 行」+「批量导入会替换该日期已有流水」；整批拒绝时报失败文件 + 行号。 |

---

## 十、待澄清问题

> 关键决策已在实施计划确认（见下「已确认决策表」），本迭代需求层面无待决项。

- [x] **需求3 ID取值/字段取值开关** ✅ 两功能独立开关（可同时启用）：`修复订单ID取值`（`output.idEnabled`，默认勾选保持现有必填，取消则跳过 Reference 赋值与校验）；`修复订单字段取值`（`fieldValue.enabled`，另一独立开关）。
- [x] **需求3 字段取值输出** ✅ 复用现有订单修复导出：赋值叠加到 `fixedRows` 主边输出行，仍走「导出文件」+ 14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板（目标列落在 14 列内才体现）。
- [x] **需求1b 批量导入日期** ✅ 共享同一日期：先选一个日期 → 多选文件 → 全部合并导入到该日期。
- [x] **需求2 改名范围** ✅ 含场景类别 label：模块显示名 + 用户可见的两个类别 label；内部 id / IPC 模块标识 / usage-stats 统计 key 全部不动（沿用 v2.1.14 先例，零风险、统计连续）。
- [ ] **需求1b 是否需新增/调整 preview 入口**：`preview:biz-op-recon` 既有，实施时确认多选导入是否需补 preview fixture（走默认）。

### 已确认决策表

| 需求 | 决策 | 确认来源 |
|------|------|---------|
| 需求3 - ID取值/字段取值开关 | **两功能独立开关**：`修复订单ID取值`（`output.idEnabled`）默认勾选启用（保持现有必填）；取消勾选则跳过 Reference 赋值与校验。`修复订单字段取值`（`fieldValue.enabled`）是另一独立开关，可同时启用 | 实施计划（已批准） |
| 需求3 - 字段取值输出 | **复用现有订单修复导出**：赋值叠加到 `fixedRows` 主边输出行，仍走「导出文件」+ 14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板（目标列落在 14 列内才体现于导出） | 实施计划（已批准） |
| 需求1b - 批量导入日期 | **共享同一日期**：先选一个日期 → 多选文件 → 全部合并导入到该日期 | 实施计划（已批准） |
| 需求2 - 改名范围 | **含场景类别 label**：模块显示名 + 用户可见的两个类别 label；内部 id / IPC 模块标识 / usage-stats 统计 key 全部不动（沿用 v2.1.14「银行对账单处理→资金对账数据处理」先例，零风险、统计连续） | 实施计划（已批准） |

---

## 十一、风险提示（人工复核）

> 🔴 资金红线：以下三项在 TechDoc 同步显著标注，实施与评审务必逐项复核。

🔴 **资金红线**

1. **需求1b 流水批量导入**：🔴 **必须单进程单事务合并、单次 `clearByDate`**，禁止循环调用现有 `runFlowImport`（worker `import-worker.js:268`；同步 fallback `biz-op-recon-session.js:491`）——否则第 2 个文件的 `clearByDate`(import-worker.js:290) 会清掉第 1 个文件刚插入的行，只剩最后一个文件（静默丢数据，资金事故）。整批拒绝语义保持（任一行失败全 ROLLBACK）。
2. **需求3 赋值不污染原始行**：`applyFieldValueOverrides` 只写新建的 `overrides` 对象，绝不触碰 `mainRow` / `oppRow`（单测断言调用后行对象字段未变）。
3. **需求3 分组 seq 全程 Number**：`mainTypeSeq` / `oppTypeSeq` 必须存 Number（`_types` 是 `Set<Number>`，存字符串导致 `has` 恒 false → 规则静默失效，最隐蔽的资金 bug）；引擎 `_types.has` 用 `Number(rule.xxxTypeSeq)` 归一，校验前置拦截非 Number。
4. **需求3 idEnabled=false 保留原值**：取消「修复订单ID取值」时不把 Reference 放进 overrides → `buildOutputRow` 取 srcRow 原值（网关账单 Reference 列，14 列模板成员），即「保留原始对账号」，比清空更安全。
5. **需求3（用户修订）字段取值限定「网关1v1渠道」**：1v多 / 多v1 模式下「修复订单字段取值」不可用——UI 禁用 + 灰显 + 提示 + 自动取消启用；校验拦截；🔴 **引擎入口 gate 强制 `fieldValue.enabled=false`，`apply1vN`/`applyNv1` 不做字段取值（双重防御，即便 config 残留启用标记也不生效）**。由此「1v多 目标列 = Amount 覆盖拆账值」实际不会触发（原 tooltip 语义说明保留）。

⚠️ **跨子模式 / 兼容**

- business 场景共用 config schema，但引擎/UI 不消费 `fieldValue`（仅 `cfg._subMode==='gateway'` 读）。
- bundle 导出/导入新字段透传，旧 bundle 入口兜底默认；config_json 无需 migration、无需 bump bundleVersion。

---

## 十二、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-10 | 初稿：依据已批准实施计划 `~/.claude/plans/3-0-2-1-op-3-0-1-immutable-flask.md` 收口 3 项需求（流水批量导入+回滚平移 / 模块改名 / 网关修复订单字段取值）为 v3.0.2 迭代需求；已确认决策表 4 项、AC 共 18 条、资金红线 5 点 |
| 2026-06-10 | reverse-sync 用户修订（需求3）：①「修复订单字段取值」限定「网关1v1渠道」模式（UI 禁用+灰显+提示+自动取消 / 校验拦截 / 引擎入口 gate 双重防御）；② 两功能区改垂直布局（标题行在上、内容在下）。AC 由 18 增至 21（新增 AC3-13/14/15）；§十一风险第 5 点改为「限定 1v1（引擎双重防御）」。状态改「定稿（已实施）」，补 §十三实施记录 |

---

## 十三、实施记录

> 2026-06-10 收口：3 项需求经 team-lead 拆分委托 dev 逐 task 实施、逐 task `release-check` 验收全绿（team-lead 自审 diff + 自跑测试兜底，不只听 dev 汇报）。需求3 含本轮用户修订「限定网关1v1渠道」+「UI 垂直布局」。质量门末态 **unit 2085 / integration 19 脚本（1011 断言）/ smoke 全过**。

### 最终落地改动清单（按需求）

**需求1a 业务OP核对左列右移回滚（🟢 纯 CSS）**

| 文件 | 改动 |
|------|------|
| `src/styles-gemini-extra.css` | 删除 v3.0.1 需求2 加的 `#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px); }` 平移规则（含注释行）；保留同段 `.gateway-recon-picker-card` / `.linked-table-delete-range-card` 不动。左列两元素回到 v3.0.1 之前位置 |

**需求1b 业务OP流水表批量多选导入（🔴 资金红线）**

| 文件 | 改动 |
|------|------|
| `src/backend/biz-op-recon-import/import-worker.js` | `runFlowImport` 接收 `filePaths` 数组：单进程单事务遍历所有文件，🔴 **单次 `clearByDate`**（首个数据行触发、沿用 `cleared` 标志），之后各文件累加 INSERT；逐文件逐行校验，任一行失败聚合到 errorRows（标注来源文件名）→ 有错全 ROLLBACK + rejected、全过 COMMIT；jobMeta 校验由 `filePath` → `filePaths`（非空数组） |
| `src/main-process/biz-op-recon-session.js` | `runFlowImportViaWorker` / `spawnImportWorker` jobMeta 带 `filePaths`；同步 fallback `runFlowImportAsync` 多文件合并、单次 clear + 累加，与 worker 同语义（无 dbPath 兜底路径） |
| `src/main.js` | `pick-flow-file` 加 `multiSelections`、返回 `filePaths`；`run-flow` 接收并校验非空数组传 worker |
| `src/renderer.js` | `importFlowStage`：`pickFlowFile` 取 `filePaths`、`runFlowImport({date, filePaths})`、状态文案「导入 N 个文件共 M 行」+「批量导入会替换该日期已有流水」 |
| `src/preload.js` | `bizOpRecon.pickFlowFile` / `runFlowImport` 放行 `filePaths`（透传） |

> 🔴 资金红线核实：worker / 同步 fallback 两条路径均单事务合并、单次 `clearByDate`，**绝不循环调用 `runFlowImport`**；任一文件任一行失败整批拒绝（全 ROLLBACK 不留半批）；单文件场景（`filePaths` 长度 1）行为零回归；业务OP 文件（`kind='bizOp'`）不在范围、未动。

**需求2 「对账单 ReconID 修复」改名「对账单修复」（🟢 纯前端文案）**

| 文件 | 改动 |
|------|------|
| `src/renderer.js` | 模块显示名 `'对账单 ReconID 修复'` → `'对账单修复'` |
| `src/renderer-dialogs.js` | 场景类别 label：`'单据对账 ReconID 修复'` → `'单据对账修复'`、`'网关对账单 ReconID 修复'` → `'网关对账单修复'` |
| ❌ 不动 | 内部 id（`recon-id-fix`/`gateway-recon-id-fix`）/ IPC 模块标识 / `usage-stats.js` `FUNCTION_REGISTRY` key `'对账单 ReconID 修复'` 与 `main.js` `trackedIpcHandle` 第二参（3 处配对）/ scenario category / DB schema CHECK 约束（沿用 v2.1.14 先例，统计连续、零风险） |

**需求3 网关对账单修复「修复订单字段取值」+「修复订单ID取值」启用开关（🔴 资金红线，含用户修订）**

| 文件 | 改动 |
|------|------|
| `src/main-process/scenario-engines/c4-recon-id-fix.js` | 新 helper `applyFieldValueOverrides(mainRow, oppRow, cfg)`（导出供单测）：只写新建 `overrides`、🔴 不污染行对象、分组 seq `Number()` 归一、空值→`''`；三 apply 函数（`apply1v1Assignment`/`apply1vNAssignment`/`applyNv1Assignment`）gateway 分支合并 overrides（先 Type/Amount/Reference 再 `Object.assign` fieldValue）；`runC4Scenario` 入口兜底 `idEnabled`/`fieldValue`；idEnabled=false 不把 Reference 放进 overrides（`buildOutputRow` 取 srcRow 原值）；🔴 **（用户修订）引擎入口 gate：非「网关1v1渠道」强制 `fieldValue.enabled=false`，`apply1vN`/`applyNv1` 不做字段取值（双重防御）** |
| `src/renderer-dialogs.js` | `createScenarioConfigDialogC4`：「订单修复ID取值」→「修复订单ID取值」+「启用该功能」开关（`output.idEnabled`，`renderOutput` 灰显联动）；新增「修复订单字段取值」row +「启用该功能」开关（`fieldValue.enabled`）+ `renderFieldValue()` 多行规则（主分组 + 网关字段「取」从分组 + 渠道字段 +「新增/×」）；🔴 **（用户修订）两 row 垂直布局（标题行在上 + 内容在下）**；🔴 **（用户修订）匹配模式 = 1v多/多v1 时字段取值开关禁用 + 灰显 + 「仅"网关1v1渠道"模式可用」提示 + 自动取消启用**；`createDefaultScenarioConfig` 加默认；`validateScenarioDraft` 加 idEnabled 跳过分支 + fieldValue 校验（规则非空 / 字段枚举 / side 匹配）+ **（用户修订）非 1v1 启用字段取值拦截** |
| 配置 | `config.output.idEnabled`（boolean，默认 true）+ `config.fieldValue`（`{enabled:false, rules:[{mainTypeSeq:Number, mainField, oppTypeSeq:Number, oppField}]}`）写入 scenario config_json（自由 JSON），**无 DB migration、不 bump bundleVersion**；`src/backend/scenarios-bundle-io.js` 透传（不改） |
| 只读 | `src/constants/gateway-bill-recon-fields.js`（`GATEWAY_BILL_FIELDS` 14 / `CHANNEL_BILL_FIELDS` 22）未改 |

**测试扩建**

| 文件 | 改动 |
|------|------|
| `scripts/smoke/recon-id-fix-engine-gateway.js` | 扩到 20 case：idEnabled 开关、fieldValue 1v1 生效、**（用户修订）1v多/多v1 限定不生效**、目标列超 14 列不体现、旧场景兼容、回归基线 |
| `tests/unit/main-process/recon-id-fix-engine.test.js` | 新增 `applyFieldValueOverrides` 单测：🔴 不污染 `mainRow`/`oppRow`、seq 字符串经 `Number()` 归一命中、分组过滤、空值赋空串 |
| `scripts/smoke/biz-op-recon.js` | 扩多文件合并（单次 clear、行数累加）/ 整批拒绝（聚合错误报告）/ 单文件回归 |

### 质量门与收口要点

- **质量门**：每 task `npm run release-check` 全绿；末态 **unit 2085 / integration 19 脚本（1011 断言）/ smoke 全过**。前端改动（需求 1a/1b 前端 / 需求2 / 需求3 dialog）重跑对应 `npm run preview:*`。
- **用户修订（需求3）**：本轮新增「限定网关1v1渠道」（UI 禁用 + 灰显 + 提示 + 自动取消 / 校验拦截 / 引擎入口 gate 双重防御）+「两功能区垂直布局」；已 reverse-sync 回 §5.3 / §六 AC（+AC3-13/14/15）/ §十一 + 本节。
- **OPEN 项收口**：
  - 待澄清 §十 `[ ]`「需求1b 是否需新增/调整 preview 入口」：实施确认走默认 `preview:biz-op-recon`，未新增 fixture。
  - 资金红线硬节点：提 PR / 版本 bump 前 `npm run scan:vars` + `/check-vars`（触及 fixedRows 输出 / Reference 取值 / 流水导入事务等重要变量）。
- **文档三件套**：CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE 已同步更新 v3.0.2 条目（含需求3 用户修订）。
