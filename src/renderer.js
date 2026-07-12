const DEFAULT_BACKGROUND_SETTINGS = Object.freeze({
  colorHex: '#efe8da',
  imageDataUrl: '',
  filePath: '',
  sourceFileName: '',
  sourcePath: ''
});
const DEFAULT_SPECTRUM_PICK_COLOR = '#ffffff';
const BACKGROUND_FILE_HINT = '支持 PNG/JPG/JPEG/WEBP，大小不超过 5MB，建议使用横版高清图片';
const BALANCE_DISABLED_OPTION = '无';
const BALANCE_CALCULATED_OPTION = '通过发生额计算';
const MERCHANT_ID_SELF_INPUT_OPTION = '自己输入';
const SIGNED_AMOUNT_MAPPING_FIELD = '按正负号拆分的发生额';
const AMOUNT_BASED_NAME_MAPPING_FIELD = '根据发生额做映射的户名';
const AMOUNT_BASED_ACCOUNT_MAPPING_FIELD = '根据发生额做映射的账户号';
const AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD = '按字段区分发生额';
const AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION = '是';
const ADVANCED_MAPPING_FIELDS = [
  SIGNED_AMOUNT_MAPPING_FIELD,
  AMOUNT_BASED_NAME_MAPPING_FIELD,
  AMOUNT_BASED_ACCOUNT_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD
];
const CONCAT_FIELDS_MAPPING_FIELD = '需要拼接字段';
// v1.5.2 需求 3：主页面「按文件名映射模板」的虚拟模板 ID（非 DB 记录）
// helper 用于在接收 templateId 的调用点统一短路，避免将虚拟 ID 传入真实查询
const FILENAME_MAPPING_TEMPLATE_ID = '__FILENAME_MAPPING__';
function isFilenameMappingMode(templateId) {
  return templateId === FILENAME_MAPPING_TEMPLATE_ID;
}

// v1.5.3 R1 (T1.5)：主页面"模式"下拉值域（取代 v1.5.2 的"模板"下拉）
const STATEMENT_MODES = Object.freeze({
  createStatement: 'create-statement',       // 制作网银账单（保留 v1.5.2 完整流程；内部强制用 __FILENAME_MAPPING__）
  exportMonthlyBalance: 'export-monthly-balance' // 导出月度余额账单（R1 新增；只启用 导入模板/模板管理/导出余额）
});
// R1 弹窗模板下拉的虚拟值（等价于后端 ALL_BANKS_TEMPLATE_SCOPE）
const ALL_BANKS_TEMPLATE_SCOPE = '__ALL_BANKS__';
const MODULES = Object.freeze({
  statementGenerator: {
    id: 'statement-generator',
    name: '网银账单生成'
  },
  newAccountGenerator: {
    id: 'new-account-generator',
    name: '新开账户余额账单生成'
  },
  pendingReconciliation: {
    id: 'pending-reconciliation',
    // v2.1.13 B1：'月度 Pending 数据核对' → '月度Pending数据核对'（去空格；仅显示名，统计 key 不变）
    name: '月度Pending数据核对'
  },
  bankStatementProcess: {
    id: 'bank-statement-process',
    // v2.1.14 A2：显示名 '银行对账单处理' → '资金对账数据处理'（仅改 name；id 保留 'bank-statement-process'，
    //   数十处引用 + DB module schema + settings-repository ALL_MODULE_IDS + usage-stats key 不变）
    name: '资金对账数据处理'
  },
  preFundReconciliation: {
    id: 'pre-fund-reconciliation',
    name: '前置资金对账'
  },
  // v2.1.0-beta.1 PR-A：对账单ReconID修复模块（C4 / business + gateway 两个子模式）
  // v2.1.0-beta.3 T4：模块下挂 business（单据对账单）+ gateway（网关对账单）两个子模式，按主面板「账单类别」下拉切换
  //   ⚠️ module.id 保留 'recon-id-fix'（数十处引用 + DB schema CHECK 约束）；
  //      单据子模式 scenario.category 仍是 'recon-id-fix'（字面与 module.id 相同，作用域不同）；
  //      网关子模式 scenario.category = 'gateway-recon-id-fix'。
  reconIdFix: {
    id: 'recon-id-fix',
    name: '对账单修复'
  },
  // v2.1.2 T2：月度银行对账单BU回填校验
  bankBuRecon: {
    id: 'bank-bu-recon',
    name: '月度银行对账单BU回填校验'
  },
  // v2.1.3：业务OP数据核对（独立第 5 个模块）
  bizOpRecon: {
    id: 'biz-op-recon',
    name: '业务OP数据核对'
  },
  // v2.1.6 Module B：收单单据币种校验
  acquiringBillCurrency: {
    id: 'acquiring-bill-currency',
    name: '收单单据币种校验'
  },
  // v2.1.12 需求1：VCC业务OP计算（第 6 个独立模块；id 须与 settings-repository.js ALL_MODULE_IDS 一致）
  vccOpCalc: {
    id: 'vcc-op-calc',
    name: 'VCC业务OP计算'
  }
});
const RENDERER_STARTUP_MARKS = Object.freeze({
  scriptStart: 'renderer-script-start',
  initializeStart: 'renderer-initialize-start',
  getInfoStart: 'renderer-get-info-start',
  getInfoDone: 'renderer-get-info-done',
  initialUiReady: 'renderer-initial-ui-ready',
  templatesRefreshStart: 'renderer-templates-refresh-start',
  templatesRefreshDone: 'renderer-templates-refresh-done',
  eventsBindStart: 'renderer-events-bind-start',
  eventsBindDone: 'renderer-events-bind-done',
  initComplete: 'renderer-init-complete'
});
const rendererStartupProfiler = {
  startedAt: performance.now(),
  marks: new Map()
};
rendererStartupProfiler.marks.set(RENDERER_STARTUP_MARKS.scriptStart, rendererStartupProfiler.startedAt);

const state = {
  // v2.0.0-beta.2 F1 / v2.1.15 W4：UI 风格恒为 'Clear'（General 已弃用，「切换页面风格」入口已移除）
  uiStyle: 'Clear',
  templates: [],
  // v1.5.3 R1 (T1.5)：创建网银账单模式下始终为 FILENAME_MAPPING_TEMPLATE_ID；
  // 月度余额模式下 selectedTemplateId 不参与（由弹窗内部维护）
  selectedTemplateId: FILENAME_MAPPING_TEMPLATE_ID,
  // v1.5.3 R1：主页面模式（create-statement / export-monthly-balance）
  mode: STATEMENT_MODES.createStatement,
  // v1.5.3 R1：月度余额装配是否就绪（true → "导出余额"直接另存为；false → "导出余额"弹装配对话框）
  monthlyBalanceReady: false,
  // v1.5.3 R1：月度余额装配预览（summary 字段由 IPC 返回）
  monthlyBalancePreview: null,
  canExportDetail: false,
  canExportBalance: false,
  canExportNewAccount: false,
  isMaximized: false,
  hasEnum: false,
  enumFileName: '',
  accountMappingCount: 0,
  hasErrorReport: false,
  newAccountHasErrorReport: false,
  backgroundSettings: { ...DEFAULT_BACKGROUND_SETTINGS },
  backgroundDraft: { ...DEFAULT_BACKGROUND_SETTINGS },
  isBackgroundPaletteOpen: false,
  currentModule: MODULES.statementGenerator.id,
  // v2.1.4 T3：左上角模块切换按钮的启用列表（启动时由 info.enabledModules 注入）
  enabledModules: [],
  pending: {
    rule: null,
    months: [],
    latestRunResult: null,
    latestRunId: null,
    importing: false,
    importingText: null,
    currentYearMonth: null,
    running: false,
    runningText: null,
    errorReportAvailable: false,
    errorMessage: null,
    lastImportSummary: null,
    errorReportPath: null
  },
  isModuleMenuOpen: false,
  currencyOptions: [],
  manualBalancePromptReady: false,
  manualBalancePrompt: null,
  selectedNewAccountCurrencies: [],
  isNewAccountCurrencyDropdownOpen: false,
  isBackgroundSpectrumDragging: false,
  backgroundPicker: {
    hasSelection: false,
    x: 0,
    y: 0,
    colorHex: DEFAULT_SPECTRUM_PICK_COLOR
  },
  // v2.0.0-beta.3 PR #32b：银行对账单处理模块 — renderer 侧 UI 缓存
  // 数据真在 main 进程；模块切换/启动时调 desktopApi.bankStatement.sessionStatus 同步
  bankStatementSession: null,    // { fileName, rowCount, importedAt } | null
  gatewayReconSession: null,     // { fileName, rowCount, importedAt } | null
  // v3.0.0 需求3：退款 session 就绪标志（来自 session-status hasRefundOrder）。
  //   { ready: boolean } —— 仅承载「本批是否已导退款表」就绪信号，供运行点 shouldPromptRefundAtRun 判据。
  refundOrderSession: null,      // { ready: true } | null
  processingResult: null,        // { hitRowCount, scenarioHitCount, warningCount, ranAt } | null
  bankStatementExport: null,     // { mainFileName, errorReportName, platformCleanupName?, refundBackfillName? } | null（仅 renderer-side 缓存）
  // v3.0.0 需求2a：去导入明细框后，失败/跳过摘要并入状态框。
  //   { text: string, hasFailed: boolean } | null —— text 为纯文本（状态框 textContent，不可 HTML）。
  //   进入新动作（再次导入/run/export/导网关）时清空，避免上一批摘要残留。
  bankStatementImportIssues: null,
  // v3.0.11 需求3（批1 · 按钮禁用统一闸）：银行对账单 import/run/export 任一进行中为 true。
  //   叠加进《开始运行》《导出文件》按钮的 disabled 计算（updateBankStatementRunBtnDisabled /
  //   updateBankStatementExportButtonsDisabled）；三入口最外层设 true、最内层 finally 清。
  bankStatementInflight: false,
  // v3.0.14：前置资金对账 renderer 只缓存轻量状态，明细和结果保留在 main/side DB。
  preFundReconciliation: {
    session: null,
    runResult: null,
    inflight: false
  },
  // v2.1.16-beta.5 需求1（PR-4 修订）🔴 资金红线：资金对账面板 row1《开始运行》的智能路由模式。
  //   'bank'（默认/最近一次导入对账单成功）→ bankStatementRunBtn 走 handleBankStatementRun()（R1-R5 核心引擎）；
  //   'gateway'（最近一次导入不平表成功）   → bankStatementRunBtn 走 handleBankStatementGatewayReconRun()（网关场景）。
  //   仅用此显式字段判路由，绝不用 session 探测（reconIdFixSession 与 ReconID 修复模块共享，易误判串引擎）。
  bankStatementProcessRunMode: 'bank',
  // 4 弹窗共享的临时配置（"返回" 保留，"完成/取消/关闭" 清空）
  scenarioDraft: null,           // { mode, category, scenarioId, name, priority, config } | null
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块 — renderer 侧 UI 缓存（spec §七）
  // 数据真在 main 进程；模块切换时调 desktopApi.reconIdFix.sessionStatus 同步
  reconIdFixSession: null,            // { fileName, sheetCounts: { recon, business, opp } } | null
  reconIdFixResult: null,             // { fixedRowCount, warningCount } | null
  reconIdFixExport: null,             // { mainFileName } | null（仅 renderer-side 缓存）
  reconIdFixSelectedScenarioId: null, // 主面板"场景"下拉当前选中（Q4 决策）
  reconIdFixScenarios: [],            // 主面板下拉 source（每次场景管理 dialog 关闭后 reload）
  // v2.1.0-beta.3 T4：主面板"账单类别"下拉持久化值（'business' | 'gateway' | null）
  // 'business' = 单据对账单子模式（已有 C4，scenario.category='recon-id-fix'）
  // 'gateway'  = 网关对账单子模式（新增，scenario.category='gateway-recon-id-fix'）
  // 切换时级联清空：selectedScenarioId / Export / import session
  reconIdFixBillCategory: null
};
const newAccountRowStateMap = new WeakMap();

function markRendererStartup(stageName) {
  rendererStartupProfiler.marks.set(stageName, performance.now());
}

function getRendererStartupValue(stageName) {
  return rendererStartupProfiler.marks.get(stageName);
}

function buildRendererStartupMetrics() {
  const marks = Object.fromEntries(
    Array.from(rendererStartupProfiler.marks.entries()).map(([key, value]) => [key, Number((value - rendererStartupProfiler.startedAt).toFixed(3))])
  );
  const initializeStart = getRendererStartupValue(RENDERER_STARTUP_MARKS.initializeStart) ?? rendererStartupProfiler.startedAt;
  const initComplete = getRendererStartupValue(RENDERER_STARTUP_MARKS.initComplete) ?? performance.now();
  const getInfoStart = getRendererStartupValue(RENDERER_STARTUP_MARKS.getInfoStart) ?? initializeStart;
  const getInfoDone = getRendererStartupValue(RENDERER_STARTUP_MARKS.getInfoDone) ?? getInfoStart;
  const initialUiReady = getRendererStartupValue(RENDERER_STARTUP_MARKS.initialUiReady) ?? getInfoDone;
  const templatesRefreshStart = getRendererStartupValue(RENDERER_STARTUP_MARKS.templatesRefreshStart) ?? initialUiReady;
  const templatesRefreshDone = getRendererStartupValue(RENDERER_STARTUP_MARKS.templatesRefreshDone) ?? templatesRefreshStart;
  const eventsBindStart = getRendererStartupValue(RENDERER_STARTUP_MARKS.eventsBindStart) ?? templatesRefreshDone;
  const eventsBindDone = getRendererStartupValue(RENDERER_STARTUP_MARKS.eventsBindDone) ?? eventsBindStart;

  return {
    marks,
    durations: {
      totalInitMs: Number((initComplete - initializeStart).toFixed(3)),
      getInfoMs: Number((getInfoDone - getInfoStart).toFixed(3)),
      initialUiSetupMs: Number((initialUiReady - getInfoDone).toFixed(3)),
      refreshTemplatesMs: Number((templatesRefreshDone - templatesRefreshStart).toFixed(3)),
      bindEventsMs: Number((eventsBindDone - eventsBindStart).toFixed(3))
    }
  };
}

function reportRendererStartupMetrics() {
  try {
    window.desktopApi.app.reportStartupMetrics(buildRendererStartupMetrics());
  } catch (error) {
    console.error(error);
  }
}

// v2.1.8 N1' (v0.7)：用户活动 10s 节流上报（spec §3.2.2 N1''-D7）
//   - main 维护 lastUserActivityTs；idle 30min 后台触发 cleanup
//   - 节流而非防抖：保证 10s 内必上报一次，避免长按/拖动时 main 误判 idle
//   - 监听 mousemove / keydown / click / wheel / touchstart（覆盖 PC + 触控板）
const USER_ACTIVITY_REPORT_INTERVAL_MS = 10 * 1000;
let lastUserActivityReportTs = 0;
function setupUserActivityReporter() {
  if (!window.desktopApi || !window.desktopApi.app || !window.desktopApi.app.reportUserActivity) return;
  const report = () => {
    const now = Date.now();
    if (now - lastUserActivityReportTs < USER_ACTIVITY_REPORT_INTERVAL_MS) return;
    lastUserActivityReportTs = now;
    try {
      window.desktopApi.app.reportUserActivity();
    } catch (_e) { /* swallow，main idle 误判由 mutex 兜底 */ }
  };
  ['mousemove', 'keydown', 'click', 'wheel', 'touchstart'].forEach((evt) => {
    window.addEventListener(evt, report, { passive: true });
  });
}

const elements = {
  appShell: document.getElementById('appShell'),
  importFileBtn: document.getElementById('importFileBtn'),
  exportDetailBtn: document.getElementById('exportDetailBtn'),
  exportBalanceBtn: document.getElementById('exportBalanceBtn'),
  newAccountGenerateBtn: document.getElementById('newAccountGenerateBtn'),
  newAccountExportBtn: document.getElementById('newAccountExportBtn'),
  importTemplateBtn: document.getElementById('importTemplateBtn'),
  manageTemplateBtn: document.getElementById('manageTemplateBtn'),
  accountMappingBtn: document.getElementById('accountMappingBtn'),
  templateSelect: document.getElementById('templateSelect'),
  statusBox: document.getElementById('statusBox'),
  newAccountStatusBox: document.getElementById('newAccountStatusBox'),
  newAccountBankNameInput: document.getElementById('newAccountBankNameInput'),
  newAccountLocationInput: document.getElementById('newAccountLocationInput'),
  newAccountCurrencyInput: document.getElementById('newAccountCurrencyInput'),
  newAccountCurrencyDropdownWrap: document.getElementById('newAccountCurrencyDropdownWrap'),
  newAccountCurrencyDropdownBtn: document.getElementById('newAccountCurrencyDropdownBtn'),
  newAccountCurrencyDropdownPanel: document.getElementById('newAccountCurrencyDropdownPanel'),
  newAccountMultiCurrencyCheckbox: document.getElementById('newAccountMultiCurrencyCheckbox'),
  newAccountBankAccountInput: document.getElementById('newAccountBankAccountInput'),
  newAccountOpenDateInput: document.getElementById('newAccountOpenDateInput'),
  newAccountRows: document.getElementById('newAccountRows'),
  newAccountAddRowBtn: document.getElementById('newAccountAddRowBtn'),
  appVersion: document.getElementById('appVersion'),
  modalRoot: document.getElementById('modalRoot'),
  minimizeBtn: document.getElementById('minimizeBtn'),
  maximizeBtn: document.getElementById('maximizeBtn'),
  closeBtn: document.getElementById('closeBtn'),
  moduleSwitcherBtn: document.getElementById('moduleSwitcherBtn'),
  moduleSwitcherMenu: document.getElementById('moduleSwitcherMenu'),
  currentModuleName: document.getElementById('currentModuleName'),
  statementModulePanel: document.getElementById('statementModulePanel'),
  newAccountModulePanel: document.getElementById('newAccountModulePanel'),
  pendingModulePanel: document.getElementById('pendingModulePanel'),
  pendingRuleBtn: document.getElementById('pendingRuleBtn'),
  pendingImportBtn: document.getElementById('pendingImportBtn'),
  pendingRunBtn: document.getElementById('pendingRunBtn'),
  pendingExportBtn: document.getElementById('pendingExportBtn'),
  pendingStatusBox: document.getElementById('pendingStatusBox'),
  bankStatementModulePanel: document.getElementById('bankStatementModulePanel'),
  bankStatementScenarioBtn: document.getElementById('bankStatementScenarioBtn'),
  // v2.1.16 A5：「导入对账单」按钮即批量入口（多选 + 按表头识别路由），无独立批量按钮
  bankStatementImportBtn: document.getElementById('bankStatementImportBtn'),
  bankStatementRunBtn: document.getElementById('bankStatementRunBtn'),
  bankStatementExportBtn: document.getElementById('bankStatementExportBtn'),
  bankStatementStatusBox: document.getElementById('bankStatementStatusBox'),
  // v2.1.14 B：资金对账数据处理面板「链接表管理」按钮缓存。
  // v3.0.7 需求2a（C2）：原 row2 两个网关按钮（导入不平表 bankStatementGatewayReconImportBtn /
  //   导出文件 bankStatementGatewayReconExportBtn）已随面板删除——DOM 缓存、事件绑定、导出 disabled 网关分支一并清理。
  //   网关 ReconID 修复仍由「对账单 ReconID 修复」面板入口承载（handleReconIdFixExport 等保留）。
  bankStatementLinkedTableBtn: document.getElementById('bankStatementLinkedTableBtn'),
  // v3.0.14：前置资金对账模块。
  preFundReconciliationModulePanel: document.getElementById('preFundReconciliationModulePanel'),
  preFundReconciliationImportBankBtn: document.getElementById('preFundReconciliationImportBankBtn'),
  preFundReconciliationExportBtn: document.getElementById('preFundReconciliationExportBtn'),
  preFundReconciliationRunBtn: document.getElementById('preFundReconciliationRunBtn'),
  preFundReconciliationScenarioSelect: document.getElementById('preFundReconciliationScenarioSelect'),
  preFundReconciliationTempManagerBtn: document.getElementById('preFundReconciliationTempManagerBtn'),
  preFundReconciliationStatusBox: document.getElementById('preFundReconciliationStatusBox'),
  // v2.1.2 T2：月度银行对账单BU回填校验模块（5 项 DOM 缓存；月份选择改为对话框，无 select）
  bankBuReconModulePanel: document.getElementById('bankBuReconModulePanel'),
  bankBuReconImportBtn: document.getElementById('bankBuReconImportBtn'),
  bankBuReconRunBtn: document.getElementById('bankBuReconRunBtn'),
  bankBuReconExportBtn: document.getElementById('bankBuReconExportBtn'),
  bankBuReconStatusBox: document.getElementById('bankBuReconStatusBox'),
  // v2.1.3：业务OP数据核对模块（spec §7.3 — 7 项 DOM 缓存）
  bizOpReconModulePanel: document.getElementById('bizOpReconModulePanel'),
  bizOpReconImportBtn: document.getElementById('bizOpReconImportBtn'),
  bizOpReconRunBtn: document.getElementById('bizOpReconRunBtn'),
  bizOpReconBuRow: document.getElementById('bizOpReconBuRow'),
  bizOpReconBuSelect: document.getElementById('bizOpReconBuSelect'),
  bizOpReconExportBtn: document.getElementById('bizOpReconExportBtn'),
  bizOpReconStatusBox: document.getElementById('bizOpReconStatusBox'),

  // v2.1.6 Module B：收单单据币种校验
  acquiringBillCurrencyModulePanel: document.getElementById('acquiringBillCurrencyModulePanel'),
  acquiringBillCurrencyImportFlowBtn: document.getElementById('acquiringBillCurrencyImportFlowBtn'),
  acquiringBillCurrencyImportBillBtn: document.getElementById('acquiringBillCurrencyImportBillBtn'),
  acquiringBillCurrencyRunBtn: document.getElementById('acquiringBillCurrencyRunBtn'),
  acquiringBillCurrencyExportBtn: document.getElementById('acquiringBillCurrencyExportBtn'),
  acquiringBillCurrencyStatusBox: document.getElementById('acquiringBillCurrencyStatusBox'),
  // v2.1.12 需求1：VCC业务OP计算模块（5 项 DOM 缓存；「导出差异」位 →「显示余额」）
  vccOpCalcModulePanel: document.getElementById('vccOpCalcModulePanel'),
  vccOpCalcImportBtn: document.getElementById('vccOpCalcImportBtn'),
  vccOpCalcRunBtn: document.getElementById('vccOpCalcRunBtn'),
  vccOpCalcShowBalanceBtn: document.getElementById('vccOpCalcShowBalanceBtn'),
  vccOpCalcStatusBox: document.getElementById('vccOpCalcStatusBox'),
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块（spec §一.1 + §七 — 6 项 DOM 缓存）
  // v2.1.0-beta.3 T4：新增主面板"账单类别"下拉 + 行 2 整行 wrapper（可隐藏）
  reconIdFixModulePanel: document.getElementById('reconIdFixModulePanel'),
  reconIdFixBillCategorySelect: document.getElementById('reconIdFixBillCategorySelect'),
  reconIdFixScenarioRow: document.getElementById('reconIdFixScenarioRow'),
  reconIdFixManageScenariosBtn: document.getElementById('reconIdFixManageScenariosBtn'),
  reconIdFixImportBtn: document.getElementById('reconIdFixImportBtn'),
  reconIdFixScenarioSelect: document.getElementById('reconIdFixScenarioSelect'),
  reconIdFixRunBtn: document.getElementById('reconIdFixRunBtn'),
  reconIdFixExportBtn: document.getElementById('reconIdFixExportBtn'),
  reconIdFixStatusBox: document.getElementById('reconIdFixStatusBox'),
  backgroundTool: document.getElementById('backgroundTool'),
  backgroundPaletteBtn: document.getElementById('backgroundPaletteBtn'),
  saveUserGuideBtn: document.getElementById('saveUserGuideBtn'),
  // v2.1.4 T3：小助手功能收纳触发按钮（紧贴 saveUserGuideBtn 右侧）
  moduleCabinetBtn: document.getElementById('moduleCabinetBtn'),
  // v3.0.8 需求1：工具箱🧰 触发按钮（紧贴 moduleCabinetBtn 右侧）
  toolboxBtn: document.getElementById('toolboxBtn'),
  backgroundPalettePanel: document.getElementById('backgroundPalettePanel'),
  backgroundSpectrumArea: document.getElementById('backgroundSpectrumArea'),
  backgroundSpectrumCanvas: document.getElementById('backgroundSpectrumCanvas'),
  backgroundSpectrumCrosshair: document.getElementById('backgroundSpectrumCrosshair'),
  backgroundSelectedColorSwatch: document.getElementById('backgroundSelectedColorSwatch'),
  backgroundImportBtn: document.getElementById('backgroundImportBtn'),
  backgroundDoneBtn: document.getElementById('backgroundDoneBtn'),
  backgroundResetBtn: document.getElementById('backgroundResetBtn')
};

const {
  closeModal,
  openModal,
  // v2.1.16-beta.5 需求1（PR-4）：资金对账面板「开始运行」多场景单选对话框
  createGatewayReconScenarioPickerDialog,
  createAlertDialog,
  createConfirmDialog,
  createExportScopeDialog,
  createMonthlyBalanceExportDialog,
  createManualBalanceSeedDialog,
  createTemplateRenameDialog,
  createBigAccountSelectionDialog,
  createBigAccountManagerDialog,
  createRememberOrderMismatchDialog,
  createTemplateManagerDialog,
  createMappingDialog,
  createAccountMappingDialog,
  createAccountMappingMigrationDialog,
  // v3.0.12 功能2（批A）：账户映射管理弹窗（链接表管理内部打开，renderer 侧仅供 preview 链路引用）
  createFundTransferAccountMappingDialog,
  // v1.5.3 round 6：补全 preview 所需 factory（仅 preview 链路使用）
  createAmountSplitRulesDialog,
  createBillSplitRowsDialog,
  createBillSplitMappingsDialog,
  createBalanceAddonManagerDialog,
  // v2.0.0-beta.3：银行对账单处理模块场景管理
  createScenariosManagerDialog,
  createScenarioCategorySelectDialog,
  // v2.1.14 C：链接表管理弹窗（UI 骨架占位）
  createLinkedTableManagerDialog,
  // v3.0.14：前置资金对账临时 MPT 批次管理。
  createPreFundTempManagerDialog,
  // v3.0.1 需求1（D4）：按日期范围删除网关对账单弹框（preview 直接调用）
  createLinkedTableDeleteRangeDialog,
  // v2.0.0-beta.3 PR #32b：4 dialog factory（C1/C2/C3 配置 + 确认场景详情）
  createScenarioConfigDialogC1,
  createScenarioConfigDialogC2,
  createScenarioConfigDialogC3,
  createScenarioConfirmDetailDialog,
  // v2.1.0-beta.1 PR-A（task A7）：C4 类配置弹窗
  createScenarioConfigDialogC4,
  // v2.1.2 T2：月份选择对话框（PRD §3.2.5 拍板修正）
  createBankBuReconMonthPickerDialog,
  // v2.1.6 fix5：收单单据币种校验月份选择对话框（spec v0.8 §8.1）
  createAcquiringBillCurrencyMonthPickerDialog,
  // v2.1.2 T2：文件导入提示对话框（Clear 风前端 modal）
  createBankBuReconFileImportPromptDialog,
  // v2.1.2 T2 (spec v0.5)：开始运行 / 导出差异 弹窗
  createBankBuReconReconcileDialog,
  createBankBuReconExportDialog,
  // v2.1.2 T2：preview state apply 函数（v0.8 删除 anomaly preview）
  applyBankBuReconPanelInitialPreviewState,
  applyBankBuReconPanelImportingPreviewState,
  applyBankBuReconPanelResultPreviewState,
  // v2.1.3：业务OP数据核对 dialog factory（v2.1.3-fix2 删除 createBizOpReconErrorReportDialog 后剩 4 个）+ preview state apply 函数 4 个
  createBizOpReconDatePickerDialog,
  createBizOpReconReconcileDialog,
  createBizOpReconExportDialog,
  createBizOpReconSecondImportPromptDialog,
  applyBizOpReconPanelInitialPreviewState,
  applyBizOpReconPanelImportingPreviewState,
  applyBizOpReconPanelResultPreviewState,
  applyBizOpReconPanelExportDialogPreviewState,
  // v2.1.3-fix1：状态框冒号换行 formatter + 默认日期 helper
  formatBizOpReconStatusHtml,
  getBizOpReconDefaultDate,
  // v2.1.4 T3：小助手功能收纳弹窗工厂
  createModuleCabinetDialog,
  // v3.0.8 需求1：工具箱🧰 主弹框（按钮 click 用）；拆表选字段弹框（preview 直接调用需在 renderer.js 取得引用）
  createToolboxDialog,
  createSplitFieldPickerDialog,
  // v2.1.12 需求1：VCC业务OP计算 dialog factory（F1 确认 / F2 计算 / F3 显示余额）
  createVccOpCalcConfirmDialog,
  createVccOpCalcComputeDialog,
  createVccOpCalcShowBalanceDialog,
  applyVccOpCalcPanelInitialPreviewState,
  applyVccOpCalcPanelResultPreviewState,
  applyVccOpCalcComputeDialogPreviewState,
  applyVccOpCalcShowBalanceDialogPreviewState
} = window.__rendererDialogs.createRendererDialogs({
  state,
  elements,
  desktopApi: window.desktopApi,
  appConstants: window.appConstants,
  BALANCE_DISABLED_OPTION,
  BALANCE_CALCULATED_OPTION,
  MERCHANT_ID_SELF_INPUT_OPTION,
  ADVANCED_MAPPING_FIELDS,
  CONCAT_FIELDS_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION,
  refreshTemplates,
  setStatus,
  applyStatementResult,
  applyManualBalancePromptStatus,
  refreshBankStatementStatus,
  // v2.1.14 C：占位 helper 透传给 dialogs 闭包（链接表管理弹窗「导入」按钮调用）
  showComingSoon,
  // v2.1.0-beta.1 PR-A（task A9）：场景管理 dialog 任意 CRUD 完成后 reload 主面板"场景"下拉
  reloadReconIdFixScenarios
});

const rendererPending = window.__rendererPending.createRendererPending({
  state,
  elements,
  desktopApi: window.desktopApi,
  openModal,
  closeModal,
  createAlertDialog,
  createConfirmDialog
});

const {
  applyNewAccountPreviewState,
  applyTemplateManagerPreviewState,
  applyMappingDialogPreviewState,
  applyTemplateRenamePreviewState,
  applyBigAccountManagerPreviewState,
  applyBigAccountManagerDropdownPreviewState,
  applyBigAccountSelectionPreviewState,
  // v1.5.3 round 6：补全的 9 个 modal preview
  applyMonthlyBalanceExportDialogPreviewState,
  applyManualBalanceSeedDialogPreviewState,
  applyBalanceAddonManagerPreviewState,
  applyExportScopeDialogPreviewState,
  applyAmountSplitRulesDialogPreviewState,
  applyBillSplitRowsDialogPreviewState,
  applyBillSplitMappingsDialogPreviewState,
  applyRememberOrderMismatchDialogPreviewState,
  applyAccountMappingMigrationDialogPreviewState,
  // v2.0.0 Pending 模块 preview（6 张）
  applyPendingPanelPreviewState,
  applyPendingRuleDialogPreviewState,
  applyPendingRuleConfirmPreviewState,
  applyPendingImportMonthPreviewState,
  applyPendingReconcilePreviewState,
  applyPendingExportRunsPreviewState,
  // 2026-04-24 补：9 张历史遗漏 preview
  applyPendingPanelInitialPreviewState,
  applyPendingPanelImportingPreviewState,
  applyPendingPanelErrorPreviewState,
  applyModuleSwitcherOpenPreviewState,
  applyNewAccountMultiPreviewState,
  applyNewAccountCurrencyDropdownPreviewState,
  applyBigAccountSelectionMultiPreviewState,
  applyBigAccountSelectionMultiLargePreviewState,   // v2.1.7 round 3 B4: ≥20 文件 fixture
  applyExtractOrderPreviewState,
  applyAccountMappingEditingPreviewState,
  // v3.0.12 功能2（批A）：账户映射管理弹窗 preview
  applyFundTransferAccountMappingPreviewState,
  // v2.0.0-beta.3：银行对账单处理模块 preview（3 张）
  applyBankStatementPanelPreviewState,
  applyScenariosManagerPreviewState,
  // v2.1.16 A1：自带写死场景「管理」弹窗（含优先级输入框）preview
  applyBuiltinFixedChannelManagePreviewState,
  // v3.0.4 块 F · F1：Payment 线下调拨订单回填处理展开态 preview
  applyBuiltinFixedChannelManagePaymentPreviewState,
  applyScenarioCategorySelectPreviewState,
  // v2.1.14 C：链接表管理弹窗 preview
  applyLinkedTableManagerPreviewState,
  // v3.0.14：临时链接表管理首页 preview
  applyPreFundTempManagerPreviewState,
  // v3.0.14：临时链接表按日期删除框 preview
  applyPreFundTempDeleteRangePreviewState,
  // v3.0.1 需求1（D4）：删除网关对账单弹框 preview
  applyLinkedTableDeleteRangePreviewState,
  // v3.0.1 需求3：网关对账单修复场景单选框 preview
  applyGatewayReconScenarioPickerPreviewState,
  // v2.0.0-beta.3 PR #32b：4 类配置弹窗 + 确认详情 preview（4 张）
  // v2.1.7 F1：C1 dialog 新增 AND 模式 preview
  applyScenarioConfigC1PreviewState,
  applyScenarioConfigC1AndPreviewState,
  applyScenarioConfigC2PreviewState,
  applyScenarioConfigC3PreviewState,
  applyScenarioConfigC3CustomPreviewState,
  applyScenarioConfirmDetailPreviewState,
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块 preview（3 张）
  applyReconIdFixPanelPreviewState,
  applyScenarioConfigC4PreviewState,
  applyScenarioConfigC4BothPreviewState,
  // v2.1.0-beta.3 T11：网关子模式 preview（4 张）
  applyReconIdFixPanelBusinessPreviewState,
  applyReconIdFixPanelGatewayPreviewState,
  applyScenarioConfigC4GatewayPreviewState,
  applyScenarioConfigC4Gateway1vNPreviewState,
  // v2.1.4 T3：小助手功能收纳弹窗 preview
  applyModuleCabinetPreviewState,
  // v3.0.8 需求1：工具箱🧰 主弹框 + 拆表选字段弹框 preview
  applyToolboxPreviewState,
  applyToolboxSplitFieldPickerPreviewState
} = window.__rendererPreviews.createRendererPreviews({
  state,
  elements,
  MODULES,
  ADVANCED_MAPPING_FIELDS,
  BALANCE_CALCULATED_OPTION,
  MERCHANT_ID_SELF_INPUT_OPTION,
  SIGNED_AMOUNT_MAPPING_FIELD,
  AMOUNT_BASED_NAME_MAPPING_FIELD,
  AMOUNT_BASED_ACCOUNT_MAPPING_FIELD,
  setCurrentModule,
  syncNewAccountCurrencyMode,
  updateNewAccountGenerateAvailability,
  setNewAccountExportAvailability,
  setNewAccountStatus,
  setExportAvailability,
  setStatus,
  getNewAccountStatusTitle,
  setNewAccountOpenDateValue,
  openModal,
  createTemplateManagerDialog,
  createMappingDialog,
  createTemplateRenameDialog,
  createBigAccountManagerDialog,
  createBigAccountSelectionDialog,
  // v1.5.3 round 6：补全 preview 所需 factory
  createMonthlyBalanceExportDialog,
  createManualBalanceSeedDialog,
  createBalanceAddonManagerDialog,
  createExportScopeDialog,
  createAmountSplitRulesDialog,
  createBillSplitRowsDialog,
  createBillSplitMappingsDialog,
  createRememberOrderMismatchDialog,
  createAccountMappingMigrationDialog,
  closeModal,
  openBackgroundPalette,
  // v2.0.0 Pending 模块 preview 所需
  rendererPending,
  createConfirmDialog,
  // 后续 preview 扩展所需
  openModuleMenu,
  createAccountMappingDialog,
  // v3.0.12 功能2（批A）：账户映射管理弹窗 preview 链路所需 factory
  createFundTransferAccountMappingDialog,
  desktopApi: window.desktopApi,
  applyStatementResult,
  closeAllNewAccountCurrencyDropdowns,
  // v2.0.0-beta.3 PR #32b：4 类配置弹窗 + 确认详情 preview 所需
  createScenarioConfigDialogC1,
  createScenarioConfigDialogC2,
  createScenarioConfigDialogC3,
  createScenarioConfirmDetailDialog,
  // v2.1.0-beta.1 PR-A（task A7）：C4 配置弹窗 preview 所需
  createScenarioConfigDialogC4,
  // v2.1.4 T3：小助手功能收纳弹窗工厂
  createModuleCabinetDialog,
  // v3.0.8 需求1：工具箱🧰 主弹框 + 拆表选字段弹框工厂（preview 直接调用）
  createToolboxDialog,
  createSplitFieldPickerDialog,
  // v3.0.1 需求1（D4）：删除网关对账单弹框 preview 直接调用
  createLinkedTableDeleteRangeDialog,
  // v3.0.1 需求3：网关对账单修复场景单选框 preview 直接调用
  createGatewayReconScenarioPickerDialog
});

