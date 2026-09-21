(function installPendingController(root) {
  'use strict';
  // 现有 Pending 工厂拥有完整业务与私有状态；此入口供静态 router 注册。
  const implementation = typeof module !== 'undefined' && module.exports
    ? require('../../renderer-pending') : root.__rendererPending;
  root.__pendingController = Object.freeze({ createPendingController: implementation.createPendingController });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.__pendingController;
})(typeof window !== 'undefined' ? window : globalThis);
