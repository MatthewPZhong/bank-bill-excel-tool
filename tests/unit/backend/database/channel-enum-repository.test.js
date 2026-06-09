// v2.1.16-beta.3 ①：Channel 枚举字典仓储单测（UT-C1~C9）
//
// 覆盖：单行双值 / 地区空只落 channel / Channel 空跳过 / 去重幂等累加 / 13 字段常量守护 /
//       listChannelEnumValues 按 type 过滤 / 计数口径 / 多地区组合 / null 与纯空格归一。
// 🔴 纯审计沉淀，不删/不改对账数据。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const channelEnumRepo = require('../../../../src/backend/database/channel-enum-repository');
const { BANK_DEPOSIT_FIELDS } = require('../../../../src/backend/database/linked-table-repository');
const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-enum-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 直接查库（绕过仓储，验证落库真相）
function rowFor(valueType, enumValue) {
  return db
    .prepare('SELECT * FROM channel_enum_values WHERE value_type = ? AND enum_value = ?')
    .get(valueType, enumValue);
}
function countAll() {
  return db.prepare('SELECT COUNT(*) AS c FROM channel_enum_values').get().c;
}

test.describe('channel-enum-repository（v2.1.16-beta.3 ①）', () => {
  // UT-C1：单行 Channel+地区均非空 → channel 与 channel-region 两条
  test('UT-C1：Channel+地区均非空 → 同时落 channel 与 channel-region', () => {
    channelEnumRepo.recordFromBankStatementRows(db, [{ Channel: 'JPM', 地区: 'HK' }]);
    assert.ok(rowFor('channel', 'JPM'), '有 channel=JPM');
    assert.ok(rowFor('channel-region', 'JPM-HK'), '有 channel-region=JPM-HK');
    assert.equal(countAll(), 2);
  });

  // UT-C2：🔴 地区空只落 channel（无 'JPM-' 脏值）
  test('UT-C2：地区空只落 channel，无 JPM- 脏值', () => {
    channelEnumRepo.recordFromBankStatementRows(db, [{ Channel: 'JPM', 地区: '' }]);
    assert.ok(rowFor('channel', 'JPM'), '有 channel=JPM');
    assert.equal(rowFor('channel-region', 'JPM-'), undefined, '无 channel-region=JPM-（脏值）');
    // 也不能有任何 channel-region 记录
    const cr = channelEnumRepo.listChannelEnumValues(db, 'channel-region');
    assert.equal(cr.length, 0, '无任何 channel-region 记录');
  });

  // UT-C3：Channel 空跳过整行
  test('UT-C3：Channel 空跳过整行（无任何记录）', () => {
    channelEnumRepo.recordFromBankStatementRows(db, [
      { Channel: '', 地区: 'HK' },
      { Channel: '   ', 地区: 'US' }, // 纯空格也算空
      { Channel: null, 地区: 'JP' }
    ]);
    assert.equal(countAll(), 0, 'Channel 空（含空格/null）的行不产生任何记录');
  });

  // UT-C4：去重幂等（两批同值 → 不重复行；count 累加；last 刷新；first 不变）
  test('UT-C4：去重幂等 — 两批同值不重复行，count 累加，last 刷新，first 不变', () => {
    channelEnumRepo.recordFromBankStatementRows(db, [{ Channel: 'JPM', 地区: 'HK' }]);
    const before = rowFor('channel', 'JPM');
    assert.equal(before.seen_count, 1);

    // 不同时间戳：稍后再导一批同值
    channelEnumRepo.recordFromBankStatementRows(db, [{ Channel: 'JPM', 地区: 'HK' }]);
    const after = rowFor('channel', 'JPM');

    assert.equal(countAll(), 2, '仍只有 channel=JPM 与 channel-region=JPM-HK 两条（UNIQUE 生效）');
    assert.equal(after.seen_count, 2, 'seen_count 累加');
    assert.equal(after.first_seen_at, before.first_seen_at, 'first_seen_at 不变');
    assert.ok(after.last_seen_at >= before.last_seen_at, 'last_seen_at 刷新（>=）');
  });

  // UT-C5：🔴 13 字段常量 ∈ BANK_STATEMENT_FIELDS（防漂移）
  test('UT-C5：BANK_DEPOSIT_FIELDS 全部 ∈ BANK_STATEMENT_FIELDS（防常量漂移）', () => {
    assert.equal(BANK_DEPOSIT_FIELDS.length, 13);
    assert.ok(
      BANK_DEPOSIT_FIELDS.every((f) => BANK_STATEMENT_FIELDS.includes(f)),
      '13 字段必须全部存在于 BANK_STATEMENT_FIELDS'
    );
  });

  // UT-C6：listChannelEnumValues 按 type 过滤
  test('UT-C6：listChannelEnumValues 按 type 过滤（channel 不含 channel-region）', () => {
    channelEnumRepo.recordFromBankStatementRows(db, [
      { Channel: 'JPM', 地区: 'HK' },
      { Channel: 'ACI', 地区: 'US' }
    ]);
    const ch = channelEnumRepo.listChannelEnumValues(db, 'channel');
    const cr = channelEnumRepo.listChannelEnumValues(db, 'channel-region');
    assert.deepEqual(ch.map((r) => r.enumValue), ['ACI', 'JPM'], 'channel 仅渠道值，ORDER BY ASC');
    assert.deepEqual(cr.map((r) => r.enumValue), ['ACI-US', 'JPM-HK'], 'channel-region 仅拼接值');
    assert.ok(!ch.some((r) => r.enumValue.includes('-')), 'channel 类不含拼接值');
  });

  // UT-C7：计数口径（同批 3 行同 channel 值 → seen_count=3）
  test('UT-C7：同批 3 行同 channel 值 → seen_count=3（去重前出现行数累加）', () => {
    channelEnumRepo.recordFromBankStatementRows(db, [
      { Channel: 'JPM', 地区: 'HK' },
      { Channel: 'JPM', 地区: 'HK' },
      { Channel: 'JPM', 地区: 'HK' }
    ]);
    assert.equal(rowFor('channel', 'JPM').seen_count, 3, 'channel JPM 累加 3');
    assert.equal(rowFor('channel-region', 'JPM-HK').seen_count, 3, 'channel-region JPM-HK 累加 3');
  });

  // UT-C8：多种地区组合（JPM-HK / JPM-US 两条独立 channel-region，channel 仅一条 JPM）
  test('UT-C8：多地区组合 → channel-region 两条独立，channel 仅一条 JPM', () => {
    channelEnumRepo.recordFromBankStatementRows(db, [
      { Channel: 'JPM', 地区: 'HK' },
      { Channel: 'JPM', 地区: 'US' }
    ]);
    const ch = channelEnumRepo.listChannelEnumValues(db, 'channel');
    const cr = channelEnumRepo.listChannelEnumValues(db, 'channel-region');
    assert.deepEqual(ch.map((r) => r.enumValue), ['JPM'], 'channel 仅一条 JPM');
    assert.equal(rowFor('channel', 'JPM').seen_count, 2, 'JPM channel 累加 2（两行都有 channel）');
    assert.deepEqual(cr.map((r) => r.enumValue), ['JPM-HK', 'JPM-US'], '两条独立 channel-region');
  });

  // UT-C9：null / 纯空格归一（地区纯空格按空处理跳过拼接；Channel 前后空格 trim 后比较）
  test('UT-C9：null/纯空格归一 — 地区空格跳过拼接；Channel 前后空格 trim 合并', () => {
    channelEnumRepo.recordFromBankStatementRows(db, [
      { Channel: 'JPM', 地区: '   ' },   // 地区纯空格 → 跳过 channel-region
      { Channel: '  JPM  ', 地区: 'HK' }  // Channel 前后空格 → trim 后与上行同值
    ]);
    // channel=JPM 合并为一条（两行 trim 后同值），seen_count=2
    const ch = channelEnumRepo.listChannelEnumValues(db, 'channel');
    assert.deepEqual(ch.map((r) => r.enumValue), ['JPM'], 'Channel 前后空格 trim 后合并为一条');
    assert.equal(rowFor('channel', 'JPM').seen_count, 2);
    // channel-region 仅第二行（HK）一条；第一行地区空格被跳过
    const cr = channelEnumRepo.listChannelEnumValues(db, 'channel-region');
    assert.deepEqual(cr.map((r) => r.enumValue), ['JPM-HK'], '地区纯空格行不产生 channel-region');
  });

  // recordValue 直接调用：空值跳过返回 false
  test('recordValue：空值（trim 后空）跳过、返回 false', () => {
    const now = new Date().toISOString();
    assert.equal(channelEnumRepo.recordValue(db, 'channel', '', now), false);
    assert.equal(channelEnumRepo.recordValue(db, 'channel', '   ', now), false);
    assert.equal(channelEnumRepo.recordValue(db, 'channel', null, now), false);
    assert.equal(countAll(), 0);
    // 非空 → true
    assert.equal(channelEnumRepo.recordValue(db, 'channel', 'X', now), true);
    assert.equal(countAll(), 1);
  });

  // facade 串联（database.recordChannelEnumFromBankStatement / listChannelEnumValues）
  test('facade：recordChannelEnumFromBankStatement + listChannelEnumValues（AC1-8）', () => {
    appDb.recordChannelEnumFromBankStatement([{ Channel: 'JPM', 地区: 'HK' }]);
    assert.deepEqual(appDb.listChannelEnumValues('channel').map((r) => r.enumValue), ['JPM']);
    assert.deepEqual(appDb.listChannelEnumValues('channel-region').map((r) => r.enumValue), ['JPM-HK']);
  });

  // 🔴 不阻断导入语义守护：沉淀内部抛错时上抛（由 handler try-catch 吞）。
  //   这里验证「facade 调用对损坏 rows 不静默吞、但单行容错」——
  //   非数组 rows 视作空批（无记录、不抛），保证 handler 不因入参形态崩。
  test('recordFromBankStatementRows：非数组 rows 视作空批（不抛、无记录）', () => {
    assert.doesNotThrow(() => channelEnumRepo.recordFromBankStatementRows(db, null));
    assert.doesNotThrow(() => channelEnumRepo.recordFromBankStatementRows(db, undefined));
    assert.equal(countAll(), 0);
  });

  // 🔴 AC1-7 前提守护：DB 异常时 recordFromBankStatementRows 上抛（ROLLBACK 后），
  //   由 main.js handler 的 try-catch 吞掉 → 导入仍 status:'ok'。这里用 fake db 注入异常验证「会上抛」。
  test('recordFromBankStatementRows：DB 异常上抛（ROLLBACK）— handler 层据此 try-catch 吞', () => {
    const calls = [];
    const fakeDb = {
      exec(sql) { calls.push(sql); }, // BEGIN / COMMIT / ROLLBACK 记录
      prepare() {
        return { run() { throw new Error('injected DB error'); } };
      }
    };
    assert.throws(
      () => channelEnumRepo.recordFromBankStatementRows(fakeDb, [{ Channel: 'JPM', 地区: 'HK' }]),
      /injected DB error/,
      '内部异常应上抛（交给 handler try-catch）'
    );
    assert.ok(calls.includes('BEGIN'), '已 BEGIN');
    assert.ok(calls.includes('ROLLBACK'), '异常后 ROLLBACK（不残留半截事务）');
    assert.ok(!calls.includes('COMMIT'), '未 COMMIT');
  });

  // ===== v3.0.0 需求1：extractChannelRegionCombos（纯函数，状态框「渠道-地区」前缀数据源）=====
  // 覆盖：空 rows / Channel 空跳过 / 地区空只产 channel / 去重 + 排序 / CITI-HK·JPM-US 混合 /
  //       与 recordFromBankStatementRows 同拼接口径 / facade 透传。
  test.describe('extractChannelRegionCombos（v3.0.0 需求1）', () => {
    // UT-E1：空 / 非数组 rows → []
    test('UT-E1：空数组 / null / undefined → []', () => {
      assert.deepEqual(channelEnumRepo.extractChannelRegionCombos([]), []);
      assert.deepEqual(channelEnumRepo.extractChannelRegionCombos(null), []);
      assert.deepEqual(channelEnumRepo.extractChannelRegionCombos(undefined), []);
    });

    // UT-E2：Channel 空（含纯空格 / null）→ 跳过整行（不产出组合）
    test('UT-E2：Channel 空（含空格/null）跳过整行 → []', () => {
      assert.deepEqual(
        channelEnumRepo.extractChannelRegionCombos([
          { Channel: '', 地区: 'HK' },
          { Channel: '   ', 地区: 'US' },
          { Channel: null, 地区: 'JP' },
          { Channel: undefined, 地区: 'SG' }
        ]),
        []
      );
    });

    // UT-E3：🔴 地区空（含纯空格 / null）→ 只产出 Channel（无 'CITI-' 脏值）
    test('UT-E3：地区空只产出 Channel，不生成带短横脏值', () => {
      assert.deepEqual(
        channelEnumRepo.extractChannelRegionCombos([
          { Channel: 'CITI', 地区: '' },
          { Channel: 'JPM', 地区: '   ' },
          { Channel: 'ACI', 地区: null }
        ]),
        ['ACI', 'CITI', 'JPM'] // 仅 Channel，去重 + 排序；无 'CITI-' / 'JPM-' / 'ACI-'
      );
    });

    // UT-E4：地区非空 → 产出 Channel-地区
    test('UT-E4：Channel+地区均非空 → 产出 Channel-地区', () => {
      assert.deepEqual(
        channelEnumRepo.extractChannelRegionCombos([{ Channel: 'CITI', 地区: 'HK' }]),
        ['CITI-HK']
      );
    });

    // UT-E5：多组合去重 + 稳定排序（CITI-HK / JPM-US 混合，重复行折叠）
    test('UT-E5：多组合去重 + 排序（CITI-HK、JPM-US 混合）', () => {
      const combos = channelEnumRepo.extractChannelRegionCombos([
        { Channel: 'JPM', 地区: 'US' },
        { Channel: 'CITI', 地区: 'HK' },
        { Channel: 'JPM', 地区: 'US' }, // 重复 → 折叠
        { Channel: 'CITI', 地区: 'HK' }  // 重复 → 折叠
      ]);
      assert.deepEqual(combos, ['CITI-HK', 'JPM-US'], '去重后两组合，字典序稳定排序');
    });

    // UT-E6：同 Channel 多地区 + 同地区多 Channel 混合，去重排序
    test('UT-E6：同 Channel 多地区 + 地区空行混合', () => {
      const combos = channelEnumRepo.extractChannelRegionCombos([
        { Channel: 'JPM', 地区: 'HK' },
        { Channel: 'JPM', 地区: 'US' },
        { Channel: 'JPM', 地区: '' },   // 地区空 → 产出 'JPM'
        { Channel: 'CITI', 地区: 'HK' }
      ]);
      assert.deepEqual(combos, ['CITI-HK', 'JPM', 'JPM-HK', 'JPM-US']);
    });

    // UT-E7：Channel / 地区前后空格 trim 后参与拼接（与 recordFromBankStatementRows 同口径）
    test('UT-E7：Channel/地区前后空格 trim 后拼接', () => {
      assert.deepEqual(
        channelEnumRepo.extractChannelRegionCombos([{ Channel: '  CITI  ', 地区: '  HK  ' }]),
        ['CITI-HK']
      );
    });

    // UT-E8：🔴 与 recordFromBankStatementRows 拼接口径一致（channel-region 集合 ∪ 地区空行的 channel）
    //   对账：组合集合 = 落库 channel-region 全集 + 「仅出现在地区空行」的 channel
    test('UT-E8：与 recordFromBankStatementRows 落库 channel-region 口径一致', () => {
      const rows = [
        { Channel: 'CITI', 地区: 'HK' },
        { Channel: 'JPM', 地区: 'US' },
        { Channel: 'ACI', 地区: '' } // 地区空 → 组合只产 'ACI'，落库 channel=ACI 但无 channel-region
      ];
      channelEnumRepo.recordFromBankStatementRows(db, rows);
      const dbCr = channelEnumRepo
        .listChannelEnumValues(db, 'channel-region')
        .map((r) => r.enumValue); // ['CITI-HK', 'JPM-US']
      const combos = channelEnumRepo.extractChannelRegionCombos(rows);
      // 组合集合应包含全部落库 channel-region
      for (const cr of dbCr) assert.ok(combos.includes(cr), `组合应含落库 channel-region ${cr}`);
      // 地区空行的 channel（ACI）以 channel 形态出现在组合里，但不在 channel-region 落库里
      assert.ok(combos.includes('ACI'), '地区空行产出纯 channel 组合 ACI');
      assert.ok(!dbCr.includes('ACI'), '地区空行不落 channel-region（无脏值）');
      assert.deepEqual(combos, ['ACI', 'CITI-HK', 'JPM-US']);
    });

    // UT-E9：非对象行（null / 字符串 / 数字）安全跳过，不抛
    test('UT-E9：rows 含非对象元素安全跳过', () => {
      assert.deepEqual(
        channelEnumRepo.extractChannelRegionCombos([
          null,
          'not-an-object',
          42,
          { Channel: 'CITI', 地区: 'HK' }
        ]),
        ['CITI-HK']
      );
    });

    // facade 透传：database.extractChannelRegionCombos
    test('facade：appDb.extractChannelRegionCombos 透传一致', () => {
      const rows = [
        { Channel: 'JPM', 地区: 'US' },
        { Channel: 'CITI', 地区: 'HK' }
      ];
      assert.deepEqual(appDb.extractChannelRegionCombos(rows), ['CITI-HK', 'JPM-US']);
      assert.deepEqual(appDb.extractChannelRegionCombos([]), []);
    });
  });
});
