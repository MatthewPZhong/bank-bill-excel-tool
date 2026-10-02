'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { streamToolboxTables, TOOLBOX_SHEET_STRATEGIES } = require('../toolbox-format-io');
const { assertUniqueSplitHeaders } = require('../toolbox-format-operations');
const { assertSourcesFresh } = require('../toolbox-background/generation-core');
const { encodePayload, decodeHeaderPayload, decodeRowPayload, decodeStylePayload, sha256FileSync } = require('../toolbox-background/route-db-contract');
const { ROWS_BUDGETS, assert, rowsError, assertDiskSpace, assertSourceBudget, writePrivateJson, readPrivateJson } = require('./contracts');
const { toolboxReaderOptions, sqliteCacheKiB, checkExecutionMemory } = require('../background-execution/execution-memory-options');
const { detectToolboxInputKind } = require('../toolbox-input-kind');
const { LOW_MEMORY_CSV_MAX_BYTES } = require('../../backend/toolbox-format/csv-capacity');

function checkCancelled(signal) {
  if (signal && signal.aborted) throw rowsError('TOOLBOX_GENERATION_CANCELLED', '按行拆分已取消');
}

function checkResources(directory, cacheBytes = 0, generatedBytes = 0, memoryConfig = null) {
  assert(cacheBytes <= ROWS_BUDGETS.maxCacheBytes && generatedBytes <= ROWS_BUDGETS.maxGeneratedBytes &&
    cacheBytes + generatedBytes <= ROWS_BUDGETS.maxTaskTemporaryBytes, '任务临时文件超出预算', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
  const memory = process.memoryUsage();
  checkExecutionMemory(memoryConfig, memory, memoryConfig ? os.freemem() : undefined);
  assert(memory.heapUsed + memory.external <= ROWS_BUDGETS.maxMemoryBytes,
    '按行拆分内存超出预算', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
  assertDiskSpace(directory);
  return memory;
}

function visitStyleRefs(value, visitor) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.sourceRegistryId === 'string' && Number.isInteger(value.styleRef)) visitor(value);
  else for (const child of Object.values(value)) visitStyleRefs(child, visitor);
}

