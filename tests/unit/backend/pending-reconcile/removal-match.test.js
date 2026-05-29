// v2.1.11 T2 — missing ↔ 移除归档 匹配（🔴 资金/对账红线）红线 unit
//
// 验证 src/backend/pending-reconcile/removal-match.js 的 matchRemoval / listMatchedDiffRowIds /
// listMatchedRemovedRowIds 与 pending-reconcile/engine.js runReconciliation 的配对语义一致：
//   - 多轮 fallback：外层遍历 matchFields，第 n 轮用第 n 个字段做 key
//   - 单字段相等即配对；空值（null / ''）跳过（engine: field IS NOT NULL AND field <> ''）
//   - 同 key 1 对 1，id 升序（missing 侧用 pending_rows.id / removed 侧用 removed_pending_rows.id）
//   - 已配对行移出候选池，进入下一轮用下一个字段
//   - 幂等：重复 matchRemoval 先删旧匹配，不累积
//
// setup：内存库 + runMigrations；直接 SQL 插 pending_rows（upper 月若干行 + matchField 列）
//   + diff_runs（1 run）+ diff_rows（type='missing'，upper_row_id 指向 pending_rows）；
//   removed 行用 removed-repository.replaceByMonth 插（走真实入库 + listByMonth 真实回读路径）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../../../src/backend/pending-db/migrations');
const removedRepo = require('../../../../src/backend/pending-db/removed-repository');
const removalMatch = require('../../../../src/backend/pending-reconcile/removal-match');

const UPPER_MONTH = '2026-04';
const LOWER_MONTH = '2026-05';

// 插一条 pending_rows（upper 月），仅给需要的列赋值，其余空字符串。
// 返回 pending_rows.id。row_hash 必填（migrations: NOT NULL + UNIQUE(year_month,row_hash)）。
function insertPendingRow(db, yearMonth, hash, fields) {
  const cols = ['order_no', 'recon_id', '金额', 'channel', 'merchant_id', 'bank_ref'];
  const placeholders = cols.map(() => '?').join(', ');
  const colList = cols.map((c) => `\`${c}\``).join(', ');
  const stmt = db.prepare(
    `INSERT INTO pending_rows (year_month, row_hash, ${colList}) VALUES (?, ?, ${placeholders})`
  );
  const vals = cols.map((c) => (fields[c] == null ? '' : String(fields[c])));
  const r = stmt.run(yearMonth, hash, ...vals);
  return Number(r.lastInsertRowid);
}

// 建一个 run + 把给定 pendingRowIds 作为 missing diff 行插入。返回 { runId, diffRowIds }（diffRowIds 与入参同序）
function createRunWithMissing(db, pendingRowIds) {
  const createdAt = new Date().toISOString();
  const runRes = db
    .prepare(
      `INSERT INTO diff_runs (upper_month, lower_month, rule_snapshot, created_at, stat_new, stat_missing, stat_changed)
       VALUES (?, ?, ?, ?, 0, ?, 0)`
    )
    .run(UPPER_MONTH, LOWER_MONTH, '{}', createdAt, pendingRowIds.length);
  const runId = Number(runRes.lastInsertRowid);
  const diffRowIds = [];
  const ins = db.prepare(
    `INSERT INTO diff_rows (run_id, type, upper_row_id, lower_row_id) VALUES (?, 'missing', ?, NULL)`
  );
  for (const pid of pendingRowIds) {
    const r = ins.run(runId, pid);
    diffRowIds.push(Number(r.lastInsertRowid));
  }
  return { runId, diffRowIds };
}

// 构造 removed-reader 风格的行：{ raw:{...}, order_no, recon_id, ... }
function removedRow(fields) {
  const raw = {};
  for (const k of Object.keys(fields)) raw[k] = String(fields[k]);
  return {
    raw,
    order_no: fields.order_no == null ? '' : String(fields.order_no),
    recon_id: fields.recon_id == null ? '' : String(fields.recon_id),
    金额: fields['金额'] == null ? '' : String(fields['金额']),
    channel: fields.channel == null ? '' : String(fields.channel),
    merchant_id: fields.merchant_id == null ? '' : String(fields.merchant_id),
    bank_ref: fields.bank_ref == null ? '' : String(fields.bank_ref)
  };
}

