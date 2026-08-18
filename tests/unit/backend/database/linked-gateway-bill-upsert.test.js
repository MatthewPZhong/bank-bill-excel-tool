// v3.0.1 需求1（task2）：网关对账单链接表「按 ReconBillBizId 幂等 upsert」仓储单测。
//
// 背景（🔴 资金对账红线）：
//   网关对账单批量导入改「累加不整表覆盖」——按 recon_bill_biz_id（task1 迁移建的 UNIQUE 键）
//   ON CONFLICT DO UPDATE。多次导入：同 bizId 覆盖为最新、不同 bizId 累加保留、空键拒入。
//   meta 累加后必须全表重算（rowCount/日期范围不是单批增量）；流式版中途 throw 必须整批 ROLLBACK。
//
// 范式同 migrations-linked-gateway-bill-biz-key.test.js：临时 DatabaseSync + ensureLinkedTableSupport(db)
//   建 schema（含 recon_bill_biz_id + UNIQUE），再调 upsert。
//
// 覆盖：
//   UT-UPSERT-1  幂等：同一 ReconBillBizId 连导 2 次 → 表内仅 1 行、为最新值
//   UT-UPSERT-2  累加不覆盖：先 {BIZ-A} 再 {BIZ-B} → 2 行（A 不被删，证无整表 DELETE）
//   UT-UPSERT-3  overwriteCount：{A,B} 后 {B,C} → overwriteCount=1（命中 B）、upserted=2
//   UT-UPSERT-4  空键拒入：空串/缺字段/纯空白拒入 + rejectedEmptyCount；带空格有效键 TRIM 入库
//   UT-UPSERT-5  meta 全表重算：跨 2 批不同 bill_date → rowCount/min/max = 全表跨两批
//   UT-UPSERT-6  流式版：feedRows 喂行与数组版等价（幂等 + 计数）
//   UT-UPSERT-7  ROLLBACK（🔴 R-4）：流式 feedRows 中途 throw → 整批回滚，表保持调用前状态

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-upsert-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
  ensureLinkedTableSupport(db); // 🔴 必须先建表（含 recon_bill_biz_id + UNIQUE）
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造真实表头键名的网关行对象
function gwRow(bizId, reconId, billDate, extra = {}) {
  const row = { reconciliationid: reconId, Billdate: billDate, ...extra };
  // 允许 bizId === undefined 时不写该字段（测「缺字段」分支）
  if (bizId !== undefined) row.ReconBillBizId = bizId;
  return row;
}

function tableRowCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM linked_gateway_bill').get().c;
}

function allRows() {
  return db.prepare('SELECT recon_bill_biz_id, reconciliation_id, bill_date, raw_json FROM linked_gateway_bill ORDER BY recon_bill_biz_id').all();
}

function rawOf(bizId) {
  const r = db.prepare('SELECT raw_json FROM linked_gateway_bill WHERE recon_bill_biz_id = ?').get(bizId);
  return r ? JSON.parse(r.raw_json) : null;
}

function legacyUpsert(rows, options = {}) {
  return repo.upsertLinkedGatewayBill(db, rows, { ...options, legacySource: true });
}

function legacyUpsertStreaming(feedRows, options = {}) {
  return repo.upsertLinkedGatewayBillStreaming(db, feedRows, { ...options, legacySource: true });
}

