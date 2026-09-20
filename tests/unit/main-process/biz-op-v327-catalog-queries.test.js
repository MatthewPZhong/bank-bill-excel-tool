'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createBizOpCatalog } = require('../../../src/main-process/biz-op-v327/catalog');
const { createBizOpCatalogQueries } = require('../../../src/main-process/biz-op-v327/catalog-queries');
const { collectInputs } = require('../../../src/main-process/biz-op-v327/compute-inputs');
const { freezeExportSource } = require('../../../src/main-process/biz-op-v327/export-inputs');
const { RULE_VERSION } = require('../../../src/main-process/biz-op-v327/import-adapter');
const { LEGACY_RESULT_SCHEMA_VERSION } = require('../../../src/main-process/biz-op-v327/result-schema');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  // 查询投影使用真实 SQLite；简化约束允许构造损坏端点及缺失关联的负向样本。
  db.exec(`CREATE TABLE biz_op_v327_datasets(dataset_id TEXT,kind TEXT,data_date TEXT,public_version INTEGER,
      row_count INTEGER,source_manifest_digest TEXT,payload_manifest_rel_path TEXT,payload_manifest_digest TEXT,state TEXT,activated_at TEXT);
    CREATE TABLE biz_op_v327_input_heads(kind TEXT,data_date TEXT,dataset_id TEXT);
    CREATE TABLE biz_op_v327_dataset_sources(dataset_id TEXT,artifact_id INTEGER,source_sha256 TEXT,source_file_name TEXT,
      source_file_order INTEGER,source_sheet_name TEXT,normalized_bu TEXT,row_count INTEGER);
    CREATE TABLE biz_op_v327_runs(run_id TEXT,result_version INTEGER,start_date TEXT,end_date TEXT,input_fingerprint TEXT,
      published_at TEXT,payload_manifest_rel_path TEXT,payload_manifest_digest TEXT,state TEXT,operation_month TEXT);
    CREATE TABLE biz_op_v327_run_inputs(run_id TEXT,role TEXT,input_version INTEGER,dataset_id TEXT);
    CREATE TABLE biz_op_v327_run_artifacts(run_id TEXT,artifact_id INTEGER,source_file_name TEXT,source_sha256 TEXT);
    CREATE TABLE biz_op_v327_diagnostic_reports(report_ref TEXT,task_run_id TEXT,scan_complete INTEGER,error_count_exact INTEGER,
      sample_count INTEGER,manifest_digest TEXT,state TEXT,producer_job_id TEXT,producer_session_id TEXT);
    CREATE TABLE biz_op_v327_diagnostic_lifecycle(report_ref TEXT,sealed_manifest_rel_path TEXT);
    CREATE TABLE biz_op_v327_dispatches(task_run_id TEXT,plan_digest TEXT,job_id TEXT,session_id TEXT,state TEXT);`);
  const queries = createBizOpCatalogQueries({ db });
  function dataset(id, { state = 'ACTIVE', kind = 'OP', date = '2026-09-01', head = true } = {}) {
    db.prepare('INSERT INTO biz_op_v327_datasets VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, kind, date, 3, 2, 'source-digest', `inputs/${id}/manifest.json`, 'manifest-digest', state, '2026-09-20T00:00:00Z');
    if (head) db.prepare('INSERT INTO biz_op_v327_input_heads VALUES (?,?,?)').run(kind, date, id);
  }
  function run(id, { state = 'PUBLISHED', endpoints = [['END_OP', 9], ['FLOW', 5], ['START_OP', 3]] } = {}) {
    db.prepare('INSERT INTO biz_op_v327_runs VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, 2, '2026-09-01', '2026-09-03', 'fingerprint', '2026-09-20T00:00:00Z', `results/${id}/manifest.json`, 'run-digest', state, '2026-09');
    for (const [role, version] of endpoints) db.prepare('INSERT INTO biz_op_v327_run_inputs VALUES (?,?,?,?)').run(id, role, version, 'data');
  }
  return { db, queries, dataset, run };
}

test('catalog 公开冻结查询集合，同连接即时读取且保留合法命令能力', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const catalog = createBizOpCatalog(db, { assertCommitReady() {} });
  assert.equal(catalog.db, db);
  assert.equal(Object.isFrozen(catalog.queries), true);
  assert.deepEqual(Object.keys(catalog.queries).sort(), ['iterateDatasetSources', 'iteratePublishedRunIdsUsingDataset',
    'iterateRunArtifacts', 'readActiveDataset', 'readActiveDatasetForDelete', 'readDiagnosticByRef', 'readDispatchesForPlan',
    'readExportObject', 'readPublishedRunForDelete']);
  assert.equal(catalog.queries.readActiveDataset('OP', '2026-09-01'), null);
  assert.equal(typeof catalog.transaction, 'function');
  assert.equal(typeof catalog.commitImport, 'function');
  assert.equal(typeof catalog.commitDelete, 'function');
});

