// v3.0.5 批次2b：BOC 链接表「增量进组 + DB 全量重匹配 + 重编号」仓储 + 端到端单测（🔴🔴 资金红线）。
//
// 覆盖（spec §3.2.2 / OPEN-3 / OPEN-5 不变量）：
//   R1  upsertBocFxLink：新键追加 + 同键覆盖（id 不变 → 行序稳定）+ orig_group_no 写入 + 空键拒入计数
//   R2  readBocFxLinkRowsForRematch：注入 __origGroup 辅助键 + 按 id ASC + raw_json 不含 orig_group_no
//   R3  getMaxBocFxOrigGroupNo：空表 0 / 有数据取最大（CAST INTEGER 防字符串比较 '10'<'9'）
//   R4  writeBocFxLinkGroupRematch：按 id 回写 group_no/allocation_no + raw_json；不碰 orig_group_no/recon_link_id
//   R5  🔴 合并等价性：分两次导入 ≡ 一次大文件导入（BOC 表调拨单号/链接ID byte 等价；组号聚类等价）
//   R6  🔴 「重置-重匹配」两次幂等：同输入跑两次库内容一致
//   R7  🔴 同日同金额一对一消耗不重复（跨文件组只消耗一次）
//   R8  OPEN-3 migration：ensureBocFxLinkSupport 清空两张派生表 + 加 orig_group_no + transaction_no UNIQUE
//
// 端到端 helper deriveFxToBoc 复刻 main.js fx 派生块编排（scan offset → upsert → readForRematch → rematch →
//   writeGroupRematch → 2.4 buildBocBankRows/replaceBocBankDeposit → 2.5 backfill/writeReconIds），用真实仓储 + builder。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');
const { ensureBocFxLinkSupport } = require('../../../../src/backend/database/migrations');
const {
  scanFxGroups,
  rematchAllBocGroups,
  buildBocBankRows,
  backfillBocReconLinkIds
} = require('../../../../src/main-process/boc-fx-link-builder');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boc-rematch-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 造交割表对象行（fx reader 产物形态：中文表头）。
function fxRow(o = {}) {
  return Object.assign({ '交易编号': '', '货币1金额': '', '货币2金额': '', '到期日': '' }, o);
}

// 端到端复刻 main.js fx 派生块编排：导入「一个文件」(objects+rowNumbers) 触发全量重算。
//   midRows = 中台调拨订单行（matchBocToMidAllocation 候选）；banksRaw = 已落库 bank-deposit 的 BOC 候选（2.4/2.5 用）。
function deriveFxToBoc({ objects, rowNumbers }, midRows, bankCandidates) {
  const groupOffset = appDb.getMaxBocFxOrigGroupNo();
  const scan = scanFxGroups({ objects, rowNumbers, offset: groupOffset });
  appDb.upsertBocFxLink(scan.rows);
  const allRows = appDb.readBocFxLinkRowsForRematch();
  rematchAllBocGroups(allRows, Array.isArray(midRows) ? midRows : []);
  appDb.writeBocFxLinkGroupRematch(allRows);
  // 2.4
  const bankBuild = buildBocBankRows(Array.isArray(bankCandidates) ? bankCandidates : []);
  appDb.replaceBocBankDeposit(bankBuild.rows);
  // 2.5
  const linkWithIds = appDb.readBocFxLinkRowsWithIds();
  const backfill = backfillBocReconLinkIds(linkWithIds, bankBuild.rows);
  appDb.writeBocFxLinkReconIds(backfill.rows);
  return { scan, backfill };
}

