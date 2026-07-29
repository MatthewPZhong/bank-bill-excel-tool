'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const scenariosRepository = require('../../../../src/backend/database/scenarios-repository');
const channelsRepository = require('../../../../src/backend/database/channels-repository');
const {
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

let db;
let tmpDir;
let backupDir;
let owner;
let targetChannel;

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
  ensureReconRoundBuiltinScenariosSeed(db);
  ensureFundTransferBackfillCanonicalOwner(db);
}

function reservedConfig(overrides = {}) {
  return {
    funcCategory: 'platform-order',
    subCategory: 'fund-transfer-backfill',
    roundPhase: 5,
    directions: [
      { gwTradeType: 'FundTransfer-out', bankFundType: 'FundTransfer-out' },
      { gwTradeType: 'FundTransfer-in', bankFundType: 'FundTransfer-in' }
    ],
    dateMatchEnabled: true,
    dateToleranceDays: 1,
    ...overrides
  };
}

function makeOrdinaryPayload(name) {
  return {
    category: 'offset-bill-mark',
    name,
    priority: 0,
    enabled: true,
    config: { billTypes: [], reconFields: [], markValue: null },
    channelId: 1
  };
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-owner-repo-'));
  backupDir = path.join(tmpDir, 'backups');
  db = new DatabaseSync(path.join(tmpDir, 'test.sqlite'));
  db.exec('PRAGMA foreign_keys = ON;');
  bootstrapReady();
  owner = scenariosRepository.listScenarios(db)
    .map((item) => scenariosRepository.getScenario(db, item.id))
    .find((scenario) => scenario
      && scenario.isBuiltin
      && scenario.category === 'builtin-fixed'
      && scenario.config
      && scenario.config.funcCategory === 'platform-order'
      && scenario.config.subCategory === 'fund-transfer-backfill');
  targetChannel = channelsRepository.createChannel(db, {
    name: 'DBS',
    ownerLocation: 'SG'
  });
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

test.describe('canonical owner public write protection', () => {
  test('public create 拒绝 isBuiltin=true，也拒绝非内置保留签名克隆', () => {
    assert.throws(
      () => scenariosRepository.createScenario(db, {
        ...makeOrdinaryPayload('伪造内置'),
        isBuiltin: true
      }),
      /不允许设置 isBuiltin=true/
    );
    assert.throws(
      () => scenariosRepository.createScenario(db, {
        category: 'builtin-fixed',
        name: '伪调拨回填',
        priority: 0,
        enabled: false,
        config: reservedConfig(),
        channelId: 1
      }),
      /保留签名/
    );
  });

  test('owner 允许启停和日期配置更新，但禁止身份漂移', () => {
    const toggled = scenariosRepository.toggleScenarioEnabled(db, owner.id, true);
    assert.equal(toggled.enabled, true);
    const nextConfig = {
      ...owner.config,
      dateMatchEnabled: false,
      dateToleranceDays: 9
    };
    assert.doesNotThrow(() => {
      scenariosRepository.updateScenario(db, owner.id, { config: nextConfig });
    });
    assert.equal(scenariosRepository.getScenario(db, owner.id).config.dateToleranceDays, 9);

    assert.throws(
      () => scenariosRepository.updateScenario(db, owner.id, {
        config: { ...nextConfig, subCategory: 'other' }
      }),
      /不能修改 funcCategory\/subCategory/
    );
    assert.throws(
      () => scenariosRepository.updateScenario(db, owner.id, { isBuiltin: false }),
      /isBuiltin 不可修改/
    );
  });

  test('owner 单删、批删和转移均被底层仓储阻断且不产生部分写', () => {
    const ordinary = scenariosRepository.createScenario(db, makeOrdinaryPayload('普通待批删'));
    assert.throws(
      () => scenariosRepository.deleteScenario(db, owner.id),
      /禁止删除/
    );
    assert.throws(
      () => scenariosRepository.batchDelete(db, [ordinary.id, owner.id]),
      /禁止批量删除/
    );
    assert.ok(scenariosRepository.getScenario(db, ordinary.id), '批删应原子阻断，普通场景不能被部分删除');
    assert.throws(
      () => scenariosRepository.transferScenarios(db, [owner.id], targetChannel.id),
      /禁止转移银行渠道/
    );
    assert.equal(scenariosRepository.getScenario(db, owner.id).channelId, 1);
  });

  test('owner 的 set-applicable-channels 与 inTx 旁路都强制归一为空', () => {
    const result = scenariosRepository.setApplicableChannelIds(
      db,
      owner.id,
      [targetChannel.id]
    );
    assert.deepEqual(result.channelIds, []);
    assert.deepEqual(scenariosRepository.getApplicableChannelIds(db, owner.id), []);

    db.exec('BEGIN');
    const inTxResult = scenariosRepository.applyApplicableChannelIdsInTx(
      db,
      owner.id,
      [targetChannel.id]
    );
    db.exec('COMMIT');
    assert.deepEqual(inTxResult.channelIds, []);
    assert.deepEqual(scenariosRepository.getApplicableChannelIds(db, owner.id), []);
  });

  test('旧非内置保留签名冲突仍可删除；普通场景 update 不得新占用签名', () => {
    const now = new Date().toISOString();
    const inserted = db.prepare(`
      INSERT INTO scenarios
        (category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
      VALUES ('builtin-fixed', '旧非系统冲突', 0, 0, ?, 0, 1, ?, ?)
    `).run(JSON.stringify(reservedConfig()), now, now);
    const conflictId = Number(inserted.lastInsertRowid);
    assert.equal(scenariosRepository.deleteScenario(db, conflictId).deleted, true);

    const ordinary = scenariosRepository.createScenario(db, {
      category: 'builtin-fixed',
      name: '普通写死场景转保留',
      priority: 0,
      enabled: false,
      config: { funcCategory: 'other', subCategory: 'other' },
      channelId: 1
    });
    assert.throws(
      () => scenariosRepository.updateScenario(db, ordinary.id, {
        config: reservedConfig()
      }),
      /非系统场景不能占用/
    );
  });
});
