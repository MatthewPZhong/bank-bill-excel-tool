const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');
const { AppDatabase } = require('./backend/database');
const { openPendingDb, PENDING_DB_FILENAME } = require('./backend/pending-db');
const PENDING_COLUMNS = require('./backend/pending-db/columns');
const pendingRuleRepo = require('./backend/pending-db/rule-repository');
const pendingMonthRepo = require('./backend/pending-db/month-repository');
const pendingDiffRepo = require('./backend/pending-db/diff-repository');
const pendingReconcileEngine = require('./backend/pending-reconcile/engine');
const pendingExportWriter = require('./backend/pending-export/writer');
const { createPendingSession } = require('./main-process/pending-session');
const { runOwnAccountsMigration } = require('./backend/database/own-accounts-migration');
const { groupBigAccountRows } = require('./backend/database/utils');
const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  upsertBalanceSeedRecord,
  splitTemplateName
} = require('./backend/balance-seed-store');
const { parseBankAccountExcel } = require('./backend/bank-account-import');
const { writeOwnAccounts } = require('./backend/own-account-store');
const {
  readBalanceAdjustments,
  writeBalanceAdjustments,
  resolveBalanceAdjustment
} = require('./backend/balance-adjustment-store');
const { readBigAccountOrder, writeBigAccountOrder } = require('./backend/big-account-order-store');
const { readBigAccountMode, writeBigAccountMode } = require('./backend/big-account-mode-store');
const {
  calculateEndingBalanceFromAmounts,
  buildDetailExportRows,
  buildMappedRows,
  compileRegexLiteral,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  extractHeaders,
  inferEndingBalance,
  isRegexLiteral,
  loadCurrencyMappings,
  loadEnumValues,
  normalizeCell,
  parseDateValue,
  parseNumericValue,
  readRows,
  readRowsWithMetadata,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('./backend/file-service');
const {
  appendActivityRecord,
  appendLog,
  ensureActivityLogFile,
  writeErrorReport
} = require('./backend/logger');
const {
  reportStartupFailure
} = require('./backend/startup-failure');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  cloneRowsWithMetadata,
  getOrCreateStatementImportSession,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  removeStatementSessionEntriesByFilePath,
  resolveSinglePreparedFieldValue
} = require('./main-process/statement-session');
const {
  createStatementGenerationHelpers
} = require('./main-process/statement-generation');
const {
  ALL_BANKS_TEMPLATE_SCOPE,
  assembleMonthlyBalance,
  toBalanceRows
} = require('./main-process/monthly-balance');

if (process.env.APP_USER_DATA_DIR) {
  app.setPath('userData', process.env.APP_USER_DATA_DIR);
}

if (process.env.APP_DOCUMENTS_DIR) {
  app.setPath('documents', process.env.APP_DOCUMENTS_DIR);
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.openai.bankbillexceltool');
}

let mainWindow = null;
let database = null;
let pendingDb = null;
const pendingSession = createPendingSession({
  getPendingDb: () => pendingDb,
  getStorageRoot: () => ensureStorageRoot()
});
let lastGeneratedExports = {
  detail: null,
  balance: null,
  allDetail: null,
  allBalance: null,
  statementSessionKey: '',
  currentBatchId: '',
  newAccount: null,
  // v1.5.3 R1 (T1.3)：月度余额装配产物（与 statement session 独立；clearGeneratedExports 不清它）
  // 形态：{ filePath, fileName, templateScope, templateLabel, year, month, recordCount }
  monthlyBalance: null
};
let lastErrorReport = null;
let activityLogFilePath = '';
let lastFileImportContext = null;
let lastManualBalancePrompt = null;
let lastPendingBigAccountSelection = null;
let fileImportInProgress = false;
let statementImportSessions = new Map();
let nextStatementBatchId = 1;
let nextStatementFileEntryId = 1;
let startupMetricsReported = false;
// v1.5.3 R2：自有账号迁移失败消息（D15）。null = 无失败；字符串 = 启动时发生失败，
// renderer 首次 app:get-info 时读取并用 error tone 显示状态栏告警
let lastOwnAccountsMigrationError = null;

const DEFAULT_BACKGROUND_COLOR = '#efe8da';
// v2.0.0-beta.2 D16：Clear 风格的默认背景色（白）
const CLEAR_BACKGROUND_COLOR = '#ffffff';
const BUNDLED_ENUM_FILE_NAME = 'COMMON枚举.xlsx';
const CURRENCY_MAPPING_FILE_NAME = '币种映射表.xlsx';
const MISSING_ENUM_MESSAGE = '内置网银账单枚举表缺失，请检查安装包';
const BALANCE_DISABLED_OPTION = '无';
const BALANCE_CALCULATED_OPTION = '通过发生额计算';
const MERCHANT_ID_SELF_INPUT_OPTION = '自己输入';
const MERCHANT_ID_MULTI_ACCOUNT_MARKER = '__MULTI_BIG_ACCOUNT__';
const CONCAT_FIELDS_MAPPING_FIELD = '需要拼接字段';
const CUSTOM_INPUT_TARGET_FIELDS = new Set(['MerchantId']);
const SIGNED_AMOUNT_MAPPING_FIELD = '按正负号拆分的发生额';
const AMOUNT_BASED_NAME_MAPPING_FIELD = '根据发生额做映射的户名';
const AMOUNT_BASED_ACCOUNT_MAPPING_FIELD = '根据发生额做映射的账户号';
const AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD = '按字段区分发生额';
const AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION = '是';
const BILL_SPLIT_MERGE_MAPPING_FIELD = '是否拆分/合并明细账单';
const BILL_SPLIT_MERGE_ENABLED_OPTION = '是';
const REUSE_MODULE_MAPPING_FIELD = '复用模块字段的映射关系';
const REUSE_MODULE_DEFAULT_OPTION = '是';
// v1.5.2 需求 3（G3-6，决策 ③A）：保持 v4 不升 v5；新增的 `filenameFixedField` 为 v4 schema 下的透明扩展字段。
// - `buildTemplateLibraryPayload` 通过 `listTemplateBundleEntries` 透传该字段（template-repository.js:856）
// - `readTemplateBundleFile` 对未知字段采用显式解构式解析（:1221-1243），v1.5.1 旧应用读 v1.5.2 导出的 bundle 时自然忽略该字段
// - v1.5.1 旧 bundle 若不含该字段，读时 fallback 为空串（:1242）
const SUPPORTED_BUNDLE_VERSION = 4;
// v1.5.2 需求 3：主页面「按文件名映射模板」的虚拟模板 ID（非 DB 记录）
// helper 用于在接收 templateId 的调用点统一短路，避免将虚拟 ID 传入真实查询
const FILENAME_MAPPING_TEMPLATE_ID = '__FILENAME_MAPPING__';
function isFilenameMappingMode(templateId) {
  return templateId === FILENAME_MAPPING_TEMPLATE_ID;
}
const ADVANCED_MAPPING_FIELDS = [
  SIGNED_AMOUNT_MAPPING_FIELD,
  AMOUNT_BASED_NAME_MAPPING_FIELD,
  AMOUNT_BASED_ACCOUNT_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD
];
const BILL_SPLIT_GROUP_FIELDS = [
  BILL_SPLIT_MERGE_MAPPING_FIELD,
  REUSE_MODULE_MAPPING_FIELD
];
const NEW_ACCOUNT_EXPORT_NAME = 'NEW_BALANCE';
const BACKGROUND_IMAGE_LIMITS = Object.freeze({
  maxSizeBytes: 5 * 1024 * 1024,
  minWidth: 1200,
  minHeight: 700,
  maxWidth: 4096,
  maxHeight: 4096
});
const SUPPORTED_BACKGROUND_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const APP_ICON_FILE_NAMES = ['app-icon.ico', 'app-icon.png'];
const STARTUP_METRIC_MARKS = Object.freeze({
  processStart: 'process-start',
  appReady: 'app-when-ready',
  activityLogReady: 'activity-log-initialized',
  databaseReady: 'database-init-done',
  templateLibrarySynced: 'template-library-sync-done',
  handlersReady: 'handlers-registered',
  windowCreated: 'window-created',
  loadStarted: 'load-file-called',
  didFinishLoad: 'did-finish-load',
  readyToShow: 'ready-to-show'
});
const startupMetrics = {
  startedAt: performance.now(),
  marks: new Map(),
  renderer: null
};
startupMetrics.marks.set(STARTUP_METRIC_MARKS.processStart, startupMetrics.startedAt);

function pad(value) {
  return String(value).padStart(2, '0');
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarkdown(md) {
  return md
    .replace(/```\w*\n/g, '')
    .replace(/```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/^---$/gm, '')
    .replace(/^\|(.+)\|$/gm, (match, content) => {
      const cells = content.split('|').map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) return '';
      return cells.join('\t');
    })
    .replace(/\n{3,}/g, '\n\n');
}

function markStartupMetric(stageName) {
  startupMetrics.marks.set(stageName, performance.now());
}

function getStartupMetricValue(stageName) {
  return startupMetrics.marks.get(stageName);
}

function formatStartupDuration(milliseconds) {
  return `${milliseconds.toFixed(1)}ms`;
}

function buildStartupMetricsSnapshot() {
  const marks = Object.fromEntries(
    Array.from(startupMetrics.marks.entries()).map(([key, value]) => [key, Number((value - startupMetrics.startedAt).toFixed(3))])
  );
  const totalReadyToShow = getStartupMetricValue(STARTUP_METRIC_MARKS.readyToShow) - startupMetrics.startedAt;
  const createWindowToReady = getStartupMetricValue(STARTUP_METRIC_MARKS.readyToShow) - getStartupMetricValue(STARTUP_METRIC_MARKS.windowCreated);
  const loadToReady = getStartupMetricValue(STARTUP_METRIC_MARKS.readyToShow) - getStartupMetricValue(STARTUP_METRIC_MARKS.loadStarted);
  const loadToFinish = getStartupMetricValue(STARTUP_METRIC_MARKS.didFinishLoad) - getStartupMetricValue(STARTUP_METRIC_MARKS.loadStarted);

  return {
    marks,
    durations: {
      totalReadyToShowMs: Number(totalReadyToShow.toFixed(3)),
      createWindowToReadyMs: Number(createWindowToReady.toFixed(3)),
      loadToReadyMs: Number(loadToReady.toFixed(3)),
      loadToDidFinishMs: Number(loadToFinish.toFixed(3))
    },
    renderer: startupMetrics.renderer
  };
}

function writeStartupMetricsSnapshot(snapshot) {
  const targetPath = String(process.env.APP_STARTUP_METRICS_PATH || '').trim();

  if (!targetPath) {
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(`${targetPath}`, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function reportStartupMetrics() {
  if (startupMetricsReported) {
    return;
  }

  const readyToShowValue = getStartupMetricValue(STARTUP_METRIC_MARKS.readyToShow);
  const windowCreatedValue = getStartupMetricValue(STARTUP_METRIC_MARKS.windowCreated);
  const loadStartedValue = getStartupMetricValue(STARTUP_METRIC_MARKS.loadStarted);
  const didFinishLoadValue = getStartupMetricValue(STARTUP_METRIC_MARKS.didFinishLoad);

  if (
    readyToShowValue === undefined ||
    windowCreatedValue === undefined ||
    loadStartedValue === undefined ||
    didFinishLoadValue === undefined
  ) {
    return;
  }

  startupMetricsReported = true;
  const snapshot = buildStartupMetricsSnapshot();
  appendActivityLogEntry({
    level: 'info',
    message: '启动耗时',
    details: [
      `进程启动到可见：${formatStartupDuration(snapshot.durations.totalReadyToShowMs)}`,
      `建窗到可见：${formatStartupDuration(snapshot.durations.createWindowToReadyMs)}`,
      `loadFile 到 did-finish-load：${formatStartupDuration(snapshot.durations.loadToDidFinishMs)}`,
      `loadFile 到 ready-to-show：${formatStartupDuration(snapshot.durations.loadToReadyMs)}`
    ]
  });
  writeStartupMetricsSnapshot(snapshot);
}

function sanitizeRendererStartupMetrics(payload = {}) {
  const marks = payload && typeof payload.marks === 'object' && payload.marks !== null
    ? Object.fromEntries(
        Object.entries(payload.marks)
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
          .map(([key, value]) => [key, Number(value.toFixed(3))])
      )
    : {};
  const durations = payload && typeof payload.durations === 'object' && payload.durations !== null
    ? Object.fromEntries(
        Object.entries(payload.durations)
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
          .map(([key, value]) => [key, Number(value.toFixed(3))])
      )
    : {};

  return {
    marks,
    durations
  };
}

function buildStatementBatchId() {
  const batchId = `batch-${nextStatementBatchId}`;
  nextStatementBatchId += 1;
  return batchId;
}

function buildStatementFileEntryId() {
  const entryId = `entry-${nextStatementFileEntryId}`;
  nextStatementFileEntryId += 1;
  return entryId;
}

function getAppRootDirectory() {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }

  return app.getAppPath();
}

function getStorageRoot() {
  return path.join(app.getPath('documents'), '网银账单生成小助手');
}

function ensureStorageRoot() {
  const storageRoot = getStorageRoot();
  fs.mkdirSync(storageRoot, { recursive: true });
  return storageRoot;
}

function getBackgroundAssetsDir() {
  return path.join(ensureStorageRoot(), 'background');
}

function getActivityLogFallbackFilePath() {
  return path.join(ensureStorageRoot(), 'app_activity_log.txt');
}

function initializeActivityLog() {
  if (activityLogFilePath) {
    return activityLogFilePath;
  }

  activityLogFilePath = ensureActivityLogFile(getActivityLogFallbackFilePath());
  markStartupMetric(STARTUP_METRIC_MARKS.activityLogReady);

  appendActivityLogEntry({
    level: 'info',
    message: '应用启动',
    details: [`版本：${app.getVersion()}`]
  });
  return activityLogFilePath;
}

function handleStartupFailure(error) {
  let logPath = getActivityLogFallbackFilePath();

  try {
    logPath = initializeActivityLog();
  } catch (logError) {
    console.error(logError);
  }

  console.error(error);

  reportStartupFailure({
    error,
    logFilePath: logPath,
    appendRecord: (filePath, payload) => appendActivityRecord(filePath, payload),
    showErrorBox: (title, message) => dialog.showErrorBox(title, message),
    exit: (exitCode) => app.exit(exitCode)
  });
}

function appendActivityLogEntry({ level = 'info', message, details = [] }) {
  try {
    const targetPath = activityLogFilePath || initializeActivityLog();
    appendActivityRecord(targetPath, {
      level,
      message,
      details
    });
  } catch (error) {
    console.error(error);
  }
}

function getBundledIconPath() {
  const candidates = APP_ICON_FILE_NAMES.flatMap((fileName) => [
    path.join(app.getAppPath(), 'assets', fileName),
    path.join(__dirname, '..', 'assets', fileName)
  ]);
  return candidates.find((filePath) => fs.existsSync(filePath)) || '';
}

function loadBundledIcon() {
  const iconPath = getBundledIconPath();
  if (!iconPath) {
    return undefined;
  }

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

function clearLastErrorReport() {
  lastErrorReport = null;
}

function clearPendingManualBalancePrompt() {
  lastManualBalancePrompt = null;
}

function clearPendingBigAccountSelection() {
  lastPendingBigAccountSelection = null;
}

function rememberLastFileImportContext(context = null) {
  lastFileImportContext = context
    ? {
        templateId: context.templateId,
        template: context.template,
        mappings: Array.isArray(context.mappings) ? context.mappings.map((mapping) => ({ ...mapping })) : [],
        orderedTargetFields: Array.isArray(context.orderedTargetFields) ? context.orderedTargetFields.slice() : [],
        inputFilePaths: normalizeInputFilePaths(context.inputFilePaths || context.inputFilePath),
        selectedBigAccount: context.selectedBigAccount
          ? {
              merchantId: normalizeCell(context.selectedBigAccount.merchantId),
              currency: normalizeCell(context.selectedBigAccount.currency)
            }
          : null,
        preparedDetailRows: context.preparedDetailRows
          ? cloneRowsWithMetadata(context.preparedDetailRows)
          : null,
        scope: normalizeCell(context.scope) || 'current',
        statementSessionKey: normalizeCell(context.statementSessionKey),
        currentBatchId: normalizeCell(context.currentBatchId)
      }
    : null;
}

function rememberPendingBigAccountSelection(context = null) {
  lastPendingBigAccountSelection = context
    ? {
        templateId: context.templateId,
        template: context.template,
        mappings: Array.isArray(context.mappings) ? context.mappings.map((mapping) => ({ ...mapping })) : [],
        orderedTargetFields: Array.isArray(context.orderedTargetFields) ? context.orderedTargetFields.slice() : [],
        inputFilePaths: normalizeInputFilePaths(context.inputFilePaths || context.inputFilePath),
        bigAccounts: Array.isArray(context.bigAccounts)
          ? context.bigAccounts.map((item) => ({
              merchantId: normalizeCell(item.merchantId),
              currencies: Array.isArray(item.currencies)
                ? item.currencies.map((value) => normalizeCell(value)).filter((value) => value !== '')
                : [],
              isMultiCurrency: Boolean(item.isMultiCurrency)
            }))
          : [],
        fixedAssignments: Array.isArray(context.fixedAssignments)
          ? context.fixedAssignments.map((item) => ({
              merchantId: normalizeCell(item.merchantId),
              currency: normalizeCell(item.currency),
              rowIndex: Number(item.rowIndex || 0)
            }))
          : [],
        fileEntries: Array.isArray(context.fileEntries)
          ? context.fileEntries.map((entry) => ({
              filePath: entry.filePath,
              detailRows: cloneRowsWithMetadata(entry.detailRows),
              matchedHeaders: Array.isArray(entry.matchedHeaders) ? entry.matchedHeaders.slice() : null,
              selfInputMerchant: Boolean(entry.selfInputMerchant),
              skipDirectMerchantLookup: Boolean(entry.skipDirectMerchantLookup),
              matchedTemplateId: entry.matchedTemplateId || null
            }))
          : [],
        rows: Array.isArray(context.rows)
          ? context.rows.map((row) => ({
              index: Number(row.index || 0),
              sourceRowNumber: Number(row.sourceRowNumber || 0),
              fileName: normalizeCell(row.fileName),
              filePath: row.filePath || ''
            }))
          : [],
        rowsWithEmptyBlocks: Array.isArray(context.rowsWithEmptyBlocks)
          ? context.rowsWithEmptyBlocks.map((row) => ({
              index: Number(row.index || 0),
              sourceRowNumber: Number(row.sourceRowNumber || 0),
              fileName: normalizeCell(row.fileName),
              filePath: row.filePath || ''
            }))
          : undefined
      }
    : null;
}

function buildManualBalanceRequiredResult(prompt, generatedFiles) {
  clearLastErrorReport();
  const normalizedPrompt = prompt
    ? {
        ...prompt,
        queueIndex: Number.isInteger(prompt.queueIndex) && prompt.queueIndex > 0 ? prompt.queueIndex : 1,
        queueTotal: Number.isInteger(prompt.queueTotal) && prompt.queueTotal > 0 ? prompt.queueTotal : 1
      }
    : null;
  lastManualBalancePrompt = normalizedPrompt ? { ...normalizedPrompt } : null;
  appendActivityLogEntry({
    level: 'info',
    message: '等待补录上一账单日余额',
    details: [
      `模板名：${normalizedPrompt?.templateName || 'N/A'}`,
      `银行账号：${normalizedPrompt?.merchantId || 'N/A'}`,
      `币种：${normalizedPrompt?.currency || '(空)'}`,
      `当前账单日期：${normalizedPrompt?.targetBillDate || 'N/A'}`
    ]
  });

  return {
    status: 'manual-balance-required',
    message: '因首次导入余额，请导入上一个账单日余额用于余额校验',
    detailReady: Boolean(generatedFiles?.detail),
    balanceReady: false,
    errorReportReady: false,
    manualBalancePromptReady: true,
    manualBalancePrompt: normalizedPrompt ? { ...normalizedPrompt } : null
  };
}

function buildBigAccountSelectionRequiredResult({ rows = [], rowsWithEmptyBlocks, bigAccounts = [], fixedAssignments = [], templateId } = {}) {
  clearLastErrorReport();
  const mapRow = (row, index) => ({
    index: Number.isInteger(row.index) ? row.index : index,
    label: `${index + 1}.`,
    sourceRowNumber: Number(row.sourceRowNumber || 0),
    fileName: normalizeCell(row.fileName),
    filePath: row.filePath || ''
  });
  return {
    status: 'select-big-account',
    message: '请选择本次使用的大账号 / 币种',
    selectionMode: 'multi-row',
    templateId,
    rows: rows.map(mapRow),
    rowsWithEmptyBlocks: (rowsWithEmptyBlocks || rows).map(mapRow),
    bigAccounts: bigAccounts.map((item) => ({
      merchantId: normalizeCell(item.merchantId),
      currencies: Array.isArray(item.currencies)
        ? item.currencies.map((value) => normalizeCell(value)).filter((value) => value !== '')
        : [],
      isMultiCurrency: Boolean(item.isMultiCurrency)
    })),
    expandedBigAccountOptions: expandBigAccountConfigurations(bigAccounts),
    fixedAssignments: fixedAssignments.map((item) => ({
      merchantId: normalizeCell(item.merchantId),
      currency: normalizeCell(item.currency),
      rowIndex: Number(item.rowIndex || 0)
    }))
  };
}

function buildPendingBigAccountFileEntries({ template, mappings, orderedTargetFields, inputFilePaths = [] }) {
  const config = buildStatementGenerationConfig({
    template,
    mappings,
    orderedTargetFields,
    allowManagedMerchantWithoutSelection: true
  });
  const merchantLookupFlags = buildManagedMerchantLookupFlags(mappings);

  return normalizeInputFilePaths(inputFilePaths, { dedupe: false }).map((inputFilePath) => ({
    filePath: inputFilePath,
    ...merchantLookupFlags,
    detailRows: buildMappedRowsForFile({
      config,
      inputFilePath
    })
  }));
}

function buildManagedMerchantLookupFlags(mappings = []) {
  const merchantIdMapping = (Array.isArray(mappings) ? mappings : []).find((mapping) => {
    return normalizeCell(mapping.templateField) === 'MerchantId';
  });
  const mappedField = normalizeCell(merchantIdMapping?.mappedField);
  const isManagedMerchant = mappedField === MERCHANT_ID_SELF_INPUT_OPTION
    || mappedField.startsWith(FIXED_FIELD_VALUE_PREFIX);

  return {
    selfInputMerchant: isManagedMerchant,
    skipDirectMerchantLookup: mappedField === MERCHANT_ID_SELF_INPUT_OPTION
  };
}

function getEntryTemplateConfig({ entry, fallbackTemplateConfig, cache = new Map() }) {
  const fallbackTemplateId = Number(fallbackTemplateConfig?.template?.id || 0);
  const matchedTemplateId = Number(entry?.matchedTemplateId || 0);

  if (!matchedTemplateId || matchedTemplateId === fallbackTemplateId) {
    return fallbackTemplateConfig;
  }

  if (cache.has(matchedTemplateId)) {
    return cache.get(matchedTemplateId);
  }

  const matchedTemplateConfig = getTemplateMappingConfig(matchedTemplateId) || fallbackTemplateConfig;
  cache.set(matchedTemplateId, matchedTemplateConfig);
  return matchedTemplateConfig;
}

function resolveGenerationTemplateConfig({ fileEntries = [], fallbackTemplateConfig }) {
  // Parent template imports may actually be generated by a single matched child template.
  const fallbackTemplateId = Number(fallbackTemplateConfig?.template?.id || 0);
  const templateIds = Array.from(new Set(
    (Array.isArray(fileEntries) ? fileEntries : []).map((entry) => {
      const matchedTemplateId = Number(entry?.matchedTemplateId || 0);
      return matchedTemplateId || fallbackTemplateId;
    })
  ));

  if (templateIds.length !== 1 || !templateIds[0] || templateIds[0] === fallbackTemplateId) {
    return fallbackTemplateConfig;
  }

  return getTemplateMappingConfig(templateIds[0]) || fallbackTemplateConfig;
}

function rebuildMatchedTemplateFileEntries({
  fileEntries = [],
  fallbackTemplateConfig,
  selectedBigAccount = null
}) {
  // Rebuild rows from the raw file so child-template mappings and selected big-account values
  // both flow into the final export rows instead of reusing parent provisional rows.
  const templateConfigCache = new Map();

  return (Array.isArray(fileEntries) ? fileEntries : []).map((entry) => {
    const entryTemplateConfig = getEntryTemplateConfig({
      entry,
      fallbackTemplateConfig,
      cache: templateConfigCache
    });
    // 只有多大账号模板才传 selectedBigAccount，避免覆盖子模板自身的 fixed/custom MerchantId
    const entryMerchantMapping = (entryTemplateConfig.exportMappings || []).find(
      (m) => normalizeCell(m.templateField) === 'MerchantId'
    );
    const entryIsMultiBigAccount = normalizeCell(entryMerchantMapping?.mappedField)
      === `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`;
    const entrySelectedBigAccount = entryIsMultiBigAccount ? selectedBigAccount : null;
    const config = buildStatementGenerationConfig({
      template: entryTemplateConfig.template,
      mappings: entryTemplateConfig.exportMappings,
      orderedTargetFields: entryTemplateConfig.exportTargetFields,
      selectedBigAccount: entrySelectedBigAccount,
      allowManagedMerchantWithoutSelection: true
    });
    const merchantLookupFlags = buildManagedMerchantLookupFlags(entryTemplateConfig.exportMappings);

    return {
      filePath: entry.filePath,
      detailRows: buildMappedRowsForFile({
        config,
        inputFilePath: entry.filePath
      }),
      matchedTemplateId: entry.matchedTemplateId || entryTemplateConfig.template.id || null,
      matchedHeaders: Array.isArray(entry.matchedHeaders)
        ? entry.matchedHeaders.slice()
        : (entryTemplateConfig.template.headers || []).slice(),
      selfInputMerchant: Boolean(entry.selfInputMerchant || merchantLookupFlags.selfInputMerchant),
      skipDirectMerchantLookup: Boolean(
        entry.skipDirectMerchantLookup || merchantLookupFlags.skipDirectMerchantLookup
      )
    };
  });
}

function identifyAccountBlocks(detailRows, options = {}) {
  const { includeEmptyBlocks = false } = options;
  const headerRow = detailRows[0] || [];
  const dataRows = detailRows.slice(1);
  const rowMetas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];
  const headerBreaks = Array.isArray(detailRows.headerBreaks) ? detailRows.headerBreaks : [];

  if (!headerBreaks.length) {
    return [{
      startIndex: 0,
      endIndex: Math.max(0, dataRows.length - 1),
      startRowNumber: rowMetas[0]?.sourceRowNumber || 2
    }];
  }

  const creditIndex = headerRow.indexOf('Credit Amount');
  const debitIndex = headerRow.indexOf('Debit Amount');

  function isTransactionRow(row) {
    if (!Array.isArray(row)) return false;
    const credit = creditIndex >= 0 ? normalizeCell(row[creditIndex]) : '';
    const debit = debitIndex >= 0 ? normalizeCell(row[debitIndex]) : '';
    return credit !== '' || debit !== '';
  }

  function trimBlock(startIndex, endIndex) {
    while (endIndex >= startIndex && !isTransactionRow(dataRows[endIndex])) {
      endIndex--;
    }
    while (startIndex <= endIndex && !isTransactionRow(dataRows[startIndex])) {
      startIndex++;
    }
    return { startIndex, endIndex };
  }

  const blocks = [];
  let blockStart = 0;
  let prevBreakRowNumber = null;

  headerBreaks.forEach((breakRowNumber) => {
    const splitIndex = rowMetas.findIndex(
      (meta, i) => i >= blockStart && meta.sourceRowNumber >= breakRowNumber
    );
    const effectiveSplit = splitIndex >= 0 ? splitIndex : dataRows.length;

    const rawEnd = effectiveSplit > blockStart ? effectiveSplit - 1 : blockStart - 1;
    const trimmed = trimBlock(blockStart, rawEnd);
    if (includeEmptyBlocks) {
      blocks.push({
        startIndex: trimmed.startIndex,
        endIndex: trimmed.endIndex,
        startRowNumber: rowMetas[trimmed.startIndex]?.sourceRowNumber || prevBreakRowNumber || blockStart + 2
      });
    } else if (trimmed.startIndex <= trimmed.endIndex) {
      blocks.push({
        startIndex: trimmed.startIndex,
        endIndex: trimmed.endIndex,
        startRowNumber: rowMetas[trimmed.startIndex]?.sourceRowNumber || prevBreakRowNumber || trimmed.startIndex + 2
      });
    }
    blockStart = effectiveSplit;
    prevBreakRowNumber = breakRowNumber;
  });

  const lastBreakRowNumber = headerBreaks[headerBreaks.length - 1];
  const lastTrimmed = trimBlock(blockStart, dataRows.length - 1);
  if (includeEmptyBlocks) {
    blocks.push({
      startIndex: lastTrimmed.startIndex,
      endIndex: lastTrimmed.endIndex,
      startRowNumber: rowMetas[lastTrimmed.startIndex]?.sourceRowNumber || lastBreakRowNumber || blockStart + 2
    });
  } else if (lastTrimmed.startIndex <= lastTrimmed.endIndex) {
    blocks.push({
      startIndex: lastTrimmed.startIndex,
      endIndex: lastTrimmed.endIndex,
      startRowNumber: rowMetas[lastTrimmed.startIndex]?.sourceRowNumber || lastBreakRowNumber || lastTrimmed.startIndex + 2
    });
  }

  if (blocks.length) {
    return blocks;
  }

  if (!headerBreaks.length) {
    return [{
      startIndex: 0,
      endIndex: Math.max(0, dataRows.length - 1),
      startRowNumber: rowMetas[0]?.sourceRowNumber || 2
    }];
  }

  return [];
}

function stripSpecialCharsForMatch(value) {
  return String(value || '').replace(/[\s\-_()（）[\]【】]/g, '');
}

function matchMerchantIds(cellValue, merchantId) {
  const a = normalizeCell(cellValue);
  const b = normalizeCell(merchantId);
  if (!a || !b) return 'none';
  if (a === b) return 'exact';
  const sa = stripSpecialCharsForMatch(a);
  const sb = stripSpecialCharsForMatch(b);
  if (sa && sb && sa === sb) return 'fuzzy';
  if (sa && sb && (sa.includes(sb) || sb.includes(sa))) return 'fuzzy';
  return 'none';
}

function findHeaderRowNumbersInRawRows(rawRows, expectedSourceHeaders) {
  const normalizedExpected = (expectedSourceHeaders || [])
    .map((h) => normalizeCell(h))
    .filter((h) => h !== '');
  if (!normalizedExpected.length) return [];

  const results = [];
  rawRows.forEach((row, index) => {
    const cells = Array.isArray(row) ? row : [];
    const maxStart = cells.length - normalizedExpected.length;
    for (let start = 0; start <= maxStart; start += 1) {
      const match = normalizedExpected.every(
        (exp, ei) => normalizeCell(cells[start + ei]) === exp
      );
      if (match) {
        results.push(index + 1);
        break;
      }
    }
  });
  return results;
}

function identifyAccountsFromFile({ filePath, detailRows, expectedSourceHeaders, allMerchantIds }) {
  const rawRows = readRows(filePath, { blankrows: true });
  const headerRowNumbers = findHeaderRowNumbersInRawRows(rawRows, expectedSourceHeaders);
  const isSingleAccount = headerRowNumbers.length <= 1;
  const identified = [];

  function searchCandidateRange(startIdx, endIdx) {
    let bestMatch = null;
    let bestMatchType = 'none';

    // 从 header 往回搜（倒序），优先命中最靠近 header 的"查询账号"行，
    // 避免被更远的交易数据行里的账户号字段污染
    for (let rowIdx = Math.min(endIdx, rawRows.length - 1); rowIdx >= startIdx; rowIdx -= 1) {
      const row = rawRows[rowIdx];
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const cellStr = normalizeCell(cell);
        if (!cellStr) continue;
        for (const mid of allMerchantIds) {
          const result = matchMerchantIds(cellStr, mid);
          if (result === 'exact') {
            bestMatch = mid;
            bestMatchType = 'exact';
            break;
          }
          if (result === 'fuzzy' && bestMatchType !== 'exact') {
            bestMatch = mid;
            bestMatchType = 'fuzzy';
          }
        }
        if (bestMatchType === 'exact') break;
      }
      if (bestMatchType === 'exact') break;
    }

    return bestMatch ? { merchantId: bestMatch, matchType: bestMatchType } : null;
  }

  headerRowNumbers.forEach((headerRowNum, idx) => {
    // 只搜索 header 前面有限行（避免搜到上一个账户的交易数据行里的账户号）
    // BOC-CN 格式：查询账号在 header 上方约 7 行，留 10 行余量
    const prevBoundary = idx === 0 ? 0 : headerRowNumbers[idx - 1];
    const narrowStart = Math.max(prevBoundary, headerRowNum - 10);
    const candidateEndIdx = headerRowNum - 2;
    const match = searchCandidateRange(narrowStart, candidateEndIdx);
    if (match) {
      identified.push(match);
    }
  });

  if (headerRowNumbers.length === 0) {
    const match = searchCandidateRange(0, rawRows.length - 1);
    if (match) {
      identified.push(match);
    }
  }

  return { accounts: identified, isSingleAccount };
}

function buildBigAccountSelectionRows(fileEntries = [], options = {}) {
  const { includeEmptyBlocks = false } = options;
  const rows = [];
  let rowIndex = 0;

  // v1.5.2 需求 2（决策 ①B）：每 row 追加 fileIndex（可视化辅助字段，同文件多 block 聚合渲染用）；
  // 注意：fileIndex 不作为 M:1 状态机 key；状态机 key 统一使用 rows[i].index（即 rowIndex）。
  fileEntries.forEach((entry, fileIndex) => {
    const blocks = identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks });

    blocks.forEach((block) => {
      rows.push({
        index: rowIndex,
        fileIndex,
        sourceRowNumber: block.startRowNumber,
        fileName: path.basename(entry.filePath),
        filePath: entry.filePath,
        blockStartIndex: block.startIndex,
        blockEndIndex: block.endIndex
      });
      rowIndex += 1;
    });
  });

  return rows;
}

function applyBigAccountAssignmentsToFileEntries(fileEntries = [], assignments = [], options = {}) {
  const { includeEmptyBlocks = false } = options;
  const normalizedAssignments = assignments.map((item, index) => ({
    merchantId: normalizeCell(item.merchantId),
    currency: normalizeCell(item.currency),
    rowIndex: Number.isInteger(item.rowIndex) ? item.rowIndex : index
  }));
  const assignmentByRowIndex = new Map(normalizedAssignments.map((item) => [item.rowIndex, item]));
  let globalBlockIndex = 0;

  return fileEntries.map((entry) => {
    const nextRows = cloneRowsWithMetadata(entry.detailRows);
    const fieldIndexMap = buildFieldIndexMap(nextRows[0] || []);
    const merchantIdIndex = fieldIndexMap.get('MerchantId');
    const currencyIndex = fieldIndexMap.get('Currency');
    const dataRows = nextRows.slice(1);
    const blocks = identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks });

    const keepIndices = new Set();

    blocks.forEach((block) => {
      const assignment = assignmentByRowIndex.get(globalBlockIndex);

      for (let i = block.startIndex; i <= block.endIndex && i < dataRows.length; i++) {
        keepIndices.add(i);
        if (assignment) {
          const row = dataRows[i];
          if (merchantIdIndex !== undefined) {
            row[merchantIdIndex] = assignment.merchantId;
          }
          if (currencyIndex !== undefined) {
            row[currencyIndex] = assignment.currency;
          }
        }
      }

      globalBlockIndex += 1;
    });

    const filteredRows = [nextRows[0]];
    const filteredRowMetas = [];
    dataRows.forEach((row, i) => {
      if (keepIndices.has(i)) {
        filteredRows.push(row);
        if (Array.isArray(nextRows.rowMetas) && nextRows.rowMetas[i]) {
          filteredRowMetas.push(nextRows.rowMetas[i]);
        }
      }
    });
    filteredRows.rowMetas = filteredRowMetas;
    if (Array.isArray(nextRows.issues)) filteredRows.issues = nextRows.issues;
    if (Array.isArray(nextRows.headerBreaks)) filteredRows.headerBreaks = [];
    if (Array.isArray(nextRows.skippedRows)) filteredRows.skippedRows = nextRows.skippedRows;
    if (Array.isArray(nextRows.simultaneousRows)) filteredRows.simultaneousRows = nextRows.simultaneousRows;

    return {
      filePath: entry.filePath,
      detailRows: filteredRows,
      matchedHeaders: Array.isArray(entry.matchedHeaders) ? entry.matchedHeaders.slice() : null,
      selfInputMerchant: Boolean(entry.selfInputMerchant),
      skipDirectMerchantLookup: Boolean(entry.skipDirectMerchantLookup),
      matchedTemplateId: entry.matchedTemplateId || null
    };
  });
}

function createErrorReport(payload) {
  const report = writeErrorReport(ensureStorageRoot(), payload);
  lastErrorReport = report;
  return report;
}

function createErrorResult({
  step,
  message,
  errorCode = 'BUSINESS_ERROR',
  errorType = '业务校验错误',
  detailLines = [],
  context = {},
  templateName = '',
  originalError = null
}) {
  const report = createErrorReport({
    step,
    message,
    errorCode,
    errorType,
    detailLines,
    context,
    templateName,
    originalError
  });
  lastErrorReport = report;
  appendActivityLogEntry({
    level: 'error',
    message: `${step}失败`,
    details: [
      `模板名：${templateName || context.templateName || context.moduleName || 'N/A'}`,
      `错误摘要：${message}`,
      `错误代码：${errorCode}`,
      ...detailLines
    ]
  });

  return {
    status: 'error',
    message,
    errorReportReady: true,
    errorReportFileName: report.fileName
  };
}

function createWarningResult({
  step,
  message,
  detailReady = false,
  balanceReady = false,
  detailLines = [],
  context = {},
  errorCode = 'BUSINESS_WARNING',
  errorType = '业务校验错误',
  templateName = ''
}) {
  const report = createErrorReport({
    step,
    message,
    errorCode,
    errorType,
    detailLines,
    context,
    templateName
  });
  appendActivityLogEntry({
    level: 'warn',
    message: `${step}告警`,
    details: [
      `模板名：${templateName || context.templateName || context.moduleName || 'N/A'}`,
      `告警摘要：${message}`,
      ...detailLines
    ]
  });

  return {
    status: 'warning',
    message,
    detailReady,
    balanceReady,
    errorReportReady: true,
    errorReportFileName: report.fileName
  };
}

