# 技术设计文档 - 网银账单小助手 v1.4.8

| 项目 | 内容 |
|------|------|
| 版本 | v1.4.8 |
| 日期 | 2026-04-07 |
| 状态 | 已定稿（Open Technical Questions 全部决策） |
| 作者 | Dev |
| PRD | PRD-v1.4.8.md |

---

## 一、PRD 评审意见（技术角度）

### 1.1 需求 1：按字段区分发生额

**总体评估：** 需求清晰，PRD 已锁定全部 21 个细节和 34 条 AC，技术上完全可实现。以下为技术角度的补充和风险点：

1. **新映射字段的"非源字段"性质**：「按字段区分发生额」的下拉框取值是一个新枚举（空 / `是`），并非来自 `template.headers`，与 `Credit Amount` / `Debit Amount` 等普通映射行的"源字段名"语义完全不同。但 PRD §3.3.1 要求其和其它映射一样以独立行存在 `template_mappings` 表（`templateField = 按字段区分发生额`、`mappedField = '' | '是'`）。这种"非源字段"形式的取值在现有 codebase 中已有先例（`BALANCE_DISABLED_OPTION = '无'`、`BALANCE_CALCULATED_OPTION = '通过发生额计算'` 等），可以沿用。

2. **`buildMappedFieldLookup` 的复用问题**：`src/main.js:3240` 的 `buildMappedFieldLookup` 会把 `mappedField` 当成"源字段名"放进 `mappingByTargetField`。新字段的 `mappedField` 取值 `是`/`空` 不是源字段名，但因为 `validateTemplateConfiguration`（`src/main.js:2554-2796`）会校验所有非空 `mappedField` 是否存在于 `sourceFieldSet`（`src/main.js:2752-2754`），所以**必须将「按字段区分发生额」加进 `targetFieldSet` 的同时给它独立的早期 return 分支**，让它跳过常规源字段校验。详见 §5.1。

3. **弹框规则的存储位置选型 (PRD §3.3.3 留给 Dev 决定)**：PRD §3.3.2 要求弹框中 6 个值（4 下拉 + 2 输入）持久化但未指定结构。Dev 选项分析见 §3.1。**Dev 决定采用方案 B：新建 `template_amount_split_rules` 关联表**，理由是结构干净、避免污染主映射表、bundle 兼容性最好（详见 §3.1.2）。

4. **PRD §3.3.1 vs §3.3.2 的存储割裂**：PRD §3.3.1 明确"按字段区分发生额"下拉框的当前值（空白/是）作为一行 `mappingByTarget` 存进现有的 `template_mappings` 表，而 §3.3.2 的 6 个规则字段需要独立持久化。这等于让一个 feature 横跨两张表存储。Dev 沿用 PRD 此设计，理由：
   - "下拉框值"（开关）和"规则细节"（元数据）天然语义不同；
   - "下拉框值"在现有 mapping 流程中天然由 `template:save-mappings` 同步（无需新 IPC）；
   - "规则细节"放独立表后，bundle 的 schema 更整齐。

5. **与 PR #14 的 `legacyConcatMode` 兼容**：`legacyConcatMode` 仅作用于 `Currency` 行（`src/renderer-dialogs.js:1554-1563` + `:399-414`），用来在 v1.4.7 移除 Currency 的 concat 选项后保留旧模板已配置的拼接字段。新 feature 影响的是 `ADVANCED_MAPPING_FIELDS` 末尾新增的「按字段区分发生额」行，**与 `legacyConcatMode` 在字段层面完全不重叠，无冲突**。两套机制各管各的。

6. **与 v1.4.7 PR #14 `dateFormat` 保存路径修复的兼容**：PR #14 的 fix（commit `36b24fd`）是确保 `dateFormat` 不被误清，这是 `database.saveMappings` 签名 `(db, templateId, mappings, bigAccounts, fixedAssignments, dateFormat)` 的最末参数。本次 v1.4.8 不修改 `database.saveMappings` 的签名（详见 §3.4），保留 `dateFormat` 在末尾。`saveMappings` 内部新增的 `template_amount_split_rules` 写入逻辑放在事务的最后一步、在 `UPDATE templates ... date_format` 之前，不影响 `dateFormat` 的写入。

7. **已有的"互斥校验"模式可直接复用**：`src/main.js:2590` 现有的 `if (usesSignedAmountMapping && usesDirectAmountMapping)` 校验是本次新校验的最佳模板。新校验扩展为三方互斥即可。详见 §3.5.1。

8. **正则触发与现有"源字段以 `/` 开头"的歧义**：本项目过去没有任何"以 `/` 开头表示正则"的语法。新引入后用户习惯不应受影响。我们仅在弹框输入框 `[1]` `[2]` 这两个特定位置启用正则解析，其它输入框（mapping select / 大账号管理 / merchant 自己输入框等）不受影响。

### 1.2 历史踩坑记录关联

- **v1.4.6 表头 break / `headerBreaks` 问题**：本需求不涉及多账号块识别，无影响。
- **v1.4.7 `cloneNode` ghost shell 问题**：本需求新增的弹框是从头创建 DOM，不复用 cloneNode，无 ghost 风险。
- **v1.4.7 PR #14 dateFormat 误清问题**：本需求不修改 `database.saveMappings` 已有签名/写入顺序（仅在事务内追加 `template_amount_split_rules` 的 DELETE+INSERT），不会干扰 `dateFormat`。Dev 在实施时务必走 §3.4 描述的事务结构。
- **v1.4.7 PR #11 number 精度问题**：本需求不涉及数字精度（条件值匹配 PRD §3.2.1 明确不做归一化），无影响。

---

## 二、架构总览

### 2.1 涉及模块

```
┌──────────────────────────┐  IPC  ┌─────────────────────────┐
│  renderer-dialogs.js     │ ────► │  main.js                │
│   - createMappingDialog  │       │  - template:save-mappings│
│   - createAmountSplit-   │ ◄──── │  - template:get-mappings │
│     RulesDialog (NEW)    │       │  - template:save-       │
│   - collectMappingDraft- │       │    amount-split-rules   │
│     FromTable (扩展)     │       │    (NEW)                │
└──────────────────────────┘       │  - validateTemplate-    │
                                   │    Configuration (扩展) │
                                   │  - getTemplateMapping-  │
                                   │    Config (扩展)        │
                                   └────────────┬────────────┘
                                                │
                                                ▼
                                   ┌─────────────────────────┐
                                   │  database / repository  │
                                   │  - saveMappings (扩展)  │
                                   │  - getTemplateMappings  │
                                   │    (扩展)               │
                                   │  - saveAmountSplitRules │
                                   │    (NEW)                │
                                   │  - getAmountSplitRules  │
                                   │    (NEW)                │
                                   └────────────┬────────────┘
                                                │
                                                ▼
                                   ┌─────────────────────────┐
                                   │  SQLite                 │
                                   │  - template_mappings    │
                                   │    （新增 1 行）        │
                                   │  - template_amount_     │
                                   │    split_rules (NEW)    │
                                   └─────────────────────────┘

导入流程（独立分支）：
buildStatementGenerationConfig (main.js:3261)
   │
   ▼
amountMappingRules.amountSplitByField = { rules: [credit, debit] }  // 新增
   │
   ▼
buildMappedRowsForFile (main.js:3356)
   │
   ▼
buildMappedRows (file-service.js:38)
   │  在 row map 阶段：
   │  - 若启用 amountSplitByField，按规则计算 credit/debit
   │  - 否则走原有 directAmount / signedAmount 分支
   ▼
exportRows
```

### 2.2 文件清单

| 类型 | 文件 | 说明 |
|------|------|------|
| 修改 | `src/main.js` | 新增常量、扩展校验、扩展 `getTemplateMappingConfig` 返回值、扩展 `buildStatementGenerationConfig`、新增 IPC handler |
| 修改 | `src/renderer-dialogs.js` | 新增 `createAmountSplitRulesDialog`、扩展 `createMappingDialog` 增加新行 + 互斥处理、扩展 `collectMappingDraftFromTable` |
| 修改 | `src/renderer.js` | 透传新增 IPC 句柄（如有需要），加载映射时获取 amount split rules |
| 修改 | `src/preload.js` | 注册 2 个新 IPC 通道（`template:get-amount-split-rules`、`template:save-amount-split-rules`） |
| 修改 | `src/styles.css` | 新增弹框 + 按钮 + disabled 行的样式 |
| 修改 | `src/backend/database.js` | 暴露新增的 repository 方法 |
| 修改 | `src/backend/database/migrations.js` | 新增 `ensureAmountSplitRulesSupport` 迁移函数 |
| 修改 | `src/backend/database/template-repository.js` | 新增 `getAmountSplitRules` / `saveAmountSplitRules`，扩展 `saveMappings` 事务、扩展 `listTemplateBundleEntries` |
| 修改 | `src/backend/file-service.js` | `buildMappedRows` 在 row map 阶段加入"按字段区分发生额"分支、`hasCreditAmount/hasDebitAmount` 联动 |
| 修改 | `package.json` | version 升至 `1.4.8` |

无新增独立文件，无删除文件。

---

## 三、数据模型设计

### 3.1 弹框 6 个规则字段的存储选型

#### 3.1.1 选项分析

| 选项 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A | 在 `template_mappings` 表加 6 个新列 | 改动最小 | 6 个 NULL 列污染主表；列语义强耦合此 feature；难扩展 |
| B | **新建 `template_amount_split_rules` 表** | schema 干净；行式存储自然支持 2 行规则；未来如需扩展更多规则只需 INSERT；bundle 序列化简单 | 多一张表 + 一次 query |
| C | 复用 `mapped_fields_json` 存 JSON 结构 | 不加列 | JSON 结构在 SQLite 中不可索引、不可校验；新字段 `mapped_field` 已被占用为 `空/是` 开关；与"该列存源字段名数组"的语义混淆 |

#### 3.1.2 Dev 决策：方案 B

**最终选择方案 B**（新建 `template_amount_split_rules` 关联表）。理由：

1. PRD §3.3 把"开关"和"细节"概念拆开了，物理存储也跟着拆开最自然。
2. 关联表语义清晰，未来如果需要扩展第 3 行规则、或者支持多种 conditional mapping，只需在表里加行而非加列。
3. Bundle 序列化时，关联表很容易作为子数组挂在 template entry 下（见 §6.1）。
4. 与现有 `template_big_accounts` / `template_fixed_assignments` 关联表一致，保持 codebase 风格统一。

#### 3.1.3 表 schema

```sql
CREATE TABLE IF NOT EXISTS template_amount_split_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  target_field TEXT NOT NULL,           -- 'Credit Amount' | 'Debit Amount'
  condition_field TEXT NOT NULL,        -- "1" / "3" 下拉框值（来自 template.headers）
  condition_value TEXT NOT NULL,        -- [1] / [2] 输入框值（字面值或 /pattern/flags）
  mapped_field TEXT NOT NULL,           -- "2" / "4" 下拉框值（来自 template.headers）
  row_index INTEGER NOT NULL,           -- 0=Credit 行，1=Debit 行
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
  UNIQUE(template_id, row_index)
);

CREATE INDEX IF NOT EXISTS template_amount_split_rules_template_id_idx
ON template_amount_split_rules(template_id);
```

**字段说明：**

