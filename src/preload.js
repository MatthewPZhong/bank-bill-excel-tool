const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  app: {
    getInfo: () => ipcRenderer.invoke('app:get-info'),
    saveUserGuide: () => ipcRenderer.invoke('app:save-user-guide'),
    reportStartupMetrics: (payload) => ipcRenderer.send('app:report-startup-metrics', payload)
  },
  errors: {
    exportLast: () => ipcRenderer.invoke('error:export-last')
  },
  background: {
    selectFile: () => ipcRenderer.invoke('background:select-file'),
    save: (payload) => ipcRenderer.invoke('background:save', payload),
    reset: () => ipcRenderer.invoke('background:reset')
  },
  settings: {
    getUiStyle: () => ipcRenderer.invoke('settings:get-ui-style'),
    setUiStyle: (style) => ipcRenderer.invoke('settings:set-ui-style', style),
    setCurrentModule: (moduleId) => ipcRenderer.invoke('settings:set-current-module', moduleId)
  },
  accountMappings: {
    list: (templateId) => ipcRenderer.invoke('account-mapping:list', templateId),
    save: (templateId, mappings) => ipcRenderer.invoke('account-mapping:save', templateId, mappings),
    checkMigrationPending: () => ipcRenderer.invoke('account-mapping:check-migration-pending'),
    getMigrationData: () => ipcRenderer.invoke('account-mapping:get-migration-data'),
    distributeMigration: (assignments) => ipcRenderer.invoke('account-mapping:distribute-migration', assignments)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximizedState: (listener) => {
      ipcRenderer.on('window:maximized-state', (_event, value) => listener(value));
    }
  },
  templates: {
    list: () => ipcRenderer.invoke('template:list'),
    listChildren: (parentTemplateId) => ipcRenderer.invoke('template:list-children', parentTemplateId),
    setParentStatus: (templateId, isParent) => ipcRenderer.invoke('template:set-parent-status', templateId, isParent),
    setChildParent: (templateId, parentTemplateId) => ipcRenderer.invoke('template:set-child-parent', templateId, parentTemplateId),
    importTemplate: () => ipcRenderer.invoke('template:import'),
    deleteTemplate: (templateId) => ipcRenderer.invoke('template:delete', templateId),
    getMappings: (templateId) => ipcRenderer.invoke('template:get-mappings', templateId),
    saveMappings: (payload) => ipcRenderer.invoke('template:save-mappings', payload),
    rename: (payload) => ipcRenderer.invoke('template:rename', payload),
    saveFilenameFixedField: (payload) => ipcRenderer.invoke('template:save-filename-fixed-field', payload),
    exportBundle: () => ipcRenderer.invoke('template:export-bundle'),
    importBundle: () => ipcRenderer.invoke('template:import-bundle'),
    getAmountSplitRules: (templateId) => ipcRenderer.invoke('template:get-amount-split-rules', templateId),
    saveAmountSplitRules: (payload) => ipcRenderer.invoke('template:save-amount-split-rules', payload),
    getBillSplitConfig: (templateId) => ipcRenderer.invoke('template:get-bill-split-config', templateId),
    saveBillSplitMappings: (payload) => ipcRenderer.invoke('template:save-bill-split-mappings', payload),
    saveBillSplitRowCount: (payload) => ipcRenderer.invoke('template:save-bill-split-row-count', payload),
    saveBillSplitRow: (payload) => ipcRenderer.invoke('template:save-bill-split-row', payload),
    previewDeleteBillSplitRow: (payload) => ipcRenderer.invoke('template:preview-delete-bill-split-row', payload),
    deleteBillSplitRow: (payload) => ipcRenderer.invoke('template:delete-bill-split-row', payload),
    saveBillSplitMergeGroup: (payload) => ipcRenderer.invoke('template:save-bill-split-merge-group', payload),
    clearBillSplitMergeGroups: (payload) => ipcRenderer.invoke('template:clear-bill-split-merge-groups', payload),
    saveBillSplitAmountRules: (payload) => ipcRenderer.invoke('template:save-bill-split-amount-rules', payload),
    saveBillSplitMeta: (payload) => ipcRenderer.invoke('template:save-bill-split-meta', payload)
  },
  bigAccount: {
    importBankInfo: (templateId) => ipcRenderer.invoke('big-account:import-bank-info', templateId),
    saveOwnAccounts: (payload) => ipcRenderer.invoke('big-account:save-own-accounts', payload),
    // v1.5.3 R2：拉含自有账号的完整大账号列表（维护大账号对话框 / G1 月度余额弹窗）
    getWithOwn: (templateId) => ipcRenderer.invoke('big-account:get-with-own', templateId),
    loadMode: (templateId) => ipcRenderer.invoke('big-account-mode:load', templateId),
    saveMode: (payload) => ipcRenderer.invoke('big-account-mode:save', payload),
    loadOrder: (templateId) => ipcRenderer.invoke('big-account-order:load', templateId),
    saveOrder: (payload) => ipcRenderer.invoke('big-account-order:save', payload)
  },
  balanceAdjustment: {
    list: (templateName) => ipcRenderer.invoke('balance-adjustment:list', templateName),
    save: (payload) => ipcRenderer.invoke('balance-adjustment:save', payload)
  },
  files: {
    importFile: (templateId) => ipcRenderer.invoke('file:import', templateId),
    cancelBigAccountSelection: () => ipcRenderer.invoke('file:cancel-big-account-selection'),
    completeBigAccountSelection: (payload) => ipcRenderer.invoke('file:complete-big-account-selection', payload),
    extractBigAccountOrder: (payload) => ipcRenderer.invoke('file:extract-big-account-order', payload),
    saveBalanceSeed: (payload) => ipcRenderer.invoke('file:save-balance-seed', payload),
    exportDetail: (scope) => ipcRenderer.invoke('file:export-detail', scope),
    exportBalance: (scope) => ipcRenderer.invoke('file:export-balance', scope)
  },
  // v1.5.3 R1 (T1.4)：月度余额账单导出（导出月度余额账单模式）
  monthlyBalance: {
    assemble: (payload) => ipcRenderer.invoke('monthly-balance:assemble', payload),
    export: () => ipcRenderer.invoke('monthly-balance:export')
  },
  newAccount: {
    generate: (payload) => ipcRenderer.invoke('new-account:generate', payload),
    exportFile: () => ipcRenderer.invoke('new-account:export')
  },
  pending: {
    getColumns: () => ipcRenderer.invoke('pending:columns'),
    getRule: () => ipcRenderer.invoke('pending:rule:get'),
    saveRule: (payload) => ipcRenderer.invoke('pending:rule:save', payload),
    listMonths: () => ipcRenderer.invoke('pending:months:list'),
    pickFiles: () => ipcRenderer.invoke('pending:import:pick-files'),
    startImport: (payload) => ipcRenderer.invoke('pending:import:start', payload),
    exportErrorReport: () => ipcRenderer.invoke('pending:error:export-report'),
    onImportProgress: (listener) => {
      ipcRenderer.on('pending:import:progress', (_event, ev) => listener(ev));
    },
    reconcile: {
      run: (payload) => ipcRenderer.invoke('pending:reconcile:run', payload)
    },
    diff: {
      listAllRuns: () => ipcRenderer.invoke('pending:diff:runs-list'),
      listRunsForMonthPair: (payload) => ipcRenderer.invoke('pending:diff:runs-for-month-pair', payload),
      getLatestRunForMonthPair: (payload) => ipcRenderer.invoke('pending:diff:latest-run-for', payload),
      exportSingle: (payload) => ipcRenderer.invoke('pending:diff:export-single', payload),
      exportAggregate: () => ipcRenderer.invoke('pending:diff:export-aggregate')
    }
  }
});
