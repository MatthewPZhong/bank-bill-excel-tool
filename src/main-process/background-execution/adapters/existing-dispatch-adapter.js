'use strict';

const { toProtocolError } = require('../error-codec');
const { createCanonicalEventEmitter } = require('./canonical-event-emitter');

function resolveDispatch(entry, configuredDispatch) {
  if (typeof configuredDispatch === 'function') return configuredDispatch;
  if (configuredDispatch && typeof configuredDispatch.dispatch === 'function') {
    return configuredDispatch.dispatch.bind(configuredDispatch);
  }
  if (typeof entry === 'function') return entry;
  if (entry && typeof entry.dispatch === 'function') return entry.dispatch.bind(entry);
  throw new TypeError('existing-dispatch adapter requires a dispatch function');
}

function normalizeDispatchResult(result) {
  if (result && result.promise && typeof result.promise.then === 'function') return result;
  if (result && typeof result.then === 'function') return { promise: result };
  return { promise: Promise.resolve(result) };
}

function normalizeCancelResult(result) {
  if (result === undefined || result === null) return null;
  if (typeof result === 'boolean') return result;
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  throw new TypeError('existing-dispatch cancel must resolve a CancelResult object, boolean, or void');
}

function cancelWasAcknowledged(result) {
  if (result === true) return true;
  if (!result || typeof result !== 'object') return false;
  if (result.acknowledged === false || result.accepted === false || result.status === 'rejected') return false;
  return result.acknowledged === true || result.accepted === true || result.status === 'acknowledged';
}

function createExistingDispatchAdapter(options = {}) {
  const configuredDispatch = options.dispatch;
  const cancellationStates = new WeakMap();
  return Object.freeze({
    kind: 'existing-dispatch',
    inspectTopology(request) {
      const owner = configuredDispatch && typeof configuredDispatch === 'object' ? configuredDispatch : null;
      const inspect = options.inspectTopology || (owner && owner.inspectTopology);
      return typeof inspect === 'function' ? inspect.call(owner, request) : null;
    },
    start(request, emit) {
      const dispatch = resolveDispatch(request.entry, configuredDispatch);
      function reportError(error) {
        if (typeof request.onError !== 'function') return;
        try { request.onError(error); } catch (_callbackError) {}
      }
      function guardedEmit(operation, payload) {
        try {
          emit(operation, payload);
        } catch (error) {
          reportError(error);
        }
      }
      const dispatched = dispatch({
        actionKey: request.actionKey,
        operationKey: request.operationKey,
        jobId: request.jobId,
        context: request.context,
        input: request.input,
        topology: request.topology || null,
        onProgress(progress) {
          guardedEmit('job:progress', { progress });
        }
      });
      const handle = normalizeDispatchResult(dispatched);
      const cancellationState = {
        cancelInvoked: false,
        terminalEvidenceReported: false,
        terminalObserved: false
      };
      cancellationStates.set(handle, cancellationState);

      function reportCancellationTerminal() {
        if (cancellationState.terminalEvidenceReported) return;
        cancellationState.terminalEvidenceReported = true;
        if (typeof request.onCancellationTerminal === 'function') {
          try {
            request.onCancellationTerminal();
          } catch (callbackError) {
            reportError(callbackError);
          }
        }
      }

      function emitDispatchError(error) {
        guardedEmit('job:error', {
          error: toProtocolError(error, 'EXISTING_DISPATCH_ERROR', request.safeErrorOptions)
        });
      }
      void Promise.resolve(handle.promise).then((result) => {
        cancellationState.terminalObserved = true;
        guardedEmit('job:done', { result });
      }, (error) => {
        cancellationState.terminalObserved = true;
        // 可选私有握手只供能识别真实 executor 取消错误的 dispatcher 使用；
        // generic void legacy-cancel 兼容语义保持不变。必须在 job:error 前上报，
        // 让 Supervisor 的同一 terminal gate 看到真实取消因果。
        if (cancellationState.cancelInvoked &&
            typeof handle.isCancellationTerminalError === 'function' &&
            handle.isCancellationTerminalError(error) === true) {
          reportCancellationTerminal();
        }
        emitDispatchError(error);
      }).catch(reportError);
      cancellationState.reportCancellationTerminal = reportCancellationTerminal;
      return handle;
    },
    cancel(handle, reason) {
      if (!handle || typeof handle.cancel !== 'function') return Promise.resolve(null);
      const cancellationState = cancellationStates.get(handle);
      return Promise.resolve().then(() => {
        if (cancellationState && cancellationState.terminalObserved) return null;
        const rawResult = handle.cancel(reason);
        if (cancellationState) cancellationState.cancelInvoked = true;
        if (rawResult === undefined || rawResult === null) {
          if (cancellationState) {
            cancellationState.reportCancellationTerminal();
          }
          return null;
        }
        return Promise.resolve(rawResult).then(normalizeCancelResult);
      });
    },
    async close(handle) {
      if (handle && typeof handle.close === 'function') await handle.close();
    }
  });
}

