'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const { AppDatabase } = require('../../src/backend/database');
const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('../../src/main-process/archive-center/source-snapshot');
const {
  canonicalSha256
} = require('../../src/main-process/background-execution/canonical-json-v1');
const {
  centsToAmountString,
  parseAmountToCents
} = require('../../src/main-process/vcc-op-calc/parser-core');
const {
  createOrderedReducer
} = require('../../src/main-process/vcc-op-calc/ordered-reducer');
const {
  EFFECTIVE_PARSER_WORKER_COUNT,
  buildParserUnits,
  runParserWorker
} = require('../../src/main-process/vcc-op-calc/parser-pipeline');
const {
  VCC_OP_SAVE_RUN_MODULE_ID,
  VCC_OP_SAVE_RUN_TASK_KEY,
  saveVccOpRunWithReceipt
} = require('../../src/main-process/vcc-op-calc/save-run-contract');

const BENCHMARK_CONTRACT_VERSION = 1;
const BENCHMARK_EVIDENCE_KIND = 'VCC_OP_PARSER_OFFLINE_BENCHMARK_V1';
const DEFAULT_RUNS = 5;
const QUALIFYING_RUNS = 5;
const MAX_RUNS = 20;
const RSS_SAMPLE_INTERVAL_MS = 10;
const WARMUP_RUNS_PER_COMBINATION = 1;
const SCENARIO_FILE_COUNTS = Object.freeze([1, 2, 4, 8]);
const REQUESTED_WORKER_COUNTS = Object.freeze([1, 2, 3, 4]);
const METRIC_KEYS = Object.freeze([
  'e2eMs',
  'parseWallMs',
  'parseCumulativeWorkerMs',
  'reduceWallMs',
  'saveWallMs',
  'peakRssMiB',
  'eventLoopDelayMaxMs'
]);
const REASON_CODES = Object.freeze({
  BASELINE_INVALID: 'BASELINE_INVALID',
  EVENT_LOOP_THRESHOLD_EXCEEDED: 'EVENT_LOOP_THRESHOLD_EXCEEDED',
  EVENT_LOOP_THRESHOLD_MISSING: 'EVENT_LOOP_THRESHOLD_MISSING',
  MATRIX_INCOMPLETE: 'MATRIX_INCOMPLETE',
  PERFORMANCE_GATE_NOT_MET: 'PERFORMANCE_GATE_NOT_MET',
  RSS_THRESHOLD_EXCEEDED: 'RSS_THRESHOLD_EXCEEDED',
  RSS_THRESHOLD_MISSING: 'RSS_THRESHOLD_MISSING',
  RUN_COUNT_NOT_FIVE: 'RUN_COUNT_NOT_FIVE',
  SAMPLE_INVALID: 'SAMPLE_INVALID'
});
const TIMING_DEFINITIONS = Object.freeze({
  e2eMs: 'UNIT_BUILD_PARSE_REDUCE_PRIVATE_SAVE_WALL',
  parseWallMs: 'WORKER_DISPATCH_TO_ALL_RESULTS_WALL',
  parseCumulativeWorkerMs: 'SUM_PER_UNIT_WORKER_DISPATCH_TO_RESULT_WALL',
  reduceWallMs: 'MAIN_THREAD_REDUCER_WALL',
  saveWallMs: 'PRIVATE_MAIN_DB_TRANSACTION_WALL',
  peakRssMiB: 'PROCESS_RSS_SAMPLED_PEAK',
  eventLoopDelayMaxMs: 'MAIN_EVENT_LOOP_DELAY_MAX'
});
const EVIDENCE_ENUM_VALUES = new Set([
  BENCHMARK_EVIDENCE_KIND,
  'ARM64',
  'CANDIDATE_FOR_REVIEW',
  'DARWIN',
  'ELIGIBLE',
  'KEEP_PRODUCTION_SINGLE',
  'LOWEST_8_FILE_E2E_MEDIAN_THEN_WORKER_COUNT',
  'LINUX',
  'NODE',
  'NONE',
  'NOT_EVALUATED',
  'OTHER',
  'SHA256',
  'WARMUP_ONE_PER_COMBINATION_THEN_DETERMINISTIC_ROTATION',
  'WIN32',
  'X64',
  ...Object.values(REASON_CODES),
  ...Object.values(TIMING_DEFINITIONS)
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class VccOpParserBenchmarkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VccOpParserBenchmarkError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new VccOpParserBenchmarkError(code, message);
}

function optionValue(argv, index, flag) {
  const token = argv[index];
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) {
    return { value: token.slice(prefix.length), nextIndex: index };
  }
  if (token !== flag || index + 1 >= argv.length) {
    fail('BENCHMARK_ARGUMENT_VALUE_MISSING', 'benchmark 参数缺少值');
  }
  return { value: argv[index + 1], nextIndex: index + 1 };
}

