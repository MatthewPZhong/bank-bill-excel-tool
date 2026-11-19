'use strict';

const {
  createToolboxLargeSplitMatureBinding
} = require('../toolbox-large-split-dispatch');
const {
  createToolboxPublicationMatureBinding
} = require('../toolbox-output-publication-dispatch');
const {
  createPositionImportMatureBinding
} = require('./adapters/position-import-adapter');
const {
  POSITION_IMPORT_ADAPTER_ACTION
} = require('./position-import-adapter-policy');

// v3.2.20：Pending / 业务OP / 收单的 mature action 随模块下线移除。
const MATURE_ACTION_KEYS = Object.freeze({
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
  return Object.freeze({
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
