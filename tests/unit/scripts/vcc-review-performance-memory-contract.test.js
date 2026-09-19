'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { evaluatePf01MemoryComparison } = require('../../../scripts/vcc-financial-op/performance-memory-contract');

const MIB = 1024 * 1024, SHA = 'a'.repeat(40), HASH = 'b'.repeat(64);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const scriptNames = ['verify-review-performance.js', 'performance-fixture.js', 'performance-worker.js',
  'performance-disk-baseline.js', 'collect-performance-disk.ps1', 'performance-rss-sampler.js', 'performance-memory-contract.js'];

function fixture(t, { small = [100, 200, 110], large = [100, 300, 120], count = 3 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pf01-memory-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return [small, large].map((values, index) => {
    const caseDirectory = path.join(directory, String(index)); fs.mkdirSync(caseDirectory);
    const pid = 100 + index, outputPath = path.join(caseDirectory, 'process-rss.jsonl');
    const rows = Array.from({ length: count }, (_, seq) => ({ seq, pid, threadId: 1,
      atNs: String(1000000000n + BigInt(seq) * 500000000n), at: 1800000000000 + seq * 500,
      rssBytes: values[seq === 0 ? 0 : seq === count - 1 ? 2 : 1] * MIB }));
    const bytes = rows.map((row) => JSON.stringify(row) + '\n').join(''); fs.writeFileSync(outputPath, bytes);
    const sampler = { schemaVersion: 1, metric: 'host-process-rss-v1', status: 'PASS', pid, samplerThreadId: 1,
      sampleCount: count, periodicSampleCount: count - 2, intervalMs: 500, maxAllowedGapMs: 750, maxGapMs: 500,
      firstSampleAtNs: rows[0].atNs, lastSampleAtNs: rows.at(-1).atNs, baselineRssBytes: rows[0].rssBytes,
      peakRssBytes: Math.max(...rows.map((row) => row.rssBytes)), finalRssBytes: rows.at(-1).rssBytes,
      durationMs: (count - 1) * 500, outputPath, sha256: hash(bytes) };
    const workerEvents = ['prepare', 'extract', 'write', 'readback'].flatMap((phase) => [
      { kind: 'stage-start', phase }, { kind: 'stage-result', phase, result: {} }, { kind: 'stage-end', phase }
    ]);
    workerEvents.push({ kind: 'worker-exit', code: 0 }, { kind: 'worker-exit', code: 0 });
    const report = { case: index ? 'pf01-1m' : 'pf01-100k', mode: 'windows', buildSha: SHA,
      automated: 'PASS', cleanup: 'PASS', readback: { status: 'PASS' }, childExit: { code: 0, signal: null }, workerEvents,
      environment: { status: 'PASS', directory: caseDirectory, platform: 'win32', arch: 'x64', osRelease: '10.0.test', cpu: 'controlled-CPU',
        machineId: 'c'.repeat(64), totalMemoryBytes: 16 * 1024 ** 3, electron: '36.9.5', node: 'v22.19.0', exceljs: '4.4.0',
        disk: { identityProof: { status: 'PASS', targetUniqueId: 'disk-a', matchedPhysicalUniqueId: 'disk-a' },
          evidence: { instance: { computerName: 'host-a', runId: 'ci-run', runAttempt: '1' }, volumes: [{ UniqueId: 'volume-a' }] } },
        buildIdentity: { productionDirty: false, scriptSha256: Object.fromEntries(scriptNames.map((name) => [name, HASH])) } },
      memoryMeasurement: { metric: 'host-process-rss-v1', runId: 'one-pair', hostPid: pid, coldProcess: true,
        fixturePreparation: { pid: 200 + index, exitCode: 0, signal: null, buildSha: SHA, fixtureSha256: String(index + 1).repeat(64) },
        startAtNs: String(BigInt(rows[0].atNs) + 1000000n), endAtNs: String(BigInt(rows.at(-1).atNs) - 1000000n), sampler },
      comparisonMetadata: { subjects: ['甲', '乙'], physicalFiles: 1, inputSheetCount: 6, outputSheetCount: 15,
        structureVersion: 'v3', groups: [{ subject: '甲', currency: 'USD', sourceType: 'pending', rawContractVersion: 'v3', headers: ['id'], part: 1, name: '甲USD' },
          { subject: '乙', currency: 'EUR', sourceType: 'pending', rawContractVersion: 'v3', headers: ['id'], part: 1, name: '乙EUR' }],
        spec: { subjects: 2, pending: index ? 1000000 : 100000, recharge: 12, adjustments: 0 } } };
    report.environment.observedScriptSha256 = structuredClone(report.environment.buildIdentity.scriptSha256);
    report.environment.verificationScriptsUnchanged = true;
    report.environment.observedProductionIdentity = { buildSha: SHA, productionDirty: false };
    report.environment.productionIdentityUnchanged = true;
    const dbPath = path.join(caseDirectory, 'business.sqlite'), filePath = path.join(caseDirectory, '多工作表性能合成样本.xlsx');
    fs.writeFileSync(dbPath, 'controlled database'); fs.writeFileSync(filePath, 'controlled input ' + index);
    const files = [dbPath, dbPath + '-wal', dbPath + '-shm', filePath].map((file) => fs.existsSync(file)
      ? { path: file, exists: true, bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) } : { path: file, exists: false });
    const preparedFixture = { directory: caseDirectory, dbPath, filePath, spec: report.comparisonMetadata.spec,
      subjects: report.comparisonMetadata.subjects, physicalFiles: 1, inputSheetCount: 6,
      inputBytes: files[3].bytes, inputSha256: files[3].sha256 };
    const fixtureSha256 = hash(JSON.stringify(preparedFixture));
    const prepared = { schemaVersion: 2, automated: 'PASS', mode: 'windows', runId: report.memoryMeasurement.runId,
      case: report.case, buildSha: SHA, pid: 200 + index, childExit: { code: 0, signal: null },
      environment: structuredClone(report.environment), fixture: preparedFixture, fixtureSha256, files };
    const evidencePath = path.join(caseDirectory, 'fixture-preparation.json'), evidenceBytes = JSON.stringify(prepared, null, 2) + '\n';
    fs.writeFileSync(evidencePath, evidenceBytes);
    Object.assign(report.memoryMeasurement.fixturePreparation, { fixtureSha256, evidencePath,
      evidenceSha256: hash(evidenceBytes), filesVerified: true });
    report.memoryMeasurement.preparedFiles = structuredClone(files);
    return report;
  });
}
function rewritePreparation(report, update, { refreshEvidenceHash = true, refreshFixtureHash = false } = {}) {
  const proof = report.memoryMeasurement.fixturePreparation;
  const prepared = JSON.parse(fs.readFileSync(proof.evidencePath, 'utf8'));
  update(prepared);
  if (refreshFixtureHash) {
    prepared.fixtureSha256 = hash(JSON.stringify(prepared.fixture)); proof.fixtureSha256 = prepared.fixtureSha256;
  }
  const bytes = JSON.stringify(prepared, null, 2) + '\n'; fs.writeFileSync(proof.evidencePath, bytes);
  if (refreshEvidenceHash) proof.evidenceSha256 = hash(bytes);
}
function rewriteRaw(report, update, { refreshHash = true } = {}) {
  const sampler = report.memoryMeasurement.sampler;
  const rows = fs.readFileSync(sampler.outputPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
  update(rows);
  const bytes = rows.map((row) => JSON.stringify(row) + '\n').join('');
  fs.writeFileSync(sampler.outputPath, bytes);
  if (refreshHash) sampler.sha256 = hash(bytes);
}
async function notRun(reports, pattern) {
  const result = await evaluatePf01MemoryComparison(reports);
  assert.equal(result.status, 'NOT_RUN', JSON.stringify(result));
  assert.ok(result.reasons.length); if (pattern) assert.match(result.reasons.join('\n'), pattern);
  return result;
}

test('从两个真实 JSONL 文件独立复算；允许 case 输入次序变化与不同样本 SHA', async (t) => {
  const reports = fixture(t), result = await evaluatePf01MemoryComparison(reports.reverse());
  assert.equal(result.status, 'PASS'); assert.deepEqual(result.reasons, []);
  assert.equal(result.schemaVersion, 2); assert.equal(result.metric, 'host-process-rss-v1');
  assert.equal(result.absolutePeakDeltaBytes, 100 * MIB); assert.equal(result.growthDeltaBytes, 100 * MIB);
  assert.equal(result.baselineDeltaBytes, 0); assert.equal(result.budgetBytes, 256 * MIB);
  assert.equal(result.observations['pf01-1m'].sha256, reports[0].memoryMeasurement.sampler.sha256);
});
test('精确 256 MiB 边界通过，多一字节失败', async (t) => {
  const reports = fixture(t, { small: [100, 200, 110], large: [100, 456, 120] });
  assert.equal((await evaluatePf01MemoryComparison(reports)).status, 'PASS');
  rewriteRaw(reports[1], (rows) => { rows[1].rssBytes++; });
  reports[1].memoryMeasurement.sampler.peakRssBytes++;
  assert.equal((await evaluatePf01MemoryComparison(reports)).status, 'FAIL');
});
test('小样本更高基线掩盖绝对差时，增长差仍拒绝', async (t) => {
  const result = await evaluatePf01MemoryComparison(fixture(t, { small: [128, 200, 130], large: [100, 450, 120] }));
  assert.equal(result.absolutePeakDeltaBytes, 250 * MIB); assert.equal(result.growthDeltaBytes, 278 * MIB);
  assert.equal(result.status, 'FAIL');
});
test('增长差合规但绝对峰值差超标仍拒绝', async (t) => {
  const result = await evaluatePf01MemoryComparison(fixture(t, { small: [100, 200, 110], large: [128, 470, 130] }));
  assert.equal(result.absolutePeakDeltaBytes, 270 * MIB); assert.equal(result.growthDeltaBytes, 242 * MIB);
  assert.equal(result.status, 'FAIL');
});
test('32 MiB 基线漂移可比；多一字节即不可比，不能补偿预算', async (t) => {
  const reports = fixture(t, { small: [100, 200, 110], large: [132, 300, 140] });
  assert.equal((await evaluatePf01MemoryComparison(reports)).status, 'PASS');
  rewriteRaw(reports[1], (rows) => { rows[0].rssBytes++; }); reports[1].memoryMeasurement.sampler.baselineRssBytes++;
  await notRun(reports, /基线漂移/);
});
test('采样跨多个读取块，仍复算全部记录和哈希', async (t) => {
  const reports = fixture(t, { count: 1200 });
  const result = await evaluatePf01MemoryComparison(reports);
  assert.equal(result.status, 'PASS'); assert.equal(result.observations['pf01-1m'].sampleCount, 1200);
});

const refused = [
  ['缺少一个规模', (pair) => pair.pop()], ['重复 case', (pair) => { pair[1].case = pair[0].case; }],
  ['额外 case', (pair) => pair.push(pair[0])], ['smoke', (pair) => { pair[1].mode = 'smoke'; }],
  ['未知构建', (pair) => { pair[1].buildSha = 'unknown'; }], ['不同构建', (pair) => {
    pair[1].buildSha = 'd'.repeat(40); pair[1].memoryMeasurement.fixturePreparation.buildSha = pair[1].buildSha;
  }],
  ['自动失败', (pair) => { pair[1].automated = 'FAIL'; }], ['缺少清理', (pair) => { delete pair[1].cleanup; }],
  ['缺少回读', (pair) => { delete pair[1].readback; }], ['子进程失败', (pair) => { pair[1].childExit.code = 1; }],
  ['子进程信号', (pair) => { pair[1].childExit.signal = 'SIGTERM'; }], ['矛盾失败记录', (pair) => { pair[1].processFailure = 'crashed'; }],
  ['基准未通过', (pair) => { pair[1].environment.status = 'NOT_RUN'; }], ['非 Windows', (pair) => { pair[1].environment.platform = 'darwin'; }],
  ['不同 CPU', (pair) => { pair[1].environment.cpu = 'other'; }], ['不同机器', (pair) => { pair[1].environment.machineId = 'd'.repeat(64); }],
  ['不同运行实例', (pair) => { pair[1].memoryMeasurement.runId = 'other'; }],
  ['不同磁盘实例', (pair) => { pair[1].environment.disk.evidence.instance.computerName = 'other'; }],
  ['不同卷', (pair) => { pair[1].environment.disk.evidence.volumes[0].UniqueId = 'volume-b'; }],
  ['不同物理盘', (pair) => { pair[1].environment.disk.identityProof.matchedPhysicalUniqueId = 'disk-b'; }],
  ['缺少原始卷', (pair) => { pair[1].environment.disk.evidence.volumes = []; }],
  ['缺少 SSD 证明', (pair) => { pair[1].environment.disk.identityProof.status = 'NOT_RUN'; }],
  ['内存无穷', (pair) => { pair[1].environment.totalMemoryBytes = Infinity; }],
  ['生产 dirty', (pair) => { pair[1].environment.buildIdentity.productionDirty = true; }],
  ['未冻结采样器', (pair) => { delete pair[1].environment.buildIdentity.scriptSha256['performance-rss-sampler.js']; }],
  ['不同验证器', (pair) => { pair[1].environment.buildIdentity.scriptSha256['performance-worker.js'] = 'd'.repeat(64); }],
  ['非冷进程', (pair) => { pair[1].memoryMeasurement.coldProcess = false; }],
  ['准备未退出', (pair) => { pair[1].memoryMeasurement.fixturePreparation.exitCode = null; }],
  ['准备进程即测量宿主', (pair) => { pair[1].memoryMeasurement.fixturePreparation.pid = pair[1].memoryMeasurement.hostPid; }],
  ['准备构建不同', (pair) => { pair[1].memoryMeasurement.fixturePreparation.buildSha = 'd'.repeat(40); }],
  ['准备哈希缺失', (pair) => { delete pair[1].memoryMeasurement.fixturePreparation.fixtureSha256; }],
  ['同一测量宿主', (pair) => {
    pair[1].memoryMeasurement.hostPid = pair[0].memoryMeasurement.hostPid;
    pair[1].memoryMeasurement.sampler.pid = pair[0].memoryMeasurement.hostPid;
    rewriteRaw(pair[1], (rows) => rows.forEach((row) => { row.pid = pair[0].memoryMeasurement.hostPid; }));
  }],
  ['窗口倒序', (pair) => { pair[1].memoryMeasurement.endAtNs = pair[1].memoryMeasurement.startAtNs; }],
  ['开始前缺样本', (pair) => { pair[1].memoryMeasurement.startAtNs = '999999999'; }],
  ['结束后缺样本', (pair) => { pair[1].memoryMeasurement.endAtNs = '2000000001'; }],
  ['缺少阶段', (pair) => { pair[1].workerEvents = pair[1].workerEvents.filter((event) => event.phase !== 'extract'); }],
  ['阶段重复', (pair) => { pair[1].workerEvents.push(pair[1].workerEvents[0]); }],
  ['阶段结果缺失', (pair) => { delete pair[1].workerEvents[1].result; }],
  ['阶段次序倒置', (pair) => { [pair[1].workerEvents[0], pair[1].workerEvents[1]] = [pair[1].workerEvents[1], pair[1].workerEvents[0]]; }],
  ['Worker 异常退出', (pair) => { pair[1].workerEvents.at(-1).code = 1; }],
  ['改变行数', (pair) => { pair[1].comparisonMetadata.spec.pending = 999999; }],
  ['改变固定调整数', (pair) => { pair[1].comparisonMetadata.spec.adjustments = 1; }],
  ['改变输入 Sheet 数', (pair) => { pair[1].comparisonMetadata.inputSheetCount++; }],
  ['改变布局次序', (pair) => { pair[1].comparisonMetadata.groups.reverse(); }],
  ['重复分组', (pair) => { pair[1].comparisonMetadata.groups.push(pair[1].comparisonMetadata.groups[0]); }],
  ['缺少主体', (pair) => { pair[1].comparisonMetadata.subjects = []; }],
  ['sampler 未通过', (pair) => { pair[1].memoryMeasurement.sampler.status = 'NOT_RUN'; }],
  ['改变采样频率', (pair) => { pair[1].memoryMeasurement.sampler.intervalMs = 1000; }],
  ['扩大采样容差', (pair) => { pair[1].memoryMeasurement.sampler.maxAllowedGapMs = 1000; }],
  ['摘要 NaN', (pair) => { pair[1].memoryMeasurement.sampler.peakRssBytes = NaN; }],
  ['伪造摘要峰值', (pair) => { pair[1].memoryMeasurement.sampler.peakRssBytes--; }],
  ['伪造摘要次数', (pair) => { pair[1].memoryMeasurement.sampler.sampleCount++; }],
  ['原始序列缺口', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].seq = 2; })],
  ['原始 PID 不匹配', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].pid++; })],
  ['伪装 Main 线程', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].threadId = 0; })],
  ['原始 RSS null', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].rssBytes = null; })],
  ['原始 RSS 字符串', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].rssBytes = '100'; })],
  ['原始 RSS 负数', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].rssBytes = -1; })],
  ['原始 RSS 不安全整数', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].rssBytes = Number.MAX_SAFE_INTEGER + 1; })],
  ['单调时间倒退', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].atNs = rows[0].atNs; })],
  ['原始哈希篡改', (pair) => rewriteRaw(pair[1], (rows) => { rows[1].at++; }, { refreshHash: false })],
  ['原始文件不存在', (pair) => fs.unlinkSync(pair[1].memoryMeasurement.sampler.outputPath)],
  ['原始尾行未完成', (pair) => {
    const sampler = pair[1].memoryMeasurement.sampler, bytes = fs.readFileSync(sampler.outputPath).subarray(0, -1);
    fs.writeFileSync(sampler.outputPath, bytes); sampler.sha256 = hash(bytes);
  }],
];
for (const [label, mutate] of refused) test('证据不足保持 NOT_RUN：' + label, async (t) => {
  const reports = fixture(t); mutate(reports); await notRun(reports);
});
test('实际 750 ms 采样间隙可用，超过一纳秒即拒绝，即使摘要与文件一致', async (t) => {
  const reports = fixture(t), summary = reports[1].memoryMeasurement.sampler;
  rewriteRaw(reports[1], (rows) => { rows[1].atNs = '1750000000'; }); summary.maxGapMs = 750;
  assert.equal((await evaluatePf01MemoryComparison(reports)).status, 'PASS');
  rewriteRaw(reports[1], (rows) => { rows[1].atNs = '1750000001'; }); summary.maxGapMs = 750.000001;
  await notRun(reports, /采样间隙/);
});
test('没有周期样本时不能用首尾两个点通过 PF01', async (t) => {
  await notRun(fixture(t, { count: 2 }), /没有周期样本/);
});
test('两份证据都把 OS 磁盘与另一物理盘配对时仍拒绝', async (t) => {
  const pair = fixture(t);
  for (const report of pair) report.environment.disk.identityProof.matchedPhysicalUniqueId = 'disk-b';
  await notRun(pair, /基准/);
});
test('超长未结束 JSONL 行有固定上限，不能无限缓冲', async (t) => {
  const pair = fixture(t), summary = pair[1].memoryMeasurement.sampler;
  fs.writeFileSync(summary.outputPath, 'x'.repeat(70000)); summary.sha256 = hash(fs.readFileSync(summary.outputPath));
  await notRun(pair, /固定上限/);
});

