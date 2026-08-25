'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { describe, test } = require('node:test');
const {
  FLOW_DB_COLUMNS,
  VCC_BILL_DATE_DB_COLUMN,
  VCC_CURRENCY_DB_COLUMN,
  VCC_DIRECTION_DB_COLUMN,
  VCC_RECON_AMOUNT_DB_COLUMN
} = require('../../../src/backend/vcc-op-calc-db/columns');
const {
  PARSER_RESULT_KEYS,
  computeParserSemanticHash,
  parseVccFileUnit
} = require('../../../src/main-process/vcc-op-calc/parser-core');
const {
  buildParserInputEvidenceHash,
  createOrderedReducer
} = require('../../../src/main-process/vcc-op-calc/ordered-reducer');
const {
  EFFECTIVE_PARSER_WORKER_COUNT,
  resolveEffectiveWorkerCount,
  runParserWorker,
  runVccParserPipeline
} = require('../../../src/main-process/vcc-op-calc/parser-pipeline');
const { createVccOpCalcSession } = require('../../../src/main-process/vcc-op-calc-session');

const SNAPSHOT_A = Object.freeze({ sizeBytes: 100, mtimeMs: 200, ctimeMs: 300, ino: '41' });
const SNAPSHOT_B = Object.freeze({ sizeBytes: 101, mtimeMs: 201, ctimeMs: 301, ino: '42' });

function parserInput(fileIndex, fileName, sourceSnapshot = SNAPSHOT_A, maxErrors = 100) {
  return {
    fileIndex,
    filePath: path.join('/private/tmp/vcc-e03-a', fileName),
    sourceSnapshot,
    maxErrors,
    parserContractVersion: 1
  };
}

function parserResult(input, overrides = {}) {
  const result = {
    fileIndex: input.fileIndex,
    sourceSnapshot: input.sourceSnapshot,
    rowCount: 1,
    monthKeys: ['2026-08'],
    currencies: ['CNY'],
    amountOutCents: 0,
    amountInCents: 100,
    errorCount: 0,
    errorRows: [],
    ...overrides
  };
  return { ...result, semanticHash: computeParserSemanticHash(result) };
}

function statFor(snapshot) {
  return {
    isFile: () => true,
    size: BigInt(snapshot.sizeBytes),
    mtimeNs: BigInt(Math.round(snapshot.mtimeMs * 1e6)),
    ctimeNs: BigInt(Math.round(snapshot.ctimeMs * 1e6)),
    ino: BigInt(snapshot.ino)
  };
}

function computeSnapshot(label, amountInCents) {
  return {
    computeSnapshotContractVersion: 1,
    inputEvidenceHash: label.repeat(64).slice(0, 64),
    yearMonth: '2026-08',
    totalRows: 1,
    totals: {
      totalOutCents: 0,
      totalInCents: amountInCents,
      totalAmountCents: amountInCents,
      totalOut: '0.00',
      totalIn: (amountInCents / 100).toFixed(2),
      totalAmount: (amountInCents / 100).toFixed(2),
      currency: 'CNY'
    },
    perFile: [{
      fileName: `${label}.xlsx`,
      rowCount: 1,
      amountOutCents: 0,
      amountInCents,
      amountCents: amountInCents,
      amountOut: '0.00',
      amountIn: (amountInCents / 100).toFixed(2),
      amount: (amountInCents / 100).toFixed(2)
    }]
  };
}

function controlledCancellablePipeline(calls) {
  return (_inputs, options = {}) => new Promise((resolve, reject) => {
    const signal = options.signal;
    assert.ok(signal instanceof AbortSignal);
    const rejectCancelled = () => reject(Object.assign(
      new Error('cancelled'),
      { code: 'VCC_PARSER_PIPELINE_CANCELLED' }
    ));
    calls.push({ reject, resolve, signal });
    if (signal.aborted) {
      queueMicrotask(rejectCancelled);
      return;
    }
    signal.addEventListener('abort', rejectCancelled, { once: true });
  });
}

