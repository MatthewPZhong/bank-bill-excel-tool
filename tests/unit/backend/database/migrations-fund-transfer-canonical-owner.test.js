'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  FUND_TRANSFER_BACKFILL_CANONICAL_SEED,
  ensureBuiltinFixedScenarioMigration,
  ensureBuiltinFixedScenarioNameUpdate,
  ensureFundTransferBackfillCanonicalOwner,
  ensureReconRoundBuiltinScenariosSeed,
  ensureScenarioApplicableChannelsTable,
  ensureScenariosCategoryBuiltinFixed,
  ensureScenariosCategoryGatewayReconIdFix,
  ensureScenariosCategoryReconIdFix,
  ensureScenariosNameUniqueByChannelId,
  ensureScenariosSupport,
  ensureSchemaV2_1_9_N5
} = require('../../../../src/backend/database/migrations');
const { createBackup } = require('../../../../src/backend/database/backup');
const channelsRepository = require('../../../../src/backend/database/channels-repository');

let db;
let tmpDir;
let backupDir;

function backupFn(label) {
  return createBackup(db, label, backupDir);
}

function bootstrapReady() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureScenariosSupport(db);
  ensureScenariosCategoryReconIdFix(db);
  ensureScenariosCategoryGatewayReconIdFix(db);
  ensureSchemaV2_1_9_N5(db, backupFn);
  ensureScenariosNameUniqueByChannelId(db, backupFn);
  ensureScenariosCategoryBuiltinFixed(db);
  ensureBuiltinFixedScenarioNameUpdate(db);
  ensureBuiltinFixedScenarioMigration(db);
  ensureScenarioApplicableChannelsTable(db);
}

function getOwners() {
  return db.prepare(`
    SELECT *
      FROM scenarios
     WHERE category = 'builtin-fixed'
       AND is_builtin = 1
       AND config_json LIKE '%"funcCategory":"platform-order"%'
       AND config_json LIKE '%"subCategory":"fund-transfer-backfill"%'
     ORDER BY id ASC
  `).all();
}

