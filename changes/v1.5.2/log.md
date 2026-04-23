# Log — v1.5.2

## 2026-04-16 Dev — G1 完成（需求 1：主/子模板名校验）

### G1-1 — 前置校验落地
- 动作：在 `src/renderer-dialogs.js:2542` `doneBtn.click` handler 顶部新增 15 行前置校验（行 2543-2558）。
  - 触发条件：`isChildCheckbox.checked && parentSelect.value` 同时成立才校验，否则跳过（AC1-4 / P1-1）。
  - 校验：`当前模板名.includes(主模板名)`，不含即弹 `createAlertDialog('子模板与主模板模板名匹配不上，请检查。', { onConfirm: () => openModal(createMappingDialog(payload)) })` 并 `return`，阻断 saveMappings / setParentStatus / setChildParent。
  - 通过即 fall-through 到原有 `saveMappings(draftMappings)` 流程，不改任何已有调用。
- 证据：
  - `npm run smoke` → `smoke test passed`（v1.5.1 回归无影响）。
  - 改动行数 15 行（≤20 行上限），只动 1 个文件（`src/renderer-dialogs.js`）。
  - 代码现状与 TechDoc §3.1 伪码一致：`isChildCheckbox`（:1913）/ `parentSelect`（:1915）/ `state.templates`（:1918）/ `payload.template.name`（:2186 同一 scope 用过）/ `createAlertDialog({onConfirm})`（:67-84）/ `openModal(createMappingDialog(payload))`（:2500-2508 同一 scope 用过）。
- 风险：低。纯前端逻辑前置拦截，后端 IPC / DB 零改动。
- 决策：D1 = `子名.includes(主名)`，区分大小写、含相等、不做空格/大小写归一化。

### G1-2 — 代码阅读结论（GUI 实测待 QA）
- 动作：阅读 `createMappingDialog(payload)`（:1835-）各 let 变量初始化：
  - `currentBigAccounts`（:1846）：`cloneBigAccountItems(payload.bigAccounts || [])`
  - `currentFixedAssignments`（:1847）：从 `payload.fixedAssignments` 深拷贝
  - `currentAmountSplitRules`（:1854）、`currentBillSplitMappings`（:1863）、`currentBillSplitRows`（:1871）、`currentBillSplitAmountRules`（:1874）、`currentBillSplitMeta`（:1877）：全部基于 `payload.xxx` 初始化
- 结论：
  - **重开对话框后的字段状态 = 本次打开对话框时 `payload` 的状态**，不会读取外部 state，payload 快照语义成立。
  - **但存在"本轮增量修改丢失"**的语义：用户在校验失败前对"映射字段表"（tbody 下拉）、`currentBigAccounts`（通过"维护大账号"对话框新增/删除）、`currentFixedAssignments` 的本会话编辑，在我们仅 `openModal(createMappingDialog(payload))` 的实现下**会丢失**——因为 `payload` 是不变引用，我们没有像 `saveMappings` 失败分支（:2614-2624）那样把 `draftMappings`/`draftBigAccounts`/`currentFixedAssignments`/`currentAmountSplitRules` 透传回 payload。
  - TechDoc §3.3 已提示："最小改动建议保持现状（用户点确认后回到原始数据），实际测试后再视需要改进"。
- 待 QA 阶段 GUI 实测的点：
  - 场景：勾"设为子模板"+ 选主模板 → 本会话内修改某个字段映射或增加一个大账号 → 点完成触发校验失败 → 提醒框确认 → 重开对话框 → 观察修改是否还在。
  - 预期（按本实现）：修改不在，恢复到本次打开时的 payload 快照。
  - 如果 QA / PM 认为应该保留本轮编辑，可 follow-up 改为"透传 draftMappings/draftBigAccounts/currentFixedAssignments/currentAmountSplitRules"（参考 :2614-2624 saveMappings 失败回调的构造方式），本 task 不做。
- 风险：中。此丢失只出现在"校验失败→重开"路径；正常 save 成功不受影响；与 saveMappings 失败路径（已有的 v1.5.1 行为）对比，saveMappings 失败会保留 draft，而本校验失败不保留——**行为不一致**是一个值得 PM 复核的点，但按 task 约束不在本轮修复。
- 决策：按 TechDoc §3.3 "保持现状"，等 QA 反馈后再决定。

## 2026-04-16 Dev — G3 第一批 4 个 task（G3-0 / G3-1 / G3-2 / G3-3）

### 改动文件清单（按文件 diff 行数）

| 文件 | +行数 | -行数 | 说明 |
|------|------:|------:|------|
| `src/backend/database/migrations.js` | +9 | 0 | 新增 `ensureTemplateFilenameFixedFieldSupport` + exports |
| `src/backend/database.js` | +11 | 0 | 引入迁移函数 + 注册 + 透传 `saveTemplateFilenameFixedField` |
| `src/backend/database/template-repository.js` | +15 | 0 | 3 个 SELECT 补字段 + 新增 save 方法 + bundle entry 追加字段 + exports |
| `src/backend/database/utils.js` | +3 | -1 | `buildTemplateSummaryFromRow` 返回值追加 `filenameFixedField` |
| `src/main.js` | +54 | -1 | 常量/helper + `getTemplateMappingConfig` 防御 + IPC handler + bundle 读写透传 + `file:import` 占位短路 |
| `src/preload.js` | +1 | 0 | 追加 `saveFilenameFixedField` API |
| `src/renderer.js` | +18 | -3 | 常量/helper + `updateTemplateSelect` 查表防御 + `handleImportFile` 透传 + `handleOpenAccountMappings` 回落 |

本批总计 7 个文件、约 +111 / -5 行，符合"≤7 文件 + 小批次"约束。

### G3-0 短路清单对齐 TechDoc §5.1.0

| TechDoc §5.1.0 清单项 | 本批落地位置 |
|----------------------|-------------|
| `file:import` handler 顶部短路（占位，G3-7 替换） | `src/main.js:5943` 占位分支返 `NOT_IMPLEMENTED` |
| `getTemplateMappingConfig` 调用者防御 | `src/main.js:1751` 函数首行 `if (isFilenameMappingMode(templateId)) return null` 一次覆盖 5 个调用点（`:592 / :611 / :3465 / :5567 / :6016`） |
| `state.selectedTemplateId` 用于 `accountMappings.list` 等 preload API | `src/renderer.js:2617` `handleOpenAccountMappings` 回落真实模板 |
| `state.templates.find((t) => String(t.id) === previous)` 类 ID 查表 | `src/renderer.js:1636-1639` `updateTemplateSelect` 查表前 `isFilenameMappingMode(previous) ? null : ...` |
| `setExportAvailability` 虚拟 ID 下 disable | `src/renderer.js:1645` 原逻辑 `!state.selectedTemplateId` 即 disable；本批 `preserved` 为 null 时 selectedTemplateId 会被清空，功能复用；G3-5 再补显式分支 |
| 主页面「导入模板包」自动选中 | 现状 `updateTemplateSelect` 通过 `preserved` 保持/回落，虚拟 ID 场景 G3-5 专门处理 |