function positiveFinite(value, code) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(code, 'benchmark 阈值必须是正数');
  return parsed;
}

function normalizeOpeningBalance(value) {
  const parsed = parseAmountToCents(value);
  if (!parsed.ok || parsed.empty || !Number.isSafeInteger(parsed.cents)) {
    fail('BENCHMARK_BEGIN_OP_INVALID', 'benchmark begin-op 必须是安全整数分金额');
  }
  return centsToAmountString(parsed.cents);
}

function parseBenchmarkArgs(argv, dependencies = {}) {
  if (!Array.isArray(argv)) fail('BENCHMARK_ARGUMENTS_INVALID', 'benchmark argv 必须是数组');
  const resolvePath = dependencies.resolvePath || path.resolve;
  const options = {
    beginOp: '0.00',
    evidenceFilePath: null,
    inputPaths: [],
    maxEventLoopDelayMs: null,
    maxRssMiB: null,
    runs: DEFAULT_RUNS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--input' || token.startsWith('--input=')) {
      const parsed = optionValue(argv, index, '--input');
      const value = String(parsed.value || '').trim();
      if (!value) fail('BENCHMARK_INPUT_EMPTY', 'benchmark input 不能为空');
      options.inputPaths.push(resolvePath(value));
      index = parsed.nextIndex;
    } else if (token === '--runs' || token.startsWith('--runs=')) {
      const parsed = optionValue(argv, index, '--runs');
      options.runs = Number(parsed.value);
      index = parsed.nextIndex;
    } else if (token === '--max-rss-mib' || token.startsWith('--max-rss-mib=')) {
      const parsed = optionValue(argv, index, '--max-rss-mib');
      options.maxRssMiB = positiveFinite(parsed.value, 'BENCHMARK_RSS_THRESHOLD_INVALID');
      index = parsed.nextIndex;
    } else if (token === '--max-event-loop-delay-ms'
        || token.startsWith('--max-event-loop-delay-ms=')) {
      const parsed = optionValue(argv, index, '--max-event-loop-delay-ms');
      options.maxEventLoopDelayMs = positiveFinite(
        parsed.value,
        'BENCHMARK_EVENT_LOOP_THRESHOLD_INVALID'
      );
      index = parsed.nextIndex;
    } else if (token === '--begin-op' || token.startsWith('--begin-op=')) {
      const parsed = optionValue(argv, index, '--begin-op');
      options.beginOp = normalizeOpeningBalance(parsed.value);
      index = parsed.nextIndex;
    } else if (token === '--evidence-file' || token.startsWith('--evidence-file=')) {
      const parsed = optionValue(argv, index, '--evidence-file');
      const value = String(parsed.value || '').trim();
      if (!value) fail('BENCHMARK_EVIDENCE_FILE_EMPTY', 'benchmark evidence file 不能为空');
      options.evidenceFilePath = resolvePath(value);
      index = parsed.nextIndex;
    } else {
      fail('BENCHMARK_ARGUMENT_UNKNOWN', 'benchmark 收到未知参数');
    }
  }

  if (options.inputPaths.length !== SCENARIO_FILE_COUNTS.at(-1)) {
    fail('BENCHMARK_INPUT_COUNT_INVALID', 'benchmark 必须显式提供 8 个 input');
  }
  if (new Set(options.inputPaths).size !== options.inputPaths.length) {
    fail('BENCHMARK_INPUT_DUPLICATE', 'benchmark input 不得重复');
  }
  if (!Number.isSafeInteger(options.runs) || options.runs < 1 || options.runs > MAX_RUNS) {
    fail('BENCHMARK_RUN_COUNT_INVALID', `benchmark runs 必须是 1-${MAX_RUNS} 的整数`);
  }
  return Object.freeze({ ...options, inputPaths: Object.freeze([...options.inputPaths]) });
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0
      || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('median 需要至少一个有限数值');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMetric(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function isMetricSet(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && METRIC_KEYS.every((key) => Number.isFinite(value[key]) && value[key] >= 0);
}

function isRunSample(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && SCENARIO_FILE_COUNTS.includes(value.fileCount)
    && REQUESTED_WORKER_COUNTS.includes(value.requestedWorkerCount)
    && Number.isSafeInteger(value.runIndex)
    && value.runIndex >= 1
    && isMetricSet(value.metrics);
}

function scenarioKey(fileCount, requestedWorkerCount) {
  return `${fileCount}:${requestedWorkerCount}`;
}

function groupValidSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = scenarioKey(sample.fileCount, sample.requestedWorkerCount);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  return groups;
}