function updateStatusBox(box, message, tone = 'info', options = {}) {
  const {
    errorReportReady = false,
    manualBalancePromptReady = false,
    idleTitle = ''
  } = options;

  // v2.0.0-beta.2：只更新 .status-box-text 子节点的文案，保留同级 .status-spark SVG 不被清空
  // v2.1.7 round 2 R3：中文「：」（U+FF1A）后强制换行；半角 ':' 不动（避开 URL/timestamp/账号 case）
  //   null/undefined 兜底空串（防 String(null) === 'null' 显示）
  //   配合 CSS .status-box-text { white-space: pre-wrap; } 识别 \n
  //   spec §8.4.2
  const text = (message === null || message === undefined) ? '' : String(message).replace(/：/g, '：\n');
  const textEl = box.querySelector('.status-box-text');
  if (textEl) textEl.textContent = text;
  box.dataset.tone = tone;
  box.dataset.errorReportReady = errorReportReady ? 'true' : 'false';
  box.dataset.manualBalancePromptReady = manualBalancePromptReady ? 'true' : 'false';
  box.classList.toggle('is-clickable', errorReportReady || manualBalancePromptReady);
  box.title = manualBalancePromptReady
    ? '点击补录上一账单日余额'
    : errorReportReady
      ? '点击导出报错文件'
      : idleTitle;

  // v2.1.9 SR-log-1 (T32i)：wrapper hijack — tone='error'/'warning' 自动上报告警（spec §15.5）
  //   - 集中在 updateStatusBox 出口，setStatus / setNewAccountStatus / setBankBuReconStatus / setBizOpReconStatus /
  //     setAcquiringBillCurrencyStatus / updateReconIdFixUi 等全部走这条路径 → 一处覆盖 175+ 调用方
  //   - try-catch graceful：desktopApi 不存在 / IPC 抛错 → 不阻塞 UI 文案显示
  //   - 仅 error / warning 上报，info / success / neutral 不打扰日志
  //   - logDomain 取自 options 或 box.dataset.logDomain（dialog 工厂可选注入）
  if (tone === 'error' || tone === 'warning') {
    try {
      if (window.desktopApi && window.desktopApi.app && typeof window.desktopApi.app.reportLog === 'function') {
        window.desktopApi.app.reportLog({
          level: tone,
          source: 'renderer',
          domain: options.logDomain || (box && box.dataset && box.dataset.logDomain) || 'ui',
          message: String(message || ''),
          details: Array.isArray(options.logDetails) ? options.logDetails : []
        });
      }
    } catch (_error) {
      // graceful — wrapper hijack 异常绝不阻塞 UI
    }
  }
}

function setStatus(message, tone = 'info', options = {}) {
  state.hasErrorReport = Boolean(options.errorReportReady);
  state.manualBalancePromptReady = Boolean(options.manualBalancePromptReady);
  state.manualBalancePrompt = state.manualBalancePromptReady && options.manualBalancePrompt
    ? { ...options.manualBalancePrompt }
    : null;
  updateStatusBox(elements.statusBox, message, tone, {
    errorReportReady: state.hasErrorReport,
    manualBalancePromptReady: state.manualBalancePromptReady,
    idleTitle: options.idleTitle ?? getStatusBoxTitle(state.accountMappingCount)
  });
}

function setNewAccountStatus(message, tone = 'info', options = {}) {
  state.newAccountHasErrorReport = Boolean(options.errorReportReady);
  updateStatusBox(elements.newAccountStatusBox, message, tone, {
    errorReportReady: state.newAccountHasErrorReport,
    idleTitle: options.idleTitle ?? '请完整填写开户信息后点击生成'
  });
}

function applyManualBalancePromptStatus(result) {
  setStatus(result.message, 'info', {
    errorReportReady: Boolean(result.errorReportReady),
    manualBalancePromptReady: Boolean(result.manualBalancePromptReady),
    manualBalancePrompt: result.manualBalancePrompt || null
  });
}

function getEnumStatusMessage() {
  return state.hasEnum
    ? '欢迎使用小助手'
    : '内置网银账单枚举表缺失，请检查安装包';
}

function getStatusBoxTitle(accountMappingCount) {
  const mappingSummary = accountMappingCount
    ? `当前账户映射条数：${accountMappingCount}`
    : '当前未设置账户映射';

  return `${mappingSummary}；应用已内置 COMMON 枚举表`;
}

function getNewAccountStatusTitle() {
  return state.canExportNewAccount
    ? '新开账户余额账单已生成，可点击导出'
    : '请完整填写开户信息后点击生成';
}

async function handleExportLastError(target = 'main') {
  const hasErrorReport = target === 'main' ? state.hasErrorReport : state.newAccountHasErrorReport;

  if (!hasErrorReport) {
    return;
  }

  const result = await window.desktopApi.errors.exportLast();

  if (result.status === 'cancelled' || result.status === 'empty') {
    return;
  }

  if (target === 'main') {
    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: result.status === 'success' ? true : Boolean(result.errorReportReady)
    });
    return;
  }

  setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: result.status === 'success' ? true : Boolean(result.errorReportReady)
  });
}

function applyStatementResult(result) {
  if (result.status === 'cancelled') {
    return false;
  }

  const tone = result.status === 'success'
    ? 'success'
    : result.manualBalancePromptReady
      ? 'info'
      : 'error';

  setStatus(result.message, tone, {
    errorReportReady: Boolean(result.errorReportReady),
    manualBalancePromptReady: Boolean(result.manualBalancePromptReady),
    manualBalancePrompt: result.manualBalancePrompt || null
  });

  if (Array.isArray(result.unmatchedAmountSplitFiles) && result.unmatchedAmountSplitFiles.length) {
    window.alert(`以下文件全部未命中收支规则，请检查规则配置：\n${result.unmatchedAmountSplitFiles.join('\n')}`);
  }

  // v1.4.9 PR #16 review P1 Fix C: ACI-12 — 拆分/合并账单全部未命中聚合告警
  if (Array.isArray(result.unmatchedBillSplitFiles) && result.unmatchedBillSplitFiles.length) {
    window.alert(`以下文件全部未命中拆分/合并规则，请检查规则配置：\n${result.unmatchedBillSplitFiles.join('\n')}`);
  }

  if (
    result.status === 'success' ||
    result.status === 'warning' ||
    result.status === 'manual-balance-required' ||
    result.status === 'manual-balance-invalid'
  ) {
    setExportAvailability({
      detailEnabled: Boolean(result.detailReady),
      balanceEnabled: Boolean(result.balanceReady)
    });
    return true;
  }

  setExportAvailability({
    detailEnabled: false,
    balanceEnabled: false
  });
  return true;
}

function getNewAccountRows() {
  return Array.from(elements.newAccountRows?.querySelectorAll('[data-new-account-row]') || []);
}

function getNewAccountRowElements(row) {
  return {
    row,
    bankNameInput: row.querySelector('.new-account-bank-name-input'),
    locationInput: row.querySelector('.new-account-location-input'),
    currencyRow: row.querySelector('.new-account-currency-row'),
    currencyInput: row.querySelector('.new-account-currency-input'),
    currencyDropdownWrap: row.querySelector('.new-account-currency-dropdown-wrap'),
    currencyDropdownBtn: row.querySelector('.new-account-currency-dropdown-btn'),
    currencyDropdownPanel: row.querySelector('.new-account-currency-dropdown-panel'),
    multiCurrencyCheckbox: row.querySelector('.new-account-multi-currency-checkbox'),
    bankAccountInput: row.querySelector('.new-account-bank-account-input'),
    openDateInput: row.querySelector('.new-account-open-date-input'),
    rowActionBtn: row.querySelector('.new-account-row-action-btn')
  };
}

function getNewAccountRowState(row) {
  if (!newAccountRowStateMap.has(row)) {
    newAccountRowStateMap.set(row, {
      selectedCurrencies: [],
      currencySearchQuery: '',
      isDropdownOpen: false,
      initialized: false
    });
  }

  return newAccountRowStateMap.get(row);
}

function ensureCurrencyGhostShell(input) {
  let shell = input.parentElement?.classList.contains('enum-input-shell') ? input.parentElement : null;
  let ghostInput = shell?.querySelector('.enum-ghost-input');

  if (!shell) {
    shell = document.createElement('div');
    shell.className = 'enum-input-shell';
    input.parentNode.insertBefore(shell, input);
    shell.appendChild(input);
  }

  if (!ghostInput) {
    ghostInput = document.createElement('input');
    ghostInput.className = `${input.className} enum-ghost-input`;
    ghostInput.type = 'text';
    ghostInput.tabIndex = -1;
    ghostInput.disabled = true;
    shell.insertBefore(ghostInput, input);
  }

  input.classList.add('enum-active-input');
  return { shell, ghostInput };
}

function normalizeCurrencyOptionEntry(option) {
  if (typeof option === 'string') {
    const code = option.trim();
    return code
      ? {
          code,
          name: '',
          label: code
        }
      : null;
  }

  if (!option || typeof option !== 'object') {
    return null;
  }

  const code = String(option.code || option.englishCode || '').trim();

  if (!code) {
    return null;
  }

  const name = String(option.name || option.displayName || option.chineseName || '').trim();
  return {
    code,
    name,
    label: String(option.label || '').trim() || (name ? `${code} ${name}` : code)
  };
}

function getCurrencyOptionEntries() {
  const optionMap = new Map();

  state.currencyOptions.forEach((option) => {
    const normalized = normalizeCurrencyOptionEntry(option);

    if (!normalized || optionMap.has(normalized.code)) {
      return;
    }

    optionMap.set(normalized.code, normalized);
  });

  return Array.from(optionMap.values());
}

function getCurrencyOptionCodes() {
  return getCurrencyOptionEntries().map((option) => option.code);
}

function getCurrencyOptionLabel(code) {
  const normalizedCode = String(code || '').trim();
  const matchedOption = getCurrencyOptionEntries().find((option) => option.code === normalizedCode);
  return matchedOption?.label || normalizedCode;
}

function getCurrencySuggestion(value, allowedCodes = null) {
  const query = String(value || '').trim().toUpperCase();

  if (!query) {
    return '';
  }

  const allowedCodeSet = allowedCodes ? new Set(allowedCodes.map((code) => String(code || '').trim()).filter(Boolean)) : null;
  const matchedOption = getCurrencyOptionEntries().find((option) => {
    if (allowedCodeSet && !allowedCodeSet.has(option.code)) {
      return false;
    }

    return option.code.toUpperCase().startsWith(query);
  });

  return matchedOption?.code || '';
}

function formatSelectedCurrencySummary(currencies) {
  if (!currencies.length) {
    return '\u00A0';
  }

  if (currencies.length <= 2) {
    return currencies.map((code) => getCurrencyOptionLabel(code)).join('、');
  }

  return `已选${currencies.length}项`;
}

function syncNewAccountDropdownFlag() {
  state.isNewAccountCurrencyDropdownOpen = getNewAccountRows().some((row) => getNewAccountRowState(row).isDropdownOpen);
}

function closeAllNewAccountCurrencyDropdowns(exceptRow = null) {
  getNewAccountRows().forEach((row) => {
    if (exceptRow && row === exceptRow) {
      return;
    }

    closeNewAccountCurrencyDropdown(getNewAccountRowElements(row));
  });
}

function isNewAccountMultiCurrencyMode(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.multiCurrencyCheckbox ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  return Boolean(refs?.multiCurrencyCheckbox?.checked);
}

function syncNewAccountRowActionButtons() {
  getNewAccountRows().forEach((row, index) => {
    const refs = getNewAccountRowElements(row);

    if (refs.rowActionBtn) {
      const isFirstRow = index === 0;
      refs.rowActionBtn.hidden = false;
      refs.rowActionBtn.dataset.rowAction = isFirstRow ? 'add' : 'delete';
      refs.rowActionBtn.textContent = isFirstRow ? '新增' : '删除';
      refs.rowActionBtn.title = isFirstRow ? '新增账号行' : '删除当前账号行';
      refs.rowActionBtn.setAttribute('aria-label', isFirstRow ? '新增账号行' : '删除当前账号行');
    }
  });
}

function closeNewAccountCurrencyDropdown(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyDropdownPanel ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.currencyDropdownPanel || !refs.currencyDropdownBtn) {
    return;
  }

  const rowState = getNewAccountRowState(refs.row);
  rowState.isDropdownOpen = false;
  rowState.currencySearchQuery = '';
  refs.currencyDropdownPanel.hidden = true;
  refs.currencyDropdownBtn.classList.remove('is-open');
  refs.currencyDropdownBtn.setAttribute('aria-expanded', 'false');
  if (isNewAccountMultiCurrencyMode(refs)) {
    renderNewAccountCurrencyOptions(refs);
  }
  syncNewAccountDropdownFlag();
}

function updateNewAccountCurrencyDropdownLabel(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyDropdownBtn ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.currencyDropdownBtn) {
    return;
  }

  const rowState = getNewAccountRowState(refs.row);
  const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);
  const label = isMultiCurrency
    ? formatSelectedCurrencySummary(rowState.selectedCurrencies)
    : (refs.currencyInput.value ? getCurrencyOptionLabel(refs.currencyInput.value) : '\u00A0');

  refs.currencyDropdownBtn.textContent = label;
  refs.currencyDropdownBtn.title = isMultiCurrency
    ? rowState.selectedCurrencies.map((currency) => getCurrencyOptionLabel(currency)).join('、')
    : (refs.currencyInput.value ? getCurrencyOptionLabel(refs.currencyInput.value) : '显示全部币种');
  refs.currencyDropdownBtn.disabled = getCurrencyOptionEntries().length === 0;
}

function updateNewAccountCurrencySuggestion(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyInput ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.currencyInput || refs.currencyInput.type === 'hidden') {
    return '';
  }

  const { ghostInput } = ensureCurrencyGhostShell(refs.currencyInput);
  const suggestion = isNewAccountMultiCurrencyMode(refs)
    ? ''
    : getCurrencySuggestion(refs.currencyInput.value);
  ghostInput.value = suggestion;
  return suggestion;
}

function matchesCurrencyOptionQuery(option, query) {
  const normalizedQuery = String(query || '').trim().toUpperCase();

  if (!normalizedQuery) {
    return true;
  }

  return [option.code, option.label, option.name]
    .map((value) => String(value || '').trim().toUpperCase())
    .some((value) => value.includes(normalizedQuery));
}

function renderNewAccountCurrencyOptionsList(refs, currencyOptions, host) {
  const rowState = getNewAccountRowState(refs.row);
  const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);
  const optionsHost = host || refs.currencyDropdownPanel;

  if (!optionsHost) {
    return;
  }

  optionsHost.replaceChildren();

  const visibleOptions = isMultiCurrency
    ? currencyOptions.filter((option) => matchesCurrencyOptionQuery(option, rowState.currencySearchQuery))
    : currencyOptions;

  if (!visibleOptions.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'new-account-currency-option';
    emptyState.innerHTML = `<span class="new-account-currency-option-text">${
      isMultiCurrency && String(rowState.currencySearchQuery || '').trim()
        ? '未匹配到币种选项'
        : '未读取到币种选项'
    }</span>`;
    optionsHost.appendChild(emptyState);
    updateNewAccountCurrencyDropdownLabel(refs);
    updateNewAccountCurrencySuggestion(refs);
    return;
  }

  visibleOptions.forEach(({ code, label }) => {
    const option = document.createElement('label');
    option.className = 'new-account-currency-option';

    const text = document.createElement('span');
    text.className = 'new-account-currency-option-text';
    text.textContent = label;

    if (isMultiCurrency) {
      const checkbox = document.createElement('input');
      checkbox.className = 'new-account-checkbox';
      checkbox.type = 'checkbox';
      checkbox.dataset.currencyCode = code;
      checkbox.checked = rowState.selectedCurrencies.includes(code);

      const indexSpan = document.createElement('span');
      indexSpan.className = 'concat-picker-index';
      const selectedIdx = rowState.selectedCurrencies.indexOf(code);
      indexSpan.textContent = selectedIdx >= 0 ? `${selectedIdx + 1}.` : '';

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          rowState.selectedCurrencies = Array.from(new Set([...rowState.selectedCurrencies, code]));
        } else {
          rowState.selectedCurrencies = rowState.selectedCurrencies.filter((value) => value !== code);
        }

        refs.currencyDropdownPanel.querySelectorAll('.concat-picker-index').forEach((span) => {
          const optionCode = span.parentElement?.querySelector('.new-account-checkbox')?.dataset?.currencyCode || '';
          const idx = rowState.selectedCurrencies.indexOf(optionCode);
          span.textContent = idx >= 0 ? `${idx + 1}.` : '';
        });
        updateNewAccountCurrencyDropdownLabel(refs);
        handleNewAccountFormMutation();
      });

      option.append(checkbox, indexSpan, text);
    } else {
      option.classList.toggle('is-selected', refs.currencyInput.value === code);
      option.addEventListener('click', () => {
        refs.currencyInput.value = code;
        updateNewAccountCurrencyDropdownLabel(refs);
        closeNewAccountCurrencyDropdown(refs);
        handleNewAccountFormMutation();
      });
      option.append(text);
    }

    optionsHost.appendChild(option);
  });

  updateNewAccountCurrencyDropdownLabel(refs);
  updateNewAccountCurrencySuggestion(refs);
}

function openNewAccountCurrencyDropdown(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyDropdownPanel ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.currencyDropdownPanel || getCurrencyOptionEntries().length === 0) {
    return;
  }

  renderNewAccountCurrencyOptions(refs);
  closeAllNewAccountCurrencyDropdowns(refs.row);
  getNewAccountRowState(refs.row).isDropdownOpen = true;
  refs.currencyDropdownPanel.hidden = false;
  refs.currencyDropdownBtn.classList.add('is-open');
  refs.currencyDropdownBtn.setAttribute('aria-expanded', 'true');
  if (isNewAccountMultiCurrencyMode(refs)) {
    setTimeout(() => {
      refs.currencyDropdownPanel.querySelector('.new-account-currency-search-input')?.focus({ preventScroll: true });
    }, 0);
  }
  syncNewAccountDropdownFlag();
}

function toggleNewAccountCurrencyDropdown(rowOrRefs = elements) {
  const refs = rowOrRefs.row ? rowOrRefs : rowOrRefs.currencyDropdownPanel ? rowOrRefs : getNewAccountRowElements(getNewAccountRows()[0]);
  const rowState = refs?.row ? getNewAccountRowState(refs.row) : null;

  if (!refs || !rowState) {
    return;
  }

  if (rowState.isDropdownOpen) {
    closeNewAccountCurrencyDropdown(refs);
    return;
  }

  openNewAccountCurrencyDropdown(refs);
}

function handleNewAccountFormMutation() {
  updateNewAccountGenerateAvailability();
  setNewAccountExportAvailability(false);
  setNewAccountStatus('请完整填写开户信息后点击生成', 'info', {
    errorReportReady: false,
    idleTitle: getNewAccountStatusTitle()
  });
}

function renderNewAccountCurrencyOptions(rowOrRefs = null) {
  if (!rowOrRefs) {
    getNewAccountRows().forEach((row) => {
      renderNewAccountCurrencyOptions(getNewAccountRowElements(row));
    });
    return;
  }

  const refs = rowOrRefs.row ? rowOrRefs : getNewAccountRowElements(rowOrRefs);
  const rowState = getNewAccountRowState(refs.row);
  const currencyOptions = getCurrencyOptionEntries();
  const currencyCodes = currencyOptions.map((option) => option.code);
  refs.currencyDropdownPanel.replaceChildren();
  rowState.selectedCurrencies = rowState.selectedCurrencies.filter((currency) => currencyCodes.includes(currency));
  if (refs.currencyInput.value && !currencyCodes.includes(refs.currencyInput.value)) {
    refs.currencyInput.value = '';
  }
  const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);

  if (!currencyOptions.length) {
    const emptyState = document.createElement('div');
    emptyState.className = 'new-account-currency-option';
    emptyState.innerHTML = '<span class="new-account-currency-option-text">未读取到币种选项</span>';
    refs.currencyDropdownPanel.appendChild(emptyState);
    updateNewAccountCurrencyDropdownLabel(refs);
    updateNewAccountCurrencySuggestion(refs);
    return;
  }

  if (isMultiCurrency) {
    const searchRow = document.createElement('div');
    searchRow.className = 'new-account-currency-search-row';

    const searchInput = document.createElement('input');
    searchInput.className = 'new-account-input new-account-currency-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = '搜索币种';
    searchInput.spellcheck = false;
    searchInput.value = rowState.currencySearchQuery;
    searchInput.addEventListener('input', () => {
      rowState.currencySearchQuery = searchInput.value;
      renderNewAccountCurrencyOptionsList(refs, currencyOptions, optionsHost);
    });
    searchInput.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });

    const optionsHost = document.createElement('div');
    optionsHost.className = 'new-account-currency-options-list';

    searchRow.appendChild(searchInput);
    refs.currencyDropdownPanel.append(searchRow, optionsHost);
    renderNewAccountCurrencyOptionsList(refs, currencyOptions, optionsHost);
    return;
  }

  const optionsHost = document.createElement('div');
  optionsHost.className = 'new-account-currency-options-list';
  refs.currencyDropdownPanel.appendChild(optionsHost);
  renderNewAccountCurrencyOptionsList(refs, currencyOptions, optionsHost);
}

function syncNewAccountCurrencyMode(rowOrRefs = null) {
  if (!rowOrRefs) {
    getNewAccountRows().forEach((row) => {
      syncNewAccountCurrencyMode(getNewAccountRowElements(row));
    });
    return;
  }

  const refs = rowOrRefs.row ? rowOrRefs : getNewAccountRowElements(rowOrRefs);
  const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);
  const rowState = getNewAccountRowState(refs.row);
  refs.currencyInput.hidden = true;
  refs.currencyDropdownWrap.hidden = false;
  refs.currencyRow?.classList.toggle('is-multi', isMultiCurrency);
  refs.currencyRow?.classList.toggle('is-single', !isMultiCurrency);

  if (!isMultiCurrency) {
    if (rowState.selectedCurrencies.length > 0) {
      refs.currencyInput.value = rowState.selectedCurrencies[0];
    }
    rowState.selectedCurrencies = [];
    rowState.currencySearchQuery = '';
    closeNewAccountCurrencyDropdown(refs);
  } else if (refs.currencyInput.value) {
    rowState.selectedCurrencies = [refs.currencyInput.value];
    refs.currencyInput.value = '';
    rowState.currencySearchQuery = '';
  }

  renderNewAccountCurrencyOptions(refs);
}

function syncNewAccountOpenDateInputType(rowOrInput = elements.newAccountOpenDateInput) {
  const input = rowOrInput?.openDateInput || rowOrInput;
  input.type = input.value ? 'date' : 'text';
}

function setNewAccountOpenDateValue(value, rowOrRefs = null) {
  const refs = rowOrRefs ? (rowOrRefs.row ? rowOrRefs : getNewAccountRowElements(rowOrRefs)) : getNewAccountRowElements(getNewAccountRows()[0]);
  if (!refs?.openDateInput) {
    return;
  }

  refs.openDateInput.type = value ? 'date' : 'text';
  refs.openDateInput.value = value;
}

function initializeNewAccountRow(row, defaults = {}) {
  const refs = getNewAccountRowElements(row);
  const rowState = getNewAccountRowState(row);

  if (!rowState.initialized) {
    refs.currencyDropdownBtn.addEventListener('click', () => {
      toggleNewAccountCurrencyDropdown(refs);
    });
    refs.multiCurrencyCheckbox.addEventListener('change', () => {
      syncNewAccountCurrencyMode(refs);
      handleNewAccountFormMutation();
    });
    [
      refs.bankNameInput,
      refs.locationInput,
      refs.bankAccountInput,
      refs.currencyInput
    ].forEach((input) => {
      input.addEventListener('input', handleNewAccountFormMutation);
    });
    refs.openDateInput.addEventListener('focus', () => {
      if (refs.openDateInput.type !== 'date') {
        refs.openDateInput.type = 'date';
      }

      refs.openDateInput.showPicker?.();
    });
    refs.openDateInput.addEventListener('blur', () => {
      syncNewAccountOpenDateInputType(refs);
    });
    refs.openDateInput.addEventListener('change', () => {
      syncNewAccountOpenDateInputType(refs);
      handleNewAccountFormMutation();
    });
    refs.rowActionBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (refs.rowActionBtn.dataset.rowAction === 'delete') {
        removeNewAccountRow(refs.row);
        return;
      }

      addNewAccountRow();
    });
    rowState.initialized = true;
  }

  refs.bankNameInput.value = defaults.bankName ?? refs.bankNameInput.value ?? '';
  refs.locationInput.value = defaults.location ?? refs.locationInput.value ?? '';
  refs.currencyInput.value = defaults.currency ?? refs.currencyInput.value ?? '';
  refs.bankAccountInput.value = defaults.bankAccount ?? refs.bankAccountInput.value ?? '';
  setNewAccountOpenDateValue(defaults.openingDate ?? refs.openDateInput.value ?? '', refs);
  refs.multiCurrencyCheckbox.checked = Boolean(defaults.isMultiCurrency);
  rowState.selectedCurrencies = Array.isArray(defaults.currencies) ? defaults.currencies.slice() : rowState.selectedCurrencies;
  rowState.currencySearchQuery = '';
  syncNewAccountCurrencyMode(refs);
  syncNewAccountRowActionButtons();
}

function addNewAccountRow(defaults = {}) {
  const sourceRow = getNewAccountRows()[0];

  if (!sourceRow) {
    return;
  }

  const clone = sourceRow.cloneNode(true);
  clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  clone.querySelectorAll('input').forEach((input) => {
    if (input.type === 'checkbox') {
      input.checked = false;
    } else {
      input.value = '';
    }
  });
  elements.newAccountRows.appendChild(clone);
  initializeNewAccountRow(clone, defaults);
  syncNewAccountRowActionButtons();
  handleNewAccountFormMutation();
}

function removeNewAccountRow(row) {
  const rows = getNewAccountRows();

  if (!row || rows.length <= 1) {
    return;
  }

  const refs = getNewAccountRowElements(row);
  closeNewAccountCurrencyDropdown(refs);
  row.remove();
  syncNewAccountRowActionButtons();
  syncNewAccountDropdownFlag();
  handleNewAccountFormMutation();
}

function resetNewAccountRows() {
  const rows = getNewAccountRows();
  rows.slice(1).forEach((row) => row.remove());
  const firstRow = rows[0];

  if (!firstRow) {
    return;
  }

  initializeNewAccountRow(firstRow, {
    bankName: '',
    location: '',
    currency: '',
    bankAccount: '',
    openingDate: '',
    isMultiCurrency: false,
    currencies: []
  });
  syncNewAccountRowActionButtons();
}

function isNewAccountFormComplete() {
  return getNewAccountRows().length > 0 && getNewAccountRows().every((row) => {
    const refs = getNewAccountRowElements(row);
    const rowState = getNewAccountRowState(row);
    const currencyReady = isNewAccountMultiCurrencyMode(refs)
      ? rowState.selectedCurrencies.length > 0
      : String(refs.currencyInput.value || '').trim() !== '';

    return [
      refs.bankNameInput.value,
      refs.locationInput.value,
      refs.bankAccountInput.value,
      refs.openDateInput.value
    ].every((value) => String(value || '').trim() !== '') && currencyReady;
  });
}

function updateNewAccountGenerateAvailability() {
  const isComplete = isNewAccountFormComplete();
  elements.newAccountGenerateBtn.disabled = !isComplete;
}

function setExportAvailability({ detailEnabled = state.canExportDetail, balanceEnabled = state.canExportBalance }) {
  state.canExportDetail = detailEnabled;
  state.canExportBalance = balanceEnabled;
  // v1.5.3 R1 (T1.6)：月度余额模式下由 applyStatementModeSideEffects 统一控制按钮；此处不覆盖
  if (state.mode === STATEMENT_MODES.exportMonthlyBalance) {
    return;
  }
  elements.exportDetailBtn.disabled = !detailEnabled;
  elements.exportBalanceBtn.disabled = !balanceEnabled;
}

function setNewAccountExportAvailability(enabled = state.canExportNewAccount) {
  state.canExportNewAccount = enabled;
  elements.newAccountExportBtn.disabled = !enabled;
}

function setCurrentModule(moduleId, { persist = true } = {}) {
  const previousModuleId = state.currentModule;
  state.currentModule = moduleId;
  const moduleDef = Object.values(MODULES).find((m) => m.id === moduleId) || MODULES.statementGenerator;

  elements.currentModuleName.textContent = moduleDef.name;
  elements.statementModulePanel.hidden = moduleId !== MODULES.statementGenerator.id;
  elements.newAccountModulePanel.hidden = moduleId !== MODULES.newAccountGenerator.id;
  if (elements.pendingModulePanel) {
    elements.pendingModulePanel.hidden = moduleId !== MODULES.pendingReconciliation.id;
  }
  if (elements.bankStatementModulePanel) {
    elements.bankStatementModulePanel.hidden = moduleId !== MODULES.bankStatementProcess.id;
  }
  if (elements.preFundReconciliationModulePanel) {
    elements.preFundReconciliationModulePanel.hidden = moduleId !== MODULES.preFundReconciliation.id;
    if (moduleId === MODULES.preFundReconciliation.id
      && typeof refreshPreFundReconciliationStatus === 'function') {
      refreshPreFundReconciliationStatus().catch((error) => {
        console.warn('refreshPreFundReconciliationStatus failed:', error);
      });
    }
  }
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块面板隐藏控制
  if (elements.reconIdFixModulePanel) {
    elements.reconIdFixModulePanel.hidden = moduleId !== MODULES.reconIdFix.id;
  }
  // v2.1.2 T2：月度银行对账单BU回填校验模块面板隐藏控制
  if (elements.bankBuReconModulePanel) {
    elements.bankBuReconModulePanel.hidden = moduleId !== MODULES.bankBuRecon.id;
    if (moduleId === MODULES.bankBuRecon.id) {
      restoreBankBuReconPanelState();
    }
  }
  // v2.1.3：业务OP数据核对模块面板隐藏控制
  if (elements.bizOpReconModulePanel) {
    elements.bizOpReconModulePanel.hidden = moduleId !== MODULES.bizOpRecon.id;
    if (moduleId === MODULES.bizOpRecon.id) {
      restoreBizOpReconPanelState();
    }
  }
  // v2.1.6 Module B：收单单据币种校验模块面板隐藏控制
  if (elements.acquiringBillCurrencyModulePanel) {
    elements.acquiringBillCurrencyModulePanel.hidden = moduleId !== MODULES.acquiringBillCurrency.id;
    if (moduleId === MODULES.acquiringBillCurrency.id) {
      restoreAcquiringBillCurrencyPanelState();
    }
  }
  // v2.1.12 需求1：VCC业务OP计算模块面板隐藏控制
  if (elements.vccOpCalcModulePanel) {
    elements.vccOpCalcModulePanel.hidden = moduleId !== MODULES.vccOpCalc.id;
    if (moduleId === MODULES.vccOpCalc.id) {
      restoreVccOpCalcPanelState();
    }
  }

  Array.from(elements.moduleSwitcherMenu.querySelectorAll('.module-option')).forEach((button) => {
    button.classList.toggle('is-active', button.dataset.module === moduleId);
  });

  if (persist && previousModuleId !== moduleId) {
    window.desktopApi?.settings?.setCurrentModule?.(moduleId).catch((error) => {
      console.warn('persist currentModule failed:', error);
    });
  }

  // v2.0.0-beta.3 PR #32b：切到银行对账单处理模块时同步 session 状态
  if (moduleId === MODULES.bankStatementProcess.id && typeof refreshBankStatementStatus === 'function') {
    refreshBankStatementStatus().catch((error) => {
      console.warn('refreshBankStatementStatus failed:', error);
    });
  }
  // v2.1.0-beta.1 PR-A：切到单据对账 ReconID 修复模块时同步 session 状态 + reload 场景下拉
  // round 2 P2-1：reloadReconIdFixScenarios 内部已统一调 refreshReconIdFixStatus，无需重复触发
  // scenariosChanged: false → 模块切换路径不清 reconIdFixExport（用户跨模块切回应保留导出文案）
  if (moduleId === MODULES.reconIdFix.id) {
    if (typeof reloadReconIdFixScenarios === 'function') {
      reloadReconIdFixScenarios({ scenariosChanged: false }).catch((error) => {
        console.warn('reloadReconIdFixScenarios failed:', error);
      });
    }
  }
}

function openModuleMenu() {
  state.isModuleMenuOpen = true;
  elements.moduleSwitcherMenu.hidden = false;
  elements.moduleSwitcherBtn.setAttribute('aria-expanded', 'true');
}

function closeModuleMenu() {
  state.isModuleMenuOpen = false;
  elements.moduleSwitcherMenu.hidden = true;
  elements.moduleSwitcherBtn.setAttribute('aria-expanded', 'false');
}

// v2.1.4 T3：按 state.enabledModules 动态渲染左上角模块切换菜单
//   - 用户通过 🔄 收纳弹窗调整启用列表 / 顺序后，外部调用方负责再次触发本函数 re-render
//   - 触发点：initialize() / openModuleCabinetDialog 提交回调 / 顶部模块切换菜单项被新增/移除/重排时
function renderTopModuleSwitcher() {
  const menu = elements.moduleSwitcherMenu;
  if (!menu) return;
  const enabledIds = Array.isArray(state.enabledModules) && state.enabledModules.length > 0
    ? state.enabledModules
    : [MODULES.statementGenerator.id];  // 兜底（理论上 sanitize 不会让它为空）
  menu.innerHTML = '';
  enabledIds.forEach((id) => {
    const moduleDef = Object.values(MODULES).find((m) => m.id === id);
    if (!moduleDef) return;  // 防御：理论上 settings-repository 的 sanitize 已过滤非法 ID
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'module-option';
    if (id === state.currentModule) btn.classList.add('is-active');
    btn.dataset.module = id;
    btn.textContent = moduleDef.name;
    menu.appendChild(btn);
  });
}

function normalizeColorHex(colorHex) {
  const normalized = String(colorHex || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : DEFAULT_BACKGROUND_SETTINGS.colorHex;
}

function cloneBackgroundSettings(backgroundSettings = DEFAULT_BACKGROUND_SETTINGS) {
  return {
    colorHex: normalizeColorHex(backgroundSettings.colorHex),
    imageDataUrl: String(backgroundSettings.imageDataUrl || ''),
    filePath: String(backgroundSettings.filePath || ''),
    sourceFileName: String(backgroundSettings.sourceFileName || ''),
    sourcePath: String(backgroundSettings.sourcePath || '')
  };
}

function clampColorChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mixRgb(fromRgb, toRgb, ratio) {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  return {
    r: clampColorChannel(fromRgb.r + (toRgb.r - fromRgb.r) * safeRatio),
    g: clampColorChannel(fromRgb.g + (toRgb.g - fromRgb.g) * safeRatio),
    b: clampColorChannel(fromRgb.b + (toRgb.b - fromRgb.b) * safeRatio)
  };
}

function hexToRgb(colorHex) {
  const normalized = normalizeColorHex(colorHex);
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16)
  };
}

function mixColor(fromHex, toHex, ratio) {
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);
  return mixRgb(from, to, ratio);
}

