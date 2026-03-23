# PRD - 网银账单小助手 v1.4.3

| 项目 | 内容 |
|------|------|
| 版本 | v1.4.3 |
| 日期 | 2026-03-23 |
| 状态 | 评审中 |
| 模块 | 映射关系管理、新开账户生成网银账单 |

---

## 一、需求概述

本版本包含 6 项需求，主要涉及两个模块：

1. **映射关系管理对话框**（renderer-dialogs.js `createMappingDialog`）：字段选择控件改回下拉框、拼接字段交互优化、间距回滚。
2. **维护大账号对话框**（renderer-dialogs.js `createBigAccountManagerDialog`）：币种区域布局调整。
3. **新开账户生成网银账单模块**（renderer.js + index.html）：多币种按钮修复、新增按钮位置修正。

---

## 二、需求详细描述

### 需求 1：映射字段控件改回下拉框

**功能说明**

映射关系管理对话框中，除 Balance 字段以外的映射字段，当前使用 `<select multiple size="6">` 展开式多选控件。需要改回单行下拉框（`<select>`，不带 `multiple` 属性），与 Balance 字段的下拉框样式一致。

**当前实现**

- 文件：`src/renderer-dialogs.js` 约第 1469 行
- 当 `supportsMultiSelect` 为 true 时，select 元素添加 `mapping-multi-select` class 和 `multiple size="6"` 属性
- 对应 CSS（`src/styles.css` 约第 1087 行）`.mapping-multi-select` 设定了 `height: auto; min-height: 128px`

**目标行为**

- 所有映射字段的 select 控件统一为单行下拉框，无 `multiple` 属性
- 下拉框外观与 Balance 字段的 `.mapping-select` 样式一致（高度 44px，圆角 14px）
- 选中"需要拼接字段"选项时，仍然显示拼接字段选择器（concat-field-picker）

**交互流程**

1. 用户打开映射关系管理对话框
2. 每个映射字段右侧显示为单行下拉框
3. 点击下拉框展开选项列表（含空选项、"需要拼接字段"选项、源文件表头字段）
4. 选择一个选项后下拉框收起，显示选中值

**UI 说明**

- 移除 `.mapping-multi-select` CSS 类及其样式规则
- select 元素不再携带 `multiple` 和 `size` 属性
- 下拉框样式复用 `.mapping-select` 基础样式（min-width: 260px, height: 44px）

**数据兼容性说明**

改为单选下拉框后，数据格式保持不变：`mappedField` 存储当前选中的单个值，`mappedFields` 仅在拼接模式下使用。v1.4.2 中通过多选控件保存的数据，如果 `mappedFields` 中有多个非拼接值，回显时取 `mappedField`（第一个值）显示在下拉框中，其余值不再回显。此行为可接受，因为多选非拼接的使用场景在 v1.4.3 中已不再支持。`collectMappingDraftFromTable` 函数取值逻辑改为单选后，保存格式不变（`mappedField` 为字符串，`mappedFields` 仅拼接模式下有值），无需数据迁移。

**验收标准**

- [ ] 所有非 Balance 映射字段显示为单行下拉框
- [ ] 下拉框外观与 Balance 字段一致
- [ ] 选择"需要拼接字段"后，拼接字段选择器正常显示
- [ ] 已保存的映射关系能正确回显到下拉框中
- [ ] 不影响 Balance 字段和 MerchantId 字段的现有逻辑
- [ ] v1.4.2 中保存的旧数据（含多选非拼接映射）打开后不报错，以 `mappedField` 值回显

**影响范围**

- `src/renderer-dialogs.js`：`createMappingDialog` 函数中 select 元素的创建逻辑
- `src/renderer-dialogs.js`：`collectMappingDraftFromTable` 函数的取值逻辑（由多选改为单选）
- `src/renderer-dialogs.js`：`getSelectValues` 辅助函数（不再需要处理 `multiple` 分支，但保留不影响功能）
- `src/styles.css`：`.mapping-multi-select` 样式规则（删除）

---

### 需求 2：拼接字段交互优化

**功能说明**

对映射字段选择"需要拼接字段"后出现的拼接字段选择器进行三项交互优化。

#### 2a：下拉框点击空白处收起

**当前实现**

