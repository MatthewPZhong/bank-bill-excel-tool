# 技术设计文档 - 网银账单小助手 v1.4.3

| 项目 | 内容 |
|------|------|
| 版本 | v1.4.3 |
| 日期 | 2026-03-23 |
| 状态 | 待评审 |
| 作者 | Dev |
| 关联 PRD | docs/iterations/v1.4.3/PRD-v1.4.3.md |

---

## 一、变更总览

本版本涉及 6 项需求，涉及 4 个文件的修改：

| 文件 | 涉及需求 | 变更类型 |
|------|----------|----------|
| `src/renderer-dialogs.js` | 需求 1、2a、2b、2c | 逻辑修改 + 代码删除 |
| `src/styles.css` | 需求 1、2c、3、4 | 样式修改 + 样式删除 |
| `src/renderer.js` | 需求 5 | 逻辑修改 + Bug 修复 |
| `index.html` | 需求 6 | DOM 结构调整 |

无新增文件，无数据库变更，无新增依赖。

---

## 二、需求 1：映射字段控件改回下拉框

### 2.1 变更文件与位置

#### 2.1.1 `src/renderer-dialogs.js`

**变更点 A：select 元素创建（约第 1469 行）**

当前代码：
```javascript
<select class="mapping-select${supportsMultiSelect ? ' mapping-multi-select' : ''}" ${supportsMultiSelect ? 'multiple size="6"' : ''}>${selectOptions}</select>
```

改为：
```javascript
<select class="mapping-select">${selectOptions}</select>
```

说明：移除 `supportsMultiSelect` 对 select 元素的影响。所有映射字段（含 Balance、MerchantId）统一使用单行下拉框。`supportsMultiSelect` 变量仍保留，仅用于控制是否显示 `CONCAT_FIELDS_MAPPING_FIELD` 选项和拼接字段选择器。

**变更点 B：select 回显逻辑（约第 1496-1509 行）**

当前代码有 `supportsMultiSelect` 分支，多选模式下遍历 options 设置 `option.selected`。改为统一使用 `select.value = ...` 单选赋值：

```javascript
if (isSavedConcatMode) {
  select.value = CONCAT_FIELDS_MAPPING_FIELD;
  concatSelectedFields = Array.isArray(savedMapping.mappedFields) ? savedMapping.mappedFields.slice() : [];
} else {
  select.value = savedMapping.mappedField || (isBalanceField ? BALANCE_DISABLED_OPTION : '');
}
```

数据兼容性：v1.4.2 多选非拼接映射数据的 `mappedField` 存储第一个选中值，改为单选后直接以此值回显，其余值静默丢弃。

**变更点 C：`collectMappingDraftFromTable`（第 353-377 行）**

当前非拼接模式下有 `mappedFields: mappedFields.length > 1 ? mappedFields : []`，改为单选后 `mappedFields` 始终为空数组：

```javascript
return {
  templateField: row.dataset.templateField,
  mappedField: select.value || '',
  mappedFields: [],
  customValue: '',
  isMultiBigAccount: false
};
```

注意：`getSelectValues` 函数（第 339-351 行）的 `multiple` 分支可保留不删，改为单选后该分支不会被触发，不影响功能。

#### 2.1.2 `src/styles.css`

**删除 `.mapping-multi-select` 规则（第 1087-1091 行）：**

```css
/* 删除以下整段 */
.mapping-multi-select {
  height: auto;
  min-height: 128px;
  padding: 10px 12px;
}
```

### 2.2 影响分析

- `buildMappedRows`（`file-service.js`）：接收 `mappingByField` 字典，key 为目标字段名，value 为源字段名或源字段名数组。单选模式下 `mappedField` 为字符串，`mappedFields` 仅拼接模式下有值。上游 `main.js` 中 `normalizeMappingRows` 已按此格式组装，**无需修改后端**。
- 模板保存（`saveMappings` IPC）：接收 `mappings` 数组，每项含 `mappedField` 和 `mappedFields`，格式不变。
- 导出流程：依赖 `mappingByField`，格式不变。

