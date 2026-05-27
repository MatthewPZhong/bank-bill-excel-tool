// v2.1.9 N5 Phase 4 T19：scenario-dispatcher 双维 first-match-wins 单元测试
//
// 覆盖范围（spec §2.2 4 种行结果矩阵）：
//   1. _matchStatus='命中' + hit≠null（专属命中）
//   2. _matchStatus='命中' + hit≠null（通用兜底命中）
//   3. _matchStatus='命中' + hit=null（专属+通用都未命中 → Sheet 2）
//   4. _matchStatus='兜底' + hit≠null（未匹配渠道 + 通用命中）
//   5. _matchStatus='兜底' + hit=null（未匹配渠道 + 通用未命中 → Sheet 2）
//
// + 不变量验证：
//   - first-match-wins（单行最多命中 1 场景）
//   - 阶段 A 命中 → 不进 B
//   - modifiedRows + unmatchedRows = bankRows（互斥 + 完整）
//   - 兼容性：channelId 缺失场景兜底到 1（通用）
//   - deps 缺省 → 走 v2.1.8 legacy 单维路径
//   - v2.1.8 hitScenarios displayIndex 输出格式不变

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  runAllScenarios,
  buildChannelKey,
  extractChannelName,
  extractChannelLocation,
  groupScenariosByChannelId,
  dispatchSingleRow,
  firstMatchWinsForRow
} = require('../../../src/main-process/scenario-dispatcher');

const channelsRepo = require('../../../src/backend/database/channels-repository');
const {
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureScenariosSupport
} = require('../../../src/backend/database/migrations');

// ---------- Fixtures ----------

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

// 共享 deps（指向同一个 db + repository 实例）
function makeDeps() {
  return { channelsRepo, db };
}

// 构造一个简单 C1 场景（提取 ReconId by feature code）
// channelId 用于双维归属；priority + id 决定 first-match-wins 顺序
function makeC1Scenario({
  id,
  name,
  channelId = 1,
  priority = 1,
  featureCode = 'FT',
  searchField = 'CustomerRef',
  digitCount = 12,
  totalLength = 15
} = {}) {
  return {
    id,
    name: name || `C1-${id}`,
    category: 'extract-recon-id',
    priority,
    enabled: true,
    channelId,
    displayIndex: id,
    config: {
      conditions: [{ field: searchField, op: '包含', value: featureCode }],
      conditionsLogic: 'OR',
      extractByFeature: {
        enabled: true,
        searchFields: [searchField],
        featureCode,
        digitCount,
        totalLength
      },
      extractByOtherField: null
    }
  };
}

// 简单 bankRow 构造器（保留 Channel / 地区 / CustomerRef / ReconciliationId / _rowId）
function makeBankRow({ rowId, channel, location, customerRef, recon = '' }) {
  return {
    _rowId: rowId,
    Channel: channel,
    地区: location,
    CustomerRef: customerRef,
    ReconciliationId: recon
  };
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-test-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  setupDb();

  // 准备渠道：工商-上海（id=2）/ 招商-北京（id=3）/ 通用-通用（id=1，自动）
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

// ========================================================================
// 1) 辅助函数 unit
// ========================================================================

test.describe('buildChannelKey', () => {
  test('正常 row → "Channel-地区"', () => {
    const row = makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'X' });
    assert.strictEqual(buildChannelKey(row), '工商-上海');
  });

  test('空字段 → "-"', () => {
    const row = makeBankRow({ rowId: 'r1', channel: '', location: '', customerRef: 'X' });
    assert.strictEqual(buildChannelKey(row), '-');
  });

  test('null row → "-"', () => {
    assert.strictEqual(buildChannelKey(null), '-');
  });

  test('字段前后空格 trim', () => {
    const row = makeBankRow({ rowId: 'r1', channel: '  招商  ', location: '  北京  ', customerRef: 'X' });
    assert.strictEqual(buildChannelKey(row), '招商-北京');
  });
});

test.describe('extractChannelName / extractChannelLocation', () => {
  test('正常字段 trim', () => {
    const row = makeBankRow({ rowId: 'r1', channel: ' 工商 ', location: ' 上海 ', customerRef: 'X' });
    assert.strictEqual(extractChannelName(row), '工商');
    assert.strictEqual(extractChannelLocation(row), '上海');
  });

  test('null / undefined → ""', () => {
    assert.strictEqual(extractChannelName(null), '');
    assert.strictEqual(extractChannelLocation(undefined), '');
    assert.strictEqual(extractChannelName({}), '');
  });
});

