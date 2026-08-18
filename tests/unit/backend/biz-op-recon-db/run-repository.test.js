const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const runRepo = require('../../../../src/backend/biz-op-recon-db/run-repository');
const importsRepo = require('../../../../src/backend/biz-op-recon-db/imports-repository');
const flowRepo = require('../../../../src/backend/biz-op-recon-db/flow-imports-repository');
const { ensureBizOpReconTablesSupport } = require('../../../../src/backend/biz-op-recon-db/migrations');

let db;

test.beforeEach(() => {
  db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
});

test.afterEach(() => {
  if (db) { try { db.close(); } catch (_) {} db = null; }
});

test.describe('subOneDay helper', () => {
  test('2026-05-22 → 2026-05-21', () => {
    assert.equal(runRepo.subOneDay('2026-05-22'), '2026-05-21');
  });

  test('跨月 2026-05-01 → 2026-04-30', () => {
    assert.equal(runRepo.subOneDay('2026-05-01'), '2026-04-30');
  });

  test('跨年 2026-01-01 → 2025-12-31', () => {
    assert.equal(runRepo.subOneDay('2026-01-01'), '2025-12-31');
  });
});

test.describe('insertRun / getRunById', () => {
  test('正常 insert + getRunById', () => {
    const id = runRepo.insertRun(db, {
      date: '2026-05-22',
      buName: 'BU-A',
      status: 'success',
      stats: {
        t1OpTotal: 100,
        t2OpTotal: 95,
        flowTotal: 90,
        amountDiffCount: 5,
        multiOpAccountCount: 2,
        t2AnomalyAccountCount: 1,
        t1NotT2Count: 3,
        t2NotT1Count: 4
      }
    });
    const r = runRepo.getRunById(db, id);
    assert.equal(r.data_date, '2026-05-22');
    assert.equal(r.bu_name, 'BU-A');
    assert.equal(r.t1_op_total, 100);
    assert.equal(r.amount_diff_count, 5);
    assert.equal(r.t2_anomaly_account_count, 1);
  });

  test('stats 缺省 → 0', () => {
    const id = runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    const r = runRepo.getRunById(db, id);
    assert.equal(r.t1_op_total, 0);
    assert.equal(r.amount_diff_count, 0);
  });

  test('getRunById 不存在 → null', () => {
    assert.equal(runRepo.getRunById(db, 9999), null);
  });
});

test.describe('v1 Archive run receipt', () => {
  test('按 TaskRun 唯一持久、查询并幂等 ack', () => {
    const stats = {
      t1OpTotal: 3,
      t2OpTotal: 2,
      flowTotal: 1,
      amountDiffCount: 1,
      multiOpAccountCount: 0,
      t2AnomalyAccountCount: 0,
      t1NotT2Count: 0,
      t2NotT1Count: 0
    };
    const id = runRepo.insertArchiveRun(db, {
      date: '2026-05-22', buName: 'BU-A', stats, archiveTaskRunId: 'biz-run-task-1'
    });
    const run = runRepo.getRunByArchiveTaskRunId(db, 'biz-run-task-1');
    assert.equal(run.id, id);
    assert.equal(run.archive_contract_version, 1);
    assert.equal(run.archive_terminal_ack_at, null);
    assert.deepEqual(runRepo.listUnacknowledgedArchiveRuns(db).map((item) => item.id), [id]);

    runRepo.acknowledgeArchiveTerminal(db, id, 'biz-run-task-1', '2026-05-22T10:00:00.000Z');
    runRepo.acknowledgeArchiveTerminal(db, id, 'biz-run-task-1', '2026-05-22T10:00:01.000Z');
    assert.equal(runRepo.getRunById(db, id).archive_terminal_ack_at, '2026-05-22T10:00:00.000Z');
    assert.equal(runRepo.listUnacknowledgedArchiveRuns(db).length, 0);
  });

  test('同一 TaskRun 不能产生第二条业务 run receipt', () => {
    const stats = {
      t1OpTotal: 0, t2OpTotal: 0, flowTotal: 0, amountDiffCount: 0,
      multiOpAccountCount: 0, t2AnomalyAccountCount: 0, t1NotT2Count: 0, t2NotT1Count: 0
    };
    runRepo.insertArchiveRun(db, {
      date: '2026-05-22', buName: 'BU-A', stats, archiveTaskRunId: 'same-task'
    });
    assert.throws(() => runRepo.insertArchiveRun(db, {
      date: '2026-05-23', buName: 'BU-A', stats, archiveTaskRunId: 'same-task'
    }), /UNIQUE/);
  });
});

test.describe('listRunsByDateBu', () => {
  test('LOWER+TRIM 过滤', () => {
    runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-B' });
    const r = runRepo.listRunsByDateBu(db, '2026-05-22', '  bu-a  ');
    assert.equal(r.length, 1);
    assert.equal(r[0].bu_name, 'BU-A');
  });

  test('其它日期不返回', () => {
    runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    assert.equal(runRepo.listRunsByDateBu(db, '2026-05-23', 'BU-A').length, 0);
  });
});

test.describe('updateRunExportPath', () => {
  test('更新 export_path', () => {
    const id = runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    runRepo.updateRunExportPath(db, id, '/path/x');
    const r = runRepo.getRunById(db, id);
    assert.equal(r.export_path, '/path/x');
  });
});

