// v2.1.16-beta.3 ②：银行对账单入金表（bank-deposit）链接表仓储单测（UT-L1~L8）
//
// 覆盖：整表覆盖 / 键列归一 / 日期范围 / raw_json 仅 13 字段 / listLinkedTableMeta 5 行 /
//       ALL_TABLE_KEYS 含 bank-deposit / supported=true / readLinkedTableRows 还原。
// 数据真相：raw_json 存裁列后 13 字段对象；date 列仅供 min/max 范围与索引（与现有链接表同范式）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');
const { BANK_STATEMENT_FIELDS } = require('../../../../src/constants/bank-statement-fields');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-deposit-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造一条「已裁列」的入金表 13 字段行（与 main.js handler 裁列后形态一致）。
function depositRow(overrides = {}) {
  const base = {
    BizId: 'B001',
    BillDate: '2026-03-10',
    ValueDate: '2026-03-11',
    Channel: 'JPM',
    地区: 'HK',
    MerchantId: 'M001',
    Currency: 'USD',
    'Credit Amount': '100',
    'Debit Amount': '0',
    ReconciliationId: 'R001',
    ChannelOrderNo: 'CO001',
    CustomerRef: 'CR001',
    FundType: 'Deposit'
  };
  return { ...base, ...overrides };
}

