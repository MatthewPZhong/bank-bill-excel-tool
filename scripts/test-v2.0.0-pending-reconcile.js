#!/usr/bin/env node
/* eslint-disable no-console */
// 对账 engine 端到端 — 资金敏感红线（必跑）
// 手工构造 4 行 × 4 行小样本，预期 new=2 / missing=2 / changed=1

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PENDING_COLUMNS = require('../src/backend/pending-db/columns');
const { openPendingDb } = require('../src/backend/pending-db');
const monthRepo = require('../src/backend/pending-db/month-repository');
const diffRepo = require('../src/backend/pending-db/diff-repository');
const engine = require('../src/backend/pending-reconcile/engine');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-reconcile-test-'));

function sampleRow({ orderNo, amount, currency, fundType = '提现' }) {
  const row = new Array(PENDING_COLUMNS.length).fill('');
  row[PENDING_COLUMNS.indexOf('order_no')] = orderNo;
  row[PENDING_COLUMNS.indexOf('金额')] = amount;
  row[PENDING_COLUMNS.indexOf('币种')] = currency;
  row[PENDING_COLUMNS.indexOf('pending资金类型')] = fundType;
  return row;
}

function insertRows(db, yearMonth, rows) {
  const insertRow = monthRepo.createRowInserter(db);
  db.exec('BEGIN');
  rows.forEach((r, i) => {
    const rowHash = `testhash-${yearMonth}-${i}`;
    insertRow(yearMonth, rowHash, r);
  });
  monthRepo.upsertMonthMeta(db, { yearMonth, rowCount: rows.length, sourceFiles: ['test.xlsx'] });
  db.exec('COMMIT');
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log('  ✓', name); pass += 1; }
  else { console.log('  ✗', name, detail ? `— ${detail}` : ''); fail += 1; }
}

