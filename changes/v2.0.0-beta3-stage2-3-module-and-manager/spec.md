# Spec — v2.0.0-beta.3 阶段 2+3：模块入口 + 场景管理弹窗

> status: apply
> owner: team-lead
> created: 2026-04-28
> updated: 2026-04-28
> 上游 PRD：`docs/iterations/v2.0.0-beta.3/PRD-v2.0.0-beta.3.md` §十二（方案 B PR #30）

## 1. 背景

- v2.0.0-beta.3 主体迭代第 2 个 PR（4 个中第 2 个）
- 目标：在主页面接入新模块「银行对账单处理」+ 实现场景管理弹窗（含类别选择新增）
- **不含**：3 类配置弹窗的具体内容（PR #31）、算法引擎、文件 IO（PR #32）

## 2. 代码现状（必须有出处）

- `index.html:40-44` — module-switcher-menu 现有 3 项（statement-generator / new-account-generator / pending-reconciliation）
- `index.html:157-182` — `pendingModulePanel` 结构：control-row × 2，含 4 个按钮 + statusBox
- `src/renderer.js:39-52` — `MODULES` 常量定义 3 个现有模块
- `src/renderer.js:96` — `state.currentModule` 默认值 `MODULES.statementGenerator.id`
- `src/renderer.js:202-204` — `elements.{statementModulePanel, newAccountModulePanel, pendingModulePanel}` 注册
- `src/renderer.js:1133-1153` — `setCurrentModule(moduleId)` 切换 3 个 panel hidden
- `src/backend/database/settings-repository.js:91-94` — `CURRENT_MODULE_VALID` 数组当前 3 项
- `src/preload.js:24-31`（PR #29 已加） — `desktopApi.scenarios` 6 个 wrapper
- `src/renderer-dialogs.js` — 现有 13+ dialog factory 模式（参考 `createTemplateManagerDialog` / `createPendingRuleDialog`）

## 3. 目标

- 必做：
  1. **模块入口**：MODULES + UI + 切换菜单 + 持久化合法值追加
  2. **bankStatementModulePanel**：fork pendingModulePanel 结构，文案改造（场景管理 / 导入文件 / 开始运行 / 导出文件 / statusBox 初始文案）
  3. **场景管理弹窗**：完整列表 + delete + toggle-enabled + 新增场景流程（类别选择）
  4. **类别选择弹窗**：3 枚举单选下拉 + 继续/取消
- 可不做：
  - **3 类配置弹窗**：占位 alert "深度配置功能将在 v2.0.0-beta.3 阶段 4-6 启用"
  - **导入文件 / 开始运行 / 导出文件按钮的实际行为**：占位 alert
- 明确不做：
  - 不实现 first-match-wins 调度引擎（PR #32）
  - 不 bump 版本号

## 4. 功能点

### F1 — 模块入口
- F1.1 `MODULES.bankStatementProcess`：`{ id: 'bank-statement-process', name: '银行对账单处理' }`
- F1.2 module-switcher-menu 第 4 项 button
- F1.3 `bankStatementModulePanel` panel（fork pendingModulePanel）：
  - `bankStatementScenarioBtn`（"场景管理"，secondary-btn）
  - `bankStatementImportBtn`（"导入文件"，primary-btn，本 PR 占位）
  - `bankStatementRunBtn`（"开始运行"，primary-btn，本 PR 占位 disabled）
  - `bankStatementExportBtn`（"导出文件"，secondary-btn，本 PR 占位 disabled）
  - `bankStatementStatusBox`（初始文案 "请先点击导入文件，选择银行对账单"）
- F1.4 `setCurrentModule` 加 panel hidden 切换分支
- F1.5 `CURRENT_MODULE_VALID` 追加 `'bank-statement-process'`

### F2 — 场景管理弹窗
- F2.1 触发：点 `bankStatementScenarioBtn`
- F2.2 标题："场景管理"（加粗）
- F2.3 表格 6 列：
  | 列 | 数据来源 | 控件 |
  |---|---|---|
  | 序号 | `id`（DB 主键，全局递增） | 文本 |
  | 功能类别 | `category` 中文化（提取ReconId / 冲销账单打标 / 根据资金对账不平结果提取ReconId） | 文本 |
  | 场景名称 | `name` | 文本 |
  | 优先级 | `priority` | 文本 |
  | 执行操作 | — | 3 按钮（编辑→完成 / 查看场景→修改场景 / 删除） |
  | 是否启动 | `enabled` | checkbox |
