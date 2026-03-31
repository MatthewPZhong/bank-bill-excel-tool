# 技术设计文档 - 网银账单小助手 v1.4.7

| 项目 | 内容 |
|------|------|
| 版本 | v1.4.7 |
| 日期 | 2026-03-31 |
| 状态 | 评审中 |
| 作者 | Dev |
| PRD | PRD-v1.4.7.md |

---

## 一、PRD 评审意见（技术角度）

### 1.1 需求 1：大账号选择对话框重构

**总体评估：** 需求清晰，影响范围明确。以下为技术角度的补充和风险点：

1. **"账号顺序固定"模式下空块识别**：PRD 提到"无数据行的模板字段参与编排"，当前 `identifyAccountBlocks`（`main.js:508-577`）在 `trimBlock` 阶段会裁剪掉无交易数据行（检查 Credit Amount / Debit Amount 是否非空），空块会被丢弃（`trimmed.startIndex <= trimmed.endIndex` 不成立则不 push）。需要新增 `includeEmptyBlocks` 参数跳过 trim 逻辑。

2. **"固定"按钮移除后的 `fixedAssignments` 数据流**：当前 `file:complete-big-account-selection` handler（`main.js:4293-4461`）通过 `payload.fixed` 字段决定是否写入 `fixedAssignments` 到数据库。移除该逻辑后，IPC payload 中不再需要 `fixed` 字段。但需注意：前端简单模式分支（`renderer-dialogs.js:459-519`）仍传递 `fixed: false`，需一并清理。

3. **解析模式存储建议**：PRD 要求按模板 ID 存储到 `{storageRoot}/big-account-modes/{templateId}.json`。建议简化为单文件 `{storageRoot}/big-account-modes.json`，以 JSON 对象 `{ [templateId]: "fixed" | "unfixed" }` 存储，减少文件碎片。但本文档按 PRD 原设计实施。

4. **记住顺序的存储与 `fixedAssignments` 的关系**：PRD 明确新增独立 JSON 存储，不复用数据库的 `fixedAssignments`。这意味着两套存储并存。需确保 `file:complete-big-account-selection` handler 不再写入 `fixedAssignments`。

5. **大账号展开列表传递**：PRD 要求 `buildBigAccountSelectionRequiredResult` 返回 `expandedBigAccountOptions`。当前已返回 `bigAccounts`（分组后），前端再展开。建议直接在后端调用 `expandBigAccountConfigurations` 返回扁平列表，避免前端重复展开逻辑。

### 1.2 需求 2：新开账户余额账单命名规则

**总体评估：** 改动极小，逻辑清晰，无风险点。

1. 当前代码位于 `main.js:4695-4699`，仅需根据 `accounts.length` 分支处理文件名。
2. 需注意 `bankAccount` 可能为空字符串的边界情况（PRD AC2-5 已覆盖）。

### 1.3 历史踩坑记录关联

- **v1.4.2 `accountMappingByBankId` 结构变更**：本次需求不涉及 `accountMappingByBankId`，无影响。
- **v1.4.5 `cloneNode` ghost shell 问题**：本次需求 1 重构了多行模式的币种输入，移除了原来的 `createCurrencyControl` 和 ghost input，不存在 clone 风险。
- **v1.4.5 `identifyAccountBlocks` / `headerBreaks` 问题**：需求 1 要修改 `identifyAccountBlocks`，需格外注意空块模式下不破坏现有 trim 逻辑的正确性。

---

## 二、需求 2 技术方案（新开账户余额账单命名规则）

> 建议先实施需求 2，改动小，风险低。

### 2.1 变更概述

修改 `src/main.js` 中 `registerNewAccountHandlers` / `new-account:generate` handler 内的文件命名逻辑，根据 `accounts.length` 生成不同的 `outputFileName`。

### 2.2 涉及文件

| 文件 | 变更说明 |
|------|---------|
| `src/main.js` | 修改 `new-account:generate` handler 约第 4691-4700 行的文件命名逻辑 |

### 2.3 详细设计

#### 2.3.1 变更位置：`src/main.js:4691-4700`

**当前代码：**

```javascript
// main.js:4695-4699
const primaryAccount = accounts[0];
const currencyLabel = generated.currencies.length > 1 ? '多币种' : (generated.currencies[0] || '');
const output = buildOutputFilePath({
  kind: 'new-account',
  outputFileName: `${primaryAccount.bankName}-${primaryAccount.location}-多账号-${currencyLabel}-${NEW_ACCOUNT_EXPORT_NAME}.xlsx`
});
```

**修改后伪代码：**

```javascript
// main.js:4695-4710（修改后）
const primaryAccount = accounts[0];

let accountSegment;
let currencySegment;

if (accounts.length === 1) {
  // 单账号：取银行账号后四位
  const bankAccount = String(primaryAccount.bankAccount || '').trim();
  accountSegment = bankAccount.length > 4
    ? bankAccount.slice(-4)
    : bankAccount;  // 长度<=4 原样输出；空字符串时为 ''

  // 单账号币种：多币种输出"多币种"，单币种输出币种代码
  currencySegment = generated.currencies.length > 1
    ? '多币种'
    : (generated.currencies[0] || '');
} else {
  // 多账号（>=2）：固定输出"多账号-多币种"
  accountSegment = '多账号';
  currencySegment = '多币种';
}

// 构建文件名，空 accountSegment 时跳过该段
const nameParts = [
  primaryAccount.bankName,
  primaryAccount.location,
  accountSegment,
  currencySegment,
  NEW_ACCOUNT_EXPORT_NAME
].filter(part => part !== '');

const output = buildOutputFilePath({
  kind: 'new-account',
  outputFileName: `${nameParts.join('-')}.xlsx`
});
```

**关键逻辑说明：**

- `accounts.length === 1` 时，`accountSegment` = `bankAccount.slice(-4)`（或原样输出当长度 <= 4）
- `accounts.length >= 2` 时，`accountSegment` = `'多账号'`，`currencySegment` = `'多币种'`（不区分实际币种数量）
- `bankAccount` 为空时，`accountSegment` 为空字符串，通过 `.filter(part => part !== '')` 跳过该段
- `NEW_ACCOUNT_EXPORT_NAME` 常量值为 `'NEW_BALANCE'`

#### 2.3.2 文件名示例验证

| 场景 | accounts.length | bankAccount | currencies | 输出文件名 |
|------|----------------|-------------|------------|-----------|
| 单账号+单币种 | 1 | `'123456787890'` | `['HKD']` | `CNCB-CN-7890-HKD-NEW_BALANCE.xlsx` |
| 单账号+多币种 | 1 | `'123456787890'` | `['HKD','USD']` | `CNCB-CN-7890-多币种-NEW_BALANCE.xlsx` |
| 单账号+短账号 | 1 | `'AB'` | `['CNY']` | `CNCB-CN-AB-CNY-NEW_BALANCE.xlsx` |
| 单账号+空账号 | 1 | `''` | `['HKD']` | `CNCB-CN-HKD-NEW_BALANCE.xlsx` |
| 多账号 | 3 | N/A（取首个） | `['HKD','USD']` | `CNCB-CN-多账号-多币种-NEW_BALANCE.xlsx` |

---

## 三、需求 1 技术方案（大账号选择对话框重构）

### 3.1 变更概述

