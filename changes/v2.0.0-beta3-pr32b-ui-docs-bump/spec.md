# Spec — v2.0.0-beta.3 PR #32b：4 dialog + 接入 + preview + E2E + 文档 + bump（闭环 + 发版）

> status: apply（v2.0.0-beta.3 最后一个 PR）
> owner: team-lead
> created: 2026-04-29
> 上游 PRD：`docs/iterations/v2.0.0-beta.3/PRD-v2.0.0-beta.3.md` §7.1-7.5（详细设计）/ §13（手动测试）
> 关联：PR #32a（已 merge `e21be0d`，5 channel + dispatcher + io）
> Q3=A：4 dialog 全做完后一次 Codex review

## 1. 背景

- v2.0.0-beta.3 主体迭代第 4 个 PR 切分后第二段（前端闭环 + 发版）
- 前置已就绪：
  - PR #29 数据底座（scenarios 表 + 6 IPC + repository）
  - PR #30 模块入口 + 场景管理 CRUD 弹窗（含 3 处占位）
  - PR #31 算法引擎纯函数（C1/C2/C3 + 字段常量 + 23 单测）
  - PR #32a 调度 + IO + 5 IPC（dispatcher 11 + io 12 + writer 3 = 26 单测）
- 本 PR 把上面四块串成"导入 → 运行 → 标黄输出"完整工作流（用户能用的功能闭环）
- 发版动作：bump `2.0.0-beta.2` → `2.0.0-beta.3` + 文档三件套

## 2. 代码现状（必须有出处）

- **算法层（PR #31）**：`runScenario` → `{ lockedRowIds, modifications, warnings }`
- **数据层（PR #29）**：`desktopApi.scenarios.{list, get, create, update, deleteOne, toggleEnabled}`
- **后端 IO + 调度（PR #32a）**：`desktopApi.bankStatement.{import, importGatewayRecon, run, export, sessionStatus}`
- **UI 骨架（PR #30）**：
  - `src/renderer-dialogs.js#createScenariosManagerDialog`（line 5320）— 6 列表 + 编辑两段式锁 + toggle 即时写库
  - `src/renderer-dialogs.js#createScenarioCategorySelectDialog`（line 5460）— 3 类单选 + "取消/继续"
  - `src/renderer.js#MODULES.bankStatementProcess` + `bankStatementModulePanel`（4 按钮 + statusBox）
- **3 处占位 alert（PR #30）**，本 PR 替换：
  - `renderer-dialogs.js:5400-5408` — view-or-modify action → 'view'/'edit' 模式 dialog
  - `renderer-dialogs.js:5491-5495` — 类别选择"继续" → create 模式 dialog
  - `renderer.js` bankStatementModulePanel 4 按钮 binding（"导入文件" / "开始运行" / "导出文件"）— 当前 alert，需接入 PR #32a IPC

## 3. 目标

### 必做

1. **4 个 dialog factory**（`createScenarioConfigDialogC1` / `C2` / `C3` / `createScenarioConfirmDetailDialog`）— PRD §7.1 / §7.2 / §7.3 / §F3.5
2. **接入 PR #30 占位 3 处**：
   - `view-or-modify` action → 调 `desktopApi.scenarios.get(id)` + 进入对应 category dialog（mode='edit' 编辑模式 / mode='view' 默认模式）
   - 类别选择"继续" → 进入对应 category dialog（mode='create'）
3. **bankStatementModulePanel 4 按钮 binding 改写**：
   - 场景管理：保留（PR #30 已实现）
   - 导入文件 → `desktopApi.bankStatement.import()` + statusBox 更新
   - 开始运行 → `desktopApi.bankStatement.run()` + statusBox 更新（C3 启用且未导入 gw → confirmDialog 三选一）
   - 导出文件 → `desktopApi.bankStatement.export()` + 处理 ok/empty 分支 + 显示文件路径
