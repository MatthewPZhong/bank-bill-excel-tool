# TechDoc - 网银账单小助手 v1.5.1

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.1 |
| 日期 | 2026-04-12 |
| 作者 | Dev |
| 状态 | 已实施（Reverse Sync） |
| 关联 PRD | `docs/iterations/v1.5.1/PRD-v1.5.1.md`（已实施，48 条 AC：AC1-1~AC1-12 + AC2-1~AC2-18 + AC3-1 + AC4-1~AC4-8 + AC5-1~AC5-9） |
| 依赖 | v1.5.0 已 merged 到 main，v1.5.1 从 v1.5.x 起分支 |

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 主/子模板 | `templates` 表新增 `parent_template_id` 列（nullable FK），幂等迁移。映射关系管理页面 dialog-header 新增两个 checkbox。模板管理页面增展开/折叠。主页面下拉框过滤子模板。文件导入时按 headers 自动匹配子模板。技术可行，工作量中等。 |
| §5.2 账户映射改动 | `account_mappings` 表新增 `template_id` 列（NOT NULL FK）。需数据迁移处理现有记录。前端新增模板下拉框、文案变更、编辑/完成切换交互。技术可行。 |
| §5.3 模板管理标题 | 纯 HTML 修改，无技术阻碍。 |
| §5.4 Bundle v4 | `SUPPORTED_BUNDLE_VERSION` 升至 4。导出新增 `parentTemplateKey` + `accountMappings` 字段。导入新增还原逻辑。v3 向下兼容。技术可行。 |
| §5.5 重复判定增强 | `resolveImportFileSelection` 扩展三维度判重 + `crypto.createHash('sha256')` 计算文件哈希。移除「保留两份」按钮。技术可行。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | §5.2 `account_mappings` 数据迁移：现有记录无 `template_id`，且 `bank_account_id` 有 UNIQUE 约束。新增 `template_id` 后需改为 `UNIQUE(template_id, bank_account_id)` 联合唯一。SQLite 不支持 `ALTER TABLE ... DROP CONSTRAINT`，需通过重建表实现。 | TechDoc §四 详细设计迁移方案。 |
| R-2 | §5.1 文件导入自动匹配子模板：当前 `file:import` handler 接收 `templateId` 后直接取该模板配置解析文件。引入主/子模板后，选择主模板导入时需先读取文件 headers，与主模板及所有子模板的 `headers_json` 比对，选出匹配的模板再解析。匹配失败需返回错误。 | TechDoc §三 详细设计。 |
| R-3 | §5.5 文件内容哈希：对于大文件（如 50MB+ 的 Excel），`fs.readFileSync` 全量读入内存计算 SHA-256 可能造成短暂卡顿。但考虑到 Electron 主进程已经在同步读取文件解析，额外哈希计算的增量开销可接受。 | 直接实现，不做异步优化。 |
| R-4 | §5.2 账户映射按模板隔离后，现有 `file:import` 中的 `database.listAccountMappings()` 调用（`main.js:4430`）需改为按 templateId 查询。 | TechDoc §四 详细设计。 |

### 1.3 与 PRD 的差异（Reverse Sync 后更新）

实施过程中产生以下与 PRD 初稿的差异，已通过 Reverse Sync 回写到 PRD：