---

## 三、需求 2：拼接字段交互优化

### 3.1 需求 2a：下拉框点击空白处收起

#### 变更文件：`src/renderer-dialogs.js`

在 `createMappingDialog` 函数内，拼接面板创建完成后（约第 1622 行 `tbody` 事件绑定附近），注册一个 document 级 `mousedown` 事件：

```javascript
function closeAllConcatPanels(exceptPanel) {
  tbody.querySelectorAll('.concat-picker-panel:not([hidden])').forEach((panel) => {
    if (panel !== exceptPanel) {
      panel.hidden = true;
    }
  });
}

document.addEventListener('mousedown', (event) => {
  const target = event.target;
  // 检查点击是否在任一 concat-picker 内部
  const clickedPicker = target.closest('.concat-field-picker');
  if (!clickedPicker) {
    closeAllConcatPanels(null);
  }
});
```

注册位置：在 `overlay.appendChild(dialog)` 之前。需在对话框关闭（overlay 移除）时清理该事件监听器，避免内存泄漏。实现方式：将事件监听器注册在 `overlay` 上，利用事件冒泡捕获 `document` 级点击。

更优方案：在 `dialog` 元素上注册 `mousedown` 事件（利用冒泡），检查点击目标是否在 `.concat-field-picker` 内部。这样对话框移除时事件自然清理。但需注意对话框外部的 overlay 蒙层点击——实际上 overlay 蒙层已有关闭逻辑，不必额外处理。

**推荐实现**：在 `dialog` 上注册 `click` 事件监听，利用事件委托判断。

```javascript
dialog.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.concat-field-picker')) {
    closeAllConcatPanels(null);
  }
});
```

由于对话框销毁时 `dialog` 元素被移除，事件监听器自动随 GC 回收，无需手动 `removeEventListener`。

#### 与现有 trigger 按钮逻辑的兼容

当前 `concatPickerTrigger` 的 `click` 事件（第 1556-1563 行）切换面板显隐。`mousedown` 先于 `click` 触发，如果 `mousedown` 关闭了面板，后续 `click` 又会打开它——即"点击 trigger 按钮关闭面板"可能失效。

解决方案：`mousedown` 事件中排除 `.concat-picker-trigger` 按钮：

```javascript
dialog.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.concat-field-picker')) {
    closeAllConcatPanels(null);
  }
});
```

此判断已经包含了 trigger 按钮（trigger 在 `.concat-field-picker` 内部），所以点击 trigger 不会触发 `closeAllConcatPanels`，由 trigger 自身的 `click` 处理切换。逻辑正确，无冲突。

### 3.2 需求 2b：预览上方显示"当前拼接顺序："

#### 变更文件：`src/renderer-dialogs.js`

在拼接字段选择器 HTML 模板中（约第 1473-1478 行），在 `.concat-preview` 前新增一个标签元素：

当前模板：
```html
<div class="concat-field-picker" hidden>
  <button class="concat-picker-trigger secondary-btn small" type="button">选择字段</button>
  <div class="concat-picker-panel" hidden></div>
  <span class="concat-preview" title=""></span>
</div>
```

改为：
```html
<div class="concat-field-picker" hidden>
  <button class="concat-picker-trigger secondary-btn small" type="button">选择字段</button>
  <div class="concat-picker-panel" hidden></div>
  <span class="concat-order-label">当前拼接顺序：</span>
  <span class="concat-preview" title=""></span>
</div>
```

#### 变更文件：`src/styles.css`

新增样式：
```css
.concat-order-label {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
```

注意：`.concat-field-picker` 使用 `display: inline-flex; align-items: center`，新增的 label 会水平排列在面板和预览之间。如需 label 和 preview 垂直堆叠显示在面板右侧，需将它们包在一个纵向 flex 容器中：

```html
<div class="concat-field-picker" hidden>
  <button class="concat-picker-trigger secondary-btn small" type="button">选择字段</button>
  <div class="concat-picker-panel" hidden></div>
  <div class="concat-preview-wrapper">
    <span class="concat-order-label">当前拼接顺序：</span>
    <span class="concat-preview" title=""></span>
  </div>
</div>
```

