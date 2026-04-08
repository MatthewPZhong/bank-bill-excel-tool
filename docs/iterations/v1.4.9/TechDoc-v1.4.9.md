# TechDoc - 网银账单小助手 v1.4.9

| 项目 | 内容 |
|------|------|
| 版本 | v1.4.9 |
| 日期 | 2026-04-08 |
| 作者 | Dev |
| 状态 | 已定稿（2026-04-08） |
| 关联 PRD | `docs/iterations/v1.4.9/PRD-v1.4.9.md`（94 AC：AC1-1 ~ AC1-82 + ACI-1 ~ ACI-12） |
| 依赖 | v1.4.8 已 merged 到 main（commit `59d2264`，2026-04-07 merged），v1.4.9 从 main 起分支 |
| 术语 | **「合并」**（PRD §3 已统一术语，禁止使用「合成」） |

---

## 一、PRD 评审意见（技术角度）

本节记录 Dev 在阅读 PRD-v1.4.9.md 后对实现可行性的判断，所有意见均不修改 PRD，仅作为 TechDoc 与后续 task #4（实施代码）的参考。

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §4.6.2 三张新表 schema（`template_bill_split_mappings` / `template_bill_split_rows` / `template_bill_split_amount_rules`） | 表名、字段名均符合既有 snake_case 命名风格；可通过新增 `migrations.js` 函数 + 沿用 `BEGIN/COMMIT/ROLLBACK` 模板实现幂等迁移。无技术阻碍。 |
| §4.5.1 4 方互斥（`AMOUNT_MODE_CONFLICT`） | `validateTemplateConfiguration`（`src/main.js:2579`）已经维护了 `enabledAmountModes` 3 方计数（`src/main.js:2617-2625`），第 4 方仅需新增一个 `usesBillSplitMerge` 布尔并放进同一数组。无技术阻碍。 |
| §4.6.4 bundleVersion 升级到 3 | v1.4.8 PRD AC1-20 已预埋 `SUPPORTED_BUNDLE_VERSION` 校验（`src/main.js:942-944` 处的 `readTemplateBundleFile`），仅需把常量从 `2` 改为 `3` 并在 `listTemplateBundleEntries` 输出中追加 5 个新字段。无技术阻碍。 |
| §4.5.3 弹框 2 副区域 UI 复用 v1.4.8 `createAmountSplitRulesDialog` | v1.4.8 的 `createAmountSplitRulesDialog`（`src/renderer-dialogs.js:1896`）签名为 `({ template, initialRules = [], onDone, onCancel })`，给它增加 `context: 'main' | 'bill-split'` 入参不破坏既有调用方。无技术阻碍。 |
| §4.3.5 行级落库（Q-C12 = B） | 没有"整体级完成按钮"意味着每一次 UI 行为都直接发 IPC 落库，前端无草稿态聚合负担。但需要 IPC 数量上升（详见 §10 Q-OT1）。无技术阻碍。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | PRD 处理建议 |
|------|---------|-------------|
| R-1 | §4.3.5 副区域配置的"按正负号拆分的发生额"在 PRD §4.6.2 中表述为"可放在表中 meta 记录或新增 `template_mappings` scope=bill-split 行，由 Dev 决定"。**team-lead 于 2026-04-08 决策（Q-OT2 = B）：新建独立表 `template_bill_split_meta`（1:1 with template，单行存 `signed_amount_source_field` 字段）**，与 `template_bill_split_amount_rules` 表完全分离，避免两种语义混存。**详见 §3.2.4 + §10 Q-OT2**。 | 不动 PRD，仅在 TechDoc 落定。 |
| R-2 | §4.7.4 中"非金额字段从代表行的对应原始行取值"的语义要求 `buildMappedRows`（`src/backend/file-service.js:41`）必须能区分"金额字段路径"与"非金额字段路径"，并把金额字段路径替换为"按弹框 2 N 行配置展开"。这是 v1.4.7 / v1.4.8 / v1.4.9 三层金额模式中**结构改动最大的一次**，需要从 `buildMappedRows` 内部抽取成两阶段处理。**详见 §5.6 / §10 Q-OT5**。 | 不动 PRD，仅在 TechDoc 落定。 |
| R-3 | §4.3.5「需要拆分成几份账单」右侧的 `完成` 在生成 N 行时必须**同时**在 DB 中插入 N 行 `row_status = draft` 记录（AC1-50），Dev 需注意 N 减小时调用 `DELETE FROM template_bill_split_rows WHERE template_id = ? AND seq_no > ?` 而不是清空整表。 | 已在 TechDoc §3.4.3 处理。 |
| R-4 | §4.4.2 合并组的"代表行 = 最小 seq_no"语义（PRD §Q-A3）要求 `merged_group_seq` 永远等于组内最小 seq_no。删除一行会引发 seq_no 整体前移（§3.4.3），可能让其它合并组的 `merged_group_seq` 偏离该不变量。**team-lead 于 2026-04-08 决策（Q-OT6 = C / Dev 选 C1 surgical）：删除时一并解除受影响的合并组**——规则：(1) 若删除行本身在合并组内，整组解散（PRD §Q-C7）；(2) 对其它合并组，若任一成员的 seq ≥ 删除行的 seq，则整组解散；前端需在删除前 **二次确认** 列出受影响的合并组。详见 §3.4.3 / §5.3 / §7.3.4 + §10 Q-OT6。 | 不动 PRD，仅在 TechDoc 落定。 |
| R-5 | §4.7.5「全部行未命中」告警需要把"拆分失败 / 合并失败"统一聚合到 v1.4.8 §3.4.3 的告警机制，但 v1.4.8 的"全部未命中"判定基于 `matchedCreditCount === 0 && matchedDebitCount === 0`（`src/backend/file-service.js:67-68`）。v1.4.9 需要新增"全部行无法产生任何输出行"的判定计数器 `matchedBillSplitCount`。详见 §5.6.4。 | 已在 TechDoc §5.6.4 处理。 |

### 1.3 与 PRD 的差异（无）

Dev 不在本 TechDoc 中改写 PRD 任何条款。所有 PRD 中标注「Dev 在 TechDoc 阶段决定」的留白点均在本 TechDoc 显式落定（详见 §11 Open Technical Questions）。

---

## 二、架构总览

### 2.1 模块划分

```
+---------------------------+        IPC          +---------------------------+
|       Renderer            |  <--------------->  |        Main Process       |
|  src/renderer-dialogs.js  |                     |       src/main.js         |
|                           |                     |                           |
| createMappingDialog       |                     | template:save-mappings    |
|   ├ 账单拆分合并管理 分组 |                     |   ├ 4 方互斥校验          |
|   ├ 「拆分账单设置」按钮  |                     |   └ 落库 (新增 5 字段)    |
|   └ 「拆分账单管理」按钮  |                     |                           |
|                           |                     | template:get-bill-split-* |
| createBillSplitMappings-  |  <--------------->  | template:save-bill-split-*|
| Dialog                    |                     |                           |
| (弹框 1，新增)            |                     | template:bill-split-rows-*|
|                           |                     |                           |
| createBillSplitRowsDialog |  <--------------->  | template:bill-split-merge-|
| (弹框 2，新增)            |                     | group-*                   |
|                           |                     |                           |
| createAmountSplitRules-   |  <--------------->  | template:save-bill-split- |
| Dialog (复用 v1.4.8       |                     | amount-rules              |
|  + context 参数)          |                     |                           |
+---------------------------+                     +---------------------------+
                                                              |
                                                              v
                                         +--------------------------------------+
                                         |        SQLite (better-sqlite3)       |
                                         |  src/backend/database/               |
                                         |                                      |
                                         |  templates                           |
                                         |  template_mappings (扩展 2 行配置)   |
                                         |  template_big_accounts               |
                                         |  template_fixed_assignments          |
                                         |  template_amount_split_rules (不动)  |
                                         |                                      |
                                         |  template_bill_split_mappings  (新)  |
                                         |  template_bill_split_rows      (新)  |
                                         |  template_bill_split_amount_rules(新)|
                                         |  template_bill_split_meta      (新)  |
                                         +--------------------------------------+
                                                              |
                                                              v
                                         +--------------------------------------+
                                         |   导入流水：file-service.js          |
                                         |   buildMappedRows + bill-split 分支  |
                                         +--------------------------------------+
```

### 2.2 涉及的文件清单

| 文件 | 改动类型 | 概要 |
|------|---------|------|
| `src/backend/database/migrations.js` | 修改 | 新增 `ensureBillSplitMergeSupport` 迁移函数；导出新函数 |
| `src/backend/database/template-repository.js` | 修改 | 新增 12 个 repository 函数（含 `getBillSplitMeta` / `saveBillSplitMeta`，Q-OT2 = B 追加）；扩展 `saveMappings` / `getTemplateMappings` / `listTemplateBundleEntries` |
| `src/backend/database/utils.js` | 不动 | 不需要改动（沿用 `normalizeText` / `parseJsonArray`） |
| `src/backend/file-service.js` | 修改 | `buildMappedRows` 新增 `billSplitMergeConfig` 入参 + 拆分 / 合并执行分支；新增 `matchedBillSplitCount` 计数器 |
| `src/main.js` | 修改 | 新增 4 个常量；扩展 `validateTemplateConfiguration`、`template:save-mappings`、`template:import-bundle`、`getTemplateMappingConfig`、`buildStatementGenerationConfig`、`buildMappedRowsForFile`；新增 9 个 IPC handler；`SUPPORTED_BUNDLE_VERSION` 改为 `3` |
| `src/preload.js` | 修改 | 暴露 9 个新 IPC 通道到 `desktopApi.templates.*` |
| `src/renderer-dialogs.js` | 修改 | 扩展 `createMappingDialog`（账单拆分合并管理分组 + 4 方互斥扩展）；新增 `createBillSplitMappingsDialog`（弹框 1）+ `createBillSplitRowsDialog`（弹框 2）；扩展 `createAmountSplitRulesDialog` 接受 `context` 参数 |
| `src/styles.css` | 修改 | 新增 `.bill-split-*` 系列样式（灰显合并行、disabled tooltip、副区域分隔线） |
| `docs/iterations/v1.4.9/TechDoc-v1.4.9.md` | 新建 | 本文件 |
| `package.json` | 修改 | `version` 字段从 `1.4.8` 升级为 `1.4.9` |

---

## 三、数据模型设计

### 3.1 设计原则

1. **不动 v1.4.8 既有表**（PRD §4.6.3 + AC1-77）。`template_amount_split_rules` 保持原样，副区域的同名规则放进新表 `template_bill_split_amount_rules`，与 Q-A4 / Q-E2 一致。
2. **4 张新表**全部用 `template_id` 外键关联 `templates.id`，DB 层 `ON DELETE CASCADE` 保证模板删除时联动清理。新增的第 4 张表 `template_bill_split_meta` 是 1:1 with template，专门存放副区域「按正负号拆分的发生额」字段（Q-OT2 = B 决策，与 `template_bill_split_amount_rules` 完全分离）。
3. **草稿语义**（PRD §4.6.5 / Q-A5 / Q-C9）：弹框 1 / 弹框 2 的所有数据在切换外层开关时**保留**。这要求 `template:save-mappings` 主流程**不**主动 `DELETE FROM template_bill_split_*`；只有用户明确在弹框内的"完成 / 删除"按钮才会触发 DML。
4. **行级落库**（PRD §4.3.5 / Q-C12 = B）：弹框 2 没有整体完成按钮，每行 / 每组关系都由独立 IPC handler 完成 DB 写入。
5. **幂等迁移**（PRD §4.6.3 + AC1-76）：所有 `CREATE TABLE` 都使用 `CREATE TABLE IF NOT EXISTS`；所有 `CREATE INDEX` 都使用 `CREATE INDEX IF NOT EXISTS`；包裹在 `BEGIN/COMMIT/ROLLBACK` 事务内。

### 3.2 四张新表 schema

#### 3.2.1 `template_bill_split_mappings` —— 弹框 1 的字段映射

| 字段 | 类型 | 约束 / 说明 |
|------|------|-------------|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` |
| `template_id` | `INTEGER` | `NOT NULL`，`FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE` |
| `template_field` | `TEXT` | `NOT NULL`，模板字段名（如 `MerchantId` / `BillDate` 等） |
| `mapped_field` | `TEXT` | 主映射字段字符串（与 `template_mappings.mapped_field` 语义一致） |
| `mapped_fields_json` | `TEXT` | 多字段拼接 JSON（与 `template_mappings.mapped_fields_json` 语义一致） |
| `row_index` | `INTEGER` | `NOT NULL DEFAULT 0`，UI 行序 |
| `created_at` | `TEXT` | `NOT NULL`，ISO 时间戳 |
| `updated_at` | `TEXT` | `NOT NULL`，ISO 时间戳 |

约束：

- `UNIQUE(template_id, template_field)`（PRD §4.6.2 「弹框 1 同一模板字段不可重复」+ AC1-20）
- `INDEX idx_template_bill_split_mappings_template_id ON (template_id)`

> **设计点**：完全镜像 v1.4.8 既有 `template_mappings` 表的字段结构（除 `template_field` 不可枚举 `Currency` / `Credit Amount` / `Debit Amount`，由前端校验保证）。这样 repository 层的 INSERT / DELETE 模式可以复用 `template_mappings` 的代码模板，降低实现难度。

#### 3.2.2 `template_bill_split_rows` —— 弹框 2 的六列表格 + 合并组

| 字段 | 类型 | 约束 / 说明 |
|------|------|-------------|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` |
| `template_id` | `INTEGER` | `NOT NULL`，`FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE` |
| `seq_no` | `INTEGER` | `NOT NULL`，账单序号 1..N |
| `currency_source_field` | `TEXT` | Currency 列下拉框选中的源字段名（PRD §4.6.2） |
| `credit_source_field` | `TEXT` | Credit Amount 列下拉框选中的源字段名 |
| `debit_source_field` | `TEXT` | Debit Amount 列下拉框选中的源字段名 |
| `amount_source_field` | `TEXT` | 「发生额」列下拉框选中的源字段名 |
| `row_status` | `TEXT` | `NOT NULL DEFAULT 'draft'`，取值 `'draft'` / `'completed'`（AC1-40 / AC1-41） |
| `merged_group_seq` | `INTEGER` | `NULL` 或组内最小 seq_no（AC1-56 / AC1-59 / Q-A3）。**Q-OT6 = C 决策**：删除行时受影响的合并组整组解散以维护 PRD §Q-A3 不变量「`merged_group_seq` = 组内最小 seq_no」。 |
| `created_at` | `TEXT` | `NOT NULL` |
| `updated_at` | `TEXT` | `NOT NULL` |

约束：

- `UNIQUE(template_id, seq_no)`（PRD §4.6.2 + AC1-78）
- `INDEX idx_template_bill_split_rows_template_id ON (template_id)`
- `INDEX idx_template_bill_split_rows_merged_group ON (template_id, merged_group_seq)`（合并组查询）
- `CHECK (row_status IN ('draft', 'completed'))`

> **设计点 1**：合并组 ID 直接复用「组内最小 seq_no」，避免引入额外的 group_id 自增表（Q-A3 锁定）。
>
> **设计点 2**：`merged_group_seq IS NULL` 表示该行未参与任何合并组；非 NULL 时表示该行属于以 `merged_group_seq` 为代表行的合并组。代表行自身的 `merged_group_seq` 也等于自己的 `seq_no`（即 `seq_no = merged_group_seq`），便于一次 SQL 查询识别合并组成员。
>
> **设计点 3**：N 缩小（PRD §4.3.3 二次确认后）通过 `DELETE FROM template_bill_split_rows WHERE template_id = ? AND seq_no > ?` 实现；同时调用同一事务内的 `UPDATE ... SET merged_group_seq = NULL WHERE merged_group_seq IN (...)` 解散被波及的合并组。

#### 3.2.3 `template_bill_split_amount_rules` —— 弹框 2 副区域子配置

