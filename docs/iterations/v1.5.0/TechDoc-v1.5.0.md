# TechDoc - 网银账单小助手 v1.5.0

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.0 |
| 日期 | 2026-04-08 |
| 作者 | Dev |
| 状态 | 已定稿（2026-04-08） |
| 关联 PRD | `docs/iterations/v1.5.0/PRD-v1.5.0.md`（36 AC：AC1-1 ~ AC1-11 + AC2-1 ~ AC2-21 + AC3-1 ~ AC3-4） |
| 依赖 | v1.4.9 已 merged 到 main，v1.5.0 从 main 起分支 |

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §4.1 精度提升到 12 位 | `sanitizeAmountValue`（normalizers.js:91）不截断小数位，`parseNumericValue`（normalizers.js:19）用 `Number()` 转换——12 位小数 + 整数部分 ≤ 3 位 = 15 位有效数字，在 IEEE 754 安全范围内。整数部分超过 3 位时（如 `12345.123456789012` = 17 位有效数字）会溢出，需要在 Excel 输出阶段自动切文本格式（Q-A2 = A2-3）。无技术阻碍。 |
| §4.1.5 `roundAmount` 新增高精度版本 | 现有 `roundAmount`（normalizers.js:41）为 `toFixed(2)`，保留用于 `inferEndingBalance` 的余额比对容差逻辑。新增 `roundAmountHighPrecision` 用 `toFixed(12)` + 去尾零用于 `calculateEndingBalanceFromAmounts`。无技术阻碍。 |
| §4.3 文件顺序帮助图标 | 纯 UI 需求。在 `createBigAccountSelectionDialog`（renderer-dialogs.js:595）的 `文件顺序：` 文本旁添加 HTML 圆形 `?` 图标 + CSS tooltip。无技术阻碍。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | §4.2.2 账户识别算法需要读取"表头上方"的原始行数据，但 `readRowsWithMetadata`（readers.js:262）返回的 `rows` 仅包含表头匹配后的数据，不含表头上方行。**检查排序需要单独读取原始文件行** —— 使用 `readRows`（readers.js:155）获取原始行，结合 `readRowsWithMetadata` 返回的 `rowNumbers` 定位表头在原始文件中的行号。详见 §3.2。 | 不动 PRD，在 TechDoc 落定。 |
| R-2 | §4.2.2 多账号场景需要知道每个账户块的表头行号和尾行行号。`identifyAccountBlocks`（main.js:535）返回 `startIndex` / `endIndex`（基于 detailRows 的 data index），但其 `startRowNumber` 对应的是 data row 的原始行号，不是表头行号。表头行号来自 `headerBreaks`（readers.js:233 记录重复表头的原始行号），第一个账户块的表头行号来自 `matchedRowIndex`。**需要在 IPC 里同时传递 `headerBreaks` 和 `matchedRowIndex` 信息。** | 不动 PRD，在 TechDoc 落定。 |
| R-3 | §4.2 检查排序的 IPC 设计：前端按钮点击 → 发 IPC 到后端 → 后端读取文件原始行 + 识别账户 + 匹配 → 返回结果。由于 `lastPendingBigAccountSelection`（main.js:90）已保存了 `fileEntries`（含 `filePath` 和 `detailRows`）和 `bigAccounts`，后端可以直接利用这些信息完成检查。**新增 1 个 IPC handler `file:check-sort`。** | 不动 PRD，在 TechDoc 落定。 |

### 1.3 与 PRD 的差异（无）

Dev 不在本 TechDoc 中改写 PRD 任何条款。

---

## 二、架构总览