全面重构 `createBigAccountSelectionDialog` 的多行模式分支（`renderer-dialogs.js:521-797`），移除"固定"按钮和逐行下拉选择 UI，替换为左右分栏布局（文件顺序 vs 大账号顺序），支持勾选序位映射、定位搜索、记住选择顺序。同时新增后端 IPC 通道和本地 JSON 存储。

### 3.2 涉及文件总览

| 文件 | 变更类型 | 变更说明 |
|------|---------|---------|
| `src/renderer-dialogs.js` | 重构 | `createBigAccountSelectionDialog` 多行模式（521-797 行）全面重写 |
| `src/styles.css` | 新增 | 左右分栏布局、序位标签、高亮、定位搜索等样式 |
| `src/main.js` | 修改 | `buildBigAccountSelectionRequiredResult` 新增 `expandedBigAccountOptions` 字段 |
| `src/main.js` | 修改 | `file:complete-big-account-selection` handler 移除 `fixed` 逻辑 + 新增 `mode` 校验 |
| `src/main.js` | 修改 | `applyBigAccountAssignmentsToFileEntries` 新增 `includeEmptyBlocks` 透传 |
| `src/main.js` | 修改 | `rememberPendingBigAccountSelection` 新增 `rowsWithEmptyBlocks` 存储 |
| `src/main.js` | 修改 | `identifyAccountBlocks` 新增 `includeEmptyBlocks` 参数 |
| `src/main.js` | 修改 | `buildBigAccountSelectionRows` 传递 `includeEmptyBlocks` |
| `src/main.js` | 新增 | `registerBigAccountOrderHandlers` -- 4 个新 IPC handler |
| `src/preload.js` | 新增 | 注册 4 个新 IPC 通道 |
| `src/backend/big-account-order-store.js` | 新增 | 记住顺序的 JSON 文件读写 |
| `src/backend/big-account-mode-store.js` | 新增 | 解析模式的 JSON 文件读写 |

### 3.3 新增后端模块

#### 3.3.1 `src/backend/big-account-order-store.js`（新增文件）

```javascript
// 职责：读写 {storageRoot}/big-account-orders/{templateId}.json
// 模式：与 own-account-store.js / balance-adjustment-store.js 一致的 JSON 文件存储模式

const fs = require('node:fs');
const path = require('node:path');
const { normalizeCell } = require('./file-service/common');

function getOrderFilePath(storageRoot, templateId) {
  return path.join(storageRoot, 'big-account-orders', `${String(templateId)}.json`);
}

/**
 * 读取已保存的大账号选择顺序
 * @returns {{ templateId: string, assignments: Array<{ rowIndex: number, merchantId: string, currency: string }> } | null}
 */
function readBigAccountOrder(storageRoot, templateId) {
  const filePath = getOrderFilePath(storageRoot, templateId);
  if (!fs.existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.assignments)) return null;

    return {
      templateId: String(parsed.templateId || templateId),
      assignments: parsed.assignments
        .map(item => ({
          rowIndex: Number(item.rowIndex || 0),
          merchantId: normalizeCell(item.merchantId),
          currency: normalizeCell(item.currency)
        }))
        .filter(item => item.merchantId !== '')
    };
  } catch (_error) {
    return null;
  }
}

/**
 * 保存大账号选择顺序
 */
function writeBigAccountOrder(storageRoot, templateId, assignments) {
  const filePath = getOrderFilePath(storageRoot, templateId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const payload = {
    templateId: String(templateId),
    assignments: assignments.map(item => ({
      rowIndex: Number(item.rowIndex || 0),
      merchantId: normalizeCell(item.merchantId),
      currency: normalizeCell(item.currency)
    })),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

module.exports = { readBigAccountOrder, writeBigAccountOrder };
```

#### 3.3.2 `src/backend/big-account-mode-store.js`（新增文件）

