# Tasks — v1.5.2

> 按需求拆 3 组 task（G1/G2/G3），组内按箭头顺序执行。
> 建议实施顺序（最小风险优先）：G1 → G3 → G2。见 TechDoc §六。
>
> **本次（2026-04-16 Reverse Sync）新增 2 个前置 task：**
> - **G3-0（虚拟 ID 短路 helper）** 进入 G3 其他 task 之前必须先完成，对应决策 ④
> - **G2-0（主模板多文件分支兼容性排查）** 进入 G2 其他 task 之前必须先完成，对应决策 ②

---

## G1 — 需求 1：主/子模板的模板名校验（最小风险组）

### Task G1-1
- 目标：在映射关系管理「完成」按钮点击时前置执行"子名包含主名"的字符串校验
- 涉及文件：`src/renderer-dialogs.js`（`:2542` `doneBtn.click` handler）
- 操作：
  - 在 `doneBtn.addEventListener('click', async () => { ... })` 回调最顶部插入约 15 行前置逻辑：
    1. 读 `isChildCheckbox.checked` + `parentSelect.value`；
    2. 从 `state.templates` 找到主模板 → 取 `parentTemplate.name`；
    3. `if (!payload.template.name.includes(parentTemplate.name))` → 弹 `createAlertDialog('子模板与主模板模板名匹配不上，请检查。', { onConfirm: () => openModal(createMappingDialog(payload)) })` + `return`；
  - 不改 `saveMappings`、`setParentStatus`、`setChildParent` 的任何调用。
- 验证：
  - 手动测试：
    - P0-1 通过 → 正常落库；
    - P0-2 失败 → 弹提醒，不落库（`desktopApi.templates.setChildParent` 无调用，在 devtools 网络面板或日志中确认）；
    - P0-3 同名通过；
    - P1-1 未勾子模板不触发校验。
- 状态：done（2026-04-16；`src/renderer-dialogs.js:2542-2558` 新增 15 行前置校验，smoke 通过）

### Task G1-2
- 目标：对 Task G1-1 的校验结果做"用户已编辑数据不丢失"的最小验证
- 涉及文件：`src/renderer-dialogs.js`
- 操作：
  - 手动或用临时测试数据检查：校验失败、点"确认"、重开 `createMappingDialog(payload)` 后，字段下拉选项、大账号列表、已配置的固定字段是否恢复到本次打开时的初始状态（payload 快照语义）。
  - 如果发现 `currentBigAccounts` 等 let 变量的本轮增量修改会丢失，记录到 `log.md`，不在本 task 内修复（避免越界），由 PM 判断是否开 follow-up。
- 验证：观察重开对话框后的字段状态；记录结论。
- 状态：done（2026-04-16；代码阅读结论见 `log.md`，GUI 实测交 QA 阶段）

---

## G3 — 需求 3：按文件名映射模板（中等风险组）

### Task G3-0（前置 — 决策 ④ 落地）🔴 必须最先完成
- 目标：统一加 `isFilenameMappingMode()` helper + 按清单覆盖所有虚拟 ID 调用点，避免"哪里出错哪里补 if"。
- 涉及文件：`src/main.js`、`src/renderer.js`、`src/renderer-dialogs.js`
- 操作：
  1. 定义共享常量 `const FILENAME_MAPPING_TEMPLATE_ID = '__FILENAME_MAPPING__'` 和 helper `function isFilenameMappingMode(templateId) { return templateId === FILENAME_MAPPING_TEMPLATE_ID; }`。helper 可同名在 main/renderer 两端各自声明（两端都不依赖对方导入），但**常量字符串必须一致**。
  2. 按 TechDoc §5.1.0 清单**逐项**短路（此时本需求的功能代码尚未落，本 task 先把短路分支加上，任何调用点返回"虚拟 ID 下 noop/disabled"即可）：
     - `file:import` handler 顶部：`if (isFilenameMappingMode(templateId)) return { status: 'error', message: '功能暂未实现', errorCode: 'NOT_IMPLEMENTED' }`（占位，G3-7 再改为真正处理）
     - `getTemplateMappingConfig(templateId)` 的所有调用者：进入前判断，虚拟 ID 下**不**调用该函数
     - `state.selectedTemplateId` 用于 `accountMappings.list(templateId)` / `bigAccount.loadMode(templateId)` 等 preload API 的地方：虚拟 ID 下跳过 IPC 或传 `null` 替代
     - `state.templates.find((t) => String(t.id) === previous)` 类 ID 查表：先 `if (isFilenameMappingMode(previous)) return null`
     - `setExportAvailability` 在虚拟 ID 下始终 disable（G3-5 会复用）
     - 其他按 ID 查真实模板的位置，`grep` 搜 `state.selectedTemplateId` / `templates.find` / `templateId` 逐一梳理
  3. 短路后的行为要求：主页面即使手动把 `state.selectedTemplateId` 设为 `__FILENAME_MAPPING__`（通过 devtools 临时赋值），所有 IPC 不应崩溃、不应报 `TEMPLATE_NOT_FOUND` 以外的错误
