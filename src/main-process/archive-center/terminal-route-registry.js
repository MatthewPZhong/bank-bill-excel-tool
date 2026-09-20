'use strict';

const { freezePersistedTaskOwner } = require('./worker-operation-context');

const registries = new WeakSet();

function registrationError(message) {
  return Object.assign(new TypeError(message), {
    code: 'ARCHIVE_TERMINAL_ROUTE_REGISTRATION_INVALID'
  });
}

function freezeData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || seen.has(value)
      || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('任务终态 route 必须是可持久化普通数据');
  }
  seen.add(value);
  const copy = Array.isArray(value) ? value.map((entry) => freezeData(entry, seen))
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeData(entry, seen)]));
  seen.delete(value);
  return Object.freeze(copy);
}

function createTerminalRouteRegistry(entries) {
  if (!Array.isArray(entries)) throw registrationError('任务终态 route 注册项必须是数组');
  const routes = new Map();
  for (const entry of entries) {
    const route = entry && typeof entry.route === 'string' ? entry.route.trim() : '';
    if (!route || typeof entry.normalize !== 'function' || typeof entry.finalize !== 'function'
        || routes.has(route)) {
      throw registrationError(`任务终态 route 注册重复或缺少 normalize/finalize：${route || '<empty>'}`);
    }
    routes.set(route, Object.freeze({ route, normalize: entry.normalize, finalize: entry.finalize }));
  }
  function normalize(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('任务终态意图 afterTerminal 格式非法');
    }
    const route = String(value.route || '').trim();
    if (!route) throw new TypeError('任务终态意图 afterTerminal.route 为空');
    const entry = routes.get(route);
    if (!entry) throw new TypeError(`不支持的任务终态 afterTerminal route：${route}`);
    const normalized = entry.normalize({ ...value, route });
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)
        || normalized.route !== route) throw new TypeError('任务终态 route 正常化结果非法');
    return freezeData(normalized);
  }
  async function finalize(payload) {
    const route = normalize(payload && payload.route);
    if (!route) throw new TypeError('任务终态意图 afterTerminal.route 为空');
    return routes.get(route.route).finalize({ ...payload, route });
  }
  // operation 的 live hook 与 replay 共用领域 finalizer，身份来自 TaskLifecycle 的实际 context。
  function createAfterTerminal(value) {
    const route = normalize(value);
    if (!route) throw new TypeError('任务终态意图 afterTerminal.route 为空');
    return ({ context, terminalStatus, terminalResult }) => finalize({
      route,
      record: { payload: { owner: freezePersistedTaskOwner({
        version: 1, kind: 'operation', operationContext: context
      }, { required: true }) } },
      terminalOutcome: { taskStatus: terminalStatus, afterTerminal: route },
      terminalResult
    });
  }
  const registry = Object.freeze({ normalize, finalize, createAfterTerminal });
  registries.add(registry);
  return registry;
}

function assertTerminalRouteRegistry(registry) {
  if (!registry || !Object.isFrozen(registry) || !registries.has(registry)) {
    throw registrationError('ArchiveCenter 需要已冻结且成对注册的 terminal route registry');
  }
  return registry;
}

module.exports = { assertTerminalRouteRegistry, createTerminalRouteRegistry };