test('ACTIVE 读取保留 head、kind 过滤、精确字段和新对象，不缓存旧状态', (t) => {
  const { db, queries, dataset } = fixture(t);
  dataset('data'); dataset('retired', { state: 'RETIRED', date: '2026-09-02' });
  dataset('without-head', { head: false, date: '2026-09-03' });
  dataset('flow', { kind: 'FLOW', date: '2026-09-04' });
  assert.deepEqual(queries.readActiveDataset('OP', '2026-09-01'), { datasetId: 'data', kind: 'OP', dataDate: '2026-09-01',
    publicVersion: 3, rowCount: 2, sourceManifestDigest: 'source-digest', manifestRelativePath: 'inputs/data/manifest.json', manifestDigest: 'manifest-digest' });
  for (const date of ['2026-09-02', '2026-09-03', '2026-09-04']) assert.equal(queries.readActiveDataset('OP', date), null);
  assert.equal(queries.readActiveDatasetForDelete('retired'), null);
  assert.deepEqual(queries.readActiveDatasetForDelete('without-head'), { datasetId: 'without-head', kind: 'OP', dataDate: '2026-09-03',
    publicVersion: 3, activatedAt: '2026-09-20T00:00:00Z' });
  const first = queries.readActiveDataset('OP', '2026-09-01'); first.publicVersion = 100;
  assert.equal(queries.readActiveDataset('OP', '2026-09-01').publicVersion, 3);
  db.prepare("UPDATE biz_op_v327_datasets SET state='RETIRED' WHERE dataset_id='data'").run();
  assert.equal(queries.readActiveDataset('OP', '2026-09-01'), null);
});

test('来源和结果原件按既有顺序逐行投影，关联结果保持 DISTINCT 查询的顺序', (t) => {
  const { db, queries, run } = fixture(t);
  for (const [id, order] of [[8, 2], [9, 0], [7, 1]]) {
    db.prepare('INSERT INTO biz_op_v327_dataset_sources VALUES (?,?,?,?,?,?,?,?)')
      .run('data', id, `hash-${id}`, `${id}.xlsx`, order, 'Sheet1', 'BU', 1);
    db.prepare('INSERT INTO biz_op_v327_run_artifacts VALUES (?,?,?,?)').run('result-z', id, `${id}.xlsx`, `hash-${id}`);
  }
  assert.deepEqual([...queries.iterateDatasetSources('data')], [9, 7, 8].map((id, order) => ({ artifactId: id,
    sha256: `hash-${id}`, originalName: `${id}.xlsx`, order, sheetName: 'Sheet1', bu: 'BU', rowCount: 1 })));
  assert.deepEqual([...queries.iterateRunArtifacts('result-z')], [7, 8, 9].map((id) => ({ artifactId: id, originalName: `${id}.xlsx`, sha256: `hash-${id}` })));
  run('result-z'); run('result-a'); run('deleted', { state: 'DELETED' });
  const priorOrder = db.prepare(`SELECT DISTINCT r.run_id FROM biz_op_v327_runs r JOIN biz_op_v327_run_inputs i USING(run_id)
    WHERE i.dataset_id=? AND r.state='PUBLISHED'`).all('data').map((row) => row.run_id);
  assert.deepEqual([...queries.iteratePublishedRunIdsUsingDataset('data')], priorOrder);
  assert.deepEqual(queries.readPublishedRunForDelete('result-z'), { runId: 'result-z', startDate: '2026-09-01', endDate: '2026-09-03',
    resultVersion: 2, manifestDigest: 'run-digest', operationMonth: '2026-09' });
  assert.equal(queries.readPublishedRunForDelete('deleted'), null);
  assert.deepEqual([...queries.iterateDatasetSources('missing')], []);
  assert.deepEqual([...queries.iterateRunArtifacts('missing')], []);
});

