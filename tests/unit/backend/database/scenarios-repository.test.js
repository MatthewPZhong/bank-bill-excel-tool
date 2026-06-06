// v2.1.9 N5 Phase 4 T17：scenarios-repository.listByChannelIdAndCategory 单元测试
//
// 范围：仅覆盖 v2.1.9 新增 API listByChannelIdAndCategory（全量 CRUD test 留 G1-cont T06e）
//
// 覆盖：
//   - channelId 不存在 → 空数组
//   - category 不存在 → 空数组
//   - 多个匹配 → 完整列表 + 排序正确（priority DESC, id ASC）
//   - enabled=0 场景被过滤
//   - displayIndex 1-based
//   - 返字段含 config（dispatcher 需要）
//   - 参数校验

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const scenariosRepo = require('../../../../src/backend/database/scenarios-repository');
const channelsRepo = require('../../../../src/backend/database/channels-repository');
const {
  ensureChannelsTable,
  ensureScenariosChannelIdColumn,
  ensureScenariosSupport,
  // v2.1.9 SR-FIX-1 T43 R1-R3：UNIQUE 复合迁移后 D39 行为验证
  ensureScenariosNameUniqueByChannelId,
  // v2.1.13 PR#58 P2-3：扩 category CHECK 含 'builtin-fixed'（否则 createScenario(builtin-fixed) 撞 CHECK）
  ensureScenariosCategoryBuiltinFixed
} = require('../../../../src/backend/database/migrations');

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
  // 注：不在共享 setupDb 里扩 builtin-fixed CHECK —— 该迁移会顺带建复合 UNIQUE，
  //   破坏 ensureScenariosNameUniqueByChannelId 的「首次跑 → migrated」测试。
  //   builtin-fixed CHECK 仅在需要它的 P2-3 describe 内按需调用（幂等）。
}

// 直接 UPDATE channel_id（createScenario 不支持指定 channel_id，本测试需指定渠道）
function setScenarioChannel(scenarioId, channelId) {
  db.prepare('UPDATE scenarios SET channel_id = ? WHERE id = ?').run(channelId, scenarioId);
}

function makeC1Payload(name, priority, enabled = true) {
  return {
    category: 'extract-recon-id',
    name,
    priority,
    enabled,
    config: {
      conditions: [{ field: 'CustomerRef', op: '包含', value: 'X' }],
      extractByFeature: null,
      extractByOtherField: { field: 'CustomerRef' }
    }
  };
}

function makeC2Payload(name, priority, enabled = true) {
  return {
    category: 'offset-bill-mark',
    name,
    priority,
    enabled,
    config: {
      billTypes: [{ seq: 1, field: 'FundType', op: '等于', value: 'A' }],
      reconFields: [{ seq: 1, leftType: 1, leftField: 'X', rightType: 2, rightField: 'X' }],
      markValue: { type: 1, field: 'FundType', value: 'B' }
    }
  };
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-repo-'));
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

test.describe('listByChannelIdAndCategory', () => {
  test('channelId 不存在 → 空数组', () => {
    scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    const list = scenariosRepo.listByChannelIdAndCategory(db, 99999, 'extract-recon-id');
    assert.deepStrictEqual(list, []);
  });

  test('category 不存在 → 空数组', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    setScenarioChannel(id, channels.icbc_sh.id);
    const list = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'no-such-category');
    assert.deepStrictEqual(list, []);
  });

  test('正常匹配 → 返完整 scenario（含 config + channelId + displayIndex）', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 2));
    setScenarioChannel(id, channels.icbc_sh.id);

    const list = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    assert.strictEqual(list.length, 1);
    const s = list[0];
    assert.strictEqual(s.id, id);
    assert.strictEqual(s.name, 's1');
    assert.strictEqual(s.priority, 2);
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.channelId, channels.icbc_sh.id);
    assert.strictEqual(s.displayIndex, 1, '1-based');
    assert.ok(s.config, 'dispatcher 需读 config');
    assert.strictEqual(s.category, 'extract-recon-id');
  });

  test('多个匹配 → 按 priority DESC, id ASC 排序', () => {
    // 创建顺序：s1(p1), s2(p3), s3(p2), s4(p3)
    // 预期排序：s2(p3, id 较小) → s4(p3) → s3(p2) → s1(p1)
    const r1 = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    const r2 = scenariosRepo.createScenario(db, makeC1Payload('s2', 3));
    const r3 = scenariosRepo.createScenario(db, makeC1Payload('s3', 2));
    const r4 = scenariosRepo.createScenario(db, makeC1Payload('s4', 3));
    [r1, r2, r3, r4].forEach(({ id }) => setScenarioChannel(id, channels.icbc_sh.id));

    const list = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    assert.strictEqual(list.length, 4);

    // 按 priority DESC：3, 3, 2, 1
    assert.deepStrictEqual(list.map(s => s.priority), [3, 3, 2, 1]);
    // 同 priority 内按 id ASC：s2(id<s4) → s4
    assert.strictEqual(list[0].id, r2.id);
    assert.strictEqual(list[1].id, r4.id);
    assert.strictEqual(list[2].id, r3.id);
    assert.strictEqual(list[3].id, r1.id);

    // displayIndex 1-based
    assert.deepStrictEqual(list.map(s => s.displayIndex), [1, 2, 3, 4]);
  });

  test('enabled=0 场景被过滤', () => {
    const e1 = scenariosRepo.createScenario(db, makeC1Payload('enabled1', 1, true));
    const d1 = scenariosRepo.createScenario(db, makeC1Payload('disabled1', 2, false));
    [e1, d1].forEach(({ id }) => setScenarioChannel(id, channels.icbc_sh.id));

    const list = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'enabled1');
  });

  test('channel 隔离：工商-上海下场景不应返回到招商-北京', () => {
    const sIcbc = scenariosRepo.createScenario(db, makeC1Payload('icbc', 1));
    const sCmb = scenariosRepo.createScenario(db, makeC1Payload('cmb', 1));
    setScenarioChannel(sIcbc.id, channels.icbc_sh.id);
    setScenarioChannel(sCmb.id, channels.cmb_bj.id);

    const icbcList = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    const cmbList = scenariosRepo.listByChannelIdAndCategory(db, channels.cmb_bj.id, 'extract-recon-id');
    assert.strictEqual(icbcList.length, 1);
    assert.strictEqual(icbcList[0].name, 'icbc');
    assert.strictEqual(cmbList.length, 1);
    assert.strictEqual(cmbList[0].name, 'cmb');
  });

  test('category 隔离：extract-recon-id 与 offset-bill-mark 不串', () => {
    const sC1 = scenariosRepo.createScenario(db, makeC1Payload('c1-s', 1));
    const sC2 = scenariosRepo.createScenario(db, makeC2Payload('c2-s', 1));
    [sC1, sC2].forEach(({ id }) => setScenarioChannel(id, channels.icbc_sh.id));

    const c1List = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    const c2List = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'offset-bill-mark');
    assert.strictEqual(c1List.length, 1);
    assert.strictEqual(c2List.length, 1);
    assert.strictEqual(c1List[0].category, 'extract-recon-id');
    assert.strictEqual(c2List[0].category, 'offset-bill-mark');
  });
});