| 列 | 说明 |
|----|------|
| `target_field` | 写死 `'Credit Amount'` 或 `'Debit Amount'`。冗余字段，方便 query 时直接区分；同时也是未来扩展的预留位 |
| `condition_field` | PRD §3.2 中的 `"1"`（Credit 行）/ `"3"`（Debit 行）。下拉框选中的列名 |
| `condition_value` | PRD §3.2 中的 `[1]`（Credit 行）/ `[2]`（Debit 行）。用户自由输入的字面值或正则字面量 |
| `mapped_field` | PRD §3.2 中的 `"2"`（Credit 行）/ `"4"`（Debit 行）。命中条件后取值的列名 |
| `row_index` | 0 = Credit 规则行，1 = Debit 规则行。固定 2 行（PRD §3.2 "固定 2 行不可增删"）|

**为什么 `condition_value` 不拆字面值/正则**：触发正则的判定需要在多处使用（保存校验 + 导入匹配），而判定逻辑很简单（"以 `/` 开头并包含结尾 `/`"），与其在 schema 里冗余一个 `is_regex` 列，不如保持 schema 简洁、运行时按需解析。

### 3.2 template_mappings 表的"开关"行

`template_mappings` 表 schema **不变**，只是多写入 1 行：

```javascript
{
  templateField: '按字段区分发生额',
  mappedField: '是',          // 或 '' (空)
  mappedFields: [],
  rowIndex: <next>            // 由 saveMappings 内部按顺序赋值
}
```

**注意：** PRD §3.3.1 明确要求这一行存在。Dev 沿用，不改成新列。

### 3.3 Migration

#### 3.3.1 新增迁移函数

在 `src/backend/database/migrations.js` 末尾新增：

```javascript
function ensureAmountSplitRulesSupport(db) {
  db.exec('BEGIN');

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS template_amount_split_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        target_field TEXT NOT NULL,
        condition_field TEXT NOT NULL,
        condition_value TEXT NOT NULL,
        mapped_field TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, row_index)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS template_amount_split_rules_template_id_idx
      ON template_amount_split_rules(template_id);
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ensureAccountMappingCurrencySupport,
  ensureTemplateDateFormatSupport,
  ensureTemplateMappingEnhancements,
  ensureTemplateKeySupport,
  ensureAmountSplitRulesSupport,   // NEW
  hasColumn
};
```

**幂等保证：**
- `CREATE TABLE IF NOT EXISTS` → 已存在则跳过；
- `CREATE INDEX IF NOT EXISTS` → 已存在则跳过；
- 整个函数包在 `BEGIN / COMMIT / ROLLBACK` 事务中，迁移失败时回滚不会留下半成品；
- 不依赖 `ALTER TABLE`，不需要数据迁移（旧模板的"按字段区分发生额"开关会在 §3.4 的逻辑里默认填 ''）。

#### 3.3.2 注册迁移

在 `src/backend/database.js`：

```javascript
const {
  ensureAccountMappingCurrencySupport,
  ensureTemplateDateFormatSupport,
  ensureTemplateKeySupport,
  ensureTemplateMappingEnhancements,
  ensureAmountSplitRulesSupport,   // NEW
  hasColumn
} = require('./database/migrations');

// init() 内部
this.ensureTemplateKeySupport();
this.ensureTemplateMappingEnhancements();
this.ensureAccountMappingCurrencySupport();
this.ensureTemplateDateFormatSupport();
this.ensureAmountSplitRulesSupport();   // NEW
```

并新增方法：

```javascript
ensureAmountSplitRulesSupport() {
  return ensureAmountSplitRulesSupport(this.db);
}

getAmountSplitRules(templateId) {
  return templateRepository.getAmountSplitRules(this.db, templateId);
}

saveAmountSplitRules(templateId, rules) {
  return templateRepository.saveAmountSplitRules(this.db, templateId, rules);
}
```

### 3.4 `saveMappings` 事务扩展

`saveMappings` 现签名 `(db, templateId, mappings, bigAccounts, fixedAssignments, dateFormat)` **不变**。新规则的写入通过两条路径：

**路径 1（一同保存）**：`saveMappings` 接收一个新的可选参数 `amountSplitRules`：

```javascript
function saveMappings(
  db,
  templateId,
  mappings,
  bigAccounts = [],
  fixedAssignments = [],
  dateFormat,
  amountSplitRules = null   // NEW，可选；null 表示"不动现有规则"
) {
  // ... 现有实现 ...

  // 现有 mappings / bigAccounts / fixedAssignments 写入完成后、UPDATE templates 之前
  if (amountSplitRules !== null) {
    db.prepare('DELETE FROM template_amount_split_rules WHERE template_id = ?').run(templateId);

    const insertRuleStatement = db.prepare(`
      INSERT INTO template_amount_split_rules (
        template_id, target_field, condition_field, condition_value, mapped_field, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    amountSplitRules.forEach((rule, index) => {
      insertRuleStatement.run(
        templateId,
        normalizeText(rule.targetField),
        normalizeText(rule.conditionField),
        normalizeText(rule.conditionValue),
        normalizeText(rule.mappedField),
        Number.isInteger(rule.rowIndex) ? rule.rowIndex : index,
        now,
        now
      );
    });
  }

  // 已有的 UPDATE templates ... date_format 部分保持不变（PR #14 修复保留）
}
```

**关键点：**
- `amountSplitRules` 默认 `null`，表示"调用方没传，不动现有数据"，**不是** "传空数组 = 清空"。这是为了保护现有的 `database.saveMappings` 调用方在不感知新参数时也能正常工作。
- 弹框落库使用单独的 IPC（`template:save-amount-split-rules`，详见 §5.3），它内部会传 `amountSplitRules` 数组（可能为空表示清空）。这条路径专门用于"用户在弹框中点完成"场景。
- 外层「映射关系管理」对话框点完成时会调用 `template:save-mappings`，但**不传 `amountSplitRules`**，这样规则草稿不会被外层动作误清。这与 PRD §3.3.4 "草稿跟着模板走、跟外层下拉框状态无关" 的语义对齐。
- bundle 导入（`src/main.js:3171-3185`）在 v1.4.8 中需要传 `amountSplitRules`，详见 §6.2。

**路径 2（独立 IPC，弹框点完成时）**：`template:save-amount-split-rules` IPC handler 直接调用 `database.saveAmountSplitRules`。详见 §5.3。

### 3.5 新增 repository 方法

在 `src/backend/database/template-repository.js`：

```javascript
function getAmountSplitRules(db, templateId) {
  return db
    .prepare(`
      SELECT
        target_field AS targetField,
        condition_field AS conditionField,
        condition_value AS conditionValue,
        mapped_field AS mappedField,
        row_index AS rowIndex
      FROM template_amount_split_rules
      WHERE template_id = ?
      ORDER BY row_index ASC
    `)
    .all(templateId)
    .map((row) => ({
      targetField: normalizeText(row.targetField),
      conditionField: normalizeText(row.conditionField),
      conditionValue: normalizeText(row.conditionValue),
      mappedField: normalizeText(row.mappedField),
      rowIndex: Number(row.rowIndex || 0)
    }));
}

