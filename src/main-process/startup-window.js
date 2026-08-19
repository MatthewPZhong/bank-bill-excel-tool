'use strict';

function startupWindowError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function waitForWindowReady({
  window,
  load,
  timeoutMs = 30000,
  timers = globalThis,
  onLoad = () => undefined
}) {
  if (!window || !window.webContents) throw new TypeError('startup window 缺少 webContents');
  if (typeof load !== 'function') throw new TypeError('startup window 缺少 load 函数');
  return new Promise((resolve, reject) => {
    let settled = false;
    let loaded = false;
    let ready = false;
    let timeout = null;
    const listeners = [];
    const listen = (emitter, eventName, listener) => {
      emitter.on(eventName, listener);
      listeners.push([emitter, eventName, listener]);
    };
    const cleanup = () => {
      if (timeout !== null) timers.clearTimeout(timeout);
      timeout = null;
      for (const [emitter, eventName, listener] of listeners) {
        emitter.removeListener(eventName, listener);
      }
      listeners.length = 0;
    };
    const finish = () => {
      if (settled || !loaded || !ready) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    listen(window, 'ready-to-show', () => {
      ready = true;
      finish();
    });
    listen(window, 'closed', () => fail(startupWindowError(
      'STARTUP_WINDOW_CLOSED',
      '启动窗口在就绪前关闭'
    )));
    listen(window.webContents, 'render-process-gone', (_event, details = {}) => fail(
      startupWindowError('STARTUP_RENDERER_GONE', '启动渲染进程在就绪前退出', {
        reason: String(details.reason || '')
      })
    ));
    listen(window.webContents, 'did-fail-load', (
      _event,
      errorCode,
      _errorDescription,
      _validatedUrl,
      isMainFrame
    ) => {
      if (isMainFrame === false) return;
      fail(startupWindowError('STARTUP_WINDOW_LOAD_FAILED', '启动页面加载失败', {
        loadErrorCode: Number(errorCode) || 0
      }));
    });
    timeout = timers.setTimeout(() => fail(startupWindowError(
      'STARTUP_WINDOW_READY_TIMEOUT',
      '启动窗口等待就绪超时'
    )), timeoutMs);
    Promise.resolve().then(load).then(() => {
      loaded = true;
      try {
        onLoad();
      } catch (error) {
        fail(error);
        return;
      }
      finish();
    }, (cause) => fail(startupWindowError(
      'STARTUP_WINDOW_LOAD_FAILED',
      '启动页面加载失败',
      { cause }
    )));
  });
}

function shouldAcceptInitialRendererMetrics({
  senderId,
  initialWebContentsId,
  hasExistingMetrics
}) {
  return initialWebContentsId !== null
    && initialWebContentsId !== undefined
    && senderId === initialWebContentsId
    && hasExistingMetrics !== true;
}

function createWindowInstrumentation({ enabled, mark, startPhase }) {
  if (enabled !== true) {
    return Object.freeze({
      enabled: false,
      mark() {},
      startPhase() { return () => null; }
    });
  }
  return Object.freeze({
    enabled: true,
    mark,
    startPhase
  });
}

function showReadyWindow({ window, sendWindowState }) {
  if (!window || typeof window.show !== 'function') {
    throw new TypeError('startup window 缺少 show 函数');
  }
  if (typeof sendWindowState !== 'function') {
    throw new TypeError('startup window 缺少状态同步函数');
  }
  window.show();
  sendWindowState();
}

module.exports = {
  createWindowInstrumentation,
  showReadyWindow,
  shouldAcceptInitialRendererMetrics,
  startupWindowError,
  waitForWindowReady
};