test('所有 iterator 支持同步提前退出和显式 return，不提前拉取或 all 分配', () => {
  for (const method of ['iterateDatasetSources', 'iteratePublishedRunIdsUsingDataset', 'iterateRunArtifacts']) {
    for (const exit of ['break', 'return', 'throw']) {
      let pulled = 0; let closed = 0; let prepared = 0;
      const row = { artifact_id: 8, source_sha256: 'hash', source_file_name: 'original.xlsx', source_file_order: 0,
        source_sheet_name: 'Sheet', normalized_bu: 'BU', row_count: 1, run_id: 'result' };
      const queries = createBizOpCatalogQueries({ db: { prepare(sql) {
        prepared += 1; assert.match(sql, /^SELECT /);
        return { iterate(id) {
          assert.equal(id, 'id');
          return { [Symbol.iterator]() { return this; }, next() { pulled += 1; return { value: row, done: false }; },
            return() { closed += 1; return { done: true }; } };
        }, all() { assert.fail('流式读取不能先收集全部行'); } };
      } } });
      const iterator = queries[method]('id');
      assert.equal(typeof iterator.then, 'undefined');
      if (exit === 'break') { for (const value of iterator) { assert.ok(value); break; } }
      if (exit === 'return') { assert.equal(iterator.next().done, false); iterator.return(); }
      if (exit === 'throw') assert.throws(() => { for (const value of iterator) { assert.ok(value); throw new Error('budget'); } }, /budget/);
      assert.equal(prepared, 1); assert.equal(pulled, 1); assert.equal(closed, 1);
      assert.equal(iterator.next().done, true);
    }
  }
});

test('SQLite 来源 iterator 提前退出释放 statement，可立即进行原连接维护', (t) => {
  const { db, queries } = fixture(t);
  db.exec("INSERT INTO biz_op_v327_dataset_sources VALUES ('data',1,'hash','a.xlsx',0,'Sheet','BU',1),('data',2,'hash','b.xlsx',1,'Sheet','BU',1)");
  for (const source of queries.iterateDatasetSources('data')) { assert.equal(source.artifactId, 1); break; }
  db.exec('DROP TABLE biz_op_v327_dataset_sources');
});

