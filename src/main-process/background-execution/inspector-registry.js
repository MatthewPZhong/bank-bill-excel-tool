'use strict';

const KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

class RecoveryRegistryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RecoveryRegistryError';
    this.code = code;
    this.details = details;
  }
}

function normalizeExpectedKeys(value, label) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`${label} expectedKeys 必须是数组`);
  const keys = value.map((key) => {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.length > 256) {
      throw new TypeError(`${label} expected key 非法`);
    }
    return key;
  });
  if (new Set(keys).size !== keys.length) throw new TypeError(`${label} expectedKeys 不得重复`);
  return Object.freeze([...keys].sort());
}

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.length > 256) {
    throw new TypeError('registry key 非法');
  }
}

function createInspectorRegistry(options = {}) {
  const expectedKeys = normalizeExpectedKeys(options.expectedKeys, 'InspectorRegistry');
  const entries = new Map();
  let frozen = false;
  return Object.freeze({
    register(key, inspector) {
      if (frozen) {
        throw new RecoveryRegistryError('RECOVERY_REGISTRY_FROZEN', 'InspectorRegistry freeze 后禁止注册');
      }
      assertKey(key);
      if (typeof inspector !== 'function') throw new TypeError('inspector 必须是函数');
      if (entries.has(key)) {
        throw new RecoveryRegistryError('RECOVERY_REGISTRY_DUPLICATE_KEY', `Inspector 重复注册：${key}`);
      }
      entries.set(key, inspector);
    },

    get(key) {
      assertKey(key);
      const inspector = entries.get(key);
      if (!inspector) {
        throw new RecoveryRegistryError('RECOVERY_INSPECTOR_NOT_FOUND', `Inspector 未注册：${key}`);
      }
      return inspector;
    },

    freeze() {
      if (frozen) return;
      const missing = expectedKeys.filter((key) => !entries.has(key));
      if (missing.length > 0) {
        throw new RecoveryRegistryError(
          'RECOVERY_REGISTRY_INCOMPLETE',
          'InspectorRegistry 缺少 Static Key Manifest 引用',
          { missing }
        );
      }
      frozen = true;
    }
  });
}

module.exports = {
  RecoveryRegistryError,
  createInspectorRegistry
};
