// v3.0.7 需求6（🔴 资金红线）：网关账单表「按 Channel 集合下推过滤读」仓储单测。
//
// 背景：bank-statement:run 旧用 readLinkedTableRows('gateway-bill') 全量读 + structuredClone 深拷网关表，
//   网关表可达数百万行 → 低配 Windows 内存尖峰卡死。新增 readGatewayBillRowsByChannels 把
//   「Channel∈本批银行单出现过的渠道集合」下推到 SQL（json_extract），只物化涉及渠道子集。
//
// 🔴 业务不变量（已确认）：对账永远同 Channel → 只需 Channel∈channels 的网关行（不漏任一合法匹配）。
//   本测试钉死仓储三陷阱（漏一即漏对账，见 changes/v3.0.7-run-linked-memory-fix/spec.md §四）：
//     ① 只回指定 Channel 行（其它渠道排除）；
//     ② channels 含空值 → 回「Channel=空串」+「缺 Channel 字段（json_extract→NULL）」两种边界行；
//        不含空值 → 这两种都不回；
//     ③ 归一化口径（前后空格 trim / 大小写敏感）与引擎 normalizeCellValue 一致；
//     ④ 空集 channels → []（不查表、不全表读）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-channel-filter-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 直接灌网关行：raw_json 存整行（与生产 createInsertContext 一致，verbatim 不裁字段）；
//   id 自增决定 ORDER BY id ASC 顺序。fields 可省略 Channel 键以模拟「缺 Channel 字段」边界。
//   ⚠️ 生产导入路径对每格过 normalizeCell（String().trim()）——本工厂直接传「已归一化」值模拟落库后形态。
function insertGwRaw(fields) {
  const raw = JSON.stringify(fields);
  db.prepare(
    `INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)`
  ).run(fields.reconciliationid || '', fields.Billdate || '', raw, '2026-06-16T00:00:00.000Z');
}

function reconIds(rows) {
  return rows.map((r) => r.reconciliationid).sort();
}