```javascript
// 职责：读写 {storageRoot}/big-account-modes/{templateId}.json
// 两种模式值：'unfixed'（默认）| 'fixed'

const fs = require('node:fs');
const path = require('node:path');

function getModeFilePath(storageRoot, templateId) {
  return path.join(storageRoot, 'big-account-modes', `${String(templateId)}.json`);
}

/**
 * 读取解析模式
 * @returns {'unfixed' | 'fixed'}
 */
function readBigAccountMode(storageRoot, templateId) {
  const filePath = getModeFilePath(storageRoot, templateId);
  if (!fs.existsSync(filePath)) return 'unfixed';

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed.mode === 'fixed' ? 'fixed' : 'unfixed';
  } catch (_error) {
    return 'unfixed';
  }
}

/**
 * 保存解析模式
 */
function writeBigAccountMode(storageRoot, templateId, mode) {
  const filePath = getModeFilePath(storageRoot, templateId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  fs.writeFileSync(filePath, `${JSON.stringify({
    templateId: String(templateId),
    mode: mode === 'fixed' ? 'fixed' : 'unfixed',
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
}

module.exports = { readBigAccountMode, writeBigAccountMode };
```

### 3.4 Preload 变更

#### 3.4.1 `src/preload.js` -- 新增 IPC 通道

在 `bigAccount` 组下新增 4 个方法：

```javascript
// preload.js -- bigAccount 组扩展（约第 39-42 行之后新增）
bigAccount: {
  importBankInfo: (templateId) => ipcRenderer.invoke('big-account:import-bank-info', templateId),
  saveOwnAccounts: (payload) => ipcRenderer.invoke('big-account:save-own-accounts', payload),
  // ---- 以下为 v1.4.7 新增 ----
  loadMode: (templateId) => ipcRenderer.invoke('big-account-mode:load', templateId),
  saveMode: (payload) => ipcRenderer.invoke('big-account-mode:save', payload),
  loadOrder: (templateId) => ipcRenderer.invoke('big-account-order:load', templateId),
  saveOrder: (payload) => ipcRenderer.invoke('big-account-order:save', payload)
},
```

### 3.5 Main 进程变更

#### 3.5.1 新增 imports（`main.js` 顶部约 1-57 行区域）

```javascript
// main.js 顶部 imports 新增
const { readBigAccountOrder, writeBigAccountOrder } = require('./backend/big-account-order-store');
const { readBigAccountMode, writeBigAccountMode } = require('./backend/big-account-mode-store');
```

#### 3.5.2 修改 `identifyAccountBlocks`（`main.js:508-577`）

**变更说明：** 新增 `options.includeEmptyBlocks` 参数。为 `true` 时跳过 `trimBlock` 逻辑，保留空块。

```javascript
// main.js:508 -- 签名变更
function identifyAccountBlocks(detailRows, options = {}) {
  const { includeEmptyBlocks = false } = options;
  const headerRow = detailRows[0] || [];
  const dataRows = detailRows.slice(1);
  const rowMetas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];
  const headerBreaks = Array.isArray(detailRows.headerBreaks) ? detailRows.headerBreaks : [];

  if (!headerBreaks.length) {
    return [{
      startIndex: 0,
      endIndex: Math.max(0, dataRows.length - 1),
      startRowNumber: rowMetas[0]?.sourceRowNumber || 2
    }];
  }

  // ... creditIndex, debitIndex, isTransactionRow, trimBlock 保持不变 ...

  const blocks = [];
  let blockStart = 0;

  headerBreaks.forEach((breakRowNumber) => {
    const splitIndex = rowMetas.findIndex(
      (meta, i) => i >= blockStart && meta.sourceRowNumber >= breakRowNumber
    );
    const effectiveSplit = splitIndex >= 0 ? splitIndex : dataRows.length;
    const rawEnd = effectiveSplit > blockStart ? effectiveSplit - 1 : blockStart - 1;

    if (includeEmptyBlocks) {
      // 空块模式：不 trim，直接保留原始范围
      if (rawEnd >= blockStart) {
        blocks.push({
          startIndex: blockStart,
          endIndex: rawEnd,
          startRowNumber: rowMetas[blockStart]?.sourceRowNumber || blockStart + 2
        });
      }
    } else {
      // 原有逻辑：trim 掉无交易数据行
      const trimmed = trimBlock(blockStart, rawEnd);
      if (trimmed.startIndex <= trimmed.endIndex) {
        blocks.push({
          startIndex: trimmed.startIndex,
          endIndex: trimmed.endIndex,
          startRowNumber: rowMetas[trimmed.startIndex]?.sourceRowNumber || trimmed.startIndex + 2
        });
      }
    }
    blockStart = effectiveSplit;
  });

  // 最后一段
  const lastRawEnd = dataRows.length - 1;
  if (includeEmptyBlocks) {
    if (lastRawEnd >= blockStart) {
      blocks.push({
        startIndex: blockStart,
        endIndex: lastRawEnd,
        startRowNumber: rowMetas[blockStart]?.sourceRowNumber || blockStart + 2
      });
    }
  } else {
    const lastTrimmed = trimBlock(blockStart, lastRawEnd);
    if (lastTrimmed.startIndex <= lastTrimmed.endIndex) {
      blocks.push({
        startIndex: lastTrimmed.startIndex,
        endIndex: lastTrimmed.endIndex,
        startRowNumber: rowMetas[lastTrimmed.startIndex]?.sourceRowNumber || lastTrimmed.startIndex + 2
      });
    }
  }

  return blocks.length ? blocks : [{
    startIndex: 0,
    endIndex: Math.max(0, dataRows.length - 1),
    startRowNumber: rowMetas[0]?.sourceRowNumber || 2
  }];
}
```

**注意：** 现有的所有 `identifyAccountBlocks(entry.detailRows)` 调用不传 options，默认 `includeEmptyBlocks = false`，保持现有行为不变。仅新代码路径传递 `{ includeEmptyBlocks: true }`。

#### 3.5.3 修改 `buildBigAccountSelectionRows`（`main.js:579-599`）

**变更说明：** 新增 `options.includeEmptyBlocks` 参数透传。

```javascript
// main.js:579 -- 签名变更
function buildBigAccountSelectionRows(fileEntries = [], options = {}) {
  const { includeEmptyBlocks = false } = options;
  const rows = [];
  let rowIndex = 0;

  fileEntries.forEach((entry) => {
    const blocks = identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks });

    blocks.forEach((block) => {
      rows.push({
        index: rowIndex,
        sourceRowNumber: block.startRowNumber,
        fileName: path.basename(entry.filePath),
        blockStartIndex: block.startIndex,
        blockEndIndex: block.endIndex
      });
      rowIndex += 1;
    });
  });

  return rows;
}
```

**注意：** 现有调用 `buildBigAccountSelectionRows(provisionalFileEntries)` 不传 options，保持现有行为。

#### 3.5.4 修改 `buildBigAccountSelectionRequiredResult`（`main.js:464-489`）

**变更说明：** 新增 `expandedBigAccountOptions` 字段（扁平列表），供前端渲染右侧列表。

```javascript
// main.js:464 -- 新增参数和返回字段
function buildBigAccountSelectionRequiredResult({ rows = [], rowsWithEmptyBlocks, bigAccounts = [], fixedAssignments = [] } = {}) {
  clearLastErrorReport();
  return {
    status: 'select-big-account',
    message: '请选择本次使用的大账号 / 币种',
    selectionMode: 'multi-row',
    rows: rows.map((row, index) => ({
      index: Number.isInteger(row.index) ? row.index : index,
      label: `${index + 1}.`,
      sourceRowNumber: Number(row.sourceRowNumber || 0),
      fileName: normalizeCell(row.fileName)
    })),
    bigAccounts: bigAccounts.map((item) => ({
      merchantId: normalizeCell(item.merchantId),
      currencies: Array.isArray(item.currencies)
        ? item.currencies.map((value) => normalizeCell(value)).filter((value) => value !== '')
        : [],
      isMultiCurrency: Boolean(item.isMultiCurrency)
    })),
    // v1.4.7 新增：展开后的大账号+币种扁平列表
    expandedBigAccountOptions: expandBigAccountConfigurations(bigAccounts),
    // v1.4.7：保留 fixedAssignments 以兼容，但不再由"固定"按钮消费
    fixedAssignments: fixedAssignments.map((item) => ({
      merchantId: normalizeCell(item.merchantId),
      currency: normalizeCell(item.currency),
      rowIndex: Number(item.rowIndex || 0)
    }))
  };
}
```

#### 3.5.5 修改 `file:complete-big-account-selection` handler（`main.js:4293-4461`）

**变更说明：**

1. 移除 `payload.fixed` 相关逻辑（第 4352-4364 行）。
2. **修改 `assignments.length` 校验逻辑**：支持 fixed 模式下 `rowsWithEmptyBlocks` 的行数。
3. **修改 `applyBigAccountAssignmentsToFileEntries` 调用**：在 fixed 模式下传递 `{ includeEmptyBlocks: true }`。

**删除代码块：**

```javascript
// main.js:4352-4364 -- 删除以下代码块
// if (Boolean(payload.fixed)) {
//   const currentMappingPayload = database.getTemplateMappings(pendingContext.templateId);
//   if (currentMappingPayload) {
//     database.saveMappings(
//       pendingContext.templateId,
//       currentMappingPayload.mappings,
//       database.getTemplateBigAccounts(pendingContext.templateId),
//       normalizedAssignments
//     );
//     syncTemplateLibraryFile();
//   }
// }
```

**修改 assignments.length 校验（main.js:4313）：**

当前代码校验 `assignments.length !== pendingContext.rows.length`，但 fixed 模式下前端使用 `rowsWithEmptyBlocks`（含空块，行数可能更多），后端 `pendingContext.rows` 是默认不含空块的。需改为根据前端传递的模式信息选择正确的 rows 进行校验。

```javascript
// main.js:4305-4320 -- 修改后
const assignments = Array.isArray(payload.assignments)
  ? payload.assignments.map((item, index) => ({
      merchantId: normalizeCell(item.merchantId),
      currency: normalizeCell(item.currency),
      rowIndex: Number.isInteger(item.index) ? item.index : (Number.isInteger(item.rowIndex) ? item.rowIndex : index)
    }))
  : [];

// v1.4.7：根据前端传递的模式选择正确的 rows 进行校验
const isFixedMode = payload.mode === 'fixed';
const expectedRows = isFixedMode
  ? (pendingContext.rowsWithEmptyBlocks || pendingContext.rows)
  : pendingContext.rows;

