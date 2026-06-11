// v3.0.4 块 E（需求2）：BOC 链接表两张隐藏表（linked_boc_fx_settlement / linked_boc_bank_deposit）
//   仓储 + migration 单测（🔴 资金对账数据层 — 隐藏性 / 覆盖语义 / 按 id 回写是后续引擎的地基契约）。
//
// 覆盖：
//   UT-BOC-1  ensureBocFxLinkSupport 幂等（连调 2 次表结构 + 索引不变；列完整性）
//   UT-BOC-2  隐藏红线：两表入 LINKED_TABLE_DEFS 但 ALL_TABLE_KEYS 不含、listLinkedTableMeta 不返回（仍 5 行）
//   UT-BOC-3  replaceBocFxLink 整表覆盖 + 8 列热列从辅助键派生 + raw_json 剥辅助键
//   UT-BOC-4  readBocFxLinkRowsWithIds 携带 id + writeBocFxLinkReconIds 按 id 回写 raw_json/recon_link_id
//   UT-BOC-5  replaceBocFxLink ROLLBACK（INSERT 失败旧数据完好 — 这里测覆盖语义边界）
//   UT-BOC-6  readBankDepositBocCandidates json_extract 下推（Channel=BOC 命中、非 BOC 不命中）
//   UT-BOC-7  replaceBocBankDeposit 整表覆盖 + 4 列派生
//   UT-BOC-8  BANK_DEPOSIT_FIELDS=14 断言（同步 13→14；含 Payment Detail）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');
const { ensureBocFxLinkSupport } = require('../../../../src/backend/database/migrations');
const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-boc-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 造一条 BOC链接表行（业务字段 + 内部辅助键，replaceBocFxLink 入参形态）。
function fxLinkRow(o = {}) {
  return Object.assign({
    '交易编号': '100',
    '货币2金额': '30',
    '到期日': '2026-05-04',
    '分组': '1',
    '调拨单号': '',
    '资金对账不平表链接ID': '',
    __txnNo: '100',
    __maturityIso: '2026-05-04',
    __sourceRow: 3
  }, o);
}

// 造一条 BOC调拨银行对账单行（buildBocBankRows 产物形态）。
function bocBankRow(o = {}) {
  return Object.assign({
    Channel: 'BOC', '地区': 'CN', Currency: 'USD', 'Credit Amount': '0',
    ReconciliationId: 'RX1', BillDate: '2026-05-04', '银行单交易编号': '100'
  }, o);
}

test.describe('linked-table-boc — 隐藏红线 + DEFS', () => {
  // UT-BOC-2：🔴 两表隐藏（不进 ALL_TABLE_KEYS / listLinkedTableMeta 不返回）
  test('UT-BOC-2：boc 两表入 DEFS 但 ALL_TABLE_KEYS 不含、listLinkedTableMeta 不返回（仍 5 行）', () => {
    assert.ok(linkedRepo.LINKED_TABLE_DEFS['boc-fx-settlement'], 'DEFS 含 boc-fx-settlement');
    assert.ok(linkedRepo.LINKED_TABLE_DEFS['boc-bank-deposit'], 'DEFS 含 boc-bank-deposit');
    assert.equal(linkedRepo.LINKED_TABLE_DEFS['boc-fx-settlement'].table, 'linked_boc_fx_settlement');
    assert.equal(linkedRepo.LINKED_TABLE_DEFS['boc-bank-deposit'].table, 'linked_boc_bank_deposit');
    assert.ok(!linkedRepo.ALL_TABLE_KEYS.includes('boc-fx-settlement'), '🔴 boc-fx-settlement 绝不进 ALL_TABLE_KEYS');
    assert.ok(!linkedRepo.ALL_TABLE_KEYS.includes('boc-bank-deposit'), '🔴 boc-bank-deposit 绝不进 ALL_TABLE_KEYS');
    const metas = linkedRepo.listLinkedTableMeta(db);
    const keys = metas.map((m) => m.tableKey);
    assert.ok(!keys.includes('boc-fx-settlement'), '🔴 listLinkedTableMeta 不暴露 boc-fx-settlement');
    assert.ok(!keys.includes('boc-bank-deposit'), '🔴 listLinkedTableMeta 不暴露 boc-bank-deposit');
    assert.equal(metas.length, 5, 'listLinkedTableMeta 仍为 5 行（BOC 两表不计入）');
  });

  // UT-BOC-8：🔴 BANK_DEPOSIT_FIELDS = 14（13→14，含 Payment Detail；全部 ∈ BANK_STATEMENT_FIELDS）
  test('UT-BOC-8：BANK_DEPOSIT_FIELDS=14 含 Payment Detail，且全部 ∈ BANK_STATEMENT_FIELDS', () => {
    assert.equal(linkedRepo.BANK_DEPOSIT_FIELDS.length, 14, '13→14');
    assert.ok(linkedRepo.BANK_DEPOSIT_FIELDS.includes('Payment Detail'), '🔴 含 Payment Detail（银行单交易编号提取源）');
    assert.ok(
      linkedRepo.BANK_DEPOSIT_FIELDS.every((f) => BANK_STATEMENT_FIELDS.includes(f)),
      '14 字段必须全部存在于 BANK_STATEMENT_FIELDS'
    );
    // Payment Detail 在 CustomerRef 与 FundType 之间（44 列契约相对顺序）
    const idx = linkedRepo.BANK_DEPOSIT_FIELDS.indexOf('Payment Detail');
    assert.ok(idx > linkedRepo.BANK_DEPOSIT_FIELDS.indexOf('CustomerRef'), 'Payment Detail 在 CustomerRef 之后');
    assert.ok(idx < linkedRepo.BANK_DEPOSIT_FIELDS.indexOf('FundType'), 'Payment Detail 在 FundType 之前');
  });
});

