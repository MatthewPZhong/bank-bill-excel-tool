'use strict';
// 正式宿主 RSS 合同；不声称能反推出 worker_threads 的独立 RSS。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const METRIC = 'host-process-rss-v1', MIB = 1024 * 1024;
const CASES = ['pf01-100k', 'pf01-1m'];
const REQUIRED_SCRIPTS = ['verify-review-performance.js', 'performance-fixture.js', 'performance-worker.js',
  'performance-disk-baseline.js', 'collect-performance-disk.ps1', 'performance-rss-sampler.js', 'performance-memory-contract.js'];
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ns = (value) => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const canonical = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('不是有限的普通 JSON 值');
};
const same = (a, b) => canonical(a) === canonical(b);

function metadata(report, pending) {
  const value = report.comparisonMetadata;
  if (!value || !Array.isArray(value.subjects) || value.subjects.length !== 2
      || value.subjects.some((item) => !text(item)) || new Set(value.subjects).size !== 2
      || !positive(value.physicalFiles) || !positive(value.inputSheetCount) || !positive(value.outputSheetCount)
      || value.structureVersion !== 'v3' || !Array.isArray(value.groups) || !value.groups.length
      || !same(value.spec, { subjects: 2, pending, recharge: 12, adjustments: 0 })) {
    throw new Error('固定元数据或规定行数不匹配');
  }
  const groups = value.groups.map((group) => {
    if (!(text(group) || (group && !Array.isArray(group) && typeof group === 'object' && Object.keys(group).length))) {
      throw new Error('分组 descriptor 缺失');
    }
    return canonical(group);
  });
  if (new Set(groups).size !== groups.length) throw new Error('重复分组 descriptor');
  return { subjects: value.subjects, physicalFiles: value.physicalFiles, inputSheetCount: value.inputSheetCount,
    outputSheetCount: value.outputSheetCount, structureVersion: value.structureVersion, groups,
    spec: { subjects: 2, recharge: 12, adjustments: 0 } };
}