// 读 BOC 表「业务视图」用于等价性比较：按 transaction_no 排序（消除 id/组号绝对值差异），
//   取 调拨单号 / 链接ID（资金红线值）+ 组聚类签名（同组的交易编号集合）。
function bocBusinessView() {
  const rows = db.prepare(
    'SELECT transaction_no, group_no, allocation_no, recon_link_id FROM linked_boc_fx_settlement ORDER BY transaction_no ASC'
  ).all();
  // 按交易编号取调拨单号/链接ID（资金值 byte 等价口径）。
  const byTxn = rows.map((r) => ({ txn: r.transaction_no, alloc: r.allocation_no, rid: r.recon_link_id }));
  // 组聚类签名：组号 → 排序后的交易编号集合（组号绝对值不比，只比「哪些交易编号在同一组」）。
  const groups = new Map();
  for (const r of rows) {
    const g = r.group_no || '';
    if (g === '') continue; // 2.2 剔除行不进任何组
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r.transaction_no);
  }
  const clusters = [...groups.values()].map((arr) => arr.slice().sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { byTxn, clusters };
}

test.describe('linked-table-boc-rematch — upsertBocFxLink', () => {
  test('R1：新键追加 + 同键覆盖 id 不变 + orig_group_no 写入 + 空键拒入', () => {
    // 首批：交易编号 100(组1)/101(组1)；scan 产物形态（含辅助键）
    const scan1 = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '到期日': '2026-05-04' }), fxRow({ '交易编号': '101', '到期日': '2026-05-04' })],
      rowNumbers: [3, 4]
    });
    const r1 = appDb.upsertBocFxLink(scan1.rows);
    assert.equal(r1.upserted, 2);
    assert.equal(r1.overwriteCount, 0, '首批无覆盖');
    const after1 = db.prepare('SELECT id, transaction_no, group_no, orig_group_no FROM linked_boc_fx_settlement ORDER BY id ASC').all();
    assert.equal(after1.length, 2);
    assert.deepEqual(after1.map((r) => r.transaction_no), ['100', '101']);
    assert.deepEqual(after1.map((r) => r.orig_group_no), ['1', '1'], 'orig_group_no = scan 组号');
    const id100 = after1.find((r) => r.transaction_no === '100').id;

    // 二批：交易编号 100（重复键，offset 后组2）+ 200（新键）
    const offset = appDb.getMaxBocFxOrigGroupNo();
    assert.equal(offset, 1, 'offset = 现有最大 orig_group_no');
    const scan2 = scanFxGroups({
      objects: [fxRow({ '交易编号': '100', '到期日': '2026-05-05' }), fxRow({ '交易编号': '200', '到期日': '2026-05-05' })],
      rowNumbers: [3, 4],
      offset
    });
    const r2 = appDb.upsertBocFxLink(scan2.rows);
    assert.equal(r2.overwriteCount, 1, '交易编号 100 同键覆盖 1 次');
    const after2 = db.prepare('SELECT id, transaction_no, orig_group_no FROM linked_boc_fx_settlement ORDER BY id ASC').all();
    assert.equal(after2.length, 3, '100 覆盖 + 101 保留 + 200 追加 = 3 行');
    const row100 = after2.find((r) => r.transaction_no === '100');
    assert.equal(row100.id, id100, '🔴 同键覆盖 id 不变（行序稳定）');
    assert.equal(row100.orig_group_no, '2', '同键覆盖 orig_group_no 更新为二批续编值（后者覆盖前者）');
  });

  test('R1b：空交易编号 upsert 拒入 + 计数', () => {
    // scan 已过滤空交易编号行，这里直接喂含空 __txnNo 的行测仓储双保险
    const ret = appDb.upsertBocFxLink([
      { '交易编号': '100', __txnNo: '100', '分组': '1', __origGroup: '1' },
      { '交易编号': '', __txnNo: '', '分组': '2', __origGroup: '2' }
    ]);
    assert.equal(ret.upserted, 1, '仅 1 行有效');
    assert.equal(ret.rejectedEmptyCount, 1, '空键拒入计数');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM linked_boc_fx_settlement').get().c, 1);
  });

  // C1（codex review / 用户 2026-06-15 拍板：文件边界 = 组边界，一笔 BOC 调拨不跨导出文件）：
  //   两个「无 footer/合计行」的裸文件，各 1 行（交易编号 100 / 101）分别 scan（offset 续编）→ 必须落为 2 个独立 orig_group。
  //   防回归：若误把跨文件同段判成一组（如把 offset 续编去掉、或按全库物理行号续扫），100+101 会坍缩成一组。
  test('C1：两个无 footer 裸文件分别 scan(offset 续编) → 2 个独立 orig_group（文件=组边界）', () => {
    // 文件1：单行 [100]（无 footer，scan 内组号 1）
    const scan1 = scanFxGroups({ objects: [fxRow({ '交易编号': '100', '到期日': '2026-05-04' })], rowNumbers: [3] });
    appDb.upsertBocFxLink(scan1.rows);
    // 文件2：单行 [101]（无 footer，offset 续编 → 组号 2）
    const offset = appDb.getMaxBocFxOrigGroupNo();
    assert.equal(offset, 1, '文件1 落库后最大 orig_group=1');
    const scan2 = scanFxGroups({ objects: [fxRow({ '交易编号': '101', '到期日': '2026-05-04' })], rowNumbers: [3], offset });
    appDb.upsertBocFxLink(scan2.rows);

    const rows = db.prepare('SELECT transaction_no, orig_group_no FROM linked_boc_fx_settlement ORDER BY transaction_no ASC').all();
    assert.equal(rows.length, 2);
    const og100 = rows.find((r) => r.transaction_no === '100').orig_group_no;
    const og101 = rows.find((r) => r.transaction_no === '101').orig_group_no;
    assert.equal(og100, '1', '文件1 交易编号 100 → orig_group 1');
    assert.equal(og101, '2', '文件2 交易编号 101 → orig_group 2');
    assert.notEqual(og100, og101, '🔴 两裸文件落为 2 个独立 orig_group（文件=组边界，BOC 调拨不跨文件）');
  });
});

