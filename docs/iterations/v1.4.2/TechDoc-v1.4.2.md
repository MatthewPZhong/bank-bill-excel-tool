# 技术设计文档 - v1.4.2

## 文档信息

| 项目 | 内容 |
|------|------|
| 版本号 | v1.4.2 |
| 日期 | 2026-03-23 |
| 基于 PRD | PRD-v1.4.2.md（评审修订版） |

---

## 一、涉及修改的文件清单

| 文件 | 需求 | 修改类型 |
|------|------|---------|
| `src/renderer-dialogs.js` | 1, 3, 4, 5 | 功能修改 |
| `src/renderer.js` | 3, 5 | 功能修改 + 代码删除 |
| `src/main.js` | 1, 2, 4, 5 | 功能修改 |
| `src/styles.css` | 1, 3, 5, 6 | 样式修改 |
| `src/backend/database.js` | 1 | Schema 变更 |
| `src/backend/database/settings-repository.js` | 1 | 数据读写修改 |
| `src/backend/database/migrations.js` | 1 | 新增迁移函数 |
| `src/backend/file-service.js` | 1 | 功能修改（币种回填） |
| `src/index.html` | 3 | 元素删除 |

---

## 二、需求一：账号映射对话框优化

### 2.1 数据模型变更

**数据库表 `account_mappings`**：新增两列

```sql
ALTER TABLE account_mappings ADD COLUMN no_currency INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_mappings ADD COLUMN currency TEXT NOT NULL DEFAULT '';
```

- `no_currency`：0 = 未勾选，1 = 已勾选"有账户号无币种"
- `currency`：勾选时用户输入的币种代码

### 2.2 修改点清单

#### `src/backend/database/migrations.js`（新增迁移函数）

新增函数 `ensureAccountMappingCurrencySupport(db)`：

```
function ensureAccountMappingCurrencySupport(db) {
  if (!hasColumn(db, 'account_mappings', 'no_currency')) {
    db.exec("ALTER TABLE account_mappings ADD COLUMN no_currency INTEGER NOT NULL DEFAULT 0;");
  }
  if (!hasColumn(db, 'account_mappings', 'currency')) {
    db.exec("ALTER TABLE account_mappings ADD COLUMN currency TEXT NOT NULL DEFAULT '';");
  }
}
```

#### `src/backend/database.js`（约第 82-87 行）

- `init()` 方法中 `CREATE TABLE IF NOT EXISTS account_mappings` 的列定义中追加 `no_currency INTEGER NOT NULL DEFAULT 0` 和 `currency TEXT NOT NULL DEFAULT ''`。
- `init()` 方法末尾调用 `this.ensureAccountMappingCurrencySupport()`。
- 新增实例方法 `ensureAccountMappingCurrencySupport()` 调用迁移函数。

#### `src/backend/database/settings-repository.js`

**`listAccountMappings`**（第 62-73 行）：SELECT 新增 `no_currency AS noCurrency, currency`。

**`saveAccountMappings`**（第 76-104 行）：INSERT 语句新增 `no_currency, currency` 两列，从 `mapping.noCurrency` 和 `mapping.currency` 取值。

#### `src/main.js`

**`validateAccountMappings`**（第 2168-2219 行）：
- 每行数据新增提取 `noCurrency` 和 `currency` 字段。
- 当 `noCurrency === true` 且 `currency` 为空时，返回错误 `{ status: 'error', message: '请填写币种' }`。
- 当 `noCurrency === true` 且 `currency` 不匹配有效币种代码格式时（校验规则：`/^[A-Z]{3,5}$/i`），返回错误 `{ status: 'error', message: '币种代码无效' }`。此处采用格式校验而非白名单校验，原因：`getCurrencyOptionEntries` 返回的是常见币种列表，不能保证覆盖所有合法币种代码；ghost input 自动补全已引导用户输入正确值，格式校验作为兜底防护。
- `cleanedMappings.push(...)` 中增加 `noCurrency` 和 `currency` 字段。