test.describe('linked-table-boc — replaceBocFxLink / read / writeReconIds', () => {
  // UT-BOC-3：8 列热列派生 + raw_json 剥辅助键
  test('UT-BOC-3：replaceBocFxLink 8 列热列派生 + raw_json 剥内部辅助键', () => {
    appDb.replaceBocFxLink([fxLinkRow({ '调拨单号': 'A1' })]);
    const dbRow = db.prepare(
      'SELECT transaction_no, group_no, allocation_no, recon_link_id, maturity_date, source_row, raw_json FROM linked_boc_fx_settlement ORDER BY id ASC'
    ).get();
    assert.equal(dbRow.transaction_no, '100', 'transaction_no 取辅助键 __txnNo');
    assert.equal(dbRow.group_no, '1');
    assert.equal(dbRow.allocation_no, 'A1');
    assert.equal(dbRow.maturity_date, '2026-05-04', 'maturity_date 取辅助键 __maturityIso');
    assert.equal(dbRow.source_row, 3, 'source_row 取辅助键 __sourceRow');
    const obj = JSON.parse(dbRow.raw_json);
    assert.ok(!('__txnNo' in obj), 'raw_json 剥掉 __txnNo');
    assert.ok(!('__maturityIso' in obj), 'raw_json 剥掉 __maturityIso');
    assert.ok(!('__sourceRow' in obj), 'raw_json 剥掉 __sourceRow');
    assert.equal(obj['交易编号'], '100', 'raw_json 保留业务字段');
    assert.equal(obj['调拨单号'], 'A1');
  });

  // UT-BOC-3b：readBocFxLinkRows 还原业务行（按 id ASC）
  test('UT-BOC-3b：readBocFxLinkRows 还原业务行（无辅助键，按 id ASC 保序）', () => {
    appDb.replaceBocFxLink([
      fxLinkRow({ '交易编号': '100', __txnNo: '100' }),
      fxLinkRow({ '交易编号': '200', __txnNo: '200' })
    ]);
    const rows = appDb.readBocFxLinkRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r['交易编号']), ['100', '200'], '按 id ASC 保序');
    assert.ok(!('__txnNo' in rows[0]), '读回无内部辅助键');
  });

  // UT-BOC-5：整表覆盖（第二批替换第一批）
  test('UT-BOC-5：replaceBocFxLink 整表覆盖 — 第二批替换第一批', () => {
    appDb.replaceBocFxLink([fxLinkRow({ '交易编号': 'OLD1', __txnNo: 'OLD1' }), fxLinkRow({ '交易编号': 'OLD2', __txnNo: 'OLD2' })]);
    const ret = appDb.replaceBocFxLink([fxLinkRow({ '交易编号': 'NEW1', __txnNo: 'NEW1' })]);
    assert.equal(ret.rowCount, 1);
    const rows = appDb.readBocFxLinkRows();
    assert.equal(rows.length, 1, '整表覆盖：第一批被全删');
    assert.equal(rows[0]['交易编号'], 'NEW1');
  });

  // UT-BOC-4：readBocFxLinkRowsWithIds 携带 id + writeBocFxLinkReconIds 按 id 回写
  test('UT-BOC-4：writeBocFxLinkReconIds 按 id 回写 raw_json + recon_link_id 列', () => {
    appDb.replaceBocFxLink([
      fxLinkRow({ '交易编号': '100', __txnNo: '100' }),
      fxLinkRow({ '交易编号': '200', __txnNo: '200' })
    ]);
    const withIds = appDb.readBocFxLinkRowsWithIds();
    assert.equal(withIds.length, 2);
    assert.ok(withIds[0].id < withIds[1].id, '携带 DB id（按 id ASC）');
    // 模拟 2.5 回填：第一行命中 RX1
    withIds[0].row['资金对账不平表链接ID'] = 'RX1';
    appDb.writeBocFxLinkReconIds(withIds);
    // raw_json 重写 + recon_link_id 列同步
    const dbRows = db.prepare('SELECT recon_link_id, raw_json FROM linked_boc_fx_settlement ORDER BY id ASC').all();
    assert.equal(dbRows[0].recon_link_id, 'RX1', 'recon_link_id 列回写');
    assert.equal(JSON.parse(dbRows[0].raw_json)['资金对账不平表链接ID'], 'RX1', 'raw_json 同步回写');
    assert.equal(dbRows[1].recon_link_id, '', '未命中行保持空');
    // 幂等：连写不变行数
    appDb.writeBocFxLinkReconIds(appDb.readBocFxLinkRowsWithIds());
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM linked_boc_fx_settlement').get().c;
    assert.equal(cnt, 2, 'writeBocFxLinkReconIds 不改行数');
  });
});