function rgbToCss(rgb, alpha) {
  if (alpha === undefined) {
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  }

  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function rgbToHex(rgb) {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) => clampColorChannel(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, saturation));
  const l = Math.max(0, Math.min(1, lightness));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h / 60;
  const second = chroma * (1 - Math.abs((segment % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;

  if (segment >= 0 && segment < 1) {
    red = chroma;
    green = second;
  } else if (segment < 2) {
    red = second;
    green = chroma;
  } else if (segment < 3) {
    green = chroma;
    blue = second;
  } else if (segment < 4) {
    green = second;
    blue = chroma;
  } else if (segment < 5) {
    red = second;
    blue = chroma;
  } else {
    red = chroma;
    blue = second;
  }

  const match = l - chroma / 2;

  return {
    r: clampColorChannel((red + match) * 255),
    g: clampColorChannel((green + match) * 255),
    b: clampColorChannel((blue + match) * 255)
  };
}

function getSpectrumColorAtPosition(x, y, width, height) {
  const safeWidth = Math.max(width - 1, 1);
  const safeHeight = Math.max(height - 1, 1);
  const hue = (x / safeWidth) * 360;
  const baseColor = hslToRgb(hue, 1, 0.5);
  const middleY = safeHeight / 2;

  if (y <= middleY) {
    return mixRgb({ r: 255, g: 255, b: 255 }, baseColor, y / Math.max(middleY, 1));
  }

  return mixRgb(
    baseColor,
    { r: 0, g: 0, b: 0 },
    (y - middleY) / Math.max(safeHeight - middleY, 1)
  );
}

function drawBackgroundSpectrum() {
  const canvas = elements.backgroundSpectrumCanvas;
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = context.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgb = getSpectrumColorAtPosition(x, y, width, height);
      const offset = (y * width + x) * 4;

      imageData.data[offset] = rgb.r;
      imageData.data[offset + 1] = rgb.g;
      imageData.data[offset + 2] = rgb.b;
      imageData.data[offset + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function updateSelectedColorSwatch(colorHex = DEFAULT_SPECTRUM_PICK_COLOR) {
  elements.backgroundSelectedColorSwatch.style.background = normalizeColorHex(colorHex);
}

function resetBackgroundPickerSelection() {
  state.backgroundPicker = {
    hasSelection: false,
    x: 0,
    y: 0,
    colorHex: DEFAULT_SPECTRUM_PICK_COLOR
  };
  elements.backgroundSpectrumCrosshair.hidden = true;
  updateSelectedColorSwatch(DEFAULT_SPECTRUM_PICK_COLOR);
}

function setBackgroundSpectrumSelection(x, y, colorHex) {
  state.backgroundPicker = {
    hasSelection: true,
    x,
    y,
    colorHex
  };
  elements.backgroundSpectrumCrosshair.hidden = false;
  elements.backgroundSpectrumCrosshair.style.left = `${x}px`;
  elements.backgroundSpectrumCrosshair.style.top = `${y}px`;
  updateSelectedColorSwatch(colorHex);
}

function pickBackgroundColorFromClientPoint(clientX, clientY) {
  const rect = elements.backgroundSpectrumArea.getBoundingClientRect();

  if (!rect.width || !rect.height) {
    return;
  }

  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
  const canvasX = Math.round((x / rect.width) * (elements.backgroundSpectrumCanvas.width - 1));
  const canvasY = Math.round((y / rect.height) * (elements.backgroundSpectrumCanvas.height - 1));
  const colorHex = rgbToHex(
    getSpectrumColorAtPosition(
      canvasX,
      canvasY,
      elements.backgroundSpectrumCanvas.width,
      elements.backgroundSpectrumCanvas.height
    )
  );

  setBackgroundSpectrumSelection(x, y, colorHex);
  state.backgroundDraft.colorHex = colorHex;
  applyBackgroundSettings(state.backgroundDraft);
}

function buildBackgroundStyle(backgroundSettings) {
  const normalized = cloneBackgroundSettings(backgroundSettings);
  const baseColor = hexToRgb(normalized.colorHex);

  if (normalized.imageDataUrl) {
    return {
      backgroundColor: rgbToCss(mixColor(normalized.colorHex, '#fff8ec', 0.3)),
      backgroundImage: [
        'radial-gradient(circle at top left, rgba(255, 255, 255, 0.72), transparent 30%)',
        `radial-gradient(circle at bottom right, ${rgbToCss(baseColor, 0.24)} 0%, transparent 34%)`,
        `linear-gradient(180deg, ${rgbToCss(baseColor, 0.18)} 0%, ${rgbToCss(baseColor, 0.3)} 100%)`,
        `url("${normalized.imageDataUrl}")`
      ].join(', '),
      backgroundSize: 'auto, auto, auto, cover',
      backgroundPosition: 'center, center, center, center',
      backgroundRepeat: 'no-repeat, no-repeat, no-repeat, no-repeat'
    };
  }

  return {
    backgroundColor: rgbToCss(mixColor(normalized.colorHex, '#ffffff', 0.66)),
    backgroundImage: [
      'radial-gradient(circle at top left, rgba(255, 255, 255, 0.75), transparent 30%)',
      `radial-gradient(circle at bottom right, ${rgbToCss(baseColor, 0.18)} 0%, transparent 30%)`,
      `linear-gradient(160deg, ${rgbToCss(mixColor(normalized.colorHex, '#ffffff', 0.56))} 0%, ${rgbToCss(baseColor)} 48%, ${rgbToCss(mixColor(normalized.colorHex, '#fffaf2', 0.74))} 100%)`
    ].join(', '),
    backgroundSize: 'auto, auto, auto',
    backgroundPosition: 'center, center, center',
    backgroundRepeat: 'no-repeat, no-repeat, no-repeat'
  };
}

function updateBackgroundControls(backgroundSettings) {
  const normalized = cloneBackgroundSettings(backgroundSettings);
  const triggerFill = normalized.imageDataUrl
    ? `linear-gradient(135deg, ${rgbToCss(hexToRgb(normalized.colorHex), 0.72)} 0%, rgba(255, 255, 255, 0.92) 100%)`
    : normalized.colorHex;
  const importTitle = normalized.sourceFileName
    ? `${BACKGROUND_FILE_HINT}\n当前背景：${normalized.sourceFileName}`
    : BACKGROUND_FILE_HINT;

  elements.backgroundPaletteBtn.style.setProperty('--palette-trigger-fill', triggerFill);
  elements.backgroundImportBtn.title = importTitle;
}

function applyBackgroundSettings(backgroundSettings) {
  const normalized = cloneBackgroundSettings(backgroundSettings);
  const style = buildBackgroundStyle(normalized);

  elements.appShell.style.backgroundColor = style.backgroundColor;
  elements.appShell.style.backgroundImage = style.backgroundImage;
  elements.appShell.style.backgroundSize = style.backgroundSize;
  elements.appShell.style.backgroundPosition = style.backgroundPosition;
  elements.appShell.style.backgroundRepeat = style.backgroundRepeat;
  document.body.style.background = rgbToCss(mixColor(normalized.colorHex, '#ffffff', 0.74));
  updateBackgroundControls(normalized);
}

function openBackgroundPalette() {
  state.backgroundDraft = cloneBackgroundSettings(state.backgroundSettings);
  state.isBackgroundPaletteOpen = true;
  elements.backgroundPalettePanel.hidden = false;
  elements.backgroundPaletteBtn.classList.add('is-active');
  resetBackgroundPickerSelection();
  applyBackgroundSettings(state.backgroundDraft);
}

function closeBackgroundPalette({ revert = true } = {}) {
  if (!state.isBackgroundPaletteOpen) {
    return;
  }

  state.isBackgroundPaletteOpen = false;
  elements.backgroundPalettePanel.hidden = true;
  elements.backgroundPaletteBtn.classList.remove('is-active');
  state.isBackgroundSpectrumDragging = false;
  resetBackgroundPickerSelection();

  if (revert) {
    state.backgroundDraft = cloneBackgroundSettings(state.backgroundSettings);
    applyBackgroundSettings(state.backgroundSettings);
    return;
  }

  state.backgroundDraft = cloneBackgroundSettings(state.backgroundSettings);
}

async function handleBackgroundImportFile() {
  const result = await window.desktopApi.background.selectFile();

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status !== 'success') {
    setStatus(result.message, 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
    openModal(createAlertDialog(result.message));
    return;
  }

  state.backgroundDraft = cloneBackgroundSettings({
    ...state.backgroundDraft,
    imageDataUrl: result.background.imageDataUrl,
    filePath: '',
    sourceFileName: result.background.sourceFileName,
    sourcePath: result.background.sourcePath
  });

  applyBackgroundSettings(state.backgroundDraft);
  setStatus(`已选择背景文件：${result.background.sourceFileName}`, 'success');
}

async function handleBackgroundSave() {
  const result = await window.desktopApi.background.save({
    colorHex: state.backgroundDraft.colorHex,
    imageSourcePath: state.backgroundDraft.sourcePath,
    keepExistingImage: !state.backgroundDraft.sourcePath && Boolean(state.backgroundDraft.filePath)
  });

  if (result.status !== 'success') {
    setStatus(result.message, 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
    openModal(createAlertDialog(result.message));
    return;
  }

  state.backgroundSettings = cloneBackgroundSettings(result.backgroundConfig);
  applyBackgroundSettings(state.backgroundSettings);
  closeBackgroundPalette({ revert: false });
  setStatus(result.message, 'success');
}

function handleBackgroundReset() {
  openModal(
    createConfirmDialog({
      message: '确认恢复默认背景？当前自定义颜色和背景图会被清除。',
      confirmText: '确认重置',
      cancelText: '取消',
      onConfirm: async () => {
        const result = await window.desktopApi.background.reset();

        closeModal();

        if (result.status !== 'success') {
          setStatus(result.message, 'error', {
            errorReportReady: Boolean(result.errorReportReady)
          });
          openModal(createAlertDialog(result.message));
          return;
        }

        state.backgroundSettings = cloneBackgroundSettings(result.backgroundConfig);
        applyBackgroundSettings(state.backgroundSettings);
        closeBackgroundPalette({ revert: false });
        setStatus(result.message, 'success');
      }
    })
  );
}

function legacyCloseModal() {
  elements.modalRoot.innerHTML = '';
}

function legacyOpenModal(modalElement) {
  elements.modalRoot.innerHTML = '';
  elements.modalRoot.appendChild(modalElement);
}

function legacyCreateOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  return overlay;
}

function legacyCreateAlertDialog(message, options = {}) {
  const { onConfirm = null } = options;
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card alert-card';
  dialog.innerHTML = `
    <div class="alert-message">${message}</div>
    <div class="dialog-actions center">
      <button class="primary-btn small" type="button">确认</button>
    </div>
  `;
  dialog.querySelector('button').addEventListener('click', () => {
    closeModal();
    onConfirm?.();
  });
  overlay.appendChild(dialog);
  return overlay;
}

function legacyCreateConfirmDialog({ message, confirmText, cancelText, onConfirm }) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card alert-card';
  dialog.innerHTML = `
    <div class="alert-message">${message}</div>
    <div class="dialog-actions center">
      <button class="danger-btn small" type="button" data-action="confirm">${confirmText}</button>
      <button class="secondary-btn small" type="button" data-action="cancel">${cancelText}</button>
    </div>
  `;
  dialog.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
    await onConfirm();
  });
  dialog.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
  overlay.appendChild(dialog);
  return overlay;
}

function legacyCreateExportScopeDialog(kind) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  const fieldLabel = kind === 'detail' ? '明细' : '余额';
  dialog.className = 'modal-card alert-card export-scope-card';
  dialog.innerHTML = `
    <div class="alert-message">请选择要导出的范围</div>
    <div class="dialog-actions vertical">
      <button class="secondary-btn small export-scope-btn" type="button" data-scope="current">导出当前批次文件的${fieldLabel}</button>
      <button class="secondary-btn small export-scope-btn" type="button" data-scope="all">导出所有批次文件的${fieldLabel}</button>
    </div>
  `;

  async function runExport(scope) {
    closeModal();
    const result = kind === 'detail'
      ? await window.desktopApi.files.exportDetail(scope)
      : await window.desktopApi.files.exportBalance(scope);

    if (result.status === 'cancelled') {
      return;
    }

    if (result.status === 'select-export-scope') {
      openModal(createExportScopeDialog(kind));
      return;
    }

    if (kind === 'balance' && (result.manualBalancePromptReady || result.status === 'manual-balance-required')) {
      applyManualBalancePromptStatus(result);
      return;
    }

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
  }

  dialog.querySelector('[data-scope="current"]').addEventListener('click', () => {
    runExport('current').catch((error) => {
      console.error(error);
      setStatus(`导出${fieldLabel}账单失败，请查看控制台`, 'error');
    });
  });
  dialog.querySelector('[data-scope="all"]').addEventListener('click', () => {
    runExport('all').catch((error) => {
      console.error(error);
      setStatus(`导出${fieldLabel}账单失败，请查看控制台`, 'error');
    });
  });
  overlay.appendChild(dialog);
  return overlay;
}

function legacyCreateManualBalanceSeedDialog(prompt, draft = {}) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manual-balance-card';
  const queueIndex = Number.isInteger(prompt?.queueIndex) && prompt.queueIndex > 0 ? prompt.queueIndex : 1;
  const queueTotal = Number.isInteger(prompt?.queueTotal) && prompt.queueTotal > 0 ? prompt.queueTotal : 1;
  const merchantId = prompt?.merchantId || 'N/A';
  const currency = prompt?.currency || '(空)';
  const targetBillDate = prompt?.targetBillDate || 'N/A';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">补录上一账单日余额</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="manual-balance-context">
      <div class="manual-balance-progress">第 ${queueIndex} 个，共 ${queueTotal} 个</div>
      <div class="manual-balance-context-grid">
        <div class="manual-balance-context-row">
          <span class="manual-balance-context-label">银行账号</span>
          <span class="manual-balance-context-value manual-balance-context-account" title="${escapeHtml(merchantId)}">${escapeHtml(merchantId)}</span>
        </div>
        <div class="manual-balance-context-row">
          <span class="manual-balance-context-label">币种</span>
          <span class="manual-balance-context-tag" title="${escapeHtml(currency)}">${escapeHtml(currency)}</span>
        </div>
        <div class="manual-balance-context-row">
          <span class="manual-balance-context-label">当前账单日期</span>
          <span class="manual-balance-context-value" title="${escapeHtml(targetBillDate)}">${escapeHtml(targetBillDate)}</span>
        </div>
      </div>
    </div>
    <div class="manual-balance-form">
      <label class="manual-balance-row">
        <span class="manual-balance-label">请选择上一账单日日期</span>
        <input class="mapping-text-input manual-balance-input manual-balance-date-input" type="text" value="" />
      </label>
      <label class="manual-balance-row">
        <span class="manual-balance-label">请输入上一账单日余额</span>
        <input class="mapping-text-input manual-balance-input manual-balance-amount-input" type="text" spellcheck="false" value="" />
      </label>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const dateInput = dialog.querySelector('.manual-balance-date-input');
  const amountInput = dialog.querySelector('.manual-balance-amount-input');
  dateInput.value = draft.billDate || '';
  dateInput.type = dateInput.value ? 'date' : 'text';
  amountInput.value = draft.endBalance || '';

  dateInput.addEventListener('focus', () => {
    if (dateInput.type !== 'date') {
      dateInput.type = 'date';
    }

    dateInput.showPicker?.();
  });
  dateInput.addEventListener('blur', () => {
    if (!dateInput.value) {
      dateInput.type = 'text';
    }
  });
  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const payload = {
      billDate: dateInput.value,
      endBalance: amountInput.value
    };
    const result = await window.desktopApi.files.saveBalanceSeed(payload);

    if (result.status === 'confirm-overwrite') {
      openModal(
        createConfirmDialog({
          message: '该日期的余额已存在，确认覆盖吗？',
          confirmText: '确认覆盖',
          cancelText: '取消',
          onConfirm: async () => {
            const overwriteResult = await window.desktopApi.files.saveBalanceSeed({
              ...payload,
              overwrite: true
            });
            closeModal();
            applyStatementResult(overwriteResult);
          }
        })
      );
      return;
    }

    closeModal();
    applyStatementResult(result);

    if (result.status === 'error' && !result.manualBalancePromptReady) {
      openModal(createAlertDialog(result.message));
    }
  });

  overlay.appendChild(dialog);
  return overlay;
}

function legacyEscapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// v1.5.3 R1 (T1.5)：主页面下拉改为"模式"（create-statement / export-monthly-balance）；
// "制作网银账单"模式内部 selectedTemplateId 固定为 __FILENAME_MAPPING__（用户不可见不可选，继承 v1.5.2 默认行为）；
// 具体模板不再出现在主页面下拉里，只在 R1 月度余额弹窗里选择。
// 函数名保留 updateTemplateSelect，只初始化/同步下拉选中值 + 按模式刷新按钮态；不再遍历 state.templates。
function updateTemplateSelect() {
  // HTML 已静态声明两个 option（见 index.html），这里只负责同步 selectedIndex 到 state.mode
  if (elements.templateSelect.value !== state.mode) {
    elements.templateSelect.value = state.mode;
  }

  // 制作网银账单模式下 selectedTemplateId 永远是虚拟 ID（继承 v1.5.2）
  if (state.mode === STATEMENT_MODES.createStatement) {
    state.selectedTemplateId = FILENAME_MAPPING_TEMPLATE_ID;
  }

  applyStatementModeSideEffects();
}

// v1.5.3 R1 (T1.6)：按模式设置按钮可用性矩阵（PRD §5.1.1）
// create-statement      → 按原 v1.5.2 规则（ canExportDetail / canExportBalance 控制）
// export-monthly-balance → 禁用 导入文件/导出明细/账户映射；导出余额始终可用（点击后走装配或另存为）
//                          导入模板/模板管理两模式都可用
function applyStatementModeSideEffects() {
  const isMonthly = state.mode === STATEMENT_MODES.exportMonthlyBalance;

  // 两模式都可用的按钮：importTemplateBtn / manageTemplateBtn（无需改动 disabled）
  // 月度余额模式禁用：导入文件 / 导出明细 / 账户映射
  if (elements.importFileBtn) {
    elements.importFileBtn.disabled = isMonthly;
  }
  if (elements.accountMappingBtn) {
    elements.accountMappingBtn.disabled = isMonthly;
  }

  if (isMonthly) {
    // 月度余额模式：导出明细一律禁用；导出余额始终可点（装配/另存为走弹窗链路）
    if (elements.exportDetailBtn) {
      elements.exportDetailBtn.disabled = true;
    }
    if (elements.exportBalanceBtn) {
      elements.exportBalanceBtn.disabled = false;
    }
    // 注：不清 state.canExportDetail / canExportBalance（PRD §1.7 P1-1：切回 statement 模式要恢复原状态）
  } else {
    // 制作网银账单模式：按 state.canExport* 恢复
    if (elements.exportDetailBtn) {
      elements.exportDetailBtn.disabled = !state.canExportDetail;
    }
    if (elements.exportBalanceBtn) {
      elements.exportBalanceBtn.disabled = !state.canExportBalance;
    }
  }
}

async function refreshTemplates() {
  state.templates = await window.desktopApi.templates.list();
  updateTemplateSelect();
}

function legacyCloneBigAccountItems(bigAccounts = []) {
  return bigAccounts.map((item) => ({
    merchantId: String(item.merchantId || ''),
    currencies: Array.isArray(item.currencies) ? item.currencies.slice() : [],
    isMultiCurrency: Boolean(item.isMultiCurrency)
  }));
}

function legacyFormatBigAccountCurrencySummary(currencies) {
  const uniqueCurrencies = Array.from(new Set((currencies || []).filter((value) => value)));

  if (!uniqueCurrencies.length) {
    return '';
  }

  if (uniqueCurrencies.length === 1) {
    return uniqueCurrencies[0];
  }

  if (uniqueCurrencies.length <= 3) {
    return uniqueCurrencies.join('、');
  }

  return `${uniqueCurrencies.length}个币种`;
}

function legacyGetBigAccountCurrencyTitle(currencies) {
  return Array.from(new Set((currencies || []).filter((value) => value))).join('、');
}

function legacyCollectMappingDraftFromTable(tableBody) {
  return Array.from(tableBody.querySelectorAll('tr[data-template-field]')).map((row) => {
    const select = row.querySelector('.mapping-select');
    const customInput = row.querySelector('.mapping-custom-input');
    const bigAccountToggle = row.querySelector('.mapping-big-account-toggle');

    return {
      templateField: row.dataset.templateField,
      mappedField: select ? select.value : '',
      customValue: customInput ? customInput.value : '',
      isMultiBigAccount: bigAccountToggle ? bigAccountToggle.checked : false
    };
  });
}

function legacyCreateTemplateRenameDialog(template) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manual-balance-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">重命名模板</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="manual-balance-form">
      <label class="manual-balance-row">
        <span class="manual-balance-label">当前模板名称</span>
        <input class="mapping-text-input manual-balance-input" type="text" value="${escapeHtml(template.name)}" disabled />
      </label>
      <label class="manual-balance-row">
        <span class="manual-balance-label">新模板名称</span>
        <input class="mapping-text-input manual-balance-input rename-template-input" type="text" spellcheck="false" value="${escapeHtml(template.name)}" />
      </label>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const input = dialog.querySelector('.rename-template-input');
  dialog.querySelector('.icon-close').addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });
  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const result = await window.desktopApi.templates.rename({
      templateId: template.id,
      name: input.value
    });

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status === 'success') {
      await refreshTemplates();
      openModal(createTemplateManagerDialog());
      return;
    }

    openModal(createAlertDialog(result.message));
  });

  overlay.appendChild(dialog);
  return overlay;
}

function legacyCreateBigAccountSelectionDialog(options) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manual-balance-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">请选择本次使用的大账号 / 币种</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="big-account-selection-list"></div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const list = dialog.querySelector('.big-account-selection-list');
  const radioName = `big-account-selection-${Date.now()}`;

  options.forEach((option, index) => {
    const label = document.createElement('label');
    label.className = 'big-account-selection-item';
    label.innerHTML = `
      <input class="new-account-checkbox" type="radio" name="${radioName}" value="${index}" />
      <span>${escapeHtml(option.label)}</span>
    `;
    list.appendChild(label);
  });

  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const checked = list.querySelector(`input[name="${radioName}"]:checked`);

    if (!checked) {
      setStatus('请选择本次使用的大账号 / 币种', 'error');
      return;
    }

    const selectedOption = options[Number(checked.value)];
    const result = await window.desktopApi.files.completeBigAccountSelection({
      merchantId: selectedOption.merchantId,
      currency: selectedOption.currency
    });

    closeModal();
    applyStatementResult(result);

    if (result.status === 'error' && !result.manualBalancePromptReady) {
      openModal(createAlertDialog(result.message));
    }
  });

  overlay.appendChild(dialog);
  return overlay;
}

function legacyCreateBigAccountManagerDialog({ bigAccounts, onDone, onCancel }) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manager-card big-account-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">维护大账号</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>大账号</th>
            <th>币种</th>
            <th class="manager-action-header"><span class="manager-action-header-label">执行操作</span></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="dialog-actions split big-account-footer-actions">
      <button class="secondary-btn small" type="button" data-action="add">新增</button>
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const tbody = dialog.querySelector('tbody');
  const tableWrapper = dialog.querySelector('.table-wrapper');
  const floatingPanel = document.createElement('div');
  floatingPanel.className = 'new-account-currency-dropdown-panel big-account-currency-floating-panel';
  floatingPanel.hidden = true;
  const currencySelectOptions = [
    '<option value=""></option>',
    ...state.currencyOptions.map((currencyCode) => `<option value="${escapeHtml(currencyCode)}">${escapeHtml(currencyCode)}</option>`)
  ].join('');
  let activeFloatingDropdown = null;

  function cleanupFloatingDropdown() {
    if (activeFloatingDropdown?.button) {
      activeFloatingDropdown.button.classList.remove('is-open');
      activeFloatingDropdown.button.setAttribute('aria-expanded', 'false');
    }

    activeFloatingDropdown = null;
    floatingPanel.hidden = true;
    floatingPanel.replaceChildren();
  }

  function updateCurrencyDropdownLabel(button, currencies) {
    const selectedCurrencies = Array.from(new Set((currencies || []).filter((value) => value)));
    button.textContent = formatBigAccountCurrencySummary(selectedCurrencies) || '\u00A0';
    button.title = getBigAccountCurrencyTitle(selectedCurrencies);
    button.disabled = state.currencyOptions.length === 0;
  }

  function renderCurrencyDropdownOptions(selectedCurrencies, onChange) {
    floatingPanel.replaceChildren();
    if (!state.currencyOptions.length) {
      const emptyState = document.createElement('div');
      emptyState.className = 'new-account-currency-option';
      emptyState.innerHTML = '<span class="new-account-currency-option-text">未读取到币种选项</span>';
      floatingPanel.appendChild(emptyState);
      return;
    }

    state.currencyOptions.forEach((currencyCode) => {
      const option = document.createElement('label');
      option.className = 'new-account-currency-option';

      const text = document.createElement('span');
      text.className = 'new-account-currency-option-text';
      text.textContent = currencyCode;

      const checkbox = document.createElement('input');
      checkbox.className = 'new-account-checkbox';
      checkbox.type = 'checkbox';
      checkbox.value = currencyCode;
      checkbox.checked = selectedCurrencies.includes(currencyCode);
      checkbox.addEventListener('change', () => {
        onChange(
          Array.from(floatingPanel.querySelectorAll('input[type="checkbox"]:checked')).map((selectedCheckbox) => selectedCheckbox.value)
        );
      });

      option.append(text, checkbox);
      floatingPanel.appendChild(option);
    });
  }

  function positionFloatingDropdown(button) {
    const buttonRect = button.getBoundingClientRect();
    const margin = 12;
    const availableWidth = Math.max(220, Math.min(260, window.innerWidth - margin * 2));

    floatingPanel.style.position = 'fixed';
    floatingPanel.style.minWidth = `${Math.max(buttonRect.width, 188)}px`;
    floatingPanel.style.maxWidth = `${availableWidth}px`;
    floatingPanel.style.visibility = 'hidden';
    floatingPanel.hidden = false;

    const panelWidth = floatingPanel.offsetWidth || Math.max(buttonRect.width, 188);
    const panelHeight = floatingPanel.offsetHeight || 216;
    const left = Math.min(
      Math.max(margin, buttonRect.left),
      Math.max(margin, window.innerWidth - panelWidth - margin)
    );
    const top = buttonRect.bottom + 6 + panelHeight > window.innerHeight - margin
      ? Math.max(margin, buttonRect.top - panelHeight - 6)
      : buttonRect.bottom + 6;

    floatingPanel.style.left = `${left}px`;
    floatingPanel.style.top = `${top}px`;
    floatingPanel.style.visibility = 'visible';
  }

  function openFloatingDropdown({ button, selectedCurrencies, onChange }) {
    const sameButton = activeFloatingDropdown?.button === button;
    cleanupFloatingDropdown();

    if (sameButton) {
      return;
    }

    renderCurrencyDropdownOptions(selectedCurrencies, onChange);
    activeFloatingDropdown = { button };
    button.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    positionFloatingDropdown(button);
  }

  function createBigAccountRow(item = {}, initialMode = 'view') {
    const row = document.createElement('tr');
    row.dataset.bigAccountRow = 'true';
    row.dataset.mode = initialMode;
    row.innerHTML = `
      <td>
        <input class="mapping-text-input big-account-merchant-input" type="text" spellcheck="false" value="${escapeHtml(item.merchantId || '')}" />
        <span class="big-account-view-text big-account-merchant-view" hidden></span>
      </td>
      <td>
        <div class="big-account-currency-editor">
          <select class="mapping-select big-account-currency-select">${currencySelectOptions}</select>
          <div class="new-account-currency-dropdown-wrap big-account-currency-dropdown-wrap" hidden>
            <button class="new-account-input new-account-currency-dropdown-btn big-account-currency-dropdown-btn" type="button" aria-expanded="false"></button>
          </div>
          <label class="new-account-checkbox-label big-account-multi-label">
            <input class="new-account-checkbox big-account-multi-checkbox" type="checkbox" />
            <span>多币种</span>
          </label>
        </div>
        <span class="big-account-view-text big-account-currency-view" hidden></span>
      </td>
      <td class="manager-action-cell big-account-action-cell">
        <div class="big-account-row-actions">
          <button class="text-action" type="button" data-action="toggle-complete"></button>
          <button class="text-action danger" type="button" data-action="delete">删除</button>
        </div>
      </td>
    `;

    const merchantInput = row.querySelector('.big-account-merchant-input');
    const merchantView = row.querySelector('.big-account-merchant-view');
    const select = row.querySelector('.big-account-currency-select');
    const dropdownWrap = row.querySelector('.big-account-currency-dropdown-wrap');
    const dropdownButton = row.querySelector('.big-account-currency-dropdown-btn');
    const multiCheckbox = row.querySelector('.big-account-multi-checkbox');
    const currencyEditor = row.querySelector('.big-account-currency-editor');
    const currencyView = row.querySelector('.big-account-currency-view');
    const toggleCompleteBtn = row.querySelector('[data-action="toggle-complete"]');
    let selectedCurrencies = Array.isArray(item.currencies) ? item.currencies.slice() : [];

    multiCheckbox.checked = Boolean(item.isMultiCurrency);
    if (!multiCheckbox.checked) {
      select.value = selectedCurrencies[0] || '';
    }

    function getRowDraft() {
      return {
        merchantId: merchantInput.value.trim(),
        isMultiCurrency: multiCheckbox.checked,
        currencies: multiCheckbox.checked
          ? Array.from(new Set(selectedCurrencies.filter((value) => value)))
          : [select.value].filter((value) => value !== '')
      };
    }

    function validateRowDraft() {
      const draft = getRowDraft();

      if (!draft.merchantId) {
        return '请填写大账号';
      }

      if (!draft.currencies.length) {
        return '请选择币种';
      }

      return '';
    }

    function syncCurrencyMode() {
      const isMultiCurrency = multiCheckbox.checked;
      select.hidden = isMultiCurrency;
      dropdownWrap.hidden = !isMultiCurrency;

      if (!isMultiCurrency) {
        if (activeFloatingDropdown?.button === dropdownButton) {
          cleanupFloatingDropdown();
        }
        return;
      }

      updateCurrencyDropdownLabel(dropdownButton, selectedCurrencies);
    }

    dropdownButton.addEventListener('click', () => {
      if (dropdownWrap.hidden) {
        return;
      }

      openFloatingDropdown({
        button: dropdownButton,
        selectedCurrencies,
        onChange: (nextSelectedCurrencies) => {
          selectedCurrencies = nextSelectedCurrencies;
          updateCurrencyDropdownLabel(dropdownButton, selectedCurrencies);
        }
      });
    });
    multiCheckbox.addEventListener('change', syncCurrencyMode);
    select.addEventListener('change', () => {
      if (row.dataset.mode === 'view') {
        return;
      }

      currencyView.textContent = select.value;
      currencyView.title = select.value;
    });
    merchantInput.addEventListener('input', () => {
      if (row.dataset.mode === 'view') {
        return;
      }

      merchantView.textContent = merchantInput.value.trim();
      merchantView.title = merchantInput.value.trim();
    });
    toggleCompleteBtn.addEventListener('click', () => {
      if (row.dataset.mode === 'edit') {
        const validationMessage = validateRowDraft();

        if (validationMessage) {
          setStatus(validationMessage, 'error');
          return;
        }

        const draft = getRowDraft();
        merchantView.textContent = draft.merchantId;
        merchantView.title = draft.merchantId;
        currencyView.textContent = formatBigAccountCurrencySummary(draft.currencies);
        currencyView.title = getBigAccountCurrencyTitle(draft.currencies);
        merchantInput.hidden = true;
        currencyEditor.hidden = true;
        merchantView.hidden = false;
        currencyView.hidden = false;
        row.dataset.mode = 'view';
        toggleCompleteBtn.textContent = '修改';
        if (activeFloatingDropdown?.button === dropdownButton) {
          cleanupFloatingDropdown();
        }
        return;
      }

      row.dataset.mode = 'edit';
      merchantInput.hidden = false;
      currencyEditor.hidden = false;
      merchantView.hidden = true;
      currencyView.hidden = true;
      toggleCompleteBtn.textContent = '完成';
      syncCurrencyMode();
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (activeFloatingDropdown?.button === dropdownButton) {
        cleanupFloatingDropdown();
      }
      row.remove();
    });

    syncCurrencyMode();

    if (initialMode === 'view') {
      const initialDraft = getRowDraft();
      merchantView.textContent = initialDraft.merchantId;
      merchantView.title = initialDraft.merchantId;
      currencyView.textContent = formatBigAccountCurrencySummary(initialDraft.currencies);
      currencyView.title = getBigAccountCurrencyTitle(initialDraft.currencies);
      merchantInput.hidden = true;
      currencyEditor.hidden = true;
      merchantView.hidden = false;
      currencyView.hidden = false;
      toggleCompleteBtn.textContent = '修改';
    } else {
      merchantInput.hidden = false;
      currencyEditor.hidden = false;
      merchantView.hidden = true;
      currencyView.hidden = true;
      toggleCompleteBtn.textContent = '完成';
    }

    return row;
  }

  const initialBigAccounts = bigAccounts.length
    ? bigAccounts
    : [{ merchantId: '', currencies: [], isMultiCurrency: false }];
  initialBigAccounts.forEach((item) => {
    tbody.appendChild(createBigAccountRow(item, bigAccounts.length ? 'view' : 'edit'));
  });

  const handleKeydown = (event) => {
    if (event.key === 'Escape' && !floatingPanel.hidden) {
      cleanupFloatingDropdown();
    }
  };

  document.addEventListener('keydown', handleKeydown);
  overlay.addEventListener('mousedown', (event) => {
    if (
      activeFloatingDropdown &&
      !floatingPanel.contains(event.target) &&
      !activeFloatingDropdown.button.contains(event.target)
    ) {
      cleanupFloatingDropdown();
    }
  });
  tableWrapper.addEventListener('scroll', cleanupFloatingDropdown);

  function cleanupAndCancel() {
    cleanupFloatingDropdown();
    document.removeEventListener('keydown', handleKeydown);
    onCancel();
  }

  dialog.querySelector('.icon-close').addEventListener('click', cleanupAndCancel);
  dialog.querySelector('[data-action="add"]').addEventListener('click', () => {
    cleanupFloatingDropdown();
    tbody.appendChild(createBigAccountRow({}, 'edit'));
  });
  dialog.querySelector('[data-action="done"]').addEventListener('click', () => {
    const rows = Array.from(tbody.querySelectorAll('tr[data-big-account-row]'));

    if (rows.some((row) => row.dataset.mode === 'edit')) {
      setStatus('请先完成或删除当前编辑行', 'error');
      return;
    }

    const nextBigAccounts = rows.map((row) => {
      const merchantId = row.querySelector('.big-account-merchant-input').value.trim();
      const isMultiCurrency = row.querySelector('.big-account-multi-checkbox').checked;
      const currencies = isMultiCurrency
        ? Array.from(new Set(row.querySelector('.big-account-currency-view').title.split('、').filter((value) => value)))
        : [row.querySelector('.big-account-currency-select').value].filter((value) => value !== '');

      return {
        merchantId,
        currencies,
        isMultiCurrency
      };
    }).filter((item) => item.merchantId !== '' && item.currencies.length > 0);

    cleanupFloatingDropdown();
    document.removeEventListener('keydown', handleKeydown);
    onDone(nextBigAccounts);
  });

  overlay.appendChild(dialog);
  overlay.appendChild(floatingPanel);
  return overlay;
}

function legacyRenderTemplateTableRows(tableBody) {
  tableBody.innerHTML = '';

  if (!state.templates.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td class="empty-cell">暂无模板</td>
      <td class="empty-cell">-</td>
      <td class="empty-cell">-</td>
    `;
    tableBody.appendChild(emptyRow);
    return;
  }

  state.templates.forEach((template) => {
    const bigAccountSummary = template.bigAccountSummary || '未设置';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${template.name}</td>
      <td class="manager-big-account-cell">
        <span class="manager-big-account-summary" title="${escapeHtml(bigAccountSummary)}">${escapeHtml(bigAccountSummary)}</span>
      </td>
      <td class="manager-action-cell">
        <div class="manager-row-actions">
          <button class="text-action" type="button" data-action="manage">修改</button>
          <button class="text-action" type="button" data-action="rename">重命名</button>
          <button class="text-action danger" type="button" data-action="delete">删除</button>
        </div>
      </td>
    `;

    row.querySelector('[data-action="manage"]').addEventListener('click', async () => {
      const result = await window.desktopApi.templates.getMappings(template.id);

      if (result.status !== 'success') {
        setStatus(result.message, 'error', {
          errorReportReady: Boolean(result.errorReportReady)
        });
        openModal(createAlertDialog(result.message));
        return;
      }

      openModal(createMappingDialog(result));
    });
    row.querySelector('[data-action="rename"]').addEventListener('click', () => {
      openModal(createTemplateRenameDialog(template));
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => {
      openModal(
        createConfirmDialog({
          message: '确认删除',
          confirmText: '确认删除',
          cancelText: '否',
          onConfirm: async () => {
            await window.desktopApi.templates.deleteTemplate(template.id);
            await refreshTemplates();
            openModal(createTemplateManagerDialog());
          }
        })
      );
    });

    tableBody.appendChild(row);
  });
}

function legacyCreateTemplateManagerDialog() {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manager-card';
  dialog.innerHTML = `
    <div class="dialog-header compact">
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>模板名称</th>
            <th>大账号</th>
            <th class="manager-action-header"><span class="manager-action-header-label">执行操作</span></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="dialog-actions right template-manager-bundle-actions">
      <button class="secondary-btn small" type="button" data-action="import-bundle">导入模板文件</button>
      <button class="secondary-btn small" type="button" data-action="export-bundle">导出模板文件</button>
    </div>
  `;

  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  dialog.querySelector('[data-action="import-bundle"]').addEventListener('click', async () => {
    const result = await window.desktopApi.templates.importBundle();

    if (result.status === 'cancelled') {
      return;
    }

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status === 'success') {
      await refreshTemplates();
      openModal(createTemplateManagerDialog());
      return;
    }

    openModal(createAlertDialog(result.message));
  });
  dialog.querySelector('[data-action="export-bundle"]').addEventListener('click', async () => {
    const result = await window.desktopApi.templates.exportBundle();

    if (result.status === 'cancelled') {
      return;
    }

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status !== 'success') {
      openModal(createAlertDialog(result.message));
    }
  });
  renderTemplateTableRows(dialog.querySelector('tbody'));
  overlay.appendChild(dialog);
  return overlay;
}

