# TechDoc - 网银账单小助手 v1.5.0 (v2)

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.0 v2 |
| 日期 | 2026-04-10 |
| 作者 | Dev |
| 状态 | 已定稿（2026-04-10），含测试期间 11 项 fix 记录 |
| 关联 PRD | `docs/iterations/v1.5.0/PRD-v1.5.0.md`（v2 定稿，44 AC：AC1-1~AC1-11 + AC2-1~AC2-3 + AC3-1~AC3-13 + AC4-1~AC4-16 + AC5-1） |
| 依赖 | v1.4.9 已 merged 到 main，v1.5.0 从 main 起分支 |

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §4.1 精度提升到 12 位 | **已实施**（v1 代码保留）。`roundAmountHighPrecision` + `calculateEndingBalanceFromAmounts` 高精度 + Excel 文本格式降级。无需再改。 |
| §4.2 标题文案改动 | 纯文本替换。`renderer-dialogs.js` 的 `dialog-title` + `记住大账号选择顺序` + footer 布局。无技术阻碍。 |
| §4.5 删除帮助图标 | 删除 v1 新增的 `.file-order-help-icon` HTML + CSS。无技术阻碍。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | §4.3 记住顺序持久化：当前 `big-account-order-store.js` 只存 `assignments`。需要扩展数据结构增加 `fileCount` / `files[]` 信息。存储格式向下兼容：旧 JSON 无 `files` 字段时读取不报错，fallback 到当前行为。 | 在 TechDoc 落定。 |
| R-2 | §4.3.4 导入时自动匹配 + 直接输出（D2-1）：需要在 `file:import` IPC handler 的大账号选择分支前插入自动匹配逻辑。匹配成功时复用 `file:complete-big-account-selection` 的后半段逻辑直接生成输出。 | 在 TechDoc 落定。 |
| R-3 | §4.4 提取大账号顺序：复用 v1 的 `identifyAccountsFromFile` / `findHeaderRowNumbersInRawRows` / `matchMerchantIds` 核心逻辑。IPC 从 `file:check-sort` 改为 `file:extract-big-account-order`，返回格式改为 `{ accounts: [{ merchantId, currency, matchType }] }`。前端弹出新对话框而非 alert。 | 在 TechDoc 落定。 |
| R-4 | §4.3.3 / §4.3.4 bundle 导出需包含记住顺序配置：`listTemplateBundleEntries` 返回的每个 entry 需追加 `bigAccountOrderConfig` 字段；import-bundle 时写入对应的 JSON 文件。 | 在 TechDoc 落定。 |

### 1.3 与 PRD 的差异（无）

Dev 不在本 TechDoc 中改写 PRD 任何条款。

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/file-service/normalizers.js` | 已完成（v1） | `roundAmountHighPrecision` + `calculateEndingBalanceFromAmounts` 高精度 |
| `src/backend/file-service/writers.js` | 已完成（v1） | Excel 15 位有效数字判定 + 文本格式降级 |
| `src/backend/file-service/readers.js` | 修改 | CSV magic bytes 检测 + `readRows` 新增 blankrows 选项（Fix #1, #2） |
| `src/backend/big-account-order-store.js` | 修改 | 扩展 `readBigAccountOrder` / `writeBigAccountOrder` 支持 `files[]` 数据 |
| `src/main.js` | 修改 | 删除 v1 check-sort/file-sort 代码；改 IPC `file:check-sort` → `file:extract-big-account-order`；新增自动匹配逻辑 in `file:import`；bundle 导出/导入追加 `bigAccountOrderConfig` |
| `src/preload.js` | 修改 | `checkSort` → `extractBigAccountOrder` |
| `src/renderer-dialogs.js` | 修改 | 标题文案改动；删除 tooltip；检查排序 → 提取大账号顺序弹框；记住顺序匹配失败弹框 |
| `src/styles.css` | 修改 | 删除 `.file-order-help-icon` / `.file-order-tooltip`；新增提取弹框样式 |
| `package.json` | 已完成（v1） | version 已为 `1.5.0` |
| `docs/iterations/v1.5.0/TechDoc-v1.5.0.md` | 重写 | 本文件 |

---

## 三、需求 1：精度 12 位（已实施，不再修改）

v1 代码保留：
- `roundAmountHighPrecision`（normalizers.js）
- `calculateEndingBalanceFromAmounts` 使用高精度（normalizers.js）
- `buildNumericCellValue` 15 位有效数字判定（writers.js）

---

## 四、需求 2 + 5：标题文案改动 + 删除帮助图标

### 4.1 文案替换

| 位置 | 原文 | 新文 |
|------|-----|-----|
| `renderer-dialogs.js` dialog-title | `请选择本次使用的大账号 / 币种` | `网银账单解析大账号确认` |
| `renderer-dialogs.js` remember label span | `记住大账号选择顺序` | `记住顺序` |

### 4.2 删除帮助图标

删除 `renderer-dialogs.js` 中 `big-account-split-header` 内的 `.file-order-help-icon` span。
删除 `styles.css` 中 `.file-order-help-icon` / `.file-order-tooltip` 规则。

### 4.3 Footer 布局调整

`定位大账号` + 搜索框向右平移：通过给 `big-account-search-label` 增加 `margin-left: auto` 实现自动推右。

---

## 五、需求 4：提取大账号顺序

### 5.1 IPC 设计

```
前端: "提取大账号顺序" 按钮点击
  ↓