- 验证：
  - `grep -nE "state\.selectedTemplateId|getTemplateMappingConfig|templates\.find" src/` 审查结果：所有按 ID 进入查表前都能命中 helper 判定
  - devtools 把 `state.selectedTemplateId = '__FILENAME_MAPPING__'`，调用 `desktopApi.files.importFile(state.selectedTemplateId)` 返回占位 `NOT_IMPLEMENTED` 错误（不是 `TEMPLATE_NOT_FOUND` 或未捕获异常）
  - v1.5.1 已有功能（真实 templateId 导入、模板管理、账户映射）回归通过 `npm run smoke`
- 状态：done（2026-04-16；`src/main.js:120-125` 与 `src/renderer.js:25-30` 双端定义常量 + helper；`getTemplateMappingConfig` 首行防御；`file:import` handler 顶部占位返 `NOT_IMPLEMENTED`；`updateTemplateSelect` 查表前判虚拟 ID；`handleImportFile` 原样透传；`handleOpenAccountMappings` 回落真实模板。smoke 通过）

### Task G3-1
- 目标：数据库迁移 — `templates` 表新增 `filename_fixed_field` 列
- 涉及文件：`src/backend/database/migrations.js`、`src/backend/database.js`
- 操作：
  - `migrations.js` 追加 `ensureTemplateFilenameFixedFieldSupport(db)`：`if (!hasColumn(db,'templates','filename_fixed_field')) db.exec("ALTER TABLE templates ADD COLUMN filename_fixed_field TEXT NOT NULL DEFAULT ''")`；
  - `exports` 追加；
  - `database.js:92` 附近注册 `this.ensureTemplateFilenameFixedFieldSupport()`，紧跟 `ensureParentTemplateSupport`。
- 验证：
  - 删库后启动 `npm start` 无报错；
  - DB 工具查 `PRAGMA table_info(templates)` 含新列；
  - 已有库重启后同样结果（幂等）。
- 状态：done（2026-04-16；`migrations.js:291` 新增函数 + exports；`database.js:103` 在 `ensureParentTemplateSupport` 之后注册。独立 node 脚本验证：新库含列、重启幂等、null 兜底为空串）

### Task G3-2
- 目标：Repository / utils 层暴露 `filenameFixedField` + 提供 `saveTemplateFilenameFixedField`
- 涉及文件：`src/backend/database/template-repository.js`、`utils.js`、`database.js`、`src/main.js`（Bundle 读写）
- 操作：
  - `template-repository.js`:
    - `listTemplates` / `getTemplate` / `getTemplateByKey` / `getTemplateByName` / `listChildTemplates` 的 SELECT 追加 `t.filename_fixed_field AS filenameFixedField`；
    - 新增 `saveTemplateFilenameFixedField(db, templateId, value)`；
    - `listTemplateBundleEntries` 返回对象追加 `filenameFixedField: template.filenameFixedField || ''`；
    - 模块 exports 追加。
  - `utils.js:86` `buildTemplateSummaryFromRow` 返回值追加 `filenameFixedField: normalizeText(row.filenameFixedField)`。
  - `database.js` 透传 `saveTemplateFilenameFixedField(templateId, value)`。
  - `main.js:1215` `readTemplateBundleFile` 解析结果追加 `filenameFixedField: normalizeCell(item.filenameFixedField) || ''`；`:3805` bundle 导入循环内对每个 entry 调用 `database.saveTemplateFilenameFixedField(template.id, entry.filenameFixedField)`。
- 验证：
  - devtools 调用 `window.desktopApi.templates.list()` 返回数组每项含 `filenameFixedField`；
  - 在 `template-repository.js` 临时加 `console.log` 或手动查库确认写入。
