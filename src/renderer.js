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
    name: '月度 Pending 数据核对'
  },
  bankStatementProcess: {
    id: 'bank-statement-process',
    name: '银行对账单处理'
  },
  // v2.1.0-beta.1 PR-A：对账单ReconID修复模块（C4 / business + gateway 两个子模式）
  // v2.1.0-beta.3 T4：模块下挂 business（单据对账单）+ gateway（网关对账单）两个子模式，按主面板「账单类别」下拉切换
  //   ⚠️ module.id 保留 'recon-id-fix'（数十处引用 + DB schema CHECK 约束）；
  //      单据子模式 scenario.category 仍是 'recon-id-fix'（字面与 module.id 相同，作用域不同）；
  //      网关子模式 scenario.category = 'gateway-recon-id-fix'。
  reconIdFix: {
    id: 'recon-id-fix',
    name: '对账单ReconID修复'
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
  // v2.0.0-beta.2 F1：UI 风格（'Clear' | 'General'），从 SQLite app_settings.ui_style 加载
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
  processingResult: null,        // { hitRowCount, scenarioHitCount, warningCount, ranAt } | null
  bankStatementExport: null,     // { mainFileName, errorReportName } | null（仅 renderer-side 缓存）
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
  bankStatementImportBtn: document.getElementById('bankStatementImportBtn'),
  bankStatementRunBtn: document.getElementById('bankStatementRunBtn'),
  bankStatementExportBtn: document.getElementById('bankStatementExportBtn'),
  bankStatementStatusBox: document.getElementById('bankStatementStatusBox'),
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
  backgroundPalettePanel: document.getElementById('backgroundPalettePanel'),
  backgroundSpectrumArea: document.getElementById('backgroundSpectrumArea'),
  backgroundSpectrumCanvas: document.getElementById('backgroundSpectrumCanvas'),
  backgroundSpectrumCrosshair: document.getElementById('backgroundSpectrumCrosshair'),
  backgroundSelectedColorSwatch: document.getElementById('backgroundSelectedColorSwatch'),
  backgroundImportBtn: document.getElementById('backgroundImportBtn'),
  backgroundDoneBtn: document.getElementById('backgroundDoneBtn'),
  backgroundResetBtn: document.getElementById('backgroundResetBtn'),
  paletteStyleSelect: document.getElementById('paletteStyleSelect'),
  paletteStyleConfirmBtn: document.getElementById('paletteStyleConfirmBtn')
};

const {
  closeModal,
  openModal,
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
  // v1.5.3 round 6：补全 preview 所需 factory（仅 preview 链路使用）
  createAmountSplitRulesDialog,
  createBillSplitRowsDialog,
  createBillSplitMappingsDialog,
  createBalanceAddonManagerDialog,
  // v2.0.0-beta.3：银行对账单处理模块场景管理
  createScenariosManagerDialog,
  createScenarioCategorySelectDialog,
  // v2.0.0-beta.3 PR #32b：4 dialog factory（C1/C2/C3 配置 + 确认场景详情）
  createScenarioConfigDialogC1,
  createScenarioConfigDialogC2,
  createScenarioConfigDialogC3,
  createScenarioConfirmDetailDialog,
  // v2.1.0-beta.1 PR-A（task A7）：C4 类配置弹窗
  createScenarioConfigDialogC4,
  // v2.1.2 T2：月份选择对话框（PRD §3.2.5 拍板修正）
  createBankBuReconMonthPickerDialog,
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
  getBizOpReconDefaultDate
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
  applyExtractOrderPreviewState,
  applyAccountMappingEditingPreviewState,
  // v2.0.0-beta.3：银行对账单处理模块 preview（3 张）
  applyBankStatementPanelPreviewState,
  applyScenariosManagerPreviewState,
  applyScenarioCategorySelectPreviewState,
  // v2.0.0-beta.3 PR #32b：4 类配置弹窗 + 确认详情 preview（4 张）
  applyScenarioConfigC1PreviewState,
  applyScenarioConfigC2PreviewState,
  applyScenarioConfigC3PreviewState,
  applyScenarioConfirmDetailPreviewState,
  // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块 preview（3 张）
  applyReconIdFixPanelPreviewState,
  applyScenarioConfigC4PreviewState,
  applyScenarioConfigC4BothPreviewState,
  // v2.1.0-beta.3 T11：网关子模式 preview（4 张）
  applyReconIdFixPanelBusinessPreviewState,
  applyReconIdFixPanelGatewayPreviewState,
  applyScenarioConfigC4GatewayPreviewState,
  applyScenarioConfigC4Gateway1vNPreviewState
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
  desktopApi: window.desktopApi,
  applyStatementResult,
  closeAllNewAccountCurrencyDropdowns,
  // v2.0.0-beta.3 PR #32b：4 类配置弹窗 + 确认详情 preview 所需
  createScenarioConfigDialogC1,
  createScenarioConfigDialogC2,
  createScenarioConfigDialogC3,
  createScenarioConfirmDetailDialog,
  // v2.1.0-beta.1 PR-A（task A7）：C4 配置弹窗 preview 所需
  createScenarioConfigDialogC4
});