**`buildStatementGenerationConfig`**（第 2937-3025 行）：
- `accountMappingByBankId` 构建逻辑扩展：从 `{ bankAccountId: clearingAccountId }` 扩展为 `{ bankAccountId: { clearingAccountId, noCurrency, currency } }`。
- **已确认方案**：币种值参与数据处理。当源文件中匹配到该 `bankAccountId` 但缺少币种信息时，自动使用配置的 `currency` 值填充 Currency 字段。
- 具体实现：`accountMappingByBankId` 在 `listAccountMappings()` 返回的数据基础上构建，将 `noCurrency` 和 `currency` 一并传递给 `buildMappedRows`。

  ```javascript
  // 第 3004-3007 行修改
  const accountMappingByBankId = database.listAccountMappings().reduce((accumulator, mapping) => {
    accumulator[mapping.bankAccountId] = {
      clearingAccountId: mapping.clearingAccountId,
      noCurrency: Boolean(mapping.noCurrency),
      currency: mapping.currency || ''
    };
    return accumulator;
  }, {});
  ```

#### `src/backend/file-service.js`（`buildMappedRows` 函数，第 38-200 行）

**币种回填逻辑**（约第 179-198 行，`targetField === 'Currency'` 分支内）：

在现有币种解析逻辑之后，新增基于 `accountMappingByBankId` 的币种回填：

```javascript
if (targetField === 'Currency') {
  // ... 现有逻辑（selectedCurrency、FIXED_FIELD_VALUE_PREFIX 等）...

  const currencyResult = resolveCurrencyValue(rawValue, currencyMappings);

  // 新增：若币种为空且 accountMapping 有配置币种，则回填
  if (!currencyResult.value || currencyResult.value === '') {
    const merchantIdValue = resolveRawValueByMapping(mappingByField['MerchantId'], row);
    const accountMapping = accountMappingByBankId[normalizeCell(merchantIdValue)];
    if (accountMapping && typeof accountMapping === 'object'
        && accountMapping.noCurrency && accountMapping.currency) {
      return accountMapping.currency;
    }
  }

  // ... 现有 issue 推送和 return 逻辑 ...
}
```

注意：`buildMappedRows` 的参数 `accountMappingByBankId` 已存在（第 42 行），当前仅用于 `Drawee` 相关字段的映射。扩展后类型从 `{ [bankId]: clearingAccountId }` 变为 `{ [bankId]: { clearingAccountId, noCurrency, currency } }`。需同步修改所有读取 `accountMappingByBankId[key]` 的位置（约第 200 行之后的 Drawee/Payee 映射），改为 `accountMappingByBankId[key]?.clearingAccountId ?? accountMappingByBankId[key]`（兼容旧调用方式）。

#### `src/renderer-dialogs.js`

**`createAccountMappingDialog`**（第 1664-1771 行）：
- 表头文案：`'清结算系统大账户ID'` → `'清结算系统大账号ID'`（第 1677 行）。
- **`createInputRow`**（第 1690-1711 行）：函数签名扩展为 `createInputRow(bankAccountId, clearingAccountId, noCurrency, currency)`。
  - `clearingCell` 内追加：checkbox 元素（class: `no-currency-checkbox`）+ label "有账户号无币种" + 币种输入框（class: `account-currency-input`，默认 hidden）。
  - 币种输入框复用 `ensureCurrencyGhostShell` + `getCurrencySuggestion` 实现自动补全。
  - checkbox change 事件：勾选时显示币种输入框，取消勾选时隐藏并清空输入值。
  - 币种输入框 input 事件：更新 ghost input 补全建议。
  - 币种输入框 keydown 事件：右方向键接受补全。
- "完成"按钮点击处理（第 1734-1753 行）：收集数据时从每行读取 checkbox 状态和币种值，数据结构扩展为 `{ bankAccountId, clearingAccountId, noCurrency, currency }`。
- 回显：`payload.mappings.forEach(...)` 中传入 `noCurrency` 和 `currency`。

#### `src/styles.css`

新增样式：

