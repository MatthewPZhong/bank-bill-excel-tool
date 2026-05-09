const { randomUUID } = require('node:crypto');
const { normalizeText } = require('./utils');

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

module.exports = {
  ensureAccountMappingCurrencySupport,
  ensureAccountMappingTemplateSupport,
  ensureAmountSplitRulesSupport,
  ensureBillSplitMergeSupport,
  ensureBillSplitTargetSeqSupport,
  ensureParentTemplateSupport,
  ensureScenariosSupport,
  ensureScenariosCategoryReconIdFix,
  migrateC4ReconGroupsStructure,
  migrateC4ReconGroupsAmountLockedFieldPair,
  ensureC3GwFieldCurrencyCaseFix,
  ensureBuiltinScenarioNamesUpdate,
  ensureTemplateBigAccountNatureSupport,
  ensureTemplateDateFormatSupport,
  ensureTemplateFilenameFixedFieldSupport,
  ensureTemplateMappingEnhancements,
  ensureTemplateKeySupport,
  hasColumn
};