renderer-dialogs.js: desktopApi.files.extractBigAccountOrder({ mode, fileRows })
  ↓
preload.js: ipcRenderer.invoke('file:extract-big-account-order', payload)
  ↓
main.js: ipcMain.handle('file:extract-big-account-order', handler)
  ↓
返回: { status: 'ok', accounts: [{ merchantId, currency, matchType, fileName }...] }
  或  { status: 'error', failedRows: [{ index, fileName }...] }
```

> **Fix #5**：前端额外传 `mode`（当前模式）和 `fileRows`（左侧面板行数据，含 `sourceRowNumber` / `fileName`）。不固定模式下后端按 `fileRows` 驱动提取——每个 fileRow 的 `sourceRowNumber` 用于定位对应 header，在 header 前的行搜索账户号。固定模式仍按文件全量 headerRowNumbers 驱动。

### 5.2 后端

复用核心函数：`identifyAccountsFromFile` / `findHeaderRowNumbersInRawRows` / `matchMerchantIds` / `stripSpecialCharsForMatch`。

`file:extract-big-account-order` handler：
1. 从 `lastPendingBigAccountSelection` 获取 fileEntries + bigAccounts
2. 根据 `mode` 决定驱动方式：
   - **固定模式**：遍历文件，调用 `identifyAccountsFromFile` 提取全部账户
   - **不固定模式**（Fix #5）：按前端传来的 `fileRows` 驱动，每个 fileRow 对应一个 header 位置，在该 header 上方行搜索账户号
3. 对提取到的 merchantId，在 `expandedBigAccountOptions` 中查找匹配的大账号
4. 任一行提取失败 → 返回 `{ status: 'error', failedRows }`
5. 全部成功 → 返回 `{ status: 'ok', accounts }`

关键实现细节：
- **Fix #1（CSV magic bytes 检测）**：`readWorkbookRows`（readers.js）的 `.csv` 分支先检查文件头 4 字节是否为 OLE2 (`0xD0CF11E0`) 或 ZIP (`0x504B0304`) 签名，匹配则 fall through 到 XLSX 库处理，避免将扩展名为 `.csv` 的 Excel 文件误用文本解析。
- **Fix #2（readRows blankrows 选项）**：`readRows(filePath, { blankrows: true })` 支持保留空行，确保原始行号与 raw rows 索引对齐。
- **Fix #3（坐标系对齐）**：`identifyAccountsFromFile` 内 3 处 `readRows` 调用改为 `{ blankrows: true }`，保证 rawRows 索引与 1-based 行号一致。
- **Fix #4（倒序搜索）**：`searchCandidateRange` 从 `candidateEnd` 向 `candidateStart` 倒序搜索，优先命中最靠近 header 的账户信息行（银行 CSV 中"查询账号"行通常紧贴表头上方）。

### 5.3 前端弹框

新增提取大账号顺序弹框（内联在 `createBigAccountSelectionDialog` 的 `extractOrderBtn` handler 中）：

- 左侧：文件顺序列表（只读，复用 `big-account-file-item` 样式），带数字序号和文件名省略（Fix #10）
- 右侧：提取结果列表，每行显示数字序号 + `merchantId currency` + `[编辑]` 按钮
- 编辑行：双输入框（账户号 + 币种）+ 行内完成按钮
- 行内完成校验：精准匹配 `expandedBigAccountOptions`
- 右下角完成按钮：条件覆盖逻辑（有已勾选→二次确认）
- 右上角关闭按钮（`×`）返回主页面（Fix #10）
- 左右面板同步滚动（Fix #10）

### 5.4 完成后填入

将提取结果填入主页面的 `checkedOrder`，触发 `syncOrderIndices` + `syncCheckboxDisabled` 刷新 UI。填入后右侧面板按已勾选在前、未勾选在后的顺序重新排列（Fix #11）。

### 5.5 主页面同步滚动

大账号确认页左右面板（文件顺序 / 大账号顺序）也实现同步滚动（Fix #11）。

---

## 六、需求 3：记住顺序持久化增强

### 6.1 数据结构扩展

`big-account-order-store.js` 的 JSON 格式扩展：

```json
{
  "templateId": "123",
  "assignments": [...],
  "fileCount": 3,
  "files": [
    {
      "fileIndex": 0,
      "accountCount": 2,
      "accounts": [
        { "merchantId": "62001234567890", "currency": "CNY" },
        { "merchantId": "62009876543210", "currency": "USD" }
      ]
    }
  ],
  "updatedAt": "..."
}
```

向下兼容：`readBigAccountOrder` 读取时 `files` 不存在则 fallback 到 `null`。

### 6.2 保存时机

`file:complete-big-account-selection` handler 中，当 `mode === 'fixed' && rememberCheckbox.checked` 时：
1. 保存 `assignments`（已有）
2. 额外保存 `fileCount` + `files[]`（从 `pendingContext.fileEntries` + `identifyAccountBlocks` 计算）

### 6.3 导入时自动匹配

在 `file:import` handler 中，进入大账号选择分支前：
1. 检查模板是否有记住顺序配置（`readBigAccountOrder` 返回有 `files`）
2. 检查模式是否为 fixed —— `savedMode === 'fixed'` 直接字符串比较（Fix #6，`readBigAccountMode` 返回字符串而非对象）
3. 文件个数不等 → 设 `forceMode: 'unfixed'`（Fix #7），前端 `initializeState` 优先使用此值覆盖模板默认模式，弹大账号确认页
4. 文件个数相等 → 逐文件匹配（**非位置对位**，Fix #8）：
   - 每个导入文件在**所有**保存文件中搜索匹配（账户个数 + 账户号），使用 `usedSavedIndices` Set 防止重复匹配同一保存文件
   - 建立 `fileMatchMap`（导入文件索引 → 保存文件索引）
5. 全部匹配 → 按 `fileMatchMap` 重排 `savedOrderConfig.assignments`（Fix #9 `reorderedAssignments`），确保 assignments 的 rowIndex 对应当前导入文件的实际排列顺序，然后直接走 `complete-big-account-selection` 逻辑输出
6. 部分失败 → 返回特殊 status `remember-order-mismatch`，前端弹匹配失败框

### 6.4 Bundle 导出/导入

**导出**：`listTemplateBundleEntries` 返回每个 entry 时，额外读取 `readBigAccountOrder` 并附加到 entry 的 `bigAccountOrderConfig` 字段。

**导入**：`template:import-bundle` handler 中，如果 entry 有 `bigAccountOrderConfig` 字段，调用 `writeBigAccountOrder` 写入。

### 6.5 匹配失败提醒框

前端新增处理 `status: 'remember-order-mismatch'` 的分支，弹出提醒框：
- 逐行列出失败的文件名
- 「变更配置」按钮 → 以 fixed 模式打开大账号确认页
- 「确认」按钮 → 关闭，返回主页

---

## 七、测试期间 Fix 汇总

以下 11 项 fix 在 v2 实施后的测试阶段发现并修复，已合入 v1.5.0 分支。

| Fix # | 问题 | 修复 | 涉及文件 |
|-------|------|------|---------|
| 1 | 扩展名 `.csv` 但实际为 Excel 格式的文件被文本解析器处理，导致乱码 | `readWorkbookRows`（readers.js）在 `.csv` 分支先检查文件头 4 字节（OLE2 `0xD0CF11E0` / ZIP `0x504B0304`），匹配则 fall through 到 XLSX 库 | `readers.js` |
| 2 | `readRows` 不支持保留空行，导致原始行号与 rawRows 索引不对齐 | 新增 `readRows(filePath, { blankrows: true })` 选项 | `readers.js` |
| 3 | `identifyAccountsFromFile` 内 `readRows` 未保留空行，行号坐标系错位 | 3 处 `readRows` 调用改为 `{ blankrows: true }` | `main.js` |
| 4 | 候选区域正序搜索命中无关行（如汇总区的数字），不够精准 | `searchCandidateRange` 改为从 `candidateEnd` 到 `candidateStart` 倒序搜索，优先命中最靠近 header 的行 | `main.js` |
| 5 | 不固定模式下后端按全文件 headerRowNumbers 驱动提取，与左侧面板显示的行数不匹配 | 前端传 `{ mode, fileRows }`，不固定模式下后端按 `fileRows`（含 `sourceRowNumber`）驱动，每个 fileRow 找对应 header 后在其前面搜索 | `main.js`, `renderer-dialogs.js` |
| 6 | `savedMode?.mode === 'fixed'` 永远为 false（`readBigAccountMode` 返回字符串 `'fixed'` 而非对象） | 改为 `savedMode === 'fixed'` 直接字符串比较 | `main.js` |
| 7 | 文件个数不匹配时前端仍以 fixed 模式打开确认页 | 后端设 `forceMode: 'unfixed'`，前端 `initializeState` 优先使用 `payload.forceMode` 覆盖模板默认模式 | `main.js`, `renderer-dialogs.js` |
| 8 | 自动匹配按 `fileIndex` 对位比较，文件顺序不同时误判失败 | 改为每个导入文件在**所有**保存文件中搜索匹配，用 `usedSavedIndices` 防止重复匹配 | `main.js` |
| 9 | 匹配成功但文件顺序变化后 assignments 的 rowIndex 与实际文件不对齐 | 按 `fileMatchMap` 重排 `reorderedAssignments` 再生成输出 | `main.js` |
| 10 | 提取弹框缺少关闭按钮；左右面板不同步滚动；无数字序号；长文件名溢出 | 新增右上角 `×` 关闭按钮；左右面板 `onscroll` 同步 `scrollTop`；每行前增数字序号；文件名超长时 `text-overflow: ellipsis` | `renderer-dialogs.js`, `styles.css` |
| 11 | 主页面左右面板无同步滚动；提取结果填入后右侧未按已勾选在前排列 | 主页面文件/大账号面板同步滚动；提取填入后触发右侧排序（已勾选按序号在前，未勾选按原序在后） | `renderer-dialogs.js` |

---

## 八、实施计划（Commit 粒度）

v2 主功能 commits：

| 序号 | Commit message | 涉及文件 |
|------|---------------|---------|
| 1 | `docs(v1.5.0): rewrite TechDoc for v2` | `TechDoc-v1.5.0.md` |
| 2 | `refactor(v1.5.0): remove v1 check-sort, tooltip, file-sort code` | `main.js`, `preload.js`, `renderer-dialogs.js`, `styles.css` |
| 3 | `feat(v1.5.0): rename dialog title and labels (requirement 2+5)` | `renderer-dialogs.js`, `styles.css` |
| 4 | `feat(v1.5.0): extract big account order dialog (requirement 4)` | `main.js`, `preload.js`, `renderer-dialogs.js`, `styles.css` |
| 5 | `feat(v1.5.0): remember order persistence enhancement (requirement 3)` | `big-account-order-store.js`, `main.js`, `preload.js`, `renderer-dialogs.js` |

测试期间 fix commits（Fix #1 ~ #11，详见 §7）：各 fix 按发现顺序独立 commit。

---

## 九、Open Technical Questions（无）

本版本技术实现方案明确，无待定的技术问题。