test.describe('listByChannelIdAndCategory 参数校验', () => {
  test('channelId 非数字 → throw', () => {
    assert.throws(
      () => scenariosRepo.listByChannelIdAndCategory(db, 'not-a-number', 'extract-recon-id'),
      /channelId 必须是数字/
    );
  });

  test('channelId NaN → throw', () => {
    assert.throws(
      () => scenariosRepo.listByChannelIdAndCategory(db, NaN, 'extract-recon-id'),
      /channelId 必须是数字/
    );
  });

  test('category 非字符串 → throw', () => {
    assert.throws(
      () => scenariosRepo.listByChannelIdAndCategory(db, 1, null),
      /category 必须是非空字符串/
    );
  });

  test('category 空字符串 → throw', () => {
    assert.throws(
      () => scenariosRepo.listByChannelIdAndCategory(db, 1, ''),
      /category 必须是非空字符串/
    );
  });
});

// v2.1.9 N5 Phase 5 T23：转移 + 批量删除
//
// 覆盖：
//   - transferScenarios：单条 / 批量 / 跨渠道搬运语义（D4=a）/ 目标渠道不存在 / id 不存在 / 事务回滚 / 参数校验
//   - batchDelete：单条 / 批量 / is_builtin=1 阻止删除（DB 层保护）/ 事务回滚 / 参数校验
test.describe('transferScenarios', () => {
  test('单条转移：A 渠道场景搬运到 B 渠道（D4=a 语义）', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    setScenarioChannel(id, channels.icbc_sh.id);

    const result = scenariosRepo.transferScenarios(db, [id], channels.cmb_bj.id);
    assert.deepStrictEqual(result, {
      transferredCount: 1,
      targetChannelId: channels.cmb_bj.id
    });
    // 验证 D4=a 搬运语义：A 内不再存在；B 内有该场景
    const icbcList = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    const cmbList = scenariosRepo.listByChannelIdAndCategory(db, channels.cmb_bj.id, 'extract-recon-id');
    assert.strictEqual(icbcList.length, 0, 'A 内场景应消失');
    assert.strictEqual(cmbList.length, 1, 'B 内应有该场景');
    assert.strictEqual(cmbList[0].id, id);
  });

  test('批量转移：多个场景一次搬运到目标渠道', () => {
    const r1 = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    const r2 = scenariosRepo.createScenario(db, makeC1Payload('s2', 2));
    const r3 = scenariosRepo.createScenario(db, makeC1Payload('s3', 3));
    [r1, r2, r3].forEach(({ id }) => setScenarioChannel(id, channels.icbc_sh.id));

    const result = scenariosRepo.transferScenarios(db, [r1.id, r2.id, r3.id], channels.cmb_bj.id);
    assert.strictEqual(result.transferredCount, 3);

    const cmbList = scenariosRepo.listByChannelIdAndCategory(db, channels.cmb_bj.id, 'extract-recon-id');
    assert.strictEqual(cmbList.length, 3);
  });

  test('转移到「通用」渠道也合法（D2=c 兜底场景维护）', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    setScenarioChannel(id, channels.icbc_sh.id);

    // 注意：setupDb → ensureScenariosSupport 会 seed 1 个 builtin extract-recon-id 到通用 channel_id=1
    //   所以通用列表本身就有 1 个 builtin 场景；转移后应是 builtin + 新转入 s1 = 2 个
    const baseGeneralList = scenariosRepo.listByChannelIdAndCategory(db, channels.general.id, 'extract-recon-id');
    const baseCount = baseGeneralList.length;

    scenariosRepo.transferScenarios(db, [id], channels.general.id);
    const generalList = scenariosRepo.listByChannelIdAndCategory(db, channels.general.id, 'extract-recon-id');
    assert.strictEqual(generalList.length, baseCount + 1);
    assert.ok(generalList.some((s) => s.id === id), '新转入的 s1 应在通用列表中');
  });

  test('空数组 → throw 不动 DB', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    setScenarioChannel(id, channels.icbc_sh.id);

    assert.throws(
      () => scenariosRepo.transferScenarios(db, [], channels.cmb_bj.id),
      /scenarioIds 必须是非空数组/
    );
    // 验证 DB 未变（事务未启动 = 数据保持）
    const icbcList = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    assert.strictEqual(icbcList.length, 1);
  });

  test('targetChannelId 不存在 → throw + 事务回滚', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    setScenarioChannel(id, channels.icbc_sh.id);

    assert.throws(
      () => scenariosRepo.transferScenarios(db, [id], 99999),
      /目标渠道 id=99999 不存在/
    );
    // 事务回滚：A 内场景应仍存在
    const icbcList = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    assert.strictEqual(icbcList.length, 1);
  });

  test('其中一条 scenario id 不存在 → throw + 整批回滚', () => {
    const r1 = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    const r2 = scenariosRepo.createScenario(db, makeC1Payload('s2', 2));
    [r1, r2].forEach(({ id }) => setScenarioChannel(id, channels.icbc_sh.id));

    assert.throws(
      () => scenariosRepo.transferScenarios(db, [r1.id, r2.id, 99999], channels.cmb_bj.id),
      /场景 id=99999 不存在/
    );
    // 验证整批回滚：r1, r2 都未转移
    const icbcList = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    const cmbList = scenariosRepo.listByChannelIdAndCategory(db, channels.cmb_bj.id, 'extract-recon-id');
    assert.strictEqual(icbcList.length, 2, '事务回滚后 A 内 2 条仍在');
    assert.strictEqual(cmbList.length, 0, '事务回滚后 B 内 0 条');
  });

  test('targetChannelId 非数字 → throw', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    setScenarioChannel(id, channels.icbc_sh.id);
    assert.throws(
      () => scenariosRepo.transferScenarios(db, [id], 'not-a-number'),
      /targetChannelId 必须是正整数/
    );
  });

  test('targetChannelId <= 0 → throw', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    setScenarioChannel(id, channels.icbc_sh.id);
    assert.throws(
      () => scenariosRepo.transferScenarios(db, [id], 0),
      /targetChannelId 必须是正整数/
    );
  });

  test('scenarioIds 含非数字 → throw', () => {
    assert.throws(
      () => scenariosRepo.transferScenarios(db, ['abc'], channels.icbc_sh.id),
      /scenario id 必须是正整数/
    );
  });

  // v2.1.9 SR-FIX-1 v0.10 reverse sync（spec §16.3.1）：
  //   transferScenarios UPDATE channel_id 也是 (channel_id, name) UNIQUE 入口
  //   目标渠道已有同名场景 → 抛 friendly error（与 createScenario / updateScenario UX 一致）
  test('转移到已有同名的目标渠道 → 抛 friendly error + 事务回滚', () => {
    // 跑 migration 切到复合 UNIQUE（setupDb 默认仍是全表 UNIQUE）— 否则跨 channel 同名 createScenario 会被全表 UNIQUE 拦
    const r = ensureScenariosNameUniqueByChannelId(db);
    assert.ok(['migrated', 'skipped', 'skipped-already-composite'].includes(r.status));

    // setup: icbc_sh 有 name='对账场景' + cmb_bj 也有 name='对账场景'（v2.1.9 SR-FIX-1 后跨 channel 同名允许）
    //   createScenario 不传 channel_id → DB 默认 NULL；用 setScenarioChannel UPDATE 设定（与 case 13 / R1 模式一致）
    const sA = scenariosRepo.createScenario(db, makeC1Payload('对账场景', 1));
    setScenarioChannel(sA.id, channels.icbc_sh.id);
    const sB = scenariosRepo.createScenario(db, makeC1Payload('对账场景', 1));
    setScenarioChannel(sB.id, channels.cmb_bj.id);

    // 把 cmb_bj 的「对账场景」transfer 到 icbc_sh → 撞 (icbc_sh.id, '对账场景') UNIQUE
    assert.throws(
      () => scenariosRepo.transferScenarios(db, [sB.id], channels.icbc_sh.id),
      /目标渠道已有同名场景/,
      '抛 friendly error 而不是原始 SQLite UNIQUE 错误'
    );

    // 事务回滚验证：双方仍各 1 条同名场景，channel_id 不变
    const icbcRow = db.prepare('SELECT channel_id, name FROM scenarios WHERE id=?').get(sA.id);
    const cmbRow = db.prepare('SELECT channel_id, name FROM scenarios WHERE id=?').get(sB.id);
    assert.strictEqual(icbcRow.channel_id, channels.icbc_sh.id, '事务回滚后 sA 仍在 icbc_sh');
    assert.strictEqual(cmbRow.channel_id, channels.cmb_bj.id, '事务回滚后 sB 仍在 cmb_bj');
    assert.strictEqual(icbcRow.name, '对账场景');
    assert.strictEqual(cmbRow.name, '对账场景');
  });
});