`src/renderer-dialogs.js` 中不持有 `state.selectedTemplateId`，对话框 `templateId` 都来自 `state.templates` 列表（真实模板）或 `payload.currentTemplateId`（由 renderer 回落保证），本批无需改动。

### 关键实现决策

1. **helper 选择"在 `getTemplateMappingConfig` 内防御"而非"所有外层调用点加 if"**：减少重复判断、避免散点逻辑。外层只在 `file:import` handler 入口分派（为 G3-7 预留），其余调用者通过函数内防御统一短路。
2. **虚拟 ID 原样透传 IPC**：`handleImportFile` 对虚拟 ID 不做 `Number()` 转换（否则 NaN 会丢失字符串信息），后端 `isFilenameMappingMode(templateId)` 能继续命中。
3. **IPC handler 做合法性校验**：`template:save-filename-fixed-field` 校验 `Number.isFinite(templateId) && templateId > 0`，避免误传虚拟 ID 导致静默写入 0/NaN 行。
4. **sync bundle library 文件**：IPC 保存后调 `syncTemplateLibraryFile()`，与 saveMappings/rename 的行为一致，保持 `Documents/.../template-library.json` 与 DB 同步。

### 验证证据

**smoke**：
```
> node scripts/smoke-test.js
smoke test passed
```

**独立 node 脚本验证（替代 devtools，场景等价）**：
```
[验证1] templates 表含 filename_fixed_field 列： true
[验证2] listTemplates 返回字段（第一项含 filenameFixedField）： true value: ""
[验证3] saveTemplateFilenameFixedField 后 list 读到的值： "中行001"
[验证4] getTemplate 返回值中 filenameFixedField： "中行001"
[验证5] 幂等：重启后 filename_fixed_field 列数量： 1
[验证5] 重启后 filenameFixedField 还在： "中行001"
[验证6] 保存空串后： ""
[验证7] 保存 null 后（应转为空串）： ""
[验证8] bundle entry 含 filenameFixedField： true value: "bundle测试"
```

**helper 判定验证**：
- `isFilenameMappingMode('__FILENAME_MAPPING__')` = true
- 其他类型（Number、NaN、null、''、undefined、'1'）全 false

**语法检查**：所有 7 个改动文件 `node --check` 通过。

**改动文件数**：7（未超约束上限）。未触碰 G3-4 ~ G3-7 的范围（`createMappingDialog` / 下拉菜单 / 默认值 / `handleFilenameMappingImport`）。

### 未发现与 TechDoc 冲突项
TechDoc §5.1.0 / §5.1.1 / §5.1.2 / §5.1.3 描述的行号、函数名、短路清单与现有代码全部对得上（`database.js:92` 附近、`utils.js:86`、`main.js:1215 / 3805 / 5898`、`preload.js:33`）。

### GUI / devtools 验证待用户手动确认项

smoke 与 node 脚本已覆盖后端 + 数据层；以下 3 项建议在用户启动 `npm start` 后在 devtools 验证（node 环境下无 Electron window）：
1. `window.desktopApi.templates.list()` 每项含 `filenameFixedField`
2. `window.desktopApi.templates.saveFilenameFixedField({templateId:<真实id>, value:'测试'})` 返回 `{status:'success'}`；再 `.list()` 看到值
3. 把 `state.selectedTemplateId = '__FILENAME_MAPPING__'` 后点"导入网银明细文件"，应弹 status 非 `TEMPLATE_NOT_FOUND` 而是 `NOT_IMPLEMENTED`（或 renderer 侧 fallback 文案）

## 2026-04-16 Dev — G3 第二批 3 个 task（G3-4 / G3-5 / G3-6）

### 改动文件清单（本批 diff 行数）

| 文件 | 改动 | 说明 |
|------|-----|------|
| `src/renderer-dialogs.js` | +67 / -0 | `createMappingDialog` 插入「按文件名映射模板」模块 + 状态机（G3-4） |
| `src/styles.css` | +20 / -0 | 新增 4 个 class（`.mapping-filename-fixed-wrap/label/input/btn`）对齐「维护大账号」按钮风格（G3-4） |
| `src/renderer.js` | +14 / -8 | `updateTemplateSelect` 替换 placeholder 为虚拟 ID option + 默认值改为虚拟 ID + 虚拟 ID 下 disable 导出（G3-5） |
| `src/main.js` | +6 / -0 | `SUPPORTED_BUNDLE_VERSION=4` 上方增加 v4 透明扩展注释（G3-6）+ `buildTemplateSummary` 透传 `filenameFixedField` 供 G3-4 对话框回显（AC3-4 必要改动） |

本批总计 4 个文件、约 +107 / -8 行，符合"≤4 文件 + 小批次"约束。

### 关键实现决策

1. **G3-4 状态机打磨**（超出 TechDoc §5.1.5 伪码的工程性增强）：
   - `filenameFixedBtn.disabled = true/false` 包住 IPC 调用，防止双击触发重复保存；
   - IPC 返回 `status:'error'` 时弹 `createAlertDialog` 保留编辑态，不切到只读；
   - 保存成功后**同时**更新 `payload.template.filenameFixedField`（避免同一对话框会话中后续校验失败→重开时回显旧值）。
2. **G3-4 必需补丁**（TechDoc 遗漏项）：`src/main.js:buildTemplateSummary`（v1.5.1 老函数）未透传 `filenameFixedField`，导致 `template:get-mappings` 返回的 `payload.template.filenameFixedField` 恒为 `undefined`。**必须补一行**，否则 AC3-4「重开对话框回显上次保存的值」直接失败。`utils.js:buildTemplateSummaryFromRow` 虽然在 G3-2 已补字段，但 main.js 有自己的 `buildTemplateSummary` 二次拍扁函数——独立透传。
3. **G3-5 默认值策略**：无持久化。`selectedTemplateId` 在 `state` 对象初值是 `''`（`renderer.js:61`），无 settings 表记录"上次选中模板"。因此默认值逻辑简化为：
   - `previous` 是虚拟 ID → 保持虚拟 ID
   - `previous` 是合法真实模板 ID → 保持真实 ID（同一会话切回不丢）
   - 其他（`''`、被删的 ID、空字符串、undefined）→ fallback 为虚拟 ID
   - 启动第一次 `state.selectedTemplateId=''`，走 fallback 选中「按文件名映射模板」，满足 AC3-1 / P1-9。
