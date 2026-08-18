'use strict';

function positionPreflightFailure(error) {
  return {
    status: 'failed',
    code: String(error && error.code || 'position-reconciliation-failed'),
    message: String(error && error.message || error || '平盘对账预检失败'),
    detailLines: Array.isArray(error && error.detailLines)
      ? error.detailLines.slice()
      : []
  };
}

function checkpointEvidence(value) {
  return JSON.stringify(value || null);
}

function preparePositionRunSubmission({
  payload = {},
  confirmation = null,
  service,
  createContextId
} = {}) {
  try {
    if (payload && payload.confirmReplace === true) {
      const contextId = String(payload.contextId || '').trim();
      if (!confirmation || confirmation.contextId !== contextId) {
        return {
          nextConfirmation: confirmation,
          prepared: {
            proceed: false,
            result: positionPreflightFailure(
              Object.assign(new Error('待确认运行已变化，请重新选择运行范围'), {
                code: 'position-run-confirmation-changed'
              })
            )
          }
        };
      }
      const current = service.prepareRun(confirmation.selection);
      const currentPendingRunId = current.existing ? Number(current.existing.id) : null;
      if (currentPendingRunId !== confirmation.pendingRunId
          || checkpointEvidence(service.persistenceCheckpoint()) !== confirmation.checkpoint) {
        return {
          nextConfirmation: confirmation,
          prepared: {
            proceed: false,
            result: positionPreflightFailure(
              Object.assign(new Error('待确认运行或必要输入已变化，请重新选择运行范围'), {
                code: 'position-run-confirmation-changed'
              })
            )
          }
        };
      }
      return {
        nextConfirmation: confirmation,
        prepared: {
          proceed: true,
          runPayload: {
            ...confirmation.selection,
            replacePendingRunId: confirmation.pendingRunId
          }
        }
      };
    }

    const preflight = service.prepareRun(payload);
    if (!preflight.existing) {
      return {
        nextConfirmation: null,
        prepared: {
          proceed: true,
          runPayload: preflight.selection
        }
      };
    }
    const contextId = createContextId();
    const nextConfirmation = {
      contextId,
      selection: preflight.selection,
      pendingRunId: Number(preflight.existing.id),
      checkpoint: checkpointEvidence(service.persistenceCheckpoint())
    };
    return {
      nextConfirmation,
      prepared: {
        proceed: false,
        result: {
          status: 'needs-replace-confirmation',
          contextId,
          pendingScope: preflight.existing.scope,
          message: '存在待确认运行结果，继续运行将使旧草稿失效'
        }
      }
    };
  } catch (error) {
    return {
      nextConfirmation: confirmation,
      prepared: { proceed: false, result: positionPreflightFailure(error) }
    };
  }
}

function createPositionRunTaskContract({
  getService,
  withRunLock,
  createContextId
} = {}) {
  let confirmation = null;
  return {
    prepare(_event, payload = {}) {
      const resolution = preparePositionRunSubmission({
        payload,
        confirmation,
        service: getService(),
        createContextId
      });
      confirmation = resolution.nextConfirmation;
      return resolution.prepared;
    },
    execute(_event, prepared) {
      return withRunLock(() => getService().run(prepared.runPayload));
    }
  };
}

