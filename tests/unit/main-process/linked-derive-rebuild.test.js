// v3.0.5 批次4（T6b-1）：链接表派生重建共享编排函数单测（🔴🔴 资金红线 parity）。
//
// 验证目标：三个抽出的纯编排函数（rebuildAdmDerivation / rebuildBankDepositBocDerivation / rebuildFxBocDerivation）
//   产物结构与旧内联（src/main.js 导入 handler）字节一致——这是「导入行为字节不变」的 parity 锁之一。
//
// 测试策略：
//   · rebuildAdmDerivation / rebuildBankDepositBocDerivation：mock database + mock builder（验证编排骨架与产物字段，
//     builder 自身逻辑由 boc-fx-link-builder.test.js / adm-bank-deposit-builder 单测各自锁定）。
//   · rebuildFxBocDerivation：用【真实】rematchAllBocGroups / buildBocBankRows / backfillBocReconLinkIds（复用 builder 夹具），
//     仅 mock database 读写——验证重匹配重编号 + 2.4 + 2.5 + 统计的端到端编排正确。
//
// 🔴 不变量：reconIdFixResult=null / processingResult=null 不在共享函数内（留 caller）——函数内绝不出现这两个赋值
//   （本测试通过「函数无副作用泄漏到外部全局」隐式保证：deps 不含这两个变量，函数无法触及）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  rebuildAdmDerivation,
  rebuildBankDepositBocDerivation,
  rebuildFxBocDerivation,
  rebuildFundTransferReconDerivation
} = require('../../../src/main-process/linked-derive-rebuild');

// 真实 builder（rebuildFxBocDerivation 端到端用）
const {
  rematchAllBocGroups,
  buildBocBankRows,
  backfillBocReconLinkIds,
  KEY_ORIG_GROUP
} = require('../../../src/main-process/boc-fx-link-builder');

// v3.0.6 需求1（T3）：调拨对账单派生端到端用真实 builder + 真实 in-memory AppDatabase。
const { buildFundTransferReconRows } = require('../../../src/main-process/fund-transfer-recon-builder');
const { AppDatabase } = require('../../../src/backend/database');
const { FT_RECON_FIELD_MAP } = require('../../../src/constants/fund-transfer-recon-fields');

// —— 工具：收集 appendActivityLogEntry 调用 ——
function makeLogSink() {
  const calls = [];
  const fn = (entry) => calls.push(entry);
  fn.calls = calls;
  return fn;
}