test.describe('linked-table-boc — readBankDepositBocCandidates / replaceBocBankDeposit', () => {
  // UT-BOC-6：json_extract 下推 Channel=BOC（命中 BOC、排除非 BOC）
  test('UT-BOC-6：readBankDepositBocCandidates 仅返回 Channel=BOC 行', () => {
    // 经 bank-deposit 仓储落库 3 行（BOC / JPM / BOC）—— replaceLinkedTable 整行存 raw_json
    const mkBank = (channel, recon) => {
      const r = {};
      for (const f of linkedRepo.BANK_DEPOSIT_FIELDS) r[f] = '';
      r.Channel = channel;
      r.ReconciliationId = recon;
      r.BillDate = '2026-05-04';
      return r;
    };
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [mkBank('BOC', 'R1'), mkBank('JPM', 'R2'), mkBank('BOC', 'R3')], {});
    const cands = appDb.readBankDepositBocCandidates();
    assert.equal(cands.length, 2, '仅 Channel=BOC 的 R1+R3（JPM 的 R2 被 SQL 排除）');
    assert.deepEqual(cands.map((c) => c.ReconciliationId).sort(), ['R1', 'R3']);
    // 候选含 Payment Detail 键（14 字段时代落库）
    assert.ok('Payment Detail' in cands[0], 'BOC 候选含 Payment Detail 键');
  });

  // UT-BOC-7：replaceBocBankDeposit 整表覆盖 + 4 列派生
  test('UT-BOC-7：replaceBocBankDeposit 整表覆盖 + 热列派生', () => {
    appDb.replaceBocBankDeposit([bocBankRow({ ReconciliationId: 'RX1', '银行单交易编号': '100' })]);
    const dbRow = db.prepare(
      'SELECT bank_txn_no, reconciliation_id, bill_date, raw_json FROM linked_boc_bank_deposit ORDER BY id ASC'
    ).get();
    assert.equal(dbRow.bank_txn_no, '100');
    assert.equal(dbRow.reconciliation_id, 'RX1');
    assert.equal(dbRow.bill_date, '2026-05-04');
    assert.equal(JSON.parse(dbRow.raw_json)['银行单交易编号'], '100', 'raw_json 存整行');
    // 整表覆盖
    appDb.replaceBocBankDeposit([bocBankRow({ '银行单交易编号': '999' })]);
    const rows = appDb.readBocBankDepositRows();
    assert.equal(rows.length, 1, '整表覆盖');
    assert.equal(rows[0]['银行单交易编号'], '999');
  });
});