if (!assignments.length || assignments.length !== expectedRows.length) {
  return createErrorResult({
    step: '选择大账号',
    message: '请选择有效的大账号 / 币种',
    errorCode: 'BIG_ACCOUNT_SELECTION_INVALID',
    templateName: pendingContext.template.name
  });
}
```

**修改 `applyBigAccountAssignmentsToFileEntries` 调用（main.js:4366-4369）：**

`applyBigAccountAssignmentsToFileEntries` 内部调用 `identifyAccountBlocks(entry.detailRows)`（不含空块），在 fixed 模式下需传递 `includeEmptyBlocks: true`，使 block 数量与 assignments 数量一致。

```javascript
// main.js:4366-4369 -- 修改后
const resolvedFileEntries = applyBigAccountAssignmentsToFileEntries(
  pendingContext.fileEntries,
  normalizedAssignments,
  { includeEmptyBlocks: isFixedMode }
);
```

**对应修改 `applyBigAccountAssignmentsToFileEntries` 签名（main.js:601）：**

```javascript
// main.js:601 -- 签名变更
function applyBigAccountAssignmentsToFileEntries(fileEntries = [], assignments = [], options = {}) {
  const { includeEmptyBlocks = false } = options;
  // ... normalizedAssignments 不变 ...

  return fileEntries.map((entry) => {
    // ...
    const blocks = identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks });
    // ... 其余逻辑不变 ...
  });
}
```

**前端 payload 需新增 `mode` 字段：**

```javascript
// renderer-dialogs.js -- "完成"按钮 handler 中
const result = await desktopApi.files.completeBigAccountSelection({
  assignments,
  mode: currentMode  // v1.4.7 新增：告知后端当前解析模式
});
```

#### 3.5.6 新增 `registerBigAccountOrderHandlers`（`main.js` 新增函数）

在 `registerBigAccountHandlers` 函数末尾（约 `main.js:4069` 之后）新增：

```javascript
function registerBigAccountOrderHandlers() {
  // 加载解析模式
  ipcMain.handle('big-account-mode:load', (_event, templateId) => {
    try {
      const mode = readBigAccountMode(ensureStorageRoot(), templateId);
      return { status: 'success', mode };
    } catch (_error) {
      return { status: 'success', mode: 'unfixed' };
    }
  });

  // 保存解析模式
  ipcMain.handle('big-account-mode:save', (_event, payload = {}) => {
    try {
      writeBigAccountMode(ensureStorageRoot(), payload.templateId, payload.mode);
      return { status: 'success' };
    } catch (_error) {
      return { status: 'error', message: '解析模式保存失败' };
    }
  });

  // 加载已保存的大账号选择顺序
  ipcMain.handle('big-account-order:load', (_event, templateId) => {
    try {
      const order = readBigAccountOrder(ensureStorageRoot(), templateId);
      return { status: 'success', order };
    } catch (_error) {
      return { status: 'success', order: null };
    }
  });

  // 保存大账号选择顺序
  ipcMain.handle('big-account-order:save', (_event, payload = {}) => {
    try {
      writeBigAccountOrder(ensureStorageRoot(), payload.templateId, payload.assignments || []);
      return { status: 'success' };
    } catch (_error) {
      return { status: 'error', message: '大账号选择顺序保存失败' };
    }
  });
}
```

在 `app.whenReady()` 中注册（`main.js:4810` 之后）：

```javascript
// main.js:4810 之后新增
registerBigAccountOrderHandlers();
```

#### 3.5.7 `file:import` handler 中传递解析模式（`main.js:4130-4200`）

**变更说明：** 当前 `file:import` handler 调用 `buildBigAccountSelectionRows` 时默认不含空块。需要在触发大账号选择对话框之前，读取当前模板的解析模式，根据模式决定是否传递 `includeEmptyBlocks: true`。

但注意：**解析模式由前端在对话框内切换，不是在导入时决定的。** 因此 `file:import` 阶段应同时构建两种模式的 rows（或由前端切换模式时重新请求）。

**推荐方案：** 后端返回结果中包含两种模式的 rows，前端根据当前选择的模式切换显示。

```javascript
// main.js -- 修改 buildBigAccountSelectionRequiredResult 调用处（约 4155-4159 行, 4196-4200 行）
// 替换原来的 selectionRows 构建为同时构建两种

const selectionRowsDefault = buildBigAccountSelectionRows(provisionalFileEntries);
const selectionRowsWithEmpty = buildBigAccountSelectionRows(provisionalFileEntries, { includeEmptyBlocks: true });

// rememberPendingBigAccountSelection 中同时保存两种 rows
// 注意：需修改 rememberPendingBigAccountSelection（main.js:391-429）新增 rowsWithEmptyBlocks 字段存储
rememberPendingBigAccountSelection({
  // ... 其他字段不变 ...
  rows: selectionRowsDefault,
  rowsWithEmptyBlocks: selectionRowsWithEmpty
});

return buildBigAccountSelectionRequiredResult({
  rows: selectionRowsDefault,
  rowsWithEmptyBlocks: selectionRowsWithEmpty,
  bigAccounts: templateConfig.bigAccounts,
  fixedAssignments: templateConfig.fixedAssignments
});
```

对应修改 `buildBigAccountSelectionRequiredResult` 返回值新增 `rowsWithEmptyBlocks` 字段：

```javascript
// 返回值新增
rowsWithEmptyBlocks: (rowsWithEmptyBlocks || rows).map((row, index) => ({
  index: Number.isInteger(row.index) ? row.index : index,
  label: `${index + 1}.`,
  sourceRowNumber: Number(row.sourceRowNumber || 0),
  fileName: normalizeCell(row.fileName)
})),
```

### 3.6 Renderer-Dialogs 变更

#### 3.6.1 `createBigAccountSelectionDialog` 多行模式重构（`renderer-dialogs.js:521-797`）

**变更说明：** 删除第 521-797 行的整个多行模式分支，替换为全新实现。简单模式分支（459-519 行）保持不变。

**新实现伪代码：**

```javascript
// renderer-dialogs.js:521 -- 多行模式分支重写
// payload 为对象，包含 { rows, rowsWithEmptyBlocks, bigAccounts, expandedBigAccountOptions, fixedAssignments }

const rows = Array.isArray(payload?.rows) ? payload.rows : [];
const rowsWithEmptyBlocks = Array.isArray(payload?.rowsWithEmptyBlocks) ? payload.rowsWithEmptyBlocks : rows;
const expandedOptions = Array.isArray(payload?.expandedBigAccountOptions) ? payload.expandedBigAccountOptions : [];
const templateId = payload?.templateId;  // 需从调用处传入

const overlay = createOverlay();
const dialog = document.createElement('div');
dialog.className = 'modal-card big-account-selection-card big-account-selection-split';

// --- 状态 ---
let currentMode = 'unfixed';  // 'unfixed' | 'fixed'
let currentFileRows = rows;   // 根据 mode 切换
let checkedOrder = [];         // 已勾选的 merchantId+currency 的有序数组
let savedOrder = null;         // 从后端加载的已保存顺序
let searchMatchIndex = -1;     // 定位搜索当前匹配索引

// --- 初始化：加载已保存的解析模式和顺序 ---
async function initializeState() {
  // IPC 返回前禁用交互，防止竞态（见踩坑预警 5.2）
  modeSelect.disabled = true;
  orderList.style.pointerEvents = 'none';
  orderList.style.opacity = '0.5';

  try {
    const modeResult = await desktopApi.bigAccount.loadMode(templateId);
    currentMode = modeResult.mode || 'unfixed';
    modeSelect.value = currentMode;

    const orderResult = await desktopApi.bigAccount.loadOrder(templateId);
    savedOrder = orderResult.order;
  } catch (_error) {
    // IPC 失败时保持默认值
  }

  // 恢复交互
  modeSelect.disabled = false;
  orderList.style.pointerEvents = '';
  orderList.style.opacity = '';

  syncModeUI();
}