function getImportedEnumConfig() {
  const enumConfig = database.getEnumConfig();

  if (!enumConfig || !enumConfig.filePath || !fs.existsSync(enumConfig.filePath)) {
    return null;
  }

  return enumConfig;
}

function getBundledEnumPath() {
  const appRoot = app.getAppPath();
  const preferredPath = path.join(appRoot, BUNDLED_ENUM_FILE_NAME);
  const fallbackPath = path.join(appRoot, 'assets', BUNDLED_ENUM_FILE_NAME);

  if (fs.existsSync(preferredPath)) {
    return preferredPath;
  }

  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  return preferredPath;
}

function getEnumConfig() {
  const bundledEnumPath = getBundledEnumPath();

  if (fs.existsSync(bundledEnumPath)) {
    return {
      filePath: bundledEnumPath,
      sourceFileName: BUNDLED_ENUM_FILE_NAME,
      isBundled: true
    };
  }

  const importedEnumConfig = getImportedEnumConfig();

  return importedEnumConfig
    ? {
        ...importedEnumConfig,
        isBundled: false
      }
    : null;
}

function getCurrencyMappingTablePath() {
  const appRoot = app.getAppPath();
  return path.join(appRoot, 'assets', CURRENCY_MAPPING_FILE_NAME);
}

function getAvailableCurrencyCodes() {
  const currencyMappingTablePath = getCurrencyMappingTablePath();

  if (!fs.existsSync(currencyMappingTablePath)) {
    return [];
  }

  try {
    return Array.from(
      loadCurrencyMappings(currencyMappingTablePath)
        .reduce((accumulator, mapping) => {
          const code = normalizeCell(mapping.englishCode);

          if (!code || accumulator.has(code)) {
            return accumulator;
          }

          const name = normalizeCell(mapping.displayName || mapping.simpleChinese || mapping.traditionalChinese);
          accumulator.set(code, {
            code,
            name,
            label: name ? `${code} ${name}` : code
          });
          return accumulator;
        }, new Map())
        .values()
    );
  } catch (error) {
    console.error(error);
    return [];
  }
}

function getTemplatesStorageDir() {
  return path.join(ensureStorageRoot(), 'templates');
}

function getTemplateLibraryFilePath() {
  return path.join(getTemplatesStorageDir(), 'template-library.json');
}

function expandBigAccountConfigurations(bigAccounts = []) {
  const expandedRows = [];

  bigAccounts.forEach((item) => {
    const merchantId = normalizeCell(item.merchantId);
    const currencies = Array.from(
      new Set(
        (Array.isArray(item.currencies) ? item.currencies : [])
          .map((value) => normalizeCell(value))
          .filter((value) => value !== '')
      )
    );
    // v1.5.3 R2：透传 accountNature 到展平行（写入 template_big_accounts 时入库）
    const rawNature = typeof item.accountNature === 'string' ? item.accountNature.trim() : '';
    const accountNature = rawNature === 'own' ? 'own' : 'client';

    currencies.forEach((currency) => {
      expandedRows.push({
        merchantId,
        currency,
        accountNature
      });
    });
  });

  return expandedRows;
}

function buildTemplateLibraryPayload() {
  const templates = database.listTemplateBundleEntries().map((entry) => {
    const template = database.getTemplateByKey(entry.templateKey) || database.getTemplateByName(entry.name);
    if (template) {
      const orderConfig = readBigAccountOrder(ensureStorageRoot(), template.id);
      if (orderConfig && Array.isArray(orderConfig.files) && orderConfig.files.length > 0) {
        entry.bigAccountOrderConfig = orderConfig;
      }
      const mode = readBigAccountMode(ensureStorageRoot(), template.id);
      if (mode === 'fixed') {
        entry.bigAccountMode = mode;
      }
      // v1.5.1: 导出账户映射
      entry.accountMappings = database.listAccountMappings(template.id).map((m) => ({
        bankAccountId: m.bankAccountId,
        clearingAccountId: m.clearingAccountId,
        noCurrency: Boolean(m.noCurrency),
        currency: m.currency || ''
      }));
    }
    return entry;
  });

  return {
    bundleVersion: SUPPORTED_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    templates
  };
}

function writeTemplateBundleFile(filePath) {
  const payload = buildTemplateLibraryPayload();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function syncTemplateLibraryFile() {
  return writeTemplateBundleFile(getTemplateLibraryFilePath());
}

function readTemplateBundleFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new FileValidationError('FILE_READ', '模板文件不存在或不可读');
  }

  let parsed = null;

  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    throw new FileValidationError('FILE_READ', '模板文件格式错误，请重新确认');
  }

  const bundleVersion = Number(parsed?.bundleVersion || 1);

  if (bundleVersion > SUPPORTED_BUNDLE_VERSION) {
    throw new FileValidationError(
      'FILE_READ',
      `模板文件版本（${bundleVersion}）高于当前应用支持的版本（${SUPPORTED_BUNDLE_VERSION}），请升级应用后再导入`
    );
  }

  const templates = Array.isArray(parsed?.templates) ? parsed.templates : [];

  return templates.map((item) => ({
    templateKey: normalizeCell(item.templateKey),
    name: normalizeCell(item.name),
    sourceFileName: normalizeCell(item.sourceFileName) || `${normalizeCell(item.name) || 'template'}.xlsx`,
    headers: Array.isArray(item.headers) ? item.headers.map((value) => normalizeCell(value)).filter((value) => value !== '') : [],
    mappings: Array.isArray(item.mappings) ? item.mappings : [],
    bigAccounts: Array.isArray(item.bigAccounts) ? item.bigAccounts : [],
    fixedAssignments: Array.isArray(item.fixedAssignments) ? item.fixedAssignments : [],
    amountSplitRules: Array.isArray(item.amountSplitRules) ? item.amountSplitRules : [],
    billSplitMappings: Array.isArray(item.billSplitMappings) ? item.billSplitMappings : [],
    billSplitRows: Array.isArray(item.billSplitRows) ? item.billSplitRows : [],
    billSplitAmountRules: Array.isArray(item.billSplitAmountRules) ? item.billSplitAmountRules : [],
    billSplitMeta: item.billSplitMeta && typeof item.billSplitMeta === 'object'
      ? { signedAmountSourceField: normalizeCell(item.billSplitMeta.signedAmountSourceField) }
      : { signedAmountSourceField: '' },
    dateFormat: normalizeCell(item.dateFormat) || 'auto',
    // v1.5.1: 主/子模板 + 账户映射
    isParent: Boolean(item.isParent),
    parentTemplateKey: normalizeCell(item.parentTemplateKey) || null,
    accountMappings: Array.isArray(item.accountMappings) ? item.accountMappings : [],
    // v1.5.2 需求 3：文件名固定字段（老 bundle 无此字段时落为空串）
    filenameFixedField: normalizeCell(item.filenameFixedField) || ''
  }));
}

// v2.0.0-beta.2 D16 fix（Codex PR #26 Finding 1）：默认/重置背景按当前 ui_style 取
// Clear → #ffffff / General → #efe8da；避免新装用户 ui_style=Clear 但回退到旧版米色
function getStyleDefaultBackgroundColor() {
  try {
    const uiStyle = database?.getUiStyle?.() || 'Clear';
    return uiStyle === 'Clear' ? CLEAR_BACKGROUND_COLOR : DEFAULT_BACKGROUND_COLOR;
  } catch (_err) {
    return CLEAR_BACKGROUND_COLOR;
  }
}

