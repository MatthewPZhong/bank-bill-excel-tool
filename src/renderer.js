let bizOpV327Controller = null;
let darkModeController = null;
const DEFAULT_BACKGROUND_SETTINGS = Object.freeze({
  colorHex: '#efe8da',
  imageDataUrl: '',
  filePath: '',
  sourceFileName: '',
  sourcePath: ''
});
const DEFAULT_APP_UPDATE_STATUS = Object.freeze({
  enabled: false,
  supported: false,
  distribution: 'unsupported',
  state: 'disabled',
  currentVersion: '',
  targetVersion: '',
  percent: 0,
  lastCheckedAt: '',
  canRestart: false,
  busyOperations: [],
  error: ''
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
  duplicateInboundMatch: {
    id: 'duplicate-inbound-match',
    name: '重复入金匹配'
  },
  positionReconciliation: {
    id: 'position-reconciliation-process',
    name: '平盘对账数据处理'
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
  },
  // v3.1.6：VCC财务OP校验。
  vccFinancialOp: {
    id: 'vcc-financial-op',
    name: 'VCC财务OP校验'
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

const VCC_PREVIEW_CAPTURE_CONTRACT = Object.freeze({
  'vcc-financial-op-panel': Object.freeze({ method: 'openPanel', strategy: 'sync' }),
  'vcc-financial-op-import-month': Object.freeze({ method: 'openImportMonth', strategy: 'lifecycle' }),
  'vcc-financial-op-run-month': Object.freeze({ method: 'openRunMonth', strategy: 'lifecycle' }),
  'vcc-financial-op-data-manager': Object.freeze({ method: 'openDataManager', strategy: 'state' }),
  'vcc-financial-op-data-manager-no-archive': Object.freeze({ method: 'openDataManagerNoArchive', strategy: 'state' }),
  'vcc-financial-op-delete': Object.freeze({ method: 'openDelete', strategy: 'state' }),
  'vcc-financial-op-delete-first-month': Object.freeze({ method: 'openDeleteFirstMonth', strategy: 'state' }),
  'vcc-financial-op-delete-first-month-archived': Object.freeze({ method: 'openDeleteFirstMonthArchived', strategy: 'state' }),
  'vcc-financial-op-delete-result': Object.freeze({ method: 'openDeleteResult', strategy: 'state' }),
  'vcc-financial-op-unarchive': Object.freeze({ method: 'openUnarchive', strategy: 'state' }),
  'vcc-financial-op-unarchive-year-switch': Object.freeze({ method: 'openUnarchiveYearSwitch', strategy: 'state' }),
  'vcc-financial-op-unarchive-non-tail': Object.freeze({ method: 'openUnarchiveNonTail', strategy: 'state' }),
  'vcc-financial-op-unarchive-executing': Object.freeze({ method: 'openUnarchiveExecuting', strategy: 'state' }),
  'vcc-financial-op-export': Object.freeze({ method: 'openExport', strategy: 'state' }),
  'vcc-financial-op-result-export-month': Object.freeze({ method: 'openResultExportMonth', strategy: 'state' }),
  'vcc-financial-op-result-export-month-empty': Object.freeze({ method: 'openResultExportMonthEmpty', strategy: 'sync' }),
  'vcc-financial-op-result': Object.freeze({ method: 'openResult', strategy: 'lifecycle' }),
  'vcc-financial-op-result-single-adjustment': Object.freeze({ method: 'openResultSingleAdjustment', strategy: 'lifecycle' }),
  'vcc-financial-op-result-multiple-adjustments': Object.freeze({ method: 'openResultMultipleAdjustments', strategy: 'lifecycle' }),
  'vcc-financial-op-result-archived': Object.freeze({ method: 'openResultArchived', strategy: 'lifecycle' }),
  'vcc-financial-op-result-zoom-125': Object.freeze({ method: 'openResult', strategy: 'lifecycle' }),
  'vcc-financial-op-result-zoom-150': Object.freeze({ method: 'openResult', strategy: 'lifecycle' }),
  'vcc-financial-op-result-min-window': Object.freeze({ method: 'openResult', strategy: 'lifecycle' }),
  'vcc-financial-op-adjustment': Object.freeze({ method: 'openAdjustment', strategy: 'lifecycle' }),
  'vcc-financial-op-run-preflight-error': Object.freeze({ method: 'openRunPreflightError', strategy: 'sync' }),
  'vcc-financial-op-opening': Object.freeze({ method: 'openOpening', strategy: 'lifecycle' })
});

function registerVccPreviewCaptureReadiness(previewToken) {
  if (window.desktopApi.previewCapture !== true) return false;
  const afterPaint = () => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  const readiness = Promise.resolve().then(async () => {
    const contract = VCC_PREVIEW_CAPTURE_CONTRACT[previewToken];
    if (!contract) throw new Error(`Unknown VCC preview capture token: ${previewToken}`);
    const hooks = window.__vccFinancialOpPreview;
    if (!hooks) throw new Error('VCC preview hooks are unavailable');
    const hook = hooks[contract.method];
    if (typeof hook !== 'function') {
      throw new Error(`VCC preview hook is unavailable: ${contract.method}`);
    }
    const hookResult = hook();
    const isPromise = Boolean(hookResult && typeof hookResult.then === 'function');
    if (contract.strategy === 'state') {
      if (!isPromise) {
        throw new Error(`VCC state preview hook did not return a readiness task: ${contract.method}`);
      }
      await hookResult;
    } else if (contract.strategy === 'lifecycle') {
      if (!isPromise) {
        throw new Error(`VCC lifecycle preview hook did not return a Promise: ${contract.method}`);
      }
      let lifecycleError = null;
      Promise.resolve(hookResult).catch((error) => {
        lifecycleError = error;
      });
      await Promise.resolve();
      if (lifecycleError) throw lifecycleError;
    } else if (isPromise) {
      Promise.resolve(hookResult).catch(() => {});
      throw new Error(`VCC synchronous preview hook returned a Promise: ${contract.method}`);
    }
    await afterPaint();
    return { status: 'ready', token: previewToken };
  });
  readiness.catch(() => {});
  Object.defineProperty(window, '__vccPreviewCaptureReady', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: readiness
  });
  return true;
}

const rendererStartupProfiler = {
  startedAt: performance.now(),
  marks: new Map()
};
rendererStartupProfiler.marks.set(RENDERER_STARTUP_MARKS.scriptStart, rendererStartupProfiler.startedAt);

const state = {
  uiStyle: 'Clear',
  isMaximized: false,
  backgroundSettings: { ...DEFAULT_BACKGROUND_SETTINGS },
  backgroundDraft: { ...DEFAULT_BACKGROUND_SETTINGS },
  isBackgroundPaletteOpen: false,
  appUpdateStatus: { ...DEFAULT_APP_UPDATE_STATUS },
  appUpdateListenerReady: false,
  appUpdatePromptedVersion: '',
  appUpdatePromptPending: false,
  appUpdatePromptObserver: null,
  currentModule: MODULES.statementGenerator.id,
  enabledModules: [],
  isModuleMenuOpen: false,
  isBackgroundSpectrumDragging: false,
  backgroundPicker: {
    hasSelection: false,
    x: 0,
    y: 0,
    colorHex: DEFAULT_SPECTRUM_PICK_COLOR
  },
};

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
const shellAbort = new AbortController();
const shellDisposers = [];
let applicationDisposed = false;
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
    window.addEventListener(evt, report, { passive: true, signal: shellAbort.signal });
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
  // v3.0.15：重复入金匹配模块。
  duplicateInboundMatchModulePanel: document.getElementById('duplicateInboundMatchModulePanel'),
  duplicateInboundMatchImportBtn: document.getElementById('duplicateInboundMatchImportBtn'),
  duplicateInboundMatchRunBtn: document.getElementById('duplicateInboundMatchRunBtn'),
  duplicateInboundMatchExportBtn: document.getElementById('duplicateInboundMatchExportBtn'),
  duplicateInboundMatchStatusBox: document.getElementById('duplicateInboundMatchStatusBox'),
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
  vccFinancialOpModulePanel: document.getElementById('vccFinancialOpModulePanel'),
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
  // v3.0.24：平盘对账数据处理前端占位模块。
  positionReconciliationModulePanel: document.getElementById('positionReconciliationModulePanel'),
  positionReconciliationFunctionSelect: document.getElementById('positionReconciliationFunctionSelect'),
  positionReconciliationRunBtn: document.getElementById('positionReconciliationRunBtn'),
  positionReconciliationTableManagerBtn: document.getElementById('positionReconciliationTableManagerBtn'),
  positionReconciliationLinkedTableManagerBtn: document.getElementById('positionReconciliationLinkedTableManagerBtn'),
  positionReconciliationConfigBtn: document.getElementById('positionReconciliationConfigBtn'),
  positionReconciliationExportBtn: document.getElementById('positionReconciliationExportBtn'),
  positionReconciliationStatusBox: document.getElementById('positionReconciliationStatusBox'),
  backgroundTool: document.getElementById('backgroundTool'),
  backgroundPaletteBtn: document.getElementById('backgroundPaletteBtn'),
  saveUserGuideBtn: document.getElementById('saveUserGuideBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  appUpdateStatusDot: document.getElementById('appUpdateStatusDot'),
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

const modalHost = window.__modalHost.createModalHost({
  root: elements.modalRoot,
  document,
  reportError: (error) => console.warn('弹窗生命周期失败：', error?.code || error?.message),
  resolveFallbackFocus: () => document.querySelector('.module-panel:not([hidden]) button:not(:disabled)')
});
const modalBridge = window.__modalBridge.createModalBridge({
  host: modalHost,
  getOwner: () => state.currentModule || 'application'
});
function disposeApplication() {
  if (applicationDisposed) return;
  applicationDisposed = true;
  shellAbort.abort();
  state.appUpdatePromptObserver?.disconnect();
  shellDisposers.splice(0).forEach(dispose => { try { dispose?.(); } catch (error) { console.warn(error); } });
  rendererPreviews?.dispose();
  moduleRouter?.dispose();
  for (const controller of new Set([statementController, bankStatementController, reconIdFixController,
    rendererPending, positionReconciliationUI, bizOpV327Controller, ...Object.values(domainControllers)])) {
    try { controller?.dispose(); } catch (error) { console.warn(error); }
  }
  scenarioChangeRouter?.dispose();
  scenarioCommands.dispose();
  sharedReconSession.dispose();
  configurationServices.dispose();
  modalHost.dispose();
}
window.addEventListener('beforeunload', disposeApplication, { once: true });

let statementController = null;
let bankStatementController = null;
let reconIdFixController = null;
let scenarioChangeRouter = null;
const domainControllers = {};
const configurationServices = window.ConfigurationServices.createConfigurationServices({
  templatesApi: { list: window.desktopApi.templates.list }, reportError: error => console.warn('配置刷新失败：', error)
});
const configurationApi = Object.freeze({
  templates: window.desktopApi.templates, accountMappings: window.desktopApi.accountMappings,
  bigAccount: window.desktopApi.bigAccount, balanceAdjustment: window.desktopApi.balanceAdjustment,
  monthlyBalance: window.desktopApi.monthlyBalance, files: window.desktopApi.files,
  app: { getInfo: window.desktopApi.app.getInfo }
});
const scenarioCommands = window.ScenarioCommandService.createScenarioCommandService({
  scenariosApi: window.desktopApi.scenarios,
  channelsApi: window.desktopApi.channels,
  // 窗口重载没有旧 Main 写入的完成屏障，依赖旧类别的写保守重同步。
  writerBoundaryTrusted: false,
  publish: (event) => scenarioChangeRouter?.route(event),
  reportError: (error) => console.warn('场景变更通知失败：', error)
});
const sharedReconSession = window.SharedReconSession.createSharedReconSession({ api: window.desktopApi.reconIdFix });
// 旧 DOM 工厂经同一个 bridge 转为宿主 descriptor；这里不创建第二个弹窗宿主。
const domainModalHost = Object.freeze({
  openRoot: modalBridge.openModal, push: modalBridge.pushModal, replace: modalBridge.replaceModal,
  closeOwner: modalHost.closeOwner, closeTop: modalHost.closeTop, getTop: modalHost.getTop, getHandle: modalHost.getHandle
});
function initializeDomainControllers(info) {
  if (bankStatementController) return;
  const ui = { modalHost: domainModalHost, status: updateStatusBox,
    alert: createAlertDialog, confirm: createConfirmDialog, gatewayScenarioPicker: createGatewayReconScenarioPickerDialog,
    reportError: error => console.warn('领域刷新失败：', error),
    openScenarios: ({ owner, category }) => modalBridge.openModal(() => createScenariosManagerDialog(category ? [category]
      : ['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'builtin-fixed']), { owner }),
    openLinkedTables: ({ owner }) => modalBridge.openModal(() => createLinkedTableManagerDialog(), { owner }) };
  bankStatementController = window.BankStatementController.createBankStatementController({
    api: window.desktopApi.bankStatement, panel: elements.bankStatementModulePanel,
    config: { scenarios: { list: scenarioCommands.scenarios.list }, linkedTable: {
      rowCount: window.desktopApi.linkedTable.rowCount, import: window.desktopApi.linkedTable.import } },
    sharedReconSession, ui
  });
  reconIdFixController = window.ReconIdFixController.createReconIdFixController({
    api: { setReconIdFixBillCategory: window.desktopApi.settings.setReconIdFixBillCategory }, panel: elements.reconIdFixModulePanel,
    config: { initialBillCategory: info.reconIdFixBillCategory, scenarios: { list: scenarioCommands.scenarios.list } }, sharedReconSession, ui
  });
  statementController = window.StatementController.createStatementController({
    panel: elements.statementModulePanel, initialInfo: info,
    api: { files: window.desktopApi.files, monthlyBalance: window.desktopApi.monthlyBalance,
      templates: { importTemplate: window.desktopApi.templates.importTemplate }, accountMappings: window.desktopApi.accountMappings,
      errors: { exportLast: window.desktopApi.errors.exportLast } },
    config: { getTemplates: configurationServices.getTemplates, getCurrencyOptions: configurationServices.getCurrencyOptions,
      getAccountMappingCount: configurationServices.getAccountMappingCount, subscribe: configurationServices.subscribe,
      refreshTemplates: configurationServices.refreshTemplates },
    ui: { modalHost, modalBridge, status: updateStatusBox, reportError: ui.reportError, alertNative: window.alert.bind(window),
      createAlertDialog, createTemplateManagerDialog, createBigAccountSelectionDialog, createRememberOrderMismatchDialog,
      createExportScopeDialog, createMonthlyBalanceExportDialog, createManualBalanceSeedDialog, createAccountMappingDialog, createAccountMappingMigrationDialog }
  });
  const domainUi = { modalHost, modalBridge, status: updateStatusBox, alert: createAlertDialog, escapeHtml, reportError: ui.reportError };
  domainControllers.preFund = window.__preFundController.createPreFundController({ api: window.desktopApi.preFundReconciliation,
    panel: elements.preFundReconciliationModulePanel, ui: { ...domainUi, createPreFundTempManagerDialog } });
  domainControllers.bankBu = window.__bankBuController.createBankBuController({ api: window.desktopApi.bankBuRecon,
    panel: elements.bankBuReconModulePanel, ui: { ...domainUi, createBankBuReconMonthPickerDialog,
      createBankBuReconFileImportPromptDialog, createBankBuReconReconcileDialog, createBankBuReconExportDialog } });
  domainControllers.duplicateInbound = window.__duplicateInboundController.createDuplicateInboundController({ api: window.desktopApi.duplicateInboundMatch,
    panel: elements.duplicateInboundMatchModulePanel, ui: domainUi });
  domainControllers.vccOpCalc = window.__vccOpCalcController.createVccOpCalcController({ api: window.desktopApi.vccOpCalc,
    panel: elements.vccOpCalcModulePanel, ui: { ...domainUi, createVccOpCalcConfirmDialog, createVccOpCalcComputeDialog, createVccOpCalcShowBalanceDialog } });
  domainControllers.acquiring = window.__acquiringController.createAcquiringController({ api: window.desktopApi.acquiringBillCurrency,
    panel: elements.acquiringBillCurrencyModulePanel, ui: { ...domainUi, createAcquiringBillCurrencyMonthPickerDialog,
      confirmNative: window.confirm.bind(window) } });
  domainControllers.bizLegacy = window.__bizOpLegacyController.createBizOpLegacyController({ api: window.desktopApi.bizOpRecon,
    panel: elements.bizOpReconModulePanel, ui: { ...domainUi, createAlertDialog, createBizOpReconDatePickerDialog,
      createBizOpReconSecondImportPromptDialog, createBizOpReconReconcileDialog, createBizOpReconExportDialog, getBizOpReconDefaultDate } });
  domainControllers.newAccount = window.__newAccountController.createNewAccountController({
    api: { generate: window.desktopApi.newAccount.generate, exportFile: window.desktopApi.newAccount.exportFile,
      exportLastError: window.desktopApi.errors.exportLast }, panel: elements.newAccountModulePanel,
    config: { getCurrencyOptions: configurationServices.getCurrencyOptions, subscribe: configurationServices.subscribe }, ui: domainUi
  });
  domainControllers.vccFinancialOp = window.__vccFinancialOpController.createVccFinancialOpController({
    api: window.desktopApi.vccFinancialOp, panel: elements.vccFinancialOpModulePanel, modalHost,
    differenceApi: window.__vccFinancialOpDifference, reviewProjection: window.__vccReviewProjection,
    previewEnabled: window.desktopApi.previewCapture === true
  });
  bizOpV327Controller = window.createBizOpV327Controller({ api: window.desktopApi.bizOpReconV327,
    panel: document.getElementById('bizOpV327ModulePanel'), legacyPanel: elements.bizOpReconModulePanel,
    legacyController: domainControllers.bizLegacy, modalHost });
  scenarioChangeRouter = window.ScenarioChangeRouter.createScenarioChangeRouter({
    bankStatement: bankStatementController, reconIdFix: reconIdFixController,
    scenarioSubscribers: [() => reconIdFixController.reloadScenarios({ updateStatus: false })],
    reportError: ui.reportError
  });
}
const scenarioSubscriptions = Object.freeze({
  subscribeScenarios: (listener) => scenarioChangeRouter.subscribeScenarios(listener),
  subscribeChannels: (listener) => scenarioChangeRouter.subscribeChannels(listener)
});

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
  applyScenarioPreviewDraft,
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
  createMultipleSplitFieldPickerDialog,
  // v2.1.12 需求1：VCC业务OP计算 dialog factory（F1 确认 / F2 计算 / F3 显示余额）
  createVccOpCalcConfirmDialog,
  createVccOpCalcComputeDialog,
  createVccOpCalcShowBalanceDialog,
  applyVccOpCalcPanelInitialPreviewState,
  applyVccOpCalcPanelResultPreviewState,
  applyVccOpCalcComputeDialogPreviewState,
  applyVccOpCalcShowBalanceDialogPreviewState
} = window.__rendererDialogs.createRendererDialogs({
  modalBridge,
  configurationServices,
  configurationApi,
  dialogApis: { fundTransferAccountMappings: window.desktopApi.fundTransferAccountMappings,
    preFundReconciliation: window.desktopApi.preFundReconciliation, linkedTable: window.desktopApi.linkedTable, toolbox: window.desktopApi.toolbox },
  reportLog: window.desktopApi.app.reportLog,
  appConstants: window.appConstants,
  BALANCE_DISABLED_OPTION,
  BALANCE_CALCULATED_OPTION,
  MERCHANT_ID_SELF_INPUT_OPTION,
  ADVANCED_MAPPING_FIELDS,
  CONCAT_FIELDS_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION,
  refreshTemplates: configurationServices.refreshTemplates,
  setStatus,
  applyStatementResult,
  applyManualBalancePromptStatus,
  createFeedbackScope: () => statementController.createFeedbackScope(),
  scenarioCommands,
  scenarioSubscriptions,
  // v2.1.14 C：占位 helper 透传给 dialogs 闭包（链接表管理弹窗「导入」按钮调用）
  showComingSoon,
  // v2.1.0-beta.1 PR-A（task A9）：场景管理 dialog 任意 CRUD 完成后 reload 主面板"场景"下拉
});

const { createAppUpdateSettingsDialog, createArchiveCenterPreviewApi } = window.__appSettingsDialogs.createAppSettingsDialogs({
  api: { archiveCenter: window.desktopApi?.archiveCenter, appUpdate: window.desktopApi?.appUpdate },
  modalBridge,
  modules: MODULES,
  ui: { escapeHtml, createConfirmDialog, getDarkModeController,
    mountAppearanceSettings: (panel, controller) => window.DarkModeUI.mountSettings(panel, controller),
    applyAppUpdateActionResult, applyAppUpdateStatus,
    getAppUpdateStatus: () => state.appUpdateStatus,
    refreshOpenAppUpdateDialog, restartAndInstallAppUpdate }
});

const rendererPending = window.__pendingController.createPendingController({
  api: window.desktopApi.pending, panel: elements.pendingModulePanel,
  ui: { modalHost, modalBridge, createAlertDialog, createConfirmDialog, reportError: error => console.warn('Pending 失败：', error) }
});

const positionReconciliationUI = window.__positionReconciliation
  ? window.__positionReconciliation.createPositionReconciliationUI({
      api: window.desktopApi && window.desktopApi.positionReconciliation,
      panel: elements.positionReconciliationModulePanel,
      openModal,
      closeModal,
      createAlertDialog,
      createConfirmDialog,
      modalHost,
      modalBridge
    })
  : null;

const rendererPreviews = window.__rendererPreviews.createRendererPreviews({
  applyScenarioPreviewDraft,
  state: { get currentModule() { return state.currentModule; } },
  configurationPreview: { templates: configurationServices.applyPreviewTemplates,
    currencies: (currencyOptions) => configurationServices.acceptBootstrap({ currencyOptions, accountMappingCount: configurationServices.getAccountMappingCount() }),
    getTemplates: configurationServices.getTemplates },
  newAccountPreview: { applyRows: (rows) => domainControllers.newAccount.preview.applyRows(rows) },
  reconIdFixPreview: { applyCategory: (category) => reconIdFixController.applyPreviewCategory(category) },
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
  createMultipleSplitFieldPickerDialog,
  // v3.0.1 需求1（D4）：删除网关对账单弹框 preview 直接调用
  createLinkedTableDeleteRangeDialog,
  // v3.0.1 需求3：网关对账单修复场景单选框 preview 直接调用
  createGatewayReconScenarioPickerDialog
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
  // v3.0.17：退款流水号模糊匹配管理页 preview
  applyBuiltinFixedChannelManageRefundPreviewState,
  applyScenarioCategorySelectPreviewState,
  // v2.1.14 C：链接表管理弹窗 preview
  applyLinkedTableManagerPreviewState,
  // v3.0.14：临时链接表管理首页 preview
  applyPreFundTempManagerPreviewState,
  // v3.0.16：临时 MPT 明细错误失败页 preview
  applyPreFundTempImportFailurePreviewState,
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
  applyPositionReconciliationPanelPreviewState,
  applyScenarioConfigC4GatewayPreviewState,
  applyScenarioConfigC4Gateway1vNPreviewState,
  // v2.1.4 T3：小助手功能收纳弹窗 preview
  applyModuleCabinetPreviewState,
  // v3.0.8 需求1：工具箱🧰 主弹框 + 拆表选字段弹框 preview
  applyToolboxPreviewState,
  applyToolboxSplitFieldPickerPreviewState,
  applyToolboxSplitFieldPickerMultiplePreviewState
} = rendererPreviews;

function updateStatusBox(box, message, tone = 'info', options = {}) {
  const {
    errorReportReady = false,
    manualBalancePromptReady = false,
    idleTitle = ''
  } = options;

  // v3.1.13：只更新 .status-box-text 子节点，保持状态框结构与布局不变
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

let moduleRouter = null;
function getModuleRouter() {
  if (moduleRouter) return moduleRouter;
  const entry = (definition, panel, controller) => ({ id: definition.id, panel, controller });
  moduleRouter = window.ModuleRouter.createModuleRouter({
    defaultModuleId: MODULES.statementGenerator.id,
    modules: [
      entry(MODULES.statementGenerator, elements.statementModulePanel, statementController),
      entry(MODULES.newAccountGenerator, elements.newAccountModulePanel, domainControllers.newAccount),
      entry(MODULES.pendingReconciliation, elements.pendingModulePanel, rendererPending),
      entry(MODULES.bankStatementProcess, elements.bankStatementModulePanel,
        bankStatementController),
      entry(MODULES.preFundReconciliation, elements.preFundReconciliationModulePanel,
        domainControllers.preFund),
      entry(MODULES.reconIdFix, elements.reconIdFixModulePanel,
        reconIdFixController),
      entry(MODULES.positionReconciliation, elements.positionReconciliationModulePanel,
        positionReconciliationUI),
      entry(MODULES.bankBuRecon, elements.bankBuReconModulePanel,
        domainControllers.bankBu),
      entry(MODULES.duplicateInboundMatch, elements.duplicateInboundMatchModulePanel,
        domainControllers.duplicateInbound),
      entry(MODULES.acquiringBillCurrency, elements.acquiringBillCurrencyModulePanel,
        domainControllers.acquiring),
      entry(MODULES.vccOpCalc, elements.vccOpCalcModulePanel,
        domainControllers.vccOpCalc),
      entry(MODULES.vccFinancialOp, elements.vccFinancialOpModulePanel, domainControllers.vccFinancialOp),
      entry(MODULES.bizOpRecon, elements.bizOpReconModulePanel, bizOpV327Controller)
    ],
    onNavigate({ moduleId }) {
      state.currentModule = moduleId;
      const definition = Object.values(MODULES).find((item) => item.id === moduleId);
      elements.currentModuleName.textContent = definition.name;
      elements.moduleSwitcherMenu.querySelectorAll('.module-option').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.module === moduleId);
      });
    },
    persistCurrentModule: (moduleId) => window.desktopApi?.settings?.setCurrentModule?.(moduleId),
    reportError: (error) => console.warn('模块导航失败：', error)
  });
  return moduleRouter;
}

function setCurrentModule(moduleId, { persist = true } = {}) {
  return getModuleRouter().navigate(moduleId, { persist, reason: moduleRouter?.getCurrentModuleId() ? 'navigation' : 'startup' });
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
  if (document.documentElement.dataset.theme === 'dark' && !normalized.imageDataUrl) {
    // 深色主题使用自己的底色，不在浅色渐变或自定义图片上叠加遮罩。
    return {
      backgroundColor: '#111419',
      backgroundImage: 'none',
      backgroundSize: 'auto',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat'
    };
  }
  return buildLightBackgroundStyle(backgroundSettings);
}

function buildLightBackgroundStyle(backgroundSettings) {
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
  document.body.style.background = document.documentElement.dataset.theme === 'dark'
    ? '#111419' : rgbToCss(mixColor(normalized.colorHex, '#ffffff', 0.74));
  updateBackgroundControls(normalized);
}

function getDarkModeController() {
  if (!darkModeController && window.DarkModeUI) {
    darkModeController = window.DarkModeUI.createController({
      api: window.desktopApi?.settings,
      document,
      onChange: () => applyBackgroundSettings(
        state.isBackgroundPaletteOpen ? state.backgroundDraft : state.backgroundSettings
      )
    });
    window.addEventListener('unload', () => darkModeController.dispose(), { once: true });
  }
  return darkModeController;
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
    openModal(() => createAlertDialog(result.message));
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
    openModal(() => createAlertDialog(result.message));
    return;
  }

  state.backgroundSettings = cloneBackgroundSettings(result.backgroundConfig);
  applyBackgroundSettings(state.backgroundSettings);
  closeBackgroundPalette({ revert: false });
  setStatus(result.message, 'success');
}

function handleBackgroundReset() {
  openModal(
    () => createConfirmDialog({
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
          openModal(() => createAlertDialog(result.message));
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

function normalizeAppUpdateStatus(value) {
  const source = value && typeof value === 'object' ? value : {};
  const percent = Number(source.percent);
  return {
    ...DEFAULT_APP_UPDATE_STATUS,
    ...source,
    enabled: source.enabled === true,
    supported: source.supported === true,
    currentVersion: String(source.currentVersion || elements.appVersion?.textContent || ''),
    targetVersion: String(source.targetVersion || ''),
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    canRestart: source.canRestart === true,
    busyOperations: Array.isArray(source.busyOperations) ? source.busyOperations.map(String) : [],
    error: source.error && typeof source.error === 'object'
      ? String(source.error.message || '')
      : String(source.error || '')
  };
}

function appUpdateDistributionText(distribution) {
  if (distribution === 'nsis') return 'Windows 安装版';
  if (distribution === 'portable') return 'Windows 便携版';
  if (distribution === 'development') return '开发环境';
  return '当前环境';
}

function formatAppUpdateVersion(value) {
  const version = String(value || '').trim();
  if (!version) return '-';
  return version.startsWith('v') ? version : `v${version}`;
}

function formatAppUpdateCheckedAt(value) {
  if (!value) return '尚未检查';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚未检查';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function appUpdateStateText(status) {
  if (status.error) return status.error;
  if (!status.supported) {
    return status.distribution === 'portable'
      ? '便携版仅支持手动下载更新'
      : '当前环境不支持在线升级';
  }

  switch (status.state) {
    case 'disabled': return '自动更新已关闭';
    case 'idle': return '等待检查';
    case 'checking': return '正在检查更新';
    case 'available': return status.targetVersion ? `发现新版本 ${status.targetVersion}` : '发现新版本';
    case 'downloading': return `正在下载更新 ${status.percent.toFixed(0)}%`;
    case 'downloaded': return status.targetVersion ? `版本 ${status.targetVersion} 已下载` : '更新已下载';
    case 'up-to-date': return '当前已是最新版本';
    case 'error': return status.error || '检查更新失败';
    default: return '等待检查';
  }
}

function extractAppUpdateStatus(result) {
  if (result && typeof result === 'object' && typeof result.state === 'string') return result;
  if (result && typeof result === 'object' && result.updateStatus) return result.updateStatus;
  return null;
}

function applyAppUpdateActionResult(result, fallbackMessage) {
  const nextStatus = extractAppUpdateStatus(result) || state.appUpdateStatus;
  if (result && result.status !== 'success' && result.status !== 'ok') {
    applyAppUpdateStatus({
      ...nextStatus,
      state: 'error',
      error: result.message || fallbackMessage
    }, { prompt: false });
    return false;
  }
  applyAppUpdateStatus(nextStatus, { prompt: true });
  return true;
}

function renderAppUpdateIndicator() {
  const downloaded = state.appUpdateStatus.state === 'downloaded';
  if (elements.appUpdateStatusDot) elements.appUpdateStatusDot.hidden = !downloaded;
  if (elements.settingsBtn) {
    const label = downloaded ? '设置，更新已下载' : '设置';
    elements.settingsBtn.setAttribute('aria-label', label);
    elements.settingsBtn.title = label;
  }
}

function refreshOpenAppUpdateDialog() {
  const dialog = elements.modalRoot?.querySelector('.app-update-settings-card');
  if (!dialog) return;

  const status = state.appUpdateStatus;
  const toggle = dialog.querySelector('[data-role="auto-update-toggle"]');
  const toggleText = dialog.querySelector('[data-role="auto-update-toggle-text"]');
  const stateText = dialog.querySelector('[data-role="update-state"]');
  const versionText = dialog.querySelector('[data-role="current-version"]');
  const lastCheckedText = dialog.querySelector('[data-role="last-checked"]');
  const distributionText = dialog.querySelector('[data-role="distribution"]');
  const targetRow = dialog.querySelector('[data-role="target-row"]');
  const targetText = dialog.querySelector('[data-role="target-version"]');
  const progress = dialog.querySelector('[data-role="download-progress"]');
  const note = dialog.querySelector('[data-role="update-note"]');
  const checkButton = dialog.querySelector('[data-action="check-update"]');
  const restartButton = dialog.querySelector('[data-action="restart-update"]');
  const closeButton = dialog.querySelector('[data-role="close-update-dialog"]');
  const navDot = dialog.querySelector('[data-role="update-nav-dot"]');

  if (toggle) {
    toggle.checked = status.enabled;
    toggle.disabled = !status.supported || status.state === 'checking';
  }
  if (toggleText) toggleText.textContent = status.enabled ? '已开启' : '已关闭';
  if (stateText) stateText.textContent = appUpdateStateText(status);
  if (versionText) versionText.textContent = formatAppUpdateVersion(status.currentVersion);
  if (lastCheckedText) lastCheckedText.textContent = formatAppUpdateCheckedAt(status.lastCheckedAt);
  if (distributionText) distributionText.textContent = appUpdateDistributionText(status.distribution);
  if (targetRow) targetRow.hidden = !status.targetVersion;
  if (targetText) targetText.textContent = status.targetVersion || '-';
  if (progress) {
    progress.hidden = status.state !== 'downloading';
    progress.value = status.percent;
  }
  if (note) {
    note.textContent = status.distribution === 'portable'
      ? '便携版不会自动安装更新。点击“前往下载”可打开稳定版下载页面。'
      : '';
    note.hidden = note.textContent === '';
  }
  if (checkButton) {
    checkButton.textContent = status.distribution === 'portable' ? '前往下载' : '立即检查';
    checkButton.disabled = ['checking', 'downloading', 'downloaded'].includes(status.state);
  }
  if (restartButton) restartButton.hidden = !status.canRestart;
  if (closeButton) {
    closeButton.textContent = '返回';
  }
  if (navDot) navDot.hidden = status.state !== 'downloaded';
}

async function restartAndInstallAppUpdate({ inline = false } = {}) {
  let result;
  try {
    result = await window.desktopApi.appUpdate.restartAndInstall();
  } catch (error) {
    const message = error && error.message ? error.message : '暂时无法重启升级';
    applyAppUpdateStatus({
      ...state.appUpdateStatus,
      state: 'error',
      error: message
    }, { prompt: false });
    if (!inline) {
      openModal(() => createAlertDialog(message, { logDomain: 'app-update' }));
    }
    return false;
  }
  const nextStatus = extractAppUpdateStatus(result);
  if (nextStatus) applyAppUpdateStatus(nextStatus, { prompt: false });

  if (result && result.status !== 'success' && result.status !== 'ok') {
    const busy = Array.isArray(result.busyOperations) && result.busyOperations.length > 0
      ? `\n正在处理：${result.busyOperations.join('、')}`
      : '';
    if (inline) {
      applyAppUpdateStatus({
        ...state.appUpdateStatus,
        state: 'error',
        error: `${result.message || '暂时无法重启升级'}${busy}`
      }, { prompt: false });
    } else {
      openModal(() => createAlertDialog(`${result.message || '暂时无法重启升级'}${busy}`, {
        logDomain: 'app-update'
      }));
    }
    return false;
  }
  return true;
}

function showDownloadedUpdatePrompt(status) {
  const promptKey = status.targetVersion || 'downloaded';
  if (state.appUpdatePromptedVersion === promptKey) return;
  const activeModal = elements.modalRoot?.firstElementChild;
  if (activeModal) {
    if (activeModal.querySelector?.('.app-update-settings-card')) {
      state.appUpdatePromptedVersion = promptKey;
      state.appUpdatePromptPending = false;
    } else {
      state.appUpdatePromptPending = true;
    }
    return;
  }
  state.appUpdatePromptPending = false;
  state.appUpdatePromptedVersion = promptKey;
  openModal(() => createConfirmDialog({
    message: status.targetVersion
      ? `版本 ${status.targetVersion} 已下载完成，是否立即重启升级？`
      : '更新已下载完成，是否立即重启升级？',
    confirmText: '立即重启升级',
    cancelText: '稍后',
    onConfirm: async () => {
      closeModal();
      await restartAndInstallAppUpdate();
    }
  }));
}

function setupAppUpdatePromptObserver() {
  if (state.appUpdatePromptObserver || !elements.modalRoot || typeof MutationObserver !== 'function') return;
  state.appUpdatePromptObserver = new MutationObserver(() => {
    if (!state.appUpdatePromptPending || elements.modalRoot.childElementCount > 0) return;
    if (state.appUpdateStatus.state !== 'downloaded') {
      state.appUpdatePromptPending = false;
      return;
    }
    queueMicrotask(() => showDownloadedUpdatePrompt(state.appUpdateStatus));
  });
  state.appUpdatePromptObserver.observe(elements.modalRoot, { childList: true });
}

function applyAppUpdateStatus(value, { prompt = true } = {}) {
  state.appUpdateStatus = normalizeAppUpdateStatus(value);
  if (state.appUpdateStatus.state !== 'downloaded') state.appUpdatePromptPending = false;
  renderAppUpdateIndicator();
  refreshOpenAppUpdateDialog();
  if (prompt && state.appUpdateStatus.state === 'downloaded') {
    showDownloadedUpdatePrompt(state.appUpdateStatus);
  }
}

async function initializeAppUpdateStatus() {
  if (!window.desktopApi?.appUpdate) return;
  setupAppUpdatePromptObserver();
  if (!state.appUpdateListenerReady) {
    state.appUpdateListenerReady = true;
    shellDisposers.push(window.desktopApi.appUpdate.onStatusChanged((status) => {
      if (!applicationDisposed) applyAppUpdateStatus(status, { prompt: true });
    }));
  }
  try {
    const status = await window.desktopApi.appUpdate.getStatus();
    if (!applicationDisposed) applyAppUpdateStatus(status, { prompt: true });
  } catch (error) {
    console.warn('load app update status failed:', error);
  }
}

function applyUiStyle() {
  state.uiStyle = 'Clear';

  const cssClear = document.getElementById('cssClear');
  const cssClearExtra = document.getElementById('cssClearExtra');
  if (!cssClear || !cssClearExtra) return;

  cssClear.disabled = false;
  cssClearExtra.disabled = false;
  document.body.dataset.style = 'clear';
}

function showComingSoon(featureName) {
  openModal(() => createAlertDialog(
    `「${featureName}」功能将在后续版本开放，敬请期待。`,
    { skipLogReport: true }
  ));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function initialize() {
  markRendererStartup(RENDERER_STARTUP_MARKS.initializeStart);
  getDarkModeController();
  markRendererStartup(RENDERER_STARTUP_MARKS.getInfoStart);
  const info = await window.desktopApi.app.getInfo();
  markRendererStartup(RENDERER_STARTUP_MARKS.getInfoDone);

  await applyFullInfo(info);
}

async function applyFullInfo(info) {
  getDarkModeController()?.accept(info);
  // v2.1.13 E2：注入平台标识，CSS 以 body[data-platform="win32"] 限定 Win 端 Noto Sans SC 字体（仅 Win 生效）
  document.body.dataset.platform = (window.desktopApi && window.desktopApi.platform) || '';
  applyUiStyle();
  drawBackgroundSpectrum();
  resetBackgroundPickerSelection();
  elements.appVersion.textContent = info.version;
  initializeAppUpdateStatus().catch((error) => {
    console.warn('initialize app update status failed:', error);
  });
  configurationServices.acceptBootstrap(info);

  // v2.1.0-beta.3 T4：从持久化恢复对账单ReconID修复模块「账单类别」
  // v2.1.4 T4：DB 持久化为空（'' / null）时默认 'gateway' 并写回（O2 拍板）
  //   - 主面板下拉占位项 "请选择账单类别" 已删，UI 层不再可能为空；DB 历史空值在此一次性迁移
  if (!['business', 'gateway'].includes(info.reconIdFixBillCategory)) {
    window.desktopApi?.settings?.setReconIdFixBillCategory?.('gateway').catch(error => console.warn('persist default reconIdFixBillCategory failed:', error));
  }
  initializeDomainControllers(info);
  state.backgroundSettings = cloneBackgroundSettings(info.backgroundConfig);
  state.backgroundDraft = cloneBackgroundSettings(info.backgroundConfig);
  applyBackgroundSettings(state.backgroundSettings);

  markRendererStartup(RENDERER_STARTUP_MARKS.initialUiReady);
  markRendererStartup(RENDERER_STARTUP_MARKS.templatesRefreshStart);
  await configurationServices.refreshTemplates();
  markRendererStartup(RENDERER_STARTUP_MARKS.templatesRefreshDone);

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

  // v1.5.3 R2（D15）：自有账号迁移失败告警，覆盖默认状态栏文案；
  // 保留到用户手动关闭或下一次 setStatus 被其它动作覆盖
  if (info.ownAccountsMigrationError) {
    setStatus(info.ownAccountsMigrationError, 'error', {
      errorReportReady: false
    });
  }

  markRendererStartup(RENDERER_STARTUP_MARKS.eventsBindStart);

  // v3.1.0：平盘模块事件由 renderer-position-reconciliation.js 独立管理。

  elements.moduleSwitcherBtn.addEventListener('click', () => {
    if (state.isModuleMenuOpen) {
      closeModuleMenu();
      return;
    }

    openModuleMenu();
  }, { signal: shellAbort.signal });
  // v2.1.4 T3：module-option 改为动态渲染（renderTopModuleSwitcher）后用 event delegation 一次绑定
  elements.moduleSwitcherMenu.addEventListener('click', (event) => {
    const btn = event.target.closest('.module-option');
    if (!btn || !btn.dataset.module) return;
    setCurrentModule(btn.dataset.module);
    closeModuleMenu();
  }, { signal: shellAbort.signal });

  // v2.1.2 T2：月度银行对账单BU回填校验事件绑定（月份选择改为对话框，无 select change 事件）

  // v2.1.12 需求1：VCC业务OP计算模块事件绑定（导入 / 开始运行 / 显示余额）

  // v2.1.3：业务OP数据核对模块事件绑定

  // v2.1.6 Module B：收单单据币种校验事件绑定

  elements.backgroundPaletteBtn.addEventListener('click', () => {
    if (state.isBackgroundPaletteOpen) {
      closeBackgroundPalette();
      return;
    }

    openBackgroundPalette();
  }, { signal: shellAbort.signal });
  elements.saveUserGuideBtn.addEventListener('click', async () => {
    const result = await window.desktopApi.app.saveUserGuide();

    if (result.status === 'cancelled') {
      return;
    }

    setStatus(result.message, result.status === 'success' ? 'success' : 'error');
  }, { signal: shellAbort.signal });
  if (elements.settingsBtn) {
    elements.settingsBtn.addEventListener('click', () => {
      openModal(() => createAppUpdateSettingsDialog());
    }, { signal: shellAbort.signal });
  }
  // v2.1.4 T3：小助手功能收纳触发按钮
  if (elements.moduleCabinetBtn) {
    elements.moduleCabinetBtn.addEventListener('click', () => {
      openModal(() => createModuleCabinetDialog({
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
          return true;
        },
        onCommitted: () => {
          if (applicationDisposed) return;
          // 保存资格由原弹窗持有；正常关闭后再导航，避免被其 busy 关闭预检拒绝。
          // O4 拍板：若 currentModule 被移出启用列表 → 自动切到启用区第 1 个（persist=true 写回 DB）
          if (!state.enabledModules.includes(state.currentModule)) {
            setCurrentModule(state.enabledModules[0], { persist: true });
          }
          renderTopModuleSwitcher();
        }
      }));
    }, { signal: shellAbort.signal });
  }

  // v3.0.8 需求1：工具箱🧰 触发按钮 → 打开工具箱主弹框（合表/拆表）
  if (elements.toolboxBtn) {
    elements.toolboxBtn.addEventListener('click', () => {
      openModal(() => createToolboxDialog());
    }, { signal: shellAbort.signal });
  }

  elements.backgroundSpectrumArea.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    state.isBackgroundSpectrumDragging = true;
    elements.backgroundSpectrumArea.setPointerCapture?.(event.pointerId);
    pickBackgroundColorFromClientPoint(event.clientX, event.clientY);
  }, { signal: shellAbort.signal });
  elements.backgroundSpectrumArea.addEventListener('pointermove', (event) => {
    if (!state.isBackgroundSpectrumDragging) {
      return;
    }

    pickBackgroundColorFromClientPoint(event.clientX, event.clientY);
  }, { signal: shellAbort.signal });
  elements.backgroundSpectrumArea.addEventListener('pointerup', (event) => {
    state.isBackgroundSpectrumDragging = false;
    elements.backgroundSpectrumArea.releasePointerCapture?.(event.pointerId);
  }, { signal: shellAbort.signal });
  elements.backgroundSpectrumArea.addEventListener('pointercancel', () => {
    state.isBackgroundSpectrumDragging = false;
  }, { signal: shellAbort.signal });
  elements.backgroundSpectrumArea.addEventListener('lostpointercapture', () => {
    state.isBackgroundSpectrumDragging = false;
  }, { signal: shellAbort.signal });
  elements.backgroundImportBtn.addEventListener('click', () => {
    handleBackgroundImportFile().catch((error) => {
      console.error(error);
      setStatus('背景导入失败，请查看控制台', 'error');
    });
  }, { signal: shellAbort.signal });
  elements.backgroundDoneBtn.addEventListener('click', () => {
    handleBackgroundSave().catch((error) => {
      console.error(error);
      setStatus('背景保存失败，请查看控制台', 'error');
    });
  }, { signal: shellAbort.signal });
  elements.backgroundResetBtn.addEventListener('click', handleBackgroundReset, { signal: shellAbort.signal });

  elements.minimizeBtn.addEventListener('click', () => window.desktopApi.window.minimize(), { signal: shellAbort.signal });
  elements.maximizeBtn.addEventListener('click', async () => {
    const result = await window.desktopApi.window.toggleMaximize();
    state.isMaximized = result.isMaximized;
    elements.maximizeBtn.textContent = state.isMaximized ? '❐' : '□';
  }, { signal: shellAbort.signal });
  elements.closeBtn.addEventListener('click', () => window.desktopApi.window.close(), { signal: shellAbort.signal });

  shellDisposers.push(window.desktopApi.window.onMaximizedState((value) => {
    if (applicationDisposed) return;
    state.isMaximized = value;
    elements.maximizeBtn.textContent = value ? '❐' : '□';
  }));

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

    domainControllers.newAccount.handleOutsidePointerDown(event);
  }, { signal: shellAbort.signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.isModuleMenuOpen) {
        closeModuleMenu();
      }

      if (state.isBackgroundPaletteOpen) {
        closeBackgroundPalette();
      }

      domainControllers.newAccount.handleKeyDown(event);
    }
  }, { signal: shellAbort.signal });
  markRendererStartup(RENDERER_STARTUP_MARKS.eventsBindDone);

  if (info.previewModal === 'account-mapping') {
    setTimeout(() => {
      statementController.commands.openAccountMappings().catch((error) => {
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
  } else if (info.previewModal === 'app-update-settings') {
    setTimeout(() => {
      applyAppUpdateStatus({
        ...state.appUpdateStatus,
        enabled: true,
        supported: true,
        distribution: 'nsis',
        state: 'downloading',
        currentVersion: info.version,
        targetVersion: '3.0.19',
        percent: 42,
        lastCheckedAt: '2026-07-16T12:34:56.000Z'
      }, { prompt: false });
      openModal(() => createAppUpdateSettingsDialog());
    }, 120);
  } else if (info.previewModal === 'archive-center-settings') {
    setTimeout(() => {
      openModal(() => createAppUpdateSettingsDialog({ archiveCenterApi: createArchiveCenterPreviewApi() }));
      requestAnimationFrame(() => {
        const archiveTab = elements.modalRoot
          ?.querySelector('.app-settings-nav-item[data-tab="archive"]')
        archiveTab?.click();
        setTimeout(() => {
          elements.modalRoot
            ?.querySelector('[data-action="open-archive-settings"]')
            ?.click();
        }, 80);
      });
    }, 120);
  } else if (info.previewModal === 'archive-center-browser') {
    setTimeout(() => {
      openModal(() => createAppUpdateSettingsDialog({ archiveCenterApi: createArchiveCenterPreviewApi() }));
      requestAnimationFrame(() => {
        elements.modalRoot
          ?.querySelector('.app-settings-nav-item[data-tab="archive"]')
          ?.click();
      });
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
  } else if (info.previewModal === 'builtin-fixed-channel-manage-refund') {
    setTimeout(() => {
      applyBuiltinFixedChannelManageRefundPreviewState();
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
  } else if (info.previewModal === 'pre-fund-temp-import-failure') {
    setTimeout(() => {
      applyPreFundTempImportFailurePreviewState();
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
  } else if (info.previewModal === 'position-reconciliation-panel') {
    setTimeout(() => {
      applyPositionReconciliationPanelPreviewState();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-data-manager') {
    setTimeout(() => {
      positionReconciliationUI?.previewDataManager();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-differences') {
    setTimeout(() => {
      positionReconciliationUI?.previewDifferenceManager();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-linked-manager') {
    setTimeout(() => {
      positionReconciliationUI?.previewLinkedManager();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-raw-sources') {
    setTimeout(() => {
      positionReconciliationUI?.previewRawSourceDialog();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-source-delete') {
    setTimeout(() => {
      positionReconciliationUI?.previewSourceDeleteDialog();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-run-scope') {
    setTimeout(() => {
      positionReconciliationUI?.previewRunScopeDialog();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-result') {
    setTimeout(() => {
      positionReconciliationUI?.previewResultDialog();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-account-mapping') {
    setTimeout(() => {
      positionReconciliationUI?.previewMappingDialog();
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-import-progress') {
    setTimeout(() => {
      positionReconciliationUI?.previewImportProgress('preflight');
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-import-stopping') {
    setTimeout(() => {
      positionReconciliationUI?.previewImportProgress('stopping');
    }, 120);
  } else if (info.previewModal === 'position-reconciliation-import-committing') {
    setTimeout(() => {
      positionReconciliationUI?.previewImportProgress('committing');
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
  } else if (info.previewModal === 'duplicate-inbound-match-panel') {
    setTimeout(() => { applyDuplicateInboundMatchPanelPreviewState(); }, 120);
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
  } else if (info.previewModal.startsWith('vcc-financial-op-')) {
    setTimeout(() => {
      const route = setCurrentModule(MODULES.vccFinancialOp.id);
      route.ready.then(() => {
        if (route.status !== 'blocked' && moduleRouter.getCurrentModuleId() === MODULES.vccFinancialOp.id) {
          registerVccPreviewCaptureReadiness(info.previewModal);
        }
      });
    }, 120);
  } else if (info.previewModal === 'module-cabinet') {
    setTimeout(() => { applyModuleCabinetPreviewState(); }, 120);
  } else if (info.previewModal === 'toolbox') {
    setTimeout(() => { applyToolboxPreviewState(); }, 120);
  } else if (info.previewModal === 'toolbox-split-field-picker') {
    setTimeout(() => { applyToolboxSplitFieldPickerPreviewState(); }, 120);
  } else if (info.previewModal === 'toolbox-split-field-picker-multiple') {
    setTimeout(() => { applyToolboxSplitFieldPickerMultiplePreviewState(); }, 120);
  }

  markRendererStartup(RENDERER_STARTUP_MARKS.initComplete);
  reportRendererStartupMetrics();
  // v2.1.8 N1' (v0.7)：注册用户活动监听 → 10s 节流上报 main，作为 idle 30min 判定依据
  setupUserActivityReporter();
}

initialize().catch((error) => {
  console.error(error);
  setStatus('初始化失败，请查看控制台', 'error');
  disposeApplication();
});

function applyPreFundReconciliationPanelPreviewState() {
  const route = setCurrentModule(MODULES.preFundReconciliation.id, { persist: false });
  return route.ready.then(() => { if (moduleRouter.getCurrentModuleId() === MODULES.preFundReconciliation.id) domainControllers.preFund.commands.preview(); });
}
function applyDuplicateInboundMatchPanelPreviewState() {
  const route = setCurrentModule(MODULES.duplicateInboundMatch.id, { persist: false });
  return route.ready.then(() => { if (moduleRouter.getCurrentModuleId() === MODULES.duplicateInboundMatch.id) domainControllers.duplicateInbound.commands.preview(); });
}

function applyAcquiringPreview(text, tone) {
  const route = setCurrentModule(MODULES.acquiringBillCurrency.id, { persist: false });
  return route.ready.then(() => { if (moduleRouter.getCurrentModuleId() === MODULES.acquiringBillCurrency.id) domainControllers.acquiring.applyPreviewState({ text, tone }); });
}
function applyAcquiringBillCurrencyPanelInitialPreviewState() { return applyAcquiringPreview('欢迎使用小助手', 'info'); }
function applyAcquiringBillCurrencyPanelImportingPreviewState() { return applyAcquiringPreview('流水表导入成功：月份 2026-03，共 4,873,210 行', 'success'); }
function applyAcquiringBillCurrencyPanelResultPreviewState() { return applyAcquiringPreview('对账完成：共 4,873,210 条，币种差异 1,247 条，未匹配 38 条', 'success'); }

function setStatus(...args) {
  return statementController ? statementController.preview.setStatus(...args) : updateStatusBox(elements.statusBox, ...args);
}
function applyStatementResult(...args) { return statementController?.preview.applyStatementResult(...args); }
function applyManualBalancePromptStatus(...args) { return statementController?.preview.applyManualBalancePromptStatus(...args); }
function setExportAvailability(...args) { return statementController?.preview.setExportAvailability(...args); }

function syncNewAccountCurrencyMode(...args) { return domainControllers.newAccount?.preview.syncCurrencyMode(...args); }
function updateNewAccountGenerateAvailability(...args) { return domainControllers.newAccount?.preview.updateGenerateAvailability(...args); }
function setNewAccountExportAvailability(...args) { return domainControllers.newAccount?.preview.setExportAvailability(...args); }
function setNewAccountStatus(...args) { return domainControllers.newAccount?.preview.setStatus(...args); }
function getNewAccountStatusTitle(...args) { return domainControllers.newAccount?.preview.getStatusTitle(...args); }
function setNewAccountOpenDateValue(...args) { return domainControllers.newAccount?.preview.setOpenDateValue(...args); }
function closeAllNewAccountCurrencyDropdowns(...args) { return domainControllers.newAccount?.preview.closeCurrencyDropdowns(...args); }