4. **G3-5 导出按钮禁用**：`setExportAvailability` 在 `updateTemplateSelect` 末尾增加显式分支「虚拟 ID 下强制 disable」（原本 `!state.selectedTemplateId` 的分支覆盖不到虚拟 ID 场景）。
5. **G3-6 v4 不升 v5**（决策 ③A）：`SUPPORTED_BUNDLE_VERSION` 保持 4，不改。v1.5.2 导出的 bundle 与 v1.5.1 双向兼容（字段级透明扩展）。本批只加 4 行注释 + 1 条 `buildTemplateSummary` 透传，**不**触碰 `buildTemplateLibraryPayload` 与 `readTemplateBundleFile`（G3-2 已完成透传链路）。

### AC 覆盖路径清单

| AC | 代码路径 |
|----|---------|
| AC3-1 | `src/renderer.js:1621-1624` 下拉顶部插入 `<option value="__FILENAME_MAPPING__">`；`:1641-1648` 默认 fallback 为虚拟 ID |
| AC3-2 | `src/renderer-dialogs.js:1979-1997` 模块 `<tr>` 位于 `payload.targetFields.forEach` 前 → 渲染在「映射关系设置」section 之上 |
| AC3-3 | `src/renderer-dialogs.js:2013-2037` 点「完成」调 `saveFilenameFixedField` + 切态 + 同步 payload；`src/main.js:3729` IPC handler 落库 |
| AC3-4 | `src/main.js:buildTemplateSummary` 透传 `filenameFixedField` + `src/renderer-dialogs.js:1980/2003` 初始值渲染与按钮初始态判定 |
| P1-7 | `src/backend/database/template-repository.js:856` bundle entry 带字段 + `src/main.js:1242` 读时 fallback 为空 |
| P1-8 | `src/main.js:1221-1243` `readTemplateBundleFile` 对象解构式解析，未知字段自然忽略 |
| P1-9 | 同 AC3-1（默认值 fallback 链） |

### 验证证据

**smoke**：
```
> node scripts/smoke-test.js
smoke test passed
```

**语法检查**：`node --check src/main.js src/renderer.js src/renderer-dialogs.js` 全部通过。

**G3-6 独立 node 脚本**（运行后已删除）：
```
[G3-6 P1-7 验证 a] bundle entry 数量: 1
[G3-6 P1-7 验证 b] entry.filenameFixedField = "中行001"
[G3-6 P1-7 验证 c] bundleVersion 策略：SUPPORTED_BUNDLE_VERSION = 4 (main.js:119)
[G3-6 P1-8 验证] 老 v4 bundle（无字段）解析 filenameFixedField = "" （应为空串）
[G3-6 P1-7 验证 d] 带字段 v4 bundle 往返读到 filenameFixedField = "农行003"
[G3-6] 所有验证通过
```

**未做**（保留 G3-7 再处理）：
- `file:import` handler 的 `__FILENAME_MAPPING__` 分支
- `handleFilenameMappingImport()` 函数
- `matchesTemplateHeaders(filePath, template)` 工具函数

### GUI / devtools 验证待用户手动确认项

1. 启动 `npm start`，主页面下拉**默认**显示「按文件名映射模板」；切换到真实模板再切回正常
2. 点「映射关系管理」打开任意模板的对话框，最上方（「映射关系设置」section 之前）出现「按文件名映射模板」模块
3. 输入「中行001」点「完成」→ input 只读 + 按钮变「编辑」；关闭对话框、重新打开同模板 → 仍显示「中行001」+ 按钮为「编辑」
4. 点「编辑」→ input 变可编辑 + 按钮变「完成」
5. 导出模板包（`desktopApi.templates.exportBundle()`）→ JSON 文件含 `filenameFixedField` + `bundleVersion: 4`
6. 重新导入该 JSON → 模板的 `filenameFixedField` 仍为「中行001」

## 2026-04-16 Dev — G3 第三批 1 个 task（G3-7 — 最后 1 个 G3 task）

### 改动文件清单

| 文件 | 改动 | 说明 |
|------|-----|------|
| `src/main.js` | +360 / -7 | 新增 `matchesTemplateHeaders` + `handleFilenameMappingImport` + 替换 G3-0 占位 |

本批总计 1 个文件、约 +360 / -7 行（其中 `-7` 是 G3-0 占位分支的 7 行注释+返回被替换）。

### 函数入口行号

- `src/main.js:5949` `matchesTemplateHeaders(filePath, template)` — 表头判定工具函数
- `src/main.js:5967` `async function handleFilenameMappingImport()` — 按文件名映射主导入函数
- `src/main.js:6315` `file:import` handler 顶部：`if (isFilenameMappingMode(templateId)) return handleFilenameMappingImport()`

### 错误码完整清单 + 触发条件

| errorCode | 触发条件 | 行号 |
|-----------|---------|------|
| `FILENAME_MAPPING_NO_MATCH` | 文件名未包含任何模板的 `filenameFixedField`（`candidates.length === 0`） | `:6027` |
| `FILENAME_MAPPING_AMBIGUOUS` | 文件名同时匹配多个模板的 `filenameFixedField`（`candidates.length > 1`） | `:6037` |
| `FILENAME_MAPPING_HEADER_MISMATCH` | 文件名唯一命中后，`readRowsWithMetadata` 抛"表头"相关 FileValidationError | `:6052` |
| `TEMPLATE_NOT_FOUND` | 匹配到的模板在 DB 查不到配置（兜底，正常不触发） | `:6075` |
| `NO_TRANSACTION_DATA` | 所有文件解析后无交易行（所有 block 都是空）| `:6172` |
| `IMPORT_IN_PROGRESS` / `ENUM_MISSING` / `ACCOUNT_MAPPING_MIGRATION_PENDING` | 守卫触发（同旧分支） | `:5973 / :5981 / :5989` |
| `FILE_IMPORT_RUNTIME` | 系统异常兜底（catch 分支，非 FileValidationError） | `:6293` |

### 整批截断实现点

