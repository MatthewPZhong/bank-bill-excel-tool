'use strict';

const PRE_FUND_MPT_IMPORT_ACTION = 'pre-fund:mpt-import';
const PRE_FUND_MPT_REPAIR_ACTION = 'pre-fund:mpt-repair-import';
const MAX_IMPORT_PARSER_COUNT = 4;
const MEBIBYTE = 1024 * 1024;

const IMPORT_BASE_RESOURCES = Object.freeze({
  cpuSlots: 0,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 0,
  memoryBytes: 32 * MEBIBYTE
});
const IMPORT_WRITER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 256 * MEBIBYTE
});
const PARSER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 256 * MEBIBYTE
});
const REPAIR_WRITER_RESOURCES = Object.freeze({
  cpuSlots: 1,
  workerThreadSlots: 1,
  utilityProcessSlots: 0,
  ioHeavySlots: 1,
  memoryBytes: 192 * MEBIBYTE
});

function topologyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizePositiveCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw topologyError('PREFUND_TOPOLOGY_INPUT_INVALID', `${name}必须是正安全整数`);
  }
  return value;
}

function normalizeAvailableParallelism(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function normalizeTotalMemoryBytes(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 768 * MEBIBYTE;
}

function resourceTotalForChildren(root, child, count, field) {
  const value = BigInt(root[field]) + BigInt(child[field]) * BigInt(count);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.POSITIVE_INFINITY;
}

function maximumChildrenWithinBudget({ budgets, base, phase, childResource, maximum }) {
  const fields = ['cpuSlots', 'workerThreadSlots', 'utilityProcessSlots', 'ioHeavySlots', 'memoryBytes'];
  const root = Object.fromEntries(fields.map((field) => [field, base[field] + phase[field]]));
  for (let count = maximum; count >= 1; count -= 1) {
    if (fields.every((field) => resourceTotalForChildren(root, childResource, count, field) <= budgets[field])) {
      return count;
    }
  }
  return 0;
}

function createPreFundMptRuntimeResourcePlan(options = {}) {
  const availableParallelism = normalizeAvailableParallelism(options.availableParallelism);
  const totalMemoryBytes = normalizeTotalMemoryBytes(options.totalMemoryBytes);
  const memoryBytes = Math.max(768 * MEBIBYTE, Math.floor(totalMemoryBytes / 4));
  const cpuSafeParserCount = Math.min(MAX_IMPORT_PARSER_COUNT, Math.max(1, availableParallelism - 1));
  const provisionalBudgets = Object.freeze({
    cpuSlots: 1 + cpuSafeParserCount,
    workerThreadSlots: 2 + cpuSafeParserCount,
    utilityProcessSlots: 0,
    ioHeavySlots: 1 + cpuSafeParserCount,
    memoryBytes
  });
  const hostSafeParserCount = maximumChildrenWithinBudget({
    budgets: provisionalBudgets,
    base: IMPORT_BASE_RESOURCES,
    phase: IMPORT_WRITER_RESOURCES,
    childResource: PARSER_RESOURCES,
    maximum: cpuSafeParserCount
  });
  if (hostSafeParserCount < 1) {
    throw topologyError('PREFUND_TOPOLOGY_BUDGET_INVALID', 'runtime预算无法容纳Writer与一个Parser');
  }
  const budgets = Object.freeze({
    cpuSlots: 1 + hostSafeParserCount,
    workerThreadSlots: 2 + hostSafeParserCount,
    utilityProcessSlots: 0,
    ioHeavySlots: 1 + hostSafeParserCount,
    memoryBytes
  });
  return Object.freeze({ budgets, hostSafeParserCount });
}

function createPreFundMptTopologyPlanner(options = {}) {
  const runtimeResourcePlan = options.runtimeResourcePlan;
  if (!runtimeResourcePlan || !runtimeResourcePlan.budgets ||
      !Number.isSafeInteger(runtimeResourcePlan.hostSafeParserCount)) {
    throw new TypeError('PreFund topology planner需要冻结runtime resource plan');
  }
  const hostSafeParserCount = runtimeResourcePlan.hostSafeParserCount;
  return function planPreFundMptTopology(request) {
    if (!request || !request.input ||
        ![PRE_FUND_MPT_IMPORT_ACTION, PRE_FUND_MPT_REPAIR_ACTION].includes(request.actionKey)) {
      throw topologyError('PREFUND_TOPOLOGY_INPUT_INVALID', 'PreFund topology请求非法');
    }
    const fileCount = normalizePositiveCount(request.input.fileCount, 'input.fileCount');
    const unitCount = normalizePositiveCount(request.unitCount, 'unitCount');
    if (fileCount !== unitCount) {
      throw topologyError(
        'PREFUND_TOPOLOGY_UNIT_COUNT_MISMATCH',
        'PreFund topology的fileCount必须与预注册unitCount一致'
      );
    }
    if (request.actionKey === PRE_FUND_MPT_REPAIR_ACTION) {
      return Object.freeze({ effectiveChildCount: 1 });
    }
    const fileSafeParserCount = Math.max(1, Math.floor(unitCount / 2));
    return Object.freeze({
      effectiveChildCount: Math.min(MAX_IMPORT_PARSER_COUNT, fileSafeParserCount, hostSafeParserCount)
    });
  };
}

module.exports = {
  IMPORT_BASE_RESOURCES,
  IMPORT_WRITER_RESOURCES,
  MAX_IMPORT_PARSER_COUNT,
  PARSER_RESOURCES,
  REPAIR_WRITER_RESOURCES,
  createPreFundMptRuntimeResourcePlan,
  createPreFundMptTopologyPlanner,
  maximumChildrenWithinBudget
};