test.describe('batchDelete', () => {
  test('单条删除非内置场景', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    const result = scenariosRepo.batchDelete(db, [id]);
    assert.deepStrictEqual(result, { deletedCount: 1 });
    assert.strictEqual(scenariosRepo.getScenario(db, id), null);
  });

  test('批量删除多条非内置场景', () => {
    const r1 = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    const r2 = scenariosRepo.createScenario(db, makeC1Payload('s2', 2));
    const r3 = scenariosRepo.createScenario(db, makeC1Payload('s3', 3));

    const result = scenariosRepo.batchDelete(db, [r1.id, r2.id, r3.id]);
    assert.strictEqual(result.deletedCount, 3);
    assert.strictEqual(scenariosRepo.getScenario(db, r1.id), null);
    assert.strictEqual(scenariosRepo.getScenario(db, r2.id), null);
    assert.strictEqual(scenariosRepo.getScenario(db, r3.id), null);
  });

  // v2.1.9 SR-FIX-1 round 2 F3（spec §16.3.4）：batchDelete 移除 is_builtin 检查
  //   原行为：内置场景阻止删除（与单条 deleteScenario 不一致）
  //   修订后：内置场景可删（与单条 deleteScenario 对齐 + USER_GUIDE 文档一致）
  test('内置场景（is_builtin=1）可删：与单条 deleteScenario 行为对齐（F3 修订）', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('builtin-s', 1));
    db.prepare('UPDATE scenarios SET is_builtin = 1 WHERE id = ?').run(id);

    const result = scenariosRepo.batchDelete(db, [id]);
    assert.strictEqual(result.deletedCount, 1, '内置场景被成功删除');
    assert.strictEqual(scenariosRepo.getScenario(db, id), null, '内置场景已不存在');
  });

  test('混合内置 + 非内置 → 全部删除（F3 修订后行为）', () => {
    const r1 = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    const r2 = scenariosRepo.createScenario(db, makeC1Payload('builtin-s', 2));
    db.prepare('UPDATE scenarios SET is_builtin = 1 WHERE id = ?').run(r2.id);

    const result = scenariosRepo.batchDelete(db, [r1.id, r2.id]);
    assert.strictEqual(result.deletedCount, 2, '内置 + 非内置 共 2 条全删');
    assert.strictEqual(scenariosRepo.getScenario(db, r1.id), null);
    assert.strictEqual(scenariosRepo.getScenario(db, r2.id), null);
  });

  test('空数组 → throw 不动 DB', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s1', 1));
    assert.throws(
      () => scenariosRepo.batchDelete(db, []),
      /scenarioIds 必须是非空数组/
    );
    assert.ok(scenariosRepo.getScenario(db, id));
  });

  test('scenarioIds 含 NaN → throw', () => {
    assert.throws(
      () => scenariosRepo.batchDelete(db, [NaN]),
      /scenario id 必须是正整数/
    );
  });

  test('id 不存在 → deletedCount = 0（不抛错；DELETE 幂等）', () => {
    // 与 transferScenarios 不同：DELETE 对不存在的 id 是 noop（SQL 语义）
    // batchDelete 不做存在性校验（只做内置场景保护）→ 不存在的 id 静默忽略
    const result = scenariosRepo.batchDelete(db, [99999]);
    assert.strictEqual(result.deletedCount, 0);
  });
});