- **关键位置**：`:6019-6057` 两个 for 循环
  - 第一轮（步骤 1）：`for (const filePath of inputFilePaths)` — 文件名匹配，任一 0/多命中 → **同步 return createErrorResult**（不进入后续步骤）
  - 第二轮（步骤 2）：`for (const { filePath, matchedTemplate } of perFileMatch)` — 表头校验，任一失败 → 同步 return
- 错误路径在 session 创建（步骤 5，`:6135-6138`）**之前**执行，保证报错后无 session 变更、无 fileEntries 写入
- `fileImportInProgress` 在 `finally` 子句（`:6306-6308`）强制置回 false，避免卡死

### 步骤 3~步骤 8 简要说明

- **步骤 3**（`:6063-6099`）：为每个文件独立 `getTemplateMappingConfig(matchedId)` → `buildMappedRowsForFile` → 组装 `parentProvisionalEntries[i] = { filePath, detailRows, matchedTemplateId, matchedHeaders, selfInputMerchant, skipDirectMerchantLookup }`（结构与 `main.js:6099-6107` 主模板多文件分支完全一致）
- **步骤 4**（`:6101-6131`）：聚合 bigAccounts —— 用 `seenMerchantIds` 去重；若命中子模板，向上追 parent 的 bigAccounts（用 `parentIdsProcessed` 跳过已直接命中的父）
- **步骤 5**（`:6133-6151`）：session 用虚拟 ID `__FILENAME_MAPPING__` 做 key，复用 `resolveImportFileSelection` 的重复文件检测；被剔除的文件同步裁剪出 `parentProvisionalEntries`
- **步骤 6**（`:6153-6161`）：合成 fallback `templateConfig` = 第一个匹配模板的 config + `fixedAssignments: []`（虚拟 ID 无持久化 fixed 模式）
- **步骤 7**（`:6163-6197`）：bigAccountOptions > 1 → `rememberPendingBigAccountSelection` + 返 `select-big-account`（复用 v1.5.1 流程）
- **步骤 8**（`:6199-6267`）：bigAccountOptions ≤ 1 边界 → `resolveGenerationTemplateConfig` + `rebuildMatchedTemplateFileEntries` 直接生成（参考 `main.js:6558-6593`）

### 6 条验证场景代码路径对应

| 场景 | 预期 | 代码路径（行号） |
|-----|------|----------------|
| AC3-5 / P0-7（1 文件命中 + 表头 OK） | 进入大账号选择 | `:6019-6042` 唯一命中 → `:6046-6056` 表头校验通过 → `:6059-6099` 构造 provisional → `:6166-6196` bigAccountOptions > 1 return select-big-account |
| AC3-6 / P0-8（表头不匹配） | `FILENAME_MAPPING_HEADER_MISMATCH` | `:6047-6056` `matchesTemplateHeaders` 返 false → createErrorResult |
| AC3-7 / P0-9（0 命中） | `FILENAME_MAPPING_NO_MATCH` | `:6023-6030` `candidates.length === 0` → createErrorResult |
| AC3-8 / P0-10（多命中） | `FILENAME_MAPPING_AMBIGUOUS` | `:6032-6040` `candidates.length > 1` → createErrorResult（不再 fallback 挑表头） |
| P0-11（多文件 1 个报错 → 整批截断） | 3 文件都不入库 | 步骤 1/2 在 session 创建（`:6135`）之前同步 return，任一 for 循环触发 createErrorResult 就不会进入步骤 3~8；`fileImportInProgress` 在 `finally`（`:6306`）释放 |
| 重复导入 | 同样报错，无残留 | 每次调用都走 `fileImportInProgress` 守卫（`:5969-5975`）+ `finally` 保证释放；session 只在步骤 5 后创建，报错路径无 session 污染 |

### 关键实现决策

1. **matchesTemplateHeaders 复用 matchFileToTemplate 模式**：捕获 `FileValidationError && message.includes('表头')` 返 false，其他异常向上抛。与 `main.js:5334` 现有代码行为一致，避免重写表头校验逻辑。
2. **session 用虚拟 ID 做 key**：`FILENAME_MAPPING_TEMPLATE_ID` 作为 `statementImportSessions` map 的 key（`getStatementSessionKey` 返 `String(templateId)`）。同一批「按文件名映射模板」导入共享 session，支持重复文件覆盖提示。
3. **fixedAssignments 置空**：虚拟 ID 不持久化"大账号顺序（固定模式）"记录（`readBigAccountMode/Order` 对虚拟 ID 返 null），synthetic templateConfig 的 `fixedAssignments` 置空避免错用任一模板的 fixed 模式顺序。
4. **syntheticTemplateConfig 取首个匹配模板**：`generationTemplateConfig.template.name` 用于导出文件命名与错误上下文；当所有文件匹配同一模板时 `resolveGenerationTemplateConfig` 会替换为该模板 config；仅当文件命中多个不同模板时才用 synthetic（首个）作兜底。
5. **aggregatedBigAccounts 去重 + 主模板向上追加**：用 `seenMerchantIds` 按 merchantId 去重；子模板命中时向上找 parent 的 bigAccounts；若 parent 本身也被直接命中则跳过（`!perTemplateConfigCache.has(parentId)`），避免双重处理。
6. **错误文案中文括号**：用 `「」`（codebase 惯例，`main.js:1939 / :5989` 等），PRD 示例的 `『』` 仅为设计稿参考；实际以 codebase 风格为准。

### 验证证据

**smoke**：
```
> node scripts/smoke-test.js
smoke test passed
```

**语法检查**：`node --check src/main.js` 通过。

**独立 node 脚本验证**（已运行后删除）：
```
[A] 表头一致，期望 true:  true
[B] 表头不一致，期望 false: false
[C1] 空 headers 数组，期望 false: false
[C2] headers 属性缺失，期望 false: false
[D] 抛出错误 (code=FILE_READ, msg=文件为空或不可读，请重新导入)
[D] 是 FileValidationError，非表头 → 向上抛出 ✓
[E] 过滤空字段后的 eligibleTemplates 数量: 3 (期望 3)
[E-5] "中行001-20260401.xlsx" 命中数: 2 (期望 2：中行001 和 中行 同时命中)
[E-7] "招行001-20260401.xlsx" 命中数: 0 (期望 0)
[E-9] "工行002-20260401.xlsx" 命中数: 1 (期望 1：工行)
[E-10] "中行-20260401.xlsx" 命中数: 1 (期望 1：只中行)
```

**改动文件数**：1（未超约束）。未触碰 G1、G3-0~6 的已完成代码，未提前做 G2 范围。

### 未发现与 TechDoc 冲突项

