'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require('../../../../src/backend/vcc-financial-op-db/migrations');
const { createArchiveRepository } = require('../../../../src/backend/database/archive-repository');
const { SOURCE_TYPES: T, SUPPORTED_CURRENCIES, SYSTEM_OP_HEADERS, getSourceDefinition } = require('../../../../src/backend/vcc-financial-op/definitions');
const { inspectWorkbookImportPlan, resolveImportPlan } = require('../../../../src/backend/vcc-financial-op/workbook-import-plan');
const { buildMemberFiles, handoffMetadata } = require('../../../../src/backend/vcc-financial-op/import-handoff');
const { importFiles } = require('../../../../src/backend/vcc-financial-op/import-service');
const { reconcileVccImportArchiveLineage } = require('../../../../src/main-process/vcc-financial-op-archive-lineage');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-multisheet-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec("CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_at TEXT DEFAULT (datetime('now')))");
  ensureVccFinancialOpTablesSupport(db, { autoUpgradeEmptyV1: true });
  const archive = createArchiveRepository(db); archive.ensureSchema();
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, archive, dir };
}
function detail(id = '001') { return { 订单号: id, BillDate: '2026-06-09', 业务部门: 'VCC', 对手部门: 'OPS',
  业务子类型: '充值', 出入方向: 'in', 公司主体: '甲', 我方币种: 'USD', 我方到账金额: '10.25' }; }
function system(subject, currencies = SUPPORTED_CURRENCIES) {
  return currencies.map((币种) => ({ 账单日期: '2026-06-30', 主体: subject, 业务部门: 'VCC', 币种,
    财务余额: '12.34', 财务主体余额: '12.34', 创建时间: '2026-07-01 00:00:00' }));
}
function write(dir, sheets, name = 'mixed.xlsx', options = {}) {
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const headers = sheet.type === T.SYSTEM_OP ? SYSTEM_OP_HEADERS : getSourceDefinition(sheet.type).headers;
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ...(sheet.leading || []), headers, ...sheet.rows.map((row) => headers.map((header) => row[header] ?? ''))
    ], options), sheet.name);
  }
  const filePath = path.join(dir, name); XLSX.writeFile(book, filePath, options); return filePath;
}
async function prepare(f, paths, taskRunId = 'multi-task') {
  const plan = await inspectWorkbookImportPlan(paths);
  const subjectBySourceId = Object.fromEntries(plan.sources.filter((s) => s.requiresSubject).map((s) => [s.sourceId, s.sheetName]));
  const files = buildMemberFiles(resolveImportPlan(plan, { planId: plan.planId, subjectBySourceId, excludedSheetIds: [] }));
  const batch = f.archive.createBatch({ moduleId: 'vcc-financial-op', moduleCode: 'VCCFINOP', moduleName: 'VCC',
    operationKey: taskRunId, taskKey: 'vccFinancialOp:import:apply', taskRunId, parentRunId: taskRunId,
    localDate: '2026-09-18', retentionUntil: '2026-11-17' }).batch;
  f.db.prepare('UPDATE archive_batches SET task_run_id = ?, task_key = ? WHERE id = ?').run(taskRunId, 'vccFinancialOp:import:apply', batch.id);
  for (const [index, file] of files.entries()) {
    const artifact = f.archive.addArtifact(batch.id, { artifactKey: `input:${index}`, direction: 'input', role: 'input',
      sourceOperation: 'vccFinancialOp:import:apply', originalName: file.fileName, sourcePath: file.filePath,
      metadata: handoffMetadata(file, taskRunId) });
    f.archive.startArtifactAttempt(artifact.id);
    f.archive.completeArtifact(artifact.id, { sha256: file.sha256, sizeBytes: file.sizeBytes,
      relativePath: `blobs/${file.sha256}`, fingerprint: { sizeBytes: file.sizeBytes, mtimeMs: 1, ctimeMs: 1, ino: '1' } });
    file.archiveArtifactId = artifact.id;
  }
  return { db: f.db, targetMonth: '2026-06', batchId: taskRunId, files,
    archiveHandoffFiles: { version: 2, taskRunId, files } };
}

