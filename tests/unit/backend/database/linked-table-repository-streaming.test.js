// v3.0.0 块 B / PR-2：replaceLinkedTableStreaming 流式整表覆盖回归测试。
//
// 背景：65 万行大文件链接表落库改为「边解压边逐行喂入仓储事务」（内存恒定）。流式路径与数组路径
//   replaceLinkedTable 共用 createInsertContext / upsertLinkedTableMeta，必须保证：
//     · 🔴 值口径 + meta 计算与数组路径字节一致（防大文件流式落库静默口径漂移 = 资金/数据事故）；
//     · 🔴 整表覆盖原子性：feedRows 中途任意 throw → 单事务整体 ROLLBACK，旧数据完好（表不留半空）；
//     · 空 feed 仍执行整表覆盖语义（DELETE 全表 + rowCount=0 + upsert meta）。
//   （真实 65.7 万行大文件端到端 COUNT=657,757 + 跨 await 事务 + 内存有界已另行实测；本测试锁定语义防回归。）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-stream-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 中台调拨行（keyHeader=调拨单号 / dateHeader=交易时间）
function midRow(no, txnTime) {
  return { '调拨单号': no, '交易时间': txnTime };
}
// feedRows 工厂：把一组行对象逐个 insertOne（模拟流式逐行喂入）
function feederOf(rows) {
  return async (insertOne) => { for (const r of rows) insertOne(r); };
}

test.describe('replaceLinkedTableStreaming — 流式整表覆盖（v3.0.0 块B/PR-2）', () => {
  test('流式落库：rowCount + 日期范围 + 实际写入行数', async () => {
    const rows = [midRow('A1', '2026-05-06'), midRow('A2', '2026-06-06'), midRow('A3', '2026-05-20')];
    const ret = await linkedRepo.replaceLinkedTableStreaming(db, 'mid-allocation', feederOf(rows), { sourceFileName: 's.xlsx' });
    assert.equal(ret.rowCount, 3);
    assert.equal(ret.dataDateMin, '2026-05-06');
    assert.equal(ret.dataDateMax, '2026-06-06');
    const meta = linkedRepo.getLinkedTableMeta(db, 'mid-allocation');
    assert.equal(meta.rowCount, 3);
    assert.equal(meta.sourceFileName, 's.xlsx');
    assert.equal(linkedRepo.readLinkedTableRows(db, 'mid-allocation').length, 3);
  });

  test('🔴 值口径 parity：同行经 流式 vs 数组路径 → raw_json 还原对象 + meta 字节一致', async () => {
    const rows = [midRow('K1', '2026-05-06'), midRow('K2', '2026-06-06'), midRow('K3', '')];
    // 数组路径
    linkedRepo.replaceLinkedTable(db, 'mid-allocation', rows, { sourceFileName: 'p.xlsx' });
    const arrRows = linkedRepo.readLinkedTableRows(db, 'mid-allocation');
    const arrMeta = linkedRepo.getLinkedTableMeta(db, 'mid-allocation');
    // 流式路径（覆盖同表，同一批行）
    const ret = await linkedRepo.replaceLinkedTableStreaming(db, 'mid-allocation', feederOf(rows), { sourceFileName: 'p.xlsx' });
    const strRows = linkedRepo.readLinkedTableRows(db, 'mid-allocation');
    assert.deepEqual(strRows, arrRows, '两路 raw_json 还原对象逐行一致');
    assert.equal(ret.rowCount, arrMeta.rowCount);
    assert.equal(ret.dataDateMin, arrMeta.dataDateMin);
    assert.equal(ret.dataDateMax, arrMeta.dataDateMax);
  });

  test('🔴 整表覆盖原子性：feedRows 中途抛错 → ROLLBACK，旧数据完好（DELETE 也回滚，表未清空）', async () => {
    // 预置旧数据
    linkedRepo.replaceLinkedTable(db, 'mid-allocation', [midRow('OLD1', '2026-05-06'), midRow('OLD2', '2026-05-07')], {});
    assert.equal(linkedRepo.readLinkedTableRows(db, 'mid-allocation').length, 2);
    // 流式覆盖：喂一行后抛错
    await assert.rejects(async () => {
      await linkedRepo.replaceLinkedTableStreaming(db, 'mid-allocation', async (insertOne) => {
        insertOne(midRow('NEW1', '2026-06-01'));
        throw new Error('模拟流式落库中途失败');
      }, {});
    });
    const after = linkedRepo.readLinkedTableRows(db, 'mid-allocation');
    assert.equal(after.length, 2, 'DELETE 也被回滚，旧 2 行完好（未被清空也未混入 NEW1）');
    assert.equal(after[0]['调拨单号'], 'OLD1');
    assert.equal(after[1]['调拨单号'], 'OLD2');
  });

  test('空 feed → 整表覆盖语义：清空旧数据 + rowCount=0 + 仍 upsert meta', async () => {
    linkedRepo.replaceLinkedTable(db, 'mid-allocation', [midRow('Z1', '2026-05-06')], {});
    const ret = await linkedRepo.replaceLinkedTableStreaming(db, 'mid-allocation', async () => { /* 不喂任何行 */ }, { sourceFileName: 'empty.xlsx' });
    assert.equal(ret.rowCount, 0);
    assert.equal(linkedRepo.readLinkedTableRows(db, 'mid-allocation').length, 0, '旧数据被整表覆盖清空');
    const meta = linkedRepo.getLinkedTableMeta(db, 'mid-allocation');
    assert.equal(meta.rowCount, 0);
    assert.equal(meta.sourceFileName, 'empty.xlsx');
  });

  test('feedRows 非函数 → 抛错（且不破坏旧数据）', async () => {
    linkedRepo.replaceLinkedTable(db, 'mid-allocation', [midRow('G1', '2026-05-06')], {});
    await assert.rejects(() => linkedRepo.replaceLinkedTableStreaming(db, 'mid-allocation', null, {}));
    assert.equal(linkedRepo.readLinkedTableRows(db, 'mid-allocation').length, 1, '校验在 BEGIN 前，旧数据不动');
  });
});