function normalizeBackgroundColor(colorHex) {
  const normalized = String(colorHex || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : getStyleDefaultBackgroundColor();
}

// v2.0.0-beta.2 D16：风格-背景色联动（仅"魔法值"场景，不覆盖用户自定义颜色）
// Clear 风格 → #ffffff；General 风格 → #efe8da
// 仅当 colorHex 等于"另一风格的默认色"时才重置；用户已自定义的颜色不动
function ensureBackgroundColorMatchesStyle() {
  const uiStyle = database.getUiStyle() || 'Clear';
  const currentBgConfig = database.getBackgroundConfig();
  if (!currentBgConfig) return;

  const currentColor = String(currentBgConfig.colorHex || '').toLowerCase();
  const desiredColor = uiStyle === 'Clear' ? CLEAR_BACKGROUND_COLOR : DEFAULT_BACKGROUND_COLOR;
  const otherDefault = uiStyle === 'Clear' ? DEFAULT_BACKGROUND_COLOR : CLEAR_BACKGROUND_COLOR;

  if (currentColor === otherDefault && currentColor !== desiredColor) {
    database.setBackgroundConfig({ ...currentBgConfig, colorHex: desiredColor });
  }
}

function getStoredBackgroundConfig() {
  const backgroundConfig = database.getBackgroundConfig() || {};
  const filePath = typeof backgroundConfig.filePath === 'string' ? backgroundConfig.filePath : '';
  const fileExists = Boolean(filePath && fs.existsSync(filePath));

  return {
    colorHex: normalizeBackgroundColor(backgroundConfig.colorHex),
    filePath: fileExists ? filePath : '',
    sourceFileName: fileExists
      ? String(backgroundConfig.sourceFileName || path.basename(filePath))
      : ''
  };
}

function getMimeTypeByExtension(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function fileToDataUrl(filePath) {
  const mimeType = getMimeTypeByExtension(filePath);
  const buffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function buildBackgroundPayload(backgroundConfig) {
  const normalized = getStoredBackgroundConfig();
  const payload = backgroundConfig
    ? {
        colorHex: normalizeBackgroundColor(backgroundConfig.colorHex),
        filePath:
          backgroundConfig.filePath && fs.existsSync(backgroundConfig.filePath)
            ? backgroundConfig.filePath
            : '',
        sourceFileName: backgroundConfig.sourceFileName || ''
      }
    : normalized;

  return {
    colorHex: payload.colorHex,
    filePath: payload.filePath,
    sourceFileName: payload.sourceFileName,
    imageDataUrl: payload.filePath ? fileToDataUrl(payload.filePath) : ''
  };
}

function removeStoredBackgroundFiles() {
  const backgroundDir = getBackgroundAssetsDir();

  if (!fs.existsSync(backgroundDir)) {
    return;
  }

  for (const fileName of fs.readdirSync(backgroundDir)) {
    const filePath = path.join(backgroundDir, fileName);

    if (fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
    }
  }
}

function backgroundFileDialogFilters() {
  return [
    {
      name: '图片',
      extensions: ['png', 'jpg', 'jpeg', 'webp']
    }
  ];
}

function validateBackgroundImage(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (!SUPPORTED_BACKGROUND_IMAGE_EXTENSIONS.has(extension)) {
    throw new FileValidationError('FILE_TYPE', '背景图片仅支持 PNG、JPG、JPEG、WEBP 格式');
  }

  if (!fs.existsSync(filePath)) {
    throw new FileValidationError('FILE_READ', '背景图片不存在或不可读，请重新选择');
  }

  const stats = fs.statSync(filePath);

  if (!stats.isFile() || stats.size === 0) {
    throw new FileValidationError('FILE_READ', '背景图片为空或不可读，请重新选择');
  }

  if (stats.size > BACKGROUND_IMAGE_LIMITS.maxSizeBytes) {
    throw new FileValidationError('FILE_SIZE', '背景图片不能超过 5MB');
  }

  const image = nativeImage.createFromPath(filePath);

  if (image.isEmpty()) {
    throw new FileValidationError('FILE_READ', '背景图片为空或不可读，请重新选择');
  }

  const { width, height } = image.getSize();

  if (width < BACKGROUND_IMAGE_LIMITS.minWidth || height < BACKGROUND_IMAGE_LIMITS.minHeight) {
    throw new FileValidationError(
      'IMAGE_DIMENSION',
      `背景图片分辨率至少需要 ${BACKGROUND_IMAGE_LIMITS.minWidth}×${BACKGROUND_IMAGE_LIMITS.minHeight}`
    );
  }

  if (width > BACKGROUND_IMAGE_LIMITS.maxWidth || height > BACKGROUND_IMAGE_LIMITS.maxHeight) {
    throw new FileValidationError(
      'IMAGE_DIMENSION',
      `背景图片分辨率不能超过 ${BACKGROUND_IMAGE_LIMITS.maxWidth}×${BACKGROUND_IMAGE_LIMITS.maxHeight}`
    );
  }

  return {
    width,
    height,
    sizeBytes: stats.size
  };
}

function saveBackgroundConfig(payload = {}) {
  const currentBackgroundConfig = getStoredBackgroundConfig();
  const colorHex = normalizeBackgroundColor(payload.colorHex);
  const imageSourcePath = String(payload.imageSourcePath || '');
  const keepExistingImage = Boolean(payload.keepExistingImage);
  let nextFilePath = '';
  let nextSourceFileName = '';

  if (imageSourcePath) {
    validateBackgroundImage(imageSourcePath);
    const imageBuffer = fs.readFileSync(imageSourcePath);
    const extension = path.extname(imageSourcePath).toLowerCase();
    const backgroundDir = getBackgroundAssetsDir();
    const storedFilePath = path.join(backgroundDir, `app-background${extension}`);

    fs.mkdirSync(backgroundDir, { recursive: true });
    removeStoredBackgroundFiles();
    fs.writeFileSync(storedFilePath, imageBuffer);

    nextFilePath = storedFilePath;
    nextSourceFileName = path.basename(imageSourcePath);
  } else if (keepExistingImage && currentBackgroundConfig.filePath) {
    nextFilePath = currentBackgroundConfig.filePath;
    nextSourceFileName = currentBackgroundConfig.sourceFileName;
  } else {
    removeStoredBackgroundFiles();
  }

  const backgroundConfig = {
    colorHex,
    filePath: nextFilePath,
    sourceFileName: nextSourceFileName
  };

  database.setBackgroundConfig(backgroundConfig);
  return buildBackgroundPayload(backgroundConfig);
}

function getToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatDateLabel(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildExportTargetFields(enumValues) {
  return ['Balance'].concat(
    Array.from(
      new Set(
        enumValues
          .map((value) => normalizeCell(value))
          .filter((value) => value !== '' && value !== 'Balance')
      )
    )
  );
}

function buildMappingTargetFields(enumValues) {
  return buildExportTargetFields(enumValues).filter((value) => value !== 'Channel');
}

function buildManagedMappingFields(enumValues) {
  return buildMappingTargetFields(enumValues).concat(ADVANCED_MAPPING_FIELDS).concat(BILL_SPLIT_GROUP_FIELDS);
}

function getBalanceTemplatePath() {
  const appRoot = app.getAppPath();
  return path.join(appRoot, 'assets', '余额账单模版.xlsx');
}

function buildImportWarningDetailLines(warnings) {
  const detailLines = [];
  const currencyWarnings = warnings.filter((warning) => warning.type === 'currency-unmapped');
  const skippedDetailWarnings = warnings.filter((warning) => warning.type === 'detail-row-skipped');
  const balanceWarnings = warnings.filter((warning) => warning.type === 'balance-generate-failed');

  if (skippedDetailWarnings.length) {
    detailLines.push('以下明细记录因 Credit Amount 和 Debit Amount 同时为 0 或空值，未写入导出的明细账单：');
    skippedDetailWarnings.forEach((warning) => {
      detailLines.push(
        `第${warning.rowNumber}行，Credit Amount="${warning.creditAmount || '(空)'}"，Debit Amount="${warning.debitAmount || '(空)'}"`
      );
    });
  }

  if (currencyWarnings.length) {
    detailLines.push('以下 Currency 原值未匹配到内置币种映射表，导出文件已保留原值：');
    currencyWarnings.forEach((warning) => {
      const matchedCodes = Array.isArray(warning.matchedCodes) && warning.matchedCodes.length
        ? `；可能匹配的英文简称：${warning.matchedCodes.join('、')}`
        : '';
      detailLines.push(
        `第${warning.rowNumber}行，源字段“${warning.sourceField || 'Currency'}”，原值“${warning.rawValue}”${matchedCodes}`
      );
    });
  }

  if (balanceWarnings.length) {
    detailLines.push('余额账单未生成，原因如下：');
    balanceWarnings.forEach((warning) => {
      detailLines.push(warning.message);

      if (warning.logPath) {
        detailLines.push(`日志文件：${warning.logPath}`);
      }
    });
  }

  return detailLines;
}

function buildImportWarningMessage({ warnings, balanceReady, balanceRequested }) {
  const warningParts = [];
  const skippedDetailCount = warnings.filter((warning) => warning.type === 'detail-row-skipped').length;
  const hasCurrencyWarning = warnings.some((warning) => warning.type === 'currency-unmapped');
  const hasBalanceWarning = warnings.some((warning) => warning.type === 'balance-generate-failed');
  const exportParts = ['明细账单可导出'];

  if (balanceReady) {
    exportParts.push('余额账单可导出');
  } else if (balanceRequested) {
    exportParts.push('余额账单未生成');
  }

  if (skippedDetailCount > 0) {
    warningParts.push(`已过滤${skippedDetailCount}条收支均为0或空值的明细`);
  }

  if (hasCurrencyWarning) {
    warningParts.push('存在币种未匹配记录');
  }

  if (hasBalanceWarning) {
    warningParts.push('存在余额账单异常');
  }

  return warningParts.length
    ? `${exportParts.join('，')}，${warningParts.join('，')}，请点击状态框导出报错文件`
    : exportParts.join('，');
}

function normalizeMappedFields(rawFields = [], fallbackValue = '') {
  const normalizedFields = Array.from(
    new Set(
      (Array.isArray(rawFields) ? rawFields : [])
        .map((value) => normalizeCell(value))
        .filter((value) => value !== '')
    )
  );

  if (normalizedFields.length) {
    return normalizedFields;
  }

  const fallback = normalizeCell(fallbackValue);
  return fallback ? [fallback] : [];
}

function getPrimaryMappedField(mapping) {
  const mappedFields = normalizeMappedFields(mapping?.mappedFields, mapping?.mappedField);
  return mappedFields[0] || '';
}

function getMappingFieldValues(mapping) {
  return normalizeMappedFields(mapping?.mappedFields, mapping?.mappedField);
}

function decodeCustomInputMappingValue(rawValue) {
  const normalizedValue = normalizeCell(rawValue);

  if (!normalizedValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
    return {
      isCustomInput: false,
      mappedField: normalizedValue,
      customValue: '',
      isMultiBigAccount: false
    };
  }

  const customValue = normalizedValue.slice(FIXED_FIELD_VALUE_PREFIX.length);

  return {
    isCustomInput: true,
    mappedField: MERCHANT_ID_SELF_INPUT_OPTION,
    customValue: customValue === MERCHANT_ID_MULTI_ACCOUNT_MARKER ? '' : customValue,
    isMultiBigAccount: customValue === MERCHANT_ID_MULTI_ACCOUNT_MARKER
  };
}

function extractFixedMappingValue(rawValue) {
  const normalizedValue = normalizeCell(rawValue);

  if (!normalizedValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
    return '';
  }

  return normalizedValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
}

function buildCompatibleBigAccounts({ mappings, bigAccounts = [] }) {
  if (Array.isArray(bigAccounts) && bigAccounts.length) {
    return bigAccounts.map((item) => ({
      merchantId: normalizeCell(item.merchantId),
      currencies: Array.from(
        new Set(
          (Array.isArray(item.currencies) ? item.currencies : [])
            .map((value) => normalizeCell(value))
            .filter((value) => value !== '')
        )
      ),
      isMultiCurrency: Boolean(item.isMultiCurrency)
    }));
  }

  const mappingMap = new Map(
    (Array.isArray(mappings) ? mappings : []).map((mapping) => [
      normalizeCell(mapping.templateField),
      normalizeCell(mapping.mappedField)
    ])
  );
  const merchantIdCustomInput = decodeCustomInputMappingValue(mappingMap.get('MerchantId') || '');

  if (
    !merchantIdCustomInput.isCustomInput ||
    merchantIdCustomInput.isMultiBigAccount ||
    !merchantIdCustomInput.customValue
  ) {
    return [];
  }

  const fixedCurrencyValue = extractFixedMappingValue(mappingMap.get('Currency') || '');

  return [{
    merchantId: merchantIdCustomInput.customValue,
    currencies: fixedCurrencyValue ? [fixedCurrencyValue] : [],
    isMultiCurrency: false
  }];
}

function resolveCurrentMappings({ template, mappings, enumValues }) {
  const targetFields = buildManagedMappingFields(enumValues);
  const targetFieldSet = new Set(targetFields);
  const sourceFieldSet = new Set(template.headers.map((header) => normalizeCell(header)));
  const currentOrientationScore = mappings.filter((mapping) => targetFieldSet.has(mapping.templateField)).length;
  const legacyOrientationScore = mappings.filter((mapping) => {
    return sourceFieldSet.has(normalizeCell(mapping.templateField)) && targetFieldSet.has(mapping.mappedField);
  }).length;
  const currentMappings = legacyOrientationScore > currentOrientationScore
    ? mappings
        .map((mapping) => ({
          templateField: mapping.mappedField,
          mappedField: mapping.templateField,
          mappedFields: normalizeMappedFields([], mapping.templateField)
        }))
        .filter((mapping) => targetFieldSet.has(mapping.templateField))
    : mappings
        .filter((mapping) => targetFieldSet.has(mapping.templateField))
        .map((mapping) => ({
          ...mapping,
          mappedField: normalizeCell(mapping.mappedField),
          mappedFields: getMappingFieldValues(mapping)
        }));

  return currentMappings;
}

function normalizeMappingRows({ template, mappings, enumValues, bigAccounts = [] }) {
  const targetFields = buildManagedMappingFields(enumValues);
  const currentMappings = resolveCurrentMappings({
    template,
    mappings,
    enumValues
  });
  const savedMap = new Map(currentMappings.map((mapping) => [mapping.templateField, mapping]));
  const merchantIdSavedValue = getPrimaryMappedField(savedMap.get('MerchantId')) || '';
  const merchantIdCustomInput = decodeCustomInputMappingValue(merchantIdSavedValue);
  const merchantIdManagedByBigAccounts = merchantIdCustomInput.isCustomInput;

  return targetFields.map((fieldName) => {
    const savedMapping = savedMap.get(fieldName) || null;
    const savedValue = getPrimaryMappedField(savedMapping);
    const savedFields = getMappingFieldValues(savedMapping);
    const rawMappedField = normalizeCell(savedMapping?.mappedField);
    const isConcatMode = rawMappedField === CONCAT_FIELDS_MAPPING_FIELD || savedFields.length > 1;
    const customInputMapping = CUSTOM_INPUT_TARGET_FIELDS.has(fieldName)
      ? decodeCustomInputMappingValue(savedValue)
      : null;
    const hasSavedBigAccounts = Array.isArray(bigAccounts) && bigAccounts.length > 0;

    return {
      templateField: fieldName,
      mappedField: isConcatMode
        ? CONCAT_FIELDS_MAPPING_FIELD
        : fieldName === 'Balance'
          ? savedValue || BALANCE_DISABLED_OPTION
          : fieldName === 'MerchantId' && merchantIdManagedByBigAccounts
            ? MERCHANT_ID_SELF_INPUT_OPTION
            : fieldName === 'Currency' && merchantIdManagedByBigAccounts
              ? ''
              : fieldName === 'Currency' && savedValue.startsWith(FIXED_FIELD_VALUE_PREFIX)
                ? ''
                : customInputMapping
                  ? customInputMapping.mappedField
                  : savedValue === BALANCE_DISABLED_OPTION
                    ? ''
                    : savedValue || '',
      mappedFields:
        fieldName === 'Balance' ||
        fieldName === 'MerchantId' ||
        fieldName === 'Currency' && merchantIdManagedByBigAccounts ||
        (customInputMapping && customInputMapping.isCustomInput)
          ? []
          : isConcatMode
            ? savedFields
            : savedFields.length > 1
              ? savedFields
              : [],
      customValue: fieldName === 'MerchantId'
        ? ''
        : customInputMapping
          ? customInputMapping.customValue
          : '',
      isMultiBigAccount: fieldName === 'MerchantId'
        ? hasSavedBigAccounts
        : customInputMapping
          ? customInputMapping.isMultiBigAccount
          : false
    };
  });
}

function normalizeExportMappingRows({ template, mappings, enumValues }) {
  const targetFields = buildManagedMappingFields(enumValues);
  const currentMappings = resolveCurrentMappings({
    template,
    mappings,
    enumValues
  });
  const savedMap = new Map(currentMappings.map((mapping) => [mapping.templateField, mapping]));

  return targetFields.map((fieldName) => {
    const savedMapping = savedMap.get(fieldName) || null;
    const savedValue = getPrimaryMappedField(savedMapping);
    const savedFields = getMappingFieldValues(savedMapping);
    const rawMappedField = normalizeCell(savedMapping?.mappedField);
    const isConcatMode = rawMappedField === CONCAT_FIELDS_MAPPING_FIELD || savedFields.length > 1;

    return {
      templateField: fieldName,
      mappedField: isConcatMode
        ? CONCAT_FIELDS_MAPPING_FIELD
        : fieldName === 'Balance'
          ? savedValue || BALANCE_DISABLED_OPTION
          : savedValue === BALANCE_DISABLED_OPTION
            ? ''
            : savedValue || '',
      mappedFields:
        isConcatMode
          ? savedFields
          : fieldName === 'Balance' || savedFields.length <= 1
            ? []
            : savedFields
    };
  });
}

function getTemplateMappingConfig(templateId) {
  // v1.5.2 需求 3：虚拟 ID 不对应任何真实模板记录，直接短路返 null
  if (isFilenameMappingMode(templateId)) {
    return null;
  }
  const templatePayload = database.getTemplateMappings(templateId);

  if (!templatePayload) {
    return null;
  }

  const enumConfig = getEnumConfig();

  if (!enumConfig) {
    throw new FileValidationError('FILE_READ', MISSING_ENUM_MESSAGE);
  }

  const enumValues = loadEnumValues(enumConfig.filePath);
  const compatibleBigAccounts = buildCompatibleBigAccounts({
    mappings: templatePayload.mappings,
    bigAccounts: templatePayload.bigAccounts
  });
  const mappings = normalizeMappingRows({
    template: templatePayload.template,
    mappings: templatePayload.mappings,
    enumValues,
    bigAccounts: compatibleBigAccounts
  });
  const exportMappings = normalizeExportMappingRows({
    template: templatePayload.template,
    mappings: templatePayload.mappings,
    enumValues
  });

  return {
    template: templatePayload.template,
    enumValues,
    targetFields: buildManagedMappingFields(enumValues),
    advancedMappingFields: ADVANCED_MAPPING_FIELDS.slice(),
    billSplitGroupFields: BILL_SPLIT_GROUP_FIELDS.slice(),
    exportTargetFields: buildExportTargetFields(enumValues),
    mappings,
    exportMappings,
    bigAccounts: compatibleBigAccounts,
    fixedAssignments: Array.isArray(templatePayload.fixedAssignments)
      ? templatePayload.fixedAssignments.map((item) => ({
          merchantId: normalizeCell(item.merchantId),
          currency: normalizeCell(item.currency),
          rowIndex: Number(item.rowIndex || 0)
        }))
      : [],
    amountSplitRules: Array.isArray(templatePayload.amountSplitRules)
      ? templatePayload.amountSplitRules.map((rule) => ({
          targetField: normalizeCell(rule.targetField),
          conditionField: normalizeCell(rule.conditionField),
          conditionValue: normalizeCell(rule.conditionValue),
          mappedField: normalizeCell(rule.mappedField),
          rowIndex: Number(rule.rowIndex || 0)
        }))
      : [],
    billSplitMappings: Array.isArray(templatePayload.billSplitMappings)
      ? templatePayload.billSplitMappings.map((m) => ({
          templateField: normalizeCell(m.templateField),
          mappedField: normalizeCell(m.mappedField),
          mappedFields: Array.isArray(m.mappedFields) ? m.mappedFields.slice() : [],
          rowIndex: Number(m.rowIndex || 0)
        }))
      : [],
    billSplitRows: Array.isArray(templatePayload.billSplitRows)
      ? templatePayload.billSplitRows.map((r) => ({
          seqNo: Number(r.seqNo),
          currencySourceField: normalizeCell(r.currencySourceField),
          creditSourceField: normalizeCell(r.creditSourceField),
          debitSourceField: normalizeCell(r.debitSourceField),
          amountSourceField: normalizeCell(r.amountSourceField),
          rowStatus: r.rowStatus === 'completed' ? 'completed' : 'draft',
          mergedGroupSeq: r.mergedGroupSeq === null || r.mergedGroupSeq === undefined ? null : Number(r.mergedGroupSeq)
        }))
      : [],
    billSplitAmountRules: Array.isArray(templatePayload.billSplitAmountRules)
      ? templatePayload.billSplitAmountRules.map((rule) => ({
          targetField: normalizeCell(rule.targetField),
          conditionField: normalizeCell(rule.conditionField),
          conditionValue: normalizeCell(rule.conditionValue),
          mappedField: normalizeCell(rule.mappedField),
          rowIndex: Number(rule.rowIndex || 0)
        }))
      : [],
    billSplitMeta: templatePayload.billSplitMeta && typeof templatePayload.billSplitMeta === 'object'
      ? { signedAmountSourceField: normalizeCell(templatePayload.billSplitMeta.signedAmountSourceField) }
      : { signedAmountSourceField: '' }
  };
}

function buildDateRangeLabel(billDates) {
  const sortedDates = Array.from(new Set(billDates)).sort();

  if (sortedDates.length === 0) {
    return '';
  }

  if (sortedDates.length === 1) {
    return sortedDates[0];
  }

  return `${sortedDates[0]}~${sortedDates[sortedDates.length - 1]}`;
}

function buildOutputFilePath({ kind, outputFileName }) {
  const date = getToday();
  const outputFolder = path.join(ensureStorageRoot(), 'exports', date, kind);
  const safeFileName = sanitizeFileName(outputFileName) || '导出文件.xlsx';
  return {
    date,
    outputFolder,
    outputFileName: safeFileName,
    outputFilePath: path.join(outputFolder, safeFileName)
  };
}

function buildStatementOutputFilePath({
  kind,
  templateName,
  merchantId = '',
  outputTag,
  dateRangeLabel,
  internalSuffix = ''
}) {
  const safeDateLabel = dateRangeLabel || getToday();
  const displayMerchantId = merchantId && merchantId.length > 4 ? merchantId.slice(-4) : merchantId;
  const publicFileName = displayMerchantId
    ? `${templateName}-${displayMerchantId}-${outputTag}-${safeDateLabel}.xlsx`
    : `${templateName}-${outputTag}-${safeDateLabel}.xlsx`;
  const internalBase = merchantId
    ? `${templateName}-${merchantId}-${outputTag}-${safeDateLabel}.xlsx`
    : publicFileName;
  const internalFileName = internalSuffix
    ? internalBase.replace(/\.xlsx$/i, `__${internalSuffix}.xlsx`)
    : internalBase;
  const outputMeta = buildOutputFilePath({
    kind,
    outputFileName: internalFileName
  });

  return {
    ...outputMeta,
    outputFileName: publicFileName
  };
}

function clearGeneratedExports() {
  lastGeneratedExports = {
    detail: null,
    balance: null,
    allDetail: null,
    allBalance: null,
    statementSessionKey: '',
    currentBatchId: '',
    newAccount: lastGeneratedExports.newAccount,
    // v1.5.3 R1：clearGeneratedExports 由"制作网银账单"流程的导入/批次切换触发；
    // monthlyBalance session 与 statement session 独立，不在这里清
    monthlyBalance: lastGeneratedExports.monthlyBalance
  };
}

function buildFieldIndexMap(headerRow) {
  const fieldIndexMap = new Map();

  headerRow.forEach((fieldName, index) => {
    const normalizedField = normalizeCell(fieldName);

    if (normalizedField && !fieldIndexMap.has(normalizedField)) {
      fieldIndexMap.set(normalizedField, index);
    }
  });

  return fieldIndexMap;
}

function getMappedFieldValue(row, fieldIndexMap, fieldName) {
  const fieldIndex = fieldIndexMap.get(fieldName);
  return fieldIndex === undefined ? '' : row[fieldIndex];
}

function parseRequiredBillDates(detailRows) {
  const fieldIndexMap = buildFieldIndexMap(detailRows[0] || []);
  const billDateIndex = fieldIndexMap.get('BillDate');

  if (billDateIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
  }

  const billDates = [];

  detailRows.slice(1).forEach((row) => {
    const rawValue = row[billDateIndex];
    const normalizedValue = normalizeCell(rawValue);

    if (!normalizedValue) {
      return;
    }

    const parsedDate = parseDateValue(rawValue);

    if (!parsedDate) {
      throw new FileValidationError('FILE_READ', `账单日期存在无效值：${normalizedValue}`);
    }

    billDates.push(formatDateLabel(parsedDate));
  });

  if (!billDates.length) {
    throw new FileValidationError('FILE_READ', '导入文件中未找到有效的 BillDate');
  }

  return billDates;
}

function ensureNumericValue(rawValue, { fieldName, dateLabel, allowBlank = false }) {
  const normalizedValue = normalizeCell(rawValue);

  if (!normalizedValue) {
    return allowBlank ? null : 0;
  }

  const parsedValue = parseNumericValue(rawValue);

  if (parsedValue === null) {
    throw new FileValidationError('FILE_READ', `${dateLabel} 的 ${fieldName} 不是有效数字`);
  }

  return parsedValue;
}

function buildBalanceTemplateRow(balanceTemplateFields, valuesByField) {
  const normalizedValues = new Map(
    Object.entries(valuesByField).map(([fieldName, value]) => [normalizeCell(fieldName), value])
  );

  return balanceTemplateFields.map((fieldName) => {
    const normalizedField = normalizeCell(fieldName);
    return normalizedValues.has(normalizedField) ? normalizedValues.get(normalizedField) : '';
  });
}

function hasMultipleEndingBalances(entries) {
  const uniqueBalances = Array.from(
    new Set(
      entries
        .filter((entry) => entry.balanceValue !== null)
        .map((entry) => Number(Number(entry.balanceValue).toFixed(2)))
    )
  );

  return uniqueBalances.length > 1;
}

function storeGeneratedBalanceSeeds({ templateName, seedRecords = [] }) {
  if (!Array.isArray(seedRecords) || !seedRecords.length) {
    return;
  }

  const storageRoot = ensureStorageRoot();

  seedRecords.forEach((record) => {
    upsertBalanceSeedRecord(storageRoot, {
      templateName,
      merchantId: record.merchantId,
      currency: record.currency,
      billDate: record.billDate,
      endBalance: record.endBalance,
      generationMethod: record.generationMethod,
      overwrite: true
    });
  });
}

function scanBalanceSeedStatus({ detailRows, templateName }) {
  const fieldIndexMap = buildFieldIndexMap(detailRows[0] || []);
  const merchantIdIndex = fieldIndexMap.get('MerchantId');
  const currencyIndex = fieldIndexMap.get('Currency');
  const billDateIndex = fieldIndexMap.get('BillDate');

  if (merchantIdIndex === undefined || billDateIndex === undefined) {
    return { total: 0, missing: 0 };
  }

  const bankNameParts = splitTemplateName(templateName);
  const accountEarliestDates = new Map();

  detailRows.slice(1).forEach((row) => {
    const merchantId = normalizeCell(row[merchantIdIndex]);
    const currency = currencyIndex !== undefined ? normalizeCell(row[currencyIndex]) : '';
    const billDate = normalizeCell(row[billDateIndex]);
    if (!merchantId || !billDate) return;

    const parsedDate = parseDateValue(billDate);
    if (!parsedDate) return;

    const dateLabel = formatDateLabel(parsedDate);
    const key = `${merchantId}@@${currency}`;
    const existing = accountEarliestDates.get(key);

    if (!existing || dateLabel < existing.dateLabel) {
      accountEarliestDates.set(key, { merchantId, currency, dateLabel });
    }
  });

  const accountKeys = new Map();
  accountEarliestDates.forEach((account, key) => {
    const seedRecord = findPreviousBalanceSeed(ensureStorageRoot(), {
      bankName: bankNameParts.bankName,
      merchantId: account.merchantId,
      currency: account.currency,
      beforeBillDate: account.dateLabel
    });

    accountKeys.set(key, { merchantId: account.merchantId, currency: account.currency, hasSeed: seedRecord !== null });
  });

  const total = accountKeys.size;
  const missing = Array.from(accountKeys.values()).filter((a) => !a.hasSeed).length;
  let missingIndex = 0;
  const missingIndexByKey = new Map();
  accountKeys.forEach((account, key) => {
    if (!account.hasSeed) {
      missingIndex++;
      missingIndexByKey.set(key, missingIndex);
    }
  });

  return { total, missing, missingIndexByKey };
}

function buildBalanceSeedPrompt({ templateName, bankName, merchantId, currency, targetBillDate }) {
  return {
    templateName,
    bankName,
    merchantId: normalizeCell(merchantId),
    currency: normalizeCell(currency),
    targetBillDate: normalizeCell(targetBillDate)
  };
}

function resolveSeededPreviousEndBalance({
  previousEndBalance,
  resolvePreviousEndBalance,
  promptContext,
  shouldPrompt
}) {
  if (previousEndBalance !== null) {
    return previousEndBalance;
  }

  const seededBalance = typeof resolvePreviousEndBalance === 'function'
    ? resolvePreviousEndBalance(promptContext)
    : null;

  if (seededBalance !== null && seededBalance !== undefined) {
    return seededBalance;
  }

  if (shouldPrompt) {
    throw new FileValidationError(
      'BALANCE_SEED_REQUIRED',
      '因首次导入余额，请导入上一个账单日余额用于余额校验',
      {
        context: promptContext
      }
    );
  }

  return null;
}

function deriveBalanceRecords({
  detailRows,
  templateName,
  balanceTemplateFields,
  mode = 'statement',
  resolvePreviousEndBalance = null,
  balanceAdjustments = []
}) {
  const fieldIndexMap = buildFieldIndexMap(detailRows[0] || []);
  const balanceIndex = fieldIndexMap.get('Balance');
  const billDateIndex = fieldIndexMap.get('BillDate');
  const merchantIdIndex = fieldIndexMap.get('MerchantId');
  const rowMetas = Array.isArray(detailRows.rowMetas) ? detailRows.rowMetas : [];

  if (mode === 'statement' && balanceIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模板未配置 Balance 字段，无法生成余额账单');
  }

  if (billDateIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
  }

  if (merchantIdIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模板启用 Balance 时必须映射 MerchantId 字段');
  }

  const groupedRows = new Map();
  const bankNameParts = splitTemplateName(templateName);
  const missingMerchantIdRows = [];

  detailRows.slice(1).forEach((row, rowIndex) => {
    const billDateRaw = row[billDateIndex];
    const normalizedBillDate = normalizeCell(billDateRaw);

    if (!normalizedBillDate) {
      return;
    }

    const parsedDate = parseDateValue(billDateRaw);

    if (!parsedDate) {
      throw new FileValidationError('FILE_READ', `账单日期存在无效值：${normalizedBillDate}`);
    }

    const dateLabel = formatDateLabel(parsedDate);
    const balanceValue = mode === 'statement'
      ? ensureNumericValue(row[balanceIndex], {
          fieldName: 'Balance',
          dateLabel,
          allowBlank: true
        })
      : null;
    const creditAmount = ensureNumericValue(getMappedFieldValue(row, fieldIndexMap, 'Credit Amount'), {
      fieldName: 'Credit Amount',
      dateLabel,
      allowBlank: false
    });
    const debitAmount = ensureNumericValue(getMappedFieldValue(row, fieldIndexMap, 'Debit Amount'), {
      fieldName: 'Debit Amount',
      dateLabel,
      allowBlank: false
    });
    const currency = normalizeCell(getMappedFieldValue(row, fieldIndexMap, 'Currency'));
    const bankAccount = normalizeCell(getMappedFieldValue(row, fieldIndexMap, 'MerchantId'));

    if (!bankAccount) {
      missingMerchantIdRows.push({
        sourceRowNumber: rowMetas[rowIndex]?.sourceRowNumber || rowIndex + 2,
        dateLabel
      });
      return;
    }

    const groupKey = `${bankAccount}@@${currency}`;

    if (!groupedRows.has(groupKey)) {
      groupedRows.set(groupKey, {
        merchantId: bankAccount,
        currency,
        dateMap: new Map()
      });
    }

    const targetGroup = groupedRows.get(groupKey);

    if (!targetGroup.dateMap.has(dateLabel)) {
      targetGroup.dateMap.set(dateLabel, []);
    }

    targetGroup.dateMap.get(dateLabel).push({
      balanceValue,
      creditAmount,
      debitAmount
    });
  });

  if (missingMerchantIdRows.length) {
    throw new FileValidationError(
      'FILE_READ',
      '当前模板启用 Balance 时，导入文件中的 MerchantId 不能为空',
      {
        detailLines: missingMerchantIdRows.map((row) => `第${row.sourceRowNumber}行，账单日期：${row.dateLabel}`),
        context: {
          templateName
        }
      }
    );
  }

  const groupedEntries = Array.from(groupedRows.values()).sort((left, right) => {
    const merchantCompare = left.merchantId.localeCompare(right.merchantId, 'zh-Hans-CN');

    if (merchantCompare !== 0) {
      return merchantCompare;
    }

    return left.currency.localeCompare(right.currency, 'zh-Hans-CN');
  });

  if (!groupedEntries.length) {
    throw new FileValidationError('FILE_READ', '导入文件中未找到可用于余额账单的账单日期');
  }

  const records = [];
  const seedRecords = [];
  const allBillDates = new Set();

  groupedEntries.forEach((group) => {
    const dateKeys = Array.from(group.dateMap.keys()).sort();
    let previousEndBalance = null;
    let lastCumulativeAdjustment = 0;

    dateKeys.forEach((dateLabel) => {
      const entries = group.dateMap.get(dateLabel);
      const promptContext = buildBalanceSeedPrompt({
        templateName,
        bankName: bankNameParts.bankName,
        merchantId: group.merchantId,
        currency: group.currency,
        targetBillDate: dateLabel
      });
      let endBalance = null;

      if (mode === 'calculated') {
        const effectivePreviousEndBalance = resolveSeededPreviousEndBalance({
          previousEndBalance,
          resolvePreviousEndBalance,
          promptContext,
          shouldPrompt: true
        });
        endBalance = calculateEndingBalanceFromAmounts({
          previousEndBalance: effectivePreviousEndBalance,
          entries
        });
      } else {
        const isFirstImportedDate = previousEndBalance === null;
        const needsSeedDisambiguation = hasMultipleEndingBalances(entries);
        let effectivePreviousEndBalance = previousEndBalance;

        if (isFirstImportedDate && needsSeedDisambiguation) {
          effectivePreviousEndBalance = resolveSeededPreviousEndBalance({
            previousEndBalance,
            resolvePreviousEndBalance,
            promptContext,
            shouldPrompt: true
          });
        }

        try {
          endBalance = inferEndingBalance({
            previousEndBalance: effectivePreviousEndBalance,
            entries,
            dateLabel
          });
        } catch (error) {
          const needsRefreshedSeed = error instanceof FileValidationError
            && error.code === 'FILE_READ'
            && isFirstImportedDate
            && needsSeedDisambiguation
            && effectivePreviousEndBalance !== null;

          if (needsRefreshedSeed) {
            throw new FileValidationError(
              'BALANCE_SEED_REQUIRED',
              '因首次导入余额，请导入上一个账单日余额用于余额校验',
              {
                context: promptContext
              }
            );
          }

          throw error;
        }
      }

      const cumulativeAdjustment = resolveBalanceAdjustment(balanceAdjustments, {
        merchantId: group.merchantId,
        currency: group.currency,
        dateLabel
      });
      const incrementalAdjustment = Math.round((cumulativeAdjustment - lastCumulativeAdjustment) * 100) / 100;
      if (incrementalAdjustment && endBalance !== null) {
        endBalance = Math.round((endBalance + incrementalAdjustment) * 100) / 100;
      }
      lastCumulativeAdjustment = cumulativeAdjustment;

      previousEndBalance = endBalance;
      allBillDates.add(dateLabel);
      records.push(buildBalanceTemplateRow(balanceTemplateFields, {
        银行名称: bankNameParts.bankName,
        所在地: bankNameParts.location,
        币种: group.currency,
        银行账号: group.merchantId,
        账单日期: dateLabel,
        期初余额: '',
        期初可用余额: '',
        期末余额: endBalance,
        期末可用余额: ''
      }));
      seedRecords.push({
        merchantId: group.merchantId,
        currency: group.currency,
        billDate: dateLabel,
        endBalance,
        generationMethod: mode === 'calculated'
          ? BALANCE_SEED_GENERATION_METHODS.calculated
          : BALANCE_SEED_GENERATION_METHODS.statement
      });
    });
  });

  return {
    records,
    billDates: Array.from(allBillDates).sort(),
    seedRecords
  };
}

function normalizeDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function buildNewAccountBillDates(openDate, today = new Date()) {
  const normalizedOpenDate = normalizeDateOnly(openDate);
  const normalizedToday = normalizeDateOnly(today);
  const yesterday = new Date(normalizedToday.getTime());
  yesterday.setDate(yesterday.getDate() - 1);

  if (normalizedOpenDate.getTime() > yesterday.getTime()) {
    throw new FileValidationError('FILE_READ', '开户日期不能晚于昨日');
  }

  const totalDays = Math.round(
    (yesterday.getTime() - normalizedOpenDate.getTime()) / (24 * 60 * 60 * 1000)
  ) + 1;

  if (totalDays > 3650) {
    throw new FileValidationError('FILE_READ', '开户日期距今超过 10 年，不支持生成');
  }

  const dates = [];
  let cursor = new Date(normalizedOpenDate.getTime());

  while (cursor.getTime() <= yesterday.getTime()) {
    dates.push(normalizeDateOnly(new Date(cursor.getTime())));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function normalizeNewAccountCurrencyValues({ currency, currencies = [], isMultiCurrency = false }) {
  return Array.from(
    new Set(
      ((isMultiCurrency && Array.isArray(currencies) && currencies.length) ? currencies : [currency])
        .map((value) => normalizeCell(value))
        .filter((value) => value !== '')
    )
  );
}

function normalizeNewAccountAccounts(payload = {}) {
  const rawAccounts = Array.isArray(payload.accounts) && payload.accounts.length
    ? payload.accounts
    : [{
        bankName: payload.bankName,
        location: payload.location,
        currency: payload.currency,
        currencies: payload.currencies,
        bankAccount: payload.bankAccount,
        openingDate: payload.openingDate,
        isMultiCurrency: payload.isMultiCurrency
      }];

  return rawAccounts.map((item) => ({
    bankName: normalizeCell(item.bankName),
    location: normalizeCell(item.location),
    currency: normalizeCell(item.currency),
    currencies: Array.isArray(item.currencies) ? item.currencies.map((value) => normalizeCell(value)) : [],
    bankAccount: normalizeCell(item.bankAccount),
    openingDateRaw: normalizeCell(item.openingDate),
    openingDate: parseDateValue(item.openingDate),
    isMultiCurrency: Boolean(item.isMultiCurrency)
  }));
}

function buildNewAccountBalanceRecords({
  accounts = [],
  balanceTemplateFields
}) {
  const records = [];
  const allBillDates = new Set();
  const allCurrencies = new Set();

  accounts.forEach((account) => {
    const billDates = buildNewAccountBillDates(account.openingDate);
    const currencyValues = normalizeNewAccountCurrencyValues(account);

    if (!currencyValues.length) {
      throw new FileValidationError('FILE_READ', '至少需要提供一个币种');
    }

    billDates.forEach((billDate) => {
      const billDateLabel = formatDateLabel(billDate);
      allBillDates.add(billDateLabel);

      currencyValues.forEach((currencyValue) => {
        allCurrencies.add(currencyValue);
        records.push(buildBalanceTemplateRow(balanceTemplateFields, {
          银行名称: account.bankName,
          所在地: account.location,
          币种: currencyValue,
          银行账号: account.bankAccount,
          账单日期: billDateLabel,
          期初余额: '',
          期初可用余额: '',
          期末余额: 0,
          期末可用余额: ''
        }));
      });
    });
  });

  return {
    records,
    billDates: Array.from(allBillDates).sort(),
    currencies: Array.from(allCurrencies)
  };
}

function templateFileDialogFilters() {
  return [
    {
      name: 'Excel / CSV',
      extensions: ['xlsx', 'xls', 'csv']
    }
  ];
}

function statementFileDialogFilters() {
  return [
    {
      name: 'Excel / CSV / PDF',
      extensions: ['xlsx', 'xls', 'csv', 'pdf']
    }
  ];
}

function sendWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:maximized-state', mainWindow.isMaximized());
  }
}

function createWindow() {
  const windowIcon = loadBundledIcon();
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 1080,
    minHeight: 760,
    frame: false,
    backgroundColor: '#f3efe6',
    show: false,
    icon: windowIcon,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  markStartupMetric(STARTUP_METRIC_MARKS.windowCreated);

  if (windowIcon && process.platform !== 'darwin') {
    mainWindow.setIcon(windowIcon);
  }

  mainWindow.webContents.once('did-finish-load', () => {
    markStartupMetric(STARTUP_METRIC_MARKS.didFinishLoad);
  });
  markStartupMetric(STARTUP_METRIC_MARKS.loadStarted);
  mainWindow.loadFile(path.join(app.getAppPath(), 'index.html'));
  mainWindow.once('ready-to-show', () => {
    markStartupMetric(STARTUP_METRIC_MARKS.readyToShow);
    reportStartupMetrics();
    mainWindow.show();
    sendWindowState();

    if (process.env.APP_CAPTURE_PATH) {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.mkdirSync(path.dirname(process.env.APP_CAPTURE_PATH), { recursive: true });
          fs.writeFileSync(process.env.APP_CAPTURE_PATH, image.toPNG());
        } catch (error) {
          console.error(error);
        } finally {
          app.quit();
        }
      }, Number(process.env.APP_CAPTURE_DELAY_MS || 1800));
    }
  });
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
}

function buildTemplateSummary(template) {
  return {
    id: template.id,
    templateKey: template.templateKey,
    name: template.name,
    sourceFileName: template.sourceFileName,
    headers: template.headers,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    bigAccountCount: template.bigAccountCount || 0,
    bigAccountMode: template.bigAccountMode || 'unset',
    bigAccountSummary: template.bigAccountSummary || '未设置',
    isParent: Boolean(template.isParent),
    parentTemplateId: template.parentTemplateId || null,
    // v1.5.2 需求 3（G3-4）：透传「文件名里的固定字段」给映射关系对话框回显
    filenameFixedField: String(template.filenameFixedField || '')
  };
}

function registerWindowHandlers() {
  ipcMain.handle('window:minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.handle('window:toggle-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }

    return { isMaximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('window:close', () => {
    mainWindow.close();
  });
}

function registerAppHandlers() {
  ipcMain.handle('app:get-info', () => {
    const enumConfig = getEnumConfig();
    return {
      version: app.getVersion(),
      storageRoot: ensureStorageRoot(),
      hasEnum: Boolean(enumConfig),
      enumFileName: enumConfig ? enumConfig.sourceFileName : '',
      hasErrorReport: Boolean(lastErrorReport && fs.existsSync(lastErrorReport.filePath)),
      accountMappingCount: database.countAllAccountMappings(),
      currencyOptions: getAvailableCurrencyCodes(),
      backgroundConfig: buildBackgroundPayload(),
      previewModal: process.env.APP_PREVIEW_MODAL || '',
      // v2.0.0-beta.2 F1：UI 风格（'Clear' | 'General'）；renderer 启动时立即应用
      uiStyle: database.getUiStyle() || 'Clear',
      // 上次使用模块；renderer 启动时恢复
      currentModule: database.getCurrentModule() || 'statement-generator',
      // v1.5.3 R2（D15）：启动时自有账号迁移失败的错误文案；null 表示无失败
      ownAccountsMigrationError: lastOwnAccountsMigrationError
    };
  });
  ipcMain.handle('settings:get-ui-style', () => {
    return database.getUiStyle() || 'Clear';
  });
  ipcMain.handle('settings:set-ui-style', (_event, style) => {
    try {
      database.setUiStyle(style);
      return { status: 'ok', uiStyle: style };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  ipcMain.handle('settings:set-current-module', (_event, moduleId) => {
    try {
      database.setCurrentModule(moduleId);
      return { status: 'ok', currentModule: moduleId };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  // v2.0.0-beta.3：银行对账单处理模块 — 场景 CRUD IPC
  ipcMain.handle('scenarios:list', () => {
    try {
      return { status: 'ok', scenarios: database.listScenarios() };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  ipcMain.handle('scenarios:get', (_event, id) => {
    try {
      const scenario = database.getScenario(id);
      if (!scenario) {
        return { status: 'failed', message: `场景 id=${id} 不存在` };
      }
      return { status: 'ok', scenario };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  ipcMain.handle('scenarios:create', (_event, payload) => {
    try {
      const result = database.createScenario(payload);
      return { status: 'ok', id: result.id };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  ipcMain.handle('scenarios:update', (_event, id, fields) => {
    try {
      database.updateScenario(id, fields);
      return { status: 'ok', id };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  ipcMain.handle('scenarios:delete', (_event, id) => {
    try {
      const result = database.deleteScenario(id);
      return { status: 'ok', id, deleted: result.deleted };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  ipcMain.handle('scenarios:toggle-enabled', (_event, id, enabled) => {
    try {
      const result = database.toggleScenarioEnabled(id, enabled);
      return { status: 'ok', id, enabled: result.enabled };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  ipcMain.handle('app:save-user-guide', async () => {
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: '使用手册',
        filters: [
          { name: '纯文本文件', extensions: ['txt'] },
          { name: 'Markdown 文件', extensions: ['md'] },
          { name: 'HTML 文件', extensions: ['html'] }
        ]
      });

      if (result.canceled || !result.filePath) {
        return { status: 'cancelled' };
      }

      const userGuidePath = path.join(app.getAppPath(), 'docs', 'USER_GUIDE.md');
      const markdown = fs.readFileSync(userGuidePath, 'utf8');
      const ext = path.extname(result.filePath).toLowerCase();

      if (ext === '.md') {
        fs.writeFileSync(result.filePath, markdown, 'utf8');
      } else if (ext === '.txt') {
        const plainText = stripMarkdown(markdown);
        fs.writeFileSync(result.filePath, plainText, 'utf8');
      } else if (ext === '.html') {
        const { marked } = require('marked');
        marked.setOptions({ gfm: true, breaks: true });
        const htmlBody = marked.parse(markdown);

        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.7; color: #333; max-width: 700px; margin: 0 auto; padding: 20px 30px; }
  h1 { font-size: 22px; border-bottom: 2px solid #e0d5c0; padding-bottom: 8px; }
  h2 { font-size: 18px; margin-top: 28px; border-bottom: 1px solid #e0d5c0; padding-bottom: 6px; }
  h3 { font-size: 15px; margin-top: 20px; }
  h4 { font-size: 14px; margin-top: 16px; }
  code { background: #f5f0e8; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  pre { background: #f5f0e8; padding: 12px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d4c9b0; margin: 10px 0; padding: 6px 14px; color: #666; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { border: 1px solid #d4c9b0; padding: 6px 10px; text-align: left; font-size: 12px; }
  th { background: #f5f0e8; }
  hr { border: none; border-top: 1px solid #e0d5c0; margin: 20px 0; }
  li { margin: 3px 0; }
  strong { color: #222; }
</style>
</head>
<body>${htmlBody}</body>
</html>`;

        fs.writeFileSync(result.filePath, html, 'utf8');
      }

      return {
        status: 'success',
        message: `使用手册导出成功：${result.filePath}`,
        filePath: result.filePath
      };
    } catch (error) {
      return {
        status: 'error',
        message: '使用手册导出失败，请查看控制台'
      };
    }
  });
  ipcMain.on('app:report-startup-metrics', (_event, payload = {}) => {
    startupMetrics.renderer = sanitizeRendererStartupMetrics(payload);

    const totalInitMs = startupMetrics.renderer?.durations?.totalInitMs;
    const getInfoMs = startupMetrics.renderer?.durations?.getInfoMs;
    const refreshTemplatesMs = startupMetrics.renderer?.durations?.refreshTemplatesMs;
    const bindEventsMs = startupMetrics.renderer?.durations?.bindEventsMs;

    if (totalInitMs !== undefined) {
      appendActivityLogEntry({
        level: 'info',
        message: '渲染层启动耗时',
        details: [
          `初始化总耗时：${formatStartupDuration(totalInitMs)}`,
          ...(getInfoMs !== undefined ? [`app:get-info：${formatStartupDuration(getInfoMs)}`] : []),
          ...(refreshTemplatesMs !== undefined ? [`模板刷新：${formatStartupDuration(refreshTemplatesMs)}`] : []),
          ...(bindEventsMs !== undefined ? [`事件绑定：${formatStartupDuration(bindEventsMs)}`] : [])
        ]
      });
    }

    if (startupMetricsReported) {
      writeStartupMetricsSnapshot(buildStartupMetricsSnapshot());
    }
  });
}

function registerErrorHandlers() {
  ipcMain.handle('error:export-last', async () => {
    if (!lastErrorReport || !lastErrorReport.filePath || !fs.existsSync(lastErrorReport.filePath)) {
      return {
        status: 'empty',
        message: '当前没有可导出的报错文件',
        errorReportReady: false
      };
    }

    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: lastErrorReport.fileName,
      filters: [
        {
          name: '文本文件',
          extensions: ['txt']
        }
      ]
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { status: 'cancelled' };
    }

    fs.copyFileSync(lastErrorReport.filePath, saveResult.filePath);
    return {
      status: 'success',
      message: '报错文件导出成功',
      filePath: saveResult.filePath
    };
  });
}

function registerBackgroundHandlers() {
  ipcMain.handle('background:select-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: backgroundFileDialogFilters()
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    const selectedPath = result.filePaths[0];

    try {
      const imageInfo = validateBackgroundImage(selectedPath);

      return {
        status: 'success',
        background: {
          sourcePath: selectedPath,
          sourceFileName: path.basename(selectedPath),
          imageDataUrl: fileToDataUrl(selectedPath),
          ...imageInfo
        }
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '导入背景文件',
          message: error.message,
          errorCode: error.code,
          detailLines: ['背景文件未通过校验，请确认格式、大小和分辨率限制。'],
          context: { selectedPath }
        });
      }

      return createErrorResult({
        step: '导入背景文件',
        message: '背景文件导入失败，请导出报错文件查看详情',
        errorCode: 'BACKGROUND_IMPORT_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { selectedPath }
      });
    }
  });

  ipcMain.handle('background:save', (_event, payload) => {
    try {
      const backgroundConfig = saveBackgroundConfig(payload);
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '保存背景设置成功',
        details: [backgroundConfig.filePath ? `背景文件：${backgroundConfig.sourceFileName}` : `背景色：${backgroundConfig.colorHex}`]
      });
      return {
        status: 'success',
        message: backgroundConfig.filePath ? '背景已更新' : '背景色已更新',
        backgroundConfig
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存背景设置',
          message: error.message,
          errorCode: error.code,
          detailLines: ['背景设置未保存，请检查颜色值或背景文件。']
        });
      }

      return createErrorResult({
        step: '保存背景设置',
        message: '背景设置保存失败，请导出报错文件查看详情',
        errorCode: 'BACKGROUND_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });

  ipcMain.handle('background:reset', () => {
    try {
      const backgroundConfig = saveBackgroundConfig({
        colorHex: getStyleDefaultBackgroundColor(),
        keepExistingImage: false
      });
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '重置背景设置成功',
        details: [`背景色：${backgroundConfig.colorHex}`]
      });

      return {
        status: 'success',
        message: '已恢复默认背景',
        backgroundConfig
      };
    } catch (error) {
      return createErrorResult({
        step: '重置背景设置',
        message: error instanceof FileValidationError ? error.message : '背景重置失败，请导出报错文件查看详情',
        errorCode: error.code || 'BACKGROUND_RESET_RUNTIME',
        errorType: error instanceof FileValidationError ? '业务校验错误' : '系统错误',
        originalError: error
      });
    }
  });
}

function validateAccountMappings(mappings) {
  const cleanedMappings = [];
  const bankAccountSeen = new Set();

  for (const mapping of mappings) {
    const bankAccountId = String(mapping.bankAccountId || '').trim();
    const clearingAccountId = String(mapping.clearingAccountId || '').trim();

    if (!bankAccountId && !clearingAccountId) {
      continue;
    }

    if (!bankAccountId || !clearingAccountId) {
      return {
        status: 'error',
        message: '账户映射存在未填写完整的行，请补全后再保存'
      };
    }

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(bankAccountId)) {
      return {
        status: 'error',
        message: '网银大账号ID仅支持1-64位字母、数字、下划线、中划线'
      };
    }

    if (bankAccountSeen.has(bankAccountId)) {
      return {
        status: 'error',
        message: '网银大账号ID不可重复，请重新确认'
      };
    }

    if (clearingAccountId.length > 128) {
      return {
        status: 'error',
        message: '清结算系统大账户ID长度不能超过128位'
      };
    }

    const noCurrency = Boolean(mapping.noCurrency);
    const currency = String(mapping.currency || '').trim();

    if (noCurrency && !currency) {
      return {
        status: 'error',
        message: '请填写币种'
      };
    }

    if (noCurrency && !/^[A-Z]{3,5}$/i.test(currency)) {
      return {
        status: 'error',
        message: '币种代码无效'
      };
    }

    bankAccountSeen.add(bankAccountId);
    cleanedMappings.push({
      bankAccountId,
      clearingAccountId,
      noCurrency,
      currency: noCurrency ? currency.toUpperCase() : currency
    });
  }

  return {
    status: 'success',
    mappings: cleanedMappings
  };
}

function registerAccountMappingHandlers() {
  ipcMain.handle('account-mapping:list', (_event, templateId) => {
    return {
      status: 'success',
      mappings: database.listAccountMappings(templateId)
    };
  });

  ipcMain.handle('account-mapping:save', (_event, templateId, mappings) => {
    try {
      const validationResult = validateAccountMappings(mappings);

      if (validationResult.status !== 'success') {
        return createErrorResult({
          step: '保存账户映射',
          message: validationResult.message,
          errorCode: 'ACCOUNT_MAPPING_VALIDATE',
          detailLines: ['账户映射存在格式或完整性问题，未执行保存。'],
          context: { templateId, mappings }
        });
      }

      database.saveAccountMappings(templateId, validationResult.mappings);
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '保存账户映射成功',
        details: [`模板ID：${templateId}`, `映射条数：${validationResult.mappings.length}`]
      });
      return {
        status: 'success',
        message: '账户映射保存成功'
      };
    } catch (error) {
      return createErrorResult({
        step: '保存账户映射',
        message: '账户映射保存失败，请导出报错文件查看详情',
        errorCode: 'ACCOUNT_MAPPING_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, mappings }
      });
    }
  });

  ipcMain.handle('account-mapping:check-migration-pending', () => {
    const pending = database.getSetting('account_mapping_migration_pending');
    return { pending: pending === 'true' };
  });

  ipcMain.handle('account-mapping:get-migration-data', () => {
    // 取所有模板的 account_mappings，按 (bankAccountId, clearingAccountId, noCurrency, currency) 去重
    const templates = database.listTemplates();
    const seen = new Set();
    const uniqueRows = [];

    for (const template of templates) {
      const mappings = database.listAccountMappings(template.id);
      for (const m of mappings) {
        const key = `${normalizeCell(m.bankAccountId)}|${normalizeCell(m.clearingAccountId)}|${m.noCurrency}|${normalizeCell(m.currency)}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueRows.push({
            bankAccountId: normalizeCell(m.bankAccountId),
            clearingAccountId: normalizeCell(m.clearingAccountId),
            noCurrency: Boolean(m.noCurrency),
            currency: normalizeCell(m.currency)
          });
        }
      }
    }

    return { status: 'success', rows: uniqueRows };
  });

  ipcMain.handle('account-mapping:distribute-migration', (_event, assignments) => {
    // assignments: [{ bankAccountId, clearingAccountId, noCurrency, currency, templateId }]
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return createErrorResult({
        step: '分配账户映射',
        message: '没有分配数据',
        errorCode: 'MIGRATION_DISTRIBUTE_EMPTY'
      });
    }

    try {
      // 按 templateId 分组
      const byTemplate = new Map();
      const allTemplates = database.listTemplates();
      const validTemplateIds = new Set(allTemplates.map((t) => t.id));

      // 获取迁移源数据的行数，用于完整性校验
      const migrationSourceRows = database.listAllAccountMappings
        ? database.listAllAccountMappings()
        : [];
      const uniqueSourceKeys = new Set(
        migrationSourceRows.map((m) => `${normalizeCell(m.bankAccountId)}@@${normalizeCell(m.clearingAccountId)}`)
      );

      const droppedRows = [];
      assignments.forEach((a, index) => {
        const tid = Number(a.templateId);
        if (!validTemplateIds.has(tid)) {
          droppedRows.push({ bankAccountId: a.bankAccountId, reason: '模板已删除' });
          return;
        }
        if (!byTemplate.has(tid)) byTemplate.set(tid, []);
        byTemplate.get(tid).push({
          bankAccountId: normalizeCell(a.bankAccountId),
          clearingAccountId: normalizeCell(a.clearingAccountId),
          noCurrency: Boolean(a.noCurrency),
          currency: normalizeCell(a.currency),
          rowIndex: index
        });
      });

      // 如果有行因模板已删除被丢弃，拒绝提交而非静默丢失
      if (droppedRows.length > 0) {
        return createErrorResult({
          step: '分配账户映射',
          message: `${droppedRows.length} 条映射的目标模板已被删除，请关闭后重新打开账户映射页面`,
          errorCode: 'MIGRATION_DISTRIBUTE_STALE_TEMPLATE'
        });
      }

      // 清空所有模板的 account_mappings，再按分配写入
      for (const template of allTemplates) {
        const rows = byTemplate.get(template.id) || [];
        database.saveAccountMappings(template.id, rows);
      }

      // 标记迁移完成
      database.setSetting('account_mapping_migration_pending', 'false');

      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '账户映射迁移分配完成',
        details: [`分配条数：${assignments.length}`, `涉及模板：${byTemplate.size}个`]
      });

      return { status: 'success', message: '账户映射分配完成' };
    } catch (error) {
      return createErrorResult({
        step: '分配账户映射',
        message: '分配失败，请导出报错文件查看详情',
        errorCode: 'MIGRATION_DISTRIBUTE_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });
}

function validateTemplateConfiguration({ template, mappings, enumValues, bigAccounts = [], fixedAssignments = [] }) {
  const targetFields = buildManagedMappingFields(enumValues);
  const targetFieldSet = new Set(targetFields);
  const sourceFieldSet = new Set(template.headers.map((header) => normalizeCell(header)));
  const mappingByTarget = new Map();

  mappings.forEach((mapping) => {
    const targetField = normalizeCell(mapping.templateField);
    const sourceField = getPrimaryMappedField(mapping);
    const rawMappedField = normalizeCell(mapping.mappedField);

    if (!targetFieldSet.has(targetField)) {
      return;
    }

    mappingByTarget.set(targetField, {
      mappedField: rawMappedField === CONCAT_FIELDS_MAPPING_FIELD ? CONCAT_FIELDS_MAPPING_FIELD : sourceField,
      mappedFields: getMappingFieldValues(mapping),
      customValue: normalizeCell(mapping.customValue)
    });
  });

  const cleanedMappings = [];
  const merchantIdMapping = mappingByTarget.get('MerchantId') || {
    mappedField: '',
    mappedFields: [],
    customValue: '',
    isMultiBigAccount: false
  };
  const merchantIdManagedByBigAccounts = merchantIdMapping.mappedField === MERCHANT_ID_SELF_INPUT_OPTION;
  const signedAmountSourceField = normalizeCell(mappingByTarget.get(SIGNED_AMOUNT_MAPPING_FIELD)?.mappedField);
  const creditAmountSourceField = normalizeCell(mappingByTarget.get('Credit Amount')?.mappedField);
  const debitAmountSourceField = normalizeCell(mappingByTarget.get('Debit Amount')?.mappedField);
  const amountSplitByFieldOption = normalizeCell(mappingByTarget.get(AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD)?.mappedField);
  const billSplitMergeOption = normalizeCell(mappingByTarget.get(BILL_SPLIT_MERGE_MAPPING_FIELD)?.mappedField);
  const usesSignedAmountMapping = signedAmountSourceField !== '';
  const usesDirectAmountMapping = creditAmountSourceField !== '' || debitAmountSourceField !== '';
  const usesAmountSplitByField = amountSplitByFieldOption === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;
  const usesBillSplitMerge = billSplitMergeOption === BILL_SPLIT_MERGE_ENABLED_OPTION;

  const enabledAmountModes = [
    usesDirectAmountMapping,
    usesSignedAmountMapping,
    usesAmountSplitByField,
    usesBillSplitMerge
  ].filter(Boolean).length;

  if (enabledAmountModes > 1) {
    throw new FileValidationError(
      'FILE_READ',
      'Credit Amount / Debit Amount 直接映射、按正负号拆分的发生额、按字段区分发生额、拆分/合并明细账单 四者只能启用其中一种'
    );
  }

  if (usesSignedAmountMapping && !sourceFieldSet.has(signedAmountSourceField)) {
    throw new FileValidationError('FILE_READ', `映射字段不存在：${signedAmountSourceField}`);
  }

  const cleanedBigAccounts = merchantIdManagedByBigAccounts
    ? bigAccounts.map((item) => {
        // v1.5.3 R2：透传 accountNature，缺省 → 'client'；非法值同样落 'client'
        const rawNature = typeof item.accountNature === 'string' ? item.accountNature.trim() : '';
        const accountNature = rawNature === 'own' ? 'own' : 'client';
        return {
          merchantId: normalizeCell(item.merchantId),
          currencies: Array.from(
            new Set(
              (Array.isArray(item.currencies) ? item.currencies : [])
                .map((value) => normalizeCell(value))
                .filter((value) => value !== '')
            )
          ),
          isMultiCurrency: Boolean(item.isMultiCurrency),
          accountNature
        };
      })
    : [];
  // v1.5.3 R2 round 2 修复 (Codex Finding 4)：
  // groupBigAccountRows 按 (merchantId+accountNature) 分组，因此同 merchantId 可能有 2 条（client + own，币种不一定相同）。
  // 旧 lookup `new Map(items.map(i=>[i.merchantId, i]))` 后写覆盖前写 → 固定字段赋值过滤可能误删合法行。
  // 修复：按 merchantId 聚合所有 currencies（client ∪ own）作为合法币种集合。
  // fixed-assignment 本身不区分 nature，能匹配任一 nature 的账户即视为合法。
  const bigAccountCurrencyLookup = new Map();
  cleanedBigAccounts.forEach((item) => {
    if (!bigAccountCurrencyLookup.has(item.merchantId)) {
      bigAccountCurrencyLookup.set(item.merchantId, new Set());
    }
    const set = bigAccountCurrencyLookup.get(item.merchantId);
    item.currencies.forEach((currency) => set.add(currency));
  });
  const seenFixedRowIndices = new Set();
  const cleanedFixedAssignments = merchantIdManagedByBigAccounts
    ? fixedAssignments
        .map((item, index) => ({
          merchantId: normalizeCell(item.merchantId),
          currency: normalizeCell(item.currency),
          rowIndex: Number.isInteger(item.rowIndex) ? item.rowIndex : index
        }))
        .filter((item) => {
          if (!item.merchantId) return false;
          if (seenFixedRowIndices.has(item.rowIndex)) return false;
          const validCurrencies = bigAccountCurrencyLookup.get(item.merchantId);
          if (!validCurrencies) return false;
          if (item.currency && validCurrencies.size && !validCurrencies.has(item.currency)) return false;
          seenFixedRowIndices.add(item.rowIndex);
          return true;
        })
    : [];

  targetFields.forEach((targetField) => {
    const selectedMapping = mappingByTarget.get(targetField) || {
      mappedField: '',
      mappedFields: [],
      customValue: '',
      isMultiBigAccount: false
    };
    const selectedSourceField = selectedMapping.mappedField;
    const selectedSourceFields = selectedMapping.mappedFields;
    const normalizedSourceField = targetField === 'Balance'
      ? selectedSourceField || BALANCE_DISABLED_OPTION
      : selectedSourceField === BALANCE_DISABLED_OPTION
        ? ''
        : selectedSourceField;

    if (targetField === 'Balance' && normalizedSourceField === BALANCE_DISABLED_OPTION) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: BALANCE_DISABLED_OPTION,
        mappedFields: []
      });
      return;
    }

    if (targetField === 'Balance' && normalizedSourceField === BALANCE_CALCULATED_OPTION) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: BALANCE_CALCULATED_OPTION,
        mappedFields: []
      });
      return;
    }

    if (merchantIdManagedByBigAccounts && targetField === 'Currency') {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: '',
        mappedFields: []
      });
      return;
    }

    if (targetField === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: normalizedSourceField === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION
          ? AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION
          : '',
        mappedFields: []
      });
      return;
    }

    if (targetField === BILL_SPLIT_MERGE_MAPPING_FIELD) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: normalizedSourceField === BILL_SPLIT_MERGE_ENABLED_OPTION
          ? BILL_SPLIT_MERGE_ENABLED_OPTION
          : '',
        mappedFields: []
      });
      return;
    }

    if (targetField === REUSE_MODULE_MAPPING_FIELD) {
      const value = normalizedSourceField === '否' ? '否' : REUSE_MODULE_DEFAULT_OPTION;
      cleanedMappings.push({
        templateField: targetField,
        mappedField: value,
        mappedFields: []
      });
      return;
    }

    if (!normalizedSourceField && !selectedSourceFields.length) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: '',
        mappedFields: []
      });
      return;
    }

    if (targetField === 'MerchantId' && normalizedSourceField === MERCHANT_ID_SELF_INPUT_OPTION) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`,
        mappedFields: []
      });
      return;
    }

    if (targetField === 'Currency' && normalizedSourceField === MERCHANT_ID_SELF_INPUT_OPTION) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: '',
        mappedFields: []
      });
      return;
    }

    if (targetField === 'MerchantId' && normalizedSourceField.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: normalizedSourceField,
        mappedFields: []
      });
      return;
    }

    if (targetField === 'Currency' && normalizedSourceField.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: merchantIdManagedByBigAccounts ? '' : normalizedSourceField,
        mappedFields: []
      });
      return;
    }

    if (normalizedSourceField === CONCAT_FIELDS_MAPPING_FIELD) {
      if (!selectedSourceFields.length) {
        throw new FileValidationError('FILE_READ', `${targetField} 使用"需要拼接字段"时必须至少选择 1 个源字段`);
      }

      selectedSourceFields.forEach((fieldName) => {
        if (!sourceFieldSet.has(fieldName)) {
          throw new FileValidationError('FILE_READ', `拼接字段不存在：${fieldName}`);
        }
      });

      cleanedMappings.push({
        templateField: targetField,
        mappedField: CONCAT_FIELDS_MAPPING_FIELD,
        mappedFields: selectedSourceFields
      });
      return;
    }

    if (selectedSourceFields.length > 1) {
      selectedSourceFields.forEach((fieldName) => {
        if (!sourceFieldSet.has(fieldName)) {
          throw new FileValidationError('FILE_READ', `映射字段不存在：${fieldName}`);
        }
      });

      cleanedMappings.push({
        templateField: targetField,
        mappedField: selectedSourceFields[0],
        mappedFields: selectedSourceFields
      });
      return;
    }

    if (!sourceFieldSet.has(normalizedSourceField)) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${normalizedSourceField}`);
    }

    cleanedMappings.push({
      templateField: targetField,
      mappedField: normalizedSourceField,
      mappedFields: []
    });
  });

  if (merchantIdManagedByBigAccounts) {
    if (!cleanedBigAccounts.length) {
      throw new FileValidationError('FILE_READ', '请至少维护 1 条大账号配置');
    }

    const duplicateKeys = new Set();

    cleanedBigAccounts.forEach((item) => {
      if (!item.merchantId) {
        throw new FileValidationError('FILE_READ', '大账号不能为空');
      }

      if (!item.currencies.length) {
        throw new FileValidationError('FILE_READ', '每条大账号配置都必须至少选择 1 个币种');
      }

      item.currencies.forEach((currency) => {
        const compositeKey = `${item.merchantId}@@${currency}`;

        if (duplicateKeys.has(compositeKey)) {
          throw new FileValidationError('FILE_READ', `大账号 ${item.merchantId} 的币种 ${currency} 重复`);
        }

        duplicateKeys.add(compositeKey);
      });
    });
  }

  return {
    mappings: cleanedMappings,
    bigAccounts: expandBigAccountConfigurations(cleanedBigAccounts),
    fixedAssignments: cleanedFixedAssignments
  };
}

function registerTemplateHandlers() {
  ipcMain.handle('template:list', () => {
    return database.listTemplates();
  });

  ipcMain.handle('template:list-children', (_event, parentTemplateId) => {
    return database.listChildTemplates(parentTemplateId);
  });

  ipcMain.handle('template:set-parent-status', (_event, templateId, isParent) => {
    try {
      database.setParentStatus(templateId, isParent);
      syncTemplateLibraryFile();
      return { status: 'success' };
    } catch (error) {
      return createErrorResult({
        step: '设置主模板状态',
        message: '操作失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_SET_PARENT_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, isParent }
      });
    }
  });

  ipcMain.handle('template:set-child-parent', (_event, templateId, parentTemplateId) => {
    try {
      database.setChildParent(templateId, parentTemplateId);
      syncTemplateLibraryFile();
      return { status: 'success' };
    } catch (error) {
      return createErrorResult({
        step: '设置子模板',
        message: '操作失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_SET_CHILD_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, parentTemplateId }
      });
    }
  });

  ipcMain.handle('template:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: templateFileDialogFilters()
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    const selectedPath = result.filePaths[0];

    try {
      const headers = extractHeaders(selectedPath);
      const templateName = path.parse(selectedPath).name;

      // v1.5.2：表头唯一性校验 — 检查是否和已有模板重复
      const existingByName = database.getTemplateByName(templateName);
      const conflict = findConflictingTemplateByHeaders(headers, existingByName ? existingByName.id : null);
      if (conflict) {
        return createErrorResult({
          step: '导入模板文件',
          message: `该文件的表头与已有模板「${conflict.name}」完全相同，无法创建重复表头的模板。`,
          errorCode: 'TEMPLATE_HEADERS_DUPLICATE',
          context: { conflictTemplateName: conflict.name }
        });
      }

      const template = database.upsertTemplate({
        name: templateName,
        sourceFileName: path.basename(selectedPath),
        headers
      });
      syncTemplateLibraryFile();
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '导入模板文件成功',
        details: [`模板名：${templateName}`, `源文件：${selectedPath}`]
      });

      return {
        status: 'success',
        message: '模板导入成功，请在模板管理中维护映射关系',
        template: buildTemplateSummary(template)
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '导入模板文件',
          message: error.message,
          errorCode: error.code,
          detailLines: ['模板文件无法读取或表头无效，未完成导入。'],
          context: { selectedPath }
        });
      }

      return createErrorResult({
        step: '导入模板文件',
        message: '模板导入失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_IMPORT_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { selectedPath }
      });
    }
  });

  ipcMain.handle('template:delete', (_event, templateId) => {
    const template = database.getTemplate(templateId);
    database.deleteTemplate(templateId);
    syncTemplateLibraryFile();
    clearGeneratedExports();
    clearPendingManualBalancePrompt();
    clearPendingBigAccountSelection();
    appendActivityLogEntry({
      level: 'info',
      message: '删除模板成功',
      details: [`模板名：${template?.name || templateId}`]
    });
    return { status: 'success' };
  });

  ipcMain.handle('template:get-mappings', (_event, templateId) => {
    if (!getEnumConfig()) {
      return createErrorResult({
        step: '打开映射关系管理',
        message: MISSING_ENUM_MESSAGE,
        errorCode: 'ENUM_MISSING'
      });
    }

    try {
      const mappingConfig = getTemplateMappingConfig(templateId);

      if (!mappingConfig) {
        return createErrorResult({
          step: '打开映射关系管理',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }

      return {
        status: 'success',
        template: buildTemplateSummary(mappingConfig.template),
        targetFields: mappingConfig.targetFields,
        advancedMappingFields: mappingConfig.advancedMappingFields,
        billSplitGroupFields: mappingConfig.billSplitGroupFields,
        exportTargetFields: mappingConfig.exportTargetFields,
        mappings: mappingConfig.mappings,
        bigAccounts: mappingConfig.bigAccounts,
        fixedAssignments: mappingConfig.fixedAssignments,
        amountSplitRules: mappingConfig.amountSplitRules,
        billSplitMappings: mappingConfig.billSplitMappings,
        billSplitRows: mappingConfig.billSplitRows,
        billSplitAmountRules: mappingConfig.billSplitAmountRules,
        billSplitMeta: mappingConfig.billSplitMeta,
        dateFormat: mappingConfig.template.dateFormat || 'auto'
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '打开映射关系管理',
          message: '内置网银账单枚举表为空或不可读，请检查安装包',
          errorCode: error.code,
          originalError: error
        });
      }

      return createErrorResult({
        step: '打开映射关系管理',
        message: '映射关系管理打开失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_MAPPING_OPEN_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId }
      });
    }
  });

  ipcMain.handle('template:save-mappings', (_event, payload) => {
    let template = null;

    try {
      const enumConfig = getEnumConfig();
      template = database.getTemplate(payload.templateId);

      if (!enumConfig) {
        return createErrorResult({
          step: '保存模板映射',
          message: MISSING_ENUM_MESSAGE,
          errorCode: 'ENUM_MISSING'
        });
      }

      if (!template) {
        return createErrorResult({
          step: '保存模板映射',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId: payload.templateId }
        });
      }

      const templateConfiguration = validateTemplateConfiguration({
        template,
        mappings: payload.mappings,
        enumValues: loadEnumValues(enumConfig.filePath),
        bigAccounts: payload.bigAccounts,
        fixedAssignments: payload.fixedAssignments
      });

      const usesAmountSplitByField = templateConfiguration.mappings.some(
        (mapping) => normalizeCell(mapping.templateField) === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD
          && normalizeCell(mapping.mappedField) === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION
      );

      if (usesAmountSplitByField) {
        const existingRules = database.getAmountSplitRules(payload.templateId) || [];

        if (existingRules.length < 2) {
          return createErrorResult({
            step: '保存模板映射',
            message: '请先在"发生额映射关系管理"中配置完整的两行规则',
            errorCode: 'AMOUNT_SPLIT_RULES_MISSING',
            context: {
              templateId: payload.templateId,
              templateName: template.name
            },
            templateName: template.name
          });
        }
      }

      // v1.4.9 ACI-11: 开关 = 是 但弹框 2 无 completed 行 → 报错
      const usesBillSplitMerge = templateConfiguration.mappings.some(
        (mapping) => normalizeCell(mapping.templateField) === BILL_SPLIT_MERGE_MAPPING_FIELD
          && normalizeCell(mapping.mappedField) === BILL_SPLIT_MERGE_ENABLED_OPTION
      );

      if (usesBillSplitMerge) {
        const existingBillSplitRows = database.getBillSplitRows(payload.templateId) || [];
        const completedRows = existingBillSplitRows.filter((row) => row.rowStatus === 'completed');

        if (completedRows.length === 0) {
          return createErrorResult({
            step: '保存模板映射',
            message: '请先在"拆分/合并账单映射关系管理"中配置至少一行拆分账单配置',
            errorCode: 'BILL_SPLIT_CONFIG_MISSING',
            context: {
              templateId: payload.templateId,
              templateName: template.name
            },
            templateName: template.name
          });
        }
      }

      // v1.5.3 R2 round 3 (Codex Finding 5)：透传 preserveOwn
      // 默认 false（向后兼容旧行为：DELETE all + INSERT all，caller 接管 own 全集）
      // 仅当前端显式传 preserveOwn=true（即维护大账号没被打开过 → bigAccountsLoadedWithOwn=false → currentBigAccounts 是 client-only）才走 DELETE-client-only 保留 own 路径
      const preserveOwn = payload.preserveOwn === true;
      database.saveMappings(
        payload.templateId,
        templateConfiguration.mappings,
        templateConfiguration.bigAccounts,
        templateConfiguration.fixedAssignments,
        payload.dateFormat,
        null,
        { preserveOwn }
      );
      syncTemplateLibraryFile();
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '保存模板映射成功',
        details: [`模板名：${template.name}`]
      });
      return {
        status: 'success',
        message: '模板映射保存成功'
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存模板映射',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: {
            templateId: payload.templateId,
            templateName: template?.name || ''
          },
          templateName: template?.name || ''
        });
      }

      return createErrorResult({
        step: '保存模板映射',
        message: '模板映射保存失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_MAPPING_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: {
          templateId: payload.templateId,
          templateName: template?.name || ''
        },
        templateName: template?.name || ''
      });
    }
  });

  ipcMain.handle('template:rename', (_event, payload = {}) => {
    const templateId = Number(payload.templateId);
    const nextName = normalizeCell(payload.name);
    const template = database.getTemplate(templateId);

    try {
      if (!template) {
        return createErrorResult({
          step: '重命名模板',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }

      if (!nextName) {
        return createErrorResult({
          step: '重命名模板',
          message: '请输入新的模板名称',
          errorCode: 'TEMPLATE_NAME_REQUIRED',
          templateName: template.name
        });
      }

      const existingTemplate = database.getTemplateByName(nextName);

      if (existingTemplate && existingTemplate.id !== templateId) {
        return createErrorResult({
          step: '重命名模板',
          message: '模板名称已存在，请重新输入',
          errorCode: 'TEMPLATE_NAME_DUPLICATED',
          templateName: template.name
        });
      }

      const renamedTemplate = database.renameTemplate(templateId, nextName);
      syncTemplateLibraryFile();
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '重命名模板成功',
        details: [`原模板名：${template.name}`, `新模板名：${nextName}`]
      });
      return {
        status: 'success',
        message: '模板名称修改成功',
        template: buildTemplateSummary(renamedTemplate)
      };
    } catch (error) {
      return createErrorResult({
        step: '重命名模板',
        message: '模板名称修改失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_RENAME_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: {
          templateId,
          templateName: template?.name || ''
        },
        templateName: template?.name || ''
      });
    }
  });

  // v1.5.2 需求 3：保存模板的文件名固定字段
  // payload: { templateId: number, value: string }
  ipcMain.handle('template:save-filename-fixed-field', (_event, payload = {}) => {
    try {
      const templateId = Number(payload.templateId);
      if (!Number.isFinite(templateId) || templateId <= 0) {
        return {
          status: 'error',
          message: '无效的模板 ID',
          errorCode: 'TEMPLATE_ID_INVALID'
        };
      }
      const value = String(payload.value ?? '');
      database.saveTemplateFilenameFixedField(templateId, value);
      syncTemplateLibraryFile();
      return { status: 'success' };
    } catch (error) {
      return {
        status: 'error',
        message: error && error.message ? error.message : '保存失败',
        errorCode: 'TEMPLATE_FILENAME_FIXED_FIELD_SAVE_FAILED'
      };
    }
  });

  ipcMain.handle('template:export-bundle', async () => {
    try {
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        defaultPath: 'template-library.json',
        filters: [
          {
            name: 'JSON',
            extensions: ['json']
          }
        ]
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return { status: 'cancelled' };
      }

      writeTemplateBundleFile(saveResult.filePath);
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '导出模板文件成功',
        details: [`导出路径：${saveResult.filePath}`]
      });
      return {
        status: 'success',
        message: '模板文件导出成功',
        filePath: saveResult.filePath
      };
    } catch (error) {
      return createErrorResult({
        step: '导出模板文件',
        message: '模板文件导出失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_BUNDLE_EXPORT_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });

  ipcMain.handle('template:import-bundle', async () => {
    const enumConfig = getEnumConfig();

    if (!enumConfig) {
      return createErrorResult({
        step: '导入模板文件',
        message: MISSING_ENUM_MESSAGE,
        errorCode: 'ENUM_MISSING'
      });
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'JSON',
          extensions: ['json']
        }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    const selectedPath = result.filePaths[0];

    try {
      const enumValues = loadEnumValues(enumConfig.filePath);
      const importedTemplates = readTemplateBundleFile(selectedPath);
      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      // Scan for existing templates with same name before importing
      const existingTemplateNames = [];
      importedTemplates.forEach((entry) => {
        if (!entry.name || !entry.headers.length) return;
        const existingTemplate = entry.templateKey
          ? database.getTemplateByKey(entry.templateKey)
          : database.getTemplateByName(entry.name);
        if (existingTemplate) {
          existingTemplateNames.push(entry.name);
        }
      });

      if (existingTemplateNames.length > 0) {
        const confirmResult = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '导入模板包',
          message: '以下模板已存在，导入将覆盖现有配置：',
          detail: existingTemplateNames.map((name) => `• ${name}`).join('\n') + '\n\n是否确认覆盖？',
          buttons: ['取消', '确认覆盖'],
          defaultId: 0,
          cancelId: 0
        });

        if (confirmResult.response === 0) {
          return { status: 'cancelled' };
        }
      }

      importedTemplates.forEach((entry) => {
        if (!entry.name || !entry.headers.length) {
          skippedCount += 1;
          return;
        }

        try {
          const existingTemplate = entry.templateKey
            ? database.getTemplateByKey(entry.templateKey)
            : database.getTemplateByName(entry.name);

          // v1.5.2：表头唯一性校验 — bundle 导入时检查每个模板
          const bundleConflict = findConflictingTemplateByHeaders(
            entry.headers,
            existingTemplate ? existingTemplate.id : null
          );
          if (bundleConflict) {
            skippedCount += 1;
            appendActivityLogEntry({
              level: 'warn',
              message: `Bundle 导入跳过模板「${entry.name}」：表头与已有模板「${bundleConflict.name}」重复`
            });
            return;
          }

          const draftTemplate = existingTemplate || {
            id: 0,
            templateKey: entry.templateKey,
            name: entry.name,
            sourceFileName: entry.sourceFileName,
            headers: entry.headers,
            createdAt: '',
            updatedAt: ''
          };
          const validated = validateTemplateConfiguration({
            template: draftTemplate,
            mappings: normalizeMappingRows({
              template: draftTemplate,
              mappings: entry.mappings,
              enumValues
            }),
            enumValues,
            bigAccounts: entry.bigAccounts,
            fixedAssignments: entry.fixedAssignments
          });
          const template = database.upsertTemplate({
            templateKey: entry.templateKey,
            name: entry.name,
            sourceFileName: entry.sourceFileName,
            headers: entry.headers
          });

          const normalizedAmountSplitRules = Array.isArray(entry.amountSplitRules)
            ? entry.amountSplitRules
                .map((rule, index) => ({
                  targetField: normalizeCell(rule?.targetField),
                  conditionField: normalizeCell(rule?.conditionField),
                  conditionValue: normalizeCell(rule?.conditionValue),
                  mappedField: normalizeCell(rule?.mappedField),
                  rowIndex: Number.isInteger(rule?.rowIndex) ? rule.rowIndex : index
                }))
                .filter((rule) => rule.targetField && rule.conditionField && rule.mappedField)
            : [];

          // bundle 导入：bigAccounts 来自 bundle 全量（listTemplateBundleEntries 导出时已含 own，见 :884）
          // preserveOwn=false → DELETE all + INSERT all，确保 bundle 是权威全集，旧 own 被覆盖
          database.saveMappings(
            template.id,
            validated.mappings,
            validated.bigAccounts,
            validated.fixedAssignments,
            entry.dateFormat,
            normalizedAmountSplitRules,
            { preserveOwn: false }
          );

          // v1.5.2 需求 3：透传文件名固定字段（老 bundle 无此字段时落为空串）
          database.saveTemplateFilenameFixedField(
            template.id,
            entry.filenameFixedField || ''
          );

          // v1.4.9: import bill-split/merge config (4 tables)
          const normalizedBillSplitMappings = Array.isArray(entry.billSplitMappings)
            ? entry.billSplitMappings
                .map((mapping, index) => ({
                  templateField: normalizeCell(mapping?.templateField),
                  mappedField: normalizeCell(mapping?.mappedField),
                  mappedFields: Array.isArray(mapping?.mappedFields)
                    ? mapping.mappedFields.map((value) => normalizeCell(value)).filter((value) => value !== '')
                    : [],
                  rowIndex: Number.isInteger(mapping?.rowIndex) ? mapping.rowIndex : index
                }))
                .filter((mapping) => mapping.templateField && (mapping.mappedField || mapping.mappedFields.length > 0))
            : [];
          database.saveBillSplitMappings(template.id, normalizedBillSplitMappings);

          const normalizedBillSplitRows = Array.isArray(entry.billSplitRows)
            ? entry.billSplitRows
                .map((row) => ({
                  seqNo: Number(row?.seqNo),
                  currencySourceField: normalizeCell(row?.currencySourceField),
                  creditSourceField: normalizeCell(row?.creditSourceField),
                  debitSourceField: normalizeCell(row?.debitSourceField),
                  amountSourceField: normalizeCell(row?.amountSourceField),
                  rowStatus: row?.rowStatus === 'completed' ? 'completed' : 'draft',
                  mergedGroupSeq: row?.mergedGroupSeq === null || row?.mergedGroupSeq === undefined
                    ? null
                    : Number(row.mergedGroupSeq)
                }))
                .filter((row) => Number.isInteger(row.seqNo) && row.seqNo >= 1)
                .sort((a, b) => a.seqNo - b.seqNo)
            : [];
          database.saveBillSplitRowCount(template.id, normalizedBillSplitRows.length);
          normalizedBillSplitRows.forEach((row) => {
            database.saveBillSplitRow(template.id, row);
          });
          // Restore merge groups
          database.clearBillSplitMergeGroups(template.id);
          const groupsByMin = new Map();
          normalizedBillSplitRows.forEach((row) => {
            if (row.mergedGroupSeq === null || row.mergedGroupSeq === undefined) {
              return;
            }
            const key = Number(row.mergedGroupSeq);
            if (!groupsByMin.has(key)) {
              groupsByMin.set(key, []);
            }
            groupsByMin.get(key).push(row.seqNo);
          });
          groupsByMin.forEach((seqNos) => {
            if (seqNos.length >= 2) {
              database.saveBillSplitMergeGroup(template.id, seqNos);
            }
          });

          const normalizedBillSplitAmountRules = Array.isArray(entry.billSplitAmountRules)
            ? entry.billSplitAmountRules
                .map((rule, index) => ({
                  targetField: normalizeCell(rule?.targetField),
                  conditionField: normalizeCell(rule?.conditionField),
                  conditionValue: normalizeCell(rule?.conditionValue),
                  mappedField: normalizeCell(rule?.mappedField),
                  rowIndex: Number.isInteger(rule?.rowIndex) ? rule.rowIndex : index
                }))
            : [];
          database.saveBillSplitAmountRules(template.id, normalizedBillSplitAmountRules);

          database.saveBillSplitMeta(template.id, {
            signedAmountSourceField: normalizeCell(entry.billSplitMeta?.signedAmountSourceField),
            signedAmountTargetSeqNos: entry.billSplitMeta?.signedAmountTargetSeqNos || [],
            byFieldAmountTargetSeqNos: entry.billSplitMeta?.byFieldAmountTargetSeqNos || []
          });

          if (entry.bigAccountOrderConfig && Array.isArray(entry.bigAccountOrderConfig.files)) {
            writeBigAccountOrder(ensureStorageRoot(), template.id, entry.bigAccountOrderConfig);
          } else {
            writeBigAccountOrder(ensureStorageRoot(), template.id, { assignments: [] });
          }

          writeBigAccountMode(
            ensureStorageRoot(),
            template.id,
            entry.bigAccountMode === 'fixed' ? 'fixed' : 'unfixed'
          );

          if (existingTemplate) {
            updatedCount += 1;
          } else {
            createdCount += 1;
          }
        } catch (error) {
          if (error instanceof FileValidationError) {
            skippedCount += 1;
            return;
          }

          throw error;
        }
      });

      // v1.5.1: 第二轮 — 还原主/子模板关系（覆盖导入时也清除旧的主/子状态）
      importedTemplates.forEach((entry) => {
        if (!entry.name || !entry.headers.length) return;
        const template = entry.templateKey
          ? database.getTemplateByKey(entry.templateKey)
          : database.getTemplateByName(entry.name);
        if (!template) return;

        // 始终同步主/子状态：v3 bundle 无这些字段时 isParent=false, parentTemplateKey=null → 清除旧状态
        database.setParentStatus(template.id, Boolean(entry.isParent));

        if (entry.parentTemplateKey) {
          const parentTemplate = database.getTemplateByKey(entry.parentTemplateKey);
          if (parentTemplate) {
            database.setChildParent(template.id, parentTemplate.id);
          }
        } else {
          database.setChildParent(template.id, null);
        }
      });

      // v1.5.1: 第三轮 — 导入账户映射（覆盖导入时也清除旧映射）
      importedTemplates.forEach((entry) => {
        if (!entry.name || !entry.headers.length) return;
        const template = entry.templateKey
          ? database.getTemplateByKey(entry.templateKey)
          : database.getTemplateByName(entry.name);
        if (!template) return;

        const mappings = (Array.isArray(entry.accountMappings) ? entry.accountMappings : []).map((m) => ({
          bankAccountId: normalizeCell(m.bankAccountId),
          clearingAccountId: normalizeCell(m.clearingAccountId),
          noCurrency: Boolean(m.noCurrency),
          currency: normalizeCell(m.currency)
        })).filter((m) => m.bankAccountId);

        // 始终写入：v3 bundle 无 accountMappings 时 mappings=[] → 清除旧映射
        database.saveAccountMappings(template.id, mappings);
      });

      syncTemplateLibraryFile();
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '导入模板包成功',
        details: [
          `源文件：${selectedPath}`,
          `新增：${createdCount}`,
          `更新：${updatedCount}`,
          `跳过：${skippedCount}`
        ]
      });
      return {
        status: 'success',
        message: `模板文件导入成功：新增${createdCount}，更新${updatedCount}，跳过${skippedCount}`
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '导入模板文件',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { selectedPath }
        });
      }

      return createErrorResult({
        step: '导入模板文件',
        message: '模板文件导入失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_BUNDLE_IMPORT_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { selectedPath }
      });
    }
  });

  ipcMain.handle('template:get-amount-split-rules', (_event, templateId) => {
    try {
      const template = database.getTemplate(templateId);

      if (!template) {
        return createErrorResult({
          step: '打开发生额映射关系管理',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }

      const rules = database.getAmountSplitRules(templateId) || [];

      return {
        status: 'success',
        template: buildTemplateSummary(template),
        rules: rules.map((rule) => ({
          targetField: normalizeCell(rule.targetField),
          conditionField: normalizeCell(rule.conditionField),
          conditionValue: normalizeCell(rule.conditionValue),
          mappedField: normalizeCell(rule.mappedField),
          rowIndex: Number(rule.rowIndex || 0)
        }))
      };
    } catch (error) {
      return createErrorResult({
        step: '打开发生额映射关系管理',
        message: '发生额映射关系管理打开失败，请导出报错文件查看详情',
        errorCode: 'AMOUNT_SPLIT_RULES_OPEN_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId }
      });
    }
  });

  ipcMain.handle('template:save-amount-split-rules', (_event, payload = {}) => {
    const templateId = Number(payload.templateId);
    let template = null;

    try {
      template = database.getTemplate(templateId);

      if (!template) {
        return createErrorResult({
          step: '保存发生额映射关系',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }

      const validatedRules = validateAmountSplitRulesPayload(payload.rules, template);

      database.saveAmountSplitRules(templateId, validatedRules);
      syncTemplateLibraryFile();
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '保存发生额映射关系成功',
        details: [`模板名：${template.name}`, `规则数：${validatedRules.length}`]
      });

      return {
        status: 'success',
        message: '发生额映射关系保存成功'
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存发生额映射关系',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId, templateName: template?.name || '' },
          templateName: template?.name || ''
        });
      }

      return createErrorResult({
        step: '保存发生额映射关系',
        message: '发生额映射关系保存失败，请导出报错文件查看详情',
        errorCode: 'AMOUNT_SPLIT_RULES_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, templateName: template?.name || '' },
        templateName: template?.name || ''
      });
    }
  });

  // ===== v1.4.9 bill split / merge handlers =====

  ipcMain.handle('template:get-bill-split-config', (_event, templateId) => {
    templateId = Number(templateId);
    try {
      const template = database.getTemplate(templateId);
      if (!template) {
        return createErrorResult({
          step: '读取拆分账单配置',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }
      const fullMapping = database.getTemplateMappings(templateId);
      const billSplitMappings = database.getBillSplitMappings(templateId) || [];
      const billSplitRows = database.getBillSplitRows(templateId) || [];
      const billSplitAmountRules = database.getBillSplitAmountRules(templateId) || [];
      const billSplitMeta = database.getBillSplitMeta(templateId) || { signedAmountSourceField: '' };
      const enabled = ((fullMapping?.mappings || [])
        .find((m) => normalizeCell(m.templateField) === BILL_SPLIT_MERGE_MAPPING_FIELD)?.mappedField || '')
        === BILL_SPLIT_MERGE_ENABLED_OPTION;
      const reuseModule = ((fullMapping?.mappings || [])
        .find((m) => normalizeCell(m.templateField) === REUSE_MODULE_MAPPING_FIELD)?.mappedField || REUSE_MODULE_DEFAULT_OPTION)
        === REUSE_MODULE_DEFAULT_OPTION;
      return {
        status: 'success',
        enabled,
        reuseModule,
        billSplitMappings,
        billSplitRows,
        billSplitAmountRules,
        billSplitMeta
      };
    } catch (error) {
      return createErrorResult({
        step: '读取拆分账单配置',
        message: '读取拆分账单配置失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_CONFIG_READ_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId }
      });
    }
  });

  ipcMain.handle('template:save-bill-split-mappings', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    let template = null;
    try {
      template = database.getTemplate(templateId);
      if (!template) {
        return createErrorResult({
          step: '保存拆分账单字段映射',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }
      const validated = validateBillSplitMappingsPayload(payload.mappings, template);
      database.saveBillSplitMappings(templateId, validated);
      syncTemplateLibraryFile();
      return { status: 'success', message: '拆分账单字段映射保存成功' };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存拆分账单字段映射',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId, templateName: template?.name || '' },
          templateName: template?.name || ''
        });
      }
      return createErrorResult({
        step: '保存拆分账单字段映射',
        message: '拆分账单字段映射保存失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_MAPPINGS_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, templateName: template?.name || '' },
        templateName: template?.name || ''
      });
    }
  });

  ipcMain.handle('template:save-bill-split-row-count', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    const nextN = Number(payload?.nextN);
    try {
      if (!Number.isInteger(nextN) || nextN < 1 || nextN > 99) {
        throw new FileValidationError('FILE_READ', '拆分账单的份数必须为 1 ~ 99 之间的整数');
      }
      database.saveBillSplitRowCount(templateId, nextN);
      const currentRows = database.getBillSplitRows(templateId) || [];
      syncTemplateLibraryFile();
      return { status: 'success', currentRows };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '设置拆分账单行数',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId, nextN }
        });
      }
      return createErrorResult({
        step: '设置拆分账单行数',
        message: '设置拆分账单行数失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_ROW_COUNT_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, nextN }
      });
    }
  });

  ipcMain.handle('template:save-bill-split-row', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    try {
      validateBillSplitRowPayload(payload?.row);
      database.saveBillSplitRow(templateId, payload.row);
      syncTemplateLibraryFile();
      return { status: 'success' };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存拆分账单单行',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId }
        });
      }
      return createErrorResult({
        step: '保存拆分账单单行',
        message: '保存拆分账单单行失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_ROW_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId }
      });
    }
  });

  ipcMain.handle('template:preview-delete-bill-split-row', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    const seqNo = Number(payload?.seqNo);
    try {
      const allRows = database.getBillSplitRows(templateId) || [];
      const target = allRows.find((r) => r.seqNo === seqNo);
      if (!target) {
        return { status: 'success', dissolvedGroups: [] };
      }
      const dissolved = new Set();
      if (target.mergedGroupSeq !== null && target.mergedGroupSeq !== undefined) {
        dissolved.add(Number(target.mergedGroupSeq));
      }
      for (const row of allRows) {
        if (row.mergedGroupSeq !== null && row.mergedGroupSeq !== undefined && row.seqNo >= seqNo && row.seqNo !== seqNo) {
          dissolved.add(Number(row.mergedGroupSeq));
        }
      }
      return { status: 'success', dissolvedGroups: Array.from(dissolved).sort((a, b) => a - b) };
    } catch (error) {
      return createErrorResult({
        step: '预演删除拆分账单行',
        message: '预演删除失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_PREVIEW_DELETE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, seqNo }
      });
    }
  });

  ipcMain.handle('template:delete-bill-split-row', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    const seqNo = Number(payload?.seqNo);
    try {
      const { dissolvedGroups } = database.deleteBillSplitRow(templateId, seqNo);
      const currentRows = database.getBillSplitRows(templateId) || [];
      syncTemplateLibraryFile();
      return { status: 'success', currentRows, dissolvedGroups };
    } catch (error) {
      return createErrorResult({
        step: '删除拆分账单行',
        message: '删除拆分账单行失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_DELETE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, seqNo }
      });
    }
  });

  ipcMain.handle('template:save-bill-split-merge-group', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    const seqNos = Array.isArray(payload?.seqNos) ? payload.seqNos.map(Number) : [];
    try {
      if (seqNos.length < 2) {
        throw new FileValidationError('FILE_READ', '合并账单至少需要选择 2 个账单序号');
      }
      const allRows = database.getBillSplitRows(templateId) || [];
      const candidateSet = new Set(
        allRows
          .filter((row) => row.rowStatus === 'completed' && (row.mergedGroupSeq === null || row.mergedGroupSeq === undefined))
          .map((row) => row.seqNo)
      );
      for (const seqNo of seqNos) {
        if (!candidateSet.has(seqNo)) {
          throw new FileValidationError('FILE_READ', `账单序号 ${seqNo} 不可参与合并（未完成或已属于其它合并组）`);
        }
      }
      database.saveBillSplitMergeGroup(templateId, seqNos);
      syncTemplateLibraryFile();
      return { status: 'success' };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存合并账单组',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId, seqNos }
        });
      }
      return createErrorResult({
        step: '保存合并账单组',
        message: '保存合并账单组失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_MERGE_GROUP_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, seqNos }
      });
    }
  });

  ipcMain.handle('template:clear-bill-split-merge-groups', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    try {
      database.clearBillSplitMergeGroups(templateId);
      syncTemplateLibraryFile();
      return { status: 'success' };
    } catch (error) {
      return createErrorResult({
        step: '清空合并账单组',
        message: '清空合并账单组失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_MERGE_CLEAR_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId }
      });
    }
  });

  ipcMain.handle('template:save-bill-split-amount-rules', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    let template = null;
    try {
      template = database.getTemplate(templateId);
      if (!template) {
        return createErrorResult({
          step: '保存拆分账单发生额规则',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }
      const incomingRules = Array.isArray(payload?.amountSplitRules) ? payload.amountSplitRules : [];
      const existingMeta = database.getBillSplitMeta(templateId) || { signedAmountSourceField: '' };
      if (existingMeta.signedAmountSourceField && incomingRules.length > 0) {
        throw new FileValidationError(
          'FILE_READ',
          '弹框 2 副区域的"按正负号拆分的发生额"和"按字段区分发生额"只能启用其中一种'
        );
      }
      const validated = incomingRules.length === 0
        ? []
        : validateBillSplitAmountRulesPayload(incomingRules, template);
      database.saveBillSplitAmountRules(templateId, validated);
      syncTemplateLibraryFile();
      return { status: 'success' };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存拆分账单发生额规则',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId, templateName: template?.name || '' },
          templateName: template?.name || ''
        });
      }
      return createErrorResult({
        step: '保存拆分账单发生额规则',
        message: '保存拆分账单发生额规则失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_AMOUNT_RULES_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, templateName: template?.name || '' },
        templateName: template?.name || ''
      });
    }
  });

  ipcMain.handle('template:save-bill-split-meta', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    try {
      const signedAmountSourceField = normalizeCell(payload?.signedAmountSourceField);
      const existingRules = database.getBillSplitAmountRules(templateId) || [];
      if (signedAmountSourceField && existingRules.length > 0) {
        throw new FileValidationError(
          'FILE_READ',
          '弹框 2 副区域的"按正负号拆分的发生额"和"按字段区分发生额"只能启用其中一种'
        );
      }
      database.saveBillSplitMeta(templateId, {
        signedAmountSourceField,
        signedAmountTargetSeqNos: payload.signedAmountTargetSeqNos || [],
        byFieldAmountTargetSeqNos: payload.byFieldAmountTargetSeqNos || []
      });
      syncTemplateLibraryFile();
      return { status: 'success' };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存拆分账单按正负号拆分字段',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId }
        });
      }
      return createErrorResult({
        step: '保存拆分账单按正负号拆分字段',
        message: '保存拆分账单按正负号拆分字段失败，请导出报错文件查看详情',
        errorCode: 'BILL_SPLIT_META_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId }
      });
    }
  });
}

