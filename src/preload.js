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
    reportStartupMetrics: (payload) => ipcRenderer.send('app:report-startup-metrics', payload),
    // v2.1.8 N1' (v0.7)：renderer 节流后上报用户活动（mousemove/keydown/click），main 维护 lastUserActivityTs
    //   单向通道 ipcRenderer.send，不等回包；node-side 仅更新时间戳（无业务副作用）
    reportUserActivity: () => ipcRenderer.send('app:user-activity'),
    // v2.1.9 SR-log-1 (T32g)：renderer 通用告警上报 IPC（spec §15.4）
    //   payload schema (spec §15.3)：{ ts?, level, source?, domain?, message, details?, stack? }
    //     - level: 'error' | 'warning' | 'info'
    //     - source 缺省 → main 端兜底 'renderer'
    //   单向通道 ipcRenderer.send，不等回包；main 端用 appendActivityLogEntry 双写日志
    //   typical caller：setStatus(msg, 'error')/createAlertDialog wrapper hijack（spec §15.5）
    //   失败 graceful：renderer 内 try-catch 不阻塞 UI（spec §15.10）
    reportLog: (payload) => ipcRenderer.send('app:report-log', payload)
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
    setCurrentModule: (moduleId) => ipcRenderer.invoke('settings:set-current-module', moduleId),
    // v2.1.0-beta.3 T4：对账单ReconID修复模块「账单类别」持久化（business | gateway | null）
    setReconIdFixBillCategory: (category) => ipcRenderer.invoke('settings:set-recon-id-fix-bill-category', category),
    // v2.1.4 T3：左上角模块切换按钮的启用列表
    getEnabledModules: () => ipcRenderer.invoke('settings:get-enabled-modules'),
    setEnabledModules: (moduleList) => ipcRenderer.invoke('settings:set-enabled-modules', moduleList)
  },
  // v2.0.0-beta.3：银行对账单处理模块 — 场景 CRUD
  // v2.1.9 N5 Phase 5：新增 transfer / batchDelete（单条 + 批量同接口）
  scenarios: {
    list: () => ipcRenderer.invoke('scenarios:list'),
    get: (id) => ipcRenderer.invoke('scenarios:get', id),
    create: (payload) => ipcRenderer.invoke('scenarios:create', payload),
    update: (id, fields) => ipcRenderer.invoke('scenarios:update', id, fields),
    deleteOne: (id) => ipcRenderer.invoke('scenarios:delete', id),
    toggleEnabled: (id, enabled) => ipcRenderer.invoke('scenarios:toggle-enabled', id, enabled),
    // 转移：payload = { scenarioIds: number[], targetChannelId: number }
    //   单条转移 = scenarioIds 长度 1；批量转移 = 长度 N
    transfer: (payload) => ipcRenderer.invoke('scenarios:transfer', payload),
    // 批量删除：payload = { scenarioIds: number[] }
    //   DB 层 is_builtin=1 保护；事务包裹保证原子性
    batchDelete: (scenarioIds) => ipcRenderer.invoke('scenarios:batch-delete', { scenarioIds }),
    // v2.1.9 N7 Phase 7：场景模板按渠道导入/导出（独立 scenarioBundleVersion=1，与网银账单 bundleVersion=4 互认隔离）
    //   exportBundle(channelIds)：main 端拉所选渠道全部场景 → serialize → showSaveDialog → 写文件
    //   importBundle()：main 端 showOpenDialog → parse + detect → 若有缺失渠道返 needs-confirm，否则直接 apply
    //   applyImport({ bundle, confirmCreateMissingChannels })：renderer 确认创建缺失渠道后调用 apply
    exportBundle: (channelIds) => ipcRenderer.invoke('scenarios:export-bundle', { channelIds }),
    importBundle: () => ipcRenderer.invoke('scenarios:import-bundle'),
    applyImport: (bundle, opts = {}) => ipcRenderer.invoke('scenarios:import-bundle-apply', {
      bundle,
      confirmCreateMissingChannels: opts && opts.confirmCreateMissingChannels === true
    })
  },
  // v2.1.9 N5：银行渠道 CRUD（银行对账单处理 / 场景管理依赖；spec §4）
  //   list 返回所有渠道（含「通用」内置 id=1, displayIndex 1-based）
  //   create 失败抛错（UNIQUE / 校验失败 → renderer 接 result.status='failed'）
  //   update / delete 对「通用」（is_builtin=1）会 DB 层抛错 — UI 同步做 disabled 兜底
  channels: {
    list: () => ipcRenderer.invoke('channels:list'),
    create: (payload) => ipcRenderer.invoke('channels:create', payload),
    update: (id, fields) => ipcRenderer.invoke('channels:update', id, fields),
    deleteOne: (id) => ipcRenderer.invoke('channels:delete', id)
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
    // v2.1.0-beta.3 T9：import 加 payload 传 subMode（'business' | 'gateway'）
    import: (payload) => ipcRenderer.invoke('recon-id-fix:import', payload),
    run: (payload) => ipcRenderer.invoke('recon-id-fix:run', payload),
    export: () => ipcRenderer.invoke('recon-id-fix:export'),
    sessionStatus: () => ipcRenderer.invoke('recon-id-fix:session-status'),
    // v2.1.0-beta.3 PR #39 Codex#1（P2）：清空 main 端 session + result（切换账单类别时调用，避免旧 session 回流）
    clearSession: () => ipcRenderer.invoke('recon-id-fix:clear-session')
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
  },
  // v2.1.2 T2：月度银行对账单BU回填校验
  // spec v0.4：pick-files 拆为 pickPendingFile / pickBankFile（前端串联 Clear 风 modal 提示）
  bankBuRecon: {
    listMonths: () => ipcRenderer.invoke('bankBuRecon:months:list'),
    status: (payload) => ipcRenderer.invoke('bankBuRecon:status', payload),
    pickPendingFile: (payload) => ipcRenderer.invoke('bankBuRecon:import:pick-pending-file', payload),
    pickBankFile: (payload) => ipcRenderer.invoke('bankBuRecon:import:pick-bank-file', payload),
    runImport: (payload) => ipcRenderer.invoke('bankBuRecon:import:run', payload),
    run: (payload) => ipcRenderer.invoke('bankBuRecon:run', payload),
    // v0.5: 拆 export → single + aggregate + 另存为 picker
    pickSavePath: (payload) => ipcRenderer.invoke('bankBuRecon:export:pick-save-path', payload),
    exportSingle: (payload) => ipcRenderer.invoke('bankBuRecon:export:single', payload),
    exportAggregate: (payload) => ipcRenderer.invoke('bankBuRecon:export:aggregate', payload),
    listRuns: (payload) => ipcRenderer.invoke('bankBuRecon:run:history', payload),
    // v0.5: 新增 ready/success 月份列表 IPC
    listReadyMonths: () => ipcRenderer.invoke('bankBuRecon:run:list-ready-months'),
    listSuccessMonths: () => ipcRenderer.invoke('bankBuRecon:run:list-success-months')
  },
  // v2.1.3：业务OP数据核对模块
  bizOpRecon: {
    status: () => ipcRenderer.invoke('bizOpRecon:status'),
    listBu: () => ipcRenderer.invoke('bizOpRecon:bu:list'),
    pickBizOpFile: (payload) => ipcRenderer.invoke('bizOpRecon:import:pick-biz-op-file', payload),
    pickFlowFile: (payload) => ipcRenderer.invoke('bizOpRecon:import:pick-flow-file', payload),
    runBizOpImport: (payload) => ipcRenderer.invoke('bizOpRecon:import:run-biz-op', payload),
    runFlowImport: (payload) => ipcRenderer.invoke('bizOpRecon:import:run-flow', payload),
    openErrorReportFolder: (payload) => ipcRenderer.invoke('bizOpRecon:import:open-error-report-folder', payload),
    checkSingleDay: (payload) => ipcRenderer.invoke('bizOpRecon:import:check-single-day', payload),
    listReadyDates: (payload) => ipcRenderer.invoke('bizOpRecon:run:list-ready-dates', payload),
    run: (payload) => ipcRenderer.invoke('bizOpRecon:run', payload),
    listSuccessDates: (payload) => ipcRenderer.invoke('bizOpRecon:export:list-success-dates', payload),
    pickSavePath: (payload) => ipcRenderer.invoke('bizOpRecon:export:pick-save-path', payload),
    exportDate: (payload) => ipcRenderer.invoke('bizOpRecon:export:date', payload),
    exportDateRange: (payload) => ipcRenderer.invoke('bizOpRecon:export:date-range', payload),
    runHistory: (payload) => ipcRenderer.invoke('bizOpRecon:run:history', payload)
  },
  // v2.1.6 Module B：收单单据币种校验
  // v2.1.7 F6：新增 onImportProgress / onRunProgress 订阅 API（spec §6.4）
  //   返回 unsubscribe 函数；renderer 必须在 finally 调用避免 listener 内存泄漏
  acquiringBillCurrency: {
    listMonths: () => ipcRenderer.invoke('acquiringBillCurrency:listMonths'),
    sessionStatus: (payload) => ipcRenderer.invoke('acquiringBillCurrency:sessionStatus', payload),
    importFlow: (payload) => ipcRenderer.invoke('acquiringBillCurrency:importFlow', payload),
    importBill: (payload) => ipcRenderer.invoke('acquiringBillCurrency:importBill', payload),
    run: (payload) => ipcRenderer.invoke('acquiringBillCurrency:run', payload),
    export: (payload) => ipcRenderer.invoke('acquiringBillCurrency:export', payload),
    clearMonth: (payload) => ipcRenderer.invoke('acquiringBillCurrency:clearMonth', payload),
    onImportProgress: (listener) => {
      const wrapped = (_event, ev) => listener(ev);
      ipcRenderer.on('acquiringBillCurrency:import:progress', wrapped);
      return () => ipcRenderer.removeListener('acquiringBillCurrency:import:progress', wrapped);
    },
    onRunProgress: (listener) => {
      const wrapped = (_event, ev) => listener(ev);
      ipcRenderer.on('acquiringBillCurrency:run:progress', wrapped);
      return () => ipcRenderer.removeListener('acquiringBillCurrency:run:progress', wrapped);
    },
    // v2.1.8 N1' (v0.7)：β 方案的 onCleanupQuitStart/Progress/Done 三 API 已移除
    //   原因：退出兜底改静默（spec §3.2.2 N1''-D10/D13），main 不再 webContents.send 进度
    //   若历史 renderer 仍订阅 → ipcRenderer.on 注册的 listener 不会触发任何回调（安全降级）
    // v2.1.8 N1 β：进入模块兜底 cleanup 后台进行中 toast（保留）
    onCleanupBackgroundToast: (listener) => {
      const wrapped = (_event, ev) => listener(ev);
      ipcRenderer.on('acquiringBillCurrency:cleanup-background:toast', wrapped);
      return () => ipcRenderer.removeListener('acquiringBillCurrency:cleanup-background:toast', wrapped);
    }
  }
});
