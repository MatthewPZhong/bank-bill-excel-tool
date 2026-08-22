'use strict';

const { types: utilTypes } = require('node:util');
const policySchema = require('./schemas/platform-contract-v1.schema.json');
const { createSchemaValidator } = require('./schema-validator');
const { assertJsonSafe, policyForAction } = require('./protocol-validator');

const policySchemaValidator = createSchemaValidator(policySchema, {
  schemaName: 'Background Execution Policy Registry v1'
});

const STATIC_REFERENCE_PATHS = Object.freeze([
  ['entryKey', 'entryKeys', 'entryRegistry'],
  ['adapterKey', 'adapterKeys', 'adapterRegistry'],
  ['commit.inspectorKey', 'inspectorKeys', 'inspectorRegistry'],
  ['commit.conflictScopeResolverKey', 'conflictScopeResolverKeys', 'scopeResolverRegistry'],
  ['commit.settlementKey', 'settlementKeys', 'settlementProviderRegistry'],
  ['artifacts.publisherKey', 'publisherKeys', 'publisherRegistry'],
  ['artifacts.technicalValidatorKey', 'technicalValidatorKeys', 'validatorRegistry'],
  ['artifacts.businessValidatorKey', 'businessValidatorKeys', 'validatorRegistry'],
  ['result.validatorKey', 'resultValidatorKeys', 'validatorRegistry'],
  ['service.serviceKey', 'serviceKeys', 'serviceRegistry'],
  ['resources.profile', 'resourceProfileKeys', 'resourceProfileRegistry'],
  ['resources.compound.topologyKey', 'topologyKeys', 'topologyRegistry'],
  ['workUnits.plannerKey', 'plannerKeys', 'plannerRegistry'],
  ['workUnits.reducerKey', 'reducerKeys', 'reducerRegistry']
]);
const staticRegistryInstances = new WeakSet();

class PolicyRegistryError extends Error {
  constructor(code, message, path = '/', details = null) {
    super(message);
    this.name = 'PolicyRegistryError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

function deepClone(value) {
  assertJsonSafe(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function valueAtPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, field) =>
    current && typeof current === 'object' ? current[field] : undefined, value);
}

function dataMethod(collection, name) {
  let current = collection;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      return Object.prototype.hasOwnProperty.call(descriptor, 'value') && typeof descriptor.value === 'function'
        ? descriptor.value
        : null;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function ownDataValue(collection, key) {
  const descriptor = Object.getOwnPropertyDescriptor(collection, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.value === null || descriptor.value === undefined) {
    return { found: false, value: undefined };
  }
  return { found: true, value: descriptor.value };
}

function registryLookup(collection, key) {
  if (!collection || key === null || key === undefined) return { found: false, value: undefined };
  if (utilTypes.isProxy(collection)) return { found: false, value: undefined };
  if (collection instanceof Map) {
    if (Object.prototype.hasOwnProperty.call(collection, 'get') ||
        Object.prototype.hasOwnProperty.call(collection, 'has')) {
      return { found: false, value: undefined };
    }
    const value = Map.prototype.get.call(collection, key);
    return {
      found: Map.prototype.has.call(collection, key) && value !== null && value !== undefined,
      value
    };
  }
  if (collection instanceof Set) {
    if (Object.prototype.hasOwnProperty.call(collection, 'get') ||
        Object.prototype.hasOwnProperty.call(collection, 'has')) {
      return { found: false, value: undefined };
    }
    return { found: Set.prototype.has.call(collection, key), value: undefined };
  }
  if (Array.isArray(collection)) return { found: collection.includes(key), value: undefined };
  if (staticRegistryInstances.has(collection)) {
    const has = dataMethod(collection, 'has');
    const get = dataMethod(collection, 'get');
    const value = get.call(collection, key);
    return { found: has.call(collection, key) && value !== null && value !== undefined, value };
  }
  const prototype = Object.getPrototypeOf(collection);
  if (prototype === Object.prototype || prototype === null) return ownDataValue(collection, key);
  return { found: false, value: undefined };
}

function collectionHas(collection, key) {
  return registryLookup(collection, key).found;
}

function collectionValue(collection, key) {
  return registryLookup(collection, key).value;
}

function isEntryReference(policy, value) {
  if (value && typeof value === 'object' && utilTypes.isProxy(value)) return false;
  if (policy.mode === 'inline-async') {
    return typeof value === 'function' || Boolean(value && dataMethod(value, 'execute'));
  }
  if (typeof value === 'string') return value.length > 0;
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return false;
  const path = ownDataValue(value, 'path');
  return path.found && typeof path.value === 'string' && path.value.length > 0;
}

function isAdapterReference(policy, value) {
  if (typeof value === 'function') return policy.adapterKind === 'existing-dispatch';
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)) return false;
  if (policy.adapterKind === 'existing-dispatch') {
    return Boolean(dataMethod(value, 'dispatch')) ||
      Boolean(dataMethod(value, 'start') && dataMethod(value, 'cancel') && dataMethod(value, 'close'));
  }
  return Boolean(dataMethod(value, 'start'));
}

