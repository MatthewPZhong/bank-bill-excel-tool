// v3.0.0 块 B / PR-3（R-3/O-3）：ADM 派生内存优化回归测试。
//
// 现状 readLinkedTableRows('bank-deposit') 为 ADM 派生把整表（实测 65.7 万行 → ~1.2GB RSS 尖峰）
//   全量读回内存，仅为筛出极小的 Channel=ADM 子集。新增 readBankDepositAdmCandidates 把 Channel='ADM'
//   过滤下推到 SQL（json_extract），只物化候选子集；hasLinkedTableRows 用 EXISTS 轻量探测存在性。
//
// 🔴 资金红线不变量：SQL 仅过滤 Channel='ADM'（buildAdmRows 完整 Channel∧FundType 条件的**超集**），
//   buildAdmRows 内部过滤仍为最终权威。本测试锁定：
//     · readBankDepositAdmCandidates 只返回 Channel=ADM 行（含 FundType 非白名单的，由 buildAdmRows 再筛）；
//     · 🔴 parity：buildAdmRows(预过滤候选) 与 buildAdmRows(全量读) 的 admRows/unmatched 完全一致（不漏不多）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');
const { buildAdmRows } = require('../../../../src/main-process/adm-bank-deposit-builder');
const { CHANNEL_VALUE, ADM_FUND_TYPES } = require('../../../../src/constants/adm-bank-deposit-fields');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-adm-cand-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// bank-deposit 行（keyHeader=ReconciliationId / dateHeader=BillDate）；含 ADM 派生用到的字段
function bankRow(reconId, channel, fundType, ref, cono) {
  return {
    ReconciliationId: reconId,
    BillDate: '2026-05-06',
    Channel: channel,
    FundType: fundType,
    CustomerRef: ref || '',
    ChannelOrderNo: cono || ''
  };
}

test.describe('readBankDepositAdmCandidates / hasLinkedTableRows（v3.0.0 块B/PR-3）', () => {
  test('readBankDepositAdmCandidates 只返回 Channel=ADM 子集（JPM 等其它渠道排除）', () => {
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [
      bankRow('R1', CHANNEL_VALUE, ADM_FUND_TYPES[0]),
      bankRow('R2', 'JPM', ADM_FUND_TYPES[0]),
      bankRow('R3', CHANNEL_VALUE, 'Fundtransfer-in') // Channel=ADM 但 FundType 非白名单 → SQL 仍返回（超集）
    ], {});
    const cands = linkedRepo.readBankDepositAdmCandidates(db);
    assert.equal(cands.length, 2, '仅 Channel=ADM 的 R1+R3（JPM 的 R2 被 SQL 排除）');
    assert.deepEqual(cands.map((r) => r.ReconciliationId).sort(), ['R1', 'R3']);
  });

  test('🔴 parity：SQL 预过滤 + buildAdmRows == 全量读 + buildAdmRows（admRows/unmatched 逐行一致）', () => {
    const rows = [
      bankRow('A1', CHANNEL_VALUE, ADM_FUND_TYPES[0], 'REF1', 'CO1'),
      bankRow('A2', CHANNEL_VALUE, 'Fundtransfer-in', 'REF2', 'CO2'), // Channel=ADM、FundType 非法 → 两路都排除
      bankRow('A3', 'JPM', ADM_FUND_TYPES[0], 'REF3', 'CO3'),         // 非 ADM → 两路都排除
      bankRow('A4', CHANNEL_VALUE, ADM_FUND_TYPES[1], 'REF4', 'CO4')
    ];
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', rows, {});
    const mid = [];

    const full = buildAdmRows(linkedRepo.readLinkedTableRows(db, 'bank-deposit'), mid);
    const pref = buildAdmRows(linkedRepo.readBankDepositAdmCandidates(db), mid);

    assert.equal(full.admRows.length, 2, '只有 A1+A4（Channel=ADM ∧ FundType 白名单）');
    assert.deepEqual(pref.admRows, full.admRows, 'admRows 逐行（含批次号等派生字段）一致');
    const simplify = (u) => u.map((x) => ({ code: x.code, ref: x.row.ReconciliationId }));
    assert.deepEqual(simplify(pref.unmatched), simplify(full.unmatched), 'unmatched 明细一致');
  });

  test('parity（无 ADM 行）：均为空，两路一致', () => {
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [
      bankRow('J1', 'JPM', ADM_FUND_TYPES[0]),
      bankRow('J2', 'PingPong', ADM_FUND_TYPES[1])
    ], {});
    const full = buildAdmRows(linkedRepo.readLinkedTableRows(db, 'bank-deposit'), []);
    const pref = buildAdmRows(linkedRepo.readBankDepositAdmCandidates(db), []);
    assert.equal(pref.admRows.length, 0);
    assert.deepEqual(pref.admRows, full.admRows);
  });

  test('hasLinkedTableRows：空表 false，有数据 true', () => {
    assert.equal(linkedRepo.hasLinkedTableRows(db, 'bank-deposit'), false);
    linkedRepo.replaceLinkedTable(db, 'bank-deposit', [bankRow('H1', CHANNEL_VALUE, ADM_FUND_TYPES[0])], {});
    assert.equal(linkedRepo.hasLinkedTableRows(db, 'bank-deposit'), true);
  });
});