// ========================================================================
// v2.1.9 SR-FIX-1 round 2 F1（spec §16.3.2）— createScenario 接受 channelId 入参
// ========================================================================
// 背景：原 createScenario INSERT 不写 channel_id 列 → 落 NULL → dispatcher
// listByChannelIdAndCategory(WHERE channel_id = ?) 不匹配 NULL → 用户新建场景在
// dispatcher 永远不命中（v2.1.9 N5 核心功能完全失效）。
//
// F1 修订：createScenario(db, payload) 增加可选 payload.channelId 入参
//   - 传 channelId=N → INSERT 落 channel_id=N
//   - 不传 / 非有限数字 → 兜底落 channel_id=1（通用），最小破坏面
test.describe('F1 — createScenario 接受 channelId 入参（spec §16.3.2）', () => {
  test('传 channelId=icbc_sh.id → INSERT 落 channel_id=icbc_sh.id', () => {
    const { id } = scenariosRepo.createScenario(db, Object.assign(
      makeC1Payload('s-with-channel', 1),
      { channelId: channels.icbc_sh.id }
    ));
    const row = db.prepare('SELECT channel_id FROM scenarios WHERE id = ?').get(id);
    assert.strictEqual(row.channel_id, channels.icbc_sh.id, '落对应 channel_id');
    // 验证 dispatcher hot path 能匹配
    const list = scenariosRepo.listByChannelIdAndCategory(db, channels.icbc_sh.id, 'extract-recon-id');
    assert.strictEqual(list.length, 1, 'listByChannelIdAndCategory 能查到');
    assert.strictEqual(list[0].id, id);
  });

  test('不传 channelId → 兜底落 channel_id=1（通用）', () => {
    const { id } = scenariosRepo.createScenario(db, makeC1Payload('s-no-channel', 1));
    const row = db.prepare('SELECT channel_id FROM scenarios WHERE id = ?').get(id);
    assert.strictEqual(row.channel_id, 1, '缺省兜底通用 id=1');
  });

  test('channelId 非有限数字（string）→ 兜底落 channel_id=1', () => {
    const { id } = scenariosRepo.createScenario(db, Object.assign(
      makeC1Payload('s-invalid-channel', 1),
      { channelId: 'invalid' }
    ));
    const row = db.prepare('SELECT channel_id FROM scenarios WHERE id = ?').get(id);
    assert.strictEqual(row.channel_id, 1, 'string channelId 兜底通用');
  });

  test('channelId=NaN → 兜底落 channel_id=1', () => {
    const { id } = scenariosRepo.createScenario(db, Object.assign(
      makeC1Payload('s-nan-channel', 1),
      { channelId: NaN }
    ));
    const row = db.prepare('SELECT channel_id FROM scenarios WHERE id = ?').get(id);
    assert.strictEqual(row.channel_id, 1, 'NaN channelId 兜底通用');
  });

  test('channelId=cmb_bj.id 跨 channel 创建 → list 查通用应返空', () => {
    scenariosRepo.createScenario(db, Object.assign(
      makeC1Payload('s-cmb-only', 1),
      { channelId: channels.cmb_bj.id }
    ));
    const generalList = scenariosRepo.listByChannelIdAndCategory(db, 1, 'extract-recon-id');
    // 通用只有 setupDb seed 的 builtin 场景（无新建的 s-cmb-only）
    assert.ok(!generalList.some((s) => s.name === 's-cmb-only'), '通用渠道不应见到 cmb_bj 专属场景');
    const cmbList = scenariosRepo.listByChannelIdAndCategory(db, channels.cmb_bj.id, 'extract-recon-id');
    assert.ok(cmbList.some((s) => s.name === 's-cmb-only'), 'cmb_bj 渠道应能查到');
  });
});