function validateBillSplitMappingsPayload(mappings, template) {
  if (!Array.isArray(mappings)) {
    throw new FileValidationError('FILE_READ', '弹框 1 字段映射格式错误');
  }
  const sourceFieldSet = new Set((template.headers || []).map((header) => normalizeCell(header)));
  const seenFields = new Set();
  const normalized = [];
  mappings.forEach((mapping, index) => {
    const templateField = normalizeCell(mapping?.templateField);
    if (!templateField) {
      return;
    }
    if (templateField === 'Currency' || templateField === 'Credit Amount' || templateField === 'Debit Amount') {
      throw new FileValidationError(
        'FILE_READ',
        '弹框 1 不允许映射 Currency / Credit Amount / Debit Amount，请在弹框 2 中配置'
      );
    }
    if (seenFields.has(templateField)) {
      throw new FileValidationError('FILE_READ', `弹框 1 中模板字段「${templateField}」重复`);
    }
    seenFields.add(templateField);
    const mappedField = normalizeCell(mapping?.mappedField);
    const mappedFields = Array.from(
      new Set(
        (Array.isArray(mapping?.mappedFields) ? mapping.mappedFields : [])
          .map((value) => normalizeCell(value))
          .filter((value) => value !== '')
      )
    );
    if (!mappedField && mappedFields.length === 0) {
      return;
    }
    // Balance 字段允许特殊值（BALANCE_DISABLED_OPTION / BALANCE_CALCULATED_OPTION），
    // 与主表格保持一致
    const isBalanceSpecialValue = templateField === 'Balance'
      && (mappedField === BALANCE_DISABLED_OPTION || mappedField === BALANCE_CALCULATED_OPTION);
    // Header existence check (allow concat marker + custom prefix to pass)
    const checkSourceFieldExists = (field) => {
      if (!field) return;
      if (field === CONCAT_FIELDS_MAPPING_FIELD) return;
      if (typeof field === 'string' && field.startsWith(FIXED_FIELD_VALUE_PREFIX)) return;
      if (!sourceFieldSet.has(field)) {
        throw new FileValidationError('FILE_READ', `映射字段不存在：${field}`);
      }
    };
    if (mappedField !== CONCAT_FIELDS_MAPPING_FIELD && !isBalanceSpecialValue) {
      checkSourceFieldExists(mappedField);
    }
    mappedFields.forEach(checkSourceFieldExists);
    normalized.push({
      templateField,
      mappedField,
      mappedFields,
      rowIndex: Number.isInteger(mapping?.rowIndex) ? mapping.rowIndex : index
    });
  });
  return normalized;
}

function validateBillSplitRowPayload(row) {
  if (!row || !Number.isInteger(Number(row?.seqNo)) || Number(row.seqNo) < 1) {
    throw new FileValidationError('FILE_READ', '拆分账单行数据格式错误');
  }
  const credit = normalizeCell(row?.creditSourceField);
  const debit = normalizeCell(row?.debitSourceField);
  if (credit && debit && credit === debit) {
    throw new FileValidationError(
      'FILE_READ',
      '同一份拆分账单的 Credit Amount 和 Debit Amount 不能是同一列'
    );
  }
  if (row.rowStatus !== undefined && row.rowStatus !== 'draft' && row.rowStatus !== 'completed') {
    throw new FileValidationError('FILE_READ', '拆分账单行状态值非法');
  }
}

function validateBillSplitAmountRulesPayload(rules, template) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return [];
  }
  const sourceFieldSet = new Set((template.headers || []).map((header) => normalizeCell(header)));
  const expectedTargets = new Set(['Credit Amount', 'Debit Amount']);
  return rules.map((rule, index) => {
    const targetField = normalizeCell(rule?.targetField);
    const conditionField = normalizeCell(rule?.conditionField);
    const conditionValue = normalizeCell(rule?.conditionValue);
    const mappedField = normalizeCell(rule?.mappedField);
    if (!expectedTargets.has(targetField)) {
      throw new FileValidationError('FILE_READ', '目标字段必须是 Credit Amount 或 Debit Amount');
    }
    if (!conditionField) {
      throw new FileValidationError('FILE_READ', '判断字段不能为空');
    }
    if (!sourceFieldSet.has(conditionField)) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${conditionField}`);
    }
    if (conditionValue === '') {
      throw new FileValidationError('FILE_READ', '判断字段值不能为空');
    }
    if (isRegexLiteral(conditionValue)) {
      try {
        compileRegexLiteral(conditionValue);
      } catch (_error) {
        throw new FileValidationError('FILE_READ', `正则表达式语法错误：${conditionValue}`);
      }
    }
    if (!mappedField) {
      throw new FileValidationError('FILE_READ', '发生额字段不能为空');
    }
    if (!sourceFieldSet.has(mappedField)) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${mappedField}`);
    }
    return {
      targetField,
      conditionField,
      conditionValue,
      mappedField,
      rowIndex: Number.isInteger(rule?.rowIndex) ? rule.rowIndex : index
    };
  });
}

