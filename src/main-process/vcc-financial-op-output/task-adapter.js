'use strict';

const { createPassthroughTaskAdapter } = require('../task-adapters/passthrough');
const { isPublicationOnlyFileTask } = require('../toolbox-archive-recovery');

function createVccOutputTaskAdapter({ acknowledgeReceipts }) {
  if (typeof acknowledgeReceipts !== 'function') throw new TypeError('VCC receipt 确认能力缺失');
  const passthrough = createPassthroughTaskAdapter();
  return Object.freeze({
    id: 'vcc-financial-op',
    createInvocation(input) {
      const invocation = passthrough.createInvocation(input);
      const { policy, prepared } = input;
      if (policy.batchPolicy === 'no-file' || policy.scopeId !== 'vcc-financial-op'
          || !isPublicationOnlyFileTask({ taskKey: policy.taskKey, moduleId: policy.scopeId })) {
        return invocation;
      }
      return Object.freeze({
        ...invocation,
        afterTerminal: () => acknowledgeReceipts(
          prepared.toolboxPublicationTaskIds || prepared.vccOutputPublicationTaskIds || []
        )
      });
    }
  });
}

module.exports = { createVccOutputTaskAdapter };