function saveAmountSplitRules(db, templateId, rules = []) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM template_amount_split_rules WHERE template_id = ?').run(templateId);

    const insertStatement = db.prepare(`
      INSERT INTO template_amount_split_rules (
        template_id, target_field, condition_field, condition_value, mapped_field, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    rules.forEach((rule, index) => {
      insertStatement.run(
        templateId,
        normalizeText(rule.targetField),
        normalizeText(rule.conditionField),
        normalizeText(rule.conditionValue),
        normalizeText(rule.mappedField),
        Number.isInteger(rule.rowIndex) ? rule.rowIndex : index,
        now,
        now
      );
    });

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

并在 `module.exports` 中追加导出。

### 3.6 `getTemplateMappings` 扩展

`getTemplateMappings`（`src/backend/database/template-repository.js:199-235`）的返回值新增 `amountSplitRules` 字段：

```javascript
function getTemplateMappings(db, templateId) {
  const template = getTemplate(db, templateId);
  if (!template) return null;

  const mappings = /* 现有逻辑 */;
  const bigAccountRows = getTemplateBigAccounts(db, templateId);
  const fixedAssignments = getTemplateFixedAssignments(db, templateId);
  const amountSplitRules = getAmountSplitRules(db, templateId);   // NEW

  return {
    template,
    mappings,
    bigAccounts: groupBigAccountRows(bigAccountRows),
    fixedAssignments,
    amountSplitRules               // NEW
  };
}
```

---

## 四、新增常量

在 `src/main.js` 顶部约 `:107` 附近的常量定义区追加：

```javascript
// v1.4.8 — 按字段区分发生额
const AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD = '按字段区分发生额';
const AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION = '是';

// v1.4.8 — bundle 版本（Q1 决策方案 C 预埋，详见 §6.2.1）
const SUPPORTED_BUNDLE_VERSION = 2;

// 加入 ADVANCED_MAPPING_FIELDS（注意是末尾，PRD §3.1）
const ADVANCED_MAPPING_FIELDS = [
  SIGNED_AMOUNT_MAPPING_FIELD,
  AMOUNT_BASED_NAME_MAPPING_FIELD,
  AMOUNT_BASED_ACCOUNT_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD   // NEW，末尾
];
```

`renderer-dialogs.js` 顶部 `createRendererDialogs(deps)` 的 `deps` 解构同步追加：

```javascript
const {
  // ... 现有 ...
  AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION
} = deps;
```

`src/renderer.js` 调用 `createRendererDialogs(deps)` 的地方（searchable）补充传入这两个常量。它们的字面值与 main 进程的常量保持完全一致（PRD §3.3.1 要求 `mappedField` 字面值就是 `'是'`）。

**新增的 IPC channel 名（kebab-case）：**

| Channel | 方向 | 用途 |
|---------|------|------|
| `template:get-amount-split-rules` | renderer→main | 加载某模板的两行规则（用于打开弹框时回显） |
| `template:save-amount-split-rules` | renderer→main | 弹框「完成」按钮触发，直接落库 |

---

## 五、后端改动

### 5.1 `validateTemplateConfiguration` 扩展（`src/main.js:2554`）

#### 5.1.1 新增互斥校验

在 `src/main.js:2584-2592` 现有 `usesSignedAmountMapping && usesDirectAmountMapping` 检查紧邻位置追加：

```javascript
// 现有
const signedAmountSourceField = normalizeCell(mappingByTarget.get(SIGNED_AMOUNT_MAPPING_FIELD)?.mappedField);
const creditAmountSourceField = normalizeCell(mappingByTarget.get('Credit Amount')?.mappedField);
const debitAmountSourceField = normalizeCell(mappingByTarget.get('Debit Amount')?.mappedField);
const usesSignedAmountMapping = signedAmountSourceField !== '';
const usesDirectAmountMapping = creditAmountSourceField !== '' || debitAmountSourceField !== '';

// NEW
const amountSplitByFieldRawValue = normalizeCell(
  mappingByTarget.get(AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD)?.mappedField
);
const usesAmountSplitByField = amountSplitByFieldRawValue === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;

if (usesSignedAmountMapping && usesDirectAmountMapping) {
  throw new FileValidationError('FILE_READ', '"按正负号拆分的发生额"与 Credit Amount / Debit Amount 不能同时设置');
}

// NEW: 三方互斥
if (usesAmountSplitByField && (usesDirectAmountMapping || usesSignedAmountMapping)) {
  throw new FileValidationError(
    'FILE_READ',
    '"按字段区分发生额"与 Credit Amount / Debit Amount 直接映射、按正负号拆分的发生额三者不能同时设置'
  );
}
```

#### 5.1.2 新映射字段的"非源字段"分支

`validateTemplateConfiguration` 的 `targetFields.forEach` 循环（`src/main.js:2631`）会遍历每个 target field 并尝试把 `mappedField` 当源字段名校验。新字段需要早期 return，跳过源字段校验：

```javascript
targetFields.forEach((targetField) => {
  const selectedMapping = mappingByTarget.get(targetField) || { /* ... */ };
  const selectedSourceField = selectedMapping.mappedField;
  // ...

  // NEW: 「按字段区分发生额」是开关字段，mappedField 是 '' 或 '是'，不是源字段名
  if (targetField === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD) {
    const enabled = normalizeCell(selectedSourceField) === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;
    cleanedMappings.push({
      templateField: targetField,
      mappedField: enabled ? AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION : '',
      mappedFields: []
    });
    return;
  }

  // ... 现有 Balance / MerchantId / Concat / 普通字段处理 ...
});
```

#### 5.1.3 弹框规则的合法性校验（保存路径）

弹框规则**主要**通过独立 IPC `template:save-amount-split-rules` 落库，IPC handler 内部会做字段层校验（详见 §5.3）。但 `validateTemplateConfiguration` 也需要做一道"如果开关 = 是，必须有有效规则存在于 DB"的弱校验，避免开关被打开但 rules 表为空的孤儿态。

实现策略：**不在 `validateTemplateConfiguration` 内部校验 rules 表存在性**，因为 `validateTemplateConfiguration` 是纯函数，不应触达 DB。改成在 `template:save-mappings` handler 中（`src/main.js:2924`）校验：如果 `usesAmountSplitByField === true` 且 `database.getAmountSplitRules(templateId)` 返回空数组，则报错：

```javascript
// src/main.js:2924 template:save-mappings handler 内
const templateConfiguration = validateTemplateConfiguration({ /* ... */ });

// NEW: 开关 = '是' 时校验 rules 表非空
const switchEnabled = templateConfiguration.mappings.some(
  (m) => m.templateField === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD
        && m.mappedField === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION
);
if (switchEnabled) {
  const existingRules = database.getAmountSplitRules(payload.templateId);
  if (!existingRules || existingRules.length < 2) {
    return createErrorResult({
      step: '保存模板映射',
      message: '请先在"发生额映射关系管理"中配置完整的两行规则',
      errorCode: 'AMOUNT_SPLIT_RULES_MISSING',
      context: { templateId: payload.templateId }
    });
  }
}

database.saveMappings(/* ... */);
```

**注意：** 这里的"完整两行规则"判断是 `length === 2`（PRD §3.2 固定 2 行）。如果用户在弹框里漏填某一行，弹框层的校验已经会拒绝（§7.2.1），不会有 `length === 1` 的情形进 DB，但保险起见用 `< 2`。

> **PRD 交叉引用（Q-T2 决策，2026-04-07）：** 此校验已于 2026-04-07 补进 PRD §3.2.2 校验规则表 + AC1-28b（由 PM 添加，闭环 Tester 发现的 Q-T2）。Tester 写测试用例时请基于 AC1-28b 编写"开关 = 是 但 rules 表为空，保存映射应报错 `请先在『发生额映射关系管理』中配置完整的两行规则`"的覆盖。

### 5.2 `template:save-mappings` handler 扩展（`src/main.js:2924`）

如 §5.1.3 所示，在调用 `database.saveMappings` **之前**插入"开关-规则"一致性校验。其它逻辑不变。

注意：`payload.amountSplitRules` 字段**不需要**从前端传过来 —— 弹框规则有独立的 save IPC（§5.3），外层「映射关系管理」对话框完成时**只**保存 mappings / bigAccounts / fixedAssignments / dateFormat。

```javascript
database.saveMappings(
  payload.templateId,
  templateConfiguration.mappings,
  templateConfiguration.bigAccounts,
  templateConfiguration.fixedAssignments,
  payload.dateFormat
  // 不传 amountSplitRules，保持为 null，事务内不动 template_amount_split_rules
);
```

### 5.3 新增 IPC handlers

在 `src/main.js` 的 `registerTemplateHandlers` 函数末尾（`src/main.js:3238` 之前）新增：

```javascript
ipcMain.handle('template:get-amount-split-rules', (_event, templateId) => {
  try {
    const template = database.getTemplate(templateId);
    if (!template) {
      return createErrorResult({
        step: '加载发生额映射关系',
        message: '未找到对应模板',
        errorCode: 'TEMPLATE_NOT_FOUND',
        context: { templateId }
      });
    }

    const rules = database.getAmountSplitRules(templateId);
    return {
      status: 'success',
      rules
    };
  } catch (error) {
    return createErrorResult({
      step: '加载发生额映射关系',
      message: '发生额映射关系加载失败',
      errorCode: 'AMOUNT_SPLIT_RULES_LOAD_RUNTIME',
      errorType: '系统错误',
      originalError: error,
      context: { templateId }
    });
  }
});

ipcMain.handle('template:save-amount-split-rules', (_event, payload) => {
  try {
    const template = database.getTemplate(payload.templateId);
    if (!template) {
      return createErrorResult({
        step: '保存发生额映射关系',
        message: '未找到对应模板',
        errorCode: 'TEMPLATE_NOT_FOUND',
        context: { templateId: payload.templateId }
      });
    }

    const validatedRules = validateAmountSplitRulesPayload(template, payload.rules);
    database.saveAmountSplitRules(payload.templateId, validatedRules);
    syncTemplateLibraryFile();
    clearLastErrorReport();
    appendActivityLogEntry({
      level: 'info',
      message: '保存发生额映射关系成功',
      details: [`模板名：${template.name}`]
    });
    return { status: 'success', message: '发生额映射关系保存成功' };
  } catch (error) {
    if (error instanceof FileValidationError) {
      return createErrorResult({
        step: '保存发生额映射关系',
        message: error.message,
        errorCode: error.code,
        originalError: error,
        context: { templateId: payload.templateId }
      });
    }
    return createErrorResult({
      step: '保存发生额映射关系',
      message: '发生额映射关系保存失败',
      errorCode: 'AMOUNT_SPLIT_RULES_SAVE_RUNTIME',
      errorType: '系统错误',
      originalError: error,
      context: { templateId: payload.templateId }
    });
  }
});
```

#### 5.3.1 `validateAmountSplitRulesPayload`（新增辅助函数）

```javascript
function validateAmountSplitRulesPayload(template, rawRules) {
  if (!Array.isArray(rawRules) || rawRules.length !== 2) {
    throw new FileValidationError('FILE_READ', '请填写完整的两行规则');
  }

  const headerSet = new Set(template.headers.map((h) => normalizeCell(h)));
  const expectedTargets = ['Credit Amount', 'Debit Amount'];
  const validated = [];

  rawRules.forEach((rule, index) => {
    const targetField = expectedTargets[index];
    const conditionField = normalizeCell(rule.conditionField);
    const conditionValue = normalizeCell(rule.conditionValue);
    const mappedField = normalizeCell(rule.mappedField);

    if (!conditionField) {
      throw new FileValidationError('FILE_READ', '请为两行规则分别选择条件字段');
    }
    if (!mappedField) {
      throw new FileValidationError('FILE_READ', '请为两行规则分别选择目标字段');
    }
    if (!conditionValue) {
      throw new FileValidationError('FILE_READ', '请填写条件值');
    }
    if (conditionField === mappedField) {
      throw new FileValidationError('FILE_READ', '条件字段与目标字段不能相同');
    }
    if (!headerSet.has(conditionField)) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${conditionField}`);
    }
    if (!headerSet.has(mappedField)) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${mappedField}`);
    }

    // 正则语法校验
    if (isRegexLiteral(conditionValue)) {
      try {
        compileRegexLiteral(conditionValue);
      } catch (_error) {
        throw new FileValidationError('FILE_READ', '正则表达式语法错误');
      }
    }

    validated.push({
      targetField,
      conditionField,
      conditionValue,
      mappedField,
      rowIndex: index
    });
  });

  return validated;
}
```

#### 5.3.2 正则解析辅助函数（新增，main 进程侧）

**位置决策（Q3 决策已生效，2026-04-07）：** 放进 `src/backend/file-service/normalizers.js`。

- main 进程（`src/main.js` 中的 `validateAmountSplitRulesPayload`）和 backend file-service（`buildMappedRows` 中的 `matchAmountSplitConditionValue`）都属于 Node 主进程世界，可以共享同一份模块。
- renderer 进程（`src/renderer-dialogs.js`）**不能** require backend 模块，因此另写一份独立实现，详见 §7.2.1。
- 两份实现必须通过 cross-reference 注释保持同步（Q3 决策方案 A）。
- **不引入** `src/shared/` 公共模块。

```javascript
// src/backend/file-service/normalizers.js 末尾追加
//
// 同步修改：renderer 侧的另一份实现位于 src/renderer-dialogs.js 内 createRendererDialogs
// 的 looksLikeRegexLiteral / parseRegexLiteral，两份必须保持行为一致。
// 不要引入 src/shared/ 公共模块（团队约定）。

const REGEX_LITERAL_PATTERN = /^\/(.+)\/([gimsu]*)$/;

function isRegexLiteral(input) {
  if (typeof input !== 'string') return false;
  if (!input.startsWith('/')) return false;
  // 至少 3 字符 (/x/)，且匹配 /pattern/flags 形态
  return REGEX_LITERAL_PATTERN.test(input);
}

function compileRegexLiteral(input) {
  const match = REGEX_LITERAL_PATTERN.exec(input);
  if (!match) {
    throw new Error('Invalid regex literal');
  }
  const [, pattern, flags] = match;
  return new RegExp(pattern, flags);
}

function matchAmountSplitConditionValue(rawSourceCell, conditionValue) {
  // PRD §3.2.1: 先 trim 源字段值首尾空白
  const trimmedSource = String(rawSourceCell ?? '').trim();
  const trimmedTarget = String(conditionValue ?? '').trim();

  if (isRegexLiteral(trimmedTarget)) {
    let regex;
    try {
      regex = compileRegexLiteral(trimmedTarget);
    } catch (_error) {
      // 配置时已校验，运行时再次失败兜底为不命中
      return false;
    }
    return regex.test(trimmedSource);
  }

  // 字面值精确匹配，大小写敏感
  return trimmedSource === trimmedTarget;
}