let db;
test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  runMigrations(db);
});
test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('removal-match — matchRemoval 配对语义', () => {
  test('① 单字段命中（order_no 相等）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1' });
    const p2 = insertPendingRow(db, UPPER_MONTH, 'h2', { order_no: 'O2' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1, p2]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1' }),
      removedRow({ order_no: 'O2' })
    ], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res.matchedCount, 2, '两行都应配上');
    assert.equal(res.missingUnmatched, 0);
    assert.equal(res.removedUnmatched, 0);

    const matchedDiff = removalMatch.listMatchedDiffRowIds(db, runId);
    assert.ok(matchedDiff.has(diffRowIds[0]) && matchedDiff.has(diffRowIds[1]));
  });

  test('② 多轮 fallback：第一字段不中、第二字段命中', () => {
    // missing 行：order_no 与任一 removed 都不等；recon_id 相等
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'X1', recon_id: 'R1' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'Y9', recon_id: 'R1' }) // order_no 不同，recon_id 同
    ], 'f.xlsx');

    // matchFields 顺序：先 order_no（不中）→ 再 recon_id（中）
    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no', 'recon_id']);
    assert.equal(res.matchedCount, 1, '第二轮 recon_id 应配上');
    assert.equal(res.missingUnmatched, 0);
    assert.equal(res.removedUnmatched, 0);

    // 留痕 match_field 应为 recon_id（第二轮命中）
    const row = db
      .prepare('SELECT match_field FROM pending_removal_matches WHERE run_id = ? AND diff_row_id = ?')
      .get(runId, diffRowIds[0]);
    assert.equal(row.match_field, 'recon_id');
  });

  test('③ missing 有、移除无（部分未配）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1' });
    const p2 = insertPendingRow(db, UPPER_MONTH, 'h2', { order_no: 'O2' }); // 无对应 removed
    const { runId } = createRunWithMissing(db, [p1, p2]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ order_no: 'O1' })], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res.matchedCount, 1);
    assert.equal(res.missingUnmatched, 1, 'O2 missing 未配（missing有_移除无）');
    assert.equal(res.removedUnmatched, 0);
  });

  test('④ 移除有、missing 无（移除多于 missing）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1' });
    const { runId } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1' }),
      removedRow({ order_no: 'O9' }) // 无对应 missing
    ], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res.matchedCount, 1);
    assert.equal(res.missingUnmatched, 0);
    assert.equal(res.removedUnmatched, 1, 'O9 removed 未配（移除有_missing无）');

    const matchedRemoved = removalMatch.listMatchedRemovedRowIds(db, runId);
    const all = removedRepo.listByMonth(db, UPPER_MONTH);
    const unmatched = all.filter((r) => !matchedRemoved.has(r.id));
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].order_no, 'O9');
  });

  test('⑤ 空 matchFields → 0 匹配（全部未配）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1' });
    const { runId } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ order_no: 'O1' })], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, []);
    assert.equal(res.matchedCount, 0);
    assert.equal(res.missingUnmatched, 1);
    assert.equal(res.removedUnmatched, 1);
    assert.equal(removalMatch.listMatchedDiffRowIds(db, runId).size, 0);
  });

  test('⑥ 空移除数据 → 0 匹配', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1' });
    const { runId } = createRunWithMissing(db, [p1]);
    // 不插 removed

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res.matchedCount, 0);
    assert.equal(res.missingUnmatched, 1);
    assert.equal(res.removedUnmatched, 0);
  });

  test('⑦ 幂等：重复 matchRemoval 先删旧不累积', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1' });
    const { runId } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ order_no: 'O1' })], 'f.xlsx');

    removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    const res2 = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res2.matchedCount, 1, '第二次仍只配 1 对');

    const total = db
      .prepare('SELECT COUNT(*) AS n FROM pending_removal_matches WHERE run_id = ?')
      .get(runId).n;
    assert.equal(total, 1, '匹配表不累积（仍 1 行）');
  });

  test('⑧ listMatchedDiffRowIds / listMatchedRemovedRowIds 正确（混合命中）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1' });
    const p2 = insertPendingRow(db, UPPER_MONTH, 'h2', { order_no: 'O2' });
    const p3 = insertPendingRow(db, UPPER_MONTH, 'h3', { order_no: 'O3' }); // 无 removed
    const { runId, diffRowIds } = createRunWithMissing(db, [p1, p2, p3]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1' }),
      removedRow({ order_no: 'O2' }),
      removedRow({ order_no: 'O9' }) // 无 missing
    ], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res.matchedCount, 2);

    const matchedDiff = removalMatch.listMatchedDiffRowIds(db, runId);
    assert.equal(matchedDiff.size, 2);
    assert.ok(matchedDiff.has(diffRowIds[0]) && matchedDiff.has(diffRowIds[1]));
    assert.ok(!matchedDiff.has(diffRowIds[2]), 'O3 未配，不在 matchedDiff');

    const matchedRemoved = removalMatch.listMatchedRemovedRowIds(db, runId);
    assert.equal(matchedRemoved.size, 2);
    const all = removedRepo.listByMonth(db, UPPER_MONTH);
    const o9 = all.find((r) => r.order_no === 'O9');
    assert.ok(!matchedRemoved.has(o9.id), 'O9 removed 未配，不在 matchedRemoved');
  });

  test('⑨ 空值跳过：missing/removed 的 key 字段为空不参与配对', () => {
    // p1 order_no 空（应跳过）；p2 order_no='O2'
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: '' });
    const p2 = insertPendingRow(db, UPPER_MONTH, 'h2', { order_no: 'O2' });
    const { runId } = createRunWithMissing(db, [p1, p2]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: '' }),   // 空 key removed，应跳过
      removedRow({ order_no: 'O2' })
    ], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res.matchedCount, 1, '只有 O2 配上；两侧空 key 都跳过');
    assert.equal(res.missingUnmatched, 1, 'p1 空 key 未配');
    assert.equal(res.removedUnmatched, 1, '空 key removed 未配');
  });

  test('⑩ 同 key 多行 → id 升序 1 对 1（min(左,右) 对）', () => {
    // 3 个 missing 同 key，2 个 removed 同 key → 配 2 对（min(3,2)），剩 1 missing
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'DUP' });
    const p2 = insertPendingRow(db, UPPER_MONTH, 'h2', { order_no: 'DUP' });
    const p3 = insertPendingRow(db, UPPER_MONTH, 'h3', { order_no: 'DUP' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1, p2, p3]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'DUP' }),
      removedRow({ order_no: 'DUP' })
    ], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res.matchedCount, 2, 'min(3,2)=2 对');
    assert.equal(res.missingUnmatched, 1);
    assert.equal(res.removedUnmatched, 0);

    // id 升序：配上的应是前 2 个 missing（diffRowIds[0], [1]），第 3 个未配
    const matchedDiff = removalMatch.listMatchedDiffRowIds(db, runId);
    assert.ok(matchedDiff.has(diffRowIds[0]) && matchedDiff.has(diffRowIds[1]));
    assert.ok(!matchedDiff.has(diffRowIds[2]), '第 3 个（id 最大）未配');
  });

  test('⑪ 多轮已配对行移出候选池（不被后续字段重复配）', () => {
    // p1: order_no=O1 且 recon_id=R1；removed r1: order_no=O1 recon_id=R1
    // 第一轮 order_no 配上 → 第二轮 recon_id 不应再重复配（matchedCount 仍 1）
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1', recon_id: 'R1' });
    const { runId } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1', recon_id: 'R1' })
    ], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no', 'recon_id']);
    assert.equal(res.matchedCount, 1, '第一轮已配，第二轮不重复');
    const total = db
      .prepare('SELECT COUNT(*) AS n FROM pending_removal_matches WHERE run_id = ?')
      .get(runId).n;
    assert.equal(total, 1);
  });

  test('⑫ matchField 非顶层索引列 → 从 raw 取值（慢路径）', () => {
    // 用 '币种'（pending_rows 有该列，但 removed_pending_rows 无索引列 → removed 侧从 raw 取）
    // pending_rows 没在 insertPendingRow 写 币种，这里直接 UPDATE 补
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', {});
    db.prepare('UPDATE pending_rows SET `币种` = ? WHERE id = ?').run('USD', p1);
    const { runId } = createRunWithMissing(db, [p1]);
    // removed 行 raw 含 币种=USD（顶层无 币种 字段）
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ 币种: 'USD' })], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['币种']);
    assert.equal(res.matchedCount, 1, '从 raw 取 币种 配上');
  });
});

