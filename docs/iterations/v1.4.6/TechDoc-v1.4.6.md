# 技术设计文档 - 网银账单小助手 v1.4.6

| 项目 | 内容 |
|------|------|
| 版本 | v1.4.6 |
| 日期 | 2026-03-27 |
| 状态 | 评审中 |
| 前置文档 | PRD-v1.4.6.md |
| 参考文档 | TechDoc-v1.4.2.md, TechDoc-v1.4.3.md |

---

## 一、概述

本文档是 v1.4.6 的技术设计方案，包含 5 项需求的实现细节。按 PRD 确认的实施顺序：需求3 → 需求2 → 需求1 → 需求5 → 需求4A → 需求4B。

**涉及的核心源文件**：

| 文件 | 当前行数 | 变更类型 |
|------|---------|---------|
| `src/styles.css` | ~1535 | 修改 |
| `src/renderer.js` | ~2967 | 修改 |
| `src/renderer-dialogs.js` | ~1833 | 修改 |
| `src/preload.js` | 51 | 修改 |
| `src/main.js` | ~4651 | 修改 |
| `src/backend/bank-account-import.js` | 新增 | 新增 |
| `src/backend/own-account-store.js` | 新增 | 新增 |
| `src/backend/balance-adjustment-store.js` | 新增 | 新增 |

---

## 二、需求 3：按钮文本溢出

### 2.1 修改点清单

#### `src/styles.css`

**`.small` 类**（第 298-301 行）：

当前代码：

```css
.small {
  min-width: 108px;
  height: 38px;
}
```

新增溢出保护属性（使用组合选择器，避免影响非按钮元素）：

在 `.small` 类之后（约第 302 行）新增：

```css
.primary-btn.small,
.secondary-btn.small,
.danger-btn.small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

**说明**：经代码审查确认，`.small` 在当前代码中始终与 `.primary-btn`、`.secondary-btn`、`.danger-btn` 组合使用（含 `.concat-picker-trigger` 继承 `.secondary-btn.small`）。使用组合选择器而非直接修改 `.small` 基类，可避免未来 `.small` 被非按钮元素复用时产生副作用。`.concat-picker-trigger`（第 869-872 行）的 `min-width: 80px` 和 `height: 34px` 覆盖不受影响，溢出保护从 `.secondary-btn.small` 继承。

### 2.2 影响分析

- 仅 CSS 变更，无 JS 逻辑改动
- 所有使用 `.primary-btn.small`、`.secondary-btn.small`、`.danger-btn.small` 的按钮均受影响，需视觉确认无截断异常
- `.concat-picker-trigger` 的 `min-width: 80px` 足以容纳"选择字段"四个字（约 56px + padding），正常不会触发省略号；但如有更长文本（如回显已选字段名）则省略号生效

---

## 三、需求 2：模板选择框初始值

### 3.1 修改点清单

#### `src/renderer.js`

**`updateTemplateSelect` 函数**（第 1595-1619 行）：

当前代码（第 1611-1618 行）：

```javascript
const preserved = state.templates.find((template) => String(template.id) === previous);
const fallback = state.templates[0];
state.selectedTemplateId = preserved
  ? String(preserved.id)
  : fallback
    ? String(fallback.id)
    : '';
elements.templateSelect.value = state.selectedTemplateId || '';
```

修改为：

```javascript
const preserved = state.templates.find((template) => String(template.id) === previous);
state.selectedTemplateId = preserved
  ? String(preserved.id)
  : '';
