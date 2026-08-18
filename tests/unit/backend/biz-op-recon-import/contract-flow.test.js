'use strict';
// 业务OP对账 流水（flow）引擎契约模块单元测试（v3.0.4 块 C · PR-D）🔴 资金红线
//
// 覆盖（仿 contract-pending.test.js）：
//   - validateContract 通过（schema 合法 + whitelist=null 旁路第 1 层防护）
//   - expectedHeaders 28 列 / mapRow 30 参（[data_date, row_index, ...28 DB 列]，列序对齐 insertSql）
//   - insertSql 与 flow-imports-repository.makeRowInserter byte-for-byte 同源
//   - mapRow 三态：合法行 → params；validateFlowRow 不过 → { error:{rowIndex,reason} }（逐字平移 validator）
//   - mapRow 逐格 normalizeCell（trim）→ DB 行（对齐 reader-streamed obj[dbCol]=normalizeCell(cell)）
//   - deleteForOverwrite = clearRunsAndDiffsByDate + flow clearByDate 2 段共 3 条 SQL（顺序敏感，闭包 date）
//   - cellsOf 从 30 参 params 逆推 28 列 cells（E4 cells 缺口补丁）
//   - maxCollectedErrors=1000 / captureRowValues=true / monthKeyOf=null
//   - finalizeForCommit 事务内写 v1 flow dataset head；不声明 dedupeKeyOf / rejectEmptyFiles

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  FLOW_HEADERS,
  FLOW_DB_COLUMNS
} = require('../../../../src/backend/biz-op-recon-db/columns');
const { validateContract } = require('../../../../src/backend/big-table-import/contract');
const contractMod = require('../../../../src/backend/biz-op-recon-import/contract-flow');
const { ensureBizOpReconTablesSupport } = require('../../../../src/backend/biz-op-recon-db/migrations');
const flowRepo = require('../../../../src/backend/biz-op-recon-db/flow-imports-repository');
const runRepo = require('../../../../src/backend/biz-op-recon-db/run-repository');

function mkContract(opts = {}) {
  return contractMod.createContract({
    date: opts.date || '2026-06-10',
    datasetSeed: opts.datasetSeed || {
      datasetId: 'flow-dataset-1',
      producerTaskRunId: 'flow-import-task-1',
      expectedDatasetId: null,
      expectedDatasetVersion: 0
    }
  });
}

// 合法流水行的 28 列值（表头序）：direction='入' / recon_amount 数值 / account_no 非空，其余任意。
function validFlowValues(overrides = {}) {
  const v = new Array(28).fill('');
  // 按 FLOW_DB_COLUMNS 索引填关键列（与 columns.js FLOW_COLUMN_DEFS 顺序一致）。
  v[FLOW_DB_COLUMNS.indexOf('direction')] = '入';
  v[FLOW_DB_COLUMNS.indexOf('recon_amount')] = '100.50';
  v[FLOW_DB_COLUMNS.indexOf('account_no')] = 'ACC-001';
  for (const k of Object.keys(overrides)) {
    const idx = FLOW_DB_COLUMNS.indexOf(k);
    if (idx >= 0) v[idx] = overrides[k];
  }
  return v;
}

function dumpOverwriteState(db) {
  return {
    flow: db.prepare('SELECT * FROM biz_op_recon_flow_imports ORDER BY id').all(),
    runs: db.prepare('SELECT * FROM biz_op_recon_runs ORDER BY id').all(),
    diffs: db.prepare('SELECT * FROM biz_op_recon_diff_rows ORDER BY id').all(),
    heads: db.prepare('SELECT * FROM biz_op_recon_dataset_heads ORDER BY dataset_kind, data_date').all()
  };
}

test('flow 契约通过 validateContract（whitelist=null 旁路第 1 层防护）', () => {
  const c = mkContract();
  const v = validateContract(c);
  assert.equal(v.expectedHeaders.length, 28);
  assert.equal(v.valueColumnWhitelist, null);
  assert.equal(v.captureRowValues, true);
  assert.equal(v.maxCollectedErrors, 1000);
  assert.equal(typeof v.cellsOf, 'function');
  // flow 不声明跨文件去重；dataset head 由事务收尾写入。
  assert.equal(typeof v.dedupeKeyOf, 'undefined');
  assert.equal(typeof v.finalizeForCommit, 'function');
  // validateContract 把未声明的 rejectEmptyFiles 归一为 false（空文件 parity 改由 session 按总行数判，见 contract-flow 头注）。
  assert.equal(v.rejectEmptyFiles, false);
});

