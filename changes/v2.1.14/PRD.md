# v2.1.14 迭代 PRD（需求规格）

> 状态：草稿（待用户 review）
> 分支：`v2.1.14`（基于 main，当前 main = 2.1.13）
> 目标版本号：`2.1.14-beta.1`
> 创建日期：2026-06-06
> 性质：**纯前端迭代，不涉及后端**（边界见 §三）

## 一、已确认决策（用户拍板）

| # | 决策点 | 选择 |
|---|---|---|
| D1 | 分支/版本 | 新建 `v2.1.14`（基于 main），bump 到 `2.1.14-beta.1` |
| D2 | 前端交付边界 | **骨架 + 复用现有对账单导入**：现有银行对账单预加工链路（导入对账单 / 开始对账 / 导出 / 导入不平表）全部复用现有 IPC；新功能（资金对账不平校验导出、链接表管理、批量识别更新覆盖）做 UI 骨架占位 |
| D3 | 模块改造方式 | **原地改造** `bank-statement-process` 模块（改名 + 重构面板布局），`module.id` 保留不变；独立的 `recon-id-fix` 模块不受影响 |
| D4 | 链接表管理形态 | **弹窗 modal**（与「场景管理」一致的交互模式，新建 `createLinkedTableManagerDialog`）|

## 二、需求清单（逐条编号 + 代码落点 + 边界标注）

> 边界图例：**[复用真实]** = 接现有后端 IPC，真实可用；**[UI骨架占位]** = 仅前端 UI + 占位交互（弹文件框/Toast「功能开发中」/前端表头识别预览），不接真实数据处理与持久化。

### A. 文案变更

| ID | 现文本 | 新文本 | 落点（代码事实） | 边界 |
|---|---|---|---|---|
| **A1** | `网银账单小助手`（主标题）| `清结算小助手` | `index.html:10`(`<title>`) + `index.html:30`(`h1.page-title > span.gemini-gradient`)；如 window-bar 标题/任务栏标题另有引用一并改 | [复用真实] |
| **A2** | `银行对账单处理`（模块名）| `资金对账数据处理` | `src/renderer.js:55`（`MODULES.bankStatementProcess.name`）。⚠️ `module.id='bank-statement-process'` **保留不变**（数十处引用 + DB schema）；仅改显示名 | [复用真实] |
| **A3** | （无）| 模块功能说明文案：「负责根据场景管理启用的功能，处理银行对账单、资金对账不平结果表等相关数据并输出相关数据处理结果。银行对账单数据处理后，默认参与资金对账不平结果表的数据处理。」| 现「功能收纳弹窗」无模块描述字段（grep 确认）。**显示位待确认**：默认仅记录于 PRD/文档，本期不在 UI 新增展示（除非用户指定显示位） | [文档记录] |
| **A4** | `开始运行`（按钮）| `开始对账` | `index.html:281`（`#bankStatementRunBtn` 文案）；相关 disabled 逻辑不变 | [复用真实] |

### B. 「资金对账数据处理」模块面板布局重构

落点：`index.html:273-298`（`#bankStatementModulePanel`，现 2 行镜像 `layout-mirrored`）→ 重构为 3 行新布局。

**目标布局（需求 2.3.1）：**

```
┌─────────────────────────────────────────────────────────┐
│  [导入对账单] [导出文件]                       [开始对账]   │  ← 银行对账单预加工组 + 右1
│  [导入不平表] [导出文件]                       [场景管理]   │  ← 资金对账不平校验组 + 右2
│  [        状态框        ]                     [链接表管理]  │  ← 状态框（左跨列）+ 右3
└─────────────────────────────────────────────────────────┘
```

- 左侧两组：`[导入对账单][导出文件]` = **银行对账单预加工**功能；`[导入不平表][导出文件]` = **资金对账不平校验**功能
- 状态框：第 3 行左侧，跨左侧按钮列宽
- 右侧纵向 3 按钮：`开始对账` / `场景管理` / `链接表管理`

**按钮映射与边界：**