// ============================================================================
// 1) rebuildAdmDerivation
// ============================================================================
test.describe('rebuildAdmDerivation —— ADM 派生编排', () => {
  test('成功：admDerive 结构与旧内联字节一致（total/matched/unmatched 映射/midEmpty）', () => {
    const replaced = [];
    const database = {
      readLinkedTableRows: (key) => { assert.equal(key, 'mid-allocation'); return [{ '调拨单号': 'M1' }]; },
      readBankDepositAdmCandidates: () => [{ Channel: 'ADM', BizId: 'B1' }, { Channel: 'ADM', BizId: 'B2' }],
      replaceAdmBankDeposit: (rows) => { replaced.push(...rows); }
    };
    // mock buildAdmRows：2 行，其中 1 行 unmatched（含 conflict）。
    const buildAdmRows = (bankCands, midRows) => {
      assert.equal(bankCands.length, 2, '收到 ADM 候选');
      assert.equal(midRows.length, 1, '收到中台行');
      return {
        admRows: [{ '批次号': 'BN1' }, { '批次号': 'BN2' }],
        unmatched: [{
          code: 'NO_MATCH',
          row: { '批次号': 'BN2', CustomerRef: 'CR2', BillDate: '2026-05-04', ChannelOrderNo: 'CO2' },
          conflict: ['x', 'y']
        }],
        midEmpty: false
      };
    };

    const { admDerive } = rebuildAdmDerivation({ database, buildAdmRows });
    assert.equal(replaced.length, 2, 'replaceAdmBankDeposit 收到 admRows');
    assert.deepEqual(admDerive, {
      created: true,
      total: 2,
      matched: 1,
      unmatched: [{
        code: 'NO_MATCH',
        batchNo: 'BN2',
        customerRef: 'CR2',
        billDate: '2026-05-04',
        channelOrderNo: 'CO2',
        conflict: ['x', 'y']
      }],
      midEmpty: false
    }, '🔴 admDerive 字节一致');
  });

  test('unmatched 无 conflict → conflict 字段 undefined（与旧内联一致）', () => {
    const database = {
      readLinkedTableRows: () => [],
      readBankDepositAdmCandidates: () => [],
      replaceAdmBankDeposit: () => {}
    };
    const buildAdmRows = () => ({
      admRows: [{ '批次号': 'BN1' }],
      unmatched: [{ code: 'NO_MATCH', row: { '批次号': 'BN1', CustomerRef: '', BillDate: '', ChannelOrderNo: '' } }],
      midEmpty: true
    });
    const { admDerive } = rebuildAdmDerivation({ database, buildAdmRows });
    assert.equal(admDerive.unmatched[0].conflict, undefined, '无 conflict → undefined');
    assert.equal(admDerive.midEmpty, true);
  });

  test('候选空 → 重建空表不抛，admDerive.created:true total=0', () => {
    let replacedRows = null;
    const database = {
      readLinkedTableRows: () => [],
      readBankDepositAdmCandidates: () => [],
      replaceAdmBankDeposit: (rows) => { replacedRows = rows; }
    };
    const buildAdmRows = () => ({ admRows: [], unmatched: [], midEmpty: true });
    let ret;
    assert.doesNotThrow(() => { ret = rebuildAdmDerivation({ database, buildAdmRows }); });
    assert.deepEqual(replacedRows, [], '空候选 → replaceAdmBankDeposit([]) 重建空表');
    assert.equal(ret.admDerive.created, true);
    assert.equal(ret.admDerive.total, 0);
    assert.equal(ret.admDerive.matched, 0);
  });

  test('buildAdmRows 抛错 → created:false + error（不向外抛）', () => {
    const database = {
      readLinkedTableRows: () => [],
      readBankDepositAdmCandidates: () => [],
      replaceAdmBankDeposit: () => {}
    };
    const buildAdmRows = () => { throw new Error('boom-adm'); };
    let ret;
    assert.doesNotThrow(() => { ret = rebuildAdmDerivation({ database, buildAdmRows }); });
    assert.deepEqual(ret.admDerive, { created: false, error: 'boom-adm' });
  });

  test('replaceAdmBankDeposit 抛错 → created:false（写库失败也隔离）', () => {
    const database = {
      readLinkedTableRows: () => [],
      readBankDepositAdmCandidates: () => [{ Channel: 'ADM' }],
      replaceAdmBankDeposit: () => { throw new Error('db-write-fail'); }
    };
    const buildAdmRows = () => ({ admRows: [{ '批次号': 'BN1' }], unmatched: [], midEmpty: false });
    const { admDerive } = rebuildAdmDerivation({ database, buildAdmRows });
    assert.equal(admDerive.created, false);
    assert.equal(admDerive.error, 'db-write-fail');
  });
});

