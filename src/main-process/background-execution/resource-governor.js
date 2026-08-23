'use strict';

const crypto = require('node:crypto');

const {
  PRIORITIES,
  DEFER_ADMISSION,
  MAX_TIMER_DELAY_MS,
  createAdmissionQueue
} = require('./admission-queue');
const {
  ResourceGovernorError,
  checkedAdd,
  checkedMultiply,
  checkedSubtract,
  createResourceLease,
  fitsWithin,
  positiveDelta,
  validateResourceVector,
  zeroResourceVector
} = require('./resource-lease');

const LOW_MEMORY_BEHAVIORS = Object.freeze(['queue', 'reject', 'downgrade-to-single']);
const governorClosers = new WeakMap();
const governorDeferredReleasers = new WeakMap();

function defaultIdFactory(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function assertNonEmptyString(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ResourceGovernorError('RESOURCE_REQUEST_INVALID', `${name} must be a non-empty string`);
  }
  return value;
}

function validateRequest(request, kind) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ResourceGovernorError('RESOURCE_REQUEST_INVALID', 'Resource request must be an object');
  }
  const lowMemoryBehavior = request.lowMemoryBehavior || 'queue';
  if (!LOW_MEMORY_BEHAVIORS.includes(lowMemoryBehavior)) {
    throw new ResourceGovernorError(
      'RESOURCE_LOW_MEMORY_BEHAVIOR_INVALID',
      `Unsupported lowMemoryBehavior: ${lowMemoryBehavior}`
    );
  }
  if (lowMemoryBehavior === 'downgrade-to-single' && kind !== 'compound') {
    throw new ResourceGovernorError(
      'RESOURCE_DOWNGRADE_INVALID',
      'downgrade-to-single is only valid for a CompoundLease'
    );
  }
  const priority = request.priority || 'normal';
  if (!PRIORITIES.includes(priority)) {
    throw new ResourceGovernorError('RESOURCE_PRIORITY_INVALID', `Unsupported admission priority: ${priority}`);
  }
  const timeoutMs = request.timeoutMs === undefined ? Infinity : request.timeoutMs;
  if (timeoutMs !== Infinity &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS)) {
    throw new ResourceGovernorError(
      'RESOURCE_TIMEOUT_INVALID',
      `timeoutMs must be Infinity or an integer between 0 and ${MAX_TIMER_DELAY_MS}`
    );
  }
  if (request.signal !== undefined &&
      (!request.signal || typeof request.signal.addEventListener !== 'function' ||
        typeof request.signal.removeEventListener !== 'function')) {
    throw new ResourceGovernorError('RESOURCE_SIGNAL_INVALID', 'signal must be an AbortSignal');
  }
  if (request.signal && request.signal.aborted) {
    throw new ResourceGovernorError('ADMISSION_CANCELLED', 'Resource request was already cancelled');
  }
  return Object.freeze({
    kind,
    ownerKey: assertNonEmptyString(request.ownerKey, 'ownerKey'),
    actionKey: assertNonEmptyString(request.actionKey, 'actionKey'),
    operationKey: request.operationKey === undefined || request.operationKey === null
      ? null
      : assertNonEmptyString(request.operationKey, 'operationKey'),
    priority,
    timeoutMs,
    signal: request.signal,
    lowMemoryBehavior
  });
}