| 按钮 | 现有元素 / 新增 | handler | 边界 |
|---|---|---|---|
| 导入对账单 | 现 `#bankStatementImportBtn` | `handleBankStatementImport`（`renderer.js:3419`）→ `bankStatement.import()` | [复用真实] |
| 导出文件（预加工组）| 现 `#bankStatementExportBtn` | `handleBankStatementExport`（`renderer.js:3560`）→ `bankStatement.export()` | [复用真实] |
| 导入不平表 | **提升**：现为弹窗触发，改为面板按钮 | `handleBankStatementImportGatewayRecon`（`renderer.js:3467`）→ `bankStatement.importGatewayRecon()` | [复用真实] |
| 导出文件（不平校验组）| **新增按钮** | 占位（无现成 gateway-recon 导出 IPC） | [UI骨架占位] |
| 开始对账 | 现 `#bankStatementRunBtn`（A4 改名）| `handleBankStatementRun`（`renderer.js:3491`）→ `bankStatement.run()` | [复用真实] |
| 场景管理 | 现 `#bankStatementScenarioBtn` | `createScenariosManagerDialog`（`renderer-dialogs.js:6077`）| [复用真实] |
| 链接表管理 | **新增按钮** | `createLinkedTableManagerDialog`（C 全新）| [UI骨架占位] |

> 注：现 `maybePromptGatewayReconImport`（`renderer.js:3443`）「导入对账单后自动弹提示导入不平表」逻辑**保留**（不冲突，是引导）；新增的面板按钮提供主动入口。

### C. 链接表管理弹窗（全新 `createLinkedTableManagerDialog`）

需求 2.3.2 布局：

```
┌──────────────────────────────────────────────────┐
│  表名列              表状态                          │
│  ─────────────────────────────────────────────    │
│  表名A          <数据日期范围>   <表更新日期>        │
│  表名B          <数据日期范围>   <表更新日期>        │
│  ……                                                │
│                                                    │
│                              [导入]  [退出]         │
└──────────────────────────────────────────────────┘
```

| ID | 需求 | 边界 |
|---|---|---|
| **C1** | 弹窗骨架：表名列 + 表状态（数据日期范围、表更新日期两子列）+ 右下角 `[导入][退出]` 按钮 | [UI骨架占位] |
| **C2** | 链接表清单（需求 2.4.4）：中台调拨订单表、网关对账单、期权表（外汇期权订单）、Payment 制作的外汇交割表（vPayment）。本期以**静态行**呈现，数据日期范围/更新日期显示占位（如「—」或「未导入」）| [UI骨架占位] |
| **C3** | `[导入]` 按钮：一键批量导入（按表头识别表类型后更新覆盖）。本期**占位**：弹文件多选框 + 前端表头识别预览（可选）/「功能开发中」提示；不做真实持久化与覆盖 | [UI骨架占位] |
| **C4** | `[退出]` 按钮：关闭弹窗 | [复用真实] |

### D. 文件模板（assets/）

需求 2.4.1：根目录 `assets/` 新增类别 + 复用 `网关对账单.xlsx`。

| 模板 | 现状（`assets/`，部分 git 未跟踪）| 待办 |
|---|---|---|
| 入账原始订单.xlsx | ✅ 已存在 | 纳入版本跟踪 |
| 中台退款订单 | ⚠️ 实为 `中台退款订单.xls`（需求写 .xlsx）| 确认扩展名口径 |
| 中台调拨订单.xlsx | ✅ 已存在 | 纳入跟踪 |
| 外汇期权订单.xlsx | ❌ **缺失** | 待用户提供 |
| 外汇交割表vPayment | ⚠️ 实为 `外汇交割表vPayment.xls` | 确认扩展名口径 |
| 中台加款单剔除模板.xlsx | ✅ 已存在 | 纳入跟踪 |
| 中台退款订单回填模板.xlsx | ✅ 已存在 | 纳入跟踪 |
| 网关对账单.xlsx（复用）| ⚠️ 现有 `银行对账单.xlsx`（sheet 名「网关账单」）| 确认是否需独立 `网关对账单.xlsx` 或复用现有 |

