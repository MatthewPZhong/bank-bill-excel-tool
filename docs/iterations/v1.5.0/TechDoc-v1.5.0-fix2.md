# TechDoc - 网银账单小助手 v1.5.0 fix2

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.0 fix2 |
| 日期 | 2026-04-11 |
| 作者 | Dev |
| 状态 | 初稿 |
| 关联 PRD | `docs/iterations/v1.5.0/PRD-v1.5.0-fix2.md`（23 条 AC） |
| 依赖 | v1.5.0 分支已合入 PRD-v1.5.0 全部需求及 Fix #1~#11 |

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §4.1 模块名称变更 | 纯文本替换。涉及 `renderer.js:32` 和 `index.html:37` 两处字符串。无技术阻碍。 |
| §4.2 英文日期格式解析 | `parseEnglishMonthDateCandidate`（normalizers.js:358-408）和 `stripDateTimeSuffix`（normalizers.js:411-425）需扩展正则模式。现有 `ENGLISH_MONTH_INDEX`（normalizers.js:4-17）已覆盖三字母缩写，需补全完整月份名映射。无技术阻碍。 |
| §4.7 按正负号下拉框宽度修复 | CSS 单行修改。`.bill-split-sub-row .mapping-select`（styles.css:2042-2044）补充 `max-width` 使之与全局 `.mapping-select`（styles.css:323-325）一致。无技术阻碍。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | §4.3 导入模板包同名覆盖确认：当前 `template:import-bundle` handler（main.js:3467-3654）在后端同步循环中直接 `database.upsertTemplate`。需要在循环前先扫描一遍 bundle 中的模板，收集存在同名的列表，通过 IPC 返回前端弹框确认后，再执行实际写入。实现方案：拆为两步——第一步扫描返回同名列表，第二步前端确认后调用新 IPC `template:confirm-import-bundle` 执行写入。或者使用 Electron `dialog.showMessageBox` 在后端弹确认框。 | 在 TechDoc §五 落定。采用 `dialog.showMessageBox` 方案（后端弹框），避免增加 IPC 往返和前端状态管理复杂度。 |
| R-2 | §4.4 使用手册导出格式扩展：当前仅支持 PDF 导出。改为支持 txt、md、html 三种格式。HTML 格式需要 Markdown→HTML 转换。 | 在 TechDoc §六 落定。 |
| R-3 | §4.5a / §4.6（5b）单滚动条：需要调整 DOM 结构——将左右面板从各自 `overflow-y: auto` 的容器移入一个共用的 `overflow-y: auto` 外层容器。对于 5b 的条件切换，需在 `rememberCheckbox` 的 `change` 事件中动态切换 DOM 结构或 CSS class。 | 在 TechDoc §七/§八 落定。 |
| R-4 | §4.8 指定账单实现功能：需要新增数据库字段或扩展 `template_bill_split_meta` 表来持久化"指定账单"的选中信息。前端需在 `createBillSplitRowsDialog`（renderer-dialogs.js:2880）中新增 checkbox + 多选下拉框 UI，并在 `renderTableRow`（renderer-dialogs.js:3008）中按选中的账单序号禁用对应行的 Credit/Debit 下拉框。 | 在 TechDoc §十 落定。 |

### 1.3 与 PRD 的差异（无）