function legacyCreateMappingDialog(payload) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  const advancedMappingFields = Array.isArray(payload.advancedMappingFields) && payload.advancedMappingFields.length
    ? payload.advancedMappingFields
    : ADVANCED_MAPPING_FIELDS;
  const currentBigAccounts = cloneBigAccountItems(payload.bigAccounts || []);
  dialog.className = 'modal-card mapping-card';
  dialog.innerHTML = `
    <div class="dialog-header">
      <div class="dialog-title">映射关系管理</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper mapping-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>模板字段</th>
            <th>映射字段</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const tbody = dialog.querySelector('tbody');
  const rowByField = new Map();
  const savedMap = new Map(payload.mappings.map((item) => [item.templateField, item]));
  const headerOptions = payload.template.headers.map((header) => {
    const escapedHeader = escapeHtml(header || '(空白字段)');
    const value = escapeHtml(header);
    return `<option value="${value}">${escapedHeader}</option>`;
  });

  payload.targetFields.forEach((fieldName) => {
    if (fieldName === advancedMappingFields[0]) {
      const sectionRow = document.createElement('tr');
      sectionRow.className = 'mapping-section-row';
      sectionRow.innerHTML = '<td colspan="2"><strong>映射关系设置</strong></td>';
      tbody.appendChild(sectionRow);
    }

    const row = document.createElement('tr');
    row.dataset.templateField = fieldName;
    const isBalanceField = fieldName === 'Balance';
    const isMerchantIdField = fieldName === 'MerchantId';
    const supportsSelfInputOption = isMerchantIdField;
    const savedMapping = savedMap.get(fieldName) || {
      mappedField: isBalanceField ? BALANCE_DISABLED_OPTION : '',
      customValue: '',
      isMultiBigAccount: false
    };
    const selectOptions = [isBalanceField ? `<option value="${BALANCE_DISABLED_OPTION}">${BALANCE_DISABLED_OPTION}</option>` : '<option value=""></option>']
      .concat(isBalanceField ? [`<option value="${BALANCE_CALCULATED_OPTION}">${BALANCE_CALCULATED_OPTION}</option>`] : [])
      .concat(supportsSelfInputOption ? [`<option value="${MERCHANT_ID_SELF_INPUT_OPTION}">${MERCHANT_ID_SELF_INPUT_OPTION}</option>`] : [])
      .concat(headerOptions)
      .join('');
    row.innerHTML = `
      <td>${escapeHtml(fieldName)}</td>
      <td>
        <div class="mapping-field-editor">
          <select class="mapping-select">${selectOptions}</select>
          ${isMerchantIdField ? `
            <button class="secondary-btn small mapping-big-account-manage-btn" type="button" hidden>维护大账号</button>
          ` : ''}
        </div>
      </td>
    `;

    const select = row.querySelector('.mapping-select');
    const manageBigAccountBtn = row.querySelector('.mapping-big-account-manage-btn');
    select.value = savedMapping.mappedField || (isBalanceField ? BALANCE_DISABLED_OPTION : '');

    function syncEditorState() {
      const isCustomInput = select.value === MERCHANT_ID_SELF_INPUT_OPTION;

      if (manageBigAccountBtn) {
        manageBigAccountBtn.hidden = !isCustomInput;
      }
    }

    if (manageBigAccountBtn) {
      manageBigAccountBtn.addEventListener('click', () => {
        const draftMappings = collectMappingDraftFromTable(tbody);
        openModal(createBigAccountManagerDialog({
          bigAccounts: currentBigAccounts,
          onDone: (nextBigAccounts) => {
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings.map((mapping) => {
                return mapping.templateField === 'MerchantId'
                  ? { ...mapping, mappedField: MERCHANT_ID_SELF_INPUT_OPTION }
                  : mapping;
              }),
              bigAccounts: nextBigAccounts
            }));
          },
          onCancel: () => {
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: currentBigAccounts
            }));
          }
        }));
      });
    }

    select.addEventListener('change', syncEditorState);
    syncEditorState();
    rowByField.set(fieldName, row);
    tbody.appendChild(row);
  });

  function syncMerchantIdDependentRows() {
    const merchantRow = rowByField.get('MerchantId');
    const currencyRow = rowByField.get('Currency');
    const merchantSelect = merchantRow?.querySelector('.mapping-select');
    const isManagedByBigAccount = merchantSelect?.value === MERCHANT_ID_SELF_INPUT_OPTION;

    if (currencyRow) {
      currencyRow.hidden = Boolean(isManagedByBigAccount);
    }
  }

  const merchantSelect = rowByField.get('MerchantId')?.querySelector('.mapping-select');
  merchantSelect?.addEventListener('change', syncMerchantIdDependentRows);
  syncMerchantIdDependentRows();

  dialog.querySelector('.icon-close').addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });

  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const mappings = collectMappingDraftFromTable(tbody);
    const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
    const result = await window.desktopApi.templates.saveMappings({
      templateId: payload.template.id,
      mappings,
      bigAccounts: draftBigAccounts
    });

    setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });

    if (result.status === 'success') {
      await refreshTemplates();
      openModal(createTemplateManagerDialog());
      return;
    }

    openModal(createAlertDialog(result.message, {
      onConfirm: () => {
        openModal(createMappingDialog({
          ...payload,
          mappings,
          bigAccounts: draftBigAccounts
        }));
      }
    }));
  });

  overlay.appendChild(dialog);
  return overlay;
}

function legacyCreateAccountMappingDialog(payload) {
  const overlay = createOverlay();
  const dialog = document.createElement('div');
  dialog.className = 'modal-card manager-card account-card';
  dialog.innerHTML = `
    <div class="dialog-header compact">
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>网银大账户ID</th>
            <th>清结算系统大账户ID</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  `;

  const tbody = dialog.querySelector('tbody');

  function createInputRow(bankAccountId = '', clearingAccountId = '') {
    const row = document.createElement('tr');
    const bankCell = document.createElement('td');
    const clearingCell = document.createElement('td');
    const bankInput = document.createElement('input');
    const clearingInput = document.createElement('input');

    bankInput.className = 'mapping-text-input';
    bankInput.type = 'text';
    bankInput.spellcheck = false;
    bankInput.value = bankAccountId;

    clearingInput.className = 'mapping-text-input';
    clearingInput.type = 'text';
    clearingInput.spellcheck = false;
    clearingInput.value = clearingAccountId;

    bankCell.appendChild(bankInput);
    clearingCell.appendChild(clearingInput);
    row.appendChild(bankCell);
    row.appendChild(clearingCell);
    return row;
  }

  function createAddRow() {
    const row = document.createElement('tr');
    row.className = 'add-row';
    row.innerHTML = `
      <td><button class="text-action" type="button" data-action="add">新增</button></td>
      <td></td>
    `;

    row.querySelector('[data-action="add"]').addEventListener('click', () => {
      tbody.insertBefore(createInputRow('', ''), row);
    });

    return row;
  }

  payload.mappings.forEach((mapping) => {
    tbody.appendChild(createInputRow(mapping.bankAccountId, mapping.clearingAccountId));
  });
  tbody.appendChild(createAddRow());

  dialog.querySelector('.icon-close').addEventListener('click', closeModal);
  dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
    const mappings = Array.from(dialog.querySelectorAll('.mapping-text-input'))
      .reduce((accumulator, input, index) => {
        const rowIndex = Math.floor(index / 2);

        if (!accumulator[rowIndex]) {
          accumulator[rowIndex] = {
            bankAccountId: '',
            clearingAccountId: ''
          };
        }

        if (index % 2 === 0) {
          accumulator[rowIndex].bankAccountId = input.value;
        } else {
          accumulator[rowIndex].clearingAccountId = input.value;
        }

        return accumulator;
      }, []);

    const result = await window.desktopApi.accountMappings.save(mappings);

    openModal(createAlertDialog(result.message));
    if (result.status === 'success') {
      const info = await window.desktopApi.app.getInfo();
      state.accountMappingCount = info.accountMappingCount;
      setStatus(result.message, 'success');
    } else {
      setStatus(result.message, 'error', {
        errorReportReady: Boolean(result.errorReportReady)
      });
    }
  });

  overlay.appendChild(dialog);
  return overlay;
}

async function handleImportTemplate() {
  const result = await window.desktopApi.templates.importTemplate();

  if (result.status === 'cancelled') {
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady)
  });

  if (result.status === 'success') {
    await refreshTemplates();
  }
}

async function handleOpenAccountMappings() {
  // v1.5.2 需求 3（G3-0）：虚拟 ID 不对应真实模板，这里当无选中处理，回落到第一个真实模板
  const hasRealSelection = state.selectedTemplateId && !isFilenameMappingMode(state.selectedTemplateId);
  const currentTemplateId = hasRealSelection ? Number(state.selectedTemplateId) : null;
  const templateId = currentTemplateId || (state.templates.length > 0 ? state.templates[0].id : null);

  if (!templateId) {
    setStatus('请先创建模板', 'error');
    return;
  }

  // 检查是否有待分配的迁移数据
  const migrationCheck = await window.desktopApi.accountMappings.checkMigrationPending();
  if (migrationCheck.pending) {
    openModal(createAlertDialog('检测到旧版本数据，请为每个模板配置正确的账户映射', {
      onConfirm: async () => {
        const migrationData = await window.desktopApi.accountMappings.getMigrationData();
        if (migrationData.status !== 'success') {
          setStatus(migrationData.message || '获取迁移数据失败', 'error');
          return;
        }
        openModal(createAccountMappingMigrationDialog({
          rows: migrationData.rows,
          templates: state.templates,
          onDone: () => {
            handleOpenAccountMappings();
          }
        }));
      }
    }));
    return;
  }

  const result = await window.desktopApi.accountMappings.list(templateId);

  if (result.status !== 'success') {
    setStatus(result.message, 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
    openModal(createAlertDialog(result.message));
    return;
  }

  openModal(createAccountMappingDialog({
    ...result,
    currentTemplateId: templateId,
    templates: state.templates,
    currencyOptions: state.currencyOptions || []
  }));
}

async function handleImportFile() {
  if (!state.hasEnum) {
    setStatus(getEnumStatusMessage(), 'error');
    return;
  }

  if (!state.selectedTemplateId) {
    setStatus('请先选择模板', 'error');
    return;
  }

  // v1.5.2 需求 3（G3-0）：虚拟 ID 原样透传给后端，由 file:import handler 做短路/分派
  const templateId = isFilenameMappingMode(state.selectedTemplateId)
    ? state.selectedTemplateId
    : Number(state.selectedTemplateId);
  const result = await window.desktopApi.files.importFile(templateId);

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status === 'select-big-account') {
    openModal(createBigAccountSelectionDialog(result));
    return;
  }

  if (result.status === 'remember-order-mismatch') {
    const failedLines = (result.failedFileNames || [])
      .map((name) => `${name}的账户个数或账户号匹配不上（账户个数和账户号都匹配不上），请检查。`)
      .join('<br/>');
    openModal(createRememberOrderMismatchDialog({
      message: failedLines,
      bigAccountResult: result
    }));
    return;
  }

  applyStatementResult(result);
}

async function handleExportDetail() {
  const result = await window.desktopApi.files.exportDetail();

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status === 'select-export-scope') {
    openModal(createExportScopeDialog('detail'));
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady)
  });
}

async function handleExportBalance() {
  // v1.5.3 R1 (T1.8)：按模式分流
  if (state.mode === STATEMENT_MODES.exportMonthlyBalance) {
    // 月度余额模式：
    //   未装配 → 弹 createMonthlyBalanceExportDialog；装配 ready 回调里再 setStatus + state.monthlyBalanceReady=true
    //   已装配 → 直接走 IPC export（弹系统保存对话框）
    if (!state.monthlyBalanceReady) {
      openModal(createMonthlyBalanceExportDialog({
        onAssembleReady: (summary) => {
          state.monthlyBalanceReady = true;
          state.monthlyBalancePreview = summary;
          setStatus(
            `月度余额账单已生成（共 ${summary.count} 条记录），可点击"导出余额"另存为文件`,
            'success',
            { errorReportReady: false }
          );
        }
      }));
      return;
    }
    const result = await window.desktopApi.monthlyBalance.export();
    if (result.status === 'cancelled') {
      return;
    }
    if (result.status === 'success') {
      setStatus(result.message || '月度余额账单导出成功', 'success', { errorReportReady: false });
      return;
    }
    // v1.5.3 R1 round 3 (Codex Finding 6)：
    // 后端 session 丢失（临时文件被清 / lastGeneratedExports.monthlyBalance 已 reset）→ reset 前端 ready 状态，
    // 让用户下次点击重新弹 assemble 对话框，而不是反复打到失败 export 分支
    if (result.errorCode === 'MONTHLY_BALANCE_NO_PENDING' || result.errorCode === 'MONTHLY_BALANCE_FILE_MISSING') {
      state.monthlyBalanceReady = false;
      state.monthlyBalancePreview = null;
    }
    setStatus(result.message || '月度余额账单导出失败', 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
    return;
  }

  // create-statement 模式：保留 v1.5.2 原逻辑
  const result = await window.desktopApi.files.exportBalance();

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status === 'select-export-scope') {
    openModal(createExportScopeDialog('balance'));
    return;
  }

  if (result.manualBalancePromptReady || result.status === 'manual-balance-required') {
    applyManualBalancePromptStatus(result);
    return;
  }

  setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady)
  });
}

function getNewAccountPayload() {
  return {
    accounts: getNewAccountRows().map((row) => {
      const refs = getNewAccountRowElements(row);
      const rowState = getNewAccountRowState(row);
      const isMultiCurrency = isNewAccountMultiCurrencyMode(refs);

      return {
        bankName: refs.bankNameInput.value,
        location: refs.locationInput.value,
        currency: isMultiCurrency ? '' : refs.currencyInput.value,
        currencies: isMultiCurrency ? rowState.selectedCurrencies.slice() : [],
        isMultiCurrency,
        bankAccount: refs.bankAccountInput.value,
        openingDate: refs.openDateInput.value
      };
    })
  };
}

async function handleNewAccountGenerate() {
  const result = await window.desktopApi.newAccount.generate(getNewAccountPayload());

  if (result.status === 'cancelled') {
    return;
  }

  if (result.status === 'success') {
    setNewAccountExportAvailability(Boolean(result.exportReady));
  } else {
    setNewAccountExportAvailability(false);
  }

  setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady),
    idleTitle: getNewAccountStatusTitle()
  });
}

async function handleNewAccountExport() {
  const result = await window.desktopApi.newAccount.exportFile();

  if (result.status === 'cancelled') {
    return;
  }

  setNewAccountStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady),
    idleTitle: getNewAccountStatusTitle()
  });
}

// v2.0.0-beta.2 F1 / v2.1.15 W4：UI 风格恒为 Clear（General 风格已弃用，「切换页面风格」入口已移除）。
// 启用 Clear 两套 CSS（styles-gemini.css + styles-gemini-extra.css），并同步 body.dataset.style 供条件 selector / JS 状态读取。
function applyUiStyle() {
  state.uiStyle = 'Clear';

  const cssClear = document.getElementById('cssClear');
  const cssClearExtra = document.getElementById('cssClearExtra');
  if (!cssClear || !cssClearExtra) return;

  cssClear.disabled = false;
  cssClearExtra.disabled = false;
  document.body.dataset.style = 'clear';
}

// v2.0.0-beta.3 PR #32b：银行对账单处理模块 — 状态同步 + 4 按钮 handler
async function refreshBankStatementStatus() {
  try {
    const status = await window.desktopApi.bankStatement.sessionStatus();
    if (!status || status.status !== 'ok') {
      state.bankStatementSession = null;
      state.gatewayReconSession = null;
      state.refundOrderSession = null;
      state.processingResult = null;
    } else {
      state.bankStatementSession = status.hasBankStatement
        ? {
          fileName: status.bankStatementFileName,
          rowCount: status.bankStatementRowCount,
          // v2.1.16 A5：合并来源文件数（> 1 时状态框显示「N 个文件合并」）
          sourceFileCount: Number(status.bankStatementSourceFileCount) || 1,
          // v3.0.0 需求1：唯一「渠道-地区」组合（缺省/老 main 兜底 []），供状态框前缀
          channelRegions: Array.isArray(status.bankStatementChannelRegions)
            ? status.bankStatementChannelRegions
            : []
        }
        : null;
      state.gatewayReconSession = status.hasGatewayRecon
        ? { fileName: status.gatewayReconFileName, rowCount: status.gatewayReconRowCount }
        : null;
      // v3.0.0 需求3：退款 session 就绪信号（缺省/老 main 兜底 null），供运行点 shouldPromptRefundAtRun 判据。
      state.refundOrderSession = status.hasRefundOrder ? { ready: true } : null;
      state.processingResult = status.hasProcessingResult
        ? {
          hitRowCount: status.processingStats?.hitRowCount ?? 0,
          scenarioHitCount: status.processingStats?.scenarioHitCount ?? 0,
          // v2.1.8 N3-1：hitScenarioIds → hitScenarios（{id, displayIndex, name}[]）
          //   状态框显示用 displayIndex 与场景管理 UI 列表序号统一
          hitScenarios: Array.isArray(status.processingStats?.hitScenarios)
            ? status.processingStats.hitScenarios.slice()
            : [],
          // v3.0.7 需求1a：状态框「已处理」分支按 渠道-地区 分组展示命中行数 + 命中场景名。
          //   数据源 reconciliation-orchestrator stats.channelRegionHits（经 main.js stats 整体透传）。
          //   向后兼容：旧持久化 processingResult / 旧 main 无此字段 → []（updateBankStatementUi 据此回退旧 hitScenarios 格式）。
          channelRegionHits: Array.isArray(status.processingStats?.channelRegionHits)
            ? status.processingStats.channelRegionHits.slice()
            : [],
          // v3.0.7 需求A：R5 场景3/4 命中提醒——只读统计字段透传（main.js stats 整体透传，但此处是显式白名单解构，需逐个带出，否则丢失）。
          //   r5s3Enabled/r5s4Enabled 决定是否显示该行（启用即显示，含 0 条）；CleanupCount/BackfilledCount 为命中数。
          //   向后兼容：旧持久化 processingResult / 旧 main 无此字段 → false / 0（updateBankStatementUi 据 enabled=false 不渲染该行）。
          r5s3Enabled: status.processingStats?.r5s3Enabled === true,
          r5s4Enabled: status.processingStats?.r5s4Enabled === true,
          r5s3CleanupCount: status.processingStats?.r5s3CleanupCount ?? 0,
          r5s4BackfilledCount: status.processingStats?.r5s4BackfilledCount ?? 0,
          warningCount: status.processingStats?.warningCount ?? 0,
          skippedC3Count: status.processingStats?.skippedC3Count ?? 0
        }
        : null;
    }
  } catch (error) {
    console.error('refreshBankStatementStatus failed:', error);
  }
  updateBankStatementUi();
}

function updateBankStatementUi() {
  if (!elements.bankStatementStatusBox) return;
  const bs = state.bankStatementSession;
  const gw = state.gatewayReconSession;
  const pr = state.processingResult;
  const ex = state.bankStatementExport;

  // 文案：5 状态优先级（初始 / 已导入 / 已处理 / 已导出）+ tone
  // 多行用 \n 分隔（CSS .status-box-text { white-space: pre-line } 渲染换行）
  let text;
  let tone = 'info';
  if (!bs) {
    text = '欢迎使用小助手';
    tone = 'neutral';
  } else if (ex) {
    // v2.1.9 N6 (T31, D18=a)：删冒号后冗余 \n
    //   updateStatusBox 内层 (`renderer.js:542-566` `String(message).replace(/：/g, '：\n')`) 已统一处理「：」后换行，
    //   外层不能再重复加 \n（否则双换行）。行间产物用 \n 续行（见下方加款单剔除 / 中台回填）。
    // v3.0.11 需求2：导出成功框不再显示 error-report（文件仍照常生成，仅去掉此处提示行）。
    text = `已导出：${ex.mainFileName}`;
    // v3.0.7 需求1b：导出附带产物（加款单剔除文件 / 中台回填文件）按存在性追加各占一行。
    //   行间用 \n 续行 + 全角「：」（与 error-report 同款，updateStatusBox 在「：」后补 \n → 文件名落下一行）。
    if (ex.platformCleanupName) text += `\n加款单剔除文件：${ex.platformCleanupName}`;
    if (ex.refundBackfillName) text += `\n中台回填文件：${ex.refundBackfillName}`;
    tone = 'success';
  } else if (pr) {
    // v3.0.7 需求1a：「已处理」分支改用 pr.channelRegionHits 按「渠道-地区」分组多行展示——
    //   每个 hit 一行 `渠道-地区:n条（场景名1、场景名2）`，组间 \n，整体接在「已处理：」后。
    //   数据契约（reconciliation-orchestrator stats.channelRegionHits）：
    //     Array<{ channelRegion:string, rowCount:number, scenarioNames:string[] }>，数组本身已按 channelRegion 升序、scenarioNames 已去重升序。
    //   🔴 换行陷阱（updateStatusBox 对全角「：」自动补 \n）：分组冒号一律半角 ':'、场景名间一律顿号 '、'，绝不用全角「：」（否则被打断换行）。
    //   向后兼容（pr.channelRegionHits 为空数组 / 字段缺失：旧持久化 processingResult / 旧 main）→ 完全回退下方 hitScenarios 旧格式，不抛错。
    const crHits = Array.isArray(pr.channelRegionHits) ? pr.channelRegionHits : [];
    if (crHits.length > 0) {
      const hitLines = crHits.map((h) => {
        const names = Array.isArray(h.scenarioNames) ? h.scenarioNames.filter((n) => n) : [];
        const namePart = names.length > 0 ? `（${names.join('、')}）` : '';
        return `${h.channelRegion}:${Number(h.rowCount) || 0}条${namePart}`;
      });
      // 「已处理：」后全角冒号已触发一次 \n（updateStatusBox），各分组再以 \n 续行。
      text = `已处理：${hitLines.join('\n')}`;
    } else {
      // v2.1.8 N3-1：hitScenarios.displayIndex 与场景管理 UI 列表序号统一（spec.md §五 N3-D1）
      const arr = Array.isArray(pr.hitScenarios) ? pr.hitScenarios : [];
      // v3.0.3 PR-E：状态框命中明细按「银行渠道枚举值:场景序号」分组换行展示。
      //   新数据（双维路径）每条 hitScenarios 带非空 channelName → 按 channelName 分组（保持首次出现顺序），
      //     每组一行 `渠道名:序号1、序号2`，组间 \n，包进括号：`（场景\nJPM:1、3\nCITI:2）`。
      //   🔴 换行陷阱（updateStatusBox 对全角「：」自动补 \n）：分组分隔必须用半角 ':'，绝不用全角「：」。
      //   fallback：旧 processingResult 持久化数据 / legacy 单维路径无 channelName → 保持原格式 `（场景 1、3）` 零变化。
      let idsText = '';
      if (arr.length > 0 && arr.every((s) => s.channelName)) {
        const groups = new Map(); // channelName → [displayIndex...]（保持首次出现顺序）
        arr.forEach((s) => {
          if (!groups.has(s.channelName)) groups.set(s.channelName, []);
          groups.get(s.channelName).push(s.displayIndex);
        });
        const lines = [];
        groups.forEach((indexes, channelName) => {
          lines.push(`${channelName}:${indexes.join('、')}`);
        });
        idsText = `（场景\n${lines.join('\n')}）`;
      } else if (arr.length > 0) {
        idsText = `（场景 ${arr.map((s) => s.displayIndex).join('、')}）`;
      }
      // v3.0.7 需求1c：「已处理」分支移除「，N 警告」尾巴（警告仍写 error-report 不动）。
      text = `已处理：${pr.hitRowCount} 行命中${idsText}`;
    }
    // v3.0.7 需求A：「已处理」命中展示之后追加 R5 场景3/4 命中行——「场景启用就显示该行（含 0 条命中）」。
    //   每行格式 `场景名:N 条命中`，行前 \n 续行。对新（channelRegionHits）/旧（hitScenarios）两种命中格式统一生效（在 if/else 汇合后追加）。
    //   🔴 换行陷阱（updateStatusBox 第 614 行对全角「：」自动补 \n）：分隔冒号一律半角 ':'，绝不用全角「：」——
    //      否则「场景名」与「N 条命中」会被强制打断成两行（每场景 2 行 / 共 4 行），违背「每行独立成行、两行」诉求。
    //      与本分支既有 channelRegionHits / hitScenarios 多行展示的半角冒号防换行约定完全一致。
    //   🔴 纯展示：r5s3Enabled/r5s4Enabled/r5s3CleanupCount/r5s4BackfilledCount 均为 orchestrator 只读统计字段，不改任何对账值。
    //   向后兼容：字段缺失（旧持久化 / 旧 main）→ refreshBankStatementStatus 兜底为 false / 0 → enabled=false 不渲染该行（与 channelRegionHits 回退风格一致）。
    if (pr.r5s3Enabled) text += `\n中台加款单脏数据处理:${Number(pr.r5s3CleanupCount) || 0} 条命中`;
    if (pr.r5s4Enabled) text += `\n中台退款订单回填:${Number(pr.r5s4BackfilledCount) || 0} 条命中`;
    if (pr.skippedC3Count > 0) {
      text += ` · 跳过 ${pr.skippedC3Count} 个对账不平场景`;
    }
    // v3.0.7 需求1c：tone 不再因警告转 error，固定 success（警告不再进状态框文案，仍写 error-report）。
    tone = 'success';
  } else {
    // v2.1.9 N6 (T31, D18=a)：删冒号后冗余 \n（同上）；`\n不平账结果表：` 是行间换行保留
    // v2.1.16 A5：批量合并多文件 → 显示「N 个文件合并 M 行」；单文件沿用「文件名（M 行）」
    const fileCount = Number(bs.sourceFileCount) || 1;
    // v3.0.0 需求1：状态框「渠道-地区」前缀。
    //   🔴 换行陷阱（renderer.js:596 updateStatusBox 对全角「：」自动补 \n）：
    //      前缀分隔必须用半角 ':'、组合间用顿号 '、'，绝不用全角「：」，否则前缀被换行打断。
    //   组合数：0 个 → 无前缀（兜底原文案）；1 个 → `CITI-HK:`；多个 → `CITI-HK、JPM-US:`（全列出、已去重+排序）。
    const combos = Array.isArray(bs.channelRegions) ? bs.channelRegions : [];
    const channelRegionPrefix = combos.length === 0 ? '' : `${combos.join('、')}:`;
    text = fileCount > 1
      ? `已导入：${channelRegionPrefix}${fileCount} 个文件合并（${bs.rowCount} 行）`
      : `已导入：${channelRegionPrefix}${bs.fileName}（${bs.rowCount} 行）`;
    if (gw) text += `\n不平账结果表：${gw.fileName}（${gw.rowCount} 行）`;
    tone = 'info';
  }
  // v3.0.0 需求2a：导入失败/跳过摘要并入状态框（去明细确认框后的信息落点）。
  //   追加在「主文案算完之后、updateStatusBox 之前」，对全部分支统一生效——
  //   尤其纯失败批次（无 bank ok，bs 为 null 走「欢迎使用」分支）也能渲染 issues。
  //   摘要为纯文本（buildImportIssuesSummary，半角冒号防换行打断），用 \n 接在主文案下方；
  //   含失败时 tone 升 'error'（覆盖原 tone，触发 updateStatusBox 的 error 视觉 + 日志上报）。
  const issues = state.bankStatementImportIssues;
  if (issues && issues.text) {
    text = `${text}\n${issues.text}`;
    if (issues.hasFailed) tone = 'error';
  }
  // v2.1.7 round 3 B5：走 updateStatusBox 入口（R3 wiring — 自动获中文「：」换行 + null 兜底）
  //   原现状：直写 textEl.textContent = text + dataset.tone = tone（漏 R3 replace 处理）
  //   spec §9.6.2
  updateStatusBox(elements.bankStatementStatusBox, text, tone);

  // 按钮 disabled 控制
  // v3.0.11 codex-P3 修复：导入按钮也受 inflight 闸约束——否则运行/导出期间的 UI 刷新（如切回本模块）会无条件复活导入按钮，
  //   用户点导入被主进程 op-lock 拒后其 finally 清掉共享 bankStatementInflight，导致运行/导出按钮中途复活。
  if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = state.bankStatementInflight;
  updateBankStatementRunBtnDisabled();
  updateBankStatementExportButtonsDisabled();
}

// v2.1.16-beta.5 需求1（PR-4 修订）🔴 资金红线：row1《开始运行》(bankStatementRunBtn) disabled 重算。
//   抽成独立 helper，使「导入不平表」成功路径也能让按钮 enable（该路径不走 updateBankStatementUi，避免覆盖状态框）。
//   F3c 修复（self-review）：enable 判据与路由 mode 对齐，消除「按钮亮起却点击 abort」的状态不自洽。
//   mode='gateway'（最近导入不平表）→ 按网关 recon session 判定可点；mode='bank'（默认/最近导入对账单）→ 按银行对账单 session 判定。
//   实际跑哪个引擎由 state.bankStatementProcessRunMode 决定（见 bankStatementRunBtn click handler）——enable 与路由现一致。
function updateBankStatementRunBtnDisabled() {
  if (!elements.bankStatementRunBtn) return;
  const ready = state.bankStatementProcessRunMode === 'gateway'
    ? !!state.reconIdFixSession
    : !!state.bankStatementSession;
  // v3.0.11 需求3（批1 · 按钮禁用统一闸）：操作进行中（import/run/export）一律禁用《开始运行》。
  elements.bankStatementRunBtn.disabled = !ready || state.bankStatementInflight;
}

// v2.1.16-beta.6 需求A 🔴 资金红线：《导出文件》按钮按面板模式禁用（与 row1 路由 mode 一致）。
//   抽成 helper，使「导入对账单成功」(updateBankStatementUi) 与「导入不平表成功」路径都能刷新。
// v3.0.7 需求2a（C2）：原 row2《导出文件》(bankStatementGatewayReconExportBtn) 已删 → 移除其网关分支；
//   本 helper 退化为只管 row1《导出文件》(bankStatementExportBtn)：仅 bank 模式 + 已有处理结果可点（gateway 模式下仍禁用）。
function updateBankStatementExportButtonsDisabled() {
  const isGateway = state.bankStatementProcessRunMode === 'gateway';
  // 预加工组导出：仅 bank 模式 + 已有处理结果可点
  // v3.0.11 需求3（批1 · 按钮禁用统一闸）：操作进行中（import/run/export）一律禁用《导出文件》。
  if (elements.bankStatementExportBtn) {
    elements.bankStatementExportBtn.disabled = isGateway || !state.processingResult || state.bankStatementInflight;
  }
}

// v2.1.14：纯前端占位 helper —— 功能 UI 已就位但后端未接入，统一弹「后续版本开放」提示框。
//   红线：严禁调用真实 run/export IPC、严禁写任何数据、严禁显示成功态。
//   info 级提示：skipLogReport 跳过 createAlertDialog 默认的 error 级日志上报（避免污染错误日志）。
function showComingSoon(featureName) {
  openModal(createAlertDialog(
    `「${featureName}」功能将在后续版本开放，敬请期待。`,
    { skipLogReport: true }
  ));
}

// v2.1.16 A5：原单选 handler handleBankStatementImport 已被批量入口 handleBankStatementBatchImport 取代
//   （「导入对账单」按钮改调批量逻辑；单选 1 个银行对账单是批量子集，行为等同）。
//   单选 IPC `bank-statement:import` 仍在 main.js / preload 保留（无其它调用方，避免破坏潜在引用）。

// v2.1.16 A5：批量导入（按表头识别）—— 多选文件 → main 逐文件识别路由 → 批量结果明细弹窗。
//   银行对账单通路：多文件 = 合并对账（main 追加 rows + 全局唯一 _rowId）；明细体现「N 个文件合并 M 行」。
//   中台退款/入账原始本阶段功能开关默认关 → main 返回 status='disabled'（标「未启用跳过」）。
// v2.1.16-beta.6 修复（根因）：renderer.js 顶层 16 处引用 escapeHtml，但它只定义在 renderer-dialogs.js
//   的 IIFE 内（renderer.js 作用域访问不到）→ buildBatchImportSummaryHtml 等运行到时 ReferenceError
//   （表现：批量导入对账单后「批量明细框」弹不出来，退款提醒也无从触发）。
//   在本文件顶层补一份同实现（function 声明 hoist，覆盖本文件全部 escapeHtml 引用）。
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildBatchImportSummaryHtml(results) {
  const list = Array.isArray(results) ? results : [];
  // 预处理表 tableKey → 中文名（与 main detector tableKey 对齐）
  const TABLE_LABELS = {
    'bank-statement': '银行对账单',
    'zhongtai-refund-order': '中台退款订单',
    'intake-original-order': '入账原始订单'
  };
  const ok = list.filter((r) => r.status === 'ok');
  const skipped = list.filter((r) => r.status === 'disabled');
  const failed = list.filter((r) => r.status !== 'ok' && r.status !== 'disabled');
  const statusLabel = {
    'ambiguous': '表头命中多张表，无法判定',
    'unrecognized': '未识别为预处理表',
    'read-error': '文件读取失败',
    'invalid': '文件校验失败'
  };
  const lines = [];
  lines.push(`成功导入 <b>${ok.length}</b> 个文件，跳过 <b>${skipped.length}</b> 个，失败 <b>${failed.length}</b> 个`);
  if (ok.length > 0) {
    const bankOk = ok.filter((r) => r.tableKey === 'bank-statement');
    const otherOk = ok.filter((r) => r.tableKey !== 'bank-statement');
    const blocks = [];
    // 银行对账单：多文件合并 → 汇总「N 个文件合并 M 行」+ 逐文件行数；单文件 → 直接显示行数
    if (bankOk.length > 0) {
      // 合并后总行数取最后一条 ok 的 mergedRowCount（main 每文件回填合并后当前总数）；兜底用逐文件求和
      const last = bankOk[bankOk.length - 1];
      const mergedTotal = Number(last.mergedRowCount) || bankOk.reduce((s, r) => s + (Number(r.rowCount) || 0), 0);
      const perFile = bankOk.map((r) => `　- ${escapeHtml(r.fileName)}（${Number(r.rowCount) || 0} 行）`).join('<br/>');
      if (bankOk.length > 1) {
        blocks.push(`• 银行对账单：${bankOk.length} 个文件合并 ${mergedTotal} 行<br/>${perFile}`);
      } else {
        blocks.push(`• ${escapeHtml(bankOk[0].fileName)} → 银行对账单（${mergedTotal} 行）`);
      }
    }
    // 其余预处理表（本阶段无 ok 通路，保留通用渲染）
    for (const r of otherOk) {
      const name = TABLE_LABELS[r.tableKey] || r.tableKey || '';
      blocks.push(`• ${escapeHtml(r.fileName)} → ${escapeHtml(name)}（${Number(r.rowCount) || 0} 行）`);
    }
    lines.push(`成功：<br/>${blocks.join('<br/>')}`);
  }
  if (skipped.length > 0) {
    const skipList = skipped.map((r) => {
      const reason = r.message || '功能未启用，已跳过';
      return `• ${escapeHtml(r.fileName)}：${escapeHtml(reason)}`;
    }).join('<br/>');
    lines.push(`跳过：<br/>${skipList}`);
  }
  if (failed.length > 0) {
    const failList = failed.map((r) => {
      const reason = r.message || statusLabel[r.status] || r.status || '未知原因';
      // invalid 携带 detailLines 时附前几行
      const detail = Array.isArray(r.detailLines) && r.detailLines.length > 0
        ? `<br/>　${r.detailLines.slice(0, 3).map((l) => escapeHtml(l)).join('<br/>　')}`
        : '';
      return `• ${escapeHtml(r.fileName)}：${escapeHtml(reason)}${detail}`;
    }).join('<br/>');
    lines.push(`失败：<br/>${failList}`);
  }
  return lines.join('<br/><br/>');
}

// v3.0.0 需求2a：去导入明细框后，把失败/跳过信息提炼成「纯文本」摘要并入状态框。
//   🔴 纯文本（非 HTML）：状态框走 updateStatusBox → textContent，HTML 标签会被原样显示。
//   口径与 buildBatchImportSummaryHtml 一致：跳过 = status==='disabled'；
//   失败 = 非 ok 非 disabled（ambiguous/unrecognized/read-error/invalid…）。
//   失败行复用同款 statusLabel/message 取文案口径（与明细框保持一致），但用半角字符拼接：
//   - 文件间分隔用顿号 '、'，跳过/失败两段间用 '\n'（CSS white-space: pre-wrap 渲染换行）；
//   - 🔴 半角冒号避坑：updateStatusBox 会对全角「：」后强制换行（renderer.js:596），
//     故每文件「文件名: 原因」一律用半角 ':'，避免被打断。
//   返回 { text, hasFailed }：text 空串表示无 issues；hasFailed 供调用方决定状态框 tone 是否升 error。
function buildImportIssuesSummary(results) {
  const list = Array.isArray(results) ? results : [];
  // 与 buildBatchImportSummaryHtml 完全一致的失败原因口径
  const statusLabel = {
    'ambiguous': '表头命中多张表，无法判定',
    'unrecognized': '未识别为预处理表',
    'read-error': '文件读取失败',
    'invalid': '文件校验失败'
  };
  const skipped = list.filter((r) => r && r.status === 'disabled');
  const failed = list.filter((r) => r && r.status !== 'ok' && r.status !== 'disabled');
  const parts = [];
  if (skipped.length > 0) {
    const names = skipped.map((r) => String(r.fileName || '')).join('、');
    parts.push(`跳过 ${skipped.length} 个: ${names}`);
  }
  if (failed.length > 0) {
    // 每文件「文件名: 失败原因」（半角冒号），原因取 message > statusLabel > status
    const items = failed.map((r) => {
      const reason = r.message || statusLabel[r.status] || r.status || '未知原因';
      return `${String(r.fileName || '')}: ${reason}`;
    }).join('、');
    parts.push(`失败 ${failed.length} 个: ${items}`);
  }
  // 跳过/失败两段各占一行（\n，CSS white-space: pre-wrap 渲染）；
  // 段内一律半角冒号，避开 updateStatusBox 对全角「：」的强制换行。
  return { text: parts.join('\n'), hasFailed: failed.length > 0 };
}

// v3.0.7 需求2d：「导入文件」按钮升级为通用导入后，main 端对每条成功结果回传 outcome：
//   - 'processed' → 走 R1-R5 预处理（bank-statement / 退款订单），由状态框「已导入」主流程承载，不在此汇总；
//   - 'linked'    → 落链接表（bank-deposit/gateway-bill/mid-allocation/fx-settlement），状态框「已导入」分支不体现（语义归银行对账单 session）。
//   故对 linked 成功单独提炼一段「N 行已存入XX表库」纯文本，追加进状态框（与 issues 同款半角冒号防换行）。
//   🔴 仅汇总 status==='ok' && outcome==='linked'（保持与 main 契约一致；linked 落库成功 tableKey≠'bank-statement'）。
function buildLinkedImportSummary(results) {
  const list = Array.isArray(results) ? results : [];
  // 链接表 tableKey → 中文表库名（与 renderer-dialogs.js LINKED_TABLE_LABELS 同口径，避免漂移）。
  const LINKED_TABLE_LABELS = {
    'bank-deposit': '银行对账单表',
    'gateway-bill': '网关对账单表库',
    'mid-allocation': '中台调拨订单表库',
    'fx-settlement': '外汇交割表库',
    'fx-option': '外汇期权表库'
  };
  const linkedOks = list.filter((r) => r && r.status === 'ok' && r.outcome === 'linked');
  if (linkedOks.length === 0) return '';
  // 每文件一行「文件名 → 表库名（N 行）」；行间 \n，段内半角字符（无全角「：」，避开 updateStatusBox 强制换行）。
  const lines = linkedOks.map((r) => {
    const label = LINKED_TABLE_LABELS[r.tableKey] || r.tableKey || '';
    const cnt = Number(r.rowCount) || 0;
    return `${String(r.fileName || '')} → ${label}（${cnt} 行）`;
  });
  return `已存入链接表 ${linkedOks.length} 个:\n${lines.join('\n')}`;
}

// v3.0.7 修复1（🔴🔴 资金红线 · 语义）：ADM/BOC/JPM-US 银行单现在「既落表 又对账」——
//   outcome 变为 'processed'（参与对账、出现在结果表），由状态框「已导入：渠道-地区:N行」主流程承载；
//   同时它们【还】落了 bank-deposit 链接表（main 端经 alsoLinked 挂在 processed result 上）。
//   为让用户也知道这层副作用，对带 alsoLinked（且无落库 error）的 processed 结果追加一行轻量提示。
//   🔴 只汇总 outcome==='processed' && alsoLinked 非空 && 无 error（落库失败不报"已存入"，避免误导）；
//     纯 'linked'（mid-allocation/gateway/fx / 经「链接表管理」导入的 bank-deposit）仍走 buildLinkedImportSummary，
//     本函数不重复体现。段内一律半角冒号，避开 updateStatusBox 对全角「：」的强制换行。
function buildAlsoLinkedSummary(results) {
  const list = Array.isArray(results) ? results : [];
  const alsoLinkedOks = list.filter((r) =>
    r && r.status === 'ok' && r.outcome === 'processed'
    && r.alsoLinked && !r.alsoLinked.error);
  if (alsoLinkedOks.length === 0) return '';
  const lines = alsoLinkedOks.map((r) => {
    const cnt = Number(r.alsoLinked.rowCount) || 0;
    return `${String(r.fileName || '')}:${cnt} 行已同时存入银行对账单表链接表`;
  });
  return lines.join('\n');
}

// v3.0.7 F1（codex review · 🔴 资金红线）：ADM/BOC/JPM-US 文件已对账(outcome:'processed')但 bank-deposit 副作用
//   落库失败(alsoLinked.error)——原 buildAlsoLinkedSummary 只报成功、失败被静默丢弃 → 用户看到「成功」但链接表
//   未更新，后续 R5 退款二跳 / ADM / BOC 对账用旧/缺数据静默错账。本函数提炼这些落库失败行，供 handler 折进 issues
//   失败段（并置 hasFailed→error tone），使「看似成功实则链接表未更新」可见、提醒用户重导。
//   段内一律半角冒号，避开 updateStatusBox 对全角「：」的强制换行。
function buildAlsoLinkedFailureSummary(results) {
  const list = Array.isArray(results) ? results : [];
  const fails = list.filter((r) =>
    r && r.status === 'ok' && r.outcome === 'processed' && r.alsoLinked && r.alsoLinked.error);
  if (fails.length === 0) return '';
  return fails.map((r) =>
    `${String(r.fileName || '')}:已对账，但银行对账单表链接表落库失败:${r.alsoLinked.error}（请重新导入该文件）`
  ).join('\n');
}

async function handleBankStatementBatchImport() {
  // v3.0.11 需求3（批1 · 按钮禁用统一闸）：最外层设 inflight → 运行/导出按钮随之禁用；下方 try/finally 统一清。
  state.bankStatementInflight = true;
  updateBankStatementRunBtnDisabled();
  updateBankStatementExportButtonsDisabled();
  // 「导入对账单」按钮即批量入口；导入期间禁用防重复触发。
  if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = true;
  // v3.0.0 需求2a：进入新一轮导入 → 先清上一批失败/跳过摘要，避免残留串到本批状态框。
  state.bankStatementImportIssues = null;
  // v3.0.11 需求3（批1 · 导入进度）：订阅导入进度事件，导入期把「正在导入第 X/Y 个文件…」刷进状态框；finally 退订防泄漏。
  let importUnsubscribe = null;
  try {
    const api = window.desktopApi && window.desktopApi.bankStatement;
    if (api && typeof api.onImportProgress === 'function') {
      importUnsubscribe = api.onImportProgress((ev) => {
        const text = formatBankStatementImportProgress(ev);
        if (text && elements.bankStatementStatusBox) {
          updateStatusBox(elements.bankStatementStatusBox, text, 'info');
        }
      });
    }
  } catch (_e) { /* swallow — 订阅失败不影响导入 */ }
  // v3.0.11 需求3（批1）：包裹整个导入流程，finally 统一清 inflight / 退订进度 / 复位按钮（覆盖全部早返回路径）。
  try {
  let result;
  try {
    result = await window.desktopApi.bankStatement.batchImport();
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`导入失败：${error.message || error}`));
    return; // → 外层 finally 统一清 inflight + 复位按钮
  }
  // v3.0.11 codex-P3 修复：不在此中途复位导入按钮——保持禁用直到外层 finally（覆盖 refreshBankStatementStatus /
  //   退款·C3 提醒整段 await），否则那段 await 期间可起第二次导入，第一次的 finally 清共享 inflight 会让 run/export 中途复活。
  if (!result || result.status === 'cancelled') return; // 用户取消文件选择 → 不刷状态框
  if (result.status !== 'ok') {
    // IPC 层整体失败（非 per-file 明细），沿用弹框；不入状态框 issues（issues 只承载 per-file 明细）
    openModal(createAlertDialog(`导入失败：${result.message || '未知错误'}`));
    return;
  }
  const results = Array.isArray(result.results) ? result.results : [];
  // v3.0.0 需求2a：去明细确认框，改把 per-file 失败/跳过摘要并入状态框（纯文本，半角冒号防换行）。
  const issues = buildImportIssuesSummary(results);
  // v3.0.7 F1（codex review · 🔴 资金红线）：把 ADM/BOC/JPM-US 文件的 bank-deposit 副作用落库失败折进 issues 失败段，
  //   使「看似成功实则链接表未更新（后续对账用旧/缺数据）」可见 + 转 error tone（详见 buildAlsoLinkedFailureSummary 注释）。
  const alsoLinkedFailText = buildAlsoLinkedFailureSummary(results);
  if (alsoLinkedFailText) {
    issues.text = issues.text ? `${issues.text}\n${alsoLinkedFailText}` : alsoLinkedFailText;
    issues.hasFailed = true;
  }
  // v3.0.7 需求2d：通用导入下，linked 落库成功（outcome==='linked'）单独提炼「已存入XX表库」段，
  //   合并进状态框 issues.text（追加在失败/跳过段之后；linked 成功非失败 → 不改 hasFailed/tone）。
  const linkedSummary = buildLinkedImportSummary(results);
  if (linkedSummary) {
    issues.text = issues.text ? `${issues.text}\n${linkedSummary}` : linkedSummary;
  }
  // v3.0.7 修复1：ADM/BOC/JPM-US 文件（outcome:'processed'）同时落了 bank-deposit 链接表 → 追加副作用提示。
  //   非失败 → 不改 hasFailed/tone（与 linkedSummary 同款，仅补充 text）。
  const alsoLinkedSummary = buildAlsoLinkedSummary(results);
  if (alsoLinkedSummary) {
    issues.text = issues.text ? `${issues.text}\n${alsoLinkedSummary}` : alsoLinkedSummary;
  }
  state.bankStatementImportIssues = issues;
  // 若本批有银行对账单成功导入 → 清「已导出」缓存 + 刷新状态框（与单选导入一致）
  const hasBankStatementOk = results.some((r) => r.status === 'ok' && r.tableKey === 'bank-statement');
  if (hasBankStatementOk) {
    state.bankStatementExport = null;
    // v2.1.16-beta.5 需求1（PR-4 修订）🔴 资金红线：导入对账单成功 → 面板运行模式置 'bank'，
    //   row1《开始运行》此后走 R1-R5 核心（handleBankStatementRun）。仅本批确实含 bank-statement 时才改，
    //   本批无 bank-statement（如失败/全是其它表）则保持原 mode（不误覆盖刚导入不平表的 'gateway'）。
    state.bankStatementProcessRunMode = 'bank';
    // v2.1.16-beta.6 防御：状态刷新抛错不应阻断后续提醒（导入反馈仍要落地）。
    //   refreshBankStatementStatus 内部会调 updateBankStatementUi，带上 issues 摘要一并渲染。
    try {
      await refreshBankStatementStatus();
    } catch (refreshErr) {
      console.error('[导入对账单] 状态刷新失败（已兜底，不阻断提醒）:', refreshErr);
    }
  } else if (results.some((r) => r && r.status === 'ok' && r.outcome === 'linked')) {
    // v3.0.7 F2（codex review）：纯 linked 成功（中台调拨/网关/外汇，无银行单）经 importLinkedFileToRepo 已清 main 端
    //   processingResult；若仅 updateBankStatementUi（按 renderer 缓存重绘）→ 状态框/导出按钮残留旧「已处理/可导出」。
    //   故拉 session-status refresh（hasProcessingResult=false → state.processingResult=null → 清残留）+ 清 export 缓存。
    //   不改 runMode（非银行单不进 R1-R5 'bank' 模式，不误覆盖 'gateway'）。
    state.bankStatementExport = null;
    try {
      await refreshBankStatementStatus();
    } catch (refreshErr) {
      console.error('[导入文件] linked 成功后状态刷新失败（已兜底，不阻断提醒）:', refreshErr);
      updateBankStatementUi(); // 兜底：refresh 抛错仍重绘 issues 摘要
    }
  } else {
    // v3.0.0 需求2a 🔴 纯失败/无 ok 批次：原路径不刷状态框 → 去明细框后会丢失失败/跳过信息。
    //   新增分支让其也渲染 issues。仅刷 UI（不调 refreshBankStatementStatus IPC）：
    //   不改 mode（不误覆盖刚导入不平表的 'gateway'）、不清 export（无有效新数据）。
    updateBankStatementUi();
  }
  // v3.0.0 需求2a：原明细框 onConfirm 里的「退款优先互斥提醒」副作用迁移至此
  //   （成功路径末尾、状态框刷新之后再弹）。去框后若不迁移，退款/C3 提醒将永不触发（R-5）。
  //   仅本批确实含银行对账单成功时才触发（与原 onConfirm 条件一致）。
  if (hasBankStatementOk) {
    // v2.1.16-beta.6 需求C P0-4：先查退款订单导入提醒（与 C3 提醒互斥，退款优先；
    //   C3 在运行点 shouldPromptGatewayReconAtRun 还有兜底提醒，不会漏）。
    const refundPrompted = await maybePromptRefundOrderImport(results);
    if (!refundPrompted) maybePromptGatewayReconImport();
  }
  } finally {
    // v3.0.11 需求3（批1）：清 inflight + 退订进度 + 复位按钮（覆盖 cancelled / 失败 / 成功各早返回路径）。
    state.bankStatementInflight = false;
    if (typeof importUnsubscribe === 'function') {
      try { importUnsubscribe(); } catch (_e) { /* swallow */ }
    }
    if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = false;
    updateBankStatementRunBtnDisabled();
    updateBankStatementExportButtonsDisabled();
  }
}

// v3.0.0 需求2b 🔴🔴 资金红线：C3 网关行数据源 v2.1.16-beta.2 已切到链接表 gateway-bill，
//   故「数据就绪判据」从旧 gatewayReconSession（死路径，引擎不消费）改向链接表 gateway-bill rowCount。
//   判据严格 rowCount>0 才算就绪（链接表空 = 未就绪 = 仍提醒）；任何异常（IPC reject / 返回非 ok）
//   一律按「未就绪」处理 → 返回 false → 调用方继续弹提醒（保守多提醒，绝不静默漏对账）。
async function isGatewayBillReady() {
  try {
    const r = await window.desktopApi.linkedTable.rowCount('gateway-bill');
    // 严格 >0：仅当 IPC 明确 ok 且 rowCount 严格大于 0 才算「就绪」。
    return !!(r && r.status === 'ok' && Number.isFinite(r.rowCount) && r.rowCount > 0);
  } catch (error) {
    // 🔴 异常按「未就绪」→ 仍提醒（保守防漏对账）。
    console.warn('isGatewayBillReady (gateway-bill rowCount) failed:', error);
    return false;
  }
}

// v3.0.0 需求3（PR-4 bug 修订）🔴 资金红线：退款 session「就绪判据」从前端缓存 state.refundOrderSession
//   改为实时查 main 端 session-status 的 hasRefundOrder。原缓存仅在 refreshBankStatementStatus 刷新，
//   纯退款表批次（hasBankStatementOk=false）不调该 IPC → 缓存滞后 → 运行点误判重复弹退款提醒。
//   与 isGatewayBillReady 同款保守写法：仅当 status==='ok' 且 hasRefundOrder 为真才算就绪；
//   任何异常（IPC reject / 返回非 ok）一律按「未就绪」→ 返回 false → 调用方继续提醒（保守防漏回填）。
async function isRefundOrderReady() {
  try {
    const status = await window.desktopApi.bankStatement.sessionStatus();
    return !!(status && status.status === 'ok' && status.hasRefundOrder);
  } catch (error) {
    // 🔴 异常按「未就绪」→ 仍提醒（保守）。
    console.warn('isRefundOrderReady (session-status hasRefundOrder) failed:', error);
    return false;
  }
}

// v3.0.4 块 A · A2 #3（修「链接表报错全链路零落盘」）：C3/运行前提醒两个入口调 linkedTable.import() 后
//   返回值原被直接丢弃，用户对失败完全无感。本 helper 消费返回值：存在失败项 → 弹 alert 列 per-file 失败明细。
//   失败状态集与 main 侧 handler 一致（read-error / write-error / ambiguous / unrecognized）。
//   日志依赖 main 侧 handler 权威落盘（#1），故 alert 走 skipLogReport:true 避免双写。
//   result 为空 / cancelled / status!=='ok' / 无失败项 → 不弹（沿用既有静默语义）。
function notifyLinkedTableImportFailures(result) {
  if (!result || result.status !== 'ok' || !Array.isArray(result.results)) return;
  const FAILED_STATUSES = new Set(['read-error', 'write-error', 'ambiguous', 'unrecognized']);
  const failed = result.results.filter((r) => FAILED_STATUSES.has(r.status));
  if (failed.length === 0) return;
  const lines = failed
    .map((r) => `${escapeHtml(r.fileName || '')}：${escapeHtml(r.message || r.status || '')}`)
    .join('<br>');
  openModal(createAlertDialog(
    `链接表导入有 ${failed.length}/${result.results.length} 个文件失败：<br>${lines}`,
    { skipLogReport: true }
  ));
}

async function maybePromptGatewayReconImport() {
  try {
    const list = await window.desktopApi.scenarios.list();
    const scenarios = (list && list.status === 'ok' && Array.isArray(list.scenarios)) ? list.scenarios : [];
    const hasC3Enabled = scenarios.some((s) => s.category === 'gateway-recon-join' && (s.enabled === 1 || s.enabled === true));
    if (!hasC3Enabled) return;
    // v3.0.0 需求2b：改向链接表 gateway-bill —— 有数据（rowCount>0）才不提醒；空/异常则继续提醒。
    if (await isGatewayBillReady()) return;
    // v2.1.12 需求6：数据侧预检 — 启用 C3 但本次导入数据无候选行（无满足银行条件的行）→ 不弹提示
    const cc = await window.desktopApi.bankStatement.c3CandidateCount();
    if (!cc || cc.status !== 'ok' || !(cc.candidateCount > 0)) return;
    openModal(createConfirmDialog({
      message: '已启用「资金对账不平」类场景，C3 需要网关对账单。<br>请在「链接表管理」导入网关对账单。',
      confirmText: '导入文件',
      cancelText: '稍后再说',
      onConfirm: async () => {
        closeModal();
        // v3.0.0 需求2b：改调链接表导入对话框（不再调死链 handleBankStatementImportGatewayRecon）。
        //   与原死链行为一致：导入后刷新状态框（refreshBankStatementStatus）。
        // v3.0.4 块 A · A2 #3：消费导入返回值，存在失败项 → 弹 per-file 失败明细（日志依赖 main 侧 handler）。
        const importResult = await window.desktopApi.linkedTable.import();
        notifyLinkedTableImportFailures(importResult);
        await refreshBankStatementStatus();
      }
    }));
  } catch (error) {
    console.warn('maybePromptGatewayReconImport failed:', error);
  }
}

// v2.1.16-beta.6 需求C P0-4（规则一）：启用「中台退款订单回填」场景、但本批未导入退款订单表 → 弹提醒。
//   返回 true=弹了提醒（调用方据此与 C3 提醒互斥）。
//   场景启用判断依赖 name（listScenarios 不返 config_json → 无 subCategory）；name 是 builtin seed
//   写死常量 REFUND_BACKFILL_SCENARIO.name='中台退款订单回填'，稳定；误判仅影响 UX 提示、不碰资金。
async function maybePromptRefundOrderImport(results) {
  try {
    const list = await window.desktopApi.scenarios.list();
    const scenarios = (list && list.status === 'ok' && Array.isArray(list.scenarios)) ? list.scenarios : [];
    const enabled = scenarios.some((s) =>
      s.name === '中台退款订单回填' && (s.enabled === 1 || s.enabled === true));
    if (!enabled) return false;
    // 本批已识别到退款订单表（落 session）→ 不提醒（规则一「带该表则不弹」）
    const hasRefundOk = (results || []).some((r) => r.tableKey === 'zhongtai-refund-order' && r.status === 'ok');
    if (hasRefundOk) return false;
    // v3.0.0 需求3：候选预检门控（对齐 C3 c3CandidateCount 范式）——
    //   本批银行对账单无 FundType=Ach Return 候选行 → 退款回填无对象 → 不弹（避免无退款数据时误打扰）。
    //   IPC 异常/返回非 ok → candidateCount 视为 0 → 不弹（退款提醒非资金红线，无候选不弹是合理保守）。
    const rc = await window.desktopApi.bankStatement.refundCandidateCount();
    if (!rc || rc.status !== 'ok' || !(rc.candidateCount > 0)) return false;
    // v3.0.0 需求3：样式对齐 C3 —— createAlertDialog 单按钮 → createConfirmDialog 两按钮（导入文件 / 稍后再说）。
    //   「导入文件」→ closeModal + handleBankStatementBatchImport（调起《导入对账单》批量导入，不续跑，让用户导完再运行）。
    openModal(createConfirmDialog({
      message: '已启用「中台退款订单回填」场景，但本次未导入「中台退款订单表」。<br>继续运行将跳过退款回填。',
      confirmText: '导入文件',
      cancelText: '稍后再说',
      onConfirm: async () => {
        closeModal();
        await handleBankStatementBatchImport();
      }
      // onCancel 默认仅 closeModal（不续跑）
    }));
    return true;
  } catch (error) {
    console.warn('maybePromptRefundOrderImport failed:', error);
    return false;
  }
}

async function handleBankStatementImportGatewayRecon() {
  try {
    const result = await window.desktopApi.bankStatement.importGatewayRecon();
    if (!result) return false;
    if (result.status === 'cancelled') return false;
    if (result.status === 'invalid') {
      const detail = (result.detailLines || []).map((l) => `• ${l}`).join('<br>');
      openModal(createAlertDialog(`${result.message || '文件校验失败'}<br>${detail}`));
      return false;
    }
    if (result.status !== 'ok') {
      openModal(createAlertDialog(`导入失败：${result.message || '未知错误'}`));
      return false;
    }
    state.bankStatementExport = null;  // 重新导入 gw → 清掉「已导出」缓存
    // v3.0.0 需求2a：进入「导入网关」动作成功 → 清旧导入失败/跳过摘要。
    state.bankStatementImportIssues = null;
    await refreshBankStatementStatus();
    return true;
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`导入资金对账文件失败：${error.message || error}`));
    return false;
  }
}

// v2.1.16-beta.5 需求1（PR-4 修订）🔴🔴 资金红线（智能路由）：
//   资金对账面板 row1《开始运行》(bankStatementRunBtn) 的唯一入口。按面板模式 state.bankStatementProcessRunMode 分流：
//     - 'gateway'（最近一次导入不平表成功）→ handleBankStatementGatewayReconRun()（运行已启用 gateway-recon-id-fix 场景，含 JPM）
//     - 否则（'bank' / 默认 / 任何非 'gateway' 值）→ handleBankStatementRun()（R1-R5 银行对账单核心引擎）
//   保守默认：仅显式 === 'gateway' 才走网关；任何意外值（undefined/null/未知）一律 fallthrough 到 R1-R5 核心，绝不误入网关引擎。
//   两个被调函数体本次零改动，仅在此处分流；各自首行已自带 session 前置校验，路由层不重复校验。
async function handleBankStatementRunRouted() {
  try {
    if (state.bankStatementProcessRunMode === 'gateway') {
      await handleBankStatementGatewayReconRun();
    } else {
      await handleBankStatementRun();
    }
  } catch (error) {
    // 被调函数内部已 try/catch 所有路径，这里仅作最终防御（理论不可达）
    console.error('handleBankStatementRunRouted failed:', error);
  }
}

// v3.0.0 需求3 🔴🔴 资金红线（运行点链式编排）：退款先于 C3、但「互不吞」。
//   编排链：handleBankStatementRun → [退款运行点提醒] → proceedToGwCheck → [C3 运行点提醒] → runBankStatementInternal。
//   关键不变量：退款「直接运行」走 proceedToGwCheck()（★只跳退款、C3 仍单独提醒），绝不直接 runBankStatementInternal
//     —— 否则 C3 缺数据会被静默跳过 = 漏对账（TechDoc §6.4 + AC3-5）。
async function handleBankStatementRun() {
  if (!state.bankStatementSession) {
    openModal(createAlertDialog('请先导入银行对账单'));
    return;
  }
  try {
    // —— 退款运行点（先于 C3，但互不吞）——
    if (await shouldPromptRefundAtRun()) {
      openModal(createConfirmDialog({
        message: '已启用「中台退款订单回填」场景但未导入「中台退款订单表」。<br>继续运行将跳过退款回填。',
        confirmText: '导入文件',
        middleText: '直接运行',
        cancelText: '取消',
        onConfirm: async () => {
          closeModal();
          // 导入文件 → 调起《导入对账单》批量导入，不续跑（与导入框「导入文件」语义一致）。
          await handleBankStatementBatchImport();
        },
        onMiddle: async () => {
          closeModal();
          // ★ 只跳退款、继续查 C3（不是 runBankStatementInternal）——C3 缺数据仍会单独提醒。
          await proceedToGwCheck();
        }
        // onCancel 默认仅 closeModal，不运行
      }));
      return;
    }
    // 无退款提醒 → 直接进入 C3 检查段。
    await proceedToGwCheck();
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`运行失败：${error.message || error}`));
  }
}

// v3.0.0 需求3：抽出「C3 运行点检查段」（承载原 PR #33 dialog#2 + PR-3 改向链接表逻辑）。
//   被 handleBankStatementRun 直接调用（无退款提醒时）或退款「直接运行」回调调用（跳退款后继续查 C3）。
async function proceedToGwCheck() {
  // PR #33 Codex Finding 1：运行点 dialog#2 三选一（防止 import 后 dialog#1 选"稍后再说"后 C3 被静默跳过）
  const needGwReminder = await shouldPromptGatewayReconAtRun();
  if (needGwReminder) {
    openModal(createConfirmDialog({
      // v3.0.0 需求2b：文案改向链接表网关对账单（C3 取数已切链接表 gateway-bill）。
      message: '已启用「资金对账不平」类场景但未导入网关对账单（链接表）。<br>继续运行将跳过该类场景。',
      confirmText: '导入文件',
      middleText: '直接运行',
      cancelText: '取消',
      onConfirm: async () => {
        closeModal();
        // v3.0.0 需求2b：改调链接表导入对话框（不再调死链 handleBankStatementImportGatewayRecon），
        //   导入后刷新状态框、不自动续跑（与导入框「导入文件」语义一致，让用户导完再决定运行）。
        // v3.0.4 块 A · A2 #3：消费导入返回值，存在失败项 → 弹 per-file 失败明细（日志依赖 main 侧 handler）。
        const importResult = await window.desktopApi.linkedTable.import();
        notifyLinkedTableImportFailures(importResult);
        await refreshBankStatementStatus();
      },
      onMiddle: async () => {
        closeModal();
        await runBankStatementInternal();
      }
      // onCancel 默认仅 closeModal，不运行
    }));
    return;
  }
  await runBankStatementInternal();
}

// v3.0.0 需求3：退款运行点提醒判据（仿 shouldPromptGatewayReconAtRun）。
//   退款场景 enabled（按 name='中台退款订单回填'）+ 本批未导退款表（!isRefundOrderReady()）+ 退款候选>0 → 运行点弹三选一。
//   就绪判据（PR-4 bug 修订）：原读前端缓存 state.refundOrderSession，纯退款表批次缓存滞后误判重复提醒；
//   改为 isRefundOrderReady() 实时查 main 端 session-status hasRefundOrder（与 C3 isGatewayBillReady 一致）。
//   候选预检与导入后提醒一致（FundType=Ach Return 计数）；任何异常按「不提醒」（退款非资金红线，保守不打扰）。
async function shouldPromptRefundAtRun() {
  try {
    // 本批已导退款表（main 端 session 就绪）→ 不提醒。实时查，不读可能滞后的前端缓存。
    if (await isRefundOrderReady()) return false;
    const list = await window.desktopApi.scenarios.list();
    const scenarios = (list && list.status === 'ok' && Array.isArray(list.scenarios)) ? list.scenarios : [];
    const enabled = scenarios.some((s) =>
      s.name === '中台退款订单回填' && (s.enabled === 1 || s.enabled === true));
    if (!enabled) return false;
    // 退款候选预检 — 本批无 FundType=Ach Return 候选行 → 不提示跳过。
    const rc = await window.desktopApi.bankStatement.refundCandidateCount();
    return !!(rc && rc.status === 'ok' && rc.candidateCount > 0);
  } catch (error) {
    console.warn('shouldPromptRefundAtRun failed:', error);
    return false;
  }
}

async function shouldPromptGatewayReconAtRun() {
  // C3 启用 + 网关对账单（链接表）未就绪 → 运行点弹 dialog#2 三选一
  // v3.0.0 需求2b 🔴 资金红线：判据从旧 gatewayReconSession（死路径）改向链接表 gateway-bill rowCount。
  //   gateway-bill 有数据（rowCount>0，严格）→ return false（不提醒）；空/异常 → 不 return，继续判 c3 候选后提醒。
  try {
    if (await isGatewayBillReady()) return false;
    const list = await window.desktopApi.scenarios.list();
    const scenarios = (list && list.status === 'ok' && Array.isArray(list.scenarios)) ? list.scenarios : [];
    const hasC3Enabled = scenarios.some((s) => s.category === 'gateway-recon-join' && (s.enabled === 1 || s.enabled === true));
    if (!hasC3Enabled) return false;
    // v2.1.12 需求6：数据侧预检 — 启用 C3 但本次数据无候选行 → 不提示跳过
    const cc = await window.desktopApi.bankStatement.c3CandidateCount();
    return !!(cc && cc.status === 'ok' && cc.candidateCount > 0);
  } catch (error) {
    console.warn('shouldPromptGatewayReconAtRun failed:', error);
    return false;
  }
}

// v3.0.11 需求3（批1 · 导入不阻塞）：import 进度文案映射（仿 formatBankStatementRunProgress）。
//   事件形态复用 run 形态 { stage:'reading', fileIndex, fileCount, filePath }；纯展示，未识别返回 null（不刷状态框）。
function formatBankStatementImportProgress(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.stage === 'reading') {
    const idx = Number.isFinite(ev.fileIndex) ? ev.fileIndex + 1 : null;
    const total = Number.isFinite(ev.fileCount) ? ev.fileCount : null;
    if (idx && total && total > 1) return `正在导入第 ${idx}/${total} 个文件…`;
    return '正在导入文件…';
  }
  return null;
}

// v3.0.8 需求3（运行不阻塞）：run 进度文案映射（stage = handler 阶段边界；round = 编排器轮次边界）。
//   纯展示文案，无数据语义；未识别的事件返回 null（不刷状态框）。仿收单 formatAcquiringBillCurrencyProgress 范式。
function formatBankStatementRunProgress(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const STAGE_LABELS = {
    prepare: '正在准备数据…',
    // v3.0.11 需求3（批2 · run 数据准备让出）：准备阶段细分文案（与 main.js yieldRun stage key 一一对应）。
    //   （codex-P2 补强：linked-table 写入已纳入 op-lock → run 持锁期间并发改表被挡 → 读取间让出仍快照一致，故三处让出齐备。）
    'prepare-clone-bank': '正在准备数据（银行流水）…',
    'prepare-gw': '正在准备数据（网关账单）…',
    'prepare-linked': '正在准备数据（关联表）…',
    reconcile: '正在执行对账…'
  };
  const ROUND_LABELS = {
    R1: '正在匹配对账号（R1）…',
    R2: '正在执行场景调度（R2）…',
    'R3.5': '正在校验 DBS-Charge 资金（R3.5）…',
    R4: '正在校验资金性质（R4）…',
    R5s2: '正在回填资金划转（R5）…',
    R5s2b: '正在回填线下调拨（R5）…',
    R5s3: '正在生成剔除清单（R5）…',
    // v3.0.12：R5 退款回填后、M2M 异常-人工判断检测后各补一次让出（编排器 yieldTick），对应进度文案。
    R5s4: '正在回填退款订单（R5）…',
    M2M: '正在排查多对多异常（人工复核）…'
  };
  if (ev.stage && STAGE_LABELS[ev.stage]) return STAGE_LABELS[ev.stage];
  if (ev.round && ROUND_LABELS[ev.round]) return ROUND_LABELS[ev.round];
  return null;
}

async function runBankStatementInternal() {
  // v3.0.11 需求3（批1 · 按钮禁用统一闸）：本函数是「实际运行」最内层入口（前序 confirm dialog 由 modal 全屏遮罩挡住重入，
  //   主进程统一 op-lock 兜底真并发）。最外层设 inflight → 运行/导出按钮禁用；最内层 finally 清，避免穿过 dialog 回调清理导致按钮卡死。
  state.bankStatementInflight = true;
  updateBankStatementRunBtnDisabled();
  updateBankStatementExportButtonsDisabled();
  // v3.0.11 需求3（批1）：运行期也禁用《导入对账单》——否则运行中点导入，导入 handler 的 finally 会误清共享 inflight、
  //   让运行/导出按钮中途复活（inflight 是三入口共享布尔）。
  if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = true;
  // v3.0.8 需求3：订阅 run 进度事件，运行期把轮次文案刷进状态框（仿收单 handleAcquiringBillCurrencyRun）；
  //   finally 必须 unsubscribe 避免 listener 泄漏。进度文案是瞬态展示，run 完成后 refreshBankStatementStatus 覆盖回最终态。
  let unsubscribe = null;
  try {
    const api = window.desktopApi && window.desktopApi.bankStatement;
    if (api && typeof api.onRunProgress === 'function') {
      unsubscribe = api.onRunProgress((ev) => {
        const text = formatBankStatementRunProgress(ev);
        if (text && elements.bankStatementStatusBox) {
          updateStatusBox(elements.bankStatementStatusBox, text, 'info');
        }
      });
    }
  } catch (_e) { /* swallow — 订阅失败不影响 run */ }

  try {
    const result = await window.desktopApi.bankStatement.run();
    if (!result || result.status !== 'ok') {
      openModal(createAlertDialog(`运行失败：${result?.message || '未知错误'}`));
      return;
    }
    state.bankStatementExport = null;  // 重新运行 → 清掉「已导出」缓存
    // v3.0.0 需求2a：进入「已处理」动作 → 清旧导入失败/跳过摘要（已过时，避免和处理结果文案叠加）。
    state.bankStatementImportIssues = null;
    // 运行成功不再弹 alert，处理结果（命中场景 ids / 警告数 / skippedC3）由 updateBankStatementUi
    // 通过 refreshBankStatementStatus 拉到的 stats 一并展示在状态框
    await refreshBankStatementStatus();
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`运行失败：${error.message || error}`));
  } finally {
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch (_e) { /* swallow */ }
    }
    // v3.0.11 需求3（批1）：清 inflight + 复位按钮（refreshBankStatementStatus 已在 inflight=true 时重算过，此处再算一次回到可用态）。
    state.bankStatementInflight = false;
    if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = false;
    updateBankStatementRunBtnDisabled();
    updateBankStatementExportButtonsDisabled();
  }
}

async function handleBankStatementExport() {
  if (!state.processingResult) {
    openModal(createAlertDialog('请先点击"开始运行"处理对账单'));
    return;
  }
  // v3.0.11 需求3（批1 · 按钮禁用统一闸）：最外层设 inflight → 运行/导出按钮禁用；finally 清。
  state.bankStatementInflight = true;
  updateBankStatementRunBtnDisabled();
  updateBankStatementExportButtonsDisabled();
  // v3.0.11 需求3（批1）：导出期也禁用《导入对账单》（理由同运行：防导入 handler finally 误清共享 inflight）。
  if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = true;
  try {
    const result = await window.desktopApi.bankStatement.export();
    if (!result) return;
    if (result.status === 'cancelled') return;
    if (result.status === 'failed') {
      openModal(createAlertDialog(`导出失败：${result.message || '未知错误'}`));
      return;
    }
    if (result.status === 'empty') {
      // 无主输出 → 把 empty 提示与 error-report 名一并写入状态框（不弹 alert）
      state.bankStatementExport = {
        mainFileName: result.message || '无修改记录，未生成主输出文件',
        errorReportName: result.errorReportName || null
      };
      // v3.0.0 需求2a：进入「导出」动作 → 清旧导入失败/跳过摘要（已过时）。
      state.bankStatementImportIssues = null;
      updateBankStatementUi();
      return;
    }
    if (result.status === 'ok') {
      state.bankStatementExport = {
        mainFileName: result.mainFileName || result.mainFilePath,
        errorReportName: result.errorReportName || null,
        // v3.0.7 需求1b：导出附带产物文件名（缺省/未生成 → null，状态框「已导出」分支按存在性追加）。
        //   main.js export 结果字段：platformCleanupName（R5 场景3 中台加款单剔除文件）/ refundBackfillName（R5 场景4 中台退款订单回填文件）。
        platformCleanupName: result.platformCleanupName || null,
        refundBackfillName: result.refundBackfillName || null
      };
      // v3.0.0 需求2a：进入「导出」动作 → 清旧导入失败/跳过摘要（已过时）。
      state.bankStatementImportIssues = null;
      updateBankStatementUi();
      return;
    }
    openModal(createAlertDialog(`未知导出状态：${JSON.stringify(result)}`));
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`导出失败：${error.message || error}`));
  } finally {
    // v3.0.11 需求3（批1）：清 inflight + 复位按钮（含 cancelled / empty / ok / failed 各早返回路径）。
    state.bankStatementInflight = false;
    if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = false;
    updateBankStatementRunBtnDisabled();
    updateBankStatementExportButtonsDisabled();
  }
}

// ===== v3.0.14：前置资金对账 =====

function updatePreFundReconciliationUi() {
  const uiState = state.preFundReconciliation;
  const status = uiState.session;
  const busy = uiState.inflight;
  const bank = status && status.bank;
  const temp = status && status.temporaryGateway;
  const linked = status && status.linkedGateway;
  const run = status && status.run;

  if (elements.preFundReconciliationImportBankBtn) elements.preFundReconciliationImportBankBtn.disabled = busy;
  if (elements.preFundReconciliationTempManagerBtn) elements.preFundReconciliationTempManagerBtn.disabled = busy;
  if (elements.preFundReconciliationScenarioSelect) elements.preFundReconciliationScenarioSelect.disabled = busy;
  if (elements.preFundReconciliationRunBtn) {
    elements.preFundReconciliationRunBtn.disabled = busy || !(status && status.canRun);
  }
  if (elements.preFundReconciliationExportBtn) {
    elements.preFundReconciliationExportBtn.disabled = busy || !(status && status.canExport);
  }
  if (!elements.preFundReconciliationStatusBox || busy) return;

  const tempBatchCount = Number(temp && temp.batchCount) || 0;
  const tempRowCount = Number(temp && temp.rowCount) || 0;
  const linkedRowCount = Number(linked && linked.rowCount) || 0;
  let text = '欢迎使用小助手';
  let tone = 'neutral';
  if (bank) {
    text = `已导入：${bank.fileName}（${Number(bank.inputRows) || 0} 行，可参与 ${Number(bank.participatingRows) || 0} 行）\n`
      + `网关数据：临时 ${tempBatchCount} 批/${tempRowCount} 行，链接表 ${linkedRowCount} 行`;
    tone = 'info';
  }
  if (run) {
    if (run.stale) {
      text = '结果已失效：数据来源发生变化，请重新运行';
      tone = 'error';
    } else {
      const summary = run.summary || {};
      text = `已完成：平账 ${Number(summary.matchedPairs) || 0} 行，不平 ${Number(summary.unmatchedBankRows) || 0} 行\n`
        + `银行排除：空ID ${Number(summary.bankExcludedEmptyIdRows) || 0} 行、零金额 ${Number(summary.bankSkippedZeroRows) || 0} 行、空渠道 ${Number(summary.bankEmptyChannelRows) || 0} 行\n`
        + `网关排除：空ID ${Number(summary.gatewayExcludedEmptyIdRows) || 0} 行、无效 ${Number(summary.gatewayInvalidRows) || 0} 行、重复折叠 ${Number(summary.gatewayCollapsedDuplicateRows) || 0} 行；未使用 ${Number(summary.unusedGatewayRows) || 0} 行、多候选ID组 ${Number(summary.gatewayConflictingSameIdGroups) || 0} 组`;
      tone = 'success';
    }
  }
  updateStatusBox(elements.preFundReconciliationStatusBox, text, tone);
}

async function refreshPreFundReconciliationStatus() {
  try {
    const status = await window.desktopApi.preFundReconciliation.sessionStatus();
    if (!status || status.status !== 'ok') {
      state.preFundReconciliation.session = null;
      updatePreFundReconciliationUi();
      if (elements.preFundReconciliationStatusBox) {
        updateStatusBox(
          elements.preFundReconciliationStatusBox,
          status && status.message ? status.message : '状态读取失败',
          'error'
        );
      }
      return;
    }
    state.preFundReconciliation.session = status;
  } catch (error) {
    state.preFundReconciliation.session = null;
    if (elements.preFundReconciliationStatusBox) {
      updateStatusBox(elements.preFundReconciliationStatusBox, error.message || String(error), 'error');
    }
  }
  updatePreFundReconciliationUi();
}

function beginPreFundReconciliationAction(message) {
  state.preFundReconciliation.inflight = true;
  updatePreFundReconciliationUi();
  if (elements.preFundReconciliationStatusBox) {
    updateStatusBox(elements.preFundReconciliationStatusBox, message, 'info');
  }
}

async function finishPreFundReconciliationAction() {
  state.preFundReconciliation.inflight = false;
  await refreshPreFundReconciliationStatus();
}

function showPreFundFailure(action, result) {
  const message = result && result.message ? result.message : '未知错误';
  const detailLines = result && Array.isArray(result.detailLines) ? result.detailLines : [];
  const details = detailLines.length > 0
    ? `<br/><br/>${detailLines.slice(0, 10).map((line) => escapeHtml(line)).join('<br/>')}`
    : '';
  openModal(createAlertDialog(`${escapeHtml(action)}失败：${escapeHtml(message)}${details}`));
}

async function handlePreFundImportBank() {
  beginPreFundReconciliationAction('正在导入银行对账单…');
  try {
    const result = await window.desktopApi.preFundReconciliation.importBank();
    if (!result || result.status === 'cancelled') return;
    if (result.status !== 'ok') showPreFundFailure('导入', result);
  } catch (error) {
    showPreFundFailure('导入', error);
  } finally {
    await finishPreFundReconciliationAction();
  }
}

async function handlePreFundImportMpt({ showFailures = true } = {}) {
  beginPreFundReconciliationAction('正在导入 MPT 网关账单…');
  let unsubscribe = null;
  try {
    const api = window.desktopApi.preFundReconciliation;
    if (typeof api.onImportProgress === 'function') {
      unsubscribe = api.onImportProgress((progress) => {
        const current = Number(progress && progress.current) || 0;
        const total = Number(progress && progress.total) || 0;
        const fileName = progress && progress.fileName ? `：${progress.fileName}` : '';
        updateStatusBox(elements.preFundReconciliationStatusBox, `正在导入账单 ${current}/${total}${fileName}`, 'info');
      });
    }
    const result = await api.importMpt();
    if (!result || result.status === 'cancelled') return result;
    if (result.status !== 'ok') {
      if (showFailures) showPreFundFailure('导入账单', result);
      return result;
    }
    const failures = Array.isArray(result.results)
      ? result.results.filter((item) => item.status !== 'ok')
      : [];
    if (showFailures && failures.length > 0) {
      const details = failures.map((item) => (
        `${escapeHtml(item.fileName || '文件')}：${escapeHtml(item.message || '导入失败')}`
      )).join('<br/>');
      openModal(createAlertDialog(`部分文件导入失败（${failures.length} 个）：<br/>${details}`));
    }
    return result;
  } catch (error) {
    if (showFailures) showPreFundFailure('导入账单', error);
    return { status: 'failed', message: error && error.message ? error.message : String(error) };
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
    await finishPreFundReconciliationAction();
  }
}

async function handlePreFundRun() {
  beginPreFundReconciliationAction('正在构建网关候选池…');
  let unsubscribe = null;
  try {
    const api = window.desktopApi.preFundReconciliation;
    if (typeof api.onRunProgress === 'function') {
      unsubscribe = api.onRunProgress((progress) => {
        let text = '正在运行前置资金对账…';
        if (progress && progress.stage === 'gateway-pool') text = `正在构建网关候选池：${Number(progress.current) || 0} 行`;
        if (progress && progress.stage === 'bank-match') text = `正在匹配银行账单：${Number(progress.current) || 0}/${Number(progress.total) || 0}`;
        if (progress && progress.stage === 'done') text = '正在汇总对账结果…';
        updateStatusBox(elements.preFundReconciliationStatusBox, text, 'info');
      });
    }
    const result = await api.run({ scenario: elements.preFundReconciliationScenarioSelect.value });
    if (!result || result.status !== 'ok') showPreFundFailure('运行', result);
  } catch (error) {
    showPreFundFailure('运行', error);
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
    await finishPreFundReconciliationAction();
  }
}

async function handlePreFundExport() {
  beginPreFundReconciliationAction('正在准备导出…');
  let unsubscribe = null;
  try {
    const api = window.desktopApi.preFundReconciliation;
    if (typeof api.onExportProgress === 'function') {
      unsubscribe = api.onExportProgress((progress) => {
        const text = progress && progress.stage === 'export-done'
          ? '正在校验导出文件…'
          : '正在按渠道导出文件…';
        updateStatusBox(elements.preFundReconciliationStatusBox, text, 'info');
      });
    }
    const result = await api.export();
    if (!result || result.status === 'cancelled') return;
    if (result.status !== 'ok') {
      showPreFundFailure('导出', result);
      return;
    }
    await finishPreFundReconciliationAction();
    const names = (result.files || []).map((file) => file.fileName).join('\n');
    updateStatusBox(
      elements.preFundReconciliationStatusBox,
      `已导出 ${Number(result.files && result.files.length) || 0} 个文件${names ? `\n${names}` : ''}`,
      'success'
    );
    return;
  } catch (error) {
    showPreFundFailure('导出', error);
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
    if (state.preFundReconciliation.inflight) await finishPreFundReconciliationAction();
  }
}

function applyPreFundReconciliationPanelPreviewState() {
  setCurrentModule(MODULES.preFundReconciliation.id, { persist: false });
  setTimeout(() => {
    state.preFundReconciliation.session = {
      status: 'ok',
      bank: null,
      temporaryGateway: { batchCount: 3, rowCount: 142202 },
      linkedGateway: { rowCount: 978430 },
      run: null,
      canRun: false,
      canExport: false
    };
    updatePreFundReconciliationUi();
  }, 200);
}

// ===== v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块（spec §六 / §七 / Q4 决策） =====
// PR-A 仅做骨架：sessionStatus 同步 + 主面板下拉 reload + 4 按钮 binding（导入/运行/导出 PR-B 落地）

async function refreshReconIdFixStatus() {
  try {
    const status = await window.desktopApi.reconIdFix.sessionStatus();
    if (!status || status.status !== 'ok') {
      state.reconIdFixSession = null;
      state.reconIdFixResult = null;
    } else {
      state.reconIdFixSession = status.hasFile
        ? { fileName: status.fileName, sheetCounts: status.sheetCounts || null }
        : null;
      state.reconIdFixResult = status.hasResult
        ? {
          fixedRowCount: status.resultStats ? Number(status.resultStats.fixedRowCount || 0) : 0,
          warningCount: status.resultStats ? Number(status.resultStats.warningCount || 0) : 0,
          unmatchedRowCount: status.resultStats ? Number(status.resultStats.unmatchedRowCount || 0) : 0
        }
        : null;
    }
  } catch (error) {
    console.error('refreshReconIdFixStatus failed:', error);
  }
  updateReconIdFixUi();
}

// 主面板"场景"下拉刷新（task A9）
// v2.1.0-beta.1 PR-A round 2 P2-1：场景管理 dialog 的 4 个成功路径（save / delete / toggle / close）
// 都汇集到本函数。除了刷新场景列表，还要把"运行结果 + 导出后状态"resync 一次：
//   - main 端的 scenarios:create/update/delete/toggle 已经清 `reconIdFixResult`（spec §六），
//     调 refreshReconIdFixStatus() 把 renderer 的 state 拉齐
//   - state.reconIdFixExport 是 renderer-only（main 不存），CRUD 之后主动清空避免显示
//     过期"已导出"文案。模块切换路径不清（用户跨模块切回应保留导出文案）。
//
// `options.scenariosChanged` 默认 true：场景管理 dialog 4 个成功路径都视为"可能有 CRUD 变更"，
// 走完整清理。模块切换调用方传 false → 仅 reload 列表 + sync session-status，不清 export。
async function reloadReconIdFixScenarios(options = { scenariosChanged: true }) {
  // v2.1.0-beta.3 T5：按 state.reconIdFixBillCategory 推导 targetCategory；账单类别为空时直接清空场景列表
  //   - 'business' → category='recon-id-fix'（单据子模式，v2.1.0-beta.1 已有）
  //   - 'gateway'  → category='gateway-recon-id-fix'（网关子模式，v2.1.0-beta.3 新增）
  //   - null       → 不拉场景（账单类别未选时主面板"场景"行已隐藏）
  const cat = state.reconIdFixBillCategory;
  const targetCategory = cat === 'gateway' ? 'gateway-recon-id-fix'
    : (cat === 'business' ? 'recon-id-fix' : null);

  if (!targetCategory) {
    state.reconIdFixScenarios = [];
    state.reconIdFixSelectedScenarioId = null;
  } else {
    try {
      const result = await window.desktopApi.scenarios.list();
      if (!result || result.status !== 'ok' || !Array.isArray(result.scenarios)) {
        state.reconIdFixScenarios = [];
      } else {
        state.reconIdFixScenarios = result.scenarios.filter((s) => s.category === targetCategory);
      }
      // 当前已选 id 已不存在 → 置 null
      if (state.reconIdFixSelectedScenarioId !== null
          && !state.reconIdFixScenarios.some((s) => s.id === state.reconIdFixSelectedScenarioId)) {
        state.reconIdFixSelectedScenarioId = null;
      }
      // v2.1.5 fix1.2：scenarios 加载完成后，如果当前未选场景且列表非空 →
      //   自动选第 1 个枚举值（user 反馈：N2 改动后 selectedIndex=-1 强迫用户主动点开下拉）
      //   下游 refreshReconIdFixStatus 在本函数末尾统一触发，与用户手动选场景副作用一致
      if (state.reconIdFixSelectedScenarioId === null && state.reconIdFixScenarios.length > 0) {
        state.reconIdFixSelectedScenarioId = state.reconIdFixScenarios[0].id;
      }
    } catch (error) {
      console.error('reloadReconIdFixScenarios failed:', error);
      state.reconIdFixScenarios = [];
      state.reconIdFixSelectedScenarioId = null;
    }
  }
  // 仅当调用方明确说"场景变更"时才清 renderer-only 的 reconIdFixExport
  // （reconIdFixResult 不在此处清——交给 refreshReconIdFixStatus 从 main 拉，避免与 main 不一致）
  if (options && options.scenariosChanged) {
    state.reconIdFixExport = null;
  }
  renderReconIdFixScenarioSelect();
  // 拉一次 main 端 session-status：若 main 已清 reconIdFixResult（任何 scenarios:* CRUD
  // 触发后必然清空），renderer 的 state.reconIdFixResult 跟着置 null
  if (typeof refreshReconIdFixStatus === 'function') {
    try {
      await refreshReconIdFixStatus();
    } catch (error) {
      console.warn('reloadReconIdFixScenarios → refreshReconIdFixStatus failed:', error);
      updateReconIdFixUi();
    }
  } else {
    updateReconIdFixUi();
  }
}

function renderReconIdFixScenarioSelect() {
  const select = elements.reconIdFixScenarioSelect;
  if (!select) return;
  // v2.1.0-beta.3 修订（用户反馈）：账单类别为空时场景下拉显示真空白（不显示 "请先在场景管理中创建" placeholder）
  const hasCategory = state.reconIdFixBillCategory === 'business' || state.reconIdFixBillCategory === 'gateway';
  if (!hasCategory) {
    // 档 1：账单类别为空 → 真空白（不变）
    select.innerHTML = '<option value=""></option>';
    select.disabled = true;
    select.value = '';
    return;
  }
  const scenarios = Array.isArray(state.reconIdFixScenarios) ? state.reconIdFixScenarios : [];
  if (scenarios.length === 0) {
    // 档 2：v2.1.5 N2 改 — 真空白（去掉"请先在场景管理中创建场景"提示）
    select.innerHTML = '<option value=""></option>';
    select.disabled = true;
    select.value = '';
    return;
  }
  // 档 3：v2.1.5 N2 改 — 直接列 scenarios（去掉"请选择场景"占位项）
  const opts = scenarios.map((s) => {
    const idStr = String(s.id);
    const name = String(s.name || '');
    // 简单 escape：避免 < / > / & / "
    const escapedName = name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<option value="${idStr}">${escapedName}</option>`;
  }).join('');
  select.innerHTML = opts;
  select.disabled = false;
  // 同步 select.value 与 state（reloadReconIdFixScenarios fix1.2 已保证 scenarios 非空时
  // state.reconIdFixSelectedScenarioId 必有值，此处直接 select.value = desired 即可）
  const desired = state.reconIdFixSelectedScenarioId !== null
    ? String(state.reconIdFixSelectedScenarioId)
    : '';
  select.value = desired;
}