4. **statusBox 文案动态更新**（PRD §F8）：未导入 / 已导入 / 已处理 / 已导出 4 状态
5. **renderer state**（renderer.js）：
   - `state.bankStatementSession` / `gatewayReconSession` / `processingResult`（仅作 UI 缓存，数据真在 main 进程）
   - `state.scenarioDraft`（dialog 编辑/新建过程中的临时配置）
   - 模块切换时 / 启动时 调 `desktopApi.bankStatement.sessionStatus()` 同步 statusBox
6. **CSS 双风格**：`styles.css` + `styles-gemini-extra.css` 各加配置弹窗布局（约 +200 行 each）
7. **Preview state**（4 张新 png）：
   - `scenario-config-c1`（create 模式 + 1 条件 + 行 4 勾选 + 字段示例）
   - `scenario-config-c2`（create 模式 + 2 类型 + 1 对账字段 + 打标值）
   - `scenario-config-c3`（create 模式 + 1 对账字段 + 赋值字段）
   - `scenario-confirm-detail`（C1 配置文本预览）
8. **E2E smoke**：`scripts/smoke/scenario-end-to-end.js`（in-memory：构造 mock bankRows + gwRows + 场景 → dispatcher → exceljs writer 全链路）
9. **用户样例文件人工 dry-run**：用户提供 `银行对账单.xlsx` + `资金对账导出不平.xlsx` 跑 PRD §13 P0-1 ~ P0-11
10. **文档三件套**：CHANGELOG.md / docs/VERSION_FEATURE_HISTORY.md / docs/USER_GUIDE.md
11. **版本 bump**：`package.json.version` `2.0.0-beta.2` → `2.0.0-beta.3`
12. **check-vars 硬节点**（版本 bump + 合并到 main 前）

### 不做

- 内置场景"恢复出厂"（PRD Q-E）
- C2 笛卡尔 O(N²) 性能优化（PRD §11，本 PR 不 profile）
- 大文件性能 spike（用户样例文件足够 dry-run，不构造 3 万行）

## 4. 功能点

### F1 — C1 配置弹窗（`createScenarioConfigDialogC1`）

完全按 PRD §7.1 + PR #32a spec.md 已废弃的 §F2 段（保留作为参考）。

UI 布局 5 行：
| 行 | 字段 | 控件 |
|---|---|---|
| 1 | 场景名称 | input[type=text] |
| 2 | 优先级 | input[type=number, min=0, max=3] + tooltip "3=最高 / 0=最低" |
| 3 | 条件（多行）| 多行表格：[字段下拉][操作下拉][值输入] + 新增/删除 |
| 4 | 根据特征提取 | checkbox + [筛选字段多选] + [英文特征] + [数字位数] + [总位数] |
| 5 | 根据其他字段提取 | checkbox + [字段下拉] |

**关键交互**：
- 行 4 / 行 5 互斥：点行 4 checkbox 自动取消行 5（反之亦然）；都不勾允许保存（运行时不产出，已经在 PR #31 算法层处理）
- 行 3 操作下拉枚举：`等于 / 不等于 / 包含 / 不包含 / 空值 / 非空值 / 开头为`；选 `空值` / `非空值` 时值输入框 disabled
- 字段下拉枚举 = `BANK_STATEMENT_FIELDS`（44 列，PR #31 常量）
- mode：'create' / 'edit' / 'view'；view 模式所有 input/select disabled，按钮区改为单一"返回"

**整体验证**（点"确认"前）：
- 场景名非空（trim 后）
- 场景名全局唯一（DB 层 UNIQUE 约束兜底，前端做即时提示）
- 优先级 0-3 整数
- 条件 ≥ 1 行
- 行 4：英文特征 `^[A-Z]+$`（含空也允许）+ 数字位数 ≥ 1 + 总位数 ≥ 数字位数 + len(英文特征)
- 行 4/5 都不勾时不报错（PRD §7.1 行 4/5 互斥但都允许 unchecked）

**右下"取消" / "确认"** → 确认进入 F4 确认场景详情弹窗

### F2 — C2 配置弹窗（`createScenarioConfigDialogC2`）