### 2.1 涉及的文件清单

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/file-service/normalizers.js` | 修改 | 新增 `roundAmountHighPrecision`；修改 `calculateEndingBalanceFromAmounts` 使用高精度；导出新函数 |
| `src/backend/file-service/writers.js` | 修改 | `applyExportFieldFormats` / `applyBalanceFieldFormats` 的 numericFields 处理增加 15 位有效数字判定 + 文本格式降级 |
| `src/backend/file-service.js` | 修改 | 导出新增的 `readRows` 函数供 main.js 的 check-sort IPC 使用 |
| `src/main.js` | 修改 | 新增 `file:check-sort` IPC handler；新增 `identifyAccountsFromRawRows` 函数 |
| `src/preload.js` | 修改 | 暴露 `file:check-sort` IPC 通道 |
| `src/renderer-dialogs.js` | 修改 | `createBigAccountSelectionDialog` 新增"检查排序"按钮 + tooltip 帮助图标 |
| `src/styles.css` | 修改 | 新增 `.file-order-help-icon` + `.file-order-tooltip` 样式；新增 `.check-sort-btn` 样式 |
| `package.json` | 修改 | `version` 字段从 `1.4.9` 升级为 `1.5.0` |
| `docs/iterations/v1.5.0/TechDoc-v1.5.0.md` | 新建 | 本文件 |

---

## 三、需求 1：精度 12 位 —— 详细设计

### 3.1 精度链路分析

金额从源文件到 Excel 输出的完整链路：

```
源文件单元格值
  ↓
sanitizeAmountValue (normalizers.js:91)  ← 清洗为纯数字字符串，不截断小数位 ✅ 无需修改
  ↓
parseNumericValue (normalizers.js:19)    ← Number() 转换，15~17 位有效数字 ✅ 无需修改（见 §3.1.1）
  ↓
splitSignedAmountValue (normalizers.js:274) ← Math.abs + String ✅ 无需修改（见 §3.1.2）
  ↓
roundAmount (normalizers.js:41)          ← toFixed(2)，仅用于余额比对容差 ✅ 保留不动
  ↓
calculateEndingBalanceFromAmounts (normalizers.js:85) ← ⚠️ 需要修改，改用 roundAmountHighPrecision
  ↓
Excel 输出 (writers.js:6 / writers.js:85) ← ⚠️ 需要修改，增加 15 位有效数字判定
```

#### 3.1.1 `parseNumericValue` 精度评估

`Number()` 的精度为 IEEE 754 双精度浮点数，约 15-17 位有效数字。对于 12 位小数的金额：
- 整数部分 ≤ 3 位时（如 `123.123456789012`）：总有效数字 = 15 位，在安全范围内。
- 整数部分 4-5 位时（如 `12345.123456789012`）：总有效数字 = 17 位，边界情况可能丢失末位精度，但 `Number()` 仍能表示大部分值。
- 整数部分 > 5 位时：有效数字超过 17 位，`Number()` 会丢失精度。此时通过 Excel 输出的文本格式降级保底（§3.3）。

**结论**：不修改 `parseNumericValue`。绝大多数银行金额的整数部分不超过 10 位，12 位小数场景总有效数字 ≤ 22 位，超过 15 位有效数字的情况通过 Excel 文本格式降级处理。

#### 3.1.2 `splitSignedAmountValue` 评估

`String(Math.abs(numericValue))` 不会补零也不会截断——`String(0.123456789012)` 输出 `"0.123456789012"`（在 IEEE 754 精度范围内）。**不需要修改。**

### 3.2 `roundAmountHighPrecision` 新增函数

位置：`src/backend/file-service/normalizers.js`，紧接 `roundAmount` 之后。

```javascript
function roundAmountHighPrecision(value) {
  const result = Number(Number(value).toFixed(12));
  return result;
}
```

设计说明：
- `toFixed(12)` 四舍五入到 12 位小数，返回字符串。
- 外层 `Number()` 去掉尾部零（如 `"100.500000000000"` → `100.5`），满足 Q-A1 "不补零"要求。
- 保留 `roundAmount` 不变（`toFixed(2)`），`inferEndingBalance` 继续使用它做余额比对容差。

### 3.3 `calculateEndingBalanceFromAmounts` 修改

将内部调用从 `roundAmount` 改为 `roundAmountHighPrecision`：

```javascript
function calculateEndingBalanceFromAmounts({ previousEndBalance, entries }) {
  const creditAmountSum = entries.reduce((sum, entry) => sum + entry.creditAmount, 0);
  const debitAmountSum = entries.reduce((sum, entry) => sum + entry.debitAmount, 0);
  return roundAmountHighPrecision(previousEndBalance + creditAmountSum - debitAmountSum);
}
```

### 3.4 Excel 输出格式修改

位置：`src/backend/file-service/writers.js`

#### 3.4.1 有效数字计算辅助函数

新增 `countSignificantDigits(value)` 函数：

```javascript
function countSignificantDigits(value) {
  const absStr = String(Math.abs(value));
  const cleaned = absStr.replace('.', '').replace(/^0+/, '');
  return cleaned.length;
}
```

#### 3.4.2 `applyExportFieldFormats` numericFields 处理修改

当前 numericFields（`Balance`、`Credit Amount`、`Debit Amount`）统一写入 `{ t: 'n', v: numericValue, z: '0.00' }`。

修改为：
- 检查 `countSignificantDigits(numericValue) > 15`
- 若超过 15 位有效数字 → `{ t: 's', v: String(numericValue), z: '@' }`（文本格式）
- 若 ≤ 15 位有效数字 → 检查是否有超过 2 位小数
  - 有超过 2 位小数 → `{ t: 'n', v: numericValue }` （数字格式，不指定 `z`，使用 Excel 默认格式以避免补零）
  - ≤ 2 位小数 → `{ t: 'n', v: numericValue, z: '0.00' }`（保持原格式，向下兼容）

#### 3.4.3 `applyBalanceFieldFormats` 同理修改

余额账单的 numericFields（`期初余额`、`期初可用余额`、`期末余额`、`期末可用余额`）应用相同的精度判定逻辑。

---

## 四、需求 2：检查排序 —— 详细设计

### 4.1 IPC 设计

```
前端: "检查排序" 按钮点击
  ↓
