// v3.0.1 需求1（task4）：网关对账单链接表「按数据日期范围统计 / 删除」仓储单测。
//
// 背景（🔴 资金对账红线）：
//   网关对账单链接表支持按 bill_date 闭区间删除（不可逆，OPEN-6 用户拍板：闭区间 + 直接删，无二次确认）。
//   删除走单事务 BEGIN/DELETE/COMMIT/ROLLBACK；删后 recomputeGatewayMeta 全表重算 rowCount/日期范围；
//   保留既有 source_file_name（删除非导入，不改来源名）。bill_date=null 的无日期行不被范围匹配（删不到）。
//   countGatewayBillByDateRange 为只读预览（前端删除弹框「将删约 N 行」），同闭区间口径。
//
// 范式同 linked-gateway-bill-upsert.test.js：临时 DatabaseSync + ensureLinkedTableSupport(db) 建 schema，
//   再调仓储函数（先 upsert 喂行作前置数据 → 再 count / delete 断言）。
//
// 覆盖：
//   UT-DEL-1  count 闭区间含端点 + null 日期行不计入
//   UT-DEL-2  delete 闭区间：deleted 正确、剩余行正确、null 日期行未被删、meta 全表重算
//   UT-DEL-3  删空整表有日期行：rowCount 仅剩 null 日期行数、dateMin/Max=null（全表重算非增量）
//   UT-DEL-4  source_file_name 删后保留（先 upsert 带来源名，再 delete，断言 meta 来源名不变）

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-del-range-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
  ensureLinkedTableSupport(db); // 🔴 必须先建表（含 recon_bill_biz_id + UNIQUE）
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造真实表头键名的网关行对象；billDate 传 '' 或不传 → bill_date 落库为 null（无日期行）
function gwRow(bizId, reconId, billDate) {
  const row = { reconciliationid: reconId };
  if (bizId !== undefined) row.ReconBillBizId = bizId;
  if (billDate !== undefined) row.Billdate = billDate;
  return row;
}

function tableRowCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM linked_gateway_bill').get().c;
}

function bizIds() {
  return db.prepare('SELECT recon_bill_biz_id FROM linked_gateway_bill ORDER BY recon_bill_biz_id').all().map((r) => r.recon_bill_biz_id);
}

// 喂入一组带不同 bill_date 的行（含 1 行无日期 bill_date=null）作前置数据。
function seedRows(sourceFileName) {
  repo.upsertLinkedGatewayBill(db, [
    gwRow('B-1', 'R-1', '2026-01-10'),
    gwRow('B-2', 'R-2', '2026-02-15'),
    gwRow('B-3', 'R-3', '2026-03-20'),
    gwRow('B-4', 'R-4', '2026-04-25'),
    gwRow('B-NULL', 'R-NULL', '')        // 无日期 → bill_date 落库 null（范围匹配不到）
  ], sourceFileName ? { sourceFileName } : {});
}