function medianRows(samples) {
  const groups = groupValidSamples(samples.filter(isRunSample));
  const rows = [];
  for (const fileCount of SCENARIO_FILE_COUNTS) {
    for (const requestedWorkerCount of REQUESTED_WORKER_COUNTS) {
      const values = groups.get(scenarioKey(fileCount, requestedWorkerCount)) || [];
      if (values.length === 0) continue;
      rows.push({
        fileCount,
        requestedWorkerCount,
        runCount: values.length,
        metrics: Object.fromEntries(METRIC_KEYS.map((key) => [
          key,
          median(values.map((sample) => sample.metrics[key]))
        ]))
      });
    }
  }
  return rows;
}

function hasCompleteMatrix(samples, expectedRuns) {
  if (samples.length !== SCENARIO_FILE_COUNTS.length
      * REQUESTED_WORKER_COUNTS.length * expectedRuns) return false;
  const groups = groupValidSamples(samples);
  for (const fileCount of SCENARIO_FILE_COUNTS) {
    for (const requestedWorkerCount of REQUESTED_WORKER_COUNTS) {
      const values = groups.get(scenarioKey(fileCount, requestedWorkerCount)) || [];
      const indices = new Set(values.map((sample) => sample.runIndex));
      if (values.length !== expectedRuns || indices.size !== expectedRuns) return false;
      for (let runIndex = 1; runIndex <= expectedRuns; runIndex += 1) {
        if (!indices.has(runIndex)) return false;
      }
    }
  }
  return true;
}

function reasonList(reasonSet) {
  const order = Object.values(REASON_CODES);
  return order.filter((reason) => reasonSet.has(reason));
}

