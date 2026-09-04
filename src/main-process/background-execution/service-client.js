'use strict';

const { types: utilTypes } = require('node:util');

class ServiceClientError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ServiceClientError';
    this.code = code;
    this.details = details;
  }
}

function requireMethod(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`ServiceClient requires ${label}.${method}`);
  }
  return value;
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`ServiceClient ${label} must be a non-empty string`);
  }
  return value;
}

function requestActionKey(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || utilTypes.isProxy(request) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(request))) {
    throw new TypeError('ServiceClient request must be a plain non-Proxy object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(request, 'actionKey');
  if (!descriptor || descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypeError('ServiceClient request actionKey must be an enumerable own data property');
  }
  return requireText(descriptor.value, 'request actionKey');
}

function serviceActionKeys(policyRegistry, serviceKey) {
  const policies = policyRegistry.list();
  if (!Array.isArray(policies)) {
    throw new TypeError('ServiceClient policyRegistry.list must return an array');
  }
  const actionKeys = policies
    .filter((policy) => policy && policy.lifetime === 'service' && policy.service &&
      policy.service.serviceKey === serviceKey)
    .map((policy) => requireText(policy.actionKey, 'policy actionKey'))
    .sort();
  if (actionKeys.length === 0) {
    throw new ServiceClientError(
      'SERVICE_CLIENT_POLICY_MISSING',
      `No service-lifetime policies are registered for ${serviceKey}`
    );
  }
  if (new Set(actionKeys).size !== actionKeys.length) {
    throw new ServiceClientError(
      'SERVICE_CLIENT_POLICY_DUPLICATE',
      `Duplicate service action policy is registered for ${serviceKey}`
    );
  }
  return Object.freeze(actionKeys);
}

function createServiceClient(options = {}) {
  const supervisor = requireMethod(options.supervisor, 'start', 'supervisor');
  for (const method of ['execute', 'cancel', 'inspect', 'closeService']) {
    requireMethod(supervisor, method, 'supervisor');
  }
  const policyRegistry = requireMethod(options.policyRegistry, 'list', 'policyRegistry');
  const serviceKey = requireText(options.serviceKey, 'serviceKey');
  const actionKeys = serviceActionKeys(policyRegistry, serviceKey);
  const allowedActions = new Set(actionKeys);

  function assertOwnedAction(request) {
    const actionKey = requestActionKey(request);
    if (!allowedActions.has(actionKey)) {
      throw new ServiceClientError(
        'SERVICE_CLIENT_ACTION_NOT_OWNED',
        `Action ${actionKey} does not belong to ${serviceKey}`,
        { actionKey, serviceKey }
      );
    }
    return actionKey;
  }

  function inspectOwnedJob(jobId) {
    const normalizedJobId = requireText(jobId, 'jobId');
    const snapshot = supervisor.inspect(normalizedJobId);
    if (snapshot && !allowedActions.has(snapshot.actionKey)) {
      throw new ServiceClientError(
        'SERVICE_CLIENT_JOB_NOT_OWNED',
        `Job ${normalizedJobId} does not belong to ${serviceKey}`,
        { actionKey: snapshot.actionKey, jobId: normalizedJobId, serviceKey }
      );
    }
    return Object.freeze({ jobId: normalizedJobId, snapshot: snapshot || null });
  }

  return Object.freeze({
    serviceKey,
    actionKeys,
    start(request) {
      assertOwnedAction(request);
      return supervisor.start(request);
    },
    execute(request) {
      assertOwnedAction(request);
      return supervisor.execute(request);
    },
    cancel(jobId, reason = { reason: 'cancelled' }) {
      const owned = inspectOwnedJob(jobId);
      return supervisor.cancel(owned.jobId, reason);
    },
    inspect(jobId) {
      return inspectOwnedJob(jobId).snapshot;
    },
    close() {
      return supervisor.closeService(serviceKey);
    }
  });
}

module.exports = {
  ServiceClientError,
  createServiceClient
};
