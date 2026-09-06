'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { setImmediate: yieldToMessages } = require('node:timers/promises');
const { createSynchronousCandidateWriter } = require('../../backend/sqlite-candidate-writer');
const { readVerifiedManifest } = require('./payload-store');
const { CELL_CONTRACT_VERSION, RULE_VERSION } = require('./import-adapter');
const { RESULT_SCHEMA_VERSION } = require('./result-schema');
const { createResultSink, configure } = require('./result-sink');
const { intervalInputs, fingerprintOf } = require('./compute-inputs');
const { REASONS, DESCRIPTION_FIELDS, keyOf, compareKeys, createGroup, observe, observeDescription, finishGroup } = require('./compute-group');
const { count, hash, fail } = require('./contracts');

const WORK_SCHEMA = `CREATE TABLE working_observations(observation_ordinal INTEGER PRIMARY KEY,
  key_bu TEXT COLLATE BINARY NOT NULL,key_account TEXT COLLATE BINARY NOT NULL,key_currency TEXT COLLATE BINARY NOT NULL,
  role TEXT NOT NULL,balance_or_amount TEXT NOT NULL,direction TEXT,bu_display TEXT NOT NULL,entity TEXT,customer_no TEXT,account_type TEXT,
  source_dataset_id TEXT NOT NULL,source_row_ordinal INTEGER NOT NULL,source_artifact_id INTEGER NOT NULL,source_sheet TEXT NOT NULL,source_row INTEGER NOT NULL);
  CREATE TABLE working_description_values(key_bu TEXT COLLATE BINARY NOT NULL,key_account TEXT COLLATE BINARY NOT NULL,
  key_currency TEXT COLLATE BINARY NOT NULL,field_key TEXT NOT NULL,null_flag INTEGER NOT NULL,normalized_value TEXT COLLATE BINARY NOT NULL,
  in_start INTEGER NOT NULL,in_end INTEGER NOT NULL,
  PRIMARY KEY(key_bu,key_account,key_currency,field_key,null_flag,normalized_value)) WITHOUT ROWID`;
