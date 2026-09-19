'use strict';
const path = require('node:path');
const { serializeError } = require('./serialize-error');

function createReviewExportHandler({ getService, dialog, getWindow, documentsPath, tempRoot, protectedRoots }) {
  return async (event, request) => {
    try {
      // Service initialization runs import recovery. It is intentionally excluded
      // from this read-only export entry point.
      const service = getService();
      if (!service) return { status: 'error', code: 'vcc-service-not-ready', message: 'VCC 服务尚未就绪，请稍后重试' };
      return await service.exportReviewTable(request, {
        tempRoot, protectedRoots,
        chooseTarget: ({ targetMonth }) => dialog.showSaveDialog(getWindow(event), {
          title: '导出 VCC 财务OP校验待确认表',
          defaultPath: path.join(documentsPath, `${targetMonth}_VCC财务OP校验待确认表.xlsx`),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }],
          properties: ['showOverwriteConfirmation']
        }),
        onProgress: (progress) => {
          if (event.sender && !event.sender.isDestroyed()) event.sender.send('vccFinancialOp:operation:progress', progress);
        }
      });
    } catch (error) {
      const serialized = serializeError(error);
      return { status: 'error', code: serialized.code || 'vcc-review-export-failed', message: serialized.message,
        detailLines: serialized.detailLines || [], ...(serialized.recoveryPaths ? { recoveryPaths: serialized.recoveryPaths } : {}) };
    }
  };
}
module.exports = { createReviewExportHandler };
