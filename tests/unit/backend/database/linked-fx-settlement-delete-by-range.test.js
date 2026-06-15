// v3.0.5 OPEN-4（T6a）：外汇交割表链接表「按数据日期范围统计 / 删除 + 联动删 BOC 派生表」仓储单测。
//
// 背景（🔴🔴 资金对账红线）：
//   fx 删除三表化——countFxByDateRange（只读预览）+ deleteFxByDateRange（不可逆删除 + 联动删 BOC）。
//   删除走单事务 BEGIN/DELETE/COMMIT/ROLLBACK；删 fx 主表后 recomputeLinkedMeta 全表重算；保留 source_file_name。
//   🔴 联动删 BOC：按被删 fx 行的 transaction_no 集合 DELETE FROM linked_boc_fx_settlement WHERE transaction_no IN(...)，
//      分 chunk ≤900 规避 IN 参数上限；⚠️⚠️ 绝不按 maturity_date / 日期删 BOC（BOC 日期列是到期日，与删除区间无关）。
//   🔴 删主表 + 删 BOC 同一事务：中途任意 throw → 全 ROLLBACK，两表回到删前态。
//   🔴 删前同事务收集 deletedTxnNos（删后行已不在无法补查）；fx 主表 transaction_no 列与 BOC transaction_no 列同口径
//      （均 normalizeKey(normalizeTransactionNo(...))，字节对齐可直接作 IN 匹配键）。
//
// 范式：临时 DatabaseSync + ensureLinkedTableSupport(db)（fx 主表 + UNIQUE）+ ensureBocFxLinkSupport(db)
//   （BOC 表 + orig_group_no + transaction_no UNIQUE）；upsertLinkedFx 喂 fx 主表行、upsertBocFxLink 喂 BOC 行。
//
// 覆盖：
//   UT-FX-DEL-1  count 闭区间含端点 + null 日期行不计入 + 无命中=0 + 全覆盖正确
//   UT-FX-DEL-2  delete fx 主表：deleted 正确 / 剩余正确 / null transaction_date 行不删 / meta 全表重算
//   UT-FX-DEL-3  deletedTxnNos 正确（去空去重；仅被删行交易编号）
//   UT-FX-DEL-4  🔴 联动删 BOC 同 transaction_no 行；非同 txn 行保留
//   UT-FX-DEL-5  🔴 BOC 行 maturity_date 落删除区间外但 transaction_no 命中被删行 → 仍被联动删（按 txn 删非按日期）
//   UT-FX-DEL-6  source_file_name 删后保留不变
//   UT-FX-DEL-7  🔴 事务一致性：BOC DELETE 失败（表被 drop）→ fx 主表 DELETE 整事务回滚（两表回删前态）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureLinkedTableSupport, ensureBocFxLinkSupport } = require('../../../../src/backend/database/migrations');
const repo = require('../../../../src/backend/database/linked-table-repository');

let tmpDir;
let db;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-del-range-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
  ensureLinkedTableSupport(db);  // 🔴 fx 主表（含 transaction_no UNIQUE）
  ensureBocFxLinkSupport(db);    // 🔴 BOC 派生表（含 orig_group_no + transaction_no UNIQUE）
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造真实表头键名的 fx 主表行（fx def：keyHeader=交易编号 / dateHeader=交易日期）。
//   txnNo 为纯数字串（真实交割表 9 位数字）；txnDate 传 '' → transaction_date 落库 null（范围匹配不到）。
function fxRow(txnNo, txnDate) {
  const row = {};
  if (txnNo !== undefined) row['交易编号'] = txnNo;
  if (txnDate !== undefined) row['交易日期'] = txnDate;
  return row;
}

// 构造 BOC 链接表行（upsertBocFxLink 入参形态：__txnNo 已归一纯数字串 + __maturityIso 到期日）。
//   maturityIso = BOC 表 maturity_date 落值（到期日，与删除区间无关，用于证「按 txn 删非按日期」）。
function bocRow(txnNo, maturityIso, group = '1') {
  return {
    '交易编号': txnNo,
    '到期日': maturityIso,
    '分组': group,
    '调拨单号': '',
    '资金对账不平表链接ID': '',
    __txnNo: txnNo,
    __maturityIso: maturityIso,
    __origGroup: group,
    __sourceRow: 3
  };
}

function fxTableRowCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM linked_fx_settlement').get().c;
}

function fxTxnNos() {
  return db.prepare('SELECT transaction_no FROM linked_fx_settlement ORDER BY transaction_no').all().map((r) => r.transaction_no);
}

