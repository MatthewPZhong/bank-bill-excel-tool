'use strict';
const { createHash } = require('node:crypto');
const { preflightCalculation } = require('./calculator');
const { getEffectiveRunResult } = require('./result-adjustments');
const { classifyNumericOutput, decimalComparable } = require('../toolbox-format/number-date');
const { assertExcelCellTextLength } = require('../toolbox-format/excel-text');

function reviewError(code, message, detailLines = []) { return Object.assign(new Error(message), { code, detailLines }); }
function validateReviewRequest(request) {
  if (!request || Object.keys(request).some((key) => !['runId', 'expectedResultRevision', 'expectedInputFingerprint'].includes(key))
      || !Number.isSafeInteger(request.runId) || request.runId < 1
      || !Number.isSafeInteger(request.expectedResultRevision) || request.expectedResultRevision < 0
      || typeof request.expectedInputFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedInputFingerprint)) {
    throw reviewError('vcc-review-request-invalid', '待确认表请求无效，请刷新确认页');
  }
  return Object.freeze({ ...request });
}
function assertReviewFresh(db, request, { effective = false } = {}) {
  validateReviewRequest(request);
  const run = db.prepare('SELECT * FROM vcc_fin_op_runs WHERE id = ?').get(request.runId);
  if (!run || run.status !== 'calculated') throw reviewError('state-changed', '结果已删除或归档，请刷新确认页');
  if (Number(run.result_revision) !== request.expectedResultRevision) throw reviewError('result-revision-changed', '结果已调整，请重新核对后导出');
  const input = preflightCalculation(db, run.target_month);
  if (run.input_fingerprint !== request.expectedInputFingerprint || input.inputFingerprint !== run.input_fingerprint
      || JSON.stringify(input.revisions) !== run.input_revisions_json || !input.ok) {
    throw reviewError('state-changed', '计算输入已变化，请重新计算或核对后导出');
  }
  return effective ? getEffectiveRunResult(db, request.runId) : run;
}
function framedDigest() {
  const hash = createHash('sha256').update('vcc-review-manifest-v1\0');
  return { add(value) { const data = Buffer.from(JSON.stringify(value), 'utf8'); const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length); hash.update(size).update(data); }, finish() { return hash.digest('hex'); } };
}
function textCell(value) {
  const text = String(value ?? ''); assertExcelCellTextLength(text);
  return { t: 'text', v: text, f: '@' };
}
function projectionCell(cell) {
  if (cell.kind !== 'amount' || cell.display === '-') return textCell(cell.display);
  const classified = classifyNumericOutput(cell.value);
  const fraction = cell.value.includes('.') ? cell.value.split('.')[1].length : 0;
  if (classified.outputType !== 'number' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cell.value)
      || (cell.value.startsWith('-') && Number(cell.value) === 0)) return { ...textCell(cell.display), semantic: cell.value };
  return { t: 'number', v: cell.value, f: `#,##0${fraction ? `.${'0'.repeat(fraction)}` : ''}`, semantic: cell.value };
}
function rawCell(cell, header = '') {
  if (cell?.hasFormula && cell.decodedSemanticValue == null) throw reviewError('vcc-review-source-unavailable', '原始公式缺少可核验缓存值');
  if (!cell || cell.cellType === 'blank') return { t: 'null', v: null, f: 'General' };
  if (cell.cellType === 'number') {
    const token = String(cell.rawLexicalValue);
    // IDs are text at the output boundary even when a historic source stored a number.
    if (/(?:id$|编号|单号|卡号|账号|批次号|节点ID|MID$)/i.test(header)) return textCell(token);
    const classified = classifyNumericOutput(token, cell.sourceFormat || 'General');
    return classified.outputType === 'number'
      ? { t: 'number', v: token, f: cell.sourceFormat && cell.sourceFormat !== 'General' ? cell.sourceFormat : classified.numFmt || 'General' }
      : { ...textCell(token), losslessNumericText: true };
  }
  if (cell.cellType === 'boolean') return { t: 'boolean', v: cell.rawLexicalValue === '1' || cell.decodedSemanticValue === true, f: 'General' };
  return textCell(cell.cellType === 'date' ? cell.rawLexicalValue : cell.decodedSemanticValue ?? cell.rawLexicalValue ?? '');
}
function historicCell(value) {
  if (value === null || value === undefined) return { t: 'null', v: null, f: 'General' };
  if (typeof value === 'number') return rawCell({ cellType: 'number', rawLexicalValue: String(value) });
  if (typeof value === 'boolean') return { t: 'boolean', v: value, f: 'General' };
  if (typeof value !== 'string') throw reviewError('vcc-review-source-unavailable', '历史原始值类型无法验证');
  return textCell(value);
}
function comparableCell(cell) {
  return { t: cell.t, v: cell.t === 'number' ? decimalComparable(cell.v) : cell.v, f: cell.f };
}

module.exports = { reviewError, validateReviewRequest, assertReviewFresh, framedDigest,
  projectionCell, rawCell, historicCell, textCell, comparableCell };