function createResourceGovernor(options = {}) {
  const budgets = validateResourceVector(options.budgets, 'budgets');
  const now = options.now || Date.now;
  const idFactory = options.idFactory || defaultIdFactory;
  const diagnosticsSink = options.diagnostics || (() => {});
  const queue = createAdmissionQueue({
    now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    agingMs: options.agingMs
  });
  const leases = new Map();
  const dependenciesByParent = new Map();
  const deferredParentReleases = new Map();
  const grantDeliveryProtected = new Set();
  const usedIds = new Set();
  let dependencySequence = 0;
  let activeUsage = zeroResourceVector();
  let accepting = true;
  const counters = {
    granted: 0,
    released: 0,
    duplicateRelease: 0,
    rejected: 0,
    downgraded: 0,
    replacements: 0
  };

  function emit(type, details) {
    try {
      diagnosticsSink(Object.freeze({ type, at: now(), ...details }));
    } catch (_error) {}
  }

  function ownerKeyHash(ownerKey) {
    return crypto.createHash('sha256').update(ownerKey).digest('hex');
  }

  function nextId(prefix) {
    const id = idFactory(prefix);
    assertNonEmptyString(id, `${prefix} id`);
    if (usedIds.has(id)) {
      throw new ResourceGovernorError('RESOURCE_ID_REUSED', `Resource ID was reused: ${id}`);
    }
    usedIds.add(id);
    return id;
  }

  function canAdd(resources) {
    try {
      return fitsWithin(checkedAdd(activeUsage, resources), budgets);
    } catch (error) {
      if (error instanceof ResourceGovernorError && error.code === 'RESOURCE_VECTOR_OVERFLOW') return false;
      throw error;
    }
  }

  function snapshotTopology(topology) {
    if (!topology) return null;
    return Object.freeze({
      base: topology.base,
      phase: topology.phase,
      childResource: topology.childResource,
      childrenMax: topology.childrenMax,
      effectiveChildCount: topology.effectiveChildCount,
      existingBaseLeaseId: topology.existingBaseLeaseId || null
    });
  }

  function assertParentDeliveryComplete(parent, errorOptions = {}) {
    if (!parent || !grantDeliveryProtected.has(parent.leaseId)) return parent;
    throw new ResourceGovernorError(
      errorOptions.code || 'RESOURCE_PARENT_DELIVERY_PENDING',
      errorOptions.message || 'A resource cannot be used as a parent before its grant is delivered'
    );
  }

  function createParentDependency(parent, kind) {
    assertParentDeliveryComplete(parent);
    const dependency = {
      id: ++dependencySequence,
      kind,
      parentLeaseId: parent.leaseId,
      childLeaseId: null,
      active: true
    };
    const dependencies = dependenciesByParent.get(parent.leaseId) || new Set();
    dependencies.add(dependency);
    dependenciesByParent.set(parent.leaseId, dependencies);
    return dependency;
  }

  function releaseParentDependency(dependency, { flushDeferred = true } = {}) {
    if (!dependency || !dependency.active) return false;
    dependency.active = false;
    const dependencies = dependenciesByParent.get(dependency.parentLeaseId);
    if (dependencies) {
      dependencies.delete(dependency);
      if (dependencies.size === 0) dependenciesByParent.delete(dependency.parentLeaseId);
    }
    if (flushDeferred && !dependenciesByParent.has(dependency.parentLeaseId) &&
        deferredParentReleases.has(dependency.parentLeaseId)) {
      const reason = deferredParentReleases.get(dependency.parentLeaseId);
      deferredParentReleases.delete(dependency.parentLeaseId);
      release(dependency.parentLeaseId, reason);
    }
    return true;
  }

  function assertReplacementParentIsAdopted(parent) {
    if (parent.replacesReservationId !== null ||
        (parent.parentDependency && parent.parentDependency.active)) {
      throw new ResourceGovernorError(
        'RESOURCE_REPLACEMENT_PARENT_TENTATIVE',
        'A tentative replacement cannot be used as a replacement parent'
      );
    }
  }

  function validateParentDependency(dependency, expected) {
    const parent = dependency && dependency.active ? leases.get(dependency.parentLeaseId) : null;
    if (!parent || parent.releasedAt !== null || parent.kind !== expected.kind) {
      throw new ResourceGovernorError(expected.staleCode, expected.staleMessage);
    }
    assertParentDeliveryComplete(parent);
    if (expected.ownerKey !== undefined && parent.ownerKey !== expected.ownerKey) {
      throw new ResourceGovernorError(expected.identityCode, expected.identityMessage);
    }
    if (expected.actionKey !== undefined && parent.actionKey !== expected.actionKey) {
      throw new ResourceGovernorError(
        'RESOURCE_REPLACEMENT_ACTION_MISMATCH',
        'Replacement reservation action identity does not match'
      );
    }
    if (expected.operationKey !== undefined && parent.operationKey !== expected.operationKey) {
      throw new ResourceGovernorError(
        'RESOURCE_REPLACEMENT_OPERATION_MISMATCH',
        'Replacement reservation operation identity does not match'
      );
    }
    return parent;
  }

  function grant(prepared, contribution, details = {}) {
    const leaseId = nextId('lease');
    const nextUsage = checkedAdd(activeUsage, contribution);
    const record = {
      leaseId,
      kind: prepared.kind,
      ownerKey: prepared.ownerKey,
      actionKey: prepared.actionKey,
      operationKey: prepared.operationKey,
      resources: prepared.resources,
      usageContribution: contribution,
      grantedAt: now(),
      releasedAt: null,
      releaseReason: null,
      replacesReservationId: details.replacesReservationId || null,
      effectiveChildCount: details.effectiveChildCount,
      downgraded: details.downgraded === true,
      downgradeReason: details.downgradeReason || null,
      topology: snapshotTopology(details.topology)
    };
    activeUsage = nextUsage;
    leases.set(record.leaseId, record);
    record.parentDependency = details.parentDependency || null;
    if (record.parentDependency) record.parentDependency.childLeaseId = record.leaseId;
    counters.granted += 1;
    if (record.downgraded) counters.downgraded += 1;
    grantDeliveryProtected.add(record.leaseId);
    try {
      emit('resource-granted', {
        leaseId: record.leaseId,
        kind: record.kind,
        ownerKeyHash: ownerKeyHash(record.ownerKey),
        downgraded: record.downgraded
      });
    } finally {
      queueMicrotask(() => grantDeliveryProtected.delete(record.leaseId));
    }
    return createResourceLease(record, release);
  }

  function unavailable(prepared) {
    counters.rejected += 1;
    const hashedOwner = ownerKeyHash(prepared.ownerKey);
    emit('resource-rejected', { kind: prepared.kind, ownerKeyHash: hashedOwner });
    return new ResourceGovernorError(
      'RESOURCE_BUDGET_UNAVAILABLE',
      `Resource budget is unavailable for ${prepared.kind}`,
      Object.freeze({ kind: prepared.kind, ownerKeyHash: hashedOwner })
    );
  }

  function enqueue(prepared, attempt, admissionOptions = {}) {
    const cleanupRejected = typeof admissionOptions.onRejected === 'function'
      ? admissionOptions.onRejected
      : () => {};
    let rejectionCleaned = false;
    const onRejected = () => {
      if (rejectionCleaned) return false;
      rejectionCleaned = true;
      cleanupRejected();
      return true;
    };
    if (!accepting) {
      onRejected();
      return Promise.reject(new ResourceGovernorError(
        'RESOURCE_GOVERNOR_CLOSED',
        'ResourceGovernor is not accepting requests'
      ));
    }
    if (queue.snapshot().size === 0) {
      let immediate;
      try {
        immediate = attempt();
      } catch (error) {
        onRejected();
        return Promise.reject(error);
      }
      if (immediate !== DEFER_ADMISSION) return Promise.resolve(immediate);
      if (prepared.lowMemoryBehavior === 'reject') {
        onRejected();
        return Promise.reject(unavailable(prepared));
      }
    }
    let requestId;
    try {
      requestId = nextId('admission');
    } catch (error) {
      onRejected();
      return Promise.reject(error);
    }
    return queue.enqueue({
      requestId,
      priority: prepared.priority,
      timeoutMs: prepared.timeoutMs,
      signal: prepared.signal,
      payload: Object.freeze({
        attempt,
        prepared,
        rejectOnUnavailable: prepared.lowMemoryBehavior === 'reject'
      }),
      onSettled(status) {
        if (status === 'rejected') onRejected();
      }
    }).catch((error) => {
      onRejected();
      throw error;
    });
  }

  queue.drain((queued) => {
    const result = queued.attempt();
    if (result === DEFER_ADMISSION && queued.rejectOnUnavailable) throw unavailable(queued.prepared);
    return result;
  });

  function acquireExact(kind, request) {
    let common;
    let resources;
    try {
      common = validateRequest(request, kind);
      resources = validateResourceVector(request.resources);
    } catch (error) {
      return Promise.reject(error);
    }
    const prepared = Object.freeze({ ...common, resources });
    return enqueue(prepared, () => {
      if (!canAdd(resources)) return DEFER_ADMISSION;
      return grant(prepared, resources);
    });
  }

  function acquirePersistentReservation(request) {
    let common;
    let resources;
    let replacesReservationId;
    let parentDependency = null;
    try {
      common = validateRequest(request, 'persistent');
      resources = validateResourceVector(request.resources);
      replacesReservationId = request.replacesReservationId === undefined
        ? null
        : request.replacesReservationId;
      if (replacesReservationId !== null) {
        assertNonEmptyString(replacesReservationId, 'replacesReservationId');
        const old = leases.get(replacesReservationId);
        if (!old || old.releasedAt !== null || old.kind !== 'persistent') {
          throw new ResourceGovernorError(
            'RESOURCE_REPLACEMENT_STALE',
            'Replacement must reference an active persistent reservation'
          );
        }
        assertReplacementParentIsAdopted(old);
        const existingDependencies = dependenciesByParent.get(old.leaseId);
        if (existingDependencies && [...existingDependencies]
          .some((dependency) => dependency.active && dependency.kind === 'replacement')) {
          throw new ResourceGovernorError(
            'RESOURCE_REPLACEMENT_IN_PROGRESS',
            'Persistent reservation already has a pending or tentative replacement'
          );
        }
        parentDependency = createParentDependency(old, 'replacement');
        validateParentDependency(parentDependency, {
          kind: 'persistent',
          ownerKey: common.ownerKey,
          actionKey: common.actionKey,
          operationKey: common.operationKey,
          staleCode: 'RESOURCE_REPLACEMENT_STALE',
          staleMessage: 'Replacement must reference an active persistent reservation',
          identityCode: 'RESOURCE_REPLACEMENT_OWNER_MISMATCH',
          identityMessage: 'Replacement reservation owner identity does not match'
        });
      }
    } catch (error) {
      releaseParentDependency(parentDependency);
      return Promise.reject(error);
    }
    const prepared = Object.freeze({ ...common, resources });
    return enqueue(prepared, () => {
      let contribution = resources;
      if (parentDependency) {
        const old = validateParentDependency(parentDependency, {
          kind: 'persistent',
          ownerKey: common.ownerKey,
          actionKey: common.actionKey,
          operationKey: common.operationKey,
          staleCode: 'RESOURCE_REPLACEMENT_STALE',
          staleMessage: 'Replacement must reference an active persistent reservation',
          identityCode: 'RESOURCE_REPLACEMENT_OWNER_MISMATCH',
          identityMessage: 'Replacement reservation owner identity does not match'
        });
        assertReplacementParentIsAdopted(old);
        contribution = positiveDelta(resources, old.resources);
      }
      if (!canAdd(contribution)) return DEFER_ADMISSION;
      return grant(prepared, contribution, { replacesReservationId, parentDependency });
    }, { onRejected: () => releaseParentDependency(parentDependency) });
  }

  function validateCount(value, name, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new ResourceGovernorError(
        'RESOURCE_COMPOUND_COUNT_INVALID',
        `${name} must be a non-negative safe integer not greater than ${maximum}`
      );
    }
    return value;
  }

  function acquireCompoundLease(request) {
    let common;
    let base;
    let phase;
    let childResource;
    let childrenMax;
    let requestedChildCount;
    let existingBase = null;
    let parentDependency = null;
    try {
      common = validateRequest(request, 'compound');
      base = validateResourceVector(request.base, 'base');
      phase = validateResourceVector(request.phase, 'phase');
      childResource = validateResourceVector(request.childResource, 'childResource');
      childrenMax = validateCount(request.childrenMax, 'childrenMax', { maximum: 128 });
      requestedChildCount = validateCount(request.effectiveChildCount, 'effectiveChildCount');
      if (requestedChildCount > childrenMax) {
        throw new ResourceGovernorError(
          'RESOURCE_COMPOUND_COUNT_INVALID',
          'effectiveChildCount must not exceed childrenMax'
        );
      }
      if (request.existingBaseLeaseId !== undefined && request.existingBaseLeaseId !== null) {
        assertNonEmptyString(request.existingBaseLeaseId, 'existingBaseLeaseId');
        existingBase = leases.get(request.existingBaseLeaseId);
        if (!existingBase || existingBase.releasedAt !== null || existingBase.kind !== 'base') {
          throw new ResourceGovernorError(
            'RESOURCE_COMPOUND_BASE_STALE',
            'existingBaseLeaseId must reference an active BaseLease'
          );
        }
        if (existingBase.ownerKey !== common.ownerKey) {
          throw new ResourceGovernorError(
            'RESOURCE_COMPOUND_BASE_OWNER_MISMATCH',
            'Compound BaseLease owner identity does not match'
          );
        }
        if (JSON.stringify(existingBase.resources) !== JSON.stringify(base)) {
          throw new ResourceGovernorError(
            'RESOURCE_COMPOUND_BASE_MISMATCH',
            'Compound base vector must equal the referenced BaseLease vector'
          );
        }
        parentDependency = createParentDependency(existingBase, 'compound');
      }
    } catch (error) {
      releaseParentDependency(parentDependency);
      return Promise.reject(error);
    }

    function prepareForCount(effectiveChildCount) {
      const childTotal = checkedMultiply(childResource, effectiveChildCount, 'compound children');
      const fullResources = checkedAdd(checkedAdd(base, phase, 'compound root and phase'), childTotal, 'compound total');
      const downgraded = effectiveChildCount !== requestedChildCount;
      return {
        prepared: Object.freeze({ ...common, resources: fullResources }),
        details: {
          effectiveChildCount,
          downgraded,
          downgradeReason: downgraded ? 'resource-budget' : null,
          topology: {
            base,
            phase,
            childResource,
            childrenMax,
            effectiveChildCount,
            existingBaseLeaseId: existingBase ? existingBase.leaseId : null
          }
        }
      };
    }

    let requested;
    let single;
    try {
      requested = prepareForCount(requestedChildCount);
      single = common.lowMemoryBehavior === 'downgrade-to-single' && requestedChildCount > 1
        ? prepareForCount(1)
        : null;
    } catch (error) {
      releaseParentDependency(parentDependency);
      return Promise.reject(error);
    }

    function contributionFor(candidate) {
      if (!parentDependency) return candidate.prepared.resources;
      const parent = validateParentDependency(parentDependency, {
        kind: 'base',
        ownerKey: common.ownerKey,
        staleCode: 'RESOURCE_COMPOUND_BASE_STALE',
        staleMessage: 'existingBaseLeaseId must reference an active BaseLease',
        identityCode: 'RESOURCE_COMPOUND_BASE_OWNER_MISMATCH',
        identityMessage: 'Compound BaseLease owner identity does not match'
      });
      if (JSON.stringify(parent.resources) !== JSON.stringify(base)) {
        throw new ResourceGovernorError(
          'RESOURCE_COMPOUND_BASE_MISMATCH',
          'Compound base vector must equal the referenced BaseLease vector'
        );
      }
      return checkedSubtract(candidate.prepared.resources, parent.resources, 'compound incremental usage');
    }

    return enqueue(requested.prepared, () => {
      const requestedContribution = contributionFor(requested);
      if (canAdd(requestedContribution)) {
        return grant(requested.prepared, requestedContribution, {
          ...requested.details,
          parentDependency
        });
      }
      if (single) {
        const singleContribution = contributionFor(single);
        if (canAdd(singleContribution)) {
          return grant(single.prepared, singleContribution, {
            ...single.details,
            parentDependency
          });
        }
      }
      return DEFER_ADMISSION;
    }, { onRejected: () => releaseParentDependency(parentDependency) });
  }

  function release(resourceId, reason = 'released') {
    assertNonEmptyString(resourceId, 'resourceId');
    assertNonEmptyString(reason, 'release reason');
    const record = leases.get(resourceId);
    if (!record || record.releasedAt !== null) {
      counters.duplicateRelease += 1;
      emit('resource-release-ignored', { resourceId, reason });
      return false;
    }
    if (grantDeliveryProtected.has(resourceId)) {
      emit('resource-release-delivery-protected', { resourceId, reason });
      return false;
    }
    const dependents = dependenciesByParent.get(resourceId);
    if (dependents && dependents.size > 0) {
      emit('resource-release-blocked', { resourceId, reason, dependentCount: dependents.size });
      throw new ResourceGovernorError(
        'RESOURCE_DEPENDENCY_ACTIVE',
        `Resource ${resourceId} has active dependent reservations`,
        Object.freeze({ resourceId, dependentCount: dependents.size })
      );
    }
    activeUsage = checkedSubtract(activeUsage, record.usageContribution);
    record.releasedAt = now();
    record.releaseReason = reason;
    releaseParentDependency(record.parentDependency);
    record.parentDependency = null;
    counters.released += 1;
    emit('resource-released', { resourceId, kind: record.kind, reason });
    queue.drain();
    return true;
  }

  function releaseWhenUnreferenced(resourceId, reason = 'released') {
    assertNonEmptyString(resourceId, 'resourceId');
    assertNonEmptyString(reason, 'release reason');
    const record = leases.get(resourceId);
    if (!record || record.releasedAt !== null) return false;
    const dependents = dependenciesByParent.get(resourceId);
    if (dependents && dependents.size > 0) {
      if (!deferredParentReleases.has(resourceId)) deferredParentReleases.set(resourceId, reason);
      emit('resource-release-deferred', { resourceId, reason, dependentCount: dependents.size });
      return false;
    }
    return release(resourceId, reason);
  }

  function adoptTentativeReplacement(oldReservationId, tentativeReservationId) {
    const old = leases.get(oldReservationId);
    const candidate = leases.get(tentativeReservationId);
    if (!old || old.releasedAt !== null || old.kind !== 'persistent') {
      throw new ResourceGovernorError('RESOURCE_REPLACEMENT_STALE', 'Old persistent reservation is not active');
    }
    assertReplacementParentIsAdopted(old);
    assertParentDeliveryComplete(old, {
      code: 'RESOURCE_REPLACEMENT_PARENT_DELIVERY_PENDING',
      message: 'Old reservation cannot be replaced before its grant is delivered'
    });
    if (!candidate || candidate.releasedAt !== null || candidate.kind !== 'persistent' ||
        candidate.replacesReservationId !== oldReservationId) {
      throw new ResourceGovernorError(
        'RESOURCE_REPLACEMENT_CANDIDATE_INVALID',
        'Tentative reservation does not replace the specified active reservation'
      );
    }
    assertParentDeliveryComplete(candidate, {
      code: 'RESOURCE_REPLACEMENT_CANDIDATE_DELIVERY_PENDING',
      message: 'Tentative reservation cannot be adopted before its grant is delivered'
    });
    if (candidate.ownerKey !== old.ownerKey) {
      throw new ResourceGovernorError(
        'RESOURCE_REPLACEMENT_OWNER_MISMATCH',
        'Tentative reservation owner identity does not match the old reservation'
      );
    }
    if (candidate.actionKey !== old.actionKey) {
      throw new ResourceGovernorError(
        'RESOURCE_REPLACEMENT_ACTION_MISMATCH',
        'Tentative reservation action identity does not match the old reservation'
      );
    }
    if (candidate.operationKey !== old.operationKey) {
      throw new ResourceGovernorError(
        'RESOURCE_REPLACEMENT_OPERATION_MISMATCH',
        'Tentative reservation operation identity does not match the old reservation'
      );
    }
    if (!candidate.parentDependency || !candidate.parentDependency.active ||
        candidate.parentDependency.parentLeaseId !== oldReservationId) {
      throw new ResourceGovernorError(
        'RESOURCE_REPLACEMENT_CANDIDATE_INVALID',
        'Tentative reservation no longer holds its replacement dependency'
      );
    }
    const oldDependents = dependenciesByParent.get(oldReservationId);
    if (!oldDependents || oldDependents.size !== 1 || !oldDependents.has(candidate.parentDependency)) {
      throw new ResourceGovernorError(
        'RESOURCE_DEPENDENCY_ACTIVE',
        'Old reservation has another active dependent and cannot be replaced'
      );
    }
    const withoutBoth = checkedSubtract(
      checkedSubtract(activeUsage, old.usageContribution),
      candidate.usageContribution
    );
    const replacementUsage = checkedAdd(withoutBoth, candidate.resources);
    if (!fitsWithin(replacementUsage, budgets)) {
      throw unavailable(candidate);
    }
    releaseParentDependency(candidate.parentDependency, { flushDeferred: false });
    candidate.parentDependency = null;
    deferredParentReleases.delete(oldReservationId);
    old.releasedAt = now();
    old.releaseReason = 'atomic-replacement';
    candidate.usageContribution = candidate.resources;
    candidate.replacesReservationId = null;
    activeUsage = replacementUsage;
    counters.released += 1;
    counters.replacements += 1;
    grantDeliveryProtected.add(candidate.leaseId);
    try {
      emit('resource-replaced', {
        oldReservationId,
        reservationId: tentativeReservationId,
        ownerKeyHash: ownerKeyHash(candidate.ownerKey)
      });
    } finally {
      queueMicrotask(() => grantDeliveryProtected.delete(candidate.leaseId));
    }
    queue.drain();
    return createResourceLease(candidate, release);
  }

  async function replaceReservationAtomically({ oldReservationId, nextRequest } = {}) {
    assertNonEmptyString(oldReservationId, 'oldReservationId');
    if (!nextRequest || typeof nextRequest !== 'object' || Array.isArray(nextRequest)) {
      throw new ResourceGovernorError('RESOURCE_REPLACEMENT_REQUEST_INVALID', 'nextRequest must be an object');
    }
    if (nextRequest.tentativeReservationId !== undefined) {
      assertNonEmptyString(nextRequest.tentativeReservationId, 'tentativeReservationId');
      return adoptTentativeReplacement(oldReservationId, nextRequest.tentativeReservationId);
    }
    const candidate = await acquirePersistentReservation({
      ...nextRequest,
      replacesReservationId: oldReservationId
    });
    try {
      return adoptTentativeReplacement(oldReservationId, candidate.leaseId);
    } catch (error) {
      candidate.release('atomic-replacement-failed');
      throw error;
    }
  }

  function snapshotRecord(record) {
    return Object.freeze({
      leaseId: record.leaseId,
      kind: record.kind,
      ownerKeyHash: ownerKeyHash(record.ownerKey),
      actionKey: record.actionKey,
      operationKey: record.operationKey,
      resources: record.resources,
      usageContribution: record.usageContribution,
      grantedAt: record.grantedAt,
      releasedAt: record.releasedAt,
      releaseReason: record.releaseReason,
      replacesReservationId: record.replacesReservationId,
      downgraded: record.downgraded,
      downgradeReason: record.downgradeReason,
      topology: record.topology
    });
  }

  function snapshot() {
    const activeLeases = [...leases.values()].filter((record) => record.releasedAt === null);
    return Object.freeze({
      accepting,
      budgets,
      activeUsage,
      available: checkedSubtract(budgets, activeUsage),
      activeLeaseCount: activeLeases.length,
      activeDependencyCount: [...dependenciesByParent.values()]
        .reduce((count, dependencies) => count + dependencies.size, 0),
      activeLeases: Object.freeze(activeLeases.map(snapshotRecord)),
      queued: queue.snapshot(),
      diagnostics: Object.freeze({ ...counters })
    });
  }

  function close(reason = 'ResourceGovernor closed') {
    if (!accepting) return false;
    accepting = false;
    queue.close(reason);
    return true;
  }

  const governor = Object.freeze({
    acquireBaseLease: (request) => acquireExact('base', request),
    acquirePersistentReservation,
    acquirePendingInteractionReservation: (request) => acquireExact('pending-interaction', request),
    acquirePhaseLease: (request) => acquireExact('phase', request),
    acquireCompoundLease,
    replaceReservationAtomically,
    release,
    snapshot
  });
  governorClosers.set(governor, close);
  governorDeferredReleasers.set(governor, releaseWhenUnreferenced);
  return governor;
}

function closeResourceGovernor(governor, reason) {
  const close = governorClosers.get(governor);
  return close ? close(reason) : false;
}

function releaseResourceWhenUnreferenced(governor, resourceId, reason) {
  const release = governorDeferredReleasers.get(governor);
  return release ? release(resourceId, reason) : false;
}

module.exports = {
  closeResourceGovernor,
  createResourceGovernor,
  releaseResourceWhenUnreferenced
};