function validateAmountSplitRulesPayload(rules, template) {
  if (!Array.isArray(rules) || rules.length !== 2) {
    throw new FileValidationError('FILE_READ', '请同时配置 Credit Amount 与 Debit Amount 两行规则');
  }

  const sourceFieldSet = new Set((template.headers || []).map((header) => normalizeCell(header)));
  const expectedTargets = new Set(['Credit Amount', 'Debit Amount']);
  const seenTargets = new Set();
  const normalized = rules.map((rule, index) => {
    const targetField = normalizeCell(rule?.targetField);
    const conditionField = normalizeCell(rule?.conditionField);
    const conditionValue = normalizeCell(rule?.conditionValue);
    const mappedField = normalizeCell(rule?.mappedField);

    if (!expectedTargets.has(targetField)) {
      throw new FileValidationError('FILE_READ', '目标字段必须是 Credit Amount 或 Debit Amount');
    }

    if (seenTargets.has(targetField)) {
      throw new FileValidationError('FILE_READ', `目标字段 ${targetField} 重复`);
    }

    seenTargets.add(targetField);

    if (!conditionField) {
      throw new FileValidationError('FILE_READ', '判断字段不能为空');
    }

    if (!sourceFieldSet.has(conditionField)) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${conditionField}`);
    }

    if (conditionValue === '') {
      throw new FileValidationError('FILE_READ', '判断字段值不能为空');
    }

    if (isRegexLiteral(conditionValue)) {
      try {
        compileRegexLiteral(conditionValue);
      } catch (_error) {
        throw new FileValidationError('FILE_READ', `正则表达式语法错误：${conditionValue}`);
      }
    }

    if (!mappedField) {
      throw new FileValidationError('FILE_READ', '发生额字段不能为空');
    }

    if (!sourceFieldSet.has(mappedField)) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${mappedField}`);
    }

    if (conditionField === mappedField) {
      throw new FileValidationError('FILE_READ', '条件字段与目标字段不能相同');
    }

    return {
      targetField,
      conditionField,
      conditionValue,
      mappedField,
      rowIndex: Number.isInteger(rule?.rowIndex) ? rule.rowIndex : index
    };
  });

  if (seenTargets.size !== 2) {
    throw new FileValidationError('FILE_READ', '必须同时设置 Credit Amount 与 Debit Amount 两个目标字段');
  }

  return normalized;
}

function buildMappedFieldLookup(mappings) {
  return mappings.reduce((accumulator, mapping) => {
    const mappedFields = getMappingFieldValues(mapping);
    const isConcatMode = normalizeCell(mapping.mappedField) === CONCAT_FIELDS_MAPPING_FIELD;
    accumulator[mapping.templateField] = isConcatMode
      ? (Array.isArray(mapping.mappedFields) && mapping.mappedFields.length ? mapping.mappedFields : mappedFields)
      : mappedFields.length > 1
        ? mappedFields
        : getPrimaryMappedField(mapping);
    return accumulator;
  }, {});
}

function normalizeLookupMappingValue(value) {
  if (Array.isArray(value)) {
    return normalizeCell(value[0]);
  }

  return normalizeCell(value);
}

function buildStatementGenerationConfig({
  template,
  mappings,
  orderedTargetFields,
  selectedBigAccount = null,
  allowManagedMerchantWithoutSelection = false
}) {
  const selectedMappings = mappings.filter((mapping) => {
    if (mapping.templateField === 'Balance') {
      return mapping.mappedField && mapping.mappedField !== BALANCE_DISABLED_OPTION;
    }

    return mapping.mappedField !== '';
  });
  const selectedExportMappings = selectedMappings.filter((mapping) => {
    return !ADVANCED_MAPPING_FIELDS.includes(mapping.templateField);
  });

  if (!selectedExportMappings.length) {
    throw new FileValidationError('FILE_READ', '当前模板尚未设置映射关系');
  }

  const mappingByTargetField = buildMappedFieldLookup(selectedMappings);
  const templateNameParts = splitTemplateName(template.name);
  const selectedMerchantId = normalizeCell(selectedBigAccount?.merchantId);
  const selectedCurrency = normalizeCell(selectedBigAccount?.currency);
  const merchantIdMappingValue = normalizeLookupMappingValue(mappingByTargetField.MerchantId);
  const currencyMappingValue = normalizeLookupMappingValue(mappingByTargetField.Currency);
  const isMultiBigAccountTemplate = merchantIdMappingValue
    === `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`;

  if (orderedTargetFields.includes('Channel')) {
    mappingByTargetField.Channel = `${FIXED_FIELD_VALUE_PREFIX}${templateNameParts.bankName}`;
  }

  if (!mappingByTargetField.BillDate || (Array.isArray(mappingByTargetField.BillDate) && !mappingByTargetField.BillDate.length)) {
    throw new FileValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
  }

  if (isMultiBigAccountTemplate && !selectedMerchantId && !allowManagedMerchantWithoutSelection) {
    throw new FileValidationError('FILE_READ', '当前模板存在多个大账号，请先选择本次使用的大账号');
  }

  let currencyMappings = [];

  if (
    (Array.isArray(mappingByTargetField.Currency) ? mappingByTargetField.Currency.length > 0 : Boolean(currencyMappingValue)) &&
    !selectedCurrency &&
    !currencyMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)
  ) {
    const currencyMappingTablePath = getCurrencyMappingTablePath();

    if (!fs.existsSync(currencyMappingTablePath)) {
      throw new FileValidationError('FILE_READ', '未找到币种映射表，请确认文件已放入 assets 目录');
    }

    currencyMappings = loadCurrencyMappings(currencyMappingTablePath);
  }

  const exportTargetFields = Array.from(
    new Set(
      (orderedTargetFields || mappings.map((mapping) => mapping.templateField))
        .map((fieldName) => normalizeCell(fieldName))
        .filter((fieldName) => fieldName !== '')
    )
  );

  const accountMappingByBankId = database.listAccountMappings(template.id).reduce((accumulator, mapping) => {
    accumulator[mapping.bankAccountId] = {
      clearingAccountId: mapping.clearingAccountId,
      noCurrency: Boolean(mapping.noCurrency),
      currency: mapping.currency || ''
    };
    return accumulator;
  }, {});

  const amountSplitByFieldConfig = buildAmountSplitByFieldConfig(template, selectedMappings);
  const billSplitMergeConfig = buildBillSplitMergeConfig(template, selectedMappings);

  return {
    template,
    mappingByTargetField,
    selectedMerchantId,
    selectedCurrency,
    balanceRequested: Boolean(mappingByTargetField.Balance),
    balanceMode: mappingByTargetField.Balance === BALANCE_CALCULATED_OPTION ? 'calculated' : 'statement',
    exportTargetFields,
    accountMappingByBankId,
    currencyMappings,
    amountMappingRules: {
      signedAmountSourceField: mappingByTargetField[SIGNED_AMOUNT_MAPPING_FIELD],
      nameSourceField: mappingByTargetField[AMOUNT_BASED_NAME_MAPPING_FIELD],
      accountSourceField: mappingByTargetField[AMOUNT_BASED_ACCOUNT_MAPPING_FIELD]
    },
    amountSplitByField: amountSplitByFieldConfig,
    billSplitMerge: billSplitMergeConfig,
    dateParseOrder: template.dateFormat || 'auto'
  };
}

function buildBillSplitMergeConfig(template, selectedMappings) {
  const enabled = selectedMappings.some((mapping) => {
    return normalizeCell(mapping.templateField) === BILL_SPLIT_MERGE_MAPPING_FIELD
      && normalizeCell(mapping.mappedField) === BILL_SPLIT_MERGE_ENABLED_OPTION;
  });

  if (!enabled || !template || !template.id) {
    return { enabled: false };
  }

  // Default reuseModuleMapping = true (PRD §Q-A4 / TechDoc §3.4.7)
  const reuseModuleMapping = !selectedMappings.some((mapping) => {
    return normalizeCell(mapping.templateField) === REUSE_MODULE_MAPPING_FIELD
      && normalizeCell(mapping.mappedField) === '否';
  });

  const billSplitMappings = (database.getBillSplitMappings(template.id) || []).map((mapping) => ({
    rowIndex: Number(mapping.rowIndex || 0),
    templateField: normalizeCell(mapping.templateField),
    mappedField: normalizeCell(mapping.mappedField),
    mappedFields: Array.isArray(mapping.mappedFields)
      ? mapping.mappedFields.map((value) => normalizeCell(value)).filter((value) => value !== '')
      : []
  }));

  // P1 Fix A (PR #16 review): 预先构造 billSplit 字段映射的 target→field lookup。
  // 当 reuseModuleMapping === false 时，file-service 会用这个 lookup 替代主模板的
  // mappingByField 重新计算每个拆分行的非金额字段，使弹框 1 配置真正生效。
  const billSplitMappingByTargetField = buildMappedFieldLookup(
    billSplitMappings.filter((m) => m.templateField)
  );

  // P1 Fix B (PR #16 review): 导出阶段只传 row_status = completed 的拆分行。
  // draft 行保留在 DB 作为"草稿"供用户下次打开弹框继续编辑，但不参与导出。
  // 对应 PRD §4.3.5 Q-C12 / ACI-1（"至少 1 行 completed 才展开"）。
  const billSplitRows = (database.getBillSplitRows(template.id) || [])
    .filter((row) => row.rowStatus === 'completed')
    .map((row) => ({
      seqNo: Number(row.seqNo),
      currencySourceField: normalizeCell(row.currencySourceField),
      creditSourceField: normalizeCell(row.creditSourceField),
      debitSourceField: normalizeCell(row.debitSourceField),
      amountSourceField: normalizeCell(row.amountSourceField),
      rowStatus: 'completed',
      mergedGroupSeq: row.mergedGroupSeq === null || row.mergedGroupSeq === undefined
        ? null
        : Number(row.mergedGroupSeq)
    }));

  const billSplitAmountRules = (database.getBillSplitAmountRules(template.id) || []).map((rule) => ({
    targetField: normalizeCell(rule.targetField),
    conditionField: normalizeCell(rule.conditionField),
    conditionValue: normalizeCell(rule.conditionValue),
    mappedField: normalizeCell(rule.mappedField),
    rowIndex: Number(rule.rowIndex || 0)
  }));

  const meta = database.getBillSplitMeta(template.id) || {};
  const signedAmountSourceField = normalizeCell(meta.signedAmountSourceField);
  const signedAmountTargetSeqNos = Array.isArray(meta.signedAmountTargetSeqNos) ? meta.signedAmountTargetSeqNos : [];
  const byFieldAmountTargetSeqNos = Array.isArray(meta.byFieldAmountTargetSeqNos) ? meta.byFieldAmountTargetSeqNos : [];

  return {
    enabled: true,
    reuseModuleMapping,
    billSplitMappings,
    billSplitMappingByTargetField,  // P1 Fix A (PR #16 review)
    billSplitRows,
    billSplitAmountRules,
    signedAmountSourceField,
    signedAmountTargetSeqNos,
    byFieldAmountTargetSeqNos
  };
}

function buildAmountSplitByFieldConfig(template, selectedMappings) {
  const enabled = selectedMappings.some((mapping) => {
    return normalizeCell(mapping.templateField) === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD
      && normalizeCell(mapping.mappedField) === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;
  });

  if (!enabled || !template || !template.id) {
    return { enabled: false, rules: [] };
  }

  const rules = (database.getAmountSplitRules(template.id) || [])
    .map((rule) => ({
      targetField: normalizeCell(rule.targetField),
      conditionField: normalizeCell(rule.conditionField),
      conditionValue: normalizeCell(rule.conditionValue),
      mappedField: normalizeCell(rule.mappedField),
      rowIndex: Number(rule.rowIndex || 0)
    }))
    .filter((rule) => rule.targetField && rule.conditionField && rule.mappedField);

  return {
    enabled: true,
    rules
  };
}

function buildMappedRowsForFile({
  config,
  inputFilePath
}) {
  return buildMappedRows({
    inputFilePath,
    orderedTargetFields: config.exportTargetFields,
    mappingByField: config.mappingByTargetField,
    accountMappingByBankId: config.accountMappingByBankId,
    currencyMappings: config.currencyMappings,
    amountMappingRules: config.amountMappingRules,
    amountSplitByField: config.amountSplitByField,
    billSplitMerge: config.billSplitMerge,
    expectedSourceHeaders: config.template.headers,
    selectedBigAccount: {
      merchantId: config.selectedMerchantId,
      currency: config.selectedCurrency
    },
    dateParseOrder: config.dateParseOrder
  });
}

const statementGenerationHelpers = createStatementGenerationHelpers({
  appendActivityLogEntry,
  appendLog,
  buildDateRangeLabel,
  buildFieldIndexMap,
  buildImportWarningDetailLines,
  buildImportWarningMessage,
  buildManualBalanceRequiredResult,
  buildMappedRowsForFile,
  buildStatementGenerationConfig,
  buildStatementOutputFilePath,
  cloneRowsWithMetadata,
  createErrorResult,
  createWarningResult,
  deriveBalanceRecords,
  ensureStorageRoot,
  extractHeaders,
  FileValidationError,
  findPreviousBalanceSeed,
  generateStatementFiles,
  getBalanceTemplatePath,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeCell,
  normalizeInputFilePaths,
  parseRequiredBillDates,
  resolveSinglePreparedFieldValue,
  splitTemplateName,
  storeGeneratedBalanceSeeds,
  writeBalanceWorkbook,
  writeWorkbookRows
});

function buildPreparedStatementBatchFromEntries({ config, fileEntries = [] }) {
  return statementGenerationHelpers.buildPreparedStatementBatchFromEntries({ config, fileEntries });
}

function buildPreparedStatementBatchFromFilePaths({ config, inputFilePaths = [] }) {
  return statementGenerationHelpers.buildPreparedStatementBatchFromFilePaths({ config, inputFilePaths });
}

function generateStatementFiles({
  config,
  preparedBatch,
  scope = 'current',
  includeDetail = true,
  includeBalance = null
}) {
  const warnings = Array.isArray(preparedBatch.warnings) ? preparedBatch.warnings.slice() : [];
  const detailRows = cloneRowsWithMetadata(preparedBatch.detailRows);
  const detailExportRows = buildDetailExportRows(detailRows);
  const effectiveDetailRows = Array.isArray(detailExportRows.sourceRows) ? detailExportRows.sourceRows : detailRows;
  const skippedDetailRows = Array.isArray(detailExportRows.skippedRows) ? detailExportRows.skippedRows : [];
  const simultaneousAmountRows = Array.isArray(detailExportRows.simultaneousRows)
    ? detailExportRows.simultaneousRows
    : [];

  if (simultaneousAmountRows.length) {
    throw new FileValidationError(
      'FILE_READ',
      `存在${simultaneousAmountRows.length}条明细的 Credit Amount 与 Debit Amount 同时有值`,
      {
        detailLines: simultaneousAmountRows.map((row) => {
          return `第${row.sourceRowNumber}行，Credit Amount="${row.creditAmount || '(空)'}"，Debit Amount="${row.debitAmount || '(空)'}"`;
        }),
        context: {
          inputFilePath: preparedBatch.inputFilePaths.join(';'),
          templateName: config.template.name
        }
      }
    );
  }

  skippedDetailRows.forEach((row) => {
    warnings.push({
      type: 'detail-row-skipped',
      rowNumber: row.sourceRowNumber,
      creditAmount: row.creditAmount,
      debitAmount: row.debitAmount
    });
  });

  const billDates = detailExportRows.length > 1
    ? parseRequiredBillDates(detailExportRows)
    : parseRequiredBillDates(detailRows);
  const dateRangeLabel = buildDateRangeLabel(billDates);
  const internalSuffix = scope === 'all' ? 'all' : '';
  const outputMerchantId = scope === 'all' ? '' : preparedBatch.selectedMerchantId;

  const result = {
    detail: null,
    balance: null,
    message: includeDetail && includeBalance !== true ? '明细账单可导出' : '',
    warnings,
    balanceRequested: Boolean(preparedBatch.balanceRequested),
    unmatchedAmountSplitFiles: Array.isArray(preparedBatch.unmatchedAmountSplitFiles)
      ? preparedBatch.unmatchedAmountSplitFiles.slice()
      : [],
    // v1.4.9 PR #16 review P1 Fix C: 平行于 unmatchedAmountSplitFiles 的 bill-split 版本
    unmatchedBillSplitFiles: Array.isArray(preparedBatch.unmatchedBillSplitFiles)
      ? preparedBatch.unmatchedBillSplitFiles.slice()
      : []
  };

  if (includeDetail) {
    const detailOutput = buildStatementOutputFilePath({
      kind: 'detail',
      templateName: config.template.name,
      merchantId: outputMerchantId,
      outputTag: 'COMMON',
      dateRangeLabel,
      internalSuffix
    });

    writeWorkbookRows({
      rows: detailExportRows,
      outputFilePath: detailOutput.outputFilePath
    });

    result.detail = {
      filePath: detailOutput.outputFilePath,
      fileName: detailOutput.outputFileName,
      templateName: config.template.name
    };
  }

  const shouldGenerateBalance = includeBalance === null
    ? Boolean(preparedBatch.balanceRequested)
    : Boolean(includeBalance) && Boolean(preparedBatch.balanceRequested);

  if (shouldGenerateBalance) {
    if (!config.mappingByTargetField.MerchantId) {
      throw new FileValidationError('FILE_READ', '当前模板启用 Balance 时必须映射 MerchantId 字段');
    }

    let balanceSeedStatus = {
      missing: 0,
      missingIndexByKey: new Map()
    };

    try {
      const balanceTemplatePath = getBalanceTemplatePath();

      if (!fs.existsSync(balanceTemplatePath)) {
        throw new FileValidationError('FILE_READ', '未找到余额账单模板，请确认文件已放入 assets 目录');
      }

      const balanceTemplateFields = extractHeaders(balanceTemplatePath);

      if (!balanceTemplateFields.length) {
        throw new FileValidationError('FILE_READ', '余额账单模板为空或不可读，请重新确认');
      }

      balanceSeedStatus = scanBalanceSeedStatus({
        detailRows: effectiveDetailRows,
        templateName: config.template.name
      });

      const templateBankName = splitTemplateName(config.template.name).bankName;
      const balanceAdjustments = readBalanceAdjustments(ensureStorageRoot(), templateBankName);

      const balanceResult = deriveBalanceRecords({
        detailRows: effectiveDetailRows,
        templateName: config.template.name,
        balanceTemplateFields,
        mode: preparedBatch.balanceMode,
        balanceAdjustments,
        resolvePreviousEndBalance: ({ bankName, merchantId, currency, targetBillDate }) => {
          const seedRecord = findPreviousBalanceSeed(ensureStorageRoot(), {
            bankName,
            merchantId,
            currency,
            beforeBillDate: targetBillDate
          });

          return seedRecord ? seedRecord.endBalance : null;
        }
      });
      const balanceOutput = buildStatementOutputFilePath({
        kind: 'balance',
        templateName: config.template.name,
        merchantId: outputMerchantId,
        outputTag: 'BALANCE',
        dateRangeLabel: buildDateRangeLabel(balanceResult.billDates),
        internalSuffix
      });

      writeBalanceWorkbook({
        templateFilePath: balanceTemplatePath,
        records: balanceResult.records,
        templateFields: balanceTemplateFields,
        outputFilePath: balanceOutput.outputFilePath
      });
      storeGeneratedBalanceSeeds({
        templateName: config.template.name,
        seedRecords: balanceResult.seedRecords
      });

      result.balance = {
        filePath: balanceOutput.outputFilePath,
        fileName: balanceOutput.outputFileName,
        templateName: config.template.name
      };
      result.message = includeDetail ? '明细账单可导出，余额账单可导出' : '余额账单可导出';
    } catch (error) {
      if (error instanceof FileValidationError) {
        if (error.code === 'BALANCE_SEED_REQUIRED') {
          const promptMerchantId = normalizeCell(error.context?.merchantId);
          const promptCurrency = normalizeCell(error.context?.currency);
          const promptKey = `${promptMerchantId}@@${promptCurrency}`;
          const queueIndex = balanceSeedStatus.missingIndexByKey?.get(promptKey) || 1;
          const queueTotal = balanceSeedStatus.missing || 1;

          warnings.push({
            type: 'balance-seed-required',
            message: error.message,
            prompt: {
              templateName: config.template.name,
              bankName: error.context?.bankName || splitTemplateName(config.template.name).bankName,
              merchantId: promptMerchantId,
              currency: promptCurrency,
              targetBillDate: normalizeCell(error.context?.targetBillDate),
              queueIndex,
              queueTotal
            }
          });
        } else {
          warnings.push({
            type: 'balance-generate-failed',
            message: error.message
          });
        }
      } else {
        const logPath = appendLog(ensureStorageRoot(), error);
        warnings.push({
          type: 'balance-generate-failed',
          message: '余额账单生成失败，系统异常已写入日志文件',
          logPath
        });
      }
    }
  }

  return result;
}

// v1.5.2 #9 修复：按文件名映射模板导入多个文件匹配不同模板时，按 matchedTemplateId 分组，
// 每组独立生成明细+余额文件，确保余额账单的银行名称/所在地使用各自模板的值。
// v1.5.2：合并多组生成的 xlsx 文件（直接操作单元格，保留日期/数字格式）
function mergeGeneratedXlsxFiles(filePaths, mergedOutputPath) {
  if (!filePaths.length) return null;
  if (filePaths.length === 1) {
    fs.copyFileSync(filePaths[0], mergedOutputPath);
    return mergedOutputPath;
  }
  // v1.5.3 R3：合并路径局部使用 xlsx-js-style，确保读回 + 写出都能保留单元格样式（cell.s）
  // 全局 XLSX（require('xlsx')）的 writeFile 会丢 s 字段；此处 shadow 到 xlsx-js-style
  const XLSXStyle = require('xlsx-js-style');
  // 以第一个文件为基础，追加其他文件的数据行
  const baseWb = XLSXStyle.readFile(filePaths[0], { cellNF: true, cellStyles: true, raw: true });
  const baseSheetName = baseWb.SheetNames[0];
  const baseWs = baseWb.Sheets[baseSheetName];
  const baseRange = XLSXStyle.utils.decode_range(baseWs['!ref'] || 'A1');
  let nextRow = baseRange.e.r + 1;
  let maxCol = baseRange.e.c;

  for (let fi = 1; fi < filePaths.length; fi++) {
    if (!fs.existsSync(filePaths[fi])) continue;
    const wb = XLSXStyle.readFile(filePaths[fi], { cellNF: true, cellStyles: true, raw: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const range = XLSXStyle.utils.decode_range(ws['!ref'] || 'A1');
    if (range.e.c > maxCol) maxCol = range.e.c;
    // 合并 !cols 元数据（取较长的数组）
    if (Array.isArray(ws['!cols']) && (!baseWs['!cols'] || ws['!cols'].length > baseWs['!cols'].length)) {
      baseWs['!cols'] = ws['!cols'];
    }
    // 跳过表头（r=0），从 r=1 开始复制数据行
    for (let r = 1; r <= range.e.r; r++) {
      for (let c = 0; c <= maxCol; c++) {
        const srcAddr = XLSXStyle.utils.encode_cell({ r, c });
        const dstAddr = XLSXStyle.utils.encode_cell({ r: nextRow, c });
        const cell = ws[srcAddr];
        if (cell) {
          baseWs[dstAddr] = { ...cell };
        }
      }
      nextRow++;
    }
  }
  // 更新 sheet range（用全局最大列数）
  baseWs['!ref'] = XLSXStyle.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: nextRow - 1, c: maxCol }
  });
  // v1.5.3 R3：合并后重新给表头注入 Courier New（读回 + 浅拷贝可能丢 s.font.name，兜底补注入）
  for (let c = 0; c <= maxCol; c++) {
    const addr = XLSXStyle.utils.encode_cell({ r: 0, c });
    const cell = baseWs[addr];
    if (!cell) continue;
    const existingStyle = cell.s || {};
    const existingFont = existingStyle.font || {};
    cell.s = {
      ...existingStyle,
      font: { ...existingFont, name: 'Courier New' }
    };
  }
  fs.mkdirSync(path.dirname(mergedOutputPath), { recursive: true });
  XLSXStyle.writeFile(baseWb, mergedOutputPath);
  return mergedOutputPath;
}

// v1.5.2：虚拟 ID 下从 session 重新生成合并的余额文件（补录 seed 后调用）
function regenerateVirtualTemplateBalanceFromSession(session, scope = 'all') {
  const allEntries = getStatementSessionEntries(session, scope);
  const groupMap = new Map();
  for (const entry of allEntries) {
    const tid = entry.matchedTemplateId || 0;
    if (!groupMap.has(tid)) groupMap.set(tid, []);
    groupMap.get(tid).push(entry);
  }

  const balancePaths = [];
  const billDates = [];
  const allWarnings = [];
  let skippedCount = 0;

  for (const [tid, groupEntries] of groupMap) {
    const templateConfig = getTemplateMappingConfig(tid);
    if (!templateConfig) {
      appendActivityLogEntry({
        level: 'warn',
        message: `余额重新生成时跳过模板组（templateId=${tid}）：模板已被删除，${groupEntries.length} 个文件的数据未包含`
      });
      skippedCount += 1;
      continue;
    }

    const groupGenConfig = buildStatementGenerationConfig({
      template: templateConfig.template,
      mappings: templateConfig.exportMappings,
      orderedTargetFields: templateConfig.exportTargetFields,
      allowManagedMerchantWithoutSelection: true
    });
    const groupPreparedBatch = buildPreparedStatementBatchFromEntries({
      config: groupGenConfig,
      fileEntries: groupEntries
    });
    const groupGeneratedFiles = generateStatementFiles({
      config: groupGenConfig,
      preparedBatch: groupPreparedBatch,
      scope: 'all',
      includeDetail: false,
      includeBalance: true
    });
    if (groupGeneratedFiles.balance) balancePaths.push(groupGeneratedFiles.balance.filePath);
    if (Array.isArray(groupGeneratedFiles.warnings)) allWarnings.push(...groupGeneratedFiles.warnings);
    try {
      billDates.push(...parseRequiredBillDates(groupPreparedBatch.detailRows));
    } catch (_ignored) {}
  }

  // 如果还有 group 需要 seed → 返回 prompt
  const seedWarning = extractManualBalancePromptWarning(allWarnings);
  if (seedWarning) {
    return { needsSeed: true, prompt: seedWarning.prompt, warnings: allWarnings };
  }

  // 合并
  let mergedBalance = null;
  if (balancePaths.length > 1) {
    const dateRange = buildDateRangeLabel(billDates);
    const mergedFileName = `${groupMap.size}-BALANCE-${dateRange || getToday()}.xlsx`;
    const { outputFilePath: mergedPath } = buildOutputFilePath({ kind: 'balance', outputFileName: mergedFileName });
    mergeGeneratedXlsxFiles(balancePaths, mergedPath);
    mergedBalance = { filePath: mergedPath, fileName: mergedFileName, templateName: '按文件名映射模板' };
  } else if (balancePaths.length === 1) {
    mergedBalance = { filePath: balancePaths[0], fileName: path.basename(balancePaths[0]), templateName: '按文件名映射模板' };
  }

  // 模板被删时加 warning：全删 → 生成失败；部分删 → 数据不完整提示
  if (!mergedBalance && !allWarnings.length) {
    allWarnings.push({
      type: 'balance-generate-failed',
      message: '余额账单未生成：所有模板均已被删除或无法加载'
    });
  } else if (mergedBalance && skippedCount > 0) {
    allWarnings.push({
      type: 'balance-generate-failed',
      message: `余额账单已生成但数据不完整：${skippedCount} 组模板已被删除，对应文件的余额未包含`
    });
  }

  return {
    needsSeed: false,
    generatedFiles: {
      detail: null,
      balance: mergedBalance,
      message: mergedBalance ? '余额账单可导出' : '',
      warnings: allWarnings,
      balanceRequested: balancePaths.length > 0 || allWarnings.some((w) => w.type === 'balance-seed-required' || w.type === 'balance-generate-failed')
    }
  };
}

function generateMultiTemplateGroupFiles({
  fileEntries,
  fallbackTemplateConfig,
  selectedBigAccount,
  session,
  replacePaths,
  inputFilePaths
}) {
  // 按 matchedTemplateId 分组
  const groupMap = new Map();
  for (const entry of fileEntries) {
    const tid = entry.matchedTemplateId || 0;
    if (!groupMap.has(tid)) {
      groupMap.set(tid, []);
    }
    groupMap.get(tid).push(entry);
  }

  // 清理待替换的旧文件 session entries
  if (Array.isArray(replacePaths)) {
    replacePaths.forEach((filePath) => {
      removeStatementSessionEntriesByFilePath(session, filePath);
    });
  }

  let lastBatchId = null;
  let lastGenerationTemplateConfig = null;
  const allDetailPaths = [];
  const allBalancePaths = [];
  const allFileEntries = [];
  const allBillDates = [];
  const allWarnings = [];

  for (const [, groupEntries] of groupMap) {
    const groupTemplateConfig = getEntryTemplateConfig({
      entry: groupEntries[0],
      fallbackTemplateConfig
    });

    const groupMerchantMapping = (groupTemplateConfig.exportMappings || []).find(
      (m) => normalizeCell(m.templateField) === 'MerchantId'
    );
    const groupIsMultiBigAccount = normalizeCell(groupMerchantMapping?.mappedField)
      === `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`;

    const groupConfig = buildStatementGenerationConfig({
      template: groupTemplateConfig.template,
      mappings: groupTemplateConfig.exportMappings,
      orderedTargetFields: groupTemplateConfig.exportTargetFields,
      selectedBigAccount: groupIsMultiBigAccount ? selectedBigAccount : null,
      allowManagedMerchantWithoutSelection: true
    });

    // 步骤 8 路径（selectedBigAccount 有值）：entries 来自步骤 3，MerchantId 未注入，需 rebuild
    // 大账号选择路径（selectedBigAccount 为 null）：entries 已由 applyBigAccountAssignments 注入，不 rebuild
    const effectiveEntries = selectedBigAccount
      ? rebuildMatchedTemplateFileEntries({
          fileEntries: groupEntries,
          fallbackTemplateConfig: groupTemplateConfig,
          selectedBigAccount
        })
      : groupEntries;

    const groupPreparedBatch = buildPreparedStatementBatchFromEntries({
      config: groupConfig,
      fileEntries: effectiveEntries
    });

    const groupGeneratedFiles = {
      ...generateStatementFiles({ config: groupConfig, preparedBatch: groupPreparedBatch, scope: 'current' }),
      fileEntries: effectiveEntries,
      preparedBatch: groupPreparedBatch
    };

    if (groupGeneratedFiles.detail) allDetailPaths.push(groupGeneratedFiles.detail.filePath);
    if (groupGeneratedFiles.balance) allBalancePaths.push(groupGeneratedFiles.balance.filePath);
    if (Array.isArray(groupGeneratedFiles.warnings)) allWarnings.push(...groupGeneratedFiles.warnings);
    try {
      const dates = parseRequiredBillDates(groupPreparedBatch.detailRows);
      allBillDates.push(...dates);
    } catch (_ignored) {}

    lastGenerationTemplateConfig = groupTemplateConfig;
    allFileEntries.push(...effectiveEntries);
  }

  // 合并多组文件为汇总文件，命名：模板数量-COMMON/BALANCE-日期范围.xlsx
  const templateCount = groupMap.size;
  const dateRangeLabel = buildDateRangeLabel(allBillDates);

  const mergedDetail = allDetailPaths.length > 1
    ? (() => {
        const mergedFileName = `${templateCount}-COMMON-${dateRangeLabel || getToday()}.xlsx`;
        const { outputFilePath: mergedPath } = buildOutputFilePath({ kind: 'detail', outputFileName: mergedFileName });
        mergeGeneratedXlsxFiles(allDetailPaths, mergedPath);
        return { filePath: mergedPath, fileName: mergedFileName, templateName: '按文件名映射模板' };
      })()
    : allDetailPaths.length === 1
      ? { filePath: allDetailPaths[0], fileName: path.basename(allDetailPaths[0]), templateName: '按文件名映射模板' }
      : null;

  const mergedBalance = allBalancePaths.length > 1
    ? (() => {
        const mergedFileName = `${templateCount}-BALANCE-${dateRangeLabel || getToday()}.xlsx`;
        const { outputFilePath: mergedPath } = buildOutputFilePath({ kind: 'balance', outputFileName: mergedFileName });
        mergeGeneratedXlsxFiles(allBalancePaths, mergedPath);
        return { filePath: mergedPath, fileName: mergedFileName, templateName: '按文件名映射模板' };
      })()
    : allBalancePaths.length === 1
      ? { filePath: allBalancePaths[0], fileName: path.basename(allBalancePaths[0]), templateName: '按文件名映射模板' }
      : null;

  // session 只 append 一次（避免 importCount 膨胀导致首次导入就弹 scope 选择）
  const mergedSessionEntries = allFileEntries.map((entry) => buildStatementFileEntry({
    ...entry,
    buildEntryId: buildStatementFileEntryId
  }));
  const mergedGeneratedFiles = {
    detail: mergedDetail,
    balance: mergedBalance,
    fileEntries: allFileEntries,
    preparedBatch: null,
    message: mergedBalance ? '明细账单可导出，余额账单可导出' : '明细账单可导出',
    warnings: allWarnings,
    balanceRequested: allBalancePaths.length > 0 || allWarnings.some((w) => w.type === 'balance-seed-required')
  };

  lastBatchId = appendStatementSessionImport({
    buildBatchId: buildStatementBatchId,
    lastGeneratedExports,
    session,
    fileEntries: mergedSessionEntries
  });
  updateStatementSessionCache(session, lastBatchId, mergedGeneratedFiles);

  const lastResult = buildImportResultFromGeneratedFiles({
    generatedFiles: mergedGeneratedFiles,
    templateId: FILENAME_MAPPING_TEMPLATE_ID,
    templateName: '按文件名映射模板',
    inputFilePaths
  });

  return { lastResult, lastBatchId, lastGenerationTemplateConfig };
}

function prepareGeneratedFiles({
  template,
  mappings,
  orderedTargetFields,
  inputFilePath,
  inputFilePaths,
  selectedBigAccount = null,
  scope = 'current'
}) {
  return statementGenerationHelpers.prepareGeneratedFiles({
    template,
    mappings,
    orderedTargetFields,
    inputFilePath,
    inputFilePaths,
    selectedBigAccount,
    scope
  });
}

async function exportGeneratedFile(generatedFile, emptyMessage, step) {
  if (!generatedFile || !generatedFile.filePath || !fs.existsSync(generatedFile.filePath)) {
    return createErrorResult({
      step,
      message: emptyMessage,
      errorCode: 'EXPORT_EMPTY',
      templateName: generatedFile?.templateName || ''
    });
  }

  const saveResult = await dialog.showSaveDialog(mainWindow, {
    defaultPath: generatedFile.fileName,
    filters: [
      {
        name: 'Excel',
        extensions: ['xlsx']
      }
    ]
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { status: 'cancelled' };
  }

  try {
    fs.copyFileSync(generatedFile.filePath, saveResult.filePath);
    clearLastErrorReport();
    appendActivityLogEntry({
      level: 'info',
      message: `${step}成功`,
      details: [
        `模板名：${generatedFile.templateName || 'N/A'}`,
        `导出路径：${saveResult.filePath}`
      ]
    });
    return {
      status: 'success',
      message: '文件导出成功',
      filePath: saveResult.filePath
    };
  } catch (error) {
    return createErrorResult({
      step,
      message: '文件导出失败，请导出报错文件查看详情',
      errorCode: 'EXPORT_RUNTIME',
      errorType: '系统错误',
      originalError: error,
      context: {
        sourceFilePath: generatedFile.filePath,
        targetFilePath: saveResult.filePath
      },
      templateName: generatedFile.templateName || ''
    });
  }
}

function extractManualBalancePromptWarning(warnings = []) {
  return statementGenerationHelpers.extractManualBalancePromptWarning(warnings);
}

function buildImportResultFromGeneratedFiles({
  generatedFiles,
  templateId,
  templateName,
  inputFilePath,
  inputFilePaths
}) {
  return statementGenerationHelpers.buildImportResultFromGeneratedFiles({
    generatedFiles,
    templateId,
    templateName,
    inputFilePath,
    inputFilePaths
  });
}

function buildPreparedBatchFromStatementSession({
  session,
  config,
  scope = 'all'
}) {
  return statementGenerationHelpers.buildPreparedBatchFromStatementSession({
    session,
    config,
    scope
  });
}

function matchFileToTemplate(filePath, candidateTemplates) {
  const matches = [];

  for (const template of candidateTemplates) {
    const headers = template.headers || [];
    if (headers.length === 0) continue;

    try {
      readRowsWithMetadata(filePath, headers);
      matches.push(template);
    } catch (error) {
      // 区分文件读取错误和表头不匹配：文件本身不可读时向上抛出
      if (error instanceof FileValidationError && error.message.includes('表头')) {
        continue; // 表头不匹配，尝试下一个模板
      }
      if (error instanceof FileValidationError) {
        throw error; // 文件为空/不可读，直接抛出
      }
      // 其他异常（如 PDF 解析失败）也抛出
      throw error;
    }
  }

  // 过滤子集匹配：多个模板匹配时，只保留 headers 最多的（最精确匹配）
  if (matches.length > 1) {
    const maxHeaderCount = Math.max(...matches.map((t) => (t.headers || []).length));
    return matches.filter((t) => (t.headers || []).length === maxHeaderCount);
  }

  return matches;
}

function computeFileHash(filePath) {
  const buffer = fs.readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

async function resolveImportFileSelection({
  templateName,
  session,
  filePaths
}) {
  const acceptedPaths = [];
  const replacePaths = [];

  // 预计算已导入文件的信息（跳过已删除/移动的文件）
  const sessionFileInfo = session.fileEntries.map((entry) => {
    let hash = '';
    try {
      hash = computeFileHash(entry.filePath);
    } catch (_ignored) {
      // 文件已删除/移动，跳过 hash 比对
    }
    return {
      filePath: entry.filePath,
      baseName: path.basename(entry.filePath),
      hash
    };
  }).filter((info) => info.hash !== '');

  // 当前批次的文件信息
  const batchFileInfo = [];

  for (const rawPath of normalizeInputFilePaths(filePaths, { dedupe: false })) {
    const normalizedPath = path.resolve(rawPath);
    const baseName = path.basename(normalizedPath);
    const fileHash = computeFileHash(normalizedPath);

    let duplicateReason = null;
    let duplicateDetail = '';

    // 1. 同路径
    if (acceptedPaths.includes(normalizedPath)) {
      duplicateReason = '同一文件路径';
      duplicateDetail = `当前批次已重复选择文件：\n${normalizedPath}`;
    } else if (session.fileEntries.some((e) => e.filePath === normalizedPath)) {
      duplicateReason = '同一文件路径';
      duplicateDetail = `该文件在当前模板的本次会话中已导入过：\n${normalizedPath}`;
    }

    // 2. 同文件名
    if (!duplicateReason) {
      if (batchFileInfo.some((info) => info.baseName === baseName)) {
        duplicateReason = '同名文件';
        duplicateDetail = `当前批次已重复选择文件：\n${baseName}`;
      } else if (sessionFileInfo.some((info) => info.baseName === baseName)) {
        duplicateReason = '同名文件';
        duplicateDetail = `当前批次已重复选择文件：\n${baseName}`;
      }
    }

    // 3. 同文件内容
    if (!duplicateReason) {
      if (batchFileInfo.some((info) => info.hash === fileHash)) {
        duplicateReason = '文件内容相同';
        duplicateDetail = `检测到与已导入文件内容相同的文件：\n${normalizedPath}`;
      } else if (sessionFileInfo.some((info) => info.hash === fileHash)) {
        duplicateReason = '文件内容相同';
        duplicateDetail = `检测到与已导入文件内容相同的文件：\n${normalizedPath}`;
      }
    }

    if (!duplicateReason) {
      acceptedPaths.push(normalizedPath);
      batchFileInfo.push({ filePath: normalizedPath, baseName, hash: fileHash });
      continue;
    }

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['覆盖旧记录', '取消本次导入'],
      defaultId: 0,
      cancelId: 1,
      message: `检测到重复文件（模板：${templateName}）`,
      detail: `${duplicateDetail}\n\n重复原因：${duplicateReason}`
    });

    if (result.response === 1) {
      return {
        status: 'cancelled',
        filePaths: []
      };
    }

    // 覆盖旧记录
    const existingBatchIndex = acceptedPaths.findIndex((fp) => fp === normalizedPath);
    if (existingBatchIndex >= 0) {
      acceptedPaths.splice(existingBatchIndex, 1);
    }

    // 同名文件覆盖：找到批次或会话中同名文件路径
    if (duplicateReason === '同名文件') {
      const batchSameName = batchFileInfo.find((info) => info.baseName === baseName);
      if (batchSameName) {
        const idx = acceptedPaths.indexOf(batchSameName.filePath);
        if (idx >= 0) {
          acceptedPaths.splice(idx, 1);
        }
        const biIdx = batchFileInfo.indexOf(batchSameName);
        if (biIdx >= 0) {
          batchFileInfo.splice(biIdx, 1);
        }
      }
      const sessionSameName = sessionFileInfo.find((info) => info.baseName === baseName);
      if (sessionSameName) {
        replacePaths.push(sessionSameName.filePath);
      }
    }

    // 同内容覆盖：找到批次或会话中同 hash 文件路径
    if (duplicateReason === '文件内容相同') {
      const batchSameHash = batchFileInfo.find((info) => info.hash === fileHash);
      if (batchSameHash) {
        const idx = acceptedPaths.indexOf(batchSameHash.filePath);
        if (idx >= 0) {
          acceptedPaths.splice(idx, 1);
        }
        const biIdx = batchFileInfo.indexOf(batchSameHash);
        if (biIdx >= 0) {
          batchFileInfo.splice(biIdx, 1);
        }
      }
      const sessionSameHash = sessionFileInfo.find((info) => info.hash === fileHash);
      if (sessionSameHash) {
        replacePaths.push(sessionSameHash.filePath);
      }
    }

    // 同路径覆盖
    if (duplicateReason === '同一文件路径') {
      if (session.fileEntries.some((e) => e.filePath === normalizedPath)) {
        replacePaths.push(normalizedPath);
      }
    }

    acceptedPaths.push(normalizedPath);
    batchFileInfo.push({ filePath: normalizedPath, baseName, hash: fileHash });
  }

  return {
    status: 'success',
    filePaths: acceptedPaths,
    replacePaths: Array.from(new Set(replacePaths))
  };
}