try {
  const db = openPendingDb(TMP);

  // === 测试数据 ===
  // upper (2026-09) 4 行
  insertRows(db, '2026-09', [
    sampleRow({ orderNo: 'A001', amount: '100', currency: 'USD' }), // unchanged
    sampleRow({ orderNo: 'A002', amount: '200', currency: 'CNY' }), // changed (金额变)
    sampleRow({ orderNo: 'A003', amount: '300', currency: 'HKD' }), // missing
    sampleRow({ orderNo: 'A004', amount: '400', currency: 'JPY' })  // missing
  ]);
  // lower (2026-10) 4 行
  insertRows(db, '2026-10', [
    sampleRow({ orderNo: 'A001', amount: '100', currency: 'USD' }), // unchanged
    sampleRow({ orderNo: 'A002', amount: '250', currency: 'CNY' }), // changed (金额变)
    sampleRow({ orderNo: 'A005', amount: '500', currency: 'HKD' }), // new
    sampleRow({ orderNo: 'A006', amount: '600', currency: 'EUR' })  // new
  ]);

  // === T1: 基础三类（new=2 / missing=2 / changed=1）===
  console.log('[T1] basic: match=[order_no], compare=[金额, 币种]');
  {
    const rule = { matchFields: ['order_no'], compareFields: ['金额', '币种'] };
    const result = engine.runReconciliation(db, { upperMonth: '2026-09', lowerMonth: '2026-10', rule });

    check('statNew = 2', result.statNew === 2, `got ${result.statNew}`);
    check('statMissing = 2', result.statMissing === 2, `got ${result.statMissing}`);
    check('statChanged = 1 (A002 金额 200→250)', result.statChanged === 1, `got ${result.statChanged}`);
    check('total = 5', result.total === 5);

    // 逐条验证 diff_rows 内容
    const newRows = diffRepo.listDiffRows(db, result.runId, 'new');
    const missingRows = diffRepo.listDiffRows(db, result.runId, 'missing');
    const changedRows = diffRepo.listDiffRows(db, result.runId, 'changed');

    // new 行只有 lower_row_id
    const newLowerIds = newRows.map((r) => r.lowerRowId).filter((v) => v != null);
    const newLowerOrderNos = newLowerIds.map((id) => {
      const row = db.prepare('SELECT `order_no` AS o FROM pending_rows WHERE id = ?').get(id);
      return row ? row.o : null;
    });
    check(
      'new rows = [A005, A006]',
      JSON.stringify([...newLowerOrderNos].sort()) === JSON.stringify(['A005', 'A006']),
      JSON.stringify(newLowerOrderNos)
    );

    const missingUpperOrderNos = missingRows.map((r) => {
      const row = db.prepare('SELECT `order_no` AS o FROM pending_rows WHERE id = ?').get(r.upperRowId);
      return row ? row.o : null;
    });
    check(
      'missing rows = [A003, A004]',
      JSON.stringify([...missingUpperOrderNos].sort()) === JSON.stringify(['A003', 'A004']),
      JSON.stringify(missingUpperOrderNos)
    );

    check(
      'changed 1 row with both upper_row_id + lower_row_id',
      changedRows.length === 1 && changedRows[0].upperRowId != null && changedRows[0].lowerRowId != null
    );
    if (changedRows[0]) {
      const upperRow = db.prepare('SELECT `order_no` AS o, `金额` AS m FROM pending_rows WHERE id = ?').get(changedRows[0].upperRowId);
      const lowerRow = db.prepare('SELECT `order_no` AS o, `金额` AS m FROM pending_rows WHERE id = ?').get(changedRows[0].lowerRowId);
      check('changed row order_no = A002 (both sides)', upperRow.o === 'A002' && lowerRow.o === 'A002');
      check('changed 金额 upper=200 lower=250', upperRow.m === '200' && lowerRow.m === '250');
    }
  }

  // === T2: A1 fallback — match=[order_no, 币种] 的 2 轮 ===
  // 轮 1 (order_no): A001↔A001, A002↔A002（2 对）
  // 轮 2 (币种): 剩余 upper[A003(HKD), A004(JPY)] / lower[A005(HKD), A006(EUR)]
  //            只 HKD 有配对 A003↔A005（1 对）；A004/A006 无配对
  // compareFields=[金额]:
  //   A001(100)↔A001(100) 不变
  //   A002(200)↔A002(250) 变
  //   A003(300)↔A005(500) 变 → changed=2
  console.log('[T2] A1 fallback match=[order_no, 币种]: new=1 / missing=1 / changed=2');
  {
    const rule = { matchFields: ['order_no', '币种'], compareFields: ['金额'] };
    const result = engine.runReconciliation(db, { upperMonth: '2026-09', lowerMonth: '2026-10', rule });
    check('statNew = 1 (A006 未配)', result.statNew === 1, `got ${result.statNew}`);
    check('statMissing = 1 (A004 未配)', result.statMissing === 1, `got ${result.statMissing}`);
    check('statChanged = 2 (A002 + A003↔A005)', result.statChanged === 2, `got ${result.statChanged}`);
  }

  // === T3: compareFields 为空 — 只有 new / missing，没 changed ===
  console.log('[T3] compareFields=[] → changed 恒为 0');
  {
    const rule = { matchFields: ['order_no'], compareFields: [] };
    const result = engine.runReconciliation(db, { upperMonth: '2026-09', lowerMonth: '2026-10', rule });
    check('statChanged = 0', result.statChanged === 0);
    check('statNew = 2', result.statNew === 2);
    check('statMissing = 2', result.statMissing === 2);
  }

  // === T4: 保留所有 run（重跑不覆盖）===
  console.log('[T4] 多次 run 全部保留（OT-10 历史 run）');
  {
    const allRuns = diffRepo.listAllRuns(db);
    check('已产生 3 个 run (T1+T2+T3)', allRuns.length === 3, `got ${allRuns.length}`);
    check(
      'all runs for (2026-09, 2026-10)',
      allRuns.every((r) => r.upperMonth === '2026-09' && r.lowerMonth === '2026-10')
    );
    check(
      'rule_snapshot 完整保留各 run 配置',
      allRuns.every((r) => r.ruleSnapshot && Array.isArray(r.ruleSnapshot.matchFields))
    );

    const latest = diffRepo.getLatestRunForMonthPair(db, '2026-09', '2026-10');
    check('latest run 是最新那次（T3 compareFields=[]）', latest && latest.statChanged === 0);
  }

  // === T6: 索引 lazy 建 ===
  console.log('[T6] ensureMatchIndex 幂等 + 索引存在');
  {
    engine.ensureMatchIndex(db, ['order_no']);
    engine.ensureMatchIndex(db, ['order_no']); // 第二次应无错
    const idxRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_pending_match_%'")
      .all();
    check('match 索引已建', idxRow.length >= 1, `got ${idxRow.length}`);
  }

  // === T7: match field 不在 PENDING_COLUMNS 应抛错 ===
  console.log('[T7] match field 必须在 PENDING_COLUMNS');
  {
    let threw = false;
    try {
      engine.runReconciliation(db, {
        upperMonth: '2026-09',
        lowerMonth: '2026-10',
        rule: { matchFields: ['NOT_A_REAL_COL'], compareFields: [] }
      });
    } catch (err) {
      threw = true;
      check('error message mentions PENDING_COLUMNS', /PENDING_COLUMNS|模板/.test(err.message));
    }
    check('runReconciliation throws on invalid match field', threw);
  }

  db.close();
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nTotal: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
