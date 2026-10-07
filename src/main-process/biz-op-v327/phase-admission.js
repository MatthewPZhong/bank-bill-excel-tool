'use strict';

const os = require('node:os');
const { fitsWithin, validateResourceVector } = require('../background-execution/resource-lease');
const { inventoryForGovernor } = require('../memory-activity');

const BIZ_OP_RESOURCE_WAIT_MS = 5000;
const mib = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const MODE_LABELS = Object.freeze({ normal: '普通档', low: '低内存档' });
const REASON_LABELS = Object.freeze({
  'stable-limit': '超出稳定上限',
  'evaluation-busy': '内存判定重入',
  slots: '槽位或固定预算已占满',
  'memory-limit': '内存额度已占满',
  'low-mode-active': '有低内存档任务在执行',
  'heavy-active': '低内存档需要独占，但有其他重任务',
  'inventory-incomplete': '活动清单未封存或无效',
  'unbounded-growth': '存在增长未知的活动',
  'system-memory': '系统可用内存不足'
});

function reasonText({ reason, facts }) {
  const label = REASON_LABELS[reason] || `未记录原因（${reason || '无'}）`;
  if (reason === 'unbounded-growth' && facts) {
    return `${label}（未登记租约 ${facts.lease} / 载体 ${facts.carrier} / 主进程活动 ${facts.main} / 上一代 runtime ${facts.previousRuntime}${facts.other ? ` / 其他 ${facts.other}` : ''}）`;
  }
  if (reason === 'system-memory' && facts) return `${label}（判定时采样 ${mib(facts.availableBytes)}，需要 ${mib(facts.neededBytes)}）`;
  if (reason === 'memory-limit' && facts) {
    return `${label}（已用 ${mib(facts.usedBytes)} + 本次 ${mib(facts.requestBytes)} > 上限 ${mib(facts.limitBytes)}）`;
  }
  return label;
}

// 判定记录在调度器判定时采集，是判断阻塞原因的依据。
function decisionDetailLines(cause) {
  const decision = cause?.details?.decision;
  if (!decision) return [];
  if (!decision.attempts) return [`判定记录：等待期间一直没有轮到本申请（入队时前方 ${decision.queuedAhead} 项）`];
  const shown = decision.candidates.slice(0, 3);
  return [
    `判定记录：共判定 ${decision.attempts} 次，最后一次在第 ${(decision.lastElapsedMs / 1000).toFixed(1)} 秒，入队时前方 ${decision.queuedAhead} 项（上方“需要”是兼容请求额度，下面是实际候选）`,
    ...shown.map((item) => `· ${MODE_LABELS[item.mode] || '申请'} ${mib(item.memoryBytes)}：${reasonText(item)}`),
    ...(decision.candidates.length > shown.length ? [`· 另有 ${decision.candidates.length - shown.length} 个候选未列出`] : [])
  ];
}

// 拒绝后现场在错误处理时采集，可能已与判定时不同，只作辅助判读。
function pressureDetailLines(governor) {
  const snapshot = governor.snapshot();
  let activity = '增长未知活动 无法读取';
  try {
    const inventory = inventoryForGovernor(() => governor);
    const count = (kind) => inventory.blockers.filter((item) => item.kind === kind).length;
    activity = `增长未知活动 载体 ${count('carrier')} / 主进程活动 ${count('main')} / 上一代 runtime ${count('previous-runtime')}，清单${inventory.inventoryComplete ? '已封存' : '未封存'}`;
  } catch (_error) {}
  const leases = snapshot.activeLeases;
  const lines = [`拒绝后现场（错误处理时采集，可能已变化）：${activity}；活动租约 ${leases.length} 项；排队 ${snapshot.queued.size} 项；系统可用内存 ${mib(os.freemem())}`];
  if (leases.length) {
    const shown = leases.slice(0, 3).map((lease) => [lease.kind, lease.actionKey || '—', MODE_LABELS[lease.memoryMode],
      lease.memoryConfig?.profileId || '未登记', mib(lease.resources.memoryBytes)].filter(Boolean).join(' '));
    lines.push(`拒绝后现场·活动租约：${shown.join('；')}${leases.length > shown.length ? `；另有 ${leases.length - shown.length} 项` : ''}`);
  }
  return lines;
}