const identityFaults = [
  ['缺少实际脚本哈希', (report) => { delete report.environment.observedScriptSha256; }],
  ['实际脚本与声明不同', (report) => { report.environment.observedScriptSha256['performance-memory-contract.js'] = 'e'.repeat(64); }],
  ['采集脚本运行中变化', (report) => { report.environment.verificationScriptsUnchanged = false; }],
  ['缺少实际生产身份', (report) => { delete report.environment.observedProductionIdentity; }],
  ['实际生产 HEAD 不同', (report) => { report.environment.observedProductionIdentity.buildSha = 'e'.repeat(40); }],
  ['实际生产文件 dirty', (report) => { report.environment.observedProductionIdentity.productionDirty = true; }],
  ['生产身份运行中变化', (report) => { report.environment.productionIdentityUnchanged = false; }],
  ['准备文件未经实际核验', (report) => { report.memoryMeasurement.fixturePreparation.filesVerified = false; }],
  ['缺少原始准备路径', (report) => { delete report.memoryMeasurement.fixturePreparation.evidencePath; }],
  ['缺少原始准备文件', (report) => { fs.unlinkSync(report.memoryMeasurement.fixturePreparation.evidencePath); }],
  ['原始准备文件字节篡改', (report) => rewritePreparation(report, (prepared) => { prepared.preparationMs = 999; }, { refreshEvidenceHash: false })],
  ['原始准备文件摘要伪造', (report) => { report.memoryMeasurement.fixturePreparation.evidenceSha256 = 'e'.repeat(64); }],
  ['缺少 preparedFiles', (report) => { delete report.memoryMeasurement.preparedFiles; }],
  ['preparedFiles 非数组', (report) => { report.memoryMeasurement.preparedFiles = {}; }],
  ['preparedFiles 顺序错误', (report) => { report.memoryMeasurement.preparedFiles.reverse(); }],
  ['preparedFiles 摘要与原始记录不同', (report) => { report.memoryMeasurement.preparedFiles[0].sha256 = 'e'.repeat(64); }],
  ['原始准备 case 不同', (report) => rewritePreparation(report, (prepared) => { prepared.case = 'pf03'; })],
  ['原始准备 runId 不同', (report) => rewritePreparation(report, (prepared) => { prepared.runId = 'other'; })],
  ['原始准备 PID 不同', (report) => rewritePreparation(report, (prepared) => { prepared.pid++; })],
  ['原始准备退出失败', (report) => rewritePreparation(report, (prepared) => { prepared.childExit.code = 1; })],
  ['原始 fixture JSON 被改但摘要未改', (report) => rewritePreparation(report, (prepared) => { prepared.fixture.spec.pending--; })],
  ['原始 fixture 改行数并重算摘要仍与比较元数据冲突', (report) => rewritePreparation(report, (prepared) => { prepared.fixture.spec.pending--; }, { refreshFixtureHash: true })],
  ['原始准备缺少实际脚本身份', (report) => rewritePreparation(report, (prepared) => { delete prepared.environment.observedScriptSha256; })],
  ['原始准备实际脚本与声明不同', (report) => rewritePreparation(report, (prepared) => { prepared.environment.observedScriptSha256['performance-worker.js'] = 'e'.repeat(64); })],
  ['原始准备实际生产 HEAD 不同', (report) => rewritePreparation(report, (prepared) => { prepared.environment.observedProductionIdentity.buildSha = 'e'.repeat(40); })],
  ['原始准备未记录结束时生产身份', (report) => rewritePreparation(report, (prepared) => { delete prepared.environment.productionIdentityUnchanged; })],
];
for (const [label, mutate] of identityFaults) test('实际身份与准备原始证据拒绝：' + label, async (t) => {
  const pair = fixture(t); mutate(pair[1]); await notRun(pair);
});
const fileFaults = [
  ['漏掉 SHM', (files) => { files.splice(2, 1); }],
  ['重复文件', (files) => { files[2] = files[1]; }],
  ['错误 DB 路径', (files) => { files[0].path += '-other'; }],
  ['缺少 DB', (files) => { files[0] = { path: files[0].path, exists: false }; }],
  ['缺少 input', (files) => { files[3] = { path: files[3].path, exists: false }; }],
  ['exists 非布尔', (files) => { files[1].exists = 'false'; }],
  ['缺失 WAL 带伪造摘要', (files) => { files[1].sha256 = HASH; }],
  ['DB 大小负数', (files) => { files[0].bytes = -1; }],
  ['DB 大小为零', (files) => { files[0].bytes = 0; }],
  ['input 摘要缺失', (files) => { delete files[3].sha256; }],
  ['input 摘要非法', (files) => { files[3].sha256 = 'not-sha'; }],
];
for (const [label, mutate] of fileFaults) test('原始和复制列表共同非法仍拒绝：' + label, async (t) => {
  const pair = fixture(t), report = pair[1];
  rewritePreparation(report, (prepared) => { mutate(prepared.files); report.memoryMeasurement.preparedFiles = structuredClone(prepared.files); });
  await notRun(pair);
});
test('WAL/SHM 显式缺失及真实存在的完整元数据两种准备状态均允许', async (t) => {
  const pair = fixture(t);
  assert.equal((await evaluatePf01MemoryComparison(pair)).status, 'PASS');
  for (const report of pair) rewritePreparation(report, (prepared) => {
    for (const index of [1, 2]) {
      const file = prepared.files[index]; fs.writeFileSync(file.path, index === 1 ? '' : 'controlled shm');
      prepared.files[index] = { path: file.path, exists: true, bytes: fs.statSync(file.path).size, sha256: hash(fs.readFileSync(file.path)) };
    }
    report.memoryMeasurement.preparedFiles = structuredClone(prepared.files);
  });
  assert.equal((await evaluatePf01MemoryComparison(pair)).status, 'PASS');
});
test('测后 DB 字节合法变化不触发重新哈希，但原始准备证据始终必须完整', async (t) => {
  const pair = fixture(t);
  for (const report of pair) fs.appendFileSync(report.memoryMeasurement.preparedFiles[0].path, 'measurement triggers');
  assert.equal((await evaluatePf01MemoryComparison(pair)).status, 'PASS');
  delete pair[1].memoryMeasurement.preparedFiles;
  await notRun(pair, /文件列表/);
});
