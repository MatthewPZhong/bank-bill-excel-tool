'use strict';

const { parseMptFile } = require('../mpt-parser');
const { buildHeaderIdentity, spoolError } = require('./spool-contract');

const INVALID_ROW_DISPOSITIONS = Object.freeze({
  ERROR: 'error',
  EXCLUDED: 'excluded'
});

function normalizeInvalidRowDisposition(value) {
  const disposition = value == null ? INVALID_ROW_DISPOSITIONS.ERROR : String(value);
  if (!Object.values(INVALID_ROW_DISPOSITIONS).includes(disposition)) {
    throw new TypeError('invalidRowDisposition必须是error或excluded');
  }
  return disposition;
}

function assertNotCancelled(signal) {
  if (signal && signal.aborted) {
    throw spoolError('PREFUND_PARSER_CANCELLED', 'MPT Parser Core已取消');
  }
}

/**
 * 只读 Parser Core：复用现有 MPT parser 的文件、表头、日期、金额与 fingerprint 规则，
 * 只输出候选，不查询或修改数据库，也不判断 noop/replacement/repair token。
 */
async function parseMptCandidates(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Parser Core input必须是对象');
  }
  const filePath = input.filePath;
  const invalidRowDisposition = normalizeInvalidRowDisposition(input.invalidRowDisposition);
  const onHeader = typeof options.onHeader === 'function' ? options.onHeader : null;
  const onCandidate = typeof options.onCandidate === 'function' ? options.onCandidate : null;
  const signal = options.signal || null;
  let header = null;
  let errorRowCount = 0;
  let excludedRowCount = 0;

  assertNotCancelled(signal);
  const parsed = await parseMptFile(filePath, {
    batchSize: input.batchSize,
    collectRowErrors: true,
    rowErrorSampleLimit: input.rowErrorSampleLimit,
    async onHeader(value) {
      assertNotCancelled(signal);
      header = Object.freeze({ ...value, headerIdentity: buildHeaderIdentity(value) });
      if (onHeader) await onHeader(header);
    },
    async onRows(rows) {
      for (const row of rows) {
        assertNotCancelled(signal);
        if (onCandidate) await onCandidate(Object.freeze({ kind: 'valid', row }));
      }
    },
    async onRowError(issue) {
      assertNotCancelled(signal);
      if (invalidRowDisposition === INVALID_ROW_DISPOSITIONS.EXCLUDED) excludedRowCount += 1;
      else errorRowCount += 1;
      if (onCandidate) {
        await onCandidate(Object.freeze({
          kind: invalidRowDisposition,
          issue
        }));
      }
    }
  });
  assertNotCancelled(signal);
  return Object.freeze({
    sourceType: parsed.sourceType,
    sourceBatch: parsed.sourceBatch,
    sourceDate: parsed.sourceDate,
    sourceFileName: parsed.sourceFileName,
    sourceFileSequence: parsed.sourceFileSequence,
    monthKey: parsed.monthKey,
    declaredRowCount: parsed.declaredRowCount,
    parsedRowCount: parsed.parsedRowCount,
    validRowCount: parsed.validRowCount,
    errorRowCount,
    excludedRowCount,
    contentHash: parsed.contentHash,
    headerIdentity: header ? header.headerIdentity : buildHeaderIdentity(parsed)
  });
}

module.exports = {
  INVALID_ROW_DISPOSITIONS,
  parseMptCandidates
};