- 状态：done（2026-04-16；`template-repository.js` 3 个 SELECT 加字段 + 新增 `saveTemplateFilenameFixedField` + bundle entry 追加 + exports；`getTemplateByKey/Name` 内部调 `getTemplate` 无需修改；`utils.js` summary 追加；`database.js` 透传；`main.js:1241` bundle 解析 + `:3900` 导入循环写入。node 脚本验证 list/get/bundle entry 均返回该字段）

### Task G3-3
- 目标：IPC + preload 暴露 `saveFilenameFixedField`
- 涉及文件：`src/main.js`、`src/preload.js`
- 操作：
  - `main.js` 新增 `ipcMain.handle('template:save-filename-fixed-field', (_e, payload) => { ... })`，payload = `{templateId, value}`，内部调用 `database.saveTemplateFilenameFixedField(Number(payload.templateId), String(payload.value ?? ''))`，返回 `{status:'success'}`。
  - `preload.js:33` 的 `templates` 对象追加 `saveFilenameFixedField: (p) => ipcRenderer.invoke('template:save-filename-fixed-field', p)`。
- 验证：devtools 调用 `window.desktopApi.templates.saveFilenameFixedField({templateId:1,value:'中行001'})` 返回 success；再 `.list()` 查看值。
- 状态：done（2026-04-16；`main.js:3716` IPC handler（含 templateId 合法性校验、sync bundle library 文件、错误码 `TEMPLATE_ID_INVALID` / `TEMPLATE_FILENAME_FIXED_FIELD_SAVE_FAILED`）；`preload.js:42` 透传 API。GUI devtools 验证交下一轮手动测试）

### Task G3-4
- 目标：映射关系管理页面新增「按文件名映射模板」模块
- 涉及文件：`src/renderer-dialogs.js`、`src/styles.css`
- 操作：
  - 在 `createMappingDialog` 中 `payload.targetFields.forEach(...)` 之前（即"映射关系设置" section 上方）插入一个 `<tr class="mapping-section-row mapping-filename-fixed-row">`，内含 `<strong>按文件名映射模板</strong>`、`<label>`、`<input>`、`<button>`；
  - 初始态：若模板已有 `filenameFixedField` 则 input `readOnly` + 按钮"编辑"（`data-mode="readonly"`）；否则 input 可编辑 + 按钮"完成"（`data-mode="edit"`）；
  - 按钮 click：`edit → readonly`（调用 `saveFilenameFixedField` 然后切态）；`readonly → edit`（切态允许编辑）；
  - CSS：`.mapping-filename-fixed-btn { min-width: 120px }` 与 `.mapping-big-account-manage-btn` 一致；`.mapping-filename-fixed-input { width: 220px }`。
- 验证：
  - AC3-2：可见模块；
  - AC3-3：输入并点"完成"后 input 变只读、按钮变"编辑"；DB 值正确；
  - AC3-4：重新打开同模板，上次保存的值展示，按钮为"编辑"。
- 状态：done（2026-04-16；`src/renderer-dialogs.js:1979-2045` 新增模块 + 状态机；`src/styles.css:1607-1626` 新增 CSS；`src/main.js:buildTemplateSummary` 补透传 `filenameFixedField` 使 `template:get-mappings` 返回含新字段——否则 AC3-4 无法回显。smoke 通过）

### Task G3-5
- 目标：主页面模板下拉新增「按文件名映射模板」并设为默认值
- 涉及文件：`src/renderer.js`
- 操作：
  - `updateTemplateSelect`（`:1611`）placeholder 替换为 `<option value="__FILENAME_MAPPING__">按文件名映射模板</option>`（置顶）；
  - 默认选中逻辑改为：若 `previous` 是合法 template id 或 `__FILENAME_MAPPING__` 则保持；否则默认 `__FILENAME_MAPPING__`；
  - `state.selectedTemplateId` 为 `__FILENAME_MAPPING__` 时 `setExportAvailability({detailEnabled:false, balanceEnabled:false})`。
  - 复用 G3-0 的 `isFilenameMappingMode()` helper 判断虚拟 ID。
- 验证：AC3-1 / P1-9：启动后默认值正确；切换到其他模板再切回也正常。
- 状态：done（2026-04-16；`src/renderer.js:1617-1651` `updateTemplateSelect` 下拉顶部插入 `<option value="__FILENAME_MAPPING__">按文件名映射模板</option>`，默认选中逻辑改为 fallback 到虚拟 ID；`setExportAvailability` 虚拟 ID 下禁用。smoke 通过）