test.describe('linked-table-boc-rematch — read/write/max 原子操作', () => {
  test('R2：readBocFxLinkRowsForRematch 注入 __origGroup + id ASC + raw_json 不含 orig_group_no', () => {
    const scan = scanFxGroups({ objects: [fxRow({ '交易编号': '100' }), fxRow({ '交易编号': '200' })], rowNumbers: [3, 4] });
    appDb.upsertBocFxLink(scan.rows);
    const list = appDb.readBocFxLinkRowsForRematch();
    assert.equal(list.length, 2);
    assert.ok(list[0].id < list[1].id, '按 id ASC');
    assert.equal(list[0].row.__origGroup, '1', '注入 __origGroup 辅助键');
    // raw_json 不含 orig_group_no 业务字段（orig_group_no 只在 DB 热列）
    const rawJson = db.prepare('SELECT raw_json FROM linked_boc_fx_settlement ORDER BY id ASC').get().raw_json;
    assert.ok(!('orig_group_no' in JSON.parse(rawJson)), 'raw_json 不含 orig_group_no');
    assert.ok(!('__origGroup' in JSON.parse(rawJson)), 'raw_json 不含 __origGroup 辅助键');
  });

  test('R3：getMaxBocFxOrigGroupNo 空表 0 / CAST 防字符串比较（10 > 9）', () => {
    assert.equal(appDb.getMaxBocFxOrigGroupNo(), 0, '空表 → 0');
    // 直接造 10 个组（orig_group_no 1..10）验证 '10' > '9'（字符串比较会错判 '9' 大）
    const objs = [];
    const rn = [];
    for (let i = 1; i <= 10; i += 1) {
      objs.push(fxRow({ '交易编号': String(1000 + i) }), fxRow({ '交易编号': '合计' }));
      rn.push(3 + (i - 1) * 2, 4 + (i - 1) * 2);
    }
    appDb.upsertBocFxLink(scanFxGroups({ objects: objs, rowNumbers: rn }).rows);
    assert.equal(appDb.getMaxBocFxOrigGroupNo(), 10, '🔴 CAST INTEGER → 10（非字符串比较的 9）');
  });

  test('R4：writeBocFxLinkGroupRematch 按 id 回写 group_no/allocation_no + raw_json，不碰 orig_group_no/recon_link_id', () => {
    const scan = scanFxGroups({ objects: [fxRow({ '交易编号': '100' })], rowNumbers: [3] });
    appDb.upsertBocFxLink(scan.rows);
    // 先模拟 2.5 写入 recon_link_id
    const wi = appDb.readBocFxLinkRowsWithIds();
    wi[0].row['资金对账不平表链接ID'] = 'RID-KEEP';
    appDb.writeBocFxLinkReconIds(wi);
    // rematch 回写：改组号 + 调拨单号
    const list = appDb.readBocFxLinkRowsForRematch();
    list[0].row['分组'] = '7';
    list[0].row['调拨单号'] = 'ALLOC-X';
    appDb.writeBocFxLinkGroupRematch(list);
    const dbRow = db.prepare('SELECT group_no, allocation_no, recon_link_id, orig_group_no, raw_json FROM linked_boc_fx_settlement').get();
    assert.equal(dbRow.group_no, '7', 'group_no 回写');
    assert.equal(dbRow.allocation_no, 'ALLOC-X', 'allocation_no 回写');
    assert.equal(dbRow.recon_link_id, 'RID-KEEP', '🔴 recon_link_id 不被 rematch 回写覆盖');
    assert.equal(dbRow.orig_group_no, '1', '🔴 orig_group_no 不被 rematch 回写改写');
    const obj = JSON.parse(dbRow.raw_json);
    assert.equal(obj['分组'], '7', 'raw_json 分组同步');
    assert.equal(obj['资金对账不平表链接ID'], 'RID-KEEP', 'raw_json 保留 2.5 链接ID');
    assert.ok(!('__origGroup' in obj), 'raw_json 剥 __origGroup');
  });

  // I2（codex review）：replaceBocFxLink 非生产路径（删除联动批次4 会用），须与新 schema 兼容——
  //   ① 喂重复 transaction_no 不报错（INSERT OR REPLACE last-wins，不撞 UNIQUE）；② orig_group_no 落列非 NULL（从 __origGroup 取/回退「分组」）。
  test('I2：replaceBocFxLink 喂重复 transaction_no last-wins 不报错 + orig_group_no 非 NULL', () => {
    const mk = (txn, group, alloc) => ({
      '交易编号': txn, '到期日': '2026-05-04', '分组': group, '调拨单号': alloc, '资金对账不平表链接ID': '',
      __txnNo: txn, __maturityIso: '2026-05-04', __sourceRow: 3, __origGroup: group
    });
    // 同批含重复 transaction_no '100'（组1 alloc A / 组2 alloc B）+ 一行无 __origGroup（回退「分组」）
    const noOrig = { '交易编号': '200', '到期日': '2026-05-04', '分组': '3', '调拨单号': '', '资金对账不平表链接ID': '', __txnNo: '200', __maturityIso: '2026-05-04', __sourceRow: 4 };
    assert.doesNotThrow(() => appDb.replaceBocFxLink([mk('100', '1', 'A'), mk('100', '2', 'B'), noOrig]), '🔴 重复 transaction_no 不撞 UNIQUE');
    const rows = db.prepare('SELECT transaction_no, group_no, allocation_no, orig_group_no FROM linked_boc_fx_settlement ORDER BY transaction_no ASC').all();
    assert.equal(rows.length, 2, 'last-wins：重复键去重后 100/200 共 2 行');
    const r100 = rows.find((r) => r.transaction_no === '100');
    assert.equal(r100.allocation_no, 'B', '🔴 last-wins：后者（组2 alloc B）覆盖前者');
    assert.equal(r100.orig_group_no, '2', 'orig_group_no = 后者 __origGroup');
    const r200 = rows.find((r) => r.transaction_no === '200');
    assert.equal(r200.orig_group_no, '3', '🔴 无 __origGroup 回退「分组」→ orig_group_no 非 NULL');
    // 落库后可被 rematch 正常读出 __origGroup（防组聚类坍缩）
    const list = appDb.readBocFxLinkRowsForRematch();
    assert.ok(list.every((it) => it.row.__origGroup !== ''), '🔴 replaceBocFxLink 写入行 rematch 读出 __origGroup 非空（组聚类不坍缩）');
  });

  // I2b：保持既有 UT-BOC-3/5 语义——空键拒入（replaceBocFxLink 升级后空 transaction_no 跳过）
  test('I2b：replaceBocFxLink 空交易编号拒入（不落库空键行）', () => {
    const valid = { '交易编号': '100', '分组': '1', __txnNo: '100', __origGroup: '1' };
    const empty = { '交易编号': '', '分组': '2', __txnNo: '', __origGroup: '2' };
    const ret = appDb.replaceBocFxLink([valid, empty]);
    assert.equal(ret.rowCount, 1, '空键拒入 → 仅 1 行落库');
    assert.equal(ret.written, 1, 'written=1');
  });
});