function identity(report) {
  const env = report.environment, measurement = report.memoryMeasurement, sampler = measurement?.sampler;
  if (report.mode !== 'windows' || !/^[a-f0-9]{40}$/.test(report.buildSha)
      || report.automated !== 'PASS' || report.cleanup !== 'PASS' || report.readback?.status !== 'PASS'
      || report.childExit?.code !== 0 || report.childExit?.signal !== null || report.processFailure) throw new Error('运行、回读、清理或子进程未完整成功');
  if (env?.status !== 'PASS' || env.platform !== 'win32' || env.arch !== 'x64'
      || !text(env.osRelease) || !text(env.cpu) || !positive(env.totalMemoryBytes)
      || env.totalMemoryBytes < 15 * 1024 ** 3 || env.totalMemoryBytes > 17 * 1024 ** 3
      || env.electron !== '36.9.5' || env.exceljs !== '4.4.0' || !text(env.node)
      || !sha(env.machineId) || env.disk?.identityProof?.status !== 'PASS' || !text(env.disk.identityProof.targetUniqueId)
      || !text(env.disk.identityProof.matchedPhysicalUniqueId)
      || env.disk.identityProof.targetUniqueId !== env.disk.identityProof.matchedPhysicalUniqueId
      || env.buildIdentity?.productionDirty !== false) throw new Error('固定 Windows 基准或生产身份缺失');
  const diskInstance = env.disk.evidence?.instance, volumes = env.disk.evidence?.volumes;
  if (!text(diskInstance?.computerName) || ['runId', 'runAttempt'].some((key) => diskInstance[key] != null && !text(diskInstance[key]))
      || !Array.isArray(volumes) || volumes.length !== 1 || !text(volumes[0]?.UniqueId)) {
    throw new Error('磁盘实例或实际卷身份缺失');
  }
  const scripts = env.buildIdentity.scriptSha256;
  if (!scripts || REQUIRED_SCRIPTS.some((name) => !sha(scripts[name]))
      || Object.values(scripts).some((value) => !sha(value))) throw new Error('验证脚本哈希不完整');
  if (env.verificationScriptsUnchanged !== true || !env.observedScriptSha256
      || !same(env.observedScriptSha256, scripts)) throw new Error('实际采集脚本身份未核验或运行期间发生变化');
  if (env.productionIdentityUnchanged !== true || !env.observedProductionIdentity
      || !same(env.observedProductionIdentity, { buildSha: report.buildSha, productionDirty: false })) {
    throw new Error('实际生产构建身份未核验或运行期间发生变化');
  }
  const prep = measurement?.fixturePreparation;
  if (measurement?.metric !== METRIC || !text(measurement.runId) || !positive(measurement.hostPid)
      || measurement.coldProcess !== true || !positive(prep?.pid) || prep.pid === measurement.hostPid
      || prep.exitCode !== 0 || prep.signal !== null || prep.buildSha !== report.buildSha || !sha(prep.fixtureSha256)
      || !ns(measurement.startAtNs) || !ns(measurement.endAtNs)
      || BigInt(measurement.startAtNs) >= BigInt(measurement.endAtNs)) throw new Error('冷进程、样本准备或测量窗口证据不完整');
  if (!sampler || sampler.schemaVersion !== 1 || sampler.metric !== METRIC || sampler.status !== 'PASS'
      || sampler.pid !== measurement.hostPid || !positive(sampler.samplerThreadId)
      || sampler.intervalMs !== 500 || sampler.maxAllowedGapMs !== 750
      || !text(sampler.outputPath) || !path.isAbsolute(sampler.outputPath) || !sha(sampler.sha256)) {
    throw new Error('独立采样器身份、覆盖或原始文件信息不完整');
  }
  const events = report.workerEvents;
  if (!Array.isArray(events)) throw new Error('缺少生产 Worker 阶段证据');
  let previousEnd = -1;
  for (const phase of ['prepare', 'extract', 'write', 'readback']) {
    const positions = ['stage-start', 'stage-result', 'stage-end'].map((kind) => {
      const matches = events.map((event, index) => event?.kind === kind && event.phase === phase ? index : -1).filter((index) => index >= 0);
      if (matches.length !== 1) throw new Error('生产 Worker 阶段不完整或重复：' + phase);
      return matches[0];
    });
    if (positions[0] <= previousEnd || positions[0] >= positions[1] || positions[1] >= positions[2]
        || !events[positions[1]].result || typeof events[positions[1]].result !== 'object') {
      throw new Error('生产 Worker 阶段次序或结果无效：' + phase);
    }
    previousEnd = positions[2];
  }
  const exits = events.filter((event) => event?.kind === 'worker-exit');
  if (exits.length !== 2 || exits.some((event) => event.code !== 0)) throw new Error('两个生产 Worker 未正常退出');
  return { buildSha: report.buildSha, runId: measurement.runId, platform: env.platform, arch: env.arch,
    osRelease: env.osRelease, cpu: env.cpu, totalMemoryBytes: env.totalMemoryBytes,
    electron: env.electron, node: env.node, exceljs: env.exceljs,
    machineId: env.machineId, diskUniqueId: env.disk.identityProof.targetUniqueId,
    physicalDiskUniqueId: env.disk.identityProof.matchedPhysicalUniqueId, volumeUniqueId: volumes[0].UniqueId,
    diskInstance: { computerName: diskInstance.computerName, runId: diskInstance.runId ?? null, runAttempt: diskInstance.runAttempt ?? null }, scripts };
}