> **D 决策点（待用户答复）**：① 缺失的 `外汇期权订单.xlsx` 是否本期提供？② `.xls` vs `.xlsx` 扩展名口径以实际文件为准还是按需求统一为 `.xlsx`？③「网关对账单」复用 `银行对账单.xlsx` 还是新增独立模板？

### E. 导入导出文件限制 + 批量识别（前端骨架）

| ID | 需求 | 边界 |
|---|---|---|
| **E1** | 银行对账单预加工-导入：银行对账单[复用真实] + 中台退款订单（中台退款订单回填功能启用时）+ 入账原始文件（入账原始订单对账ID反回填）。后两者按表头识别 | 对账单 [复用真实]；中台退款订单/入账原始文件 [UI骨架占位] |
| **E2** | 银行对账单预加工-导出：银行对账单[复用真实] + 中台退款订单回填模板 + 中台加款单剔除模板 | 银行对账单 [复用真实]；两模板导出 [UI骨架占位] |
| **E3** | 资金对账不平校验-导入：资金对账不平结果表 | [复用真实]（`importGatewayRecon`）|
| **E4** | 资金对账不平校验-导出：资金对账不平结果表 + 中台加款单剔除模板（脏数据表有数据且预加工时未触发）+ 银行对账单（触发资金性质校验功能）| [UI骨架占位] |
| **E5** | 链接表管理-导入：中台调拨订单表 / 网关对账单 / 期权表 / 外汇交割表vPayment，一键批量按表头识别更新覆盖 | [UI骨架占位] |

> 「按场景管理启用的功能」（中台退款订单回填、入账原始订单对账ID反回填、资金性质校验）本期均为 [UI骨架占位]；其场景开关的真实接入留待后续后端迭代。

## 三、前端交付边界（D2 细化）

**本期真实交付（接现有后端 / 纯 UI）：**
1. A1/A2/A4 文案变更
2. B 模块面板 3 行布局重构（CSS + DOM）
3. 导入对账单 / 导出文件（预加工）/ 导入不平表 / 开始对账 / 场景管理 5 个按钮接现有 IPC
4. C 链接表管理弹窗 UI 骨架 + 退出
5. assets 模板文件纳入跟踪

**本期占位（UI 在、不接真实数据处理）：**
1. 资金对账不平校验「导出文件」按钮
2. 链接表管理「导入」（批量识别 + 更新覆盖 + 持久化）
3. 中台退款订单 / 入账原始文件导入识别
4. 中台退款订单回填模板 / 中台加款单剔除模板导出
5. 资金性质校验触发的银行对账单导出

> 占位统一策略：按钮可点 → 弹文件选择框（或直接 Toast）→ 提示「该功能将在后续版本开放」，不报错、不假装成功。详见 `TECH_DESIGN.md`。

## 四、验收标准

1. 主标题显示「清结算小助手」（标题栏 + 页面 H1 一致）。
2. 模块切换菜单 / 功能收纳中该模块名显示「资金对账数据处理」；`module.id` 仍为 `bank-statement-process`，所有现有引用不报错。
3. 该模块面板呈现新 3 行布局：左侧两组导入/导出 + 状态框，右侧「开始对账 / 场景管理 / 链接表管理」。
4. 「开始对账」按钮文案正确，复用现有 run 链路，功能回归（导入→对账→导出）。
5. 「导入不平表」按钮可主动导入资金对账不平结果表（复用 `importGatewayRecon`），状态框正确反映。
6. 「链接表管理」弹窗可打开，展示表名/状态骨架，「退出」可关闭；「导入」走占位提示。
7. 占位按钮均给出明确「后续版本开放」提示，无报错、无误导成功态。
8. 该模块状态框文案逻辑（5 状态）回归正常；ReconID 修复模块、其他模块不受影响。
9. `npm run release-check` 全绿；`npm run preview:bank-statement-panel` 等相关 preview 回归并新增链接表弹窗 preview。

