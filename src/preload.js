const { contextBridge, ipcRenderer } = require('electron');

// v2.0.0-beta.3 PR #32b：暴露银行对账单处理模块的字段常量到 renderer
// 注：Electron sandbox 限制 preload require 自定义模块，不能 require '../constants/*'。
// 此处 inline 常量副本，必须与 src/constants/bank-statement-fields.js 同步：
//   - 任意修改 BANK_STATEMENT_FIELDS / BANK_STATEMENT_VIRTUAL_AMOUNT_ABS，必须同时改这里和 src/constants/。
//   - v2.1.15 W1：GATEWAY_RECON_FIELDS 不再 inline（C3 改读 xlsx 表头，走 IPC scenarios:gateway-recon-headers）。
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
// v2.1.15 W1：C3「网关账单字段」枚举改为运行时读 assets/网关对账单.xlsx 表头（经 IPC
//   scenarios:gateway-recon-headers）。旧 inline GATEWAY_RECON_FIELDS 同步副本已移除，
//   appConstants.gatewayReconFields 随之下线（renderer 改异步加载缓存，见 renderer-dialogs.js）。

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
// ⚠️ GATEWAY_BILL_FIELDS（C4-gateway，写死常量）与 C3 网关账单字段分属两个模块，不要相互引用。
//    v2.1.15 W1 起 C3 字段改读 xlsx 表头（IPC），本常量仍为 C4-gateway 的写死字段，不受影响。
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
  // v2.1.15 W1：gatewayReconFields 已下线 —— C3「网关账单字段」改读 xlsx 表头（IPC scenarios:gateway-recon-headers）
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块的两 sheet 表头
  businessBillFields: BUSINESS_BILL_FIELDS,
  opponentBillFields: OPPONENT_BILL_FIELDS,
  // v2.1.0-beta.3：网关对账单 ReconID 修复模块的 3 个字段常量
  gatewayBillFields: GATEWAY_BILL_FIELDS,
  channelBillFields: CHANNEL_BILL_FIELDS,
  orderRepairFieldsGateway: ORDER_REPAIR_FIELDS_GATEWAY
});

