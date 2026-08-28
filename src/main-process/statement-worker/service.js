'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const { canonicalSha256 } = require('../background-execution/canonical-json-v1');
const { createCanonicalEventEmitter } = require('../background-execution/adapters/canonical-event-emitter');
const { toProtocolError } = require('../background-execution/error-codec');
const {
  createServiceControlEnvelope,
  validateEnvelope
} = require('../background-execution/protocol');
const { createDirectionSequenceTracker } = require('../background-execution/sequence-tracker');
const {
  createStatementImportResult,
  createStatementInteractionCancelledResult,
  createStatementInteractionRequiredResult,
  createStatementStatusDto,
  createStatementStatusResult
} = require('./contracts');
const { createStatementServiceRequest } = require('./import-contracts');
const { createStatementGenerationRequest } = require('./generation-contracts');
const {
  executeStatementGenerationWithSafepoints,
  removeArtifacts
} = require('./generation');
const {
  createStatementBigAccountContinuationRequest,
  createStatementCancelInteractionRequest
} = require('./interaction-contracts');
const { estimateStatementServiceStateFootprint } = require('./state-footprint');
const {
  createStatementSourceIdentityGuard,
  resolveStatementSourceIdentity
} = require('./source-identity');
const {
  buildStableSummary,
  buildBigAccountInteractionDraft,
  buildStatementImportCandidate,
  createStatementServiceState,
  statementGenerationInputEvidence
} = require('./session-state');
const { createStatementTokenStore } = require('./token-store');

class StatementServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatementServiceError';
    this.code = code;
  }
}

