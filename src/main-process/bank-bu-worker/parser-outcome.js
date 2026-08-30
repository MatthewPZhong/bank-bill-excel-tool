'use strict';

const fs = require('node:fs');

const {
  BANK_BU_INPUT_ROLES,
  BANK_BU_SPOOL_SCHEMA_VERSION,
  bankBuSpoolPaths,
  normalizeSpoolDescriptor,
  spoolError
} = require('./spool-contract');
const {
  ensurePrivateSpoolDirectory,
  validatePrivateSpoolDirectory
} = require('./spool-filesystem');

function safeCauseCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'BANK_BU_PARSER_FAILED';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(code) ? code : 'BANK_BU_PARSER_FAILED';
}

function terminalPayload(descriptor, terminal) {
  const base = {
    schemaVersion: BANK_BU_SPOOL_SCHEMA_VERSION,
    jobId: descriptor.jobId,
    operationKey: descriptor.operationKey,
    producerTaskRunId: descriptor.producerTaskRunId,
    yearMonth: descriptor.yearMonth,
    role: descriptor.role
  };
  if (terminal && terminal.status === 'succeeded' && terminal.role === descriptor.role &&
      Number.isSafeInteger(terminal.rowCount) && terminal.rowCount >= 0) {
    return Object.freeze({ ...base, status: 'succeeded', rowCount: terminal.rowCount });
  }
  if (terminal && terminal.status === 'failed') {
    return Object.freeze({ ...base, status: 'failed', causeCode: safeCauseCode(terminal.error) });
  }
  throw spoolError('BANK_BU_PARSER_OUTCOME_INVALID', 'BankBU Parser terminal outcome参数非法');
}

function writeBankBuParserOutcome(rawDescriptor, terminal) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = bankBuSpoolPaths(descriptor);
  ensurePrivateSpoolDirectory(paths, { requireEmpty: false });
  const proposed = terminalPayload(descriptor, terminal);
  try {
    const existing = fs.lstatSync(paths.outcomeReady);
    if (!existing.isSymbolicLink() && existing.isFile()) {
      const recorded = readBankBuParserOutcome(descriptor);
      if (JSON.stringify(recorded) === JSON.stringify(proposed)) return paths.outcomeReady;
      throw spoolError('BANK_BU_PARSER_OUTCOME_CONFLICT', 'BankBU Parser outcome冲突');
    }
    throw spoolError('BANK_BU_PARSER_OUTCOME_INVALID', 'BankBU Parser outcome不是普通文件');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  let fd;
  try {
    fd = fs.openSync(paths.outcomePart, 'wx', 0o600);
    fs.writeFileSync(fd, Buffer.from(`${JSON.stringify(proposed)}\n`, 'utf8'));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(paths.outcomePart, paths.outcomeReady);
    return paths.outcomeReady;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_error) { /* original wins */ }
    }
    try { fs.rmSync(paths.outcomePart, { force: true }); } catch (_error) { /* best effort */ }
  }
}

function readBankBuParserOutcome(rawDescriptor) {
  const descriptor = normalizeSpoolDescriptor(rawDescriptor);
  const paths = bankBuSpoolPaths(descriptor);
  let stat;
  try { stat = fs.lstatSync(paths.outcomeReady); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  validatePrivateSpoolDirectory(descriptor);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024) {
    throw spoolError('BANK_BU_PARSER_OUTCOME_INVALID', 'BankBU Parser outcome非法');
  }
  let outcome;
  try { outcome = JSON.parse(fs.readFileSync(paths.outcomeReady, 'utf8')); } catch (_error) {
    throw spoolError('BANK_BU_PARSER_OUTCOME_INVALID', 'BankBU Parser outcome不是合法JSON');
  }
  const baseKeys = [
    'jobId', 'operationKey', 'producerTaskRunId', 'role', 'schemaVersion', 'status', 'yearMonth'
  ];
  const expectedKeys = outcome && outcome.status === 'succeeded'
    ? [...baseKeys, 'rowCount']
    : [...baseKeys, 'causeCode'];
  if (!outcome || Object.keys(outcome).sort().join(',') !== expectedKeys.sort().join(',') ||
      outcome.schemaVersion !== BANK_BU_SPOOL_SCHEMA_VERSION ||
      outcome.jobId !== descriptor.jobId || outcome.operationKey !== descriptor.operationKey ||
      outcome.producerTaskRunId !== descriptor.producerTaskRunId ||
      outcome.yearMonth !== descriptor.yearMonth || outcome.role !== descriptor.role ||
      !Object.values(BANK_BU_INPUT_ROLES).includes(outcome.role) ||
      !['succeeded', 'failed'].includes(outcome.status) ||
      (outcome.status === 'succeeded' &&
        (!Number.isSafeInteger(outcome.rowCount) || outcome.rowCount < 0)) ||
      (outcome.status === 'failed' &&
        (typeof outcome.causeCode !== 'string' ||
         !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(outcome.causeCode)))) {
    throw spoolError('BANK_BU_PARSER_OUTCOME_INVALID', 'BankBU Parser outcome identity非法');
  }
  return Object.freeze(outcome);
}

function writeBankBuParserFailure(descriptor, error) {
  return writeBankBuParserOutcome(descriptor, { status: 'failed', error });
}

function writeBankBuParserSuccess(descriptor, result) {
  return writeBankBuParserOutcome(descriptor, {
    status: 'succeeded', role: result && result.role, rowCount: result && result.rowCount
  });
}

module.exports = {
  readBankBuParserOutcome,
  writeBankBuParserFailure,
  writeBankBuParserSuccess
};
