'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../src/backend/database');
const { applyScenarioBundleImport } = require('../../../src/main-process/scenarios-bundle-import');

let database;
let tmpDir;

function makeDeps() {
  return {
    db: database.db,
    listChannels: () => database.listChannels(),
    getBuiltinGeneralChannel: () => database.getBuiltinGeneralChannel(),
    createChannel: (payload) => database.createChannel(payload),
    findScenarioByChannelAndName: (channelId, name) =>
      database.findScenarioByChannelAndName(channelId, name),
    createScenario: (payload) => database.createScenario(payload),
    findChannelByNameAndLocation: (name, ownerLocation) =>
      database.findChannelByNameAndLocation(name, ownerLocation),
    setScenarioApplicableChannels: (scenarioId, channelIds) =>
      database.setScenarioApplicableChannelsInTx(scenarioId, channelIds),
    setScenarioEnabled: (scenarioId, enabled) =>
      database.toggleScenarioEnabled(scenarioId, enabled)
  };
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-bundle-ft-guard-'));
  database = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  database.init();
});

test.afterEach(() => {
  if (database && database.db) {
    try { database.db.close(); } catch (_error) {}
  }
  database = null;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

test('配置包不能克隆 fund-transfer-backfill 保留签名，也不覆盖本机 owner', () => {
  const ownerBefore = database.listScenarios()
    .map((item) => database.getScenario(item.id))
    .find((scenario) => scenario
      && scenario.isBuiltin
      && scenario.category === 'builtin-fixed'
      && scenario.config
      && scenario.config.funcCategory === 'platform-order'
      && scenario.config.subCategory === 'fund-transfer-backfill');
  assert.ok(ownerBefore);
  const beforeConfig = JSON.parse(JSON.stringify(ownerBefore.config));

  const bundle = {
    scenarioBundleVersion: 1,
    channels: [{
      name: '通用',
      ownerLocation: '通用',
      isBuiltin: 1,
      scenarios: [{
        category: 'builtin-fixed',
        name: '不同名字也不能绕过',
        sortOrder: 3,
        enabled: 1,
        configJson: {
          funcCategory: 'platform-order',
          subCategory: 'fund-transfer-backfill',
          roundPhase: 5,
          dateMatchEnabled: false,
          dateToleranceDays: 99
        },
        applicableChannelNames: [{ name: '通用', ownerLocation: '通用' }]
      }]
    }]
  };

  const result = applyScenarioBundleImport(
    bundle,
    { confirmCreateMissingChannels: false },
    makeDeps()
  );
  assert.equal(result.importedCount, 0);
  assert.deepEqual(result.conflicts, [{
    channel: '通用-通用',
    scenario: '不同名字也不能绕过',
    reason: 'reserved-signature'
  }]);
  assert.equal(
    database.listScenarios().some((scenario) => scenario.name === '不同名字也不能绕过'),
    false
  );
  const ownerAfter = database.getScenario(ownerBefore.id);
  assert.deepEqual(ownerAfter.config, beforeConfig);
});