renderer-dialogs.js: desktopApi.files.checkSort({ assignments: checkedOrder })
  ↓
preload.js: ipcRenderer.invoke('file:check-sort', payload)
  ↓
main.js: ipcMain.handle('file:check-sort', handler)
  ↓
返回: { status: 'ok', resultCode: 'R1'|'R2'|..., message: '...' }
```

### 4.2 后端：`file:check-sort` IPC handler

位置：`src/main.js`，在 `file:complete-big-account-selection` handler 附近。

#### 4.2.1 入参

```javascript
{
  assignments: [
    { merchantId: '62001234567890', currency: 'CNY' },
    { merchantId: '62009876543210', currency: 'USD' }
  ]
}
```

`assignments` 数组按用户勾选的序号排列（index 0 = 序号 1）。

#### 4.2.2 处理流程

```
1. 校验: lastPendingBigAccountSelection 是否存在
2. 校验: assignments 非空（前端已校验，后端双保险）
3. 遍历所有文件 (pendingContext.fileEntries):
   a. 读取原始文件行: readRows(entry.filePath)
   b. 读取带元数据的行: entry.detailRows (已在 pendingContext 中)
   c. 识别账户块: identifyAccountBlocks(entry.detailRows)
   d. 对每个账户块，定位候选区域（表头上方的行）
   e. 在候选区域中搜索大账号的 merchantId