test.describe('groupScenariosByChannelId', () => {
  test('正常按 channelId 分组', () => {
    const list = [
      { id: 1, channelId: 2 },
      { id: 2, channelId: 1 },
      { id: 3, channelId: 2 }
    ];
    const map = groupScenariosByChannelId(list);
    assert.strictEqual(map.get(1).length, 1);
    assert.strictEqual(map.get(2).length, 2);
    assert.deepStrictEqual(map.get(2).map(s => s.id), [1, 3]);
  });

  test('缺 channelId 兜底到 1（通用）', () => {
    const list = [{ id: 1 }, { id: 2 }];
    const map = groupScenariosByChannelId(list);
    assert.strictEqual(map.get(1).length, 2);
  });

  test('snake_case channel_id 兼容', () => {
    const list = [{ id: 1, channel_id: 3 }];
    const map = groupScenariosByChannelId(list);
    assert.strictEqual(map.get(3).length, 1);
  });
});

// ========================================================================
// 2) firstMatchWinsForRow — 子集级 first-match-wins
// ========================================================================

test.describe('firstMatchWinsForRow', () => {
  test('空场景子集 → null', () => {
    const row = makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'FT123456789012' });
    assert.strictEqual(firstMatchWinsForRow([], row, null), null);
  });

  test('null 子集 → null', () => {
    const row = makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'X' });
    assert.strictEqual(firstMatchWinsForRow(null, row, null), null);
  });

  test('row 缺 _rowId → null', () => {
    const scenarios = [makeC1Scenario({ id: 1 })];
    const row = { Channel: '工商', CustomerRef: 'FT123456789012' };
    assert.strictEqual(firstMatchWinsForRow(scenarios, row, null), null);
  });

  test('首个匹配 → 返回 { scenario, result }（命中即 break，验证 first-match-wins）', () => {
    const s1 = makeC1Scenario({ id: 10, name: 'A', priority: 2 });
    const s2 = makeC1Scenario({ id: 11, name: 'B', priority: 1 });
    const row = makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' });
    const out = firstMatchWinsForRow([s1, s2], row, null);
    assert.ok(out);
    assert.strictEqual(out.scenario.id, 10, '应命中第一个（id=10）— first-match-wins 验证');
  });

  test('全部未命中 → null', () => {
    const s1 = makeC1Scenario({ id: 10, featureCode: 'ZZ' });
    const row = makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'no_match' });
    assert.strictEqual(firstMatchWinsForRow([s1], row, null), null);
  });
});

// ========================================================================
// 3) 双维 runAllScenarios — spec §2.2 4 种行结果矩阵
// ========================================================================