test.describe('linked-table-repository — 网关对账单幂等 upsert（v3.0.1 task2）', () => {
  // UT-UPSERT-1：同一 bizId 连导 2 次 → 仅 1 行且为最新值
  test('UT-UPSERT-1：幂等——同一 ReconBillBizId 连导 2 次仅 1 行、值更新为最新', () => {
    legacyUpsert([gwRow('BIZ-A', 'R-A1', '2026-01-01', { Amount: '100' })]);
    const r1 = legacyUpsert([gwRow('BIZ-A', 'R-A2', '2026-02-02', { Amount: '200' })]);

    assert.equal(tableRowCount(), 1, '同 bizId 连导 2 次表内仅 1 行');
    const raw = rawOf('BIZ-A');
    assert.equal(raw.reconciliationid, 'R-A2', 'raw_json 更新为最新 reconciliationid');
    assert.equal(raw.Amount, '200', 'raw_json 更新为最新 Amount');
    const dbRow = db.prepare("SELECT reconciliation_id, bill_date FROM linked_gateway_bill WHERE recon_bill_biz_id = 'BIZ-A'").get();
    assert.equal(dbRow.reconciliation_id, 'R-A2', '键列更新为最新');
    assert.equal(dbRow.bill_date, '2026-02-02', '日期列更新为最新');
    // 第二次：1 行命中已存在 → overwriteCount=1，upserted=1
    assert.equal(r1.overwriteCount, 1, '第二次命中已存在 bizId → overwriteCount=1');
    assert.equal(r1.upserted, 1, '第二次 upserted=1');
  });

  // UT-UPSERT-2：先 A 再 B → 2 行（A 不被删，证无整表 DELETE）
  test('UT-UPSERT-2：累加不覆盖——先 {BIZ-A} 再 {BIZ-B} → 2 行，A 仍在', () => {
    legacyUpsert([gwRow('BIZ-A', 'R-A', '2026-01-01')]);
    legacyUpsert([gwRow('BIZ-B', 'R-B', '2026-01-02')]);

    assert.equal(tableRowCount(), 2, '第二批不删第一批 → 2 行（证无整表 DELETE）');
    assert.deepEqual(allRows().map((r) => r.recon_bill_biz_id), ['BIZ-A', 'BIZ-B'], 'A、B 都在');
  });

  // UT-UPSERT-3：{A,B} 后 {B,C} → overwriteCount=1、upserted=2
  test('UT-UPSERT-3：overwriteCount——{A,B} 后 {B,C} 命中 B → overwriteCount=1、upserted=2', () => {
    const first = legacyUpsert([
      gwRow('BIZ-A', 'R-A', '2026-01-01'),
      gwRow('BIZ-B', 'R-B', '2026-01-02')
    ]);
    assert.equal(first.overwriteCount, 0, '首批全新 → overwriteCount=0');
    assert.equal(first.upserted, 2, '首批 upserted=2');

    const second = legacyUpsert([
      gwRow('BIZ-B', 'R-B2', '2026-01-03'),
      gwRow('BIZ-C', 'R-C', '2026-01-04')
    ]);
    assert.equal(second.overwriteCount, 1, '第二批命中已存在 BIZ-B → overwriteCount=1');
    assert.equal(second.upserted, 2, '第二批 upserted=2（B 覆盖 + C 新增）');
    assert.equal(tableRowCount(), 3, '累加后表内 A、B、C 共 3 行');
  });

  // UT-UPSERT-4：空键拒入 + 带空格有效键 TRIM 入库
  test('UT-UPSERT-4：空键拒入（空串/缺字段/纯空白）；带空格有效键 TRIM 入库', () => {
    const res = legacyUpsert([
      gwRow('', 'R-empty', '2026-01-01'),          // 空串 → 拒
      gwRow(undefined, 'R-missing', '2026-01-02'),  // 缺字段 → 拒
      gwRow('   ', 'R-blank', '2026-01-03'),        // 纯空白 → 拒
      gwRow('  BIZ-X  ', 'R-X', '2026-01-04')       // 带前后空格有效键 → 入库且 TRIM
    ]);

    assert.equal(res.rejectedEmptyCount, 3, '空串/缺字段/纯空白 共 3 行拒入');
    assert.equal(res.upserted, 1, '仅 1 行有效键入库');
    assert.equal(tableRowCount(), 1, '表内仅 1 行');
    assert.deepEqual(allRows().map((r) => r.recon_bill_biz_id), ['BIZ-X'], '键被 TRIM 成 BIZ-X（口径与 migration 一致）');
    // 空键行未入库
    assert.equal(rawOf('BIZ-X').reconciliationid, 'R-X', '有效键行落库正确');
  });

  // UT-UPSERT-5：meta 全表重算（跨 2 批不同 bill_date）
  test('UT-UPSERT-5：meta 全表重算——rowCount/dataDateMin/Max 跨两批为全表口径', () => {
    legacyUpsert([
      gwRow('BIZ-A', 'R-A', '2026-03-15'),
      gwRow('BIZ-B', 'R-B', '2026-03-20')
    ], { sourceFileName: 'gw-batch1.xlsx' });

    const r2 = legacyUpsert([
      gwRow('BIZ-C', 'R-C', '2026-01-05'), // 更早 → 拉低 min
      gwRow('BIZ-D', 'R-D', '2026-05-30')  // 更晚 → 拉高 max
    ], { sourceFileName: 'gw-batch2.xlsx' });

    // 返回值 meta = 全表口径（非单批增量）
    assert.equal(r2.rowCount, 4, '返回 rowCount = 全表 4 行（非单批 2 行）');
    assert.equal(r2.dataDateMin, '2026-01-05', 'dataDateMin = 全表跨两批最早');
    assert.equal(r2.dataDateMax, '2026-05-30', 'dataDateMax = 全表跨两批最晚');

    // linked_table_meta 落库口径一致
    const meta = repo.getLinkedTableMeta(db, 'gateway-bill');
    assert.equal(meta.rowCount, 4, 'meta.rowCount 全表 4 行');
    assert.equal(meta.dataDateMin, '2026-01-05', 'meta.dataDateMin 全表最早');
    assert.equal(meta.dataDateMax, '2026-05-30', 'meta.dataDateMax 全表最晚');
    assert.equal(meta.sourceFileName, 'gw-batch2.xlsx', 'sourceFileName = 最近一批');
  });

  // UT-UPSERT-6：流式版与数组版等价（幂等 + 计数）
  test('UT-UPSERT-6：流式版——feedRows 喂行与数组版等价（幂等 + 计数）', async () => {
    const rows = [
      gwRow('BIZ-A', 'R-A1', '2026-01-01'),
      gwRow('BIZ-B', 'R-B', '2026-01-02')
    ];
    const first = await legacyUpsertStreaming(async (upsertOne) => {
      rows.forEach(upsertOne);
    });
    assert.equal(first.upserted, 2, '流式首批 upserted=2');
    assert.equal(first.overwriteCount, 0, '流式首批 overwriteCount=0');
    assert.equal(tableRowCount(), 2, '流式首批 2 行入库');

    // 再流式喂同 bizId（幂等覆盖）+ 1 新 + 1 空键
    const second = await legacyUpsertStreaming(async (upsertOne) => {
      [
        gwRow('BIZ-A', 'R-A2', '2026-02-02'), // 覆盖
        gwRow('BIZ-C', 'R-C', '2026-01-03'),  // 新增
        gwRow('', 'R-empty', '2026-01-04')    // 空键拒入
      ].forEach(upsertOne);
    });
    assert.equal(second.overwriteCount, 1, '流式第二批命中 BIZ-A → overwriteCount=1');
    assert.equal(second.upserted, 2, '流式第二批 upserted=2（A 覆盖 + C 新增）');
    assert.equal(second.rejectedEmptyCount, 1, '流式第二批空键拒入 1');
    assert.equal(tableRowCount(), 3, '累加后 A、B、C 共 3 行');
    assert.equal(rawOf('BIZ-A').reconciliationid, 'R-A2', '流式 BIZ-A 覆盖为最新值');

    // feedRows 非函数 → 守卫抛错
    await assert.rejects(
      () => legacyUpsertStreaming(null),
      /feedRows/,
      '流式版 feedRows 非函数 → 守卫抛错'
    );
  });

  // UT-UPSERT-7：🔴 R-4 流式中途 throw → 整批 ROLLBACK，表保持调用前状态
  test('UT-UPSERT-7：ROLLBACK（R-4）——流式 feedRows 中途 throw → 整批回滚，表不变', async () => {
    // 先成功 upsert 2 行
    legacyUpsert([
      gwRow('BIZ-A', 'R-A', '2026-01-01'),
      gwRow('BIZ-B', 'R-B', '2026-01-02')
    ]);
    const before = allRows();
    assert.equal(before.length, 2, '前置 2 行');
    const metaBefore = repo.getLinkedTableMeta(db, 'gateway-bill');

    // 流式：喂 1 行成功后 throw → 整批回滚（那 1 行不入、A/B 不变）
    await assert.rejects(
      () => legacyUpsertStreaming(async (upsertOne) => {
        upsertOne(gwRow('BIZ-C', 'R-C', '2026-01-03')); // 这行不应最终入库
        throw new Error('boom: 模拟流式中途失败');
      }),
      /boom/,
      '流式中途 throw 向上抛'
    );

    const after = allRows();
    assert.equal(after.length, 2, '🔴 回滚后仍是 2 行（BIZ-C 未入）');
    assert.deepEqual(after.map((r) => r.recon_bill_biz_id), ['BIZ-A', 'BIZ-B'], '🔴 表保持 A、B 不变');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM linked_gateway_bill WHERE recon_bill_biz_id = 'BIZ-C'").get().c, 0, 'BIZ-C 未入库');

    // meta 也未被改写（recomputeGatewayMeta 在 COMMIT 前，随事务回滚）
    const metaAfter = repo.getLinkedTableMeta(db, 'gateway-bill');
    assert.equal(metaAfter.rowCount, metaBefore.rowCount, 'meta.rowCount 未变');
    assert.equal(metaAfter.dataDateMin, metaBefore.dataDateMin, 'meta.dataDateMin 未变');
    assert.equal(metaAfter.dataDateMax, metaBefore.dataDateMax, 'meta.dataDateMax 未变');

    // 表仍可继续正常 upsert（事务已干净回滚，无残留 BEGIN）
    assert.doesNotThrow(() => legacyUpsert([gwRow('BIZ-D', 'R-D', '2026-01-04')]), '回滚后可继续 upsert');
    assert.equal(tableRowCount(), 3, '回滚后续 upsert 正常 → A、B、D 共 3 行');
  });

  test('v1 同一文件重复幂等键时每次物理 upsert 换 nonce，最终来源身份不降级', () => {
    repo.upsertLinkedGatewayBill(db, [
      gwRow('BIZ-DUP', 'R-OLD', '2026-07-01'),
      gwRow('BIZ-DUP', 'R-NEW', '2026-07-02')
    ], {
      sourceIdentity: {
        datasetId: 'gateway-dataset-v1',
        producerTaskRunId: 'gateway-task-v1',
        sourceContractVersion: 1
      }
    });

    const row = db.prepare(`
      SELECT reconciliation_id, source_dataset_id, source_task_run_id,
             source_contract_version, source_write_nonce
      FROM linked_gateway_bill
      WHERE recon_bill_biz_id = 'BIZ-DUP'
    `).get();
    assert.equal(row.reconciliation_id, 'R-NEW');
    assert.equal(row.source_dataset_id, 'gateway-dataset-v1');
    assert.equal(row.source_task_run_id, 'gateway-task-v1');
    assert.equal(row.source_contract_version, 1);
    assert.match(row.source_write_nonce, /^[0-9a-f-]{36}$/);
  });

  test('旧 binary 未换 nonce 的业务列 UPDATE 仅将命中行来源降为 v0', () => {
    const sourceIdentity = {
      datasetId: 'gateway-dataset-v1',
      producerTaskRunId: 'gateway-task-v1',
      sourceContractVersion: 1
    };
    repo.upsertLinkedGatewayBill(db, [
      gwRow('BIZ-OLD', 'R-OLD', '2026-07-01'),
      gwRow('BIZ-KEEP', 'R-KEEP', '2026-07-01')
    ], { sourceIdentity });

    db.prepare(`
      UPDATE linked_gateway_bill
      SET reconciliation_id = ?, raw_json = ?, imported_at = ?
      WHERE recon_bill_biz_id = ?
    `).run('R-OLD-BINARY', JSON.stringify(gwRow('BIZ-OLD', 'R-OLD-BINARY', '2026-07-02')), '2026-07-02T00:00:00.000Z', 'BIZ-OLD');

    const rows = db.prepare(`
      SELECT recon_bill_biz_id, source_dataset_id, source_task_run_id, source_contract_version
      FROM linked_gateway_bill
      ORDER BY recon_bill_biz_id
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      {
        recon_bill_biz_id: 'BIZ-KEEP',
        source_dataset_id: 'gateway-dataset-v1',
        source_task_run_id: 'gateway-task-v1',
        source_contract_version: 1
      },
      {
        recon_bill_biz_id: 'BIZ-OLD',
        source_dataset_id: null,
        source_task_run_id: null,
        source_contract_version: 0
      }
    ]);
  });
});
