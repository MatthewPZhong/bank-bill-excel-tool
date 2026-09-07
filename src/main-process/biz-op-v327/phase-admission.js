'use strict';

const { fitsWithin, validateResourceVector } = require('../background-execution/resource-lease');

const BIZ_OP_RESOURCE_WAIT_MS = 5000;

function capacityError(code, request, snapshot, cause) {
  const insufficient = code === 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT';
  const error = new Error(insufficient
    ? '业务 OP 所需资源超过本次应用的资源预算，请释放内存后重新启动应用'
    : '业务 OP 等待后台资源超过 5 秒，请等待其他任务结束后重试', { cause });
  error.code = code;
  const mib = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  error.detailLines = [
    `动作：${request.actionKey}`,
    `内存：需要 ${mib(request.resources.memoryBytes)}，本次预算 ${mib(snapshot.budgets.memoryBytes)}，当前剩余 ${mib(snapshot.available.memoryBytes)}`,
    `CPU / Worker / I/O 槽位：需要 ${request.resources.cpuSlots} / ${request.resources.workerThreadSlots} / ${request.resources.ioHeavySlots}，本次预算 ${snapshot.budgets.cpuSlots} / ${snapshot.budgets.workerThreadSlots} / ${snapshot.budgets.ioHeavySlots}`,
    '本阶段尚未开始执行；未完成的任务和恢复记录继续保留。'
  ];
  return error;
}

async function acquireBizOpPhaseLease(runtime, request) {
  const governor = runtime.resourceGovernor;
  const resources = validateResourceVector(request.resources);
  const snapshot = governor.snapshot();
  // 固定总预算无法容纳时，释放其它 lease 也无法准入，不能无限排队。
  // 关闭/取消仍交给原 governor，以保留其取消语义和错误类型。
  if (snapshot.accepting && !request.signal?.aborted && !fitsWithin(resources, snapshot.budgets)) {
    throw capacityError('BIZOP_RESOURCE_BUDGET_INSUFFICIENT', request, snapshot);
  }
  try {
    return await governor.acquirePhaseLease({ ...request, resources, timeoutMs: BIZ_OP_RESOURCE_WAIT_MS });
  } catch (error) {
    if (error.code !== 'ADMISSION_TIMEOUT') throw error;
    // 仅限制准入队列；lease 交付后继续等待实际工作及载体退出，不能提前释放。
    throw capacityError('BIZOP_RESOURCE_WAIT_TIMEOUT', request, governor.snapshot(), error);
  }
}

module.exports = { acquireBizOpPhaseLease, BIZ_OP_RESOURCE_WAIT_MS };
