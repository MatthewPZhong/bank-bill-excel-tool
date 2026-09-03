'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  METRIC_KEYS,
  REASON_CODES,
  REQUESTED_WORKER_COUNTS,
  SCENARIO_FILE_COUNTS,
  TIMING_DEFINITIONS,
  assertEvidencePrivacy,
  buildEvidenceReport,
  createOperationOwner,
  evaluateEligibility,
  median,
  parseBenchmarkArgs,
  rotatedWorkerOrder,
  runOfflineBenchmark
} = require('../../../scripts/lib/vcc-op-parser-benchmark');
const {
  atomicWriteEvidenceFile,
  runCli
} = require('../../../scripts/vcc-op-parser-benchmark');
const {
  EFFECTIVE_PARSER_WORKER_COUNT,
  resolveEffectiveWorkerCount
} = require('../../../src/main-process/vcc-op-calc/parser-pipeline');

function metrics(e2eMs = 100, overrides = {}) {
  return {
    e2eMs,
    parseWallMs: e2eMs * 0.7,
    parseCumulativeWorkerMs: e2eMs * 0.75,
    reduceWallMs: e2eMs * 0.05,
    saveWallMs: e2eMs * 0.1,
    peakRssMiB: 128,
    eventLoopDelayMaxMs: 12,
    ...overrides
  };
}

function e2eFor(fileCount, workerCount) {
  if (fileCount === 1) return ({ 1: 100, 2: 104, 3: 106, 4: 110 })[workerCount];
  if (fileCount === 8) return ({ 1: 1000, 2: 800, 3: 700, 4: 850 })[workerCount];
  return fileCount * 100 / workerCount;
}

function completeSamples(overrides = {}) {
  const values = [];
  for (const fileCount of SCENARIO_FILE_COUNTS) {
    for (const requestedWorkerCount of REQUESTED_WORKER_COUNTS) {
      for (let runIndex = 1; runIndex <= 5; runIndex += 1) {
        values.push({
          fileCount,
          requestedWorkerCount,
          runIndex,
          metrics: metrics(e2eFor(fileCount, requestedWorkerCount), overrides)
        });
      }
    }
  }
  return values;
}

function reportInput(runs = completeSamples(), options = {}) {
  return {
    runs,
    inputEvidence: {
      inputSetHash: 'a'.repeat(64),
      inputCount: 8,
      totalSizeBytes: 123456
    },
    options: {
      runs: 5,
      maxRssMiB: 512,
      maxEventLoopDelayMs: 50,
      ...options
    },
    environment: {
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v22.0.0',
      logicalCpuCount: 8,
      totalMemoryMiB: 16384
    }
  };
}

function argvForEight(extra = []) {
  return [
    ...Array.from({ length: 8 }, (_, index) => ['--input', `input-${index + 1}.xlsx`]).flat(),
    ...extra
  ];
}

test('args 要求 8 个不同 real inputs，默认 5 runs 并解析显式阈值/evidence file', () => {
  const parsed = parseBenchmarkArgs(argvForEight([
    '--begin-op', '12.3',
    '--max-rss-mib=512',
    '--max-event-loop-delay-ms', '40',
    '--evidence-file', 'evidence.json'
  ]), { resolvePath: (value) => `/resolved/${value}` });
  assert.equal(parsed.runs, 5);
  assert.equal(parsed.beginOp, '12.30');
  assert.equal(parsed.inputPaths.length, 8);
  assert.equal(parsed.maxRssMiB, 512);
  assert.equal(parsed.maxEventLoopDelayMs, 40);
  assert.equal(parsed.evidenceFilePath, '/resolved/evidence.json');
  assert.throws(
    () => parseBenchmarkArgs(argvForEight().map((value) => (
      value === 'input-8.xlsx' ? 'input-1.xlsx' : value
    )), { resolvePath: (value) => `/resolved/${value}` }),
    { code: 'BENCHMARK_INPUT_DUPLICATE' }
  );
  assert.throws(
    () => parseBenchmarkArgs(argvForEight().slice(0, -2)),
    { code: 'BENCHMARK_INPUT_COUNT_INVALID' }
  );
});

test('median 对奇偶样本确定性，timing 明确区分 parse wall 与 cumulative worker', () => {
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([8, 2, 4, 6]), 5);
  assert.equal(TIMING_DEFINITIONS.parseWallMs, 'WORKER_DISPATCH_TO_ALL_RESULTS_WALL');
  assert.equal(
    TIMING_DEFINITIONS.parseCumulativeWorkerMs,
    'SUM_PER_UNIT_WORKER_DISPATCH_TO_RESULT_WALL'
  );
  assert.ok(METRIC_KEYS.includes('parseCumulativeWorkerMs'));
});

