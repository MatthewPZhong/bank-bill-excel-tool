// v3.0.5 OPEN-4（T6a）：银行对账单入金表链接表「按数据日期范围统计 / 删除」仓储单测。
//
// 背景（🔴 资金对账红线）：
//   入金表删除三表化——countBankDepositByDateRange（只读预览）+ deleteBankDepositByDateRange（不可逆删除）。
//   删除走单事务 BEGIN/DELETE/COMMIT/ROLLBACK；删后 recomputeLinkedMeta 全表重算 rowCount/日期范围；
//   保留既有 source_file_name（删除非导入，不改来源名）；bill_date=null/'' 的无日期行不被范围匹配（删不到）。
//   🔴 删前同事务收集 deletedBizIds（normalizeKey 去空 + 去重）——T6b 用于清 OPEN-7 命中标记 / ADM·BOC bank 派生重建。
//   count 预览与 delete 实删共用同一 WHERE（buildDateRangeWhere）→ 预览 = 实删（资金红线下删除行数不失真）。
//
// 范式同 linked-gateway-bill-delete-by-range.test.js：临时 DatabaseSync + ensureLinkedTableSupport(db) 建 schema
//   （含 biz_id + UNIQUE），先 upsert 喂行作前置数据 → 再 count / delete 断言。
//
// 覆盖：
//   UT-BD-DEL-1  count 闭区间含端点 + null 日期行不计入 + 无命中=0 + 全覆盖正确
//   UT-BD-DEL-2  delete：deleted 正确 / 剩余正确 / null bill_date 行不删 / meta 全表重算
//   UT-BD-DEL-3  deletedBizIds 正确（去空去重；仅含被删行的 BizId）
//   UT-BD-DEL-4  source_file_name 删后保留不变
//   UT-BD-DEL-5  删空全部有日期行 → rowCount 仅剩 null 行、dateMin/Max=null（全表重算非增量）

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-del-range-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
  ensureLinkedTableSupport(db); // 🔴 必须先建表（含 biz_id + UNIQUE）
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造真实表头键名的入金表行对象（bank-deposit def：keyHeader=ReconciliationId / dateHeader=BillDate）。
//   billDate 传 '' 或不传 → bill_date 落库为 null（无日期行，范围匹配不到）。
function bdRow(bizId, reconId, billDate) {
  const row = { ReconciliationId: reconId };
  if (bizId !== undefined) row.BizId = bizId;
  if (billDate !== undefined) row.BillDate = billDate;
  return row;
}

function tableRowCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM linked_bank_deposit').get().c;
}

function bizIds() {
  return db.prepare('SELECT biz_id FROM linked_bank_deposit ORDER BY biz_id').all().map((r) => r.biz_id);
}

// 喂入一组带不同 bill_date 的行（含 1 行无日期 bill_date=null）作前置数据。
function seedRows(sourceFileName) {
  repo.upsertLinkedBankDeposit(db, [
    bdRow('BIZ-1', 'R-1', '2026-01-10'),
    bdRow('BIZ-2', 'R-2', '2026-02-15'),
    bdRow('BIZ-3', 'R-3', '2026-03-20'),
    bdRow('BIZ-4', 'R-4', '2026-04-25'),
    bdRow('BIZ-NULL', 'R-NULL', '')        // 无日期 → bill_date 落库 null（范围匹配不到）
  ], sourceFileName ? { sourceFileName } : {});
}