Dev 不在本 TechDoc 中改写 PRD 任何条款。

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `index.html` | 修改 | 需求 1：模块按钮文本替换 |
| `src/renderer.js` | 修改 | 需求 1：模块定义 `name` 字段替换 |
| `src/backend/file-service/normalizers.js` | 修改 | 需求 2：扩展 `ENGLISH_MONTH_INDEX`、`stripDateTimeSuffix`、`parseEnglishMonthDateCandidate` |
| `src/main.js` | 修改 | 需求 3：`template:import-bundle` handler 增加同名检测 + 确认弹框；需求 4：`app:save-user-guide` handler 扩展多格式导出（txt/md/html） |
| `src/renderer-dialogs.js` | 修改 | 需求 5a：提取弹框单滚动条 DOM 重构；需求 5b：大账号选择对话框条件单滚动条 + 文本化；需求 7：指定账单实现功能 UI |
| `src/styles.css` | 修改 | 需求 5a/5b：单滚动条样式；需求 6：`.bill-split-sub-row .mapping-select` 宽度修复；需求 7：指定账单 UI 样式 |
| `src/backend/database/migrations.js` | 修改 | 需求 7：`template_bill_split_meta` 表新增字段 |
| `src/backend/database/template-repository.js` | 修改 | 需求 7：读写指定账单配置 |
| `src/backend/database.js` | 修改 | 需求 7：暴露指定账单配置的读写方法 |
| `src/preload.js` | 可能修改 | 需求 3：如采用前端确认方案则需新增 IPC（当前方案采用后端 `dialog.showMessageBox`，不需要修改 preload） |

---

## 三、需求 1：模块名称变更

### 3.1 文本替换

| 文件 | 行号 | 原文 | 新文 |
|------|------|------|------|
| `src/renderer.js` | 32 | `name: '新开账户生成网银账单'` | `name: '新开账户余额账单生成'` |
| `index.html` | 37 | `<button ... data-module="new-account-generator">新开账户生成网银账单</button>` | `<button ... data-module="new-account-generator">新开账户余额账单生成</button>` |

### 3.2 不变的部分

- 后端 `main.js` 中使用 `new-account:generate` / `new-account:export` IPC channel 名不变（不含模块显示名）。
- 模块 ID `new-account-generator` 不变。
- `data-module` attribute 值不变。

---

## 四、需求 2：英文日期格式解析

### 4.1 `ENGLISH_MONTH_INDEX` 扩展

当前 Map（normalizers.js:4-17）仅包含三字母缩写（`jan`~`dec`）。`resolveEnglishMonthIndex`（normalizers.js:346-356）使用 `normalizedValue.slice(0, 3)` 截取前三字符后查 Map，因此**完整月份名天然可兼容**（`april` → slice → `apr` → Map hit）。

结论：`ENGLISH_MONTH_INDEX` 和 `resolveEnglishMonthIndex` **无需修改**。

### 4.2 `stripDateTimeSuffix` 扩展

当前实现（normalizers.js:411-425）通过三步正则去除时间后缀：

1. `[Tt]\d{1,2}:\d{1,2}(:\d{1,2})?.*$` — 去除 ISO 格式 `T` 后时间
2. `^(\d{4}-\d{1,2}-\d{1,2})-\d{1,2}:\d{1,2}$` — 去除 `YYYY-MM-DD-HH:MM`
3. `\s+\d{1,2}[:.]\d{1,2}([:.]\d{1,2})?.*$` — 去除空格后时间

**问题**：输入 `09 Apr 2026, 06:26:26 PM` 经步骤 3 处理后变为 `09 Apr 2026,`（尾部残留逗号），以及 `April 9, 2026` 本身不含时间不受影响。

**改动**：

在步骤 3 的正则中增强对带逗号 + 时间 + AM/PM 的匹配：

```javascript
// 原：
const withoutTrailingTime = withoutDashHourMinute.replace(/\s+\d{1,2}[:.]\d{1,2}([:.]\d{1,2})?.*$/, '');

// 改为：
const withoutTrailingTime = withoutDashHourMinute
  .replace(/[,，]\s*\d{1,2}[:.]\d{1,2}([:.]\d{1,2})?\s*(AM|PM|am|pm)?.*$/i, '')
  .replace(/\s+\d{1,2}[:.]\d{1,2}([:.]\d{1,2})?\s*(AM|PM|am|pm)?.*$/i, '');
```

**处理流程**：
- `09 Apr 2026, 06:26:26 PM` → 第一个 replace 匹配 `, 06:26:26 PM` → 结果 `09 Apr 2026`
- `April 9, 2026` → 第一个 replace 不匹配（逗号后是空格 + 纯数字年份，没有时间模式）→ 保持不变