test.describe('readGatewayBillRowsByChannels（v3.0.7 需求6）', () => {
  test('① 只回指定 Channel 行（其它渠道排除）', () => {
    insertGwRaw({ reconciliationid: 'G1', Channel: 'BOSH', Billdate: '2026-06-01' });
    insertGwRaw({ reconciliationid: 'G2', Channel: 'JPM', Billdate: '2026-06-01' });
    insertGwRaw({ reconciliationid: 'G3', Channel: 'BOSH', Billdate: '2026-06-02' });
    insertGwRaw({ reconciliationid: 'G4', Channel: 'ICBC', Billdate: '2026-06-02' });

    const got = linkedRepo.readGatewayBillRowsByChannels(db, ['BOSH']);
    assert.deepEqual(reconIds(got), ['G1', 'G3'], '仅 Channel=BOSH 的 G1+G3');

    const multi = linkedRepo.readGatewayBillRowsByChannels(db, ['BOSH', 'JPM']);
    assert.deepEqual(reconIds(multi), ['G1', 'G2', 'G3'], 'BOSH+JPM 三行（ICBC 排除）');
  });

  test('① 全行还原为对象、保留全部字段、ORDER BY id ASC（导入原序）', () => {
    insertGwRaw({ reconciliationid: 'A', Channel: 'BOSH', amount: '100', extra: 'x' });
    insertGwRaw({ reconciliationid: 'B', Channel: 'BOSH', amount: '200', extra: 'y' });
    const got = linkedRepo.readGatewayBillRowsByChannels(db, ['BOSH']);
    assert.equal(got.length, 2);
    assert.equal(got[0].reconciliationid, 'A', '原序：先插的 A 在前');
    assert.equal(got[1].reconciliationid, 'B');
    assert.deepEqual(got[0], { reconciliationid: 'A', Channel: 'BOSH', amount: '100', extra: 'x' }, '整行字段无裁剪');
  });

  test('② channels 含空值 → 回「Channel=空串」+「缺 Channel 字段」两种边界行', () => {
    insertGwRaw({ reconciliationid: 'NB', Channel: 'BOSH' });        // 非空 Channel
    insertGwRaw({ reconciliationid: 'EMPTY', Channel: '' });          // Channel=空串
    insertGwRaw({ reconciliationid: 'MISSING' });                     // 缺 Channel 字段（json_extract→NULL）

    // channels 含空值（''）→ 应回 EMPTY + MISSING（两种边界），不含空值的 BOSH 行此查询不返回
    const blankOnly = linkedRepo.readGatewayBillRowsByChannels(db, ['']);
    assert.deepEqual(reconIds(blankOnly), ['EMPTY', 'MISSING'], '空值集回空串行 + 缺字段行');

    // channels = BOSH + 空值 → 三行全回（NB 的 Channel=BOSH）
    const mixed = linkedRepo.readGatewayBillRowsByChannels(db, ['BOSH', '']);
    assert.deepEqual(reconIds(mixed), ['EMPTY', 'MISSING', 'NB'], 'BOSH + 空值 → 三行全回');
  });

  test('② channels 不含空值 → 空串行 + 缺字段行都不回', () => {
    insertGwRaw({ reconciliationid: 'NB', Channel: 'BOSH' });
    insertGwRaw({ reconciliationid: 'EMPTY', Channel: '' });
    insertGwRaw({ reconciliationid: 'MISSING' });

    const got = linkedRepo.readGatewayBillRowsByChannels(db, ['BOSH']);
    assert.deepEqual(reconIds(got), ['NB'], '不含空值 → 仅 BOSH，空串/缺字段行不回');
  });

  test('③ 归一化：channels 内值过 trim（前后空格） + 大小写敏感', () => {
    insertGwRaw({ reconciliationid: 'BOSH-row', Channel: 'BOSH' });   // 网关侧已归一化（落库时 normalizeCell trim）
    insertGwRaw({ reconciliationid: 'bosh-low', Channel: 'bosh' });   // 小写：大小写敏感不应被 'BOSH' 命中

    // channels 传带前后空格 → 内部 String().trim() 后 = 'BOSH' → 命中 BOSH-row
    const trimmed = linkedRepo.readGatewayBillRowsByChannels(db, ['  BOSH  ']);
    assert.deepEqual(reconIds(trimmed), ['BOSH-row'], 'channels 前后空格被 trim 后命中 BOSH');

    // 大小写敏感：'BOSH' 不命中 'bosh'
    const caseSensitive = linkedRepo.readGatewayBillRowsByChannels(db, ['BOSH']);
    assert.deepEqual(reconIds(caseSensitive), ['BOSH-row'], '大小写敏感：BOSH 不回 bosh 行');

    // 反向：'bosh' 只回小写行
    const lower = linkedRepo.readGatewayBillRowsByChannels(db, ['bosh']);
    assert.deepEqual(reconIds(lower), ['bosh-low'], '大小写敏感：bosh 只回 bosh 行');
  });

  test('③ channels 去重 + 含 null/undefined 归一为空值口径', () => {
    insertGwRaw({ reconciliationid: 'NB', Channel: 'BOSH' });
    insertGwRaw({ reconciliationid: 'MISSING' });
    // [null, undefined, 'BOSH', 'BOSH'] → 去重归一为 {'', 'BOSH'} → 回 BOSH 行 + 缺字段行
    const got = linkedRepo.readGatewayBillRowsByChannels(db, [null, undefined, 'BOSH', 'BOSH']);
    assert.deepEqual(reconIds(got), ['MISSING', 'NB'], 'null/undefined→空值 + BOSH，去重不重复');
  });

  test('④ 空集 channels → []（不查表）', () => {
    insertGwRaw({ reconciliationid: 'G1', Channel: 'BOSH' });
    assert.deepEqual(linkedRepo.readGatewayBillRowsByChannels(db, []), [], '空数组 → []');
    assert.deepEqual(linkedRepo.readGatewayBillRowsByChannels(db, null), [], 'null → []');
    assert.deepEqual(linkedRepo.readGatewayBillRowsByChannels(db, undefined), [], 'undefined → []');
  });

  test('🔴 损坏 raw_json 行被 json_valid 守卫排除、不中断整批（资金红线 run 路径不崩）', () => {
    insertGwRaw({ reconciliationid: 'GOOD', Channel: 'BOSH' });
    // 手动灌一条坏 JSON：json_extract 对它本会抛 "malformed JSON" 中断整条查询，
    //   WHERE 内 json_valid(raw_json) 短路守卫把它排除在 json_extract 求值之外 → 查询不崩、坏行不回。
    db.prepare(
      `INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)`
    ).run('', '', '{不是合法json', '2026-06-16T00:00:00.000Z');

    // ['BOSH', ''] 同时走 IN + IS NULL 分支（坏行 json_extract 会触发求值）→ 验 json_valid 守卫生效不抛
    const got = linkedRepo.readGatewayBillRowsByChannels(db, ['BOSH', '']);
    assert.deepEqual(reconIds(got), ['GOOD'], '坏 JSON 行被 json_valid 排除，仅 GOOD 还原，查询不抛');
  });

  test('facade database.readGatewayBillRowsByChannels 转发一致', () => {
    insertGwRaw({ reconciliationid: 'G1', Channel: 'BOSH' });
    insertGwRaw({ reconciliationid: 'G2', Channel: 'JPM' });
    const viaFacade = appDb.readGatewayBillRowsByChannels(['BOSH']);
    assert.deepEqual(reconIds(viaFacade), ['G1'], 'facade 与仓储同口径');
  });
});

