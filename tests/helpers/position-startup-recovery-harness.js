'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const acorn = require('acorn');
const { bankStatementSourceHeaders, resolveBankStatementStructure } = require('../../src/main-process/bank-statement-structure');
const { createPositionReconciliationService } = require('../../src/main-process/position-reconciliation/service');
const { authorizePositionImportApply } = require('../../src/main-process/position-reconciliation/operation-lifecycle');
const { findArchivedPositionReportArtifact } = require('../../src/main-process/position-reconciliation/archive-file-plan-evidence');
const { PositionReconciliationError } = require('../../src/main-process/position-reconciliation/common');
const { hashFileSha256Async } = require('../../src/main-process/position-reconciliation/input-staging');
const constants = require('../../src/main-process/position-reconciliation/constants');

const mainPath = path.resolve(__dirname, '../../src/main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const mainAst = acorn.parse(mainSource, { ecmaVersion: 'latest' });
const functionNames = [
  'recoverPositionPendingBeforeInterruptedSweep',
  'getPositionReconciliationService',
  // 异常报告取回：暂存已回收时按侧库记录到原存档批次里找报告（生产实现原样执行）。
  'resolvePositionAnomalyReportReference'
];
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
    const { database, fs, path, randomUUID, __dirname, createPositionReconciliationService,
      authorizePositionImportApply, findArchivedPositionReportArtifact, PositionReconciliationError,
      hashFileSha256Async,
      POSITION_SIDE_DB_CHECKPOINT_SETTING, POSITION_SIDE_DB_BOOTSTRAP_SETTING,
      appendActivityLogEntry, trackArchiveOperationPromise, getTemplateResourceService,
      resolvePositionSourceStructures, bankStatementSourceHeaders, resolveBankStatementStructure } = dependencies;
    let positionTaskOwner;
    let archiveCenterService;
    let positionReconciliationService = null;
    let positionPendingRecoveryPromise = Promise.resolve();
    const mainWindow = null;
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
  return build({ database, fs, path, randomUUID, __dirname: path.dirname(mainPath),
    createPositionReconciliationService,
    authorizePositionImportApply, findArchivedPositionReportArtifact, PositionReconciliationError,
    hashFileSha256Async, ...constants,
    // 恢复测试不涉及模板版本：来源为空时服务沿用固定的内置模板路径。
    getTemplateResourceService: () => ({ source: () => null }),
    // 链接原始表结构不注入解析器时，服务按内置结构导入。
    resolvePositionSourceStructures: null,
    // 银行对账单导入识别结构：模板来源为空时解析回落内置（只认内置 46 / 49 列）。
    bankStatementSourceHeaders,
    resolveBankStatementStructure,
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