### 4.3 `parseEnglishMonthDateCandidate` 扩展

当前 patterns（normalizers.js:368-384）仅支持以连字符 `-` 或空格分隔的 4 种模式，且每个 regex 中月份部分要求 `[A-Za-z]{3,}`（至少 3 个字母）。

**新增 patterns**（在现有 4 个 pattern 之后追加）：

```javascript
// Pattern 5: "DD Mon YYYY" 以空格分隔（无连字符）
// 例如: "09 Apr 2026"（经 stripDateTimeSuffix 去除时间后）
{
  regex: /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/,
  resolve: (parts) => ({ year: parts[3], day: parts[1], monthName: parts[2] })
},

// Pattern 6: "Month DD, YYYY" 完整月份名 + 逗号
// 例如: "April 9, 2026"
{
  regex: /^([A-Za-z]{3,})\s+(\d{1,2})\s+(\d{4})$/,
  resolve: (parts) => ({ year: parts[3], day: parts[2], monthName: parts[1] })
}
```

注意：`parseEnglishMonthDateCandidate` 入口处已有 `.replace(/[，,]/g, ' ')` 和 `.replace(/\s+/g, ' ')` 的预处理，所以 `April 9, 2026` 会被先转换为 `April 9 2026`，可被 Pattern 6 的 regex 匹配。

**现有 patterns 验证**：

- Pattern 1 `^(\d{4})[\s-]+(\d{1,2})-([A-Za-z]{3,})$` — `YYYY DD-Mon`
- Pattern 2 `^(\d{1,2})-([A-Za-z]{3,})[\s-]+(\d{4})$` — `DD-Mon YYYY`
- Pattern 3 `^(\d{4})[\s-]+([A-Za-z]{3,})-(\d{1,2})$` — `YYYY Mon-DD`
- Pattern 4 `^([A-Za-z]{3,})-(\d{1,2})[\s-]+(\d{4})$` — `Mon-DD YYYY`

现有 Pattern 2 中 `[\s-]+` 要求月份名和年份之间有连字符或空格，但月份名后接空格的情况（如 `09-Apr 2026`）能匹配。纯空格分隔（如 `09 Apr 2026`）不匹配（因为 `\d{1,2}` 和 `[A-Za-z]` 之间需要 `-`）。所以 Pattern 5 是必要的。

### 4.4 验证矩阵

| 输入 | stripDateTimeSuffix 输出 | parseEnglishMonthDateCandidate 预处理 | 命中 Pattern | 解析结果 |
|------|--------------------------|--------------------------------------|-------------|---------|
| `09 Apr 2026, 06:26:26 PM` | `09 Apr 2026` | `09 Apr 2026` | 新 Pattern 5 | `2026-04-09` |
| `April 9, 2026` | `April 9, 2026` | `April 9 2026` | 新 Pattern 6 | `2026-04-09` |
| `9 April 2026` | `9 April 2026` | `9 April 2026` | 新 Pattern 5 | `2026-04-09` |
| `Apr 9, 2026` | `Apr 9, 2026` | `Apr 9 2026` | 新 Pattern 6 | `2026-04-09` |
| `09 Apr 2026` | `09 Apr 2026` | `09 Apr 2026` | 新 Pattern 5 | `2026-04-09` |
| `09-Apr 2026`（现有） | `09-Apr 2026` | `09-Apr 2026` | 现有 Pattern 2 | `2026-04-09` |
| `2026-04-09`（现有） | `2026-04-09` | 不含英文字母跳过 | N/A（走后续分支） | `2026-04-09` |

---

## 五、需求 3：导入模板包同名覆盖确认

### 5.1 实现方案

采用 Electron 原生 `dialog.showMessageBox` 在后端弹出确认框。理由：
- 无需新增 IPC 通道
- 无需修改 `preload.js`
- 同步阻塞导入流程，逻辑清晰