function row({ direction = '入', amount = '1.00', billDate = '2026-08-01', currency = 'CNY', rowIndex = 2 } = {}) {
  const value = Object.fromEntries(FLOW_DB_COLUMNS.map((column) => [column, '']));
  value[VCC_DIRECTION_DB_COLUMN] = direction;
  value[VCC_RECON_AMOUNT_DB_COLUMN] = amount;
  value[VCC_BILL_DATE_DB_COLUMN] = billDate;
  value[VCC_CURRENCY_DB_COLUMN] = currency;
  value._rowIndex = rowIndex;
  return value;
}

describe('VCC Parser Core v1', () => {
  test('固定 input/result，复用资金口径并把 errorRows 截断到 maxErrors', async () => {
    const input = parserInput(0, 'core.xlsx', SNAPSHOT_A, 2);
    const rows = [
      row({ direction: '入', amount: '1.25', currency: 'USD' }),
      row({ direction: '错', rowIndex: 3 }),
      row({ amount: 'NaN', rowIndex: 4 }),
      row({ billDate: '', rowIndex: 5 })
    ];
    const result = await parseVccFileUnit(input, {
      statFile: async () => statFor(SNAPSHOT_A),
      streamFile: async (_filePath, callbacks) => {
        for (const value of rows) callbacks.onDataRow(value);
      }
    });

    assert.deepEqual(Object.keys(result).sort(), PARSER_RESULT_KEYS);
    assert.equal(result.rowCount, 4);
    assert.equal(result.amountInCents, 125);
    assert.equal(result.amountOutCents, 0);
    assert.deepEqual(result.monthKeys, ['2026-08']);
    assert.deepEqual(result.currencies, ['USD']);
    assert.equal(result.errorCount, 3);
    assert.equal(result.errorRows.length, 2);
    assert.equal(result.semanticHash, computeParserSemanticHash(result));
    assert.equal(Object.isFrozen(result), true);
  });

  test('解析后 source snapshot 漂移即丢弃 unit', async () => {
    const input = parserInput(0, 'drift.xlsx');
    let calls = 0;
    await assert.rejects(
      parseVccFileUnit(input, {
        statFile: async () => {
          calls += 1;
          return statFor(calls === 1 ? SNAPSHOT_A : { ...SNAPSHOT_A, mtimeMs: 201 });
        },
        streamFile: async (_filePath, callbacks) => callbacks.onDataRow(row())
      }),
      (error) => error && error.code === 'VCC_PARSER_SOURCE_CHANGED'
    );
  });

  test('解析前 source snapshot 已变化时不调用 reader', async () => {
    const input = parserInput(0, 'pre-drift.xlsx');
    let readerCalled = false;
    await assert.rejects(
      parseVccFileUnit(input, {
        statFile: async () => statFor({ ...SNAPSHOT_A, sizeBytes: 999 }),
        streamFile: async () => { readerCalled = true; }
      }),
      (error) => error && error.code === 'VCC_PARSER_SOURCE_CHANGED'
    );
    assert.equal(readerCalled, false);
  });

  test('单行金额超出安全整数分范围按业务错误拒绝，不产生 unsafe aggregate', async () => {
    const input = parserInput(0, 'unsafe.xlsx');
    const result = await parseVccFileUnit(input, {
      statFile: async () => statFor(SNAPSHOT_A),
      streamFile: async (_filePath, callbacks) => callbacks.onDataRow(row({ amount: '90071992547410.00' }))
    });
    assert.equal(result.errorCount, 1);
    assert.match(result.errorRows[0].reason, /安全整数分范围/);
    assert.equal(result.amountInCents, 0);
  });
});

