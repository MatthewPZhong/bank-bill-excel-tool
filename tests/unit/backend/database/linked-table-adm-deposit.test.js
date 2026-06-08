// v2.1.16-beta.5 需求3（PR-1）：ADM 银行对账单隐藏表（linked_adm_bank_deposit）仓储 + migration 单测。
//
// 覆盖（🔴 资金对账数据层 — 隐藏性 / round-trip / 幂等是后续 PR-2/3 的地基契约）：
//   UT-ADM-1  ADM def 入 LINKED_TABLE_DEFS（仓储可读写），但 ALL_TABLE_KEYS 不含 'adm-bank-deposit'
//   UT-ADM-2  listLinkedTableMeta 结果不含 'adm-bank-deposit'（前端弹窗不可见）
//   UT-ADM-3  replaceAdmBankDeposit 6 字段 round-trip：6 新字段 + 13 银行字段写入后 readAdmBankDepositRows 读回一致
//   UT-ADM-4  batch_no / channel_order_no / reconciliation_id / bill_date 列从行派生值正确落列
//   UT-ADM-5  整表覆盖：第二次 replaceAdmBankDeposit 后仅含第二批
//   UT-ADM-6  ensureAdmBankDepositSupport 连续调 2 次不报错、表结构（列 + 索引）一致（幂等）
//   UT-ADM-7  writeAdmMatchFlags 整批幂等重写：标志/资金对账ID 落 raw_json；连调 2 次结果一致
//   UT-ADM-8  writeAdmMatchFlags 行数不一致 → 抛错（ADM 表被并发重建保护）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');
const { ensureAdmBankDepositSupport } = require('../../../../src/backend/database/migrations');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-adm-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造一条 ADM 行（13 银行字段 + 6 新字段，buildAdmRows 产物形态；PR-1 仓储整行存 raw_json）。
function admRow(overrides = {}) {
  const base = {
    // 13 银行字段
    BizId: 'B001',
    BillDate: '2026-05-04',
    ValueDate: '2026-05-05',
    Channel: 'ADM',
    地区: 'HK',
    MerchantId: '6300156616',
    Currency: 'USD',
    'Credit Amount': '2100000',
    'Debit Amount': '0',
    ReconciliationId: 'R001',
    ChannelOrderNo: 'CO123',
    CustomerRef: 'CR-9',
    FundType: 'Fundtransfer-out',
    // 6 新字段（派生初值）
    '批次号': '2026-05-04-CO123',
    '调拨号': 'ALLOC-1',
    'Fundtransfer-in金额': '2100000',
    '资金对账ID': '',
    '是否与渠道账单匹配': 0,
    '是否与网关账单匹配': 0
  };
  return { ...base, ...overrides };
}