function capacityError(code, request, snapshot, cause, governor = null) {
  const insufficient = code === 'BIZOP_RESOURCE_BUDGET_INSUFFICIENT';
  const error = new Error(insufficient
    ? cause?.details?.memoryLimitKind === 'hardware'
      ? '业务 OP 的所有可用执行配置均超过资源上限，本阶段尚未开始'
      : '业务 OP 所需资源超过本次应用的兼容资源预算，请释放内存后重新启动应用'
    : '业务 OP 等待后台资源超过 5 秒，请等待其他任务结束或释放其他程序占用后直接重试', { cause });
  error.code = code;
  error.detailLines = [
    `动作：${request.actionKey}`,
    `内存：需要 ${mib(request.resources.memoryBytes)}，本次预算 ${mib(snapshot.budgets.memoryBytes)}，当前剩余 ${mib(snapshot.available.memoryBytes)}`,
    `CPU / Worker / I/O 槽位：需要 ${request.resources.cpuSlots} / ${request.resources.workerThreadSlots} / ${request.resources.ioHeavySlots}，本次预算 ${snapshot.budgets.cpuSlots} / ${snapshot.budgets.workerThreadSlots} / ${snapshot.budgets.ioHeavySlots}`,
    '本阶段尚未开始执行；未完成的任务和恢复记录继续保留。'
  ];
  if (cause?.details?.candidateMemoryBytes) error.detailLines.push(
    `实际候选额度：${cause.details.candidateMemoryBytes.map(mib).join(' / ')}`);
  if (cause?.details?.reason === 'stable-limit' && Number.isSafeInteger(cause.details.memoryLimitBytes)) error.detailLines.push(
    `调度器原因：stable-limit（${cause.details.memoryLimitKind === 'hardware' ? '硬件上限' : '兼容上限'} ${mib(cause.details.memoryLimitBytes)}）`);
  error.detailLines.push(...decisionDetailLines(cause));
  if (governor) error.detailLines.push(...pressureDetailLines(governor));
  return error;
}

async function acquireBizOpPhaseLease(runtime, request) {
  const governor = runtime.resourceGovernor;
  const resources = validateResourceVector(request.resources);
  const snapshot = governor.snapshot();
  // 固定总预算无法容纳时，释放其它 lease 也无法准入，不能无限排队。
  // 关闭/取消仍交给原 governor，以保留其取消语义和错误类型。
  if (!governor.usesMemoryAdmission && snapshot.accepting && !request.signal?.aborted && !fitsWithin(resources, snapshot.budgets)) {
    throw capacityError('BIZOP_RESOURCE_BUDGET_INSUFFICIENT', request, snapshot);
  }
  try {
    return await governor.acquirePhaseLease({ ...request, resources, timeoutMs: BIZ_OP_RESOURCE_WAIT_MS });
  } catch (error) {
    if (error.code === 'RESOURCE_BUDGET_UNAVAILABLE') {
      throw capacityError('BIZOP_RESOURCE_BUDGET_INSUFFICIENT', request, governor.snapshot(), error, governor);
    }
    if (error.code !== 'ADMISSION_TIMEOUT') throw error;
    // 仅限制准入队列；lease 交付后继续等待实际工作及载体退出，不能提前释放。
    throw capacityError('BIZOP_RESOURCE_WAIT_TIMEOUT', request, governor.snapshot(), error, governor);
  }
}

module.exports = { acquireBizOpPhaseLease, BIZ_OP_RESOURCE_WAIT_MS };