```css
.concat-preview-wrapper {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.concat-order-label {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
```

PRD 要求"正上方、左对齐"，因此推荐使用纵向 flex 容器方案。

#### JS 引用适配

`concatPreview` 变量引用（第 1489 行）使用 `row.querySelector('.concat-preview')`，DOM 嵌套层级变化不影响 `querySelector` 查找，**无需修改**。

### 3.3 需求 2c：取消多选字段顺序确认弹窗

#### 变更文件：`src/renderer-dialogs.js`

**变更点 A：删除 `createMappingOrderDialog` 函数（第 380-461 行）**

整段删除（约 82 行）。

**变更点 B：简化"完成"按钮回调（第 1643-1720 行）**

当前逻辑：
```javascript
dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
  const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
  const draftMappings = collectMappingDraftFromTable(tbody);

  const saveMappings = async (mappings) => { /* ... */ };

  const multiSelectMappings = draftMappings.filter(
    (mapping) => Array.isArray(mapping.mappedFields) && mapping.mappedFields.length > 1
  );

  if (multiSelectMappings.length) {
    openModal(createMappingOrderDialog({ /* ... */ }));
    return;
  }

  saveMappings(draftMappings).catch(/* ... */);
});
```

简化为：
```javascript
dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
  const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
  const draftMappings = collectMappingDraftFromTable(tbody);

  const saveMappings = async (mappings) => { /* 保持不变 */ };

  saveMappings(draftMappings).catch((error) => {
    console.error(error);
    setStatus('模板映射保存失败，请查看控制台', 'error');
  });
});
```

删除 `multiSelectMappings` 过滤逻辑和 `createMappingOrderDialog` 调用分支（第 1677-1713 行）。

**数据流验证**：`collectMappingDraftFromTable` 在 `isConcatMode` 分支中从 `row.dataset.concatFields`（JSON）读取有序字段列表填入 `mappedFields`，该数据由拼接字段选择器的 `checkbox.change` 事件维护并通过 `updateConcatPreview` 写入 `row.dataset.concatFields`。此路径不依赖 `createMappingOrderDialog`，删除后拼接字段顺序数据完整无损。

#### 变更文件：`src/styles.css`

**删除 `.mapping-order-*` 相关规则（第 1093-1156 行）：**

```css
/* 删除以下所有规则 */
.mapping-order-card { ... }           /* 第 1093-1095 行 */
.mapping-order-intro { ... }          /* 第 1097-1101 行 */
.mapping-order-groups { ... }         /* 第 1103-1106 行 */
.mapping-order-group { ... }          /* 第 1108-1113 行 */
.mapping-order-group-title { ... }    /* 第 1115-1118 行 */
.mapping-order-list { ... }           /* 第 1120-1123 行 */
.mapping-order-row { ... }            /* 第 1125-1133 行 */
.mapping-order-index { ... }          /* 第 1135-1137 行 */
.mapping-order-name { ... }           /* 第 1139-1144 行 */
.mapping-order-actions { ... }        /* 第 1146-1150 行 */
.mapping-order-preview { ... }        /* 第 1152-1156 行 */
```

共计 11 条规则，约 64 行 CSS。

---

## 四、需求 3：维护大账号币种区域布局调整

### 4.1 变更文件：`src/styles.css`

**变更点 A：`.big-account-currency-editor`（第 1316-1322 行）**

```css
/* 改前 */
.big-account-currency-editor {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-height: 44px;
}

/* 改后 */
.big-account-currency-editor {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  min-height: 44px;
}
```

**变更点 B：`.big-account-currency-dropdown-wrap`（第 1328-1331 行）**

```css
/* 改前 */
.big-account-currency-dropdown-wrap {
  position: relative;
  width: 168px;
}

/* 改后 — 缩小宽度 */
.big-account-currency-dropdown-wrap {
  position: relative;
  width: 128px;
}
```

