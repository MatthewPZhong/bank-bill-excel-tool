'use strict';

function registrationError(message) {
  return Object.assign(new TypeError(message), { code: 'TASK_ADAPTER_REGISTRATION_INVALID' });
}

function registrationKey(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw registrationError(`任务适配器注册缺少 ${name}`);
  }
  return value.trim();
}

function createTaskAdapterRegistry({ adapters, taskBindings } = {}) {
  if (!Array.isArray(adapters) || !Array.isArray(taskBindings)) {
    throw registrationError('任务适配器与任务绑定必须显式提供数组');
  }
  const adapterById = new Map();
  for (const adapter of adapters) {
    const id = registrationKey(adapter && adapter.id, 'id');
    if (adapterById.has(id) || typeof adapter.createInvocation !== 'function') {
      throw registrationError(`任务适配器重复或缺少 createInvocation：${id}`);
    }
    adapterById.set(id, Object.freeze({ id, createInvocation: adapter.createInvocation }));
  }
  const adapterByTask = new Map();
  for (const binding of taskBindings) {
    const taskKey = registrationKey(binding && binding.taskKey, 'taskKey');
    const adapterId = registrationKey(binding && binding.adapterId, 'adapterId');
    if (adapterByTask.has(taskKey) || !adapterById.has(adapterId)) {
      throw registrationError(`任务绑定重复或适配器未注册：${taskKey} → ${adapterId}`);
    }
    adapterByTask.set(taskKey, adapterById.get(adapterId));
  }
  return Object.freeze({
    resolve(taskKey) {
      const adapter = adapterByTask.get(taskKey);
      if (!adapter) {
        throw Object.assign(new Error(`业务任务未绑定适配器：${String(taskKey)}`), {
          code: 'TASK_ADAPTER_UNBOUND'
        });
      }
      return adapter;
    }
  });
}

module.exports = { createTaskAdapterRegistry };