// ⚠️ C1 资金红线（v2.1.11 SR-FIX Round 1）：数值字段比较 key 归一化
//   pending 入库（streaming-xlsx-reader）数值 cell → String(parseFloat)（"1234.5"）；
//   removed（removed-reader raw:false）→ 显示格式串（"1,234.50" 带千分位/尾零）。
//   归一化前两侧裸字符串比较 → 金额配不上（同一笔被同时误报 missing有_移除无 + 移除有_missing无）。
//   下列用例：pending 侧写「入库口径」串，removed 侧写「显示格式」串，断言金额能配上。
test.describe('removal-match — C1 数值字段比较 key 归一化（金额千分位/尾零）', () => {
  test('⑬ 金额 "1234.5"（pending 入库口径） vs "1,234.50"（removed 显示格式） → 配上', () => {
    // pending_rows.金额 模拟 streaming-reader：String(parseFloat("1234.50")) = "1234.5"
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { 金额: '1234.5' });
    const { runId } = createRunWithMissing(db, [p1]);
    // removed 金额取显示格式串（千分位 + 尾零），顶层 + raw 均为 "1,234.50"
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ 金额: '1,234.50' })], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['金额']);
    assert.equal(res.matchedCount, 1, '金额归一化后应配上（1234.5 == 1,234.50）');
    assert.equal(res.missingUnmatched, 0, '不应误报 missing有_移除无');
    assert.equal(res.removedUnmatched, 0, '不应误报 移除有_missing无');
  });

  test('⑭ 金额 "1000" vs "1,000.00" → 配上（整数尾零 + 千分位）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { 金额: '1000' });
    const { runId } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ 金额: '1,000.00' })], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['金额']);
    assert.equal(res.matchedCount, 1, '1000 == 1,000.00 应配上');
    assert.equal(res.missingUnmatched, 0);
    assert.equal(res.removedUnmatched, 0);
  });

  test('⑮ 金额 "0.1" vs "0.10" → 配上（小数尾零）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { 金额: '0.1' });
    const { runId } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ 金额: '0.10' })], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['金额']);
    assert.equal(res.matchedCount, 1, '0.1 == 0.10 应配上');
  });

  test('⑯ 金额不同值仍不配（归一化不放宽到错配）：1234.5 vs 1,234.60', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { 金额: '1234.5' });
    const { runId } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ 金额: '1,234.60' })], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['金额']);
    assert.equal(res.matchedCount, 0, '金额不等不应配上');
    assert.equal(res.missingUnmatched, 1);
    assert.equal(res.removedUnmatched, 1);
  });

  test('⑰ 非数值字段（order_no）千分位形态不归一化：保持字符串严格比较', () => {
    // order_no 含逗号/前导零等非数值文本不应被当数值归一化（避免错配）
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: '1,234' });
    const { runId } = createRunWithMissing(db, [p1]);
    // removed order_no = "1234"（无逗号）—— 非数值字段不归一化 → 不应配上
    removedRepo.replaceByMonth(db, UPPER_MONTH, [removedRow({ order_no: '1234' })], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);
    assert.equal(res.matchedCount, 0, 'order_no 是非数值字段，"1,234" ≠ "1234" 不应配上');
  });

  test('⑱ 金额配对走多轮 fallback（order_no 不中 → 金额归一化命中）', () => {
    // order_no 两侧不同（第一轮不中）；金额经归一化相等（第二轮命中）
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'X1', 金额: '500' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'Y9', 金额: '500.00' })
    ], 'f.xlsx');

    const res = removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no', '金额']);
    assert.equal(res.matchedCount, 1, '第二轮金额归一化命中');
    const row = db
      .prepare('SELECT match_field FROM pending_removal_matches WHERE run_id = ? AND diff_row_id = ?')
      .get(runId, diffRowIds[0]);
    assert.equal(row.match_field, '金额', '命中字段应为 金额');
  });
});

