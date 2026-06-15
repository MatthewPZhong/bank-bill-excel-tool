// v3.0.5 需求2：外汇交割表链接表「按交易编号幂等 upsert」仓储单测（仅数组版，fx 永不流式）。
//
// 背景（🔴 资金对账红线）：
//   外汇交割表批量导入改「累加不整表覆盖」——按 transaction_no（T1 迁移建的 UNIQUE 键）
//   ON CONFLICT DO UPDATE。多次导入：同交易编号覆盖为最新、不同交易编号累加保留、空键拒入。
//   幂等键口径：txnNo = normalizeKey(normalizeTransactionNo(obj['交易编号']))（单一真相 = engine-utils，
//     与 migration JS 层回填 / builder 派生分组同口径）。归一为空（合计/页脚/非数字行）→ 空键拒入 + 计数。
//   meta 累加后必须全表重算（rowCount/日期范围不是单批增量）。
//
// 范式同 linked-bank-deposit-upsert.test.js：临时 DatabaseSync + ensureLinkedTableSupport(db)
//   建 schema（含 transaction_no + UNIQUE），再调 upsert。
//
// 覆盖：
//   UT-FX-UPSERT-1  幂等：同一交易编号连导 2 次 → 表内仅 1 行、为最新值
//   UT-FX-UPSERT-2  累加不覆盖：先 {A} 再 {B} → 2 行（A 不被删，证无整表 DELETE）
//   UT-FX-UPSERT-3  overwriteCount：{A,B} 后 {B,C} → overwriteCount=1（命中 B）、upserted=2
//   UT-FX-UPSERT-4  空键拒入（合计行 "生成日期:..." / 缺字段 / 非零小数 / 纯空白）+ rejectedEmptyCount
//   UT-FX-UPSERT-5  meta 全表重算：跨 2 批不同 transaction_date → rowCount/日期范围 = 全表跨两批
//   UT-FX-UPSERT-6  number 类型交易编号正确 String 化为键（926181062 number → 入库 transaction_no='926181062'）
//   UT-FX-UPSERT-7  带尾零小数交易编号归一后与纯数字同键覆盖（'926181062.0' 与 926181062 视为同键）

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-upsert-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
  ensureLinkedTableSupport(db); // 🔴 必须先建表（含 transaction_no + UNIQUE）
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造真实表头键名的交割表行对象（fx def：keyHeader=交易编号 / dateHeader=交易日期）。
//   txnNo 可为 number（真实交割表 9 位纯数字 number 类型）或 String。
function fxRow(txnNo, txnDate, extra = {}) {
  const row = { '交易日期': txnDate, ...extra };
  if (txnNo !== undefined) row['交易编号'] = txnNo;
  return row;
}

function tableRowCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM linked_fx_settlement').get().c;
}

function allTxnNos() {
  return db.prepare('SELECT transaction_no FROM linked_fx_settlement ORDER BY transaction_no').all().map((r) => r.transaction_no);
}

function rawOf(txnNo) {
  const r = db.prepare('SELECT raw_json FROM linked_fx_settlement WHERE transaction_no = ?').get(String(txnNo));
  return r ? JSON.parse(r.raw_json) : null;
}