4. 汇总文件内账户顺序
5. 与用户勾选的 assignments 做比较
6. 返回匹配结果
```

#### 4.2.3 账户识别算法：`identifyAccountsFromRawRows`

新增函数，位置在 `identifyAccountBlocks` 附近。

```javascript
function identifyAccountsFromRawRows({
  filePath,
  detailRows,
  bigAccounts,
  expectedSourceHeaders
}) {
  // 1. 读取原始文件全部行（含表头上方的行）
  const rawRows = readRows(filePath);

  // 2. 识别账户块
  const headerBreaks = Array.isArray(detailRows.headerBreaks) ? detailRows.headerBreaks : [];
  const rowMetas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];
  const blocks = identifyAccountBlocks(detailRows);

  // 3. 定位表头在原始文件中的行号
  //    第一个表头行号：找到 detailRows[0]（即 header row）对应的原始行号
  //    通过在 rawRows 中搜索匹配 expectedSourceHeaders 的行来定位
  const headerRowNumbers = findHeaderRowNumbers(rawRows, expectedSourceHeaders, headerBreaks);

  // 4. 定位每个账户块的尾行行号
  //    block.endIndex 是 data rows 中的 index (0-based, relative to detailRows.slice(1))
  //    对应原始行号 = rowMetas[block.endIndex]?.sourceRowNumber

  // 5. 对每个账户块，确定候选搜索区域：
  //    - 排序第一的账户：从文件第 1 行到该账户的表头行（不含表头行本身）
  //    - 排序第 N 的账户 (N > 1)：从前一个账户的尾行到该账户的表头行之间
  // 6. 在候选区域中搜索 merchantId
  // 7. 返回识别结果数组
}
```

#### 4.2.4 表头行号定位：`findHeaderRowNumbers`

```javascript
function findHeaderRowNumbers(rawRows, expectedSourceHeaders, headerBreaks) {
  // expectedSourceHeaders = 模板的源表头字段数组
  // 在 rawRows 中找到匹配 expectedSourceHeaders 的行
  const normalizedExpected = expectedSourceHeaders
    .map(h => normalizeCell(h))
    .filter(h => h !== '');
  
  const headerRowNumbers = [];
  
  rawRows.forEach((row, index) => {
    const rowNumber = index + 1;
    const normalizedCells = (Array.isArray(row) ? row : [])
      .map(cell => normalizeCell(cell));
    
    // 检查这一行是否包含所有期望的表头
    const matchStart = normalizedCells.findIndex((cell, ci) => {
      if (ci + normalizedExpected.length > normalizedCells.length) return false;
      return normalizedExpected.every((exp, ei) => normalizedCells[ci + ei] === exp);
    });
    
    if (matchStart >= 0) {
      headerRowNumbers.push(rowNumber);
    }
  });
  
  return headerRowNumbers;
}
```

#### 4.2.5 候选区域搜索与匹配

对每个账户块的候选区域，逐行逐单元格搜索 merchantId：

**第一步：精准匹配**
```javascript
function exactMatchMerchantId(cellValue, merchantId) {
  return normalizeCell(cellValue) === normalizeCell(merchantId);
}
```

**第二步：模糊匹配（精准匹配未命中时）**

子步骤 1：去特殊字符后精确匹配
```javascript
function stripSpecialChars(value) {
  return String(value || '').replace(/[\s\-_()（）[\]【】]/g, '');
}

function fuzzyExactMatch(cellValue, merchantId) {
  const a = stripSpecialChars(normalizeCell(cellValue));
  const b = stripSpecialChars(normalizeCell(merchantId));
  return a !== '' && b !== '' && a === b;
}
```

子步骤 2：包含匹配
```javascript
function containsMatch(cellValue, merchantId) {
  const a = stripSpecialChars(normalizeCell(cellValue));
  const b = stripSpecialChars(normalizeCell(merchantId));
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}
```

#### 4.2.6 匹配结果判定

```
输入：
  fileAccounts = [{ merchantId, matchType: 'exact'|'fuzzy' }, ...]  // 文件内账户顺序
  userAccounts = [{ merchantId, currency }, ...]                     // 用户勾选顺序

算法：
  isSingleAccount = (fileAccounts 来自单账号文件)
  
  if (isSingleAccount):
    // 单账号场景
    if fileAccounts[0] 能匹配 userAccounts 中任意一个:
      → RS1: "排序检查无误，请自行再做检查。"
    else:
      → RS2: "匹配不上，请检查。"
  
  else:
    // 多账号场景
    countMatch = (fileAccounts.length === userAccounts.length)
    compareLen = min(fileAccounts.length, userAccounts.length)
    
    // 逐位比较
    allExact = true
    allMatch = true
    for i in 0..compareLen-1:
      matched = compareAccounts(fileAccounts[i].merchantId, userAccounts[i].merchantId)
      if matched === 'none':
        allMatch = false
        allExact = false
      elif matched === 'fuzzy':
        allExact = false
    
    if countMatch && allExact:
      → R1: "排序检查无误，请自行再做检查。"
    elif countMatch && allMatch && !allExact:
      → R3: "账户顺序在模糊匹配下排序无误，请检查。"
    elif countMatch && !allMatch:
      → R4: "账户顺序匹配不上，请检查。"
    elif !countMatch && allMatch:
      → R2: "账户个数匹配不上，请检查。"
    elif !countMatch && !allMatch:
      → R5: "账户个数和顺序都匹配不上，请检查。"
