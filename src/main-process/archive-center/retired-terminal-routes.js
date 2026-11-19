'use strict';

// v3.2.20 下线「月度Pending数据核对」「业务OP数据核对」。旧版存档 outbox / 任务终态意图中可能残留
//   这两类 run 的 afterTerminal route；若 route 未登记，重放时 normalize 抛错会使 outbox flush 失败、
//   阻断存档中心初始化。这里只保留 route 识别：任务终态照常由 ArchiveCenter 收口，
//   业务侧收尾（写回 Pending 库 / BizOP 侧库的 run 血缘）不再执行，已下线模块的数据保持原样。

const RETIRED_TERMINAL_ROUTES = Object.freeze(['pending-run', 'biz-op-run']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function createRetiredTerminalRouteRegistrations({ onRetiredFinalize = null } = {}) {
  if (onRetiredFinalize !== null && typeof onRetiredFinalize !== 'function') {
    throw new TypeError('onRetiredFinalize 必须是函数');
  }
  return Object.freeze(RETIRED_TERMINAL_ROUTES.map((route) => Object.freeze({
    route,
    // 与原领域 normalizer 同形（{ route, taskRunId }，taskRunId 去首尾空格），保证已持久化的收口凭证比对一致；
    //   遗留记录缺 taskRunId 时不再抛错，只保留 route。
    normalize(value) {
      if (!isPlainObject(value) || value.route !== route) {
        throw new TypeError(`已下线模块的任务终态 route 格式非法：${route}`);
      }
      const taskRunId = typeof value.taskRunId === 'string' ? value.taskRunId.trim() : '';
      return taskRunId ? { route, taskRunId } : { route };
    },
    async finalize(payload = {}) {
      if (onRetiredFinalize) {
        const owner = payload.record && payload.record.payload && payload.record.payload.owner;
        onRetiredFinalize({
          route,
          taskStatus: payload.terminalOutcome && payload.terminalOutcome.taskStatus || '',
          taskRunId: owner && (owner.batchContext || owner.operationContext || {}).taskRunId || ''
        });
      }
      return Object.freeze({ route, retired: true });
    }
  })));
}

module.exports = {
  RETIRED_TERMINAL_ROUTES,
  createRetiredTerminalRouteRegistrations
};
