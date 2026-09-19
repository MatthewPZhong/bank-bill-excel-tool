'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { setImmediate: yieldMessages } = require('node:timers/promises');
const { createArchiveRepository } = require('../database/archive-repository');
const { SOURCE_TYPES, SOURCE_LABELS, SUPPORTED_CURRENCIES, SYSTEM_OP_HEADERS, SYSTEM_OP_DEFINITION,
  getRawContractHeaders, normalizeLegacyStoredCurrency, headersEqual } = require('./definitions');
const { assertArtifactMember, readHandoffMetadata } = require('./import-handoff');
const { projectReview } = require('../../shared/vcc-review-projection');
const { isEffectiveDifferenceZero } = require('../../shared/vcc-financial-op-difference');
const { mapDetailRow, pendingCanonicalValues, monthOfDate } = require('./row-mapper');
const { systemAmountRead, systemOpCellValues } = require('./system-op-importer');
const { cellValueFromBody } = require('../big-table-import/row-scanner');
const { assertMappedLineage } = require('../../main-process/vcc-financial-op-dataset-writer');
const { hashSourceFile } = require('./source-lineage');
const { openRichWorkbook } = require('../xlsx-rich-reader');
const { assertReviewFresh, framedDigest, rawCell, historicCell, comparableCell, reviewError } = require('./review-export-contract');