// --- 对话框 DOM 结构 ---
dialog.innerHTML = `
  <div class="dialog-header">
    <div class="dialog-title">请选择本次使用的大账号 / 币种</div>
    <div class="big-account-selection-toolbar">
      <label class="big-account-mode-label">
        <span>多账号账单导入解析模式</span>
        <select class="mapping-select big-account-mode-select">
          <option value="unfixed">账号顺序不固定</option>
          <option value="fixed">账号顺序固定</option>
        </select>
      </label>
      <button class="icon-close" type="button">×</button>
    </div>
  </div>
  <div class="big-account-selection-split-layout">
    <div class="big-account-file-panel">
      <div class="big-account-panel-title">文件顺序</div>
      <div class="big-account-file-list"></div>
      <div class="big-account-search-bar">
        <input class="mapping-text-input big-account-search-input"
               type="text" placeholder="定位大账号" spellcheck="false" />
      </div>
    </div>
    <div class="big-account-order-panel">
      <div class="big-account-panel-title">大账号顺序</div>
      <div class="big-account-order-list"></div>
      <div class="big-account-remember-bar">
        <label class="new-account-checkbox-label">
          <input class="new-account-checkbox big-account-remember-checkbox" type="checkbox" />
          <span>记住大账号选择顺序</span>
        </label>
      </div>
    </div>
  </div>
  <div class="dialog-actions right">
    <button class="primary-btn small" type="button" data-action="done">完成</button>
  </div>
`;

const modeSelect = dialog.querySelector('.big-account-mode-select');
const fileList = dialog.querySelector('.big-account-file-list');
const orderList = dialog.querySelector('.big-account-order-list');
const searchInput = dialog.querySelector('.big-account-search-input');
const rememberCheckbox = dialog.querySelector('.big-account-remember-checkbox');

// --- 渲染左侧文件顺序列表 ---
function renderFileList() {
  fileList.innerHTML = '';
  currentFileRows = currentMode === 'fixed' ? rowsWithEmptyBlocks : rows;

  currentFileRows.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = 'big-account-file-item';
    const text = `${index + 1}. ${row.fileName}+第${row.sourceRowNumber}行`;
    item.textContent = text;
    item.title = text;
    fileList.appendChild(item);
  });

  // 模式切换时，重置右侧勾选（因为行数可能变了）
  resetCheckedOrder();
}

// --- 渲染右侧大账号顺序列表 ---
function renderOrderList() {
  orderList.innerHTML = '';

  // AC1-24：列表为空时显示提示信息
  if (expandedOptions.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'big-account-order-empty-hint';
    hint.textContent = '请先在映射管理中维护大账号和币种';
    orderList.appendChild(hint);
    return;
  }

  expandedOptions.forEach((option, index) => {
    const item = document.createElement('label');
    item.className = 'big-account-order-item';
    item.dataset.merchantId = option.merchantId;
    item.dataset.currency = option.currency;
    item.dataset.optionIndex = index;

    const checkbox = document.createElement('input');
    checkbox.className = 'new-account-checkbox big-account-order-checkbox';
    checkbox.type = 'checkbox';

    const orderLabel = document.createElement('span');
    orderLabel.className = 'big-account-order-number';
    orderLabel.textContent = '';

    const text = document.createElement('span');
    text.className = 'big-account-order-text';
    text.textContent = `${option.merchantId}+${option.currency}`;

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        // 勾选：添加到有序数组
        if (checkedOrder.length >= currentFileRows.length) {
          checkbox.checked = false;  // 超出最大可勾选数量
          return;
        }
        checkedOrder.push({ optionIndex: index, merchantId: option.merchantId, currency: option.currency });
      } else {
        // 取消勾选：从有序数组移除
        checkedOrder = checkedOrder.filter(entry => entry.optionIndex !== index);
      }
      syncOrderLabels();
      // AC1-10：达到上限后自动禁用未勾选项
      syncCheckboxDisabledState();
    });

    item.append(checkbox, orderLabel, text);
    orderList.appendChild(item);
  });
}

// --- 同步序位标签 ---
function syncOrderLabels() {
  const allItems = orderList.querySelectorAll('.big-account-order-item');
  allItems.forEach((item) => {
    const optionIndex = Number(item.dataset.optionIndex);
    const checkbox = item.querySelector('.big-account-order-checkbox');
    const orderLabel = item.querySelector('.big-account-order-number');
    const orderEntry = checkedOrder.findIndex(e => e.optionIndex === optionIndex);

    if (orderEntry >= 0) {
      checkbox.checked = true;
      orderLabel.textContent = `${orderEntry + 1}.`;
    } else {
      checkbox.checked = false;
      orderLabel.textContent = '';
    }
  });
}

// --- AC1-10：同步 checkbox disabled 状态 ---
// 当已勾选数量达到左侧文件行数时，所有未勾选项 checkbox 置为 disabled
function syncCheckboxDisabledState() {
  const atLimit = checkedOrder.length >= currentFileRows.length;
  const allItems = orderList.querySelectorAll('.big-account-order-item');
  allItems.forEach((item) => {
    const checkbox = item.querySelector('.big-account-order-checkbox');
    if (!checkbox.checked) {
      checkbox.disabled = atLimit;
    } else {
      checkbox.disabled = false;  // 已勾选项始终可取消
    }
  });
}

// --- 重置勾选 ---
function resetCheckedOrder() {
  checkedOrder = [];
  syncOrderLabels();
  syncCheckboxDisabledState();
}

// --- 解析模式切换 ---
function syncModeUI() {
  renderFileList();

  // "记住"勾选框仅在 fixed 模式下可用
  rememberCheckbox.disabled = currentMode !== 'fixed';
  if (currentMode !== 'fixed') {
    rememberCheckbox.checked = false;
  }

  // 如果是 fixed 模式且有已保存的顺序，自动预填充
  if (currentMode === 'fixed' && savedOrder && Array.isArray(savedOrder.assignments)) {
    applyPrefilledOrder(savedOrder.assignments);
  }
}

// --- 预填充已保存的顺序 ---
// AC1-26：预填充容错——跳过 expandedOptions 中不存在的 merchantId+currency，
// 不抛异常，不中断预填充流程。用户需手动补选缺失部分。
function applyPrefilledOrder(assignments) {
  checkedOrder = [];
  for (const assignment of assignments) {
    // 已达到文件行数上限，停止预填充
    if (checkedOrder.length >= currentFileRows.length) break;

    const optionIndex = expandedOptions.findIndex(
      opt => opt.merchantId === assignment.merchantId && opt.currency === assignment.currency
    );
    // AC1-26：optionIndex < 0 表示该 merchantId+currency 已不存在，静默跳过
    if (optionIndex >= 0) {
      checkedOrder.push({
        optionIndex,
        merchantId: assignment.merchantId,
        currency: assignment.currency
      });
    }
  }
  syncOrderLabels();
  syncCheckboxDisabledState();
}