### 5.2 改动点：`template:import-bundle` handler（main.js:3467-3654）

在 `importedTemplates.forEach` 循环**之前**，新增同名模板检测逻辑：

```javascript
// 步骤 1：扫描 bundle 中所有 entry，收集存在同名模板的列表
const existingTemplateNames = [];
importedTemplates.forEach((entry) => {
  if (!entry.name || !entry.headers.length) return;
  const existingTemplate = entry.templateKey
    ? database.getTemplateByKey(entry.templateKey)
    : database.getTemplateByName(entry.name);
  if (existingTemplate) {
    existingTemplateNames.push(entry.name);
  }
});

// 步骤 2：如果有同名模板，弹出确认框
if (existingTemplateNames.length > 0) {
  const confirmResult = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '导入模板包',
    message: '以下模板已存在，导入将覆盖现有配置：',
    detail: existingTemplateNames.map((name) => `• ${name}`).join('\n') + '\n\n是否确认覆盖？',
    buttons: ['取消', '确认覆盖'],
    defaultId: 0,
    cancelId: 0
  });

  if (confirmResult.response === 0) {
    // 用户点击"取消"
    return { status: 'cancelled' };
  }
}

// 步骤 3：继续执行原有的 importedTemplates.forEach 循环
```

### 5.3 注意事项

- `dialog.showMessageBox` 是 `async` 的，当前 handler 已是 `async` 函数，可直接 `await`。
- 用户点击"取消"返回 `{ status: 'cancelled' }`，前端收到该 status 不做任何操作（与文件选择取消的行为一致）。
- 不存在同名模板时，跳过确认步骤，直接进入原有循环逻辑——行为不变。
- `getTemplateByKey` / `getTemplateByName` 在扫描阶段和循环阶段各调用一次。虽然有冗余查询，但模板数量通常很少（< 50），性能影响可忽略。

---

## 六、需求 4：使用手册导出格式扩展

### 6.1 改动点：`app:save-user-guide` handler（main.js:2419-2526）

#### 6.1.1 扩展 `showSaveDialog` filters

```javascript
const result = await dialog.showSaveDialog(mainWindow, {
  defaultPath: '使用手册',
  filters: [
    { name: '纯文本文件', extensions: ['txt'] },
    { name: 'Markdown 文件', extensions: ['md'] },
    { name: 'HTML 文件', extensions: ['html'] }
  ]
});
```

#### 6.1.2 按扩展名分支处理

```javascript
const ext = path.extname(result.filePath).toLowerCase();

if (ext === '.md') {
  // 直接写出原始 Markdown 内容
  fs.writeFileSync(result.filePath, markdown, 'utf8');
} else if (ext === '.txt') {
  // 去除 Markdown 标记后写出纯文本
  const plainText = stripMarkdown(markdown);
  fs.writeFileSync(result.filePath, plainText, 'utf8');
} else if (ext === '.html') {
  // Markdown 渲染为 HTML 后写出
  const htmlContent = markdownToHtml(markdown);
  fs.writeFileSync(result.filePath, htmlContent, 'utf8');
}
```

#### 6.1.3 `stripMarkdown` 函数

新增纯文本转换函数：