async function readPreparation(report, reportIdentity) {
  const measurement = report.memoryMeasurement, proof = measurement.fixturePreparation;
  if (proof.filesVerified !== true || !text(proof.evidencePath) || !path.isAbsolute(proof.evidencePath)
      || !sha(proof.evidenceSha256)) throw new Error('缺少已实际核验的原始准备记录');
  const directory = path.dirname(proof.evidencePath);
  if (proof.evidencePath !== path.join(directory, 'fixture-preparation.json')
      || report.environment.directory !== directory) throw new Error('原始准备记录不属于本次测试目录');
  const stat = await fs.promises.lstat(proof.evidencePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('原始准备记录必须是普通文件');
  const bytes = await fs.promises.readFile(proof.evidencePath);
  if (createHash('sha256').update(bytes).digest('hex') !== proof.evidenceSha256) throw new Error('原始准备记录哈希不匹配');
  const prepared = JSON.parse(bytes.toString('utf8'));
  if (prepared.schemaVersion !== 2 || prepared.automated !== 'PASS' || prepared.mode !== 'windows'
      || prepared.runId !== measurement.runId || prepared.case !== report.case || prepared.buildSha !== report.buildSha
      || prepared.pid !== proof.pid || !same(prepared.childExit, { code: proof.exitCode, signal: proof.signal })
      || prepared.fixtureSha256 !== proof.fixtureSha256 || !prepared.fixture
      || createHash('sha256').update(JSON.stringify(prepared.fixture)).digest('hex') !== proof.fixtureSha256) {
    throw new Error('原始准备记录与冷进程或样本身份不一致');
  }
  // 准备和测量两次实际采集都必须满足同一环境、构建与脚本身份要求。
  if (prepared.environment?.directory !== directory
      || !same(identity({ ...report, environment: prepared.environment }), reportIdentity)) {
    throw new Error('准备和测量的实际环境身份不一致');
  }
  const fixture = prepared.fixture, expectedPaths = [path.join(directory, 'business.sqlite'),
    path.join(directory, 'business.sqlite-wal'), path.join(directory, 'business.sqlite-shm'),
    path.join(directory, '多工作表性能合成样本.xlsx')];
  if (fixture.directory !== directory || fixture.dbPath !== expectedPaths[0] || fixture.filePath !== expectedPaths[3]
      || !Array.isArray(prepared.files) || prepared.files.length !== 4
      || !Array.isArray(measurement.preparedFiles) || !same(prepared.files, measurement.preparedFiles)) {
    throw new Error('准备文件列表缺失或与原始记录不一致');
  }
  for (let index = 0; index < prepared.files.length; index++) {
    const file = prepared.files[index];
    if (!file || file.path !== expectedPaths[index] || typeof file.exists !== 'boolean'
        || ((index === 0 || index === 3) && file.exists !== true)) throw new Error('准备文件路径或存在性无效');
    const keys = file.exists ? ['bytes', 'exists', 'path', 'sha256'] : ['exists', 'path'];
    if (!same(Object.keys(file).sort(), keys) || (file.exists && (!nonnegative(file.bytes) || !sha(file.sha256)))
        || ((index === 0 || index === 3) && !positive(file.bytes))) throw new Error('准备文件大小或摘要无效');
  }
  const meta = report.comparisonMetadata;
  if (!same(fixture.spec, meta.spec) || !same(fixture.subjects, meta.subjects)
      || fixture.physicalFiles !== meta.physicalFiles || fixture.inputSheetCount !== meta.inputSheetCount
      || fixture.inputBytes !== prepared.files[3].bytes || fixture.inputSha256 !== prepared.files[3].sha256) {
    throw new Error('比较元数据未绑定原始准备样本');
  }
  // 测量前 runner 已核对原文件；业务只读触发器会合法改变 DB，测后不重算 DB 哈希。
}

async function readSamples(measurement) {
  const summary = measurement.sampler, hash = createHash('sha256');
  const stat = await fs.promises.lstat(summary.outputPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('原始采样必须是普通文件');
  let carry = Buffer.alloc(0), count = 0, first, last, peak = 0, maxGapNs = 0n;
  const acceptLine = (line) => {
    if (!line.length || line.length > 4096) throw new Error('采样行为空或过大');
    const row = JSON.parse(line.toString('utf8'));
    if (!row || !same(Object.keys(row).sort(), ['at', 'atNs', 'pid', 'rssBytes', 'seq', 'threadId'])
        || row.seq !== count || row.pid !== measurement.hostPid || row.threadId !== summary.samplerThreadId
        || !ns(row.atNs) || !nonnegative(row.at) || !positive(row.rssBytes)) throw new Error('采样序列、身份或数值无效');
    if (last) {
      const gap = BigInt(row.atNs) - BigInt(last.atNs);
      if (gap <= 0n) throw new Error('采样单调时钟未严格递增');
      if (gap > maxGapNs) maxGapNs = gap;
    } else first = row;
    last = row; count += 1; peak = Math.max(peak, row.rssBytes);
  };
  // 固定大小块和行上限；不把百万行任务的长期采样重新载入一个数组。
  for await (const chunk of fs.createReadStream(summary.outputPath, { highWaterMark: 64 * 1024 })) {
    hash.update(chunk);
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0, end;
    while ((end = bytes.indexOf(10, start)) !== -1) { acceptLine(bytes.subarray(start, end)); start = end + 1; }
    carry = Buffer.from(bytes.subarray(start));
    if (carry.length > 4096) throw new Error('采样行超过固定上限');
  }
  if (carry.length || count < 3) throw new Error('采样未完整结束或没有周期样本');
  const computed = { sampleCount: count, periodicSampleCount: count - 2, firstSampleAtNs: first.atNs,
    lastSampleAtNs: last.atNs, baselineRssBytes: first.rssBytes, peakRssBytes: peak, finalRssBytes: last.rssBytes,
    maxGapMs: Number(maxGapNs) / 1e6, durationMs: Number(BigInt(last.atNs) - BigInt(first.atNs)) / 1e6,
    sha256: hash.digest('hex') };
  for (const [key, value] of Object.entries(computed)) {
    if (summary[key] !== value) throw new Error('原始采样与摘要不一致：' + key);
  }
  if (maxGapNs > 750000000n) throw new Error('采样间隙超过 750 ms');
  const start = BigInt(measurement.startAtNs), end = BigInt(measurement.endAtNs);
  if (BigInt(first.atNs) > start || BigInt(last.atNs) < end
      || start - BigInt(first.atNs) > 750000000n || BigInt(last.atNs) - end > 750000000n) {
    throw new Error('原始采样没有紧邻且完整覆盖任务窗口');
  }
  return computed;
}

async function evaluatePf01MemoryComparison(reports) {
  const result = { schemaVersion: 2, metric: METRIC, status: 'NOT_RUN', reasons: [], budgetBytes: 256 * MIB,
    baselineToleranceBytes: 32 * MIB, absolutePeakDeltaBytes: null, growthDeltaBytes: null, baselineDeltaBytes: null };
  if (!Array.isArray(reports) || reports.length !== 2 || CASES.some((name) => reports.filter((r) => r?.case === name).length !== 1)) {
    result.reasons.push('必须提供一次 pf01-100k 和一次 pf01-1m 的完整证据'); return result;
  }
  const pair = CASES.map((name) => reports.find((r) => r.case === name)), identities = [], metadataValues = [], samples = [];
  for (let index = 0; index < pair.length; index++) {
    try {
      identities.push(identity(pair[index]));
      metadataValues.push(metadata(pair[index], index ? 1000000 : 100000));
      await readPreparation(pair[index], identities[index]);
      samples.push(await readSamples(pair[index].memoryMeasurement));
    } catch (error) { result.reasons.push(pair[index].case + '：' + error.message); }
  }
  if (result.reasons.length) return result;
  if (!same(identities[0], identities[1])) result.reasons.push('两种规模的构建、实例、环境或验证器身份不一致');
  if (!same(metadataValues[0], metadataValues[1])) result.reasons.push('两种规模的固定元数据不一致');
  if (pair[0].memoryMeasurement.hostPid === pair[1].memoryMeasurement.hostPid
      || path.resolve(pair[0].memoryMeasurement.sampler.outputPath) === path.resolve(pair[1].memoryMeasurement.sampler.outputPath)) {
    result.reasons.push('两种规模没有使用各自独立冷进程和原始采样文件');
  }
  if (result.reasons.length) return result;
  const [small, large] = samples;
  result.absolutePeakDeltaBytes = large.peakRssBytes - small.peakRssBytes;
  result.baselineDeltaBytes = large.baselineRssBytes - small.baselineRssBytes;
  result.growthDeltaBytes = (large.peakRssBytes - large.baselineRssBytes) - (small.peakRssBytes - small.baselineRssBytes);
  result.observations = Object.fromEntries(CASES.map((name, index) => [name, samples[index]]));
  if (Math.abs(result.baselineDeltaBytes) > result.baselineToleranceBytes) {
    result.reasons.push('任务基线漂移超过 32 MiB，两种规模不可比'); return result;
  }
  if (result.absolutePeakDeltaBytes > result.budgetBytes || result.growthDeltaBytes > result.budgetBytes) {
    result.status = 'FAIL'; result.reasons.push('绝对峰值差或基线校正增长差超过 256 MiB'); return result;
  }
  result.status = 'PASS'; return result;
}

module.exports = { evaluatePf01MemoryComparison };