// --- 定位搜索 ---
searchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;

  const query = searchInput.value.trim().toLowerCase();
  if (!query) return;

  // 找所有匹配项
  const allItems = Array.from(orderList.querySelectorAll('.big-account-order-item'));
  // AC1-13：子串匹配（不是精确匹配）
  const matchedItems = allItems.filter(
    item => item.dataset.merchantId.toLowerCase().includes(query)
  );

  // AC1-15：无匹配时红色边框闪烁 500ms
  if (!matchedItems.length) {
    searchInput.classList.add('is-flash-error');
    setTimeout(() => searchInput.classList.remove('is-flash-error'), 500);
    return;
  }

  // 循环定位
  searchMatchIndex = (searchMatchIndex + 1) % matchedItems.length;
  const targetItem = matchedItems[searchMatchIndex];

  // 移除所有高亮
  allItems.forEach(item => item.classList.remove('is-search-highlight'));
  // 添加高亮
  targetItem.classList.add('is-search-highlight');
  // 滚动到可视区域
  targetItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

// 输入内容变化时重置循环索引
searchInput.addEventListener('input', () => {
  searchMatchIndex = -1;
  orderList.querySelectorAll('.big-account-order-item').forEach(
    item => item.classList.remove('is-search-highlight')
  );
});

// --- 模式切换事件 ---
modeSelect.addEventListener('change', async () => {
  currentMode = modeSelect.value;
  // 保存模式选择
  await desktopApi.bigAccount.saveMode({ templateId, mode: currentMode });
  // 重置搜索状态（高亮和循环索引）
  searchMatchIndex = -1;
  searchInput.value = '';
  orderList.querySelectorAll('.big-account-order-item').forEach(
    item => item.classList.remove('is-search-highlight')
  );
  syncModeUI();
});

// --- 关闭 ---
dialog.querySelector('.icon-close').addEventListener('click', closeModal);

// --- 完成 ---
dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
  if (checkedOrder.length !== currentFileRows.length) {
    setStatus('请为每一行文件数据选择对应的大账号和币种', 'error');
    return;
  }

  // 构建 assignments
  const assignments = checkedOrder.map((entry, orderIndex) => ({
    rowIndex: currentFileRows[orderIndex].index,
    merchantId: entry.merchantId,
    currency: entry.currency
  }));

  // AC1-27：勾选"记住"则保存顺序，未勾选则清除已保存的 JSON
  if (rememberCheckbox.checked && currentMode === 'fixed') {
    await desktopApi.bigAccount.saveOrder({ templateId, assignments });
  } else if (!rememberCheckbox.checked && currentMode === 'fixed') {
    // 未勾选"记住" + 点击完成 = 清除已保存的顺序 JSON
    await desktopApi.bigAccount.saveOrder({ templateId, assignments: [] });
  }

  // 调用后端 IPC（v1.4.7：新增 mode 字段，供后端选择正确的 rows 校验和空块处理）
  const result = await desktopApi.files.completeBigAccountSelection({ assignments, mode: currentMode });

  closeModal();
  applyStatementResult(result);

  if (result.status === 'error' && !result.manualBalancePromptReady) {
    openModal(createAlertDialog(result.message));
  }
});

// --- 初始化渲染 ---
renderOrderList();
initializeState();

overlay.appendChild(dialog);
return overlay;
```

**关键设计说明：**

1. **`checkedOrder` 数组**：按勾选先后顺序存储 `{ optionIndex, merchantId, currency }`，取消勾选时 filter 移除并重排标签。
2. **最大可勾选数量（AC1-10）**：`checkedOrder.length >= currentFileRows.length` 时，所有未勾选的 checkbox 自动 `disabled`，已勾选项仍可取消。由 `syncCheckboxDisabledState()` 管理。
3. **`initializeState` 异步初始化**：对话框先同步渲染结构，IPC 返回前禁用右侧交互（disabled + opacity），返回后恢复并 `syncModeUI()` 更新。避免 IPC 延迟导致空白或竞态。
4. **模式切换（AC1-25）**：切换时重新渲染左侧文件列表（行数可能变化），`resetCheckedOrder()` 清空右侧勾选序位，同时重置搜索状态（`searchMatchIndex`、高亮、输入框内容）。
5. **`payload.templateId`**：需从调用处传入。当前 `createBigAccountSelectionDialog` 不接收 `templateId`，需要在 `handleImportFile`（renderer.js）中传递。
6. **定位搜索（AC1-13/AC1-15）**：使用 `.includes()` 子串匹配（非精确匹配）；无匹配时搜索框红色边框闪烁 500ms。
7. **空列表（AC1-24）**：`expandedOptions` 为空时，右侧列表显示"请先在映射管理中维护大账号和币种"提示文本。
8. **预填充容错（AC1-26）**：加载已保存顺序时，静默跳过不存在的 `merchantId+currency`。使用 `checkedOrder.length < currentFileRows.length` 做上限判断（非 `assignmentIndex`），避免跳过失效项后误截断有效项。
9. **取消记住（AC1-27）**：未勾选"记住"时点击"完成"，发送空 `assignments: []` 清除已保存的 JSON。
10. **`mode` 字段传递后端**："完成"按钮 payload 新增 `mode: currentMode`，后端据此选择 `pendingContext.rows` 或 `pendingContext.rowsWithEmptyBlocks` 进行校验，以及 `applyBigAccountAssignmentsToFileEntries` 是否传递 `includeEmptyBlocks: true`。
11. **`rowsWithEmptyBlocks` 在 `buildBigAccountSelectionRequiredResult` 中的参数**：函数签名已包含 `rowsWithEmptyBlocks`，与 3.5.7 中的调用处一致。

#### 3.6.2 `handleImportFile` 调用处适配（`renderer.js:2619-2621`）

当前代码：

```javascript
// renderer.js:2619-2621
if (result.status === 'select-big-account') {
  openModal(createBigAccountSelectionDialog(result));
  return;
}
```

需确保 `result` 中包含 `templateId`（由后端返回）或在前端补充：

```javascript
// renderer.js:2619-2621 -- 传入 templateId
if (result.status === 'select-big-account') {
  openModal(createBigAccountSelectionDialog({
    ...result,
    templateId: Number(state.selectedTemplateId)
  }));
  return;
}
```

#### 3.6.3 简单模式分支清理（`renderer-dialogs.js:498-507`）

移除 `fixed: false` 字段：

```javascript
// renderer-dialogs.js:498-507 -- 修改前
const result = await desktopApi.files.completeBigAccountSelection({
  assignments: [
    {
      rowIndex: 0,
      merchantId: selectedOption.merchantId,
      currency: selectedOption.currency
    }
  ],
  fixed: false
});

// 修改后：移除 fixed 字段
const result = await desktopApi.files.completeBigAccountSelection({
  assignments: [
    {
      rowIndex: 0,
      merchantId: selectedOption.merchantId,
      currency: selectedOption.currency
    }
  ]
});
```

### 3.7 样式变更

#### 3.7.1 `src/styles.css` 新增样式

```css
/* ===== v1.4.7 大账号选择对话框重构 ===== */

.big-account-selection-split {
  width: min(100%, 1040px);
}

.big-account-selection-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
}

.big-account-mode-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
}

.big-account-mode-select {
  min-width: 160px;
  height: 36px;
  border-radius: 10px;
  font-size: 13px;
}

