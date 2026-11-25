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
const { normalizeCellValue } = require('../../../../src/main-process/scenario-engines/engine-utils');
const { buildR5ChannelMissingDiagnosticPrefilter } = require('../../../../src/main-process/scenario-engines/r5-fund-transfer-backfill');

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

test.describe('readGatewayBillRowPoolsByChannels outOfPoolDiagnostic（v3.2.22 R5s2 缺渠道诊断与读池同一次扫描）', () => {
  const FT = ['FundTransfer-in', 'FundTransfer-out'];
  const ids = (rows) => rows.map((r) => r.reconciliationid);
  const rowsOf = (collected) => collected.map((entry) => entry.row);
  const diagnostic = (collected, extra = {}) => ({
    outOfPoolDiagnostic: {
      tradeTypes: FT,
      accounts: ['GW-1'],
      collect: (row, rowId) => { collected.push({ row, rowId }); },
      ...extra
    }
  });
  const seed = () => {
    const ft = (reconciliationid, extra) => insertGwRaw({
      reconciliationid, TradeType: 'FundTransfer-in', merchantid: 'GW-1', Billdate: '2026-06-01', ...extra
    });
    ft('MISSING', {});
    ft('EMPTY', { Channel: '' });
    ft('SPACES', { Channel: '   ' });
    ft('TAB', { Channel: '\t' });
    ft('IDEOGRAPHIC', { Channel: '　' });
    ft('NBSP-JPM', { Channel: '\u00a0JPM' });
    ft('JPM', { Channel: 'JPM' });
    ft('LOWER-JPM', { Channel: 'jpm' });
    ft('CITI', { Channel: 'CITI' });
    ft('SKIP', { Channel: '' });
    insertGwRaw({ reconciliationid: 'OUT-PADDED', TradeType: '　FundTransfer-out\t', merchantid: 'GW-1', Channel: '' });
    insertGwRaw({ reconciliationid: 'PAYMENT', TradeType: 'Payment', merchantid: 'GW-1', Channel: '' });
    insertGwRaw({ reconciliationid: 'OTHER-ACCOUNT', TradeType: 'FundTransfer-in', merchantid: 'GW-2', Channel: '' });
    db.prepare(
      `INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)`
    ).run('BAD', '2026-06-01', '{bad json', '2026-06-16T00:00:00.000Z');
  };
  const idOf = (reconciliationid) => db.prepare(
    `SELECT id FROM linked_gateway_bill WHERE json_extract(raw_json, '$.reconciliationid') = ?`
  ).get(reconciliationid).id;

  test('银行批次都有渠道：池外 = 空渠道（缺字段 / 空串 / 任意 JS 空白）+ 大小写或空白不同 / 银行侧未出现的渠道；一次查询、按 id 顺序交 collect', () => {
    seed();
    let prepareCount = 0;
    const countingDb = { prepare(sql) { prepareCount += 1; return db.prepare(sql); } };
    const collected = [];
    const pools = linkedRepo.readGatewayBillRowPoolsByChannels(countingDb, ['JPM'], diagnostic(collected));
    assert.equal(prepareCount, 1, '池与池外诊断候选由同一条 SQL 生成');
    assert.deepEqual(Object.keys(pools), ['exactRows', 'c3Rows'], '仓储不累积诊断候选，返回结构不变');
    assert.deepEqual(ids(pools.exactRows), ['JPM']);
    assert.deepEqual(ids(pools.c3Rows), ['JPM', 'LOWER-JPM']);
    const expected = ['MISSING', 'EMPTY', 'SPACES', 'TAB', 'IDEOGRAPHIC', 'NBSP-JPM', 'LOWER-JPM', 'CITI', 'SKIP', 'OUT-PADDED'];
    assert.deepEqual(ids(rowsOf(collected)), expected,
      'TradeType 按 JS trim 同口径预筛；非调拨行、账号不在映射内的行与池内 JPM 行不交 collect');
    assert.deepEqual(collected.map((entry) => entry.rowId), expected.map(idOf), 'collect 拿到的是该行的表 id');
    assert.strictEqual(pools.c3Rows[1], collected[6].row, 'C3 池与诊断候选共享同一次解析');
    const viaFacade = [];
    appDb.readGatewayBillRowPoolsByChannels([' JPM '], diagnostic(viaFacade));
    assert.deepEqual(ids(rowsOf(viaFacade)), expected, 'facade 透传');
  });

  test('银行批次含空渠道：缺字段 / 空串已在池内，池外只剩其余空白与银行侧未出现的渠道', () => {
    seed();
    const collected = [];
    linkedRepo.readGatewayBillRowPoolsByChannels(db, ['', 'JPM'], diagnostic(collected));
    assert.deepEqual(ids(rowsOf(collected)), ['SPACES', 'TAB', 'IDEOGRAPHIC', 'NBSP-JPM', 'LOWER-JPM', 'CITI']);
  });

  test('与 exactRows 严格互补、不改变两个池', () => {
    seed();
    const all = ['MISSING', 'EMPTY', 'SPACES', 'TAB', 'IDEOGRAPHIC', 'NBSP-JPM', 'JPM', 'LOWER-JPM', 'CITI', 'SKIP', 'OUT-PADDED', 'PAYMENT', 'OTHER-ACCOUNT'];
    for (const channels of [['JPM'], [''], ['', 'JPM'], ['CITI', 'JPM'], ['　']]) {
      const plain = linkedRepo.readGatewayBillRowPoolsByChannels(db, channels);
      const collected = [];
      const pools = linkedRepo.readGatewayBillRowPoolsByChannels(db, channels,
        diagnostic(collected, { tradeTypes: [...FT, 'Payment'], accounts: ['GW-1', 'GW-2'] }));
      assert.deepEqual(Object.keys(plain), ['exactRows', 'c3Rows'], '未请求诊断时返回结构不变');
      assert.deepEqual(ids(pools.exactRows), ids(plain.exactRows), `${JSON.stringify(channels)} exactRows 不变`);
      assert.deepEqual(ids(pools.c3Rows), ids(plain.c3Rows), `${JSON.stringify(channels)} c3Rows 不变`);
      const inPool = ids(pools.exactRows);
      const outOfPool = ids(rowsOf(collected));
      assert.deepEqual(inPool.filter((id) => outOfPool.includes(id)), [], `${JSON.stringify(channels)} 不重叠`);
      assert.deepEqual([...inPool, ...outOfPool].sort(), all.slice().sort(), `${JSON.stringify(channels)} 合起来覆盖全部有效行`);
    }
  });

  test('账号预筛是精确判据的超集：文本按 JS trim 比对，非文本值与含 JSON 转义（NUL 等）的行交 collect 判断', () => {
    const row = (reconciliationid, merchantid) => insertGwRaw({ reconciliationid, TradeType: 'FundTransfer-out', Channel: '', merchantid });
    row('PADDED', '　GW-1\t');
    row('NUMBER', 123);
    row('NUL', 'A\u0000B');
    row('LITERAL', 'A_x0000_B');
    row('CTRL-OTHER', 'Z\u0001');
    row('UNRELATED', 'GW-9');
    row('NULL-ACCOUNT', null);
    insertGwRaw({ reconciliationid: 'MISSING-ACCOUNT', TradeType: 'FundTransfer-out', Channel: '' });
    const collected = [];
    linkedRepo.readGatewayBillRowPoolsByChannels(db, ['JPM'], diagnostic(collected, { accounts: ['GW-1', '123', 'A\u0000B'] }));
    assert.deepEqual(ids(rowsOf(collected)), ['PADDED', 'NUMBER', 'NUL', 'CTRL-OTHER'],
      '不相关的文本账号、字面 _x0000_、缺账号与 null 账号在 SQL 端即排除；其余交 collect 精确判断');
  });

  test('零命中的大表：诊断只增加同一次扫描的条件，不交 collect、不多一次全表扫描', () => {
    const insert = db.prepare(
      `INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)`
    );
    const total = 20000;
    db.exec('BEGIN');
    for (let i = 0; i < total; i += 1) {
      const kind = i % 4;
      const fields = kind === 0
        ? { reconciliationid: `IN-${i}`, TradeType: 'FundTransfer-in', merchantid: 'GW-1', Channel: 'JPM' }
        : kind === 1
          ? { reconciliationid: `PAY-${i}`, TradeType: 'Payment', merchantid: 'GW-1', Channel: '' }
          : kind === 2
            ? { reconciliationid: `OTHER-${i}`, TradeType: 'FundTransfer-out', merchantid: 'GW-2', Channel: 'CITI' }
            : { reconciliationid: `BLANK-${i}`, TradeType: 'FundTransfer-out', merchantid: `GW-X${i}`, Channel: '' };
      insert.run(fields.reconciliationid, '2026-06-01', JSON.stringify(fields), '2026-06-16T00:00:00.000Z');
    }
    db.exec('COMMIT');
    const statements = [];
    const countingDb = { prepare(sql) { statements.push(sql); return db.prepare(sql); } };
    const collected = [];
    const pools = linkedRepo.readGatewayBillRowPoolsByChannels(countingDb, ['JPM'], diagnostic(collected));
    assert.equal(statements.length, 1);
    assert.equal(pools.exactRows.length, total / 4);
    assert.equal(collected.length, 0, '粗筛不过的行不交 collect');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all();
    const tableSteps = plan.filter((step) => /linked_gateway_bill/.test(String(step.detail)));
    assert.equal(tableSteps.length, 1, `网关表只扫描一次：${JSON.stringify(plan.map((step) => step.detail))}`);
  });

  test('渠道集合以 JSON 数组绑定：数千个渠道启用诊断也不超过 SQLite 变量上限，参数个数不随渠道数增长', () => {
    insertGwRaw({ reconciliationid: 'C1', TradeType: 'FundTransfer-in', merchantid: 'GW-1', Channel: 'CH-1' });
    insertGwRaw({ reconciliationid: 'OUT', TradeType: 'FundTransfer-in', merchantid: 'GW-1', Channel: 'OTHER' });
    const channels = Array.from({ length: 40000 }, (_v, i) => `CH-${i}`);
    const statements = [];
    const countingDb = {
      prepare(sql) {
        const stmt = db.prepare(sql);
        return { iterate: (...args) => { statements.push(args.length); return stmt.iterate(...args); } };
      }
    };
    const collected = [];
    const pools = linkedRepo.readGatewayBillRowPoolsByChannels(countingDb, ['', ...channels], diagnostic(collected));
    assert.deepEqual(ids(pools.exactRows), ['C1']);
    assert.deepEqual(ids(rowsOf(collected)), ['OUT']);
    assert.ok(statements[0] < 20, `绑定参数个数为常数：${statements[0]}`);
  });

  test('collect 抛错向上传（不当坏行吞掉），坏 JSON 仍跳过', () => {
    seed();
    assert.throws(
      () => linkedRepo.readGatewayBillRowPoolsByChannels(db, ['JPM'], diagnostic([], { collect: () => { throw new Error('暂存失败'); } })),
      /暂存失败/
    );
    const collected = [];
    linkedRepo.readGatewayBillRowPoolsByChannels(db, ['JPM'], diagnostic(collected));
    assert.ok(!ids(rowsOf(collected)).includes('BAD'));
  });

  test('诊断参数无效时按未请求处理；没有渠道时返回两个空池', () => {
    seed();
    const identity = (row) => row;
    for (const invalid of [
      { tradeTypes: [], accounts: ['GW-1'], collect: () => {} },
      { tradeTypes: FT, accounts: [], collect: () => {} },
      { tradeTypes: FT, accounts: ['GW-1'] },
      { tradeTypes: FT, accounts: ['GW-1'], select: identity },
      null
    ]) {
      assert.deepEqual(Object.keys(linkedRepo.readGatewayBillRowPoolsByChannels(db, ['JPM'], { outOfPoolDiagnostic: invalid })),
        ['exactRows', 'c3Rows']);
    }
    assert.deepEqual(linkedRepo.readGatewayBillRowPoolsByChannels(db, [], diagnostic([])), { exactRows: [], c3Rows: [] });
  });

  test('随机对照：读池暂存的候选 = 全表逐行取 exactRows 补集后按同一粗筛暂存（id、键摘要、渠道为空位一致）', () => {
    const mapping = new Map([['GW-1', 'CLR-1'], ['A\u0000B', 'CLR-N'], ['123', 'CLR-123']]);
    const pick = (list, rand) => list[Math.floor(rand() * list.length)];
    let state = 20261124;
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const ABSENT = Symbol('absent');
    const channels = ['JPM', 'jpm', ' JPM', '', '  ', '　', null, ABSENT, 'CITI', 0];
    const tradeTypes = ['FundTransfer-in', 'FundTransfer-out', ' FundTransfer-in　', 'Payment', 7, ABSENT];
    const accounts = ['GW-1', ' GW-1 ', ' GW-1', 'CLR-1', 'A\u0000B', 'A_x0000_B', 'GW-2', 123, 1.5, null, ABSENT, true, '', '　', 'Z\u0001'];
    const reconIdValues = ['R', '', '  ', null, 0];
    const currencies = ['USD', ' usd', '', ABSENT];
    const amounts = [100, '100.00', -100, 'x', ABSENT, 1e307];
    const bankChannelSets = [['JPM'], [''], ['', 'JPM'], ['CITI', 'JPM'], ['jpm']];
    const all = db.prepare('SELECT id, raw_json FROM linked_gateway_bill ORDER BY id ASC');
    const snapshot = (prefilter) => {
      const staged = prefilter.stagedCandidates();
      return { ids: Array.from(staged.ids), digests: Array.from(staged.keyDigests), blank: Array.from(staged.unverifiableChannel) };
    };
    for (let round = 0; round < 200; round += 1) {
      db.exec('DELETE FROM linked_gateway_bill');
      for (let i = 0; i < 30; i += 1) {
        const fields = {};
        const set = (key, value) => { if (value !== ABSENT) fields[key] = value; };
        const reconId = pick(reconIdValues, rand);
        set('reconciliationid', reconId === 'R' ? `R${round}-${i}` : reconId);
        set('TradeType', pick(tradeTypes, rand));
        set('merchantid', pick(accounts, rand));
        set('Channel', pick(channels, rand));
        set('currency', pick(currencies, rand));
        set('amount', pick(amounts, rand));
        insertGwRaw(fields);
      }
      const bankChannels = pick(bankChannelSets, rand);
      const prefilter = buildR5ChannelMissingDiagnosticPrefilter(mapping);
      const pools = linkedRepo.readGatewayBillRowPoolsByChannels(db, bankChannels, { outOfPoolDiagnostic: prefilter });
      const exactSet = new Set(pools.exactRows.map((row) => JSON.stringify(row)));
      const expected = buildR5ChannelMissingDiagnosticPrefilter(mapping);
      for (const { id, raw_json: rawJson } of all.all()) {
        const row = JSON.parse(rawJson);
        if (!exactSet.has(JSON.stringify(row))) expected.collect(row, id);
      }
      assert.deepEqual(snapshot(prefilter), snapshot(expected), `round ${round} channels ${JSON.stringify(bankChannels)}`);
    }
  });
});