function updateStatusBox(box, message, tone = 'info', options = {}) {
  const {
    errorReportReady = false,
    manualBalancePromptReady = false,
    idleTitle = ''
  } = options;

  // v2.0.0-beta.2：只更新 .status-box-text 子节点的文案，保留同级 .status-spark SVG 不被清空
  const textEl = box.querySelector('.status-box-text');
  if (textEl) textEl.textContent = message;
  box.dataset.tone = tone;
  box.dataset.errorReportReady = errorReportReady ? 'true' : 'false';
  box.dataset.manualBalancePromptReady = manualBalancePromptReady ? 'true' : 'false';
  box.classList.toggle('is-clickable', errorReportReady || manualBalancePromptReady);
  box.title = manualBalancePromptReady
    ? '点击补录上一账单日余额'
    : errorReportReady
      ? '点击导出报错文件'
      : idleTitle;
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
  // v2.0.0-beta.2 D5：每次打开调色板时下拉永远显示 'Clear'（不反映当前实际风格）
  if (elements.paletteStyleSelect) {
    elements.paletteStyleSelect.value = 'Clear';
  }
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

// v2.0.0-beta.2 F1：UI 风格切换核心（D6 / D6.1 / D15）
// 通过 link.disabled 切换 General / Clear 两套 CSS（CSS 引擎层级隔离，零延迟）
// 同时同步 body.dataset.style 供条件 selector / JS 状态读取
function applyUiStyle(style) {
  const safe = (style === 'General') ? 'General' : 'Clear';
  state.uiStyle = safe;

  const cssGeneral = document.getElementById('cssGeneral');
  const cssClear = document.getElementById('cssClear');
  const cssClearExtra = document.getElementById('cssClearExtra');
  if (!cssGeneral || !cssClear || !cssClearExtra) return;

  // 先启用目标 link → 再禁用旧的，避免 1 帧裸 DOM
  if (safe === 'General') {
    cssGeneral.disabled = false;
    cssClear.disabled = true;
    cssClearExtra.disabled = true;
    document.body.dataset.style = 'general';
  } else {
    cssClear.disabled = false;
    cssClearExtra.disabled = false;
    cssGeneral.disabled = true;
    document.body.dataset.style = 'clear';
  }
}

// v2.0.0-beta.2 D16：用户主动切风格时同步背景色（仅"魔法值"场景，不覆盖用户自定义）
async function maybeSyncBackgroundColorOnStyleChange(targetStyle) {
  const currentColor = String(state.backgroundSettings?.colorHex || '').toLowerCase();
  const desiredColor = targetStyle === 'Clear' ? '#ffffff' : '#efe8da';
  const otherDefault = targetStyle === 'Clear' ? '#efe8da' : '#ffffff';

  if (currentColor !== otherDefault || currentColor === desiredColor) return;

  const result = await window.desktopApi.background.save({
    colorHex: desiredColor,
    keepExistingImage: true
  });
  if (result && result.status === 'success') {
    state.backgroundSettings = cloneBackgroundSettings(result.backgroundConfig);
    state.backgroundDraft = cloneBackgroundSettings(result.backgroundConfig);
    applyBackgroundSettings(state.backgroundSettings);
  }
}

// v2.0.0-beta.3 PR #32b：银行对账单处理模块 — 状态同步 + 4 按钮 handler
async function refreshBankStatementStatus() {
  try {
    const status = await window.desktopApi.bankStatement.sessionStatus();
    if (!status || status.status !== 'ok') {
      state.bankStatementSession = null;
      state.gatewayReconSession = null;
      state.processingResult = null;
    } else {
      state.bankStatementSession = status.hasBankStatement
        ? { fileName: status.bankStatementFileName, rowCount: status.bankStatementRowCount }
        : null;
      state.gatewayReconSession = status.hasGatewayRecon
        ? { fileName: status.gatewayReconFileName, rowCount: status.gatewayReconRowCount }
        : null;
      state.processingResult = status.hasProcessingResult
        ? {
          hitRowCount: status.processingStats?.hitRowCount ?? 0,
          scenarioHitCount: status.processingStats?.scenarioHitCount ?? 0,
          hitScenarioIds: Array.isArray(status.processingStats?.hitScenarioIds)
            ? status.processingStats.hitScenarioIds.slice()
            : [],
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
    text = `已导出：\n${ex.mainFileName}`;
    if (ex.errorReportName) text += `\nerror-report：${ex.errorReportName}`;
    tone = 'success';
  } else if (pr) {
    const ids = Array.isArray(pr.hitScenarioIds) ? pr.hitScenarioIds : [];
    const idsText = ids.length > 0 ? `（场景 ${ids.join('、')}）` : '';
    text = `已处理：${pr.hitRowCount} 行命中${idsText}，${pr.warningCount} 警告`;
    if (pr.skippedC3Count > 0) {
      text += ` · 跳过 ${pr.skippedC3Count} 个对账不平场景`;
    }
    tone = pr.warningCount > 0 ? 'error' : 'success';
  } else {
    text = `已导入：\n${bs.fileName}（${bs.rowCount} 行）`;
    if (gw) text += `\n不平账结果表：${gw.fileName}（${gw.rowCount} 行）`;
    tone = 'info';
  }
  // 仅替换文本节点，保留 .status-spark SVG（与 setStatus 模式一致）
  const textEl = elements.bankStatementStatusBox.querySelector('.status-box-text');
  if (textEl) textEl.textContent = text;
  elements.bankStatementStatusBox.dataset.tone = tone;

  // 按钮 disabled 控制
  if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = false;
  if (elements.bankStatementRunBtn) elements.bankStatementRunBtn.disabled = !bs;
  if (elements.bankStatementExportBtn) elements.bankStatementExportBtn.disabled = !pr;
}

async function handleBankStatementImport() {
  try {
    const result = await window.desktopApi.bankStatement.import();
    if (!result) return;
    if (result.status === 'cancelled') return;
    if (result.status === 'invalid') {
      const detail = (result.detailLines || []).map((l) => `• ${l}`).join('<br>');
      openModal(createAlertDialog(`${result.message || '文件校验失败'}<br>${detail}`));
      return;
    }
    if (result.status !== 'ok') {
      openModal(createAlertDialog(`导入失败：${result.message || '未知错误'}`));
      return;
    }
    state.bankStatementExport = null;  // 重新导入 → 清掉「已导出」缓存
    await refreshBankStatementStatus();
    // v2.0.0-beta.3 PR #32b：导入银行对账单成功后，若启用了 C3 类场景且未导入资金对账文件 → 立即弹提示
    await maybePromptGatewayReconImport();
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`导入失败：${error.message || error}`));
  }
}

async function maybePromptGatewayReconImport() {
  try {
    const list = await window.desktopApi.scenarios.list();
    const scenarios = (list && list.status === 'ok' && Array.isArray(list.scenarios)) ? list.scenarios : [];
    const hasC3Enabled = scenarios.some((s) => s.category === 'gateway-recon-join' && (s.enabled === 1 || s.enabled === true));
    if (!hasC3Enabled) return;
    if (state.gatewayReconSession) return;
    openModal(createConfirmDialog({
      message: '已启用「资金对账不平」类场景，需要导入「资金对账不平结果表」。<br>是否现在导入？（也可稍后再导入；不导入则该类场景将被跳过）',
      confirmText: '导入文件',
      cancelText: '稍后再说',
      onConfirm: async () => {
        closeModal();
        await handleBankStatementImportGatewayRecon();
      }
    }));
  } catch (error) {
    console.warn('maybePromptGatewayReconImport failed:', error);
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
    await refreshBankStatementStatus();
    return true;
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`导入资金对账文件失败：${error.message || error}`));
    return false;
  }
}

