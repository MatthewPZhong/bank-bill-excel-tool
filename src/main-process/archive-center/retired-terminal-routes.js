'use strict';

// v3.2.20 下线「月度Pending数据核对」「业务OP数据核对」。旧版存档 outbox / 任务终态意图中可能残留
//   这两类 run 的 afterTerminal route；若 route 未登记，normalize 抛错会使 outbox 读取失败、阻断存档中心初始化。
//   这里只保留 route 识别。已下线模块的通知由 ArchiveCenterController 在重放前整条跳过并原样保留
//   （不写 Task Run 终态、不做业务收尾、不删除通知），留给回退旧版重放；finalize 仅作兜底，
//   一旦被调用即拒绝，使通知继续保留，绝不把"本版不执行"当作"已执行"。

const RETIRED_TERMINAL_ROUTES = Object.freeze(['pending-run', 'biz-op-run']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function createRetiredTerminalRouteRegistrations() {
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
    async finalize() {
      const error = new Error(`已下线模块的任务终态 route 不在本版收尾，通知原样保留给旧版：${route}`);
      error.code = 'ARCHIVE_RETIRED_TERMINAL_ROUTE_RETAINED';
      throw error;
    }
  })));
}

module.exports = {
  RETIRED_TERMINAL_ROUTES,
  createRetiredTerminalRouteRegistrations
};