function updateReconIdFixUi() {
  if (!elements.reconIdFixStatusBox) return;
  const session = state.reconIdFixSession;
  const result = state.reconIdFixResult;
  const exp = state.reconIdFixExport;
  const selectedId = state.reconIdFixSelectedScenarioId;
  const selectedScenario = selectedId !== null
    ? (state.reconIdFixScenarios || []).find((s) => s.id === selectedId)
    : null;
  const scenarioName = selectedScenario ? selectedScenario.name : '';

  let text;
  let tone = 'info';
  if (exp) {
    // Round 3：双文件导出时同时显示主+unmatched 文件名
    const parts = [];
    if (exp.mainFileName) parts.push(`主文件 ${exp.mainFileName}`);
    if (exp.unmatchedFileName) parts.push(`未匹配 ${exp.unmatchedFileName}`);
    text = parts.length > 0 ? `已导出 — ${parts.join(' / ')}` : '已导出';
    tone = 'success';
  } else if (result) {
    // Round 3：加 K 行未匹配档
    const unm = Number(result.unmatchedRowCount || 0);
    const baseText = `场景"${scenarioName}"运行完成；命中 ${result.fixedRowCount} 行修复，${result.warningCount} 行警告`;
    text = unm > 0 ? `${baseText}，${unm} 行未匹配` : baseText;
    tone = result.warningCount > 0 ? 'error' : 'success';
  } else if (session) {
    const counts = session.sheetCounts || {};
    text = `已导入 ${session.fileName}（${counts.business || 0} 行业务账单 / ${counts.opp || 0} 行对手账单）；请点击"开始运行"`;
    tone = 'info';
  } else if (selectedScenario) {
    text = `已选场景"${scenarioName}"，请点击"导入文件"`;
    tone = 'neutral';
  } else {
    text = '欢迎使用小助手';
    tone = 'neutral';
  }
  // v2.1.7 round 3 B5：走 updateStatusBox 入口（R3 wiring — spec §9.6.2）
  updateStatusBox(elements.reconIdFixStatusBox, text, tone);

  // 按钮可用性（spec §七 + Q4 决策）
  if (elements.reconIdFixImportBtn) elements.reconIdFixImportBtn.disabled = false;
  if (elements.reconIdFixRunBtn) {
    elements.reconIdFixRunBtn.disabled = !(session && selectedId !== null);
  }
  if (elements.reconIdFixExportBtn) {
    elements.reconIdFixExportBtn.disabled = !result;
  }
  // v2.1.0-beta.3 T4：账单类别为空时强制 disable 所有动作按钮 + 隐藏场景行
  // updateReconIdFixPanelVisibility 是最后一道 override（覆盖上面默认逻辑）
  updateReconIdFixPanelVisibility();
}

