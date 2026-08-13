'use strict';

const { ARCHIVE_CONTRACTS } = require('./archive-contract');

const UNARCHIVE_GATE_VERSION = 1;

function dependentMonths(gateEvidence) {
  return [...new Set(gateEvidence.laterDependencies.map((item) => String(item.targetMonth)))].sort();
}

function evaluateUnarchiveGate(contractResult, gateEvidence) {
  const months = dependentMonths(gateEvidence);
  if (contractResult.contract === ARCHIVE_CONTRACTS.INCONSISTENT) {
    return Object.freeze({
      canUnarchive: false,
      code: 'archive-state-inconsistent',
      message: '归档结构不一致，禁止解归档。',
      dependentMonths: Object.freeze(months)
    });
  }
  if (
    gateEvidence.taskActive
    || gateEvidence.activeBatchIds.length > 0
    || gateEvidence.importingRecordIds.length > 0
  ) {
    return Object.freeze({
      canUnarchive: false,
      code: 'active-vcc-task',
      message: '已有 VCC 财务OP任务正在运行，请完成后重试。',
      dependentMonths: Object.freeze(months)
    });
  }
  if (gateEvidence.unresolvedRecords.length > 0) {
    return Object.freeze({
      canUnarchive: false,
      code: 'unresolved-imports',
      message: '当前账期仍有未处理的导入异常，禁止解归档。',
      dependentMonths: Object.freeze(months)
    });
  }
  if (months.length > 0) {
    return Object.freeze({
      canUnarchive: false,
      code: 'unarchive-not-tail',
      message: `该月之后仍存在已归档或已计算月份：${months.join('、')}，请从最新月份开始处理。`,
      dependentMonths: Object.freeze(months)
    });
  }
  return Object.freeze({
    canUnarchive: true,
    code: '',
    message: '',
    dependentMonths: Object.freeze([])
  });
}

module.exports = {
  UNARCHIVE_GATE_VERSION,
  evaluateUnarchiveGate
};
