'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAdmissionOnlyOwner } = require('./background-execution/admission-only-owner');
const { dispatchLargeSplit } = require('./toolbox-large-split-dispatch');
const { createToolboxScanResources } = require('./toolbox-scan-resources');
const { sourceSnapshotFromStat, sourceSnapshotMatchesStat } = require('./archive-center/source-snapshot');
const { MAX_ROW_SPLIT_FILES } = require('./toolbox-row-split/contracts');

const SCAN_ACTION = 'toolbox:split:prepare';
// 公共扫描沿用原入口无独立内存预留的兼容合同；0 是账本预留值，不是工作集估计。
// CPU/Worker/IO 与未知增长观察继续保护执行；获批阶段由 memory policy 替换内存配置。
const SCAN_RESOURCES = Object.freeze({ cpuSlots: 1, workerThreadSlots: 1,
  utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 0 });
const VALUES_BYTES = 4 * 1024 ** 2;
const MAX_CACHED_FIELDS = 8;

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function validateRequest(request, keys) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).sort().join(',') !== [...keys].sort().join(',') || request.version !== 2 ||
      typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(request.requestId)) {
    throw failure('TOOLBOX_SPLIT_READ_INVALID', '拆分读取请求无效');
  }
}

// Main 持有窗口、来源与私有目录；Renderer 只能持有 token 与请求号。
function createToolboxSplitReadOwner({ governor, dispatch = dispatchLargeSplit,
  temporaryRoot = path.join(os.tmpdir(), 'bank-bill-toolbox-scans'), fsImpl = fs }) {
  const resources = createToolboxScanResources({ temporaryRoot, fsImpl });
  const sessions = new Map();
  const requests = new Map();
  const observedSenders = new WeakSet();
  let accepting = true;
  let closing = null;
  const scans = createAdmissionOnlyOwner({
    governor,
    descriptor: { ownerKey: 'toolbox-split-read', actionKey: SCAN_ACTION, resources: SCAN_RESOURCES, timeoutMs: 5000 },
    start(input, execution) {
      try {
        resources.create(input);
        const carrier = dispatch({ ...input, executionMemoryConfig: execution.memoryConfig });
        return { ...carrier, promise: carrier.promise.then((result) => ({ ...result, executionMode: execution.memoryMode })) };
      } catch (error) {
        return { promise: Promise.reject(error), closed: Promise.resolve({ spawned: false }), cancel() {} };
      }
    },
    cleanup(input) {
      resources.cleanup(input);
    }
  });

  async function runScan(input, options) {
    try { return await scans.run(input, options); } catch (error) {
      const timeout = error.code === 'ADMISSION_TIMEOUT';
      if (!timeout && error.code !== 'RESOURCE_BUDGET_UNAVAILABLE') throw error;
      // 只在公共读取边界解释准入错误，保留原错误码、诊断与 cause 供定位。
      throw Object.assign(new Error(timeout ? '拆分文件读取等待后台资源超时' : '拆分文件读取所需的后台资源配额不足',
        { cause: error }), { code: error.code, details: error.details,
        detailLines: [...(Array.isArray(error.detailLines) ? error.detailLines : []), timeout
          ? '已等待 5 秒，请等待其他任务完成后重试。'
          : '扫描所需资源超过本次运行的固定配额，未进入等待队列。'] });
    }
  }

  function senderId(sender) {
    if (!accepting || !sender || !Number.isSafeInteger(sender.id) || sender.isDestroyed?.()) {
      throw failure('TOOLBOX_SPLIT_READ_CLOSED', '拆分读取窗口已关闭');
    }
    if (!observedSenders.has(sender)) {
      observedSenders.add(sender);
      sender.once?.('destroyed', () => invalidate(sender.id));
    }
    return sender.id;
  }
  function invalidate(id) {
    sessions.delete(id);
    for (const request of requests.values()) if (request.senderId === id) request.controller.abort();
  }
  function keyOf(id, requestId) { return `${id}:${requestId}`; }
  function begin(id, requestId) {
    const key = keyOf(id, requestId);
    if (requests.has(key)) throw failure('TOOLBOX_SPLIT_READ_DUPLICATE', '拆分读取请求号重复');
    const record = { senderId: id, controller: new AbortController(), key };
    requests.set(key, record);
    return record;
  }
  function assertFresh(context) {
    let stat;
    try { stat = fs.statSync(context.sourceFilePath, { bigint: true }); } catch (_error) { /* 下方统一失效 */ }
    if (!stat || !sourceSnapshotMatchesStat(context.snapshot, stat)) {
      invalidate(context.senderId);
      throw failure('TOOLBOX_SPLIT_READ_CONTEXT_STALE', '拆分源文件已变化，请重新选择');
    }
  }
  function requireContext(sender, payload) {
    const context = sessions.get(senderId(sender));
    if (!context || context.token !== payload.splitReadToken ||
        (payload.sourceFilePath !== undefined && path.resolve(payload.sourceFilePath) !== context.sourceFilePath)) {
      throw failure('TOOLBOX_SPLIT_READ_CONTEXT_STALE', '拆分源文件准备信息已失效，请重新选择');
    }
    assertFresh(context);
    return context;
  }
  async function read(sender, request, chooseSource) {
    validateRequest(request, ['version', 'scanKind', 'requestId']);
    if (request.scanKind !== 'metadata') throw failure('TOOLBOX_SPLIT_READ_INVALID', '基础读取类型无效');
    const id = senderId(sender);
    invalidate(id);
    const record = begin(id, request.requestId);
    try {
      const selected = await chooseSource();
      if (!selected || record.controller.signal.aborted) return { status: 'cancelled' };
      const sourceFilePath = path.resolve(selected);
      const snapshot = sourceSnapshotFromStat(fs.statSync(sourceFilePath, { bigint: true }));
      if (!snapshot) throw failure('TOOLBOX_SPLIT_READ_INVALID', '拆分源文件不可读');
      const result = await runScan({ op: 'scanMetadata', filePath: sourceFilePath },
        { operationKey: request.requestId, signal: record.controller.signal });
      const context = { token: randomUUID(), senderId: id, sourceFilePath, snapshot: Object.freeze(snapshot),
        dataRowCount: result.dataRowCount, headers: Object.freeze([...result.headers]), fields: new Map() };
      assertFresh(context);
      if (record.controller.signal.aborted) return { status: 'cancelled' };
      sessions.set(id, context);
      return { status: 'success', version: 2, requestId: request.requestId, valuesState: 'not-requested',
        sourceFilePath, splitReadToken: context.token, headers: context.headers,
        dataRowCount: context.dataRowCount, maxRowSplitFiles: MAX_ROW_SPLIT_FILES, executionMode: result.executionMode };
    } finally { requests.delete(record.key); }
  }
  async function readValues(sender, request) {
    validateRequest(request, ['version', 'splitReadToken', 'requestId', 'field']);
    const context = requireContext(sender, request);
    if (typeof request.field !== 'string' || !context.headers.includes(request.field)) {
      throw failure('TOOLBOX_SPLIT_READ_INVALID', '拆分字段不属于本次表头');
    }
    const record = begin(context.senderId, request.requestId);
    let field = context.fields.get(request.field);
    try {
      if (!field) {
        // 只保留最多八列，每列限额包含字符串和集合条目；不能无界累积历史选择。
        if (context.fields.size >= MAX_CACHED_FIELDS) {
          const evict = [...context.fields].find(([, item]) => item.subscribers.size === 0);
          if (!evict) throw failure('TOOLBOX_SPLIT_READ_BUSY', '字段读取过多，请等待当前读取完成');
          context.fields.delete(evict[0]);
        }
        field = { controller: new AbortController(), subscribers: new Set(), promise: null };
        context.fields.set(request.field, field);
        field.promise = runScan({ op: 'scanValues', filePath: context.sourceFilePath, field: request.field,
          maxValues: 50000, maxValueBytes: VALUES_BYTES },
        { operationKey: `values-${randomUUID()}`, signal: field.controller.signal }).then((result) => {
          assertFresh(context);
          return result;
        }).catch((error) => {
          if (context.fields.get(request.field) === field) context.fields.delete(request.field);
          throw error;
        });
      }
      field.subscribers.add(record);
      const cancel = () => {
        field.subscribers.delete(record);
        if (field.subscribers.size === 0) {
          field.controller.abort();
          if (context.fields.get(request.field) === field) context.fields.delete(request.field);
        }
      };
      record.controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await field.promise;
        if (record.controller.signal.aborted || sessions.get(context.senderId) !== context) return { status: 'cancelled' };
        assertFresh(context);
        return { status: 'success', version: 2, requestId: request.requestId, splitReadToken: context.token, ...result };
      } finally { record.controller.signal.removeEventListener('abort', cancel); }
    } finally {
      field?.subscribers.delete(record);
      requests.delete(record.key);
    }
  }
  return Object.freeze({ read, readValues, requireContext,
    ownsToken(sender, token) { return sessions.get(sender.id)?.token === token; },
    clear(context) { if (sessions.get(context.senderId) === context) invalidate(context.senderId); },
    cancel(sender, request) {
      validateRequest(request, ['version', 'requestId']);
      requests.get(keyOf(senderId(sender), request.requestId))?.controller.abort();
      return { status: 'cancelled', version: 2, requestId: request.requestId };
    },
    close() {
      accepting = false;
      if (closing) return closing;
      closing = (async () => {
        for (const id of sessions.keys()) invalidate(id);
        for (const request of requests.values()) request.controller.abort();
        const result = await scans.close();
        const recovery = resources.retryRecovered();
        const cleanupPendingCount = result.cleanupPendingCount + recovery.cleanupPendingCount;
        return Object.freeze({ closed: result.unclosedCount === 0 && cleanupPendingCount === 0,
          unclosedCount: result.unclosedCount, cleanupPendingCount });
      })().finally(() => { closing = null; });
      return closing;
    },
    snapshot() {
      const current = scans.snapshot(), recovery = resources.snapshot();
      return Object.freeze({ ...current, cleanupPendingCount: current.cleanupPendingCount + recovery.cleanupPendingCount,
        cleanupUnpersistedCount: recovery.cleanupUnpersistedCount,
        cleanupFailures: Object.freeze([...current.cleanupFailures, ...recovery.cleanupFailures]) });
    }
  });
}

module.exports = { createToolboxSplitReadOwner, SCAN_ACTION, SCAN_RESOURCES };
