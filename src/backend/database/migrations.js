const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeText } = require('./utils');
// v2.1.9 SR-log-1 (T32h)：替换 console.error → appendModuleLog 双写
const { appendModuleLog } = require('../logger');
// v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景默认商户号（与引擎从 scenario.config.merchantId 读同源）。
const { ADM_MERCHANT_ID } = require('../../constants/adm-bank-deposit-fields');
// v3.0.5 需求2：fx 主表幂等键回填用「交易编号归一」单一真相（与仓储 upsert / builder 派生同口径，防漂移）。
//   ⚠️ engine-utils 是无依赖纯 JS 工具（零 require），不引入循环依赖。
const { normalizeTransactionNo } = require('../../main-process/scenario-engines/engine-utils');
const {
  isCanonicalFundTransferOwner
} = require('../../main-process/fund-transfer-date-policy');

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
    // v2.1.13 D-4：内置提取场景「从银行对账单的信息里提取调拨订单对账ID」最终归入「自带写死场景」(builtin-fixed)。
    //   seed 阶段仍以 extract-recon-id / priority 3 落库（此时表 CHECK 仅 3 值），
    //   再由 ensureBuiltinFixedScenarioMigration（在 builtin-fixed CHECK 扩展后）统一迁移成 builtin-fixed / priority 0。
    //   新库与老库走同一迁移路径，避免 seed 时序违反 CHECK；config（extractByFeature）保持不变。
    //   v2.1.13（增量）：场景名「…提取对账ID」→「…提取调拨订单对账ID」（老库由 ensureBuiltinFixedScenarioNameUpdate 迁移）
    category: 'extract-recon-id',
    name: '从银行对账单的信息里提取调拨订单对账ID',
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

// v3.0.12 批E 修复C：反转 v2.0.0-beta.3 的 ensureC3GwFieldCurrencyCaseFix（"小写 currency → 大写 Currency"）
// ⚠️ 资金红线：改 scenarios.config_json。
//
// 背景（旧迁移当时为何正确）：v2.0.0-beta.3 时 C3「网关对账单赋值银行对账单」(category='gateway-recon-join')
//   的网关字段下拉枚举源是硬编码常量 GATEWAY_RECON_FIELDS（大写 'Currency'），故当时把存量小写 'currency'
//   改成大写 'Currency' 对齐枚举是正确的。
// 数据源变化（旧迁移变有害）：
//   - v2.1.15 W1 把 C3 下拉枚举源改为读 assets/网关对账单.xlsx 表头（实际是小写 'currency'）；
//   - v2.1.16-beta.2 T1 又把 C3 对账引擎的网关行数据源切到链接表 linked_gateway_bill（小写表头）。
//   至此 UI 下拉源、引擎取数源都已统一为小写 'currency'，唯独旧迁移仍每次开机无条件把它改成大写 → 重启后
//   大写值在小写下拉里 === 匹配不到 → 落回占位空值；且引擎按小写 key 取不到值 → currency 维度静默不比对。
// 修复：反转语义——扫所有 'gateway-recon-join' 场景，把被旧迁移改坏的存量 reconFields[].gwField === 'Currency'
//   （大写）改回 'currency'（小写）。仅处理 reconFields[].gwField（旧迁移只破坏了它；assign.gwField 等其余字段
//   本就是小写、未被旧迁移触碰，不动）。引擎、UI 下拉源、normalize 一律不动（已正确对齐小写）。
// 一次性 marker（c3_gw_field_currency_revert_done）：跑过即不再跑——避免重蹈"每次开机无条件改写"覆盖
//   用户后续合法改动的覆辙。marker 已存在 → 整个迁移 no-op。
const C3_GW_FIELD_CURRENCY_REVERT_KEY = 'c3_gw_field_currency_revert_done';
function ensureC3GwFieldCurrencyCaseRevert(db) {
  // 1. marker 幂等检查（只跑一次）
  let markerRow;
  try {
    markerRow = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(C3_GW_FIELD_CURRENCY_REVERT_KEY);
  } catch (_e) {
    // app_settings 表不存在（极早期启动） → 跳过本次（等下一次启动）
    return { status: 'skipped-no-settings-table' };
  }
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'already-migrated' };
  }

  // 2. 扫 gateway-recon-join 场景（scenarios 表不存在 → 跳过、不写 marker，下次启动重试）
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, config_json FROM scenarios WHERE category = 'gateway-recon-join'`
    ).all();
  } catch (_e) {
    return { status: 'skipped-no-scenarios-table' };
  }

  // 3. 反转：仅把 reconFields[].gwField === 'Currency'（大写存量）改回 'currency'（小写）
  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  let updated = 0;
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
      if (rf && rf.gwField === 'Currency') {
        rf.gwField = 'currency';
        changed = true;
      }
    });
    if (changed) {
      update.run(JSON.stringify(config), now, row.id);
      updated += 1;
    }
  });

  // 4. 写 marker（即使本次 0 改动也写 — 反转迁移此后永不再跑，尊重用户后续合法改动）
  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, 'true', ?)
    ON CONFLICT(setting_key) DO UPDATE
    SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
  `).run(C3_GW_FIELD_CURRENCY_REVERT_KEY, now);

  return { status: 'reverted', scanned: rows.length, updated };
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

// v2.1.12 β.1-T3：seed 收单单据多 worker write-splitting 的 worker 数默认值（2）
//   spec §4 D33（OOM 防御默认 2，高级可调 4）+ D29（默认上限 4）；范围 [1, 8]（settings-repository.js）
//   getter 范围外回退默认；main.js handler 还会再做 CPU/内存 clamp
//   幂等：INSERT OR IGNORE — 用户已改值（sqlite3 直改）不被覆盖
const ACQUIRING_BILL_WORKER_COUNT_KEY = 'acquiring_bill_worker_count';
const ACQUIRING_BILL_WORKER_COUNT_DEFAULT = '2';
function ensureAcquiringBillWorkerCountSetting(db) {
  // 同 ensureAcquiringBillChunkSizeSetting：依赖 app_settings 表存在
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
    ACQUIRING_BILL_WORKER_COUNT_KEY,
    ACQUIRING_BILL_WORKER_COUNT_DEFAULT,
    now
  );
  return { status: 'seeded', key: ACQUIRING_BILL_WORKER_COUNT_KEY };
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

// v3.0.5 PR-3（Part B Phase 1）：给 acquiring_bill_currency_runs 加 side_db_rel_path 列（per-月侧库元数据）
//   值：侧库文件相对路径（run-data/acquiring-bill-currency/month-{monthKey}.sqlite），NULL = 历史主库 run（双源过渡）。
//   读路径双源判定（B-D2）：runs.side_db_rel_path 非空 → 读侧库；NULL → 读主库旧表（旧 run 行为零变化）。
//   轻量加列（不搬历史数据、不需 8-status 重迁移范式）；幂等 hasColumn 检查避免重复 ADD COLUMN。
//   必须在 ensureAcquiringBillCurrencyTablesSupport 之后（依赖 runs 表已存在）。
function ensureAcquiringBillCurrencyRunsSideDbPath(db) {
  if (hasColumn(db, 'acquiring_bill_currency_runs', 'side_db_rel_path')) return;
  db.exec(`ALTER TABLE acquiring_bill_currency_runs ADD COLUMN side_db_rel_path TEXT`);
}

// v3.0.5 PR-4（Part B Phase 2）：给 bank_bu_recon_runs 加 side_db_rel_path 列（per-月侧库元数据镜像）。
//   值：侧库文件相对路径（run-data/bank-bu-recon/month-{yearMonth}.sqlite），NULL = 历史主库 run（双源过渡）。
//   读路径双源判定（B-D2）：runs.side_db_rel_path 非空 → 读侧库；NULL → 读主库旧表。
//   轻量加列幂等；必须在 ensureBankBuReconTablesSupport 之后（依赖 runs 表已存在）。
function ensureBankBuReconRunsSideDbPath(db) {
  if (hasColumn(db, 'bank_bu_recon_runs', 'side_db_rel_path')) return;
  db.exec(`ALTER TABLE bank_bu_recon_runs ADD COLUMN side_db_rel_path TEXT`);
}