// 2026-05-27 N5 fix（资金红线）：getScenario 必须返 channelId 字段
// 防回归：dispatcher.groupScenariosByChannelId 依赖 scenario.channelId 切片；缺失会兜底
// 到 1（通用）导致非通用渠道场景被错应用到其他渠道行（用户报告 BOSH-CN 行被 CITI-HK 场景命中）
test.describe('getScenario channelId 字段（N5 资金红线防回归）', () => {
  test('转移到非通用渠道后：getScenario 返回 channelId = 该渠道 id（不是兜底 1）', () => {
    // 模拟生产路径：create（落通用 1）→ transferScenarios 搬到 CITI-HK
    // 这是用户实际操作路径（UI 选 CITI-HK 渠道 → 「新增场景」实质创建 + 落 channel_id=NULL/1
    //   → 通过 transferScenarios 落到目标渠道）
    const ch = channelsRepo.createChannel(db, { name: 'CITI', ownerLocation: 'HK' });
    const created = scenariosRepo.createScenario(db, makeC1Payload('citi-hk-scenario', 1));
    scenariosRepo.transferScenarios(db, [created.id], ch.id);
    const fetched = scenariosRepo.getScenario(db, created.id);
    assert.ok(fetched, 'getScenario 应返回对象');
    assert.strictEqual(fetched.channelId, ch.id, `channelId 应为 ${ch.id}（CITI-HK），而非兜底 1（通用）— 若兜底则 dispatcher 错应用到通用`);
  });

  test('通用渠道场景：getScenario 返回 channelId = 1', () => {
    const created = scenariosRepo.createScenario(db, makeC1Payload('general-scenario', 1));
    const fetched = scenariosRepo.getScenario(db, created.id);
    assert.strictEqual(fetched.channelId, 1);
  });
});

// 2026-05-27 N5 fix（防回归）：listScenarios displayIndex 必须按渠道分组 1-based
// 用户报告状态框显示「场景 7、8、9、10」但 UI 渠道内只有 4 个场景（序号 1-4）→ 串号
// 根因：旧 displayIndex 是全表 1-based，N5 引入渠道后 UI 渠道过滤显示渠道内 1-based → 两者不一致
test.describe('listScenarios displayIndex 按渠道分组 1-based（N5 防回归）', () => {
  test('同渠道内场景 displayIndex 连续 1-based（按 priority DESC + id ASC）', () => {
    // 注：beforeEach 已 seed 3 个内置场景到通用渠道，新增的场景接在后面
    // 关键不变量：渠道内 displayIndex 从 1 开始连续递增（无跳号）
    scenariosRepo.createScenario(db, makeC1Payload('user-1', 1));
    scenariosRepo.createScenario(db, makeC1Payload('user-2', 1));
    const list = scenariosRepo.listScenarios(db);
    const inGeneral = list.filter((s) => s.channelId === 1).sort((a, b) => a.displayIndex - b.displayIndex);
    // 所有通用场景 displayIndex 连续 1..N
    inGeneral.forEach((s, idx) => {
      assert.strictEqual(s.displayIndex, idx + 1, `通用渠道第 ${idx + 1} 个场景 displayIndex 应为 ${idx + 1}（实际 ${s.displayIndex}）`);
    });
  });

  test('多渠道：每个渠道 displayIndex 都从 1 开始（不是全表 1-N 跨渠道串号）', () => {
    const general = scenariosRepo.createScenario(db, makeC1Payload('g1', 3));
    scenariosRepo.createScenario(db, makeC1Payload('g2', 2));
    const ch1 = channelsRepo.createChannel(db, { name: 'CITI', ownerLocation: 'HK' });
    const ch2 = channelsRepo.createChannel(db, { name: 'BOSH', ownerLocation: 'CN' });
    const citi = scenariosRepo.createScenario(db, makeC1Payload('citi-1', 1));
    scenariosRepo.transferScenarios(db, [citi.id], ch1.id);
    const bosh1 = scenariosRepo.createScenario(db, makeC1Payload('bosh-1', 2));
    const bosh2 = scenariosRepo.createScenario(db, makeC1Payload('bosh-2', 1));
    scenariosRepo.transferScenarios(db, [bosh1.id, bosh2.id], ch2.id);

    const list = scenariosRepo.listScenarios(db);
    const byChannel = {};
    list.forEach((s) => {
      if (!byChannel[s.channelId]) byChannel[s.channelId] = [];
      byChannel[s.channelId].push({ name: s.name, displayIndex: s.displayIndex });
    });

    // 每个渠道内 displayIndex 都从 1 开始
    assert.strictEqual(byChannel[1][0].displayIndex, 1, '通用渠道第 1 个 displayIndex=1');
    assert.strictEqual(byChannel[ch1.id][0].displayIndex, 1, 'CITI-HK 第 1 个 displayIndex=1（不是续 3 或 4）');
    assert.strictEqual(byChannel[ch2.id][0].displayIndex, 1, 'BOSH-CN 第 1 个 displayIndex=1');
    assert.strictEqual(byChannel[ch2.id][1].displayIndex, 2, 'BOSH-CN 第 2 个 displayIndex=2');
  });
});