function insertOrdinaryNameConflict(name) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO scenarios
      (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES ('offset-bill-mark', ?, 0, 0, '{}', 0, 1, ?, ?)
  `).run(name, now, now);
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-transfer-owner-'));
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(path.join(tmpDir, 'test.sqlite'));
  db.exec('PRAGMA foreign_keys = ON;');
  bootstrapReady();
});

test.afterEach(() => {
  if (db) {
    try { db.close(); } catch (_error) {}
    db = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

test.describe('ensureFundTransferBackfillCanonicalOwner', () => {
  test('fresh seed 保持兼容 enabled=1、使用完整 config/通用渠道，并清空历史适用渠道', () => {
    ensureReconRoundBuiltinScenariosSeed(db);
    let owner = getOwners()[0];
    assert.ok(owner);
    assert.equal(owner.enabled, 1);
    assert.equal(owner.channel_id, 1);
    assert.deepEqual(
      JSON.parse(owner.config_json),
      FUND_TRANSFER_BACKFILL_CANONICAL_SEED.config
    );

    const extraChannel = channelsRepository.createChannel(db, {
      name: 'DBS',
      ownerLocation: 'SG'
    });
    db.prepare(
      'INSERT INTO scenario_applicable_channels (scenario_id, channel_id) VALUES (?, ?)'
    ).run(owner.id, extraChannel.id);

    const result = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(result.status, 'owner-present');
    assert.equal(result.ownerId, owner.id);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM scenario_applicable_channels WHERE scenario_id = ?')
        .get(owner.id).count,
      0
    );
  });

  test('已有单 owner 不覆盖用户启停、名称、优先级或 config', () => {
    ensureReconRoundBuiltinScenariosSeed(db);
    const owner = getOwners()[0];
    const customConfig = {
      ...FUND_TRANSFER_BACKFILL_CANONICAL_SEED.config,
      dateMatchEnabled: false,
      dateToleranceDays: 17,
      function: '用户自定义的调拨回填说明，必须保留',
      customAuditNote: 'keep-me'
    };
    db.prepare(`
      UPDATE scenarios
         SET name = '用户保留名称',
             priority = 3,
             enabled = 1,
             config_json = ?
       WHERE id = ?
    `).run(JSON.stringify(customConfig), owner.id);

    const result = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(result.status, 'owner-present');
    const after = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(owner.id);
    assert.equal(after.name, '用户保留名称');
    assert.equal(after.priority, 3);
    assert.equal(after.enabled, 1);
    assert.deepEqual(JSON.parse(after.config_json), customConfig);
  });

  test('仅将精确等于旧系统默认值的 function 幂等更新为当前配置化说明', () => {
    ensureReconRoundBuiltinScenariosSeed(db);
    const owner = getOwners()[0];
    const legacyFunction =
      '网关 FundTransfer-out/in 与 R4 后银行同向行按商户/币种/发生额绝对值/日期(同日优先,±1日兜底)1v1 匹配，命中后把网关 reconciliationid 回填进银行 ReconciliationId。';
    const legacyConfig = {
      ...FUND_TRANSFER_BACKFILL_CANONICAL_SEED.config,
      function: legacyFunction,
      dateMatchEnabled: false,
      dateToleranceDays: 17,
      customAuditNote: 'keep-everything-else',
      customNested: { enabled: true, values: ['A', 'B'] }
    };
    db.prepare('UPDATE scenarios SET config_json = ? WHERE id = ?')
      .run(JSON.stringify(legacyConfig), owner.id);

    const first = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(first.status, 'owner-present');
    const afterFirst = db.prepare('SELECT config_json, updated_at FROM scenarios WHERE id = ?')
      .get(owner.id);
    const migratedConfig = JSON.parse(afterFirst.config_json);
    assert.equal(
      migratedConfig.function,
      FUND_TRANSFER_BACKFILL_CANONICAL_SEED.config.function
    );
    assert.deepEqual(
      { ...migratedConfig, function: legacyFunction },
      legacyConfig,
      '除精确旧系统 function 外的全部 config 必须原样保留'
    );

    const second = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(second.status, 'owner-present');
    const afterSecond = db.prepare('SELECT config_json, updated_at FROM scenarios WHERE id = ?')
      .get(owner.id);
    assert.equal(afterSecond.config_json, afterFirst.config_json);
    assert.equal(afterSecond.updated_at, afterFirst.updated_at);
  });

  test('owner 缺失时从当前完整 seed 深拷贝恢复，默认 disabled；重复执行幂等', () => {
    ensureReconRoundBuiltinScenariosSeed(db);
    db.prepare('DELETE FROM scenarios WHERE id = ?').run(getOwners()[0].id);

    const first = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(first.status, 'owner-restored');
    let owners = getOwners();
    assert.equal(owners.length, 1);
    assert.equal(owners[0].enabled, 0);
    assert.equal(owners[0].name, FUND_TRANSFER_BACKFILL_CANONICAL_SEED.name);
    assert.deepEqual(JSON.parse(owners[0].config_json), FUND_TRANSFER_BACKFILL_CANONICAL_SEED.config);

    const second = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(second.status, 'owner-present');
    owners = getOwners();
    assert.equal(owners.length, 1);
    assert.equal(owners[0].id, first.ownerId);
  });

  test('预定名称冲突时使用固定恢复名；两个名称都冲突则保留 owner=0', () => {
    insertOrdinaryNameConflict(FUND_TRANSFER_BACKFILL_CANONICAL_SEED.name);
    const fallback = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(fallback.status, 'owner-restored');
    assert.equal(fallback.ownerName, '调拨回填功能管理（系统恢复）');
    assert.equal(getOwners().length, 1);

    db.prepare('DELETE FROM scenarios WHERE id = ?').run(fallback.ownerId);
    insertOrdinaryNameConflict('调拨回填功能管理（系统恢复）');
    const blocked = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(blocked.status, 'missing-name-conflict');
    assert.equal(blocked.ownerCount, 0);
    assert.equal(getOwners().length, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM scenarios WHERE is_builtin = 0').get().count >= 2,
      true
    );
  });

  test('多 owner 不自动合并或删除，并清空各自历史适用渠道', () => {
    ensureReconRoundBuiltinScenariosSeed(db);
    const first = getOwners()[0];
    const now = new Date().toISOString();
    const inserted = db.prepare(`
      INSERT INTO scenarios
        (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('builtin-fixed', '重复调拨 owner', 0, 0, ?, 1, 1, ?, ?)
    `).run(JSON.stringify(FUND_TRANSFER_BACKFILL_CANONICAL_SEED.config), now, now);
    const secondId = Number(inserted.lastInsertRowid);
    const extraChannel = channelsRepository.createChannel(db, {
      name: 'MAYBANK',
      ownerLocation: 'MY'
    });
    const insertApplicable = db.prepare(
      'INSERT INTO scenario_applicable_channels (scenario_id, channel_id) VALUES (?, ?)'
    );
    insertApplicable.run(first.id, extraChannel.id);
    insertApplicable.run(secondId, extraChannel.id);

    const result = ensureFundTransferBackfillCanonicalOwner(db);
    assert.equal(result.status, 'duplicate-owner');
    assert.deepEqual(result.ownerIds, [Number(first.id), secondId]);
    assert.equal(getOwners().length, 2);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM scenario_applicable_channels').get().count,
      0
    );
  });
});
