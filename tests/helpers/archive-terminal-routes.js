'use strict';

const { createTerminalRouteRegistry } = require('../../src/main-process/archive-center/terminal-route-registry');
const { createArchiveCenterController } = require('../../src/main-process/archive-center/controller');
const { normalizePositionTerminalRoute } = require('../../src/main-process/position-reconciliation/task-owner');
const { normalizePendingTerminalRoute } = require('../../src/main-process/pending-archive-lineage');
const { normalizePreFundTerminalRoute } = require('../../src/main-process/pre-fund-archive-lineage');
const { normalizeBizOpRunTerminalRoute } = require('../../src/main-process/biz-op-recon-run-data');

function createTestTerminalRouteRegistry(finalize) {
  const finalizer = typeof finalize === 'function' ? finalize : () => {
    throw new Error('测试夹具未提供领域 terminal finalizer');
  };
  return createTerminalRouteRegistry([
    { route: 'position-reconciliation', normalize: normalizePositionTerminalRoute, finalize: finalizer },
    { route: 'pending-run', normalize: normalizePendingTerminalRoute, finalize: finalizer },
    { route: 'biz-op-run', normalize: normalizeBizOpRunTerminalRoute, finalize: finalizer },
    { route: 'pre-fund-run', normalize: normalizePreFundTerminalRoute, finalize: finalizer }
  ]);
}

// 旧 Controller 测试只模拟领域副作用；实际 normalizer 和成对注册仍走生产入口。
function createArchiveControllerWithRoutes(options) {
  let controller;
  const registry = options.terminalRouteRegistry || createTestTerminalRouteRegistry((payload) => {
    if (typeof controller.onTerminalIntentFlushed !== 'function') {
      throw new Error('测试夹具未提供领域 terminal finalizer');
    }
    return controller.onTerminalIntentFlushed(payload);
  });
  controller = createArchiveCenterController({ ...options, terminalRouteRegistry: registry });
  controller.onTerminalIntentFlushed = options.onTerminalIntentFlushed;
  return controller;
}

module.exports = { createArchiveControllerWithRoutes, createTestTerminalRouteRegistry };
