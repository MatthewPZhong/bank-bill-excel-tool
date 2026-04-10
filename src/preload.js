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
  accountMappings: {
    list: () => ipcRenderer.invoke('account-mapping:list'),
    save: (mappings) => ipcRenderer.invoke('account-mapping:save', mappings)
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
    importTemplate: () => ipcRenderer.invoke('template:import'),
    deleteTemplate: (templateId) => ipcRenderer.invoke('template:delete', templateId),
    getMappings: (templateId) => ipcRenderer.invoke('template:get-mappings', templateId),
    saveMappings: (payload) => ipcRenderer.invoke('template:save-mappings', payload),
    rename: (payload) => ipcRenderer.invoke('template:rename', payload),
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
    completeBigAccountSelection: (payload) => ipcRenderer.invoke('file:complete-big-account-selection', payload),
    extractBigAccountOrder: () => ipcRenderer.invoke('file:extract-big-account-order'),
    saveBalanceSeed: (payload) => ipcRenderer.invoke('file:save-balance-seed', payload),
    exportDetail: (scope) => ipcRenderer.invoke('file:export-detail', scope),
    exportBalance: (scope) => ipcRenderer.invoke('file:export-balance', scope)
  },
  newAccount: {
    generate: (payload) => ipcRenderer.invoke('new-account:generate', payload),
    exportFile: () => ipcRenderer.invoke('new-account:export')
  }
});