test.describe('runAllScenarios 双维调度 — spec §2.2 4 种行结果矩阵', () => {
  // 矩阵 1：_matchStatus='命中' + hit≠null（专属命中）
  test('矩阵 1：行匹配专属渠道 + 专属场景命中', () => {
    const scenarios = [
      makeC1Scenario({ id: 10, name: '工商专属', channelId: channels.icbc_sh.id }),
      makeC1Scenario({ id: 11, name: '通用', channelId: channels.general.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];

    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1, '应 1 行命中');
    assert.strictEqual(result.unmatchedRows.length, 0);
    const row = result.modifiedRows[0];
    assert.strictEqual(row._matchStatus, '命中');
    assert.strictEqual(row._matchedChannelId, channels.icbc_sh.id);
    assert.strictEqual(row._fallbackChannelId, null, '专属命中无 fallback');
    assert.strictEqual(row._hitChannelKey, '工商-上海');
    // v2.1.9 D16=b：命中专属 → _hitChannelId = 专属渠道 id
    assert.strictEqual(row._hitChannelId, channels.icbc_sh.id, '_hitChannelId 写入专属渠道 id');
    assert.strictEqual(row._hitScenarioId, 10, '专属场景 id=10 命中');
    assert.strictEqual(row._hitScenarioName, '工商专属');
  });

  // 矩阵 2：_matchStatus='命中' + hit≠null（通用兜底命中）
  test('矩阵 2：行匹配专属 + 专属无命中 → 通用兜底命中', () => {
    const scenarios = [
      // 专属场景 featureCode='ZZ' 不会命中（CustomerRef 不含 ZZ）
      makeC1Scenario({ id: 10, name: '工商专属', channelId: channels.icbc_sh.id, featureCode: 'ZZ' }),
      makeC1Scenario({ id: 11, name: '通用', channelId: channels.general.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];

    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1, '通用兜底应命中');
    const row = result.modifiedRows[0];
    assert.strictEqual(row._matchStatus, '命中', '行匹配到专属，状态=命中');
    assert.strictEqual(row._matchedChannelId, channels.icbc_sh.id);
    assert.strictEqual(row._fallbackChannelId, channels.general.id, '通用兜底命中 → fallback 记录通用 id');
    // v2.1.9 D16=b：实际命中通用 → _hitChannelId = 通用 id（不是专属 id）
    assert.strictEqual(row._hitChannelId, channels.general.id, '_hitChannelId 写入实际命中通用 id');
    assert.strictEqual(row._hitScenarioId, 11);
    assert.strictEqual(row._hitScenarioName, '通用');
  });

  // 矩阵 3：_matchStatus='命中' + hit=null（专属+通用都未命中 → Sheet 2）
  test('矩阵 3：行匹配专属 + 专属和通用都未命中 → unmatchedRows（Sheet 2）', () => {
    const scenarios = [
      makeC1Scenario({ id: 10, name: '工商专属', channelId: channels.icbc_sh.id, featureCode: 'ZZ' }),
      makeC1Scenario({ id: 11, name: '通用', channelId: channels.general.id, featureCode: 'YY' })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];

    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 0);
    assert.strictEqual(result.unmatchedRows.length, 1);
    const row = result.unmatchedRows[0];
    assert.strictEqual(row._matchStatus, '命中', '行匹配到专属，状态=命中（即使场景未命中）');
    assert.strictEqual(row._matchedChannelId, channels.icbc_sh.id);
    assert.strictEqual(row._fallbackChannelId, null, '未命中 fallback=null');
    assert.strictEqual(row._hitChannelKey, '工商-上海');
    // v2.1.9 D16=b：未命中行 _hitChannelId=null
    assert.strictEqual(row._hitChannelId, null, '未命中行 _hitChannelId=null');
  });

  // 矩阵 4：_matchStatus='兜底' + hit≠null（未匹配渠道 + 通用命中）
  test('矩阵 4：行未匹配渠道 + 通用兜底命中', () => {
    const scenarios = [
      makeC1Scenario({ id: 11, name: '通用', channelId: channels.general.id })
    ];
    const rows = [
      // 浦发-深圳 不在 channels 表中
      makeBankRow({ rowId: 'r1', channel: '浦发', location: '深圳', customerRef: 'AFT123456789012' })
    ];

    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    const row = result.modifiedRows[0];
    assert.strictEqual(row._matchStatus, '兜底', '未匹配渠道，状态=兜底');
    assert.strictEqual(row._matchedChannelId, null);
    assert.strictEqual(row._fallbackChannelId, null, '兜底直接走通用，不走 fallback 字段（fallback 字段仅在专属命中通用时记录）');
    assert.strictEqual(row._hitChannelKey, '浦发-深圳', '保留原始 Channel-地区 用于审计');
    assert.strictEqual(row._hitScenarioId, 11);
    // v2.1.9 D16=b：兜底命中通用 → _hitChannelId = 通用 id
    assert.strictEqual(row._hitChannelId, channels.general.id, '_hitChannelId 写入通用 id');
  });

  // 矩阵 5：_matchStatus='兜底' + hit=null（未匹配渠道 + 通用未命中 → Sheet 2）
  test('矩阵 5：行未匹配渠道 + 通用也未命中 → unmatchedRows（Sheet 2）', () => {
    const scenarios = [
      makeC1Scenario({ id: 11, name: '通用', channelId: channels.general.id, featureCode: 'YY' })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '浦发', location: '深圳', customerRef: 'AFT123456789012' })
    ];

    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 0);
    assert.strictEqual(result.unmatchedRows.length, 1);
    const row = result.unmatchedRows[0];
    assert.strictEqual(row._matchStatus, '兜底');
    assert.strictEqual(row._matchedChannelId, null);
    assert.strictEqual(row._hitChannelKey, '浦发-深圳');
    // v2.1.9 D16=b：未命中行 _hitChannelId=null
    assert.strictEqual(row._hitChannelId, null, '未命中行 _hitChannelId=null');
  });
});

