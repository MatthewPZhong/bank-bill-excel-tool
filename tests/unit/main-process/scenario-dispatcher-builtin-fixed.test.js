// v2.1.13 D-3/D-5：builtin-fixed 自带写死场景在 dispatcher 的执行
//   覆盖：runScenario 路由（复用 C1 提取）/ 默认全部生效 / 适用渠道限定 / 空数组=全部 / 兜底语义保持
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { runAllScenarios } = require('../../../src/main-process/scenario-dispatcher');
const { runScenario } = require('../../../src/main-process/scenario-engines');
const channelsRepo = require('../../../src/backend/database/channels-repository');
const {
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureScenariosSupport
} = require('../../../src/backend/database/migrations');

let tmpDir;
let dbPath;
let db;
let channels;

function setupDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureScenariosSupport(db);
  ensureChannelsTable(db);
  ensureScenariosChannelIdColumn(db);
}

function makeDeps() {
  return { channelsRepo, db };
}

// builtin-fixed 场景（config 形态 = extractByFeature → 复用 C1 提取引擎）
function makeBuiltinFixedScenario({ id = 100, applicableChannelIds = null } = {}) {
  return {
    id,
    name: '从银行对账单的信息里提取调拨订单对账ID',
    category: 'builtin-fixed',
    priority: 0,
    enabled: true,
    channelId: 1, // 通用
    displayIndex: 1,
    _applicableChannelIds: applicableChannelIds,
    config: {
      conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
      conditionsLogic: 'OR',
      extractByFeature: { enabled: true, searchFields: ['CustomerRef'], featureCode: 'FT', digitCount: 12, totalLength: 15 },
      extractByOtherField: null
    }
  };
}

function makeBankRow({ rowId, channel, location, customerRef, recon = '' }) {
  return { _rowId: rowId, Channel: channel, 地区: location, CustomerRef: customerRef, ReconciliationId: recon };
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-bf-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  setupDb();
  channels = {
    general: channelsRepo.getBuiltinGeneral(db),
    icbc_sh: channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' }),
    cmb_bj: channelsRepo.createChannel(db, { name: '招商', ownerLocation: '北京' })
  };
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

test.describe('v2.1.13 builtin-fixed 在 dispatcher 的执行', () => {
  test('runScenario：builtin-fixed（含 extractByFeature）复用 C1 提取；缺 config 抛错', () => {
    const sc = makeBuiltinFixedScenario();
    const rows = [makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })];
    const result = runScenario(sc, rows);
    assert.ok(result.lockedRowIds && result.lockedRowIds.size >= 1, 'builtin-fixed 应通过 C1 提取命中');

    const bad = { ...makeBuiltinFixedScenario(), config: { conditions: [] } };
    assert.throws(() => runScenario(bad, rows), /builtin-fixed[\s\S]*config/);
  });

  test('默认（无适用渠道 null）→ 对所有渠道行生效', () => {
    const scenarios = [makeBuiltinFixedScenario({ applicableChannelIds: null })];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' }),
      makeBankRow({ rowId: 'r2', channel: '招商', location: '北京', customerRef: 'BFT987654321098' }),
      makeBankRow({ rowId: 'r3', channel: '未知', location: '未知', customerRef: 'CFT111122223333' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.modifiedRows.length, 3, '默认全部生效 → 3 行都提取');
  });

  test('适用渠道限定 [工商] → 仅工商行生效', () => {
    const scenarios = [makeBuiltinFixedScenario({ applicableChannelIds: [channels.icbc_sh.id] })];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' }),
      makeBankRow({ rowId: 'r2', channel: '招商', location: '北京', customerRef: 'BFT987654321098' }),
      makeBankRow({ rowId: 'r3', channel: '未知', location: '未知', customerRef: 'CFT111122223333' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.modifiedRows.length, 1, '仅工商行生效');
    assert.strictEqual(result.modifiedRows[0]._rowId, 'r1');
  });

  test('适用渠道空数组 [] → 等同全部生效', () => {
    const scenarios = [makeBuiltinFixedScenario({ applicableChannelIds: [] })];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' }),
      makeBankRow({ rowId: 'r2', channel: '招商', location: '北京', customerRef: 'BFT987654321098' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.modifiedRows.length, 2, '空数组 = 全部生效');
  });

  test('适用渠道限定 [招商] → 工商行不生效（兜底语义保持，未匹配渠道行也不生效）', () => {
    const scenarios = [makeBuiltinFixedScenario({ applicableChannelIds: [channels.cmb_bj.id] })];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' }),
      makeBankRow({ rowId: 'r2', channel: '招商', location: '北京', customerRef: 'BFT987654321098' }),
      makeBankRow({ rowId: 'r3', channel: '未知', location: '未知', customerRef: 'CFT111122223333' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]._rowId, 'r2');
  });
});
