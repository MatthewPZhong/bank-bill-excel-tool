'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  PLATFORM_PROTOCOL_MAX_BYTES,
  parseAndValidateEnvelope,
  policyForAction,
  utf8Size,
  validateEnvelope,
  validateJobEnvelope,
  validateServiceControlEnvelope
} = require('../../../../src/main-process/background-execution/protocol-validator');
const {
  createServiceControlEnvelope
} = require('../../../../src/main-process/background-execution/protocol');
const {
  validateProtocolSequence
} = require('../../../../src/main-process/background-execution/protocol-sequence-validator');
const {
  createDirectionSequenceTracker
} = require('../../../../src/main-process/background-execution/sequence-tracker');

const FIXTURES = path.resolve(
  __dirname,
  '../../../../changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures'
);

function fixture(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relativePath), 'utf8'));
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail('Expected callback to throw');
}

const registry = fixture('valid/policy-registry.v3.2.x.json');

test('最终 23 条 valid protocol message 全量通过', () => {
  const messages = fixture('valid/protocol-messages.v1.json');
  assert.equal(messages.length, 23);
  for (const message of messages) {
    const owned = validateEnvelope(message, { policyRegistry: registry });
    assert.deepEqual(owned, message);
    assert.notEqual(owned, message);
    assert.equal(Object.isFrozen(owned), true);
  }
});

test('Service Control envelope builder 机械保持 Schema exact keys', () => {
  const source = fixture('valid/protocol-messages.v1.json')
    .find((message) => message.channel === 'service-control');
  const built = createServiceControlEnvelope(source, { policyRegistry: registry });
  assert.deepEqual(built, source);
  assert.deepEqual(Object.keys(built), [
    'protocolVersion', 'channel', 'direction', 'operation', 'serviceKey', 'controlId',
    'workerInstanceId', 'serviceGeneration', 'seq', 'jobRef', 'payload'
  ]);
});

test('最终 11 条 invalid protocol message 全量被拒绝', () => {
  const invalid = fixture('invalid/protocol-messages.invalid.v1.json');
  assert.equal(invalid.length, 11);
  for (const item of invalid) {
    assert.throws(
      () => validateEnvelope(item.message, { policyRegistry: registry }),
      (error) => typeof error.code === 'string' && error.code.startsWith('PROTOCOL_'),
      item.name
    );
  }
});

test('最终 5 条 valid sequence 通过且 24 条 invalid sequence 全量拒绝', () => {
  const valid = fixture('valid/protocol-sequences.v1.json');
  const invalid = fixture('invalid/protocol-sequences.invalid.v1.json');
  assert.equal(valid.length, 5);
  assert.equal(invalid.length, 24);
  for (const item of valid) {
    const result = validateProtocolSequence(item.messages, { policyRegistry: registry });
    assert.equal(result.valid, true, `${item.name}: ${JSON.stringify(result.errors)}`);
  }
  for (const item of invalid) {
    const result = validateProtocolSequence(item.messages, { policyRegistry: registry });
    assert.equal(result.valid, false, item.name);
    assert.ok(result.errors[0].code.startsWith('PROTOCOL_'));
  }
});