- 文件：`src/renderer-dialogs.js` 约第 1556-1563 行
- 拼接字段的 `.concat-picker-panel` 面板通过点击"选择字段"按钮切换显隐
- 当前没有点击外部区域关闭面板的逻辑

**目标行为**

- 点击 `.concat-picker-panel` 及其触发按钮以外的任意区域时，面板自动收起（设 hidden = true）
- 面板收起时保留已勾选的状态，不清空选择
- 如果同一对话框中有多个拼接面板同时打开，点击外部区域时关闭所有已展开的面板

**交互流程**

1. 用户点击"选择字段"按钮，面板展开
2. 用户在面板内勾选/取消勾选字段
3. 用户点击面板外部任意空白区域，面板收起，已勾选状态保留

**验收标准**

- [ ] 点击面板外部区域，面板收起
- [ ] 点击面板内部区域（勾选框、选项等），面板不收起
- [ ] 点击"选择字段"按钮仍可正常切换面板显隐
- [ ] 面板收起后，已勾选的字段状态保留，预览文本不变
- [ ] 多个拼接面板同时展开时，点击外部区域全部关闭

**影响范围**

- `src/renderer-dialogs.js`：`createMappingDialog` 函数中拼接字段面板的事件处理

#### 2b：预览上方显示"当前拼接顺序："文本

**当前实现**

- 文件：`src/renderer-dialogs.js` 约第 1477 行
- `.concat-preview` 元素直接显示拼接结果文本，无标题标注

**目标行为**

- 在 `.concat-preview` 的上方（正上方，左对齐）新增一行文本："当前拼接顺序："
- 该文本仅在拼接字段选择器可见时显示

**UI 说明**

- 标签文本使用灰色（var(--muted)）、小字号（约 12px）
- 位于拼接预览文本的正上方，与预览文本左对齐

**验收标准**

- [ ] 选择"需要拼接字段"后，预览区域上方显示"当前拼接顺序："文本
- [ ] 文本样式与整体 UI 协调
- [ ] 非拼接模式下该文本不显示

**影响范围**

- `src/renderer-dialogs.js`：拼接字段选择器的 HTML 模板
- `src/styles.css`：新增标签文本样式（如有必要）

#### 2c：取消"多选字段顺序确认"弹窗

**当前实现**

- 文件：`src/renderer-dialogs.js` 约第 380-450 行
- `createMappingOrderDialog` 函数在点击"完成"后被调用（约第 1677-1710 行）
- 当 `draftMappings` 中存在 `mappedFields.length > 1` 的映射时，弹出"多选字段顺序确认"对话框

**目标行为**

- 移除该确认弹窗流程
- 点击映射关系管理的"完成"按钮后，直接使用用户在拼接字段选择器中设定的顺序保存，不再弹出顺序确认对话框

**交互流程**

1. 用户在映射关系管理中完成所有字段映射
2. 点击"完成"按钮
3. 直接保存映射结果（跳过 `createMappingOrderDialog`）

**代码清理要求**

- 删除 `createMappingOrderDialog` 函数及其全部代码
- 删除 `src/styles.css` 中 `.mapping-order-*` 相关样式规则
- 简化"完成"按钮回调逻辑：移除 `multiSelectMappings` 判断分支，直接调用 `saveMappings(draftMappings)`

**数据流说明**

去掉顺序确认弹窗后，拼接字段的 `mappedFields` 数据不会丢失。`collectMappingDraftFromTable` 函数（renderer-dialogs.js:353-377）已内置拼接模式处理逻辑：当检测到 `isConcatMode`（即 select 值为 `CONCAT_FIELDS_MAPPING_FIELD`）时，直接从 `row.dataset.concatFields`（JSON）读取用户在拼接字段选择器中设定的有序字段列表，填入返回值的 `mappedFields` 字段。该数据路径不依赖 `createMappingOrderDialog` 的回注，因此简化"完成"按钮回调后，`collectMappingDraftFromTable` 返回的 `draftMappings` 中拼接字段的 `mappedFields` 已经是正确的有序数组，可直接传给 `saveMappings`。`collectMappingDraftFromTable` 函数本身无需修改。

**验收标准**

