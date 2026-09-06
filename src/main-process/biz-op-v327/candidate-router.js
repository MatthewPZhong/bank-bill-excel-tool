'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { setImmediate: yieldToMessages } = require('node:timers/promises');
const { createSynchronousCandidateWriter, chargeBindRow } = require('../../backend/sqlite-candidate-writer');
const { OP_COLUMNS, FLOW_COLUMNS, CELL_CONTRACT_VERSION, RULE_VERSION } = require('./import-adapter');
const { hash, fail } = require('./contracts');

const PART_TARGET_ROWS = 250000;
const PART_TARGET_BYTES = 256 * 1024 * 1024;
const ROUTE_METADATA_LIMIT = 4096;

function configure(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA encoding="UTF-8"; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-16384');
}
function tableFor(kind) { return kind === 'OP' ? 'op_check_rows' : 'flow_check_rows'; }
function createPartSchema(db, route, part, taskRunId) {
  const columns = route.kind === 'OP' ? OP_COLUMNS : FLOW_COLUMNS;
  db.exec(`CREATE TABLE part_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload_schema_version INTEGER NOT NULL,
    owner_id TEXT NOT NULL, part_kind TEXT NOT NULL, part_number INTEGER NOT NULL, producer_task_id TEXT NOT NULL,
    cell_contract_version TEXT NOT NULL, rule_version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('STAGING','SEALED')), row_count INTEGER NOT NULL);
    CREATE TABLE ${tableFor(route.kind)}(row_ordinal INTEGER PRIMARY KEY CHECK(row_ordinal>=1),
    ${columns.map((name) => `${name} TEXT NOT NULL${name === 'direction' ? " CHECK(direction IN ('入','出'))" : ''}`).join(',')},
    key_bu TEXT COLLATE BINARY NOT NULL, key_account TEXT COLLATE BINARY NOT NULL, key_currency TEXT COLLATE BINARY NOT NULL,
    source_artifact_id INTEGER NOT NULL CHECK(source_artifact_id>0), source_file_order INTEGER NOT NULL CHECK(source_file_order>=0),
    source_sheet TEXT NOT NULL, source_row INTEGER NOT NULL CHECK(source_row>=2));`);
  db.prepare('INSERT INTO part_meta VALUES (1,1,?,?,?,?,?,?,?,0)').run(route.objectId, `${route.kind}_CHECK`, part.number,
    taskRunId, CELL_CONTRACT_VERSION, RULE_VERSION, 'STAGING');
}