// v3.0.5 PR-4（Part B Phase 2）：给 biz_op_recon_runs 加 side_db_rel_path 列（per-月侧库元数据镜像）。
//   值：侧库文件相对路径（run-data/biz-op-recon/month-{month(date)}.sqlite），NULL = 历史主库 run（双源过渡）。
//   biz-op run 粒度 = (data_date, bu_name)，但侧库按对账归属月 month(date) 分片，故 rel_path 指向月侧库。
//   轻量加列幂等；必须在 ensureBizOpReconTablesSupport 之后（依赖 runs 表已存在）。
function ensureBizOpReconRunsSideDbPath(db) {
  if (hasColumn(db, 'biz_op_recon_runs', 'side_db_rel_path')) return;
  db.exec(`ALTER TABLE biz_op_recon_runs ADD COLUMN side_db_rel_path TEXT`);
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

// v2.1.13 D-3：扩展 scenarios.category CHECK 约束，新增 'builtin-fixed'（自带写死场景）枚举值 → 6 值
// 背景：v2.1.0-beta.3 已扩到 5 值；本迭代新增「自带写死场景」类别（PRD §二 D-2）。
// SQLite 不支持 ALTER TABLE 改 CHECK → 必须重建表。
// 资金红线：必须包在事务里；老库无损迁移；id / 列结构 / channel_id FK / 复合 UNIQUE / 默认值都须保留。
// 幂等：解析 sqlite_master.sql 含 'builtin-fixed' → no-op；多次启动仅触发一次重建。
// 调用顺序：必须在 ensureScenariosNameUniqueByChannelId（SR-FIX-1）之后 —— 依赖最终态 channel_id 列 +
//   复合 UNIQUE(channel_id, name) 已就位。防御：channel_id 列缺失（N5 未完成）→ 跳过本次，
//   等下次启动 N5 / SR-FIX-1 成功后再重建（避免 INSERT SELECT 引用不存在的列）。
function ensureScenariosCategoryBuiltinFixed(db) {
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return;
  if (tableSqlRow.sql.includes("'builtin-fixed'")) return; // 已扩，no-op
  // 防御：N5 未完成（无 channel_id 列）→ 跳过，下次启动重试
  if (!hasColumn(db, 'scenarios', 'channel_id')) return;

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
          'gateway-recon-id-fix',
          'builtin-fixed'
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
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v2.1.13（增量）：内置提取场景重命名「从银行对账单的信息里提取对账ID」→「从银行对账单的信息里提取调拨订单对账ID」。
//   - 不限 category（覆盖 extract-recon-id 未迁移 / builtin-fixed 已迁移 两种状态）；仅 is_builtin=1。
//   - 幂等：再跑无旧名匹配 → no-op。
//   - UNIQUE(channel_id, name) 冲突（同渠道已存在新名）→ try-catch 跳过保留旧名。
//   调用顺序：在 ensureScenariosCategoryBuiltinFixed 之后、ensureBuiltinFixedScenarioMigration 之前
//     （使 category 迁移可用新名定位）。
function ensureBuiltinFixedScenarioNameUpdate(db) {
  const OLD_NAME = '从银行对账单的信息里提取对账ID';
  const NEW_NAME = '从银行对账单的信息里提取调拨订单对账ID';
  try {
    db.prepare('UPDATE scenarios SET name = ?, updated_at = ? WHERE name = ? AND is_builtin = 1')
      .run(NEW_NAME, new Date().toISOString(), OLD_NAME);
  } catch (_) {
    // UNIQUE 冲突（同渠道已存在新名）→ 跳过保留旧名
  }
}

// v2.1.13 D-4：把内置提取场景「从银行对账单的信息里提取调拨订单对账ID」归入「自带写死场景」(builtin-fixed)。
//   - category: extract-recon-id → builtin-fixed；priority → 0；channel_id → 1（通用）
//   - config（extractByFeature）保持不变 → 执行引擎对 builtin-fixed 路由复用 C1 提取逻辑（PRD D-5）
//   - 幂等：再次运行 WHERE 无匹配 → no-op
//   - 若用户已删除该内置场景（D14 删除终态）→ 无匹配 → 不复活
//   调用顺序：必须在 ensureBuiltinFixedScenarioNameUpdate（用新名定位）+ ensureScenariosCategoryBuiltinFixed（CHECK 已含 'builtin-fixed'）之后
function ensureBuiltinFixedScenarioMigration(db) {
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return;
  if (!tableSqlRow.sql.includes("'builtin-fixed'")) return; // CHECK 未扩（前置未完成）→ 跳过
  // v2.1.13 PR#58 review P2-B：改用 is_builtin + category + config.extractByFeature 定位，不依赖 name。
  //   原固定名定位有两个漏洞：① 用户改过内置场景名 → 匹配不到、停在 extract-recon-id；
  //   ② 用户新建同名场景 → 前置 ensureBuiltinFixedScenarioNameUpdate 撞 (channel_id,name) UNIQUE 留旧名 → 仍匹配不到。
  //   内置提取场景特征唯一：is_builtin=1 + extract-recon-id + config 含 extractByFeature（D-1 后用户不可再新建 extract-recon-id）。
  db.prepare(`
    UPDATE scenarios
       SET category = 'builtin-fixed', priority = 0, channel_id = 1, updated_at = ?
     WHERE category = 'extract-recon-id'
       AND is_builtin = 1
       AND config_json LIKE '%extractByFeature%'
  `).run(new Date().toISOString());
}

// v2.1.13 D-3：场景-渠道 多对多关联表（「自带写死场景」适用银行渠道）
//   语义：某 scenario_id 在本表无任何行 = 适用「全部渠道」（默认全选）；有行则限定为所列渠道。
//   ON DELETE CASCADE：场景/渠道删除时自动清理关联行（兜底一致性）。
//   幂等：CREATE TABLE IF NOT EXISTS。
//   调用顺序：必须在 ensureChannelsTable（N5）+ scenarios 表重建（ensureScenariosCategoryBuiltinFixed）之后，
//     使 FK 指向最终态 scenarios 表（避免重建 scenarios 时悬空）。
function ensureScenarioApplicableChannelsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenario_applicable_channels (
      scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      channel_id  INTEGER NOT NULL REFERENCES channels(id)  ON DELETE CASCADE,
      PRIMARY KEY (scenario_id, channel_id)
    );
  `);
}

// v2.1.16-beta.2 §8：5 轮对账 R4/R5 内置场景 seed（🔴 资金红线 —— config 字段须与引擎/编排器逐字对齐）
//   插入 7 个内置「自带写死场景」(builtin-fixed)：5 个 R4 资金性质校验 + 2 个 R5 中台订单数据处理。
//
// ⚠️ config 字段契约（资金红线，改值即改资金口径；偏离会让场景静默落入 R2 或 handler 不命中）：
//   公共：funcCategory / subCategory / roundPhase / priority(∈0..3) / function(中文功能描述) / involvedFiles(数组)
//   编排器 reconciliation-orchestrator.js bucketScenarios 分桶字面值（必须逐字一致）：
//     - R4         : category==='builtin-fixed' && config.funcCategory==='fund-nature-check'
//     - R5 场景2   : config.funcCategory==='platform-order' && config.subCategory==='fund-transfer-backfill'
//     - R5 场景3   : config.funcCategory==='platform-order' && config.subCategory==='platform-inbound-cleanup'
//   R4 引擎按 subCategory 读取固定规则；历史 gwTradeType/setFundType/requireBankZeroField 字段仅保留兼容展示。
//   R5 场景2（r5-fund-transfer-backfill.js 读）：directions[] / dateToleranceDays
//   R5 场景3（r5-platform-inbound-cleanup.js 读）：gwTradeType / excludeFundType
//
// 🔴 v3.0.23 起 R4 四类 TradeType / 目标 FundType 由 subCategory 在引擎中固定；seed 中同名历史字段只用于
//    配置展示和旧版本兼容。R5 的 Inbound-VA / FundTransfer-out / FundTransfer-in 仍按各自 config 契约读取。
//
// 幂等（仿 ensureBuiltinFixedScenarioMigration / ensureScenariosSupport seed 范式）：
//   - 定位键：is_builtin=1 AND category='builtin-fixed' AND config_json LIKE '%"subCategory":"<X>"%'。
//     已存在则【跳过不覆盖】（保护用户对内置场景的改动 —— priority / config / 启停 / 改名）。
//   - 删除是终态：用户删某条 → 定位不到 → 但本函数不写 seed marker，仅凭「在场即跳过」；
//     删除后再次启动仍定位不到该 subCategory → 会被重新插回？否：见下「删除不复活」设计。
//     —— 采用「逐条 subCategory 定位」+ app_settings marker 双保险：marker 一旦写过 → 整体不再 seed，
//        与 BUILTIN_SCENARIOS 的 scenarios_seeded 同语义（D14 删除终态保护），避免用户删除后复活。
//   - 事务包裹（BEGIN/COMMIT/ROLLBACK）。
//   - 前置：scenarios.category CHECK 必须已含 'builtin-fixed'（读 sqlite_master.scenarios.sql 判定）；
//     未含 → return 跳过，下次启动（CHECK 扩展完成后）重试（仿 ensureScenariosCategoryBuiltinFixed 防御）。
//   - UNIQUE(channel_id, name) 冲突（用户已有同名场景）→ try/catch 单条跳过，不中断其余。
//   调用顺序：必须在 ensureScenariosCategoryBuiltinFixed 之后（依赖 CHECK 已扩到含 'builtin-fixed'）。
const RECON_ROUND_BUILTIN_SCENARIOS_SEEDED_MARKER = 'recon_round_builtin_scenarios_seeded';
const FUND_TRANSFER_BACKFILL_LEGACY_FUNCTION =
  '网关 FundTransfer-out/in 与 R4 后银行同向行按商户/币种/发生额绝对值/日期(同日优先,±1日兜底)1v1 匹配，命中后把网关 reconciliationid 回填进银行 ReconciliationId。';
const FUND_TRANSFER_BACKFILL_CURRENT_FUNCTION =
  '按配置选择网关对账单或调拨对账单作为来源，将 FundTransfer-out/in 与银行同向行按商户、币种、发生额绝对值和严格 1v1 匹配；调拨单匹配日期启用时同日优先、未命中再按 ±N 天，关闭时跳过日期；命中后回填银行 ReconciliationId。';
const FUND_TRANSFER_BACKFILL_CANONICAL_SEED = {
  name: '中台调拨订单对账ID回填',
  priority: 0,
  config: {
    funcCategory: 'platform-order',
    subCategory: 'fund-transfer-backfill',
    roundPhase: 5,
    directions: [
      { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
      { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
    ],
    dateMatchEnabled: true,
    dateToleranceDays: 1,
    reconSourceMid: true,
    paymentOfflineBackfill: {
      enabled: false,
      bankChannel: '',
      region: '',
      bigAccount: ''
    },
    function: FUND_TRANSFER_BACKFILL_CURRENT_FUNCTION,
    involvedFiles: ['银行对账单']
  }
};
const RECON_ROUND_BUILTIN_SCENARIOS = [
  // ===== R4 资金性质校验（4 子场景，按 priority 降序执行；详见 r4-fund-nature-check.js）=====
  //   v3.0.6 需求3（T9）：原 charge-outbound 子场景退役（重写为 DBS-Charge / R3.5），R4 由 5 → 4。
  {
    name: '资金性质校验-Ach Return',
    priority: 3,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory: 'ach-return',
      roundPhase: 4,
      // 🔴【待用户核对真实网关取值】AchReturn
      gwTradeType: 'AchReturn',
      setFundType: 'Ach Return',
      // v3.0.10 需求1：方向守卫——出账性质要求银行行 Credit Amount=0（命中后若 Credit Amount 非0=方向录反则不改写并记 warning）
      requireBankZeroField: 'Credit Amount',
      function: '严格匹配 TradeType=AchReturn，且对账ID、银行大账号、币种一致，abs(Debit Amount)+Extra Fee 等于网关 amount、Credit Amount 为空或0时，将 FundType 改为「Ach Return」。',
      involvedFiles: ['银行对账单']
    }
  },
  {
    name: '资金性质校验-Wire Return',
    priority: 2,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory: 'wire-return',
      roundPhase: 4,
      // 🔴【待用户核对真实网关取值】WireReturn
      gwTradeType: 'WireReturn',
      setFundType: 'Wire Return',
      // v3.0.10 需求1：方向守卫——入账性质要求银行行 Debit Amount=0（命中后若 Debit Amount 非0=方向录反则不改写并记 warning）
      requireBankZeroField: 'Debit Amount',
      function: '严格匹配 TradeType=WireReturn，且对账ID、银行大账号、币种一致，abs(Credit Amount)+Extra Fee 等于网关 amount、Debit Amount 为空或0时，将 FundType 改为「Wire Return」。',
      involvedFiles: ['银行对账单']
    }
  },
  // v3.0.6 需求3（T9）：原「资金性质校验-Charge转outbound」（subCategory='charge-outbound'）已退役 ——
  //   全渠道 charge→outbound 整体重写为 DBS 专属「DBS-Charge资金校验」（subCategory='dbs-charge-fund-check'，
  //   funcCategory='dbs-charge-fund-check' → 编排器 R3.5 桶；见 DBS_CHARGE_FUND_CHECK_SCENARIO + ensureDbsChargeFundCheckScenarioSeed）。
  //   R4 资金性质校验由 5 子场景退化为 4（ach-return / wire-return / hx-out / hx-in）。
  //   旧库孤儿（已 seed 的 charge-outbound 条目）由 retireChargeOutboundOrphans 每次启动幂等 DELETE（含级联删关联表）。
  {
    name: '资金性质校验-HX-out',
    priority: 1,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory: 'hx-out',
      roundPhase: 4,
      // 🔴【待用户核对真实网关取值】HX_OUTBOUND
      gwTradeType: 'HX_OUTBOUND',
      setFundType: 'HX-out',
      // v3.0.10 需求1：方向守卫——出账性质要求银行行 Credit Amount=0（命中后若 Credit Amount 非0=方向录反则不改写并记 warning）
      requireBankZeroField: 'Credit Amount',
      function: '严格匹配 TradeType=HX_OUTBOUND，且对账ID、银行大账号、币种一致，abs(Debit Amount)+Extra Fee 等于网关 amount、Credit Amount 为空或0时，将 FundType 改为「HX-out」。',
      involvedFiles: ['银行对账单']
    }
  },
  {
    name: '资金性质校验-HX-in',
    priority: 0,
    config: {
      funcCategory: 'fund-nature-check',
      subCategory: 'hx-in',
      roundPhase: 4,
      // 🔴【待用户核对真实网关取值】HX_INBOUND
      gwTradeType: 'HX_INBOUND',
      setFundType: 'HX-in',
      // v3.0.10 需求1：方向守卫——入账性质要求银行行 Debit Amount=0（命中后若 Debit Amount 非0=方向录反则不改写并记 warning）
      requireBankZeroField: 'Debit Amount',
      function: '严格匹配 TradeType=HX_INBOUND，且对账ID、银行大账号、币种一致，abs(Credit Amount)+Extra Fee 等于网关 amount、Debit Amount 为空或0时，将 FundType 改为「HX-in」。',
      involvedFiles: ['银行对账单']
    }
  },
  // ===== R5 中台订单数据处理（2 场景；详见 r5-fund-transfer-backfill.js / r5-platform-inbound-cleanup.js）=====
  FUND_TRANSFER_BACKFILL_CANONICAL_SEED,
  {
    name: '中台加款单脏数据处理',
    priority: 0,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'platform-inbound-cleanup',
      roundPhase: 5,
      // 🔴【待用户核对真实网关取值】Inbound-VA；excludeFundType=Inbound（命中但 FundType=Inbound 不产剔除行）
      gwTradeType: 'Inbound-VA',
      excludeFundType: 'Inbound',
      function: '网关 Inbound-VA 与银行行按对账ID 1v1 匹配，命中且银行 FundType 不为 Inbound 时，生成 1 条中台加款单剔除行（加款单号=网关 orderid，附言含银行 FundType）。',
      involvedFiles: ['中台加款单剔除模板']
    }
  },
  // ===== R5 场景4 中台退款订单回填（v2.1.16-beta.4 ③；详见 r5-refund-order-backfill.js）=====
  //   ⚠️ 本场景默认 enabled=0（Layer 1 引擎层休眠，零风险）；INSERT 参数化 enabled 时单独传 0（见下）。
  //   ⚠️ 无 directions（非场景2 双方向 1v1，是 4 基数×4 策略矩阵）。
  {
    name: '中台退款订单回填',
    priority: 0,
    config: {
      funcCategory: 'platform-order',
      subCategory: 'refund-order-backfill',
      roundPhase: 5,
      bankPaymentSerialFuzzyMatchEnabled: false,
      function: '银行 FundType=Ach Return（未改写）行与中台退款订单 SUBMITTED 行按渠道大账号/金额/币种唯一值分组，按4基数×4策略(渠道流水号/附言MTX/付款人卡号虚拟卡号/金额币种日期)+JPM(HK/US)匹配回填，产出双sheet模板，不改银行行。',
      involvedFiles: ['中台退款订单', '中台退款订单回填模板', '银行对账单入金表']
    }
  }
];

// v2.1.16-beta.4 ③：退款回填场景独立 seed marker。
//   ⚠️ 为何独立：RECON_ROUND_BUILTIN_SCENARIOS_SEEDED_MARKER 是全局 marker —— 旧库（已 seed 过 R4/R5
//   既有 7 条 + marker=true）启动时 ensureReconRoundBuiltinScenariosSeed 整体短路 return，
//   新增的退款场景不会被补种。故退款场景额外用本独立 marker + 独立迁移函数补种，
//   不改动现有全局 marker 语义（保留「删除终态保护 D14」）。
const REFUND_BACKFILL_SCENARIO_SEEDED_MARKER = 'refund_backfill_scenario_seeded';
const REFUND_BACKFILL_SCENARIO = RECON_ROUND_BUILTIN_SCENARIOS.find(
  (s) => s.config && s.config.subCategory === 'refund-order-backfill'
);

function ensureReconRoundBuiltinScenariosSeed(db) {
  // 前置 1：scenarios 表 CHECK 必须已含 'builtin-fixed'（否则 INSERT 触发 CHECK 失败）。
  //   未含 → 跳过本次，下次启动（ensureScenariosCategoryBuiltinFixed 扩 CHECK 后）重试。
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return { status: 'skipped-no-scenarios-table' };
  if (!tableSqlRow.sql.includes("'builtin-fixed'")) {
    return { status: 'skipped-check-not-extended' };
  }

  // 前置 2：marker 已写 → 整体不再 seed（D14 删除终态保护：用户删光这些内置场景后重启不复活）。
  //   仿 BUILTIN_SCENARIOS 的 scenarios_seeded：删除是终态，凭 marker 不靠「在场」。
  let markerRow;
  try {
    markerRow = db
      .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
      .get(RECON_ROUND_BUILTIN_SCENARIOS_SEEDED_MARKER);
  } catch (_e) {
    // app_settings 表不存在（极早期启动）→ 跳过，等下次启动 schema 完整后再 seed
    return { status: 'skipped-no-settings-table' };
  }
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'already-seeded' };
  }

  const now = new Date().toISOString();
  // 定位语句：凭 is_builtin + builtin-fixed + config_json 含特定 subCategory（已存在则跳过不覆盖用户改动）。
  const locate = db.prepare(
    `SELECT id FROM scenarios
      WHERE is_builtin = 1
        AND category = 'builtin-fixed'
        AND config_json LIKE ?`
  );
  // enabled 参数化（v2.1.16-beta.4 ③）：退款回填场景默认休眠 enabled=0，其余既有内置场景仍 enabled=1。
  const insert = db.prepare(`
    INSERT INTO scenarios
      (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES ('builtin-fixed', ?, ?, ?, ?, 1, 1, ?, ?)
  `);

  let inserted = 0;
  let skippedExisting = 0;
  let skippedConflict = 0;
  db.exec('BEGIN');
  try {
    for (const scenario of RECON_ROUND_BUILTIN_SCENARIOS) {
      // 幂等定位：同 subCategory 的内置 builtin-fixed 场景已存在 → 跳过不覆盖
      const subCategory = scenario.config.subCategory;
      const likePattern = `%"subCategory":"${subCategory}"%`;
      const existing = locate.get(likePattern);
      if (existing) {
        skippedExisting += 1;
        continue;
      }
      // 退款回填场景默认休眠（enabled=0）；既有 R4/R5 场景仍启用（enabled=1）。
      // v3.1.1 的“enabled=0”只用于 canonical owner 缺失后的修复插入，不改变 fresh seed 兼容口径。
      const enabledValue = subCategory === 'refund-order-backfill' ? 0 : 1;
      try {
        insert.run(
          scenario.name,
          scenario.priority,
          enabledValue,
          JSON.stringify(scenario.config),
          now,
          now
        );
        inserted += 1;
      } catch (insErr) {
        // UNIQUE(channel_id, name) 冲突（用户已有同名场景，channel_id=1）→ 单条跳过保留用户场景
        const msg = insErr && insErr.message ? insErr.message : String(insErr);
        if (/UNIQUE constraint failed/i.test(msg)) {
          skippedConflict += 1;
          continue;
        }
        throw insErr; // 其它错误（如 CHECK）→ 抛出回滚
      }
    }

    // 写 marker（无论本次插了几条 —— 仅首次启动写一次；此后删除不复活）。
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(RECON_ROUND_BUILTIN_SCENARIOS_SEEDED_MARKER, now);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { status: 'seeded', inserted, skippedExisting, skippedConflict };
}

// v3.1.1：canonical 调拨回填 owner 修复迁移。
//
// 与旧的“一次 seed 后删除终态”不同，该场景从本版本起同时承载全局日期策略，必须始终恰好有一个
// canonical owner。迁移每次启动幂等执行：
// - 1 条：清空历史适用渠道；除把逐字等于旧系统默认值的 function 更新为当前准确说明外，
//   不覆盖名称、启停、优先级或其它 config，自定义 function 也原样保留；
// - 0 条：从当前完整 seed 深拷贝恢复，默认 disabled + 通用渠道；
// - 多条：不合并、不删除，只清空这些 owner 的适用渠道并返回 duplicate，运行时 resolver 会 fail-closed。
// 普通 CRUD 不调用本函数，内置身份只由此可信 SQL 路径创建。
function ensureFundTransferBackfillCanonicalOwner(db) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, category, name, priority, enabled, is_builtin, config_json
        FROM scenarios
       ORDER BY id ASC
    `).all();
  } catch (_error) {
    return { status: 'skipped-no-scenarios-table', ownerCount: 0 };
  }

  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql || !tableSqlRow.sql.includes("'builtin-fixed'")) {
    return { status: 'skipped-check-not-extended', ownerCount: 0 };
  }

  const owners = rows.map((row) => {
    let config = null;
    try {
      config = JSON.parse(row.config_json);
    } catch (_error) {
      config = null;
    }
    return {
      id: Number(row.id),
      category: row.category,
      name: row.name,
      priority: Number(row.priority),
      enabled: Number(row.enabled) === 1,
      isBuiltin: Number(row.is_builtin) === 1,
      config
    };
  }).filter(isCanonicalFundTransferOwner);

  const applicableTableExists = Boolean(db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='scenario_applicable_channels'"
  ).get());
  const clearApplicable = applicableTableExists
    ? db.prepare('DELETE FROM scenario_applicable_channels WHERE scenario_id = ?')
    : null;
  const updateLegacyFunction = db.prepare(
    'UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?'
  );
  const hasChannelId = hasColumn(db, 'scenarios', 'channel_id');
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    owners.forEach((owner) => {
      if (clearApplicable) clearApplicable.run(owner.id);
      if (owner.config
        && owner.config.function === FUND_TRANSFER_BACKFILL_LEGACY_FUNCTION) {
        owner.config = {
          ...owner.config,
          function: FUND_TRANSFER_BACKFILL_CURRENT_FUNCTION
        };
        updateLegacyFunction.run(JSON.stringify(owner.config), now, owner.id);
      }
    });

    if (owners.length === 1) {
      db.exec('COMMIT');
      return {
        status: 'owner-present',
        ownerCount: 1,
        ownerId: owners[0].id
      };
    }
    if (owners.length > 1) {
      db.exec('COMMIT');
      return {
        status: 'duplicate-owner',
        ownerCount: owners.length,
        ownerIds: owners.map((owner) => owner.id)
      };
    }

    const configJson = JSON.stringify(
      JSON.parse(JSON.stringify(FUND_TRANSFER_BACKFILL_CANONICAL_SEED.config))
    );
    const candidateNames = [
      FUND_TRANSFER_BACKFILL_CANONICAL_SEED.name,
      '调拨回填功能管理（系统恢复）'
    ];
    let restored = null;

    for (const name of candidateNames) {
      try {
        const result = hasChannelId
          ? db.prepare(`
              INSERT INTO scenarios
                (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
              VALUES ('builtin-fixed', ?, ?, 0, ?, 1, 1, ?, ?)
            `).run(
              name,
              FUND_TRANSFER_BACKFILL_CANONICAL_SEED.priority,
              configJson,
              now,
              now
            )
          : db.prepare(`
              INSERT INTO scenarios
                (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
              VALUES ('builtin-fixed', ?, ?, 0, ?, 1, ?, ?)
            `).run(
              name,
              FUND_TRANSFER_BACKFILL_CANONICAL_SEED.priority,
              configJson,
              now,
              now
            );
        restored = {
          id: Number(result.lastInsertRowid),
          name
        };
        break;
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        if (/UNIQUE constraint failed/i.test(message)) {
          continue;
        }
        throw error;
      }
    }

    db.exec('COMMIT');
    if (!restored) {
      return {
        status: 'missing-name-conflict',
        ownerCount: 0,
        attemptedNames: candidateNames
      };
    }
    return {
      status: 'owner-restored',
      ownerCount: 1,
      ownerId: restored.id,
      ownerName: restored.name
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（🔴 资金红线 —— 默认休眠 enabled=0）。
//
// 为何独立于 ensureReconRoundBuiltinScenariosSeed：
//   后者带全局 marker（recon_round_builtin_scenarios_seeded）。旧库已 seed 既有 7 条 + marker=true，
//   启动时整体短路 return 'already-seeded' → 新增的退款回填场景在旧库永远不会被补种。
//   本函数用独立 marker（refund_backfill_scenario_seeded）+ 凭 subCategory 定位幂等，专门补种这 1 条，
//   不触碰也不依赖全局 marker，因此旧库也能装上退款场景；且新库（ensureReconRoundBuiltinScenariosSeed
//   已插过退款场景）走本函数时凭 subCategory 定位为「已存在」跳过 → 不会重复插。
//
// 幂等/删除终态（与 ensureReconRoundBuiltinScenariosSeed 同语义 D14）：
//   - 凭 is_builtin=1 + category='builtin-fixed' + config_json 含 "subCategory":"refund-order-backfill" 定位，
//     已存在 → 跳过不覆盖（保护用户对启停/改名/config 的改动）。
//   - 独立 marker 一旦写过 → 整体不再 seed，用户删除该场景后重启不复活。
//   - 默认 enabled=0（引擎层休眠，零风险）。
//
// 前置同 ensureReconRoundBuiltinScenariosSeed：scenarios 表存在 + CHECK 已含 'builtin-fixed' + app_settings 存在。
// 返回 { status, inserted? }
//   status:
//     - 'skipped-no-scenarios-table'  : scenarios 表不存在
//     - 'skipped-check-not-extended'  : CHECK 未扩到含 'builtin-fixed'
//     - 'skipped-no-settings-table'   : app_settings 表不存在（极早期启动）
//     - 'already-seeded'              : 独立 marker 已写
//     - 'seeded'                      : 本次执行（inserted=0 或 1）
function ensureRefundBackfillScenarioSeed(db) {
  // 前置 1：scenarios 表 CHECK 必须已含 'builtin-fixed'。
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return { status: 'skipped-no-scenarios-table' };
  if (!tableSqlRow.sql.includes("'builtin-fixed'")) {
    return { status: 'skipped-check-not-extended' };
  }

  // 前置 2：独立 marker 已写 → 整体不再 seed（删除终态保护：用户删该场景后重启不复活）。
  let markerRow;
  try {
    markerRow = db
      .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
      .get(REFUND_BACKFILL_SCENARIO_SEEDED_MARKER);
  } catch (_e) {
    return { status: 'skipped-no-settings-table' };
  }
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'already-seeded' };
  }

  if (!REFUND_BACKFILL_SCENARIO) {
    // 防御：数组里找不到退款场景（不应发生）→ 不写 marker，下次重试。
    return { status: 'skipped-no-scenario-def' };
  }

  const now = new Date().toISOString();
  const locate = db.prepare(
    `SELECT id FROM scenarios
      WHERE is_builtin = 1
        AND category = 'builtin-fixed'
        AND config_json LIKE ?`
  );
  const insert = db.prepare(`
    INSERT INTO scenarios
      (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES ('builtin-fixed', ?, ?, 0, ?, 1, 1, ?, ?)
  `);

  let inserted = 0;
  let skippedExisting = 0;
  let skippedConflict = 0;
  db.exec('BEGIN');
  try {
    const likePattern = '%"subCategory":"refund-order-backfill"%';
    const existing = locate.get(likePattern);
    if (existing) {
      skippedExisting = 1;
    } else {
      try {
        insert.run(
          REFUND_BACKFILL_SCENARIO.name,
          REFUND_BACKFILL_SCENARIO.priority,
          JSON.stringify(REFUND_BACKFILL_SCENARIO.config),
          now,
          now
        );
        inserted = 1;
      } catch (insErr) {
        // UNIQUE(channel_id, name) 冲突（用户已有同名场景）→ 跳过保留用户场景，不中断。
        const msg = insErr && insErr.message ? insErr.message : String(insErr);
        if (/UNIQUE constraint failed/i.test(msg)) {
          skippedConflict = 1;
        } else {
          throw insErr;
        }
      }
    }

    // 写独立 marker（仅首次启动写一次；此后删除不复活）。
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(REFUND_BACKFILL_SCENARIO_SEEDED_MARKER, now);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { status: 'seeded', inserted, skippedExisting, skippedConflict };
}