// ========================================================================
// v2.1.9 D16=b 新增：_hitChannelId 写入语义专项验证（spec §D16=b）
// ========================================================================
test.describe('v2.1.9 D16=b：_hitChannelId 写入语义', () => {
  test('命中专属渠道场景 → _hitChannelId = 专属渠道 id', () => {
    const scenarios = [
      makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id, name: 'icbc-sh' })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]._hitChannelId, channels.icbc_sh.id);
  });

  test('命中通用渠道场景（行匹配专属，但走 fallback）→ _hitChannelId = 通用 id（不是专属）', () => {
    const scenarios = [
      // 专属不命中（featureCode 不匹配）
      makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id, featureCode: 'ZZ' }),
      // 通用命中
      makeC1Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.modifiedRows.length, 1);
    const row = result.modifiedRows[0];
    assert.strictEqual(row._hitChannelId, channels.general.id, '命中通用 → _hitChannelId=通用 id（即使行匹配专属）');
    assert.strictEqual(row._matchedChannelId, channels.icbc_sh.id, '_matchedChannelId 仍是行匹配的专属 id');
    assert.notStrictEqual(row._hitChannelId, row._matchedChannelId, '两个字段语义不同：matchedChannelId=行 / hitChannelId=场景');
  });

  test('行匹配通用本身 → _hitChannelId = 通用 id', () => {
    const scenarios = [
      makeC1Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '通用', location: '通用', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]._hitChannelId, channels.general.id);
  });

  test('未命中行（专属+通用都未命中）→ unmatchedRows 行 _hitChannelId=null', () => {
    const scenarios = [
      makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id, featureCode: 'ZZ' }),
      makeC1Scenario({ id: 11, channelId: channels.general.id, featureCode: 'YY' })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.unmatchedRows.length, 1);
    assert.strictEqual(result.unmatchedRows[0]._hitChannelId, null);
  });

  test('用户场景（BOSH-CN → 通用兜底）：_hitChannelId=通用 id（不是 BOSH-CN 行原始 key）', () => {
    // 复现用户反馈：导入 BOSH-CN 银行账单，库内只有通用渠道
    const scenarios = [
      makeC1Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: 'BOSH', location: 'CN', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());
    assert.strictEqual(result.modifiedRows.length, 1);
    const row = result.modifiedRows[0];
    assert.strictEqual(row._hitChannelId, channels.general.id, 'writer 用此 id 反查 → "通用"');
    assert.strictEqual(row._hitChannelKey, 'BOSH-CN', '_hitChannelKey 仍保留原始 BOSH-CN 用于审计');
    assert.strictEqual(row._matchStatus, '兜底');
  });
});

// ========================================================================
// 4) first-match-wins 不变量 + spec §2.4 分阶段执行验证
// ========================================================================

test.describe('first-match-wins 不变量 + 分阶段执行', () => {
  test('阶段 A 命中 → 不进阶段 B（专属命中后通用不被尝试）', () => {
    const scenarios = [
      // 专属场景（CustomerRef='AFT*' 命中，写 ReconciliationId 为提取的 FT 编码）
      makeC1Scenario({ id: 10, name: 'icbc-A', channelId: channels.icbc_sh.id }),
      // 通用场景（featureCode 不同，理论上也能命中但应被 first-match-wins 拦下）
      makeC1Scenario({ id: 11, name: 'general-B', channelId: channels.general.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];

    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]._hitScenarioId, 10, '阶段 A 命中后不进 B；hit 是专属');
    // 不变量：每行最多 1 个场景命中 → hitScenarios 中无 id=11
    assert.deepStrictEqual(
      result.stats.hitScenarios.map(s => s.id).sort(),
      [10],
      'hitScenarios 仅含阶段 A 命中的场景'
    );
  });

  test('单行最多命中 1 场景（first-match-wins 不变量）', () => {
    // 3 个专属场景全部理论可命中同一行；first-match-wins 应只命中 priority 最高
    const scenarios = [
      makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id, priority: 1 }),
      makeC1Scenario({ id: 11, channelId: channels.icbc_sh.id, priority: 3 }), // 最高
      makeC1Scenario({ id: 12, channelId: channels.icbc_sh.id, priority: 2 })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];

    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]._hitScenarioId, 11, 'priority=3 优先');
  });

  test('modifiedRows + unmatchedRows = bankRows（互斥 + 完整）', () => {
    const scenarios = [
      makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id }),
      makeC1Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' }),
      makeBankRow({ rowId: 'r2', channel: '浦发', location: '深圳', customerRef: 'no_match' }),  // 通用 featureCode=FT 也命中？customerRef 不含 FT → 未命中
      makeBankRow({ rowId: 'r3', channel: '招商', location: '北京', customerRef: 'AFT999999999999' })
    ];

    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(
      result.modifiedRows.length + result.unmatchedRows.length,
      rows.length,
      '互斥 + 完整：sum = totalRows'
    );

    // 双向 id 比对：每个 rowId 恰好出现在一边
    const allIds = [
      ...result.modifiedRows.map(r => r._rowId),
      ...result.unmatchedRows.map(r => r._rowId)
    ];
    assert.deepStrictEqual(allIds.sort(), ['r1', 'r2', 'r3']);
  });
});

