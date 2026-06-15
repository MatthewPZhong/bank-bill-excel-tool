// v3.0.5 需求（OPEN-7 / T5a）：银行对账单入金表「跨期重复命中提醒」命中标记读写仓储 + migration 加列单测。
//
// 背景（🔴 资金红线 spec §3.6）：
//   累加表残留的历史月份行仍参与对账，被某次对账「成功使用」（以入金表为命中来源，如 R5 场景4 matchJpmUs 桥接 /
//   refund R3/R5/R6 二跳）即记一次命中。载体 = linked_bank_deposit 专用列 last_hit_run / last_hit_at（不动 65.7 万行 raw_json）；
//   键 = biz_id（OPEN-1 幂等键 = BANK_DEPOSIT_FIELDS[0]，UNIQUE）。归一口径 normalizeKey（String().trim()）与 migration 回填一致。
//
// 范式同 linked-bank-deposit-upsert.test.js：临时 DatabaseSync + ensureLinkedTableSupport(db) 建 schema
//   （T1a 已把 last_hit_run/last_hit_at 加列纳入 ensureLinkedTableSupport），再调读写函数。
//
// 覆盖（本批 T5a 只交付 3 函数 + facade + migration 加列，命中回写/提醒注入在 T5b）：
//   UT-HIT-1  markBankDepositHits：写入后 last_hit_run/last_hit_at 精确；marked = 命中行数
//   UT-HIT-2  markBankDepositHits：仅 UPDATE 已存在 biz_id；缺失 BizId 不 INSERT（不凭空造行）+ marked 不计缺失
//   UT-HIT-3  markBankDepositHits：空数组 / 全空键 no-op（marked=0，不改任何行）
//   UT-HIT-4  readBankDepositHitMarkers：返回正确 Map；未命中不在 Map；空入参 → 空 Map；归一/去重入参
//   UT-HIT-5  clearBankDepositHitMarkersByBizIds：置 NULL；不影响其他 BizId；不动 raw_json/biz_id；缺失 no-op
//   UT-HIT-6  🔴 关键锁死：markBankDepositHits 标记后再 upsertLinkedBankDeposit 同 BizId（覆盖 raw_json）→ last_hit 保留不被洗
//             （证 buildLinkedUpsertContext ON CONFLICT 4 列 SET 不碰标记列）；新 BizId 行 last_hit 为 NULL
//   UT-HIT-7  🔴 migration 幂等：连跑 ensureLinkedTableSupport 2 次列只加一次（PRAGMA table_info 计数）；旧库升级后列存在且默认 NULL
//   UT-HIT-8  🔴 last_hit 列绝不进任何 UNIQUE 索引（PRAGMA index_list/index_info 自证）
//   UT-HIT-9  🔴 (T5c Important) readBankDepositHitMarkers 按 chunk 分批：构造 2000 个 BizId（> 900 批量上限、> 旧 SQLite 999 参数上限）
//             → 不抛 "too many SQL variables" → 结果 Map 完整正确（标记/未标记/未入库各类均跨批合并准确）

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-hit-'));
  db = new DatabaseSync(path.join(tmpDir, 'm.sqlite'));
  ensureLinkedTableSupport(db); // 🔴 含 biz_id + UNIQUE + last_hit_run/last_hit_at 加列（T1a）
});

