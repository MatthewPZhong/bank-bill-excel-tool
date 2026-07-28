const fs = require('node:fs');
const path = require('node:path');

const settingsRepository = require('../backend/database/settings-repository');

// 业务导入入口 scope 全集。与模块 ID 同名的部分直接从 ALL_MODULE_IDS 派生
// （new-account-generator 无文件导入入口，排除），避免出现第 4 份手工词表拷贝
// （前 3 次改名忘同步事故见 settings-repository.js ALL_MODULE_IDS 注释）。
// 新增导入入口时把 scope 加进 EXTRA_IMPORT_DIALOG_SCOPES，
// 并必须走 showImportOpenDialog——扫描测试 import-dialog-scope-scan.test.js
// 禁止 main.js handler 里出现新的裸 dialog.showOpenDialog。
const EXTRA_IMPORT_DIALOG_SCOPES = Object.freeze([
  'template',
  'template-bundle',              // 模板 JSON 包导入，与 xlsx/csv 模板目录分开记忆
  'big-account',
  'toolbox',
  'toolbox-split-export-directory',
  'linked-table',
  'pre-fund-reconciliation-export',
  'position-reconciliation-bank',
  'position-reconciliation-linked-source',
  'position-reconciliation-result',
  'bank-statement-process-bundle' // 场景包 JSON 导入，与银行对账单 xlsx 目录分开记忆
]);

const IMPORT_DIALOG_SCOPES = Object.freeze([
  ...settingsRepository.ALL_MODULE_IDS.filter((id) => id !== 'new-account-generator'),
  ...EXTRA_IMPORT_DIALOG_SCOPES
]);

// 记忆目录存在性校验的超时上限：目录可能是断连的网络盘（UNC/SMB），
// 同步 stat 会阻塞主进程数秒到数十秒；超时后放弃 defaultPath，弹窗照常打开
const STAT_TIMEOUT_MS = 300;

function statWithTimeout(target, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    fs.promises.stat(target).then(
      (stats) => { clearTimeout(timer); resolve(stats); },
      () => { clearTimeout(timer); resolve(null); }
    );
  });
}

async function resolveExistingDirectory(dir) {
  if (!dir) return undefined;
  try {
    const resolved = path.resolve(dir);
    const stats = await statWithTimeout(resolved, STAT_TIMEOUT_MS);
    return stats && stats.isDirectory() ? resolved : undefined;
  } catch (_error) {
    return undefined;
  }
}

// 目录记忆读写失败（SQLite 锁/磁盘满）只降级为"无记忆"，绝不让导入主流程 reject
async function getImportDialogDefaultPath(db, scope) {
  if (!db) return undefined;
  let candidates;
  try {
    candidates = settingsRepository.getLastImportDirectoryCandidates(db, scope);
  } catch (_error) {
    return undefined;
  }
  for (const candidate of candidates) {
    const resolved = await resolveExistingDirectory(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function rememberImportDialogDirectory(db, scope, filePaths) {
  if (!db) return;
  const first = Array.isArray(filePaths) ? filePaths[0] : filePaths;
  if (!first) return;
  try {
    settingsRepository.setLastImportDirectory(db, scope, path.dirname(first));
  } catch (_error) {
    // 记忆失败不影响已完成的文件选择结果
  }
}

async function showImportOpenDialog({ dialog, browserWindow, db, scope, options }) {
  const dialogOptions = { ...(options || {}) };
  if (!dialogOptions.defaultPath) {
    const defaultPath = await getImportDialogDefaultPath(db, scope);
    if (defaultPath) dialogOptions.defaultPath = defaultPath;
  }
  const result = browserWindow
    ? await dialog.showOpenDialog(browserWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (!result.canceled && Array.isArray(result.filePaths) && result.filePaths.length > 0) {
    const selectingDirectory = Array.isArray(dialogOptions.properties)
      && dialogOptions.properties.includes('openDirectory');
    if (selectingDirectory) {
      try {
        settingsRepository.setLastImportDirectory(db, scope, result.filePaths[0]);
      } catch (_error) {
        // 目录记忆失败不影响已完成的目录选择
      }
    } else {
      rememberImportDialogDirectory(db, scope, result.filePaths);
    }
  }
  return result;
}

module.exports = {
  IMPORT_DIALOG_SCOPES,
  EXTRA_IMPORT_DIALOG_SCOPES,
  STAT_TIMEOUT_MS,
  resolveExistingDirectory,
  getImportDialogDefaultPath,
  rememberImportDialogDirectory,
  showImportOpenDialog
};