TechDoc §5.1.6 骨架与现有代码完全对得上：
- `fileImportInProgress` / `MISSING_ENUM_MESSAGE` / `database.getSetting('account_mapping_migration_pending')` 守卫与旧分支一致
- `database.listTemplates()` 返回每项含 `filenameFixedField`（G3-2 已确保）
- `parentProvisionalEntries` 结构与 `main.js:6099-6107` 主模板多文件分支一致
- `rememberPendingBigAccountSelection` / `buildBigAccountSelectionRequiredResult` 签名与旧分支一致

TechDoc §5.1.6 的一个**留空点**（"省略，Dev 落地时从 main.js:6011 复制改造"）本次补齐为实际实现，其中：
- **决策点**：对 `bigAccountOptions.length <= 1` 的边界，补了直接生成分支（步骤 8），参考 `main.js:6558-6593`；这个场景在多文件 filenameMapping 下不常见，但需要兜底
- **决策点**：`fixedAssignments: []` 置空策略见"关键实现决策 3"

### GUI 手动验证待用户确认项

以下 6 条场景建议在 `npm start` 后用 GUI 实测（node 环境下 Electron dialog / ipcMain 无法运行）：

1. **AC3-5**：给某模板 A 配 `filenameFixedField="中行001"`；下拉选「按文件名映射模板」→ 选单个文件「中行001-0401.xlsx」（表头与 A 匹配） → 进入大账号选择页
2. **AC3-6**：同上但修改文件表头与 A 不一致 → 弹 `FILENAME_MAPPING_HEADER_MISMATCH` 错误文案
3. **AC3-7**：所有模板的 `filenameFixedField` 都不与文件名 includes → 弹 `FILENAME_MAPPING_NO_MATCH` 错误文案
4. **AC3-8**：模板 A 配"中行001"、模板 B 配"中行"，文件名"中行001..." → 弹 `FILENAME_MAPPING_AMBIGUOUS` 错误文案
5. **P0-11**：多选 3 个文件（2 个可唯一命中 + 1 个 0 命中 / 多命中 / 表头不匹配）→ 整批截断，3 个都不进 session
6. **重复点导入**：任一报错后再点一次导入，同样触发同样报错（不会卡 `IMPORT_IN_PROGRESS`、session 无残留）

## 2026-04-16 Dev — G2-0 兼容性排查（只读，无代码改动）

### 已阅读代码位置
- `src/main.js:867-889` `buildBigAccountSelectionRows`
- `src/main.js:891-955` `applyBigAccountAssignmentsToFileEntries`
- `src/main.js:6431-6468` 主模板多文件分支 `parentProvisionalEntries` 构造
- `src/main.js:7053-7221` `file:complete-big-account-selection` handler

### 结论：无兼容性问题，可继续 G2-1

### 依据（代码事实）

1. **`applyBigAccountAssignmentsToFileEntries` 不读不写 `matchedTemplateId`**（main.js:891-955）
   - 读 `assignments` 只取 `merchantId/currency/rowIndex` 三字段（`:893-897`）
   - 写回 entry 只改 `merchantIdIndex` / `currencyIndex` 两个列（`:918-923`）
   - return 通过 `matchedTemplateId: entry.matchedTemplateId || null`（`:952`）原样透传
   - → M:1 展开后无论有多少组 assignments 指向同一组大账号，都不会触及 `matchedTemplateId`

2. **`rowIndex` 到 `(filePath, block)` 的映射完全由 `buildBigAccountSelectionRows` 决定**（main.js:867-889）
   - `rowIndex` 是全局递增的 block 序号（`:870 let rowIndex = 0` + `:884 rowIndex += 1`）
   - 每个 `row` 带 `filePath / fileName / blockStartIndex / blockEndIndex`，但**不**带 `matchedTemplateId`
   - `matchedTemplateId` 只挂在 `fileEntries[i]` 上（main.js:6463 `parentProvisionalEntries.push({...matchedTemplateId: matchedTemplate.id})`）
   - `applyBigAccountAssignmentsToFileEntries` 用 `globalBlockIndex` 累加定位 block（`:899, :911, :927`），与 `rowIndex` 对齐；`entry` 不变所以 `matchedTemplateId` 始终绑在其原 entry 上
   - → block 粒度展开后，某个 block 的 rowIndex 映射到"哪个文件的哪个 block"依然确定，与 matchedTemplateId 完全解耦

3. **`file:complete-big-account-selection` 后续 `resolveGenerationTemplateConfig` 仍基于 `matchedTemplateId`**（main.js:7117-7135）
   - `resolvedFileEntries = applyBigAccountAssignmentsToFileEntries(pendingContext.fileEntries, ...)` 保留 `matchedTemplateId`
   - `resolveGenerationTemplateConfig({ fileEntries: resolvedFileEntries, ... })` 内部按 matchedTemplateId 挑 config（与 v1.5.1 `:6920-6923` 路径一致）
   - → M:1 展开后每个文件的模板解析配置仍然正确

### 为什么"单文件多 block M:1" 不会污染同文件其他 block

- 前端改 `leftBlockRowIndices`：用户勾选 block 粒度（状态机 key = rowIndex，不是 fileIndex），每被勾选的 block 产生 1 条 assignment
- 后端 `applyBigAccountAssignmentsToFileEntries` 的循环（`:911-928`）按 block 推进，**只有**当前 `globalBlockIndex` 在 `assignmentByRowIndex` 中找到 assignment 才会改写该 block 的 MerchantId/Currency
- 未入组的 block 若用户未在 1:1 勾选补齐，`assignment` 为 `undefined`，`:916 if (assignment)` 跳过 → block 原 MerchantId/Currency 保留（决策 ①B "同文件未勾选 block 保持原值"由此成立）
- 但注意：前端 G2-5 主 doneBtn 校验要求 `finalAssignments.length === currentFileRows.length`，保证所有 block 都会被覆盖（P1-5 场景若不全覆盖 → 沿用 `BIG_ACCOUNT_SELECTION_INVALID` 错误提示）

### 对 G3-7 `handleFilenameMappingImport` 的同步结论

`handleFilenameMappingImport`（main.js:5967+）构造的 `parentProvisionalEntries[i]`（`:6059-6099`）每项含 `matchedTemplateId: matchedTemplate.id`，与主模板多文件分支（`:6431-6468`）结构完全一致，上述兼容性结论对 G3-7 同等成立。

### 签字条

已阅读 main.js:867-889（buildBigAccountSelectionRows）/ :891-955（applyBigAccountAssignmentsToFileEntries）/ :6431-6468（parentProvisionalEntries 构造）/ :7053-7221（complete-big-account-selection）——**G2 block 粒度 M:1 与 v1.5.1 多文件主模板分支兼容性无问题，可继续 G2-1**。

