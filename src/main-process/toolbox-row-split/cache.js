'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { streamToolboxTables, TOOLBOX_SHEET_STRATEGIES } = require('../toolbox-format-io');
const { assertUniqueSplitHeaders } = require('../toolbox-format-operations');
const { assertSourcesFresh } = require('../toolbox-background/generation-core');
const { encodePayload, decodeHeaderPayload, decodeRowPayload, decodeStylePayload, sha256FileSync } = require('../toolbox-background/route-db-contract');
const { ROWS_BUDGETS, assert, rowsError, assertDiskSpace, assertSourceBudget, writePrivateJson, readPrivateJson } = require('./contracts');

function checkCancelled(signal) {
  if (signal && signal.aborted) throw rowsError('TOOLBOX_GENERATION_CANCELLED', '按行拆分已取消');
}

function checkResources(directory, cacheBytes = 0, generatedBytes = 0) {
  assert(cacheBytes <= ROWS_BUDGETS.maxCacheBytes && generatedBytes <= ROWS_BUDGETS.maxGeneratedBytes &&
    cacheBytes + generatedBytes <= ROWS_BUDGETS.maxTaskTemporaryBytes, '任务临时文件超出预算', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
  const memory = process.memoryUsage();
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

async function createSealedCache(plan, signal, resourceObserver = () => {}, pollCommands = () => {}) {
  const observeResources = (cacheBytes = 0) => resourceObserver(checkResources(plan.privateDirectory, cacheBytes));
  const cachePath = path.join(plan.privateDirectory, 'rows.sqlite');
  assert(!fs.existsSync(cachePath), '任务缓存已存在，不能覆盖');
  assertSourcesFresh([plan.source]);
  assertSourceBudget(plan.source.filePath);
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
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192;
      PRAGMA temp_store=FILE; PRAGMA max_page_count=${Math.floor(ROWS_BUDGETS.maxCacheBytes / 4096)};
      CREATE TABLE rows(row_seq INTEGER PRIMARY KEY, payload BLOB NOT NULL);
      CREATE TABLE styles(registry_id TEXT NOT NULL, style_ref INTEGER NOT NULL, payload BLOB NOT NULL,
        PRIMARY KEY(registry_id,style_ref)) WITHOUT ROWID;
      CREATE TABLE header(payload BLOB NOT NULL);`);
    const rowInsert = db.prepare('INSERT INTO rows VALUES (?,?)');
    const styleInsert = db.prepare('INSERT INTO styles VALUES (?,?,?)');
    const encode = (kind, value) => {
      const bytes = encodePayload(kind, value);
      assert(bytes.length <= ROWS_BUDGETS.maxCacheRecordBytes, '缓存记录超出预算', 'TOOLBOX_ROWS_BUDGET_EXCEEDED');
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
    const summary = await streamToolboxTables(plan.source.filePath, {
      strategy: TOOLBOX_SHEET_STRATEGIES.SPLIT,
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
  const reader = openCache(plan, seal);
  try { reader.validateAll(); } finally { reader.close(); }
  const descriptor = writePrivateJson(path.join(plan.privateDirectory, 'cache-sealed.json'), seal, 4096);
  return { seal, descriptor };
}

function openCache(plan, seal) {
  const cachePath = path.join(plan.privateDirectory, 'rows.sqlite');
  const stat = fs.lstatSync(cachePath);
  assert(!stat.isSymbolicLink() && stat.isFile() && stat.size === seal.byteSize &&
    seal.attemptId === plan.attemptId && seal.rowCount === plan.rowCount &&
    sha256FileSync(cachePath) === seal.sha256, '缓存身份或摘要不一致');
  const db = new DatabaseSync(cachePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192;');
    assert(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', '缓存完整性校验失败');
    const headers = db.prepare('SELECT payload FROM header').all();
    assert(headers.length === 1, '缓存表头数量非法');
    const header = decodeHeaderPayload(headers[0].payload);
    const resolver = new Map();
    let registryBytes = 0;
    for (const item of db.prepare('SELECT * FROM styles ORDER BY registry_id,style_ref').iterate()) {
      registryBytes += item.payload.length;
      assert(registryBytes <= ROWS_BUDGETS.maxRegistryBytes, '缓存样式超出预算');
      if (!resolver.has(item.registry_id)) {
        const styles = [];
        resolver.set(item.registry_id, { styles, get(ref) { assert(styles[ref], '缓存样式引用缺失'); return styles[ref]; } });
      }
      const registry = resolver.get(item.registry_id);
      assert(item.style_ref === registry.styles.length, '缓存样式编号不连续');
      registry.styles.push(decodeStylePayload(item.payload));
    }
    const refs = (value) => visitStyleRefs(value, (ref) => {
      assert(resolver.has(ref.sourceRegistryId), '缓存来源注册表缺失');
      resolver.get(ref.sourceRegistryId).get(ref.styleRef);
    });
    refs(header);
    const readRange = function* (start, end, onPayload = null) {
      let expected = start;
      for (const item of db.prepare('SELECT row_seq,payload FROM rows WHERE row_seq>=? AND row_seq<? ORDER BY row_seq').iterate(start, end)) {
        assert(item.row_seq === expected && item.payload.length <= ROWS_BUDGETS.maxCacheRecordBytes, '缓存行序号或记录大小非法');
        const row = decodeRowPayload(item.payload);
        refs(row);
        expected += 1;
        if (onPayload) onPayload(item.payload.length);
        yield row;
      }
      assert(expected === end, '缓存数据行缺失');
    };
    return { header, resolver, readRange,
      validateAll() {
        assert(db.prepare('SELECT COUNT(*) AS n FROM rows').get().n === plan.rowCount, '缓存行数不一致');
        for (const _row of readRange(0, plan.rowCount)) { /* 验证每条记录及其样式引用 */ }
      },
      close() { db.close(); resolver.clear(); }
    };
  } catch (error) { db.close(); throw error; }
}

function openSealedCache(plan, descriptor) {
  const seal = readPrivateJson(path.join(plan.privateDirectory, 'cache-sealed.json'), descriptor, 4096);
  return { seal, reader: openCache(plan, seal) };
}

module.exports = { createSealedCache, openSealedCache, openCache, checkCancelled, checkResources };
