'use strict';

const { isDeepStrictEqual } = require('node:util');

const {
  canonicalJsonSnapshot,
  policyForAction,
  validateEnvelope
} = require('./protocol-validator');
const { createDirectionSequenceTracker } = require('./sequence-tracker');

function validateProtocolSequence(messages, options = {}) {
  const errors = [];
  const sequenceTracker = createDirectionSequenceTracker();
  const jobIdentities = new Map();

  function add(code, index, message, path = '/') {
    errors.push(Object.freeze({ code, index, path, message }));
  }

  let sequenceMessages;
  try {
    sequenceMessages = canonicalJsonSnapshot(messages);
  } catch (error) {
    add(error.code || 'PROTOCOL_SEQUENCE_INPUT_INVALID', -1, error.message, error.path);
    return Object.freeze({ valid: false, errors: Object.freeze(errors) });
  }
  if (!Array.isArray(sequenceMessages)) {
    add('PROTOCOL_SEQUENCE_INPUT_INVALID', -1, 'Protocol sequence must be an array');
    return Object.freeze({ valid: false, errors: Object.freeze(errors) });
  }
  const ownedMessages = new Array(sequenceMessages.length).fill(null);

  sequenceMessages.forEach((message, index) => {
    let ownedMessage;
    try {
      ownedMessage = validateEnvelope(message, { policyRegistry: options.policyRegistry });
      ownedMessages[index] = ownedMessage;
    } catch (error) {
      add(error.code || 'PROTOCOL_SCHEMA_INVALID', index, error.message, error.path);
      return;
    }
    if (ownedMessage.channel === 'job') {
      const identity = [
        ownedMessage.actionKey,
        ownedMessage.operationKey,
        ownedMessage.workerInstanceId,
        ownedMessage.serviceGeneration
      ];
      const prior = jobIdentities.get(ownedMessage.jobId);
      if (prior && !isDeepStrictEqual(prior, identity)) {
        add('PROTOCOL_JOB_ROUTE_CHANGED', index, 'Job route or generation changed within a sequence');
      } else if (!prior) {
        jobIdentities.set(ownedMessage.jobId, identity);
      }
    }
    try {
      sequenceTracker.observe(ownedMessage);
    } catch (error) {
      add(error.code || 'PROTOCOL_SEQUENCE_INVALID', index, error.message, error.path);
    }
  });

  validateJobUnits(ownedMessages, options.policyRegistry, add);
  validateServiceResources(ownedMessages, add);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function validateJobUnits(messages, registry, add) {
  const jobMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message && message.channel === 'job');
  if (!jobMessages.length) return;
  const units = new Map();
  const unknownUnits = new Set();
  let terminalSeen = false;
  const policy = policyForAction(registry, jobMessages[0].message.actionKey) || {};
  const failure = policy.failure || {};
  const allowUnitError = failure.unitBusinessError === 'collect-and-continue' ||
    failure.unitTransportCrash === 'fail-unit-and-continue';

  jobMessages.forEach(({ message, index }) => {
    const operation = message.operation;
    const unitId = String(message.unitId);
    if (terminalSeen) {
      add('PROTOCOL_LATE_JOB_MESSAGE', index, 'Job message arrived after execution terminal');
      return;
    }
    if (operation === 'unit:start') {
      if (units.has(unitId)) add('PROTOCOL_DUPLICATE_UNIT', index, `Duplicate registered unit ${unitId}`);
      else units.set(unitId, 'running');
    } else if (['unit:progress', 'unit:done', 'unit:error', 'unit:cancel'].includes(operation)) {
      if (!units.has(unitId)) {
        unknownUnits.add(unitId);
        add('PROTOCOL_UNKNOWN_UNIT', index, `Message references unknown unit ${unitId}`);
      } else if (units.get(unitId) !== 'running') {
        add(
          ['done', 'error', 'cancelled'].includes(units.get(unitId))
            ? 'PROTOCOL_UNIT_TERMINAL_IMMUTABLE'
            : 'PROTOCOL_UNIT_STATE_INVALID',
          index,
          `Unit ${unitId} cannot accept ${operation} while ${units.get(unitId)}`
        );
      } else if (operation === 'unit:done') units.set(unitId, 'done');
      else if (operation === 'unit:error') units.set(unitId, 'error');
      else if (operation === 'unit:cancel') units.set(unitId, 'cancelled');
    } else if (operation === 'job:done') {
      const invalid = [...units.values()].some((state) => state !== 'done' && !(allowUnitError && state === 'error'));
      if (unknownUnits.size || invalid) {
        add('PROTOCOL_JOB_DONE_GATE_FAILED', index, 'job:done has unknown or non-terminal units');
      }
      terminalSeen = true;
    } else if (operation === 'job:error') {
      for (const [key, state] of units) {
        if (state === 'running') units.set(key, 'cancelled');
      }
      terminalSeen = true;
    }
  });
}

