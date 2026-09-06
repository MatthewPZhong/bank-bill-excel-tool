'use strict';

const { ACTIONS } = require('./contracts');

function registerBizOpV327Handlers({ ipcMain, getModule, businessOperationRegistry }) {
  for (const action of Object.values(ACTIONS)) {
    if (action.taskKey.includes(':maintenance:')) continue;
    ipcMain.handle(action.taskKey, () => {
      getModule().assertBusinessEnabled();
    });
  }
  ipcMain.handle('bizOpReconV327:status', () => getModule().getStatus());
  ipcMain.handle('bizOpReconV327:recovery:retry', async () => {
    const operation = businessOperationRegistry.begin({ channel: 'bizOpReconV327:recovery:retry',
      moduleKey: '业务OP数据核对', functionKey: '重试恢复' });
    if (!operation.accepted) return operation;
    try { return await getModule().recovery.run(); }
    finally { businessOperationRegistry.end(operation.token); }
  });
}

module.exports = { registerBizOpV327Handlers };