- [ ] 点击"完成"后不再弹出顺序确认对话框
- [ ] 拼接字段的顺序以用户在拼接字段选择器中的选择顺序为准
- [ ] 保存的映射数据中 `mappedFields` 顺序正确（数据来源于 `row.dataset.concatFields`，由拼接字段选择器维护）
- [ ] `createMappingOrderDialog` 函数和 `.mapping-order-*` 样式已彻底删除，无残留代码

**影响范围**

- `src/renderer-dialogs.js`：`createMappingDialog` 中"完成"按钮的回调逻辑（约第 1677-1710 行）——移除 `multiSelectMappings` 分支，直接 `saveMappings(draftMappings)`
- `src/renderer-dialogs.js`：`createMappingOrderDialog` 函数（删除，约第 380-450 行）
- `src/renderer-dialogs.js`：`collectMappingDraftFromTable` 函数——无需修改，已正确处理拼接模式（第 357-368 行的 `isConcatMode` 分支从 `row.dataset.concatFields` 读取数据）
- `src/styles.css`：`.mapping-order-*` 相关样式（删除）

---

### 需求 3：维护大账号 — 币种区域布局调整

**功能说明**

维护大账号对话框中，币种列的布局需要调整，使"多币种"勾选框和文本与币种输入框在同一行显示。

**当前实现**

- 文件：`src/renderer-dialogs.js` 约第 998-1010 行
- `.big-account-currency-editor` 使用 flex 布局（`src/styles.css` 约第 1316 行），含 `flex-wrap: wrap`
- 包含三个子元素：币种输入框壳（`enum-input-shell`）、下拉框包装（`currency-dropdown-wrap`，width: 168px）、多币种勾选标签（`big-account-multi-label`）
- 当容器宽度不足时，"多币种"标签会换行到下一行

**目标行为**

- 缩小币种输入框/下拉框的宽度，确保"多币种"勾选框和文本与币种输入框始终在同一行
- 所有元素（币种输入框或下拉框按钮 + "多币种"勾选框 + 文本）水平排列，不换行

**UI 说明**

- 缩小 `.big-account-currency-dropdown-wrap` 的宽度（从 168px 适当减小）
- 或缩小 `.big-account-currency-input-shell` 的宽度
- 确保 `flex-wrap: nowrap`（或移除 `wrap`），让所有元素强制同行
- 最小窗口宽度以应用默认窗口尺寸为基准（约 1200px），在此宽度下必须保证同行
- 极端窄窗口场景下（低于 900px），允许容器内元素压缩但不换行，如文本被截断可接受

**验收标准**

- [ ] 大账号币种编辑区域的所有元素在同一行显示
- [ ] "多币种"勾选框和文本不换行
- [ ] 币种输入框/下拉框仍可正常使用，文字不被截断
- [ ] 在默认窗口尺寸（约 1200px 宽）下布局正常
- [ ] 在较小窗口尺寸（约 900px 宽）下元素不换行，允许适度压缩

**影响范围**

- `src/styles.css`：`.big-account-currency-editor`、`.big-account-currency-dropdown-wrap` 及相关样式

---

### 需求 4：映射关系间距回滚

**功能说明**

v1.4.2 版本中对映射关系管理对话框的模板字段列新增了样式约束，导致两列间距视觉效果发生变化，此改动需要回滚到 v1.4.2 之前的状态。

**当前实现**

- 文件：`src/styles.css`
- v1.4.2 **新增**了 `.mapping-card .data-table td:first-child` 和 `.mapping-card .data-table th:first-child` 规则（约第 851-856 行），内容为 `width: 1%; white-space: nowrap; padding-right: 8px`
- 该规则使模板字段列被压缩为最小宽度（`width: 1%` + `nowrap`），并添加了固定的 `padding-right: 8px`，导致两列间距变窄
- `.mapping-field-editor` 的 `gap: 12px` 在 v1.4.2 前后未变化，不需要修改

**目标行为**

- **删除** v1.4.2 新增的 `.mapping-card .data-table td:first-child` 和 `.mapping-card .data-table th:first-child` 规则
- 删除后，模板字段列宽度恢复为表格自动分配，两列间距恢复到 v1.4.2 之前的自然状态

**验收标准**