```javascript
function stripMarkdown(md) {
  return md
    // 移除代码块标记
    .replace(/```\w*\n/g, '')
    .replace(/```/g, '')
    // 移除标题标记
    .replace(/^#{1,6}\s+/gm, '')
    // 移除粗体/斜体
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // 移除行内代码
    .replace(/`([^`]+)`/g, '$1')
    // 移除引用块标记
    .replace(/^>\s+/gm, '')
    // 移除分割线
    .replace(/^---$/gm, '')
    // 保留表格文本但去除 | 边框
    .replace(/^\|(.+)\|$/gm, (match, content) => {
      const cells = content.split('|').map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) return '';
      return cells.join('\t');
    })
    // 清理多余空行
    .replace(/\n{3,}/g, '\n\n');
}
```

#### 6.1.4 `markdownToHtml` 函数

将 Markdown 内容转换为完整的 HTML 文档。可使用现有的正则 Markdown→HTML 转换逻辑，或引入第三方库（如 `marked`）。输出为包含 `<html>` / `<head>` / `<body>` 的完整 HTML 文件，可直接在浏览器中打开。

#### 6.1.5 导出后确认提示

导出成功后返回文件路径，前端弹出提示框：

```javascript
return {
  status: 'success',
  message: `使用手册导出成功：${result.filePath}`,
  filePath: result.filePath
};
```

前端收到 `status: 'success'` 后弹框展示 `message`（与现有提示逻辑一致）。

---

## 七、需求 5a：提取大账号顺序弹框 — 单滚动条

### 7.1 DOM 结构改造

**现有结构**（renderer-dialogs.js:914-930）：

```
extractDialog
  ├── .extract-file-list    (overflow-y: auto) ← 独立滚动条
  ├── .extract-order-list   (overflow-y: auto) ← 独立滚动条
  └── 完成按钮
```

**改造后结构**：

```
extractDialog
  ├── .extract-scroll-container  (overflow-y: auto)  ← 单滚动条
  │    ├── .extract-file-list    (overflow-y: visible / 不设 overflow)
  │    └── .extract-order-list   (overflow-y: visible / 不设 overflow)
  └── 完成按钮
```

### 7.2 CSS 改动

```css
.extract-scroll-container {
  display: flex;
  gap: 16px;
  overflow-y: auto;
  max-height: 60vh;   /* 与原 .extract-file-list / .extract-order-list 的 max-height 一致 */
}

.extract-file-list,
.extract-order-list {
  overflow-y: visible;  /* 覆盖原有 overflow-y: auto */
  max-height: none;     /* 覆盖原有 max-height */
  flex: 1;
}
```

### 7.3 JS 改动

删除 renderer-dialogs.js:917-930 的同步滚动逻辑（`extractSyncingScroll` + 两个 `addEventListener('scroll', ...)`）——因为单滚动条不需要手动同步。

---

## 八、需求 5b：大账号选择对话框 — 条件单滚动条 + 文本化

### 8.1 DOM 结构改造

**现有结构**（renderer-dialogs.js:624-637）：

```
dialog
  ├── fileListContainer    (overflow-y: auto) ← 独立滚动条
  ├── orderListContainer   (overflow-y: auto) ← 独立滚动条
  └── footer
```

**改造后结构**：

```
dialog
  ├── .ba-scroll-container          (条件切换 overflow-y)
  │    ├── fileListContainer
  │    └── orderListContainer
  └── footer
```

### 8.2 勾选"记住顺序"时的切换逻辑

在 `rememberCheckbox` 的 `change` 事件中：

```javascript
rememberCheckbox.addEventListener('change', () => {
  if (rememberCheckbox.checked) {
    // 切为单滚动条
    scrollContainer.style.overflowY = 'auto';
    fileListContainer.style.overflowY = 'visible';
    orderListContainer.style.overflowY = 'visible';
    // 删除双滚动条同步事件（或设标记跳过）
  } else {
    // 恢复双滚动条
    scrollContainer.style.overflowY = 'visible';
    fileListContainer.style.overflowY = 'auto';
    orderListContainer.style.overflowY = 'auto';
    // 恢复双滚动条同步事件
  }
});
```

### 8.3 右面板文本化渲染

勾选"记住顺序"时，调用 `renderOrderListAsText()` 将右面板从 checkbox 列表切换为纯文本只读显示：

- `orderListContainer` 添加 `.text-readonly` class（`pointer-events: none`）
- 遍历 `checkedOrder`，渲染为 `.big-account-order-text-item`（序号 + 文本）
- 取消勾选时调用 `renderOrderListAsCheckbox()` 恢复 checkbox 列表

### 8.4 JS 改动

删除或条件跳过 renderer-dialogs.js:624-637 的双滚动条同步逻辑：

- 新增 `isRememberMode` 标记
- `rememberCheckbox.checked === true` 时跳过手动 `scrollTop` 同步（单滚动条不需要）
- `rememberCheckbox.checked === false` 时保留双滚动条同步

---

## 九、需求 6：按正负号下拉框宽度修复

### 9.1 CSS 改动

```css
/* 原：styles.css:2042 */
.bill-split-sub-row .mapping-select {
  min-width: 200px;
}