// ============================================================================
// 2) rebuildBankDepositBocDerivation
// ============================================================================
test.describe('rebuildBankDepositBocDerivation —— BOC bank 派生（2.4）+ 2.5 回填', () => {
  test('成功（有链接行）：bocBankDerive 结构与旧内联一致 + 2.5 回填 + 日志写入', () => {
    const log = makeLogSink();
    let replacedBank = null;
    let writtenReconIds = null;
    const database = {
      readBankDepositBocCandidates: () => [{ Channel: 'BOC' }],
      replaceBocBankDeposit: (rows) => { replacedBank = rows; },
      readBocFxLinkRowsWithIds: () => [{ id: 1, row: { '交易编号': '100' } }],
      writeBocFxLinkReconIds: (rows) => { writtenReconIds = rows; }
    };
    const buildBocBankRows = (cands) => {
      assert.equal(cands.length, 1);
      return { availability: 'ok', rows: [{ '银行单交易编号': '100' }, { '银行单交易编号': '200' }], logs: [{ level: 'info', message: 'bank-log' }] };
    };
    const backfillBocReconLinkIds = (linkRows, bankRows) => {
      assert.equal(linkRows.length, 1);
      assert.equal(bankRows.length, 2);
      return { rows: [{ id: 1, row: {} }], backfilled: 1, unlinkedCount: 0, logs: [{ level: 'warning', message: 'bf-log' }] };
    };

    const { bocBankDerive } = rebuildBankDepositBocDerivation({
      database, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry: log
    });
    assert.equal(replacedBank.length, 2, 'replaceBocBankDeposit 收到 bank rows');
    assert.deepEqual(writtenReconIds, [{ id: 1, row: {} }], '2.5 回填写回');
    assert.deepEqual(bocBankDerive, {
      created: true,
      bankRowCount: 2,
      backfilled: 1,
      unlinkedCount: 0
    }, '🔴 bocBankDerive 字节一致');
    // 日志：bank-log + bf-log 各写一条，domain=boc-dispatch-order-fix
    assert.equal(log.calls.length, 2);
    assert.equal(log.calls[0].message, 'bank-log');
    assert.equal(log.calls[0].domain, 'boc-dispatch-order-fix');
    assert.equal(log.calls[1].message, 'bf-log');
    assert.equal(log.calls[1].level, 'warning');
  });

  test('无链接行（BOC链接表空）→ 跳过 2.5 回填，backfilled/unlinkedCount=0', () => {
    const log = makeLogSink();
    let writeReconCalled = false;
    const database = {
      readBankDepositBocCandidates: () => [{ Channel: 'BOC' }],
      replaceBocBankDeposit: () => {},
      readBocFxLinkRowsWithIds: () => [], // 空 → 跳过 2.5
      writeBocFxLinkReconIds: () => { writeReconCalled = true; }
    };
    const buildBocBankRows = () => ({ availability: 'ok', rows: [{ x: 1 }], logs: [] });
    const backfillBocReconLinkIds = () => { throw new Error('should-not-call-backfill'); };

    const { bocBankDerive } = rebuildBankDepositBocDerivation({
      database, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry: log
    });
    assert.equal(writeReconCalled, false, '🔴 无链接行不调 writeBocFxLinkReconIds');
    assert.deepEqual(bocBankDerive, { created: true, bankRowCount: 1, backfilled: 0, unlinkedCount: 0 });
  });

  test('候选空（no-boc-rows）→ 重建空表不抛，bankRowCount=0', () => {
    const log = makeLogSink();
    let replaced = null;
    const database = {
      readBankDepositBocCandidates: () => [],
      replaceBocBankDeposit: (rows) => { replaced = rows; },
      readBocFxLinkRowsWithIds: () => [],
      writeBocFxLinkReconIds: () => {}
    };
    const buildBocBankRows = () => ({ availability: 'no-boc-rows', rows: [], logs: [] });
    const backfillBocReconLinkIds = () => { throw new Error('nope'); };
    let ret;
    assert.doesNotThrow(() => {
      ret = rebuildBankDepositBocDerivation({ database, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry: log });
    });
    assert.deepEqual(replaced, [], '空候选 → replaceBocBankDeposit([]) 重建空表');
    assert.deepEqual(ret.bocBankDerive, { created: true, bankRowCount: 0, backfilled: 0, unlinkedCount: 0 });
  });

  test('replaceBocBankDeposit 抛错 → created:false + error（隔离）', () => {
    const log = makeLogSink();
    const database = {
      readBankDepositBocCandidates: () => [{ Channel: 'BOC' }],
      replaceBocBankDeposit: () => { throw new Error('boc-bank-write-fail'); },
      readBocFxLinkRowsWithIds: () => [],
      writeBocFxLinkReconIds: () => {}
    };
    const buildBocBankRows = () => ({ availability: 'ok', rows: [{ x: 1 }], logs: [] });
    const backfillBocReconLinkIds = () => ({ rows: [], backfilled: 0, unlinkedCount: 0, logs: [] });
    const { bocBankDerive } = rebuildBankDepositBocDerivation({
      database, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry: log
    });
    assert.equal(bocBankDerive.created, false);
    assert.equal(bocBankDerive.error, 'boc-bank-write-fail');
  });
});

