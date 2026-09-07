'use strict';

const test = require('node:test');
const { durableDirectoryTest } = require('../../helpers/durable-directory-tests');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { registry, schemaFor, evidenceIdentity } = require('../../../src/main-process/biz-op-v327/export-cells');
const { freezeExportSource } = require('../../../src/main-process/biz-op-v327/export-inputs');
const { buildExportSource } = require('../../../src/main-process/biz-op-v327/export-source');
const { createBizOpPayloadStore, readVerifiedManifest } = require('../../../src/main-process/biz-op-v327/payload-store');
const { RESULT_SCHEMA, PART_SCHEMA, RESULT_COLUMNS, LEGACY_RESULT_SCHEMA_VERSION, RESULT_SCHEMA_VERSION,
  COMPUTE_RULE_VERSION } = require('../../../src/main-process/biz-op-v327/result-schema');
const { CELL_CONTRACT_VERSION, RULE_VERSION } = require('../../../src/main-process/biz-op-v327/import-adapter');

test('结果列版本 1 的表头与证据保留，版本 2 只改变第 14 列减法表头', () => {
  for (const kind of ['RESULT_FULL', 'RESULT_DIFF']) {
    const original = structuredClone(registry.outputKinds[kind]);
    const oldSchema = schemaFor(kind, 1); const newSchema = schemaFor(kind, 2);
    assert.deepEqual(oldSchema, original);
    assert.equal(oldSchema.columns[13].header, '终止期末＋合计流水');
    assert.equal(newSchema.columns[13].header, '终止期末－合计流水');
    const expected = { ...original, columnSchemaVersion: 2,
      columns: original.columns.map((column, index) => index === 13 ? { ...column, header: '终止期末－合计流水' } : column) };
    assert.deepEqual(newSchema, expected);
    assert.deepEqual(schemaFor(kind, 1), original, '派生新版不能修改旧 schema');
    const identity = evidenceIdentity({ outputKind: kind, columnSchemaVersion: 1, objectId: 'old-result',
      manifestDigest: '1'.repeat(64), maxRowsPerSheet: 1048575 });
    assert.deepEqual(identity, { evidenceVersion: 'bizop-v327-stream-v1', evidenceSchemaRevision: kind === 'RESULT_DIFF' ? 3 : 2,
      outputKind: kind, columnSchemaVersion: 1, cellContractVersion: CELL_CONTRACT_VERSION, ownerId: 'old-result',
      manifestDigest: '1'.repeat(64), maxRowsPerSheet: 1048575, notesSchemaVersion: kind === 'RESULT_DIFF' ? null : 1 });
    assert.notDeepEqual(evidenceIdentity({ ...identity, objectId: 'old-result', columnSchemaVersion: 2 }), identity);
    for (const version of [0, 3, '2', null]) assert.throws(() => schemaFor(kind, version), { code: 'BIZOP_OUTPUT_SCHEMA_UNKNOWN' });
  }
  for (const kind of ['OP_RAW', 'FLOW_RAW', 'OP_CHECK', 'FLOW_CHECK', 'ERRORS']) {
    assert.equal(schemaFor(kind, 1).columnSchemaVersion, 1);
    assert.throws(() => schemaFor(kind, 2), { code: 'BIZOP_OUTPUT_SCHEMA_UNKNOWN' });
  }
});

