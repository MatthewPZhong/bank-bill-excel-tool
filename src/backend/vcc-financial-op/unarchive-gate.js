'use strict';

const { ARCHIVE_CONTRACTS } = require('./archive-contract');

const UNARCHIVE_GATE_VERSION = 2;

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

// v3.2.17 级联解归档：只有“后续月份存在已归档或已计算结果”这一项改为可执行（cascade），
// 归档不一致、有活动任务、目标月导入中仍按原顺序阻断。旧写路径继续使用 evaluateUnarchiveGate。
function evaluateCascadeUnarchiveGate(contractResult, gateEvidence) {
  const gate = evaluateUnarchiveGate(contractResult, gateEvidence);
  if (gate.code !== 'unarchive-not-tail') return Object.freeze({ ...gate, cascade: false });
  return Object.freeze({
    canUnarchive: true,
    cascade: true,
    code: '',
    message: '',
    dependentMonths: gate.dependentMonths
  });
}

module.exports = {
  UNARCHIVE_GATE_VERSION,
  evaluateUnarchiveGate,
  evaluateCascadeUnarchiveGate
};