// ===== v2.1.11 T2 手测增强：compareMatchedContent 内容核对（状态列三态） =====
//   配对成功后用 compareFields（共用对账规则）比对 missing 行 vs 移除行内容：
//     - 全部归一化一致 → { status:'无误' }
//     - 有不一致 → { status:'有差异', diffText:'字段(missing原值≠移除原值); …' }
//   🔴 红线：一致性判定复用 C1 数值归一化（"100" vs "100.00" 判一致不误报）；差异文字展示原始值。
//   未配对的 missing 行不在返回 Map（writer 据此填 missing有_移除无）。
test.describe('removal-match — compareMatchedContent 内容核对（compareFields 共用对账规则）', () => {
  // 先 order_no 配对（稳定），再用 compareFields 比对其它字段内容
  test('① 配上 + compareFields 全部一致 → 核对无误', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1', 金额: '100', channel: 'C1' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1', 金额: '100', channel: 'C1' })
    ], 'f.xlsx');
    removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);

    const map = removalMatch.compareMatchedContent(db, runId, ['金额', 'channel']);
    assert.equal(map.size, 1);
    const r = map.get(diffRowIds[0]);
    assert.equal(r.status, '无误', 'compareFields 全一致 → 无误');
    assert.equal(r.diffText, '');
  });

  test('② 配上 + 金额带千分位/尾零但数值相等 → 核对无误（复用 C1 归一化，不误报）', () => {
    // 🔴 关键用例：missing 侧 "1234.5"（pending 入库口径）vs removed 侧 "1,234.50"（显示格式）
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1', 金额: '1234.5' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1', 金额: '1,234.50' })
    ], 'f.xlsx');
    removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']); // 用 order_no 配对

    const map = removalMatch.compareMatchedContent(db, runId, ['金额']);
    const r = map.get(diffRowIds[0]);
    assert.equal(r.status, '无误', '金额 1234.5 vs 1,234.50 归一化后相等 → 不误报核对有差异');
    assert.equal(r.diffText, '');
  });

  test('③ 配上 + 金额真不同 → 核对有差异（差异文字含金额 + 原始值）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1', 金额: '500' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1', 金额: '600.00' })
    ], 'f.xlsx');
    removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);

    const map = removalMatch.compareMatchedContent(db, runId, ['金额']);
    const r = map.get(diffRowIds[0]);
    assert.equal(r.status, '有差异');
    // 展示原始值（500 / 600.00），不显示归一化后的值
    assert.equal(r.diffText, '金额(500≠600.00)');
  });

  test('④ 多字段差异 → 文字含多字段，; 分隔', () => {
    // 金额不同 + channel 不同；币种相同（不进差异文字）
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1', 金额: '500', channel: 'A' });
    db.prepare('UPDATE pending_rows SET `币种` = ? WHERE id = ?').run('USD', p1);
    const { runId, diffRowIds } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1', 金额: '600', channel: 'B', 币种: 'USD' })
    ], 'f.xlsx');
    removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);

    // compareFields 顺序 = 金额, 币种, channel → 差异文字按此顺序，仅含不一致字段（金额/channel）
    const map = removalMatch.compareMatchedContent(db, runId, ['金额', '币种', 'channel']);
    const r = map.get(diffRowIds[0]);
    assert.equal(r.status, '有差异');
    assert.equal(r.diffText, '金额(500≠600); channel(A≠B)', '多字段用 "; " 分隔，币种一致不进文字');
  });

  test('⑤ 没配上的 missing 行 → 不在返回 Map（writer 据此填 missing有_移除无）', () => {
    // O1 配上、O2 无对应 removed（未配上）
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1', 金额: '100' });
    const p2 = insertPendingRow(db, UPPER_MONTH, 'h2', { order_no: 'O2', 金额: '200' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1, p2]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1', 金额: '100' })
    ], 'f.xlsx');
    removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);

    const map = removalMatch.compareMatchedContent(db, runId, ['金额']);
    assert.equal(map.size, 1, '只含配对成功的 O1');
    assert.ok(map.has(diffRowIds[0]), 'O1 在 Map（核对无误）');
    assert.ok(!map.has(diffRowIds[1]), 'O2 未配对 → 不在 Map');
    assert.equal(map.get(diffRowIds[0]).status, '无误');
  });

  test('⑥ compareFields 为空 → 配上即无误（无可比内容）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1', 金额: '100' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1', 金额: '999' }) // 金额不同，但 compareFields 空 → 不比
    ], 'f.xlsx');
    removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);

    const map = removalMatch.compareMatchedContent(db, runId, []);
    assert.equal(map.get(diffRowIds[0]).status, '无误', 'compareFields 空 → 无可比 → 无误');
  });

  test('⑦ 空值核对：missing 有值 vs removed 空 → 有差异（原始值显示空串侧）', () => {
    const p1 = insertPendingRow(db, UPPER_MONTH, 'h1', { order_no: 'O1', channel: 'X' });
    const { runId, diffRowIds } = createRunWithMissing(db, [p1]);
    removedRepo.replaceByMonth(db, UPPER_MONTH, [
      removedRow({ order_no: 'O1' }) // channel 空
    ], 'f.xlsx');
    removalMatch.matchRemoval(db, runId, UPPER_MONTH, ['order_no']);

    const map = removalMatch.compareMatchedContent(db, runId, ['channel']);
    const r = map.get(diffRowIds[0]);
    assert.equal(r.status, '有差异', 'X vs 空 → 有差异');
    assert.equal(r.diffText, 'channel(X≠)', '差异文字 removed 侧显示空');
  });
});
