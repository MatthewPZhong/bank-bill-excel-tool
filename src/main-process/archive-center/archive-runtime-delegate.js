'use strict';

const ADMISSION_METHODS = new Set([
  'archiveFile',
  'attachFile',
  'beginTaskRecovery',
  'createBatch',
  'reserveTaskBatch',
  'stageFile'
]);

function maintenanceFailure(message = '存档中心正在维护，请稍后重试') {
  return {
    ok: false,
    status: 'maintenance',
    code: 'ARCHIVE_STORAGE_MAINTENANCE',
    message,
    retryable: true
  };
}

class ArchiveRuntimeDelegate {
  constructor(options = {}) {
    this.currentService = options.service || null;
    this.repositoryFallback = options.repository || null;
    this.intendedRoot = options.rootDir ? String(options.rootDir) : '';
    this.maintenanceRequested = false;
    this.maintenanceActive = false;
    this.maintenanceMessage = '';
  }

  get repository() {
    return this.currentService ? this.currentService.repository : null;
  }

  get rootDir() {
    return this.currentService ? this.currentService.rootDir : this.intendedRoot;
  }

  get service() {
    return this.currentService;
  }

  getMaintenanceState() {
    return {
      requested: this.maintenanceRequested,
      active: this.maintenanceActive,
      message: this.maintenanceMessage
    };
  }

  requestMaintenance(message) {
    if (this.maintenanceRequested || this.maintenanceActive) return false;
    this.maintenanceRequested = true;
    this.maintenanceMessage = String(message || '存档中心正在迁移存储位置');
    return true;
  }

  activateMaintenance() {
    if (!this.maintenanceRequested) throw new Error('maintenance 尚未请求');
    this.maintenanceActive = true;
  }

  releaseMaintenance() {
    this.maintenanceActive = false;
    this.maintenanceRequested = false;
    this.maintenanceMessage = '';
  }

  switchService(service) {
    if (!service || typeof service.initialize !== 'function' || !service.repository) {
      throw new TypeError('ArchiveRuntimeDelegate 需要有效 ArchiveService');
    }
    this.currentService = service;
    this.repositoryFallback = service.repository;
    this.intendedRoot = service.rootDir;
    return service;
  }

  clearService(rootDir = this.intendedRoot) {
    this.currentService = null;
    this.intendedRoot = rootDir ? String(rootDir) : '';
  }

  listUnresolvedSourcePaths() {
    if (!this.currentService || this.maintenanceActive) return [];
    return this.currentService.listUnresolvedSourcePaths();
  }

  invoke(method, args) {
    if (!this.currentService || typeof this.currentService[method] !== 'function') {
      return Promise.resolve({
        ok: false,
        status: 'unavailable',
        code: 'ARCHIVE_STORAGE_ROOT_UNAVAILABLE',
        message: '存档位置暂不可用，请检查存储设备后重试',
        retryable: true
      });
    }
    if (this.maintenanceActive
        || (this.maintenanceRequested && ADMISSION_METHODS.has(method))) {
      return Promise.resolve(maintenanceFailure(this.maintenanceMessage));
    }
    return this.currentService[method](...args);
  }
}

function createArchiveRuntimeDelegate(options = {}) {
  const delegate = new ArchiveRuntimeDelegate(options);
  return new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === 'then') return undefined;
      if (Reflect.has(target, property)) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (typeof property !== 'string') return undefined;
      return (...args) => target.invoke(property, args);
    }
  });
}

module.exports = {
  ADMISSION_METHODS,
  ArchiveRuntimeDelegate,
  createArchiveRuntimeDelegate,
  maintenanceFailure
};