// v2.1.13 PR#58 review P2-3（🔴 对账场景号一致性）：listScenarios displayIndex 必须把 builtin-fixed 置顶
//   （每渠道内排在普通 priority 0-3 场景之前 → displayIndex=1），与场景管理弹窗展示序号一致。
//   否则 builtin-fixed priority=0 在 (priority DESC, id ASC) 里排最后 → run 路径状态栏 / 命中场景 sheet
//   的「场景序号」与 manager 不符。
test.describe('listScenarios displayIndex builtin-fixed 置顶（PR#58 P2-3 防回归）', () => {
  // 直接落一个 builtin-fixed 场景到指定渠道（createScenario 已允许该 category）
  function createBuiltinFixed(name, channelId, priority = 0) {
    // 幂等：首次调用扩 category CHECK 含 'builtin-fixed'（依赖 channel_id 列，setupDb 已建）
    ensureScenariosCategoryBuiltinFixed(db);
    const r = scenariosRepo.createScenario(db, {
      category: 'builtin-fixed',
      name,
      priority,
      enabled: true,
      config: {
        conditions: [{ field: 'CustomerRef', op: '包含', value: 'FT' }],
        conditionsLogic: 'OR',
        extractByFeature: { enabled: true, searchFields: ['CustomerRef'], featureCode: 'FT', digitCount: 12, totalLength: 15 },
        extractByOtherField: null
      },
      channelId
    });
    return r;
  }

  test('同渠道：builtin-fixed displayIndex=1，普通高优先级场景排其后', () => {
    // 通用渠道：1 个普通 p3 场景 + 1 个 builtin-fixed（p0）
    const normal = scenariosRepo.createScenario(db, makeC1Payload('normal-p3', 3));
    db.prepare('UPDATE scenarios SET channel_id = 1 WHERE id = ?').run(normal.id);
    const bf = createBuiltinFixed('写死提取', 1);

    const list = scenariosRepo.listScenarios(db);
    const bfItem = list.find((s) => s.id === bf.id);
    const normalItem = list.find((s) => s.id === normal.id);
    assert.strictEqual(bfItem.displayIndex, 1, 'builtin-fixed 置顶 → displayIndex=1（即便 priority=0）');
    // 普通 p3 场景 displayIndex 应大于 builtin-fixed（排其后）
    assert.ok(normalItem.displayIndex > bfItem.displayIndex,
      `普通场景 displayIndex(${normalItem.displayIndex}) 应排在 builtin-fixed(${bfItem.displayIndex}) 之后`);
  });

  test('返回数组顺序仍是 (priority DESC, id ASC)（manager stable sort 前提不破）', () => {
    // p3 普通(id 大) + builtin-fixed(p0, id 小) → 数组顺序应 普通(p3) 在前、builtin-fixed(p0) 在后
    const normal = scenariosRepo.createScenario(db, makeC1Payload('normal-p3', 3));
    db.prepare('UPDATE scenarios SET channel_id = 1 WHERE id = ?').run(normal.id);
    const bf = createBuiltinFixed('写死提取', 1);
    const list = scenariosRepo.listScenarios(db).filter((s) => s.channelId === 1);
    const idxNormal = list.findIndex((s) => s.id === normal.id);
    const idxBf = list.findIndex((s) => s.id === bf.id);
    assert.ok(idxNormal < idxBf,
      '数组顺序：priority 3 普通场景应排在 priority 0 builtin-fixed 之前（SQL 原序未变）');
    // 但 displayIndex 取值是 builtin-fixed 优先
    assert.ok(list[idxBf].displayIndex < list[idxNormal].displayIndex,
      'displayIndex 取值仍是 builtin-fixed 优先（与数组顺序解耦）');
  });

  test('多 builtin-fixed 同渠道：按 id ASC 取 1,2…，普通场景接其后', () => {
    const bf1 = createBuiltinFixed('写死A', 1);
    const bf2 = createBuiltinFixed('写死B', 1);
    const normal = scenariosRepo.createScenario(db, makeC1Payload('normal', 2));
    db.prepare('UPDATE scenarios SET channel_id = 1 WHERE id = ?').run(normal.id);
    const list = scenariosRepo.listScenarios(db).filter((s) => s.channelId === 1);
    const di = (id) => list.find((s) => s.id === id).displayIndex;
    // 两个 builtin-fixed 在前（id ASC → bf1 先 bf2 后），普通场景 displayIndex 更大
    assert.ok(di(bf1.id) < di(bf2.id), 'builtin-fixed 之间按 id ASC');
    assert.ok(di(bf2.id) < di(normal.id), '普通场景排在所有 builtin-fixed 之后');
    assert.strictEqual(di(bf1.id), 1, '第一个 builtin-fixed displayIndex=1');
  });
});