function evaluateEligibility(samples, options = {}) {
  const source = Array.isArray(samples) ? samples : [];
  const validSamples = source.filter(isRunSample);
  const reasons = new Set();
  const configuredRuns = options.runsPerCombination === undefined
    ? QUALIFYING_RUNS
    : options.runsPerCombination;
  if (source.length !== validSamples.length) reasons.add(REASON_CODES.SAMPLE_INVALID);
  if (configuredRuns !== QUALIFYING_RUNS) reasons.add(REASON_CODES.RUN_COUNT_NOT_FIVE);
  if (!hasCompleteMatrix(validSamples, QUALIFYING_RUNS)) {
    reasons.add(REASON_CODES.MATRIX_INCOMPLETE);
  }

  const maxRssMiB = options.maxRssMiB;
  const maxEventLoopDelayMs = options.maxEventLoopDelayMs;
  const rssThresholdPresent = Number.isFinite(maxRssMiB) && maxRssMiB > 0;
  const eventLoopThresholdPresent = Number.isFinite(maxEventLoopDelayMs)
    && maxEventLoopDelayMs > 0;
  if (!rssThresholdPresent) reasons.add(REASON_CODES.RSS_THRESHOLD_MISSING);
  if (!eventLoopThresholdPresent) reasons.add(REASON_CODES.EVENT_LOOP_THRESHOLD_MISSING);

  const rssGatePassed = rssThresholdPresent
    && validSamples.every((sample) => sample.metrics.peakRssMiB <= maxRssMiB);
  const eventLoopGatePassed = eventLoopThresholdPresent
    && validSamples.every((sample) => (
      sample.metrics.eventLoopDelayMaxMs <= maxEventLoopDelayMs
    ));
  if (rssThresholdPresent && !rssGatePassed) reasons.add(REASON_CODES.RSS_THRESHOLD_EXCEEDED);
  if (eventLoopThresholdPresent && !eventLoopGatePassed) {
    reasons.add(REASON_CODES.EVENT_LOOP_THRESHOLD_EXCEEDED);
  }

  const medians = medianRows(validSamples);
  const medianByKey = new Map(medians.map((row) => [
    scenarioKey(row.fileCount, row.requestedWorkerCount),
    row
  ]));
  const smallBaseline = medianByKey.get(scenarioKey(1, 1));
  const largeBaseline = medianByKey.get(scenarioKey(8, 1));
  const baselinesValid = Boolean(
    smallBaseline && largeBaseline
    && smallBaseline.metrics.e2eMs > 0
    && largeBaseline.metrics.e2eMs > 0
  );
  if (!baselinesValid) reasons.add(REASON_CODES.BASELINE_INVALID);

  const candidates = REQUESTED_WORKER_COUNTS.filter((count) => count > 1).map((workerCount) => {
    const small = medianByKey.get(scenarioKey(1, workerCount));
    const large = medianByKey.get(scenarioKey(8, workerCount));
    if (!baselinesValid || !small || !large) {
      return {
        workerCount,
        largeImprovementPct: null,
        smallRegressionPct: null,
        largeE2eMedianMs: null,
        performanceGatePassed: false
      };
    }
    const largeImprovementPct = (
      (largeBaseline.metrics.e2eMs - large.metrics.e2eMs)
      / largeBaseline.metrics.e2eMs
    ) * 100;
    const smallRegressionPct = (
      (small.metrics.e2eMs - smallBaseline.metrics.e2eMs)
      / smallBaseline.metrics.e2eMs
    ) * 100;
    return {
      workerCount,
      largeImprovementPct,
      smallRegressionPct,
      largeE2eMedianMs: large.metrics.e2eMs,
      performanceGatePassed: largeImprovementPct >= 15 && smallRegressionPct <= 5
    };
  });
  const performanceCandidates = candidates.filter((candidate) => candidate.performanceGatePassed);
  if (baselinesValid && performanceCandidates.length === 0) {
    reasons.add(REASON_CODES.PERFORMANCE_GATE_NOT_MET);
  }

  const prerequisitesPassed = reasons.size === 0 && rssGatePassed && eventLoopGatePassed;
  const selected = prerequisitesPassed
    ? [...performanceCandidates].sort((left, right) => (
        left.largeE2eMedianMs - right.largeE2eMedianMs
        || left.workerCount - right.workerCount
      ))[0]
    : null;
  return Object.freeze({
    status: selected ? 'ELIGIBLE' : 'NOT_EVALUATED',
    eligibleWorkerCount: selected ? selected.workerCount : 1,
    reasonCodes: Object.freeze(reasonList(reasons)),
    rssGatePassed,
    eventLoopGatePassed,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate })))
  });
}

function safePlatform(value) {
  if (value === 'darwin') return 'DARWIN';
  if (value === 'win32') return 'WIN32';
  if (value === 'linux') return 'LINUX';
  return 'OTHER';
}

function safeArch(value) {
  if (value === 'x64') return 'X64';
  if (value === 'arm64') return 'ARM64';
  return 'OTHER';
}

function safeEnvironment(input = {}) {
  const nodeMajor = Number.parseInt(String(input.nodeVersion || process.version).replace(/^v/, '').split('.')[0], 10);
  const logicalCpuCount = Number(input.logicalCpuCount ?? os.cpus().length);
  const totalMemoryMiB = Number(input.totalMemoryMiB ?? Math.floor(os.totalmem() / 1024 / 1024));
  return Object.freeze({
    runtime: 'NODE',
    platform: safePlatform(input.platform || process.platform),
    arch: safeArch(input.arch || process.arch),
    nodeMajor: Number.isSafeInteger(nodeMajor) && nodeMajor > 0 ? nodeMajor : 0,
    logicalCpuCount: Number.isSafeInteger(logicalCpuCount) && logicalCpuCount > 0
      ? logicalCpuCount
      : 0,
    totalMemoryMiB: Number.isSafeInteger(totalMemoryMiB) && totalMemoryMiB > 0
      ? totalMemoryMiB
      : 0
  });
}

function sanitizeMetrics(metrics) {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, roundMetric(metrics[key])]));
}