function validateServiceResources(messages, add) {
  const serviceMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message && message.channel === 'service-control');
  if (!serviceMessages.length) return;
  const canonicalIdentity = [
    serviceMessages[0].message.serviceKey,
    serviceMessages[0].message.workerInstanceId,
    serviceMessages[0].message.serviceGeneration
  ];
  let lifecycle = 'new';
  let closeCommand = null;
  let closeAck = false;
  const usedControlIds = new Map();
  const usedGrantIds = new Set();
  const usedReservationIds = new Set();
  const requests = new Map();
  const requestStates = new Map();
  const requestByReservation = new Map();
  const grants = new Map();
  const adopted = new Map();
  const adoptAcks = new Set();
  const activeReservations = new Map();
  const releases = new Map();
  const revokes = new Map();
  const tentativeRevocations = new Set();
  const releaseAcks = new Set();
  const currentReservationByOwner = new Map();
  const pendingRequestByOwner = new Map();
  const ownerByReservation = new Map();
  const replacedReservations = new Set();
  const tentativeReplacementByOld = new Map();

  function jobRefEqual(left, right) {
    return isDeepStrictEqual(left.jobRef, right.jobRef);
  }

  function ownerKey(owner = {}) {
    return JSON.stringify([owner.kind, owner.ownerKeyHash]);
  }

  function claimControl(message, index, kind, key = null) {
    const prior = usedControlIds.get(message.controlId);
    if (prior) {
      add(
        'PROTOCOL_CONTROL_ID_REUSED',
        index,
        `controlId ${message.controlId} was already used by ${prior.kind}`
      );
      return false;
    }
    usedControlIds.set(message.controlId, Object.freeze({ kind, key }));
    return true;
  }

  function tombstoneUnexpectedResponse(message, index, kind, key = null) {
    if (!usedControlIds.has(message.controlId)) {
      usedControlIds.set(message.controlId, Object.freeze({ kind: `invalid-${kind}`, key }));
    } else {
      add(
        'PROTOCOL_CONTROL_ID_REUSED',
        index,
        `Unexpected response reused controlId ${message.controlId}`
      );
    }
  }

  function exactResponseControl(initiator, response, index, kind, key = null) {
    if (!initiator || initiator.controlId !== response.controlId) {
      tombstoneUnexpectedResponse(response, index, kind, key);
      add(
        'PROTOCOL_CONTROL_ID_MISMATCH',
        index,
        `${response.operation} must exactly echo the initiating controlId`
      );
      return false;
    }
    const exchange = usedControlIds.get(response.controlId);
    if (!exchange || exchange.kind !== kind || exchange.key !== key) {
      add(
        'PROTOCOL_CONTROL_ID_MISMATCH',
        index,
        `${response.operation} does not match its initiating control exchange`
      );
      return false;
    }
    return true;
  }

  function claimGrantIdentities(payload, index) {
    let valid = true;
    if (usedGrantIds.has(payload.grantId)) {
      add('PROTOCOL_GRANT_ID_REUSED', index, `grantId ${payload.grantId} was already used`);
      valid = false;
    } else {
      usedGrantIds.add(payload.grantId);
    }
    if (usedReservationIds.has(payload.reservationId)) {
      add(
        'PROTOCOL_RESERVATION_ID_REUSED',
        index,
        `reservationId ${payload.reservationId} was already used`
      );
      valid = false;
    } else {
      usedReservationIds.add(payload.reservationId);
    }
    return valid;
  }

  function hasPendingResourceExchange() {
    return [...requestStates.values()].some(({ state }) =>
      [
        'requested',
        'granted',
        'adopted',
        'revoked-tentative',
        'revoked-active',
        'released'
      ].includes(state));
  }

  function markFatalResourceCleanup() {
    const unfinishedStates = new Set([
      'requested',
      'granted',
      'adopted',
      'acked',
      'revoked-tentative',
      'revoked-active',
      'released'
    ]);
    for (const requestState of requestStates.values()) {
      if (unfinishedStates.has(requestState.state)) requestState.state = 'terminal-cleanup';
    }
    activeReservations.clear();
    currentReservationByOwner.clear();
    pendingRequestByOwner.clear();
    ownerByReservation.clear();
    tentativeReplacementByOld.clear();
  }

  serviceMessages.forEach(({ message, index }) => {
    const identity = [message.serviceKey, message.workerInstanceId, message.serviceGeneration];
    if (!isDeepStrictEqual(identity, canonicalIdentity)) {
      add('PROTOCOL_SERVICE_IDENTITY_CHANGED', index, 'Service identity changed within a sequence');
    }
    const operation = message.operation;
    const payload = message.payload || {};
    if (lifecycle === 'closed' || lifecycle === 'failed') {
      if (operation === 'executor:ready') {
        add('PROTOCOL_DUPLICATE_READY', index, 'Duplicate executor:ready');
      } else if (operation === 'executor:close') {
        add('PROTOCOL_DUPLICATE_CLOSE', index, 'Duplicate executor:close');
      } else if (operation === 'executor:close-ack') {
        add('PROTOCOL_DUPLICATE_CLOSE_ACK', index, 'Duplicate executor:close-ack');
      }
      add(
        'PROTOCOL_SERVICE_MESSAGE_AFTER_TERMINAL',
        index,
        `Service message ${operation} arrived after ${lifecycle}`
      );
      return;
    }
    if (lifecycle === 'closing' && operation === 'executor:close') {
      claimControl(message, index, 'close');
      add('PROTOCOL_DUPLICATE_CLOSE', index, 'Duplicate executor:close');
      return;
    }
    if (lifecycle === 'closing' && operation === 'executor:ready') {
      claimControl(message, index, 'ready');
      add('PROTOCOL_DUPLICATE_READY', index, 'Duplicate executor:ready');
      return;
    }
    if (lifecycle === 'closing' &&
        operation !== 'executor:close-ack' && operation !== 'executor:error') {
      add(
        'PROTOCOL_SERVICE_MESSAGE_WHILE_CLOSING',
        index,
        `Service message ${operation} is not valid while closing`
      );
      return;
    }
    if (operation === 'executor:init') {
      const controlValid = claimControl(message, index, 'init');
      if (lifecycle !== 'new') {
        add('PROTOCOL_DUPLICATE_INIT', index, 'Duplicate executor:init');
        return;
      }
      if (!controlValid) return;
      lifecycle = 'initialized';
    } else if (operation === 'executor:ready') {
      const controlValid = claimControl(message, index, 'ready');
      if (lifecycle === 'ready') {
        add('PROTOCOL_DUPLICATE_READY', index, 'Duplicate executor:ready');
        return;
      }
      if (lifecycle !== 'initialized') {
        add('PROTOCOL_READY_BEFORE_INIT', index, 'executor:ready arrived before executor:init');
        return;
      }
      if (!controlValid) return;
      lifecycle = 'ready';
    } else if (operation === 'executor:error') {
      const controlValid = claimControl(message, index, 'error');
      if (lifecycle === 'new') {
        add('PROTOCOL_ERROR_BEFORE_INIT', index, 'executor:error arrived before executor:init');
      }
      if (!controlValid) return;
      markFatalResourceCleanup();
      lifecycle = 'failed';
    } else if (operation.startsWith('resource:') && operation !== 'resource:request' &&
        lifecycle !== 'ready') {
      add(
        'PROTOCOL_RESOURCE_OUTSIDE_READY',
        index,
        `${operation} is only valid while the service is ready`
      );
      return;
    } else if (operation === 'resource:request') {
      if (lifecycle !== 'ready') {
        add('PROTOCOL_REQUEST_BEFORE_READY', index, 'resource:request arrived before executor:ready');
        return;
      }
      const requestId = payload.requestId;
      if (!claimControl(message, index, 'request', requestId)) return;
      if (requests.has(requestId)) {
        add('PROTOCOL_DUPLICATE_REQUEST', index, `Duplicate resource request ${requestId}`);
        return;
      }
      const key = ownerKey(payload.owner);
      const current = currentReservationByOwner.get(key);
      const pendingOwnerRequest = pendingRequestByOwner.get(key);
      if (pendingOwnerRequest !== undefined && pendingOwnerRequest !== requestId) {
        add(
          'PROTOCOL_DUPLICATE_OWNER',
          index,
          `Owner already has live request ${pendingOwnerRequest}`
        );
      }
      if (payload.requestKind === 'persistent-state-replace') {
        if (current !== undefined && payload.replacesReservationId !== current) {
          add('PROTOCOL_STALE_REPLACEMENT', index, `Persistent owner must replace current reservation ${current}`);
        }
        if (current === undefined && payload.replacesReservationId !== null) {
          add('PROTOCOL_FIRST_REPLACEMENT_INVALID', index, 'First persistent request must not replace a reservation');
        }
      } else if (payload.replacesReservationId !== null) {
        add('PROTOCOL_REPLACEMENT_FORBIDDEN', index, `${payload.requestKind} cannot replace a reservation`);
      }
      if (current !== undefined &&
          !(payload.requestKind === 'persistent-state-replace' && payload.replacesReservationId === current)) {
        add('PROTOCOL_DUPLICATE_OWNER', index, `Owner already has active reservation ${current}`);
      }
      if (pendingOwnerRequest === undefined) pendingRequestByOwner.set(key, requestId);
      requests.set(requestId, message);
      requestStates.set(requestId, { state: 'requested', request: message });
    } else if (operation === 'resource:grant' || operation === 'resource:reject') {
      const requestId = payload.requestId;
      const grantIdentitiesValid = operation === 'resource:grant'
        ? claimGrantIdentities(payload, index)
        : true;
      const request = requests.get(requestId);
      if (!request) {
        tombstoneUnexpectedResponse(message, index, 'request-response', requestId);
        add('PROTOCOL_RESPONSE_WITHOUT_REQUEST', index, `${operation} has no matching resource:request`);
        return;
      }
      const requestState = requestStates.get(requestId);
      let responseValid = exactResponseControl(request, message, index, 'request', requestId);
      if (!jobRefEqual(request, message)) {
        add('PROTOCOL_JOB_REF_MISMATCH', index, `${operation} jobRef differs from request`);
        responseValid = false;
      }
      if (requestState.state !== 'requested') {
        if (operation === 'resource:grant' && requestState.state === 'granted') {
          add('PROTOCOL_DUPLICATE_GRANT', index, `Duplicate grant for resource request ${requestId}`);
        } else if (operation === 'resource:reject' && requestState.state === 'rejected') {
          add('PROTOCOL_DUPLICATE_REJECT', index, `Duplicate rejection for resource request ${requestId}`);
        } else {
          add(
            'PROTOCOL_RESOURCE_RESPONSE_CONFLICT',
            index,
            `${operation} conflicts with request ${requestId} state ${requestState.state}`
          );
        }
        return;
      }
      if (!responseValid) return;
      if (operation === 'resource:grant') {
        let grantValid = grantIdentitiesValid;
        if (payload.replacesReservationId !== request.payload.replacesReservationId) {
          add('PROTOCOL_REPLACEMENT_MISMATCH', index, 'Grant replacement differs from request');
          grantValid = false;
        }
        for (const field of ['memoryBytes', 'cpuSlots', 'ioHeavySlots']) {
          if (payload.granted[field] > request.payload.requested[field]) {
            add('PROTOCOL_GRANT_EXCEEDS_REQUEST', index, `Grant exceeds requested ${field}`);
            grantValid = false;
          }
        }
        if (!grantValid) return;
        grants.set(requestId, message);
        requestState.state = 'granted';
        requestState.grant = message;
        requestState.reservationId = payload.reservationId;
        requestByReservation.set(payload.reservationId, requestId);
        if (payload.replacesReservationId !== null) {
          if (tentativeReplacementByOld.has(payload.replacesReservationId)) {
            add(
              'PROTOCOL_DUPLICATE_TENTATIVE_REPLACEMENT',
              index,
              `Reservation ${payload.replacesReservationId} already has a tentative replacement`
            );
          } else {
            tentativeReplacementByOld.set(payload.replacesReservationId, payload.reservationId);
          }
        }
      } else {
        requestState.state = 'rejected';
        const key = ownerKey(request.payload.owner);
        if (pendingRequestByOwner.get(key) === requestId) pendingRequestByOwner.delete(key);
      }
    } else if (operation === 'resource:adopted') {
      const requestId = payload.requestId;
      if (!claimControl(message, index, 'adoption', requestId)) return;
      const grant = grants.get(requestId);
      const request = requests.get(requestId);
      if (!grant || !request) {
        add('PROTOCOL_ADOPTED_WITHOUT_GRANT', index, 'resource:adopted has no matching grant');
        return;
      }
      const requestState = requestStates.get(requestId);
      if (requestState.state !== 'granted') {
        if (requestState.state === 'adopted' || requestState.state === 'acked') {
          add('PROTOCOL_DUPLICATE_ADOPTED', index, `Duplicate adoption for resource request ${requestId}`);
        } else if (requestState.state === 'revoked-tentative') {
          add('PROTOCOL_ADOPT_AFTER_REVOKE', index, `Revoked request ${requestId} cannot be adopted`);
        } else {
          add(
            'PROTOCOL_ADOPTED_STATE_INVALID',
            index,
            `resource:adopted is invalid while request ${requestId} is ${requestState.state}`
          );
        }
        return;
      }
      let adoptionValid = true;
      if (payload.grantId !== grant.payload.grantId || payload.reservationId !== grant.payload.reservationId) {
        add('PROTOCOL_ADOPTED_IDENTITY_MISMATCH', index, 'Adopted grant/reservation identity mismatch');
        adoptionValid = false;
      }
      if (!isDeepStrictEqual(payload.owner, request.payload.owner)) {
        add('PROTOCOL_ADOPTED_OWNER_MISMATCH', index, 'Adopted owner differs from request');
        adoptionValid = false;
      }
      if (!jobRefEqual(grant, message)) {
        add('PROTOCOL_JOB_REF_MISMATCH', index, 'Adopted jobRef differs from grant');
        adoptionValid = false;
      }
      if (!adoptionValid) return;
      adopted.set(requestId, message);
      requestState.state = 'adopted';
      requestState.adoption = message;
    } else if (operation === 'resource:adopt-ack') {
      const requestId = payload.requestId;
      const adoption = adopted.get(requestId);
      const grant = grants.get(requestId);
      if (!adoption || !grant) {
        tombstoneUnexpectedResponse(message, index, 'adopt-ack', requestId);
        add('PROTOCOL_ADOPT_ACK_WITHOUT_ADOPTED', index, 'adopt-ack has no matching adopted/grant');
        return;
      }
      const requestState = requestStates.get(requestId);
      let adoptAckValid = exactResponseControl(adoption, message, index, 'adoption', requestId);
      if (payload.grantId !== adoption.payload.grantId || payload.reservationId !== adoption.payload.reservationId) {
        add('PROTOCOL_ADOPT_ACK_IDENTITY_MISMATCH', index, 'adopt-ack identity mismatch');
        adoptAckValid = false;
      }
      if (!jobRefEqual(adoption, message)) {
        add('PROTOCOL_JOB_REF_MISMATCH', index, 'adopt-ack jobRef differs from adopted');
        adoptAckValid = false;
      }
      if (requestState.state !== 'adopted') {
        if (requestState.state === 'acked') {
          add('PROTOCOL_DUPLICATE_ADOPT_ACK', index, `Duplicate adopt-ack for resource request ${requestId}`);
        } else {
          add(
            'PROTOCOL_ADOPT_ACK_STATE_INVALID',
            index,
            `resource:adopt-ack is invalid while request ${requestId} is ${requestState.state}`
          );
        }
        return;
      }
      if (!adoptAckValid) return;
      adoptAcks.add(requestId);
      requestState.state = 'acked';
      requestState.adoptAck = message;
      const reservationId = payload.reservationId;
      if (activeReservations.has(reservationId)) {
        add('PROTOCOL_DUPLICATE_RESERVATION', index, `Duplicate active reservation ${reservationId}`);
        return;
      }
      activeReservations.set(reservationId, requestId);
      const request = requests.get(requestId);
      const key = ownerKey(request.payload.owner);
      if (pendingRequestByOwner.get(key) === requestId) pendingRequestByOwner.delete(key);
      const replaced = request.payload.replacesReservationId;
      if (replaced !== null) {
        const replacedRequestId = activeReservations.get(replaced);
        if (tentativeReplacementByOld.get(replaced) === reservationId) {
          tentativeReplacementByOld.delete(replaced);
        }
        activeReservations.delete(replaced);
        ownerByReservation.delete(replaced);
        replacedReservations.add(replaced);
        const replacedState = requestStates.get(replacedRequestId);
        if (replacedState) replacedState.state = 'replaced';
      }
      currentReservationByOwner.set(key, reservationId);
      ownerByReservation.set(reservationId, key);
    } else if (operation === 'resource:revoke') {
      if (!claimControl(message, index, 'revoke', payload.reservationId)) return;
      const requestId = activeReservations.get(payload.reservationId);
      const grant = requestId === undefined
        ? [...grants.values()].find((candidate) =>
          candidate.payload.reservationId === payload.reservationId) || null
        : grants.get(requestId);
      if (!grant) {
        add('PROTOCOL_REVOKE_UNKNOWN_RESERVATION', index, `Revoke references unknown reservation ${payload.reservationId}`);
        return;
      }
      const revokedRequestId = grant.payload.requestId;
      const requestState = requestStates.get(revokedRequestId);
      if (requestState.state === 'revoked-tentative' || requestState.state === 'revoked-active') {
        add('PROTOCOL_DUPLICATE_REVOKE', index, `Duplicate revoke for reservation ${payload.reservationId}`);
        return;
      }
      if (requestState.state !== 'granted' && requestState.state !== 'acked') {
        add(
          'PROTOCOL_REVOKE_STATE_INVALID',
          index,
          `resource:revoke is invalid while request ${revokedRequestId} is ${requestState.state}`
        );
        return;
      }
      let revokeValid = true;
      if (payload.grantId !== grant.payload.grantId) {
        add('PROTOCOL_REVOKE_GRANT_MISMATCH', index, 'Revoke grantId mismatch');
        revokeValid = false;
      }
      if (!jobRefEqual(grant, message)) {
        add('PROTOCOL_JOB_REF_MISMATCH', index, 'Revoke jobRef differs from grant');
        revokeValid = false;
      }
      if (!revokeValid) return;
      revokes.set(payload.reservationId, message);
      if (requestState.state === 'granted') {
        requestState.state = 'revoked-tentative';
        tentativeRevocations.add(payload.reservationId);
        const request = [...requests.values()].find((candidate) =>
          candidate.payload.requestId === grant.payload.requestId) || null;
        const replaced = request && request.payload.replacesReservationId;
        if (replaced !== null && replaced !== undefined &&
            tentativeReplacementByOld.get(replaced) === payload.reservationId) {
          tentativeReplacementByOld.delete(replaced);
        }
      } else {
        requestState.state = 'revoked-active';
      }
      const revokedRequest = requests.get(revokedRequestId);
      if (revokedRequest) {
        const key = ownerKey(revokedRequest.payload.owner);
        if (pendingRequestByOwner.get(key) === revokedRequestId) pendingRequestByOwner.delete(key);
      }
    } else if (operation === 'resource:release') {
      const reservationId = payload.reservationId;
      const revoke = revokes.get(reservationId);
      const releaseControlValid = revoke
        ? exactResponseControl(revoke, message, index, 'revoke', reservationId)
        : claimControl(message, index, 'release', reservationId);
      if (!releaseControlValid) return;
      if (tentativeReplacementByOld.has(reservationId)) {
        add(
          'PROTOCOL_RELEASE_DURING_TENTATIVE_REPLACEMENT',
          index,
          `Reservation ${reservationId} has a live tentative replacement`
        );
        return;
      }
      const requestId = requestByReservation.get(reservationId);
      const requestState = requestStates.get(requestId);
      const releasesTentativeRevoke = revoke && requestState &&
        requestState.state === 'revoked-tentative';
      if (requestState && (requestState.state === 'released' || requestState.state === 'release-acked')) {
        add('PROTOCOL_DUPLICATE_RELEASE', index, `Duplicate release for reservation ${reservationId}`);
        return;
      }
      const releasesActiveReservation = activeReservations.has(reservationId) && requestState &&
        ['acked', 'revoked-active'].includes(requestState.state);
      if (!releasesActiveReservation && !releasesTentativeRevoke) {
        add('PROTOCOL_RELEASE_UNKNOWN_RESERVATION', index, `Release references non-active reservation ${reservationId}`);
        return;
      }
      let releaseValid = true;
      if (revoke && !jobRefEqual(revoke, message)) {
        add('PROTOCOL_JOB_REF_MISMATCH', index, 'Revoked release jobRef mismatch');
        releaseValid = false;
      }
      const adoption = adopted.get(requestId);
      if (!revoke && message.jobRef !== null && adoption && !jobRefEqual(adoption, message)) {
        add('PROTOCOL_JOB_REF_MISMATCH', index, 'Release jobRef differs from adopted reservation');
        releaseValid = false;
      }
      if (!releaseValid) return;
      activeReservations.delete(reservationId);
      const key = ownerByReservation.get(reservationId);
      ownerByReservation.delete(reservationId);
      if (key && currentReservationByOwner.get(key) === reservationId) currentReservationByOwner.delete(key);
      releases.set(reservationId, message);
      requestState.state = 'released';
      requestState.release = message;
    } else if (operation === 'resource:release-ack') {
      const reservationId = payload.reservationId;
      const release = releases.get(reservationId);
      if (!release) {
        tombstoneUnexpectedResponse(message, index, 'release-ack', reservationId);
        add('PROTOCOL_RELEASE_ACK_WITHOUT_RELEASE', index, 'release-ack has no matching release');
        return;
      }
      const requestId = requestByReservation.get(reservationId);
      const requestState = requestStates.get(requestId);
      const exchangeKind = revokes.has(reservationId) ? 'revoke' : 'release';
      let releaseAckValid = exactResponseControl(
        release,
        message,
        index,
        exchangeKind,
        reservationId
      );
      if (!jobRefEqual(release, message)) {
        add('PROTOCOL_JOB_REF_MISMATCH', index, 'release-ack jobRef differs from release');
        releaseAckValid = false;
      }
      if (requestState.state === 'release-acked') {
        add('PROTOCOL_DUPLICATE_RELEASE_ACK', index, `Duplicate release-ack for reservation ${reservationId}`);
        return;
      }
      if (requestState.state !== 'released') {
        add(
          'PROTOCOL_RELEASE_ACK_STATE_INVALID',
          index,
          `resource:release-ack is invalid while request ${requestId} is ${requestState.state}`
        );
        return;
      }
      if (!releaseAckValid) return;
      releaseAcks.add(reservationId);
      requestState.state = 'release-acked';
      requestState.releaseAck = message;
    } else if (operation === 'executor:close') {
      const controlValid = claimControl(message, index, 'close');
      if (lifecycle !== 'ready') {
        add('PROTOCOL_CLOSE_BEFORE_READY', index, 'executor:close arrived before ready');
        return;
      }
      let closeValid = controlValid;
      if (hasPendingResourceExchange()) {
        add('PROTOCOL_CLOSE_WITH_PENDING_RESOURCES', index, 'executor:close has pending resource exchanges');
        closeValid = false;
      }
      if (activeReservations.size) {
        add('PROTOCOL_CLOSE_WITH_ACTIVE_RESERVATIONS', index, 'executor:close has active reservations');
        closeValid = false;
      }
      if (!closeValid) return;
      closeCommand = message;
      lifecycle = 'closing';
    } else if (operation === 'executor:close-ack') {
      if (!closeCommand || lifecycle !== 'closing') {
        tombstoneUnexpectedResponse(message, index, 'close-ack');
        add('PROTOCOL_CLOSE_ACK_WITHOUT_CLOSE', index, 'close-ack has no matching close');
        return;
      }
      if (!exactResponseControl(closeCommand, message, index, 'close')) return;
      closeAck = true;
      lifecycle = 'closed';
    }
  });

  for (const [requestId, grant] of grants) {
    const reservationId = grant.payload.reservationId;
    const requestState = requestStates.get(requestId);
    if (requestState && requestState.state === 'terminal-cleanup') continue;
    if (tentativeRevocations.has(reservationId)) {
      if (releases.has(reservationId) && !releaseAcks.has(reservationId)) {
        add('PROTOCOL_MISSING_RELEASE_ACK', -1, `Reservation ${reservationId} is missing resource:release-ack`);
      }
      continue;
    }
    if (!adopted.has(requestId)) add('PROTOCOL_MISSING_ADOPTED', -1, `Granted request ${requestId} is missing resource:adopted`);
    if (!adoptAcks.has(requestId)) add('PROTOCOL_MISSING_ADOPT_ACK', -1, `Granted request ${requestId} is missing resource:adopt-ack`);
    if (!releases.has(reservationId) && !replacedReservations.has(reservationId)) {
      add('PROTOCOL_MISSING_RELEASE', -1, `Reservation ${reservationId} is missing resource:release`);
    }
    if (!releaseAcks.has(reservationId) && !replacedReservations.has(reservationId)) {
      add('PROTOCOL_MISSING_RELEASE_ACK', -1, `Reservation ${reservationId} is missing resource:release-ack`);
    }
  }
  if (closeCommand && !closeAck && lifecycle === 'closing') {
    add('PROTOCOL_MISSING_CLOSE_ACK', -1, 'executor:close is missing executor:close-ack');
  }
}

module.exports = {
  validateProtocolSequence
};