---

## 2026-04-16 Dev — G2 全批 5 个 task（G2-1/2/3/4/5）

### 改动文件清单（G2-0 只读；G2-1/5 合计改动）

| 文件 | 改动 | 说明 |
|------|-----|------|
| `src/main.js` | +3 / -1 | `buildBigAccountSelectionRows` 每 row 追加 `fileIndex` 字段 + 2 行中文注释（G2-1） |
| `src/renderer-dialogs.js` | +~230 / -15 | 多对一工具条 + 状态机 + 4 个渲染分支 + 主 doneBtn 按 block 展开（G2-2 ~ G2-5） |
| `src/styles.css` | +42 / 0 | 新增 `.ba-multi-mode-label` / `.ba-left-block-checkbox` / `.big-account-order-index--alpha` / `.ba-multi-grouped` / `.ba-multi-group-marker` 5 个 class（G2-2） |

本批总计 3 个文件，符合"≤3 文件"约束（CLAUDE.md "小批次"）。

### G2-0 只读排查签字条
已阅读 main.js:867-889（buildBigAccountSelectionRows）/ :891-955（applyBigAccountAssignmentsToFileEntries）/ :6431-6468（parentProvisionalEntries 构造）/ :7053-7221（complete-big-account-selection）——**G2 block 粒度 M:1 与 v1.5.1 多文件主模板分支兼容性无问题，可继续 G2-1**（详细三点依据见前文 §G2-0 节）。

### G2-1 关键 diff
`src/main.js:867-891` `buildBigAccountSelectionRows`：在 `fileEntries.forEach((entry, fileIndex) => {...})` 的箭头函数中追加 `fileIndex` 捕获，`rows.push({ index:rowIndex, fileIndex, ... })`。注释明确：`fileIndex` 仅作可视化辅助、非状态机 key；状态机 key 统一用 `rows[i].index`（即 rowIndex）。

### G2-2 关键 diff
- `src/renderer-dialogs.js:610-616`（footer 内）插入 3 个元素：`<label><input .ba-multi-mode-checkbox checked></label>`、`<button .ba-multi-edit-btn>编辑</button>`、`<button .ba-multi-done-btn disabled>完成</button>`
- `src/renderer-dialogs.js:637-639` DOM 引用：`multiModeCheckbox / multiEditBtn / multiDoneBtn`
- `src/styles.css:1230-1279`：5 个 class（`.ba-multi-mode-label[.is-disabled]` / `.ba-multi-edit-btn` / `.ba-multi-done-btn` / `.ba-left-block-checkbox` / `.big-account-file-item.ba-multi-editing .big-account-file-index{display:none}` / `.big-account-order-index.big-account-order-index--alpha` / `.big-account-file-item.ba-multi-grouped` / `.ba-multi-group-marker`）

### G2-3 关键 diff（核心 task）
4 个 let 变量（`multiMode / multiEditing / multiGroups / pendingGroup`），随后：
- `renderFileList`（`renderer-dialogs.js:663-710`）：3 分支（编辑态渲染 checkbox / 闭合态已入组 block 显示"✓ 文件名 → 大账号"/ 未入组或非多对一模式保留数字序号）
- `renderOrderList` 的 checkbox.change（`:723-739`）：编辑态下分流到 `onRightAccountChecked`；非编辑态沿用 v1.5.1 `checkedOrder.push/filter`
- `syncOrderIndices`（`:755-768`）：编辑态下调 `renderAlphaIndex`（按 `multiGroups.findIndex` 分配字母 + pendingGroup 用 `multiGroups.length` 作下一字母）
- `syncCheckboxDisabled`（`:770-793`）：编辑态下不限上限；闭合态下已入组大账号保持 `disabled=true`
- 状态机 helpers（`:795-955`）：`onLeftBlockChecked / onRightAccountChecked / closeCurrentGroup / renderAlphaIndex / rerenderAfterMultiDone / syncMultiToolbar / findGroupByRowIndex / findGroupByAccount / sameAccount / accountKey / isRowIndexCovered`
- 事件监听（`:1121-1186`）：`multiModeCheckbox.change` / `multiEditBtn.click`（决策 D3：每次编辑清空 multiGroups 从 a 重开）/ `multiDoneBtn.click`（闭合 pendingGroup + 退出编辑态）
- `initializeState` 末尾追加 `syncMultiToolbar()` + `syncMultiModeMutualDisabled()`
- `modeSelect.change` 末尾追加 `syncMultiModeMutualDisabled()`

### G2-4 关键 diff（已随 G2-3 一并落地）
- `onLeftBlockChecked` 的 `else` 分支：取消 pending 的 block / 从已闭合组移除；组变空整组移除
- `multiModeCheckbox.change`：取消时清空 multiGroups/pendingGroup/checkedOrder + 重渲染
- `syncMultiModeMutualDisabled`（`:1190-1218`）：rememberCheckbox 与 multiModeCheckbox 双向 disabled
- `syncModeUI` 内补 `multiGroups = []; pendingGroup = null`：fixed↔unfixed 切换时 rowIndex 空间变（rowsWithEmptyBlocks vs rows）→ 清状态防错位

### G2-5 关键 diff
- 主 `doneBtn.click`（`:1475-1557`）重写：
  1. `multiMode && multiEditing` → 自动 `closeCurrentGroup()` + `multiEditing=false`（P0-4 单组用户直接点主完成也能生效）
  2. 展开 `multiGroups`：`group.leftBlockRowIndices.forEach((rowIndex) => finalAssignments.push({...}); covered.add(rowIndex))`
  3. 按 `currentFileRows` 顺序补齐 1:1：`checkedOrder` 顺序消费，跳过 covered 的 rowIndex
  4. `finalAssignments.sort((a,b) => a.rowIndex - b.rowIndex)`
  5. 长度校验 `=== currentFileRows.length`（与 v1.5.1 一致）
  6. fixed + remember 保留 saveOrder；错误码 `BIG_ACCOUNT_SELECTION_INVALID` 处理不变

### AC 覆盖代码路径清单