test.describe('linked-table-repository — 外汇交割表幂等 upsert（v3.0.5 需求2）', () => {
  // UT-FX-UPSERT-1：同一交易编号连导 2 次 → 仅 1 行且为最新值
  test('UT-FX-UPSERT-1：幂等——同一交易编号连导 2 次仅 1 行、值更新为最新', () => {
    repo.upsertLinkedFx(db, [fxRow('926181062', '2026-05-13', { '货币2金额': '100' })]);
    const r1 = repo.upsertLinkedFx(db, [fxRow('926181062', '2026-05-14', { '货币2金额': '200' })]);

    assert.equal(tableRowCount(), 1, '同交易编号连导 2 次表内仅 1 行');
    const raw = rawOf('926181062');
    assert.equal(raw['货币2金额'], '200', 'raw_json 更新为最新货币2金额');
    const dbRow = db.prepare("SELECT transaction_date FROM linked_fx_settlement WHERE transaction_no = '926181062'").get();
    assert.equal(dbRow.transaction_date, '2026-05-14', '日期列更新为最新');
    assert.equal(r1.overwriteCount, 1, '第二次命中已存在交易编号 → overwriteCount=1');
    assert.equal(r1.upserted, 1, '第二次 upserted=1');
  });

  // UT-FX-UPSERT-2：先 A 再 B → 2 行（A 不被删，证无整表 DELETE）
  test('UT-FX-UPSERT-2：累加不覆盖——先 {A} 再 {B} → 2 行，A 仍在', () => {
    repo.upsertLinkedFx(db, [fxRow('111111111', '2026-05-13')]);
    repo.upsertLinkedFx(db, [fxRow('222222222', '2026-05-14')]);

    assert.equal(tableRowCount(), 2, '第二批不删第一批 → 2 行（证无整表 DELETE）');
    assert.deepEqual(allTxnNos(), ['111111111', '222222222'], 'A、B 都在');
  });

  // UT-FX-UPSERT-3：{A,B} 后 {B,C} → overwriteCount=1、upserted=2
  test('UT-FX-UPSERT-3：overwriteCount——{A,B} 后 {B,C} 命中 B → overwriteCount=1、upserted=2', () => {
    const first = repo.upsertLinkedFx(db, [
      fxRow('111111111', '2026-05-13'),
      fxRow('222222222', '2026-05-14')
    ]);
    assert.equal(first.overwriteCount, 0, '首批全新 → overwriteCount=0');
    assert.equal(first.upserted, 2, '首批 upserted=2');

    const second = repo.upsertLinkedFx(db, [
      fxRow('222222222', '2026-05-15'),
      fxRow('333333333', '2026-05-16')
    ]);
    assert.equal(second.overwriteCount, 1, '第二批命中已存在 222222222 → overwriteCount=1');
    assert.equal(second.upserted, 2, '第二批 upserted=2（B 覆盖 + C 新增）');
    assert.equal(tableRowCount(), 3, '累加后表内 A、B、C 共 3 行');
  });

  // UT-FX-UPSERT-4：空键拒入（合计行/缺字段/非零小数/纯空白）+ rejectedEmptyCount
  //   🔴 fx 主表无「调拨单号」列 → 空键判据用「交易编号归一为空」（合计行交易编号列为 "生成日期:..." 文本，归一为空）。
  test('UT-FX-UPSERT-4：空键拒入（合计行/缺字段/非零小数/纯空白）；有效键入库', () => {
    const res = repo.upsertLinkedFx(db, [
      fxRow('生成日期:20260513', ''),          // 合计/页脚行（非数字文本）→ 归一为空 → 拒
      fxRow(undefined, '2026-05-13'),           // 缺字段 → 归一为空 → 拒
      fxRow('123.5', '2026-05-13'),             // 非零小数 → 归一为空 → 拒
      fxRow('   ', '2026-05-13'),               // 纯空白 → 归一为空 → 拒
      fxRow('926181062', '2026-05-13')          // 有效纯数字 → 入库
    ]);

    assert.equal(res.rejectedEmptyCount, 4, '合计行/缺字段/非零小数/纯空白 共 4 行拒入');
    assert.equal(res.upserted, 1, '仅 1 行有效键入库');
    assert.equal(tableRowCount(), 1, '表内仅 1 行');
    assert.deepEqual(allTxnNos(), ['926181062'], '仅有效交易编号入库');
  });

  // UT-FX-UPSERT-5：meta 全表重算（跨 2 批不同 transaction_date）
  test('UT-FX-UPSERT-5：meta 全表重算——rowCount/dataDateMin/Max 跨两批为全表口径', () => {
    repo.upsertLinkedFx(db, [
      fxRow('111111111', '2026-05-15'),
      fxRow('222222222', '2026-05-20')
    ], { sourceFileName: 'fx-batch1.xls' });

    const r2 = repo.upsertLinkedFx(db, [
      fxRow('333333333', '2026-05-05'), // 更早 → 拉低 min
      fxRow('444444444', '2026-05-30')  // 更晚 → 拉高 max
    ], { sourceFileName: 'fx-batch2.xls' });

    assert.equal(r2.rowCount, 4, '返回 rowCount = 全表 4 行（非单批 2 行）');
    assert.equal(r2.dataDateMin, '2026-05-05', 'dataDateMin = 全表跨两批最早');
    assert.equal(r2.dataDateMax, '2026-05-30', 'dataDateMax = 全表跨两批最晚');

    const meta = repo.getLinkedTableMeta(db, 'fx-settlement');
    assert.equal(meta.rowCount, 4, 'meta.rowCount 全表 4 行');
    assert.equal(meta.dataDateMin, '2026-05-05', 'meta.dataDateMin 全表最早');
    assert.equal(meta.dataDateMax, '2026-05-30', 'meta.dataDateMax 全表最晚');
    assert.equal(meta.sourceFileName, 'fx-batch2.xls', 'sourceFileName = 最近一批');
  });

  // UT-FX-UPSERT-6：number 类型交易编号正确 String 化为键（真实交割表 9 位纯数字 number 类型）
  test('UT-FX-UPSERT-6：number 类型交易编号正确 String 化为 transaction_no 键', () => {
    const res = repo.upsertLinkedFx(db, [fxRow(926181062, '2026-05-13', { '货币2金额': 50 })]);
    assert.equal(res.upserted, 1, 'number 交易编号有效入库');
    assert.equal(res.rejectedEmptyCount, 0, 'number 交易编号非空键');
    assert.deepEqual(allTxnNos(), ['926181062'], '🔴 number 926181062 String 化为 transaction_no=926181062');
    // raw_json 保留原始 number（JSON 序列化为数字）
    assert.equal(rawOf('926181062')['交易编号'], 926181062, 'raw_json 保留原始 number 交易编号');
  });

  // UT-FX-UPSERT-7：带尾零小数交易编号归一后与纯数字同键（'926181062.0' ≡ 926181062）
  test('UT-FX-UPSERT-7：带尾零小数与纯数字归一同键 → 覆盖（不新增第二行）', () => {
    repo.upsertLinkedFx(db, [fxRow(926181062, '2026-05-13', { v: 'first' })]);
    const r2 = repo.upsertLinkedFx(db, [fxRow('926181062.0', '2026-05-14', { v: 'second' })]);

    assert.equal(tableRowCount(), 1, '🔴 尾零小数归一后与 number 同键 → 仅 1 行（覆盖非追加）');
    assert.equal(r2.overwriteCount, 1, '命中同归一键 → overwriteCount=1');
    assert.equal(rawOf('926181062').v, 'second', '覆盖为最新值');
  });
});
