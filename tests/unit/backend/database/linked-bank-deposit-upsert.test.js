// v3.0.5 需求1：银行对账单入金表链接表「按 BizId 幂等 upsert」仓储单测。
//
// 背景（🔴 资金对账红线）：
//   银行对账单入金表批量导入改「累加不整表覆盖」——按 biz_id（T1 迁移建的 UNIQUE 键）
//   ON CONFLICT DO UPDATE。多次导入：同 BizId 覆盖为最新、不同 BizId 累加保留、空键拒入。
//   meta 累加后必须全表重算（rowCount/日期范围不是单批增量）；流式版中途 throw 必须整批 ROLLBACK。
//   幂等键口径：bizId = normalizeKey(obj.BizId)（精确大小写 BizId）= migration 回填 TRIM(json_extract(...,'$.BizId')) 字节一致。
//
// 范式同 linked-gateway-bill-upsert.test.js：临时 DatabaseSync + ensureLinkedTableSupport(db)
//   建 schema（含 biz_id + UNIQUE），再调 upsert。
//
// 覆盖：
//   UT-BD-UPSERT-1  幂等：同一 BizId 连导 2 次 → 表内仅 1 行、为最新值
//   UT-BD-UPSERT-2  累加不覆盖：先 {BIZ-A} 再 {BIZ-B} → 2 行（A 不被删，证无整表 DELETE）
//   UT-BD-UPSERT-3  overwriteCount：{A,B} 后 {B,C} → overwriteCount=1（命中 B）、upserted=2
//   UT-BD-UPSERT-4  空键拒入：空串/缺字段/纯空白拒入 + rejectedEmptyCount；带空格有效键 TRIM 入库
//   UT-BD-UPSERT-5  meta 全表重算：跨 2 批不同 bill_date → rowCount/min/max = 全表跨两批
//   UT-BD-UPSERT-6  流式版：feedRows 喂行与数组版等价（幂等 + 计数）
//   UT-BD-UPSERT-7  ROLLBACK（🔴 R-6）：流式 feedRows 中途 throw → 整批回滚，表保持调用前状态
//   UT-BD-UPSERT-8  幂等键独立于展示键列：同 ReconciliationId 不同 BizId → 2 行（证幂等键是 BizId 非 reconciliation_id）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureLinkedTableSupport } = require('../../../../src/backend/database/migrations');
const repo = require('../../../../src/backend/database/linked-table-repository');

let tmpDir;
let db;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-upsert-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
  ensureLinkedTableSupport(db); // 🔴 必须先建表（含 biz_id + UNIQUE）
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造真实表头键名的入金表行对象（bank-deposit def：keyHeader=ReconciliationId / dateHeader=BillDate）。
function bdRow(bizId, reconId, billDate, extra = {}) {
  const row = { ReconciliationId: reconId, BillDate: billDate, ...extra };
  if (bizId !== undefined) row.BizId = bizId;
  return row;
}

function tableRowCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM linked_bank_deposit').get().c;
}

function allRows() {
  return db.prepare('SELECT biz_id, reconciliation_id, bill_date, raw_json FROM linked_bank_deposit ORDER BY biz_id').all();
}

function rawOf(bizId) {
  const r = db.prepare('SELECT raw_json FROM linked_bank_deposit WHERE biz_id = ?').get(bizId);
  return r ? JSON.parse(r.raw_json) : null;
}