/* 左右分栏 */
.big-account-selection-split-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  min-height: 320px;
  max-height: 480px;
}

.big-account-file-panel,
.big-account-order-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.big-account-panel-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  padding-left: 2px;
}

.big-account-file-list,
.big-account-order-list {
  flex: 1 1 0;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #fffdf9;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 文件顺序列表项 */
.big-account-file-item {
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: rgba(224, 208, 182, 0.12);
}

/* 大账号顺序列表项 */
.big-account-order-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.big-account-order-item:hover {
  background: rgba(154, 90, 26, 0.06);
}

.big-account-order-item.is-search-highlight {
  background: rgba(154, 90, 26, 0.14);
  box-shadow: inset 0 0 0 1px rgba(154, 90, 26, 0.3);
}

.big-account-order-number {
  min-width: 24px;
  font-size: 13px;
  font-weight: 700;
  color: var(--primary);
  text-align: right;
}

.big-account-order-text {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 定位搜索 */
.big-account-search-bar {
  padding-top: 4px;
}

.big-account-search-input {
  height: 36px;
  border-radius: 10px;
  font-size: 13px;
}

/* AC1-15：定位搜索无匹配时红色边框闪烁动画 */
.big-account-search-input.is-flash-error {
  animation: search-flash-error 500ms ease;
}

@keyframes search-flash-error {
  0%, 100% { border-color: var(--line); }
  25%, 75% { border-color: #e74c3c; box-shadow: 0 0 0 2px rgba(231, 76, 60, 0.2); }
}

/* AC1-24：大账号列表为空时的提示 */
.big-account-order-empty-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
  padding: 20px;
}

/* AC1-10：达到勾选上限时 disabled 样式 */
.big-account-order-checkbox:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* 记住勾选框 */
.big-account-remember-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}
```

---

## 四、数据流变更总览

### 4.1 需求 1 IPC 通道变更

| IPC 通道 | 变更类型 | 方向 | 说明 |
|----------|---------|------|------|
| `big-account-mode:load` | 新增 | renderer -> main | 加载模板的解析模式 |
| `big-account-mode:save` | 新增 | renderer -> main | 保存模板的解析模式 |
| `big-account-order:load` | 新增 | renderer -> main | 加载已保存的大账号选择顺序 |
| `big-account-order:save` | 新增 | renderer -> main | 保存大账号选择顺序 |
| `file:complete-big-account-selection` | 修改 | renderer -> main | payload 移除 `fixed` 字段，新增 `mode` 字段（`'unfixed'` / `'fixed'`） |

### 4.2 需求 1 本地存储变更

| 存储路径 | 变更类型 | 内容 |
|----------|---------|------|
| `{storageRoot}/big-account-modes/{templateId}.json` | 新增 | `{ templateId, mode: 'unfixed'\|'fixed', updatedAt }` |
| `{storageRoot}/big-account-orders/{templateId}.json` | 新增 | `{ templateId, assignments: [{rowIndex, merchantId, currency}], updatedAt }` |

### 4.3 需求 1 返回值变更

`buildBigAccountSelectionRequiredResult` 返回值新增字段：

```typescript
// 新增字段
expandedBigAccountOptions: Array<{ merchantId: string, currency: string }>
rowsWithEmptyBlocks: Array<{ index, label, sourceRowNumber, fileName }>
```

---

## 五、踩坑预警

### 5.1 `identifyAccountBlocks` 空块模式不能破坏现有逻辑

**风险等级：高**

现有所有调用 `identifyAccountBlocks` 的地方（`buildBigAccountSelectionRows`、`file:import` handler 中的 `totalBlocks` 计算）都不传 options，必须保持 `includeEmptyBlocks = false` 默认值。新增参数时务必使用 `options = {}` 解构模式，不要改变函数签名的位置参数。

**验证方法：** 全局搜索 `identifyAccountBlocks(` 确认所有调用处。

### 5.2 `initializeState` 异步时序与竞态

**风险等级：中**

`createBigAccountSelectionDialog` 返回 overlay DOM 后立即被 `openModal` 挂载到 DOM。但 `initializeState` 是异步的（需要 2 次 IPC invoke）。必须确保：
- 对话框先渲染默认状态（`unfixed` 模式 + 空勾选），再异步更新。
- 用户在 IPC 返回前操作不会崩溃。

**竞态风险：** 如果用户在 IPC 返回前开始勾选右侧列表，之后 `initializeState` 完成调用 `syncModeUI()` -> `renderFileList()` -> `resetCheckedOrder()`，会清空用户已做的勾选。

**方案：** 在 `initializeState` 执行期间，右侧列表和模式选择器置为不可交互状态（加 loading 遮罩或 disabled）。IPC 返回后恢复交互。

```javascript
// initializeState 开始前
modeSelect.disabled = true;
orderList.style.pointerEvents = 'none';
orderList.style.opacity = '0.5';

async function initializeState() {
  // ... IPC calls ...
  // 恢复交互
  modeSelect.disabled = false;
  orderList.style.pointerEvents = '';
  orderList.style.opacity = '';
  syncModeUI();
}
```

**测试建议：** 测试用例应覆盖 IPC 延迟场景（可通过网络模拟），验证加载期间 UI 不可操作。

### 5.3 前端 `templateId` 传递

**风险等级：中**

当前 `createBigAccountSelectionDialog` 接收的 `payload` 来自后端 `buildBigAccountSelectionRequiredResult` 的返回值，该返回值不含 `templateId`。需要在前端调用处补充 `templateId: Number(state.selectedTemplateId)`。

### 5.4 `file:complete-big-account-selection` handler 的 `assignments` 格式兼容

**风险等级：低**

新的前端传递的 `assignments` 格式与旧版本相同（`[{ rowIndex, merchantId, currency }]`），后端 handler 不需要修改 assignments 处理逻辑，仅需删除 `fixed` 相关代码。

### 5.5 `expandBigAccountConfigurations` 结果顺序稳定性

**风险等级：低**

`expandBigAccountConfigurations`（`main.js:841-863`）遍历 bigAccounts 数组，每个 item 内部遍历 currencies。顺序由数据库中 `template_big_accounts` 的 `row_index` 决定，是稳定的。右侧列表顺序与数据库一致。

### 5.6 "记住顺序"与 bigAccounts 配置变更的不一致

**风险等级：中**

用户可能先保存了选择顺序，之后在映射管理中修改了大账号列表（新增/删除/改币种）。下次打开时，保存的 assignments 中的 merchantId+currency 可能在当前 expandedOptions 中不存在。

**处理方案（AC1-26）：** `applyPrefilledOrder` 中通过 `expandedOptions.findIndex` 匹配，匹配不到的自动跳过（不抛异常）。如果预填充后 `checkedOrder.length < currentFileRows.length`，用户需手动补选。

### 5.7 旧版 `fixedAssignments` 数据兼容（AC1-28）

**风险等级：中**

旧版本通过"固定"按钮将 `fixedAssignments` 保存在数据库的模板映射中。v1.4.7 移除了"固定"按钮和写入逻辑，但数据库中可能仍残留旧数据。`buildBigAccountSelectionRequiredResult` 仍返回 `fixedAssignments` 字段（兼容），但新前端不再消费该字段。

**关键点：** 后端 `file:complete-big-account-selection` handler 删除 `payload.fixed` 分支（`main.js:4352-4364`）后，handler 中**不再有任何路径**读取或消费 `payload.fixed` 或 `fixedAssignments`。逐行确认：
- `payload.assignments` — 仍正常消费（`main.js:4305-4311`）
- `pendingContext.bigAccounts` — 仍正常消费（`main.js:4304`）
- `pendingContext.rows` — 仅用于 `.length` 校验（`main.js:4313`）
- `payload.fixed` — 仅在被删除的 `if (Boolean(payload.fixed))` 分支中使用，删除后无残留引用
- `normalizedAssignments` 写入 `saveMappings` 的调用也在被删除分支内

旧的 `fixedAssignments` 数据仍存在于数据库中但不会被消费，不会引发异常。无需额外迁移操作。

### 5.8 模式切换立即保存的时序影响

**风险等级：低**

模式切换事件中立即调用 `await desktopApi.bigAccount.saveMode()`。如果用户切换模式后关闭对话框（点击 x 取消），模式已被保存但本次导入被取消。下次打开对话框时模式会是上次切换的值。此行为**符合 PRD AC1-3（"保留上次选择"）的要求**，是预期行为。

**测试建议：** 测试用例应覆盖"切换模式 -> 关闭对话框 -> 重新导入 -> 确认模式已保留"场景。

### 5.9 `readBigAccountOrder` 读取空/损坏文件容错

**风险等级：低**

`readBigAccountOrder` 已通过 try-catch 包裹 JSON.parse，损坏文件返回 `null`。`assignments: []`（由 AC1-27 清除操作写入）会被 `Array.isArray` 校验通过但为空数组，`applyPrefilledOrder` 收到空数组后 `checkedOrder` 保持空，行为正确。

---

## 六、实施顺序

| 步骤 | 内容 | 涉及文件 |
|------|------|---------|
| 1 | 需求 2：修改新开账户文件命名逻辑 | `src/main.js` |
| 2 | 新增后端存储模块 | `src/backend/big-account-order-store.js`, `src/backend/big-account-mode-store.js` |
| 3 | 新增 IPC handler 和 preload 注册 | `src/main.js`, `src/preload.js` |
| 4 | 修改 `identifyAccountBlocks` 和 `buildBigAccountSelectionRows` | `src/main.js` |
| 5 | 修改 `buildBigAccountSelectionRequiredResult` | `src/main.js` |
| 6 | 修改 `file:complete-big-account-selection` handler（移除 fixed + 新增 mode 校验 + includeEmptyBlocks 透传） | `src/main.js` |
| 7 | 重构 `createBigAccountSelectionDialog` 多行模式 | `src/renderer-dialogs.js` |
| 8 | 前端调用处适配（传 templateId、移除 fixed） | `src/renderer.js`, `src/renderer-dialogs.js` |
| 9 | 新增 CSS 样式 | `src/styles.css` |
| 10 | 更新 `package.json` 版本号为 `1.4.7` | `package.json` |

---

## 七、版本号变更

```json
// package.json
"version": "1.4.7"
```

---

## 八、修订记录

| 日期 | 修订内容 |
|------|---------|
| 2026-03-31 | 初版生成 |
| 2026-03-31 | 根据 PRD 修订（tester 12 项反馈）更新技术文档，涉及以下变更：|

**PRD 修订对应的技术文档更新项：**

1. **AC1-10 勾选上限交互**：新增 `syncCheckboxDisabledState()` 函数，达到上限时自动 disabled 未勾选项（§3.6.1 伪代码 + §3.7.1 CSS）
2. **AC1-13 搜索方式**：定位搜索由精确匹配 `===` 改为子串匹配 `.includes()`（§3.6.1 伪代码）
3. **AC1-15 无匹配反馈**：无匹配时搜索框红色边框闪烁 500ms，新增 `.is-flash-error` CSS 动画（§3.6.1 伪代码 + §3.7.1 CSS）
4. **AC1-24 空列表提示**：`expandedOptions` 为空时显示"请先在映射管理中维护大账号和币种"（§3.6.1 伪代码 + §3.7.1 CSS）
5. **AC1-25 模式切换清空**：确认 `resetCheckedOrder()` 在 `renderFileList()` 中已调用，补充 `syncCheckboxDisabledState()` 调用（§3.6.1 伪代码）
6. **AC1-26 预填充容错**：`applyPrefilledOrder` 增加明确注释，补充 `syncCheckboxDisabledState()` 调用（§3.6.1 伪代码 + §5.6 踩坑预警）
7. **AC1-27 取消记住清除**："完成"按钮未勾选"记住"时发送 `assignments: []` 清除 JSON（§3.6.1 伪代码）
8. **AC1-28 旧数据兼容**：新增 §5.7 踩坑预警，说明旧 `fixedAssignments` 数据无需迁移
9. **新增 §5.8**：`readBigAccountOrder` 空/损坏文件容错说明
10. **关键设计说明**：从 5 项扩充为 9 项，涵盖所有 PRD 修订涉及的设计要点

| 2026-03-31 | 根据 Tester 技术文档评审（12 项反馈）更新技术文档 |

**Tester 评审反馈处理记录（12 项）：**

| # | 反馈项 | 优先级 | 处理方式 |
|---|--------|--------|---------|
| 1 | 搜索匹配逻辑与 PRD 不一致 | 高 | 已在上一轮修订中修正为 `.includes()`（§3.6.1） |
| 2 | AC1-10 disabled 行为未实现 | 高 | 已在上一轮修订中新增 `syncCheckboxDisabledState()`（§3.6.1） |
| 3 | AC1-15 红色闪烁未实现 | 高 | 已在上一轮修订中新增 `.is-flash-error` 动画（§3.6.1 + §3.7.1） |
| 4 | AC1-27 取消记住时清除未实现 | 高 | 已在上一轮修订中新增 `else if` 分支（§3.6.1） |
| 5 | AC1-24 空列表提示未实现 | 高 | 已在上一轮修订中新增 empty state（§3.6.1 + §3.7.1） |
| 6 | AC1-28 fixedAssignments 兼容性不明确 | 高 | 补充 handler 中逐行确认无残留消费路径（§5.7） |
| 7 | `file:import` 两套 rows 的 rowIndex 映射 | 中 | **关键修正**：handler 新增 `payload.mode` 字段，按模式选择 rows 校验 + `applyBigAccountAssignmentsToFileEntries` 透传 `includeEmptyBlocks`（§3.5.5 重大补充） |
| 8 | 模式切换立即保存的时序 | 中 | 确认符合 AC1-3 预期行为，新增 §5.8 踩坑预警 + 测试建议 |
| 9 | `initializeState` 异步竞态 | 中 | 新增 IPC 返回前 disabled + opacity 遮罩方案（§5.2 + §3.6.1 伪代码） |
| 10 | `applyPrefilledOrder` 中 `assignmentIndex` 截断问题 | 中 | **修正**：改为 `checkedOrder.length >= currentFileRows.length` 做上限（§3.6.1 伪代码） |
| 11 | `buildBigAccountSelectionRequiredResult` 函数签名缺 `rowsWithEmptyBlocks` | 低 | 已补充参数到函数签名（§3.5.4） |
| 12 | 搜索高亮在模式切换后未重置 | 低 | 模式切换事件中新增搜索状态重置逻辑（§3.6.1 伪代码） |
