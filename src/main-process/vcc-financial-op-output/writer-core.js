'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { openVccReadDatabase } = require('../../backend/vcc-financial-op/read-schema');
const { writeRunWorkbooks } = require('../vcc-financial-op-writer');
const {
  assertVccExportAuthorityEqual,
  readVccExportSnapshot
} = require('./authority');
const {
  VCC_EXPORT_SINGLE_ACTION,
  VCC_EXPORT_SUBJECTS_ACTION,
  VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS
} = require('./policies');

function writerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw writerError('VCC_EXPORT_WRITER_INPUT_INVALID', `${label} exact keys 非法`);
  }
}

function normalizeWriterInput(value, actionKey) {
  exactKeys(value, [
    'assetsDir', 'authority', 'contractVersion', 'databasePath', 'generations', 'task'
  ], 'writer input');
  if (value.contractVersion !== 1 || typeof value.databasePath !== 'string' ||
      typeof value.assetsDir !== 'string') {
    throw writerError('VCC_EXPORT_WRITER_INPUT_INVALID', 'writer input version/path 非法');
  }
  exactKeys(value.task, ['action', 'taskGeneration', 'taskRunId'], 'writer task');
  if (value.task.action !== 'export-result' ||
      !Number.isSafeInteger(value.task.taskGeneration) || value.task.taskGeneration < 0 ||
      typeof value.task.taskRunId !== 'string' || !value.task.taskRunId) {
    throw writerError('VCC_EXPORT_WRITER_INPUT_INVALID', 'writer task authority 非法');
  }
  if (![VCC_EXPORT_SINGLE_ACTION, VCC_EXPORT_SUBJECTS_ACTION].includes(actionKey)) {
    throw writerError('VCC_EXPORT_WRITER_INPUT_INVALID', 'writer actionKey 非法');
  }
  const subjects = value.authority && value.authority.subjects;
  if (!Array.isArray(subjects) || !Array.isArray(value.generations) ||
      subjects.length < 1 || subjects.length > VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS ||
      value.generations.length < 1 ||
      (actionKey === VCC_EXPORT_SINGLE_ACTION && value.generations.length !== 1) ||
      (actionKey === VCC_EXPORT_SUBJECTS_ACTION && value.generations.length !== subjects.length)) {
    throw writerError('VCC_EXPORT_WRITER_INPUT_INVALID', 'writer subject/generation set 非法');
  }
  const keys = new Set();
  const paths = new Set();
  const generations = value.generations.map((item, index) => {
    exactKeys(item, ['generationPath', 'outputArtifactKey', 'subjectIndex'], `generations[${index}]`);
    if (!Number.isSafeInteger(item.subjectIndex) || item.subjectIndex < 0 ||
        item.subjectIndex >= subjects.length ||
        (actionKey === VCC_EXPORT_SUBJECTS_ACTION && item.subjectIndex !== index) ||
        typeof item.outputArtifactKey !== 'string' ||
        !/^output-[a-f0-9]{64}$/.test(item.outputArtifactKey) ||
        keys.has(item.outputArtifactKey) || typeof item.generationPath !== 'string' ||
        paths.has(item.generationPath)) {
      throw writerError('VCC_EXPORT_WRITER_INPUT_INVALID', `generations[${index}] identity 非法`);
    }
    keys.add(item.outputArtifactKey);
    paths.add(item.generationPath);
    return Object.freeze({ ...item });
  });
  return Object.freeze({
    contractVersion: 1,
    databasePath: value.databasePath,
    assetsDir: value.assetsDir,
    authority: value.authority,
    task: Object.freeze({ ...value.task }),
    actionKey,
    generations: Object.freeze(generations)
  });
}

function cancelledError() {
  return writerError('VCC_EXPORT_CANCELLED', 'VCC export Writer 已取消');
}

function throwIfCancelled(signal) {
  if (signal && signal.aborted) throw cancelledError();
}

async function hashRegularFile(filePath) {
  const stat = await fs.promises.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1) {
    throw writerError('VCC_EXPORT_ARTIFACT_INVALID', 'VCC export generation 不是普通非空文件');
  }
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return Object.freeze({ byteSize: Number(stat.size), sha256: hash.digest('hex') });
}

async function executeVccExportWriter(rawInput, signal, actionKey = VCC_EXPORT_SUBJECTS_ACTION) {
  const input = normalizeWriterInput(rawInput, actionKey);
  const db = openVccReadDatabase(input.databasePath);
  const generationPaths = input.generations.map((item) => item.generationPath);
  let transactionOpen = false;
  try {
    throwIfCancelled(signal);
    db.exec('BEGIN DEFERRED');
    transactionOpen = true;
    const start = readVccExportSnapshot(db, {
      runId: input.authority.runId,
      targetMonth: input.authority.targetMonth
    });
    assertVccExportAuthorityEqual(input.authority, start.authority);
    const written = await writeRunWorkbooks({
      db,
      runId: input.authority.runId,
      outputPaths: generationPaths,
      assetsDir: input.assetsDir,
      abortSignal: signal,
      cleanupOnFailure: true,
      subjectIndexes: input.generations.map((item) => item.subjectIndex)
    });
    const expectedSubjects = input.generations.map((item) => start.data.subjects[item.subjectIndex]);
    if (JSON.stringify(written.subjects) !== JSON.stringify(expectedSubjects) ||
        JSON.stringify(written.filePaths) !== JSON.stringify(generationPaths)) {
      throw writerError('VCC_EXPORT_WRITER_RESULT_INVALID', 'Writer output set/order 与 authority 不一致');
    }
    throwIfCancelled(signal);
    const end = readVccExportSnapshot(db, {
      runId: input.authority.runId,
      targetMonth: input.authority.targetMonth
    });
    assertVccExportAuthorityEqual(input.authority, end.authority);
    const artifacts = [];
    for (let index = 0; index < input.generations.length; index += 1) {
      throwIfCancelled(signal);
      // eslint-disable-next-line no-await-in-loop
      const file = await hashRegularFile(input.generations[index].generationPath);
      const subject = input.authority.subjects[input.generations[index].subjectIndex];
      artifacts.push(Object.freeze({
        subjectIndex: input.generations[index].subjectIndex,
        subjectDigest: subject.subjectDigest,
        outputArtifactKey: input.generations[index].outputArtifactKey,
        byteSize: file.byteSize,
        sha256: file.sha256,
        businessDigest: subject.businessDigest,
        resultRowCount: subject.resultRowCount,
        pendingRowCount: subject.pendingRowCount
      }));
    }
    db.exec('COMMIT');
    transactionOpen = false;
    return Object.freeze({
      contractVersion: 1,
      actionKey,
      runId: input.authority.runId,
      targetMonth: input.authority.targetMonth,
      resultRevision: input.authority.resultRevision,
      inputFingerprint: input.authority.inputFingerprint,
      archiveStateDigest: input.authority.archiveStateDigest,
      authorityDigest: input.authority.authorityDigest,
      task: input.task,
      artifacts: Object.freeze(artifacts),
      summary: Object.freeze({ subjectCount: artifacts.length, artifactCount: artifacts.length })
    });
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) { /* close below */ }
    }
    for (const filePath of generationPaths) {
      try { fs.rmSync(filePath, { force: true }); } catch (_cleanupError) { /* Main owns directory */ }
    }
    throw error;
  } finally {
    db.close();
  }
}

module.exports = {
  executeVccExportWriter,
  normalizeWriterInput
};
