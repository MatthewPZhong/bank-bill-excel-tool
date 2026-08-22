'use strict';

const {
  ProtocolValidationError,
  canonicalJsonSnapshot
} = require('./protocol-validator');

function sequenceScopeOwned(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new ProtocolValidationError('PROTOCOL_CHANNEL_INVALID', 'Sequence identity must be an object', '/');
  }
  if (message.channel === 'job') {
    return ['job', message.jobId, message.workerInstanceId, message.direction];
  }
  if (message.channel === 'service-control') {
    return [
      'service-control',
      message.serviceKey,
      message.serviceGeneration,
      message.workerInstanceId,
      message.direction
    ];
  }
  throw new ProtocolValidationError('PROTOCOL_CHANNEL_INVALID', `Unsupported channel: ${message.channel}`, '/channel');
}

function sequenceScope(message) {
  return sequenceScopeOwned(canonicalJsonSnapshot(message));
}

function scopeKeyOwned(message) {
  return JSON.stringify(sequenceScopeOwned(message));
}

function createDirectionSequenceTracker() {
  const lastByScope = new Map();

  function observe(message) {
    const ownedMessage = canonicalJsonSnapshot(message);
    const scope = sequenceScopeOwned(ownedMessage);
    const key = JSON.stringify(scope);
    const expected = (lastByScope.get(key) || 0) + 1;
    if (ownedMessage.seq !== expected) {
      throw new ProtocolValidationError(
        'PROTOCOL_SEQUENCE_INVALID',
        `Sequence must equal last + 1; expected ${expected}, got ${ownedMessage.seq}`,
        '/seq',
        { expected, actual: ownedMessage.seq, scope }
      );
    }
    lastByScope.set(key, ownedMessage.seq);
    return ownedMessage.seq;
  }

  function next(messageIdentity) {
    const key = scopeKeyOwned(canonicalJsonSnapshot(messageIdentity));
    const value = (lastByScope.get(key) || 0) + 1;
    lastByScope.set(key, value);
    return value;
  }

  function current(messageIdentity) {
    return lastByScope.get(scopeKeyOwned(canonicalJsonSnapshot(messageIdentity))) || 0;
  }

  function reset(messageIdentity) {
    return lastByScope.delete(scopeKeyOwned(canonicalJsonSnapshot(messageIdentity)));
  }

  return Object.freeze({ current, next, observe, reset });
}

module.exports = {
  createDirectionSequenceTracker,
  sequenceScope
};