test.describe('linked-table-boc-rematch — 🔴 合并等价性 + 幂等 + 一对一消耗', () => {
  // 🔴 合并等价性前提（C1 / 用户 2026-06-15 拍板）：各文件含 footer/合计行（生成日期行，真实导出文件均有）作组分隔，
  //   故「文件边界 = 组边界」——BOC 调拨不跨导出文件。本组用例的大文件 fixture 用「合计行」分隔两段（模拟两文件各自的 footer），
  //   等价于「分两次导入两个各带 footer 的文件」。若文件无 footer（裸文件），文件边界仍由 offset 续编保证（见上方 C1 案）。
  // 中台候选：组A（汇总30，05-04）一笔 / 单行组（50，05-05）一笔
  const mids = [
    { '调拨单号': 'GRP30', '付款渠道': 'BOC', '收款金额': '30', '交易时间': '2026-05-04' },
    { '调拨单号': 'SOLO50', '付款渠道': 'BOC', '收款金额': '50', '交易时间': '2026-05-05' }
  ];
  // 银行候选（2.5 链接ID 来源）：银行单交易编号 = 交易编号
  function bankCand(txn, rid) {
    return {
      Channel: 'BOC', '地区': 'CN', Currency: 'USD', 'Credit Amount': '0',
      ReconciliationId: rid, BillDate: '2026-05-04', 'Payment Detail': `无折存款借记交易 ${txn}`
    };
  }
  const banks = [bankCand('100', 'RID100'), bankCand('101', 'RID101'), bankCand('300', 'RID300'), bankCand('301', 'RID301')];

  // 大文件：组1=[100,101]（10+20=30，05-04，走 2.3 组汇总），合计行分隔，组2=[300,301]（25+25=50，05-05，走 2.3 组汇总）。
  //   两组均为多行（单行金额 != 候选金额 → 不被 2.2 剔除）→ 纯走 2.3 组汇总命中，便于断言调拨单号绝对值。
  const bigObjects = [
    fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' }),
    fxRow({ '交易编号': '101', '货币2金额': '20', '到期日': '2026-05-04' }),
    fxRow({ '交易编号': '合计' }),
    fxRow({ '交易编号': '300', '货币2金额': '25', '到期日': '2026-05-05' }),
    fxRow({ '交易编号': '301', '货币2金额': '25', '到期日': '2026-05-05' })
  ];
  const bigRowNumbers = [3, 4, 5, 6, 7];

  test('R5：分两次导入 ≡ 一次大文件导入（调拨单号/链接ID byte 等价 + 组聚类等价）', () => {
    // —— 路径 A：一次大文件 ——
    appDb.replaceLinkedTable('bank-deposit', banks, {}); // 落库 BOC 候选供 2.4/2.5
    deriveFxToBoc({ objects: bigObjects, rowNumbers: bigRowNumbers }, mids, appDb.readBankDepositBocCandidates());
    const viewBig = bocBusinessView();

    // 重置 BOC 表（清空，模拟另一台干净库）
    db.prepare('DELETE FROM linked_boc_fx_settlement').run();
    db.prepare('DELETE FROM linked_boc_bank_deposit').run();

    // —— 路径 B：分两次（文件1=组1[100,101]，文件2=组2[300,301]）——
    deriveFxToBoc({
      objects: [
        fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '101', '货币2金额': '20', '到期日': '2026-05-04' })
      ],
      rowNumbers: [3, 4]
    }, mids, appDb.readBankDepositBocCandidates());
    deriveFxToBoc({
      objects: [
        fxRow({ '交易编号': '300', '货币2金额': '25', '到期日': '2026-05-05' }),
        fxRow({ '交易编号': '301', '货币2金额': '25', '到期日': '2026-05-05' })
      ],
      rowNumbers: [3, 4]
    }, mids, appDb.readBankDepositBocCandidates());
    const viewSplit = bocBusinessView();

    // 🔴 资金值 byte 等价：每个交易编号的调拨单号 + 链接ID 完全一致
    assert.deepEqual(viewSplit.byTxn, viewBig.byTxn, '🔴 调拨单号/链接ID byte 等价（分两次 ≡ 一次大文件）');
    // 组聚类等价（哪些交易编号在同一组）
    assert.deepEqual(viewSplit.clusters, viewBig.clusters, '🔴 组聚类等价');
    // 具体值校验：组1 [100,101]→GRP30；组2 [300,301]→SOLO50（均走 2.3 组汇总）
    assert.equal(viewSplit.byTxn.find((b) => b.txn === '100').alloc, 'GRP30', '组1 调拨单号 GRP30');
    assert.equal(viewSplit.byTxn.find((b) => b.txn === '101').alloc, 'GRP30', '组1 行2 同组同单号');
    assert.equal(viewSplit.byTxn.find((b) => b.txn === '300').alloc, 'SOLO50', '组2 调拨单号 SOLO50');
    assert.equal(viewSplit.byTxn.find((b) => b.txn === '301').alloc, 'SOLO50', '组2 行2 同组同单号');
    // 链接ID 命中（2.5 按交易编号 ↔ 银行单交易编号）
    assert.equal(viewSplit.byTxn.find((b) => b.txn === '100').rid, 'RID100', '100 链接ID 命中');
    assert.equal(viewSplit.byTxn.find((b) => b.txn === '300').rid, 'RID300', '300 链接ID 命中');
  });

  test('R6：「重置-重匹配」两次幂等（同文件重复导入库内容一致）', () => {
    appDb.replaceLinkedTable('bank-deposit', banks, {});
    deriveFxToBoc({ objects: bigObjects, rowNumbers: bigRowNumbers }, mids, appDb.readBankDepositBocCandidates());
    const v1 = bocBusinessView();
    const cnt1 = db.prepare('SELECT COUNT(*) AS c FROM linked_boc_fx_settlement').get().c;
    // 再导入同一文件（幂等：行数不变、调拨单号/链接ID 一致）
    deriveFxToBoc({ objects: bigObjects, rowNumbers: bigRowNumbers }, mids, appDb.readBankDepositBocCandidates());
    const v2 = bocBusinessView();
    const cnt2 = db.prepare('SELECT COUNT(*) AS c FROM linked_boc_fx_settlement').get().c;
    assert.equal(cnt2, cnt1, '🔴 同文件重导行数不变（幂等 upsert）');
    assert.deepEqual(v2.byTxn, v1.byTxn, '🔴 调拨单号/链接ID 幂等一致');
    assert.deepEqual(v2.clusters, v1.clusters, '🔴 组聚类幂等一致');
  });

  test('R7：同日同金额一对一消耗不重复（两组同日同额，1 候选只消耗 1 次）', () => {
    // 组1[100,101]=30(05-04)，组2[300,301]=30(05-04) 同日同额；仅 1 个中台 30 候选
    const mids1 = [{ '调拨单号': 'ONCE30', '付款渠道': 'BOC', '收款金额': '30', '交易时间': '2026-05-04' }];
    deriveFxToBoc({
      objects: [
        fxRow({ '交易编号': '100', '货币2金额': '10', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '101', '货币2金额': '20', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '合计' }),
        fxRow({ '交易编号': '300', '货币2金额': '10', '到期日': '2026-05-04' }),
        fxRow({ '交易编号': '301', '货币2金额': '20', '到期日': '2026-05-04' })
      ],
      rowNumbers: [3, 4, 5, 6, 7]
    }, mids1, []);
    const allocs = db.prepare("SELECT transaction_no, allocation_no FROM linked_boc_fx_settlement ORDER BY transaction_no ASC").all();
    const filled = allocs.filter((a) => a.allocation_no !== '');
    assert.equal(filled.length, 2, '🔴 仅一组（2 行）被回填，候选只消耗一次');
    assert.ok(filled.every((a) => a.allocation_no === 'ONCE30'));
  });
});