### Task G3-6
- 目标：Bundle v4 透明扩展 `filenameFixedField` 字段
- 涉及文件：`src/main.js`
- 操作：
  - `buildTemplateLibraryPayload`（`:1150`）确保 entry 带 `filenameFixedField`（由 Repository 透传，本 task 只需要验证）；
  - `readTemplateBundleFile`（`:1191`）解析已在 G3-2 添加；本 task 验证 v4 bundle 向下兼容（v1.5.1 导入不报错）。
- 验证：P1-7（导出/导入往返）/ P1-8（老 bundle 无字段兼容）。
- 状态：done（2026-04-16；`src/main.js:119-123` 增加 `SUPPORTED_BUNDLE_VERSION = 4` 的 v4 透明扩展注释；验证 G3-2 的透传链路已全部就位：`buildTemplateLibraryPayload → listTemplateBundleEntries` 带 `filenameFixedField`（`template-repository.js:856`）、`readTemplateBundleFile:1242` 对无字段 v4 bundle fallback 为空串、bundle 导入循环 `main.js:3901` 写入 DB。独立 node 脚本验证 P1-7 / P1-8 两个场景全部通过）

### Task G3-7
- 目标：后端 `file:import` 新增 `__FILENAME_MAPPING__` 分支 + 整批截断（替换 G3-0 的占位）
- 涉及文件：`src/main.js`
- 操作：
  - `file:import` handler（`:5898`）顶部（已有 G3-0 的占位分支）改为 `if (isFilenameMappingMode(templateId)) return handleFilenameMappingImport()`；
  - 新增 `handleFilenameMappingImport()`（按 TechDoc §5.1.6 骨架）：
    1. `fileImportInProgress` / `ENUM_MISSING` / `account_mapping_migration_pending` 三个守卫同旧分支；
    2. `dialog.showOpenDialog` 取文件；
    3. 拉 `database.listTemplates()` 过滤 `filenameFixedField.length > 0` 得到 `eligibleTemplates`；
    4. 遍历文件：`basename.includes(t.filenameFixedField)` 得 `candidates`；0 或 >=2 → 对应 errorCode 整批截断；
    5. 唯一命中后对每个文件调 `matchesTemplateHeaders(filePath, matchedTemplate)`；任一失败 → `FILENAME_MAPPING_HEADER_MISMATCH` 整批截断；
    6. 按每文件的 `matchedTemplate` 独立 `getTemplateMappingConfig(matchedTemplate.id)` → 构造 `parentProvisionalEntries`（逻辑参考 `main.js:6011-6066`）；
    7. 聚合 bigAccounts（若命中的是子模板，向上找主模板也聚合进来 —— 复用 v1.5.1 `aggregatedBigAccounts` 思路）；
    8. 后续 `bigAccountOptions` / `rememberPendingBigAccountSelection` / 大账号选择流程沿用现有 `:6070-6480` 标准流程。
  - 新增 `matchesTemplateHeaders(filePath, template)` 工具函数（`readRowsWithMetadata` + 捕获 `FileValidationError message.includes('表头')` 返 false）。
- 验证：
  - AC3-5 / AC3-6 / AC3-7 / AC3-8 全部通过；
  - P0-7 ~ P0-10 按 PRD 表格逐一跑通；
  - 报错后重复导入同样触发同样报错（session 无残留、`fileImportInProgress` 正确释放）。
- 状态：done（2026-04-16；`src/main.js:5949-5961` 新增 `matchesTemplateHeaders`；`:5967-6309` 新增 `handleFilenameMappingImport`；`:6315-6317` 替换 G3-0 占位；smoke 通过；节点脚本验证 matchesTemplateHeaders 四种场景 + 文件名匹配 0/1/2 分支）

---

## G2 — 需求 2：大账号确认页 M:1 映射（最高风险组，最后做）