完全按 PRD §7.2。UI 布局 5 行：
| 行 | 字段 | 控件 |
|---|---|---|
| 1 | 场景名称 | input |
| 2 | 优先级 | input 0-3 |
| 3 | 账单类型（多行带序号）| #序号 / 字段下拉 / 操作下拉 / 值 + 新增/删除 |
| 4 | 对账字段（多行 vs 横向）| #序号 / 账单类型 1 / 字段 1 / vs / 账单类型 2 / 字段 2 + 新增/删除 |
| 5 | 对账成立的打标值 | 账单类型下拉 + 字段下拉 + 值输入 |

**关键交互**：
- 行 3 序号自动从 1 起递增；删除行后序号重排
- 行 4 / 行 5 的"账单类型下拉"枚举 = 行 3 当前所有序号（动态联动；行 3 增减时联动重渲）
- 字段下拉 = `BANK_STATEMENT_FIELDS` 44 列

**验证**：
- 场景名 / 优先级同 C1
- 账单类型 ≥ 2 行（笛卡尔配对至少需要两类）
- 对账字段 ≥ 1 行
- 打标值类型必须存在于行 3
- 打标字段非空 + 写入值非空

### F3 — C3 配置弹窗（`createScenarioConfigDialogC3`）

完全按 PRD §7.3。UI 布局 4 行：
| 行 | 字段 | 控件 |
|---|---|---|
| 1 | 场景名称 | input |
| 2 | 优先级 | input 0-3 |
| 3 | 对账字段（多行 vs 横向）| #序号 / 网关账单字段 / vs / 银行对账单字段 + 新增/删除 |
| 4 | 对账成立后赋值 | 网关账单字段 / 赋值给 / 银行对账单字段 |

**关键交互**：
- 行 3 网关账单字段下拉 = `GATEWAY_RECON_FIELDS`（31 列，PR #31 常量）
- 行 3 银行对账单字段下拉 = `BANK_STATEMENT_FIELDS_FOR_C3`（44 列 + `'发生额绝对值'` 虚拟字段）
- 行 4 赋值字段同上

**验证**：
- 场景名 / 优先级同 C1
- 对账字段 ≥ 1 行
- 赋值字段两端都非空

### F4 — 确认场景详情弹窗（`createScenarioConfirmDetailDialog`）

按 PRD F3.5（§7 内联段）。

- 标题"确认场景详情"
- Body：上一级配置的"文本化预览"
  - C1：列出 conditions / extractByFeature 或 extractByOtherField
  - C2：列出 billTypes / reconFields / markValue
  - C3：列出 reconFields / assign
- **右下"完成"** → 落库（create/update）→ 刷新场景管理弹窗
- **右下"返回"** → 回上级配置弹窗（保留输入）

**落库逻辑**：
- create 模式：调 `desktopApi.scenarios.create({ category, name, priority, enabled: true, config })`
- edit 模式：调 `desktopApi.scenarios.update(id, { name, priority, config })`
- 失败：弹 alert + 留在确认详情弹窗
- 成功：close + 重新打开 `createScenariosManagerDialog`（刷新列表）

### F5 — 接入 PR #30 占位 3 处

| PR #30 占位（renderer-dialogs.js）| 替换为 |
|---|---|
| `view-or-modify` action（line 5400）| `tr.classList.contains('is-editing')` 决定 mode：edit / view；`desktopApi.scenarios.get(id)` → 按 category 进入对应 dialog（预填 + mode）|
| 类别选择"继续"（line 5491）| 按 category 进入对应 dialog（mode='create'，无预填）|

**`state.scenarioDraft`** 在 4 个弹窗之间共享：
- 配置 → 确认详情：完整 config 写入 draft
- 确认详情"返回" → 回到配置弹窗，从 draft 预填
- 完成 / 取消 / dialog 关闭：清空 draft

### F6 — bankStatementModulePanel 4 按钮 binding 改写

替换 `renderer.js` bankStatementModulePanel 4 按钮 binding：