test.afterEach(() => {
  try { if (db && db.close) db.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 构造真实表头键名的入金表行对象（bank-deposit def：keyHeader=ReconciliationId / dateHeader=BillDate；幂等键 BizId）。
function bdRow(bizId, reconId, billDate, extra = {}) {
  const row = { ReconciliationId: reconId, BillDate: billDate, ...extra };
  if (bizId !== undefined) row.BizId = bizId;
  return row;
}

// 直接读某 biz_id 行的标记列（绕过仓储，验证 DB 真实落值）。
function markersOf(bizId) {
  return db.prepare('SELECT last_hit_run, last_hit_at FROM linked_bank_deposit WHERE biz_id = ?').get(bizId);
}

function rawOf(bizId) {
  const r = db.prepare('SELECT raw_json FROM linked_bank_deposit WHERE biz_id = ?').get(bizId);
  return r ? JSON.parse(r.raw_json) : null;
}

function tableRowCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM linked_bank_deposit').get().c;
}

test.describe('linked-table-repository — 银行对账单入金表跨期命中标记（OPEN-7 / T5a）', () => {
  // UT-HIT-1：写入后标记精确 + marked = 命中行数
  test('UT-HIT-1：markBankDepositHits 写入后 last_hit_run/last_hit_at 精确、marked=命中行数', () => {
    repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-A', 'R-A', '2026-01-01'),
      bdRow('BIZ-B', 'R-B', '2026-01-02')
    ]);

    const res = repo.markBankDepositHits(db, ['BIZ-A', 'BIZ-B'], 'run-001', '2026-06-15T10:00:00.000Z');
    assert.equal(res.marked, 2, '两行均命中 → marked=2');

    const a = markersOf('BIZ-A');
    assert.equal(a.last_hit_run, 'run-001', 'BIZ-A last_hit_run 精确');
    assert.equal(a.last_hit_at, '2026-06-15T10:00:00.000Z', 'BIZ-A last_hit_at 精确');
    const b = markersOf('BIZ-B');
    assert.equal(b.last_hit_run, 'run-001', 'BIZ-B last_hit_run 精确');
    assert.equal(b.last_hit_at, '2026-06-15T10:00:00.000Z', 'BIZ-B last_hit_at 精确');
  });

  // UT-HIT-2：仅 UPDATE 已存在 biz_id；缺失 BizId 不 INSERT
  test('UT-HIT-2：仅 UPDATE 已存在行——缺失 BizId 不 INSERT、marked 不计缺失', () => {
    repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-A', 'R-A', '2026-01-01')]);
    const before = tableRowCount();
    assert.equal(before, 1, '前置仅 1 行');

    // BIZ-A 存在 + BIZ-MISSING 不存在 → 只标 BIZ-A，不为 BIZ-MISSING 造行
    const res = repo.markBankDepositHits(db, ['BIZ-A', 'BIZ-MISSING'], 'run-002', '2026-06-15T11:00:00.000Z');
    assert.equal(res.marked, 1, '🔴 仅命中已存在的 BIZ-A → marked=1（缺失不计）');
    assert.equal(tableRowCount(), 1, '🔴 缺失 BizId 未被 INSERT，表仍 1 行');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM linked_bank_deposit WHERE biz_id = 'BIZ-MISSING'").get().c, 0, 'BIZ-MISSING 未入库');
    assert.equal(markersOf('BIZ-A').last_hit_run, 'run-002', 'BIZ-A 已标记');
  });

  // UT-HIT-3：空数组 / 全空键 no-op
  test('UT-HIT-3：空数组 / 全空键 no-op（marked=0，不改任何行）', () => {
    repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-A', 'R-A', '2026-01-01')]);
    repo.markBankDepositHits(db, ['BIZ-A'], 'run-pre', '2026-06-15T09:00:00.000Z');
    const before = markersOf('BIZ-A');

    assert.deepEqual(repo.markBankDepositHits(db, [], 'run-x', '2026-06-15T12:00:00.000Z'), { marked: 0 }, '空数组 marked=0');
    assert.deepEqual(repo.markBankDepositHits(db, ['', '   ', null, undefined], 'run-x', '2026-06-15T12:00:00.000Z'), { marked: 0 }, '全空键 marked=0');
    assert.deepEqual(repo.markBankDepositHits(db, null, 'run-x', '2026-06-15T12:00:00.000Z'), { marked: 0 }, '非数组 marked=0');

    const after = markersOf('BIZ-A');
    assert.equal(after.last_hit_run, before.last_hit_run, 'no-op 未改 BIZ-A last_hit_run');
    assert.equal(after.last_hit_at, before.last_hit_at, 'no-op 未改 BIZ-A last_hit_at');
  });

  // UT-HIT-4：readBankDepositHitMarkers 返回 Map / 未命中不在 Map / 空入参空 Map / 归一去重
  test('UT-HIT-4：readBankDepositHitMarkers——返回正确 Map、未命中不在 Map、空入参空 Map、归一去重', () => {
    repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-A', 'R-A', '2026-01-01'),
      bdRow('BIZ-B', 'R-B', '2026-01-02'),
      bdRow('BIZ-C', 'R-C', '2026-01-03')  // 未标记 → 标记列为 NULL
    ]);
    repo.markBankDepositHits(db, ['BIZ-A', 'BIZ-B'], 'run-003', '2026-06-15T13:00:00.000Z');

    // 空入参 → 空 Map
    assert.equal(repo.readBankDepositHitMarkers(db, []).size, 0, '空数组 → 空 Map');
    assert.equal(repo.readBankDepositHitMarkers(db, null).size, 0, '非数组 → 空 Map');

    // 查 A/B/C/MISSING；归一 + 去重（带空格 / 重复）入参
    const m = repo.readBankDepositHitMarkers(db, ['  BIZ-A  ', 'BIZ-A', 'BIZ-B', 'BIZ-C', 'BIZ-MISSING', '']);
    assert.ok(m.has('BIZ-A'), 'BIZ-A 在 Map（带空格归一命中）');
    assert.deepEqual(m.get('BIZ-A'), { last_hit_run: 'run-003', last_hit_at: '2026-06-15T13:00:00.000Z' }, 'BIZ-A 标记正确');
    assert.deepEqual(m.get('BIZ-B'), { last_hit_run: 'run-003', last_hit_at: '2026-06-15T13:00:00.000Z' }, 'BIZ-B 标记正确');
    // BIZ-C 已入库但未标记 → 在 Map 但标记列为 null
    assert.ok(m.has('BIZ-C'), 'BIZ-C 已入库 → 在 Map');
    assert.deepEqual(m.get('BIZ-C'), { last_hit_run: null, last_hit_at: null }, 'BIZ-C 未标记 → 标记列 null');
    // BIZ-MISSING 未入库 → 不在 Map
    assert.equal(m.has('BIZ-MISSING'), false, '🔴 未入库 BizId 不在 Map');
    assert.equal(m.has(''), false, '空键不在 Map');
  });

  // UT-HIT-5：clearBankDepositHitMarkersByBizIds 置 NULL / 不影响其他 / 不动 raw_json+biz_id / 缺失 no-op
  test('UT-HIT-5：clearBankDepositHitMarkersByBizIds——置 NULL、不影响其他 BizId、不动 raw_json/biz_id', () => {
    repo.upsertLinkedBankDeposit(db, [
      bdRow('BIZ-A', 'R-A', '2026-01-01', { 'Credit Amount': '100' }),
      bdRow('BIZ-B', 'R-B', '2026-01-02', { 'Credit Amount': '200' })
    ]);
    repo.markBankDepositHits(db, ['BIZ-A', 'BIZ-B'], 'run-004', '2026-06-15T14:00:00.000Z');
    const rawBeforeA = rawOf('BIZ-A');

    // 清 BIZ-A（+ 一个缺失 BizId 验证 no-op 不报错）
    const res = repo.clearBankDepositHitMarkersByBizIds(db, ['BIZ-A', 'BIZ-MISSING']);
    assert.equal(res.cleared, 1, '仅清 BIZ-A → cleared=1（缺失不计）');

    const a = markersOf('BIZ-A');
    assert.equal(a.last_hit_run, null, 'BIZ-A last_hit_run 置 NULL');
    assert.equal(a.last_hit_at, null, 'BIZ-A last_hit_at 置 NULL');
    // BIZ-B 不受影响
    const b = markersOf('BIZ-B');
    assert.equal(b.last_hit_run, 'run-004', '🔴 BIZ-B last_hit_run 不受影响');
    assert.equal(b.last_hit_at, '2026-06-15T14:00:00.000Z', '🔴 BIZ-B last_hit_at 不受影响');
    // 🔴 BIZ-A raw_json / biz_id 不动
    assert.deepEqual(rawOf('BIZ-A'), rawBeforeA, '🔴 清标记不动 BIZ-A raw_json');
    assert.equal(rawOf('BIZ-A')['Credit Amount'], '100', 'BIZ-A 业务字段保留');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM linked_bank_deposit WHERE biz_id = 'BIZ-A'").get().c, 1, 'BIZ-A 行仍在（biz_id 未动）');

    // 空入参 no-op
    assert.deepEqual(repo.clearBankDepositHitMarkersByBizIds(db, []), { cleared: 0 }, '空数组 cleared=0');
    assert.deepEqual(repo.clearBankDepositHitMarkersByBizIds(db, ['  ', null]), { cleared: 0 }, '全空键 cleared=0');
  });

  // UT-HIT-6：🔴🔴 关键锁死——upsert 覆盖同 BizId 时 last_hit 保留不被洗
  test('UT-HIT-6：🔴 markBankDepositHits 标记后 upsert 覆盖同 BizId → last_hit 保留不被洗；新 BizId last_hit 为 NULL', () => {
    repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-A', 'R-A1', '2026-01-01', { 'Credit Amount': '100' })]);
    repo.markBankDepositHits(db, ['BIZ-A'], 'run-005', '2026-06-15T15:00:00.000Z');

    // 重导覆盖同 BizId（raw_json/展示键/日期全变）——证 buildLinkedUpsertContext ON CONFLICT 4 列 SET 不碰标记列
    const upd = repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-A', 'R-A2', '2026-02-02', { 'Credit Amount': '999' })]);
    assert.equal(upd.overwriteCount, 1, '同 BizId 覆盖 → overwriteCount=1（确认走了 ON CONFLICT DO UPDATE）');

    // 业务列确实被覆盖
    assert.equal(rawOf('BIZ-A').ReconciliationId, 'R-A2', 'raw_json 被覆盖为最新（确认 upsert 生效）');
    assert.equal(rawOf('BIZ-A')['Credit Amount'], '999', '业务金额被覆盖为最新');
    // 🔴 关键：标记列纹丝不动
    const a = markersOf('BIZ-A');
    assert.equal(a.last_hit_run, 'run-005', '🔴 upsert 覆盖后 last_hit_run 保留不被洗');
    assert.equal(a.last_hit_at, '2026-06-15T15:00:00.000Z', '🔴 upsert 覆盖后 last_hit_at 保留不被洗');

    // 用 biz_id 变化的新行验证其 last_hit 为 NULL（新插入行标记列默认 NULL）
    repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-NEW', 'R-N', '2026-03-03')]);
    const n = markersOf('BIZ-NEW');
    assert.equal(n.last_hit_run, null, '新 BizId 行 last_hit_run 为 NULL');
    assert.equal(n.last_hit_at, null, '新 BizId 行 last_hit_at 为 NULL');
  });

  // UT-HIT-7：🔴 migration 幂等——连跑 2 次列只加一次；列存在且默认 NULL
  test('UT-HIT-7：migration 幂等——连跑 ensureLinkedTableSupport 2 次列只加一次、默认 NULL', () => {
    // beforeEach 已跑 1 次；再跑 1 次（模拟二次启动）
    ensureLinkedTableSupport(db);
    ensureLinkedTableSupport(db);

    const cols = db.prepare('PRAGMA table_info(linked_bank_deposit)').all();
    const runCols = cols.filter((c) => c.name === 'last_hit_run');
    const atCols = cols.filter((c) => c.name === 'last_hit_at');
    assert.equal(runCols.length, 1, '🔴 last_hit_run 列只加一次（连跑 3 次仍 1 列）');
    assert.equal(atCols.length, 1, '🔴 last_hit_at 列只加一次');

    // 新建库升级后列存在且默认 NULL（ADD COLUMN 无默认值 → NULL）
    repo.upsertLinkedBankDeposit(db, [bdRow('BIZ-Z', 'R-Z', '2026-01-01')]);
    const z = markersOf('BIZ-Z');
    assert.equal(z.last_hit_run, null, '升级后新行 last_hit_run 默认 NULL');
    assert.equal(z.last_hit_at, null, '升级后新行 last_hit_at 默认 NULL');
  });

  // UT-HIT-8：🔴 last_hit 列绝不进任何 UNIQUE 索引
  test('UT-HIT-8：last_hit_run/last_hit_at 绝不进任何 UNIQUE 索引', () => {
    const indexes = db.prepare("PRAGMA index_list('linked_bank_deposit')").all();
    for (const idx of indexes) {
      const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all().map((c) => c.name);
      assert.equal(cols.includes('last_hit_run'), false, `🔴 索引 ${idx.name} 不含 last_hit_run`);
      assert.equal(cols.includes('last_hit_at'), false, `🔴 索引 ${idx.name} 不含 last_hit_at`);
    }
    // 双保险：唯一索引存在且只覆盖 biz_id（确认 biz_id UNIQUE 未被标记列污染）
    const uniqIdx = indexes.filter((i) => i.unique);
    const uniqCols = uniqIdx.flatMap((i) => db.prepare(`PRAGMA index_info('${i.name}')`).all().map((c) => c.name));
    assert.ok(uniqCols.includes('biz_id'), 'biz_id UNIQUE 索引存在');
    assert.equal(uniqCols.includes('last_hit_run'), false, '🔴 UNIQUE 索引不含 last_hit_run');
    assert.equal(uniqCols.includes('last_hit_at'), false, '🔴 UNIQUE 索引不含 last_hit_at');
  });

  // UT-HIT-9：🔴 (T5c Important) readBankDepositHitMarkers 按 chunk 分批，规避 SQLite IN 参数上限
  test('UT-HIT-9：readBankDepositHitMarkers 按 chunk 分批——2000 个 BizId 不抛参数上限错、跨批合并 Map 完整正确', () => {
    const TOTAL = 2000; // > 900 批量上限（需 3 批）且 > 旧 SQLite 999 参数上限（修复前一次性 IN 会抛 "too many SQL variables"）
    const rows = [];
    for (let i = 0; i < TOTAL; i += 1) {
      // 左补零保证字典序与插入序一致，便于断言；biz_id 唯一
      rows.push(bdRow(`BIZ-${String(i).padStart(5, '0')}`, `R-${i}`, '2026-01-01'));
    }
    repo.upsertLinkedBankDeposit(db, rows);
    assert.equal(tableRowCount(), TOTAL, `前置 ${TOTAL} 行全部入库`);

    // 标记前一半（0..999），后一半（1000..1999）入库但不标记 → 验证「已标记 / 入库未标记」两类都能跨批正确返回
    const markedIds = [];
    for (let i = 0; i < 1000; i += 1) markedIds.push(`BIZ-${String(i).padStart(5, '0')}`);
    const markRes = repo.markBankDepositHits(db, markedIds, 'run-chunk', '2026-06-15T16:00:00.000Z');
    assert.equal(markRes.marked, 1000, '前 1000 行均标记');

    // 查询入参 = 全部 2000 个入库 BizId + 5 个未入库 BizId（共 2005，> 999；修复前此处抛错）
    const queryIds = rows.map((r) => r.BizId);
    for (let i = 0; i < 5; i += 1) queryIds.push(`BIZ-MISSING-${i}`);

    let markerMap;
    assert.doesNotThrow(() => {
      markerMap = repo.readBankDepositHitMarkers(db, queryIds);
    }, '🔴 2005 个入参不抛 "too many SQL variables"（chunk 分批生效）');

    // 🔴 Map 完整性：2000 个入库 BizId 全部在 Map（跨 3 批合并无遗漏），5 个未入库不在 Map
    assert.equal(markerMap.size, TOTAL, `🔴 Map 含全部 ${TOTAL} 个入库 BizId（跨批合并无遗漏/无重复）`);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(markerMap.has(`BIZ-MISSING-${i}`), false, `未入库 BIZ-MISSING-${i} 不在 Map`);
    }

    // 抽样校验三批边界值（< 900 批1 / 900~1799 批2 / ≥1800 批3）的标记值正确
    const checkMarked = (id) => {
      assert.deepEqual(markerMap.get(id), { last_hit_run: 'run-chunk', last_hit_at: '2026-06-15T16:00:00.000Z' }, `${id} 已标记值正确`);
    };
    const checkUnmarked = (id) => {
      assert.deepEqual(markerMap.get(id), { last_hit_run: null, last_hit_at: null }, `${id} 入库未标记 → 标记列 null`);
    };
    checkMarked('BIZ-00000');   // 批1 首
    checkMarked('BIZ-00899');   // 批1 末（chunk 边界）
    checkMarked('BIZ-00900');   // 批2 首（chunk 边界）
    checkMarked('BIZ-00999');   // 批2 内（标记区末位）
    checkUnmarked('BIZ-01000'); // 批2 内（未标记区首位）
    checkUnmarked('BIZ-01799'); // 批2 末（chunk 边界）
    checkUnmarked('BIZ-01800'); // 批3 首（chunk 边界）
    checkUnmarked('BIZ-01999'); // 批3 末（全表末位）
  });
});