### Task G2-0（前置 — 决策 ② 落地）🔴 必须最先完成
- 目标：排查「主模板多文件」分支（`parentProvisionalEntries`）与 M:1 映射的兼容性；确保 block 粒度展开不破坏每文件独立 `matchedTemplateId`。
- 涉及文件：**只读排查**，不改产品代码；若需验证性脚本放 `scripts/` 下
- 操作：
  1. 通读 `src/main.js:6009-6066` 主模板分支，确认 `parentProvisionalEntries[i]` 每项含 `matchedTemplateId` / `matchedHeaders` / `selfInputMerchant` / `skipDirectMerchantLookup` 字段；
  2. 通读 `src/main.js:881-945` `applyBigAccountAssignmentsToFileEntries`，确认其只改写 `MerchantId` / `Currency` 两个字段，**不**读也不写 `matchedTemplateId`；
  3. 通读 `src/main.js:6633-6801` `file:complete-big-account-selection`，确认 `pendingContext.fileEntries` 的 `matchedTemplateId` 在 `applyBigAccountAssignmentsToFileEntries` 前后保持一致（`resolvedFileEntries = applyBigAccountAssignmentsToFileEntries(pendingContext.fileEntries, ...)`；后续 `resolveGenerationTemplateConfig({ fileEntries: resolvedFileEntries, fallbackTemplateConfig })` 仍能正确用 matchedTemplateId 挑配置）；
  4. 确认 M:1 在 block 粒度展开后（key = `rowIndex`）不会让某个 block 被"错配到另一文件的模板配置"——因为 `rowIndex` 到 `(filePath, block)` 的映射关系由 `buildBigAccountSelectionRows` 决定，与 matchedTemplateId 解耦；
  5. 把结论写入 `changes/v1.5.2/log.md`：
     - 若 4 步验证全通过 → 记录 "兼容性无问题，可继续 G2-1"；
     - 若发现任何破坏 matchedTemplateId 的路径 → **停下来找 PM**，不自作主张改方案（见 CLAUDE.md 全局规则 "Spec is Truth"）。
- 验证：`log.md` 里有签字条（"已阅读 main.js:6009-6066 / :881-945 / :6633-6801"）+ 明确结论 + 可复现的示例（任选 v1.5.1 P0-3 / P0-4 场景在本地跑一遍）。
- 状态：done（2026-04-16；只读排查结论见 `log.md`：`applyBigAccountAssignmentsToFileEntries` 不触碰 `matchedTemplateId`；rowIndex→（filePath,block）映射与 matchedTemplateId 解耦；block 粒度展开后 `resolveGenerationTemplateConfig` 仍按 matchedTemplateId 挑 config。兼容性无问题，可继续 G2-1）

### Task G2-1
- 目标：`buildBigAccountSelectionRows` 每行追加 `fileIndex` 字段（可视化辅助，非状态机 key）
- 涉及文件：`src/main.js`（`:857`）
- 操作：
  - `fileEntries.forEach((entry, fileIndex) => { blocks.forEach((block) => { rows.push({ index:rowIndex, fileIndex, ...原字段 }) }) })`；
  - 无其他调用方依赖原结构，但保险起见全局搜索 `.index` / `.fileName` 确认。
  - **注意（Reverse Sync 修订）**：`fileIndex` 只作为"同文件 block 折叠/可视化分组"的辅助字段，**不**作为 M:1 状态机的 key；状态机 key 统一使用 `rows[i].index`（即后端 `rowIndex`），见 G2-3 / G2-5。
- 验证：
  - 打开大账号确认页、在 devtools 查看 `rows[i].fileIndex` 非 undefined；
  - v1.5.1 的旧 UI 行为无感知（数字序号、勾选、完成均正常）。
- 状态：done（2026-04-16；`src/main.js:867-891` 每 row 追加 `fileIndex`；smoke 通过；未触碰调用点结构）

### Task G2-2
- 目标：大账号确认对话框 footer 新增多对一工具条 + 编辑/完成按钮（默认态 UI 就位）
- 涉及文件：`src/renderer-dialogs.js`（`:605-614`）、`src/styles.css`
- 操作：
  - 在 `extract-order-btn` 右侧插入：
    ```
    <label><input type="checkbox" class="ba-multi-mode-checkbox" checked> 单个账号匹多个文件</label>
    <button class="secondary-btn small ba-multi-edit-btn">编辑</button>
    <button class="secondary-btn small ba-multi-done-btn">完成</button>
    ```
  - 默认勾选；默认编辑态（"编辑"按钮激活样式、"完成"按钮非激活）；
  - CSS：与现有 `.big-account-selection-footer` 对齐；新加 `.big-account-order-index--alpha` 供字母序号使用。
