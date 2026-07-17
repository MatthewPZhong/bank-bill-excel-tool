'use strict';

const UPDATE_STATES = Object.freeze([
  'disabled',
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'up-to-date',
  'error'
]);

const PRODUCTION_UPDATER_CONFIG = Object.freeze({
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  allowDowngrade: false,
  disableWebInstaller: true
});

const DISTRIBUTIONS = Object.freeze({
  DEVELOPMENT: 'development',
  NSIS: 'nsis',
  PORTABLE: 'portable'
});

function readIsPackaged(app) {
  try {
    return Boolean(
      typeof app.isPackaged === 'function' ? app.isPackaged() : app.isPackaged
    );
  } catch (_error) {
    return false;
  }
}

function detectDistribution({ app, platform = process.platform, env = process.env } = {}) {
  if (!readIsPackaged(app || {})) return DISTRIBUTIONS.DEVELOPMENT;
  if (platform !== 'win32') return String(platform || 'unsupported');
  if (env && (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR)) {
    return DISTRIBUTIONS.PORTABLE;
  }
  return DISTRIBUTIONS.NSIS;
}

function getCurrentVersion(app) {
  try {
    const version = app && typeof app.getVersion === 'function' ? app.getVersion() : null;
    return version == null ? null : String(version);
  } catch (_error) {
    return null;
  }
}

function extractVersion(info) {
  if (!info || typeof info !== 'object') return null;
  const version = info.version == null ? null : String(info.version);
  return version || null;
}

function parseStableSemver(value) {
  const match = String(value || '').trim().match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/
  );
  return match ? match.slice(1, 4).map((part) => BigInt(part)) : null;
}

function isStrictStableUpgrade(currentVersion, targetVersion) {
  const current = parseStableSemver(currentVersion);
  const target = parseStableSemver(targetVersion);
  if (!current || !target) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (target[index] > current[index]) return true;
    if (target[index] < current[index]) return false;
  }
  return false;
}

function serializeError(error, fallbackMessage = '在线升级失败') {
  const message = error && error.message ? String(error.message) : String(error || fallbackMessage);
  const code = error && error.code != null ? String(error.code) : null;
  return { code, message };
}

function createServiceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isCancellationError(error) {
  const name = error && error.name ? String(error.name).toLowerCase() : '';
  const code = error && error.code ? String(error.code).toLowerCase() : '';
  const message = error && error.message ? String(error.message).toLowerCase() : '';
  return name.includes('cancel')
    || code.includes('cancel')
    || message === 'cancelled'
    || message === 'canceled';
}

function normalizePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function normalizeBusyOperations(value) {
  if (value == null || value === false) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item) => item != null && item !== false && String(item).trim())
    .map((item) => String(item));
}

function cloneStatus(status) {
  return {
    enabled: status.enabled,
    supported: status.supported,
    distribution: status.distribution,
    state: status.state,
    currentVersion: status.currentVersion,
    targetVersion: status.targetVersion,
    percent: status.percent,
    lastCheckedAt: status.lastCheckedAt,
    canRestart: status.canRestart,
    busyOperations: [...status.busyOperations],
    error: status.error ? { ...status.error } : null
  };
}

function defaultUpdaterLoader() {
  // 延迟到受支持发行版 initialize 时加载，node:test 可直接 require 本模块。
  return require('electron-updater');
}

class AppUpdaterService {
  constructor(options = {}) {
    if (!options.app) throw new TypeError('AppUpdaterService 需要 app');

    this.app = options.app;
    this.logger = options.logger || console;
    this.callbacks = options.callbacks || {};
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this._updaterLoader = options.updaterLoader || defaultUpdaterLoader;
    this._updater = options.updater || null;
    this._createCancellationToken = options.createCancellationToken || null;

    const injectedUpdater = Boolean(options.updater);
    const distribution = options.distribution
      || (injectedUpdater
        ? DISTRIBUTIONS.NSIS
        : detectDistribution({
            app: this.app,
            platform: options.platform,
            env: options.env
          }));
    const supported = typeof options.supported === 'boolean'
      ? options.supported
      : distribution === DISTRIBUTIONS.NSIS;
    const enabled = options.enabled === true;

    this._status = {
      enabled,
      supported,
      distribution,
      state: enabled && supported ? 'idle' : 'disabled',
      currentVersion: getCurrentVersion(this.app),
      targetVersion: null,
      percent: 0,
      lastCheckedAt: null,
      canRestart: false,
      busyOperations: [],
      error: null
    };

    this._initialized = false;
    this._updaterReady = false;
    this._initializePromise = null;
    this._startupCheckAttempted = false;
    this._startupCheckPromise = null;
    this._checkPromise = null;
    this._activeCheck = null;
    this._pendingCheckPromise = null;
    this._pendingCheckKind = null;
    this._pendingCheckGeneration = null;
    this._downloadPromise = null;
    this._activeDownload = null;
    this._downloadSequence = 0;
    this._downloadReady = false;
    this._downloadSource = null;
    this._lastLoggedDownloadProgress = -1;
    this._availableCancellationToken = null;
    this._lastCompletedCheckKind = null;
    this._ignoreDownloadEvents = false;
    this._installPromise = null;
    this._operationGeneration = 0;
    this._listeners = new Set();
    this._boundUpdaterListeners = null;

    if (typeof this.callbacks.onStatusChange === 'function') {
      this._listeners.add(this.callbacks.onStatusChange);
    }
  }

