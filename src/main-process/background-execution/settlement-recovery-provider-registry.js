'use strict';

const { RecoveryRegistryError } = require('./inspector-registry');

const KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.length > 256) {
    throw new TypeError('registry key 非法');
  }
}

function expectedKeyList(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError('SettlementRecoveryProviderRegistry expectedKeys 必须是数组');
  const keys = value.map((key) => {
    assertKey(key);
    return key;
  });
  if (new Set(keys).size !== keys.length) throw new TypeError('expectedKeys 不得重复');
  return Object.freeze([...keys].sort());
}

function createSettlementRecoveryProviderRegistry(options = {}) {
  const expectedKeys = expectedKeyList(options.expectedKeys);
  const entries = new Map();
  let frozen = false;
  return Object.freeze({
    register(key, provider) {
      if (frozen) {
        throw new RecoveryRegistryError(
          'RECOVERY_REGISTRY_FROZEN',
          'SettlementRecoveryProviderRegistry freeze 后禁止注册'
        );
      }
      assertKey(key);
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)
          || typeof provider.listOpenSources !== 'function'
          || typeof provider.recover !== 'function') {
        throw new TypeError('provider 必须实现 listOpenSources/recover');
      }
      if (entries.has(key)) {
        throw new RecoveryRegistryError('RECOVERY_REGISTRY_DUPLICATE_KEY', `Provider 重复注册：${key}`);
      }
      entries.set(key, provider);
    },

    get(key) {
      assertKey(key);
      const provider = entries.get(key);
      if (!provider) {
        throw new RecoveryRegistryError('RECOVERY_PROVIDER_NOT_FOUND', `Provider 未注册：${key}`);
      }
      return provider;
    },

    list() {
      return Object.freeze([...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, provider]) => Object.freeze({ key, provider })));
    },

    freeze() {
      if (frozen) return;
      const missing = expectedKeys.filter((key) => !entries.has(key));
      if (missing.length > 0) {
        throw new RecoveryRegistryError(
          'RECOVERY_REGISTRY_INCOMPLETE',
          'SettlementRecoveryProviderRegistry 缺少 Static Key Manifest 引用',
          { missing }
        );
      }
      frozen = true;
    }
  });
}

module.exports = {
  createSettlementRecoveryProviderRegistry
};