```css
.no-currency-checkbox { /* checkbox 基础样式 */ }
.account-currency-input { width: 100px; /* 币种输入框宽度 */ }
.account-mapping-clearing-cell { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
```

### 2.3 兼容性处理

- 旧数据（v1.4.1）加载时，`no_currency` 列默认 0，`currency` 列默认 `''`，对话框显示为未勾选、无币种输入框，功能正常。
- 迁移通过 `ALTER TABLE ADD COLUMN ... DEFAULT` 实现，无需数据迁移脚本。

---

## 三、需求二：导出文件命名规则变更

### 3.1 修改点清单

#### `src/main.js`

**`buildStatementOutputFilePath`**（第 1371-1395 行）：

修改 `publicFileName` 拼接逻辑中的 `merchantId` 处理：

```javascript
// 在第 1380 行附近，merchantId 参数使用前截取
const displayMerchantId = merchantId.length > 4 ? merchantId.slice(-4) : merchantId;
const publicFileName = displayMerchantId
  ? `${templateName}-${displayMerchantId}-${outputTag}-${safeDateLabel}.xlsx`
  : `${templateName}-${outputTag}-${safeDateLabel}.xlsx`;
```

注意：`internalFileName` 仍使用完整 `merchantId`（或使用 `displayMerchantId`，但因 `internalSuffix` 已区分，不会产生覆盖）。实际上 `internalFileName` 是基于 `publicFileName` 的变体，因此也会使用截取后的值，这不影响功能因为有 `__${internalSuffix}` 区分。

### 3.2 影响分析

- 仅影响导出文件的文件名，Excel 内容中的 MerchantId 单元格不受影响。
- 调用 `buildStatementOutputFilePath` 的位置：`generateStatementFiles` 中的 detail 和 balance 输出路径（约第 3144、3203 行），无需修改调用方。
- 新开账户导出不涉及 merchantId 文件名，不受影响。

---

## 四、需求三：币种输入框简化

### 4.1 修改点清单

#### `src/index.html`

删除以下元素（在新开账户模块的币种输入区域）：
- `id="newAccountCurrencyDropdownBtn"` 的 button 元素
- `id="newAccountCurrencyDropdownPanel"` 的 div 元素
- 新开账户每行模板中对应的 `.new-account-currency-dropdown-btn` 和 `.new-account-currency-dropdown-panel` 元素

#### `src/renderer.js`

**删除的函数/逻辑（约第 507-598 行区域）：**
- `syncNewAccountDropdownFlag()`
- `closeAllNewAccountCurrencyDropdowns()`
- `closeNewAccountCurrencyDropdown()`
- `updateNewAccountCurrencyDropdownLabel()`
- `openNewAccountCurrencyDropdown()`
- `toggleNewAccountCurrencyDropdown()`

**修改的函数：**
- `isNewAccountMultiCurrencyMode()`（第 521-524 行）：保留。**已确认**：多币种勾选框模式不受本需求影响，本需求仅简化单币种输入场景的下拉框。多币种模式下，勾选复选框后仍保留现有交互方式（下拉面板选择多个币种）。即：仅移除单币种输入时的下拉按钮和面板，多币种模式的下拉面板保留。

**`elements` 对象（第 123-167 行）：**
- 删除 `newAccountCurrencyDropdownBtn`、`newAccountCurrencyDropdownPanel` 引用。
- 保留 `newAccountCurrencyInput`。

**事件绑定：**
- 删除所有 `newAccountCurrencyDropdownBtn` 和 `newAccountCurrencyDropdownPanel` 相关的事件监听。
- 保留 `newAccountCurrencyInput` 的 input/keydown 事件（自动补全）。

**`state` 对象（第 49-78 行）：**
- 删除 `isNewAccountCurrencyDropdownOpen` 属性。

#### `src/renderer-dialogs.js`

**`createBigAccountSelectionDialog`** 多行模式中的币种控件：
- 将币种下拉框替换为文本输入框 + ghost input 自动补全。
- 自动补全的 `allowedCodes` 参数使用所选大账号的币种列表过滤。