test('finalizeForCommit 以冻结 seed 写下一版 flow dataset head', () => {
  const rawSeed = {
    datasetId: 'flow-dataset-frozen',
    producerTaskRunId: 'flow-import-task-frozen',
    expectedDatasetId: 'flow-dataset-v6',
    expectedDatasetVersion: 6
  };
  const c = mkContract({ date: '2026-06-11', datasetSeed: rawSeed });
  rawSeed.datasetId = 'mutated-after-contract';
  rawSeed.expectedDatasetVersion = 99;

  const statements = c.finalizeForCommit();
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /INSERT INTO biz_op_recon_dataset_heads/);
  assert.match(statements[0].sql, /VALUES \('flow', \?, '', \?, \?, \?, 1, \?\)/);
  assert.deepEqual(statements[0].params.slice(0, 4), [
    '2026-06-11',
    'flow-dataset-frozen',
    'flow-import-task-frozen',
    7
  ]);
  assert.ok(!Number.isNaN(Date.parse(statements[0].params[4])));
});

test('engine worker contract 边界拒绝 missing 或 malformed v1 seed', () => {
  assert.throws(
    () => contractMod.createContract({ date: '2026-06-10' }),
    /exact v1 dataset seed/
  );
  assert.throws(
    () => contractMod.createContract({
      date: '2026-06-10',
      datasetSeed: {
        datasetId: 'flow-dataset',
        producerTaskRunId: 'flow-task',
        expectedDatasetId: 'old-dataset',
        expectedDatasetVersion: '1'
      }
    }),
    /exact v1 dataset seed/
  );
});

test('v0 head 可被首个 v1 transaction 精确覆盖；过期 seed 在业务删除前 fail-closed', () => {
  const db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
  db.prepare(`
    INSERT INTO biz_op_recon_dataset_heads (
      dataset_kind, data_date, normalized_bu, dataset_id,
      producer_task_run_id, dataset_version, archive_contract_version, updated_at
    ) VALUES ('flow', '2026-06-12', '', 'legacy-v0', NULL, 0, 0, '2026-06-12T00:00:00.000Z')
  `).run();

  const c = mkContract({
    date: '2026-06-12',
    datasetSeed: {
      datasetId: 'first-v1',
      producerTaskRunId: 'flow-task-v1',
      expectedDatasetId: 'legacy-v0',
      expectedDatasetVersion: 0
    }
  });
  db.exec('BEGIN');
  for (const statement of c.deleteForOverwrite()) {
    db.prepare(statement.sql).run(...statement.params);
  }
  for (const statement of c.finalizeForCommit()) {
    db.prepare(statement.sql).run(...statement.params);
  }
  db.exec('COMMIT');
  assert.deepEqual(
    { ...db.prepare(`SELECT dataset_id, dataset_version, archive_contract_version
      FROM biz_op_recon_dataset_heads WHERE dataset_kind = 'flow'`).get() },
    { dataset_id: 'first-v1', dataset_version: 1, archive_contract_version: 1 }
  );

  const stale = mkContract({
    date: '2026-06-12',
    datasetSeed: {
      datasetId: 'stale-v1',
      producerTaskRunId: 'stale-task',
      expectedDatasetId: 'legacy-v0',
      expectedDatasetVersion: 0
    }
  });
  db.exec('BEGIN');
  assert.throws(() => {
    for (const statement of stale.deleteForOverwrite()) {
      db.prepare(statement.sql).run(...statement.params);
    }
  }, /constraint/i);
  db.exec('ROLLBACK');
  assert.equal(
    db.prepare(`SELECT dataset_id FROM biz_op_recon_dataset_heads
      WHERE dataset_kind = 'flow'`).get().dataset_id,
    'first-v1'
  );
  db.close();
});

