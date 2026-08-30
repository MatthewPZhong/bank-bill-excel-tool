'use strict';

const {
  createBigTableImportMatureBinding
} = require('../big-table-import-dispatch');
const {
  createToolboxLargeSplitMatureBinding
} = require('../toolbox-large-split-dispatch');
const {
  createToolboxPublicationMatureBinding
} = require('../toolbox-output-publication-dispatch');
const {
  ACQUIRING_ADAPTER_ACTIONS
} = require('./acquiring-adapter-policies');
const {
  createAcquiringMatureBindings
} = require('./adapters/acquiring-adapter');
const {
  createPositionImportMatureBinding
} = require('./adapters/position-import-adapter');
const {
  POSITION_IMPORT_ADAPTER_ACTION
} = require('./position-import-adapter-policy');

const MATURE_ACTION_KEYS = Object.freeze({
  pendingImport: 'pending:import',
  bizOpImportFlow: 'biz-op:import-flow',
  acquiringImport: ACQUIRING_ADAPTER_ACTIONS.IMPORT,
  acquiringRunNewEligible: ACQUIRING_ADAPTER_ACTIONS.RUN_NEW_ELIGIBLE,
  acquiringRunSingleOrResume: ACQUIRING_ADAPTER_ACTIONS.RUN_SINGLE_OR_RESUME,
  positionImport: POSITION_IMPORT_ADAPTER_ACTION,
  toolboxSplitLarge: 'toolbox:split-large',
  toolboxPublish: 'toolbox:publish'
});

// E02-D 只落可验证的 adapter seam；人工资金/发布红线签字前，生产入口继续
// 走现有 IPC/dispatcher，不能由代码或自动测试把 action 偷开成 production。
const MATURE_ACTION_PRODUCTION = Object.freeze(Object.fromEntries(
  Object.values(MATURE_ACTION_KEYS).map((actionKey) => [actionKey, false])
));

function createMatureActionAdapterBindings(options = {}) {
  const bigTableOptions = options.bigTable || {};
  const acquiringBindings = createAcquiringMatureBindings(options.acquiring || {});
  return Object.freeze({
    [MATURE_ACTION_KEYS.pendingImport]: createBigTableImportMatureBinding(bigTableOptions.pending),
    [MATURE_ACTION_KEYS.bizOpImportFlow]: createBigTableImportMatureBinding(bigTableOptions.bizOp),
    [MATURE_ACTION_KEYS.acquiringImport]: acquiringBindings[MATURE_ACTION_KEYS.acquiringImport],
    [MATURE_ACTION_KEYS.acquiringRunNewEligible]:
      acquiringBindings[MATURE_ACTION_KEYS.acquiringRunNewEligible],
    [MATURE_ACTION_KEYS.acquiringRunSingleOrResume]:
      acquiringBindings[MATURE_ACTION_KEYS.acquiringRunSingleOrResume],
    [MATURE_ACTION_KEYS.positionImport]: createPositionImportMatureBinding(
      options.position || {}
    ),
    [MATURE_ACTION_KEYS.toolboxSplitLarge]: createToolboxLargeSplitMatureBinding(options.toolboxSplit),
    [MATURE_ACTION_KEYS.toolboxPublish]: createToolboxPublicationMatureBinding(options.toolboxPublication)
  });
}

function isMatureActionProductionEnabled(actionKey) {
  return MATURE_ACTION_PRODUCTION[actionKey] === true;
}

module.exports = {
  MATURE_ACTION_KEYS,
  MATURE_ACTION_PRODUCTION,
  createMatureActionAdapterBindings,
  isMatureActionProductionEnabled
};