function buildScopeSelectionResult(kind) {
  return statementGenerationHelpers.buildScopeSelectionResult(kind);
}

function getCurrentStatementSession() {
  const sessionKey = normalizeCell(lastGeneratedExports.statementSessionKey);
  return sessionKey ? statementImportSessions.get(sessionKey) || null : null;
}

function shouldPromptForExportScope(session) {
  return Boolean(session && session.importCount >= 2);
}

function createGenerationContext({
  templateId,
  template,
  mappings,
  orderedTargetFields,
  inputFilePaths = [],
  selectedBigAccount = null,
  preparedDetailRows = null,
  scope = 'current',
  statementSessionKey = '',
  currentBatchId = ''
}) {
  return statementGenerationHelpers.createGenerationContext({
    templateId,
    template,
    mappings,
    orderedTargetFields,
    inputFilePaths,
    selectedBigAccount,
    preparedDetailRows,
    scope,
    statementSessionKey,
    currentBatchId
  });
}

function generateFilesFromRememberedContext(context) {
  return statementGenerationHelpers.generateFilesFromRememberedContext(context);
}

function cacheCurrentStatementExports({
  session,
  generatedFiles
}) {
  statementGenerationHelpers.cacheCurrentStatementExports({
    session,
    generatedFiles,
    lastGeneratedExports
  });
}

function cacheAllStatementExport(kind, generatedFile) {
  statementGenerationHelpers.cacheAllStatementExport(lastGeneratedExports, kind, generatedFile);
}

function updateStatementSessionCache(session, batchId, generatedFiles) {
  statementGenerationHelpers.updateStatementSessionCache(session, batchId, generatedFiles, lastGeneratedExports);
}

function buildStatementSessionGenerationContext({
  session,
  template,
  mappings,
  orderedTargetFields,
  scope
}) {
  return statementGenerationHelpers.buildStatementSessionGenerationContext({
    session,
    template,
    mappings,
    orderedTargetFields,
    scope
  });
}

function getGeneratedStatementExport(kind, scope = 'current') {
  return statementGenerationHelpers.getGeneratedStatementExport(lastGeneratedExports, kind, scope);
}

async function exportStatementByScope(kind, scope = 'auto') {
  const session = getCurrentStatementSession();

  const isVirtualTemplate = session && isFilenameMappingMode(session.templateId);

  const normalizedScope = scope === 'all' || scope === 'current'
    ? scope
    : shouldPromptForExportScope(session)
      ? 'select'
      : 'current';

  if (normalizedScope === 'select') {
    return buildScopeSelectionResult(kind);
  }

  const emptyMessage = normalizedScope === 'all'
    ? `暂无可导出的全部${kind === 'detail' ? '明细' : '余额'}账单`
    : `暂无可导出的${kind === 'detail' ? '明细' : '余额'}账单`;
  let generatedFile = getGeneratedStatementExport(kind, normalizedScope);

  if (!generatedFile && normalizedScope === 'all') {
    if (!session) {
      return createErrorResult({
        step: kind === 'detail' ? '导出明细账单' : '导出余额账单',
        message: emptyMessage,
        errorCode: 'EXPORT_EMPTY'
      });
    }

    // v1.5.2：虚拟 ID 按 matchedTemplateId 分组，每组用各自模板 config 生成，最后合并
    if (isVirtualTemplate) {
      const allEntries = getStatementSessionEntries(session, 'all');
      const groupMap = new Map();
      for (const entry of allEntries) {
        const tid = entry.matchedTemplateId || 0;
        if (!groupMap.has(tid)) groupMap.set(tid, []);
        groupMap.get(tid).push(entry);
      }

      const perGroupPaths = []; // [{detail, balance, warnings}]
      const exportBillDates = [];
      const skippedGroupNames = [];
      for (const [tid, groupEntries] of groupMap) {
        const templateConfig = getTemplateMappingConfig(tid);
        if (!templateConfig) {
          appendActivityLogEntry({
            level: 'warn',
            message: `导出时跳过模板组（templateId=${tid}）：模板已被删除，${groupEntries.length} 个文件的数据未包含在导出中`
          });
          skippedGroupNames.push(`模板ID=${tid}（${groupEntries.length}个文件）`);
          continue;
        }

        const groupGenConfig = buildStatementGenerationConfig({
          template: templateConfig.template,
          mappings: templateConfig.exportMappings,
          orderedTargetFields: templateConfig.exportTargetFields,
          allowManagedMerchantWithoutSelection: true
        });
        const groupPreparedBatch = buildPreparedStatementBatchFromEntries({
          config: groupGenConfig,
          fileEntries: groupEntries
        });

        if (kind === 'balance') {
          rememberLastFileImportContext(createGenerationContext({
            templateId: tid,
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            preparedDetailRows: groupPreparedBatch.detailRows,
            scope: 'all',
            statementSessionKey: session.key,
            currentBatchId: session.currentBatchId
          }));
        }

        const groupGeneratedFiles = generateStatementFiles({
          config: groupGenConfig,
          preparedBatch: groupPreparedBatch,
          scope: 'all',
          includeDetail: kind === 'detail',
          includeBalance: kind === 'balance'
        });

        // 不在循环内 return balance-seed-required；收集 warnings 后统一处理
        // （补录后重新导出时 seed 已持久化，该组能正常生成余额）

        try {
          const dates = parseRequiredBillDates(groupPreparedBatch.detailRows);
          exportBillDates.push(...dates);
        } catch (_ignored) {}
        perGroupPaths.push({
          detail: groupGeneratedFiles.detail ? groupGeneratedFiles.detail.filePath : null,
          balance: groupGeneratedFiles.balance ? groupGeneratedFiles.balance.filePath : null,
          warnings: groupGeneratedFiles.warnings || []
        });
      }

      // 循环结束后统一检查 balance-seed-required（补录后重新导出时 seed 已持久化）
      if (kind === 'balance') {
        const allGroupWarnings = perGroupPaths.flatMap((g) => g.warnings || []);
        const manualBalanceWarning = extractManualBalancePromptWarning(allGroupWarnings);
        if (manualBalanceWarning) {
          return buildManualBalanceRequiredResult(manualBalanceWarning.prompt, {
            warnings: allGroupWarnings,
            balance: null,
            detail: null,
            balanceRequested: true
          });
        }
      }

      // 合并多组文件，命名：模板数量-COMMON/BALANCE-日期范围.xlsx
      const targetPaths = perGroupPaths.map((g) => kind === 'detail' ? g.detail : g.balance).filter(Boolean);
      if (targetPaths.length > 1) {
        const exportDateRange = buildDateRangeLabel(exportBillDates);
        const outputTag = kind === 'detail' ? 'COMMON' : 'BALANCE';
        const mergedFileName = `${groupMap.size}-${outputTag}-${exportDateRange || getToday()}.xlsx`;
        const { outputFilePath: mergedPath } = buildOutputFilePath({ kind, outputFileName: mergedFileName });
        mergeGeneratedXlsxFiles(targetPaths, mergedPath);
        generatedFile = { filePath: mergedPath, fileName: mergedFileName, templateName: '按文件名映射模板' };
      } else if (targetPaths.length === 1) {
        generatedFile = { filePath: targetPaths[0], fileName: path.basename(targetPaths[0]), templateName: '按文件名映射模板' };
      }

      if (!generatedFile) {
        return createErrorResult({
          step: kind === 'detail' ? '导出明细账单' : '导出余额账单',
          message: emptyMessage,
          errorCode: 'EXPORT_EMPTY',
          templateName: session.templateName
        });
      }

      // 部分 group 模板被删时：先导出文件，再返回带 warning 的 result
      if (skippedGroupNames.length > 0) {
        const step = kind === 'detail' ? '导出明细账单' : '导出余额账单';
        const exportResult = await exportGeneratedFile(generatedFile, emptyMessage, step);
        if (exportResult.status === 'success') {
          exportResult.message = `文件已导出，但数据不完整：${skippedGroupNames.join('、')} 的模板已被删除，对应文件未包含在导出中。`;
        }
        return exportResult;
      }
    } else {
      // 正常模板流程（非虚拟 ID）
      const templateConfig = getTemplateMappingConfig(session.templateId);

      if (!templateConfig) {
        return createErrorResult({
          step: kind === 'detail' ? '导出明细账单' : '导出余额账单',
          message: '未找到当前模板，请重新选择模板后导入文件',
          errorCode: 'TEMPLATE_NOT_FOUND',
          templateName: session.templateName
        });
      }

      const sessionFileEntries = getStatementSessionEntries(session, 'all');
      const generationTemplateConfig = resolveGenerationTemplateConfig({
        fileEntries: sessionFileEntries,
        fallbackTemplateConfig: templateConfig
      });

      const { config, preparedBatch } = buildStatementSessionGenerationContext({
        session,
        template: generationTemplateConfig.template,
        mappings: generationTemplateConfig.exportMappings,
        orderedTargetFields: generationTemplateConfig.exportTargetFields,
        scope: 'all'
      });

      if (kind === 'balance') {
        rememberLastFileImportContext(createGenerationContext({
          templateId: generationTemplateConfig.template.id || session.templateId,
          template: generationTemplateConfig.template,
          mappings: generationTemplateConfig.exportMappings,
          orderedTargetFields: generationTemplateConfig.exportTargetFields,
          preparedDetailRows: preparedBatch.detailRows,
          scope: 'all',
          statementSessionKey: session.key,
          currentBatchId: session.currentBatchId
        }));
      }

      const generatedFiles = generateStatementFiles({
        config,
        preparedBatch,
        scope: 'all',
        includeDetail: kind === 'detail',
        includeBalance: kind === 'balance'
      });

      if (kind === 'detail') {
        cacheAllStatementExport('detail', generatedFiles.detail);
        generatedFile = generatedFiles.detail;
      } else {
        const manualBalanceWarning = extractManualBalancePromptWarning(generatedFiles.warnings);

        if (manualBalanceWarning) {
          return buildManualBalanceRequiredResult(manualBalanceWarning.prompt, generatedFiles);
        }

        if (!generatedFiles.balance) {
          const balanceWarning = generatedFiles.warnings.find((warning) => warning.type === 'balance-generate-failed');
          return createErrorResult({
            step: '导出余额账单',
            message: balanceWarning?.message || emptyMessage,
            errorCode: 'EXPORT_EMPTY',
            templateName: session.templateName
          });
        }

        cacheAllStatementExport('balance', generatedFiles.balance);
        generatedFile = generatedFiles.balance;
      }
    }
  }

  return exportGeneratedFile(
    generatedFile,
    emptyMessage,
    kind === 'detail' ? '导出明细账单' : '导出余额账单'
  );
}

