(function initModalBridge(global) {
  'use strict';

  // 迁移期 DOM 工厂只在这里关联生命周期描述，不把业务状态挂到节点上。
  function createModalBridge({ host, getOwner = () => 'application', reportError = (error) => console.warn('弹窗回调失败：', error) }) {
    const descriptors = new WeakMap();
    const consumed = new WeakSet();

    function registerModal(overlay, descriptor = {}) {
      const previous = descriptors.get(overlay) || {};
      const next = { ...previous, ...descriptor };
      next.disposers = [...(previous.disposers || []), ...(descriptor.onDispose ? [descriptor.onDispose] : [])];
      for (const name of ['onMount']) {
        if (previous[name] && descriptor[name]) {
          next[name] = (...args) => {
            previous[name](...args);
            return descriptor[name](...args);
          };
        }
      }
      descriptors.set(overlay, next);
      return overlay;
    }

    function factoryFor(source) {
      return (scope) => {
        const value = typeof source === 'function' ? source(scope) : source;
        const overlay = value?.overlay || value;
        if (!overlay || overlay.isConnected || consumed.has(overlay)) {
          const error = new Error('弹窗已结束，不能重新挂载旧视图');
          error.code = 'MODAL_VIEW_EXPIRED';
          throw error;
        }
        const descriptor = { ...(descriptors.get(overlay) || {}), ...(value?.overlay ? value : {}) };
        for (const dispose of descriptor.disposers || []) scope.onDispose(dispose);
        if (value?.overlay && value.onDispose) scope.onDispose(value.onDispose);
        scope.onDispose(() => consumed.add(overlay));
        const onMount = descriptor.onMount;
        return {
          ...descriptor,
          overlay,
          dialog: descriptor.dialog || overlay.querySelector('.modal-card') || overlay.firstElementChild || overlay,
          onMount(handle) {
            if (descriptor.onClose) handle.closed.then(descriptor.onClose).catch(reportError);
            return onMount?.(handle, scope);
          }
        };
      };
    }

    function openModal(source, options = {}) {
      return host.openRoot(factoryFor(source), { owner: getOwner(), ...options });
    }

    function pushModal(parent, source) {
      const handle = parent?.close ? parent : host.getHandle(parent);
      // 兼容工厂的晚到响应只放弃显示，不能接管新的弹窗会话。
      if (!handle?.isOpen() || !handle.isTop()) return { status: 'stale' };
      return host.push(handle, factoryFor(source));
    }

    function replaceModal(target, source) {
      return host.replace(target?.close ? target : host.getHandle(target), factoryFor(source));
    }

    function closeModal(target, outcome) {
      const handle = target?.close ? target : target?.nodeType ? host.getHandle(target) : host.getTop();
      return handle?.close(outcome) || { status: 'already-closed' };
    }

    function returnToModal(element) {
      const handle = host.getHandle(element);
      if (!handle?.isOpen()) return { status: 'stale' };
      while (!handle.isTop()) {
        const closed = host.closeTop({ status: 'submitted', value: undefined });
        if (closed.status !== 'closed') return closed;
      }
      return { status: 'opened', handle };
    }

    return Object.freeze({ host, registerModal, openModal, pushModal, replaceModal, closeModal, returnToModal });
  }

  global.__modalBridge = Object.freeze({ createModalBridge });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.__modalBridge;
})(typeof window !== 'undefined' ? window : globalThis);