- F2.4 编辑模式两段式锁（D5）：
  - 默认：按钮 "编辑" / "查看场景" / "删除"
  - 点 "编辑" → 进入解锁，按钮变 "完成" / "修改场景" / "删除"
  - 点 "完成" → 回默认
  - 点 "查看场景"（默认状态）→ 弹 alert "查看模式将在阶段 4-6 启用"（占位）
  - 点 "修改场景"（解锁状态）→ 弹 alert "深度修改将在阶段 4-6 启用"（占位）
- F2.5 删除：弹 confirm "确认删除场景 {名称}？" → 调 `desktopApi.scenarios.deleteOne(id)` → 刷新列表
- F2.6 toggle 启用：checkbox change → 调 `desktopApi.scenarios.toggleEnabled(id, enabled)` → 即时持久化（D13）
- F2.7 左下"新增场景"按钮 → 打开类别选择弹窗

### F3 — 类别选择弹窗
- F3.1 触发：场景管理弹窗的"新增场景"按钮
- F3.2 标题："新增场景"
- F3.3 文本："请选择功能类别"
- F3.4 单选下拉枚举：3 个类别（提取ReconId / 冲销账单打标 / 根据资金对账不平结果提取ReconId）
- F3.5 右下："继续"（占位 alert）+ "取消"（关闭）

## 5. 影响范围

- 前端：
  - `index.html` 加 1 个 module-option + 新 panel
  - `src/renderer.js` MODULES + elements + setCurrentModule + 按钮 binding
  - `src/renderer-dialogs.js` 加 `createScenariosManagerDialog` + `createScenarioCategorySelectDialog`
  - CSS：`src/styles-gemini.css` + `src/styles.css` 加场景管理表格样式
- 后端：
  - `src/backend/database/settings-repository.js` `CURRENT_MODULE_VALID` 追加
- 脚本 / 配置 / 数据：无 schema 变更
- 对外接口影响：
  - 新增 1 个模块 ID `bank-statement-process`
  - PR #29 已加的 6 个 IPC 直接消费（不新增）
- 兼容性影响：
  - 旧版本 `current_module` 持久化值若是 `bank-statement-process`，新版本能识别（合法值校验通过）
  - 旧版本读不到新模块 panel（但本身没用过这个 ID，无影响）

## 6. 技术决策

- **fork pendingModulePanel** 而非从 0 写：4 个按钮 + statusBox 布局完全一致，复用 `.control-board` / `.module-panel` / `.control-row` / `.status-box` CSS
- **占位 alert vs 完整骨架**：
  - F2.4 "查看 / 修改场景" 按钮的占位 alert 比完全 hide 更友好（让用户知道"按钮存在，功能阶段后开放"）
  - 同理 F3.5 "继续"按钮也占位 alert
- **toggle-enabled 即时写库（D13）**：与 PR #27 currentModule 持久化模式一致，fire-and-forget + console.warn
- **删除 confirm 风格**：复用 `createConfirmDialog`（已有）

## 7. 数据 / 状态 / 安全影响

- **数据结构**：无变更
- **状态流转**：`state.currentModule` 多 1 个合法值；新模块 panel 不持有任何 session 数据（本 PR 没接入文件 IO）
- **权限 / 安全**：无
- **资金红线**：无（本 PR 仅 UI 入口；算法引擎在 PR #32 启用时高亮）
- **回滚策略**：
  - 代码层：revert commit
  - 数据层：旧库的 `current_module` 若已是 `bank-statement-process`，回滚后 `CURRENT_MODULE_VALID` 不含此值 → 自动 fallback 默认 `statement-generator`（PR #27 兜底逻辑）

## 8. 待澄清问题

- [x] "查看场景 / 修改场景" 按钮在本 PR 是否完全 disabled？→ 不 disabled，点击弹占位 alert（保持 UI 完整性）
- [x] 类别选择"继续"按钮是否完全 disabled？→ 不 disabled，弹占位 alert
- [x] 删除内置场景需要二次确认还是普通 confirm？→ 普通 confirm（D14：与用户场景同等地位）
- [x] 表格内 toggle 失败时 UI 是否回滚？→ 失败 console.warn + 重新 listScenarios 刷新（容错）
