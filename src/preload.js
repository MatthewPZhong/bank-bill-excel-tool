const { contextBridge, ipcRenderer } = require('electron');

// v2.0.0-beta.3 PR #32b：暴露银行对账单处理模块的字段常量到 renderer
// 注：Electron sandbox 限制 preload require 自定义模块，不能 require '../constants/*'。
// 此处 inline 常量副本，必须与 src/constants/bank-statement-fields.js / gateway-recon-fields.js 同步：
//   - 任意修改 BANK_STATEMENT_FIELDS / GATEWAY_RECON_FIELDS / BANK_STATEMENT_VIRTUAL_AMOUNT_ABS，
//     必须同时改这里和 src/constants/。
const BANK_STATEMENT_FIELDS = Object.freeze([
  '账户主体', '账户BU', 'BizId', 'BillDate', 'ValueDate', 'Channel', '地区', 'MerchantId',
  'Currency', 'Credit Amount', 'Debit Amount', 'ReconciliationId', 'ChannelOrderNo',
  'CustomerRef', 'Account Reference', 'Transaction Description', 'Extra Information',
  'Payment Detail', 'Payee Name', 'Payee CardNo', 'Drawee Name', 'Drawee CardNo',
  'By Order Of/Beneficiary', 'Extra Fee', 'tradeChannel', 'FundType', 'Remark-description',
  'Datasource', 'Remark-BU', '回填方式', '关联大账号', '自动分类规则', '分类人',
  '清算网络', '最近修改时间', 'Recon Amount', 'OriginBillId', 'fxChannel', 'fxReconId',
  'buyCurrency', 'buyAmount', 'sellCurrency', 'sellAmount', '拆分信息'
]);
const BANK_STATEMENT_VIRTUAL_AMOUNT_ABS = '发生额绝对值';
const BANK_STATEMENT_FIELDS_FOR_C3 = Object.freeze([
  ...BANK_STATEMENT_FIELDS,
  BANK_STATEMENT_VIRTUAL_AMOUNT_ABS
]);
const GATEWAY_RECON_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)', 'Reference', 'Currency',
  'Amount', 'OriginBillBizId', 'ReconBillBizId', 'reconciliationId', 'tradeType',
  'clientId', 'name', 'cardNo', '真实渠道', '清算网络', '对账批次号', 'createTime',
  'finishTime', 'LOriginalId', 'remark1', 'remark2', 'bookdate', 'valuedate', 'fileId', 'AccountRef'
]);

// v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块字段常量（spec §四）
// 注：与 src/constants/recon-id-fix-fields.js 同步——任意修改两端都要改
//      （PR-B 才会创建 src/constants/recon-id-fix-fields.js，PR-A 仅 inline 在此处）
const BUSINESS_BILL_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId',
  'BizType', 'reconId', 'clientId', 'AccountId', 'createTime', 'finishTime', 'subRcptType',
  '订单创建来源', '交易订单号'
]);
const OPPONENT_BILL_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId',
  'BizType', 'reconId', 'clientId', 'AccountId', 'createTime', 'finishTime', 'subRcptType',
  '交易订单号'
]);

// v2.1.0-beta.3：网关对账单 ReconID 修复（gateway 子模式）字段常量
// 与 src/constants/gateway-bill-recon-fields.js 同步——任意修改两端都要改
// ⚠️ GATEWAY_BILL_FIELDS 与上方 GATEWAY_RECON_FIELDS 列名相同但分属两个模块（C3 / C4-gateway），不要相互引用
const GATEWAY_BILL_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)', 'Reference', 'Currency', 'Amount',
  'OriginBillBizId', 'ReconBillBizId', 'reconciliationId', 'tradeType', 'clientId', 'name',
  'cardNo', '真实渠道', '清算网络', '对账批次号', 'createTime', 'finishTime',
  'LOriginalId', 'remark1', 'remark2', 'bookdate', 'valuedate', 'fileId', 'AccountRef'
]);
const CHANNEL_BILL_FIELDS = Object.freeze([
  'channelName', 'merchantId', 'reconciliationId', 'channelOrderNo', 'name', 'cardNo',
  'currency', 'requestAmount', 'receiveAmount', 'extraFee', '清算网络', 'createTime',
  'finishTime', 'additionInfo', 'remark', 'COriginalId'
]);
const ORDER_REPAIR_FIELDS_GATEWAY = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId'
]);

contextBridge.exposeInMainWorld('appConstants', {
  bankStatementFields: BANK_STATEMENT_FIELDS,
  bankStatementFieldsForC3: BANK_STATEMENT_FIELDS_FOR_C3,
  bankStatementVirtualAmountAbs: BANK_STATEMENT_VIRTUAL_AMOUNT_ABS,
  gatewayReconFields: GATEWAY_RECON_FIELDS,
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块的两 sheet 表头
  businessBillFields: BUSINESS_BILL_FIELDS,
  opponentBillFields: OPPONENT_BILL_FIELDS,
  // v2.1.0-beta.3：网关对账单 ReconID 修复模块的 3 个字段常量
  gatewayBillFields: GATEWAY_BILL_FIELDS,
  channelBillFields: CHANNEL_BILL_FIELDS,
  orderRepairFieldsGateway: ORDER_REPAIR_FIELDS_GATEWAY
});

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
  // v2.0.0-beta.3：银行对账单处理模块 — 场景 CRUD
  scenarios: {
    list: () => ipcRenderer.invoke('scenarios:list'),
    get: (id) => ipcRenderer.invoke('scenarios:get', id),
    create: (payload) => ipcRenderer.invoke('scenarios:create', payload),
    update: (id, fields) => ipcRenderer.invoke('scenarios:update', id, fields),
    deleteOne: (id) => ipcRenderer.invoke('scenarios:delete', id),
    toggleEnabled: (id, enabled) => ipcRenderer.invoke('scenarios:toggle-enabled', id, enabled)
  },
  // v2.0.0-beta.3 PR #32a：银行对账单处理模块 — IO + 调度
  bankStatement: {
    import: () => ipcRenderer.invoke('bank-statement:import'),
    importGatewayRecon: () => ipcRenderer.invoke('gateway-recon:import'),
    run: () => ipcRenderer.invoke('bank-statement:run'),
    export: () => ipcRenderer.invoke('bank-statement:export'),
    sessionStatus: () => ipcRenderer.invoke('bank-statement:session-status')
  },
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块（PR-B 实装算法/IO；本 PR 占位）
  // payload 形态见 docs/iterations/v2.1.0-beta.1/spec.md §三
  reconIdFix: {
    import: () => ipcRenderer.invoke('recon-id-fix:import'),
    run: (payload) => ipcRenderer.invoke('recon-id-fix:run', payload),
    export: () => ipcRenderer.invoke('recon-id-fix:export'),
    sessionStatus: () => ipcRenderer.invoke('recon-id-fix:session-status')
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