function openReadonly(filename) {
  const uri = pathToFileURL(filename); uri.searchParams.set('mode', 'ro'); uri.searchParams.set('immutable', '1');
  const db = new DatabaseSync(uri.href, { readOnly: true });
  db.exec('PRAGMA temp_store=FILE; PRAGMA cache_size=-16384');
  return db;
}
function identity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); }
async function verifyOriginal(source, safePoint) {
  const handle = await fs.promises.open(source.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== source.sizeBytes) fail('BIZOP_RUN_ORIGINAL_UNAVAILABLE');
    const digest = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) { safePoint(); digest.update(bytes); }
    if (digest.digest('hex') !== source.sha256 || identity(before) !== identity(await handle.stat())
        || identity(before) !== identity(await fs.promises.stat(source.filePath))) fail('BIZOP_RUN_ORIGINAL_UNAVAILABLE');
  } finally { await handle.close(); }
}
async function runComputePipeline({ payloadStore, taskRunId, intentDigest, candidateRef, inputReference, cancelToken, options = {} }) {
  const started = Date.now();
  const metrics = { inputRows: 0, opRows: 0, flowRows: 0, resultRows: 0, noteRows: 0,
    peakRssBytes: process.memoryUsage().rss, peakInputConnections: 0, peakWorkConnections: 1, peakOutputConnections: 0,
    loadMs: 0, indexMs: 0, groupMs: 0, resultCopyMs: 0, sealMs: 0 };
  function safePoint() {
    if (cancelToken?.cancelled) fail('BIZOP_CANCELLED');
  }
  const root = payloadStore.readDocument(inputReference.relativePath, inputReference.digest).value;
  if (root.taskRunId !== taskRunId || root.schemaVersion !== 1 || root.cellContractVersion !== CELL_CONTRACT_VERSION
      || root.ruleVersion !== RULE_VERSION || fingerprintOf(root) !== root.inputFingerprint) fail('BIZOP_COMPUTE_INPUT_MISMATCH');
  const required = intervalInputs(root.startDate, root.endDate);
  if (root.references.length !== required.length || root.inputs.length !== required.length
      || required.some((item, index) => item.role !== root.inputs[index].role || item.dataDate !== root.inputs[index].dataDate)) fail('BIZOP_RUN_INPUT_MISSING');
  const candidate = payloadStore.prepareCandidate(taskRunId, candidateRef);
  const work = payloadStore.prepareCandidate(taskRunId, `work-${candidateRef}`);
  const workFile = path.join(work.directory, 'observations.sqlite');
  const resultSpool = path.join(work.directory, 'results.jsonl');
  if (fs.existsSync(workFile) || fs.existsSync(resultSpool)) fail('BIZOP_COMPUTE_STAGE_EXISTS');
  const db = new DatabaseSync(workFile);
  let dbClosed = false; let spoolFd = null; let inputWriter = null;
  const sink = createResultSink({ directory: candidate.directory, taskRunId, objectId: candidateRef, safePoint,
    partTargetRows: options.partTargetRows, partTargetBytes: options.partTargetBytes });
  const inputById = new Map(); const verifiedOriginals = new Set();
  const reasonCounts = Object.fromEntries(REASONS.map(([code]) => [code, 0]));
  let diffCount = 0;
  function diskCheck() {
    safePoint();
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss);
    const stat = fs.statfsSync(payloadStore.root);
    if (stat.bavail * stat.bsize < 16 * 1024 * 1024) fail('BIZOP_DISK_SPACE_LOW', '临时目录可用空间不足，结果未发布');
  }
  try {
    diskCheck(); configure(db); db.exec(WORK_SCHEMA);
    inputWriter = createSynchronousCandidateWriter({ db, insertSql: `INSERT INTO working_observations VALUES (${Array(16).fill('?').join(',')})` });
    sink.note({ record_type: 'RUN_META', field_key: 'calculation', value_type: 'JSON', value_part: JSON.stringify({
      startDate: root.startDate, endDate: root.endDate, interval: '(S,E]', reverseFlow: '出-入', difference: '起始期末-(终止期末+出-入)',
      tolerance: '0.01', inputFingerprint: root.inputFingerprint, bus: root.bus, cellContractVersion: CELL_CONTRACT_VERSION, ruleVersion: RULE_VERSION }) });
    const loadStarted = Date.now();
    for (let index = 0; index < root.references.length; index += 1) {
      safePoint();
      const ref = root.references[index];
      const input = payloadStore.readDocument(ref.relativePath, ref.digest).value;
      const expected = root.inputs[index];
      if (Object.keys(expected).some((key) => expected[key] !== input[key]) || input.kind !== required[index].kind) fail('BIZOP_COMPUTE_INPUT_MISMATCH');
      inputById.set(input.datasetId, input);
      const sources = new Map(input.sources.map((source) => [source.artifactId, source]));
      const sourceCounts = new Map(input.sources.map((source) => [source.artifactId, 0]));
      for (const source of sources.values()) {
        if (!verifiedOriginals.has(source.artifactId)) { await verifyOriginal(source, safePoint); verifiedOriginals.add(source.artifactId); }
        const { filePath: _privatePath, ...publicSource } = source;
        sink.note({ record_type: 'INPUT_VERSION', source_role: input.role, source_dataset_id: input.datasetId,
          source_date: input.dataDate, source_version: input.inputVersion, source_artifact_id: source.artifactId,
          source_sheet: source.sheetName, field_key: 'input', value_type: 'JSON', value_part: JSON.stringify({ ...expected, source: publicSource }) });
      }
      const token = await payloadStore.verifyManifest(input.manifestRelativePath, input.manifestDigest);
      const manifest = readVerifiedManifest(token);
      if (manifest.objectId !== input.datasetId || manifest.rowCount !== input.rowCount || manifest.catalog.sourceManifestDigest !== input.sourceManifestDigest) fail('BIZOP_COMPUTE_INPUT_MISMATCH');
      let readRows = 0;
      for (let partIndex = 0; partIndex < manifest.parts.length; partIndex += 1) {
        diskCheck();
        const part = manifest.parts[partIndex];
        const filename = payloadStore.resolve(`${path.posix.dirname(input.manifestRelativePath)}/${part.name}`);
        const before = identity(fs.statSync(filename));
        const reader = openReadonly(filename); metrics.peakInputConnections = 1;
        let partRows = 0;
        try {
          const meta = reader.prepare('SELECT * FROM part_meta WHERE singleton=1').get();
          if (!meta || meta.owner_id !== input.datasetId || meta.state !== 'SEALED' || meta.row_count !== part.rowCount
              || meta.part_number !== partIndex + 1 || meta.payload_schema_version !== 1 || meta.part_kind !== `${input.kind}_CHECK`
              || meta.cell_contract_version !== CELL_CONTRACT_VERSION || meta.rule_version !== RULE_VERSION) fail('BIZOP_COMPUTE_PART_INVALID');
          const table = input.kind === 'OP' ? 'op_check_rows' : 'flow_check_rows';
          for (const row of reader.prepare(`SELECT * FROM ${table} ORDER BY row_ordinal`).iterate()) {
            const source = sources.get(row.source_artifact_id);
            if (!source || row.source_sheet !== source.sheetName || row.source_row < 2
                || row.row_ordinal !== readRows + 1 || row.key_bu !== source.bu
                || (input.kind === 'OP' ? row.billdate : row.bill_date) !== input.dataDate) fail('BIZOP_COMPUTE_SOURCE_MISMATCH');
            metrics.inputRows += 1; readRows += 1; partRows += 1;
            sourceCounts.set(source.artifactId, sourceCounts.get(source.artifactId) + 1);
            const op = input.kind === 'OP';
            inputWriter.append([metrics.inputRows, ...keyOf(row), input.role, op ? row.end_balance : row.recon_amount,
              op ? null : row.direction, op ? row.bu_name : row.bu_dept, op ? row.entity : null,
              op ? row.customer_no : null, op ? row.account_type : null, input.datasetId, row.row_ordinal,
              row.source_artifact_id, row.source_sheet, row.source_row]);
            if (op) metrics.opRows += 1; else metrics.flowRows += 1;
            if (metrics.inputRows % 1024 === 0) { await yieldToMessages(); diskCheck(); }
          }
          if (partRows !== part.rowCount) fail('BIZOP_ROW_COUNT_MISMATCH');
        } finally { reader.close(); }
        if (identity(fs.statSync(filename)) !== before) fail('BIZOP_PART_MISMATCH');
      }
      if (readRows !== input.rowCount || input.sources.some((source) => sourceCounts.get(source.artifactId) !== source.rowCount)) fail('BIZOP_ROW_COUNT_MISMATCH');
    }
    inputWriter.finish(); inputWriter.close(); inputWriter = null;
    metrics.loadMs = Date.now() - loadStarted;
    const indexStarted = Date.now();
    db.exec('CREATE INDEX observations_key ON working_observations(key_bu,key_account,key_currency,role,observation_ordinal)');
    for (const field of DESCRIPTION_FIELDS) {
      // 这一步由 SQLite FILE 临时排序完成；字段为冻结白名单，金额不参加 SQL 聚合。
      db.exec(`INSERT INTO working_description_values
        SELECT key_bu,key_account,key_currency,'${field}',CASE WHEN ${field} IS NULL OR ${field}='' THEN 1 ELSE 0 END,
        COALESCE(${field},''),MAX(role='START_OP'),MAX(role='END_OP') FROM working_observations WHERE role!='FLOW'
        GROUP BY key_bu,key_account,key_currency,CASE WHEN ${field} IS NULL OR ${field}='' THEN 1 ELSE 0 END,COALESCE(${field},'')`);
      await yieldToMessages(); diskCheck();
    }
    metrics.indexMs = Date.now() - indexStarted;
    const groupStarted = Date.now();
    spoolFd = fs.openSync(resultSpool, 'wx', 0o600);
    const descriptions = db.prepare('SELECT * FROM working_description_values ORDER BY key_bu,key_account,key_currency,field_key,null_flag,normalized_value').iterate();
    let nextDescription = descriptions.next();
    let group = null;
    async function completeGroup() {
      if (!group) return;
      while (!nextDescription.done && compareKeys(group.key, keyOf(nextDescription.value)) === 0) {
        observeDescription(group, nextDescription.value); nextDescription = descriptions.next();
        if ((group.START_OP.count + group.END_OP.count) > 1024 && descriptionsSeen++ % 1024 === 0) { await yieldToMessages(); safePoint(); }
      }
      const result = finishGroup(group, { startDate: root.startDate, endDate: root.endDate, rowOrdinal: metrics.resultRows + 1 });
      const line = JSON.stringify(result);
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) fail('BIZOP_RESULT_ROW_TOO_LARGE');
      fs.writeSync(spoolFd, `${line}\n`);
      metrics.resultRows += 1; diffCount += result.isDifference;
      for (const code of result.reasonCodes) reasonCounts[code] += 1;
      sink.note({ record_type: 'DESCRIPTION_SOURCE', result_row_ordinal: result.rowOrdinal, ...Object.fromEntries(
        ['key_bu', 'key_account', 'key_currency'].map((key, i) => [key, result.key[i]])), source_role: result.descriptionSourceRole,
      field_key: 'selection', value_type: 'JSON', value_part: JSON.stringify({ fields: result.description,
        counts: result.counts, reasonCodes: result.reasonCodes, rowLocator: String(result.rowOrdinal) }) });
    }
    let observationsSeen = 0; let descriptionsSeen = 0;
    try {
      for (const row of db.prepare('SELECT * FROM working_observations ORDER BY key_bu,key_account,key_currency,role,observation_ordinal').iterate()) {
        if (!group || compareKeys(group.key, keyOf(row)) !== 0) { await completeGroup(); group = createGroup(keyOf(row)); }
        observe(group, row);
        if (row.role !== 'FLOW') {
          const input = inputById.get(row.source_dataset_id);
          sink.note({ record_type: 'ROW_SOURCE', result_row_ordinal: metrics.resultRows + 1,
            key_bu: row.key_bu, key_account: row.key_account, key_currency: row.key_currency, source_role: row.role,
            source_artifact_id: row.source_artifact_id, source_dataset_id: input.datasetId, source_date: input.dataDate,
            source_version: input.inputVersion, source_sheet: row.source_sheet, source_row: row.source_row,
            field_key: 'op_values', value_type: 'JSON', value_part: JSON.stringify({ balance: row.balance_or_amount,
              entity: row.entity || null, customer_no: row.customer_no || null, account_type: row.account_type || null, bu: row.bu_display }) });
        }
        if (++observationsSeen % 1024 === 0) { await yieldToMessages(); diskCheck(); }
      }
      await completeGroup();
      if (!nextDescription.done || observationsSeen !== metrics.inputRows) fail('BIZOP_ROW_COUNT_MISMATCH');
    } finally { descriptions.return(); }
    fs.fsyncSync(spoolFd); fs.closeSync(spoolFd); spoolFd = null;
    sink.close(); db.close(); dbClosed = true;
    metrics.groupMs = Date.now() - groupStarted;
    const copyStarted = Date.now();
    const stream = fs.createReadStream(resultSpool);
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) fail('BIZOP_RESULT_ROW_TOO_LARGE');
        const result = JSON.parse(line); sink.result(result);
        if (result.rowOrdinal % 1024 === 0) { await yieldToMessages(); diskCheck(); }
      }
    } finally { lines.close(); stream.destroy(); await new Promise((resolve) => { if (stream.closed) resolve(); else stream.once('close', resolve); }); }
    const sealed = sink.finish();
    metrics.resultCopyMs = Date.now() - copyStarted;
    metrics.noteRows = sealed.noteCount; metrics.peakOutputConnections = sealed.peakOutputConnections;
    metrics.outputTransactions = sealed.transactions;
    if (sealed.resultCount !== metrics.resultRows) fail('BIZOP_ROW_COUNT_MISMATCH');
    fs.unlinkSync(resultSpool); fs.unlinkSync(workFile); fs.rmdirSync(work.directory);
    diskCheck();
    const sealStarted = Date.now();
    const token = await payloadStore.sealCandidate({ taskRunId, objectId: candidateRef, objectKind: 'RESULT', intentDigest,
      catalog: { startDate: root.startDate, endDate: root.endDate, inputs: root.inputs, bus: root.bus,
        originalDigests: root.originalDigests, inputFingerprint: root.inputFingerprint, ruleVersion: RULE_VERSION,
        cellContractVersion: CELL_CONTRACT_VERSION, resultSchemaVersion: RESULT_SCHEMA_VERSION,
        fullRowCount: metrics.resultRows, diffRowCount: diffCount, noteRowCount: metrics.noteRows, reasonCounts }, parts: sealed.parts });
    metrics.sealMs = Date.now() - sealStarted;
    safePoint(); metrics.elapsedMs = Date.now() - started;
    const result = { schemaVersion: 1, taskRunId, candidateRef, intentDigest, inputDigest: inputReference.digest,
      manifestDigest: token.sha256, metrics };
    const document = payloadStore.writeDocument(`operations/${taskRunId}/${candidateRef}.json`, result);
    // 所有工作句柄已关闭；仅移除已知空目录，失败候选仍由 Main 恢复。
    fs.rmdirSync(path.dirname(candidate.directory));
    return { contractVersion: 1, candidateRef, rowCount: metrics.resultRows, sha256: document.digest };
  } catch (error) {
    const errors = [error];
    try { inputWriter?.close(); } catch (closeError) { errors.push(closeError); }
    try { sink.close(); } catch (closeError) { errors.push(closeError); }
    if (spoolFd !== null) { try { fs.closeSync(spoolFd); } catch (closeError) { errors.push(closeError); } }
    if (!dbClosed) { try { db.close(); } catch (closeError) { errors.push(closeError); } }
    if (errors.length > 1) throw Object.assign(new AggregateError(errors, '计算失败且资源关闭未全部确认', { cause: error }), { code: error.code });
    throw error;
  }
}

module.exports = { runComputePipeline, openReadonly, verifyOriginal };