function assertEvidencePrivacy(value, keyPath = '') {
  if (typeof value === 'string') {
    if (!SHA256_PATTERN.test(value) && !EVIDENCE_ENUM_VALUES.has(value)) {
      fail('BENCHMARK_EVIDENCE_FREE_TEXT', 'benchmark evidence 包含非枚举字符串');
    }
    return true;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertEvidencePrivacy(item, `${keyPath}/${index}`));
    return true;
  }
  if (!value || typeof value !== 'object') {
    fail('BENCHMARK_EVIDENCE_TYPE_INVALID', 'benchmark evidence 含非 JSON 类型');
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:path|file.?name|message|description|detail|free.?text)/i.test(key)) {
      fail('BENCHMARK_EVIDENCE_KEY_FORBIDDEN', 'benchmark evidence 含敏感字段名');
    }
    assertEvidencePrivacy(nested, `${keyPath}/${key}`);
  }
  return true;
}

function buildEvidenceReport(input = {}) {
  const runs = Array.isArray(input.runs) ? input.runs : [];
  if (runs.some((sample) => !isRunSample(sample))) {
    fail('BENCHMARK_RUN_SAMPLE_INVALID', 'benchmark run sample 非法');
  }
  const inputEvidence = input.inputEvidence || {};
  if (!SHA256_PATTERN.test(inputEvidence.inputSetHash || '')
      || inputEvidence.inputCount !== SCENARIO_FILE_COUNTS.at(-1)
      || !Number.isSafeInteger(inputEvidence.totalSizeBytes)
      || inputEvidence.totalSizeBytes < 0) {
    fail('BENCHMARK_INPUT_EVIDENCE_INVALID', 'benchmark input evidence 非法');
  }
  const options = input.options || {};
  const evaluation = evaluateEligibility(runs, {
    runsPerCombination: options.runs,
    maxRssMiB: options.maxRssMiB,
    maxEventLoopDelayMs: options.maxEventLoopDelayMs
  });
  const report = {
    contractVersion: BENCHMARK_CONTRACT_VERSION,
    evidenceKind: BENCHMARK_EVIDENCE_KIND,
    status: evaluation.status,
    eligibleWorkerCount: evaluation.eligibleWorkerCount,
    recommendation: evaluation.eligibleWorkerCount > 1
      ? 'CANDIDATE_FOR_REVIEW'
      : 'KEEP_PRODUCTION_SINGLE',
    productionChange: 'NONE',
    environment: safeEnvironment(input.environment),
    inputEvidence: {
      hashAlgorithm: 'SHA256',
      inputSetHash: inputEvidence.inputSetHash,
      inputCount: inputEvidence.inputCount,
      totalSizeBytes: inputEvidence.totalSizeBytes
    },
    benchmarkContract: {
      scenarioFileCounts: [...SCENARIO_FILE_COUNTS],
      requestedWorkerCounts: [...REQUESTED_WORKER_COUNTS],
      runsPerCombination: options.runs,
      qualifyingRunsPerCombination: QUALIFYING_RUNS,
      productionEffectiveWorkerCount: EFFECTIVE_PARSER_WORKER_COUNT,
      rssSampleIntervalMs: RSS_SAMPLE_INTERVAL_MS,
      warmupRunsPerCombination: WARMUP_RUNS_PER_COMBINATION,
      measurementSchedule: 'WARMUP_ONE_PER_COMBINATION_THEN_DETERMINISTIC_ROTATION',
      timingDefinitions: TIMING_DEFINITIONS
    },
    thresholds: {
      maxRssMiB: Number.isFinite(options.maxRssMiB) ? options.maxRssMiB : null,
      maxEventLoopDelayMs: Number.isFinite(options.maxEventLoopDelayMs)
        ? options.maxEventLoopDelayMs
        : null
    },
    runs: runs.map((sample) => ({
      fileCount: sample.fileCount,
      requestedWorkerCount: sample.requestedWorkerCount,
      runIndex: sample.runIndex,
      metrics: sanitizeMetrics(sample.metrics)
    })),
    medians: medianRows(runs).map((row) => ({
      fileCount: row.fileCount,
      requestedWorkerCount: row.requestedWorkerCount,
      runCount: row.runCount,
      metrics: sanitizeMetrics(row.metrics)
    })),
    eligibility: {
      selectionRule: 'LOWEST_8_FILE_E2E_MEDIAN_THEN_WORKER_COUNT',
      reasonCodes: [...evaluation.reasonCodes],
      rssGatePassed: evaluation.rssGatePassed,
      eventLoopGatePassed: evaluation.eventLoopGatePassed,
      candidates: evaluation.candidates.map((candidate) => ({
        workerCount: candidate.workerCount,
        largeImprovementPct: candidate.largeImprovementPct === null
          ? null
          : roundMetric(candidate.largeImprovementPct),
        smallRegressionPct: candidate.smallRegressionPct === null
          ? null
          : roundMetric(candidate.smallRegressionPct),
        performanceGatePassed: candidate.performanceGatePassed
      }))
    }
  };
  assertEvidencePrivacy(report);
  return Object.freeze(report);
}