test.describe('linked-table-repository — ADM 银行对账单隐藏表（v2.1.16-beta.5 需求3 PR-1）', () => {
  // UT-ADM-1：ADM def 可读写（supported=true）但 ALL_TABLE_KEYS 不含（隐藏表）
  test('UT-ADM-1：LINKED_TABLE_DEFS 含 adm-bank-deposit（supported=true）；ALL_TABLE_KEYS 不含', () => {
    assert.ok(linkedRepo.LINKED_TABLE_DEFS['adm-bank-deposit'], 'LINKED_TABLE_DEFS 必须含 adm-bank-deposit');
    assert.equal(linkedRepo.LINKED_TABLE_DEFS['adm-bank-deposit'].supported, true);
    assert.equal(linkedRepo.LINKED_TABLE_DEFS['adm-bank-deposit'].table, 'linked_adm_bank_deposit');
    assert.ok(
      !linkedRepo.ALL_TABLE_KEYS.includes('adm-bank-deposit'),
      '🔴 ADM 表隐藏：ALL_TABLE_KEYS 绝不能含 adm-bank-deposit'
    );
  });

  // UT-ADM-2：listLinkedTableMeta 不暴露 ADM 表（前端弹窗渲染不到它）
  test('UT-ADM-2：listLinkedTableMeta 结果不含 adm-bank-deposit', () => {
    const metas = linkedRepo.listLinkedTableMeta(db);
    const keys = metas.map((m) => m.tableKey);
    assert.ok(!keys.includes('adm-bank-deposit'), '🔴 listLinkedTableMeta 不得暴露 ADM 隐藏表');
    // 守护：仍是现有 5 张可见表
    assert.equal(metas.length, 5, 'listLinkedTableMeta 仍为 5 行（ADM 不计入）');
  });

  // UT-ADM-3：6 字段 round-trip（写入 13+6 字段 → 读回字段集合与值一致）
  test('UT-ADM-3：replaceAdmBankDeposit → readAdmBankDepositRows round-trip（含 6 新字段）', () => {
    const row = admRow();
    appDb.replaceAdmBankDeposit([row]);
    const back = appDb.readAdmBankDepositRows();
    assert.equal(back.length, 1);
    // 字段集合一致（13 + 6 = 19 字段）
    assert.deepEqual(Object.keys(back[0]).sort(), Object.keys(row).sort(), 'raw_json 字段集合 = 入参 19 字段');
    // 6 新字段值一致
    assert.equal(back[0]['批次号'], '2026-05-04-CO123');
    assert.equal(back[0]['调拨号'], 'ALLOC-1');
    assert.equal(back[0]['Fundtransfer-in金额'], '2100000');
    assert.equal(back[0]['资金对账ID'], '');
    assert.equal(back[0]['是否与渠道账单匹配'], 0);
    assert.equal(back[0]['是否与网关账单匹配'], 0);
    // 银行字段抽查
    assert.equal(back[0].Channel, 'ADM');
    assert.equal(back[0].CustomerRef, 'CR-9');
    assert.equal(back[0].ReconciliationId, 'R001');
  });

  // UT-ADM-4：派生列正确落库（reconciliation_id / bill_date / batch_no / channel_order_no）
  test('UT-ADM-4：reconciliation_id / bill_date / batch_no / channel_order_no 列从行派生值落库', () => {
    appDb.replaceAdmBankDeposit([
      admRow({ ReconciliationId: 987654321, BillDate: '2026/05/04', ChannelOrderNo: '  CO-PAD  ', '批次号': '2026-05-04-CO-PAD' })
    ]);
    const dbRow = db.prepare(
      'SELECT reconciliation_id, bill_date, batch_no, channel_order_no FROM linked_adm_bank_deposit ORDER BY id ASC'
    ).get();
    assert.equal(dbRow.reconciliation_id, '987654321', 'number 键归一为 String().trim()');
    assert.equal(dbRow.bill_date, '2026-05-04', '斜杠格式 BillDate 归一为 YYYY-MM-DD');
    assert.equal(dbRow.batch_no, '2026-05-04-CO-PAD', 'batch_no = 行「批次号」');
    assert.equal(dbRow.channel_order_no, 'CO-PAD', 'channel_order_no = ChannelOrderNo（trim）');
  });

  // UT-ADM-5：整表覆盖（第二批替换第一批）
  test('UT-ADM-5：整表覆盖 — 第二次 replaceAdmBankDeposit 后仅含第二批', () => {
    appDb.replaceAdmBankDeposit([
      admRow({ ReconciliationId: 'OLD1' }),
      admRow({ ReconciliationId: 'OLD2' })
    ]);
    const ret = appDb.replaceAdmBankDeposit([admRow({ ReconciliationId: 'NEW1' })]);
    assert.equal(ret.rowCount, 1);
    const back = appDb.readAdmBankDepositRows();
    assert.equal(back.length, 1, '整表覆盖：第一批 2 行被全删');
    assert.equal(back[0].ReconciliationId, 'NEW1');
  });

  // UT-ADM-7：writeAdmMatchFlags 整批幂等重写（标志/资金对账ID 落 raw_json；连调 2 次一致）
  test('UT-ADM-7：writeAdmMatchFlags 整批幂等重写匹配标志/资金对账ID（可重入）', () => {
    appDb.replaceAdmBankDeposit([
      admRow({ ReconciliationId: 'S1' }),
      admRow({ ReconciliationId: 'S2' })
    ]);
    // 读出 → 模拟 JPM 引擎计算回写 → writeAdmMatchFlags
    const rows = appDb.readAdmBankDepositRows();
    rows[0]['资金对账ID'] = 'RECON-FUND-1';
    rows[0]['是否与渠道账单匹配'] = 1;
    rows[0]['是否与网关账单匹配'] = 1;
    appDb.writeAdmMatchFlags(rows);

    const after1 = appDb.readAdmBankDepositRows();
    assert.equal(after1[0]['资金对账ID'], 'RECON-FUND-1');
    assert.equal(after1[0]['是否与渠道账单匹配'], 1);
    assert.equal(after1[0]['是否与网关账单匹配'], 1);
    assert.equal(after1[1]['是否与渠道账单匹配'], 0, '第二行未命中保持 0');
    // 幂等：再用同一批写回，结果一致
    appDb.writeAdmMatchFlags(after1);
    const after2 = appDb.readAdmBankDepositRows();
    assert.deepEqual(after2, after1, '整批幂等重写 — 连调 2 次结果一致');
    // 行数不变（UPDATE 非 INSERT）
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM linked_adm_bank_deposit').get().c;
    assert.equal(cnt, 2, 'writeAdmMatchFlags 不改行数');
  });

  // UT-ADM-8：writeAdmMatchFlags 行数不一致 → 抛错（防 ADM 表被并发重建后按位置错位写回）
  test('UT-ADM-8：writeAdmMatchFlags 入参行数 ≠ DB 行数 → 抛错', () => {
    appDb.replaceAdmBankDeposit([admRow({ ReconciliationId: 'S1' }), admRow({ ReconciliationId: 'S2' })]);
    assert.throws(
      () => appDb.writeAdmMatchFlags([admRow({ ReconciliationId: 'S1' })]), // 仅 1 行 vs DB 2 行
      /行数不一致/,
      '行数不一致必须抛错保护'
    );
    // 抛错后 DB 数据未被破坏（仍 2 行）
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM linked_adm_bank_deposit').get().c;
    assert.equal(cnt, 2, 'ROLLBACK 后行数不变');
  });
});