// ============================================================================
// 3) rebuildFxBocDerivation（真实 builder 端到端）
// ============================================================================
test.describe('rebuildFxBocDerivation —— fx 全量重匹配重编号 + 2.4 + 2.5 + 统计', () => {
  // 造 readBocFxLinkRowsForRematch 产物项（[{ id, row }]，row 含 orig_group_no + 业务字段）。
  function fxItem(id, { txnNo, origGroup, ccy2, maturity }) {
    const row = {
      '交易编号': txnNo,
      '货币2金额': ccy2 === undefined ? '' : ccy2,
      '到期日': maturity === undefined ? '' : maturity,
      __maturityIso: maturity === undefined ? '' : maturity,
      '分组': String(origGroup),
      '调拨单号': '',
      '资金对账不平表链接ID': ''
    };
    row[KEY_ORIG_GROUP] = String(origGroup);
    return { id, row };
  }
  function midRow(o = {}) {
    return Object.assign({ '调拨单号': '', '付款渠道': '', '收款金额': '', '交易时间': '' }, o);
  }

  // 组装一套 mock database（真实 builder 用）。
  function makeFxDb({ allRows, midRows = [], bankCandidates = [], linkWithIds = null }) {
    const captured = { written: null, replacedBank: null, reconWritten: null };
    const database = {
      readLinkedTableRows: (key) => { assert.equal(key, 'mid-allocation'); return midRows; },
      readBocFxLinkRowsForRematch: () => allRows, // rematch 原地改 allRows[].row
      writeBocFxLinkGroupRematch: (rows) => { captured.written = rows; },
      readBankDepositBocCandidates: () => bankCandidates,
      replaceBocBankDeposit: (rows) => { captured.replacedBank = rows; },
      // 2.5：readBocFxLinkRowsWithIds 默认复用 allRows（id+row），caller 用 linkWithIds 覆盖
      readBocFxLinkRowsWithIds: () => (linkWithIds !== null ? linkWithIds : allRows.map((it) => ({ id: it.id, row: it.row }))),
      writeBocFxLinkReconIds: (rows) => { captured.reconWritten = rows; }
    };
    return { database, captured };
  }

  const realDeps = (database, log) => ({
    database,
    rematchAllBocGroups,
    buildBocBankRows,
    backfillBocReconLinkIds,
    appendActivityLogEntry: log
  });

  test('重匹配重编号正确：orig_group_no 有空洞(5/9/3) → 分组重编号 1/2/3 写回 + 统计 total/groupCount/overwriteCount', () => {
    const log = makeLogSink();
    const allRows = [
      fxItem(10, { txnNo: '100', origGroup: 5, ccy2: '10', maturity: '2026-05-04' }),
      fxItem(11, { txnNo: '101', origGroup: 9, ccy2: '20', maturity: '2026-05-05' }),
      fxItem(12, { txnNo: '102', origGroup: 3, ccy2: '30', maturity: '2026-05-06' })
    ];
    const { database, captured } = makeFxDb({ allRows, midRows: [], bankCandidates: [], linkWithIds: [] });

    const { bocDerive } = rebuildFxBocDerivation(realDeps(database, log), {
      scanLogs: [{ level: 'info', message: 'scan-log' }],
      groupCount: 3,
      overwriteCount: 1
    });

    // 重编号写回（writeBocFxLinkGroupRematch 收到 rematch 后 allRows）
    assert.deepEqual(captured.written.map((it) => it.row['分组']), ['1', '2', '3'], '🔴 分组重编号 1..N 写回');
    assert.deepEqual(captured.written.map((it) => it.row[KEY_ORIG_GROUP]), ['5', '9', '3'], '🔴 orig_group_no 不改写');
    // 统计字段（caller 传入 groupCount/overwriteCount 透传；无 bank 候选 → needBankImport=true）
    assert.equal(bocDerive.created, true);
    assert.equal(bocDerive.total, 3, 'total = 全库行数');
    assert.equal(bocDerive.groupCount, 3, 'groupCount 来自 caller 透传');
    assert.equal(bocDerive.overwriteCount, 1, 'overwriteCount 来自 caller 透传');
    assert.equal(bocDerive.step22Removed, 0, '无 2.2 剔除');
    assert.equal(bocDerive.step23MatchedGroups, 0, '无中台 → 无回填');
    assert.equal(bocDerive.step23UnmatchedGroups, 3, '3 组均未回填');
    assert.equal(bocDerive.needBankImport, true, '无 bank 候选 → 需导入');
    assert.equal(bocDerive.bankMissingReason, 'no-boc-rows');
    // 日志：scan-log 在最前（caller 传入），随后 rematch / 无中台 info / bank build logs
    assert.equal(log.calls[0].message, 'scan-log', '🔴 scanLogs 在 allLogs 最前');
    assert.ok(log.calls.some((c) => c.message.indexOf('无中台调拨订单数据') >= 0), '无中台 info log 写入');
  });

  test('2.2 单行剔除 + 2.3 组汇总命中 → step22Removed/step23Matched 统计正确', () => {
    const log = makeLogSink();
    // org1=[100,101]（10+20=30）2.3 命中；org2=[200]（50）2.2 单行剔除（分组清空）。
    const allRows = [
      fxItem(1, { txnNo: '100', origGroup: 1, ccy2: '10', maturity: '2026-05-04' }),
      fxItem(2, { txnNo: '101', origGroup: 1, ccy2: '20', maturity: '2026-05-04' }),
      fxItem(3, { txnNo: '200', origGroup: 2, ccy2: '50', maturity: '2026-05-04' })
    ];
    const midRows = [
      midRow({ '调拨单号': 'G30', '付款渠道': 'BOC', '收款金额': '30', '交易时间': '2026-05-04' }),
      midRow({ '调拨单号': 'KILL', '付款渠道': 'BOC', '收款金额': '50', '交易时间': '2026-05-04' })
    ];
    const { database, captured } = makeFxDb({ allRows, midRows, bankCandidates: [], linkWithIds: [] });

    const { bocDerive } = rebuildFxBocDerivation(realDeps(database, log), {
      scanLogs: [], groupCount: 2, overwriteCount: 0
    });

    // org2 单行被 2.2 清空分组 → step22Removed=1；org1 命中调拨单号 → step23MatchedGroups=1。
    assert.equal(bocDerive.step22Removed, 1, '🔴 2.2 单行剔除计数');
    assert.equal(bocDerive.step23MatchedGroups, 1, '🔴 2.3 命中组数');
    assert.equal(bocDerive.step23UnmatchedGroups, 0, '剩余组均已回填');
    assert.equal(bocDerive.total, 3);
    // 写回的 org1 两行调拨单号 = G30
    assert.equal(captured.written[0].row['调拨单号'], 'G30', 'org1 回填调拨单号');
    assert.equal(captured.written[2].row['分组'], '', 'org2 分组清空');
  });

  test('2.4 有 BOC 银行候选 + 2.5 回填命中 → needBankImport=false + backfilled 计数', () => {
    const log = makeLogSink();
    const allRows = [
      fxItem(1, { txnNo: '100', origGroup: 1, ccy2: '10', maturity: '2026-05-04' })
    ];
    // BOC 银行候选：地区=CN ∧ Currency=USD ∧ Credit=0，Payment Detail 含关键词「无折存款借记交易」+ 数字串 100 → 银行单交易编号 100。
    const bankCandidates = [{
      Channel: 'BOC', '地区': 'CN', Currency: 'USD', 'Credit Amount': '0',
      ReconciliationId: 'RECON-100', 'Payment Detail': '无折存款借记交易 100', BillDate: '2026-05-04'
    }];
    const { database, captured } = makeFxDb({ allRows, midRows: [], bankCandidates, linkWithIds: null });

    const { bocDerive } = rebuildFxBocDerivation(realDeps(database, log), {
      scanLogs: [], groupCount: 1, overwriteCount: 0
    });

    assert.equal(bocDerive.needBankImport, false, '🔴 有可用 BOC 候选 → 不需导入');
    assert.equal(bocDerive.bankMissingReason, null);
    assert.equal(captured.replacedBank.length, 1, 'BOC 银行表派生 1 行');
    // 2.5：交易编号 100 命中银行单交易编号 100 → 资金对账不平表链接ID = RECON-100。
    assert.equal(bocDerive.backfilled, 1, '🔴 2.5 命中回填 1 行');
    assert.equal(bocDerive.unlinkedCount, 0);
    assert.equal(captured.reconWritten[0].row['资金对账不平表链接ID'], 'RECON-100', '链接ID 回填');
  });

  test('全空（无库行/无中台/无候选）→ 重建空表不抛 + needBankImport=true + total=0', () => {
    const log = makeLogSink();
    const { database, captured } = makeFxDb({ allRows: [], midRows: [], bankCandidates: [], linkWithIds: [] });
    let ret;
    assert.doesNotThrow(() => {
      ret = rebuildFxBocDerivation(realDeps(database, log), { scanLogs: [], groupCount: 0, overwriteCount: 0 });
    });
    assert.deepEqual(captured.replacedBank, [], '空候选 → 重建空 BOC 银行表');
    assert.equal(ret.bocDerive.created, true);
    assert.equal(ret.bocDerive.total, 0);
    assert.equal(ret.bocDerive.needBankImport, true);
    assert.equal(ret.bocDerive.bankMissingReason, 'no-boc-rows');
    // 无中台 info log 仍写
    assert.ok(log.calls.some((c) => c.message.indexOf('无中台调拨订单数据') >= 0));
  });

  test('readBocFxLinkRowsForRematch 抛错 → bocDerive.created:false + error（隔离，不向外抛）', () => {
    const log = makeLogSink();
    const database = {
      readLinkedTableRows: () => [],
      readBocFxLinkRowsForRematch: () => { throw new Error('rematch-read-fail'); },
      writeBocFxLinkGroupRematch: () => {},
      readBankDepositBocCandidates: () => [],
      replaceBocBankDeposit: () => {},
      readBocFxLinkRowsWithIds: () => [],
      writeBocFxLinkReconIds: () => {}
    };
    let ret;
    assert.doesNotThrow(() => {
      ret = rebuildFxBocDerivation(realDeps(database, log), { scanLogs: [], groupCount: 0, overwriteCount: 0 });
    });
    assert.equal(ret.bocDerive.created, false);
    assert.equal(ret.bocDerive.error, 'rematch-read-fail');
  });

  test('readLinkedTableRows(mid) 抛错 → 按无中台处理（不抛 + 跳 2.2/2.3）', () => {
    const log = makeLogSink();
    const allRows = [fxItem(1, { txnNo: '100', origGroup: 1, ccy2: '10', maturity: '2026-05-04' })];
    const database = {
      readLinkedTableRows: () => { throw new Error('mid-read-fail'); },
      readBocFxLinkRowsForRematch: () => allRows,
      writeBocFxLinkGroupRematch: () => {},
      readBankDepositBocCandidates: () => [],
      replaceBocBankDeposit: () => {},
      readBocFxLinkRowsWithIds: () => [],
      writeBocFxLinkReconIds: () => {}
    };
    let ret;
    assert.doesNotThrow(() => {
      ret = rebuildFxBocDerivation(realDeps(database, log), { scanLogs: [], groupCount: 1, overwriteCount: 0 });
    });
    assert.equal(ret.bocDerive.created, true, '🔴 mid 读失败按无中台处理，不阻断');
    assert.equal(ret.bocDerive.step23MatchedGroups, 0);
    assert.ok(log.calls.some((c) => c.message.indexOf('无中台调拨订单数据') >= 0), '走无中台分支 info log');
  });
});