test.describe('readGatewayBillRowsByIds（v3.2.22 R5s2 缺渠道诊断按 id 回读）', () => {
  test('按 id 升序逐行回调（与传入顺序无关），不存在的 id 无回调，坏 JSON 跳过；facade 透传', () => {
    for (let i = 0; i < 5; i += 1) insertGwRaw({ reconciliationid: `R${i}`, Channel: 'JPM' });
    db.prepare(
      `INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)`
    ).run('BAD', '2026-06-01', '{bad json', '2026-06-16T00:00:00.000Z');
    const rows = db.prepare('SELECT id FROM linked_gateway_bill ORDER BY id ASC').all().map((row) => row.id);
    const seen = [];
    linkedRepo.readGatewayBillRowsByIds(db, [rows[3], rows[0], rows[5], 999999, rows[1]], (row, rowId) => {
      seen.push([row.reconciliationid, rowId]);
    });
    assert.deepEqual(seen, [['R0', rows[0]], ['R1', rows[1]], ['R3', rows[3]]]);
    const viaFacade = [];
    appDb.readGatewayBillRowsByIds(new Float64Array([rows[4], rows[2]]), (row) => viaFacade.push(row.reconciliationid));
    assert.deepEqual(viaFacade, ['R2', 'R4'], '接受类型化数组');
  });

  test('超过一块的 id 分块回读：同一条预编译语句、按主键查找、整体仍按 id 升序', () => {
    const insert = db.prepare(
      `INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)`
    );
    db.exec('BEGIN');
    for (let i = 0; i < 1300; i += 1) {
      insert.run(`R${i}`, '2026-06-01', JSON.stringify({ reconciliationid: `R${i}` }), '2026-06-16T00:00:00.000Z');
    }
    db.exec('COMMIT');
    const allIds = db.prepare('SELECT id FROM linked_gateway_bill ORDER BY id ASC').all().map((row) => row.id);
    const wanted = allIds.filter((_id, index) => index % 2 === 0).reverse();
    const statements = [];
    const iterations = [];
    const countingDb = {
      prepare(sql) {
        statements.push(sql);
        const stmt = db.prepare(sql);
        return { iterate: (...args) => { iterations.push(args); return stmt.iterate(...args); } };
      }
    };
    const seen = [];
    linkedRepo.readGatewayBillRowsByIds(countingDb, wanted, (_row, rowId) => seen.push(rowId));
    assert.deepEqual(seen, wanted.slice().sort((a, b) => a - b));
    assert.equal(statements.length, 1);
    assert.equal(iterations.length, Math.ceil(wanted.length / 500), '每块至多 500 个 id');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all(JSON.stringify([allIds[0]]))
      .map((step) => String(step.detail));
    assert.ok(plan.some((detail) => /linked_gateway_bill USING INTEGER PRIMARY KEY/.test(detail)),
      `按主键查找，不全表扫描：${JSON.stringify(plan)}`);
  });

  test('id 无效时抛 TypeError；onRow 抛错向上传；空 id 列表不查表', () => {
    insertGwRaw({ reconciliationid: 'R0' });
    const id = db.prepare('SELECT id FROM linked_gateway_bill').get().id;
    for (const bad of [[1.5], ['1'], [Number.NaN], [2 ** 53]]) {
      assert.throws(() => linkedRepo.readGatewayBillRowsByIds(db, bad, () => {}), TypeError, JSON.stringify(bad));
    }
    assert.throws(() => linkedRepo.readGatewayBillRowsByIds(db, [id]), TypeError, '缺回调');
    assert.throws(() => linkedRepo.readGatewayBillRowsByIds(db, [id], () => { throw new Error('裁决失败'); }), /裁决失败/);
    const noQuery = { prepare() { throw new Error('不应查表'); } };
    linkedRepo.readGatewayBillRowsByIds(noQuery, [], () => {});
  });
});
