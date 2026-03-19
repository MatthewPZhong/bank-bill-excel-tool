const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');
const { AppDatabase } = require('./backend/database');
const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  upsertBalanceSeedRecord,
  splitTemplateName
} = require('./backend/balance-seed-store');
const {
  calculateEndingBalanceFromAmounts,
  buildDetailExportRows,
  buildMappedRows,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  extractHeaders,
  inferEndingBalance,
  loadCurrencyMappings,
  loadEnumValues,
  normalizeCell,
  parseDateValue,
  parseNumericValue,
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
let lastGeneratedExports = {
  detail: null,
  balance: null,
  allDetail: null,
  allBalance: null,
  statementSessionKey: '',
  currentBatchId: '',
  newAccount: null
};
let lastErrorReport = null;
let activityLogFilePath = '';
let lastFileImportContext = null;
let lastManualBalancePrompt = null;
let lastPendingBigAccountSelection = null;
let statementImportSessions = new Map();
let nextStatementBatchId = 1;
let nextStatementFileEntryId = 1;
let startupMetricsReported = false;

const DEFAULT_BACKGROUND_COLOR = '#efe8da';
const BUNDLED_ENUM_FILE_NAME = 'COMMON枚举.xlsx';
const CURRENCY_MAPPING_FILE_NAME = '币种映射表.xlsx';
const MISSING_ENUM_MESSAGE = '内置网银账单枚举表缺失，请检查安装包';
const BALANCE_DISABLED_OPTION = '无';
const BALANCE_CALCULATED_OPTION = '通过发生额计算';
const MERCHANT_ID_SELF_INPUT_OPTION = '自己输入';
const MERCHANT_ID_MULTI_ACCOUNT_MARKER = '__MULTI_BIG_ACCOUNT__';
const CUSTOM_INPUT_TARGET_FIELDS = new Set(['MerchantId']);
const SIGNED_AMOUNT_MAPPING_FIELD = '按正负号拆分的发生额';
const AMOUNT_BASED_NAME_MAPPING_FIELD = '根据发生额做映射的户名';
const AMOUNT_BASED_ACCOUNT_MAPPING_FIELD = '根据发生额做映射的账户号';
const ADVANCED_MAPPING_FIELDS = [
  SIGNED_AMOUNT_MAPPING_FIELD,
  AMOUNT_BASED_NAME_MAPPING_FIELD,
  AMOUNT_BASED_ACCOUNT_MAPPING_FIELD
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
              detailRows: cloneRowsWithMetadata(entry.detailRows)
            }))
          : [],
        rows: Array.isArray(context.rows)
          ? context.rows.map((row) => ({
              index: Number(row.index || 0),
              sourceRowNumber: Number(row.sourceRowNumber || 0),
              fileName: normalizeCell(row.fileName)
            }))
          : []
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