test('adoption timeout 允许 Main 在 grant 后、adopt 前 revoke tentative reservation', () => {
  const valid = fixture('valid/protocol-sequences.v1.json');
  const source = valid.find((item) => item.name === 'service-independent-direction-seq-with-revoke');
  const throughGrant = source.messages.slice(0, 4);
  const grant = throughGrant.at(-1);
  const revoke = structuredClone(source.messages.find((message) => message.operation === 'resource:revoke'));
  revoke.seq = grant.seq + 1;
  revoke.controlId = 'ctl-adoption-timeout';
  revoke.payload.grantId = grant.payload.grantId;
  revoke.payload.reservationId = grant.payload.reservationId;
  revoke.payload.reasonCode = 'adoption-timeout';
  let result = validateProtocolSequence([...throughGrant, revoke], { policyRegistry: registry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const release = structuredClone(source.messages.find((message) =>
    message.operation === 'resource:release'));
  release.seq = 3;
  release.controlId = revoke.controlId;
  release.jobRef = structuredClone(revoke.jobRef);
  release.payload.reservationId = revoke.payload.reservationId;
  const releaseAck = structuredClone(source.messages.find((message) =>
    message.operation === 'resource:release-ack'));
  releaseAck.seq = 4;
  releaseAck.controlId = revoke.controlId;
  releaseAck.jobRef = structuredClone(revoke.jobRef);
  releaseAck.payload.reservationId = revoke.payload.reservationId;
  result = validateProtocolSequence([...throughGrant, revoke, release, releaseAck], {
    policyRegistry: registry
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('tentative replacement 存活时 sequence validator 拒绝提前 release old reservation', () => {
  const source = fixture('valid/protocol-sequences.v1.json')
    .find((item) => item.name === 'persistent-state-first-and-exact-current-replacement');
  const throughReplacementGrant = structuredClone(source.messages.slice(0, 8));
  const releaseOld = structuredClone(source.messages[10]);
  releaseOld.seq = source.messages[8].seq;
  releaseOld.controlId = 'release-old-during-tentative';
  releaseOld.payload.reservationId = 'reservation-state-1';
  const result = validateProtocolSequence([...throughReplacementGrant, releaseOld], {
    policyRegistry: registry
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) =>
    error.code === 'PROTOCOL_RELEASE_DURING_TENTATIVE_REPLACEMENT'));
});

test('sequence owner claim starts at request and releases on reject, revoke, or release', () => {
  const source = fixture('valid/protocol-sequences.v1.json')
    .find((item) => item.name === 'statement-resource-adopt-release-close');
  const [init, ready, request, grant, adopted, adoptAck, release, releaseAck] =
    structuredClone(source.messages);

  function retryRequest(seq, suffix) {
    const retry = structuredClone(request);
    retry.seq = seq;
    retry.controlId = `owner-retry-${suffix}`;
    retry.payload.requestId = `owner-retry-${suffix}`;
    return retry;
  }

  const duplicate = retryRequest(3, 'duplicate');
  const duplicateResult = validateProtocolSequence([init, ready, request, duplicate], {
    policyRegistry: registry
  });
  assert.equal(duplicateResult.valid, false);
  assert.ok(duplicateResult.errors.some((error) => error.code === 'PROTOCOL_DUPLICATE_OWNER'));

  const reject = structuredClone(grant);
  reject.operation = 'resource:reject';
  reject.payload = {
    requestId: request.payload.requestId,
    reasonCode: 'RESOURCE_BUDGET_UNAVAILABLE',
    retryable: true,
    safeSummary: 'Resource request was not admitted'
  };
  const afterReject = validateProtocolSequence([
    init,
    ready,
    request,
    reject,
    retryRequest(3, 'after-reject')
  ], { policyRegistry: registry });
  assert.equal(afterReject.valid, true, JSON.stringify(afterReject.errors));

  const revoke = structuredClone(grant);
  revoke.operation = 'resource:revoke';
  revoke.controlId = 'owner-revoke';
  revoke.seq = 3;
  revoke.payload = {
    grantId: grant.payload.grantId,
    reservationId: grant.payload.reservationId,
    reasonCode: 'adoption-timeout'
  };
  const afterRevoke = validateProtocolSequence([
    init,
    ready,
    request,
    grant,
    revoke,
    retryRequest(3, 'after-revoke')
  ], { policyRegistry: registry });
  assert.equal(afterRevoke.valid, true, JSON.stringify(afterRevoke.errors));

  const afterRelease = validateProtocolSequence([
    init,
    ready,
    request,
    grant,
    adopted,
    adoptAck,
    release,
    retryRequest(5, 'after-release'),
    releaseAck
  ], { policyRegistry: registry });
  assert.equal(afterRelease.valid, true, JSON.stringify(afterRelease.errors));
});

test('service resource sequence uses an explicit per-request response and adoption FSM', () => {
  const source = fixture('valid/protocol-sequences.v1.json')
    .find((item) => item.name === 'statement-resource-adopt-release-close').messages;
  const [init, ready, request, grant, adopted, adoptAck, release, releaseAck] = structuredClone(source);

  function rejected(seq) {
    const message = structuredClone(grant);
    message.operation = 'resource:reject';
    message.seq = seq;
    message.payload = {
      requestId: request.payload.requestId,
      reasonCode: 'RESOURCE_BUDGET_UNAVAILABLE',
      retryable: true,
      safeSummary: 'Resource request was not admitted'
    };
    return message;
  }

  function revoked() {
    const message = structuredClone(grant);
    message.operation = 'resource:revoke';
    message.controlId = 'ctl-adoption-timeout';
    message.seq = 3;
    message.payload = {
      grantId: grant.payload.grantId,
      reservationId: grant.payload.reservationId,
      reasonCode: 'adoption-timeout'
    };
    return message;
  }

  const duplicateGrant = structuredClone(grant);
  duplicateGrant.seq = 3;
  const duplicateAdopted = structuredClone(adopted);
  duplicateAdopted.seq = 4;
  duplicateAdopted.controlId = 'ctl-adopt-duplicate';
  const duplicateReject = rejected(3);
  const duplicateReleaseAck = structuredClone(releaseAck);
  duplicateReleaseAck.seq = 5;

  const cases = [
    ['PROTOCOL_DUPLICATE_GRANT', [init, ready, request, grant, duplicateGrant]],
    ['PROTOCOL_DUPLICATE_ADOPTED', [init, ready, request, grant, adopted, duplicateAdopted]],
    ['PROTOCOL_DUPLICATE_REJECT', [init, ready, request, rejected(2), duplicateReject]],
    ['PROTOCOL_DUPLICATE_RELEASE_ACK', [
      init, ready, request, grant, adopted, adoptAck, release, releaseAck, duplicateReleaseAck
    ]],
    ['PROTOCOL_RESOURCE_RESPONSE_CONFLICT', [init, ready, request, grant, rejected(3)]],
    ['PROTOCOL_ADOPT_AFTER_REVOKE', [init, ready, request, grant, revoked(), adopted]]
  ];
  for (const [code, messages] of cases) {
    const result = validateProtocolSequence(messages, { policyRegistry: registry });
    assert.equal(result.valid, false, code);
    assert.ok(result.errors.some((error) => error.code === code), JSON.stringify(result.errors));
  }
});

test('service sequence correlation identities are generation-wide tombstones with exact response echo', () => {
  const sequences = fixture('valid/protocol-sequences.v1.json');
  const normal = sequences.find((item) =>
    item.name === 'statement-resource-adopt-release-close').messages;
  const multi = sequences.find((item) =>
    item.name === 'service-independent-direction-seq-with-revoke').messages;
  const [init, ready, request, grant] = structuredClone(normal);

  const reusedControlRequest = structuredClone(request);
  reusedControlRequest.controlId = ready.controlId;
  let result = validateProtocolSequence([init, ready, reusedControlRequest], {
    policyRegistry: registry
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'PROTOCOL_CONTROL_ID_REUSED'));

  const initIdRequest = structuredClone(request);
  initIdRequest.controlId = init.controlId;
  result = validateProtocolSequence([init, ready, initIdRequest], {
    policyRegistry: registry
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'PROTOCOL_CONTROL_ID_REUSED'));

  const mismatchedGrant = structuredClone(grant);
  mismatchedGrant.controlId = 'ctl-wrong-response';
  result = validateProtocolSequence([init, ready, request, mismatchedGrant], {
    policyRegistry: registry
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'PROTOCOL_CONTROL_ID_MISMATCH'));

  const rejected = structuredClone(grant);
  rejected.operation = 'resource:reject';
  rejected.payload = {
    requestId: request.payload.requestId,
    reasonCode: 'RESOURCE_BUDGET_UNAVAILABLE',
    retryable: true,
    safeSummary: 'Resource request was not admitted'
  };
  const duplicateRejected = structuredClone(rejected);
  duplicateRejected.controlId = 'ctl-invalid-response-tombstone';
  duplicateRejected.seq = 3;
  const closeReusingInvalidResponse = structuredClone(normal[8]);
  closeReusingInvalidResponse.controlId = duplicateRejected.controlId;
  closeReusingInvalidResponse.seq = 4;
  result = validateProtocolSequence([
    init,
    ready,
    request,
    rejected,
    duplicateRejected,
    closeReusingInvalidResponse
  ], { policyRegistry: registry });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'PROTOCOL_CONTROL_ID_REUSED'));

  const grantReuse = structuredClone(multi.slice(0, 11));
  const grantMessages = grantReuse.filter((message) => message.operation === 'resource:grant');
  grantMessages[1].payload.grantId = grantMessages[0].payload.grantId;
  result = validateProtocolSequence(grantReuse, { policyRegistry: registry });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'PROTOCOL_GRANT_ID_REUSED'));

  const reservationReuse = structuredClone(multi.slice(0, 11));
  const reservationGrants = reservationReuse.filter((message) =>
    message.operation === 'resource:grant');
  reservationGrants[1].payload.reservationId = reservationGrants[0].payload.reservationId;
  result = validateProtocolSequence(reservationReuse, { policyRegistry: registry });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'PROTOCOL_RESERVATION_ID_REUSED'));

  const revokeIdRequest = structuredClone(multi[9]);
  revokeIdRequest.controlId = multi[6].controlId;
  result = validateProtocolSequence([...structuredClone(multi.slice(0, 9)), revokeIdRequest], {
    policyRegistry: registry
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'PROTOCOL_CONTROL_ID_REUSED'));

  result = validateProtocolSequence(structuredClone(multi), { policyRegistry: registry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const nextGeneration = structuredClone(normal);
  for (const message of nextGeneration) {
    message.workerInstanceId = 'worker-next-generation';
    message.serviceGeneration = 2;
  }
  result = validateProtocolSequence(nextGeneration, { policyRegistry: registry });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('service sequence lifecycle FSM rejects duplicate, pending-close, and post-terminal messages', () => {
  const normal = fixture('valid/protocol-sequences.v1.json')
    .find((item) => item.name === 'statement-resource-adopt-release-close').messages;
  const [init, ready, request] = structuredClone(normal);
  const fatal = structuredClone(ready);
  fatal.operation = 'executor:error';
  fatal.controlId = 'ctl-fatal';
  fatal.seq = 2;
  fatal.payload = {};
  const fatalResult = validateProtocolSequence([init, ready, fatal], { policyRegistry: registry });
  assert.equal(fatalResult.valid, true, JSON.stringify(fatalResult.errors));

  const closingFatal = structuredClone(normal[9]);
  closingFatal.operation = 'executor:error';
  closingFatal.controlId = 'ctl-fatal-while-closing';
  closingFatal.payload = {};
  const closingFatalResult = validateProtocolSequence([
    ...structuredClone(normal.slice(0, 9)),
    closingFatal
  ], { policyRegistry: registry });
  assert.equal(closingFatalResult.valid, true, JSON.stringify(closingFatalResult.errors));

  const duplicateReady = structuredClone(ready);
  duplicateReady.controlId = 'ctl-ready-duplicate';
  duplicateReady.seq = 2;

  const duplicateClose = structuredClone(normal[8]);
  duplicateClose.controlId = 'ctl-close-duplicate';
  duplicateClose.seq = 6;

  const duplicateCloseAck = structuredClone(normal[9]);
  duplicateCloseAck.seq = 6;

  const closeWithPending = structuredClone(normal[8]);
  closeWithPending.controlId = 'ctl-close-pending';
  closeWithPending.seq = 2;

  const postClosedRequest = structuredClone(request);
  postClosedRequest.controlId = 'ctl-post-closed';
  postClosedRequest.seq = 6;
  postClosedRequest.payload.requestId = 'request-post-closed';
  postClosedRequest.payload.owner.ownerKeyHash = 'post-closed-owner';

  const postFailedRequest = structuredClone(request);
  postFailedRequest.controlId = 'ctl-post-failed';
  postFailedRequest.seq = 3;
  postFailedRequest.payload.requestId = 'request-post-failed';
  postFailedRequest.payload.owner.ownerKeyHash = 'post-failed-owner';

  const cases = [
    ['PROTOCOL_DUPLICATE_READY', [init, ready, duplicateReady]],
    ['PROTOCOL_DUPLICATE_CLOSE', [...structuredClone(normal.slice(0, 9)), duplicateClose]],
    ['PROTOCOL_DUPLICATE_CLOSE_ACK', [...structuredClone(normal), duplicateCloseAck]],
    ['PROTOCOL_CLOSE_WITH_PENDING_RESOURCES', [init, ready, request, closeWithPending]],
    ['PROTOCOL_SERVICE_MESSAGE_AFTER_TERMINAL', [...structuredClone(normal), postClosedRequest]],
    ['PROTOCOL_SERVICE_MESSAGE_AFTER_TERMINAL', [init, ready, fatal, postFailedRequest]]
  ];
  for (const [code, messages] of cases) {
    const result = validateProtocolSequence(messages, { policyRegistry: registry });
    assert.equal(result.valid, false, code);
    assert.ok(result.errors.some((error) => error.code === code), JSON.stringify(result.errors));
  }
});

test('fatal executor terminal delegates unfinished resource tails to internal cleanup only', () => {
  const normal = fixture('valid/protocol-sequences.v1.json')
    .find((item) => item.name === 'statement-resource-adopt-release-close').messages;
  const [init, ready, request, grant, adopted, adoptAck, release] = structuredClone(normal);

  function fatalAfter(messages) {
    const fatal = structuredClone(ready);
    fatal.operation = 'executor:error';
    fatal.controlId = `ctl-fatal-after-${messages.length}`;
    fatal.seq = Math.max(
      ...messages.filter((message) => message.direction === 'event').map((message) => message.seq)
    ) + 1;
    fatal.payload = {};
    return [...messages, fatal];
  }

  const fatalBoundaries = [
    [init, ready, request, grant],
    [init, ready, request, grant, adopted],
    [init, ready, request, grant, adopted, adoptAck, release]
  ];
  for (const messages of fatalBoundaries) {
    const result = validateProtocolSequence(fatalAfter(messages), { policyRegistry: registry });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }

  const invalidRelease = structuredClone(release);
  invalidRelease.controlId = 'invalid-release-before-fatal';
  invalidRelease.payload.reservationId = 'unknown-before-fatal';
  const invalidResult = validateProtocolSequence(fatalAfter([
    init, ready, request, grant, adopted, adoptAck, invalidRelease
  ]), { policyRegistry: registry });
  assert.equal(invalidResult.valid, false);
  assert.ok(invalidResult.errors.some((error) =>
    error.code === 'PROTOCOL_RELEASE_UNKNOWN_RESERVATION'));
});

test('graceful close cannot use fatal terminal cleanup to skip revoke release acknowledgement', () => {
  const sequences = fixture('valid/protocol-sequences.v1.json');
  const normal = sequences.find((item) =>
    item.name === 'statement-resource-adopt-release-close').messages;
  const revokeSource = sequences.find((item) =>
    item.name === 'service-independent-direction-seq-with-revoke').messages
    .find((message) => message.operation === 'resource:revoke');
  const [init, ready, request, grant] = structuredClone(normal);
  const revoke = structuredClone(revokeSource);
  revoke.controlId = 'graceful-unanswered-revoke';
  revoke.seq = 3;
  revoke.jobRef = structuredClone(grant.jobRef);
  revoke.payload.grantId = grant.payload.grantId;
  revoke.payload.reservationId = grant.payload.reservationId;
  revoke.payload.reasonCode = 'service-close';
  const close = structuredClone(normal.find((message) => message.operation === 'executor:close'));
  close.controlId = 'close-before-revoke-release';
  close.seq = 4;

  const result = validateProtocolSequence([init, ready, request, grant, revoke, close], {
    policyRegistry: registry
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) =>
    error.code === 'PROTOCOL_CLOSE_WITH_PENDING_RESOURCES'));
});

test('完整 compact JSON 以 UTF-8 bytes 执行 exact ceiling，多字节越界拒绝', () => {
  const start = structuredClone(
    fixture('valid/protocol-messages.v1.json').find((message) => message.operation === 'job:start')
  );
  start.payload = { input: { text: '' } };
  const remaining = PLATFORM_PROTOCOL_MAX_BYTES - utf8Size(start);
  start.payload.input.text = 'x'.repeat(remaining);
  assert.equal(utf8Size(start), PLATFORM_PROTOCOL_MAX_BYTES);
  assert.doesNotThrow(() => validateEnvelope(start, { policyRegistry: registry }));

  start.payload.input.text = `${'x'.repeat(remaining - 1)}界`;
  assert.equal(utf8Size(start), PLATFORM_PROTOCOL_MAX_BYTES + 2);
  assert.throws(
    () => validateEnvelope(start, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_MESSAGE_TOO_LARGE' && error.details.actualBytes === PLATFORM_PROTOCOL_MAX_BYTES + 2
  );
  assert.throws(
    () => validateEnvelope(start, {
      policyRegistry: registry,
      maxBytes: PLATFORM_PROTOCOL_MAX_BYTES + 1000,
      serializedBytes: 1
    }),
    (error) => error.code === 'PROTOCOL_MESSAGE_TOO_LARGE' &&
      error.details.limit === PLATFORM_PROTOCOL_MAX_BYTES
  );

  start.payload.input.text = 'x'.repeat(remaining);
  assert.throws(
    () => validateEnvelope(start, {
      policyRegistry: registry,
      maxBytes: PLATFORM_PROTOCOL_MAX_BYTES - 1
    }),
    (error) => error.code === 'PROTOCOL_MESSAGE_TOO_LARGE' &&
      error.details.limit === PLATFORM_PROTOCOL_MAX_BYTES - 1
  );
});

test('serialized message 在 JSON.parse 前先做 UTF-8 byte ceiling，parse/schema 错误 code/path 稳定', () => {
  const overLimitInvalidJson = Buffer.alloc(PLATFORM_PROTOCOL_MAX_BYTES + 1, 0x7b);
  assert.throws(
    () => parseAndValidateEnvelope(overLimitInvalidJson, {
      maxBytes: PLATFORM_PROTOCOL_MAX_BYTES + 1000,
      serializedBytes: 1
    }),
    (error) => error.code === 'PROTOCOL_MESSAGE_TOO_LARGE' &&
      error.details.limit === PLATFORM_PROTOCOL_MAX_BYTES
  );
  assert.throws(
    () => parseAndValidateEnvelope('{'),
    (error) => error.code === 'PROTOCOL_INVALID_JSON' && error.path === '/'
  );

  const message = fixture('invalid/protocol-messages.invalid.v1.json')[0].message;
  const first = captureError(() => parseAndValidateEnvelope(JSON.stringify(message)));
  const second = captureError(() => parseAndValidateEnvelope(JSON.stringify(message)));
  assert.equal(first.code, 'PROTOCOL_SCHEMA_INVALID');
  assert.equal(first.path, second.path);
  assert.equal(first.details[0].code, second.details[0].code);
});

test('operation context identity 与 policy context kind 分别 fail closed', () => {
  const operationMessage = fixture('valid/protocol-messages.v1.json')
    .find((message) => message.context && message.context.kind === 'operation');
  const mismatch = structuredClone(operationMessage);
  mismatch.context.value.operationKey = 'different-operation';
  assert.throws(
    () => validateEnvelope(mismatch, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_OPERATION_KEY_MISMATCH' && error.path === '/context/value/operationKey'
  );

  const pure = structuredClone(fixture('valid/protocol-messages.v1.json')[0]);
  pure.context = operationMessage.context;
  pure.operationKey = operationMessage.operationKey;
  assert.throws(
    () => validateEnvelope(pure, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_CONTEXT_KIND_MISMATCH' && error.path === '/context/kind'
  );
});

test('直接 transport envelope 中非 JSON 值 fail closed，不被 stringify 静默改写', () => {
  const message = structuredClone(
    fixture('valid/protocol-messages.v1.json').find((item) => item.operation === 'job:start')
  );
  message.payload.input.value = Number.NaN;
  assert.throws(
    () => validateEnvelope(message, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/value'
  );

  message.payload.input.value = undefined;
  assert.throws(
    () => validateEnvelope(message, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/value'
  );
});

test('Reflect.ownKeys JSON-safe gate 拒绝隐藏 key、symbol、accessor、toJSON 与非索引数组属性', () => {
  function message() {
    return structuredClone(
      fixture('valid/protocol-messages.v1.json').find((item) => item.operation === 'job:start')
    );
  }

  const nonEnumerable = message();
  Object.defineProperty(nonEnumerable.payload.input, 'hidden', { value: true, enumerable: false });
  assert.throws(
    () => validateEnvelope(nonEnumerable, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/hidden'
  );

  const symbolKey = message();
  symbolKey.payload.input[Symbol('hidden')] = true;
  assert.throws(
    () => validateEnvelope(symbolKey, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input'
  );

  const accessor = message();
  let getterCalls = 0;
  Object.defineProperty(accessor.payload.input, 'trap', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    }
  });
  assert.throws(
    () => validateEnvelope(accessor, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/trap'
  );
  assert.equal(getterCalls, 0);

  const customJson = message();
  customJson.payload.input.toJSON = () => ({ replaced: true });
  assert.throws(
    () => validateEnvelope(customJson, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/toJSON'
  );

  const arrayExtra = message();
  arrayExtra.payload.input.items = [1];
  arrayExtra.payload.input.items.extra = true;
  assert.throws(
    () => validateEnvelope(arrayExtra, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/items/extra'
  );

  const arraySymbol = message();
  arraySymbol.payload.input.items = [1];
  arraySymbol.payload.input.items[Symbol('hidden')] = true;
  assert.throws(
    () => validateEnvelope(arraySymbol, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/items'
  );

  const arrayAccessor = message();
  arrayAccessor.payload.input.items = [1];
  let arrayGetterCalls = 0;
  Object.defineProperty(arrayAccessor.payload.input.items, '0', {
    enumerable: true,
    get() {
      arrayGetterCalls += 1;
      return 1;
    }
  });
  assert.throws(
    () => validateEnvelope(arrayAccessor, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/items/0'
  );
  assert.equal(arrayGetterCalls, 0);

  const sparseArray = message();
  sparseArray.payload.input.items = new Array(1);
  assert.throws(
    () => validateEnvelope(sparseArray, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/payload/input/items/0'
  );
});

test('Buffer 在 JSON.parse 前使用 fatal UTF-8 decoder', () => {
  assert.throws(
    () => parseAndValidateEnvelope(Buffer.from([0xc3, 0x28])),
    (error) => error.code === 'PROTOCOL_INVALID_UTF8' && error.path === '/'
  );
});

test('严格 Job/Service validator 要求完整 expected route/generation，并默认拒绝未知 action', () => {
  const job = fixture('valid/protocol-messages.v1.json').find((message) => message.channel === 'job');
  const jobRoute = {
    actionKey: job.actionKey,
    operationKey: job.operationKey,
    jobId: job.jobId,
    workerInstanceId: job.workerInstanceId,
    serviceGeneration: job.serviceGeneration,
    direction: job.direction
  };
  assert.deepEqual(validateJobEnvelope(job, jobRoute, { policyRegistry: registry }), job);
  assert.throws(
    () => validateJobEnvelope(job, { ...jobRoute, serviceGeneration: 2 }, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_ROUTE_MISMATCH' && error.path === '/serviceGeneration'
  );
  const routeWithoutGeneration = { ...jobRoute };
  delete routeWithoutGeneration.serviceGeneration;
  assert.throws(
    () => validateJobEnvelope(job, routeWithoutGeneration, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_EXPECTED_JOB_ROUTE_INVALID'
  );

  const unknown = structuredClone(job);
  unknown.actionKey = 'background-execution:unknown-action';
  assert.throws(
    () => validateJobEnvelope(unknown, { ...jobRoute, actionKey: unknown.actionKey }, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_UNKNOWN_ACTION'
  );

  const service = fixture('valid/protocol-messages.v1.json')
    .find((message) => message.channel === 'service-control');
  const serviceRoute = {
    serviceKey: service.serviceKey,
    workerInstanceId: service.workerInstanceId,
    serviceGeneration: service.serviceGeneration,
    direction: service.direction
  };
  assert.deepEqual(validateServiceControlEnvelope(service, serviceRoute, { policyRegistry: registry }), service);
  assert.throws(
    () => validateServiceControlEnvelope(service, null, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_EXPECTED_SERVICE_ROUTE_INVALID'
  );
});

test('operation body gate 冻结 SafeError/cancel ACK，并拒绝 privacy 与 maxErrorItems 反例', () => {
  const messages = fixture('valid/protocol-messages.v1.json');
  const errorMessage = messages.find((message) => message.operation === 'job:error');
  const withStack = structuredClone(errorMessage);
  withStack.payload.error.stack = '/Users/alice/private.js:1';
  assert.throws(
    () => validateEnvelope(withStack, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_SAFE_ERROR_INVALID'
  );

  const tooMany = structuredClone(errorMessage);
  tooMany.payload.error.detailLines = new Array(101).fill('safe');
  assert.throws(
    () => validateEnvelope(tooMany, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_SAFE_ERROR_INVALID' && error.path === '/payload/error/detailLines'
  );

  const progress = messages.find((message) => message.operation === 'job:progress');
  for (const privateBody of [
    { accountNumber: '6222021234567890' },
    { '账号': '6222021234567890' },
    { userPath: '/Users/alice/input.xlsx' },
    { '用户路径': '/tmp/input.xlsx' },
    { rawRow: { cell: 'private' } },
    { message: 'rawRow=招商银行第3行' },
    { message: '订单号：CN-PRIVATE-001' },
    { message: '金额明细: 借方100.00' },
    { message: 'ReconID=R-PRIVATE' },
    { message: 'failed at C:\\Users\\alice\\private\\input.xlsx' },
    { message: 'path=/Users/alice/private/input.xlsx' },
    { message: 'source=/home/alice/private/input.xlsx' },
    { message: 'file:C:\\Users\\alice\\private\\input.xlsx' },
    { message: 'location=[C:/Users/alice/private/input.xlsx]' },
    { message: 'location=file:///Users/alice/private/input.xlsx' },
    { message: 'source=file://localhost/Users/alice/private/input.xlsx' },
    { message: 'source=file://localhost/home/alice/private/input.xlsx' }
  ]) {
    const privateProgress = structuredClone(progress);
    privateProgress.payload.progress = privateBody;
    assert.throws(
      () => validateEnvelope(privateProgress, { policyRegistry: registry }),
      (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION'
    );
  }
  const safeProgress = structuredClone(progress);
  safeProgress.payload.progress = {
    message: 'rawRow parser failed; order processing will retry',
    location: 'C:\\Program Files\\BankTool\\worker.js',
    source: '/var/lib/bank-tool/input.json',
    documentation: 'http://localhost/Users/alice/help',
    remoteFile: 'file://files.example.test/home/alice/shared-help'
  };
  assert.doesNotThrow(() => validateEnvelope(safeProgress, { policyRegistry: registry }));

  const privateError = structuredClone(errorMessage);
  privateError.payload.error.message = 'source=file://localhost/home/alice/private/input.xlsx';
  assert.throws(
    () => validateEnvelope(privateError, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_PRIVACY_VIOLATION' && error.path === '/payload/error/message'
  );

  const ack = messages.find((message) => message.operation === 'cancel:ack');
  const nonCanonicalAck = structuredClone(ack);
  nonCanonicalAck.payload.cancellation = { acknowledged: true };
  assert.throws(
    () => validateEnvelope(nonCanonicalAck, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_CANCELLATION_ACK_INVALID'
  );
});

test('validated envelope 是 owned canonical snapshot，调用方后续 mutation 不改 terminal body', () => {
  const source = structuredClone(
    fixture('valid/protocol-messages.v1.json').find((message) => message.operation === 'job:done')
  );
  const owned = validateEnvelope(source, { policyRegistry: registry });
  source.payload.result.kind = 'mutated-after-validation';
  assert.equal(owned.payload.result.kind, 'ok');
  assert.equal(Object.isFrozen(owned.payload.result), true);
});

test('unknown action accessor/inherited fields fail closed，sequence validator 不二读也不抛', () => {
  const base = structuredClone(
    fixture('valid/protocol-messages.v1.json').find((message) => message.channel === 'job')
  );
  let getterCalls = 0;
  Object.defineProperty(base, 'actionKey', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'background-execution:unknown-action';
    }
  });
  const result = validateProtocolSequence([base], { policyRegistry: registry });
  assert.equal(result.valid, false);
  assert.equal(getterCalls, 0);

  const inherited = Object.create({ actionKey: 'background-execution:unknown-action' });
  Object.assign(inherited, structuredClone(
    fixture('valid/protocol-messages.v1.json').find((message) => message.channel === 'job')
  ));
  delete inherited.actionKey;
  assert.throws(
    () => validateEnvelope(inherited, { policyRegistry: registry }),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE'
  );
});

test('policyForAction 只读固定 data method 或 own-enumerable actions/action，accessor/inherited 零调用', () => {
  const actionKey = 'background-execution:pure-compute-canary';
  const policy = registry.actions[actionKey];
  assert.equal(policyForAction(registry, actionKey), policy);

  const fixedRegistry = {};
  Object.defineProperty(fixedRegistry, 'get', {
    value: (key) => key === actionKey ? policy : null
  });
  assert.equal(policyForAction(fixedRegistry, actionKey), policy);

  let getterCalls = 0;
  const accessorMethod = {};
  Object.defineProperty(accessorMethod, 'get', {
    get() {
      getterCalls += 1;
      return () => policy;
    }
  });
  assert.equal(policyForAction(accessorMethod, actionKey), null);

  const accessorActions = {};
  Object.defineProperty(accessorActions, 'actions', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return registry.actions;
    }
  });
  assert.equal(policyForAction(accessorActions, actionKey), null);
  const validMessage = structuredClone(
    fixture('valid/protocol-messages.v1.json').find((message) => message.channel === 'job')
  );
  assert.throws(
    () => validateEnvelope(validMessage, { policyRegistry: accessorActions }),
    (error) => error.code === 'PROTOCOL_UNKNOWN_ACTION'
  );
  assert.equal(validateProtocolSequence([validMessage], { policyRegistry: accessorActions }).valid, false);

  const actionMap = {};
  Object.defineProperty(actionMap, actionKey, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return policy;
    }
  });
  assert.equal(policyForAction(actionMap, actionKey), null);
  assert.equal(policyForAction(Object.create({ [actionKey]: policy }), actionKey), null);
  assert.equal(getterCalls, 0);

  let traps = 0;
  const proxiedRegistry = new Proxy({}, {
    get() { traps += 1; return undefined; },
    getPrototypeOf() { traps += 1; return Object.prototype; },
    getOwnPropertyDescriptor() { traps += 1; return undefined; }
  });
  assert.equal(policyForAction(proxiedRegistry, actionKey), null);
  assert.equal(traps, 0);
});

test('sequence 公共入口先取 owned descriptor-safe snapshot，Proxy/getter 不触发且合法 tracker 邻接不变', () => {
  let traps = 0;
  const proxiedSequence = new Proxy([], {
    get() { traps += 1; return undefined; },
    getPrototypeOf() { traps += 1; return Array.prototype; },
    ownKeys() { traps += 1; return ['length']; }
  });
  const sequenceResult = validateProtocolSequence(proxiedSequence, { policyRegistry: registry });
  assert.equal(sequenceResult.valid, false);
  assert.equal(sequenceResult.errors[0].code, 'PROTOCOL_NOT_JSON_SAFE');
  assert.equal(traps, 0);

  const tracker = createDirectionSequenceTracker();
  let getterCalls = 0;
  const accessorIdentity = { direction: 'event', jobId: 'job', workerInstanceId: 'worker' };
  Object.defineProperty(accessorIdentity, 'channel', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'job';
    }
  });
  assert.throws(
    () => tracker.next(accessorIdentity),
    (error) => error.code === 'PROTOCOL_NOT_JSON_SAFE' && error.path === '/channel'
  );
  assert.equal(getterCalls, 0);

  const identity = { channel: 'job', direction: 'event', jobId: 'job', workerInstanceId: 'worker' };
  assert.equal(tracker.next(identity), 1);
  assert.equal(tracker.current(identity), 1);
  assert.equal(tracker.observe({ ...identity, seq: 2 }), 2);
  assert.equal(tracker.reset(identity), true);
  assert.equal(tracker.current(identity), 0);
});