| 字段 | 类型 | 约束 / 说明 |
|------|------|-------------|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` |
| `template_id` | `INTEGER` | `NOT NULL`，`FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE` |
| `target_field` | `TEXT` | `NOT NULL`，取值：`'Credit Amount'` / `'Debit Amount'`。**仅承载副区域「按字段区分发生额」规则**；副区域「按正负号拆分的发生额」单独存到 `template_bill_split_meta`（Q-OT2 = B 决策，详见 §3.2.4）。 |
| `condition_field` | `TEXT` | 条件字段名（v1.4.8 「按字段区分发生额」语义） |
| `condition_value` | `TEXT` | 条件值字符串（字面值或 `/pattern/flags` 正则） |
| `mapped_field` | `TEXT` | 目标源字段名 |
| `row_index` | `INTEGER` | `NOT NULL DEFAULT 0`，行序 |
| `created_at` | `TEXT` | `NOT NULL` |
| `updated_at` | `TEXT` | `NOT NULL` |

约束：

- `INDEX idx_template_bill_split_amount_rules_template_id ON (template_id)`
- 不加 `UNIQUE(template_id, target_field)`，因为 `target_field = 'Credit Amount'` 可能有多行规则（与 v1.4.8 `template_amount_split_rules` 同结构）

> **设计点 1（Q-OT2 = B 决策，2026-04-08 by team-lead/user）**：本表**仅承载**副区域「按字段区分发生额」的规则（`target_field IN ('Credit Amount', 'Debit Amount')`）。副区域「按正负号拆分的发生额」独立放到 `template_bill_split_meta`（详见 §3.2.4），与本表完全分离 —— 两种语义不混存，schema 干净。
>
> **设计点 2**：保存"按字段区分发生额"规则时，先 `DELETE FROM template_bill_split_amount_rules WHERE template_id = ?`，然后 INSERT 新规则。保存动作只覆盖本表的"按字段区分"语义，不影响 `template_bill_split_meta`。
>
> **设计点 3**：本表完全独立于 v1.4.8 的 `template_amount_split_rules`，符合 Q-A4 / Q-E2 锁定（"不与 v1.4.8 既有表合并"）。

#### 3.2.4 `template_bill_split_meta` —— 弹框 2 副区域「按正负号拆分的发生额」（Q-OT2 = B）

| 字段 | 类型 | 约束 / 说明 |
|------|------|-------------|
| `template_id` | `INTEGER` | `PRIMARY KEY`，`FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE` —— 1:1 with template |
| `signed_amount_source_field` | `TEXT` | `NOT NULL DEFAULT ''`，副区域「按正负号拆分的发生额」选中的源列名（空字符串表示未配置） |
| `created_at` | `TEXT` | `NOT NULL`，ISO 时间戳 |
| `updated_at` | `TEXT` | `NOT NULL`，ISO 时间戳 |

约束：

- `template_id` 为 `PRIMARY KEY`，自带 unique index。
- `ON DELETE CASCADE` 保证模板删除时本表 1 行自动清理。

> **设计点（Q-OT2 = B，2026-04-08 by team-lead/user）**：本表 1 行 1 列承载副区域「按正负号拆分的发生额」配置。**与 `template_bill_split_amount_rules` 完全分离**，原因：
>
> 1. **schema 洁癖**：两种语义不同的数据（多行规则 vs 单一字段配置）不应该共用一张表。`template_bill_split_amount_rules` 是"按字段区分发生额"的多行规则集；本表是"按正负号拆分的发生额"的单一字段值。混存会让 repository 层 SELECT 时必须用 `target_field` 做语义路由，破坏表结构语义。
> 2. **未来可扩展**：副区域如果再加更多"非规则型"配置（例如 sign 反转开关），都可以加到本表的列上而不破坏现有约束。
> 3. **1:1 with template**：用 `template_id` 直接做 PRIMARY KEY，不需要 AUTOINCREMENT id，节约一个字段。
>
> **数据存在性约定**：本表行的存在与否**不**代表"用户启用了按正负号拆分"——`signed_amount_source_field = ''` 同样表示"未配置"。读取时，若行不存在，repository 层 fallback 到 `{ signedAmountSourceField: '' }`；写入时，按"upsert"语义处理（见 §3.4.6）。

### 3.3 迁移函数

新增 `migrations.js` 函数 `ensureBillSplitMergeSupport(db)`：

```javascript
function ensureBillSplitMergeSupport(db) {
  db.exec('BEGIN');

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS template_bill_split_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        template_field TEXT NOT NULL,
        mapped_field TEXT,
        mapped_fields_json TEXT,
        row_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE (template_id, template_field)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_template_bill_split_mappings_template_id
        ON template_bill_split_mappings (template_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS template_bill_split_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        seq_no INTEGER NOT NULL,
        currency_source_field TEXT,
        credit_source_field TEXT,
        debit_source_field TEXT,
        amount_source_field TEXT,
        row_status TEXT NOT NULL DEFAULT 'draft' CHECK (row_status IN ('draft', 'completed')),
        merged_group_seq INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE (template_id, seq_no)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_template_bill_split_rows_template_id
        ON template_bill_split_rows (template_id);
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_template_bill_split_rows_merged_group
        ON template_bill_split_rows (template_id, merged_group_seq);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS template_bill_split_amount_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        target_field TEXT NOT NULL,
        condition_field TEXT,
        condition_value TEXT,
        mapped_field TEXT,
        row_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_template_bill_split_amount_rules_template_id
        ON template_bill_split_amount_rules (template_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS template_bill_split_meta (
        template_id INTEGER PRIMARY KEY,
        signed_amount_source_field TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
      );
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

> **Q-OT2 = B 决策（2026-04-08）**：`template_bill_split_meta` 与其它 3 张 bill-split 表共享同一个 migration `ensureBillSplitMergeSupport`，避免新增独立 migration 函数（一次启动只需运行 1 次事务，原子性最强）。如果团队偏好独立 migration，可以拆为 `ensureBillSplitMetaSupport`，但本 TechDoc 选择合并以减少调用点。

幂等保证：

- `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`：重复执行不报错，无副作用。
- `BEGIN/COMMIT/ROLLBACK`：任一 DDL 失败时回滚整个事务，避免半状态。
- 不修改任何既有表的 schema，因此对已经升级到 v1.4.8 的环境完全幂等。

迁移函数注册在 `migrations.js` 末尾的 `module.exports`：

```javascript
module.exports = {
  ensureTemplateKeySupport,
  ensureTemplateMappingEnhancements,
  ensureAccountMappingCurrencySupport,
  ensureTemplateDateFormatSupport,
  ensureAmountSplitRulesSupport,
  ensureBillSplitMergeSupport,  // ← v1.4.9 新增
};
```

调用顺序：在 `src/backend/database/index.js`（或等效初始化模块）中已有的 `ensureAmountSplitRulesSupport(db)` 调用之后追加 `ensureBillSplitMergeSupport(db);`。

### 3.4 repository 层新增函数

在 `src/backend/database/template-repository.js` 中新增以下 12 个函数：`getBillSplitMappings` / `saveBillSplitMappings`（弹框 1）；`getBillSplitRows` / `saveBillSplitRowCount` / `saveBillSplitRow` / `deleteBillSplitRow`（弹框 2 行 CRUD）；`saveBillSplitMergeGroup` / `clearBillSplitMergeGroups`（合并组）；`getBillSplitAmountRules` / `saveBillSplitAmountRules`（副区域「按字段区分发生额」规则）；`getBillSplitMeta` / `saveBillSplitMeta`（副区域「按正负号拆分的发生额」字段，**Q-OT2 = B 决策追加**，专门读写 `template_bill_split_meta` 表）。

#### 3.4.1 `getBillSplitMappings(db, templateId)`

读取弹框 1 的字段映射列表。返回结构与 v1.4.8 `getTemplateMappings(...).mappings` 一致。

```javascript
function getBillSplitMappings(db, templateId) {
  return db
    .prepare(`
      SELECT
        row_index AS rowIndex,
        template_field AS templateField,
        mapped_field AS mappedField,
        mapped_fields_json AS mappedFieldsJson
      FROM template_bill_split_mappings
      WHERE template_id = ?
      ORDER BY row_index ASC
    `)
    .all(templateId)
    .map((row) => ({
      rowIndex: Number(row.rowIndex || 0),
      templateField: normalizeText(row.templateField),
      mappedField: normalizeText(row.mappedField),
      mappedFields: parseJsonArray(row.mappedFieldsJson)
        .map((value) => normalizeText(value))
        .filter((value) => value !== '')
    }));
}
```

#### 3.4.2 `saveBillSplitMappings(db, templateId, mappings)`

整体覆盖弹框 1 的字段映射（弹框 1 的「完成」按钮 = 整体落库，AC1-19）。

```javascript
function saveBillSplitMappings(db, templateId, mappings = []) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM template_bill_split_mappings WHERE template_id = ?').run(templateId);

    const insertStatement = db.prepare(`
      INSERT INTO template_bill_split_mappings (
        template_id, template_field, mapped_field, mapped_fields_json, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    mappings.forEach((mapping, index) => {
      const templateField = normalizeText(mapping.templateField);
      const mappedField = normalizeText(mapping.mappedField);
      // 「映射字段」为空的行被丢弃 (AC1-20)
      if (!templateField || (!mappedField && (!Array.isArray(mapping.mappedFields) || mapping.mappedFields.length === 0))) {
        return;
      }
      const mappedFields = Array.from(
        new Set(
          (Array.isArray(mapping.mappedFields) ? mapping.mappedFields : [])
            .map((value) => normalizeText(value))
            .filter((value) => value !== '')
        )
      );
      insertStatement.run(
        templateId,
        templateField,
        mappedField,
        JSON.stringify(mappedFields),
        Number.isInteger(mapping.rowIndex) ? mapping.rowIndex : index,
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

#### 3.4.3 `getBillSplitRows(db, templateId)` / `saveBillSplitRowCount(db, templateId, n)` / `saveBillSplitRow(db, templateId, row)` / `deleteBillSplitRow(db, templateId, seqNo)`

弹框 2 六列表格的行级 CRUD：

```javascript
function getBillSplitRows(db, templateId) {
  return db
    .prepare(`
      SELECT
        seq_no AS seqNo,
        currency_source_field AS currencySourceField,
        credit_source_field AS creditSourceField,
        debit_source_field AS debitSourceField,
        amount_source_field AS amountSourceField,
        row_status AS rowStatus,
        merged_group_seq AS mergedGroupSeq
      FROM template_bill_split_rows
      WHERE template_id = ?
      ORDER BY seq_no ASC
    `)
    .all(templateId)
    .map((row) => ({
      seqNo: Number(row.seqNo),
      currencySourceField: normalizeText(row.currencySourceField),
      creditSourceField: normalizeText(row.creditSourceField),
      debitSourceField: normalizeText(row.debitSourceField),
      amountSourceField: normalizeText(row.amountSourceField),
      rowStatus: normalizeText(row.rowStatus) || 'draft',
      mergedGroupSeq: row.mergedGroupSeq === null ? null : Number(row.mergedGroupSeq)
    }));
}

function saveBillSplitRowCount(db, templateId, nextN) {
  // 对应 PRD §4.3.3：N 增大时追加空白行；N 减小时由 IPC handler 在调用前完成
  // 二次确认；本函数只负责 DML。
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const existingRows = db
      .prepare('SELECT seq_no, merged_group_seq FROM template_bill_split_rows WHERE template_id = ? ORDER BY seq_no ASC')
      .all(templateId);
    const currentM = existingRows.length;

    if (nextN > currentM) {
      const insertStmt = db.prepare(`
        INSERT INTO template_bill_split_rows (
          template_id, seq_no, currency_source_field, credit_source_field, debit_source_field,
          amount_source_field, row_status, merged_group_seq, created_at, updated_at
        ) VALUES (?, ?, '', '', '', '', 'draft', NULL, ?, ?)
      `);
      for (let seq = currentM + 1; seq <= nextN; seq += 1) {
        insertStmt.run(templateId, seq, now, now);
      }
    } else if (nextN < currentM) {
      // 解散包含被删除行的合并组：先收集所有被波及的 group_seq
      const dissolvedGroups = db
        .prepare('SELECT DISTINCT merged_group_seq FROM template_bill_split_rows WHERE template_id = ? AND seq_no > ? AND merged_group_seq IS NOT NULL')
        .all(templateId, nextN)
        .map((row) => Number(row.merged_group_seq));
      if (dissolvedGroups.length > 0) {
        const placeholders = dissolvedGroups.map(() => '?').join(',');
        db.prepare(`UPDATE template_bill_split_rows SET merged_group_seq = NULL, updated_at = ? WHERE template_id = ? AND merged_group_seq IN (${placeholders})`)
          .run(now, templateId, ...dissolvedGroups);
      }
      db.prepare('DELETE FROM template_bill_split_rows WHERE template_id = ? AND seq_no > ?').run(templateId, nextN);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function saveBillSplitRow(db, templateId, row) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE template_bill_split_rows
    SET currency_source_field = ?,
        credit_source_field = ?,
        debit_source_field = ?,
        amount_source_field = ?,
        row_status = ?,
        updated_at = ?
    WHERE template_id = ? AND seq_no = ?
  `).run(
    normalizeText(row.currencySourceField),
    normalizeText(row.creditSourceField),
    normalizeText(row.debitSourceField),
    normalizeText(row.amountSourceField),
    row.rowStatus === 'completed' ? 'completed' : 'draft',
    now,
    templateId,
    Number(row.seqNo)
  );
}

function deleteBillSplitRow(db, templateId, seqNo) {
  // 删除一行 + 后续行 seq_no 整体前移 + 按 Q-OT6 = C (C1 surgical) 解除"受影响的合并组"
  // 受影响 = (1) 删除行自身所在的合并组（PRD §Q-C7）
  //        + (2) 任一其它合并组中存在 seq >= seqNo 的成员
  // 等价说法：删除 seq=N 后，保留下来的合并组必须满足"所有成员的 seq < N"。
  const now = new Date().toISOString();
  const dissolvedGroups = [];   // 返回给上层 IPC handler，供前端二次确认 / 通知用
  db.exec('BEGIN');
  try {
    const target = db.prepare('SELECT merged_group_seq FROM template_bill_split_rows WHERE template_id = ? AND seq_no = ?').get(templateId, seqNo);
    if (!target) {
      db.exec('COMMIT');
      return { dissolvedGroups };
    }

    // Step A: 收集所有"受影响"的合并组 group_seq（去重）
    // (1) 删除行自身所在的合并组（若有）
    if (target.merged_group_seq !== null) {
      dissolvedGroups.push(Number(target.merged_group_seq));
    }
    // (2) 其它合并组中包含 seq >= seqNo 的成员（不含删除行自身那一组，因已加入 (1)）
    const otherAffected = db
      .prepare(`
        SELECT DISTINCT merged_group_seq
        FROM template_bill_split_rows
        WHERE template_id = ?
          AND merged_group_seq IS NOT NULL
          AND seq_no >= ?
          AND seq_no != ?
      `)
      .all(templateId, seqNo, seqNo)
      .map((row) => Number(row.merged_group_seq))
      .filter((groupSeq) => !dissolvedGroups.includes(groupSeq));
    dissolvedGroups.push(...otherAffected);

    // Step B: 解除受影响的合并组（UPDATE merged_group_seq = NULL）
    if (dissolvedGroups.length > 0) {
      const placeholders = dissolvedGroups.map(() => '?').join(',');
      db.prepare(`
        UPDATE template_bill_split_rows
        SET merged_group_seq = NULL, updated_at = ?
        WHERE template_id = ? AND merged_group_seq IN (${placeholders})
      `).run(now, templateId, ...dissolvedGroups);
    }

    // Step C: 删除目标行
    db.prepare('DELETE FROM template_bill_split_rows WHERE template_id = ? AND seq_no = ?').run(templateId, seqNo);

    // Step D: 后续行 seq_no 整体前移
    db.prepare(`
      UPDATE template_bill_split_rows
      SET seq_no = seq_no - 1,
          updated_at = ?
      WHERE template_id = ? AND seq_no > ?
    `).run(now, templateId, seqNo);

    // 不变量保证：Step B 之后没有任何剩余合并组的成员 seq >= seqNo，因此 Step D 的前移
    // 不会让任何幸存的 merged_group_seq 偏离"组内最小 seq_no"——对幸存合并组而言，所有
    // 成员 seq 都 < seqNo，前移操作根本不影响它们。PRD §Q-A3 不变量保持。

    db.exec('COMMIT');
    return { dissolvedGroups };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

> **Q-OT6 = C / C1 surgical 决策（2026-04-08 by team-lead/user）**：
>
> - PRD §Q-A3 要求 `merged_group_seq` 永远等于组内最小 seq_no。原 Dev 方案（不处理漂移）会在"删除非合并行"场景下让其它合并组的 `merged_group_seq` 偏离这个不变量，违反 PRD。
> - C1 surgical 规则：精确解除"删除后会破坏不变量"的合并组，对其它不受影响的合并组保持原样。这比 C2 conservative（一律解散全部合并组）保留了更多用户配置，UX 更好。
> - 等价表达式：删除 seq=N 后，保留下来的合并组必须满足"所有成员的 seq < N"。这是 Step B 的判定依据。
> - 二次确认 UI 见 §7.3.4 deleteBtn handler。后端返回 `dissolvedGroups: number[]` 数组，让前端在删除前展示"以下合并组将被解散：[列表]，确认继续？"

#### 3.4.4 `saveBillSplitMergeGroup(db, templateId, seqNos)` / `clearBillSplitMergeGroups(db, templateId)`

合并组的 DML：

```javascript
function saveBillSplitMergeGroup(db, templateId, seqNos = []) {
  if (!Array.isArray(seqNos) || seqNos.length < 2) {
    // AC1-55：< 2 个时报错由 IPC handler 层抛出，本函数防御性 noop
    return;
  }
  const minSeq = Math.min(...seqNos.map(Number));
  const now = new Date().toISOString();
  const placeholders = seqNos.map(() => '?').join(',');
  db.prepare(`
    UPDATE template_bill_split_rows
    SET merged_group_seq = ?,
        updated_at = ?
    WHERE template_id = ? AND seq_no IN (${placeholders})
  `).run(minSeq, now, templateId, ...seqNos.map(Number));
}

function clearBillSplitMergeGroups(db, templateId) {
  // PRD AC1-59：取消勾选「合并账单」时一次性清空所有合并组
  const now = new Date().toISOString();
  db.prepare('UPDATE template_bill_split_rows SET merged_group_seq = NULL, updated_at = ? WHERE template_id = ? AND merged_group_seq IS NOT NULL')
    .run(now, templateId);
}
```

#### 3.4.5 `getBillSplitAmountRules(db, templateId)` / `saveBillSplitAmountRules(db, templateId, rules)`

副区域「按字段区分发生额」规则的 CRUD（**不含**「按正负号拆分」字段，后者由 §3.4.6 处理）：

```javascript
function getBillSplitAmountRules(db, templateId) {
  return db
    .prepare(`
      SELECT
        target_field AS targetField,
        condition_field AS conditionField,
        condition_value AS conditionValue,
        mapped_field AS mappedField,
        row_index AS rowIndex
      FROM template_bill_split_amount_rules
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

function saveBillSplitAmountRules(db, templateId, rules = []) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM template_bill_split_amount_rules WHERE template_id = ?')
      .run(templateId);
    const insertStmt = db.prepare(`
      INSERT INTO template_bill_split_amount_rules (
        template_id, target_field, condition_field, condition_value, mapped_field, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (Array.isArray(rules) ? rules : []).forEach((rule, index) => {
      insertStmt.run(
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

> **Q-OT2 = B 决策（2026-04-08）**：本函数语义简化 —— 只承载"按字段区分发生额"规则，签名收敛为 `(db, templateId, rules: array)`，整体覆盖语义（与 v1.4.8 `saveAmountSplitRules` 一致）。"按正负号拆分的发生额"通过独立函数 `saveBillSplitMeta` 处理（§3.4.6），两路完全不耦合。

#### 3.4.6 `getBillSplitMeta(db, templateId)` / `saveBillSplitMeta(db, templateId, meta)` — Q-OT2 = B 新增

副区域「按正负号拆分的发生额」配置的 CRUD（独立 1:1 表）：

```javascript
function getBillSplitMeta(db, templateId) {
  const row = db
    .prepare(`
      SELECT signed_amount_source_field AS signedAmountSourceField
      FROM template_bill_split_meta
      WHERE template_id = ?
    `)
    .get(templateId);
  return {
    signedAmountSourceField: row ? normalizeText(row.signedAmountSourceField) : ''
  };
}

function saveBillSplitMeta(db, templateId, meta = {}) {
  const now = new Date().toISOString();
  const value = normalizeText(meta.signedAmountSourceField);
  // upsert：若行存在则 UPDATE，否则 INSERT
  const existing = db.prepare('SELECT 1 FROM template_bill_split_meta WHERE template_id = ?').get(templateId);
  if (existing) {
    db.prepare(`
      UPDATE template_bill_split_meta
      SET signed_amount_source_field = ?, updated_at = ?
      WHERE template_id = ?
    `).run(value, now, templateId);
  } else {
    db.prepare(`
      INSERT INTO template_bill_split_meta (
        template_id, signed_amount_source_field, created_at, updated_at
      ) VALUES (?, ?, ?, ?)
    `).run(templateId, value, now, now);
  }
}
```

> **设计点**：
>
> 1. **upsert 而非 REPLACE**：避免 REPLACE 触发的 `ON DELETE CASCADE` 副作用（虽然本表无子表，但保持语义清晰）。
> 2. **空字符串 = 未配置**：`saveBillSplitMeta(templateId, { signedAmountSourceField: '' })` 同样落库 1 行，但 `value = ''`，等同于"已写入但未配置"。读取时 fallback 到 `''`，导入流程不会触发副区域逻辑。
> 3. **不需要"不传不动"语义**：因为本表只有 1 个有效字段，调用方明确知道要么覆盖要么不调用。简化接口。

### 3.5 `getTemplateMappings` 扩展

`src/backend/database/template-repository.js:255-293` 中的 `getTemplateMappings` 当前返回 `{ template, mappings, bigAccounts, fixedAssignments, amountSplitRules }`。v1.4.9 扩展为：

```javascript
return {
  template,
  mappings,
  bigAccounts: groupBigAccountRows(bigAccountRows),
  fixedAssignments,
  amountSplitRules,
  // v1.4.9 新增
  billSplitMappings: getBillSplitMappings(db, templateId),
  billSplitRows: getBillSplitRows(db, templateId),
  billSplitAmountRules: getBillSplitAmountRules(db, templateId),
  billSplitMeta: getBillSplitMeta(db, templateId)   // ← Q-OT2 = B 新增
};
```

### 3.6 `saveMappings` 不需要扩展

PRD §4.6.5 + Q-A5 / Q-C9 明确：「弹框 1 / 弹框 2 都采用直接落库模式（无外层草稿），关闭弹框不丢数据；切回主开关也不删除已落库的数据」。这意味着 `template:save-mappings` 主流程**不**应该清理 `template_bill_split_*` 表，只清理 v1.4.8 已有的 `template_mappings` / `template_big_accounts` / `template_fixed_assignments`（保持现状不动）。

但是 `template:save-mappings` 主流程**仍然要**写入两个开关行到 `template_mappings`：

- `templateField = '是否拆分/合并明细账单'`，`mappedField = '是' / ''`
- `templateField = '复用模块字段的映射关系'`，`mappedField = '是' / '否'`

这两行通过 v1.4.8 既有的 `saveMappings(db, templateId, mappings, ...)` 流程自动写入（因为 mappings 数组已经包含了这两行，由前端在保存时拼装），不需要新增 repository 函数。

### 3.7 `listTemplateBundleEntries` 扩展

`src/backend/database/template-repository.js:410-433` 当前的 `listTemplateBundleEntries` 在每个 entry 中输出 `mappings / bigAccounts / fixedAssignments / amountSplitRules / dateFormat`。v1.4.9 扩展为：

```javascript
return {
  templateKey: template.templateKey,
  name: template.name,
  sourceFileName: template.sourceFileName,
  headers: template.headers,
  mappings: payload ? payload.mappings.map((mapping) => ({ ...mapping })) : [],
  bigAccounts: payload ? payload.bigAccounts.map(/* ... */) : [],
  fixedAssignments: payload ? payload.fixedAssignments.map((item) => ({ ...item })) : [],
  amountSplitRules: payload && Array.isArray(payload.amountSplitRules)
    ? payload.amountSplitRules.map((rule) => ({ ...rule }))
    : [],
  // v1.4.9 新增 ↓
  billSplitMappings: payload && Array.isArray(payload.billSplitMappings)
    ? payload.billSplitMappings.map((m) => ({ ...m }))
    : [],
  billSplitRows: payload && Array.isArray(payload.billSplitRows)
    ? payload.billSplitRows.map((r) => ({ ...r }))
    : [],
  billSplitAmountRules: payload && Array.isArray(payload.billSplitAmountRules)
    ? payload.billSplitAmountRules.map((r) => ({ ...r }))
    : [],
  // Q-OT2 = B 新增字段（独立于 billSplitAmountRules）
  billSplitMeta: payload && payload.billSplitMeta
    ? { signedAmountSourceField: payload.billSplitMeta.signedAmountSourceField || '' }
    : { signedAmountSourceField: '' },
  dateFormat: template.dateFormat || 'auto',
  createdAt: template.createdAt,
  updatedAt: template.updatedAt
};
```

注意 bundle 顶层的 `billSplitMergeEnabled` / `reuseModuleMapping` 两个开关值通过 `mappings` 数组自然带出（因为它们存储在 `template_mappings` 表中），无需在 entry 顶层重复输出。

---

## 四、新增常量与 IPC 通道命名

### 4.1 后端常量（写在 `src/main.js` 顶部常量块，紧邻 `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD`）

在 `src/main.js:100-117` 已有的常量块之后追加：

```javascript
// v1.4.9 — 账单拆分合并管理
const BILL_SPLIT_MERGE_MAPPING_FIELD = '是否拆分/合并明细账单';
const BILL_SPLIT_MERGE_ENABLED_OPTION = '是';
const REUSE_MODULE_MAPPING_FIELD = '复用模块字段的映射关系';
const REUSE_MODULE_DEFAULT_OPTION = '是';

// SUPPORTED_BUNDLE_VERSION 升级
const SUPPORTED_BUNDLE_VERSION = 3;  // 原 v1.4.8 = 2

// ADVANCED_MAPPING_FIELDS 不动 —— BILL_SPLIT_MERGE_MAPPING_FIELD 不属于"高级映射字段"组
// 它是一个独立分组「账单拆分合并管理」，UI 处理路径完全独立。
```

> **Q-OT2 = B 决策（2026-04-08）**：原 Dev 方案中的 `BILL_SPLIT_SIGNED_AMOUNT_TARGET = 'SignedAmount'` 常量**已删除**。副区域「按正负号拆分的发生额」改用独立表 `template_bill_split_meta`（§3.2.4），不再需要任何 target_field 标记常量。

| 常量名 | 用途 |
|-------|------|
| `BILL_SPLIT_MERGE_MAPPING_FIELD` | 「是否拆分/合并明细账单」开关在 `template_mappings` 表中的 `template_field` 值 |
| `BILL_SPLIT_MERGE_ENABLED_OPTION` | 该开关启用时的 `mapped_field` 值（参考 v1.4.8 `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION = '是'`） |
| `REUSE_MODULE_MAPPING_FIELD` | 「复用模块字段的映射关系」开关在 `template_mappings` 表中的 `template_field` 值 |
| `REUSE_MODULE_DEFAULT_OPTION` | 该开关默认值（'是'）；用于旧模板回退 |
| `SUPPORTED_BUNDLE_VERSION = 3` | 模板 bundle 的当前支持版本，从 v1.4.8 的 `2` 升级（PRD §4.6.4 + AC1-79 / AC1-80 / AC1-81） |

> **不变常量**：v1.4.7 / v1.4.8 既有的 `SIGNED_AMOUNT_MAPPING_FIELD`、`AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD`、`AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION`、`AMOUNT_BASED_NAME_MAPPING_FIELD`、`AMOUNT_BASED_ACCOUNT_MAPPING_FIELD`、`ADVANCED_MAPPING_FIELDS` 数组**完全不动**。

### 4.2 错误码常量

| 常量名 | 错误码字符串 | 适用场景 | 对应 AC |
|-------|-------------|---------|---------|
| `ERROR_AMOUNT_MODE_CONFLICT` | `'AMOUNT_MODE_CONFLICT'` | 4 方互斥违反（保存阶段） | AC1-71 |
| `ERROR_BILL_SPLIT_CONFIG_MISSING` | `'BILL_SPLIT_CONFIG_MISSING'` | 开关 = 是但弹框 2 无 `completed` 行（保存阶段） | ACI-11 |
| `ERROR_BILL_MERGE_CURRENCY_MISMATCH` | `'BILL_MERGE_CURRENCY_MISMATCH'` | 合并组 Currency 不一致（导入阶段） | AC1-60 / ACI-6 |
| `ERROR_BILL_MERGE_NET_ZERO` *(deprecated)* | `'BILL_MERGE_NET_ZERO'` | ~~合并组净值 = 0（导入阶段）~~ **2026-04-08 fix2 override：不再抛出**，合并组净值 = 0 时改为静默跳过整个组（见 §5.6.4）。错误码字符串保留在错误码表中以保持历史兼容，但实际代码路径永远不会触发。 | AC1-62 / ACI-7 |

> **统一文案**（参考 PRD §4.5 / §4.7.5 / Q-G2 / Q-G3）：
>
> - `AMOUNT_MODE_CONFLICT` → `Credit Amount / Debit Amount 直接映射、按正负号拆分的发生额、按字段区分发生额、拆分/合并明细账单 四者只能启用其中一种`
> - `BILL_SPLIT_CONFIG_MISSING` → `请先在"拆分/合并账单映射关系管理"中配置至少一行拆分账单配置`
> - `BILL_MERGE_CURRENCY_MISMATCH` → `合并账单的 Currency 不一致，无法合并`
> - ~~`BILL_MERGE_NET_ZERO` → `合并账单后净值为 0，无法判定收支方向，请检查合并配置`~~ **已废弃（2026-04-08 fix2）**，保留文案仅作历史参考

### 4.3 IPC 通道命名

参考 v1.4.8 既有的 `template:save-mappings` / `template:save-amount-split-rules` 命名风格（`template:` 前缀 + kebab-case action）。

| IPC 通道 | 方向 | 入参 | 返回 | AC |
|---------|------|-----|-----|-----|
| `template:get-bill-split-config` | renderer → main | `{ templateId }` | `{ enabled, reuseModule, billSplitMappings, billSplitRows, billSplitAmountRules, billSplitMeta }` | AC1-74 / AC1-75 |
| `template:save-bill-split-mappings` | renderer → main | `{ templateId, mappings }` | `{ ok: true }` 或抛错 | AC1-19 / AC1-20 |
| `template:save-bill-split-row-count` | renderer → main | `{ templateId, nextN }` | `{ ok: true, currentRows: [...] }` | AC1-37 / AC1-38 / AC1-50 |
| `template:save-bill-split-row` | renderer → main | `{ templateId, row }` | `{ ok: true }` 或抛错 | AC1-40 / AC1-41 / AC1-51 |
| `template:preview-delete-bill-split-row` | renderer → main | `{ templateId, seqNo }` | `{ dissolvedGroups: number[] }` | AC1-42 / AC1-43-NEW |
| `template:delete-bill-split-row` | renderer → main | `{ templateId, seqNo }` | `{ ok: true, currentRows: [...], dissolvedGroups: number[] }` | AC1-42 / AC1-43 / AC1-44 |
| `template:save-bill-split-merge-group` | renderer → main | `{ templateId, seqNos: number[] }` | `{ ok: true }` 或抛错 | AC1-52 / AC1-55 / AC1-56 |
| `template:clear-bill-split-merge-groups` | renderer → main | `{ templateId }` | `{ ok: true }` | AC1-59 |
| `template:save-bill-split-amount-rules` | renderer → main | `{ templateId, amountSplitRules: [...] }` | `{ ok: true }` | AC1-48 / AC1-49 |
| `template:save-bill-split-meta` | renderer → main | `{ templateId, signedAmountSourceField }` | `{ ok: true }` | AC1-47 / AC1-49 |

> **设计说明**（详见 §10 Q-OT1）：因为 PRD Q-C12 = B 选择了"行级落库"路径，弹框 2 没有整体级"完成"按钮，必须用细粒度 IPC 落库每一次行为。这里**不**采用 PM 在 Q-G1 中提议的统一 `template:save-bill-split-config` 单一通道，理由：
>
> 1. 行级落库要求"用户每点一次完成 / 删除 / 合并完成 = 一次 DB 写入"，单一 umbrella IPC 在前端会变成"前端持有 N 个 dirty 状态 → 每次都把整个状态推到后端 → 后端整体覆盖"，这违背了 PRD 行级落库的初衷（草稿不在 renderer 维护，因为关闭弹框后再打开必须回显已落库的 draft 行）。
> 2. 细粒度 IPC 让每个操作的失败回滚边界更清晰：删除一行失败不会破坏其它行的状态。
>
> 弹框 1（`template:save-bill-split-mappings`）保留单一 IPC，因为 PRD §4.2 明确弹框 1 是「点完成按钮整体落库」（与 v1.4.8 `createAmountSplitRulesDialog` 的 `onDone` 一致）。

> **Q-OT2 = B 决策（2026-04-08）的 IPC 拆分**：原 Dev 方案中的 `template:save-bill-split-amount-rules`（同时承载 `signedAmountSourceField` 和 `amountSplitRules`）已**拆分为两个 IPC**：
>
> - `template:save-bill-split-amount-rules` —— 仅承载「按字段区分发生额」规则（写入 `template_bill_split_amount_rules` 表）
> - `template:save-bill-split-meta` —— 仅承载「按正负号拆分的发生额」字段（upsert 写入 `template_bill_split_meta` 表）
>
> 两路完全独立，前端调用方根据用户操作的具体下拉框分别调用对应 IPC。这样后端 handler 不再需要"如果传 A 就处理 A，如果传 B 就处理 B"的多分支判定。

> **Q-OT6 = C / C1 surgical 决策（2026-04-08）的 IPC 新增**：新增 `template:preview-delete-bill-split-row` —— 在前端真正调用 `template:delete-bill-split-row` 之前先 dry-run 一次 `deleteBillSplitRow` 的"受影响合并组"判定逻辑，返回 `dissolvedGroups: number[]` 给前端用于二次确认弹框。preview 和实际 delete 走同一份 server-side 判定代码，前端不需要自己复制规则。`template:delete-bill-split-row` 的返回值同步加上 `dissolvedGroups`，让前端在删除完成后能继续刷新 UI（例如显示"已解散合并组：[...]" toast）。

### 4.4 Preload 暴露

`src/preload.js` 中给 `desktopApi.templates` 添加 10 个新方法（与 v1.4.8 暴露 `desktopApi.templates.saveAmountSplitRules` 等的方式一致）：

```javascript
// src/preload.js (片段示意)
templates: {
  // ... v1.4.8 既有方法 ...
  // v1.4.9 新增
  getBillSplitConfig: (templateId) =>
    ipcRenderer.invoke('template:get-bill-split-config', { templateId }),
  saveBillSplitMappings: (templateId, mappings) =>
    ipcRenderer.invoke('template:save-bill-split-mappings', { templateId, mappings }),
  saveBillSplitRowCount: (templateId, nextN) =>
    ipcRenderer.invoke('template:save-bill-split-row-count', { templateId, nextN }),
  saveBillSplitRow: (templateId, row) =>
    ipcRenderer.invoke('template:save-bill-split-row', { templateId, row }),
  previewDeleteBillSplitRow: (templateId, seqNo) =>          // ← Q-OT6 = C 新增
    ipcRenderer.invoke('template:preview-delete-bill-split-row', { templateId, seqNo }),
  deleteBillSplitRow: (templateId, seqNo) =>
    ipcRenderer.invoke('template:delete-bill-split-row', { templateId, seqNo }),
  saveBillSplitMergeGroup: (templateId, seqNos) =>
    ipcRenderer.invoke('template:save-bill-split-merge-group', { templateId, seqNos }),
  clearBillSplitMergeGroups: (templateId) =>
    ipcRenderer.invoke('template:clear-bill-split-merge-groups', { templateId }),
  saveBillSplitAmountRules: (templateId, amountSplitRules) =>  // ← Q-OT2 = B 拆分后简化
    ipcRenderer.invoke('template:save-bill-split-amount-rules', { templateId, amountSplitRules }),
  saveBillSplitMeta: (templateId, signedAmountSourceField) =>  // ← Q-OT2 = B 新增
    ipcRenderer.invoke('template:save-bill-split-meta', { templateId, signedAmountSourceField }),
},
```

---

## 五、后端改动

### 5.1 `validateTemplateConfiguration` 扩展（4 方互斥）

文件：`src/main.js:2579`（函数定义起点）

#### 5.1.1 新增 mode 布尔（基于 PRD §4.5.1 / Q-B1 / Q-B2）

在现有 `enabledAmountModes` 计算块（`src/main.js:2609-2625`）中追加 v1.4.9 的第 4 模式：

```javascript
// 既有 (src/main.js:2609-2615)
const signedAmountSourceField = /* ... */;
const creditAmountSourceField = /* ... */;
const debitAmountSourceField = /* ... */;
const amountSplitByFieldOption = /* ... */;
const usesSignedAmountMapping = Boolean(signedAmountSourceField);
const usesDirectAmountMapping = Boolean(creditAmountSourceField || debitAmountSourceField);
const usesAmountSplitByField = amountSplitByFieldOption === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;

// v1.4.9 新增
const billSplitMergeOption = mappings
  .find((m) => m.templateField === BILL_SPLIT_MERGE_MAPPING_FIELD)?.mappedField || '';
const usesBillSplitMerge = billSplitMergeOption === BILL_SPLIT_MERGE_ENABLED_OPTION;

// 既有 (src/main.js:2617-2625) — 扩为 4 项
const enabledAmountModes = [
  usesDirectAmountMapping,
  usesSignedAmountMapping,
  usesAmountSplitByField,
  usesBillSplitMerge,                     // ← v1.4.9 新增
].filter(Boolean);

if (enabledAmountModes.length > 1) {
  throw createValidationError(
    'AMOUNT_MODE_CONFLICT',
    'Credit Amount / Debit Amount 直接映射、按正负号拆分的发生额、按字段区分发生额、拆分/合并明细账单 四者只能启用其中一种'
  );
}
```

#### 5.1.2 BILL_SPLIT_MERGE_MAPPING_FIELD 的 early-return 处理

`validateTemplateConfiguration` 在 `src/main.js:2706-2715` 已有针对 `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` 的"早期返回 / 跳过强校验"分支（保留 `''` 或 `'是'` 即合法，不走"映射字段必须存在于 headers"的校验）。v1.4.9 需要为 `BILL_SPLIT_MERGE_MAPPING_FIELD` 和 `REUSE_MODULE_MAPPING_FIELD` 添加同样的早返回：

```javascript
// 既有 (src/main.js:2706-2715 周边)
if (templateField === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD) {
  // ... 保留原代码 ...
  return;
}

// v1.4.9 新增
if (templateField === BILL_SPLIT_MERGE_MAPPING_FIELD) {
  if (mappedField !== '' && mappedField !== BILL_SPLIT_MERGE_ENABLED_OPTION) {
    throw createValidationError(
      'INVALID_BILL_SPLIT_MERGE_OPTION',
      `「${BILL_SPLIT_MERGE_MAPPING_FIELD}」只能取值 "" 或 "${BILL_SPLIT_MERGE_ENABLED_OPTION}"`
    );
  }
  return;
}

if (templateField === REUSE_MODULE_MAPPING_FIELD) {
  if (mappedField !== '是' && mappedField !== '否') {
    throw createValidationError(
      'INVALID_REUSE_MODULE_OPTION',
      `「${REUSE_MODULE_MAPPING_FIELD}」只能取值 "是" 或 "否"`
    );
  }
  return;
}
```

#### 5.1.3 `BILL_SPLIT_CONFIG_MISSING` 校验（保存阶段）

PRD ACI-11：「开关 = 是但弹框 2 无任何 `row_status = completed` 行 → 保存外层「映射关系管理」对话框时报错」。这一校验插入在 `template:save-mappings` handler 中（见 §5.2），不在 `validateTemplateConfiguration` 内（因为 `validateTemplateConfiguration` 只能看到 `mappings` 数组，看不到 `template_bill_split_rows` 表的内容）。

### 5.2 `template:save-mappings` handler 扩展

文件：`src/main.js:2969-3069`

#### 5.2.1 BILL_SPLIT_CONFIG_MISSING 校验插入点

在 v1.4.8 的 `usesAmountSplitByField` 校验（`src/main.js:3001-3021`）之后追加：

```javascript
// 既有 (src/main.js:3001-3021)
if (usesAmountSplitByField) {
  const existingRules = database.getAmountSplitRules(templateId);
  if (existingRules.length === 0) {
    throw createValidationError(
      'AMOUNT_SPLIT_RULES_MISSING',
      '请先在"发生额映射关系管理"中配置规则'
    );
  }
}

// v1.4.9 新增
if (usesBillSplitMerge) {
  const completedRows = database.getBillSplitRows(templateId)
    .filter((row) => row.rowStatus === 'completed');
  if (completedRows.length === 0) {
    throw createValidationError(
      'BILL_SPLIT_CONFIG_MISSING',
      '请先在"拆分/合并账单映射关系管理"中配置至少一行拆分账单配置'
    );
  }
}
```

> **注意**：此处只校验"至少 1 行 completed"，**不**校验合并组 Currency 一致或合并组净值非 0 —— 后两者依赖原始数据值，必须等到导入阶段才能判定（详见 §5.6）。

#### 5.2.2 `saveMappings` 不传 bill-split 数据

`template:save-mappings` 调用 `database.saveMappings(...)` 时**仍然只传 v1.4.8 的 6 个参数**，**不传**任何 bill-split 相关参数。这是因为：

1. PRD §4.6.5 / Q-A5：弹框 1 / 弹框 2 的数据走草稿语义，外层保存动作不应该清理它们。
2. v1.4.8 已经实现的"`amountSplitRules = null` = 不传不动"语义（`src/backend/database/template-repository.js:374-395`）应该被复用：v1.4.9 也用同样的"不传不动"模式，避免外层 save 误删 bill-split 数据。

具体而言，v1.4.8 的 `template:save-mappings` 在 `src/main.js:3023-3029` 处的调用：

```javascript
database.saveMappings(
  templateId,
  mappings,
  bigAccounts,
  fixedAssignments,
  dateFormat
  // amountSplitRules omitted → null → "不传不动"
);
```

v1.4.9 **保持完全一致**，不追加任何参数。

### 5.3 8 个新 IPC handler

全部注册在 `src/main.js` 的 `app.whenReady().then(...)` 内（参考 v1.4.8 的 `ipcMain.handle('template:save-amount-split-rules', ...)` 等位置）。

```javascript
// 1. 读取配置
ipcMain.handle('template:get-bill-split-config', async (_event, { templateId }) => {
  const billSplitMappings = database.getBillSplitMappings(templateId);
  const billSplitRows = database.getBillSplitRows(templateId);
  const billSplitAmountRules = database.getBillSplitAmountRules(templateId);
  const billSplitMeta = database.getBillSplitMeta(templateId);    // ← Q-OT2 = B 新增
  // 两个开关从主 mappings 表读
  const fullMapping = database.getTemplateMappings(templateId);
  const enabled = (fullMapping?.mappings || [])
    .find((m) => m.templateField === BILL_SPLIT_MERGE_MAPPING_FIELD)?.mappedField
    === BILL_SPLIT_MERGE_ENABLED_OPTION;
  const reuseModule = ((fullMapping?.mappings || [])
    .find((m) => m.templateField === REUSE_MODULE_MAPPING_FIELD)?.mappedField || '是') === '是';
  return { enabled, reuseModule, billSplitMappings, billSplitRows, billSplitAmountRules, billSplitMeta };
});

// 2. 保存弹框 1 字段映射
ipcMain.handle('template:save-bill-split-mappings', async (_event, { templateId, mappings }) => {
  validateBillSplitMappingsPayload(mappings);
  database.saveBillSplitMappings(templateId, mappings);
  return { ok: true };
});

// 3. 保存 N 行行数（生成 / 同步 N 行）
ipcMain.handle('template:save-bill-split-row-count', async (_event, { templateId, nextN }) => {
  if (!Number.isInteger(nextN) || nextN < 1 || nextN > 99) {
    throw createValidationError('INVALID_BILL_SPLIT_ROW_COUNT', '拆分账单的份数必须为 1 ~ 99 之间的整数');
  }
  database.saveBillSplitRowCount(templateId, nextN);
  const currentRows = database.getBillSplitRows(templateId);
  return { ok: true, currentRows };
});

// 4. 保存单行（行级落库）
ipcMain.handle('template:save-bill-split-row', async (_event, { templateId, row }) => {
  validateBillSplitRowPayload(row);
  database.saveBillSplitRow(templateId, row);
  return { ok: true };
});

// 5a. 预演删除单行 —— 仅返回受影响的合并组列表（Q-OT6 = C / C1 surgical 二次确认前调用）
ipcMain.handle('template:preview-delete-bill-split-row', async (_event, { templateId, seqNo }) => {
  // 使用与 deleteBillSplitRow 完全相同的判定逻辑（在事务外只读 SELECT）
  const allRows = database.getBillSplitRows(templateId);
  const target = allRows.find((r) => r.seqNo === Number(seqNo));
  if (!target) return { dissolvedGroups: [] };
  const dissolved = new Set();
  // 规则 1：删除行自身所在的合并组
  if (target.mergedGroupSeq !== null) {
    dissolved.add(Number(target.mergedGroupSeq));
  }
  // 规则 2：其它合并组中包含 seq >= seqNo 的成员
  for (const row of allRows) {
    if (row.mergedGroupSeq !== null && row.seqNo >= Number(seqNo) && row.seqNo !== Number(seqNo)) {
      dissolved.add(Number(row.mergedGroupSeq));
    }
  }
  return { dissolvedGroups: Array.from(dissolved).sort((a, b) => a - b) };
});

// 5b. 删除单行（实际写入）
ipcMain.handle('template:delete-bill-split-row', async (_event, { templateId, seqNo }) => {
  const { dissolvedGroups } = database.deleteBillSplitRow(templateId, seqNo);
  const currentRows = database.getBillSplitRows(templateId);
  return { ok: true, currentRows, dissolvedGroups };
});

// 6. 保存合并组
ipcMain.handle('template:save-bill-split-merge-group', async (_event, { templateId, seqNos }) => {
  if (!Array.isArray(seqNos) || seqNos.length < 2) {
    throw createValidationError(
      'BILL_MERGE_TOO_FEW_ROWS',
      '合并账单至少需要选择 2 个账单序号'
    );
  }
  // 校验所有 seqNo 都已 completed 且未已合并
  const allRows = database.getBillSplitRows(templateId);
  const candidates = new Set(
    allRows
      .filter((row) => row.rowStatus === 'completed' && row.mergedGroupSeq === null)
      .map((row) => row.seqNo)
  );
  for (const seqNo of seqNos) {
    if (!candidates.has(Number(seqNo))) {
      throw createValidationError(
        'BILL_MERGE_INVALID_CANDIDATE',
        `账单序号 ${seqNo} 不可参与合并（未完成或已属于其它合并组）`
      );
    }
  }
  database.saveBillSplitMergeGroup(templateId, seqNos);
  return { ok: true };
});

// 7. 清空所有合并组
ipcMain.handle('template:clear-bill-split-merge-groups', async (_event, { templateId }) => {
  database.clearBillSplitMergeGroups(templateId);
  return { ok: true };
});

// 8. 保存副区域「按字段区分发生额」规则（Q-OT2 = B 拆分后简化）
ipcMain.handle('template:save-bill-split-amount-rules', async (_event, { templateId, amountSplitRules }) => {
  // 副区域 2 选 1 互斥（PRD §4.5.2）：若 meta 已有「按正负号」字段且本次提交了非空规则 → 报错
  const existingMeta = database.getBillSplitMeta(templateId);
  if (existingMeta.signedAmountSourceField && Array.isArray(amountSplitRules) && amountSplitRules.length > 0) {
    throw createValidationError(
      'BILL_SPLIT_AMOUNT_MODE_CONFLICT',
      '弹框 2 副区域的"按正负号拆分的发生额"和"按字段区分发生额"只能启用其中一种'
    );
  }
  database.saveBillSplitAmountRules(templateId, Array.isArray(amountSplitRules) ? amountSplitRules : []);
  return { ok: true };
});

// 9. 保存副区域「按正负号拆分的发生额」字段（Q-OT2 = B 新增）
ipcMain.handle('template:save-bill-split-meta', async (_event, { templateId, signedAmountSourceField }) => {
  // 副区域 2 选 1 互斥：若 amount-rules 表已有规则且本次提交了非空字段 → 报错
  const existingRules = database.getBillSplitAmountRules(templateId);
  if (signedAmountSourceField && Array.isArray(existingRules) && existingRules.length > 0) {
    throw createValidationError(
      'BILL_SPLIT_AMOUNT_MODE_CONFLICT',
      '弹框 2 副区域的"按正负号拆分的发生额"和"按字段区分发生额"只能启用其中一种'
    );
  }
  database.saveBillSplitMeta(templateId, { signedAmountSourceField: signedAmountSourceField || '' });
  return { ok: true };
});
```

> **Q-OT2 = B 决策（2026-04-08）**：原 handler 用一个 IPC 同时承载两套语义，校验时还要 dispatch 到不同的 DB 写入路径。拆成两个 handler 后：(1) 每个 handler 只做 1 件事；(2) 互斥校验在两个 handler 中**对称实现**（任一方写入前都查另一方的现状）；(3) 调用方明确知道在写哪一类数据，前端逻辑也更直观（详见 §7.3.5 拆分后的 onChange 逻辑）。

### 5.4 校验辅助函数

```javascript
function validateBillSplitMappingsPayload(mappings) {
  if (!Array.isArray(mappings)) {
    throw createValidationError('INVALID_BILL_SPLIT_MAPPINGS', '弹框 1 字段映射格式错误');
  }
  const seenFields = new Set();
  for (const mapping of mappings) {
    const tf = (mapping?.templateField || '').trim();
    if (!tf) continue;
    // 排除三件套（前端应已过滤，后端兜底）
    if (tf === 'Currency' || tf === 'Credit Amount' || tf === 'Debit Amount') {
      throw createValidationError(
        'BILL_SPLIT_MAPPING_FIELD_NOT_ALLOWED',
        `弹框 1 不允许映射 Currency / Credit Amount / Debit Amount，请在弹框 2 中配置`
      );
    }
    // 同字段不可重复 (AC1-20)
    if (seenFields.has(tf)) {
      throw createValidationError(
        'DUPLICATE_BILL_SPLIT_TEMPLATE_FIELD',
        `弹框 1 中模板字段「${tf}」重复`
      );
    }
    seenFields.add(tf);
  }
}

function validateBillSplitRowPayload(row) {
  if (!row || !Number.isInteger(row.seqNo) || row.seqNo < 1) {
    throw createValidationError('INVALID_BILL_SPLIT_ROW', '拆分账单行数据格式错误');
  }
  // AC1-34: 同行 Credit !== Debit
  if (
    row.creditSourceField &&
    row.debitSourceField &&
    row.creditSourceField === row.debitSourceField
  ) {
    throw createValidationError(
      'BILL_SPLIT_CREDIT_DEBIT_SAME',
      '同一份拆分账单的 Credit Amount 和 Debit Amount 不能是同一列'
    );
  }
  if (row.rowStatus !== undefined && row.rowStatus !== 'draft' && row.rowStatus !== 'completed') {
    throw createValidationError('INVALID_BILL_SPLIT_ROW_STATUS', '拆分账单行状态值非法');
  }
}
```

> **关于「同行 Credit ≠ Debit」（AC1-34）**：前端先校验，后端兜底。后端报错时由前端弹错误提示，符合 PRD 文案 `同一份拆分账单的 Credit Amount 和 Debit Amount 不能是同一列`。

### 5.5 `getTemplateMappingConfig` 与 `buildStatementGenerationConfig` 扩展

文件：`src/main.js:1499-1524`（`getTemplateMappingConfig`）+ `src/main.js:3506-3628`（`buildStatementGenerationConfig`）

#### 5.5.1 `getTemplateMappingConfig` 返回结构追加

```javascript
return {
  // ... v1.4.8 既有字段（含 amountSplitRules / amountSplitByField 等）...
  // v1.4.9 新增
  billSplitMergeEnabled: enabledFromMappings(BILL_SPLIT_MERGE_MAPPING_FIELD, BILL_SPLIT_MERGE_ENABLED_OPTION),
  reuseModuleMapping: enabledFromMappings(REUSE_MODULE_MAPPING_FIELD, '是', '是'),  // 默认 '是'
  billSplitMappings: database.getBillSplitMappings(templateId),
  billSplitRows: database.getBillSplitRows(templateId),
  billSplitAmountRules: database.getBillSplitAmountRules(templateId),
  billSplitMeta: database.getBillSplitMeta(templateId)   // ← Q-OT2 = B 新增
};
```

`enabledFromMappings(field, expected, defaultValue = '')` 是一个内部 helper：从 `mappings` 数组找出 `templateField === field` 的行，返回其 `mappedField === expected` 的判定结果（带默认值）。

> **2026-04-08 fix2（Fix #6，commit `d30ec96`）：`template:get-mappings` handler 返回 5 个 billSplit 字段**
>
> `getTemplateMappingConfig` 的返回结构正确包含了 `billSplitGroupFields` / `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 5 个字段，但 `template:get-mappings` IPC handler（`src/main.js:2988-3020`）在组装 response 对象时**漏了这 5 个字段**——直接 `return { status: 'success', template, targetFields, advancedMappingFields, ..., mappings, bigAccounts, fixedAssignments, amountSplitRules, dateFormat }`，前端 `createMappingDialog` 读到 undefined fallback 为空数组，导致冷启动后**首次**打开弹框 2 显示空状态。
>
> 修复：在 handler return 对象中显式追加这 5 个字段（从 `mappingConfig.*` 读取并透传）。第二次打开能正常显示的原因：弹框 2 onClose → getBillSplitConfig → reopen 时显式传这些字段。详见 commit message。

#### 5.5.2 `buildStatementGenerationConfig` 扩展

`buildStatementGenerationConfig` 当前在 `src/main.js:3506-3628` 处构造导入阶段使用的配置对象。v1.4.9 在返回对象中追加 `billSplitMergeConfig`：

```javascript
return {
  // ... v1.4.8 既有字段 ...
  amountMappingRules,
  amountSplitByField: amountSplitByFieldConfig,  // v1.4.8 既有
  // v1.4.9 新增
  billSplitMergeConfig: usesBillSplitMerge
    ? buildBillSplitMergeConfig(templateConfig)
    : null
};
```

新增内部 builder：

```javascript
function buildBillSplitMergeConfig(templateConfig) {
  const completedRows = (templateConfig.billSplitRows || []).filter((row) => row.rowStatus === 'completed');
  // 把 completed 行按 merged_group_seq 分组：null 的是独立行；非 null 的属于合并组
  const mergeGroupsMap = new Map();   // merged_group_seq → row[]
  const standaloneRows = [];
  for (const row of completedRows) {
    if (row.mergedGroupSeq === null) {
      standaloneRows.push(row);
    } else {
      const key = row.mergedGroupSeq;
      if (!mergeGroupsMap.has(key)) {
        mergeGroupsMap.set(key, []);
      }
      mergeGroupsMap.get(key).push(row);
    }
  }
  const mergeGroups = Array.from(mergeGroupsMap.entries()).map(([groupSeq, rows]) => ({
    groupSeq,
    representativeSeqNo: groupSeq,    // 代表行 = 最小 seq_no = groupSeq 自身
    rows: rows.slice().sort((a, b) => a.seqNo - b.seqNo)
  }));
  return {
    splitRows: completedRows.slice().sort((a, b) => a.seqNo - b.seqNo),
    standaloneRows,
    mergeGroups,
    reuseModuleMapping: Boolean(templateConfig.reuseModuleMapping),
    billSplitMappings: templateConfig.billSplitMappings || [],
    // Q-OT2 = B：以下两个字段独立读取
    billSplitAmountRules: Array.isArray(templateConfig.billSplitAmountRules)
      ? templateConfig.billSplitAmountRules
      : [],
    billSplitMeta: templateConfig.billSplitMeta || { signedAmountSourceField: '' }
  };
}
```

#### 5.5.3 `buildMappedRowsForFile` 透传

`src/main.js:3630-3649` 的 `buildMappedRowsForFile` 在调用 `buildMappedRows` 时透传 `amountSplitByField` 作为独立参数。v1.4.9 同样把 `billSplitMergeConfig` 作为独立参数透传：

```javascript
const result = await buildMappedRows({
  // ... v1.4.8 既有参数 ...
  amountSplitByField: statementConfig.amountSplitByField,
  // v1.4.9 新增
  billSplitMergeConfig: statementConfig.billSplitMergeConfig
});
```

### 5.6 `buildMappedRows` 拆分 / 合并执行分支

文件：`src/backend/file-service.js:41-91`（函数签名 + headers 校验起点）

#### 5.6.1 函数签名扩展

```javascript
function buildMappedRows({
  rows,
  headers,
  templateMappings,
  // ... v1.4.8 既有参数 ...
  amountSplitByField,
  billSplitMergeConfig,   // ← v1.4.9 新增
}) {
  // ...
}
```

#### 5.6.2 总体流程

```
                    +-----------------------------+
                    |   foreach originalRow       |
                    +-----------------------------+
                                  |
                  +---------------+----------------+
                  | billSplitMergeConfig 存在?      |
                  +---------------+----------------+
                       no |             | yes
                          v             v
              +------------------+   +-----------------------------+
              | v1.4.8 既有路径   |   | 1. 计算非金额字段（reuse 决定）|
              | （单行映射）       |   | 2. 按 splitRows 展开 N 拆分行 |
              +------------------+   | 3. 评估副区域规则             |
                                     | 4. 按 mergeGroups 合并        |
                                     | 5. 输出最终行                 |
                                     +-----------------------------+
```

#### 5.6.3 拆分阶段（每条原始行 → N 拆分行）

```javascript
function expandBillSplit(originalRow, headers, billSplitMergeConfig, templateMappings) {
  const { splitRows, billSplitMappings, billSplitAmountRules, billSplitMeta, reuseModuleMapping } = billSplitMergeConfig;
  // 1. 计算每份拆分账单的非金额字段（所有 N 份共享同一份非金额字段）
  const nonAmountFields = reuseModuleMapping
    ? mapNonAmountFieldsFromMain(originalRow, headers, templateMappings)
    : mapNonAmountFieldsFromBillSplitMappings(originalRow, headers, billSplitMappings);

  // 2. 按 splitRows 展开 N 拆分行
  const splitOutputRows = splitRows.map((splitRow) => {
    const baseFields = { ...nonAmountFields };
    const currency = readSourceFieldValue(originalRow, headers, splitRow.currencySourceField);
    let creditAmount = '';
    let debitAmount = '';

    // 副区域规则评估（Q-OT2 = B：按正负号 = billSplitMeta；按字段区分 = billSplitAmountRules）
    const hasSignedAmount = Boolean(billSplitMeta && billSplitMeta.signedAmountSourceField);
    const hasAmountSplitRules = Array.isArray(billSplitAmountRules) && billSplitAmountRules.length > 0;
    const useAmountSourceField = hasSignedAmount || hasAmountSplitRules;

    if (useAmountSourceField) {
      const amountValue = readSourceFieldValue(originalRow, headers, splitRow.amountSourceField);
      if (hasSignedAmount) {
        // 调用 v1.4.7 既有的 splitSignedAmountValue
        const { credit, debit } = splitSignedAmountValue(amountValue);
        creditAmount = credit;
        debitAmount = debit;
      } else {
        // hasAmountSplitRules：副区域的「按字段区分发生额」逻辑
        // 对 originalRow 评估 condition_field + condition_value 规则，决定 amountValue
        // 是落到 Credit 还是 Debit。复用 v1.4.8 evaluateAmountSplitByFieldRule(...) 逻辑。
        const result = evaluateBillSplitAmountRules(
          originalRow,
          headers,
          billSplitAmountRules,
          amountValue
        );
        creditAmount = result.credit;
        debitAmount = result.debit;
      }
    } else {
      // 副区域为空 → 直接从 splitRow.creditSourceField / debitSourceField 取
      creditAmount = readAmountValue(originalRow, headers, splitRow.creditSourceField);
      debitAmount = readAmountValue(originalRow, headers, splitRow.debitSourceField);
    }

    return {
      seqNo: splitRow.seqNo,
      mergedGroupSeq: splitRow.mergedGroupSeq,
      currency,
      creditAmount,
      debitAmount,
      ...baseFields
    };
  });

  return splitOutputRows;
}
```

`readSourceFieldValue` / `readAmountValue` 复用 v1.4.8 既有的 `sanitizeAmountValue` 处理管线（`src/backend/file-service.js` 既有 helper）。

`evaluateBillSplitAmountRules` 是新增的 helper，逻辑等同于 v1.4.8 的 `evaluateAmountSplitByFieldRule`，但使用副区域的 `billSplitMergeConfig.billSplitAmountRules`（Q-OT2 = B 后已扁平为规则数组）而不是主模板的 `amountSplitRules`。**复用** v1.4.8 既有 helper 的 condition matcher（含 `/pattern/flags` 正则识别），不要复制粘贴。

#### 5.6.4 合并阶段（按 mergeGroups 合并 K 拆分行 → 1 输出行）

> **2026-04-08 fix2 override**（对应代码 commit `6031f88 fix(v1.4.9): filter zero-amount rows silently`）：
>
> - **原决定**：合并组净值 = 0 时抛 `BILL_MERGE_NET_ZERO` 错误阻断整个导入流程。
> - **新决定**：合并组净值 = 0 时**静默跳过整个合并组**（不 push 到 `finalRows`），导入流程继续处理其他行/组。`BILL_MERGE_NET_ZERO` 错误码保留在错误码表中但代码永远不会抛出。
> - **同时新增**：`expandBillSplitForRow`（§5.6.3）在计算完每条拆分行的 credit/debit 后，若两者都为 0 / 空 / NaN，直接返回 `null` 并过滤掉，不输出该拆分行。
> - **独立行双保险**：`applyBillSplitMerge` 对 standalone 行（未参与合并组的拆分输出行）也再过滤一次 credit+debit 全 0 的情况，作为双保险兜底。
> - **保留不变**：Currency 不一致仍然抛 `BILL_MERGE_CURRENCY_MISMATCH` 阻断导入。
> - 详见 PRD §4.4.2 / §4.7.5、AC1-62 / AC1-62a / ACI-7 / ACI-7a 的 override 说明。

```javascript
// 2026-04-08 fix2 override 后的伪代码
function applyBillSplitMerge(splitOutputRows, billSplitMergeConfig) {
  const { mergeGroups } = billSplitMergeConfig;

  // 辅助：判断一行 credit 和 debit 是否都为 0 / 空 / NaN（fix2 新增）
  function isAllZero(row) {
    const c = parseNumericValue(row.creditAmount);
    const d = parseNumericValue(row.debitAmount);
    const czero = c === 0 || c === null || c === undefined || Number.isNaN(c);
    const dzero = d === 0 || d === null || d === undefined || Number.isNaN(d);
    return czero && dzero;
  }

  if (mergeGroups.length === 0) {
    // 未合并行双保险过滤 0 值（fix2 新增）
    return splitOutputRows.filter((row) => !isAllZero(row));
  }

  const mergedSeqs = new Set();
  for (const group of mergeGroups) {
    for (const row of group.rows) {
      mergedSeqs.add(row.seqNo);
    }
  }

  // 1. 未合并行原样输出（fix2：加 0 值过滤）
  const finalRows = splitOutputRows
    .filter((row) => !mergedSeqs.has(row.seqNo))
    .filter((row) => !isAllZero(row));

  // 2. 每个合并组 → 0 或 1 行
  for (const group of mergeGroups) {
    const groupRows = group.rows.map((r) => splitOutputRows.find((sr) => sr.seqNo === r.seqNo));

    // Step 1: Currency 一致性校验 (AC1-60 / ACI-6) — 保留
    const currencies = groupRows.map((r) => r.currency).filter(Boolean);
    const distinctCurrencies = new Set(currencies);
    if (distinctCurrencies.size > 1) {
      throw createImportError(
        'BILL_MERGE_CURRENCY_MISMATCH',
        '合并账单的 Currency 不一致，无法合并'
      );
    }

    // Step 2: 金额求和
    const sumCredit = groupRows.reduce((acc, r) => acc + safeNumber(r.creditAmount), 0);
    const sumDebit = groupRows.reduce((acc, r) => acc + safeNumber(r.debitAmount), 0);

    // Step 3: 净值与方向判定（fix2 override：净值=0 静默跳过，不再 throw）
    const net = sumCredit - sumDebit;
    if (net === 0) {
      continue;  // 2026-04-08 fix2: 整个组不产生输出行，不报错
    }

    // Step 4: 非金额字段从代表行取
    const representativeSplitRow = groupRows.find((r) => r.seqNo === group.representativeSeqNo)
      || groupRows[0];
    const mergedRow = {
      ...representativeSplitRow,
      creditAmount: net > 0 ? Math.abs(net).toString() : '',
      debitAmount: net < 0 ? Math.abs(net).toString() : '',
      currency: distinctCurrencies.size === 1 ? Array.from(distinctCurrencies)[0] : ''
    };
    finalRows.push(mergedRow);
  }

  // 按代表行 seqNo 排序输出，保持稳定顺序
  return finalRows.sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));
}
```

`expandBillSplitForRow`（§5.6.3）对应的 fix2 改动：

```javascript
// §5.6.3 pseudo — fix2 override: 0 值静默过滤
return billSplitRows
  .map((splitRow) => {
    // ... 原 expand 逻辑（currency / credit / debit / amount source field 取值）...

    // fix2 新增: credit 和 debit 都为 0 → 返回 null 丢弃
    const creditNum = parseNumericValue(creditValue);
    const debitNum = parseNumericValue(debitValue);
    if ((creditNum === 0 || creditNum === null || creditNum === undefined || Number.isNaN(creditNum))
        && (debitNum === 0 || debitNum === null || debitNum === undefined || Number.isNaN(debitNum))) {
      return null;
    }

    return { seqNo, mergedGroupSeq, currency, creditAmount, debitAmount, rowArray, sourceRowNumber };
  })
  .filter((r) => r !== null);
```

#### 5.6.5 全部行未命中告警的扩展

PRD §4.7.5「全部行未命中」沿用 v1.4.8 §3.4.3 的多文件聚合机制。`buildMappedRows` 内部维护的计数器（`src/backend/file-service.js:67-68` 周边的 `matchedCreditCount` / `matchedDebitCount`）需要扩展为：

```javascript
let matchedCreditCount = 0;
let matchedDebitCount = 0;
let matchedBillSplitCount = 0;     // ← v1.4.9 新增

// 在拆分 / 合并分支内部
if (billSplitMergeConfig && finalRows.length > 0) {
  matchedBillSplitCount += finalRows.length;
}
```

返回结构里追加：

```javascript
return {
  rows: finalOutputRows,
  hasCreditAmount: matchedCreditCount > 0,
  hasDebitAmount: matchedDebitCount > 0,
  hasBillSplitOutput: matchedBillSplitCount > 0,    // ← v1.4.9 新增
  // ...
};
```

`buildMappedRowsForFile` 在外层判定"全部行未命中"时：

```javascript
const hasAnyOutput = result.hasCreditAmount || result.hasDebitAmount || result.hasBillSplitOutput;
if (!hasAnyOutput) {
  // 加入 v1.4.8 既有的"全部未命中"告警聚合
  unmatchedFiles.push(file.name);
}
```

`unmatchedFiles` 数组的 UI 提示文案在 v1.4.8 已有"以下文件全部未命中映射规则"。v1.4.9 把这个文案改为统一版本：

```
以下文件全部未命中映射 / 拆分 / 合并规则，请检查规则配置：
file1.csv
file5.csv
```

文案改动落在 `src/main.js` 中聚合告警的位置（v1.4.8 既有逻辑）。

#### 5.6.6 头字段缺失校验

PRD ACI-10：「源文件 headers 中不存在弹框 2 配置中选定的某列 → 报错 `映射字段不存在：{字段名}`」。

`src/backend/file-service.js:78-91` 已有针对主模板 `mappings` 的 header 存在性校验抛错 `映射字段不存在：${field}`。v1.4.9 在这之后追加：

```javascript
if (billSplitMergeConfig) {
  const requiredFields = new Set();
  for (const splitRow of billSplitMergeConfig.splitRows) {
    if (splitRow.currencySourceField) requiredFields.add(splitRow.currencySourceField);
    if (splitRow.creditSourceField) requiredFields.add(splitRow.creditSourceField);
    if (splitRow.debitSourceField) requiredFields.add(splitRow.debitSourceField);
    if (splitRow.amountSourceField) requiredFields.add(splitRow.amountSourceField);
  }
  // Q-OT2 = B：按正负号 = billSplitMeta；按字段区分 = billSplitAmountRules（已扁平为数组）
  if (billSplitMergeConfig.billSplitMeta && billSplitMergeConfig.billSplitMeta.signedAmountSourceField) {
    requiredFields.add(billSplitMergeConfig.billSplitMeta.signedAmountSourceField);
  }
  for (const rule of (billSplitMergeConfig.billSplitAmountRules || [])) {
    if (rule.conditionField) requiredFields.add(rule.conditionField);
    if (rule.mappedField) requiredFields.add(rule.mappedField);
  }
  // billSplitMappings 的 mappedField 同样需要校验（仅当 reuseModuleMapping = false 时）
  if (!billSplitMergeConfig.reuseModuleMapping) {
    for (const mapping of billSplitMergeConfig.billSplitMappings) {
      if (mapping.mappedField) requiredFields.add(mapping.mappedField);
      if (Array.isArray(mapping.mappedFields)) {
        for (const f of mapping.mappedFields) requiredFields.add(f);
      }
    }
  }
  for (const field of requiredFields) {
    if (!headers.includes(field)) {
      throw new Error(`映射字段不存在：${field}`);
    }
  }
}
```

---

## 六、Bundle 导出 / 导入

### 6.1 `bundleVersion` 升级

`src/main.js` 顶部常量：`SUPPORTED_BUNDLE_VERSION` 从 `2` 改为 `3`。

`readTemplateBundleFile`（`src/main.js:925-964`）的版本校验保持不变，因为 v1.4.8 已实现的 `if (bundleVersion > SUPPORTED_BUNDLE_VERSION)` 逻辑会自动生效（PRD AC1-81：v1.4.8 读取 v1.4.9 bundle 报错拒绝是 v1.4.8 的预埋机制，**不需要**在 v1.4.9 端做任何事）。

### 6.2 v1.4.9 写入 bundle 的字段

`listTemplateBundleEntries`（详见 §3.7）扩展后，每个 entry 在 JSON 输出中追加：

```json
{
  "templateKey": "...",
  "name": "...",
  "sourceFileName": "...",
  "headers": ["..."],
  "mappings": [
    {
      "templateField": "MerchantId",
      "mappedField": "...",
      "mappedFields": []
    },
    {
      "templateField": "是否拆分/合并明细账单",
      "mappedField": "是",
      "mappedFields": []
    },
    {
      "templateField": "复用模块字段的映射关系",
      "mappedField": "否",
      "mappedFields": []
    }
  ],
  "bigAccounts": [...],
  "fixedAssignments": [...],
  "amountSplitRules": [...],
  "billSplitMappings": [
    {"templateField": "BillDate", "mappedField": "...", "mappedFields": [], "rowIndex": 0},
    ...
  ],
  "billSplitRows": [
    {
      "seqNo": 1,
      "currencySourceField": "...",
      "creditSourceField": "...",
      "debitSourceField": "...",
      "amountSourceField": "",
      "rowStatus": "completed",
      "mergedGroupSeq": null
    },
    ...
  ],
  "billSplitAmountRules": [
    {"targetField": "Credit Amount", "conditionField": "...", "conditionValue": "...", "mappedField": "...", "rowIndex": 0},
    ...
  ],
  "billSplitMeta": {
    "signedAmountSourceField": ""
  },
  "dateFormat": "auto",
  "createdAt": "...",
  "updatedAt": "..."
}
```

bundle 顶层：

```json
{
  "bundleVersion": 3,
  "exportedAt": "...",
  "templates": [ /* entries */ ]
}
```

### 6.3 v1.4.9 读取 bundle 的导入路径

`template:import-bundle` handler（`src/main.js:3174-3317`）在每个 entry 处理时追加 v1.4.9 字段的读取与落库。

#### 6.3.1 normalize 入参

在 v1.4.8 既有的 `normalizedAmountSplitRules` 计算（`src/main.js:3245-3255`）之后追加：

```javascript
// v1.4.9 新增 normalize
const normalizedBillSplitMappings = Array.isArray(entry.billSplitMappings)
  ? entry.billSplitMappings.map((m, idx) => ({
      templateField: typeof m.templateField === 'string' ? m.templateField : '',
      mappedField: typeof m.mappedField === 'string' ? m.mappedField : '',
      mappedFields: Array.isArray(m.mappedFields) ? m.mappedFields.map(String) : [],
      rowIndex: Number.isInteger(m.rowIndex) ? m.rowIndex : idx
    }))
  : [];

const normalizedBillSplitRows = Array.isArray(entry.billSplitRows)
  ? entry.billSplitRows.map((r) => ({
      seqNo: Number(r.seqNo),
      currencySourceField: typeof r.currencySourceField === 'string' ? r.currencySourceField : '',
      creditSourceField: typeof r.creditSourceField === 'string' ? r.creditSourceField : '',
      debitSourceField: typeof r.debitSourceField === 'string' ? r.debitSourceField : '',
      amountSourceField: typeof r.amountSourceField === 'string' ? r.amountSourceField : '',
      rowStatus: r.rowStatus === 'completed' ? 'completed' : 'draft',
      mergedGroupSeq: r.mergedGroupSeq === null || r.mergedGroupSeq === undefined ? null : Number(r.mergedGroupSeq)
    }))
  : [];

// Q-OT2 = B：billSplitAmountRules 在 v3 bundle 中是扁平数组
const normalizedBillSplitAmountRules = Array.isArray(entry.billSplitAmountRules)
  ? entry.billSplitAmountRules.map((rule, idx) => ({
      targetField: typeof rule.targetField === 'string' ? rule.targetField : '',
      conditionField: typeof rule.conditionField === 'string' ? rule.conditionField : '',
      conditionValue: typeof rule.conditionValue === 'string' ? rule.conditionValue : '',
      mappedField: typeof rule.mappedField === 'string' ? rule.mappedField : '',
      rowIndex: Number.isInteger(rule.rowIndex) ? rule.rowIndex : idx
    }))
  : (
      // v2 → v3 兼容：v2 bundle（如果存在）的 billSplitAmountRules 是嵌套对象
      // 但 v2 实际上完全不存在 billSplitAmountRules 字段（v1.4.8 的 bundle 没有 bill-split），
      // 所以这个分支只会在用户手动构造畸形 v3 bundle 时触发，fallback 为空数组。
      []
    );

// Q-OT2 = B 新增：单独 normalize billSplitMeta
const normalizedBillSplitMeta = entry.billSplitMeta && typeof entry.billSplitMeta === 'object'
  ? {
      signedAmountSourceField: typeof entry.billSplitMeta.signedAmountSourceField === 'string'
        ? entry.billSplitMeta.signedAmountSourceField
        : ''
    }
  : { signedAmountSourceField: '' };
```

#### 6.3.2 bundle import 落库

在 v1.4.8 的 `database.saveMappings(...)` 调用之后追加：

```javascript
// v1.4.9 新增 ↓ 全量覆盖（不像 saveMappings 的"不传不动"语义；import bundle 是整体覆盖动作）
database.saveBillSplitMappings(templateId, normalizedBillSplitMappings);

// 先清空 row 表，再按 normalizedBillSplitRows 整体重建
database.saveBillSplitRowCount(templateId, 0);   // 清空
if (normalizedBillSplitRows.length > 0) {
  database.saveBillSplitRowCount(templateId, normalizedBillSplitRows.length);
  for (const row of normalizedBillSplitRows) {
    database.saveBillSplitRow(templateId, row);
  }
  // 重建合并组关系
  const groupMap = new Map();   // groupSeq → seqNo[]
  for (const row of normalizedBillSplitRows) {
    if (row.mergedGroupSeq !== null) {
      if (!groupMap.has(row.mergedGroupSeq)) groupMap.set(row.mergedGroupSeq, []);
      groupMap.get(row.mergedGroupSeq).push(row.seqNo);
    }
  }
  for (const [, seqNos] of groupMap) {
    if (seqNos.length >= 2) {
      database.saveBillSplitMergeGroup(templateId, seqNos);
    }
  }
}

// Q-OT2 = B：拆分为两次独立写入
database.saveBillSplitAmountRules(templateId, normalizedBillSplitAmountRules);
database.saveBillSplitMeta(templateId, {
  signedAmountSourceField: normalizedBillSplitMeta.signedAmountSourceField
});
```

> **注意**：这里 `saveBillSplitRowCount(templateId, 0)` 调用会触发 §3.4.3 中"N 减小"分支，把所有现有 bill-split rows 删除（因为 nextN < currentM）。但是 `saveBillSplitRowCount` 内部 `if (nextN > currentM)` 与 `else if (nextN < currentM)` 的判定要求 nextN >= 1 才能进入"增加"分支，所以这里需要扩展 `saveBillSplitRowCount` 的处理边界让 nextN === 0 时也能正确清空：

```javascript
// 在 saveBillSplitRowCount 内部增加 nextN === 0 的处理
if (nextN === 0) {
  // 清空所有 rows，但仍要解散合并组（虽然行也被删除了）
  db.prepare('DELETE FROM template_bill_split_rows WHERE template_id = ?').run(templateId);
  db.exec('COMMIT');
  return;
}
```

但是 IPC handler `template:save-bill-split-row-count` 仍然限制 `1 ≤ nextN ≤ 99`（这是 UI 规则）。bundle 导入时直接调用 repository 函数，绕过 IPC 层，因此 `nextN === 0` 是 bundle 导入路径的合法值。

### 6.4 旧版本 bundle 兼容

#### 6.4.1 v1.4.9 读取 v1.4.8 bundle（`bundleVersion = 2`）— AC1-80

在 §6.3.1 的 normalize 步骤中，所有 v1.4.9 新字段 (`entry.billSplitMappings` / `entry.billSplitRows` / `entry.billSplitAmountRules` / `entry.billSplitMeta`) 在 v1.4.8 bundle 中**都不存在**，会被 normalize 函数 fallback 为空数组 / 空对象。落库时：

- `saveBillSplitMappings(templateId, [])` → DELETE 然后不 INSERT，等价于"清空"。但因为模板是新导入的（先 upsertTemplate），表中本来就没有数据，DELETE 是 noop。
- `saveBillSplitRowCount(templateId, 0)` → 清空（同上 noop）。
- `saveBillSplitAmountRules(templateId, [])` → 清空 `template_bill_split_amount_rules` 表（noop）。
- `saveBillSplitMeta(templateId, { signedAmountSourceField: '' })` → upsert `template_bill_split_meta` 表写入 1 行 `signed_amount_source_field = ''`。本行虽然存在但语义为"未配置"，不会触发副区域逻辑。

主模板的两个开关 (`是否拆分/合并明细账单` / `复用模块字段的映射关系`) 在 v1.4.8 bundle 的 `mappings` 数组中**不存在**，因此导入后 `template_mappings` 表里也不会有这两行 → 读取时 `enabledFromMappings` fallback 到默认值（开关 = `否`，复用 = `是`）。AC1-80 满足。

#### 6.4.2 v1.4.8 读取 v1.4.9 bundle（`bundleVersion = 3`）— AC1-81

完全由 v1.4.8 既有的 `readTemplateBundleFile` 校验 `bundleVersion > SUPPORTED_BUNDLE_VERSION` 报错。v1.4.9 不需要做任何事。

#### 6.4.3 v1.4.7 及以下读取 v1.4.9 bundle — AC1-82

v1.4.7 没有 `bundleVersion` 校验机制（v1.4.8 才引入），会**静默忽略** v1.4.9 新字段，继承 v1.4.8 的已知限制。v1.4.9 不需要做任何事。

---

## 七、前端改动

### 7.1 `createMappingDialog` 扩展（`src/renderer-dialogs.js:1470`）

#### 7.1.1 payload 读取新字段

`createMappingDialog` 当前在 `src/renderer-dialogs.js:1484-1492` 处从 payload 读取 `currentAmountSplitRules` 等状态。v1.4.9 在此追加：

```javascript
// v1.4.9 新增状态
let currentBillSplitMergeEnabled =
  (payload.mappings || []).find((m) => m.templateField === '是否拆分/合并明细账单')?.mappedField === '是';
let currentReuseModuleMapping =
  ((payload.mappings || []).find((m) => m.templateField === '复用模块字段的映射关系')?.mappedField || '是') === '是';
// 弹框 1 / 弹框 2 数据由外层 payload 直接携带（从 template:get-bill-split-config 或 getTemplateMappings 带过来）
let currentBillSplitMappings = Array.isArray(payload.billSplitMappings) ? payload.billSplitMappings : [];
let currentBillSplitRows = Array.isArray(payload.billSplitRows) ? payload.billSplitRows : [];
// Q-OT2 = B：拆分为两个独立状态
let currentBillSplitAmountRules = Array.isArray(payload.billSplitAmountRules) ? payload.billSplitAmountRules : [];
let currentBillSplitMeta = payload.billSplitMeta || { signedAmountSourceField: '' };
```

#### 7.1.2 「账单拆分合并管理」分组渲染

在 `createMappingDialog` 的主表格渲染循环（`src/renderer-dialogs.js:1524` 处的 `payload.targetFields.forEach(...)`）之后，渲染「映射关系设置」分组；在该分组末尾紧接**新分组**「账单拆分合并管理」：

```javascript
// 在「映射关系设置」分组（ADVANCED_MAPPING_FIELDS 那几行）之后
const billSplitGroupHeader = document.createElement('div');
billSplitGroupHeader.className = 'mapping-group-header';
billSplitGroupHeader.textContent = '账单拆分合并管理';
tableBody.appendChild(billSplitGroupHeader);

// 第一行：是否拆分/合并明细账单
const enabledRow = createMappingRow({
  label: '是否拆分/合并明细账单',
  type: 'dropdown',
  options: ['', '是'],
  value: currentBillSplitMergeEnabled ? '是' : '',
  buttonLabel: currentBillSplitMergeEnabled ? '拆分/合并账单映射关系管理' : null,
  onChange: (next) => { /* ... 见 §7.1.3 ... */ },
  onButtonClick: () => openBillSplitRowsDialog()
});
tableBody.appendChild(enabledRow);

// 第二行：复用模块字段的映射关系
const reuseRow = createMappingRow({
  label: '复用模块字段的映射关系',
  type: 'dropdown',
  options: ['是', '否'],
  value: currentReuseModuleMapping ? '是' : '否',
  buttonLabel: currentReuseModuleMapping ? null : '拆分/合并账单映射关系设置',
  onChange: (next) => { /* ... 见 §7.1.3 ... */ },
  onButtonClick: () => openBillSplitMappingsDialog()
});
tableBody.appendChild(reuseRow);
```

> **注意**：`createMappingRow` 是一个 Dev 在 task #4 实施阶段可以新建的 helper，或者直接沿用现有的 `document.createElement('tr')` + `cells` 拼装流程。本 TechDoc 不强制命名。

#### 7.1.3 开关的 onChange 处理

**「是否拆分/合并明细账单」的 onChange**：

```javascript
async (next) => {
  const enabling = next === '是';
  if (enabling) {
    // 4 方互斥：清空其它 3 种模式的字段 (AC1-65 / AC1-66 / AC1-67 / AC1-68 / AC1-69 / AC1-70)
    clearMappingForField('Currency');
    clearMappingForField('Credit Amount');
    clearMappingForField('Debit Amount');
    clearMappingForField('按正负号拆分的发生额');
    clearMappingForField('按字段区分发生额');
    currentAmountSplitRules = [];  // 同时清空 v1.4.8 的 template_amount_split_rules（落库时由 template:save-mappings 的 v1.4.8 逻辑走，因为 amountSplitByField 开关变 '' 会触发）
    // disable 5 行（加 tooltip）
    applyBillSplitMergeMutualExclusion(true);
  } else {
    // 切回否：解除 disable 但值已被清空（AC1-72）
    applyBillSplitMergeMutualExclusion(false);
  }
  currentBillSplitMergeEnabled = enabling;
  // 更新按钮显隐
  toggleButtonVisibility(enabledRow, enabling ? '拆分/合并账单映射关系管理' : null);
  // 这一步不直接落库（主 save-mappings 走 "完成" 按钮路径，与 v1.4.8 一致）
}
```

**「复用模块字段的映射关系」的 onChange**：

```javascript
async (next) => {
  currentReuseModuleMapping = next === '是';
  toggleButtonVisibility(reuseRow, next === '否' ? '拆分/合并账单映射关系设置' : null);
  // 同样不直接落库，跟随主 save-mappings 路径
}
```

#### 7.1.4 `applyBillSplitMergeMutualExclusion(enabled)` — 4 方互斥 UI 侧

新增 helper：

```javascript
function applyBillSplitMergeMutualExclusion(enabled) {
  const mutexFields = [
    'Currency',
    'Credit Amount',
    'Debit Amount',
    '按正负号拆分的发生额',
    '按字段区分发生额'
  ];
  for (const field of mutexFields) {
    const row = findMappingRowByTemplateField(field);
    if (!row) continue;
    const select = row.querySelector('.mapping-field-select');
    if (enabled) {
      select.value = '';
      select.disabled = true;
      row.setAttribute('data-tooltip', '已开启拆分/合并明细账单，本字段不可用');
      row.classList.add('mapping-row-disabled');
    } else {
      select.disabled = false;
      row.removeAttribute('data-tooltip');
      row.classList.remove('mapping-row-disabled');
      // 注意：不自动恢复值（AC1-72 要求值已清空）
    }
  }
}
```

> **关键设计**（吸取 v1.4.8 教训）：这是**单向互斥**。开启「是否拆分/合并明细账单」→ 禁用其它 4 种；关闭 → 解除禁用。**不**反过来给其它 4 种模式也加锁去禁用「是否拆分/合并明细账单」。**理由**：
>
> - v1.4.8 `applyAmountSplitMutualExclusion`（`src/renderer-dialogs.js:1758-1792`）已经是前向互斥，代码注释 1782-1785 明确解释"不做反向互斥"。这是历次 code review 反复确认的 invariant。
> - 反向互斥（即在 Credit Amount 有值时把「是否拆分/合并明细账单」的"是"选项隐藏或 disable）会导致用户改变思路时必须先清空原配置才能切到另一种模式，UX 不友好；现行 UX 让用户只要选目标模式，系统就自动清空原配置。
> - 保存阶段由 `validateTemplateConfiguration` 兜底（4 方 `enabledAmountModes > 1` 报错），UI 层的前向互斥已足够。
>
> **Dev 在 task #4 实施阶段注意**：请勿给 v1.4.9 新增任何反向互斥逻辑，哪怕看起来"更安全"——这是 v1.4.8 的 lesson learned，PRD 没要求就不加。

v1.4.8 既有的 `applyAmountSplitMutualExclusion`（`src/renderer-dialogs.js:1758`）继续存在，**但在 v1.4.9 有一处协作性改动**——它处理的是 `Credit Amount` / `Debit Amount` / `按正负号拆分的发生额` 三个字段之间的互斥，v1.4.9 新增的 `applyBillSplitMergeMutualExclusion` 覆盖的是"拆分合并 vs 前三方"的互斥。

> **2026-04-08 fix2（Fix #3，commit `8041619`）：`applyAmountSplitMutualExclusion` 需要 bill-split-merge 启用时 early-return**
>
> 原始实施（v1.4.9 第一版）存在一个调用顺序 bug：`applyBillSplitMergeMutualExclusion(true)` 在循环结束时调用 `applyAmountSplitMutualExclusion()`，后者无条件进入 `else` 分支把 `Credit Amount` / `Debit Amount` / `按正负号` 三个 select 的 `disabled` 置回 `false`，**覆盖**了 4 方互斥刚刚设置的 disabled 状态，导致用户反馈的「互斥禁用不生效」bug。
>
> 修复方式：
> 1. `applyAmountSplitMutualExclusion` **顶部 early-return**：当 `isBillSplitMergeEnabledInTable()` 返回 true 时直接 noop，让 4 方互斥独占 5 行的 disabled 状态。
> 2. `applyBillSplitMergeMutualExclusion(false)` 才重新调用 `applyAmountSplitMutualExclusion()`（关闭 4 方互斥后恢复 2 方互斥）。
> 3. `applyBillSplitMergeMutualExclusion(true)` 同时**显式禁用行内所有按钮**（big-account 维护 / 发生额规则管理 / concat trigger），通过 `data-bill-split-merge-disabled='true'` 标记；解除时只恢复被本函数禁用的按钮。
> 4. 新增辅助函数 `isBillSplitMergeEnabledInTable()` 读取当前 select 值。

#### 7.1.5 主表格 `Currency` / 金额字段的显示规则

进入 `createMappingDialog` 时，如果 `currentBillSplitMergeEnabled === true`，**立即**调用 `applyBillSplitMergeMutualExclusion(true)`。这个调用点放在 `payload.targetFields.forEach` 循环结束之后 + 所有行 DOM 已插入之后。

### 7.2 弹框 1：`createBillSplitMappingsDialog`（新增）

文件位置：`src/renderer-dialogs.js`（紧邻 `createAmountSplitRulesDialog` 之后）

#### 7.2.1 签名

```javascript
function createBillSplitMappingsDialog({
  template,                      // 主模板对象（含 targetFields / headers / 既有主映射）
  initialMappings,               // 弹框 1 的初始数据，来自 template:get-bill-split-config
  mainTemplateMappings,          // 主模板当前映射（用于「导入当前映射关系」按钮）
  onDone,                        // 保存成功后的回调（父弹框调用 refreshState）
  onCancel                       // 弹框关闭回调
}) { /* ... */ }
```

#### 7.2.2 DOM 结构

```
+----------------------------------------------------------------+
| 拆分/合并账单映射关系设置      [导入当前映射关系]  [x]          |
+----------------------------------------------------------------+
| 模板字段             | 映射字段                                |
+----------------------+-----------------------------------------+
| <targetField 1>     | <select/input reused from main dialog> |
| <targetField 2>     | <select/input reused from main dialog> |
| ...                                                           |
+----------------------+-----------------------------------------+
|                                                       [完成]   |
+----------------------------------------------------------------+
```

- 弹框尺寸：~~主 `createMappingDialog` 的 50%（`width: 50%; max-width: 500px;`）~~ **2026-04-08 fix2 override**：改为 `width: 80vw; min-width: 520px; max-width: none;`（commit `3eaaf14`），原设计"主弹框的一半"在用户实测后发现不足以容纳完整的字段映射表格，基于用户反馈扩大；`max-width: none` 必须显式写以覆盖 `.modal-card` 的 `width: min(100%, 940px)` 默认约束。CSS 类名实际采用 `.bill-split-mappings-card`。
- 标题：`拆分/合并账单映射关系设置`（AC1-12）。
- 右上角按钮：`导入当前映射关系`（AC1-13）。
- 表格行枚举：`template.targetFields.filter((f) => f !== 'Currency' && f !== 'Credit Amount' && f !== 'Debit Amount' && !ADVANCED_MAPPING_FIELDS.includes(f) && !BILL_SPLIT_GROUP_FIELDS.includes(f))`（AC1-15，同时排除 v1.4.7/8 的高级字段 + v1.4.9 bill-split group 字段）。
- 「映射字段」列复用主弹框的单元格工厂（包括拼接字段 / 自己输入所有形式，AC1-16）。**关键**：这里不能 `cloneNode` DOM（参考 PRD NFR-6 + v1.4.7 ghost shell 教训）；要重新调用 factory 函数构造。
- **`Balance` 字段选项**（**2026-04-08 fix2 澄清**）：弹框 1 的 Balance 行选项**与主表格 Balance 行一致**——`BALANCE_DISABLED_OPTION`（`'无'`）+ `BALANCE_CALCULATED_OPTION`（`'通过发生额计算'`）+ `template.headers`，默认值为 `BALANCE_DISABLED_OPTION`；Balance 行**不渲染 concat-field-picker DOM**（`supportsMultiSelect = !isCurrencyLike && !isBalanceField`）。后端 `validateBillSplitMappingsPayload` 对 Balance 字段加 `isBalanceSpecialValue` 旁路，允许 `BALANCE_DISABLED_OPTION` / `BALANCE_CALCULATED_OPTION` 跳过 header 存在性校验（commit `cb127c0`）。

#### 7.2.3 「导入当前映射关系」按钮逻辑（AC1-17 / AC1-18）

```javascript
importButton.addEventListener('click', () => {
  const hasExistingData = currentDialogMappings.some(
    (m) => m.templateField && (m.mappedField || (m.mappedFields && m.mappedFields.length > 0))
  );
  if (hasExistingData) {
    // 二次确认
    showConfirmDialog({
      title: '确认覆盖',
      message: '确认覆盖弹框中已有的配置？',
      onConfirm: () => {
        overwriteFromMainMappings();
        rerenderDialog();
      }
    });
  } else {
    overwriteFromMainMappings();
    rerenderDialog();
  }
});

function overwriteFromMainMappings() {
  const mainMappings = mainTemplateMappings
    .filter((m) =>
      m.templateField !== 'Currency' &&
      m.templateField !== 'Credit Amount' &&
      m.templateField !== 'Debit Amount' &&
      !ADVANCED_MAPPING_FIELDS.includes(m.templateField) &&
      m.templateField !== BILL_SPLIT_MERGE_MAPPING_FIELD &&
      m.templateField !== REUSE_MODULE_MAPPING_FIELD
    )
    .map((m) => ({
      templateField: m.templateField,
      mappedField: m.mappedField,
      mappedFields: Array.isArray(m.mappedFields) ? m.mappedFields.slice() : []
    }));
  currentDialogMappings = mainMappings;
}
```

#### 7.2.4 「完成」按钮（AC1-19）

```javascript
doneButton.addEventListener('click', async () => {
  try {
    // 前端校验
    validateLocalMappings(currentDialogMappings);  // 同字段不可重复
    // IPC 直接落库
    await window.desktopApi.templates.saveBillSplitMappings(template.id, currentDialogMappings);
    onDone(currentDialogMappings);
    closeDialog();
  } catch (error) {
    showErrorMessage(error.message);
    // 不关闭弹框，不丢失已填字段
  }
});
```

### 7.3 弹框 2：`createBillSplitRowsDialog`（新增）

文件位置：`src/renderer-dialogs.js`

#### 7.3.1 签名

```javascript
function createBillSplitRowsDialog({
  template,
  initialRows,                   // 初始 billSplitRows (含 draft/completed/merged_group_seq)
  initialAmountRules,            // 初始副区域「按字段区分发生额」规则数组
  initialBillSplitMeta,          // 初始副区域「按正负号拆分的发生额」配置 { signedAmountSourceField } —— Q-OT2 = B 新增
  onClose                        // 仅在弹框 x 或 ESC 时调用（AC1-28：关闭不额外落库）
}) { /* ... */ }
```

#### 7.3.2 DOM 结构（对照 PRD §4.3 ASCII 图）

```
+----------------------------------------------------------------+
| 拆分/合并账单映射关系管理   [✓ 合并账单] [请选择▾] [完成]  [x]  |
+----------------------------------------------------------------+
| 需要拆分成几份账单 [ 3 ] [拆]                                   |
|                                                                |
| +------+----------+-------------+------------+--------+-----+|
| |账单序号| Currency | Credit Amt  | Debit Amt  | 发生额|操作 ||
| +------+----------+-------------+------------+--------+-----+|
| |  1   | [AMT1_C] | [AMT1_C]    | [  ]       | [disa.]|完 删||
| |  2   | [AMT2_C] | [AMT2_C]    | [  ]       | [disa.]|完 删||
| |  3   | [JPY_C]  | [JPY_AMT]   | [  ]       | [disa.]|完 删||
| +------+----------+-------------+------------+--------+-----+|
|                                                                |
| --------------------- 页面中线 ---------------------           |
|                                                                |
| 拆分/合并账单——发生额映射关系管理                            |
|                                                                |
| 按正负号拆分的发生额  [          ▾]                          |
| 按字段区分发生额      [          ▾]  [发生额映射关系管理]      |
|                                                                |
|                                                       [完成]   |
+----------------------------------------------------------------+
```

> **2026-04-08 fix2 override**（对应 commit `fc91550` / `04a2e21` / `57dbd38`）：
>
> 1. **合并下拉框改为 checkbox-panel picker**（Fix #1，`fc91550`）：
>    - 原设计：`<select class="mapping-select bill-split-merge-dropdown" multiple hidden>`
>    - 新设计：`<div class="bill-split-merge-picker">` 包裹 `bill-split-merge-picker-trigger`（按钮）和 `bill-split-merge-picker-panel`（浮层 checkbox 列表），复用 concat-picker 模式。
>    - 原因：`<select multiple>` 被 `.mapping-select { height: 44px }` 挤压成单行无法多选。
>    - trigger 文本动态显示 `请选择账单序号` / `已选: 1, 2` / `已选: N 项`（> 5 项切换到计数）。
>    - dialog 上注册 `mousedown` 外部点击 → 关闭 panel（与 concat-picker 相同的惯例）。
>    - 前端状态 `mergeSelectedSeqNos: number[]` 代替原 `selectedOptions` 读取。
>
> 2. **「需要拆分成几份账单」按钮文本 + 宽度**（Fix #8，`57dbd38`）：
>    - 按钮文本从 `完成` 改为 `拆`。
>    - 按钮宽度：通过 CSS `.bill-split-row-count-done-btn.secondary-btn.small { min-width: 0; width: 71px; padding: 0 8px; }` 覆盖 `.small { min-width: 108px }`，达到原宽度的 ≈66%。
>    - 原因：用户反馈新增的底部「完成」按钮（Fix #7）和此处按钮的 `完成` 文案重复，基于用户要求改名避免混淆。
>
> 3. **弹框 2 右下角新增「完成」按钮**（Fix #7，`04a2e21`）：
>    - 新增 `<div class="dialog-actions right bill-split-rows-footer">` 包裹 `<button class="primary-btn small bill-split-rows-done-btn">完成</button>`，位置在 `bill-split-rows-body` 之外、弹框底部。
>    - 点击事件**语义等同 × 关闭**：调 `onClose` 回调 + 关闭 modal，**不做任何额外 save 动作**（所有改动仍是行级落库）。
>    - 对应 PRD §4.3.5 override、Q-C12 override、AC1-27 override、AC1-27a 新增。
>    - 原 PRD Q-C12 = B 明确"弹框 2 没有弹框级完成按钮"，本次 override 是用户实测后主动要求的交互回调（提供一个显式"我已完成"的关闭入口），不破坏行级落库语义。

#### 7.3.3 顶部：`需要拆分成几份账单` 数字框 + `拆` 按钮（AC1-23 / AC1-24 / AC1-25 / AC1-26 / AC1-37 / AC1-38 / AC1-39 / AC1-50）

> **2026-04-08 fix2 override**：按钮文本从 `完成` 改为 `拆`（commit `57dbd38`），避免与弹框 2 右下角新增的「完成」按钮（commit `04a2e21`）重复混淆。按钮宽度通过 CSS 覆盖为原 `.small` 宽度的 66%（108px → 71px）。

```javascript
const nInput = document.createElement('input');
nInput.type = 'number';
nInput.min = '1';
nInput.max = '99';
nInput.value = String(currentRows.length || 1);
nInput.addEventListener('input', () => {
  // 拒绝非数字 / 超界
  const v = Number(nInput.value);
  if (!Number.isInteger(v) || v < 1 || v > 99) {
    nInput.setCustomValidity('必须为 1~99 之间的整数');
  } else {
    nInput.setCustomValidity('');
  }
});

const nDoneButton = document.createElement('button');
nDoneButton.textContent = '拆';  // 2026-04-08 fix2: 原文本为 '完成'
nDoneButton.addEventListener('click', async () => {
  const nextN = Number(nInput.value);
  if (!Number.isInteger(nextN) || nextN < 1 || nextN > 99) {
    showErrorMessage('拆分账单份数必须为 1~99 之间的整数');
    return;
  }
  const currentM = currentRows.length;
  if (nextN < currentM) {
    // 二次确认
    showConfirmDialog({
      title: '确认删除',
      message: `确认删除最下方的 ${currentM - nextN} 行？已填数据会丢失`,
      onConfirm: async () => {
        await persistNAndRefresh(nextN);
      }
    });
  } else if (nextN > currentM) {
    await persistNAndRefresh(nextN);
  }
  // nextN === currentM 无动作
});

async function persistNAndRefresh(nextN) {
  const { currentRows: nextRows } = await window.desktopApi.templates
    .saveBillSplitRowCount(template.id, nextN);
  currentRows = nextRows;
  rerenderTable();
}
```

#### 7.3.4 六列表格（AC1-29 ~ AC1-44）

表格行的渲染函数：

```javascript
function renderRowCells(row) {
  const tr = document.createElement('tr');
  // 账单序号（只读）
  const seqCell = document.createElement('td');
  seqCell.textContent = row.mergedGroupSeq !== null ? String(row.mergedGroupSeq) : String(row.seqNo);
  tr.appendChild(seqCell);

  // Currency / Credit / Debit / 发生额 四个 select
  const fields = ['currencySourceField', 'creditSourceField', 'debitSourceField', 'amountSourceField'];
  const labels = ['Currency', 'Credit Amount', 'Debit Amount', '发生额'];
  for (let i = 0; i < 4; i += 1) {
    const cell = document.createElement('td');
    const select = document.createElement('select');
    // options = template.headers 排除特殊枚举 (AC1-31)
    const options = filterBillSplitDropdownOptions(template.headers);
    populateSelectOptions(select, ['', ...options]);
    select.value = row[fields[i]] || '';
    // 发生额列 disabled 条件
    if (labels[i] === '发生额') {
      select.disabled = !isAmountSourceColumnEnabled();  // 见 §7.3.6
    }
    // completed 行锁定
    if (row.rowStatus === 'completed') {
      select.disabled = true;
    }
    // 合并组行灰显不可选
    if (row.mergedGroupSeq !== null) {
      select.disabled = true;
      tr.classList.add('bill-split-merged-row');
    }
    // Credit/Debit 列在副区域启用时 disabled + 清空
    if ((labels[i] === 'Credit Amount' || labels[i] === 'Debit Amount') && isAmountSourceColumnEnabled()) {
      select.disabled = true;
      select.value = '';
    }

    select.addEventListener('change', async () => {
      // 同行 Credit !== Debit 校验 (AC1-34)
      if (labels[i] === 'Credit Amount' || labels[i] === 'Debit Amount') {
        const newRow = {
          ...row,
          creditSourceField: labels[i] === 'Credit Amount' ? select.value : row.creditSourceField,
          debitSourceField: labels[i] === 'Debit Amount' ? select.value : row.debitSourceField
        };
        if (newRow.creditSourceField && newRow.debitSourceField && newRow.creditSourceField === newRow.debitSourceField) {
          showErrorMessage('同一份拆分账单的 Credit Amount 和 Debit Amount 不能是同一列');
          select.value = row[fields[i]] || '';   // 回退
          return;
        }
      }
      row[fields[i]] = select.value;
      // 不立即落库 —— 等用户点「完成」按钮才落库（Q-C12 = B 行级落库）
    });

    cell.appendChild(select);
    tr.appendChild(cell);
  }

  // 执行操作列
  const actionCell = document.createElement('td');
  const completeBtn = document.createElement('button');
  completeBtn.textContent = row.rowStatus === 'completed' ? '编辑' : '完成';
  completeBtn.disabled = row.mergedGroupSeq !== null;
  completeBtn.addEventListener('click', async () => {
    const nextStatus = row.rowStatus === 'completed' ? 'draft' : 'completed';
    await window.desktopApi.templates.saveBillSplitRow(template.id, {
      ...row,
      rowStatus: nextStatus
    });
    row.rowStatus = nextStatus;
    rerenderTable();
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = '删除';
  deleteBtn.disabled = row.mergedGroupSeq !== null;
  deleteBtn.addEventListener('click', async () => {
    // Q-OT6 = C / C1 surgical 决策（2026-04-08）：先 preview 受影响的合并组
    const { dissolvedGroups } = await window.desktopApi.templates
      .previewDeleteBillSplitRow(template.id, row.seqNo);

    if (dissolvedGroups && dissolvedGroups.length > 0) {
      // 二次确认：列出将被解散的合并组（合并组以代表行 seq_no 标识）
      const groupListText = dissolvedGroups.map((seq) => `合并组 ${seq}`).join('、');
      const confirmed = await new Promise((resolve) => {
        showConfirmDialog({
          title: '确认删除',
          message: `删除账单序号 ${row.seqNo} 将解散以下合并组：${groupListText}。\n确认继续？`,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false)
        });
      });
      if (!confirmed) return;
    }

    const { currentRows: nextRows, dissolvedGroups: actuallyDissolved } = await window.desktopApi.templates
      .deleteBillSplitRow(template.id, row.seqNo);
    currentRows = nextRows;
    // AC1-42：N 自动 −1；nInput 同步
    nInput.value = String(currentRows.length);
    rerenderTable();
    // 可选：toast 提示已解散的合并组
    if (Array.isArray(actuallyDissolved) && actuallyDissolved.length > 0) {
      showInfoToast(`已解散合并组：${actuallyDissolved.join('、')}`);
    }
  });

  actionCell.appendChild(completeBtn);
  actionCell.appendChild(deleteBtn);
  tr.appendChild(actionCell);
  return tr;
}
```

`filterBillSplitDropdownOptions(headers)` 是一个新增 helper，返回 `headers` 数组排除 `MERCHANT_ID_SELF_INPUT_OPTION` / `CONCAT_FIELDS_MAPPING_FIELD` 等特殊枚举（AC1-31）。

#### 7.3.5 副区域（`拆分/合并账单——发生额映射关系管理`，AC1-45 ~ AC1-49）

```javascript
// 副标题
const subSectionTitle = document.createElement('h3');
subSectionTitle.textContent = '拆分/合并账单——发生额映射关系管理';

// 两行：按正负号 / 按字段区分
// Q-OT2 = B：两个下拉框分别调用各自的 IPC，前端不再混存"组合 payload"
const signedAmountRow = createMappingRow({
  label: '按正负号拆分的发生额',
  type: 'dropdown',
  options: ['', ...filterBillSplitDropdownOptions(template.headers)],
  value: currentBillSplitMeta.signedAmountSourceField || '',
  onChange: async (next) => {
    // 二选一互斥 (AC1-47)：若 amountSplitRules 非空且 next 非空 → 先清空对侧 IPC
    if (next && currentBillSplitAmountRules.length > 0) {
      currentBillSplitAmountRules = [];
      await window.desktopApi.templates.saveBillSplitAmountRules(template.id, []);
    }
    // 写入 meta 表
    currentBillSplitMeta.signedAmountSourceField = next;
    await window.desktopApi.templates.saveBillSplitMeta(template.id, next);
    applyBillSplit2WayExclusion();
    rerenderTable();  // 六列表格的 Credit/Debit/发生额 启用状态变化
  }
});

const amountSplitByFieldRow = createMappingRow({
  label: '按字段区分发生额',
  type: 'dropdown',
  options: ['', '是'],
  value: currentBillSplitAmountRules.length > 0 ? '是' : '',
  buttonLabel: currentBillSplitAmountRules.length > 0 ? '发生额映射关系管理' : null,
  onChange: async (next) => {
    if (next === '是' && currentBillSplitMeta.signedAmountSourceField) {
      // 互斥：先清空 meta
      currentBillSplitMeta.signedAmountSourceField = '';
      await window.desktopApi.templates.saveBillSplitMeta(template.id, '');
    }
    if (next === '') {
      // 清空 amountSplitRules
      currentBillSplitAmountRules = [];
      await window.desktopApi.templates.saveBillSplitAmountRules(template.id, []);
    }
    applyBillSplit2WayExclusion();
    rerenderTable();
  },
  onButtonClick: () => openAmountSplitRulesDialogForBillSplit()
});

function openAmountSplitRulesDialogForBillSplit() {
  // 复用 v1.4.8 的 createAmountSplitRulesDialog，加 context 参数
  createAmountSplitRulesDialog({
    template,
    initialRules: currentBillSplitAmountRules,
    context: 'bill-split',                  // ← v1.4.9 新增参数
    onDone: async (nextRules) => {
      currentBillSplitAmountRules = nextRules;
      await window.desktopApi.templates.saveBillSplitAmountRules(template.id, nextRules);
      applyBillSplit2WayExclusion();
      rerenderTable();
    },
    onCancel: () => { /* noop */ }
  });
}
```

#### 7.3.6 副区域 vs 六列表格的互斥（AC1-49 / §4.5.2）

```javascript
function isAmountSourceColumnEnabled() {
  // Q-OT2 = B：从两个独立状态判定
  return Boolean(currentBillSplitMeta.signedAmountSourceField)
    || currentBillSplitAmountRules.length > 0;
}

function applyBillSplit2WayExclusion() {
  const amountSourceEnabled = isAmountSourceColumnEnabled();
  // 当副区域有值时：六列表格 Credit/Debit 列 disabled + 清空
  // 当副区域为空时：Credit/Debit 启用；发生额 disabled 但保留值 (AC1-33)
  for (const row of currentRows) {
    if (amountSourceEnabled) {
      row.creditSourceField = '';
      row.debitSourceField = '';
    }
    // 发生额列的值不清空 (AC1-33)
  }
  // 六列表格重新渲染会重新计算 select.disabled
}
```

#### 7.3.7 合并账单勾选框（AC1-22 / AC1-53 ~ AC1-59）

```javascript
const mergeCheckbox = document.createElement('input');
mergeCheckbox.type = 'checkbox';
mergeCheckbox.checked = false;

const mergeDropdown = document.createElement('select');
mergeDropdown.multiple = true;
mergeDropdown.style.display = 'none';

const mergeDoneButton = document.createElement('button');
mergeDoneButton.textContent = '完成';
mergeDoneButton.style.display = 'none';

mergeCheckbox.addEventListener('change', async () => {
  if (mergeCheckbox.checked) {
    // 显示多选下拉框 + 填充候选值（AC1-54）
    const candidates = currentRows.filter(
      (r) => r.rowStatus === 'completed' && r.mergedGroupSeq === null
    );
    populateSelectOptions(mergeDropdown,
      candidates.map((r) => ({ value: String(r.seqNo), label: String(r.seqNo) }))
    );
    mergeDropdown.style.display = '';
    mergeDoneButton.style.display = '';
  } else {
    // 取消勾选 → 一次性清空所有合并组 (AC1-59)
    await window.desktopApi.templates.clearBillSplitMergeGroups(template.id);
    const { currentRows: nextRows } = await fetchLatestRows();
    currentRows = nextRows;
    mergeDropdown.style.display = 'none';
    mergeDoneButton.style.display = 'none';
    rerenderTable();
  }
});

mergeDoneButton.addEventListener('click', async () => {
  const selectedSeqNos = Array.from(mergeDropdown.selectedOptions).map((opt) => Number(opt.value));
  if (selectedSeqNos.length < 2) {
    // AC1-55
    showErrorMessage('合并账单至少需要选择 2 个账单序号');
    return;
  }
  await window.desktopApi.templates.saveBillSplitMergeGroup(template.id, selectedSeqNos);
  const { currentRows: nextRows } = await fetchLatestRows();
  currentRows = nextRows;
  // 成功后：重新刷新候选列表（剔除已合并的行）
  const nextCandidates = currentRows.filter(
    (r) => r.rowStatus === 'completed' && r.mergedGroupSeq === null
  );
  populateSelectOptions(mergeDropdown,
    nextCandidates.map((r) => ({ value: String(r.seqNo), label: String(r.seqNo) }))
  );
  mergeDropdown.value = [];   // 清空选中
  rerenderTable();
});
```

#### 7.3.8 弹框关闭（AC1-27 / AC1-27a / AC1-28）

> **2026-04-08 fix2 override**（commit `04a2e21`）：原设计弹框 2 只能通过右上角 × 按钮或 ESC 键关闭。本次新增右下角「完成」按钮（`.bill-split-rows-done-btn`）作为第三种关闭方式，**语义等同 ×**——不做任何额外 save 动作，调 `onClose` 回调关闭 modal。三种关闭路径等价：× / ESC / 右下角完成。对应 AC1-27 override + AC1-27a 新增。

```javascript
// 右上角 × 按钮 / ESC 键 / 右下角「完成」按钮（2026-04-08 fix2 新增）
function closeDialog() {
  // 不做额外落库动作（一切已行级落库）
  removeDialogDOM();
  onClose();
}

// 实际实现（renderer-dialogs.js）
dialog.querySelector('.icon-close').addEventListener('click', () => {
  if (typeof onClose === 'function') onClose();
  else closeModal();
});

// 2026-04-08 fix2 新增：右下角「完成」按钮
dialog.querySelector('.bill-split-rows-done-btn').addEventListener('click', () => {
  if (typeof onClose === 'function') onClose();
  else closeModal();
});
```

### 7.4 `createAmountSplitRulesDialog` 扩展 —— `context` 参数

文件：`src/renderer-dialogs.js:1896`

#### 7.4.1 签名扩展

```javascript
function createAmountSplitRulesDialog({
  template,
  initialRules = [],
  context = 'main',           // ← v1.4.9 新增：'main' | 'bill-split'
  onDone,
  onCancel
}) { /* ... */ }
```

#### 7.4.2 `context` 的作用

| context | 影响 |
|---------|------|
| `'main'` (默认) | 与 v1.4.8 完全一致行为。`onDone` 的回调由 v1.4.8 的主 `createMappingDialog` 调用 `template:save-amount-split-rules` 落库到 `template_amount_split_rules` 表。 |
| `'bill-split'` | 对话框标题可选加前缀 `[拆分账单]`（Dev 可选）；`onDone` 回调由 v1.4.9 的 `createBillSplitRowsDialog` 调用 `template:save-bill-split-amount-rules` 落库到 `template_bill_split_amount_rules` 表。 |

**实现细节**：`createAmountSplitRulesDialog` 内部**不**直接调用任何 IPC，所有 IPC 调用都在 `onDone` 回调里（与 v1.4.8 现状一致）。因此 `context` 参数在函数内部**几乎不需要分支逻辑**——它只影响 UI 文案（可选）。`onDone` 回调的 IPC 区分完全由调用方处理：

- 主 `createMappingDialog` 把 `context: 'main'` + `onDone: (rules) => api.saveAmountSplitRules(...)` 传入。
- `createBillSplitRowsDialog` 把 `context: 'bill-split'` + `onDone: (rules) => api.saveBillSplitAmountRules(...)` 传入。

这种"参数化但不在内部分支"的设计最小化了对 v1.4.8 既有代码的侵入性，完全符合 PRD §4.5.3 的"UI 复用 + 数据独立"要求。

> **Dev 在 task #4 实施阶段注意**：这个 `context` 参数即使不在对话框内部使用也必须声明，因为：(1) 它对 Tester 有文档价值（Test case 里写明"bill-split 上下文"就能用这个参数查验）；(2) 未来如果需要在对话框内部做细微 UI 差异化（例如标题加前缀），不必再改 signature。不要把它删除作为"未使用参数"清理。

### 7.5 CSS 新增样式

文件：`src/styles.css`

```css
/* 合并组行灰显不可选取 */
.bill-split-merged-row {
  opacity: 0.5;
  pointer-events: none;
}

/* disabled mapping 行的 tooltip 样式 */
.mapping-row-disabled {
  position: relative;
}
.mapping-row-disabled::after {
  content: attr(data-tooltip);
  display: none;
  position: absolute;
  /* ... tooltip 样式 ... */
}
.mapping-row-disabled:hover::after {
  display: block;
}

/* 弹框 2 副区域分隔线 */
.bill-split-dialog .sub-section-divider {
  border-top: 1px solid #ccc;
  margin: 16px 0;
}

/* 弹框 1 尺寸 —— 2026-04-08 fix2 override */
/* 原: .bill-split-mappings-dialog { width: 50%; max-width: 500px; } */
/* 新（commit 3eaaf14）: */
.bill-split-mappings-card {
  width: 80vw;
  min-width: 520px;
  max-width: none;  /* 必须显式覆盖 .modal-card 的 width: min(100%, 940px) */
}

/* 弹框 2 合并下拉框改为 checkbox-panel picker —— 2026-04-08 fix2 override (commit fc91550) */
.bill-split-merge-picker {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.bill-split-merge-picker-trigger {
  min-width: 180px;
  height: 34px;
}
.bill-split-merge-picker-panel {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 10;
  /* ... panel 样式参考 concat-picker-panel ... */
}

/* 弹框 2「需要拆分成几份账单」按钮缩窄 —— 2026-04-08 fix2 (commit 57dbd38) */
.bill-split-row-count-done-btn.secondary-btn.small {
  min-width: 0;       /* 解除 .small 的 min-width: 108px 约束 */
  width: 71px;        /* 108 × 66% ≈ 71 */
  padding: 0 8px;
}
```

> **CSS 类名约定**：实际实施阶段采用 `.bill-split-mappings-card` / `.bill-split-rows-card` / `.bill-split-merged-row` / `.bill-split-merge-disabled` 等（非原 TechDoc 示例中的 `.bill-split-mappings-dialog` / `.bill-split-dialog`）。CSS 选择器与 HTML class 一致。

### 7.6 Preload 暴露（再次强调，详见 §4.4）

在 `src/preload.js` 的 `desktopApi.templates` 对象中追加 8 个新方法；签名在 §4.4 已列出。

---

## 八、导入流程改动

### 8.1 总体链路

```
用户点「生成对账单」
  ↓
src/main.js 触发 buildStatementGenerationConfig(templateConfig)
  ↓  (§5.5.2 新增 billSplitMergeConfig)
  ↓
buildMappedRowsForFile(file, statementConfig)
  ↓  (§5.5.3 透传 billSplitMergeConfig)
  ↓
src/backend/file-service.js::buildMappedRows({ rows, headers, ..., billSplitMergeConfig })
  ↓  (§5.6 拆分 / 合并执行分支)
  ├─ billSplitMergeConfig === null
  │     ↓ 沿用 v1.4.8 既有路径
  │
  └─ billSplitMergeConfig !== null
        ↓
        foreach originalRow:
          splitOutputRows = expandBillSplit(originalRow, headers, billSplitMergeConfig, templateMappings)
          finalRows = applyBillSplitMerge(splitOutputRows, billSplitMergeConfig)
          push finalRows into allOutputRows
        ↓
        matchedBillSplitCount = allOutputRows.length
        ↓
        return { rows: allOutputRows, hasBillSplitOutput: matchedBillSplitCount > 0, ... }
```

### 8.2 `buildMappedRows` 细节补充

#### 8.2.1 `reuseModuleMapping = true` 时的非金额字段计算

PRD §4.7.4 明确：「若「复用模块字段的映射关系」= 是 → 非金额字段按主模板映射计算，取自对应的原始行」。

这意味着 `mapNonAmountFieldsFromMain(originalRow, headers, templateMappings)` 复用的是 v1.4.8 既有的"主模板映射单行"逻辑，但**只对非金额字段**生效——即 `templateMappings` 数组中排除 `Currency` / `Credit Amount` / `Debit Amount` 三个字段的行，对这些字段执行 `mappedField → header → 原始行取值` 的转换。

实现上可以直接复用 v1.4.8 的 `buildMappedRows` 主循环，但入参 `templateMappings` 被 filter 过（排除三件套）；或者更简洁的做法是直接在 `expandBillSplit` 内部调用一个 inline filter：

```javascript
function mapNonAmountFieldsFromMain(originalRow, headers, templateMappings) {
  const nonAmount = templateMappings.filter((m) =>
    m.templateField !== 'Currency' &&
    m.templateField !== 'Credit Amount' &&
    m.templateField !== 'Debit Amount'
  );
  return evaluateMappingsForSingleRow(originalRow, headers, nonAmount);
}
```

`evaluateMappingsForSingleRow` 是 v1.4.8 主路径中"单行 × 映射数组 → 单行映射结果对象"的 helper；若当前 v1.4.8 代码没有把这一步抽成独立函数，Dev 在 task #4 实施阶段可以进行一次小重构——把 `buildMappedRows` 主循环内部的 mapping evaluation 抽成函数，供 v1.4.8 主路径和 v1.4.9 拆分路径共用。

#### 8.2.2 `reuseModuleMapping = false` 时的非金额字段计算

直接用弹框 1 的 `billSplitMappings` 数组调用 `evaluateMappingsForSingleRow`：

```javascript
function mapNonAmountFieldsFromBillSplitMappings(originalRow, headers, billSplitMappings) {
  // billSplitMappings 天然不含三件套（前端 + 后端 validate 都会校验）
  return evaluateMappingsForSingleRow(originalRow, headers, billSplitMappings);
}
```

**所有 N 份拆分账单共享同一套非金额字段**（AC1-5 / ACI-9）——这由 `expandBillSplit` 在循环外计算一次 `nonAmountFields`、再在 N 个 split 行内展开实现（已在 §5.6.3 的代码示例中体现）。

#### 8.2.3 合并组代表行的非金额字段

PRD §4.4.2 / Q-F4：「合并后的非金额字段取合并组代表行（最小 seq_no 行）的值」。

因为 `nonAmountFields` 对所有 N 份拆分是**共享**的（来自同一条原始行 + 同一套映射），合并组内 K 个 split 行的非金额字段实际上完全相同。`applyBillSplitMerge` 的 Step 4 `const mergedRow = { ...representativeSplitRow, ... }` 展开时会自然取到这份共享的非金额字段。

### 8.3 导入阶段错误的用户提示

v1.4.8 既有的 import 错误流：`buildMappedRowsForFile` throw → main process catch → 通过 IPC 返回 renderer → dialog 弹错误提示。

v1.4.9 新增的错误码（`BILL_MERGE_CURRENCY_MISMATCH`）走同一流程，**不需要**额外的 handler。错误文案在 §4.2 已统一定义，`createImportError(code, message)` 抛出后由现有错误渲染逻辑处理。

> **2026-04-08 fix2 override**：原本列为 v1.4.9 新增错误码的 `BILL_MERGE_NET_ZERO` 已**不再抛出**（合并组净值 = 0 时改为静默过滤，详见 §5.6.4 override 说明）。错误码字符串保留在错误码表以防外部引用，但实际代码路径永远不会触发。

### 8.4 多文件聚合告警（AC ACI-12）

v1.4.8 已经实现"多文件全部未命中"聚合告警：遍历所有文件调用 `buildMappedRowsForFile`，收集 `hasCreditAmount === false && hasDebitAmount === false` 的文件名到 `unmatchedFiles` 数组；所有文件处理完后一次性弹告警。

v1.4.9 扩展判定条件为 `hasCreditAmount === false && hasDebitAmount === false && hasBillSplitOutput === false`（见 §5.6.5）。告警文案改为 `以下文件全部未命中映射 / 拆分 / 合并规则，请检查规则配置：\n{filenames}`。

---

## 九、回归风险 & 向后兼容

### 9.1 v1.4.7 / v1.4.8 既有功能不受影响

| 既有功能 | 兼容保证 |
|---------|---------|
| 直接映射 `Credit Amount` / `Debit Amount` | 默认场景：新 feature 开关 = 否，`buildStatementGenerationConfig` 返回 `billSplitMergeConfig = null`，`buildMappedRows` 走 v1.4.8 既有路径，完全不变。 |
| 按正负号拆分的发生额（v1.4.7 `SIGNED_AMOUNT_MAPPING_FIELD`） | 同上。4 方互斥仅在保存阶段报 `AMOUNT_MODE_CONFLICT`，不开启 v1.4.9 时该互斥不触发。 |
| 按字段区分发生额（v1.4.8 `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD`） | 同上。v1.4.8 `template_amount_split_rules` 表**完全不动**，repository `getAmountSplitRules` / `saveMappings` 的 6 参数签名**完全不动**。 |
| v1.4.8 `createAmountSplitRulesDialog` | 新增 `context` 参数默认 `'main'`，对 v1.4.8 所有调用点行为完全一致（v1.4.8 现有调用点不需要改 signature，因为 JS 默认参数）。 |
| legacyConcatMode（v1.4.7 PR #14） | 不在本 feature 改动的代码路径内；`legacyConcatMode` 的 dataset 处理（`src/renderer-dialogs.js:1745-1752` 周边）完全不动。 |
| `saveMappings` 的 `dateFormat` 写入顺序（v1.4.7 PR #14 修复） | `saveMappings` 6 参数签名完全不动；v1.4.9 的所有 bill-split 数据走独立 repository 函数，不挤占 `saveMappings` 的事务。 |
| v1.4.7 text-based CSV 解析的精度修复（PR #11） | 本 feature 不改动 CSV 解析层，`sanitizeAmountValue` 等处理函数继续复用；合并阶段的 `Math.abs(net)` 使用的是 `safeNumber` 已清洗过的值。 |
| v1.4.8 bundle version 2 的读取 | §6.4.1 已覆盖：v1.4.9 读 v1.4.8 bundle 时新字段 fallback 默认值，AC1-80 满足。 |

### 9.2 需要 Dev 在 task #4 实施阶段特别注意的 Regression

| 风险点 | 预防措施 |
|-------|---------|
| 打开旧模板对话框时 `payload.billSplitMappings` / `payload.billSplitRows` / `payload.billSplitAmountRules` 为 `undefined` | `createMappingDialog` 的 v1.4.9 状态读取代码用 `Array.isArray(payload.xxx) ? ... : []` 兜底（见 §7.1.1），确保旧 payload 能正常打开。 |
| 保存 v1.4.8 模板时误删 v1.4.9 的 bill-split 数据 | `template:save-mappings` 主流程**不**调用 `database.saveBillSplit*` 的任何清理函数（§5.2.2 明确）。草稿语义保持。 |
| 4 方互斥错误码 `AMOUNT_MODE_CONFLICT` 的文案改动影响 v1.4.8 Test case | v1.4.8 的错误码原本就是 `AMOUNT_MODE_CONFLICT`，文案从"3 方"改为"4 方"表述，v1.4.8 Test case 可能需要同步更新。**Dev 在 task #4 实施阶段需提醒 Tester 在 task #5 回归测试中核实这条**。 |
| bundle version `SUPPORTED_BUNDLE_VERSION` 改为 3 后 v1.4.8 导出的 bundle（version = 2）在 v1.4.9 是否可导入 | §6.4.1 明确：`bundleVersion <= SUPPORTED_BUNDLE_VERSION` 正常导入；fallback 填默认值。在 v1.4.8 既有的 `readTemplateBundleFile` 代码逻辑下，`bundleVersion = 2` 满足 `2 <= 3`，不会被拒绝。 |
| 弹框 1 / 弹框 2 的 DOM 不用 `cloneNode` | 参考 PRD NFR-6 + v1.4.7 ghost shell 教训：每次打开弹框都用 `document.createElement` 重新构造 DOM，不做 `prototypeNode.cloneNode(true)` 之类的优化。 |
| `template:save-mappings` 在 `usesBillSplitMerge === true` 时校验 `template_bill_split_rows` 至少有 1 行 completed | 见 §5.2.1；这是一个**新增**校验，需确保校验时机发生在 `saveMappings` 之前（因为 `saveMappings` 不写 bill-split 表，校验用的是此前行级落库的既有数据）。 |
| 并发问题：用户在弹框 2 内快速点击"完成 / 删除 / 合并"按钮 | 每个 IPC handler 是独立的 `ipcMain.handle`，better-sqlite3 是同步 API + 全局锁，不会出现数据竞争。UI 层可以额外给每个按钮加 "处理中 disabled" 防止用户双击，但不是 PRD 强制要求。 |

### 9.3 不引入的"防御性改动"

参考 v1.4.8 的 lesson learned（PR #14 移除反向互斥锁 + 正则提示文案），Dev 在 task #4 **不**引入以下未被 PRD 要求的改动：

1. **反向互斥锁**：不给 `Credit Amount` / `Debit Amount` / 按正负号 / 按字段区分 的下拉框加"禁止切回『是否拆分/合并明细账单=是』"的锁。v1.4.8 明确教训。
2. **正则语法提示文案**：不在副区域的"按字段区分发生额"弹框内加额外的正则 hint 文本。v1.4.8 明确教训。
3. **并发锁 / 状态机**：不引入任何 React/Vue 级的状态机管理，保持直接操作 DOM + 每次 IPC 后 `rerenderTable()` 全量重绘。
4. **Query cache**：每次打开弹框 2 都调用 `template:get-bill-split-config` 拉最新数据，不在 renderer 缓存。
5. **旧模板数据迁移（autofix）**：不给没有两个开关行的旧模板自动补一行 `mappedField = ''`；读取时 fallback 即可（§5.5.1 的 `enabledFromMappings` helper）。

---

## 十、Open Technical Questions

以下是 Dev 在 TechDoc 阶段**已经决定**但需要向 team-lead / PM 公示的技术实现选择。所有选择都**不**修改 PRD 任何条款，只在 PRD 留白点（"由 Dev 在 TechDoc 阶段决定"）处落定。如果 team-lead 觉得任何一项需要调整，请在本节记录 diff。

### Q-OT1 — IPC 通道粒度：8 个细粒度 IPC vs 1 个 umbrella IPC

**Background**：PM 在 PRD Q-G1 中建议命名 `template:save-bill-split-config` 作为统一 IPC，但 PRD §4.3.5 / Q-C12 = B 要求行级落库，若用单一 IPC 会把 renderer 变成"维护整个弹框状态 + 每次 change 全量推"，违背行级落库初衷。

**Dev 决定**：拆成 8 个细粒度 IPC，命名见 §4.3。弹框 1 保留 1 个 `template:save-bill-split-mappings`（因为弹框 1 是整体落库）；弹框 2 拆成 6 个：

1. `template:save-bill-split-row-count` — N 变化
2. `template:save-bill-split-row` — 单行完成 / 编辑
3. `template:delete-bill-split-row` — 单行删除
4. `template:save-bill-split-merge-group` — 合并组创建
5. `template:clear-bill-split-merge-groups` — 解散所有合并组
6. `template:save-bill-split-amount-rules` — 副区域配置

另加 1 个 `template:get-bill-split-config` 用于读取。

**影响 AC**：无（AC 只要求落库正确，不指定 IPC 形式）。

### Q-OT2 — 副区域「按正负号拆分的发生额」的存储位置 ✅ 已决策（2026-04-08）by team-lead/user

**Background**：PRD §4.6.2 明确留白："可放在表中 meta 记录或新增 `template_mappings` scope=bill-split 行，由 Dev 决定"。

**Dev 原方案**：统一存入 `template_bill_split_amount_rules` 表，用特殊行 `target_field = 'SignedAmount'` 表示。**未被采纳。**

**team-lead 最终决策（B）**：**新建独立表 `template_bill_split_meta`**（1:1 with template，PRIMARY KEY = `template_id`，单列 `signed_amount_source_field TEXT NOT NULL DEFAULT ''`），与 `template_bill_split_amount_rules` 完全分离。详见 §3.2.4 + §3.4.6 + §3.3 migration。

**最终方案要点**：

1. 新增表 `template_bill_split_meta`：1:1 with template，承载副区域「按正负号拆分的发生额」的单一字段。
2. 新增 repository 函数 `getBillSplitMeta(db, templateId)` / `saveBillSplitMeta(db, templateId, meta)`（§3.4.6），upsert 语义。
3. **删除** 原 Dev 方案中的常量 `BILL_SPLIT_SIGNED_AMOUNT_TARGET = 'SignedAmount'`（§4.1）。
4. **拆分** 原 IPC `template:save-bill-split-amount-rules`：
   - `template:save-bill-split-amount-rules` —— 仅承载「按字段区分发生额」规则数组（写入 `template_bill_split_amount_rules`）。
   - `template:save-bill-split-meta` —— 仅承载「按正负号拆分」字段（upsert 写入 `template_bill_split_meta`）。
5. Bundle JSON v3 顶层新增 `billSplitMeta: { signedAmountSourceField: '' }` 字段；`billSplitAmountRules` 由原"嵌套对象"扁平为"规则数组"（§6.2）。
6. 前端 `createBillSplitRowsDialog` 拆分 state 为 `currentBillSplitAmountRules: array` + `currentBillSplitMeta: { signedAmountSourceField }`，两个下拉框 onChange 分别调用各自的 IPC（§7.3.5）。
7. 互斥校验在两个 handler 中**对称实现**（任一方写入前都查另一方现状）。

**team-lead 理由**：

1. **schema 洁癖**：两种语义不同的数据（多行规则 vs 单一字段配置）不应该共用一张表。混存让 repository SELECT 必须用 `target_field` 做语义路由，破坏表结构语义。
2. 1:1 表用 `template_id` 直接做 PRIMARY KEY，不需要 AUTOINCREMENT id，节约一个字段。
3. 未来若副区域需要更多"非规则型"配置（例如 sign 反转开关），可以加列到 `template_bill_split_meta` 表上，比扩展 `target_field` enum 更清晰。

**影响 AC**：无（AC1-47 / AC1-48 / AC1-49 只要求数据独立于 v1.4.8 `template_amount_split_rules`，不指定存储细节）。

### Q-OT3 — `createAmountSplitRulesDialog` 的 `context` 参数复用方式

**Background**：PRD §4.5.3 明确"UI 复用 + 数据独立，Dev 在 TechDoc 阶段决定具体复用方式（参数化 / 子类化 / 工厂等）"。

**Dev 决定**：**参数化**——给 v1.4.8 `createAmountSplitRulesDialog` 增加 `context: 'main' | 'bill-split'` 参数，默认 `'main'`。数据持久化的 IPC 区分完全在调用方的 `onDone` 回调里做（详见 §7.4.2）。

**理由**：

1. 最小侵入 —— 不破坏 v1.4.8 既有调用点（JS 默认参数）。
2. IPC 分流在调用方更清晰 —— 对话框自己不需要知道"我在主模板还是拆分账单上下文"这样的业务知识。
3. Dev 避免子类化 / 工厂模式 —— 这是一个渲染函数，不是 class；引入工厂只会增加代码量而没有收益。

**影响 AC**：无。

### Q-OT4 — 旧版本 bundle 向下兼容的默认值

**Background**：PRD §4.6.4 + AC1-80 要求 v1.4.9 能读 v1.4.8 bundle，但没明确 v1.4.9 新字段缺失时填什么默认值。

**Dev 决定**：

| 缺失字段 | 默认值 |
|---------|-------|
| `billSplitMappings` | `[]`（空数组） |
| `billSplitRows` | `[]` |
| `billSplitAmountRules` | `[]`（空数组） —— Q-OT2 = B 拆分后扁平为数组 |
| `billSplitMeta` | `{ signedAmountSourceField: '' }` —— Q-OT2 = B 新增独立字段 |
| `mappings` 中的 `是否拆分/合并明细账单` | 不存在即视为 `''`（默认 "否"） |
| `mappings` 中的 `复用模块字段的映射关系` | 不存在即视为 `'是'`（默认 "是"） |

这些默认值在 `template:import-bundle` handler 的 normalize 步骤（§6.3.1）中 fallback，在 `getTemplateMappingConfig` 的读取步骤（§5.5.1 `enabledFromMappings`）中也 fallback。双保险确保 v1.4.8 → v1.4.9 迁移无声无息。

**影响 AC**：AC1-75 / AC1-80 直接覆盖。

### Q-OT5 — `buildMappedRows` 两阶段处理的实现复杂度

**Background**：`src/backend/file-service.js::buildMappedRows` 在 v1.4.8 已经是一个复杂的"按 mappings 数组逐行计算"的循环，v1.4.9 要引入"拆分 × N + 合并"的新维度，改动面可能超过 150 行。

**Dev 决定**：**抽取一个 inline helper `evaluateMappingsForSingleRow(row, headers, mappings)`**，让 v1.4.8 主路径和 v1.4.9 拆分路径共享同一个 mapping 计算逻辑。改动策略：

1. 先在 `file-service.js` 中把 v1.4.8 主循环内部的"单行 × 映射 → 结果对象"计算提取成 `evaluateMappingsForSingleRow`，**保证行为完全等价**（不改任何语义，只是抽函数）。这步是一次纯 refactor，可以独立 commit / 独立回归测试。
2. 然后新增 `expandBillSplit` + `applyBillSplitMerge`（§5.6.3 / §5.6.4），都调用 `evaluateMappingsForSingleRow`。
3. 最后在 `buildMappedRows` 的顶层 `foreach rows` 加 `billSplitMergeConfig` 的分支判断。

**影响 AC**：无；这是实现细节。但**重要：Dev 在 task #4 实施阶段应把 step 1 的 refactor 作为第一个 commit 单独提交**，便于 code review 分开确认"refactor 等价性"和"新功能"。

### Q-OT6 — 删除中间行后的合并组 `merged_group_seq` 整数漂移 ✅ 已决策（2026-04-08）by team-lead/user

**Background**：§3.4.3 的 `deleteBillSplitRow` 在删除一行后执行 `UPDATE ... SET seq_no = seq_no - 1 WHERE seq_no > ?`，把后续行的 seq_no 整体前移。问题：如果后续行中有合并组，它们的 `merged_group_seq` 可能不再指向"组内最小 seq_no"——违反 PRD §Q-A3 不变量。

**Dev 原方案**：不处理漂移，理由是 `buildBillSplitMergeConfig` 只把 `merged_group_seq` 当 group key 使用，DB 仍然内部一致。**未被采纳。**

**team-lead 最终决策（C）**：**删除时一并解除受影响的合并组**，以维护 PRD §Q-A3「`merged_group_seq` = 组内最小 seq_no」的不变量。Dev 在 C1（surgical 精准解散）和 C2（conservative 一律解散全部）之间选择，**Dev 选 C1 surgical**。

**最终方案要点**（详见 §3.4.3 + §5.3 + §7.3.4）：

1. **解除规则**（C1 surgical）：
   - **规则 1**：若被删除的行本身在某个合并组内，整组解散（PRD §Q-C7 已要求，原方案已实现）。
   - **规则 2**：对其它合并组，若任一成员的 seq ≥ 被删除行的 seq，整组解散。
   - **等价表达式**：删除 seq=N 后，保留下来的合并组必须满足"所有成员的 seq < N"。
2. **不变量证明**：Step B 解散后，所有幸存合并组的成员 seq 都 < N；Step D 的前移操作只影响 seq > N 的行，因此不会改变任何幸存合并组的 seq_no，`merged_group_seq` 仍然等于该组内最小 seq_no。PRD §Q-A3 不变量保持。
3. **二次确认 UI**：
   - 前端 deleteBtn 点击时**先调用** `template:preview-delete-bill-split-row` —— dry-run 同一份判定逻辑，返回 `dissolvedGroups: number[]`（受影响的合并组列表，由代表行 seq_no 标识）。
   - 若 `dissolvedGroups.length > 0` 弹二次确认对话框，列出"将被解散的合并组：合并组 X、合并组 Y"，用户确认后才调用真正的 `template:delete-bill-split-row`。
   - 若 `dissolvedGroups.length === 0`（删除非合并行且后续行无合并组），不弹二次确认，与原 AC1-43 一致。
4. **后端实现**：`deleteBillSplitRow` 函数返回 `{ dissolvedGroups }`，IPC handler 透传给前端。preview IPC 复用同一份判定代码（§5.3 IPC 5a），保证规则一致。
5. **新增 IPC**：`template:preview-delete-bill-split-row` 和 `template:delete-bill-split-row` 的返回值新增 `dissolvedGroups` 字段。

**Dev 选 C1 surgical 而非 C2 conservative 的理由**：

1. **保留更多用户配置**：用户可能合并了 3+ 组中只有 1 组受影响，C2 一律解散全部会丢掉用户已配置的其它合并组关系，用户得重新合并。C1 只解散真正会破坏不变量的组。
2. **判定逻辑简单**：规则 2 是一个 SQL 子查询（`merged_group_seq IS NOT NULL AND seq_no >= ?`），实现成本低。
3. **二次确认 UX 更直观**：用户看到"删除这行将解散合并组 5 和 7"时，能理解原因；C2 一律解散全部，用户会问"为什么要解散我没动过的合并组 2？"

**team-lead 理由（C 而非原 Dev 方案）**：

1. PRD §Q-A3 是显式不变量声明（"`merged_group_seq` = 组内最小 seq_no"），不是模糊语义。原方案违反这个声明，与 PRD 不一致。
2. `buildBillSplitMergeConfig` 当前虽然只把 `merged_group_seq` 当 key 用，但未来如果有"显示合并组代表序号"的 UI 改动，漂移就会变成 bug。维持不变量是更稳健的选择。
3. 前端二次确认能给用户提供"我即将丢失什么"的可见性，避免静默副作用。

**新增 AC（建议 Tester 在 task #3 写 TestCases 时纳入并由 PM 在 PRD 加 AC1-43-NEW + AC1-44-NEW）**：

- **AC1-43-NEW**：删除一行前，若该删除会导致受影响的合并组（自身所在组 OR 其它组中存在 seq ≥ 删除行 seq 的成员），前端**必须**弹出二次确认对话框，列出将被解散的合并组代表序号；用户取消则不删除。
- **AC1-44-NEW**：删除完成后，所有幸存的合并组必须满足 PRD §Q-A3 不变量「`merged_group_seq` = 组内最小 seq_no」。换言之：所有幸存合并组的成员 seq 都 < (被删除行的原 seq_no)。

**影响 AC**：原 AC1-42 / AC1-43 / AC1-44 行为扩展（二次确认 + dissolvedGroups 返回），需要 PM 在 PRD 中追加 AC1-43-NEW / AC1-44-NEW。Tester 在 task #3 写 TestCases 时应包含：
- 删除非合并行 + 后续无合并组 → 不弹二次确认（向下兼容）
- 删除非合并行 + 后续有合并组（成员 seq 都 ≤ 删除行 seq）→ 弹二次确认列出受影响组
- 删除合并行 → 弹二次确认列出自身所在组 + 其它受影响组
- 删除后所有幸存合并组的 `merged_group_seq` = 组内最小 seq_no（不变量验证）

### Q-OT7 — 弹框 2 关闭时 draft 行的处理

**Background**：PRD AC1-28 "弹框 2 关闭时不做额外落库动作"。问题：若用户输入 N=5 生成 5 行 draft，填了 3 行但没点完成，然后关弹框——5 行都以 `row_status = 'draft'` 留在 DB 里。下次打开弹框 2 时 draft 行回显（AC1-27 暗示 / PRD §4.3.5 "未完成的 draft 行保留在 DB 中，下次打开弹框时回显，允许用户继续编辑"）。

**Dev 决定**：

- draft 行**完全按现状**保留，不做任何自动清理。
- `template:save-mappings` 主保存流程仍然校验"至少 1 行 completed"（§5.2.1），所以全是 draft 行的用户在保存外层映射关系管理对话框时会看到 `BILL_SPLIT_CONFIG_MISSING` 错误——这是符合 ACI-11 的预期行为，也是提醒用户"还有未完成的配置"的一种机制。
- 不清理 draft 行意味着如果用户改变思路把 N 从 5 减小到 3，前 3 行的 draft 内容**保留**，第 4/5 行的 draft 内容**被删除**（通过 §3.4.3 的 "N 减小"事务）。

**影响 AC**：AC1-27 / AC1-28 / AC1-73 / ACI-11 直接对齐。

### Q-OT8 — 保存路径中 `hasCompletedRow` 的校验时机

**Background**：§5.2.1 的 `BILL_SPLIT_CONFIG_MISSING` 校验查询的是"当前 DB 中的 `template_bill_split_rows` 是否至少有一行 completed"。问题：如果用户还没点完行级"完成"按钮就点了外层"完成"，校验会基于"用户预期的最新状态"还是"DB 中的旧状态"？

**Dev 分析**：

- 因为弹框 2 所有行为都是行级落库，用户的"预期最新状态"和"DB 实际状态"**永远**一致——除非有 race condition，而 better-sqlite3 + 单一 Electron main process 不会有 race。
- 所以校验查询 DB 即可，不需要 renderer 再推一次最新状态。

**Dev 决定**：§5.2.1 的校验直接查 DB，不接受 renderer 传入的 `currentBillSplitRows` 参数。保持 IPC 接口简洁。

**影响 AC**：ACI-11 直接对齐。

---

## 十一、分阶段实施建议

本节面向 task #4（Dev 实施代码）提供一个可执行的分阶段计划。每个阶段结束后都能**独立 commit** 并通过 lint + 手动烟雾测试。

| 阶段 | 内容 | 依赖 | 输出 |
|------|------|-----|------|
| P1 | **DB 迁移** — 新增 `ensureBillSplitMergeSupport`（§3.3），在启动时调用，通过 sqlite CLI 验证 3 张表 + 索引创建成功；幂等性测试（运行应用 2 次） | 无 | commit: `feat(v1.4.9): add bill-split-merge schema migration` |
| P2 | **Repository 层** — 实现 §3.4 的 6 个函数，外加 `getBillSplitMappings` / `getBillSplitRows` / `getBillSplitAmountRules`。写简单的单元测试（如果项目有测试框架）或直接在 `node` REPL 里手动验证 | P1 | commit: `feat(v1.4.9): add bill-split repository functions` |
| P3 | **常量 + 错误码** — §4.1 / §4.2 的常量定义写入 `src/main.js` 顶部，`createValidationError` helper 若不存在则新增 | P2 | commit: `feat(v1.4.9): add bill-split constants and error codes` |
| P4 | **后端 IPC handler + validate 扩展** — §5.1 / §5.2 / §5.3 / §5.4，包括 4 方互斥 `validateTemplateConfiguration` 扩展、8 个 IPC handler、辅助校验函数 | P3 | commit: `feat(v1.4.9): add 4-way mutual exclusion and bill-split IPC handlers` |
| P5 | **`getTemplateMappingConfig` / `buildStatementGenerationConfig` 扩展** — §5.5，追加 `billSplitMergeConfig` 的构造 + `buildMappedRowsForFile` 透传 | P4 | commit: `feat(v1.4.9): wire bill-split config into statement generation` |
| P6 | **Refactor `buildMappedRows`** — 按 Q-OT5 建议，先把 v1.4.8 主循环内的"单行 × 映射"提取成 `evaluateMappingsForSingleRow` helper，**不**引入新功能。通过全量回归确保 v1.4.8 行为不变 | P5 | commit: `refactor(v1.4.9): extract evaluateMappingsForSingleRow from buildMappedRows` |
| P7 | **`buildMappedRows` 拆分分支 + 副区域 + 合并** — §5.6 / §8，实现 `expandBillSplit` + `applyBillSplitMerge` + `evaluateBillSplitAmountRules` + header 校验 + `matchedBillSplitCount` 计数 | P6 | commit: `feat(v1.4.9): implement bill-split expand and merge in buildMappedRows` |
| P8 | **Bundle 导入 / 导出扩展** — `listTemplateBundleEntries` 追加 5 字段（§3.7）；`template:import-bundle` handler 追加 normalize + 落库（§6.3.1 / §6.3.2）；`SUPPORTED_BUNDLE_VERSION = 3` 常量升级 | P7 | commit: `feat(v1.4.9): bump bundle version to 3 and include bill-split fields` |
| P9 | **Preload 暴露** — §4.4 / §7.6，在 `src/preload.js` 给 `desktopApi.templates` 追加 8 个方法 | P4 (只依赖 IPC 命名确定) | commit: `feat(v1.4.9): expose bill-split IPC methods via preload` |
| P10 | **弹框 1 前端** — §7.2 实现 `createBillSplitMappingsDialog`；在 `createMappingDialog` 中添加开关 + 打开弹框 1 的按钮 | P9 | commit: `feat(v1.4.9): add bill-split mappings dialog (dialog 1)` |
| P11 | **弹框 2 主表格 + 副区域 + 合并** — §7.3 实现 `createBillSplitRowsDialog` + `applyBillSplit2WayExclusion` + `openAmountSplitRulesDialogForBillSplit` 的 `context: 'bill-split'` 复用 + `createAmountSplitRulesDialog` 添加 `context` 参数（§7.4） | P10 | commit: `feat(v1.4.9): add bill-split rows dialog (dialog 2) with sub-section and merge` |
| P12 | **主 `createMappingDialog` 4 方互斥 UI** — §7.1.3 / §7.1.4 实现 `applyBillSplitMergeMutualExclusion`；手动验证：切换开关时 5 行字段的 disable + tooltip + 值清空 | P11 | commit: `feat(v1.4.9): add 4-way mutual exclusion UI in main mapping dialog` |
| P13 | **CSS 样式** — §7.5 的 `.bill-split-*` 样式；手动验证灰显效果 + tooltip 显示 | P12 | commit: `style(v1.4.9): add bill-split dialog styles` |
| P14 | **端到端手动测试** — 创建一个带 CNY/USD 双币种的 CSV 样例文件，验证拆分路径；创建一个合并场景验证合并；验证 4 方互斥保存时报错；验证切换开关的草稿保留；验证 bundle 导出 / 导入 | P13 | commit: `docs(v1.4.9): add manual e2e test evidence to iterations/v1.4.9/` (optional) |
| P15 | **版本号 + Release Note** — `package.json` 升级 `1.4.8` → `1.4.9`；`docs/release-notes/v1.4.9.md` 同步 PRD §12 的 Release Note 草稿 | P14 | commit: `chore(v1.4.9): bump version to 1.4.9 and publish release notes` |

**建议 PR 结构**：15 个 commit 可以整合为 1 个 PR，但每个 commit 独立可以 revert。code review 可按 commit 顺序逐个确认。

**P6 refactor 的重要性**：P6 是唯一一个"纯 refactor"commit，它的存在让 code review 可以分两步走——先确认 refactor 等价，再确认新功能。这一点不能跳过或合并到 P7。

---

## 十二、AC 影响映射 & 版本号变更

### 12.1 AC → TechDoc 章节 追溯表

| AC 编号 | PRD 描述（摘要） | TechDoc 主要实现章节 |
|---------|---------------|------------------|
| AC1-1 ~ AC1-2 | 新分组「账单拆分合并管理」位置与 2 行开关 | §7.1.2 |
| AC1-3 ~ AC1-4 | 两个开关的选项与默认值 | §7.1.2 + §5.5.1 |
| AC1-5 ~ AC1-10 | 按钮显隐 + 弹框触发 | §7.1.2 / §7.1.3 |
| AC1-11 ~ AC1-16 | 弹框 1 尺寸 / 标题 / 表格枚举 | §7.2.2 |
| AC1-17 ~ AC1-18 | 「导入当前映射关系」按钮 | §7.2.3 |
| AC1-19 ~ AC1-20 | 弹框 1 「完成」落库 | §7.2.4 + §3.4.2 + §5.3 (IPC 2) |
| AC1-21 ~ AC1-26 | 弹框 2 布局 + N 输入框 | §7.3.2 + §7.3.3 |
| AC1-27 ~ AC1-28 | 弹框 2 无整体完成按钮 / 关闭不落库 | §7.3.8 + Q-OT7 |
| AC1-29 ~ AC1-36 | 六列表格列定义 + 下拉框枚举 + 同行 Credit≠Debit | §7.3.4 + §5.4 (`validateBillSplitRowPayload`) |
| AC1-37 ~ AC1-39 | 修改 N 的 UI 行为 | §7.3.3 + §3.4.3 (`saveBillSplitRowCount`) |
| AC1-40 ~ AC1-41 | 行级「完成 / 编辑」按钮 | §7.3.4 + §3.4.3 (`saveBillSplitRow`) + §5.3 (IPC 4) |
| AC1-42 ~ AC1-44 | 删除按钮 + seq_no 前移 + 解散合并组 | §7.3.4 + §3.4.3 (`deleteBillSplitRow`) + §5.3 (IPC 5a/5b) |
| AC1-43-NEW / AC1-44-NEW（**建议 PM 加入 PRD**） | 删除前的合并组解散二次确认 + PRD §Q-A3 不变量保持 | §7.3.4 deleteBtn + §3.4.3 (Q-OT6=C / C1 surgical) + §5.3 (preview IPC) |
| AC1-45 ~ AC1-49 | 副区域 2 行 + 副区域 2 选 1 互斥 + vs 六列表格的互斥 | §7.3.5 + §7.3.6 + §5.3 (IPC 8) |
| AC1-50 ~ AC1-52 | 三个落库时机 | §3.4.3 / §3.4.4 + §5.3 (IPC 3, 4, 6) |
| AC1-53 ~ AC1-55 | 合并勾选框 + 多选下拉框 + >=2 校验 | §7.3.7 + §5.3 (IPC 6) |
| AC1-56 ~ AC1-59 | 合并落库 + 灰显 + 多组独立 + 取消清空 | §7.3.7 + §3.4.4 (`saveBillSplitMergeGroup` / `clearBillSplitMergeGroups`) + §5.3 (IPC 6, 7) |
| AC1-60 ~ AC1-63 | 合并后输出计算（Currency 一致 / 求和 / 净值 / 非金额字段） | §5.6.4 (`applyBillSplitMerge`) |
| AC1-64 | 最终输出行数 | §5.6.4 |
| AC1-65 ~ AC1-70 | 主表格 5 行的互斥清空 + disabled + tooltip | §7.1.4 (`applyBillSplitMergeMutualExclusion`) |
| AC1-71 | 4 方互斥校验 `AMOUNT_MODE_CONFLICT` | §5.1.1 |
| AC1-72 ~ AC1-73 | 切回的 UI 行为 + 草稿保留 | §7.1.3 + §3.6 (saveMappings 不动 bill-split) + Q-OT7 |
| AC1-74 ~ AC1-78 | 持久化 / 默认值 / 迁移幂等 / 3 张新表 + 必含字段 | §3.2 / §3.3 / §5.5.1 |
| AC1-79 | bundle v3 + 5 字段 | §6.1 + §6.2 |
| AC1-80 ~ AC1-82 | 跨版本 bundle 兼容 | §6.4 + Q-OT4 |
| ACI-1 ~ ACI-2 | 拆分语义（N 条拆分输出 + 源列取值） | §5.6.3 (`expandBillSplit`) |
| ACI-3 ~ ACI-4 | 副区域发生额规则（按正负号 / 按字段区分） | §5.6.3 + v1.4.7/v1.4.8 helper 复用 |
| ACI-5 ~ ACI-7 | 合并语义 + Currency 一致 + 净值 = 0 | §5.6.4 |
| ACI-8 ~ ACI-9 | 非金额字段（复用 / 独立） | §8.2.1 / §8.2.2 |
| ACI-10 | 源字段不存在报错 | §5.6.6 |
| ACI-11 | `BILL_SPLIT_CONFIG_MISSING` 保存阶段校验 | §5.2.1 |
| ACI-12 | 多文件全部未命中聚合告警 | §5.6.5 + §8.4 |

**覆盖率**：94/94 = 100%。所有 PRD 既有 AC 都有对应的 TechDoc 实现章节。

**新增 AC 提议**：Q-OT6 = C 决策（2026-04-08）后，TechDoc 在 §3.4.3 / §5.3 / §7.3.4 落实了"删除前合并组解散二次确认 + PRD §Q-A3 不变量保持"两条新行为。这两条**超出**当前 PRD 的 94 AC 描述范围（PRD AC1-43 只说"不弹二次确认"，与 Q-OT6=C 决策冲突）。Dev 在此**建议 PM 在 task #3 写 TestCases 之前**先把以下 2 条 AC 加入 PRD-v1.4.9.md（任由 PM 决定编号，建议 AC1-43-NEW / AC1-44-NEW 或重排）：

- **AC1-43-NEW**：删除一行前，若该删除会导致受影响的合并组（自身所在组 OR 其它组中存在 seq ≥ 删除行 seq 的成员），前端必须弹出二次确认对话框，列出将被解散的合并组代表序号；用户取消则不删除。
- **AC1-44-NEW**：删除完成后，所有幸存的合并组必须满足 PRD §Q-A3 不变量「`merged_group_seq` = 组内最小 seq_no」。

PRD 添加这 2 条 AC 后，覆盖率变成 96/96 = 100%（仍然 100%，但分母由 94 → 96）。Tester 在 task #3 写 TestCases 时按这 2 条 AC 设计 Test case。

### 12.2 版本号变更

- `package.json` 的 `version` 字段：`1.4.8` → `1.4.9`
- `src/main.js` 的 `SUPPORTED_BUNDLE_VERSION` 常量：`2` → `3`
- Release Note 草稿来源：PRD §12（已 PM 锁定，可直接发布）

---

## 十三、修订记录

| 日期 | 变更内容 | 作者 |
|------|---------|------|
| 2026-04-08 | 初版 TechDoc 生成。覆盖 PRD-v1.4.9.md 定稿的 94 AC（AC1-1 ~ AC1-82 + ACI-1 ~ ACI-12），13 章结构对齐 `docs/iterations/v1.4.8/TechDoc-v1.4.8.md`；落定 3 张新表 schema 与幂等迁移 SQL；落定 8 个新 IPC 通道命名；落定 4 方互斥扩展方案；提交 8 个 Open Technical Questions（Q-OT1 ~ Q-OT8）公示 Dev 的实现选择。 | Dev |
| 2026-04-08 | **team-lead 决策更新**：Q-OT2 选 B、Q-OT6 选 C / Dev 选 C1 surgical。具体改动：(1) 新增第 4 张表 `template_bill_split_meta`（1:1 with template，独立存「按正负号拆分的发生额」字段），与 `template_bill_split_amount_rules` 完全分离；新增 repo 函数 `getBillSplitMeta` / `saveBillSplitMeta`；删除常量 `BILL_SPLIT_SIGNED_AMOUNT_TARGET`；将原 IPC `template:save-bill-split-amount-rules` 拆分为 `template:save-bill-split-amount-rules`（仅承载规则数组）+ `template:save-bill-split-meta`（仅承载 signed 字段）；bundle JSON v3 顶层新增 `billSplitMeta` 字段；前端 state / onChange / IPC 调用全部对应拆分。(2) `deleteBillSplitRow` 新增"受影响合并组解散"逻辑（C1 surgical：自身所在组 + 任一其它组中存在 seq ≥ 删除行 seq 的成员），新增 `template:preview-delete-bill-split-row` IPC + 前端 deleteBtn 二次确认 UI；保证 PRD §Q-A3 不变量「`merged_group_seq` = 组内最小 seq_no」。提议 PM 在 task #3 之前为 PRD 加入 AC1-43-NEW / AC1-44-NEW 两条 AC（详见 §12.1 末尾说明）。 | Dev (执行 team-lead 决策) |
| 2026-04-08 fix2 | **基于 v1.4.9 实施后用户实测反馈同步 TechDoc**，对应代码 commit 范围 `fc91550..57dbd38`（8 个 fix commit）。override 项：(1) **Fix #2（`6031f88`）** §4.2 错误码表、§5.6.4 `applyBillSplitMerge` 伪代码、§5.6.3 `expandBillSplitForRow` 伪代码、§8.3 导入错误流：`BILL_MERGE_NET_ZERO` 改为 deprecated，合并组净值 = 0 静默 `continue` 跳过整组，并新增"单行拆分输出 Credit/Debit 全 0 静默丢弃"的过滤逻辑（双保险：`expandBillSplitForRow` 的 `.filter(r => r !== null)` + `applyBillSplitMerge` 对 standalone 行的再次过滤）。`BILL_MERGE_CURRENCY_MISMATCH` 保留不变。(2) **Fix #7（`04a2e21`）** §7.3.2 ASCII 图 + §7.3.8 关闭逻辑：弹框 2 右下角新增 `.bill-split-rows-done-btn` 按钮，click 等同 × 关闭（不做额外 save），对应 PRD AC1-27 override + AC1-27a 新增。(3) **Fix #8（`57dbd38`）** §7.3.3 `nDoneButton.textContent = '拆'`（原 `完成`）；CSS 新增 `.bill-split-row-count-done-btn.secondary-btn.small { min-width: 0; width: 71px; }` 覆盖 `.small { min-width: 108px }`。(4) **Fix #4（`3eaaf14`）** §7.2 弹框尺寸 + §7.5 CSS：弹框 1 从 `width: 50%; max-width: 500px` 改为 `width: 80vw; min-width: 520px; max-width: none`；CSS 类名由 `.bill-split-mappings-dialog` 实际采用为 `.bill-split-mappings-card`。(5) **Fix #5（`cb127c0`）** §7.2.2：弹框 1 Balance 字段选项与主表格对齐（`无` / `通过发生额计算` / `headers`），后端 `validateBillSplitMappingsPayload` 加 `isBalanceSpecialValue` 旁路；Balance 行不渲染 concat-field-picker。(6) **Fix #1（`fc91550`）** §7.3.2：弹框 2 「合并账单」下拉框由 `<select multiple>` 改为 `.bill-split-merge-picker` (trigger + panel) checkbox-panel 模式，复用 concat-picker 惯例；§7.5 CSS 新增 `.bill-split-merge-picker-*` 样式。(7) **Fix #3（`8041619`）** §7.1.4：`applyAmountSplitMutualExclusion` 顶部 early-return 当 `isBillSplitMergeEnabledInTable()` 返回 true，避免覆盖 `applyBillSplitMergeMutualExclusion(true)` 设置的 disabled 状态；`applyBillSplitMergeMutualExclusion` 显式禁用行内所有按钮（`data-bill-split-merge-disabled='true'`）。(8) **Fix #6（`d30ec96`）** §5.5.1：`template:get-mappings` IPC handler 的 return 对象补齐 5 个 billSplit 字段（`billSplitGroupFields` / `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta`），修复冷启动首次打开弹框 2 显示空状态的 bug。 | dev-3（根据用户 fix2 反馈 + team-lead override 指令） |