async function createSealedCache(plan, signal, resourceObserver = () => {}, pollCommands = () => {}, memoryConfig = null) {
  const observeResources = (cacheBytes = 0) => resourceObserver(checkResources(plan.privateDirectory, cacheBytes, 0, memoryConfig));
  const cachePath = path.join(plan.privateDirectory, 'rows.sqlite');
  assert(!fs.existsSync(cachePath), '任务缓存已存在，不能覆盖');
  assertSourcesFresh([plan.source]);
  assertSourceBudget(plan.source.filePath);
  const inputKind = detectToolboxInputKind(plan.source.filePath);
  const sourceSha256 = sha256FileSync(plan.source.filePath);
  observeResources();
  const db = new DatabaseSync(cachePath);
  let count = 0;
  let payloadBytes = 0;
  let registryBytes = 0;
  let checkpointBytes = 0;
  let header = null;
  let transaction = false;
  const resolver = new Map();
  const copied = new Map();
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-${sqliteCacheKiB(memoryConfig, 1)};
      PRAGMA temp_store=FILE; PRAGMA max_page_count=${Math.floor(ROWS_BUDGETS.maxCacheBytes / 4096)};
      CREATE TABLE rows(row_seq INTEGER PRIMARY KEY, payload BLOB NOT NULL);
      CREATE TABLE styles(registry_id TEXT NOT NULL, style_ref INTEGER NOT NULL, payload BLOB NOT NULL,
        PRIMARY KEY(registry_id,style_ref)) WITHOUT ROWID;
      CREATE TABLE header(payload BLOB NOT NULL);`);
    const rowInsert = db.prepare('INSERT INTO rows VALUES (?,?)');
    const styleInsert = db.prepare('INSERT INTO styles VALUES (?,?,?)');
    const encode = (kind, value) => {
      const bytes = encodePayload(kind, value);
      assert(bytes.length <= Math.min(ROWS_BUDGETS.maxCacheRecordBytes, memoryConfig ? memoryConfig.maxSingleRecordBytes : Infinity), '缓存记录超出预算', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
      payloadBytes += bytes.length;
      assert(payloadBytes <= ROWS_BUDGETS.maxCacheBytes, '保真缓存超出预算', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
      return bytes;
    };
    // 在源回调仍持有有效 registry 时复制实体；关闭 reader 后只使用缓存。
    const captureStyles = (value) => {
      for (const [id, registry] of resolver) {
        for (let ref = copied.get(id) || 0; ref < registry.size; ref += 1) {
          const bytes = encode('style', registry.get(ref));
          registryBytes += bytes.length;
          assert(registryBytes <= ROWS_BUDGETS.maxRegistryBytes, '样式注册表超出预算', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
          styleInsert.run(id, ref, bytes);
        }
        copied.set(id, registry.size);
      }
      visitStyleRefs(value, (ref) => assert(ref.styleRef >= 0 && ref.styleRef < (copied.get(ref.sourceRegistryId) || 0), '缓存样式引用缺失'));
    };
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    assertSourcesFresh([plan.source]);
    const summary = await streamToolboxTables(plan.source.filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
      readerOptions: { ...toolboxReaderOptions(memoryConfig, plan.privateDirectory), expectedInputKind: inputKind,
        ...(memoryConfig?.profileId === 'rows-generation-low-v1' ? { csvMaxSourceBytes: LOW_MEMORY_CSV_MAX_BYTES } : {}) },
      sourceRegistryResolver: resolver,
      cancelToken: { get cancelled() { return Boolean(signal && signal.aborted); } },
      onHeader(info) {
        pollCommands();
        checkCancelled(signal);
        assertUniqueSplitHeaders(info.normalizedHeaders);
        header = { normalizedHeaders: info.normalizedHeaders, headerRow: info.headerRow, sheetMeta: info.sheetMeta };
        captureStyles(header);
        db.prepare('INSERT INTO header VALUES (?)').run(encode('header', header));
      },
      onDataRow(row) {
        pollCommands();
        checkCancelled(signal);
        captureStyles(row);
        assert(count < plan.rowCount, '源文件行数已变化，请重新导入', 'TOOLBOX_ROWS_COUNT_CHANGED');
        rowInsert.run(count, encode('row', row));
        count += 1;
        if (count % 128 === 0 || payloadBytes - checkpointBytes >= 4 * 1024 ** 2) {
          db.exec('COMMIT; BEGIN IMMEDIATE');
          observeResources(fs.statSync(cachePath).size);
          checkpointBytes = payloadBytes;
        }
      }
    });
    assert(header && count === plan.rowCount && summary.dataRowCount === count,
      '源文件行数已变化，请重新导入', 'TOOLBOX_ROWS_COUNT_CHANGED');
    assertSourcesFresh([plan.source]);
    assert(sha256FileSync(plan.source.filePath) === sourceSha256, '源文件内容已变化，请重新导入', 'ARCHIVE_INPUT_CHANGED');
    db.exec('COMMIT');
    transaction = false;
  } finally {
    if (transaction) { try { db.exec('ROLLBACK'); } catch (_error) { /* 保留原错误 */ } }
    db.close();
  }
  const byteSize = fs.statSync(cachePath).size;
  observeResources(byteSize);
  const seal = { version: 1, attemptId: plan.attemptId, rowCount: count, sourceSha256,
    byteSize, sha256: sha256FileSync(cachePath) };
  // 写 SEALED 前完成独立回读、连续行号与引用校验；不依赖写入时的对象仍存活。
  resolver.clear();
  copied.clear();
  const reader = openCache(plan, seal, memoryConfig);
  try { reader.validateAll(); } finally { reader.close(); }
  const descriptor = writePrivateJson(path.join(plan.privateDirectory, 'cache-sealed.json'), seal, 4096);
  return { seal, descriptor };
}

function openCache(plan, seal, memoryConfig = null) {
  const cachePath = path.join(plan.privateDirectory, 'rows.sqlite');
  const stat = fs.lstatSync(cachePath);
  assert(!stat.isSymbolicLink() && stat.isFile() && stat.size === seal.byteSize &&
    seal.attemptId === plan.attemptId && seal.rowCount === plan.rowCount &&
    sha256FileSync(cachePath) === seal.sha256, '缓存身份或摘要不一致');
  const db = new DatabaseSync(cachePath, { readOnly: true });
  try {
    db.exec(`PRAGMA query_only=ON; PRAGMA cache_size=-${sqliteCacheKiB(memoryConfig, 1)};`);
    assert(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', '缓存完整性校验失败');
    const headers = db.prepare('SELECT payload FROM header').all();
    assert(headers.length === 1, '缓存表头数量非法');
    const header = decodeHeaderPayload(headers[0].payload);
    const resolver = new Map();
    const styles = new Map();
    const cacheLimit = memoryConfig ? memoryConfig.styleCacheBytes : 8 * 1024 ** 2;
    let styleCacheBytes = 0;
    let peakStyleCacheBytes = 0;
    let styleEvictions = 0;
    let alive = true;
    const lookup = db.prepare('SELECT payload FROM styles WHERE registry_id=? AND style_ref=?');
    const getStyle = (id, ref) => {
      assert(alive && Number.isSafeInteger(ref) && ref >= 0, '缓存样式引用非法或 reader 已关闭');
      const key = `${id}:${ref}`;
      let entry = styles.get(key);
      if (entry) { styles.delete(key); styles.set(key, entry); return entry.value; }
      const row = lookup.get(id, ref);
      assert(row && row.payload.length <= Math.min(ROWS_BUDGETS.maxCacheRecordBytes, memoryConfig ? memoryConfig.maxSingleRecordBytes : Infinity), '缓存样式引用缺失');
      entry = { value: decodeStylePayload(row.payload), bytes: row.payload.length * 4 + 128 };
      // 单条解码对象受记录预算保护；超过缓存容量不缓存，不扩大 LRU。
      if (entry.bytes <= cacheLimit) {
        while (styleCacheBytes + entry.bytes > cacheLimit) {
          const [oldKey, old] = styles.entries().next().value;
          styles.delete(oldKey); styleCacheBytes -= old.bytes;
          styleEvictions += 1;
        }
        styles.set(key, entry); styleCacheBytes += entry.bytes;
        peakStyleCacheBytes = Math.max(peakStyleCacheBytes, styleCacheBytes);
      }
      return entry.value;
    };
    let registryBytes = 0;
    for (const item of db.prepare('SELECT * FROM styles ORDER BY registry_id,style_ref').iterate()) {
      registryBytes += item.payload.length;
      assert(registryBytes <= ROWS_BUDGETS.maxRegistryBytes, '缓存样式超出预算');
      if (!resolver.has(item.registry_id)) {
        const id = item.registry_id;
        resolver.set(id, { size: 0, get(ref) { return getStyle(id, ref); } });
      }
      const registry = resolver.get(item.registry_id);
      assert(item.style_ref === registry.size && item.payload.length <= Math.min(ROWS_BUDGETS.maxCacheRecordBytes, memoryConfig ? memoryConfig.maxSingleRecordBytes : Infinity),
        '缓存样式编号不连续或记录超出预算');
      decodeStylePayload(item.payload); // 连未使用样式也逐条核验，不保留整份解析结果。
      registry.size += 1;
    }
    const refs = (value) => visitStyleRefs(value, (ref) => {
      assert(resolver.has(ref.sourceRegistryId), '缓存来源注册表缺失');
      resolver.get(ref.sourceRegistryId).get(ref.styleRef);
    });
    refs(header);
    const readRange = function* (start, end, onPayload = null) {
      let expected = start;
      for (const item of db.prepare('SELECT row_seq,payload FROM rows WHERE row_seq>=? AND row_seq<? ORDER BY row_seq').iterate(start, end)) {
        assert(item.row_seq === expected && item.payload.length <= Math.min(ROWS_BUDGETS.maxCacheRecordBytes, memoryConfig ? memoryConfig.maxSingleRecordBytes : Infinity), '缓存行序号或记录大小非法');
        const row = decodeRowPayload(item.payload);
        refs(row);
        expected += 1;
        if (onPayload) onPayload(item.payload.length);
        yield row;
      }
      assert(expected === end, '缓存数据行缺失');
    };
    return { header, resolver, readRange,
      styleCacheStats() { return { styleCacheBytes, peakStyleCacheBytes, cacheLimit, entries: styles.size, styleEvictions }; },
      validateAll() {
        assert(db.prepare('SELECT COUNT(*) AS n FROM rows').get().n === plan.rowCount, '缓存行数不一致');
        for (const _row of readRange(0, plan.rowCount)) { /* 验证每条记录及其样式引用 */ }
      },
      close() { alive = false; db.close(); resolver.clear(); styles.clear(); styleCacheBytes = 0; }
    };
  } catch (error) { db.close(); throw error; }
}

function openSealedCache(plan, descriptor, memoryConfig = null) {
  const seal = readPrivateJson(path.join(plan.privateDirectory, 'cache-sealed.json'), descriptor, 4096);
  return { seal, reader: openCache(plan, seal, memoryConfig) };
}

module.exports = { createSealedCache, openSealedCache, openCache, checkCancelled, checkResources };
