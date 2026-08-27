'use strict';

const fs = require('node:fs');

const {
  DUPLICATE_INPUT_ROLES,
  DUPLICATE_SPOOL_SCHEMA_VERSION,
  duplicateSpoolPaths,
  normalizeSpoolDescriptor,
  spoolError
} = require('./spool-contract');
const {
  ensurePrivateSpoolDirectory,
  validatePrivateSpoolDirectory
} = require('./spool-filesystem');

function safeCauseCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'DUPLICATE_PARSER_FAILED';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(code)
    ? code
    : 'DUPLICATE_PARSER_FAILED';
}

function terminalPayload(descriptor, terminal) {
  const base = {
    schemaVersion: DUPLICATE_SPOOL_SCHEMA_VERSION,
    jobId: descriptor.jobId,
    operationKey: descriptor.operationKey,
    producerTaskRunId: descriptor.producerTaskRunId,
    slotIndex: descriptor.slotIndex,
    unitId: descriptor.unitId
  };
  if (terminal && terminal.status === 'succeeded' &&
      Object.values(DUPLICATE_INPUT_ROLES).includes(terminal.role) &&
      Number.isSafeInteger(terminal.rowCount) && terminal.rowCount >= 0) {
    return Object.freeze({
      ...base,
      status: 'succeeded',
      role: terminal.role,
      rowCount: terminal.rowCount
    });
  }
  if (terminal && terminal.status === 'failed') {
    return Object.freeze({
      ...base,
      status: 'failed',
      causeCode: safeCauseCode(terminal.error)
    });
  }
  throw spoolError('DUPLICATE_PARSER_OUTCOME_INVALID', 'Parser terminal outcome参数非法');
}

function writeDuplicateParserOutcome(rawDescriptor, terminal) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = duplicateSpoolPaths(descriptor);
  ensurePrivateSpoolDirectory(paths, { requireEmpty: false });
  try {
    const existing = fs.lstatSync(paths.outcomeReady);
    if (existing.isFile() && !existing.isSymbolicLink()) {
      const recorded = readDuplicateParserOutcome(descriptor);
      const proposed = terminalPayload(descriptor, terminal);
      if (JSON.stringify(recorded) === JSON.stringify(proposed)) return paths.outcomeReady;
      throw spoolError(
        'DUPLICATE_PARSER_OUTCOME_CONFLICT',
        'Parser terminal outcome已经以不同结果发布'
      );
    }
    throw spoolError('DUPLICATE_PARSER_OUTCOME_INVALID', 'Parser outcome不是普通文件');
  } catch (statError) {
    if (!statError || statError.code !== 'ENOENT') throw statError;
  }
  const outcome = terminalPayload(descriptor, terminal);
  let fd;
  try {
    fd = fs.openSync(paths.outcomePart, 'wx', 0o600);
    fs.writeFileSync(fd, Buffer.from(`${JSON.stringify(outcome)}\n`, 'utf8'));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(paths.outcomePart, paths.outcomeReady);
    // outcome只服务当前进程的pre-critical barrier，不是跨重启durable evidence；
    // rename后的可见文件即为权威，避免目录fsync失败制造已发布/回包歧义。
    return paths.outcomeReady;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_error) { /* original wins */ }
    }
    try { fs.rmSync(paths.outcomePart, { force: true }); } catch (_error) { /* best effort */ }
  }
}

function readDuplicateParserOutcome(rawDescriptor) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = duplicateSpoolPaths(descriptor);
  let stat;
  try { stat = fs.lstatSync(paths.outcomeReady); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  validatePrivateSpoolDirectory(descriptor);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024) {
    throw spoolError('DUPLICATE_PARSER_OUTCOME_INVALID', 'Parser outcome缺失、过大或不是普通文件');
  }
  let outcome;
  try { outcome = JSON.parse(fs.readFileSync(paths.outcomeReady, 'utf8')); } catch (_error) {
    throw spoolError('DUPLICATE_PARSER_OUTCOME_INVALID', 'Parser outcome不是合法JSON');
  }
  const baseKeys = [
    'jobId', 'operationKey', 'producerTaskRunId', 'schemaVersion', 'slotIndex', 'status', 'unitId'
  ];
  const expectedKeys = outcome && outcome.status === 'succeeded'
    ? [...baseKeys, 'role', 'rowCount']
    : [...baseKeys, 'causeCode'];
  const keys = Object.keys(outcome || {}).sort().join(',');
  if (keys !== expectedKeys.sort().join(',') ||
      outcome.schemaVersion !== DUPLICATE_SPOOL_SCHEMA_VERSION ||
      outcome.jobId !== descriptor.jobId || outcome.operationKey !== descriptor.operationKey ||
      outcome.producerTaskRunId !== descriptor.producerTaskRunId ||
      outcome.slotIndex !== descriptor.slotIndex || outcome.unitId !== descriptor.unitId ||
      !['succeeded', 'failed'].includes(outcome.status) ||
      (outcome.status === 'succeeded' &&
        (!Object.values(DUPLICATE_INPUT_ROLES).includes(outcome.role) ||
         !Number.isSafeInteger(outcome.rowCount) || outcome.rowCount < 0)) ||
      (outcome.status === 'failed' &&
        (typeof outcome.causeCode !== 'string' ||
         !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(outcome.causeCode)))) {
    throw spoolError('DUPLICATE_PARSER_OUTCOME_INVALID', 'Parser outcome identity非法');
  }
  return Object.freeze(outcome);
}

function writeDuplicateParserFailure(rawDescriptor, error) {
  return writeDuplicateParserOutcome(rawDescriptor, { status: 'failed', error });
}

function writeDuplicateParserSuccess(rawDescriptor, result) {
  return writeDuplicateParserOutcome(rawDescriptor, {
    status: 'succeeded',
    role: result && result.role,
    rowCount: result && result.rowCount
  });
}

function readDuplicateParserFailure(rawDescriptor) {
  const outcome = readDuplicateParserOutcome(rawDescriptor);
  return outcome && outcome.status === 'failed' ? outcome : null;
}

module.exports = {
  readDuplicateParserFailure,
  readDuplicateParserOutcome,
  writeDuplicateParserFailure,
  writeDuplicateParserSuccess
};