- 验证：AC2-1 外观通过（`npm run preview` 截图比对）。
- 状态：done（2026-04-16；`src/renderer-dialogs.js:610-616` footer 插入 3 元素 + `:637-639` DOM 引用；默认 multiModeCheckbox.checked=true、multiEditBtn 激活、multiDoneBtn disabled；`src/styles.css:1230-1279` 新增 5 类 CSS；smoke 通过）

### Task G2-3
- 目标：左右勾选联动的状态机实现（**block 粒度**；决策 ①B）
- 涉及文件：`src/renderer-dialogs.js`
- 操作：
  - 新增 4 个 let 变量（TechDoc §4.1.2）：
    - `multiMode`（boolean）、`multiEditing`（boolean）、`pendingGroup`（null 或 `{leftBlockRowIndices:[], rightAccount:null, startedBy:'left'|'right'}`）、`multiGroups`（`[{leftBlockRowIndices:number[], rightAccount:{merchantId,currency}}]`）；
    - **字段命名关键点**：`leftBlockRowIndices` 存储的是 `currentFileRows[i].index`（即后端 `rowIndex`），**不是** `fileIndex`；
  - 改 `renderFileList`：若 `multiMode && multiEditing` 在**每 block 条目**首位渲染 `<input type="checkbox" class="ba-left-block-checkbox">`（保留每 block 一行的现有视觉结构，不按文件折叠），否则保留原数字序号；
  - 改 `renderOrderList` / `syncOrderIndices`：在字母态下渲染 `a.b.c...`；
  - 新增 `onLeftBlockChecked(rowIndex, checked)` / `onRightAccountChecked` / `renderAlphaIndex` / `closeGroup`（按 TechDoc §4.1.2 伪码）；
  - "编辑"按钮 click → 清空 pendingGroup、设 multiEditing=true、重新分配字母（决策 D3）；
  - "完成"按钮 click → 闭合 pendingGroup（有效时）、multiEditing=false、隐藏字母 + 勾选框；
  - "单个账号匹多个文件"勾选框取消 → 清空 multiGroups + pendingGroup、回旧 UI；
  - `rememberCheckbox` 与 `ba-multi-mode-checkbox` 互斥（`disabled` listener）。
- 验证：AC2-2 ~ AC2-8、AC2-10、AC2-12、P1-2 ~ P1-4 通过；**重点跑 P0-12（同文件多 block 独立归组）**。
- 状态：done（2026-04-16；`src/renderer-dialogs.js:640-657` 4 个 let 变量 + `:671-711` renderFileList 3 分支 + `:723-739` renderOrderList checkbox change 分流 + `:755-799` syncOrderIndices/Disabled 多模式分支 + `:800-978` 状态机 helpers + `:1121-1186` 事件监听。smoke 通过）

### Task G2-4
- 目标：取消勾选/回滚边界 + 固定模式互斥
- 涉及文件：`src/renderer-dialogs.js`
- 操作：
  - 在 G2-3 状态机基础上打磨边界：
    - 编辑态取消左侧 block 勾选 → 从 `pendingGroup.leftBlockRowIndices` 或已闭合组的对应数组移除，若组因此变空则整组移除；
    - 取消"单个账号匹多个文件"勾选框 → 清空 multiGroups + pendingGroup，恢复旧数字序号 UI；
    - `rememberCheckbox` 与 `ba-multi-mode-checkbox` 绑定 `change` listener 实现互斥 `disabled`。
- 验证：P1-3 / P1-4 通过；AC2-8 / AC2-10 通过。
- 状态：done（2026-04-16；onLeftBlockChecked 取消分支已在 G2-3 一并实现；multiModeCheckbox.change 清空 multiGroups/pendingGroup/checkedOrder；syncMultiModeMutualDisabled 实现双向 disabled；syncModeUI 追加 multiGroups/pendingGroup 清空防 fixed↔unfixed 切换 rowIndex 空间不对齐）