- [ ] `src/styles.css` 中 `.mapping-card .data-table td:first-child` 和 `th:first-child` 规则已删除
- [ ] 映射关系管理对话框中模板字段列宽度恢复为自动分配（不再被强制压缩）
- [ ] 两列间距视觉效果恢复到 v1.4.2 之前
- [ ] 不影响其他对话框的布局

**影响范围**

- `src/styles.css`：删除 `.mapping-card .data-table td:first-child` 和 `.mapping-card .data-table th:first-child` 规则（约第 851-856 行）

---

### 需求 5：新开账户多币种按钮修复与改造

**功能说明**

新开账户生成网银账单模块中，多币种账户功能存在 Bug（按钮点不了），需修复并改造为：勾选"多币种账户"后，币种输入框变成下拉框，支持多选，勾选后显示序号。

**当前实现**

- 文件：`index.html` 约第 88-104 行
- 勾选"多币种账户"复选框后，应切换币种输入框为下拉框（`newAccountCurrencyDropdownWrap`）
- 文件：`src/renderer.js` 中 `syncNewAccountCurrencyMode` 函数控制切换逻辑
- 下拉框面板 `.new-account-currency-dropdown-panel` 内渲染币种选项（checkbox 列表）

**Bug 描述**

- 当前多币种按钮点击无响应，可能是事件绑定或 DOM 引用问题

**目标行为**

1. 勾选"多币种账户"复选框后：
   - 币种文本输入框隐藏
   - 显示下拉框按钮
   - 点击下拉框按钮展开币种多选面板
2. 多选面板中：
   - 每个币种选项前有 checkbox
   - 勾选后，选项旁显示序号（如 1、2、3...），表示选择顺序
   - 可复用拼接字段选择器（`concat-picker-panel`）的下拉框样式和序号显示逻辑
3. 下拉框按钮上显示已选币种的摘要文本
4. 未勾选任何币种时，下拉框按钮显示占位文本（空白或不可点击状态）
5. 币种选择无数量上限；当选择数量较多时，按钮摘要文本使用截断或省略展示（如"3个币种"）
6. 点击面板外部区域关闭面板

**交互流程**

1. 用户勾选"多币种账户"
2. 币种输入框切换为下拉框按钮
3. 点击下拉框按钮，展开多选面板
4. 勾选币种，面板中显示勾选顺序序号
5. 点击面板外部区域关闭面板
6. 下拉框按钮文本更新为已选币种摘要

**UI 说明**

- 多选面板样式可复用 `.concat-picker-panel` 的圆角、边框、阴影
- 序号样式复用 `.concat-picker-index` 的主色调、粗体效果
- 下拉框按钮复用现有 `.new-account-currency-dropdown-btn` 样式

**数据格式说明**

多币种选择后，生成的网银账单中币种数据格式沿用现有 `selectedCurrencies` 数组结构（币种代码字符串数组），顺序即用户勾选顺序。最终 Excel 输出的币种格式由后端（`desktopApi.newAccount.generate`）决定，前端只需保证传递正确的有序币种数组。

**验收标准**

- [ ] 修复前点击无响应的多币种按钮现在可正常点击响应（Bug 回归验证）
- [ ] 勾选"多币种账户"后，币种区域切换为下拉框
- [ ] 点击下拉框按钮可展开多选面板
- [ ] 勾选币种后，面板中显示勾选顺序序号（1、2、3...）
- [ ] 取消勾选后序号自动重排
- [ ] 下拉框按钮文本正确显示已选币种摘要
- [ ] 未选择任何币种时，按钮显示空白或占位文本
- [ ] 选择多个币种时，摘要文本合理展示（如"3个币种"）
- [ ] 点击面板外部区域，面板关闭
- [ ] 取消勾选"多币种账户"后恢复为文本输入框
- [ ] 新增行（clone 行）的多币种功能同样正常工作

**影响范围**

- `src/renderer.js`：`renderNewAccountCurrencyOptions` 函数（约第 623-689 行）——主要修改点，需新增序号显示逻辑
- `src/renderer.js`：`syncNewAccountCurrencyMode`、`openNewAccountCurrencyDropdown`——Bug 修复，排查事件绑定/DOM 引用问题
- `src/renderer-dialogs.js`：如有共享的下拉面板组件逻辑
- `src/styles.css`：币种下拉面板样式（可能需微调或复用 `.concat-picker-index` 序号样式）
- `index.html`：无需修改（已有相关 DOM 结构）

