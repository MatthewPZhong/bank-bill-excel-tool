const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeText } = require('./utils');
// v2.1.9 SR-log-1 (T32h)：替换 console.error → appendModuleLog 双写
const { appendModuleLog } = require('../logger');

function hasColumn(db, tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((column) => normalizeText(column.name) === normalizeText(columnName));
}

function ensureTemplateKeySupport(db) {
  db.exec('BEGIN');

  try {
    if (!hasColumn(db, 'templates', 'template_key')) {
      db.exec('ALTER TABLE templates ADD COLUMN template_key TEXT;');
    }

    const rows = db
      .prepare(`
        SELECT id
        FROM templates
        WHERE COALESCE(template_key, '') = ''
      `)
      .all();

    const updateStatement = db.prepare(`
      UPDATE templates
      SET template_key = ?
      WHERE id = ?
    `);

    rows.forEach((row) => {
      updateStatement.run(randomUUID(), row.id);
    });

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS templates_template_key_unique
      ON templates(template_key);
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureTemplateMappingEnhancements(db) {
  db.exec('BEGIN');

  try {
    if (!hasColumn(db, 'template_mappings', 'mapped_fields_json')) {
      db.exec('ALTER TABLE template_mappings ADD COLUMN mapped_fields_json TEXT NOT NULL DEFAULT \'[]\';');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS template_fixed_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        merchant_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, row_index)
      );
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureAccountMappingCurrencySupport(db) {
  if (!hasColumn(db, 'account_mappings', 'no_currency')) {
    db.exec("ALTER TABLE account_mappings ADD COLUMN no_currency INTEGER NOT NULL DEFAULT 0;");
  }
  if (!hasColumn(db, 'account_mappings', 'currency')) {
    db.exec("ALTER TABLE account_mappings ADD COLUMN currency TEXT NOT NULL DEFAULT '';");
  }
}

function ensureTemplateDateFormatSupport(db) {
  if (!hasColumn(db, 'templates', 'date_format')) {
    db.exec("ALTER TABLE templates ADD COLUMN date_format TEXT NOT NULL DEFAULT 'auto';");
  }
}

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

function ensureBillSplitTargetSeqSupport(db) {
  if (!hasColumn(db, 'template_bill_split_meta', 'signed_amount_target_seq_nos')) {
    db.exec("ALTER TABLE template_bill_split_meta ADD COLUMN signed_amount_target_seq_nos TEXT NOT NULL DEFAULT '';");
  }
  if (!hasColumn(db, 'template_bill_split_meta', 'by_field_amount_target_seq_nos')) {
    db.exec("ALTER TABLE template_bill_split_meta ADD COLUMN by_field_amount_target_seq_nos TEXT NOT NULL DEFAULT '';");
  }
}

function ensureAccountMappingTemplateSupport(db) {
  if (hasColumn(db, 'account_mappings', 'template_id')) {
    return;
  }

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE account_mappings RENAME TO account_mappings_old;');

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

    const templates = db.prepare('SELECT id FROM templates').all();
    const oldRowCount = db.prepare('SELECT COUNT(1) AS cnt FROM account_mappings_old').get().cnt;
    if (templates.length > 0 && oldRowCount > 0) {
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

      // 复制给多个模板时标记需要用户手动分配
      if (templates.length > 1) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES ('account_mapping_migration_pending', 'true', ?)
          ON CONFLICT(setting_key) DO UPDATE
          SET setting_value = 'true', updated_at = ?
        `).run(now, now);
      }
    }
    // 无模板但有旧映射时：旧数据无法关联到任何模板，随旧表一起丢弃

    db.exec('DROP TABLE account_mappings_old;');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureParentTemplateSupport(db) {
  if (!hasColumn(db, 'templates', 'parent_template_id')) {
    db.exec('ALTER TABLE templates ADD COLUMN parent_template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL;');
  }
  if (!hasColumn(db, 'templates', 'is_parent')) {
    db.exec('ALTER TABLE templates ADD COLUMN is_parent INTEGER NOT NULL DEFAULT 0;');
  }
}

// v1.5.2 需求 3：按文件名映射模板 — 在 templates 表新增 filename_fixed_field 列
// 幂等：若列已存在则跳过（老库再次启动不重复添加）。
function ensureTemplateFilenameFixedFieldSupport(db) {
  if (!hasColumn(db, 'templates', 'filename_fixed_field')) {
    db.exec("ALTER TABLE templates ADD COLUMN filename_fixed_field TEXT NOT NULL DEFAULT '';");
  }
}

// v1.5.3 需求 R2：自有账号合并入大账号表 — 在 template_big_accounts 表新增 account_nature 列
// 幂等：若列已存在则跳过；默认值 'client'（客资），迁移脚本写入 'own' 表示自有
function ensureTemplateBigAccountNatureSupport(db) {
  if (!hasColumn(db, 'template_big_accounts', 'account_nature')) {
    db.exec("ALTER TABLE template_big_accounts ADD COLUMN account_nature TEXT NOT NULL DEFAULT 'client';");
  }
}

// v2.0.0-beta.3：银行对账单处理模块 — 场景表 + 内置 3 场景 seed
// 幂等：CREATE TABLE IF NOT EXISTS + seed-if-empty
const BUILTIN_SCENARIOS = [
  {
    category: 'extract-recon-id',
    name: '从银行对账单的信息里提取对账ID',
    priority: 3,
    enabled: 1,
    is_builtin: 1,
    config: {
      conditions: [
        { field: 'Extra Information', op: '包含', value: 'AFT' },
        { field: 'Extra Information', op: '包含', value: 'BFT' },
        { field: 'Extra Information', op: '包含', value: 'CFT' },
        { field: 'Extra Information', op: '包含', value: 'DFT' },
        { field: 'CustomerRef',       op: '包含', value: 'AFT' },
        { field: 'CustomerRef',       op: '包含', value: 'BFT' },
        { field: 'CustomerRef',       op: '包含', value: 'CFT' },
        { field: 'CustomerRef',       op: '包含', value: 'DFT' },
        { field: 'Payment Detail',    op: '包含', value: 'AFT' },
        { field: 'Payment Detail',    op: '包含', value: 'BFT' },
        { field: 'Payment Detail',    op: '包含', value: 'CFT' },
        { field: 'Payment Detail',    op: '包含', value: 'DFT' }
      ],
      extractByFeature: {
        enabled: true,
        searchFields: ['CustomerRef', 'Extra Information', 'Payment Detail'],
        featureCode: 'FT',
        digitCount: 12,
        totalLength: 15
      },
      extractByOtherField: null
    }
  },
  {
    category: 'offset-bill-mark',
    name: 'outbound改标为outbound Fail',
    priority: 2,
    enabled: 1,
    is_builtin: 1,
    config: {
      billTypes: [
        { seq: 1, field: 'FundType', op: '等于', value: 'outbound Fail' },
        { seq: 2, field: 'FundType', op: '等于', value: 'outbound' }
      ],
      reconFields: [
        { seq: 1, leftType: 1, leftField: 'CustomerRef',   rightType: 2, rightField: 'CustomerRef' },
        { seq: 2, leftType: 1, leftField: 'Credit Amount', rightType: 2, rightField: 'Debit Amount' }
      ],
      markValue: {
        type: 2,
        field: 'FundType',
        value: 'outbound Fail'
      }
    }
  },
  {
    category: 'gateway-recon-join',
    name: '与网关对账单根据金额币种一对一匹配对账ID',
    priority: 1,
    enabled: 0,
    is_builtin: 1,
    config: {
      reconFields: [
        // 网关账单 sheet 实际表头大小写：'Currency'（大写 C）；
        // PR #29 早期 seed 误用小写 'currency' → C3 默认场景全行匹配不到（Codex PR #31 F3 P1 修复）
        { seq: 1, gwField: 'Currency',   bankField: 'Currency' },
        { seq: 2, gwField: 'Amount',     bankField: '发生额绝对值' },
        { seq: 3, gwField: 'MerchantId', bankField: 'MerchantId' },
        { seq: 4, gwField: 'Bank',       bankField: 'Channel' }
      ],
      assign: {
        gwField: 'reconciliationId',
        bankField: 'ReconciliationId'
      }
    }
  }
];

// seed 标记 key（落在 app_settings 表）
// 一旦 seed 过 → marker=true → 此后永不重复 seed，即使用户把所有内置场景删光
// 这是 D14 "内置场景可删除" 的语义保障：删除是终态，重启不会复活
const SCENARIOS_SEEDED_MARKER = 'scenarios_seeded';

function ensureScenariosSupport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join')),
      name TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      config_json TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (name)
    );
  `);

  // 1. marker 已存在 → 已 seed 过，无论当前表是否为空都不再 seed（D14 删除终态保护）
  const markerRow = db
    .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
    .get(SCENARIOS_SEEDED_MARKER);
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return;
  }

  const now = new Date().toISOString();
  const writeMarker = () => {
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value,
          updated_at = excluded.updated_at
    `).run(SCENARIOS_SEEDED_MARKER, now);
  };

  // 2. marker 不存在但表已有数据 → 老库迁移路径（无 marker 时已被早期版本 seed 过）
  //    仅写 marker 防止后续误判，不重复 seed
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM scenarios').get();
  if (countRow && Number(countRow.cnt) > 0) {
    writeMarker();
    return;
  }

  // 3. marker 不存在且表为空 → 全新库，seed 3 内置场景 + 写 marker
  const insert = db.prepare(`
    INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    BUILTIN_SCENARIOS.forEach((scenario) => {
      insert.run(
        scenario.category,
        scenario.name,
        scenario.priority,
        scenario.enabled,
        JSON.stringify(scenario.config),
        scenario.is_builtin,
        now,
        now
      );
    });
    writeMarker();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v2.0.0-beta.3 PR #32b：一次性更新内置场景 name（旧 → 新，用户友好命名）
// 仅在 name 仍是旧值（用户未自行重命名）时更新；UNIQUE 冲突时跳过保留旧名
function ensureBuiltinScenarioNamesUpdate(db) {
  const renames = [
    { oldName: '调拨ReconId自提取',     newName: '从银行对账单的信息里提取对账ID',       category: 'extract-recon-id' },
    { oldName: 'outbound Fail打标',     newName: 'outbound改标为outbound Fail',          category: 'offset-bill-mark' },
    { oldName: '调拨ReconId From网关',  newName: '与网关对账单根据金额币种一对一匹配对账ID', category: 'gateway-recon-join' }
  ];
  const upd = db.prepare(`UPDATE scenarios SET name = ?, updated_at = ? WHERE name = ? AND category = ? AND is_builtin = 1`);
  const now = new Date().toISOString();
  renames.forEach(({ oldName, newName, category }) => {
    try {
      upd.run(newName, now, oldName, category);
    } catch (_err) {
      // UNIQUE 冲突（已存在新 name）→ 跳过保留旧名
    }
  });
}

// v2.1.0-beta.3：扩展 scenarios.category CHECK 约束，新增 'gateway-recon-id-fix' 枚举值
// 背景：v2.1.0-beta.1 PR-A 已扩到 4 值（recon-id-fix 加入）；本迭代新增 C4 gateway 子模式 → 扩到 5 值
// 模板完全沿用 ensureScenariosCategoryReconIdFix，PR #37/#38 已实战验证
// SQLite 不支持 ALTER TABLE 改 CHECK → 必须重建表
// 资金红线：必须包在事务里；老库（含本版本前任意旧场景）必须无损迁移；id / 列结构 / UNIQUE / 默认值都须保留
// 幂等：解析 sqlite_master.sql，已含 'gateway-recon-id-fix' → no-op；多次启动只触发一次重建
// 调用顺序：必须在 ensureScenariosCategoryReconIdFix 之后（依赖 CHECK 已扩到 4 值）
function ensureScenariosCategoryGatewayReconIdFix(db) {
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return;
  if (tableSqlRow.sql.includes("'gateway-recon-id-fix'")) return; // 已扩，no-op

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE scenarios RENAME TO scenarios_old;');

    db.exec(`
      CREATE TABLE scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (category IN (
          'extract-recon-id',
          'offset-bill-mark',
          'gateway-recon-join',
          'recon-id-fix',
          'gateway-recon-id-fix'
        )),
        name TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (name)
      );
    `);

    db.exec(`
      INSERT INTO scenarios
        (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      SELECT id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at
      FROM scenarios_old;
    `);

    db.exec('DROP TABLE scenarios_old;');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v2.1.0-beta.1 PR-A：扩展 scenarios.category CHECK 约束，新增 'recon-id-fix' 枚举值
// 背景：v2.0.0-beta.3 PR #29 / #32b 的 CHECK 仅含 3 值；本迭代新增 C4「单据对账 ReconID 修复」类需要扩到 4 值。
// SQLite 不支持 ALTER TABLE 改 CHECK → 必须重建表。
// 资金红线：必须包在事务里；包含 v2.0.0-beta.3 builtin scenarios 的老库必须无损迁移；id / 列结构 / UNIQUE / 默认值都须保留。
// 幂等：解析 sqlite_master.sql 字符串，已含 'recon-id-fix' → no-op；多次启动仅触发一次重建。
// 注：必须在 ensureScenariosSupport（含 seed marker 写入）之后调用，避免迁移过程触发不必要的 marker 写入。
function ensureScenariosCategoryReconIdFix(db) {
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return;
  if (tableSqlRow.sql.includes("'recon-id-fix'")) return; // 已扩，no-op

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE scenarios RENAME TO scenarios_old;');

    db.exec(`
      CREATE TABLE scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (category IN (
          'extract-recon-id',
          'offset-bill-mark',
          'gateway-recon-join',
          'recon-id-fix'
        )),
        name TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (name)
      );
    `);

    db.exec(`
      INSERT INTO scenarios
        (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      SELECT id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at
      FROM scenarios_old;
    `);

    db.exec('DROP TABLE scenarios_old;');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v2.1.0-beta.1 PR-B（Q1=B 决策回写，2026-04-30）：把 C4 类场景的 config_json
// 从 reconFields[]（含 seq/leftTypeSeq/rightTypeSeq/leftField/rightField，
// 同 seq AND / 不同 seq OR）迁移到 reconGroups[]（每个 group 自带
// leftTypeSeq/rightTypeSeq + fieldPairs[{leftField, rightField}]，
// 一个 group 内部 AND，多个 group 之间 OR）。
//
// 老结构 → 新结构的语义映射（按 seq 聚合）：
//   reconFields[seq=1, leftField=A, rightField=B]  → reconGroups[0].fieldPairs[0] = {A, B}
//   reconFields[seq=1, leftField=C, rightField=D]  → reconGroups[0].fieldPairs[1] = {C, D}
//   reconFields[seq=2, leftField=E, rightField=F]  → reconGroups[1].fieldPairs[0] = {E, F}
//   每个 group 的 leftTypeSeq/rightTypeSeq 沿用同 seq 第一条 reconField 的取值
//
// 幂等：
//   - 已含 reconGroups → no-op（不再读 reconFields）
//   - 仅含 reconFields[] → 转换 + 写回（删除 reconFields，新增 reconGroups）
//   - 两个都没有（空场景或非 C4）→ no-op
//   - 解析 config_json 失败 → 跳过该行
function migrateC4ReconGroupsStructure(db) {
  const rows = db.prepare(
    `SELECT id, config_json FROM scenarios WHERE category = 'recon-id-fix'`
  ).all();
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  rows.forEach((row) => {
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch (_e) {
      return; // 解析失败跳过
    }
    if (!config || typeof config !== 'object') return;
    // 幂等：已含 reconGroups → no-op（即便同时含历史 reconFields 也以 reconGroups 为准）
    if (Array.isArray(config.reconGroups) && config.reconGroups.length > 0) {
      // 边界：若同时含残留 reconFields → 删掉历史字段（避免下次再触发本迁移做无意义工作）
      if (Object.prototype.hasOwnProperty.call(config, 'reconFields')) {
        delete config.reconFields;
        update.run(JSON.stringify(config), now, row.id);
      }
      return;
    }
    if (!Array.isArray(config.reconFields) || config.reconFields.length === 0) {
      // 没有 reconFields[] 也没有 reconGroups → no-op（用户保存过空场景；后续 dialog 再补默认）
      return;
    }
    // 按 seq 聚合（保持与老 groupReconFields 同语义）
    const grouped = new Map();
    for (const rf of config.reconFields) {
      if (!rf || typeof rf !== 'object') continue;
      const seq = rf.seq;
      if (!grouped.has(seq)) {
        grouped.set(seq, {
          leftTypeSeq: rf.leftTypeSeq,
          rightTypeSeq: rf.rightTypeSeq,
          fieldPairs: []
        });
      }
      grouped.get(seq).fieldPairs.push({
        leftField: rf.leftField,
        rightField: rf.rightField
      });
    }
    config.reconGroups = Array.from(grouped.values());
    delete config.reconFields;
    update.run(JSON.stringify(config), now, row.id);
  });
}

// v2.1.0-beta.1 PR-B Round 3（Decision 4，2026-05-09）：给 C4 场景的 reconGroups 强制带 Amount 锁定 fieldPair
// 处理 3 类老数据：
//   1. fieldPairs 中已有 leftField=='Amount' && rightField=='Amount' 但缺 locked 标记 → 补 locked: true
//   2. fieldPairs 中没有 Amount/Amount 行 → 在 fieldPairs 头部插入 { leftField: 'Amount', rightField: 'Amount', locked: true }
//   3. 已含 locked Amount/Amount → no-op（幂等）
// 仅扫 category='recon-id-fix'，不动 C2/C3 reconFields[] 结构
function migrateC4ReconGroupsAmountLockedFieldPair(db) {
  const rows = db.prepare(
    `SELECT id, config_json FROM scenarios WHERE category = 'recon-id-fix'`
  ).all();
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  rows.forEach((row) => {
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch (_e) {
      return;
    }
    if (!config || typeof config !== 'object') return;
    if (!Array.isArray(config.reconGroups) || config.reconGroups.length === 0) return;
    let changed = false;
    config.reconGroups.forEach((grp) => {
      if (!grp || typeof grp !== 'object') return;
      if (!Array.isArray(grp.fieldPairs)) {
        grp.fieldPairs = [{ leftField: 'Amount', rightField: 'Amount', locked: true }];
        changed = true;
        return;
      }
      let hasAmountLocked = false;
      let hasAmountUnlocked = false;
      grp.fieldPairs.forEach((fp) => {
        if (fp && fp.leftField === 'Amount' && fp.rightField === 'Amount') {
          if (fp.locked === true) {
            hasAmountLocked = true;
          } else {
            // 老数据：补 locked
            fp.locked = true;
            hasAmountLocked = true;
            hasAmountUnlocked = true;
            changed = true;
          }
        }
      });
      if (!hasAmountLocked) {
        // 头部插一条
        grp.fieldPairs.unshift({ leftField: 'Amount', rightField: 'Amount', locked: true });
        changed = true;
      }
      // hasAmountUnlocked 仅用于跟踪 — 已在循环里 changed
      void hasAmountUnlocked;
    });
    if (changed) {
      update.run(JSON.stringify(config), now, row.id);
    }
  });
}

// v2.1.0-beta.3 PR #39 self-review P1-1：一次性修复 v2.1.0-beta.3 早期测试期创建的 gateway 场景
// fieldPairs locked 行 rightField='Amount'（应为 'receiveAmount'）的数据。
// 背景：fix-5（commit f291013）发布给用户测试时，createDefaultScenarioConfig 仍写死 Amount/Amount；
//       fix-round-2（commit 3f826e6）才修正默认值。期间用户创建的 gateway 场景 config_json 含 Amount/Amount locked
//       → 引擎拿渠道行不存在的 Amount 字段匹配 → 1v1/1v多/多v1 全部 0 命中
// 修复：扫描 scenarios category='gateway-recon-id-fix'，把 reconGroups[i].fieldPairs[j] 内
//       `locked === true && leftField === 'Amount' && rightField === 'Amount'` 强制改为 rightField='receiveAmount'
// 幂等：执行一次后 rightField 已是 'receiveAmount'，再跑命中 0 条 → no-op
// 调用顺序：必须在 ensureScenariosCategoryGatewayReconIdFix 之后（依赖 category 枚举已扩 5 值）
function migrateGatewayReconIdFixFieldPairs(db) {
  const rows = db.prepare(
    `SELECT id, config_json FROM scenarios WHERE category = 'gateway-recon-id-fix'`
  ).all();
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  rows.forEach((row) => {
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch (_e) {
      return;
    }
    if (!config || typeof config !== 'object') return;
    if (!Array.isArray(config.reconGroups) || config.reconGroups.length === 0) return;
    let changed = false;
    config.reconGroups.forEach((grp) => {
      if (!grp || typeof grp !== 'object' || !Array.isArray(grp.fieldPairs)) return;
      grp.fieldPairs.forEach((fp) => {
        if (!fp) return;
        // gateway 子模式 locked Amount 行 rightField 必须是 receiveAmount
        if (fp.locked === true && fp.leftField === 'Amount' && fp.rightField === 'Amount') {
          fp.rightField = 'receiveAmount';
          changed = true;
        }
      });
    });
    if (changed) {
      update.run(JSON.stringify(config), now, row.id);
    }
  });
}

// v2.0.0-beta.3 PR #32b：一次性修复历史 PR #29 seed 的小写 'currency' 错误
// 背景：PR #29 初始 seed 时把 C3 内置场景的 reconFields[0].gwField 写成小写 'currency'，
//       PR #31 修了 seed JSON 但 marker 机制保护老库不重 seed → 用户老 DB 里仍是小写。
//       结果：v2.0.0-beta.3 dialog 渲染时网关字段下拉的 selected 不匹配（GATEWAY_RECON_FIELDS 是 'Currency' 大写），
//       UI 显示空选项。
// 修复：扫描所有 'gateway-recon-join' 场景，发现 reconFields[].gwField === 'currency' → 改为 'Currency'
// 幂等：执行一次后 'currency' 就被替换为 'Currency'，再次运行不命中 → no-op
function ensureC3GwFieldCurrencyCaseFix(db) {
  const rows = db.prepare(
    `SELECT id, config_json FROM scenarios WHERE category = 'gateway-recon-join'`
  ).all();
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  rows.forEach((row) => {
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch (_e) {
      return; // 解析失败跳过
    }
    if (!config || !Array.isArray(config.reconFields)) return;
    let changed = false;
    config.reconFields.forEach((rf) => {
      if (rf && rf.gwField === 'currency') {
        rf.gwField = 'Currency';
        changed = true;
      }
    });
    if (changed) {
      update.run(JSON.stringify(config), now, row.id);
    }
  });
}

// v2.1.8 N4：差异表瘦身 — bill_imports.raw_json 一次性 rewrite 仅保留 9 模版字段（破坏性，永久删 17 字段值）
// ⚠️ 资金红线 + 破坏性 schema：spec v0.10 §三.1 / PRD v0.9 §八.1
//
// 流程：
//   1. 幂等检查 app_settings.acquiring_bill_raw_json_v2_migrated = 'true' → 跳过
//   2. 备份 DB：v2.1.9 N4 重构 (T32e, D22=a) 切换到 createBackupFn (SR-backup-1 sqlite VACUUM INTO)
//      旧实现：PRAGMA wal_checkpoint(TRUNCATE) + fs.copyFileSync 到 <dbDir>/backups/tool-data-bak-pre-N4-<ts>.sqlite
//      新实现：createBackupFn('pre-N4') → 内部 VACUUM INTO + atomic rename；备份路径仍是 <dbDir>/backups/tool-data-bak-pre-N4-{timestamp}.sqlite（行为不变）
//   3. 事务包裹：分批扫 bill_imports → JSON.parse → 只保留 TEMPLATE_BILL_HEADERS 9 字段 → JSON.stringify → UPDATE raw_json
//   4. 成功后写 marker = 'true'；失败回滚事务 + activityLog（caller 端 console.error）+ marker 不写 → 下次启动重试
//   5. 大数据量分批（每批 5000 + COMMIT 让 event loop 喘气）
//
// 备份失败 → 整个 migration 不启动（cb 抛错，启动期 console.error）；保护用户数据完整性
//
// v2.1.8 self-review SR1 修订：从本地常量改 require columns.js 的 TEMPLATE_BILL_HEADERS
//   避免双源真理 — 模版字段是 N4 输出契约，未来若 PM 改模版（如增字段）
//   必须仅改 columns.js 一处，migration 自动跟随；不可在此处独立维护副本
const { TEMPLATE_BILL_HEADERS } = require('../acquiring-bill-currency-db/columns');
const BILL_RAW_JSON_V2_MIGRATED_KEY = 'acquiring_bill_raw_json_v2_migrated';
function ensureBillRawJsonV2Slim(db, dbPath, createBackupFn) {
  // 1. 幂等检查
  let markerRow;
  try {
    markerRow = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(BILL_RAW_JSON_V2_MIGRATED_KEY);
  } catch (_e) {
    // app_settings 表不存在（极早期启动） → 跳过本次（等下一次启动）
    return { status: 'skipped-no-settings-table' };
  }
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'already-migrated' };
  }

  // 检查目标表是否存在（极早期启动）
  let billCount;
  try {
    billCount = db.prepare('SELECT COUNT(*) as c FROM acquiring_bill_currency_bill_imports').get().c;
  } catch (_e) {
    return { status: 'skipped-no-bill-table' };
  }

  // 2. 备份 DB（不论 billCount > 0 与否，首次都备份一份；后续幂等跳过）
  //   v2.1.9 N4 重构 (T32e, D22=a)：切换到 createBackupFn（SR-backup-1 VACUUM INTO 体系）
  //     - VACUUM INTO 原子写 + WAL 一致 + 备份过程库可读
  //     - 备份路径仍是 <dbDir>/backups/tool-data-bak-pre-N4-{timestamp}.sqlite（行为不变 — v2.1.8 已发用户机器路径契约保护）
  //     - 注入函数解耦 migrations.js 与 backup.js → 单元测试可注入 mock
  //   兼容性：createBackupFn 缺失（无 dbPath 或老调用方）→ 跳过备份阶段（既有行为不变）
  let backupPath = null;
  if (dbPath && typeof createBackupFn === 'function') {
    try {
      backupPath = createBackupFn('pre-N4');
    } catch (backupErr) {
      // 备份失败 → 不启动 migration（数据完整性优先）；下次启动重试
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'migration',
        message: '[migration N4] DB backup failed, aborting raw_json slim migration',
        details: [backupErr && backupErr.message ? backupErr.message : String(backupErr)],
        stack: backupErr && backupErr.stack ? backupErr.stack : undefined
      });
      return { status: 'backup-failed', error: backupErr.message };
    }
  }

  // billCount=0 时直接写 marker 完事
  if (billCount === 0) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(BILL_RAW_JSON_V2_MIGRATED_KEY, now);
    return { status: 'migrated-empty', backupPath, rowsAffected: 0 };
  }

  // 3. 分批事务 rewrite
  const BATCH = 5000;
  let totalRewritten = 0;
  let lastId = 0;
  const selectStmt = db.prepare('SELECT id, raw_json FROM acquiring_bill_currency_bill_imports WHERE id > ? ORDER BY id ASC LIMIT ?');
  const updateStmt = db.prepare('UPDATE acquiring_bill_currency_bill_imports SET raw_json = ? WHERE id = ?');

  while (true) {
    const rows = selectStmt.all(lastId, BATCH);
    if (rows.length === 0) break;
    db.exec('BEGIN');
    let batchUpdated = 0; // SR2 修订：实际 UPDATE 计数（剔除 JSON.parse 跳过的行），totalRewritten 累加更准
    try {
      for (const row of rows) {
        let rawObj;
        try {
          rawObj = JSON.parse(row.raw_json);
        } catch (_parseErr) {
          // 单行 JSON 损坏 → 跳过这行（保留原值，避免误删）；lastId 仍前推保证游标进度
          lastId = row.id;
          continue;
        }
        const slim = {};
        for (const key of TEMPLATE_BILL_HEADERS) {
          if (key in rawObj) slim[key] = rawObj[key];
        }
        updateStmt.run(JSON.stringify(slim), row.id);
        lastId = row.id;
        batchUpdated++;
      }
      db.exec('COMMIT');
      totalRewritten += batchUpdated;
    } catch (batchErr) {
      try { db.exec('ROLLBACK'); } catch (_e) { /* swallow */ }
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'migration',
        message: '[migration N4] batch rewrite failed, marker NOT written, will retry next launch',
        details: [batchErr && batchErr.message ? batchErr.message : String(batchErr)],
        stack: batchErr && batchErr.stack ? batchErr.stack : undefined
      });
      return { status: 'batch-failed', error: batchErr.message, totalRewritten, backupPath };
    }
    if (rows.length < BATCH) break;
  }

  // 4. 写 marker（仅全部成功才写，确保失败可重试）
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, 'true', ?)
    ON CONFLICT(setting_key) DO UPDATE
    SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
  `).run(BILL_RAW_JSON_V2_MIGRATED_KEY, now);

  return { status: 'migrated', backupPath, rowsAffected: totalRewritten };
}

// v2.1.8 N1：给 acquiring_bill_currency_runs 加 cleanup_pending 列（β 方案：cleanup 移出对账链路）
// 背景：v2.1.7 runCheck 成功后 main.js:10307 setImmediate(cleanupAfterRunBackground) 立即异步清；
//       v2.1.8 N1 β 改为延迟到 app.before-quit（主清）+ 进入模块时（兜底）；
//       runs 表加 cleanup_pending=1 标记"待清理"，cleanup 完成后 SET=0
// 幂等：hasColumn 检查避免重复 ADD COLUMN
function ensureAcquiringBillCurrencyRunsCleanupPending(db) {
  if (hasColumn(db, 'acquiring_bill_currency_runs', 'cleanup_pending')) return;
  db.exec(`ALTER TABLE acquiring_bill_currency_runs ADD COLUMN cleanup_pending INTEGER DEFAULT 0`);
}

// v2.1.9 N1-settings (T32b)：把硬编码 30min idle cleanup 阈值改为 settings 化
//   spec.md §13.2 / tasks.md T32b / 资金红线缓解：阈值过小会过于频繁清理；过大会让 cleanup 永不触发
//   范围 5-180 分钟前端 + 后端双校验（main.js IPC handler + renderer-dialogs.js input 属性）
//   默认 30（与 v2.1.8 N1' 硬编码值一致 → 升级不改行为）
//   幂等：INSERT OR IGNORE 不覆盖用户已设值
const ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY = 'acquiring_bill_idle_cleanup_minutes';
const ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT = '30';
function ensureAcquiringBillIdleCleanupMinutesSetting(db) {
  // app_settings 表理论上由 ensureScenariosSupport 之前就建好（既有 settings 调用方都依赖）
  // 防御性检查：若表不存在则跳过，等下次启动 schema 完整后再 seed
  try {
    db.prepare('SELECT 1 FROM app_settings LIMIT 1').get();
  } catch (_e) {
    return { status: 'skipped-no-table' };
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, ?)
  `).run(
    ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY,
    ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT,
    now
  );
  return { status: 'seeded', key: ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY };
}