test.describe('listSuccessDates', () => {
  test('每日期取最新 run（按 MAX(id) GROUP BY date）', () => {
    runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    runRepo.insertRun(db, { date: '2026-05-21', buName: 'BU-A' });
    const r = runRepo.listSuccessDates(db, 'BU-A');
    assert.equal(r.length, 2);
    // 排序 DESC
    assert.equal(r[0].date, '2026-05-22');
  });

  test('其它 BU 不返回', () => {
    runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    assert.equal(runRepo.listSuccessDates(db, 'BU-B').length, 0);
  });
});

test.describe('listSuccessDatesInRange', () => {
  test('区间过滤 + 排序 ASC', () => {
    runRepo.insertRun(db, { date: '2026-05-01', buName: 'BU-A' });
    runRepo.insertRun(db, { date: '2026-05-15', buName: 'BU-A' });
    runRepo.insertRun(db, { date: '2026-05-30', buName: 'BU-A' });
    const r = runRepo.listSuccessDatesInRange(db, 'BU-A', '2026-05-10', '2026-05-20');
    assert.equal(r.length, 1);
    assert.equal(r[0].date, '2026-05-15');
  });
});

test.describe('listReadyDates — 三件齐校验', () => {
  function insertBizOp(date, bu) {
    importsRepo.insertRows(db, date, [{ _rowIndex: 1, bu_name: bu, account_no: 'A1' }]);
  }
  function insertFlow(date, buDept) {
    flowRepo.insertRows(db, date, [{
      _rowIndex: 1, account_no: 'A1', direction: '入', recon_amount: '100',
      bu_dept: buDept
    }]);
  }

  test('三件齐 → 返回 date', () => {
    insertBizOp('2026-05-22', 'BU-A');
    insertBizOp('2026-05-21', 'BU-A');  // T-2
    insertFlow('2026-05-22', 'BU-A');
    const r = runRepo.listReadyDates(db, 'BU-A');
    assert.equal(r.length, 1);
    assert.equal(r[0].date, '2026-05-22');
  });

  test('缺 T-2 → 不返回', () => {
    insertBizOp('2026-05-22', 'BU-A');
    insertFlow('2026-05-22', 'BU-A');
    // 没有 2026-05-21
    assert.deepEqual(runRepo.listReadyDates(db, 'BU-A'), []);
  });

  test('缺流水 → 不返回', () => {
    insertBizOp('2026-05-22', 'BU-A');
    insertBizOp('2026-05-21', 'BU-A');
    // 无 flow
    assert.deepEqual(runRepo.listReadyDates(db, 'BU-A'), []);
  });

  test('流水 bu_dept 不匹配 → 不返回', () => {
    insertBizOp('2026-05-22', 'BU-A');
    insertBizOp('2026-05-21', 'BU-A');
    insertFlow('2026-05-22', 'BU-OTHER');
    assert.deepEqual(runRepo.listReadyDates(db, 'BU-A'), []);
  });

  test('LOWER+TRIM 流水 bu_dept 匹配', () => {
    insertBizOp('2026-05-22', 'BU-A');
    insertBizOp('2026-05-21', 'BU-A');
    insertFlow('2026-05-22', '  bu-a  ');
    const r = runRepo.listReadyDates(db, 'BU-A');
    assert.equal(r.length, 1);
  });
});

test.describe('insertDiffRows / getDiffRowsByRun', () => {
  test('批量插入 + 查询', () => {
    const runId = runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    const n = runRepo.insertDiffRows(db, runId, '2026-05-22', 'BU-A', [
      { source_table: 'imports', source_row_id: 1, cmp_t2: 'X', multi_op_flag: 'N', cmp_amount: 'Y', amount_diff: 0.5 },
      { source_table: 'flow', source_row_id: 2, cmp_t2: '', multi_op_flag: '', cmp_amount: '', amount_diff: null }
    ]);
    assert.equal(n, 2);
    const r = runRepo.getDiffRowsByRun(db, runId);
    assert.equal(r.length, 2);
    assert.equal(r[0].amount_diff, '0.5');
    assert.equal(r[1].amount_diff, '');
  });

  test('空数组 → 0', () => {
    const runId = runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    assert.equal(runRepo.insertDiffRows(db, runId, '2026-05-22', 'BU-A', []), 0);
  });
});

test.describe('clearRunsAndDiffsByDateBu', () => {
  test('删 runs + diff_rows FK 顺序正确', () => {
    const runId = runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    runRepo.insertDiffRows(db, runId, '2026-05-22', 'BU-A', [
      { source_table: 't', source_row_id: 1, multi_op_flag: 'N' }
    ]);
    const r = runRepo.clearRunsAndDiffsByDateBu(db, '2026-05-22', 'BU-A');
    assert.equal(r.diffRowsDeleted, 1);
    assert.equal(r.runsDeleted, 1);
  });

  test('未匹配 → 0/0', () => {
    const r = runRepo.clearRunsAndDiffsByDateBu(db, '2099-01-01', 'BU-X');
    assert.equal(r.diffRowsDeleted, 0);
    assert.equal(r.runsDeleted, 0);
  });
});

test.describe('clearRunsAndDiffsByDate（流水重导专用 — 资金红线）', () => {
  test('清该 date 的全部 BU runs（跨 BU）', () => {
    runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-A' });
    runRepo.insertRun(db, { date: '2026-05-22', buName: 'BU-B' });
    runRepo.insertRun(db, { date: '2026-05-21', buName: 'BU-A' });
    const r = runRepo.clearRunsAndDiffsByDate(db, '2026-05-22');
    assert.equal(r.runsDeleted, 2);
    // 其它日期不动
    assert.equal(runRepo.listRunsByDateBu(db, '2026-05-21', 'BU-A').length, 1);
  });
});