function registerBigAccountHandlers() {
  ipcMain.handle('big-account:import-bank-info', async (_event, templateId) => {
    const template = database.getTemplate(templateId);

    if (!template) {
      return createErrorResult({
        step: '导入银行账号信息',
        message: '未找到对应模板',
        errorCode: 'TEMPLATE_NOT_FOUND',
        context: { templateId }
      });
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    try {
      const parsed = parseBankAccountExcel(result.filePaths[0]);

      if (!parsed.clientAccounts.length && !parsed.ownAccounts.length) {
        return createErrorResult({
          step: '导入银行账号信息',
          message: '未找到符合条件的银行账号信息',
          errorCode: 'BANK_ACCOUNT_IMPORT_EMPTY'
        });
      }

      const skippedNote = parsed.skippedCount > 0
        ? `（${parsed.skippedCount} 行因银行账号或币种为空被跳过）`
        : '';

      appendActivityLogEntry({
        level: 'info',
        message: '导入银行账号信息成功',
        details: [
          `模板名：${template.name}`,
          `客资账号：${parsed.clientAccounts.length} 个`,
          `自有账号：${parsed.ownAccounts.length} 个`
        ]
      });

      return {
        status: 'success',
        message: `已导入 ${parsed.clientAccounts.length} 个客资账号、${parsed.ownAccounts.length} 个自有账号${skippedNote}`,
        clientAccounts: parsed.clientAccounts,
        ownAccounts: parsed.ownAccounts
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '导入银行账号信息',
          message: error.message,
          errorCode: error.code,
          originalError: error
        });
      }
      return createErrorResult({
        step: '导入银行账号信息',
        message: '导入失败，请导出报错文件查看详情',
        errorCode: 'BANK_ACCOUNT_IMPORT_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });

  // v1.5.3 R2：deprecated。自有账号已合入 template_big_accounts 表，由 saveMappings 统一写回。
  // 保留该 handler 仅作兼容（防止老调用链报错），任何新调用应改走 saveMappings。
  ipcMain.handle('big-account:save-own-accounts', (_event, payload = {}) => {
    try {
      console.warn('[v1.5.3] big-account:save-own-accounts is deprecated; own accounts should be persisted via template:save-mappings');
      const template = database.getTemplate(payload.templateId);
      if (!template) {
        return { status: 'error', message: '未找到对应模板' };
      }
      const bankNameParts = splitTemplateName(template.name);
      writeOwnAccounts(ensureStorageRoot(), bankNameParts.bankName, payload.accounts || []);
      return { status: 'success' };
    } catch (error) {
      return createErrorResult({
        step: '保存自有账号',
        message: '自有账号保存失败',
        errorCode: 'OWN_ACCOUNT_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });

  // v1.5.3 R2：拉含自有账号的完整大账号列表（专供"维护大账号"对话框初始化 / G1 月度余额弹窗）
  // 与默认 getTemplateBigAccounts 区别：显式带 { includeOwn: true }，并按 merchantId+accountNature 聚合
  // 返回 grouped 结构 {merchantId, currencies, isMultiCurrency, accountNature}，与 getTemplateMappings.bigAccounts 对齐
  ipcMain.handle('big-account:get-with-own', (_event, templateId) => {
    try {
      if (!templateId) {
        return { status: 'error', message: 'templateId 不能为空' };
      }
      const rows = database.getTemplateBigAccounts(templateId, { includeOwn: true });
      const bigAccounts = groupBigAccountRows(rows);
      return { status: 'success', bigAccounts };
    } catch (error) {
      return createErrorResult({
        step: '获取大账号（含自有）',
        message: '获取大账号失败',
        errorCode: 'BIG_ACCOUNT_GET_WITH_OWN_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });

  ipcMain.handle('balance-adjustment:list', (_event, templateName) => {
    try {
      const normalizedName = normalizeCell(templateName);
      const bankNameParts = splitTemplateName(normalizedName);
      const allAdjustments = readBalanceAdjustments(ensureStorageRoot(), bankNameParts.bankName);
      return {
        status: 'success',
        adjustments: allAdjustments.filter(
          (record) => normalizeCell(record.templateName) === normalizedName
        )
      };
    } catch (_error) {
      return { status: 'success', adjustments: [] };
    }
  });

  ipcMain.handle('balance-adjustment:save', (_event, payload = {}) => {
    try {
      const templateName = normalizeCell(payload.templateName);
      if (!templateName) {
        return createErrorResult({
          step: '保存余额附加值',
          message: '模板名称不能为空',
          errorCode: 'BALANCE_ADJUSTMENT_TEMPLATE_MISSING'
        });
      }

      const bankNameParts = splitTemplateName(templateName);
      const records = Array.isArray(payload.records) ? payload.records : [];
      const existingRecords = readBalanceAdjustments(ensureStorageRoot(), bankNameParts.bankName);
      const otherTemplateRecords = existingRecords.filter(
        (record) => normalizeCell(record.templateName) !== templateName
      );
      const mergedRecords = [
        ...otherTemplateRecords,
        ...records.map((record) => ({ ...record, templateName }))
      ];

      writeBalanceAdjustments(ensureStorageRoot(), bankNameParts.bankName, mergedRecords);

      appendActivityLogEntry({
        level: 'info',
        message: '保存余额附加值成功',
        details: [`模板名：${templateName}`, `记录数：${records.length}`]
      });

      return { status: 'success', message: '余额附加值保存成功' };
    } catch (error) {
      return createErrorResult({
        step: '保存余额附加值',
        message: '余额附加值保存失败',
        errorCode: 'BALANCE_ADJUSTMENT_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });
}

function registerBigAccountOrderHandlers() {
  ipcMain.handle('big-account-mode:load', (_event, templateId) => {
    try {
      return { status: 'success', mode: readBigAccountMode(ensureStorageRoot(), templateId) };
    } catch (_error) {
      return { status: 'success', mode: 'unfixed' };
    }
  });

  ipcMain.handle('big-account-mode:save', (_event, payload = {}) => {
    try {
      writeBigAccountMode(ensureStorageRoot(), payload.templateId, payload.mode);
      return { status: 'success' };
    } catch (_error) {
      return { status: 'error', message: '解析模式保存失败' };
    }
  });

  ipcMain.handle('big-account-order:load', (_event, templateId) => {
    try {
      return { status: 'success', order: readBigAccountOrder(ensureStorageRoot(), templateId) };
    } catch (_error) {
      return { status: 'success', order: null };
    }
  });

  ipcMain.handle('big-account-order:save', (_event, payload = {}) => {
    try {
      const data = { assignments: payload.assignments || [] };

      if (payload.includeFileInfo && lastPendingBigAccountSelection) {
        const pendingContext = lastPendingBigAccountSelection;
        const fileEntries = pendingContext.fileEntries || [];
        const allMerchantIds = (pendingContext.bigAccounts || []).map((ba) => normalizeCell(ba.merchantId)).filter((id) => id !== '');
        const defaultHeaders = pendingContext.template?.headers || [];
        const expandedOptions = expandBigAccountConfigurations(pendingContext.bigAccounts || []);

        data.fileCount = fileEntries.length;
        data.files = fileEntries.map((entry, fileIndex) => {
          const entryHeaders = entry.matchedHeaders || defaultHeaders;
          let fileResult = entry.skipDirectMerchantLookup
            ? { accounts: [], isSingleAccount: false }
            : identifyAccountsFromFile({
                filePath: entry.filePath,
                detailRows: entry.detailRows,
                expectedSourceHeaders: entryHeaders,
                allMerchantIds
              });
          // 自定义输入 MerchantId：通过账户映射桥接提取（merchantId 不在文件中，跳过全文搜索）
          if (fileResult.accounts.length === 0 && entry.selfInputMerchant) {
            if (entry.matchedTemplateId) {
              const rawRowsFull = readRows(entry.filePath, { blankrows: true });
              const acctMappings = database.listAccountMappings(entry.matchedTemplateId);
              const bankIdToMerchant = new Map();
              for (const am of acctMappings) {
                const bankId = normalizeCell(am.bankAccountId);
                const clearingId = normalizeCell(am.clearingAccountId);
                if (bankId && clearingId) bankIdToMerchant.set(bankId, clearingId);
              }
              if (bankIdToMerchant.size > 0) {
                const bankIds = [...bankIdToMerchant.keys()];
                for (let rowIdx = 0; rowIdx < rawRowsFull.length && fileResult.accounts.length === 0; rowIdx += 1) {
                  const row = rawRowsFull[rowIdx];
                  if (!Array.isArray(row)) continue;
                  for (const cell of row) {
                    const cellStr = normalizeCell(cell);
                    if (!cellStr) continue;
                    for (const bankId of bankIds) {
                      if (matchMerchantIds(cellStr, bankId) !== 'none') {
                        const clearingId = bankIdToMerchant.get(bankId);
                        const matched = expandedOptions.find((o) => matchMerchantIds(clearingId, o.merchantId) !== 'none');
                        if (matched) {
                          fileResult = { accounts: [{ merchantId: matched.merchantId, matchType: 'exact' }], isSingleAccount: true };
                          break;
                        }
                      }
                    }
                    if (fileResult.accounts.length > 0) break;
                  }
                }
              }
            }
          }
          const accounts = fileResult.accounts.map((identified) => {
            const matched = expandedOptions.find((o) => matchMerchantIds(identified.merchantId, o.merchantId) !== 'none');
            return matched
              ? { merchantId: matched.merchantId, currency: matched.currency }
              : { merchantId: identified.merchantId, currency: '' };
          });
          return { fileIndex, accountCount: accounts.length, accounts };
        });
      }

      writeBigAccountOrder(ensureStorageRoot(), payload.templateId, data);
      return { status: 'success' };
    } catch (_error) {
      return { status: 'error', message: '大账号选择顺序保存失败' };
    }
  });
}

// v1.5.2：检查表头是否与已有模板重复（排除自身 excludeId）
function findConflictingTemplateByHeaders(headers, excludeId) {
  const allTemplates = database.listTemplates();
  const key = JSON.stringify(headers);
  return allTemplates.find((t) => {
    if (excludeId != null && t.id === Number(excludeId)) return false;
    return JSON.stringify(t.headers) === key;
  }) || null;
}

// v1.5.2 需求 3（G3-7）：判定单个文件是否匹配给定模板的表头
// 复用 matchFileToTemplate 的捕获模式（main.js:5334）：FileValidationError + message.includes('表头') → 视为表头不匹配
// 其他 FileValidationError（文件不可读等）与非业务异常向上抛出，让调用方走通用 catch
function matchesTemplateHeaders(filePath, template) {
  const headers = Array.isArray(template?.headers) ? template.headers : [];
  if (headers.length === 0) return false;
  try {
    readRowsWithMetadata(filePath, headers);
    return true;
  } catch (error) {
    if (error instanceof FileValidationError && typeof error.message === 'string' && error.message.includes('表头')) {
      return false;
    }
    throw error;
  }
}

// v1.5.2 需求 3（G3-7）：按文件名映射模板 — 独立导入分支
// 流程：守卫 → 文件选择 → 文件名匹配（0/>=2 整批截断）→ 表头校验（不一致整批截断）
//     → 为每个文件构造 provisionalEntry → 聚合大账号（含主模板兜底）→ 复用大账号选择/直接生成流程
// 整批截断：任一文件校验失败 → 所有文件全部不入库（无部分成功）
async function handleFilenameMappingImport() {
  // ===== 守卫（与旧分支一致）=====
  if (fileImportInProgress) {
    return createErrorResult({
      step: '导入网银明细文件',
      message: '上一次导入尚未完成，请稍候',
      errorCode: 'IMPORT_IN_PROGRESS'
    });
  }

  if (!getEnumConfig()) {
    return createErrorResult({
      step: '导入网银明细文件',
      message: MISSING_ENUM_MESSAGE,
      errorCode: 'ENUM_MISSING'
    });
  }

  const migrationPending = database.getSetting('account_mapping_migration_pending');
  if (migrationPending === 'true') {
    return createErrorResult({
      step: '导入网银明细文件',
      message: '账户映射数据迁移尚未完成，请先打开「账户映射」页面完成数据分配',
      errorCode: 'ACCOUNT_MAPPING_MIGRATION_PENDING'
    });
  }

  // 虚拟模板名，用于错误上下文 / session 标题 / 文件名重复提示
  const virtualTemplateName = '按文件名映射模板';

  fileImportInProgress = true;
  try {
    clearPendingManualBalancePrompt();
    clearPendingBigAccountSelection();

    // ===== 步骤 0：文件选择 =====
    const pickResult = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: statementFileDialogFilters()
    });
    if (pickResult.canceled || pickResult.filePaths.length === 0) {
      return { status: 'cancelled' };
    }
    const inputFilePaths = normalizeInputFilePaths(pickResult.filePaths, { dedupe: false });

    // ===== 步骤 1：表头 → 模板候选匹配（遍历所有模板，用表头识别）=====
    // 0 命中 → FILENAME_MAPPING_NO_MATCH（整批截断）
    // ≥2 命中 → FILENAME_MAPPING_AMBIGUOUS（整批截断）
    const allTemplates = database.listTemplates();

    const perFileMatch = []; // [{ filePath, matchedTemplate }]
    for (const filePath of inputFilePaths) {
      const basename = path.basename(filePath);
      // 复用 matchFileToTemplate：多命中时自动保留 headers 最多的（子集消歧）
      const candidates = matchFileToTemplate(filePath, allTemplates);

      if (candidates.length === 0) {
        return createErrorResult({
          step: '导入网银明细文件',
          message: `文件「${basename}」无法通过表头匹配任何已有模板，请检查。已取消本次导入。`,
          errorCode: 'FILENAME_MAPPING_NO_MATCH',
          context: { fileName: basename },
          templateName: virtualTemplateName
        });
      }
      if (candidates.length > 1) {
        const candidateNames = candidates.map((t) => t.name);
        return createErrorResult({
          step: '导入网银明细文件',
          message: `文件「${basename}」的表头同时匹配到多个模板：${candidateNames.join('、')}；请手动选择模板。已取消本次导入。`,
          errorCode: 'FILENAME_MAPPING_AMBIGUOUS',
          context: { fileName: basename, candidateNames },
          templateName: virtualTemplateName
        });
      }
      perFileMatch.push({ filePath, matchedTemplate: candidates[0] });
    }

    // ===== 步骤 3：构造 parentProvisionalEntries + 缓存 matchedConfig =====
    // 每个文件用自己命中的 matchedTemplate 的 config 独立解析；
    // matchedTemplateId 保持在 entry 上，后续 resolveGenerationTemplateConfig / rebuildMatchedTemplateFileEntries
    // 会据此挑选正确的 config（逻辑同 main.js:6070-6107 主模板多文件分支）
    const perTemplateConfigCache = new Map(); // templateId → matchedConfig
    const parentProvisionalEntries = [];

    for (const { filePath, matchedTemplate } of perFileMatch) {
      const matchedId = matchedTemplate.id;
      let matchedConfig = perTemplateConfigCache.get(matchedId);
      if (!matchedConfig) {
        matchedConfig = getTemplateMappingConfig(matchedId);
        if (!matchedConfig) {
          return createErrorResult({
            step: '导入网银明细文件',
            message: `未找到匹配模板「${matchedTemplate.name}」的配置`,
            errorCode: 'TEMPLATE_NOT_FOUND',
            context: { templateId: matchedId },
            templateName: virtualTemplateName
          });
        }
        perTemplateConfigCache.set(matchedId, matchedConfig);
      }

      const config = buildStatementGenerationConfig({
        template: matchedConfig.template,
        mappings: matchedConfig.exportMappings,
        orderedTargetFields: matchedConfig.exportTargetFields,
        allowManagedMerchantWithoutSelection: true
      });
      const merchantLookupFlags = buildManagedMerchantLookupFlags(matchedConfig.exportMappings);

      parentProvisionalEntries.push({
        filePath,
        detailRows: buildMappedRowsForFile({ config, inputFilePath: filePath }),
        matchedTemplateId: matchedId,
        matchedHeaders: matchedConfig.template.headers || [],
        selfInputMerchant: merchantLookupFlags.selfInputMerchant,
        skipDirectMerchantLookup: merchantLookupFlags.skipDirectMerchantLookup
      });
    }

    // ===== 步骤 4：聚合大账号 =====
    // 每个命中的模板自身 bigAccounts；若模板是子模板，向上追加主模板的 bigAccounts（沿用 v1.5.1 聚合思路）。
    // 主模板如也被直接命中（即也在 perTemplateConfigCache 内），跳过重复追加。
    const aggregatedBigAccounts = [];
    const addBigAccounts = (baList) => {
      if (!Array.isArray(baList)) return;
      for (const ba of baList) {
        const mid = normalizeCell(ba.merchantId);
        if (!mid) continue;
        const existing = aggregatedBigAccounts.find((a) => normalizeCell(a.merchantId) === mid);
        if (existing) {
          // 同 MerchantId 合并 currencies（避免丢弃不同模板的币种）
          const newCurrencies = (Array.isArray(ba.currencies) ? ba.currencies : [])
            .map((c) => normalizeCell(c)).filter((c) => c !== '');
          const existingCurrencies = Array.isArray(existing.currencies) ? existing.currencies : [];
          existing.currencies = Array.from(new Set([...existingCurrencies, ...newCurrencies]));
          // 合并后币种 > 1 则标记多币种，确保提交时不被 coerce 回第一个
          existing.isMultiCurrency = existing.currencies.length > 1;
        } else {
          aggregatedBigAccounts.push({ ...ba });
        }
      }
    };

    const parentIdsProcessed = new Set();
    for (const [, matchedConfig] of perTemplateConfigCache) {
      addBigAccounts(matchedConfig.bigAccounts);
      const parentId = matchedConfig.template.parentTemplateId;
      if (parentId
        && !parentIdsProcessed.has(parentId)
        && !perTemplateConfigCache.has(parentId)
      ) {
        parentIdsProcessed.add(parentId);
        const parentConfig = getTemplateMappingConfig(parentId);
        if (parentConfig) {
          addBigAccounts(parentConfig.bigAccounts);
        }
      }
    }

    // ===== 步骤 5：session + 文件重复检测（复用 resolveImportFileSelection）=====
    // 用虚拟 ID 作为 session key：同一批「按文件名映射模板」导入共享 session，支持重复文件提示
    const session = getOrCreateStatementImportSession({
      statementImportSessions,
      templateId: FILENAME_MAPPING_TEMPLATE_ID,
      templateName: virtualTemplateName
    });
    const selectionResult = await resolveImportFileSelection({
      templateName: virtualTemplateName,
      session,
      filePaths: inputFilePaths
    });
    if (selectionResult.status === 'cancelled' || selectionResult.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    // resolveImportFileSelection 可能剔除重复文件 → 同步裁剪 parentProvisionalEntries
    const acceptedPathSet = new Set(selectionResult.filePaths);
    const trimmedProvisionalEntries = parentProvisionalEntries.filter((entry) => acceptedPathSet.has(entry.filePath));

    // ===== 步骤 6：合成 fallback templateConfig =====
    // 当所有文件命中同一真实模板时，resolveGenerationTemplateConfig 会返回该模板的 config；
    // 当命中多个模板时，返回本 fallback — 取第一个匹配模板的 config 保底（每条 entry 仍按自身 matchedTemplateId 重新生成行）。
    // fixedAssignments 置空：虚拟 ID 不持久化 fixed 模式顺序，避免错用某个模板的顺序
    const firstMatchedConfig = perTemplateConfigCache.get(perFileMatch[0].matchedTemplate.id);
    const syntheticTemplateConfig = {
      ...firstMatchedConfig,
      fixedAssignments: []
    };

    // ===== 步骤 7：大账号选择流程 =====
    const bigAccountOptions = expandBigAccountConfigurations(aggregatedBigAccounts);

    if (bigAccountOptions.length > 1) {
      const selectionRows = buildBigAccountSelectionRows(trimmedProvisionalEntries);
      if (!selectionRows.length) {
        return createErrorResult({
          step: '导入网银明细文件',
          message: '导入文件中没有账号存在交易数据',
          errorCode: 'NO_TRANSACTION_DATA',
          templateName: virtualTemplateName
        });
      }
      const selectionRowsWithEmpty = buildBigAccountSelectionRows(trimmedProvisionalEntries, { includeEmptyBlocks: true });

      rememberPendingBigAccountSelection({
        templateId: FILENAME_MAPPING_TEMPLATE_ID,
        template: syntheticTemplateConfig.template,
        mappings: syntheticTemplateConfig.exportMappings,
        orderedTargetFields: syntheticTemplateConfig.exportTargetFields,
        inputFilePaths: selectionResult.filePaths,
        bigAccounts: aggregatedBigAccounts,
        fixedAssignments: [],
        fileEntries: trimmedProvisionalEntries,
        rows: selectionRows,
        rowsWithEmptyBlocks: selectionRowsWithEmpty
      });
      return buildBigAccountSelectionRequiredResult({
        rows: selectionRows,
        rowsWithEmptyBlocks: selectionRowsWithEmpty,
        bigAccounts: aggregatedBigAccounts,
        fixedAssignments: [],
        templateId: FILENAME_MAPPING_TEMPLATE_ID
      });
    }

    // ===== 步骤 8：边界 — bigAccountOptions.length <= 1 直接生成 =====
    const selectedBigAccount = bigAccountOptions.length === 1
      ? { merchantId: bigAccountOptions[0].merchantId, currency: bigAccountOptions[0].currency }
      : null;

    // v1.5.2 #9 修复：多文件匹配不同模板时，按模板分组独立生成，确保余额账单银行名/所在地正确
    if (perTemplateConfigCache.size > 1) {
      const { lastResult, lastBatchId, lastGenerationTemplateConfig } = generateMultiTemplateGroupFiles({
        fileEntries: trimmedProvisionalEntries,
        fallbackTemplateConfig: syntheticTemplateConfig,
        selectedBigAccount,
        session,
        replacePaths: selectionResult.replacePaths,
        inputFilePaths: selectionResult.filePaths
      });

      rememberLastFileImportContext({
        templateId: FILENAME_MAPPING_TEMPLATE_ID,
        template: lastGenerationTemplateConfig.template,
        mappings: lastGenerationTemplateConfig.exportMappings,
        orderedTargetFields: lastGenerationTemplateConfig.exportTargetFields,
        inputFilePaths: selectionResult.filePaths,
        selectedBigAccount,
        preparedDetailRows: null,
        scope: 'current',
        statementSessionKey: session.key,
        currentBatchId: lastBatchId
      });

      return lastResult;
    }

    const generationTemplateConfig = resolveGenerationTemplateConfig({
      fileEntries: trimmedProvisionalEntries,
      fallbackTemplateConfig: syntheticTemplateConfig
    });
    const rebuiltFileEntries = rebuildMatchedTemplateFileEntries({
      fileEntries: trimmedProvisionalEntries,
      fallbackTemplateConfig: syntheticTemplateConfig,
      selectedBigAccount
    });
    const generationMerchantMapping = (generationTemplateConfig.exportMappings || []).find(
      (m) => normalizeCell(m.templateField) === 'MerchantId'
    );
    const generationIsMultiBigAccount = normalizeCell(generationMerchantMapping?.mappedField)
      === `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`;
    const genConfig = buildStatementGenerationConfig({
      template: generationTemplateConfig.template,
      mappings: generationTemplateConfig.exportMappings,
      orderedTargetFields: generationTemplateConfig.exportTargetFields,
      selectedBigAccount: generationIsMultiBigAccount ? selectedBigAccount : null,
      allowManagedMerchantWithoutSelection: true
    });
    const preparedBatch = buildPreparedStatementBatchFromEntries({
      config: genConfig,
      fileEntries: rebuiltFileEntries
    });
    const generatedFiles = {
      ...generateStatementFiles({ config: genConfig, preparedBatch, scope: 'current' }),
      fileEntries: rebuiltFileEntries,
      preparedBatch
    };

    selectionResult.replacePaths.forEach((filePath) => {
      removeStatementSessionEntriesByFilePath(session, filePath);
    });

    const batchId = appendStatementSessionImport({
      buildBatchId: buildStatementBatchId,
      lastGeneratedExports,
      session,
      fileEntries: generatedFiles.fileEntries.map((entry) => buildStatementFileEntry({
        ...entry,
        buildEntryId: buildStatementFileEntryId
      }))
    });

    rememberLastFileImportContext({
      templateId: FILENAME_MAPPING_TEMPLATE_ID,
      template: generationTemplateConfig.template,
      mappings: generationTemplateConfig.exportMappings,
      orderedTargetFields: generationTemplateConfig.exportTargetFields,
      inputFilePaths: selectionResult.filePaths,
      selectedBigAccount,
      preparedDetailRows: generatedFiles.preparedBatch.detailRows,
      scope: 'current',
      statementSessionKey: session.key,
      currentBatchId: batchId
    });
    updateStatementSessionCache(session, batchId, generatedFiles);
    return buildImportResultFromGeneratedFiles({
      generatedFiles,
      templateId: FILENAME_MAPPING_TEMPLATE_ID,
      templateName: generationTemplateConfig.template.name,
      inputFilePaths: selectionResult.filePaths
    });
  } catch (error) {
    clearGeneratedExports();
    clearPendingManualBalancePrompt();
    clearPendingBigAccountSelection();

    if (error instanceof FileValidationError) {
      return createErrorResult({
        step: '导入网银明细文件',
        message: error.message,
        errorCode: error.code,
        originalError: error,
        detailLines: Array.isArray(error.detailLines) ? error.detailLines : [],
        context: {
          templateId: FILENAME_MAPPING_TEMPLATE_ID,
          templateName: virtualTemplateName,
          ...(error.context || {})
        },
        templateName: virtualTemplateName
      });
    }

    const logPath = appendLog(ensureStorageRoot(), error);
    return createErrorResult({
      step: '导入网银明细文件',
      message: '文件转换错误，请导出报错文件查看详情',
      errorCode: 'FILE_IMPORT_RUNTIME',
      errorType: '系统错误',
      detailLines: [
        '系统异常已额外写入日志文件。',
        `日志文件：${logPath}`
      ],
      context: {
        templateId: FILENAME_MAPPING_TEMPLATE_ID,
        templateName: virtualTemplateName
      },
      originalError: error,
      templateName: virtualTemplateName
    });
  } finally {
    fileImportInProgress = false;
  }
}

function registerFileHandlers() {
  ipcMain.handle('file:import', async (_event, templateId) => {
    // v1.5.2 需求 3（G3-7）：虚拟 ID 走独立分支
    // 见 handleFilenameMappingImport（文件名+表头双校验 + 整批截断 + 复用大账号选择流程）
    if (isFilenameMappingMode(templateId)) {
      return handleFilenameMappingImport();
    }

    if (fileImportInProgress) {
      return createErrorResult({
        step: '导入网银明细文件',
        message: '上一次导入尚未完成，请稍候',
        errorCode: 'IMPORT_IN_PROGRESS'
      });
    }

    if (!getEnumConfig()) {
      return createErrorResult({
        step: '导入网银明细文件',
        message: MISSING_ENUM_MESSAGE,
        errorCode: 'ENUM_MISSING'
      });
    }

    if (!templateId) {
      return createErrorResult({
        step: '导入网银明细文件',
        message: '请选择模板',
        errorCode: 'TEMPLATE_REQUIRED'
      });
    }

    // v1.5.1: 迁移未完成时阻止导入，避免使用未分配的占位映射
    const migrationPending = database.getSetting('account_mapping_migration_pending');
    if (migrationPending === 'true') {
      return createErrorResult({
        step: '导入网银明细文件',
        message: '账户映射数据迁移尚未完成，请先打开「账户映射」页面完成数据分配',
        errorCode: 'ACCOUNT_MAPPING_MIGRATION_PENDING'
      });
    }

    let templateConfig = null;
    fileImportInProgress = true;

    try {
      clearPendingManualBalancePrompt();
      clearPendingBigAccountSelection();
      templateConfig = getTemplateMappingConfig(templateId);

      if (!templateConfig) {
        return createErrorResult({
          step: '导入网银明细文件',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: statementFileDialogFilters()
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { status: 'cancelled' };
      }

      const inputFilePaths = normalizeInputFilePaths(result.filePaths, { dedupe: false });
      const session = getOrCreateStatementImportSession({
        statementImportSessions,
        templateId,
        templateName: templateConfig.template.name
      });
      const selectionResult = await resolveImportFileSelection({
        templateName: templateConfig.template.name,
        session,
        filePaths: inputFilePaths
      });

      if (selectionResult.status === 'cancelled' || selectionResult.filePaths.length === 0) {
        return { status: 'cancelled' };
      }

      // v1.5.1: 主模板导入 — 自动匹配子模板
      if (templateConfig.template.isParent) {
        const childTemplates = database.listChildTemplates(templateId);
        const candidateTemplates = [templateConfig.template, ...childTemplates];

        const fileTemplateMap = new Map(); // filePath → matchedTemplate
        for (const filePath of selectionResult.filePaths) {
          const matches = matchFileToTemplate(filePath, candidateTemplates);

          if (matches.length === 0) {
            return createErrorResult({
              step: '导入网银明细文件',
              message: `文件 ${path.basename(filePath)} 的表头不匹配主模板或任何子模板，请检查文件或模板配置`,
              errorCode: 'TEMPLATE_HEADER_MISMATCH',
              templateName: templateConfig.template.name
            });
          }

          if (matches.length > 1) {
            return createErrorResult({
              step: '导入网银明细文件',
              message: `文件 ${path.basename(filePath)} 的表头匹配到多个模板（${matches.map((t) => t.name).join('、')}），请检查模板配置`,
              errorCode: 'TEMPLATE_HEADER_AMBIGUOUS',
              templateName: templateConfig.template.name
            });
          }

          fileTemplateMap.set(filePath, matches[0]);
        }



        // 如果所有文件都匹配到主模板自身，无需特殊处理——直接 fall through 到标准流程
        const allMatchParent = [...fileTemplateMap.values()].every((t) => t.id === templateId);
        if (!allMatchParent) {
          // 有文件匹配到子模板——用各自模板配置解析，生成 provisionalFileEntries 后走标准流程
          const parentProvisionalEntries = [];
          const childConfigCache = new Map(); // templateId → matchedConfig
          for (const [filePath, matchedTemplate] of fileTemplateMap) {
            const matchedConfig = matchedTemplate.id === templateId
              ? templateConfig
              : (childConfigCache.get(matchedTemplate.id) || getTemplateMappingConfig(matchedTemplate.id));

            if (!matchedConfig) {
              return createErrorResult({
                step: '导入网银明细文件',
                message: `未找到匹配模板 ${matchedTemplate.name} 的配置`,
                errorCode: 'TEMPLATE_NOT_FOUND',
                context: { templateId: matchedTemplate.id }
              });
            }

            if (matchedTemplate.id !== templateId) {
              childConfigCache.set(matchedTemplate.id, matchedConfig);
            }

            const config = buildStatementGenerationConfig({
              template: matchedConfig.template,
              mappings: matchedConfig.exportMappings,
              orderedTargetFields: matchedConfig.exportTargetFields,
              allowManagedMerchantWithoutSelection: true
            });

            const merchantLookupFlags = buildManagedMerchantLookupFlags(matchedConfig.exportMappings);

            parentProvisionalEntries.push({
              filePath,
              detailRows: buildMappedRowsForFile({ config, inputFilePath: filePath }),
              matchedTemplateId: matchedTemplate.id,
              matchedHeaders: matchedConfig.template.headers || [],
              selfInputMerchant: merchantLookupFlags.selfInputMerchant,
              skipDirectMerchantLookup: merchantLookupFlags.skipDirectMerchantLookup
            });
          }

          // 聚合所有匹配到的模板的大账号配置 + 检查是否有子模板启用了 Balance
          const aggregatedBigAccounts = templateConfig.bigAccounts.map((ba) => ({ ...ba }));
          for (const [, childConfig] of childConfigCache) {
            for (const ba of (childConfig.bigAccounts || [])) {
              const mid = normalizeCell(ba.merchantId);
              if (!mid) continue;
              const existing = aggregatedBigAccounts.find((a) => normalizeCell(a.merchantId) === mid);
              if (existing) {
                const newCurrencies = (Array.isArray(ba.currencies) ? ba.currencies : [])
                  .map((c) => normalizeCell(c)).filter((c) => c !== '');
                const existingCurrencies = Array.isArray(existing.currencies) ? existing.currencies : [];
                existing.currencies = Array.from(new Set([...existingCurrencies, ...newCurrencies]));
                existing.isMultiCurrency = existing.currencies.length > 1;
              } else {
                aggregatedBigAccounts.push({ ...ba });
              }
            }
          }

          // 将解析结果注入到 selectionResult 上下文中，供标准流程使用
          selectionResult.parentProvisionalEntries = parentProvisionalEntries;
          selectionResult.aggregatedBigAccounts = aggregatedBigAccounts;
        }
        // fall through to standard flow below
      }

      const effectiveBigAccounts = selectionResult.aggregatedBigAccounts || templateConfig.bigAccounts;
      const bigAccountOptions = expandBigAccountConfigurations(effectiveBigAccounts);
      const isMerchantIdSelfInput = templateConfig.exportMappings.some(
        (mapping) => mapping.templateField === 'MerchantId' && mapping.mappedField === MERCHANT_ID_SELF_INPUT_OPTION
      );

      if (bigAccountOptions.length > 1) {
        const provisionalFileEntries = selectionResult.parentProvisionalEntries
          || buildPendingBigAccountFileEntries({
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            inputFilePaths: selectionResult.filePaths
          });
        const savedMode = readBigAccountMode(ensureStorageRoot(), templateId);
        const savedOrderConfig = readBigAccountOrder(ensureStorageRoot(), templateId);


        let forceUnfixedMode = false;
        if (savedMode === 'fixed' && savedOrderConfig && Array.isArray(savedOrderConfig.files) && savedOrderConfig.files.length > 0) {
          const importFileCount = selectionResult.filePaths.length;

          if (importFileCount !== savedOrderConfig.fileCount) {
            // 文件个数不等于"记住顺序"里的文件个数 → 降级为"不固定"模式
            forceUnfixedMode = true;
          } else if (importFileCount === savedOrderConfig.fileCount) {
            const allMerchantIds = effectiveBigAccounts.map((ba) => normalizeCell(ba.merchantId)).filter((id) => id !== '');
            const defaultExpectedSourceHeaders = templateConfig.template.headers || [];
            const failedFileNames = [];

            // 每个导入文件用账户个数+账户号去全部保存文件里找匹配（不按位置对位）
            const usedSavedIndices = new Set();
            const fileMatchMap = new Map(); // importIndex → savedFileIndex

            provisionalFileEntries.forEach((entry, fileIndex) => {
              const entryHeaders = entry.matchedHeaders || defaultExpectedSourceHeaders;
              let fileResult = entry.skipDirectMerchantLookup
                ? { accounts: [], isSingleAccount: false }
                : identifyAccountsFromFile({
                    filePath: entry.filePath,
                    detailRows: entry.detailRows,
                    expectedSourceHeaders: entryHeaders,
                    allMerchantIds
                  });

              // 自定义输入 MerchantId：通过账户映射桥接提取（merchantId 不在文件中，跳过全文搜索）
              if (fileResult.accounts.length === 0 && entry.selfInputMerchant) {
                if (entry.matchedTemplateId) {
                  const rawRowsFull = readRows(entry.filePath, { blankrows: true });
                  const acctMappings = database.listAccountMappings(entry.matchedTemplateId);
                  const bankIdToMerchant = new Map();
                  for (const am of acctMappings) {
                    const bankId = normalizeCell(am.bankAccountId);
                    const clearingId = normalizeCell(am.clearingAccountId);
                    if (bankId && clearingId) bankIdToMerchant.set(bankId, clearingId);
                  }
                  if (bankIdToMerchant.size > 0) {
                    const bankIds = [...bankIdToMerchant.keys()];
                    const bigAccountOpts = expandBigAccountConfigurations(effectiveBigAccounts);
                    for (let rowIdx = 0; rowIdx < rawRowsFull.length && fileResult.accounts.length === 0; rowIdx += 1) {
                      const row = rawRowsFull[rowIdx];
                      if (!Array.isArray(row)) continue;
                      for (const cell of row) {
                        const cellStr = normalizeCell(cell);
                        if (!cellStr) continue;
                        for (const bankId of bankIds) {
                          if (matchMerchantIds(cellStr, bankId) !== 'none') {
                            const clearingId = bankIdToMerchant.get(bankId);
                            const matched = bigAccountOpts.find((o) => matchMerchantIds(clearingId, o.merchantId) !== 'none');
                            if (matched) {
                              fileResult = { accounts: [{ merchantId: matched.merchantId, matchType: 'exact' }], isSingleAccount: true };
                              break;
                            }
                          }
                        }
                        if (fileResult.accounts.length > 0) break;
                      }
                    }
                  }
                }
              }

              let matchedSavedIndex = -1;
              for (let si = 0; si < savedOrderConfig.files.length; si += 1) {
                if (usedSavedIndices.has(si)) continue;
                const savedFile = savedOrderConfig.files[si];

                if (fileResult.accounts.length !== savedFile.accountCount) continue;

                const allAccountsMatch = savedFile.accounts.every((savedAccount) => {
                  return fileResult.accounts.some((identified) => matchMerchantIds(identified.merchantId, savedAccount.merchantId) !== 'none');
                });

                if (allAccountsMatch) {
                  matchedSavedIndex = si;
                  break;
                }
              }

              if (matchedSavedIndex >= 0) {
                usedSavedIndices.add(matchedSavedIndex);
                fileMatchMap.set(fileIndex, matchedSavedIndex);
              } else {
                failedFileNames.push(path.basename(entry.filePath));
              }
            });

            if (failedFileNames.length === 0 && Array.isArray(savedOrderConfig.assignments) && savedOrderConfig.assignments.length > 0) {
              // 按 fileMatchMap 重排 assignments：按导入文件顺序重组保存的 assignments
              const savedFiles = savedOrderConfig.files || [];
              const savedAssignments = savedOrderConfig.assignments || [];

              // 计算每个保存文件的 assignment 范围（基于 accountCount 累加）
              const savedFileRanges = [];
              let cumulativeIndex = 0;
              savedFiles.forEach((sf) => {
                const count = sf.accountCount || 0;
                savedFileRanges.push({ start: cumulativeIndex, count });
                cumulativeIndex += count;
              });

              // 按导入文件顺序重组
              const reorderedAssignments = [];
              let newRowIndex = 0;
              for (let importIdx = 0; importIdx < provisionalFileEntries.length; importIdx += 1) {
                const savedIdx = fileMatchMap.get(importIdx);
                if (savedIdx === undefined) continue;
                const range = savedFileRanges[savedIdx];
                if (!range) continue;
                const slice = savedAssignments.slice(range.start, range.start + range.count);
                slice.forEach((a) => {
                  reorderedAssignments.push({ ...a, rowIndex: newRowIndex });
                  newRowIndex += 1;
                });
              }

              rememberPendingBigAccountSelection({
                templateId,
                template: templateConfig.template,
                mappings: templateConfig.exportMappings,
                orderedTargetFields: templateConfig.exportTargetFields,
                inputFilePaths: selectionResult.filePaths,
                bigAccounts: effectiveBigAccounts,
                fixedAssignments: templateConfig.fixedAssignments,
                fileEntries: provisionalFileEntries,
                rows: buildBigAccountSelectionRows(provisionalFileEntries),
                rowsWithEmptyBlocks: buildBigAccountSelectionRows(provisionalFileEntries, { includeEmptyBlocks: true }),
              });

              const autoResult = await ipcMain.emit('__internal-complete-big-account-selection__') || null;
              if (!autoResult) {
                try {
                  const directResult = await (async () => {
                    const pendingContext = lastPendingBigAccountSelection;
                    const isFixedMode = true;
                    const expectedRows = pendingContext.rowsWithEmptyBlocks || pendingContext.rows;
                    const normalizedAssignments = reorderedAssignments
                      .map((assignment) => {
                        const matchedAccount = effectiveBigAccounts.find((item) => item.merchantId === assignment.merchantId);
                        if (!matchedAccount) return null;
                        const availableCurrencies = Array.isArray(matchedAccount.currencies) ? matchedAccount.currencies : [];
                        const normalizedCurrency = matchedAccount.isMultiCurrency
                          ? normalizeCell(assignment.currency)
                          : normalizeCell(availableCurrencies[0] || assignment.currency);
                        if (!normalizedCurrency || !availableCurrencies.includes(normalizedCurrency)) return null;
                        return { merchantId: matchedAccount.merchantId, currency: normalizedCurrency, rowIndex: assignment.rowIndex };
                      })
                      .filter((a) => a !== null)
                      .sort((left, right) => left.rowIndex - right.rowIndex);

                    if (normalizedAssignments.length !== expectedRows.length) {
                      // Log first few filtered-out assignments
                      savedOrderConfig.assignments.forEach((a, i) => {
                        const matched = effectiveBigAccounts.find((item) => item.merchantId === a.merchantId);
                        if (!matched) {
                        } else {
                          const avail = Array.isArray(matched.currencies) ? matched.currencies : [];
                          const nc = matched.isMultiCurrency ? normalizeCell(a.currency) : normalizeCell(avail[0] || a.currency);
                          if (!nc || !avail.includes(nc)) {
                          }
                        }
                      });
                      return null;
                    }

                    const resolvedFileEntries = applyBigAccountAssignmentsToFileEntries(
                      pendingContext.fileEntries,
                      normalizedAssignments,
                      { includeEmptyBlocks: isFixedMode }
                    );
                    const fallbackTemplateConfig = {
                      template: pendingContext.template,
                      exportMappings: pendingContext.mappings,
                      exportTargetFields: pendingContext.orderedTargetFields
                    };
                    const generationTemplateConfig = resolveGenerationTemplateConfig({
                      fileEntries: resolvedFileEntries,
                      fallbackTemplateConfig
                    });
                    const generationConfig = buildStatementGenerationConfig({
                      template: generationTemplateConfig.template,
                      mappings: generationTemplateConfig.exportMappings,
                      orderedTargetFields: generationTemplateConfig.exportTargetFields,
                      allowManagedMerchantWithoutSelection: true
                    });
                    const preparedBatch = statementGenerationHelpers.buildPreparedStatementBatchFromEntries({
                      config: generationConfig,
                      fileEntries: resolvedFileEntries
                    });
                    const generatedFiles = {
                      ...generateStatementFiles({
                        config: generationConfig,
                        preparedBatch,
                        scope: 'current'
                      }),
                      fileEntries: resolvedFileEntries.map((entry) => buildStatementFileEntry({
                        ...entry,
                        buildEntryId: buildStatementFileEntryId
                      })),
                      preparedBatch
                    };

                    pendingContext.inputFilePaths.forEach((fp) => {
                      removeStatementSessionEntriesByFilePath(session, fp);
                    });
                    const batchId = appendStatementSessionImport({
                      buildBatchId: buildStatementBatchId,
                      lastGeneratedExports,
                      session,
                      fileEntries: generatedFiles.fileEntries
                    });
                    rememberLastFileImportContext({
                      templateId: generationTemplateConfig.template.id || pendingContext.templateId,
                      template: generationTemplateConfig.template,
                      mappings: generationTemplateConfig.exportMappings,
                      orderedTargetFields: generationTemplateConfig.exportTargetFields,
                      inputFilePaths: pendingContext.inputFilePaths,
                      selectedBigAccount: null,
                      preparedDetailRows: generatedFiles.preparedBatch.detailRows,
                      scope: 'current',
                      statementSessionKey: session.key,
                      currentBatchId: batchId
                    });
                    clearPendingBigAccountSelection();
                    updateStatementSessionCache(session, batchId, generatedFiles);
                    return buildImportResultFromGeneratedFiles({
                      generatedFiles,
                      templateId: pendingContext.templateId,
                      templateName: generationTemplateConfig.template.name,
                      inputFilePaths: pendingContext.inputFilePaths
                    });
                  })();

                  if (directResult) {
                    return directResult;
                  }
                } catch (_autoMatchError) {
                  // Fall through to manual selection
                }
              }
            }

            if (failedFileNames.length > 0) {
              rememberPendingBigAccountSelection({
                templateId,
                template: templateConfig.template,
                mappings: templateConfig.exportMappings,
                orderedTargetFields: templateConfig.exportTargetFields,
                inputFilePaths: selectionResult.filePaths,
                bigAccounts: effectiveBigAccounts,
                fixedAssignments: templateConfig.fixedAssignments,
                fileEntries: provisionalFileEntries,
                rows: buildBigAccountSelectionRows(provisionalFileEntries),
                rowsWithEmptyBlocks: buildBigAccountSelectionRows(provisionalFileEntries, { includeEmptyBlocks: true }),
              });
              return {
                status: 'remember-order-mismatch',
                message: failedFileNames
                  .map((name) => `${name}的账户个数或账户号匹配不上（账户个数和账户号都匹配不上），请检查。`)
                  .join('\n'),
                failedFileNames,
                selectionMode: 'multi-row',
                templateId,
                rows: buildBigAccountSelectionRows(provisionalFileEntries).map((row, index) => ({
                  index: Number.isInteger(row.index) ? row.index : index,
                  label: `${index + 1}.`,
                  sourceRowNumber: Number(row.sourceRowNumber || 0),
                  fileName: normalizeCell(row.fileName),
              filePath: row.filePath || ''
                })),
                rowsWithEmptyBlocks: buildBigAccountSelectionRows(provisionalFileEntries, { includeEmptyBlocks: true }).map((row, index) => ({
                  index: Number.isInteger(row.index) ? row.index : index,
                  label: `${index + 1}.`,
                  sourceRowNumber: Number(row.sourceRowNumber || 0),
                  fileName: normalizeCell(row.fileName),
              filePath: row.filePath || ''
                })),
                bigAccounts: effectiveBigAccounts.map((item) => ({
                  merchantId: normalizeCell(item.merchantId),
                  currencies: Array.isArray(item.currencies)
                    ? item.currencies.map((value) => normalizeCell(value)).filter((value) => value !== '')
                    : [],
                  isMultiCurrency: Boolean(item.isMultiCurrency)
                })),
                expandedBigAccountOptions: expandBigAccountConfigurations(effectiveBigAccounts),
                fixedAssignments: (templateConfig.fixedAssignments || []).map((item) => ({
                  merchantId: normalizeCell(item.merchantId),
                  currency: normalizeCell(item.currency),
                  rowIndex: Number(item.rowIndex || 0)
                })),
                forceMode: 'fixed'
              };
            }
          }
        }

        const selectionRows = buildBigAccountSelectionRows(provisionalFileEntries);

        if (!selectionRows.length) {
          return createErrorResult({
            step: '导入网银明细文件',
            message: '导入文件中没有账号存在交易数据',
            errorCode: 'NO_TRANSACTION_DATA',
            templateName: templateConfig.template.name
          });
        }

        const selectionRowsWithEmpty = buildBigAccountSelectionRows(provisionalFileEntries, { includeEmptyBlocks: true });

        rememberPendingBigAccountSelection({
          templateId,
          template: templateConfig.template,
          mappings: templateConfig.exportMappings,
          orderedTargetFields: templateConfig.exportTargetFields,
          inputFilePaths: selectionResult.filePaths,
          bigAccounts: effectiveBigAccounts,
          fixedAssignments: templateConfig.fixedAssignments,
          fileEntries: provisionalFileEntries,
          rows: selectionRows,
          rowsWithEmptyBlocks: selectionRowsWithEmpty,
          });
        const selectionRequired = buildBigAccountSelectionRequiredResult({
          rows: selectionRows,
          rowsWithEmptyBlocks: selectionRowsWithEmpty,
          bigAccounts: effectiveBigAccounts,
          fixedAssignments: templateConfig.fixedAssignments,
          templateId
        });
        if (forceUnfixedMode) {
          selectionRequired.forceMode = 'unfixed';
        }
        return selectionRequired;
      }

      if (isMerchantIdSelfInput && bigAccountOptions.length <= 1) {
        const inputFileCount = selectionResult.filePaths.length;
        const provisionalFileEntries = selectionResult.parentProvisionalEntries
          || buildPendingBigAccountFileEntries({
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            inputFilePaths: selectionResult.filePaths
          });
        const totalBlocks = provisionalFileEntries.reduce((sum, entry) => {
          return sum + identifyAccountBlocks(entry.detailRows).length;
        }, 0);

        if (totalBlocks === 0) {
          return createErrorResult({
            step: '导入网银明细文件',
            message: '导入文件中没有账号存在交易数据',
            errorCode: 'NO_TRANSACTION_DATA',
            templateName: templateConfig.template.name
          });
        }

        const needsSelection = inputFileCount > 1 || totalBlocks > 1;

        if (needsSelection) {
          if (!effectiveBigAccounts.length) {
            return createErrorResult({
              step: '导入网银明细文件',
              message: '请先在映射管理中维护大账号列表',
              errorCode: 'BIG_ACCOUNT_REQUIRED'
            });
          }

          const selectionRows = buildBigAccountSelectionRows(provisionalFileEntries);

          if (!selectionRows.length) {
            return createErrorResult({
              step: '导入网银明细文件',
              message: '导入文件中没有账号存在交易数据',
              errorCode: 'NO_TRANSACTION_DATA',
              templateName: templateConfig.template.name
            });
          }

          const selectionRowsWithEmpty = buildBigAccountSelectionRows(provisionalFileEntries, { includeEmptyBlocks: true });
          rememberPendingBigAccountSelection({
            templateId,
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            inputFilePaths: selectionResult.filePaths,
            bigAccounts: effectiveBigAccounts,
            fixedAssignments: templateConfig.fixedAssignments,
            fileEntries: provisionalFileEntries,
            rows: selectionRows,
            rowsWithEmptyBlocks: selectionRowsWithEmpty,
              });
          return buildBigAccountSelectionRequiredResult({
            rows: selectionRows,
            rowsWithEmptyBlocks: selectionRowsWithEmpty,
            bigAccounts: effectiveBigAccounts,
            fixedAssignments: templateConfig.fixedAssignments,
            templateId
          });
        }
      }

      const selectedBigAccount = bigAccountOptions.length === 1
        ? {
            merchantId: bigAccountOptions[0].merchantId,
            currency: bigAccountOptions[0].currency
          }
        : null;

      let generatedFiles;
      if (selectionResult.parentProvisionalEntries) {
        const generationTemplateConfig = resolveGenerationTemplateConfig({
          fileEntries: selectionResult.parentProvisionalEntries,
          fallbackTemplateConfig: templateConfig
        });
        const rebuiltFileEntries = rebuildMatchedTemplateFileEntries({
          fileEntries: selectionResult.parentProvisionalEntries,
          fallbackTemplateConfig: templateConfig,
          selectedBigAccount
        });
        // batch 级 config 也需按实际模板类型决定是否传 selectedBigAccount
        const generationMerchantMapping = (generationTemplateConfig.exportMappings || []).find(
          (m) => normalizeCell(m.templateField) === 'MerchantId'
        );
        const generationIsMultiBigAccount = normalizeCell(generationMerchantMapping?.mappedField)
          === `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`;
        const config = buildStatementGenerationConfig({
          template: generationTemplateConfig.template,
          mappings: generationTemplateConfig.exportMappings,
          orderedTargetFields: generationTemplateConfig.exportTargetFields,
          selectedBigAccount: generationIsMultiBigAccount ? selectedBigAccount : null,
          allowManagedMerchantWithoutSelection: true
        });
        const preparedBatch = buildPreparedStatementBatchFromEntries({
          config,
          fileEntries: rebuiltFileEntries
        });
        generatedFiles = {
          ...generateStatementFiles({
            config,
            preparedBatch,
            scope: 'current'
          }),
          fileEntries: rebuiltFileEntries,
          preparedBatch
        };
      } else {
        generatedFiles = prepareGeneratedFiles({
          template: templateConfig.template,
          mappings: templateConfig.exportMappings,
          orderedTargetFields: templateConfig.exportTargetFields,
          inputFilePaths: selectionResult.filePaths,
          selectedBigAccount
        });
      }

      const rememberedTemplateConfig = selectionResult.parentProvisionalEntries
        ? resolveGenerationTemplateConfig({
            fileEntries: generatedFiles.fileEntries,
            fallbackTemplateConfig: templateConfig
          })
        : templateConfig;

      selectionResult.replacePaths.forEach((filePath) => {
        removeStatementSessionEntriesByFilePath(session, filePath);
      });

      const batchId = appendStatementSessionImport({
        buildBatchId: buildStatementBatchId,
        lastGeneratedExports,
        session,
        fileEntries: generatedFiles.fileEntries.map((entry) => buildStatementFileEntry({
          ...entry,
          buildEntryId: buildStatementFileEntryId
        }))
      });

      rememberLastFileImportContext({
        templateId: rememberedTemplateConfig.template.id || templateId,
        template: rememberedTemplateConfig.template,
        mappings: rememberedTemplateConfig.exportMappings,
        orderedTargetFields: rememberedTemplateConfig.exportTargetFields,
        inputFilePaths: selectionResult.filePaths,
        selectedBigAccount,
        preparedDetailRows: generatedFiles.preparedBatch.detailRows,
        scope: 'current',
        statementSessionKey: session.key,
        currentBatchId: batchId,
      });
      updateStatementSessionCache(session, batchId, generatedFiles);
      return buildImportResultFromGeneratedFiles({
        generatedFiles,
        templateId,
        templateName: rememberedTemplateConfig.template.name,
        inputFilePaths: selectionResult.filePaths
      });
    } catch (error) {
      clearGeneratedExports();
      clearPendingManualBalancePrompt();
      clearPendingBigAccountSelection();

      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '导入网银明细文件',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          detailLines: Array.isArray(error.detailLines) ? error.detailLines : [],
          context: {
            templateId,
            templateName: templateConfig?.template?.name || '',
            ...(error.context || {})
          },
          templateName: templateConfig?.template?.name || ''
        });
      }

      const logPath = appendLog(ensureStorageRoot(), error);
      return createErrorResult({
        step: '导入网银明细文件',
        message: '文件转换错误，请导出报错文件查看详情',
        errorCode: 'FILE_IMPORT_RUNTIME',
        errorType: '系统错误',
        detailLines: [
          '系统异常已额外写入日志文件。',
          `日志文件：${logPath}`
        ],
        context: {
          templateId,
          templateName: templateConfig?.template?.name || ''
        },
        originalError: error,
        templateName: templateConfig?.template?.name || ''
      });
    } finally {
      fileImportInProgress = false;
    }
  });

  ipcMain.handle('file:cancel-big-account-selection', () => {
    clearPendingBigAccountSelection();
    return { status: 'success' };
  });

  ipcMain.handle('file:complete-big-account-selection', async (_event, payload = {}) => {
    const pendingContext = lastPendingBigAccountSelection;

    if (!pendingContext) {
      return createErrorResult({
        step: '选择大账号',
        message: '当前没有待处理的大账号选择任务，请重新导入文件',
        errorCode: 'BIG_ACCOUNT_SELECTION_MISSING'
      });
    }

    const groupedBigAccounts = Array.isArray(pendingContext.bigAccounts) ? pendingContext.bigAccounts : [];
    const assignments = Array.isArray(payload.assignments)
      ? payload.assignments.map((item, index) => ({
          merchantId: normalizeCell(item.merchantId),
          currency: normalizeCell(item.currency),
          rowIndex: Number.isInteger(item.index) ? item.index : (Number.isInteger(item.rowIndex) ? item.rowIndex : index)
        }))
      : [];

    const isFixedMode = payload.mode === 'fixed';
    const expectedRows = isFixedMode
      ? (pendingContext.rowsWithEmptyBlocks || pendingContext.rows)
      : pendingContext.rows;

    if (!assignments.length || assignments.length !== expectedRows.length) {
      return createErrorResult({
        step: '选择大账号',
        message: `请选择有效的大账号 / 币种（需要 ${expectedRows.length} 个，当前 ${assignments.length} 个）`,
        errorCode: 'BIG_ACCOUNT_SELECTION_INVALID',
        templateName: pendingContext.template.name
      });
    }

    const normalizedAssignments = assignments.map((assignment) => {
      const matchedAccount = groupedBigAccounts.find((item) => item.merchantId === assignment.merchantId);

      if (!matchedAccount) {
        throw new FileValidationError('FILE_READ', '请选择有效的大账号 / 币种');
      }

      const availableCurrencies = Array.isArray(matchedAccount.currencies) ? matchedAccount.currencies : [];
      const normalizedCurrency = matchedAccount.isMultiCurrency
        ? normalizeCell(assignment.currency)
        : normalizeCell(availableCurrencies[0] || assignment.currency);

      if (!normalizedCurrency || !availableCurrencies.includes(normalizedCurrency)) {
        throw new FileValidationError('FILE_READ', `大账号 ${matchedAccount.merchantId} 的币种选择无效`);
      }

      return {
        merchantId: matchedAccount.merchantId,
        currency: normalizedCurrency,
        rowIndex: assignment.rowIndex
      };
    }).sort((left, right) => left.rowIndex - right.rowIndex);

    try {
      const session = getOrCreateStatementImportSession({
        statementImportSessions,
        templateId: pendingContext.templateId,
        templateName: pendingContext.template.name
      });

      const resolvedFileEntries = applyBigAccountAssignmentsToFileEntries(
        pendingContext.fileEntries,
        normalizedAssignments,
        { includeEmptyBlocks: isFixedMode }
      );
      const fallbackTemplateConfig = {
        template: pendingContext.template,
        exportMappings: pendingContext.mappings,
        exportTargetFields: pendingContext.orderedTargetFields
      };

      // v1.5.2 #9 修复：按文件名映射模板 + 多模板时，分组独立生成
      const distinctTemplateIds = new Set(
        resolvedFileEntries.map((entry) => entry.matchedTemplateId || 0)
      );
      if (isFilenameMappingMode(pendingContext.templateId) && distinctTemplateIds.size > 1) {
        const { lastResult, lastBatchId, lastGenerationTemplateConfig } = generateMultiTemplateGroupFiles({
          fileEntries: resolvedFileEntries,
          fallbackTemplateConfig,
          selectedBigAccount: null,
          session,
          replacePaths: pendingContext.inputFilePaths,
          inputFilePaths: pendingContext.inputFilePaths
        });

        rememberLastFileImportContext({
          templateId: FILENAME_MAPPING_TEMPLATE_ID,
          template: lastGenerationTemplateConfig.template,
          mappings: lastGenerationTemplateConfig.exportMappings,
          orderedTargetFields: lastGenerationTemplateConfig.exportTargetFields,
          inputFilePaths: pendingContext.inputFilePaths,
          selectedBigAccount: null,
          preparedDetailRows: null,
          scope: 'current',
          statementSessionKey: session.key,
          currentBatchId: lastBatchId,
        });
        clearPendingBigAccountSelection();
        return lastResult;
      }

      const generationTemplateConfig = resolveGenerationTemplateConfig({
        fileEntries: resolvedFileEntries,
        fallbackTemplateConfig
      });
      const generationConfig = buildStatementGenerationConfig({
        template: generationTemplateConfig.template,
        mappings: generationTemplateConfig.exportMappings,
        orderedTargetFields: generationTemplateConfig.exportTargetFields,
        allowManagedMerchantWithoutSelection: true
      });
      const preparedBatch = statementGenerationHelpers.buildPreparedStatementBatchFromEntries({
        config: generationConfig,
        fileEntries: resolvedFileEntries
      });
      const generatedFiles = {
        ...generateStatementFiles({
          config: generationConfig,
          preparedBatch,
          scope: 'current'
        }),
        fileEntries: resolvedFileEntries.map((entry) => buildStatementFileEntry({
          ...entry,
          buildEntryId: buildStatementFileEntryId
        })),
        preparedBatch
      };

      pendingContext.inputFilePaths.forEach((filePath) => {
        removeStatementSessionEntriesByFilePath(session, filePath);
      });
      const batchId = appendStatementSessionImport({
        buildBatchId: buildStatementBatchId,
        lastGeneratedExports,
        session,
        fileEntries: generatedFiles.fileEntries
      });
      rememberLastFileImportContext({
        templateId: generationTemplateConfig.template.id || pendingContext.templateId,
        template: generationTemplateConfig.template,
        mappings: generationTemplateConfig.exportMappings,
        orderedTargetFields: generationTemplateConfig.exportTargetFields,
        inputFilePaths: pendingContext.inputFilePaths,
        selectedBigAccount: null,
        preparedDetailRows: generatedFiles.preparedBatch.detailRows,
        scope: 'current',
        statementSessionKey: session.key,
        currentBatchId: batchId,
      });
      clearPendingBigAccountSelection();
      updateStatementSessionCache(session, batchId, generatedFiles);
      return buildImportResultFromGeneratedFiles({
        generatedFiles,
        templateId: pendingContext.templateId,
        templateName: generationTemplateConfig.template.name,
        inputFilePaths: pendingContext.inputFilePaths
      });
    } catch (error) {
      clearGeneratedExports();
      clearPendingManualBalancePrompt();

      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '选择大账号',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          detailLines: Array.isArray(error.detailLines) ? error.detailLines : [],
          context: {
            templateId: pendingContext.templateId,
            templateName: pendingContext.template.name,
            ...(error.context || {})
          },
          templateName: pendingContext.template.name
        });
      }

      const logPath = appendLog(ensureStorageRoot(), error);
      return createErrorResult({
        step: '选择大账号',
        message: '文件转换错误，请导出报错文件查看详情',
        errorCode: 'BIG_ACCOUNT_SELECTION_RUNTIME',
        errorType: '系统错误',
        detailLines: [
          '系统异常已额外写入日志文件。',
          `日志文件：${logPath}`
        ],
        context: {
          templateId: pendingContext.templateId,
          templateName: pendingContext.template.name
        },
        originalError: error,
        templateName: pendingContext.template.name
      });
    }
  });


  ipcMain.handle('file:extract-big-account-order', (_event, payload = {}) => {
    const pendingContext = lastPendingBigAccountSelection;
    const mode = payload?.mode || 'unfixed';
    const frontendFileRows = Array.isArray(payload?.fileRows) ? payload.fileRows : [];

    if (!pendingContext) {
      return { status: 'error', failedRows: [], message: '当前没有待处理的大账号选择任务，请重新导入文件' };
    }

    const allMerchantIds = (pendingContext.bigAccounts || []).map((ba) => normalizeCell(ba.merchantId)).filter((id) => id !== '');
    const defaultExpectedSourceHeaders = pendingContext.template?.headers || [];
    const expandedOptions = expandBigAccountConfigurations(pendingContext.bigAccounts || []);

    // 构建 filePath → matchedHeaders 映射（用于子模板文件的 header 行检测）
    const fileHeadersMap = new Map();
    (pendingContext.fileEntries || []).forEach((entry) => {
      if (entry.matchedHeaders) {
        fileHeadersMap.set(entry.filePath, entry.matchedHeaders);
      }
    });

    try {
      const accounts = [];
      const failedRows = [];
      const ambiguousCurrencyFiles = [];
      let globalIndex = 0;

      if (mode !== 'fixed' && frontendFileRows.length > 0) {
        // 不固定模式：按前端传来的 fileRows（左侧面板显示的行）逐行提取
        // 每个 fileRow 有 sourceRowNumber + fileName，根据 sourceRowNumber 在原始文件里找对应的账户号
        const fileEntriesByPath = new Map();
        (pendingContext.fileEntries || []).forEach((entry) => {
          fileEntriesByPath.set(entry.filePath, entry);
        });

        // 预缓存每个文件的原始行和 headerRowNumbers
        const fileCache = new Map();
        fileEntriesByPath.forEach((entry, filePath) => {
          const rawRows = readRows(filePath, { blankrows: true });
          const fileExpectedHeaders = fileHeadersMap.get(filePath) || defaultExpectedSourceHeaders;
          const headerRowNumbers = findHeaderRowNumbersInRawRows(rawRows, fileExpectedHeaders);
          fileCache.set(filePath, { rawRows, headerRowNumbers, entry });
        });

        frontendFileRows.forEach((fr) => {
          const cached = fileCache.get(fr.filePath || '') || fileCache.get(
            // fallback: 按 basename 匹配（兼容旧数据）
            [...fileCache.keys()].find((fp) => path.basename(fp) === fr.fileName) || ''
          );

          if (!cached) {
            failedRows.push({ index: globalIndex, fileName: fr.fileName || '' });
            globalIndex += 1;
            return;
          }

          const { rawRows, headerRowNumbers } = cached;
          const sourceRow = Number(fr.sourceRowNumber || 0);

          // 找到该行所属的 header（最后一个 <= sourceRow 的 headerRowNumber）
          let headerIdx = -1;
          for (let hi = headerRowNumbers.length - 1; hi >= 0; hi -= 1) {
            if (headerRowNumbers[hi] <= sourceRow) {
              headerIdx = hi;
              break;
            }
          }

          let bestMatch = null;

          if (headerIdx >= 0 && !cached.entry?.skipDirectMerchantLookup) {
            // 在该 header 前面的行里搜索账户号（倒序搜索，避免数据行污染）——仅非自定义输入模板
            const candidateStart = headerIdx === 0 ? 0 : headerRowNumbers[headerIdx - 1];
            const narrowStart = Math.max(candidateStart, headerRowNumbers[headerIdx] - 10);
            const candidateEnd = headerRowNumbers[headerIdx] - 2;

            for (let rowIdx = Math.min(candidateEnd, rawRows.length - 1); rowIdx >= narrowStart; rowIdx -= 1) {
              const row = rawRows[rowIdx];
              if (!Array.isArray(row)) continue;
              for (const cell of row) {
                const cellStr = normalizeCell(cell);
                if (!cellStr) continue;
                for (const mid of allMerchantIds) {
                  const result = matchMerchantIds(cellStr, mid);
                  if (result === 'exact') { bestMatch = { merchantId: mid, matchType: 'exact' }; break; }
                  if (result === 'fuzzy' && (!bestMatch || bestMatch.matchType !== 'exact')) {
                    bestMatch = { merchantId: mid, matchType: 'fuzzy' };
                  }
                }
                if (bestMatch?.matchType === 'exact') break;
              }
              if (bestMatch?.matchType === 'exact') break;
            }
          }


          // 自定义输入 MerchantId：通过账户映射桥接提取（merchantId 不在文件中，跳过全文搜索）
          if (!bestMatch && cached.entry && cached.entry.selfInputMerchant) {
            if (cached.entry.matchedTemplateId) {
              const acctMappings = database.listAccountMappings(cached.entry.matchedTemplateId);
              const bankIdToMerchant = new Map();
              for (const am of acctMappings) {
                const bankId = normalizeCell(am.bankAccountId);
                const clearingId = normalizeCell(am.clearingAccountId);
                if (bankId && clearingId) bankIdToMerchant.set(bankId, clearingId);
              }
              if (bankIdToMerchant.size > 0) {
                const bankIds = [...bankIdToMerchant.keys()];
                for (let rowIdx = 0; rowIdx < rawRows.length && !bestMatch; rowIdx += 1) {
                  const row = rawRows[rowIdx];
                  if (!Array.isArray(row)) continue;
                  for (const cell of row) {
                    const cellStr = normalizeCell(cell);
                    if (!cellStr) continue;
                    for (const bankId of bankIds) {
                      if (matchMerchantIds(cellStr, bankId) !== 'none') {
                        const clearingId = bankIdToMerchant.get(bankId);
                        const matched = expandedOptions.find((o) => matchMerchantIds(clearingId, o.merchantId) !== 'none');
                        if (matched) {
                          bestMatch = { merchantId: matched.merchantId, matchType: 'exact', viaBridge: true };
                          break;
                        }
                      }
                    }
                    if (bestMatch) break;
                  }
                }
              }
            }
            // 桥接匹配成功但 merchantId 有多个币种 — 标记币种不确定
            if (bestMatch && bestMatch.viaBridge) {
              const currencyCount = expandedOptions.filter((o) => matchMerchantIds(bestMatch.merchantId, o.merchantId) !== 'none').length;
              if (currencyCount > 1) {
                ambiguousCurrencyFiles.push(fr.fileName || '');
              }
            }
          }

          if (bestMatch) {
            const matched = expandedOptions.find((o) => matchMerchantIds(bestMatch.merchantId, o.merchantId) !== 'none');
            if (matched) {
              accounts.push({ merchantId: matched.merchantId, currency: matched.currency, matchType: bestMatch.matchType, fileName: fr.fileName });
            } else {
              failedRows.push({ index: globalIndex, fileName: fr.fileName || '' });
            }
          } else if (headerIdx < 0 && !cached.entry?.skipDirectMerchantLookup) {

            failedRows.push({ index: globalIndex, fileName: fr.fileName || '' });
          } else {

            failedRows.push({ index: globalIndex, fileName: fr.fileName || '' });
          }
          globalIndex += 1;
        });
      } else {
        // 固定模式（或没传 fileRows 的 fallback）：提取全量账户
        (pendingContext.fileEntries || []).forEach((entry) => {
          const fileName = path.basename(entry.filePath);
          const fileExpectedHeaders = fileHeadersMap.get(entry.filePath) || defaultExpectedSourceHeaders;
          // selfInputMerchant 的文件跳过标准提取（避免 fuzzy match 误匹配），直接走桥接
          let fileResult = entry.skipDirectMerchantLookup
            ? { accounts: [], isSingleAccount: false }
            : identifyAccountsFromFile({
                filePath: entry.filePath,
                detailRows: entry.detailRows,
                expectedSourceHeaders: fileExpectedHeaders,
                allMerchantIds
              });


          // 自定义输入 MerchantId：通过账户映射桥接提取（merchantId 不在文件中，跳过全文搜索）
          let bridgeMatched = false;
          if (fileResult.accounts.length === 0 && entry.selfInputMerchant) {
            if (entry.matchedTemplateId) {
              const rawRowsFull = readRows(entry.filePath, { blankrows: true });
              const acctMappings = database.listAccountMappings(entry.matchedTemplateId);
              const bankIdToMerchant = new Map();
              for (const am of acctMappings) {
                const bankId = normalizeCell(am.bankAccountId);
                const clearingId = normalizeCell(am.clearingAccountId);
                if (bankId && clearingId) bankIdToMerchant.set(bankId, clearingId);
              }
              if (bankIdToMerchant.size > 0) {
                const bankIds = [...bankIdToMerchant.keys()];
                for (let rowIdx = 0; rowIdx < rawRowsFull.length && fileResult.accounts.length === 0; rowIdx += 1) {
                  const row = rawRowsFull[rowIdx];
                  if (!Array.isArray(row)) continue;
                  for (const cell of row) {
                    const cellStr = normalizeCell(cell);
                    if (!cellStr) continue;
                    for (const bankId of bankIds) {
                      if (matchMerchantIds(cellStr, bankId) !== 'none') {
                        const clearingId = bankIdToMerchant.get(bankId);
                        const matched = expandedOptions.find((o) => matchMerchantIds(clearingId, o.merchantId) !== 'none');
                        if (matched) {
                          fileResult = { accounts: [{ merchantId: matched.merchantId, matchType: 'exact' }], isSingleAccount: true };
                          bridgeMatched = true;
                          break;
                        }
                      }
                    }
                    if (fileResult.accounts.length > 0) break;
                  }
                }
              }
            }
            // 桥接匹配成功但 merchantId 有多个币种 — 标记币种不确定
            if (bridgeMatched && fileResult.accounts.length > 0) {
              const mid = fileResult.accounts[0].merchantId;
              const currencyCount = expandedOptions.filter((o) => matchMerchantIds(mid, o.merchantId) !== 'none').length;
              if (currencyCount > 1) {
                ambiguousCurrencyFiles.push(fileName);
              }
            }
          }

          const rawRows = readRows(entry.filePath, { blankrows: true });
          const headerRowNumbers = findHeaderRowNumbersInRawRows(rawRows, fileExpectedHeaders);
          const blockCount = Math.max(headerRowNumbers.length, fileResult.accounts.length, 1);

          for (let bi = 0; bi < blockCount; bi += 1) {
          const identified = fileResult.accounts[bi];
          if (!identified) {
            failedRows.push({ index: globalIndex, fileName });
            globalIndex += 1;
            continue;
          }

          const matched = expandedOptions.find((o) => {
            const result = matchMerchantIds(identified.merchantId, o.merchantId);
            return result !== 'none';
          });

          if (matched) {
            accounts.push({
              merchantId: matched.merchantId,
              currency: matched.currency,
              matchType: identified.matchType,
              fileName
            });
          } else {
            failedRows.push({ index: globalIndex, fileName });
          }
          globalIndex += 1;
          }
        });
      }

      if (failedRows.length > 0) {
        return { status: 'error', failedRows };
      }


      const result = { status: 'ok', accounts };
      if (ambiguousCurrencyFiles.length > 0) {
        result.ambiguousCurrencyFiles = ambiguousCurrencyFiles;
      }
      return result;
    } catch (error) {
      return { status: 'error', failedRows: [], message: '提取大账号信息时出错' };
    }
  });

  ipcMain.handle('file:save-balance-seed', (_event, payload = {}) => {
    const pendingPrompt = lastManualBalancePrompt;
    const importContext = lastFileImportContext;

    if (!pendingPrompt || !importContext) {
      return createErrorResult({
        step: '补录上一账单日余额',
        message: '当前没有待补录的余额校验任务，请重新导入文件',
        errorCode: 'BALANCE_SEED_CONTEXT_MISSING',
        templateName: importContext?.template?.name || ''
      });
    }

    try {
      const seedDate = parseDateValue(payload.billDate);
      const targetDate = parseDateValue(pendingPrompt.targetBillDate);
      const normalizedSeedDate = seedDate ? formatDateLabel(seedDate) : '';
      const normalizedTargetDate = targetDate ? formatDateLabel(targetDate) : '';
      const endBalance = parseNumericValue(payload.endBalance);

      function buildManualBalanceInvalidResult(message) {
        return {
          status: 'manual-balance-invalid',
          message,
          detailReady: Boolean(lastGeneratedExports.detail),
          balanceReady: Boolean(lastGeneratedExports.balance),
          errorReportReady: false,
          manualBalancePromptReady: true,
          manualBalancePrompt: { ...pendingPrompt }
        };
      }

      if (!normalizedSeedDate) {
        return buildManualBalanceInvalidResult('请选择上一账单日日期');
      }

      if (normalizedTargetDate && normalizedSeedDate >= normalizedTargetDate) {
        return buildManualBalanceInvalidResult('上一账单日日期必须早于当前需要校验的账单日期');
      }

      if (endBalance === null) {
        return buildManualBalanceInvalidResult('请输入有效的上一账单日余额');
      }

      // 用 prompt 里的 templateName（来自实际缺 seed 的组），不用 importContext.template.name（可能是最后一组）
      const seedTemplateName = pendingPrompt.templateName || importContext.template.name;
      const upsertResult = upsertBalanceSeedRecord(ensureStorageRoot(), {
        templateName: seedTemplateName,
        merchantId: pendingPrompt.merchantId,
        currency: pendingPrompt.currency,
        billDate: normalizedSeedDate,
        endBalance,
        generationMethod: BALANCE_SEED_GENERATION_METHODS.manual,
        overwrite: Boolean(payload.overwrite)
      });

      if (upsertResult.status === 'confirm-overwrite') {
        return {
          status: 'confirm-overwrite',
          message: '该日期的余额已存在，确认覆盖吗？',
          existingRecord: upsertResult.existingRecord,
          incomingRecord: upsertResult.incomingRecord
        };
      }

      appendActivityLogEntry({
        level: 'info',
        message: '补录上一账单日余额成功',
        details: [
          `模板名：${seedTemplateName}`,
          `银行账号：${pendingPrompt.merchantId}`,
          `币种：${pendingPrompt.currency || '(空)'}`,
          `账单日期：${normalizedSeedDate}`,
          `余额：${endBalance}`,
          `生成方式：${BALANCE_SEED_GENERATION_METHODS.manual}`
        ]
      });

      // v1.5.2：虚拟 ID 下走多模板重新生成（避免用单组 importContext 产出不完整余额）
      const session = importContext.statementSessionKey
        ? statementImportSessions.get(importContext.statementSessionKey) || null
        : null;

      if (isFilenameMappingMode(importContext.templateId) && session) {
        const regenResult = regenerateVirtualTemplateBalanceFromSession(session, importContext.scope || 'current');
        if (regenResult.needsSeed) {
          // 还有其他 group 需要补录 → 返回下一个 prompt
          return buildManualBalanceRequiredResult(regenResult.prompt, {
            warnings: regenResult.warnings,
            balance: null,
            detail: lastGeneratedExports.detail,
            balanceRequested: true
          });
        }
        const generatedFiles = regenResult.generatedFiles;
        lastGeneratedExports.balance = generatedFiles.balance;
        return buildImportResultFromGeneratedFiles({
          generatedFiles: { ...generatedFiles, detail: lastGeneratedExports.detail },
          templateId: FILENAME_MAPPING_TEMPLATE_ID,
          templateName: '按文件名映射模板',
          inputFilePaths: importContext.inputFilePaths
        });
      }

      const generatedFiles = generateFilesFromRememberedContext(importContext);

      if (importContext.scope === 'all') {
        cacheAllStatementExport('balance', generatedFiles.balance);
      } else if (session) {
        updateStatementSessionCache(session, importContext.currentBatchId || session.currentBatchId, generatedFiles);
      } else {
        lastGeneratedExports.detail = generatedFiles.detail;
        lastGeneratedExports.balance = generatedFiles.balance;
      }

      return buildImportResultFromGeneratedFiles({
        generatedFiles,
        templateId: importContext.templateId,
        templateName: importContext.template.name,
        inputFilePaths: importContext.inputFilePaths
      });
    } catch (error) {
      if (error instanceof FileValidationError) {
        clearPendingManualBalancePrompt();
        return createErrorResult({
          step: '补录上一账单日余额',
          message: error.message,
          errorCode: error.code,
          detailLines: Array.isArray(error.detailLines) ? error.detailLines : [],
          context: {
            templateName: importContext.template.name,
            ...(error.context || {})
          },
          templateName: importContext.template.name,
          originalError: error
        });
      }

      const logPath = appendLog(ensureStorageRoot(), error);
      clearPendingManualBalancePrompt();
      return createErrorResult({
        step: '补录上一账单日余额',
        message: '余额补录失败，请导出报错文件查看详情',
        errorCode: 'BALANCE_SEED_SAVE_RUNTIME',
        errorType: '系统错误',
        detailLines: [`日志文件：${logPath}`],
        context: {
          templateName: importContext.template.name
        },
        templateName: importContext.template.name,
        originalError: error
      });
    }
  });

  ipcMain.handle('file:export-detail', (_event, scope = 'auto') => {
    return exportStatementByScope('detail', scope);
  });

  ipcMain.handle('file:export-balance', (_event, scope = 'auto') => {
    return exportStatementByScope('balance', scope);
  });

  // v1.5.3 R1 (T1.3)：月度余额装配 IPC
  // payload = { templateScope, templateName, year, month }
  //   - templateScope：'all'（走全部普通模板） | 'single'（templateName 指定的具体模板）
  //   - templateName：当 templateScope === 'single' 时必填；为 '全部银行渠道' 时等价于 'all'
  // 返回：
  //   { status: 'ready', summary: { count, missingCount, templateScope, year, month } }
  //   { status: 'empty', message }
  //   { status: 'error', errorCode, message }
  // 注意：校验类错误（E1/E2/E3/E4）不走 createErrorResult 避免误触发错误报告；前端通过 createAlertDialog 弹窗
  ipcMain.handle('monthly-balance:assemble', async (_event, payload = {}) => {
    try {
      const templateScopeRaw = payload && typeof payload.templateScope === 'string' ? payload.templateScope : '';
      const templateNameRaw = payload && typeof payload.templateName === 'string' ? payload.templateName : '';
      const yearRaw = payload ? Number(payload.year) : NaN;
      const monthRaw = payload ? Number(payload.month) : NaN;

      const hasTemplate =
        templateScopeRaw === 'all' ||
        templateScopeRaw === ALL_BANKS_TEMPLATE_SCOPE ||
        (templateScopeRaw === 'single' && templateNameRaw.trim() !== '');
      const hasTime = Number.isInteger(yearRaw) && Number.isInteger(monthRaw) && monthRaw >= 1 && monthRaw <= 12;

      // E1 / E2 / E3：三类校验合并为一条 errorCode，前端根据 templateScopeRaw / year / month 自行区分弹窗文案
      if (!hasTemplate && !hasTime) {
        return {
          status: 'error',
          errorCode: 'MONTHLY_BALANCE_INVALID_INPUT',
          message: '请选择模板和时间'
        };
      }
      if (!hasTemplate) {
        return {
          status: 'error',
          errorCode: 'MONTHLY_BALANCE_INVALID_INPUT',
          message: '请选择模板'
        };
      }
      if (!hasTime) {
        return {
          status: 'error',
          errorCode: 'MONTHLY_BALANCE_INVALID_INPUT',
          message: '请选择时间'
        };
      }

      const storageRoot = ensureStorageRoot();
      const useAll = templateScopeRaw === 'all' || templateScopeRaw === ALL_BANKS_TEMPLATE_SCOPE;
      const assembleScope = useAll ? ALL_BANKS_TEMPLATE_SCOPE : templateNameRaw.trim();

      const assembled = assembleMonthlyBalance({
        templateScope: assembleScope,
        year: yearRaw,
        month: monthRaw,
        db: database,
        storageRoot
      });

      // E4：装配结果为空（模板/范围内无余额记录）
      if (!assembled.records.length) {
        lastGeneratedExports.monthlyBalance = null;
        return {
          status: 'empty',
          message: `所选模板在 ${yearRaw}年${monthRaw}月的月末及更早均无余额记录，无法生成月度余额账单`
        };
      }

      // 写入临时 xlsx（用户点"导出余额"时再通过 save dialog 另存为）
      const balanceTemplatePath = getBalanceTemplatePath();
      if (!fs.existsSync(balanceTemplatePath)) {
        return createErrorResult({
          step: '装配月度余额账单',
          message: '未找到余额账单模板，请确认 assets/余额账单模版.xlsx 已存在',
          errorCode: 'BALANCE_TEMPLATE_MISSING'
        });
      }
      const balanceTemplateFields = extractHeaders(balanceTemplatePath);
      if (!balanceTemplateFields.length) {
        return createErrorResult({
          step: '装配月度余额账单',
          message: '余额账单模板为空或不可读',
          errorCode: 'BALANCE_TEMPLATE_INVALID'
        });
      }

      const records = toBalanceRows(assembled.records, balanceTemplateFields);
      const templateLabel = useAll ? '全部银行渠道' : templateNameRaw.trim();
      const publicFileName = sanitizeFileName(
        `月度余额账单-${templateLabel}-${yearRaw}-${String(monthRaw).padStart(2, '0')}.xlsx`
      );
      // 复用 buildOutputFilePath('balance') 的目录约定：{storageRoot}/exports/{date}/balance/
      const output = buildOutputFilePath({
        kind: 'balance',
        outputFileName: publicFileName
      });

      writeBalanceWorkbook({
        templateFilePath: balanceTemplatePath,
        records,
        templateFields: balanceTemplateFields,
        outputFilePath: output.outputFilePath
      });

      lastGeneratedExports.monthlyBalance = {
        filePath: output.outputFilePath,
        fileName: publicFileName,
        templateScope: assembleScope,
        templateLabel,
        year: yearRaw,
        month: monthRaw,
        recordCount: assembled.records.length
      };

      appendActivityLogEntry({
        level: 'info',
        message: '月度余额账单装配成功',
        details: [
          `模板：${templateLabel}`,
          `年月：${yearRaw}-${String(monthRaw).padStart(2, '0')}`,
          `记录数：${assembled.records.length}`,
          `缺失大账号数：${assembled.stats.missingAccounts.length}`,
          `临时文件：${output.outputFilePath}`
        ]
      });

      return {
        status: 'ready',
        summary: {
          count: assembled.records.length,
          missingCount: assembled.stats.missingAccounts.length,
          templateLabel,
          templateScope: assembleScope,
          year: yearRaw,
          month: monthRaw,
          fileName: publicFileName
        }
      };
    } catch (error) {
      return createErrorResult({
        step: '装配月度余额账单',
        message: '装配月度余额账单失败，请导出报错文件查看详情',
        errorCode: 'MONTHLY_BALANCE_ASSEMBLE_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });

  // v1.5.3 R1 (T1.4)：月度余额另存为
  // 前提：lastGeneratedExports.monthlyBalance 已由 assemble 成功填充
  // 返回：
  //   { status: 'success', filePath, message }
  //   { status: 'cancelled' }
  //   { status: 'error', errorCode, message }
  ipcMain.handle('monthly-balance:export', async () => {
    try {
      const pending = lastGeneratedExports.monthlyBalance;
      if (!pending || !pending.filePath) {
        return {
          status: 'error',
          errorCode: 'MONTHLY_BALANCE_NO_PENDING',
          message: '尚未生成月度余额账单，请先在弹窗中选择模板和时间'
        };
      }
      if (!fs.existsSync(pending.filePath)) {
        lastGeneratedExports.monthlyBalance = null;
        return {
          status: 'error',
          errorCode: 'MONTHLY_BALANCE_FILE_MISSING',
          message: '临时文件已丢失，请重新生成月度余额账单'
        };
      }

      const saveResult = await dialog.showSaveDialog(mainWindow, {
        defaultPath: pending.fileName,
        filters: [
          {
            name: 'Excel',
            extensions: ['xlsx']
          }
        ]
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return { status: 'cancelled' };
      }

      fs.copyFileSync(pending.filePath, saveResult.filePath);
      appendActivityLogEntry({
        level: 'info',
        message: '月度余额账单导出成功',
        details: [
          `模板：${pending.templateLabel}`,
          `年月：${pending.year}-${String(pending.month).padStart(2, '0')}`,
          `导出路径：${saveResult.filePath}`
        ]
      });

      return {
        status: 'success',
        filePath: saveResult.filePath,
        message: '月度余额账单导出成功'
      };
    } catch (error) {
      return createErrorResult({
        step: '导出月度余额账单',
        message: '月度余额账单另存为失败，请导出报错文件查看详情',
        errorCode: 'MONTHLY_BALANCE_EXPORT_RUNTIME',
        errorType: '系统错误',
        originalError: error
      });
    }
  });
}

function registerNewAccountHandlers() {
  ipcMain.handle('new-account:generate', (_event, payload = {}) => {
    const accounts = normalizeNewAccountAccounts(payload);

    if (!accounts.length) {
      return createErrorResult({
        step: '生成新开账户余额账单',
        message: '请完整填写所有必填项',
        errorCode: 'NEW_ACCOUNT_REQUIRED',
        templateName: NEW_ACCOUNT_EXPORT_NAME,
        context: {
          moduleName: NEW_ACCOUNT_EXPORT_NAME
        }
      });
    }

    const missingDetails = [];

    accounts.forEach((account, index) => {
      const missingFields = [
        ['银行名称', account.bankName],
        ['所在地', account.location],
        ['银行账号', account.bankAccount],
        ['开户日期', account.openingDateRaw]
      ].filter(([, value]) => !value);

      if (!account.isMultiCurrency && !account.currency) {
        missingFields.push(['币种', '']);
      }

      if (missingFields.length) {
        missingDetails.push(`${index + 1}. 缺少字段：${missingFields.map(([label]) => label).join('、')}`);
        return;
      }

      const selectedCurrencies = normalizeNewAccountCurrencyValues(account);

      if (account.isMultiCurrency && selectedCurrencies.length === 0) {
        missingDetails.push(`${index + 1}. 多币种账户至少需要勾选一个币种`);
        return;
      }

      if (!account.openingDate) {
        missingDetails.push(`${index + 1}. 开户日期不是有效日期`);
      }
    });

    if (missingDetails.length) {
      return createErrorResult({
        step: '生成新开账户余额账单',
        message: '请完整填写所有必填项',
        errorCode: 'NEW_ACCOUNT_REQUIRED',
        detailLines: missingDetails,
        templateName: NEW_ACCOUNT_EXPORT_NAME,
        context: {
          moduleName: NEW_ACCOUNT_EXPORT_NAME
        }
      });
    }

    try {
      const balanceTemplatePath = getBalanceTemplatePath();

      if (!fs.existsSync(balanceTemplatePath)) {
        return createErrorResult({
          step: '生成新开账户余额账单',
          message: '未找到余额账单模板，请确认文件已放入 assets 目录',
          errorCode: 'BALANCE_TEMPLATE_MISSING',
          templateName: NEW_ACCOUNT_EXPORT_NAME,
          context: {
            moduleName: NEW_ACCOUNT_EXPORT_NAME
          }
        });
      }

      const balanceTemplateFields = extractHeaders(balanceTemplatePath);

      if (!balanceTemplateFields.length) {
        return createErrorResult({
          step: '生成新开账户余额账单',
          message: '余额账单模板为空或不可读，请重新确认',
          errorCode: 'BALANCE_TEMPLATE_INVALID',
          templateName: NEW_ACCOUNT_EXPORT_NAME,
          context: {
            moduleName: NEW_ACCOUNT_EXPORT_NAME
          }
        });
      }

      const generated = buildNewAccountBalanceRecords({
        accounts,
        balanceTemplateFields
      });
      const primaryAccount = accounts[0];

      let accountSegment;
      let currencySegment;

      if (accounts.length === 1) {
        const bankAccount = String(primaryAccount.bankAccount || '').trim();
        accountSegment = bankAccount.length > 4 ? bankAccount.slice(-4) : bankAccount;
        currencySegment = generated.currencies.length > 1 ? '多币种' : (generated.currencies[0] || '');
      } else {
        accountSegment = '多账号';
        currencySegment = '多币种';
      }

      const nameParts = [
        primaryAccount.bankName,
        primaryAccount.location,
        accountSegment,
        currencySegment,
        NEW_ACCOUNT_EXPORT_NAME
      ].filter((part) => part !== '');

      const output = buildOutputFilePath({
        kind: 'new-account',
        outputFileName: `${nameParts.join('-')}.xlsx`
      });

      writeBalanceWorkbook({
        templateFilePath: balanceTemplatePath,
        records: generated.records,
        templateFields: balanceTemplateFields,
        outputFilePath: output.outputFilePath
      });

      lastGeneratedExports = {
        detail: lastGeneratedExports.detail,
        balance: lastGeneratedExports.balance,
        newAccount: {
          filePath: output.outputFilePath,
          fileName: output.outputFileName,
          templateName: NEW_ACCOUNT_EXPORT_NAME
        }
      };
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '生成新开账户余额账单成功',
        details: [
          `导出文件：${output.outputFileName}`,
          `币种：${currencySegment}`,
          `账单日期数量：${generated.billDates.length}`,
          `账号行数：${accounts.length}`
        ]
      });

      return {
        status: 'success',
        message: '新开账户余额账单可导出',
        exportReady: true
      };
    } catch (error) {
      lastGeneratedExports = {
        detail: lastGeneratedExports.detail,
        balance: lastGeneratedExports.balance,
        newAccount: null
      };

      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '生成新开账户余额账单',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: {
            accounts: accounts.map((account) => ({
              bankName: account.bankName,
              location: account.location,
              currency: account.currency,
              currencies: account.currencies,
              bankAccount: account.bankAccount,
              openingDate: account.openingDate ? formatDateLabel(account.openingDate) : account.openingDateRaw
            })),
            moduleName: NEW_ACCOUNT_EXPORT_NAME
          },
          templateName: NEW_ACCOUNT_EXPORT_NAME
        });
      }

      const logPath = appendLog(ensureStorageRoot(), error);
      return createErrorResult({
        step: '生成新开账户余额账单',
        message: '生成失败，请导出报错文件查看详情',
        errorCode: 'NEW_ACCOUNT_RUNTIME',
        errorType: '系统错误',
        detailLines: [`日志文件：${logPath}`],
        originalError: error,
        templateName: NEW_ACCOUNT_EXPORT_NAME,
        context: {
          accounts: accounts.map((account) => ({
            bankName: account.bankName,
            location: account.location,
            currency: account.currency,
            currencies: account.currencies,
            bankAccount: account.bankAccount,
            openingDate: account.openingDate ? formatDateLabel(account.openingDate) : account.openingDateRaw
          })),
          moduleName: NEW_ACCOUNT_EXPORT_NAME
        }
      });
    }
  });

  ipcMain.handle('new-account:export', () => {
    return exportGeneratedFile(lastGeneratedExports.newAccount, '暂无可导出的新开账户余额账单', '导出新开账户余额账单');
  });

  ipcMain.handle('pending:columns', () => PENDING_COLUMNS.slice());

  ipcMain.handle('pending:rule:get', () => {
    if (!pendingDb) return null;
    try {
      return pendingRuleRepo.getRule(pendingDb);
    } catch (err) {
      try {
        appendActivityLogEntry({
          level: 'error',
          message: 'pending:rule:get 失败',
          details: [String(err && err.stack ? err.stack : err)]
        });
      } catch (_logErr) {
        // swallow
      }
      return null;
    }
  });

  ipcMain.handle('pending:rule:save', (_event, payload) => {
    if (!pendingDb) {
      throw new Error('Pending DB 未初始化，无法保存规则');
    }
    return pendingRuleRepo.upsertRule(pendingDb, payload || {});
  });

  ipcMain.handle('pending:months:list', () => {
    if (!pendingDb) return [];
    try { return pendingMonthRepo.listMonths(pendingDb); } catch (_err) { return []; }
  });

  ipcMain.handle('pending:import:pick-files', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Pending 数据文件',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cancelled: false, files: result.filePaths };
  });

  ipcMain.handle('pending:import:start', async (event, payload) => {
    const { files, yearMonth, overwriteConfirmed = false } = payload || {};
    if (!Array.isArray(files) || files.length === 0) {
      return { status: 'error', errors: [{ severity: 'fatal', message: '未选择文件' }] };
    }
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      return { status: 'error', errors: [{ severity: 'fatal', message: 'yearMonth 格式错误（应为 YYYY-MM）' }] };
    }
    const webContents = event.sender;
    const dbPath = path.join(app.getPath('userData'), PENDING_DB_FILENAME);
    return pendingSession.runImport({
      yearMonth,
      files,
      overwriteConfirmed,
      dbPath,
      onProgress: (ev) => {
        try { webContents.send('pending:import:progress', ev); } catch (_e) { /* swallow */ }
      }
    });
  });

  ipcMain.handle('pending:error:export-report', async () => {
    if (!pendingSession.hasPendingErrorReport()) {
      return { status: 'error', message: '无错误报告' };
    }
    const result = await dialog.showSaveDialog({
      title: '保存 Pending 导入报错文件',
      defaultPath: `pending-import-errors-${Date.now()}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (result.canceled || !result.filePath) return { status: 'cancelled' };
    try {
      return pendingSession.exportErrorReport(result.filePath);
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('pending:reconcile:run', (_event, payload = {}) => {
    if (!pendingDb) throw new Error('Pending DB 未初始化');
    const rule = pendingRuleRepo.getRule(pendingDb);
    if (!rule || !rule.matchFields || rule.matchFields.length === 0) {
      throw new Error('规则未设置（matchFields 为空）');
    }
    return pendingReconcileEngine.runReconciliation(pendingDb, {
      upperMonth: payload.upperMonth,
      lowerMonth: payload.lowerMonth,
      rule
    });
  });

  ipcMain.handle('pending:diff:runs-list', () => {
    if (!pendingDb) return [];
    try { return pendingDiffRepo.listAllRuns(pendingDb); } catch (_e) { return []; }
  });

  ipcMain.handle('pending:diff:runs-for-month-pair', (_event, payload = {}) => {
    if (!pendingDb) return [];
    try {
      return pendingDiffRepo.listRunsForMonthPair(pendingDb, payload.upperMonth, payload.lowerMonth);
    } catch (_e) {
      return [];
    }
  });

  ipcMain.handle('pending:diff:latest-run-for', (_event, payload = {}) => {
    if (!pendingDb) return null;
    try {
      return pendingDiffRepo.getLatestRunForMonthPair(pendingDb, payload.upperMonth, payload.lowerMonth);
    } catch (_e) {
      return null;
    }
  });

  ipcMain.handle('pending:diff:export-single', async (_event, payload = {}) => {
    if (!pendingDb) return { status: 'error', message: 'Pending DB 未初始化' };
    const runId = Number(payload.runId);
    if (!Number.isFinite(runId) || runId <= 0) {
      return { status: 'error', message: 'runId 无效' };
    }
    const saveResult = await dialog.showSaveDialog({
      title: '保存 Pending 差异文件',
      defaultPath: payload.defaultFileName || `月度Pending差异-run${runId}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) return { status: 'cancelled' };
    try {
      return pendingExportWriter.exportSingleRun(pendingDb, runId, saveResult.filePath);
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('pending:diff:export-aggregate', async () => {
    if (!pendingDb) return { status: 'error', message: 'Pending DB 未初始化' };
    const saveResult = await dialog.showSaveDialog({
      title: '保存 Pending 差异汇总文件',
      defaultPath: `月度Pending差异-汇总-${new Date().toISOString().slice(0, 10)}.xlsx`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) return { status: 'cancelled' };
    try {
      return pendingExportWriter.exportAggregate(pendingDb, saveResult.filePath);
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });
}

app.whenReady()
  .then(() => {
    markStartupMetric(STARTUP_METRIC_MARKS.appReady);
    initializeActivityLog();

    const dataPath = path.join(app.getPath('userData'), 'tool-data.sqlite');
    database = new AppDatabase(dataPath);
    database.init();
    markStartupMetric(STARTUP_METRIC_MARKS.databaseReady);

    // v2.0.0-beta.2 F4：ui_style 升级迁移（D4）—— 若不存在则写 'Clear'
    database.ensureUiStyleDefault();

    // v2.0.0-beta.2 阶段 6：preview 模式通过 env APP_PREVIEW_STYLE=clear|general 强制风格
    if (process.env.APP_PREVIEW_STYLE) {
      const v = String(process.env.APP_PREVIEW_STYLE).trim().toLowerCase();
      if (v === 'clear') database.setUiStyle('Clear');
      else if (v === 'general') database.setUiStyle('General');
    }

    // v2.0.0-beta.2 D16：风格-背景色联动（仅魔法值场景）
    ensureBackgroundColorMatchesStyle();

    try {
      pendingDb = openPendingDb(app.getPath('userData'));
    } catch (pendingDbErr) {
      pendingDb = null;
      try {
        appendActivityLogEntry({
          level: 'error',
          message: 'Pending DB 初始化失败（v2.0.0）',
          details: [String(pendingDbErr && pendingDbErr.stack ? pendingDbErr.stack : pendingDbErr)]
        });
      } catch (_logErr) {
        // swallow
      }
    }

    // v1.5.3 R2（D15）：一次性迁移 own-accounts/*.json → template_big_accounts
    // 失败不阻塞启动：异常由迁移模块内部捕获，返回 status='failed' 时记录到
    // lastOwnAccountsMigrationError，renderer 首次 app:get-info 读取后用 error tone 显示
    try {
      const storageRoot = ensureStorageRoot();
      const migrationResult = runOwnAccountsMigration(storageRoot, database.db, {
        appendActivityLogEntry
      });
      if (migrationResult && migrationResult.status === 'failed') {
        lastOwnAccountsMigrationError = '自有账号迁移失败，请查看 own-accounts-migration-v1.5.3.log 后联系技术支持';
      } else {
        lastOwnAccountsMigrationError = null;
      }
    } catch (migrationErr) {
      // 防御：即使迁移模块外层 catch 漏抛，这里再兜底一层
      lastOwnAccountsMigrationError = '自有账号迁移失败，请查看 own-accounts-migration-v1.5.3.log 后联系技术支持';
      try {
        appendActivityLogEntry({
          level: 'error',
          message: '自有账号迁移（v1.5.3）抛出未捕获异常',
          details: [String(migrationErr && migrationErr.stack ? migrationErr.stack : migrationErr)]
        });
      } catch (_logErr) {
        // swallow
      }
    }

    syncTemplateLibraryFile();
    markStartupMetric(STARTUP_METRIC_MARKS.templateLibrarySynced);

    registerWindowHandlers();
    registerAppHandlers();
    registerErrorHandlers();
    registerBackgroundHandlers();
    registerAccountMappingHandlers();
    registerTemplateHandlers();
    registerBigAccountHandlers();
    registerBigAccountOrderHandlers();
    registerFileHandlers();
    registerNewAccountHandlers();
    markStartupMetric(STARTUP_METRIC_MARKS.handlersReady);
    createWindow();
  })
  .catch((error) => {
    handleStartupFailure(error);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