| AC | 代码路径 |
|----|---------|
| AC2-1 | `renderer-dialogs.js:605-616` footer 插入 3 元素，默认 checked + 编辑按钮 enabled + 完成按钮 disabled |
| AC2-2 | `renderer-dialogs.js:681-697` 编辑态每 block 渲染 `<input .ba-left-block-checkbox>` 替代 `.big-account-file-index` |
| AC2-3 | `renderer-dialogs.js:908-923` `renderAlphaIndex` 按 `String.fromCharCode(97 + idx)` 渲染 |
| AC2-4 | `renderer-dialogs.js:804-833` `onLeftBlockChecked` checked=true 分支：追加 pendingGroup；闭合时机见 `onRightAccountChecked`（`:854-872` 已绑 rightAccount 再勾新大账号触发闭合） |
| AC2-5 | `renderer-dialogs.js:856-868` 先勾右侧：若 pending 空 → 新建 `{leftBlockRowIndices:[], rightAccount, startedBy:'right'}` |
| AC2-6 | `renderer-dialogs.js:942-970` `rerenderAfterMultiDone`：字母清零 + 已入组 block 显示 "✓ 文件名 → 大账号"（`renderFileList` 闭合态分支 `:690-705`） + 已入组大账号 checkbox 保持 checked 且 disabled |
| AC2-7 | `renderer-dialogs.js:1163-1175` `multiEditBtn.click`：清空 multiGroups（字母从 a 重开）+ pendingGroup + 所有 cb uncheck |
| AC2-8 | `renderer-dialogs.js:1132-1156` `multiModeCheckbox.change` checked=false 分支：清空 multiGroups/pendingGroup/checkedOrder + cb uncheck + 重渲染 |
| AC2-9 | `renderer-dialogs.js:1475-1511` 主 doneBtn 展开（block 粒度）+ `rowIndex` 升序 |
| AC2-10 | `renderer-dialogs.js:1190-1218` `syncMultiModeMutualDisabled` 双向 disabled |
| AC2-11 | 由 G2-0 已验证：`applyBigAccountAssignmentsToFileEntries`（`main.js:918-923`）按 `assignmentByRowIndex.get(globalBlockIndex)` 匹配，每 block 改写独立 MerchantId/Currency |
| AC2-12 | 关键场景 P0-12：同文件 3 block 可分别归不同组或不入组 —— `renderFileList` + `onLeftBlockChecked` 按 rowIndex（而非 fileIndex）独立工作；G2-5 展开按 rowIndex 粒度；已通过独立 node 脚本验证（运行后删除） |

### 验证证据

**smoke**：
```
> node scripts/smoke-test.js
smoke test passed
```

**语法检查**：`node --check src/main.js src/renderer-dialogs.js` 全部通过。

**独立 node 脚本验证（模拟状态机 + 主 doneBtn 展开，不依赖 DOM）**：
```
PASS [A.1 pending 未闭合前 groups=0]
PASS [A.2 C 追加到 pending]
PASS [A.3 闭合第一组]
PASS [A.4 第一组 left]
PASS [A.5 第一组 right]
PASS [A.6 pending 新组 right=M2]
PASS [A.7 pending.left=[3]]
PASS [A.8 最终 assignments 正确]       ← P0-4
PASS [B 先右后左 + 1 个 1:1 补齐]      ← P0-5
PASS [C P0-6 混合 1:1 补齐]            ← P0-6
PASS [D P0-12 同文件 3 block 独立归组]  ← P0-12（关键）
PASS [E.1 取消 block0 后 pending.left=[1]] ← P1-2
PASS [E.2 rightAccount 保留]
PASS [F.1 右侧进入 pending]
PASS [F.2 取消右侧且无 left → pending=null]
PASS [F.3 有 left 时取消右侧 → pending 保留 left]
PASS [F.4 rightAccount 置 null]
PASS [G.1 一组已闭合]
PASS [G.2 闭合组 left=[0]]
PASS [G.3 整组删除]
PASS [H.1 已闭合大账号再次勾选被忽略]
PASS [H.2 原 M1 组保持]
```
（脚本运行后已删除；脚本路径 `/tmp/v1.5.2-g2-statemachine-test.js`）

### 关键实现决策

1. **multiGroups 在"编辑"按钮 click 时清空**：PRD §6.2 D3 决策"每次完成后清零；下次进编辑态从 a 重开"；代码上选择"每次点编辑时清空 multiGroups + pendingGroup + cb uncheck"——语义等价。若只清 pendingGroup 不清 multiGroups，字母序号会从 `multiGroups.length` 而不是 a 开始，违反 D3。这里的权衡：若保留已闭合组，用户需要先点"编辑"再逐个取消已闭合组的 block 才能"擦除"，UX 不自然；按决策 D3 直接清零更简单。
2. **主 doneBtn 编辑态下自动闭合**：P0-4 单组场景里，PRD §6.2.3 第一幅 Mockup 用户操作是"勾左 → 勾右"即可，不要求点组"完成"按钮再点主"完成"。实现上在 `doneBtn.click` 顶部若 `multiEditing=true` → `closeCurrentGroup() + multiEditing=false`，保证 pendingGroup 能被捕获到 finalAssignments。
3. **已入组大账号在闭合态下 disable cb**：PRD §6.2.1 明确"右侧已入组大账号保持勾选态，不允许取消（除非重新"编辑"）"。实现在 `syncCheckboxDisabled` + `rerenderAfterMultiDone` 双重保障。
4. **mode 切换（fixed↔unfixed）时清空 multiGroups**：`syncModeUI` 切换 `currentFileRows`（rows vs rowsWithEmptyBlocks），rowIndex 空间不同 → 若保留 multiGroups 会出现 rowIndex 错位；清空最安全。
5. **G2-5 `currentFileRows` 顺序补齐 1:1**：用户在编辑态下不累积 checkedOrder（checkbox 分流到状态机）；闭合态后用户可再勾 1:1 累积 checkedOrder；主 doneBtn 合并时按 `currentFileRows` 顺序消费 checkedOrder（类似 v1.5.1 的 1:1 顺序），跳过已 covered 的 rowIndex。
6. **rememberCheckbox ↔ multiModeCheckbox 双向互斥**：rememberCheckbox checked=true 时直接 uncheck multiModeCheckbox 且 `renderFileList` 恢复数字序号，避免左侧勾选框残留（fixed+savedOrder 自动进入 rememberMode 时尤其需要）。

### 未发现与 TechDoc / PRD 冲突项

- TechDoc §4.1.1 / §4.1.2 / §4.1.3 伪码结构与本实现一致
- PRD §6.2.1 "边界条件" 全部覆盖（见 AC 覆盖表 + 独立 node 验证）
- 决策 ①B（block 粒度，状态机 key = rowIndex）全程贯穿，无"文件折叠/按 fileIndex 分组"的残留

### GUI 手动验证待用户确认项（自测框架不可触达 Electron GUI）

以下场景在 `npm start` GUI 环境下手动验证：

