'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const acorn = require('acorn');
const { createPositionReconciliationService } = require('../../src/main-process/position-reconciliation/service');
const { dispatchPositionLargeImportSchemaMigration } = require('../../src/main-process/position-reconciliation/import-dispatch');
const { authorizePositionImportApply } = require('../../src/main-process/position-reconciliation/operation-lifecycle');
const constants = require('../../src/main-process/position-reconciliation/constants');

const mainPath = path.resolve(__dirname, '../../src/main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const mainAst = acorn.parse(mainSource, { ecmaVersion: 'latest' });
const functionNames = ['recoverPositionPendingBeforeInterruptedSweep', 'getPositionReconciliationService'];
const source = functionNames.map((name) => {
  const functions = mainAst.body.filter((node) => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.equal(functions.length, 1, `Main 必须只有一个 ${name} 实现`);
  return mainSource.slice(functions[0].start, functions[0].end);
}).join('\n');

// AST 仅定位当前生产函数；函数体原样执行，不复制恢复分支、不依赖物理行号。
// 同一词法环境保留 Main 的 service cache 与 recovery promise 读写关系。
function createPositionStartupRecoveryHarness({ database, diagnostics, tracked }) {
  const build = Function('dependencies', `
    'use strict';
    const { database, path, randomUUID, __dirname, createPositionReconciliationService,
      dispatchPositionLargeImportSchemaMigration, authorizePositionImportApply,
      POSITION_SIDE_DB_CHECKPOINT_SETTING, POSITION_SIDE_DB_BOOTSTRAP_SETTING,
      appendActivityLogEntry, trackArchiveOperationPromise } = dependencies;
    let positionTaskOwner;
    let archiveCenterService;
    let positionReconciliationService = null;
    let positionPendingRecoveryPromise = Promise.resolve();
    const mainWindow = null;
    const resolvePositionAnomalyReportReference = () => { throw new Error('本测试不导出异常报告'); };
    const initializeArchiveCenter = () => { throw new Error('测试必须先装配真实 Archive Controller'); };
    ${source}
    return {
      attach(owner, center) { positionTaskOwner = owner; archiveCenterService = center; },
      getService: getPositionReconciliationService,
      recover: recoverPositionPendingBeforeInterruptedSweep,
      currentService: () => positionReconciliationService,
      recoveryPromise: () => positionPendingRecoveryPromise,
      close() { if (positionReconciliationService) positionReconciliationService.close(); }
    };
  `);
  return build({ database, path, randomUUID, __dirname: path.dirname(mainPath),
    createPositionReconciliationService, dispatchPositionLargeImportSchemaMigration,
    authorizePositionImportApply, ...constants,
    appendActivityLogEntry: (entry) => diagnostics.push(entry),
    trackArchiveOperationPromise(promise) {
      tracked.push(promise);
      // 与生产退出跟踪相同，单独处理拒绝，仍由真实恢复入口 await 原 promise。
      promise.catch(() => {});
      return promise;
    }
  });
}

module.exports = { createPositionStartupRecoveryHarness };