test.describe('linked-table-repository — bank-deposit 入金表（v2.1.16-beta.3 ②）', () => {
  // UT-L6：ALL_TABLE_KEYS 含 bank-deposit 且在末位
  test('UT-L6：ALL_TABLE_KEYS 含 bank-deposit 且排末位', () => {
    assert.ok(linkedRepo.ALL_TABLE_KEYS.includes('bank-deposit'), 'ALL_TABLE_KEYS 必须含 bank-deposit');
    assert.equal(
      linkedRepo.ALL_TABLE_KEYS[linkedRepo.ALL_TABLE_KEYS.length - 1],
      'bank-deposit',
      'bank-deposit 排末位（弹窗第 5 行）'
    );
  });

  // UT-L7：supported=true，replaceLinkedTable 不抛「模板缺失」
  test('UT-L7：LINKED_TABLE_DEFS bank-deposit supported=true，写入不抛模板缺失', () => {
    assert.equal(linkedRepo.LINKED_TABLE_DEFS['bank-deposit'].supported, true);
    assert.doesNotThrow(() => {
      linkedRepo.replaceLinkedTable(db, 'bank-deposit', [depositRow()], { sourceFileName: 'a.xlsx' });
    });
  });

  // UT-L5：listLinkedTableMeta 返回 5 行，末位 tableKey='bank-deposit'
  test('UT-L5：listLinkedTableMeta 返回 5 行，末位 bank-deposit', () => {
    const metas = linkedRepo.listLinkedTableMeta(db);
    assert.equal(metas.length, 5, '链接表 meta 现 5 行');
    assert.equal(metas[metas.length - 1].tableKey, 'bank-deposit');
  });

  // UT-L1：整表覆盖（连续两次 replaceLinkedTable → 仅第二批）
  test('UT-L1：整表覆盖 — 第二次导入后仅含第二批数据', () => {
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [
      depositRow({ ReconciliationId: 'OLD1' }),
      depositRow({ ReconciliationId: 'OLD2' })
    ], { sourceFileName: 'first.xlsx' });

    const ret = linkedRepo.replaceLinkedTable(db, 'bank-deposit', [
      depositRow({ ReconciliationId: 'NEW1' })
    ], { sourceFileName: 'second.xlsx' });

    assert.equal(ret.rowCount, 1, '第二批 1 行');
    const rows = linkedRepo.readLinkedTableRows(db, 'bank-deposit');
    assert.equal(rows.length, 1, '整表覆盖：第一批 2 行被全删');
    assert.equal(rows[0].ReconciliationId, 'NEW1', '仅剩第二批数据');
    const meta = linkedRepo.getLinkedTableMeta(db, 'bank-deposit');
    assert.equal(meta.rowCount, 1);
    assert.equal(meta.sourceFileName, 'second.xlsx');
  });

  // UT-L2：键列归一（reconciliation_id = String(ReconciliationId).trim()，含 number 入参）
  test('UT-L2：键列 reconciliation_id 归一为 String().trim()（含 number 入参）', () => {
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [
      depositRow({ ReconciliationId: 987654321 }),       // number
      depositRow({ ReconciliationId: '  R-PAD  ' })       // 前后空格
    ], {});
    const keys = db.prepare('SELECT reconciliation_id FROM linked_bank_deposit ORDER BY id ASC')
      .all().map((r) => r.reconciliation_id);
    assert.deepEqual(keys, ['987654321', 'R-PAD'], 'number 转字符串、前后空格 trim');
  });

  // UT-L3：日期范围（bill_date 归一为 YYYY-MM-DD；meta dataDateMin/Max = BillDate min/max）
  test('UT-L3：bill_date 归一为 YYYY-MM-DD，meta dataDateMin/Max = BillDate min/max', () => {
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [
      depositRow({ BillDate: '2026/03/10', ReconciliationId: 'D1' }), // 斜杠格式
      depositRow({ BillDate: '2026-01-05', ReconciliationId: 'D2' }),
      depositRow({ BillDate: '2026-05-20', ReconciliationId: 'D3' })
    ], {});
    const dates = db.prepare('SELECT bill_date FROM linked_bank_deposit ORDER BY id ASC')
      .all().map((r) => r.bill_date);
    assert.equal(dates[0], '2026-03-10', '斜杠格式归一为 YYYY-MM-DD');
    const meta = linkedRepo.getLinkedTableMeta(db, 'bank-deposit');
    assert.equal(meta.dataDateMin, '2026-01-05', 'min = 最早 BillDate');
    assert.equal(meta.dataDateMax, '2026-05-20', 'max = 最晚 BillDate');
  });

  // UT-L4：raw_json 仅 13 字段（传入 13 字段对象 → 读回恰好 13 键）
  test('UT-L4：raw_json 恰好 13 键，无多余列', () => {
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [depositRow()], {});
    const raw = db.prepare('SELECT raw_json FROM linked_bank_deposit ORDER BY id ASC').get().raw_json;
    const obj = JSON.parse(raw);
    const keys = Object.keys(obj).sort();
    assert.equal(keys.length, 13, 'raw_json 恰好 13 字段');
    assert.deepEqual(keys, [...linkedRepo.BANK_DEPOSIT_FIELDS].sort(), '字段集合 = BANK_DEPOSIT_FIELDS');
    // 不含主表其余列（抽查几个不在 13 字段内的列）
    assert.ok(!('账户主体' in obj), '不含账户主体');
    assert.ok(!('Recon Amount' in obj), '不含 Recon Amount');
    assert.ok(!('拆分信息' in obj), '不含拆分信息');
  });

  // UT-L8：readLinkedTableRows 还原（13 字段对象数组，按 id ASC 保序）
  test('UT-L8：readLinkedTableRows 还原 13 字段对象数组并按 id ASC 保序', () => {
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [
      depositRow({ ReconciliationId: 'S1' }),
      depositRow({ ReconciliationId: 'S2' }),
      depositRow({ ReconciliationId: 'S3' })
    ], {});
    const rows = linkedRepo.readLinkedTableRows(db, 'bank-deposit');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.ReconciliationId), ['S1', 'S2', 'S3'], '按 id ASC 保序');
    assert.equal(Object.keys(rows[0]).length, 13, '每行 13 字段');
  });

  // 辅助断言：13 字段全部 ∈ BANK_STATEMENT_FIELDS（与 UT-C5 同口径，防漂移；本文件就近守护）
  test('BANK_DEPOSIT_FIELDS 全部 ∈ BANK_STATEMENT_FIELDS（防常量漂移）', () => {
    assert.equal(linkedRepo.BANK_DEPOSIT_FIELDS.length, 13);
    assert.ok(
      linkedRepo.BANK_DEPOSIT_FIELDS.every((f) => BANK_STATEMENT_FIELDS.includes(f)),
      '13 字段必须全部存在于 BANK_STATEMENT_FIELDS'
    );
  });
});