test.describe('linked-table-repository — 网关对账单按日期范围统计 / 删除（v3.0.1 task4）', () => {
  // UT-DEL-1：count 闭区间含端点 + null 日期行不计入
  test('UT-DEL-1：count 闭区间含端点、null 日期行不计入', () => {
    seedRows();
    assert.equal(tableRowCount(), 5, '前置 5 行（含 1 无日期行）');

    // 闭区间含端点：[2026-02-15, 2026-03-20] 含 B-2、B-3 两端点行
    assert.equal(repo.countGatewayBillByDateRange(db, '2026-02-15', '2026-03-20'), 2, '闭区间含两端点 → 2 行');
    // 全覆盖有日期行（1/10~4/25）→ 4 行（null 行不计入）
    assert.equal(repo.countGatewayBillByDateRange(db, '2026-01-01', '2026-12-31'), 4, '全覆盖有日期行 → 4 行，null 行不计入');
    // 单日精确命中端点
    assert.equal(repo.countGatewayBillByDateRange(db, '2026-01-10', '2026-01-10'), 1, '单日闭区间命中端点 B-1 → 1 行');
    // 区间无命中
    assert.equal(repo.countGatewayBillByDateRange(db, '2026-05-01', '2026-05-31'), 0, '区间无命中 → 0 行');
  });

  // UT-DEL-2：delete 闭区间——deleted 正确、剩余行正确、null 日期行未被删、meta 全表重算
  test('UT-DEL-2：delete 闭区间删除——deleted/剩余/null 行保留/meta 全表重算', () => {
    seedRows();

    // 删 [2026-02-01, 2026-03-31] → 命中 B-2(2/15)、B-3(3/20) 两行
    const ret = repo.deleteGatewayBillByDateRange(db, '2026-02-01', '2026-03-31');
    assert.equal(ret.deleted, 2, '删除 deleted=2（B-2、B-3）');

    // 剩余：B-1、B-4、B-NULL（含无日期行——证 null 行不被范围删）
    assert.deepEqual(bizIds(), ['B-1', 'B-4', 'B-NULL'], '剩余 B-1/B-4/B-NULL（null 行保留）');
    assert.equal(tableRowCount(), 3, '剩余 3 行');

    // meta 全表重算：rowCount=3（含 null 行），日期范围 = 剩余有日期行的 MIN/MAX（1/10~4/25）
    assert.equal(ret.rowCount, 3, '返回 rowCount=3（全表重算含 null 行）');
    assert.equal(ret.dataDateMin, '2026-01-10', '返回 dataDateMin=2026-01-10（B-1）');
    assert.equal(ret.dataDateMax, '2026-04-25', '返回 dataDateMax=2026-04-25（B-4）');

    const meta = repo.getLinkedTableMeta(db, 'gateway-bill');
    assert.equal(meta.rowCount, 3, 'meta.rowCount=3 落库一致');
    assert.equal(meta.dataDateMin, '2026-01-10', 'meta.dataDateMin 落库一致');
    assert.equal(meta.dataDateMax, '2026-04-25', 'meta.dataDateMax 落库一致');
  });

  // UT-DEL-3：删空整表有日期行 → rowCount 仅剩 null 日期行数、dateMin/Max=null
  test('UT-DEL-3：删空全部有日期行——rowCount 仅剩 null 行、dateMin/Max=null', () => {
    seedRows();

    // 范围覆盖全部有日期行（1/10~4/25）→ 删 4 行，仅留 B-NULL
    const ret = repo.deleteGatewayBillByDateRange(db, '2026-01-01', '2026-12-31');
    assert.equal(ret.deleted, 4, '删除全部 4 个有日期行');
    assert.deepEqual(bizIds(), ['B-NULL'], '仅剩无日期行 B-NULL');

    // meta 全表重算：rowCount=1（仅 null 行），日期范围全为 null
    assert.equal(ret.rowCount, 1, '返回 rowCount=1（仅 null 行，非增量）');
    assert.equal(ret.dataDateMin, null, '返回 dataDateMin=null（无有日期行）');
    assert.equal(ret.dataDateMax, null, '返回 dataDateMax=null');

    const meta = repo.getLinkedTableMeta(db, 'gateway-bill');
    assert.equal(meta.rowCount, 1, 'meta.rowCount=1 落库一致');
    assert.equal(meta.dataDateMin, null, 'meta.dataDateMin=null 落库一致');
    assert.equal(meta.dataDateMax, null, 'meta.dataDateMax=null 落库一致');
  });

  // UT-DEL-4：source_file_name 删后保留（删除非导入，不改来源名）
  test('UT-DEL-4：source_file_name 删后保留不变', () => {
    seedRows('gw-original.xlsx');
    const metaBefore = repo.getLinkedTableMeta(db, 'gateway-bill');
    assert.equal(metaBefore.sourceFileName, 'gw-original.xlsx', '前置来源名 gw-original.xlsx');

    repo.deleteGatewayBillByDateRange(db, '2026-02-01', '2026-03-31');

    const metaAfter = repo.getLinkedTableMeta(db, 'gateway-bill');
    assert.equal(metaAfter.sourceFileName, 'gw-original.xlsx', '🔴 删除后来源名保持 gw-original.xlsx 不变');
  });
});