function bocTxnNos() {
  return db.prepare('SELECT transaction_no FROM linked_boc_fx_settlement ORDER BY transaction_no').all().map((r) => r.transaction_no);
}

// 喂入 fx 主表前置数据（4 个有日期行 + 1 个 null 日期行）。
function seedFx(sourceFileName) {
  repo.upsertLinkedFx(db, [
    fxRow('100000001', '2026-01-10'),
    fxRow('100000002', '2026-02-15'),
    fxRow('100000003', '2026-03-20'),
    fxRow('100000004', '2026-04-25'),
    fxRow('100000099', '')              // 无日期 → transaction_date 落库 null（范围匹配不到）
  ], sourceFileName ? { sourceFileName } : {});
}

test.describe('linked-table-repository — 外汇交割表按日期范围统计 / 删除 + 联动删 BOC（v3.0.5 OPEN-4 T6a）', () => {
  // UT-FX-DEL-1：count 闭区间含端点、null 日期行不计入、无命中=0、全覆盖正确
  test('UT-FX-DEL-1：count 闭区间含端点 / null 行不计入 / 无命中=0 / 全覆盖正确', () => {
    seedFx();
    assert.equal(fxTableRowCount(), 5, '前置 5 行（含 1 无日期行）');

    assert.equal(repo.countFxByDateRange(db, '2026-02-15', '2026-03-20'), 2, '闭区间含两端点 → 2 行');
    assert.equal(repo.countFxByDateRange(db, '2026-01-01', '2026-12-31'), 4, '全覆盖有日期行 → 4 行，null 行不计入');
    assert.equal(repo.countFxByDateRange(db, '2026-01-10', '2026-01-10'), 1, '单日闭区间命中端点 → 1 行');
    assert.equal(repo.countFxByDateRange(db, '2026-05-01', '2026-05-31'), 0, '区间无命中 → 0 行');
  });

  // UT-FX-DEL-2：delete fx 主表——deleted/剩余/null 行保留/meta 全表重算
  test('UT-FX-DEL-2：delete fx 主表——deleted/剩余/null 行保留/meta 全表重算', () => {
    seedFx();

    // 删 [2026-02-01, 2026-03-31] → 命中 100000002(2/15)、100000003(3/20)
    const ret = repo.deleteFxByDateRange(db, '2026-02-01', '2026-03-31');
    assert.equal(ret.deleted, 2, '删除 deleted=2');
    assert.deepEqual(fxTxnNos(), ['100000001', '100000004', '100000099'], '剩余含 null 日期行 100000099');
    assert.equal(fxTableRowCount(), 3, '剩余 3 行');

    assert.equal(ret.rowCount, 3, '返回 rowCount=3（全表重算含 null 行）');
    assert.equal(ret.dataDateMin, '2026-01-10', 'dataDateMin=2026-01-10');
    assert.equal(ret.dataDateMax, '2026-04-25', 'dataDateMax=2026-04-25');

    const meta = repo.getLinkedTableMeta(db, 'fx-settlement');
    assert.equal(meta.rowCount, 3, 'meta.rowCount=3 落库一致');
    assert.equal(meta.dataDateMin, '2026-01-10', 'meta.dataDateMin 落库一致');
  });

  // UT-FX-DEL-3：deletedTxnNos 正确（删前同事务收集；仅被删行；去空去重）
  test('UT-FX-DEL-3：deletedTxnNos 正确（仅被删行 / 去空去重）', () => {
    seedFx();

    const ret = repo.deleteFxByDateRange(db, '2026-02-01', '2026-03-31');
    assert.deepEqual([...ret.deletedTxnNos].sort(), ['100000002', '100000003'], 'deletedTxnNos = 被删行交易编号');
    assert.ok(!ret.deletedTxnNos.includes('100000001'), '未删行不在 deletedTxnNos');
    assert.equal(new Set(ret.deletedTxnNos).size, ret.deletedTxnNos.length, 'deletedTxnNos 无重复');
    assert.ok(ret.deletedTxnNos.every((k) => k !== ''), 'deletedTxnNos 无空键');
  });

  // UT-FX-DEL-4：🔴 联动删 BOC 同 transaction_no 行；非同 txn 行保留
  test('UT-FX-DEL-4：联动删 BOC 同 transaction_no 行，非同 txn 行保留', () => {
    seedFx();
    // BOC 表：100000002/100000003 与被删 fx 行同 txn（应联动删）；100000001 不在删除区间（应保留）。
    repo.upsertBocFxLink(db, [
      bocRow('100000001', '2026-05-04', '1'),
      bocRow('100000002', '2026-05-04', '2'),
      bocRow('100000003', '2026-05-04', '3')
    ]);
    assert.deepEqual(bocTxnNos(), ['100000001', '100000002', '100000003'], '前置 BOC 3 行');

    const ret = repo.deleteFxByDateRange(db, '2026-02-01', '2026-03-31');
    assert.equal(ret.deleted, 2, 'fx 主表删 2 行');
    assert.equal(ret.bocDeleted, 2, '🔴 BOC 联动删 2 行（同 transaction_no 100000002/100000003）');
    assert.deepEqual(bocTxnNos(), ['100000001'], '🔴 BOC 仅剩非被删 txn 的 100000001');
  });

  // UT-FX-DEL-5：🔴🔴 BOC 行 maturity_date 落删除区间外但 transaction_no 命中被删 fx 行 → 仍被联动删（证按 txn 删非按日期）
  test('UT-FX-DEL-5：BOC maturity_date 在删除区间外但 txn 命中 → 仍被联动删（按 txn 非按日期）', () => {
    seedFx();
    // 删除区间 = [2026-02-01, 2026-03-31]；BOC 行 maturity_date 故意落在区间外（2026-09-30）。
    //   若误按 maturity_date / 日期删 BOC，则此行不会被删（在区间外）→ 断言会失败暴露 bug。
    //   正确实现按 transaction_no IN(被删 fx 行) → 100000002 命中被删 → 此 BOC 行必被联动删。
    repo.upsertBocFxLink(db, [
      bocRow('100000002', '2026-09-30', '1'),  // maturity 在删除区间外，但 txn=100000002 命中被删 fx 行
      bocRow('100000004', '2026-02-20', '2')   // maturity 在删除区间内，但 txn=100000004 未被删 fx 行（不应被删）
    ]);
    assert.deepEqual(bocTxnNos(), ['100000002', '100000004'], '前置 BOC 2 行');

    const ret = repo.deleteFxByDateRange(db, '2026-02-01', '2026-03-31');
    assert.equal(ret.bocDeleted, 1, '🔴 联动删 1 行（txn=100000002，尽管其 maturity_date=2026-09-30 在删除区间外）');
    assert.deepEqual(
      bocTxnNos(),
      ['100000004'],
      '🔴 剩 txn=100000004（其 maturity_date=2026-02-20 在删除区间内但 txn 未被删 fx → 证联动删按 txn 非按日期）'
    );
  });

  // UT-FX-DEL-6：source_file_name 删后保留不变
  test('UT-FX-DEL-6：source_file_name 删后保留不变', () => {
    seedFx('fx-original.xls');
    const metaBefore = repo.getLinkedTableMeta(db, 'fx-settlement');
    assert.equal(metaBefore.sourceFileName, 'fx-original.xls', '前置来源名');

    repo.deleteFxByDateRange(db, '2026-02-01', '2026-03-31');

    const metaAfter = repo.getLinkedTableMeta(db, 'fx-settlement');
    assert.equal(metaAfter.sourceFileName, 'fx-original.xls', '🔴 删除后来源名保持不变');
  });

  // UT-FX-DEL-7：🔴 事务一致性——BOC DELETE 失败（BOC 表被 drop）→ fx 主表 DELETE 整事务回滚
  test('UT-FX-DEL-7：BOC DELETE 失败 → fx 主表 DELETE 整事务回滚（两表回删前态）', () => {
    seedFx();
    const fxBefore = fxTxnNos();
    assert.equal(fxBefore.length, 5, '删前 fx 5 行');

    // drop BOC 表：deletedTxnNos 非空（删除区间命中 100000002/100000003）→ 执行 BOC DELETE 时 no such table 抛错。
    db.exec('DROP TABLE linked_boc_fx_settlement');

    assert.throws(
      () => repo.deleteFxByDateRange(db, '2026-02-01', '2026-03-31'),
      /no such table|linked_boc_fx_settlement/i,
      'BOC DELETE 失败应抛错'
    );

    // 🔴 fx 主表 DELETE 必须随之 ROLLBACK：5 行原样在（已删的 100000002/100000003 也回来）。
    assert.deepEqual(fxTxnNos(), fxBefore, '🔴 fx 主表整事务回滚，5 行原样在（删除未生效）');
    assert.equal(fxTableRowCount(), 5, 'fx 表行数回删前态');
  });
});
