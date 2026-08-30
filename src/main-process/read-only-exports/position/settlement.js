'use strict';

function composePositionTerminalSettlement(finalizePosition, afterTerminal = null) {
  if (typeof finalizePosition !== 'function') {
    throw new TypeError('Position pending terminal settlement 缺失');
  }
  if (afterTerminal !== null && typeof afterTerminal !== 'function') {
    throw new TypeError('Position additional terminal settlement 非法');
  }
  return async (terminal) => {
    await finalizePosition(terminal);
    if (afterTerminal) await afterTerminal(terminal);
  };
}

function settlePositionPublishedMetadata({ store, variant, runId, onWarning = null }) {
  if (variant !== 'run') return Object.freeze({ warnings: Object.freeze([]) });
  try {
    store.markRunExported(runId);
    return Object.freeze({ warnings: Object.freeze([]) });
  } catch (error) {
    const warning = '文件已成功发布，但导出状态标记失败；请勿重复确认，先联系维护人员核对。';
    if (typeof onWarning === 'function') onWarning(error, warning);
    return Object.freeze({ warnings: Object.freeze([warning]) });
  }
}

module.exports = {
  composePositionTerminalSettlement,
  settlePositionPublishedMetadata
};