// v2.1.10 A4 T18：seed 收单单据 SQL JOIN chunked 分批 size 默认值（100000）
//   spec §3.2 拍板默认 10w + 范围 [1w, 100w]；getter 范围外回退默认（settings-repository.js）
//   幂等：INSERT OR IGNORE — 用户已改值（sqlite3 直改）不被覆盖
const ACQUIRING_BILL_CHUNK_SIZE_KEY = 'acquiring_bill_chunk_size';
const ACQUIRING_BILL_CHUNK_SIZE_DEFAULT = '100000';
function ensureAcquiringBillChunkSizeSetting(db) {
  // 同 ensureAcquiringBillIdleCleanupMinutesSetting：依赖 app_settings 表存在
  try {
    db.prepare('SELECT 1 FROM app_settings LIMIT 1').get();
  } catch (_e) {
    return { status: 'skipped-no-table' };
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, ?)
  `).run(
    ACQUIRING_BILL_CHUNK_SIZE_KEY,
    ACQUIRING_BILL_CHUNK_SIZE_DEFAULT,
    now
  );
  return { status: 'seeded', key: ACQUIRING_BILL_CHUNK_SIZE_KEY };
}

// v2.1.10 A4 T19：给 acquiring_bill_currency_runs 加 chunk_progress 列（chunked 进度 JSON 序列化）
//   值结构：JSON `{ lastCompletedChunkIndex, totalChunks, status: 'in-progress' | 'partial' | 'complete' }`
//   - in-progress：runCheckCore stage 4' chunked 循环刚开始（totalChunks 已算出）
//   - partial：cancel 或 crash 中途；lastCompletedChunkIndex 指向最后一个 COMMIT 的 chunk
//   - complete：所有 chunk 都 COMMIT 完毕
//   resume 路径：renderer 调 acquiringBillCurrency:run:resume → 主进程查 runs.chunk_progress
//     → 不存在 / status='complete' → 抛错；存在 → 从 lastCompletedChunkIndex+1 重启
//   幂等：hasColumn 检查避免重复 ADD COLUMN
function ensureAcquiringBillCurrencyRunsChunkProgress(db) {
  if (hasColumn(db, 'acquiring_bill_currency_runs', 'chunk_progress')) return;
  db.exec(`ALTER TABLE acquiring_bill_currency_runs ADD COLUMN chunk_progress TEXT`);
}

// v2.1.10 N4-cont-1 T22 (Phase 4)：seed 收单单据 raw_json idle 自动清理保留窗口（默认 7 天）
//   spec §4.1.1 单键策略（v0.2 reverse sync 后从 v0.1 双键降为单键）
//   - 仅清「对账成功」（不在 acquiring_bill_currency_diff_rows 中）且 imported_at < N 天前的 bill_imports.raw_json
//   - 差异行 raw_json 永远保留（writer.js:184 重导差异 xlsx 依赖；migrations.js:1543 diff_rows schema 不冗余存）
//   - 范围 [1, 30] 天；getter 范围外回退默认 7（settings-repository）
//   - 触发链路：v2.1.9 N1' idle 30min cleanup 回调追加调用（src/main.js setupIdleCleanupTimer）
//   幂等：INSERT OR IGNORE — 用户已改值（sqlite3 直改）不被覆盖
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY = 'acquiring_bill_raw_json_retention_days';
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT = '7';
function ensureAcquiringBillCurrencyRawJsonRetentionSettings(db) {
  // 同 ensureAcquiringBillIdleCleanupMinutesSetting：依赖 app_settings 表存在
  try {
    db.prepare('SELECT 1 FROM app_settings LIMIT 1').get();
  } catch (_e) {
    return { status: 'skipped-no-table' };
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, ?)
  `).run(
    ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY,
    ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT,
    now
  );
  return { status: 'seeded', key: ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY };
}