```

### 4.3 前端："检查排序"按钮

位置：`src/renderer-dialogs.js`，`createBigAccountSelectionDialog` 的 footer 区域。

#### 4.3.1 按钮位置

在 `dialog-actions big-account-selection-footer` 内，`定位大账号` 之前（最左侧）插入：

```html
<button class="secondary-btn small check-sort-btn" type="button" data-action="check-sort">检查排序</button>
```

#### 4.3.2 按钮点击逻辑

```javascript
checkSortBtn.addEventListener('click', async () => {
  // 1. 前置校验：是否有勾选
  if (checkedOrder.length === 0) {
    openModal(createAlertDialog('未勾选任何大账号，请检查。'));
    return;
  }

  // 2. 构建 assignments
  const assignments = checkedOrder.map(item => ({
    merchantId: item.merchantId,
    currency: item.currency
  }));

  // 3. 发 IPC
  const result = await desktopApi.files.checkSort({ assignments });

  // 4. 弹提醒框
  openModal(createAlertDialog(result.message, {
    onConfirm: () => {
      // 5. 排序刷新（仅在非 RE1 场景）
      if (result.resultCode !== 'RE1') {
        sortOrderListByCheckedOrder();
      }
    }
  }));
});
```

#### 4.3.3 排序刷新：`sortOrderListByCheckedOrder`

提醒框关闭后，右侧"大账号顺序"面板重新排列：

```javascript
function sortOrderListByCheckedOrder() {
  const allItems = Array.from(orderListContainer.querySelectorAll('.big-account-order-item'));
  
  // 已勾选的按序号排序
  const checkedItems = [];
  const uncheckedItems = [];
  
  allItems.forEach(item => {
    const key = `${item.dataset.merchantId}@@${item.dataset.currency}`;
    const orderIdx = checkedOrder.findIndex(o => o.key === key);
    if (orderIdx >= 0) {
      checkedItems.push({ item, order: orderIdx });
    } else {
      uncheckedItems.push(item);
    }
  });
  
  // 已勾选按序号排序
  checkedItems.sort((a, b) => a.order - b.order);
  
  // 清空容器，重新追加
  orderListContainer.innerHTML = '';
  checkedItems.forEach(({ item }) => orderListContainer.appendChild(item));
  uncheckedItems.forEach(item => orderListContainer.appendChild(item));
}
```

### 4.4 多文件处理

当导入多个文件时，`lastPendingBigAccountSelection.fileEntries` 包含多个 entry。检查排序时遍历所有文件，将所有文件中识别到的账户按文件顺序 + 文件内顺序拼接成一个完整的 `fileAccounts` 数组，然后与 `userAccounts` 做比较。

---

## 五、需求 3：文件顺序帮助图标 —— 详细设计

### 5.1 HTML 结构

修改 `createBigAccountSelectionDialog`（renderer-dialogs.js:595）中的 `big-account-split-header`：

```html
<div class="big-account-split-header">
  文件顺序：
  <span class="file-order-help-icon" tabindex="0">?
    <span class="file-order-tooltip">导入多个文件时，文件顺序是由多个文件的文件名里最左侧的数字的大小决定，由小到大排序的。如：四个文件&lt;文件2.xlsx&gt;、&lt;文件12.xlsx&gt;、&lt;文件1_4.xlsx&gt;、&lt;文件6.xlsx&gt;，多选导入后的文件顺序：&lt;文件1_4.xlsx&gt;、&lt;文件2.xlsx&gt;、&lt;文件6.xlsx&gt;、&lt;文件12.xlsx&gt;。</span>
  </span>
</div>
```

### 5.2 CSS 样式

```css
.file-order-help-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(104, 79, 39, 0.15);
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  cursor: help;
  position: relative;
  vertical-align: middle;
  margin-left: 4px;
}