从 168px 缩至 128px。需验证下拉按钮文字（币种代码如 "USD"、"CNY"）在 128px 宽度下不被截断。币种代码通常 3-4 字符，128px 足够。

### 4.2 容器宽度验证

大账号对话框使用 `.manager-card`（`width: min(100%, 1120px)`），内部表格第二列（币种列）可用宽度估算：
- 第一列（MerchantId）约 200px
- 第三列（操作按钮）约 100px
- 表格内边距约 40px
- 第二列可用 ≈ 1120 - 200 - 100 - 40 = 780px

币种编辑器内元素宽度：
- `enum-input-shell` / `dropdown-wrap`：128px
- `big-account-multi-label`（"多币种"文本 + checkbox）：约 80px
- gap 10px x 2 = 20px
- 合计约 228px，远小于可用宽度

在 900px 窗口下（对话框按 min(100%, 1120px) 会缩小），第二列可用约 560px，仍充足。

### 4.3 无 JS 变更

此需求为纯 CSS 变更，不涉及 JS 逻辑。

---

## 五、需求 4：映射关系间距回滚

### 5.1 变更文件：`src/styles.css`

**删除第 851-856 行的规则：**

```css
/* 删除以下整段 */
.mapping-card .data-table td:first-child,
.mapping-card .data-table th:first-child {
  width: 1%;
  white-space: nowrap;
  padding-right: 8px;
}
```

此规则为 v1.4.2 新增（commit `5d91853`），通过 `git diff bbd0c23..5d91853 -- src/styles.css` 确认：v1.4.2 之前不存在此规则。删除后模板字段列恢复为表格自动分配宽度。

### 5.2 影响分析

- `.mapping-card .data-table` 仅出现在映射关系管理对话框中
- 其他对话框（账户映射 `.account-card .data-table`、大账号 `.manager-card .data-table`）不受影响
- `.mapping-field-editor` 的 `gap: 12px` 在 v1.4.2 前后未变，不需修改

### 5.3 无 JS 变更

此需求为纯 CSS 变更。

---

## 六、需求 5：新开账户多币种按钮修复与改造

### 6.1 Bug 排查分析

#### 6.1.1 事件绑定路径

多币种复选框的事件绑定在 `initializeNewAccountRow`（`renderer.js` 第 741-744 行）：

```javascript
refs.multiCurrencyCheckbox.addEventListener('change', () => {
  syncNewAccountCurrencyMode(refs);
  handleNewAccountFormMutation();
});
```

`syncNewAccountCurrencyMode`（第 691-715 行）根据 `isNewAccountMultiCurrencyMode(refs)` 切换 `currencyInput.hidden` 和 `currencyDropdownWrap.hidden`。

需要排查 `isNewAccountMultiCurrencyMode` 的实现，确认其是否正确引用了 checkbox 状态。

#### 6.1.2 可能的 Bug 原因

需在实际运行环境中 debug 确认。可能原因包括：
1. `ensureCurrencyGhostShell` 在第 735 行执行，可能改变了 DOM 层级导致 `refs.currencyInput` 后续引用失效
2. `isNewAccountMultiCurrencyMode` 中 checkbox 引用指向旧 DOM 节点
3. clone 行时 `rowState.initialized` 标志位问题——但 `addNewAccountRow` 使用 `cloneNode(true)` 后调用 `initializeNewAccountRow`，新 row 进入 `getNewAccountRowState` 时会创建新 state（使用 `WeakMap`/`Map`），`initialized` 为 `false`，事件会正确绑定

修复策略：在实现阶段通过浏览器 DevTools 断点调试确认具体原因，针对性修复。

#### 6.1.3 调试检查清单

实现阶段按以下顺序排查：