test.describe('linked-table-repository — 银行对账单入金表幂等 upsert（v3.0.5 需求1）', () => {
  // UT-BD-UPSERT-1：同一 BizId 连导 2 次 → 仅 1 行且为最新值
  test('UT-BD-UPSERT-1：幂等——同一 BizId 连导 2 次仅 1 行、值更新为最新', () => {
    repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-A', 'R-A1', '2026-01-01', { 'Credit Amount': '100' })]);
    const r1 = repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-A', 'R-A2', '2026-02-02', { 'Credit Amount': '200' })]);

    assert.equal(tableRowCount(), 1, '同 BizId 连导 2 次表内仅 1 行');
    const raw = rawOf('BIZ-A');
    assert.equal(raw.ReconciliationId, 'R-A2', 'raw_json 更新为最新 ReconciliationId');
    assert.equal(raw['Credit Amount'], '200', 'raw_json 更新为最新 Credit Amount');
    const dbRow = db.prepare("SELECT reconciliation_id, bill_date FROM linked_bank_deposit WHERE biz_id = 'BIZ-A'").get();
    assert.equal(dbRow.reconciliation_id, 'R-A2', '展示键列更新为最新');
    assert.equal(dbRow.bill_date, '2026-02-02', '日期列更新为最新');
    assert.equal(r1.overwriteCount, 1, '第二次命中已存在 BizId → overwriteCount=1');
    assert.equal(r1.upserted, 1, '第二次 upserted=1');
  });

  // UT-BD-UPSERT-2：先 A 再 B → 2 行（A 不被删，证无整表 DELETE）
  test('UT-BD-UPSERT-2：累加不覆盖——先 {BIZ-A} 再 {BIZ-B} → 2 行，A 仍在', () => {
    repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-A', 'R-A', '2026-01-01')]);
    repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-B', 'R-B', '2026-01-02')]);

    assert.equal(tableRowCount(), 2, '第二批不删第一批 → 2 行（证无整表 DELETE）');
    assert.deepEqual(allRows().map((r) => r.biz_id), ['BIZ-A', 'BIZ-B'], 'A、B 都在');
  });

  // UT-BD-UPSERT-3：{A,B} 后 {B,C} → overwriteCount=1、upserted=2
  test('UT-BD-UPSERT-3：overwriteCount——{A,B} 后 {B,C} 命中 B → overwriteCount=1、upserted=2', () => {
    const first = repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-A', 'R-A', '2026-01-01'),
      bdRow('BIZ-B', 'R-B', '2026-01-02')
    ]);
    assert.equal(first.overwriteCount, 0, '首批全新 → overwriteCount=0');
    assert.equal(first.upserted, 2, '首批 upserted=2');

    const second = repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-B', 'R-B2', '2026-01-03'),
      bdRow('BIZ-C', 'R-C', '2026-01-04')
    ]);
    assert.equal(second.overwriteCount, 1, '第二批命中已存在 BIZ-B → overwriteCount=1');
    assert.equal(second.upserted, 2, '第二批 upserted=2（B 覆盖 + C 新增）');
    assert.equal(tableRowCount(), 3, '累加后表内 A、B、C 共 3 行');
  });

  // UT-BD-UPSERT-4：空键拒入 + 带空格有效键 TRIM 入库
  test('UT-BD-UPSERT-4：空键拒入（空串/缺字段/纯空白）；带空格有效键 TRIM 入库', () => {
    const res = repo.upsertLinkedBankDeposit(db, [
      bdRow('', 'R-empty', '2026-01-01'),          // 空串 → 拒
      bdRow(undefined, 'R-missing', '2026-01-02'),  // 缺字段 → 拒
      bdRow('   ', 'R-blank', '2026-01-03'),        // 纯空白 → 拒
      bdRow('  BIZ-X  ', 'R-X', '2026-01-04')       // 带前后空格有效键 → 入库且 TRIM
    ]);

    assert.equal(res.rejectedEmptyCount, 3, '空串/缺字段/纯空白 共 3 行拒入');
    assert.equal(res.upserted, 1, '仅 1 行有效键入库');
    assert.equal(tableRowCount(), 1, '表内仅 1 行');
    assert.deepEqual(allRows().map((r) => r.biz_id), ['BIZ-X'], '键被 TRIM 成 BIZ-X（口径与 migration 一致）');
    assert.equal(rawOf('BIZ-X').ReconciliationId, 'R-X', '有效键行落库正确');
  });

  // UT-BD-UPSERT-5：meta 全表重算（跨 2 批不同 bill_date）
  test('UT-BD-UPSERT-5：meta 全表重算——rowCount/dataDateMin/Max 跨两批为全表口径', () => {
    repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-A', 'R-A', '2026-03-15'),
      bdRow('BIZ-B', 'R-B', '2026-03-20')
    ], { sourceFileName: 'bd-batch1.xlsx' });

    const r2 = repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-C', 'R-C', '2026-01-05'), // 更早 → 拉低 min
      bdRow('BIZ-D', 'R-D', '2026-05-30')  // 更晚 → 拉高 max
    ], { sourceFileName: 'bd-batch2.xlsx' });

    assert.equal(r2.rowCount, 4, '返回 rowCount = 全表 4 行（非单批 2 行）');
    assert.equal(r2.dataDateMin, '2026-01-05', 'dataDateMin = 全表跨两批最早');
    assert.equal(r2.dataDateMax, '2026-05-30', 'dataDateMax = 全表跨两批最晚');

    const meta = repo.getLinkedTableMeta(db, 'bank-deposit');
    assert.equal(meta.rowCount, 4, 'meta.rowCount 全表 4 行');
    assert.equal(meta.dataDateMin, '2026-01-05', 'meta.dataDateMin 全表最早');
    assert.equal(meta.dataDateMax, '2026-05-30', 'meta.dataDateMax 全表最晚');
    assert.equal(meta.sourceFileName, 'bd-batch2.xlsx', 'sourceFileName = 最近一批');
  });

  // UT-BD-UPSERT-6：流式版与数组版等价（幂等 + 计数）
  test('UT-BD-UPSERT-6：流式版——feedRows 喂行与数组版等价（幂等 + 计数）', async () => {
    const rows = [
      bdRow('BIZ-A', 'R-A1', '2026-01-01'),
      bdRow('BIZ-B', 'R-B', '2026-01-02')
    ];
    const first = await repo.upsertLinkedBankDepositStreaming(db, async (upsertOne) => {
      rows.forEach(upsertOne);
    });
    assert.equal(first.upserted, 2, '流式首批 upserted=2');
    assert.equal(first.overwriteCount, 0, '流式首批 overwriteCount=0');
    assert.equal(tableRowCount(), 2, '流式首批 2 行入库');

    const second = await repo.upsertLinkedBankDepositStreaming(db, async (upsertOne) => {
      [
        bdRow('BIZ-A', 'R-A2', '2026-02-02'), // 覆盖
        bdRow('BIZ-C', 'R-C', '2026-01-03'),  // 新增
        bdRow('', 'R-empty', '2026-01-04')    // 空键拒入
      ].forEach(upsertOne);
    });
    assert.equal(second.overwriteCount, 1, '流式第二批命中 BIZ-A → overwriteCount=1');
    assert.equal(second.upserted, 2, '流式第二批 upserted=2（A 覆盖 + C 新增）');
    assert.equal(second.rejectedEmptyCount, 1, '流式第二批空键拒入 1');
    assert.equal(tableRowCount(), 3, '累加后 A、B、C 共 3 行');
    assert.equal(rawOf('BIZ-A').ReconciliationId, 'R-A2', '流式 BIZ-A 覆盖为最新值');

    await assert.rejects(
      () => repo.upsertLinkedBankDepositStreaming(db, null),
      /feedRows/,
      '流式版 feedRows 非函数 → 守卫抛错'
    );
  });

  // UT-BD-UPSERT-7：🔴 R-6 流式中途 throw → 整批 ROLLBACK，表保持调用前状态
  test('UT-BD-UPSERT-7：ROLLBACK（R-6）——流式 feedRows 中途 throw → 整批回滚，表不变', async () => {
    repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-A', 'R-A', '2026-01-01'),
      bdRow('BIZ-B', 'R-B', '2026-01-02')
    ]);
    const before = allRows();
    assert.equal(before.length, 2, '前置 2 行');
    const metaBefore = repo.getLinkedTableMeta(db, 'bank-deposit');

    await assert.rejects(
      () => repo.upsertLinkedBankDepositStreaming(db, async (upsertOne) => {
        upsertOne(bdRow('BIZ-C', 'R-C', '2026-01-03')); // 这行不应最终入库
        throw new Error('boom: 模拟流式中途失败');
      }),
      /boom/,
      '流式中途 throw 向上抛'
    );

    const after = allRows();
    assert.equal(after.length, 2, '🔴 回滚后仍是 2 行（BIZ-C 未入）');
    assert.deepEqual(after.map((r) => r.biz_id), ['BIZ-A', 'BIZ-B'], '🔴 表保持 A、B 不变');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM linked_bank_deposit WHERE biz_id = 'BIZ-C'").get().c, 0, 'BIZ-C 未入库');

    const metaAfter = repo.getLinkedTableMeta(db, 'bank-deposit');
    assert.equal(metaAfter.rowCount, metaBefore.rowCount, 'meta.rowCount 未变');
    assert.equal(metaAfter.dataDateMin, metaBefore.dataDateMin, 'meta.dataDateMin 未变');
    assert.equal(metaAfter.dataDateMax, metaBefore.dataDateMax, 'meta.dataDateMax 未变');

    assert.doesNotThrow(() => repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-D', 'R-D', '2026-01-04')]), '回滚后可继续 upsert');
    assert.equal(tableRowCount(), 3, '回滚后续 upsert 正常 → A、B、D 共 3 行');
  });

  // UT-BD-UPSERT-8：幂等键 = BizId（独立于展示键列 reconciliation_id）
  //   🔴 资金红线（spec §1.4-3）：银行侧同 ReconciliationId 多行 = 合法数据；幂等键用 BizId 不可用 ReconciliationId，
  //     否则会静默互相覆盖丢行。本案证：同 ReconciliationId、不同 BizId → 2 行并存（不互相覆盖）。
  test('UT-BD-UPSERT-8：幂等键是 BizId 而非 reconciliation_id——同 ReconId 不同 BizId 累加 2 行', () => {
    const res = repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-A', 'SAME-RECON', '2026-01-01'),
      bdRow('BIZ-B', 'SAME-RECON', '2026-01-02')
    ]);
    assert.equal(res.upserted, 2, '同 ReconciliationId 两行 upserted=2');
    assert.equal(res.overwriteCount, 0, '不同 BizId → 无覆盖');
    assert.equal(tableRowCount(), 2, '🔴 同 ReconId 不同 BizId 累加为 2 行（未互相覆盖）');
    assert.deepEqual(allRows().map((r) => r.biz_id), ['BIZ-A', 'BIZ-B'], '两 BizId 都在');
    assert.deepEqual(
      allRows().map((r) => r.reconciliation_id),
      ['SAME-RECON', 'SAME-RECON'],
      '两行 reconciliation_id 相同（证展示键列允许重复，幂等仅靠 biz_id）'
    );
  });
});