module.exports = {
  // ... 现有 ...
  isRegexLiteral,
  compileRegexLiteral,
  matchAmountSplitConditionValue
};
```

`src/main.js` 顶部 require 区追加：

```javascript
const {
  // ... 现有 ...
  isRegexLiteral,
  compileRegexLiteral
} = require('./backend/file-service/normalizers');
```

**关于 `flags` 校验：** `REGEX_LITERAL_PATTERN` 中 `[gimsu]*` 已限定可识别 flag。`new RegExp(pattern, flags)` 会再次校验。

### 5.4 `getTemplateMappingConfig` 扩展（`src/main.js:1483-1499`）

`getTemplateMappingConfig` 已经返回 `template / mappings / bigAccounts / fixedAssignments`。新增 `amountSplitRules`：

```javascript
return {
  template: templatePayload.template,
  enumValues,
  targetFields: buildManagedMappingFields(enumValues),  // 包含新增的 ADVANCED_MAPPING_FIELDS 末项
  advancedMappingFields: ADVANCED_MAPPING_FIELDS.slice(),
  exportTargetFields: buildExportTargetFields(enumValues),
  mappings,
  exportMappings,
  bigAccounts: compatibleBigAccounts,
  fixedAssignments: /* ... */,
  amountSplitRules: templatePayload.amountSplitRules || []   // NEW
};
```

`template:get-mappings` handler（`src/main.js:2871-2922`）的返回值同步追加：

```javascript
return {
  status: 'success',
  template: buildTemplateSummary(mappingConfig.template),
  targetFields: mappingConfig.targetFields,
  advancedMappingFields: mappingConfig.advancedMappingFields,
  exportTargetFields: mappingConfig.exportTargetFields,
  mappings: mappingConfig.mappings,
  bigAccounts: mappingConfig.bigAccounts,
  fixedAssignments: mappingConfig.fixedAssignments,
  dateFormat: mappingConfig.template.dateFormat || 'auto',
  amountSplitRules: mappingConfig.amountSplitRules   // NEW
};
```

**注意：** `amountSplitRules` 同时通过 `template:get-mappings` 整体返回（用于回显外层下拉框 + 弹框初始草稿）。独立 IPC `template:get-amount-split-rules` 仅在弹框单独打开时用作精确加载。两条路径数据来源相同。

### 5.5 `buildStatementGenerationConfig` 扩展（`src/main.js:3261`）

返回值的 `amountMappingRules` 新增 `amountSplitByField` 子结构：

```javascript
return {
  // ... 现有 ...
  amountMappingRules: {
    signedAmountSourceField: mappingByTargetField[SIGNED_AMOUNT_MAPPING_FIELD],
    nameSourceField: mappingByTargetField[AMOUNT_BASED_NAME_MAPPING_FIELD],
    accountSourceField: mappingByTargetField[AMOUNT_BASED_ACCOUNT_MAPPING_FIELD],
    amountSplitByField: buildAmountSplitByFieldConfig(template, selectedMappings)   // NEW
  },
  dateParseOrder: template.dateFormat || 'auto'
};
```

新增辅助函数：

```javascript
function buildAmountSplitByFieldConfig(template, selectedMappings) {
  const switchMapping = selectedMappings.find(
    (m) => m.templateField === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD
  );
  const enabled = switchMapping && normalizeCell(switchMapping.mappedField) === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;

  if (!enabled) {
    return { enabled: false, rules: [] };
  }

  const rules = database.getAmountSplitRules(template.id);

  // PRD §3.4.6: 校验源文件 headers 中存在条件/目标字段（在导入路径会再校验一次，此处提早暴露）
  // 这里不抛 error，因为 buildStatementGenerationConfig 在导入主路径上，保留校验权给 buildMappedRows

  return {
    enabled: true,
    rules: rules.map((rule) => ({
      targetField: rule.targetField,
      conditionField: rule.conditionField,
      conditionValue: rule.conditionValue,
      mappedField: rule.mappedField
    }))
  };
}
```

**说明：**
- `buildStatementGenerationConfig` 是导入流程入口的一部分（`src/main.js:3261`，被 `statementGenerationHelpers` 在 `file:import` 链路中调用）。
- 这里读 `database.getAmountSplitRules` 是 sync 调用（`better-sqlite3` 风格），不会增加额外延迟。
- 返回结构 `{ enabled, rules }` 让下游 `buildMappedRows` 一目了然。

### 5.6 `buildMappedRowsForFile` 透传

`src/main.js:3356` 已经透传整个 `config.amountMappingRules`。无需修改 — `amountSplitByField` 子字段会自动跟着 `amountMappingRules` 流到 `buildMappedRows`。

---

## 六、Bundle 导出/导入

### 6.1 Bundle JSON 结构

#### 6.1.1 现状

`buildTemplateLibraryPayload`（`src/main.js:904-910`）返回：

```json
{
  "bundleVersion": 1,
  "exportedAt": "2026-04-07T...",
  "templates": [
    {
      "templateKey": "...",
      "name": "...",
      "sourceFileName": "...",
      "headers": [...],
      "mappings": [...],
      "bigAccounts": [...],
      "fixedAssignments": [...],
      "dateFormat": "auto",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

`bundleVersion` 字段已经存在（值 `1`），但目前 `readTemplateBundleFile`（`src/main.js:923-948`）**没有校验**这个字段。

#### 6.1.2 v1.4.8 修改

**bundleVersion 升至 2**。每个 template entry 新增 `amountSplitRules` 字段。

```json
{
  "bundleVersion": 2,
  "exportedAt": "2026-04-07T...",
  "templates": [
    {
      "templateKey": "...",
      "name": "...",
      "sourceFileName": "...",
      "headers": [...],
      "mappings": [...],   // 包含「按字段区分发生额」的开关行
      "bigAccounts": [...],
      "fixedAssignments": [...],
      "amountSplitRules": [   // NEW
        {
          "targetField": "Credit Amount",
          "conditionField": "TXN_TYPE",
          "conditionValue": "C",
          "mappedField": "AMOUNT",
          "rowIndex": 0
        },
        {
          "targetField": "Debit Amount",
          "conditionField": "TXN_TYPE",
          "conditionValue": "D",
          "mappedField": "AMOUNT",
          "rowIndex": 1
        }
      ],
      "dateFormat": "auto",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

#### 6.1.3 `listTemplateBundleEntries` 扩展

`src/backend/database/template-repository.js:321-341`：

```javascript
function listTemplateBundleEntries(db) {
  return listTemplates(db).map((template) => {
    const payload = getTemplateMappings(db, template.id);
    return {
      templateKey: template.templateKey,
      name: template.name,
      sourceFileName: template.sourceFileName,
      headers: template.headers,
      mappings: payload ? payload.mappings.map((mapping) => ({ ...mapping })) : [],
      bigAccounts: payload ? /* ... */ : [],
      fixedAssignments: payload ? payload.fixedAssignments.map((item) => ({ ...item })) : [],
      amountSplitRules: payload ? payload.amountSplitRules.map((r) => ({ ...r })) : [],   // NEW
      dateFormat: template.dateFormat || 'auto',
      createdAt: template.createdAt,
      updatedAt: template.updatedAt
    };
  });
}
```

`buildTemplateLibraryPayload` 同步把 `bundleVersion` 升至 `2`：

```javascript
function buildTemplateLibraryPayload() {
  return {
    bundleVersion: 2,   // bumped from 1
    exportedAt: new Date().toISOString(),
    templates: database.listTemplateBundleEntries()
  };
}
```

### 6.2 Bundle 导入

#### 6.2.1 旧版 app 打开新 bundle → 本版本无法满足 AC1-20（已决策 2026-04-07，方案 C）

**关键问题：旧版 app（v1.4.7 及以下）已经发布，没有 bundleVersion 校验代码。** 我们无法回溯让旧版 app 报错。

**用户决策（2026-04-07）：选择方案 C**
- 接受 AC1-20 在 v1.4.7→v1.4.8 方向**本版本暂不满足**，标记为 **known limitation**。
- v1.4.8 仍然在 bundle 顶层写入 `bundleVersion = 2`，并在每个 template entry 中写入 `amountSplitRules` 字段。
- v1.4.8 自身的 `readTemplateBundleFile` 加入"`bundleVersion > SUPPORTED_BUNDLE_VERSION` 时拒绝"的校验逻辑，但因为 v1.4.8 自己 `SUPPORTED_BUNDLE_VERSION = 2`，**这段校验在本版本运行时永远不会触发**（不存在 `bundleVersion ≥ 3` 的合法 bundle），它仅作为给 v1.4.9+ 的预埋。
- v1.4.9+ 发布时会读 v1.4.8 写入的 `bundleVersion = 2`，校验逻辑届时生效，可以正确拒绝来自 ≥ v1.4.9 的更高版本 bundle。
- v1.4.7 老用户由 release note 明确提示："请升级到 v1.4.8 以避免导入新 bundle 时静默丢失字段"。
- **不发 v1.4.7.1 hotfix。**

**Dev 实施要点：**
1. `buildTemplateLibraryPayload` 把 `bundleVersion` 升到 `2` —— **必做**，让未来的 v1.4.9+ 能够正确识别版本。
2. `readTemplateBundleFile` 加入 `bundleVersion > SUPPORTED_BUNDLE_VERSION` 校验 —— **必做**，让本版本面对 v1.4.9+ 导出的 bundle 时也能正确拒绝（v1.4.8 自身永远不会触发，但代码必须存在）。
3. `SUPPORTED_BUNDLE_VERSION` 常量定义位置：放在 `src/main.js` 顶部常量区附近（与 `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` 相邻），值为 `2`。理由：`readTemplateBundleFile` 在 `src/main.js` 中，常量与使用方就近原则。

**对 AC1-20 的影响：** 测试时跳过此 AC，标记为 known limitation，写进 release note。

#### 6.2.2 新版 app 打开旧 bundle（PRD AC1-21）

`readTemplateBundleFile`（`src/main.js:923-948`）扩展：

```javascript
// 在 src/main.js 顶部常量区附近（与 AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD 相邻）
const SUPPORTED_BUNDLE_VERSION = 2;   // v1.4.8 自身支持的最高 bundle 版本

function readTemplateBundleFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new FileValidationError('FILE_READ', '模板文件不存在或不可读');
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    throw new FileValidationError('FILE_READ', '模板文件格式错误，请重新确认');
  }

  // NEW: bundleVersion 校验
  // 旧 bundle (v1.4.7 及以下) 没有 bundleVersion 字段 → 当作版本 1 处理
  // 新 bundle 来自更高版本 (v1.4.9+) 时报错拒绝
  // 注：v1.4.8 自身 SUPPORTED_BUNDLE_VERSION = 2，本版本运行时这段校验永远不会触发，
  //     仅为 v1.4.9+ 预留。v1.4.7→v1.4.8 方向无法报错（旧版本没有这段代码），
  //     已 release note 提示用户升级。详见 §6.2.1。
  const bundleVersion = Number(parsed?.bundleVersion || 1);
  if (bundleVersion > SUPPORTED_BUNDLE_VERSION) {
    throw new FileValidationError(
      'FILE_READ',
      `此 bundle 来自更高版本的应用，请升级 (需要 bundleVersion ${bundleVersion} 及以上)`
    );
  }

  const templates = Array.isArray(parsed?.templates) ? parsed.templates : [];

  return templates.map((item) => ({
    templateKey: normalizeCell(item.templateKey),
    name: normalizeCell(item.name),
    sourceFileName: normalizeCell(item.sourceFileName) || `${normalizeCell(item.name) || 'template'}.xlsx`,
    headers: Array.isArray(item.headers) ? item.headers.map(normalizeCell).filter(Boolean) : [],
    mappings: Array.isArray(item.mappings) ? item.mappings : [],
    bigAccounts: Array.isArray(item.bigAccounts) ? item.bigAccounts : [],
    fixedAssignments: Array.isArray(item.fixedAssignments) ? item.fixedAssignments : [],
    amountSplitRules: Array.isArray(item.amountSplitRules) ? item.amountSplitRules : [],  // NEW，旧 bundle 缺字段填 []
    dateFormat: normalizeCell(item.dateFormat) || 'auto'
  }));
}
```

**幂等保证：**
- 旧 bundle (`bundleVersion = 1` 或缺字段) → `amountSplitRules` 默认 `[]`，导入后该模板的"按字段区分发生额"开关默认空白（PRD AC1-21 ✓）。
- 新 bundle (`bundleVersion = 2`) → 正常解析。
- 未来 bundle (`bundleVersion >= 3`) → v1.4.8 自身**不会**遇到（因为 v1.4.9+ 还没发布），但代码已就位，留给 v1.4.9+ 实际生效。
- v1.4.7 旧版 app 打开 v1.4.8 bundle → 旧版没有此校验代码，会静默忽略 `amountSplitRules` 字段。这是 known limitation，不在本版本测试范围（详见 §6.2.1 + §10.1）。

#### 6.2.3 Bundle 导入路径写入新表

`src/main.js:3171-3185` 当前调用：

```javascript
database.saveMappings(
  template.id,
  validated.mappings,
  validated.bigAccounts,
  validated.fixedAssignments,
  entry.dateFormat
);
```

需要扩展为：

```javascript
database.saveMappings(
  template.id,
  validated.mappings,
  validated.bigAccounts,
  validated.fixedAssignments,
  entry.dateFormat,
  Array.isArray(entry.amountSplitRules) ? entry.amountSplitRules : []   // NEW
);
```

注意，此处传**数组**（可能为空）给 `saveMappings` 的第 6 个参数，触发 `template_amount_split_rules` 表的 DELETE+INSERT。空数组 = 清空。这与外层 `template:save-mappings` IPC 路径（不传，保持 `null`）的语义不同 —— bundle 导入是"完整覆盖"，外层映射对话框是"局部更新"。

#### 6.2.4 `validateTemplateConfiguration` 在 bundle 导入路径要不要校验"开关-规则"一致性？

- bundle 来源可信（自家 app 导出），结构应当一致；
- 但用户可能手动编辑过 JSON；
- Dev 决策：**bundle 导入跳过"开关-规则一致性"校验**，仅依赖 JSON 中字段的物理存在。如果用户手动改坏 JSON 导致"开关 = 是 但规则 = []"，导入后该模板再次打开映射对话框时会被 `template:save-mappings` handler 校验拦截，用户需要手动配置。这不会破坏数据，只是稍后会暴露问题，可接受。

---

## 七、前端改动

### 7.1 `createMappingDialog` 扩展（`src/renderer-dialogs.js:1444`）

#### 7.1.1 advancedMappingFields 透传

`payload.advancedMappingFields` 已经包含新字段（main 进程在 §5.4 已扩展），无需在 renderer 层硬编码。**section 标题判断** `if (fieldName === advancedMappingFields[0])`（`renderer-dialogs.js:1490`）保持不变 —— 因为 `ADVANCED_MAPPING_FIELDS[0]` 仍是 `SIGNED_AMOUNT_MAPPING_FIELD`，新字段是末尾追加，不影响 section 标题位置。

#### 7.1.2 新行的 select 选项构造

`createMappingDialog` 的 `payload.targetFields.forEach` 循环（`renderer-dialogs.js:1489`）会自动创建新行（因为 targetFields 已包含新字段名）。需要在 select 选项构造逻辑中给新字段一个特殊分支：

```javascript
// renderer-dialogs.js 约 1499 行附近，添加新的 isAmountSplitByFieldField 标志
const isBalanceField = fieldName === 'Balance';
const isMerchantIdField = fieldName === 'MerchantId';
const isAdvancedField = advancedMappingFields.includes(fieldName);
const isAmountSplitByFieldField = fieldName === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD;   // NEW
const supportsSelfInputOption = isMerchantIdField;
const isCurrencyField = fieldName === 'Currency';
const supportsMultiSelect = !isBalanceField && !supportsSelfInputOption && !isAdvancedField && !isCurrencyField;

// ... savedMapping 取值 ...

const selectOptions = isAmountSplitByFieldField
  ? `<option value=""></option><option value="${AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION}">${AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION}</option>`
  : [
      isBalanceField
        ? `<option value="${BALANCE_DISABLED_OPTION}">${BALANCE_DISABLED_OPTION}</option>`
        : '<option value=""></option>'
    ]
      .concat(isBalanceField ? [`<option value="${BALANCE_CALCULATED_OPTION}">${BALANCE_CALCULATED_OPTION}</option>`] : [])
      .concat(supportsSelfInputOption ? [`<option value="${MERCHANT_ID_SELF_INPUT_OPTION}">${MERCHANT_ID_SELF_INPUT_OPTION}</option>`] : [])
      .concat(supportsMultiSelect ? [`<option value="${CONCAT_FIELDS_MAPPING_FIELD}">${CONCAT_FIELDS_MAPPING_FIELD}</option>`] : [])
      .concat(headerOptions)
      .join('');
```

#### 7.1.3 新行的右侧按钮渲染

```javascript
row.innerHTML = `
  <td>${escapeHtml(fieldName)}</td>
  <td>
    <div class="mapping-field-editor">
      <select class="mapping-select">${selectOptions}</select>
      ${isMerchantIdField ? /* 维护大账号 */ : ''}
      ${supportsMultiSelect ? /* concat picker */ : ''}
      ${isAmountSplitByFieldField ? `
        <button class="secondary-btn small mapping-amount-split-manage-btn" type="button" hidden>发生额映射关系管理</button>
      ` : ''}
    </div>
  </td>
`;
```

#### 7.1.4 互斥处理

新增 module-scope 局部变量 `currentAmountSplitRules`，初始来自 `payload.amountSplitRules`（外层 `createMappingDialog` 顶部）：

```javascript
function createMappingDialog(payload) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  // ... 现有 ...
  let currentAmountSplitRules = Array.isArray(payload.amountSplitRules)
    ? payload.amountSplitRules.map((r) => ({ ...r }))
    : [];
  // ...
}
```

新增辅助函数 `applyAmountSplitMutualExclusion(enabled)`：

```javascript
function applyAmountSplitMutualExclusion(enabled) {
  const targets = ['Credit Amount', 'Debit Amount', SIGNED_AMOUNT_MAPPING_FIELD];
  targets.forEach((fieldName) => {
    const otherRow = rowByField.get(fieldName);
    if (!otherRow) return;
    const otherSelect = otherRow.querySelector('.mapping-select');
    if (!otherSelect) return;

    if (enabled) {
      // 互斥：彻底清空 + disabled
      otherSelect.value = '';
      otherSelect.disabled = true;
      otherSelect.title = '已开启"按字段区分发生额"，本字段不可用';
      otherRow.classList.add('mapping-row-mutex-disabled');
      // 同步清空可能的 concat / customValue 状态
      delete otherRow.dataset.legacyConcatMode;
      delete otherRow.dataset.legacyConcatFields;
      otherRow.dataset.concatFields = '[]';
    } else {
      otherSelect.disabled = false;
      otherSelect.title = '';
      otherRow.classList.remove('mapping-row-mutex-disabled');
    }
  });
}
```

调用时机：
1. 渲染完所有行后，根据 `savedMapping.mappedField === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` 调一次（初始化回显）。
2. 新行的 select change handler 中调用：

```javascript
if (isAmountSplitByFieldField) {
  const manageBtn = row.querySelector('.mapping-amount-split-manage-btn');
  select.addEventListener('change', () => {
    const enabled = getSelectValues(select)[0] === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;
    if (manageBtn) manageBtn.hidden = !enabled;
    applyAmountSplitMutualExclusion(enabled);
  });
  // 按钮 click handler
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      openAmountSplitRulesDialog();
    });
  }
}
```

`openAmountSplitRulesDialog` 内部打开 `createAmountSplitRulesDialog`（§7.2）。

#### 7.1.5 `collectMappingDraftFromTable` 扩展

新字段不是源字段映射，但仍要被 `collectMappingDraftFromTable` 输出，以便随外层「映射关系管理」对话框「完成」按钮一起保存到 DB。

由于 `mapping-row-mutex-disabled` 行的 `select.value` 被强制清空，`collectMappingDraftFromTable` 现有逻辑会自然把它们 dump 成 `mappedField = ''`，符合 PRD §3.1 §3.4.2 "彻底清空" 的要求。

新字段的 select 行会被自然处理（select.value = `'是'` 或 `''`），不需要新的 if 分支。注意 `legacyConcatMode` 兼容路径不会触发新行（因为新字段从不进入 concat 模式），无冲突。

#### 7.1.6 `payload.targetFields` 顺序确认

`payload.targetFields` 来自后端 `buildManagedMappingFields`（`src/main.js:1148-1150`），是 `buildMappingTargetFields(enumValues).concat(ADVANCED_MAPPING_FIELDS)`。新字段在 `ADVANCED_MAPPING_FIELDS` 末尾，因此 forEach 会自然把它放在所有 advanced 字段之后，符合 PRD §3.1 "末尾"。

### 7.2 新增弹框 `createAmountSplitRulesDialog`

新增独立函数（建议位置：`src/renderer-dialogs.js` 中 `createMappingDialog` 之后）：

```javascript
function createAmountSplitRulesDialog({ template, draftRules, onComplete, onClose }) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card amount-split-rules-card';

  // 排除特殊枚举值（PRD §3.2 "特殊值排除"）
  const headerOptionsSet = (template.headers || []).filter(
    (h) => h && h !== MERCHANT_ID_SELF_INPUT_OPTION && h !== CONCAT_FIELDS_MAPPING_FIELD
  );

  const renderHeaderOptions = (selected) => {
    const blank = `<option value=""></option>`;
    return blank + headerOptionsSet.map((h) => {
      const escaped = escapeHtml(h);
      const sel = h === selected ? ' selected' : '';
      return `<option value="${escaped}"${sel}>${escaped}</option>`;
    }).join('');
  };

  // 初始化两行规则草稿
  const rules = [
    {
      targetField: 'Credit Amount',
      conditionField: draftRules?.[0]?.conditionField || '',
      conditionValue: draftRules?.[0]?.conditionValue || '',
      mappedField: draftRules?.[0]?.mappedField || ''
    },
    {
      targetField: 'Debit Amount',
      conditionField: draftRules?.[1]?.conditionField || '',
      conditionValue: draftRules?.[1]?.conditionValue || '',
      mappedField: draftRules?.[1]?.mappedField || ''
    }
  ];

  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">发生额映射关系管理</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="amount-split-rules-body">
      <div class="amount-split-rule-row" data-rule-index="0">
        <span>当 </span>
        <select class="mapping-select amount-split-condition-field">${renderHeaderOptions(rules[0].conditionField)}</select>
        <span> 的值为 </span>
        <input class="mapping-text-input amount-split-condition-value" type="text" value="${escapeHtml(rules[0].conditionValue)}" spellcheck="false" />
        <span> 时， </span>
        <select class="mapping-select amount-split-mapped-field">${renderHeaderOptions(rules[0].mappedField)}</select>
        <span> 映射为 Credit Amount</span>
      </div>
      <div class="amount-split-rule-row" data-rule-index="1">
        <span>当 </span>
        <select class="mapping-select amount-split-condition-field">${renderHeaderOptions(rules[1].conditionField)}</select>
        <span> 的值为 </span>
        <input class="mapping-text-input amount-split-condition-value" type="text" value="${escapeHtml(rules[1].conditionValue)}" spellcheck="false" />
        <span> 时， </span>
        <select class="mapping-select amount-split-mapped-field">${renderHeaderOptions(rules[1].mappedField)}</select>
        <span> 映射为 Debit Amount</span>
      </div>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  function readDraftFromUI() {
    return Array.from(dialog.querySelectorAll('.amount-split-rule-row')).map((row, index) => ({
      targetField: index === 0 ? 'Credit Amount' : 'Debit Amount',
      conditionField: row.querySelector('.amount-split-condition-field').value || '',
      conditionValue: row.querySelector('.amount-split-condition-value').value || '',
      mappedField: row.querySelector('.amount-split-mapped-field').value || '',
      rowIndex: index
    }));
  }

  function showError(message, currentDraft) {
    // 错误提示通过 createAlertDialog 弹出。点确认后保留弹框打开，已填字段不丢失。
    openModal(createAlertDialog(message, {
      onConfirm: () => {
        // 重新打开弹框，传 currentDraft 作为草稿
        openModal(createAmountSplitRulesDialog({
          template,
          draftRules: currentDraft,
          onComplete,
          onClose
        }));
      }
    }));
  }

  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const draft = readDraftFromUI();

    // 校验（PRD §3.2.2）
    for (const [i, rule] of draft.entries()) {
      if (!rule.conditionField) return showError('请为两行规则分别选择条件字段', draft);
      if (!rule.mappedField) return showError('请为两行规则分别选择目标字段', draft);
      if (!rule.conditionValue.trim()) return showError('请填写条件值', draft);
      if (rule.conditionField === rule.mappedField) return showError('条件字段与目标字段不能相同', draft);

      // 正则语法校验（PRD §3.2.1 B + AC1-29b）
      if (looksLikeRegexLiteral(rule.conditionValue.trim())) {
        try {
          parseRegexLiteral(rule.conditionValue.trim());
        } catch (_error) {
          return showError('正则表达式语法错误', draft);
        }
      }
    }

    // 直接落库（PRD §3.2 "完成按钮语义"）
    try {
      const result = await desktopApi.templates.saveAmountSplitRules({
        templateId: template.id,
        rules: draft
      });
      if (result.status !== 'success') {
        return showError(result.message || '发生额映射关系保存失败', draft);
      }
      onComplete?.(draft);
      closeModal();
    } catch (error) {
      console.error(error);
      return showError('发生额映射关系保存失败，请查看控制台', draft);
    }
  });

  dialog.querySelector('.icon-close').addEventListener('click', () => {
    onClose?.();
    closeModal();
  });

  overlay.appendChild(dialog);
  return overlay;
}
```

#### 7.2.1 前端正则解析辅助函数（renderer 层）

renderer 层不能直接 require backend 模块。在 `createRendererDialogs` 内部新增两个本地辅助函数（Q3 决策方案 A，2026-04-07）：

```javascript
// 同步修改：另一份实现位于 src/backend/file-service/normalizers.js 内的
// isRegexLiteral / compileRegexLiteral，两份必须保持行为一致。
// 不要引入 src/shared/ 公共模块（团队约定）。
const REGEX_LITERAL_PATTERN_RE = /^\/(.+)\/([gimsu]*)$/;