test.describe('linked-table-boc-rematch — OPEN-3 migration 清空两表', () => {
  test('R8：ensureBocFxLinkSupport 加 orig_group_no 时清空两张派生表 + 建 UNIQUE', () => {
    // 裸库：建 v3.0.4 旧结构（无 orig_group_no）→ 写入旧数据 → 跑迁移 → 应清空 + 加列 + UNIQUE
    const mTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boc-mig-open3-'));
    const mDb = new DatabaseSync(path.join(mTmp, 'm.sqlite'));
    try {
      // 模拟 v3.0.4 旧表（无 orig_group_no、无 UNIQUE）
      mDb.exec(`CREATE TABLE linked_boc_fx_settlement (
        id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_no TEXT, group_no TEXT, allocation_no TEXT,
        recon_link_id TEXT, maturity_date TEXT, source_row INTEGER, raw_json TEXT NOT NULL, imported_at TEXT NOT NULL);`);
      mDb.exec(`CREATE TABLE linked_boc_bank_deposit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bank_txn_no TEXT, reconciliation_id TEXT, bill_date TEXT,
        raw_json TEXT NOT NULL, imported_at TEXT NOT NULL);`);
      mDb.prepare('INSERT INTO linked_boc_fx_settlement (transaction_no, group_no, raw_json, imported_at) VALUES (?,?,?,?)')
        .run('OLD', '1', '{"交易编号":"OLD"}', '2026-05-04T00:00:00.000Z');
      mDb.prepare('INSERT INTO linked_boc_bank_deposit (bank_txn_no, raw_json, imported_at) VALUES (?,?,?)')
        .run('OLDBANK', '{"银行单交易编号":"OLDBANK"}', '2026-05-04T00:00:00.000Z');

      ensureBocFxLinkSupport(mDb);

      // 清空两表
      assert.equal(mDb.prepare('SELECT COUNT(*) AS c FROM linked_boc_fx_settlement').get().c, 0, '🔴 OPEN-3 清空 fx 派生表');
      assert.equal(mDb.prepare('SELECT COUNT(*) AS c FROM linked_boc_bank_deposit').get().c, 0, '🔴 OPEN-3 清空 bank 派生表');
      // orig_group_no 列存在
      const cols = mDb.prepare("PRAGMA table_info('linked_boc_fx_settlement')").all().map((c) => c.name);
      assert.ok(cols.includes('orig_group_no'), '加 orig_group_no 列');
      // UNIQUE 索引存在
      const idx = mDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='linked_boc_fx_settlement'").all().map((r) => r.name);
      assert.ok(idx.includes('idx_linked_boc_fx_settlement_txn_uniq'), 'transaction_no UNIQUE 索引');

      // 幂等：再跑一次不报错、不再清空（此时无数据可清）
      mDb.prepare('INSERT INTO linked_boc_fx_settlement (transaction_no, group_no, orig_group_no, raw_json, imported_at) VALUES (?,?,?,?,?)')
        .run('NEW', '1', '1', '{"交易编号":"NEW"}', '2026-05-04T00:00:00.000Z');
      assert.doesNotThrow(() => ensureBocFxLinkSupport(mDb));
      assert.equal(mDb.prepare('SELECT COUNT(*) AS c FROM linked_boc_fx_settlement').get().c, 1, '🔴 幂等：二次迁移不清空新数据');

      // UNIQUE 生效：插重复 transaction_no 抛错
      assert.throws(() => mDb.prepare('INSERT INTO linked_boc_fx_settlement (transaction_no, group_no, orig_group_no, raw_json, imported_at) VALUES (?,?,?,?,?)')
        .run('NEW', '2', '2', '{"交易编号":"NEW"}', '2026-05-04T00:00:00.000Z'), 'transaction_no UNIQUE 阻止重复');
    } finally {
      try { mDb.close(); } catch (_e) { /* ignore */ }
      fs.rmSync(mTmp, { recursive: true, force: true });
    }
  });

  // I3（codex review 真 bug）：半迁移态自愈——库已有 orig_group_no 列但缺 UNIQUE 索引（上次启动加列成功但建 UNIQUE 前崩）。
  //   旧实现把建 UNIQUE 绑在 hasColumn(orig_group_no) 守卫内 → 此态下跳过整块 → UNIQUE 永不补建 → upsertBocFxLink 的
  //   ON CONFLICT(transaction_no) 运行时报错。修复：UNIQUE 用独立 PRAGMA index_list 守卫，缺则补建。
  test('I3：半迁移态（有 orig_group_no 列、无 UNIQUE 索引）→ 再跑 ensureBocFxLinkSupport 补建 UNIQUE（自愈）', () => {
    const mTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boc-mig-i3-'));
    const mDb = new DatabaseSync(path.join(mTmp, 'm.sqlite'));
    try {
      // 构造半迁移态：建表「已含 orig_group_no 列」但「无 idx_..._txn_uniq UNIQUE 索引」（普通索引在，模拟 v3.0.4 残留）。
      mDb.exec(`CREATE TABLE linked_boc_fx_settlement (
        id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_no TEXT, group_no TEXT, allocation_no TEXT,
        recon_link_id TEXT, maturity_date TEXT, source_row INTEGER, orig_group_no TEXT, raw_json TEXT NOT NULL, imported_at TEXT NOT NULL);`);
      mDb.exec(`CREATE TABLE linked_boc_bank_deposit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bank_txn_no TEXT, reconciliation_id TEXT, bill_date TEXT,
        raw_json TEXT NOT NULL, imported_at TEXT NOT NULL);`);
      mDb.exec('CREATE INDEX idx_linked_boc_fx_settlement_txn ON linked_boc_fx_settlement(transaction_no);'); // 普通索引（非 UNIQUE）

      // 前置确认：UNIQUE 索引此刻不存在
      const idxBefore = mDb.prepare("PRAGMA index_list('linked_boc_fx_settlement')").all().map((i) => i.name);
      assert.ok(!idxBefore.includes('idx_linked_boc_fx_settlement_txn_uniq'), '前置：半迁移态无 UNIQUE 索引');

      // 关键：hasColumn(orig_group_no) 此刻判 true（列已存在）→ 旧实现会跳过整块；修复后 UNIQUE 独立守卫补建。
      ensureBocFxLinkSupport(mDb);

      const idxAfter = mDb.prepare("PRAGMA index_list('linked_boc_fx_settlement')").all();
      const uniqIdx = idxAfter.find((i) => i.name === 'idx_linked_boc_fx_settlement_txn_uniq');
      assert.ok(uniqIdx, '🔴 自愈：半迁移态再跑后 transaction_no UNIQUE 索引已补建');
      assert.equal(uniqIdx.unique, 1, '🔴 补建的是 UNIQUE 索引（unique=1）');

      // UNIQUE 真生效：ON CONFLICT(transaction_no) 可用（upsertBocFxLink 不再运行时报错）
      const appDb2 = new AppDatabase(path.join(mTmp, 'unused.sqlite'));
      appDb2.db = mDb; // 复用半迁移态库
      assert.doesNotThrow(() => appDb2.upsertBocFxLink([
        { '交易编号': '100', __txnNo: '100', '分组': '1', __origGroup: '1' },
        { '交易编号': '100', __txnNo: '100', '分组': '2', __origGroup: '2' } // 同键覆盖（验 ON CONFLICT 生效）
      ]), '🔴 UNIQUE 补建后 upsertBocFxLink 的 ON CONFLICT 不报错');
      assert.equal(mDb.prepare('SELECT COUNT(*) AS c FROM linked_boc_fx_settlement').get().c, 1, '同键覆盖 → 1 行');
    } finally {
      try { mDb.close(); } catch (_e) { /* ignore */ }
      fs.rmSync(mTmp, { recursive: true, force: true });
    }
  });
});