const TYPES = Object.values(SOURCE_TYPES);
const MAX_DATA_ROWS = 1048575;
const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const unavailable = (message) => reviewError('vcc-review-source-unavailable', message);
const mismatch = (message) => reviewError('vcc-review-validation-failed', message);
function safePoint(signal) { if (signal?.aborted) throw signal.reason || reviewError('vcc-review-cancelled', '已取消导出'); }
function parse(value, label) { try { return JSON.parse(value); } catch (_error) { throw unavailable(`${label} 无法解析`); } }
function rawHeaders(type, version) {
  const headers = type === SOURCE_TYPES.SYSTEM_OP && Number(version) === 1 ? SYSTEM_OP_HEADERS
    : getRawContractHeaders(type, version);
  if (!headers || (type !== SOURCE_TYPES.PENDING && Number(version) !== 1)) throw unavailable(`${type} 原始结构版本 ${version} 不受支持`);
  return [...headers];
}
function assertHistoricalSource(db, record, source) {
  if (!source && db.prepare('SELECT 1 FROM vcc_fin_op_import_sources WHERE import_record_id=? LIMIT 1').get(record.id)) {
    throw unavailable(`导入记录 ${record.id} 已有来源记录，事实的来源关联已丢失`);
  }
  if (source && db.prepare(`SELECT 1 FROM archive_artifact_holds WHERE owner_module='vcc-financial-op'
    AND owner_type='vcc-import-source' AND owner_id=? LIMIT 1`).get(String(source.id))) {
    throw unavailable(`导入来源 ${source.id} 仍有原件保护关系，不能降级读取历史值`);
  }
  // NULL 外键或被清空的 source 字段不是“从未绑定”的证据。
  // 同一导入审计下的持久 artifact 成员仍然具有权威性，不在只读导出中修复关系。
  const artifacts = db.prepare(`SELECT a.id,a.metadata_json FROM archive_artifacts a
    JOIN archive_batches b ON b.id=a.batch_id
    WHERE b.module_id='vcc-financial-op' AND b.task_run_id=? AND a.direction='input'
      AND a.source_operation='vccFinancialOp:import:apply'
      AND (a.status='ready' OR a.blob_id IS NOT NULL OR a.archived_at IS NOT NULL)`).all(record.batch_id);
  for (const artifact of artifacts) {
    const metadata = parse(artifact.metadata_json, `原件 ${artifact.id} 成员`);
    let belongs;
    if (metadata?.vccImportHandoffVersion === 2) {
      const handoff = readHandoffMetadata(metadata);
      belongs = handoff.vccSourceMembers.some((member) => member.sourceType === record.source_type
        && (!source || member.sourceOrdinal === Number(source.source_ordinal)));
    } else {
      const sameOrdinal = !source || metadata?.vccSourceOrdinal == null
        || Number(metadata.vccSourceOrdinal) === Number(source.source_ordinal);
      belongs = (Number(metadata?.vccImportRecordId) === Number(record.id) && sameOrdinal)
        || (source && Number(metadata?.vccImportSourceId) === Number(source.id))
        || (metadata?.vccSourceType === record.source_type && sameOrdinal);
      if (!metadata?.vccSourceType && !metadata?.vccImportRecordId) {
        throw unavailable(`导入记录 ${record.id} 存在无法排除的原件绑定证据`);
      }
    }
    if (belongs) throw unavailable(`导入记录 ${record.id} 已有原件 ${artifact.id} 成员，不能降级读取历史值`);
  }
}
function managedPath(root, relative) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof relative !== 'string'
      || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw unavailable('存档原件路径不合法');
  const result = path.resolve(root, relative);
  if (!result.startsWith(`${path.resolve(root)}${path.sep}`)) throw unavailable('存档原件越出受管目录');
  return result;
}
function createManifest(filePath) {
  fs.closeSync(fs.openSync(filePath, 'wx', 0o600));
  const db = new DatabaseSync(filePath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sources (source_key TEXT PRIMARY KEY, descriptor TEXT NOT NULL);
    CREATE TABLE facts (identity TEXT PRIMARY KEY, source_key TEXT NOT NULL, sheet_name TEXT NOT NULL,
      sheet_index INTEGER NOT NULL, source_row INTEGER NOT NULL, record_id INTEGER NOT NULL, source_ordinal INTEGER NOT NULL,
      payload TEXT NOT NULL, historic_values TEXT, FOREIGN KEY(source_key) REFERENCES sources(source_key));
    CREATE INDEX facts_coordinate ON facts(source_key, sheet_index, source_row, identity);
    CREATE TABLE groups (group_key TEXT PRIMARY KEY, subject_order INTEGER, currency_order INTEGER, type_order INTEGER,
      raw_version INTEGER, header_fingerprint TEXT, descriptor TEXT NOT NULL);
    CREATE TABLE expected (group_key TEXT NOT NULL, identity TEXT NOT NULL, ordinal INTEGER,
      PRIMARY KEY(group_key,identity), FOREIGN KEY(group_key) REFERENCES groups(group_key), FOREIGN KEY(identity) REFERENCES facts(identity));
    CREATE UNIQUE INDEX expected_order ON expected(group_key,ordinal);
    CREATE TABLE pages (id INTEGER PRIMARY KEY, group_key TEXT NOT NULL, name TEXT NOT NULL UNIQUE, part INTEGER NOT NULL,
      start_ordinal INTEGER NOT NULL, row_count INTEGER NOT NULL, identity_digest TEXT NOT NULL);
    CREATE TABLE actual (identity TEXT PRIMARY KEY, cells TEXT NOT NULL, FOREIGN KEY(identity) REFERENCES facts(identity));
    CREATE TABLE page_actual (page_id INTEGER PRIMARY KEY, row_count INTEGER NOT NULL, identity_digest TEXT NOT NULL,
      content_digest TEXT NOT NULL, FOREIGN KEY(page_id) REFERENCES pages(id));`);
  return db;
}
function setMeta(db, key, value) { db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
function getMeta(db, key) { const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? parse(row.value, key) : null; }
function sheetName(full, key, part, parts, used) {
  const base = full.replace(/[\u0000-\u001f\u007f\\/:?*\[\]]/g, '-').replace(/^'+|'+$/g, '') || '原表';
  const tail = parts > 1 ? `-p${part}` : '';
  const truncate = (value, length) => { let out = ''; for (const char of value) { if (out.length + char.length > length) break; out += char; } return out; };
  const legal = (name) => name.length <= 31 && !used.has(name.toLowerCase()) && !['history', '待确认表'].includes(name.toLowerCase());
  let name = `${base}${tail}`;
  if (!legal(name)) {
    const digest = sha(key);
    for (let length = 6; length <= 12; length += 2) {
      const suffix = `-${digest.slice(0, length)}${tail}`;
      name = `${truncate(base, 31 - suffix.length)}${suffix}`;
      if (legal(name)) break;
    }
    let serial = 1;
    while (!legal(name)) { const suffix = `-${digest.slice(0, 12)}-${serial++}${tail}`; name = `${truncate(base, 31 - suffix.length)}${suffix}`; }
  }
  used.add(name.toLowerCase()); return name;
}

async function prepareReviewManifest({ dbPath, manifestPath, request, archiveRoot, appVersion, signal, onProgress }) {
  const manifest = createManifest(manifestPath);
  let business;
  try {
    business = new DatabaseSync(dbPath, { readOnly: true });
    business.exec('PRAGMA query_only=ON; BEGIN');
    const effective = assertReviewFresh(business, request, { effective: true });
    const projection = projectReview(effective.review);
    if (projection.rowCount > MAX_DATA_ROWS + 1) throw reviewError('vcc-review-result-too-large', '完整确认页超过 Excel 行容量，无法导出');
    const provenance = { schemaVersion: 1, runId: request.runId, resultRevision: request.expectedResultRevision,
      inputFingerprint: request.expectedInputFingerprint, exportedAt: new Date().toISOString(), appVersion: String(appVersion) };
    setMeta(manifest, 'projection', projection); setMeta(manifest, 'provenance', provenance);
    setMeta(manifest, 'run', effective.run); setMeta(manifest, 'request', request);
    const coordinates = new Map(effective.review.subjects.map((subject, subjectOrder) => [subject.subject, {
      subjectOrder, currencies: SUPPORTED_CURRENCIES.filter((currency) => !isEffectiveDifferenceZero(subject.summaries.effectiveDifference[currency]))
    }]));
    const archive = createArchiveRepository(business);
    const sources = new Map();
    const knownInputPaths = new Set(business.prepare(`SELECT DISTINCT a.source_path FROM archive_artifacts a
      JOIN vcc_fin_op_import_sources s ON s.archive_artifact_id=a.id
      JOIN vcc_fin_op_import_records r ON r.id=s.import_record_id
      WHERE r.target_month=? AND a.source_path<>''`).all(effective.run.targetMonth).map((row) => row.source_path));
    const sourceFor = (fact, type) => {
      const record = business.prepare('SELECT * FROM vcc_fin_op_import_records WHERE id=?').get(fact.import_record_id);
      if (!record || record.source_type !== type || record.target_month !== effective.run.targetMonth
          || !['success', 'success_with_skips', 'all_skipped'].includes(record.status)) throw unavailable(`事实 ${fact.id} 缺少合法导入审计关系`);
      const sourceId = Number(fact.import_source_id);
      if (sourceId && sources.has(sourceId)) {
        const cached = sources.get(sourceId);
        if (Number(cached.source.import_record_id) !== Number(record.id)) throw unavailable('事实来源与导入记录不符');
        return cached;
      }
      let source = sourceId ? business.prepare('SELECT * FROM vcc_fin_op_import_sources WHERE id=?').get(sourceId) : null;
      if (sourceId && (!source || Number(source.import_record_id) !== Number(record.id))) throw unavailable(`导入来源 ${sourceId} 已丢失或归属不符`);
      let descriptor;
      if (source && (source.archive_artifact_id || source.bound_at || source.archive_state === 'ready')) {
        if (!source.archive_artifact_id || source.archive_state !== 'ready') throw unavailable(`导入来源 ${sourceId} 绑定尚未完成或已损坏`);
        const artifact = archive.getArtifact(source.archive_artifact_id);
        const batch = artifact ? archive.getBatch(artifact.batchId) : null;
        if (!artifact || artifact.status !== 'ready' || !artifact.blob || batch?.taskRunId !== record.batch_id
            || batch?.moduleId !== 'vcc-financial-op' || artifact.direction !== 'input'
            || artifact.sourceOperation !== 'vccFinancialOp:import:apply'
            || artifact.blob.sha256 !== source.source_sha256 || artifact.blob.sizeBytes !== Number(source.source_size_bytes)) throw unavailable(`导入来源 ${sourceId} 原件身份或 SHA/大小不符`);
        let member = null;
        if (artifact.metadata?.vccImportHandoffVersion === 2) member = assertArtifactMember(artifact, { ...source, ...record, id: source.id,
          import_record_id: record.id, source_type: type, batch_id: record.batch_id }, batch);
        else {
          const metadata = artifact.metadata || {};
          const direct = Number(metadata.vccImportSourceId) === sourceId && Number(metadata.vccImportRecordId) === Number(record.id);
          const legacy = metadata.vccImportHandoffVersion === 1 && metadata.vccSourceType === type
            && (metadata.vccTaskRunId || metadata.vccImportBatchId) === record.batch_id;
          if ((!direct && !legacy) || Number(metadata.vccSourceOrdinal) !== Number(source.source_ordinal)
              || artifact.originalName !== source.source_file_name) throw unavailable(`导入来源 ${sourceId} 旧版成员身份缺失或不符`);
        }
        const sourceKey = `artifact:${artifact.id}`;
        const file = { mode: 'artifact', sourceKey, artifactId: artifact.id, filePath: managedPath(archiveRoot, artifact.blob.relativePath),
          archiveRoot, sha256: source.source_sha256, sizeBytes: Number(source.source_size_bytes), originalPath: artifact.sourcePath };
        manifest.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(sourceKey, JSON.stringify(file));
        if (artifact.sourcePath) knownInputPaths.add(artifact.sourcePath);
        descriptor = { sourceKey, member, sourceOrdinal: Number(source.source_ordinal), source };
      } else {
        assertHistoricalSource(business, record, source);
        const sourceKey = source ? `fallback:${sourceId}` : `legacy:${record.id}`;
        manifest.prepare('INSERT OR IGNORE INTO sources VALUES (?,?)').run(sourceKey, JSON.stringify({ mode: source ? 'fallback' : 'legacy', sourceKey }));
        descriptor = { sourceKey, member: null, sourceOrdinal: source ? Number(source.source_ordinal) : 0, source };
      }
      if (sourceId) sources.set(sourceId, descriptor);
      return descriptor;
    };
    const add = (fact, type, identity, currencyHits, extra = {}) => {
      const version = type === SOURCE_TYPES.SYSTEM_OP ? 1 : Number(fact.raw_contract_version);
      const headers = rawHeaders(type, version);
      const descriptor = sourceFor(fact, type);
      const sheet = descriptor.member?.sheets.find((s) => s.sheetName === fact.sheet_name);
      if (descriptor.member && (!sheet || sheet.rawContractVersion !== version
          || (type === SOURCE_TYPES.CHANNEL && sheet.subject !== fact.subject))) throw unavailable(`来源 ${fact.import_source_id} 的 Sheet 或主体不在冻结成员中`);
      const sourceRow = extra.sourceRow ?? Number(fact.source_row);
      if (!Number.isSafeInteger(sourceRow) || sourceRow < 1 || typeof fact.sheet_name !== 'string' || !fact.sheet_name) throw unavailable(`事实 ${identity} 原始坐标无效`);
      let historical = null;
      if (!descriptor.sourceKey.startsWith('artifact:')) {
        if (type === SOURCE_TYPES.SYSTEM_OP) historical = extra.systemRow.rawValues || extra.systemRow.displayValues;
        else if (descriptor.source) {
          const fallback = business.prepare('SELECT * FROM vcc_fin_op_effective_raw_fallback WHERE effective_row_id=?').get(fact.id);
          if (!fallback || Number(fallback.import_source_id) !== Number(descriptor.source.id) || Number(fallback.raw_contract_version) !== version) throw unavailable(`事实 ${identity} 没有合法 fallback`);
          historical = parse(fallback.raw_json, identity);
        } else historical = parse(fact.raw_json, identity);
        if (!Array.isArray(historical) || historical.length !== headers.length) throw unavailable(`事实 ${identity} 历史原始值不完整`);
      }
      const payload = { ...fact, source_type: type, headers, raw_contract_version: version,
        expectedHeaderRow: sheet?.headerRow || extra.headerRow || null, verifiedSheetIndex: sheet?.sheetIndex ?? null,
        systemAuditContract: type === SOURCE_TYPES.SYSTEM_OP ? (descriptor.member ? 'rich-v1' : 'sheetjs-v1') : null, ...extra };
      manifest.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?,?)').run(identity, descriptor.sourceKey, fact.sheet_name,
        sheet?.sheetIndex ?? 0, sourceRow, Number(fact.import_record_id), descriptor.sourceOrdinal, JSON.stringify(payload), historical === null ? null : JSON.stringify(historical));
      const coordinate = coordinates.get(fact.subject);
      for (const currency of currencyHits) {
        const headerFingerprint = sha(JSON.stringify(headers));
        const groupKey = JSON.stringify([fact.subject, currency, type, version, headerFingerprint]);
        const group = { subject: fact.subject, currency, sourceType: type, rawContractVersion: version, headers,
          headerFingerprint, fullLogicalName: `${fact.subject}-${currency}-${SOURCE_LABELS[type]}` };
        manifest.prepare('INSERT OR IGNORE INTO groups VALUES (?,?,?,?,?,?,?)').run(groupKey, coordinate.subjectOrder,
          SUPPORTED_CURRENCIES.indexOf(currency), TYPES.indexOf(type), version, headerFingerprint, JSON.stringify(group));
        manifest.prepare('INSERT INTO expected VALUES (?,?,NULL)').run(groupKey, identity);
      }
    };
    manifest.exec('BEGIN');
    let factCount = 0;
    for (const fact of business.prepare('SELECT * FROM vcc_fin_op_effective_rows WHERE target_month=? ORDER BY id').iterate(effective.run.targetMonth)) {
      if (++factCount % 512 === 0) { safePoint(signal); await yieldMessages(); }
      const coordinate = coordinates.get(fact.subject);
      if (!coordinate?.currencies.length) continue;
      const currencies = fact.source_type === SOURCE_TYPES.PENDING
        ? [normalizeLegacyStoredCurrency(fact.flow_currency), normalizeLegacyStoredCurrency(fact.pending_currency)]
        : [normalizeLegacyStoredCurrency(fact.stat_currency)];
      const hits = coordinate.currencies.filter((currency) => currencies.includes(currency));
      if (hits.length) add(fact, fact.source_type, `D:${fact.id}`, hits);
    }
    for (const snapshot of business.prepare('SELECT * FROM vcc_fin_op_system_snapshots WHERE target_month=? ORDER BY id').iterate(effective.run.targetMonth)) {
      const coordinate = coordinates.get(snapshot.subject);
      if (!coordinate?.currencies.length) continue;
      const raw = parse(snapshot.raw_json, `系统快照 ${snapshot.id}`), balances = parse(snapshot.balances_json, '系统余额');
      const canonicalBalances = Object.fromEntries(SUPPORTED_CURRENCIES.map((currency) => [currency, balances[currency]]));
      if (!headersEqual(raw?.displayHeaders, SYSTEM_OP_HEADERS) || raw.rows?.length !== 9 || Object.keys(balances).length !== 9
          || sha(JSON.stringify({ targetMonth: snapshot.target_month, subject: snapshot.subject, balances: canonicalBalances })) !== snapshot.content_hash) throw unavailable(`系统快照 ${snapshot.id} 结构或内容哈希不符`);
      const seen = new Set();
      for (const row of raw.rows) {
        const currency = normalizeLegacyStoredCurrency(row.normalizedCurrency);
        if (!SUPPORTED_CURRENCIES.includes(currency) || seen.has(currency)) throw unavailable(`系统快照 ${snapshot.id} 币种原行不完整`);
        seen.add(currency);
        add(snapshot, SOURCE_TYPES.SYSTEM_OP, `S:${snapshot.id}:${row.sourceRow}`, coordinate.currencies.includes(currency) ? [currency] : [],
          { sourceRow: row.sourceRow, systemRow: row, systemCurrency: currency, expectedBalance: balances[currency], headerRow: raw.headerRow });
      }
    }
    safePoint(signal);
    setMeta(manifest, 'knownInputPaths', [...knownInputPaths]);
    manifest.exec('COMMIT'); business.exec('COMMIT'); business.close(); business = null;
    await freezeExpectedPages(manifest, MAX_DATA_ROWS, signal);
    onProgress?.({ phase: 'preparing-result', rows: factCount });
    return { provenance, subjectCount: projection.blocks.length, knownInputPaths: [...knownInputPaths] };
  } finally {
    if (business) { try { business.exec('ROLLBACK'); } catch (_error) { /* no active snapshot */ } business.close(); }
    manifest.close();
  }
}

async function freezeExpectedPages(db, maxRows = MAX_DATA_ROWS, signal) {
  const used = new Set(['待确认表']);
  db.exec('BEGIN');
  try {
    for (const group of db.prepare('SELECT * FROM groups ORDER BY subject_order,currency_order,type_order,raw_version,header_fingerprint').all()) {
      const count = db.prepare('SELECT COUNT(*) n FROM expected WHERE group_key=?').get(group.group_key).n;
      const parts = Math.ceil(count / maxRows); let ordinal = 0, digest = framedDigest(), part = 1, inPage = 0;
      const descriptor = parse(group.descriptor, '附页分组');
      for (const entry of db.prepare(`SELECT e.identity FROM expected e JOIN facts f ON f.identity=e.identity
        WHERE e.group_key=? ORDER BY f.record_id,f.source_ordinal,f.sheet_index,f.source_row,f.identity`).iterate(group.group_key)) {
        ordinal += 1; inPage += 1;
        if (ordinal % 512 === 0) { safePoint(signal); await yieldMessages(); }
        db.prepare('UPDATE expected SET ordinal=? WHERE group_key=? AND identity=?').run(ordinal, group.group_key, entry.identity);
        digest.add([group.group_key, ordinal, entry.identity]);
        if (inPage === maxRows || ordinal === count) {
          db.prepare('INSERT INTO pages(group_key,name,part,start_ordinal,row_count,identity_digest) VALUES (?,?,?,?,?,?)').run(group.group_key,
            sheetName(descriptor.fullLogicalName, group.group_key, part, parts, used), part, ordinal - inPage + 1, inPage, digest.finish());
          part += 1; inPage = 0; digest = framedDigest();
        }
      }
    }
    for (const table of ['sources', 'facts', 'groups', 'expected', 'pages']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER frozen_${table}_${operation} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'frozen review manifest'); END`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function validateRawFact(fact, values, cells) {
  const expected = parse(fact.payload, fact.identity);
  if (values.length !== expected.headers.length) throw mismatch(`${fact.identity} 原始列数不符`);
  if (expected.source_type === SOURCE_TYPES.SYSTEM_OP) {
    const ix = SYSTEM_OP_DEFINITION.indexes;
    const stored = expected.systemRow;
    const criticalIndexes = ['主体', '币种', '业务部门', '账单日期', SYSTEM_OP_DEFINITION.balanceHeader].map((header) => ix[header]);
    if (criticalIndexes.some((index) => cells?.[index]?.cellType === 'error')) throw mismatch(`${fact.identity} 系统 OP 计算字段包含错误值`);
    // 归属按导入时的显示值解释；下面仍独立核验原始值，输出继续使用原件单元格。
    const displayValues = cells ? expected.headers.map((_header, index) => cells[index]
      ? systemOpCellValues(cells[index], { legacySheetJsDisplay: expected.systemAuditContract === 'sheetjs-v1' }).display : '')
      : stored.displayValues;
    const currency = normalizeLegacyStoredCurrency(String(displayValues[ix['币种']] ?? '').trim());
    if (String(displayValues[ix['主体']] ?? '').trim() !== expected.subject || currency !== expected.systemCurrency
        || String(displayValues[ix['业务部门']] ?? '').trim() !== 'VCC'
        || (monthOfDate(displayValues[ix['账单日期']]) || monthOfDate(values[ix['账单日期']])) !== expected.target_month) throw mismatch(`${fact.identity} 系统 OP 主体/币种/账期不符`);
    const balanceIndex = ix[SYSTEM_OP_DEFINITION.balanceHeader];
    const original = cells?.[balanceIndex];
    const balance = systemAmountRead(stored.displayValues[balanceIndex], original?.cellType === 'number' ? Number(original.rawLexicalValue) : values[balanceIndex],
      { rawLexicalToken: original?.cellType === 'number' ? original.rawLexicalValue : undefined });
    if (balance.canonicalValue !== expected.expectedBalance) throw mismatch(`${fact.identity} 系统 OP 余额与有效快照不符`);
    for (let index = 0; index < values.length; index += 1) {
      if (index === balanceIndex) continue;
      const historical = stored.rawValues?.[index] ?? stored.displayValues[index];
      // 旧 SheetJS 审计将原生错误单元格记为空；仅兼容经过原件身份核验的旧来源。
      // 主体、币种、部门、账期和余额仍须通过上面的业务核验，附页继续使用原件错误码。
      if (expected.systemAuditContract === 'sheetjs-v1' && cells?.[index]?.cellType === 'error'
          && stored.rawValues?.[index] === '' && stored.displayValues?.[index] === '') continue;
      if (typeof historical === 'number' && cells?.[index]?.cellType === 'number') {
        if (Number(cells[index].rawLexicalValue) !== historical) throw mismatch(`${fact.identity} 原始列 ${index + 1} 不符`);
      } else if (String(values[index] ?? '') !== String(historical ?? '')) throw mismatch(`${fact.identity} 原始列 ${index + 1} 不符`);
    }
  } else {
    const mappingValues = expected.source_type === SOURCE_TYPES.PENDING ? pendingCanonicalValues(values, expected.raw_contract_version) : values;
    const mapped = mapDetailRow({ sourceType: expected.source_type, values: mappingValues, targetMonth: expected.target_month,
      assignedSubject: expected.subject, sourceFile: '', sheetName: fact.sheet_name, sourceRow: fact.source_row });
    assertMappedLineage(expected, mapped);
    if (expected.subject !== mapped.subject) throw mismatch(`${fact.identity} subject 与原表不符`);
    for (const key of ['stat_currency', 'pending_currency', 'flow_currency']) {
      const property = { stat_currency: 'statCurrency', pending_currency: 'pendingCurrency', flow_currency: 'flowCurrency' }[key];
      if (expected[key] != null && normalizeLegacyStoredCurrency(expected[key]) !== mapped[property]) throw mismatch(`${fact.identity} ${key} 与原表不符`);
    }
  }
  return expected;
}

async function extractReviewSources({ manifestPath, signal, onProgress }) {
  const db = new DatabaseSync(manifestPath); let scannedFiles = 0, extracted = 0;
  try {
    for (const sourceRow of db.prepare('SELECT * FROM sources ORDER BY source_key').all()) {
      safePoint(signal); const source = parse(sourceRow.descriptor, sourceRow.source_key);
      const save = (fact, values, cells) => {
        safePoint(signal);
        const expected = validateRawFact(fact, values, cells);
        const output = cells ? expected.headers.map((header, index) => rawCell(cells[index], header)) : values.map(historicCell);
        db.prepare('INSERT INTO actual VALUES (?,?)').run(fact.identity, JSON.stringify(output)); extracted += 1;
      };
      db.exec('BEGIN');
      try {
        if (source.mode !== 'artifact') {
          for (const fact of db.prepare('SELECT * FROM facts WHERE source_key=? ORDER BY sheet_index,source_row,identity').iterate(source.sourceKey)) {
            save(fact, parse(fact.historic_values, fact.identity), null);
            if (extracted % 512 === 0) await yieldMessages();
          }
        } else {
          const originalStat = fs.lstatSync(source.filePath);
          if (!originalStat.isFile() || originalStat.isSymbolicLink()
              || !fs.realpathSync(source.filePath).startsWith(`${fs.realpathSync(source.archiveRoot)}${path.sep}`)) throw unavailable('存档原件不是受管普通文件');
          const fingerprint = await hashSourceFile(source.filePath);
          if (fingerprint.sha256 !== source.sha256 || fingerprint.sizeBytes !== source.sizeBytes) throw reviewError('archive-integrity-failure', `原件 ${source.artifactId} 内容已损坏`);
          const workbook = await openRichWorkbook(source.filePath, { memoryBudgetBytes: 64 * 1024 * 1024,
            cacheMaxBytes: 64 * 1024 * 1024,
            cancelToken: { get cancelled() { return !!signal?.aborted; } } });
          try {
            const sheets = db.prepare('SELECT DISTINCT sheet_name,sheet_index FROM facts WHERE source_key=? ORDER BY sheet_index').all(source.sourceKey);
            for (const selected of sheets) {
              const index = workbook.sheets.findIndex((sheet) => sheet.name === selected.sheet_name);
              if (index < 0) throw unavailable(`原件 ${source.artifactId} 缺少 ${selected.sheet_name}`);
              const iterator = db.prepare('SELECT * FROM facts WHERE source_key=? AND sheet_name=? ORDER BY source_row,identity').iterate(source.sourceKey, selected.sheet_name);
              let next = iterator.next(), headerSeen = false;
              const descriptor = parse(next.value.payload, next.value.identity);
              let importValues = [];
              // v1 has a single business Sheet and no persisted workbook ordinal.
              if (descriptor.verifiedSheetIndex !== null && descriptor.verifiedSheetIndex !== index) throw unavailable('原 Sheet 序号不符');
              try {
                await workbook.scanSheet(index, (row) => {
                  const cells = []; for (const cell of row.cells) cells[cell.columnIndex] = cell;
                  const values = descriptor.headers.map((_header, column) => {
                    const cell = cells[column];
                    if (descriptor.source_type !== SOURCE_TYPES.SYSTEM_OP) return importValues[column] ?? '';
                    return !cell || cell.cellType === 'blank' ? '' : systemOpCellValues(cell).raw;
                  });
                  importValues = [];
                  if (headersEqual(values, descriptor.headers)) {
                    if (headerSeen || (descriptor.expectedHeaderRow && descriptor.expectedHeaderRow !== row.rowIndex)) throw mismatch('原表表头位置不符或重复');
                    headerSeen = true; return;
                  }
                  if (next.done || row.rowIndex < next.value.source_row) return;
                  if (!headerSeen || row.rowIndex > next.value.source_row) throw mismatch(`${next.value.identity} 原表行缺失`);
                  if (cells.slice(descriptor.headers.length).some((cell) => cell && cell.cellType !== 'blank')) throw mismatch('原始行包含合同外数据列');
                  save(next.value, values, cells); next = iterator.next();
                  if (!next.done && next.value.source_row === row.rowIndex) throw mismatch(`${next.value.identity} 有效事实共享同一原表坐标`);
                }, undefined, descriptor.source_type === SOURCE_TYPES.SYSTEM_OP ? undefined : (cell, lexical) => {
                  // 原导入规则直接处理同次扫描的原始 body，输出仍取完整语义值。
                  importValues[cell.columnIndex] = cellValueFromBody(lexical.body, lexical.type, workbook.sharedStrings);
                });
                if (!headerSeen || !next.done) throw mismatch(`${source.artifactId} / ${selected.sheet_name} 提取不完整`);
              } finally { iterator.return?.(); }
            }
            scannedFiles += 1;
          } finally { await workbook.close(); }
          const after = await hashSourceFile(source.filePath);
          if (after.sha256 !== source.sha256 || after.sizeBytes !== source.sizeBytes) throw reviewError('archive-integrity-failure', '读取期间原件发生变化');
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      onProgress?.({ phase: 'extracting-sources', rows: extracted, scannedFiles });
    }
    if (db.prepare('SELECT COUNT(*) n FROM facts f LEFT JOIN actual a ON a.identity=f.identity WHERE a.identity IS NULL').get().n) throw mismatch('实际提取集合缺少应输出身份');
    for (const page of db.prepare('SELECT * FROM pages ORDER BY id').all()) {
      const identity = framedDigest(), content = framedDigest(); let count = 0;
      for (const row of pageRows(db, page)) {
        count += 1;
        if (count % 512 === 0) { safePoint(signal); await yieldMessages(); }
        identity.add([page.group_key, row.ordinal, row.identity]);
        content.add([page.group_key, row.ordinal, parse(row.cells, row.identity).map(comparableCell)]);
      }
      if (count !== page.row_count || identity.finish() !== page.identity_digest) throw mismatch(`附页 ${page.name} 提取身份或数量不符`);
      db.prepare('INSERT INTO page_actual VALUES (?,?,?,?)').run(page.id, count, page.identity_digest, content.finish());
    }
    setMeta(db, 'extractionMetrics', { scannedFiles, extracted });
    return { scannedFiles, extracted };
  } finally { db.close(); }
}
function pageRows(db, page) {
  return db.prepare(`SELECT e.ordinal,e.identity,a.cells FROM expected e JOIN actual a ON a.identity=e.identity
    WHERE e.group_key=? AND e.ordinal>=? AND e.ordinal<? ORDER BY e.ordinal`)
    .iterate(page.group_key, page.start_ordinal, page.start_ordinal + page.row_count);
}

module.exports = { prepareReviewManifest, extractReviewSources, freezeExpectedPages, createManifest, pageRows,
  getMeta, setMeta, sheetName, validateRawFact, MAX_DATA_ROWS, safePoint };