| 序号 | 断点位置 | 检查内容 |
|------|----------|----------|
| 1 | `initializeNewAccountRow` 第 741 行 | checkbox `change` 事件是否成功绑定（在 listener 内打断点，勾选 checkbox 后是否命中） |
| 2 | `syncNewAccountCurrencyMode` 第 700 行 | `refs` 对象中 `currencyInput`、`currencyDropdownWrap`、`currencyDropdownBtn` 是否为有效 DOM 引用（非 null、且在文档中） |
| 3 | `ensureCurrencyGhostShell` 第 735 行（调用处） | 执行前后对比 `refs.currencyInput.parentElement`，确认 DOM 重组是否导致后续引用失效 |
| 4 | `isNewAccountMultiCurrencyMode` 函数体内 | 确认读取的 checkbox 引用是否指向当前 DOM 中的节点（`checkbox.isConnected === true`） |
| 5 | `toggleNewAccountCurrencyDropdown` 第 598 行 | 点击下拉按钮后是否进入此函数，`refs` 和 `rowState` 是否正确 |

### 6.2 多币种序号显示改造

#### 变更文件：`src/renderer.js` — `renderNewAccountCurrencyOptions` 函数（第 623-689 行）

**改造点：多选模式下增加序号显示**

当前多选模式代码（第 657-671 行）创建 checkbox 和 text 两个元素。改造为增加序号 span：

```javascript
if (isMultiCurrency) {
  const checkbox = document.createElement('input');
  checkbox.className = 'new-account-checkbox';
  checkbox.type = 'checkbox';
  checkbox.checked = rowState.selectedCurrencies.includes(code);

  const indexSpan = document.createElement('span');
  indexSpan.className = 'concat-picker-index';  // 复用拼接字段序号样式
  const selectedIdx = rowState.selectedCurrencies.indexOf(code);
  indexSpan.textContent = selectedIdx >= 0 ? `${selectedIdx + 1}` : '';

  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      rowState.selectedCurrencies = Array.from(new Set([...rowState.selectedCurrencies, code]));
    } else {
      rowState.selectedCurrencies = rowState.selectedCurrencies.filter((value) => value !== code);
    }
    // 重新渲染以更新所有选项的序号
    renderNewAccountCurrencyOptions(refs);
    updateNewAccountCurrencyDropdownLabel(refs);
    handleNewAccountFormMutation();
  });

  option.append(checkbox, indexSpan, text);
}
```

关键改动：
1. 新增 `indexSpan`，复用 `.concat-picker-index` 样式（`color: var(--primary); font-weight: 600`）
2. `checkbox.change` 回调中调用 `renderNewAccountCurrencyOptions(refs)` 重新渲染整个选项列表，以更新所有序号
3. 取消勾选后自动重排——因为 `selectedCurrencies` 数组中该项被 `filter` 移除，后续项的 `indexOf` 自动前移

#### 下拉按钮摘要文本

`updateNewAccountCurrencyDropdownLabel` 函数已存在（需确认其实现位置），需确保：
- 0 个已选：显示空白或占位文本
- 1-2 个已选：显示币种代码，如 "USD, CNY"
- 3 个及以上：显示 "3个币种" 格式

如当前实现不满足，修改该函数即可。

### 6.3 点击外部关闭面板

当前 `closeNewAccountCurrencyDropdown` 已存在（`renderer.js` 第 538 行），需在面板打开时注册外部点击监听。

与需求 2a 类似，在 `openNewAccountCurrencyDropdown` 中添加 document 级 `mousedown` 监听：

```javascript
function openNewAccountCurrencyDropdown(refs) {
  closeAllNewAccountCurrencyDropdowns(refs.row);
  getNewAccountRowState(refs.row).isDropdownOpen = true;
  refs.currencyDropdownPanel.hidden = false;
  refs.currencyDropdownBtn.classList.add('is-open');
  refs.currencyDropdownBtn.setAttribute('aria-expanded', 'true');
  syncNewAccountDropdownFlag();

  // 外部点击关闭
  function handleOutsideClick(event) {
    if (!refs.currencyDropdownWrap.contains(event.target)) {
      closeNewAccountCurrencyDropdown(refs);
      document.removeEventListener('mousedown', handleOutsideClick);
    }
  }
  // 延迟一帧注册，避免当前点击事件触发关闭
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', handleOutsideClick);
  });
}
```