**`createBigAccountManagerDialog`**（第 909 行起）中的币种控件：
- 同样移除下拉面板，仅保留文本输入框 + 自动补全。

#### `src/styles.css`

- 可选清理：`.new-account-currency-dropdown-*` 相关样式。保留不影响功能，删除可减少 CSS 体积。

### 4.2 影响分析

- 涉及所有使用币种输入的场景：新开账户模块、大账号/币种选择对话框、大账号管理对话框。
- 自动补全核心逻辑（`ensureCurrencyGhostShell`、`getCurrencySuggestion`、`getCurrencyOptionEntries`）保持不变。
- 需求一中新增的币种输入框天然使用文本输入+自动补全，无额外适配。

---

## 五、需求四：MerchantId 自己输入模式增强

### 5.1 现有实现分析

当前大账号选择的触发条件（`main.js:3674-3701`）：

```
const bigAccountOptions = expandBigAccountConfigurations(templateConfig.bigAccounts);
if (bigAccountOptions.length > 1) {
  // 构建 selectionRows，弹出大账号选择对话框
}
```

即：只有当模板维护了多个大账号/币种组合时才触发。PRD 需求四要求在以下情况**额外**触发：
1. 场景 A：MerchantId 为"自己输入"模式，一次导入多个文件
2. 场景 B：MerchantId 为"自己输入"模式，单文件中有多行数据

### 5.2 修改点清单

#### `src/main.js`

**`file:import` handler**（第 3616-3790 行）：

在 `bigAccountOptions.length > 1` 判断之后，新增以下逻辑：

```
// 现有逻辑之后（约第 3701 行之后），新增判断：
const isMultiBigAccountTemplate = ... // 复用现有判断
if (isMultiBigAccountTemplate && bigAccountOptions.length <= 1) {
  // MerchantId 为"自己输入"模式，但大账号只有 0 或 1 个
  // 需要判断是否为多文件或多行场景

  const inputFileCount = selectionResult.filePaths.length;

  // 构建临时的 mapped rows 来判断行数
  const provisionalFileEntries = buildPendingBigAccountFileEntries({
    template: templateConfig.template,
    mappings: templateConfig.exportMappings,
    orderedTargetFields: templateConfig.exportTargetFields,
    inputFilePaths: selectionResult.filePaths
  });
  const totalDataRows = provisionalFileEntries.reduce(
    (sum, entry) => sum + Math.max(0, entry.detailRows.length - 1), 0
  );

  const needsSelection = inputFileCount > 1 || totalDataRows > 1;

  if (needsSelection) {
    const selectionRows = buildBigAccountSelectionRows(provisionalFileEntries);
    // 为每行加上文件名信息
    rememberPendingBigAccountSelection({
      templateId,
      template: templateConfig.template,
      mappings: templateConfig.exportMappings,
      orderedTargetFields: templateConfig.exportTargetFields,
      inputFilePaths: selectionResult.filePaths,
      bigAccounts: templateConfig.bigAccounts,
      fixedAssignments: templateConfig.fixedAssignments,
      fileEntries: provisionalFileEntries,
      rows: selectionRows
    });
    return buildBigAccountSelectionRequiredResult({
      rows: selectionRows,
      bigAccounts: templateConfig.bigAccounts,
      fixedAssignments: templateConfig.fixedAssignments
    });
  }
}
```

**触发时机明确**：
- 场景 A 触发条件：用户在一次"导入文件"操作中选择了多个文件（`selectionResult.filePaths.length > 1`），且 MerchantId 为"自己输入"模式。
- 场景 B 触发条件：导入的文件（可能是 1 个或多个）解析后总数据行数 > 1，且 MerchantId 为"自己输入"模式。
- 场景 A+B 交叉：多文件且部分文件含多行 → 统一弹出综合对话框，按文件+行号列出（AC4-11）。

**`buildBigAccountSelectionRows`**（第 500-517 行）：
- 已支持多文件多行的 rows 构建，每行包含 `fileName` 和 `sourceRowNumber`。无需修改此函数。