| 编号 | 差异 | 处理 |
|------|------|------|
| D-1 | 账户映射缺失时不再截断导入（移除截断检查） | PRD §5.2 第 4 条和 P1-11 已更新 |
| D-2 | 新增迁移分配对话框（`account_mapping_migration_pending` flag + 分配 UI） | PRD §5.2 第 7 条、AC2-16 已补充 |
| D-3 | 新增币种 tooltip ⓘ 说明 | PRD §5.2 第 5 条、AC2-13 已补充 |
| D-4 | 「有账户号无币种」checkbox 改为自动检测 | PRD §5.2 第 6 条、AC2-14 已补充 |
| D-5 | 编辑/完成按钮左对齐 | PRD §5.2 第 3 条补充、AC2-15 已补充 |
| D-6 | 新增多币种桥接提醒 | PRD §5.2 第 8 条、AC2-17 已补充 |
| D-7 | 账户映射模板下拉框含子模板 | PRD §5.2 第 9 条、AC2-18 已补充 |
| D-8 | 主模板导入子模板文件后需重建 rows（`rebuildMatchedTemplateFileEntries`）以传入 `selectedBigAccount` | TechDoc §三 补充 |

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/database/migrations.js` | 修改 | 新增 `ensureParentTemplateSupport` + `ensureAccountMappingTemplateSupport` 迁移函数 |
| `src/backend/database/template-repository.js` | 修改 | `listTemplates` 新增 `parent_template_id` 返回；新增 `listChildTemplates(db, parentId)` 查询；`listTemplateBundleEntries` 追加 `parentTemplateKey` + `accountMappings` |
| `src/backend/database/settings-repository.js` | 修改 | `listAccountMappings` / `saveAccountMappings` 新增 `templateId` 参数 |
| `src/backend/database.js` | 修改 | 透传新增参数；注册新迁移函数；`listAccountMappings(templateId)` / `saveAccountMappings(templateId, mappings)` |
| `src/main.js` | 修改 | `SUPPORTED_BUNDLE_VERSION` 4；`buildTemplateLibraryPayload` 追加子模板+账户映射；`readTemplateBundleFile` 解析 v4 格式；`file:import` handler 增主/子模板匹配逻辑；`resolveImportFileSelection` 三维度判重；`registerAccountMappingHandlers` 增 templateId |
| `src/preload.js` | 修改 | `accountMappings.list(templateId)` / `accountMappings.save(templateId, mappings)` |
| `src/renderer-dialogs.js` | 修改 | `createMappingDialog` header 新增主/子勾选框；`createTemplateManagerDialog` 新增标题+展开/折叠；`createAccountMappingDialog` 新增模板下拉框+文案变更+编辑/完成切换+币种 tooltip+noCurrency 自动检测；新增 `createAccountMappingMigrationDialog` 迁移分配对话框 |
| `src/renderer.js` | 修改 | `updateTemplateSelect()` 过滤子模板；打开账户映射时检查 `account_mapping_migration_pending` flag |
| `src/styles.css` | 修改 | 新增主/子模板展开/折叠样式、账户映射编辑/完成切换样式、币种 tooltip 样式（`z-index: 9999`）、action-cell 左对齐 |
| `package.json` | 修改 | version 升为 `1.5.1` |

---

## 三、需求 1：主/子模板

### 3.1 实现方案

#### 3.1.1 数据库 — `templates` 表新增 `parent_template_id`

新增幂等迁移函数 `ensureParentTemplateSupport`（`migrations.js`）：

```javascript
function ensureParentTemplateSupport(db) {
  if (!hasColumn(db, 'templates', 'parent_template_id')) {
    db.exec('ALTER TABLE templates ADD COLUMN parent_template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL;');
  }
}
```

- `parent_template_id` 为 NULL 表示普通模板或主模板。
- `parent_template_id` 指向某个 `templates.id` 表示该模板为子模板。
- 判断是否为主模板：`parent_template_id IS NULL` 且存在至少一个子模板（`SELECT COUNT(1) FROM templates WHERE parent_template_id = ?`）。或者使用标记字段（后续讨论）。

**设计决策 — 是否需要 `is_parent` 标记列**：

PRD 中「设为主模板」是用户手动勾选的，并非自动推断。因此需要一个显式标记来区分"普通模板"和"主模板"（两者的 `parent_template_id` 都为 NULL）。建议新增 `is_parent INTEGER NOT NULL DEFAULT 0` 列：

```javascript
function ensureParentTemplateSupport(db) {
  if (!hasColumn(db, 'templates', 'parent_template_id')) {
    db.exec('ALTER TABLE templates ADD COLUMN parent_template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL;');
  }
  if (!hasColumn(db, 'templates', 'is_parent')) {
    db.exec('ALTER TABLE templates ADD COLUMN is_parent INTEGER NOT NULL DEFAULT 0;');
  }
}
```

#### 3.1.2 查询子模板

`template-repository.js` 新增：

```javascript
function listChildTemplates(db, parentTemplateId) {
  return db.prepare(`
    SELECT id, template_key AS templateKey, name, source_file_name AS sourceFileName,
           headers_json AS headersJson, created_at AS createdAt, updated_at AS updatedAt
    FROM templates
    WHERE parent_template_id = ?
    ORDER BY id ASC
  `).all(parentTemplateId).map((row) => ({
    ...row,
    headers: JSON.parse(row.headersJson || '[]')
  }));
}
```

#### 3.1.3 设置主/子模板 — IPC

新增或扩展 IPC handler：

- `template:set-parent-status`：设置 `is_parent` = 1/0。取消主模板时若有子模板，需先将子模板的 `parent_template_id` 置 NULL。
- `template:set-child-parent`：设置 `parent_template_id`。同时将自身 `is_parent` 置 0（互斥）。取消子模板身份时置 `parent_template_id` = NULL。

#### 3.1.4 主页面模板下拉框过滤

`src/renderer.js:1610` `updateTemplateSelect()` 修改：

```javascript
state.templates
  .filter((template) => !template.parentTemplateId)  // 过滤子模板
  .forEach((template) => {
    const option = document.createElement('option');
    option.value = String(template.id);
    option.textContent = template.name;
    elements.templateSelect.appendChild(option);
  });