| 按钮 | 状态 | 动作 |
|---|---|---|
| 场景管理 | 始终 enabled | 调 `createScenariosManagerDialog`（PR #30 已实现，不改）|
| 导入文件 | 始终 enabled | 调 `desktopApi.bankStatement.import()` |
| 开始运行 | session 已导入时 enabled（statusBox 状态控制）| 调 `desktopApi.bankStatement.run()` |
| 导出文件 | hasProcessingResult 时 enabled | 调 `desktopApi.bankStatement.export()` |

**导入文件交互**：
- 成功 → statusBox 更新："已导入：{文件名}（{行数} 行）"
- invalid → alert："表头不符 / 缺 sheet 等" + statusBox 不变
- cancelled → statusBox 不变

**开始运行交互**：
- 启动前检查：若启用了 C3 类场景 + 未导入 gw → confirmDialog："请导入资金对账不平结果表（可跳过）"，三选一：
  - 导入 → 调 `desktopApi.bankStatement.importGatewayRecon()` 后再 run
  - 跳过 → 直接 run（dispatcher 会按 PR #32a R3 fix 让 C3 产 'no-gateway-rows' warning）
  - 取消 → 关闭对话框，不 run
- run 成功 → statusBox 更新："已处理：{命中行数} 行，{警告数} 警告"
- run 失败 → alert + statusBox 不变

**导出文件交互**：
- ok → alert："已导出：{mainFilePath}{若有}" + 提供"打开文件夹"链接
- empty + errorReportPath → alert："无修改记录，但有 N 条警告（路径：xxx）"
- empty + 无 errorReport → alert："无修改记录"
- failed → alert + 错误信息

**statusBox 文案 4 状态**：
- 初始："未导入文件"
- 导入后："已导入：{fileName}（{rowCount} 行）" + 若导入了 gw："+ 资金对账：{gwFileName}（{gwRowCount} 行）"
- 运行后："已处理：{hitRowCount} 行（{scenarioHitCount} 场景命中），{warningCount} 警告"
- 导出后："已导出：{mainFileName}" + 若 errorReport："+ {errorReportName}"

### F7 — Renderer state（renderer.js）

新增字段：
```js
state.bankStatementSession = null;       // { fileName, rowCount, importedAt } 仅 UI 缓存
state.gatewayReconSession = null;        // { fileName, rowCount, importedAt }
state.processingResult = null;           // { hitRowCount, scenarioHitCount, warningCount, ranAt }
state.scenarioDraft = null;              // dialog 配置编辑中的临时 config（含 mode/category/originalScenarioId）
```

模块切换 / 启动时调 `desktopApi.bankStatement.sessionStatus()` 同步：
```js
async function refreshBankStatementStatus() {
  const status = await desktopApi.bankStatement.sessionStatus();
  state.bankStatementSession = status.hasBankStatement
    ? { fileName: status.bankStatementFileName, rowCount: status.bankStatementRowCount }
    : null;
  // ... 同步 state，刷新 statusBox + 按钮 disabled 状态
}
```

### F8 — CSS（双风格）

`styles.css` + `styles-gemini-extra.css` 各加：
- `.scenario-config-card` 配置弹窗主容器（5 行 grid 布局）
- `.scenario-config-row` + `.scenario-config-row-label` + `.scenario-config-row-control` 单行布局
- `.scenario-config-multi-row-table` 多行编辑表格（行 3/4/5 多行）
- `.scenario-config-vs-row` vs 横向布局（C2 行 4 / C3 行 3）
- `.scenario-config-mutex-row` 互斥 checkbox 行（C1 行 4/5）
- `.scenario-confirm-detail-body` 文本预览容器
- view 模式样式（disabled input 视觉）

### F9 — Preview state（renderer-previews.js）

新增 4 个 preview state 函数：

```js
function previewScenarioConfigC1() {
  // mode='create' + 1 条件（CustomerRef 包含 FT）+ 行 4 勾选 + 特征 FT/12/15
  state.scenarioDraft = { mode: 'create', category: 'extract-recon-id', config: {...} };
  openModal(createScenarioConfigDialogC1());
}

function previewScenarioConfigC2() { /* ... */ }
function previewScenarioConfigC3() { /* ... */ }
function previewScenarioConfirmDetail() { /* ... */ }
```