elements.templateSelect.value = state.selectedTemplateId || '';
```

**变更说明**：

- 删除 `const fallback = state.templates[0]` 及其对应的 fallback 分支
- 当 `previous === ''`（初始状态）时，`preserved` 为 `undefined`，`state.selectedTemplateId` 保持 `''`，下拉框显示 placeholder "请选择模板"
- 当 `previous` 有值但对应模板已被删除时（`preserved` 为 `undefined`），`state.selectedTemplateId` 重置为 `''`，下拉框回到"请选择模板"
- `state.selectedTemplateId` 在 `state` 对象初始化时已是 `''`（第 52 行），启动时首次调用 `updateTemplateSelect` 时 `previous === ''`，不会 fallback

### 3.2 AC2-7：导入文件守卫

#### `src/renderer.js`

**`handleImportFile` 函数**（第 2600-2618 行）：

当前代码（第 2606 行）：

```javascript
const templateId = Number(state.selectedTemplateId);
```

`Number('')` 结果为 `0`，会将 `0` 传给后端。在此行之前加入守卫：

```javascript
async function handleImportFile() {
  if (!state.hasEnum) {
    setStatus(getEnumStatusMessage(), 'error');
    return;
  }

  if (!state.selectedTemplateId) {
    setStatus('请先选择模板', 'error');
    return;
  }

  const templateId = Number(state.selectedTemplateId);
  // ... 后续不变
```

### 3.3 AC2-8：导出状态重置

在 `updateTemplateSelect` 函数末尾（修改后的 `state.selectedTemplateId` 赋值之后），增加导出可用状态的同步重置：

```javascript
const preserved = state.templates.find((template) => String(template.id) === previous);
state.selectedTemplateId = preserved
  ? String(preserved.id)
  : '';
elements.templateSelect.value = state.selectedTemplateId || '';

// AC2-8：模板清空时重置导出按钮
if (!state.selectedTemplateId) {
  setExportAvailability({ detailEnabled: false, balanceEnabled: false });
}
```

`setExportAvailability`（第 986-991 行）已有禁用逻辑，直接复用。

### 3.4 AC2-9：删除模板后清除 lastGeneratedExports

#### `src/main.js`

**`template:delete` handler**（第 2793-2803 行）：

在 `database.deleteTemplate(templateId)` 之后、`return` 之前，增加缓存清除：

```javascript
ipcMain.handle('template:delete', (_event, templateId) => {
  const template = database.getTemplate(templateId);
  database.deleteTemplate(templateId);
  syncTemplateLibraryFile();

  // AC2-9：清除可能残留的导出缓存
  clearGeneratedExports();

  appendActivityLogEntry({
    level: 'info',
    message: '删除模板成功',
    details: [`模板名：${template?.name || templateId}`]
  });
  return { status: 'success' };
});
```

`clearGeneratedExports`（第 1511-1521 行）重置 `detail`、`balance` 等字段为 `null`，保留 `newAccount`（新开账户模块独立）。

### 3.5 影响分析

- `refreshTemplates`（第 1621-1624 行）调用 `updateTemplateSelect`，同一会话内已选模板可通过 `preserved` 保留
- 用户删除当前选中模板后，下拉框回到"请选择模板"而非自动选中第一个——这是 AC2-6 的期望行为
- AC2-7 守卫确保未选模板时不会将 `templateId=0` 传给后端
- AC2-8 确保模板清空后导出按钮立即禁用
- AC2-9 确保删除模板后不能通过缓存导出已删除模板的旧数据
- 不影响 `template:import` 后的 `refreshTemplates` 调用：如果用户之前已选模板且未被删除，仍然保留

---

## 四、需求 1：多币种枚举缺失 + 币种大写强制

### 4.1 枚举缺失排查

经代码审查确认：`createBigAccountManagerDialog`（`renderer-dialogs.js:799-1204`）仅有一套实现路径。第 831 行 `const currencyOptionEntries = getCurrencyOptionEntries()` 已从 `state.currencyOptions`（`app:get-info` 返回的完整币种列表）正确获取数据。`renderCurrencyDropdownOptions`（第 858-890 行）遍历的也是 `currencyOptionEntries`。

**排查步骤**（开发实施时执行）：

1. 检查 `assets/币种映射表.xlsx` 文件是否完整存在
2. 在开发环境中确认 `getAvailableCurrencyCodes()`（`main.js:793-824`）返回的数组长度
3. 在渲染进程中 `console.log(state.currencyOptions.length)` 确认数据传递完整
4. 如以上均正常，则枚举缺失部分标记为"已确认无代码修改"（NFR-5）

### 4.2 币种大写强制

#### `src/renderer-dialogs.js`

**`createBigAccountRow` 函数内的 `toggleCompleteBtn` click handler**（第 1073-1106 行）：

当前代码（第 1073-1076 行）：

```javascript
toggleCompleteBtn.addEventListener('click', () => {
  if (row.dataset.mode === 'edit') {
    const validationMessage = validateRowDraft();
```

修改为：

```javascript
toggleCompleteBtn.addEventListener('click', () => {
  if (row.dataset.mode === 'edit') {
    if (!multiCheckbox.checked) {
      currencyInput.value = currencyInput.value.trim().toUpperCase();
      renderCurrencyInputSuggestion();
    }
    const validationMessage = validateRowDraft();
```

**变更说明**：

- 在 `validateRowDraft()` 之前执行大写转换，确保校验和后续 `getRowDraft()` 取到的都是大写值
- 仅在单币种模式下（`!multiCheckbox.checked`）执行，多币种模式通过下拉框选择的值来自 `getCurrencyOptionEntries()`，本身已是标准大写代码
- 调用 `renderCurrencyInputSuggestion()` 更新 ghost input，防止转大写后 ghost 文本与 active 值不一致
- `currencyView` 的文本在第 1085 行由 `formatBigAccountCurrencySummary(draft.currencies)` 设置，`draft.currencies` 来自 `getRowDraft()`（第 997 行：`currencyInput.value.trim()`），此时已是大写值

### 4.3 影响分析

- 仅影响维护大账号对话框的单币种输入场景
- 不影响 `createBigAccountSelectionDialog`（第 459-797 行）的币种输入——该对话框使用独立的 `createCurrencyControl`（第 567-639 行），有自己的 ghost input 逻辑
- 不影响新开账户模块的币种输入（`renderer.js` 中的 `ensureCurrencyGhostShell`）

---

## 五、需求 5：新开账户余额账单逻辑

### 5.1 修改点清单

#### `src/main.js`

**`buildNewAccountBillDates` 函数**（第 1940-1962 行）：

当前代码：

```javascript
function buildNewAccountBillDates(openDate, today = new Date()) {
  const normalizedOpenDate = normalizeDateOnly(openDate);
  const normalizedToday = normalizeDateOnly(today);

  if (normalizedOpenDate.getTime() > normalizedToday.getTime()) {
    throw new FileValidationError('FILE_READ', '开户日期不能晚于今日');
  }

  const dateMap = new Map([[formatDateLabel(normalizedOpenDate), normalizedOpenDate]]);
  let cursor = new Date(normalizedOpenDate.getFullYear(), normalizedOpenDate.getMonth(), 1);

  while (cursor.getTime() <= normalizedToday.getTime()) {
    const monthEndDate = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);

    if (monthEndDate.getTime() >= normalizedOpenDate.getTime() && monthEndDate.getTime() <= normalizedToday.getTime()) {
      dateMap.set(formatDateLabel(monthEndDate), normalizeDateOnly(monthEndDate));
    }

    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return Array.from(dateMap.values()).sort((left, right) => left.getTime() - right.getTime());
}
```

替换为：

```javascript
function buildNewAccountBillDates(openDate, today = new Date()) {
  const normalizedOpenDate = normalizeDateOnly(openDate);
  const normalizedToday = normalizeDateOnly(today);

  if (normalizedOpenDate.getTime() > normalizedToday.getTime()) {
    throw new FileValidationError('FILE_READ', '开户日期不能晚于今日');
  }

  const totalDays = Math.round(
    (normalizedToday.getTime() - normalizedOpenDate.getTime()) / (24 * 60 * 60 * 1000)
  ) + 1;

  if (totalDays > 3650) {
    throw new FileValidationError('FILE_READ', '开户日期距今超过 10 年，不支持生成');
  }

  const dates = [];
  let cursor = new Date(normalizedOpenDate.getTime());

  while (cursor.getTime() <= normalizedToday.getTime()) {
    dates.push(normalizeDateOnly(new Date(cursor.getTime())));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}
```

**变更说明**：

- 在循环之前通过日期差计算 `totalDays`，超过 3650 天直接抛错，避免大循环
- `+1` 因为含两端（开户日期和今天都算）
- 用 `cursor.setDate(cursor.getDate() + 1)` 逐天递增，`normalizeDateOnly` 确保时间部分归零
- 返回数组已按时间升序（cursor 从早到晚），无需额外排序
- 删除原 `dateMap` 和月末生成逻辑

### 5.2 影响分析

- `buildNewAccountBillDates` 仅在 `buildNewAccountBalanceRecords`（第 1999-2041 行）中被调用
- `buildNewAccountBalanceRecords` 遍历每个日期生成余额行（`期末余额: 0`），数据格式不变
- 性能：3650 天 * 3 币种 = ~11000 行，`writeBalanceWorkbook` 使用 `xlsx` 库写入，实测应在 5 秒内完成（NFR-3）

---

## 六、需求 4A：导入银行账号信息

### 6.1 新增模块：`src/backend/bank-account-import.js`

新建文件，职责：解析银行账号信息 Excel，按条件提取客资/自有账号。

```javascript
const { readRows } = require('./file-service/readers');
const { normalizeCell, FileValidationError } = require('./file-service');

const REQUIRED_COLUMNS = ['账户性质', '账户状态', '是否参与对账', '银行账号', '币种'];

function parseBankAccountExcel(filePath) {
  const rows = readRows(filePath);

  if (!rows || rows.length <= 1) {
    throw new FileValidationError('FILE_READ', '导入的文件为空或只有表头');
  }

  const headerRow = rows[0];
  const columnIndexMap = new Map();

  headerRow.forEach((cell, index) => {
    const normalizedName = normalizeCell(cell);
    if (normalizedName && !columnIndexMap.has(normalizedName)) {
      columnIndexMap.set(normalizedName, index);
    }
  });

  // 检查必需列
  const missingColumns = REQUIRED_COLUMNS.filter(
    (columnName) => !columnIndexMap.has(columnName)
  );

  if (missingColumns.length) {
    throw new FileValidationError(
      'FILE_READ',
      `导入的文件中缺少必需列：${missingColumns.join('、')}`
    );
  }

  const accountNatureIndex = columnIndexMap.get('账户性质');
  const accountStatusIndex = columnIndexMap.get('账户状态');
  const reconFlagIndex = columnIndexMap.get('是否参与对账');
  const bankAccountIndex = columnIndexMap.get('银行账号');
  const currencyIndex = columnIndexMap.get('币种');

  const clientAccountMap = new Map(); // merchantId -> Set<currency>
  const ownAccountMap = new Map();    // merchantId -> Set<currency>
  let skippedCount = 0;

  rows.slice(1).forEach((row) => {
    const accountNature = normalizeCell(row[accountNatureIndex]);
    const accountStatus = normalizeCell(row[accountStatusIndex]);
    const reconFlag = normalizeCell(row[reconFlagIndex]);
    const bankAccount = normalizeCell(row[bankAccountIndex]);
    const rawCurrency = normalizeCell(row[currencyIndex]);
    const currency = rawCurrency.toUpperCase(); // AC4A-17: trim + toUpperCase

    if (accountStatus !== '正常' || reconFlag !== '是') {
      return;
    }

    if (!bankAccount || !currency) {
      skippedCount += 1;
      return;
    }

    if (accountNature === '客资') {
      if (!clientAccountMap.has(bankAccount)) {
        clientAccountMap.set(bankAccount, new Set());
      }
      clientAccountMap.get(bankAccount).add(currency);
    } else if (accountNature === '自有') {
      if (!ownAccountMap.has(bankAccount)) {
        ownAccountMap.set(bankAccount, new Set());
      }
      ownAccountMap.get(bankAccount).add(currency);
    }
  });

  function buildAccountList(accountMap) {
    return Array.from(accountMap.entries()).map(([merchantId, currencySet]) => {
      const currencies = Array.from(currencySet);
      return {
        merchantId,
        currencies,
        isMultiCurrency: currencies.length > 1
      };
    });
  }

  return {
    clientAccounts: buildAccountList(clientAccountMap),
    ownAccounts: buildAccountList(ownAccountMap),
    skippedCount
  };
}

module.exports = {
  parseBankAccountExcel
};
```

**关键设计决策**：

- 复用 `readRows`（`readers.js`）读取 Excel，天然支持 `.xlsx` 和 `.xls`（NFR-1）
- 列名匹配使用 `normalizeCell` 去除前后空格
- 币种值经过 `normalizeCell`（trim）+ `toUpperCase()` 处理，不经过 `resolveCurrencyValue` 映射（PRD AC4A-17 确认）
- 同一银行账号多行自动合并到 `currencies` 数组
- `isMultiCurrency` 由 `currencies.length > 1` 决定
- 返回 `skippedCount` 表示因银行账号或币种为空被跳过的行数，渲染进程通过状态栏提示用户

### 6.2 自有账号存储

#### 新增模块：`src/backend/own-account-store.js`

独立模块，不放在 `bank-account-import.js` 内。理由：`bank-account-import.js` 职责为"解析 Excel 并返回数据"（纯函数、无副作用），而 `own-account-store.js` 职责为"文件系统读写持久化"（有副作用）。两者生命周期不同——解析在导入按钮点击时调用，持久化在"完成"按钮点击时调用。与 `balance-seed-store.js`（余额种子持久化）平行的设计模式。PRD 影响范围表建议同步更新，增加此新模块。

```javascript
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCell } = require('./file-service');

function getOwnAccountsDir(storageRoot) {
  return path.join(storageRoot, 'own-accounts');
}

function sanitizeBankName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .trim() || 'unknown-bank';
}

function getOwnAccountFilePath(storageRoot, bankName) {
  return path.join(getOwnAccountsDir(storageRoot), `${sanitizeBankName(bankName)}.json`);
}

function readOwnAccounts(storageRoot, bankName) {
  const filePath = getOwnAccountFilePath(storageRoot, bankName);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeOwnAccounts(storageRoot, bankName, accounts) {
  const filePath = getOwnAccountFilePath(storageRoot, bankName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(accounts, null, 2)}\n`, 'utf8');
}

module.exports = {
  readOwnAccounts,
  writeOwnAccounts
};
```

**路径命名**：使用 `bankName`（`splitTemplateName` 取模板名第一段）而非 `templateId`，与 `balance-seed-store.js:31-33` 保持一致（PRD 确认）。

### 6.3 IPC 通道

#### `src/preload.js`

在 `templates` 分组内新增（第 37 行后）：

```javascript
bigAccount: {
  importBankInfo: (templateId) => ipcRenderer.invoke('big-account:import-bank-info', templateId)
},
```

**完整修改位置**：在 `contextBridge.exposeInMainWorld('desktopApi', { ... })` 内，`files` 分组之前插入 `bigAccount` 分组。

#### `src/main.js`

新增 `registerBigAccountHandlers` 函数（在 `registerFileHandlers` 之前定义，约第 3892 行附近）：

```javascript
function registerBigAccountHandlers() {
  ipcMain.handle('big-account:import-bank-info', async (_event, templateId) => {
    const template = database.getTemplate(templateId);

    if (!template) {
      return createErrorResult({
        step: '导入银行账号信息',
        message: '未找到对应模板',
        errorCode: 'TEMPLATE_NOT_FOUND',
        context: { templateId }
      });
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Excel',
          extensions: ['xlsx', 'xls']
        }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    const selectedPath = result.filePaths[0];

    try {
      const parsed = parseBankAccountExcel(selectedPath);

      if (!parsed.clientAccounts.length && !parsed.ownAccounts.length) {
        return createErrorResult({
          step: '导入银行账号信息',
          message: '未找到符合条件的银行账号信息',
          errorCode: 'BANK_ACCOUNT_IMPORT_EMPTY',
          templateName: template.name
        });
      }

      appendActivityLogEntry({
        level: 'info',
        message: '导入银行账号信息成功',
        details: [
          `模板名：${template.name}`,
          `源文件：${selectedPath}`,
          `客资账号：${parsed.clientAccounts.length} 个`,
          `自有账号：${parsed.ownAccounts.length} 个`
        ]
      });

      const skippedNote = parsed.skippedCount > 0
        ? `（${parsed.skippedCount} 行因银行账号或币种为空被跳过）`
        : '';

      return {
        status: 'success',
        message: `已导入 ${parsed.clientAccounts.length} 个客资账号、${parsed.ownAccounts.length} 个自有账号${skippedNote}`,
        clientAccounts: parsed.clientAccounts,
        ownAccounts: parsed.ownAccounts
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '导入银行账号信息',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          templateName: template.name
        });
      }

      return createErrorResult({
        step: '导入银行账号信息',
        message: '导入失败，请导出报错文件查看详情',
        errorCode: 'BANK_ACCOUNT_IMPORT_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        templateName: template.name
      });
    }
  });
}
```

**注册位置**：在 `app.whenReady()` 的 `.then()` 回调中（第 4625-4633 行），在 `registerFileHandlers()` 之前加一行：

```javascript
registerBigAccountHandlers();
```

**导入语句**：在 `main.js` 文件顶部（约第 11 行后）新增：

```javascript
const { parseBankAccountExcel } = require('./backend/bank-account-import');
const { readOwnAccounts, writeOwnAccounts } = require('./backend/own-account-store');
```

**IPC 职责分工**：

- 主进程：弹出文件选择 → 调用 `parseBankAccountExcel` 解析 → 返回 `{ clientAccounts, ownAccounts }` 给渲染进程
- 渲染进程：收到数据后重新渲染 tbody（客资账号），暂存自有账号
- 持久化时机：用户点击"完成"后，渲染进程通过现有 `template:save-mappings` 保存客资账号（bigAccounts）；自有账号通过新增逻辑在同一"完成"回调中保存

### 6.4 渲染进程：维护大账号对话框

#### `src/renderer-dialogs.js`

**`createBigAccountManagerDialog` 函数签名变更**（第 799 行）：

当前签名：

```javascript
function createBigAccountManagerDialog({ bigAccounts, onDone, onCancel }) {
```

修改为（新增 `templateId` 和 `templateName` 参数）：

```javascript
function createBigAccountManagerDialog({ bigAccounts, templateId, templateName, onDone, onCancel }) {
```

**调用方适配**：`createBigAccountManagerDialog` 有两处调用方，均需传入新参数：

1. **`renderer-dialogs.js:1532`**（`createMappingDialog` 内的 `manageBigAccountBtn` click handler）：

```javascript
openModal(createBigAccountManagerDialog({
  bigAccounts: currentBigAccounts,
  templateId: payload.template.id,       // 新增
  templateName: payload.template.name,   // 新增
  onDone: (nextBigAccounts, extra) => {  // 扩展签名
    // ... 保存自有账号 ...
    openModal(createMappingDialog({
      ...payload,
      // ...
    }));
  },
  onCancel: () => { /* ... */ }
}));
```

2. **`renderer.js:2377`**（同样的 `manageBigAccountBtn` click handler，legacy 路径）：

```javascript
openModal(createBigAccountManagerDialog({
  bigAccounts: currentBigAccounts,
  templateId: payload.template.id,       // 新增
  templateName: payload.template.name,   // 新增
  onDone: (nextBigAccounts, extra) => {  // 扩展签名
    // ... 保存自有账号 ...
    openModal(createMappingDialog({
      ...payload,
      // ...
    }));
  },
  onCancel: () => { /* ... */ }
}));
```

**`payload.template`** 在 `createMappingDialog` 上下文中始终可用（来自 `template:get-mappings` 返回的 `result`），包含 `id` 和 `name` 属性。

**6.4.1 新增"导入银行账号信息"按钮**

在第 1170 行 `dialog.querySelector('[data-action="add"]')` 的事件绑定之后，需要先修改对话框的 HTML 模板。查找对话框 footer 区域的 HTML（约在 `createBigAccountManagerDialog` 函数内构建 dialog innerHTML 的位置），在 `[data-action="add"]` 按钮后新增按钮：

```html
<button class="secondary-btn small" type="button" data-action="import-bank-info">导入银行账号信息</button>
<button class="secondary-btn small" type="button" data-action="balance-management">余额管理</button>
```

**6.4.2 导入按钮事件处理**

在第 1173 行（`[data-action="add"]` 的 click handler）之后新增：

```javascript
dialog.querySelector('[data-action="import-bank-info"]').addEventListener('click', async () => {
  cleanupFloatingDropdown();

  if (!templateId) {
    setStatus('请先选择模板', 'error');
    return;
  }

  const result = await window.desktopApi.bigAccount.importBankInfo(templateId);

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status === 'error') {
    setStatus(result.message, 'error');
    return;
  }

  // 暂存自有账号，"完成"时持久化
  pendingOwnAccounts = result.ownAccounts || [];

  // 替换 tbody 内容为客资账号
  tbody.innerHTML = '';
  const clientAccounts = result.clientAccounts || [];

  if (clientAccounts.length === 0) {
    tbody.appendChild(createBigAccountRow({}, 'edit'));
  } else {
    clientAccounts.forEach((item) => {
      tbody.appendChild(createBigAccountRow(item, 'view'));
    });
  }

  setStatus(result.message, 'success');
});
```

**6.4.3 需要维护的闭包变量**

在 `createBigAccountManagerDialog` 函数内部、`tbody` 声明附近新增：

```javascript
let pendingOwnAccounts = null;
```

**已知限制**：`pendingOwnAccounts` 在导入时被赋值，如果用户导入后又手动新增/删除客资账号行再点击"完成"，`pendingOwnAccounts` 仍保留上次导入的自有账号数据。用户无法单独取消自有账号的导入而保留客资账号的编辑。这是 v1.4.6 的已知限制——导入操作是客资 + 自有的原子动作，取消需整体取消（关闭对话框）。

**6.4.4 "完成"按钮回调修改**

在第 1174-1198 行的 `[data-action="done"]` click handler 中，`onDone(nextBigAccounts)` 调用之前，增加自有账号的传递：

```javascript
// 原代码第 1198 行
onDone(nextBigAccounts);
```

修改为：

```javascript
onDone(nextBigAccounts, { ownAccounts: pendingOwnAccounts });
```

**6.4.5 `onDone` 回调的上游修改**

`createBigAccountManagerDialog` 的 `onDone` 回调定义在两处调用方（`renderer-dialogs.js:1534` 和 `renderer.js:2379`）。需要在调用方接收第二个参数 `extra`，在 `createMappingDialog` 的 `saveMappings` 成功后保存自有账号。

**`renderer-dialogs.js:1534`**（`createMappingDialog` 内）：

```javascript
onDone: async (nextBigAccounts, extra) => {
  // 如果有导入的自有账号，先异步保存
  if (extra && extra.ownAccounts) {
    await window.desktopApi.bigAccount.saveOwnAccounts({
      templateId: payload.template.id,
      accounts: extra.ownAccounts
    });
  }
  openModal(createMappingDialog({
    ...payload,
    mappings: draftMappings.map((mapping) => {
      return mapping.templateField === 'MerchantId'
        ? { ...mapping, mappedField: MERCHANT_ID_SELF_INPUT_OPTION, mappedFields: [] }
        : mapping;
    }),
    bigAccounts: nextBigAccounts,
    fixedAssignments: currentFixedAssignments
  }));
},
```

**`renderer.js:2379`**（同理适配）。

**`saveOwnAccounts` 调用时机澄清**：PRD 要求"客资账号和自有账号均在点击'完成'后才持久化"——这里的"完成"指的是**大账号对话框**的"完成"按钮（`[data-action="done"]`），而非映射对话框的"完成"。因此 `saveOwnAccounts` 在大账号对话框的 `onDone` 回调中立即触发，与客资账号通过 `openModal(createMappingDialog({...}))` 回传到映射对话框的时机一致。

具体流程：
1. 用户在大账号对话框点击"完成" → 触发 `onDone(nextBigAccounts, { ownAccounts })` 回调
2. 回调中先 `await saveOwnAccounts`（自有账号持久化到 JSON 文件）
3. 然后 `openModal(createMappingDialog({...}))` 将客资账号（`nextBigAccounts`）传回映射对话框
4. 用户在映射对话框点击"完成" → `template:save-mappings` 将客资账号（`bigAccounts`）持久化到数据库

注意：自有账号保存不阻断映射管理的重新打开——即使 `saveOwnAccounts` 失败，映射仍然可以重新渲染。使用 `await` 确保保存在映射对话框重建前完成，但不做错误弹窗（静默失败，依赖 activity log 记录）。

需要在 `src/preload.js` 和 `src/main.js` 中新增自有账号保存的 IPC 通道：

**`src/preload.js`**：在 `bigAccount` 分组内新增：

```javascript
bigAccount: {
  importBankInfo: (templateId) => ipcRenderer.invoke('big-account:import-bank-info', templateId),
  saveOwnAccounts: (payload) => ipcRenderer.invoke('big-account:save-own-accounts', payload)
},
```

**`src/main.js`**：在 `registerBigAccountHandlers` 内新增：

```javascript
ipcMain.handle('big-account:save-own-accounts', (_event, payload = {}) => {
  try {
    const template = database.getTemplate(payload.templateId);
    if (!template) {
      return { status: 'error', message: '未找到对应模板' };
    }

    const bankNameParts = splitTemplateName(template.name);
    writeOwnAccounts(ensureStorageRoot(), bankNameParts.bankName, payload.accounts || []);

    return { status: 'success' };
  } catch (error) {
    return createErrorResult({
      step: '保存自有账号',
      message: '自有账号保存失败',
      errorCode: 'OWN_ACCOUNT_SAVE_RUNTIME',
      errorType: '系统错误',
      originalError: error
    });
  }
});
```

### 6.5 注意事项

- `readRows`（`readers.js:189`）已支持 `.xlsx` 和 `.xls`，无需额外适配
- 导入仅修改对话框内存中的 tbody 和 `pendingOwnAccounts` 变量，不直接写入数据库
- 用户点击"完成"时，客资账号通过现有 `template:save-mappings` 路径保存到 `bigAccounts`；自有账号通过新增 `big-account:save-own-accounts` 路径保存到 JSON 文件
- 两者持久化时机一致，都在"完成"时触发

---

## 七、需求 4B：余额管理

### 7.1 新增模块：`src/backend/balance-adjustment-store.js`

复用 `balance-seed-store.js` 的文件管理模式。

```javascript
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCell, parseNumericValue, parseDateValue } = require('./file-service');

function sanitizeBankName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .trim() || 'unknown-bank';
}

function getBalanceAdjustmentsDir(storageRoot) {
  return path.join(storageRoot, 'balance-adjustments');
}

function getBalanceAdjustmentFilePath(storageRoot, bankName) {
  const safeBankName = sanitizeBankName(bankName);
  return path.join(getBalanceAdjustmentsDir(storageRoot), `${safeBankName}.json`);
}

function readBalanceAdjustments(storageRoot, bankName) {
  const filePath = getBalanceAdjustmentFilePath(storageRoot, bankName);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((record) => ({
        merchantId: normalizeCell(record.merchantId),
        currency: normalizeCell(record.currency),
        effectiveDate: normalizeCell(record.effectiveDate),
        adjustmentValue: parseNumericValue(record.adjustmentValue),
        remark: normalizeCell(record.remark),
        templateName: normalizeCell(record.templateName),
        updatedAt: normalizeCell(record.updatedAt)
      }))
      .filter((record) =>
        record.merchantId !== '' &&
        record.effectiveDate !== '' &&
        record.adjustmentValue !== null
      );
  } catch (_error) {
    // NFR-2: 文件损坏时返回空数组
    return [];
  }
}

function normalizeEffectiveDate(dateString) {
  const parsed = parseDateValue(normalizeCell(dateString));
  if (!parsed) {
    return normalizeCell(dateString); // 兜底：原值 trim
  }
  // 标准化为 YYYY-MM-DD（零填充），确保字符串比较等价于日期比较
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function writeBalanceAdjustments(storageRoot, bankName, records) {
  const filePath = getBalanceAdjustmentFilePath(storageRoot, bankName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const normalizedRecords = records.map((record) => ({
    merchantId: normalizeCell(record.merchantId),
    currency: normalizeCell(record.currency),
    effectiveDate: normalizeEffectiveDate(record.effectiveDate),
    adjustmentValue: record.adjustmentValue,
    remark: normalizeCell(record.remark),
    templateName: normalizeCell(record.templateName),
    updatedAt: new Date().toISOString()
  }));

  fs.writeFileSync(filePath, `${JSON.stringify(normalizedRecords, null, 2)}\n`, 'utf8');
}

/**
 * 计算指定大账号+币种在指定日期的累计余额附加值。
 * 规则：所有 effectiveDate <= dateLabel 的记录的 adjustmentValue 累加。
 */
function resolveBalanceAdjustment(adjustments, { merchantId, currency, dateLabel }) {
  return adjustments
    .filter((record) =>
      record.merchantId === merchantId &&
      record.currency === currency &&
      record.effectiveDate <= dateLabel
    )
    .reduce((sum, record) => sum + (record.adjustmentValue || 0), 0);
}

module.exports = {
  readBalanceAdjustments,
  writeBalanceAdjustments,
  resolveBalanceAdjustment
};
```

**关键设计**：

- `resolveBalanceAdjustment` 使用字符串比较 `effectiveDate <= dateLabel`，因为日期格式为 `YYYY-MM-DD`（`formatDateLabel` 输出），字符串比较等价于日期比较。`writeBalanceAdjustments` 通过 `normalizeEffectiveDate` 在写入时标准化日期为 `YYYY-MM-DD` 格式，防止用户手动编辑 JSON 写入非标准格式（如 `2026-3-1`）导致字符串比较出错
- 累加规则：所有 `effectiveDate <= dateLabel` 的记录的 `adjustmentValue` 求和（PRD 确认为累加）
- NFR-2：`catch` 块返回空数组而非崩溃

### 7.2 IPC 通道

#### `src/preload.js`

在 `bigAccount` 分组内新增（或新建 `balanceAdjustment` 分组）：

```javascript
balanceAdjustment: {
  list: (templateName) => ipcRenderer.invoke('balance-adjustment:list', templateName),
  save: (payload) => ipcRenderer.invoke('balance-adjustment:save', payload)
},
```

#### `src/main.js`

新增导入语句（文件顶部）：

```javascript
const {
  readBalanceAdjustments,
  writeBalanceAdjustments,
  resolveBalanceAdjustment
} = require('./backend/balance-adjustment-store');
```

在 `registerBigAccountHandlers` 内新增两个 handler：

```javascript
ipcMain.handle('balance-adjustment:list', (_event, templateName) => {
  try {
    const bankNameParts = splitTemplateName(templateName);
    const adjustments = readBalanceAdjustments(ensureStorageRoot(), bankNameParts.bankName);
    return {
      status: 'success',
      adjustments
    };
  } catch (error) {
    return {
      status: 'success',
      adjustments: []
    };
  }
});

ipcMain.handle('balance-adjustment:save', (_event, payload = {}) => {
  try {
    const templateName = normalizeCell(payload.templateName);

    if (!templateName) {
      return createErrorResult({
        step: '保存余额附加值',
        message: '模板名称不能为空',
        errorCode: 'BALANCE_ADJUSTMENT_TEMPLATE_MISSING'
      });
    }

    const bankNameParts = splitTemplateName(templateName);
    const records = Array.isArray(payload.records) ? payload.records : [];

    // 校验每条记录
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!normalizeCell(record.merchantId)) {
        return createErrorResult({
          step: '保存余额附加值',
          message: `第 ${i + 1} 行：大账号不能为空`,
          errorCode: 'BALANCE_ADJUSTMENT_VALIDATE'
        });
      }
      if (!normalizeCell(record.currency)) {
        return createErrorResult({
          step: '保存余额附加值',
          message: `第 ${i + 1} 行：币种不能为空`,
          errorCode: 'BALANCE_ADJUSTMENT_VALIDATE'
        });
      }
      if (!normalizeCell(record.effectiveDate) || !parseDateValue(record.effectiveDate)) {
        return createErrorResult({
          step: '保存余额附加值',
          message: `第 ${i + 1} 行：日期不能为空且必须是有效日期`,
          errorCode: 'BALANCE_ADJUSTMENT_VALIDATE'
        });
      }
      if (parseNumericValue(record.adjustmentValue) === null) {
        return createErrorResult({
          step: '保存余额附加值',
          message: `第 ${i + 1} 行：余额附加值必须是有效数字`,
          errorCode: 'BALANCE_ADJUSTMENT_VALIDATE'
        });
      }
    }

    writeBalanceAdjustments(ensureStorageRoot(), bankNameParts.bankName, records.map((record) => ({
      ...record,
      templateName
    })));

    clearLastErrorReport();
    appendActivityLogEntry({
      level: 'info',
      message: '保存余额附加值成功',
      details: [
        `模板名：${templateName}`,
        `记录数：${records.length}`
      ]
    });

    return {
      status: 'success',
      message: '余额附加值保存成功'
    };
  } catch (error) {
    return createErrorResult({
      step: '保存余额附加值',
      message: '余额附加值保存失败，请导出报错文件查看详情',
      errorCode: 'BALANCE_ADJUSTMENT_SAVE_RUNTIME',
      errorType: '系统错误',
      originalError: error
    });
  }
});
```

### 7.3 余额叠加逻辑注入

#### `src/main.js` — `deriveBalanceRecords` 函数（第 1733-1934 行）

**7.3.1 函数签名变更**

在第 1733 行，新增 `balanceAdjustments` 参数：

```javascript
function deriveBalanceRecords({
  detailRows,
  templateName,
  balanceTemplateFields,
  mode = 'statement',
  resolvePreviousEndBalance = null,
  balanceAdjustments = []          // 新增
}) {
```

**7.3.2 叠加注入点**

在第 1902-1904 行之间注入余额附加值叠加：

当前代码（第 1897-1904 行）：

```javascript
        endBalance = inferEndingBalance({
          previousEndBalance: effectivePreviousEndBalance,
          entries,
          dateLabel
        });
      }

      previousEndBalance = endBalance;
```

修改为：

```javascript
        endBalance = inferEndingBalance({
          previousEndBalance: effectivePreviousEndBalance,
          entries,
          dateLabel
        });
      }

      // 叠加余额附加值（累加所有 effectiveDate <= dateLabel 的记录）
      const adjustment = resolveBalanceAdjustment(balanceAdjustments, {
        merchantId: group.merchantId,
        currency: group.currency,
        dateLabel
      });

      if (adjustment !== 0) {
        endBalance = roundAmount(endBalance + adjustment);
      }

      previousEndBalance = endBalance;
```

**为避免代码重复，在 `dateKeys.forEach` 循环开始处（第 1863 行之后）提取局部函数：**

```javascript
    dateKeys.forEach((dateLabel) => {
      // ... 原有代码 ...

      // 提取为局部函数，供两个分支共用
      function applyAdjustment(balance) {
        const adjustment = resolveBalanceAdjustment(balanceAdjustments, {
          merchantId: group.merchantId,
          currency: group.currency,
          dateLabel
        });
        return adjustment !== 0 ? roundAmount(balance + adjustment) : balance;
      }
```

**分支 1 — `mode === 'calculated'`（第 1874-1884 行）：**

```javascript
      if (mode === 'calculated') {
        const effectivePreviousEndBalance = resolveSeededPreviousEndBalance({
          previousEndBalance,
          resolvePreviousEndBalance,
          promptContext,
          shouldPrompt: true
        });
        endBalance = calculateEndingBalanceFromAmounts({
          previousEndBalance: effectivePreviousEndBalance,
          entries
        });
        endBalance = applyAdjustment(endBalance);  // ← 第 1884 行之后注入
```

**分支 2 — `mode === 'statement'`（第 1885-1902 行）：**

```javascript
      } else {
        // ... effectivePreviousEndBalance 解析 ...
        endBalance = inferEndingBalance({
          previousEndBalance: effectivePreviousEndBalance,
          entries,
          dateLabel
        });
      }
      endBalance = applyAdjustment(endBalance);    // ← 第 1902 行之后注入（或放在 } 之后统一处理）
```

**推荐方案**：将 `applyAdjustment` 调用放在两个分支 `if/else` 结束之后、`previousEndBalance = endBalance` 之前，这样只需写一次：

```javascript
      // 两个分支计算完 endBalance 后统一叠加
      endBalance = applyAdjustment(endBalance);
      previousEndBalance = endBalance;  // 原第 1904 行
```

**测试分支对照表**（供 Tester 编写用例）：

| 场景 | 走的分支 | `endBalance` 计算方式 | 叠加时机 |
|------|---------|---------------------|---------|
| statement 模式 + 有余额附加值 | `else`（第 1885-1902 行） | `inferEndingBalance` | `endBalance` 赋值后、`previousEndBalance` 赋值前 |
| calculated 模式 + 有余额附加值 | `if`（第 1874-1884 行） | `calculateEndingBalanceFromAmounts` | 同上 |
| 任意模式 + 无余额附加值 | 对应分支 | 原有逻辑 | `applyAdjustment` 返回原值（`adjustment === 0`） |

**7.3.3 `roundAmount` 的引用**

`roundAmount` 定义在 `normalizers.js:41-43`，但未被 `main.js` 直接导入。需要在 `main.js` 顶部的 `require('./backend/file-service')` 解构中新增 `roundAmount`，或直接使用 `Number(Number(value).toFixed(2))`。

采用方案 A，保持精度处理一致。需要三步修改：

**步骤 1**：`roundAmount` 已在 `normalizers.js:619` 的 `module.exports` 中导出，无需修改 `normalizers.js`。

**步骤 2**：在 `file-service.js` 中新增转导出（当前 `file-service.js` 未转导出 `roundAmount`）。

在 `file-service.js` 顶部 `require('./file-service/normalizers')` 的解构中新增 `roundAmount`（约第 16 行后）：

```javascript
const {
  calculateEndingBalanceFromAmounts,
  hasEffectiveAmount,
  inferDateCellFormat,
  inferEndingBalance,
  loadCurrencyMappings: loadCurrencyMappingsFromMappings,
  normalizeDateExportValue,
  parseDateValue,
  parseNumericValue,
  resolveCurrencyValue,
  roundAmount,                          // 新增
  sanitizeAmountValue,
  splitSignedAmountValue,
  toExcelSerial
} = require('./file-service/normalizers');
```

在 `file-service.js` 的 `module.exports`（第 394-416 行）中新增：

```javascript
module.exports = {
  // ... 现有导出 ...
  roundAmount,                          // 新增
  // ...
};
```

**步骤 3**：在 `main.js` 顶部的 `require('./backend/file-service')` 解构中新增 `roundAmount`。

**7.3.4 调用方适配**

`deriveBalanceRecords` 在以下位置被调用：

| 位置 | 行号 | 说明 |
|------|------|------|
| `generateStatementFiles` | ~3456 | 余额账单生成主入口 |

在第 3456 行的调用中新增 `balanceAdjustments` 参数：

```javascript
const balanceResult = deriveBalanceRecords({
  detailRows: effectiveDetailRows,
  templateName: config.template.name,
  balanceTemplateFields,
  mode: preparedBatch.balanceMode,
  resolvePreviousEndBalance: ({ bankName, merchantId, currency, targetBillDate }) => {
    const seedRecord = findPreviousBalanceSeed(ensureStorageRoot(), {
      bankName,
      merchantId,
      currency,
      beforeBillDate: targetBillDate
    });
    return seedRecord ? seedRecord.endBalance : null;
  },
  balanceAdjustments: readBalanceAdjustments(     // 新增
    ensureStorageRoot(),
    splitTemplateName(config.template.name).bankName
  )
});
```

### 7.4 渲染进程：余额管理对话框

#### `src/renderer-dialogs.js`

在 `createBigAccountManagerDialog` 函数之后（约第 1205 行），新增 `createBalanceAdjustmentDialog` 工厂函数：

```javascript
function createBalanceAdjustmentDialog({
  templateName,
  bigAccounts = [],
  adjustments = [],
  onDone,
  onCancel
}) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'dialog-card balance-adjustment-dialog';

  // 构建大账号下拉选项（去重 merchantId）
  const uniqueMerchantIds = Array.from(
    new Set(bigAccounts.map((item) => item.merchantId).filter(Boolean))
  );
  const bigAccountMap = new Map(
    bigAccounts.map((item) => [item.merchantId, item])
  );

  dialog.innerHTML = `
    <div class="dialog-header">
      <span class="dialog-title">余额管理</span>
      <button class="icon-close" type="button" aria-label="关闭">&times;</button>
    </div>
    <div class="dialog-body">
      <div class="dialog-table-wrapper">
        <table class="data-table balance-adjustment-table">
          <thead>
            <tr>
              <th>大账号</th>
              <th>币种</th>
              <th>日期</th>
              <th>余额附加值</th>
              <th>备注</th>
              <th></th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="dialog-status" hidden></div>
    </div>
    <div class="dialog-footer">
      <div class="dialog-footer-actions">
        <button class="secondary-btn small" type="button" data-action="add">新增</button>
      </div>
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const tbody = dialog.querySelector('tbody');
  const statusEl = dialog.querySelector('.dialog-status');

  function setStatus(message, level = 'info') {
    statusEl.textContent = message;
    statusEl.className = `dialog-status ${level}`;
    statusEl.hidden = !message;
  }

  function createAdjustmentRow(item = {}) {
    const localItem = { ...item }; // 避免修改传入的原始对象引用
    const row = document.createElement('tr');
    const merchantOptions = uniqueMerchantIds
      .map((id) => `<option value="${escapeHtml(id)}"${id === localItem.merchantId ? ' selected' : ''}>${escapeHtml(id)}</option>`)
      .join('');

    row.innerHTML = `
      <td>
        <select class="mapping-select adj-merchant-select">
          <option value=""></option>
          ${merchantOptions}
        </select>
      </td>
      <td class="adj-currency-cell"></td>
      <td><input class="mapping-text-input adj-date-input" type="date" value="${escapeHtml(localItem.effectiveDate || '')}" /></td>
      <td><input class="mapping-text-input adj-value-input" type="text" inputmode="decimal" value="${localItem.adjustmentValue != null ? localItem.adjustmentValue : ''}" /></td>
      <td><input class="mapping-text-input adj-remark-input" type="text" value="${escapeHtml(localItem.remark || '')}" /></td>
      <td><button class="text-action danger" type="button" data-action="delete-row">删除</button></td>
    `;

    const merchantSelect = row.querySelector('.adj-merchant-select');
    const currencyCell = row.querySelector('.adj-currency-cell');

    function renderCurrencyControl() {
      const selectedMerchantId = merchantSelect.value;
      const account = bigAccountMap.get(selectedMerchantId);
      currencyCell.innerHTML = '';

      if (!account || !account.currencies.length) {
        const input = document.createElement('input');
        input.className = 'mapping-text-input adj-currency-input';
        input.type = 'text';
        input.value = localItem.currency || '';
        currencyCell.appendChild(input);
        return;
      }

      if (account.currencies.length === 1) {
        const span = document.createElement('span');
        span.className = 'adj-currency-fixed';
        span.textContent = account.currencies[0];
        span.dataset.value = account.currencies[0];
        currencyCell.appendChild(span);
        return;
      }

      // 多币种：下拉框
      const select = document.createElement('select');
      select.className = 'mapping-select adj-currency-select';
      select.innerHTML = '<option value=""></option>' +
        account.currencies.map((c) =>
          `<option value="${escapeHtml(c)}"${c === localItem.currency ? ' selected' : ''}>${escapeHtml(c)}</option>`
        ).join('');
      currencyCell.appendChild(select);
    }

    merchantSelect.addEventListener('change', () => {
      localItem.currency = '';
      renderCurrencyControl();
    });
    renderCurrencyControl();

    row.querySelector('[data-action="delete-row"]').addEventListener('click', () => {
      row.remove();
    });

    return row;
  }

  function getRowData(row) {
    const merchantId = row.querySelector('.adj-merchant-select').value;
    const currencyFixed = row.querySelector('.adj-currency-fixed');
    const currencySelect = row.querySelector('.adj-currency-select');
    const currencyInput = row.querySelector('.adj-currency-input');
    const currency = currencyFixed
      ? currencyFixed.dataset.value
      : currencySelect
        ? currencySelect.value
        : currencyInput
          ? currencyInput.value.trim()
          : '';

    return {
      merchantId,
      currency,
      effectiveDate: row.querySelector('.adj-date-input').value,
      adjustmentValue: row.querySelector('.adj-value-input').value,
      remark: row.querySelector('.adj-remark-input').value.trim()
    };
  }

  // 初始化已有记录
  adjustments.forEach((item) => {
    tbody.appendChild(createAdjustmentRow(item));
  });

  dialog.querySelector('[data-action="add"]').addEventListener('click', () => {
    tbody.appendChild(createAdjustmentRow());
  });

  dialog.querySelector('.icon-close').addEventListener('click', () => {
    onCancel();
  });

  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const records = rows.map(getRowData);

    // 前端预校验：减少不必要的 IPC 往返
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.merchantId) {
        setStatus(`第 ${i + 1} 行：请选择大账号`, 'error');
        return;
      }
      if (!r.currency) {
        setStatus(`第 ${i + 1} 行：请填写或选择币种`, 'error');
        return;
      }
      if (!r.effectiveDate) {
        setStatus(`第 ${i + 1} 行：请填写日期`, 'error');
        return;
      }
      if (r.adjustmentValue === '' || isNaN(Number(r.adjustmentValue))) {
        setStatus(`第 ${i + 1} 行：余额附加值必须是有效数字`, 'error');
        return;
      }
    }

    // 传给主进程做最终校验和保存
    const result = await window.desktopApi.balanceAdjustment.save({
      templateName,
      records
    });

    if (result.status === 'error') {
      setStatus(result.message, 'error');
      return;
    }

    onDone();
  });

  overlay.appendChild(dialog);
  return overlay;
}
```

**6.4 "余额管理"按钮事件处理**

在 `createBigAccountManagerDialog` 的 `[data-action="import-bank-info"]` handler 之后新增：

```javascript
dialog.querySelector('[data-action="balance-management"]').addEventListener('click', async () => {
  cleanupFloatingDropdown();

  if (!templateId || !templateName) {
    setStatus('请先选择模板', 'error');
    return;
  }

  // 从数据库已保存的大账号数据获取选项
  const mappingResult = await window.desktopApi.templates.getMappings(templateId);

  if (mappingResult.status !== 'success') {
    setStatus('无法获取大账号列表', 'error');
    return;
  }

  const savedBigAccounts = mappingResult.bigAccounts || [];
  const listResult = await window.desktopApi.balanceAdjustment.list(templateName);
  const existingAdjustments = listResult.status === 'success' ? listResult.adjustments : [];

  const adjustmentOverlay = createBalanceAdjustmentDialog({
    templateName,
    bigAccounts: savedBigAccounts,
    adjustments: existingAdjustments,
    onDone: () => {
      adjustmentOverlay.remove();
      setStatus('余额附加值保存成功', 'success');
    },
    onCancel: () => {
      adjustmentOverlay.remove();
    }
  });

  document.body.appendChild(adjustmentOverlay);
});
```

**注意**：
- `templateId` 和 `templateName` 来自 `createBigAccountManagerDialog` 的新增入参（由调用方从 `payload.template` 传入），不是 `state` 上的属性
- 大账号下拉的数据源为**数据库中已保存的大账号数据**（通过 `template:get-mappings` IPC 获取），而非对话框内存中的 tbody（PRD 确认）

### 7.5 样式

#### `src/styles.css`

新增余额管理对话框样式（在文件末尾、响应式样式之前）：

```css
/* 余额管理对话框 */
.balance-adjustment-dialog .dialog-table-wrapper {
  max-height: 400px;
  overflow-y: auto;
}

.balance-adjustment-table .adj-merchant-select,
.balance-adjustment-table .adj-currency-select {
  min-width: 120px;
}

.balance-adjustment-table .adj-date-input {
  min-width: 140px;
}

.balance-adjustment-table .adj-value-input {
  min-width: 100px;
}

.balance-adjustment-table .adj-remark-input {
  min-width: 80px;
}

.adj-currency-fixed {
  display: inline-block;
  padding: 6px 0;
  color: var(--text);
}
```

复用现有 `.dialog-card`、`.dialog-header`、`.dialog-body`、`.dialog-footer`、`.data-table` 样式，仅补充余额管理表格的列宽控制。

---

## 八、影响分析

### 8.1 对现有功能的影响

| 现有功能 | 影响说明 | 风险等级 |
|---------|---------|---------|
| 维护大账号对话框 | 新增 2 个按钮、导入替换 tbody 逻辑、"完成"回调扩展传递 ownAccounts | 中 |
| 余额账单生成 | `deriveBalanceRecords` 新增 `balanceAdjustments` 参数和叠加逻辑，影响链式余额计算 | 高 |
| 模板选择 | `updateTemplateSelect` fallback 逻辑变更 + AC2-7 导入守卫 + AC2-8 导出状态重置 | 低 |
| 模板删除 | `template:delete` handler 新增 `clearGeneratedExports()` 调用（AC2-9） | 低 |
| 新开账户模块 | `buildNewAccountBillDates` 从月末改为逐天 | 低 |
| 模板映射保存 | `onDone` 回调新增第二参数，需确保现有调用方不受影响 | 中 |
| 余额种子系统 | 不受影响。余额附加值是独立存储，与 `balance-seeds` 互不干扰 | 无 |

### 8.2 `deriveBalanceRecords` 调用链分析

`deriveBalanceRecords` 被 `generateStatementFiles`（`main.js:~3456`）调用，该函数被以下入口调用：

1. `file:import` handler → `prepareGeneratedFiles` → `generateStatementFiles`
2. `file:complete-big-account-selection` handler → `generateStatementFiles`
3. `file:save-balance-seed` handler → `generateFilesFromRememberedContext` → `generateStatementFiles`
4. `exportStatementByScope`（导出全部）→ `generateStatementFiles`

所有路径均通过 `generateStatementFiles`，因此只需在该函数内的 `deriveBalanceRecords` 调用点传入 `balanceAdjustments` 即可。

### 8.3 `previousEndBalance` 链式传递的影响

余额附加值叠加到 `endBalance` 后，通过 `previousEndBalance = endBalance` 传递给后续日期。这意味着：

- 如果 3/1 的附加值为 +100，那么 3/1 及之后的**所有日期**都会受影响
- 如果 3/15 又新增 +50，那么 3/15 及之后的日期余额 = 原始余额 + 100 + 50 = +150

这是 PRD 确认的"永久偏移量"语义。需要在测试中重点验证多条附加值的累加效果。

### 8.4 新增文件存储清单

| 路径 | 内容 | 创建时机 |
|------|------|---------|
| `{storageRoot}/own-accounts/{bankName}.json` | 自有账号列表 | 用户导入银行账号信息并点击"完成"时 |
| `{storageRoot}/balance-adjustments/{bankName}.json` | 余额附加值记录 | 用户在余额管理对话框中点击"完成"时 |

### 8.5 新增 IPC 通道清单

| 通道名称 | 方向 | 入参 | 返回 |
|---------|------|------|------|
| `big-account:import-bank-info` | renderer → main | `templateId` | `{ status, clientAccounts, ownAccounts, message }` |
| `big-account:save-own-accounts` | renderer → main | `{ templateId, accounts }` | `{ status }` |
| `balance-adjustment:list` | renderer → main | `templateName` | `{ status, adjustments }` |
| `balance-adjustment:save` | renderer → main | `{ templateName, records }` | `{ status, message }` |

所有通道需在 `src/preload.js` 中注册（NFR-4）。

---

## 九、实施顺序与工作量估算

| 顺序 | 需求 | 涉及文件 | 复杂度 |
|------|------|---------|--------|
| 1 | 需求 3：按钮溢出 | `styles.css` | 低 |
| 2 | 需求 2：模板选择框 | `renderer.js` | 低 |
| 3 | 需求 1：币种大写强制 | `renderer-dialogs.js` | 低 |
| 4 | 需求 5：新开账户逐天 | `main.js` | 低 |
| 5 | 需求 4A：导入银行账号 | `bank-account-import.js`(新增), `own-account-store.js`(新增), `preload.js`, `main.js`, `renderer-dialogs.js` | 中 |
| 6 | 需求 4B：余额管理 | `balance-adjustment-store.js`(新增), `preload.js`, `main.js`, `renderer-dialogs.js`, `styles.css` | 高 |

---

## 十、踩坑预警

基于 v1.4.2-v1.4.5 的历史踩坑记录，以下场景需要特别注意：

1. **需求 4A — `createBigAccountRow` 的 `cloneNode` 陷阱**：v1.4.3 记录了 `addNewAccountRow` 的 `cloneNode(true)` 会复制 ghost shell 导致 querySelector 选错元素。需求 4A 导入后重新渲染 tbody 时使用的是 `createBigAccountRow` 创建新行，不涉及 `cloneNode`，但如果后续有类似实现需警惕此问题。

2. **需求 4B — `accountMappingByBankId` 结构**：v1.4.2 记录了该对象从 string 改为 object 结构。需求 4B 的余额附加值通过独立的 `resolveBalanceAdjustment` 函数计算，不经过 `accountMappingByBankId`，因此不受此问题影响。

3. **需求 4B — `previousEndBalance` 链式计算**：这是本版本最关键的变更点。`deriveBalanceRecords` 的 `previousEndBalance = endBalance` 赋值位于第 1904 行，余额附加值叠加必须在此行之前完成，确保叠加后的值进入链式传递。

4. **需求 2 — `updateTemplateSelect` 的调用时机**：该函数在 `refreshTemplates`（第 1621 行）中被调用，而 `refreshTemplates` 在多个场景触发（导入模板、删除模板、重命名模板、导入模板包）。移除 fallback 后，所有这些场景都需要回归验证，确保已选模板正确保留或正确清空。

5. **需求 4A — `onDone` 回调签名变更**：`createBigAccountManagerDialog` 的 `onDone(nextBigAccounts)` 改为 `onDone(nextBigAccounts, { ownAccounts })` 后，所有调用方必须适配。当前有两处调用：`renderer-dialogs.js:1534`（`createMappingDialog` 内）和 `renderer.js:2379`（legacy 路径），均需适配。

6. **需求 4A/4B — `createBigAccountManagerDialog` 签名变更**：新增 `templateId` 和 `templateName` 入参。原函数内不存在 `state.editingTemplateId` 或 `state.editingTemplateName`，必须由调用方从 `payload.template` 传入。两处调用方（`renderer-dialogs.js:1532` 和 `renderer.js:2377`）均需补充。

7. **需求 4B — `effectiveDate` 日期格式标准化**：`resolveBalanceAdjustment` 使用字符串比较 `effectiveDate <= dateLabel`，要求日期为 `YYYY-MM-DD` 零填充格式。`writeBalanceAdjustments` 通过 `normalizeEffectiveDate` 在写入时强制标准化，但如果用户直接手动编辑 JSON 文件仍可能破坏格式。渲染进程使用 `<input type="date">` 天然产出标准格式，正常使用不会触发此问题。

---

## 变更记录

| 日期 | 变更内容 | 作者 |
|------|---------|------|
| 2026-03-27 | 初版技术设计文档生成 | Dev |
| 2026-03-27 | 修订版：处理 PM + Tester 评审反馈共 15 项。主要变更：(1) 需求 3 CSS 选择器改为组合选择器 `.primary-btn.small, .secondary-btn.small, .danger-btn.small`，避免 `.small` 基类副作用；(2) 补充 AC2-7 导入守卫、AC2-8 导出状态重置、AC2-9 删除模板清缓存的实现方案；(3) 修复 AC4A-17 币种 toUpperCase 遗漏，新增 skippedCount 提示；(4) `createBigAccountManagerDialog` 签名扩展新增 `templateId`/`templateName` 入参（修复 PM 阻塞项：原 `state.editingTemplateId` 不存在）；(5) `writeBalanceAdjustments` 新增 `normalizeEffectiveDate` 日期格式标准化；(6) `createAdjustmentRow` 增加 `localItem` 浅拷贝防引用污染；(7) 余额管理"完成"新增前端预校验；(8) 余额叠加注入点统一为 if/else 之后的单次调用，附测试分支对照表 | Dev |