// v2.1.0-beta.3 T4：根据 state.reconIdFixBillCategory 控制行 2 wrapper 可见性 + 按钮可用性
// 调用时机：
//   1. updateReconIdFixUi 末尾（作为按钮可用性最终 override）
//   2. handleReconIdFixBillCategoryChange 切换账单类别时
//   3. setCurrentModule 切到 reconIdFix 模块时（同步 UI 选中态）
function updateReconIdFixPanelVisibility() {
  // v2.1.0-beta.3 T11 修订（按用户反馈）：账单类别为空时也保持所有按钮显示（按 beta.2 结构），仅 disabled，
  //   不再隐藏行 2 wrapper；行 2 始终 visible。
  const cat = state.reconIdFixBillCategory;
  const hasCategory = cat === 'business' || cat === 'gateway';

  // 账单类别为空时强制禁用所有按钮（覆盖 updateReconIdFixUi 的默认 enable 逻辑）
  if (!hasCategory) {
    if (elements.reconIdFixImportBtn) elements.reconIdFixImportBtn.disabled = true;
    if (elements.reconIdFixRunBtn) elements.reconIdFixRunBtn.disabled = true;
    if (elements.reconIdFixExportBtn) elements.reconIdFixExportBtn.disabled = true;
    if (elements.reconIdFixManageScenariosBtn) elements.reconIdFixManageScenariosBtn.disabled = true;
  } else {
    // 类别选定 → 场景管理按钮 enable；其他按钮（导入/运行/导出）由 updateReconIdFixUi 已设的状态决定
    if (elements.reconIdFixManageScenariosBtn) elements.reconIdFixManageScenariosBtn.disabled = false;
  }
}

// v2.1.0-beta.3 T4：账单类别切换 handler（持久化 + 级联清空 + UI 刷新）
// 级联清空规则参考 spec §3.1：切换时清 selectedScenarioId / Export / Session / Result
// 不动 import session 的 main 端状态（main 没有 clear 接口；下次导入自然覆盖）
async function handleReconIdFixBillCategoryChange(event) {
  const raw = event && event.target ? event.target.value : '';
  const newCat = (raw === 'business' || raw === 'gateway') ? raw : null;
  const prevCat = state.reconIdFixBillCategory;
  if (newCat === prevCat) return; // no-op

  // 1. 更新 state（先 state 后清空，避免清空逻辑读到旧 state）
  state.reconIdFixBillCategory = newCat;
  state.reconIdFixSelectedScenarioId = null;
  state.reconIdFixExport = null;
  state.reconIdFixSession = null;
  state.reconIdFixResult = null;

  // 2. 清 main 端 session/result + 持久化账单类别
  // v2.1.0-beta.3 PR #39 Codex#1（P2）：必须先清 main 端 session，否则下面 reloadReconIdFixScenarios →
  // refreshReconIdFixStatus → main 端 session-status 会拉回旧 session/result 进 renderer state，导致
  // 切换后 panel 仍显示旧文件/结果，Run/Export 按钮误启用（用 session.subMode vs scenario.category
  // 校验只能在用户实际触发 run 时优雅失败，UI 错觉问题仍在）
  try {
    await window.desktopApi.reconIdFix.clearSession();
  } catch (error) {
    console.warn('clear main reconIdFix session failed:', error);
  }
  try {
    await window.desktopApi.settings.setReconIdFixBillCategory(newCat);
  } catch (error) {
    console.warn('persist reconIdFixBillCategory failed:', error);
  }

  // 3. 重新加载场景列表（按新类别过滤；reloadReconIdFixScenarios 已按 state.reconIdFixBillCategory 推导 targetCategory — T5）
  if (newCat && typeof reloadReconIdFixScenarios === 'function') {
    try {
      await reloadReconIdFixScenarios({ scenariosChanged: true });
    } catch (error) {
      console.warn('reloadReconIdFixScenarios on category change failed:', error);
    }
  } else {
    // 类别清空 → 直接清场景下拉 + 触发 UI 重绘
    state.reconIdFixScenarios = [];
    if (typeof renderReconIdFixScenarioSelect === 'function') renderReconIdFixScenarioSelect();
    if (typeof updateReconIdFixUi === 'function') updateReconIdFixUi();
  }
}

// v2.1.0-beta.1 PR-B：4 个按钮 handler 接通真实 IPC（spec §七 + §三）
async function handleReconIdFixImport() {
  try {
    // v2.1.0-beta.3 T9：按主面板"账单类别"推导 subMode（'business' | 'gateway'）传给 main 端 reader
    const subMode = state.reconIdFixBillCategory === 'gateway' ? 'gateway' : 'business';
    const result = await window.desktopApi.reconIdFix.import({ subMode });
    if (!result || result.status === 'cancelled') {
      // 用户取消 — 状态保持
      return;
    }
    if (result.status === 'invalid') {
      const detail = Array.isArray(result.detailLines) && result.detailLines.length > 0
        ? `\n\n${result.detailLines.slice(0, 5).join('\n')}`
        : '';
      openModal(createAlertDialog(`导入失败：${result.message || '文件校验未通过'}${detail}`));
      return;
    }
    if (result.status !== 'ok') {
      openModal(createAlertDialog(`导入失败：${result.message || '未知错误'}`));
      return;
    }
    // 导入成功：刷新 main 端 session-status 同步 state
    state.reconIdFixExport = null; // 资金红线：导入新文件后清旧导出文案
    await refreshReconIdFixStatus();
  } catch (error) {
    openModal(createAlertDialog(`导入失败：${error && error.message ? error.message : error}`));
  }
}

async function handleReconIdFixRun() {
  // 防御兜底：理论上按钮已 disabled，此处再校验
  if (state.reconIdFixSelectedScenarioId === null) {
    openModal(createAlertDialog('请先选择场景'));
    return;
  }
  if (!state.reconIdFixSession) {
    openModal(createAlertDialog('请先点击"导入文件"'));
    return;
  }
  try {
    const result = await window.desktopApi.reconIdFix.run({
      scenarioId: state.reconIdFixSelectedScenarioId
    });
    if (!result || result.status !== 'ok') {
      openModal(createAlertDialog(`运行失败：${(result && result.message) || '未知错误'}`));
      return;
    }
    // 运行成功：清除"已导出"文案 + 刷新 session-status 同步 result
    state.reconIdFixExport = null;
    await refreshReconIdFixStatus();
  } catch (error) {
    openModal(createAlertDialog(`运行失败：${error && error.message ? error.message : error}`));
  }
}

async function handleReconIdFixExport() {
  try {
    const result = await window.desktopApi.reconIdFix.export();
    if (!result) {
      openModal(createAlertDialog('导出失败：未知错误'));
      return;
    }
    if (result.status === 'cancelled') {
      return;
    }
    if (result.status === 'empty') {
      openModal(createAlertDialog(result.message || '本次运行无修复记录，未生成文件'));
      return;
    }
    if (result.status !== 'ok') {
      // failed（含 stale-snapshot）→ refreshReconIdFixStatus 拉新状态
      // （main 已在 stale-snapshot 路径清 reconIdFixResult）
      openModal(createAlertDialog(`导出失败：${result.message || '未知错误'}`));
      await refreshReconIdFixStatus();
      return;
    }
    // 成功：缓存导出文件名（renderer-only，main 不存）+ 刷新 UI
    // Round 3：含 unmatched 双文件名
    state.reconIdFixExport = {
      mainFileName: result.mainFileName || '',
      mainFilePath: result.mainFilePath || '',
      unmatchedFileName: result.unmatchedFileName || '',
      unmatchedFilePath: result.unmatchedFilePath || ''
    };
    updateReconIdFixUi();
  } catch (error) {
    openModal(createAlertDialog(`导出失败：${error && error.message ? error.message : error}`));
  }
}

// ============================================================
// v2.1.16-beta.5 需求1（PR-4 修订）：资金对账「不平校验」运行接到网关 ReconID 修复链路
//   - 与「对账单 ReconID 修复」网关子模式共用 main 进程 reconIdFixSession（决策1）：
//     run/export 复用同一 session/引擎/导出。
//   - 网关场景运行：由 row1《开始运行》(bankStatementRunBtn) 按 mode 智能路由
//     （handleBankStatementRunRouted → mode='gateway' 时调 handleBankStatementGatewayReconRun()）。
//   - v3.0.7 需求2a（C2）：原 row2《导入不平表》/《导出文件》两按钮已随面板删除——
//     对应 handleBankStatementGatewayReconImport 及其绑定一并移除。网关不平表的导入改由
//     「链接表管理」+「对账单 ReconID 修复」面板入口承载；handleReconIdFixExport 保留（ReconID 修复面板共用）。
//   - ⚠️ 共用 session 语义：run 时 main 端按 session.subMode vs scenario.category 兜底校验（不一致提示重新导入），不会误跑。
// ============================================================

// 开始运行：取场景管理里「已启用」的 gateway-recon-id-fix 场景（含 JPM 调拨订单修复场景）运行。
//   - 0 个启用 → 提示去场景管理启用；1 个 → 直接跑；≥2 个 → 弹场景选择对话框让用户挑一个（决策2/3）。
//   - 前提：先导入不平表（main 端 reconIdFixSession 就位）。session 的 subMode 是否为 gateway 由 main 端 run 兜底校验。
//   - JPM 场景前提（渠道账单含 merchantId=6300156616）由引擎层 PR-3 处理：空结果 + 提示，前端透传 stats。
async function handleBankStatementGatewayReconRun() {
  try {
    // 1. 检查 main 端 session 是否就位（不依赖 renderer 侧 state.reconIdFixSession —— 资金对账面板不维护它）
    const sessionStatus = await window.desktopApi.reconIdFix.sessionStatus();
    if (!sessionStatus || sessionStatus.status !== 'ok' || !sessionStatus.hasFile) {
      openModal(createAlertDialog('请先点击"导入不平表"导入资金对账不平结果表'));
      return;
    }
    // 2. 取「已启用」的 gateway-recon-id-fix 场景
    const list = await window.desktopApi.scenarios.list();
    const scenarios = (list && list.status === 'ok' && Array.isArray(list.scenarios)) ? list.scenarios : [];
    const enabled = scenarios.filter((s) =>
      s.category === 'gateway-recon-id-fix' && (s.enabled === 1 || s.enabled === true));
    if (enabled.length === 0) {
      openModal(createAlertDialog('请先在网关对账单修复-场景管理启用场景'));
      return;
    }
    // 3. 0/1/≥2 分流
    if (enabled.length === 1) {
      await runGatewayReconScenario(enabled[0].id);
      return;
    }
    // ≥2 个：弹场景选择对话框让用户挑一个（资金对账面板无场景下拉，复用单选对话框范式）
    openModal(createGatewayReconScenarioPickerDialog({
      scenarios: enabled,
      onPick: async (scenarioId) => {
        closeModal();
        await runGatewayReconScenario(scenarioId);
      }
    }));
  } catch (error) {
    openModal(createAlertDialog(`运行失败：${error && error.message ? error.message : error}`));
  }
}

// 实际调 reconIdFix.run（与 handleReconIdFixRun 同一 IPC，共用 session/引擎）。
//   成功后 refreshReconIdFixStatus() 同步 result → renderer state（导出按钮亮 + 状态框反馈）。
async function runGatewayReconScenario(scenarioId) {
  try {
    const result = await window.desktopApi.reconIdFix.run({ scenarioId });
    if (!result || result.status !== 'ok') {
      openModal(createAlertDialog(`运行失败：${(result && result.message) || '未知错误'}`));
      // run 失败可能清了 main 端 result（stale 等），同步一次状态
      if (typeof refreshReconIdFixStatus === 'function') {
        await refreshReconIdFixStatus();
      }
      return;
    }
    // 运行成功：清旧导出文案 + 刷新 session-status 同步 result（让"导出文件"按钮可用）
    state.reconIdFixExport = null;
    if (typeof refreshReconIdFixStatus === 'function') {
      await refreshReconIdFixStatus();
    }
    const stats = result.stats || {};
    const fixedCount = Number(stats.fixedRowCount || 0);
    // v2.1.16-beta.5 需求1（PR-4）：警告数取 result.warnings 数组长度（run 返回 stats 无 warningCount，warnings 单独透传）
    const warningCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
    // 用弹框反馈（不写 bankStatementStatusBox，理由同导入）。
    const baseMsg = fixedCount > 0
      ? `运行完成，命中 ${fixedCount} 行网关修复。<br>请点击"导出文件"导出网关对账单修复文件。`
      // v3.0.4 块 E 需求3：0 命中兜底文案去 JPM merchantId 硬编码（BOC/JPM 通用，场景无关）。
      : '运行完成，本次无网关修复行。<br>（请核对场景渠道行与链接表/网关账单是否匹配，详见下方警告或操作日志。）';
    // v3.0.4 块 E 需求3（O2 拍板 / R7）：逐条显示前 5 条 warning 中文 message（手工 escape 后拼 <br>，防 innerHTML 注入——警告含表格数据值）。
    //   超 5 条尾缀「等 N 条，详见操作日志」；warnings 为 BOC 引擎产物时带 message，JPM 仅 code 时回退 code。
    let warnMsg = '';
    if (warningCount > 0) {
      const warns = Array.isArray(result.warnings) ? result.warnings : [];
      const shown = warns.slice(0, 5);
      const lines = shown.map((w) => `• ${escapeHtml((w && (w.message || w.code)) || '')}`);
      const tail = warningCount > 5 ? `<br>等 ${warningCount} 条，详见操作日志` : '';
      warnMsg = `<br><br>另有 ${warningCount} 条警告：<br>${lines.join('<br>')}${tail}`;
    }
    // 有警告 → 弹框按 warning 级上报（去 skipLogReport）；无警告维持 info 静默。
    const alertOpts = warningCount > 0
      ? { logLevel: 'warning', logDomain: 'gateway-recon-id-fix' }
      : { logLevel: 'info', skipLogReport: true };
    openModal(createAlertDialog(`${baseMsg}${warnMsg}`, alertOpts));
  } catch (error) {
    openModal(createAlertDialog(`运行失败：${error && error.message ? error.message : error}`));
  }
}

// ============================================================
// v2.1.2 T2：月度银行对账单BU回填校验 — UI 状态机 + IPC 调用
// PRD §3.2.5 数据流：[点导入文件] → [弹月份对话框] → [弹 2 次文件选择] → [导入] → [运行] → [导出]
// 状态机：[空闲] → [导入中] → [导入完成] → [运行中] → [运行完成] → [导出完成]
//        异常路径：[运行中] → [异常中断]（重新走「导入文件」流程）
// ============================================================

// v0.5: 状态模型简化 — 按钮 enable 不再依赖单一 currentSessionMonth；改为基于后端 ready/success 月份计数
const bankBuReconState = {
  readyMonthsCount: 0,    // 两侧都已导入的月份数（决定「开始运行」是否亮）
  successMonthsCount: 0   // 至少 1 个 success run 的月份数（决定「导出差异」是否亮）
};

function setBankBuReconStatus(message, tone = 'info') {
  if (!elements.bankBuReconStatusBox) return;
  updateStatusBox(elements.bankBuReconStatusBox, message, tone, {
    idleTitle: '欢迎使用小助手'
  });
}

function applyBankBuReconButtonState() {
  // 「导入文件」永远 enabled（点击后弹月份对话框，PRD §3.2.5 数据流第一步）
  if (elements.bankBuReconImportBtn) elements.bankBuReconImportBtn.disabled = false;
  // 「开始运行」：至少 1 个月份两侧都已导入（OPEN ISSUE Q2 拍板 A）
  if (elements.bankBuReconRunBtn) elements.bankBuReconRunBtn.disabled = bankBuReconState.readyMonthsCount === 0;
  // 「导出差异」：至少 1 个 success run（OPEN ISSUE Q5 拍板 A）
  if (elements.bankBuReconExportBtn) elements.bankBuReconExportBtn.disabled = bankBuReconState.successMonthsCount === 0;
}

async function refreshBankBuReconButtonAvailability() {
  try {
    const [ready, success] = await Promise.all([
      window.desktopApi.bankBuRecon.listReadyMonths().catch(() => []),
      window.desktopApi.bankBuRecon.listSuccessMonths().catch(() => [])
    ]);
    bankBuReconState.readyMonthsCount = Array.isArray(ready) ? ready.length : 0;
    bankBuReconState.successMonthsCount = Array.isArray(success) ? success.length : 0;
  } catch (_e) {
    bankBuReconState.readyMonthsCount = 0;
    bankBuReconState.successMonthsCount = 0;
  }
  applyBankBuReconButtonState();
}

// 切到本模块时拉服务器状态 → 同步按钮可用性
function restoreBankBuReconPanelState() {
  applyBankBuReconButtonState();
  setBankBuReconStatus('欢迎使用小助手', 'info');
  refreshBankBuReconButtonAvailability();
}

async function handleBankBuReconImport() {
  // PRD §3.2.5 数据流第一步：弹月份选择对话框（年+月两下拉，spec v0.3）
  openModal(createBankBuReconMonthPickerDialog({
    onConfirm: async (yearMonth) => {
      await pickFilesAndImport(yearMonth);
    },
    onCancel: () => {
      // 用户取消月份选择，状态栏不变
    }
  }));
}

async function pickFilesAndImport(yearMonth) {
  // PRD §3.2.5 数据流第 2-3 步：前端 Clear 风 modal 提示 → 调 IPC 单选文件
  // 流程：[prompt 1] → [pick pending] → [prompt 2] → [pick bank] → [import:run]

  // === 步骤 1：Pending 数据管理文件 ===
  openModal(createBankBuReconFileImportPromptDialog({
    title: '请导入 Pending 数据管理文件',
    detail: `接下来弹出的文件选择对话框中，请选择对应的 xlsx 文件（对账月份 ${yearMonth}）。`,
    onConfirm: async () => {
      const pendingRes = await window.desktopApi.bankBuRecon.pickPendingFile({ yearMonth });
      if (!pendingRes || pendingRes.status === 'cancelled') {
        setBankBuReconStatus(`${yearMonth}：已取消选择 Pending 数据管理文件`, 'info');
        return;
      }
      if (pendingRes.status === 'error') {
        setBankBuReconStatus(pendingRes.message || '选择 Pending 文件失败', 'error');
        return;
      }
      const pendingPath = pendingRes.filePath;

      // === 步骤 2：银行对账单文件 ===
      openModal(createBankBuReconFileImportPromptDialog({
        title: '请导入银行对账单文件',
        detail: `接下来弹出的文件选择对话框中，请选择对应的 xlsx 文件（对账月份 ${yearMonth}）。`,
        onConfirm: async () => {
          const bankRes = await window.desktopApi.bankBuRecon.pickBankFile({ yearMonth });
          if (!bankRes || bankRes.status === 'cancelled') {
            setBankBuReconStatus(`${yearMonth}：已取消选择银行对账单文件`, 'info');
            return;
          }
          if (bankRes.status === 'error') {
            setBankBuReconStatus(bankRes.message || '选择银行对账单文件失败', 'error');
            return;
          }
          const bankPath = bankRes.filePath;

          // === 步骤 3：导入 ===
          setBankBuReconStatus(`正在导入 ${yearMonth} 数据...`, 'info');
          const impResult = await window.desktopApi.bankBuRecon.runImport({
            yearMonth,
            pendingPath,
            bankPath
          });
          if (impResult.status === 'error') {
            const detail = impResult.detailLines && impResult.detailLines.length > 0
              ? '\n' + impResult.detailLines.join('\n')
              : '';
            setBankBuReconStatus(`导入失败：${impResult.message}${detail}`, 'error');
            return;
          }

          // 导入成功 → 刷新按钮可用性（readyMonths 可能新增此月）
          setBankBuReconStatus(
            `已导入 ${yearMonth}：Pending ${impResult.pendingCount} 行 / 银行对账单 ${impResult.bankCount} 行 — 点击「开始运行」对账`,
            'success'
          );
          await refreshBankBuReconButtonAvailability();
        },
        onCancel: () => {
          setBankBuReconStatus(`${yearMonth}：已取消导入`, 'info');
        }
      }));
    },
    onCancel: () => {
      setBankBuReconStatus(`${yearMonth}：已取消导入`, 'info');
    }
  }));
}

// v0.5: 「开始运行」流程 — 弹月份对话框 → 选月份 → 直接跑（无二次确认）
async function handleBankBuReconRun() {
  const readyMonths = await window.desktopApi.bankBuRecon.listReadyMonths().catch(() => []);
  if (!readyMonths || readyMonths.length === 0) {
    openModal(createAlertDialog('暂无可对账的月份。请先用「导入文件」按月份导入 Pending + 银行对账单两份源文件。'));
    return;
  }
  openModal(createBankBuReconReconcileDialog({
    readyMonths,
    defaultMonth: readyMonths[0],
    onConfirm: async (yearMonth) => {
      setBankBuReconStatus(`正在对账 ${yearMonth}...`, 'info');
      const result = await window.desktopApi.bankBuRecon.run({ yearMonth });
      if (result.status === 'error') {
        setBankBuReconStatus(`运行失败：${result.message}`, 'error');
        return;
      }
      // v0.8: 永远 status=success（不再有 failed_anomaly 中断分支）
      const s = result.stats;
      const nmTail = s.nmAnomalyCount > 0 ? ` / N:M 异常 ${s.nmAnomalyCount} 组` : '';
      const tone = s.buDiffCount > 0 || s.nmAnomalyCount > 0 ? 'info' : 'success';
      setBankBuReconStatus(
        `${yearMonth} 对账完成：成功 ${s.matchedCount} 行 / BU 差异 ${s.buDiffCount} 行 / Pending 未匹上银行 ${s.pendingUnmatched} 行 / 银行未匹上 Pending ${s.bankUnmatched} 行${nmTail}`,
        tone
      );
      await refreshBankBuReconButtonAvailability();
    },
    onCancel: () => {}
  }));
}