describe('VCC Ordered Reducer', () => {
  test('乱序只缓存，按 fileIndex 连续消费且 perFile/金额/行数无重无漏', () => {
    const inputs = [
      parserInput(0, 'a.xlsx', SNAPSHOT_A),
      parserInput(1, 'b.xlsx', SNAPSHOT_B),
      parserInput(2, 'c.xlsx', SNAPSHOT_A)
    ];
    const reducer = createOrderedReducer({ inputs });
    reducer.accept(parserResult(inputs[2], { rowCount: 3, amountInCents: 300 }));
    assert.deepEqual(reducer.state(), {
      nextExpectedIndex: 0,
      bufferedCount: 1,
      acceptedCount: 1,
      expectedCount: 3,
      finalized: false
    });
    reducer.accept(parserResult(inputs[0], { rowCount: 1, amountInCents: 100 }));
    reducer.accept(parserResult(inputs[1], { rowCount: 2, amountOutCents: 40, amountInCents: 0 }));
    const reduced = reducer.finalize();

    assert.equal(reduced.ok, true);
    assert.equal(reduced.snapshot.totalRows, 6);
    assert.equal(reduced.snapshot.totals.totalInCents, 400);
    assert.equal(reduced.snapshot.totals.totalOutCents, 40);
    assert.equal(reduced.snapshot.totals.totalAmountCents, 360);
    assert.deepEqual(reduced.snapshot.perFile.map((item) => item.fileName), ['a.xlsx', 'b.xlsx', 'c.xlsx']);
    assert.deepEqual(reduced.snapshot.perFile.map((item) => item.rowCount), [1, 2, 3]);
    assert.equal(Object.isFrozen(reduced.snapshot), true);
    assert.equal(Object.isFrozen(reduced.snapshot.perFile), true);
    assert.doesNotMatch(JSON.stringify(reduced.snapshot), /\/private\/tmp\/vcc-e03-a/);
  });

  test('inputEvidenceHash 同一有序输入稳定，调换文件顺序必变化', () => {
    const ordered = [parserInput(0, 'a.xlsx', SNAPSHOT_A), parserInput(1, 'b.xlsx', SNAPSHOT_B)];
    const reordered = [parserInput(0, 'b.xlsx', SNAPSHOT_B), parserInput(1, 'a.xlsx', SNAPSHOT_A)];
    assert.equal(buildParserInputEvidenceHash(ordered), buildParserInputEvidenceHash(structuredClone(ordered)));
    assert.notEqual(buildParserInputEvidenceHash(ordered), buildParserInputEvidenceHash(reordered));
  });

  test('duplicate 与 missing fileIndex 都 fail closed', () => {
    const inputs = [parserInput(0, 'a.xlsx'), parserInput(1, 'b.xlsx', SNAPSHOT_B)];
    const duplicate = createOrderedReducer({ inputs });
    const first = parserResult(inputs[0]);
    duplicate.accept(first);
    assert.throws(
      () => duplicate.accept(first),
      (error) => error && error.code === 'VCC_REDUCER_FILE_INDEX_DUPLICATE'
    );

    const missing = createOrderedReducer({ inputs });
    missing.accept(parserResult(inputs[1]));
    assert.throws(
      () => missing.finalize(),
      (error) => error && error.code === 'VCC_REDUCER_FILE_INDEX_MISSING'
    );
  });

  test('source snapshot drift、unsafe amount、semantic hash mismatch 分别拒绝', () => {
    const input = parserInput(0, 'a.xlsx');

    const driftReducer = createOrderedReducer({ inputs: [input] });
    const drift = parserResult(input, { sourceSnapshot: SNAPSHOT_B });
    assert.throws(
      () => driftReducer.accept(drift),
      (error) => error && error.code === 'VCC_REDUCER_SOURCE_SNAPSHOT_MISMATCH'
    );

    const unsafeReducer = createOrderedReducer({ inputs: [input] });
    const unsafe = { ...parserResult(input), amountInCents: Number.MAX_SAFE_INTEGER + 1 };
    assert.throws(
      () => unsafeReducer.accept(unsafe),
      (error) => error && error.code === 'VCC_REDUCER_AMOUNT_UNSAFE'
    );

    const hashReducer = createOrderedReducer({ inputs: [input] });
    const staleHash = { ...parserResult(input), amountInCents: 101 };
    assert.throws(
      () => hashReducer.accept(staleHash),
      (error) => error && error.code === 'VCC_REDUCER_SEMANTIC_HASH_MISMATCH'
    );
  });

  test('多文件错误按 input order 全局截断；errorCount 保留全量且不产生 snapshot', () => {
    const inputs = [
      parserInput(0, 'a.xlsx', SNAPSHOT_A, 2),
      parserInput(1, 'b.xlsx', SNAPSHOT_B, 2)
    ];
    const reducer = createOrderedReducer({ inputs, maxErrors: 2 });
    const errorsA = [
      { fileName: 'a.xlsx', rowIndex: 2, reason: 'A-1' },
      { fileName: 'a.xlsx', rowIndex: 3, reason: 'A-2' }
    ];
    const errorsB = [
      { fileName: 'b.xlsx', rowIndex: 2, reason: 'B-1' },
      { fileName: 'b.xlsx', rowIndex: 3, reason: 'B-2' }
    ];
    reducer.accept(parserResult(inputs[1], { rowCount: 3, errorCount: 3, errorRows: errorsB, amountInCents: 0 }));
    reducer.accept(parserResult(inputs[0], { rowCount: 3, errorCount: 3, errorRows: errorsA, amountInCents: 0 }));
    const reduced = reducer.finalize();
    assert.deepEqual(reduced, { ok: false, errorRows: errorsA, errorCount: 6 });
    assert.equal('snapshot' in reduced, false);
  });

  test('跨月错误沿用 legacy 分类并在 capped row samples 后追加', () => {
    const inputs = [
      parserInput(0, 'a.xlsx', SNAPSHOT_A, 1),
      parserInput(1, 'b.xlsx', SNAPSHOT_B, 1)
    ];
    const reducer = createOrderedReducer({ inputs, maxErrors: 1 });
    reducer.accept(parserResult(inputs[0], {
      rowCount: 2,
      monthKeys: ['2026-07'],
      errorCount: 1,
      errorRows: [{ fileName: 'a.xlsx', rowIndex: 2, reason: 'A' }]
    }));
    reducer.accept(parserResult(inputs[1], { monthKeys: ['2026-08'] }));
    const reduced = reducer.finalize();
    assert.equal(reduced.errorCount, 2);
    assert.equal(reduced.errorRows.length, 2);
    assert.equal(reduced.errorRows[0].reason, 'A');
    assert.match(reduced.errorRows[1].reason, /跨多个月份（2026-07, 2026-08）/);
  });
});