function createCandidateRouter({ payloadStore, taskRunId, intentDigest, safePoint = () => {},
  partTargetRows = PART_TARGET_ROWS, partTargetBytes = PART_TARGET_BYTES, writerOptions = {} }) {
  const routes = new Map();
  let current = null;
  let metadataEntries = 0;
  let stopped = false;
  const metrics = { openedConnections: 0, peakActiveConnections: 0, insertedRows: 0, committedTransactions: 0,
    peakTransactionChargedBytes: 0, parts: 0, indexMs: 0, sealMs: 0 };
  for (const limit of [partTargetRows, partTargetBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('分片目标必须是正安全整数');
  }
  function allocateMetadata() {
    if (++metadataEntries > ROUTE_METADATA_LIMIT) fail('BIZOP_ROUTE_METADATA_LIMIT', '候选路由元数据超过当前资源预算');
  }
  function closeCurrent() {
    if (!current) return;
    const { db, writer } = current;
    // finish 失败时也由当前所有者关闭连接；关闭失败直接终止，不能打开下一条连接。
    const errors = [];
    try {
      const state = writer.snapshot().state;
      const counters = ['READY', 'WRITING'].includes(state) ? writer.finish() : writer.snapshot();
      metrics.committedTransactions += counters.committedTransactions;
    } catch (error) { errors.push(error); }
    try { writer.close(); } catch (error) { errors.push(error); }
    try { db.close(); } catch (error) { errors.push(error); }
    current = null;
    if (errors.length) { stopped = true; throw new AggregateError(errors, '候选连接关闭未确认'); }
  }
  function newPart(route) {
    allocateMetadata();
    const number = route.parts.length + 1;
    const name = `part-${String(number).padStart(6, '0')}.sqlite`;
    const part = { number, name, rowCount: 0, path: path.join(route.directory, name), full: false };
    route.parts.push(part); metrics.parts += 1;
    return part;
  }
  function connect(route) {
    closeCurrent(); safePoint();
    let part = route.parts.at(-1);
    if (!part || part.full) part = newPart(route);
    const exists = fs.existsSync(part.path);
    const db = new DatabaseSync(part.path);
    try {
      configure(db);
      if (!exists) createPartSchema(db, route, part, taskRunId);
      const count = (route.kind === 'OP' ? OP_COLUMNS : FLOW_COLUMNS).length + 8;
      const writer = createSynchronousCandidateWriter({ ...writerOptions, db,
        insertSql: `INSERT INTO ${tableFor(route.kind)} VALUES (${Array(count).fill('?').join(',')})` });
      current = { route, part, db, writer };
      metrics.openedConnections += 1;
      metrics.peakActiveConnections = 1;
    } catch (error) { db.close(); throw error; }
  }
  function routeFor(row) {
    const key = `${row.kind}/${row.dataDate}`;
    if (!routes.has(key)) {
      allocateMetadata();
      const objectId = `candidate-${randomUUID()}`;
      // 先持久化归属，再创建/移动文件；反馈丢失时 Main 可完整发现动态账期候选。
      payloadStore.writeDocument(`operations/${taskRunId}/allocated-${objectId}.json`, { taskRunId, intentDigest, objectId });
      const candidate = payloadStore.prepareCandidate(taskRunId, objectId);
      routes.set(key, { kind: row.kind, dataDate: row.dataDate, objectId, directory: candidate.directory,
        rowCount: 0, parts: [], sources: new Map() });
    }
    return routes.get(key);
  }
  return Object.freeze({
    append(row, source) {
      if (stopped) fail('BIZOP_ROUTER_STOPPED');
      safePoint();
      const route = routeFor(row);
      if (!current || current.route !== route || current.part.full) connect(route);
      const values = [route.rowCount + 1, ...row.values, ...row.key,
        source.artifactId, source.order, source.sheetName, row.sourceRow];
      const before = current.writer.snapshot();
      const charge = chargeBindRow(values);
      const nextCharge = before.currentChargedBytes + charge;
      const acceptedCharge = nextCharge > (writerOptions.maxChargedBytesPerTransaction ?? 4194304) ? charge : nextCharge;
      current.writer.append(values);
      metrics.peakTransactionChargedBytes = Math.max(metrics.peakTransactionChargedBytes, acceptedCharge);
      route.rowCount += 1; current.part.rowCount += 1; metrics.insertedRows += 1;
      let sourceInfo = route.sources.get(source.artifactId);
      if (!sourceInfo) {
        allocateMetadata();
        sourceInfo = { artifactId: source.artifactId, sha256: source.sha256, order: source.order,
          sheetName: source.sheetName, bu: row.bu, rowCount: 0 };
        route.sources.set(source.artifactId, sourceInfo);
      }
      sourceInfo.rowCount += 1;
      if (current.part.rowCount >= partTargetRows || (current.writer.snapshot().currentRows === 0
          && fs.statSync(current.part.path).size >= partTargetBytes)) current.part.full = true;
    },
    reject() { stopped = true; closeCurrent(); },
    close: closeCurrent,
    snapshot: () => ({ ...metrics, routes: routes.size, metadataEntries }),
    async finish() {
      if (stopped) fail('BIZOP_ROUTER_STOPPED');
      closeCurrent();
      const references = [];
      for (const route of routes.values()) {
        for (const part of route.parts) {
          safePoint();
          const started = Date.now();
          const db = new DatabaseSync(part.path);
          try {
            configure(db);
            const table = tableFor(route.kind);
            const prefix = route.kind === 'OP' ? 'op' : 'flow';
            db.exec(`CREATE INDEX ${prefix}_rows_key ON ${table}(key_bu,key_account,key_currency,row_ordinal);
              CREATE INDEX ${prefix}_rows_source ON ${table}(source_artifact_id,source_sheet,source_row)`);
            const actual = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
            if (actual !== part.rowCount || Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') fail('BIZOP_CANDIDATE_SQLITE_INVALID');
            db.prepare("UPDATE part_meta SET state='SEALED',row_count=? WHERE singleton=1").run(actual);
          } finally { db.close(); }
          metrics.indexMs += Date.now() - started;
          await yieldToMessages();
        }
        safePoint();
        const sources = [...route.sources.values()].sort((a, b) => a.order - b.order);
        const sourceManifestDigest = hash({ version: 1, kind: route.kind, dataDate: route.dataDate, sources });
        const inputFingerprint = hash({ version: 1, kind: route.kind, dataDate: route.dataDate,
          cellContractVersion: CELL_CONTRACT_VERSION, ruleVersion: RULE_VERSION,
          sources: sources.map(({ sha256, sheetName, bu, rowCount }) => ({ sha256, sheetName, bu, rowCount }))
            .sort((a, b) => Buffer.compare(Buffer.from(a.sha256), Buffer.from(b.sha256))) });
        const started = Date.now();
        const token = await payloadStore.sealCandidate({ taskRunId, objectId: route.objectId, objectKind: 'DATASET', intentDigest,
          catalog: { kind: route.kind, dataDate: route.dataDate, sources, sourceManifestDigest, inputFingerprint,
            cellContractVersion: CELL_CONTRACT_VERSION, ruleVersion: RULE_VERSION },
          parts: route.parts.map(({ name, rowCount }) => ({ name, rowCount })) });
        references.push({ objectId: token.ref, digest: token.sha256 });
        metrics.sealMs += Date.now() - started;
        await yieldToMessages();
        safePoint();
      }
      stopped = true;
      return references;
    }
  });
}

module.exports = { createCandidateRouter, PART_TARGET_ROWS, PART_TARGET_BYTES, ROUTE_METADATA_LIMIT };