---

### 需求 6：新增按钮位置修正

**功能说明**

新开账户模块的"新增"文字按钮，应位于"银行账号"标签文本（`<span class="new-account-label">银行账号</span>`）的右侧，而不是当前的银行账号输入框右侧。

**当前实现**

- 文件：`index.html` 约第 106-112 行
- "新增"按钮（`newAccountAddRowBtn`）位于 `.new-account-bank-account-row` div 内，紧跟在银行账号输入框之后
- 布局结构：`<label>` > `<span>银行账号</span>` + `<div>` > `<input>` + `<button>新增</button>`

**目标行为**

- "新增"按钮移到 `<span class="new-account-label">银行账号</span>` 的右侧
- 视觉上与"银行账号"标签文本在同一行，位于标签文字右侧

**UI 说明**

- "新增"按钮与标签文本基线对齐或垂直居中对齐
- 按钮样式保持不变（`.text-action .new-account-add-btn`）
- 标签行需要调整为 flex 布局以容纳按钮

**交互流程**

1. 用户看到"银行账号"标签文本右侧有"新增"文字按钮
2. 点击"新增"添加新行（功能不变）

**验收标准**

- [ ] "新增"按钮显示在"银行账号"标签文本的右侧
- [ ] 按钮不在输入框右侧
- [ ] 仅第一行显示"新增"按钮（现有逻辑保持不变）
- [ ] 点击"新增"功能正常
- [ ] 新增行的布局正确（无多余的"新增"按钮）
- [ ] DOM 结构调整后，JS 中通过 DOM 查询定位"新增"按钮的代码（`getNewAccountRowElements` 中的 `.new-account-add-btn` 选择器、`addNewAccountRow` 中的 clone 逻辑）已同步适配

**影响范围**

- `index.html`：银行账号字段区域的 DOM 结构调整（"新增"按钮从 `.new-account-bank-account-row` 移至标签行）
- `src/styles.css`：标签行布局样式调整（标签 span 容器改为 flex）
- `src/renderer.js`：`getNewAccountRowElements` 中 `addRowBtn` 的选择器可能需适配新 DOM 位置；`addNewAccountRow` 中 clone 行后的按钮显隐逻辑需验证

---

## 三、需求优先级

| 优先级 | 需求编号 | 需求名称 |
|--------|----------|----------|
| P0 | 需求 5 | 新开账户多币种按钮修复与改造（Bug 修复 + 功能改造）|
| P1 | 需求 1 | 映射字段控件改回下拉框 |
| P1 | 需求 2 | 拼接字段交互优化 |
| P1 | 需求 4 | 映射关系间距回滚 |
| P2 | 需求 3 | 维护大账号币种布局调整 |
| P2 | 需求 6 | 新增按钮位置修正 |

---

## 四、非功能性要求

- 不引入新的外部依赖
- 保持现有代码风格一致性

### 数据兼容性策略

| 需求 | 兼容策略 |
|------|----------|
| 需求 1（多选改单选）| 数据格式不变。旧数据中 `mappedField` 存储首选值，改为单选后以此值回显；`mappedFields` 的多选非拼接值不再回显，此为预期行为。无需数据迁移。|
| 需求 5（多币种改造）| 数据格式不变。`selectedCurrencies` 数组结构保持，新增序号为前端展示逻辑，不影响存储格式。|

---

## 五、回归测试范围

各需求可能影响到的关联功能，供测试制定回归策略参考：

| 需求 | 回归测试范围 |
|------|-------------|
| 需求 1 | 映射关系的保存/加载/回显；导出明细功能（依赖映射数据）；模板切换后映射重载 |
| 需求 2 | 拼接字段的选择/排序/保存；映射关系整体保存流程；拼接结果在导出 Excel 中的正确性 |
| 需求 3 | 维护大账号对话框的增删改操作；币种选择功能（单币种/多币种切换）|
| 需求 4 | 映射关系管理对话框整体布局；其他对话框间距未受影响 |
| 需求 5 | 新开账户模块的完整流程（填写表单 -> 生成 -> 导出）；单币种/多币种切换；多行表单的币种独立性 |
| 需求 6 | 新增行功能；删除行后的布局；多行表单的完整性 |