#### `src/renderer-dialogs.js`

**`createBigAccountSelectionDialog`** 多行模式（第 563 行起）：

当前已支持 `payload.rows` 模式。需要确认以下调整：
- 币种列从下拉框改为文本输入框+自动补全（与需求三一致）。
- 大账号列保持下拉选择。
- 每行标签显示格式：多文件场景显示 `"1. 文件名.xlsx"`，多行场景显示 `"1. 第3行的账号为："`。这由 `row.label` + `row.fileName` 组合决定，主要在 `main.js` 构建 rows 时处理。

#### `src/renderer.js`

导入文件回调逻辑中已有处理 `select-big-account` 状态的代码，弹出 `createBigAccountSelectionDialog`。无需修改。

### 5.3 待确认事项

1. **大账号数据源**：当 MerchantId 为"自己输入"且模板未维护大账号列表时，下拉框选项为空。此时用户需先去"维护大账号"添加数据。实现方案：在 `needsSelection` 判断后、弹出对话框前，检查 `bigAccounts.length === 0`，若为空则返回错误提示 `{ status: 'error', message: '请先在映射管理中维护大账号列表' }`，中止导入流程。
2. **单行单文件场景**：MerchantId 为"自己输入"，单文件单行时不弹对话框，沿用当前逻辑（自动使用第一个/唯一一个大账号）。若大账号列表为空（0 个），同样返回上述错误提示。

---

## 六、需求五：映射字段新增"需要拼接字段"

### 6.1 数据结构设计

映射保存时的数据结构：

```json
{
  "templateField": "AccountNo",
  "mappedField": "需要拼接字段",
  "mappedFields": ["账号前缀", "账号主体", "校验位"],
  "concatSeparator": ""
}
```

- `mappedField` 值为 `"需要拼接字段"`（常量 `CONCAT_FIELDS_MAPPING_FIELD`）。
- `mappedFields` 数组按用户指定的顺序存储子字段名称。
- `concatSeparator` 为拼接分隔符，当前版本为空字符串（直接连接）。后续如需支持分隔符（如 `-`、`/`），直接修改此值即可。
- 判断是否为拼接模式统一通过 `mappedField === '需要拼接字段'` 判断，无需额外布尔标记。

**与现有多选的关系**：
- 现有多选（`<select multiple>`）保留，两者并存。
- 区别：现有多选通过 Ctrl/Shift 在 select 中多选，保存时弹 `createMappingOrderDialog` 确认顺序；"需要拼接字段"通过专门的带序号多选面板直接指定顺序，无需额外确认步骤。
- 保存到数据库的结构相同（`mapped_fields_json`），加载时通过 `mappedField === '需要拼接字段'` 判断是否为拼接模式。

### 6.2 修改点清单

#### `src/renderer.js`

**常量定义（约第 13-20 行区域）：**

```javascript
const CONCAT_FIELDS_MAPPING_FIELD = '需要拼接字段';
```

将其追加到 `ADVANCED_MAPPING_FIELDS` 之后作为独立常量（不加入 `ADVANCED_MAPPING_FIELDS` 数组，因为它不是高级映射字段，而是映射值的一个可选项）。

#### `src/renderer-dialogs.js`

**`createMappingDialog`**（第 1424-1662 行）：

1. **映射字段 `<select>` 新增选项**（约第 1490-1494 行）：

   在 `headerOptions` 和现有特殊选项之后，对非 Balance、非 MerchantId、非高级字段的行，追加 `<option value="需要拼接字段">需要拼接字段</option>`。

   ```javascript
   const selectOptions = [...]
     .concat(supportsMultiSelect && !isAdvancedField
       ? [`<option value="${CONCAT_FIELDS_MAPPING_FIELD}">${CONCAT_FIELDS_MAPPING_FIELD}</option>`]
       : [])
     .concat(headerOptions)
     .join('');
   ```