function createPositionSourceImportTaskContract({
  pickFiles,
  getService,
  withSourceLock
} = {}) {
  return {
    async prepare() {
      const choice = await pickFiles();
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      const service = getService();
      const preparedImport = await service.prepareSourceImportForLifecycle(choice.filePaths);
      const plan = preparedImport.plan;
      const preflightReady = plan && plan.preflightReady;
      const legacyEntries = plan && plan.engine === 'legacy' ? plan.entries : [];
      const staged = plan && plan.engine === 'streaming'
        ? [
            ...(preflightReady.acceptedOrdinaryInputFiles || []),
            ...(preflightReady.accountConfirmationDescriptor
              ? [preflightReady.accountConfirmationDescriptor]
              : [])
          ]
        : legacyEntries
          .filter((entry) => entry.parsed && entry.parsed.archivePath)
          .map((entry) => entry.parsed);
      const resultFiles = !plan && preparedImport.result
        ? (preparedImport.result.results || []).filter((item) => item.archivePath)
        : [];
      const stagedFiles = staged.length > 0 ? staged : resultFiles;
      const selectedCount = choice.filePaths.length;
      const executionInputIndexes = [];
      if (plan && plan.engine === 'streaming') {
        for (let index = 0; index < (preflightReady.acceptedOrdinaryInputFiles || []).length; index += 1) {
          executionInputIndexes.push(selectedCount + index);
        }
      } else if (plan && plan.engine === 'legacy') {
        let stagedIndex = 0;
        for (const entry of legacyEntries) {
          if (!entry.parsed || !entry.parsed.archivePath) continue;
          if (entry.status === 'prepared') executionInputIndexes.push(selectedCount + stagedIndex);
          stagedIndex += 1;
        }
      }
      const outputFiles = preflightReady && Array.isArray(preflightReady.outputFiles)
        ? preflightReady.outputFiles
        : preparedImport.result && Array.isArray(preparedImport.result.outputFiles)
          ? preparedImport.result.outputFiles
          : [];
      return {
        proceed: true,
        preparedImport,
        executionInputIndexes: Object.freeze(executionInputIndexes),
        positionArchiveEvidence: Object.freeze({
          inputs: Object.freeze([
            ...choice.filePaths.map(() => Object.freeze({})),
            ...stagedFiles.map((file) => Object.freeze({
              sourceType: file.sourceType,
              sha256: file.stagedSha256,
              sizeBytes: file.stagedSizeBytes
            }))
          ]),
          outputs: Object.freeze(outputFiles.map((file) => Object.freeze({
            sourceSnapshot: file.sourceSnapshot,
            sha256: file.expectedSha256 || file.sha256,
            sizeBytes: file.sizeBytes,
            requiredInputPaths: file.requiredInputPaths,
            metadata: file.metadata
          })))
        }),
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [
            ...choice.filePaths.map((filePath) => ({
              filePath,
              role: 'input',
              sourceOperation: 'position-reconciliation:source:prepare-import'
            })),
            ...stagedFiles.map((file) => ({
              filePath: file.archivePath,
              role: 'input',
              originalName: file.fileName,
              sourceOperation: 'position-reconciliation:source:prepare-import'
            }))
          ],
          outputs: outputFiles.map((file) => ({
            filePath: file.filePath,
            role: 'output',
            originalName: file.originalName,
            sourceOperation: 'position-reconciliation:source:prepare-import'
          }))
        },
        onAbandon: () => service.abandonPreparedSourceImport(preparedImport.plan)
      };
    },
    async execute(_event, prepared, taskContext) {
      const service = getService();
      let applyEntered = false;
      try {
        const result = prepared.preparedImport.requiresExecution
          ? await withSourceLock(() => {
              applyEntered = true;
              return service.executePreparedSourceImport(
                prepared.preparedImport.plan,
                taskContext.batchContext,
                {
                  executionInputPaths: prepared.executionInputIndexes.map(
                    (index) => taskContext.fileEvidence.filePlan.inputs[index].filePath
                  ),
                  outputs: taskContext.fileEvidence.filePlan.outputs
                }
              );
            })
          : prepared.preparedImport.result;
        return result;
      } finally {
        if (prepared.preparedImport.requiresExecution && !applyEntered) {
          await service.abandonPreparedSourceImport(prepared.preparedImport.plan);
        }
      }
    }
  };
}

function runWithPreparedResourceCleanup(prepared, run) {
  let executeStarted = false;
  const markExecuteStarted = () => { executeStarted = true; };
  return Promise.resolve(run(markExecuteStarted)).finally(async () => {
    if (!executeStarted && prepared && typeof prepared.onAbandon === 'function') {
      await prepared.onAbandon();
    }
  });
}

function executeAfterPositionAdmission({
  isPositionOperation,
  markExecuteStarted,
  execute,
  admitPosition
} = {}) {
  if (!isPositionOperation) {
    markExecuteStarted();
    return execute();
  }
  return admitPosition(() => {
    markExecuteStarted();
    return execute();
  });
}

module.exports = {
  checkpointEvidence,
  createPositionRunTaskContract,
  createPositionSourceImportTaskContract,
  executeAfterPositionAdmission,
  positionPreflightFailure,
  preparePositionRunSubmission,
  runWithPreparedResourceCleanup
};