test('完整 5-run 矩阵只有同时过 large/small/RSS/event-loop 才推荐 >1', () => {
  const evaluation = evaluateEligibility(completeSamples(), {
    runsPerCombination: 5,
    maxRssMiB: 512,
    maxEventLoopDelayMs: 50
  });
  assert.equal(evaluation.status, 'ELIGIBLE');
  assert.equal(evaluation.eligibleWorkerCount, 2);
  assert.deepEqual(evaluation.reasonCodes, []);
  const worker2 = evaluation.candidates.find((candidate) => candidate.workerCount === 2);
  assert.equal(worker2.largeImprovementPct, 20);
  assert.equal(worker2.smallRegressionPct, 4);
});

test('缺阈值、矩阵不全、资源越界均 NOT_EVALUATED 且 worker=1', () => {
  const missing = evaluateEligibility(completeSamples(), { runsPerCombination: 5 });
  assert.equal(missing.status, 'NOT_EVALUATED');
  assert.equal(missing.eligibleWorkerCount, 1);
  assert.ok(missing.reasonCodes.includes(REASON_CODES.RSS_THRESHOLD_MISSING));
  assert.ok(missing.reasonCodes.includes(REASON_CODES.EVENT_LOOP_THRESHOLD_MISSING));

  const incomplete = evaluateEligibility(completeSamples().slice(0, -1), {
    runsPerCombination: 5,
    maxRssMiB: 512,
    maxEventLoopDelayMs: 50
  });
  assert.equal(incomplete.eligibleWorkerCount, 1);
  assert.ok(incomplete.reasonCodes.includes(REASON_CODES.MATRIX_INCOMPLETE));

  const exceeded = evaluateEligibility(completeSamples({
    peakRssMiB: 513,
    eventLoopDelayMaxMs: 51
  }), {
    runsPerCombination: 5,
    maxRssMiB: 512,
    maxEventLoopDelayMs: 50
  });
  assert.equal(exceeded.eligibleWorkerCount, 1);
  assert.ok(exceeded.reasonCodes.includes(REASON_CODES.RSS_THRESHOLD_EXCEEDED));
  assert.ok(exceeded.reasonCodes.includes(REASON_CODES.EVENT_LOOP_THRESHOLD_EXCEEDED));
});

test('evidence 仅保留 hash/count/size/safe environment，不含路径/文件名/free text', () => {
  const report = buildEvidenceReport(reportInput());
  assert.equal(report.status, 'ELIGIBLE');
  assert.equal(report.productionChange, 'NONE');
  assert.equal(report.benchmarkContract.productionEffectiveWorkerCount, 1);
  assert.equal(report.benchmarkContract.warmupRunsPerCombination, 1);
  assert.equal(
    report.benchmarkContract.measurementSchedule,
    'WARMUP_ONE_PER_COMBINATION_THEN_DETERMINISTIC_ROTATION'
  );
  assert.equal(assertEvidencePrivacy(report), true);
  assert.doesNotMatch(JSON.stringify(report), /input-\d|\.xlsx|[\\/]resolved[\\/]/);
  assert.throws(
    () => assertEvidencePrivacy({ note: 'arbitrary text' }),
    { code: 'BENCHMARK_EVIDENCE_FREE_TEXT' }
  );
  assert.throws(
    () => assertEvidencePrivacy({ fileName: 'a'.repeat(64) }),
    { code: 'BENCHMARK_EVIDENCE_KEY_FORBIDDEN' }
  );
});

