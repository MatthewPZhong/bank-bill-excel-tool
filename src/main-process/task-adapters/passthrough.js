'use strict';

function createPassthroughTaskAdapter() {
  return Object.freeze({
    id: 'passthrough',
    createInvocation({ prepared } = {}) {
      return {
        identity: {
          taskRunId: prepared && prepared.taskRunId || undefined,
          operationKey: prepared && prepared.operationKey || undefined
        },
        afterTerminalIntent: prepared && prepared.afterTerminalIntent || null,
        afterTerminal: prepared && typeof prepared.afterTerminal === 'function'
          ? prepared.afterTerminal
          : null,
        async execute({ executeBusiness, markExecuteStarted }) {
          markExecuteStarted();
          return executeBusiness();
        }
      };
    }
  });
}

module.exports = { createPassthroughTaskAdapter };