并在 `closeNewAccountCurrencyDropdown` 中确保清理（或通过 `handleOutsideClick` 自身在关闭时 `removeEventListener`）。

### 6.4 影响分析

- 数据格式不变：`selectedCurrencies` 仍为币种代码字符串数组
- `isNewAccountFormComplete`（第 844-858 行）的 `currencyReady` 判断（`rowState.selectedCurrencies.length > 0`）不受影响
- 生成/导出流程中 `desktopApi.newAccount.generate` 接收的币种数据格式不变
- clone 行的多币种功能：`addNewAccountRow` -> `cloneNode(true)` -> `initializeNewAccountRow` -> `syncNewAccountCurrencyMode` -> `renderNewAccountCurrencyOptions`，新增的序号逻辑已在 `renderNewAccountCurrencyOptions` 中，clone 行自动继承

---

## 七、需求 6：新增按钮位置修正

### 7.1 变更文件：`index.html`

**当前 DOM 结构（第 106-112 行）：**
```html
<label class="new-account-field">
  <span class="new-account-label">银行账号</span>
  <div class="new-account-bank-account-row">
    <input id="newAccountBankAccountInput" class="new-account-input new-account-bank-account-input" type="text" spellcheck="false" />
    <button id="newAccountAddRowBtn" class="text-action new-account-add-btn" type="button">新增</button>
  </div>
</label>
```

**目标 DOM 结构：**
```html
<label class="new-account-field">
  <span class="new-account-label new-account-label-with-action">
    银行账号
    <button id="newAccountAddRowBtn" class="text-action new-account-add-btn" type="button">新增</button>
  </span>
  <div class="new-account-bank-account-row">
    <input id="newAccountBankAccountInput" class="new-account-input new-account-bank-account-input" type="text" spellcheck="false" />
  </div>
</label>
```

将按钮从 `.new-account-bank-account-row` 移至 `<span class="new-account-label">` 内部。由于 `<span>` 默认为 inline 元素，添加新 class `.new-account-label-with-action` 使其成为 inline-flex 容器。

### 7.2 变更文件：`src/styles.css`

新增样式：
```css
.new-account-label-with-action {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
```

### 7.3 变更文件：`src/renderer.js`

#### 7.3.1 `getNewAccountRowElements`（第 369-384 行）

当前 `addRowBtn` 查找：
```javascript
addRowBtn: row.querySelector('.new-account-add-btn')
```

按钮移至标签行后，仍在 `[data-new-account-row]` 容器内部，`querySelector` 从 `row` 向下搜索，能找到新位置的按钮。**无需修改选择器**。

#### 7.3.2 `addNewAccountRow`（第 801-821 行）

当前使用 `sourceRow.cloneNode(true)` 深拷贝整行，clone 后按钮也会被复制到新行中。`syncNewAccountAddButtonVisibility`（第 528-536 行）负责仅在第一行显示按钮：

```javascript
function syncNewAccountAddButtonVisibility() {
  getNewAccountRows().forEach((row, index) => {
    const refs = getNewAccountRowElements(row);
    if (refs.addRowBtn) {
      refs.addRowBtn.hidden = index !== 0;
    }
  });
}
```

DOM 位置变化后，此逻辑仍然正确——`refs.addRowBtn` 通过 `querySelector` 找到按钮并设置 `hidden`，与按钮在标签行还是输入行无关。**无需修改**。

#### 7.3.3 `<label>` 的 `click` 行为注意

按钮移入 `<label>` 后，点击按钮会触发 label 的默认行为（聚焦其关联的 input）。但由于按钮是 `<button type="button">`，点击事件会被按钮捕获，不会穿透到 label。实测需确认——如有问题，在按钮的 `click` handler 中添加 `event.preventDefault()` 即可。

或者改为：将 `<label>` 改为 `<div>`，因为此处 label 并不关联 `for` 属性，改为 div 对功能无影响。但这会改变语义，建议保持 label 不变，仅在确认有问题时再调整。

