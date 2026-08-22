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
  let initialized = false;
  let ready = false;
  let closeCommand = null;
  let closeAck = false;
  const requests = new Map();
  const grants = new Map();
  const adopted = new Map();
  const adoptAcks = new Set();
  const activeReservations = new Map();
  const releases = new Map();
  const revokes = new Map();
  const releaseAcks = new Set();
  const currentReservationByOwner = new Map();
  const ownerByReservation = new Map();
  const replacedReservations = new Set();

  function jobRefEqual(left, right) {
    return isDeepStrictEqual(left.jobRef, right.jobRef);
  }

  function ownerKey(owner = {}) {
    return JSON.stringify([owner.kind, owner.ownerKeyHash]);
  }

  serviceMessages.forEach(({ message, index }) => {
    const identity = [message.serviceKey, message.workerInstanceId, message.serviceGeneration];
    if (!isDeepStrictEqual(identity, canonicalIdentity)) {
      add('PROTOCOL_SERVICE_IDENTITY_CHANGED', index, 'Service identity changed within a sequence');
    }
    const operation = message.operation;
    const payload = message.payload || {};
    if (operation === 'executor:init') {
      if (initialized) add('PROTOCOL_DUPLICATE_INIT', index, 'Duplicate executor:init');
      initialized = true;
    } else if (operation === 'executor:ready') {
      if (!initialized) add('PROTOCOL_READY_BEFORE_INIT', index, 'executor:ready arrived before executor:init');
      ready = true;
    } else if (operation === 'resource:request') {
      if (!ready) add('PROTOCOL_REQUEST_BEFORE_READY', index, 'resource:request arrived before executor:ready');
      const requestId = payload.requestId;
      if (requests.has(requestId)) add('PROTOCOL_DUPLICATE_REQUEST', index, `Duplicate resource request ${requestId}`);
      const key = ownerKey(payload.owner);
      const current = currentReservationByOwner.get(key);
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
      requests.set(requestId, message);
    } else if (operation === 'resource:grant' || operation === 'resource:reject') {
      const requestId = payload.requestId;
      const request = requests.get(requestId);
      if (!request) {
        add('PROTOCOL_RESPONSE_WITHOUT_REQUEST', index, `${operation} has no matching resource:request`);
        return;
      }
      if (!jobRefEqual(request, message)) add('PROTOCOL_JOB_REF_MISMATCH', index, `${operation} jobRef differs from request`);
      if (request.controlId !== message.controlId) add('PROTOCOL_CONTROL_ID_MISMATCH', index, `${operation} controlId differs from request`);
      if (operation === 'resource:grant') {
        if (payload.replacesReservationId !== request.payload.replacesReservationId) {
          add('PROTOCOL_REPLACEMENT_MISMATCH', index, 'Grant replacement differs from request');
        }
        for (const field of ['memoryBytes', 'cpuSlots', 'ioHeavySlots']) {
          if (payload.granted[field] > request.payload.requested[field]) {
            add('PROTOCOL_GRANT_EXCEEDS_REQUEST', index, `Grant exceeds requested ${field}`);
          }
        }
        grants.set(requestId, message);
      }
    } else if (operation === 'resource:adopted') {
      const requestId = payload.requestId;
      const grant = grants.get(requestId);
      const request = requests.get(requestId);
      if (!grant || !request) {
        add('PROTOCOL_ADOPTED_WITHOUT_GRANT', index, 'resource:adopted has no matching grant');
        return;
      }
      if (payload.grantId !== grant.payload.grantId || payload.reservationId !== grant.payload.reservationId) {
        add('PROTOCOL_ADOPTED_IDENTITY_MISMATCH', index, 'Adopted grant/reservation identity mismatch');
      }
      if (!isDeepStrictEqual(payload.owner, request.payload.owner)) {
        add('PROTOCOL_ADOPTED_OWNER_MISMATCH', index, 'Adopted owner differs from request');
      }
      if (!jobRefEqual(grant, message)) add('PROTOCOL_JOB_REF_MISMATCH', index, 'Adopted jobRef differs from grant');
      adopted.set(requestId, message);
    } else if (operation === 'resource:adopt-ack') {
      const requestId = payload.requestId;
      const adoption = adopted.get(requestId);
      const grant = grants.get(requestId);
      if (!adoption || !grant) {
        add('PROTOCOL_ADOPT_ACK_WITHOUT_ADOPTED', index, 'adopt-ack has no matching adopted/grant');
        return;
      }
      if (payload.grantId !== adoption.payload.grantId || payload.reservationId !== adoption.payload.reservationId) {
        add('PROTOCOL_ADOPT_ACK_IDENTITY_MISMATCH', index, 'adopt-ack identity mismatch');
      }
      if (adoption.controlId !== message.controlId) add('PROTOCOL_CONTROL_ID_MISMATCH', index, 'adopt-ack must echo adopted controlId');
      if (!jobRefEqual(adoption, message)) add('PROTOCOL_JOB_REF_MISMATCH', index, 'adopt-ack jobRef differs from adopted');
      adoptAcks.add(requestId);
      const reservationId = payload.reservationId;
      if (activeReservations.has(reservationId)) {
        add('PROTOCOL_DUPLICATE_RESERVATION', index, `Duplicate active reservation ${reservationId}`);
      }
      activeReservations.set(reservationId, requestId);
      const request = requests.get(requestId);
      const key = ownerKey(request.payload.owner);
      const replaced = request.payload.replacesReservationId;
      if (replaced !== null) {
        activeReservations.delete(replaced);
        ownerByReservation.delete(replaced);
        replacedReservations.add(replaced);
      }
      currentReservationByOwner.set(key, reservationId);
      ownerByReservation.set(reservationId, key);
    } else if (operation === 'resource:revoke') {
      const requestId = activeReservations.get(payload.reservationId);
      const grant = requestId === undefined ? null : grants.get(requestId);
      if (!grant) {
        add('PROTOCOL_REVOKE_UNKNOWN_RESERVATION', index, `Revoke references non-active reservation ${payload.reservationId}`);
        return;
      }
      if (payload.grantId !== grant.payload.grantId) add('PROTOCOL_REVOKE_GRANT_MISMATCH', index, 'Revoke grantId mismatch');
      if (!jobRefEqual(grant, message)) add('PROTOCOL_JOB_REF_MISMATCH', index, 'Revoke jobRef differs from grant');
      revokes.set(payload.reservationId, message);
    } else if (operation === 'resource:release') {
      const reservationId = payload.reservationId;
      if (!activeReservations.has(reservationId)) {
        add('PROTOCOL_RELEASE_UNKNOWN_RESERVATION', index, `Release references non-active reservation ${reservationId}`);
      }
      const revoke = revokes.get(reservationId);
      if (revoke && revoke.controlId !== message.controlId) {
        add('PROTOCOL_CONTROL_ID_MISMATCH', index, 'Revoked release controlId mismatch');
      }
      if (revoke && !jobRefEqual(revoke, message)) add('PROTOCOL_JOB_REF_MISMATCH', index, 'Revoked release jobRef mismatch');
      releases.set(reservationId, message);
    } else if (operation === 'resource:release-ack') {
      const reservationId = payload.reservationId;
      const release = releases.get(reservationId);
      if (!release) {
        add('PROTOCOL_RELEASE_ACK_WITHOUT_RELEASE', index, 'release-ack has no matching release');
        return;
      }
      if (release.controlId !== message.controlId) add('PROTOCOL_CONTROL_ID_MISMATCH', index, 'release-ack must echo release controlId');
      releaseAcks.add(reservationId);
      activeReservations.delete(reservationId);
      const key = ownerByReservation.get(reservationId);
      ownerByReservation.delete(reservationId);
      if (key && currentReservationByOwner.get(key) === reservationId) currentReservationByOwner.delete(key);
    } else if (operation === 'executor:close') {
      if (!ready) add('PROTOCOL_CLOSE_BEFORE_READY', index, 'executor:close arrived before ready');
      if (activeReservations.size) add('PROTOCOL_CLOSE_WITH_ACTIVE_RESERVATIONS', index, 'executor:close has active reservations');
      closeCommand = message;
    } else if (operation === 'executor:close-ack') {
      if (!closeCommand) add('PROTOCOL_CLOSE_ACK_WITHOUT_CLOSE', index, 'close-ack has no matching close');
      else if (closeCommand.controlId !== message.controlId) add('PROTOCOL_CONTROL_ID_MISMATCH', index, 'close-ack must echo close controlId');
      closeAck = true;
    }
  });

  for (const [requestId, grant] of grants) {
    if (!adopted.has(requestId)) add('PROTOCOL_MISSING_ADOPTED', -1, `Granted request ${requestId} is missing resource:adopted`);
    if (!adoptAcks.has(requestId)) add('PROTOCOL_MISSING_ADOPT_ACK', -1, `Granted request ${requestId} is missing resource:adopt-ack`);
    const reservationId = grant.payload.reservationId;
    if (!releases.has(reservationId) && !replacedReservations.has(reservationId)) {
      add('PROTOCOL_MISSING_RELEASE', -1, `Reservation ${reservationId} is missing resource:release`);
    }
    if (!releaseAcks.has(reservationId) && !replacedReservations.has(reservationId)) {
      add('PROTOCOL_MISSING_RELEASE_ACK', -1, `Reservation ${reservationId} is missing resource:release-ack`);
    }
  }
  if (closeCommand && !closeAck) add('PROTOCOL_MISSING_CLOSE_ACK', -1, 'executor:close is missing executor:close-ack');
}

module.exports = {
  validateProtocolSequence
};