`scripts/render-account-mapping-preview.js` 主入口分发追加 4 项。

### F10 — E2E smoke

`scripts/smoke/scenario-end-to-end.js`（新）：
- 构造 mock bankRows（10 行）+ gwRows（5 行）+ scenarios（3 内置）
- 调 dispatcher → 验证 modifiedRows + errorReport
- 调 exceljs-writer → 写到 tmp 文件 → 读回校验标黄 cell + headers
- 接入 `scripts/smoke-test.js`

不构造 dialog factory smoke（DOM 依赖电池模拟，复杂度高；preview 渲染就是 dialog smoke）。

### F11 — 用户样例文件人工 dry-run

跑 PRD §13.1 P0-1 ~ P0-11（11 个用例）：
- 用户提供 `银行对账单.xlsx`（44 列）+ `资金对账导出不平.xlsx`（含「网关账单」sheet）
- 启用 C1+C2+C3 各 1 条内置场景
- 对照预期结果（标黄 / 文件名 / error-report）

dry-run 结果写入 PR body + tasks.md 验收。

### F12 — 文档三件套

按 `workflow_docs_update`：v2.0.0-beta.3 系列发版（本 PR）才统一更新。

- **CHANGELOG.md**：新增 `## 2.0.0-beta.3 — 2026-04-29` 条目
  - 列阶段 1-8 全部产物（4 个 PR）
  - **资金红线高亮**段落
- **docs/VERSION_FEATURE_HISTORY.md**：表格追加 v2.0.0-beta.3 行
- **docs/USER_GUIDE.md**：新增"银行对账单处理模块"章节
  - 模块入口 / 场景管理 / 3 类场景配置（C1/C2/C3 各一段）/ 工作流（导入 → 运行 → 导出）
  - 4 张新 preview 截图

### F13 — 版本 bump

`package.json.version` `2.0.0-beta.2` → `2.0.0-beta.3`。

## 5. 影响范围

- **前端新增**：
  - `src/renderer-dialogs.js` — 4 个新 dialog factory（约 +1500 行）
  - `src/renderer.js` — bankStatementModulePanel 4 按钮 binding 改写 + state.bankStatementSession 等 + refreshBankStatementStatus（约 +250 行）
  - `src/renderer-previews.js` — 4 张 preview state（约 +120 行）
  - `src/styles.css` + `src/styles-gemini-extra.css` — 各加 ~200 行
- **前端修改**：
  - `src/renderer-dialogs.js` createScenariosManagerDialog（PR #30）— `view-or-modify` action 接入 dialog（替换 alert）
  - `src/renderer-dialogs.js` createScenarioCategorySelectDialog（PR #30）— "继续"按钮接入 dialog
- **依赖**：无新依赖（exceljs PR #32a 已装）
- **测试**：
  - `scripts/smoke/scenario-end-to-end.js`（新，~150 行）
  - `scripts/smoke-test.js` 接入
- **预览**：`scripts/render-account-mapping-preview.js` 主入口分发 + `docs/previews/` 加 4 张新 png
- **文档**：CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE
- **版本**：`package.json`
- **不动**：
  - 任何后端文件（main.js / preload.js / 任何 main-process/）
  - PR #29/#30/#31/#32a 已 merge 内容
  - scenarios 表 schema / 6 scenarios IPC / 5 bankStatement IPC

## 6. 技术决策

### D1 dialog factory 文件位置

- 全部加在 `src/renderer-dialogs.js`（已有 5500 行，但保持单文件便于查找）
- 按 createScenariosManagerDialog 后顺序：C1 → C2 → C3 → 确认详情

### D2 dialog 状态保留：state.scenarioDraft

- 4 弹窗共享 `state.scenarioDraft = { mode, category, originalScenarioId, config }`
- "返回" 按钮：保留 draft，重新打开配置弹窗时预填
- "完成" 落库成功：清空 draft + 关闭弹窗 + 重开场景管理弹窗
- "取消" / dialog 关闭 / 模块切换：清空 draft

