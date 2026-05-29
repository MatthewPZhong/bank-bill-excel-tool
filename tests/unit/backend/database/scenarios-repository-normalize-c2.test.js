// v2.1.11 T3（spec §4.2 / PRD §2.3 D-T3-mig=a）：C2「银行对账单字段赋值」老数据惰性迁移单测
//
// 覆盖：
//   - normalizeC2Config 纯函数：旧单条件 → conditions / 已是新结构幂等 / 非 C2（无 billTypes）不动
//   - DB 往返：旧结构 config 插入 → getScenario / listByChannelIdAndCategory 读取时惰性迁移为 conditions

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const scenariosRepo = require('../../../../src/backend/database/scenarios-repository');
const {
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureScenariosSupport
} = require('../../../../src/backend/database/migrations');

const { normalizeC2Config } = scenariosRepo;

// ========================================================================
// normalizeC2Config — 纯函数
// ========================================================================

test.describe('normalizeC2Config — 纯函数', () => {
  test('旧单条件 {seq,field,op,value} → conditions:[{...}]（删顶层 field/op/value）', () => {
    const cfg = {
      billTypes: [
        { seq: 1, field: 'FundType', op: '等于', value: 'outbound Fail' },
        { seq: 2, field: 'FundType', op: '等于', value: 'outbound' }
      ],
      reconFields: [{ seq: 1, leftType: 1, leftField: 'CustomerRef', rightType: 2, rightField: 'CustomerRef' }],
      markValue: { type: 2, field: 'FundType', value: 'outbound Fail' }
    };
    const out = normalizeC2Config(cfg);
    assert.deepEqual(out.billTypes[0], { seq: 1, conditions: [{ field: 'FundType', op: '等于', value: 'outbound Fail' }] });
    assert.deepEqual(out.billTypes[1], { seq: 2, conditions: [{ field: 'FundType', op: '等于', value: 'outbound' }] });
    // 顶层旧字段已删除
    assert.equal(out.billTypes[0].field, undefined);
    assert.equal(out.billTypes[0].op, undefined);
    assert.equal(out.billTypes[0].value, undefined);
    // 其它字段不动
    assert.deepEqual(out.reconFields, cfg.reconFields);
    assert.deepEqual(out.markValue, cfg.markValue);
  });

  test('已是 conditions 结构 → 幂等', () => {
    const cfg = {
      billTypes: [
        { seq: 1, conditions: [
          { field: 'FundType', op: '等于', value: 'outbound Fail' },
          { field: 'Currency', op: '等于', value: 'USD' }
        ] }
      ],
      reconFields: [],
      markValue: { type: 1, field: 'FundType', value: 'x' }
    };
    const out = normalizeC2Config(cfg);
    assert.deepEqual(out.billTypes[0].conditions, [
      { field: 'FundType', op: '等于', value: 'outbound Fail' },
      { field: 'Currency', op: '等于', value: 'USD' }
    ]);
    // 二次归一化幂等
    assert.deepEqual(normalizeC2Config(out), out);
  });

  test('缺字段防御：conditions 内 op/value 缺省补齐', () => {
    const cfg = { billTypes: [{ seq: 1, conditions: [{ field: 'a' }] }] };
    const out = normalizeC2Config(cfg);
    assert.deepEqual(out.billTypes[0].conditions, [{ field: 'a', op: '等于', value: '' }]);
  });

  test('非 C2 / 无 billTypes config → 原样返回（不动）', () => {
    const c1Cfg = { conditions: [{ field: 'x', op: '等于', value: 'y' }], conditionsLogic: 'AND' };
    assert.strictEqual(normalizeC2Config(c1Cfg), c1Cfg);
    // null / 非对象
    assert.strictEqual(normalizeC2Config(null), null);
    assert.strictEqual(normalizeC2Config(undefined), undefined);
  });

  test('billTypes 内含非对象元素 → 原样保留该元素（不崩）', () => {
    const cfg = { billTypes: [null, { seq: 1, field: 'a', op: '等于', value: 'x' }] };
    const out = normalizeC2Config(cfg);
    assert.strictEqual(out.billTypes[0], null);
    assert.deepEqual(out.billTypes[1].conditions, [{ field: 'a', op: '等于', value: 'x' }]);
  });
});

// ========================================================================
// DB 往返：旧结构插入 → 读取时惰性迁移
// ========================================================================

let tmpDir;
let dbPath;
let db;

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

test.describe('C2 DB 往返惰性迁移', () => {
  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-normalize-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
    db = new DatabaseSync(dbPath);
    setupDb();
  });

  test.afterEach(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('旧结构 config 插入 → getScenario 读取得 conditions', () => {
    // 直接以旧单条件结构写入 config_json（模拟 v2.1.10 及以前持久化数据）
    const oldConfig = {
      billTypes: [{ seq: 1, field: 'FundType', op: '等于', value: 'outbound' }],
      reconFields: [],
      markValue: { type: 1, field: 'FundType', value: 'outbound Fail' }
    };
    const created = scenariosRepo.createScenario(db, {
      category: 'offset-bill-mark',
      name: 'C2-old',
      priority: 1,
      enabled: true,
      config: oldConfig,
      channelId: 1
    });
    const detail = scenariosRepo.getScenario(db, created.id);
    assert.deepEqual(detail.config.billTypes[0], { seq: 1, conditions: [{ field: 'FundType', op: '等于', value: 'outbound' }] });
    // 顶层旧字段已被迁移掉
    assert.equal(detail.config.billTypes[0].field, undefined);
  });

  test('listByChannelIdAndCategory 读取 C2 → 所有 billTypes 已迁移为 conditions（含内置 seed 场景）', () => {
    // ensureScenariosSupport seed 了 1 个内置 C2 场景（旧单条件结构）→ 读取也应迁移
    scenariosRepo.createScenario(db, {
      category: 'offset-bill-mark',
      name: 'C2-list',
      priority: 2,
      enabled: true,
      config: {
        billTypes: [{ seq: 1, field: 'Channel', op: '包含', value: 'NET' }],
        reconFields: [],
        markValue: { type: 1, field: 'FundType', value: 'x' }
      },
      channelId: 1
    });
    const list = scenariosRepo.listByChannelIdAndCategory(db, 1, 'offset-bill-mark');
    // 至少含我新建的 + 内置 seed 场景
    assert.ok(list.length >= 2, `期望 ≥ 2 条 C2（含内置 seed），实际 ${list.length}`);
    // 所有 C2 的每个 billType 都应是 conditions 结构（无残留顶层 field/op/value）
    for (const sc of list) {
      for (const bt of (sc.config.billTypes || [])) {
        assert.ok(Array.isArray(bt.conditions), `场景「${sc.name}」billType 应有 conditions 数组`);
        assert.equal(bt.field, undefined, `场景「${sc.name}」billType 顶层 field 应已迁移删除`);
      }
    }
    // 我新建的那条 conditions 正确
    const mine = list.find((s) => s.name === 'C2-list');
    assert.ok(mine, '应找到新建的 C2-list 场景');
    assert.deepEqual(mine.config.billTypes[0].conditions, [{ field: 'Channel', op: '包含', value: 'NET' }]);
  });
});
