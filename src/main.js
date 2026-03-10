const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');
const { AppDatabase } = require('./backend/database');
const {
  buildMappedRows,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  extractHeaders,
  loadCurrencyMappings,
  loadEnumValues,
  normalizeCell,
  parseDateValue,
  parseNumericValue,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('./backend/file-service');
const { appendLog, writeErrorReport } = require('./backend/logger');

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
  newAccount: null
};
let lastErrorReport = null;

const DEFAULT_BACKGROUND_COLOR = '#efe8da';
const BUNDLED_ENUM_FILE_NAME = 'COMMON枚举.xlsx';
const CURRENCY_MAPPING_FILE_NAME = '币种映射表.xlsx';
const MISSING_ENUM_MESSAGE = '内置网银账单枚举表缺失，请检查安装包';
const MERCHANT_ID_SELF_INPUT_OPTION = '自己输入';
const BACKGROUND_IMAGE_LIMITS = Object.freeze({
  maxSizeBytes: 5 * 1024 * 1024,
  minWidth: 1200,
  minHeight: 700,
  maxWidth: 4096,
  maxHeight: 4096
});
const SUPPORTED_BACKGROUND_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function pad(value) {
  return String(value).padStart(2, '0');
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
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

function clearLastErrorReport() {
  lastErrorReport = null;
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
  originalError = null
}) {
  const report = createErrorReport({
    step,
    message,
    errorCode,
    errorType,
    detailLines,
    context,
    originalError
  });
  lastErrorReport = report;

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
  errorType = '业务校验错误'
}) {
  const report = createErrorReport({
    step,
    message,
    errorCode,
    errorType,
    detailLines,
    context
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

function getBalanceTemplatePath() {
  const appRoot = app.getAppPath();
  return path.join(appRoot, 'assets', '余额账单模版.xlsx');
}

function buildImportWarningDetailLines(warnings) {
  const detailLines = [];
  const currencyWarnings = warnings.filter((warning) => warning.type === 'currency-unmapped');
  const balanceWarnings = warnings.filter((warning) => warning.type === 'balance-generate-failed');

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

function decodeMerchantIdMappingValue(rawValue) {
  const normalizedValue = normalizeCell(rawValue);

  if (!normalizedValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
    return {
      isCustomInput: false,
      mappedField: normalizedValue,
      customValue: ''
    };
  }

  return {
    isCustomInput: true,
    mappedField: MERCHANT_ID_SELF_INPUT_OPTION,
    customValue: normalizedValue.slice(FIXED_FIELD_VALUE_PREFIX.length)
  };
}

function resolveCurrentMappings({ template, mappings, enumValues }) {
  const targetFields = buildMappingTargetFields(enumValues);
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
          mappedField: mapping.templateField
        }))
        .filter((mapping) => targetFieldSet.has(mapping.templateField))
    : mappings.filter((mapping) => targetFieldSet.has(mapping.templateField));

  return currentMappings;
}

function normalizeMappingRows({ template, mappings, enumValues }) {
  const targetFields = buildMappingTargetFields(enumValues);
  const currentMappings = resolveCurrentMappings({
    template,
    mappings,
    enumValues
  });
  const savedMap = new Map(currentMappings.map((mapping) => [mapping.templateField, normalizeCell(mapping.mappedField)]));

  return targetFields.map((fieldName) => {
    const savedValue = savedMap.get(fieldName) || '';
    const merchantIdMapping = fieldName === 'MerchantId'
      ? decodeMerchantIdMappingValue(savedValue)
      : null;

    return {
      templateField: fieldName,
      mappedField: fieldName === 'Balance'
        ? savedValue || '无'
        : merchantIdMapping
          ? merchantIdMapping.mappedField
          : savedValue === '无'
            ? ''
            : savedValue || '',
      customValue: merchantIdMapping ? merchantIdMapping.customValue : ''
    };
  });
}

function normalizeExportMappingRows({ template, mappings, enumValues }) {
  const targetFields = buildMappingTargetFields(enumValues);
  const currentMappings = resolveCurrentMappings({
    template,
    mappings,
    enumValues
  });
  const savedMap = new Map(currentMappings.map((mapping) => [mapping.templateField, normalizeCell(mapping.mappedField)]));

  return targetFields.map((fieldName) => {
    const savedValue = savedMap.get(fieldName) || '';

    return {
      templateField: fieldName,
      mappedField: fieldName === 'Balance'
        ? savedValue || '无'
        : savedValue === '无'
          ? ''
          : savedValue || ''
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
  const mappings = normalizeMappingRows({
    template: templatePayload.template,
    mappings: templatePayload.mappings,
    enumValues
  });
  const exportMappings = normalizeExportMappingRows({
    template: templatePayload.template,
    mappings: templatePayload.mappings,
    enumValues
  });

  return {
    template: templatePayload.template,
    enumValues,
    targetFields: buildMappingTargetFields(enumValues),
    exportTargetFields: buildExportTargetFields(enumValues),
    mappings,
    exportMappings
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

function buildStatementOutputFilePath({ kind, templateName, outputTag, dateRangeLabel }) {
  const safeDateLabel = dateRangeLabel || getToday();
  return buildOutputFilePath({
    kind,
    outputFileName: `${templateName}-${outputTag}-${safeDateLabel}.xlsx`
  });
}

function clearGeneratedExports() {
  lastGeneratedExports = {
    detail: null,
    balance: null,
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
    throw new FileValidationError('FILE_READ', '当前模版必须映射 BillDate 字段');
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

function roundAmount(value) {
  return Number(value.toFixed(2));
}

function pickSingleTextValue(values, fieldName) {
  const uniqueValues = Array.from(
    new Set(values.map((value) => normalizeCell(value)).filter((value) => value !== ''))
  );

  if (uniqueValues.length > 1) {
    throw new FileValidationError('FILE_READ', `${fieldName} 存在多个不同取值，无法生成余额账单`);
  }

  return uniqueValues[0] || '';
}

function splitTemplateName(templateName) {
  const [bankName, ...locationParts] = String(templateName || '').split('-');

  return {
    bankName: bankName || '',
    location: locationParts.join('-')
  };
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

function deriveBalanceRecords({ detailRows, templateName, balanceTemplateFields }) {
  const fieldIndexMap = buildFieldIndexMap(detailRows[0] || []);
  const balanceIndex = fieldIndexMap.get('Balance');
  const billDateIndex = fieldIndexMap.get('BillDate');

  if (balanceIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模版未配置 Balance 字段，无法生成余额账单');
  }

  if (billDateIndex === undefined) {
    throw new FileValidationError('FILE_READ', '当前模版必须映射 BillDate 字段');
  }

  const groupedRows = new Map();
  const bankNameParts = splitTemplateName(templateName);
  const currencies = [];
  const bankAccounts = [];

  detailRows.slice(1).forEach((row) => {
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
    const balanceValue = ensureNumericValue(row[balanceIndex], {
      fieldName: 'Balance',
      dateLabel,
      allowBlank: true
    });
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
    const currency = getMappedFieldValue(row, fieldIndexMap, 'Currency');
    const bankAccount = getMappedFieldValue(row, fieldIndexMap, 'MerchantId');

    currencies.push(currency);
    bankAccounts.push(bankAccount);

    if (!groupedRows.has(dateLabel)) {
      groupedRows.set(dateLabel, []);
    }

    groupedRows.get(dateLabel).push({
      balanceValue,
      creditAmount,
      debitAmount
    });
  });

  const dateKeys = Array.from(groupedRows.keys()).sort();

  if (!dateKeys.length) {
    throw new FileValidationError('FILE_READ', '导入文件中未找到可用于余额账单的账单日期');
  }

  const currency = pickSingleTextValue(currencies, 'Currency');
  const bankAccount = pickSingleTextValue(bankAccounts, '银行账号');
  const records = [];
  let previousEndBalance = null;

  dateKeys.forEach((dateLabel) => {
    const entries = groupedRows.get(dateLabel);
    const uniqueBalances = Array.from(
      new Set(
        entries
          .filter((entry) => entry.balanceValue !== null)
          .map((entry) => roundAmount(entry.balanceValue))
      )
    );
    let endBalance = null;

    if (uniqueBalances.length === 0) {
      throw new FileValidationError('FILE_READ', `${dateLabel} 未找到期末余额`);
    }

    if (uniqueBalances.length === 1) {
      [endBalance] = uniqueBalances;
    } else {
      if (previousEndBalance === null) {
        throw new FileValidationError('FILE_READ', `${dateLabel} 存在多个期末余额，且无法推导首日余额`);
      }

      const amount = roundAmount(
        previousEndBalance
          + entries.reduce((sum, entry) => sum + entry.creditAmount, 0)
          + entries.reduce((sum, entry) => sum + entry.debitAmount, 0)
      );
      const matchedBalance = uniqueBalances.find((balance) => Math.abs(balance - amount) < 0.005);

      if (matchedBalance === undefined) {
        throw new FileValidationError('FILE_READ', `${dateLabel} 的期末余额无法根据收支金额推导`);
      }

      endBalance = matchedBalance;
    }

    previousEndBalance = endBalance;
    records.push(buildBalanceTemplateRow(balanceTemplateFields, {
      银行名称: bankNameParts.bankName,
      所在地: bankNameParts.location,
      币种: currency,
      银行账号: bankAccount,
      账单日期: dateLabel,
      期初余额: '',
      期初可用余额: '',
      期末余额: endBalance,
      期末可用余额: ''
    }));
  });

  return {
    records,
    billDates: dateKeys
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

function buildNewAccountBalanceRecords({
  bankName,
  location,
  currency,
  bankAccount,
  openingDate,
  balanceTemplateFields
}) {
  const billDates = buildNewAccountBillDates(openingDate);
  const records = billDates.map((billDate) => buildBalanceTemplateRow(balanceTemplateFields, {
    银行名称: bankName,
    所在地: location,
    币种: currency,
    银行账号: bankAccount,
    账单日期: formatDateLabel(billDate),
    期初余额: '',
    期初可用余额: '',
    期末余额: 0,
    期末可用余额: ''
  }));

  return {
    records,
    billDates: billDates.map((billDate) => formatDateLabel(billDate))
  };
}

function fileDialogFilters() {
  return [
    {
      name: 'Excel / CSV',
      extensions: ['xlsx', 'xls', 'csv']
    }
  ];
}

function sendWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:maximized-state', mainWindow.isMaximized());
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 1080,
    minHeight: 760,
    frame: false,
    backgroundColor: '#f3efe6',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(app.getAppPath(), 'index.html'));
  mainWindow.once('ready-to-show', () => {
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
    name: template.name,
    sourceFileName: template.sourceFileName,
    headers: template.headers,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt
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
      backgroundConfig: buildBackgroundPayload(),
      previewModal: process.env.APP_PREVIEW_MODAL || ''
    };
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

function validateTemplateMappings({ template, mappings, enumValues }) {
  const targetFields = buildMappingTargetFields(enumValues);
  const targetFieldSet = new Set(targetFields);
  const sourceFieldSet = new Set(template.headers.map((header) => normalizeCell(header)));
  const mappingByTarget = new Map();

  mappings.forEach((mapping) => {
    const targetField = normalizeCell(mapping.templateField);
    const sourceField = normalizeCell(mapping.mappedField);

    if (!targetFieldSet.has(targetField)) {
      return;
    }

    mappingByTarget.set(targetField, {
      mappedField: sourceField,
      customValue: normalizeCell(mapping.customValue)
    });
  });

  const cleanedMappings = [];

  targetFields.forEach((targetField) => {
    const selectedMapping = mappingByTarget.get(targetField) || {
      mappedField: '',
      customValue: ''
    };
    const selectedSourceField = selectedMapping.mappedField;
    const normalizedSourceField = targetField === 'Balance'
      ? selectedSourceField || '无'
      : selectedSourceField === '无'
        ? ''
        : selectedSourceField;

    if (targetField === 'Balance' && normalizedSourceField === '无') {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: '无'
      });
      return;
    }

    if (!normalizedSourceField) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: ''
      });
      return;
    }

    if (targetField === 'MerchantId' && normalizedSourceField === MERCHANT_ID_SELF_INPUT_OPTION) {
      const customValue = selectedMapping.customValue;

      if (!customValue) {
        throw new FileValidationError('FILE_READ', 'MerchantId 选择“自己输入”后必须填写内容');
      }

      cleanedMappings.push({
        templateField: targetField,
        mappedField: `${FIXED_FIELD_VALUE_PREFIX}${customValue}`
      });
      return;
    }

    if (!sourceFieldSet.has(normalizedSourceField)) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${normalizedSourceField}`);
    }

    cleanedMappings.push({
      templateField: targetField,
      mappedField: normalizedSourceField
    });
  });

  return cleanedMappings;
}

function registerTemplateHandlers() {
  ipcMain.handle('template:list', () => {
    return database.listTemplates();
  });

  ipcMain.handle('template:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: fileDialogFilters()
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
      clearLastErrorReport();

      return {
        status: 'success',
        message: '模版导入成功，请在管理模版中维护映射关系',
        template: buildTemplateSummary(template)
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '导入模版文件',
          message: error.message,
          errorCode: error.code,
          detailLines: ['模版文件无法读取或表头无效，未完成导入。'],
          context: { selectedPath }
        });
      }

      return createErrorResult({
        step: '导入模版文件',
        message: '模版导入失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_IMPORT_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { selectedPath }
      });
    }
  });

  ipcMain.handle('template:delete', (_event, templateId) => {
    database.deleteTemplate(templateId);
    return { status: 'success' };
  });

  ipcMain.handle('template:get-mappings', (_event, templateId) => {
    if (!getEnumConfig()) {
      return createErrorResult({
        step: '打开映射关系设置',
        message: MISSING_ENUM_MESSAGE,
        errorCode: 'ENUM_MISSING'
      });
    }

    try {
      const mappingConfig = getTemplateMappingConfig(templateId);

      if (!mappingConfig) {
        return createErrorResult({
          step: '打开映射关系设置',
          message: '未找到对应模版',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }

      return {
        status: 'success',
        template: buildTemplateSummary(mappingConfig.template),
        targetFields: mappingConfig.targetFields,
        exportTargetFields: mappingConfig.exportTargetFields,
        mappings: mappingConfig.mappings
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '打开映射关系设置',
          message: '内置网银账单枚举表为空或不可读，请检查安装包',
          errorCode: error.code,
          originalError: error
        });
      }

      return createErrorResult({
        step: '打开映射关系设置',
        message: '映射关系设置打开失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_MAPPING_OPEN_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId }
      });
    }
  });

  ipcMain.handle('template:save-mappings', (_event, payload) => {
    try {
      const enumConfig = getEnumConfig();
      const template = database.getTemplate(payload.templateId);

      if (!enumConfig) {
        return createErrorResult({
          step: '保存模版映射',
          message: MISSING_ENUM_MESSAGE,
          errorCode: 'ENUM_MISSING'
        });
      }

      if (!template) {
        return createErrorResult({
          step: '保存模版映射',
          message: '未找到对应模版',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId: payload.templateId }
        });
      }

      const mappings = validateTemplateMappings({
        template,
        mappings: payload.mappings,
        enumValues: loadEnumValues(enumConfig.filePath)
      });

      database.saveMappings(payload.templateId, mappings);
      clearLastErrorReport();
      return {
        status: 'success',
        message: '模版映射保存成功'
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存模版映射',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId: payload.templateId }
        });
      }

      return createErrorResult({
        step: '保存模版映射',
        message: '模版映射保存失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_MAPPING_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId: payload.templateId }
      });
    }
  });
}

function buildMappedFieldLookup(mappings) {
  return mappings.reduce((accumulator, mapping) => {
    accumulator[mapping.templateField] = mapping.mappedField;
    return accumulator;
  }, {});
}

function prepareGeneratedFiles({
  template,
  mappings,
  orderedTargetFields,
  inputFilePath
}) {
  const selectedMappings = mappings.filter((mapping) => {
    if (mapping.templateField === 'Balance') {
      return mapping.mappedField && mapping.mappedField !== '无';
    }

    return mapping.mappedField !== '';
  });

  if (!selectedMappings.length) {
    throw new FileValidationError('FILE_READ', '当前模版尚未设置映射关系');
  }

  const mappingByTargetField = buildMappedFieldLookup(selectedMappings);
  const templateNameParts = splitTemplateName(template.name);

  if (orderedTargetFields.includes('Channel')) {
    mappingByTargetField.Channel = `${FIXED_FIELD_VALUE_PREFIX}${templateNameParts.bankName}`;
  }

  if (!mappingByTargetField.BillDate) {
    throw new FileValidationError('FILE_READ', '当前模版必须映射 BillDate 字段');
  }

  let currencyMappings = [];

  if (mappingByTargetField.Currency) {
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
  const detailRows = buildMappedRows({
    inputFilePath,
    orderedTargetFields: exportTargetFields,
    mappingByField: mappingByTargetField,
    accountMappingByBankId,
    currencyMappings
  });
  const warnings = Array.isArray(detailRows.issues) ? detailRows.issues.slice() : [];
  const billDates = parseRequiredBillDates(detailRows);
  const dateRangeLabel = buildDateRangeLabel(billDates);
  const detailOutput = buildStatementOutputFilePath({
    kind: 'detail',
    templateName: template.name,
    outputTag: 'COMMON',
    dateRangeLabel
  });

  writeWorkbookRows({
    rows: detailRows,
    outputFilePath: detailOutput.outputFilePath
  });

  const result = {
    detail: {
      filePath: detailOutput.outputFilePath,
      fileName: detailOutput.outputFileName
    },
    balance: null,
    message: '明细账单可导出',
    warnings,
    balanceRequested: Boolean(mappingByTargetField.Balance)
  };

  if (mappingByTargetField.Balance) {
    try {
      const balanceTemplatePath = getBalanceTemplatePath();

      if (!fs.existsSync(balanceTemplatePath)) {
        throw new FileValidationError('FILE_READ', '未找到余额账单模版，请确认文件已放入 assets 目录');
      }

      const balanceTemplateFields = extractHeaders(balanceTemplatePath);

      if (!balanceTemplateFields.length) {
        throw new FileValidationError('FILE_READ', '余额账单模版为空或不可读，请重新确认');
      }

      const balanceResult = deriveBalanceRecords({
        detailRows,
        templateName: template.name,
        balanceTemplateFields
      });
      const balanceOutput = buildStatementOutputFilePath({
        kind: 'balance',
        templateName: template.name,
        outputTag: 'Balance',
        dateRangeLabel: buildDateRangeLabel(balanceResult.billDates)
      });

      writeBalanceWorkbook({
        templateFilePath: balanceTemplatePath,
        records: balanceResult.records,
        templateFields: balanceTemplateFields,
        outputFilePath: balanceOutput.outputFilePath
      });

      result.balance = {
        filePath: balanceOutput.outputFilePath,
        fileName: balanceOutput.outputFileName
      };
      result.message = '明细账单可导出，余额账单可导出';
    } catch (error) {
      if (error instanceof FileValidationError) {
        warnings.push({
          type: 'balance-generate-failed',
          message: error.message
        });
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

async function exportGeneratedFile(generatedFile, emptyMessage, step) {
  if (!generatedFile || !generatedFile.filePath || !fs.existsSync(generatedFile.filePath)) {
    return createErrorResult({
      step,
      message: emptyMessage,
      errorCode: 'EXPORT_EMPTY'
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
      }
    });
  }
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
        message: '请选择模版',
        errorCode: 'TEMPLATE_REQUIRED'
      });
    }

    try {
      const templateConfig = getTemplateMappingConfig(templateId);

      if (!templateConfig) {
        return createErrorResult({
          step: '导入网银明细文件',
          message: '未找到对应模版',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }

      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: fileDialogFilters()
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { status: 'cancelled' };
      }

      const inputFilePath = result.filePaths[0];
      const generatedFiles = prepareGeneratedFiles({
        template: templateConfig.template,
        mappings: templateConfig.exportMappings,
        orderedTargetFields: templateConfig.exportTargetFields,
        inputFilePath
      });
      lastGeneratedExports = {
        detail: generatedFiles.detail,
        balance: generatedFiles.balance,
        newAccount: lastGeneratedExports.newAccount
      };

      if (generatedFiles.warnings.length) {
        const detailReady = Boolean(generatedFiles.detail);
        const balanceReady = Boolean(generatedFiles.balance);
        const message = balanceReady
          ? '明细账单可导出，余额账单可导出，但存在报错，请点击状态框导出报错文件'
          : generatedFiles.balanceRequested
            ? '明细账单可导出，余额账单未生成，请点击状态框导出报错文件'
            : '明细账单可导出，但存在报错，请点击状态框导出报错文件';

        return createWarningResult({
          step: '导入网银明细文件',
          message,
          detailReady,
          balanceReady,
          detailLines: buildImportWarningDetailLines(generatedFiles.warnings),
          context: {
            templateId,
            inputFilePath
          },
          errorCode: 'FILE_IMPORT_WARNING'
        });
      }

      clearLastErrorReport();

      return {
        status: 'success',
        message: generatedFiles.message,
        detailReady: Boolean(generatedFiles.detail),
        balanceReady: Boolean(generatedFiles.balance)
      };
    } catch (error) {
      clearGeneratedExports();

      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '导入网银明细文件',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: {
            templateId
          }
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
          templateId
        },
        originalError: error
      });
    }
  });

  ipcMain.handle('file:export-detail', () => {
    return exportGeneratedFile(lastGeneratedExports.detail, '暂无可导出的明细账单', '导出明细账单');
  });

  ipcMain.handle('file:export-balance', () => {
    return exportGeneratedFile(lastGeneratedExports.balance, '暂无可导出的余额账单', '导出余额账单');
  });
}

function registerNewAccountHandlers() {
  ipcMain.handle('new-account:generate', (_event, payload = {}) => {
    const bankName = normalizeCell(payload.bankName);
    const location = normalizeCell(payload.location);
    const currency = normalizeCell(payload.currency);
    const bankAccount = normalizeCell(payload.bankAccount);
    const openingDate = parseDateValue(payload.openingDate);
    const missingFields = [
      ['银行名称', bankName],
      ['所在地', location],
      ['币种', currency],
      ['银行账号', bankAccount],
      ['开户日期', normalizeCell(payload.openingDate)]
    ].filter(([, value]) => !value);

    if (missingFields.length) {
      return createErrorResult({
        step: '生成新开账户余额账单',
        message: '请完整填写所有必填项',
        errorCode: 'NEW_ACCOUNT_REQUIRED',
        detailLines: [`缺少字段：${missingFields.map(([label]) => label).join('、')}`]
      });
    }

    if (!openingDate) {
      return createErrorResult({
        step: '生成新开账户余额账单',
        message: '开户日期不是有效日期',
        errorCode: 'NEW_ACCOUNT_OPEN_DATE_INVALID',
        context: { openingDate: payload.openingDate }
      });
    }

    try {
      const balanceTemplatePath = getBalanceTemplatePath();

      if (!fs.existsSync(balanceTemplatePath)) {
        return createErrorResult({
          step: '生成新开账户余额账单',
          message: '未找到余额账单模版，请确认文件已放入 assets 目录',
          errorCode: 'BALANCE_TEMPLATE_MISSING'
        });
      }

      const balanceTemplateFields = extractHeaders(balanceTemplatePath);

      if (!balanceTemplateFields.length) {
        return createErrorResult({
          step: '生成新开账户余额账单',
          message: '余额账单模版为空或不可读，请重新确认',
          errorCode: 'BALANCE_TEMPLATE_INVALID'
        });
      }

      const generated = buildNewAccountBalanceRecords({
        bankName,
        location,
        currency,
        bankAccount,
        openingDate,
        balanceTemplateFields
      });
      const dateRangeLabel = buildDateRangeLabel(generated.billDates);
      const output = buildOutputFilePath({
        kind: 'new-account',
        outputFileName: `${bankName}${location}${bankAccount}${currency}新开银行账户余额录入${dateRangeLabel}.xlsx`
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
          fileName: output.outputFileName
        }
      };
      clearLastErrorReport();

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
            bankName,
            location,
            currency,
            bankAccount,
            openingDate: formatDateLabel(openingDate)
          }
        });
      }

      const logPath = appendLog(ensureStorageRoot(), error);
      return createErrorResult({
        step: '生成新开账户余额账单',
        message: '生成失败，请导出报错文件查看详情',
        errorCode: 'NEW_ACCOUNT_RUNTIME',
        errorType: '系统错误',
        detailLines: [`日志文件：${logPath}`],
        originalError: error
      });
    }
  });

  ipcMain.handle('new-account:export', () => {
    return exportGeneratedFile(lastGeneratedExports.newAccount, '暂无可导出的新开账户余额账单', '导出新开账户余额账单');
  });
}

app.whenReady().then(() => {
  const dataPath = path.join(app.getPath('userData'), 'tool-data.sqlite');
  database = new AppDatabase(dataPath);
  database.init();

  registerWindowHandlers();
  registerAppHandlers();
  registerErrorHandlers();
  registerBackgroundHandlers();
  registerAccountMappingHandlers();
  registerTemplateHandlers();
  registerFileHandlers();
  registerNewAccountHandlers();
  createWindow();
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