function observeSystemReader(t, observe) {
  const richReader = require('../../../../src/backend/xlsx-rich-reader');
  const originalOpen = richReader.openRichWorkbook;
  const open = t.mock.method(richReader, 'openRichWorkbook', async (...args) => {
    const reader = await originalOpen(...args);
    observe('open', args[0]);
    return { ...reader, async close() {
      observe('close-start', args[0]);
      await reader.close();
      observe('close-complete', args[0]);
    } };
  });
  const modules = ['system-op-importer', 'import-service'].map((name) =>
    require.resolve('../../../../src/backend/vcc-financial-op/' + name));
  const cached = modules.map((name) => require.cache[name]);
  try {
    for (const name of modules) delete require.cache[name];
    return require(modules[1]).importFiles;
  } finally {
    modules.forEach((name, index) => { require.cache[name] = cached[index]; });
    open.mock.restore();
  }
}

test('系统 OP 异步关闭期间收到取消：不提交当前组，保留前组并停止后续工作', async (t) => {
  for (const scenario of ['仅系统 OP', '前组已提交且后组未执行', '取消后不再打开下一个文件']) {
    await t.test(scenario, async (t) => {
      const f = fixture(t), hasPrior = scenario === '前组已提交且后组未执行';
      const sheets = [
        ...(hasPrior ? [{ name: '已提交充值', type: T.RECHARGE, rows: [detail()] }] : []),
        { name: '系统', type: T.SYSTEM_OP, rows: system('甲') },
        ...(hasPrior ? [{ name: '未执行通道', type: T.CHANNEL, rows: [{ 渠道订单号: 'channel-1',
          账单日期: '2026-06-10', 通道名称: 'CITI', 交易金额: '100', 交易币种: 'USD', 借贷方向: 'in' }] }] : [])
      ];
      const first = write(f.dir, sheets), files = [first];
      if (scenario === '取消后不再打开下一个文件') files.push(write(f.dir,
        [{ name: '后续系统', type: T.SYSTEM_OP, rows: system('乙') }], 'second.xlsx'));
      const request = await prepare(f, files), events = [], progress = [];
      let cancelled = false, priorRows;
      const observe = (event, filePath = first) => events.push({ event, filePath, cancelled,
        snapshots: f.db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_system_snapshots').get().n });
      const importObserved = observeSystemReader(t, observe);
      request.shouldCancel = () => cancelled;
      request.onProgress = (p) => {
        progress.push(p);
        if (p.phase === 'reading' && p.sourceType === T.SYSTEM_OP && !priorRows) {
          priorRows = f.db.prepare('SELECT * FROM vcc_fin_op_effective_rows ORDER BY id').all();
          observe('last-reading');
          setImmediate(() => { cancelled = true; observe('cancel-delivered'); });
        }
      };
      let caught;
      try { await importObserved(request); } catch (error) { caught = error; }
      const index = (event) => events.findIndex((item) => item.event === event);
      assert.ok(index('close-start') < index('cancel-delivered'));
      assert.ok(index('cancel-delivered') < index('close-complete'));
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_system_snapshots').get().n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_system_snapshot_attempts').get().n, 0);
      assert.equal(caught?.code, 'vcc-import-cancelled');
      assert.equal(caught.partialResult.partialCommitted, hasPrior);
      assert.deepEqual(caught.partialResult.records.map((r) => [r.sourceType, r.status, r.insertedCount]), [
        ...(hasPrior ? [[T.RECHARGE, 'success', 1]] : []),
        [T.SYSTEM_OP, 'failed_validation', 0],
        ...(hasPrior ? [[T.CHANNEL, 'failed_validation', 0]] : [])
      ]);
      assert.deepEqual(f.db.prepare('SELECT * FROM vcc_fin_op_effective_rows ORDER BY id').all(), priorRows);
      assert.equal(priorRows.length, hasPrior ? 1 : 0);
      assert.deepEqual(events.filter((event) => event.event === 'open').map((event) => event.filePath), [first]);
      assert.ok(!progress.some((p) => p.sourceType === T.CHANNEL || p.phase === 'summarizing'));
      assert.equal(f.db.prepare('SELECT status FROM vcc_fin_op_import_batches WHERE id=?').get(request.batchId).status, 'failed');
    });
  }
});