describe('VCC Parser Pipeline', () => {
  test('requested=4 仍以机器断言锁死 effective=1，逐文件执行后才 finalize', async () => {
    const inputs = [
      { filePath: parserInput(0, 'a.xlsx').filePath, sourceSnapshot: SNAPSHOT_A },
      { filePath: parserInput(1, 'b.xlsx').filePath, sourceSnapshot: SNAPSHOT_B },
      { filePath: parserInput(2, 'c.xlsx').filePath, sourceSnapshot: SNAPSHOT_A }
    ];
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const reduced = await runVccParserPipeline(inputs, {
      requestedWorkerCount: 4,
      runUnit: async (unit) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(unit.fileIndex);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return parserResult(unit, { amountInCents: 100 * (unit.fileIndex + 1) });
      }
    });
    assert.equal(EFFECTIVE_PARSER_WORKER_COUNT, 1);
    assert.equal(resolveEffectiveWorkerCount({ requestedWorkerCount: 4 }), 1);
    assert.equal(maxActive, 1);
    assert.deepEqual(calls, [0, 1, 2]);
    assert.equal(reduced.ok, true);
    assert.equal(reduced.snapshot.totals.totalInCents, 600);
  });

  test('显式请求 effective>1 稳定拒绝，不可绕过 E03-A gate', async () => {
    await assert.rejects(
      runVccParserPipeline([
        { filePath: parserInput(0, 'a.xlsx').filePath, sourceSnapshot: SNAPSHOT_A }
      ], { effectiveWorkerCount: 2 }),
      (error) => error && error.code === 'VCC_PARSER_EFFECTIVE_WORKER_COUNT_LOCKED'
    );
  });

  test('cancel 中止 active unit，pipeline 不返回任何 candidate snapshot', async () => {
    const abort = new AbortController();
    let started = false;
    const pending = runVccParserPipeline([
      { filePath: parserInput(0, 'a.xlsx').filePath, sourceSnapshot: SNAPSHOT_A },
      { filePath: parserInput(1, 'b.xlsx').filePath, sourceSnapshot: SNAPSHOT_B }
    ], {
      signal: abort.signal,
      runUnit: (_unit, { signal }) => new Promise((resolve, reject) => {
        started = true;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
          code: 'VCC_PARSER_PIPELINE_CANCELLED'
        })), { once: true });
      })
    });
    while (!started) await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await assert.rejects(pending, (error) => error && error.code === 'VCC_PARSER_PIPELINE_CANCELLED');
  });

  test('unit crash 立即终止整批，后续文件不执行', async () => {
    const inputs = [
      { filePath: parserInput(0, 'a.xlsx').filePath, sourceSnapshot: SNAPSHOT_A },
      { filePath: parserInput(1, 'b.xlsx').filePath, sourceSnapshot: SNAPSHOT_B }
    ];
    const calls = [];
    await assert.rejects(
      runVccParserPipeline(inputs, {
        runUnit: async (unit) => {
          calls.push(unit.fileIndex);
          throw Object.assign(new Error('parser crashed'), { code: 'VCC_PARSER_WORKER_CRASHED' });
        }
      }),
      (error) => error && error.code === 'VCC_PARSER_WORKER_CRASHED'
    );
    assert.deepEqual(calls, [0]);
  });

  test('真实 Worker adapter 区分 spawn failure 与 crash', async () => {
    const input = parserInput(0, 'a.xlsx');
    class SpawnFailureWorker {
      constructor() {
        throw new Error('spawn failed');
      }
    }
    await assert.rejects(
      runParserWorker(input, { WorkerClass: SpawnFailureWorker }),
      (error) => error && error.code === 'VCC_PARSER_WORKER_SPAWN_FAILED'
    );

    class CrashWorker extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => this.emit('error', new Error('crash')));
      }

      terminate() {
        return Promise.resolve(1);
      }
    }
    await assert.rejects(
      runParserWorker(input, { WorkerClass: CrashWorker }),
      (error) => error && error.code === 'VCC_PARSER_WORKER_CRASHED'
    );
  });

  test('Worker adapter 等待 terminate 完成后才 settle，避免下一 unit 短暂重叠', async () => {
    let releaseTermination;
    class ResultWorker extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => this.emit('message', { fileIndex: 0 }));
      }

      terminate() {
        return new Promise((resolve) => { releaseTermination = resolve; });
      }
    }
    let settled = false;
    const pending = runParserWorker(parserInput(0, 'a.xlsx'), { WorkerClass: ResultWorker })
      .then((result) => {
        settled = true;
        return result;
      });
    while (!releaseTermination) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseTermination(1);
    assert.deepEqual(await pending, { fileIndex: 0 });
    assert.equal(settled, true);
  });
});