function looksLikeRegexLiteral(input) {
  return typeof input === 'string'
    && input.startsWith('/')
    && REGEX_LITERAL_PATTERN_RE.test(input);
}

function parseRegexLiteral(input) {
  const match = REGEX_LITERAL_PATTERN_RE.exec(input);
  if (!match) throw new Error('Invalid regex literal');
  const [, pattern, flags] = match;
  return new RegExp(pattern, flags);
}
```

**Q3 决策（2026-04-07）：** 两边各写一份，避免 require backend 到 renderer，**不引入** `src/shared/` 公共模块。两份代码很短，分离并不重；通过 cross-reference 注释保证同步。

#### 7.2.2 弹框打开与回调

在 `createMappingDialog` 中：

```javascript
function openAmountSplitRulesDialog() {
  openModal(createAmountSplitRulesDialog({
    template: payload.template,
    draftRules: currentAmountSplitRules,
    onComplete: (savedDraft) => {
      // 把保存后的草稿反映到外层 state，并重新打开外层 createMappingDialog
      currentAmountSplitRules = savedDraft;
      const draftMappings = collectMappingDraftFromTable(tbody);
      openModal(createMappingDialog({
        ...payload,
        mappings: draftMappings,
        bigAccounts: currentBigAccounts,
        fixedAssignments: currentFixedAssignments,
        amountSplitRules: currentAmountSplitRules
      }));
    },
    onClose: () => {
      // 取消 / x：保留外层不动，只关闭弹框
      // 由于外层 dialog DOM 已被弹框覆盖，需要重新挂载外层
      const draftMappings = collectMappingDraftFromTable(tbody);
      openModal(createMappingDialog({
        ...payload,
        mappings: draftMappings,
        bigAccounts: currentBigAccounts,
        fixedAssignments: currentFixedAssignments,
        amountSplitRules: currentAmountSplitRules
      }));
    }
  }));
}
```

**注意：** `openModal` 会重置 `modalRoot.innerHTML`（`renderer-dialogs.js:22-25`），打开新模态会替换当前 DOM。因此关闭弹框后需要重新构造外层 `createMappingDialog`（与现有 `createBigAccountManagerDialog` 的 `onCancel` 重新打开映射对话框模式一致）。

### 7.3 `preload.js` 暴露新 IPC

```javascript
templates: {
  // ... 现有 ...
  saveMappings: (payload) => ipcRenderer.invoke('template:save-mappings', payload),
  // NEW
  getAmountSplitRules: (templateId) => ipcRenderer.invoke('template:get-amount-split-rules', templateId),
  saveAmountSplitRules: (payload) => ipcRenderer.invoke('template:save-amount-split-rules', payload)
}
```

### 7.4 样式 (`src/styles.css`)

```css
/* v1.4.8 — 按字段区分发生额 */