// v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景（🔴 资金红线 —— 默认休眠 enabled=0）。
//
// 与既有 builtin-fixed seed 的差异：
//   - category='gateway-recon-id-fix'（不是 'builtin-fixed'）—— 该 category 已在 scenarios CHECK 内
//     （ensureScenariosCategoryGatewayReconIdFix，v2.1.0-beta.3 引入），无需扩枚举。
//   - config 不带 funcCategory → 「功能类别」显示由 getScenarioCategoryDisplay 回退到
//     SCENARIO_CATEGORY_LABELS['gateway-recon-id-fix']=「网关对账单修复」（前端零改动）。
//   - config.subCategory='jpm-dispatch-order-fix' 是引擎分流键（runReconIdFix 据此走 JPM 引擎）。
//   - merchantId 收进 config（引擎从 scenario.config.merchantId 读，不散落硬编码；R-10）。
const JPM_DISPATCH_ORDER_SCENARIO = {
  category: 'gateway-recon-id-fix',
  name: 'JPM调拨订单修复',
  priority: 3, // 兜底值；is_builtin 置顶机制保证 compact 单类别视图序号稳定
  config: {
    subCategory: 'jpm-dispatch-order-fix',
    merchantId: ADM_MERCHANT_ID // '6300156616'
  }
};

// v2.1.16-beta.5 需求4：JPM 场景独立 seed marker（绕开全局 marker 短路，仿 ensureRefundBackfillScenarioSeed）。
const JPM_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER = 'jpm_dispatch_order_scenario_seeded';

// v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（🔴 资金红线 —— 默认休眠 enabled=0）。
//
// 幂等/删除终态（与 ensureRefundBackfillScenarioSeed 同语义）：
//   - 凭 is_builtin=1 + category='gateway-recon-id-fix' + config_json 含
//     "subCategory":"jpm-dispatch-order-fix" 定位，已存在 → 跳过不覆盖（保护用户对启停/改名/config 的改动）。
//   - 独立 marker(jpm_dispatch_order_scenario_seeded) 一旦写过 → 整体不再 seed，用户删除后重启不复活。
//   - 默认 enabled=0（Layer 1 引擎层休眠，零风险）。
//
// 前置：scenarios 表存在 + CHECK 已含 'gateway-recon-id-fix'（否则 INSERT 触发 CHECK 失败）+ app_settings 存在。
// 返回 { status, inserted?, skippedExisting?, skippedConflict? }
//   status:
//     - 'skipped-no-scenarios-table'  : scenarios 表不存在
//     - 'skipped-check-not-extended'  : CHECK 未扩到含 'gateway-recon-id-fix'
//     - 'skipped-no-settings-table'   : app_settings 表不存在（极早期启动）
//     - 'already-seeded'              : 独立 marker 已写
//     - 'seeded'                      : 本次执行（inserted=0 或 1）
function ensureJpmDispatchOrderScenarioSeed(db) {
  // 前置 1：scenarios 表 CHECK 必须已含 'gateway-recon-id-fix'。
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return { status: 'skipped-no-scenarios-table' };
  if (!tableSqlRow.sql.includes("'gateway-recon-id-fix'")) {
    return { status: 'skipped-check-not-extended' };
  }

  // 前置 2：独立 marker 已写 → 整体不再 seed（删除终态保护：用户删该场景后重启不复活）。
  let markerRow;
  try {
    markerRow = db
      .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
      .get(JPM_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER);
  } catch (_e) {
    return { status: 'skipped-no-settings-table' };
  }
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'already-seeded' };
  }

  const now = new Date().toISOString();
  // 定位：凭 is_builtin + gateway-recon-id-fix + config_json 含特定 subCategory（已存在则跳过不覆盖用户改动）。
  const locate = db.prepare(
    `SELECT id FROM scenarios
      WHERE is_builtin = 1
        AND category = 'gateway-recon-id-fix'
        AND config_json LIKE ?`
  );
  // enabled 硬编码 0（决策10：默认休眠）；category 硬编码 'gateway-recon-id-fix'。
  const insert = db.prepare(`
    INSERT INTO scenarios
      (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES ('gateway-recon-id-fix', ?, ?, 0, ?, 1, 1, ?, ?)
  `);

  let inserted = 0;
  let skippedExisting = 0;
  let skippedConflict = 0;
  db.exec('BEGIN');
  try {
    const likePattern = '%"subCategory":"jpm-dispatch-order-fix"%';
    const existing = locate.get(likePattern);
    if (existing) {
      skippedExisting = 1;
    } else {
      try {
        insert.run(
          JPM_DISPATCH_ORDER_SCENARIO.name,
          JPM_DISPATCH_ORDER_SCENARIO.priority,
          JSON.stringify(JPM_DISPATCH_ORDER_SCENARIO.config),
          now,
          now
        );
        inserted = 1;
      } catch (insErr) {
        // UNIQUE(channel_id, name) 冲突（用户已有同名场景）→ 跳过保留用户场景，不中断。
        const msg = insErr && insErr.message ? insErr.message : String(insErr);
        if (/UNIQUE constraint failed/i.test(msg)) {
          skippedConflict = 1;
        } else {
          throw insErr;
        }
      }
    }

    // 写独立 marker（仅首次启动写一次；此后删除不复活）。
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(JPM_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER, now);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { status: 'seeded', inserted, skippedExisting, skippedConflict };
}

// v3.0.4 块 E 需求1：BOC 调拨订单修复写死场景（🔴 资金红线 —— 默认休眠 enabled=0）。
//
// 与 JPM 种子（JPM_DISPATCH_ORDER_SCENARIO，上方）byte-for-byte 同范式：
//   - category='gateway-recon-id-fix'（CHECK 已含，无需扩枚举）。
//   - config 不带 funcCategory → 「功能类别」回退 SCENARIO_CATEGORY_LABELS['gateway-recon-id-fix']=「网关对账单修复」。
//   - config.subCategory='boc-dispatch-order-fix' 是引擎分流键（runReconIdFix 据此走 BOC 引擎）。
//   - channelName 收进 config（引擎从 scenario.config.channelName 读、常量兜底；R-10）；JPM 收 merchantId，BOC 收 channelName。
//   - priority=3 同 JPM；database.js init 链在 ensureJpmDispatchOrderScenarioSeed() 之后调用本函数 → 新库 id 紧随 JPM →
//     `priority DESC, id ASC` 下 BOC 排在 JPM 之后（场景管理网关 compact 序号自然 = 2）。
const BOC_DISPATCH_ORDER_SCENARIO = {
  category: 'gateway-recon-id-fix',
  name: 'BOC调拨订单修复',
  priority: 3, // 兜底值；与 JPM 同 priority，靠 id ASC 排在 JPM 之后
  config: {
    subCategory: 'boc-dispatch-order-fix',
    channelName: 'BOC' // 引擎读 config.channelName，常量兜底（boc-dispatch-order-fields.BOC_CHANNEL_NAME）
  }
};

