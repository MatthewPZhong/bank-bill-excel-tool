'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('./source-snapshot');

class ScenarioImportContextStore {
  constructor(options = {}) {
    this.statSync = options.statSync || fs.statSync;
    this.createId = options.createId || (() => crypto.randomUUID());
    this.contexts = new Map();
  }

  create({ bundle, filePath, missingChannels = [] } = {}) {
    if (!bundle || !Array.isArray(bundle.channels)) {
      throw new TypeError('场景导入 prepared context 缺少 bundle');
    }
    const resolvedPath = path.resolve(String(filePath || ''));
    const sourceSnapshot = sourceSnapshotFromStat(this.statSync(resolvedPath));
    if (!sourceSnapshot) throw new Error('场景模板源文件不可读');
    const id = String(this.createId()).trim();
    if (!id) throw new Error('场景导入 prepared context ID 为空');
    // 单窗口只保留当前一次 preview，避免取消弹窗后无限积累旧 bundle。
    this.contexts.clear();
    this.contexts.set(id, {
      id,
      bundle,
      filePath: resolvedPath,
      sourceSnapshot,
      missingChannels: Array.isArray(missingChannels) ? missingChannels.slice() : []
    });
    return id;
  }

  require(id, { confirmCreateMissingChannels = false } = {}) {
    const context = this.contexts.get(String(id || '').trim());
    if (!context) {
      const error = new Error('场景导入预览已失效，请重新选择文件');
      error.code = 'SCENARIO_IMPORT_CONTEXT_EXPIRED';
      throw error;
    }
    if (context.missingChannels.length > 0 && confirmCreateMissingChannels !== true) {
      const error = new Error('尚未确认创建缺失渠道');
      error.code = 'SCENARIO_IMPORT_CONFIRMATION_REQUIRED';
      throw error;
    }
    this.assertUnchanged(context);
    return context;
  }

  assertUnchanged(context) {
    let stat;
    try {
      stat = this.statSync(context.filePath);
    } catch (error) {
      const changed = new Error('场景模板源文件已不存在，请重新选择文件');
      changed.code = 'SCENARIO_IMPORT_SOURCE_CHANGED';
      changed.cause = error;
      throw changed;
    }
    if (!sourceSnapshotMatchesStat(context.sourceSnapshot, stat)) {
      const changed = new Error('场景模板源文件在确认期间发生变化，请重新选择文件');
      changed.code = 'SCENARIO_IMPORT_SOURCE_CHANGED';
      throw changed;
    }
    return context;
  }

  consume(id, options) {
    const context = this.require(id, options);
    this.contexts.delete(context.id);
    return context;
  }
}

function createScenarioImportContextStore(options) {
  return new ScenarioImportContextStore(options);
}

module.exports = {
  ScenarioImportContextStore,
  createScenarioImportContextStore
};
