(function initAppSettingsDialogs(global) {
  'use strict';
  function createAppSettingsDialogs({ api, modalBridge, modules: MODULES, ui }) {
    const { escapeHtml, createConfirmDialog, getDarkModeController, mountAppearanceSettings,
      applyAppUpdateActionResult, applyAppUpdateStatus, getAppUpdateStatus,
      refreshOpenAppUpdateDialog, restartAndInstallAppUpdate } = ui;
function archiveCenterBatchId(batch) {
  return String(batch?.internalId ?? batch?.batchId ?? batch?.id ?? '');
}

function archiveCenterBatchNumber(batch) {
  return String(batch?.batchNumber ?? batch?.number ?? archiveCenterBatchId(batch));
}

function archiveCenterFileRefId(file) {
  return String(file?.fileRefId ?? file?.id ?? '');
}

function archiveCenterErrorText(error, fallback) {
  if (error && typeof error === 'object' && error.message) return String(error.message);
  const text = String(error || '').trim();
  return text || fallback;
}

function readArchiveCenterPayload(result, key, fallback, {
  allowDirectObject = false,
  directObjectTest = null
} = {}) {
  if (result === null || result === undefined) {
    throw new Error('存档中心未返回有效结果');
  }
  const isObject = result && typeof result === 'object' && !Array.isArray(result);
  if (isObject && result.ok === false) {
    throw new Error(result.message || '存档中心请求失败');
  }
  if (isObject && Object.prototype.hasOwnProperty.call(result, key)) {
    const status = String(result.status || '').toLowerCase();
    if (status === 'failed' || status === 'error') {
      throw new Error(result.message || '存档中心请求失败');
    }
    return result[key];
  }
  if (Array.isArray(result)) return result;
  if (isObject) {
    const status = String(result.status || '').toLowerCase();
    const isDirectDomainObject = typeof directObjectTest === 'function'
      && directObjectTest(result) === true;
    if ((status === 'failed' || status === 'error') && !isDirectDomainObject) {
      throw new Error(result.message || '存档中心请求失败');
    }
    if (allowDirectObject || isDirectDomainObject) return result;
  }
  return fallback;
}

function verifyArchiveCenterAction(result, fallbackMessage) {
  if (!result || typeof result !== 'object') {
    throw new Error(fallbackMessage);
  }
  if (result.ok === false) {
    throw new Error(result.message || fallbackMessage);
  }
  const status = String(result.status || '').toLowerCase();
  if (status === 'failed' || status === 'error') {
    throw new Error(result.message || fallbackMessage);
  }
  return status !== 'cancelled' && status !== 'canceled';
}

function formatArchiveCenterBytes(value) {
  if (typeof value === 'string' && value.trim() && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function archiveCenterStatusKey(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['success', 'completed', 'complete', 'archived', 'ready'].includes(status)) return 'success';
  if (['incomplete', 'partial', 'retryable'].includes(status)) return 'incomplete';
  if (['failed', 'error'].includes(status)) return 'failed';
  if (['running', 'retrying', 'pending', 'staging'].includes(status)) return 'pending';
  return 'neutral';
}

function archiveCenterTaskStatusText(item) {
  const explicit = String(item?.taskStatusText || '').trim();
  if (explicit) return explicit;
  const status = String(item?.taskStatus || '').trim().toLowerCase();
  if (status === 'reserved') return '已预留';
  if (status === 'running') return '运行中';
  if (status === 'succeeded') return '已完成';
  if (status === 'failed') return '任务失败';
  if (status === 'cancelled') return '已取消';
  const legacy = item?.businessStatusText ?? item?.businessStatus;
  return String(legacy || '-');
}

function archiveCenterStatusText(item) {
  const explicit = item?.archiveStatusText ?? item?.statusText;
  if (explicit) return String(explicit);
  const status = archiveCenterStatusKey(item?.archiveStatus ?? item?.status);
  if (status === 'success') return '存档完成';
  if (status === 'incomplete') return '存档不完整';
  if (status === 'failed') return '存档失败';
  if (status === 'pending') return '处理中';
  return '状态未知';
}

function archiveCenterFileStatusText(file) {
  if (file?.statusText) return String(file.statusText);
  const status = archiveCenterStatusKey(file?.archiveStatus ?? file?.status);
  if (status === 'success') return '已存档';
  if (status === 'failed' || status === 'incomplete') return '存档失败';
  if (status === 'pending') return '处理中';
  return '状态未知';
}

function archiveCenterModuleName(batch) {
  if (batch?.moduleName) return String(batch.moduleName);
  const moduleId = String(batch?.moduleId || '');
  return Object.values(MODULES).find((module) => module.id === moduleId)?.name || moduleId || '未知模块';
}

function archiveCenterBatchTime(batch) {
  if (batch?.time) return String(batch.time);
  const value = batch?.createdAt ?? batch?.archivedAt;
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function archiveCenterDirectionText(value) {
  const direction = String(value || '').trim().toLowerCase();
  if (direction === 'input') return '输入';
  if (direction === 'output') return '输出';
  return value ? String(value) : '-';
}

function archiveCenterRoleText(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'input') return '业务输入';
  if (role === 'output') return '首次结果';
  return value ? String(value) : '-';
}

function archiveCenterRetentionText(batch) {
  const value = batch && Object.prototype.hasOwnProperty.call(batch, 'retentionUntil')
    ? batch.retentionUntil
    : batch?.retention;
  if (value === null || value === 'permanent') return '永久';
  if (!value) return batch?.locked === true ? '已锁定' : '-';
  return batch?.locked === true ? `${String(value)}（已锁定）` : String(value);
}

function createArchiveCenterPreviewApi() {
  let retentionDays = 180;
  const retentionDaysByModule = { toolbox: 30, 'vcc-financial-op': null };
  const batches = [
    {
      internalId: 901,
      batchId: '2026-08-10-127',
      batchNumber: '2026-08-10-127',
      moduleId: MODULES.bankStatementProcess.id,
      moduleName: '超长模块名称用于验证最小窗口省略与完整标题',
      taskStatus: 'failed',
      archiveStatus: 'complete',
      businessStatus: '',
      locked: true,
      createdAt: '2026-08-10T06:36:08.000Z'
    },
    {
      internalId: 902,
      batchId: '2026-08-11-001',
      batchNumber: '2026-08-11-001',
      moduleId: MODULES.vccFinancialOp.id,
      moduleName: MODULES.vccFinancialOp.name,
      taskStatus: 'cancelled',
      archiveStatus: 'complete',
      businessStatus: '',
      createdAt: '2026-08-11T06:37:09.000Z'
    },
    {
      internalId: 903,
      batchId: '2026-08-11-002',
      batchNumber: '2026-08-11-002',
      moduleId: 'toolbox',
      moduleName: '工具箱',
      taskStatus: 'running',
      archiveStatus: 'staging',
      businessStatus: '',
      createdAt: '2026-08-11T06:38:10.000Z'
    },
    {
      internalId: 904,
      batchId: 'BANK-20260720-001',
      batchNumber: 'BANK-20260720-001',
      moduleId: MODULES.bankStatementProcess.id,
      moduleName: MODULES.bankStatementProcess.name,
      taskStatus: 'succeeded',
      archiveStatus: 'incomplete',
      businessStatus: '',
      createdAt: '2026-07-20T06:39:11.000Z'
    }
  ];
  const relatedBatches = [
    { batchId: 901, batchNumber: '2026-08-10-127', localDate: '2026-08-10', globalDailySequence: 127 },
    { batchId: 902, batchNumber: '2026-08-11-001', localDate: '2026-08-11', globalDailySequence: 1 },
    { batchId: 903, batchNumber: '2026-08-11-002', localDate: '2026-08-11', globalDailySequence: 2 }
  ];
  const storagePath = 'D:\\Finance\\Archive\\超长存档目录\\2026年度\\银行账单生成小助手\\存档中心';
  return {
    async listBatches() { return { status: 'success', batches }; },
    async getBatch(batchId) {
      const batch = batches.find((item) => String(item.internalId) === String(batchId));
      return batch ? {
        status: 'success',
        batch: {
          ...batch,
          parentRunId: 'preview-parent-not-rendered',
          relatedBatches,
          retentionUntil: '2026-11-09',
          files: [
            {
              fileRefId: 951,
              fileName: '用于验证超长文件名省略的银行对账处理结果明细.xlsx',
              direction: 'output',
              role: 'output',
              sizeBytes: 12582912,
              archiveStatus: 'ready'
            },
            {
              fileRefId: 952,
              fileName: '原始输入账单.xlsx',
              direction: 'input',
              role: 'input',
              sizeBytes: 7340032,
              archiveStatus: 'ready'
            }
          ]
        }
      } : { status: 'failed', message: '未找到批次' };
    },
    async openFile() { return { status: 'success', message: '预览模式未打开文件' }; },
    async saveAs() { return { status: 'cancelled' }; },
    async setLocked() { return { status: 'success' }; },
    async prepareDeleteBatch() { return { status: 'success', ok: true, confirmationToken: 'preview-confirmation', summary: { total: 2 } }; },
    async deleteBatch() { return { status: 'success', ok: true, metadataDeleted: true, fullyDeleted: true }; },
    async listDeleteCleanupJobs() { return { status: 'success', jobs: [] }; },
    async retryDeleteCleanupJob() { return { status: 'success', ok: true, metadataDeleted: true, fullyDeleted: true }; },
    async selectRetrySources() { return { status: 'cancelled' }; },
    async retryBatch() { return { status: 'success' }; },
    async getSettings() {
      return {
        status: 'success',
        settings: {
          retentionDays,
          retentionDaysByModule: { ...retentionDaysByModule },
          retentionModules: [
            ...Object.values(MODULES).map(({ id, name }) => ({ id, name })),
            { id: 'toolbox', name: '工具箱' }
          ],
          storageRoot: storagePath,
          storageMigration: { status: 'idle', phase: '', processed: 0, total: 0 }
        }
      };
    },
    async changeStorageLocation() { return { status: 'cancelled' }; },
    async setRetentionDays(value) {
      retentionDays = value;
      return { status: 'success', settings: { retentionDays: value } };
    },
    async setModuleRetentionDays({ moduleId, retentionDays: value }) {
      if (value === 'inherit') delete retentionDaysByModule[moduleId];
      else retentionDaysByModule[moduleId] = value;
      return this.getSettings();
    },
    async getStats() {
      return {
        status: 'success',
        stats: {
          storagePath,
          fileTotalBytes: 1325400064,
          runCount: 128,
          latestBatchNumber: '2026-08-11-128',
          latestBatchId: 928,
          latestBatchStatus: 'succeeded',
          migrationStatus: { status: 'idle', phase: '', processed: 0, total: 0 }
        }
      };
    },
    onStorageMigrationProgress() { return () => {}; }
  };
}

function createAppUpdateSettingsDialog(options = {}) {
  const archiveCenterApi = options.archiveCenterApi || null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const dialog = document.createElement('section');
  dialog.className = 'modal-card app-update-settings-card';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'appUpdateSettingsTitle');

  const archiveModules = new Map(
    [
      ...Object.values(MODULES).map((module) => [module.id, module.name]),
      ['toolbox', '工具箱']
    ]
  );
  const archiveState = {
    activeTab: 'update',
    archiveSettingsOpen: false,
    loaded: false,
    loading: false,
    loadPromise: null,
    visitCounter: 0,
    currentVisitId: '',
    listRequestId: 0,
    detailRequestId: 0,
    settingsRequestId: 0,
    settingsLoading: false,
    selectedBatchId: '',
    batches: [],
    deleteCleanupJobs: [],
    cleanupRequestId: 0,
    deleteRequestId: 0,
    detail: null,
    stats: null,
    settings: { retentionDays: 60, retentionDaysByModule: {}, storageRoot: '', storageMigration: null },
    storageMigration: { status: 'idle', phase: '', processed: 0, total: 0 },
    savedRetentionValue: '60',
    selectedRetentionModuleId: '',
    retentionIntentToken: 0,
    retentionPendingIntent: null,
    retentionSaving: false,
    retentionSavePromise: null,
    destroyed: false,
    batchFilterTimer: null
  };

  const initialModuleOptions = [
    '<option value="">全部模块</option>',
    ...Array.from(archiveModules, ([id, name]) => (
      `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`
    ))
  ].join('');

  dialog.innerHTML = `
    <div class="dialog-header app-settings-header">
      <div id="appUpdateSettingsTitle" class="dialog-title">设置</div>
      <button class="icon-close" type="button" data-action="close" title="关闭" aria-label="关闭">×</button>
    </div>
    <div class="app-settings-layout">
      <nav class="app-settings-nav" aria-label="设置导航">
        <button class="app-settings-nav-item is-active" type="button" data-tab="update" aria-controls="appUpdatePane" aria-current="page">
          <span class="app-settings-nav-icon" aria-hidden="true">↻</span>
          <span>版本管理</span>
          <span class="app-settings-nav-dot" data-role="update-nav-dot" aria-label="更新已下载" hidden></span>
        </button>
        <button class="app-settings-nav-item" type="button" data-tab="archive" aria-controls="archiveCenterPane" aria-current="false">
          <span class="app-settings-nav-icon" aria-hidden="true">▤</span>
          <span>存档中心</span>
        </button>
        <button class="app-settings-nav-item" type="button" data-tab="appearance" aria-controls="appearancePane" aria-current="false">
          <span class="app-settings-nav-icon" aria-hidden="true">☾</span>
          <span>外观设置</span>
        </button>
      </nav>

      <div class="app-settings-main">
        <section id="appearancePane" class="app-settings-pane appearance-pane" data-pane="appearance" aria-label="外观设置" hidden></section>
        <section id="appUpdatePane" class="app-settings-pane app-update-pane" data-pane="update" aria-labelledby="appUpdatePaneHeading">
          <div class="app-update-pane-scroll">
            <h3 id="appUpdatePaneHeading" class="app-settings-pane-heading">版本管理</h3>
            <div class="app-update-settings-body">
              <div class="app-update-settings-row">
                <span class="app-update-settings-label">当前版本</span>
                <span class="app-update-settings-value" data-role="current-version">-</span>
              </div>
              <div class="app-update-settings-row">
                <span class="app-update-settings-label">安装类型</span>
                <span class="app-update-settings-value" data-role="distribution">-</span>
              </div>
              <div class="app-update-settings-row">
                <span class="app-update-settings-label">自动更新</span>
                <label class="app-update-toggle">
                  <input type="checkbox" data-role="auto-update-toggle" aria-label="自动更新" />
                  <span data-role="auto-update-toggle-text">已关闭</span>
                </label>
              </div>
              <div class="app-update-settings-row">
                <span class="app-update-settings-label">更新状态</span>
                <span class="app-update-settings-value" data-role="update-state">-</span>
              </div>
              <div class="app-update-settings-row">
                <span class="app-update-settings-label">最近检查</span>
                <span class="app-update-settings-value" data-role="last-checked">尚未检查</span>
              </div>
              <div class="app-update-settings-row" data-role="target-row" hidden>
                <span class="app-update-settings-label">目标版本</span>
                <span class="app-update-settings-value" data-role="target-version">-</span>
              </div>
              <progress class="app-update-progress" data-role="download-progress" max="100" value="0" aria-label="更新下载进度" hidden></progress>
            </div>
            <p class="app-update-settings-note" data-role="update-note"></p>
          </div>
        </section>

        <section id="archiveCenterPane" class="app-settings-pane archive-center-pane" data-pane="archive" aria-labelledby="archiveCenterHeading" hidden>
          <div class="archive-center-feedback" data-role="archive-feedback" role="status" aria-live="polite" hidden></div>

          <div class="archive-center-browser" data-archive-view="browser">
            <header class="archive-center-header">
              <div class="archive-center-header-copy">
                <h3 id="archiveCenterHeading" class="app-settings-pane-heading">存档中心</h3>
                <button class="archive-center-icon-button" type="button" data-action="open-archive-settings" title="存档设置" aria-label="存档设置">⚙</button>
              </div>
              <div class="archive-center-storage-summary" aria-label="存档容量">
                <span>文件总大小</span>
                <strong data-role="archive-file-total-size">-</strong>
              </div>
            </header>

            <section class="archive-center-warning" data-role="archive-delete-cleanup-jobs" aria-label="待完成删除" hidden></section>

            <div class="archive-center-filters" aria-label="存档筛选">
              <label class="archive-center-field">
                <span>日期</span>
                <input type="date" data-filter="date" value="" />
              </label>
              <label class="archive-center-field">
                <span>模块</span>
                <select data-filter="module">${initialModuleOptions}</select>
              </label>
              <label class="archive-center-field">
                <span>批次号</span>
                <input type="text" data-filter="batch-id" autocomplete="off" placeholder="输入批次号" />
              </label>
            </div>

            <div class="archive-center-workspace">
              <aside class="archive-center-batch-panel" aria-label="批次列表">
                <div class="archive-center-panel-caption">
                  <span>批次列表</span>
                  <span data-role="archive-batch-count">0 个</span>
                </div>
                <div class="archive-center-batch-list" data-role="archive-batch-list">
                  <div class="archive-center-empty">切换到存档中心后加载批次</div>
                </div>
              </aside>
              <section class="archive-center-detail" data-role="archive-batch-detail" aria-live="polite">
                <div class="archive-center-detail-empty">请选择一个存档批次</div>
              </section>
            </div>
          </div>

          <section class="archive-center-settings-view" data-archive-view="settings" aria-labelledby="archiveSettingsHeading" hidden>
            <header class="archive-center-subview-header">
              <button class="archive-center-icon-button" type="button" data-action="back-to-archive" title="返回存档列表" aria-label="返回存档列表">←</button>
              <h3 id="archiveSettingsHeading" class="app-settings-pane-heading">存档设置</h3>
            </header>

            <div class="archive-center-settings-section">
              <div class="archive-center-storage-location-heading">
                <span>存档位置</span>
                <button class="secondary-btn small" type="button" data-action="change-archive-storage">变更</button>
              </div>
              <p class="archive-center-storage-path" data-role="archive-storage-path" title="">-</p>
              <p class="archive-center-settings-note" data-role="archive-storage-migration" aria-live="polite" hidden></p>
            </div>

            <div class="archive-center-settings-section">
              <h4>输入/输出文件保留期限</h4>
              <div class="archive-center-retention-fields">
                <label class="archive-center-field archive-center-retention-module-field">
                  <span>适用模块</span>
                  <select data-role="archive-retention-module" aria-label="保留期限适用模块">
                    <option value="">默认（未单独设置的模块）</option>
                  </select>
                </label>
                <label class="archive-center-field archive-center-retention-field">
                  <span>保留期限</span>
                  <select data-role="archive-retention-days" aria-label="保留期限">
                    <option value="inherit" hidden disabled>跟随默认</option>
                    <option value="30">30 天</option>
                    <option value="60" selected>60 天</option>
                    <option value="90">90 天</option>
                    <option value="180">180 天</option>
                    <option value="365">365 天</option>
                    <option value="permanent">永久</option>
                  </select>
                </label>
              </div>
            </div>
          </section>
        </section>

        <footer class="dialog-actions right app-settings-footer">
          <div class="app-settings-footer-group" data-footer="update">
            <button class="secondary-btn small" type="button" data-action="check-update">立即检查</button>
            <button class="primary-btn small" type="button" data-action="restart-update" hidden>立即重启升级</button>
          </div>
          <button class="secondary-btn small" type="button" data-action="confirm-settings" data-role="close-update-dialog">返回</button>
        </footer>
      </div>
    </div>
  `;

  const updatePane = dialog.querySelector('[data-pane="update"]');
  const appearancePane = dialog.querySelector('[data-pane="appearance"]');
  const themeController = getDarkModeController();
  let appearanceView = null;
  let settingsHandle = null;
  const archivePane = dialog.querySelector('[data-pane="archive"]');
  const archiveBrowser = dialog.querySelector('[data-archive-view="browser"]');
  const archiveSettingsView = dialog.querySelector('[data-archive-view="settings"]');
  const updateFooter = dialog.querySelector('[data-footer="update"]');
  const archiveFeedback = dialog.querySelector('[data-role="archive-feedback"]');
  const batchList = dialog.querySelector('[data-role="archive-batch-list"]');
  const batchCount = dialog.querySelector('[data-role="archive-batch-count"]');
  const detailPanel = dialog.querySelector('[data-role="archive-batch-detail"]');
  const dateFilter = dialog.querySelector('[data-filter="date"]');
  const moduleFilter = dialog.querySelector('[data-filter="module"]');
  const batchIdFilter = dialog.querySelector('[data-filter="batch-id"]');
  const retentionSelect = dialog.querySelector('[data-role="archive-retention-days"]');
  const retentionModuleSelect = dialog.querySelector('[data-role="archive-retention-module"]');
  const changeStorageButton = dialog.querySelector('[data-action="change-archive-storage"]');
  const storageMigrationText = dialog.querySelector('[data-role="archive-storage-migration"]');
  const closeDialogButton = dialog.querySelector('[data-action="close"]');
  const returnButton = dialog.querySelector('[data-role="close-update-dialog"]');
  let unsubscribeStorageMigration = null;
  let unsubscribeEntryMaintenanceCompleted = null;
  let unsubscribeEntryMaintenanceFailed = null;

  function getArchiveCenterApi() {
    const archiveApi = archiveCenterApi || api.archiveCenter;
    if (!archiveApi) throw new Error('存档中心服务暂不可用');
    return archiveApi;
  }

  function showArchiveFeedback(message, tone = 'error') {
    const text = String(message || '').trim();
    archiveFeedback.hidden = !text;
    archiveFeedback.textContent = text;
    archiveFeedback.dataset.tone = tone;
    archiveFeedback.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  }

  function currentArchiveFilters() {
    const batchNumber = batchIdFilter.value.trim();
    return {
      localDate: dateFilter.value,
      moduleId: moduleFilter.value,
      batchNumber
    };
  }

  function renderArchiveModuleOptions() {
    const selected = moduleFilter.value;
    moduleFilter.innerHTML = [
      '<option value="">全部模块</option>',
      ...Array.from(archiveModules, ([id, name]) => (
        `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`
      ))
    ].join('');
  }

  function renderDeleteCleanupJobs() {
    const panel = dialog.querySelector('[data-role="archive-delete-cleanup-jobs"]');
    panel.hidden = archiveState.deleteCleanupJobs.length === 0;
    panel.innerHTML = archiveState.deleteCleanupJobs.map((job) => {
      const jobId = String(job.cleanupJobId ?? job.id ?? '');
      const failures = Array.isArray(job.failures) ? job.failures : [];
      const reason = job.message || job.lastErrorMessage
        || failures.map((failure) => failure.message || failure.code).filter(Boolean).join('；')
        || (job.state === 'waiting-migration' ? '等待存档位置迁移完成' : '文件清理尚未完成');
      return `<div data-delete-cleanup-job-id="${escapeHtml(jobId)}">
        <strong>待完成删除：${escapeHtml(job.batchNumber || String(job.batchId || ''))}</strong>
        <p role="status">${escapeHtml(reason)}</p>
        <button class="secondary-btn small" type="button" data-action="retry-delete-cleanup" data-cleanup-job-id="${escapeHtml(jobId)}">重试清理</button>
      </div>`;
    }).join('');
  }

  async function loadDeleteCleanupJobs() {
    const requestId = ++archiveState.cleanupRequestId;
    try {
      const result = await getArchiveCenterApi().listDeleteCleanupJobs();
      const jobs = readArchiveCenterPayload(result, 'jobs', []);
      if (!Array.isArray(jobs)) throw new Error('待完成删除格式无效');
      if (requestId !== archiveState.cleanupRequestId || archiveState.destroyed) return false;
      archiveState.deleteCleanupJobs = jobs;
      renderDeleteCleanupJobs();
      return true;
    } catch (error) {
      if (requestId !== archiveState.cleanupRequestId || archiveState.destroyed) return false;
      showArchiveFeedback(`待完成删除加载失败：${archiveCenterErrorText(error, '未知错误')}`);
      return false;
    }
  }

  async function retryDeleteCleanup(button) {
    if (button.disabled) return;
    button.disabled = true;
    showArchiveFeedback('正在重试文件清理…', 'info');
    try {
      const result = await getArchiveCenterApi().retryDeleteCleanupJob(button.dataset.cleanupJobId);
      const complete = result?.ok === true && result?.metadataDeleted === true && result?.fullyDeleted === true;
      await loadDeleteCleanupJobs();
      await loadArchiveStats();
      showArchiveFeedback(result?.message || (complete ? '存档批次已永久删除' : '清理尚未完成，请查看原因后重试'), complete ? 'success' : 'error');
    } catch (error) {
      showArchiveFeedback(`重试清理失败：${archiveCenterErrorText(error, '未知错误')}`);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  function renderArchiveBatches() {
    batchCount.textContent = `${archiveState.batches.length} 个`;
    if (archiveState.batches.length === 0) {
      batchList.innerHTML = '<div class="archive-center-empty">当前筛选条件下没有存档批次</div>';
      return;
    }
    batchList.innerHTML = archiveState.batches.map((batch) => {
      const batchId = archiveCenterBatchId(batch);
      const batchNumber = archiveCenterBatchNumber(batch);
      const status = archiveCenterStatusKey(batch.archiveStatus ?? batch.status);
      const active = batchId === archiveState.selectedBatchId;
      return `
        <button class="archive-center-batch-item${active ? ' is-active' : ''}" type="button" data-batch-id="${escapeHtml(batchId)}" aria-current="${active ? 'true' : 'false'}">
          <span class="archive-center-batch-row archive-center-batch-row-primary">
            <strong data-role="archive-batch-module" title="${escapeHtml(archiveCenterModuleName(batch))}">${escapeHtml(archiveCenterModuleName(batch))}</strong>
            <span class="archive-center-batch-number-wrap">
              <span data-role="archive-batch-number" title="${escapeHtml(batchNumber)}">${escapeHtml(batchNumber || '未命名批次')}</span>
              ${batch.businessLocked === true
                ? '<span class="archive-center-lock-mark" title="当前有效数据正在引用输入文件" aria-label="业务引用锁">🔒</span>'
                : (batch.locked === true ? '<span class="archive-center-lock-mark" title="已锁定" aria-label="已锁定">🔒</span>' : '')}
            </span>
          </span>
          <span class="archive-center-batch-row archive-center-batch-row-secondary">
            <span class="archive-center-status" data-role="archive-batch-status" data-status="${status}">${escapeHtml(archiveCenterStatusText(batch))}</span>
            <time data-role="archive-batch-time" datetime="${escapeHtml(batch.createdAt || '')}">${escapeHtml(archiveCenterBatchTime(batch))}</time>
          </span>
        </button>
      `;
    }).join('');
  }

  function renderArchiveRelatedBatches(batch) {
    const related = Array.isArray(batch.relatedBatches) ? batch.relatedBatches : [];
    if (related.length < 2) return '';
    const groups = [];
    for (const item of related) {
      const localDate = String(item.localDate || '');
      let group = groups.find((candidate) => candidate.localDate === localDate);
      if (!group) {
        group = { localDate, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    const groupHtml = groups.map((group) => group.items.map((item, index) => {
      const sequence = Number(item.globalDailySequence);
      const sequenceText = Number.isSafeInteger(sequence) && sequence > 0
        ? String(sequence).padStart(3, '0')
        : '';
      const displayText = sequenceText
        ? (index === 0 ? `${group.localDate}-${sequenceText}` : sequenceText)
        : String(item.batchNumber || '-');
      const relatedId = String(item.batchId ?? '');
      const current = relatedId === archiveState.selectedBatchId;
      const batchNumber = String(item.batchNumber || displayText);
      return `<button class="archive-center-related-batch" type="button" data-action="view-related-batch" data-related-batch-id="${escapeHtml(relatedId)}" title="查看关联批次 ${escapeHtml(batchNumber)}" aria-label="查看关联批次 ${escapeHtml(batchNumber)}" aria-current="${current ? 'true' : 'false'}">${escapeHtml(displayText)}</button>`;
    }).join('<span class="archive-center-related-separator" aria-hidden="true">/</span>'))
      .join('<span class="archive-center-related-group-separator" aria-hidden="true"> · </span>');
    return `<nav class="archive-center-related" aria-label="关联任务"><span>关联任务：</span>${groupHtml}</nav>`;
  }

  function renderArchiveDetail() {
    const batch = archiveState.detail;
    if (!batch || archiveCenterBatchId(batch) !== archiveState.selectedBatchId) {
      detailPanel.innerHTML = '<div class="archive-center-detail-empty">请选择一个存档批次</div>';
      return;
    }

    const batchId = archiveCenterBatchId(batch);
    const batchNumber = archiveCenterBatchNumber(batch);
    const files = Array.isArray(batch.files)
      ? batch.files
      : (Array.isArray(batch.fileRefs)
        ? batch.fileRefs
        : (Array.isArray(batch.artifacts) ? batch.artifacts : []));
    const readyCount = files.filter((file) => archiveCenterStatusKey(file.archiveStatus ?? file.status) === 'success').length;
    const status = archiveCenterStatusKey(batch.archiveStatus ?? batch.status);
    const canRetry = typeof batch.canRetry === 'boolean'
      ? batch.canRetry
      : Number(batch.failedArtifactCount || 0) > 0
        || status === 'failed'
        || status === 'incomplete';
    const locked = batch.locked === true;
    const businessLocked = batch.businessLocked === true
      || files.some((file) => file.businessLocked === true);
    const deletionLocked = locked || businessLocked;
    const selectRetrySource = batch.retryMode === 'select-source';
    const retryTitle = selectRetrySource ? '选择原文件并重试' : '重试失败存档';
    const deleteTitle = businessLocked
      ? '当前有效数据正在引用输入文件，不能删除批次'
      : (locked ? '请先解除锁定，再永久删除批次' : '永久删除批次');
    const baseWarning = batch.warning
      ?? batch.warningMessage
      ?? batch.errorMessage
      ?? batch.lastErrorMessage
      ?? batch.failureMessage
      ?? '';
    const warning = batch.requiresBusinessRerun === true
      ? [baseWarning, batch.rerunHint || '该批次缺少可验证的业务内容摘要，需要重新运行业务。']
        .filter(Boolean)
        .join('；')
      : baseWarning;

    const fileRows = files.length > 0
      ? files.map((file) => {
        const fileRefId = archiveCenterFileRefId(file);
        const fileStatus = archiveCenterStatusKey(file.archiveStatus ?? file.status);
        const ready = fileStatus === 'success';
        const fileName = String(file.fileName ?? file.name ?? file.originalName ?? '未命名文件');
        const direction = archiveCenterDirectionText(file.direction ?? file.kind);
        const role = archiveCenterRoleText(file.role ?? file.fileRole);
        const size = formatArchiveCenterBytes(file.sizeBytes ?? file.size ?? file.blob?.sizeBytes);
        return `
          <tr>
            <td><span class="archive-center-file-direction">${escapeHtml(direction)}</span></td>
            <td>
              <div class="archive-center-file-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
              <div class="archive-center-file-role">${escapeHtml(role)}</div>
            </td>
            <td>${escapeHtml(size)}</td>
            <td><span class="archive-center-status" data-status="${fileStatus}">${escapeHtml(archiveCenterFileStatusText(file))}</span></td>
            <td>
              <div class="archive-center-row-actions">
                ${ready && fileRefId
                  ? `<button class="archive-center-icon-button archive-center-text-button" type="button" data-action="open-archive-file" data-file-ref-id="${escapeHtml(fileRefId)}" title="打开只读副本" aria-label="打开只读副本">打开</button>
                     <button class="archive-center-icon-button" type="button" data-action="save-as-archive-file" data-file-ref-id="${escapeHtml(fileRefId)}" title="另存为" aria-label="另存为">💾</button>`
                  : '<span class="archive-center-no-action">—</span>'}
                ${file.businessLocked === true
                  ? '<button class="archive-center-icon-button" type="button" title="当前有效数据正在引用该输入文件" aria-label="业务引用锁" disabled>🔒</button>'
                  : ''}
              </div>
            </td>
          </tr>
        `;
      }).join('')
      : '<tr><td colspan="5" class="archive-center-table-empty">该批次没有文件记录</td></tr>';

    detailPanel.innerHTML = `
      <div class="archive-center-detail-heading">
        <div>
          <div class="archive-center-detail-title-line">
            <h4 title="${escapeHtml(batchNumber)}">${escapeHtml(batchNumber)}</h4>
            ${renderArchiveRelatedBatches(batch)}
          </div>
          <p>${escapeHtml(archiveCenterModuleName(batch))}</p>
        </div>
        <div class="archive-center-detail-actions">
          ${canRetry
            ? `<button class="archive-center-icon-button" type="button" data-action="retry-archive-batch" data-batch-id="${escapeHtml(batchId)}" data-batch-number="${escapeHtml(batchNumber)}" data-retry-mode="${escapeHtml(batch.retryMode || 'same-source')}" title="${retryTitle}" aria-label="${retryTitle}">↻</button>`
            : ''}
          <button class="archive-center-icon-button" type="button" data-action="toggle-archive-lock" data-batch-id="${escapeHtml(batchId)}" data-batch-number="${escapeHtml(batchNumber)}" title="${businessLocked ? '业务引用锁不能手工解除' : (locked ? '解除锁定' : '锁定批次')}" aria-label="${businessLocked ? '业务引用锁' : (locked ? '解除锁定' : '锁定批次')}"${businessLocked ? ' disabled' : ''}>${businessLocked ? '🔒' : (locked ? '🔓' : '🔒')}</button>
          <button class="archive-center-icon-button archive-center-icon-button-danger" type="button" data-action="delete-archive-batch" data-batch-id="${escapeHtml(batchId)}" data-batch-number="${escapeHtml(batchNumber)}" title="${deleteTitle}" aria-label="${deleteTitle}"${deletionLocked ? ' disabled' : ''}>×</button>
        </div>
      </div>
      <div class="archive-center-metadata">
        <div><span>业务状态</span><strong data-role="archive-task-status">${escapeHtml(archiveCenterTaskStatusText(batch))}</strong></div>
        <div><span>存档状态</span><strong class="archive-center-status" data-role="archive-detail-status" data-status="${status}">${escapeHtml(archiveCenterStatusText(batch))}</strong></div>
        <div><span>文件</span><strong>${readyCount}/${files.length} 个完成</strong></div>
        <div><span>保留至</span><strong>${escapeHtml(archiveCenterRetentionText(batch))}</strong></div>
      </div>
      <div class="archive-center-file-table-wrap">
        <table class="archive-center-file-table">
          <colgroup>
            <col style="width: 72px" />
            <col />
            <col style="width: 94px" />
            <col style="width: 98px" />
            <col style="width: 82px" />
          </colgroup>
          <thead><tr><th>类型</th><th>文件</th><th>大小</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${fileRows}</tbody>
        </table>
      </div>
      ${warning ? `<div class="archive-center-warning">${escapeHtml(warning)}</div>` : ''}
    `;
  }

  function renderArchiveStats() {
    const stats = archiveState.stats && typeof archiveState.stats === 'object'
      ? archiveState.stats
      : {};
    const fileTotalText = formatArchiveCenterBytes(stats.fileTotalBytes);
    dialog.querySelector('[data-role="archive-file-total-size"]').textContent = fileTotalText;
    const storageRoot = stats.storagePath || archiveState.settings?.storageRoot || '';
    const storagePath = dialog.querySelector('[data-role="archive-storage-path"]');
    storagePath.textContent = storageRoot || '-';
    storagePath.title = storageRoot;
    if (stats.migrationStatus && typeof stats.migrationStatus === 'object') {
      archiveState.storageMigration = { ...stats.migrationStatus };
      renderStorageMigration();
    }
  }

  function renderArchiveSettings() {
    const settings = archiveState.settings && typeof archiveState.settings === 'object'
      ? archiveState.settings
      : {};
    const defaultRetentionDays = Object.prototype.hasOwnProperty.call(settings, 'retentionDays')
      ? settings.retentionDays
      : settings.defaultRetentionDays;
    const moduleId = archiveState.selectedRetentionModuleId;
    const overrides = settings.retentionDaysByModule || {};
    const hasOverride = moduleId && Object.prototype.hasOwnProperty.call(overrides, moduleId);
    const retentionDays = hasOverride ? overrides[moduleId] : defaultRetentionDays;
    const retentionValue = moduleId && !hasOverride
      ? 'inherit'
      : retentionDays === null || retentionDays === 'permanent'
      ? 'permanent'
      : String(retentionDays ?? 60);
    const allowedRetentionValues = new Set(['30', '60', '90', '180', '365', 'permanent', 'inherit']);
    if (!archiveState.retentionSaving && !archiveState.retentionPendingIntent) {
      const modules = Array.isArray(settings.retentionModules)
        ? settings.retentionModules
        : Array.from(archiveModules, ([id, name]) => ({ id, name }));
      retentionModuleSelect.innerHTML = '<option value="">默认（未单独设置的模块）</option>'
        + modules.map(({ id, name }) => (
          `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`
        )).join('');
      retentionModuleSelect.value = moduleId;
      const inheritOption = retentionSelect.querySelector('[value="inherit"]');
      inheritOption.hidden = !moduleId;
      inheritOption.disabled = !moduleId;
      const defaultLabel = defaultRetentionDays === null || defaultRetentionDays === 'permanent'
        ? '永久'
        : `${defaultRetentionDays ?? 60} 天`;
      inheritOption.textContent = `跟随默认（${defaultLabel}）`;
      archiveState.savedRetentionValue = allowedRetentionValues.has(retentionValue)
        ? retentionValue
        : '60';
      retentionSelect.value = archiveState.savedRetentionValue;
    }
    if (settings.storageMigration && typeof settings.storageMigration === 'object') {
      archiveState.storageMigration = { ...settings.storageMigration };
    }
    renderStorageMigration();
  }

  function renderStorageMigration() {
    const migration = archiveState.storageMigration || {};
    const running = migration.status === 'running';
    const cleanupPending = migration.phase === 'cleanup-pending';
    const phases = {
      prepared: '正在准备迁移',
      copying: '正在复制存档内容',
      'materializing-layout': '正在重建存档目录',
      verifying: '正在校验迁移结果',
      switched: '已切换存档位置',
      'cleanup-pending': '新位置已启用，旧位置清理待重试',
      done: '存档位置变更完成'
    };
    changeStorageButton.disabled = running || cleanupPending;
    changeStorageButton.textContent = cleanupPending ? '待清理' : (running ? '变更中…' : '变更');
    const phaseText = phases[migration.phase] || '';
    const total = Number(migration.total) || 0;
    const processed = Number(migration.processed) || 0;
    storageMigrationText.hidden = !phaseText;
    storageMigrationText.textContent = total > 0
      ? `${phaseText}（${processed}/${total}）`
      : phaseText;
  }

  async function changeArchiveStorageLocation() {
    if (changeStorageButton.disabled) return;
    changeStorageButton.disabled = true;
    changeStorageButton.textContent = '变更中…';
    showArchiveFeedback('请选择新的存档位置…', 'info');
    try {
      const result = await getArchiveCenterApi().changeStorageLocation();
      if (result?.status === 'cancelled') {
        showArchiveFeedback('', 'info');
        return;
      }
      const cleanupPending = result?.status === 'partial'
        && result?.code === 'ARCHIVE_STORAGE_CLEANUP_PENDING';
      if (!cleanupPending && !verifyArchiveCenterAction(result, '存档位置变更失败')) return;
      showArchiveFeedback(result?.message || '存档位置已变更',
        cleanupPending ? 'error' : 'success');
      await loadArchiveSettings();
    } catch (error) {
      showArchiveFeedback(`存档位置变更失败：${archiveCenterErrorText(error, '未知错误')}`);
    } finally {
      renderStorageMigration();
    }
  }

  async function loadArchiveStats() {
    try {
      const result = await getArchiveCenterApi().getStats();
      archiveState.stats = readArchiveCenterPayload(result, 'stats', {}, { allowDirectObject: true });
      renderArchiveStats();
      return true;
    } catch (error) {
      showArchiveFeedback(`存档信息加载失败：${archiveCenterErrorText(error, '未知错误')}`);
      return false;
    }
  }

  async function loadArchiveDetail(batchId) {
    if (!batchId) {
      archiveState.detail = null;
      renderArchiveDetail();
      return false;
    }
    const requestId = ++archiveState.detailRequestId;
    detailPanel.innerHTML = '<div class="archive-center-detail-empty">正在加载批次详情…</div>';
    try {
      const result = await getArchiveCenterApi().getBatch(batchId);
      const batch = readArchiveCenterPayload(result, 'batch', null, {
        directObjectTest: (value) => Boolean(archiveCenterBatchId(value))
      });
      if (!batch || typeof batch !== 'object') throw new Error('批次详情格式无效');
      if (requestId !== archiveState.detailRequestId) return false;
      archiveState.detail = batch;
      renderArchiveDetail();
      return true;
    } catch (error) {
      if (requestId !== archiveState.detailRequestId) return false;
      archiveState.detail = null;
      detailPanel.innerHTML = `<div class="archive-center-detail-empty archive-center-detail-error">${escapeHtml(archiveCenterErrorText(error, '批次详情加载失败'))}</div>`;
      showArchiveFeedback(`批次详情加载失败：${archiveCenterErrorText(error, '未知错误')}`);
      return false;
    }
  }

  async function loadArchiveBatches({
    clearFeedback = true,
    maintenanceRefresh = false,
    maintenanceDeletedBatchIds = []
  } = {}) {
    const requestId = ++archiveState.listRequestId;
    const cleanupLoad = loadDeleteCleanupJobs();
    const filters = currentArchiveFilters();
    if (clearFeedback) showArchiveFeedback('', 'info');
    batchList.setAttribute('aria-busy', 'true');
    batchList.innerHTML = '<div class="archive-center-empty">正在加载批次…</div>';
    try {
      const result = await getArchiveCenterApi().listBatches(filters);
      const receivedBatches = readArchiveCenterPayload(result, 'batches', []);
      if (!Array.isArray(receivedBatches)) throw new Error('批次列表格式无效');
      if (requestId !== archiveState.listRequestId) return false;

      const requestedBatchNumber = String(filters.batchNumber || '').toLowerCase();
      const batches = requestedBatchNumber
        ? receivedBatches.filter((batch) => (
          archiveCenterBatchNumber(batch).toLowerCase().includes(requestedBatchNumber)
        ))
        : receivedBatches;

      archiveState.batches = batches;
      for (const batch of batches) {
        const moduleId = String(batch?.moduleId || '');
        if (moduleId && !archiveModules.has(moduleId)) {
          archiveModules.set(moduleId, archiveCenterModuleName(batch));
        }
      }
      renderArchiveModuleOptions();

      const priorSelectedBatchId = archiveState.selectedBatchId;
      const selectedStillVisible = batches.some(
        (batch) => archiveCenterBatchId(batch) === archiveState.selectedBatchId
      );
      const deletedBatchIds = new Set(
        maintenanceDeletedBatchIds.map((batchId) => String(batchId))
      );
      const selectedRemovedByMaintenance = maintenanceRefresh
        && Boolean(priorSelectedBatchId)
        && deletedBatchIds.has(String(priorSelectedBatchId));
      const preserveFilteredMaintenanceSelection = maintenanceRefresh
        && Boolean(priorSelectedBatchId)
        && !selectedRemovedByMaintenance
        && !selectedStillVisible;
      archiveState.selectedBatchId = selectedRemovedByMaintenance
        ? ''
        : (selectedStillVisible || preserveFilteredMaintenanceSelection
            ? priorSelectedBatchId
            : archiveCenterBatchId(batches[0]));
      archiveState.detail = null;
      renderArchiveBatches();
      if (archiveState.selectedBatchId) {
        await loadArchiveDetail(archiveState.selectedBatchId);
      } else {
        renderArchiveDetail();
      }
      return true;
    } catch (error) {
      if (requestId !== archiveState.listRequestId) return false;
      archiveState.batches = [];
      archiveState.detail = null;
      renderArchiveBatches();
      renderArchiveDetail();
      showArchiveFeedback(`批次列表加载失败：${archiveCenterErrorText(error, '未知错误')}`);
      return false;
    } finally {
      await cleanupLoad;
      if (requestId === archiveState.listRequestId) {
        batchList.removeAttribute('aria-busy');
      }
    }
  }

  function setArchiveSettingsLoading(loading) {
    archiveState.settingsLoading = loading === true;
    archiveSettingsView.toggleAttribute('aria-busy', archiveState.settingsLoading);
    retentionSelect.disabled = archiveState.settingsLoading;
    updateArchiveExitControls();
  }

  function archiveDialogAlive() {
    return !archiveState.destroyed && overlay.isConnected;
  }

  function updateArchiveExitControls() {
    const busy = archiveState.settingsLoading || archiveState.retentionSaving;
    returnButton.disabled = busy;
    closeDialogButton.disabled = busy;
    retentionModuleSelect.disabled = busy;
  }

  function setRetentionSaving(saving) {
    archiveState.retentionSaving = saving === true;
    if (archiveDialogAlive()) updateArchiveExitControls();
  }

  function retentionDaysApiValue(value) {
    if (value === 'inherit') return 'inherit';
    return value === 'permanent' ? null : Number(value);
  }

  async function drainRetentionIntents() {
    setRetentionSaving(true);
    try {
      const api = getArchiveCenterApi();
      while (archiveState.retentionPendingIntent && archiveDialogAlive()) {
        const intent = archiveState.retentionPendingIntent;
        archiveState.retentionPendingIntent = null;
        if (intent.value === archiveState.savedRetentionValue) {
          if (archiveDialogAlive()) showArchiveFeedback('保留期限已保存', 'success');
          continue;
        }

        let failure = null;
        try {
          const result = intent.moduleId
            ? await api.setModuleRetentionDays({
              moduleId: intent.moduleId,
              retentionDays: retentionDaysApiValue(intent.value)
            })
            : await api.setRetentionDays(retentionDaysApiValue(intent.value));
          if (!verifyArchiveCenterAction(result, '保留期限保存失败')) {
            throw new Error('保留期限保存失败');
          }
          archiveState.savedRetentionValue = intent.value;
          if (intent.moduleId) {
            const overrides = { ...archiveState.settings.retentionDaysByModule };
            if (intent.value === 'inherit') delete overrides[intent.moduleId];
            else overrides[intent.moduleId] = retentionDaysApiValue(intent.value);
            archiveState.settings = { ...archiveState.settings, retentionDaysByModule: overrides };
          } else {
            archiveState.settings = {
              ...archiveState.settings,
              retentionDays: retentionDaysApiValue(intent.value)
            };
          }
        } catch (error) {
          failure = error;
        }

        const isLatestIntent = intent.token === archiveState.retentionIntentToken
          && !archiveState.retentionPendingIntent;
        if (failure) {
          if (!isLatestIntent) continue;
          if (archiveDialogAlive()) {
            retentionSelect.value = archiveState.savedRetentionValue;
            showArchiveFeedback(
              `保留期限保存失败：${archiveCenterErrorText(failure, '未知错误')}`
            );
          }
          continue;
        }
        if (isLatestIntent && archiveDialogAlive()) {
          retentionSelect.value = archiveState.savedRetentionValue;
          showArchiveFeedback('保留期限已保存', 'success');
        }
      }
    } finally {
      archiveState.retentionSavePromise = null;
      setRetentionSaving(false);
      if (archiveDialogAlive()) renderArchiveSettings();
      if (archiveState.retentionPendingIntent && archiveDialogAlive()) {
        archiveState.retentionSavePromise = drainRetentionIntents();
      }
    }
  }

  function saveRetentionSelection() {
    if (archiveState.settingsLoading || archiveState.destroyed) return;
    const value = retentionSelect.value;
    if (!archiveState.retentionSaving && value === archiveState.savedRetentionValue) return;
    archiveState.retentionIntentToken += 1;
    archiveState.retentionPendingIntent = {
      token: archiveState.retentionIntentToken,
      moduleId: archiveState.selectedRetentionModuleId,
      value
    };
    showArchiveFeedback('正在保存保留期限…', 'info');
    if (!archiveState.retentionSavePromise) {
      archiveState.retentionSavePromise = drainRetentionIntents();
    }
  }

  async function loadArchiveSettings() {
    const requestId = ++archiveState.settingsRequestId;
    showArchiveFeedback('', 'info');
    setArchiveSettingsLoading(true);
    try {
      // 重入设置页先等当前保存队列完成，避免旧设置快照覆盖刚保存的模块期限。
      if (archiveState.retentionSavePromise) await archiveState.retentionSavePromise;
      if (requestId !== archiveState.settingsRequestId || !archiveDialogAlive()) return false;
      const api = getArchiveCenterApi();
      const [settingsResult, statsResult] = await Promise.allSettled([
        api.getSettings(),
        api.getStats()
      ]);
      if (requestId !== archiveState.settingsRequestId) return false;

      const failures = [];
      if (settingsResult.status === 'fulfilled') {
        try {
          archiveState.settings = readArchiveCenterPayload(
            settingsResult.value,
            'settings',
            { retentionDays: 60 },
            { allowDirectObject: true }
          );
        } catch (error) {
          failures.push(`保留设置：${archiveCenterErrorText(error, '加载失败')}`);
        }
      } else {
        failures.push(`保留设置：${archiveCenterErrorText(settingsResult.reason, '加载失败')}`);
      }

      if (statsResult.status === 'fulfilled') {
        try {
          archiveState.stats = readArchiveCenterPayload(
            statsResult.value,
            'stats',
            {},
            { allowDirectObject: true }
          );
        } catch (error) {
          failures.push(`存档信息：${archiveCenterErrorText(error, '加载失败')}`);
        }
      } else {
        failures.push(`存档信息：${archiveCenterErrorText(statsResult.reason, '加载失败')}`);
      }

      renderArchiveSettings();
      renderArchiveStats();
      if (failures.length > 0) {
        showArchiveFeedback(`部分存档设置加载失败：${failures.join('；')}`);
        return false;
      }
      return true;
    } finally {
      if (requestId === archiveState.settingsRequestId) {
        setArchiveSettingsLoading(false);
      }
    }
  }

  async function startArchiveEntryMaintenance(visitId) {
    if (!visitId || visitId !== archiveState.currentVisitId || archiveState.destroyed) return;
    const api = getArchiveCenterApi();
    if (typeof api.startEntryMaintenance !== 'function') return;
    try {
      const result = await api.startEntryMaintenance(visitId);
      if (result?.failed === true) {
        console.warn('archive entry maintenance did not complete:', result?.errorCode || 'unknown');
      }
    } catch (error) {
      console.warn('archive entry maintenance start failed:', error);
    }
  }

  async function ensureArchiveLoaded(visitId) {
    if (!archiveState.loaded && !archiveState.loadPromise) {
      archiveState.loading = true;
      archiveState.loadPromise = (async () => {
        const batchesLoaded = await loadArchiveBatches();
        archiveState.loaded = batchesLoaded === true;
        return batchesLoaded;
      })().finally(() => {
        archiveState.loading = false;
        archiveState.loadPromise = null;
      });
    }
    const batchesLoaded = archiveState.loaded
      ? true
      : await archiveState.loadPromise;
    if (batchesLoaded) {
      await startArchiveEntryMaintenance(visitId);
      void loadArchiveStats();
    }
  }

  function setArchiveSettingsOpen(open) {
    const nextOpen = open === true;
    if (!nextOpen) {
      archiveState.settingsRequestId += 1;
      setArchiveSettingsLoading(false);
      if (!archiveState.retentionSaving && !archiveState.retentionPendingIntent) {
        retentionSelect.value = archiveState.savedRetentionValue;
      }
    }
    archiveState.archiveSettingsOpen = nextOpen;
    archiveBrowser.hidden = archiveState.archiveSettingsOpen;
    archiveSettingsView.hidden = !archiveState.archiveSettingsOpen;
  }

  function setSettingsTab(tab) {
    const wasArchive = archiveState.activeTab === 'archive';
    archiveState.activeTab = ['archive', 'appearance'].includes(tab) ? tab : 'update';
    dialog.querySelectorAll('[data-tab]').forEach((button) => {
      const active = button.dataset.tab === archiveState.activeTab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    updatePane.hidden = archiveState.activeTab !== 'update';
    appearancePane.hidden = archiveState.activeTab !== 'appearance';
    archivePane.hidden = archiveState.activeTab !== 'archive';
    updateFooter.hidden = archiveState.activeTab !== 'update';
    if (archiveState.activeTab !== 'archive') {
      setArchiveSettingsOpen(false);
    } else {
      if (!wasArchive) {
        archiveState.visitCounter += 1;
        archiveState.currentVisitId = `archive-visit-${Date.now()}-${archiveState.visitCounter}`;
        ensureArchiveLoaded(archiveState.currentVisitId);
      }
    }
    refreshOpenAppUpdateDialog();
  }

  async function runArchiveFileAction(button, actionName) {
    const fileRefId = button.dataset.fileRefId;
    const isOpen = actionName === 'open';
    button.disabled = true;
    showArchiveFeedback('', 'info');
    try {
      const api = getArchiveCenterApi();
      const result = isOpen
        ? await api.openFile(fileRefId)
        : await api.saveAs(fileRefId);
      const completed = verifyArchiveCenterAction(
        result,
        isOpen ? '打开存档文件失败' : '另存存档文件失败'
      );
      if (completed) {
        showArchiveFeedback(
          result?.message || (isOpen ? '已打开只读副本' : '已完成另存为'),
          'success'
        );
      }
    } catch (error) {
      showArchiveFeedback(
        `${isOpen ? '打开只读副本' : '另存为'}失败：${archiveCenterErrorText(error, '未知错误')}`
      );
    } finally {
      button.disabled = false;
    }
  }

  async function toggleArchiveBatchLock(button) {
    const batchId = button.dataset.batchId;
    const batch = archiveState.detail;
    const nextLocked = !(batch?.locked === true);
    button.disabled = true;
    showArchiveFeedback('', 'info');
    try {
      const result = await getArchiveCenterApi().setLocked(batchId, nextLocked);
      if (!verifyArchiveCenterAction(result, nextLocked ? '锁定批次失败' : '解除锁定失败')) {
        return;
      }
      showArchiveFeedback(nextLocked ? '批次已锁定，不参与自动清理' : '批次已解除锁定', 'success');
      await loadArchiveBatches({ clearFeedback: false });
      await loadArchiveStats();
    } catch (error) {
      showArchiveFeedback(`${nextLocked ? '锁定批次' : '解除锁定'}失败：${archiveCenterErrorText(error, '未知错误')}`);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  async function retryArchiveBatch(button) {
    const batchId = button.dataset.batchId;
    button.disabled = true;
    const selectSource = button.dataset.retryMode === 'select-source';
    let retryAttempted = false;
    let operationFeedback = null;
    showArchiveFeedback(selectSource ? '请选择业务处理时使用的原文件…' : '正在重试失败存档…', 'info');
    try {
      let sourcePaths = null;
      if (selectSource) {
        const selected = await getArchiveCenterApi().selectRetrySources(batchId);
        if (!verifyArchiveCenterAction(selected, '选择原文件失败')) {
          showArchiveFeedback('', 'info');
          return;
        }
        sourcePaths = selected.sourcePaths;
        showArchiveFeedback('正在校验原文件并重试存档…', 'info');
      }
      retryAttempted = true;
      const result = await getArchiveCenterApi().retryBatch(batchId, sourcePaths);
      if (!verifyArchiveCenterAction(result, '重试存档失败')) {
        operationFeedback = { message: '', type: 'info' };
        return;
      }
      operationFeedback = {
        message: result?.message || '已提交存档重试',
        type: 'success'
      };
    } catch (error) {
      operationFeedback = {
        message: `重试存档失败：${archiveCenterErrorText(error, '未知错误')}`,
        type: 'error'
      };
    } finally {
      if (retryAttempted) {
        const batchesLoaded = await loadArchiveBatches({ clearFeedback: false });
        const statsLoaded = await loadArchiveStats();
        if (operationFeedback) {
          const refreshSuffix = batchesLoaded && statsLoaded
            ? ''
            : '；页面刷新失败，请重新打开存档中心查看最新状态';
          showArchiveFeedback(
            `${operationFeedback.message}${refreshSuffix}`,
            refreshSuffix ? 'error' : operationFeedback.type
          );
        }
      }
      if (button.isConnected) button.disabled = false;
    }
  }

  async function confirmArchiveBatchDelete(button) {
    if (button.disabled || archiveState.destroyed || !overlay.isConnected) return;
    const settingsReadyForDelete = () => {
      // 删除确认会替换设置弹窗，先等期限保存收口，避免中断待保存的最终选择。
      if (archiveState.settingsLoading || archiveState.retentionSaving || archiveState.retentionPendingIntent) {
        showArchiveFeedback(
          archiveState.settingsLoading
            ? '存档设置正在加载，请稍后再删除批次'
            : '保留期限正在保存，请稍后再删除批次',
          'info'
        );
        return false;
      }
      return true;
    };
    if (!settingsReadyForDelete()) return;
    const requestId = ++archiveState.deleteRequestId;
    const isCurrentRequest = () => !archiveState.destroyed && settingsHandle?.isOpen()
      && requestId === archiveState.deleteRequestId;
    const ownsDialog = (target) => isCurrentRequest() && target?.isConnected;
    const batchId = button.dataset.batchId;
    const batchNumber = button.dataset.batchNumber || batchId;
    button.disabled = true;
    let prepared;
    try {
      prepared = await getArchiveCenterApi().prepareDeleteBatch(batchId);
      if (!ownsDialog(overlay) || !settingsHandle.isTop()) return;
      if (!verifyArchiveCenterAction(prepared, '删除预检失败') || !prepared?.confirmationToken) return;
    } catch (error) {
      if (!ownsDialog(overlay)) return;
      showArchiveFeedback(`删除预检失败：${archiveCenterErrorText(error, '未知错误')}`);
      return;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
    // 预检等待期间仍可调整期限，替换弹窗前再次确认保存已收口。
    if (!settingsReadyForDelete()) return;
    let confirmOverlay = null;
    let deleteBusy = false;
    const restoreSettingsDialog = () => {
      if (isCurrentRequest()) refreshOpenAppUpdateDialog();
    };
    confirmOverlay = createConfirmDialog({
      message: `确定永久删除批次 <strong>${escapeHtml(batchNumber)}</strong> 吗？`,
      confirmText: '永久删除',
      cancelText: '取消',
      onCancel: restoreSettingsDialog,
      onConfirm: async () => {
        const confirmButton = confirmOverlay.querySelector('[data-action="confirm"]');
        if (!ownsDialog(confirmOverlay) || confirmButton.disabled) return;
        const cancelButton = confirmOverlay.querySelector('[data-action="cancel"]');
        if (deleteBusy) return;
        deleteBusy = true;
        confirmButton.disabled = true;
        confirmButton.textContent = '删除中…';
        cancelButton.disabled = true;
        try {
          const result = await getArchiveCenterApi().deleteBatch(batchId, prepared.confirmationToken);
          if (!ownsDialog(confirmOverlay)) return;
          const metadataDeleted = result?.metadataDeleted === true;
          const fullyDeleted = result?.ok === true && metadataDeleted && result?.fullyDeleted === true;
          if (!metadataDeleted) throw new Error(result?.message || '永久删除未完成，请重新预检并确认');
          // 使删除前已经发出的列表/详情读取失效，避免迟到响应恢复旧卡片。
          archiveState.listRequestId += 1;
          archiveState.detailRequestId += 1;
          archiveState.selectedBatchId = '';
          archiveState.detail = null;
          deleteBusy = false;
          modalBridge.closeModal(confirmOverlay, { status: 'submitted', value: result });
          await loadArchiveBatches({ clearFeedback: false });
          if (!ownsDialog(overlay)) return;
          await loadArchiveStats();
          if (!ownsDialog(overlay)) return;
          showArchiveFeedback(result?.message || (fullyDeleted
            ? '存档批次已永久删除'
            : '批次记录已删除，但文件清理尚未完成，请在待完成删除中重试'), fullyDeleted ? 'success' : 'error');
        } catch (error) {
          if (!ownsDialog(confirmOverlay)) return;
          let feedback = confirmOverlay.querySelector('[data-role="archive-delete-error"]');
          if (!feedback) {
            feedback = document.createElement('div');
            feedback.className = 'archive-delete-confirm-error';
            feedback.dataset.role = 'archive-delete-error';
            feedback.setAttribute('role', 'alert');
            confirmOverlay.querySelector('.alert-body')?.appendChild(feedback);
          }
          feedback.textContent = `永久删除失败：${archiveCenterErrorText(error, '未知错误')}`;
          deleteBusy = false;
          confirmButton.disabled = false;
          confirmButton.textContent = '永久删除';
          cancelButton.disabled = false;
        }
      }
    });
    modalBridge.registerModal(confirmOverlay, { canClose: () => !deleteBusy });
    modalBridge.pushModal(settingsHandle, confirmOverlay);
  }

  function canCloseSettingsDialog() {
    return !themeController?.getSnapshot().saving
      && !archiveState.settingsLoading && !archiveState.retentionSaving
      && !archiveState.retentionPendingIntent;
  }

  function closeSettingsDialog() {
    return modalBridge.closeModal(overlay);
  }

  function disposeSettingsDialog() {
    appearanceView?.destroy();
    archiveState.destroyed = true;
    archiveState.deleteRequestId += 1;
    archiveState.retentionIntentToken += 1;
    archiveState.retentionPendingIntent = null;
    clearTimeout(archiveState.batchFilterTimer);
    archiveState.listRequestId += 1;
    archiveState.detailRequestId += 1;
    archiveState.settingsRequestId += 1;
    setArchiveSettingsLoading(false);
    if (unsubscribeStorageMigration) {
      unsubscribeStorageMigration();
      unsubscribeStorageMigration = null;
    }
    for (const unsubscribe of [
      unsubscribeEntryMaintenanceCompleted,
      unsubscribeEntryMaintenanceFailed
    ]) {
      if (typeof unsubscribe === 'function') unsubscribe();
    }
    unsubscribeEntryMaintenanceCompleted = null;
    unsubscribeEntryMaintenanceFailed = null;
  }

  dialog.querySelector('[data-action="close"]').addEventListener('click', closeSettingsDialog);
  dialog.querySelector('[data-action="confirm-settings"]').addEventListener('click', closeSettingsDialog);
  dialog.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => setSettingsTab(button.dataset.tab));
  });
  dialog.querySelector('[data-role="auto-update-toggle"]').addEventListener('change', async (event) => {
    const toggle = event.currentTarget;
    toggle.disabled = true;
    try {
      const result = await api.appUpdate.setEnabled(toggle.checked);
      applyAppUpdateActionResult(result, '自动更新设置失败');
    } catch (error) {
      applyAppUpdateStatus({
        ...getAppUpdateStatus(),
        state: 'error',
        error: error && error.message ? error.message : '更新设置保存失败'
      }, { prompt: false });
    } finally {
      if (settingsHandle?.isOpen()) refreshOpenAppUpdateDialog();
    }
  });
  dialog.querySelector('[data-action="check-update"]').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api.appUpdate.checkNow();
      applyAppUpdateActionResult(result, '检查更新失败');
    } catch (error) {
      applyAppUpdateStatus({
        ...getAppUpdateStatus(),
        state: 'error',
        error: error && error.message ? error.message : '检查更新失败'
      }, { prompt: false });
    } finally {
      if (settingsHandle?.isOpen()) refreshOpenAppUpdateDialog();
    }
  });
  dialog.querySelector('[data-action="restart-update"]').addEventListener('click', async () => {
    await restartAndInstallAppUpdate({ inline: true });
  });

  dateFilter.addEventListener('change', () => {
    archiveState.selectedBatchId = '';
    loadArchiveBatches();
  });
  moduleFilter.addEventListener('change', () => {
    archiveState.selectedBatchId = '';
    loadArchiveBatches();
  });
  batchIdFilter.addEventListener('input', () => {
    clearTimeout(archiveState.batchFilterTimer);
    archiveState.batchFilterTimer = setTimeout(() => {
      archiveState.selectedBatchId = '';
      loadArchiveBatches();
    }, 250);
  });
  batchIdFilter.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    clearTimeout(archiveState.batchFilterTimer);
    archiveState.selectedBatchId = '';
    loadArchiveBatches();
  });
  retentionSelect.addEventListener('change', saveRetentionSelection);
  retentionModuleSelect.addEventListener('change', () => {
    if (archiveState.settingsLoading || archiveState.retentionSaving) {
      retentionModuleSelect.value = archiveState.selectedRetentionModuleId;
      return;
    }
    archiveState.selectedRetentionModuleId = retentionModuleSelect.value;
    renderArchiveSettings();
    showArchiveFeedback('', 'info');
  });

  function selectArchiveBatch(batchId) {
    const nextBatchId = String(batchId || '');
    if (!nextBatchId || nextBatchId === archiveState.selectedBatchId) return;
    archiveState.selectedBatchId = nextBatchId;
    archiveState.detail = null;
    renderArchiveBatches();
    loadArchiveDetail(nextBatchId);
  }

  batchList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-batch-id]');
    if (!button) return;
    selectArchiveBatch(button.dataset.batchId);
  });

  archivePane.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'open-archive-settings') {
      setArchiveSettingsOpen(true);
      loadArchiveSettings().catch((error) => {
        showArchiveFeedback(`存档设置加载失败：${archiveCenterErrorText(error, '未知错误')}`);
      });
    } else if (action === 'back-to-archive') {
      setArchiveSettingsOpen(false);
    } else if (action === 'view-related-batch') {
      selectArchiveBatch(button.dataset.relatedBatchId);
    } else if (action === 'change-archive-storage') {
      changeArchiveStorageLocation();
    } else if (action === 'open-archive-file') {
      runArchiveFileAction(button, 'open');
    } else if (action === 'save-as-archive-file') {
      runArchiveFileAction(button, 'save-as');
    } else if (action === 'toggle-archive-lock') {
      toggleArchiveBatchLock(button);
    } else if (action === 'delete-archive-batch') {
      confirmArchiveBatchDelete(button);
    } else if (action === 'retry-delete-cleanup') {
      retryDeleteCleanup(button);
    } else if (action === 'retry-archive-batch') {
      retryArchiveBatch(button);
    }
  });

  overlay.appendChild(dialog);
  modalBridge.registerModal(overlay, {
    canClose: canCloseSettingsDialog,
    onDispose: disposeSettingsDialog,
    onMount(handle, scope) {
      settingsHandle = handle;
      appearanceView = themeController ? mountAppearanceSettings(appearancePane, themeController) : null;
  const archiveApi = archiveCenterApi || api.archiveCenter;
  if (archiveApi && typeof archiveApi.onStorageMigrationProgress === 'function') {
    unsubscribeStorageMigration = archiveApi.onStorageMigrationProgress((progress) => {
      if (!archiveDialogAlive()) return;
      archiveState.storageMigration = progress && typeof progress === 'object'
        ? { ...progress }
        : { status: 'idle', phase: '', processed: 0, total: 0 };
      renderStorageMigration();
    });
  }
  if (archiveApi && typeof archiveApi.onEntryMaintenanceCompleted === 'function') {
    unsubscribeEntryMaintenanceCompleted = archiveApi.onEntryMaintenanceCompleted(async (result) => {
      if (!archiveDialogAlive()) return;
      await loadArchiveBatches({
        clearFeedback: false,
        maintenanceRefresh: true,
        maintenanceDeletedBatchIds: Array.isArray(result?.deletedBatchIds)
          ? result.deletedBatchIds
          : []
      });
      await loadArchiveStats();
    });
  }
  if (archiveApi && typeof archiveApi.onEntryMaintenanceFailed === 'function') {
    unsubscribeEntryMaintenanceFailed = archiveApi.onEntryMaintenanceFailed((result) => {
      if (!archiveDialogAlive()) return;
      console.warn('archive entry maintenance failed:', result?.errorCode || 'unknown');
    });
  }
      const focusFrame = requestAnimationFrame(() => {
        if (handle.isOpen()) refreshOpenAppUpdateDialog();
      });
      scope.onDispose(() => cancelAnimationFrame(focusFrame));
    }
  });
  return overlay;
}

    return Object.freeze({ createAppUpdateSettingsDialog, createArchiveCenterPreviewApi });
  }
  global.__appSettingsDialogs = Object.freeze({ createAppSettingsDialogs });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.__appSettingsDialogs;
})(typeof window !== 'undefined' ? window : globalThis);