// v2.1.13 PR#58 review P3-1（场景号一致性收口）：C4（ReconID 修复）独立流水线，displayIndex 无人消费，
//   不得参与渠道内序号计数 —— 否则同渠道中间优先级的 C4 会顶偏银行场景 displayIndex（与银行弹窗 idx+1 串号）。
test.describe('listScenarios displayIndex 排除 C4（PR#58 P3-1 防回归）', () => {
  const { C4_CATEGORIES } = require('../../../../src/main-process/scenario-dispatcher');

  function makeC4Payload(name, priority) {
    return { category: 'recon-id-fix', name, priority, enabled: true, config: { note: 'c4-min' } };
  }

  // 不变量式断言（对 setup 是否 seed 默认场景免疫）：核心是「插入中间优先级 C4 不改变银行场景 displayIndex」
  test('加入中间优先级 C4 前后：同渠道银行场景 displayIndex 不变（C4 不顶偏）', () => {
    ensureScenariosCategoryBuiltinFixed(db); // 幂等扩 CHECK 至 6 类（允许 recon-id-fix）
    const c1 = scenariosRepo.createScenario(db, makeC1Payload('c1-p3', 3));
    setScenarioChannel(c1.id, 1);
    const c2 = scenariosRepo.createScenario(db, makeC2Payload('c2-p1', 1));
    setScenarioChannel(c2.id, 1);
    const before = scenariosRepo.listScenarios(db);
    const c1Before = before.find((s) => s.id === c1.id).displayIndex;
    const c2Before = before.find((s) => s.id === c2.id).displayIndex;

    // 插入 recon-id-fix(p2)，优先级介于 c1(p3) 与 c2(p1) 之间 —— 修复前会把 c2 顶偏 +1
    const c4 = scenariosRepo.createScenario(db, makeC4Payload('reconfix-p2', 2));
    setScenarioChannel(c4.id, 1);
    const after = scenariosRepo.listScenarios(db);
    assert.strictEqual(after.find((s) => s.id === c1.id).displayIndex, c1Before,
      'C4 加入后 C1(p3) displayIndex 不变');
    assert.strictEqual(after.find((s) => s.id === c2.id).displayIndex, c2Before,
      'C4 加入后 C2(p1) displayIndex 不变（中间优先级 C4 不占号）');
  });

  test('C4 自身 displayIndex 有效（自成分区，1-based，不被消费但需稳定非空）', () => {
    ensureScenariosCategoryBuiltinFixed(db); // 幂等扩 CHECK 至 6 类（允许 recon-id-fix）
    const c4a = scenariosRepo.createScenario(db, makeC4Payload('rf-a', 3));
    setScenarioChannel(c4a.id, 1);
    const c4b = scenariosRepo.createScenario(db, makeC4Payload('rf-b', 1));
    setScenarioChannel(c4b.id, 1);
    const list = scenariosRepo.listScenarios(db);
    const a = list.find((s) => s.id === c4a.id).displayIndex;
    const b = list.find((s) => s.id === c4b.id).displayIndex;
    assert.ok(Number.isFinite(a) && a >= 1, 'C4 displayIndex 有效 1-based');
    assert.ok(Number.isFinite(b) && b >= 1, 'C4 displayIndex 有效 1-based');
    // C4 自成分区从 1 起：两个 C4 占 1,2（与银行场景分区不互相挤号）
    assert.deepStrictEqual([a, b].sort(), [1, 2], 'C4 分区独立 1-based（与非C4 区互不占号）');
  });

  test('漂移守卫：repository C4 副本与 scenario-dispatcher C4_CATEGORIES 一致', () => {
    assert.deepStrictEqual(
      [...scenariosRepo.RECON_ID_FIX_DISPLAY_INDEX_CATEGORIES].sort(),
      [...C4_CATEGORIES].sort(),
      'repository 本地 C4 副本必须与 dispatcher C4_CATEGORIES 同步（否则新增 C4 类别会重新顶偏银行序号）'
    );
  });
});