test('warm-up 不计入 evidence，5轮按 scenario/run 确定性 rotation 交错', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-benchmark-matrix-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const calls = [];
  let databasePath = null;
  class FakeAppDatabase {
    constructor(dbPath) {
      databasePath = dbPath;
      this.db = null;
    }

    init() { this.db = {}; }
    close() { this.db = null; }
  }
  const preparedInputs = Array.from({ length: 8 }, (_, index) => ({
    filePath: `/private/input-${index}.xlsx`,
    sourceSnapshot: { sizeBytes: 1, mtimeMs: 1, ctimeMs: 1 }
  }));
  const report = await runOfflineBenchmark({
    inputPaths: preparedInputs.map((item) => item.filePath),
    beginOp: '0.00',
    runs: 5,
    maxRssMiB: 512,
    maxEventLoopDelayMs: 50,
    evidenceFilePath: null
  }, {
    AppDatabaseClass: FakeAppDatabase,
    tempRoot: () => tempRoot,
    prepareInputs: async () => ({
      inputs: preparedInputs,
      evidence: { inputSetHash: 'b'.repeat(64), inputCount: 8, totalSizeBytes: 8 }
    }),
    runSingleSample: async ({ inputs, requestedWorkerCount }) => {
      calls.push([inputs.length, requestedWorkerCount]);
      return metrics(e2eFor(inputs.length, requestedWorkerCount));
    },
    environment: reportInput().environment
  });
  assert.equal(calls.length, 16 + 80);
  assert.deepEqual(calls.slice(0, 4), [[1, 1], [1, 2], [1, 3], [1, 4]]);
  assert.deepEqual(calls.slice(4, 8).map((item) => item[1]), [1, 2, 3, 4]);
  assert.deepEqual(calls.slice(8, 12).map((item) => item[1]), [2, 3, 4, 1]);
  const scenarioTwoStart = 4 + (5 * 4);
  assert.deepEqual(calls.slice(scenarioTwoStart, scenarioTwoStart + 4), [
    [2, 1], [2, 2], [2, 3], [2, 4]
  ]);
  assert.deepEqual(calls.slice(scenarioTwoStart + 4, scenarioTwoStart + 8).map((item) => item[1]), [
    2, 3, 4, 1
  ]);
  assert.equal(report.runs.length, 80);
  assert.equal(report.medians.length, 16);
  assert.ok(databasePath.startsWith(`${tempRoot}${path.sep}`));
  assert.equal(fs.existsSync(path.dirname(databasePath)), false);
  assert.deepEqual(rotatedWorkerOrder(1, 0), [1, 2, 3, 4]);
  assert.deepEqual(rotatedWorkerOrder(2, 0), [2, 3, 4, 1]);
});

test('evidence-file 采用 exclusive atomic publish，既有文件绝不覆盖', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-benchmark-evidence-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'evidence.json');
  atomicWriteEvidenceFile(target, '{"status":"NOT_EVALUATED"}\n', {
    randomUuid: () => 'first'
  });
  assert.equal(fs.readFileSync(target, 'utf8'), '{"status":"NOT_EVALUATED"}\n');
  assert.throws(
    () => atomicWriteEvidenceFile(target, '{"status":"ELIGIBLE"}\n', {
      randomUuid: () => 'second'
    }),
    { code: 'EEXIST' }
  );
  assert.equal(fs.readFileSync(target, 'utf8'), '{"status":"NOT_EVALUATED"}\n');
  assert.deepEqual(fs.readdirSync(root), ['evidence.json']);
});

test('CLI 同时输出 stdout JSON/可选 evidence file，failure 只输出稳定 code', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-benchmark-cli-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'result.json');
  let stdout = '';
  let stderr = '';
  const report = buildEvidenceReport(reportInput(completeSamples(), {
    maxRssMiB: null,
    maxEventLoopDelayMs: null
  }));
  const exitCode = await runCli(argvForEight(['--evidence-file', target]), {
    runBenchmark: async () => report,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, fs.readFileSync(target, 'utf8'));
  assert.deepEqual(JSON.parse(stdout), report);

  stdout = '';
  stderr = '';
  const failed = await runCli(['--unknown'], {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }
  });
  assert.equal(failed, 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'VCC_OP_PARSER_BENCHMARK_ERROR=BENCHMARK_ARGUMENT_UNKNOWN\n');
});

test('Main owner 每次唯一且 production effective worker 始终锁死 1', () => {
  const values = ['owner-one', 'owner-two'];
  const first = createOperationOwner(() => values.shift());
  const second = createOperationOwner(() => values.shift());
  assert.notEqual(first.operationKey, second.operationKey);
  assert.equal(first.taskKey, 'vccOpCalc:run:save');
  assert.equal(first.moduleId, 'vcc-op-calc');
  assert.equal(EFFECTIVE_PARSER_WORKER_COUNT, 1);
  assert.equal(resolveEffectiveWorkerCount({ requestedWorkerCount: 4 }), 1);
  assert.throws(
    () => resolveEffectiveWorkerCount({ requestedWorkerCount: 4, effectiveWorkerCount: 2 }),
    { code: 'VCC_PARSER_EFFECTIVE_WORKER_COUNT_LOCKED' }
  );
});

test('package.json 只有一个 benchmark:vcc-op-parser key 且指向唯一 CLI', () => {
  const packagePath = path.resolve(__dirname, '../../../package.json');
  const source = fs.readFileSync(packagePath, 'utf8');
  assert.equal((source.match(/"benchmark:vcc-op-parser"/g) || []).length, 1);
  assert.equal(JSON.parse(source).scripts['benchmark:vcc-op-parser'],
    'node --no-warnings scripts/vcc-op-parser-benchmark.js');
  assert.equal(fs.existsSync(path.resolve(__dirname, '../../../scripts/benchmark-vcc-op-parser.js')), false);
});