2. **拼接字段选择 UI**（`createMappingDialog` 内新增）：

   每个映射行的 `<td>` 中，在 `<select>` 后新增一个拼接字段控件容器 `.concat-field-picker`（默认 hidden）：

   ```html
   <div class="concat-field-picker" hidden>
     <button class="concat-picker-trigger secondary-btn small" type="button">选择字段</button>
     <div class="concat-picker-panel" hidden>
       <!-- 动态生成选项列表 -->
     </div>
     <span class="concat-preview" title=""></span>
   </div>
   ```

3. **拼接字段交互逻辑**（新增函数）：

   ```
   function createConcatFieldPicker(row, headers, savedFields) {
     // 初始化面板，列出所有 headers 作为可选项
     // 每个选项：[checkbox] [序号位] [字段名]
     // 点击事件：toggle 勾选，按点击顺序分配序号
     // 取消勾选：移除，后续序号重排
     // 面板关闭时：更新预览文本
   }
   ```

   关键伪代码：

   ```
   selectedFields = [] // 有序数组

   onClick(fieldName):
     if fieldName in selectedFields:
       selectedFields.remove(fieldName)
     else:
       selectedFields.push(fieldName)
     重新渲染面板（更新序号）
     更新预览文本

   updatePreview():
     previewText = selectedFields.join(' ')
     if previewText.length > 40:
       显示前 40 字符 + "......"
     tooltip = selectedFields.join(' ')
   ```

4. **select change 事件增强**（约第 1558 行 `syncEditorState` 区域）：

   ```
   function syncEditorState() {
     const selectedValue = getSelectValues(select)[0];
     const isConcatMode = selectedValue === CONCAT_FIELDS_MAPPING_FIELD;
     const isCustomInput = selectedValue === MERCHANT_ID_SELF_INPUT_OPTION;

     if (manageBigAccountBtn) manageBigAccountBtn.hidden = !isCustomInput;
     if (concatFieldPicker) concatFieldPicker.hidden = !isConcatMode;

     // AC5-14：切换回普通值时清空拼接配置
     if (!isConcatMode && concatFieldPicker) {
       clearConcatSelection();
     }
   }
   ```

5. **`collectMappingDraftFromTable`**（第 352-365 行）：

   扩展收集逻辑：

   ```javascript
   function collectMappingDraftFromTable(tableBody) {
     return Array.from(tableBody.querySelectorAll('tr[data-template-field]')).map((row) => {
       const select = row.querySelector('.mapping-select');
       const mappedFields = getSelectValues(select);
       const concatPicker = row.querySelector('.concat-field-picker');
       const isConcatMode = mappedFields[0] === CONCAT_FIELDS_MAPPING_FIELD;

       // 如果是拼接模式，从 concatPicker 中读取已选字段的有序列表
       const concatFields = isConcatMode && concatPicker
         ? getConcatSelectedFields(concatPicker)
         : [];

       return {
         templateField: row.dataset.templateField,
         mappedField: mappedFields[0] || '',
         mappedFields: isConcatMode ? concatFields : (mappedFields.length > 1 ? mappedFields : []),
         customValue: '',
         isMultiBigAccount: false,
         concatSeparator: isConcatMode ? '' : undefined
       };
     });
   }
   ```

6. **保存时跳过 `createMappingOrderDialog`**（第 1617-1651 行）：

   对拼接模式的映射，不需要弹出排序确认框（因为拼接面板已经包含排序）。修改多选判断：

   ```javascript
   const multiSelectMappings = draftMappings.filter(
     (mapping) => Array.isArray(mapping.mappedFields)
       && mapping.mappedFields.length > 1
       && mapping.mappedField !== CONCAT_FIELDS_MAPPING_FIELD  // 拼接模式已有序，不弹排序确认
   );
   ```

#### `src/main.js`

**`validateTemplateConfiguration`**（约第 2290 行区域）：

处理 `mappedField === '需要拼接字段'` 的映射：
- 将 `mappedFields` 数组直接保存（已有序）。
- `mappedField` 保存为 `'需要拼接字段'` 标记值。

**`normalizeMappingRows`**（第 1208-1265 行）：