// ========================================================================
// v2.1.9 SR-FIX-1 — spec §16.4 R1-R3 + ensureScenariosNameUniqueByChannelId migration
// ========================================================================
//
// 验收 spec §16.3 修订设计：
//   R1：同 channel 同 name 插入 → friendly error 抛
//   R2：跨 channel 同 name 插入 → 双方都落库成功（D39 验证）
//   R3：findByChannelAndName 隔离 — 跨 channel 同名查询仅返回指定 channel 的记录
//
// 加测 migration 行为：
//   - 首次跑：检测旧 UNIQUE(name) → 重建表 + 标志位 + 备份
//   - 重复跑：标志位命中 → skipped
//   - 老 UNIQUE 检测兼容：UNIQUE (name) 和 UNIQUE(name) 等空格变体都识别
test.describe('v2.1.9 SR-FIX-1 spec §16.4 — R1/R2/R3 + UNIQUE migration', () => {
  test('R1：同 channel 同 name 插入 → 抛 friendly error（兼容新旧 UNIQUE 错误）', () => {
    // 跑 migration 切到复合 UNIQUE（test setupDb 默认仍是全表 UNIQUE）
    const r = ensureScenariosNameUniqueByChannelId(db);
    assert.ok(['migrated', 'skipped', 'skipped-already-composite'].includes(r.status));

    // 第一条 — createScenario 不传 channel_id → DB 默认 NULL（须显式 UPDATE 到通用 id=1，
    //   因 SQLite UNIQUE 对 NULL 视为 distinct，否则同 channel 约束失效）
    const s1 = scenariosRepo.createScenario(db, makeC1Payload('同名场景', 1));
    db.prepare('UPDATE scenarios SET channel_id = 1 WHERE id = ?').run(s1.id);

    // 第二条同 channel 同 name → 通过 INSERT 直接测 schema 约束（绕开 createScenario 不传 channel_id 问题）
    //   验证 createScenario 的错误捕获：先用 raw INSERT 模拟约束冲突，再验 friendly error
    const now = new Date().toISOString();
    assert.throws(() => {
      try {
        db.prepare(`
          INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
          VALUES (?, 'extract-recon-id', '同名场景', 1, 1, '{}', 0, 1, ?, ?)
        `).run(s1.id + 100, now, now);
      } catch (err) {
        // 走 scenarios-repository.isScenarioNameUniqueError 校验路径
        if (scenariosRepo.isScenarioNameUniqueError(err)) {
          throw new Error(`场景名 "同名场景" 在该渠道下已存在，请换一个名字`);
        }
        throw err;
      }
    }, /场景名.+在该渠道下已存在/, 'friendly error 抛（兼容新 UNIQUE constraint failed: scenarios.channel_id, scenarios.name 错误消息）');
  });

  test('R2：跨 channel 同 name 插入 → 双方落库成功（D39）', () => {
    const r = ensureScenariosNameUniqueByChannelId(db);
    assert.ok(['migrated', 'skipped', 'skipped-already-composite'].includes(r.status));

    // 通用渠道创建「跨渠道场景」
    const s1 = scenariosRepo.createScenario(db, makeC1Payload('跨渠道场景', 1));
    assert.ok(s1.id);

    // 第二条同名 → 转移到工商-上海
    const s2 = scenariosRepo.createScenario(db, makeC1Payload('跨渠道场景-tmp', 1));
    // 直接 UPDATE 改 channel_id + name（绕开 createScenario 不支持 channel_id 的限制）
    db.prepare('UPDATE scenarios SET channel_id = ?, name = ? WHERE id = ?').run(
      channels.icbc_sh.id, '跨渠道场景', s2.id
    );

    const all = scenariosRepo.listScenarios(db);
    const sameName = all.filter((s) => s.name === '跨渠道场景');
    assert.strictEqual(sameName.length, 2, '跨 channel 同名共 2 条全部落库');
    const channelIds = sameName.map((s) => s.channelId).sort();
    assert.deepStrictEqual(channelIds, [1, channels.icbc_sh.id].sort(), '两条分别在通用 + 工商-上海');
  });

  test('R3：findByChannelAndName 跨 channel 同名查询仅返回指定 channel 的记录', () => {
    const r = ensureScenariosNameUniqueByChannelId(db);
    assert.ok(['migrated', 'skipped', 'skipped-already-composite'].includes(r.status));

    // 同 name 跨 channel 各落 1 条
    const s1 = scenariosRepo.createScenario(db, makeC1Payload('查询测试', 1));
    // createScenario 不传 channel_id → 默认 NULL → 显式 UPDATE 到通用 id=1
    db.prepare('UPDATE scenarios SET channel_id = 1 WHERE id = ?').run(s1.id);

    const s2 = scenariosRepo.createScenario(db, makeC1Payload('查询测试-tmp', 1));
    db.prepare('UPDATE scenarios SET channel_id = ?, name = ? WHERE id = ?').run(
      channels.icbc_sh.id, '查询测试', s2.id
    );

    // 查通用 → 返回 s1
    const fromGeneral = scenariosRepo.findByChannelAndName(db, 1, '查询测试');
    assert.ok(fromGeneral, '通用渠道有「查询测试」');
    assert.strictEqual(fromGeneral.id, s1.id);
    assert.strictEqual(fromGeneral.channelId, 1);

    // 查 icbc-sh → 返回 s2
    const fromIcbc = scenariosRepo.findByChannelAndName(db, channels.icbc_sh.id, '查询测试');
    assert.ok(fromIcbc);
    assert.strictEqual(fromIcbc.id, s2.id);
    assert.strictEqual(fromIcbc.channelId, channels.icbc_sh.id);

    // 查招商-北京（无此场景）→ null
    const fromCmb = scenariosRepo.findByChannelAndName(db, channels.cmb_bj.id, '查询测试');
    assert.strictEqual(fromCmb, null);

    // 参数校验
    assert.throws(() => scenariosRepo.findByChannelAndName(db, 'abc', '查询测试'),
      /channelId 必须是正整数/);
    assert.throws(() => scenariosRepo.findByChannelAndName(db, 1, ''),
      /name 不能为空/);
  });

  test('migration：首次跑 → migrated；标志位写入 + scenarios 表结构改为复合 UNIQUE', () => {
    const r = ensureScenariosNameUniqueByChannelId(db);
    assert.strictEqual(r.status, 'migrated', '首次跑应 migrated');

    // 标志位写入
    const marker = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?')
      .get('n5_scenarios_unique_migrated');
    assert.ok(marker);
    assert.strictEqual(marker.setting_value, 'true');

    // 表结构含 UNIQUE (channel_id, name)
    const tableSqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'").get();
    assert.match(tableSqlRow.sql, /UNIQUE\s*\(\s*channel_id\s*,\s*name\s*\)/);
  });

  test('migration：第二次跑 → skipped（标志位幂等）', () => {
    ensureScenariosNameUniqueByChannelId(db); // 首次
    const r = ensureScenariosNameUniqueByChannelId(db); // 二次
    assert.strictEqual(r.status, 'skipped', '二次应 skipped');
  });
});