### Task G2-5
- 目标：对话框主"完成"按钮按 block 粒度展开 assignments（key = `rowIndex`）
- 涉及文件：`src/renderer-dialogs.js`（`:1105`）
- 操作：
  - 主 `doneBtn` handler 中构造 `finalAssignments`（TechDoc §4.1.3 伪码）：
    1. 先展开 multiGroups：**每被勾选的 block 产生一条 assignment**，key = `rowIndex`（即 `leftBlockRowIndices[i]`），value = 组绑定的 `merchantId/currency`；
    2. 构造 `coveredRowIndices` 集合，避免同一 rowIndex 被 1:1 剩余再写一次；
    3. 追加 `checkedOrder` 中未入组的 block（按 `currentFileRows[idx].index` 判断是否已被覆盖）；
  - 按 `rowIndex` 排序；长度校验 `=== currentFileRows.length`；
  - 调 `desktopApi.files.completeBigAccountSelection({ assignments: finalAssignments, mode: currentMode })`；
  - 错误码 `BIG_ACCOUNT_SELECTION_INVALID` 处理同现有。
- 验证：
  - AC2-9 / AC2-11 / AC2-12 / P0-4 / P0-5 / P0-6 / **P0-12** 通过；
  - P1-5：覆盖不全时沿用原错误提示；
  - 多账号导出 Excel 数据正确（MerchantId / Currency 与**被勾选 block**绑定的大账号一致；同文件未勾选 block 保持原值）。
- 状态：done（2026-04-16；主 doneBtn handler 重写：multiMode=true 时展开 multiGroups → coveredRowIndices → checkedOrder 补齐 1:1 → 按 rowIndex 升序；multiMode=false 时沿用 v1.5.1；长度校验 `=== currentFileRows.length` 保留；错误码 `BIG_ACCOUNT_SELECTION_INVALID` 处理不变；smoke 通过）

---

## 收尾 Task（版本号 + 文档三件套）

### Task Z-1
- 目标：版本号升级 1.5.1 → 1.5.2
- 涉及文件：`package.json`
- 操作：`"version": "1.5.2"`
- 验证：启动后"关于"弹窗显示新版本号；bundle 导出文件 `bundleVersion` 仍为 4（透明扩展策略）
- 状态：done（2026-04-16；`package.json:3` `"version": "1.5.2"`；`npm run smoke` 输出 `bank-bill-excel-tool@1.5.2 smoke` + `smoke test passed`；`SUPPORTED_BUNDLE_VERSION = 4` 保持不变（决策 ③A））

### Task Z-2
- 目标：文档三件套统一更新
- 涉及文件：`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`
- 操作：
  - `CHANGELOG.md` 新增 `## 1.5.2 - 2026-04-16` 节 + 3 项需求 + 「变更」section（透明扩展、IPC、helper）；
  - `VERSION_FEATURE_HISTORY.md` 新增 `## 1.5.2` 节，按 `新增 / 变更 / 移除` 三组分；
  - `USER_GUIDE.md` 顶部版本号 → v1.5.2；主要功能列表追加 3 条 v1.5.2 项；「修改模板 - 字段介绍」补充「按文件名映射模板」模块说明；Q&A 新增 17/18/19 三组（按文件名映射、单账号匹多文件、主子模板名校验）。
- 验证：`git diff --stat` → CHANGELOG +15、USER_GUIDE +60、VERSION_FEATURE_HISTORY +21、package.json ±1；smoke 通过；4 个文件版本号一致 = 1.5.2。
- 状态：done（2026-04-16；详见 log.md "2026-04-16 Dev — 收尾 Z-1 / Z-2"）

---

## 依赖关系

```
G1-1 → G1-2  (独立组)

G3-0 (前置 — 决策 ④)
  → G3-1 → G3-2 → G3-3 → G3-4
                        → G3-5
                        → G3-6
                        → G3-7  (替换 G3-0 的占位)

G2-0 (前置 — 决策 ②；只读排查)
  → G2-1 → G2-2 → G2-3 → G2-4 → G2-5

Z-1 (独立，任何时候)
Z-2 (最后)
```

**关键约束**：
- G3-0 必须先于 G3-1~G3-7 完成（所有虚拟 ID 短路一次性就位，避免后续 task 发现散点问题）
- G2-0 必须先于 G2-1~G2-5 完成（排查结论可能触发回 PM，提前暴露风险）
- G1 / G3 / G2 三组彼此独立，可按风险序串行
- 组内按箭头顺序执行

**Task 数量变化**：原 15 → 17（新增 G2-0、G3-0 两个前置 task；G3 原 G3-1~G3-6 重编号为 G3-1~G3-7（原 G3-5 `Bundle 透传` 拆为 G3-6 独立验收；原 G3-6 `file:import 分支` 变 G3-7；G2 原 G2-1~G2-4 重编号为 G2-1~G2-5（新增 G2-4 边界打磨独立成 task））
