'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { vccFinancialOpErrorResult } = require('./vcc-financial-op-ipc');

function createResultExportHandlers({ getService, dialog, getWindow, documentsPath,
  createStagingDirectory, cleanupStagingDirectory, settlePublication }) {
  return {
    prepare: async (event, payload = {}) => {
      try {
        const target = await getService().getArchivedRunByMonth(payload.targetMonth);
        const choice = await dialog.showSaveDialog(getWindow(event), {
          title: '导出 VCC 财务OP校验结果表',
          defaultPath: path.join(documentsPath, `${target.targetMonth}_VCC财务OP校验结果表.xlsx`),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }],
          properties: ['showOverwriteConfirmation']
        });
        if (choice.canceled || !choice.filePath) return { proceed: false, result: { status: 'cancelled' } };
        return {
          proceed: true, runId: target.runId, targetMonth: target.targetMonth,
          resultRevision: target.resultRevision, archivedAt: target.archivedAt,
          subjects: Object.freeze(target.subjects.slice()), vccOutputPublicationTaskIds: [],
          filePlan: { version: 1, allocation: 'eager', inputs: [], outputs: [{
            filePath: path.resolve(choice.filePath), role: 'output', sourceOperation: 'vccFinancialOp:export:result'
          }] }
        };
      } catch (error) { return { proceed: false, result: vccFinancialOpErrorResult(error) }; }
    },
    execute: async (_event, prepared, taskContext) => {
      let directory, response;
      try {
        directory = createStagingDirectory(taskContext.batchContext);
        const result = await getService().exportRun({
          targetMonth: prepared.targetMonth, expectedRunId: prepared.runId,
          expectedSubjects: prepared.subjects, expectedResultRevision: prepared.resultRevision,
          expectedArchivedAt: prepared.archivedAt,
          outputPaths: taskContext.fileEvidence.filePlan.outputs.map((item) => item.filePath),
          publicationStagingDirectory: directory,
          targetSnapshots: taskContext.fileEvidence.targetSnapshots,
          onDurableHandoff: (publication, _exportResult, evidence) =>
            settlePublication(prepared, taskContext, publication, evidence)
        }, taskContext.batchContext);
        response = { ...result, status: 'success' };
      } catch (error) {
        if (error.publicationOutcomeUncertain === true) {
          // 由本次 Publisher 的派发/恢复事实决定，不能把旧 receipt 的 preflight 拒绝也挂起。
          const recoveryError = Object.assign(new Error('结果文件的提交状态尚未确认，已保留文件与恢复凭据，请完成恢复后重试。'), {
            code: 'VCC_RESULT_PUBLICATION_RECOVERY_REQUIRED', preserveTemporaryFiles: true,
            publicationOutcomeUncertain: true, publicationTaskId: error.publicationTaskId,
            recoveryPaths: error.recoveryPaths || [], cause: error
          });
          prepared.vccResultPublicationRecoveryError = recoveryError;
          response = vccFinancialOpErrorResult(recoveryError);
        } else response = vccFinancialOpErrorResult(error);
      }
      finally {
        // 仅清理本次空目录；非空目录可能仍有 publisher 的恢复证据。
        try {
          if (directory && (!fs.existsSync(directory) || !fs.readdirSync(directory).length)) {
            cleanupStagingDirectory(directory);
          }
        } catch (_cleanupError) {
          if (response?.status === 'success') response.warnings = [...(response.warnings || []),
            '结果文件已保存；导出临时目录清理未完成，可稍后重试。'];
        }
      }
      return response;
    }
  };
}

module.exports = { createResultExportHandlers };