/* 改为： */
.bill-split-sub-row .mapping-select {
  min-width: 260px;
  max-width: 260px;
}
```

使之与全局 `.mapping-select`（styles.css:323-325）的 `min-width: 260px; max-width: 260px` 一致。

---

## 十、需求 7：指定账单实现功能

### 10.1 数据库改动

#### 10.1.1 `template_bill_split_meta` 表扩展

新增两个字段：

| 字段名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `signed_amount_target_seq_nos` | TEXT | `''` | "按正负号拆分的发生额"指定的账单序号列表，逗号分隔，如 `1,3` |
| `by_field_amount_target_seq_nos` | TEXT | `''` | "按字段区分发生额"指定的账单序号列表，逗号分隔，如 `2` |

Migration 脚本（`migrations.js`）：

```javascript
if (!hasColumn(db, 'template_bill_split_meta', 'signed_amount_target_seq_nos')) {
  db.exec("ALTER TABLE template_bill_split_meta ADD COLUMN signed_amount_target_seq_nos TEXT NOT NULL DEFAULT '';");
}
if (!hasColumn(db, 'template_bill_split_meta', 'by_field_amount_target_seq_nos')) {
  db.exec("ALTER TABLE template_bill_split_meta ADD COLUMN by_field_amount_target_seq_nos TEXT NOT NULL DEFAULT '';");
}
```

向下兼容：新字段默认值为空字符串，旧数据读取时 `signedAmountTargetSeqNos` / `byFieldAmountTargetSeqNos` 为空字符串，解析为空数组。

#### 10.1.2 `template-repository.js` 扩展

`getBillSplitMeta`（template-repository.js:707-718）：

```javascript
function getBillSplitMeta(db, templateId) {
  const row = db.prepare(`
    SELECT
      signed_amount_source_field AS signedAmountSourceField,
      signed_amount_target_seq_nos AS signedAmountTargetSeqNos,
      by_field_amount_target_seq_nos AS byFieldAmountTargetSeqNos
    FROM template_bill_split_meta
    WHERE template_id = ?
  `).get(templateId);
  return {
    signedAmountSourceField: row ? normalizeText(row.signedAmountSourceField) : '',
    signedAmountTargetSeqNos: row && row.signedAmountTargetSeqNos
      ? row.signedAmountTargetSeqNos.split(',').filter(Boolean).map(Number)
      : [],
    byFieldAmountTargetSeqNos: row && row.byFieldAmountTargetSeqNos
      ? row.byFieldAmountTargetSeqNos.split(',').filter(Boolean).map(Number)
      : []
  };
}
```

`saveBillSplitMeta`（template-repository.js:720-737）扩展参数：

```javascript
function saveBillSplitMeta(db, templateId, meta = {}) {
  const now = new Date().toISOString();
  const signedField = normalizeText(meta && meta.signedAmountSourceField);
  const signedTargetSeqNos = Array.isArray(meta.signedAmountTargetSeqNos)
    ? meta.signedAmountTargetSeqNos.join(',')
    : '';
  const byFieldTargetSeqNos = Array.isArray(meta.byFieldAmountTargetSeqNos)
    ? meta.byFieldAmountTargetSeqNos.join(',')
    : '';
  // ... upsert 逻辑同原有，增加两个字段
}
```

### 10.2 后端 IPC 改动

`template:save-bill-split-meta`（main.js）handler 的 payload 新增两个字段：

```javascript
database.saveBillSplitMeta(templateId, {
  signedAmountSourceField: normalizeCell(payload.signedAmountSourceField),
  signedAmountTargetSeqNos: payload.signedAmountTargetSeqNos || [],
  byFieldAmountTargetSeqNos: payload.byFieldAmountTargetSeqNos || []
});
```

`template:get-bill-split-config` 返回值中 `billSplitMeta` 已包含完整 `getBillSplitMeta` 返回，无需额外改动。

### 10.3 前端 UI 改动：`createBillSplitRowsDialog`（renderer-dialogs.js:2880）

#### 10.3.1 新增 HTML 元素

在"按正负号拆分的发生额"下拉框右侧和"按字段区分发生额"的"发生额映射关系管理"按钮右侧各新增：

```html
<label class="bill-split-target-seq-label" hidden>
  <input type="checkbox" class="bill-split-target-seq-checkbox" />
  <span>指定账单实现功能</span>