test.describe('migrations — ensureAdmBankDepositSupport 幂等（v2.1.16-beta.5 需求3 PR-1）', () => {
  let mTmpDir;
  let mDb;

  test.beforeEach(() => {
    mTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-migration-'));
    mDb = new DatabaseSync(path.join(mTmpDir, 'm.sqlite'));
  });

  test.afterEach(() => {
    try { if (mDb && mDb.close) mDb.close(); } catch (_e) { /* ignore */ }
    if (mTmpDir) { fs.rmSync(mTmpDir, { recursive: true, force: true }); mTmpDir = null; }
  });

  // 取表结构指纹（列名+类型 + 索引名）供前后对比
  function schemaFingerprint(database) {
    const cols = database.prepare("PRAGMA table_info('linked_adm_bank_deposit')").all()
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`).sort();
    const idx = database.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='linked_adm_bank_deposit' AND name NOT LIKE 'sqlite_%'"
    ).all().map((r) => r.name).sort();
    return { cols, idx };
  }

  // UT-ADM-6：连续调 2 次不报错 + 表结构一致（CREATE IF NOT EXISTS 幂等）
  test('UT-ADM-6：ensureAdmBankDepositSupport 连续调 2 次不报错、表结构一致', () => {
    assert.doesNotThrow(() => ensureAdmBankDepositSupport(mDb));
    const fp1 = schemaFingerprint(mDb);
    // 第二次调用：幂等 no-op，不报错
    assert.doesNotThrow(() => ensureAdmBankDepositSupport(mDb));
    const fp2 = schemaFingerprint(mDb);
    assert.deepEqual(fp2, fp1, '幂等：第二次调用后表结构（列 + 索引）不变');
    // 列完整性：7 列
    assert.equal(fp1.cols.length, 7, 'linked_adm_bank_deposit 应有 7 列');
    const colNames = mDb.prepare("PRAGMA table_info('linked_adm_bank_deposit')").all().map((c) => c.name);
    for (const expected of ['id', 'reconciliation_id', 'bill_date', 'batch_no', 'channel_order_no', 'raw_json', 'imported_at']) {
      assert.ok(colNames.includes(expected), `应含列 ${expected}`);
    }
    // 索引完整性：batch + date 两索引
    assert.ok(fp1.idx.includes('idx_linked_adm_bank_deposit_batch'), '应有 batch 索引');
    assert.ok(fp1.idx.includes('idx_linked_adm_bank_deposit_date'), '应有 date 索引');
  });

  // 写入后再次 ensure 不丢数据（CREATE IF NOT EXISTS 不重建表）
  test('UT-ADM-6b：建表 → 写入 → 再 ensure 不丢数据', () => {
    ensureAdmBankDepositSupport(mDb);
    mDb.prepare(
      'INSERT INTO linked_adm_bank_deposit (reconciliation_id, bill_date, batch_no, channel_order_no, raw_json, imported_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('R1', '2026-05-04', '2026-05-04-CO1', 'CO1', '{"a":1}', '2026-05-04T00:00:00.000Z');
    ensureAdmBankDepositSupport(mDb); // 幂等再调
    const cnt = mDb.prepare('SELECT COUNT(*) AS c FROM linked_adm_bank_deposit').get().c;
    assert.equal(cnt, 1, 'CREATE IF NOT EXISTS 不重建表 → 数据保留');
  });
});