### D3 view 模式 disabled 实现

- 所有 input / select 加 `disabled` 属性
- 多行编辑表格的"新增/删除"按钮 hidden
- 按钮区只剩"返回"（关闭 dialog 回场景管理弹窗）

### D4 dialog factory 实施顺序（用户 Q3=A 配套）

1. 第 1 天：C3（最简 4 行）+ C1（5 行 + 互斥）
2. 第 2 天：C2（5 行 + 序号自动 + vs，最复杂）+ 确认详情
3. 第 3 天：CSS 双风格 + state + 接入 PR #30 占位 + bankStatementModulePanel 4 按钮 binding
4. 第 4 天：preview state + 渲染 4 张 png + E2E smoke
5. 第 5 天：用户样例文件 dry-run + 文档三件套
6. 第 6 天：bump + check-vars + PR

### D5 资金对账文件检查时机（PR #32a Q-A1 配套）

- 用户点"开始运行"时检查 C3 启用 + 未导入 gw → confirmDialog 三选一
- 不在导入银行对账单时检查（用户可能改 C3 启用状态）

### D6 用户样例文件不入 git

- 用户提供的 `银行对账单.xlsx` / `资金对账导出不平.xlsx` 是真实数据样本
- 添加到 `.gitignore` 防止误 commit
- dry-run 完手动删除或留 working tree

### D7 4 张新 preview state 不需要 mock IPC

- preview script 用 mock state.scenarioDraft 直接渲染 dialog
- IPC 调用（如 scenarios.create）在 preview 模式下不实际触发（mock 或 noop）

## 7. 数据 / 状态 / 安全影响

### ⚠️ 资金红线（高亮提醒，最高级）

本 PR **真改 FundType / ReconciliationId**：

- C2 笛卡尔配对：`outbound 行 FundType` 改 `outbound Fail` → 后续清算路由依据
- C3 join：`银行对账单.ReconciliationId` 由网关账单赋值 → 对账依赖字段
- first-match-wins 调度：C1 优先级 3 > C2 优先级 2 > C3 优先级 1

**强制要求**：
- E2E smoke F10 必须 PASS
- F11 用户样例文件人工 dry-run PRD §13 P0-1 ~ P0-11 全部通过
- PR body 高亮"⚠️ 资金红线"段落 + dry-run 结果

### Schema 变更：无

### 状态生命周期

- `state.bankStatementSession` 等：renderer 仅作 UI 缓存；数据真在 main 进程（PR #32a 实现）
- 模块切换 / 启动时由 `desktopApi.bankStatement.sessionStatus()` 同步
- 进程重启不持久化（PRD §8.2）

### 回滚

- 代码层：revert merge commit
- 数据层：无（无 schema 变更）
- 用户已生成的导出文件：用户自己管理

## 8. 待澄清问题

| ID | 问题 | 状态 |
|---|---|---|
| Q1 | dialog 失败后关闭策略：留输入 vs 清空 | ⏳ 默认留输入（state.scenarioDraft 保留）；用户主动"取消"才清空 |
| Q2 | 用户样例文件是否覆盖所有 P0 用例？| ⏳ 实施 dry-run 时检查；缺的话构造补充样本 |
| Q3 | bankStatementModulePanel "导入资金对账文件"按钮是否独立显示？| ⏳ 推荐：不独立按钮，只在"开始运行"时弹 confirmDialog 触发；状态栏显示已导入的 gw 文件名 |

## 9. 实施顺序

按 D4：
- 第 1 天：F3 C3 dialog → F1 C1 dialog
- 第 2 天：F2 C2 dialog → F4 确认详情 dialog
- 第 3 天：F8 CSS → F7 state → F5 接入 PR #30 → F6 bankStatementModulePanel
- 第 4 天：F9 preview state → 渲染 4 张 png → F10 E2E smoke
- 第 5 天：F11 用户样例文件 dry-run → F12 文档三件套
- 第 6 天：F13 bump → check-vars → 提 PR
