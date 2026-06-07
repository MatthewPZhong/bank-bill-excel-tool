// v2.1.16 fix — 链接表「中台调拨订单」数据日期范围基于「交易时间」（用户确认 / self-review 诊断）
//
// 背景：旧实现 dateHeader='业务日期'(idx 18)，而真实文件业务日期空值率高（导致交易时间最早的行漏出日期范围）。
//   用户确认应基于「交易时间」(idx 4，每行均有值)。本测试锁定修复 + 防回归（不再回落业务日期）。
//   DB 列名已对齐为 transaction_date（链接表 v2.1.16 新建无存量，建表即用该列名；raw_json 为真相，date 列仅供 min/max 范围与索引）。

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-repo-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 中台调拨行（按 Excel 表头名建 key）：交易时间 idx 4 / 业务日期 idx 18
function midRow(allocationNo, txnTime, bizDate) {
  return { '调拨单号': allocationNo, '交易时间': txnTime, '业务日期': bizDate };
}

test.describe('linked-table-repository — 中台调拨日期范围基于交易时间（v2.1.16 fix）', () => {
  test('LINKED_TABLE_DEFS：mid-allocation 取值列 dateHeader = 交易时间', () => {
    assert.equal(linkedRepo.LINKED_TABLE_DEFS['mid-allocation'].dateHeader, '交易时间');
  });

  test('交易时间有值 + 业务日期空 → 日期范围基于交易时间（修复核心：用户的 260506/2026-05-06 行）', () => {
    const rows = [
      midRow('A1', '2026-06-06', '2026-06-05'),
      midRow('A2', '2026-06-05', ''), // 业务日期空、交易时间 6-05
      midRow('A3', '2026-05-06', '')  // 业务日期空、交易时间 5-06（用户报「没识别到」的行）
    ];
    linkedRepo.replaceLinkedTable(db, 'mid-allocation', rows, { sourceFileName: 'test.xlsx' });
    const meta = linkedRepo.getLinkedTableMeta(db, 'mid-allocation');
    assert.equal(meta.dataDateMin, '2026-05-06', 'min=交易时间最早 2026-05-06（业务日期空也不漏该行）');
    assert.equal(meta.dataDateMax, '2026-06-06');
    assert.equal(meta.rowCount, 3, '3 行全部入库（含业务日期空的行）');
  });

  test('全部业务日期空但交易时间有值 → 范围非空（修复前 bug：旧逻辑会得 null/偏窄）', () => {
    linkedRepo.replaceLinkedTable(db, 'mid-allocation', [
      midRow('B1', '2026-05-06', ''),
      midRow('B2', '2026-06-06', '')
    ], {});
    const meta = linkedRepo.getLinkedTableMeta(db, 'mid-allocation');
    assert.equal(meta.dataDateMin, '2026-05-06');
    assert.equal(meta.dataDateMax, '2026-06-06');
  });

  test('交易时间空的行 → 跳过不参与范围（仍入库；且不再回落业务日期）', () => {
    // C2 交易时间空、业务日期 2026-01-01：若仍用业务日期，min 会是 2026-01-01；
    //   改用交易时间后 C2 跳过 → min=2026-06-06（直接证明日期列已从业务日期切到交易时间）
    linkedRepo.replaceLinkedTable(db, 'mid-allocation', [
      midRow('C1', '2026-06-06', '2026-06-05'),
      midRow('C2', '', '2026-01-01')
    ], {});
    const meta = linkedRepo.getLinkedTableMeta(db, 'mid-allocation');
    assert.equal(meta.dataDateMin, '2026-06-06', '仅 C1 参与；C2 交易时间空跳过，不回落业务日期 2026-01-01');
    assert.equal(meta.dataDateMax, '2026-06-06');
    assert.equal(meta.rowCount, 2);
  });
});
