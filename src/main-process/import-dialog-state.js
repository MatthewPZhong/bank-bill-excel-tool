const fs = require('node:fs');
const path = require('node:path');

const settingsRepository = require('../backend/database/settings-repository');

function resolveExistingDirectory(dir) {
  if (!dir) return undefined;
  try {
    const resolved = path.resolve(dir);
    return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? resolved
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

function getImportDialogDefaultPath(db, scope) {
  if (!db) return undefined;
  return resolveExistingDirectory(settingsRepository.getLastImportDirectory(db, scope));
}

function rememberImportDialogDirectory(db, scope, filePaths) {
  if (!db) return;
  const first = Array.isArray(filePaths) ? filePaths[0] : filePaths;
  if (!first) return;
  settingsRepository.setLastImportDirectory(db, scope, path.dirname(first));
}

async function showImportOpenDialog({ dialog, browserWindow, db, scope, options }) {
  const defaultPath = getImportDialogDefaultPath(db, scope);
  const dialogOptions = {
    ...(options || {}),
    ...(defaultPath ? { defaultPath } : {})
  };
  const result = browserWindow
    ? await dialog.showOpenDialog(browserWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (!result.canceled && Array.isArray(result.filePaths) && result.filePaths.length > 0) {
    rememberImportDialogDirectory(db, scope, result.filePaths);
  }
  return result;
}

module.exports = {
  resolveExistingDirectory,
  getImportDialogDefaultPath,
  rememberImportDialogDirectory,
  showImportOpenDialog
};