</label>
<div class="bill-split-target-seq-picker" hidden>
  <button class="bill-split-target-seq-trigger secondary-btn small" type="button">选择账单序号</button>
  <div class="bill-split-target-seq-panel" hidden></div>
</div>
```

#### 10.3.2 显示/隐藏逻辑

```javascript
// "按正负号拆分的发生额" 行
signedSelect.addEventListener('change', () => {
  const hasValue = Boolean(signedSelect.value);
  signedTargetSeqLabel.hidden = !hasValue;
  if (!hasValue) {
    signedTargetSeqCheckbox.checked = false;
    signedTargetSeqPicker.hidden = true;
    // 清除并落库
    updateTargetSeqNos('signed', []);
  }
});

// "按字段区分发生额" 行
byFieldSelect.addEventListener('change', () => {
  const hasValue = byFieldSelect.value === '是';
  byFieldTargetSeqLabel.hidden = !hasValue;
  if (!hasValue) {
    byFieldTargetSeqCheckbox.checked = false;
    byFieldTargetSeqPicker.hidden = true;
    updateTargetSeqNos('byField', []);
  }
});
```

#### 10.3.3 多选下拉框交互

复用现有的多选下拉面板模式（与合并账单的 `bill-split-merge-picker` 类似）：

```javascript
function renderTargetSeqPanel(panel, currentSeqNos, selectedSeqNos) {
  panel.innerHTML = '';
  currentSeqNos.forEach((seqNo) => {
    const label = document.createElement('label');
    label.innerHTML = `
      <input type="checkbox" value="${seqNo}" ${selectedSeqNos.includes(seqNo) ? 'checked' : ''} />
      <span>账单 ${seqNo}</span>
    `;
    panel.appendChild(label);
  });
}
```

点击面板外区域收起并落库：

```javascript
dialog.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.bill-split-target-seq-picker')) {
    // 收起面板
    signedTargetSeqPanel.hidden = true;
    byFieldTargetSeqPanel.hidden = true;
    // 读取勾选结果并落库
    const selectedSeqNos = collectSelectedSeqNos(panel);
    updateTargetSeqNos(type, selectedSeqNos);
  }
});
```

#### 10.3.4 禁用对应行的 Credit/Debit 下拉框

在 `renderTableRow`（renderer-dialogs.js:3008）中，根据副区域（发生额映射关系管理）的配置状态决定禁用逻辑：

```javascript
const hasSubAreaValue = Boolean(currentBillSplitMeta.signedAmountSourceField) ||
  Boolean(currentBillSplitMeta.byFieldAmountSourceField);
const hasAnyDesignation = currentBillSplitMeta.signedAmountTargetSeqNos.length > 0 ||
  currentBillSplitMeta.byFieldAmountTargetSeqNos.length > 0;
const isTargetedBySigned = currentBillSplitMeta.signedAmountTargetSeqNos.includes(row.seqNo);
const isTargetedByField = currentBillSplitMeta.byFieldAmountTargetSeqNos.includes(row.seqNo);
const isTargetedByAny = isTargetedBySigned || isTargetedByField;