加载映射时，检测 `mappedField === '需要拼接字段'`：
- 返回 `{ mappedField: '需要拼接字段', mappedFields: [...已保存的有序字段], concatSeparator: '' }`。
- 回显到前端对话框时，拼接面板根据 `mappedField === '需要拼接字段'` 和 `mappedFields` 恢复已选状态和顺序。

#### `src/backend/file-service.js`（`buildMappedRows` 函数，第 38-200 行）

**已确认无需修改拼接逻辑**。现有 `resolveRawValueByMapping` 已支持数组类型的 `mappingValue`，拼接逻辑为 `resolveMappedPartsByTokens(mappingTokens, row).filter(...).join('')`（第 95-98 行）。当 `mappingByField[targetField]` 为 `['账号前缀', '账号主体', '校验位']` 时，自动按序拼接各列值。空值处理的精确行为：`resolveMappedPartsByTokens` 解析各列原始值后，通过 `.filter((value) => normalizeCell(value) !== '')` 过滤掉空值（含空白字符串），再 `.join('')` 拼接（第 95-97 行）。当前分隔符为空字符串，"过滤空值"与"空值作为空字符串参与拼接"结果一致。若后续 NFR-4 扩展支持非空分隔符，需将 `filter` 改为保留空字符串（即 `map` 替代 `filter`），以实现"空值视为空字符串参与拼接"的语义（AC5-13）。当前版本无需修改此行为。

`buildMappedFieldLookup`（`main.js:2919-2927`）已将多字段映射以数组形式传入 `mappingByField`，无需额外适配。

**NFR-5 降级兼容**：旧版本客户端打开含"需要拼接字段"的模板时，`mappedField` 值 `'需要拼接字段'` 不会被识别为有效的源文件表头，但 `mappedFields` 数组会被当作普通多选处理，拼接结果与预期一致（因为后端 `resolveRawValueByMapping` 统一处理数组）。

#### `src/styles.css`

新增拼接字段面板样式：

```css
.concat-field-picker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.concat-picker-trigger {
  min-width: 80px;
  height: 34px;
}

.concat-picker-panel {
  position: absolute;
  z-index: 10;
  min-width: 240px;
  max-height: 300px;
  overflow-y: auto;
  border-radius: 14px;
  border: 1px solid var(--line-strong);
  background: rgba(255, 250, 242, 0.98);
  box-shadow: 0 14px 30px rgba(45, 31, 14, 0.15);
  padding: 8px 0;
}

.concat-picker-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  cursor: pointer;
}

.concat-picker-option:hover {
  background: rgba(154, 90, 26, 0.06);
}

.concat-picker-index {
  width: 2em;
  text-align: right;
  color: var(--primary);
  font-weight: 600;
}

.concat-preview {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 13px;
}
```

### 6.3 拼接字段的可选值范围

仅展示文件表头（`payload.template.headers`），排除以下特殊选项：
- `ADVANCED_MAPPING_FIELDS`（`SIGNED_AMOUNT_MAPPING_FIELD`、`AMOUNT_BASED_NAME_MAPPING_FIELD`、`AMOUNT_BASED_ACCOUNT_MAPPING_FIELD`）
- `BALANCE_DISABLED_OPTION`、`BALANCE_CALCULATED_OPTION`
- `MERCHANT_ID_SELF_INPUT_OPTION`（"自己输入"）
- `CONCAT_FIELDS_MAPPING_FIELD`（"需要拼接字段"本身）

即：可选值仅为源文件的实际列名（headers 数组中的值）。

---

## 七、需求六：映射关系管理间距调整

### 7.1 修改点清单

#### `src/styles.css`

**`.data-table th, .data-table td`**（第 1092-1097 行）：

当前 `padding: 14px 16px`。

在 `.mapping-card` 范围内覆盖模板字段列的宽度：

```css
.mapping-card .data-table td:first-child,
.mapping-card .data-table th:first-child {
  width: 1%;
  white-space: nowrap;
  padding-right: 8px;
}
```

