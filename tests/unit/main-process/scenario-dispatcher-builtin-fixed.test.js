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
const scenariosRepo = require('../../../src/backend/database/scenarios-repository');
const {
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureScenariosSupport,
  // v2.1.13 PR#58 P2-3：扩 category CHECK 含 'builtin-fixed'（createScenario(builtin-fixed) 需要）
  ensureScenariosCategoryBuiltinFixed
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

// v2.1.13 PR#58 review P2-3（🔴 对账场景号一致性）：run 路径 displayIndex 与 manager 一致
//   端到端：真实 listScenarios() → 按 main.js bank-statement:run 同款方式组装 dispatchScenarios →
//   runAllScenarios → 命中 builtin-fixed 的 displayIndex 必须 = 1（与场景管理弹窗置顶序号一致），
//   而不是 (priority DESC, id ASC) 下的末位序号。
test.describe('P2-3 run 路径 builtin-fixed displayIndex 对齐 manager（端到端真实 listScenarios）', () => {
  function seedBuiltinFixed(name, channelId) {
    ensureScenariosCategoryBuiltinFixed(db); // 幂等
    const r = scenariosRepo.createScenario(db, {
      category: 'builtin-fixed',
      name,
      priority: 0,
      enabled: true,
      channelId,
      config: {
        conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
        conditionsLogic: 'OR',
        extractByFeature: { enabled: true, searchFields: ['CustomerRef'], featureCode: 'FT', digitCount: 12, totalLength: 15 },
        extractByOtherField: null
      }
    });
    return r;
  }
  function seedC1(name, channelId, priority) {
    const r = scenariosRepo.createScenario(db, {
      category: 'extract-recon-id',
      name,
      priority,
      enabled: true,
      channelId,
      config: { conditions: [{ field: 'CustomerRef', op: '包含', value: 'ZZZ' }], extractByFeature: null, extractByOtherField: { field: 'CustomerRef' } }
    });
    return r;
  }

  // 复刻 src/main.js bank-statement:run 的场景组装（list item 的 displayIndex/channelId + getScenario 的 config）
  function buildDispatchScenarios() {
    const all = scenariosRepo.listScenarios(db);
    const enabled = all.filter((s) => s.enabled === 1 || s.enabled === true);
    return enabled.map((s) => {
      const detail = scenariosRepo.getScenario(db, s.id);
      if (!detail) return null;
      const applicableChannelIds = detail.category === 'builtin-fixed'
        ? scenariosRepo.getApplicableChannelIds(db, s.id)
        : null;
      return { ...detail, displayIndex: s.displayIndex, channelId: s.channelId, _applicableChannelIds: applicableChannelIds };
    }).filter(Boolean);
  }

  test('通用渠道：builtin-fixed(p0) + 普通 C1(p3) 同时启用 → 命中 builtin-fixed 的 displayIndex=1', () => {
    // beforeEach 的 ensureScenariosSupport 会 seed 3 个内置场景（含一个 FT 特征提取场景，priority 3）。
    //   为隔离测 builtin-fixed 命中，先清空 seed，只留本测试创建的两个场景。
    db.exec('DELETE FROM scenarios');
    const c1 = seedC1('普通高优先级', 1, 3); // 条件 ZZZ，不命中本测试的行
    const bf = seedBuiltinFixed('写死提取', 1); // FT 特征提取，命中本测试的行

    // sanity：listScenarios displayIndex builtin-fixed=1，普通 C1 > 1（即便 C1 priority 更高）
    const list = scenariosRepo.listScenarios(db).filter((s) => s.channelId === 1);
    const bfDi = list.find((s) => s.id === bf.id).displayIndex;
    const c1Di = list.find((s) => s.id === c1.id).displayIndex;
    assert.strictEqual(bfDi, 1, 'listScenarios：builtin-fixed displayIndex=1');
    assert.ok(c1Di > 1, 'listScenarios：普通 C1 排在 builtin-fixed 之后');

    // 构造只命中 builtin-fixed（FT 特征）的行；普通 C1 条件是 ZZZ 不会命中
    const rows = [makeBankRow({ rowId: 'r1', channel: '工商', location: '上海', customerRef: 'AFT123456789012' })];
    const dispatchScenarios = buildDispatchScenarios();
    const result = runAllScenarios(rows, null, dispatchScenarios, makeDeps());

    assert.strictEqual(result.modifiedRows.length, 1, 'builtin-fixed 应命中该行');
    assert.strictEqual(result.modifiedRows[0]._hitScenarioId, bf.id, '命中的应是 builtin-fixed');
    // 命中行的 _hitScenarioDisplayIndex（写 hit-scenario sheet 的「场景序号」）= 1
    assert.strictEqual(result.modifiedRows[0]._hitScenarioDisplayIndex, 1,
      '命中行 displayIndex 应=1（与 manager 置顶序号一致，而非 priority 末位序号）');
    // stats.hitScenarios（状态栏「命中场景 [N] name」）= displayIndex 1
    const hit = result.stats.hitScenarios.find((h) => h.id === bf.id);
    assert.ok(hit, 'hitScenarios 应含 builtin-fixed');
    assert.strictEqual(hit.displayIndex, 1, '状态栏命中场景 displayIndex 应=1');
  });

  test('回归对照：若按 (priority DESC, id ASC) 算（未修复），builtin-fixed displayIndex 会是末位（>1）', () => {
    // 固化「修复前后差异」：同样的数据，旧口径下 builtin-fixed(p0) 排最后。
    db.exec('DELETE FROM scenarios');
    seedC1('普通A', 1, 3);
    seedC1('普通B', 1, 2);
    const bf = seedBuiltinFixed('写死提取', 1);
    const list = scenariosRepo.listScenarios(db).filter((s) => s.channelId === 1);
    // 修复后：builtin-fixed=1
    assert.strictEqual(list.find((s) => s.id === bf.id).displayIndex, 1);
    // 旧口径（priority DESC, id ASC）下 builtin-fixed 会是第 3 位 —— 用纯计算复现对照，确认修复确实改变了序号
    const oldOrder = [...list].sort((a, b) => (b.priority - a.priority) || (a.id - b.id));
    const oldDiOfBf = oldOrder.findIndex((s) => s.id === bf.id) + 1;
    assert.ok(oldDiOfBf > 1, `旧口径 builtin-fixed displayIndex=${oldDiOfBf}（>1）→ 修复把它纠正为 1`);
  });
});