test.describe('linked-table-repository — 银行对账单入金表按日期范围统计 / 删除（v3.0.5 OPEN-4 T6a）', () => {
  // UT-BD-DEL-1：count 闭区间含端点、null 日期行不计入、无命中=0、全覆盖正确
  test('UT-BD-DEL-1：count 闭区间含端点 / null 行不计入 / 无命中=0 / 全覆盖正确', () => {
    seedRows();
    assert.equal(tableRowCount(), 5, '前置 5 行（含 1 无日期行）');

    // 闭区间含端点：[2026-02-15, 2026-03-20] 含 BIZ-2、BIZ-3 两端点行
    assert.equal(repo.countBankDepositByDateRange(db, '2026-02-15', '2026-03-20'), 2, '闭区间含两端点 → 2 行');
    // 全覆盖有日期行（1/10~4/25）→ 4 行（null 行不计入）
    assert.equal(repo.countBankDepositByDateRange(db, '2026-01-01', '2026-12-31'), 4, '全覆盖有日期行 → 4 行，null 行不计入');
    // 单日精确命中端点
    assert.equal(repo.countBankDepositByDateRange(db, '2026-01-10', '2026-01-10'), 1, '单日闭区间命中端点 BIZ-1 → 1 行');
    // 区间无命中
    assert.equal(repo.countBankDepositByDateRange(db, '2026-05-01', '2026-05-31'), 0, '区间无命中 → 0 行');
  });

  // UT-BD-DEL-2：delete 闭区间——deleted/剩余/null 行保留/meta 全表重算
  test('UT-BD-DEL-2：delete 闭区间——deleted/剩余/null 行保留/meta 全表重算', () => {
    seedRows();

    // 删 [2026-02-01, 2026-03-31] → 命中 BIZ-2(2/15)、BIZ-3(3/20) 两行
    const ret = repo.deleteBankDepositByDateRange(db, '2026-02-01', '2026-03-31');
    assert.equal(ret.deleted, 2, '删除 deleted=2（BIZ-2、BIZ-3）');

    // 剩余：BIZ-1、BIZ-4、BIZ-NULL（含无日期行——证 null 行不被范围删）
    assert.deepEqual(bizIds(), ['BIZ-1', 'BIZ-4', 'BIZ-NULL'], '剩余 BIZ-1/BIZ-4/BIZ-NULL（null 行保留）');
    assert.equal(tableRowCount(), 3, '剩余 3 行');

    // meta 全表重算：rowCount=3（含 null 行），日期范围 = 剩余有日期行的 MIN/MAX（1/10~4/25）
    assert.equal(ret.rowCount, 3, '返回 rowCount=3（全表重算含 null 行）');
    assert.equal(ret.dataDateMin, '2026-01-10', '返回 dataDateMin=2026-01-10（BIZ-1）');
    assert.equal(ret.dataDateMax, '2026-04-25', '返回 dataDateMax=2026-04-25（BIZ-4）');

    const meta = repo.getLinkedTableMeta(db, 'bank-deposit');
    assert.equal(meta.rowCount, 3, 'meta.rowCount=3 落库一致');
    assert.equal(meta.dataDateMin, '2026-01-10', 'meta.dataDateMin 落库一致');
    assert.equal(meta.dataDateMax, '2026-04-25', 'meta.dataDateMax 落库一致');
  });

  // UT-BD-DEL-3：🔴 deletedBizIds 正确（删前同事务收集；仅被删行的 BizId；去空去重）
  test('UT-BD-DEL-3：deletedBizIds 正确（仅被删行 / 去空去重）', () => {
    seedRows();

    const ret = repo.deleteBankDepositByDateRange(db, '2026-02-01', '2026-03-31');
    // deletedBizIds 应恰为被删的 BIZ-2、BIZ-3（顺序无关，排序后断言）
    assert.deepEqual([...ret.deletedBizIds].sort(), ['BIZ-2', 'BIZ-3'], 'deletedBizIds = 被删行的 BizId（BIZ-2、BIZ-3）');
    // 未删行 BizId 不在 deletedBizIds
    assert.ok(!ret.deletedBizIds.includes('BIZ-1'), '未删行 BIZ-1 不在 deletedBizIds');
    assert.ok(!ret.deletedBizIds.includes('BIZ-NULL'), 'null 日期未删行 BIZ-NULL 不在 deletedBizIds');
  });

  // UT-BD-DEL-3b：deletedBizIds 去重——同一区间内即便底层多行（此处单键 UNIQUE 不可能重复，验证 Set 去重 + 空键过滤逻辑）
  test('UT-BD-DEL-3b：deletedBizIds 无空键、无重复', () => {
    seedRows();
    const ret = repo.deleteBankDepositByDateRange(db, '2026-01-01', '2026-12-31'); // 删全部有日期行
    assert.deepEqual([...ret.deletedBizIds].sort(), ['BIZ-1', 'BIZ-2', 'BIZ-3', 'BIZ-4'], '4 个有日期行 BizId 全收集');
    assert.equal(new Set(ret.deletedBizIds).size, ret.deletedBizIds.length, 'deletedBizIds 无重复');
    assert.ok(ret.deletedBizIds.every((k) => k !== ''), 'deletedBizIds 无空键');
  });

  // UT-BD-DEL-4：source_file_name 删后保留（删除非导入，不改来源名）
  test('UT-BD-DEL-4：source_file_name 删后保留不变', () => {
    seedRows('bank-deposit-original.xlsx');
    const metaBefore = repo.getLinkedTableMeta(db, 'bank-deposit');
    assert.equal(metaBefore.sourceFileName, 'bank-deposit-original.xlsx', '前置来源名');

    repo.deleteBankDepositByDateRange(db, '2026-02-01', '2026-03-31');

    const metaAfter = repo.getLinkedTableMeta(db, 'bank-deposit');
    assert.equal(metaAfter.sourceFileName, 'bank-deposit-original.xlsx', '🔴 删除后来源名保持不变');
  });

  // UT-BD-DEL-5：删空全部有日期行 → rowCount 仅剩 null 行、dateMin/Max=null
  test('UT-BD-DEL-5：删空全部有日期行——rowCount 仅剩 null 行、dateMin/Max=null', () => {
    seedRows();

    const ret = repo.deleteBankDepositByDateRange(db, '2026-01-01', '2026-12-31');
    assert.equal(ret.deleted, 4, '删除全部 4 个有日期行');
    assert.deepEqual(bizIds(), ['BIZ-NULL'], '仅剩无日期行 BIZ-NULL');

    assert.equal(ret.rowCount, 1, '返回 rowCount=1（仅 null 行，非增量）');
    assert.equal(ret.dataDateMin, null, '返回 dataDateMin=null（无有日期行）');
    assert.equal(ret.dataDateMax, null, '返回 dataDateMax=null');

    const meta = repo.getLinkedTableMeta(db, 'bank-deposit');
    assert.equal(meta.rowCount, 1, 'meta.rowCount=1 落库一致');
    assert.equal(meta.dataDateMin, null, 'meta.dataDateMin=null 落库一致');
  });
});
