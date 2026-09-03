'use strict';

const protocolSchema = require('./schemas/platform-protocol-v1.schema.json');
const {
  compactJson,
  parseAndValidateEnvelope,
  validateEnvelope,
  validateJobEnvelope,
  validateServiceControlEnvelope
} = require('./protocol-validator');

const JOB_OPERATIONS = Object.freeze([...protocolSchema.$defs.jobEnvelope.properties.operation.enum]);
const SERVICE_CONTROL_OPERATIONS = Object.freeze([
  ...protocolSchema.$defs.serviceControlEnvelope.properties.operation.enum
]);
const TERMINAL_JOB_OPERATIONS = Object.freeze(['job:done', 'job:error']);
const EXECUTION_TERMINAL_SOURCES = Object.freeze([
  'job:done',
  'job:error',
  'init-timeout',
  'execution-timeout',
  'cancel-timeout',
  'adapter-error',
  'spawn-error',
  'unexpected-exit',
  'protocol-error'
]);

function createJobEnvelope(fields, options = {}) {
  const envelope = {
    protocolVersion: 1,
    channel: 'job',
    direction: fields.direction,
    operation: fields.operation,
    actionKey: fields.actionKey,
    operationKey: fields.operationKey,
    jobId: fields.jobId,
    workerInstanceId: fields.workerInstanceId,
    serviceGeneration: fields.serviceGeneration === undefined ? null : fields.serviceGeneration,
    unitId: fields.unitId === undefined ? null : fields.unitId,
    seq: fields.seq,
    context: fields.context,
    payload: fields.payload
  };
  if (options.validate === false) return envelope;
  return validateJobEnvelope(envelope, {
    actionKey: envelope.actionKey,
    operationKey: envelope.operationKey,
    jobId: envelope.jobId,
    workerInstanceId: envelope.workerInstanceId,
    serviceGeneration: envelope.serviceGeneration,
    direction: envelope.direction
  }, options);
}

function createServiceControlEnvelope(fields, options = {}) {
  const envelope = {
    protocolVersion: 1,
    channel: 'service-control',
    direction: fields.direction,
    operation: fields.operation,
    serviceKey: fields.serviceKey,
    controlId: fields.controlId,
    workerInstanceId: fields.workerInstanceId,
    serviceGeneration: fields.serviceGeneration,
    seq: fields.seq,
    jobRef: fields.jobRef === undefined ? null : fields.jobRef,
    payload: fields.payload
  };
  if (options.validate === false) return envelope;
  return validateServiceControlEnvelope(envelope, {
    serviceKey: envelope.serviceKey,
    workerInstanceId: envelope.workerInstanceId,
    serviceGeneration: envelope.serviceGeneration,
    direction: envelope.direction
  }, options);
}

function serializeEnvelope(envelope, options = {}) {
  const ownedEnvelope = validateEnvelope(envelope, options);
  return compactJson(ownedEnvelope);
}

module.exports = {
  EXECUTION_TERMINAL_SOURCES,
  JOB_OPERATIONS,
  SERVICE_CONTROL_OPERATIONS,
  TERMINAL_JOB_OPERATIONS,
  createJobEnvelope,
  createServiceControlEnvelope,
  parseAndValidateEnvelope,
  serializeEnvelope,
  validateEnvelope,
  validateJobEnvelope,
  validateServiceControlEnvelope
};