## 五、风险提醒（人工复核）

- **模块 id 兼容**：A2 仅改 `name`，严禁动 `id='bank-statement-process'`（settings-repository `ALL_MODULE_IDS`、DB module schema、usage-stats key、数十处引用）。命中 `rules/important-variables.md` 需走 `/check-vars`。
- **现有链路回归**：B 重构面板 DOM 时，`#bankStatementImportBtn / #bankStatementRunBtn / #bankStatementExportBtn / #bankStatementScenarioBtn / #bankStatementStatusBox` 的 id 与事件绑定必须保留，避免破坏现有 run/export/状态机。
- **镜像布局移除**：现 `layout-mirrored`（`direction:rtl`）用于 bankStatement 面板，新布局需重新设计 CSS，注意不要影响共享该 class 的 `bankBuRecon/vccOpCalc` 面板。
- **占位不可伪装**：资金/对账/导出相关占位按钮严禁假装成功或写任何数据。
- **preview 回归**：改前端文件提 PR 前必须重跑对应 `npm run preview:*`（memory `workflow_frontend_previews`）；新增链接表弹窗需补 preview 入口（package.json scripts + render-modal-preview mock + previews 目录）。

## 六、实施记录（合并后回填）

> 由 `TASKS.md` 进度日志同步；本节为合并后回填（workflow_pr_integrate_prd）。

## 七、追加需求（2026-06-07 用户追加，6 条）

> 性质：场景配置弹窗 C2/C3 细节 + 资金对账数据处理面板微调（纯前端）。

| ID | 需求 | 落点 |
|---|---|---|
| **七-1** | 「开始对账」**撤回**为「开始运行」（§A4 回退）| `index.html` `#bankStatementRunBtn` 文案 + 注释 |
| **七-2** | 每组 [导入][导出] 往两侧张开：导入(first-child)往左 14px、导出(last-child)往右 14px | `.pending-action-pair > button:first-child/last-child { translateX(∓14px) }`（两主题）|
| **七-3** | C2「银行对账单赋值自身」赋值区：field 选 FundType 时 value 下拉末尾加「自己输入」；选中→就地替换为输入框（编辑态已有自定义值自动进输入框模式）| `renderScenarioValueControl`（加 allowCustom/customMode/extraClass）+ markValue 调用 + markRow change + `markValueCustom` 局部变量 + ensureFundTypeEnum.then 初始化 |
| **七-4** | C2/C3 标题「— 类别名」后缀不加粗（modeLabel 保持）| 新增 `getCategoryDialogTitleHtml`（拆 modeLabel + `<span class="scenario-config-title-suffix">`）；C2/C3 dialog-title 改用（C1 不变）+ CSS |
| **七-5** | **仅 C2** 赋值两个下拉缩窄至约 80%（160px）；C3「对账成立后赋值」**改回原宽**（长字段名 reconciliationId 需完整显示，用户反馈）| C2 field/value 加 `scenario-config-assign-select` class + CSS |
| **七-6** | 去掉账单类型 #x.x 子序号 + 对账字段 #x 序号（保留「账单类型 #x」分组标题）| 删 C2 `#${bt.seq}.${ci+1}` / C2 `#${idx+1}` / C3 `${idx+1}` 三处 multi-seq span |
| **七-7**（测试通过后追加）| 表名「外汇交割表vPayment→外汇交割表库」「期权表→外汇期权表库」；列头/表名/导入提示「表」→「表库」（表库名 / 表库更新日期 / 中台调拨订单表库 / 链接表库批量导入）；**标题 + 面板按钮「链接表管理」保持不变**（用户回退，未带「库」）| `createLinkedTableManagerDialog` LINKED_TABLES + 列头 + `index.html` 按钮文案 + showComingSoon |

> 七-5 宽度固定 160px（≈原 80%），仅 C2（C3 改回原宽）。七-2 终态：每组导入往左 14px、导出往右 14px（张开，非整体平移）。A4「开始对账」改名作废。