// v2.1.9 N5：channels 表 + 「通用」内置渠道（id=1）
// 幂等：CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE
// is_builtin=1 系统内置渠道，不可删不可改名（D1=a 拍板；保护在 channels-repository + UI 层）
function ensureChannelsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_location TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (name, owner_location)
    );
  `);
  // 启动期幂等插入「通用」内置渠道（保留 id=1 给通用，方便 dispatcher 兜底查询）
  db.exec(`
    INSERT OR IGNORE INTO channels (id, name, owner_location, is_builtin, sort_order, created_at)
    VALUES (1, '通用', '通用', 1, 0, CURRENT_TIMESTAMP);
  `);
}

// v2.1.9 N5：scenarios 表加 channel_id 列 + backfill 「通用」（id=1）
// 幂等：pragma_table_info 检测 channel_id 已存在则 no-op
// FK：ON UPDATE CASCADE（避免渠道改名级联问题；不加 ON DELETE CASCADE → 删除阻止策略由 channels-repository + UI 双重保护）
function ensureScenariosChannelIdColumn(db) {
  if (hasColumn(db, 'scenarios', 'channel_id')) return false;
  db.exec(`ALTER TABLE scenarios ADD COLUMN channel_id INTEGER REFERENCES channels(id) ON UPDATE CASCADE`);
  db.exec(`UPDATE scenarios SET channel_id = 1 WHERE channel_id IS NULL`);
  return true;
}

const N5_MIGRATED_MARKER = 'n5_channels_migrated';
const N5_SCENARIOS_UNIQUE_MIGRATED_MARKER = 'n5_scenarios_unique_migrated';

// v2.1.9 SR-FIX-1 (spec §16.3 🔴 资金红线 + 破坏性 schema 变更)：
//   scenarios.name UNIQUE 全表约束 → (channel_id, name) 复合 UNIQUE 约束
//
// 背景（PR #53 self-review SR1 #3）：
//   - 既有 schema 是 UNIQUE (name) 全表约束（migrations.js:407/519/571）
//   - spec §6.3.2「channel 内同名跳过」语义要求：跨 channel 同名场景允许并存
//   - 全表 UNIQUE 与该语义冲突 → bundle 导入跨渠道复用场景名会被错误跳过
//
// 修复策略（spec §16.3）：
//   1. 检测当前是否仍是全表 UNIQUE(name)：解析 sqlite_master.sql 含 `UNIQUE (name)` / `UNIQUE(name)`
//   2. 检测标志位 N5_SCENARIOS_UNIQUE_MIGRATED_MARKER 已写 → no-op
//   3. 冲突预检（防御性）：SELECT channel_id, name, COUNT(*) GROUP BY ... HAVING > 1
//      - N5 backfill 后所有 channel_id=1，全表 UNIQUE 等价 channel 内 UNIQUE → 理论不应有冲突
//      - 若有冲突 → 抛错（用户介入决定如何处理）
//   4. SQLite 不支持 DROP CONSTRAINT → 重建表 swap：
//      CREATE scenarios_tmp + INSERT SELECT * + DROP old + RENAME → 保留 id / 列结构 / 默认值
//      新表用复合 UNIQUE (channel_id, name)
//   5. 写标志位 N5_SCENARIOS_UNIQUE_MIGRATED_MARKER='true'
//   6. 备份：调用方传 createBackupFn 时前置 `createBackupFn('pre-scenarios-unique-migration')`
//
// 调用顺序：
//   ensureSchemaV2_1_9_N5 （ensureChannelsTable + ensureScenariosChannelIdColumn + backfill）
//     → ensureScenariosNameUniqueByChannelId（本函数）
//   缺一不可：必须保证 scenarios.channel_id 列已加 + 所有行都有非空 channel_id 值
//
// 返回 { status, backupPath?, error? }
//   status:
//     - 'skipped'                 : 标志位 = true，已迁移
//     - 'skipped-no-table'        : scenarios 表不存在
//     - 'skipped-already-composite': 已经是复合 UNIQUE，无需迁移（防御性兜底）
//     - 'skipped-no-channel-id'   : scenarios.channel_id 列缺失（前置 migration 未跑）
//     - 'migrated'                : 本次成功执行
//     - 'backup-failed'           : 备份失败，schema 未改动
//     - 'conflict-detected'       : 同 channel_id 同 name 冲突 → ROLLBACK + 抛
//     - 'migration-failed'        : 事务失败已回滚
function ensureScenariosNameUniqueByChannelId(db, createBackupFn) {
  // 1. 标志位检测
  let markerRow;
  try {
    markerRow = db
      .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
      .get(N5_SCENARIOS_UNIQUE_MIGRATED_MARKER);
  } catch (_) {
    // app_settings 表不存在 → 跳过（理论不发生：migrations 入口已建表）
    return { status: 'skipped-no-table' };
  }
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'skipped' };
  }

  // 2. 解析 scenarios 表 DDL，判定当前 UNIQUE 形态
  const tableSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'")
    .get();
  if (!tableSqlRow || !tableSqlRow.sql) {
    return { status: 'skipped-no-table' };
  }
  const sql = tableSqlRow.sql;
  // 已含复合 UNIQUE → 标志位补写 + no-op
  // 兼容 `UNIQUE (channel_id, name)` / `UNIQUE(channel_id, name)` / 任意空格
  if (/UNIQUE\s*\(\s*channel_id\s*,\s*name\s*\)/i.test(sql)) {
    writeUniqueMigratedMarker(db);
    return { status: 'skipped-already-composite' };
  }
  // 全表 UNIQUE (name) 仍存在（待迁移）
  // 兼容 `UNIQUE (name)` / `UNIQUE(name)`
  const hasOldUnique = /UNIQUE\s*\(\s*name\s*\)/i.test(sql);
  if (!hasOldUnique) {
    // 未识别到 UNIQUE(name)，也未识别到 UNIQUE(channel_id, name) → 防御性补标志位 + no-op
    writeUniqueMigratedMarker(db);
    return { status: 'skipped-already-composite' };
  }

  // 3. 前置：必须保证 scenarios 已有 channel_id 列（前置 N5 migration 必须先跑）
  if (!hasColumn(db, 'scenarios', 'channel_id')) {
    return { status: 'skipped-no-channel-id' };
  }

  // 4. 前置备份（事务外，SR-backup-1 sqlite VACUUM INTO）
  let backupPath = null;
  if (typeof createBackupFn === 'function') {
    try {
      backupPath = createBackupFn('pre-scenarios-unique-migration');
    } catch (e) {
      return { status: 'backup-failed', error: e && e.message ? e.message : String(e) };
    }
  }

  // 5. 事务：冲突预检 + 重建表 swap + 标志位
  try {
    db.exec('BEGIN');

    // 5a. 冲突预检（防御性）：理论 N5 backfill 后所有 channel_id=1 不会冲突
    const conflictRows = db
      .prepare(`
        SELECT channel_id, name, COUNT(*) AS cnt
        FROM scenarios
        GROUP BY channel_id, name
        HAVING COUNT(*) > 1
      `)
      .all();
    if (conflictRows && conflictRows.length > 0) {
      db.exec('ROLLBACK');
      const detail = conflictRows
        .map((r) => `channel_id=${r.channel_id}, name="${r.name}", count=${r.cnt}`)
        .join('; ');
      return {
        status: 'conflict-detected',
        backupPath,
        error: `scenarios 表内存在同 channel_id 下重名记录（理论不应发生），需用户介入：${detail}`,
      };
    }

    // 5b. 重建表 swap（SQLite 不支持 DROP CONSTRAINT；保留 id / 列结构 / 默认值 / FK）
    //   - 解析现有 category CHECK 约束（v2.1.0-beta.3 已扩到 5 值）
    //   - 保留 channel_id FK ON UPDATE CASCADE（spec §3.2）
    //   - 复合 UNIQUE (channel_id, name)
    db.exec('ALTER TABLE scenarios RENAME TO scenarios_old;');
    db.exec(`
      CREATE TABLE scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (category IN (
          'extract-recon-id',
          'offset-bill-mark',
          'gateway-recon-join',
          'recon-id-fix',
          'gateway-recon-id-fix'
        )),
        name TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        channel_id INTEGER REFERENCES channels(id) ON UPDATE CASCADE,
        UNIQUE (channel_id, name)
      );
    `);
    db.exec(`
      INSERT INTO scenarios
        (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at, channel_id)
      SELECT id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at, channel_id
      FROM scenarios_old;
    `);
    db.exec('DROP TABLE scenarios_old;');

    // 5c. 写标志位
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(N5_SCENARIOS_UNIQUE_MIGRATED_MARKER, new Date().toISOString());

    db.exec('COMMIT');
    return { status: 'migrated', backupPath };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return {
      status: 'migration-failed',
      error: e && e.message ? e.message : String(e),
      backupPath,
    };
  }
}

// 辅助：写 N5_SCENARIOS_UNIQUE_MIGRATED_MARKER（用于"已经是复合 UNIQUE"分支补写）
function writeUniqueMigratedMarker(db) {
  try {
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(N5_SCENARIOS_UNIQUE_MIGRATED_MARKER, new Date().toISOString());
  } catch (_) {
    // app_settings 表不存在 → 忽略（理论不发生）
  }
}

// v2.1.9 N5：DB schema 总迁移函数（🔴 资金红线 + 破坏性 schema 变更，不可逆）
//
// 步骤：
//   1. 标志位检测 app_settings.n5_channels_migrated='true' 跳过
//   2. 前置备份（事务外，SR-backup-1 sqlite VACUUM INTO）→ <dbDir>/backups/tool-data-bak-pre-N5-{ts}.sqlite
//   3. 事务包裹：ensureChannelsTable + ensureScenariosChannelIdColumn + 写标志位
//   4. 失败 ROLLBACK + 备份保留 + 返回错误状态（启动不阻塞，下次重试）
//
// 返回 { status, backupPath?, columnAdded?, error? }
//   status:
//     - 'skipped'           : 标志位 = true，已迁移
//     - 'migrated'          : 本次成功执行
//     - 'backup-failed'     : 备份失败，未执行 schema 改动
//     - 'migration-failed'  : 事务失败已回滚，备份保留
function ensureSchemaV2_1_9_N5(db, createBackupFn) {
  // 1. 标志位检测
  const markerRow = db
    .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
    .get(N5_MIGRATED_MARKER);
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'skipped' };
  }

  // 2. 前置备份（事务外）
  let backupPath = null;
  if (typeof createBackupFn === 'function') {
    try {
      backupPath = createBackupFn('pre-N5');
    } catch (e) {
      return { status: 'backup-failed', error: e && e.message ? e.message : String(e) };
    }
  }

  // 3. 事务：建表 + 加列 + backfill + 标志位
  try {
    db.exec('BEGIN');
    ensureChannelsTable(db);
    const columnAdded = ensureScenariosChannelIdColumn(db);
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(N5_MIGRATED_MARKER, new Date().toISOString());
    db.exec('COMMIT');
    return { status: 'migrated', backupPath, columnAdded };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return {
      status: 'migration-failed',
      error: e && e.message ? e.message : String(e),
      backupPath,
    };
  }
}

// v2.1.10 N4-cont-2：差异行 FK 加 ON DELETE CASCADE 改造（🔴 资金红线 + 不可逆 DB schema 变更）
//
// 改造范围（PRD §四 D28 用户拍板 = (a) 仅 diff_rows 2 FK）：
//   1. acquiring_bill_currency_diff_rows.run_id → acquiring_bill_currency_runs(id) **ON DELETE CASCADE**
//   2. acquiring_bill_currency_diff_rows.bill_import_id → acquiring_bill_currency_bill_imports(id) **ON DELETE CASCADE**
//   (不动 bill_imports / flow_imports / runs 等其他表 FK — 它们是数据真理源)
//
// 业务语义：
//   - diff_rows 是 run 的派生数据（差异表）；删 run / 删源 bill 时差异行必须跟随消失
//   - 范式与 v2.1.9 N5 不同：N5 用 ON UPDATE CASCADE + UI 双保护禁删；本次显式 ON DELETE CASCADE
//
// 8-status state machine（沿用 v2.1.9 N5 范式，spec §5.3）：
//   pending → backup-done → checked → rebuilt → indexed → fk-verified → flag-set → committed
//                             ↓          ↓          ↓           ↓
//                          ROLLBACK   ROLLBACK   ROLLBACK   ROLLBACK
//                          + 保留备份 + activity log warning
//
// 返回 { status, backupPath?, error?, statusReached? }
//   status 8 值（沿用 v2.1.9 N5 范式 + 防御性扩 2 个 skipped 分支）：
//     - 'skipped'                  : 标志位 = '1'，已迁
//     - 'skipped-no-table'         : diff_rows 表不存在（新装用户极早期路径）
//     - 'skipped-already-cascaded' : 解析现有 schema 发现 2 FK 都已含 ON DELETE CASCADE
//     - 'skipped-no-flag-table'    : app_settings 表不存在（理论不发生，启动入口已建）
//     - 'migrated'                 : 本次成功（state 推到 committed）
//     - 'backup-failed'            : SR-backup-1 备份失败，schema 未动
//     - 'conflict-detected'        : INSERT INTO new SELECT * FROM old 后行数对账失败 → ROLLBACK + 保留备份
//     - 'migration-failed'         : rebuild / indexed / fk-verified / flag-set 任一失败 → ROLLBACK + 保留备份
//
// 标志位 key：'n4_cont_2_diff_rows_cascade_migrated' (value='1')
//
// 关键不变量：
//   - SR-backup-1 在事务**外**（VACUUM INTO；失败不可能污染主库）
//   - rebuild + index + flag-set 在**一个**事务内（要么全成功要么全 ROLLBACK）
//   - fk-verified 后才写 flag（spec §5.3.2 各 status 详情）
//   - row 数对账失败 → conflict-detected → ROLLBACK（不依赖事务自动失败；防御性显式比对）
//   - 失败保留备份文件（用户可手动恢复）+ activity log warning（USER_GUIDE 引用恢复路径）
const N4_CONT_2_DIFF_ROWS_CASCADE_MIGRATED_MARKER = 'n4_cont_2_diff_rows_cascade_migrated';
const N4_CONT_2_DIFF_ROWS_TABLE = 'acquiring_bill_currency_diff_rows';
const N4_CONT_2_DIFF_ROWS_TABLE_NEW = 'acquiring_bill_currency_diff_rows_new';
const N4_CONT_2_DIFF_ROWS_INDEX = 'idx_acquiring_bill_currency_diff_run';

function ensureDiffRowsCascadeMigration_v2_1_10(db, dbPath, createBackupFn) {
  let statusReached = 'pending';

  // ---------------- Step 1：flag check（标志位幂等） ----------------
  let markerRow;
  try {
    markerRow = db
      .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
      .get(N4_CONT_2_DIFF_ROWS_CASCADE_MIGRATED_MARKER);
  } catch (_) {
    // app_settings 表不存在 → 理论不应发生（启动入口已建表）；防御性返回
    return { status: 'skipped-no-flag-table', statusReached };
  }
  if (markerRow && String(markerRow.setting_value) === '1') {
    return { status: 'skipped', statusReached };
  }

  // ---------------- Step 2：table existence check ----------------
  const tableRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(N4_CONT_2_DIFF_ROWS_TABLE);
  if (!tableRow || !tableRow.sql) {
    // diff_rows 表不存在 → 新装用户极早期路径（未跑 acquiring-bill-currency 模块）
    //   写标志位防止下次重复 check；下次新建表时直接含 CASCADE（未来 ensureAcquiringBillCurrencyTablesSupport 可扩，但本版未改）
    writeN4Cont2Marker(db);
    return { status: 'skipped-no-table', statusReached };
  }

  // ---------------- Step 3：已含 CASCADE 检测（防御性） ----------------
  //   PRAGMA foreign_key_list 返回 FK 列表 + on_delete 字段
  //   两个 FK（run_id / bill_import_id）都已是 CASCADE → no-op + 写标志位
  const fkList = db
    .prepare(`PRAGMA foreign_key_list('${N4_CONT_2_DIFF_ROWS_TABLE}')`)
    .all();
  const runIdFk = fkList.find((f) => f.from === 'run_id');
  const billImportIdFk = fkList.find((f) => f.from === 'bill_import_id');
  if (
    runIdFk && String(runIdFk.on_delete).toUpperCase() === 'CASCADE' &&
    billImportIdFk && String(billImportIdFk.on_delete).toUpperCase() === 'CASCADE'
  ) {
    writeN4Cont2Marker(db);
    return { status: 'skipped-already-cascaded', statusReached };
  }

  // ---------------- Step 4：SR-backup-1 前置备份（事务外） ----------------
  let backupPath = null;
  if (typeof createBackupFn === 'function') {
    try {
      backupPath = createBackupFn('pre-N4-cont-2');
    } catch (e) {
      const err = e && e.message ? e.message : String(e);
      // activity log warning（caller 也会 log，但 migration 函数本身不 log；按 N5 范式）
      return { status: 'backup-failed', statusReached, error: err };
    }
  }
  statusReached = 'backup-done';

  // ---------------- Step 5：rebuild 事务（rebuilt → indexed → fk-verified → flag-set → committed） ----------------
  try {
    db.exec('BEGIN');

    // 5a. 行数快照（用于 5c 对账）
    const oldRowCount = db
      .prepare(`SELECT COUNT(*) AS cnt FROM ${N4_CONT_2_DIFF_ROWS_TABLE}`)
      .get().cnt;

    // 5b. 建新表（schema 严格对齐原表 + 2 FK 加 ON DELETE CASCADE）
    //   原 schema 见 migrations.js ensureAcquiringBillCurrencyTablesSupport（行 1542）：
    //     id PK AUTOINC / run_id NOT NULL / bill_import_id NOT NULL /
    //     flow_currency TEXT / flow_amount_abs TEXT / diff_type TEXT NOT NULL
    db.exec(`
      CREATE TABLE ${N4_CONT_2_DIFF_ROWS_TABLE_NEW} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        bill_import_id INTEGER NOT NULL,
        flow_currency TEXT,
        flow_amount_abs TEXT,
        diff_type TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id) ON DELETE CASCADE
      );
    `);

    // 5c. 全量迁数据（显式列名顺序；不依赖 SELECT *）
    db.exec(`
      INSERT INTO ${N4_CONT_2_DIFF_ROWS_TABLE_NEW}
        (id, run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type)
      SELECT id, run_id, bill_import_id, flow_currency, flow_amount_abs, diff_type
      FROM ${N4_CONT_2_DIFF_ROWS_TABLE};
    `);

    // 5d. 行数对账（防御性 — 任一行漏迁立即 ROLLBACK）
    const newRowCount = db
      .prepare(`SELECT COUNT(*) AS cnt FROM ${N4_CONT_2_DIFF_ROWS_TABLE_NEW}`)
      .get().cnt;
    if (newRowCount !== oldRowCount) {
      db.exec('ROLLBACK');
      return {
        status: 'conflict-detected',
        statusReached,
        backupPath,
        error: `diff_rows 迁移行数不匹配：old=${oldRowCount}, new=${newRowCount}`,
      };
    }

    // 5e. DROP 老表 + RENAME 新表
    db.exec(`DROP TABLE ${N4_CONT_2_DIFF_ROWS_TABLE};`);
    db.exec(`ALTER TABLE ${N4_CONT_2_DIFF_ROWS_TABLE_NEW} RENAME TO ${N4_CONT_2_DIFF_ROWS_TABLE};`);
    statusReached = 'rebuilt';

    // 5f. 重建索引（spec §5.3.3）
    db.exec(`
      CREATE INDEX IF NOT EXISTS ${N4_CONT_2_DIFF_ROWS_INDEX}
        ON ${N4_CONT_2_DIFF_ROWS_TABLE}(run_id);
    `);
    statusReached = 'indexed';

    // 5g. PRAGMA foreign_key_check（事务内 0 violation 验证）
    //   注意：foreign_keys=ON 时 INSERT 阶段会逐行检查；这里再跑一次全表 sanity
    const violations = db
      .prepare(`PRAGMA foreign_key_check('${N4_CONT_2_DIFF_ROWS_TABLE}')`)
      .all();
    if (violations && violations.length > 0) {
      db.exec('ROLLBACK');
      return {
        status: 'migration-failed',
        statusReached,
        backupPath,
        error: `PRAGMA foreign_key_check 发现 ${violations.length} 条 violation`,
      };
    }
    statusReached = 'fk-verified';

    // 5h. 写标志位（事务内 — 与 schema 改造一起 COMMIT 或一起 ROLLBACK）
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, '1', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(N4_CONT_2_DIFF_ROWS_CASCADE_MIGRATED_MARKER, new Date().toISOString());
    statusReached = 'flag-set';

    db.exec('COMMIT');
    statusReached = 'committed';
    return { status: 'migrated', statusReached, backupPath, rowsAffected: oldRowCount };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return {
      status: 'migration-failed',
      statusReached,
      backupPath,
      error: e && e.message ? e.message : String(e),
    };
  }
}

// 辅助：写 N4_CONT_2 标志位（用于 skipped-no-table / skipped-already-cascaded 分支补写）
function writeN4Cont2Marker(db) {
  try {
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, '1', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(N4_CONT_2_DIFF_ROWS_CASCADE_MIGRATED_MARKER, new Date().toISOString());
  } catch (_) {
    // app_settings 表不存在 → 忽略（理论不发生）
  }
}

// v2.1.8 N2：给历史 'gateway-recon-join' 场景的 assign 对象补 mode / customValue 字段
// 背景：v2.1.7 之前 assign = { gwField, bankField }；v2.1.8 N2 扩展为
//       { gwField, bankField, mode: 'direct' | 'custom', customValue }
// 用户老 scenario 升级 v2.1.8 后，dialog 编辑 / 引擎读取需要 mode 字段才能进入 v2.1.8 新分支
// 幂等：若 assign.mode 已存在 → no-op；多次启动只首次命中
// 不变量：仅追加 mode='direct' + customValue=''，不修改任何已有字段（gwField/bankField 保持）
function ensureC3AssignAddMode(db) {
  const rows = db.prepare(
    `SELECT id, config_json FROM scenarios WHERE category = 'gateway-recon-join'`
  ).all();
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  rows.forEach((row) => {
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch (_e) {
      return;
    }
    if (!config || !config.assign) return;
    if (config.assign.mode) return; // 幂等：已有 mode 字段则跳过
    config.assign.mode = 'direct';
    if (!('customValue' in config.assign)) config.assign.customValue = '';
    update.run(JSON.stringify(config), now, row.id);
  });
}

// v2.1.2 T2 — 月度银行对账单BU回填校验模块的 3 张表
// PRD §三 / spec §3.4：
//   - bank_bu_recon_pending_imports：按月份存 Pending 数据管理.xlsx (20 列) 的导入数据
//   - bank_bu_recon_bank_imports：按月份存 银行对账单.xlsx (44 列) 的导入数据
//   - bank_bu_recon_runs：对账运行历史 + 统计 + 异常报告路径
// 幂等：CREATE TABLE / INDEX IF NOT EXISTS，多次启动 no-op
// 与 Pending 模块（pending-db 独立 DB）完全隔离：本模块 3 张表都在主 DB（tool-data.sqlite）
function ensureBankBuReconTablesSupport(db) {
  db.exec('BEGIN');

  try {
    // 表 1：Pending 数据管理导入（spec §3.4.1，20 列源数据）
    db.exec(`
      CREATE TABLE IF NOT EXISTS bank_bu_recon_pending_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year_month TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        pending_biz_id TEXT,
        bill_date TEXT,
        pending_type TEXT,
        fund_type TEXT,
        entity TEXT,
        finance_bu TEXT,
        biz_dept TEXT,
        counter_dept TEXT,
        recon_id TEXT,
        channel TEXT,
        account_no TEXT,
        amount TEXT,
        currency TEXT,
        bank_period TEXT,
        balance_period TEXT,
        remark TEXT,
        status TEXT,
        update_time TEXT,
        operator TEXT,
        bu_fix_flag TEXT,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bbr_pending_month
        ON bank_bu_recon_pending_imports(year_month);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bbr_pending_reconid
        ON bank_bu_recon_pending_imports(year_month, recon_id);
    `);

    // 表 2：银行对账单导入（spec §3.4.2，44 列源数据）
    db.exec(`
      CREATE TABLE IF NOT EXISTS bank_bu_recon_bank_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year_month TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        account_entity TEXT,
        account_bu TEXT,
        biz_id TEXT,
        bill_date TEXT,
        value_date TEXT,
        channel TEXT,
        region TEXT,
        merchant_id TEXT,
        currency TEXT,
        credit_amount TEXT,
        debit_amount TEXT,
        reconciliation_id TEXT,
        channel_order_no TEXT,
        customer_ref TEXT,
        account_reference TEXT,
        transaction_description TEXT,
        extra_information TEXT,
        payment_detail TEXT,
        payee_name TEXT,
        payee_card_no TEXT,
        drawee_name TEXT,
        drawee_card_no TEXT,
        by_order_of_beneficiary TEXT,
        extra_fee TEXT,
        trade_channel TEXT,
        fund_type TEXT,
        remark_description TEXT,
        datasource TEXT,
        remark_bu TEXT,
        fill_method TEXT,
        related_account TEXT,
        auto_category_rule TEXT,
        categorized_by TEXT,
        clearing_network TEXT,
        last_modified_time TEXT,
        recon_amount TEXT,
        origin_bill_id TEXT,
        fx_channel TEXT,
        fx_recon_id TEXT,
        buy_currency TEXT,
        buy_amount TEXT,
        sell_currency TEXT,
        sell_amount TEXT,
        split_info TEXT,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bbr_bank_month
        ON bank_bu_recon_bank_imports(year_month);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bbr_bank_reconid
        ON bank_bu_recon_bank_imports(year_month, reconciliation_id);
    `);

    // 表 3：对账运行历史（spec §3.4.3）
    // status: v0.4 设计 'success'/'failed_anomaly'；v0.8 后实际只用 'success'（schema 字段保留兼容）
    db.exec(`
      CREATE TABLE IF NOT EXISTS bank_bu_recon_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year_month TEXT NOT NULL,
        run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status TEXT NOT NULL,
        pending_total INTEGER NOT NULL,
        bank_total INTEGER NOT NULL,
        matched_count INTEGER NOT NULL,
        bu_diff_count INTEGER NOT NULL,
        pending_unmatched INTEGER NOT NULL,
        bank_unmatched INTEGER NOT NULL,
        anomaly_count INTEGER NOT NULL DEFAULT 0,
        anomaly_report_path TEXT,
        export_path TEXT
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bbr_runs_month
        ON bank_bu_recon_runs(year_month, run_at DESC);
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v2.1.6 T4 — 收单单据币种校验模块（acquiring-bill-currency）4 张表
// 复用 v2.1.2 bankBuRecon 范式，主 DB（tool-data.sqlite）
//   - acquiring_bill_currency_flow_imports：流水表导入（关键字段 recon_main_id / settle_amount / settle_currency）
//   - acquiring_bill_currency_bill_imports：单据表导入（关键字段 recon_main_id / settle_currency）
//   - acquiring_bill_currency_runs：对账运行历史 + 统计
//   - acquiring_bill_currency_diff_rows：差异行（仅币种不一致 + 单据币种缺失）
// UNIQUE(month_key, recon_main_id) 强制保障 1:1 关联假设（spec §3.1 / §4.1 / §4.2）
// v0.7 fix4：流水侧取列从「币种/对账金额」改为「通道清算币种/通道清算金额」，DB 列名 recon_amount/currency → settle_amount/settle_currency
// 幂等：CREATE TABLE / INDEX IF NOT EXISTS，多次启动 no-op
function ensureAcquiringBillCurrencyTablesSupport(db) {
  db.exec('BEGIN');

  try {
    // 表 1：流水表导入（spec §3.1 + §4.1，v0.7 字段名）
    db.exec(`
      CREATE TABLE IF NOT EXISTS acquiring_bill_currency_flow_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month_key TEXT NOT NULL,
        source_file TEXT NOT NULL,
        source_row_index INTEGER NOT NULL,
        recon_main_id TEXT NOT NULL,
        settle_amount TEXT NOT NULL,
        settle_amount_abs TEXT NOT NULL,
        settle_currency TEXT,
        settle_currency_norm TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (month_key, recon_main_id)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_flow_month
        ON acquiring_bill_currency_flow_imports(month_key);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_flow_join
        ON acquiring_bill_currency_flow_imports(month_key, recon_main_id);
    `);

    // 表 2：单据表导入（spec §3.2 + §4.2，v0.7 字段名）
    db.exec(`
      CREATE TABLE IF NOT EXISTS acquiring_bill_currency_bill_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month_key TEXT NOT NULL,
        source_file TEXT NOT NULL,
        source_row_index INTEGER NOT NULL,
        recon_main_id TEXT NOT NULL,
        settle_currency TEXT,
        settle_currency_norm TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (month_key, recon_main_id)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_month
        ON acquiring_bill_currency_bill_imports(month_key);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_join
        ON acquiring_bill_currency_bill_imports(month_key, recon_main_id);
    `);
    // v2.1.7 F7-A2：writer 阶段高频查询用 source_file 索引（spec §7.4.1）
    //   覆盖 run-repository.js: listDiffRowsBySourceFile (WHERE source_file=?)
    //                          listAllDiffRowsByRun (ORDER BY source_file ASC)
    //                          listSourceFilesByRun (SELECT DISTINCT source_file ORDER BY source_file ASC)
    //   CREATE INDEX IF NOT EXISTS 幂等
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_source_file
        ON acquiring_bill_currency_bill_imports(source_file);
    `);

    // 表 3：对账运行历史（spec §4.3）
    // v0.8 fix5：新增 diff_file_path + report_file_path 存 run 时生成的输出文件路径
    db.exec(`
      CREATE TABLE IF NOT EXISTS acquiring_bill_currency_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month_key TEXT NOT NULL,
        ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        total_bill_rows INTEGER NOT NULL,
        matched_rows INTEGER NOT NULL,
        mismatch_rows INTEGER NOT NULL,
        unmatched_rows INTEGER NOT NULL,
        status TEXT NOT NULL,
        diff_file_path TEXT,
        report_file_path TEXT
      );
    `);

    // 表 4：差异行（spec §4.4） — 仅含币种不一致 + 单据币种缺失的行
    // flow_currency / flow_amount_abs 列名 v0.7 保留（避免 schema 二次变更），内容指向流水侧 settle_currency / settle_amount_abs
    db.exec(`
      CREATE TABLE IF NOT EXISTS acquiring_bill_currency_diff_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        bill_import_id INTEGER NOT NULL,
        flow_currency TEXT,
        flow_amount_abs TEXT,
        diff_type TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES acquiring_bill_currency_runs(id),
        FOREIGN KEY (bill_import_id) REFERENCES acquiring_bill_currency_bill_imports(id)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_diff_run
        ON acquiring_bill_currency_diff_rows(run_id);
    `);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // v0.7 fix4：对已存在的老 schema 库做幂等列重命名（v0.6 → v0.7）
  ensureAcquiringBillCurrencyFix4ColumnsRename(db);
  // v0.8 fix5：runs 表加 diff_file_path + report_file_path 两列（幂等）
  ensureAcquiringBillCurrencyFix5RunPathColumns(db);
}

// v0.8 fix5：runs 表加 diff_file_path + report_file_path（幂等）
function ensureAcquiringBillCurrencyFix5RunPathColumns(db) {
  const cols = db.prepare("PRAGMA table_info(acquiring_bill_currency_runs)").all();
  const hasDiff = cols.some((c) => c.name === 'diff_file_path');
  const hasReport = cols.some((c) => c.name === 'report_file_path');
  if (hasDiff && hasReport) return;

  db.exec('BEGIN');
  try {
    if (!hasDiff) db.exec(`ALTER TABLE acquiring_bill_currency_runs ADD COLUMN diff_file_path TEXT`);
    if (!hasReport) db.exec(`ALTER TABLE acquiring_bill_currency_runs ADD COLUMN report_file_path TEXT`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* idempotent */ }
    throw error;
  }
}

// v0.7 fix4：将 v0.6 入库的列名（recon_amount/recon_amount_abs/currency/currency_norm）
// 重命名为 v0.7 的 settle_* 命名。
// 幂等：先 PRAGMA table_info 检查列是否已重命名，跳过已迁移的库。
// ⚠️ 仅 ALTER 列名，**不动数据值** —— v0.6 已入库的 currency_norm 内容是订单视角，
//    用户必须配合「清月 2026-03 + 重导」才能让对账逻辑用上新字段「通道清算币种」。
function ensureAcquiringBillCurrencyFix4ColumnsRename(db) {
  const flowCols = db.prepare("PRAGMA table_info(acquiring_bill_currency_flow_imports)").all();
  const billCols = db.prepare("PRAGMA table_info(acquiring_bill_currency_bill_imports)").all();
  const flowHasOld = flowCols.some((c) => c.name === 'recon_amount');
  const flowHasNew = flowCols.some((c) => c.name === 'settle_amount');
  const billHasOld = billCols.some((c) => c.name === 'currency') && !billCols.some((c) => c.name === 'settle_currency');

  if (!flowHasOld && flowHasNew && !billHasOld) return; // 已是新 schema

  db.exec('BEGIN');
  try {
    if (flowHasOld) {
      db.exec(`ALTER TABLE acquiring_bill_currency_flow_imports RENAME COLUMN recon_amount TO settle_amount`);
      db.exec(`ALTER TABLE acquiring_bill_currency_flow_imports RENAME COLUMN recon_amount_abs TO settle_amount_abs`);
      db.exec(`ALTER TABLE acquiring_bill_currency_flow_imports RENAME COLUMN currency TO settle_currency`);
      db.exec(`ALTER TABLE acquiring_bill_currency_flow_imports RENAME COLUMN currency_norm TO settle_currency_norm`);
    }
    if (billHasOld) {
      db.exec(`ALTER TABLE acquiring_bill_currency_bill_imports RENAME COLUMN currency TO settle_currency`);
      db.exec(`ALTER TABLE acquiring_bill_currency_bill_imports RENAME COLUMN currency_norm TO settle_currency_norm`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ensureAccountMappingCurrencySupport,
  ensureAccountMappingTemplateSupport,
  ensureAcquiringBillCurrencyTablesSupport,
  ensureAmountSplitRulesSupport,
  ensureBankBuReconTablesSupport,
  ensureBillSplitMergeSupport,
  ensureBillSplitTargetSeqSupport,
  ensureParentTemplateSupport,
  ensureScenariosSupport,
  ensureScenariosCategoryReconIdFix,
  ensureScenariosCategoryGatewayReconIdFix,
  migrateGatewayReconIdFixFieldPairs,
  migrateC4ReconGroupsStructure,
  migrateC4ReconGroupsAmountLockedFieldPair,
  ensureC3GwFieldCurrencyCaseFix,
  ensureC3AssignAddMode,
  ensureAcquiringBillCurrencyRunsCleanupPending,
  ensureAcquiringBillIdleCleanupMinutesSetting,
  // v2.1.10 A4 T18 / T19：chunked 分批 size settings + runs.chunk_progress 列 migration
  ensureAcquiringBillChunkSizeSetting,
  ensureAcquiringBillCurrencyRunsChunkProgress,
  // v2.1.10 N4-cont-1 T22 (Phase 4)：raw_json idle 自动清理保留窗口 settings（v0.2 单键）
  ensureAcquiringBillCurrencyRawJsonRetentionSettings,
  ensureBillRawJsonV2Slim,
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureSchemaV2_1_9_N5,
  // v2.1.9 SR-FIX-1 (spec §16.3)：scenarios.name UNIQUE 全表 → (channel_id, name) 复合
  ensureScenariosNameUniqueByChannelId,
  // v2.1.10 N4-cont-2：diff_rows 2 FK 加 ON DELETE CASCADE（🔴 资金红线 + 不可逆 DB schema）
  ensureDiffRowsCascadeMigration_v2_1_10,
  ensureBuiltinScenarioNamesUpdate,
  ensureTemplateBigAccountNatureSupport,
  ensureTemplateDateFormatSupport,
  ensureTemplateFilenameFixedFieldSupport,
  ensureTemplateMappingEnhancements,
  ensureTemplateKeySupport,
  hasColumn,
  // v2.1.9 N1-settings：导出常量供 settings-repository / main.js 共享
  ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY,
  ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT,
  // v2.1.10 A4 T18：chunked 分批 size 常量（spec §3.2）
  ACQUIRING_BILL_CHUNK_SIZE_KEY,
  ACQUIRING_BILL_CHUNK_SIZE_DEFAULT,
  // v2.1.10 N4-cont-1 T22 (Phase 4)：raw_json 保留窗口常量（v0.2 单键 默认 7 天）
  ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY,
  ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT,
};