// 在非合并、非完成态的编辑行中：
if (!isMerged && !isCompleted) {
  if (hasSubAreaValue && !hasAnyDesignation) {
    // 副区域有值但未勾选任何"指定账单实现功能" → 所有行 Credit/Debit 禁用
    creditSel.disabled = true;
    debitSel.disabled = true;
  } else if (hasSubAreaValue && hasAnyDesignation) {
    if (isTargetedByAny) {
      // 被选定的账单序号行 → Credit/Debit 禁用
      creditSel.disabled = true;
      debitSel.disabled = true;
    } else {
      // 未被选定的账单序号行 → Credit/Debit 可用
      creditSel.disabled = false;
      debitSel.disabled = false;
    }
  }
}
```

#### 10.3.5 落库函数

```javascript
function updateTargetSeqNos(type, seqNos) {
  if (type === 'signed') {
    currentBillSplitMeta.signedAmountTargetSeqNos = seqNos;
  } else {
    currentBillSplitMeta.byFieldAmountTargetSeqNos = seqNos;
  }
  desktopApi.templates.saveBillSplitMeta({
    templateId: template.id,
    signedAmountSourceField: currentBillSplitMeta.signedAmountSourceField,
    signedAmountTargetSeqNos: currentBillSplitMeta.signedAmountTargetSeqNos,
    byFieldAmountTargetSeqNos: currentBillSplitMeta.byFieldAmountTargetSeqNos
  });
  // 重新渲染表格行以更新禁用状态
  rerenderTable();
}
```

### 10.4 后端 file-service 改动

`file-service.js` 在处理拆分/合并账单的发生额逻辑时（file-service.js:141 和 file-service.js:215），需要检查当前行的 `seqNo` 是否在 `signedAmountTargetSeqNos` / `byFieldAmountTargetSeqNos` 中。如果是，则该行的 `creditSourceField` / `debitSourceField` / `amountSourceField` 来自"指定账单实现功能"的功能模块配置，而非该行自身的下拉框值。

### 10.5 Bundle 导出/导入

`listTemplateBundleEntries`（main.js）返回的 `billSplitMeta` 已包含完整 `getBillSplitMeta` 返回值（含新增的两个字段）。导入时 `saveBillSplitMeta` 同样透传新字段。无需额外改动。

---

## 十一、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `docs(v1.5.0-fix2): add PRD and TechDoc` | `PRD-v1.5.0-fix2.md`, `TechDoc-v1.5.0-fix2.md` | -- |
| 2 | `fix(v1.5.0-fix2): rename module name (requirement 1)` | `index.html`, `renderer.js` | 1 |
| 3 | `feat(v1.5.0-fix2): english date format parsing (requirement 2)` | `normalizers.js` | 2 |
| 4 | `feat(v1.5.0-fix2): bundle import overwrite confirmation (requirement 3)` | `main.js` | 3 |
| 5 | `feat(v1.5.0-fix2): user guide export multi-format (requirement 4)` | `main.js` | 4 |
| 6 | `refactor(v1.5.0-fix2): extract dialog single scrollbar (requirement 5a)` | `renderer-dialogs.js`, `styles.css` | 5a |
| 7 | `feat(v1.5.0-fix2): big account dialog conditional single scrollbar (requirement 5b)` | `renderer-dialogs.js`, `styles.css` | 5b |
| 8 | `fix(v1.5.0-fix2): signed amount select width alignment (requirement 6)` | `styles.css` | 6 |
| 9 | `feat(v1.5.0-fix2): designate bills for amount feature (requirement 7)` | `migrations.js`, `template-repository.js`, `database.js`, `main.js`, `renderer-dialogs.js`, `styles.css`, `file-service.js` | 7 |

---

## 十二、Open Technical Questions（无）

本版本技术实现方案明确，无待定的技术问题。