function buildBigAccountSelectionRequiredResult({ rows = [], bigAccounts = [], fixedAssignments = [] } = {}) {
  clearLastErrorReport();
  return {
    status: 'select-big-account',
    message: '请选择本次使用的大账号 / 币种',
    selectionMode: 'multi-row',
    rows: rows.map((row, index) => ({
      index: Number.isInteger(row.index) ? row.index : index,
      label: `${index + 1}.`,
      sourceRowNumber: Number(row.sourceRowNumber || 0),
      fileName: normalizeCell(row.fileName)
    })),
    bigAccounts: bigAccounts.map((item) => ({
      merchantId: normalizeCell(item.merchantId),
      currencies: Array.isArray(item.currencies)
        ? item.currencies.map((value) => normalizeCell(value)).filter((value) => value !== '')
        : [],
      isMultiCurrency: Boolean(item.isMultiCurrency)
    })),
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

  return normalizeInputFilePaths(inputFilePaths, { dedupe: false }).map((inputFilePath) => ({
    filePath: inputFilePath,
    detailRows: buildMappedRowsForFile({
      config,
      inputFilePath
    })
  }));
}

function buildBigAccountSelectionRows(fileEntries = []) {
  const rows = [];
  let rowIndex = 0;

  fileEntries.forEach((entry) => {
    const rowMetas = Array.isArray(entry.detailRows?.rowMetas) ? entry.detailRows.rowMetas : [];
    entry.detailRows.slice(1).forEach((_row, index) => {
      rows.push({
        index: rowIndex,
        sourceRowNumber: rowMetas[index]?.sourceRowNumber || index + 2,
        fileName: path.basename(entry.filePath)
      });
      rowIndex += 1;
    });
  });

  return rows;
}

function applyBigAccountAssignmentsToFileEntries(fileEntries = [], assignments = []) {
  const normalizedAssignments = assignments.map((item, index) => ({
    merchantId: normalizeCell(item.merchantId),
    currency: normalizeCell(item.currency),
    rowIndex: Number.isInteger(item.rowIndex) ? item.rowIndex : index
  }));
  const assignmentByRowIndex = new Map(normalizedAssignments.map((item) => [item.rowIndex, item]));
  let globalRowIndex = 0;

  return fileEntries.map((entry) => {
    const nextRows = cloneRowsWithMetadata(entry.detailRows);
    const fieldIndexMap = buildFieldIndexMap(nextRows[0] || []);
    const merchantIdIndex = fieldIndexMap.get('MerchantId');
    const currencyIndex = fieldIndexMap.get('Currency');

    nextRows.slice(1).forEach((row) => {
      const assignment = assignmentByRowIndex.get(globalRowIndex);

      if (assignment) {
        if (merchantIdIndex !== undefined) {
          row[merchantIdIndex] = assignment.merchantId;
        }

        if (currencyIndex !== undefined) {
          row[currencyIndex] = assignment.currency;
        }
      }

      globalRowIndex += 1;
    });

    return {
      filePath: entry.filePath,
      detailRows: nextRows
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

    currencies.forEach((currency) => {
      expandedRows.push({
        merchantId,
        currency
      });
    });
  });

  return expandedRows;
}

function buildTemplateLibraryPayload() {
  return {
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    templates: database.listTemplateBundleEntries()
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

  const templates = Array.isArray(parsed?.templates) ? parsed.templates : [];

  return templates.map((item) => ({
    templateKey: normalizeCell(item.templateKey),
    name: normalizeCell(item.name),
    sourceFileName: normalizeCell(item.sourceFileName) || `${normalizeCell(item.name) || 'template'}.xlsx`,
    headers: Array.isArray(item.headers) ? item.headers.map((value) => normalizeCell(value)).filter((value) => value !== '') : [],
    mappings: Array.isArray(item.mappings) ? item.mappings : [],
    bigAccounts: Array.isArray(item.bigAccounts) ? item.bigAccounts : [],
    fixedAssignments: Array.isArray(item.fixedAssignments) ? item.fixedAssignments : []
  }));
}

function normalizeBackgroundColor(colorHex) {
  const normalized = String(colorHex || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : DEFAULT_BACKGROUND_COLOR;
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
  return buildMappingTargetFields(enumValues).concat(ADVANCED_MAPPING_FIELDS);
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
    const customInputMapping = CUSTOM_INPUT_TARGET_FIELDS.has(fieldName)
      ? decodeCustomInputMappingValue(savedValue)
      : null;
    const hasSavedBigAccounts = Array.isArray(bigAccounts) && bigAccounts.length > 0;

    return {
      templateField: fieldName,
      mappedField: fieldName === 'Balance'
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

    return {
      templateField: fieldName,
      mappedField: fieldName === 'Balance'
        ? savedValue || BALANCE_DISABLED_OPTION
        : savedValue === BALANCE_DISABLED_OPTION
          ? ''
          : savedValue || '',
      mappedFields:
        fieldName === 'Balance' || savedFields.length <= 1
          ? []
          : savedFields
    };
  });
}

function getTemplateMappingConfig(templateId) {
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
      : []
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
  const publicFileName = merchantId
    ? `${templateName}-${merchantId}-${outputTag}-${safeDateLabel}.xlsx`
    : `${templateName}-${outputTag}-${safeDateLabel}.xlsx`;
  const internalFileName = internalSuffix
    ? publicFileName.replace(/\.xlsx$/i, `__${internalSuffix}.xlsx`)
    : publicFileName;
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
    newAccount: lastGeneratedExports.newAccount
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
  resolvePreviousEndBalance = null
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
        let effectivePreviousEndBalance = previousEndBalance;

        if (effectivePreviousEndBalance === null && hasMultipleEndingBalances(entries)) {
          effectivePreviousEndBalance = resolveSeededPreviousEndBalance({
            previousEndBalance,
            resolvePreviousEndBalance,
            promptContext,
            shouldPrompt: true
          });
        }

        endBalance = inferEndingBalance({
          previousEndBalance: effectivePreviousEndBalance,
          entries,
          dateLabel
        });
      }

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

  if (normalizedOpenDate.getTime() > normalizedToday.getTime()) {
    throw new FileValidationError('FILE_READ', '开户日期不能晚于今日');
  }

  const dateMap = new Map([[formatDateLabel(normalizedOpenDate), normalizedOpenDate]]);
  let cursor = new Date(normalizedOpenDate.getFullYear(), normalizedOpenDate.getMonth(), 1);

  while (cursor.getTime() <= normalizedToday.getTime()) {
    const monthEndDate = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);

    if (monthEndDate.getTime() >= normalizedOpenDate.getTime() && monthEndDate.getTime() <= normalizedToday.getTime()) {
      dateMap.set(formatDateLabel(monthEndDate), normalizeDateOnly(monthEndDate));
    }

    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return Array.from(dateMap.values()).sort((left, right) => left.getTime() - right.getTime());
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
    bigAccountSummary: template.bigAccountSummary || '未设置'
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
      accountMappingCount: database.listAccountMappings().length,
      currencyOptions: getAvailableCurrencyCodes(),
      backgroundConfig: buildBackgroundPayload(),
      previewModal: process.env.APP_PREVIEW_MODAL || ''
    };
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
        colorHex: DEFAULT_BACKGROUND_COLOR,
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
        message: '网银大账户ID仅支持1-64位字母、数字、下划线、中划线'
      };
    }

    if (bankAccountSeen.has(bankAccountId)) {
      return {
        status: 'error',
        message: '网银大账户ID不可重复，请重新确认'
      };
    }

    if (clearingAccountId.length > 128) {
      return {
        status: 'error',
        message: '清结算系统大账户ID长度不能超过128位'
      };
    }

    bankAccountSeen.add(bankAccountId);
    cleanedMappings.push({
      bankAccountId,
      clearingAccountId
    });
  }

  return {
    status: 'success',
    mappings: cleanedMappings
  };
}

