'use strict';

// G6 B2 独立差分探针。仅从 Git/文件系统读取源代码，不改生产文件或业务数据库。
// 在本功能 worktree 根执行：
// node changes/v3.2.10/codex/v3.2.10-storage-execution-separation/evidence/b2-differential-probe.cjs
// HEAD 旧 wrapper 与当前 service/repository 使用同一受控 executor/DB；
// 此探针证明接口和编排差分，不代替真实 worker、SQLite、XLSX 集成。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = process.cwd();
const repositoryPath = path.join(root, 'src/backend/acquiring-bill-currency-db/run-repository.js');
const servicePath = path.join(root, 'src/main-process/acquiring-bill-currency-multiworker-service.js');
const oldSource = execFileSync('git', ['show', 'HEAD:src/backend/acquiring-bill-currency-db/run-repository.js'], {
  cwd: root, encoding: 'utf8',
});
const currentRepository = require(repositoryPath);
const { createAcquiringMultiworkerService } = require(servicePath);
const valid = {
  runId: 1, monthKey: '2026-04', chunkSize: 2,
  dbPath: 'managed.sqlite', workerCount: 2, tempDir: 'managed-parts',
};
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function loadOldRepository(execute) {
  const oldModule = new Module(repositoryPath);
  oldModule.filename = repositoryPath;
  oldModule.paths = Module._nodeModulePaths(path.dirname(repositoryPath));
  const originalRequire = oldModule.require.bind(oldModule);
  oldModule.require = (id) => id === '../../main-process/run-check-multiworker'
    ? { runWriteSplitChunks: execute }
    : originalRequire(id);
  oldModule._compile(oldSource, repositoryPath);
  return oldModule.exports;
}

async function observe(which, options, totalRows, mode) {
  const calls = [];
  const progress = [];
  const executionError = Object.assign(new Error('execution-original'), { code: 'ORIGINAL' });
  const phaseError = new Error(`phase-${mode}`);
  const execute = async (params) => {
    calls.push(['execute', Object.fromEntries(
      Object.entries(params).filter(([key]) => !['db', 'onProgress'].includes(key))
    )]);
    params.onProgress({ chunkIndex: 1, totalChunks: 3, rowCount: 1 });
    if (mode.startsWith('execute') || ['BEGIN', 'DELETE', 'COMMIT', 'ROLLBACK'].includes(mode)) {
      throw executionError;
    }
    return { insertedRows: 3 };
  };
  const db = {
    prepare(sql) {
      calls.push(['prepare', sql]);
      if (mode === 'COUNT' && sql.includes('COUNT')) throw phaseError;
      return {
        get(monthKey) { calls.push(['count', monthKey]); return { c: totalRows }; },
        run(runId) {
          calls.push(['delete', runId]);
          if (['DELETE', 'ROLLBACK'].includes(mode)) throw phaseError;
        },
      };
    },
    exec(sql) { calls.push(['exec', sql]); if (mode === sql) throw phaseError; },
  };
  const insertDiffRows = which === 'old'
    ? loadOldRepository(execute).insertDiffRowsByJoinMultiWorker
    : createAcquiringMultiworkerService({
        runRepository: currentRepository, executeWriteSplitChunks: execute,
      }).insertDiffRows;
  let outcome;
  try {
    outcome = {
      result: await insertDiffRows(db, {
        ...options,
        onChunkDone(event) {
          progress.push(event);
          if (mode === 'progress') throw new Error('UI failure');
        },
      }),
    };
  } catch (error) {
    outcome = {
      error: {
        name: error.name, message: error.message, code: error.code,
        originalExecutionError: error === executionError,
      },
    };
  }
  return { calls, progress, outcome };
}

(async () => {
  const previousRepository = loadOldRepository(() => { throw new Error('此阶段不得执行'); });
  const retainedFunctions = Object.keys(previousRepository).filter((key) =>
    typeof previousRepository[key] === 'function' && typeof currentRepository[key] === 'function'
  );
  const structure = {
    removedExports: Object.keys(previousRepository).filter((key) => !(key in currentRepository)),
    addedExports: Object.keys(currentRepository).filter((key) => !(key in previousRepository)),
    retainedFunctionCount: retainedFunctions.length,
    changedRetainedFunctions: retainedFunctions.filter((key) =>
      previousRepository[key].toString() !== currentRepository[key].toString()
    ),
    selectSqlEqual: previousRepository.buildSelectOnlyChunkSql() === currentRepository.buildSelectOnlyChunkSql(),
    partColumnsEqual: JSON.stringify(previousRepository.MULTIWORKER_PART_COLUMNS) === JSON.stringify(currentRepository.MULTIWORKER_PART_COLUMNS),
    targetColumnsEqual: JSON.stringify(previousRepository.MULTIWORKER_TARGET_COLUMNS) === JSON.stringify(currentRepository.MULTIWORKER_TARGET_COLUMNS),
  };
  assert.deepEqual(structure.removedExports, ['insertDiffRowsByJoinMultiWorker']);
  assert.deepEqual(structure.addedExports, ['buildMultiworkerPlan', 'cleanupFailedMultiworkerRun']);
  assert.deepEqual(structure.changedRetainedFunctions, []);
  assert.equal(structure.selectSqlEqual, true);
  assert.equal(structure.partColumnsEqual, true);
  assert.equal(structure.targetColumnsEqual, true);

  const parameterCases = [
    {}, { chunkSize: '2' }, { runId: -1 }, { runId: Infinity }, { monthKey: 123 },
    { dbPath: ' ', tempDir: ' ' }, { runId: 0 }, { runId: '1', monthKey: '' },
    { monthKey: '', chunkSize: 0 }, { chunkSize: 1.5, dbPath: '' },
    { chunkSize: Symbol('x') }, { dbPath: '', workerCount: 0 },
    { workerCount: '2', tempDir: '' }, { tempDir: 3 },
  ];
  const modes = ['success', 'progress', 'execute-error', 'COUNT', 'BEGIN', 'DELETE', 'COMMIT', 'ROLLBACK'];
  let compared = 0;
  for (const totalRows of [0, 5]) {
    for (const mode of modes) {
      for (const override of parameterCases) {
        const options = { ...valid, ...override };
        const oldObservation = await observe('old', options, totalRows, mode);
        const newObservation = await observe('new', options, totalRows, mode);
        assert.deepEqual(newObservation, oldObservation,
          `totalRows=${totalRows},mode=${mode},override=${Object.keys(override).join(',')}`);
        compared += 1;
      }
    }
  }
  console.log(JSON.stringify({
    recordedAt: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktree: root,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    sourceSha256: {
      headRepository: sha256(oldSource),
      currentRepository: sha256(fs.readFileSync(repositoryPath)),
      currentService: sha256(fs.readFileSync(servicePath)),
      currentSession: sha256(fs.readFileSync(path.join(root, 'src/main-process/acquiring-bill-currency-session.js'))),
    },
    structure,
    matrix: { totalRows: [0, 5], modes, parameterCaseCount: parameterCases.length },
    differentialCases: compared,
    result: 'all equivalent',
    comparedObservations: [
      '参数验证错误优先级/name/message/code',
      'COUNT/DELETE/BEGIN/COMMIT/ROLLBACK调用序列',
      'executor计划字段、chunk参数与调用次数',
      'progress结构及回调异常吞吐',
      '返回摘要与执行主异常对象身份',
    ],
    scope: '受控 executor/DB 的旧新差分；真实 worker/SQLite/XLSX 集成和 Main 锁问题另行验证',
  }, null, 2));
  console.log(`${compared}/${compared} PASS`);
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
