'use strict';

(function installScenarioChangeRouter(root) {
  function createScenarioChangeRouter({ bankStatement, reconIdFix, scenarioSubscribers = [], configurationSubscribers = {}, reportError = () => {} } = {}) {
    const scenarioListeners = new Set(scenarioSubscribers);
    const channelListeners = new Set(configurationSubscribers.channels || []);
    let lastRevision = 0;
    let disposed = false;
    function call(listener, event) {
      try { listener(event); } catch (error) { try { reportError(error); } catch (_) { /* 继续通知其他 owner。 */ } }
    }
    function notify(listeners, event) {
      [...listeners].forEach((listener) => { if (listeners.has(listener)) call(listener, event); });
    }
    function subscribe(listeners, listener) {
      if (disposed) return () => {};
      if (typeof listener !== 'function') throw new TypeError('场景变更订阅者必须为函数');
      listeners.add(listener);
      let subscribed = true;
      return () => { if (subscribed) { subscribed = false; listeners.delete(listener); } };
    }
    function invalidate(controller, event) {
      if (controller && typeof controller.invalidate === 'function') call((value) => controller.invalidate(value), event);
    }
    return Object.freeze({
      route(event) {
        if (disposed || !event || !Number.isSafeInteger(event.revision) || event.revision <= lastRevision) return false;
        if (!['scenarios-changed', 'scenarios-resync-required', 'scenarios-closed', 'configuration-changed'].includes(event.kind)) return false;
        lastRevision = event.revision;
        if (event.kind === 'configuration-changed') {
          if (event.resource === 'channels') notify(channelListeners, event);
          return true;
        }
        if (event.kind === 'scenarios-closed') {
          notify(scenarioListeners, event);
          return true;
        }
        const scope = event.kind === 'scenarios-resync-required' ? event.resyncScope : event.invalidationScope;
        const bank = Array.isArray(scope) && scope.includes('bank-statement');
        const recon = Array.isArray(scope) && scope.includes('recon-id-fix');
        // 网关结果只有一个 Main owner；BankStatement 消费 recon scope 时只标记其网关展示。
        if (bank || recon) invalidate(bankStatement, event);
        if (recon) invalidate(reconIdFix, event);
        notify(scenarioListeners, event);
        return true;
      },
      subscribeScenarios(listener) { return subscribe(scenarioListeners, listener); },
      subscribeChannels(listener) { return subscribe(channelListeners, listener); },
      dispose() {
        if (disposed) return;
        disposed = true;
        scenarioListeners.clear();
        channelListeners.clear();
      }
    });
  }
  const exported = Object.freeze({ createScenarioChangeRouter });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ScenarioChangeRouter = exported;
})(typeof window !== 'undefined' ? window : null);
