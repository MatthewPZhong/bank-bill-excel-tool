'use strict';

const { randomUUID } = require('node:crypto');
const { composePositionTerminalSettlement } = require('../read-only-exports/position/settlement');
const { executeAfterPositionAdmission } = require('./interactive-task-preflight');
const { positionFilePlanSettlementFiles } = require('./archive-file-plan-evidence');
const {
  positionReconciliationFailureResult,
  settlePositionArchiveResult
} = require('./operation-lifecycle');

function createPositionTaskAdapter({ owner, reportArchiveFailure, createOperationToken = randomUUID }) {
  return Object.freeze({
    id: 'position-reconciliation',
    createInvocation({ meta, policy, prepared }) {
      const operationToken = createOperationToken();
      const noFile = policy.batchPolicy === 'no-file';
      const legacy = prepared.legacyExistingBatchRecovery === true;
      const route = Object.freeze({ route: 'position-reconciliation', operationToken });
      return Object.freeze({
        identity: Object.freeze({
          taskRunId: prepared.taskRunId || operationToken,
          operationKey: prepared.operationKey || `position:${operationToken}:${meta.channel}`
        }),
        afterTerminalIntent: route,
        afterTerminal: composePositionTerminalSettlement(
          (terminal) => owner.terminalRegistration.finalize({ ...terminal, route }),
          typeof prepared.afterTerminal === 'function' ? prepared.afterTerminal : null
        ),
        execute({ taskContext, controls, executeBusiness, markExecuteStarted }) {
          const executePositionBusiness = async () => {
            if (noFile) return executeBusiness();
            if (!legacy) {
              owner.recordPositionFilePlanIntent(
                taskContext.fileEvidence.filePlan,
                prepared.positionArchiveEvidence
              );
            }
            let result;
            let operationError = null;
            try {
              result = await executeBusiness();
            } catch (error) {
              operationError = error;
            }
            owner.markPositionBusinessOutcome(
              operationError ? positionReconciliationFailureResult(operationError) : result,
              legacy ? undefined : { terminalForCurrentTask: true }
            );
            if (!legacy) {
              const settled = await controls.settleArtifacts({
                files: positionFilePlanSettlementFiles(taskContext.fileEvidence.filePlan)
              });
              if (settled && settled.durable === true) {
                owner.markPositionArchiveDurable({ batchId: taskContext.batchContext.batchId });
                await owner.cleanupPositionArchiveStaging({
                  cleanupPaths: result && Array.isArray(result.cleanupPaths) ? result.cleanupPaths : []
                });
              } else {
                owner.markPositionArchiveIncomplete({
                  warning: {
                    message: settled && settled.message
                      ? settled.message
                      : 'manifest artifact 尚未形成耐久结果'
                  }
                });
              }
              if (operationError) throw operationError;
              return result;
            }
            const settled = await controls.settleArtifacts({ result, error: operationError });
            const settledResult = await settlePositionArchiveResult({
              result,
              archiveTask: Promise.resolve(settled.archiveResult),
              runtime: settled.runtime,
              persistRecovery: owner.persistCurrentPositionArchiveIntentIfNeeded,
              markDurable: owner.markPositionArchiveDurable,
              markIncomplete: owner.markPositionArchiveIncomplete,
              cleanup: owner.cleanupPositionArchiveStaging,
              reportFailure: reportArchiveFailure
            });
            if (operationError) throw operationError;
            return settledResult;
          };
          return executeAfterPositionAdmission({
            isPositionOperation: true,
            markExecuteStarted,
            execute: executePositionBusiness,
            admitPosition: (operation) => owner.runPositionReconciliationOperation(
              meta.channel,
              operation,
              {
                operationToken,
                ...(noFile
                  ? { operationContext: taskContext.operationContext }
                  : { batchContext: taskContext.batchContext })
              }
            )
          });
        }
      });
    }
  });
}

module.exports = { createPositionTaskAdapter };