// v0.5: 「导出差异」流程 — 弹 export 弹窗 → radio (single/aggregate) → 弹另存为 → 写文件
async function handleBankBuReconExport() {
  const successMonths = await window.desktopApi.bankBuRecon.listSuccessMonths().catch(() => []);
  if (!successMonths || successMonths.length === 0) {
    openModal(createAlertDialog('暂无可导出的成功运行记录。请先用「开始运行」对账。'));
    return;
  }
  openModal(createBankBuReconExportDialog({
    successMonths,
    onConfirm: async (choice) => {
      // 弹另存为对话框拿 savePath
      const ts = formatBbrTimestampForFilename();
      const defaultFileName = choice.scope === 'aggregate'
        ? `月度银行对账单BU回填校验_汇总_${ts}.xlsx`
        : `月度银行对账单BU回填校验_${(choice.yearMonth || '').replace('-', '')}_${ts}.xlsx`;
      const pickRes = await window.desktopApi.bankBuRecon.pickSavePath({ defaultFileName });
      if (!pickRes || pickRes.status === 'cancelled') {
        setBankBuReconStatus('已取消导出', 'info');
        return;
      }
      if (pickRes.status === 'error') {
        setBankBuReconStatus(`选择保存路径失败：${pickRes.message}`, 'error');
        return;
      }
      const savePath = pickRes.savePath;

      setBankBuReconStatus('正在导出差异表...', 'info');
      let result;
      if (choice.scope === 'single') {
        result = await window.desktopApi.bankBuRecon.exportSingle({ runId: choice.runId, savePath });
      } else {
        result = await window.desktopApi.bankBuRecon.exportAggregate({ savePath });
      }

      if (result.status !== 'success') {
        setBankBuReconStatus(`导出失败：${result.message || '未知错误'}`, 'error');
        return;
      }
      setBankBuReconStatus(`差异表已生成：${result.filePath}`, 'success');

      // 汇总场景：若有 skippedMonths，弹 alert 提示（OPEN ISSUE Q7 拍板 A）
      if (choice.scope === 'aggregate' && Array.isArray(result.skippedMonths) && result.skippedMonths.length > 0) {
        openModal(createAlertDialog(
          `汇总完成。${result.skippedMonths.length} 个月份因数据异常或未运行成功未包含在汇总中：${result.skippedMonths.join(', ')}`
        ));
      }
    },
    onCancel: () => {}
  }));
}

function formatBbrTimestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ============================================================
// v2.1.12 需求1：VCC业务OP计算 — UI 状态机 + IPC 调用（spec §2 状态机 + §8 真实契约）
// 数据流：导入(pickFiles→scan→F1确认→computeAmounts) → 开始运行(F2 输入期初OP→save 落库) → 显示余额(F3)
// 资金红线🔴：金额计算全在后端（整数分）；前端仅透传 beginOp + 展示后端返回的金额字符串，绝不自行算钱。
// 会话态：scan/compute 中间结果缓存在 main 进程 vccOpCalcSession；前端 vccOpCalcState 标志位驱动按钮可用性。
// ============================================================

const vccOpCalcState = {
  scanned: false,          // scan + computeAmounts 成功（已统计完成但未落库）→「开始运行」亮
  balanceMonthsCount: 0,   // 已落库月份数（后端 listBalanceMonths().length）→「显示余额」亮
  yearMonth: '',           // F1/F2 展示用
  totalRows: 0,
  fileCount: 0,
  totals: null             // computeAmounts 返回的 totals（供 F2 展示）
};

function setVccOpCalcStatus(message, tone = 'info') {
  if (!elements.vccOpCalcStatusBox) return;
  updateStatusBox(elements.vccOpCalcStatusBox, message, tone, {
    idleTitle: '欢迎使用小助手'
  });
}

function applyVccOpCalcButtonState() {
  if (elements.vccOpCalcImportBtn) elements.vccOpCalcImportBtn.disabled = false;  // 永远 enable
  // 「开始运行」：已统计完成但未落库的当前会话才亮（spec §2.3）
  if (elements.vccOpCalcRunBtn) elements.vccOpCalcRunBtn.disabled = !vccOpCalcState.scanned;
  // 「显示余额」：后端至少 1 条已计算月份
  if (elements.vccOpCalcShowBalanceBtn) elements.vccOpCalcShowBalanceBtn.disabled = vccOpCalcState.balanceMonthsCount === 0;
}

async function refreshVccOpCalcButtonAvailability() {
  try {
    const months = await window.desktopApi.vccOpCalc.listBalanceMonths().catch(() => []);
    vccOpCalcState.balanceMonthsCount = Array.isArray(months) ? months.length : 0;
  } catch (_e) {
    vccOpCalcState.balanceMonthsCount = 0;
  }
  applyVccOpCalcButtonState();
}

// 切到本模块时拉后端状态 → 同步按钮可用性
function restoreVccOpCalcPanelState() {
  applyVccOpCalcButtonState();
  setVccOpCalcStatus('欢迎使用小助手', 'info');
  refreshVccOpCalcButtonAvailability();
}

// 「导入文件」：pickFiles → scan → F1 确认 → computeAmounts（统计发生额）
async function handleVccOpCalcImport() {
  const pickRes = await window.desktopApi.vccOpCalc.pickFiles().catch(() => null);
  if (!pickRes || pickRes.status === 'cancelled') {
    setVccOpCalcStatus('已取消选择文件', 'info');
    return;
  }
  if (pickRes.status !== 'success' || !Array.isArray(pickRes.filePaths) || pickRes.filePaths.length === 0) {
    setVccOpCalcStatus(pickRes.message || '选择文件失败', 'error');
    return;
  }

  // v2.1.12 流式改造（spec §9）：大文件读取期间订阅进度事件，状态框流式更新；finally 退订防 listener 泄漏
  setVccOpCalcStatus(`正在读取 ${pickRes.filePaths.length} 个文件...`, 'info');
  let unsubscribeProgress = null;
  if (typeof window.desktopApi.vccOpCalc.onScanProgress === 'function') {
    unsubscribeProgress = window.desktopApi.vccOpCalc.onScanProgress((data) => {
      const rows = (data && data.rows) || 0;
      setVccOpCalcStatus(`正在读取大文件… 已处理 ${(rows / 10000).toFixed(1)} 万行`, 'info');
    });
  }
  let scanRes;
  try {
    scanRes = await window.desktopApi.vccOpCalc
      .scan({ filePaths: pickRes.filePaths })
      .catch((e) => ({ status: 'error', message: e && e.message ? e.message : String(e) }));
  } finally {
    if (typeof unsubscribeProgress === 'function') unsubscribeProgress();
  }

  if (scanRes.status === 'rejected') {
    vccOpCalcState.scanned = false;
    applyVccOpCalcButtonState();
    showVccOpCalcErrorReport(scanRes.errorRows, scanRes.errorCount);
    setVccOpCalcStatus('导入被拒绝：数据存在异常（见错误报告）', 'error');
    return;
  }
  if (scanRes.status !== 'success') {
    vccOpCalcState.scanned = false;
    applyVccOpCalcButtonState();
    const detail = scanRes.detailLines && scanRes.detailLines.length > 0 ? '\n' + scanRes.detailLines.join('\n') : '';
    setVccOpCalcStatus(`导入失败：${scanRes.message || '未知错误'}${detail}`, 'error');
    return;
  }

  // scan 成功 → 弹 F1 确认框（展示月份 + 条数）
  openModal(createVccOpCalcConfirmDialog({
    yearMonth: scanRes.yearMonth,
    totalRows: scanRes.totalRows,
    fileCount: scanRes.fileCount,
    onConfirm: async () => {
      // F1 确认 → 后台统计发生额（computeAmounts，复用 main 会话缓存的 rows）
      setVccOpCalcStatus('正在统计发生额...', 'info');
      const compRes = await window.desktopApi.vccOpCalc
        .computeAmounts()
        .catch((e) => ({ status: 'error', message: e && e.message ? e.message : String(e) }));
      if (compRes.status === 'rejected') {
        vccOpCalcState.scanned = false;
        applyVccOpCalcButtonState();
        showVccOpCalcErrorReport(compRes.errorRows);
        setVccOpCalcStatus('统计被拒绝：数据存在异常（见错误报告）', 'error');
        return;
      }
      if (compRes.status !== 'success') {
        vccOpCalcState.scanned = false;
        applyVccOpCalcButtonState();
        setVccOpCalcStatus(`统计失败：${compRes.message || '未知错误'}`, 'error');
        return;
      }
      // 统计完成 → 缓存 totals + 亮「开始运行」
      vccOpCalcState.scanned = true;
      vccOpCalcState.yearMonth = compRes.yearMonth;
      vccOpCalcState.totals = compRes.totals;
      vccOpCalcState.fileCount = scanRes.fileCount;
      vccOpCalcState.totalRows = scanRes.totalRows;
      applyVccOpCalcButtonState();
      const t = compRes.totals || {};
      setVccOpCalcStatus(
        `统计完成：${compRes.yearMonth}：发生额出 ${t.totalOut}：发生额入 ${t.totalIn}：总发生额 ${t.totalAmount} — 点「开始运行」输入期初OP`,
        'success'
      );
    },
    onCancel: () => {
      setVccOpCalcStatus('已取消导入', 'info');
    }
  }));
}

// 「开始运行」：弹 F2（展示发生额 + 输入期初OP），点「计算」即调 save 落库（资金红线🔴 后端算 endOp）
async function handleVccOpCalcRun() {
  if (!vccOpCalcState.scanned || !vccOpCalcState.totals) {
    openModal(createAlertDialog('请先用「导入文件」选择流水并完成统计。'));
    return;
  }
  openModal(createVccOpCalcComputeDialog({
    totals: vccOpCalcState.totals,
    yearMonth: vccOpCalcState.yearMonth,
    onCompute: async (beginOp) => {
      // 资金红线🔴：beginOp 原样透传后端，后端整数分算 endOp = beginOp + 发生额 + 原子落库
      const saveRes = await window.desktopApi.vccOpCalc
        .save({ beginOp })
        .catch((e) => ({ status: 'error', message: e && e.message ? e.message : String(e) }));
      if (saveRes && saveRes.status === 'success') {
        // 落库成功 → 清会话态（灭「开始运行」）+ 刷新「显示余额」
        vccOpCalcState.scanned = false;
        vccOpCalcState.totals = null;
        setVccOpCalcStatus(
          `${saveRes.yearMonth} 运行完成：期初OP ${saveRes.beginOp} → 期末OP ${saveRes.endOp}（已保存）`,
          'success'
        );
        await refreshVccOpCalcButtonAvailability();
        return { status: 'success', endOp: saveRes.endOp };
      }
      return { status: 'error', message: (saveRes && saveRes.message) ? saveRes.message : '保存失败' };
    },
    onClose: () => {}
  }));
}

// 「显示余额」：弹 F3（月份下拉 + 查看），查看调 getBalance
async function handleVccOpCalcShowBalance() {
  const months = await window.desktopApi.vccOpCalc.listBalanceMonths().catch(() => []);
  if (!Array.isArray(months) || months.length === 0) {
    openModal(createAlertDialog('暂无已计算的月份。请先用「导入文件」+「开始运行」计算期末OP。'));
    return;
  }
  openModal(createVccOpCalcShowBalanceDialog({
    months,
    onView: async (yearMonth) => {
      return await window.desktopApi.vccOpCalc.getBalance({ yearMonth }).catch(() => null);
    },
    onClose: () => {}
  }));
}

// 整批拒绝错误报告（资金红线🔴 不静默跳过）：errorRows = [{ fileName, rowIndex, reason }]
// 用 createAlertDialog 多行展示（前 N 条 + 总数），与第5模块「整批拒绝」口径一致
function showVccOpCalcErrorReport(errorRows, errorCount) {
  const rows = Array.isArray(errorRows) ? errorRows : [];
  // 流式改造（spec §9）：errorRows 有上限（前 100 条），errorCount 是真实总数（百万行场景）
  const total = (typeof errorCount === 'number' && errorCount > rows.length) ? errorCount : rows.length;
  const MAX_SHOW = 20;
  const lines = rows.slice(0, MAX_SHOW).map((r) => {
    const fn = r && r.fileName ? `[${r.fileName}] ` : '';
    const ri = r && r.rowIndex ? `第 ${r.rowIndex} 行：` : '';
    return `${fn}${ri}${(r && r.reason) || ''}`;
  });
  let msg = `导入被拒绝，共 ${total} 处异常（资金计算不容静默跳过）：\n\n${lines.join('\n')}`;
  if (total > MAX_SHOW) msg += `\n\n... 其余 ${total - MAX_SHOW} 处略`;
  openModal(createAlertDialog(msg));
}

// ============================================================
// v2.1.3：业务OP数据核对 — UI 状态机 + IPC 调用
// PRD §3.3 数据流：导入 (业务OP + 流水) → 选 BU → 开始运行 → 导出（单日 / 区间）
// OPEN ISSUE 拍板固化点（PRD §6.1）：
//   #1 双重校验 + #5 整批拒绝 → 错误报告对话框
//   #8 年下拉 ±1 / 月 1-12 / 日 1-31 不联动
//   #11 续导确认对话框
//   #12 listReadyDates 前置 enable
//   #13 listSuccessDates 复用 v2.1.2 命名风格
// ============================================================

const bizOpReconState = {
  buList: [],           // [{buName, count}] 来自 imports.bu_name DISTINCT（保留原值不 normalize）
  selectedBu: '',       // 用户在 BU 下拉框选中的原值
  readyDates: [],       // [{date}] 当前 selectedBu 下三件齐日期
  successDates: []      // [{date, runId, runAt}] 当前 selectedBu 下 success 日期
};

function setBizOpReconStatus(message, tone = 'info') {
  if (!elements.bizOpReconStatusBox) return;
  // v2.1.7 round 2 R3：删除原 innerHTML hack（formatBizOpReconStatusHtml 覆盖）
  //   全局 updateStatusBox 已在 spec §8.4.2 加 String(message).replace(/：/g, '：\n')
  //   + 全局 CSS .status-box-text { white-space: pre-wrap } 识别 \n
  //   bizOpRecon 模块的「：」换行行为与原 hack 等价（textContent 路径，无 XSS 风险）
  //   formatBizOpReconStatusHtml 函数定义保留（renderer-dialogs.js preview 内部仍在用，不动）
  updateStatusBox(elements.bizOpReconStatusBox, message, tone, {
    idleTitle: '欢迎使用小助手'
  });
}

function applyBizOpReconButtonState() {
  // 「导入文件」永远 enabled
  if (elements.bizOpReconImportBtn) elements.bizOpReconImportBtn.disabled = false;
  // v2.1.3-fix1：BU 下拉框永远 enabled（buList 为空时仅 option 列表为空白 placeholder）
  if (elements.bizOpReconBuSelect) elements.bizOpReconBuSelect.disabled = false;
  // 「开始运行」：已选 BU + 该 BU 下至少 1 个 ready 日期
  if (elements.bizOpReconRunBtn) {
    elements.bizOpReconRunBtn.disabled = !(bizOpReconState.selectedBu && bizOpReconState.readyDates.length > 0);
  }
  // 「导出差异」：已选 BU + 该 BU 下至少 1 个 success 日期
  if (elements.bizOpReconExportBtn) {
    elements.bizOpReconExportBtn.disabled = !(bizOpReconState.selectedBu && bizOpReconState.successDates.length > 0);
  }
}

function renderBizOpReconBuSelect() {
  const sel = elements.bizOpReconBuSelect;
  if (!sel) return;
  // 清空旧 options
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  if (bizOpReconState.buList.length === 0) {
    // v2.1.3-fix1：buList 为空时仅 1 项空白 placeholder（option label 完全空白）
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '';
    sel.appendChild(opt);
    bizOpReconState.selectedBu = '';
    sel.value = '';
    return;
  }
  // v2.1.3-fix2.2：option label 仅 BU 名（去掉「（N 行）」附加值）
  // v2.1.3-fix2.3：buList 有数据时不再追加空白 placeholder（避免下拉空值项）
  for (const bu of bizOpReconState.buList) {
    const opt = document.createElement('option');
    opt.value = bu.buName;
    opt.textContent = bu.buName;
    sel.appendChild(opt);
  }
  // v2.1.3-fix2.3 smart preserve：
  //   - 若上次 selectedBu 仍在新 buList → 保留
  //   - 否则回到第一项（buList[0]）
  const stillExists = bizOpReconState.selectedBu
    && bizOpReconState.buList.some(b => b.buName === bizOpReconState.selectedBu);
  if (!stillExists) {
    bizOpReconState.selectedBu = bizOpReconState.buList[0].buName;
  }
  sel.value = bizOpReconState.selectedBu;
}

async function refreshBizOpReconButtonAvailability() {
  // 拉 BU 列表
  try {
    const bus = await window.desktopApi.bizOpRecon.listBu().catch(() => []);
    bizOpReconState.buList = Array.isArray(bus) ? bus : [];
  } catch (_e) {
    bizOpReconState.buList = [];
  }
  renderBizOpReconBuSelect();

  // 若已选 BU → 拉 ready + success；否则清空
  if (bizOpReconState.selectedBu) {
    try {
      const [ready, success] = await Promise.all([
        window.desktopApi.bizOpRecon.listReadyDates({ buName: bizOpReconState.selectedBu }).catch(() => []),
        window.desktopApi.bizOpRecon.listSuccessDates({ buName: bizOpReconState.selectedBu }).catch(() => [])
      ]);
      bizOpReconState.readyDates = Array.isArray(ready) ? ready : [];
      bizOpReconState.successDates = Array.isArray(success) ? success : [];
    } catch (_e) {
      bizOpReconState.readyDates = [];
      bizOpReconState.successDates = [];
    }
  } else {
    bizOpReconState.readyDates = [];
    bizOpReconState.successDates = [];
  }

  applyBizOpReconButtonState();
}

function restoreBizOpReconPanelState() {
  applyBizOpReconButtonState();
  setBizOpReconStatus('欢迎使用小助手', 'info');
  refreshBizOpReconButtonAvailability();
}

// ===== v2.1.6 Module B：收单单据币种校验（spec v0.8 §3.5 / §8，fix5 删月份下拉 + 月份选弹窗）=====

const acquiringBillCurrencyState = {
  latestMonth: null,    // 最近成功操作的月份（导入/运行/导出后回写，仅状态栏文案展示用）
  // v2.1.7 round 2 R4：当前正在执行的操作（'import' | 'run' | 'export' | null）
  //   切模块后 restoreAcquiringBillCurrencyPanelState 据此决定按钮 disabled
  //   防止用户切走→切回时按钮被无脑解禁，重复点击触发并发 IPC
  //   spec §8.5.2 / PRD §十三-R4
  inflightOperation: null
};

function setAcquiringBillCurrencyStatus(message, tone = 'info') {
  const box = elements.acquiringBillCurrencyStatusBox;
  if (!box) return;
  // v2.1.7 round 2 B5：走 updateStatusBox 入口（R3 wiring — 自动获中文「：」换行 + null 兜底）
  //   原现状直写 textEl.textContent = message + classList.add('is-' + tone) 是历史死代码
  //   （PM grep 验证：styles-gemini-extra.css 中 .acquiring-bill-currency-board .status-box[data-tone="success"]
  //    才是生效 CSS；is-* class 无对应 CSS 规则）
  //   改走 updateStatusBox 反而修复历史隐藏 bug：tone 真正生效（dataset.tone 联动 data-tone 属性选择器）
  //   spec §9.6.2 / §9.6.3
  updateStatusBox(box, message, tone);
}

// v2.1.7 F6：进度事件 → 状态框文案 helper（spec §6.5）
//   import 阶段：
//     - reading      → '正在导入 xxx.xlsx 文件 (i/n 个文件)'
//     - inserting    → '正在写入 xxx：已读取 N 行 (i/n 个文件)'
//   run 阶段：
//     - clearing-old-runs / computing-stats / inserting-run / sql-joining / writing-xlsx / updating-paths
//   未识别事件 → 返回空串（caller 跳过 setStatus，保留前一文案）
function formatAcquiringBillCurrencyProgress(ev) {
  if (!ev || !ev.phase) return '';
  if (ev.phase === 'import') {
    if (ev.stage === 'reading') {
      const i = (typeof ev.fileIndex === 'number') ? ev.fileIndex + 1 : '?';
      const n = ev.fileCount || '?';
      const file = ev.filePath ? String(ev.filePath).split(/[\\/]/).pop() : '?';
      return `正在导入 ${file} 文件 (${i}/${n} 个文件)`;
    }
    if (ev.stage === 'inserting') {
      const i = (typeof ev.fileIndex === 'number') ? ev.fileIndex + 1 : '?';
      const n = ev.fileCount || '?';
      const file = ev.sourceFile || '?';
      const c = (ev.importedCount || 0).toLocaleString();
      return `正在写入 ${file}：已读取 ${c} 行 (${i}/${n} 个文件)`;
    }
    return '';
  }
  if (ev.phase === 'run') {
    switch (ev.stage) {
      case 'clearing-old-runs': return '正在清理该月历史结果...';
      case 'computing-stats':   return '正在统计数据量...';
      case 'inserting-run':     return '正在初始化对账批次...';
      case 'sql-joining':       return '正在比对币种（耗时较长，请稍候）...';
      case 'writing-xlsx':      return '正在写入差异 Excel 文件...';
      case 'updating-paths':    return '正在收尾结果文件...';
      default: return `运行中：${ev.stage}`;
    }
  }
  return '';
}

function restoreAcquiringBillCurrencyPanelState() {
  setAcquiringBillCurrencyStatus('欢迎使用小助手', 'info');
  // fix5：删月份下拉后，按钮可用性不再依赖 selectedMonth，4 按钮均默认 enabled
  // v2.1.7 round 2 R4：若当前有 inflight 操作（用户切走前点了导入/运行/导出），保持按钮 disabled
  //   spec §8.5.2 — 防切回后用户重复点击触发并发 IPC（main 端 acquiringBillCurrencyOperationLock 兜底，renderer 端体感正确）
  setAcquiringBillCurrencyButtonsDisabled(!!acquiringBillCurrencyState.inflightOperation);
}

// fix1（spec §3.4）：两段式导入 handler — 首调若已有数据返回 overwrite-required，confirm 后二次调带 confirmOverwrite
// fix3：进入 handler 时禁用 4 个导入/运行/导出按钮，结束/异常时恢复，防止用户连点触发并发 IPC
function setAcquiringBillCurrencyButtonsDisabled(disabled) {
  const btns = [
    elements.acquiringBillCurrencyImportFlowBtn,
    elements.acquiringBillCurrencyImportBillBtn,
    elements.acquiringBillCurrencyRunBtn,
    elements.acquiringBillCurrencyExportBtn
  ];
  for (const b of btns) {
    if (b) b.disabled = disabled;
  }
}

// fix5：弹「选择对账月份」picker（复用 bankBuRecon 范式 createAcquiringBillCurrencyMonthPickerDialog）
// 返回 Promise<string|null>（'YYYY-MM' 或 null 表示取消）
function pickAcquiringBillCurrencyMonth(actionLabel) {
  return new Promise((resolve) => {
    openModal(createAcquiringBillCurrencyMonthPickerDialog({
      actionLabel,
      onConfirm: (yearMonth) => resolve(yearMonth),
      onCancel: () => resolve(null)
    }));
  });
}

async function runAcquiringBillCurrencyImport(kind) {
  const labelTable = kind === 'flow' ? '流水表' : '单据表';
  const apiCall = kind === 'flow'
    ? (payload) => window.desktopApi.acquiringBillCurrency.importFlow(payload)
    : (payload) => window.desktopApi.acquiringBillCurrency.importBill(payload);

  // 第 1 步：弹月份选择
  const monthKey = await pickAcquiringBillCurrencyMonth('导入');
  if (!monthKey) {
    setAcquiringBillCurrencyStatus('已取消导入', 'info');
    return;
  }

  // v2.1.7 round 2 R4：set inflight flag —— 在按钮 disable 之前那一刻（取消月份不设；spec §8.5.2 关键不变量）
  acquiringBillCurrencyState.inflightOperation = 'import';
  setAcquiringBillCurrencyButtonsDisabled(true);
  setAcquiringBillCurrencyStatus(`正在导入${labelTable}（${monthKey}）...`, 'info');

  // v2.1.7 F6：订阅 import 进度事件（spec §6.5）；finally 必须 unsubscribe 防内存泄漏
  let unsubscribe = null;
  try {
    const api = window.desktopApi && window.desktopApi.acquiringBillCurrency;
    if (api && typeof api.onImportProgress === 'function') {
      unsubscribe = api.onImportProgress((ev) => {
        const text = formatAcquiringBillCurrencyProgress(ev);
        if (text) setAcquiringBillCurrencyStatus(text, 'info');
      });
    }
  } catch (_e) { /* swallow — preload 异常不应中断业务流程 */ }

  try {
    // 第 2 步：调 IPC 选文件 + peek + 月份校验 + 导入
    const first = await apiCall({ monthKey });
    if (first.status === 'cancelled') {
      setAcquiringBillCurrencyStatus('已取消导入', 'info');
      return;
    }
    if (first.status === 'error') {
      const detail = (first.detailLines || []).slice(0, 3).join('；');
      setAcquiringBillCurrencyStatus(`${labelTable}导入失败：${first.message}${detail ? '（' + detail + '）' : ''}`, 'error');
      return;
    }

    let result = first;
    if (first.status === 'overwrite-required') {
      const ok = window.confirm(
        `检测到月份 ${first.monthKey} 已有 ${first.existingCount} 行${labelTable}数据。\n` +
        `点击「确定」将先清空该月份的${labelTable}数据，再导入本次选择的 ${first.filePaths.length} 个文件。\n` +
        `（仅清单侧数据，不影响该月份对账历史 / 差异结果）\n\n继续？`
      );
      if (!ok) {
        setAcquiringBillCurrencyStatus(`已取消覆盖导入（月份 ${first.monthKey} 数据保留）`, 'info');
        return;
      }
      setAcquiringBillCurrencyStatus(`正在覆盖导入${labelTable}（${monthKey}）...`, 'info');
      const second = await apiCall({ monthKey, filePaths: first.filePaths, confirmOverwrite: true });
      if (second.status === 'cancelled') {
        setAcquiringBillCurrencyStatus('已取消导入', 'info');
        return;
      }
      if (second.status === 'error') {
        const detail = (second.detailLines || []).slice(0, 3).join('；');
        setAcquiringBillCurrencyStatus(`${labelTable}覆盖导入失败：${second.message}${detail ? '（' + detail + '）' : ''}`, 'error');
        return;
      }
      result = second;
    }

    const overwriteNote = result.overwritten ? `（已清旧 ${result.deletedCount} 行）` : '';
    setAcquiringBillCurrencyStatus(
      `${labelTable}导入成功：月份 ${result.monthKey}，共 ${result.totalImported} 行${overwriteNote}`,
      'success'
    );
    acquiringBillCurrencyState.latestMonth = result.monthKey;
  } catch (e) {
    setAcquiringBillCurrencyStatus(`${labelTable}导入异常：${e.message || e}`, 'error');
  } finally {
    // v2.1.7 round 2 R4：清 inflight flag —— 必须先于 setAcquiringBillCurrencyButtonsDisabled(false)
    //   异常路径也要清；spec §8.5.2 关键不变量
    acquiringBillCurrencyState.inflightOperation = null;
    // v2.1.7 F6：显式 unsubscribe 防 listener 累积（切到其它模块再回来不报错）
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch (_e) { /* swallow */ }
    }
    setAcquiringBillCurrencyButtonsDisabled(false);
  }
}

async function handleAcquiringBillCurrencyImportFlow() {
  return runAcquiringBillCurrencyImport('flow');
}

async function handleAcquiringBillCurrencyImportBill() {
  return runAcquiringBillCurrencyImport('bill');
}

async function handleAcquiringBillCurrencyRun() {
  // fix5：弹月份选择 → run → 同步生成 diff + report
  const monthKey = await pickAcquiringBillCurrencyMonth('运行');
  if (!monthKey) {
    setAcquiringBillCurrencyStatus('已取消运行', 'info');
    return;
  }
  // v2.1.7 round 2 R4：set inflight flag（spec §8.5.2）
  acquiringBillCurrencyState.inflightOperation = 'run';
  setAcquiringBillCurrencyButtonsDisabled(true);
  setAcquiringBillCurrencyStatus(`正在对账（${monthKey}）...`, 'info');

  // v2.1.7 F6：订阅 run 进度事件（6 阶段）；finally 必须 unsubscribe
  let unsubscribe = null;
  try {
    const api = window.desktopApi && window.desktopApi.acquiringBillCurrency;
    if (api && typeof api.onRunProgress === 'function') {
      unsubscribe = api.onRunProgress((ev) => {
        const text = formatAcquiringBillCurrencyProgress(ev);
        if (text) setAcquiringBillCurrencyStatus(text, 'info');
      });
    }
  } catch (_e) { /* swallow */ }

  try {
    const result = await window.desktopApi.acquiringBillCurrency.run({ monthKey });
    if (result.status !== 'success') {
      setAcquiringBillCurrencyStatus(`对账失败：${result.message || ''}`, 'error');
      return;
    }
    acquiringBillCurrencyState.latestMonth = monthKey;
    const diffNote = result.diffFilePath ? `\n差异表：${result.diffFilePath}` : '';
    const reportNote = result.reportFilePath ? `\n结果表：${result.reportFilePath}` : '';
    setAcquiringBillCurrencyStatus(
      `对账完成（${monthKey}）：共 ${result.totalBillRows} 条，币种差异 ${result.mismatchRows} 条，未匹配 ${result.unmatchedRows} 条${diffNote}${reportNote}`,
      'success'
    );
  } catch (e) {
    setAcquiringBillCurrencyStatus(`对账异常：${e.message || e}`, 'error');
  } finally {
    // v2.1.7 round 2 R4：清 inflight flag（spec §8.5.2）
    acquiringBillCurrencyState.inflightOperation = null;
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch (_e) { /* swallow */ }
    }
    setAcquiringBillCurrencyButtonsDisabled(false);
  }
}

async function handleAcquiringBillCurrencyExport() {
  // fix5：弹月份选择 → 弹另存为对话框 → IPC fs.copyFile 已生成的 diff.xlsx
  const monthKey = await pickAcquiringBillCurrencyMonth('导出');
  if (!monthKey) {
    setAcquiringBillCurrencyStatus('已取消导出', 'info');
    return;
  }
  // v2.1.7 round 2 R4：set inflight flag（spec §8.5.2）
  acquiringBillCurrencyState.inflightOperation = 'export';
  setAcquiringBillCurrencyButtonsDisabled(true);
  setAcquiringBillCurrencyStatus(`正在导出差异表（${monthKey}）...`, 'info');
  try {
    const result = await window.desktopApi.acquiringBillCurrency.export({ monthKey });
    if (result.status === 'cancelled') {
      setAcquiringBillCurrencyStatus('已取消导出', 'info');
      return;
    }
    if (result.status !== 'success') {
      setAcquiringBillCurrencyStatus(`导出失败：${result.message || ''}`, 'error');
      return;
    }
    setAcquiringBillCurrencyStatus(`差异表已导出：${result.savedPath}`, 'success');
  } catch (e) {
    setAcquiringBillCurrencyStatus(`导出异常：${e.message || e}`, 'error');
  } finally {
    // v2.1.7 round 2 R4：清 inflight flag（spec §8.5.2）
    acquiringBillCurrencyState.inflightOperation = null;
    setAcquiringBillCurrencyButtonsDisabled(false);
  }
}

// preview 状态模拟（仅用于 preview 截图，不影响生产逻辑）
function applyAcquiringBillCurrencyPanelInitialPreviewState() {
  setCurrentModule(MODULES.acquiringBillCurrency.id, { persist: false });
  setAcquiringBillCurrencyStatus('欢迎使用小助手', 'info');
}

function applyAcquiringBillCurrencyPanelImportingPreviewState() {
  setCurrentModule(MODULES.acquiringBillCurrency.id, { persist: false });
  setAcquiringBillCurrencyStatus('流水表导入成功：月份 2026-03，共 4,873,210 行', 'success');
}

function applyAcquiringBillCurrencyPanelResultPreviewState() {
  setCurrentModule(MODULES.acquiringBillCurrency.id, { persist: false });
  if (elements.acquiringBillCurrencyRunBtn) elements.acquiringBillCurrencyRunBtn.disabled = false;
  if (elements.acquiringBillCurrencyExportBtn) elements.acquiringBillCurrencyExportBtn.disabled = false;
  setAcquiringBillCurrencyStatus(
    '对账完成：共 4,873,210 条，币种差异 1,247 条，未匹配 38 条',
    'success'
  );
}

function handleBizOpReconBuChange(e) {
  bizOpReconState.selectedBu = String(e.target.value || '');
  refreshBizOpReconButtonAvailability();
}

// 导入流程：业务OP → 续导确认 → 流水对账单
async function handleBizOpReconImport() {
  // 阶段一：业务OP
  await importBizOpStage();
}

async function importBizOpStage() {
  return new Promise((resolve) => {
    openModal(createBizOpReconDatePickerDialog({
      title: '选择业务OP所属日期',
      // v2.1.3-fix1.4：默认值 = 系统今天 - 1 天（按本地时区，自动滚月/滚年）
      defaultDate: getBizOpReconDefaultDate(),
      onConfirm: async (date) => {
        const pickRes = await window.desktopApi.bizOpRecon.pickBizOpFile({ date });
        if (!pickRes || pickRes.status === 'cancelled') {
          setBizOpReconStatus(`${date}：已取消选择业务OP文件`, 'info');
          resolve();
          return;
        }
        if (pickRes.status === 'error') {
          setBizOpReconStatus(pickRes.message || '选择业务OP文件失败', 'error');
          resolve();
          return;
        }
        setBizOpReconStatus(`正在导入业务OP ${date} 数据...`, 'info');
        const impResult = await window.desktopApi.bizOpRecon.runBizOpImport({
          date,
          filePath: pickRes.filePath
        });
        if (impResult.status === 'error') {
          const detail = impResult.detailLines && impResult.detailLines.length > 0
            ? '\n' + impResult.detailLines.join('\n')
            : '';
          setBizOpReconStatus(`业务OP 导入失败：${impResult.message}${detail}`, 'error');
          resolve();
          return;
        }
        if (impResult.status === 'rejected') {
          // v2.1.3-fix1.5：校验失败 → 不再弹错误报告对话框，状态框显示行数 + 失败报告路径
          const pathPart = impResult.errorReportPath
            ? `；失败报告：${impResult.errorReportPath}`
            : '';
          setBizOpReconStatus(
            `业务OP 校验失败：${impResult.errorRows.length} 行（整批拒绝）${pathPart}`,
            'error'
          );
          resolve();
          return;
        }
        // success
        setBizOpReconStatus(
          `业务OP（${date} / BU=${impResult.buName}）已导入 ${impResult.validCount} 行`,
          'success'
        );
        await refreshBizOpReconButtonAvailability();

        // #11 拍板 B：检查"库里仅一日数据"，弹续导确认
        const single = await window.desktopApi.bizOpRecon.checkSingleDay({ buName: impResult.buName });
        if (single && single.onlyOneDay) {
          openModal(createBizOpReconSecondImportPromptDialog({
            firstDate: date,
            onConfirm: async () => {
              // 再走一轮业务OP 导入
              await importBizOpStage();
              resolve();
            },
            onCancel: () => {
              setBizOpReconStatus(`已导入第 1 日数据（${date} / BU=${impResult.buName}），待手动再次点击导入。`, 'info');
              resolve();
            }
          }));
          return;
        }
        // 已有多日 → 进入流水阶段
        await importFlowStage();
        resolve();
      },
      onCancel: () => resolve()
    }));
  });
}

async function importFlowStage() {
  return new Promise((resolve) => {
    openModal(createBizOpReconDatePickerDialog({
      title: '选择流水对账单所属日期',
      // v2.1.3-fix2.5：默认值 = 系统今天 - 1 天（与业务OP日期 dialog 同源 helper）
      defaultDate: getBizOpReconDefaultDate(),
      onConfirm: async (date) => {
        // v3.0.2 需求1b：流水表支持批量多选，全部合并导入到同一日期（单进程单事务，会替换该日期已有流水）。
        const pickRes = await window.desktopApi.bizOpRecon.pickFlowFile({ date });
        if (!pickRes || pickRes.status === 'cancelled') {
          setBizOpReconStatus(`${date}：已取消选择流水对账单文件`, 'info');
          resolve();
          return;
        }
        if (pickRes.status === 'error') {
          setBizOpReconStatus(pickRes.message || '选择流水对账单文件失败', 'error');
          resolve();
          return;
        }
        // 取 filePaths（多文件数组）；兼容旧返回的 filePath（单数）。
        const flowFiles = Array.isArray(pickRes.filePaths) && pickRes.filePaths.length > 0
          ? pickRes.filePaths
          : (pickRes.filePath ? [pickRes.filePath] : []);
        if (flowFiles.length === 0) {
          setBizOpReconStatus(`${date}：未选择流水对账单文件`, 'info');
          resolve();
          return;
        }
        const fileCount = flowFiles.length;
        setBizOpReconStatus(
          `正在导入流水对账单 ${date} 数据（${fileCount} 个文件，将替换该日期已有流水）...`,
          'info'
        );
        const impResult = await window.desktopApi.bizOpRecon.runFlowImport({
          date,
          filePaths: flowFiles
        });
        if (impResult.status === 'error') {
          const detail = impResult.detailLines && impResult.detailLines.length > 0
            ? '\n' + impResult.detailLines.join('\n')
            : '';
          setBizOpReconStatus(`流水对账单 导入失败：${impResult.message}${detail}`, 'error');
          resolve();
          return;
        }
        if (impResult.status === 'rejected') {
          // v2.1.3-fix1.5：校验失败 → 不再弹错误报告对话框，状态框显示行数 + 失败报告路径
          // v3.0.2 需求1b：多文件任一行失败 → 整批拒绝（所有文件都不入库），错误报告聚合并标注来源文件名
          const pathPart = impResult.errorReportPath
            ? `；失败报告：${impResult.errorReportPath}`
            : '';
          setBizOpReconStatus(
            `流水对账单 校验失败：${impResult.errorRows.length} 行（整批拒绝）${pathPart}`,
            'error'
          );
          resolve();
          return;
        }
        // v3.0.2 需求1b：成功文案标注 N 个文件共 M 行（单文件时仍读得通：「1 个文件共 M 行」）。
        setBizOpReconStatus(
          `流水对账单（${date}）已导入 ${fileCount} 个文件共 ${impResult.totalCount} 行`,
          'success'
        );
        await refreshBizOpReconButtonAvailability();
        resolve();
      },
      onCancel: () => resolve()
    }));
  });
}

