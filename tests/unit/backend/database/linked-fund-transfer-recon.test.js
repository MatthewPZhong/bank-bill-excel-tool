// v3.0.6 需求1（T2）：调拨对账单隐藏表（linked_fund_transfer_recon）仓储 + migration 单测。
//
// 覆盖（🔴 资金对账数据层 — 隐藏性 / round-trip / 整表覆盖 / 幂等是需求2/3 引擎的地基契约）：
//   UT-FTR-1  fund-transfer-recon 不在 ALL_TABLE_KEYS（隐藏表，前端弹窗渲染不到它）
//   UT-FTR-2  listLinkedTableMeta 结果不含 fund-transfer-recon，仍是现有 5 张可见表
//   UT-FTR-3  replaceFundTransferReconRows → readFundTransferReconRows round-trip（recon 11 字段一致）
//   UT-FTR-4  allocation_no / fund_type / bill_date / recon_id / big_account 列从行经常量取值正确落列
//   UT-FTR-5  整表覆盖：第二次 replace 仅含第二批（二次 replace 不累加）
//   UT-FTR-6  readFundTransferReconRows ORDER BY id ASC 还原原序 + 损坏 raw_json 行跳过
//   UT-FTR-7  ensureFundTransferReconSupport 连续调 2 次不报错、表结构（列 + 索引）一致（幂等）
//   UT-FTR-8  建表 → 写入 → 再 ensure 不丢数据（CREATE IF NOT EXISTS 不重建表）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');
const { ensureFundTransferReconSupport } = require('../../../../src/backend/database/migrations');
const { FT_RECON_FIELD_MAP } = require('../../../../src/constants/fund-transfer-recon-fields');
const { buildFundTransferReconRows } = require('../../../../src/main-process/fund-transfer-recon-builder');

const M = FT_RECON_FIELD_MAP.mid;
const R = FT_RECON_FIELD_MAP.recon;

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-ftr-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造一行中台调拨订单（中文真实表头；字段名经 FT_RECON_FIELD_MAP.mid 取，禁手敲）。
function midRow(overrides = {}) {
  const base = {
    [M.allocationNo]: 'ALLOC-1',
    [M.txTime]: '2026-05-04',
    [M.channelSerial]: 'SERIAL-1',
    [M.payCard]: 'PAY-CARD-1',
    [M.payeeCard]: 'PAYEE-CARD-1',
    [M.receiveChannel]: 'DBS',
    [M.receiveAmount]: '2100000',
    [M.receiveCurrency]: 'USD',
    [M.payChannel]: 'CITI',
    [M.payAmount]: '2100000',
    [M.payCurrency]: 'HKD'
  };
  return { ...base, ...overrides };
}

// 经 builder 派生 recon 行（每单 in/out 两行，字段名 = recon 中文/英文列名）。
function reconRowsFrom(...mids) {
  return buildFundTransferReconRows(mids).rows;
}

