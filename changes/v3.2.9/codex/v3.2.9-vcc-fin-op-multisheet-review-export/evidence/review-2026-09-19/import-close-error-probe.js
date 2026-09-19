'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reviewRoot = process.env.VCC_REVIEW_ROOT || process.cwd();
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');
const { ensureVccFinancialOpTablesSupport } = require(path.join(reviewRoot, 'src/backend/vcc-financial-op-db/migrations'));
const { createArchiveRepository } = require(path.join(reviewRoot, 'src/backend/database/archive-repository'));
const { SOURCE_TYPES: T, SUPPORTED_CURRENCIES, SYSTEM_OP_HEADERS, getSourceDefinition } = require(path.join(reviewRoot, 'src/backend/vcc-financial-op/definitions'));
const { inspectWorkbookImportPlan, resolveImportPlan } = require(path.join(reviewRoot, 'src/backend/vcc-financial-op/workbook-import-plan'));
const { buildMemberFiles, handoffMetadata } = require(path.join(reviewRoot, 'src/backend/vcc-financial-op/import-handoff'));
const { importFiles } = require(path.join(reviewRoot, 'src/backend/vcc-financial-op/import-service'));
const { reconcileVccImportArchiveLineage } = require(path.join(reviewRoot, 'src/main-process/vcc-financial-op-archive-lineage'));

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
  const richReader = require(path.join(reviewRoot, 'src/backend/xlsx-rich-reader'));
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
    require.resolve(path.join(reviewRoot, 'src/backend/vcc-financial-op', name)));
  const cached = modules.map((name) => require.cache[name]);
  try {
    for (const name of modules) delete require.cache[name];
    return require(modules[1]).importFiles;
  } finally {
    modules.forEach((name, index) => { require.cache[name] = cached[index]; });
    open.mock.restore();
  }
}


test('review: reader close error retains priority over concurrent cancellation and stops subsequent groups',async t=>{
 for(const cancelDuringClose of [false,true])await t.test(String(cancelDuringClose),async t=>{
  const f=fixture(t), file=write(f.dir,[
   {name:'已提交充值',type:T.RECHARGE,rows:[detail()]},
   {name:'系统',type:T.SYSTEM_OP,rows:system('甲')},
   {name:'后续通道',type:T.CHANNEL,rows:[{渠道订单号:'channel-1',账单日期:'2026-06-10',通道名称:'CITI',交易金额:'100',交易币种:'USD',借贷方向:'in'}]}
  ]);
  const request=await prepare(f,[file]); let cancelled=false;const events=[],progress=[];
  const cleanupError=Object.assign(new Error('injected cleanup failure after real close'),{code:'EIO'});
  const observed=observeSystemReader(t,(event)=>{
   events.push({event,cancelled});
   if(event==='close-start'&&cancelDuringClose)setImmediate(()=>{cancelled=true;events.push({event:'cancel-delivered',cancelled})});
   if(event==='close-complete')throw cleanupError;
  });
  request.shouldCancel=()=>cancelled; request.onProgress=p=>progress.push(p);
  let caught;try{await observed(request)}catch(e){caught=e}
  assert.equal(caught,cleanupError);assert.equal(caught.code,'EIO');assert.equal(caught.partialResult.partialCommitted,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_system_snapshots').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vcc_fin_op_system_snapshot_attempts').get().n,0);
  assert.deepEqual(f.db.prepare('SELECT source_type,idempotency_key FROM vcc_fin_op_effective_rows').all().map(r=>[r.source_type,r.idempotency_key]),[[T.RECHARGE,'001']]);
  assert.ok(!progress.some(p=>p.sourceType===T.CHANNEL||p.phase==='summarizing'));
  if(cancelDuringClose){assert.equal(events.at(-1).event,'close-complete');assert.equal(events.at(-1).cancelled,true)}
  console.log(JSON.stringify({cancelDuringClose,events,error:{code:caught.code,message:caught.message},partial: caught.partialResult}));
 });
});