test('三类导出保留 ACTIVE/PUBLISHED/READY 过滤和完整 metadata 投影', (t) => {
  const { db, queries, dataset, run } = fixture(t);
  dataset('data'); dataset('retired', { state: 'RETIRED', head: false });
  run('result'); run('staged', { state: 'STAGED' });
  assert.deepEqual(queries.readExportObject('RESULT_FULL', 'result'), { objectKind: 'RESULT', metadata: { version: 2,
    startDate: '2026-09-01', endDate: '2026-09-03', inputFingerprint: 'fingerprint', publishedAt: '2026-09-20T00:00:00Z',
    startInputVersion: 3, endInputVersion: 9 }, manifestRelativePath: 'results/result/manifest.json', manifestDigest: 'run-digest' });
  assert.deepEqual(queries.readExportObject('OP_CHECK', 'data'), { objectKind: 'DATASET', metadata: { version: 3,
    dataDate: '2026-09-01', sourceManifestDigest: 'source-digest', activatedAt: '2026-09-20T00:00:00Z' },
  manifestRelativePath: 'inputs/data/manifest.json', manifestDigest: 'manifest-digest' });
  assert.equal(queries.readExportObject('FLOW_CHECK', 'data'), null);
  assert.equal(queries.readExportObject('OP_RAW', 'retired'), null);
  assert.equal(queries.readExportObject('RESULT_FULL', 'staged'), null);
  for (const [id, state, sealed] of [['report', 'READY', true], ['retired-report', 'RETIRED', true], ['unsealed-report', 'READY', false]]) {
    db.prepare('INSERT INTO biz_op_v327_diagnostic_reports VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'task', 1, 0, 4, 'diag-digest', state, 'job', 'session');
    if (sealed) db.prepare('INSERT INTO biz_op_v327_diagnostic_lifecycle VALUES (?,?)').run(id, `diagnostics/${id}/manifest.json`);
  }
  assert.deepEqual(queries.readExportObject('ERRORS', 'report'), { objectKind: 'DIAGNOSTIC', metadata: { producerTaskRunId: 'task',
    scanComplete: true, errorCountExact: false, sampleCount: 4 }, manifestRelativePath: 'diagnostics/report/manifest.json', manifestDigest: 'diag-digest' });
  for (const id of ['retired-report', 'unsealed-report', 'missing']) assert.equal(queries.readExportObject('ERRORS', id), null);
});

test('RESULT 端点必须恰好两条且有起止版本，保持 metadata missing 错误', (t) => {
  const { queries, run } = fixture(t);
  for (const [index, endpoints] of [[], [['START_OP', 1]], [['START_OP', 1], ['START_OP', 2]],
    [['START_OP', 1], ['END_OP', null]], [['START_OP', 1], ['END_OP', 0]], [['START_OP', 1], ['END_OP', 2], ['END_OP', 3]]].entries()) {
    const id = `broken-${index}`; run(id, { endpoints });
    assert.throws(() => queries.readExportObject('RESULT_FULL', id), { code: 'BIZOP_EXPORT_INPUT_METADATA_MISSING' });
  }
  assert.equal(queries.readExportObject('RESULT_FULL', 'missing'), null);
});

test('诊断和 dispatch 保留原字段与数字类型，重复 carrier 不在 query 中隐藏', (t) => {
  const { db, queries } = fixture(t);
  for (const [task, digest, job] of [['task', 'plan', 'job1'], ['task', 'plan', 'job2'], ['other', 'plan', 'job3'], ['task', 'other', 'job4']]) {
    db.prepare('INSERT INTO biz_op_v327_dispatches VALUES (?,?,?,?,?)').run(task, digest, job, 'session', 'CLOSED');
  }
  const dispatches = queries.readDispatchesForPlan('task', 'plan');
  assert.equal(dispatches.length, 2);
  assert.deepEqual(dispatches, db.prepare('SELECT * FROM biz_op_v327_dispatches WHERE task_run_id=? AND plan_digest=?').all('task', 'plan'));
  dispatches[0].state = 'CHANGED'; assert.equal(queries.readDispatchesForPlan('task', 'plan')[0].state, 'CLOSED');
  db.prepare('INSERT INTO biz_op_v327_diagnostic_reports VALUES (?,?,?,?,?,?,?,?,?)').run('report', 'task', 1, 0, 0, 'digest', 'READY', 'job1', 'session');
  const report = queries.readDiagnosticByRef('report');
  assert.deepEqual(report, db.prepare('SELECT * FROM biz_op_v327_diagnostic_reports WHERE report_ref=?').get('report'));
  assert.equal(typeof report.scan_complete, 'number'); assert.equal(report.error_count_exact, 0);
  assert.equal(queries.readDiagnosticByRef('missing'), null); assert.deepEqual(queries.readDispatchesForPlan('missing', 'plan'), []);
});

test('所有查询可在 SQLite query_only 内执行，无写入或事务且 SQL 错误不转为空', (t) => {
  const { db, queries, dataset, run } = fixture(t); dataset('data'); run('result');
  db.exec('PRAGMA query_only=ON');
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  assert.ok(queries.readActiveDataset('OP', '2026-09-01'));
  assert.ok(queries.readActiveDatasetForDelete('data')); assert.ok(queries.readPublishedRunForDelete('result'));
  for (const kind of ['OP_CHECK', 'RESULT_FULL', 'ERRORS']) queries.readExportObject(kind, kind === 'OP_CHECK' ? 'data' : 'result');
  [...queries.iterateDatasetSources('data')]; [...queries.iteratePublishedRunIdsUsingDataset('data')]; [...queries.iterateRunArtifacts('result')];
  queries.readDispatchesForPlan('task', 'plan'); queries.readDiagnosticByRef('report');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(db.isTransaction, false);
  const failure = new Error('sqlite failed');
  const broken = createBizOpCatalogQueries({ db: { prepare() { throw failure; } } });
  assert.throws(() => broken.readActiveDataset('OP', 'date'), (error) => error === failure);
  assert.throws(() => broken.iterateDatasetSources('data').next(), (error) => error === failure);
});

test('计算完整 missing 清单先于来源检查；4096 预算退出会关闭来源 iterator', () => {
  const missingCatalog = { get db() { assert.fail('协调器不能绕回原始连接'); }, queries: { readActiveDataset() { return null; },
    iterateDatasetSources() { assert.fail('缺少输入时不能提前验证来源'); } } };
  assert.throws(() => collectInputs({ catalog: missingCatalog, startDate: '2026-09-01', endDate: '2026-09-03' }), (error) => {
    assert.equal(error.code, 'BIZOP_RUN_INPUT_MISSING');
    assert.deepEqual(error.missing.map(({ role, dataDate }) => [role, dataDate]), [['START_OP', '2026-09-01'], ['END_OP', '2026-09-03'],
      ['FLOW', '2026-09-02'], ['FLOW', '2026-09-03']]); return true;
  });
  let pulled = 0; let closed = false; let checked = 0;
  const catalog = { get db() { assert.fail('协调器不能绕回原始连接'); }, queries: {
    readActiveDataset() { return { datasetId: 'data' }; }, *iterateDatasetSources() {
      try { while (true) { pulled += 1; yield { artifactId: pulled, sha256: 'hash', bu: 'BU' }; } } finally { closed = true; }
    }
  }, archive: { getArtifact() { checked += 1; return { status: 'ready', blob: { sha256: 'hash' } }; },
    listArtifactHolds() { return [{ ownerModule: 'biz-op-recon', ownerType: 'v327-input', ownerId: 'data' }]; } } };
  assert.throws(() => collectInputs({ catalog, startDate: '2026-09-01', endDate: '2026-09-03' }), { code: 'BIZOP_RUN_INPUT_BUDGET' });
  assert.equal(pulled, 4093); assert.equal(checked, 4092); assert.equal(closed, true);
});

test('导出冻结 JSON 保留字段顺序，manifest 判断及错误优先级由协调器维持', async (t) => {
  const { queries, run, dataset } = fixture(t); run('result'); dataset('data');
  const catalog = { queries, get db() { assert.fail('协调器不能绕回原始连接'); } };
  let reads = 0;
  const payloadStore = { readDocument(relativePath, digest) {
    reads += 1; assert.equal(relativePath, 'results/result/manifest.json'); assert.equal(digest, 'run-digest');
    return { value: { objectId: 'result', objectKind: 'RESULT', catalog: { ruleVersion: RULE_VERSION, resultSchemaVersion: LEGACY_RESULT_SCHEMA_VERSION } } };
  } };
  const result = await freezeExportSource({ catalog, payloadStore, objectId: 'result', outputKind: 'RESULT_FULL' });
  assert.equal(JSON.stringify(result), JSON.stringify({ columnSchemaVersion: 1, manifestDigest: 'run-digest',
    manifestRelativePath: 'results/result/manifest.json', metadata: { endDate: '2026-09-03', endInputVersion: 9,
      inputFingerprint: 'fingerprint', publishedAt: '2026-09-20T00:00:00Z', startDate: '2026-09-01', startInputVersion: 3, version: 2 },
    objectId: 'result', objectKind: 'RESULT', outputKind: 'RESULT_FULL' }));
  assert.equal(reads, 1);
  const source = await freezeExportSource({ catalog, payloadStore, objectId: 'data', outputKind: 'OP_CHECK' });
  assert.deepEqual(Object.keys(source), ['columnSchemaVersion', 'manifestDigest', 'manifestRelativePath', 'metadata', 'objectId', 'objectKind', 'outputKind']);
  assert.equal(reads, 1);
  await assert.rejects(freezeExportSource({ catalog, payloadStore, objectId: 'result', outputKind: 'RESULT_FULL', columnSchemaVersion: 2 }),
    { code: 'BIZOP_EXPORT_CONTRACT_MISMATCH' });
  run('broken', { endpoints: [] });
  await assert.rejects(freezeExportSource({ catalog, payloadStore, objectId: 'broken', outputKind: 'RESULT_FULL' }), { code: 'BIZOP_EXPORT_INPUT_METADATA_MISSING' });
  await assert.rejects(freezeExportSource({ catalog, payloadStore, objectId: 'missing', outputKind: 'RESULT_FULL' }), { code: 'BIZOP_EXPORT_SOURCE_UNAVAILABLE' });
  await assert.rejects(freezeExportSource({ catalog, payloadStore, objectId: 'missing', outputKind: 'UNKNOWN' }), { code: 'BIZOP_OUTPUT_SCHEMA_UNKNOWN' });
  assert.equal(reads, 2, '元数据或源不存在时不读 manifest');
});