test('系统 OP 最后一次读取进度同步取消，仍先完成 Reader 关闭再收口', async (t) => {
  const f = fixture(t), file = write(f.dir, [{ name: '系统', type: T.SYSTEM_OP, rows: system('甲') }]);
  const request = await prepare(f, [file]), events = [];
  const importObserved = observeSystemReader(t, (event) => events.push(event));
  let cancelled = false;
  request.shouldCancel = () => cancelled;
  request.onProgress = (p) => { if (p.phase === 'reading') cancelled = true; };
  await assert.rejects(importObserved(request), { code: 'vcc-import-cancelled' });
  assert.deepEqual(events, ['open', 'close-start', 'close-complete']);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_system_snapshots').get().n, 0);
});

test('同类型跨 Sheet 幂等、多主体通道及混合原件共享；来源 hold 在首行读取前已齐全', async (t) => {
  const f = fixture(t);
  const channel = { 渠道订单号: 'channel-1', 账单日期: '2026-06-10', 通道名称: 'CITI', 交易金额: '100', 交易币种: 'USD', 借贷方向: 'in' };
  const file = write(f.dir, [
    { name: '充值一', type: T.RECHARGE, rows: [detail()] },
    { name: '甲', type: T.CHANNEL, rows: [channel] },
    { name: '充值二', type: T.RECHARGE, leading: [['说明']], rows: [detail(), detail('002')] },
    { name: '乙', type: T.CHANNEL, rows: [{ ...channel, 渠道订单号: 'channel-2' }] }
  ]);
  const request = await prepare(f, [file]);
  let checked = false;
  request.onProgress = () => {
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM archive_artifact_holds').get().n, 2); checked = true;
  };
  const result = await importFiles(request);
  assert.equal(result.physicalFileCount, 1); assert.equal(result.businessSheetCount, 4); assert.ok(checked);
  assert.deepEqual(result.records.map((r) => [r.sourceType, r.insertedCount, r.skippedCount]), [[T.RECHARGE, 2, 1], [T.CHANNEL, 2, 0]]);
  const sources = f.db.prepare('SELECT archive_artifact_id FROM vcc_fin_op_import_sources').all();
  assert.equal(sources.length, 2); assert.equal(sources[0].archive_artifact_id, sources[1].archive_artifact_id);
  assert.deepEqual(f.db.prepare('SELECT subject, sheet_name FROM vcc_fin_op_effective_rows WHERE source_type = ? ORDER BY id').all(T.CHANNEL).map((r) => [r.subject, r.sheet_name]), [['甲', '甲'], ['乙', '乙']]);
  assert.equal(f.db.prepare('SELECT source_row FROM vcc_fin_op_effective_rows WHERE idempotency_key = ?').get('002').source_row, 4);
  assert.equal(reconcileVccImportArchiveLineage({ db: f.db, archiveRepository: f.archive }).failed, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM archive_artifact_holds').get().n, 2);
  f.db.prepare('DELETE FROM vcc_fin_op_effective_rows WHERE source_type = ?').run(T.CHANNEL);
  reconcileVccImportArchiveLineage({ db: f.db, archiveRepository: f.archive });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM archive_artifact_holds').get().n, 1);
});

test('RV02：完整甲、八币种乙、充值各 Sheet 独立，系统组精确计数并保留 18 条实际读取行', async (t) => {
  const f = fixture(t);
  const file = write(f.dir, [{ name: 'A', type: T.SYSTEM_OP, rows: system('甲') },
    { name: 'B', type: T.SYSTEM_OP, rows: system('乙', SUPPORTED_CURRENCIES.slice(0, 8)) },
    { name: 'C', type: T.RECHARGE, rows: [detail()] }]);
  const request = await prepare(f, [file]);
  const progress = []; request.onProgress = (p) => progress.push(p);
  const result = await importFiles(request);
  const row = result.records[0];
  assert.deepEqual([row.rawCount, row.insertedCount, row.formatErrorCount, row.skippedCount, row.rolledBackCount, row.status], [2, 1, 1, 0, 0, 'success_with_skips']);
  assert.equal(result.records[1].insertedCount, 1); assert.equal(result.status, 'success');
  assert.equal(Math.max(...progress.filter((p) => p.sourceType === T.SYSTEM_OP).map((p) => p.rows)), 17);
  assert.equal(Math.max(...progress.filter((p) => p.sourceType === T.RECHARGE).map((p) => p.rows)), 1);
});

test('系统 OP 无目标账期也保留扫描行数和 Sheet 进度，其他类型照常提交', async (t) => {
  const f = fixture(t);
  const file = write(f.dir, [{ name: '旧账期', type: T.SYSTEM_OP, rows: system('甲').map((row) => ({ ...row, 账单日期: '2026-05-31' })) },
    { name: '充值', type: T.RECHARGE, rows: [detail()] }]);
  const request = await prepare(f, [file]), progress = []; request.onProgress = (value) => progress.push(value);
  const result = await importFiles(request);
  assert.equal(result.status, 'completed_with_errors');
  assert.deepEqual(result.records.map((r) => [r.sourceType, r.status, r.insertedCount]), [[T.SYSTEM_OP, 'failed_validation', 0], [T.RECHARGE, 'success', 1]]);
  assert.equal(result.readRowCount, 10); assert.equal(progress.at(-1).rows, 10);
  const systemRead = progress.filter((p) => p.phase === 'reading' && p.sourceType === T.SYSTEM_OP);
  assert.deepEqual(systemRead.map((p) => [p.sourceFile, p.sheetName, p.rows]), [['mixed.xlsx', '旧账期', 9]]);
});

test('失败和解析成功的系统 OP Sheet 跨文件累计读取量，整组回滚也保留计数', async (t) => {
  const f = fixture(t), oldRows = system('甲').map((row) => ({ ...row, 账单日期: '2026-05-31' }));
  const first = write(f.dir, [{ name: '旧一', type: T.SYSTEM_OP, rows: oldRows }, { name: '正常', type: T.SYSTEM_OP, rows: system('乙') }], 'first.xlsx');
  const second = write(f.dir, [{ name: '旧二', type: T.SYSTEM_OP, rows: oldRows }, { name: '充值', type: T.RECHARGE, rows: [detail()] }], 'second.xlsx');
  const request = await prepare(f, [first, second]), progress = []; request.onProgress = (value) => progress.push(value);
  const result = await importFiles(request);
  assert.equal(result.physicalFileCount, 2); assert.equal(result.businessSheetCount, 4);
  assert.equal(result.readRowCount, 28); assert.equal(progress.at(-1).rows, 28);
  const systemRead = progress.filter((p) => p.phase === 'reading' && p.sourceType === T.SYSTEM_OP);
  assert.deepEqual(systemRead.map((p) => [p.sourceFile, p.sheetName, p.rows]), [['first.xlsx', '旧一', 9], ['first.xlsx', '正常', 18], ['second.xlsx', '旧二', 27]]);
  const systemRecord = result.records.find((r) => r.sourceType === T.SYSTEM_OP);
  assert.deepEqual([systemRecord.status, systemRecord.insertedCount, systemRecord.rolledBackCount], ['failed_validation', 0, 1]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_system_snapshots').get().n, 0);
  assert.equal(result.records.find((r) => r.sourceType === T.RECHARGE).insertedCount, 1);
});

test('系统 OP 扫描中断仍上报已完成数据行，不把未读尾部或表头计入', async (t) => {
  const { openRichWorkbook } = require('../../../../src/backend/xlsx-rich-reader');
  const { readSystemOpSheetCandidates } = require('../../../../src/backend/vcc-financial-op/system-op-importer');
  const f = fixture(t), file = write(f.dir, [{ name: '系统', type: T.SYSTEM_OP, rows: system('甲') }]);
  const reader = await openRichWorkbook(file), progress = [];
  const failure = new Error('injected scan failure');
  try {
    await assert.rejects(readSystemOpSheetCandidates({ filePath: file, fileName: 'mixed.xlsx' },
      { sheetIndex: 0, sheetName: '系统', headerRow: 1 }, '2026-06', {
        sheets: reader.sheets, date1904: reader.date1904,
        scanSheet(index, onRow) { return reader.scanSheet(index, (row) => {
          if (row.rowIndex === 6) throw failure;
          onRow(row);
        }); }
      }, { onReadProgress: (rows) => progress.push(rows) }), (error) => error === failure);
    assert.deepEqual(progress, [4]);
  } finally { await reader.close(); }
});

test('同主体九币种跨 Sheet 拆分，或八币种与完整候选并存，都不能补救该主体', async (t) => {
  for (const complete of [false, true]) {
    const f = fixture(t);
    const file = write(f.dir, [{ name: '碎片', type: T.SYSTEM_OP, rows: system('甲', SUPPORTED_CURRENCIES.slice(0, 8)) },
      { name: '第二页', type: T.SYSTEM_OP, rows: system('甲', complete ? SUPPORTED_CURRENCIES : ['USD']) },
      { name: '正常', type: T.SYSTEM_OP, rows: system('乙') }]);
    const result = await importFiles(await prepare(f, [file]));
    assert.equal(result.records[0].formatErrorCount, 1); assert.equal(result.records[0].insertedCount, 1);
    assert.deepEqual(f.db.prepare('SELECT subject FROM vcc_fin_op_system_snapshots').all().map((r) => r.subject), ['乙']);
  }
});

test('未知主体按 Sheet 计数；主体成员或持久 metadata 损坏时来源和 hold 创建一起回滚', async (t) => {
  const f = fixture(t);
  const file = write(f.dir, [{ name: '空一', type: T.SYSTEM_OP, rows: system('', ['USD']) },
    { name: '空二', type: T.SYSTEM_OP, rows: system('', ['USD']) },
    { name: '正常', type: T.SYSTEM_OP, rows: system('乙') }]);
  const request = await prepare(f, [file]);
  const result = await importFiles(request);
  assert.equal(result.records[0].formatErrorCount, 2); assert.equal(result.records[0].insertedCount, 1);
  const second = await prepare(f, [file], 'corrupt-task');
  f.db.prepare("UPDATE archive_artifacts SET metadata_json = '{}' WHERE id = ?").run(second.files[0].archiveArtifactId);
  await assert.rejects(importFiles(second), { code: 'vcc-import-handoff-mismatch' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_import_batches WHERE id = ?').get('corrupt-task').n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM archive_artifact_holds WHERE artifact_id = ?').get(second.files[0].archiveArtifactId).n, 0);
});

test('不同输入文件同名同内容：存档共用 Blob 后仍按两个物理来源导入和幂等', async (t) => {
  const f = fixture(t);
  const file = write(f.dir, [{ name: '充值', type: T.RECHARGE, rows: [detail()] }]);
  fs.mkdirSync(path.join(f.dir, '副本'));
  const copy = path.join(f.dir, '副本', path.basename(file)); fs.copyFileSync(file, copy);
  const request = await prepare(f, [file, copy]);
  assert.notEqual(request.files[0].physicalFileId, request.files[1].physicalFileId);
  assert.notEqual(request.files[0].archiveArtifactId, request.files[1].archiveArtifactId);
  // Main resolves both distinct artifacts to the same content-addressed Blob.
  request.files[1].filePath = request.files[0].filePath;
  const result = await importFiles(request);
  assert.equal(result.physicalFileCount, 2); assert.equal(result.businessSheetCount, 2); assert.equal(result.readRowCount, 2);
  assert.equal(result.records[0].insertedCount, 1); assert.equal(result.records[0].skippedCount, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM vcc_fin_op_import_sources').get().n, 2);
  assert.equal(reconcileVccImportArchiveLineage({ db: f.db, archiveRepository: f.archive }).failed, 0);
});


test('系统 OP 日期单元格与旧 Reader 等价，九币种快照正常导入', async (t) => {
  const f = fixture(t);
  const rows = system('甲').map((row) => ({ ...row, 账单日期: new Date('2026-06-30T00:00:00Z') }));
  const file = write(f.dir, [{ name: '系统 OP', type: T.SYSTEM_OP, rows }], 'date.xlsx', { cellDates: true });
  const { readSystemOpSnapshotCandidates } = require('../../../../src/backend/vcc-financial-op/system-op-importer');
  const legacy = readSystemOpSnapshotCandidates(file, '2026-06');
  assert.equal(legacy.snapshots.length, 1); assert.equal(legacy.validationErrors.length, 0);
  const result = await importFiles(await prepare(f, [file]));
  assert.equal(result.records[0].status, 'success'); assert.equal(result.records[0].insertedCount, 1);
  assert.equal(result.readRowCount, 9);
  const snapshot = f.db.prepare('SELECT content_hash,raw_json FROM vcc_fin_op_system_snapshots').get();
  assert.equal(snapshot.content_hash, legacy.snapshots[0].contentHash);
  assert.deepEqual(JSON.parse(snapshot.raw_json).rows.map((row) => row.rawValues),
    JSON.parse(legacy.snapshots[0].rawJson).rows.map((row) => row.rawValues));
});

test('表头位于预览窗口外：混合类型导入后原表、校验表仍按持久成员定位', async (t) => {
  const f = fixture(t);
  const file = write(f.dir, [
    { name: '充值', type: T.RECHARGE, leading: Array.from({ length: 221 }, (_, i) => ['说明' + i]), rows: [detail()] },
    { name: '系统 OP', type: T.SYSTEM_OP, leading: Array.from({ length: 220 }, (_, i) => ['说明' + i]), rows: system('甲') }
  ]);
  const request = await prepare(f, [file]);
  assert.deepEqual(request.files[0].sheets.map((sheet) => [sheet.status, sheet.headerRow]), [['ready', 222], ['ready', 221]]);
  const imported = await importFiles(request);
  assert.deepEqual(imported.records.map((record) => [record.status, record.insertedCount]), [['success', 1], ['success', 1]]);
  const { writeDatasetWorkbook } = require('../../../../src/main-process/vcc-financial-op-dataset-writer');
  const archiveSources = f.db.prepare('SELECT * FROM vcc_fin_op_import_sources').all().map((s) => ({
    sourceId: s.id, filePath: file, fileName: s.source_file_name, sha256: s.source_sha256, sizeBytes: s.source_size_bytes
  }));
  for (const sourceType of [T.RECHARGE, T.SYSTEM_OP]) {
    for (const targetKind of ['raw', 'check']) {
      const outputPath = path.join(f.dir, sourceType + '-' + targetKind + '.xlsx');
      const exported = await writeDatasetWorkbook({ db: f.db, targetMonth: '2026-06', sourceType, targetKind, outputPath, archiveSources });
      assert.equal(exported.dataCount, sourceType === T.SYSTEM_OP ? 9 : 1);
      const actual = XLSX.readFile(outputPath);
      const values = XLSX.utils.sheet_to_json(actual.Sheets[actual.SheetNames[0]], { header: 1 });
      assert.equal(values.length, sourceType === T.SYSTEM_OP ? 10 : 2);
    }
  }
  const artifactId = request.files[0].archiveArtifactId;
  const metadata = f.archive.getArtifact(artifactId).metadata;
  metadata.vccSourceMembers.find((member) => member.sourceType === T.RECHARGE).sheets[0].headerRow -= 1;
  metadata.vccMembersDigest = require('../../../../src/backend/vcc-financial-op/import-handoff').membersDigest(metadata.vccSourceMembers);
  f.db.prepare('UPDATE archive_artifacts SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), artifactId);
  await assert.rejects(writeDatasetWorkbook({ db: f.db, targetMonth: '2026-06', sourceType: T.RECHARGE,
    targetKind: 'raw', outputPath: path.join(f.dir, 'wrong-header.xlsx'), archiveSources }), /表头/);
});