// v3.0.4 块 E 需求1：BOC 场景独立 seed marker（绕开全局 marker 短路，仿 JPM）。
const BOC_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER = 'boc_dispatch_order_scenario_seeded';

// v3.0.4 块 E 需求1：BOC 调拨订单修复写死场景独立补种（🔴 资金红线 —— 默认休眠 enabled=0）。
//
// 幂等/删除终态（与 ensureJpmDispatchOrderScenarioSeed byte-for-byte 同语义）：
//   - 凭 is_builtin=1 + category='gateway-recon-id-fix' + config_json 含
//     "subCategory":"boc-dispatch-order-fix" 定位，已存在 → 跳过不覆盖（保护用户对启停/改名/config 的改动）。
//   - 独立 marker(boc_dispatch_order_scenario_seeded) 一旦写过 → 整体不再 seed，用户删除后重启不复活。
//   - 默认 enabled=0（Layer 1 引擎层休眠，零风险）。
//
// 前置：scenarios 表存在 + CHECK 已含 'gateway-recon-id-fix' + app_settings 存在。
// 返回 { status, inserted?, skippedExisting?, skippedConflict? }（status 取值同 JPM 种子）。
function ensureBocDispatchOrderScenarioSeed(db) {
  // 前置 1：scenarios 表 CHECK 必须已含 'gateway-recon-id-fix'。
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return { status: 'skipped-no-scenarios-table' };
  if (!tableSqlRow.sql.includes("'gateway-recon-id-fix'")) {
    return { status: 'skipped-check-not-extended' };
  }

  // 前置 2：独立 marker 已写 → 整体不再 seed（删除终态保护：用户删该场景后重启不复活）。
  let markerRow;
  try {
    markerRow = db
      .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
      .get(BOC_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER);
  } catch (_e) {
    return { status: 'skipped-no-settings-table' };
  }
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'already-seeded' };
  }

  const now = new Date().toISOString();
  // 定位：凭 is_builtin + gateway-recon-id-fix + config_json 含特定 subCategory（已存在则跳过不覆盖用户改动）。
  const locate = db.prepare(
    `SELECT id FROM scenarios
      WHERE is_builtin = 1
        AND category = 'gateway-recon-id-fix'
        AND config_json LIKE ?`
  );
  // enabled 硬编码 0（默认休眠）；category 硬编码 'gateway-recon-id-fix'；channel_id 硬编码 1。
  const insert = db.prepare(`
    INSERT INTO scenarios
      (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES ('gateway-recon-id-fix', ?, ?, 0, ?, 1, 1, ?, ?)
  `);

  let inserted = 0;
  let skippedExisting = 0;
  let skippedConflict = 0;
  db.exec('BEGIN');
  try {
    const likePattern = '%"subCategory":"boc-dispatch-order-fix"%';
    const existing = locate.get(likePattern);
    if (existing) {
      skippedExisting = 1;
    } else {
      try {
        insert.run(
          BOC_DISPATCH_ORDER_SCENARIO.name,
          BOC_DISPATCH_ORDER_SCENARIO.priority,
          JSON.stringify(BOC_DISPATCH_ORDER_SCENARIO.config),
          now,
          now
        );
        inserted = 1;
      } catch (insErr) {
        // UNIQUE(channel_id, name) 冲突（用户已有同名场景）→ 跳过保留用户场景，不中断。
        const msg = insErr && insErr.message ? insErr.message : String(insErr);
        if (/UNIQUE constraint failed/i.test(msg)) {
          skippedConflict = 1;
        } else {
          throw insErr;
        }
      }
    }

    // 写独立 marker（仅首次启动写一次；此后删除不复活）。
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(BOC_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER, now);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { status: 'seeded', inserted, skippedExisting, skippedConflict };
}

// v3.0.6 需求3（T9）：DBS-Charge 资金校验写死场景（🔴 资金红线 —— 改写 ReconciliationId + FundType）。
//
// 与 BOC/JPM 种子的差异：
//   - category='builtin-fixed'（同 R4/R5 内置场景；前置 CHECK 须已含 'builtin-fixed'）。
//   - config.funcCategory='dbs-charge-fund-check' 是编排器 R3.5 分流键
//     （reconciliation-orchestrator.bucketScenarios：funcCategory==='dbs-charge-fund-check' → dbsChargeFundCheck 桶 → R3.5）。
//   - config.subCategory='dbs-charge-fund-check' 是 seed 幂等定位键（与 funcCategory 同字面，区别于已退役的 'charge-outbound'）。
//   - 默认 enabled=1（启用即生效；DBS 渠道空 / 调拨对账单空时引擎整体 no-op，无 DBS 数据零影响）。
//   - 引擎 runDbsChargeFundCheck 从 scenario.config 读 dispatchChannelValue/setFundTypeCharge/setFundTypeOutbound/
//     chargeSiblingsScope（编排器 R3.5 段直接把 scenario.config 透传给引擎），字面值须与引擎 DEFAULT_CONFIG 逐字对齐。
//     🔴 chargeSiblingsScope='dbs-only'（默认）：步骤1末只对 Channel=DBS 行批量归并为 Charge，
//        防跨渠道误伤非 DBS 同 reconId 行（用户决策偏离原文字面）；'all' 仍可经 config 切回全量银行单。
const DBS_CHARGE_FUND_CHECK_SCENARIO = {
  name: 'DBS-Charge资金校验',
  priority: 1, // 兜底值；is_builtin 置顶机制保证场景管理视图序号稳定
  config: {
    funcCategory: 'dbs-charge-fund-check', // 编排器 R3.5 分流键
    subCategory: 'dbs-charge-fund-check',  // seed 幂等定位键（区别于已退役 'charge-outbound'）
    roundPhase: 3.5,
    bankChannel: 'DBS',            // 步骤1 银行行门控：Channel===DBS 才进 DBS-Charge
    dispatchChannelValue: 'DBS',  // 步骤1 调拨对账单付款渠道 + 收款渠道均须等于此值
    setFundTypeCharge: 'Charge',  // 步骤1末归并目标 FundType（同 reconId 非 Charge 行置此值）
    setFundTypeOutbound: 'outbound', // 步骤2 命中目标 FundType
    chargeSiblingsScope: 'dbs-only', // 🔴 步骤1末批量置 Charge 波及范围默认仅 DBS 渠道行（防跨渠道误伤；'all' 可切回全量银行单）
    function: 'DBS渠道银行单经调拨对账单赋ReconciliationId并归并FundType，再按网关amount/currency判定outbound（资金校验）',
    involvedFiles: ['银行对账单', '调拨对账单', '网关对账单']
  }
};

// v3.0.6 需求3（T9）：DBS-Charge 场景独立 seed marker（绕开全局 marker 短路，仿 ensureBocDispatchOrderScenarioSeed）。
const DBS_CHARGE_FUND_CHECK_SCENARIO_SEEDED_MARKER = 'dbs_charge_fund_check_scenario_seeded';