test.describe('migrations — ensureBocFxLinkSupport 幂等', () => {
  let mTmpDir;
  let mDb;

  test.beforeEach(() => {
    mTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boc-migration-'));
    mDb = new DatabaseSync(path.join(mTmpDir, 'm.sqlite'));
  });

  test.afterEach(() => {
    try { if (mDb && mDb.close) mDb.close(); } catch (_e) { /* ignore */ }
    if (mTmpDir) { fs.rmSync(mTmpDir, { recursive: true, force: true }); mTmpDir = null; }
  });

  function schemaFingerprint(database, table) {
    const cols = database.prepare(`PRAGMA table_info('${table}')`).all()
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`).sort();
    const idx = database.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}' AND name NOT LIKE 'sqlite_%'`
    ).all().map((r) => r.name).sort();
    return { cols, idx };
  }

  // UT-BOC-1：连续调 2 次不报错 + 表结构一致（两表 + 三索引）
  test('UT-BOC-1：ensureBocFxLinkSupport 连续调 2 次不报错、两表结构 + 索引一致', () => {
    assert.doesNotThrow(() => ensureBocFxLinkSupport(mDb));
    const fpFx1 = schemaFingerprint(mDb, 'linked_boc_fx_settlement');
    const fpBank1 = schemaFingerprint(mDb, 'linked_boc_bank_deposit');
    assert.doesNotThrow(() => ensureBocFxLinkSupport(mDb)); // 幂等 no-op
    const fpFx2 = schemaFingerprint(mDb, 'linked_boc_fx_settlement');
    const fpBank2 = schemaFingerprint(mDb, 'linked_boc_bank_deposit');
    assert.deepEqual(fpFx2, fpFx1, '交割链接表幂等');
    assert.deepEqual(fpBank2, fpBank1, '银行表幂等');
    // 列完整性（含 imported_at）
    assert.equal(fpFx1.cols.length, 9, 'linked_boc_fx_settlement 9 列');
    assert.equal(fpBank1.cols.length, 6, 'linked_boc_bank_deposit 6 列');
    for (const expected of ['id', 'transaction_no', 'group_no', 'allocation_no', 'recon_link_id', 'maturity_date', 'source_row', 'raw_json']) {
      assert.ok(mDb.prepare("PRAGMA table_info('linked_boc_fx_settlement')").all().map((c) => c.name).includes(expected), `fx 表应含列 ${expected}`);
    }
    // 索引完整性
    assert.ok(fpFx1.idx.includes('idx_linked_boc_fx_settlement_txn'), 'fx txn 索引');
    assert.ok(fpFx1.idx.includes('idx_linked_boc_fx_settlement_group'), 'fx group 索引');
    assert.ok(fpBank1.idx.includes('idx_linked_boc_bank_deposit_txn'), 'bank txn 索引');
  });

  // 建表 → 写入 → 再 ensure 不丢数据（CREATE IF NOT EXISTS 不重建表）
  test('UT-BOC-1b：建表 → 写入 → 再 ensure 不丢数据', () => {
    ensureBocFxLinkSupport(mDb);
    mDb.prepare(
      'INSERT INTO linked_boc_fx_settlement (transaction_no, group_no, allocation_no, recon_link_id, maturity_date, source_row, raw_json, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('100', '1', '', '', '2026-05-04', 3, '{"交易编号":"100"}', '2026-05-04T00:00:00.000Z');
    ensureBocFxLinkSupport(mDb); // 幂等再调
    const cnt = mDb.prepare('SELECT COUNT(*) AS c FROM linked_boc_fx_settlement').get().c;
    assert.equal(cnt, 1, 'CREATE IF NOT EXISTS 不重建表 → 数据保留');
  });
});
