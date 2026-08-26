'use strict';

const { normalizeFileIndex, spoolError } = require('./spool-contract');

function normalizeFileCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) {
    throw new TypeError('Ordered Coordinator fileCount必须是0..1000000安全整数');
  }
  return value;
}

function normalizeHighWaterMark(value) {
  if (value === undefined) return 2;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024) {
    throw new TypeError('Ordered Coordinator readyHighWaterMark必须是1..1024安全整数');
  }
  return value;
}

class OrderedMptCoordinator {
  constructor(options = {}) {
    this.fileCount = normalizeFileCount(options.fileCount);
    if (typeof options.consumeReady !== 'function') {
      throw new TypeError('Ordered Coordinator需要consumeReady函数');
    }
    this.consumeReady = options.consumeReady;
    this.consumeError = typeof options.consumeError === 'function' ? options.consumeError : null;
    this.readyHighWaterMark = normalizeHighWaterMark(options.readyHighWaterMark);
    this.nextConsumeIndex = 0;
    this.entries = new Map();
    this.acceptedIndexes = new Set();
    this.results = new Array(this.fileCount);
    this.bufferedReadyCount = 0;
    this.consumerActive = false;
    this.activePermitCount = 0;
    this.maxObservedPermitCount = 0;
    this.nextPermitId = 0;
    this.permitRecords = new WeakMap();
    this.capacityWaiters = [];
    this.capacityObservers = [];
    this.fatalError = null;
    this.settled = false;
    this.drainPromise = Promise.resolve();
    this.completionPromise = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    if (this.fileCount === 0) {
      this.settled = true;
      this.resolveCompletion(Object.freeze([]));
    }
    this.signal = options.signal || null;
    this.onAbort = () => this.cancel();
    if (this.signal) {
      if (this.signal.aborted) this.cancel();
      else this.signal.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  _assertOpen() {
    if (this.fatalError) throw this.fatalError;
    if (this.settled) throw spoolError('PREFUND_COORDINATOR_SETTLED', 'Ordered Coordinator已结束');
  }

  _assertIndex(fileIndex) {
    const index = normalizeFileIndex(fileIndex);
    if (index >= this.fileCount) {
      throw spoolError('PREFUND_COORDINATOR_INDEX_INVALID', 'fileIndex超出本次输入范围');
    }
    if (this.acceptedIndexes.has(index)) {
      throw spoolError('PREFUND_COORDINATOR_DUPLICATE_RESULT', '同一fileIndex只能提交一个parser结果');
    }
    return index;
  }

  _newPermit() {
    const record = { id: ++this.nextPermitId, state: 'reserved' };
    let permit;
    permit = Object.freeze({
      id: record.id,
      submitReady: (fileIndex, spool) => this.submitReady(fileIndex, spool, permit),
      submitBusinessError: (fileIndex, fileResult) =>
        this.submitBusinessError(fileIndex, fileResult, permit),
      submitTransportCrash: (fileIndex, fileResult) =>
        this.submitTransportCrash(fileIndex, fileResult, permit),
      release: () => this._releaseReservedPermit(record)
    });
    this.permitRecords.set(permit, record);
    this.activePermitCount += 1;
    this.maxObservedPermitCount = Math.max(this.maxObservedPermitCount, this.activePermitCount);
    return permit;
  }

  _notifyCapacityAvailable() {
    if (this.fatalError || this.settled || this.activePermitCount >= this.readyHighWaterMark) return;
    const observers = this.capacityObservers.splice(0);
    for (const observer of observers) observer.resolve();
    while (!this.fatalError && !this.settled &&
        this.activePermitCount < this.readyHighWaterMark && this.capacityWaiters.length) {
      this.capacityWaiters.shift().resolve(this._newPermit());
    }
  }

  _rejectCapacityWaiters(error) {
    const waiters = this.capacityWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
    const observers = this.capacityObservers.splice(0);
    for (const observer of observers) observer.reject(error);
  }

  _releaseReservedPermit(record) {
    if (!record || record.state !== 'reserved') return false;
    record.state = 'released';
    this.activePermitCount -= 1;
    this._notifyCapacityAvailable();
    return true;
  }

  _releaseSubmittedPermit(record) {
    if (!record || record.state !== 'submitted') return false;
    record.state = 'released';
    this.activePermitCount -= 1;
    this._notifyCapacityAvailable();
    return true;
  }

  _claimPermit(permit) {
    let ownedPermit = permit;
    if (ownedPermit === undefined) {
      if (this.activePermitCount >= this.readyHighWaterMark) {
        throw spoolError(
          'PREFUND_COORDINATOR_CAPACITY_REQUIRED',
          '提交parser结果前必须取得有界dispatch permit'
        );
      }
      ownedPermit = this._newPermit();
    }
    const record = this.permitRecords.get(ownedPermit);
    if (!record || record.state !== 'reserved') {
      throw spoolError('PREFUND_COORDINATOR_PERMIT_INVALID', 'dispatch permit无效或已消费');
    }
    record.state = 'submitted';
    return record;
  }

  _fail(error) {
    if (this.fatalError || this.settled) return;
    this.fatalError = error;
    this.settled = true;
    if (this.signal) this.signal.removeEventListener('abort', this.onAbort);
    this._rejectCapacityWaiters(error);
    for (const entry of this.entries.values()) {
      this._releaseSubmittedPermit(entry.permitRecord);
    }
    this.entries.clear();
    this.rejectCompletion(error);
  }

  _scheduleDrain() {
    this.drainPromise = this.drainPromise
      .then(() => this._drain())
      .catch((error) => this._fail(error));
  }

  async _drain() {
    while (!this.fatalError && this.entries.has(this.nextConsumeIndex)) {
      const fileIndex = this.nextConsumeIndex;
      const entry = this.entries.get(fileIndex);
      this.entries.delete(fileIndex);
      this._releaseSubmittedPermit(entry.permitRecord);
      if (entry.kind === 'ready') {
        this.bufferedReadyCount -= 1;
        if (this.consumerActive) {
          throw spoolError('PREFUND_COORDINATOR_CONSUMER_OVERLAP', 'Ordered Coordinator consumer不能并发');
        }
        this.consumerActive = true;
        try {
          this.results[fileIndex] = await this.consumeReady(entry.spool, Object.freeze({ fileIndex }));
        } finally {
          this.consumerActive = false;
        }
      } else {
        if (this.consumeError) {
          await this.consumeError(entry.fileResult, Object.freeze({ fileIndex, kind: entry.kind }));
        }
        this.results[fileIndex] = entry.fileResult;
      }
      this.nextConsumeIndex += 1;
    }
    if (!this.fatalError && this.nextConsumeIndex === this.fileCount) {
      this.settled = true;
      if (this.signal) this.signal.removeEventListener('abort', this.onAbort);
      this._notifyCapacityAvailable();
      this.resolveCompletion(Object.freeze(this.results.slice()));
    }
  }

  _submit(fileIndex, entry, permit) {
    this._assertOpen();
    const index = this._assertIndex(fileIndex);
    const permitRecord = this._claimPermit(permit);
    this.acceptedIndexes.add(index);
    this.entries.set(index, Object.freeze({ ...entry, permitRecord }));
    this._scheduleDrain();
  }

  submitReady(fileIndex, spool, permit) {
    if (!spool || typeof spool !== 'object') {
      throw new TypeError('ready parser结果必须包含spool descriptor');
    }
    this.bufferedReadyCount += 1;
    try {
      this._submit(fileIndex, { kind: 'ready', spool }, permit);
    } catch (error) {
      this.bufferedReadyCount -= 1;
      throw error;
    }
  }

  submitBusinessError(fileIndex, fileResult, permit) {
    if (!fileResult || typeof fileResult !== 'object') {
      throw new TypeError('business error必须提供当前file结果对象');
    }
    this._submit(fileIndex, { kind: 'business-error', fileResult }, permit);
  }

  submitTransportCrash(fileIndex, fileResult, permit) {
    if (!fileResult || typeof fileResult !== 'object') {
      throw new TypeError('transport crash必须提供按旧service合同构造的当前file结果对象');
    }
    this._submit(fileIndex, { kind: 'transport-crash', fileResult }, permit);
  }

  acquireDispatchPermit() {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.settled) {
      return Promise.reject(spoolError('PREFUND_COORDINATOR_SETTLED', 'Ordered Coordinator已结束'));
    }
    if (this.activePermitCount < this.readyHighWaterMark) {
      return Promise.resolve(this._newPermit());
    }
    return new Promise((resolve, reject) => this.capacityWaiters.push({ resolve, reject }));
  }

  waitForDispatchCapacity() {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.settled || this.activePermitCount < this.readyHighWaterMark) return Promise.resolve();
    return new Promise((resolve, reject) => this.capacityObservers.push({ resolve, reject }));
  }

  cancel() {
    this._fail(spoolError('PREFUND_COORDINATOR_CANCELLED', 'Ordered Coordinator已取消'));
  }

  completion() {
    return this.completionPromise;
  }

  snapshot() {
    return Object.freeze({
      fileCount: this.fileCount,
      nextConsumeIndex: this.nextConsumeIndex,
      acceptedCount: this.acceptedIndexes.size,
      bufferedReadyCount: this.bufferedReadyCount,
      activePermitCount: this.activePermitCount,
      maxObservedPermitCount: this.maxObservedPermitCount,
      readyHighWaterMark: this.readyHighWaterMark,
      consumerActive: this.consumerActive,
      settled: this.settled
    });
  }
}

function createOrderedMptCoordinator(options) {
  return new OrderedMptCoordinator(options);
}

module.exports = {
  OrderedMptCoordinator,
  createOrderedMptCoordinator
};