// ========================================================================
// 5) dispatchSingleRow 单行级 unit
// ========================================================================

test.describe('dispatchSingleRow（单行视角）', () => {
  test('阶段 A 命中', () => {
    const map = new Map();
    map.set(channels.icbc_sh.id, [makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id })]);
    map.set(channels.general.id, [makeC1Scenario({ id: 11, channelId: channels.general.id })]);

    const row = makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' });
    const out = dispatchSingleRow(row, null, map, makeDeps());

    assert.ok(out.hit);
    assert.strictEqual(out.hit.scenario.id, 10, '专属命中');
    assert.strictEqual(out.hitChannelId, channels.icbc_sh.id);
    assert.strictEqual(out.matchedChannel.id, channels.icbc_sh.id);
    assert.strictEqual(out.generalChannel.id, channels.general.id);
  });

  test('阶段 A 未命中 → 阶段 B 通用兜底命中', () => {
    const map = new Map();
    map.set(channels.icbc_sh.id, [makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id, featureCode: 'ZZ' })]);
    map.set(channels.general.id, [makeC1Scenario({ id: 11, channelId: channels.general.id })]);

    const row = makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' });
    const out = dispatchSingleRow(row, null, map, makeDeps());

    assert.ok(out.hit);
    assert.strictEqual(out.hit.scenario.id, 11);
    assert.strictEqual(out.hitChannelId, channels.general.id);
    assert.strictEqual(out.matchedChannel.id, channels.icbc_sh.id, '行仍匹配到专属');
  });

  test('行匹配到通用（即 channels 表里只有「通用」） → 跳过阶段 A 直接走 B', () => {
    const map = new Map();
    map.set(channels.general.id, [makeC1Scenario({ id: 11, channelId: channels.general.id })]);

    const row = makeBankRow({ rowId: 'r1', channel: '通用', location: '通用', customerRef: 'AFT123456789012' });
    const out = dispatchSingleRow(row, null, map, makeDeps());

    assert.ok(out.hit);
    assert.strictEqual(out.hit.scenario.id, 11);
    assert.strictEqual(out.hitChannelId, channels.general.id);
    assert.strictEqual(out.matchedChannel.id, channels.general.id, '匹配的是通用本身');
  });

  test('未匹配渠道 + 通用为空 → hit=null', () => {
    const map = new Map();  // 无任何 scenarios
    const row = makeBankRow({ rowId: 'r1', channel: '浦发', location: '深圳', customerRef: 'AFT123456789012' });
    const out = dispatchSingleRow(row, null, map, makeDeps());

    assert.strictEqual(out.hit, null);
    assert.strictEqual(out.hitChannelId, null);
    assert.strictEqual(out.matchedChannel, null);
  });
});

// ========================================================================
// 6) 向后兼容：deps 缺省 → legacy 单维路径
// ========================================================================

test.describe('向后兼容：deps 缺省走 v2.1.8 legacy 单维路径', () => {
  test('deps 为 undefined → legacy 路径（无 _hitChannelKey 字段）', () => {
    const scenarios = [makeC1Scenario({ id: 10 })];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];

    const result = runAllScenarios(rows, null, scenarios); // 无 deps

    assert.strictEqual(result.modifiedRows.length, 1);
    const row = result.modifiedRows[0];
    // legacy 路径不写 _hitChannelKey / _matchStatus
    assert.strictEqual(row._hitChannelKey, undefined);
    assert.strictEqual(row._matchStatus, undefined);
    // 但 v2.1.8 N3-1 现有字段仍输出
    assert.strictEqual(row._hitScenarioId, 10);
    assert.strictEqual(row._hitScenarioName, 'C1-10');
  });

  test('deps 为 null → legacy 路径', () => {
    const scenarios = [makeC1Scenario({ id: 10 })];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, null);
    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]._hitChannelKey, undefined);
  });

  test('deps 缺 channelsRepo → fallback legacy 单维', () => {
    const scenarios = [makeC1Scenario({ id: 10 })];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, { db });
    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]._hitChannelKey, undefined);
  });
});