test('Flow overwrite 遇同日未 ACK v1 receipt 时 run/diff/import/head 零变化', () => {
  const date = '2026-06-13';
  const db = new DatabaseSync(':memory:');
  ensureBizOpReconTablesSupport(db);
  flowRepo.insertRows(db, date, [{
    _rowIndex: 2, bu_dept: 'BU-A', direction: '入', account_no: 'ACC-OLD', recon_amount: '10'
  }]);
  db.prepare(`
    INSERT INTO biz_op_recon_dataset_heads (
      dataset_kind, data_date, normalized_bu, dataset_id,
      producer_task_run_id, dataset_version, archive_contract_version, updated_at
    ) VALUES ('flow', ?, '', 'flow-old', 'flow-old-task', 1, 1, '2026-06-13T00:00:00.000Z')
  `).run(date);
  const runId = runRepo.insertArchiveRun(db, {
    date,
    buName: 'BU-A',
    archiveTaskRunId: 'flow-pending-run',
    stats: {
      t1OpTotal: 1, t2OpTotal: 1, flowTotal: 1, amountDiffCount: 1,
      multiOpAccountCount: 0, t2AnomalyAccountCount: 0,
      t1NotT2Count: 0, t2NotT1Count: 0
    }
  });
  runRepo.insertDiffRows(db, runId, date, 'BU-A', [
    { source_table: 'flow', source_row_id: 1, multi_op_flag: 'N' }
  ]);
  const before = dumpOverwriteState(db);
  const contract = mkContract({
    date,
    datasetSeed: {
      datasetId: 'flow-replacement',
      producerTaskRunId: 'flow-replacement-task',
      expectedDatasetId: 'flow-old',
      expectedDatasetVersion: 1
    }
  });

  db.exec('BEGIN');
  assert.throws(() => {
    for (const statement of contract.deleteForOverwrite()) {
      db.prepare(statement.sql).run(...statement.params);
    }
  }, /constraint/i);
  db.exec('ROLLBACK');
  assert.deepEqual(dumpOverwriteState(db), before);
  db.close();
});

test('expectedHeaders = FLOW_HEADERS（28 列，顺序一致）', () => {
  const c = mkContract();
  assert.deepEqual(c.expectedHeaders, FLOW_HEADERS);
  assert.equal(c.expectedHeaders.length, 28);
});

test('insertSql 与 flow-imports-repository.makeRowInserter byte-for-byte 同源', () => {
  // 复刻 flow-imports-repository.buildInsertSql 的构造方式对照（不 require 仓储——平移锁，参 PR-H/PR-C 范式）。
  const cols = ['data_date', 'row_index', ...FLOW_DB_COLUMNS].join(', ');
  const placeholders = ['?', '?', ...FLOW_DB_COLUMNS.map(() => '?')].join(', ');
  const expected = `INSERT INTO biz_op_recon_flow_imports (${cols}) VALUES (${placeholders})`;
  assert.equal(contractMod.FLOW_INSERT_SQL, expected);
  assert.equal(mkContract().insertSql, expected);
});

test('mapRow 合法行 → 30 参（[data_date, row_index, ...28 列]，列序对齐 insertSql）', () => {
  const c = mkContract({ date: '2026-06-10' });
  const values = validFlowValues();
  const m = c.mapRow({ rowR: 42, values });
  assert.ok(Array.isArray(m.params), 'mapRow 合法行返回 { params }');
  assert.equal(m.params.length, 30);
  assert.equal(m.params[0], '2026-06-10');   // data_date = 入参 date
  assert.equal(m.params[1], 42);             // row_index = rowR（Excel 真实行号）
  // 余 28 列 = normalizeCell 后的 DB 列值（表头序）。
  assert.equal(m.params.slice(2).length, 28);
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('direction')], '入');
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('recon_amount')], '100.50');
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('account_no')], 'ACC-001');
});

test('mapRow 逐格 normalizeCell（trim）→ 对齐 reader-streamed obj[dbCol]=normalizeCell(cell)', () => {
  const c = mkContract({ date: '2026-06-10' });
  // 关键列带首尾空白（reader-streamed 在 reader 内 trim；引擎不 trim，故契约必须补 trim 保 byte-for-byte）。
  const values = validFlowValues({ account_no: '  ACC-002  ', direction: '入' });
  // 给某非关键列也带空白验证全列 trim。
  values[FLOW_DB_COLUMNS.indexOf('biz_id')] = '  B123  ';
  const m = c.mapRow({ rowR: 5, values });
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('account_no')], 'ACC-002', 'account_no 已 trim');
  assert.equal(m.params[2 + FLOW_DB_COLUMNS.indexOf('biz_id')], 'B123', '非关键列也 trim');
});