.file-order-tooltip {
  display: none;
  position: absolute;
  left: 50%;
  top: calc(100% + 8px);
  transform: translateX(-50%);
  width: 320px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(63, 49, 32, 0.95);
  color: #fff;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.5;
  white-space: normal;
  z-index: 10;
  pointer-events: none;
}

.file-order-help-icon:hover .file-order-tooltip,
.file-order-help-icon:focus .file-order-tooltip {
  display: block;
}
```

---

## 六、preload.js 修改

新增 1 个 IPC 通道：

```javascript
// 在 files 对象内追加：
checkSort: (payload) => ipcRenderer.invoke('file:check-sort', payload)
```

---

## 七、需求 4：多文件按账户个数升序排序 —— 详细设计

### 7.1 需求概述

导入多文件时，左侧"文件顺序"面板的文件按文件内账户个数**升序排列**（账户少的排前面）。账户个数相同时保持 OS 原始顺序（稳定排序）。两种模式（不固定 / 固定）都生效。

### 7.2 排序算法

新增 `sortFileEntriesByAccountCount(fileEntries)` 函数，位置在 `buildBigAccountSelectionRows` 附近。

```javascript
function sortFileEntriesByAccountCount(fileEntries) {
  return fileEntries
    .map((entry, originalIndex) => ({
      entry,
      originalIndex,
      blockCount: identifyAccountBlocks(entry.detailRows).length
    }))
    .sort((a, b) => a.blockCount - b.blockCount || a.originalIndex - b.originalIndex)
    .map(({ entry }) => entry);
}
```

设计说明：
- `identifyAccountBlocks(entry.detailRows)` 不传 `includeEmptyBlocks`，默认 `false`，计算有交易的账户块数。
- `sort` 使用 `blockCount` 升序；相同时按 `originalIndex` 保持稳定排序。
- 排序后的 `fileEntries` 传给 `buildBigAccountSelectionRows` 的两次调用（不固定 / 固定模式），确保两个面板数据一致。

### 7.3 改动点

在 `main.js` 的两处调用 `buildBigAccountSelectionRows` 之前，对 `provisionalFileEntries` 排序：

```javascript
const sortedFileEntries = sortFileEntriesByAccountCount(provisionalFileEntries);
const selectionRows = buildBigAccountSelectionRows(sortedFileEntries);
// ...
const selectionRowsWithEmpty = buildBigAccountSelectionRows(sortedFileEntries, { includeEmptyBlocks: true });
```

同时 `rememberPendingBigAccountSelection` 的 `fileEntries` 也传排序后的版本，确保后续 `file:check-sort` / `file:complete-big-account-selection` 使用相同顺序。

### 7.4 影响范围

- `buildBigAccountSelectionRows` 本身不改动，只是传入排序后的 `fileEntries`。
- `applyBigAccountAssignmentsToFileEntries` 使用 `pendingContext.fileEntries`（已排序），与左侧面板顺序一致。
- 检查排序（`file:check-sort`）同样使用排序后的 `fileEntries`，顺序一致。

---

## 八、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 |
|------|---------------|---------|
| 1 | `docs(v1.5.0): add TechDoc-v1.5.0.md` | `docs/iterations/v1.5.0/TechDoc-v1.5.0.md` |
| 2 | `feat(v1.5.0): precision 12 decimal places for amounts` | `normalizers.js`, `writers.js`, `file-service.js` |
| 3 | `feat(v1.5.0): check-sort button in big account selection` | `main.js`, `preload.js`, `renderer-dialogs.js`, `styles.css`, `file-service.js` |
| 4 | `feat(v1.5.0): file order help tooltip` | `renderer-dialogs.js`, `styles.css` |
| 5 | `chore(v1.5.0): bump package.json version to 1.5.0` | `package.json` |
| 6 | `feat(v1.5.0): sort files by account count ascending in big account selection` | `main.js` |

---

## 九、Open Technical Questions（无）

本版本的 4 项需求技术实现方案明确，无待定的技术问题。