// ============================================================================
// 4) rebuildFundTransferReconDerivation —— 调拨对账单派生（v3.0.6 需求1 T3，🔴 资金红线）
// ============================================================================
test.describe('rebuildFundTransferReconDerivation —— 调拨对账单派生编排', () => {
  const M = FT_RECON_FIELD_MAP.mid;
  const R = FT_RECON_FIELD_MAP.recon;

  // 构造一行中台调拨订单（中文真实表头；字段名经 FT_RECON_FIELD_MAP.mid 取，禁手敲全角括号）。
  function midRow(overrides = {}) {
    const base = {
      [M.allocationNo]: 'ALLOC-1',
      [M.status]: '付款成功',
      [M.txTime]: '2026-05-04',
      [M.channelSerial]: 'SERIAL-1',
      [M.payCard]: 'PAY-CARD-1',
      [M.payeeCard]: 'PAYEE-CARD-1',
      [M.receiveChannel]: 'DBS',
      [M.receiveAmount]: '2100000',
      [M.receiveCurrency]: 'USD',
      [M.payChannel]: 'CITI',
      [M.payAmount]: '2100000',
      [M.payCurrency]: 'HKD'
    };
    return { ...base, ...overrides };
  }

  // —— mock 编排骨架测试（仿 rebuildAdmDerivation 风格，验证读源→builder→replace 三步 + 产物字节）——
  test('成功：读 mid-allocation → builder → replace，fundTransferReconDerive={created:true,total}', () => {
    let readKey = null;
    let replacedRows = null;
    const database = {
      readLinkedTableRows: (key) => { readKey = key; return [{ '调拨单号': 'M1' }, { '调拨单号': 'M2' }]; },
      replaceFundTransferReconRows: (rows) => { replacedRows = rows; return { rowCount: rows.length }; }
    };
    // mock builder：一单 → 两行（与真实 builder 的「in/out」语义一致，但此处只验编排透传）。
    const fakeBuilder = (midRows) => {
      assert.equal(midRows.length, 2, '收到 mid-allocation 整行');
      return { rows: [{ r: 1 }, { r: 2 }, { r: 3 }, { r: 4 }], total: 4 };
    };

    const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({
      database, buildFundTransferReconRows: fakeBuilder
    });
    assert.equal(readKey, 'mid-allocation', "🔴 读 'mid-allocation' 表（big_account 派生源）");
    assert.equal(replacedRows.length, 4, 'replaceFundTransferReconRows 收到 builder.rows');
    assert.deepEqual(fundTransferReconDerive, { created: true, total: 4 }, '🔴 fundTransferReconDerive 字节一致（total = 派生行数）');
  });

  test('mid 为空 → 派生空表不抛，total=0', () => {
    let replacedRows = null;
    const database = {
      readLinkedTableRows: () => [],
      replaceFundTransferReconRows: (rows) => { replacedRows = rows; return { rowCount: rows.length }; }
    };
    let ret;
    assert.doesNotThrow(() => {
      ret = rebuildFundTransferReconDerivation({ database, buildFundTransferReconRows });
    });
    assert.deepEqual(replacedRows, [], '空 mid → replaceFundTransferReconRows([]) 重建空表');
    assert.equal(ret.fundTransferReconDerive.created, true);
    assert.equal(ret.fundTransferReconDerive.total, 0);
  });

  test('readLinkedTableRows 抛错 → created:false + error（隔离，不向外抛）', () => {
    const database = {
      readLinkedTableRows: () => { throw new Error('mid-read-fail'); },
      replaceFundTransferReconRows: () => { throw new Error('should-not-reach'); }
    };
    let ret;
    assert.doesNotThrow(() => {
      ret = rebuildFundTransferReconDerivation({ database, buildFundTransferReconRows });
    });
    assert.deepEqual(ret.fundTransferReconDerive, { created: false, error: 'mid-read-fail' }, '🔴 派生失败不阻断导入');
  });

  test('replaceFundTransferReconRows 抛错 → created:false（写库失败也隔离）', () => {
    const database = {
      readLinkedTableRows: () => [{ '调拨单号': 'M1' }],
      replaceFundTransferReconRows: () => { throw new Error('db-write-fail'); }
    };
    const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({
      database, buildFundTransferReconRows
    });
    assert.equal(fundTransferReconDerive.created, false);
    assert.equal(fundTransferReconDerive.error, 'db-write-fail');
  });

  // —— 端到端（真实 builder + 真实 in-memory AppDatabase）——
  test.describe('端到端（真实 builder + 真实 AppDatabase）', () => {
    let appDb;
    let tmpDir;

    test.beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftr-derive-'));
      appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
      appDb.init();
    });

    test.afterEach(() => {
      try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
      if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
    });

    test('导入 mid-allocation → 派生后 readFundTransferReconRows 行数 = mid 行数×2', () => {
      // 真实落 mid-allocation（链接表通用 replace；字段为中台中文表头）。
      appDb.replaceLinkedTable('mid-allocation', [midRow({ [M.allocationNo]: 'A1' }), midRow({ [M.allocationNo]: 'A2' }), midRow({ [M.allocationNo]: 'A3' })]);

      const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({
        database: appDb, buildFundTransferReconRows
      });

      const back = appDb.readFundTransferReconRows();
      assert.equal(back.length, 6, '🔴 3 行 mid → 6 行调拨对账单（每单 in/out 两行）');
      assert.equal(fundTransferReconDerive.created, true);
      assert.equal(fundTransferReconDerive.total, 6, 'total = mid 行数×2');
      // in 行（A1）：方向 / big_account=收款卡号 / 币种=收款币种；out 行：big_account=付款卡号 / 币种=付款币种。
      assert.equal(back[0][R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_IN);
      assert.equal(back[0][R.bigAccount], 'PAYEE-CARD-1', 'D1：in 行 big_account = 收款卡号');
      assert.equal(back[0][R.currency], 'USD');
      assert.equal(back[1][R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_OUT);
      assert.equal(back[1][R.bigAccount], 'PAY-CARD-1', 'D1：out 行 big_account = 付款卡号');
      assert.equal(back[1][R.currency], 'HKD', 'out 行币种取付款币种');
    });

    // v3.0.6 codex-pr74-fix P2（🔴 资金红线）：升级/空表场景回归锁。
    //   背景：建表迁移仅 CREATE TABLE linked_fund_transfer_recon 不回填；派生原仅在「导入 mid-allocation」时触发。
    //   叠加 → 已有 mid-allocation 但未重导的升级用户隐藏表恒空 → run 勾选路读空表静默不回填（真实回归）。
    //   修复：run 入口读取前实时重派生刷新持久表。本用例直接锁派生层契约 ——
    //   「mid-allocation 有数据 ∧ linked_fund_transfer_recon 为空（模拟升级建表后未派生）→ 调用后被正确回填（行数=mid×2）」。
    test('升级场景：mid 有数据但 recon 表为空 → 重派生后回填（行数 = mid×2）', () => {
      // 模拟升级用户：mid-allocation 已有数据（旧库既有），但 linked_fund_transfer_recon 仅被建表迁移创建、从未派生 → 空。
      appDb.replaceLinkedTable('mid-allocation', [
        midRow({ [M.allocationNo]: 'UP1' }),
        midRow({ [M.allocationNo]: 'UP2' })
      ]);
      // 前置断言：隐藏表当前为空（建表迁移只建表不回填 → 升级用户初始空）。
      assert.equal(appDb.readFundTransferReconRows().length, 0, '前置：升级用户 recon 隐藏表初始为空');

      // run 入口实时重派生（与 main.js bank-statement:run 入口同款调用）。
      const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({
        database: appDb, buildFundTransferReconRows
      });

      const back = appDb.readFundTransferReconRows();
      assert.equal(back.length, 4, '🔴 升级回归修复：2 行 mid → 4 行调拨对账单（不再读空表）');
      assert.equal(fundTransferReconDerive.created, true);
      assert.equal(fundTransferReconDerive.total, 4, 'total = mid 行数×2');
      // 回填内容正确（in/out 两行均落库）。
      assert.equal(back[0][R.allocationNo], 'UP1');
      assert.equal(back[0][R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_IN);
      assert.equal(back[1][R.fundType], FT_RECON_FIELD_MAP.FUND_TYPE_OUT);
    });

    // v3.0.6 codex-pr74-fix P2：run 每次入口都重派生 → 必须幂等刷新（替换而非追加），否则连续 run 会行数翻倍污染对手方数据源。
    test('幂等刷新：mid 不变时重复重派生 → 行数恒为 mid×2（替换非追加）', () => {
      appDb.replaceLinkedTable('mid-allocation', [
        midRow({ [M.allocationNo]: 'IDEM1' }),
        midRow({ [M.allocationNo]: 'IDEM2' })
      ]);

      // 第一次重派生（首次 run）。
      const r1 = rebuildFundTransferReconDerivation({ database: appDb, buildFundTransferReconRows });
      assert.equal(appDb.readFundTransferReconRows().length, 4, '首次重派生 → 4 行');
      assert.equal(r1.fundTransferReconDerive.total, 4);

      // 第二、三次重派生（连续 run，mid 不变）→ 行数恒为 4，不累加。
      rebuildFundTransferReconDerivation({ database: appDb, buildFundTransferReconRows });
      const r3 = rebuildFundTransferReconDerivation({ database: appDb, buildFundTransferReconRows });
      const back = appDb.readFundTransferReconRows();
      assert.equal(back.length, 4, '🔴 幂等：重复重派生整表覆盖，行数不翻倍');
      assert.equal(r3.fundTransferReconDerive.total, 4, 'total 恒为 mid×2');
    });

    test('整表覆盖：第二次派生（mid 减少）后调拨对账单仅含第二批，不累加', () => {
      appDb.replaceLinkedTable('mid-allocation', [midRow({ [M.allocationNo]: 'OLD1' }), midRow({ [M.allocationNo]: 'OLD2' })]);
      rebuildFundTransferReconDerivation({ database: appDb, buildFundTransferReconRows });
      assert.equal(appDb.readFundTransferReconRows().length, 4, '首次派生 2 单 → 4 行');

      // mid 重导为 1 单 → 重派生应整表覆盖为 2 行。
      appDb.replaceLinkedTable('mid-allocation', [midRow({ [M.allocationNo]: 'NEW1' })]);
      const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({ database: appDb, buildFundTransferReconRows });
      const back = appDb.readFundTransferReconRows();
      assert.equal(back.length, 2, '🔴 整表覆盖：旧 4 行被全删，二次派生不累加');
      assert.equal(fundTransferReconDerive.total, 2);
      assert.equal(back[0][R.allocationNo], 'NEW1');
    });

    test('ADM 派生不受调拨对账单派生影响（共存 — 同库两隐藏表互不污染）', () => {
      // 先建 mid-allocation（ADM 派生输入之一 + 调拨对账单派生唯一输入）。
      appDb.replaceLinkedTable('mid-allocation', [midRow({ [M.allocationNo]: 'A1' })]);
      // 跑调拨对账单派生 → 2 行。
      rebuildFundTransferReconDerivation({ database: appDb, buildFundTransferReconRows });
      assert.equal(appDb.readFundTransferReconRows().length, 2, '调拨对账单派生 2 行');

      // 跑 ADM 派生（真实 buildAdmRows；无 bank-deposit 候选 → ADM 空表，但必须 created:true 不抛）。
      const { buildAdmRows } = require('../../../src/main-process/adm-bank-deposit-builder');
      const { admDerive } = rebuildAdmDerivation({ database: appDb, buildAdmRows });
      assert.equal(admDerive.created, true, 'ADM 派生成功（不受调拨对账单派生干扰）');

      // 调拨对账单表仍为 2 行（ADM 派生写的是另一张隐藏表 linked_adm_bank_deposit）。
      assert.equal(appDb.readFundTransferReconRows().length, 2, '🔴 ADM 派生后调拨对账单表行数不变（两隐藏表隔离）');
    });
  });
});