  getStatus() {
    return cloneStatus(this._status);
  }

  getLastCompletedCheckKind() {
    return this._lastCompletedCheckKind;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('升级状态监听器必须是 function');
    }
    this._listeners.add(listener);
    listener(this.getStatus());
    return () => this._listeners.delete(listener);
  }

  initialize() {
    if (this._initialized) return Promise.resolve(this.getStatus());
    if (this._initializePromise) return this._initializePromise;

    this._initializePromise = this._initialize()
      .finally(() => {
        this._initializePromise = null;
      });
    return this._initializePromise;
  }

  async _initialize() {
    if (!this._status.supported) {
      this._initialized = true;
      this._setStatus({ state: 'disabled', canRestart: false });
      return this.getStatus();
    }

    try {
      if (!this._updater) {
        const loaded = await this._updaterLoader();
        this._updater = loaded && (loaded.autoUpdater || loaded.updater || loaded);
        if (!this._createCancellationToken && loaded && typeof loaded.CancellationToken === 'function') {
          this._createCancellationToken = () => new loaded.CancellationToken();
        }
      }
      this._validateUpdater();
      this._configureUpdater();
      this._bindUpdaterEvents();
      this._updaterReady = true;
      this._initialized = true;
      this._setStatus({
        state: this._status.enabled ? 'idle' : 'disabled',
        error: null
      });
    } catch (error) {
      this._updaterReady = false;
      this._initialized = true;
      this._setError(error, '在线升级服务初始化失败');
    }
    return this.getStatus();
  }

  _validateUpdater() {
    const updater = this._updater;
    if (!updater || typeof updater.on !== 'function') {
      throw new TypeError('electron-updater 缺少事件接口');
    }
    for (const method of ['checkForUpdates', 'downloadUpdate', 'quitAndInstall']) {
      if (typeof updater[method] !== 'function') {
        throw new TypeError(`electron-updater 缺少 ${method}`);
      }
    }
  }

  _configureUpdater() {
    for (const [key, value] of Object.entries(PRODUCTION_UPDATER_CONFIG)) {
      this._updater[key] = value;
    }
    this._updater.logger = this.logger;
  }

  _bindUpdaterEvents() {
    if (this._boundUpdaterListeners) return;
    const listeners = {
      'download-progress': (progress) => {
        if (this._ignoreDownloadEvents
          || !this._shouldAcceptDownloadEvent()) return;
        const percent = normalizePercent(progress && progress.percent);
        const progressBucket = Math.floor(percent / 25) * 25;
        if (progressBucket >= 25 && progressBucket > this._lastLoggedDownloadProgress) {
          this._lastLoggedDownloadProgress = progressBucket;
          this._log('info', `下载进度 ${progressBucket}%；source=${this._activeDownload?.source || 'unknown'}`);
        }
        this._setStatus({
          state: 'downloading',
          percent,
          canRestart: false,
          error: null
        });
      },
      error: (error) => {
        if (this._activeCheck || this._activeDownload || isCancellationError(error)) return;
        this._logRawError('忽略未关联的升级器错误事件', error);
      }
    };
    for (const [eventName, listener] of Object.entries(listeners)) {
      this._updater.on(eventName, listener);
    }
    this._boundUpdaterListeners = listeners;
  }

  _shouldAcceptDownloadEvent() {
    const operation = this._activeDownload;
    if (!operation
      || operation.cancelled
      || operation.generation !== this._operationGeneration) return false;
    return operation.source === 'manual' || this._status.enabled;
  }

  _markDownloaded(info) {
    const firstCompletion = !this._downloadReady || this._status.state !== 'downloaded';
    this._ignoreDownloadEvents = false;
    this._downloadReady = true;
    this._availableCancellationToken = null;
    this._downloadSource = this._activeDownload
      ? this._activeDownload.source
      : this._downloadSource;
    this._setStatus({
      state: 'downloaded',
      targetVersion: extractVersion(info) || this._status.targetVersion,
      percent: 100,
      canRestart: true,
      busyOperations: [],
      error: null
    });
    if (firstCompletion) {
      this._log('info', `下载完成；source=${this._downloadSource || 'unknown'}；targetVersion=${this._status.targetVersion || '-'}`);
    }
  }

  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('enabled 必须是 boolean');
    }
    if (enabled) {
      this._setStatus({
        enabled: true,
        state: this._downloadReady
          ? 'downloaded'
          : (this._status.supported ? 'idle' : 'disabled'),
        canRestart: this._status.supported && this._downloadReady,
        error: null
      });
      return this.getStatus();
    }

    const automaticCheck = Boolean(this._activeCheck && this._activeCheck.kind !== 'manual');
    const automaticDownload = Boolean(this._activeDownload && this._activeDownload.source !== 'manual');
    const automaticDownloaded = Boolean(this._downloadReady && this._downloadSource !== 'manual');
    if (automaticCheck || automaticDownload) this._operationGeneration += 1;
    if (automaticCheck) this._activeCheck.invalidated = true;
    this._setStatus({ enabled: false });
    try {
      if (automaticDownload) await this._cancelDownload('disabled');
    } catch (error) {
      this._setError(error, '关闭在线升级时取消下载失败');
      return this.getStatus();
    }

    if ((this._activeCheck && this._activeCheck.kind === 'manual')
      || (this._activeDownload && this._activeDownload.source === 'manual')) {
      return this.getStatus();
    }
    if (automaticDownloaded) {
      this._downloadReady = false;
      this._downloadSource = null;
      this._availableCancellationToken = null;
      this._setStatus({
        state: 'disabled',
        percent: 0,
        canRestart: false,
        busyOperations: [],
        error: null
      });
    } else if (this._downloadReady) {
      this._setStatus({ state: 'downloaded', canRestart: true });
    } else {
      this._setStatus({
        state: 'disabled',
        percent: 0,
        canRestart: false,
        busyOperations: [],
        error: null
      });
    }
    return this.getStatus();
  }

  enable() {
    return this.setEnabled(true);
  }

  disable() {
    return this.setEnabled(false);
  }

  checkForUpdatesOnStartup() {
    if (this._startupCheckPromise) return this._startupCheckPromise;
    if (this._startupCheckAttempted) return Promise.resolve(this.getStatus());
    this._startupCheckAttempted = true;

    this._startupCheckPromise = (async () => {
      await this.initialize();
      if (!this._status.enabled || !this._status.supported || !this._updaterReady) {
        return this.getStatus();
      }
      return this._runCheck('startup');
    })().finally(() => {
      this._startupCheckPromise = null;
    });
    return this._startupCheckPromise;
  }

  async checkForUpdates(kind = 'manual') {
    if (!['manual', 'toggle'].includes(kind)) {
      throw new TypeError(`未知检查来源：${kind}`);
    }
    await this.initialize();
    if (!this._status.supported || !this._updaterReady) return this.getStatus();
    if (this._downloadReady) return this.getStatus();
    if (this._hasInvalidatedAutomaticOperation()) {
      return this._queueCheck(kind);
    }
    if (this._downloadPromise || this._installPromise) {
      throw createServiceError('APP_UPDATE_BUSY', '升级服务正忙，暂时无法检查更新');
    }
    return this._runCheck(kind);
  }

  checkForUpdatesManually() {
    return this.checkForUpdates('manual');
  }

  _runCheck(kind) {
    if (this._checkPromise) {
      if (this._activeCheck && this._activeCheck.invalidated) {
        return this._queueCheck(kind);
      }
      return this._checkPromise;
    }
    const operation = {
      kind,
      generation: this._operationGeneration,
      invalidated: false
    };
    this._activeCheck = operation;
    this._log('info', `检查开始；source=${kind}；distribution=${this._status.distribution}；currentVersion=${this._status.currentVersion || '-'}`);

    this._checkPromise = (async () => {
      let failure = null;
      this._setStatus({
        state: 'checking',
        percent: 0,
        canRestart: false,
        busyOperations: [],
        error: null
      });
      try {
        const result = await this._updater.checkForUpdates();
        if (!operation.invalidated && operation.generation === this._operationGeneration) {
          this._applyCheckResultFallback(result);
        }
      } catch (error) {
        failure = error;
        if (!operation.invalidated && operation.generation === this._operationGeneration) {
          if (kind === 'startup') {
            this._logRawError('启动后台检查更新失败', error);
            this._setStatus({
              state: this._status.enabled ? 'idle' : 'disabled',
              targetVersion: null,
              percent: 0,
              canRestart: false,
              busyOperations: [],
              error: null
            });
          } else {
            this._setError(error, '检查失败，请稍后重试');
          }
        }
      } finally {
        if (!operation.invalidated && operation.generation === this._operationGeneration) {
          this._lastCompletedCheckKind = operation.kind;
          this._setStatus({ lastCheckedAt: this._nowIsoString() });
        }
        if (this._activeCheck === operation) this._activeCheck = null;
        this._checkPromise = null;
      }

      if (failure && kind === 'manual') throw failure;
      return this.getStatus();
    })();
    return this._checkPromise;
  }

  _hasInvalidatedAutomaticOperation() {
    return Boolean(
      (this._activeCheck && this._activeCheck.invalidated && this._checkPromise)
      || (this._activeDownload && this._activeDownload.cancelled && this._downloadPromise)
    );
  }

  _queueCheck(kind) {
    if (this._pendingCheckPromise) {
      if (kind === 'manual') this._pendingCheckKind = 'manual';
      return this._pendingCheckPromise;
    }
    this._pendingCheckKind = kind;
    this._pendingCheckGeneration = this._operationGeneration;
    const activePromise = this._checkPromise || this._downloadPromise;
    const queuedPromise = Promise.resolve(activePromise)
      .catch(() => null)
      .then(() => {
        const queuedKind = this._pendingCheckKind;
        const queuedGeneration = this._pendingCheckGeneration;
        if (this._pendingCheckPromise === queuedPromise) {
          this._pendingCheckPromise = null;
          this._pendingCheckKind = null;
          this._pendingCheckGeneration = null;
        }
        if (queuedKind !== 'manual'
          && (!this._status.enabled || queuedGeneration !== this._operationGeneration)) {
          return this.getStatus();
        }
        return this._runCheck(queuedKind);
      });
    this._pendingCheckPromise = queuedPromise;
    return queuedPromise;
  }

  _applyCheckResultFallback(result) {
    const info = result && (result.updateInfo || result.versionInfo);
    const targetVersion = extractVersion(info);
    const explicitlyAvailable = result && typeof result.isUpdateAvailable === 'boolean'
      ? result.isUpdateAvailable
      : null;
    const stableUpgrade = isStrictStableUpgrade(this._status.currentVersion, targetVersion);
    const available = explicitlyAvailable == null ? stableUpgrade : explicitlyAvailable && stableUpgrade;
    const resultToken = result && result.cancellationToken;
    this._availableCancellationToken = available
      && resultToken
      && typeof resultToken.cancel === 'function'
      ? resultToken
      : null;

    if (this._status.state !== 'checking') return;

    if (available) {
      this._downloadReady = false;
      this._downloadSource = null;
      this._setStatus({
        state: 'available',
        targetVersion,
        percent: 0,
        canRestart: false,
        error: null
      });
    } else {
      this._downloadReady = false;
      this._downloadSource = null;
      this._availableCancellationToken = null;
      this._setStatus({
        state: 'up-to-date',
        targetVersion: null,
        percent: 0,
        canRestart: false,
        error: null
      });
    }
  }

  async downloadUpdate(options = {}) {
    const source = typeof options === 'string' ? options : options.source || 'manual';
    if (!['automatic', 'manual'].includes(source)) {
      throw new TypeError(`未知下载来源：${source}`);
    }
    await this.initialize();
    if (!this._status.supported || !this._updaterReady) return this.getStatus();
    if (source === 'automatic' && !this._status.enabled) return this.getStatus();
    if (this._downloadReady) return this.getStatus();
    if (this._downloadPromise) return this._downloadPromise;
    if (this._checkPromise || this._installPromise) {
      throw createServiceError('APP_UPDATE_BUSY', '升级服务正忙，暂时无法下载更新');
    }
    if (!this._status.targetVersion
      || !['available', 'error'].includes(this._status.state)) {
      throw createServiceError('APP_UPDATE_NOT_AVAILABLE', '当前没有可下载的更新');
    }

    let cancellationToken = this._availableCancellationToken;
    try {
      if (!cancellationToken && this._createCancellationToken) {
        cancellationToken = this._createCancellationToken();
      }
    } catch (error) {
      this._setError(error, '创建下载取消令牌失败');
      if (source === 'manual') throw error;
      return this.getStatus();
    }
    const operation = {
      id: ++this._downloadSequence,
      generation: this._operationGeneration,
      source,
      cancellationToken,
      cancelled: false
    };
    this._ignoreDownloadEvents = false;
    this._lastLoggedDownloadProgress = -1;
    this._activeDownload = operation;
    this._log('info', `下载开始；source=${source}；targetVersion=${this._status.targetVersion || '-'}`);

    this._downloadPromise = (async () => {
      this._setStatus({
        state: 'downloading',
        percent: 0,
        canRestart: false,
        busyOperations: [],
        error: null
      });
      try {
        await this._updater.downloadUpdate(cancellationToken || undefined);
        if (!operation.cancelled && operation.generation === this._operationGeneration) {
          this._markDownloaded({ version: this._status.targetVersion });
        }
      } catch (error) {
        if (!operation.cancelled && !isCancellationError(error)) {
          this._availableCancellationToken = null;
          this._setError(error, '下载失败，请稍后重试');
          if (source === 'manual') throw error;
        } else if (!operation.cancelled) {
          operation.cancelled = true;
          this._ignoreDownloadEvents = true;
          this._setCancelledDownloadState();
        }
      } finally {
        if (this._activeDownload === operation) this._activeDownload = null;
        this._downloadPromise = null;
      }
      return this.getStatus();
    })();
    return this._downloadPromise;
  }

  cancelDownload() {
    return this._cancelDownload('manual');
  }

  async _cancelDownload(reason) {
    const operation = this._activeDownload;
    if (!operation || operation.cancelled) return false;

    operation.cancelled = true;
    let cancellationRequested = false;
    try {
      if (operation.cancellationToken
        && typeof operation.cancellationToken.cancel === 'function') {
        operation.cancellationToken.cancel();
        cancellationRequested = true;
      } else if (this._updater && typeof this._updater.cancelDownload === 'function') {
        await this._updater.cancelDownload();
        cancellationRequested = true;
      }
    } catch (error) {
      operation.cancelled = false;
      throw error;
    }

    if (!cancellationRequested) {
      operation.cancelled = false;
      throw createServiceError(
        'APP_UPDATE_CANCEL_UNAVAILABLE',
        '当前升级组件不支持取消下载'
      );
    }

    this._ignoreDownloadEvents = true;
    this._setCancelledDownloadState(reason);
    this._log('info', `下载已取消；source=${operation.source}；reason=${reason}`);
    return true;
  }

  _setCancelledDownloadState(reason = 'manual') {
    this._downloadReady = false;
    this._downloadSource = null;
    this._availableCancellationToken = null;
    this._setStatus({
      state: reason === 'disabled'
        ? 'disabled'
        : (this._status.targetVersion ? 'available' : (this._status.enabled ? 'idle' : 'disabled')),
      percent: 0,
      canRestart: false,
      busyOperations: [],
      error: null
    });
  }

  restartAndInstall() {
    if (this._installPromise) return this._installPromise;
    this._installPromise = this._restartAndInstall();
    this._installPromise.then(
      (result) => {
        if (!result.restarted) this._installPromise = null;
      },
      () => {
        this._installPromise = null;
      }
    );
    return this._installPromise;
  }

  async _restartAndInstall() {
    await this.initialize();
    if (!this._status.supported || !this._updaterReady) {
      return this._restartResult(false, 'unsupported');
    }
    if (!this._downloadReady || !this._status.canRestart) {
      return this._restartResult(false, 'not-downloaded');
    }

    let transitionCancelAttempted = false;
    let cleanupCompleted = false;
    const cancelInstallTransition = async () => {
      if (transitionCancelAttempted) return;
      transitionCancelAttempted = true;
      if (typeof this.callbacks.cancelInstallTransition === 'function') {
        await this.callbacks.cancelInstallTransition();
      }
    };

    try {
      const getBusyOperations = this.callbacks.getBusyOperations;
      const busyOperations = normalizeBusyOperations(
        typeof getBusyOperations === 'function' ? await getBusyOperations() : []
      );
      this._setStatus({
        state: 'downloaded',
        canRestart: true,
        busyOperations,
        error: null
      });
      if (busyOperations.length > 0) {
        this._log('warn', `重启升级被业务阻断；operations=${busyOperations.join('、')}`);
        await cancelInstallTransition();
        return this._restartResult(false, 'busy');
      }

      if (typeof this.callbacks.cleanupBeforeRestart === 'function') {
        await this.callbacks.cleanupBeforeRestart();
      }
      cleanupCompleted = true;
      this._log('info', `安装意图已确认；targetVersion=${this._status.targetVersion || '-'}`);
      this._updater.quitAndInstall(true, true);
      return this._restartResult(true, null);
    } catch (error) {
      const followupErrors = [];
      if (cleanupCompleted && typeof this.callbacks.resumeAfterFailedRestart === 'function') {
        try {
          await this.callbacks.resumeAfterFailedRestart();
        } catch (resumeError) {
          followupErrors.push(resumeError);
        }
      }
      try {
        await cancelInstallTransition();
      } catch (transitionError) {
        followupErrors.push(transitionError);
      }
      let reportedError = error;
      if (followupErrors.length > 0) {
        reportedError = new AggregateError(
          [error, ...followupErrors],
          `${serializeError(error).message}；升级失败后的应用状态恢复不完整`
        );
        reportedError.code = 'APP_UPDATE_POST_FAILURE_RECOVERY_FAILED';
      }
      this._setError(reportedError, '重启升级失败，请稍后重试', {
        state: this._downloadReady ? 'downloaded' : 'error',
        canRestart: this._downloadReady
      });
      throw reportedError;
    }
  }

  _restartResult(restarted, reason) {
    return {
      restarted,
      reason,
      busyOperations: [...this._status.busyOperations],
      status: this.getStatus()
    };
  }

  _nowIsoString() {
    try {
      const value = this.now();
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    } catch (_error) {
      return null;
    }
  }

  _setError(error, fallbackMessage, extra = {}) {
    const serialized = serializeError(error, fallbackMessage);
    const publicCode = serialized.code && /^[A-Z0-9_:-]{1,64}$/.test(serialized.code)
      ? serialized.code
      : 'APP_UPDATE_ERROR';
    const publicMessage = String(fallbackMessage || '在线升级失败，请稍后重试');
    this._log('error', `${publicMessage}：${serialized.message}`);
    this._setStatus({
      state: 'error',
      busyOperations: [],
      error: { code: publicCode, message: publicMessage },
      ...extra
    });
  }

  _logRawError(context, error) {
    this._log('error', `${context}：${serializeError(error).message}`);
  }

  _setStatus(patch) {
    if (patch.state && !UPDATE_STATES.includes(patch.state)) {
      throw new TypeError(`未知升级状态：${patch.state}`);
    }
    const previousState = this._status.state;
    this._status = {
      ...this._status,
      ...patch,
      busyOperations: patch.busyOperations
        ? [...patch.busyOperations]
        : this._status.busyOperations,
      error: Object.prototype.hasOwnProperty.call(patch, 'error')
        ? (patch.error ? { ...patch.error } : null)
        : this._status.error
    };
    if (previousState !== this._status.state) {
      this._log(
        'info',
        `状态 ${previousState}->${this._status.state}；distribution=${this._status.distribution}；currentVersion=${this._status.currentVersion || '-'}；targetVersion=${this._status.targetVersion || '-'}`
      );
    }
    const snapshot = this.getStatus();
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this._log('warn', `升级状态监听器执行失败：${serializeError(error).message}`);
      }
    }
  }

  _log(level, message) {
    try {
      if (this.logger && typeof this.logger[level] === 'function') {
        this.logger[level](`[app-updater] ${message}`);
      }
    } catch (_error) {
      // 日志失败不能改变升级状态机。
    }
  }
}

function createAppUpdaterService(options) {
  return new AppUpdaterService(options);
}

module.exports = {
  UPDATE_STATES,
  PRODUCTION_UPDATER_CONFIG,
  DISTRIBUTIONS,
  AppUpdaterService,
  createAppUpdaterService,
  detectDistribution,
  isStrictStableUpgrade
};