function createStatementService(options = {}) {
  if (typeof options.postMessage !== 'function') {
    throw new TypeError('Statement Service requires postMessage');
  }
  const incomingSequence = createDirectionSequenceTracker();
  let identity = null;
  let controlSeq = 0;
  let controlOrdinal = 0;
  let state = null;
  let activeJob = null;
  let cancelledRequestTombstone = null;
  let closing = false;
  const tokenStore = createStatementTokenStore(options.tokenStoreOptions);
  const tokenClockNow = options.tokenStoreOptions && typeof options.tokenStoreOptions.now === 'function'
    ? options.tokenStoreOptions.now
    : Date.now;
  const tokenExpiryTimers = new Map();
  const tokenReleases = new Map();
  let releasedTokenTombstone = null;
  let failedGrantTombstone = null;

  function nextControlId(prefix) {
    controlOrdinal += 1;
    return `statement-${prefix}-${controlOrdinal}`;
  }

  function postControl(operation, controlId, jobRef, payload) {
    if (!identity) throw new StatementServiceError('STATEMENT_SERVICE_NOT_INITIALIZED', 'Service identity is missing');
    controlSeq += 1;
    options.postMessage(createServiceControlEnvelope({
      direction: 'event',
      operation,
      serviceKey: identity.serviceKey,
      controlId,
      workerInstanceId: identity.workerInstanceId,
      serviceGeneration: identity.serviceGeneration,
      seq: controlSeq,
      jobRef,
      payload
    }, { validate: false }));
  }

  function jobRef(start) {
    return Object.freeze({
      actionKey: start.actionKey,
      operationKey: start.operationKey,
      jobId: start.jobId,
      unitId: null
    });
  }

  function sameJobRef(left, right) {
    return Boolean(left && right &&
      left.actionKey === right.actionKey &&
      left.operationKey === right.operationKey &&
      left.jobId === right.jobId &&
      left.unitId === right.unitId);
  }

  function matchesCancelledRequest(message) {
    return Boolean(cancelledRequestTombstone &&
      cancelledRequestTombstone.phase === 'awaiting-response' &&
      message.controlId === cancelledRequestTombstone.requestControlId &&
      message.payload.requestId === cancelledRequestTombstone.requestId &&
      sameJobRef(message.jobRef, cancelledRequestTombstone.jobRef));
  }

  function safeError(error, fallbackCode, fallbackMessage) {
    const wrapped = new Error(fallbackMessage);
    wrapped.code = error && typeof error.code === 'string' ? error.code : fallbackCode;
    return wrapped;
  }

  function finishError(job, error, fallbackCode = 'STATEMENT_IMPORT_FAILED') {
    if (!job || job.terminal) return;
    cleanupUnpublishedGeneration(job);
    job.terminal = true;
    if (activeJob === job) activeJob = null;
    job.emit('job:error', {
      error: toProtocolError(safeError(error, fallbackCode, 'Statement Service operation failed'))
    });
  }

  function finishDone(job, result) {
    if (!job || job.terminal) return;
    if (job.kind === 'generation') job.unpublishedGenerationPaths = null;
    job.terminal = true;
    if (activeJob === job) activeJob = null;
    job.emit('job:done', { result });
  }

  function cleanupUnpublishedGeneration(job) {
    if (!job || !Array.isArray(job.unpublishedGenerationPaths) ||
        job.unpublishedGenerationPaths.length === 0) return;
    const paths = job.unpublishedGenerationPaths;
    job.unpublishedGenerationPaths = null;
    removeArtifacts(paths, { stagingRoot: options.stagingRoot });
  }

  function cancellationError() {
    return new StatementServiceError(
      'STATEMENT_IMPORT_CANCELLED',
      'Statement continuation cancelled'
    );
  }

  function currentSummary(activePhase = 'idle') {
    const pendingInteractions = tokenStore.listStatus();
    return createStatementStatusDto({
      ...(state.stableSummary || buildStableSummary(state)),
      pendingInteractionCount: pendingInteractions.length,
      pendingInteractions,
      activePhase
    });
  }

  function releaseToken(record, reason, completion = null) {
    if (!record) return;
    const existingRelease = tokenReleases.get(record.handle.reservationId);
    if (existingRelease) {
      if (completion && !existingRelease.completion) existingRelease.completion = completion;
      return;
    }
    tokenStore.markReleasing(record.handle.tokenId);
    const timer = tokenExpiryTimers.get(record.handle.tokenId);
    if (timer) clearTimeout(timer);
    tokenExpiryTimers.delete(record.handle.tokenId);
    const controlId = nextControlId('token-release');
    tokenReleases.set(record.handle.reservationId, {
      record,
      completion,
      controlId,
      controlIds: new Set([controlId])
    });
    postControl('resource:release', controlId, record.ownerJobRef, {
      reservationId: record.handle.reservationId,
      reason
    });
  }

  function publicTokenIdentity(record) {
    const interaction = record.publicInteraction;
    return Object.freeze({
      tokenId: interaction.tokenId,
      purpose: interaction.purpose,
      serviceGeneration: interaction.serviceGeneration,
      sessionRevision: interaction.sessionRevision,
      expiresAt: interaction.expiresAt,
      allowedChoiceDigest: interaction.allowedChoiceDigest
    });
  }

  function samePublicToken(left, right) {
    return Boolean(left && right &&
      ['tokenId', 'purpose', 'serviceGeneration', 'sessionRevision', 'expiresAt', 'allowedChoiceDigest']
        .every((key) => left[key] === right[key]));
  }

  function assertJobActive(job) {
    if (!job.cancelled && !job.terminal && activeJob === job) return;
    throw new StatementServiceError('STATEMENT_IMPORT_CANCELLED', 'Statement operation cancelled before adoption');
  }

  function requestInteractionToken(job, interactionDraft) {
    assertJobActive(job);
    const draft = tokenStore.prepare({
      ...interactionDraft,
      serviceGeneration: state.serviceGeneration
    });
    const result = createStatementInteractionRequiredResult({
      status: 'interaction-required',
      interaction: draft.publicInteraction
    }, job.start.actionKey);
    assertJobActive(job);
    const requestId = nextControlId('request');
    const owner = Object.freeze({
      kind: 'interaction-token',
      ownerKeyHash: createHash('sha256').update(`service.statement/token/${draft.tokenId}`).digest('hex'),
      candidateRevision: ++controlOrdinal
    });
    Object.assign(job, {
      kind: 'token', interactionDraft: draft, requestId,
      requestControlId: nextControlId('request-control'), owner, result
    });
    assertJobActive(job);
    postControl('resource:request', job.requestControlId, jobRef(job.start), {
      requestId, requestKind: 'pending-interaction-create',
      requested: { memoryBytes: draft.footprint.estimatedBytes, cpuSlots: 0, ioHeavySlots: 0 },
      replacesReservationId: null, owner
    });
  }

  async function resolvePrivateSources(request, job) {
    if (typeof options.resolveSourceResource !== 'function') {
      throw new StatementServiceError(
        'STATEMENT_SOURCE_RESOURCE_UNAVAILABLE',
        'Statement source resource resolver is unavailable'
      );
    }
    const sources = [];
    const identityGuard = createStatementSourceIdentityGuard(state);
    for (const source of request.sources) {
      assertJobActive(job);
      const resolved = options.resolveSourceResource(source.resourceId);
      const resolution = typeof resolved === 'string'
        ? { path: resolved, legacyPath: resolved, allowedRoot: null }
        : resolved;
      if (!resolution || typeof resolution !== 'object' ||
          typeof resolution.path !== 'string' || resolution.path.length === 0 ||
          typeof resolution.legacyPath !== 'string' || resolution.legacyPath.length === 0 ||
          (resolution.allowedRoot !== null &&
            (typeof resolution.allowedRoot !== 'string' || resolution.allowedRoot.length === 0))) {
        throw new StatementServiceError(
          'STATEMENT_SOURCE_RESOURCE_UNAVAILABLE',
          'Statement source resource identity is unavailable'
        );
      }
      const privateSource = await resolveStatementSourceIdentity(source, resolution.path, {
        allowedRoot: resolution.allowedRoot,
        legacyPath: resolution.legacyPath,
        assertNotCancelled: () => assertJobActive(job)
      });
      identityGuard.accept(privateSource);
      sources.push(privateSource);
    }
    return Object.freeze(sources);
  }

  async function beginJob(start) {
    const emit = createCanonicalEventEmitter(start, options.postMessage);
    const job = {
      start,
      emit,
      terminal: false,
      cancelled: false,
      adoptionStarted: false,
      requestId: null,
      requestControlId: null,
      owner: null,
      candidate: null,
      footprint: null,
      result: null,
      grant: null,
      revokedCandidateError: null
    };
    activeJob = job;
    try {
      if (start.actionKey === 'statement:generate-current' ||
          start.actionKey === 'statement:generate-all') {
        const scope = start.actionKey === 'statement:generate-all' ? 'all' : 'current';
        const request = createStatementGenerationRequest(start.payload.input);
        const session = state.sessions.get(request.sessionKey);
        if (!session) {
          throw new StatementServiceError(
            'STATEMENT_GENERATION_SESSION_MISSING',
            'Statement generation session does not exist'
          );
        }
        if (request.command === 'prepare-generation') {
          const scopeEvidenceHashes = {
            current: statementGenerationInputEvidence(session, 'current').hash,
            all: statementGenerationInputEvidence(session, 'all').hash
          };
          const tokenInputEvidenceHash = canonicalSha256({
            sessionKey: request.sessionKey,
            sessionRevision: state.sessionRevision,
            scopeEvidenceHashes
          });
          const interactionDraft = Object.freeze({
            purpose: 'scope-generation',
            sessionKey: request.sessionKey,
            sessionRevision: state.sessionRevision,
            prompt: {
              status: 'select-export-scope',
              kind: request.kind === 'both' ? 'detail' : request.kind,
              options: [
                { scope: 'current', label: `导出当前批次文件的${request.kind === 'balance' ? '余额' : '明细'}` },
                { scope: 'all', label: `导出所有批次文件的${request.kind === 'balance' ? '余额' : '明细'}` }
              ]
            },
            allowedChoices: {
              kind: request.kind,
              scopes: ['current', 'all'],
              inputEvidenceHash: tokenInputEvidenceHash
            },
            privateContext: {
              evidence: {
                sessionKey: request.sessionKey,
                sessionRevision: state.sessionRevision,
                inputEvidenceHash: tokenInputEvidenceHash
              },
              choiceDomain: {
                kind: request.kind,
                scopes: ['current', 'all'],
                inputEvidenceHash: tokenInputEvidenceHash
              },
              scopeEvidenceHashes
            }
          });
          const existingToken = tokenStore.listRecords()[0];
          if (existingToken) {
            releaseToken(existingToken, 'session-invalidated', { job, interactionDraft });
            return;
          }
          requestInteractionToken(job, interactionDraft);
          return;
        }
        if (request.sessionRevision !== state.sessionRevision ||
            request.token.sessionRevision !== state.sessionRevision) {
          throw new StatementServiceError('STATEMENT_TOKEN_STALE', 'Statement generation revision is stale');
        }
        const pendingToken = tokenStore.inspect(request.token.tokenId);
        if (!pendingToken) {
          throw new StatementServiceError('STATEMENT_TOKEN_STALE', 'Statement generation token is stale');
        }
        if (pendingToken.handle.purpose !== 'scope-generation' ||
            !pendingToken.privateContext || !pendingToken.privateContext.scopeEvidenceHashes ||
            !pendingToken.privateContext.choiceDomain) {
          throw new StatementServiceError('STATEMENT_TOKEN_STALE', 'Statement generation token is stale');
        }
        if (pendingToken.privateContext.choiceDomain.kind !== request.kind ||
            !pendingToken.privateContext.choiceDomain.scopes.includes(scope)) {
          throw new StatementServiceError(
            'STATEMENT_GENERATION_CHOICE_INVALID',
            'Statement generation choice is not allowed'
          );
        }
        const currentEvidence = statementGenerationInputEvidence(session, scope);
        const privateEvidence = pendingToken.privateContext.evidence;
        if (pendingToken.privateContext.scopeEvidenceHashes[scope] !== currentEvidence.hash) {
          throw new StatementServiceError(
            'STATEMENT_GENERATION_INPUT_STALE',
            'Statement generation input evidence changed'
          );
        }
        const tokenRecord = tokenStore.beginConsume(request.token, {
          serviceGeneration: state.serviceGeneration,
          sessionRevision: state.sessionRevision,
          purpose: 'scope-generation',
          sessionKey: request.sessionKey,
          evidence: privateEvidence,
          choiceDomain: pendingToken.privateContext.choiceDomain,
          choice: {
            kind: request.kind,
            scope,
            inputEvidenceHash: pendingToken.privateContext.choiceDomain.inputEvidenceHash
          }
        });
        Object.assign(job, { kind: 'generation', tokenRecord });
        await new Promise((resolve) => setImmediate(resolve));
        assertJobActive(job);
        job.generationInFlight = true;
        let result;
        try {
          result = await (options.executeGeneration || executeStatementGenerationWithSafepoints)({
            session,
            entries: currentEvidence.entries,
            request,
            scope,
            inputEvidenceHash: currentEvidence.hash,
            stagingRoot: options.stagingRoot,
            storageRoot: options.storageRoot,
            balanceTemplatePath: options.balanceTemplatePath,
            assertNotCancelled: () => assertJobActive(job),
            yieldToEventLoop: options.yieldGenerationSafepoint
          });
        } finally {
          job.generationInFlight = false;
        }
        assertJobActive(job);
        job.unpublishedGenerationPaths = Object.freeze(
          result.artifacts.map((artifact) => artifact.generationPath)
        );
        releaseToken(tokenRecord, 'token-consumed', { job, result });
        return;
      }
      if (start.actionKey === 'statement:resolve-big-account') {
        if (start.payload.input && start.payload.input.command === 'cancel-interaction') {
          const cancellation = createStatementCancelInteractionRequest(start.payload.input);
          const result = createStatementInteractionCancelledResult({
            status: 'interaction-cancelled',
            tokenId: cancellation.token.tokenId
          });
          if (releasedTokenTombstone && releasedTokenTombstone.kind === 'cancel-interaction' &&
              samePublicToken(cancellation.token, releasedTokenTombstone.token)) {
            finishDone(job, result);
            return;
          }
          const tokenRecord = tokenStore.claimCancellation(cancellation.token, {
            serviceGeneration: state.serviceGeneration,
            sessionRevision: state.sessionRevision,
            purpose: 'big-account'
          });
          Object.assign(job, { kind: 'cancel-interaction', tokenRecord, result });
          releaseToken(tokenRecord, 'job-failed', { job, result });
          return;
        }
        const continuation = createStatementBigAccountContinuationRequest(start.payload.input);
        const pendingToken = tokenStore.inspect(continuation.token.tokenId);
        if (!pendingToken) {
          throw new StatementServiceError('STATEMENT_TOKEN_STALE', 'Statement token is stale');
        }
        const tokenRecord = tokenStore.beginConsume(continuation.token, {
          serviceGeneration: state.serviceGeneration,
          sessionRevision: state.sessionRevision,
          purpose: 'big-account',
          sessionKey: continuation.importEvidence.sessionOwner.sessionKey,
          evidence: {
            sessionOwner: continuation.importEvidence.sessionOwner,
            templateCatalog: continuation.importEvidence.templateCatalog,
            sources: continuation.importEvidence.sources
          },
          choiceDomain: pendingToken.privateContext.choiceDomain,
          choice: continuation.choice
        });
        Object.assign(job, { kind: 'continuation', tokenRecord });
        const privateRequest = Object.freeze({
          ...continuation.importEvidence,
          sources: await resolvePrivateSources(continuation.importEvidence, job)
        });
        const originalSources = tokenRecord.privateContext.request.sources;
        if (privateRequest.sources.length !== originalSources.length ||
            privateRequest.sources.some((source, index) => {
              const original = originalSources[index];
              return source.resourceId !== original.resourceId ||
                source.templateRef !== original.templateRef ||
                source.path !== original.path ||
                !isDeepStrictEqual(source.snapshot, original.snapshot) ||
                !isDeepStrictEqual(source.sourceIdentity, original.sourceIdentity);
            })) {
          throw new StatementServiceError(
            'STATEMENT_TOKEN_SOURCE_IDENTITY_STALE',
            'Statement source resource identity changed before continuation'
          );
        }
        const candidate = await buildStatementImportCandidate(state, privateRequest, {
          assertNotCancelled: () => assertJobActive(job),
          bigAccountAssignments: tokenRecord.claimedChoice.assignments,
          bigAccountChoiceMode: tokenRecord.claimedChoice.mode,
          expectedProvisionalDigest: tokenRecord.privateContext.candidateDigest
        });
        assertJobActive(job);
        const footprint = estimateStatementServiceStateFootprint(candidate.state);
        const result = createStatementImportResult({
          status: 'imported', summary: candidate.state.stableSummary, session: candidate.result
        });
        const requestId = nextControlId('request');
        const owner = Object.freeze({
          kind: 'service-state',
          ownerKeyHash: createHash('sha256').update('service.statement/session-state').digest('hex'),
          candidateRevision: candidate.state.sessionRevision
        });
        Object.assign(job, {
          kind: 'persistent-after-token', tokenRecord, requestId,
          requestControlId: nextControlId('request-control'), owner, candidate, footprint, result
        });
        assertJobActive(job);
        postControl('resource:request', job.requestControlId, jobRef(start), {
          requestId, requestKind: 'persistent-state-replace',
          requested: { memoryBytes: footprint.estimatedBytes, cpuSlots: 0, ioHeavySlots: 0 },
          replacesReservationId: state.persistentReservationId, owner
        });
        return;
      }
      if (start.actionKey !== 'statement:import') {
        throw new StatementServiceError(
          'STATEMENT_ACTION_UNSUPPORTED',
          'E09-B Statement Service only supports statement:import and statement:resolve-big-account'
        );
      }
      const request = createStatementServiceRequest(start.payload.input);
      if (request.command === 'status') {
        const summary = currentSummary(tokenStore.listStatus().length ? 'waiting-user' : 'idle');
        finishDone(job, createStatementStatusResult({ status: 'status', summary }));
        return;
      }

      await new Promise((resolve) => setImmediate(resolve));
      assertJobActive(job);
      const privateRequest = Object.freeze({
        ...request,
        sources: await resolvePrivateSources(request, job)
      });
      const interactionDraft = await buildBigAccountInteractionDraft(state, privateRequest, {
        assertNotCancelled: () => assertJobActive(job)
      });
      assertJobActive(job);
      if (interactionDraft) {
        const existingToken = tokenStore.listRecords()[0];
        if (existingToken) {
          releaseToken(existingToken, 'session-invalidated', { job, interactionDraft });
          return;
        }
        requestInteractionToken(job, interactionDraft);
        return;
      }
      const candidate = await buildStatementImportCandidate(state, privateRequest, {
        assertNotCancelled: () => assertJobActive(job)
      });
      assertJobActive(job);
      const footprint = estimateStatementServiceStateFootprint(candidate.state);
      const result = createStatementImportResult({
        status: 'imported',
        summary: candidate.state.stableSummary,
        session: candidate.result
      });
      if (typeof options.beforeAdopt === 'function') {
        options.beforeAdopt(Object.freeze({
          candidateRevision: candidate.state.sessionRevision
        }));
      }
      assertJobActive(job);
      const requestId = nextControlId('request');
      const owner = Object.freeze({
        kind: 'service-state',
        ownerKeyHash: createHash('sha256').update('service.statement/session-state').digest('hex'),
        candidateRevision: candidate.state.sessionRevision
      });
      job.requestId = requestId;
      job.requestControlId = nextControlId('request-control');
      job.owner = owner;
      job.candidate = candidate;
      job.footprint = footprint;
      job.result = result;
      assertJobActive(job);
      postControl('resource:request', job.requestControlId, jobRef(start), {
        requestId,
        requestKind: 'persistent-state-replace',
        requested: { memoryBytes: footprint.estimatedBytes, cpuSlots: 0, ioHeavySlots: 0 },
        replacesReservationId: state.persistentReservationId,
        owner
      });
    } catch (error) {
      if (job.terminal) return;
      if (job.tokenRecord && tokenReleases.has(job.tokenRecord.handle.reservationId)) return;
      if (job.tokenRecord && ['published', 'consuming', 'inserted'].includes(job.tokenRecord.state)) {
        releaseToken(job.tokenRecord, 'job-failed', { job, error });
        return;
      }
      if (error && error.code === 'STATEMENT_IMPORT_CANCELLED') {
        if (!job.terminal) job.emit('cancel:ack', { cancellation: { scope: 'job' } });
        finishError(job, error, 'STATEMENT_IMPORT_CANCELLED');
        return;
      }
      finishError(job, error);
    }
  }

  function handleResourceGrant(message) {
    const job = activeJob;
    if (!job || job.terminal || (!job.candidate && job.kind !== 'token') ||
        message.payload.requestId !== job.requestId) {
      if (matchesCancelledRequest(message)) {
        cancelledRequestTombstone = {
          ...cancelledRequestTombstone,
          phase: 'awaiting-revoke',
          grantId: message.payload.grantId,
          reservationId: message.payload.reservationId
        };
        return;
      }
      throw new StatementServiceError('STATEMENT_SERVICE_GRANT_STALE', 'Resource grant does not match active candidate');
    }
    if (job.cancelled) {
      throw new StatementServiceError('STATEMENT_IMPORT_CANCELLED', 'Cancelled candidate received a resource grant');
    }
    try {
      job.grant = message.payload;
      job.adoptionStarted = true;
      if (job.kind === 'token') {
        const record = tokenStore.insertPrivate(job.interactionDraft, {
          ...message.payload,
          owner: job.owner,
          ownerJobRef: jobRef(job.start)
        });
        job.tokenRecord = record;
      }
      if (typeof options.withholdAdopt === 'function' && options.withholdAdopt(Object.freeze({
        candidateRevision: job.owner.candidateRevision,
        requestId: job.requestId,
        reservationId: message.payload.reservationId
      }))) {
        return;
      }
      postControl('resource:adopted', nextControlId('adopted'), jobRef(job.start), {
        requestId: job.requestId,
        grantId: message.payload.grantId,
        reservationId: message.payload.reservationId,
        owner: job.owner
      });
    } catch (error) {
      job.candidate = null;
      failedGrantTombstone = {
        phase: 'awaiting-revoke',
        reservationId: message.payload.reservationId,
        grantId: message.payload.grantId,
        jobRef: jobRef(job.start),
        revokeControlId: null
      };
      finishError(job, error, 'STATEMENT_ADOPTION_FAILED');
    }
  }

  function handleResourceReject(message) {
    const job = activeJob;
    if (!job || job.terminal || message.payload.requestId !== job.requestId) {
      if (matchesCancelledRequest(message)) {
        cancelledRequestTombstone = null;
        return;
      }
      throw new StatementServiceError('STATEMENT_SERVICE_REJECT_STALE', 'Resource reject does not match active candidate');
    }
    const error = new StatementServiceError(
      'STATEMENT_RESERVATION_REJECTED',
      `Statement reservation rejected: ${message.payload.reasonCode}`
    );
    job.candidate = null;
    if (job.tokenRecord) {
      releaseToken(job.tokenRecord, 'job-failed', { job, error });
      return;
    }
    finishError(job, error, 'STATEMENT_RESERVATION_REJECTED');
  }

  function handleAdoptAck(message) {
    const job = activeJob;
    if (!job || job.terminal || ((!job.candidate || !job.result) && job.kind !== 'token') || !job.grant ||
        message.payload.requestId !== job.requestId ||
        message.payload.grantId !== job.grant.grantId ||
        message.payload.reservationId !== job.grant.reservationId) {
      throw new StatementServiceError('STATEMENT_SERVICE_ADOPT_ACK_STALE', 'Adopt ack does not match active candidate');
    }
    if (job.kind === 'token') {
      const record = tokenStore.markAdopted(job.tokenRecord.handle.tokenId, message.payload);
      const delay = Math.max(0, record.handle.expiresAt - tokenClockNow());
      const expiryTimer = setTimeout(() => {
        if (tokenStore.inspect(record.handle.tokenId)?.state === 'published') {
          releaseToken(record, 'token-expired');
        }
      }, delay);
      if (typeof expiryTimer.unref === 'function') expiryTimer.unref();
      tokenExpiryTimers.set(record.handle.tokenId, expiryTimer);
      finishDone(job, job.result);
      return;
    }
    const adopted = job.candidate.state;
    adopted.persistentReservationId = message.payload.reservationId;
    adopted.activePhase = 'idle';
    adopted.stableSummary = buildStableSummary(adopted);
    state = adopted;
    job.candidate = null;
    if (job.tokenRecord) {
      releaseToken(job.tokenRecord, 'token-consumed', { job, result: job.result });
    } else {
      const published = tokenStore.listRecords().find((record) => record.state === 'published');
      if (published) {
        releaseToken(published, 'session-invalidated', { job, result: job.result });
        return;
      }
      finishDone(job, job.result);
    }
  }

  function handleCancel(message) {
    const job = activeJob;
    if (!job || job.terminal || message.jobId !== job.start.jobId) return;
    if (job.adoptionStarted) return;
    if (job.requestId && !job.grant) {
      cancelledRequestTombstone = {
        phase: 'awaiting-response',
        requestId: job.requestId,
        requestControlId: job.requestControlId,
        jobRef: jobRef(job.start),
        grantId: null,
        reservationId: null,
        revokeControlId: null
      };
    }
    job.cancelled = true;
    job.candidate = null;
    job.emit('cancel:ack', { cancellation: { scope: 'job' } });
    if (job.tokenRecord) {
      if (job.generationInFlight) return;
      cleanupUnpublishedGeneration(job);
      releaseToken(job.tokenRecord, 'job-failed', {
        job,
        error: cancellationError()
      });
      return;
    }
    finishError(
      job,
      new StatementServiceError('STATEMENT_IMPORT_CANCELLED', 'Statement import cancelled before adoption'),
      'STATEMENT_IMPORT_CANCELLED'
    );
  }

  function handleResourceRevoke(message) {
    const reservationId = message.payload.reservationId;
    const failedGrant = failedGrantTombstone &&
      failedGrantTombstone.phase === 'awaiting-revoke' &&
      reservationId === failedGrantTombstone.reservationId &&
      message.payload.grantId === failedGrantTombstone.grantId &&
      sameJobRef(message.jobRef, failedGrantTombstone.jobRef);
    const tokenRecord = tokenStore.listRecords().find((record) =>
      record.handle.reservationId === reservationId);
    if (tokenRecord) {
      const adoptionTimeoutJob = message.payload.reasonCode === 'adoption-timeout' &&
        activeJob && !activeJob.terminal && activeJob.kind === 'token' &&
        activeJob.tokenRecord === tokenRecord && tokenRecord.state === 'inserted' &&
        activeJob.grant && activeJob.grant.grantId === message.payload.grantId &&
        sameJobRef(message.jobRef, jobRef(activeJob.start));
      const timeoutCompletion = adoptionTimeoutJob
        ? {
            job: activeJob,
            error: new StatementServiceError(
              'STATEMENT_ADOPTION_TIMEOUT',
              'Statement token adoption timed out'
            )
          }
        : null;
      const existingRelease = tokenReleases.get(reservationId);
      if (!existingRelease) {
        tokenStore.markReleasing(tokenRecord.handle.tokenId);
        tokenReleases.set(reservationId, {
          record: tokenRecord,
          completion: timeoutCompletion,
          controlId: message.controlId,
          controlIds: new Set([message.controlId])
        });
      } else {
        existingRelease.controlIds.add(message.controlId);
        if (timeoutCompletion && !existingRelease.completion) {
          existingRelease.completion = timeoutCompletion;
        }
      }
      if (failedGrant) {
        failedGrantTombstone = {
          ...failedGrantTombstone,
          phase: 'awaiting-release-ack',
          revokeControlId: message.controlId
        };
      }
      postControl('resource:release', message.controlId, message.jobRef, {
        reservationId,
        reason: adoptionTimeoutJob || failedGrant ? 'job-failed' : 'service-close'
      });
      return;
    }
    if (failedGrant) {
      failedGrantTombstone = {
        ...failedGrantTombstone,
        phase: 'awaiting-release-ack',
        revokeControlId: message.controlId
      };
      postControl('resource:release', message.controlId, message.jobRef, {
        reservationId,
        reason: 'job-failed'
      });
      return;
    }
    if (cancelledRequestTombstone &&
        cancelledRequestTombstone.phase === 'awaiting-revoke' &&
        reservationId === cancelledRequestTombstone.reservationId &&
        message.payload.grantId === cancelledRequestTombstone.grantId &&
        sameJobRef(message.jobRef, cancelledRequestTombstone.jobRef)) {
      cancelledRequestTombstone = {
        ...cancelledRequestTombstone,
        phase: 'awaiting-release-ack',
        revokeControlId: message.controlId
      };
      postControl('resource:release', message.controlId, message.jobRef, {
        reservationId,
        reason: 'job-failed'
      });
      return;
    }
    if (activeJob && activeJob.grant &&
        reservationId === activeJob.grant.reservationId) {
      activeJob.revokedCandidateError = new StatementServiceError(
        'STATEMENT_ADOPTION_TIMEOUT',
        'Statement candidate adoption timed out'
      );
      activeJob.candidate = null;
      postControl('resource:release', message.controlId, message.jobRef, {
        reservationId,
        reason: 'job-failed'
      });
      return;
    }
    if (!state || reservationId !== state.persistentReservationId) {
      throw new StatementServiceError('STATEMENT_SERVICE_REVOKE_STALE', 'Resource revoke is not current');
    }
    postControl('resource:release', message.controlId, message.jobRef, {
      reservationId,
      reason: 'service-close'
    });
  }

  function handleMessage(rawMessage) {
    const message = validateEnvelope(rawMessage);
    if (message.direction !== 'command') {
      throw new StatementServiceError('STATEMENT_SERVICE_DIRECTION_INVALID', 'Service only accepts commands');
    }
    incomingSequence.observe(message);
    if (message.channel === 'service-control') {
      if (message.operation === 'executor:init') {
        if (identity) throw new StatementServiceError('STATEMENT_SERVICE_INIT_DUPLICATE', 'Duplicate executor:init');
        identity = Object.freeze({
          serviceKey: message.serviceKey,
          workerInstanceId: message.workerInstanceId,
          serviceGeneration: message.serviceGeneration
        });
        state = createStatementServiceState(message.serviceGeneration);
        state.stableSummary = buildStableSummary(state);
        postControl('executor:ready', nextControlId('ready'), null, {
          contractVersion: 1,
          capabilities: ['resource-control-v1', 'statement-import-session-v1']
        });
        return;
      }
      if (message.operation === 'resource:grant') return handleResourceGrant(message);
      if (message.operation === 'resource:reject') return handleResourceReject(message);
      if (message.operation === 'resource:adopt-ack') return handleAdoptAck(message);
      if (message.operation === 'resource:revoke') return handleResourceRevoke(message);
      if (message.operation === 'resource:release-ack') {
        const release = tokenReleases.get(message.payload.reservationId);
        if (release && release.controlIds.has(message.controlId)) {
          tokenReleases.delete(message.payload.reservationId);
          tokenStore.remove(release.record.handle.tokenId);
          releasedTokenTombstone = Object.freeze({
            kind: release.completion && release.completion.job &&
              release.completion.job.kind === 'cancel-interaction'
              ? 'cancel-interaction'
              : 'other-release',
            reservationId: message.payload.reservationId,
            controlIds: Object.freeze([...release.controlIds]),
            token: publicTokenIdentity(release.record)
          });
          if (failedGrantTombstone &&
              failedGrantTombstone.phase === 'awaiting-release-ack' &&
              message.payload.reservationId === failedGrantTombstone.reservationId &&
              message.controlId === failedGrantTombstone.revokeControlId &&
              sameJobRef(message.jobRef, failedGrantTombstone.jobRef)) {
            failedGrantTombstone = null;
          }
          if (release.completion) {
            if (release.completion.job && release.completion.job.cancelled) {
              cleanupUnpublishedGeneration(release.completion.job);
              finishError(
                release.completion.job,
                cancellationError(),
                'STATEMENT_IMPORT_CANCELLED'
              );
            } else if (release.completion.interactionDraft) {
              if (release.completion.job.terminal || release.completion.job.cancelled) return;
              try {
                requestInteractionToken(release.completion.job, release.completion.interactionDraft);
              } catch (error) {
                finishError(release.completion.job, error);
              }
            } else if (release.completion.error) {
              finishError(release.completion.job, release.completion.error);
            } else {
              finishDone(release.completion.job, release.completion.result);
            }
          }
          return;
        }
        if (failedGrantTombstone &&
            failedGrantTombstone.phase === 'awaiting-release-ack' &&
            message.payload.reservationId === failedGrantTombstone.reservationId &&
            message.controlId === failedGrantTombstone.revokeControlId &&
            sameJobRef(message.jobRef, failedGrantTombstone.jobRef)) {
          failedGrantTombstone = null;
          return;
        }
        if (releasedTokenTombstone &&
            message.payload.reservationId === releasedTokenTombstone.reservationId &&
            releasedTokenTombstone.controlIds.includes(message.controlId)) {
          return;
        }
        if (cancelledRequestTombstone &&
            cancelledRequestTombstone.phase === 'awaiting-release-ack' &&
            message.controlId === cancelledRequestTombstone.revokeControlId &&
            message.payload.reservationId === cancelledRequestTombstone.reservationId &&
            sameJobRef(message.jobRef, cancelledRequestTombstone.jobRef)) {
          cancelledRequestTombstone = null;
          return;
        }
        if (activeJob && activeJob.revokedCandidateError && activeJob.grant &&
            message.payload.reservationId === activeJob.grant.reservationId) {
          const job = activeJob;
          const error = job.revokedCandidateError;
          job.revokedCandidateError = null;
          if (job.tokenRecord) {
            releaseToken(job.tokenRecord, 'job-failed', { job, error });
            return;
          }
          finishError(job, error, 'STATEMENT_ADOPTION_TIMEOUT');
          return;
        }
        if (state && message.payload.reservationId === state.persistentReservationId) {
          state = createStatementServiceState(identity.serviceGeneration);
          state.stableSummary = buildStableSummary(state);
        }
        return;
      }
      if (message.operation === 'executor:close') {
        closing = true;
        postControl('executor:close-ack', message.controlId, null, {});
        if (typeof options.close === 'function') queueMicrotask(options.close);
        return;
      }
      throw new StatementServiceError(
        'STATEMENT_SERVICE_CONTROL_UNSUPPORTED',
        `Unsupported service operation: ${message.operation}`
      );
    }
    if (closing || !identity || !state) {
      throw new StatementServiceError('STATEMENT_SERVICE_NOT_READY', 'Statement Service is not ready');
    }
    if (message.operation === 'job:start') {
      if (activeJob) throw new StatementServiceError('STATEMENT_SERVICE_BUSY', 'Statement Service is busy');
      void beginJob(message);
      return;
    }
    if (message.operation === 'job:cancel') return handleCancel(message);
    throw new StatementServiceError(
      'STATEMENT_SERVICE_JOB_UNSUPPORTED',
      `Unsupported job operation: ${message.operation}`
    );
  }

  return Object.freeze({ handleMessage });
}

module.exports = {
  StatementServiceError,
  createStatementService
};
