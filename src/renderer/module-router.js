'use strict';

(function installModuleRouter(root) {
  function createModuleRouter({ modules, defaultModuleId, onNavigate = () => {}, persistCurrentModule = () => {}, reportError = () => {} } = {}) {
    if (!Array.isArray(modules) || modules.length === 0) throw new TypeError('模块路由需要静态控制器列表');
    const registry = new Map();
    modules.forEach((entry) => {
      if (!entry || typeof entry.id !== 'string' || !entry.id || registry.has(entry.id)) throw new TypeError('模块 ID 缺失或重复');
      const controller = entry.controller;
      if (!controller || !['enter', 'leave', 'dispose'].every((method) => typeof controller[method] === 'function')) {
        throw new TypeError(`模块 ${entry.id} 缺少生命周期方法`);
      }
      registry.set(entry.id, Object.freeze({ id: entry.id, controller, panel: entry.panel || null }));
    });
    if (!registry.has(defaultModuleId)) throw new TypeError('默认模块必须在静态注册表中');
    const moduleIds = Object.freeze([...registry.keys()]);
    let currentModuleId = null;
    let routeVersion = 0;
    let currentReady = Promise.resolve(Object.freeze({ status: 'stale', moduleId: null, routeVersion: 0 }));
    let transitioning = false;
    let disposed = false;

    function report(error) {
      try { reportError(error); } catch (_) { /* 日志不能中断其他控制器清理。 */ }
    }
    function result(status, ready = currentReady) {
      return Object.freeze({ status, moduleId: currentModuleId, routeVersion, ready });
    }
    function persist(moduleId, version) {
      let pending;
      try { pending = persistCurrentModule(moduleId, { routeVersion: version }); } catch (error) { report(error); return; }
      Promise.resolve(pending).then((response) => {
        if (response && response.status === 'failed') report(new Error(response.message || '模块选择保存失败'));
      }, report);
    }
    function runEnter(entry, version, reason) {
      let pending;
      try { pending = entry.controller.enter({ routeVersion: version, reason }); } catch (error) { pending = Promise.reject(error); }
      return Promise.resolve(pending).then((response) => {
        if (disposed || version !== routeVersion || currentModuleId !== entry.id) {
          return Object.freeze({ status: 'stale', moduleId: entry.id, routeVersion: version });
        }
        const status = response && ['ready', 'error', 'stale'].includes(response.status) ? response.status : 'ready';
        return Object.freeze({ status, moduleId: entry.id, routeVersion: version });
      }, (error) => {
        report(error);
        return Object.freeze({ status: disposed || version !== routeVersion || currentModuleId !== entry.id ? 'stale' : 'error',
          moduleId: entry.id, routeVersion: version, error });
      });
    }
    return Object.freeze({
      moduleIds,
      getCurrentModuleId() { return currentModuleId; },
      getCurrentRoute() { return Object.freeze({ moduleId: currentModuleId, routeVersion }); },
      navigate(requestedId, { reason = 'navigation', persist: shouldPersist = true } = {}) {
        if (disposed) return result('disposed');
        // leave/onNavigate 的同步回调不能在一次尚未提交的切换中再次更改路由。
        if (transitioning) return result('blocked');
        const nextId = registry.has(requestedId) ? requestedId : defaultModuleId;
        if (nextId === currentModuleId) return result('unchanged');
        const previousId = currentModuleId;
        const previousEntry = registry.get(previousId);
        transitioning = true;
        try {
          if (previousEntry) {
            let leaving;
            try { leaving = previousEntry.controller.leave({ reason, nextModuleId: nextId }); } catch (error) {
              report(error);
              return result('error');
            }
            if (leaving && typeof leaving.then === 'function') {
              // leave 是同步资格检查；等待结束不构成第二次导航授权。
              Promise.resolve(leaving).catch(report);
              report(new TypeError(`模块 ${previousId} 的 leave 必须同步返回`));
              return result('blocked');
            }
            if (!leaving || leaving.status !== 'left') return result('blocked');
          }
          if (disposed) return result('disposed');
          currentModuleId = nextId;
          routeVersion += 1;
          const version = routeVersion;
          registry.forEach((entry) => { if (entry.panel) entry.panel.hidden = entry.id !== nextId; });
          try { onNavigate(Object.freeze({ moduleId: nextId, previousModuleId: previousId, routeVersion: version, reason })); } catch (error) { report(error); }
          if (disposed) return result('disposed');
          if (shouldPersist) persist(nextId, version);
          // 到此同步提交已完成，目标 enter 可触发后续导航；旧响应以 version 隔离。
          transitioning = false;
          const entering = runEnter(registry.get(nextId), version, reason);
          if (!disposed && routeVersion === version && currentModuleId === nextId) currentReady = entering;
          return Object.freeze({ status: 'navigated', moduleId: nextId, routeVersion: version, ready: entering });
        } finally {
          transitioning = false;
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        routeVersion += 1;
        currentModuleId = null;
        const disposedControllers = new Set();
        registry.forEach(({ controller }) => {
          if (disposedControllers.has(controller)) return;
          disposedControllers.add(controller);
          try { controller.dispose(); } catch (error) { report(error); }
        });
      }
    });
  }
  const exported = Object.freeze({ createModuleRouter });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ModuleRouter = exported;
})(typeof window !== 'undefined' ? window : null);