// v3.0.6 需求3（T9）：DBS-Charge 资金校验写死场景独立补种（🔴 资金红线 —— 改写 ReconciliationId + FundType）。
//
// 为何独立于 ensureReconRoundBuiltinScenariosSeed：
//   后者带全局 marker（recon_round_builtin_scenarios_seeded）。旧库已 seed 既有 8 条 + marker=true，
//   启动时整体短路 return → DBS-Charge 新增场景在旧库永远不会被补种。本函数用独立 marker
//   （dbs_charge_fund_check_scenario_seeded）+ 凭 subCategory 定位幂等，专门补种这 1 条；新库走幂等定位为「已存在」跳过。
//
// 幂等/删除终态（与 ensureBocDispatchOrderScenarioSeed 同语义）：
//   - 凭 is_builtin=1 + category='builtin-fixed' + config_json 含 "subCategory":"dbs-charge-fund-check" 定位，
//     已存在 → 跳过不覆盖（保护用户对启停/改名/config 的改动）。
//   - 独立 marker 一旦写过 → 整体不再 seed，用户删除该场景后重启不复活。
//   - 默认 enabled=1（启用即生效；DBS 渠道空 / 调拨对账单空时引擎整体 no-op）。
//
// 前置：scenarios 表存在 + CHECK 已含 'builtin-fixed' + app_settings 存在。
// 返回 { status, inserted?, skippedExisting?, skippedConflict? }（status 取值同 BOC 种子）。
function ensureDbsChargeFundCheckScenarioSeed(db) {
  // 前置 1：scenarios 表 CHECK 必须已含 'builtin-fixed'。
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return { status: 'skipped-no-scenarios-table' };
  if (!tableSqlRow.sql.includes("'builtin-fixed'")) {
    return { status: 'skipped-check-not-extended' };
  }

  // 前置 2：独立 marker 已写 → 整体不再 seed（删除终态保护：用户删该场景后重启不复活）。
  let markerRow;
  try {
    markerRow = db
      .prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
      .get(DBS_CHARGE_FUND_CHECK_SCENARIO_SEEDED_MARKER);
  } catch (_e) {
    return { status: 'skipped-no-settings-table' };
  }
  if (markerRow && String(markerRow.setting_value) === 'true') {
    return { status: 'already-seeded' };
  }

  const now = new Date().toISOString();
  // 定位：凭 is_builtin + builtin-fixed + config_json 含特定 subCategory（已存在则跳过不覆盖用户改动）。
  const locate = db.prepare(
    `SELECT id FROM scenarios
      WHERE is_builtin = 1
        AND category = 'builtin-fixed'
        AND config_json LIKE ?`
  );
  // enabled 硬编码 1（启用即生效；引擎自带 DBS 渠道空 / 调拨对账单空 no-op 门控）；category 硬编码 'builtin-fixed'。
  const insert = db.prepare(`
    INSERT INTO scenarios
      (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES ('builtin-fixed', ?, ?, 1, ?, 1, 1, ?, ?)
  `);

  let inserted = 0;
  let skippedExisting = 0;
  let skippedConflict = 0;
  db.exec('BEGIN');
  try {
    const likePattern = '%"subCategory":"dbs-charge-fund-check"%';
    const existing = locate.get(likePattern);
    if (existing) {
      skippedExisting = 1;
    } else {
      try {
        insert.run(
          DBS_CHARGE_FUND_CHECK_SCENARIO.name,
          DBS_CHARGE_FUND_CHECK_SCENARIO.priority,
          JSON.stringify(DBS_CHARGE_FUND_CHECK_SCENARIO.config),
          now,
          now
        );
        inserted = 1;
      } catch (insErr) {
        // UNIQUE(channel_id, name) 冲突（用户已有同名场景）→ 跳过保留用户场景，不中断。
        const msg = insErr && insErr.message ? insErr.message : String(insErr);
        if (/UNIQUE constraint failed/i.test(msg)) {
          skippedConflict = 1;
        } else {
          throw insErr;
        }
      }
    }

    // 写独立 marker（仅首次启动写一次；此后删除不复活）。
    db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, 'true', ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
    `).run(DBS_CHARGE_FUND_CHECK_SCENARIO_SEEDED_MARKER, now);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { status: 'seeded', inserted, skippedExisting, skippedConflict };
}

// v3.0.6 需求3（T9）：每次启动幂等删除已废弃的 charge-outbound 内置孤儿场景
//   （🔴 资金红线 + 破坏性 —— 从 DB 删内置场景行，但仅限已退役的 charge-outbound 内置孤儿）。
//
// 背景：原全渠道「资金性质校验-Charge转outbound」(subCategory='charge-outbound') 已整体退役（重写为
//   DBS-Charge / R3.5），R4 引擎的 charge-outbound 分支已于 T10 删除。删 RECON_ROUND_BUILTIN_SCENARIOS
//   数组条目只影响「新库不再 seed」；旧库（已 seed 过该条目）里仍残留一条 enabled=1 的孤儿场景 —— 它会
//   落 R4 桶（funcCategory='fund-nature-check'）却指向已不存在的引擎分支，必须从库里彻底清除。
//
// 决策（用户）：彻底删除而非禁用 —— 引擎逻辑已删，该场景无任何执行价值，禁用（enabled=0）只会让它继续在
//   场景管理 UI 露出一条死场景。改为 DELETE：场景管理 UI 不再显示，库里不留死引用。
//
// 去 marker（对比旧实现）：旧实现用独立 marker(charge_outbound_retired) 一次性 UPDATE enabled=0。脆弱点 ——
//   UPDATE 影响 0 行也照写 marker；一旦出现「marker 写了但禁用没生效」的中间态（如旧库 seed 时机错位），就会
//   永久跳过、孤儿永不清理。本实现去掉 marker，改为每次启动幂等 DELETE：无孤儿则 deleted=0 no-op，重复跑安全，
//   不依赖任何一次性标志位，杜绝中间态污染导致的永久跳过。
//
// 🔴 WHERE 严格三重限定（is_builtin=1 + category='builtin-fixed' + config.subCategory='charge-outbound'），
//   绝不误删 DBS-Charge(subCategory='dbs-charge-fund-check') / 其余 R4 子场景 / 用户自建场景。
//   级联：scenario_applicable_channels.scenario_id 是 scenarios.id 的唯一 FK（ON DELETE CASCADE）；本实现
//   仍在删 scenarios 前显式 DELETE 关联行（不依赖 PRAGMA foreign_keys 是否开启，防 FK 残留 / 主键悬空）。
//
// 前置：scenarios 表存在。无 app_settings 依赖（去 marker 后不读/写设置）。CHECK 无要求（仅 DELETE 既有行）。
// 返回 { status, deleted? }
//   status:
//     - 'skipped-no-scenarios-table' : scenarios 表不存在（极早期启动）
//     - 'retired'                    : 本次执行（deleted = 删除的孤儿场景行数，可能为 0 = no-op）
function retireChargeOutboundOrphans(db) {
  // 前置：scenarios 表存在（极早期启动时可能尚未建表）。
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return { status: 'skipped-no-scenarios-table' };

  // 🔴 唯一定位条件：内置 charge-outbound 孤儿（严格三重限定，绝不误删 DBS-Charge / 用户场景）。
  const ORPHAN_WHERE = `is_builtin = 1
         AND category = 'builtin-fixed'
         AND config_json LIKE '%"subCategory":"charge-outbound"%'`;

  let deleted = 0;
  db.exec('BEGIN');
  try {
    // 1) 先删关联行（scenario_applicable_channels 是 scenarios.id 的唯一 FK；显式删，不赖 PRAGMA foreign_keys）。
    //    scenario_applicable_channels 在极旧库可能尚未建表 → IF 存在才删（CREATE 顺序晚于本迁移调用点的极端情况兜底）。
    const hasAcTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scenario_applicable_channels'"
    ).get();
    if (hasAcTable) {
      db.prepare(`
        DELETE FROM scenario_applicable_channels
         WHERE scenario_id IN (
           SELECT id FROM scenarios WHERE ${ORPHAN_WHERE}
         )
      `).run();
    }

    // 2) 再删孤儿场景行本身（幂等：无孤儿 → changes=0 no-op；重复跑安全）。
    const del = db.prepare(`
      DELETE FROM scenarios WHERE ${ORPHAN_WHERE}
    `).run();
    deleted = del && typeof del.changes === 'number' ? del.changes : 0;

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { status: 'retired', deleted };
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

// v2.1.16-beta.2 §FundType：一次性修存量 config 里 FundType 错拼 'Ach Ruturn' → 'Ach Return'（🔴 资金红线 — FundType 枚举值）
//
// 背景：
//   - assets/FundType枚举值.xlsx 历史上把 'Ach Return' 误拼成 'Ach Ruturn'（见 src/constants/fund-type-enum.js）。
//     C2 打标场景弹窗的 FundType 下拉直接来自该 xlsx（值「严格按文件原样」不纠正），
//     故老用户若在 C2 场景里选过该值，scenarios.config_json 会持久化字面 'Ach Ruturn'。
//   - 本版已把 xlsx 内容改正为 'Ach Return'；存量 config 里的旧错拼值不会被自动同步 → 需一次性数据迁移修正，
//     否则旧场景的打标值与新枚举不一致（资金性质打标依赖 FundType 字面匹配）。
//   - 注：R4/R5 内置场景（ensureReconRoundBuiltinScenariosSeed）seed 时用的就是正确拼写 'Ach Return'，本迁移不影响它们；
//     仅修「用户手动在 config 里存过 'Ach Ruturn' 的行」（绝大多数库无引用 → no-op，属精确性防护）。
//
// 安全策略：
//   - **精确字面替换**：只把 config_json 文本里出现的精确子串 'Ach Ruturn' 全部替换为 'Ach Return'，
//     不解析 config 结构（FundType 可能出现在 markValue / setValue / 条件 value 等多处，逐字段解析易漏；
//     字面替换覆盖全部位置）。'Ach Ruturn' 是高辨识度错拼串，误伤其它内容风险极低。
//   - 事务包裹：BEGIN / COMMIT，失败 ROLLBACK；只对「确实含该串」的行做 UPDATE。
//   - 幂等：执行一次后 config 里不再含 'Ach Ruturn'，再次运行 SELECT ... LIKE '%Ach Ruturn%' 命中 0 行 → no-op。
//
// 返回：{ status: 'no-op' | 'migrated', scanned, updated }
function ensureFundTypeAchReturnConfigMigration(db) {
  // scenarios 表不存在（极早期启动） → 跳过，下次启动重试
  let rows;
  try {
    rows = db.prepare(
      `SELECT id, config_json FROM scenarios WHERE config_json LIKE '%Ach Ruturn%'`
    ).all();
  } catch (_e) {
    return { status: 'no-op', scanned: 0, updated: 0 };
  }
  if (rows.length === 0) {
    return { status: 'no-op', scanned: 0, updated: 0 };
  }

  const update = db.prepare(
    `UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`
  );
  const now = new Date().toISOString();
  let updated = 0;

  db.exec('BEGIN');
  try {
    rows.forEach((row) => {
      const original = row.config_json;
      if (typeof original !== 'string' || original.indexOf('Ach Ruturn') === -1) return;
      // 精确全局替换字面子串（不依赖 config 结构；split/join 避免正则转义风险）
      const fixed = original.split('Ach Ruturn').join('Ach Return');
      if (fixed !== original) {
        update.run(fixed, now, row.id);
        updated += 1;
      }
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { status: updated > 0 ? 'migrated' : 'no-op', scanned: rows.length, updated };
}

// v3.0.10 需求1：R4 方向守卫 config 字段补种（历史兼容迁移）。
//
// 背景：
//   - v3.0.10 时 R4 从 config.requireBankZeroField 读取方向列；v3.0.23 起四类核心口径已按 subCategory 固定，
//     当前引擎不再依赖该字段。
//   - 守卫读 config.requireBankZeroField（4 个 R4 子场景各对应一列）。本字段已加进 RECON_ROUND_BUILTIN_SCENARIOS
//     seed，但老库的 4 个 R4 场景早已 seed 过、且 ensureReconRoundBuiltinScenariosSeed 凭全局 marker 短路 →
//     老库拿不到新字段 → 守卫读到 undefined → 整层方向守卫静默不生效。这是资金红线必须堵的缝。
//   - 迁移继续保留，保证配置导出/回滚到旧版本时仍完整；不得把该字段重新作为 v3.0.23 当前资金规则来源。
//
// 安全策略（范式同 ensureFundTypeAchReturnConfigMigration：精确定位 scenarios.config_json + JSON.parse + 事务 + 幂等）：
//   - ⚠️ 无 marker：每次启动幂等补回缺失的 requireBankZeroField（不依赖任何 marker，老库也能补上）。
//   - 🔴 绝不覆盖用户已改的值：config 里已有 requireBankZeroField（哪怕被用户改成空串）→ 跳过不动。
//   - 精确匹配：LIKE 仅粗筛，JSON.parse 后再校验 subCategory 严格相等才补（避免误伤）。
//   - 事务包裹：BEGIN / COMMIT，失败 ROLLBACK。
//   - scenarios 表不存在（极早期启动）→ no-op 不抛错，下次启动重试。
//   - 幂等：执行一次后 4 个 R4 场景 config 均含 requireBankZeroField → 再次运行全部命中「已存在跳过」→ updated=0、no-op。
//
// 返回：{ status: 'no-op' | 'migrated', scanned, updated }
const R4_DIRECTION_GUARD_FIELD = 'requireBankZeroField';
const R4_DIRECTION_GUARD_BY_SUBCATEGORY = Object.freeze({
  'ach-return': 'Credit Amount', // 出账性质 → 要求 Credit Amount=0
  'wire-return': 'Debit Amount', // 入账性质 → 要求 Debit Amount=0
  'hx-out': 'Credit Amount',     // 出账性质 → 要求 Credit Amount=0
  'hx-in': 'Debit Amount'        // 入账性质 → 要求 Debit Amount=0
});

function ensureR4DirectionGuardConfigMigration(db) {
  // scenarios 表不存在（极早期启动）→ 跳过，下次启动重试
  let select;
  try {
    select = db.prepare(`SELECT id, config_json FROM scenarios WHERE config_json LIKE ?`);
  } catch (_e) {
    return { status: 'no-op', scanned: 0, updated: 0 };
  }

  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  let scanned = 0;
  let updated = 0;

  db.exec('BEGIN');
  try {
    for (const [subCat, zeroField] of Object.entries(R4_DIRECTION_GUARD_BY_SUBCATEGORY)) {
      const rows = select.all(`%"subCategory":"${subCat}"%`);
      for (const row of rows) {
        scanned += 1;
        let cfg;
        try {
          cfg = JSON.parse(row.config_json);
        } catch (_e) {
          continue; // 非法 JSON 跳过（防御）
        }
        if (!cfg || cfg.subCategory !== subCat) continue; // 精确匹配（LIKE 仅粗筛）
        // 🔴 已存在则跳过（绝不覆盖用户改值；用 hasOwnProperty 判存在，即便被改成空串也保留、不补回）
        if (Object.prototype.hasOwnProperty.call(cfg, R4_DIRECTION_GUARD_FIELD)) continue;
        cfg[R4_DIRECTION_GUARD_FIELD] = zeroField;
        update.run(JSON.stringify(cfg), now, row.id);
        updated += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { status: updated > 0 ? 'migrated' : 'no-op', scanned, updated };
}

// v3.0.23：R4 核心规则改为 subCategory 固定严格匹配后，幂等刷新四个内置场景的功能说明。
// 只覆盖 is_builtin=1、category=builtin-fixed、funcCategory=fund-nature-check 的 function 字段；
// 启停、名称、优先级及其它 config 字段全部保留。无 marker，每次启动内容相同即 no-op。
const R4_STRICT_FUNCTION_BY_SUBCATEGORY = Object.freeze({
  'ach-return': '严格匹配 TradeType=AchReturn，且对账ID、银行大账号、币种一致，abs(Debit Amount)+Extra Fee 等于网关 amount、Credit Amount 为空或0时，将 FundType 改为「Ach Return」。',
  'wire-return': '严格匹配 TradeType=WireReturn，且对账ID、银行大账号、币种一致，abs(Credit Amount)+Extra Fee 等于网关 amount、Debit Amount 为空或0时，将 FundType 改为「Wire Return」。',
  'hx-out': '严格匹配 TradeType=HX_OUTBOUND，且对账ID、银行大账号、币种一致，abs(Debit Amount)+Extra Fee 等于网关 amount、Credit Amount 为空或0时，将 FundType 改为「HX-out」。',
  'hx-in': '严格匹配 TradeType=HX_INBOUND，且对账ID、银行大账号、币种一致，abs(Credit Amount)+Extra Fee 等于网关 amount、Debit Amount 为空或0时，将 FundType 改为「HX-in」。'
});

function ensureR4StrictDescriptionMigration(db) {
  let select;
  try {
    select = db.prepare(`
      SELECT id, config_json
        FROM scenarios
       WHERE is_builtin = 1
         AND category = 'builtin-fixed'
         AND config_json LIKE ?
    `);
  } catch (_error) {
    return { status: 'no-op', scanned: 0, updated: 0 };
  }

  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  let scanned = 0;
  let updated = 0;

  db.exec('BEGIN');
  try {
    for (const [subCategory, description] of Object.entries(R4_STRICT_FUNCTION_BY_SUBCATEGORY)) {
      for (const row of select.all(`%"subCategory":"${subCategory}"%`)) {
        scanned += 1;
        let config;
        try {
          config = JSON.parse(row.config_json);
        } catch (_error) {
          continue;
        }
        if (!config
          || config.funcCategory !== 'fund-nature-check'
          || config.subCategory !== subCategory
          || config.function === description) {
          continue;
        }
        config.function = description;
        update.run(JSON.stringify(config), now, row.id);
        updated += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { status: updated > 0 ? 'migrated' : 'no-op', scanned, updated };
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

  // ---------------- Step 4.5：pre-migration FK check（spec §5.3.2 8-status state machine 第 3 步 'checked'） ----------------
  // v2.1.10 SR-FIX-1 round 2 P1-3：spec §5.3.2 定义 8 status，原 code 漏 'checked'
  //   触发场景：v2.1.7/v2.1.8/v2.1.9 老库已经有 FK violation（极少；理论 0，但 SQLite WAL replay 边界 / 用户 sqlite3 直改等极端场景可能引入）
  //   修复后：跑 PRAGMA foreign_key_check 整表先验；如有 violation → 拒绝迁移（不动 schema，保留备份 + 错误信息供人工排查）
  //   safer 不变：foreign_key_check 只读不锁；失败 path 不破坏已备份的 DB
  try {
    const preViolations = db
      .prepare(`PRAGMA foreign_key_check('${N4_CONT_2_DIFF_ROWS_TABLE}')`)
      .all();
    if (preViolations && preViolations.length > 0) {
      return {
        status: 'pre-fk-violation',
        statusReached,
        backupPath,
        error: `pre-migration FK check 发现 ${preViolations.length} 条 violation — 拒绝迁移以防破坏（备份已保留：${backupPath || '(none)'}）`,
      };
    }
  } catch (preCheckErr) {
    // PRAGMA 失败（如表不存在 — 但 Step 3 已检查；防御性）→ 走 migration-failed 路径
    return {
      status: 'migration-failed',
      statusReached,
      backupPath,
      error: `pre-migration FK check 抛错：${preCheckErr && preCheckErr.message ? preCheckErr.message : String(preCheckErr)}`,
    };
  }
  statusReached = 'checked';

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

// v2.1.12 需求1 T-vcc-1 — VCC业务OP计算模块（vcc-op-calc）运行表；
// v3.2.0 E03-B — 同库新增 saveRun operation receipt。
// 复用 v2.1.2 bankBuRecon 范式（ensureBankBuReconTablesSupport），主 DB（tool-data.sqlite）
//   - vcc_op_calc_runs：按月一行 = 一次计算汇总（month / 发生额出入总额 / 期初OP / 期末OP / 币种）
//   - vcc_op_calc_run_files：每次运行的逐文件发生额明细（file_name / row_count / out / in / amount）
//   - vcc_op_operation_receipts：save Task operation identity 与业务 run 的同事务提交证据
// 资金红线 🔴：所有金额列一律 TEXT 存储（防 JS Number 浮点漂移；session 用整数分计算后传字符串）。
// 幂等：CREATE TABLE / INDEX IF NOT EXISTS，多次启动 no-op。
// 与现有 5 模块表完全隔离（零改动），调用顺序无依赖。
function ensureVccOpCalcTablesSupport(db) {
  db.exec('BEGIN');

  try {
    // 表 A：vcc_op_calc_runs（spec §1.2 表A）
    db.exec(`
      CREATE TABLE IF NOT EXISTS vcc_op_calc_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year_month TEXT NOT NULL,
        run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        file_count INTEGER NOT NULL,
        total_amount_out TEXT NOT NULL,
        total_amount_in TEXT NOT NULL,
        total_amount TEXT NOT NULL,
        begin_op TEXT NOT NULL,
        end_op TEXT NOT NULL,
        currency TEXT
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vcc_runs_month
        ON vcc_op_calc_runs(year_month, run_at DESC);
    `);

    // 表 B：vcc_op_calc_run_files（spec §1.2 表B）
    db.exec(`
      CREATE TABLE IF NOT EXISTS vcc_op_calc_run_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        amount_out TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        amount TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES vcc_op_calc_runs(id)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vcc_files_run
        ON vcc_op_calc_run_files(run_id);
    `);

    // E03-B：独立 receipt 不改旧 run/files 口径。当前产品物理 run 表为
    // vcc_op_calc_runs，因此 FK 必须指向该唯一真相，不能另建 vcc_op_runs 别名表。
    db.exec(`
      CREATE TABLE IF NOT EXISTS vcc_op_operation_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_key TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        producer_task_run_id TEXT NOT NULL,
        run_id INTEGER NOT NULL,
        year_month TEXT NOT NULL,
        compute_snapshot_hash TEXT NOT NULL,
        input_file_count INTEGER NOT NULL,
        committed_at TEXT NOT NULL,
        UNIQUE(action_key, operation_key),
        FOREIGN KEY (run_id) REFERENCES vcc_op_calc_runs(id)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_vcc_op_operation_receipts_run_id
        ON vcc_op_operation_receipts(run_id);
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
    // v3.0.3 PR-B（acquiring-import-recon-perf P0-3）：新库一步到位建 covering 索引（不再建旧 _month / _join）
    //   决策依据：UNIQUE(month_key, recon_main_id) 自带唯一索引 → 旧 idx_*_month（左前缀）与 idx_*_join（全键）冗余；
    //   covering 加 settle_currency_norm 让对账 JOIN 探测 index-only 不回表（通用模式：分区键+业务键+比对键）。
    //   老库的旧 4 索引由 ensureAcquiringBillCurrencyIndexSlimV2 迁移（DROP 旧 4 + CREATE v2）。
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_flow_join_v2
        ON acquiring_bill_currency_flow_imports(month_key, recon_main_id, settle_currency_norm);
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
    // v3.0.3 PR-B（acquiring-import-recon-perf P0-3）：bill 侧同 flow，新库直接建 covering 索引（详见上方 flow 侧注释）
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_join_v2
        ON acquiring_bill_currency_bill_imports(month_key, recon_main_id, settle_currency_norm);
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

// v3.0.3 PR-B（acquiring-import-recon-perf P0-3）：收单两表索引瘦身 + covering 升级（老库迁移）
//   决策依据：UNIQUE(month_key, recon_main_id) 已自带唯一索引 → 旧 idx_*_month（左前缀）+ idx_*_join（全键）
//     与之完全冗余，每行 INSERT 多维护 2 个 B-tree；删冗余后导入每行少维护 1 个 B-tree。
//   covering 升级：join 索引加第三列 settle_currency_norm → 对账 JOIN 探测列 = (分区键 month_key, 业务键
//     recon_main_id, 比对键 settle_currency_norm) 全在索引内，index-only 不回表读宽行（含 raw_json）。
//   通用模式（big-table-import-engine §8.3 留缝）：对账 covering 索引 = (分区键, 业务键, 比对键)。
//   新库由 ensureAcquiringBillCurrencyTablesSupport 直接建 v2；本函数仅服务老库（已建旧 4 索引）的就地迁移。
//   幂等：DROP INDEX IF EXISTS（旧索引不存在则 no-op）+ CREATE INDEX IF NOT EXISTS（v2 已存在则 no-op）；
//     事务包裹保证 DROP+CREATE 原子（中途失败 ROLLBACK，下次启动重试）。
//   idx_acquiring_bill_currency_bill_source_file（writer 高频查询用）不在本函数范围，保留不动。
function ensureAcquiringBillCurrencyIndexSlimV2(db) {
  db.exec('BEGIN');
  try {
    db.exec('DROP INDEX IF EXISTS idx_acquiring_bill_currency_flow_month');
    db.exec('DROP INDEX IF EXISTS idx_acquiring_bill_currency_flow_join');
    db.exec('DROP INDEX IF EXISTS idx_acquiring_bill_currency_bill_month');
    db.exec('DROP INDEX IF EXISTS idx_acquiring_bill_currency_bill_join');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_flow_join_v2
      ON acquiring_bill_currency_flow_imports(month_key, recon_main_id, settle_currency_norm)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_acquiring_bill_currency_bill_join_v2
      ON acquiring_bill_currency_bill_imports(month_key, recon_main_id, settle_currency_norm)`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// v2.1.16 阶段一 A3 — 链接表持久化（资金对账数据处理 / 链接表管理弹窗后端）
// 混合存储：每张数据表 = 少数「提取键列」（join 键）+ 日期列（建索引）+ raw_json（整行 JSON）+ imported_at
//   meta 表 linked_table_meta：按 table_key 记录数据日期范围 / 行数 / 来源文件 / 更新时间（前端弹窗渲染用）。
// tableKey 与前端 createLinkedTableManagerDialog LINKED_TABLES 一一对应：
//   gateway-bill（网关对账单）/ mid-allocation（中台调拨订单）/ fx-settlement（外汇交割表）
//   fx-option（外汇期权）模板缺失（PRD v2.1.14 §D ❌ 缺失待补）→ 本批次不建数据表；
//     CREATE TABLE IF NOT EXISTS 范式保证未来期权模板到位后增量加表零返工。
// 各表键列 / 日期列来源（已读 assets 模板表头确认，详见 linked-table-repository.js LINKED_TABLE_DEFS）：
//   linked_gateway_bill   : 键 reconciliation_id(reconciliationid) / 日期 bill_date(Billdate)
//   linked_mid_allocation : 键 allocation_no(调拨单号)             / 日期 transaction_date(列名已对齐「交易时间」idx 4——业务日期空值率高，数据日期范围用交易时间)
//   linked_fx_settlement  : 键 transaction_no(交易编号)           / 日期 transaction_date(交易日期)
//   linked_bank_deposit   : 键 reconciliation_id(ReconciliationId) / 日期 bill_date(BillDate)（v2.1.16-beta.3 ②）
// 幂等：CREATE TABLE / INDEX IF NOT EXISTS，多次启动 no-op；纯新增无破坏性（不需备份 / 标志位）。
// 与现有模块表完全隔离，调用顺序无依赖。
function ensureLinkedTableSupport(db) {
  db.exec('BEGIN');

  try {
    // 元数据表：每 tableKey 一行（前端弹窗「数据日期范围 / 表库更新日期」数据源）
    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_table_meta (
        table_key TEXT PRIMARY KEY,
        data_date_min TEXT,
        data_date_max TEXT,
        row_count INTEGER NOT NULL DEFAULT 0,
        source_file_name TEXT,
        updated_at TEXT
      );
    `);

    // 数据表 1：网关对账单（键 reconciliation_id / 日期 bill_date）
    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_gateway_bill (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reconciliation_id TEXT,
        bill_date TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_gateway_bill_recon ON linked_gateway_bill(reconciliation_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_gateway_bill_date ON linked_gateway_bill(bill_date);');

    // v3.0.1 需求1：网关对账单批量导入「按 ReconBillBizId 幂等累加」——新增幂等键列 recon_bill_biz_id + UNIQUE 索引。
    //   幂等：仅 recon_bill_biz_id 列不存在时执行整块（ALTER + 回填 + 存量清洗 + 建 UNIQUE）；升级后 / 新建库首启一次，
    //     后续启动列已存在即跳过（与本函数其它 hasColumn 守卫范式一致，如 line ~2687 business_date RENAME）。
    //   🔴 资金红线（spec R-2）：建 UNIQUE 前必须清洗存量，否则 CREATE UNIQUE INDEX 在存量空键/重复键上抛错
    //     → 整个 ensureLinkedTableSupport 事务 ROLLBACK → 资金模块启动失败。清洗策略 OPEN-8 用户 2026-06-09 拍板：
    //     空键行直接删（与新导入空键拒入同口径）；重复键保留最大 id（最新导入）。资金数据不可逆删除 → appendModuleLog（warning）记录删除行数
    //     （禁直接 console.*：架构守护 v2.1.9-sr-log-1 Case 6 要求 src 全树零 console.error/warn，统一走日志上报，与本文件 N4 备份失败范式一致）。
    //   口径：回填用 TRIM(json_extract(...)) 与 linked-table-repository.normalizeKey（String().trim()）字节一致，
    //     防存量行键与后续 upsert 键漂移（精确大小写 ReconBillBizId，见 table-signatures.js GATEWAY_RECON_SIGNATURE idx 13）。
    if (!hasColumn(db, 'linked_gateway_bill', 'recon_bill_biz_id')) {
      db.exec('ALTER TABLE linked_gateway_bill ADD COLUMN recon_bill_biz_id TEXT;');
      db.exec("UPDATE linked_gateway_bill SET recon_bill_biz_id = TRIM(json_extract(raw_json, '$.ReconBillBizId'));");
      const delEmpty = db.prepare("DELETE FROM linked_gateway_bill WHERE recon_bill_biz_id IS NULL OR recon_bill_biz_id = ''").run().changes;
      const delDup = db.prepare('DELETE FROM linked_gateway_bill WHERE id NOT IN (SELECT MAX(id) FROM linked_gateway_bill GROUP BY recon_bill_biz_id)').run().changes;
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_gateway_bill_biz ON linked_gateway_bill(recon_bill_biz_id);');
      if (delEmpty || delDup) {
        appendModuleLog({
          level: 'warning',
          source: 'main',
          domain: 'migration',
          message: '[migration v3.0.1] linked_gateway_bill 幂等键迁移：建 UNIQUE 前清洗存量（资金数据不可逆删除）',
          details: [`删除空键行 ${delEmpty} 条`, `删除重复键旧行 ${delDup} 条`]
        });
        // v3.0.1 PR#68 Finding2 修复：清洗删除后同步 linked_table_meta（否则 row-count/日期范围/C3 就绪判断读旧 meta）。
        //   口径对齐仓储 recomputeGatewayMeta：rowCount=COUNT(*) 全表（含 null 日期行）；日期范围=MIN/MAX(bill_date) 排除 null/空串。
        //   不 import linked-table-repository（避免 migrations.js 耦合），用内联 SQL。UPDATE 对「无 gateway-bill meta 行」是 no-op，安全。
        const gwRowCount = Number(db.prepare('SELECT COUNT(*) AS c FROM linked_gateway_bill').get().c) || 0;
        const gwRange = db.prepare("SELECT MIN(bill_date) AS mn, MAX(bill_date) AS mx FROM linked_gateway_bill WHERE bill_date IS NOT NULL AND bill_date != ''").get();
        db.prepare("UPDATE linked_table_meta SET row_count = ?, data_date_min = ?, data_date_max = ? WHERE table_key = 'gateway-bill'")
          .run(gwRowCount, gwRange && gwRange.mn != null ? gwRange.mn : null, gwRange && gwRange.mx != null ? gwRange.mx : null);
      }
    }
    if (!hasColumn(db, 'linked_gateway_bill', 'source_dataset_id')) {
      db.exec('ALTER TABLE linked_gateway_bill ADD COLUMN source_dataset_id TEXT;');
    }
    if (!hasColumn(db, 'linked_gateway_bill', 'source_task_run_id')) {
      db.exec('ALTER TABLE linked_gateway_bill ADD COLUMN source_task_run_id TEXT;');
    }
    if (!hasColumn(db, 'linked_gateway_bill', 'source_contract_version')) {
      db.exec(`
        ALTER TABLE linked_gateway_bill ADD COLUMN source_contract_version INTEGER NOT NULL DEFAULT 0
          CHECK (source_contract_version IN (0, 1));
      `);
    }
    if (!hasColumn(db, 'linked_gateway_bill', 'source_write_nonce')) {
      db.exec('ALTER TABLE linked_gateway_bill ADD COLUMN source_write_nonce TEXT;');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_linked_gateway_bill_source_dataset
        ON linked_gateway_bill(source_dataset_id)
        WHERE source_dataset_id IS NOT NULL AND source_dataset_id <> '';
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_linked_gateway_bill_legacy_source_invalidate
      AFTER UPDATE OF reconciliation_id, bill_date, raw_json, imported_at ON linked_gateway_bill
      WHEN OLD.source_contract_version = 1
       AND NEW.source_write_nonce IS OLD.source_write_nonce
      BEGIN
        UPDATE linked_gateway_bill
        SET source_dataset_id = NULL,
            source_task_run_id = NULL,
            source_contract_version = 0
        WHERE id = NEW.id;
      END;
    `);

    // 残留旧列名迁移：中间 beta 构建曾用 business_date，已改名 transaction_date；
    //   CREATE TABLE IF NOT EXISTS 不迁移已存在表 → 显式 RENAME（幂等：仅旧列在 ∧ 新列不在时执行）。
    if (hasColumn(db, 'linked_mid_allocation', 'business_date')
        && !hasColumn(db, 'linked_mid_allocation', 'transaction_date')) {
      db.exec('ALTER TABLE linked_mid_allocation RENAME COLUMN business_date TO transaction_date;');
    }

    // 数据表 2：中台调拨订单（键 allocation_no / 日期 transaction_date，列名已对齐「交易时间」）
    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_mid_allocation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_no TEXT,
        transaction_date TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_mid_allocation_no ON linked_mid_allocation(allocation_no);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_mid_allocation_date ON linked_mid_allocation(transaction_date);');

    // 数据表 3：外汇交割表（键 transaction_no / 日期 transaction_date）
    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_fx_settlement (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_no TEXT,
        transaction_date TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_fx_settlement_no ON linked_fx_settlement(transaction_no);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_fx_settlement_date ON linked_fx_settlement(transaction_date);');

    // v3.0.5 需求2：外汇交割表「按交易编号幂等累加」——回填幂等键列 transaction_no + UNIQUE 索引（仿 v3.0.1 网关 / 需求1 bank-deposit 段）。
    //   🔴🔴 资金红线（spec R-7 / TechDoc A-2）：交易编号唯一性仅单文件单日（20260513）证实；建 UNIQUE 前必须清洗存量
    //     （删空键 + 去重保留 id 最大），否则 CREATE UNIQUE INDEX 在存量空键/重复键上抛错 → 整个 ensureLinkedTableSupport 事务
    //     ROLLBACK → 资金模块启动失败。去重保留 id 最大 = 同键真撞则保留最新；delDup>0 即异常信号（需人工核对是否合法重复交易编号）。
    //   ⚠️ 现状 transaction_no 列本就存在（建表即有，:2894），不能用 hasColumn 守卫；用「UNIQUE 索引是否已存在」作幂等守卫
    //     （PRAGMA index_list 查 idx_linked_fx_settlement_txn_uniq）——仅首次（无 UNIQUE 索引）执行回填+清洗+建 UNIQUE，二次启动跳过。
    //   ⚠️ 与 bank-deposit（SQL TRIM(json_extract)）不同：fx「交易编号」是 number 类型（9 位纯数字），SQL json_extract 取数有量纲歧义
    //     （TechDoc 决策5）→ fx 体量小（spec §1.6 单文件覆盖产物），走 JS 层全表读 + normalizeTransactionNo 归一回填更稳；
    //     与仓储 upsert 幂等键 normalizeTransactionNo(交易编号) / builder 派生分组同口径（单一真相 engine-utils，防漂移）。
    //   ⚠️ 新建 UNIQUE 索引须用不同名（idx_linked_fx_settlement_txn_uniq）——现状已有普通索引 idx_linked_fx_settlement_no（:2900），
    //     不复用旧名（CREATE UNIQUE INDEX IF NOT EXISTS 对已存在同名普通索引 no-op，不会升级为 UNIQUE）。
    const fxUniqueExists = db.prepare("PRAGMA index_list('linked_fx_settlement')")
      .all()
      .some((i) => i.name === 'idx_linked_fx_settlement_txn_uniq');
    if (!fxUniqueExists) {
      // JS 层全表读重算键列：交易编号 number 须经 normalizeTransactionNo（String 化 + 纯数字判定，归一为空覆盖合计/页脚行）。
      const fxAll = db.prepare('SELECT id, raw_json FROM linked_fx_settlement ORDER BY id ASC').all();
      const fxUpd = db.prepare('UPDATE linked_fx_settlement SET transaction_no = ? WHERE id = ?');
      for (const r of fxAll) {
        let key = '';
        try { const o = JSON.parse(r.raw_json); key = normalizeTransactionNo(o && o['交易编号']); } catch (_e) { key = ''; }
        fxUpd.run(key, r.id);
      }
      // 删空键（归一为空 = 合计/页脚/非数字行，与新导入空键拒入同口径）→ 去重保留 id 最大（最新）。
      const fxDelEmpty = db.prepare("DELETE FROM linked_fx_settlement WHERE transaction_no IS NULL OR transaction_no = ''").run().changes;
      const fxDelDup = db.prepare('DELETE FROM linked_fx_settlement WHERE id NOT IN (SELECT MAX(id) FROM linked_fx_settlement GROUP BY transaction_no)').run().changes;
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_fx_settlement_txn_uniq ON linked_fx_settlement(transaction_no);');
      if (fxDelEmpty || fxDelDup) {
        appendModuleLog({
          level: 'warning',
          source: 'main',
          domain: 'migration',
          message: '[migration v3.0.5] linked_fx_settlement 幂等键迁移：建 UNIQUE 前清洗存量（资金数据不可逆删除）',
          details: [`删除空键行 ${fxDelEmpty} 条`, `删除重复键旧行 ${fxDelDup} 条`]
        });
        // 清洗删除后同步 linked_table_meta（口径对齐仓储 recomputeLinkedMeta：rowCount=COUNT(*) 全表；日期范围 MIN/MAX(transaction_date) 排除 null/空串）。
        //   不 import linked-table-repository（避免 migrations.js 耦合），用内联 SQL。UPDATE 对「无 fx-settlement meta 行」是 no-op，安全。
        const fxRowCount = Number(db.prepare('SELECT COUNT(*) AS c FROM linked_fx_settlement').get().c) || 0;
        const fxRange = db.prepare("SELECT MIN(transaction_date) AS mn, MAX(transaction_date) AS mx FROM linked_fx_settlement WHERE transaction_date IS NOT NULL AND transaction_date != ''").get();
        db.prepare("UPDATE linked_table_meta SET row_count = ?, data_date_min = ?, data_date_max = ? WHERE table_key = 'fx-settlement'")
          .run(fxRowCount, fxRange && fxRange.mn != null ? fxRange.mn : null, fxRange && fxRange.mx != null ? fxRange.mx : null);
      }
    }

    // 注：linked_fx_option（外汇期权）模板缺失，本批次不建表；待模板到位后在此处增量补一张表。

    // 数据表 4：银行对账单入金表（v2.1.16-beta.3 ②；键 reconciliation_id / 日期 bill_date）
    //   存银行对账单 C~N 列 + FundType 共 13 字段 raw_json（裁列在 main.js handler 完成；本表与现有 3 张同构）。
    //   ChannelOrderNo 不单独建索引（PRD §2.3：下游 JPM-US 匹配量小走内存，索引留待 ③ 引擎评估）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_bank_deposit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reconciliation_id TEXT,
        bill_date TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_bank_deposit_recon ON linked_bank_deposit(reconciliation_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_bank_deposit_date ON linked_bank_deposit(bill_date);');

    // v3.0.5 需求1：银行对账单入金表「按 BizId 幂等累加」——新增幂等键列 biz_id + UNIQUE 索引（仿 v3.0.1 网关段）。
    //   幂等：仅 biz_id 列不存在时执行整块（ALTER + 回填 + 存量清洗 + 建 UNIQUE）；升级后 / 新建库首启一次，
    //     后续启动列已存在即跳过（与上方 gateway recon_bill_biz_id 守卫范式一致）。
    //   🔴🔴 资金红线（spec R-1/R-6）：65.7 万行存量表，全程 SQL 侧（不可 JS 全表读 OOM）；建 UNIQUE 前必须清洗存量，
    //     否则 CREATE UNIQUE INDEX 在存量空键/重复键上抛错 → 整个 ensureLinkedTableSupport 事务 ROLLBACK → 资金模块启动失败。
    //     清洗策略（OPEN-1 同 gateway 口径）：空键行直接删（与新导入空键拒入同口径）；重复键保留最大 id（最新导入）。
    //     资金数据不可逆删除 → appendModuleLog（warning）记录删除行数（禁直接 console.*：架构守护 v2.1.9-sr-log-1 Case 6）。
    //   口径：回填用 TRIM(json_extract(...,'$.BizId')) 与 linked-table-repository.normalizeKey（String().trim()）字节一致，
    //     防存量行键与后续 upsert 键漂移（精确大小写 BizId = BANK_DEPOSIT_FIELDS[0]，自 13 字段时代即在白名单）。
    //   ⚠️ 新建 UNIQUE 索引须用不同名（idx_linked_bank_deposit_biz）——现状已有普通索引 idx_linked_bank_deposit_recon（reconciliation_id），
    //     不复用旧名（CREATE UNIQUE INDEX IF NOT EXISTS 对已存在同名普通索引 no-op，不会升级为 UNIQUE）。
    if (!hasColumn(db, 'linked_bank_deposit', 'biz_id')) {
      db.exec('ALTER TABLE linked_bank_deposit ADD COLUMN biz_id TEXT;');
      db.exec("UPDATE linked_bank_deposit SET biz_id = TRIM(json_extract(raw_json, '$.BizId'));");
      const delEmpty = db.prepare("DELETE FROM linked_bank_deposit WHERE biz_id IS NULL OR biz_id = ''").run().changes;
      const delDup = db.prepare('DELETE FROM linked_bank_deposit WHERE id NOT IN (SELECT MAX(id) FROM linked_bank_deposit GROUP BY biz_id)').run().changes;
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_bank_deposit_biz ON linked_bank_deposit(biz_id);');
      if (delEmpty || delDup) {
        appendModuleLog({
          level: 'warning',
          source: 'main',
          domain: 'migration',
          message: '[migration v3.0.5] linked_bank_deposit 幂等键迁移：建 UNIQUE 前清洗存量（资金数据不可逆删除）',
          details: [`删除空键行 ${delEmpty} 条`, `删除重复键旧行 ${delDup} 条`]
        });
        // 清洗删除后同步 linked_table_meta（否则 row-count/日期范围读旧 meta）。
        //   口径对齐仓储 recomputeLinkedMeta：rowCount=COUNT(*) 全表（含 null 日期行）；日期范围=MIN/MAX(bill_date) 排除 null/空串。
        //   不 import linked-table-repository（避免 migrations.js 耦合），用内联 SQL。UPDATE 对「无 bank-deposit meta 行」是 no-op，安全。
        const bdRowCount = Number(db.prepare('SELECT COUNT(*) AS c FROM linked_bank_deposit').get().c) || 0;
        const bdRange = db.prepare("SELECT MIN(bill_date) AS mn, MAX(bill_date) AS mx FROM linked_bank_deposit WHERE bill_date IS NOT NULL AND bill_date != ''").get();
        db.prepare("UPDATE linked_table_meta SET row_count = ?, data_date_min = ?, data_date_max = ? WHERE table_key = 'bank-deposit'")
          .run(bdRowCount, bdRange && bdRange.mn != null ? bdRange.mn : null, bdRange && bdRange.mx != null ? bdRange.mx : null);
      }
    }

    // v3.0.5 需求（OPEN-7 / T5a）：银行对账单入金表「跨期重复命中提醒」载体——加两列 last_hit_run / last_hit_at。
    //   语义（spec §3.6）：累加表残留的历史月份行仍参与对账，被某次对账「成功使用」（以入金表为命中来源，如 R5 场景4
    //     matchJpmUs 桥接 / refund R3/R5/R6 二跳）即记一次命中；export 成功后回写 last_hit_run（当期运行标识）+ last_hit_at（命中时间）。
    //     再次命中时若 last_hit_run 非空且 ≠ 当前运行标识 → 判「跨期重复命中」→ 提醒用户疑似历史残留漏删。
    //   键 = biz_id（OPEN-1 幂等键 = BANK_DEPOSIT_FIELDS[0]，上方已建 UNIQUE）；本批仅加列 + 读写仓储，命中回写/提醒注入在 T5b。
    //   🔴🔴 资金红线（spec 硬约束）：这两列绝不进任何 UNIQUE 索引（仅按 biz_id 单查，biz_id 已有 UNIQUE，不需为标记列额外建索引）；
    //     绝不动 raw_json（65.7 万行不可逐行重写 raw_json，标记走专用列）；upsert ON CONFLICT SET 不碰这两列
    //     （buildLinkedUpsertContext 硬编码 4 列 SET：keyColumn/dateColumn/raw_json/imported_at）→ 重导覆盖同 BizId 时 last_hit 保留不被洗。
    //   范式照抄上方 BOC orig_group_no 加列（hasColumn 守卫 + ALTER TABLE ADD COLUMN）：幂等可重入，连跑 2 次只加一次；
    //     升级后 / 新建库首启加列，二次启动列已存在即跳过；旧库升级后列存在且默认 NULL（SQLite ADD COLUMN 无默认值 → NULL）。
    if (!hasColumn(db, 'linked_bank_deposit', 'last_hit_run')) {
      db.exec('ALTER TABLE linked_bank_deposit ADD COLUMN last_hit_run TEXT;');
    }
    if (!hasColumn(db, 'linked_bank_deposit', 'last_hit_at')) {
      db.exec('ALTER TABLE linked_bank_deposit ADD COLUMN last_hit_at TEXT;');
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v2.1.16-beta.5 需求3：ADM 银行对账单链接表（隐藏表 linked_adm_bank_deposit）。
//   由银行对账单表 Channel=ADM 行派生（13 银行字段 + 6 新字段，全进 raw_json），与中台调拨订单匹配。
//   🔴 资金/数据红线说明：纯新增隐藏表，无破坏性 DDL（CREATE TABLE / INDEX IF NOT EXISTS 幂等）；
//      与现有 4 张链接表完全隔离、无调用顺序依赖；整表覆盖语义由 replaceAdmBankDeposit 仓储函数实现。
//   raw_json 存整行（与现有链接表同范式）；batch_no / channel_order_no 同时落列供 JPM 引擎按批 GROUP / 索引。
//   独立于 ensureLinkedTableSupport（不进 ALL_TABLE_KEYS，前端弹窗不可见）；在 database.js 初始化序列里紧随其后调用。
function ensureAdmBankDepositSupport(db) {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_adm_bank_deposit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reconciliation_id TEXT,
        bill_date TEXT,
        batch_no TEXT,
        channel_order_no TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_adm_bank_deposit_batch ON linked_adm_bank_deposit(batch_no);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_adm_bank_deposit_date ON linked_adm_bank_deposit(bill_date);');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v3.0.6 需求1：调拨对账单隐藏表（linked_fund_transfer_recon）。
//   由中台调拨订单（mid-allocation）经 buildFundTransferReconRows 派生（一行 → FundTransfer-in + out 两行，
//   recon 13 字段全进 raw_json），供需求2（r5-fund-transfer-recon-backfill）/ 需求3（dbs-charge）引擎读取匹配。
//   🔴 资金/数据红线说明：纯新增隐藏表，无破坏性 DDL（CREATE TABLE / INDEX IF NOT EXISTS 幂等）；
//      与现有链接表完全隔离、无调用顺序依赖；整表覆盖语义由 replaceFundTransferReconRows 仓储函数实现。
//   🔴 绝不进 ALL_TABLE_KEYS / 不写 linked_table_meta（前端弹窗不可见，与 ADM 隐藏表同范式）。
//   raw_json 存整行（数据真相）；allocation_no / fund_type / bill_date / recon_id / big_account 同时落列供索引与匹配热路径。
//   独立于 ensureLinkedTableSupport，在 database.js 初始化序列里紧随 ensureAdmBankDepositSupport 调用。
function ensureFundTransferReconSupport(db) {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_fund_transfer_recon (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_no TEXT,
        fund_type TEXT,
        bill_date TEXT,
        recon_id TEXT,
        big_account TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_lftr_alloc ON linked_fund_transfer_recon(allocation_no);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lftr_date ON linked_fund_transfer_recon(bill_date);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lftr_ftype ON linked_fund_transfer_recon(fund_type);');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v3.0.4 块 E（需求2）：BOC 链接表派生两张隐藏表（linked_boc_fx_settlement + linked_boc_bank_deposit）。
//   linked_boc_fx_settlement：外汇交割表导入后按物理行序分组派生（33+3 字段进 raw_json，热列单列）。
//   linked_boc_bank_deposit：银行对账单 Channel=BOC 行派生（提取「银行单交易编号」），供 2.5 回填。
//   🔴 资金/数据红线说明：纯新增隐藏表，无破坏性 DDL（CREATE TABLE / INDEX IF NOT EXISTS 幂等）；
//      与现有链接表完全隔离、无调用顺序依赖；整表覆盖语义由 replaceBocFxLink / replaceBocBankDeposit 仓储函数实现。
//   🔴 两表均绝不进 ALL_TABLE_KEYS / 不写 linked_table_meta（前端弹窗不可见，与 ADM 隐藏表同范式）。
//   raw_json 存整行（数据真相）；transaction_no / group_no / maturity_date / bank_txn_no 落列供索引与匹配热路径。
//   独立于 ensureLinkedTableSupport，在 database.js 初始化序列里紧随 ensureAdmBankDepositSupport 调用。
function ensureBocFxLinkSupport(db) {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_boc_fx_settlement (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_no TEXT,
        group_no TEXT,
        allocation_no TEXT,
        recon_link_id TEXT,
        maturity_date TEXT,
        source_row INTEGER,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_boc_fx_settlement_txn ON linked_boc_fx_settlement(transaction_no);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_boc_fx_settlement_group ON linked_boc_fx_settlement(group_no);');

    db.exec(`
      CREATE TABLE IF NOT EXISTS linked_boc_bank_deposit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bank_txn_no TEXT,
        reconciliation_id TEXT,
        bill_date TEXT,
        raw_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_linked_boc_bank_deposit_txn ON linked_boc_bank_deposit(bank_txn_no);');

    // v3.0.5 需求2（批次2b）：BOC 链接表「单文件内存派生 + 整表覆盖」→「增量进组 + DB 全量重匹配 + 重编号」升级。
    //   🔴🔴 资金红线（spec §3.2.2 / OPEN-3 / OPEN-5）：本块三件事——
    //     ① linked_boc_fx_settlement 加 orig_group_no 列（scan 时刻组归属，永不被 2.2/2.3 改写——
    //        现状 matchBocToMidAllocation 2.2 命中清空「分组」(boc-fx-link-builder.js:191) → 原始组号不可从现库恢复，
    //        无 orig_group_no 则全量重匹配/重编号无法把行复原到正确组）；
    //     ② transaction_no 建 UNIQUE 索引（新名，现状普通索引 idx_linked_boc_fx_settlement_txn 不复用——
    //        upsertBocFxLink 同键覆盖的 ON CONFLICT 判定列）；
    //     ③ OPEN-3：清空两张 BOC 派生表（linked_boc_fx_settlement + linked_boc_bank_deposit）——
    //        存量原始组号不可恢复（v3.0.4 新表存量极少），首启后引导用户重导外汇交割表全量恢复。
    //   🔴🔴 I3 修复（codex review）：三件事各用「独立幂等守卫」，不可把 UNIQUE 建在 hasColumn(orig_group_no) 守卫内——
    //     否则半迁移态（已有 orig_group_no 列但缺 UNIQUE 索引，如上次启动加列+清空成功但建 UNIQUE 前崩）下，
    //     hasColumn 判 true 跳过整块 → UNIQUE 永不补建 → upsertBocFxLink 的 ON CONFLICT(transaction_no) 运行时报错
    //     → fx 主表已导入但 BOC 派生失败。改为：列添加+OPEN-3清空 绑 hasColumn；UNIQUE 用 PRAGMA index_list 独立检测补建（自愈）。
    //   ⚠️ 两事务非原子（本函数自有 BEGIN/COMMIT，与 ensureLinkedTableSupport 不同事务）：任何半迁移态靠下方各独立守卫续跑兜底（spec §五 TechDoc）。

    // —— 守卫①+③：列添加 + OPEN-3 清空（绑 hasColumn——OPEN-3「加 orig_group_no 时存量原始组号不可恢复」语义即首次加列才清）——
    if (!hasColumn(db, 'linked_boc_fx_settlement', 'orig_group_no')) {
      db.exec('ALTER TABLE linked_boc_fx_settlement ADD COLUMN orig_group_no TEXT;');
      // OPEN-3：清空两张派生表（存量原始组号不可恢复，引导重导交割表全量恢复）。
      const bocFxCleared = db.prepare('DELETE FROM linked_boc_fx_settlement').run().changes;
      const bocBankCleared = db.prepare('DELETE FROM linked_boc_bank_deposit').run().changes;
      // orig_group_no 索引（全量重匹配按 orig_group_no 聚合的热列）；CREATE INDEX IF NOT EXISTS 本就幂等。
      db.exec('CREATE INDEX IF NOT EXISTS idx_linked_boc_fx_settlement_orig_group ON linked_boc_fx_settlement(orig_group_no);');
      appendModuleLog({
        level: 'warning',
        source: 'main',
        domain: 'migration',
        message: '[migration v3.0.5] BOC 派生表清空（orig_group_no 升级）：存量原始组号不可恢复，首启后请重导外汇交割表全量恢复',
        details: [`清空 linked_boc_fx_settlement ${bocFxCleared} 行`, `清空 linked_boc_bank_deposit ${bocBankCleared} 行`]
      });
    }

    // —— 守卫②：transaction_no UNIQUE 索引（🔴 独立守卫，半迁移态自愈）——
    //   用 PRAGMA index_list 检测 idx_linked_boc_fx_settlement_txn_uniq 是否已存在；缺则补建。
    //   不复用普通索引名 idx_linked_boc_fx_settlement_txn（CREATE UNIQUE IF NOT EXISTS 对已存在同名普通索引 no-op，不升级为 UNIQUE）。
    //   建 UNIQUE 前若存量已含重复 transaction_no（理论不应——OPEN-3 已清空 + upsertBocFxLink 幂等键），去重保留 id 最大兜底防建索引抛错。
    const bocFxUniqueExists = db.prepare("PRAGMA index_list('linked_boc_fx_settlement')")
      .all()
      .some((i) => i.name === 'idx_linked_boc_fx_settlement_txn_uniq');
    if (!bocFxUniqueExists) {
      const bocFxDelDup = db.prepare(
        'DELETE FROM linked_boc_fx_settlement WHERE id NOT IN (SELECT MAX(id) FROM linked_boc_fx_settlement GROUP BY transaction_no)'
      ).run().changes;
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_boc_fx_settlement_txn_uniq ON linked_boc_fx_settlement(transaction_no);');
      if (bocFxDelDup) {
        appendModuleLog({
          level: 'warning',
          source: 'main',
          domain: 'migration',
          message: '[migration v3.0.5] linked_boc_fx_settlement 建 transaction_no UNIQUE 前去重保留 id 最大（半迁移态自愈）',
          details: [`删除重复键旧行 ${bocFxDelDup} 条`]
        });
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v2.1.16-beta.3 ①：Channel 枚举字典表（纯审计沉淀，无 UI）。
//   每次导入银行对账单后去重 upsert 两类枚举值：value_type='channel'（Channel 值）/
//   'channel-region'（<Channel>-<地区> 拼接值）。供后续 ③ 中台退款回填引擎读库 + 业务审计。
//   🔴 资金/数据红线说明：纯新增审计字典表，无破坏性 DDL；只 INSERT/UPDATE 枚举字典，
//      不删除/不改写任何对账数据，非资金红线、属审计辅助。
//   value_type CHECK + (value_type, enum_value) UNIQUE 是去重 upsert 的基础，不可省。
//   幂等：CREATE TABLE / INDEX IF NOT EXISTS，多次启动 no-op；与其它模块表完全隔离、无调用顺序依赖。
function ensureChannelEnumSupport(db) {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_enum_values (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        value_type    TEXT NOT NULL CHECK (value_type IN ('channel', 'channel-region')),
        enum_value    TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        seen_count    INTEGER NOT NULL DEFAULT 1,
        UNIQUE (value_type, enum_value)
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_channel_enum_type ON channel_enum_values(value_type);');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// v3.0.12 功能2（批A）：账户映射管理 — 全局对照表「中台调拨单账户号 → 清结算系统银行账号」。
//   全局表（非 per-template；调拨/链接表是全局概念，与 account_mappings 的 per-template 语义不同）。
//   🔴 风险敏感：纯新增表，幂等 CREATE TABLE IF NOT EXISTS，无破坏性 DDL、无回填（映射本就用户新配）。
//   UNIQUE(mid_account_id)：一个中台调拨单账户号只能映射一个清结算银行账号（仓储 saveMappings 整表重建语义托底）。
//   批B 才把映射喂给调拨对账派生（buildFundTransferReconRows）；本批仅建表 + CRUD + UI，对账暂不消费。
function ensureFundTransferAccountMappingSupport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fund_transfer_account_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mid_account_id TEXT NOT NULL,            -- 中台调拨单账户号（归一化后）
      clearing_account_id TEXT NOT NULL,       -- 清结算系统银行账号（归一化后）
      row_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(mid_account_id)
    );
  `);
}

// v3.0.14：前置资金对账 run 元数据镜像。
// 明细、候选池和结果保存在 per-month side DB；主库只保留轻量状态、汇总和侧库相对路径，
// 供运行审计与侧库丢失检测使用。side_run_id 属于侧库内部命名空间。
function ensurePreFundReconciliationRunMetadataSupport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pre_fund_reconciliation_run_mirrors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      side_run_id INTEGER NOT NULL,
      scenario TEXT NOT NULL,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      snapshot_hash TEXT NOT NULL,
      bank_files_json TEXT NOT NULL DEFAULT '[]',
      side_db_rel_path TEXT NOT NULL,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      archive_contract_version INTEGER NOT NULL DEFAULT 0
        CHECK (archive_contract_version IN (0, 1)),
      archive_task_run_id TEXT,
      archive_terminal_ack_at TEXT
    );
  `);
  if (!hasColumn(db, 'pre_fund_reconciliation_run_mirrors', 'archive_contract_version')) {
    db.exec(`
      ALTER TABLE pre_fund_reconciliation_run_mirrors
      ADD COLUMN archive_contract_version INTEGER NOT NULL DEFAULT 0
        CHECK (archive_contract_version IN (0, 1));
    `);
  }
  if (!hasColumn(db, 'pre_fund_reconciliation_run_mirrors', 'archive_task_run_id')) {
    db.exec('ALTER TABLE pre_fund_reconciliation_run_mirrors ADD COLUMN archive_task_run_id TEXT;');
  }
  if (!hasColumn(db, 'pre_fund_reconciliation_run_mirrors', 'archive_terminal_ack_at')) {
    db.exec('ALTER TABLE pre_fund_reconciliation_run_mirrors ADD COLUMN archive_terminal_ack_at TEXT;');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pre_fund_run_mirrors_status
      ON pre_fund_reconciliation_run_mirrors(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pre_fund_run_mirrors_side_run
      ON pre_fund_reconciliation_run_mirrors(month_key, side_run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_fund_run_mirrors_archive_task
      ON pre_fund_reconciliation_run_mirrors(archive_task_run_id)
      WHERE archive_contract_version = 1
        AND archive_task_run_id IS NOT NULL AND archive_task_run_id <> '';
  `);
}

// v3.0.15：重复入金匹配主库仅保存运行镜像，不保存银行明细、姓名或卡号。
// side_run_id 与 side_db_rel_path 指向当前启动周期的独立侧库；重启后镜像会标记 expired。
function ensureDuplicateInboundMatchRunMetadataSupport(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS duplicate_inbound_match_run_mirrors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      side_run_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      snapshot_hash TEXT NOT NULL,
      bank_file_name TEXT NOT NULL,
      bank_file_hash TEXT NOT NULL,
      document_file_name TEXT NOT NULL DEFAULT '',
      document_file_hash TEXT NOT NULL DEFAULT '',
      side_db_rel_path TEXT NOT NULL,
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_duplicate_inbound_run_mirrors_status
      ON duplicate_inbound_match_run_mirrors(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_duplicate_inbound_run_mirrors_side_run
      ON duplicate_inbound_match_run_mirrors(month_key, side_run_id);
  `);
  if (!hasColumn(db, 'duplicate_inbound_match_run_mirrors', 'document_file_name')) {
    db.exec("ALTER TABLE duplicate_inbound_match_run_mirrors ADD COLUMN document_file_name TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'duplicate_inbound_match_run_mirrors', 'document_file_hash')) {
    db.exec("ALTER TABLE duplicate_inbound_match_run_mirrors ADD COLUMN document_file_hash TEXT NOT NULL DEFAULT ''");
  }
}

module.exports = {
  ensureAccountMappingCurrencySupport,
  ensureAccountMappingTemplateSupport,
  ensureAcquiringBillCurrencyTablesSupport,
  // v3.0.3 PR-B（acquiring-import-recon-perf P0-3）：收单两表索引瘦身 + covering 升级（老库迁移；新库由建表段直接建 v2）
  ensureAcquiringBillCurrencyIndexSlimV2,
  ensureAmountSplitRulesSupport,
  ensureBankBuReconTablesSupport,
  // v2.1.12 需求1 T-vcc-1：VCC业务OP计算模块 2 张表 + 2 索引
  ensureVccOpCalcTablesSupport,
  ensureBillSplitMergeSupport,
  ensureBillSplitTargetSeqSupport,
  ensureParentTemplateSupport,
  ensureScenariosSupport,
  ensureScenariosCategoryReconIdFix,
  ensureScenariosCategoryGatewayReconIdFix,
  migrateGatewayReconIdFixFieldPairs,
  migrateC4ReconGroupsStructure,
  migrateC4ReconGroupsAmountLockedFieldPair,
  ensureC3GwFieldCurrencyCaseRevert,
  ensureC3AssignAddMode,
  ensureAcquiringBillCurrencyRunsCleanupPending,
  ensureAcquiringBillIdleCleanupMinutesSetting,
  // v2.1.10 A4 T18 / T19：chunked 分批 size settings + runs.chunk_progress 列 migration
  ensureAcquiringBillChunkSizeSetting,
  // v2.1.12 β.1-T3：多 worker write-splitting worker 数 settings seed（D29/D33）
  ensureAcquiringBillWorkerCountSetting,
  ensureAcquiringBillCurrencyRunsChunkProgress,
  ensureAcquiringBillCurrencyRunsSideDbPath,
  // v3.0.5 PR-4（Part B Phase 2）：bank-bu / biz-op runs 表加 side_db_rel_path 列（侧库镜像）
  ensureBankBuReconRunsSideDbPath,
  ensureBizOpReconRunsSideDbPath,
  // v2.1.10 N4-cont-1 T22 (Phase 4)：raw_json idle 自动清理保留窗口 settings（v0.2 单键）
  ensureAcquiringBillCurrencyRawJsonRetentionSettings,
  ensureBillRawJsonV2Slim,
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureSchemaV2_1_9_N5,
  // v2.1.9 SR-FIX-1 (spec §16.3)：scenarios.name UNIQUE 全表 → (channel_id, name) 复合
  ensureScenariosNameUniqueByChannelId,
  // v2.1.13 D-3/D-4：自带写死场景 builtin-fixed 数据层迁移
  ensureScenariosCategoryBuiltinFixed,
  ensureBuiltinFixedScenarioNameUpdate,
  ensureBuiltinFixedScenarioMigration,
  ensureScenarioApplicableChannelsTable,
  // v2.1.16-beta.2 §8：5 轮对账 R4/R5 内置场景 seed（5 R4 + 2 R5，🔴 资金红线）
  ensureReconRoundBuiltinScenariosSeed,
  // v3.1.1：canonical 调拨回填 owner 幂等恢复 + 全渠道归一（不覆盖已有单 owner 配置）
  ensureFundTransferBackfillCanonicalOwner,
  // 测试/契约复用：恢复 owner 必须与当前完整 seed 深相等
  FUND_TRANSFER_BACKFILL_CANONICAL_SEED,
  // v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（默认休眠 enabled=0，独立 marker 绕开全局 marker 短路）
  ensureRefundBackfillScenarioSeed,
  // v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（默认休眠 enabled=0，独立 marker；category=gateway-recon-id-fix）
  ensureJpmDispatchOrderScenarioSeed,
  // v3.0.4 块 E 需求1：BOC 调拨订单修复写死场景独立补种（默认休眠 enabled=0，独立 marker；category=gateway-recon-id-fix）
  ensureBocDispatchOrderScenarioSeed,
  // v3.0.6 需求3（T9）：DBS-Charge 资金校验写死场景独立补种（默认 enabled=1，独立 marker；category=builtin-fixed → R3.5）
  ensureDbsChargeFundCheckScenarioSeed,
  // v3.0.6 需求3（T9）：每次启动幂等 DELETE 已废弃 charge-outbound 内置孤儿（含级联删关联表，无 marker；🔴 资金红线 + 破坏性）
  retireChargeOutboundOrphans,
  // v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'（🔴 资金红线）
  ensureFundTypeAchReturnConfigMigration,
  // v3.0.10 需求1：R4 方向守卫 config 字段补种（无 marker 每次启动幂等补缺失 requireBankZeroField，绝不覆盖用户值；🔴 资金红线）
  ensureR4DirectionGuardConfigMigration,
  // v3.0.23：幂等刷新四个内置 R4 场景固定严格匹配说明（只改 config.function）
  ensureR4StrictDescriptionMigration,
  R4_STRICT_FUNCTION_BY_SUBCATEGORY,
  // v2.1.10 N4-cont-2：diff_rows 2 FK 加 ON DELETE CASCADE（🔴 资金红线 + 不可逆 DB schema）
  ensureDiffRowsCascadeMigration_v2_1_10,
  // v2.1.16 阶段一 A3：链接表持久化（meta + 3 张数据表，期权表模板缺失暂不建）
  //   v2.1.16-beta.3 ②：事务内追加 linked_bank_deposit（入金表）+ recon/date 两索引
  ensureLinkedTableSupport,
  // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表（紧随 linked 表，独立幂等迁移函数）
  ensureAdmBankDepositSupport,
  // v3.0.6 需求1：调拨对账单隐藏表（紧随 ADM 表，独立幂等迁移；不进 ALL_TABLE_KEYS）
  ensureFundTransferReconSupport,
  // v3.0.4 块 E 需求2：BOC 链接表两张隐藏表（紧随 ADM 表，独立幂等迁移；不进 ALL_TABLE_KEYS）
  ensureBocFxLinkSupport,
  // v2.1.16-beta.3 ①：Channel 枚举字典表（纯审计沉淀，独立迁移函数）
  ensureChannelEnumSupport,
  // v3.0.12 功能2（批A）：账户映射管理全局表（中台调拨单账户号 → 清结算系统银行账号；幂等建表，不进 ALL_TABLE_KEYS）
  ensureFundTransferAccountMappingSupport,
  ensurePreFundReconciliationRunMetadataSupport,
  ensureDuplicateInboundMatchRunMetadataSupport,
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
