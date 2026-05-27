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
  // v2.1.9 SR-FIX-1 (spec §16.2)：dispatchSingleRow / firstMatchWinsForRow 已删（per-row 路径
  //   打破 C3 1v1 不变量 + 让 C2 笛卡尔配对失效）；新增 runChannelBatch（per-channel batch）。
  runChannelBatch
} = require('../../../src/main-process/scenario-dispatcher');

const channelsRepo = require('../../../src/backend/database/channels-repository');
// v2.1.9 SR-FIX-1 T43 case 13：scenarios 跨 channel 同名验证（D39）
const scenariosRepo = require('../../../src/backend/database/scenarios-repository');
const {
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureScenariosSupport,
  // v2.1.9 SR-FIX-1 T43 case 13：跨 channel 同名场景需 schema 切到复合 UNIQUE 才能落库
  ensureScenariosNameUniqueByChannelId
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
// 2) 双维 runAllScenarios — spec §2.2 4 种行结果矩阵
// ========================================================================
//
// 注：原 firstMatchWinsForRow 9 case 已删（v2.1.9 SR-FIX-1 spec §16.2 — per-row 路径
//   打破 C3 1v1 不变量 + 让 C2 笛卡尔配对失效；改用 per-channel batch 后该函数已删除）。
//   first-match-wins 不变量改由「first-match-wins 不变量」+「matrix 5 case」+ T43 新增 case 验证。

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
// 4) 向后兼容：deps 缺省 → legacy 单维路径
// ========================================================================
//
// 注：原 dispatchSingleRow 4 case 已删（v2.1.9 SR-FIX-1 spec §16.2 — per-row 入口
//   不再保留；调度通过 runAllScenarios + runChannelBatch 入口）。
//   单行阶段 A/B 行为改由「runAllScenarios 双维调度 4 矩阵」case 覆盖。

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
    // v2.1.9 SR-FIX-1 (spec §16.2) reverse sync：scenarioHitCount 是「场景级命中次数」（与 v2.1.8
    //   legacy 单维路径一致 — 一个 scenario 命中即 +1，不论命中多少行；N5 v0.3 per-row 误算成「行级」）
    //   per-channel batch 重写后回归 legacy 语义：单 scenario 命中 1+ 行 → scenarioHitCount += 1
    assert.strictEqual(result.stats.scenarioHitCount, 1, '场景级命中次数 = 1（一个 scenario 命中 2 行算一次）');
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

// ========================================================================
// v2.1.9 SR-FIX-1 — spec §16.4 case 矩阵：C2/C3 双维 unit case 18 个
// ========================================================================
//
// 范围（spec §16.4 表 1-15 + R1-R3）：
//   case 1-6  : C3 阶段 A/B + 1v1 资金红线 + 跨阶段 gw 重消费已知边界
//   case 7-10 : C2 阶段 A/B + 笛卡尔配对 + reconFields=0 衍生方案 A
//   case 11-12: 混合 first-match-wins 不变量（C1 锁定后 C2 / C3 锁定后 C2 不再处理同行）
//   case 13   : 跨 channel 同名场景 — D39 验证（在 scenarios-repository 维度 R2 也覆盖）
//   case 14-15: 全部场景在通用 + 行匹配/未匹配渠道 — metadata fallback 验证
//
// 关键资金红线断言：
//   - case 2: C3 1v1 严格 — 不同 bank 行配不同 gw 行（usedGwRowIdx 在 runScenario scope 内独占）
//   - case 7: C2 笛卡尔配对 — leftRows / rightRows 各 ≥1 才命中（per-channel batch 修复 SR1 #2）

// ---- C2/C3 场景构造器 ----

// C3 场景：1v1 金额匹配（assign 直取 gw 字段写 bank 字段）
function makeC3Scenario({
  id, name, channelId = 1, priority = 1,
  gwField = 'Reference', bankField = 'ReconciliationId'
} = {}) {
  return {
    id,
    name: name || `C3-${id}`,
    category: 'gateway-recon-join',
    priority,
    enabled: true,
    channelId,
    displayIndex: id,
    config: {
      reconFields: [{ seq: 1, gwField: 'Amount', bankField: '发生额绝对值' }],
      assign: { gwField, bankField, mode: 'direct', customValue: '' }
    }
  };
}

// C3 bank 行：要 Credit / Debit Amount + ReconciliationId
function makeC3BankRow({ rowId, channel, location, creditAmount = 0, debitAmount = 0, recon = '' }) {
  return {
    _rowId: rowId,
    Channel: channel,
    地区: location,
    'Credit Amount': creditAmount,
    'Debit Amount': debitAmount,
    ReconciliationId: recon
  };
}

// C2 场景：billTypes seq=1/2 + reconFields 配对（按 OrderId） + markValue 写 rightRow
function makeC2Scenario({
  id, name, channelId = 1, priority = 1,
  rightField = 'Remark-description', rightValue = 'PAIRED'
} = {}) {
  return {
    id,
    name: name || `C2-${id}`,
    category: 'offset-bill-mark',
    priority,
    enabled: true,
    channelId,
    displayIndex: id,
    config: {
      billTypes: [
        { seq: 1, field: 'type', op: '等于', value: 'A' },
        { seq: 2, field: 'type', op: '等于', value: 'B' }
      ],
      reconFields: [
        { seq: 1, leftType: 1, leftField: 'OrderId', rightType: 2, rightField: 'OrderId' }
      ],
      markValue: { type: 2, field: rightField, value: rightValue }
    }
  };
}

// C2 bank 行：含 type + OrderId + 目标字段
function makeC2BankRow({ rowId, channel, location, type, orderId, mark = '' }) {
  return {
    _rowId: rowId,
    Channel: channel,
    地区: location,
    type,
    OrderId: orderId,
    'Remark-description': mark
  };
}

// C2 reconFields=0「衍生方案 A」场景：无条件按 billType 命中写 markValue
function makeC2NoReconFieldsScenario({
  id, name, channelId = 1, priority = 1,
  markField = 'Remark-description', markValue = 'NO-RECON', markType = 1
} = {}) {
  return {
    id,
    name: name || `C2NR-${id}`,
    category: 'offset-bill-mark',
    priority,
    enabled: true,
    channelId,
    displayIndex: id,
    config: {
      billTypes: [
        { seq: 1, field: 'type', op: '等于', value: 'X' }
      ],
      reconFields: [],
      markValue: { type: markType, field: markField, value: markValue }
    }
  };
}

test.describe('v2.1.9 SR-FIX-1 spec §16.4 — C3 矩阵 case 1-6', () => {
  // case 1：阶段 A 专属 channel C3 命中
  test('case 1：阶段 A 专属 channel C3 命中 + gw 行被消费', () => {
    const scenarios = [
      makeC3Scenario({ id: 10, name: 'C3-icbc', channelId: channels.icbc_sh.id })
    ];
    const rows = [
      makeC3BankRow({ rowId: 'r1', channel: '工商', location: '上海', creditAmount: 100 })
    ];
    const gwRows = [
      { Amount: 100, Reference: 'GW-REF-A' }
    ];
    const result = runAllScenarios(rows, gwRows, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1, '阶段 A 应命中');
    assert.strictEqual(result.modifiedRows[0]._hitScenarioId, 10);
    assert.strictEqual(result.modifiedRows[0]._matchedChannelId, channels.icbc_sh.id);
    assert.strictEqual(result.modifiedRows[0]._hitChannelId, channels.icbc_sh.id);
    assert.strictEqual(result.modifiedRows[0].ReconciliationId, 'GW-REF-A', '应写入 gw Reference');
  });

  // case 2：C3 阶段 A 同 channel 多行 1v1 — 🔴 资金红线护栏
  test('case 2：阶段 A 同 channel 多 bank 行多 gw 行严格 1v1（C3 资金红线 1v1 不变量）', () => {
    const scenarios = [
      makeC3Scenario({ id: 10, channelId: channels.icbc_sh.id })
    ];
    // 2 行 bank 都金额=100 + matched 工商-上海
    const rows = [
      makeC3BankRow({ rowId: 'r1', channel: '工商', location: '上海', creditAmount: 100 }),
      makeC3BankRow({ rowId: 'r2', channel: '工商', location: '上海', creditAmount: 100 })
    ];
    // 2 行 gw 都金额=100 但 Reference 不同
    const gwRows = [
      { Amount: 100, Reference: 'GW-A' },
      { Amount: 100, Reference: 'GW-B' }
    ];
    const result = runAllScenarios(rows, gwRows, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 2, '2 行 bank 都应命中');
    // 关键：2 行写入的 gw Reference 必须不同（严格 1v1）— per-row 路径 bug 会让两行都写 GW-A
    const refs = result.modifiedRows.map((r) => r.ReconciliationId).sort();
    assert.deepStrictEqual(refs, ['GW-A', 'GW-B'], 'C3 1v1 红线：不同 bank 行写入不同 gw 行（不共费）');
  });

  // case 3：C3 阶段 A gw 不够 → 部分 bank 未命中
  test('case 3：阶段 A C3 gw 行不够 → 多余 bank 行 unmatched', () => {
    const scenarios = [
      makeC3Scenario({ id: 10, channelId: channels.icbc_sh.id })
    ];
    const rows = [
      makeC3BankRow({ rowId: 'r1', channel: '工商', location: '上海', creditAmount: 100 }),
      makeC3BankRow({ rowId: 'r2', channel: '工商', location: '上海', creditAmount: 100 })
    ];
    const gwRows = [
      { Amount: 100, Reference: 'GW-A' }
    ];
    const result = runAllScenarios(rows, gwRows, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1, '只 1 行能命中 gw');
    assert.strictEqual(result.unmatchedRows.length, 1, '另 1 行 unmatched');
    assert.strictEqual(result.modifiedRows[0].ReconciliationId, 'GW-A');
  });

  // case 4：阶段 A 未命中 → 阶段 B 通用 C3 命中
  test('case 4：阶段 A 专属 C3 不匹配 → 阶段 B 通用 C3 命中', () => {
    const scenarios = [
      // 专属 C3 reconFields 比通用严格（金额必须 200）→ 不会命中 100
      {
        ...makeC3Scenario({ id: 10, channelId: channels.icbc_sh.id }),
        config: {
          reconFields: [
            { seq: 1, gwField: 'Amount', bankField: '发生额绝对值' },
            { seq: 1, gwField: 'StrictKey', bankField: 'OrderId' }
          ],
          assign: { gwField: 'Reference', bankField: 'ReconciliationId', mode: 'direct', customValue: '' }
        }
      },
      makeC3Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      makeC3BankRow({ rowId: 'r1', channel: '工商', location: '上海', creditAmount: 100 })
    ];
    const gwRows = [
      // 第一个不命中专属（StrictKey 不匹配 OrderId），但命中通用
      { Amount: 100, Reference: 'GW-GEN', StrictKey: 'NONE' }
    ];
    const result = runAllScenarios(rows, gwRows, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    const row = result.modifiedRows[0];
    assert.strictEqual(row._hitScenarioId, 11, '通用 C3 命中');
    assert.strictEqual(row._hitChannelId, channels.general.id);
    assert.strictEqual(row._fallbackChannelId, channels.general.id, '专属未命中 → fallback 通用');
  });

  // case 5：行未 matched channel → 阶段 B 通用 C3 命中
  test('case 5：行未匹配任何渠道 → 阶段 B 通用 C3 命中（兜底）', () => {
    const scenarios = [
      makeC3Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      // 浦发-深圳 不在 channels 表
      makeC3BankRow({ rowId: 'r1', channel: '浦发', location: '深圳', creditAmount: 100 })
    ];
    const gwRows = [
      { Amount: 100, Reference: 'GW-GEN' }
    ];
    const result = runAllScenarios(rows, gwRows, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]._matchStatus, '兜底');
    assert.strictEqual(result.modifiedRows[0]._hitChannelId, channels.general.id);
  });

  // case 6：跨 channel gw 重消费已知边界（spec §16.2 文档化）
  test('case 6：跨 channel + 跨场景的 gw 行允许多次消费（已知边界，记录不抛错）', () => {
    // 同一个 gwRow 在专属 C3 + 通用 C3 都能匹配（同 reconFields = Amount）
    const scenarios = [
      makeC3Scenario({ id: 10, channelId: channels.icbc_sh.id }),
      makeC3Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      // r1: matched 工商-上海 → 走阶段 A 专属（消费 gw[0]）
      makeC3BankRow({ rowId: 'r1', channel: '工商', location: '上海', creditAmount: 100 }),
      // r2: 未 matched 浦发-深圳 → 走阶段 B 通用（理论能消费 gw[0]，但已被消费 → 红线问题？）
      makeC3BankRow({ rowId: 'r2', channel: '浦发', location: '深圳', creditAmount: 100 })
    ];
    const gwRows = [
      { Amount: 100, Reference: 'GW-A' }
    ];
    const result = runAllScenarios(rows, gwRows, scenarios, makeDeps());

    // 已知边界（spec §16.2 / USER_GUIDE 文档化）：
    //   - 阶段 A runScenario(专属 C3, [r1], gw) 内 usedGwRowIdx 消费 gw[0]
    //   - 阶段 B runScenario(通用 C3, [r2], gw) 内 usedGwRowIdx 是新 Set → 能再消费 gw[0]
    //   - 与 v2.1.8 单维行为一致：单 runScenario 调用内 1v1，跨调用允许多次消费
    //   - 不抛错；调用方需在 USER_GUIDE 引导用户避免「专属 + 通用同时配相同 reconFields」
    assert.ok(result.modifiedRows.length >= 1, '至少 1 行命中（专属 r1）');
    // 不强断言 r2 命中或不命中 — 行为是「允许跨调用重消费」（实际会再命中）
    // 严格断言：r1 必命中专属
    const r1 = result.modifiedRows.find((r) => r._rowId === 'r1');
    assert.ok(r1, 'r1 应被专属命中');
    assert.strictEqual(r1._hitChannelId, channels.icbc_sh.id);
  });
});

test.describe('v2.1.9 SR-FIX-1 spec §16.4 — C2 矩阵 case 7-10', () => {
  // case 7：阶段 A 专属 C2 笛卡尔配对成功 — 🔴 修复 SR1 #2（per-row 路径 C2 失效）
  test('case 7：阶段 A 专属 C2 leftRow + rightRow 笛卡尔配对成功（修复 SR1 #2）', () => {
    const scenarios = [
      makeC2Scenario({ id: 10, channelId: channels.icbc_sh.id })
    ];
    // 2 行 bank：A 行（type=A，leftType=1） + B 行（type=B，rightType=2）+ 同 channel 同 OrderId
    const rows = [
      makeC2BankRow({ rowId: 'r1', channel: '工商', location: '上海', type: 'A', orderId: 'O1' }),
      makeC2BankRow({ rowId: 'r2', channel: '工商', location: '上海', type: 'B', orderId: 'O1' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 2, 'C2 笛卡尔配对成功 — 左右双方都被锁定');
    // rightRow 应被写入 markValue
    const r2 = result.modifiedRows.find((r) => r._rowId === 'r2');
    assert.ok(r2);
    assert.strictEqual(r2['Remark-description'], 'PAIRED', 'rightRow 字段被写入');
  });

  // case 8：阶段 A 专属 C2 单行入参（防御性 — 仅 leftType 一行）
  test('case 8：阶段 A 专属 C2 仅 leftRow 一行 → 无配对 → unmatched（不抛错）', () => {
    const scenarios = [
      makeC2Scenario({ id: 10, channelId: channels.icbc_sh.id })
    ];
    const rows = [
      makeC2BankRow({ rowId: 'r1', channel: '工商', location: '上海', type: 'A', orderId: 'O1' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 0, '无 rightRow → C2 无法配对');
    assert.strictEqual(result.unmatchedRows.length, 1);
  });

  // case 9：阶段 A 未命中 → 阶段 B 通用 C2 命中
  test('case 9：阶段 A 无专属 C2 → 阶段 B 通用 C2 笛卡尔配对成功', () => {
    const scenarios = [
      // 通用 C2（无专属）
      makeC2Scenario({ id: 11, channelId: channels.general.id })
    ];
    // 招商-北京 是已知 channel，但无专属 C2 → 进阶段 B 通用
    const rows = [
      makeC2BankRow({ rowId: 'r1', channel: '招商', location: '北京', type: 'A', orderId: 'O1' }),
      makeC2BankRow({ rowId: 'r2', channel: '招商', location: '北京', type: 'B', orderId: 'O1' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 2);
    const r2 = result.modifiedRows.find((r) => r._rowId === 'r2');
    assert.ok(r2);
    assert.strictEqual(r2['Remark-description'], 'PAIRED');
    assert.strictEqual(r2._fallbackChannelId, channels.general.id, '专属无 C2 → fallback 通用');
  });

  // case 10：C2 reconFields=0 衍生方案 A 无条件赋值
  test('case 10：C2 reconFields=0 衍生方案 A — 命中 billType 即写字段（不走笛卡尔）', () => {
    const scenarios = [
      makeC2NoReconFieldsScenario({ id: 10, channelId: channels.icbc_sh.id })
    ];
    const rows = [
      {
        _rowId: 'r1', Channel: '工商', 地区: '上海',
        type: 'X', // 命中 billType seq=1
        'Remark-description': ''
      }
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    assert.strictEqual(result.modifiedRows[0]['Remark-description'], 'NO-RECON', 'reconFields=0 → 直接写值');
  });
});

test.describe('v2.1.9 SR-FIX-1 spec §16.4 — 混合 case 11-15', () => {
  // case 11：first-match-wins 不变量验证 — C1 锁定后同行不再被 C2 处理
  test('case 11：C1 命中行后 first-match-wins 锁定 → 后续 C2 场景不再处理同行', () => {
    // C1 先命中 r1（CustomerRef 含 AFT）→ r1 锁定
    // C2 想配对 r1 + r2，但 r1 已锁定 → C2 收到 unlocked = [r2] → 无法配对（leftRows 空）
    const scenarios = [
      // C1 priority=3 优先（专属 + 高优先级 → 阶段 A 先跑）
      makeC1Scenario({ id: 10, channelId: channels.icbc_sh.id, priority: 3 }),
      // C2 priority=1
      makeC2Scenario({ id: 11, channelId: channels.icbc_sh.id, priority: 1 })
    ];
    const rows = [
      // r1：C1 能命中（AFT123 含 FT 编码）+ C2 是 leftType A
      {
        _rowId: 'r1', Channel: '工商', 地区: '上海',
        CustomerRef: 'AFT123456789012', ReconciliationId: '',
        type: 'A', OrderId: 'O1', 'Remark-description': ''
      },
      // r2：仅 C2 rightType B（CustomerRef 不含 AFT）
      {
        _rowId: 'r2', Channel: '工商', 地区: '上海',
        CustomerRef: 'no_match', ReconciliationId: '',
        type: 'B', OrderId: 'O1', 'Remark-description': ''
      }
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    // r1: C1 命中（priority=3 优先），不再被 C2 触及
    const r1 = result.modifiedRows.find((r) => r._rowId === 'r1');
    assert.ok(r1, 'r1 应命中');
    assert.strictEqual(r1._hitScenarioId, 10, 'r1 命中 C1（first-match-wins）');
    // r2: 因 r1 锁定，C2 入参 unlocked = [r2]（仅 rightRow），无 leftRow → 无配对 → r2 unmatched
    const r2unmatched = result.unmatchedRows.find((r) => r._rowId === 'r2');
    assert.ok(r2unmatched, 'r2 在 C2 入参无 leftRow → unmatched');
  });

  // case 12：C3 命中行后同行 C2 不再处理
  test('case 12：C3 命中行 → 锁定后 C2 同 channel 同行不再处理', () => {
    const scenarios = [
      makeC3Scenario({ id: 10, channelId: channels.icbc_sh.id, priority: 3 }),
      makeC2Scenario({ id: 11, channelId: channels.icbc_sh.id, priority: 1 })
    ];
    // r1：C3 能命中（金额 100 + 工商-上海）+ 同时是 C2 leftType A（type=A + OrderId=O1）
    // r2: 仅 C2 rightType B（type=B + OrderId=O1）
    const rows = [
      {
        _rowId: 'r1', Channel: '工商', 地区: '上海',
        'Credit Amount': 100, 'Debit Amount': 0,
        ReconciliationId: '',
        type: 'A', OrderId: 'O1', 'Remark-description': ''
      },
      {
        _rowId: 'r2', Channel: '工商', 地区: '上海',
        'Credit Amount': 0, 'Debit Amount': 0,
        ReconciliationId: '',
        type: 'B', OrderId: 'O1', 'Remark-description': ''
      }
    ];
    const gwRows = [{ Amount: 100, Reference: 'GW-A' }];
    const result = runAllScenarios(rows, gwRows, scenarios, makeDeps());

    // r1 应命中 C3（priority=3 优先）
    const r1 = result.modifiedRows.find((r) => r._rowId === 'r1');
    assert.ok(r1);
    assert.strictEqual(r1._hitScenarioId, 10, 'r1 命中 C3');
    // r2 在 C2 入参无 leftRow（r1 锁定）→ unmatched
    const r2 = result.unmatchedRows.find((r) => r._rowId === 'r2');
    assert.ok(r2, 'r2 unmatched');
  });

  // case 13：scenarios.name 跨 channel 同名允许（D39 验证，通过 dispatcher 间接验证）
  test('case 13：跨 channel 同名 scenarios 都能在 dispatcher 内正确归属各自 channel', () => {
    // 前置：跑 T42 UNIQUE migration 把 schema 从全表 UNIQUE(name) 切换到 (channel_id, name)
    // （test setupDb 只跑 ensureScenariosSupport，未跑 ensureScenariosNameUniqueByChannelId）
    const migResult = ensureScenariosNameUniqueByChannelId(db);
    assert.ok(['migrated', 'skipped', 'skipped-already-composite'].includes(migResult.status),
      `migration 必须成功，实际 status=${migResult.status} error=${migResult.error || 'n/a'}`);

    // 创建跨 channel 同名场景（D39 允许）— 用 SQL 直接 UPDATE channel_id 模拟 N7 import 已落库
    const s1Id = scenariosRepo.createScenario(db, {
      category: 'extract-recon-id',
      name: '对账场景',
      priority: 1,
      enabled: true,
      config: {
        conditions: [{ field: 'CustomerRef', op: '包含', value: 'AFT' }],
        extractByFeature: { enabled: true, searchFields: ['CustomerRef'], featureCode: 'FT', digitCount: 12, totalLength: 15 },
        extractByOtherField: null
      }
    }).id;
    db.prepare('UPDATE scenarios SET channel_id = ? WHERE id = ?').run(channels.icbc_sh.id, s1Id);

    // 第二个同名场景留在通用渠道（migration 后 UNIQUE (channel_id, name) 允许跨 channel 同名）
    const s2Id = scenariosRepo.createScenario(db, {
      category: 'extract-recon-id',
      name: '对账场景',  // 同名（不同 channel_id：通用 = 1，s1 = icbc-sh）→ migration 后允许
      priority: 1,
      enabled: true,
      config: {
        conditions: [{ field: 'CustomerRef', op: '包含', value: 'AFT' }],
        extractByFeature: { enabled: true, searchFields: ['CustomerRef'], featureCode: 'FT', digitCount: 12, totalLength: 15 },
        extractByOtherField: null
      }
    }).id;

    const allScenarios = scenariosRepo.listScenarios(db);
    const sameName = allScenarios.filter((s) => s.name === '对账场景');
    assert.strictEqual(sameName.length, 2, '跨 channel 同名场景共 2 条');
    assert.notStrictEqual(sameName[0].channelId, sameName[1].channelId, '两条 channelId 不同');

    // dispatcher 视角：拉完整 detail（含 config） + 跑双维调度
    const detailScenarios = sameName.map((s) => ({
      ...s,
      ...scenariosRepo.getScenario(db, s.id) // 加 config
    }));
    const rows = [
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, detailScenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1, '行命中');
    // 命中专属（icbc-sh）— 阶段 A 优先于阶段 B 通用
    assert.strictEqual(result.modifiedRows[0]._hitChannelId, channels.icbc_sh.id, '命中专属（阶段 A 优先）');
  });

  // case 14：全部场景在通用 + 行 matched 专属 → 阶段 A 空跑 → 阶段 B 兜底命中
  test('case 14：全部场景在通用 + 行匹配专属 → 阶段 A 空跑 → 阶段 B 通用命中 + fallback', () => {
    const scenarios = [
      // 仅通用 C1（无专属场景）
      makeC1Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      // 行匹配 工商-上海（专属）
      makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    const row = result.modifiedRows[0];
    assert.strictEqual(row._hitChannelId, channels.general.id, '阶段 B 命中通用');
    assert.strictEqual(row._matchedChannelId, channels.icbc_sh.id, '行仍 matched 专属');
    assert.strictEqual(row._fallbackChannelId, channels.general.id, '专属未命中 + 通用命中 → fallback 通用');
    assert.strictEqual(row._matchStatus, '命中', '行 matched 专属，状态=命中');
  });

  // case 15：全部场景在通用 + 行未 matched → 阶段 B 兜底
  test('case 15：全部场景在通用 + 行未 matched 任何渠道 → 阶段 B 命中（兜底）+ metadata 完整', () => {
    const scenarios = [
      makeC1Scenario({ id: 11, channelId: channels.general.id })
    ];
    const rows = [
      // 浦发-深圳 不在 channels 表
      makeBankRow({ rowId: 'r1', channel: '浦发', location: '深圳', customerRef: 'AFT123456789012' })
    ];
    const result = runAllScenarios(rows, null, scenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1);
    const row = result.modifiedRows[0];
    assert.strictEqual(row._matchStatus, '兜底', '未 matched → 兜底');
    assert.strictEqual(row._matchedChannelId, null, '未 matched 任何渠道 → matchedChannelId=null');
    assert.strictEqual(row._hitChannelId, channels.general.id, '兜底命中通用');
    assert.strictEqual(row._fallbackChannelId, null, '兜底场景：fallback=null（仅在 matched 专属命中通用时才记录）');
    assert.strictEqual(row._hitChannelKey, '浦发-深圳', '_hitChannelKey 保留原始审计 key');
  });
});

