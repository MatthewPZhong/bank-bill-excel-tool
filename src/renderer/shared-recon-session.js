'use strict';

(function installSharedReconSession(root) {
  function createSharedReconSession({ api, reportError = () => {} } = {}) {
    if (!api) throw new TypeError('共享对账会话需要 ReconID API');
    const listeners = new Set();
    let revision = 0;
    let disposed = false;
    function assertLive() {
      if (disposed) throw new Error('共享对账会话已经销毁');
    }
    function notify(method, source, result, rejected) {
      if (disposed) return;
      const outcome = rejected ? 'unknown' : result && result.status === 'ok' ? 'succeeded'
        : result && (result.status === 'failed' || result.status === 'cancelled') ? result.status : 'unknown';
      const event = Object.freeze({ source, kind: method, outcome, revision: ++revision });
      [...listeners].forEach((listener) => {
        if (!listeners.has(listener)) return;
        try { listener(event); } catch (error) { try { reportError(error); } catch (_) { /* 继续刷新其他视图。 */ } }
      });
    }
    function mutation(method, args) {
      assertLive();
      const source = args[0] && args[0].originModuleId ? args[0].originModuleId : 'recon-id-fix';
      let result;
      try { result = api[method](...args); } catch (error) { notify(method, source, null, true); throw error; }
      return Promise.resolve(result).then(
        (value) => { notify(method, source, value, false); return value; },
        (error) => { notify(method, source, null, true); throw error; }
      );
    }
    return Object.freeze({
      import: (...args) => mutation('import', args),
      run: (...args) => mutation('run', args),
      clearSession: (...args) => mutation('clearSession', args),
      export: (...args) => { assertLive(); return api.export(...args); },
      sessionStatus: (...args) => { assertLive(); return api.sessionStatus(...args); },
      subscribe(listener) {
        assertLive();
        if (typeof listener !== 'function') throw new TypeError('共享会话订阅者必须为函数');
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        listeners.clear();
      }
    });
  }
  const exported = Object.freeze({ createSharedReconSession });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.SharedReconSession = exported;
})(typeof window !== 'undefined' ? window : null);