```

需要 `listTemplates` 返回 `parentTemplateId` 字段。

#### 3.1.5 文件导入自动匹配子模板

`file:import` handler 中，当 `templateId` 指向主模板时（`is_parent = 1`）：

1. 获取主模板 + 所有子模板的 headers 列表。
2. 对每个导入文件，读取文件 headers（已有逻辑在 `readers.js` 的 `readWorkbookRows` 返回值中）。
3. 比对文件 headers 与模板 headers，匹配规则：**精确匹配（集合相等）**——文件 headers 经 `normalizeCell` 规范化后的集合必须与模板 headers 集合完全一致（顺序无关，但元素必须一一对应），不是"包含"关系。
4. 精确匹配到主模板 → 用主模板配置解析；精确匹配到子模板 → 用子模板配置解析；匹配到多个模板（理论上不应发生，属于配置问题）→ 报错提示；都不匹配 → 返回错误。

```
导入文件 A → headers 匹配 → 主模板
导入文件 B → headers 匹配 → 子模板 1
导入文件 C → headers 匹配 → 子模板 2
导入文件 D → headers 不匹配 → 报错
```

**注意**：每个文件可能匹配到不同的模板，因此需要按文件粒度分别获取 `templateConfig`。当前 `file:import` 只取一次 `getTemplateMappingConfig(templateId)`，需改为循环每个文件独立获取。

**账户映射缺失时截断导入（已确认）**：文件匹配到某个（子）模板后，立即检查该模板是否有账户映射记录（`database.listAccountMappings(matchedTemplateId).length > 0`）。若为空，**直接截断本次导入**，返回错误：

```javascript
return createErrorResult({
  step: '导入网银明细文件',
  message: '相关模板无任何映射关系，请配置相关模板的账户映射关系',
  errorCode: 'ACCOUNT_MAPPING_MISSING',
  context: { templateId: matchedTemplateId, templateName: matchedTemplate.name }
});
```

不弹出账户映射页面、不继续处理其余文件。

### 3.2 改动点

| 文件 | 行号（约） | 改动内容 |
|------|-----------|---------|
| `src/backend/database/migrations.js` | 新增 | `ensureParentTemplateSupport` 函数 |
| `src/backend/database.js` | :92 附近 | 调用 `this.ensureParentTemplateSupport()` |
| `src/backend/database/template-repository.js` | :9 `listTemplates` | SELECT 新增 `t.parent_template_id AS parentTemplateId, t.is_parent AS isParent` |
| `src/backend/database/template-repository.js` | 新增 | `listChildTemplates(db, parentId)` 函数 |
| `src/backend/database/template-repository.js` | :758 `listTemplateBundleEntries` | 每个 entry 新增 `parentTemplateKey`、`isParent` 字段 |
| `src/main.js` | :5399 `file:import` handler | 主模板时：读取子模板列表 → 按文件 headers 匹配 → 分别获取 templateConfig |
| `src/renderer-dialogs.js` | :1807 `createMappingDialog` dialog-header | 新增「设为主模板」「设为子模板」checkbox + 主模板下拉框 |
| `src/renderer-dialogs.js` | :1695 `createTemplateManagerDialog` | 模板行增展开/折叠按钮，子模板缩进显示 |
| `src/renderer.js` | :1619 `updateTemplateSelect` | 增 `.filter((t) => !t.parentTemplateId)` |
| `src/preload.js` | 新增 | `templates.setParentStatus` / `templates.setChildParent` IPC |

### 3.3 注意事项

- 主模板删除时，子模板的 `parent_template_id` 通过 `ON DELETE SET NULL` 自动置 NULL，`is_parent` 无需处理。
- 子模板删除时不影响主模板。
- 文件 headers 匹配为**精确匹配（集合相等）**，顺序无关，大小写/空白通过 `normalizeCell` 规范化后比对。
- 如果一个文件精确匹配到多个模板（即两个模板的 headers 完全相同，属于配置问题），报错提示用户检查模板配置。不做模糊匹配、不做匹配度排序。

### 3.4 实施补充 — `rebuildMatchedTemplateFileEntries`（Reverse Sync）

**问题**：主模板导入子模板文件时，provisional rows 在 `selectedBigAccount` 未确定前构建（`main.js:5957`，`allowManagedMerchantWithoutSelection: true`），导致 MerchantId 为 `__MULTI_BIG_ACCOUNT__` 标记值而非实际账号。

**修复**：新增 `rebuildMatchedTemplateFileEntries`（`main.js:613-653`），在大账号选定后**重建 detailRows**：

```javascript
function rebuildMatchedTemplateFileEntries({ fileEntries, fallbackTemplateConfig, selectedBigAccount }) {
  return fileEntries.map((entry) => {
    const entryTemplateConfig = getEntryTemplateConfig({ entry, fallbackTemplateConfig, cache });
    const config = buildStatementGenerationConfig({
      ...entryTemplateConfig,
      selectedBigAccount,           // ← 传入已选定的大账号
      allowManagedMerchantWithoutSelection: true
    });
    return {
      filePath: entry.filePath,
      detailRows: buildMappedRowsForFile({ config, inputFilePath: entry.filePath }),  // 重建
      ...
    };
  });
}
```

**调用点**：`main.js:6430`，在 `selectionResult.parentProvisionalEntries` 存在时调用，确保导出数据中 MerchantId 正确。

### 3.5 实施补充 — 新增辅助函数（Reverse Sync）

| 函数 | 位置 | 作用 |
|------|------|------|
| `matchFileToTemplate(filePath, candidateTemplates)` | `main.js:5240` | 遍历候选模板，用 `readRowsWithMetadata` 尝试匹配，返回匹配到的模板列表 |
| `resolveGenerationTemplateConfig({ fileEntries, fallbackTemplateConfig })` | `main.js:596` | 当所有文件匹配到同一个子模板时，返回该子模板配置；否则返回父模板配置 |
| `getEntryTemplateConfig({ entry, fallbackTemplateConfig, cache })` | `main.js:579` | 根据 `matchedTemplateId` 获取对应模板配置，带缓存 |

---

## 四、需求 2：账户映射页面改动

### 4.1 实现方案

#### 4.1.1 数据库 — `account_mappings` 表新增 `template_id`

由于 SQLite 不支持 `ALTER TABLE DROP CONSTRAINT`，且现有 `bank_account_id` 有 `UNIQUE` 约束需改为 `UNIQUE(template_id, bank_account_id)`，需通过**重建表**方式迁移。

新增幂等迁移函数 `ensureAccountMappingTemplateSupport`（`migrations.js`）：

```javascript
function ensureAccountMappingTemplateSupport(db) {
  if (hasColumn(db, 'account_mappings', 'template_id')) {
    return; // 已迁移
  }

  db.exec('BEGIN');
  try {
    // 1. 重命名旧表
    db.exec('ALTER TABLE account_mappings RENAME TO account_mappings_old;');

    // 2. 创建新表（含 template_id，联合唯一约束）
    db.exec(`
      CREATE TABLE account_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        bank_account_id TEXT NOT NULL,
        clearing_account_id TEXT NOT NULL,
        no_currency INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT '',
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, bank_account_id)
      );
    `);

    // 3. 数据迁移（方案 B：复制给每个模板）
    const templates = db.prepare('SELECT id FROM templates').all();
    if (templates.length > 0) {
      const insertStmt = db.prepare(`
        INSERT INTO account_mappings
          (template_id, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at)
        SELECT
          ?, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at
        FROM account_mappings_old
      `);
      templates.forEach((t) => {
        insertStmt.run(t.id);
      });
    }
    // 无模板时旧数据丢弃（无模板则无法关联）

    // 4. 删除旧表
    db.exec('DROP TABLE account_mappings_old;');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

> **数据迁移策略（已确认方案 B）**：现有记录复制给每个已有模板。遍历所有 `templates` 记录，为每个模板各执行一次 INSERT，将旧 `account_mappings_old` 全量复制。

#### 4.1.2 Repository 改造

`settings-repository.js`：

```javascript
function listAccountMappings(db, templateId) {
  return db
    .prepare(`
      SELECT id, bank_account_id AS bankAccountId, clearing_account_id AS clearingAccountId,
             no_currency AS noCurrency, currency, row_index AS rowIndex
      FROM account_mappings
      WHERE template_id = ?
      ORDER BY row_index ASC, id ASC
    `)
    .all(templateId);
}

function saveAccountMappings(db, templateId, mappings) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM account_mappings WHERE template_id = ?').run(templateId);
    const stmt = db.prepare(`
      INSERT INTO account_mappings
        (template_id, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    mappings.forEach((m, i) => {
      stmt.run(templateId, m.bankAccountId, m.clearingAccountId, m.noCurrency ? 1 : 0, m.currency || '', i, now, now);
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

#### 4.1.3 IPC 改造

`main.js` 中 `registerAccountMappingHandlers`：

- `account-mapping:list`：接收 `templateId` 参数，调用 `database.listAccountMappings(templateId)`。
- `account-mapping:save`：接收 `(templateId, mappings)` 参数。

`preload.js`：

```javascript
accountMappings: {
  list: (templateId) => ipcRenderer.invoke('account-mapping:list', templateId),
  save: (templateId, mappings) => ipcRenderer.invoke('account-mapping:save', templateId, mappings)
}
```

#### 4.1.4 文件导入时查账户映射

`main.js:4430` 现有代码：

```javascript
const accountMappingByBankId = database.listAccountMappings().reduce(...)
```

改为：

```javascript
const accountMappingByBankId = database.listAccountMappings(template.id).reduce(...)
```

其中 `template.id` 为当前文件匹配到的模板（可能是主模板或子模板）。

#### 4.1.5 前端 — 账户映射页面

`createAccountMappingDialog`（`renderer-dialogs.js:3958`）改动：

1. **模板下拉框**：dialog-header 新增 `<select>` 元素，options 从 `payload.templates` 生成，默认选中 `payload.currentTemplateId`。切换时重新调用 `desktopApi.accountMappings.list(templateId)` 刷新表格。

2. **表头文案**：
   - `网银大账号ID` → `网银账单账户号`
   - `清结算系统大账号ID` → `清结算系统银行账号`

3. **执行操作列**：新增 `<th>执行操作</th>`。每行新增 `<td>` 含「编辑」「删除」按钮。

4. **编辑/完成切换**：
   - 已保存行：文本 `<span>` 显示，「编辑」按钮。
   - 编辑状态：`<input>` 输入框，「完成」按钮。
   - 新增行默认编辑状态。

### 4.2 改动点

| 文件 | 行号（约） | 改动内容 |
|------|-----------|---------|
| `src/backend/database/migrations.js` | 新增 | `ensureAccountMappingTemplateSupport` 函数（重建表迁移） |
| `src/backend/database.js` | :92 附近 | 调用 `this.ensureAccountMappingTemplateSupport()` |
| `src/backend/database.js` | :265-270 | `listAccountMappings(templateId)` / `saveAccountMappings(templateId, mappings)` |
| `src/backend/database/settings-repository.js` | :62-108 | 两个函数新增 `templateId` 参数 |
| `src/main.js` | :2753-2787 `registerAccountMappingHandlers` | IPC handler 接收 `templateId` |
| `src/main.js` | :4430 | `listAccountMappings(template.id)` |
| `src/preload.js` | :17-19 | API 签名变更 |
| `src/renderer-dialogs.js` | :3958-4127 `createAccountMappingDialog` | 模板下拉框 + 文案变更 + 执行操作列 + 编辑/完成交互 |

### 4.3 注意事项

- **迁移风险**：重建表操作在事务内执行。如果中途失败，ROLLBACK 恢复。但迁移成功后无法回退到旧 schema（除非用户回退到旧版本的数据库文件）。
- `bank_account_id` 的 UNIQUE 约束变更：从全局唯一改为 `(template_id, bank_account_id)` 联合唯一，允许不同模板有相同的 bank_account_id。
- 迁移顺序：`ensureParentTemplateSupport` 必须在 `ensureAccountMappingTemplateSupport` 之前执行（后者依赖 `templates` 表已有数据）。

### 4.4 实施补充 — 新增功能（Reverse Sync）

#### 4.4.1 迁移分配对话框

迁移后多模板场景下旧记录被复制给每个模板。首次打开账户映射时检查 `account_mapping_migration_pending` flag：

- **IPC**：`account-mapping:check-migration-pending`（`main.js:2935`）读取 flag。
- **Renderer**：`renderer.js:2614-2633` 检测 flag → 弹 `createAccountMappingMigrationDialog`（`renderer-dialogs.js:4409-4498`）引导用户分配。
- **清除 flag**：分配完成后 `main.js:2998` 置 `'false'`。

#### 4.4.2 币种 tooltip

`renderer-dialogs.js:4146`：币种表头新增 `<span class="currency-tooltip-wrap">` + ⓘ 图标 + tooltip 文本。
`styles.css:2221-2260`：`z-index: 9999` + `position: absolute` + hover 触发 `display: block`。

#### 4.4.3 noCurrency 自动检测

移除 UI checkbox。`renderer-dialogs.js:4250`：`getNoCurrency: () => currencyInput.value.trim() !== ''`。
币种字段有值时 `noCurrency = true`（自动启用），无需用户手动勾选。

#### 4.4.4 编辑/完成按钮左对齐

`styles.css:2301-2310`：`.account-mapping-action-cell { text-align: left }` + `button:first-child { margin-left: 0 }`。

#### 4.4.5 多币种桥接提醒

`main.js:6924-6930`：`file:extract-big-account-order` handler 检测 bridge match + 多币种 → `ambiguousCurrencyFiles`。
`renderer-dialogs.js:1091-1098`：弹 alert 显示受影响文件列表。

#### 4.4.6 账户映射模板下拉框含子模板

`renderer.js:2649`：传 `state.templates`（全量列表，含子模板）。
`renderer-dialogs.js:4162-4170`：遍历所有模板渲染 option，不过滤子模板。

#### 4.4.7 账户映射缺失不阻断导入

移除 TechDoc §3.1.5 中描述的截断逻辑。导入时不再检查子模板是否有账户映射记录。

---

## 五、需求 3：模板管理页面标题

### 5.1 实现方案

`createTemplateManagerDialog`（`renderer-dialogs.js:1695`）的 dialog-header 修改：

当前（行 1700-1702）：
```html
<div class="dialog-header compact">
  <button class="icon-close" type="button">×</button>
</div>
```

改为：
```html
<div class="dialog-header compact">
  <div class="dialog-title">模板管理</div>
  <button class="icon-close" type="button">×</button>
</div>
```

### 5.2 改动点

| 文件 | 行号（约） | 改动内容 |
|------|-----------|---------|
| `src/renderer-dialogs.js` | :1700 | dialog-header 新增 `<div class="dialog-title">模板管理</div>` |

### 5.3 注意事项

无。纯 UI 文本修改。

---

## 六、需求 4：模板导出/导入增强

### 6.1 实现方案

#### 6.1.1 Bundle 版本升级

`main.js:116`：

```javascript
const SUPPORTED_BUNDLE_VERSION = 4;
```

#### 6.1.2 导出增强

`buildTemplateLibraryPayload`（`main.js:1040`）：

当前 `listTemplateBundleEntries` 返回每个模板的数据。需增加：

1. **`parentTemplateKey`**：子模板的 `parentTemplateKey` 指向主模板的 `templateKey`。主模板和普通模板为 `null`。
2. **`isParent`**：布尔值，标记是否为主模板。
3. **`accountMappings`**：该模板的账户映射列表（从 `database.listAccountMappings(template.id)` 获取）。

`listTemplateBundleEntries`（`template-repository.js:758`）改动：

```javascript
// 每个 entry 新增字段
const template = getTemplate(db, ...);
entry.isParent = Boolean(template.isParent);
entry.parentTemplateKey = template.parentTemplateId
  ? getTemplate(db, template.parentTemplateId)?.templateKey || null
  : null;
```

`buildTemplateLibraryPayload`（`main.js:1040`）改动：

```javascript
entry.accountMappings = database.listAccountMappings(template.id).map((m) => ({
  bankAccountId: m.bankAccountId,
  clearingAccountId: m.clearingAccountId,
  noCurrency: Boolean(m.noCurrency),
  currency: m.currency
}));
```

#### 6.1.3 导入增强

`readTemplateBundleFile`（`main.js:1074`）：

- v4 bundle 的每个 template item 新增 `parentTemplateKey`、`isParent`、`accountMappings` 字段。
- 解析时额外返回这些字段。

`template:import-bundle` handler（`main.js:3450`）：

导入分两轮：
1. **第一轮**：导入所有模板（含主/子），先不设置 `parent_template_id`。
2. **第二轮**：遍历有 `parentTemplateKey` 的模板，通过 `templateKey` 找到已导入的主模板 id，设置 `parent_template_id`。
3. **第三轮**：导入每个模板的 `accountMappings`，调用 `database.saveAccountMappings(templateId, accountMappings)`。

#### 6.1.4 向下兼容

- v3 bundle 导入时 `parentTemplateKey` / `isParent` / `accountMappings` 字段不存在，忽略即可。
- v4 bundle 在旧版本（仅支持 v3）导入时，旧版本的 `bundleVersion > SUPPORTED_BUNDLE_VERSION` 检查会拒绝导入并提示版本过高。

### 6.2 改动点

| 文件 | 行号（约） | 改动内容 |
|------|-----------|---------|
| `src/main.js` | :116 | `SUPPORTED_BUNDLE_VERSION = 4` |
| `src/main.js` | :1040 `buildTemplateLibraryPayload` | 每个 entry 追加 `accountMappings` |
| `src/backend/database/template-repository.js` | :758 `listTemplateBundleEntries` | 每个 entry 追加 `isParent`、`parentTemplateKey` |
| `src/main.js` | :1074 `readTemplateBundleFile` | 解析 `parentTemplateKey`、`isParent`、`accountMappings` |
| `src/main.js` | :3450 `template:import-bundle` handler | 两轮导入 + 账户映射导入 |

### 6.3 注意事项

- 导入时模板名冲突处理沿用现有逻辑（跳过或覆盖），但主/子关系需在所有模板导入完成后才能建立。
- 如果主模板导入成功但子模板因名称冲突被跳过，子模板的 `parentTemplateKey` 关联会失败。需在导入日志中记录此情况。

---

## 七、需求 5：导入文件重复判定规则增强

### 7.1 实现方案

#### 7.1.1 `resolveImportFileSelection` 改造

`main.js:4940` 现有逻辑仅按 `path.resolve` 判重。改为三维度判重：

```javascript
const { createHash } = require('node:crypto');

function computeFileHash(filePath) {
  const buffer = fs.readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

async function resolveImportFileSelection({ templateName, session, filePaths }) {
  const acceptedPaths = [];
  const replacePaths = [];

  // 预计算已导入文件的信息（用于 basename 和 hash 比对）
  const sessionFileInfo = session.fileEntries.map((entry) => ({
    filePath: entry.filePath,
    baseName: path.basename(entry.filePath),
    hash: computeFileHash(entry.filePath)
  }));

  // 当前批次的文件信息
  const batchFileInfo = [];

  for (const rawPath of normalizeInputFilePaths(filePaths, { dedupe: false })) {
    const normalizedPath = path.resolve(rawPath);
    const baseName = path.basename(normalizedPath);
    const fileHash = computeFileHash(normalizedPath);

    // 三维度判重（优先级：路径 > 文件名 > 内容）
    let duplicateSource = null; // 'batch' | 'session'
    let duplicateReason = null; // '同一文件路径' | '同名文件' | '文件内容相同'

    // 1. 同路径
    if (acceptedPaths.includes(normalizedPath)) {
      duplicateSource = 'batch';
      duplicateReason = '同一文件路径';
    } else if (session.fileEntries.some((e) => e.filePath === normalizedPath)) {
      duplicateSource = 'session';
      duplicateReason = '同一文件路径';
    }

    // 2. 同文件名
    if (!duplicateReason) {
      if (batchFileInfo.some((info) => info.baseName === baseName)) {
        duplicateSource = 'batch';
        duplicateReason = '同名文件';
      } else if (sessionFileInfo.some((info) => info.baseName === baseName)) {
        duplicateSource = 'session';
        duplicateReason = '同名文件';
      }
    }

    // 3. 同文件内容
    if (!duplicateReason) {
      if (batchFileInfo.some((info) => info.hash === fileHash)) {
        duplicateSource = 'batch';
        duplicateReason = '文件内容相同';
      } else if (sessionFileInfo.some((info) => info.hash === fileHash)) {
        duplicateSource = 'session';
        duplicateReason = '文件内容相同';
      }
    }

    if (!duplicateReason) {
      acceptedPaths.push(normalizedPath);
      batchFileInfo.push({ filePath: normalizedPath, baseName, hash: fileHash });
      continue;
    }

    // 弹重复提示框（两按钮）
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['覆盖旧记录', '取消本次导入'],
      defaultId: 0,
      cancelId: 1,
      message: `检测到重复文件（模板：${templateName}）`,
      detail: `...\n\n重复原因：${duplicateReason}`
    });

    if (result.response === 1) {
      return { status: 'cancelled', filePaths: [] };
    }

    // 覆盖旧记录逻辑
    // ...（与现有覆盖逻辑类似，按 duplicateSource 分支处理）
  }

  return { status: 'success', filePaths: acceptedPaths, replacePaths: [...new Set(replacePaths)] };
}
```

#### 7.1.2 对话框按钮变更

当前：`['覆盖旧记录', '保留两份', '取消本次导入']`（3 按钮，cancelId: 2）

改为：`['覆盖旧记录', '取消本次导入']`（2 按钮，cancelId: 1）

移除所有 `result.response === 1`（原「保留两份」）的分支代码。

### 7.2 改动点

| 文件 | 行号（约） | 改动内容 |
|------|-----------|---------|
| `src/main.js` | :4940 `resolveImportFileSelection` | 三维度判重 + 两按钮 + `computeFileHash` |
| `src/main.js` | 顶部 require | 确保 `crypto` 已引入（检查现有 require） |

### 7.3 注意事项

- `node:crypto` 已在 `migrations.js` 中使用（`randomUUID`），`main.js` 顶部需检查是否已 require。若无需新增 `const { createHash } = require('node:crypto');`。
- 文件哈希计算使用同步 `fs.readFileSync`，与现有文件读取逻辑一致（主进程同步 I/O 风格）。
- `session.fileEntries` 中的文件在会话期间不会被外部修改（已导入的文件），因此哈希值可信。

---

## 八、任务分解

> 每个 task 尽量小、可验证、可独立完成。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| 1 | DB 迁移：`templates` 表新增 `parent_template_id` + `is_parent` | `migrations.js`, `database.js` | 启动 app 无报错；`PRAGMA table_info(templates)` 含新列 | todo |
| 2 | DB 迁移：`account_mappings` 表重建（新增 `template_id`，改联合唯一） | `migrations.js`, `database.js` | 启动 app 无报错；`PRAGMA table_info(account_mappings)` 含 `template_id` | todo |
| 3 | Repository + IPC：`listAccountMappings` / `saveAccountMappings` 增 `templateId` 参数 | `settings-repository.js`, `database.js`, `main.js`, `preload.js` | `account-mapping:list` 传 templateId 返回对应数据 | todo |
| 4 | Repository：`listTemplates` 返回 `parentTemplateId` / `isParent`；新增 `listChildTemplates` | `template-repository.js`, `database.js` | `templates.list()` 返回值含新字段 | todo |
| 5 | 前端：模板管理页面标题「模板管理」 | `renderer-dialogs.js` | 打开模板管理页面可见标题 | todo |
| 6 | 前端：映射关系管理页面新增主/子模板 checkbox | `renderer-dialogs.js`, `main.js`, `preload.js` | 勾选主/子模板保存后 DB 值正确 | todo |
| 7 | 前端：模板管理页面展开/折叠子模板 | `renderer-dialogs.js`, `styles.css` | 主模板可展开显示子模板列表 | todo |
| 8 | 前端：主页面模板下拉框过滤子模板 | `renderer.js` | 子模板不在下拉框中显示 | todo |
| 9 | 后端：`file:import` 主/子模板自动匹配 + 缺账户映射截断 | `main.js` | 主模板导入子模板文件时自动匹配解析；子模板无账户映射时截断并报错 | todo |
| 10 | 前端：账户映射页面重构（模板下拉框 + 文案 + 编辑/完成 + 执行操作列） | `renderer-dialogs.js`, `styles.css` | 页面按 PRD mockup 展示 | todo |
| 11 | 后端：Bundle v4 导出（子模板 + 账户映射） | `main.js`, `template-repository.js` | 导出 JSON 含 bundleVersion:4 + parentTemplateKey + accountMappings | todo |
| 12 | 后端：Bundle v4 导入（还原主/子关系 + 账户映射） | `main.js` | 导入 v4 bundle 后 DB 主/子关系和账户映射正确 | todo |
| 13 | 后端：v3 bundle 向下兼容导入 | `main.js` | 导入 v3 bundle 无报错，无主/子关系无账户映射 | todo |
| 14 | 后端：`resolveImportFileSelection` 三维度判重 + 两按钮 | `main.js` | 同路径/同名/同内容均触发提示框，无「保留两份」按钮 | todo |
| 15 | 后端：文件导入时按模板查账户映射 | `main.js` | `listAccountMappings(template.id)` 返回对应模板数据 | todo |

---

## 九、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `docs(v1.5.1): add TechDoc` | `TechDoc-v1.5.1.md` | - |
| 2 | `feat(v1.5.1): db migration — parent_template_id + is_parent` | `migrations.js`, `database.js` | 1 |
| 3 | `feat(v1.5.1): db migration — account_mappings add template_id` | `migrations.js`, `database.js` | 2 |
| 4 | `feat(v1.5.1): account mapping repository + IPC add templateId` | `settings-repository.js`, `database.js`, `main.js`, `preload.js` | 2 |
| 5 | `feat(v1.5.1): template repository — parentTemplateId, isParent, listChildTemplates` | `template-repository.js`, `database.js` | 1 |
| 6 | `feat(v1.5.1): template manager dialog title` | `renderer-dialogs.js` | 3 |
| 7 | `feat(v1.5.1): mapping dialog — parent/child template checkboxes` | `renderer-dialogs.js`, `main.js`, `preload.js` | 1 |
| 8 | `feat(v1.5.1): template manager — expand/collapse child templates` | `renderer-dialogs.js`, `styles.css` | 1 |
| 9 | `feat(v1.5.1): filter child templates from main dropdown` | `renderer.js` | 1 |
| 10 | `feat(v1.5.1): file import — auto match child template by headers` | `main.js` | 1 |
| 11 | `feat(v1.5.1): account mapping dialog — template dropdown + labels + edit/done` | `renderer-dialogs.js`, `styles.css` | 2 |
| 12 | `feat(v1.5.1): file import — account mapping by template` | `main.js` | 2 |
| 13 | `feat(v1.5.1): bundle v4 export — child templates + account mappings` | `main.js`, `template-repository.js` | 4 |
| 14 | `feat(v1.5.1): bundle v4 import — restore parent/child + account mappings` | `main.js` | 4 |
| 15 | `feat(v1.5.1): file duplicate detection — three dimensions + two buttons` | `main.js` | 5 |
| 16 | `chore(v1.5.1): bump version to 1.5.1` | `package.json` | - |

---

## 十、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。

### 2026-04-12

- 动作：撰写 TechDoc 初稿
- 证据：本文件
- 风险：`account_mappings` 重建表迁移是本次最高风险点，需人工复核迁移脚本
- 决策：`is_parent` 列独立于 `parent_template_id`，用于显式标记主模板身份
- 动作：用户确认 3 个待澄清问题后更新 TechDoc
- 决策：account_mappings 迁移采用方案 B（复制给每个模板），迁移代码已更新
- 决策：文件哈希算法确认 SHA-256
- 决策：子模板缺账户映射时截断导入并报错（不弹映射页面）
- 动作：team-lead review 后修正两处问题
- 决策：子模板匹配算法改为精确匹配（集合相等），不做模糊匹配/匹配度排序；多模板匹配同一文件时报错

### 2026-04-13

- 动作：代码实施完成，Reverse Sync 回写 PRD + TechDoc
- 差异：实施过程中新增 7 项功能补充（D-1~D-8），详见 §1.3
- 修复：`rebuildMatchedTemplateFileEntries` 解决主模板导入子模板文件时 MerchantId 为空的问题（详见 §3.4）
- 证据：`npm run smoke` 通过；代码模拟验证 MerchantId 正确；导出文件数据验证通过（详见 `TestReport-v1.5.1.md`）
- 待确认：P1-16 BOC-CN 多文件导入"提取不到大账号信息"，需确认具体导入文件列表

### 可沉淀知识

- [ ] SQLite 不支持 `ALTER TABLE DROP CONSTRAINT`，表结构变更需通过重建表实现（值得记录到 `knowledge/`）

---

## 十一、Open Technical Questions

1. ~~**`account_mappings` 数据迁移策略**~~：已确认方案 B（复制给每个模板）。§四迁移代码已更新。
2. ~~**文件 headers 匹配算法细节**~~：已确认**精确匹配（集合相等）**，一对一。不做模糊匹配、不做匹配度排序。一个文件精确匹配到多个模板时报错（属于配置问题）。§三已更新。
3. **`is_parent` 列 vs 动态查询**：是否需要 `is_parent` 列，还是通过 `SELECT COUNT(1) FROM templates WHERE parent_template_id = ?` 动态判断？显式列更简单且查询效率高，推荐保留。