function registerAccountMappingHandlers() {
  ipcMain.handle('account-mapping:list', () => {
    return {
      status: 'success',
      mappings: database.listAccountMappings()
    };
  });

  ipcMain.handle('account-mapping:save', (_event, mappings) => {
    try {
      const validationResult = validateAccountMappings(mappings);

      if (validationResult.status !== 'success') {
        return createErrorResult({
          step: '保存账户映射',
          message: validationResult.message,
          errorCode: 'ACCOUNT_MAPPING_VALIDATE',
          detailLines: ['账户映射存在格式或完整性问题，未执行保存。'],
          context: { mappings }
        });
      }

      database.saveAccountMappings(validationResult.mappings);
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '保存账户映射成功',
        details: [`映射条数：${validationResult.mappings.length}`]
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
        context: { mappings }
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

    if (!targetFieldSet.has(targetField)) {
      return;
    }

    mappingByTarget.set(targetField, {
      mappedField: sourceField,
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
  const usesSignedAmountMapping = signedAmountSourceField !== '';
  const usesDirectAmountMapping = creditAmountSourceField !== '' || debitAmountSourceField !== '';

  if (usesSignedAmountMapping && usesDirectAmountMapping) {
    throw new FileValidationError('FILE_READ', '“按正负号拆分的发生额”与 Credit Amount / Debit Amount 不能同时设置');
  }

  if (usesSignedAmountMapping && !sourceFieldSet.has(signedAmountSourceField)) {
    throw new FileValidationError('FILE_READ', `映射字段不存在：${signedAmountSourceField}`);
  }

  const cleanedBigAccounts = merchantIdManagedByBigAccounts
    ? bigAccounts.map((item) => ({
        merchantId: normalizeCell(item.merchantId),
        currencies: Array.from(
          new Set(
            (Array.isArray(item.currencies) ? item.currencies : [])
              .map((value) => normalizeCell(value))
              .filter((value) => value !== '')
          )
        ),
        isMultiCurrency: Boolean(item.isMultiCurrency)
      }))
    : [];
  const cleanedFixedAssignments = merchantIdManagedByBigAccounts
    ? fixedAssignments
        .map((item, index) => ({
          merchantId: normalizeCell(item.merchantId),
          currency: normalizeCell(item.currency),
          rowIndex: Number.isInteger(item.rowIndex) ? item.rowIndex : index
        }))
        .filter((item) => item.merchantId !== '')
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
        exportTargetFields: mappingConfig.exportTargetFields,
        mappings: mappingConfig.mappings,
        bigAccounts: mappingConfig.bigAccounts,
        fixedAssignments: mappingConfig.fixedAssignments
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

      database.saveMappings(
        payload.templateId,
        templateConfiguration.mappings,
        templateConfiguration.bigAccounts,
        templateConfiguration.fixedAssignments
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

      importedTemplates.forEach((entry) => {
        if (!entry.name || !entry.headers.length) {
          skippedCount += 1;
          return;
        }

        try {
          const existingTemplate = entry.templateKey
            ? database.getTemplateByKey(entry.templateKey)
            : database.getTemplateByName(entry.name);
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

          database.saveMappings(
            template.id,
            validated.mappings,
            validated.bigAccounts,
            validated.fixedAssignments
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
}

function buildMappedFieldLookup(mappings) {
  return mappings.reduce((accumulator, mapping) => {
    const mappedFields = getMappingFieldValues(mapping);
    accumulator[mapping.templateField] = mappedFields.length > 1
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

  const accountMappingByBankId = database.listAccountMappings().reduce((accumulator, mapping) => {
    accumulator[mapping.bankAccountId] = mapping.clearingAccountId;
    return accumulator;
  }, {});

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
    }
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
    expectedSourceHeaders: config.template.headers,
    selectedBigAccount: {
      merchantId: config.selectedMerchantId,
      currency: config.selectedCurrency
    }
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
    balanceRequested: Boolean(preparedBatch.balanceRequested)
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

    try {
      const balanceTemplatePath = getBalanceTemplatePath();

      if (!fs.existsSync(balanceTemplatePath)) {
        throw new FileValidationError('FILE_READ', '未找到余额账单模板，请确认文件已放入 assets 目录');
      }

      const balanceTemplateFields = extractHeaders(balanceTemplatePath);

      if (!balanceTemplateFields.length) {
        throw new FileValidationError('FILE_READ', '余额账单模板为空或不可读，请重新确认');
      }

      const balanceResult = deriveBalanceRecords({
        detailRows: effectiveDetailRows,
        templateName: config.template.name,
        balanceTemplateFields,
        mode: preparedBatch.balanceMode,
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
          warnings.push({
            type: 'balance-seed-required',
            message: error.message,
            prompt: {
              templateName: config.template.name,
              bankName: error.context?.bankName || splitTemplateName(config.template.name).bankName,
              merchantId: normalizeCell(error.context?.merchantId),
              currency: normalizeCell(error.context?.currency),
              targetBillDate: normalizeCell(error.context?.targetBillDate)
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

async function resolveImportFileSelection({
  templateName,
  session,
  filePaths
}) {
  const acceptedPaths = [];
  const replacePaths = [];

  for (const rawPath of normalizeInputFilePaths(filePaths, { dedupe: false })) {
    const normalizedPath = path.resolve(rawPath);
    const duplicateInCurrentBatch = acceptedPaths.includes(normalizedPath);
    const duplicateInSession = session.fileEntries.some((entry) => entry.filePath === normalizedPath);

    if (!duplicateInCurrentBatch && !duplicateInSession) {
      acceptedPaths.push(normalizedPath);
      continue;
    }

    const message = duplicateInCurrentBatch
      ? `当前批次已重复选择文件：\n${normalizedPath}\n\n请选择覆盖当前批次中的旧记录，还是保留两份。`
      : `该文件在当前模板的本次会话中已导入过：\n${normalizedPath}\n\n请选择覆盖旧记录，还是保留两份。`;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['覆盖旧记录', '保留两份', '取消本次导入'],
      defaultId: 0,
      cancelId: 2,
      message: `检测到重复文件（模板：${templateName}）`,
      detail: message
    });

    if (result.response === 2) {
      return {
        status: 'cancelled',
        filePaths: []
      };
    }

    if (result.response === 0) {
      if (duplicateInCurrentBatch) {
        const existingIndex = acceptedPaths.findIndex((filePath) => filePath === normalizedPath);

        if (existingIndex >= 0) {
          acceptedPaths.splice(existingIndex, 1);
        }
      }

      if (duplicateInSession) {
        replacePaths.push(normalizedPath);
      }

      acceptedPaths.push(normalizedPath);
      continue;
    }

    acceptedPaths.push(normalizedPath);
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

    const templateConfig = getTemplateMappingConfig(session.templateId);

    if (!templateConfig) {
      return createErrorResult({
        step: kind === 'detail' ? '导出明细账单' : '导出余额账单',
        message: '未找到当前模板，请重新选择模板后导入文件',
        errorCode: 'TEMPLATE_NOT_FOUND',
        templateName: session.templateName
      });
    }

    const { config, preparedBatch } = buildStatementSessionGenerationContext({
      session,
      template: templateConfig.template,
      mappings: templateConfig.exportMappings,
      orderedTargetFields: templateConfig.exportTargetFields,
      scope: 'all'
    });

    if (kind === 'balance') {
      rememberLastFileImportContext(createGenerationContext({
        templateId: session.templateId,
        template: templateConfig.template,
        mappings: templateConfig.exportMappings,
        orderedTargetFields: templateConfig.exportTargetFields,
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

  return exportGeneratedFile(
    generatedFile,
    emptyMessage,
    kind === 'detail' ? '导出明细账单' : '导出余额账单'
  );
}

function registerFileHandlers() {
  ipcMain.handle('file:import', async (_event, templateId) => {
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

    let templateConfig = null;

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

      const bigAccountOptions = expandBigAccountConfigurations(templateConfig.bigAccounts);

      if (bigAccountOptions.length > 1) {
        const provisionalFileEntries = buildPendingBigAccountFileEntries({
          template: templateConfig.template,
          mappings: templateConfig.exportMappings,
          orderedTargetFields: templateConfig.exportTargetFields,
          inputFilePaths: selectionResult.filePaths
        });
        const selectionRows = buildBigAccountSelectionRows(provisionalFileEntries);

        rememberPendingBigAccountSelection({
          templateId,
          template: templateConfig.template,
          mappings: templateConfig.exportMappings,
          orderedTargetFields: templateConfig.exportTargetFields,
          inputFilePaths: selectionResult.filePaths,
          bigAccounts: templateConfig.bigAccounts,
          fixedAssignments: templateConfig.fixedAssignments,
          fileEntries: provisionalFileEntries,
          rows: selectionRows
        });
        return buildBigAccountSelectionRequiredResult({
          rows: selectionRows,
          bigAccounts: templateConfig.bigAccounts,
          fixedAssignments: templateConfig.fixedAssignments
        });
      }

      const selectedBigAccount = bigAccountOptions.length === 1
        ? {
            merchantId: bigAccountOptions[0].merchantId,
            currency: bigAccountOptions[0].currency
          }
        : null;

      const generatedFiles = prepareGeneratedFiles({
        template: templateConfig.template,
        mappings: templateConfig.exportMappings,
        orderedTargetFields: templateConfig.exportTargetFields,
        inputFilePaths: selectionResult.filePaths,
        selectedBigAccount
      });

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
        templateId,
        template: templateConfig.template,
        mappings: templateConfig.exportMappings,
        orderedTargetFields: templateConfig.exportTargetFields,
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
        templateId,
        templateName: templateConfig.template.name,
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
    }
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

    if (!assignments.length || assignments.length !== pendingContext.rows.length) {
      return createErrorResult({
        step: '选择大账号',
        message: '请选择有效的大账号 / 币种',
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

      if (Boolean(payload.fixed)) {
        const currentMappingPayload = database.getTemplateMappings(pendingContext.templateId);

        if (currentMappingPayload) {
          database.saveMappings(
            pendingContext.templateId,
            currentMappingPayload.mappings,
            database.getTemplateBigAccounts(pendingContext.templateId),
            normalizedAssignments
          );
          syncTemplateLibraryFile();
        }
      }

      const resolvedFileEntries = applyBigAccountAssignmentsToFileEntries(
        pendingContext.fileEntries,
        normalizedAssignments
      );
      const generationConfig = buildStatementGenerationConfig({
        template: pendingContext.template,
        mappings: pendingContext.mappings,
        orderedTargetFields: pendingContext.orderedTargetFields,
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
        templateId: pendingContext.templateId,
        template: pendingContext.template,
        mappings: pendingContext.mappings,
        orderedTargetFields: pendingContext.orderedTargetFields,
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
        templateName: pendingContext.template.name,
        inputFilePaths: pendingContext.inputFilePaths
      });
    } catch (error) {
      clearGeneratedExports();
      clearPendingManualBalancePrompt();
      clearPendingBigAccountSelection();

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

      const upsertResult = upsertBalanceSeedRecord(ensureStorageRoot(), {
        templateName: importContext.template.name,
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
          `模板名：${importContext.template.name}`,
          `银行账号：${pendingPrompt.merchantId}`,
          `币种：${pendingPrompt.currency || '(空)'}`,
          `账单日期：${normalizedSeedDate}`,
          `余额：${endBalance}`,
          `生成方式：${BALANCE_SEED_GENERATION_METHODS.manual}`
        ]
      });

      const generatedFiles = generateFilesFromRememberedContext(importContext);
      const session = importContext.statementSessionKey
        ? statementImportSessions.get(importContext.statementSessionKey) || null
        : null;

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
      const currencyLabel = generated.currencies.length > 1 ? '多币种' : (generated.currencies[0] || '');
      const output = buildOutputFilePath({
        kind: 'new-account',
        outputFileName: `${primaryAccount.bankName}-${primaryAccount.location}-多账号-${currencyLabel}-${NEW_ACCOUNT_EXPORT_NAME}.xlsx`
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
          `币种：${currencyLabel}`,
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
}

app.whenReady()
  .then(() => {
    markStartupMetric(STARTUP_METRIC_MARKS.appReady);
    initializeActivityLog();

    const dataPath = path.join(app.getPath('userData'), 'tool-data.sqlite');
    database = new AppDatabase(dataPath);
    database.init();
    markStartupMetric(STARTUP_METRIC_MARKS.databaseReady);
    syncTemplateLibraryFile();
    markStartupMetric(STARTUP_METRIC_MARKS.templateLibrarySynced);

    registerWindowHandlers();
    registerAppHandlers();
    registerErrorHandlers();
    registerBackgroundHandlers();
    registerAccountMappingHandlers();
    registerTemplateHandlers();
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