async function handleBankStatementRun() {
  if (!state.bankStatementSession) {
    openModal(createAlertDialog('请先导入银行对账单'));
    return;
  }
  // PR #33 Codex Finding 1：保留 import 后 dialog#1（maybePromptGatewayReconImport）+
  // 运行点新增 dialog#2 三选一（防止 dialog#1 选"稍后再说"后 C3 被静默跳过）
  try {
    const needGwReminder = await shouldPromptGatewayReconAtRun();
    if (needGwReminder) {
      openModal(createConfirmDialog({
        message: '已启用「资金对账不平」类场景但未导入「资金对账不平结果表」。<br>继续运行将跳过该类场景。',
        confirmText: '导入文件',
        middleText: '直接运行',
        cancelText: '取消',
        onConfirm: async () => {
          closeModal();
          const ok = await handleBankStatementImportGatewayRecon();
          if (ok) await runBankStatementInternal();
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
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`运行失败：${error.message || error}`));
  }
}

async function shouldPromptGatewayReconAtRun() {
  // C3 启用 + 未导入 gw 文件 → 运行点弹 dialog#2 三选一
  if (state.gatewayReconSession) return false;
  try {
    const list = await window.desktopApi.scenarios.list();
    const scenarios = (list && list.status === 'ok' && Array.isArray(list.scenarios)) ? list.scenarios : [];
    return scenarios.some((s) => s.category === 'gateway-recon-join' && (s.enabled === 1 || s.enabled === true));
  } catch (error) {
    console.warn('shouldPromptGatewayReconAtRun failed:', error);
    return false;
  }
}

async function runBankStatementInternal() {
  try {
    const result = await window.desktopApi.bankStatement.run();
    if (!result || result.status !== 'ok') {
      openModal(createAlertDialog(`运行失败：${result?.message || '未知错误'}`));
      return;
    }
    state.bankStatementExport = null;  // 重新运行 → 清掉「已导出」缓存
    // 运行成功不再弹 alert，处理结果（命中场景 ids / 警告数 / skippedC3）由 updateBankStatementUi
    // 通过 refreshBankStatementStatus 拉到的 stats 一并展示在状态框
    await refreshBankStatementStatus();
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`运行失败：${error.message || error}`));
  }
}

async function handleBankStatementExport() {
  if (!state.processingResult) {
    openModal(createAlertDialog('请先点击"开始运行"处理对账单'));
    return;
  }
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
      updateBankStatementUi();
      return;
    }
    if (result.status === 'ok') {
      state.bankStatementExport = {
        mainFileName: result.mainFileName || result.mainFilePath,
        errorReportName: result.errorReportName || null
      };
      updateBankStatementUi();
      return;
    }
    openModal(createAlertDialog(`未知导出状态：${JSON.stringify(result)}`));
  } catch (error) {
    console.error(error);
    openModal(createAlertDialog(`导出失败：${error.message || error}`));
  }
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
    select.innerHTML = '<option value=""></option>';
    select.disabled = true;
    select.value = '';
    return;
  }
  const scenarios = Array.isArray(state.reconIdFixScenarios) ? state.reconIdFixScenarios : [];
  if (scenarios.length === 0) {
    select.innerHTML = '<option value="">请先在场景管理中创建场景</option>';
    select.disabled = true;
    select.value = '';
    return;
  }
  const opts = ['<option value="">请选择场景</option>']
    .concat(scenarios.map((s) => {
      const idStr = String(s.id);
      const name = String(s.name || '');
      // 简单 escape：避免 < / > / & / "
      const escapedName = name
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      return `<option value="${idStr}">${escapedName}</option>`;
    }))
    .join('');
  select.innerHTML = opts;
  select.disabled = false;
  // 同步 select.value 与 state（防御 reload 后 currentSelected 仍存在的情况）
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
  const textEl = elements.reconIdFixStatusBox.querySelector('.status-box-text');
  if (textEl) textEl.textContent = text;
  elements.reconIdFixStatusBox.dataset.tone = tone;

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