function isValidatorReference(value) {
  return typeof value === 'function' || Boolean(value && typeof value === 'object' && !utilTypes.isProxy(value) &&
    (dataMethod(value, 'assertValid') || dataMethod(value, 'validate')));
}

function referenceApiValid(fieldPath, policy, value) {
  if (fieldPath === 'entryKey') return isEntryReference(policy, value);
  if (fieldPath === 'adapterKey') return isAdapterReference(policy, value);
  if (fieldPath.endsWith('ValidatorKey') || fieldPath === 'result.validatorKey') {
    return isValidatorReference(value);
  }
  return value !== null && value !== undefined;
}

function snapshotRuntimeBinding(fieldPath, policy, value) {
  if (fieldPath === 'entryKey') {
    if (typeof value === 'function' || typeof value === 'string') return value;
    const execute = dataMethod(value, 'execute');
    if (policy.mode === 'inline-async' && execute) {
      return Object.freeze({ execute: execute.bind(value) });
    }
    return deepFreeze(deepClone(value));
  }
  if (fieldPath === 'adapterKey') {
    if (typeof value === 'function') return value;
    const dispatch = dataMethod(value, 'dispatch');
    if (dispatch) {
      const inspectTopology = dataMethod(value, 'inspectTopology');
      return Object.freeze({
        dispatch: dispatch.bind(value),
        ...(inspectTopology ? { inspectTopology: inspectTopology.bind(value) } : {})
      });
    }
    return Object.freeze({
      start: dataMethod(value, 'start').bind(value),
      cancel: dataMethod(value, 'cancel').bind(value),
      close: dataMethod(value, 'close').bind(value)
    });
  }
  if (fieldPath.endsWith('ValidatorKey') || fieldPath === 'result.validatorKey') {
    if (typeof value === 'function') return value;
    const assertValid = dataMethod(value, 'assertValid');
    const validate = dataMethod(value, 'validate');
    return Object.freeze(assertValid
      ? { assertValid: assertValid.bind(value) }
      : { validate: validate.bind(value) });
  }
  return value;
}

function policyJsonSafetyError(value) {
  try {
    assertJsonSafe(value);
    return null;
  } catch (error) {
    return Object.freeze({
      code: 'POLICY_NOT_JSON_SAFE',
      path: error.path || '/',
      message: error.message
    });
  }
}

function makeStaticKeySets(staticKeys = {}) {
  const sets = {};
  for (const [bucket, values] of Object.entries(staticKeys)) {
    sets[bucket] = values instanceof Set ? values : new Set(values || []);
  }
  return sets;
}

