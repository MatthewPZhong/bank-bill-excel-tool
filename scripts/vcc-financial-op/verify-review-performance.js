'use strict';
// Independent PF evidence runner. Never interprets supplemental or missing evidence as acceptance.
// node scripts/vcc-financial-op/verify-review-performance.js --mode smoke --output <new-directory>
// node scripts/vcc-financial-op/verify-review-performance.js --mode windows --output <new-directory> [--case pf02]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { collectDiskBaseline } = require('./performance-disk-baseline');
const root = path.resolve(__dirname, '../..');
const CASES = ['pf01-100k', 'pf01-1m', 'pf02', 'pf03', 'pf04', 'cancel-prepare', 'cancel-extract', 'cancel-write', 'cancel-readback', 'cancel-drain', 'cancel-publish'];
const VERIFICATION_SCRIPTS = ['verify-review-performance.js', 'performance-fixture.js', 'performance-worker.js',
  'performance-disk-baseline.js', 'collect-performance-disk.ps1', 'performance-rss-sampler.js', 'performance-memory-contract.js'];
const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const mib = 1024 * 1024;
function baseline(directory) {
  let disk = null, diskError = null;
  if (process.platform === 'win32') {
    disk = collectDiskBaseline(directory); diskError = disk.error;
  }
  const checks = { windowsX64: process.platform === 'win32' && process.arch === 'x64',
    memory16GiB: os.totalmem() >= 15 * 1024 ** 3 && os.totalmem() <= 17 * 1024 ** 3,
    localSsd: disk?.identityProof.status === 'PASS',
    electronLocked: process.versions.electron === '36.9.5', exceljsLocked: require('exceljs/package.json').version === '4.4.0',
    sameVolume: true };
  return { status: Object.values(checks).every(Boolean) ? 'PASS' : 'NOT_RUN', checks, disk, diskError,
    platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model,
    totalMemoryBytes: os.totalmem(), electron: process.versions.electron, node: process.version,
    exceljs: require('exceljs/package.json').version, directory,
    sameVolumeReason: 'Inputs, business DB, temporary manifest and output are descendants of the one newly created case directory.' };
}
async function independentReadback(filePath, manifest, fixture, name) {
  const { openRichWorkbook } = require('../../src/backend/xlsx-rich-reader');
  const { SOURCE_TYPES: T, SUPPORTED_CURRENCIES: CURRENCIES, getSourceDefinition } = require('../../src/backend/vcc-financial-op/definitions');
  const book = await openRichWorkbook(filePath, { memoryBudgetBytes: 64 * mib });
  const pages = [];
  try {
    assert.equal(book.sheets.length, manifest.pages.length + 1);
    for (let index = 0; index < manifest.pages.length; index += 1) {
      const page = manifest.pages[index], group = JSON.parse(page.descriptor), subjectIndex = fixture.subjects.indexOf(group.subject);
      assert.ok(subjectIndex >= 0); let count = 0, headers;
      await book.scanSheet(index + 1, (row) => {
        assert.ok(row.cells.every((c) => !c.hasFormula));
        const cells = new Map(row.cells.map((c) => [c.columnIndex, c.decodedSemanticValue]));
        if (row.rowIndex === 1) { headers = group.headers; assert.deepEqual(headers.map((_, i) => cells.get(i) ?? ''), headers); return; }
        count += 1; const ordinal = page.start_ordinal + count - 1;
        const value = (key) => cells.get(headers.indexOf(key));
        if (group.sourceType === T.RECHARGE) {
          const n = name === 'pf02' ? ordinal - 1 : subjectIndex * 6 + ordinal - 1;
          assert.equal(value('订单号'), `0000000000000000000000R${String(n).padStart(10, '0')}`);
          assert.equal(value('备注'), `=1+1 唯一备注 ${n}`);
        } else if (group.sourceType === T.PENDING) {
          const n = subjectIndex + (ordinal - 1) * fixture.subjects.length;
          assert.equal(value('PendingBizId'), `0000000000000000000000P${String(n).padStart(10, '0')}`);
          assert.equal(value('备注'), `=1+1 唯一长文本 ${n} ${'文本'.repeat(20)}`);
          assert.equal(headers.length, getSourceDefinition(T.PENDING).headers.length);
        } else if (group.sourceType === T.CHANNEL) assert.equal(value('渠道订单号'), `channel-${subjectIndex}`);
        else if (group.sourceType === T.FEE_FX) assert.equal(value('订单号'), `fee-${subjectIndex}`);
        else { assert.equal(value('主体'), group.subject); assert.equal(value('币种'), group.currency); }
      });
      assert.equal(count, page.row_count); pages.push({ name: page.name, sourceType: group.sourceType, subject: group.subject, currency: group.currency, part: page.part, rows: count });
    }
    const sum = (type) => pages.filter((p) => p.sourceType === type).reduce((n, p) => n + p.rows, 0);
    assert.equal(sum(T.PENDING), fixture.spec.pending * 2); assert.equal(sum(T.RECHARGE), fixture.spec.recharge);
    assert.equal(sum(T.CHANNEL), fixture.spec.subjects); assert.equal(sum(T.FEE_FX), fixture.spec.subjects);
    // Independent handwritten group expectations: missing an entire source type must not
    // pass just because E/A/X were all derived from the same incomplete manifest.
    const expectedGroups = new Map(), actualGroups = new Map();
    const key = (subject, currency, type) => JSON.stringify([subject, currency, type]);
    const systemCurrencies = fixture.spec.adjustments >= fixture.spec.subjects * 9 ? CURRENCIES
      : fixture.spec.adjustments ? ['AUD', 'CAD', 'EUR', 'USD'] : ['EUR', 'USD'];
    for (const [index, subject] of fixture.subjects.entries()) {
      expectedGroups.set(key(subject, 'USD', T.RECHARGE), name === 'pf02' ? 1048576 : 6);
      expectedGroups.set(key(subject, 'USD', T.FEE_FX), 1);
      expectedGroups.set(key(subject, 'EUR', T.CHANNEL), 1);
      const pending = Math.floor((fixture.spec.pending - 1 - index) / fixture.spec.subjects) + 1;
      for (const currency of ['USD', 'EUR']) expectedGroups.set(key(subject, currency, T.PENDING), pending);
      for (const currency of systemCurrencies) expectedGroups.set(key(subject, currency, T.SYSTEM_OP), 1);
    }
    for (const page of pages) {
      const groupKey = key(page.subject, page.currency, page.sourceType);
      actualGroups.set(groupKey, (actualGroups.get(groupKey) || 0) + page.rows);
    }
    assert.deepEqual([...actualGroups].sort(), [...expectedGroups].sort());
    if (name === 'pf02') {
      assert.deepEqual(pages.filter((p) => p.sourceType === T.RECHARGE).map((p) => p.rows), [1048575, 1]);
      assert.deepEqual(manifest.pages.filter((p) => JSON.parse(p.descriptor).sourceType === T.RECHARGE).map((p) => p.start_ordinal), [1, 1048576]);
    }
    if (name === 'pf03') { assert.ok(pages.length >= 500); assert.equal(fixture.spec.subjects, 200); assert.equal(manifest.projection.filter((r) => r.kind === 'adjustment').length, 10000); }
    return { status: 'PASS', pages, sourceRowCount: pages.reduce((n, p) => n + p.rows, 0), manualExcelWps: 'NOT_RUN' };
  } finally { await book.close(); }
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function currentScriptSha256() {
  return Object.fromEntries(VERIFICATION_SCRIPTS.map((name) => [name, digest(fs.readFileSync(path.join(__dirname, name)))]));
}
function currentProductionIdentity() {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const paths = ['src', 'assets', 'package.json', 'package-lock.json'];
  return { buildSha: git(['rev-parse', 'HEAD']),
    productionDirty: !!git(['diff', '--name-only', 'HEAD', '--', ...paths])
      || !!git(['ls-files', '--others', '--exclude-standard', '--', ...paths]) };
}
function verifyProductionIdentity(environment, config) {
  const observed = currentProductionIdentity();
  assert.match(config.buildSha, /^[a-f0-9]{40}$/);
  assert.equal(observed.buildSha, config.buildSha, '实际生产构建偏离本轮冻结提交');
  assert.equal(observed.productionDirty, false, '生产文件存在未提交改动');
  assert.equal(config.buildIdentity.productionDirty, false, '本轮未冻结干净的生产构建');
  assert.deepEqual(observed, environment.observedProductionIdentity, '生产构建在子进程运行期间发生变化');
  environment.productionIdentityUnchanged = true;
}
function verifyVerificationScripts(environment) {
  const observed = currentScriptSha256();
  assert.deepEqual(observed, environment.buildIdentity.scriptSha256, '采集脚本偏离本轮冻结身份');
  assert.deepEqual(observed, environment.observedScriptSha256, '采集脚本在子进程运行期间发生变化');
  environment.verificationScriptsUnchanged = true;
}
function caseEnvironment(config) {
  const environment = baseline(config.directory);
  environment.buildIdentity = config.buildIdentity;
  environment.machineId = digest(os.hostname());
  environment.observedScriptSha256 = currentScriptSha256();
  environment.observedProductionIdentity = currentProductionIdentity();
  environment.checks.frozenVerificationScripts = VERIFICATION_SCRIPTS.every((name) => environment.observedScriptSha256[name] === config.buildIdentity?.scriptSha256?.[name]);
  environment.checks.knownBuildSha = /^[a-f0-9]{40}$/.test(config.buildSha)
    && environment.observedProductionIdentity.buildSha === config.buildSha;
  environment.checks.cleanProduction = config.buildIdentity?.productionDirty === false
    && environment.observedProductionIdentity.productionDirty === false;
  environment.status = Object.values(environment.checks).every(Boolean) ? 'PASS' : 'NOT_RUN';
  return environment;
}
async function setupElectron(config, phase) {
  const { app } = require('electron');
  app.setPath('userData', path.join(config.directory, `${phase}-user-data`));
  app.setPath('sessionData', path.join(config.directory, `${phase}-session-data`));
  app.disableHardwareAcceleration(); await app.whenReady();
}
async function prepareElectronFixture(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  await setupElectron(config, 'fixture');
  const report = { schemaVersion: 2, case: config.name, mode: config.mode, buildSha: config.buildSha,
    runId: config.runId, pid: process.pid, environment: caseEnvironment(config), automated: 'NOT_RUN', acceptance: 'NOT_RUN' };
  let timer;
  try {
    verifyVerificationScripts(report.environment);
    verifyProductionIdentity(report.environment, config);
    if (config.mode === 'windows' && report.environment.status !== 'PASS') {
      report.reason = 'Fixed Windows baseline not satisfied; no large fixture was generated.'; return report;
    }
    const started = Date.now();
    const progress = () => console.log('[vcc-pf-progress] ' + JSON.stringify({ case: config.name,
      phase: 'fixture-preparation', elapsedMs: Date.now() - started }));
    progress(); timer = setInterval(progress, 30000); timer.unref();
    report.fixture = await require('./performance-fixture').createPerformanceFixture(config.directory, config.name, config.buildSha);
    report.preparationMs = Date.now() - started;
    report.fixtureSha256 = digest(JSON.stringify(report.fixture));
    report.files = [];
    // 准备函数返回前已关闭数据库，测量进程不得继承准备阶段的分配器和缓存。
    for (const file of [report.fixture.dbPath, `${report.fixture.dbPath}-wal`, `${report.fixture.dbPath}-shm`, report.fixture.filePath]) {
      if (!fs.existsSync(file)) { report.files.push({ path: file, exists: false }); continue; }
      const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
      report.files.push({ path: file, exists: true, bytes: stat.size, sha256: await hashFile(file) });
    }
    report.automated = 'PASS'; return report;
  } catch (error) { report.automated = 'FAIL'; report.error = { message: error.message, stack: error.stack }; return report; }
  finally {
    if (timer) clearInterval(timer);
    try { verifyVerificationScripts(report.environment); verifyProductionIdentity(report.environment, config); }
    catch (error) { report.automated = 'FAIL'; report.error = { message: error.message }; }
    json(path.join(config.directory, 'fixture-preparation.json'), report);
  }
}
async function loadPreparedFixture(config) {
  const evidencePath = path.join(config.directory, 'fixture-preparation.json'), bytes = fs.readFileSync(evidencePath);
  const report = JSON.parse(bytes.toString('utf8'));
  assert.equal(report.schemaVersion, 2); assert.equal(report.automated, 'PASS');
  assert.equal(report.runId, config.runId); assert.equal(report.case, config.name); assert.equal(report.buildSha, config.buildSha);
  assert.deepEqual(report.childExit, { code: 0, signal: null });
  assert.ok(Number.isSafeInteger(report.pid) && report.pid > 0 && report.pid !== process.pid, 'Fixture must finish in a separate process');
  assert.equal(digest(JSON.stringify(report.fixture)), report.fixtureSha256, 'Fixture metadata changed');
  const expected = [report.fixture.dbPath, `${report.fixture.dbPath}-wal`, `${report.fixture.dbPath}-shm`, report.fixture.filePath];
  assert.equal(report.fixture.directory, config.directory);
  assert.equal(report.fixture.dbPath, path.join(config.directory, 'business.sqlite'));
  assert.equal(report.fixture.filePath, path.join(config.directory, '多工作表性能合成样本.xlsx'));
  assert.equal(report.files[0]?.exists, true); assert.equal(report.files[3]?.exists, true);
  assert.deepEqual(report.environment.buildIdentity.scriptSha256, config.buildIdentity.scriptSha256);
  assert.deepEqual(currentScriptSha256(), config.buildIdentity.scriptSha256, '准备记录与实际采集脚本不一致');
  assert.deepEqual(report.files.map((file) => file.path), expected);
  for (const file of report.files) {
    const relative = path.relative(config.directory, file.path);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    assert.equal(fs.existsSync(file.path), file.exists, 'Prepared file existence changed');
    if (file.exists) {
      const stat = fs.lstatSync(file.path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.size, file.bytes); assert.equal(await hashFile(file.path), file.sha256, 'Prepared file changed');
    }
  }
  return { ...report, evidencePath, evidenceSha256: digest(bytes), filesVerified: true };
}
function threadMemory() {
  const { rss: _processRss, ...memory } = process.memoryUsage();
  return memory; // 线程辅助指标不命名为RSS，也不与进程RSS相加。
}
async function electronCase(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  await setupElectron(config, 'measurement');
  const environment = caseEnvironment(config);
  const report = { schemaVersion: 2, case: config.name, mode: config.mode, buildSha: config.buildSha, environment,
    acceptance: 'NOT_RUN', automated: 'NOT_RUN', manualExcelWps: 'NOT_RUN', nativeDialog: 'stubbed', fullMainColdStart: 'NOT_RUN',
    memoryAttribution: { processRss: 'All Main and worker_threads share this PID; do not add thread RSS values.',
      metric: 'host-process-rss-v1', independentWorkerRss: 'N/A', reason: 'Superseded by explicit host-process-rss-v1 contract; not equivalent isolated Worker RSS.',
      sampleIntervalMs: 500, workerHeap: 'Each isolate heap/external/arrayBuffers are supplemental, not RSS.' },
    fixtureSetup: { importedBy: 'Production inspect/resolve/importFiles/calculator',
      seeded: ['Archive batch/artifact and fingerprint', 'Previous-month archived run and opening balances', 'Saved adjustments'],
      excluded: ['Main import IPC and TaskLifecycle/FilePlan', 'Previous-month archive command', 'Per-adjustment mutation command performance'] },
    sstDictionaryStress: 'NOT_RUN', syntheticTextStorage: 'inline strings; no nonempty shared-string dictionary is generated',
    scope: 'Synthetic real import and calculation; production IPC handler, Service, original Review Worker, writer and validator; instrumentation wrapper only.' };
  let service, db, timer, progressTimer, rssSampler; const samples = [], events = [], progress = [];
  const progressStartedAt = Date.now();
  let progressPhase = 'fixture-preparation', lastProgressPhase, lastProgressAt = 0, progressCounters = {};
  const logProgress = (nextPhase = progressPhase, counters = {}) => {
    progressPhase = nextPhase;
    for (const key of ['rows', 'readRows']) if (Number.isSafeInteger(counters[key]) && counters[key] >= 0) progressCounters[key] = counters[key];
    const now = Date.now();
    if (progressPhase === lastProgressPhase && now - lastProgressAt < 30000) return;
    lastProgressAt = now; lastProgressPhase = progressPhase;
    console.log('[vcc-pf-progress] ' + JSON.stringify({ case: config.name, phase: progressPhase,
      elapsedMs: now - progressStartedAt, ...progressCounters }));
  };
  try {
    verifyVerificationScripts(environment);
    verifyProductionIdentity(environment, config);
    if (config.mode === 'windows' && environment.status !== 'PASS') {
      report.reason = 'Fixed Windows baseline not satisfied; no large fixture was generated.'; return report;
    }
    logProgress('verify-prepared-fixture'); progressTimer = setInterval(() => logProgress(), 30000); progressTimer.unref();
    const prepared = await loadPreparedFixture(config), fixture = prepared.fixture;
    report.fixture = { ...fixture, preparationMs: prepared.preparationMs, adjustmentSetup: 'Separate process preparation; persisted synthetic rows, not adjustment command performance.' };
    report.memoryMeasurement = { metric: 'host-process-rss-v1', runId: config.runId, hostPid: process.pid, coldProcess: true,
      fixturePreparation: { pid: prepared.pid, exitCode: prepared.childExit.code, signal: prepared.childExit.signal,
        buildSha: prepared.buildSha, fixtureSha256: prepared.fixtureSha256, evidencePath: prepared.evidencePath,
        evidenceSha256: prepared.evidenceSha256, filesVerified: prepared.filesVerified }, preparedFiles: prepared.files };
    const { DatabaseSync } = require('node:sqlite'), { Worker } = require('node:worker_threads');
    db = new DatabaseSync(fixture.dbPath);
    require('../../src/backend/vcc-financial-op-db/storage-contract').assertVccStorageContract(db);
    require('../../src/backend/vcc-financial-op-db/storage-contract').registerVccStorageWriteCapability(db);
    const cancellation = { requestedAt: null, finishedAt: null, result: null }; let cancelPromise, manifest;
    const cancel = () => { if (!cancelPromise) { cancellation.requestedAt = Date.now(); cancelPromise = service.cancelActiveTask().then((value) => { cancellation.finishedAt = Date.now(); cancellation.result = value; }); } };
    service = require('../../src/main-process/vcc-financial-op-service').createVccFinancialOpService({
      database: { db, dbPath: fixture.dbPath }, assetsDir: path.join(root, 'assets'), appVersion: '3.2.9',
      archiveServiceProvider: () => ({ rootDir: fixture.archiveRoot }),
      reviewWorkerFactory(filename, options) {
        const worker = new Worker(path.join(__dirname, 'performance-worker.js'), { ...options, workerData: { ...options.workerData,
          productionWorkerPath: filename, performanceProbe: { cancelPhase: config.name.startsWith('cancel-') ? config.name.slice(7) : null,
            bytesPerSecond: ['pf04', 'cancel-drain'].includes(config.name) ? mib : null,
            pauseMs: config.name === 'cancel-drain' ? 30000 : 5000, cancelOnDrain: config.name === 'cancel-drain' } } });
        worker.on('message', (message) => {
          if (message?.type !== 'performance-probe') return;
          events.push(message); if (message.kind === 'manifest') manifest = message;
          if (message.kind === 'stage-start') logProgress(message.phase);
          if (message.kind === 'sample') logProgress(progressPhase, message);
          if (message.kind === 'cancel-point') cancel();
        });
        worker.once('exit', (code) => events.push({ kind: 'worker-exit', at: Date.now(), code })); return worker;
      }
    });
    // Any business/Archive DML during successful export, cancellation or cleanup fails immediately.
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'vcc_fin_op_%' OR name LIKE 'archive_%')").all()) {
      for (const verb of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER "pf_no_${verb}_${name}" BEFORE ${verb} ON "${name}" BEGIN SELECT RAISE(ABORT, 'PF export must be read-only'); END`);
    }
    const target = path.join(config.directory, '待确认表.xlsx');
    const handler = require('../../src/main-process/vcc-financial-op-review-ipc').createReviewExportHandler({
      getService: () => service, getWindow: () => null, documentsPath: config.directory,
      tempRoot: path.join(config.directory, 'review-temp'), protectedRoots: [fixture.archiveRoot],
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) } });
    const sample = () => samples.push({ at: Date.now(), role: 'Main', pid: process.pid, threadId: 0, memory: threadMemory() });
    if (global.gc) global.gc();
    rssSampler = await require('./performance-rss-sampler').startRssSampler({ outputPath: path.join(config.directory, 'process-rss.jsonl') });
    report.memoryMeasurement.startAtNs = process.hrtime.bigint().toString();
    const exportStart = Date.now(); sample(); timer = setInterval(sample, 500);
    const exported = await handler({ sender: { isDestroyed: () => false, send(_channel, value) {
      progress.push({ at: Date.now(), ...value }); if (config.name === 'cancel-publish' && value.phase === 'publishing') cancel();
    } } }, fixture.request);
    await cancelPromise; sample(); clearInterval(timer); timer = null;
    assert.deepEqual(fs.readdirSync(path.join(config.directory, 'review-temp')), []);
    assert.equal(fs.readdirSync(config.directory).some((n) => n.startsWith('.vcc-review-')), false);
    report.cleanup = 'PASS';
    report.memoryMeasurement.endAtNs = process.hrtime.bigint().toString();
    report.memoryMeasurement.sampler = await rssSampler.stop(); rssSampler = null;
    Object.assign(report, { exported, elapsedMs: Date.now() - exportStart, samples, workerEvents: events, progress, cancellation,
      businessDml: 'No business/Archive INSERT/UPDATE/DELETE permitted by temporary fixture triggers.' });
    report.processPeakRssBytes = report.memoryMeasurement.sampler.peakRssBytes;
    report.processBaselineRssBytes = report.memoryMeasurement.sampler.baselineRssBytes;
    if (config.mode === 'smoke') assert.equal(report.memoryMeasurement.sampler.status, 'PASS', 'RSS sampling incomplete');
    if (manifest) report.comparisonMetadata = { subjects: fixture.subjects, physicalFiles: fixture.physicalFiles,
      inputSheetCount: fixture.inputSheetCount, outputSheetCount: exported.sheetCount, structureVersion: 'v3', spec: fixture.spec,
      groups: manifest.pages.map((page) => { const group = JSON.parse(page.descriptor);
        return { subject: group.subject, currency: group.currency, sourceType: group.sourceType,
          rawContractVersion: group.rawContractVersion, headers: group.headers, part: page.part, name: page.name }; }) };
    if (config.name.startsWith('cancel-') && config.name !== 'cancel-publish') {
      assert.equal(exported.status, 'cancelled', JSON.stringify(exported)); assert.equal(fs.existsSync(target), false);
      assert.ok(cancellation.requestedAt); assert.equal(cancellation.result?.forced, false);
      report.automated = 'PASS'; report.cancellation.stageBoundaryOnly = config.name !== 'cancel-drain';
      report.cancellation.drainWaitProof = config.name === 'cancel-drain' ? assertFlowProof(events, { cancelled: true }) : 'NOT_RUN';
      report.cancellation.interruptionScope = config.name === 'cancel-drain' ? 'Actual SheetStream drain wait aborted while output remained paused; source cursor and handles closed' : 'Real phase entry boundary';
      report.reason = config.name === 'cancel-drain'
        ? 'Real drain cancellation verified; other PF05 phase and native UI acceptance remain separate.'
        : 'Cancellation observed in real stage; phase-boundary probes do not prove all in-stage cursor and UI timings.';
    } else {
      assert.equal(exported.status, 'success', JSON.stringify(exported)); assert.ok(manifest);
      assert.equal(exported.subjectCount, fixture.spec.subjects);
      logProgress('independent-readback');
      report.readback = await independentReadback(target, manifest, fixture, config.name);
      assert.equal(report.readback.sourceRowCount, exported.sourceRowCount);
      report.automated = 'PASS'; report.outputBytes = fs.statSync(target).size;
      const extraction = events.find((e) => e.kind === 'stage-result' && e.phase === 'extract')?.result;
      assert.equal(extraction?.scannedFiles, fixture.physicalFiles); report.extraction = extraction;
      if (config.name === 'cancel-publish') { assert.ok(cancellation.requestedAt); assert.equal(cancellation.result?.status, 'completed'); }
      if (config.name === 'pf04') {
        const pause = events.find((e) => e.kind === 'output-paused'); assert.ok(pause, 'Output pause did not occur');
        const summaries = events.filter((e) => e.kind === 'summary');
        assert.ok(summaries.length >= 2, 'Missing Worker summary observations');
        assert.ok(summaries.every((e) => Number.isFinite(e.queuePeak) && e.queuePeak >= 0), 'Invalid queue peak');
        const queueSamples = events.filter((e) => e.kind === 'sample' && e.phase === 'write');
        assert.ok(queueSamples.length > 0, 'No writing queue sample');
        assert.ok(queueSamples.every((e) => ['sheet', 'zip', 'zipEngine', 'output', 'total'].every((k) => Number.isFinite(e.queues?.[k]) && e.queues[k] >= 0)), 'Missing queue metrics');
        const peak = Math.max(...summaries.map((e) => e.queuePeak));
        assert.ok(peak <= 24 * mib, `Observed queue peak ${peak} exceeds 8 MiB + 16 MiB single-row budget`);
        report.backpressure = { configuredBytesPerSecond: mib, pauseMs: 5000, queuePeakBytes: peak,
          upstreamStopProof: assertFlowProof(events), reason: 'Actual SQLite pageRows cursor stopped during SheetStream drain and resumed after output/drain; original XLSX extraction had already completed.' };
        assert.equal(report.backpressure.upstreamStopProof.sourceRows, exported.sourceRowCount);
      }
    }
    if (config.mode === 'windows' && config.name === 'pf02') report.acceptance = 'PASS';
    if (config.name === 'pf03') report.structuralAcceptance = 'PASS';
    return report;
  } catch (error) { report.automated = 'FAIL'; report.error = { message: error.message, code: error.code, stack: error.stack }; return report; }
  finally {
    if (timer) clearInterval(timer); if (progressTimer) clearInterval(progressTimer);
    await service?.terminate(); db?.close();
    if (rssSampler) {
      try { report.memoryMeasurement.endAtNs ||= process.hrtime.bigint().toString(); report.memoryMeasurement.sampler = await rssSampler.stop(); }
      catch (error) { report.automated = 'FAIL'; report.samplingError = error.message; }
    }
    try { verifyVerificationScripts(environment); verifyProductionIdentity(environment, config); }
    catch (error) { report.automated = 'FAIL'; report.error = { message: error.message }; }
    json(path.join(config.directory, 'evidence.json'), report);
  }
}
// FLOW_PROOF_START
function assertFlowProof(events, { cancelled = false } = {}) {
  const blocked = events.filter((e) => e.kind === 'sheet-drain-blocked' && e.phase === 'write');
  assert.ok(blocked.length, 'No actual SheetStream drain wait observed during output pause');
  for (const item of blocked) {
    assert.ok(['at', 'since', 'sourceRowsStart', 'sourceRowsEnd', 'row'].every((key) => Number.isFinite(item[key])), 'Missing finite drain observations');
    assert.ok(item.sourceRowsStart > 0 && item.row > 1, 'Observed wait must be on an actual appendix data row');
    assert.equal(item.sourceRowsStart, item.sourceRowsEnd, 'Source cursor advanced during observed drain wait');
    assert.equal(item.pendingCommits, 1); assert.equal(item.writableNeedDrain, true); assert.equal(item.outputPaused, true);
    assert.ok(item.originalDrainListeners > 0); assert.ok(item.at - item.since >= 100, 'Drain wait was not observed across time');
  }
  const summaries = events.filter((e) => e.kind === 'summary' && e.flow?.sourceRows > 0);
  assert.equal(summaries.length, 1, 'Missing write Worker flow summary');
  const flow = summaries[0].flow;
  assert.ok(['sourceRows', 'sourceNextCalls', 'sourceCursors', 'pendingCommits', 'maxPendingCommits', 'nextWhileCommitPending', 'cursorReturns'].every((key) => Number.isSafeInteger(flow[key]) && flow[key] >= 0), 'Missing source cursor counters');
  assert.equal(flow.nextWhileCommitPending, 0); assert.equal(flow.pendingCommits, 0);
  assert.equal(flow.sourceCursors, 0); assert.equal(flow.maxPendingCommits, 1);
  const settled = events.filter((e) => e.kind === 'sheet-drain-settled' && e.phase === 'write');
  assert.ok(settled.length, 'Missing actual drain completion/abort evidence');
  assert.ok(settled.every((e) => e.sourceRowsStart === e.sourceRowsEnd && e.originalDrainListenersRemoved));
  assert.ok(events.some((e) => e.kind === 'database-closed' && e.phase === 'write' && Array.isArray(e.files) && e.files.length > 0));
  const outputClose = events.find((e) => e.kind === 'output-closed' && e.phase === 'write');
  assert.ok(outputClose, 'Output close was not observed');
  if (cancelled) {
    assert.ok(flow.cursorReturns > 0, 'Cancelled source cursor was not returned');
    assert.equal(flow.sourceRows, flow.sourceRowsAtCancel, 'Source cursor continued after Worker received cancel');
    assert.equal(events.some((e) => e.kind === 'output-resumed'), false, 'Cancellation depended on output resume');
    assert.equal(outputClose.outputPaused, true);
    assert.ok(settled.some((e) => e.aborted === true && e.drainedAt === null && e.outputResumedAt === null));
    assert.ok(events.some((e) => e.kind === 'cancel-received' && e.sourceRows === flow.sourceRows));
  } else {
    const resumed = events.find((e) => e.kind === 'source-resumed');
    assert.ok(resumed, 'Source cursor did not resume after output/drain resumed');
    assert.ok(Number.isFinite(resumed.outputResumedAt) && Number.isFinite(resumed.drainedAt));
    assert.ok(resumed.drainedAt >= resumed.outputResumedAt && resumed.at >= resumed.drainedAt);
    assert.ok(resumed.sourceRows > resumed.priorSourceRows);
    assert.ok(settled.some((e) => !e.aborted && e.outputResumedAt === resumed.outputResumedAt
      && e.drainedAt === resumed.drainedAt && e.sourceRowsEnd === resumed.priorSourceRows));
  }
  return { status: 'PASS', sampledBlockedWaits: blocked.length, sourceRows: flow.sourceRows,
    maxPendingCommits: flow.maxPendingCommits, cursorReturns: flow.cursorReturns,
    sourceRowsAtCancel: flow.sourceRowsAtCancel, sourceResumeCount: flow.resumed };
}
// FLOW_PROOF_END

async function runCaseProcess(configPath, directory, phase) {
  return new Promise((resolve, reject) => {
    const electronEnv = { ...process.env };
    // Windows 下空值仍会启用 Node 模式；移除变量及其大小写变体。
    for (const key of Object.keys(electronEnv)) {
      if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete electronEnv[key];
    }
    const child = spawn(require('electron'), ['--js-flags=--expose-gc', __filename, phase === 'fixture' ? '--fixture-child' : '--electron-child', configPath],
      { env: electronEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(directory, phase === 'fixture' ? 'fixture-run.log' : 'run.log'), { flags: 'wx' });
    let progressBuffer = '';
    child.stdout.on('data', (data) => {
      log.write(data); progressBuffer += data.toString('utf8');
      let newline;
      while ((newline = progressBuffer.indexOf('\n')) >= 0) {
        const line = progressBuffer.slice(0, newline); progressBuffer = progressBuffer.slice(newline + 1);
        if (line.startsWith('[vcc-pf-progress] ') && line.length <= 2048) process.stdout.write(line + '\n');
      }
      if (progressBuffer.length > 2048) progressBuffer = progressBuffer.slice(-2048);
    });
    child.stderr.on('data', (data) => log.write(data));
    child.once('error', (error) => { log.end(); reject(error); });
    child.once('close', (code, signal) => { if (signal) log.write(`Electron ended by ${signal}\n`); log.end(() => resolve({ code, signal })); });
  });
}

async function main() {
  const args = process.argv.slice(2), get = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  if (args.includes('--help')) { console.log('Usage: node scripts/vcc-financial-op/verify-review-performance.js --mode smoke|windows --output NEW_DIRECTORY [--case CASE]\nCases: ' + CASES.join(', ') + '\nExit 0=all requested acceptance passed; 2=evidence generated with NOT_RUN acceptance; 1=automated failure. Smoke exit 0 means supplemental smoke only.'); return; }
  const mode = get('--mode') || 'smoke', requested = get('--case');
  if (!['smoke', 'windows'].includes(mode) || (requested && !CASES.includes(requested))) throw new Error('Invalid mode/case');
  if (mode === 'smoke' && requested && !requested.startsWith('cancel-')) throw new Error('Large cases require --mode windows; smoke only accepts cancellation cases');
  const output = get('--output'); if (!output) throw new Error('--output NEW_DIRECTORY is required');
  const destination = path.resolve(output); fs.mkdirSync(destination); // fail if existing, preserve previous evidence
  let buildSha = 'unknown'; try { buildSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch (_error) { /* explicit unknown */ }
  let productionDirty = true, workingTreeStatus = 'unknown';
  try {
    productionDirty = !!execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src', 'assets', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim()
      || !!execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src', 'assets', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim();
    workingTreeStatus = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (_error) { /* identity remains unverified */ }
  const scriptSha256 = currentScriptSha256();
  const buildIdentity = { productionDirty, workingTreeStatus, scriptSha256 };
  const results = [], reports = [], runId = randomUUID();
  for (const name of requested ? [requested] : mode === 'smoke' ? ['smoke'] : CASES) {
    const directory = path.join(destination, name); fs.mkdirSync(directory); const configPath = path.join(directory, 'config.json');
    json(configPath, { directory, name, mode, buildSha, buildIdentity, runId });
    const preparedExit = await runCaseProcess(configPath, directory, 'fixture');
    const preparedPath = path.join(directory, 'fixture-preparation.json');
    const prepared = fs.existsSync(preparedPath) ? JSON.parse(fs.readFileSync(preparedPath, 'utf8'))
      : { automated: 'FAIL', acceptance: 'NOT_RUN', error: 'Fixture process produced no evidence' };
    prepared.childExit = preparedExit;
    if (preparedExit.code !== 0 || preparedExit.signal) prepared.automated = 'FAIL';
    json(preparedPath, prepared);
    let code = preparedExit.code, signal = preparedExit.signal;
    if (prepared.automated === 'PASS') ({ code, signal } = await runCaseProcess(configPath, directory, 'measure'));
    else json(path.join(directory, 'evidence.json'), { ...prepared, memoryMeasurement: { metric: 'host-process-rss-v1', status: 'NOT_RUN' } });
    const evidencePath = path.join(directory, 'evidence.json');
    const report = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : { automated: 'FAIL', error: 'Electron did not produce evidence', acceptance: 'NOT_RUN' };
    report.childExit = { code, signal };
    if (code !== 0 || signal) { report.automated = 'FAIL'; report.processFailure = `Electron exited with code=${code}, signal=${signal}`; }
    json(evidencePath, report); reports.push(report);
    results.push({ name, code, signal, evidencePath, automated: report.automated, acceptance: report.acceptance,
      processPeakRssBytes: report.processPeakRssBytes, fixture: report.fixture?.spec, sheetCount: report.exported?.sheetCount });
    console.log(JSON.stringify(results.at(-1)));
    if (code !== 0 || signal || report.automated === 'FAIL') break;
  }
  const memoryComparison = await require('./performance-memory-contract').evaluatePf01MemoryComparison(reports.filter((report) => ['pf01-100k', 'pf01-1m'].includes(report.case)));
  const summary = { schemaVersion: 2, mode, buildSha, buildIdentity, runId, results, acceptance: 'NOT_RUN',
    pf01WorkerRss: { status: 'N/A', reason: 'Explicitly superseded by host-process-rss-v1; historical independent Worker RSS was not measured.' },
    pf01HostProcessRss: memoryComparison, manualWindowsInstalledApplication: 'NOT_RUN', excelWps: 'NOT_RUN' };
  if (memoryComparison.status === 'PASS') {
    for (const result of results.filter((r) => ['pf01-100k', 'pf01-1m'].includes(r.name))) {
      result.acceptance = 'PASS';
      const report = reports.find((r) => r.case === result.name); report.acceptance = 'PASS';
      report.pf01HostProcessRss = memoryComparison; json(result.evidencePath, report);
    }
  }
  summary.requestedCasesAcceptance = results.every((r) => r.acceptance === 'PASS') ? 'PASS' : 'NOT_RUN';
  summary.fullVccAcceptance = 'NOT_RUN';
  json(path.join(destination, 'summary.json'), summary);
  if (results.some((r) => r.automated === 'FAIL') || memoryComparison.status === 'FAIL') process.exitCode = 1;
  else if (mode === 'windows' && !results.every((r) => r.acceptance === 'PASS')) process.exitCode = 2;
}
if (process.versions.electron && process.argv.includes('--fixture-child')) {
  prepareElectronFixture(process.argv[process.argv.indexOf('--fixture-child') + 1]).then((report) => require('electron').app.exit(report.automated === 'FAIL' ? 1 : 0), (error) => { console.error(error); require('electron').app.exit(1); });
} else if (process.versions.electron && process.argv.includes('--electron-child')) {
  electronCase(process.argv[process.argv.indexOf('--electron-child') + 1]).then((report) => require('electron').app.exit(report.automated === 'FAIL' ? 1 : 0), (error) => { console.error(error); require('electron').app.exit(1); });
} else if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { baseline, independentReadback, loadPreparedFixture, hashFile, currentScriptSha256, verifyVerificationScripts,
  currentProductionIdentity, verifyProductionIdentity };