// v2.0.0-beta.2 F1+F2（D9/D10）：调色板"应用"按钮触发风格切换流程
function handlePaletteStyleConfirm() {
  const select = elements.paletteStyleSelect;
  if (!select) return;
  const targetStyle = select.value === 'General' ? 'General' : 'Clear';

  // 当前已经是该风格，无需切换；直接收起调色板
  if (targetStyle === state.uiStyle) {
    closeBackgroundPalette({ revert: true });
    return;
  }

  openModal(
    createConfirmDialog({
      message: `确认切换页面风格为「${targetStyle}」？切换后立即生效。`,
      confirmText: '确认切换',
      cancelText: '取消',
      onConfirm: async () => {
        const result = await window.desktopApi.settings.setUiStyle(targetStyle);
        if (!result || result.status !== 'ok') {
          closeModal();
          openModal(createAlertDialog((result && result.message) || '切换失败'));
          return;
        }
        applyUiStyle(targetStyle);
        await maybeSyncBackgroundColorOnStyleChange(targetStyle);
        closeModal();
        closeBackgroundPalette({ revert: true });
      },
      onCancel: () => {
        // D10：取消 → 下拉值回到 'Clear'（D5 的固定显示值）
        select.value = 'Clear';
      }
    })
  );
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
  // v2.1.3-fix1.5：本模块状态框 — 冒号（: 或 ：）后强制换行
  // updateStatusBox 用 textContent 写文案，无法识别 <br>；此处先 escape + 替换为 innerHTML，再回写 textContent 用于 dataset tone 等
  updateStatusBox(elements.bizOpReconStatusBox, message, tone, {
    idleTitle: '欢迎使用小助手'
  });
  // updateStatusBox 调用之后，覆盖 textEl 内容为 HTML（含 <br> 换行）
  const textEl = elements.bizOpReconStatusBox.querySelector('.status-box-text');
  if (textEl && typeof formatBizOpReconStatusHtml === 'function') {
    textEl.innerHTML = formatBizOpReconStatusHtml(message);
  }
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
        setBizOpReconStatus(`正在导入流水对账单 ${date} 数据...`, 'info');
        const impResult = await window.desktopApi.bizOpRecon.runFlowImport({
          date,
          filePath: pickRes.filePath
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
        setBizOpReconStatus(
          `流水对账单（${date}）已导入 ${impResult.totalCount} 行`,
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
        `${date} BU=${buName} 对账完成：测算金额差异 ${s.amountDiffCount} 笔 / T-1 有 T-2 无 ${s.t1NotT2Count} 笔 / T-2 有 T-1 无 ${s.t2NotT1Count} 笔 / 多 OP 账户 ${s.multiOpAccountCount} 个`,
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

async function initialize() {
  markRendererStartup(RENDERER_STARTUP_MARKS.initializeStart);
  markRendererStartup(RENDERER_STARTUP_MARKS.getInfoStart);
  const info = await window.desktopApi.app.getInfo();
  markRendererStartup(RENDERER_STARTUP_MARKS.getInfoDone);
  applyUiStyle(info.uiStyle);
  drawBackgroundSpectrum();
  resetBackgroundPickerSelection();
  elements.appVersion.textContent = info.version;
  state.hasEnum = info.hasEnum;
  state.enumFileName = info.enumFileName || '';
  state.accountMappingCount = info.accountMappingCount || 0;
  state.hasErrorReport = Boolean(info.hasErrorReport);
  state.currencyOptions = Array.isArray(info.currencyOptions) ? info.currencyOptions.slice() : [];
  // v2.1.0-beta.3 T4：从持久化恢复对账单ReconID修复模块「账单类别」
  state.reconIdFixBillCategory = (info.reconIdFixBillCategory === 'business' || info.reconIdFixBillCategory === 'gateway')
    ? info.reconIdFixBillCategory
    : null;
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
  const validModuleIds = Object.values(MODULES).map((m) => m.id);
  const restoredModuleId = validModuleIds.includes(info.currentModule)
    ? info.currentModule
    : MODULES.statementGenerator.id;
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
      'gateway-recon-join'
    ]));
  });
  elements.bankStatementImportBtn.addEventListener('click', handleBankStatementImport);
  elements.bankStatementRunBtn.addEventListener('click', handleBankStatementRun);
  elements.bankStatementExportBtn.addEventListener('click', handleBankStatementExport);
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
  Array.from(elements.moduleSwitcherMenu.querySelectorAll('.module-option')).forEach((button) => {
    button.addEventListener('click', () => {
      setCurrentModule(button.dataset.module);
      closeModuleMenu();
    });
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
  if (elements.paletteStyleConfirmBtn) {
    elements.paletteStyleConfirmBtn.addEventListener('click', handlePaletteStyleConfirm);
  }

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
  } else if (info.previewModal === 'extract-order') {
    setTimeout(() => {
      applyExtractOrderPreviewState();
    }, 120);
  } else if (info.previewModal === 'account-mapping-editing') {
    setTimeout(() => {
      applyAccountMappingEditingPreviewState();
    }, 120);
  } else if (info.previewModal === 'bank-statement-panel') {
    setTimeout(() => {
      applyBankStatementPanelPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenarios-manager') {
    setTimeout(() => {
      applyScenariosManagerPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-category-select') {
    setTimeout(() => {
      applyScenarioCategorySelectPreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c1') {
    setTimeout(() => {
      applyScenarioConfigC1PreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c2') {
    setTimeout(() => {
      applyScenarioConfigC2PreviewState();
    }, 120);
  } else if (info.previewModal === 'scenario-config-c3') {
    setTimeout(() => {
      applyScenarioConfigC3PreviewState();
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
  }

  markRendererStartup(RENDERER_STARTUP_MARKS.initComplete);
  reportRendererStartupMetrics();
}

initialize().catch((error) => {
  console.error(error);
  setStatus('初始化失败，请查看控制台', 'error');
});