**P0 场景**：
1. **AC2-1 外观**：打开大账号确认页，footer 有"单个账号匹多个文件 ✓ [编辑][完成]"
2. **AC2-2**：默认编辑态下，左侧每 block 有勾选框，数字序号消失
3. **AC2-3**：右侧勾一个大账号 → 大账号左侧 "1." 变 "a."
4. **P0-4 基本 M:1**：勾左侧 block0+block1 → 勾右侧 M1 → 勾 block2 → 勾 M2 → 勾 block3 → 勾 M3 → 点主完成 → 导出 detailRows：block0/1 MerchantId=M1, block2=M2, block3=M3
5. **P0-5 逆序**：勾右侧 M1 → 勾左侧 block0+1+2 → 点主完成 → 导出正确
6. **P0-6 混合**：勾 block0+1 → 勾 M1 → 点组"完成"按钮（退出编辑态） → 未入组 block2/3 用数字序号单勾 M2/M3 → 点主完成 → 导出 4 条
7. **P0-12（关键）**：1 个文件 3 block；勾 block0 → 勾 M1 → 勾右侧 M2（触发闭合 + 开新组）→ 勾 block2 → 点主完成（block1 需在"编辑组"闭合后 1:1 勾 M3）→ 导出 block0=M1, block1=M3, block2=M2
   - 注意：上述 P0-12 需要用户在**编辑态内先勾 M2 开新组**（触发组 a 闭合），否则继续追加 block 会并入原组。PRD §6.2.1 "组切换触发器"列举 "开始勾新的右侧大账号" 即此语义。

**P1 场景**：
- P1-2：编辑态下取消 block 勾选 → 组不消失（仅该 block 移除），字母序号保持
- P1-3：点"单个账号匹多个文件"取消 → 左侧字母/勾选框消失，恢复数字序号 UI
- P1-4：fixed 模式勾"记住顺序" → "单个账号匹多个文件" 自动 uncheck + disabled；反之亦然
- P1-5：主完成时若 block 未全覆盖 → 弹 `BIG_ACCOUNT_SELECTION_INVALID` 错误提示
- AC2-9 后端展开：`pendingContext.fileEntries` 保留 `matchedTemplateId`（由 G2-0 验证），展开的 assignments 被 `applyBigAccountAssignmentsToFileEntries` 按 rowIndex 匹配 globalBlockIndex 一致处理

---

## 2026-04-16 Dev — 收尾 Z-1 / Z-2（版本号 + 文档三件套）

### 改动文件清单（4 个文件）

| 文件 | 改动 | 关键内容 |
|------|------|---------|
| `package.json` | +1 / -1 | `"version": "1.5.1"` → `"1.5.2"` |
| `CHANGELOG.md` | +15 / -0 | 顶部插入 `## 1.5.2 - 2026-04-16` 节：3 项主需求（按文件名映射 / M:1 大账号 / 主子模板名校验）+「变更」section（模板表新增 `filename_fixed_field` 列、Bundle v4 透明扩展承诺、大账号 row 结构、固定模式互斥、新 IPC）|
| `docs/VERSION_FEATURE_HISTORY.md` | +21 / -0 | `## 1.5.1` 上方插入 `## 1.5.2` 节，按「新增 / 变更 / 移除」三组分；新增 = 3 项主需求；变更 = 6 条（数据结构 / Bundle / row 结构 / 互斥 / IPC / helper）；移除 = 无 |
| `docs/USER_GUIDE.md` | +60 / -2 | 顶部版本号 v1.5.1 → v1.5.2；主要功能 8/9 之后追加 10/11/12 三条 v1.5.2 项；「修改模板 - 字段介绍」补 4) 模块说明；Q&A 17/18/19 新增三组（按文件名映射 3 问 / 单账号匹多文件 3 问 / 主子模板名校验 1 问）|

`git diff --stat`：4 个文件 +95 / -3。

### 关键内容决策

1. **Bundle v4 透明扩展承诺写进 CHANGELOG + VERSION_FEATURE_HISTORY**（决策 ③A 对外承诺）：明确"v1.5.1 用户读 v1.5.2 导出的 bundle 不会报错，该字段被自然忽略"；不升 v5。
2. **CHANGELOG 不写「修复」章节**：本版本无纯 bug fix，按 user 提示"如果本版本没有纯 bug 修复，这节可以省略"省略该 section。
3. **USER_GUIDE 风格保持 Q&A**：参考 v1.5.1 新增的 14/15/16 三组（主子模板 / 账户映射隔离 / 重复判定）的写法，每组 1-3 个 Q&A，文案口吻一致。
4. **「修改模板 - 字段介绍」补 4) 子项**：因「按文件名映射模板」模块在 dialog 视觉上的位置就在「映射关系设置」section 上方，把它当作模板配置的"第 4 个字段"补进去更直观。
5. **Q&A 19 主子模板名校验**：v1.5.1 已有 14) 主子模板说明，本次 19) 是对其行为的"完成时校验"补充，放在 18) 单账号匹多文件之后保持时间顺序。

### 验证证据

**smoke**：
```
> bank-bill-excel-tool@1.5.2 smoke
> node scripts/smoke-test.js
smoke test passed
```
（`@1.5.2` 显示版本号已生效）

**git diff --stat 4 文件**：
```
 CHANGELOG.md                    | 15 +++++++++++
 docs/USER_GUIDE.md              | 60 +++++++++++++++++++++++++++++++++++++++--
 docs/VERSION_FEATURE_HISTORY.md | 21 +++++++++++++++
 package.json                    |  2 +-
 4 files changed, 95 insertions(+), 3 deletions(-)
```

**版本号一致性**：4 个文件中所有 `v1.5.2 / 1.5.2` 字面值匹配；`SUPPORTED_BUNDLE_VERSION = 4` 不变。

### 待用户验证项（非 docs 改动；与 G1 / G3 / G2 已完成的 16 个 task 一并属于 GUI 手动测试范围）

按 PRD §八 P0 → P1 顺序逐条手动验证：
- P0-1 ~ P0-3（需求 1 主子模板名校验）
- P0-4 ~ P0-6 + P0-12（需求 2 M:1 大账号 + block 粒度）
- P0-7 ~ P0-11（需求 3 按文件名映射）
- P1-1 ~ P1-9（边界场景）

详细 GUI 手动验证清单见前文各批次 log（G1-1 / G3-3 / G3-4 / G3-7 / G2 全批）末尾的「GUI 手动验证待用户确认项」。

---

## 可沉淀知识
- [ ] （暂无）