更稳妥方案：将按钮从 label 内部移到 label 外部、label 同级位置：

```html
<div class="new-account-field-group">
  <div class="new-account-label-row">
    <span class="new-account-label">银行账号</span>
    <button id="newAccountAddRowBtn" class="text-action new-account-add-btn" type="button">新增</button>
  </div>
  <label class="new-account-field">
    <div class="new-account-bank-account-row">
      <input id="newAccountBankAccountInput" class="new-account-input new-account-bank-account-input" type="text" spellcheck="false" />
    </div>
  </label>
</div>
```

但此方案改动更大，会破坏其他行的 `.new-account-field` 结构一致性。

**推荐方案**：保持第一方案（按钮放入 `<span class="new-account-label">` 内），因为 `<button>` 元素不会触发 label 的默认聚焦行为。如果测试发现问题再调整。

### 7.4 影响分析

- 仅影响"银行账号"字段行的布局
- 其他字段行（银行名称、所在地、币种、开户日期）不受影响
- clone 行中按钮被 `syncNewAccountAddButtonVisibility` 隐藏，行为不变

---

## 八、实现顺序建议

按依赖关系和优先级排序：

| 顺序 | 需求 | 理由 |
|------|------|------|
| 1 | 需求 4（间距回滚）| 纯 CSS 删除，无依赖，最简单 |
| 2 | 需求 1（单选下拉框）| 需求 2 依赖此变更（单选后拼接交互才有意义优化） |
| 3 | 需求 2c（删除顺序弹窗）| 依赖需求 1 完成后验证数据流 |
| 4 | 需求 2a + 2b（拼接交互优化）| 依赖需求 1 的 select 结构变更 |
| 5 | 需求 3（大账号布局）| 独立模块，纯 CSS |
| 6 | 需求 5（多币种修复+改造）| P0 优先级但涉及 Bug 调试，需运行环境 |
| 7 | 需求 6（新增按钮位置）| 独立变更，HTML + CSS |

注：需求 5 为 P0 优先级，如 Bug 影响用户使用，应优先排查修复，再进行其他需求。

---

## 九、CSS 变更汇总

以下为 `src/styles.css` 所有变更的集中汇总：

| 行号范围 | 操作 | 关联需求 |
|-----------|------|----------|
| 851-856 | 删除 `.mapping-card .data-table td:first-child` 和 `th:first-child` | 需求 4 |
| 1087-1091 | 删除 `.mapping-multi-select` | 需求 1 |
| 1093-1156 | 删除 `.mapping-order-card` 至 `.mapping-order-preview`（11 条规则） | 需求 2c |
| 1316-1322 | 修改 `.big-account-currency-editor`：`flex-wrap: wrap` → `nowrap` | 需求 3 |
| 1328-1331 | 修改 `.big-account-currency-dropdown-wrap`：`width: 168px` → `128px` | 需求 3 |
| 新增 | `.concat-order-label` + `.concat-preview-wrapper` | 需求 2b |
| 新增 | `.new-account-label-with-action` | 需求 6 |

---

## 十、风险点与注意事项

| 风险项 | 描述 | 缓解措施 |
|--------|------|----------|
| 需求 1 数据兼容 | v1.4.2 多选非拼接旧数据只回显 `mappedField` 首选值，其余静默丢弃 | PRD 已确认此为预期行为；首次打开并重新保存后旧数据自动归一化 |
| 需求 2a 事件冲突 | `mousedown` 与 `click` 事件先后顺序可能导致 trigger 按钮行为异常 | 通过 `.closest('.concat-field-picker')` 排除内部点击 |
| 需求 5 Bug 原因未定 | 多币种按钮不响应的根因需运行时调试确认 | 列出所有可能原因，实现阶段逐一排查 |
| 需求 6 label 行为 | 按钮移入 `<label>` 可能影响点击行为 | `<button>` 不会触发 label 默认行为，测试验证即可 |
| CSS 删除范围 | 大量 CSS 规则删除后需确认无残留引用 | 删除前全局搜索类名确认无其他使用 |