test('mapRow 三态：出入方向非法 → { error }（逐字平移 validateFlowRow）', () => {
  const c = mkContract();
  const values = validFlowValues({ direction: 'X' });
  const m = c.mapRow({ rowR: 7, values });
  assert.ok(m.error, '非法方向返回 { error }');
  assert.equal(m.error.rowIndex, 7);
  assert.equal(m.error.reason, '出入方向非法：实际值 "X"，仅允许 "入" 或 "出"');
});

test('mapRow 三态：对账金额非数值 → { error }', () => {
  const c = mkContract();
  const values = validFlowValues({ recon_amount: 'abc' });
  const m = c.mapRow({ rowR: 8, values });
  assert.ok(m.error);
  assert.equal(m.error.reason, '对账金额非数值：abc');
});

test('mapRow 三态：账户编号为空 → { error }', () => {
  const c = mkContract();
  const values = validFlowValues({ account_no: '   ' });
  const m = c.mapRow({ rowR: 9, values });
  assert.ok(m.error);
  assert.equal(m.error.reason, '账户编号为空');
});

test('🔴 deleteForOverwrite 先核对 head，再按 diff → run → flow 顺序覆盖', () => {
  const c = mkContract({ date: '2026-06-10' });
  const dels = c.deleteForOverwrite();
  assert.equal(dels.length, 6);
  assert.match(dels[0].sql, /CREATE TEMP TABLE/);
  assert.match(dels[2].sql, /biz_op_recon_dataset_heads/);
  assert.match(dels[2].sql, /archive_contract_version = 1/);
  assert.match(dels[2].sql, /archive_terminal_ack_at IS NULL/);
  const businessDeletes = dels.slice(3);
  // 1) 先删该 date 的 diff_rows（run_id IN 该 date runs）
  assert.match(businessDeletes[0].sql, /DELETE FROM biz_op_recon_diff_rows/);
  assert.match(businessDeletes[0].sql, /SELECT id FROM biz_op_recon_runs/);
  assert.match(businessDeletes[0].sql, /WHERE data_date = \?/);
  assert.deepEqual(businessDeletes[0].params, ['2026-06-10']);
  // 2) 删该 date 的 runs（跨所有 BU）
  assert.match(businessDeletes[1].sql, /DELETE FROM biz_op_recon_runs/);
  assert.match(businessDeletes[1].sql, /WHERE data_date = \?/);
  assert.deepEqual(businessDeletes[1].params, ['2026-06-10']);
  // 3) 删该 date 的流水主表行
  assert.equal(businessDeletes[2].sql, 'DELETE FROM biz_op_recon_flow_imports WHERE data_date = ?');
  assert.deepEqual(businessDeletes[2].params, ['2026-06-10']);
});

test('cellsOf 从 30 参 params 逆推 28 列 cells（E4 cells 缺口补丁）', () => {
  const c = mkContract({ date: '2026-06-10' });
  const values = validFlowValues();
  const m = c.mapRow({ rowR: 3, values });
  const cells = c.cellsOf({ params: m.params });
  assert.equal(cells.length, 28);
  // cells = params.slice(2) = 28 DB 列归一值（表头序）。
  assert.deepEqual(cells, m.params.slice(2));
});

test('cellsOf 防御：params 非数组 → 空数组', () => {
  const c = mkContract();
  assert.deepEqual(c.cellsOf({ params: null }), []);
  assert.deepEqual(c.cellsOf({}), []);
});

test('monthKeyOf 恒返回 null（跨月校验旁路）', () => {
  const c = mkContract();
  assert.equal(c.monthKeyOf(), null);
});

test('buildFlowDbRow：values → DB 行对象（snake_case key + _rowIndex）', () => {
  const values = validFlowValues();
  const row = contractMod.buildFlowDbRow(values, 11);
  assert.equal(row.direction, '入');
  assert.equal(row.recon_amount, '100.50');
  assert.equal(row.account_no, 'ACC-001');
  assert.equal(row._rowIndex, 11);
  // 全 28 DB 列均存在。
  for (const col of FLOW_DB_COLUMNS) assert.ok(col in row, `缺列 ${col}`);
});