这样模板字段列宽度自适应内容（`width: 1%` + `white-space: nowrap` 实现最小宽度适配），映射字段列自动占据剩余空间。列间距由 `padding-right: 8px`（从 16px 缩减）控制。

---

## 八、影响分析

### 8.1 对现有功能的影响

| 现有功能 | 影响说明 | 风险等级 |
|---------|---------|---------|
| 模板导入/导出（JSON bundle） | 需求五的拼接字段映射会被导出为 `mappedFields` 数组。旧版本客户端导入时，`mappedFields` 被视为普通多选处理（NFR-5 降级兼容），不会报错 | 低 |
| 余额账单生成 | 不受影响。Balance 字段不支持多选和拼接 | 无 |
| 新开账户模块 | 需求三仅影响单币种输入场景的下拉框，多币种模式保留现有交互 | 低 |
| 账号映射数据 | 需求一新增列，旧数据自动兼容（DEFAULT 值） | 低 |
| 导出文件内容 | 需求二仅影响文件名，不影响 Excel 内容 | 无 |
| `buildMappedRows` 数据处理 | 需求一的币种回填逻辑修改了 `accountMappingByBankId` 的数据结构（从 string 改为 object），所有读取该对象的位置需同步适配 | 中 |

**`accountMappingByBankId` 读取位置清单**（数据结构从 `{ [bankId]: clearingAccountId }` 变为 `{ [bankId]: { clearingAccountId, noCurrency, currency } }`）：

| 文件 | 行号 | 用途 | 适配方式 |
|------|------|------|---------|
| `src/main.js` | 3004 | 构建 `accountMappingByBankId` | 已在技术文档 2.2 节重新设计，输出新结构 |
| `src/main.js` | 3017 | 传入 `buildStatementGenerationConfig` 返回值 | 透传，无需修改 |
| `src/main.js` | 3035 | 传入 `buildMappedRows` 参数 | 透传，无需修改 |
| `src/backend/file-service.js` | 42 | `buildMappedRows` 参数接收 | 透传，无需修改 |
| `src/backend/file-service.js` | **217-218** | **Drawee/Payee 字段映射**：`String(accountMappingByBankId[originalValue])` | **需修改**：改为 `accountMappingByBankId[originalValue]?.clearingAccountId ?? String(accountMappingByBankId[originalValue])`（兼容旧调用） |
| `src/backend/file-service.js` | 340 | `transformFileToWorkbook` 参数接收 | 透传，无需修改 |
| `src/backend/file-service.js` | 370 | 传入 `buildMappedRows` | 透传，无需修改 |

**关键适配点**：仅 `file-service.js:217-218` 是实际读取值的位置，需从 `String(value)` 改为 `value?.clearingAccountId ?? String(value)`。其余位置均为参数传递，无需修改。新增的币种回填逻辑（技术文档 2.2 节 `file-service.js` 部分）直接读取 `accountMappingByBankId[key].noCurrency` 和 `.currency`，属于新增代码。

### 8.2 需求间的依赖关系

```
需求三 → 需求四（需求四的币种输入依赖需求三的简化方案）
需求三 → 需求一（需求一的币种输入框直接采用简化方案）
需求五 → 需求六（间距调整需考虑拼接预览控件的空间）
```

建议实施顺序：需求六 → 需求三 → 需求一 → 需求二 → 需求四 → 需求五

### 8.3 测试重点

1. 需求一：数据库迁移后旧数据正确加载；勾选/取消勾选联动；币种校验
2. 需求二：文件名截取边界（空、<=4位、>4位）
3. 需求三：所有币种输入场景无遗漏（新开账户、大账号管理、大账号选择）
4. 需求四：多文件/多行/交叉场景触发；关闭对话框取消导入；大账号列表为空时的错误提示
5. 需求五：拼接顺序正确性；切换映射值清空拼接；保存/回显一致性；导出数据拼接结果；多个模板字段同时使用"需要拼接字段"时各行配置独立性
6. 需求六：间距视觉确认；不同字段名长度下无截断