// ========================================================================
// 7) v2.1.8 输出契约保留：hitScenarios displayIndex + stats 兼容
// ========================================================================

test.describe('v2.1.8 输出契约：hitScenarios / displayIndex / stats', () => {
  test('双维路径 hitScenarios 含 { id, displayIndex, name }', () => {
    const scenarios = [
      makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id })
    ];
    scenarios[0].displayIndex = 3;  // 手工设 displayIndex 验证传透
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.stats.hitScenarios.length, 1);
    assert.deepStrictEqual(result.stats.hitScenarios[0], {
      id: 10,
      displayIndex: 3,
      name: 'C1-10'
    });
  });

  test('hitScenarios 跨行去重（同 scenario 命中多行只入一次）', () => {
    const scenarios = [
      makeC1Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '浦发', location: '深圳', customerRef: 'AFT111111111111' }),
      makeBankRow({ rowId: 'r2', channel: '建行', location: '南京', customerRef: 'AFT222222222222' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 2);
    assert.strictEqual(result.stats.scenarioHitCount, 2, '行级命中次数 = 2');
    assert.strictEqual(result.stats.hitScenarios.length, 1, 'hitScenarios 去重后仅 1 个场景');
    assert.strictEqual(result.stats.hitScenarios[0].id, 11);
  });

  test('双维路径 stats 字段完整（hitRowCount / unmatchedRowCount / skippedC4/C3Count）', () => {
    const scenarios = [
      makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id })
    ];
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' }),
      makeBankRow({ rowId: 'r2', channel: '浦发', location: '深圳', customerRef: 'no_match' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.stats.totalRows, 2);
    assert.strictEqual(result.stats.hitRowCount, 1);
    assert.strictEqual(result.stats.unmatchedRowCount, 1);
    assert.strictEqual(result.stats.skippedC3Count, 0);
    assert.strictEqual(result.stats.skippedC4Count, 0);
  });
});

// ========================================================================
// 8) 兼容性：scenarios 无 channelId 字段 → groupScenariosByChannelId 兜底通用
// ========================================================================

test.describe('兼容性：旧 scenarios 无 channelId', () => {
  test('无 channelId 场景在双维路径下走通用渠道', () => {
    // 不带 channelId（模拟 v2.1.8 老调用方）
    const scenario = makeC1Scenario({ id: 10 });
    delete scenario.channelId;

    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, [scenario], makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    const row = result.modifiedRows[0];
    // 行匹配到工商-上海（matchedChannel=icbc_sh），但场景在通用 → 走阶段 B 兜底
    assert.strictEqual(row._matchStatus, '命中', '行匹配工商-上海');
    assert.strictEqual(row._matchedChannelId, channels.icbc_sh.id);
    assert.strictEqual(row._fallbackChannelId, channels.general.id, '场景在通用 → fallback');
    assert.strictEqual(row._hitScenarioId, 10);
  });
});

// ========================================================================
// 9) 输入校验
// ========================================================================

test.describe('runAllScenarios 输入校验', () => {
  test('bankRows 非数组 → throw', () => {
    assert.throws(() => runAllScenarios(null, null, []), /bankRows 必须是数组/);
  });

  test('scenarios 非数组 → throw', () => {
    assert.throws(() => runAllScenarios([], null, null), /scenarios 必须是数组/);
  });

  test('空 bankRows + 双维 → 返回空结果（无 throw）', () => {
    const result = runAllScenarios([], null, [], makeDeps());
    assert.strictEqual(result.modifiedRows.length, 0);
    assert.strictEqual(result.unmatchedRows.length, 0);
    assert.strictEqual(result.stats.totalRows, 0);
  });

  test('空 scenarios + 双维 → 所有行进 unmatchedRows', () => {
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, [], makeDeps());
    assert.strictEqual(result.modifiedRows.length, 0);
    assert.strictEqual(result.unmatchedRows.length, 1);
    assert.strictEqual(result.unmatchedRows[0]._hitChannelKey, '工商-上海');
    assert.strictEqual(result.unmatchedRows[0]._matchStatus, '命中', '行仍匹配到工商-上海渠道');
  });
});