test.describe('readGatewayBillRowPoolsByChannels（v3.0.23 C3 专用大小写不敏感预筛）', () => {
  test('一次查询返回 exactRows 与 C3 trim+NOCASE 池，近似渠道不误入', () => {
    insertGwRaw({ reconciliationid: 'EXACT', Channel: 'Maybank' });
    insertGwRaw({ reconciliationid: 'UPPER', Channel: 'MAYBANK' });
    insertGwRaw({ reconciliationid: 'LOWER', Channel: 'maybank' });
    insertGwRaw({ reconciliationid: 'SPACED', Channel: '  Maybank  ' });
    insertGwRaw({ reconciliationid: 'NEAR', Channel: 'MAYBANK2' });

    let prepareCount = 0;
    const countingDb = {
      prepare(sql) {
        prepareCount += 1;
        return db.prepare(sql);
      }
    };
    const pools = linkedRepo.readGatewayBillRowPoolsByChannels(countingDb, [' Maybank ']);

    assert.equal(prepareCount, 1, '双池必须由一次 SQL 查询生成');
    assert.deepEqual(pools.exactRows.map((r) => r.reconciliationid), ['EXACT']);
    assert.deepEqual(
      pools.c3Rows.map((r) => r.reconciliationid),
      ['EXACT', 'UPPER', 'LOWER', 'SPACED'],
      'C3 接受大小写/首尾空格差异，但不接受 MAYBANK2'
    );
    assert.strictEqual(pools.exactRows[0], pools.c3Rows[0], '同行在两个池中共享对象引用');
  });

  test('exactRows 保留旧空值口径，C3 额外接受网关空白字符串', () => {
    insertGwRaw({ reconciliationid: 'EMPTY', Channel: '' });
    insertGwRaw({ reconciliationid: 'SPACES', Channel: '   ' });
    insertGwRaw({ reconciliationid: 'MISSING' });
    insertGwRaw({ reconciliationid: 'OTHER', Channel: 'JPM' });

    const pools = linkedRepo.readGatewayBillRowPoolsByChannels(db, ['']);
    assert.deepEqual(pools.exactRows.map((r) => r.reconciliationid), ['EMPTY', 'MISSING']);
    assert.deepEqual(pools.c3Rows.map((r) => r.reconciliationid), ['EMPTY', 'SPACES', 'MISSING']);
  });

  test('坏 JSON 跳过且空入参返回两个空池', () => {
    insertGwRaw({ reconciliationid: 'GOOD', Channel: 'MAYBANK' });
    db.prepare(
      `INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)`
    ).run('', '', '{broken-json', '2026-07-21T00:00:00.000Z');

    const pools = linkedRepo.readGatewayBillRowPoolsByChannels(db, ['Maybank']);
    assert.deepEqual(pools.exactRows, []);
    assert.deepEqual(pools.c3Rows.map((r) => r.reconciliationid), ['GOOD']);
    assert.deepEqual(linkedRepo.readGatewayBillRowPoolsByChannels(db, []), { exactRows: [], c3Rows: [] });
    assert.deepEqual(linkedRepo.readGatewayBillRowPoolsByChannels(db, null), { exactRows: [], c3Rows: [] });
  });

  test('facade 转发双池结果', () => {
    insertGwRaw({ reconciliationid: 'MIXED', Channel: 'MAYBANK' });
    const pools = appDb.readGatewayBillRowPoolsByChannels(['Maybank']);
    assert.deepEqual(pools.exactRows, []);
    assert.deepEqual(pools.c3Rows.map((r) => r.reconciliationid), ['MIXED']);
  });
});