function sha256File(filePath, createReadStream = fs.createReadStream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function prepareRealInputs(inputPaths, dependencies = {}) {
  const statFile = dependencies.statFile
    || ((filePath) => fs.promises.stat(filePath, { bigint: true }));
  const hashFile = dependencies.hashFile || sha256File;
  const entries = [];
  let totalSizeBytes = 0;
  for (let fileIndex = 0; fileIndex < inputPaths.length; fileIndex += 1) {
    const filePath = inputPaths[fileIndex];
    let before;
    try {
      before = await statFile(filePath);
    } catch (_error) {
      fail('BENCHMARK_INPUT_UNAVAILABLE', 'benchmark input 不可读取');
    }
    const sourceSnapshot = sourceSnapshotFromStat(before);
    if (!sourceSnapshot) fail('BENCHMARK_INPUT_NOT_FILE', 'benchmark input 不是普通文件');
    const sha256 = await hashFile(filePath);
    if (!SHA256_PATTERN.test(sha256)) {
      fail('BENCHMARK_INPUT_HASH_INVALID', 'benchmark input hash 非法');
    }
    let after;
    try {
      after = await statFile(filePath);
    } catch (_error) {
      fail('BENCHMARK_INPUT_UNAVAILABLE', 'benchmark input 校验时不可读取');
    }
    if (!sourceSnapshotMatchesStat(sourceSnapshot, after)) {
      fail('BENCHMARK_INPUT_CHANGED', 'benchmark input 在证据采集期间变化');
    }
    totalSizeBytes += sourceSnapshot.sizeBytes;
    if (!Number.isSafeInteger(totalSizeBytes)) {
      fail('BENCHMARK_INPUT_SIZE_UNSAFE', 'benchmark input 总大小超出安全整数');
    }
    entries.push({ fileIndex, filePath, sourceSnapshot, sizeBytes: sourceSnapshot.sizeBytes, sha256 });
  }
  const inputSetHash = canonicalSha256({
    contractVersion: 1,
    inputs: entries.map((entry) => ({
      fileIndex: entry.fileIndex,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256
    }))
  });
  return Object.freeze({
    inputs: Object.freeze(entries.map((entry) => Object.freeze({
      filePath: entry.filePath,
      sourceSnapshot: entry.sourceSnapshot
    }))),
    evidence: Object.freeze({
      inputSetHash,
      inputCount: entries.length,
      totalSizeBytes
    })
  });
}

async function runParserScenario(inputs, requestedWorkerCount, dependencies = {}) {
  if (!REQUESTED_WORKER_COUNTS.includes(requestedWorkerCount)) {
    fail('BENCHMARK_WORKER_COUNT_INVALID', 'benchmark worker count 必须是 1-4');
  }
  const nowMs = dependencies.nowMs || (() => performance.now());
  const runWorker = dependencies.runWorker || runParserWorker;
  const units = buildParserUnits(inputs);
  const abortController = new AbortController();
  const completed = [];
  let cursor = 0;
  let firstError = null;
  let parseCumulativeWorkerMs = 0;
  const parseStartedAt = nowMs();

  async function workerLoop() {
    while (!abortController.signal.aborted) {
      const unitIndex = cursor;
      if (unitIndex >= units.length) return;
      cursor += 1;
      const workerStartedAt = nowMs();
      try {
        const result = await runWorker(units[unitIndex], { signal: abortController.signal });
        parseCumulativeWorkerMs += nowMs() - workerStartedAt;
        if (abortController.signal.aborted) return;
        completed.push({ unitIndex, result });
      } catch (error) {
        parseCumulativeWorkerMs += nowMs() - workerStartedAt;
        if (!firstError) firstError = error;
        abortController.abort();
      }
    }
  }

  const activeWorkerCount = Math.min(requestedWorkerCount, units.length);
  await Promise.all(Array.from({ length: activeWorkerCount }, () => workerLoop()));
  const parseWallMs = nowMs() - parseStartedAt;
  if (firstError) throw firstError;
  if (completed.length !== units.length) {
    fail('BENCHMARK_PARSE_INCOMPLETE', 'benchmark parser 未返回完整结果');
  }

  const reduceStartedAt = nowMs();
  const reducer = createOrderedReducer({ inputs: units });
  for (const entry of completed) reducer.accept(entry.result);
  const reduced = reducer.finalize();
  const reduceWallMs = nowMs() - reduceStartedAt;
  if (!reduced || reduced.ok !== true || !reduced.snapshot) {
    fail('BENCHMARK_INPUT_REJECTED', 'benchmark 输入未形成成功 Compute Snapshot');
  }
  return Object.freeze({
    snapshot: reduced.snapshot,
    parseWallMs,
    parseCumulativeWorkerMs,
    reduceWallMs
  });
}

function createOperationOwner(randomUuid = crypto.randomUUID) {
  const identity = randomUuid();
  return Object.freeze({
    taskRunId: `benchmark-task-${identity}`,
    taskKey: VCC_OP_SAVE_RUN_TASK_KEY,
    moduleId: VCC_OP_SAVE_RUN_MODULE_ID,
    parentRunId: `benchmark-parent-${identity}`,
    operationKey: `benchmark-operation-${identity}`
  });
}

function rssSampler(dependencies = {}) {
  const memoryUsage = dependencies.memoryUsage || process.memoryUsage;
  const setTimer = dependencies.setInterval || setInterval;
  const clearTimer = dependencies.clearInterval || clearInterval;
  let peakRssBytes = Number(memoryUsage().rss) || 0;
  const sample = () => {
    peakRssBytes = Math.max(peakRssBytes, Number(memoryUsage().rss) || 0);
  };
  const timer = setTimer(sample, RSS_SAMPLE_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return Object.freeze({
    sample,
    stop() { clearTimer(timer); },
    peakRssBytes() { return peakRssBytes; }
  });
}

async function monitorReady() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runSingleSample(options, dependencies = {}) {
  const nowMs = dependencies.nowMs || (() => performance.now());
  const createDelayMonitor = dependencies.createDelayMonitor
    || (() => monitorEventLoopDelay({ resolution: 10 }));
  const delayMonitor = createDelayMonitor();
  delayMonitor.enable();
  await (dependencies.monitorReady || monitorReady)();
  const sampler = rssSampler(dependencies);
  const e2eStartedAt = nowMs();
  try {
    const parsed = await runParserScenario(
      options.inputs,
      options.requestedWorkerCount,
      dependencies
    );
    const saveStartedAt = nowMs();
    (dependencies.saveRun || saveVccOpRunWithReceipt)({
      db: options.db,
      computeSnapshot: parsed.snapshot,
      beginOp: options.beginOp,
      operationOwner: createOperationOwner(dependencies.randomUuid)
    });
    const saveWallMs = nowMs() - saveStartedAt;
    const e2eMs = nowMs() - e2eStartedAt;
    sampler.sample();
    // e2e 计时已截止；额外让监视器观察到最后一段同步 reduce/save 阻塞。
    await (dependencies.monitorReady || monitorReady)();
    const eventLoopDelayMaxMs = Number(delayMonitor.max || 0) / 1e6;
    return Object.freeze({
      e2eMs,
      parseWallMs: parsed.parseWallMs,
      parseCumulativeWorkerMs: parsed.parseCumulativeWorkerMs,
      reduceWallMs: parsed.reduceWallMs,
      saveWallMs,
      peakRssMiB: sampler.peakRssBytes() / 1024 / 1024,
      eventLoopDelayMaxMs: Number.isFinite(eventLoopDelayMaxMs) ? eventLoopDelayMaxMs : 0
    });
  } finally {
    sampler.stop();
    delayMonitor.disable();
  }
}

function rotatedWorkerOrder(runIndex, scenarioIndex) {
  if (!Number.isSafeInteger(runIndex) || runIndex < 1
      || !Number.isSafeInteger(scenarioIndex) || scenarioIndex < 0) {
    throw new TypeError('rotation index 非法');
  }
  const offset = (runIndex - 1 + scenarioIndex) % REQUESTED_WORKER_COUNTS.length;
  return Object.freeze(REQUESTED_WORKER_COUNTS.map((_, index) => (
    REQUESTED_WORKER_COUNTS[(index + offset) % REQUESTED_WORKER_COUNTS.length]
  )));
}

function assertPrivateTempDirectory(tempDir, tempRoot) {
  const resolvedDir = path.resolve(tempDir);
  const resolvedRoot = path.resolve(tempRoot);
  if (resolvedDir === resolvedRoot || !resolvedDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail('BENCHMARK_TEMP_DIRECTORY_INVALID', 'benchmark DB 目录不在私有临时根下');
  }
}

async function runOfflineBenchmark(options, dependencies = {}) {
  const prepared = await (dependencies.prepareInputs || prepareRealInputs)(
    options.inputPaths,
    dependencies
  );
  const tempRoot = (dependencies.tempRoot || os.tmpdir)();
  const mkdtempSync = dependencies.mkdtempSync || fs.mkdtempSync;
  const rmSync = dependencies.rmSync || fs.rmSync;
  const tempDir = mkdtempSync(path.join(tempRoot, 'vcc-op-parser-benchmark-'));
  assertPrivateTempDirectory(tempDir, tempRoot);
  const DatabaseClass = dependencies.AppDatabaseClass || AppDatabase;
  let appDatabase = null;
  const runs = [];
  try {
    appDatabase = new DatabaseClass(path.join(tempDir, 'tool-data.sqlite'));
    appDatabase.init();
    if (!appDatabase.db) fail('BENCHMARK_PRIVATE_DB_UNAVAILABLE', 'benchmark 私有 DB 未初始化');
    for (let scenarioIndex = 0; scenarioIndex < SCENARIO_FILE_COUNTS.length; scenarioIndex += 1) {
      const fileCount = SCENARIO_FILE_COUNTS[scenarioIndex];
      const inputs = prepared.inputs.slice(0, fileCount);
      // 每个组合先执行一次不计入证据的完整 parse/reduce/private-save warm-up，
      // 避免后跑 worker 系统性独占 OS cache/module 热状态。
      for (const requestedWorkerCount of REQUESTED_WORKER_COUNTS) {
        await (dependencies.runSingleSample || runSingleSample)({
          db: appDatabase.db,
          beginOp: options.beginOp,
          inputs,
          requestedWorkerCount
        }, dependencies);
      }
      // 计入证据的轮次按 scenario/run 确定性旋转 worker 顺序。
      for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
        for (const requestedWorkerCount of rotatedWorkerOrder(runIndex, scenarioIndex)) {
          const metrics = await (dependencies.runSingleSample || runSingleSample)({
            db: appDatabase.db,
            beginOp: options.beginOp,
            inputs,
            requestedWorkerCount
          }, dependencies);
          runs.push(Object.freeze({ fileCount, requestedWorkerCount, runIndex, metrics }));
        }
      }
    }
  } finally {
    try {
      if (appDatabase) appDatabase.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  return buildEvidenceReport({
    runs,
    inputEvidence: prepared.evidence,
    options,
    environment: dependencies.environment
  });
}

function publicFailureCode(error) {
  return error instanceof VccOpParserBenchmarkError
    ? error.code
    : 'BENCHMARK_EXECUTION_FAILED';
}

module.exports = {
  BENCHMARK_CONTRACT_VERSION,
  BENCHMARK_EVIDENCE_KIND,
  DEFAULT_RUNS,
  METRIC_KEYS,
  QUALIFYING_RUNS,
  REASON_CODES,
  REQUESTED_WORKER_COUNTS,
  RSS_SAMPLE_INTERVAL_MS,
  SCENARIO_FILE_COUNTS,
  TIMING_DEFINITIONS,
  VccOpParserBenchmarkError,
  assertEvidencePrivacy,
  buildEvidenceReport,
  createOperationOwner,
  evaluateEligibility,
  median,
  medianRows,
  parseBenchmarkArgs,
  prepareRealInputs,
  publicFailureCode,
  rotatedWorkerOrder,
  runOfflineBenchmark,
  runParserScenario,
  runSingleSample,
  safeEnvironment
};