async function sealedResult(t, version, { partRuleVersion, catalogPatch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-export-rule-'));
  const payloadStore = createBizOpPayloadStore({ userDataDir: root }); payloadStore.initialize();
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const objectId = randomUUID(); const taskRunId = randomUUID();
  const candidate = payloadStore.prepareCandidate(taskRunId, objectId);
  const partPath = path.join(candidate.directory, 'part-000001.sqlite');
  const part = new DatabaseSync(partPath);
  const values = ['BU-A', '主体A', 'C001', '000123', '客资', 'USD', '2026-08-08', '1000', '2026-08-10', '1100',
    '200', '100', version === 1 ? '-100' : '100', '1000', '0', null, '否', '金额相等', null];
  const computeRuleVersion = version === 1 ? RULE_VERSION : COMPUTE_RULE_VERSION;
  try {
    part.exec(`${RESULT_SCHEMA};${PART_SCHEMA};`);
    part.prepare(`INSERT INTO result_rows VALUES (${Array(26).fill('?').join(',')})`)
      .run(1, ...values, 'bu-a', '000123', 'USD', 0, 0, 'END_OP');
    part.prepare(`INSERT INTO part_meta VALUES (${Array(10).fill('?').join(',')})`)
      .run(1, 1, objectId, 'RESULT', 1, taskRunId, CELL_CONTRACT_VERSION, partRuleVersion || computeRuleVersion, 'SEALED', 1);
  } finally { part.close(); }
  const inputs = [{ role: 'START_OP', dataDate: '2026-08-08', inputVersion: 1 }, { role: 'END_OP', dataDate: '2026-08-10', inputVersion: 2 }];
  const resultCatalog = { cellContractVersion: CELL_CONTRACT_VERSION, ruleVersion: RULE_VERSION,
    resultSchemaVersion: version === 1 ? LEGACY_RESULT_SCHEMA_VERSION : RESULT_SCHEMA_VERSION,
    ...(version === 2 ? { computeRuleVersion } : {}), inputs, noteRowCount: 0, diffRowCount: 0, ...catalogPatch };
  for (const key of Object.keys(resultCatalog)) if (resultCatalog[key] === undefined) delete resultCatalog[key];
  const manifest = readVerifiedManifest(await payloadStore.sealCandidate({ taskRunId, objectId, objectKind: 'RESULT',
    intentDigest: '1'.repeat(64), parts: [{ name: 'part-000001.sqlite', partKind: 'RESULT', rowCount: 1 }],
    catalog: resultCatalog }));
  db.exec(`CREATE TABLE biz_op_v327_runs(run_id TEXT,state TEXT,result_version INTEGER,start_date TEXT,end_date TEXT,
    input_fingerprint TEXT,published_at TEXT,payload_manifest_rel_path TEXT,payload_manifest_digest TEXT);
    CREATE TABLE biz_op_v327_run_inputs(run_id TEXT,role TEXT,input_version INTEGER);`);
  db.prepare('INSERT INTO biz_op_v327_runs VALUES (?,?,?,?,?,?,?,?,?)')
    .run(objectId, 'PUBLISHED', 1, '2026-08-08', '2026-08-10', '2'.repeat(64), '2026-09-07T00:00:00Z', manifest.relativePath, manifest.digest);
  for (const input of inputs) db.prepare('INSERT INTO biz_op_v327_run_inputs VALUES (?,?,?)').run(objectId, input.role, input.inputVersion);
  return { root, objectId, manifest, values, payloadStore, catalog: { db } };
}

function recordingSpool() {
  return { counts: { DATA: 0 }, rows: [], note() {}, precision() {}, data(values) { this.rows.push(values); this.counts.DATA += 1; } };
}

for (const version of [1, 2]) {
  durableDirectoryTest(`封存结果版本 ${version} 自动选择对应导出合同，显式错配及 worker 错配均拒绝`, async (t) => {
    const fixture = await sealedResult(t, version);
    const partPath = fixture.payloadStore.resolve(`results/${fixture.objectId}/part-000001.sqlite`);
    const before = fs.readFileSync(partPath);
    for (const outputKind of ['RESULT_FULL', 'RESULT_DIFF']) {
      const source = await freezeExportSource({ ...fixture, outputKind });
      assert.equal(source.columnSchemaVersion, version);
      assert.deepEqual(await freezeExportSource({ ...fixture, outputKind, columnSchemaVersion: version }), source);
      await assert.rejects(freezeExportSource({ ...fixture, outputKind, columnSchemaVersion: 3 - version }), { code: 'BIZOP_EXPORT_CONTRACT_MISMATCH' });
      const spool = recordingSpool();
      await buildExportSource({ ...fixture, source, spool, tempDirectory: fixture.root, safePoint() {} });
      assert.deepEqual(spool.rows.map((row) => row.map((cell) => cell.v)), outputKind === 'RESULT_FULL' ? [fixture.values] : []);
      const invalidSpool = recordingSpool();
      await assert.rejects(buildExportSource({ ...fixture, source: { ...source, columnSchemaVersion: 3 - version },
        spool: invalidSpool, tempDirectory: fixture.root, safePoint() {} }), { code: 'BIZOP_EXPORT_CONTRACT_MISMATCH' });
      assert.equal(invalidSpool.rows.length, 0);
    }
    assert.deepEqual(fs.readFileSync(partPath), before, '导出读取不能改写封存结果');
    assert.equal(RESULT_COLUMNS.length, 19);
  });

  durableDirectoryTest(`封存结果版本 ${version} 拒绝同一 manifest 下混入其他计算规则的分片`, async (t) => {
    const fixture = await sealedResult(t, version, { partRuleVersion: version === 1 ? COMPUTE_RULE_VERSION : RULE_VERSION });
    const source = await freezeExportSource({ ...fixture, outputKind: 'RESULT_FULL' });
    const spool = recordingSpool();
    await assert.rejects(buildExportSource({ ...fixture, source, spool, tempDirectory: fixture.root, safePoint() {} }), { code: 'BIZOP_EXPORT_PART_INVALID' });
    assert.equal(spool.rows.length, 0);
  });
}

durableDirectoryTest('未知或缺失计算规则的结果合同不能被默认解释成旧版', async (t) => {
  for (const catalogPatch of [{ resultSchemaVersion: 'bizop-result-unknown' }, { computeRuleVersion: undefined }, { computeRuleVersion: RULE_VERSION }]) {
    const fixture = await sealedResult(t, 2, { catalogPatch });
    await assert.rejects(freezeExportSource({ ...fixture, outputKind: 'RESULT_FULL' }), { code: 'BIZOP_RESULT_CONTRACT_UNKNOWN' });
  }
});