test.describe('linked-table-repository — 调拨对账单隐藏表（v3.0.6 需求1 T2）', () => {
  // UT-FTR-1：fund-transfer-recon 隐藏表 — ALL_TABLE_KEYS 绝不能含
  test('UT-FTR-1：ALL_TABLE_KEYS 不含 fund-transfer-recon（隐藏表）', () => {
    assert.ok(
      !linkedRepo.ALL_TABLE_KEYS.includes('fund-transfer-recon'),
      '🔴 调拨对账单隐藏表：ALL_TABLE_KEYS 绝不能含 fund-transfer-recon'
    );
  });

  // UT-FTR-2：listLinkedTableMeta 不暴露调拨对账单表（前端弹窗仍 5 表）
  test('UT-FTR-2：listLinkedTableMeta 结果不含 fund-transfer-recon，仍为 5 张可见表', () => {
    const metas = linkedRepo.listLinkedTableMeta(db);
    const keys = metas.map((m) => m.tableKey);
    assert.ok(!keys.includes('fund-transfer-recon'), '🔴 listLinkedTableMeta 不得暴露调拨对账单隐藏表');
    assert.equal(metas.length, 5, '链接表弹窗仍为 5 行（调拨对账单不计入）');
  });

  // UT-FTR-3：recon 11 字段 round-trip（写入 → 读回字段集合与值一致）
  test('UT-FTR-3：replaceFundTransferReconRows → readFundTransferReconRows round-trip（recon 11 字段）', () => {
    const rows = reconRowsFrom(midRow());
    assert.equal(rows.length, 2, '一行中台订单派生 in/out 两行');
    appDb.replaceFundTransferReconRows(rows);
    const back = appDb.readFundTransferReconRows();
    assert.equal(back.length, 2);
    // 字段集合一致（recon 11 字段）
    assert.deepEqual(Object.keys(back[0]).sort(), Object.keys(rows[0]).sort(), 'raw_json 字段集合 = recon 11 字段');
    // in 行（第 1 行）：方向 / 渠道 / 金额 / 币种 / big_account 抽查
    assert.equal(back[0][R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_IN);
    assert.equal(back[0][R.receiveChannel], 'DBS');
    assert.equal(back[0][R.amount], '2100000');
    assert.equal(back[0][R.currency], 'USD');
    assert.equal(back[0][R.bigAccount], 'PAYEE-CARD-1', 'D1：in 行 big_account = 收款卡号');
    // out 行（第 2 行）
    assert.equal(back[1][R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_OUT);
    assert.equal(back[1][R.payChannel], 'CITI');
    assert.equal(back[1][R.currency], 'HKD', 'out 行币种取付款币种');
    assert.equal(back[1][R.bigAccount], 'PAY-CARD-1', 'D1：out 行 big_account = 付款卡号');
    // 公共字段
    assert.equal(back[0][R.allocationNo], 'ALLOC-1');
    assert.equal(back[0][R.reconId], 'SERIAL-1');
  });

  // UT-FTR-4：提取列从行经常量取值正确落库（allocation_no / fund_type / bill_date / recon_id / big_account）
  test('UT-FTR-4：allocation_no / fund_type / bill_date / recon_id / big_account 列从行派生值落库', () => {
    const rows = reconRowsFrom(midRow({ [M.allocationNo]: '  ALLOC-PAD  ', [M.txTime]: '2026/05/04', [M.channelSerial]: 987654321 }));
    appDb.replaceFundTransferReconRows(rows);
    const dbRows = db.prepare(
      'SELECT allocation_no, fund_type, bill_date, recon_id, big_account FROM linked_fund_transfer_recon ORDER BY id ASC'
    ).all();
    assert.equal(dbRows.length, 2);
    // in 行
    assert.equal(dbRows[0].allocation_no, 'ALLOC-PAD', 'normalizeKey trim');
    assert.equal(dbRows[0].fund_type, FT_RECON_FIELD_MAP.FUND_TYPE_IN);
    assert.equal(dbRows[0].bill_date, '2026-05-04', '斜杠格式 BillDate 归一为 YYYY-MM-DD');
    assert.equal(dbRows[0].recon_id, '987654321', 'number 渠道流水号归一为 String().trim()');
    assert.equal(dbRows[0].big_account, 'PAYEE-CARD-1', 'in 行 big_account = 收款卡号');
    // out 行
    assert.equal(dbRows[1].fund_type, FT_RECON_FIELD_MAP.FUND_TYPE_OUT);
    assert.equal(dbRows[1].big_account, 'PAY-CARD-1', 'out 行 big_account = 付款卡号');
  });

  // UT-FTR-5：整表覆盖（第二批替换第一批，不累加）
  test('UT-FTR-5：整表覆盖 — 第二次 replaceFundTransferReconRows 后仅含第二批', () => {
    appDb.replaceFundTransferReconRows(reconRowsFrom(
      midRow({ [M.allocationNo]: 'OLD1' }),
      midRow({ [M.allocationNo]: 'OLD2' })
    )); // 2 单 → 4 行
    const ret = appDb.replaceFundTransferReconRows(reconRowsFrom(midRow({ [M.allocationNo]: 'NEW1' }))); // 1 单 → 2 行
    assert.equal(ret.rowCount, 2);
    const back = appDb.readFundTransferReconRows();
    assert.equal(back.length, 2, '整表覆盖：第一批 4 行被全删，二次 replace 不累加');
    assert.equal(back[0][R.allocationNo], 'NEW1');
    assert.equal(back[1][R.allocationNo], 'NEW1');
  });

  // UT-FTR-6：ORDER BY id ASC 还原原序 + 损坏 raw_json 行跳过
  test('UT-FTR-6：readFundTransferReconRows ORDER BY id ASC 还原 + 损坏 raw_json 行跳过', () => {
    appDb.replaceFundTransferReconRows(reconRowsFrom(
      midRow({ [M.allocationNo]: 'A1' }),
      midRow({ [M.allocationNo]: 'A2' })
    )); // 4 行：A1-in, A1-out, A2-in, A2-out（id 升序 = 派生原序）
    // 注入一条损坏 raw_json 行（应被读取时跳过）
    db.prepare(
      'INSERT INTO linked_fund_transfer_recon (allocation_no, fund_type, bill_date, recon_id, big_account, raw_json, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('BROKEN', 'FundTransfer-in', '2026-05-04', 'X', 'C', '{not json', '2026-05-04T00:00:00.000Z');

    const back = appDb.readFundTransferReconRows();
    assert.equal(back.length, 4, '损坏行被跳过，仅 4 条有效行');
    // 原序：A1-in → A1-out → A2-in → A2-out
    assert.deepEqual(
      back.map((r) => [r[R.allocationNo], r[R.fundType]]),
      [
        ['A1', FT_RECON_FIELD_MAP.FUND_TYPE_IN],
        ['A1', FT_RECON_FIELD_MAP.FUND_TYPE_OUT],
        ['A2', FT_RECON_FIELD_MAP.FUND_TYPE_IN],
        ['A2', FT_RECON_FIELD_MAP.FUND_TYPE_OUT]
      ],
      'ORDER BY id ASC 还原派生原序（每单 in 行后接 out 行）'
    );
  });
});

test.describe('migrations — ensureFundTransferReconSupport 幂等（v3.0.6 需求1 T2）', () => {
  let mTmpDir;
  let mDb;

  test.beforeEach(() => {
    mTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftr-migration-'));
    mDb = new DatabaseSync(path.join(mTmpDir, 'm.sqlite'));
  });

  test.afterEach(() => {
    try { if (mDb && mDb.close) mDb.close(); } catch (_e) { /* ignore */ }
    if (mTmpDir) { fs.rmSync(mTmpDir, { recursive: true, force: true }); mTmpDir = null; }
  });

  // 取表结构指纹（列名+类型 + 索引名）供前后对比
  function schemaFingerprint(database) {
    const cols = database.prepare("PRAGMA table_info('linked_fund_transfer_recon')").all()
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`).sort();
    const idx = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='linked_fund_transfer_recon' AND name NOT LIKE 'sqlite_%'"
    ).all().map((r) => r.name).sort();
    return { cols, idx };
  }

  // UT-FTR-7：连续调 2 次不报错 + 表结构一致（CREATE IF NOT EXISTS 幂等）
  test('UT-FTR-7：ensureFundTransferReconSupport 连续调 2 次不报错、表结构一致', () => {
    assert.doesNotThrow(() => ensureFundTransferReconSupport(mDb));
    const fp1 = schemaFingerprint(mDb);
    // 第二次调用：幂等 no-op，不报错
    assert.doesNotThrow(() => ensureFundTransferReconSupport(mDb));
    const fp2 = schemaFingerprint(mDb);
    assert.deepEqual(fp2, fp1, '幂等：第二次调用后表结构（列 + 索引）不变');
    // 列完整性：8 列
    assert.equal(fp1.cols.length, 8, 'linked_fund_transfer_recon 应有 8 列');
    const colNames = mDb.prepare("PRAGMA table_info('linked_fund_transfer_recon')").all().map((c) => c.name);
    for (const expected of ['id', 'allocation_no', 'fund_type', 'bill_date', 'recon_id', 'big_account', 'raw_json', 'imported_at']) {
      assert.ok(colNames.includes(expected), `应含列 ${expected}`);
    }
    // 索引完整性：alloc + date + ftype 三索引
    assert.ok(fp1.idx.includes('idx_lftr_alloc'), '应有 alloc 索引');
    assert.ok(fp1.idx.includes('idx_lftr_date'), '应有 date 索引');
    assert.ok(fp1.idx.includes('idx_lftr_ftype'), '应有 ftype 索引');
  });

  // UT-FTR-8：建表 → 写入 → 再 ensure 不丢数据（CREATE IF NOT EXISTS 不重建表）
  test('UT-FTR-8：建表 → 写入 → 再 ensure 不丢数据', () => {
    ensureFundTransferReconSupport(mDb);
    mDb.prepare(
      'INSERT INTO linked_fund_transfer_recon (allocation_no, fund_type, bill_date, recon_id, big_account, raw_json, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('ALLOC-1', 'FundTransfer-in', '2026-05-04', 'S1', 'C1', '{"a":1}', '2026-05-04T00:00:00.000Z');
    ensureFundTransferReconSupport(mDb); // 幂等再调
    const cnt = mDb.prepare('SELECT COUNT(*) AS c FROM linked_fund_transfer_recon').get().c;
    assert.equal(cnt, 1, 'CREATE IF NOT EXISTS 不重建表 → 数据保留');
  });
});