function semanticPolicyErrors(document, options = {}) {
  const errors = [];
  const staticKeySets = makeStaticKeySets(options.staticKeys);
  const runtimeRegistries = options.runtimeRegistries || {};
  const requireRuntimeApis = options.requireRuntimeApis === true;
  const actionsDescriptor = document && typeof document === 'object' && !utilTypes.isProxy(document)
    ? Object.getOwnPropertyDescriptor(document, 'actions')
    : null;
  const actions = actionsDescriptor && actionsDescriptor.enumerable === true &&
    Object.prototype.hasOwnProperty.call(actionsDescriptor, 'value') &&
    actionsDescriptor.value && typeof actionsDescriptor.value === 'object' &&
    !Array.isArray(actionsDescriptor.value) && !utilTypes.isProxy(actionsDescriptor.value)
    ? actionsDescriptor.value
    : {};

  function add(code, path, message) {
    errors.push({ code, path, message });
  }

  for (const [propertyKey, policy] of Object.entries(actions)) {
    const basePath = `/actions/${propertyKey.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (policy.actionKey !== propertyKey) {
      add('POLICY_ACTION_KEY_MISMATCH', `${basePath}/actionKey`, 'Policy actionKey must equal its registry property name');
    }

    for (const [fieldPath, bucket, registryName] of STATIC_REFERENCE_PATHS) {
      const key = valueAtPath(policy, fieldPath);
      if (key === null || key === undefined) {
        continue;
      }
      const staticCollection = staticKeySets[bucket];
      const runtimeCollection = runtimeRegistries[registryName];
      const resolved = collectionHas(staticCollection, key) || collectionHas(runtimeCollection, key);
      if (!resolved) {
        add(
          'POLICY_STATIC_REFERENCE_MISSING',
          `${basePath}/${fieldPath.replace(/\./g, '/')}`,
          `Unresolved static reference ${fieldPath}=${key}`
        );
        continue;
      }
      const requiresCallableApi = fieldPath === 'entryKey' || fieldPath === 'adapterKey' ||
        fieldPath.endsWith('ValidatorKey') || fieldPath === 'result.validatorKey';
      if (requireRuntimeApis && requiresCallableApi) {
        const runtimeValue = collectionValue(runtimeCollection, key);
        if (!referenceApiValid(fieldPath, policy, runtimeValue)) {
          add(
            'POLICY_STATIC_REFERENCE_INVALID',
            `${basePath}/${fieldPath.replace(/\./g, '/')}`,
            `Static reference ${fieldPath}=${key} has no supported callable API`
          );
        }
      }
    }

    const commit = policy.commit || {};
    const artifacts = policy.artifacts || {};
    if (commit.kind === 'none') {
      if (commit.criticalIntent !== false || ['receiptKind', 'inspectorKey', 'conflictScopeResolverKey', 'settlementKey']
        .some((field) => commit[field] !== null)) {
        add('POLICY_COMMIT_INVALID', `${basePath}/commit`, 'commit.kind=none cannot contain durable recovery fields');
      }
    }
    if (artifacts.kind === 'none') {
      if (artifacts.publisherKey !== null || artifacts.technicalValidatorKey !== null ||
          artifacts.businessValidatorKey !== null || artifacts.maxArtifacts !== 0) {
        add('POLICY_ARTIFACT_INVALID', `${basePath}/artifacts`, 'artifacts.kind=none cannot contain publication fields');
      }
    } else {
      if (artifacts.filePlanRequired !== true) {
        add('POLICY_ARTIFACT_FILE_PLAN_REQUIRED', `${basePath}/artifacts/filePlanRequired`, 'Artifact actions require a FilePlan');
      }
      for (const field of ['publisherKey', 'technicalValidatorKey', 'businessValidatorKey']) {
        if (!artifacts[field]) {
          add('POLICY_ARTIFACT_REFERENCE_REQUIRED', `${basePath}/artifacts/${field}`, `Artifact action requires ${field}`);
        }
      }
    }
    if (policy.disposition === 'blocked' && policy.production && policy.production.enabled === true) {
      add('POLICY_BLOCKED_PRODUCTION', `${basePath}/production/enabled`, 'Blocked action cannot be production enabled');
    }
    const production = policy.production || {};
    if (production.enabled === true) {
      const allowedModes = new Set([policy.mode]);
      if (policy.mode === 'thread-pool') allowedModes.add('thread-single');
      if (!allowedModes.has(production.effectiveMode)) {
        add(
          'POLICY_PRODUCTION_EFFECTIVE_MODE_INVALID',
          `${basePath}/production/effectiveMode`,
          `Enabled production effectiveMode=${production.effectiveMode} is incompatible with mode=${policy.mode}`
        );
      }
    } else if (!['legacy', 'thread-single', 'inline-async', 'utility-process'].includes(production.effectiveMode)) {
      add(
        'POLICY_PRODUCTION_EFFECTIVE_MODE_UNEXPLAINED',
        `${basePath}/production/effectiveMode`,
        'Disabled policy has an unexplained production effectiveMode'
      );
    }
    if (policy.protocolLimits &&
        (policy.protocolLimits.commandMaxBytes !== 262144 || policy.protocolLimits.eventMaxBytes !== 262144)) {
      add('POLICY_PROTOCOL_LIMIT_INVALID', `${basePath}/protocolLimits`, 'Protocol limits must both equal 262144 bytes');
    }
  }
  const durableCanary = policyForAction(actions, 'background-execution:canary');
  if (durableCanary && (!durableCanary.commit || durableCanary.commit.kind !== 'worker-durable')) {
    add(
      'POLICY_DURABLE_CANARY_IDENTITY_INVALID',
      '/actions/background-execution:canary/commit/kind',
      'background-execution:canary must remain the E02-C2 durable recovery canary'
    );
  }
  const pureCanary = policyForAction(actions, 'background-execution:pure-compute-canary');
  if (pureCanary) {
    const context = pureCanary.context;
    const contextKeys = context && typeof context === 'object' ? Object.keys(context).sort() : [];
    const identityValid = contextKeys.length === 2 && contextKeys[0] === 'kind' && contextKeys[1] === 'validatorKey' &&
      context.kind === 'none' && context.validatorKey === 'platform-none' &&
      pureCanary.commit && pureCanary.commit.kind === 'none' &&
      pureCanary.production && pureCanary.production.enabled === false;
    if (!identityValid) {
      add(
        'POLICY_PURE_CANARY_IDENTITY_INVALID',
        '/actions/background-execution:pure-compute-canary',
        'background-execution:pure-compute-canary must remain none/platform-none, commit none and production disabled'
      );
    }
  }
  return errors;
}

function validatePolicyDocument(document, options = {}) {
  const jsonSafetyError = policyJsonSafetyError(document);
  const jsonSafetyErrors = jsonSafetyError ? Object.freeze([jsonSafetyError]) : Object.freeze([]);
  const schemaResult = jsonSafetyError
    ? Object.freeze({ valid: false, errors: Object.freeze([]) })
    : policySchemaValidator.validate(document);
  const semanticErrors = schemaResult.valid ? semanticPolicyErrors(document, options) : [];
  return Object.freeze({
    valid: jsonSafetyErrors.length === 0 && schemaResult.valid && semanticErrors.length === 0,
    jsonSafetyErrors,
    schemaErrors: schemaResult.errors,
    semanticErrors: Object.freeze(semanticErrors.map((error) => Object.freeze(error)))
  });
}

function createStaticRegistry(initialEntries = {}) {
  const entries = new Map();
  let frozen = false;

  function register(key, value) {
    if (frozen) {
      throw new PolicyRegistryError('STATIC_REGISTRY_FROZEN', 'Static registry is frozen');
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new PolicyRegistryError('STATIC_REGISTRY_KEY_INVALID', 'Static registry key must be a non-empty string');
    }
    if (entries.has(key)) {
      throw new PolicyRegistryError('STATIC_REGISTRY_DUPLICATE', `Duplicate static registry key: ${key}`);
    }
    if (value === null || value === undefined) {
      throw new PolicyRegistryError(
        'STATIC_REGISTRY_VALUE_INVALID',
        `Static registry value must not be null or undefined: ${key}`
      );
    }
    entries.set(key, value);
    return value;
  }

  if (utilTypes.isProxy(initialEntries)) {
    throw new PolicyRegistryError(
      'STATIC_REGISTRY_ENTRIES_INVALID',
      'Static registry initial entries must not be a Proxy'
    );
  }
  if (!initialEntries || typeof initialEntries !== 'object' || Array.isArray(initialEntries) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(initialEntries))) {
    throw new PolicyRegistryError(
      'STATIC_REGISTRY_ENTRIES_INVALID',
      'Static registry initial entries must be a plain object'
    );
  }
  for (const key of Reflect.ownKeys(initialEntries)) {
    const descriptor = Object.getOwnPropertyDescriptor(initialEntries, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new PolicyRegistryError(
        'STATIC_REGISTRY_VALUE_INVALID',
        `Static registry value must be an own data property: ${String(key)}`
      );
    }
    register(key, descriptor.value);
  }

  const registry = Object.freeze({
    freeze() {
      frozen = true;
      return registry;
    },
    get(key) {
      return entries.get(key);
    },
    has(key) {
      return entries.has(key);
    },
    isFrozen() {
      return frozen;
    },
    list() {
      return Object.freeze([...entries.keys()].sort());
    },
    register
  });
  staticRegistryInstances.add(registry);
  return registry;
}

function createExecutionPolicyRegistry(options = {}) {
  const policies = new Map();
  const frozenBindings = new Map();
  let frozen = false;
  const runtimeRegistries = {
    entryRegistry: options.entryRegistry,
    adapterRegistry: options.adapterRegistry,
    inspectorRegistry: options.inspectorRegistry,
    scopeResolverRegistry: options.scopeResolverRegistry,
    settlementProviderRegistry: options.settlementProviderRegistry,
    publisherRegistry: options.publisherRegistry,
    validatorRegistry: options.validatorRegistry,
    serviceRegistry: options.serviceRegistry,
    resourceProfileRegistry: options.resourceProfileRegistry,
    topologyRegistry: options.topologyRegistry,
    plannerRegistry: options.plannerRegistry,
    reducerRegistry: options.reducerRegistry
  };
  const inputPolicies = options.policies;
  if (inputPolicies !== undefined) {
    const inputJsonSafetyError = policyJsonSafetyError(inputPolicies);
    if (inputJsonSafetyError) {
      throw new PolicyRegistryError(
        inputJsonSafetyError.code,
        inputJsonSafetyError.message,
        inputJsonSafetyError.path
      );
    }
  }
  const isFullDocument = Boolean(inputPolicies && typeof inputPolicies === 'object' && !Array.isArray(inputPolicies) &&
    Object.prototype.hasOwnProperty.call(inputPolicies, 'actions'));

  function validationError(result) {
    const first = result.jsonSafetyErrors[0] || result.schemaErrors[0] || result.semanticErrors[0];
    return new PolicyRegistryError(
      result.jsonSafetyErrors.length
        ? 'POLICY_NOT_JSON_SAFE'
        : result.schemaErrors.length ? 'POLICY_SCHEMA_INVALID' : first.code,
      `Execution policy registry validation failed at ${first.path}: ${first.message}`,
      first.path,
      result
    );
  }

  if (isFullDocument) {
    const originalResult = validatePolicyDocument(inputPolicies, {
      staticKeys: options.staticKeys,
      runtimeRegistries,
      requireRuntimeApis: true
    });
    if (!originalResult.valid) throw validationError(originalResult);
  }
  const documentMetadata = isFullDocument
    ? Object.fromEntries(Reflect.ownKeys(inputPolicies)
      .filter((key) => key !== 'actions')
      .map((key) => [key, inputPolicies[key]]))
    : {
        contractVersion: 1,
        generatedAt: options.generatedAt || new Date().toISOString(),
        ...(options.baselineRef ? { baselineRef: options.baselineRef } : {})
      };

  function register(policy) {
    if (frozen) {
      throw new PolicyRegistryError('POLICY_REGISTRY_FROZEN', 'Execution policy registry is frozen');
    }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new PolicyRegistryError('POLICY_INVALID', 'Execution policy must be an object');
    }
    const jsonSafetyError = policyJsonSafetyError(policy);
    if (jsonSafetyError) {
      throw new PolicyRegistryError(jsonSafetyError.code, jsonSafetyError.message, jsonSafetyError.path);
    }
    const actionKey = policy.actionKey;
    if (typeof actionKey !== 'string' || actionKey.length === 0) {
      throw new PolicyRegistryError('POLICY_ACTION_KEY_INVALID', 'Execution policy actionKey must be a non-empty string', '/actionKey');
    }
    if (policies.has(actionKey)) {
      throw new PolicyRegistryError('POLICY_DUPLICATE_ACTION', `Duplicate execution policy: ${actionKey}`, '/actionKey');
    }
    const ownedPolicy = deepFreeze(deepClone(policy));
    policies.set(actionKey, ownedPolicy);
    return ownedPolicy;
  }

  if (Array.isArray(inputPolicies)) {
    inputPolicies.forEach(register);
  } else if (isFullDocument) {
    Object.entries(inputPolicies.actions).forEach(([, policy]) => register(policy));
  } else if (inputPolicies && typeof inputPolicies === 'object') {
    Object.entries(inputPolicies).forEach(([propertyKey, policy]) => {
      if (!policy || policy.actionKey !== propertyKey) {
        throw new PolicyRegistryError(
          'POLICY_ACTION_KEY_MISMATCH',
          'Policy actionKey must equal its registry property name',
          `/${propertyKey.replace(/~/g, '~0').replace(/\//g, '~1')}/actionKey`
        );
      }
      register(policy);
    });
  }

  function snapshot() {
    const document = {
      ...documentMetadata,
      actions: Object.fromEntries(policies.entries())
    };
    return deepFreeze(deepClone(document));
  }

  function freeze() {
    if (frozen) {
      return registry;
    }
    const document = snapshot();
    const result = validatePolicyDocument(document, {
      staticKeys: options.staticKeys,
      runtimeRegistries,
      requireRuntimeApis: true
    });
    if (!result.valid) {
      throw validationError(result);
    }
    for (const [actionKey, policy] of policies) {
      const bindings = {};
      for (const [fieldPath, , registryName] of STATIC_REFERENCE_PATHS) {
        const key = valueAtPath(policy, fieldPath);
        if (key === null || key === undefined) continue;
        const resolved = registryLookup(runtimeRegistries[registryName], key);
        if (resolved.found) {
          try {
            bindings[fieldPath] = snapshotRuntimeBinding(fieldPath, policy, resolved.value);
          } catch (error) {
            throw new PolicyRegistryError(
              'POLICY_STATIC_REFERENCE_INVALID',
              `Static reference ${fieldPath}=${key} cannot be snapshotted: ${error.message}`,
              `/actions/${actionKey.replace(/~/g, '~0').replace(/\//g, '~1')}/${fieldPath.replace(/\./g, '/')}`
            );
          }
        }
      }
      frozenBindings.set(actionKey, Object.freeze(bindings));
    }
    frozen = true;
    return registry;
  }

  function assertRunnable(actionKey, runOptions = {}) {
    if (!frozen) {
      throw new PolicyRegistryError('POLICY_REGISTRY_NOT_FROZEN', 'Execution policy registry must be frozen before execution');
    }
    const policy = policies.get(actionKey);
    if (!policy) {
      throw new PolicyRegistryError('POLICY_NOT_FOUND', `No execution policy registered for ${actionKey}`);
    }
    if (policy.disposition === 'blocked') {
      throw new PolicyRegistryError('POLICY_BLOCKED', `Execution policy is blocked: ${actionKey}`);
    }
    if (runOptions.production === true && policy.production.enabled !== true) {
      throw new PolicyRegistryError('POLICY_PRODUCTION_DISABLED', `Execution policy is not enabled in production: ${actionKey}`);
    }
    return policy;
  }

  const registry = Object.freeze({
    assertRunnable,
    freeze,
    get(actionKey) {
      return policies.get(actionKey);
    },
    getBinding(actionKey, fieldPath) {
      if (!frozen) {
        throw new PolicyRegistryError(
          'POLICY_REGISTRY_NOT_FROZEN',
          'Execution policy registry must be frozen before resolving bindings'
        );
      }
      const bindings = frozenBindings.get(actionKey);
      return bindings ? bindings[fieldPath] : undefined;
    },
    has(actionKey) {
      return policies.has(actionKey);
    },
    isFrozen() {
      return frozen;
    },
    list() {
      return Object.freeze([...policies.values()]);
    },
    register,
    snapshot
  });

  return registry;
}

module.exports = {
  PolicyRegistryError,
  STATIC_REFERENCE_PATHS,
  createExecutionPolicyRegistry,
  createStaticRegistry,
  deepFreeze,
  policySchema,
  policySchemaValidator,
  semanticPolicyErrors,
  validatePolicyDocument
};