function createExistingDispatchTransportAdapter(existingAdapter) {
  if (!existingAdapter || typeof existingAdapter.start !== 'function' ||
      typeof existingAdapter.cancel !== 'function' || typeof existingAdapter.close !== 'function') {
    throw new TypeError('ExistingDispatchAdapter must expose start/cancel/close');
  }
  return Object.freeze({
    kind: 'existing-dispatch-transport',
    start(startOptions) {
      const policy = startOptions.policy || {
        protocolLimits: { eventMaxBytes: 262144 },
        result: { maxErrorItems: 100 },
        metrics: { privacyProfile: 'finance-safe-v1' }
      };
      let dispatchHandle = null;
      let emit = null;
      let started = false;
      let closed = false;
      let cancelInvoked = false;

      function reportError(error) {
        if (!closed && typeof startOptions.onError === 'function') {
          try { startOptions.onError(error); } catch (_callbackError) {}
        }
      }

      return Object.freeze({
        ready: Promise.resolve(),
        send(envelope) {
          if (closed) return;
          if (envelope.operation === 'job:start') {
            if (started) throw new Error('existing-dispatch transport received duplicate job:start');
            started = true;
            emit = createCanonicalEventEmitter(envelope, startOptions.onMessage, reportError, {
              policy
            });
            try {
              dispatchHandle = existingAdapter.start({
                entry: startOptions.entry,
                actionKey: envelope.actionKey,
                operationKey: envelope.operationKey,
                jobId: envelope.jobId,
                context: envelope.context,
                input: envelope.payload.input,
                topology: startOptions.topology || null,
                safeErrorOptions: {
                  maxBytes: policy.protocolLimits.eventMaxBytes,
                  maxErrorItems: policy.result.maxErrorItems,
                  privacyProfile: policy.metrics.privacyProfile,
                  stage: 'execute'
                },
                onCancellationTerminal() {
                  if (!closed && typeof startOptions.onCancellationTerminal === 'function') {
                    startOptions.onCancellationTerminal();
                  }
                },
                onError: reportError
              }, (operation, payload, unitId = null) => {
                if (!closed) emit(operation, payload, unitId);
              });
            } catch (error) {
              emit('job:error', {
                error: toProtocolError(error, 'EXISTING_DISPATCH_START_FAILED', {
                  maxErrorItems: policy.result.maxErrorItems,
                  stage: 'spawn'
                })
              });
            }
            return;
          }
          if (envelope.operation !== 'job:cancel' || !emit) return;
          if (cancelInvoked) throw new Error('existing-dispatch transport received duplicate job:cancel');
          cancelInvoked = true;
          let cancellation;
          try {
            cancellation = existingAdapter.cancel(dispatchHandle, envelope.payload.cancel);
          } catch (error) {
            reportError(error);
            return;
          }
          void Promise.resolve(cancellation).then((result) => {
              if (!closed && cancelWasAcknowledged(result)) {
                emit('cancel:ack', { cancellation: { scope: 'job' } });
              }
            }, reportError).catch(reportError);
        },
        async close() {
          if (closed) return;
          closed = true;
          await existingAdapter.close(dispatchHandle);
        },
        async terminate() {
          if (dispatchHandle && typeof dispatchHandle.terminate === 'function') {
            return await dispatchHandle.terminate();
          }
          if (!cancelInvoked) {
            cancelInvoked = true;
            return await existingAdapter.cancel(dispatchHandle, { reason: 'force-stop' });
          }
          return undefined;
        }
      });
    }
  });
}

module.exports = {
  cancelWasAcknowledged,
  createExistingDispatchAdapter,
  createExistingDispatchTransportAdapter,
  normalizeCancelResult,
  normalizeDispatchResult,
  resolveDispatch
};