describe('VCC session Compute Snapshot adoption', () => {
  test('scan success 只在 pipeline 全完成后采用 immutable snapshot，Renderer DTO 不暴露 evidence/path', async () => {
    const snapshot = computeSnapshot('a', 125);
    const session = createVccOpCalcSession({
      getDb: () => null,
      parserPipeline: async () => ({ ok: true, snapshot })
    });
    const returned = await session.parserPipelineScanAndCompute([{ filePath: '/private/tmp/a.xlsx' }]);
    const cache = session.getComputeCache();
    assert.equal(returned.ok, true);
    assert.equal(returned.totals.totalAmount, '1.25');
    assert.equal('inputEvidenceHash' in returned, false);
    assert.equal(cache.inputEvidenceHash, 'a'.repeat(64));
    assert.equal(Object.isFrozen(cache), true);
    assert.equal(Object.isFrozen(cache.totals), true);
    assert.equal(Object.isFrozen(cache.perFile), true);
    assert.doesNotMatch(JSON.stringify(returned), /\/private\/tmp/);
  });

  test('旧 scan 迟到不能覆盖新 generation 已采用的 snapshot', async () => {
    const pending = [];
    const session = createVccOpCalcSession({
      getDb: () => null,
      parserPipeline: () => new Promise((resolve) => pending.push(resolve))
    });
    const oldScan = session.parserPipelineScanAndCompute([{ filePath: '/private/tmp/old.xlsx' }]);
    const newScan = session.parserPipelineScanAndCompute([{ filePath: '/private/tmp/new.xlsx' }]);

    pending[1]({ ok: true, snapshot: computeSnapshot('n', 200) });
    await newScan;
    assert.equal(session.getComputeCache().totals.totalInCents, 200);

    pending[0]({ ok: true, snapshot: computeSnapshot('o', 100) });
    await assert.rejects(
      oldScan,
      (error) => error && error.code === 'VCC_COMPUTE_SCAN_SUPERSEDED'
    );
    assert.equal(session.getComputeCache().totals.totalInCents, 200);
    assert.equal(session.getComputeCache().inputEvidenceHash, 'n'.repeat(64));
  });

  test('新 Parser scan 立即 abort 旧 signal，旧调用保持 superseded 且新 snapshot 正常采用', async () => {
    const calls = [];
    const session = createVccOpCalcSession({
      getDb: () => null,
      parserPipeline: controlledCancellablePipeline(calls)
    });
    const oldScan = session.parserPipelineScanAndCompute([{ filePath: '/private/tmp/old.xlsx' }]);
    const oldRejected = assert.rejects(
      oldScan,
      (error) => error && error.code === 'VCC_COMPUTE_SCAN_SUPERSEDED'
    );
    assert.equal(calls[0].signal.aborted, false);

    const newScan = session.parserPipelineScanAndCompute([{ filePath: '/private/tmp/new.xlsx' }]);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    await oldRejected;

    calls[1].resolve({ ok: true, snapshot: computeSnapshot('n', 200) });
    const result = await newScan;
    assert.equal(result.totals.totalInCents, 200);
    assert.equal(session.getComputeCache().inputEvidenceHash, 'n'.repeat(64));
  });

  test('旧 scan finally 不清除新 controller；clearCache 与调用方 signal 分别保持取消语义', async () => {
    const calls = [];
    const session = createVccOpCalcSession({
      getDb: () => null,
      parserPipeline: controlledCancellablePipeline(calls)
    });
    const oldScan = session.parserPipelineScanAndCompute([{}]);
    const oldRejected = assert.rejects(
      oldScan,
      (error) => error && error.code === 'VCC_COMPUTE_SCAN_SUPERSEDED'
    );
    const currentScan = session.parserPipelineScanAndCompute([{}]);
    const currentRejected = assert.rejects(
      currentScan,
      (error) => error && error.code === 'VCC_COMPUTE_SCAN_SUPERSEDED'
    );
    await oldRejected;

    session.clearCache();
    assert.equal(calls[1].signal.aborted, true, '旧 finally 不得清除当前 controller');
    await currentRejected;

    const callerController = new AbortController();
    const callerScan = session.parserPipelineScanAndCompute([{}], {
      signal: callerController.signal
    });
    const callerRejected = assert.rejects(
      callerScan,
      (error) => error && error.code === 'VCC_PARSER_PIPELINE_CANCELLED'
    );
    assert.equal(calls[2].signal.aborted, false);
    callerController.abort();
    assert.equal(calls[2].signal.aborted, true);
    await callerRejected;
  });

  test('新 scan 的业务拒绝、crash/cancel、clearCache 都先清除旧 snapshot', async () => {
    const outcomes = [
      { ok: true, snapshot: computeSnapshot('a', 100) },
      { ok: false, errorRows: [{ fileName: 'bad.xlsx', rowIndex: 2, reason: 'bad' }], errorCount: 1 },
      Object.assign(new Error('cancelled'), { code: 'VCC_PARSER_PIPELINE_CANCELLED' })
    ];
    const session = createVccOpCalcSession({
      getDb: () => null,
      parserPipeline: async () => {
        const next = outcomes.shift();
        if (next instanceof Error) throw next;
        return next;
      }
    });

    await session.parserPipelineScanAndCompute([{}]);
    assert.ok(session.getComputeCache());
    const rejected = await session.parserPipelineScanAndCompute([{}]);
    assert.equal(rejected.ok, false);
    assert.equal(session.getComputeCache(), null);
    await assert.rejects(
      session.parserPipelineScanAndCompute([{}]),
      (error) => error && error.code === 'VCC_PARSER_PIPELINE_CANCELLED'
    );
    assert.equal(session.getComputeCache(), null);

    const deferred = [];
    const clearingSession = createVccOpCalcSession({
      getDb: () => null,
      parserPipeline: () => new Promise((resolve) => deferred.push(resolve))
    });
    const pendingScan = clearingSession.parserPipelineScanAndCompute([{}]);
    clearingSession.clearCache();
    deferred[0]({ ok: true, snapshot: computeSnapshot('z', 300) });
    await assert.rejects(
      pendingScan,
      (error) => error && error.code === 'VCC_COMPUTE_SCAN_SUPERSEDED'
    );
    assert.equal(clearingSession.getComputeCache(), null);
  });
});