contextBridge.exposeInMainWorld('desktopApi', {
  // v2.1.13 E2：暴露平台标识，供 renderer 判断是否应用 Win 端 Noto Sans SC 字体（仅 win32 生效）
  platform: process.platform,
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
    // v2.1.15 W4：弃用 General 风格，移除「切换页面风格」入口。setUiStyle 写链路已删；
    //   getUiStyle 保留兜底（main 端恒返回 'Clear'），renderer 启动 applyUiStyle 仍可用。
    getUiStyle: () => ipcRenderer.invoke('settings:get-ui-style'),
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
    }),
    // v2.1.11 T3（spec §4.5 / 决策 D-T3-2-src=xlsx）：C2 FundType 字段值枚举
    //   - main 进程读 assets/FundType枚举值.xlsx（preload 无法 require 自定义模块，故走 IPC）
    //   - 返回 { status:'ok', values: string[] }；文件缺失/读取失败 → values 为空数组（renderer 降级文本输入）
    getFundTypeEnum: () => ipcRenderer.invoke('scenarios:fund-type-enum'),
    // v2.1.15 W1（spec §3 / 决策 xlsx 为准、旧硬编码作废）：C3「网关账单字段」枚举
    //   - main 进程读 assets/网关对账单.xlsx 表头行（preload 无法 require 自定义模块，故走 IPC）
    //   - 返回 { status:'ok', values: string[] }；文件缺失/读取失败 → values 为 loader fallback（旧硬编码兜底）
    //   - 取代旧 appConstants.gatewayReconFields 同步常量（已移除 inline 副本）
    getGatewayReconHeaders: () => ipcRenderer.invoke('scenarios:gateway-recon-headers'),
    // v2.1.13 D-3：自带写死场景「适用银行渠道」读写（空数组 = 适用全部渠道）
    getApplicableChannels: (id) => ipcRenderer.invoke('scenarios:get-applicable-channels', id),
    setApplicableChannels: (id, channelIds) => ipcRenderer.invoke('scenarios:set-applicable-channels', id, channelIds)
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
    // v2.1.16 阶段一 A5：批量导入（按表头识别）— 多选 Excel → main 逐文件识别路由 → 返回 per-file 批量明细
    batchImport: () => ipcRenderer.invoke('bank-statement:batch-import'),
    importGatewayRecon: () => ipcRenderer.invoke('gateway-recon:import'),
    run: () => ipcRenderer.invoke('bank-statement:run'),
    export: () => ipcRenderer.invoke('bank-statement:export'),
    sessionStatus: () => ipcRenderer.invoke('bank-statement:session-status'),
    // v2.1.12 需求6：数据侧预检 — 当前导入银行对账单中满足启用 C3 场景「银行条件」的候选行数
    c3CandidateCount: () => ipcRenderer.invoke('bank-statement:c3-candidate-count')
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
    },
    // v2.1.11 T2 移除核对：选移除归档 xlsx + 解析入库（关联导入月份；D-T2-1 = 后续对账的 upperMonth）
    removed: {
      pickFiles: () => ipcRenderer.invoke('pending:removed:pick-files'),
      import: (payload) => ipcRenderer.invoke('pending:removed:import', payload)
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
  // v2.1.12 需求1：VCC业务OP计算（仅流水文件 → 按月聚合发生额出/入 → 算期末OP；资金红线 🔴）
  // 流程：pickFiles → scan(F1: 月份+条数) → computeAmounts(F2: 发生额) → save(F2: 期初OP→期末OP 落库)
  //       → listBalanceMonths / getBalance(F3: 显示余额)
  vccOpCalc: {
    pickFiles: () => ipcRenderer.invoke('vccOpCalc:import:pick-files'),
    scan: (payload) => ipcRenderer.invoke('vccOpCalc:import:scan', payload),
    computeAmounts: () => ipcRenderer.invoke('vccOpCalc:run:compute-amounts'),
    save: (payload) => ipcRenderer.invoke('vccOpCalc:run:save', payload),
    listBalanceMonths: () => ipcRenderer.invoke('vccOpCalc:balance:list-months'),
    getBalance: (payload) => ipcRenderer.invoke('vccOpCalc:balance:get', payload),
    // v2.1.12 流式改造（spec §9）：大文件读取进度订阅；返回 unsubscribe（renderer 用完 finally 退订防 listener 泄漏）
    onScanProgress: (cb) => {
      const listener = (_e, data) => { if (typeof cb === 'function') cb(data); };
      ipcRenderer.on('vccOpCalc:scan:progress', listener);
      return () => ipcRenderer.removeListener('vccOpCalc:scan:progress', listener);
    }
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
    // v2.1.10 A3 T10 / A4 T19：cancel 和 resume IPC（spec §三）
    //   - cancel：worker pool cancel API；renderer 加 cancel 按钮时调（v2.1.11+ 评估 UI）
    //   - resume：续跑 chunk_progress.status='partial' 的 run（v2.1.11+ 评估 UI）
    //   - 当前版本 renderer 不暴露入口；IPC 通道留好供集成测试 / 高级用户
    runCancel: (payload) => ipcRenderer.invoke('acquiringBillCurrency:run:cancel', payload),
    runResume: (payload) => ipcRenderer.invoke('acquiringBillCurrency:run:resume', payload),
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
  },
  // v2.1.16 阶段一 A4：链接表管理（资金对账数据处理模块「链接表管理」弹窗）
  //   list   ：读 4 个 tableKey 元数据（渲染弹窗 4 行的日期范围 / 更新日期）
  //   import ：多选 Excel → main 识别 + 落库 → 返回 per-file 批量明细（成功/失败 + 原因）
  linkedTable: {
    list: () => ipcRenderer.invoke('linked-table:list'),
    import: () => ipcRenderer.invoke('linked-table:import')
  }
});