async function handleBizOpReconRun() {
  if (!bizOpReconState.selectedBu) {
    openModal(createAlertDialog('请先在下拉框中选择 BU。'));
    return;
  }
  const buName = bizOpReconState.selectedBu;
  // #12 拍板 A：列出 ready 日期
  const readyDates = await window.desktopApi.bizOpRecon.listReadyDates({ buName }).catch(() => []);
  if (!readyDates || readyDates.length === 0) {
    openModal(createAlertDialog(
      `BU=${buName} 暂无可对账日期。需要同时导入：T-1 业务OP + T-2 业务OP + T-1 流水对账单（同 BU），三件齐才会显示在此处。`
    ));
    return;
  }
  openModal(createBizOpReconReconcileDialog({
    readyDates,
    onConfirm: async (date) => {
      setBizOpReconStatus(`正在对账 ${buName} / ${date}...`, 'info');
      const result = await window.desktopApi.bizOpRecon.run({ date, buName });
      if (result.status === 'error') {
        setBizOpReconStatus(`运行失败：${result.message}`, 'error');
        return;
      }
      const s = result.stats;
      const tone = (s.amountDiffCount > 0 || s.t1NotT2Count > 0 || s.t2NotT1Count > 0) ? 'info' : 'success';
      setBizOpReconStatus(
        `${date} BU=${buName} 对账完成：测算金额差异 ${s.amountDiffCount} 笔 / T-1 有 T-2 无 ${s.t1NotT2Count} 笔 / T-2 有 T-1 无 ${s.t2NotT1Count} 笔 / 多 OP 账户 ${s.multiOpAccountCount} 个`
        + (s.t2AnomalyAccountCount > 0 ? ` / T-2 异常账户 ${s.t2AnomalyAccountCount} 个` : ''),
        tone
      );
      await refreshBizOpReconButtonAvailability();
    },
    onCancel: () => {}
  }));
}

async function handleBizOpReconExport() {
  if (!bizOpReconState.selectedBu) {
    openModal(createAlertDialog('请先在下拉框中选择 BU。'));
    return;
  }
  const buName = bizOpReconState.selectedBu;
  const successDates = await window.desktopApi.bizOpRecon.listSuccessDates({ buName }).catch(() => []);
  if (!successDates || successDates.length === 0) {
    openModal(createAlertDialog(`BU=${buName} 暂无可导出的成功运行记录。请先用「开始运行」对账。`));
    return;
  }
  openModal(createBizOpReconExportDialog({
    successDates,
    onConfirm: async (choice) => {
      // 默认文件名（#9 拍板 A）
      const ts = formatBbrTimestampForFilename();
      let defaultFileName;
      if (choice.scope === 'single') {
        const compact = (choice.date || '').replace(/-/g, '');
        defaultFileName = `业务OP数据核对_${buName}_${compact}_${ts}.xlsx`;
      } else {
        const sc = (choice.startDate || '').replace(/-/g, '');
        const ec = (choice.endDate || '').replace(/-/g, '');
        defaultFileName = `业务OP数据核对_${buName}_${sc}-${ec}_${ts}.xlsx`;
      }
      const pickRes = await window.desktopApi.bizOpRecon.pickSavePath({ defaultFileName });
      if (!pickRes || pickRes.status === 'cancelled') {
        setBizOpReconStatus('已取消导出', 'info');
        return;
      }
      if (pickRes.status === 'error') {
        setBizOpReconStatus(`选择保存路径失败：${pickRes.message}`, 'error');
        return;
      }
      const savePath = pickRes.savePath;
      setBizOpReconStatus('正在导出差异表...', 'info');
      let result;
      if (choice.scope === 'single') {
        result = await window.desktopApi.bizOpRecon.exportDate({ runId: choice.runId, savePath });
      } else {
        result = await window.desktopApi.bizOpRecon.exportDateRange({
          buName, startDate: choice.startDate, endDate: choice.endDate, savePath
        });
      }
      if (result.status !== 'success') {
        setBizOpReconStatus(`导出失败：${result.message || '未知错误'}`, 'error');
        return;
      }
      setBizOpReconStatus(`差异表已生成：${result.filePath}`, 'success');
      if (choice.scope === 'range' && Array.isArray(result.skippedDates) && result.skippedDates.length > 0) {
        openModal(createAlertDialog(
          `区间导出完成。${result.skippedDates.length} 个日期因未对账成功未包含在文件中：${result.skippedDates.join(', ')}`
        ));
      }
    },
    onCancel: () => {}
  }));
}

// v3.0.5 PR-5（Part B Phase 3）：启动窗口先行——两段式初始化。
//   initialize() = 入口：getInfo 若返回 initPending（main init 链未完，窗口已 loading 态显示）→ 渲染轻量骨架
//     （平台标识/UI 风格默认/版本号/「正在初始化…」状态）+ 订阅 app:init-done → 收到后重新 getInfo 拿全量
//     → applyFullInfo(info) 完成数据填充。若 getInfo 已全量（旧时序 / init 已完）→ 直接 applyFullInfo。
//   ⚠️ applyFullInfo 幂等性要求：onInitDone 只触发一次（main 只发一次），且收到时 init 已完 → getInfo 必全量。
async function initialize() {
  markRendererStartup(RENDERER_STARTUP_MARKS.initializeStart);
  markRendererStartup(RENDERER_STARTUP_MARKS.getInfoStart);
  const info = await window.desktopApi.app.getInfo();
  markRendererStartup(RENDERER_STARTUP_MARKS.getInfoDone);

  if (info && info.initPending) {
    // 轻量骨架（init 前）：平台标识 + UI 风格默认 + 版本号 + loading 状态文案。
    document.body.dataset.platform = (window.desktopApi && window.desktopApi.platform) || '';
    applyUiStyle();
    if (elements.appVersion) elements.appVersion.textContent = info.version || '';
    setStatus('正在初始化，请稍候…', 'info', { errorReportReady: false });
    // VACUUM 等阶段文案（B-D6）：升级首启优化数据库时显示「正在优化数据库…」。
    if (window.desktopApi.app.onInitProgress) {
      window.desktopApi.app.onInitProgress((payload) => {
        if (payload && payload.text) setStatus(payload.text, 'info', { errorReportReady: false });
      });
    }
    // init-done 后重新 getInfo 拿全量 → 完成数据填充（解绑一次性监听）。
    let off = null;
    const onDone = async () => {
      if (off) { try { off(); } catch (_e) { /* swallow */ } off = null; }
      try {
        const fullInfo = await window.desktopApi.app.getInfo();
        await applyFullInfo(fullInfo);
      } catch (err) {
        setStatus('初始化失败，请重启程序', 'error', { errorReportReady: false });
        console.error('applyFullInfo after init-done failed:', err);
      }
    };
    off = window.desktopApi.app.onInitDone(onDone);
    return;
  }

  // 旧时序 / init 已完：直接全量填充。
  await applyFullInfo(info);
}

async function applyFullInfo(info) {
  // v2.1.13 E2：注入平台标识，CSS 以 body[data-platform="win32"] 限定 Win 端 Noto Sans SC 字体（仅 Win 生效）
  document.body.dataset.platform = (window.desktopApi && window.desktopApi.platform) || '';
  applyUiStyle();
  drawBackgroundSpectrum();
  resetBackgroundPickerSelection();
  elements.appVersion.textContent = info.version;
  state.hasEnum = info.hasEnum;
  state.enumFileName = info.enumFileName || '';
  state.accountMappingCount = info.accountMappingCount || 0;
  state.hasErrorReport = Boolean(info.hasErrorReport);
  state.currencyOptions = Array.isArray(info.currencyOptions) ? info.currencyOptions.slice() : [];
  // v2.1.0-beta.3 T4：从持久化恢复对账单ReconID修复模块「账单类别」
  // v2.1.4 T4：DB 持久化为空（'' / null）时默认 'gateway' 并写回（O2 拍板）
  //   - 主面板下拉占位项 "请选择账单类别" 已删，UI 层不再可能为空；DB 历史空值在此一次性迁移
  if (info.reconIdFixBillCategory === 'business' || info.reconIdFixBillCategory === 'gateway') {
    state.reconIdFixBillCategory = info.reconIdFixBillCategory;
  } else {
    state.reconIdFixBillCategory = 'gateway';
    window.desktopApi?.settings?.setReconIdFixBillCategory?.('gateway').catch((error) => {
      console.warn('persist default reconIdFixBillCategory failed:', error);
    });
  }
  state.backgroundSettings = cloneBackgroundSettings(info.backgroundConfig);
  state.backgroundDraft = cloneBackgroundSettings(info.backgroundConfig);
  applyBackgroundSettings(state.backgroundSettings);
  resetNewAccountRows();
  markRendererStartup(RENDERER_STARTUP_MARKS.initialUiReady);
  markRendererStartup(RENDERER_STARTUP_MARKS.templatesRefreshStart);
  await refreshTemplates();
  markRendererStartup(RENDERER_STARTUP_MARKS.templatesRefreshDone);
  setExportAvailability({
    detailEnabled: false,
    balanceEnabled: false
  });
  setNewAccountExportAvailability(false);
  updateNewAccountGenerateAvailability();
  // v2.1.4 T3：启用列表（左上角切换菜单）由 enabledModules 决定，currentModule 必须在其中
  state.enabledModules = Array.isArray(info.enabledModules) && info.enabledModules.length > 0
    ? info.enabledModules
    : [MODULES.statementGenerator.id];
  renderTopModuleSwitcher();
  const restoredModuleId = state.enabledModules.includes(info.currentModule)
    ? info.currentModule
    : state.enabledModules[0];
  // v2.1.4 round 1 self-review I1：fallback 写回必须绕过 setCurrentModule 内部的 previousModuleId guard。
  //   state.currentModule 初值（renderer.js state 块）= MODULES.statementGenerator.id；当 fallback 目标
  //   恰好也是 'statement-generator' 时，setCurrentModule 内部 `previousModuleId !== moduleId` guard 会短路
  //   导致 persist 路径不发 IPC → DB 永久残留旧值（如 'biz-op-recon'），下次启动用户感知为"上次模块自动恢复"。
  //   修复：fallback 时直接调 IPC 写回 DB，setCurrentModule 走 persist=false 路径只更新 UI/state。
  if (restoredModuleId !== info.currentModule) {
    window.desktopApi?.settings?.setCurrentModule?.(restoredModuleId).catch((error) => {
      console.warn('persist fallback currentModule failed:', error);
    });
  }
  setCurrentModule(restoredModuleId, { persist: false });
  closeModuleMenu();
  await rendererPending.initialize();
  rendererPending.bindEvents();
  setStatus(getEnumStatusMessage(), state.hasEnum ? 'info' : 'error', {
    errorReportReady: false
  });
  // v1.5.3 R2（D15）：自有账号迁移失败告警，覆盖默认状态栏文案；
  // 保留到用户手动关闭或下一次 setStatus 被其它动作覆盖
  if (info.ownAccountsMigrationError) {
    setStatus(info.ownAccountsMigrationError, 'error', {
      errorReportReady: false
    });
  }
  setNewAccountStatus('请完整填写开户信息后点击生成', 'info', {
    errorReportReady: false,
    idleTitle: getNewAccountStatusTitle()
  });

  markRendererStartup(RENDERER_STARTUP_MARKS.eventsBindStart);
  elements.importTemplateBtn.addEventListener('click', handleImportTemplate);
  elements.manageTemplateBtn.addEventListener('click', () => {
    openModal(createTemplateManagerDialog());
  });
  elements.accountMappingBtn.addEventListener('click', handleOpenAccountMappings);
  elements.importFileBtn.addEventListener('click', handleImportFile);
  elements.exportDetailBtn.addEventListener('click', handleExportDetail);
  elements.exportBalanceBtn.addEventListener('click', handleExportBalance);
  elements.newAccountGenerateBtn.addEventListener('click', handleNewAccountGenerate);
  elements.newAccountExportBtn.addEventListener('click', handleNewAccountExport);
  // v2.0.0-beta.3：银行对账单处理模块按钮 binding
  // v2.1.0-beta.2 PR-A：场景管理传白名单 ['extract-recon-id','offset-bill-mark','gateway-recon-join']（C1/C2/C3）
  elements.bankStatementScenarioBtn.addEventListener('click', () => {
    openModal(createScenariosManagerDialog([
      'extract-recon-id',
      'offset-bill-mark',
      'gateway-recon-join',
      // v2.1.13 D-2：自带写死场景（builtin-fixed）在银行对账单入口可见（仅通用渠道，置顶）
      'builtin-fixed'
    ]));
  });
  // v2.1.16 A5：「导入对账单」按钮即批量入口（多选 + 按表头识别路由）。
  //   单选 1 个银行对账单是批量子集，行为等同原单选导入（识别 bank-statement → readBankStatement → 写 session）。
  elements.bankStatementImportBtn.addEventListener('click', handleBankStatementBatchImport);
  // v2.1.16-beta.5 需求1（PR-4 修订）🔴 资金红线：row1《开始运行》改智能路由（按面板模式分流，不直接绑 handleBankStatementRun）。
  elements.bankStatementRunBtn.addEventListener('click', handleBankStatementRunRouted);
  elements.bankStatementExportBtn.addEventListener('click', handleBankStatementExport);
  // v2.1.14 B：资金对账数据处理面板「链接表管理」按钮绑定 → 打开链接表管理弹窗。
  // v3.0.7 需求2a（C2）：原 row2《导入不平表》/《导出文件》两按钮已随面板删除——对应事件绑定一并移除
  //   （导入不平表绑定 handleBankStatementGatewayReconImport、导出绑定 handleReconIdFixExport 的宿主按钮均已删）。
  //   网关 ReconID 修复仍由「对账单 ReconID 修复」面板入口承载；handleReconIdFixExport 函数本体保留（该面板 5790 行仍绑定）。
  if (elements.bankStatementLinkedTableBtn) {
    elements.bankStatementLinkedTableBtn.addEventListener('click', () => openModal(createLinkedTableManagerDialog()));
  }
  if (elements.preFundReconciliationImportBankBtn) {
    elements.preFundReconciliationImportBankBtn.addEventListener('click', handlePreFundImportBank);
  }
  if (elements.preFundReconciliationRunBtn) {
    elements.preFundReconciliationRunBtn.addEventListener('click', handlePreFundRun);
  }
  if (elements.preFundReconciliationExportBtn) {
    elements.preFundReconciliationExportBtn.addEventListener('click', handlePreFundExport);
  }
  if (elements.preFundReconciliationTempManagerBtn) {
    elements.preFundReconciliationTempManagerBtn.addEventListener('click', () => {
      openModal(createPreFundTempManagerDialog({
        onChanged: () => refreshPreFundReconciliationStatus(),
        onImport: handlePreFundImportMpt
      }));
    });
  }
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块按钮 binding（spec §一.1 + Q4 决策）
  // v2.1.0-beta.3 T5：场景管理白名单按当前账单类别动态决定
  if (elements.reconIdFixManageScenariosBtn) {
    elements.reconIdFixManageScenariosBtn.addEventListener('click', () => {
      const cat = state.reconIdFixBillCategory;
      if (!cat) return; // 账单类别为空时按钮 disabled，理论上不会触发
      const targetCategory = cat === 'gateway' ? 'gateway-recon-id-fix' : 'recon-id-fix';
      openModal(createScenariosManagerDialog([targetCategory]));
    });
  }
  // v2.1.0-beta.3 T4：账单类别下拉 change handler + 同步 UI 选中态
  if (elements.reconIdFixBillCategorySelect) {
    elements.reconIdFixBillCategorySelect.value = state.reconIdFixBillCategory || '';
    elements.reconIdFixBillCategorySelect.addEventListener('change', (event) => {
      handleReconIdFixBillCategoryChange(event).catch((error) => {
        console.warn('handleReconIdFixBillCategoryChange failed:', error);
      });
    });
  }
  if (elements.reconIdFixImportBtn) {
    elements.reconIdFixImportBtn.addEventListener('click', handleReconIdFixImport);
  }
  if (elements.reconIdFixRunBtn) {
    elements.reconIdFixRunBtn.addEventListener('click', handleReconIdFixRun);
  }
  if (elements.reconIdFixExportBtn) {
    elements.reconIdFixExportBtn.addEventListener('click', handleReconIdFixExport);
  }
  if (elements.reconIdFixScenarioSelect) {
    elements.reconIdFixScenarioSelect.addEventListener('change', (event) => {
      const raw = event.target.value;
      const id = raw ? Number.parseInt(raw, 10) : NaN;
      state.reconIdFixSelectedScenarioId = Number.isFinite(id) ? id : null;
      updateReconIdFixUi();
    });
  }
  elements.statusBox.addEventListener('click', () => {
    if (state.manualBalancePromptReady && state.manualBalancePrompt) {
      openModal(createManualBalanceSeedDialog(state.manualBalancePrompt));
      return;
    }

    handleExportLastError('main').catch((error) => {
      console.error(error);
      setStatus('报错文件导出失败，请查看控制台', 'error');
    });
  });
  elements.newAccountStatusBox.addEventListener('click', () => {
    handleExportLastError('new-account').catch((error) => {
      console.error(error);
      setNewAccountStatus('报错文件导出失败，请查看控制台', 'error');
    });
  });
  elements.templateSelect.addEventListener('change', (event) => {
    // v1.5.3 R1 (T1.5)：主页面下拉现在是"模式"语义（而不是模板 ID）
    const nextMode = event.target.value === STATEMENT_MODES.exportMonthlyBalance
      ? STATEMENT_MODES.exportMonthlyBalance
      : STATEMENT_MODES.createStatement;
    if (state.mode === nextMode) return;
    state.mode = nextMode;

    // 切模式时重置月度余额装配 session（让下次切回月度余额重新弹弹窗）
    // 注：不清 statementImportSessions / lastGeneratedExports（PRD P1-1：模式切换不丢 statement session）
    state.monthlyBalanceReady = false;
    state.monthlyBalancePreview = null;

    if (nextMode === STATEMENT_MODES.createStatement) {
      // 恢复到 v1.5.2 默认：selectedTemplateId 固定虚拟 ID
      state.selectedTemplateId = FILENAME_MAPPING_TEMPLATE_ID;
      applyStatementModeSideEffects();
    } else {
      // 切到月度余额：按钮矩阵重置；状态栏提示
      applyStatementModeSideEffects();
      setStatus('点击"导出余额"选择模板和年月', 'info', {
        errorReportReady: false
      });
    }
  });
  elements.moduleSwitcherBtn.addEventListener('click', () => {
    if (state.isModuleMenuOpen) {
      closeModuleMenu();
      return;
    }

    openModuleMenu();
  });
  // v2.1.4 T3：module-option 改为动态渲染（renderTopModuleSwitcher）后用 event delegation 一次绑定
  elements.moduleSwitcherMenu.addEventListener('click', (event) => {
    const btn = event.target.closest('.module-option');
    if (!btn || !btn.dataset.module) return;
    setCurrentModule(btn.dataset.module);
    closeModuleMenu();
  });

  // v2.1.2 T2：月度银行对账单BU回填校验事件绑定（月份选择改为对话框，无 select change 事件）
  if (elements.bankBuReconImportBtn) {
    elements.bankBuReconImportBtn.addEventListener('click', handleBankBuReconImport);
  }
  if (elements.bankBuReconRunBtn) {
    elements.bankBuReconRunBtn.addEventListener('click', handleBankBuReconRun);
  }
  if (elements.bankBuReconExportBtn) {
    elements.bankBuReconExportBtn.addEventListener('click', handleBankBuReconExport);
  }

  // v2.1.12 需求1：VCC业务OP计算模块事件绑定（导入 / 开始运行 / 显示余额）
  if (elements.vccOpCalcImportBtn) {
    elements.vccOpCalcImportBtn.addEventListener('click', handleVccOpCalcImport);
  }
  if (elements.vccOpCalcRunBtn) {
    elements.vccOpCalcRunBtn.addEventListener('click', handleVccOpCalcRun);
  }
  if (elements.vccOpCalcShowBalanceBtn) {
    elements.vccOpCalcShowBalanceBtn.addEventListener('click', handleVccOpCalcShowBalance);
  }

  // v2.1.3：业务OP数据核对模块事件绑定
  if (elements.bizOpReconImportBtn) {
    elements.bizOpReconImportBtn.addEventListener('click', handleBizOpReconImport);
  }
  if (elements.bizOpReconRunBtn) {
    elements.bizOpReconRunBtn.addEventListener('click', handleBizOpReconRun);
  }
  if (elements.bizOpReconExportBtn) {
    elements.bizOpReconExportBtn.addEventListener('click', handleBizOpReconExport);
  }
  if (elements.bizOpReconBuSelect) {
    elements.bizOpReconBuSelect.addEventListener('change', handleBizOpReconBuChange);
  }

  // v2.1.6 Module B：收单单据币种校验事件绑定
  if (elements.acquiringBillCurrencyImportFlowBtn) {
    elements.acquiringBillCurrencyImportFlowBtn.addEventListener('click', handleAcquiringBillCurrencyImportFlow);
  }
  if (elements.acquiringBillCurrencyImportBillBtn) {
    elements.acquiringBillCurrencyImportBillBtn.addEventListener('click', handleAcquiringBillCurrencyImportBill);
  }
  if (elements.acquiringBillCurrencyRunBtn) {
    elements.acquiringBillCurrencyRunBtn.addEventListener('click', handleAcquiringBillCurrencyRun);
  }
  if (elements.acquiringBillCurrencyExportBtn) {
    elements.acquiringBillCurrencyExportBtn.addEventListener('click', handleAcquiringBillCurrencyExport);
  }

  elements.backgroundPaletteBtn.addEventListener('click', () => {
    if (state.isBackgroundPaletteOpen) {
      closeBackgroundPalette();
      return;
    }

    openBackgroundPalette();
  });
  elements.saveUserGuideBtn.addEventListener('click', async () => {
    const result = await window.desktopApi.app.saveUserGuide();

    if (result.status === 'cancelled') {
      return;
    }

    setStatus(result.message, result.status === 'success' ? 'success' : 'error');
  });
  // v2.1.4 T3：小助手功能收纳触发按钮
  if (elements.moduleCabinetBtn) {
    elements.moduleCabinetBtn.addEventListener('click', () => {
      openModal(createModuleCabinetDialog({
        enabledModules: state.enabledModules,
        allModules: Object.values(MODULES),
        onCommit: async (nextEnabledIds) => {
          const result = await window.desktopApi.settings.setEnabledModules(nextEnabledIds);
          if (!result || result.status !== 'ok') {
            console.warn('persist enabledModules failed:', result && result.message);
            return false;
          }
          // round 1 self-review M5：用 IPC 返回的 DB 真值刷新 state（sanitize 后可能去重 / 过滤非法 ID）
          state.enabledModules = Array.isArray(result.enabledModules) && result.enabledModules.length > 0
            ? [...result.enabledModules]
            : [...nextEnabledIds];
          // O4 拍板：若 currentModule 被移出启用列表 → 自动切到启用区第 1 个（persist=true 写回 DB）
          if (!state.enabledModules.includes(state.currentModule)) {
            setCurrentModule(state.enabledModules[0], { persist: true });
          }
          renderTopModuleSwitcher();
          return true;
        }
      }));
    });
  }

  // v3.0.8 需求1：工具箱🧰 触发按钮 → 打开工具箱主弹框（合表/拆表）
  if (elements.toolboxBtn) {
    elements.toolboxBtn.addEventListener('click', () => {
      openModal(createToolboxDialog());
    });
  }

  elements.backgroundSpectrumArea.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    state.isBackgroundSpectrumDragging = true;
    elements.backgroundSpectrumArea.setPointerCapture?.(event.pointerId);
    pickBackgroundColorFromClientPoint(event.clientX, event.clientY);
  });
  elements.backgroundSpectrumArea.addEventListener('pointermove', (event) => {
    if (!state.isBackgroundSpectrumDragging) {
      return;
    }

    pickBackgroundColorFromClientPoint(event.clientX, event.clientY);
  });
  elements.backgroundSpectrumArea.addEventListener('pointerup', (event) => {
    state.isBackgroundSpectrumDragging = false;
    elements.backgroundSpectrumArea.releasePointerCapture?.(event.pointerId);
  });
  elements.backgroundSpectrumArea.addEventListener('pointercancel', () => {
    state.isBackgroundSpectrumDragging = false;
  });
  elements.backgroundSpectrumArea.addEventListener('lostpointercapture', () => {
    state.isBackgroundSpectrumDragging = false;
  });
  elements.backgroundImportBtn.addEventListener('click', () => {
    handleBackgroundImportFile().catch((error) => {
      console.error(error);
      setStatus('背景导入失败，请查看控制台', 'error');
    });
  });
  elements.backgroundDoneBtn.addEventListener('click', () => {
    handleBackgroundSave().catch((error) => {
      console.error(error);
      setStatus('背景保存失败，请查看控制台', 'error');
    });
  });
  elements.backgroundResetBtn.addEventListener('click', handleBackgroundReset);

  elements.minimizeBtn.addEventListener('click', () => window.desktopApi.window.minimize());
  elements.maximizeBtn.addEventListener('click', async () => {
    const result = await window.desktopApi.window.toggleMaximize();
    state.isMaximized = result.isMaximized;
    elements.maximizeBtn.textContent = state.isMaximized ? '❐' : '□';
  });
  elements.closeBtn.addEventListener('click', () => window.desktopApi.window.close());

  window.desktopApi.window.onMaximizedState((value) => {
    state.isMaximized = value;
    elements.maximizeBtn.textContent = value ? '❐' : '□';
  });

  document.addEventListener('pointerdown', (event) => {
    if (
      state.isModuleMenuOpen &&
      !elements.moduleSwitcherBtn.contains(event.target) &&
      !elements.moduleSwitcherMenu.contains(event.target)
    ) {
      closeModuleMenu();
    }

    if (state.isBackgroundPaletteOpen) {
      if (
        elements.backgroundTool.contains(event.target) ||
        elements.modalRoot.contains(event.target)
      ) {
        return;
      }

      closeBackgroundPalette();
    }

    if (state.isNewAccountCurrencyDropdownOpen) {
      const clickedInsideNewAccountDropdown = getNewAccountRows().some((row) => {
        const refs = getNewAccountRowElements(row);
        return refs.currencyDropdownWrap?.contains(event.target)
          || refs.currencyInput?.contains(event.target)
          || refs.currencyInput?.parentElement?.contains(event.target);
      });

      if (!clickedInsideNewAccountDropdown) {
        closeAllNewAccountCurrencyDropdowns();
      }
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.isModuleMenuOpen) {
        closeModuleMenu();
      }

      if (state.isBackgroundPaletteOpen) {
        closeBackgroundPalette();
      }

      if (state.isNewAccountCurrencyDropdownOpen) {
        closeAllNewAccountCurrencyDropdowns();
      }
    }
  });
  markRendererStartup(RENDERER_STARTUP_MARKS.eventsBindDone);

  if (info.previewModal === 'account-mapping') {
    setTimeout(() => {
      handleOpenAccountMappings().catch((error) => {
        console.error(error);
      });
    }, 120);
  } else if (info.previewModal === 'template-manager') {
    setTimeout(() => {
      applyTemplateManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'mapping-dialog') {
    setTimeout(() => {
      applyMappingDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'template-rename') {
    setTimeout(() => {
      applyTemplateRenamePreviewState();
    }, 120);
  } else if (info.previewModal === 'big-account-manager') {
    setTimeout(() => {
      applyBigAccountManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'big-account-manager-dropdown') {
    setTimeout(() => {
      applyBigAccountManagerDropdownPreviewState();
    }, 120);
  } else if (info.previewModal === 'big-account-selection') {
    setTimeout(() => {
      applyBigAccountSelectionPreviewState();
    }, 120);
  } else if (info.previewModal === 'new-account') {
    setTimeout(() => {
      applyNewAccountPreviewState();
    }, 120);
  } else if (info.previewModal === 'background-palette') {
    setTimeout(() => {
      openBackgroundPalette();
    }, 120);
  } else if (info.previewModal === 'new-account-palette') {
    setTimeout(() => {
      applyNewAccountPreviewState();
      openBackgroundPalette();
    }, 120);
  } else if (info.previewModal === 'monthly-balance-export-dialog') {
    setTimeout(() => {
      applyMonthlyBalanceExportDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'manual-balance-seed-dialog') {
    setTimeout(() => {
      applyManualBalanceSeedDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'balance-addon-manager') {
    setTimeout(() => {
      applyBalanceAddonManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'export-scope-dialog') {
    setTimeout(() => {
      applyExportScopeDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'amount-split-rules-dialog') {
    setTimeout(() => {
      applyAmountSplitRulesDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'bill-split-rows-dialog') {
    setTimeout(() => {
      applyBillSplitRowsDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'bill-split-mappings-dialog') {
    setTimeout(() => {
      applyBillSplitMappingsDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'remember-order-mismatch-dialog') {
    setTimeout(() => {
      applyRememberOrderMismatchDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'account-mapping-migration-dialog') {
    setTimeout(() => {
      applyAccountMappingMigrationDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-panel') {
    setTimeout(() => {
      applyPendingPanelPreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-rule-dialog') {
    setTimeout(() => {
      applyPendingRuleDialogPreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-rule-confirm') {
    setTimeout(() => {
      applyPendingRuleConfirmPreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-import-month') {
    setTimeout(() => {
      applyPendingImportMonthPreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-reconcile') {
    setTimeout(() => {
      applyPendingReconcilePreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-export-runs') {
    setTimeout(() => {
      applyPendingExportRunsPreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-panel-initial') {
    setTimeout(() => {
      applyPendingPanelInitialPreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-panel-importing') {
    setTimeout(() => {
      applyPendingPanelImportingPreviewState();
    }, 120);
  } else if (info.previewModal === 'pending-panel-error') {
    setTimeout(() => {
      applyPendingPanelErrorPreviewState();
    }, 120);
  } else if (info.previewModal === 'module-switcher-open') {
    setTimeout(() => {
      applyModuleSwitcherOpenPreviewState();
    }, 120);
  } else if (info.previewModal === 'new-account-multi') {
    setTimeout(() => {
      applyNewAccountMultiPreviewState();
    }, 120);
  } else if (info.previewModal === 'new-account-currency-dropdown') {
    setTimeout(() => {
      applyNewAccountCurrencyDropdownPreviewState();
    }, 120);
  } else if (info.previewModal === 'big-account-selection-multi') {
    setTimeout(() => {
      applyBigAccountSelectionMultiPreviewState();
    }, 120);
  } else if (info.previewModal === 'big-account-selection-multi-large') {
    // v2.1.7 round 3 B4：≥20 文件 fixture，验证大数据集滚动行为
    setTimeout(() => {
      applyBigAccountSelectionMultiLargePreviewState();
    }, 120);
  } else if (info.previewModal === 'extract-order') {
    setTimeout(() => {
      applyExtractOrderPreviewState();
    }, 120);
  } else if (info.previewModal === 'account-mapping-editing') {
    setTimeout(() => {
      applyAccountMappingEditingPreviewState();
    }, 120);
  } else if (info.previewModal === 'fund-transfer-account-mapping') {
    // v3.0.12 功能2（批A）：账户映射管理弹窗 preview
    setTimeout(() => {
      applyFundTransferAccountMappingPreviewState();
    }, 120);
  } else if (info.previewModal === 'bank-statement-panel') {
    setTimeout(() => {
      applyBankStatementPanelPreviewState();
    }, 120);
  } else if (info.previewModal === 'pre-fund-reconciliation-panel') {
    setTimeout(() => {
      applyPreFundReconciliationPanelPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenarios-manager') {
    setTimeout(() => {
      applyScenariosManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'builtin-fixed-channel-manage') {
    // v2.1.16 A1：自带写死场景「管理」弹窗（含优先级输入框）preview
    setTimeout(() => {
      applyBuiltinFixedChannelManagePreviewState();
    }, 120);
  } else if (info.previewModal === 'builtin-fixed-channel-manage-payment') {
    // v3.0.4 块 F · F1：Payment 线下调拨订单回填处理展开态 preview
    setTimeout(() => {
      applyBuiltinFixedChannelManagePaymentPreviewState();
    }, 120);
  } else if (info.previewModal === 'linked-table-manager') {
    // v2.1.14 C：链接表管理弹窗 preview
    setTimeout(() => {
      applyLinkedTableManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'pre-fund-temp-manager') {
    setTimeout(() => {
      applyPreFundTempManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'pre-fund-temp-delete-range') {
    setTimeout(() => {
      applyPreFundTempDeleteRangePreviewState();
    }, 120);
  } else if (info.previewModal === 'linked-table-delete-range') {
    // v3.0.1 需求1（D4）：删除网关对账单弹框 preview
    setTimeout(() => {
      applyLinkedTableDeleteRangePreviewState();
    }, 120);
  } else if (info.previewModal === 'gateway-recon-scenario-picker') {
    // v3.0.1 需求3：网关对账单修复场景单选框 preview
    setTimeout(() => applyGatewayReconScenarioPickerPreviewState(), 120);
  } else if (info.previewModal === 'scenario-category-select') {
    setTimeout(() => {
      applyScenarioCategorySelectPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c1') {
    setTimeout(() => {
      applyScenarioConfigC1PreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c1-and') {
    // v2.1.7 F1：C1 dialog AND 模式截图入口
    setTimeout(() => {
      applyScenarioConfigC1AndPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c2') {
    setTimeout(() => {
      applyScenarioConfigC2PreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c3') {
    setTimeout(() => {
      applyScenarioConfigC3PreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c3-custom') {
    setTimeout(() => {
      applyScenarioConfigC3CustomPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-confirm-detail') {
    setTimeout(() => {
      applyScenarioConfirmDetailPreviewState();
    }, 120);
  } else if (info.previewModal === 'recon-id-fix-panel') {
    setTimeout(() => {
      applyReconIdFixPanelPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c4') {
    setTimeout(() => {
      applyScenarioConfigC4PreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c4-both') {
    setTimeout(() => {
      applyScenarioConfigC4BothPreviewState();
    }, 120);
  } else if (info.previewModal === 'recon-id-fix-panel-business') {
    setTimeout(() => {
      applyReconIdFixPanelBusinessPreviewState();
    }, 120);
  } else if (info.previewModal === 'recon-id-fix-panel-gateway') {
    setTimeout(() => {
      applyReconIdFixPanelGatewayPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c4-gateway') {
    setTimeout(() => {
      applyScenarioConfigC4GatewayPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c4-gateway-1vN') {
    setTimeout(() => {
      applyScenarioConfigC4Gateway1vNPreviewState();
    }, 120);
  } else if (info.previewModal === 'bank-bu-recon-panel-initial') {
    setTimeout(() => { applyBankBuReconPanelInitialPreviewState(); }, 120);
  } else if (info.previewModal === 'bank-bu-recon-panel-importing') {
    setTimeout(() => { applyBankBuReconPanelImportingPreviewState(); }, 120);
  } else if (info.previewModal === 'bank-bu-recon-panel-result') {
    setTimeout(() => { applyBankBuReconPanelResultPreviewState(); }, 120);
  } else if (info.previewModal === 'biz-op-recon-panel-initial') {
    setTimeout(() => { applyBizOpReconPanelInitialPreviewState(); }, 120);
  } else if (info.previewModal === 'biz-op-recon-panel-importing') {
    setTimeout(() => { applyBizOpReconPanelImportingPreviewState(); }, 120);
  } else if (info.previewModal === 'biz-op-recon-panel-result') {
    setTimeout(() => { applyBizOpReconPanelResultPreviewState(); }, 120);
  } else if (info.previewModal === 'biz-op-recon-panel-export-dialog') {
    setTimeout(() => { applyBizOpReconPanelExportDialogPreviewState(); }, 120);
  } else if (info.previewModal === 'acquiring-bill-currency-panel-initial') {
    setTimeout(() => { applyAcquiringBillCurrencyPanelInitialPreviewState(); }, 120);
  } else if (info.previewModal === 'acquiring-bill-currency-panel-importing') {
    setTimeout(() => { applyAcquiringBillCurrencyPanelImportingPreviewState(); }, 120);
  } else if (info.previewModal === 'acquiring-bill-currency-panel-result') {
    setTimeout(() => { applyAcquiringBillCurrencyPanelResultPreviewState(); }, 120);
  } else if (info.previewModal === 'vcc-op-calc-panel-initial') {
    setTimeout(() => { applyVccOpCalcPanelInitialPreviewState(); }, 120);
  } else if (info.previewModal === 'vcc-op-calc-panel-result') {
    setTimeout(() => { applyVccOpCalcPanelResultPreviewState(); }, 120);
  } else if (info.previewModal === 'vcc-op-calc-compute') {
    setTimeout(() => { applyVccOpCalcComputeDialogPreviewState(); }, 120);
  } else if (info.previewModal === 'vcc-op-calc-show-balance') {
    setTimeout(() => { applyVccOpCalcShowBalanceDialogPreviewState(); }, 120);
  } else if (info.previewModal === 'module-cabinet') {
    setTimeout(() => { applyModuleCabinetPreviewState(); }, 120);
  } else if (info.previewModal === 'toolbox') {
    setTimeout(() => { applyToolboxPreviewState(); }, 120);
  } else if (info.previewModal === 'toolbox-split-field-picker') {
    setTimeout(() => { applyToolboxSplitFieldPickerPreviewState(); }, 120);
  }

  markRendererStartup(RENDERER_STARTUP_MARKS.initComplete);
  reportRendererStartupMetrics();
  // v2.1.8 N1' (v0.7)：注册用户活动监听 → 10s 节流上报 main，作为 idle 30min 判定依据
  setupUserActivityReporter();
}

initialize().catch((error) => {
  console.error(error);
  setStatus('初始化失败，请查看控制台', 'error');
});