/* 互斥 disabled 行的样式 */
.mapping-row-mutex-disabled .mapping-select {
  background-color: #f3f0ea;
  color: #8a8275;
  cursor: not-allowed;
}

.mapping-row-mutex-disabled td {
  opacity: 0.6;
}

/* 「发生额映射关系管理」按钮 */
.mapping-amount-split-manage-btn {
  margin-left: 8px;
}

/* 弹框 */
.amount-split-rules-card {
  width: min(100%, 720px);
}

.amount-split-rules-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 4px;
}

.amount-split-rule-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
}

.amount-split-rule-row .mapping-select {
  min-width: 140px;
  height: 32px;
}

.amount-split-rule-row .mapping-text-input {
  min-width: 120px;
  height: 32px;
}
```

---

## 八、导入流程改动

### 8.1 `buildMappedRows` 扩展（`src/backend/file-service.js:38-251`）

在函数签名 `amountMappingRules = {}` 解构基础上新增：

```javascript
function buildMappedRows({
  inputFilePath,
  orderedTargetFields,
  mappingByField,
  accountMappingByBankId = {},
  currencyMappings = [],
  amountMappingRules = {},
  expectedSourceHeaders = [],
  selectedBigAccount = null,
  dateParseOrder = 'auto'
}) {
  const { rows, rowNumbers, headerBreaks = [] } = readRowsWithMetadata(inputFilePath, expectedSourceHeaders);
  const sourceHeaders = rows[0] || [];
  const sourceIndexByField = new Map();
  const issues = [];
  const rowMetas = [];
  const nameSourceField = normalizeCell(amountMappingRules.nameSourceField);
  const accountSourceField = normalizeCell(amountMappingRules.accountSourceField);
  const signedAmountSourceField = normalizeCell(amountMappingRules.signedAmountSourceField);
  // NEW
  const amountSplitConfig = amountMappingRules.amountSplitByField || { enabled: false, rules: [] };
  // ...

  sourceHeaders.forEach((header, index) => {
    const normalizedHeader = normalizeCell(header);
    if (normalizedHeader && !sourceIndexByField.has(normalizedHeader)) {
      sourceIndexByField.set(normalizedHeader, index);
    }
  });

  // NEW: 校验源文件 headers 中存在配置中的条件 / 目标字段（PRD §3.4.6）
  if (amountSplitConfig.enabled) {
    amountSplitConfig.rules.forEach((rule) => {
      if (!sourceIndexByField.has(rule.conditionField)) {
        throw new FileValidationError('FILE_READ', `映射字段不存在：${rule.conditionField}`);
      }
      if (!sourceIndexByField.has(rule.mappedField)) {
        throw new FileValidationError('FILE_READ', `映射字段不存在：${rule.mappedField}`);
      }
    });
  }
```

#### 8.1.1 row map 阶段加入新分支

`rows.slice(1).forEach((row, rowIndex) => { ... })` 内部，**取代**现有的 `creditAmountValue / debitAmountValue / hasCreditAmount / hasDebitAmount` 计算（`file-service.js:114-131`）：

```javascript
rows.slice(1).forEach((row, rowIndex) => {
  let creditAmountValue = '';
  let debitAmountValue = '';
  let hasCreditAmount = false;
  let hasDebitAmount = false;

  if (amountSplitConfig.enabled) {
    // PRD §3.4.1: 并行评估两行规则
    const [creditRule, debitRule] = amountSplitConfig.rules;

    if (creditRule) {
      const conditionCellRaw = row[sourceIndexByField.get(creditRule.conditionField)];
      if (matchAmountSplitConditionValue(conditionCellRaw, creditRule.conditionValue)) {
        const mappedCellRaw = row[sourceIndexByField.get(creditRule.mappedField)];
        creditAmountValue = sanitizeAmountValue(mappedCellRaw);
        hasCreditAmount = hasEffectiveAmount(mappedCellRaw);
      }
    }
    if (debitRule) {
      const conditionCellRaw = row[sourceIndexByField.get(debitRule.conditionField)];
      if (matchAmountSplitConditionValue(conditionCellRaw, debitRule.conditionValue)) {
        const mappedCellRaw = row[sourceIndexByField.get(debitRule.mappedField)];
        debitAmountValue = sanitizeAmountValue(mappedCellRaw);
        hasDebitAmount = hasEffectiveAmount(mappedCellRaw);
      }
    }
  } else {
    // 现有逻辑保持不变
    const directCreditAmountRaw = resolveRawValueByMapping(mappingByField['Credit Amount'], row);
    const directDebitAmountRaw = resolveRawValueByMapping(mappingByField['Debit Amount'], row);
    const signedAmountValue = signedAmountSourceField
      ? splitSignedAmountValue(resolveRawValueByMapping(signedAmountSourceField, row))
      : null;
    creditAmountValue = signedAmountValue
      ? signedAmountValue.creditAmount
      : sanitizeAmountValue(directCreditAmountRaw);
    debitAmountValue = signedAmountValue
      ? signedAmountValue.debitAmount
      : sanitizeAmountValue(directDebitAmountRaw);
    hasCreditAmount = signedAmountValue
      ? signedAmountValue.hasCreditAmount
      : hasEffectiveAmount(directCreditAmountRaw);
    hasDebitAmount = signedAmountValue
      ? signedAmountValue.hasDebitAmount
      : hasEffectiveAmount(directDebitAmountRaw);
  }

  // 现有的 rowMetas / mappedRow 构建保持不变
  rowMetas.push({ sourceRowNumber: rowNumbers[rowIndex + 1] || rowIndex + 2 });
  // ...
});
```

#### 8.1.2 `hasCreditAmount` / `hasDebitAmount` 联动 (PRD §3.4.4)

由于 `hasCreditAmount` / `hasDebitAmount` 已经在 `amountSplitConfig.enabled` 分支里按规则匹配后的写入值正确计算（`hasEffectiveAmount(mappedCellRaw)` 等价于现有 directAmount 模式的语义），后续 `Drawee Name` / `Payee Name` / `Drawee CardNo` / `Payee CardNo` 的现有逻辑（`file-service.js:160-178`）不需要修改 — 它们直接用 `hasCreditAmount` / `hasDebitAmount` 标志，对来源不敏感。AC1-33 自动满足。

#### 8.1.3 `mappingByField` 中的 Credit/Debit Amount 在新模式下的状态

PRD §3.4.2 要求新模式下 Credit/Debit Amount 在 DB 中被清空。因此 `mappingByField['Credit Amount']` 和 `mappingByField['Debit Amount']` 在新模式下都是 `''`。

`buildMappedRows` 现有的 `targetField === 'Credit Amount'` 分支会返回 `creditAmountValue`（在新模式下来自规则匹配），所以对 mappedRow 输出无影响。注意 `orderedTargetFields` 应包含 `'Credit Amount'` 和 `'Debit Amount'`，否则它们不会出现在导出表中 —— 这一点由 `buildExportTargetFields(enumValues)` 保证（`Credit Amount` / `Debit Amount` 是枚举表里固定的列），与映射状态无关。

### 8.2 全部行未命中告警 (PRD §3.4.3 / AC1-32)

> **2026-04-07 修订（Q-T1 决策方案 C）：** Tester 在 TestCases-v1.4.8 评审中发现"多文件导入合计判定"会让单个全部未命中的文件被合计淹没。用户决策方案 C：**改为按每个文件独立判定 + 收集未命中文件名 + 合并告警列出所有全部未命中的文件名**。本节按新方案完整重写，旧的"合计告警"实现描述已删除。
>
> **PRD 文案影响：** PRD AC1-32 / §3.4.3 的旧文案 `本次导入 N 行，其中 0 行成功匹配收支规则，请检查规则配置` 是单文件视角，新方案使用列表式文案，PM 需要相应更新 PRD AC1-32 措辞至列表形式（与本节一致）。本 TechDoc 实施时**以下方文案为准**。

#### 8.2.1 `buildMappedRows` 输出 stats

`buildMappedRows` 不直接抛 warning，而是把"该文件命中数"作为 metadata **挂在 `mappedRows` 数组上**。沿用现有约定：`buildMappedRows` 已经把 `issues` / `rowMetas` / `headerBreaks` 作为属性挂在 `mappedRows` 数组上返回（见 `src/backend/file-service.js:247-250`），新字段 `amountSplitMatchStats` 复用同样的模式：

```javascript
// src/backend/file-service.js buildMappedRows 函数末尾，紧跟现有的 mappedRows.issues / .rowMetas / .headerBreaks
mappedRows.amountSplitMatchStats = amountSplitConfig.enabled
  ? {
      enabled: true,
      totalRows: rows.length - 1,         // 数据行数（不含表头）
      hitCredit: matchedCreditCount,      // 该文件 Credit 命中行数
      hitDebit: matchedDebitCount         // 该文件 Debit 命中行数
    }
  : { enabled: false };
return mappedRows;
```

`matchedCreditCount` / `matchedDebitCount` 在 §8.1.1 的 row forEach 中分别累加：

```javascript
let matchedCreditCount = 0;
let matchedDebitCount = 0;

rows.slice(1).forEach((row, rowIndex) => {
  // ... 现有 amountSplitConfig.enabled 分支匹配逻辑 ...

  if (amountSplitConfig.enabled) {
    if (hasCreditAmount) matchedCreditCount += 1;
    if (hasDebitAmount) matchedDebitCount += 1;
  }

  // ... 现有 mappedRow 构建 ...
});
```

**关键：保持向后兼容。** `buildMappedRows` 仍然返回 `mappedRows` 数组本身（不改成 object），调用方完全无需修改 —— 新字段 `amountSplitMatchStats` 与现有的 `.issues` / `.rowMetas` / `.headerBreaks` 一样作为数组的隐藏属性存在。这避免了任何"breaking change"，调用方只在需要使用 stats 时按 `mappedRows.amountSplitMatchStats` 取用即可。

#### 8.2.2 main 进程：按文件独立判定 + 收集未命中文件名

在 `buildMappedRowsForFile`（`src/main.js:3356`）的上层调用点（即 `statementGenerationHelpers` 处理多文件导入的循环），按每个文件独立判定，收集未命中文件名。注意 `buildMappedRowsForFile` 透传 `buildMappedRows` 的返回值，因此 `mappedRows.amountSplitMatchStats` 在上层依然可见：

```javascript
// src/main.js 多文件导入循环的所在位置（statementGenerationHelpers）
const unmatchedFiles = [];   // 收集"全部未命中"的文件名

for (const fileEntry of fileEntries) {
  const mappedRows = buildMappedRowsForFile(fileEntry, config, ...);
  // mappedRows 是数组，挂有 .issues / .rowMetas / .headerBreaks / .amountSplitMatchStats

  const stats = mappedRows.amountSplitMatchStats;
  // 仅在该文件启用了"按字段区分发生额"模式时才参与判定
  // mappedRows.length > 1：数组首元素是表头，>1 表示至少有一行数据
  if (stats?.enabled && mappedRows.length > 1) {
    if (stats.hitCredit === 0 && stats.hitDebit === 0) {
      unmatchedFiles.push(fileEntry.fileName);
    }
  }

  // ... 现有的把 mappedRows 拼进 finalRows 等逻辑保持不变 ...
}

// 循环结束后，unmatchedFiles 的内容用于构建最终结果中的 warning
```

**判定规则（与 PRD §3.4.3 对齐）：**
1. 仅对**启用了"按字段区分发生额"模式**的文件参与判定（`stats.enabled === true`）。其它文件（即使没有任何金额行）不进 `unmatchedFiles`。
2. 文件**有数据行**（`mappedRows.length > 1`，因为 index 0 是表头）才参与判定。空文件不告警，避免误报。
3. 该文件 `hitCredit === 0 && hitDebit === 0` 时记为"全部未命中"。

#### 8.2.3 IPC 返回 result + renderer 弹框

main 进程的 IPC handler 把 `unmatchedFiles` 放进 result：

```javascript
// src/main.js file:import 或 statement:generate IPC handler 末尾
return {
  status: 'success',           // 仍然 success，因为"导入流程不阻断"（PRD §3.4.3）
  // ... 现有字段 ...
  unmatchedFiles               // NEW，可能是空数组，也可能是 [fileName, ...]
};
```

renderer 收到 result 后，若 `unmatchedFiles.length > 0`，弹一次 alert dialog：

```javascript
// src/renderer.js 对应的 import 完成 handler
if (Array.isArray(result.unmatchedFiles) && result.unmatchedFiles.length > 0) {
  const message = '以下文件全部未命中收支规则，请检查规则配置：\n'
    + result.unmatchedFiles.join('\n');
  openModal(createAlertDialog(message));
}
```

**告警文案规则：**
- 文案前缀固定：`以下文件全部未命中收支规则，请检查规则配置：`
- 紧跟换行 + 文件名列表，每行一个文件名（用 `\n` 连接）
- **即使只有 1 个文件全部未命中，也用同样的列表格式**（前缀 + 换行 + 单行文件名），不再走旧的"本次导入 N 行..."单文件文案

#### 8.2.4 调用方影响：无破坏性改动

由于 §8.2.1 选择"沿用现有约定"——把 `amountSplitMatchStats` 作为属性挂在 `mappedRows` 数组上（与现有的 `.issues` / `.rowMetas` / `.headerBreaks` 同模式），**所有现有调用方完全无需修改**。

只有 §8.2.2 描述的 `statementGenerationHelpers` 多文件循环新增 `unmatchedFiles` 收集逻辑，以及 §8.2.3 的 IPC handler 末尾追加 `unmatchedFiles` 字段进 result。其它任何调用 `buildMappedRows(` / `buildMappedRowsForFile(` 的地方都不需要触碰。

实施时仍建议全文搜索 `buildMappedRows(` 一遍以确认调用面，但不预期会有任何改动。

#### 8.2.5 告警弹出时机：在生成结果之后

告警**不阻断**生成流程（PRD §3.4.3 明确）。`createWarningResult` 不适用（它的语义是"生成失败但有部分结果"），改成在 `status: 'success'` 的 result 上**附带 `unmatchedFiles` 字段**。renderer 在显示生成成功提示**之前或之后**单独弹一次 alert dialog（推荐**之后**：先告知生成成功，再提示哪些文件未命中），由 renderer 实施时决定具体顺序。

### 8.3 源文件缺列报错 (PRD §3.4.6)

已在 §8.1 开头加入了 throw `映射字段不存在：{字段名}`，使用现有的 `FileValidationError` 模式。这与 `src/main.js:2594-2596` 的错误风格保持一致。

---

## 九、回归风险 & 向后兼容

### 9.1 旧模板打开不应崩溃

- 旧模板没有「按字段区分发生额」行 → `getTemplateMappings` 不返回该 templateField → `createMappingDialog` 中 `savedMap.get(fieldName)` 返回 `undefined` → `savedMapping` fallback 到 `{ mappedField: '', mappedFields: [] }` → select.value = '' → 行渲染为空白。AC1-17 ✓
- 旧模板没有 `template_amount_split_rules` 行 → `getAmountSplitRules` 返回 `[]` → 弹框打开时也回显为空。

### 9.2 `legacyConcatMode` 兼容

如 §1.1.5 所述，新增字段不与 `legacyConcatMode` 重叠。`collectMappingDraftFromTable` 中 `legacyConcatMode` 分支只在 `firstValue` 为空 + `dataset.legacyConcatMode === 'true'` 时触发，新行的 `select.value` 可能为空但 `dataset.legacyConcatMode` 不会被设置（new field 不进入 concat 模式），无误触发。

### 9.3 PR #14 `dateFormat` 保存路径

如 §1.1.6 所述，`saveMappings` 签名 `(db, templateId, mappings, bigAccounts, fixedAssignments, dateFormat)` 不变，第 7 参数 `amountSplitRules` 默认 `null`。`UPDATE templates ... date_format` 仍是事务最后一步。`template_amount_split_rules` 的 DELETE+INSERT 放在 `UPDATE templates` 之前，不互相影响。

### 9.4 三方互斥校验回退路径

- 已存在的三种情形（仅 direct / 仅 signed / direct+signed 报错）行为完全不变。
- 新引入的"开关 = 是"行为只会在用户主动启用后生效。
- 如果用户保存时校验失败，外层 `createMappingDialog` 会通过 `createAlertDialog.onConfirm` 重新打开（现有逻辑），用户的草稿保留（`payload.mappings = mappings` 重新传入）。
- 如果用户曾经在 v1.4.7 模板里配过 direct + signed（不可能，因为旧版本就有互斥校验），新版本继续拒绝。

### 9.5 `amountMappingRules` 传透回归

- `buildStatementGenerationConfig` 已经返回 `amountMappingRules`，新增 `amountSplitByField` 子字段后，老的 `nameSourceField` / `accountSourceField` / `signedAmountSourceField` 字段不变。
- `buildMappedRowsForFile` 直接透传整个 `amountMappingRules`，无需修改。
- `buildMappedRows` 在新分支被 enabled 时跳过 directAmount / signedAmount 计算，但只在 `amountSplitConfig.enabled === true` 时才走新分支，旧路径完全保留。

### 9.6 Bundle 兼容

- 新版 app 打开旧 bundle (`bundleVersion = 1` 或缺字段) → `amountSplitRules` 默认 `[]` → 不影响（AC1-21 ✓）。
- 新版 app 打开新 bundle (`bundleVersion = 2`) → 正常解析（AC1-19 ✓）。
- 新版 app 打开未来 bundle (`bundleVersion ≥ 3`) → `readTemplateBundleFile` 报错拒绝（代码已就位，运行时本版本不会触发，留给 v1.4.9+ 实际生效）。
- 旧版 app（v1.4.7 及以下）打开新 bundle → **本版本无法报错**，是 known limitation。详见 §6.2.1，决策为方案 C：接受现状，release note 提示老用户升级。**AC1-20 不在本版本测试范围**。

---

## 十、Open Technical Questions（已全部决策 2026-04-07）

### 10.1 [BLOCKING for AC1-20] 旧版 app 打开新 bundle 的"报错拒绝"语义

**问题：** PRD §3.3.3 + AC1-20 要求"旧版本应用打开新版本导出的 bundle 时报错拒绝，提示『bundle 来自更高版本的 app，请升级』"。

**技术现状：**
- v1.4.7 及以下版本的 `readTemplateBundleFile` 不读 `bundleVersion`，遇到新字段会静默忽略，不会报错。
- v1.4.8 输出的新字段 `amountSplitRules` 旧版 app 解析时会被丢弃，但解析过程不会失败 → 旧版 app 把它当合法 v1 bundle 导入，结果是丢失新字段 → 用户在旧版 app 中看不到「按字段区分发生额」配置 → 静默数据降级，违反 AC1-20。

**Dev 提出的方案：**

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A | v1.4.8 bundle 顶层把 `templates` 改名为 `templates_v2`，同时保留 `templates: []` 占位 | 旧版 app 看到 `templates: 0`，导入 0 条；不破坏数据 | hacky；不报错而是"什么都没导入"，用户可能困惑 |
| B | 同时发布 v1.4.7 hotfix（v1.4.7.1）补一个 `bundleVersion ≥ 2` 拒绝逻辑，再发 v1.4.8 | 干净 | 需要额外发版 + 用户必须升级到 hotfix 才有效 |
| C | 本版本只为 v1.4.9+ 准备 `bundleVersion` 校验机制（v1.4.8 接受 `≤ 2`），AC1-20 在 v1.4.7→v1.4.8 方向暂时无法满足，明确写进 release note | 简单 | 与 PRD AC1-20 部分不符 |
| D | 本次跳过 `amountSplitRules` 字段的 bundle 导出（仅本地 DB），AC1-19 同时降级 | 完全规避兼容性问题 | 与 PRD AC1-19 不符 |

✅ **决策（2026-04-07）：选择方案 C（妥协方案）**
- AC1-20 在 v1.4.7→v1.4.8 方向**本版本不满足**，标记为 known limitation。
- v1.4.8 在 bundle 顶层写入 `bundleVersion = 2`（必做），并在每个 template entry 中写入 `amountSplitRules` 字段（必做）。
- v1.4.8 自身的 `readTemplateBundleFile` 加入 `bundleVersion > SUPPORTED_BUNDLE_VERSION` 拒绝逻辑（必做）。本版本 `SUPPORTED_BUNDLE_VERSION = 2`，因此这段校验在本版本运行时永远不会触发，仅作为 v1.4.9+ 的预埋。
- v1.4.9+ 发布时即可读取 v1.4.8 写入的 `bundleVersion`，正确拒绝来自 ≥ v1.4.9 的 bundle。
- v1.4.7 老用户由 release note 明确提示升级。
- **不发 v1.4.7.1 hotfix。**
- 测试影响：AC1-20 不在本版本测试范围。AC1-19 仍然测试，验收时确认 bundle JSON 顶层包含 `bundleVersion: 2` 字段。
- 详见 §6.2.1 + §6.2.2 + §9.6。

### 10.2 [非 blocking] 弹框规则的 "落库后立即生效" vs "外层取消则回滚"

**问题：** PRD §3.2 "完成按钮语义" 说"点击『完成』直接落库到 DB（不走外层对话框的草稿模式）"，"外层『映射关系管理』对话框的『完成』/『取消』/『关闭』均不影响弹框中已落库的配置"。

**技术现状：** 这意味着用户在弹框点完成后，规则立即写入 DB。如果之后用户在外层映射对话框点"取消"或"关闭"，弹框规则**不会**被回滚 —— 但外层映射设置（包括"按字段区分发生额"开关）会回滚到原值。

**潜在 inconsistency：** 用户可能进入这样的状态：
- 外层下拉框 = 空（因为外层"取消"恢复原状）；
- DB 中 `template_amount_split_rules` 有 2 行有效规则（弹框已落库）。

下次用户打开映射对话框时，外层显示空（开关关闭），但弹框草稿仍能回显规则（PRD §3.3.4 "草稿跟着模板走、跟外层下拉框状态无关"）。

**Dev 评估：** 此行为完全符合 PRD 的"草稿独立"原则。

✅ **决策（2026-04-07）：采纳 Dev 建议，接受孤儿态**
- 完全符合 PRD §3.3.4 草稿独立原则，不做特殊清理逻辑。
- §3.4 已经把 `saveMappings` 的 `amountSplitRules` 默认参数设为 `null`（"不传不动"），避免 `template:save-mappings` 误删规则。
- 实施时不需要任何额外清理代码。

### 10.3 [非 blocking] 正则解析是否应该统一到一个 service？

**问题：** §5.3.2 + §7.2.1 让 main 进程和 renderer 进程各自维护一份 `looksLikeRegexLiteral` / `parseRegexLiteral`。两份代码很短，但有同步风险。

**Dev 选项：**
- A. 各写一份（当前方案）。简单，但有同步风险。
- B. 把它放进 `assets/` 或 `src/shared/` 目录，让 main 和 renderer 都能 require。需要新增"shared module"概念（项目当前没有）。
- C. 通过 IPC 让 renderer 调用 main 的解析函数。但解析需要在用户敲键盘时即时反馈，IPC 延迟不可接受。

✅ **决策（2026-04-07）：采纳 Dev 建议，选择方案 A**
- main 进程和 renderer 各写一份 `looksLikeRegexLiteral` / `parseRegexLiteral`。
- **不引入 `src/shared/` 公共模块**，避免给项目引入新架构约定。
- 两份实现之间必须加 cross-reference 注释提醒同步。推荐注释文案：
  ```javascript
  // 同步修改：另一份实现位于 src/renderer-dialogs.js 内 createRendererDialogs，两份必须保持行为一致
  function looksLikeRegexLiteral(value) { ... }
  ```
  和：
  ```javascript
  // 同步修改：另一份实现位于 src/backend/file-service/normalizers.js，两份必须保持行为一致
  function looksLikeRegexLiteral(value) { ... }
  ```
- 详见 §5.3.2（main 进程版本）+ §7.2.1（renderer 进程版本）。

### 10.4 [非 blocking] `validateTemplateConfiguration` 在新字段下的"无效非空 mappedField" 校验

**问题：** `validateTemplateConfiguration` 现有逻辑会把 `mappedField` 当源字段名校验是否在 `sourceFieldSet` 中。新字段 `mappedField = '是'` 不是源字段名，§5.1.2 给出了一个早期 return 分支让它跳过校验。

**潜在 risk：** 如果未来又新增类似的"开关字段"（mappedField 是预定义枚举而非源字段名），需要类似的 早期 return。是否值得引入一个 `NON_SOURCE_FIELD_MAPPINGS` 常量集合？

✅ **决策（2026-04-07）：采纳 Dev 建议，YAGNI**
- 本次**不引入** `NON_SOURCE_FIELD_MAPPINGS` 常量集合。
- 仅给「按字段区分发生额」一个 early return 分支（即 §5.1.2 的实现），形式为：
  ```javascript
  if (targetField === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD) {
    // 跳过普通源字段校验，按"开关字段"语义处理
    ...
    return;
  }
  ```
- 如果未来再增加同类字段，再做抽象。

---

## 十一、分阶段实施建议

| 步骤 | 内容 | 涉及文件 | smoke test |
|------|------|---------|-----------|
| 1 | 新增 migration 函数 + 注册 + 跑一次空 migration | `src/backend/database/migrations.js`, `src/backend/database.js` | 启动 app，确认 SQLite 中存在 `template_amount_split_rules` 表 |
| 2 | 新增 repository 方法 `getAmountSplitRules` / `saveAmountSplitRules` | `src/backend/database/template-repository.js`, `src/backend/database.js` | 开 Node REPL，对一个测试模板插入/读取 2 行规则 |
| 3 | 扩展 `getTemplateMappings` / `listTemplateBundleEntries` 包含新字段 | 同上 | 调用 `database.getTemplateMappings(id)` 检查 `amountSplitRules` 字段存在 |
| 4 | 新增常量 + 扩展 `ADVANCED_MAPPING_FIELDS` + `validateTemplateConfiguration` 早期 return 分支 + 三方互斥校验 | `src/main.js` | 构造一个 mappings payload 含新字段，调 `validateTemplateConfiguration`，确认通过；构造一个三方都填的 payload，确认报互斥错 |
| 5 | 新增 IPC handler `template:get-amount-split-rules` / `template:save-amount-split-rules` + `validateAmountSplitRulesPayload` + 正则辅助函数 | `src/main.js`, `src/backend/file-service/normalizers.js`, `src/preload.js` | 用 DevTools console 调 `desktopApi.templates.saveAmountSplitRules({...})` 校验各种合法/非法 payload |
| 6 | 扩展 `template:get-mappings` / `template:save-mappings` handler + `getTemplateMappingConfig` 返回 `amountSplitRules` + "开关-规则一致性"校验 | `src/main.js` | 在外层映射对话框打开/保存，确认开关行存在；构造"开关=是 但 rules 为空"，确认报错 |
| 7 | 前端 `createMappingDialog` 新增行 + 互斥处理 + 按钮挂载 + `applyAmountSplitMutualExclusion` | `src/renderer-dialogs.js`, `src/styles.css` | 打开映射对话框，切换新行下拉框，确认 Credit/Debit/Signed 三行 disabled + 按钮显示/隐藏 |
| 8 | 新增 `createAmountSplitRulesDialog` 弹框 + 校验 + 直接落库 | `src/renderer-dialogs.js`, `src/styles.css` | 完整流程：打开外层 → 选"是" → 点按钮 → 填两行规则 → 完成 → SQLite 中确认规则已写入 |
| 9 | 扩展 `buildStatementGenerationConfig` + `buildMappedRows` 加入新分支（含 `matchAmountSplitConditionValue` 调用） | `src/main.js`, `src/backend/file-service.js`, `src/backend/file-service/normalizers.js` | 构造一个测试 CSV（如 `AMOUNT, TXN_TYPE` 列），导入并确认 Credit/Debit 列符合规则 |
| 10 | "全部未命中"告警实现 | `src/main.js` | 故意把规则配错（如 `conditionValue = 'XYZ'`），导入后确认弹告警，导出文件 Credit/Debit 全空 |
| 11 | Bundle 导出/导入扩展（`buildTemplateLibraryPayload` bumpVersion，`readTemplateBundleFile` 校验 + amountSplitRules 字段，import 路径调用 `saveMappings(amountSplitRules)`） | `src/main.js`, `src/backend/database/template-repository.js` | 导出 bundle 检查 JSON 中包含 `bundleVersion: 2` + `amountSplitRules`；导入旧 bundle 确认默认值；构造 `bundleVersion: 99` 的 bundle 确认报错 |
| 12 | `package.json` 版本号升至 `1.4.8` | `package.json` | `npm start` 后看左下角版本号 |
| 13 | 全量回归 smoke test：旧模板打开 + 现有 direct/signed 模式导入 + 新模板按字段区分模式导入 | 全部 | 全部通过 |

---

## 十二、版本号变更

```json
// package.json
"version": "1.4.8"
```

---

## 十三、修订记录

| 日期 | 修订内容 | 作者 |
|------|---------|------|
| 2026-04-07 | 初版生成，对齐 PRD-v1.4.8.md 全部 21 个 §3 细节和 34 条 AC | dev |
| 2026-04-07 | 根据用户决策关闭 4 个 Open Technical Questions（Q1=C 预埋 bundleVersion、Q2 接受孤儿态、Q3 正则解析各一份、Q4 不抽 NON_SOURCE_FIELD_MAPPINGS）| dev |
| 2026-04-07 | 根据用户 Q-T1/Q-T2 决策更新 TechDoc：§8.2 导入告警改为"按文件独立判定 + 聚合列表"模式；§5.1.3 加 PRD AC1-28b 交叉引用 | dev |
